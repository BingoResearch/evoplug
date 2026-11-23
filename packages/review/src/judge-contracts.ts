/**
 * QP and EVD judge ABI consumed by REV (DD-REV-070, DD-REV-140).
 *
 * QP owns the single `JudgmentRouteRecord`; REV stores only the three route
 * references (`route_id`, `route_hash`, `route_class`) and the frozen
 * `question_key`. EVD owns the typed judge envelope; REV never builds a
 * second answer schema.
 */

import type { ErrorEnvelope, Hash, Result, SourceRef, VersionBinding } from "@evoplug/core";



type JudgmentRouteState = "planned" | "not_required" | "duplicate" | "degraded" | "rejected";

export interface ExperienceReviewRouteRef {
  route_id: string;
  route_key: Hash;
  route_hash: Hash;
  route_class: "experience_match";
  route_state: JudgmentRouteState;
}

export interface ReviewExperienceInput {
  experience_id: string;
  version: number;
  content_hash: Hash;
  type: string;
  risk: string;
  scope: unknown;
  excerpt: string;
  source_refs: SourceRef[];
  text_hash: Hash;
}

export interface ReviewSnapshotView {
  schema_version: "rsi.review_snapshot_view/1";
  snapshot_id: string;
  snapshot_hash: Hash;
  binding: VersionBinding;
  proposal_id: string;
  candidate: ReviewExperienceInput;
  shortlist: ReviewExperienceInput[];
  local_checks: {
    static_check_passed: boolean;
    authorization_granted: boolean;
    scope_compatible: boolean;
    version_compatible: boolean;
  };
  source_refs: SourceRef[];
}

export interface ExperienceReviewPlanningInput {
  schema_version: "rsi.experience_review_planning_in/1";
  binding: VersionBinding;
  snapshot: ReviewSnapshotView;
  template: {
    template_id: "qt.experience_match";
    template_version: "1.0.0";
    template_hash: Hash;
    options: ["applicable", "conflict", "unknown"];
  };
  deadline_at: number;
}

export interface PlannedQuestion {
  question_key: string;
  question_id: string;
  template_id: "qt.experience_match";
  template_version: "1.0.0";
  template_hash: Hash;
  option_order: Array<"applicable" | "conflict" | "unknown">;
  issue_id: string;
}

export interface ExperienceReviewPlanResult {
  plan_id: string;
  plan_hash: Hash;
  issue_id: string;
  question_key: string;
  questions: PlannedQuestion[];
}

export type ExperienceReviewPlanningResult =
  | {
      schema_version: "rsi.experience_review_planning_result/1";
      outcome: "planned";
      route: ExperienceReviewRouteRef;
      plan: ExperienceReviewPlanResult;
    }
  | {
      schema_version: "rsi.experience_review_planning_result/1";
      outcome: "no_op";
      route: ExperienceReviewRouteRef;
      reason: "not_required" | "duplicate_issue" | "not_planable_state";
      issue_id?: string;
      plan: null;
      failure_code?: string;
      missing?: string[];
    }
  | {
      schema_version: "rsi.experience_review_planning_result/1";
      outcome: "rejected";
      route: ExperienceReviewRouteRef;
      failure_code: string;
      missing: string[];
      plan: null;
    };

export interface QuestionPlanner {
  planExperienceReview(
    input: ExperienceReviewPlanningInput
  ): Promise<Result<ExperienceReviewPlanningResult, ErrorEnvelope>>;
}

export interface TemplateBinding {
  question_key: string;
  template_id: "qt.experience_match";
  template_version: "1.0.0";
  template_hash: Hash;
}

export interface EvidenceInput {
  evidence_id: string;
  source_ref: SourceRef;
  content_hash: Hash;
  text: string;
  truncated: boolean;
}

export interface JudgeRunBudget {
  max_input_tokens: number;
  max_output_tokens: number;
  wall_ms: number;
  deadline_at: number;
}

export interface ExperienceMatchJudgeInput {
  schema_version: "rsi.experience_match_judge_in/1";
  purpose: "experience_match";
  plan_id: string;
  plan_hash: Hash;
  question_ids: string[];
  version_binding: VersionBinding;
  issue_id: string;
  template_bindings: TemplateBinding[];
  service_profile_id: string;
  budget: JudgeRunBudget;
  questions: Array<{
    question_id: string;
    question_key: string;
    question: string;
    options: Array<"applicable" | "conflict" | "unknown">;
  }>;
  evidence: EvidenceInput[];
}

export interface JudgeTemplateBindingReceipt {
  question_key: string;
  template_id: "qt.experience_match";
  template_version: "1.0.0";
  template_hash: Hash;
}

export interface JudgeInvocationResult {
  status: "accepted" | "degraded" | "rejected" | "unknown" | "cancelled";
  invocation_id?: string;
  attempt_id?: string;
  envelope_id?: string;
  envelope_key?: Hash;
  binding_id?: string;
  validator_binding_id?: string;
  validator_binding_key?: Hash;
  question_bindings_digest?: Hash;
  request_hash?: Hash;
  dispatch_key?: Hash;
  service_profile_id?: string;
  validator_version?: string;
  template_bindings?: JudgeTemplateBindingReceipt[];
  match_outcome?: "applicable" | "conflict" | "unknown" | "not_applicable";
  confidence?: number | null;
  answers?: Array<{
    question_id: string;
    choice: "applicable" | "conflict" | "unknown";
    free_text?: string;
  }>;
  failure_code?: string;
  missing?: string[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_micros?: number;
    cost_status?: "known" | "unknown" | "not_applicable";
    usage_refs?: SourceRef[];
  };
}

export interface ExperienceMatchJudgeResult {
  schema_version: "rsi.experience_match_judge_result/1";
  candidate_disposition: "unverified";
  result: JudgeInvocationResult;
}

export interface JudgeService {
  judgeExperienceMatch(
    input: ExperienceMatchJudgeInput
  ): Promise<Result<ExperienceMatchJudgeResult, ErrorEnvelope>>;
}

export interface JevServiceProfile {
  schema_version: "rsi.jev_service_profile/1";
  service_profile_id: string;
  acceptance: {
    status: "eligible" | "shadow_only" | "ineligible" | "unknown";
    evidence_ref: SourceRef | null;
  };
  limits: {
    request_max_tokens: number;
    max_output_tokens: number;
    rpm: number | null;
    concurrency: number | null;
  };
}

export interface JevServiceProfileReadPort {
  select(input: {
    purpose: "experience_match";
    template_hash: Hash;
    deadline_at: number;
  }): Promise<Result<JevServiceProfile | null, ErrorEnvelope>>;
}

export interface EvidenceReadPort {
  readApproved(input: {
    refs: SourceRef[];
    approved: SourceRef[];
    max_bytes_per_ref: number;
    deadline_at: number;
  }): Promise<Result<Map<SourceRef, { bytes: Uint8Array; text: string; content_hash: Hash }>, ErrorEnvelope>>;
}

export interface VerifierRegistryEntry {
  binding_ref: SourceRef;
  kind:
    | "test_pass"
    | "artifact_check"
    | "state_predicate"
    | "human_acceptance"
    | "external_verification"
    | "none";
  independence: "independent" | "same_task_replay" | "user_confirmation" | "none";
}

export interface VerifierRegistryPort {
  resolve(verifier_ref: SourceRef): Promise<Result<VerifierRegistryEntry, ErrorEnvelope>>;
}

