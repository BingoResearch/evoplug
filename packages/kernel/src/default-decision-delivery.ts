/**
 * Default FND decision/delivery composition (DD-FND-072, DD-FND-092).
 *
 * These are the exact `decision.record` and `delivery.create` projections the
 * IPC handlers have always written. They now live behind reusable ports so
 * the online pipeline can call the same code instead of a second copy:
 *
 * - `record(draft)` implements `DecisionRecordPort` with the documented hash
 *   whitelist, the `(branch_id, decision_hash)` idempotency key and the
 *   action/reason allowlist gate.
 * - `create({plan, content})` implements the create half of
 *   `DeliveryPipelinePort`. Delivery, `delivery_history` and the initial
 *   `delivery.dispatch` outbox row are projected by one journal frame and one
 *   SQLite transaction; they are never split into a delivery transaction and
 *   an enqueue transaction.
 * - `enqueue(outbox)` never writes a second frame. It observes the outbox row
 *   that `create` already staged in the same frame and returns its effect key,
 *   or fails with `E_IDEMPOTENCY_CONFLICT` when no such staged row exists.
 *
 * There is deliberately no `prepare` here. The decision input snapshot hashes
 * and the delivery content/pack preparation are owned by the caller; this
 * module never invents a preimage or a plan.
 */

import type {
  DecisionDraft,
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  Tx,
  VersionBinding
} from "@evoplug/core";
import { ok, err, canonicalHash, canonicalJsonText, compareUtf8, newId, parseSourceRef } from "@evoplug/core";
import type { IpcHandler } from "@evoplug/ipc";
import {
  checkDecisionActionReason,
  validateVersionBinding,
  type DecisionActionKind,
  type DecisionReasonCode
} from "@evoplug/ledger";
import {
  buildDeliveryCreateOutbox,
  createDelivery,
  parseDeliveryPlan,
  type DeliveryContentCheck,
  type DeliveryCreateResult,
  type DeliveryOutboxEnqueue,
  type DeliveryPlan,
  type DeliveryRecord
} from "@evoplug/delivery";
import type { BlobStore, SqliteConnection } from "@evoplug/storage";

import { fieldError, internalError } from "./errors.js";
import type { DecisionRecordPort, DeliveryPipelinePort } from "./online-pipeline.js";

type Row = Record<string, unknown>;

/** One ledger frame as the kernel's shared committer consumes it. */
export interface DecisionDeliveryCommitInput {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation: "insert" | "update" | "transition";
  readonly binding: VersionBinding | null;
  readonly row_schema: string;
  readonly row: Record<string, JsonValue>;
  readonly before: Record<string, JsonValue> | null;
  readonly apply?: (tx: Tx, afterHash: Hash, eventId: Id<"ev">) => void;
}

export interface DecisionDeliveryCommitPort {
  commit(input: DecisionDeliveryCommitInput): Promise<Result<void, ErrorEnvelope>>;
}

export interface DefaultDecisionDeliveryDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: Pick<BlobStore, "verify">;
  readonly now: () => number;
  readonly commit: DecisionDeliveryCommitPort["commit"];
}

export type DefaultDeliveryCreateEnqueuePort = Pick<DeliveryPipelinePort, "create" | "enqueue">;

export interface DefaultDeliveryService extends DefaultDeliveryCreateEnqueuePort {
  /**
   * Production handler path: parse the plan, project it through `create`, and
   * keep the content check and dedupe order of the original IPC handler.
   */
  createFromPlan(plan: DeliveryPlan): Promise<Result<DeliveryCreateResult, ErrorEnvelope>>;
}

export interface DefaultDecisionDeliveryService {
  readonly decision: DecisionRecordPort;
  readonly delivery: DefaultDeliveryService;
  readonly handlers: {
    readonly "decision.record": IpcHandler<"decision.record">;
    readonly "delivery.create": IpcHandler<"delivery.create">;
  };
}

/* ------------------------------------------------------------------ */
/* Shared row helpers                                                 */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path = "$"): Result<Record<string, unknown>, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(fieldError(path, "must_be_object"));
  }
  return ok(value);
}

function oneRow<T>(
  connection: SqliteConnection,
  sql: string,
  params?: Readonly<Record<string, string | number | null>>
): T | null {
  const row = connection.prepare(sql).get(params ?? {});
  return row === undefined ? null : (row as T);
}

function asString(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function asNumber(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function asNullableString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function parseJson(text: string | null): JsonValue | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

function bindingJson(binding: VersionBinding): JsonValue {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

function asSqlParams(value: Record<string, JsonValue>): Readonly<Record<string, string | number | null>> {
  return value as unknown as Readonly<Record<string, string | number | null>>;
}

function canonicalDecisionAction(action: Record<string, unknown>): JsonValue {
  const targets = action["targets"];
  if (!Array.isArray(targets)) {
    return action as unknown as JsonValue;
  }
  const sorted = [...targets].sort((left, right) =>
    compareUtf8(canonicalJsonText(left as JsonValue), canonicalJsonText(right as JsonValue))
  );
  return { ...action, targets: sorted } as unknown as JsonValue;
}

function validateDecisionAction(action: Record<string, unknown>): ErrorEnvelope | null {
  if (action["kind"] !== "no_op") {
    return null;
  }
  if (!Array.isArray(action["targets"])) {
    return fieldError("decision.action.targets", "required");
  }
  const noopReason = action["noop_reason"];
  if (
    noopReason !== "nothing_to_do" &&
    noopReason !== "below_threshold" &&
    noopReason !== "same_goal"
  ) {
    return fieldError("decision.action.noop_reason", "required");
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Decision record                                                    */
/* ------------------------------------------------------------------ */

async function recordDecision(
  connection: SqliteConnection,
  commit: DecisionDeliveryCommitPort["commit"],
  now: () => number,
  decisionValue: unknown
): Promise<Result<{ readonly decision_id: Id<"dec">; readonly created: boolean }, ErrorEnvelope>> {
  if (!isRecord(decisionValue)) {
    return err(fieldError("decision", "must_be_object"));
  }
  const decision = decisionValue;
  const action = decision["action"];
  if (!isRecord(action) || typeof action["kind"] !== "string") {
    return err(fieldError("decision.action.kind", "required"));
  }
  const actionError = validateDecisionAction(action);
  if (actionError !== null) {
    return err(actionError);
  }
  const reasonCode = decision["reason_code"];
  if (typeof reasonCode !== "string") {
    return err(fieldError("decision.reason_code", "required"));
  }
  const policyCheck = checkDecisionActionReason({
    action_kind: action["kind"] as DecisionActionKind,
    reason_code: reasonCode as DecisionReasonCode
  });
  if (!policyCheck.ok) {
    return err(fieldError("decision.reason_code", policyCheck.reason));
  }
  const bindingValue = decision["binding"];
  if (!isRecord(bindingValue)) {
    return err(fieldError("decision.binding", "must_be_object"));
  }
  const binding: VersionBinding = {
    task_id: String(bindingValue["task_id"] ?? "") as Id<"task">,
    branch_id: String(bindingValue["branch_id"] ?? "") as Id<"br">,
    input_epoch: Number(bindingValue["input_epoch"] ?? 0),
    goal_version: String(bindingValue["goal_version"] ?? ""),
    config_version: String(bindingValue["config_version"] ?? ""),
    watermark: Number(bindingValue["watermark"] ?? 0)
  };
  const bindingCheck = validateVersionBinding(binding);
  if (!bindingCheck.ok) return bindingCheck;
  const inputs = decision["inputs"];
  const diagnostics = decision["diagnostics"];
  if (!isRecord(inputs) || !isRecord(diagnostics)) {
    return err(fieldError("decision.inputs", "must_be_object"));
  }
  const preimage: JsonValue = {
    binding: bindingJson(binding),
    policy_version: String(decision["policy_version"] ?? ""),
    issue_id: (decision["issue_id"] ?? null) as JsonValue,
    action: canonicalDecisionAction(action),
    outcome: String(decision["outcome"] ?? ""),
    reason_code: reasonCode,
    dedupe_key: (decision["dedupe_key"] ?? null) as JsonValue,
    evidence_hash: (decision["evidence_hash"] ?? null) as JsonValue,
    pack_hash: (decision["pack_hash"] ?? null) as JsonValue,
    request_hash: (decision["request_hash"] ?? null) as JsonValue,
    delivery_id: (decision["delivery_id"] ?? null) as JsonValue,
    job_id: (decision["job_id"] ?? null) as JsonValue,
    write_id: (decision["write_id"] ?? null) as JsonValue,
    aggregate_id: (decision["aggregate_id"] ?? null) as JsonValue,
    inputs: inputs as unknown as JsonValue,
    rule_ids: (diagnostics["rule_ids"] ?? []) as JsonValue,
    classifier_version: String(diagnostics["classifier_version"] ?? ""),
    degraded_reasons: (diagnostics["degraded_reasons"] ?? []) as JsonValue
  };
  const decisionHash = canonicalHash(preimage);
  const existing = oneRow<Row>(
    connection,
    "SELECT decision_id FROM decision_record WHERE branch_id = :branch_id AND decision_hash = :decision_hash",
    { branch_id: binding.branch_id, decision_hash: decisionHash }
  );
  if (existing !== null) {
    return ok({ decision_id: asString(existing, "decision_id") as Id<"dec">, created: false });
  }
  const decisionId = newId("dec", now());
  const row: Record<string, JsonValue> = {
    decision_id: decisionId,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    policy_version: String(decision["policy_version"] ?? ""),
    issue_id: (decision["issue_id"] ?? null) as JsonValue,
    action_kind: action["kind"],
    outcome: String(decision["outcome"] ?? ""),
    reason_code: reasonCode,
    dedupe_key: (decision["dedupe_key"] ?? null) as JsonValue,
    evidence_hash: (decision["evidence_hash"] ?? null) as JsonValue,
    pack_hash: (decision["pack_hash"] ?? null) as JsonValue,
    request_hash: (decision["request_hash"] ?? null) as JsonValue,
    delivery_id: (decision["delivery_id"] ?? null) as JsonValue,
    job_id: (decision["job_id"] ?? null) as JsonValue,
    write_id: (decision["write_id"] ?? null) as JsonValue,
    aggregate_id: (decision["aggregate_id"] ?? null) as JsonValue,
    action_json: canonicalJsonText(action as unknown as JsonValue),
    inputs_json: canonicalJsonText(inputs as unknown as JsonValue),
    diagnostics_json: canonicalJsonText(diagnostics as unknown as JsonValue),
    decided_at: now(),
    decision_hash: decisionHash
  };
  const journaled = await commit({
    event_type: "decision.recorded",
    entity_type: "decision_record",
    entity_id: decisionId,
    operation: "insert",
    binding,
    row_schema: "rsi.decision/1",
    row,
    before: null,
    apply: (tx) => {
      tx.prepare(
        `INSERT INTO decision_record (
           decision_id, task_id, branch_id, input_epoch, goal_version, config_version,
           watermark, policy_version, issue_id, action_kind, outcome, reason_code,
           dedupe_key, evidence_hash, pack_hash, request_hash, delivery_id, job_id,
           write_id, aggregate_id, action_json, inputs_json, diagnostics_json,
           decided_at, decision_hash
         ) VALUES (
           :decision_id, :task_id, :branch_id, :input_epoch, :goal_version, :config_version,
           :watermark, :policy_version, :issue_id, :action_kind, :outcome, :reason_code,
           :dedupe_key, :evidence_hash, :pack_hash, :request_hash, :delivery_id, :job_id,
           :write_id, :aggregate_id, :action_json, :inputs_json, :diagnostics_json,
           :decided_at, :decision_hash
         )`
      ).run(asSqlParams(row));
    }
  });
  if (!journaled.ok) return journaled;
  return ok({ decision_id: decisionId, created: true });
}

/* ------------------------------------------------------------------ */
/* Delivery create / enqueue                                          */
/* ------------------------------------------------------------------ */

export function deliveryFromRow(row: Row): DeliveryRecord | null {
  const requirementIds = parseJson(asNullableString(row, "requirement_ids_json"));
  if (!Array.isArray(requirementIds)) {
    return null;
  }
  return {
    schema_version: "rsi.delivery/2",
    task_id: asString(row, "task_id") as Id<"task">,
    branch_id: asString(row, "branch_id") as Id<"br">,
    input_epoch: asNumber(row, "input_epoch"),
    config_version: asString(row, "config_version"),
    goal_version: asString(row, "goal_version"),
    requirement_ids: requirementIds as Id<"req">[],
    issue_id: asNullableString(row, "issue_id") as Id<"issue"> | null,
    evidence_hash: asString(row, "evidence_hash") as Hash,
    pack_hash: asString(row, "pack_hash") as Hash,
    content_hash: asString(row, "content_hash") as Hash,
    content_ref: asString(row, "content_ref") as SourceRef,
    expires_at: asNumber(row, "expires_at"),
    delivery_id: asString(row, "delivery_id") as Id<"del">,
    dedupe_key: asString(row, "dedupe_key") as Hash,
    state: asString(row, "state") as DeliveryRecord["state"],
    terminal_reason: asNullableString(row, "terminal_reason") as DeliveryRecord["terminal_reason"],
    inclusion_evidence: asString(row, "inclusion_evidence") as DeliveryRecord["inclusion_evidence"],
    transport_body_verified: asNumber(row, "transport_body_verified") === 1,
    submission_ref: asNullableString(row, "submission_ref"),
    inclusion_ref: asNullableString(row, "inclusion_ref") as SourceRef | null,
    adoption: asString(row, "adoption") as DeliveryRecord["adoption"],
    adoption_ref: asNullableString(row, "adoption_ref") as SourceRef | null,
    row_version: asNumber(row, "row_version"),
    created_at: asNumber(row, "created_at"),
    updated_at: asNumber(row, "updated_at")
  };
}

export function deliveryRow(record: DeliveryRecord): Record<string, JsonValue> {
  return {
    delivery_id: record.delivery_id,
    task_id: record.task_id,
    branch_id: record.branch_id,
    input_epoch: record.input_epoch,
    goal_version: record.goal_version,
    config_version: record.config_version,
    watermark: 0,
    requirement_ids_json: canonicalJsonText(record.requirement_ids as unknown as JsonValue),
    issue_id: record.issue_id,
    dedupe_key: record.dedupe_key,
    pack_hash: record.pack_hash,
    evidence_hash: record.evidence_hash,
    content_hash: record.content_hash,
    content_ref: record.content_ref,
    state: record.state,
    inclusion_evidence: record.inclusion_evidence,
    transport_body_verified: record.transport_body_verified ? 1 : 0,
    submission_ref: record.submission_ref,
    inclusion_ref: record.inclusion_ref,
    adoption: record.adoption,
    adoption_ref: record.adoption_ref,
    terminal_reason: record.terminal_reason,
    expires_at: record.expires_at,
    row_version: record.row_version,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function insertDeliveryHistory(
  tx: Tx,
  record: DeliveryRecord,
  eventId: string,
  noteCode: string,
  at: number,
  evidenceRef: SourceRef | null
): void {
  tx.prepare(
    `INSERT INTO delivery_history (
       delivery_id, event_id, at, state, inclusion_evidence, adoption,
       evidence_ref, terminal_reason, note_code
     ) VALUES (
       :delivery_id, :event_id, :at, :state, :inclusion_evidence, :adoption,
       :evidence_ref, :terminal_reason, :note_code
     ) ON CONFLICT(delivery_id, event_id) DO NOTHING`
  ).run({
    delivery_id: record.delivery_id,
    event_id: eventId,
    at,
    state: record.state,
    inclusion_evidence: record.inclusion_evidence,
    adoption: record.adoption,
    evidence_ref: evidenceRef,
    terminal_reason: record.terminal_reason,
    note_code: noteCode
  });
}

function deliveryDedupeKey(plan: DeliveryPlan): Hash {
  return canonicalHash({
    task_id: plan.task_id,
    branch_id: plan.branch_id,
    requirement_ids: plan.requirement_ids,
    issue_id: plan.issue_id,
    goal_version: plan.goal_version,
    evidence_hash: plan.evidence_hash
  }) as Hash;
}

function findExistingDelivery(
  connection: SqliteConnection,
  plan: DeliveryPlan
): Result<DeliveryRecord | null, ErrorEnvelope> {
  const existingRow = oneRow<Row>(
    connection,
    "SELECT * FROM delivery WHERE dedupe_key = :dedupe_key AND evidence_hash = :evidence_hash",
    { dedupe_key: deliveryDedupeKey(plan), evidence_hash: plan.evidence_hash }
  );
  if (existingRow === null) return ok(null);
  const existing = deliveryFromRow(existingRow);
  if (existing === null) {
    return err(internalError("kernel.delivery_row_corrupt"));
  }
  return ok(existing);
}

function insertOutboxRow(
  tx: Tx,
  outbox: DeliveryOutboxEnqueue<"delivery.dispatch">,
  at: number
): void {
  tx.prepare(
    `INSERT INTO outbox (
       outbox_id, effect_kind, effect_key, payload_json, state, priority, attempts,
       max_attempts, next_attempt_at, lease_owner, lease_token, lease_expires_at,
       reconcile_required, last_error_code, result_ref, created_at, updated_at
     ) VALUES (
       :outbox_id, :effect_kind, :effect_key, :payload_json, 'pending', :priority, 0,
       :max_attempts, :next_attempt_at, NULL, NULL, NULL, 0, NULL, NULL, :created_at, :updated_at
     )`
  ).run({
    outbox_id: newId("ob", at),
    effect_kind: outbox.effect_kind,
    effect_key: outbox.effect_key,
    payload_json: canonicalJsonText(outbox.payload as unknown as JsonValue),
    priority: outbox.priority,
    max_attempts: outbox.max_attempts,
    next_attempt_at: at,
    created_at: at,
    updated_at: at
  });
}

function stagedOutboxConflict(rule: string): ErrorEnvelope {
  return fieldError("outbox.effect_key", rule, "E_IDEMPOTENCY_CONFLICT");
}

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

export function createDefaultDecisionDeliveryService(
  deps: DefaultDecisionDeliveryDeps
): DefaultDecisionDeliveryService {
  const { connection, blob_store, now, commit } = deps;

  async function create(input: {
    readonly plan: DeliveryPlan;
    readonly content: DeliveryContentCheck;
  }): Promise<Result<DeliveryCreateResult, ErrorEnvelope>> {
    const planResult = parseDeliveryPlan(input.plan);
    if (!planResult.ok) return planResult;
    const plan = planResult.value;
    const existingResult = findExistingDelivery(connection, plan);
    if (!existingResult.ok) return existingResult;
    // The caller's booleans describe the preparation boundary; the kernel
    // rechecks the actual CAS object immediately before both new creation and
    // dedupe acceptance. This closes the gap where a deleted blob could make a
    // previously matching delivery look safely replayable.
    const contentRef = parseSourceRef(plan.content_ref);
    const verified = contentRef.ok
      ? blob_store.verify(contentRef.value.locator as Hash)
      : { ok: false as const };
    const content: DeliveryContentCheck = {
      ...input.content,
      retrievable:
        input.content.retrievable && verified.ok && verified.value.present,
      hash_matches:
        input.content.hash_matches && verified.ok && verified.value.hash_matches
    };
    const created = createDelivery({
      plan,
      existing: existingResult.value,
      delivery_id: input.content.delivery_id ?? newId("del", now()),
      content,
      now_ms: now()
    });
    if (!created.ok) return created;
    if (created.value.dedupe_hit) {
      return ok({ delivery: created.value.delivery, dedupe_hit: true });
    }
    const delivery = created.value.delivery;
    const row = deliveryRow(delivery);
    const outbox = buildDeliveryCreateOutbox(delivery, false, 0, 3);
    if (!outbox.ok) return outbox;
    if (outbox.value === null) {
      return err(internalError("kernel.delivery_outbox_missing"));
    }
    const dispatchOutbox = outbox.value;
    const journaled = await commit({
      event_type: "delivery.recorded",
      entity_type: "delivery",
      entity_id: delivery.delivery_id,
      operation: "insert",
      binding: {
        task_id: delivery.task_id,
        branch_id: delivery.branch_id,
        input_epoch: delivery.input_epoch,
        goal_version: delivery.goal_version,
        config_version: delivery.config_version,
        watermark: 0
      },
      row_schema: "rsi.delivery_row/1",
      row,
      before: null,
      apply: (tx, _afterHash, eventId) => {
        tx.prepare(
          `INSERT INTO delivery (
             delivery_id, task_id, branch_id, input_epoch, goal_version, config_version,
             watermark, requirement_ids_json, issue_id, dedupe_key, pack_hash, evidence_hash,
             content_hash, content_ref, state, inclusion_evidence, transport_body_verified,
             submission_ref, inclusion_ref, adoption, adoption_ref, terminal_reason, expires_at,
             row_version, created_at, updated_at
           ) VALUES (
             :delivery_id, :task_id, :branch_id, :input_epoch, :goal_version, :config_version,
             :watermark, :requirement_ids_json, :issue_id, :dedupe_key, :pack_hash, :evidence_hash,
             :content_hash, :content_ref, :state, :inclusion_evidence, :transport_body_verified,
             :submission_ref, :inclusion_ref, :adoption, :adoption_ref, :terminal_reason, :expires_at,
             :row_version, :created_at, :updated_at
           )`
        ).run(asSqlParams(row));
        insertDeliveryHistory(tx, delivery, eventId, "created", now(), delivery.content_ref);
        insertOutboxRow(tx, dispatchOutbox, now());
      }
    });
    if (!journaled.ok) return journaled;
    return ok({ delivery, dedupe_hit: false });
  }

  async function createFromPlan(
    plan: DeliveryPlan
  ): Promise<Result<DeliveryCreateResult, ErrorEnvelope>> {
    const parsed = parseDeliveryPlan(plan);
    if (!parsed.ok) return parsed;
    const existing = findExistingDelivery(connection, parsed.value);
    if (!existing.ok) return existing;
    const parsedRef = parseSourceRef(parsed.value.content_ref);
    if (!parsedRef.ok) return parsedRef;
    const contentHash = parsedRef.value.locator as Hash;
    const verified = blob_store.verify(contentHash);
    const content: DeliveryContentCheck = {
      retrievable: verified.ok && verified.value.present,
      hash_matches: verified.ok && verified.value.hash_matches
    };
    return create({ plan: parsed.value, content });
  }

  async function enqueue(
    outbox: DeliveryOutboxEnqueue<"delivery.dispatch">
  ): Promise<Result<string, ErrorEnvelope>> {
    const row = oneRow<Row>(
      connection,
      "SELECT effect_kind, effect_key, payload_json FROM outbox WHERE effect_key = :effect_key",
      { effect_key: outbox.effect_key }
    );
    if (row === null) {
      return err(stagedOutboxConflict("not_staged_in_create_frame"));
    }
    if (asString(row, "effect_kind") !== outbox.effect_kind) {
      return err(stagedOutboxConflict("effect_kind_mismatch"));
    }
    const stagedPayload = asString(row, "payload_json");
    if (stagedPayload !== canonicalJsonText(outbox.payload as unknown as JsonValue)) {
      return err(stagedOutboxConflict("payload_mismatch"));
    }
    return ok(asString(row, "effect_key"));
  }

  const decision: DecisionRecordPort = {
    record: (draft: DecisionDraft) => recordDecision(connection, commit, now, draft)
  };

  return {
    decision,
    delivery: { create, enqueue, createFromPlan },
    handlers: {
      "decision.record": async (context) => {
        const record = requireRecord(context.params, "params");
        if (!record.ok) return record;
        return recordDecision(connection, commit, now, record.value["decision"]);
      },
      "delivery.create": async (context) => {
        const record = requireRecord(context.params, "params");
        if (!record.ok) return record;
        const planResult = parseDeliveryPlan(record.value["plan"]);
        if (!planResult.ok) return planResult;
        return createFromPlan(planResult.value);
      }
    }
  };
}
