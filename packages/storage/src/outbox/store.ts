import { randomUUID } from "node:crypto";
import type { StatementSource } from "../types.js";
import { fieldDetails, storageError } from "../errors.js";
import {
  OUTBOX_LEASE_MS,
  outboxBackoffMs
} from "./model.js";
import type { OutboxAttemptRow, OutboxRow } from "./model.js";

/**
 * Single-statement lease claim (DD-FND-061). At most one worker wins because
 * the outer `state='pending'` predicate is rechecked after the subquery.
 */
export const OUTBOX_CLAIM_SQL = `UPDATE outbox
SET state='leased', lease_owner=:owner, lease_token=:token,
    lease_expires_at=:now+30000, attempts=attempts+1, updated_at=:now
WHERE outbox_id = (
  SELECT outbox_id FROM outbox
  WHERE state='pending' AND next_attempt_at <= :now AND attempts < max_attempts
  ORDER BY priority DESC, next_attempt_at ASC, outbox_id ASC LIMIT 1
) AND state='pending'
RETURNING outbox_id`;

export interface OutboxLeaseClaim {
  readonly owner: string;
  readonly token: string;
  readonly now: number;
}

const OUTBOX_COLUMNS = `outbox_id, effect_kind, effect_key, payload_json, state, priority,
  attempts, max_attempts, next_attempt_at, lease_owner, lease_token, lease_expires_at,
  reconcile_required, last_error_code, result_ref, created_at, updated_at`;

/** Claims the next due outbox row or returns null when none is due. */
export function claimNextOutbox(
  source: StatementSource,
  claim: OutboxLeaseClaim,
): OutboxRow | null {
  const claimed = source
    .prepare<{ outbox_id: string }>(OUTBOX_CLAIM_SQL)
    .get({ owner: claim.owner, token: claim.token, now: claim.now });
  if (claimed === undefined) {
    return null;
  }
  return readOutboxRow(source, claimed.outbox_id);
}

/** Reads one outbox row. */
export function readOutboxRow(source: StatementSource, outboxId: string): OutboxRow | null {
  const row = source
    .prepare<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE outbox_id = :outbox_id`,
    )
    .get({ outbox_id: outboxId });
  return row ?? null;
}

/** Extends a live lease to `now + 30 s`. Expired leases are never revived. */
export function renewOutboxLease(
  source: StatementSource,
  input: { readonly outbox_id: string; readonly token: string; readonly now: number },
): boolean {
  const result = source
    .prepare(
      `UPDATE outbox
          SET lease_expires_at = :now + ${OUTBOX_LEASE_MS},
              updated_at = :now
        WHERE outbox_id = :outbox_id
          AND state = 'leased'
          AND lease_token = :token
          AND lease_expires_at > :now`,
    )
    .run({ outbox_id: input.outbox_id, token: input.token, now: input.now });
  return result.changes === 1;
}

/** Inserts the `started` attempt row before any external call. */
export function startOutboxAttempt(
  source: StatementSource,
  input: { readonly outbox_id: string; readonly now: number },
): OutboxAttemptRow | null {
  const row = readOutboxRow(source, input.outbox_id);
  if (row === null || row.state !== "leased") {
    return null;
  }
  const attemptId = randomUUID();
  source
    .prepare(
      `INSERT INTO outbox_attempt (
         outbox_attempt_id, outbox_id, attempt, state, error_code, started_at, ended_at
       ) VALUES (
         :outbox_attempt_id, :outbox_id, :attempt, 'started', NULL, :started_at, NULL
       )`,
    )
    .run({
      outbox_attempt_id: attemptId,
      outbox_id: input.outbox_id,
      attempt: row.attempts,
      started_at: input.now
    });
  return readOutboxAttempt(source, input.outbox_id, Number(row.attempts));
}

/** Reads one attempt row. */
export function readOutboxAttempt(
  source: StatementSource,
  outboxId: string,
  attempt: number,
): OutboxAttemptRow | null {
  const row = source
    .prepare<OutboxAttemptRow>(
      `SELECT outbox_attempt_id, outbox_id, attempt, state, error_code, started_at, ended_at
         FROM outbox_attempt
        WHERE outbox_id = :outbox_id AND attempt = :attempt`,
    )
    .get({ outbox_id: outboxId, attempt });
  return row ?? null;
}

/** Lists attempts of one outbox row in ascending attempt order. */
export function listOutboxAttempts(
  source: StatementSource,
  outboxId: string,
): readonly OutboxAttemptRow[] {
  return source
    .prepare<OutboxAttemptRow>(
      `SELECT outbox_attempt_id, outbox_id, attempt, state, error_code, started_at, ended_at
         FROM outbox_attempt
        WHERE outbox_id = :outbox_id
        ORDER BY attempt ASC`,
    )
    .all({ outbox_id: outboxId });
}

/** Finishes an attempt row. Returns false when it was already terminal. */
export function finishOutboxAttempt(
  source: StatementSource,
  input: {
    readonly outbox_id: string;
    readonly attempt: number;
    readonly state: Exclude<OutboxAttemptRow["state"], "started">;
    readonly now: number;
    readonly error_code?: string;
  },
): boolean {
  const result = source
    .prepare(
      `UPDATE outbox_attempt
          SET state = :state, error_code = :error_code, ended_at = :ended_at
        WHERE outbox_id = :outbox_id AND attempt = :attempt AND state = 'started'`,
    )
    .run({
      outbox_id: input.outbox_id,
      attempt: input.attempt,
      state: input.state,
      error_code: input.error_code ?? null,
      ended_at: input.now
    });
  return result.changes === 1;
}

/** Marks a leased row done. */
export function markOutboxDone(
  source: StatementSource,
  input: {
    readonly outbox_id: string;
    readonly now: number;
    readonly result_ref?: string;
    readonly token?: string;
  },
): boolean {
  const result = source
    .prepare(
      `UPDATE outbox
          SET state = 'done',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              result_ref = :result_ref,
              updated_at = :now
        WHERE outbox_id = :outbox_id
          AND state = 'leased'
          ${input.token === undefined ? "" : "AND lease_token = :token"}`,
    )
    .run({
      outbox_id: input.outbox_id,
      result_ref: input.result_ref ?? null,
      now: input.now,
      ...(input.token === undefined ? {} : { token: input.token })
    });
  return result.changes === 1;
}

/** Returns a lease to `pending` after a retryable failure, with exponential backoff. */
export function returnOutboxToPending(
  source: StatementSource,
  input: {
    readonly outbox_id: string;
    readonly now: number;
    readonly error_code?: string;
  },
): boolean {
  const row = readOutboxRow(source, input.outbox_id);
  if (row === null) {
    return false;
  }
  const attempts = Number(row.attempts);
  if (attempts >= Number(row.max_attempts)) {
    return failOutbox(source, {
      outbox_id: input.outbox_id,
      now: input.now,
      ...(input.error_code === undefined ? {} : { error_code: input.error_code })
    });
  }
  const result = source
    .prepare(
      `UPDATE outbox
          SET state = 'pending',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              next_attempt_at = :next_attempt_at,
              last_error_code = :error_code,
              updated_at = :now
        WHERE outbox_id = :outbox_id AND state = 'leased'`,
    )
    .run({
      outbox_id: input.outbox_id,
      next_attempt_at: input.now + outboxBackoffMs(attempts),
      error_code: input.error_code ?? null,
      now: input.now
    });
  return result.changes === 1;
}

/** Marks a row terminally failed. */
export function failOutbox(
  source: StatementSource,
  input: {
    readonly outbox_id: string;
    readonly now: number;
    readonly error_code?: string;
  },
): boolean {
  const result = source
    .prepare(
      `UPDATE outbox
          SET state = 'failed',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = :error_code,
              updated_at = :now
        WHERE outbox_id = :outbox_id AND state IN ('pending','leased')`,
    )
    .run({
      outbox_id: input.outbox_id,
      error_code: input.error_code ?? null,
      now: input.now
    });
  return result.changes === 1;
}

/**
 * Marks a row `uncertain` with `reconcile_required=1`. Only an explicit
 * reconcile may return it to `pending`; it is never retried automatically.
 */
export function markOutboxUncertain(
  source: StatementSource,
  input: {
    readonly outbox_id: string;
    readonly now: number;
    readonly error_code?: string;
  },
): boolean {
  const result = source
    .prepare(
      `UPDATE outbox
          SET state = 'uncertain',
              reconcile_required = 1,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = :error_code,
              updated_at = :now
        WHERE outbox_id = :outbox_id`,
    )
    .run({
      outbox_id: input.outbox_id,
      error_code: input.error_code ?? null,
      now: input.now
    });
  return result.changes === 1;
}

export interface PendingOutboxInsert {
  readonly outbox_id: string;
  readonly effect_kind: string;
  readonly effect_key: string;
  readonly payload_json: string;
  readonly created_at: number;
  readonly priority?: number;
  readonly max_attempts?: number;
}

/** Inserts a fully frozen pending row (journal projection path). */
export function insertPendingOutbox(
  source: StatementSource,
  input: PendingOutboxInsert,
): boolean {
  if (Buffer.byteLength(input.payload_json, "utf8") > 65536) {
    throw storageError({
      code: "E_STATE_ROW_SCHEMA",
      stage: "storage.outbox",
      details: fieldDetails("payload_json", "exceeds_64_kib"),
      message_key: "error.storage.outbox_payload_too_large"
    });
  }
  const result = source
    .prepare(
      `INSERT INTO outbox (
         outbox_id, effect_kind, effect_key, payload_json, state, priority,
         attempts, max_attempts, next_attempt_at, lease_owner, lease_token,
         lease_expires_at, reconcile_required, last_error_code, result_ref,
         created_at, updated_at
       ) VALUES (
         :outbox_id, :effect_kind, :effect_key, :payload_json, 'pending', :priority,
         0, :max_attempts, :created_at, NULL, NULL, NULL, 0, NULL, NULL,
         :created_at, :created_at
       )
       ON CONFLICT(effect_key) DO NOTHING`,
    )
    .run({
      outbox_id: input.outbox_id,
      effect_kind: input.effect_kind,
      effect_key: input.effect_key,
      payload_json: input.payload_json,
      priority: input.priority ?? 0,
      max_attempts: input.max_attempts ?? 1,
      created_at: input.created_at
    });
  return result.changes === 1;
}
