/**
 * Journal-backed `IdempotencyJournalPort` (DD-FND-097.1, DD-FND-097.2,
 * DD-FND-097.7).
 *
 * Every transition appends exactly one `rsi.journal_event/1` frame carrying a
 * `rsi.ledger_event/1` whose `row_json` is the complete, canonical
 * `rsi.ipc_idempotency_row/1` after-image. The frame is written and fsynced
 * before the commit record and `ledger_event_log` projection; the caller
 * (`createSqliteIdempotencyStore`) writes the `ipc_idempotency` row only after
 * this port returns Ok.
 *
 * The port is deliberately synchronous inside `record*`: the dedupe read,
 * `JournalWriter.append` (write + fsync) and the projection transaction run in
 * one JS turn, so two requests for the same entity cannot append the same
 * event twice.
 */

import { basename, join } from "node:path";

import type {
  ErrorEnvelope,
  FailureStatus,
  Hash,
  Id,
  JsonValue,
  Result
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  isHash,
  isId,
  newId
} from "@evoplug/core";
import { idempotencyEntityId, isIpcMethod } from "@evoplug/ipc";
import type {
  JournalCommitter,
  JournalFramePayload,
  JournalWriter,
  SqlRow,
  SqliteConnection,
  Tx
} from "@evoplug/storage";
import {
  JournalWriter as JournalWriterClass,
  createJournalCommitter,
  listJournalStates
} from "@evoplug/storage";

import { fieldError, internalError } from "./errors.js";
import { homeLayout, type HomeLayout } from "./home.js";
import type {
  IdempotencyJournalPort,
  IdempotencyRowSnapshot,
  IdempotencyRowState
} from "./idempotency.js";

const ROW_SCHEMA = "rsi.ipc_idempotency_row/1";
const ENTITY_TYPE = "ipc_idempotency";

interface EventSpec {
  readonly event_type: string;
  readonly operation: "insert" | "update" | "transition";
}

const STARTED_EVENT: EventSpec = {
  event_type: "ipc_idempotency.started",
  operation: "insert"
};

const FINISHED_EVENT: EventSpec = {
  event_type: "ipc_idempotency.finished",
  operation: "update"
};

const UNCERTAIN_EVENT: EventSpec = {
  event_type: "ipc_idempotency.uncertain",
  operation: "transition"
};

type TransitionKind = "started" | "finished" | "uncertain";

/**
 * Complete DDL after-image of one `ipc_idempotency` row. The table has no
 * `schema_version` column, so neither does `row_json`; every physical column is
 * present, including nulls.
 */
interface IpcIdempotencyRowJson
  extends Readonly<Record<string, JsonValue>> {
  readonly client_id: Id<"adp">;
  readonly method: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly state: IdempotencyRowState;
  readonly response_json: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: number | null;
  readonly created_at: number;
  readonly expires_at: number;
}

/**
 * Dependencies for `createJournalIdempotencyJournal`.
 *
 * Supply either a shared `journal` committer (the kernel service composition
 * already owns one) or a `writer` plus `relative_path`, or a `home`/`layout`
 * from which the latest journal era is opened.
 */
interface JournalIdempotencyJournalDeps {
  readonly connection: SqliteConnection;
  readonly now?: () => number;
  /** Home containing `journal/`; used when `journal`/`writer` are omitted. */
  readonly home?: string;
  /** Explicit layout; wins over `home` when both are present. */
  readonly layout?: HomeLayout;
  /** Pre-opened FND committer shared with the kernel services. */
  readonly journal?: JournalCommitter;
  /** Pre-opened writer; used with `relative_path` when `journal` is omitted. */
  readonly writer?: JournalWriter;
  /** Journal path relative to the evoplug home; defaults to the writer basename. */
  readonly relative_path?: string;
}

/**
 * Outcome of `JournalIdempotencyJournal.dispose()`.
 *
 * `owned` reports whether this port opened the writer itself. `closed` is true
 * only on the call that actually closed an owned writer, so a repeated dispose
 * is observably a no-op. A borrowed writer (shared `journal` committer or
 * caller-supplied `writer`) is never closed and always yields `closed: false`.
 */
interface JournalIdempotencyDisposeResult {
  readonly owned: boolean;
  readonly closed: boolean;
}

/**
 * The port plus the recovery transition required by DD-FND-097.7: an
 * `in_progress` row whose entity has no `finished` event becomes `uncertain`.
 */
export interface JournalIdempotencyJournal extends IdempotencyJournalPort {
  recordUncertain(
    row: IdempotencyRowSnapshot
  ): Promise<Result<void, ErrorEnvelope>>;
  /**
   * Idempotently closes the journal writer this port opened from `home` or
   * `layout`. A borrowed `journal`/`writer` stays open for its owner. After
   * dispose every write transition is rejected; a dispose never replays or
   * reclassifies an existing event.
   */
  dispose(): JournalIdempotencyDisposeResult;
}

interface CommitterSetup {
  readonly committer: JournalCommitter | null;
  /** Non-null only when this call opened the writer and therefore owns it. */
  readonly owned_writer: JournalWriter | null;
}

interface StoredIdempotencyRow extends SqlRow {
  readonly client_id: string;
  readonly method: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly state: string;
  readonly response_json: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: number | null;
  readonly created_at: number;
  readonly expires_at: number;
}

interface DurableEventRow extends SqlRow {
  readonly event_type: string;
  readonly entity_id: string;
  readonly after_hash: string;
}

const SELECT_ROW = `SELECT client_id, method, idempotency_key, request_hash, state,
       response_json, lease_owner, lease_expires_at, created_at, expires_at
  FROM ipc_idempotency
 WHERE client_id = :client_id AND method = :method AND idempotency_key = :idempotency_key`;

const SELECT_DURABLE_EVENT = `SELECT event_type, entity_id, after_hash
  FROM ledger_event_log
 WHERE event_key = :event_key`;

function ok(): Result<void, ErrorEnvelope> {
  return { ok: true, status: "ok", value: undefined };
}

function fail(error: ErrorEnvelope, status: FailureStatus = "rejected"): Result<void, ErrorEnvelope> {
  return { ok: false, status, error };
}

function isRowState(value: string): value is IdempotencyRowState {
  return (
    value === "in_progress" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "uncertain"
  );
}

function isSafeTime(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function validateSnapshot(
  snapshot: IdempotencyRowSnapshot,
  kind: TransitionKind
): ErrorEnvelope | null {
  if (!isId(snapshot.client_id, "adp")) {
    return fieldError("client_id", "adp_id");
  }
  if (!isIpcMethod(snapshot.method)) {
    return fieldError("method", "ipc_method");
  }
  if (snapshot.idempotency_key.length === 0) {
    return fieldError("idempotency_key", "non_empty_string");
  }
  if (!isHash(snapshot.request_hash)) {
    return fieldError("request_hash", "sha256");
  }
  if (!isSafeTime(snapshot.created_at) || !isSafeTime(snapshot.expires_at)) {
    return fieldError("created_at", "epoch_ms");
  }
  if (snapshot.expires_at < snapshot.created_at) {
    return fieldError("expires_at", "not_before_created_at");
  }
  if (snapshot.lease_expires_at !== null && !isSafeTime(snapshot.lease_expires_at)) {
    return fieldError("lease_expires_at", "epoch_ms_or_null");
  }
  if (kind === "started") {
    if (snapshot.state !== "in_progress") {
      return fieldError("state", "in_progress");
    }
    if (snapshot.response_json !== null) {
      return fieldError("response_json", "null_while_in_progress");
    }
    if (snapshot.lease_owner === null || snapshot.lease_expires_at === null) {
      return fieldError("lease_owner", "required_while_in_progress");
    }
  }
  if (kind === "finished") {
    if (snapshot.state !== "succeeded" && snapshot.state !== "failed") {
      return fieldError("state", "succeeded_or_failed");
    }
    if (snapshot.response_json === null) {
      return fieldError("response_json", "required_when_terminal");
    }
  }
  if (kind === "uncertain" && snapshot.state !== "uncertain") {
    return fieldError("state", "uncertain");
  }
  return null;
}

function rowFromSnapshot(snapshot: IdempotencyRowSnapshot): IpcIdempotencyRowJson {
  return {
    client_id: snapshot.client_id,
    method: snapshot.method,
    idempotency_key: snapshot.idempotency_key,
    request_hash: snapshot.request_hash,
    state: snapshot.state,
    response_json: snapshot.response_json,
    lease_owner: snapshot.lease_owner,
    lease_expires_at: snapshot.lease_expires_at,
    created_at: snapshot.created_at,
    expires_at: snapshot.expires_at
  };
}

function rowFromStored(raw: StoredIdempotencyRow): IpcIdempotencyRowJson | null {
  if (
    !isId(raw.client_id, "adp") ||
    !isHash(raw.request_hash) ||
    !isRowState(raw.state)
  ) {
    return null;
  }
  return {
    client_id: raw.client_id,
    method: raw.method,
    idempotency_key: raw.idempotency_key,
    request_hash: raw.request_hash,
    state: raw.state,
    response_json: raw.response_json,
    lease_owner: raw.lease_owner,
    lease_expires_at: raw.lease_expires_at,
    created_at: raw.created_at,
    expires_at: raw.expires_at
  };
}

function readCurrentRow(
  connection: SqliteConnection,
  snapshot: IdempotencyRowSnapshot
): IpcIdempotencyRowJson | null {
  const raw = connection
    .prepare<StoredIdempotencyRow>(SELECT_ROW)
    .get({
      client_id: snapshot.client_id,
      method: snapshot.method,
      idempotency_key: snapshot.idempotency_key
    });
  return raw === undefined ? null : rowFromStored(raw);
}

function readDurableEvent(
  connection: SqliteConnection,
  eventKey: Hash
): DurableEventRow | null {
  const raw = connection
    .prepare<DurableEventRow>(SELECT_DURABLE_EVENT)
    .get({ event_key: eventKey });
  return raw ?? null;
}

function rowHash(row: IpcIdempotencyRowJson): Hash {
  return canonicalHash({
    row_schema: ROW_SCHEMA,
    row_json: canonicalJsonText(row)
  });
}

function insertLedgerEventLog(
  tx: Tx,
  input: {
    readonly event_id: string;
    readonly event_key: Hash;
    readonly commit_seq: number;
    readonly journal_id: string;
    readonly event_type: string;
    readonly entity_id: string;
    readonly operation: EventSpec["operation"];
    readonly before_hash: Hash | null;
    readonly after_hash: Hash;
    readonly row_json: string;
    readonly recorded_at: number;
  }
): void {
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, 'ipc_idempotency', :entity_id,
       :operation, 'global', NULL, NULL, NULL, NULL, NULL, NULL, :before_hash, :after_hash,
       'rsi.ipc_idempotency_row/1', :row_json, NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: input.event_id,
    event_key: input.event_key,
    commit_seq: input.commit_seq,
    journal_id: input.journal_id,
    event_type: input.event_type,
    entity_id: input.entity_id,
    operation: input.operation,
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    row_json: input.row_json,
    payload_hash: input.after_hash,
    recorded_at: input.recorded_at
  });
}

function createCommitterSetup(deps: JournalIdempotencyJournalDeps): CommitterSetup {
  if (deps.journal !== undefined) {
    return { committer: deps.journal, owned_writer: null };
  }
  const now = deps.now ?? ((): number => Date.now());
  try {
    if (deps.writer !== undefined) {
      return {
        committer: createJournalCommitter({
          writer: deps.writer,
          connection: deps.connection,
          relative_path: deps.relative_path ?? basename(deps.writer.filePath),
          now,
          // The ACK finishes with the `ipc_idempotency.finished` frame
          // (DD-FND-103).
          enospc_code: "E_STORAGE_ACK_ENOSPC"
        }),
        owned_writer: null
      };
    }
    const layout =
      deps.layout ?? (deps.home === undefined ? null : homeLayout(deps.home));
    if (layout === null) {
      return { committer: null, owned_writer: null };
    }
    const states = listJournalStates(deps.connection);
    const latest = states[states.length - 1];
    const journalId = latest?.journal_id ?? "journal-000001";
    const relativePath = latest?.relative_path ?? "journal-000001.rsij";
    const writer = JournalWriterClass.open({
      file_path: join(layout.journal_dir, relativePath),
      journal_id: journalId,
      last_commit_seq: latest?.last_commit_seq ?? 0,
      shared_commit_seq: () => readSharedCommitSeq(deps.connection, journalId)
    });
    if (!writer.ok) {
      return { committer: null, owned_writer: null };
    }
    return {
      committer: createJournalCommitter({
        writer: writer.value,
        connection: deps.connection,
        relative_path: relativePath,
        now,
        enospc_code: "E_STORAGE_ACK_ENOSPC"
      }),
      owned_writer: writer.value
    };
  } catch {
    return { committer: null, owned_writer: null };
  }
}

/**
 * The shared commit-sequence counter of one journal era.
 *
 * `commit_seq` is a *global* monotonic sequence over the whole journal
 * (DD-FND-059): every host event, ledger event and state-row batch member
 * shares it. A `JournalWriter` instance therefore only knows the sequence up
 * to the frame it wrote itself; another writer on the same file (the kernel's
 * event writer) moves the sequence forward independently.
 *
 * The persisted `journal_state.last_commit_seq` is the one counter both
 * writers agree on. This reader returns it, so a writer can re-sync before
 * every append.
 */
function readSharedCommitSeq(
  connection: SqliteConnection,
  journalId: string
): number {
  const row = connection
    .prepare<{ last_commit_seq: number }>(
      "SELECT last_commit_seq FROM journal_state WHERE journal_id = :journal_id"
    )
    .get({ journal_id: journalId });
  return row === undefined ? 0 : Number(row.last_commit_seq);
}

/**
 * Creates the FND journal face used by the SQLite idempotency store.
 *
 * Each call appends and fsyncs one frame, then projects `commit_record`,
 * `journal_state` and `ledger_event_log` in one short transaction. Nothing is
 * written when validation or the append fails, and an fsync-then-projection
 * failure is returned as `unknown` so the caller cannot mistake it for a
 * durable projection.
 */
export function createJournalIdempotencyJournal(
  deps: JournalIdempotencyJournalDeps
): JournalIdempotencyJournal {
  const connection = deps.connection;
  const now = deps.now ?? ((): number => Date.now());
  const setup = createCommitterSetup(deps);
  const committer = setup.committer;
  // The writer this port must close: only an internally opened one. A caller
  // supplied `journal`/`writer` is borrowed and its owner closes it.
  const ownedWriter = setup.owned_writer;
  // The caller-supplied writer whose shared sequence needs re-syncing before
  // every append. An internally opened writer re-syncs through its
  // `shared_commit_seq` hook instead.
  const explicitWriter = deps.writer ?? null;
  let disposed = false;

  /**
   * Idempotently closes an owned writer. Borrowed writers are left open.
   * Disposal never rewrites, retries or reclassifies an existing event.
   */
  function dispose(): JournalIdempotencyDisposeResult {
    if (ownedWriter === null) {
      disposed = true;
      return { owned: false, closed: false };
    }
    if (disposed) {
      return { owned: true, closed: false };
    }
    disposed = true;
    ownedWriter.close();
    return { owned: true, closed: true };
  }

  /**
   * Re-syncs the owned writer against the shared commit sequence.
   *
   * `commit_seq` is global over the journal era (DD-FND-059). The kernel's
   * event writer and this ACK writer are two `JournalWriter` instances on the
   * same file, and each allocates from its own private counter. Without the
   * re-sync the two counters collide, the `commit_record` primary key
   * rejects the loser, and the ACK's ledger frames are silently dropped.
   */
  function resyncWriter(): void {
    if (explicitWriter === null) {
      return;
    }
    const row = connection
      .prepare<{
        last_commit_seq: number;
        trusted_prefix_end: number;
        relative_path: string;
      }>(
        "SELECT last_commit_seq, trusted_prefix_end, relative_path FROM journal_state WHERE journal_id = :journal_id"
      )
      .get({ journal_id: explicitWriter.journalId });
    const shared = row === undefined ? 0 : Number(row.last_commit_seq);
    // The writer re-reads the file size as well: another writer on the same
    // file (the kernel's event writer) moves the append offset forward, and
    // the ACK writer must append after it instead of overwriting it. The
    // state path also follows a rotation performed by another writer, and the
    // persisted prefix makes a crash-before-projection window fail closed.
    if (row === undefined) {
      explicitWriter.resyncFromDisk(shared);
    } else {
      explicitWriter.resyncFromDisk(
        shared,
        row.relative_path,
        Number(row.trusted_prefix_end)
      );
    }
  }

  function commitEvent(
    kind: TransitionKind,
    snapshot: IdempotencyRowSnapshot
  ): Result<void, ErrorEnvelope> {
    if (disposed) {
      return fail(internalError("kernel.idempotency_journal_unavailable"));
    }
    if (committer === null) {
      return fail(internalError("kernel.idempotency_journal_unavailable"));
    }
    const invalid = validateSnapshot(snapshot, kind);
    if (invalid !== null) {
      return fail(invalid);
    }
    const method = snapshot.method;
    if (!isIpcMethod(method)) {
      return fail(fieldError("method", "ipc_method"));
    }

    resyncWriter();

    const spec =
      kind === "started"
        ? STARTED_EVENT
        : kind === "finished"
          ? FINISHED_EVENT
          : UNCERTAIN_EVENT;

    let before: IpcIdempotencyRowJson | null = null;
    if (spec.operation !== "insert") {
      before = readCurrentRow(connection, snapshot);
      if (before === null) {
        return fail(internalError("kernel.idempotency_row_missing_or_corrupt"));
      }
      if (before.state !== "in_progress") {
        return fail(internalError("kernel.idempotency_row_not_in_progress"));
      }
    }

    const after = rowFromSnapshot(snapshot);
    const rowJson = canonicalJsonText(after);
    const afterHash = rowHash(after);
    const beforeHash = before === null ? null : rowHash(before);
    const entityId = idempotencyEntityId({
      client_id: snapshot.client_id,
      method,
      idempotency_key: snapshot.idempotency_key
    });
    const eventKey = canonicalHash({
      event_type: spec.event_type,
      entity_type: ENTITY_TYPE,
      entity_id: entityId,
      operation: spec.operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      binding: null
    });

    const durable = readDurableEvent(connection, eventKey);
    if (durable !== null) {
      if (
        durable.event_type === spec.event_type &&
        durable.entity_id === entityId &&
        durable.after_hash === afterHash
      ) {
        return ok();
      }
      return fail(internalError("kernel.idempotency_event_key_conflict"));
    }

    const at = now();
    const eventId = newId("ev", at);
    const event: JsonValue = {
      schema_version: "rsi.ledger_event/1",
      event_id: eventId,
      event_key: eventKey,
      event_type: spec.event_type,
      entity_type: ENTITY_TYPE,
      entity_id: entityId,
      operation: spec.operation,
      binding: null,
      before_hash: beforeHash,
      after_hash: afterHash,
      row_schema: ROW_SCHEMA,
      row_json: rowJson,
      payload_hash: afterHash,
      recorded_at: at
    };
    const payload: JournalFramePayload = {
      schema_version: "rsi.journal_event/1",
      event,
      event_hash: canonicalHash(event),
      blob_hashes: []
    };

    const outcome = committer.commitSync(payload, (tx, receipt) => {
      insertLedgerEventLog(tx, {
        event_id: eventId,
        event_key: eventKey,
        commit_seq: receipt.first_commit_seq,
        journal_id: receipt.journal_id,
        event_type: spec.event_type,
        entity_id: entityId,
        operation: spec.operation,
        before_hash: beforeHash,
        after_hash: afterHash,
        row_json: rowJson,
        recorded_at: at
      });
      return null;
    });
    if (!outcome.ok) {
      return fail(
        outcome.error,
        outcome.commit_state === "unknown_recovery_required" ? "unknown" : "rejected"
      );
    }
    return ok();
  }

  return {
    async recordStarted(row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>> {
      return commitEvent("started", row);
    },
    async recordFinished(row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>> {
      return commitEvent("finished", row);
    },
    async recordUncertain(row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>> {
      return commitEvent("uncertain", row);
    },
    dispose,
    async hasFinished(row: IdempotencyRowSnapshot): Promise<boolean> {
      // A finished frame for this entity means the request completed; the
      // journal event carries the terminal state.
      if (!isIpcMethod(row.method)) {
        return false;
      }
      const entityId = idempotencyEntityId({
        client_id: row.client_id,
        method: row.method,
        idempotency_key: row.idempotency_key
      });
      const raw = connection
        .prepare<{ readonly event_type: string }>(
          `SELECT event_type FROM ledger_event_log
            WHERE entity_id = :entity_id AND event_type = 'ipc_idempotency.finished'`
        )
        .get({ entity_id: entityId });
      return raw !== undefined;
    }
  };
}
