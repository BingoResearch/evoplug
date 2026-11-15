/**
 * Provider rate-limit state (DD-FND-081, DD-FND-097.8).
 *
 * Two independent mechanisms:
 * - an in-process token bucket per provider scope (`rpm` / `burst`), which
 *   starts empty after a restart;
 * - a persisted `rate_limit_state` cooldown, which is recovered from the
 *   journal and only ever extended or explicitly cleared.
 *
 * A provider 429 must be journalled and fsynced as `rate_limit.updated`, then
 * upserted, before any reservation is released or the next call is admitted.
 */

import type { ErrorEnvelope, Result, Tx } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { ledgerAsofUnavailable, schemaError } from "./errors.js";

export const RATE_LIMIT_STATE_ROW_SCHEMA: "rsi.rate_limit_state_row/1" =
  "rsi.rate_limit_state_row/1";

export type RateLimitReasonCode =
  | "provider_429"
  | "provider_error"
  | "manual"
  | "recovery_unknown_fence"
  | "cleared";

export interface RateLimitState {
  scope_key: string;
  cooldown_until: number | null;
  last_error_code: string | null;
  reason_code: RateLimitReasonCode;
  row_version: number;
  updated_at: number;
}

/** Recovery fence length, 60 s (DD-FND-097.8). */
export const RECOVERY_FENCE_MS = 60_000;

/** Local guard used when the provider limit is unknown. */
export const UNKNOWN_LIMIT_INFLIGHT = 1;

/** Local guard used when the provider limit is unknown. */
export const UNKNOWN_LIMIT_RPM = 6;

export interface TokenBucketConfig {
  rpm: number;
  burst: number;
}

export interface TokenBucketState {
  tokens: number;
  last_refill_ms: number;
}

export interface TokenBucketDecision {
  allowed: boolean;
  state: TokenBucketState;
  retry_after_ms: number | null;
}

/** Starts an empty bucket; this is the post-restart behavior. */
export function createTokenBucket(now: number): TokenBucketState {
  return { tokens: 0, last_refill_ms: now };
}

/** Adds tokens for elapsed time, capped at `burst`. */
export function refillTokenBucket(
  state: TokenBucketState,
  config: TokenBucketConfig,
  now: number
): TokenBucketState {
  const elapsed = Math.max(0, now - state.last_refill_ms);
  const refill = (elapsed * config.rpm) / 60_000;
  const tokens = Math.min(config.burst, state.tokens + refill);
  return { tokens, last_refill_ms: Math.max(state.last_refill_ms, now) };
}

/** Consumes one token if available; returns the wait until the next token. */
export function consumeToken(
  state: TokenBucketState,
  config: TokenBucketConfig,
  now: number
): TokenBucketDecision {
  const refilled = refillTokenBucket(state, config, now);
  if (refilled.tokens >= 1) {
    return {
      allowed: true,
      state: { tokens: refilled.tokens - 1, last_refill_ms: refilled.last_refill_ms },
      retry_after_ms: null
    };
  }
  const missing = 1 - refilled.tokens;
  const retryAfter = config.rpm > 0 ? Math.ceil((missing * 60_000) / config.rpm) : null;
  return { allowed: false, state: refilled, retry_after_ms: retryAfter };
}

/** True when the scope is currently cooling down. */
export function isCoolingDown(state: RateLimitState | null, now: number): boolean {
  return state !== null && state.cooldown_until !== null && state.cooldown_until > now;
}

export interface CooldownInput {
  scope_key: string;
  current: RateLimitState | null;
  reason_code: "provider_429" | "provider_error";
  error_code: string;
  now: number;
  cooldown_base_ms: number;
  cooldown_max_ms: number;
}

/**
 * Plans the next cooldown row after a provider rate-limit error.
 *
 * The backoff doubles per consecutive persisted update: the first 429 uses
 * `cooldown_base_ms`, the next uses twice that, capped at `cooldown_max_ms`.
 * `cooldown_until` only moves forward.
 */
export function planProviderCooldown(input: CooldownInput): RateLimitState {
  const current = input.current;
  const previousVersion = current === null ? 0 : current.row_version;
  const exponent = Math.min(previousVersion, 16);
  const backoff = Math.min(
    input.cooldown_max_ms,
    input.cooldown_base_ms * 2 ** exponent
  );
  const proposed = input.now + backoff;
  const existing = current?.cooldown_until ?? 0;
  return {
    scope_key: input.scope_key,
    cooldown_until: Math.max(existing, proposed),
    last_error_code: input.error_code,
    reason_code: input.reason_code,
    row_version: previousVersion + 1,
    updated_at: input.now
  };
}

/** Plans an explicit clear; the row stays with `reason_code="cleared"`. */
export function planClearedCooldown(input: {
  scope_key: string;
  current: RateLimitState | null;
  now: number;
}): RateLimitState {
  return {
    scope_key: input.scope_key,
    cooldown_until: null,
    last_error_code: null,
    reason_code: "cleared",
    row_version: (input.current?.row_version ?? 0) + 1,
    updated_at: input.now
  };
}

/**
 * Plans the conservative recovery fence written before the kernel becomes
 * ready. It never shortens an existing cooldown and never invents one for a
 * scope without a pending reservation.
 */
export function planRecoveryFence(input: {
  scope_key: string;
  current: RateLimitState | null;
  now: number;
}): RateLimitState {
  const existing = input.current?.cooldown_until ?? 0;
  return {
    scope_key: input.scope_key,
    cooldown_until: Math.max(existing, input.now + RECOVERY_FENCE_MS),
    last_error_code: "recovery_unknown",
    reason_code: "recovery_unknown_fence",
    row_version: (input.current?.row_version ?? 0) + 1,
    updated_at: input.now
  };
}

/**
 * Builds the `rate_limit_state` row hash preimage used by the ledger event.
 * The row schema and the JCS object are the ledger contract (DD-FND-097.2).
 */
export function rateLimitStateJson(state: RateLimitState): Record<string, string | number | null> {
  return {
    scope_key: state.scope_key,
    cooldown_until: state.cooldown_until,
    last_error_code: state.last_error_code,
    reason_code: state.reason_code,
    row_version: state.row_version,
    updated_at: state.updated_at
  };
}

/* ------------------------------------------------------------------ */
/* Persistence hooks                                                   */
/* ------------------------------------------------------------------ */

interface RateLimitRow extends Record<string, unknown> {
  scope_key: string;
  cooldown_until: number | null;
  last_error_code: string | null;
  reason_code: string;
  row_version: number;
  updated_at: number;
}

/** Reads the cooldown row for a scope; `null` when absent. */
export function readRateLimitStateInTransaction(
  tx: Tx,
  scopeKey: string
): Result<RateLimitState | null, ErrorEnvelope> {
  let row: RateLimitRow | undefined;
  try {
    row = tx
      .prepare<RateLimitRow>("SELECT * FROM rate_limit_state WHERE scope_key = ?")
      .get([scopeKey]);
  } catch {
    return err(ledgerAsofUnavailable("rate_limit_state:read"));
  }
  if (row === undefined) {
    return ok(null);
  }
  if (!isReasonCode(row.reason_code)) {
    return err(ledgerAsofUnavailable("rate_limit_state.reason_code"));
  }
  return ok({
    scope_key: row.scope_key,
    cooldown_until: row.cooldown_until,
    last_error_code: row.last_error_code,
    reason_code: row.reason_code,
    row_version: row.row_version,
    updated_at: row.updated_at
  });
}

/**
 * Upserts a cooldown row with `row_version` CAS.
 *
 * The caller must already have fsynced `rate_limit.updated`; this function is
 * the short synchronous transaction that follows it.
 */
export function writeRateLimitStateInTransaction(
  tx: Tx,
  state: RateLimitState
): Result<RateLimitState, ErrorEnvelope> {
  if (!Number.isSafeInteger(state.row_version) || state.row_version < 1) {
    return err(schemaError("row_version", "positive_integer", "rate_limit_state"));
  }
  if (state.cooldown_until !== null && state.cooldown_until < state.updated_at) {
    return err(schemaError("cooldown_until", "cooldown_until_gte_updated_at", "rate_limit_state"));
  }
  if ((state.reason_code === "cleared") !== (state.cooldown_until === null)) {
    return err(schemaError("reason_code", "cleared_iff_cooldown_null", "rate_limit_state"));
  }
  tx.prepare(
    `INSERT INTO rate_limit_state
       (scope_key, cooldown_until, last_error_code, reason_code, row_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       cooldown_until = excluded.cooldown_until,
       last_error_code = excluded.last_error_code,
       reason_code = excluded.reason_code,
       row_version = excluded.row_version,
       updated_at = excluded.updated_at`
  ).run([
    state.scope_key,
    state.cooldown_until,
    state.last_error_code,
    state.reason_code,
    state.row_version,
    state.updated_at
  ]);
  return ok(state);
}

/**
 * Scope keys holding a non-expired `claimed` or an `unsettled` reservation.
 *
 * The recovery fence is written for these scopes only; the caller still has to
 * skip scopes that already have a `rate_limit` event after the claim.
 */
export function listFenceScopeKeysInTransaction(tx: Tx, now: number): readonly string[] {
  const rows = tx
    .prepare<{ scope_key: string }>(
      `SELECT DISTINCT scope_key FROM budget_reservation
        WHERE state = 'unsettled'
           OR (state = 'claimed' AND expires_at > ?)
        ORDER BY scope_key`
    )
    .all([now]);
  return rows.map((row) => row.scope_key);
}

function isReasonCode(value: string): value is RateLimitReasonCode {
  return (
    value === "provider_429" ||
    value === "provider_error" ||
    value === "manual" ||
    value === "recovery_unknown_fence" ||
    value === "cleared"
  );
}
