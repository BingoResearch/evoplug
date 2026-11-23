/**
 * UsageVerificationRecord derivation (DD-REV-120).
 *
 * The caller supplies evidence and verifier bindings; loading state, verifier
 * kind/independence, attribution, result, window index and both hashes are
 * computed here.
 */

import type { Hash, Result, SourceRef, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ErrorEnvelope } from "@evoplug/core";

import { revError } from "./errors.js";
import { hasBehavioralLoadingEvidence } from "./experience.js";
import { usageEvidenceHash, usageKey } from "./storage.js";
import type {
  ExperienceProjection,
  LoadingIncludedState,
  LoadingStageState,
  UsageVerificationRecord,
  ValidationPlan
} from "./types.js";

interface UsageVerificationFacts {
  kind: ValidationPlan["verifier"]["kind"];
  independence: ValidationPlan["verifier"]["independence"];
  status: "passed" | "failed" | "not_available" | "not_applicable";
  verifier_ref: SourceRef | null;
  binding_ref: SourceRef;
  validation_plan_hash: Hash;
  version_binding: VersionBinding;
}

interface UsageDerivationInput {
  projection: ExperienceProjection;
  plan: ValidationPlan;
  version_binding: VersionBinding;
  task_family_id: string;
  trigger_result: "triggered" | "not_triggered" | "unknown";
  loading: {
    written: LoadingStageState;
    discovered: LoadingStageState;
    included: LoadingIncludedState;
    observed: "unknown" | "claimed" | "verified";
    evidence_refs: SourceRef[];
  };
  behavior_evidence_refs: SourceRef[];
  behavior_summary: string;
  verification: UsageVerificationFacts;
  outcome_ref: SourceRef | null;
  other_change_refs: SourceRef[];
  window_index: number;
  now: number;
}

type UsageAttribution = UsageVerificationRecord["attribution"];

export function deriveAttribution(input: {
  verification_status: UsageVerificationFacts["status"];
  replay_isolated: boolean;
  controlled_trial: boolean;
  overlapping_changes: boolean;
}): UsageAttribution {
  if (input.replay_isolated) {
    return "isolated_replay";
  }
  if (input.controlled_trial) {
    return "controlled_trial";
  }
  if (input.overlapping_changes) {
    return "confounded";
  }
  return "not_claimed";
}

type UsageResult = UsageVerificationRecord["result"];

export function classifyUsageResult(input: {
  trigger_result: UsageVerificationRecord["trigger_result"];
  verification: UsageVerificationFacts;
  plan: ValidationPlan;
  loading: UsageDerivationInput["loading"];
  attribution: UsageAttribution;
  observed_at: number;
  window_started_at: number;
  window_end_at: number;
  other_change_refs: readonly SourceRef[];
}): UsageResult {
  if (input.trigger_result === "not_triggered") {
    return "not_exercised";
  }
  if (
    input.verification.status === "failed" &&
    (input.attribution === "isolated_replay" || input.attribution === "controlled_trial")
  ) {
    return "negative_evidence";
  }
  if (
    input.verification.status === "passed" &&
    input.verification.independence === "independent" &&
    input.plan.retention_rule.required_verifier_kinds.includes(input.verification.kind) &&
    input.verification.validation_plan_hash === input.plan.plan_hash &&
    input.verification.binding_ref !== undefined &&
    hasBehavioralLoadingEvidence(input.loading) &&
    input.other_change_refs.length === 0 &&
    input.observed_at >= input.window_started_at &&
    input.observed_at < input.window_end_at
  ) {
    return "positive_evidence";
  }
  return "inconclusive";
}

export function windowIndexFor(
  projection: ExperienceProjection,
  existing: readonly UsageVerificationRecord[]
): number {
  const start = projection.retention.window_started_at;
  if (start === undefined) {
    return 0;
  }
  return existing.filter((usage) => usage.observed_at >= start).length;
}

export function computeUsageRecord(input: UsageDerivationInput): UsageVerificationRecord {
  const projection = input.projection;
  const windowStart = projection.retention.window_started_at ?? projection.checked_at;
  const windowEnd = projection.retention.window_end_at ?? Number.MAX_SAFE_INTEGER;
  const attribution = deriveAttribution({
    verification_status: input.verification.status,
    replay_isolated: input.verification.status === "failed" && input.other_change_refs.length === 0,
    controlled_trial: false,
    overlapping_changes: input.other_change_refs.length > 0
  });
  const evidenceHash = usageEvidenceHash({
    loading_evidence_refs: input.loading.evidence_refs,
    behavior_evidence_refs: input.behavior_evidence_refs,
    verification_binding_ref: input.verification.binding_ref,
    outcome_ref: input.outcome_ref,
    other_change_refs: input.other_change_refs
  });
  const key = usageKey({
    projection_id: projection.projection_id,
    version_binding: input.version_binding,
    experience_content_hash: projection.experience_content_hash,
    validation_plan_hash: projection.validation_plan_hash,
    task_family_id: input.task_family_id,
    window_index: input.window_index,
    evidence_hash: evidenceHash
  });
  const result = classifyUsageResult({
    trigger_result: input.trigger_result,
    verification: input.verification,
    plan: input.plan,
    loading: input.loading,
    attribution,
    observed_at: input.now,
    window_started_at: windowStart,
    window_end_at: windowEnd,
    other_change_refs: input.other_change_refs
  });
  const verification: UsageVerificationRecord["verification"] = {
    kind: input.verification.kind,
    independence: input.verification.independence,
    status: input.verification.status,
    binding_ref: input.verification.binding_ref,
    validation_plan_hash: input.verification.validation_plan_hash,
    version_binding: input.verification.version_binding
  };
  if (input.verification.verifier_ref !== null) {
    verification.verifier_ref = input.verification.verifier_ref;
  }
  const record: UsageVerificationRecord = {
    schema_version: "rsi.usage_verification/1",
    usage_id: "",
    usage_key: key,
    projection_id: projection.projection_id,
    experience_id: projection.experience_id,
    experience_version: projection.experience_version,
    experience_content_hash: projection.experience_content_hash,
    validation_plan_id: projection.validation_plan_id,
    validation_plan_hash: projection.validation_plan_hash,
    version_binding: input.version_binding,
    task_family_id: input.task_family_id,
    trigger_result: input.trigger_result,
    loading: {
      written: input.loading.written,
      discovered: input.loading.discovered,
      included: input.loading.included,
      observed: input.loading.observed,
      evidence_refs: [...input.loading.evidence_refs]
    },
    behavior: {
      evidence_refs: [...input.behavior_evidence_refs],
      summary: input.behavior_summary
    },
    verification,
    other_change_refs: [...input.other_change_refs],
    attribution,
    result,
    evidence_hash: evidenceHash,
    causal_supported: false,
    observed_at: input.now,
    window_index: input.window_index
  };
  if (input.outcome_ref !== null) {
    record.outcome_ref = input.outcome_ref;
  }
  return record;
}

export function validateUsageRecord(record: UsageVerificationRecord): Result<UsageVerificationRecord, ErrorEnvelope> {
  if (record.behavior.summary.length < 1 || record.behavior.summary.length > 2048) {
    return err(
      revError({
        code: "E_EXPERIENCE_SCHEMA",
        stage: "usage_record",
        details: { kind: "field", path: "behavior.summary", rule: "length_1_2048" }
      })
    );
  }
  if (record.version_binding.task_id !== record.verification.version_binding.task_id) {
    return err(
      revError({
        code: "E_VERSION_BINDING",
        stage: "usage_record",
        details: { kind: "version", expected: record.version_binding.task_id, actual: record.verification.version_binding.task_id }
      })
    );
  }
  if (record.version_binding.branch_id !== record.verification.version_binding.branch_id) {
    return err(
      revError({
        code: "E_VERSION_BINDING",
        stage: "usage_record",
        details: { kind: "version", expected: record.version_binding.branch_id, actual: record.verification.version_binding.branch_id }
      })
    );
  }
  const expectedEvidence = usageEvidenceHash({
    loading_evidence_refs: record.loading.evidence_refs,
    behavior_evidence_refs: record.behavior.evidence_refs,
    verification_binding_ref: record.verification.binding_ref,
    outcome_ref: record.outcome_ref ?? null,
    other_change_refs: record.other_change_refs
  });
  if (expectedEvidence !== record.evidence_hash) {
    return err(
      revError({
        code: "E_REBUILD_DIVERGENCE",
        stage: "usage_record",
        details: { kind: "field", path: "evidence_hash", rule: "recomputed" }
      })
    );
  }
  const expectedKey = usageKey({
    projection_id: record.projection_id,
    version_binding: record.version_binding,
    experience_content_hash: record.experience_content_hash,
    validation_plan_hash: record.validation_plan_hash,
    task_family_id: record.task_family_id,
    window_index: record.window_index,
    evidence_hash: record.evidence_hash
  });
  if (expectedKey !== record.usage_key) {
    return err(
      revError({
        code: "E_REBUILD_DIVERGENCE",
        stage: "usage_record",
        details: { kind: "field", path: "usage_key", rule: "recomputed" }
      })
    );
  }
  return ok(record);
}

export function duplicateUsagePayload(
  existing: UsageVerificationRecord,
  incoming: UsageVerificationRecord
): boolean {
  return existing.usage_key === incoming.usage_key && existing.evidence_hash === incoming.evidence_hash;
}
