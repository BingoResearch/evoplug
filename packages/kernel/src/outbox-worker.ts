/**
 * Outbox delivery worker (DD-FND-057, DD-FND-061, DD-FND-092, DD-FND-097.4).
 *
 * The worker owns exactly two effects: `delivery.dispatch` and
 * `delivery.expire`. It leases one due row with a token-fenced CAS, records a
 * `started` attempt before any external call, dispatches through an injected
 * HOST delivery port, and then advances the delivery transport/inclusion axes
 * and the outbox row together.
 *
 * Invariants:
 * - a row is only claimed from `pending`, so at most one worker owns a lease;
 * - every external call happens behind a `leased` row whose `lease_token` is
 *   rechecked on every state transition and renewed while the call is running;
 * - a timeout, transport error or any other unknown outcome becomes
 *   `uncertain` with `reconcile_required=1` and is never retried automatically;
 * - an absent HOST port releases the lease without consuming an attempt, so the
 *   row stays recoverable;
 * - journal frames are appended and fsynced before the SQLite projections they
 *   describe when a `JournalCommitter` is supplied.
 *
 * The HOST port deliberately receives a narrow, row-shaped request. Building a
 * full `HostDeliveryRequest` (`host_binding`, `boundary_event_ref`, `nonce`,
 * `max_chars`, `wait_mode`) remains a HOST composition concern because those
 * values are not persisted on `delivery`.
 */

import { randomUUID } from "node:crypto";

import { canonicalHash, canonicalJsonText, isJsonValue, newId } from "@evoplug/core";
import type {
  ErrorEnvelope,
  FailureStatus,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  Tx,
  VersionBinding
} from "@evoplug/core";
import type {
  HostAdapterError,
  HostAdapterResult,
  HostDeliveryResult,
  InclusionLevel
} from "@evoplug/core/host";
import {
  applyDeliveryUpdate,
  expireDelivery,
  validateDeliveryEffectKey
} from "@evoplug/delivery";
import type {
  DeliveryRecord,
  DeliveryTerminalReason,
  DeliveryUpdateOutcome,
  DeliveryUpdateRequest,
  InclusionEvidence
} from "@evoplug/delivery";
import {
  OUTBOX_LEASE_MS,
  createTransactionRunner,
  isErrorEnvelope,
  listOutboxAttempts,
  outboxBackoffMs,
  readOutboxAttempt,
  readOutboxRow,
  renewOutboxLease,
  validateOutboxEffect
} from "@evoplug/storage";
import type { JournalAppendResult, JournalCommitter, JournalFramePayload, OutboxAttemptRow, OutboxRow, SqliteConnection } from "@evoplug/storage";

import { internalError } from "./errors.js";
import { readDeliveryRecord } from "./delivery-row.js";
import { stageDueDeliveryExpiry } from "./delivery-expiry.js";
import type { DeliveryExpirySweepEnqueuePort } from "./delivery-expiry.js";
import {
  createDeliveryTransitionWriter,
  type DeliveryTransitionWriter
} from "./delivery-transition.js";

/* ------------------------------------------------------------------ */
/* Public contract                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_OUTBOX_WORKER_INTERVAL_MS = 1000;
const DEFAULT_OUTBOX_UNAVAILABLE_RETRY_MS = 30000;
const DEFAULT_OUTBOX_DISPATCH_DEADLINE_MS = 20000;

/**
 * Narrow HOST delivery port. The HOST composition maps this row-shaped request
 * onto its adapter's `deliver(HostDeliveryRequest, AbortSignal)`.
 */
export interface OutboxDeliveryPort {
  deliver(
    request: OutboxDeliveryDispatchRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<HostDeliveryResult>>;
}

export interface OutboxDeliveryDispatchRequest {
  readonly delivery_id: Id<"del">;
  readonly submission_attempt: number;
  readonly attempt: number;
  readonly lease_token: string;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly content_ref: SourceRef;
  readonly content_hash: Hash;
  readonly expires_at: number;
  readonly idempotency_key: string;
  readonly deadline_ms: number;
}

interface OutboxWorkerDeps {
  readonly connection: SqliteConnection;
  readonly now?: () => number;
  /** Stable worker identity recorded in `outbox.lease_owner`. */
  readonly owner?: string;
  /** Absent means every dispatch fails closed and stays recoverable. */
  readonly delivery?: OutboxDeliveryPort;
  /** When supplied, every business projection is journaled first. */
  readonly journal?: JournalCommitter;
  /** Optional evidence reachability check for inclusion evidence refs. */
  readonly isEvidenceRetrievable?: (ref: SourceRef) => boolean;
  readonly lease_ms?: number;
  readonly interval_ms?: number;
  readonly dispatch_deadline_ms?: number;
  readonly unavailable_retry_ms?: number;
  /**
   * W5: stage `delivery.expire` effects for due rows before claiming one.
   * Default `false` keeps the pre-W5 worker behavior; production enables it
   * only when an explicit delivery TTL was configured.
   */
  readonly delivery_expiry_sweep?: boolean;
  /** Per-pass staging bound; default 100. */
  readonly delivery_expiry_sweep_limit?: number;
  /**
   * Durable enqueue for the sweep. Required when the sweep is enabled: the
   * outbox row and its `outbox.enqueued` member must share one journal frame,
   * so a direct SQL insert is never accepted.
   */
  readonly delivery_expiry_sweep_enqueue?: DeliveryExpirySweepEnqueuePort;
}

type OutboxDisposition =
  | "done"
  | "retry"
  | "failed"
  | "uncertain"
  | "skipped"
  | "fenced";

interface OutboxRunResult {
  readonly status: "idle" | "processed" | "error";
  readonly outbox_id: string | null;
  readonly effect_kind: string | null;
  readonly disposition: OutboxDisposition | null;
  readonly error?: ErrorEnvelope;
}

interface OutboxWorkerStartOptions {
  readonly interval_ms?: number;
}

export interface OutboxWorker {
  readonly worker_id: string;
  /** Processes at most one due row. Calls are serialised per worker. */
  runOnce(): Promise<OutboxRunResult>;
  /** Reclaims expired leases without claiming a new external effect. */
  recover(): Promise<OutboxRunResult>;
  /** Starts a timer-driven loop; idempotent while already running. */
  start(options?: OutboxWorkerStartOptions): void;
  /**
   * Stops the loop, aborts every in-flight or queued dispatch run, and then
   * waits for the real serialized tail to settle. The abort is advisory: a
   * delivery that the HOST already claimed resolves as evidence-unknown and is
   * never replayed automatically.
   */
  stop(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

type JsonRecord = Record<string, JsonValue>;

interface Ok<T> {
  readonly ok: true;
  readonly status: "ok";
  readonly value: T;
}

function ok<T>(value: T): Ok<T> {
  return { ok: true, status: "ok", value };
}

function fail<T>(error: ErrorEnvelope, status: FailureStatus = "rejected"): Result<T, ErrorEnvelope> {
  return { ok: false, status, error };
}

function parseJsonObject(text: string): JsonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonValue(parsed) || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

function bindingJson(binding: VersionBinding): JsonRecord {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

/* ------------------------------------------------------------------ */
/* Outbox row <-> DDL                                                 */
/* ------------------------------------------------------------------ */

function outboxRowJson(row: OutboxRow): JsonRecord {
  return {
    outbox_id: row.outbox_id,
    effect_kind: row.effect_kind,
    effect_key: row.effect_key,
    payload_json: row.payload_json,
    state: row.state,
    priority: row.priority,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at,
    lease_owner: row.lease_owner,
    lease_token: row.lease_token,
    lease_expires_at: row.lease_expires_at,
    reconcile_required: row.reconcile_required,
    last_error_code: row.last_error_code,
    result_ref: row.result_ref,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function attemptRowJson(row: OutboxAttemptRow): JsonRecord {
  return {
    outbox_attempt_id: row.outbox_attempt_id,
    outbox_id: row.outbox_id,
    attempt: row.attempt,
    state: row.state,
    error_code: row.error_code,
    started_at: row.started_at,
    ended_at: row.ended_at
  };
}

/* ------------------------------------------------------------------ */
/* Journal-first projections                                          */
/* ------------------------------------------------------------------ */

interface LedgerEventInput {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation: "insert" | "update" | "transition";
  readonly binding: VersionBinding | null;
  readonly row_schema: string;
  readonly row: JsonRecord;
  readonly before: JsonRecord | null;
  readonly project: (tx: Tx, eventId: Id<"ev">) => void;
}

function insertLedgerEventLog(
  tx: Tx,
  input: {
    readonly receipt: JournalAppendResult;
    readonly event_id: string;
    readonly event_key: Hash;
    readonly event_type: string;
    readonly entity_type: string;
    readonly entity_id: string;
    readonly operation: LedgerEventInput["operation"];
    readonly binding: VersionBinding | null;
    readonly before_hash: Hash | null;
    readonly after_hash: Hash;
    readonly row_schema: string;
    readonly row_json: string;
    readonly recorded_at: number;
  }
): void {
  const binding = input.binding;
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, :binding_mode, :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: input.event_id,
    event_key: input.event_key,
    commit_seq: input.receipt.first_commit_seq,
    journal_id: input.receipt.journal_id,
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    binding_mode: binding === null ? "global" : "bound",
    task_id: binding?.task_id ?? null,
    branch_id: binding?.branch_id ?? null,
    input_epoch: binding?.input_epoch ?? null,
    goal_version: binding?.goal_version ?? null,
    config_version: binding?.config_version ?? null,
    watermark: binding?.watermark ?? null,
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    row_schema: input.row_schema,
    row_json: input.row_json,
    payload_hash: input.after_hash,
    recorded_at: input.recorded_at
  });
}

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

export function createOutboxWorker(deps: OutboxWorkerDeps): OutboxWorker {
  const { connection } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const workerId = deps.owner ?? `outbox-worker:${randomUUID()}`;
  const leaseMs = deps.lease_ms ?? OUTBOX_LEASE_MS;
  const dispatchDeadlineMs = deps.dispatch_deadline_ms ?? DEFAULT_OUTBOX_DISPATCH_DEADLINE_MS;
  const unavailableRetryMs = deps.unavailable_retry_ms ?? DEFAULT_OUTBOX_UNAVAILABLE_RETRY_MS;
  const sweepEnabled = deps.delivery_expiry_sweep === true;
  const sweepLimit = deps.delivery_expiry_sweep_limit ?? 100;
  const sweepEnqueue = deps.delivery_expiry_sweep_enqueue;
  const runner = createTransactionRunner(connection);
  const journal = deps.journal;
  const transition: DeliveryTransitionWriter = createDeliveryTransitionWriter({
    connection,
    ...(journal === undefined ? {} : { journal }),
    now
  });
  let tail: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  /**
   * One controller per serialized run. `stop` aborts all of them before it
   * awaits the tail so an in-flight HOST delivery can resolve as a cancellation
   * instead of waiting out its full dispatch deadline.
   */
  const runControllers = new Set<AbortController>();

  /* ---------------------------------------------------------------- */
  /* Journal / projection                                              */
  /* ---------------------------------------------------------------- */

  async function commitLedgerEvent(
    input: LedgerEventInput
  ): Promise<Result<Id<"ev">, ErrorEnvelope>> {
    const rowJson = canonicalJsonText(input.row);
    const afterHash = canonicalHash({ row_schema: input.row_schema, row_json: rowJson });
    const beforeHash =
      input.before === null
        ? null
        : canonicalHash({
            row_schema: input.row_schema,
            row_json: canonicalJsonText(input.before)
          });
    const eventId = newId("ev", now());
    const eventKey = canonicalHash({
      event_type: input.event_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      operation: input.operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      binding: input.binding === null ? null : bindingJson(input.binding)
    });
    if (journal === undefined) {
      try {
        runner.withTxSync((tx) => {
          input.project(tx, eventId);
          return null;
        });
        return ok(eventId);
      } catch (error) {
        if (isErrorEnvelope(error)) {
          return fail(error);
        }
        return fail(internalError("kernel.outbox_projection_failed"));
      }
    }
    const event: JsonValue = {
      schema_version: "rsi.ledger_event/1",
      event_id: eventId,
      event_key: eventKey,
      event_type: input.event_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      operation: input.operation,
      binding: input.binding === null ? null : bindingJson(input.binding),
      before_hash: beforeHash,
      after_hash: afterHash,
      row_schema: input.row_schema,
      row_json: rowJson,
      payload_hash: afterHash,
      recorded_at: now()
    };
    const payload: JournalFramePayload = {
      schema_version: "rsi.journal_event/1",
      event,
      event_hash: canonicalHash(event),
      blob_hashes: []
    };
    const outcome = await journal.commit(payload, (tx, receipt) => {
      insertLedgerEventLog(tx, {
        receipt,
        event_id: eventId,
        event_key: eventKey,
        event_type: input.event_type,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        operation: input.operation,
        binding: input.binding,
        before_hash: beforeHash,
        after_hash: afterHash,
        row_schema: input.row_schema,
        row_json: rowJson,
        recorded_at: now()
      });
      input.project(tx, eventId);
      return null;
    }, {
      // The delivery is enqueued by this durable write (DD-FND-103).
      enospc_code: "E_STORAGE_DELIVERY_ENOSPC"
    });
    if (!outcome.ok) {
      return fail(
        outcome.error,
        outcome.commit_state === "unknown_recovery_required" ? "unknown" : "rejected"
      );
    }
    return ok(eventId);
  }

  /* ---------------------------------------------------------------- */
  /* Leases                                                            */
  /* ---------------------------------------------------------------- */

  const CLAIM_SQL = `UPDATE outbox
SET state='leased', lease_owner=:owner, lease_token=:token,
    lease_expires_at=:now+:lease_ms, attempts=attempts+1, updated_at=:now
WHERE outbox_id = (
  SELECT outbox_id FROM outbox
  WHERE state='pending' AND next_attempt_at <= :now
    AND (attempts < max_attempts OR effect_kind = 'delivery.expire')
    AND effect_kind IN ('delivery.dispatch','delivery.expire')
  ORDER BY priority DESC, next_attempt_at ASC, outbox_id ASC LIMIT 1
) AND state='pending'
RETURNING outbox_id`;

  function claimNext(): OutboxRow | null {
    const token = randomUUID();
    const claimed = connection
      .prepare<{ outbox_id: string }>(CLAIM_SQL)
      .get({ owner: workerId, token, now: now(), lease_ms: leaseMs });
    if (claimed === undefined) {
      return null;
    }
    return readOutboxRow(connection, claimed.outbox_id);
  }

  function failExhaustedPending(): void {
    runner.withTxSync((tx) => {
      tx.prepare(
        `UPDATE outbox
            SET state='failed', lease_owner=NULL, lease_token=NULL,
                lease_expires_at=NULL, last_error_code='attempts_exhausted',
                updated_at=:now
          WHERE state='pending' AND attempts >= max_attempts
            AND effect_kind = 'delivery.dispatch'`
      ).run({ now: now() });
      return null;
    });
  }

  function forceLeasedState(
    outboxId: string,
    target: {
      readonly state: "pending" | "done" | "failed" | "uncertain";
      readonly attempts: number;
      readonly next_attempt_at: number;
      readonly reconcile_required: number;
      readonly error_code: string | null;
      readonly result_ref: string | null;
    }
  ): boolean {
    const result = connection
      .prepare(
        `UPDATE outbox
            SET state=:state, attempts=:attempts, next_attempt_at=:next_attempt_at,
                lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
                reconcile_required=:reconcile_required,
                last_error_code=:error_code, result_ref=:result_ref,
                updated_at=:now
          WHERE outbox_id=:outbox_id AND state='leased'
            AND lease_expires_at <= :now`
      )
      .run({
        outbox_id: outboxId,
        state: target.state,
        attempts: target.attempts,
        next_attempt_at: target.next_attempt_at,
        reconcile_required: target.reconcile_required,
        error_code: target.error_code,
        result_ref: target.result_ref,
        now: now()
      });
    return result.changes === 1;
  }

  function finishExpiredAttempt(
    attempt: OutboxAttemptRow,
    state: "succeeded" | "uncertain" | "retryable_failed" | "terminal_failed" | "cancelled",
    errorCode: string
  ): void {
    runner.withTxSync((tx) => {
      tx.prepare(
        `UPDATE outbox_attempt
            SET state=:state, error_code=:error_code, ended_at=:now
          WHERE outbox_attempt_id=:outbox_attempt_id AND state='started'`
      ).run({
        outbox_attempt_id: attempt.outbox_attempt_id,
        state,
        error_code: errorCode,
        now: now()
      });
      return null;
    });
  }

  /**
   * A `delivery.expire` effect is local and idempotent. If the delivery row is
   * already terminal, the effect reached its postcondition even when the
   * attempt/outbox bookkeeping was interrupted by a crash.
   */
  function localExpireApplied(row: OutboxRow): boolean {
    if (row.effect_kind !== "delivery.expire") {
      return false;
    }
    const decoded = decodeEffect(row);
    if (!decoded.ok || decoded.effect.effect_kind !== "delivery.expire") {
      return false;
    }
    const record = readDeliveryRecord(connection, decoded.effect.payload.delivery_id);
    return record !== null && (record.state === "expired" || record.state === "failed");
  }

  function lastAttempt(outboxId: string): OutboxAttemptRow | null {
    const attempts = listOutboxAttempts(connection, outboxId);
    return attempts.length === 0 ? null : attempts[attempts.length - 1] ?? null;
  }

  /**
   * Reconciles `delivery.expire` rows that were already marked uncertain.
   * Journal recovery runs before this worker; once the delivery transition is
   * visible again, the local effect is done rather than waiting for manual
   * reconciliation of an external outcome that never existed.
   */
  function reconcileUncertainLocalExpiry(): void {
    const rows = connection
      .prepare<OutboxRow>(
        `SELECT outbox_id, effect_kind, effect_key, payload_json, state, priority,
                attempts, max_attempts, next_attempt_at, lease_owner, lease_token,
                lease_expires_at, reconcile_required, last_error_code, result_ref,
                created_at, updated_at
           FROM outbox
          WHERE state='uncertain' AND effect_kind='delivery.expire'
          ORDER BY outbox_id ASC`
      )
      .all();
    for (const row of rows) {
      if (localExpireApplied(row)) {
        connection
          .prepare(
            `UPDATE outbox
                SET state='done', reconcile_required=0, last_error_code=NULL,
                    result_ref=:result_ref, updated_at=:updated_at
              WHERE outbox_id=:outbox_id AND state='uncertain'`
          )
          .run({
            outbox_id: row.outbox_id,
            result_ref: lastAttempt(row.outbox_id)?.outbox_attempt_id ?? null,
            updated_at: now()
          });
        continue;
      }
      // A local expiry has no external side effect. An uncertain row whose
      // delivery is still open means the transition did not land: retry it
      // instead of latching a reconciliation that can never complete. The
      // same effect key keeps the sweep from staging a second effect.
      connection
        .prepare(
          `UPDATE outbox
              SET state='pending', reconcile_required=0,
                  next_attempt_at=:next_attempt_at,
                  last_error_code='recovery_local_retry', result_ref=NULL,
                  updated_at=:updated_at
            WHERE outbox_id=:outbox_id AND state='uncertain'`
        )
        .run({
          outbox_id: row.outbox_id,
          next_attempt_at: now() + outboxBackoffMs(Number(row.attempts)),
          updated_at: now()
        });
    }
  }

  /**
   * Reclaims only expired leases. Live leases belong to another run (or a
   * crashed run whose TTL has not elapsed yet) and are never touched.
   */
  function reclaimExpiredLeases(): void {
    const rows = connection
      .prepare<OutboxRow>(
        `SELECT outbox_id, effect_kind, effect_key, payload_json, state, priority,
                attempts, max_attempts, next_attempt_at, lease_owner, lease_token,
                lease_expires_at, reconcile_required, last_error_code, result_ref,
                created_at, updated_at
           FROM outbox
          WHERE state='leased' AND lease_expires_at <= :now
            AND effect_kind IN ('delivery.dispatch','delivery.expire')
          ORDER BY outbox_id ASC`
      )
      .all({ now: now() });
    for (const row of rows) {
      const attempts = Number(row.attempts);
      const maxAttempts = Number(row.max_attempts);
      const attemptRows = listOutboxAttempts(connection, row.outbox_id);
      const last = attemptRows.length === 0 ? null : attemptRows[attemptRows.length - 1] ?? null;
      if (last === null) {
        if (attempts >= maxAttempts) {
          forceLeasedState(row.outbox_id, {
            state: "failed",
            attempts,
            next_attempt_at: row.next_attempt_at,
            reconcile_required: 0,
            error_code: "recovery_attempts_exhausted",
            result_ref: null
          });
        } else {
          forceLeasedState(row.outbox_id, {
            state: "pending",
            attempts,
            next_attempt_at: now() + outboxBackoffMs(attempts),
            reconcile_required: 0,
            error_code: "recovery_released",
            result_ref: null
          });
        }
        continue;
      }
      switch (last.state) {
        case "started": {
          if (localExpireApplied(row)) {
            finishExpiredAttempt(last, "succeeded", "recovery_local_effect_applied");
            forceLeasedState(row.outbox_id, {
              state: "done",
              attempts,
              next_attempt_at: row.next_attempt_at,
              reconcile_required: 0,
              error_code: null,
              result_ref: last.outbox_attempt_id
            });
            break;
          }
          if (row.effect_kind === "delivery.expire") {
            // Crash before the local transition: no external effect happened,
            // so the safe action is a bounded retry, not a reconciliation latch.
            finishExpiredAttempt(last, "retryable_failed", "recovery_local_retry");
            forceLeasedState(row.outbox_id, {
              state: "pending",
              attempts,
              next_attempt_at: now() + outboxBackoffMs(attempts),
              reconcile_required: 0,
              error_code: "recovery_local_retry",
              result_ref: null
            });
            break;
          }
          finishExpiredAttempt(last, "uncertain", "recovery_unknown_fence");
          forceLeasedState(row.outbox_id, {
            state: "uncertain",
            attempts,
            next_attempt_at: row.next_attempt_at,
            reconcile_required: 1,
            error_code: "recovery_unknown_fence",
            result_ref: null
          });
          break;
        }
        case "succeeded": {
          if (row.effect_kind === "delivery.expire") {
            // Local idempotent effect: the projection is safe to consider done.
            forceLeasedState(row.outbox_id, {
              state: "done",
              attempts,
              next_attempt_at: row.next_attempt_at,
              reconcile_required: 0,
              error_code: null,
              result_ref: last.outbox_attempt_id
            });
          } else {
            forceLeasedState(row.outbox_id, {
              state: "uncertain",
              attempts,
              next_attempt_at: row.next_attempt_at,
              reconcile_required: 1,
              error_code: "recovery_external_unverified",
              result_ref: null
            });
          }
          break;
        }
        case "retryable_failed": {
          if (attempts >= maxAttempts) {
            forceLeasedState(row.outbox_id, {
              state: "failed",
              attempts,
              next_attempt_at: row.next_attempt_at,
              reconcile_required: 0,
              error_code: last.error_code ?? "retryable_failed",
              result_ref: null
            });
          } else {
            forceLeasedState(row.outbox_id, {
              state: "pending",
              attempts,
              next_attempt_at: now() + outboxBackoffMs(attempts),
              reconcile_required: 0,
              error_code: last.error_code,
              result_ref: null
            });
          }
          break;
        }
        case "terminal_failed":
        case "cancelled": {
          forceLeasedState(row.outbox_id, {
            state: "failed",
            attempts,
            next_attempt_at: row.next_attempt_at,
            reconcile_required: 0,
            error_code: last.error_code,
            result_ref: null
          });
          break;
        }
        case "uncertain": {
          if (localExpireApplied(row)) {
            forceLeasedState(row.outbox_id, {
              state: "done",
              attempts,
              next_attempt_at: row.next_attempt_at,
              reconcile_required: 0,
              error_code: null,
              result_ref: last.outbox_attempt_id
            });
            break;
          }
          if (row.effect_kind === "delivery.expire") {
            forceLeasedState(row.outbox_id, {
              state: "pending",
              attempts,
              next_attempt_at: now() + outboxBackoffMs(attempts),
              reconcile_required: 0,
              error_code: "recovery_local_retry",
              result_ref: null
            });
            break;
          }
          forceLeasedState(row.outbox_id, {
            state: "uncertain",
            attempts,
            next_attempt_at: row.next_attempt_at,
            reconcile_required: 1,
            error_code: last.error_code ?? "recovery_unknown_fence",
            result_ref: null
          });
          break;
        }
      }
    }
    reconcileUncertainLocalExpiry();
  }

  /* ---------------------------------------------------------------- */
  /* Attempt transitions                                               */
  /* ---------------------------------------------------------------- */

  async function startAttempt(row: OutboxRow): Promise<Result<OutboxAttemptRow, ErrorEnvelope>> {
    const attemptNumber = Number(row.attempts);
    const startedAt = now();
    const attemptRow: OutboxAttemptRow = {
      outbox_attempt_id: randomUUID(),
      outbox_id: row.outbox_id,
      attempt: attemptNumber,
      state: "started",
      error_code: null,
      started_at: startedAt,
      ended_at: null
    };
    const journaled = await commitLedgerEvent({
      event_type: "outbox.attempt_started",
      entity_type: "outbox_attempt",
      entity_id: attemptRow.outbox_attempt_id,
      operation: "insert",
      binding: null,
      row_schema: "rsi.outbox_attempt/1",
      row: attemptRowJson(attemptRow),
      before: null,
      project: (tx) => {
        tx.prepare(
          `INSERT INTO outbox_attempt (
             outbox_attempt_id, outbox_id, attempt, state, error_code, started_at, ended_at
           ) SELECT
             :outbox_attempt_id, :outbox_id, :attempt, 'started', NULL, :started_at, NULL
           WHERE NOT EXISTS (
             SELECT 1 FROM outbox_attempt WHERE outbox_id = :outbox_id AND attempt = :attempt
           )`
        ).run({
          outbox_attempt_id: attemptRow.outbox_attempt_id,
          outbox_id: attemptRow.outbox_id,
          attempt: attemptRow.attempt,
          started_at: attemptRow.started_at
        });
      }
    });
    if (!journaled.ok) {
      return journaled;
    }
    const stored = readOutboxAttempt(connection, row.outbox_id, attemptNumber);
    if (stored === null) {
      return fail(internalError("kernel.outbox_attempt_not_found"));
    }
    if (stored.state !== "started") {
      return fail(internalError("kernel.outbox_attempt_conflict"));
    }
    return ok(stored);
  }

  async function finishAttempt(
    attempt: OutboxAttemptRow,
    state: "succeeded" | "retryable_failed" | "terminal_failed" | "uncertain" | "cancelled",
    errorCode: string | null
  ): Promise<boolean> {
    if (attempt.state !== "started") {
      return true;
    }
    const after: OutboxAttemptRow = {
      ...attempt,
      state,
      error_code: errorCode,
      ended_at: now()
    };
    const committed = await commitLedgerEvent({
      event_type: "outbox.attempt_finished",
      entity_type: "outbox_attempt",
      entity_id: attempt.outbox_attempt_id,
      operation: "update",
      binding: null,
      row_schema: "rsi.outbox_attempt/1",
      row: attemptRowJson(after),
      before: attemptRowJson(attempt),
      project: (tx) => {
        tx.prepare(
          `UPDATE outbox_attempt
              SET state=:state, error_code=:error_code, ended_at=:ended_at
            WHERE outbox_attempt_id=:outbox_attempt_id AND state='started'`
        ).run({
          outbox_attempt_id: after.outbox_attempt_id,
          state: after.state,
          error_code: after.error_code,
          ended_at: after.ended_at
        });
      }
    });
    return committed.ok;
  }

  /* ---------------------------------------------------------------- */
  /* Outbox transitions                                                */
  /* ---------------------------------------------------------------- */

  interface OutboxTarget {
    readonly state: "pending" | "done" | "failed" | "uncertain";
    readonly attempts: number;
    readonly next_attempt_at: number;
    readonly reconcile_required: number;
    readonly error_code: string | null;
    readonly result_ref: string | null;
  }

  function outboxAfter(row: OutboxRow, target: OutboxTarget, at: number): OutboxRow {
    return {
      ...row,
      state: target.state,
      attempts: target.attempts,
      next_attempt_at: target.next_attempt_at,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      reconcile_required: target.reconcile_required,
      last_error_code: target.error_code,
      result_ref: target.result_ref,
      updated_at: at
    };
  }

  async function transitionOutbox(
    row: OutboxRow,
    token: string,
    target: OutboxTarget
  ): Promise<boolean> {
    const at = now();
    const after = outboxAfter(row, target, at);
    const eventType =
      target.state === "done"
        ? "outbox.completed"
        : target.state === "failed"
          ? "outbox.failed"
          : target.state === "uncertain"
            ? "outbox.uncertain"
            : null;
    const project = (tx: Tx): void => {
      const result = tx.prepare(
        `UPDATE outbox
            SET state=:state, attempts=:attempts, next_attempt_at=:next_attempt_at,
                lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
                reconcile_required=:reconcile_required,
                last_error_code=:error_code, result_ref=:result_ref, updated_at=:updated_at
          WHERE outbox_id=:outbox_id AND state='leased' AND lease_token=:token`
      ).run({
        outbox_id: row.outbox_id,
        state: after.state,
        attempts: after.attempts,
        next_attempt_at: after.next_attempt_at,
        reconcile_required: after.reconcile_required,
        error_code: after.last_error_code,
        result_ref: after.result_ref,
        updated_at: after.updated_at,
        token
      });
      if (result.changes !== 1) {
        throw internalError("kernel.outbox_lease_fenced");
      }
    };
    if (eventType === null) {
      try {
        return runner.withTxSync((tx) => {
          project(tx);
          return true;
        });
      } catch {
        return false;
      }
    }
    const journaled = await commitLedgerEvent({
      event_type: eventType,
      entity_type: "outbox",
      entity_id: row.outbox_id,
      operation: "transition",
      binding: null,
      row_schema: "rsi.outbox/1",
      row: outboxRowJson(after),
      before: outboxRowJson(row),
      project
    });
    if (!journaled.ok) {
      // A projection may still have committed; reflect it from the database.
      return readOutboxRow(connection, row.outbox_id)?.state === target.state;
    }
    return true;
  }

  function releaseWithoutAttempt(
    row: OutboxRow,
    token: string,
    errorCode: string,
    retryAfterMs: number
  ): Promise<boolean> {
    return transitionOutbox(row, token, {
      state: "pending",
      attempts: Math.max(0, Number(row.attempts) - 1),
      next_attempt_at: now() + retryAfterMs,
      reconcile_required: 0,
      error_code: errorCode,
      result_ref: null
    });
  }

  /* ---------------------------------------------------------------- */
  /* Delivery projections                                              */
  /* ---------------------------------------------------------------- */

  async function commitDeliveryUpdate(
    before: DeliveryRecord,
    outcome: DeliveryUpdateOutcome
  ): Promise<Result<void, ErrorEnvelope>> {
    return transition.commit(before, outcome);
  }

  async function applyTransportSubmitted(
    record: DeliveryRecord,
    submissionRef: string
  ): Promise<Result<DeliveryRecord, ErrorEnvelope>> {
    if (record.state === "submitted" || record.submission_ref !== null) {
      return ok(record);
    }
    const request: DeliveryUpdateRequest = {
      schema_version: "rsi.delivery_update/1",
      delivery_id: record.delivery_id,
      expected_row_version: record.row_version,
      update: { axis: "transport", state: "submitted", submission_ref: submissionRef }
    };
    const applied = applyDeliveryUpdate(record, request, {
      now_ms: now(),
      evidence_retrievable: true,
      human_attestation_verified: false
    });
    if (!applied.ok) {
      return applied;
    }
    const committed = await commitDeliveryUpdate(record, applied.value);
    if (!committed.ok) {
      return committed;
    }
    return ok(applied.value.record);
  }

  async function applyTransportTerminal(
    record: DeliveryRecord,
    reason: DeliveryTerminalReason
  ): Promise<Result<DeliveryRecord, ErrorEnvelope>> {
    if (record.state === "expired" || record.state === "failed") {
      return ok(record);
    }
    // `expired_by_time` is reserved for the outbox expiry path.
    if (reason === "expired_by_time") {
      return applyExpiry(record);
    }
    const request: DeliveryUpdateRequest = {
      schema_version: "rsi.delivery_update/1",
      delivery_id: record.delivery_id,
      expected_row_version: record.row_version,
      update: { axis: "transport", state: "failed", reason_code: reason }
    };
    const applied = applyDeliveryUpdate(record, request, {
      now_ms: now(),
      evidence_retrievable: true,
      human_attestation_verified: false
    });
    if (!applied.ok) {
      return applied;
    }
    const committed = await commitDeliveryUpdate(record, applied.value);
    if (!committed.ok) {
      return committed;
    }
    return ok(applied.value.record);
  }

  async function applyExpiry(record: DeliveryRecord): Promise<Result<DeliveryRecord, ErrorEnvelope>> {
    const expired = expireDelivery(record, now());
    if (!expired.changed) {
      return ok(expired.record);
    }
    const committed = await commitDeliveryUpdate(record, expired);
    if (!committed.ok) {
      return committed;
    }
    return ok(expired.record);
  }

  function inclusionFromHostLevel(level: InclusionLevel): InclusionEvidence | null {
    switch (level) {
      case "context_projection":
        return "context_projection";
      case "provider_payload":
        return "provider_payload";
      case "transport_body":
        return "transport_body";
      // HOST's `constructive` level is weaker than a captured projection but
      // stronger than `unknown`; the delivery axis has no constructive member.
      case "constructive":
        return "context_projection";
      case "none":
      case "unknown":
        return null;
    }
  }

  async function applyInclusion(
    record: DeliveryRecord,
    result: HostDeliveryResult
  ): Promise<Result<DeliveryRecord, ErrorEnvelope>> {
    const evidence = inclusionFromHostLevel(result.inclusion.level);
    if (evidence === null) {
      return ok(record);
    }
    const evidenceRef = result.inclusion.evidence_ref ?? record.content_ref;
    const retrievable = deps.isEvidenceRetrievable?.(evidenceRef) ?? true;
    const request: DeliveryUpdateRequest = {
      schema_version: "rsi.delivery_update/1",
      delivery_id: record.delivery_id,
      expected_row_version: record.row_version,
      update: {
        axis: "inclusion",
        evidence,
        evidence_ref: evidenceRef,
        transport_body_verified: result.inclusion.level === "transport_body"
      }
    };
    const applied = applyDeliveryUpdate(record, request, {
      now_ms: now(),
      evidence_retrievable: retrievable,
      human_attestation_verified: false
    });
    if (!applied.ok) {
      return applied;
    }
    const committed = await commitDeliveryUpdate(record, applied.value);
    if (!committed.ok) {
      return committed;
    }
    return ok(applied.value.record);
  }

  function terminalReasonForHostError(error: HostAdapterError): DeliveryTerminalReason {
    switch (error.code) {
      case "E_CANCELLED":
        return "cancelled";
      case "E_DEADLINE_EXCEEDED":
        return "timeout";
      case "E_HOST_REJECTED":
      case "E_UNSUPPORTED":
      case "E_CAPABILITY":
      case "E_SCHEMA":
      case "E_CONFLICT":
      case "E_AUTH_UNAVAILABLE":
        return "host_rejected";
      case "E_IO":
      case "E_EVIDENCE_UNKNOWN":
      case "E_INTERNAL":
        // A transport failure after the request left the process is unknown.
        return "timeout";
    }
  }

  /* ---------------------------------------------------------------- */
  /* Processing                                                        */
  /* ---------------------------------------------------------------- */

  function finishResult(
    row: OutboxRow,
    disposition: OutboxDisposition,
    error?: ErrorEnvelope
  ): OutboxRunResult {
    return {
      status: "processed",
      outbox_id: row.outbox_id,
      effect_kind: row.effect_kind,
      disposition,
      ...(error === undefined ? {} : { error })
    };
  }

  async function markFailed(
    row: OutboxRow,
    token: string,
    attempt: OutboxAttemptRow | null,
    errorCode: string
  ): Promise<OutboxRunResult> {
    if (attempt !== null && !(await finishAttempt(attempt, "terminal_failed", errorCode))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
    }
    if (!(await transitionOutbox(row, token, {
      state: "failed",
      attempts: Number(row.attempts),
      next_attempt_at: row.next_attempt_at,
      reconcile_required: 0,
      error_code: errorCode,
      result_ref: null
    }))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
    }
    return finishResult(row, "failed");
  }

  async function markUncertain(
    row: OutboxRow,
    token: string,
    attempt: OutboxAttemptRow | null,
    errorCode: string
  ): Promise<OutboxRunResult> {
    if (attempt !== null && !(await finishAttempt(attempt, "uncertain", errorCode))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
    }
    if (!(await transitionOutbox(row, token, {
      state: "uncertain",
      attempts: Number(row.attempts),
      next_attempt_at: row.next_attempt_at,
      reconcile_required: 1,
      error_code: errorCode,
      result_ref: null
    }))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
    }
    return finishResult(row, "uncertain");
  }

  /**
   * A refused local expiry is safe to retry: the delivery transition did not
   * commit a journal frame (the writer rechecks its CAS before appending), and
   * the effect has no external side effect.
   */
  async function retryLocalExpire(
    row: OutboxRow,
    token: string,
    attempt: OutboxAttemptRow,
    errorCode: string,
    error: ErrorEnvelope
  ): Promise<OutboxRunResult> {
    if (!(await finishAttempt(attempt, "retryable_failed", errorCode))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
    }
    if (!(await transitionOutbox(row, token, {
      state: "pending",
      attempts: Number(row.attempts),
      next_attempt_at: now() + outboxBackoffMs(Number(row.attempts)),
      reconcile_required: 0,
      error_code: errorCode,
      result_ref: null
    }))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
    }
    return finishResult(row, "retry", error);
  }

  async function processDispatch(
    row: OutboxRow,
    token: string,
    attempt: OutboxAttemptRow,
    deliveryId: Id<"del">,
    submissionAttempt: number,
    signal: AbortSignal
  ): Promise<OutboxRunResult> {
    const record = readDeliveryRecord(connection, deliveryId);
    if (record === null) {
      return markFailed(row, token, attempt, "delivery_not_found");
    }
    if (record.state === "expired" || record.state === "failed") {
      if (!(await finishAttempt(attempt, "succeeded", "delivery_terminal"))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
      }
      if (!(await transitionOutbox(row, token, {
        state: "done",
        attempts: Number(row.attempts),
        next_attempt_at: row.next_attempt_at,
        reconcile_required: 0,
        error_code: null,
        result_ref: attempt.outbox_attempt_id
      }))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
      }
      return finishResult(row, "done");
    }
    if (record.expires_at <= now()) {
      const expired = await applyExpiry(record);
      if (!expired.ok) {
        return markUncertain(row, token, attempt, "delivery_expiry_projection_failed");
      }
      if (!(await finishAttempt(attempt, "succeeded", "expired_by_time"))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
      }
      if (!(await transitionOutbox(row, token, {
        state: "done",
        attempts: Number(row.attempts),
        next_attempt_at: row.next_attempt_at,
        reconcile_required: 0,
        error_code: null,
        result_ref: attempt.outbox_attempt_id
      }))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
      }
      return finishResult(row, "done");
    }
    // A previously submitted delivery is never submitted twice. This covers a
    // crash where the external call succeeded but the outbox row was not
    // marked done.
    if (record.state === "submitted" || record.submission_ref !== null) {
      if (!(await finishAttempt(attempt, "succeeded", "already_submitted"))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
      }
      if (!(await transitionOutbox(row, token, {
        state: "done",
        attempts: Number(row.attempts),
        next_attempt_at: row.next_attempt_at,
        reconcile_required: 0,
        error_code: null,
        result_ref: attempt.outbox_attempt_id
      }))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
      }
      return finishResult(row, "done");
    }
    const port = deps.delivery;
    if (port === undefined) {
      if (!(await finishAttempt(attempt, "retryable_failed", "host_delivery_port_unavailable"))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
      }
      if (!(await transitionOutbox(row, token, {
        state: "pending",
        attempts: Math.max(0, Number(row.attempts) - 1),
        next_attempt_at: now() + unavailableRetryMs,
        reconcile_required: 0,
        error_code: "host_delivery_port_unavailable",
        result_ref: null
      }))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
      }
      return finishResult(row, "retry");
    }

    const remaining = record.expires_at - now();
    const deadline = Math.max(1, Math.min(dispatchDeadlineMs, leaseMs - 1000, remaining));
    const request: OutboxDeliveryDispatchRequest = {
      delivery_id: record.delivery_id,
      submission_attempt: submissionAttempt,
      attempt: attempt.attempt,
      lease_token: token,
      task_id: record.task_id,
      branch_id: record.branch_id,
      input_epoch: record.input_epoch,
      goal_version: record.goal_version,
      config_version: record.config_version,
      content_ref: record.content_ref,
      content_hash: record.content_hash,
      expires_at: record.expires_at,
      idempotency_key: row.effect_key,
      deadline_ms: deadline
    };

    // Renew immediately before the external call and keep the lease alive while
    // it runs. If renewal ever fails, the lease is fenced: the result must not
    // be projected as done.
    let leaseLost = !renewOutboxLease(connection, {
      outbox_id: row.outbox_id,
      token,
      now: now()
    });
    const heartbeat = setInterval(() => {
      if (
        !renewOutboxLease(connection, {
          outbox_id: row.outbox_id,
          token,
          now: now()
        })
      ) {
        leaseLost = true;
      }
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    heartbeat.unref();

    let result: HostAdapterResult<HostDeliveryResult>;
    try {
      result = await port.deliver(request, signal);
    } catch {
      clearInterval(heartbeat);
      return markUncertain(row, token, attempt, "host_delivery_threw");
    } finally {
      clearInterval(heartbeat);
    }
    if (leaseLost) {
      return finishResult(row, "fenced");
    }

    if (!result.ok) {
      const errorCode = result.error.code;
      if (errorCode === "E_CAPABILITY" && result.error.retryable) {
        if (Number(row.attempts) >= Number(row.max_attempts)) {
          return markFailed(row, token, attempt, errorCode);
        }
        if (!(await finishAttempt(attempt, "retryable_failed", errorCode))) {
          return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
        }
        const retried = await transitionOutbox(row, token, {
          state: "pending",
          attempts: Number(row.attempts),
          next_attempt_at: now() + outboxBackoffMs(Number(row.attempts)),
          reconcile_required: 0,
          error_code: errorCode,
          result_ref: null
        });
        return finishResult(row, retried ? "retry" : "fenced");
      }
      if (
        errorCode === "E_DEADLINE_EXCEEDED" ||
        errorCode === "E_IO" ||
        errorCode === "E_EVIDENCE_UNKNOWN" ||
        errorCode === "E_INTERNAL"
      ) {
        return markUncertain(row, token, attempt, errorCode);
      }
      const reason = terminalReasonForHostError(result.error);
      const failed = await applyTransportTerminal(record, reason);
      if (!failed.ok) {
        return markUncertain(row, token, attempt, "delivery_terminal_projection_failed");
      }
      return markFailed(row, token, attempt, errorCode);
    }

    const value = result.value;
    if (value.submitted === "false") {
      const code = value.error?.code;
      if (
        code === "E_DEADLINE_EXCEEDED" ||
        code === "E_IO" ||
        code === "E_EVIDENCE_UNKNOWN" ||
        code === "E_INTERNAL"
      ) {
        return markUncertain(row, token, attempt, code);
      }
      const reason = value.error === undefined ? "host_rejected" : terminalReasonForHostError(value.error);
      const failed = await applyTransportTerminal(record, reason);
      if (!failed.ok) {
        return markUncertain(row, token, attempt, "delivery_terminal_projection_failed");
      }
      return markFailed(row, token, attempt, value.error?.code ?? "host_rejected");
    }

    // Inclusion evidence is independent of the transport axis. For an unknown
    // submission it can still be recorded, but a known submission is projected
    // transport-first so the history frames follow transport→inclusion.
    if (value.submitted === "unknown") {
      const included = await applyInclusion(record, value);
      if (!included.ok) {
        return markUncertain(row, token, attempt, "delivery_inclusion_projection_failed");
      }
      return markUncertain(row, token, attempt, "host_submission_unknown");
    }

    const submissionRef =
      value.host_ack_ref ?? `submission:${record.delivery_id}:${String(attempt.attempt)}`;
    const submitted = await applyTransportSubmitted(record, submissionRef);
    if (!submitted.ok) {
      return markUncertain(row, token, attempt, "delivery_submission_projection_failed");
    }
    const included = await applyInclusion(submitted.value, value);
    if (!included.ok) {
      return markUncertain(row, token, attempt, "delivery_inclusion_projection_failed");
    }
    if (!(await finishAttempt(attempt, "succeeded", null))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
    }
    if (!(await transitionOutbox(row, token, {
      state: "done",
      attempts: Number(row.attempts),
      next_attempt_at: row.next_attempt_at,
      reconcile_required: 0,
      error_code: null,
      result_ref: attempt.outbox_attempt_id
    }))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
    }
    return finishResult(row, "done");
  }

  async function processExpire(
    row: OutboxRow,
    token: string,
    attempt: OutboxAttemptRow,
    deliveryId: Id<"del">,
    effectExpiresAt: number
  ): Promise<OutboxRunResult> {
    const record = readDeliveryRecord(connection, deliveryId);
    if (record === null) {
      return markFailed(row, token, attempt, "delivery_not_found");
    }
    if (record.state === "expired" || record.state === "failed") {
      if (!(await finishAttempt(attempt, "succeeded", "delivery_terminal"))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
      }
      if (!(await transitionOutbox(row, token, {
        state: "done",
        attempts: Number(row.attempts),
        next_attempt_at: row.next_attempt_at,
        reconcile_required: 0,
        error_code: null,
        result_ref: attempt.outbox_attempt_id
      }))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
      }
      return finishResult(row, "done");
    }
    const dueAt = record.expires_at;
    if (dueAt !== effectExpiresAt) {
      // `expires_at` is immutable on the delivery row; a mismatch means the
      // effect payload is corrupt and the row cannot be applied safely.
      return markFailed(row, token, attempt, "delivery_expires_at_mismatch");
    }
    if (dueAt > now()) {
      if (!(await finishAttempt(attempt, "cancelled", "not_due"))) {
        return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
      }
      const rescheduled = await transitionOutbox(row, token, {
        state: "pending",
        // The row did not execute an effect; refund the lease attempt.
        attempts: Math.max(0, Number(row.attempts) - 1),
        next_attempt_at: dueAt,
        reconcile_required: 0,
        error_code: null,
        result_ref: null
      });
      return finishResult(row, rescheduled ? "retry" : "fenced");
    }
    const expired = await applyExpiry(record);
    if (!expired.ok) {
      if (expired.status === "unknown") {
        return markUncertain(row, token, attempt, "delivery_expiry_projection_failed");
      }
      return retryLocalExpire(
        row,
        token,
        attempt,
        expired.error.code === "E_INTERNAL"
          ? "delivery_expiry_projection_retry"
          : expired.error.code,
        expired.error
      );
    }
    if (!(await finishAttempt(attempt, "succeeded", null))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
    }
    if (!(await transitionOutbox(row, token, {
      state: "done",
      attempts: Number(row.attempts),
      next_attempt_at: row.next_attempt_at,
      reconcile_required: 0,
      error_code: null,
      result_ref: attempt.outbox_attempt_id
    }))) {
      return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
    }
    return finishResult(row, "done");
  }

  function decodeEffect(row: OutboxRow):
    | { readonly ok: true; readonly effect: ReturnType<typeof validateOutboxEffect> extends Result<infer T, ErrorEnvelope> ? T : never }
    | { readonly ok: false } {
    const payload = parseJsonObject(row.payload_json);
    if (payload === null) {
      return { ok: false };
    }
    const validated = validateOutboxEffect({
      effect_kind: row.effect_kind,
      payload
    });
    if (!validated.ok || validated.value.effect_key !== row.effect_key) {
      return { ok: false };
    }
    const effect = validated.value;
    if (effect.effect_kind === "delivery.dispatch") {
      if (!validateDeliveryEffectKey("delivery.dispatch", row.effect_key, effect.payload)) {
        return { ok: false };
      }
    }
    if (effect.effect_kind === "delivery.expire") {
      if (!validateDeliveryEffectKey("delivery.expire", row.effect_key, effect.payload)) {
        return { ok: false };
      }
    }
    return { ok: true, effect };
  }

  async function executeOnce(signal: AbortSignal): Promise<OutboxRunResult> {
    if (signal.aborted) {
      // A run queued before `stop` must not claim new work after the abort.
      return {
        status: "idle",
        outbox_id: null,
        effect_kind: null,
        disposition: null
      };
    }
    reclaimExpiredLeases();
    failExhaustedPending();
    if (sweepEnabled) {
      // Stage due `delivery.expire` rows before claiming, so a submitted
      // delivery with no pending dispatch still reaches its terminal history.
      // The enqueue is journal-first: the outbox row and its
      // `outbox.enqueued` member commit in one frame, and the unique effect
      // key keeps a repeat sweep idempotent.
      if (sweepEnqueue === undefined) {
        return {
          status: "error",
          outbox_id: null,
          effect_kind: null,
          disposition: null,
          error: internalError("kernel.delivery_expiry_sweep_enqueue_unavailable")
        };
      }
      const staged = await stageDueDeliveryExpiry(sweepEnqueue, now(), sweepLimit);
      if (!staged.ok) {
        return {
          status: "error",
          outbox_id: null,
          effect_kind: null,
          disposition: null,
          error: staged.error
        };
      }
    }
    const row = claimNext();
    if (row === null) {
      return {
        status: "idle",
        outbox_id: null,
        effect_kind: null,
        disposition: null
      };
    }
    const token = row.lease_token;
    if (row.state !== "leased" || token === null) {
      return finishResult(row, "fenced");
    }
    const decoded = decodeEffect(row);
    if (!decoded.ok) {
      return markFailed(row, token, null, "invalid_effect_payload");
    }
    const effect = decoded.effect;

    if (effect.effect_kind === "delivery.dispatch" && deps.delivery === undefined) {
      // Fail closed before recording an attempt: no external call happened.
      await releaseWithoutAttempt(row, token, "host_delivery_port_unavailable", unavailableRetryMs);
      return finishResult(row, "retry");
    }

    const attempt = await startAttempt(row);
    if (!attempt.ok) {
      const details = attempt.error.details;
      if (
        attempt.status === "unknown" ||
        (details.kind === "internal" && details.incident_id === "kernel.outbox_attempt_conflict")
      ) {
        return markUncertain(row, token, null, "attempt_start_uncertain");
      }
      // A journal failure before the external call is safe to retry.
      await releaseWithoutAttempt(row, token, "attempt_start_failed", outboxBackoffMs(Number(row.attempts)));
      return finishResult(row, "retry", attempt.error);
    }

    switch (effect.effect_kind) {
      case "delivery.dispatch":
        return processDispatch(
          row,
          token,
          attempt.value,
          effect.payload.delivery_id,
          effect.payload.submission_attempt,
          signal
        );
      case "delivery.expire":
        return processExpire(
          row,
          token,
          attempt.value,
          effect.payload.delivery_id,
          effect.payload.expires_at
        );
      default:
        if (!(await finishAttempt(attempt.value, "cancelled", "unsupported_effect"))) {
          return finishResult(row, "fenced", internalError("kernel.outbox_attempt_finish_failed"));
        }
        if (!(await transitionOutbox(row, token, {
          state: "done",
          attempts: Number(row.attempts),
          next_attempt_at: row.next_attempt_at,
          reconcile_required: 0,
          error_code: null,
          result_ref: attempt.value.outbox_attempt_id
        }))) {
          return finishResult(row, "fenced", internalError("kernel.outbox_transition_failed"));
        }
        return finishResult(row, "skipped");
    }
  }

  function runOnceSerial(): Promise<OutboxRunResult> {
    const controller = new AbortController();
    runControllers.add(controller);
    const run = tail.then(
      () => executeOnce(controller.signal),
      () => executeOnce(controller.signal)
    );
    tail = run.then(
      () => {
        runControllers.delete(controller);
      },
      () => {
        runControllers.delete(controller);
      }
    );
    return run;
  }

  function recoverSerial(): Promise<OutboxRunResult> {
    const run = tail.then(
      () => {
        reclaimExpiredLeases();
        failExhaustedPending();
        return {
          status: "idle" as const,
          outbox_id: null,
          effect_kind: null,
          disposition: null
        };
      },
      () => {
        reclaimExpiredLeases();
        failExhaustedPending();
        return {
          status: "idle" as const,
          outbox_id: null,
          effect_kind: null,
          disposition: null
        };
      }
    );
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    worker_id: workerId,
    runOnce(): Promise<OutboxRunResult> {
      return runOnceSerial();
    },
    recover(): Promise<OutboxRunResult> {
      return recoverSerial();
    },
    start(options?: OutboxWorkerStartOptions): void {
      if (timer !== null) {
        return;
      }
      const interval = options?.interval_ms ?? deps.interval_ms ?? DEFAULT_OUTBOX_WORKER_INTERVAL_MS;
      stopped = false;
      const tick = (): void => {
        if (stopped) {
          return;
        }
        void runOnceSerial().finally(() => {
          if (!stopped) {
            timer = setTimeout(tick, interval);
            timer.unref();
          }
        });
      };
      timer = setTimeout(tick, 0);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Abort before awaiting: the bridge is allowed to wait for a real claim
      // check, but it must not wait for the full dispatch deadline.
      for (const controller of runControllers) {
        controller.abort();
      }
      await tail;
    }
  };
}
