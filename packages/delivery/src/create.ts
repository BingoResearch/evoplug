/**
 * `delivery.create` validation and row construction (DD-FND-092).
 *
 * A create writes only a `pending` row; submission and evidence arrive
 * through independent axis updates. Content must be retrievable and match
 * `content_hash` before a row exists. A dedupe hit writes only the dedupe
 * Decision and returns the existing row unchanged.
 */

import {
  compareUtf8,
  err,
  isHash,
  isId,
  isValidConfigVersion,
  isValidGoalVersion,
  newId,
  ok,
  parseSourceRef,
} from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, SourceRef } from "@evoplug/core";

import { computeDeliveryDedupeKey, isDeliveryDedupeHit } from "./dedupe.js";
import { deliveryContentError, deliverySchemaError } from "./errors.js";
import { buildDeliveryCreateOutbox, type DeliveryOutboxEnqueue } from "./outbox.js";
import {
  DELIVERY_PLAN_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_VERSION,
  isDeliveryTerminal,
  type DeliveryPlan,
  type DeliveryRecord,
} from "./types.js";

const PLAN_FIELDS: readonly string[] = [
  "schema_version",
  "task_id",
  "branch_id",
  "input_epoch",
  "config_version",
  "goal_version",
  "requirement_ids",
  "issue_id",
  "evidence_hash",
  "pack_hash",
  "content_hash",
  "content_ref",
  "expires_at",
];

export interface DeliveryContentCheck {
  readonly retrievable: boolean;
  readonly hash_matches: boolean;
  /** Optional preallocated id used by the online preparation boundary. */
  readonly delivery_id?: Id<"del">;
  /** Prepared bytes are written by the composition before `create`. */
  readonly content_bytes?: Uint8Array;
}

export interface DeliveryCreateResult {
  readonly delivery: DeliveryRecord;
  readonly dedupe_hit: boolean;
}

export interface CreateDeliveryInput {
  readonly plan: DeliveryPlan;
  readonly existing: DeliveryRecord | null;
  readonly delivery_id: Id<"del">;
  readonly content: DeliveryContentCheck;
  readonly now_ms: number;
}

/** Parses the `delivery.create` plan. Unknown fields are rejected. */
export function parseDeliveryPlan(value: unknown): Result<DeliveryPlan, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(deliverySchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PLAN_FIELDS.includes(key)) {
      return err(deliverySchemaError(key, "known_field"));
    }
  }
  for (const field of PLAN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(deliverySchemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== DELIVERY_PLAN_SCHEMA_VERSION) {
    return err(deliverySchemaError("schema_version", DELIVERY_PLAN_SCHEMA_VERSION));
  }
  const taskId = record["task_id"];
  const branchId = record["branch_id"];
  if (typeof taskId !== "string" || !isId(taskId, "task")) {
    return err(deliverySchemaError("task_id", "task_id"));
  }
  if (typeof branchId !== "string" || !isId(branchId, "br")) {
    return err(deliverySchemaError("branch_id", "br_id"));
  }
  const inputEpoch = record["input_epoch"];
  if (typeof inputEpoch !== "number" || !Number.isSafeInteger(inputEpoch) || inputEpoch < 1) {
    return err(deliverySchemaError("input_epoch", "positive_safe_integer"));
  }
  const configVersion = record["config_version"];
  if (typeof configVersion !== "string" || !isValidConfigVersion(configVersion)) {
    return err(deliverySchemaError("config_version", "config_version_format"));
  }
  const goalVersion = record["goal_version"];
  if (typeof goalVersion !== "string" || !isValidGoalVersion(goalVersion)) {
    return err(deliverySchemaError("goal_version", "goal_version_format"));
  }
  const requirementIds = parseRequirementIds(record["requirement_ids"]);
  if (!requirementIds.ok) {
    return requirementIds;
  }
  const issueId = record["issue_id"];
  if (issueId !== null) {
    if (typeof issueId !== "string" || !isId(issueId, "issue")) {
      return err(deliverySchemaError("issue_id", "issue_id_or_null"));
    }
  }
  if (requirementIds.value.length === 0 && issueId === null) {
    return err(deliverySchemaError("issue_id", "requirement_or_issue"));
  }
  const evidenceHash = record["evidence_hash"];
  const packHash = record["pack_hash"];
  const contentHash = record["content_hash"];
  if (typeof evidenceHash !== "string" || !isHash(evidenceHash)) {
    return err(deliverySchemaError("evidence_hash", "sha256_full_hash"));
  }
  if (typeof packHash !== "string" || !isHash(packHash)) {
    return err(deliverySchemaError("pack_hash", "sha256_full_hash"));
  }
  if (typeof contentHash !== "string" || !isHash(contentHash)) {
    return err(deliverySchemaError("content_hash", "sha256_full_hash"));
  }
  const contentRef = record["content_ref"];
  if (typeof contentRef !== "string") {
    return err(deliverySchemaError("content_ref", "source_ref"));
  }
  const parsedRef = parseSourceRef(contentRef);
  if (!parsedRef.ok) {
    return parsedRef;
  }
  const expiresAt = record["expires_at"];
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return err(deliverySchemaError("expires_at", "epoch_ms"));
  }
  return ok({
    schema_version: DELIVERY_PLAN_SCHEMA_VERSION,
    task_id: taskId,
    branch_id: branchId,
    input_epoch: inputEpoch,
    config_version: configVersion,
    goal_version: goalVersion,
    requirement_ids: requirementIds.value,
    issue_id: issueId,
    evidence_hash: evidenceHash,
    pack_hash: packHash,
    content_hash: contentHash,
    content_ref: parsedRef.value.source_ref,
    expires_at: expiresAt,
  });
}

/**
 * Creates a delivery or returns the existing dedupe hit. A hit never mutates
 * the existing row; a new round with the same key and evidence only records
 * the dedupe Decision at the service layer.
 */
export function createDelivery(
  input: CreateDeliveryInput,
): Result<DeliveryCreateResult, ErrorEnvelope> {
  const parsed = parseDeliveryPlan(input.plan);
  if (!parsed.ok) {
    return parsed;
  }
  const plan = parsed.value;
  const dedupeKey = computeDeliveryDedupeKey(plan);
  // Revalidate the frozen content before accepting a dedupe hit. A row with a
  // matching identity cannot make a missing or corrupted CAS object usable;
  // callers must repair the content and retry explicitly.
  if (!input.content.retrievable) {
    return err(deliveryContentError(plan.content_ref, "missing"));
  }
  if (!input.content.hash_matches) {
    return err(deliveryContentError(plan.content_ref, "hash_mismatch"));
  }
  if (input.existing !== null) {
    if (
      isDeliveryDedupeHit(input.existing, {
        dedupe_key: dedupeKey,
        evidence_hash: plan.evidence_hash,
      })
    ) {
      return ok({ delivery: input.existing, dedupe_hit: true }, "no_op");
    }
  }
  const record: DeliveryRecord = {
    schema_version: DELIVERY_RECORD_SCHEMA_VERSION,
    task_id: plan.task_id,
    branch_id: plan.branch_id,
    input_epoch: plan.input_epoch,
    config_version: plan.config_version,
    goal_version: plan.goal_version,
    requirement_ids: [...plan.requirement_ids],
    issue_id: plan.issue_id,
    evidence_hash: plan.evidence_hash,
    pack_hash: plan.pack_hash,
    content_hash: plan.content_hash,
    content_ref: plan.content_ref,
    expires_at: plan.expires_at,
    delivery_id: input.delivery_id,
    dedupe_key: dedupeKey,
    state: "pending",
    terminal_reason: null,
    inclusion_evidence: "unknown",
    transport_body_verified: false,
    submission_ref: null,
    inclusion_ref: null,
    adoption: "unknown",
    adoption_ref: null,
    row_version: 1,
    created_at: input.now_ms,
    updated_at: input.now_ms,
  };
  return ok({ delivery: record, dedupe_hit: false });
}

/** Creates a delivery and allocates its `del` id. */
export function createDeliveryWithNewId(
  plan: DeliveryPlan,
  existing: DeliveryRecord | null,
  content: DeliveryContentCheck,
  nowMs: number,
): Result<DeliveryCreateResult, ErrorEnvelope> {
  return createDelivery({
    plan,
    existing,
    delivery_id: newId("del"),
    content,
    now_ms: nowMs,
  });
}

export interface DeliveryCreateCommit extends DeliveryCreateResult {
  /** `delivery.dispatch` frame that must follow the delivery frame in the same commit. */
  readonly outbox: DeliveryOutboxEnqueue<"delivery.dispatch"> | null;
}

/**
 * Builds the create result and its initial `delivery.dispatch` outbox input.
 * A dedupe hit produces no row and no outbox member. The journal order is
 * `delivery.recorded` first, then `outbox.enqueued`.
 */
export function buildDeliveryCreateCommit(
  input: CreateDeliveryInput,
  priority: number,
  maxAttempts: number,
): Result<DeliveryCreateCommit, ErrorEnvelope> {
  const created = createDelivery(input);
  if (!created.ok) {
    return created;
  }
  const outbox = buildDeliveryCreateOutbox(
    created.value.delivery,
    created.value.dedupe_hit,
    priority,
    maxAttempts,
  );
  if (!outbox.ok) {
    return outbox;
  }
  return ok({
    delivery: created.value.delivery,
    dedupe_hit: created.value.dedupe_hit,
    outbox: outbox.value,
  });
}

/** Content may never be replaced after creation. */
export function isDeliveryImmutableField(field: string): boolean {
  return (
    field === "dedupe_key" ||
    field === "evidence_hash" ||
    field === "content_hash" ||
    field === "goal_version"
  );
}

/** True when the row is already expired or failed; terminal rows never revive. */
export function isDeliveryClosed(record: DeliveryRecord): boolean {
  return isDeliveryTerminal(record.state);
}

/** Returns the content ref stored on the row, never a caller-supplied one. */
export function deliveryContentRef(record: DeliveryRecord): SourceRef {
  return record.content_ref;
}

function parseRequirementIds(value: unknown): Result<Id<"req">[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(deliverySchemaError("requirement_ids", "array"));
  }
  const out: Id<"req">[] = [];
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || !isId(item, "req")) {
      return err(deliverySchemaError(`requirement_ids[${String(index)}]`, "req_id"));
    }
    if (previous !== null) {
      const order = compareUtf8(previous, item);
      if (order > 0) {
        return err(deliverySchemaError("requirement_ids", "strict_utf8_ascending"));
      }
      if (order === 0) {
        return err(deliverySchemaError("requirement_ids", "unique"));
      }
    }
    previous = item;
    out.push(item);
  }
  return ok(out);
}
