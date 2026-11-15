/**
 * Delivery ⇒ outbox integration (DD-FND-061, DD-FND-092, DD-FND-097.4).
 *
 * Delivery owns the two effect payloads and their fixed `effect_key` forms:
 * - `delivery.dispatch:<delivery_id>:<submission_attempt>`
 * - `delivery.expire:<delivery_id>`
 *
 * The payloads are closed schemas with no extra fields. The service must stage
 * them through the same journal frame as the delivery change; this module
 * only freezes and validates the inputs.
 */

import { err, isId, makeErrorEnvelope, ok } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, VersionBinding } from "@evoplug/core";

import { deliverySchemaError } from "./errors.js";
import { isDeliveryExpired } from "./state.js";
import type { DeliveryRecord, DeliveryUpdateRequest } from "./types.js";

export const DELIVERY_DISPATCH_EFFECT_SCHEMA_VERSION: "rsi.delivery_dispatch_effect/1" =
  "rsi.delivery_dispatch_effect/1";

export const DELIVERY_EXPIRE_EFFECT_SCHEMA_VERSION: "rsi.delivery_expire_effect/1" =
  "rsi.delivery_expire_effect/1";

export const DELIVERY_DISPATCH_EFFECT_KIND: "delivery.dispatch" = "delivery.dispatch";

export const DELIVERY_EXPIRE_EFFECT_KIND: "delivery.expire" = "delivery.expire";

export const DELIVERY_OUTBOX_MIN_PRIORITY = 0;
export const DELIVERY_OUTBOX_MAX_PRIORITY = 9;
export const DELIVERY_OUTBOX_MIN_ATTEMPTS = 1;
export const DELIVERY_OUTBOX_MAX_ATTEMPTS = 16;
export const DELIVERY_MAX_SUBMISSION_ATTEMPT = 16;

export interface DeliveryDispatchEffect {
  schema_version: "rsi.delivery_dispatch_effect/1";
  delivery_id: Id<"del">;
  /** 1..16 safe integer. */
  submission_attempt: number;
}

export interface DeliveryExpireEffect {
  schema_version: "rsi.delivery_expire_effect/1";
  delivery_id: Id<"del">;
  expires_at: number;
}

export type DeliveryOutboxEffectKind = "delivery.dispatch" | "delivery.expire";

export interface DeliveryOutboxEnqueue<K extends DeliveryOutboxEffectKind> {
  effect_kind: K;
  effect_key: string;
  payload: K extends "delivery.dispatch" ? DeliveryDispatchEffect : DeliveryExpireEffect;
  priority: number;
  max_attempts: number;
}

/** `delivery.dispatch:<delivery_id>:<submission_attempt>`. */
export function deliveryDispatchEffectKey(
  deliveryId: Id<"del">,
  submissionAttempt: number,
): string {
  return `${DELIVERY_DISPATCH_EFFECT_KIND}:${deliveryId}:${String(submissionAttempt)}`;
}

/** `delivery.expire:<delivery_id>`. */
export function deliveryExpireEffectKey(deliveryId: Id<"del">): string {
  return `${DELIVERY_EXPIRE_EFFECT_KIND}:${deliveryId}`;
}

export function buildDeliveryDispatchEffect(
  deliveryId: Id<"del">,
  submissionAttempt: number,
): Result<DeliveryDispatchEffect, ErrorEnvelope> {
  if (!isId(deliveryId, "del")) {
    return err(deliverySchemaError("delivery_id", "del_id"));
  }
  if (
    !Number.isSafeInteger(submissionAttempt) ||
    submissionAttempt < 1 ||
    submissionAttempt > DELIVERY_MAX_SUBMISSION_ATTEMPT
  ) {
    return err(deliverySchemaError("submission_attempt", "1_16"));
  }
  return ok({
    schema_version: DELIVERY_DISPATCH_EFFECT_SCHEMA_VERSION,
    delivery_id: deliveryId,
    submission_attempt: submissionAttempt,
  });
}

export function buildDeliveryExpireEffect(
  deliveryId: Id<"del">,
  expiresAt: number,
): Result<DeliveryExpireEffect, ErrorEnvelope> {
  if (!isId(deliveryId, "del")) {
    return err(deliverySchemaError("delivery_id", "del_id"));
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return err(deliverySchemaError("expires_at", "epoch_ms"));
  }
  return ok({
    schema_version: DELIVERY_EXPIRE_EFFECT_SCHEMA_VERSION,
    delivery_id: deliveryId,
    expires_at: expiresAt,
  });
}

export interface DeliveryDispatchOutboxInput {
  readonly delivery_id: Id<"del">;
  readonly submission_attempt: number;
  readonly priority: number;
  readonly max_attempts: number;
}

export function buildDeliveryDispatchOutbox(
  input: DeliveryDispatchOutboxInput,
): Result<DeliveryOutboxEnqueue<"delivery.dispatch">, ErrorEnvelope> {
  const priorityFailure = validateEnqueueBounds(input.priority, input.max_attempts);
  if (priorityFailure !== null) {
    return err(priorityFailure);
  }
  const payload = buildDeliveryDispatchEffect(input.delivery_id, input.submission_attempt);
  if (!payload.ok) {
    return payload;
  }
  return ok({
    effect_kind: DELIVERY_DISPATCH_EFFECT_KIND,
    effect_key: deliveryDispatchEffectKey(input.delivery_id, input.submission_attempt),
    payload: payload.value,
    priority: input.priority,
    max_attempts: input.max_attempts,
  });
}

export interface DeliveryExpireOutboxInput {
  readonly delivery_id: Id<"del">;
  readonly expires_at: number;
  readonly priority: number;
  readonly max_attempts: number;
}

export function buildDeliveryExpireOutbox(
  input: DeliveryExpireOutboxInput,
): Result<DeliveryOutboxEnqueue<"delivery.expire">, ErrorEnvelope> {
  const priorityFailure = validateEnqueueBounds(input.priority, input.max_attempts);
  if (priorityFailure !== null) {
    return err(priorityFailure);
  }
  const payload = buildDeliveryExpireEffect(input.delivery_id, input.expires_at);
  if (!payload.ok) {
    return payload;
  }
  return ok({
    effect_kind: DELIVERY_EXPIRE_EFFECT_KIND,
    effect_key: deliveryExpireEffectKey(input.delivery_id),
    payload: payload.value,
    priority: input.priority,
    max_attempts: input.max_attempts,
  });
}

/**
 * Initial dispatch for a newly created delivery. A dedupe hit creates no row
 * and therefore no dispatch effect.
 */
export function buildDeliveryCreateOutbox(
  record: DeliveryRecord,
  dedupeHit: boolean,
  priority: number,
  maxAttempts: number,
): Result<DeliveryOutboxEnqueue<"delivery.dispatch"> | null, ErrorEnvelope> {
  if (dedupeHit) {
    return ok(null);
  }
  return buildDeliveryDispatchOutbox({
    delivery_id: record.delivery_id,
    submission_attempt: 1,
    priority,
    max_attempts: maxAttempts,
  });
}

/**
 * Outbox `delivery.expire` input for a due row, or `null` when the row is not
 * due/terminal. Expiry never resends; only a new evidence hash or issue/goal
 * binding creates a new delivery.
 */
export function planDeliveryExpiry(
  record: DeliveryRecord,
  nowMs: number,
  priority: number,
  maxAttempts: number,
): Result<DeliveryOutboxEnqueue<"delivery.expire"> | null, ErrorEnvelope> {
  if (!isDeliveryExpired(record, nowMs)) {
    return ok(null);
  }
  return buildDeliveryExpireOutbox({
    delivery_id: record.delivery_id,
    expires_at: record.expires_at,
    priority,
    max_attempts: maxAttempts,
  });
}

/**
 * Confirms an existing effect key agrees with its payload. A mismatch is a
 * schema violation; the service maps it to `E_STATE_ROW_SCHEMA` at the
 * `stageOutbox` boundary.
 */
export function validateDeliveryEffectKey(
  effectKind: DeliveryOutboxEffectKind,
  effectKey: string,
  payload: DeliveryDispatchEffect | DeliveryExpireEffect,
): boolean {
  if (effectKind === "delivery.dispatch") {
    if (payload.schema_version !== DELIVERY_DISPATCH_EFFECT_SCHEMA_VERSION) {
      return false;
    }
    return effectKey === deliveryDispatchEffectKey(payload.delivery_id, payload.submission_attempt);
  }
  if (payload.schema_version !== DELIVERY_EXPIRE_EFFECT_SCHEMA_VERSION) {
    return false;
  }
  return effectKey === deliveryExpireEffectKey(payload.delivery_id);
}

function validateEnqueueBounds(priority: number, maxAttempts: number): ErrorEnvelope | null {
  if (
    !Number.isSafeInteger(priority) ||
    priority < DELIVERY_OUTBOX_MIN_PRIORITY ||
    priority > DELIVERY_OUTBOX_MAX_PRIORITY
  ) {
    return deliverySchemaError("priority", "0_9");
  }
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < DELIVERY_OUTBOX_MIN_ATTEMPTS ||
    maxAttempts > DELIVERY_OUTBOX_MAX_ATTEMPTS
  ) {
    return deliverySchemaError("max_attempts", "1_16");
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Delivery TTL policy (W5)                                           */
/* ------------------------------------------------------------------ */

/** Fresh-home default; never applied as an implicit composition fallback. */
export const DEFAULT_DELIVERY_TTL_MS = 900_000;

/** Default outbox scheduling for a `delivery.expire` effect. */
export const DELIVERY_EXPIRE_OUTBOX_PRIORITY = 0;
export const DELIVERY_EXPIRE_OUTBOX_MAX_ATTEMPTS = 3;

export interface DeliveryTtlPolicy {
  /** Positive safe integer milliseconds. */
  readonly ttl_ms: number;
  /**
   * Absolute epoch-ms of the next input. Unknown/absent means the wall-clock
   * window is used unchanged; a value that is not ahead of `now` is refused,
   * never clamped to one millisecond and never replaced with zero/infinity.
   */
  readonly next_input_epoch_at?: number | null;
}

function deliveryTtlError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_EVIDENCE_UNKNOWN",
    category: "source",
    message_key: "error.evidence.unknown",
    stage: "delivery_expiry",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/** `min(now + ttl_ms, next_input_epoch_at)` with fail-closed validation. */
export function computeDeliveryExpiresAt(
  now_ms: number,
  policy: DeliveryTtlPolicy | null | undefined,
): Result<number, ErrorEnvelope> {
  if (!Number.isSafeInteger(now_ms) || now_ms < 0) {
    return err(deliveryTtlError("now_ms", "non_negative_safe_integer"));
  }
  if (policy === null || policy === undefined) {
    return err(deliveryTtlError("delivery.ttl_ms", "ttl_missing"));
  }
  const ttl = policy.ttl_ms;
  if (!Number.isSafeInteger(ttl) || ttl < 1) {
    return err(deliveryTtlError("delivery.ttl_ms", "positive_safe_integer"));
  }
  const wall = now_ms + ttl;
  if (!Number.isSafeInteger(wall)) {
    return err(deliveryTtlError("delivery.ttl_ms", "overflow"));
  }
  const next = policy.next_input_epoch_at;
  if (next === undefined || next === null) {
    return ok(wall);
  }
  if (!Number.isSafeInteger(next) || next < 0) {
    return err(deliveryTtlError("delivery.next_input_epoch_at", "epoch_ms"));
  }
  if (next <= now_ms) {
    return err(deliveryTtlError("delivery.next_input_epoch_at", "next_input_epoch_not_ahead"));
  }
  return ok(Math.min(wall, next));
}

/**
 * Deliveries from an older input epoch that may still be sent.
 *
 * Submitted rows are deliberately excluded: their reminder already reached
 * the host, so invalidating the row would record a retraction that never
 * happened. They still expire through the wall-clock TTL sweep. Terminal rows
 * are excluded for the same reason.
 */
export function selectEpochInvalidated(
  records: readonly DeliveryRecord[],
  binding: Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">,
): readonly DeliveryRecord[] {
  return records.filter(
    (record) =>
      record.task_id === binding.task_id &&
      record.branch_id === binding.branch_id &&
      record.input_epoch < binding.input_epoch &&
      record.state === "pending",
  );
}

/**
 * One transport transition for a stale row. The reason is `version_changed`
 * (a newer input exists); `expired_by_time` is reserved for the TTL path.
 * `expires_at` and the adoption axis are untouched.
 */
export function epochInvalidationRequest(record: DeliveryRecord): DeliveryUpdateRequest {
  return {
    schema_version: "rsi.delivery_update/1",
    delivery_id: record.delivery_id,
    expected_row_version: record.row_version,
    update: { axis: "transport", state: "expired", reason_code: "version_changed" },
  };
}

/** Validates the binding fields the selector compares. */
export function validateEpochBinding(
  binding: Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">,
): Result<Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">, ErrorEnvelope> {
  if (!isId(binding.task_id, "task")) {
    return err(deliveryTtlError("binding.task_id", "task_id"));
  }
  if (!isId(binding.branch_id, "br")) {
    return err(deliveryTtlError("binding.branch_id", "br_id"));
  }
  if (!Number.isSafeInteger(binding.input_epoch) || binding.input_epoch < 1) {
    return err(deliveryTtlError("binding.input_epoch", "positive_safe_integer"));
  }
  return ok(binding);
}
