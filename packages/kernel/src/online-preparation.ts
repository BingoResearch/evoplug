/**
 * Canonical preparation contracts for the online decision and delivery tail.
 *
 * This module owns only deterministic projections. Persistence remains behind
 * the existing decision and delivery ports. A missing or mismatched source is
 * returned as an evidence error; no synthetic hash or delivery is produced.
 */

import {
  canonicalHash,
  canonicalJsonText,
  compareUtf8,
  err,
  makeErrorEnvelope,
  newId,
  ok,
  sortUtf8,
  toJsonValue
} from "@evoplug/core";
import type {
  DecisionDraft,
  ErrorEnvelope,
  Hash,
  Id,
  Result,
  SourceRef,
  VersionBinding
} from "@evoplug/core";
import {
  buildDeliveryDispatchOutbox,
  type DeliveryContentCheck,
  type DeliveryOutboxEnqueue,
  type DeliveryPlan
} from "@evoplug/delivery";
import type { AnswerAggregateV2, EvidencePack } from "@evoplug/evidence";

import type { CommittedHostEvent, OnlineIssue } from "./online-pipeline.js";

export const DECISION_INPUTS_PROJECTION_VERSION = "rsi.decision_inputs_projection/1" as const;
export const DELIVERY_CONTENT_PROJECTION_VERSION = "rsi.delivery_content_projection/1" as const;

export interface DecisionInputsProjection {
  readonly schema_version: typeof DECISION_INPUTS_PROJECTION_VERSION;
  readonly axis: string;
  readonly binding: VersionBinding;
  readonly watermark: number;
  readonly input_epoch: number;
  readonly identity: string;
  readonly value: unknown;
  readonly source_refs: readonly SourceRef[];
}

export interface DecisionInputsPreparationInput {
  readonly event: CommittedHostEvent;
  readonly binding: VersionBinding;
  readonly issue: OnlineIssue;
  readonly aggregate: AnswerAggregateV2;
}

export interface DeliveryContentProjection {
  readonly schema_version: typeof DELIVERY_CONTENT_PROJECTION_VERSION;
  readonly binding: VersionBinding;
  readonly issue: {
    readonly issue_id: string;
    readonly issue_version: number;
    readonly requirement_ids: readonly string[];
  };
  readonly aggregate: {
    readonly aggregate_id: string;
    readonly aggregate_hash: Hash;
    readonly final_state: AnswerAggregateV2["final_state"];
    readonly final_basis: AnswerAggregateV2["final_basis"];
    readonly reason_codes: readonly string[];
  };
  readonly pack: {
    readonly pack_id: string;
    readonly pack_hash: Hash;
    readonly evidence_hash: Hash;
    readonly evidence_refs: readonly SourceRef[];
  };
  readonly created_at: number;
}

function evidenceError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_EVIDENCE_UNKNOWN",
    category: "source",
    message_key: "error.evidence.unknown",
    stage: "evidence_decision",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function sameBinding(left: VersionBinding, right: VersionBinding): boolean {
  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version &&
    left.watermark === right.watermark
  );
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isVersionBinding(value: unknown): value is VersionBinding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Record<string, unknown>;
  return (
    isNonEmptyText(binding["task_id"]) &&
    isNonEmptyText(binding["branch_id"]) &&
    isSafeCount(binding["input_epoch"]) &&
    isNonEmptyText(binding["goal_version"]) &&
    isNonEmptyText(binding["config_version"]) &&
    isSafeCount(binding["watermark"])
  );
}

function isPackBinding(value: unknown, binding: VersionBinding): boolean {
  if (typeof value !== "object" || value === null) return false;
  const pack = value as Record<string, unknown>;
  return (
    pack["task_id"] === binding.task_id &&
    pack["branch_id"] === binding.branch_id &&
    pack["input_epoch"] === binding.input_epoch &&
    pack["goal_version"] === binding.goal_version &&
    pack["config_version"] === binding.config_version &&
    pack["watermark"] === binding.watermark
  );
}

function hasPackBinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const pack = value as Record<string, unknown>;
  return (
    isNonEmptyText(pack["task_id"]) &&
    isNonEmptyText(pack["branch_id"]) &&
    isSafeCount(pack["input_epoch"]) &&
    isNonEmptyText(pack["goal_version"]) &&
    isNonEmptyText(pack["config_version"]) &&
    isSafeCount(pack["watermark"])
  );
}

function refs(values: readonly SourceRef[]): SourceRef[] {
  return [...new Set(values)].sort(compareUtf8);
}

function projection(input: {
  axis: string;
  binding: VersionBinding;
  identity: string;
  value: unknown;
  source_refs: readonly SourceRef[];
}): DecisionInputsProjection {
  return {
    schema_version: DECISION_INPUTS_PROJECTION_VERSION,
    axis: input.axis,
    binding: input.binding,
    watermark: input.binding.watermark,
    input_epoch: input.binding.input_epoch,
    identity: input.identity,
    value: input.value,
    source_refs: refs(input.source_refs)
  };
}

function axisHash(value: DecisionInputsProjection): Hash {
  return canonicalHash(toJsonValue(value));
}

/**
 * Freezes the seven decision axes from the committed binding and the accepted
 * aggregate. The aggregate is the only owner-approved joined read available at
 * this boundary, so its hashes are carried into the axis preimages explicitly.
 */
export function prepareDecisionInputs(
  input: DecisionInputsPreparationInput
): Result<DecisionDraft["inputs"], ErrorEnvelope> {
  if (
    input === undefined ||
    !isVersionBinding(input.event?.binding) ||
    !isVersionBinding(input.binding) ||
    input.issue === undefined ||
    !isVersionBinding(input.aggregate?.binding)
  ) {
    return err(evidenceError("DecisionDraft.inputs.requirement_snapshot_hash", "snapshot_preimage_undefined"));
  }
  const aggregateRecord = input.aggregate as unknown as Record<string, unknown>;
  const issueRecord = input.issue as unknown as Record<string, unknown>;
  const inputKeys = aggregateRecord["input_keys"];
  const backend = aggregateRecord["backend"];
  const missing = aggregateRecord["missing"];
  const validAggregate =
    isNonEmptyText(aggregateRecord["aggregate_id"]) &&
    isNonEmptyText(aggregateRecord["plan_id"]) &&
    isNonEmptyText(aggregateRecord["plan_hash"]) &&
    isNonEmptyText(aggregateRecord["aggregate_hash"]) &&
    isNonEmptyText(aggregateRecord["final_state"]) &&
    isNonEmptyText(aggregateRecord["final_basis"]) &&
    typeof aggregateRecord["coverage_complete"] === "boolean" &&
    isStringArray(aggregateRecord["reason_codes"]) &&
    isStringArray(aggregateRecord["evidence_refs"]) &&
    Array.isArray(missing) &&
    missing.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        isStringArray((entry as Record<string, unknown>)["source_refs"])
    ) &&
    typeof inputKeys === "object" &&
    inputKeys !== null &&
    isNonEmptyText((inputKeys as Record<string, unknown>)["pack_hash"]) &&
    isNonEmptyText((inputKeys as Record<string, unknown>)["shard_plan_key"]) &&
    isNonEmptyText((inputKeys as Record<string, unknown>)["hard_fact_snapshot_hash"]) &&
    isNonEmptyText((inputKeys as Record<string, unknown>)["hard_fact_view_hash"]) &&
    isNonEmptyText((inputKeys as Record<string, unknown>)["capability_key"]) &&
    isNonEmptyText((inputKeys as Record<string, unknown>)["capability_hash"]) &&
    isStringArray((inputKeys as Record<string, unknown>)["hard_fact_keys"]) &&
    isStringArray((inputKeys as Record<string, unknown>)["selected_envelope_keys"]) &&
    isStringArray((inputKeys as Record<string, unknown>)["omission_keys"]) &&
    typeof backend === "object" &&
    backend !== null &&
    isNonEmptyText((backend as Record<string, unknown>)["capability_key"]) &&
    isNonEmptyText((backend as Record<string, unknown>)["backend_key"]) &&
    isNonEmptyText(issueRecord["issue_id"]) &&
    isNonEmptyText(issueRecord["issue_key"]) &&
    isNonEmptyText(issueRecord["issue_type"]) &&
    isNonEmptyText(issueRecord["state"]) &&
    isSafeCount(issueRecord["issue_version"]) &&
    isStringArray(issueRecord["requirement_ids"]);
  if (!validAggregate) {
    return err(evidenceError("DecisionDraft.inputs.aggregate_shape", "aggregate_shape_invalid"));
  }
  if (!sameBinding(input.binding, input.event.binding)) {
    return err(evidenceError("DecisionDraft.inputs.binding", "cross_binding"));
  }
  if (!sameBinding(input.binding, input.aggregate.binding)) {
    return err(evidenceError("DecisionDraft.inputs.aggregate", "cross_binding"));
  }
  if (input.aggregate.issue_id !== input.issue.issue_id) {
    return err(evidenceError("DecisionDraft.inputs.issue_snapshot_hash", "issue_identity"));
  }
  if (input.aggregate.input_keys.pack_hash.length === 0 || input.aggregate.aggregate_hash.length === 0) {
    return err(evidenceError("DecisionDraft.inputs", "aggregate_hash_missing"));
  }

  const sourceRefs = refs([
    ...input.aggregate.evidence_refs,
    ...input.aggregate.missing.flatMap((missing) => missing.source_refs)
  ]);
  if (sourceRefs.some((ref) => ref.length === 0)) {
    return err(evidenceError("DecisionDraft.inputs.evidence_refs", "empty_source_ref"));
  }

  const binding = input.binding;
  const common = { binding, watermark: binding.watermark, input_epoch: binding.input_epoch };
  const requirement = projection({
    ...common,
    axis: "requirements",
    identity: input.issue.issue_id,
    value: { requirement_ids: sortUtf8(input.issue.requirement_ids, (value) => value), goal_version: binding.goal_version },
    source_refs: sourceRefs
  });
  const facts = projection({
    ...common,
    axis: "facts",
    identity: input.aggregate.aggregate_id,
    value: {
      hard_fact_snapshot_hash: input.aggregate.input_keys.hard_fact_snapshot_hash,
      hard_fact_view_hash: input.aggregate.input_keys.hard_fact_view_hash,
      hard_fact_keys: sortUtf8(input.aggregate.input_keys.hard_fact_keys, (value) => value)
    },
    source_refs: sourceRefs
  });
  const feedback = projection({
    ...common,
    axis: "feedback",
    identity: input.aggregate.aggregate_id,
    value: { selected_envelope_keys: sortUtf8(input.aggregate.input_keys.selected_envelope_keys, (value) => value) },
    source_refs: sourceRefs
  });
  const constraints = projection({
    ...common,
    axis: "constraints",
    identity: input.aggregate.plan_id,
    value: {
      plan_hash: input.aggregate.plan_hash,
      shard_plan_key: input.aggregate.input_keys.shard_plan_key,
      omission_keys: sortUtf8(input.aggregate.input_keys.omission_keys, (value) => value)
    },
    source_refs: sourceRefs
  });
  const outcome = projection({
    ...common,
    axis: "outcome",
    identity: input.aggregate.aggregate_id,
    value: {
      final_state: input.aggregate.final_state,
      final_basis: input.aggregate.final_basis,
      reason_codes: sortUtf8(input.aggregate.reason_codes, (value) => value),
      aggregate_hash: input.aggregate.aggregate_hash
    },
    source_refs: sourceRefs
  });
  const budget = projection({
    ...common,
    axis: "budget",
    identity: input.aggregate.plan_id,
    value: { coverage_complete: input.aggregate.coverage_complete, pack_hash: input.aggregate.input_keys.pack_hash },
    source_refs: sourceRefs
  });
  const capability = projection({
    ...common,
    axis: "capability",
    identity: input.aggregate.backend.capability_key,
    value: {
      capability_key: input.aggregate.input_keys.capability_key,
      capability_hash: input.aggregate.input_keys.capability_hash,
      backend_key: input.aggregate.backend.backend_key
    },
    source_refs: sourceRefs
  });
  const issue = projection({
    ...common,
    axis: "issue",
    identity: input.issue.issue_id,
    value: {
      issue_key: input.issue.issue_key,
      issue_type: input.issue.issue_type,
      issue_version: input.issue.issue_version,
      state: input.issue.state
    },
    source_refs: sourceRefs
  });

  return ok({
    requirement_snapshot_hash: axisHash(requirement),
    fact_snapshot_hash: axisHash(facts),
    feedback_snapshot_hash: axisHash(feedback),
    constraint_snapshot_hash: axisHash(constraints),
    outcome_current_hash: axisHash(outcome),
    budget_state_hash: axisHash(budget),
    capability_snapshot_hash: axisHash(capability),
    issue_snapshot_hash: axisHash(issue),
    evidence_refs: sourceRefs
  });
}

export function prepareDeliveryProjection(input: {
  readonly event: CommittedHostEvent;
  readonly issue: OnlineIssue;
  readonly aggregate: AnswerAggregateV2;
  readonly pack: EvidencePack;
  readonly now: number;
  readonly expires_at: number;
  readonly priority?: number;
  readonly max_attempts?: number;
}): Result<{
  readonly plan: DeliveryPlan;
  readonly content: DeliveryContentCheck;
  readonly outbox: DeliveryOutboxEnqueue<"delivery.dispatch">;
  readonly projection: DeliveryContentProjection;
  readonly content_bytes: Uint8Array;
}, ErrorEnvelope> {
  if (
    input === undefined ||
    input.event === undefined ||
    input.issue === undefined ||
    input.aggregate === undefined ||
    input.pack === undefined
  ) {
    return err(evidenceError("DeliveryPipelinePort.prepare", "input_undefined"));
  }
  if (!isVersionBinding(input.event.binding) || !isVersionBinding(input.aggregate.binding)) {
    return err(evidenceError("DeliveryPipelinePort.prepare.binding", "missing"));
  }
  if (!sameBinding(input.event.binding, input.aggregate.binding)) {
    return err(evidenceError("DeliveryPipelinePort.prepare.aggregate", "cross_binding"));
  }
  if (input.pack.pack_state !== "valid") {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack", input.pack.pack_state));
  }
  if (!hasPackBinding(input.pack)) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_binding", "missing"));
  }
  if (!isPackBinding(input.pack, input.event.binding)) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_binding", "cross_binding"));
  }
  const pack = input.pack as unknown as Record<string, unknown>;
  const aggregate = input.aggregate as unknown as Record<string, unknown>;
  const aggregateKeys = aggregate["input_keys"];
  if (!isStringArray(input.issue.requirement_ids)) {
    return err(evidenceError("DeliveryPipelinePort.prepare.issue", "requirements_missing"));
  }
  if (!isNonEmptyText(pack["issue_id"])) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_issue", "missing"));
  }
  if (pack["issue_id"] !== input.issue.issue_id) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_issue", "issue_identity"));
  }
  if (
    !isNonEmptyText(pack["plan_id"]) ||
    !isNonEmptyText(pack["plan_hash"]) ||
    !isNonEmptyText(aggregate["plan_id"]) ||
    !isNonEmptyText(aggregate["plan_hash"])
  ) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_plan", "missing"));
  }
  if (pack["plan_id"] !== aggregate["plan_id"] || pack["plan_hash"] !== aggregate["plan_hash"]) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_plan", "plan_identity"));
  }
  if (
    !isNonEmptyText(pack["pack_hash"]) ||
    !isNonEmptyText(pack["evidence_hash"]) ||
    typeof aggregateKeys !== "object" ||
    aggregateKeys === null ||
    !isNonEmptyText((aggregateKeys as Record<string, unknown>)["pack_hash"])
  ) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_hash", "missing"));
  }
  if (pack["pack_hash"] !== (aggregateKeys as Record<string, unknown>)["pack_hash"]) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_hash", "aggregate_mismatch"));
  }
  if (
    !isNonEmptyText(aggregate["aggregate_id"]) ||
    !isNonEmptyText(aggregate["aggregate_hash"]) ||
    !isNonEmptyText(aggregate["final_state"]) ||
    !isNonEmptyText(aggregate["final_basis"]) ||
    !isStringArray(aggregate["reason_codes"])
  ) {
    return err(evidenceError("DeliveryPipelinePort.prepare.aggregate_shape", "aggregate_shape_invalid"));
  }
  if (
    !Array.isArray(pack["requirements"]) ||
    !Array.isArray(pack["facts"]) ||
    pack["requirements"].some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        !isStringArray((entry as Record<string, unknown>)["source_refs"])
    ) ||
    pack["facts"].some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        !isStringArray((entry as Record<string, unknown>)["source_refs"])
    ) ||
    (pack["feedback"] !== undefined &&
      (typeof pack["feedback"] !== "object" ||
        pack["feedback"] === null ||
        !isStringArray((pack["feedback"] as Record<string, unknown>)["source_refs"])))
  ) {
    return err(evidenceError("DeliveryPipelinePort.prepare.pack_shape", "pack_shape_invalid"));
  }
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    !Number.isSafeInteger(input.expires_at) ||
    input.expires_at <= input.now
  ) {
    return err(evidenceError("DeliveryPipelinePort.prepare.expires_at", "invalid_expiry"));
  }
  const requirementIds = sortUtf8(input.issue.requirement_ids, (value) => value) as Id<"req">[];
  const evidenceRefs = refs([
    ...input.pack.requirements.flatMap((entry) => entry.source_refs),
    ...(input.pack.feedback?.source_refs ?? []),
    ...input.pack.facts.flatMap((entry) => entry.source_refs)
  ]);
  if (evidenceRefs.length === 0) {
    return err(evidenceError("DeliveryPipelinePort.prepare.evidence_refs", "missing"));
  }
  const projection: DeliveryContentProjection = {
    schema_version: DELIVERY_CONTENT_PROJECTION_VERSION,
    binding: input.event.binding,
    issue: {
      issue_id: input.issue.issue_id,
      issue_version: input.issue.issue_version,
      requirement_ids: requirementIds
    },
    aggregate: {
      aggregate_id: input.aggregate.aggregate_id,
      aggregate_hash: input.aggregate.aggregate_hash,
      final_state: input.aggregate.final_state,
      final_basis: input.aggregate.final_basis,
      reason_codes: sortUtf8(input.aggregate.reason_codes, (value) => value)
    },
    pack: {
      pack_id: input.pack.pack_id,
      pack_hash: input.pack.pack_hash,
      evidence_hash: input.pack.evidence_hash,
      evidence_refs: evidenceRefs
    },
    created_at: input.now
  };
  const contentJson = canonicalJsonText(toJsonValue(projection));
  const contentBytes = new TextEncoder().encode(contentJson);
  const contentHash = canonicalHash(toJsonValue(projection));
  const contentRef = `blob://${contentHash}#bytes=0-${contentBytes.byteLength}` as SourceRef;
  const plan: DeliveryPlan = {
    schema_version: "rsi.delivery_plan/1",
    task_id: input.event.binding.task_id as Id<"task">,
    branch_id: input.event.binding.branch_id as Id<"br">,
    input_epoch: input.event.binding.input_epoch,
    config_version: input.event.binding.config_version,
    goal_version: input.event.binding.goal_version,
    requirement_ids: requirementIds,
    issue_id: input.issue.issue_id as Id<"issue">,
    evidence_hash: input.pack.evidence_hash,
    pack_hash: input.pack.pack_hash,
    content_hash: contentHash,
    content_ref: contentRef,
    expires_at: input.expires_at
  };
  const deliveryId = newId("del", input.now);
  const outbox = buildDeliveryDispatchOutbox({
    delivery_id: deliveryId,
    submission_attempt: 1,
    priority: input.priority ?? 0,
    max_attempts: input.max_attempts ?? 3
  });
  if (!outbox.ok || outbox.value === null) {
    return err(outbox.ok ? evidenceError("DeliveryPipelinePort.prepare.outbox", "missing") : outbox.error);
  }
  return ok({
    plan,
    content: {
      retrievable: true,
      hash_matches: true,
      delivery_id: deliveryId,
      content_bytes: contentBytes
    },
    outbox: outbox.value,
    projection,
    content_bytes: contentBytes
  });
}
