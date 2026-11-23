import {
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  statSync
} from "node:fs";
import { dirname } from "node:path";
import { canonicalHash, canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Hash, JsonValue, Result } from "@evoplug/core";
import {
  fieldDetails,
  internalDetails,
  storageDetails,
  storageError
} from "../errors.js";
import type { StatementSource } from "../types.js";
import type { BlobStore } from "../blob/store.js";
import { insertQuarantine } from "../schema/quarantine.js";
import {
  commitRecordMatches,
  expectedCommitRecords,
  insertCommitRecord,
  readCommitRecords
} from "../journal/commit-record.js";
import type { CommitRecord, CommitRecordRow } from "../journal/commit-record.js";
import { payloadEvents, payloadMemberBlobs } from "../journal/payload.js";
import type { JournalFramePayload } from "../journal/payload.js";
import {
  projectStateRowEvent,
  StateRowProjectionError,
  type StateRowProjectionEvent,
  type StateRowProjectionRegistration,
} from "./state-row-projection.js";
import {
  FND_STATE_ROW_PROJECTIONS,
  STATE_ROW_REFERENCES
} from "./state-row-registry.js";
import { scanJournalFile } from "../journal/reader.js";
import type { JournalFrameRecord, JournalTailState } from "../journal/reader.js";
import { clearJournalEraPoison, listJournalSegments, poisonJournalEra } from "../journal/era.js";
import { nextJournalPath, receiptRelativePath } from "../journal/writer.js";
import {
  adoptJournalSegment,
  ensureJournalEra,
  readJournalState,
  recordFrameDurability,
  setJournalTailState
} from "../journal/state.js";
import { rebuildStateLedgers } from "./state-ledger-rebuild.js";
import { isErrorEnvelope, mapSqliteFailure } from "../sqlite/tx.js";

export interface JournalRecoveryReport {
  readonly schema_version: "rsi.recovery_report/1";
  readonly journal_id: string;
  readonly frames_scanned: number;
  readonly events_scanned: number;
  readonly trusted_prefix_end: number;
  readonly tail_state: JournalTailState;
  readonly first_commit_seq: number | null;
  readonly last_commit_seq: number | null;
  readonly inserted_commit_records: number;
  readonly quarantined_commit_records: number;
  readonly blob_refs_written: number;
  readonly missing_blobs: readonly Hash[];
  readonly replayed_frames: number;
  /** Typed state rows projected from the scanned frames. */
  readonly projected_state_rows: number;
  readonly degraded_read_only: boolean;
}

interface JournalRecoveryOptions {
  readonly source: StatementSource;
  readonly blob_store: BlobStore;
  readonly journal_id: string;
  readonly journal_path: string;
  /**
   * Home-relative path of `journal_path`. Recovery derives the path of a
   * rotated final segment from it. Defaults to stripping a `journal/`
   * directory from the absolute path.
   */
  readonly relative_path?: string;
  readonly now: number;
  /** Durable values from `journal_state`; defaults are read from SQLite. */
  readonly trusted_prefix_end?: number;
  readonly last_commit_seq?: number;
  readonly base_commit_seq?: number;
  /**
   * Synchronous domain projection hook, invoked per frame in commit_seq order.
   * It receives the same Tx the recovery is running in. `replay`, the generic
   * state-row projection and the outbox projection of one frame share one
   * savepoint, so a failing or divergent frame leaves no member visible.
   */
  readonly replay?: (
    source: StatementSource,
    frame: JournalFrameRecord,
  ) => Result<void, ErrorEnvelope>;
  /**
   * Read-only invariant check for one scanned frame, run before recovery
   * advances `journal_state` or writes `commit_record` rows.
   *
   * The journal is the durable source, but a domain projection such as
   * `event_log` may still be missing because the SQLite transaction that
   * followed the append rolled back. Such a frame cannot be replayed by the
   * generic projectors: the frozen envelope is not the complete row. Returning
   * an error here keeps the persisted trusted prefix where it was, so a later
   * process cannot report `clean`/ready while the projection is absent, and
   * fails with that error. Returning `null` means the frame's projection is
   * present.
   */
  readonly verify_frame?: (
    source: StatementSource,
    frame: JournalFrameRecord,
  ) => ErrorEnvelope | null;
  /**
   * Row schemas owned by `replay` and therefore not handed to the generic
   * state-row projector. This is an exact, closed set: an event whose schema
   * is not listed still fails closed as unregistered. The option is rejected
   * when it is non-empty without a `replay` hook, or when it overlaps the
   * generic registrations (a registered schema must not be silently skipped).
   */
  readonly skip_row_schemas?: readonly string[];
  /**
   * Typed state-row projection. Every `state_row.recorded`,
   * `object_document.recorded`, `object_head.transition` and `outbox.enqueued`
   * member of every scanned frame is projected into its registered table, in
   * commit_seq order, inside the recovery transaction. A frozen `after_hash`
   * that does not match the frozen `row_json`, or a `before_hash` that does
   * not match the current row, is a divergence: the rebuild stops there and
   * enters `degraded_read_only`.
   *
   * The default registry covers the FND-owned typed rows. Owners that register
   * their own rows pass the full list; `project_state_rows: []` disables the
   * projection entirely.
   */
  readonly project_state_rows?: StateRowProjectionRegistration[];
  /**
   * Rebuilds the seven state ledgers (DD-FND-097) from the same scanned frames,
   * in commit order, inside the same per-frame savepoint. Defaults to `true`;
   * `false` is reserved for callers that replay frames only to inspect them.
   *
   * `delivery_history` is part of the rebuild: a transition frame carries the
   * frozen history row, so a database that lost `delivery`/`delivery_history`
   * recovers both from the journal prefix instead of only the current row.
   */
  readonly rebuild_state_ledgers?: boolean;
}

function readFileRange(path: string, start: number, length: number): Uint8Array | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read);
      if (chunk === 0) {
        return null;
      }
      read += chunk;
    }
    return new Uint8Array(buffer);
  } finally {
    closeSync(fd);
  }
}

function quarantineCorruptTail(args: {
  readonly source: StatementSource;
  readonly blob_store: BlobStore;
  readonly journal_id: string;
  readonly journal_path: string;
  readonly from_offset: number;
  readonly byte_length: number;
  readonly reason_code: string;
  readonly now: number;
}): string | null {
  if (args.byte_length <= 0) {
    return null;
  }
  const bytes = readFileRange(args.journal_path, args.from_offset, args.byte_length);
  if (bytes === null) {
    return null;
  }
  const stored = args.blob_store.putSync(bytes);
  if (!stored.ok) {
    return null;
  }
  const bytesRef = `blob://${stored.value.hash}#bytes=0-${bytes.byteLength}`;
  insertQuarantine(args.source, {
    scope: "journal",
    journal_id: args.journal_id,
    byte_offset: args.from_offset,
    reason_code: args.reason_code,
    bytes_ref: bytesRef,
    discovered_at: args.now
  });
  return bytesRef;
}

interface JournalEraCorruption {
  readonly journal_path: string;
  readonly from_offset: number;
  readonly byte_length: number;
  readonly reason_code: string;
}

interface JournalEraScan {
  readonly frames: readonly JournalFrameRecord[];
  /** Segment the era continues in; the last scanned segment. */
  readonly final_path: string;
  /** Trusted byte offset within `final_path`. */
  readonly trusted_prefix_end: number;
  readonly tail_state: JournalTailState;
  readonly corruption: JournalEraCorruption | null;
}

/**
 * Scans a journal era across its contiguous `journal-<NNNNNN>.rsij` segments.
 *
 * A rotation creates the next segment before the SQLite projection records
 * the new path, so a crash can leave durable frames in a segment that
 * `journal_state.relative_path` does not name yet. Scanning only the named
 * segment loses those frames and leaves the era permanently blocked on the
 * orphan file, so every contiguous segment after the named one is scanned in
 * order with the same monotonic commit-sequence guard.
 *
 * A corrupt segment stops the scan: bytes after the corruption cannot be
 * trusted, and later segments would silently skip them.
 */
function scanJournalEra(args: {
  readonly journal_path: string;
  readonly trusted_prefix_end: number;
  readonly last_commit_seq: number;
}): JournalEraScan {
  const segments = listJournalSegments(args.journal_path);
  const frames: JournalFrameRecord[] = [];
  let previousCommitSeq = args.last_commit_seq;
  let finalPath = args.journal_path;
  let finalPrefixEnd = args.trusted_prefix_end;
  let tailState: JournalTailState = "clean";
  let corruption: JournalEraCorruption | null = null;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const startOffset = index === 0 ? args.trusted_prefix_end : 0;
    const scan = scanJournalFile(segment.path, {
      start_offset: startOffset,
      last_commit_seq: previousCommitSeq
    });
    for (const frame of scan.frames) {
      frames.push(frame);
    }
    const last = scan.frames[scan.frames.length - 1];
    if (last !== undefined) {
      previousCommitSeq = last.commit_seq + last.commit_seq_span - 1;
    }
    finalPath = segment.path;
    finalPrefixEnd = scan.trusted_prefix_end;
    tailState = scan.tail_state;
    if (scan.corrupt_offset !== null) {
      // Bytes of a later segment follow the corruption, so even a locally
      // "tail" corruption is a middle corruption for the era: the chain
      // cannot be resumed without searching past bad bytes, which DD-FND-060
      // forbids.
      if (index < segments.length - 1) {
        tailState = "corrupt_middle";
      }
      corruption = {
        journal_path: segment.path,
        from_offset: scan.corrupt_offset,
        byte_length: scan.bytes_total - scan.corrupt_offset,
        reason_code: scan.corrupt_reason ?? "corrupt_tail"
      };
      break;
    }
  }

  return {
    frames,
    final_path: finalPath,
    trusted_prefix_end: finalPrefixEnd,
    tail_state: tailState,
    corruption
  };
}

function storeBlobRow(
  source: StatementSource,
  blobStore: BlobStore,
  hash: Hash,
  byteLength: number,
  now: number,
): void {
  source
    .prepare(
      `INSERT INTO blob (
         blob_hash, byte_length, relative_path, state, verified_at,
         created_at, deleted_at, deletion_reason
       ) VALUES (
         :blob_hash, :byte_length, :relative_path, 'present', :now,
         :now, NULL, NULL
       )
       ON CONFLICT(blob_hash) DO NOTHING`,
    )
    .run({
      blob_hash: hash,
      byte_length: byteLength,
      relative_path: blobStore.relativePath(hash),
      now
    });
}

function insertJournalBlobRef(
  source: StatementSource,
  args: {
    readonly event_id: string;
    readonly blob_hash: Hash;
    readonly payload_len: number;
    readonly now: number;
  },
): number {
  const result = source
    .prepare(
      `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
       VALUES (
         :blob_hash, 'journal', :owner_id,
         :source_ref, :created_at
       )
       ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`,
    )
    .run({
      blob_hash: args.blob_hash,
      owner_id: args.event_id,
      source_ref: `journal://${args.event_id}#bytes=0-${args.payload_len}`,
      created_at: args.now
    });
  return result.changes;
}

function divergenceError(detail: string): ErrorEnvelope {
  return storageError({
    code: "E_REBUILD_DIVERGENCE",
    stage: "storage.recovery",
    details: internalDetails(detail),
    message_key: "error.storage.rebuild_divergence"
  });
}

function projectionConfigError(detail: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_SCHEMA",
    stage: "storage.recovery",
    details: internalDetails(detail),
    message_key: "error.storage.state_row_schema_invalid"
  });
}

function fsyncRecoveryDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface RetiredEra {
  readonly path: string;
  readonly relative_path: string;
  /** False when an earlier retirement already left the empty segment behind. */
  readonly created: boolean;
}

/**
 * Starts a new era after a corrupt tail (DD-FND-060): the corrupt segment is
 * left untouched, the prefix frames are already projected, and all further
 * appends go to a new empty `journal-<NNNNNN>.rsij` segment.
 *
 * Appending behind the un-isolated garbage is what used to make the next
 * frame invisible: the scanner stops at the garbage, so every later frame is
 * shadowed while recovery still reports `clean`. Retiring the segment keeps
 * the sequence monotonic and the corrupt bytes immutable.
 */
function retireCorruptSegment(args: {
  readonly source: StatementSource;
  readonly journal_id: string;
  readonly final_path: string;
  readonly relative_path: string;
  readonly now: number;
}): Result<RetiredEra, ErrorEnvelope> {
  const nextPath = nextJournalPath(args.final_path);
  if (nextPath === null) {
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_STORAGE_CORRUPT",
        stage: "storage.recovery",
        details: storageDetails("journal_era", "not_rotatable"),
        side_effect: "none"
      })
    };
  }
  const nextRelative = receiptRelativePath(args.relative_path, nextPath);
  if (nextRelative === null) {
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_STORAGE_CORRUPT",
        stage: "storage.recovery",
        details: storageDetails("journal_era", "next_relative_path_invalid"),
        side_effect: "none"
      })
    };
  }
  let created = false;
  try {
    const fd = openSync(nextPath, "wx");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncRecoveryDirectory(dirname(nextPath));
    created = true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? (error as { readonly code?: unknown }).code
        : undefined;
    // A previous retirement may have created and fsynced the empty segment
    // before failing. Adopting it is safe only while it is still empty; a
    // non-empty next segment belongs to the scanned era and would have been
    // scanned instead.
    let existingEmpty = false;
    if (code === "EEXIST") {
      try {
        existingEmpty = statSync(nextPath).size === 0;
      } catch {
        existingEmpty = false;
      }
    }
    if (!existingEmpty) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_IO",
          stage: "storage.recovery",
          details: storageDetails(
            "journal_era",
            typeof code === "string" ? code : "create_failed"
          ),
          side_effect: "unknown"
        })
      };
    }
  }
  adoptJournalSegment(args.source, {
    journal_id: args.journal_id,
    relative_path: nextRelative,
    trusted_prefix_end: 0,
    tail_state: "clean",
    updated_at: args.now
  });
  return {
    ok: true,
    status: "ok",
    value: { path: nextPath, relative_path: nextRelative, created }
  };
}

/**
 * The `commit_seq` a host event envelope hashes, or null for other frames.
 * The envelope hash covers this value, so it must agree with the frame
 * header; a mismatch cannot be projected under either sequence.
 */
function embeddedEventCommitSeq(payload: JournalFramePayload): number | null {
  const body = payload as { readonly event?: unknown };
  const event = body.event;
  if (typeof event !== "object" || event === null) {
    return null;
  }
  const record = event as {
    readonly schema_version?: unknown;
    readonly commit_seq?: unknown;
  };
  if (record.schema_version !== "rsi.event/1") {
    return null;
  }
  const seq = record.commit_seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) ? seq : null;
}

/** Savepoint around one frame's replay + generic + outbox projection. */
function beginFrameProjection(source: StatementSource): void {
  source.prepare("SAVEPOINT rsi_recovery_frame").run();
}

function rollbackFrameProjection(source: StatementSource): void {
  try {
    source.prepare("ROLLBACK TO rsi_recovery_frame").run();
    source.prepare("RELEASE rsi_recovery_frame").run();
  } catch {
    // The connection is already unwinding; the caller still fails closed.
  }
}

function releaseFrameProjection(source: StatementSource): void {
  source.prepare("RELEASE rsi_recovery_frame").run();
}

interface CommitReconciliation {
  readonly inserted: number;
  readonly quarantined: number;
  readonly divergent: boolean;
  readonly expected: readonly CommitRecord[];
  readonly extraSeqs: readonly number[];
}

function reconcileCommitRecords(
  source: StatementSource,
  journalId: string,
  frames: readonly JournalFrameRecord[],
  trustedLastCommitSeq: number,
  now: number,
): CommitReconciliation {
  const expected: CommitRecord[] = [];
  for (const frame of frames) {
    const records = expectedCommitRecords({
      journal_id: journalId,
      commit_seq: frame.commit_seq,
      payload: frame.payload,
      committed_at: now,
      indexed_at: null
    });
    if (!records.ok) {
      throw records.error;
    }
    expected.push(...records.value);
  }
  const existing = readCommitRecords(source, journalId);
  const existingBySeq = new Map<number, CommitRecordRow>();
  for (const row of existing) {
    existingBySeq.set(Number(row.commit_seq), row);
  }
  let inserted = 0;
  let quarantined = 0;
  let divergent = false;
  const expectedSeqs = new Set<number>();
  const firstExpected = expected.length === 0 ? 0 : (expected[0]?.commit_seq ?? 0);
  const lastExpected =
    expected.length === 0 ? 0 : (expected[expected.length - 1]?.commit_seq ?? 0);
  for (const record of expected) {
    expectedSeqs.add(record.commit_seq);
    const row = existingBySeq.get(record.commit_seq);
    if (row === undefined) {
      insertCommitRecord(source, record);
      inserted += 1;
      continue;
    }
    if (!commitRecordMatches(row, record)) {
      divergent = true;
      insertQuarantine(source, {
        scope: "journal",
        journal_id: journalId,
        commit_seq: record.commit_seq,
        reason_code: "commit_record_divergence",
        payload_hash: record.payload_hash,
        discovered_at: now
      });
    }
  }
  const extraSeqs: number[] = [];
  for (const row of existing) {
    const seq = Number(row.commit_seq);
    if (expectedSeqs.has(seq)) {
      continue;
    }
    // Frames at or below the trusted prefix were reconciled by the commit that
    // wrote them; the scan intentionally starts after `trusted_prefix_end`, so
    // they have no frame in `scan.frames` on a clean restart.
    if (seq <= trustedLastCommitSeq) {
      continue;
    }
    if (seq > lastExpected) {
      divergent = true;
      insertQuarantine(source, {
        scope: "journal",
        journal_id: journalId,
        commit_seq: seq,
        reason_code: "commit_record_without_frame",
        discovered_at: now
      });
      continue;
    }
    if (seq >= firstExpected && seq <= lastExpected) {
      extraSeqs.push(seq);
      insertQuarantine(source, {
        scope: "journal",
        journal_id: journalId,
        commit_seq: seq,
        reason_code: "commit_record_extra",
        discovered_at: now
      });
      quarantined += 1;
    }
  }
  return { inserted, quarantined, divergent, expected, extraSeqs };
}

/**
 * Scans the journal from its trusted prefix, reconciles `commit_record` rows and
 * rebuilds the journal `blob_ref` closure. Projection of domain rows is done by
 * the caller's synchronous `replay` hook, per frame, in commit_seq order.
 *
 * A corrupt middle classifies the era `read_only=1` and returns
 * `E_JOURNAL_CORRUPT_MIDDLE`; a corrupt tail is quarantined and the trusted
 * prefix remains usable. A divergence returns `E_REBUILD_DIVERGENCE`.
 */
export function recoverJournal(
  options: JournalRecoveryOptions,
): Result<JournalRecoveryReport, ErrorEnvelope> {
  const stateRowRegistrations =
    options.project_state_rows ?? FND_STATE_ROW_PROJECTIONS;
  const skipRowSchemas = new Set(options.skip_row_schemas ?? []);
  // Validate the ownership split before touching the journal state: a bad
  // configuration must not advance the trusted prefix.
  if (skipRowSchemas.size > 0) {
    if (options.replay === undefined) {
      return {
        ok: false,
        status: "rejected",
        error: projectionConfigError("skip_row_schemas_without_replay")
      };
    }
    for (const registration of stateRowRegistrations) {
      if (skipRowSchemas.has(registration.row_schema)) {
        return {
          ok: false,
          status: "rejected",
          error: projectionConfigError(
            `skip_row_schemas_overlaps_registration:${registration.row_schema}`
          )
        };
      }
    }
  }
  const existingState = readJournalState(options.source, options.journal_id);
  const trustedPrefixEnd =
    options.trusted_prefix_end ?? existingState?.trusted_prefix_end ?? 0;
  const lastCommitSeq =
    options.last_commit_seq ?? existingState?.last_commit_seq ?? 0;
  const scan = scanJournalEra({
    journal_path: options.journal_path,
    trusted_prefix_end: trustedPrefixEnd,
    last_commit_seq: lastCommitSeq
  });
  // Keep the era's home-relative path shape when the scan advanced into a
  // rotated segment. Reconstructing it from the absolute file path loses the
  // home prefix (and fails outright when the journal directory is the home
  // itself), which would make the next writer reject its own state row.
  const relativePath =
    existingState === null
      ? (receiptRelativePath(
          options.relative_path ?? relativizeJournalPath(options.journal_path),
          scan.final_path
        ) ?? relativizeJournalPath(scan.final_path))
      : (receiptRelativePath(existingState.relative_path, scan.final_path) ??
        relativizeJournalPath(scan.final_path));

  if (scan.corruption !== null) {
    quarantineCorruptTail({
      source: options.source,
      blob_store: options.blob_store,
      journal_id: options.journal_id,
      journal_path: scan.corruption.journal_path,
      from_offset: scan.corruption.from_offset,
      byte_length: scan.corruption.byte_length,
      reason_code: scan.corruption.reason_code,
      now: options.now
    });
  }

  const firstFrame = scan.frames[0];
  const lastFrame = scan.frames[scan.frames.length - 1];
  // A state-less era starts at its first frame, not at sequence zero. Without
  // this, `journal_state` would be inserted with `last_commit_seq <
  // base_commit_seq` and the CHECK would surface as `E_INTERNAL`. The base is
  // the sequence immediately before the first durable frame; the persisted
  // sequence may not exceed the last frame already on disk.
  const segmentBase =
    firstFrame === undefined ? 0 : Math.max(0, firstFrame.commit_seq - 1);
  const effectiveBase =
    existingState?.base_commit_seq ?? options.base_commit_seq ?? segmentBase;
  const effectiveLastBefore =
    existingState?.last_commit_seq ??
    (firstFrame === undefined
      ? Math.max(lastCommitSeq, effectiveBase)
      : Math.min(
          Math.max(lastCommitSeq, effectiveBase),
          Math.max(effectiveBase, firstFrame.commit_seq - 1)
        ));

  if (existingState === null) {
    try {
      ensureJournalEra(options.source, {
        journal_id: options.journal_id,
        relative_path: relativePath,
        base_commit_seq: effectiveBase,
        last_commit_seq: effectiveLastBefore,
        trusted_prefix_end: trustedPrefixEnd,
        tail_state: scan.tail_state,
        updated_at: options.now
      });
    } catch {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_CORRUPT",
          stage: "storage.recovery",
          details: storageDetails("journal_state", "insert_failed"),
          side_effect: "none"
        })
      };
    }
  }

  /**
   * Leaves the persisted prefix exactly where it was and records a durable
   * read-only fence. Every failure below uses this: advancing the prefix past
   * frames that were not fully projected is what let a later recovery scan
   * zero frames, clear `read_only`, and report `clean` while rows stayed
   * missing.
   */
  const fenceReadOnly = (tailState: JournalTailState): void => {
    try {
      setJournalTailState(
        options.source,
        options.journal_id,
        tailState,
        true,
        trustedPrefixEnd,
        options.now
      );
    } catch {
      // The poisoned era still blocks writers in this process; the caller
      // returns the original failure either way.
    }
    poisonJournalEra(scan.final_path, options.journal_id);
  };

  if (scan.tail_state === "corrupt_middle") {
    fenceReadOnly("corrupt_middle");
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_JOURNAL_CORRUPT_MIDDLE",
        stage: "storage.recovery",
        details: storageDetails(
          "scan_journal",
          scan.corruption?.reason_code ?? "corrupt_middle",
          scan.corruption?.from_offset,
        ),
        side_effect: "none"
      })
    };
  }

  const mismatchedFrame = scan.frames.find((frame) => {
    const embedded = embeddedEventCommitSeq(frame.payload);
    return embedded !== null && embedded !== frame.commit_seq;
  });
  if (mismatchedFrame !== undefined) {
    // Keep the persisted prefix where it was: advancing past an inconsistent
    // frame would make the next recovery skip it forever.
    fenceReadOnly(scan.tail_state);
    return {
      ok: false,
      status: "conflict",
      error: divergenceError(
        `embedded_commit_seq_mismatch:${mismatchedFrame.commit_seq}`
      )
    };
  }
  if (options.verify_frame !== undefined) {
    for (const frame of scan.frames) {
      const violation = options.verify_frame(options.source, frame);
      if (violation !== null) {
        // Do not advance the trusted prefix or insert commit records: the
        // frame is durable but its domain projection is absent, so leaving the
        // prefix behind makes the next process re-check the same frame instead
        // of silently reporting a clean recovery.
        fenceReadOnly(scan.tail_state);
        return { ok: false, status: "conflict", error: violation };
      }
    }
  }

  const reconciliation = reconcileCommitRecords(
    options.source,
    options.journal_id,
    scan.frames,
    effectiveLastBefore,
    options.now,
  );

  const missingBlobs: Hash[] = [];
  let blobRefsWritten = 0;
  for (const frame of scan.frames) {
    const members = payloadMemberBlobs(frame.payload);
    if (!members.ok) {
      fenceReadOnly(scan.tail_state);
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_LEDGER_EVENT_INVALID",
          stage: "storage.recovery",
          details: fieldDetails("frame.members", members.error.detail)
        })
      };
    }
    for (const member of members.value) {
      for (const hash of member.blob_hashes) {
        const verification = options.blob_store.verify(hash);
        if (!verification.ok) {
          fenceReadOnly(scan.tail_state);
          return verification;
        }
        if (!verification.value.present || !verification.value.hash_matches) {
          missingBlobs.push(hash);
          continue;
        }
        storeBlobRow(
          options.source,
          options.blob_store,
          hash,
          verification.value.byte_length ?? 0,
          options.now,
        );
        blobRefsWritten += insertJournalBlobRef(options.source, {
          event_id: member.event_id,
          blob_hash: hash,
          payload_len: frame.payload_len,
          now: options.now
        });
      }
    }
  }

  // A frame whose blob is missing cannot be projected: the row may reference
  // it. DD-FND-060 requires the rebuild to fail closed with `E_BLOB_MISSING`
  // and to enter `degraded_read_only` instead of projecting a partial batch.
  if (missingBlobs.length > 0) {
    const missing = missingBlobs[0]!;
    fenceReadOnly(scan.tail_state);
    return {
      ok: false,
      status: "degraded",
      error: storageError({
        code: "E_BLOB_MISSING",
        stage: "storage.recovery",
        details: {
          kind: "source",
          source_ref: `blob://${missing}#bytes=0-0`,
          reason: "missing"
        },
        side_effect: "none"
      })
    };
  }

  // Set when the typed projection stops at a divergence. The rebuild then
  // keeps the trusted prefix and enters `degraded_read_only`.
  let divergent = false;

  if (reconciliation.divergent) {
    fenceReadOnly(scan.tail_state);
    return {
      ok: false,
      status: "conflict",
      error: divergenceError("commit_record_divergence")
    };
  }

  let replayedFrames = 0;
  let projectedRows = 0;
  const rebuildLedgers = options.rebuild_state_ledgers !== false;
  if (
    stateRowRegistrations.length > 0 ||
    options.replay !== undefined ||
    rebuildLedgers
  ) {
    for (const frame of scan.frames) {
      let frameRows = 0;
      // DD-FND-060: a frame is the unit of projection. Replay, generic typed
      // rows and outbox rows either all become visible or none do.
      beginFrameProjection(options.source);
      try {
        if (options.replay !== undefined) {
          const replayed = options.replay(options.source, frame);
          if (!replayed.ok) {
            rollbackFrameProjection(options.source);
            fenceReadOnly(scan.tail_state);
            return replayed;
          }
        }
        let frameDivergent = false;
        if (stateRowRegistrations.length > 0) {
          const projected = projectFrameStateRows(
            options,
            frame,
            stateRowRegistrations,
            skipRowSchemas
          );
          if (!projected.ok) {
            rollbackFrameProjection(options.source);
            fenceReadOnly(scan.tail_state);
            return { ok: false, status: "conflict", error: projected.error };
          }
          frameRows = projected.value;
          frameDivergent = projected.divergent;
          if (!frameDivergent) {
            const outbox = projectOutboxRows(options, frame);
            if (!outbox.ok) {
              rollbackFrameProjection(options.source);
              fenceReadOnly(scan.tail_state);
              return { ok: false, status: "conflict", error: outbox.error };
            }
          }
        }
        if (rebuildLedgers) {
          // Ledger rows (delivery, replay, egress, ipc idempotency, rate
          // limit) and `delivery_history` are rebuilt from the same frozen
          // frame. A divergence rolls the whole frame back, exactly like the
          // typed-row projector, so the trusted prefix stops before it.
          const ledger = rebuildStateLedgers({
            source: options.source,
            frames: [frame],
            now: options.now
          });
          if (!ledger.ok) {
            rollbackFrameProjection(options.source);
            fenceReadOnly(scan.tail_state);
            return { ok: false, status: "conflict", error: ledger.error };
          }
        }
        if (frameDivergent) {
          // The rebuild stops at that frame, keeps the trusted prefix and
          // enters `degraded_read_only`. Nothing of the divergent frame
          // survives the savepoint rollback.
          rollbackFrameProjection(options.source);
          divergent = true;
          break;
        }
        releaseFrameProjection(options.source);
      } catch (error) {
        rollbackFrameProjection(options.source);
        fenceReadOnly(scan.tail_state);
        // A thrown SQL failure is a fail-closed projection failure too. It is
        // reported as a typed envelope instead of escaping as an internal
        // crash; the prefix and read-only fence above are already persisted.
        return {
          ok: false,
          status: "rejected",
          error: isErrorEnvelope(error)
            ? error
            : mapSqliteFailure(error, "storage.recovery", "project_frame")
        };
      }
      if (options.replay !== undefined) {
        replayedFrames += 1;
      }
      projectedRows += frameRows;
    }
  }

  const buildReport = (degraded: boolean): JournalRecoveryReport => ({
    schema_version: "rsi.recovery_report/1",
    journal_id: options.journal_id,
    frames_scanned: scan.frames.length,
    events_scanned: scan.frames.reduce((total, frame) => total + frame.commit_seq_span, 0),
    trusted_prefix_end: scan.trusted_prefix_end,
    tail_state: scan.tail_state,
    first_commit_seq: firstFrame === undefined ? null : firstFrame.commit_seq,
    last_commit_seq:
      lastFrame === undefined ? null : lastFrame.commit_seq + lastFrame.commit_seq_span - 1,
    inserted_commit_records: reconciliation.inserted,
    quarantined_commit_records: reconciliation.quarantined,
    blob_refs_written: blobRefsWritten,
    missing_blobs: missingBlobs,
    replayed_frames: replayedFrames,
    projected_state_rows: projectedRows,
    degraded_read_only: degraded
  });

  if (divergent) {
    // A divergent frame was not projected. Moving the prefix over it would
    // make the next recovery scan zero frames and clear the read-only flag,
    // so the degraded window is recorded against the old prefix instead.
    fenceReadOnly(scan.tail_state);
    return { ok: true, status: "ok", value: buildReport(true) };
  }

  // Every scanned frame is projected. Only now may the durable tail and the
  // trusted prefix move; a failure above leaves both exactly where the last
  // successful transaction put them.
  if (lastFrame !== undefined) {
    recordFrameDurability(options.source, {
      journal_id: options.journal_id,
      relative_path: relativePath,
      first_commit_seq: lastFrame.commit_seq,
      member_count: lastFrame.commit_seq_span,
      trusted_prefix_end: scan.trusted_prefix_end,
      updated_at: options.now,
      base_commit_seq: effectiveBase,
      tail_state: scan.tail_state
    });
  } else {
    // A rotation that created the next segment without writing a frame leaves
    // no frame to record. Adopt its path so the writer stops treating it as an
    // orphan and the next rotation can proceed; the sequence is unchanged.
    adoptJournalSegment(options.source, {
      journal_id: options.journal_id,
      relative_path: relativePath,
      trusted_prefix_end: scan.trusted_prefix_end,
      tail_state: scan.tail_state,
      updated_at: options.now
    });
  }

  let stateTail: JournalTailState = scan.tail_state;
  let statePrefix = scan.trusted_prefix_end;
  if (scan.tail_state === "corrupt_tail") {
    // DD-FND-060: the corrupt bytes stay quarantined and the era continues in
    // a new segment. Appending behind them would make every later frame
    // invisible to the sequential scanner while recovery reported `clean`.
    const retired = retireCorruptSegment({
      source: options.source,
      journal_id: options.journal_id,
      final_path: scan.final_path,
      relative_path: relativePath,
      now: options.now
    });
    if (!retired.ok) {
      try {
        setJournalTailState(
          options.source,
          options.journal_id,
          "corrupt_tail",
          true,
          scan.trusted_prefix_end,
          options.now
        );
      } catch {
        // The era stays poisoned; the original error is returned.
      }
      poisonJournalEra(scan.final_path, options.journal_id);
      return retired;
    }
    stateTail = "clean";
    statePrefix = 0;
    clearJournalEraPoison(retired.value.path, options.journal_id);
  }

  setJournalTailState(
    options.source,
    options.journal_id,
    stateTail,
    false,
    statePrefix,
    options.now,
  );

  // Recovery is the only operation allowed to lift the era fence: the
  // persisted tail now covers every durable frame, so a writer may allocate
  // the next sequence without reusing one. Degraded/conflict returns above
  // deliberately leave the fence in place.
  clearJournalEraPoison(scan.final_path, options.journal_id);

  return { ok: true, status: "ok", value: buildReport(false) };
}

/**
 * Projects every typed member of one frame into its registered table.
 *
 * The frame is projected as a whole: the first invalid member stops the
 * rebuild at that frame and no member of it becomes visible.
 */
/**
 * Projects the `outbox.enqueued` members of one frame.
 *
 * The outbox row is a ledger row, not a typed state row: it carries the
 * complete physical row and the `after_hash` of DD-FND-097.2. The rebuild
 * copies the frozen row verbatim and never leases, retries or sends it.
 */
function projectOutboxRows(
  options: JournalRecoveryOptions,
  frame: JournalFrameRecord
): { ok: true } | { ok: false; error: ErrorEnvelope } {
  for (const event of payloadEvents(frame.payload)) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      continue;
    }
    const record = event as Record<string, JsonValue>;
    if (record["event_type"] !== "outbox.enqueued" || record["entity_type"] !== "outbox") {
      continue;
    }
    const rowJson = record["row_json"];
    const rowSchema = record["row_schema"];
    const afterHash = record["after_hash"];
    if (typeof rowJson !== "string" || typeof afterHash !== "string") {
      continue;
    }
    // Only the registered outbox row schema is projected here. A frame that
    // carries an `outbox.enqueued` event under another schema is not an outbox
    // row and belongs to the caller's own replay hook.
    if (rowSchema !== "rsi.outbox/1") {
      continue;
    }
    let row: Record<string, JsonValue>;
    try {
      const parsed: unknown = JSON.parse(rowJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          ok: false,
          error: divergenceError("outbox_row_json_not_object")
        };
      }
      row = parsed as Record<string, JsonValue>;
    } catch {
      return { ok: false, error: divergenceError("outbox_row_json_not_json") };
    }
    const computed = canonicalHash({ row_schema: "rsi.outbox/1", row_json: rowJson });
    if (computed !== afterHash) {
      return { ok: false, error: divergenceError("outbox_after_hash_mismatch") };
    }
    const outboxId = row["outbox_id"];
    if (typeof outboxId !== "string") {
      return { ok: false, error: divergenceError("outbox_id_missing") };
    }
    const existing = options.source
      .prepare<{ outbox_id: string }>(
        "SELECT outbox_id FROM outbox WHERE outbox_id = :outbox_id"
      )
      .get({ outbox_id: outboxId });
    if (existing !== undefined) {
      // An identical pending row is idempotent; a different one is a conflict.
      const current = options.source
        .prepare<Record<string, JsonValue>>(
          "SELECT * FROM outbox WHERE outbox_id = :outbox_id"
        )
        .get({ outbox_id: outboxId });
      if (current === undefined) {
        return { ok: false, error: divergenceError("outbox_row_missing") };
      }
      const currentHash = canonicalHash({
        row_schema: "rsi.outbox/1",
        row_json: canonicalJsonText(current as JsonValue)
      });
      if (currentHash === computed) {
        continue;
      }
      return { ok: false, error: divergenceError("outbox_row_conflict") };
    }
    const columns = Object.keys(row);
    const placeholders = columns.map((column) => `:${column}`).join(", ");
    options.source
      .prepare(`INSERT INTO outbox (${columns.join(", ")}) VALUES (${placeholders})`)
      .run(row);
  }
  return { ok: true };
}

function projectFrameStateRows(
  options: JournalRecoveryOptions,
  frame: JournalFrameRecord,
  registrations: readonly StateRowProjectionRegistration[],
  skipRowSchemas: ReadonlySet<string>
): { ok: true; value: number; divergent: boolean } | { ok: false; error: ErrorEnvelope } {
  const projectionOptions = {
    source: options.source,
    registrations,
    now: options.now,
    references: STATE_ROW_REFERENCES
  };
  let projected = 0;
  let divergent = false;
  for (const event of payloadEvents(frame.payload)) {
    const rowSchema = eventRowSchema(event);
    if (rowSchema !== null && skipRowSchemas.has(rowSchema)) {
      // Owned by the replay hook, which ran for this frame before the generic
      // projector. Only the exact configured schemas are skipped.
      continue;
    }
    const member = asProjectionEvent(event);
    if (member === null) {
      continue;
    }
    try {
      const report = projectStateRowEvent(projectionOptions, member);
      projected += report.projected_rows;
    } catch (error) {
      if (error instanceof StateRowProjectionError) {
        // A divergence is not a crash: the rebuild stops at that frame, keeps
        // the trusted prefix and enters `degraded_read_only`. The era stays
        // readable for diagnosis and explicit repair only.
        if (error.envelope.code === "E_REBUILD_DIVERGENCE") {
          divergent = true;
          break;
        }
        return { ok: false, error: error.envelope };
      }
      throw error;
    }
  }
  return { ok: true, value: projected, divergent };
}

/** The `row_schema` of a ledger-shaped event, when it carries one. */
function eventRowSchema(event: JsonValue): string | null {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return null;
  }
  const rowSchema = (event as Record<string, JsonValue>)["row_schema"];
  return typeof rowSchema === "string" ? rowSchema : null;
}

/** Narrows a frame event to the shapes the state-row reducer consumes. */
function asProjectionEvent(event: JsonValue): StateRowProjectionEvent | null {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return null;
  }
  const record = event as Record<string, JsonValue>;
  const eventType = record["event_type"];
  const entityType = record["entity_type"];
  const rowSchema = record["row_schema"];
  const rowJson = record["row_json"];
  const afterHash = record["after_hash"];
  const beforeHash = record["before_hash"];
  const operation = record["operation"];
  if (
    typeof rowJson !== "string" ||
    typeof afterHash !== "string" ||
    typeof rowSchema !== "string"
  ) {
    return null;
  }
  // DD-FND-097.2: a typed state row travels in a `rsi.ledger_event/1`
  // envelope. A member with a different envelope schema is not a typed state
  // row and is left to the caller's own replay hook.
  if (record["schema_version"] !== "rsi.ledger_event/1") {
    return null;
  }
  const entityId = typeof record["entity_id"] === "string" ? record["entity_id"] : "";
  const documentId =
    typeof record["document_id"] === "string" ? (record["document_id"] as Hash) : null;
  const frozenBeforeHash =
    typeof beforeHash === "string" ? (beforeHash as Hash) : null;
  if (eventType === "state_row.recorded" && entityType === "state_row") {
    if (
      operation !== "insert" &&
      operation !== "update" &&
      operation !== "transition"
    ) {
      return null;
    }
    return {
      event_type: "state_row.recorded",
      entity_type: "state_row",
      entity_id: entityId,
      operation,
      before_hash: frozenBeforeHash,
      after_hash: afterHash as Hash,
      row_schema: rowSchema,
      row_json: rowJson,
      binding: (record["binding"] ?? null) as JsonValue
    };
  }
  if (eventType === "object_document.recorded" && entityType === "object_document") {
    return {
      event_type: "object_document.recorded",
      entity_type: "object_document",
      entity_id: entityId,
      operation: "insert",
      after_hash: afterHash as Hash,
      row_schema: "rsi.object_document_row/1",
      row_json: rowJson,
      document_id: documentId
    };
  }
  if (eventType === "object_head.transition" && entityType === "object_head") {
    if (operation !== "insert" && operation !== "transition") {
      return null;
    }
    return {
      event_type: "object_head.transition",
      entity_type: "object_head",
      entity_id: entityId,
      operation,
      before_hash: frozenBeforeHash,
      after_hash: afterHash as Hash,
      row_schema: "rsi.object_head_row/1",
      row_json: rowJson,
      document_id: documentId
    };
  }
  return null;
}

function relativizeJournalPath(path: string): string {
  const marker = "/journal/";
  const index = path.lastIndexOf(marker);
  return index === -1 ? path : path.slice(index + 1);
}

