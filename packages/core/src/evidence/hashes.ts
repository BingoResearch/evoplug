/**
 * QP semantic and content hashes (DD-QP-04b, DD-QP-19, DD-QP-21, DD-QP-31c).
 *
 * Every preimage lists all keys explicitly and writes `null` for absent
 * optional values. Arrays that carry business meaning are sorted by the
 * documented UTF-8 key before canonicalization; instance ids and wall clocks
 * never enter a semantic hash.
 */

import { compareUtf8, sortUtf8 } from "../canonical.js";
import { canonicalHash, hashBytes, type Hash } from "../hash.js";
import type { JsonValue } from "../json.js";
import type { VersionBinding } from "../version-binding.js";
import type { SourceRef } from "../source-ref.js";
import type {
  CloseEvidence,
  CloseEvidenceReviewHandoff,
  EvidenceDependency,
  EvidenceGap,
  Issue,
  IssueJudgmentDraft,
  IssueTransitionRecord,
  JudgmentRouteRecord,
  PlanSource,
  PlannedQuestion,
  QuestionPlan,
  QuestionTemplate,
  QuestionTemplateRegistry,
  ReopenEvidence,
  RequirementResult
} from "./types.js";

/** Sorts and deduplicates strings by UTF-8 byte order. */
export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  const sorted = sortUtf8(values, (value) => value);
  const result: T[] = [];
  for (const value of sorted) {
    if (result.length === 0 || result[result.length - 1] !== value) {
      result.push(value);
    }
  }
  return result;
}

/** Sorts and deduplicates SourceRefs by UTF-8 byte order. */
export function sortedUniqueRefs(refs: readonly SourceRef[]): SourceRef[] {
  return sortedUnique(refs);
}

/** Sorts strings by UTF-8 byte order without deduplicating. */
export function sorted<T extends string>(values: readonly T[]): T[] {
  return sortUtf8(values, (value) => value);
}

/** `sha256(JCS(value))` with a stable object key order (JCS handles it). */
export function hashJson(value: JsonValue): Hash {
  return canonicalHash(value);
}

/** `issue_key` (DD-QP-04b). */
export function issueKey(input: {
  type: string;
  binding: VersionBinding;
  requirement_ids: readonly string[];
  subject_key: string;
}): Hash {
  return hashJson({
    schema_version: "rsi.issue_key/2",
    type: input.type,
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    input_epoch: input.binding.input_epoch,
    goal_version: input.binding.goal_version,
    config_version: input.binding.config_version,
    requirement_ids: sortedUnique(input.requirement_ids),
    subject_key: input.subject_key
  });
}

/** `acceptance_key` used inside `subject_key` (DD-QP-04b). */
export function acceptanceSubjectKey(input: { kind: string; criterion: string }): Hash {
  return hashJson({
    schema_version: "rsi.acceptance_subject/1",
    kind: input.kind,
    criterion: input.criterion
  });
}

/** Plan source fields that enter `question_key` selection. */
interface SourceSelectionEntry {
  source_id: string;
  kind: string;
  role: string;
  content_hash: string;
  version: string | null;
  subject: string | null;
  fact_kind: string | null;
  fact_value_hash: string | null;
}

/** Stable source selection projection for `question_key` (DD-QP-18). */
export function sourceSelection(
  requiredSourceIds: readonly string[],
  sourcesById: ReadonlyMap<string, PlanSource>
): SourceSelectionEntry[] {
  const ids = sortedUnique(requiredSourceIds);
  const entries: SourceSelectionEntry[] = [];
  for (const id of ids) {
    const source = sourcesById.get(id);
    if (source === undefined) {
      continue;
    }
    entries.push({
      source_id: source.source_id,
      kind: source.kind,
      role: source.role,
      content_hash: source.content_hash,
      version: source.version,
      subject: source.subject,
      fact_kind: source.fact_kind,
      fact_value_hash: source.fact_value_hash
    });
  }
  return entries;
}

/** `question_key` (DD-QP-18). */
export function questionKey(input: {
  issue_key: string;
  proposition_id: string;
  slot: string;
  template_id: string;
  template_version: string;
  template_hash: string;
  requirement_ids: readonly string[];
  selection: readonly SourceSelectionEntry[];
}): Hash {
  return hashJson({
    schema_version: "rsi.question_key/2",
    issue_key: input.issue_key,
    proposition_id: input.proposition_id,
    slot: input.slot,
    template_id: input.template_id,
    template_version: input.template_version,
    template_hash: input.template_hash,
    requirement_ids: sortedUnique(input.requirement_ids),
    source_selection: input.selection.map((entry) => ({
      source_id: entry.source_id,
      kind: entry.kind,
      role: entry.role,
      content_hash: entry.content_hash,
      version: entry.version,
      subject: entry.subject,
      fact_kind: entry.fact_kind,
      fact_value_hash: entry.fact_value_hash
    }))
  });
}

/** `proposition_id` (DD-QP-18); returns the hex body without the `propo:` prefix. */
export function propositionId(input: {
  proposition_family: string;
  issue_key: string;
  subject_key: string;
  requirement_ids: readonly string[];
  slot: string;
  experience_id: string | null;
}): string {
  const hash = hashJson({
    schema_version: "rsi.proposition_id/2",
    proposition_family: input.proposition_family,
    issue_key: input.issue_key,
    subject_key: input.subject_key,
    requirement_ids: sortedUnique(input.requirement_ids),
    slot: input.slot,
    experience_id: input.experience_id
  });
  return hash.slice("sha256:".length);
}

function dependencyPreimage(input: {
  question_keys: readonly string[];
  source_ids: readonly string[];
  transport_role: string;
  relation: string;
}): JsonValue {
  return {
    schema_version: "rsi.evidence_dependency/1",
    question_keys: sorted(input.question_keys),
    source_ids: sorted(input.source_ids),
    transport_role: input.transport_role,
    relation: input.relation
  };
}

/** `dependency_key` (DD-QP-19). */
export function dependencyKey(input: {
  question_keys: readonly string[];
  source_ids: readonly string[];
  transport_role: string;
  relation: string;
}): string {
  return `dep:${hashJson(dependencyPreimage(input)).slice("sha256:".length)}`;
}

/**
 * Dependency content hash over the content hashes in the caller's order.
 * DD-QP-19 requires callers to order them by the dependency's sorted
 * `source_ids`, not by the hash values themselves.
 */
export function dependencyContentHash(contentHashes: readonly string[]): Hash {
  return hashJson([...contentHashes]);
}

function planSourcePreimage(source: PlanSource): JsonValue {
  return {
    source_id: source.source_id,
    kind: source.kind,
    source_refs: sorted(source.source_refs),
    content_hash: source.content_hash,
    version: source.version,
    subject: source.subject,
    fact_kind: source.fact_kind,
    fact_value_hash: source.fact_value_hash,
    role: source.role,
    requirement_ids: sorted(source.requirement_ids)
  };
}

function questionPreimage(question: PlannedQuestion): JsonValue {
  return {
    question_key: question.question_key,
    slot: question.slot,
    issue_type: question.issue_type,
    question_type: question.question_type,
    template_id: question.template_id,
    template_version: question.template_version,
    template_hash: question.template_hash,
    instructions: question.instructions,
    criteria: criteriaJson(question.criteria),
    options: [...question.options],
    required_views: [...question.required_views],
    required_source_ids: [...question.required_source_ids],
    requirement_ids: [...question.requirement_ids],
    proposition_id: question.proposition_id,
    option_effects: optionEffectsJson(question.option_effects),
    answer_to_issue_map: answerMapJson(question.answer_to_issue_map),
    required_for_issue: question.required_for_issue,
    independence: {
      answer_independent: question.independence.answer_independent,
      state_profile: question.independence.state_profile,
      shareable: question.independence.shareable
    },
    output_reserve_tokens: question.output_reserve_tokens
  };
}

function criteriaJson(criteria: Record<string, string>): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(criteria).sort()) {
    const value = criteria[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function optionEffectsJson(effects: Record<string, "supports" | "contradicts" | "unknown">): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(effects).sort()) {
    const value = effects[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function answerMapJson(map: PlannedQuestion["answer_to_issue_map"]): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value === undefined) {
      continue;
    }
    result[key] = {
      semantic_axis: value.semantic_axis,
      semantic_value: value.semantic_value,
      option_effect: value.option_effect,
      issue_effect: value.issue_effect,
      requires_local_authorization: value.requires_local_authorization,
      can_close_issue: value.can_close_issue,
      can_satisfy_task: value.can_satisfy_task
    };
  }
  return result;
}

function dependencyPreimageForPlan(dependency: EvidenceDependency): JsonValue {
  return {
    dependency_key: dependency.dependency_key,
    question_keys: sorted(dependency.question_keys),
    role: dependency.role,
    transport_role: dependency.transport_role,
    selection_rank: dependency.selection_rank,
    source_ids: sorted(dependency.source_ids),
    source_refs: sorted(dependency.source_refs),
    content_hash: dependency.content_hash,
    inseparable_group_key: dependency.inseparable_group_key,
    relation: dependency.relation,
    omission_impact: dependency.omission_impact,
    can_omit: dependency.can_omit,
    derived_view_key: dependency.derived_view_key
  };
}

/** `plan_hash` over the exact plan body (DD-QP-21). */
export function planHash(plan: QuestionPlan): Hash {
  return hashJson({
    schema_version: "rsi.question_plan/1",
    planner_version: plan.planner_version,
    issue_key: plan.issue_key,
    issue_type: plan.issue_type,
    binding: bindingPreimage(plan.binding, false),
    state_profile: plan.state_profile,
    registry_version: plan.registry_version,
    registry_hash: plan.registry_hash,
    artifact_paths: sorted(plan.artifact_paths),
    sources: sortUtf8(plan.sources, (source) => source.source_id).map(planSourcePreimage),
    questions: sortUtf8(plan.questions, (question) => question.question_key).map(questionPreimage),
    dependencies: sortUtf8(plan.dependencies, (dependency) => dependency.dependency_key).map(
      dependencyPreimageForPlan
    ),
    required_source_ids: sorted(plan.required_source_ids),
    required_views: sorted(plan.required_views),
    aggregate_output_reserve_tokens: plan.aggregate_output_reserve_tokens
  });
}

/** Plan idempotency key (DD-QP-27a concurrency rule 5). */
export function planIdempotencyKey(issue_key: string, plan_hash: string): Hash {
  return hashJson({
    schema_version: "rsi.plan_idempotency/1",
    issue_key,
    plan_hash
  });
}

/** PlanState content hash (DD-QP-20). */
export function planStateContentHash(input: {
  plan_id: string;
  state_seq: number;
  state: string;
  reason_code: string | null;
  plan_hash: string;
  task_id: string;
  branch_id: string;
}): Hash {
  return hashJson({
    schema_version: "rsi.question_plan_state/1",
    plan_id: input.plan_id,
    state_seq: input.state_seq,
    state: input.state,
    reason_code: input.reason_code,
    plan_hash: input.plan_hash,
    task_id: input.task_id,
    branch_id: input.branch_id
  });
}

/** Binding preimage; `watermark` is included only when the contract keeps it. */
function bindingPreimage(binding: VersionBinding, includeWatermark: boolean): JsonValue {
  const base: Record<string, JsonValue> = {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version
  };
  if (includeWatermark) {
    base["watermark"] = binding.watermark;
  }
  return base;
}

/** `judgment_hash` (DD-QP-05b step 5). */
export function judgmentHash(draft: IssueJudgmentDraft): Hash {
  const decision: JsonValue =
    draft.decision.kind === "answer_aggregate"
      ? {
          kind: "answer_aggregate",
          aggregate_key: draft.decision.aggregate_key,
          aggregate_hash: draft.decision.aggregate_hash,
          plan_hash: draft.decision.plan_hash
        }
      : { kind: "local_facts", fact_keys: sorted(draft.decision.fact_keys) };
  return hashJson({
    schema_version: "rsi.issue_judgment/1",
    issue_key: draft.issue_key,
    issue_version: draft.issue_version,
    decision,
    basis: draft.basis,
    outcome: draft.outcome,
    requirement_results: requirementResultsPreimage(draft.requirement_results),
    accepted: true
  });
}

/** Requirement results sorted by `(requirement_id, proposition_id)` UTF-8. */
export function sortRequirementResults(results: readonly RequirementResult[]): RequirementResult[] {
  const sortedResults = [...results].sort((left, right) => {
    const byRequirement = compareUtf8(left.requirement_id, right.requirement_id);
    return byRequirement !== 0 ? byRequirement : compareUtf8(left.proposition_id, right.proposition_id);
  });
  return sortedResults;
}

function requirementResultsPreimage(results: readonly RequirementResult[]): JsonValue {
  return sortRequirementResults(results).map((result) => ({
    requirement_id: result.requirement_id,
    proposition_id: result.proposition_id,
    result: result.result,
    aggregate_key: result.aggregate_key
  }));
}

/** `issue_transition.payload_hash` over the journal payload (DD-QP-27a). */
export function issueTransitionPayloadHash(payload: JsonValue): Hash {
  return hashJson(payload);
}

/**
 * `IssueTransitionRecord.content_hash` over the canonical transition body.
 *
 * The design fixes the field list but not a wrapping schema literal; the
 * literal below is the transition record's own `schema_version`, which keeps
 * the hash self-describing without a second schema.
 */
export function transitionContentHash(record: Omit<IssueTransitionRecord, "content_hash">): Hash {
  return hashJson({
    schema_version: "rsi.issue_transition/1",
    transition_id: record.transition_id,
    issue_id: record.issue_id,
    expected_version: record.expected_version,
    issue_version: record.issue_version,
    from_state: record.from_state,
    to_state: record.to_state,
    event: record.event,
    evidence_refs: sorted(record.evidence_refs),
    judgment_ref: record.judgment_ref,
    payload_hash: record.payload_hash,
    task_id: record.task_id,
    branch_id: record.branch_id,
    recorded_at: record.recorded_at,
    issue_after: issuePreimage(record.issue_after)
  });
}

/** Canonical `rsi.issue/1` body used by transition content hashing. */
function issuePreimage(issue: Issue): JsonValue {
  const body: Record<string, JsonValue> = {
    schema_version: "rsi.issue/1",
    issue_id: issue.issue_id,
    issue_version: issue.issue_version,
    issue_key: issue.issue_key,
    binding: {
      task_id: issue.binding.task_id,
      branch_id: issue.binding.branch_id,
      input_epoch: issue.binding.input_epoch,
      goal_version: issue.binding.goal_version,
      config_version: issue.binding.config_version,
      watermark: issue.binding.watermark
    },
    type: issue.type,
    state: issue.state,
    subject_key: issue.subject_key,
    question_text: issue.question_text,
    requirement_ids: sorted(issue.requirement_ids),
    artifact_paths: sorted(issue.artifact_paths),
    artifact_versions: sortUtf8(issue.artifact_versions, (entry) => entry.path).map((entry) => ({
      path: entry.path,
      version: entry.version
    })),
    contract_required: issue.contract_required,
    contract_paths: sorted(issue.contract_paths),
    trigger: {
      kind: issue.trigger.kind,
      event_ids: sorted(issue.trigger.event_ids),
      detector_id: issue.trigger.detector_id,
      detector_version: issue.trigger.detector_version
    },
    source_event_ids: sorted(issue.source_event_ids),
    source_refs: sorted(issue.source_refs),
    evidence_gap: evidenceGapsPreimage(issue.evidence_gap),
    confirmation: issue.confirmation === undefined ? null : confirmationPreimage(issue.confirmation),
    judgment_ref: issue.judgment_ref ?? null,
    close_evidence: issue.close_evidence === undefined ? null : closeEvidencePreimage(issue.close_evidence),
    review_handoff_closure:
      issue.review_handoff_closure === undefined
        ? null
        : reviewHandoffClosurePreimage(issue.review_handoff_closure),
    experience_ref: issue.experience_ref === undefined ? null : experienceRefPreimage(issue.experience_ref),
    reopen_count: issue.reopen_count,
    previous_issue_id: issue.previous_issue_id ?? null,
    rejection:
      issue.rejection === undefined
        ? null
        : { kind: issue.rejection.kind, source_refs: sorted(issue.rejection.source_refs) },
    opened_at_watermark: issue.opened_at_watermark,
    last_observed_watermark: issue.last_observed_watermark,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    last_transition_id: issue.last_transition_id
  };
  return body;
}

function closeEvidencePreimage(evidence: NonNullable<Issue["close_evidence"]>): JsonValue {
  return {
    kind: evidence.kind,
    evidence_id: evidence.evidence_id,
    source_refs: sorted(evidence.source_refs),
    source_hashes: evidence.source_hashes.map((entry) => ({
      source_ref: entry.source_ref,
      content_hash: entry.content_hash
    })),
    evidence_hash: evidence.evidence_hash,
    goal_version: evidence.goal_version,
    recorded_at_watermark: evidence.recorded_at_watermark,
    requirement_ids: sorted(evidence.requirement_ids),
    artifact_version: evidence.artifact_version,
    verifier_ref: evidence.verifier_ref,
    review_handoff:
      evidence.review_handoff === null
        ? null
        : {
            handoff_id: evidence.review_handoff.handoff_id,
            handoff_hash: evidence.review_handoff.handoff_hash,
            proposal_id: evidence.review_handoff.proposal_id,
            proposal_hash: evidence.review_handoff.proposal_hash,
            decision: evidence.review_handoff.decision,
            review_match_outcome: evidence.review_handoff.review_match_outcome,
            snapshot_id: evidence.review_handoff.snapshot_id,
            snapshot_hash: evidence.review_handoff.snapshot_hash,
            plan_id: evidence.review_handoff.plan_id,
            plan_hash: evidence.review_handoff.plan_hash,
            question_key: evidence.review_handoff.question_key,
            close_payload_hash: evidence.review_handoff.close_payload_hash
          }
  };
}

function confirmationPreimage(confirmation: NonNullable<Issue["confirmation"]>): JsonValue {
  return {
    kind: confirmation.kind,
    evidence_ids: sorted(confirmation.evidence_ids),
    source_refs: sorted(confirmation.source_refs),
    confirmed_at_watermark: confirmation.confirmed_at_watermark
  };
}

function experienceRefPreimage(ref: NonNullable<Issue["experience_ref"]>): JsonValue {
  return {
    snapshot_id: ref.snapshot_id,
    snapshot_hash: ref.snapshot_hash,
    proposal_id: ref.proposal_id,
    proposal_hash: ref.proposal_hash,
    experience_id: ref.experience_id,
    experience_version: ref.experience_version,
    experience_content_hash: ref.experience_content_hash
  };
}

function reviewHandoffClosurePreimage(closure: NonNullable<Issue["review_handoff_closure"]>): JsonValue {
  return {
    handoff_id: closure.handoff_id,
    handoff_hash: closure.handoff_hash,
    proposal_id: closure.proposal_id,
    proposal_hash: closure.proposal_hash,
    decision: closure.decision,
    review_match_outcome: closure.review_match_outcome,
    closure_disposition: closure.closure_disposition,
    snapshot_id: closure.snapshot_id,
    snapshot_hash: closure.snapshot_hash,
    plan_id: closure.plan_id,
    plan_hash: closure.plan_hash,
    question_key: closure.question_key
  };
}

/** Sorts gaps by `(code, requirement_ids, source_refs, affects_question_keys)`. */
function sortEvidenceGaps(gaps: readonly EvidenceGap[]): EvidenceGap[] {
  const normalized = gaps.map((gap) => ({
    code: gap.code,
    requirement_ids: sortedUnique(gap.requirement_ids),
    source_refs: sortedUnique(gap.source_refs),
    affects_question_keys: sortedUnique(gap.affects_question_keys)
  }));
  return normalized.sort((left, right) => {
    const byCode = compareUtf8(left.code, right.code);
    if (byCode !== 0) {
      return byCode;
    }
    const byRequirement = compareUtf8(left.requirement_ids.join("\u0000"), right.requirement_ids.join("\u0000"));
    if (byRequirement !== 0) {
      return byRequirement;
    }
    const byRef = compareUtf8(left.source_refs.join("\u0000"), right.source_refs.join("\u0000"));
    return byRef !== 0
      ? byRef
      : compareUtf8(left.affects_question_keys.join("\u0000"), right.affects_question_keys.join("\u0000"));
  });
}

export function evidenceGapsPreimage(gaps: readonly EvidenceGap[]): JsonValue {
  return sortEvidenceGaps(gaps).map((gap) => ({
    code: gap.code,
    requirement_ids: gap.requirement_ids,
    source_refs: gap.source_refs,
    affects_question_keys: gap.affects_question_keys
  }));
}

/** `CloseEvidence.evidence_hash` (DD-QP-06). */
export function closeEvidenceHash(evidence: Omit<CloseEvidence, "evidence_hash" | "recorded_at_watermark">): Hash {
  const refs = sortedUnique(evidence.source_refs);
  const hashesById = new Map(evidence.source_hashes.map((entry) => [entry.source_ref, entry.content_hash]));
  const body: Record<string, JsonValue> = {
    schema_version: "rsi.close_evidence/1",
    kind: evidence.kind,
    evidence_id: evidence.evidence_id,
    goal_version: evidence.goal_version,
    requirement_ids: sortedUnique(evidence.requirement_ids),
    artifact_version: evidence.artifact_version,
    verifier_ref: evidence.verifier_ref,
    source_refs: refs,
    source_hashes: refs.map((ref) => ({
      source_ref: ref,
      content_hash: hashesById.get(ref) ?? ""
    }))
  };
  if (evidence.review_handoff !== null) {
    body["handoff_id"] = evidence.review_handoff.handoff_id;
    body["handoff_hash"] = evidence.review_handoff.handoff_hash;
    body["proposal_id"] = evidence.review_handoff.proposal_id;
    body["proposal_hash"] = evidence.review_handoff.proposal_hash;
    body["decision"] = evidence.review_handoff.decision;
    body["review_match_outcome"] = evidence.review_handoff.review_match_outcome;
    body["snapshot_id"] = evidence.review_handoff.snapshot_id;
    body["snapshot_hash"] = evidence.review_handoff.snapshot_hash;
    body["plan_id"] = evidence.review_handoff.plan_id;
    body["plan_hash"] = evidence.review_handoff.plan_hash;
    body["question_key"] = evidence.review_handoff.question_key;
    body["close_payload_hash"] = evidence.review_handoff.close_payload_hash;
  }
  return hashJson(body);
}

/** `close_payload_hash = sha256(JCS(close_payload))` over the 11 fields. */
export function closePayloadHash(payload: Omit<CloseEvidenceReviewHandoff, "close_payload_hash">): Hash {
  return hashJson({
    handoff_id: payload.handoff_id,
    handoff_hash: payload.handoff_hash,
    proposal_id: payload.proposal_id,
    proposal_hash: payload.proposal_hash,
    decision: payload.decision,
    review_match_outcome: payload.review_match_outcome,
    snapshot_id: payload.snapshot_id,
    snapshot_hash: payload.snapshot_hash,
    plan_id: payload.plan_id,
    plan_hash: payload.plan_hash,
    question_key: payload.question_key
  });
}

/** `ReopenEvidence.evidence_hash` (DD-QP-07). */
export function reopenEvidenceHash(evidence: Omit<ReopenEvidence, "evidence_hash" | "recorded_at_watermark">): Hash {
  const refs = sortedUnique(evidence.source_refs);
  const hashesById = new Map(evidence.source_hashes.map((entry) => [entry.source_ref, entry.content_hash]));
  return hashJson({
    schema_version: "rsi.reopen_evidence/1",
    kind: evidence.kind,
    evidence_id: evidence.evidence_id,
    source_refs: refs,
    source_hashes: refs.map((ref) => ({
      source_ref: ref,
      content_hash: hashesById.get(ref) ?? ""
    })),
    artifact_version: evidence.artifact_version ?? null,
    resolved_gap_codes: sortedUnique(evidence.resolved_gap_codes ?? [])
  });
}

/** `template_hash` over the template body only (DD-QP-11). */
export function templateHash(template: Omit<QuestionTemplate, "template_hash" | "status" | "supersedes">): Hash {
  return hashJson({
    schema_version: "rsi.question_template/1",
    template_id: template.template_id,
    template_version: template.template_version,
    question_type: template.question_type,
    issue_types: [...template.issue_types],
    cardinality: template.cardinality,
    required_views: [...template.required_views],
    required_sources: template.required_sources.map((source) => ({
      role: source.role,
      selector: source.selector,
      presence: source.presence,
      min_count: source.min_count,
      max_count: source.max_count,
      required_if: source.required_if ?? null,
      view: source.view,
      selection: source.selection,
      omission_impact: source.omission_impact
    })),
    options: template.options.map((option) => ({
      key: option.key,
      criteria: option.criteria,
      mapping: {
        semantic_axis: option.mapping.semantic_axis,
        semantic_value: option.mapping.semantic_value,
        option_effect: option.mapping.option_effect,
        issue_effect: option.mapping.issue_effect,
        requires_local_authorization: option.mapping.requires_local_authorization,
        can_close_issue: option.mapping.can_close_issue,
        can_satisfy_task: option.mapping.can_satisfy_task
      }
    })),
    instructions_template: template.instructions_template,
    question_text_template: template.question_text_template,
    proposition_family: template.proposition_family,
    output_reserve_tokens: template.output_reserve_tokens
  });
}

/** `registry_hash` over the sorted template summaries (DD-QP-12). */
export function registryHash(registry: Omit<QuestionTemplateRegistry, "registry_hash">): Hash {
  const templates = [...registry.templates].sort((left, right) => {
    const byId = compareUtf8(left.template_id, right.template_id);
    return byId !== 0 ? byId : compareUtf8(left.template_version, right.template_version);
  });
  return hashJson({
    schema_version: "rsi.question_template_registry/1",
    registry_version: registry.registry_version,
    templates: templates.map((template) => ({
      template_id: template.template_id,
      template_version: template.template_version,
      template_hash: template.template_hash,
      status: template.status
    }))
  });
}

/**
 * `PlanSource.content_hash`: SHA-256 over sorted refs, each framed as
 * `uint32be(length) || bytes` (DD-QP-19).
 */
export function sourceContentHash(segments: ReadonlyArray<{ source_ref: string; bytes: Uint8Array }>): Hash {
  const ordered = sortUtf8(segments, (segment) => segment.source_ref);
  let total = 0;
  for (const segment of ordered) {
    total += 4 + segment.bytes.length;
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const segment of ordered) {
    const length = segment.bytes.length;
    buffer[offset] = (length >>> 24) & 0xff;
    buffer[offset + 1] = (length >>> 16) & 0xff;
    buffer[offset + 2] = (length >>> 8) & 0xff;
    buffer[offset + 3] = length & 0xff;
    offset += 4;
    buffer.set(segment.bytes, offset);
    offset += length;
  }
  return hashBytes(buffer);
}

/* ------------------------------------------------------------------------- */
/* Judgment route hashes (DD-QP-31c)                                         */
/* ------------------------------------------------------------------------- */

function routeEvidencePreimage(evidence: JudgmentRouteRecord["stages"][number]["evidence"][number]): JsonValue {
  return {
    source_ref: evidence.source_ref,
    content_hash: evidence.content_hash,
    role: evidence.role,
    scope: {
      subject_keys: sorted(evidence.scope.subject_keys),
      subject_versions: sorted(evidence.scope.subject_versions),
      coverage: evidence.scope.coverage
    }
  };
}

function routeStageEvidence(record: JudgmentRouteRecord): JudgmentRouteRecord["stages"][number]["evidence"] {
  return record.stages.flatMap((stage) => stage.evidence);
}

export function routeEvidenceSetHash(record: JudgmentRouteRecord): Hash {
  // DD-QP-31c hashes `sorted_unique` evidence: the array order and a repeated
  // entry never change the identity of the route.
  const preimages = routeStageEvidence(record).map(routeEvidencePreimage);
  const unique = new Map<string, JsonValue>();
  for (const preimage of preimages) {
    unique.set(JSON.stringify(preimage), preimage);
  }
  return hashJson({
    schema_version: "rsi.judgment_route_evidence/1",
    evidence: sortUtf8([...unique.values()], (entry) => JSON.stringify(entry))
  });
}

export function routeGapsHash(record: JudgmentRouteRecord): Hash {
  return hashJson({
    schema_version: "rsi.judgment_route_gaps/1",
    gaps: evidenceGapsPreimage(record.gaps)
  });
}

function routeKeyPreimage(record: JudgmentRouteRecord): JsonValue {
  const methods = sortUtf8(
    record.stages.flatMap((stage) => (stage.method === null ? [] : [stage.method])),
    (method) => JSON.stringify(method)
  );
  return {
    schema_version: "rsi.judgment_route_key/1",
    route_policy_version: record.route_policy_version,
    project_id: record.project_id,
    binding: {
      task_id: record.binding.task_id,
      branch_id: record.binding.branch_id,
      input_epoch: record.binding.input_epoch,
      goal_version: record.binding.goal_version,
      config_version: record.binding.config_version,
      watermark: record.binding.watermark
    },
    route_class: record.route_class,
    scope: {
      subject_key: record.scope.subject_key,
      subject_versions: sorted(record.scope.subject_versions)
    },
    issue_key: record.issue_key,
    question_key: record.question_key,
    template_binding:
      record.template_binding === null
        ? null
        : {
            template_id: record.template_binding.template_id,
            template_version: record.template_binding.template_version,
            template_hash: record.template_binding.template_hash
          },
    plan_hash: record.plan_ref === null ? null : record.plan_ref.plan_hash,
    semantic_eligibility:
      record.semantic_eligibility === null
        ? null
        : {
            backend_key: record.semantic_eligibility.backend_key,
            capability_hash: record.semantic_eligibility.capability_hash,
            semantic_scope_key: record.semantic_eligibility.semantic_scope_key
          },
    evidence_set_hash: record.evidence_set_hash,
    gaps_hash: routeGapsHash(record),
    method_refs: methods.map((method) => ({
      schema_version: method.schema_version,
      method_id: method.method_id,
      method_version: method.method_version,
      rule_version: method.rule_version
    }))
  };
}

export function routeKey(record: JudgmentRouteRecord): Hash {
  return hashJson(routeKeyPreimage(record));
}

function routeStageHashInput(stage: JudgmentRouteRecord["stages"][number]): JsonValue {
  return {
    stage: stage.stage,
    status: stage.status,
    method:
      stage.method === null
        ? null
        : {
            schema_version: stage.method.schema_version,
            method_id: stage.method.method_id,
            method_version: stage.method.method_version,
            rule_version: stage.method.rule_version
          },
    evidence: stage.evidence.map(routeEvidencePreimage),
    result_refs: stage.result_refs.map((ref) => ({ kind: ref.kind, result_hash: ref.result_hash })),
    verification:
      stage.verification === null
        ? null
        : {
            fact_content_hash: stage.verification.fact_content_hash,
            verifier_ref: stage.verification.verifier_ref,
            producer_ref: stage.verification.producer_ref,
            independent: stage.verification.independent,
            verification_plan_hash: stage.verification.verification_plan_hash,
            covered_subject_keys: sorted(stage.verification.covered_subject_keys),
            covered_versions: sorted(stage.verification.covered_versions)
          },
    reason_codes: sorted(stage.reason_codes)
  };
}

export function routeHash(record: JudgmentRouteRecord): Hash {
  return hashJson({
    schema_version: "rsi.judgment_route/1",
    route_key: record.route_key,
    route_status: record.route_status,
    plan_ref: record.plan_ref === null ? null : { plan_hash: record.plan_ref.plan_hash },
    aggregate_ref: record.aggregate_ref === null ? null : { aggregate_hash: record.aggregate_ref.aggregate_hash },
    stages: record.stages.map(routeStageHashInput),
    gaps: evidenceGapsPreimage(record.gaps),
    reason_codes: sorted(record.reason_codes),
    policy_factors: sorted(record.policy_factors),
    escalation:
      record.escalation === null
        ? null
        : { kind: record.escalation.kind, reason_code: record.escalation.reason_code }
  });
}

export function routeId(route_key: string, route_hash: string): string {
  const hash = hashJson({
    schema_version: "rsi.judgment_route_id/1",
    route_key,
    route_hash
  });
  return `route:${hash.slice("sha256:".length)}`;
}

export function routeContentHash(draft: Omit<JudgmentRouteRecord, "recorded_at" | "content_hash">): Hash {
  // DD-QP-31d: the object body is the draft and the document content hash is
  // the hash of the document's own canonical bytes, so `content_hash =
  // sha256(JCS(draft))`. The two envelope fields (`recorded_at`,
  // `content_hash`) are not part of the body, so the hash is not
  // self-referential.
  return hashJson(toJsonValue(draft));
}

/**
 * Structural conversion for canonicalization of typed records. Records built
 * by QP contain only JSON values; this guard makes that contract explicit
 * without `any` or a double assertion.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = toJsonValue(entry);
      }
    }
    return result;
  }
  throw new TypeError(`QP record contains a non-JSON value of type ${typeof value}`);
}
