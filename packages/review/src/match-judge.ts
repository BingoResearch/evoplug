/**
 * experience_match_judge routing and EVD result mapping (DD-REV-070).
 *
 * REV never authors a route, never treats shortlist similarity as evidence and
 * never upgrades a Jev result into an applicability conclusion. Every judge
 * path leaves the Proposal `unverified`.
 */

import { canonicalHash, compareUtf8, toJsonValue } from "@evoplug/core";
import type { Hash, JsonValue, Result, SourceRef, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ErrorEnvelope } from "@evoplug/core";

import {
  egressNotApproved,
  revError
} from "./errors.js";
import type {
  EgressDecisionPort,
  EgressRequestView
} from "./egress-contracts.js";
import type {
  EvidenceInput,
  ExperienceMatchJudgeInput,
  ExperienceMatchJudgeResult,
  ExperienceReviewPlanningResult,
  ExperienceReviewPlanResult,
  ExperienceReviewRouteRef,
  JevServiceProfile,
  JudgeInvocationResult,
  JudgeService,
  PlannedQuestion,
  QuestionPlanner,
  ReviewExperienceInput,
  ReviewSnapshotView,
  TemplateBinding,
  VerifierRegistryEntry
} from "./judge-contracts.js";
import type {
  Experience,
  ExperienceCandidate,
  ExperienceRisk,
  MatchJudgeStatus,
  Proposal,
  ProposalCandidate,
  ProposalMatchJudge,
  ReviewHandoffProposal,
  ReviewJob,
  ReviewSnapshot,
  ValidationPlan
} from "./types.js";

export const EXPERIENCE_MATCH_TEMPLATE_ID = "qt.experience_match" as const;
export const EXPERIENCE_MATCH_TEMPLATE_VERSION = "1.0.0" as const;
export const EXPERIENCE_MATCH_TEMPLATE_OPTIONS: readonly ["applicable", "conflict", "unknown"] = [
  "applicable",
  "conflict",
  "unknown"
];

export function experienceMatchTemplateHash(): Hash {
  return canonicalHash(
    toJsonValue({
      template_id: EXPERIENCE_MATCH_TEMPLATE_ID,
      template_version: EXPERIENCE_MATCH_TEMPLATE_VERSION,
      options: EXPERIENCE_MATCH_TEMPLATE_OPTIONS
    })
  );
}

/* ------------------------------------------------------------------ */
/* QP result mapping                                                   */
/* ------------------------------------------------------------------ */

export interface RouteMapping {
  projection: MatchJudgeProjection;
  plan: ExperienceReviewPlanResult | null;
  route: ExperienceReviewRouteRef | null;
}

export interface MatchJudgeProjection {
  status: MatchJudgeStatus;
  route_id: string | null;
  route_hash: Hash | null;
  route_class: "experience_match" | null;
  question_key: string | null;
  plan_id: string | null;
  plan_hash: Hash | null;
  issue_id: string | null;
  degrade_reason: string | null;
}

function emptyProjection(status: MatchJudgeStatus, reason: string | null): MatchJudgeProjection {
  return {
    status,
    route_id: null,
    route_hash: null,
    route_class: null,
    question_key: null,
    plan_id: null,
    plan_hash: null,
    issue_id: null,
    degrade_reason: reason
  };
}

export function routeShapeValid(route: ExperienceReviewRouteRef | null | undefined): route is ExperienceReviewRouteRef {
  if (route === null || route === undefined) {
    return false;
  }
  return (
    typeof route.route_id === "string" &&
    route.route_id.length > 0 &&
    typeof route.route_hash === "string" &&
    route.route_hash.startsWith("sha256:") &&
    route.route_class === "experience_match" &&
    (route.route_state === "planned" ||
      route.route_state === "not_required" ||
      route.route_state === "duplicate" ||
      route.route_state === "degraded" ||
      route.route_state === "rejected")
  );
}

/**
 * QP result table. A missing or malformed route degrades the Proposal and
 * clears all three route fields; it never synthesizes a local route.
 */
export function mapQpResult(
  result:
    | Result<ExperienceReviewPlanningResult, ErrorEnvelope>
    | ExperienceReviewPlanningResult
    | null
): RouteMapping {
  if (result === null) {
    return { projection: emptyProjection("degraded", "qp_unavailable"), plan: null, route: null };
  }
  let value: ExperienceReviewPlanningResult;
  if ("ok" in result) {
    if (!result.ok) {
      return { projection: emptyProjection("degraded", "qp_unavailable"), plan: null, route: null };
    }
    value = result.value;
  } else {
    value = result;
  }
  const route = routeShapeValid(value.route) ? value.route : null;
  if (route === null) {
    return { projection: emptyProjection("degraded", "route_missing"), plan: null, route: null };
  }
  switch (value.outcome) {
    case "planned": {
      if (route.route_state !== "planned") {
        return {
          projection: emptyProjection("degraded", "route_state_mismatch"),
          plan: null,
          route: null
        };
      }
      return {
        projection: {
          status: "pending",
          route_id: route.route_id,
          route_hash: route.route_hash,
          route_class: route.route_class,
          question_key: value.plan.question_key,
          plan_id: value.plan.plan_id,
          plan_hash: value.plan.plan_hash,
          issue_id: value.plan.issue_id,
          degrade_reason: null
        },
        plan: value.plan,
        route
      };
    }
    case "no_op": {
      switch (value.reason) {
        case "not_required":
          if (route.route_state !== "not_required") {
            return {
              projection: emptyProjection("degraded", "route_state_mismatch"),
              plan: null,
              route: null
            };
          }
          return {
            projection: {
              status: "not_required",
              route_id: route.route_id,
              route_hash: route.route_hash,
              route_class: route.route_class,
              question_key: null,
              plan_id: null,
              plan_hash: null,
              issue_id: value.issue_id ?? null,
              degrade_reason: null
            },
            plan: null,
            route
          };
        case "duplicate_issue":
          if (route.route_state !== "duplicate") {
            return {
              projection: emptyProjection("degraded", "route_state_mismatch"),
              plan: null,
              route: null
            };
          }
          return {
            projection: {
              status: "reused",
              route_id: route.route_id,
              route_hash: route.route_hash,
              route_class: route.route_class,
              question_key: null,
              plan_id: null,
              plan_hash: null,
              issue_id: value.issue_id ?? null,
              degrade_reason: null
            },
            plan: null,
            route
          };
        case "not_planable_state":
          return {
            projection: {
              status: "degraded",
              route_id: route.route_id,
              route_hash: route.route_hash,
              route_class: route.route_class,
              question_key: null,
              plan_id: null,
              plan_hash: null,
              issue_id: value.issue_id ?? null,
              degrade_reason: "not_planable_state"
            },
            plan: null,
            route
          };
      }
    }
    case "rejected":
      return {
        projection: {
          status: "degraded",
          route_id: route.route_id,
          route_hash: route.route_hash,
          route_class: route.route_class,
          question_key: null,
          plan_id: null,
          plan_hash: null,
          issue_id: null,
          degrade_reason: value.failure_code
        },
        plan: null,
        route
      };
  }
}

export function applyProjection(judge: ProposalMatchJudge, projection: MatchJudgeProjection): ProposalMatchJudge {
  const next: ProposalMatchJudge = {
    ...judge,
    status: projection.status,
    route_id: projection.route_id,
    route_hash: projection.route_hash,
    route_class: projection.route_class
  };
  if (projection.plan_id !== null) {
    next.plan_id = projection.plan_id;
  } else {
    delete next.plan_id;
  }
  if (projection.plan_hash !== null) {
    next.plan_hash = projection.plan_hash;
  } else {
    delete next.plan_hash;
  }
  if (projection.issue_id !== null) {
    next.issue_id = projection.issue_id;
  } else {
    delete next.issue_id;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Five deterministic checks                                           */
/* ------------------------------------------------------------------ */

export interface DeterministicCheckInput {
  candidate: ExperienceCandidate;
  binding: VersionBinding;
  experience_version: number;
  experience_binding: VersionBinding;
  scope: Experience["scope"];
  target: { host_id: string; project_id: string | null; mode: string };
  now: number;
  expires_at: number | null;
  host_versions: { host_id: string; mode: string; tool_versions: Record<string, string> } | null;
  counterexample_hit: boolean;
}

export interface DeterministicChecks {
  scope: boolean;
  version: boolean;
  expiry: boolean;
  interface: boolean;
  counterexample: boolean;
}

/** Exclusion checks only; passing them never proves applicability. */
export function runDeterministicChecks(input: DeterministicCheckInput): DeterministicChecks {
  const scopeLevel = input.scope.level;
  const scopePass =
    (scopeLevel === "project" &&
      input.target.project_id !== null &&
      input.scope.project_ids.includes(input.target.project_id)) ||
    (scopeLevel === "host" &&
      input.scope.host_ids.includes(input.target.host_id as Experience["scope"]["host_ids"][number])) ||
    scopeLevel === "user" ||
    scopeLevel === "global";
  const modesPass =
    input.scope.modes.length === 0 || input.scope.modes.includes(input.target.mode);
  const versionPass =
    input.binding.task_id === input.experience_binding.task_id &&
    input.binding.branch_id === input.experience_binding.branch_id &&
    input.binding.input_epoch === input.experience_binding.input_epoch &&
    input.binding.goal_version === input.experience_binding.goal_version;
  const expiryPass = input.expires_at === null || input.now < input.expires_at;
  const interfacePass =
    input.host_versions === null ||
    input.scope.tool_version_ranges.every((range) => {
      const current = input.host_versions?.tool_versions[range.tool];
      return current !== undefined;
    });
  const counterexamplePass = !input.counterexample_hit;
  return {
    scope: scopePass && modesPass,
    version: versionPass,
    expiry: expiryPass,
    interface: interfacePass,
    counterexample: counterexamplePass
  };
}

export function allDeterministicChecksPass(checks: DeterministicChecks): boolean {
  return checks.scope && checks.version && checks.expiry && checks.interface && checks.counterexample;
}

/* ------------------------------------------------------------------ */
/* QP input and dispatch                                               */
/* ------------------------------------------------------------------ */

export function buildReviewExperienceInput(input: {
  experience_id: string;
  version: number;
  content_hash: Hash;
  type: string;
  risk: string;
  scope: unknown;
  excerpt: string;
  source_refs: SourceRef[];
}): ReviewExperienceInput {
  return {
    experience_id: input.experience_id,
    version: input.version,
    content_hash: input.content_hash,
    type: input.type,
    risk: input.risk,
    scope: input.scope,
    excerpt: input.excerpt,
    source_refs: [...input.source_refs].sort(compareUtf8),
    text_hash: canonicalHash(toJsonValue(input.excerpt))
  };
}

export function buildReviewSnapshotView(input: {
  snapshot: ReviewSnapshot;
  proposal: Proposal;
  candidate: ReviewExperienceInput;
  shortlist: ReviewExperienceInput[];
  local_checks: ReviewSnapshotView["local_checks"];
  source_refs: SourceRef[];
}): ReviewSnapshotView {
  return {
    schema_version: "rsi.review_snapshot_view/1",
    snapshot_id: input.snapshot.snapshot_id,
    snapshot_hash: input.snapshot.snapshot_hash,
    binding: input.snapshot.version_binding,
    proposal_id: input.proposal.proposal_id,
    candidate: input.candidate,
    shortlist: input.shortlist,
    local_checks: input.local_checks,
    source_refs: [...input.source_refs].sort(compareUtf8)
  };
}

export function canCallPlanner(localChecks: ReviewSnapshotView["local_checks"]): boolean {
  return (
    localChecks.static_check_passed &&
    localChecks.authorization_granted &&
    localChecks.scope_compatible &&
    localChecks.version_compatible
  );
}

export async function planExperienceReviewWithPolicy(
  planner: QuestionPlanner,
  input: import("./judge-contracts.js").ExperienceReviewPlanningInput
): Promise<RouteMapping> {
  try {
    const result = await planner.planExperienceReview(input);
    return mapQpResult(result);
  } catch {
    return { projection: emptyProjection("degraded", "qp_unavailable"), plan: null, route: null };
  }
}

/* ------------------------------------------------------------------ */
/* Judge request and result                                            */
/* ------------------------------------------------------------------ */

export interface JudgeDispatchInput {
  plan: ExperienceReviewPlanResult;
  route: ExperienceReviewRouteRef;
  binding: VersionBinding;
  project_id: string | null;
  service_profile: JevServiceProfile;
  budget: ExperienceMatchJudgeInput["budget"];
  evidence: EvidenceInput[];
  template_hash: Hash;
  egress: EgressDecisionPort;
  endpoint: string;
  model_id: string;
  approved_evidence_refs: ReadonlySet<SourceRef>;
}

export interface JudgeDispatchPlan {
  input: ExperienceMatchJudgeInput;
  egress: EgressRequestView;
}

/** Builds the typed judge input after the profile and template gates. */
export async function prepareJudgeDispatch(
  input: JudgeDispatchInput
): Promise<Result<JudgeDispatchPlan, ErrorEnvelope>> {
  void input.project_id;
  if (input.service_profile.acceptance.status !== "eligible") {
    return err(
      revError({
        code: "E_REVIEW_EGRESS_NOT_APPROVED",
        details: {
          kind: "egress",
          policy_version: "egress/default",
          denied_dimension: "approval",
          refs: []
        }
      })
    );
  }
  const templateBindings: TemplateBinding[] = [];
  for (const question of input.plan.questions) {
    if (
      question.template_id !== EXPERIENCE_MATCH_TEMPLATE_ID ||
      question.template_version !== EXPERIENCE_MATCH_TEMPLATE_VERSION ||
      question.template_hash !== input.template_hash
    ) {
      return err(
        revError({
          code: "E_TEMPLATE_BINDING_MISSING",
          stage: "judge",
          details: { kind: "field", path: "template_bindings", rule: "template_binding_missing" }
        })
      );
    }
    templateBindings.push({
      question_key: question.question_key,
      template_id: EXPERIENCE_MATCH_TEMPLATE_ID,
      template_version: EXPERIENCE_MATCH_TEMPLATE_VERSION,
      template_hash: input.template_hash
    });
  }
  for (const item of input.evidence) {
    if (!input.approved_evidence_refs.has(item.source_ref)) {
      return err(egressNotApproved({ policyVersion: "egress/default", refs: [item.source_ref] }));
    }
  }
  const sources = [...new Set(input.evidence.map((item) => item.source_ref))].sort(compareUtf8);
  let decision: Result<EgressRequestView, ErrorEnvelope>;
  try {
    decision = await input.egress.decide({
      purpose: "review_match",
      binding: input.binding,
      sources,
      endpoint: input.endpoint,
      model_id: input.model_id
    });
  } catch {
    decision = err(
      revError({
        code: "E_REVIEW_EGRESS_NOT_APPROVED",
        details: {
          kind: "egress",
          policy_version: "egress/default",
          denied_dimension: "endpoint",
          refs: sources
        }
      })
    );
  }
  if (!decision.ok) {
    return err(decision.error);
  }
  if (!decision.value.allowed) {
    return err(
      egressNotApproved({
        policyVersion: "egress/default",
        refs: sources,
        deniedDimension: "approval"
      })
    );
  }
  const decided = new Set(decision.value.sources);
  if (
    decided.size !== sources.length ||
    sources.some((source) => !decided.has(source))
  ) {
    // An "allowed" decision that omits (or widens) the requested sources is
    // not approval for this request.
    return err(
      egressNotApproved({
        policyVersion: "egress/default",
        refs: sources,
        deniedDimension: "approval"
      })
    );
  }
  const questionIds = input.plan.questions.map((question) => question.question_id);
  return ok({
    input: {
      schema_version: "rsi.experience_match_judge_in/1",
      purpose: "experience_match",
      plan_id: input.plan.plan_id,
      plan_hash: input.plan.plan_hash,
      question_ids: questionIds,
      version_binding: input.binding,
      issue_id: input.plan.issue_id,
      template_bindings: templateBindings,
      service_profile_id: input.service_profile.service_profile_id,
      budget: input.budget,
      questions: input.plan.questions.map((question) => ({
        question_id: question.question_id,
        question_key: question.question_key,
        question: "Does this experience apply to the current task?",
        options: [...EXPERIENCE_MATCH_TEMPLATE_OPTIONS]
      })),
      evidence: input.evidence
    },
    egress: decision.value
  });
}

export function validateJudgeTemplateBindings(
  input: ExperienceMatchJudgeInput
): boolean {
  if (input.template_bindings.length !== input.question_ids.length) {
    throw new TemplateBindingMissingError("template_bindings", "length");
  }
  for (const binding of input.template_bindings) {
    if (
      binding.template_id !== EXPERIENCE_MATCH_TEMPLATE_ID ||
      binding.template_version !== EXPERIENCE_MATCH_TEMPLATE_VERSION ||
      typeof binding.template_hash !== "string" ||
      !binding.template_hash.startsWith("sha256:")
    ) {
      throw new TemplateBindingMissingError(binding.question_key, "template_hash");
    }
  }
  return true;
}

/** Named error for a missing or mismatched QP template binding. */
export class TemplateBindingMissingError extends Error {
  constructor(questionKey: string, rule: string) {
    super(`E_TEMPLATE_BINDING_MISSING: ${questionKey}/${rule}`);
    this.name = "E_TEMPLATE_BINDING_MISSING";
  }
}

export interface JudgeOutcome {
  status: MatchJudgeStatus;
  match_outcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  binding: JudgeInvocationResult;
}

/** Result table: every status leaves the Proposal `unverified`. */
export function mapJudgeResult(  result: Result<ExperienceMatchJudgeResult, ErrorEnvelope>
): JudgeOutcome | null {
  if (!result.ok) {
    return null;
  }
  const invocation = result.value.result;
  switch (invocation.status) {
    case "accepted": {
      const outcome = invocation.match_outcome;
      if (
        outcome !== "applicable" &&
        outcome !== "conflict" &&
        outcome !== "unknown" &&
        outcome !== "not_applicable"
      ) {
        return { status: "unknown", match_outcome: null, binding: invocation };
      }
      return { status: "accepted", match_outcome: outcome, binding: invocation };
    }
    case "degraded":
      return { status: "degraded", match_outcome: null, binding: invocation };
    case "rejected":
      return { status: "rejected", match_outcome: null, binding: invocation };
    case "unknown":
    case "cancelled":
      return { status: "unknown", match_outcome: null, binding: invocation };
  }
}

function isProposalRecord(value: ProposalMatchJudge | Proposal): value is Proposal {
  return typeof value === "object" && value !== null && "proposal_id" in value && "match_judge" in value;
}

export function applyJudgeOutcome(
  judge: ProposalMatchJudge,
  outcome: JudgeOutcome
): ProposalMatchJudge;
export function applyJudgeOutcome(
  proposal: Proposal,
  outcome: JudgeOutcome
): ProposalMatchJudge;
export function applyJudgeOutcome(
  input: ProposalMatchJudge | Proposal,
  outcome: JudgeOutcome
): ProposalMatchJudge {
  if (isProposalRecord(input)) {
    // Proposal-shaped input: merge the judge outcome over the Proposal
    // projection while keeping the Proposal fields intact for callers that
    // carry the result forward.
    const merged = applyJudgeOutcome(input.match_judge, outcome);
    return { ...input, ...merged, match_judge: input.match_judge } as ProposalMatchJudge;
  }
  const judge = input;
  const next: ProposalMatchJudge = {
    ...judge,
    status: outcome.status,
    template_id: EXPERIENCE_MATCH_TEMPLATE_ID,
    template_version: EXPERIENCE_MATCH_TEMPLATE_VERSION
  };
  if (outcome.match_outcome !== null) {
    next.match_outcome = outcome.match_outcome;
  } else {
    delete next.match_outcome;
  }
  const binding = outcome.binding;
  if (binding.invocation_id !== undefined) next.invocation_id = binding.invocation_id;
  if (binding.attempt_id !== undefined) next.attempt_id = binding.attempt_id;
  if (binding.envelope_id !== undefined) next.envelope_id = binding.envelope_id;
  if (binding.envelope_key !== undefined) next.envelope_key = binding.envelope_key;
  if (binding.binding_id !== undefined) next.binding_id = binding.binding_id;
  if (binding.validator_binding_id !== undefined) next.validator_binding_id = binding.validator_binding_id;
  if (binding.validator_binding_key !== undefined) next.validator_binding_key = binding.validator_binding_key;
  if (binding.question_bindings_digest !== undefined) {
    next.question_bindings_digest = binding.question_bindings_digest;
  }
  if (binding.request_hash !== undefined) next.request_hash = binding.request_hash;
  if (binding.dispatch_key !== undefined) next.dispatch_key = binding.dispatch_key;
  if (binding.service_profile_id !== undefined) next.service_profile_id = binding.service_profile_id;
  if (binding.validator_version !== undefined) next.validator_version = binding.validator_version;
  return next;
}

export async function invokeJudge(
  judge: JudgeService,
  input: ExperienceMatchJudgeInput
): Promise<Result<ExperienceMatchJudgeResult, ErrorEnvelope>> {
  try {
    return await judge.judgeExperienceMatch(input);
  } catch {
    return err(
      revError({
        code: "E_REVIEW_BACKEND_EXIT",
        details: { kind: "external", provider: "jev" }
      })
    );
  }
}

/* ------------------------------------------------------------------ */
/* Handoff decision and auto-adoption                                  */
/* ------------------------------------------------------------------ */

export function handoffDecision(status: MatchJudgeStatus): "proceed" | "unverified" {
  return status === "not_required" ? "proceed" : "unverified";
}

export interface AutoAdoptInput {
  proposal: Proposal;
  decision: "proceed" | "unverified";
  grant_valid: boolean;
}

/** Computed at handoff time; callers must recompute on adoption. */
export function autoAdoptEligible(input: AutoAdoptInput): boolean {
  const { proposal } = input;
  return (
    input.decision === "proceed" &&
    proposal.state === "proposed" &&
    proposal.match_judge.status === "not_required" &&
    proposal.match_judge.route_id !== null &&
    proposal.match_judge.route_hash !== null &&
    proposal.match_judge.route_class === "experience_match" &&
    proposal.experience.risk !== "high" &&
    proposal.experience.scope.level !== "global" &&
    proposal.experience.verifier.kind !== "none" &&
    proposal.experience.verifier.independence === "independent" &&
    input.grant_valid
  );
}

export interface HandoffProposalInput {
  proposal: Proposal;
  decision: "proceed" | "unverified";
  auto_adopt_eligible: boolean;
  reason_code?: string;
  judge: ReviewHandoffProposal["judge"];
}

export function toHandoffProposal(input: HandoffProposalInput): ReviewHandoffProposal {
  const proposal = input.proposal;
  const base: ReviewHandoffProposal = {
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    question_key: proposal.question_key,
    route_id: proposal.match_judge.route_id,
    route_hash: proposal.match_judge.route_hash,
    route_class: proposal.match_judge.route_class,
    candidate_hash: proposal.candidate_hash,
    candidate_file_hash: proposal.candidate_file_hash,
    candidate_block_hash: proposal.candidate_block_hash,
    experience_id: proposal.experience.experience_id,
    experience_version: proposal.experience.version,
    experience_content_hash: proposal.experience.content_hash,
    validation_plan_hash: proposal.experience.validation_plan_hash,
    decision: input.decision,
    auto_adopt_eligible: input.auto_adopt_eligible,
    risk: proposal.experience.risk,
    scope_level: proposal.experience.scope.level,
    no_verifier: proposal.experience.no_verifier,
    verifier: {
      kind: proposal.experience.verifier.kind,
      independence: proposal.experience.verifier.independence,
      ...(proposal.experience.verifier.binding_ref === undefined
        ? {}
        : { binding_ref: proposal.experience.verifier.binding_ref })
    }
  };
  if (input.reason_code !== undefined) {
    base.reason_code = input.reason_code;
  }
  if (proposal.egress_decision_ref !== undefined) {
    base.egress_decision_ref = proposal.egress_decision_ref;
  }
  if (input.judge !== undefined) {
    base.judge = input.judge;
  }
  return base;
}

export function judgeBindingFromProposal(proposal: Proposal): ReviewHandoffProposal["judge"] {
  const judge = proposal.match_judge;
  if (judge.issue_id === undefined || judge.plan_id === undefined || judge.plan_hash === undefined) {
    return undefined;
  }
  if (judge.service_profile_id === undefined || judge.validator_binding_id === undefined) {
    return undefined;
  }
  const binding: NonNullable<ReviewHandoffProposal["judge"]> = {
    issue_id: judge.issue_id,
    plan_id: judge.plan_id,
    plan_hash: judge.plan_hash,
    service_profile_id: judge.service_profile_id,
    validator_binding_id: judge.validator_binding_id,
    template_id: EXPERIENCE_MATCH_TEMPLATE_ID,
    template_version: EXPERIENCE_MATCH_TEMPLATE_VERSION,
    template_hash: judge.template_hash
  };
  if (judge.validator_binding_key !== undefined) {
    binding.validator_binding_key = judge.validator_binding_key;
  }
  if (judge.question_bindings_digest !== undefined) {
    binding.question_bindings_digest = judge.question_bindings_digest;
  }
  if (judge.binding_id !== undefined) binding.binding_id = judge.binding_id;
  if (judge.invocation_id !== undefined) binding.invocation_id = judge.invocation_id;
  if (judge.attempt_id !== undefined) binding.attempt_id = judge.attempt_id;
  if (judge.envelope_id !== undefined) binding.envelope_id = judge.envelope_id;
  if (judge.envelope_key !== undefined) binding.envelope_key = judge.envelope_key;
  if (judge.request_hash !== undefined) binding.request_hash = judge.request_hash;
  if (judge.dispatch_key !== undefined) binding.dispatch_key = judge.dispatch_key;
  if (judge.validator_version !== undefined) binding.validator_version = judge.validator_version;
  if (judge.match_outcome !== undefined) binding.match_outcome = judge.match_outcome;
  if (judge.egress_decision_ref !== undefined) binding.egress_decision_ref = judge.egress_decision_ref;
  return binding;
}

export function plannedQuestionTemplate(question: PlannedQuestion): TemplateBinding {
  return {
    question_key: question.question_key,
    template_id: question.template_id,
    template_version: question.template_version,
    template_hash: question.template_hash
  };
}

export function verifierIsIndependent(entry: VerifierRegistryEntry): boolean {
  return entry.independence === "independent";
}

export function scopeLevelRisk(input: {
  risk: ExperienceRisk;
  scopeLevel: Experience["scope"]["level"];
}): "eligible" | "blocked" {
  return input.risk !== "high" && input.scopeLevel !== "global" ? "eligible" : "blocked";
}

export function supportingVerifier(plan: ValidationPlan): boolean {
  return plan.verifier.kind !== "none" && plan.verifier.independence === "independent";
}

/* ------------------------------------------------------------------ */
/* Experience-match plan binding validator (DD-EVD / DD-REV-070)       */
/* ------------------------------------------------------------------ */

export interface ExperienceMatchPlanQuestionBinding {
  question_key: string;
  question_id?: string;
  template_id: string;
  template_version: string;
  template_hash?: string;
  options?: readonly string[];
  option_order?: readonly string[];
}

/** Persisted QP plan projection; question ids may be absent on old rows. */
export interface ExperienceMatchPlanBinding {
  plan_id?: string;
  plan_hash?: string;
  issue_id?: string;
  questions: readonly ExperienceMatchPlanQuestionBinding[];
}

export interface ExperienceMatchInputAccepted {
  status: "accepted";
  match_outcome: "unknown";
  candidate_disposition: "unverified";
  plan_id: string;
  plan_hash: Hash;
  issue_id: string;
  question_ids: string[];
}

export interface ExperienceMatchInputRejected {
  ok: false;
  status: "rejected";
  error: { code: string; stage: "judge"; retryable: false; rule: string };
}

export type ExperienceMatchInputValidation =
  | ExperienceMatchInputAccepted
  | ExperienceMatchInputRejected;

const EXPERIENCE_MATCH_OPTIONS: readonly string[] = ["applicable", "conflict", "unknown"];

function matchInputReject(code: string, rule: string): ExperienceMatchInputRejected {
  return { ok: false, status: "rejected", error: { code, stage: "judge", retryable: false, rule } };
}

function sameStringSequence(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Validates an `ExperienceMatchJudgeInput` against the persisted QP plan it
 * claims to answer. A judge invocation without a resolvable plan, a matching
 * plan hash, the same issue/questions or a complete template binding is never
 * dispatched.
 */
export function validateExperienceMatchInput(
  input: ExperienceMatchJudgeInput,
  plan: ExperienceMatchPlanBinding | null | undefined
): ExperienceMatchInputValidation {
  if (
    plan === null ||
    plan === undefined ||
    typeof input.plan_id !== "string" ||
    input.plan_id.length === 0 ||
    plan.plan_id !== input.plan_id
  ) {
    return matchInputReject("E_PLAN_REQUIRED", "plan_pointer");
  }
  if (plan.plan_hash === undefined || input.plan_hash !== plan.plan_hash) {
    return matchInputReject("E_PLAN_HASH_MISMATCH", "plan_hash");
  }
  if (plan.issue_id === undefined || input.issue_id !== plan.issue_id) {
    return matchInputReject("E_PLAN_AGGREGATION_BINDING", "issue_id");
  }
  if (input.question_ids.length !== plan.questions.length) {
    return matchInputReject("E_PLAN_AGGREGATION_BINDING", "question_ids");
  }
  if (input.questions.length !== plan.questions.length) {
    return matchInputReject("E_PLAN_AGGREGATION_BINDING", "questions");
  }
  const byKey = new Map(plan.questions.map((question) => [question.question_key, question]));
  for (const question of input.questions) {
    const planned = byKey.get(question.question_key);
    if (planned === undefined) {
      return matchInputReject("E_PLAN_AGGREGATION_BINDING", "question_key");
    }
    const plannedOptions = planned.options ?? planned.option_order ?? EXPERIENCE_MATCH_OPTIONS;
    if (!sameStringSequence(question.options, plannedOptions)) {
      return matchInputReject("E_PLAN_AGGREGATION_BINDING", "options");
    }
    const binding = input.template_bindings.find(
      (entry) => entry.question_key === question.question_key
    );
    if (
      binding === undefined ||
      binding.template_id !== planned.template_id ||
      binding.template_version !== planned.template_version ||
      typeof binding.template_hash !== "string" ||
      binding.template_hash.length === 0 ||
      binding.template_hash !== planned.template_hash
    ) {
      return matchInputReject("E_TEMPLATE_BINDING_MISSING", question.question_key);
    }
  }
  return {
    status: "accepted",
    match_outcome: "unknown",
    candidate_disposition: "unverified",
    plan_id: input.plan_id,
    plan_hash: input.plan_hash,
    issue_id: input.issue_id,
    question_ids: [...input.question_ids]
  };
}

export interface DispatchMatchJudgeInput extends JudgeDispatchInput {
  proposal: Proposal;
  judge: JudgeService;
}

/**
 * Drives one Proposal through the QP route and the EVD judge. An egress
 * denial never drops the QP route: the Proposal becomes `degraded` and keeps
 * the route triple for the handoff.
 */
export async function dispatchMatchJudge(
  input: DispatchMatchJudgeInput
): Promise<Result<ProposalMatchJudge, ErrorEnvelope>> {
  const mapping = mapQpResult(
    ok({
      schema_version: "rsi.experience_review_planning_result/1",
      outcome: "planned",
      route: input.route,
      plan: input.plan
    })
  );
  if (mapping.route === null || mapping.plan === null) {
    return ok(applyProjection(input.proposal.match_judge, mapping.projection));
  }
  const prepared = await prepareJudgeDispatch(input);
  if (!prepared.ok) {
    return ok(
      applyProjection(input.proposal.match_judge, {
        status: "degraded",
        route_id: mapping.projection.route_id,
        route_hash: mapping.projection.route_hash,
        route_class: mapping.projection.route_class,
        question_key: mapping.projection.question_key,
        plan_id: mapping.projection.plan_id,
        plan_hash: mapping.projection.plan_hash,
        issue_id: mapping.projection.issue_id,
        degrade_reason: prepared.error.code
      })
    );
  }
  const judged = await invokeJudge(input.judge, prepared.value.input);
  const outcome = mapJudgeResult(judged);
  if (outcome === null) {
    return ok(
      applyProjection(input.proposal.match_judge, {
        ...mapping.projection,
        status: "degraded",
        degrade_reason: judged.ok ? "judge_unavailable" : judged.error.code
      })
    );
  }
  return ok(applyJudgeOutcome(input.proposal.match_judge, outcome));
}

export interface JudgeStateRow {
  row_schema: "rsi.proposal/2";
  object_key: string;
  operation: "transition";
  before_hash: Hash;
  after_hash: Hash;
  row_json: JsonValue;
}

export interface JudgeStateRowBatch {
  job_id: string;
  rows: JudgeStateRow[];
  job_after_image: {
    row_schema: "rsi.review_job/2";
    object_key: string;
    row_json: JsonValue;
  };
}

/**
 * T5 appendStateRows batch: one Proposal transition per Proposal (judged or
 * untouched) plus the job after-image that advances the stage.
 */
export function buildJudgeStateRowBatch(input: {
  job: ReviewJob;
  proposals: readonly Proposal[];
}): JudgeStateRowBatch {
  const rows: JudgeStateRow[] = [...input.proposals]
    .sort((left, right) => compareUtf8(left.proposal_id, right.proposal_id))
    .map((proposal) => ({
      row_schema: "rsi.proposal/2",
      object_key: proposal.proposal_id,
      operation: "transition",
      before_hash: proposal.proposal_hash,
      after_hash: proposal.proposal_hash,
      row_json: toJsonValue(proposal)
    }));
  return {
    job_id: input.job.job_id,
    rows,
    job_after_image: {
      row_schema: "rsi.review_job/2",
      object_key: input.job.job_id,
      row_json: toJsonValue(input.job)
    }
  };
}
