import { type ErrorEnvelope, type Hash, type Id, type JsonValue, type Result } from "@evoplug/core";
import { fieldDetails, storageError } from "../errors.js";
import type { SqlRow } from "../types.js";
import { isHash } from "../hash.js";
import { isJsonObject as sharedIsJsonObject } from "@evoplug/core";

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return sharedIsJsonObject(value);
}

/** Lease duration in milliseconds (DD-FND-061). */
export const OUTBOX_LEASE_MS = 30000;

/** Retry backoff schedule: 1 s, 5 s, 30 s, 5 min, capped at 5 min. */
const OUTBOX_BACKOFF_MS: readonly number[] = [1000, 5000, 30000, 300000];

/** Closed effect kind set of the `outbox` table. */
const OUTBOX_EFFECT_KINDS = [
  "delivery.dispatch",
  "review.enqueue",
  "maintenance.gc",
  "delivery.expire"
] as const;

export type OutboxEffectKind = (typeof OUTBOX_EFFECT_KINDS)[number];

const OUTBOX_STATES = [
  "pending",
  "leased",
  "done",
  "failed",
  "uncertain",
  "cancelled"
] as const;

type OutboxState = (typeof OUTBOX_STATES)[number];

const OUTBOX_ATTEMPT_STATES = [
  "started",
  "succeeded",
  "retryable_failed",
  "terminal_failed",
  "uncertain",
  "cancelled"
] as const;

type OutboxAttemptState = (typeof OUTBOX_ATTEMPT_STATES)[number];

const ULID_PATTERN: RegExp = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when `value` is a `del:` / `job:` / `trg:` style prefixed ULID. */
function isPrefixedUlid(value: string, prefix: string): boolean {
  const head = `${prefix}:`;
  return value.startsWith(head) && ULID_PATTERN.test(value.slice(head.length));
}

function isSafeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export interface DeliveryDispatchEffect {
  readonly schema_version: "rsi.delivery_dispatch_effect/1";
  readonly delivery_id: Id<"del">;
  readonly submission_attempt: number;
}

export interface ReviewEnqueueEffect {
  readonly schema_version: "rsi.review_enqueue_effect/1";
  readonly job_id: Id<"job">;
  readonly request_id: string;
  readonly trigger_event_id: Id<"trg">;
  readonly trigger_dedupe_key: Hash;
  readonly binding: {
    readonly task_id: Id<"task">;
    readonly branch_id: Id<"br">;
    readonly input_epoch: number;
    readonly goal_version: string;
    readonly config_version: string;
    readonly watermark: number;
  };
  readonly created_at: number;
}

export interface MaintenanceGcEffect {
  readonly schema_version: "rsi.maintenance_gc_effect/1";
  readonly mode: "dry_run" | "apply";
  readonly retention_days: number | null;
}

export interface DeliveryExpireEffect {
  readonly schema_version: "rsi.delivery_expire_effect/1";
  readonly delivery_id: Id<"del">;
  readonly expires_at: number;
}

export interface OutboxEffectPayloadMap {
  readonly "delivery.dispatch": DeliveryDispatchEffect;
  readonly "review.enqueue": ReviewEnqueueEffect;
  readonly "maintenance.gc": MaintenanceGcEffect;
  readonly "delivery.expire": DeliveryExpireEffect;
}

export type OutboxEnqueueInput = {
  readonly [K in OutboxEffectKind]: {
    readonly effect_kind: K;
    readonly effect_key: string;
    readonly payload: OutboxEffectPayloadMap[K];
    readonly priority: number;
    readonly max_attempts: number;
  };
}[OutboxEffectKind];

/** Fixed effect key formula for `delivery.dispatch`. */
export function deliveryDispatchEffectKey(
  deliveryId: string,
  submissionAttempt: number,
): string {
  return `delivery.dispatch:${deliveryId}:${submissionAttempt}`;
}

/** Fixed effect key formula for `review.enqueue`. */
export function reviewEnqueueEffectKey(jobId: string): string {
  return `review.enqueue:${jobId}`;
}

/** Fixed effect key formula for `delivery.expire`. */
export function deliveryExpireEffectKey(deliveryId: string): string {
  return `delivery.expire:${deliveryId}`;
}

const EXACT_KEYS: Readonly<Record<OutboxEffectKind, readonly string[]>> = {
  "delivery.dispatch": ["schema_version", "delivery_id", "submission_attempt"],
  "review.enqueue": [
    "schema_version",
    "job_id",
    "request_id",
    "trigger_event_id",
    "trigger_dedupe_key",
    "binding",
    "created_at"
  ],
  "maintenance.gc": ["schema_version", "mode", "retention_days"],
  "delivery.expire": ["schema_version", "delivery_id", "expires_at"]
};

const SCHEMA_VERSION_BY_KIND: Readonly<Record<OutboxEffectKind, string>> = {
  "delivery.dispatch": "rsi.delivery_dispatch_effect/1",
  "review.enqueue": "rsi.review_enqueue_effect/1",
  "maintenance.gc": "rsi.maintenance_gc_effect/1",
  "delivery.expire": "rsi.delivery_expire_effect/1"
};

const BINDING_KEYS: readonly string[] = [
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "watermark"
];

/** True when `value` is a registered effect kind. */
function isOutboxEffectKind(value: string): value is OutboxEffectKind {
  return (OUTBOX_EFFECT_KINDS as readonly string[]).includes(value);
}

function fieldsAreExact(value: Record<string, JsonValue>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function validateBinding(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value) || !fieldsAreExact(value, BINDING_KEYS)) {
    return false;
  }
  const taskId = value["task_id"];
  const branchId = value["branch_id"];
  const inputEpoch = value["input_epoch"];
  const goalVersion = value["goal_version"];
  const configVersion = value["config_version"];
  const watermark = value["watermark"];
  return (
    typeof taskId === "string" &&
    isPrefixedUlid(taskId, "task") &&
    typeof branchId === "string" &&
    isPrefixedUlid(branchId, "br") &&
    typeof inputEpoch === "number" &&
    Number.isSafeInteger(inputEpoch) &&
    inputEpoch >= 1 &&
    typeof goalVersion === "string" &&
    goalVersion.length > 0 &&
    typeof configVersion === "string" &&
    configVersion.length > 0 &&
    typeof watermark === "number" &&
    isSafeNonNegative(watermark)
  );
}

/**
 * Validates an outbox payload against its closed schema and derives the fixed
 * `effect_key`. `maintenance.gc` keeps the caller-provided stable key.
 */
export function validateOutboxEffect(input: {
  readonly effect_kind: string;
  readonly payload: JsonValue;
  readonly effect_key?: string;
}): Result<OutboxEnqueueInput, ErrorEnvelope> {
  const reject = (reason: string, detail: string) => ({
    ok: false as const,
    status: "rejected" as const,
    error: storageError({
      code: "E_STATE_ROW_SCHEMA",
      stage: "storage.outbox",
      details: fieldDetails(`payload.${reason}`, detail),
      message_key: "error.storage.outbox_payload_invalid"
    })
  });
  if (!isOutboxEffectKind(input.effect_kind)) {
    return reject("unknown_effect_kind", input.effect_kind);
  }
  const kind = input.effect_kind;
  const payload = input.payload;
  if (!isJsonObject(payload) || !fieldsAreExact(payload, EXACT_KEYS[kind])) {
    return reject("payload_shape", "payload must have exactly the declared fields");
  }
  if (payload["schema_version"] !== SCHEMA_VERSION_BY_KIND[kind]) {
    return reject("schema_version", "payload schema_version does not match effect kind");
  }
  switch (kind) {
    case "delivery.dispatch": {
      const deliveryId = payload["delivery_id"];
      const attempt = payload["submission_attempt"];
      if (typeof deliveryId !== "string" || !isPrefixedUlid(deliveryId, "del")) {
        return reject("delivery_id", "delivery_id must be del:<ULID>");
      }
      if (
        typeof attempt !== "number" ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1 ||
        attempt > 16
      ) {
        return reject("submission_attempt", "submission_attempt must be 1..16");
      }
      return {
        ok: true,
        status: "ok",
        value: {
          effect_kind: kind,
          effect_key: deliveryDispatchEffectKey(deliveryId, attempt),
          payload: {
            schema_version: "rsi.delivery_dispatch_effect/1",
            delivery_id: deliveryId as Id<"del">,
            submission_attempt: attempt
          },
          priority: 0,
          max_attempts: 1
        }
      };
    }
    case "review.enqueue": {
      const jobId = payload["job_id"];
      const requestId = payload["request_id"];
      const triggerEventId = payload["trigger_event_id"];
      const dedupeKey = payload["trigger_dedupe_key"];
      const createdAt = payload["created_at"];
      if (typeof jobId !== "string" || !isPrefixedUlid(jobId, "job")) {
        return reject("job_id", "job_id must be job:<ULID>");
      }
      if (
        typeof requestId !== "string" ||
        requestId.length === 0 ||
        Buffer.byteLength(requestId, "utf8") > 128
      ) {
        return reject("request_id", "request_id must be 1..128 UTF-8 bytes");
      }
      if (typeof triggerEventId !== "string" || !isPrefixedUlid(triggerEventId, "trg")) {
        return reject("trigger_event_id", "trigger_event_id must be trg:<ULID>");
      }
      if (typeof dedupeKey !== "string" || !isHash(dedupeKey)) {
        return reject("trigger_dedupe_key", "trigger_dedupe_key must be a content hash");
      }
      if (!validateBinding(payload["binding"])) {
        return reject("binding", "binding must be a complete six-field VersionBinding");
      }
      if (typeof createdAt !== "number" || !isSafeNonNegative(createdAt)) {
        return reject("created_at", "created_at must be a non-negative safe integer");
      }
      const binding = payload["binding"];
      if (!isJsonObject(binding)) {
        return reject("binding", "binding must be an object");
      }
      return {
        ok: true,
        status: "ok",
        value: {
          effect_kind: kind,
          effect_key: reviewEnqueueEffectKey(jobId),
          payload: {
            schema_version: "rsi.review_enqueue_effect/1",
            job_id: jobId as Id<"job">,
            request_id: requestId,
            trigger_event_id: triggerEventId as Id<"trg">,
            trigger_dedupe_key: dedupeKey,
            binding: {
              task_id: binding["task_id"] as Id<"task">,
              branch_id: binding["branch_id"] as Id<"br">,
              input_epoch: binding["input_epoch"] as number,
              goal_version: binding["goal_version"] as string,
              config_version: binding["config_version"] as string,
              watermark: binding["watermark"] as number
            },
            created_at: createdAt
          },
          priority: 0,
          max_attempts: 1
        }
      };
    }
    case "maintenance.gc": {
      const mode = payload["mode"];
      const retention = payload["retention_days"];
      if (mode !== "dry_run" && mode !== "apply") {
        return reject("mode", "mode must be dry_run or apply");
      }
      if (
        retention !== null &&
        (typeof retention !== "number" || !isSafeNonNegative(retention))
      ) {
        return reject("retention_days", "retention_days must be null or a non-negative integer");
      }
      const effectKey = input.effect_key;
      if (
        typeof effectKey !== "string" ||
        effectKey.length === 0 ||
        Buffer.byteLength(effectKey, "utf8") > 256
      ) {
        return reject("effect_key", "maintenance.gc requires a stable caller effect_key");
      }
      return {
        ok: true,
        status: "ok",
        value: {
          effect_kind: kind,
          effect_key: effectKey,
          payload: {
            schema_version: "rsi.maintenance_gc_effect/1",
            mode,
            retention_days: retention
          },
          priority: 0,
          max_attempts: 1
        }
      };
    }
    case "delivery.expire": {
      const deliveryId = payload["delivery_id"];
      const expiresAt = payload["expires_at"];
      if (typeof deliveryId !== "string" || !isPrefixedUlid(deliveryId, "del")) {
        return reject("delivery_id", "delivery_id must be del:<ULID>");
      }
      if (typeof expiresAt !== "number" || !isSafeNonNegative(expiresAt)) {
        return reject("expires_at", "expires_at must be a non-negative safe integer");
      }
      return {
        ok: true,
        status: "ok",
        value: {
          effect_kind: kind,
          effect_key: deliveryExpireEffectKey(deliveryId),
          payload: {
            schema_version: "rsi.delivery_expire_effect/1",
            delivery_id: deliveryId as Id<"del">,
            expires_at: expiresAt
          },
          priority: 0,
          max_attempts: 1
        }
      };
    }
  }
}

/** Retry backoff for the given attempt count. */
export function outboxBackoffMs(attempts: number): number {
  if (attempts <= 0) {
    return OUTBOX_BACKOFF_MS[0] ?? 1000;
  }
  const index = Math.min(attempts - 1, OUTBOX_BACKOFF_MS.length - 1);
  return OUTBOX_BACKOFF_MS[index] ?? 300000;
}

export interface OutboxRow extends SqlRow {
  readonly outbox_id: string;
  readonly effect_kind: OutboxEffectKind;
  readonly effect_key: string;
  readonly payload_json: string;
  readonly state: OutboxState;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly next_attempt_at: number;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: number | null;
  readonly reconcile_required: number;
  readonly last_error_code: string | null;
  readonly result_ref: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface OutboxAttemptRow extends SqlRow {
  readonly outbox_attempt_id: string;
  readonly outbox_id: string;
  readonly attempt: number;
  readonly state: OutboxAttemptState;
  readonly error_code: string | null;
  readonly started_at: number;
  readonly ended_at: number | null;
}
