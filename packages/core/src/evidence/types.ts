/**
 * QP domain records (DD-QP-04 … DD-QP-26).
 *
 * Types only. Every JSON record is a strict closed shape; optional fields are
 * declared with `?` and written as explicit `null` where the design says so.
 * Shared primitives (`Id`, `Hash`, `VersionBinding`, `SourceRef`, `Result`,
 * `ErrorEnvelope`) come from `@evoplug/core`; this module never redefines them.
 */


import type { Hash } from "../hash.js";
import type { MethodRef, VersionBinding } from "../version-binding.js";

export type { MethodRef };

import type { JsonValue } from "../json.js";
import type { FailureCode } from "./errors.js";
import type { SourceRef } from "../source-ref.js";

/* ------------------------------------------------------------------------- */
/* Issue records (DD-QP-04)                                                  */
/* ------------------------------------------------------------------------- */

export type IssueType =
  | "constraint_violation"
  | "missing_requirement"
  | "wrong_target"
  | "missing_verification"
  | "goal_change"
  | "insufficient_evidence"
  | "stall_or_regression_candidate"
  | "experience_applicability";

export type IssueState =
  | "proposed"
  | "open"
  | "needs_evidence"
  | "judged"
  | "abstained"
  | "closed"
  | "stale_goal"
  | "rejected";

export type EvidenceGapCode =
  | "source_unretrievable"
  | "interface_contract_missing"
  | "artifact_version_unknown"
  | "verifier_absent"
  | "counterevidence_not_searched"
  | "capture_gap"
  | "template_role_unresolved"
  | "authorization_not_local"
  | "conflicting_sources";

export interface EvidenceGap {
  code: EvidenceGapCode;
  requirement_ids: string[];
  source_refs: SourceRef[];
  affects_question_keys: string[];
}

export interface IssueTrigger {
  kind:
    | "deterministic_check"
    | "user_feedback"
    | "completion_claim"
    | "stable_boundary"
    | "progress_signal"
    | "ledger_correction"
    | "review_snapshot";
  event_ids: string[];
  detector_id: string;
  detector_version: string;
}

export interface IssueConfirmation {
  kind: "human_input" | "verified_fact" | "coverage_gap" | "stable_signal" | "review_snapshot";
  evidence_ids: string[];
  source_refs: SourceRef[];
  confirmed_at_watermark: number;
}

interface ArtifactVersion {
  path: string;
  version: string;
}

interface ExperienceRef {
  snapshot_id: string;
  snapshot_hash: string;
  proposal_id: string;
  proposal_hash: string;
  experience_id: string;
  experience_version: number;
  experience_content_hash: string;
}

export interface ReviewHandoffClosure {
  handoff_id: string;
  handoff_hash: string;
  proposal_id: string;
  proposal_hash: string;
  decision: "proceed" | "unverified";
  review_match_outcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  closure_disposition: "handoff_proceed" | "handoff_unverified";
  snapshot_id: string;
  snapshot_hash: string;
  plan_id: string;
  plan_hash: string;
  question_key: string;
}

export interface CloseEvidenceReviewHandoff {
  handoff_id: string;
  handoff_hash: string;
  proposal_id: string;
  proposal_hash: string;
  decision: "proceed" | "unverified";
  review_match_outcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  snapshot_id: string;
  snapshot_hash: string;
  plan_id: string;
  plan_hash: string;
  question_key: string;
  close_payload_hash: string;
}

export interface SourceHashEntry {
  source_ref: SourceRef;
  content_hash: string;
}

export interface CloseEvidence {
  kind:
    | "verified_behavior"
    | "verified_artifact"
    | "human_acceptance"
    | "coverage_completion"
    | "review_handoff";
  evidence_id: string;
  source_refs: SourceRef[];
  source_hashes: SourceHashEntry[];
  evidence_hash: string;
  goal_version: string;
  recorded_at_watermark: number;
  requirement_ids: string[];
  artifact_version: string | null;
  verifier_ref: string | null;
  review_handoff: CloseEvidenceReviewHandoff | null;
}

export interface ReopenEvidence {
  kind:
    | "contradicting_verification"
    | "artifact_changed"
    | "human_reopen_request"
    | "ledger_correction"
    | "new_evidence";
  evidence_id: string;
  source_refs: SourceRef[];
  source_hashes: SourceHashEntry[];
  recorded_at_watermark: number;
  artifact_version?: string;
  resolved_gap_codes?: EvidenceGapCode[];
  evidence_hash: string;
}

interface IssueRejection {
  kind:
    | "candidate_unconfirmed"
    | "ledger_correction"
    | "requirement_retracted"
    | "duplicate_merged"
    | "review_handoff_terminal";
  source_refs: SourceRef[];
}

export interface Issue {
  schema_version: "rsi.issue/1";
  issue_id: string;
  issue_version: number;
  issue_key: string;
  binding: VersionBinding;
  type: IssueType;
  state: IssueState;
  subject_key: string;
  question_text: string | null;
  requirement_ids: string[];
  artifact_paths: string[];
  artifact_versions: ArtifactVersion[];
  contract_required: boolean;
  contract_paths: string[];
  trigger: IssueTrigger;
  source_event_ids: string[];
  source_refs: SourceRef[];
  evidence_gap: EvidenceGap[];
  confirmation?: IssueConfirmation;
  judgment_ref?: string;
  close_evidence?: CloseEvidence;
  review_handoff_closure?: ReviewHandoffClosure;
  experience_ref?: ExperienceRef;
  reopen_count: number;
  previous_issue_id?: string;
  rejection?: IssueRejection;
  opened_at_watermark: number;
  last_observed_watermark: number;
  created_at: number;
  updated_at: number;
  last_transition_id: string;
}

export interface IssueSummary {
  issue_id: string;
  issue_key: string;
  issue_version: number;
  binding: VersionBinding;
  type: IssueType;
  state: IssueState;
  subject_key: string;
  requirement_ids: string[];
  artifact_paths: string[];
  artifact_versions: ArtifactVersion[];
  contract_required: boolean;
  contract_paths: string[];
  opened_at_watermark: number;
  last_observed_watermark: number;
  previous_issue_id?: string;
}

/* ------------------------------------------------------------------------- */
/* Issue transitions and judgments (DD-QP-04a, DD-QP-05b)                    */
/* ------------------------------------------------------------------------- */

export type IssueTransitionEvent =
  | "propose"
  | "confirm"
  | "reject"
  | "require_evidence"
  | "supply_evidence"
  | "judge"
  | "abstain"
  | "reopen_evidence"
  | "close"
  | "reopen"
  | "review_handoff_close"
  | "review_handoff_reject"
  | "invalidate_goal"
  | "reject_issue"
  | "attach_evidence";

export interface IssueTransitionRecord {
  schema_version: "rsi.issue_transition/1";
  transition_id: string;
  issue_id: string;
  expected_version: number;
  issue_version: number;
  from_state: IssueState | "none";
  to_state: IssueState;
  event: IssueTransitionEvent;
  evidence_refs: SourceRef[];
  judgment_ref: string | null;
  payload_hash: Hash;
  content_hash: Hash;
  task_id: string;
  branch_id: string;
  recorded_at: number;
  issue_after: Issue;
}

type IssueJudgmentDecision =
  | {
      kind: "answer_aggregate";
      aggregate_id: string;
      aggregate_key: string;
      aggregate_hash: string;
      plan_hash: string;
    }
  | {
      kind: "local_facts";
      fact_keys: string[];
    };

type JudgmentBasis = "hard_fact" | "mixed";

type JudgmentOutcome = "consistent" | "inconsistent" | "satisfied" | "not_satisfied";

export interface RequirementResult {
  requirement_id: string;
  proposition_id: string;
  result: "supports" | "contradicts" | "unknown";
  aggregate_key: string | null;
}

export interface IssueJudgment {
  schema_version: "rsi.issue_judgment/1";
  judgment_id: string;
  issue_key: string;
  issue_id: string;
  issue_version: number;
  decision: IssueJudgmentDecision;
  basis: JudgmentBasis;
  outcome: JudgmentOutcome;
  requirement_results: RequirementResult[];
  accepted: true;
  recorded_at_watermark: number;
  judgment_hash: string;
}

export interface IssueJudgmentDraft {
  schema_version: "rsi.issue_judgment/1";
  judgment_id: string;
  issue_key: string;
  issue_id: string;
  issue_version: number;
  decision: IssueJudgmentDecision;
  basis: JudgmentBasis;
  outcome: JudgmentOutcome;
  requirement_results: RequirementResult[];
  accepted: true;
}

export interface AppendIssueTransitionCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  from_state: IssueState | "none";
  to_state: IssueState;
  event: IssueTransitionEvent;
  evidence_refs: SourceRef[];
  issue: Issue;
  judgment?: IssueJudgmentDraft;
}

export interface AppendIssueTransitionResult {
  transition: IssueTransitionRecord;
  issue: Issue;
  judgment: IssueJudgment | null;
  deduplicated: boolean;
}

export interface IssueReadRepository {
  listActive(q: { binding: VersionBinding; states?: readonly IssueState[] }): readonly IssueSummary[];
  getIssue(issue_id: string): Issue | null;
  getIssueJudgment(judgment_id: string): IssueJudgment | null;
  getTransition(transition_id: string): IssueTransitionRecord | null;
}

export interface IssueWriteRepository extends IssueReadRepository {
  appendTransition(command: AppendIssueTransitionCommand): AppendIssueTransitionResult;
}

/* ------------------------------------------------------------------------- */
/* Confirmation, close and reopen evidence (DD-QP-06 … DD-QP-09)             */
/* ------------------------------------------------------------------------- */

export type ConfirmationOrigin = "human" | "agent" | "tool" | "evaluator" | "system" | "unknown";

export type ConfirmationEvidence =
  | {
      kind: "human_input";
      event_id: string;
      origin: ConfirmationOrigin;
      directive_strength: "explicit" | "ambiguous";
      source_refs: SourceRef[];
      requirement_op_id?: string;
    }
  | {
      kind: "verified_fact";
      fact_ids: string[];
      source_refs: SourceRef[];
      artifact_version: string;
      verifier_ref?: string;
    }
  | {
      kind: "coverage_gap";
      coverage_snapshot_id: string;
      source_refs: SourceRef[];
      requirement_id: string;
      missing_codes: EvidenceGapCode[];
    }
  | {
      kind: "stable_signal";
      signal_id: string;
      source_refs: SourceRef[];
      comparable_checkpoints: 2;
      exclusions: Array<{ code: string; source_ref: SourceRef }>;
    }
  | {
      kind: "review_snapshot";
      snapshot_id: string;
      source_refs: SourceRef[];
      experience_ids: string[];
    };

export interface CloseEvidenceDraft {
  kind: "verified_behavior" | "verified_artifact" | "human_acceptance" | "coverage_completion";
  evidence_id: string;
  source_refs: SourceRef[];
  goal_version: string;
  requirement_ids: string[];
  artifact_version: string | null;
  verifier_ref: string | null;
}

export type CloseIssueCommand = {
  transition_id: string;
  issue_id: string;
  expected_version: number;
} & (
  | { mode: "judgment"; close_evidence: CloseEvidenceDraft; handoff_id?: never }
  | { mode: "review_handoff"; handoff_id: string; close_evidence?: never }
);

interface ReopenEvidenceDraft {
  kind: ReopenEvidence["kind"];
  evidence_id: string;
  source_refs: SourceRef[];
  artifact_version?: string;
  resolved_gap_codes?: EvidenceGapCode[];
}

export interface ReopenIssueCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  reopen_evidence: ReopenEvidenceDraft;
}

export interface ConfirmIssueCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  confirmation: ConfirmationEvidence;
}

export interface AttachEvidenceCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  source_event_ids: string[];
  source_refs: SourceRef[];
  gaps: EvidenceGap[];
}

export interface RequireEvidenceCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  gaps: EvidenceGap[];
  reason: "evidence_missing" | "feedback_correction" | "counterevidence";
}

export interface AbstainIssueCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  reason: "budget_exhausted" | "unresolved_conflict";
  gaps: EvidenceGap[];
}

export interface RejectIssueCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  rejection: IssueRejection;
}

export interface InvalidateGoalCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  current_binding: VersionBinding;
}

export interface RecordIssueJudgmentCommand {
  transition_id: string;
  issue_id: string;
  expected_version: number;
  source:
    | {
        kind: "answer_aggregate";
        aggregate_id: string;
        expected_aggregate_hash: string;
        plan_id: string;
        plan_hash: string;
      }
    | {
        kind: "local_facts";
        fact_keys: string[];
      };
}

/* ------------------------------------------------------------------------- */
/* Question templates (DD-QP-11 … DD-QP-17)                                  */
/* ------------------------------------------------------------------------- */

export type JudgeStateViewName =
  | "binding"
  | "question_scope"
  | "requirements"
  | "latest_input"
  | "evidence"
  | "comparison"
  | "coverage"
  | "task_conditions"
  | "experience_candidates";

export type SourceSelector =
  | "latest_input"
  | "active_requirement"
  | "feedback"
  | "artifact_fact"
  | "interface_contract"
  | "verifier_result"
  | "counterevidence"
  | "counterevidence_search"
  | "baseline_checkpoint"
  | "current_checkpoint"
  | "pending_work"
  | "acceptance_criterion"
  | "experience_candidate"
  | "experience_evidence"
  | "task_condition"
  | "unverified_constraint";

export interface RequiredSourceSpec {
  role: string;
  selector: SourceSelector;
  presence: "required" | "optional";
  min_count: number;
  max_count: number;
  required_if?: "issue.contract_required" | "issue.has_completion_claim" | "issue.has_baseline";
  view: JudgeStateViewName;
  selection: "all" | "first_k";
  omission_impact: "answer_changing" | "none";
}

export interface ChoiceOptionMapping {
  semantic_axis:
    | "requirement_compliance"
    | "intent_relation"
    | "progress_effect"
    | "experience_applicability";
  semantic_value: "positive" | "negative" | "neutral" | "unknown";
  option_effect: "supports" | "contradicts" | "unknown";
  issue_effect:
    | "judged_consistent"
    | "judged_inconsistent"
    | "judged_satisfied"
    | "judged_not_satisfied"
    | "candidate_relation_only"
    | "shadow_only"
    | "needs_evidence";
  requires_local_authorization: boolean;
  can_close_issue: false;
  can_satisfy_task: false;
}

export interface ChoiceOption {
  key: string;
  criteria: string;
  mapping: ChoiceOptionMapping;
}

export interface QuestionTemplate {
  schema_version: "rsi.question_template/1";
  template_id: string;
  template_version: string;
  template_hash: string;
  question_type: "choice";
  issue_types: IssueType[];
  cardinality: "per_issue" | "per_requirement" | "per_acceptance_item" | "per_experience_candidate";
  required_views: JudgeStateViewName[];
  required_sources: RequiredSourceSpec[];
  options: ChoiceOption[];
  instructions_template: string;
  question_text_template: string;
  proposition_family: string;
  output_reserve_tokens: number;
  status: "active" | "deprecated";
  supersedes?: { template_id: string; template_version: string };
}

export interface QuestionTemplateRegistry {
  schema_version: "rsi.question_template_registry/1";
  registry_version: string;
  templates: Array<{
    template_id: string;
    template_version: string;
    template_hash: string;
    status: "active" | "deprecated";
  }>;
  registry_hash: string;
}

/* ------------------------------------------------------------------------- */
/* Questions, sources and dependencies (DD-QP-18 … DD-QP-19)                 */
/* ------------------------------------------------------------------------- */

export type EvidenceFactKind = "code" | "interface_contract" | "call" | "result" | "diff" | "test" | "message";

export type PlanSourceKind =
  | "requirement"
  | "feedback"
  | "fact"
  | "code"
  | "interface_contract"
  | "call"
  | "result"
  | "diff"
  | "test"
  | "message"
  | "experience"
  | "comparison"
  | "coverage"
  | "task_condition"
  | "unverified_constraint";

export type SourceRole = "support" | "counter" | "context" | "definition" | "target";

export type TransportRole =
  | "requirement"
  | "feedback"
  | "artifact"
  | "verifier"
  | "counter"
  | "history"
  | "context";

export interface PlanSource {
  source_id: string;
  kind: PlanSourceKind;
  source_refs: SourceRef[];
  content_hash: string;
  version: string | null;
  subject: string | null;
  fact_kind: EvidenceFactKind | null;
  fact_value_hash: string | null;
  role: SourceRole;
  retrievable: boolean;
  requirement_ids: string[];
}

export interface EvidenceDependency {
  dependency_key: string;
  question_keys: string[];
  role: string;
  transport_role: TransportRole;
  selection_rank: number;
  source_ids: string[];
  source_refs: SourceRef[];
  content_hash: string;
  inseparable_group_key: string;
  relation: "supports" | "counter" | "context" | "defines" | "derived";
  omission_impact: "answer_changing" | "none";
  can_omit: boolean;
  derived_view_key: string | null;
}

export interface PlannedQuestion {
  schema_version: "rsi.judge_question/1";
  question_id: string;
  question_key: string;
  slot: string;
  issue_id: string;
  issue_type: IssueType;
  question_type: "choice";
  template_id: string;
  template_version: string;
  template_hash: string;
  instructions: string;
  criteria: Record<string, string>;
  options: string[];
  required_views: JudgeStateViewName[];
  required_source_ids: string[];
  requirement_ids: string[];
  proposition_id: string;
  option_effects: Record<string, "supports" | "contradicts" | "unknown">;
  answer_to_issue_map: Record<string, ChoiceOptionMapping>;
  required_for_issue: true;
  independence: {
    answer_independent: true;
    state_profile: "progress_issue" | "experience_review";
    shareable: boolean;
  };
  output_reserve_tokens: number;
  wire_question: {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
  };
}

/* ------------------------------------------------------------------------- */
/* Plan records (DD-QP-20 … DD-QP-21)                                        */
/* ------------------------------------------------------------------------- */

export interface QuestionPlan {
  schema_version: "rsi.question_plan/1";
  plan_id: string;
  plan_hash: string;
  planner_version: "qp.planner/1";
  issue_id: string;
  issue_key: string;
  issue_type: IssueType;
  issue_version: number;
  binding: VersionBinding;
  state_profile: "progress_issue" | "experience_review";
  registry_version: string;
  registry_hash: string;
  artifact_paths: string[];
  sources: PlanSource[];
  questions: PlannedQuestion[];
  dependencies: EvidenceDependency[];
  required_source_ids: string[];
  required_views: JudgeStateViewName[];
  aggregate_output_reserve_tokens: number;
  planned_at: number;
  supersedes_plan_id?: string;
}

export type PlanLifecycleState =
  | "active"
  | "superseded"
  | "stale_goal"
  | "stale_binding"
  | "stale_template"
  | "rejected";

export interface PlanState {
  schema_version: "rsi.question_plan_state/1";
  plan_id: string;
  state_seq: number;
  state: PlanLifecycleState;
  reason_code: string | null;
  plan_hash: string;
  task_id: string;
  branch_id: string;
  recorded_at: number;
  content_hash: string;
}

export interface PlanStateDraft {
  schema_version: "rsi.question_plan_state/1";
  plan_id: string;
  state_seq: 1;
  state: "active";
  reason_code: null;
  plan_hash: string;
  task_id: string;
  branch_id: string;
}

export interface PutQuestionPlanCommand {
  plan: QuestionPlan;
  initial_state: PlanStateDraft;
  planning_idempotency_key: string;
}

export interface PutQuestionPlanResult {
  plan: QuestionPlan;
  plan_state: PlanState;
  deduplicated: boolean;
}

export interface AppendPlanStateCommand {
  plan_id: string;
  expected_state_seq: number;
  state: PlanLifecycleState;
  reason_code: string | null;
  task_id: string;
  branch_id: string;
}

export interface AppendPlanStateResult {
  plan_state: PlanState;
  deduplicated: boolean;
}

export interface AggregatePlanQuestion {
  question_key: string;
  question_type: "choice";
  template_id: string;
  template_version: string;
  template_hash: string;
  instructions: string;
  criteria: Record<string, string>;
  options: string[];
  required_views: JudgeStateViewName[];
  required_source_ids: string[];
  output_reserve_tokens: number;
  required_for_issue: true;
  proposition_id: string;
  requirement_ids: string[];
  option_effects: Record<string, "supports" | "contradicts" | "unknown">;
  answer_to_issue_map: Record<string, ChoiceOptionMapping>;
  independence: PlannedQuestion["independence"];
}

export interface AggregatePlanView {
  issue_id: string;
  issue_key: string;
  plan_hash: string;
  plan_state: PlanLifecycleState;
  state_profile: "progress_issue" | "experience_review";
  binding: VersionBinding;
  questions: AggregatePlanQuestion[];
}

export type PlanReadResult =
  | { status: "ok"; view: AggregatePlanView }
  | {
      status: "rejected";
      code:
        | "E_PLAN_NOT_FOUND"
        | "E_PLAN_HASH_MISMATCH"
        | "E_PLAN_AGGREGATION_BINDING"
        | "E_VERSION_BINDING";
      details: { stage: "plan_read"; upstream_code?: string; question_key?: string; field?: string };
    };

export interface PlanReadPort {
  readPlanForAggregate(q: {
    plan_id: string;
    expected_plan_hash: string;
    binding: VersionBinding;
  }): PlanReadResult;
}

export interface QuestionPlanRepository extends PlanReadPort {
  getPlan(plan_id: string): QuestionPlan | null;
  getPlanState(plan_id: string): PlanState | null;
  putPlan(command: PutQuestionPlanCommand): PutQuestionPlanResult;
  appendPlanState(command: AppendPlanStateCommand): AppendPlanStateResult;
}

/* ------------------------------------------------------------------------- */
/* JudgeState /2 (DD-QP-23 … DD-QP-24)                                       */
/* ------------------------------------------------------------------------- */

interface JudgeQuestionScope {
  issue_key: string;
  issue_type: IssueType;
  scope_kind: "issue" | "experience_review";
  requirement_ids: string[];
  artifact_paths: string[];
  whole_task_verdict_requested: boolean;
}

export interface JudgeCoverage {
  checked_requirement_ids: string[];
  searched_sources: string[];
  counterevidence_evidence_ids: string[];
  counterevidence_search_complete_for: string[];
  omitted: Array<{
    logical_id: string;
    reason: "budget" | "not_available" | "not_relevant" | "capture_gap";
    affects_question_keys: string[];
  }>;
  missing: Array<{
    code: EvidenceGapCode;
    requirement_id: string | null;
    logical_id: string | null;
    affects_question_keys: string[];
  }>;
  whole_task_coverage_complete: boolean;
}

interface JudgeEvidenceBase {
  display_id: string;
  logical_id: string;
  role: TransportRole;
  excerpt: string;
  artifact_version?: string;
  requirement_ids: string[];
}

interface CodeEvidence extends JudgeEvidenceBase {
  kind: "code";
  path: string;
  version: string;
}

interface InterfaceContractEvidence extends JudgeEvidenceBase {
  kind: "interface_contract";
  path: string;
  version: string;
}

interface TestEvidence extends JudgeEvidenceBase {
  kind: "test";
  command: string;
  tested_snapshot: string;
  exit_code: number | null;
  assertions: Array<{ name: string; result: "pass" | "fail" | "unknown"; requirement_id: string }>;
  not_covered: string[];
}

interface CallEvidence extends JudgeEvidenceBase {
  kind: "call";
  tool: string;
  call_status: "ok" | "error" | "pending";
  call_id: string;
}

interface ResultEvidence extends JudgeEvidenceBase {
  kind: "result";
  call_id: string;
  exit_code: number | null;
  truncated: boolean;
}

interface DiffEvidence extends JudgeEvidenceBase {
  kind: "diff";
  path: string;
  before_version: string;
  after_version: string;
  diff_excerpt: string;
}

interface MessageEvidence extends JudgeEvidenceBase {
  kind: "message";
  message_status: "claim" | "observed" | "verified" | "contradicted" | "unknown";
  origin: ConfirmationOrigin;
}

interface FeedbackEvidence extends JudgeEvidenceBase {
  kind: "feedback";
  signal_kind: string;
  target_issue_id: string | null;
}

interface UnverifiedConstraintEvidence extends JudgeEvidenceBase {
  kind: "unverified_constraint";
  role: "context";
  constraint_status: "unverified_constraint" | "confirmed" | "rejected";
  authorization: false;
  requirement_ids: [];
}

export type JudgeEvidence =
  | CodeEvidence
  | InterfaceContractEvidence
  | TestEvidence
  | CallEvidence
  | ResultEvidence
  | DiffEvidence
  | MessageEvidence
  | FeedbackEvidence
  | UnverifiedConstraintEvidence;

export interface JudgeRequirement {
  display_id: string;
  logical_id: string;
  quote: string;
  valid_from_event: number;
  goal_version: string;
  scope?: { paths?: string[]; excluded_paths?: string[]; objects?: string[] };
  acceptance: {
    kind: "human_acceptance" | "test" | "artifact" | "constraint";
    criterion: string;
    acceptance_ref_id?: string;
  };
}

export interface JudgeLatestInput {
  display_id: string;
  logical_id: string;
  quote: string;
  origin: ConfirmationOrigin;
  directive_strength?: "explicit" | "ambiguous";
  requirement_operation?: "add" | "clarify" | "supersede" | "retract" | "confirm";
  requirement_op_status?: "applied" | "proposed" | "conflict";
  goal_changed: boolean;
}

export interface JudgeComparison {
  comparison_view_key: string;
  before_watermark: number;
  after_watermark: number;
  goal_version: string;
  before_evidence_ids: string[];
  after_evidence_ids: string[];
  new_information: string[];
  pending_calls: string[];
  excluded_hypothesis_ids: string[];
}

export interface ExperienceTriggerView {
  description: string;
  signal_kinds: Array<
    "user_correction" | "repeated_failure" | "recovery_success" | "task_boundary" | "manual"
  >;
  task_family_ids: string[];
  tool_names: string[];
  path_patterns: string[];
  negative_triggers: string[];
}

export interface ExperienceScopeView {
  level: "project" | "user" | "host" | "global";
  project_ids: string[];
  host_ids: string[];
  modes: string[];
  environment_fingerprints: string[];
  tool_version_ranges: Array<{ tool: string; range: string }>;
  model_families: string[];
}

export interface JudgeExperienceCandidate {
  display_id: string;
  logical_id: string;
  experience_id: string;
  version: number;
  content_hash: string;
  type:
    | "recovery_procedure"
    | "tool_workflow"
    | "project_constraint"
    | "user_preference"
    | "validation_check";
  title: string;
  summary: string;
  trigger: ExperienceTriggerView;
  scope: ExperienceScopeView;
  preconditions: Array<{
    precondition_id: string;
    statement: string;
    check_kind: "path_exists" | "tool_available" | "version_in_range" | "evidence_ref" | "human_confirm";
  }>;
  steps: Array<{
    step_id: string;
    action: string;
    inputs: string[];
    expected_observation: string;
    failure_branch?: string;
  }>;
  expected_effects: string[];
  completion_check: {
    kind:
      | "test_pass"
      | "artifact_check"
      | "state_predicate"
      | "human_acceptance"
      | "external_verification"
      | "none";
    description: string;
  };
  counterexamples: Array<{
    counterexample_id: string;
    condition: string;
    observed_failure: string;
    excerpt: string;
  }>;
  risk: "low" | "medium" | "high";
  excerpt: string;
  shortlist: Array<{
    display_id: string;
    logical_id: string;
    experience_id: string;
    version: number;
    content_hash: string;
    relation: "same_family" | "overlap" | "similar_trigger";
    excerpt: string;
  }>;
}

export interface JudgeTaskCondition {
  display_id: string;
  logical_id: string;
  condition_id: string;
  value: string;
  quote: string;
  origin: "human" | "fact" | "config" | "review";
}

interface JudgeStateBase {
  schema_version: "rsi.judge_state/2";
  binding: VersionBinding;
  question_scope: JudgeQuestionScope;
  coverage: JudgeCoverage;
}

interface ProgressIssueJudgeState extends JudgeStateBase {
  profile: "progress_issue";
  requirements: JudgeRequirement[];
  latest_input?: JudgeLatestInput;
  evidence: JudgeEvidence[];
  comparison?: JudgeComparison;
}

interface ExperienceReviewJudgeState extends JudgeStateBase {
  profile: "experience_review";
  requirements: JudgeRequirement[];
  task_conditions: JudgeTaskCondition[];
  experience_candidates: JudgeExperienceCandidate[];
  evidence: JudgeEvidence[];
}

export type JudgeState = ProgressIssueJudgeState | ExperienceReviewJudgeState;

/* ------------------------------------------------------------------------- */
/* Planner inputs and results (DD-QP-08, DD-QP-26)                           */
/* ------------------------------------------------------------------------- */

export interface IssueDiscoveryInput {
  binding: VersionBinding;
  watermark: number;
  progress_from_watermark: number;
  policy_version: string;
  review_snapshot_id?: string;
}

export interface IssueDiscoveryResult {
  status: "ok" | "no_op" | "truncated" | "rejected";
  issues: Issue[];
  proposed_count: number;
  no_op_reason?: "no_issue";
  errors: FailureCode[];
}

export interface IssueTransitionResult {
  status: "ok" | "no_op" | "rejected";
  transition_id: string;
  issue?: Issue;
  judgment?: IssueJudgment;
  deduplicated: boolean;
  errors: FailureCode[];
}

export interface PlanningInput {
  binding: VersionBinding;
  issue: Issue;
  registry: QuestionTemplateRegistry;
  policy_version: string;
  whole_task_verdict_requested?: boolean;
}

/**
 * Gap reported when an issue type has no primary template (DD-QP-12). This is
 * a planning outcome, not a persisted `Issue.evidence_gap`, so it is kept
 * outside the closed `EvidenceGapCode` set.
 */
interface PlanningGap {
  code: EvidenceGapCode | "no_template_for_issue_type";
  requirement_ids: string[];
  source_refs: SourceRef[];
  affects_question_keys: string[];
}

export type PlanningResult =
  | { status: "planned"; plan: QuestionPlan; plan_state: PlanState; deduplicated: boolean }
  | {
      status: "no_op";
      reason: "no_issue" | "local_fact_path" | "no_template" | "duplicate_issue" | "not_planable_state";
      issue_id?: string;
      gap?: PlanningGap;
    }
  | {
      status: "deferred";
      reason: "pending_work" | "waiting_stable_boundary";
      issue_id: string;
      retry_after_watermark?: number;
    }
  | { status: "rejected"; reason: FailureCode; issue_id: string; missing: EvidenceGap[] };

export interface PlanValidationInput {
  plan: QuestionPlan;
  current_binding: VersionBinding;
  registry: QuestionTemplateRegistry;
}

export type PlanValidationResult =
  | { status: "valid" }
  | { status: "stale"; plan_state: "stale_goal" | "stale_binding" | "stale_template"; errors: FailureCode[] }
  | { status: "rejected"; plan_state: "rejected"; errors: FailureCode[] };

export interface ProjectionInput {
  plan: QuestionPlan;
  shard: { shard_id: string; question_keys: string[]; pack_hash: string };
  review_snapshot_id?: string;
}

export type ProjectionResult =
  | { status: "ok"; state: JudgeState }
  | {
      status: "rejected";
      errors: Array<{ code: FailureCode; question_keys: string[]; logical_ids?: string[] }>;
    };

export interface ProjectionValidationInput {
  state: JudgeState;
  plan: QuestionPlan;
  question_keys: string[];
}

export type ProjectionValidationResult =
  | { status: "ok"; required_logical_ids: string[]; present_logical_ids: string[] }
  | {
      status: "rejected";
      errors: Array<{
        code:
          | "E_PROJECTION_VIEW_MISSING"
          | "E_PROJECTION_SOURCE_MISSING"
          | "E_TEMPLATE_BINDING_MISSING"
          | "E_PLAN_STALE";
        question_keys: string[];
        logical_ids?: string[];
      }>;
    };

export interface JudgeStateValidationInput {
  state: JudgeState;
  plan: QuestionPlan;
  question_keys: string[];
}

export type JudgeStateValidationResult =
  | { status: "ok" }
  | { status: "rejected"; errors: Array<{ code: FailureCode; question_keys: string[] }> };

export interface ReviewExperienceInput {
  experience_id: string;
  version: number;
  content_hash: string;
  type: JudgeExperienceCandidate["type"];
  title: string;
  summary: string;
  trigger: ExperienceTriggerView;
  scope: ExperienceScopeView;
  preconditions: JudgeExperienceCandidate["preconditions"];
  steps: JudgeExperienceCandidate["steps"];
  expected_effects: string[];
  completion_check: JudgeExperienceCandidate["completion_check"];
  counterexamples: JudgeExperienceCandidate["counterexamples"];
  risk: "low" | "medium" | "high";
  validation_plan_id: string;
  evidence_refs: SourceRef[];
  excerpt: string;
  source_refs: SourceRef[];
  text_hash: string;
}

export interface ReviewSnapshotView {
  schema_version: "rsi.review_snapshot_view/1";
  snapshot_id: string;
  snapshot_hash: string;
  binding: VersionBinding;
  proposal_id: string;
  /** Optional because DD-REV snapshot views expose only proposal_id. */
  proposal_hash?: string;
  candidate: ReviewExperienceInput;
  shortlist: Array<{
    experience_id: string;
    version: number;
    content_hash: string;
    relation: "same_family" | "overlap" | "similar_trigger";
    excerpt: string;
    source_refs: SourceRef[];
    text_hash: string;
  }>;
  local_checks: {
    static_check_passed: boolean;
    authorization_granted: boolean;
    scope_compatible: boolean;
    version_compatible: boolean;
  };
  source_refs: SourceRef[];
}

export interface ExperienceReviewPlanningInput {
  binding: VersionBinding;
  snapshot: ReviewSnapshotView;
  registry: QuestionTemplateRegistry;
}

type ExperienceReviewRouteState = "planned" | "not_required" | "duplicate" | "degraded" | "rejected";

export interface ExperienceReviewRouteRef {
  route_id: string;
  route_key: string;
  route_hash: string;
  route_class: "experience_match";
  route_state: ExperienceReviewRouteState;
}

export type ExperienceReviewPlanningResult =
  | {
      status: "planned";
      issue: Issue;
      plan: QuestionPlan;
      plan_state: PlanState;
      question_key: string;
      deduplicated: boolean;
      route: ExperienceReviewRouteRef;
      /** Projected `experience_review` JudgeState /2 for the planned question. */
      state?: JudgeState;
    }
  | {
      status: "no_op";
      reason: "not_required" | "duplicate_issue" | "not_planable_state";
      issue_id?: string;
      route: ExperienceReviewRouteRef;
    }
  | {
      status: "rejected";
      reason: FailureCode;
      issue_id?: string;
      missing: EvidenceGap[];
      route: ExperienceReviewRouteRef | null;
    };

/* ------------------------------------------------------------------------- */
/* Ports (owner DTOs referenced type-only; see ports.ts)                     */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* Judgment route (DD-QP-31)                                                 */
/* ------------------------------------------------------------------------- */

type JudgmentRouteClass =
  | "intent_relation"
  | "behavior_relation"
  | "step_effect"
  | "acceptance_relation"
  | "experience_match";

export type JudgmentRouteStageName = "deterministic" | "retrieval" | "semantic" | "verification";
type JudgmentRouteStatus = "planned" | "no_op" | "executed";
type JudgmentRouteStageStatus = "performed" | "skipped" | "unavailable" | "failed";
type JudgmentRouteCoverage = "full" | "partial" | "unknown";
export type JudgmentRouteCostStatus = "known" | "partial" | "unknown" | "not_applicable";

export type JudgmentRouteReason =
  | "deterministic_decisive"
  | "deterministic_inconclusive"
  | "retrieval_required"
  | "retrieval_gap"
  | "retrieval_truncated"
  | "semantic_not_needed"
  | "semantic_disabled"
  | "semantic_unavailable"
  | "semantic_shadow"
  | "semantic_unknown"
  | "verification_existing_fact"
  | "verification_absent"
  | "verification_failed"
  | "verification_not_independent"
  | "scope_mismatch"
  | "version_stale"
  | "counterevidence"
  | "conflict"
  | "budget_exhausted"
  | "deadline_exceeded"
  | "rate_limited"
  | "cancelled"
  | "late_discarded"
  | "skipped_by_order"
  | "owner_unavailable";

type JudgmentRoutePolicyFactor = "experience_global_scope" | "experience_high_risk";

interface JudgmentRouteScope {
  subject_key: string;
  subject_versions: string[];
}

interface JudgmentRouteEvidenceScope {
  subject_keys: string[];
  subject_versions: string[];
  coverage: JudgmentRouteCoverage;
}

interface JudgmentRouteEvidence {
  source_ref: SourceRef;
  content_hash: string;
  role: "direct" | "recall" | "counter" | "context";
  scope: JudgmentRouteEvidenceScope;
}

interface JudgmentRouteSemanticEligibility {
  backend_key: string;
  capability_hash: string;
  semantic_scope_key: string;
}

interface JudgmentRoutePlanRef {
  plan_id: string;
  plan_hash: string;
}

interface JudgmentRouteAggregateRef {
  aggregate_id: string;
  aggregate_hash: string;
}

interface JudgmentRouteAttemptRef {
  kind: "judge_attempt" | "late_judge_result";
  result_id: string;
  result_hash: string;
}

interface JudgmentRouteVerification {
  fact_id: string;
  fact_content_hash: string;
  verifier_ref: string;
  producer_ref: string;
  independent: boolean;
  verification_plan_id: string;
  verification_plan_hash: string;
  covered_subject_keys: string[];
  covered_versions: string[];
}

export interface JudgmentRouteCost {
  elapsed_ms: number;
  cpu_ms: number | null;
  read_bytes: number;
  retrieval_count: number;
  model_invocations: number;
  input_tokens: number | null;
  output_tokens: number | null;
  verifier_invocations: number;
  amount: string | null;
  currency: string | null;
  cost_status: JudgmentRouteCostStatus;
  receipt_ref: string | null;
}

interface JudgmentRouteDeadline {
  total_ms: number;
  deterministic_ms: number;
  retrieval_ms: number;
  semantic_ms: number;
  verification_ms: number;
}

export interface JudgmentRouteStage {
  stage: JudgmentRouteStageName;
  status: JudgmentRouteStageStatus;
  method: MethodRef | null;
  evidence: JudgmentRouteEvidence[];
  result_refs: JudgmentRouteAttemptRef[];
  verification: JudgmentRouteVerification | null;
  reason_codes: JudgmentRouteReason[];
  cost: JudgmentRouteCost;
}

interface JudgmentRouteEscalation {
  kind: "clarification" | "authorization";
  reason_code: "execution_blocking_clarification" | "authorization_required";
}

export interface JudgmentRouteRecord {
  schema_version: "rsi.judgment_route/1";
  route_id: string;
  route_key: string;
  route_hash: string;
  route_status: JudgmentRouteStatus;
  route_policy_version: "qp.route/1";
  route_class: JudgmentRouteClass;
  project_id: string | null;
  binding: VersionBinding;
  scope: JudgmentRouteScope;
  issue_key: string | null;
  question_key: string | null;
  template_binding: { template_id: string; template_version: string; template_hash: string } | null;
  plan_ref: JudgmentRoutePlanRef | null;
  aggregate_ref: JudgmentRouteAggregateRef | null;
  semantic_eligibility: JudgmentRouteSemanticEligibility | null;
  evidence_set_hash: string;
  stages: JudgmentRouteStage[];
  gaps: EvidenceGap[];
  reason_codes: JudgmentRouteReason[];
  policy_factors: JudgmentRoutePolicyFactor[];
  escalation: JudgmentRouteEscalation | null;
  deadline: JudgmentRouteDeadline;
  deadline_ref: string | null;
  total_cost: JudgmentRouteCost;
  budget_receipt_ref: string | null;
  consumer_ref:
    | { kind: "issue_transition" | "answer_aggregate" | "review_handoff"; ref_id: string }
    | { kind: "none"; ref_id: null };
  recorded_at: number;
  content_hash: string;
}

export type JudgmentRouteDraft = Omit<JudgmentRouteRecord, "recorded_at" | "content_hash">;

export interface JudgmentRouteAppendRequest {
  draft: JudgmentRouteDraft;
  current_action: string | null;
  escalation_source: JsonValue | null;
}

export interface JudgmentRouteAppendResult {
  record: JudgmentRouteRecord;
  interaction_handoff: {
    route_ref: {
      schema_version: "rsi.host_interaction_route_ref/1";
      route_id: string;
      route_hash: string;
      route_status: JudgmentRouteStatus;
      binding: VersionBinding;
      escalation: JudgmentRouteEscalation;
    };
    escalation_source: JsonValue;
  } | null;
}

