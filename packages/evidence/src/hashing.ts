/**
 * Deterministic content keys for EVD (DD-EVD-004, DD-EVD-005).
 *
 * Every formula uses FND `canonicalHash` (RFC 8785 JCS); business arrays are
 * sorted by UTF-8 byte order before hashing, object keys are left to JCS.
 * Random row identifiers, timestamps and runtime watermarks never enter these
 * preimages.
 */

import { canonicalHash, compareUtf8, hashBytes, hashUtf8, sortUtf8 } from "@evoplug/core";
import type { Hash, JsonValue, SourceRef, VersionBinding } from "@evoplug/core";

import type {
  AggregateConflict,
  AggregateCoverage,
  AggregateInputKeys,
  AggregateMissing,
  AggregateMissingV2,
  AggregateStale,
  AggregateStaleV2,
  AnswerAggregate,
  AnswerAggregateV2,
  BudgetEstimate,
  DependencyUnit,
  DependencyUnitStateEvidence,
  HardFactReadView,
  HardFactUse,
  JudgeStateManifestEntry,
  MethodRef,
  NoulPropositionBinding,
  OptionalObservation,
  PropositionAggregate,
  QuestionBinding,
  SemanticBackendRef,
  RequirementAggregate,
  SemanticBackendCapability,
  SemanticBackendLimits,
  SemanticOutcome,
  SemanticScope,
  SemanticUsageObservation,
  Shard,
  TemplateBinding,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** UTF-8 byte length of a string. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Sorts strings by UTF-8 byte order. */
export function sortUtf8Strings(values: Iterable<string>): string[] {
  return sortUtf8([...values], (value) => value);
}

/** Sorts by a string key in UTF-8 byte order. */
export function sortByKey<T>(values: readonly T[], key: (value: T) => string): T[] {
  return sortUtf8(values, key);
}

/** `sha256(JCS(value))`. */
export function jcsHash(value: unknown): Hash {
  return canonicalHash(value as JsonValue);
}

/** JSON string representation used as an opaque hash input. */
export function jsonText(value: JsonValue): string {
  return JSON.stringify(value);
}

export function compareStrings(a: string, b: string): number {
  return compareUtf8(a, b);
}

function bindingContent(binding: VersionBinding): JsonValue {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
  };
}

/* ------------------------------------------------------------------ */
/* Source / fact identity                                              */
/* ------------------------------------------------------------------ */

export function factKey(input: {
  requirement_id: string;
  proposition_id?: string;
  effect: "supports" | "violates";
  artifact_version?: string;
  source_ids: string[];
  source_refs: SourceRef[];
  verifier_ref: SourceRef;
  verified: boolean;
}): Hash {
  return jcsHash({
    schema_version: "rsi.hard_fact_key/1",
    requirement_id: input.requirement_id,
    proposition_id: input.proposition_id ?? null,
    effect: input.effect,
    artifact_version: input.artifact_version ?? null,
    source_ids_utf8: sortUtf8Strings(input.source_ids),
    source_refs_utf8: sortUtf8Strings(input.source_refs),
    verifier_ref: input.verifier_ref,
    verified: input.verified,
  });
}

export function independenceKey(input: {
  source_ids: string[];
  verifier_ref: SourceRef;
}): Hash {
  return jcsHash({
    schema_version: "rsi.hard_fact_independence/1",
    source_ids_utf8: sortUtf8Strings(input.source_ids),
    verifier_ref: input.verifier_ref,
  });
}

export function hardFactViewHash(facts: readonly HardFactReadView[]): Hash {
  const projected = facts
    .map((fact) => ({
      fact_key: fact.fact_key,
      independence_key: fact.independence_key,
      requirement_id: fact.requirement_id,
      proposition_id: fact.proposition_id ?? null,
      effect: fact.effect,
      verified: fact.verified,
      artifact_version: fact.artifact_version ?? null,
      verifier_ref: fact.verifier_ref,
      source_ids_utf8: sortUtf8Strings(fact.source_ids),
      source_refs_utf8: sortUtf8Strings(fact.source_refs),
    }))
    .sort((a, b) => compareStrings(a.fact_key, b.fact_key));
  return jcsHash({
    schema_version: "rsi.hard_fact_view_hash/1",
    facts: projected,
  });
}

/* ------------------------------------------------------------------ */
/* Coverage / comparison views                                         */
/* ------------------------------------------------------------------ */

export function coverageSnapshotId(input: {
  binding: VersionBinding;
  watermark: number;
  checked_requirement_ids: string[];
  searched_sources: string[];
  missing: JsonValue;
  source_set_hash: Hash;
}): string {
  const hash = jcsHash({
    schema_version: "rsi.coverage_snapshot_id/1",
    binding: input.binding,
    watermark: input.watermark,
    scope: "ledger_scan/1",
    checked_requirement_ids: sortUtf8Strings(input.checked_requirement_ids),
    searched_sources: sortUtf8Strings(input.searched_sources),
    missing: input.missing,
    source_set_hash: input.source_set_hash,
  });
  return `coverage:${hash.slice("sha256:".length)}`;
}

export function coverageViewKey(input: {
  snapshot_id: string;
  checked_requirement_ids: string[];
  searched_sources: string[];
  missing_codes: string[];
  source_refs: SourceRef[];
}): Hash {
  return jcsHash({
    schema_version: "rsi.coverage_view/1",
    snapshot_id: input.snapshot_id,
    scope: "ledger_scan/1",
    checked_requirement_ids: sortUtf8Strings(input.checked_requirement_ids),
    searched_sources: sortUtf8Strings(input.searched_sources),
    missing_codes: sortUtf8Strings([...new Set(input.missing_codes)]),
    source_refs_utf8: sortUtf8Strings(input.source_refs),
  });
}

export function comparisonViewKey(input: {
  comparability_key: Hash;
  before_watermark: number;
  after_watermark: number;
  baseline_evidence_digest: Hash;
  current_evidence_digest: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.comparison_view/1",
    comparability_key: input.comparability_key,
    before_watermark: input.before_watermark,
    after_watermark: input.after_watermark,
    baseline_evidence_digest: input.baseline_evidence_digest,
    current_evidence_digest: input.current_evidence_digest,
  });
}

/* ------------------------------------------------------------------ */
/* Pack                                                                */
/* ------------------------------------------------------------------ */

export interface EvidenceHashInput {
  plan_hash: Hash;
  question_keys: string[];
  issue_key: string;
  issue_question: string;
  issue_requirement_ids: string[];
  issue_type: string;
  requirements: Array<{
    id: string;
    quote: string;
    source_refs: SourceRef[];
    source_id: string;
  }>;
  feedback: { quote: string; source_refs: SourceRef[]; source_id: string } | null;
  facts: Array<{
    id: string;
    source_id: string;
    kind: string;
    role: string;
    excerpt: string;
    content_hash: Hash;
    source_refs: SourceRef[];
    version?: string;
  }>;
  coverage: {
    checked_requirement_ids: string[];
    searched_sources: string[];
    omitted_refs: string[];
    missing: Array<{
      source_refs?: SourceRef[];
      source_id?: string;
      reason: string;
      affects_question_keys: string[];
      recoverable: boolean;
    }>;
  };
}

export function evidencePackEvidenceHash(input: EvidenceHashInput): Hash {
  const requirements = input.requirements
    .map((row) => ({
      id: row.id,
      quote: row.quote,
      source_refs_utf8: sortUtf8Strings(row.source_refs),
      source_id: row.source_id,
    }))
    .sort((a, b) => {
      const byId = compareStrings(a.id, b.id);
      if (byId !== 0) {
        return byId;
      }
      return compareStrings(jsonText(a.source_refs_utf8), jsonText(b.source_refs_utf8));
    });
  const facts = input.facts
    .map((row) => ({
      id: row.id,
      source_id: row.source_id,
      kind: row.kind,
      role: row.role,
      excerpt: row.excerpt,
      content_hash: row.content_hash,
      source_refs_utf8: sortUtf8Strings(row.source_refs),
      version: row.version ?? null,
    }))
    .sort((a, b) => {
      const byRefs = compareStrings(jsonText(a.source_refs_utf8), jsonText(b.source_refs_utf8));
      if (byRefs !== 0) {
        return byRefs;
      }
      return compareStrings(a.id, b.id);
    });
  const missing = input.coverage.missing
    .map((entry) => ({
      source_refs_utf8: sortUtf8Strings(entry.source_refs ?? []),
      source_id: entry.source_id ?? null,
      reason: entry.reason,
      affects_question_keys_utf8: sortUtf8Strings(entry.affects_question_keys),
      recoverable: entry.recoverable,
    }))
    .sort((a, b) => {
      const byId = compareStrings(a.source_id ?? "", b.source_id ?? "");
      if (byId !== 0) {
        return byId;
      }
      const byRefs = compareStrings(jsonText(a.source_refs_utf8), jsonText(b.source_refs_utf8));
      if (byRefs !== 0) {
        return byRefs;
      }
      return compareStrings(a.reason, b.reason);
    });
  return jcsHash({
    schema_version: "rsi.evidence_pack_evidence/2",
    plan_hash: input.plan_hash,
    question_keys_utf8: sortUtf8Strings(input.question_keys),
    issue: {
      issue_key: input.issue_key,
      question: input.issue_question,
      requirement_ids_utf8: sortUtf8Strings(input.issue_requirement_ids),
      issue_type: input.issue_type,
    },
    requirements,
    feedback:
      input.feedback === null
        ? null
        : {
            quote: input.feedback.quote,
            source_refs_utf8: sortUtf8Strings(input.feedback.source_refs),
            source_id: input.feedback.source_id,
          },
    facts,
    coverage: {
      checked_requirement_ids_utf8: sortUtf8Strings(input.coverage.checked_requirement_ids),
      searched_sources_utf8: sortUtf8Strings(input.coverage.searched_sources),
      omitted_refs_utf8: sortUtf8Strings(input.coverage.omitted_refs),
      missing,
    },
  });
}

export function evidencePackHash(input: {
  plan_hash: Hash;
  question_keys: string[];
  compiler_version: string;
  counting_method_version: string;
  source_manifest_version: string;
  issue_key: string;
  binding: VersionBinding;
  evidence_hash: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.evidence_pack/2",
    plan_hash: input.plan_hash,
    question_keys_utf8: sortUtf8Strings(input.question_keys),
    compiler_version: input.compiler_version,
    counting_method_version: input.counting_method_version,
    source_manifest_version: input.source_manifest_version,
    issue_key: input.issue_key,
    binding: {
      task_id: input.binding.task_id,
      branch_id: input.binding.branch_id,
      input_epoch: input.binding.input_epoch,
      goal_version: input.binding.goal_version,
      config_version: input.binding.config_version,
      watermark: input.binding.watermark,
    },
    evidence_hash: input.evidence_hash,
  });
}

export function evidencePackKey(input: {
  pack_hash: Hash;
  plan_hash: Hash;
  question_keys: string[];
  source_manifest_version: string;
  compiler_version: string;
  counting_method_version: string;
}): Hash {
  return jcsHash({
    schema_version: "rsi.evidence_pack_key/2",
    pack_hash: input.pack_hash,
    plan_hash: input.plan_hash,
    question_keys_utf8: sortUtf8Strings(input.question_keys),
    source_manifest_version: input.source_manifest_version,
    compiler_version: input.compiler_version,
    counting_method_version: input.counting_method_version,
  });
}

/* ------------------------------------------------------------------ */
/* Dependency unit                                                     */
/* ------------------------------------------------------------------ */

export function dependencyUnitKey(input: {
  plan_hash: Hash;
  dependency_key: string;
  inseparable_group_key: string;
  role: string;
  transport_role: DependencyUnit["transport_role"];
  source_ids: string[];
  source_refs: SourceRef[];
  artifact_version?: string;
  omission_impact: "answer_changing" | "none";
  can_omit: boolean;
  derived_view_key?: string;
}): Hash {
  return jcsHash({
    schema_version: "rsi.dependency_unit/1",
    plan_hash: input.plan_hash,
    dependency_key: input.dependency_key,
    inseparable_group_key: input.inseparable_group_key,
    role: input.role,
    transport_role: input.transport_role,
    source_ids_utf8: sortUtf8Strings(input.source_ids),
    source_refs_utf8: sortUtf8Strings(input.source_refs),
    artifact_version: input.artifact_version ?? null,
    omission_impact: input.omission_impact,
    can_omit: input.can_omit,
    derived_view_key: input.derived_view_key ?? null,
  });
}

export function stateEvidenceHash(entries: readonly DependencyUnitStateEvidence[]): Hash {
  const projected = [...entries]
    .map((entry) => ({
      logical_id: entry.logical_id,
      source_ids_utf8: sortUtf8Strings(entry.source_ids),
      source_refs_utf8: sortUtf8Strings(entry.source_refs),
      content_hash: entry.content_hash,
      text_hash: entry.text_hash,
      excerpt_hash: entry.excerpt_hash,
      artifact_version: entry.artifact_version ?? null,
    }))
    .sort((a, b) => compareStrings(a.logical_id, b.logical_id));
  return jcsHash(projected);
}

export function dependencyUnitHash(input: {
  unit_key: Hash;
  state_evidence: readonly DependencyUnitStateEvidence[];
  estimated_tokens: number;
}): Hash {
  return jcsHash({
    schema_version: "rsi.dependency_unit_hash/1",
    unit_key: input.unit_key,
    state_evidence_hash: stateEvidenceHash(input.state_evidence),
    estimated_tokens: input.estimated_tokens,
  });
}

/* ------------------------------------------------------------------ */
/* Omission                                                            */
/* ------------------------------------------------------------------ */

export interface OmissionKeyInput {
  plan_hash: Hash;
  unit_keys: readonly string[];
  question_keys: readonly string[];
  source_ids: readonly string[];
  source_refs: readonly SourceRef[];
  plan_omission_impact: "answer_changing" | "none";
  can_omit: boolean;
  required_for_issue: boolean;
  reason: string;
  impact: "none" | "may_change_answer" | "blocking";
}

export function omissionKey(input: OmissionKeyInput): Hash {
  return jcsHash({
    schema_version: "rsi.evidence_omission_key/1",
    plan_hash: input.plan_hash,
    unit_keys_utf8: sortUtf8Strings(input.unit_keys),
    question_keys_utf8: sortUtf8Strings(input.question_keys),
    source_ids_utf8: sortUtf8Strings(input.source_ids),
    source_refs_utf8: sortUtf8Strings(input.source_refs),
    plan_omission_impact: input.plan_omission_impact,
    can_omit: input.can_omit,
    required_for_issue: input.required_for_issue,
    reason: input.reason,
    impact: input.impact,
  });
}

/* ------------------------------------------------------------------ */
/* Shard / shard plan                                                  */
/* ------------------------------------------------------------------ */

export function shardKey(input: {
  plan_hash: Hash;
  pack_key: Hash;
  required_question_keys: string[];
  optional_question_keys: string[];
  unit_keys: string[];
  service_profile_key: Hash;
  limits_hash: Hash;
  omission_keys: string[];
  counting_method_version: string;
  compiler_version: string;
}): Hash {
  return jcsHash({
    schema_version: "rsi.shard/1",
    plan_hash: input.plan_hash,
    pack_key: input.pack_key,
    required_question_keys_utf8: sortUtf8Strings(input.required_question_keys),
    optional_question_keys_utf8: sortUtf8Strings(input.optional_question_keys),
    unit_keys_utf8: sortUtf8Strings(input.unit_keys),
    service_profile_key: input.service_profile_key,
    limits_hash: input.limits_hash,
    omission_keys_utf8: sortUtf8Strings(input.omission_keys),
    counting_method_version: input.counting_method_version,
    compiler_version: input.compiler_version,
  });
}

export function shardPlanKey(input: {
  plan_hash: Hash;
  pack_key: Hash;
  service_profile_key: Hash;
  limits_hash: Hash;
  shard_keys: string[];
  shard_plan_policy_version: string;
  compiler_version: string;
  counting_method_version: string;
}): Hash {
  return jcsHash({
    schema_version: "rsi.shard_plan/1",
    plan_hash: input.plan_hash,
    pack_key: input.pack_key,
    service_profile_key: input.service_profile_key,
    limits_hash: input.limits_hash,
    shard_keys_utf8: sortUtf8Strings(input.shard_keys),
    shard_plan_policy_version: input.shard_plan_policy_version,
    compiler_version: input.compiler_version,
    counting_method_version: input.counting_method_version,
  });
}

export function shardPlanHash(input: {
  shard_plan_key: Hash;
  plan_hash: Hash;
  pack_key: Hash;
  shard_plan_policy_version: string;
  compiler_version: string;
  counting_method_version: string;
  shard_keys: string[];
  omission_keys: string[];
}): Hash {
  return jcsHash({
    schema_version: "rsi.shard_plan_hash/1",
    shard_plan_key: input.shard_plan_key,
    plan_hash: input.plan_hash,
    pack_key: input.pack_key,
    shard_plan_policy_version: input.shard_plan_policy_version,
    compiler_version: input.compiler_version,
    counting_method_version: input.counting_method_version,
    shard_keys_utf8: sortUtf8Strings(input.shard_keys),
    omission_keys_utf8: sortUtf8Strings(input.omission_keys),
  });
}

/* ------------------------------------------------------------------ */
/* Budget estimate                                                     */
/* ------------------------------------------------------------------ */

interface QuestionNumber {
  question_key: string;
  tokens: number;
}

function sortedQuestionNumbers(record: Record<string, number>): Array<{ question_key: string; tokens: number }> {
  const entries: QuestionNumber[] = Object.keys(record).map((question_key) => ({
    question_key,
    tokens: record[question_key] ?? 0,
  }));
  return sortByKey(entries, (entry) => entry.question_key);
}

export function budgetEstimateKey(input: {
  shard_key: Hash;
  service_profile_key: Hash;
  limits_hash: Hash;
  counting_method_version: string;
  frame_req: number;
  state_tokens: number;
  question_tokens: Record<string, number>;
  reserves: {
    per_question_output: Record<string, number>;
    per_question_margin: Record<string, number>;
  };
  checks: Array<{ question_key: string; total: number; ok: boolean }>;
  verdict: BudgetEstimate["verdict"];
  limiting_question_key: string | null;
}): Hash {
  const questionTokens = sortedQuestionNumbers(input.question_tokens);
  const reserves = sortByKey(
    Object.keys(input.question_tokens).map((question_key) => ({
      question_key,
      output: input.reserves.per_question_output[question_key] ?? 0,
      margin: input.reserves.per_question_margin[question_key] ?? 0,
    })),
    (entry) => entry.question_key
  );
  const checks = sortByKey(input.checks, (entry) => entry.question_key);
  return jcsHash({
    schema_version: "rsi.budget_estimate_key/1",
    shard_key: input.shard_key,
    service_profile_key: input.service_profile_key,
    limits_hash: input.limits_hash,
    counting_method_version: input.counting_method_version,
    frame_req: input.frame_req,
    state_tokens: input.state_tokens,
    question_tokens_utf8: questionTokens,
    reserves_utf8: reserves,
    checks_utf8: checks,
    verdict: input.verdict,
    limiting_question_key: input.limiting_question_key,
  });
}

export function budgetEstimateHash(estimate: Omit<BudgetEstimate, "estimate_hash">): Hash {
  const framePerQuestion = sortedQuestionNumbers(estimate.frame_tokens.per_question);
  const questionTokens = sortedQuestionNumbers(estimate.question_tokens);
  const reservesOutput = sortedQuestionNumbers(estimate.reserves.per_question_output);
  const reservesMargin = sortedQuestionNumbers(estimate.reserves.per_question_margin);
  const checks = sortByKey(estimate.checks.per_question, (entry) => entry.question_key);
  return jcsHash({
    schema_version: "rsi.budget_estimate/1",
    estimate_key: estimate.estimate_key,
    shard_key: estimate.shard_key,
    service_profile_key: estimate.service_profile_key,
    counting_method_version: estimate.counting_method_version,
    estimator: estimate.estimator,
    limits: {
      request_max_tokens: estimate.limits.request_max_tokens,
      question_max_tokens: estimate.limits.question_max_tokens,
      source: estimate.limits.source,
      source_refs_utf8: sortUtf8Strings(estimate.limits.source_refs),
      limits_hash: estimate.limits.limits_hash,
    },
    frame_tokens: {
      request: estimate.frame_tokens.request,
      per_question_utf8: framePerQuestion,
    },
    state_tokens: estimate.state_tokens,
    question_tokens_utf8: questionTokens,
    reserves: {
      request_output: estimate.reserves.request_output,
      per_question_utf8: reservesOutput,
      request_margin: estimate.reserves.request_margin,
      per_question_margin_utf8: reservesMargin,
    },
    checks: {
      request_total: estimate.checks.request_total,
      request_ok: estimate.checks.request_ok,
      per_question: checks,
    },
    verdict: estimate.verdict,
    limiting_question_key: estimate.limiting_question_key ?? null,
    headroom_tokens: estimate.headroom_tokens ?? null,
  });
}

export function semanticBudgetEstimateKey(input: {
  shard_key: Hash;
  capability_key: Hash;
  capability_hash: Hash;
  limits_hash: Hash;
  counts: JsonValue;
  checks: JsonValue;
  verdict: string;
  limiting_field: string | null;
}): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_budget_estimate_key/1",
    shard_key: input.shard_key,
    capability_key: input.capability_key,
    capability_hash: input.capability_hash,
    limits_hash: input.limits_hash,
    counts: input.counts,
    checks: input.checks,
    verdict: input.verdict,
    limiting_field: input.limiting_field,
  });
}

/* ------------------------------------------------------------------ */
/* Judge state manifest                                                */
/* ------------------------------------------------------------------ */

export function manifestEntryProjection(entry: JudgeStateManifestEntry): JsonValue {
  return {
    display_ordinal: entry.display_ordinal,
    display_id: entry.display_id,
    logical_id: entry.logical_id,
    source_ids_utf8: sortUtf8Strings(entry.source_ids),
    source_refs_utf8: sortUtf8Strings(entry.source_refs),
    role: entry.role,
    text_hash: entry.text_hash,
    content_hash: entry.content_hash,
    excerpt_bytes: entry.excerpt_bytes,
    requirement_ids_utf8: sortUtf8Strings(entry.requirement_ids),
    artifact_version: entry.artifact_version ?? null,
  };
}

export function manifestEntriesProjection(
  entries: readonly JudgeStateManifestEntry[]
): JsonValue[] {
  return [...entries]
    .sort((a, b) => a.display_ordinal - b.display_ordinal)
    .map((entry) => manifestEntryProjection(entry));
}

export function manifestKey(input: {
  state_hash: Hash;
  state_content_hash: Hash;
  shard_key: Hash;
  pack_key: Hash;
  plan_hash: Hash;
  entries: readonly JudgeStateManifestEntry[];
}): Hash {
  return jcsHash({
    schema_version: "rsi.judge_state_manifest_key/1",
    state_hash: input.state_hash,
    state_content_hash: input.state_content_hash,
    shard_key: input.shard_key,
    pack_key: input.pack_key,
    plan_hash: input.plan_hash,
    entries: manifestEntriesProjection(input.entries),
  });
}

export function manifestHash(input: {
  manifest_key: Hash;
  state_hash: Hash;
  state_content_hash: Hash;
  shard_key: Hash;
  pack_key: Hash;
  plan_hash: Hash;
  entries: readonly JudgeStateManifestEntry[];
  wire_removed_fields: string[];
}): Hash {
  return jcsHash({
    schema_version: "rsi.judge_state_manifest/1",
    manifest_key: input.manifest_key,
    state_hash: input.state_hash,
    state_content_hash: input.state_content_hash,
    shard_key: input.shard_key,
    pack_key: input.pack_key,
    plan_hash: input.plan_hash,
    entries: manifestEntriesProjection(input.entries),
    wire_removed_fields_utf8: sortUtf8Strings(input.wire_removed_fields),
  });
}

/* ------------------------------------------------------------------ */
/* Service profile / capability / validator                            */
/* ------------------------------------------------------------------ */

export function jevLimitsHash(limits: {
  request_max_tokens: number | null;
  question_max_tokens: number | null;
  source: string;
  source_refs: SourceRef[];
}): Hash {
  return jcsHash({
    schema_version: "rsi.jev_limits/1",
    request_max_tokens: limits.request_max_tokens,
    question_max_tokens: limits.question_max_tokens,
    source: limits.source,
    source_refs_utf8: sortUtf8Strings(limits.source_refs),
  });
}

export function jevProfileKey(input: {
  provider: string;
  base_url: string;
  route: string;
  endpoint_contract_version: string;
  requested_model: string;
  expected_returned_model: string;
  model_kind: string;
  response_schema_version: string;
  limits_hash: Hash;
  long_context: { supported: string; enabled: boolean; source_refs: SourceRef[] };
  official_precision_policy: string;
  precision_contract: string;
}): Hash {
  return jcsHash({
    schema_version: "rsi.jev_service_profile/1",
    provider: input.provider,
    base_url: input.base_url,
    route: input.route,
    endpoint_contract_version: input.endpoint_contract_version,
    requested_model: input.requested_model,
    expected_returned_model: input.expected_returned_model,
    model_kind: input.model_kind,
    response_schema_version: input.response_schema_version,
    limits_hash: input.limits_hash,
    long_context: {
      supported: input.long_context.supported,
      enabled: input.long_context.enabled,
      source_refs_utf8: sortUtf8Strings(input.long_context.source_refs),
    },
    official_precision_policy: input.official_precision_policy,
    precision_contract: input.precision_contract,
  });
}

export function jevServiceStateKey(profile_key: Hash): Hash {
  return jcsHash({
    schema_version: "rsi.jev_service_state/1",
    profile_key,
  });
}

export function semanticScopeKey(scope: SemanticScope): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_scope/1",
    question_classes_utf8: sortUtf8Strings(scope.question_classes),
    issue_types_utf8: sortUtf8Strings(scope.issue_types),
    state_profiles_utf8: sortUtf8Strings(scope.state_profiles),
    evidence_kinds_utf8: sortUtf8Strings(scope.evidence_kinds),
  });
}

export function semanticLimitsHash(
  limits: Omit<SemanticBackendLimits, "schema_version" | "limits_hash">
): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_backend_limits/1",
    state_supported: limits.state_supported,
    max_questions: limits.max_questions,
    max_evidence_items: limits.max_evidence_items,
    max_state_bytes: limits.max_state_bytes,
    max_request_bytes: limits.max_request_bytes,
    max_response_bytes: limits.max_response_bytes,
  });
}

export function semanticBackendKey(input: {
  backend_kind: string;
  implementation_id: string;
  implementation_version: string;
  method: MethodRef;
  scope_key: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_backend_key/1",
    backend_kind: input.backend_kind,
    implementation_id: input.implementation_id,
    implementation_version: input.implementation_version,
    method_id: input.method.method_id,
    method_version: input.method.method_version,
    rule_version: input.method.rule_version,
    scope_key: input.scope_key,
  });
}

function competenceProjection(
  capacity: SemanticBackendCapability
): JsonValue[] {
  return sortByKey(
    capacity.semantic_competence.map((entry) => ({
      question_class: entry.question_class,
      status: entry.status,
      calibration_ref: entry.calibration_ref,
    })),
    (entry) => entry.question_class
  );
}

export function semanticCapabilityKey(capacity: SemanticBackendCapability): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_backend_capability_key/1",
    backend_key: capacity.backend_key,
    method: {
      method_id: capacity.method.method_id,
      method_version: capacity.method.method_version,
      rule_version: capacity.method.rule_version,
    },
    scope_key: semanticScopeKey(capacity.scope),
    output_contracts: capacity.output_contracts,
    transport_status: capacity.transport_status,
    semantic_competence: competenceProjection(capacity),
    limits_hash: capacity.limits.limits_hash,
  });
}

export function semanticCapabilityHash(capacity: SemanticBackendCapability): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_backend_capability/1",
    capability_key: capacity.capability_key,
    backend_key: capacity.backend_key,
    backend_kind: capacity.backend_kind,
    implementation_id: capacity.implementation_id,
    implementation_version: capacity.implementation_version,
    method: {
      method_id: capacity.method.method_id,
      method_version: capacity.method.method_version,
      rule_version: capacity.method.rule_version,
    },
    scope: {
      question_classes_utf8: sortUtf8Strings(capacity.scope.question_classes),
      issue_types_utf8: sortUtf8Strings(capacity.scope.issue_types),
      state_profiles_utf8: sortUtf8Strings(capacity.scope.state_profiles),
      evidence_kinds_utf8: sortUtf8Strings(capacity.scope.evidence_kinds),
    },
    output_contracts: capacity.output_contracts,
    transport_status: capacity.transport_status,
    semantic_competence: competenceProjection(capacity),
    limits: {
      state_supported: capacity.limits.state_supported,
      max_questions: capacity.limits.max_questions,
      max_evidence_items: capacity.limits.max_evidence_items,
      max_state_bytes: capacity.limits.max_state_bytes,
      max_request_bytes: capacity.limits.max_request_bytes,
      max_response_bytes: capacity.limits.max_response_bytes,
      limits_hash: capacity.limits.limits_hash,
    },
    source_refs_utf8: sortUtf8Strings(capacity.source_refs),
  });
}

export function jevValidatorPolicyHash(): Hash {
  return jcsHash({
    schema_version: "rsi.judge.validator_policy_hash/1",
    policy_version: "rsi.judge.validator/1",
    choice_options_min: 2,
    choice_options_max: 255,
    score_levels_min: 2,
    score_levels_max: 10,
    probability_sum_tolerance: 1e-6,
    confidence_tolerance: 1e-6,
    unknown_option_key: "unknown",
    partial_batch: "reject_all",
    alias_policy: "shadow_only",
  });
}

export function jevValidatorBindingKey(input: {
  validator_policy_hash: Hash;
  service_profile_key: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.judge.validator_binding/1",
    validator_policy_hash: input.validator_policy_hash,
    service_profile_key: input.service_profile_key,
    response_schema_version: "rsi.judge_wire/1",
    tolerance_policy: "local_fixed",
    probability_sum_tolerance: 1e-6,
    confidence_tolerance: 1e-6,
    partial_batch: "reject_all",
  });
}

export function semanticContractHash(): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_output_contract/1",
    request_schema_version: "rsi.semantic_backend_request/1",
    result_schema_version: "rsi.semantic_backend_result/1",
    output_contract: "categorical_option/1",
    effect_source: "qp_option_effects",
    evidence_source: "frozen_manifest_only",
    counterevidence_rule: "contradicts_requires_counterevidence",
    unknown_rule: "null_option_key",
    batch_atomicity: "reject_all",
    forbidden_outputs: [
      "probability",
      "confidence",
      "free_text",
      "hard_effect",
      "grant",
      "option_effect",
    ],
  });
}

export function semanticPolicyHash(): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_validator_policy/1",
    policy_version: "rsi.semantic.validator/1",
    question_set_exact: true,
    batch_atomicity: "reject_all",
    evidence_refs_subset_manifest: true,
    counterevidence_required_on_contradict: true,
    null_option_is_unknown: true,
    forbidden_outputs_utf8: sortUtf8Strings([
      "probability",
      "confidence",
      "free_text",
      "hard_effect",
      "grant",
      "option_effect",
    ]),
  });
}

export function semanticValidatorBindingKey(input: {
  backend_key: Hash;
  capability_key: Hash;
  capability_hash: Hash;
  policy_hash: Hash;
  contract_hash: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_validator_binding/1",
    backend_key: input.backend_key,
    capability_key: input.capability_key,
    capability_hash: input.capability_hash,
    output_contract: "categorical_option/1",
    policy_hash: input.policy_hash,
    contract_hash: input.contract_hash,
  });
}

/* ------------------------------------------------------------------ */
/* Judge request binding                                               */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Semantic request sets                                               */
/* ------------------------------------------------------------------ */

export interface SemanticQuestionSetEntry {
  question_key: string;
  question_class: string;
  instructions: string;
  options: Array<{ option_key: string; description: string }>;
  required_for_issue: boolean;
  proposition_id: string;
  requirement_ids: string[];
  evidence_refs: SourceRef[];
  template: { template_id: string; template_version: string; template_hash: Hash };
}

export function semanticQuestionSetHash(questions: readonly SemanticQuestionSetEntry[]): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_question_set/1",
    questions: [...questions]
      .map((question) => ({
        question_key: question.question_key,
        question_class: question.question_class,
        instructions: question.instructions,
        options: question.options.map((option) => ({
          option_key: option.option_key,
          description: option.description,
        })),
        required_for_issue: question.required_for_issue,
        proposition_id: question.proposition_id,
        requirement_ids_utf8: sortUtf8Strings(question.requirement_ids),
        evidence_refs_utf8: sortUtf8Strings(question.evidence_refs),
        template: question.template,
      }))
      .sort((a, b) => compareStrings(a.question_key, b.question_key)),
  });
}

export interface SemanticEvidenceSetEntry {
  source_id: string;
  source_ref: SourceRef;
  content_hash: Hash;
  roles: string[];
}

export function semanticEvidenceSetHash(evidence: readonly SemanticEvidenceSetEntry[]): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_evidence_set/1",
    evidence: [...evidence]
      .map((entry) => ({
        source_id: entry.source_id,
        source_ref: entry.source_ref,
        content_hash: entry.content_hash,
        roles_utf8: sortUtf8Strings(entry.roles),
      }))
      .sort((a, b) => {
        const bySource = compareStrings(a.source_id, b.source_id);
        return bySource !== 0 ? bySource : compareStrings(a.source_ref, b.source_ref);
      }),
  });
}


export function templateBindingsDigest(bindings: readonly TemplateBinding[]): Hash {
  const projected = sortByKey(bindings, (binding) => binding.question_key).map((binding) => ({
    question_key: binding.question_key,
    template_id: binding.template_id,
    template_version: binding.template_version,
    template_hash: binding.template_hash,
  }));
  return jcsHash(projected);
}

export function questionBindingsDigest(bindings: readonly QuestionBinding[]): Hash {
  const projected = sortByKey(bindings, (binding) => binding.question_key).map((binding) => ({
    question_key: binding.question_key,
    template_id: binding.template_id,
    template_version: binding.template_version,
    template_hash: binding.template_hash,
    proposition_id: binding.proposition_id,
    requirement_ids_utf8: sortUtf8Strings(binding.requirement_ids),
    required_for_issue: binding.required_for_issue,
    option_order: binding.option_order,
    option_effects: binding.option_effects,
    answer_to_issue_map: binding.answer_to_issue_map,
    independence: binding.independence,
  }));
  return jcsHash(projected);
}

export function propositionBindingsDigest(
  bindings: readonly NoulPropositionBinding[]
): Hash {
  const projected = sortByKey(bindings, (binding) => binding.question_key).map((binding) => ({
    question_key: binding.question_key,
    proposition_id: binding.proposition_id,
    requirement_ids_utf8: sortUtf8Strings(binding.requirement_ids),
    p_yes_means: binding.p_yes_means,
    inconsistent_equivalent: binding.inconsistent_equivalent,
    equivalence_source: binding.equivalence_source,
    mapping_version: binding.mapping_version,
  }));
  return jcsHash(projected);
}

export function stateHashOf(state: JsonValue): Hash {
  return jcsHash(state);
}

export function stateContentView(state: JsonValue): JsonValue {
  const record = state as { [key: string]: JsonValue };
  const binding = record["binding"] as { [key: string]: JsonValue } | undefined;
  const questionScope = record["question_scope"] as { [key: string]: JsonValue } | undefined;
  return {
    schema_version: record["schema_version"] ?? null,
    profile: record["profile"] ?? null,
    binding: {
      task_id: binding?.["task_id"] ?? null,
      branch_id: binding?.["branch_id"] ?? null,
      input_epoch: binding?.["input_epoch"] ?? null,
      goal_version: binding?.["goal_version"] ?? null,
      config_version: binding?.["config_version"] ?? null,
    },
    question_scope: {
      issue_type: questionScope?.["issue_type"] ?? null,
      scope_kind: questionScope?.["scope_kind"] ?? null,
      requirement_ids: questionScope?.["requirement_ids"] ?? [],
      artifact_paths: questionScope?.["artifact_paths"] ?? [],
      whole_task_verdict_requested: questionScope?.["whole_task_verdict_requested"] ?? false,
    },
    coverage: record["coverage"] ?? null,
    requirements: record["requirements"] ?? [],
    latest_input: record["latest_input"] ?? null,
    evidence: record["evidence"] ?? [],
    comparison: record["comparison"] ?? null,
    task_conditions: record["task_conditions"] ?? null,
    experience_candidates: record["experience_candidates"] ?? null,
  };
}

export function stateContentHash(state: JsonValue): Hash {
  return jcsHash(stateContentView(state));
}

export function questionsHash(questions: JsonValue): Hash {
  return jcsHash(questions);
}

export function requestHashV3(input: {
  backend: SemanticBackendRef;
  scope_key: Hash;
  pack_hash: Hash;
  manifest_hash: Hash;
  state_content_hash: Hash | null;
  question_set_hash: Hash;
  evidence_set_hash: Hash;
  adapter_request_hash: Hash | null;
}): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_request/1",
    backend_key: input.backend.backend_key,
    capability_key: input.backend.capability_key,
    capability_hash: input.backend.capability_hash,
    method: {
      method_id: input.backend.method.method_id,
      method_version: input.backend.method.method_version,
      rule_version: input.backend.method.rule_version,
    },
    scope_key: input.scope_key,
    pack_hash: input.pack_hash,
    manifest_hash: input.manifest_hash,
    state_content_hash: input.state_content_hash,
    question_set_hash: input.question_set_hash,
    evidence_set_hash: input.evidence_set_hash,
    adapter_request_hash: input.adapter_request_hash,
  });
}

export function dispatchKeyV3(input: {
  request_hash: Hash;
  backend: SemanticBackendRef;
  scope_key: Hash;
  validator_binding_key: Hash;
  question_set_hash: Hash;
  question_bindings_digest: Hash;
  adapter_request_hash: Hash | null;
}): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_dispatch/1",
    request_hash: input.request_hash,
    backend_key: input.backend.backend_key,
    capability_key: input.backend.capability_key,
    capability_hash: input.backend.capability_hash,
    method: {
      method_id: input.backend.method.method_id,
      method_version: input.backend.method.method_version,
      rule_version: input.backend.method.rule_version,
    },
    scope_key: input.scope_key,
    validator_binding_key: input.validator_binding_key,
    question_set_hash: input.question_set_hash,
    question_bindings_digest: input.question_bindings_digest,
    adapter_request_hash: input.adapter_request_hash,
  });
}

export function adapterContractHash(backendKind: string): Hash | null {
  if (backendKind !== "jev_typed") {
    return null;
  }
  return jcsHash({
    schema_version: "rsi.jev_adapter_contract/1",
    request_schema: "rsi.jev_typed_adapter_request/1",
    response_schema: "rsi.judge_wire/1",
    question_types: ["noul", "choice", "score"],
    box: false,
    batch_atomicity: "reject_all",
    validator_policy_version: "rsi.judge.validator/1",
  });
}

export function adapterEvidenceHash(evidence: JsonValue | null): Hash | null {
  if (evidence === null) {
    return null;
  }
  return jcsHash({
    schema_version: "rsi.adapter_evidence_hash/1",
    evidence,
  });
}

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

export interface EnvelopeHashInput {
  request_hash: Hash;
  dispatch_key: Hash;
  shard_key: Hash;
  plan_hash: Hash;
  pack_hash: Hash;
  request_schema_version: string;
  backend: SemanticBackendRef;
  question_set_hash: Hash;
  question_bindings_digest: Hash;
  template_bindings: readonly TemplateBinding[];
  semantic_outcomes: Record<string, SemanticOutcome>;
  validation: {
    status: "accepted" | "degraded";
    policy_version: string;
    policy_hash: Hash;
    validator_binding_key: Hash;
    output_contract: string;
    contract_hash: Hash;
    errors: string[];
    skipped_by_dependency: string[];
    primary_error: string | null;
    per_question: Record<string, { status: string; errors: string[] }>;
    calibration_status: string;
  };
  adapter_evidence_hash: Hash | null;
}

export function envelopeHashV3(input: EnvelopeHashInput): Hash {
  return jcsHash({
    schema_version: "rsi.judge_envelope/3",
    request_hash: input.request_hash,
    dispatch_key: input.dispatch_key,
    shard_key: input.shard_key,
    plan_hash: input.plan_hash,
    pack_hash: input.pack_hash,
    request_schema_version: input.request_schema_version,
    backend: {
      backend_key: input.backend.backend_key,
      capability_key: input.backend.capability_key,
      capability_hash: input.backend.capability_hash,
      backend_kind: input.backend.backend_kind,
      method: {
        method_id: input.backend.method.method_id,
        method_version: input.backend.method.method_version,
        rule_version: input.backend.method.rule_version,
      },
      scope_key: input.backend.scope_key,
    },
    question_set_hash: input.question_set_hash,
    question_bindings_digest: input.question_bindings_digest,
    template_bindings: sortByKey(input.template_bindings, (binding) => binding.question_key).map(
      (binding) => ({
        question_key: binding.question_key,
        template_id: binding.template_id,
        template_version: binding.template_version,
        template_hash: binding.template_hash,
      })
    ),
    semantic_outcomes: input.semantic_outcomes,
    validation: {
      status: input.validation.status,
      policy_version: input.validation.policy_version,
      policy_hash: input.validation.policy_hash,
      validator_binding_key: input.validation.validator_binding_key,
      output_contract: input.validation.output_contract,
      contract_hash: input.validation.contract_hash,
      errors_utf8: sortUtf8Strings(input.validation.errors),
      skipped_by_dependency_utf8: sortUtf8Strings(input.validation.skipped_by_dependency),
      primary_error: input.validation.primary_error,
      per_question: input.validation.per_question,
      calibration_status: input.validation.calibration_status,
    },
    adapter_evidence_hash: input.adapter_evidence_hash,
  });
}

export function envelopeKeyV3(input: {
  request_hash: Hash;
  dispatch_key: Hash;
  envelope_hash: Hash;
  validator_binding_key: Hash;
  capability_key: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.judge_envelope_key/3",
    request_hash: input.request_hash,
    dispatch_key: input.dispatch_key,
    envelope_hash: input.envelope_hash,
    validator_binding_key: input.validator_binding_key,
    capability_key: input.capability_key,
  });
}

export function attemptKeyV2(input: { binding_id: string; attempt_no: number }): Hash {
  return jcsHash({
    schema_version: "rsi.judge_attempt/2",
    binding_id: input.binding_id,
    attempt_no: input.attempt_no,
  });
}

export function lateResultKeyV2(input: {
  attempt_id: string;
  raw_response_hash: Hash;
  capability_key: Hash;
  envelope_schema_version: string | null;
  envelope_key: Hash | null;
  disposition: string;
}): Hash {
  return jcsHash({
    schema_version: "rsi.late_judge_result_key/2",
    attempt_id: input.attempt_id,
    raw_response_hash: input.raw_response_hash,
    capability_key: input.capability_key,
    envelope_schema_version: input.envelope_schema_version,
    envelope_key: input.envelope_key,
    disposition: input.disposition,
  });
}

/* ------------------------------------------------------------------ */
/* Aggregate                                                           */
/* ------------------------------------------------------------------ */

export function conflictKey(input: {
  proposition_id: string;
  requirement_ids: string[];
  sides: Array<{ question_key: string; envelope_key: Hash; effect: string }>;
}): Hash {
  return jcsHash({
    schema_version: "rsi.aggregate_conflict/1",
    proposition_id: input.proposition_id,
    requirement_ids_utf8: sortUtf8Strings(input.requirement_ids),
    sides: [...input.sides].sort((a, b) => {
      const byQuestion = compareStrings(a.question_key, b.question_key);
      return byQuestion !== 0 ? byQuestion : compareStrings(a.envelope_key, b.envelope_key);
    }),
  });
}

export function aggregateKeyV2(input: {
  plan_hash: Hash;
  shard_plan_key: Hash;
  pack_hash: Hash;
  backend: SemanticBackendRef;
  scope_key: Hash;
  selected_envelope_keys: Hash[];
  hard_fact_keys: Hash[];
  omission_keys: Hash[];
  question_bindings_digest: Hash;
  hard_fact_snapshot_hash: Hash;
  hard_fact_view_hash: Hash;
  validator_binding_key: Hash;
  /**
   * Digest of the normalized `decided_question_keys` that were validated from
   * verified hard facts. It is omitted when empty so aggregates produced
   * without a deterministic decision keep their historic canonical key.
   */
  decided_question_keys_digest?: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.answer_aggregate_key/2",
    plan_hash: input.plan_hash,
    shard_plan_key: input.shard_plan_key,
    pack_hash: input.pack_hash,
    capability_key: input.backend.capability_key,
    capability_hash: input.backend.capability_hash,
    method: {
      method_id: input.backend.method.method_id,
      method_version: input.backend.method.method_version,
      rule_version: input.backend.method.rule_version,
    },
    scope_key: input.scope_key,
    selected_envelope_keys_utf8: sortUtf8Strings(input.selected_envelope_keys),
    hard_fact_keys_utf8: sortUtf8Strings(input.hard_fact_keys),
    omission_keys_utf8: sortUtf8Strings(input.omission_keys),
    question_bindings_digest: input.question_bindings_digest,
    hard_fact_snapshot_hash: input.hard_fact_snapshot_hash,
    hard_fact_view_hash: input.hard_fact_view_hash,
    aggregation_policy_version: "rsi.aggregate/2",
    review_policy_version: "rsi.aggregate.review/1",
    validator_binding_key: input.validator_binding_key,
    ...(input.decided_question_keys_digest === undefined
      ? {}
      : { decided_question_keys_digest: input.decided_question_keys_digest }),
  });
}

export function aggregateKeyV1(input: {
  plan_hash: Hash;
  shard_plan_key: Hash;
  pack_hash: Hash;
  selected_envelope_keys: Hash[];
  hard_fact_keys: Hash[];
  omission_keys: Hash[];
  question_bindings_digest: Hash;
  hard_fact_snapshot_hash: Hash;
  hard_fact_view_hash: Hash;
  aggregation_policy_version: string;
  validator_binding_key: Hash;
}): Hash {
  return jcsHash({
    schema_version: "rsi.answer_aggregate_key/1",
    plan_hash: input.plan_hash,
    shard_plan_key: input.shard_plan_key,
    pack_hash: input.pack_hash,
    selected_envelope_keys_utf8: sortUtf8Strings(input.selected_envelope_keys),
    hard_fact_keys_utf8: sortUtf8Strings(input.hard_fact_keys),
    omission_keys_utf8: sortUtf8Strings(input.omission_keys),
    question_bindings_digest: input.question_bindings_digest,
    hard_fact_snapshot_hash: input.hard_fact_snapshot_hash,
    hard_fact_view_hash: input.hard_fact_view_hash,
    aggregation_policy_version: input.aggregation_policy_version,
    validator_binding_key: input.validator_binding_key,
  });
}

function aggregateCoverageProjection(coverage: AggregateCoverage): JsonValue {
  return {
    required_question_keys_utf8: sortUtf8Strings(coverage.required_question_keys),
    accepted_question_keys_utf8: sortUtf8Strings(coverage.accepted_question_keys),
    degraded_question_keys_utf8: sortUtf8Strings(coverage.degraded_question_keys),
    missing_question_keys_utf8: sortUtf8Strings(coverage.missing_question_keys),
    stale_question_keys_utf8: sortUtf8Strings(coverage.stale_question_keys),
    budget_rejected_question_keys_utf8: sortUtf8Strings(
      coverage.budget_rejected_question_keys
    ),
    projection_rejected_question_keys_utf8: sortUtf8Strings(
      coverage.projection_rejected_question_keys
    ),
    complete: coverage.complete,
  };
}

export function propositionProjection(
  propositions: readonly PropositionAggregate[]
): JsonValue[] {
  return [...propositions]
    .map((entry) => ({
      proposition_id: entry.proposition_id,
      requirement_ids_utf8: sortUtf8Strings(entry.requirement_ids),
      question_keys_utf8: sortUtf8Strings(entry.question_keys),
      semantic_effects: {
        supports_utf8: sortUtf8Strings(entry.semantic_effects.supports),
        contradicts_utf8: sortUtf8Strings(entry.semantic_effects.contradicts),
        unknown_utf8: sortUtf8Strings(entry.semantic_effects.unknown),
        not_applicable_utf8: sortUtf8Strings(entry.semantic_effects.not_applicable),
      },
      hard_effects: {
        supports_utf8: sortUtf8Strings(entry.hard_effects.supports),
        violates_utf8: sortUtf8Strings(entry.hard_effects.violates),
      },
      result: entry.result,
      resolved_by: entry.resolved_by,
      evidence_refs_utf8: sortUtf8Strings(entry.evidence_refs),
    }))
    .sort((a, b) => {
      const byId = compareStrings(a.proposition_id, b.proposition_id);
      if (byId !== 0) {
        return byId;
      }
      return compareStrings(jsonText(a.requirement_ids_utf8), jsonText(b.requirement_ids_utf8));
    });
}

export function requirementProjection(
  requirements: readonly RequirementAggregate[]
): JsonValue[] {
  return [...requirements]
    .map((entry) => ({
      requirement_id: entry.requirement_id,
      proposition_ids_utf8: sortUtf8Strings(entry.proposition_ids),
      hard_effects: {
        supports_utf8: sortUtf8Strings(entry.hard_effects.supports),
        violates_utf8: sortUtf8Strings(entry.hard_effects.violates),
        same_source_conflicts_utf8: sortUtf8Strings(entry.hard_effects.same_source_conflicts),
      },
      final_state: entry.final_state,
      basis: entry.basis,
      reason_codes_utf8: sortUtf8Strings(entry.reason_codes),
    }))
    .sort((a, b) => compareStrings(a.requirement_id, b.requirement_id));
}

export function conflictProjection(conflicts: readonly AggregateConflict[]): JsonValue[] {
  return [...conflicts]
    .map((entry) => ({
      conflict_key: entry.conflict_key,
      proposition_id: entry.proposition_id,
      requirement_ids_utf8: sortUtf8Strings(entry.requirement_ids),
      sides: [...entry.sides]
        .sort((a, b) => {
          const byQuestion = compareStrings(a.question_key, b.question_key);
          return byQuestion !== 0 ? byQuestion : compareStrings(a.envelope_key, b.envelope_key);
        })
        .map((side) => ({
          question_key: side.question_key,
          envelope_key: side.envelope_key,
          effect: side.effect,
        })),
      resolution: entry.resolution,
      reason_codes_utf8: sortUtf8Strings(entry.reason_codes),
    }))
    .sort((a, b) => compareStrings(a.conflict_key, b.conflict_key));
}

export function missingProjection(missing: readonly (AggregateMissing | AggregateMissingV2)[]): JsonValue[] {
  return [...missing]
    .map((entry) => ({
      question_key: entry.question_key,
      shard_key: entry.shard_key,
      kind: entry.kind,
      required_for_issue: entry.required_for_issue,
      recoverable: entry.recoverable,
      omission_keys_utf8: sortUtf8Strings(entry.omission_keys),
      source_refs_utf8: sortUtf8Strings(entry.source_refs),
    }))
    .sort((a, b) => {
      const byQuestion = compareStrings(a.question_key, b.question_key);
      if (byQuestion !== 0) {
        return byQuestion;
      }
      const byKind = compareStrings(a.kind, b.kind);
      if (byKind !== 0) {
        return byKind;
      }
      if (a.shard_key === null && b.shard_key !== null) {
        return -1;
      }
      if (a.shard_key !== null && b.shard_key === null) {
        return 1;
      }
      const byShard = compareStrings(a.shard_key ?? "", b.shard_key ?? "");
      if (byShard !== 0) {
        return byShard;
      }
      return compareStrings(jsonText(a.omission_keys_utf8), jsonText(b.omission_keys_utf8));
    });
}

export function staleProjection(stale: readonly (AggregateStale | AggregateStaleV2)[]): JsonValue[] {
  return [...stale]
    .map((entry) => ({
      question_key: entry.question_key,
      shard_key: entry.shard_key,
      rejected_binding: {
        task_id: entry.rejected_binding.task_id,
        branch_id: entry.rejected_binding.branch_id,
        input_epoch: entry.rejected_binding.input_epoch,
        goal_version: entry.rejected_binding.goal_version,
        config_version: entry.rejected_binding.config_version,
      },
      current_binding: {
        task_id: entry.current_binding.task_id,
        branch_id: entry.current_binding.branch_id,
        input_epoch: entry.current_binding.input_epoch,
        goal_version: entry.current_binding.goal_version,
        config_version: entry.current_binding.config_version,
      },
      reason: entry.reason,
    }))
    .sort((a, b) => {
      const byQuestion = compareStrings(a.question_key, b.question_key);
      return byQuestion !== 0 ? byQuestion : compareStrings(a.shard_key, b.shard_key);
    });
}

export function hardFactUseProjection(facts: readonly HardFactUse[]): JsonValue[] {
  return [...facts]
    .map((entry) => ({
      fact_key: entry.fact_key,
      independence_key: entry.independence_key,
      requirement_id: entry.requirement_id,
      proposition_id: entry.proposition_id ?? null,
      effect: entry.effect,
      verified: entry.verified,
      artifact_version: entry.artifact_version ?? null,
      source_ids_utf8: sortUtf8Strings(entry.source_ids),
      source_refs_utf8: sortUtf8Strings(entry.source_refs),
    }))
    .sort((a, b) => compareStrings(a.fact_key, b.fact_key));
}

export function optionalObservationProjection(
  observations: readonly OptionalObservation[]
): JsonValue[] {
  return [...observations]
    .map((entry) => ({
      question_key: entry.question_key,
      envelope_key: entry.envelope_key,
      effect: entry.effect,
      issue_effect: entry.issue_effect,
      affects_final_state: entry.affects_final_state,
      local_action_authorized: entry.local_action_authorized,
    }))
    .sort((a, b) => {
      const byQuestion = compareStrings(a.question_key, b.question_key);
      return byQuestion !== 0 ? byQuestion : compareStrings(a.envelope_key, b.envelope_key);
    });
}

export function aggregateHashV2(aggregate: AnswerAggregateV2): Hash {
  const selected = [...aggregate.selected_shards]
    .map((entry) => ({
      shard_key: entry.shard_key,
      request_hash: entry.request_hash,
      dispatch_key: entry.dispatch_key,
      envelope_key: entry.envelope_key,
      envelope_schema_version: entry.envelope_schema_version,
      capability_key: entry.capability_key,
      capability_hash: entry.capability_hash,
      validation_status: entry.validation_status,
      model_match: entry.model_match,
      selected: entry.selected,
      reason_codes_utf8: sortUtf8Strings(entry.reason_codes),
    }))
    .sort((a, b) => compareStrings(a.shard_key, b.shard_key));
  return jcsHash({
    schema_version: "rsi.answer_aggregate/2",
    aggregate_key: aggregate.aggregate_key,
    plan_hash: aggregate.plan_hash,
    shard_plan_key: aggregate.shard_plan_key,
    binding: bindingContent(aggregate.binding),
    aggregation_policy_version: aggregate.aggregation_policy_version,
    review_policy_version: aggregate.review_policy_version,
    validator_policy_version: aggregate.validator_policy_version,
    validator_binding_key: aggregate.validator_binding_key,
    question_bindings_digest: aggregate.input_keys.question_bindings_digest,
    backend: {
      backend_key: aggregate.backend.backend_key,
      backend_kind: aggregate.backend.backend_kind,
      method: {
        method_id: aggregate.backend.method.method_id,
        method_version: aggregate.backend.method.method_version,
        rule_version: aggregate.backend.method.rule_version,
      },
      scope_key: aggregate.backend.scope_key,
      capability_key: aggregate.backend.capability_key,
      capability_hash: aggregate.backend.capability_hash,
    },
    selected_shards: selected,
    coverage: aggregateCoverageProjection(aggregate.coverage),
    propositions: propositionProjection(aggregate.propositions),
    requirements: requirementProjection(aggregate.requirements),
    conflicts: conflictProjection(aggregate.conflicts),
    missing: missingProjection(aggregate.missing),
    stale_discarded: staleProjection(aggregate.stale_discarded),
    hard_facts: hardFactUseProjection(aggregate.hard_facts),
    optional_observations: optionalObservationProjection(aggregate.optional_observations),
    final_state: aggregate.final_state,
    final_basis: aggregate.final_basis,
    reason_codes_utf8: sortUtf8Strings(aggregate.reason_codes),
    coverage_complete: aggregate.coverage_complete,
    task_success: aggregate.task_success,
    delivery_allowed: aggregate.delivery_allowed,
    local_action: aggregate.local_action,
    human_review_candidate: aggregate.human_review_candidate,
    human_review_reasons_utf8: sortUtf8Strings(aggregate.human_review_reasons),
    evidence_refs_utf8: sortUtf8Strings(aggregate.evidence_refs),
    input_keys: aggregateInputKeysProjection(aggregate.input_keys),
  });
}

export function aggregateHashV1(aggregate: AnswerAggregate): Hash {
  const selected = [...aggregate.selected_shards]
    .map((entry) => ({
      shard_key: entry.shard_key,
      request_hash: entry.request_hash,
      dispatch_key: entry.dispatch_key,
      envelope_key: entry.envelope_key,
      validation_status: entry.validation_status,
      model_match: entry.model_match,
      selected: entry.selected,
      reason_codes_utf8: sortUtf8Strings(entry.reason_codes),
    }))
    .sort((a, b) => compareStrings(a.shard_key, b.shard_key));
  return jcsHash({
    schema_version: "rsi.answer_aggregate/1",
    aggregate_key: aggregate.aggregate_key,
    plan_hash: aggregate.plan_hash,
    shard_plan_key: aggregate.shard_plan_key,
    binding: bindingContent(aggregate.binding),
    aggregation_policy_version: aggregate.aggregation_policy_version,
    validator_policy_version: aggregate.validator_policy_version,
    validator_binding_key: aggregate.validator_binding_key,
    question_bindings_digest: aggregate.input_keys.question_bindings_digest,
    selected_shards: selected,
    coverage: aggregateCoverageProjection(aggregate.coverage),
    propositions: propositionProjection(aggregate.propositions),
    requirements: requirementProjection(aggregate.requirements),
    conflicts: conflictProjection(aggregate.conflicts),
    missing: missingProjection(aggregate.missing),
    stale_discarded: staleProjection(aggregate.stale_discarded),
    hard_facts: hardFactUseProjection(aggregate.hard_facts),
    optional_observations: optionalObservationProjection(aggregate.optional_observations),
    final_state: aggregate.final_state,
    final_basis: aggregate.final_basis,
    reason_codes_utf8: sortUtf8Strings(aggregate.reason_codes),
    coverage_complete: aggregate.coverage_complete,
    task_success: aggregate.task_success,
    delivery_allowed: aggregate.delivery_allowed,
    local_action: aggregate.local_action,
    evidence_refs_utf8: sortUtf8Strings(aggregate.evidence_refs),
    input_keys: {
      pack_hash: aggregate.input_keys.pack_hash,
      shard_plan_key: aggregate.input_keys.shard_plan_key,
      selected_envelope_keys_utf8: sortUtf8Strings(
        aggregate.input_keys.selected_envelope_keys
      ),
      hard_fact_keys_utf8: sortUtf8Strings(aggregate.input_keys.hard_fact_keys),
      omission_keys_utf8: sortUtf8Strings(aggregate.input_keys.omission_keys),
      question_bindings_digest: aggregate.input_keys.question_bindings_digest,
      hard_fact_snapshot_hash: aggregate.input_keys.hard_fact_snapshot_hash,
      hard_fact_view_hash: aggregate.input_keys.hard_fact_view_hash,
    },
  });
}

function aggregateInputKeysProjection(input: AggregateInputKeys): JsonValue {
  const record: { [key: string]: JsonValue } = {
    pack_hash: input.pack_hash,
    shard_plan_key: input.shard_plan_key,
    selected_envelope_keys_utf8: sortUtf8Strings(input.selected_envelope_keys),
    hard_fact_keys_utf8: sortUtf8Strings(input.hard_fact_keys),
    omission_keys_utf8: sortUtf8Strings(input.omission_keys),
    question_bindings_digest: input.question_bindings_digest,
    hard_fact_snapshot_hash: input.hard_fact_snapshot_hash,
    hard_fact_view_hash: input.hard_fact_view_hash,
  };
  if ("capability_key" in input && typeof input.capability_key === "string") {
    record["capability_key"] = input.capability_key;
  }
  if ("capability_hash" in input && typeof input.capability_hash === "string") {
    record["capability_hash"] = input.capability_hash;
  }
  return record;
}

/** `closure_hash` for `ClosureResult` (DD-EVD-026). */
export function closureHash(input: {
  units: readonly { unit_key: Hash }[];
  omissions: readonly { omission_key: Hash }[];
  per_question: readonly { question_key: string; unit_keys: string[]; omission_keys: string[] }[];
}): Hash {
  return jcsHash({
    schema_version: "rsi.closure_result_hash/1",
    unit_keys_utf8: sortUtf8Strings(input.units.map((unit) => unit.unit_key)),
    omission_keys_utf8: sortUtf8Strings(input.omissions.map((omission) => omission.omission_key)),
    per_question: [...input.per_question]
      .map((entry) => ({
        question_key: entry.question_key,
        unit_keys_utf8: sortUtf8Strings(entry.unit_keys),
        omission_keys_utf8: sortUtf8Strings(entry.omission_keys),
      }))
      .sort((a, b) => compareStrings(a.question_key, b.question_key)),
  });
}

/** `sha256(UTF-8(text))` used for excerpt and statement text hashes. */
export function textHash(text: string): Hash {
  return hashUtf8(text);
}

/** `sha256(bytes)` re-export for source validation. */
export function bytesHash(bytes: Uint8Array): Hash {
  return hashBytes(bytes);
}

export { bindingContent };
