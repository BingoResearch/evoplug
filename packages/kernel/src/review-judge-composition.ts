/**
 * Production planner/judge composition for REV match judging.
 *
 * This module is the one place that turns real FND/REV/EVD/QP state into the
 * three review ports (`planner`, `judge`, `judge_prepare`). A composition root
 * passes one dependency bundle and spreads `review_options` into
 * `ReviewServiceOptions`; it does not hand-assemble profiles, budgets,
 * evidence, egress or transport per proposal.
 *
 * Hard rules kept here:
 *   - the review snapshot, the Experience body, the approved source set, the
 *     persisted service profile, the persisted budget and the real transport
 *     are read; none is synthesized;
 *   - missing routes, plans, profiles, templates, evidence sources or
 *     transports degrade the Proposal through `createPlannerJudgeDispatch`;
 *   - an existing EVD `/3` request binding is reused, and an orphan compile
 *     without a binding fails closed instead of inserting a second pack;
 *   - the forced-pass experiment stays off unless its exact policy type is
 *     passed, and caller-supplied labels cannot reach the record.
 *
 * Construction performs no provider request.
 */

import { type Clock, type ErrorEnvelope, type Hash, type Id, type Result, type SourceRef, type SourceRefPort, type VersionBinding } from "@evoplug/core";
import {
  canonicalHash,
  compareUtf8,
  err,
  hashBytes,
  newId,
  ok,
  parseSourceRef,
  systemClock,
  toJsonValue
} from "@evoplug/core";
import type {
  ExperienceReviewPlanningResult as CoreExperienceReviewPlanningResult,
  ExperienceScopeView as CoreScopeView,
  ExperienceTriggerView as CoreTriggerView,
  QuestionPlan as CoreQuestionPlan,
  ReviewExperienceInput as CoreReviewExperienceInput,
  ReviewSnapshotView as CoreReviewSnapshotView
} from "@evoplug/core/evidence";
import { MAX_SOURCE_REFS, buildTemplateRegistry } from "@evoplug/core/evidence";
import type {
  EvidenceIndexSnapshot as EvdEvidenceIndexSnapshot,
  ExperienceScopeView as EvdScopeView,
  ExperienceTriggerView as EvdTriggerView,
  GatewayAttemptPersistence,
  JevServiceProfile as EvdJevServiceProfile,
  JudgeAttemptResult,
  JudgeEnvelopeV3,
  JudgeRequestBindingV3,
  QuestionPlan as EvdQuestionPlan,
  ReviewSnapshotView as EvdReviewSnapshotView,
  RunBudget,
  SemanticBackendPort,
  SemanticOutcome
} from "@evoplug/evidence";
import {
  buildTemplateBindings,
  createEvidenceCompiler,
  createJudgeGateway,
  textHash
} from "@evoplug/evidence";
import type {
  EgressDecisionPort,
  Experience,
  ExperienceMatchJudgeInput,
  ExperienceMatchJudgeResult,
  ExperienceReviewPlanningInput,
  ExperienceReviewPlanningResult,
  JudgeInvocationResult,
  JudgeRunBudget,
  JudgeService,
  JudgeTemplateBindingReceipt,
  JevServiceProfile as ReviewJevServiceProfile,
  Proposal,
  QuestionPlanner,
  ReviewJob,
  ReviewSnapshot
} from "@evoplug/review";
import {
  experienceBodyBytes,
  experienceBodyHash,
  experienceContentHash,
  revError,
  validateExperienceMatchInput
} from "@evoplug/review";
import type { BlobStore, JournalWriter, SqliteConnection } from "@evoplug/storage";

import type { DefaultEvidenceComposition } from "./default-evidence-composition.js";
import {
  createDefaultEvidenceComposition,
  resolveDefaultEvidenceBinding,
  type ResolvedEvidenceBinding
} from "./default-evidence-composition.js";
import { createDefaultQuestionEvidencePorts } from "./default-question-evidence.js";
import type { DefaultQuestionPlannerBundle } from "./default-question-planner.js";
import { createDefaultQuestionPlanner } from "./default-question-planner.js";
import { fieldError, kernelError, versionError } from "./errors.js";
import type {
  ForcedPassExperimentPolicy,
  PlannerJudgeDispatchPreparation,
  PlannerJudgePrepare,
  ReviewServiceOptions
} from "./review-service.js";
import { createSourceRefPort } from "./source-ref-port.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

interface PersistedReviewJudgeComposition {
  readonly planner: QuestionPlanner;
  readonly judge: JudgeService;
  readonly judge_prepare: PlannerJudgePrepare;
  /**
   * Exact spread value for `ReviewServiceOptions`. It never contains
   * `judge_dispatch` or `forced_pass_experiment`, so the production pipeline
   * cannot be combined with the experiment by accident.
   */
  readonly review_options: Pick<
    ReviewServiceOptions,
    "planner" | "judge" | "judge_prepare"
  >;
  /** Reused W9 composition (writer, reader, `/3` binding reader). */
  readonly composition: DefaultEvidenceComposition;
}

interface PersistedReviewJudgeCompositionDeps {
  /** The single-writer FND connection shared with QP/EVD. */
  readonly connection: SqliteConnection;
  /** Independent read connection used by the EVD reader. */
  readonly read_connection: SqliteConnection;
  readonly blob_store: BlobStore;
  /** The shared journal; this factory opens no second writer. */
  readonly journal: JournalWriter;
  readonly journal_relative_path: string;
  /** Concrete Jev transport. No provider call happens until a dispatch. */
  readonly jev_transport: SemanticBackendPort;
  readonly source_refs?: SourceRefPort;
  readonly now: () => number;
  readonly clock?: Clock;
  /**
   * Optional real egress decision port. When omitted, the factory approves
   * exactly the frozen snapshot's `egress_approved_refs` +
   * `egress_approved_experience_refs` for the resolved endpoint/model.
   */
  readonly egress?: EgressDecisionPort;
  readonly registry_version?: string;
  /** Per-source read cap; defaults to 1 MiB. */
  readonly max_evidence_bytes?: number;
  /** Deterministic cap on evidence items passed to the review gate; default 32. */
  readonly max_evidence_items?: number;
  readonly detector_version?: string;
  readonly planner_version?: string;
  /** Reuse the W9 composition instead of building a second one. */
  readonly evidence_composition?: DefaultEvidenceComposition;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_REGISTRY_VERSION = "qp.registry/1";
const DEFAULT_MAX_EVIDENCE_BYTES = 1_048_576;
const DEFAULT_MAX_EVIDENCE_ITEMS = 32;
const DEFAULT_COMPILER_VERSION = "evd-compiler/1";
const DEFAULT_COUNTING_METHOD_VERSION = "utf8-bytes/1";
const EXPERIENCE_MATCH_TEMPLATE_ID = "qt.experience_match" as const;
const EXPERIENCE_MATCH_TEMPLATE_VERSION = "1.0.0" as const;
const EXPERIENCE_MATCH_OPTIONS = ["applicable", "conflict", "unknown"] as const;
export const FORCED_PASS_LABEL_PREFIX = "forced_pass_experimental:";

/* ------------------------------------------------------------------ */
/* Internal state                                                      */
/* ------------------------------------------------------------------ */

interface PreparedContext {
  readonly proposal_id: string;
  readonly snapshot_id: string;
  readonly snapshot_hash: Hash;
  readonly binding: VersionBinding;
  readonly review_planning: ExperienceReviewPlanningInput;
  readonly core_snapshot: CoreReviewSnapshotView;
  readonly experience: Experience;
  readonly excerpt: string;
  readonly judge_dispatch: Omit<
    PlannerJudgeDispatchPreparation["judge_dispatch"],
    "plan" | "route"
  >;
  readonly approved_refs: ReadonlySet<SourceRef>;
  readonly egress: EgressDecisionPort;
  readonly endpoint: string;
  readonly model_id: string;
  readonly resolved: ResolvedEvidenceBinding;
  readonly evd_profile: EvdJevServiceProfile;
  readonly template_hash: Hash;
}

interface PlannedContext {
  readonly prepared: PreparedContext;
  readonly core_plan: CoreQuestionPlan;
  readonly bundle: DefaultQuestionPlannerBundle;
}

interface CompositionState {
  readonly prepared: Map<string, PreparedContext>;
  readonly planned: Map<string, PlannedContext>;
}

function contextKey(snapshotId: string, proposalId: string): string {
  return `${snapshotId} ${proposalId}`;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function sameBinding(a: VersionBinding, b: VersionBinding): boolean {
  return (
    a.task_id === b.task_id &&
    a.branch_id === b.branch_id &&
    a.input_epoch === b.input_epoch &&
    a.goal_version === b.goal_version &&
    a.config_version === b.config_version &&
    a.watermark === b.watermark
  );
}

function sameScope(binding: VersionBinding, scope: ReviewJob["scope"]): boolean {
  return (
    scope.task_id === binding.task_id &&
    scope.branch_id === binding.branch_id &&
    scope.input_epoch === binding.input_epoch &&
    scope.goal_version === binding.goal_version &&
    scope.config_version === binding.config_version
  );
}

function sortedUniqueRefs(refs: readonly SourceRef[]): SourceRef[] {
  return [...new Set(refs)].sort(compareUtf8);
}

function refsOf(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  return sortedUniqueRefs(
    value.filter((entry): entry is SourceRef => typeof entry === "string")
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function nowMs(now: () => number): number {
  return Math.max(0, Math.trunc(now()));
}

/* ------------------------------------------------------------------ */
/* Forced-pass option                                                  */
/* ------------------------------------------------------------------ */

interface ForcedPassReviewOptions {
  readonly forced_pass_experiment: ForcedPassExperimentPolicy;
}

function forcedPassText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`forced_pass_experimental requires a non-empty ${field}`);
  }
  return value.trim();
}

/**
 * Validates the experiment policy without throwing. Returns the first problem
 * for composition roots that prevalidate before opening resources.
 */
export function validateForcedPassPolicy(policy: unknown): string | null {
  if (!isRecord(policy)) return "forced_pass_experiment must be an object";
  if (policy["kind"] !== "forced_pass_experimental") {
    return "forced_pass_experiment kind must be forced_pass_experimental";
  }
  for (const field of ["experiment_id", "approved_by", "reason"] as const) {
    const value = policy[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return `forced_pass_experiment requires a non-empty ${field}`;
    }
  }
  return null;
}

/**
 * Builds the exact spread value for `ReviewServiceOptions` that selects the
 * forced-pass experiment.
 *
 * The returned object contains only `forced_pass_experiment`; it cannot be
 * merged with the production trio. Every label is derived by
 * `createForcedPassExperimentDispatch` from the normalized `experiment_id`;
 * this helper accepts no label field and drops unknown properties.
 */
export function createForcedPassReviewOptions(
  policy: ForcedPassExperimentPolicy
): ForcedPassReviewOptions {
  const problem = validateForcedPassPolicy(policy);
  if (problem !== null) throw new Error(problem);
  const normalized: ForcedPassExperimentPolicy = Object.freeze({
    kind: "forced_pass_experimental",
    experiment_id: forcedPassText(policy.experiment_id, "experiment_id"),
    approved_by: forcedPassText(policy.approved_by, "approved_by"),
    reason: forcedPassText(policy.reason, "reason")
  });
  return Object.freeze({ forced_pass_experiment: normalized });
}

/* ------------------------------------------------------------------ */
/* Non-throwing dispatcher prevalidation                               */
/* ------------------------------------------------------------------ */

type ReviewJudgeDispatchMode =
  | "degraded"
  | "judge_dispatch"
  | "planner_judge_pipeline"
  | "forced_pass_experiment";

type ReviewJudgeDispatchValidation =
  | { readonly ok: true; readonly mode: ReviewJudgeDispatchMode }
  | {
      readonly ok: false;
      readonly reason: "conflicting" | "partial_trio" | "invalid_forced_pass";
      readonly message: string;
      readonly missing?: readonly string[];
    };

/**
 * Mirrors `resolveJudgeDispatch` without throwing.
 *
 * A composition root should call this before opening databases/journals so an
 * invalid trio cannot leave resources open. This helper does not activate a
 * dispatcher; `resolveJudgeDispatch` remains the only activation path.
 */
export function validateReviewJudgeDispatchOptions(
  options: Pick<
    ReviewServiceOptions,
    "planner" | "judge" | "judge_prepare" | "judge_dispatch" | "forced_pass_experiment"
  >
): ReviewJudgeDispatchValidation {
  const trioParts = [
    options.planner === undefined ? null : "planner",
    options.judge === undefined ? null : "judge",
    options.judge_prepare === undefined ? null : "judge_prepare"
  ].filter((part): part is string => part !== null);
  const configured = [
    options.judge_dispatch === undefined ? null : "judge_dispatch",
    options.forced_pass_experiment === undefined ? null : "forced_pass_experiment",
    trioParts.length === 3 ? "planner_judge_pipeline" : null
  ].filter((part): part is string => part !== null);
  if (configured.length > 1) {
    return {
      ok: false,
      reason: "conflicting",
      message: `ReviewServiceOptions configures conflicting judge dispatchers: ${configured.join(", ")}`
    };
  }
  if (trioParts.length > 0 && trioParts.length < 3) {
    const missing = ["planner", "judge", "judge_prepare"].filter(
      (part) => !trioParts.includes(part)
    );
    return {
      ok: false,
      reason: "partial_trio",
      message:
        `ReviewServiceOptions ${trioParts.join("/")} supplied without ${missing.join("/")}; ` +
        "the typed judge pipeline requires all three",
      missing
    };
  }
  if (options.judge_dispatch !== undefined) {
    return { ok: true, mode: "judge_dispatch" };
  }
  if (options.forced_pass_experiment !== undefined) {
    const problem = validateForcedPassPolicy(options.forced_pass_experiment);
    if (problem !== null) {
      return { ok: false, reason: "invalid_forced_pass", message: problem };
    }
    return { ok: true, mode: "forced_pass_experiment" };
  }
  if (trioParts.length === 3) {
    return { ok: true, mode: "planner_judge_pipeline" };
  }
  return { ok: true, mode: "degraded" };
}

/* ------------------------------------------------------------------ */
/* Pure QP result mapping                                              */
/* ------------------------------------------------------------------ */

/**
 * Maps the core QP result to the REV planning ABI.
 *
 * A core result without a persisted route cannot be expressed in the REV ABI;
 * it returns an error and the dispatcher degrades the Proposal.
 */
export function mapCoreExperiencePlanningResult(
  result: CoreExperienceReviewPlanningResult
): Result<ExperienceReviewPlanningResult, ErrorEnvelope> {
  const route = result.route;
  if (route === null) {
    return err(
      kernelError("E_INTERNAL", {
        details: {
          kind: "internal",
          incident_id: "review_judge_composition.qp_route_missing"
        }
      })
    );
  }
  const reviewRoute = {
    route_id: route.route_id,
    route_key: route.route_key as Hash,
    route_hash: route.route_hash as Hash,
    route_class: "experience_match" as const,
    route_state: route.route_state
  };
  if (result.status === "planned") {
    const questions: Array<{
      question_key: string;
      question_id: string;
      template_id: "qt.experience_match";
      template_version: "1.0.0";
      template_hash: Hash;
      option_order: Array<"applicable" | "conflict" | "unknown">;
      issue_id: string;
    }> = [];
    for (const question of result.plan.questions) {
      if (
        question.template_id !== EXPERIENCE_MATCH_TEMPLATE_ID ||
        question.template_version !== EXPERIENCE_MATCH_TEMPLATE_VERSION ||
        question.options.length !== EXPERIENCE_MATCH_OPTIONS.length ||
        question.options.some(
          (option, index) => option !== EXPERIENCE_MATCH_OPTIONS[index]
        )
      ) {
        return err(
          fieldError("plan.questions", "experience_match_template_binding")
        );
      }
      questions.push({
        question_key: question.question_key,
        question_id: question.question_id,
        template_id: EXPERIENCE_MATCH_TEMPLATE_ID,
        template_version: EXPERIENCE_MATCH_TEMPLATE_VERSION,
        template_hash: question.template_hash as Hash,
        option_order: [...EXPERIENCE_MATCH_OPTIONS],
        issue_id: question.issue_id
      });
    }
    return ok<ExperienceReviewPlanningResult>({
      schema_version: "rsi.experience_review_planning_result/1",
      outcome: "planned",
      route: reviewRoute,
      plan: {
        plan_id: result.plan.plan_id,
        plan_hash: result.plan.plan_hash as Hash,
        issue_id: result.plan.issue_id,
        question_key: result.question_key,
        questions
      }
    });
  }
  if (result.status === "no_op") {
    return ok<ExperienceReviewPlanningResult>({
      schema_version: "rsi.experience_review_planning_result/1",
      outcome: "no_op",
      route: reviewRoute,
      reason: result.reason,
      ...(result.issue_id === undefined ? {} : { issue_id: result.issue_id }),
      plan: null
    });
  }
  return ok<ExperienceReviewPlanningResult>({
    schema_version: "rsi.experience_review_planning_result/1",
    outcome: "rejected",
    route: reviewRoute,
    failure_code: result.reason,
    missing: result.missing.map((gap) => gap.code),
    plan: null
  });
}

/* ------------------------------------------------------------------ */
/* Pure judge attempt mapping                                          */
/* ------------------------------------------------------------------ */

interface ReviewQuestionRef {
  readonly question_key: string;
  readonly question_id: string;
}

function reviewUsage(
  usage: JudgeEnvelopeV3["usage"]
): NonNullable<JudgeInvocationResult["usage"]> {
  const result: NonNullable<JudgeInvocationResult["usage"]> = {
    cost_status: usage.cost_status
  };
  if (usage.input_tokens !== null) result.input_tokens = usage.input_tokens;
  if (usage.output_tokens !== null) result.output_tokens = usage.output_tokens;
  if (usage.cost_micros !== null) result.cost_micros = usage.cost_micros;
  if (usage.receipt_ref !== null) result.usage_refs = [usage.receipt_ref];
  return result;
}

function reviewTemplateBindings(
  envelope: JudgeEnvelopeV3
): JudgeTemplateBindingReceipt[] | undefined {
  const mapped: JudgeTemplateBindingReceipt[] = [];
  for (const binding of envelope.template_bindings) {
    if (
      binding.template_id !== EXPERIENCE_MATCH_TEMPLATE_ID ||
      binding.template_version !== EXPERIENCE_MATCH_TEMPLATE_VERSION
    ) {
      return undefined;
    }
    mapped.push({
      question_key: binding.question_key,
      template_id: EXPERIENCE_MATCH_TEMPLATE_ID,
      template_version: EXPERIENCE_MATCH_TEMPLATE_VERSION,
      template_hash: binding.template_hash
    });
  }
  return mapped;
}

function answerChoice(
  outcome: SemanticOutcome | undefined
): "applicable" | "conflict" | "unknown" {
  switch (outcome?.effect) {
    case "supports":
      return "applicable";
    case "contradicts":
      return "conflict";
    default:
      return "unknown";
  }
}

function envelopeMatchOutcome(
  outcomes: ReadonlyArray<SemanticOutcome | undefined>
): "applicable" | "conflict" | "unknown" | "not_applicable" {
  if (outcomes.length === 0) return "unknown";
  if (outcomes.every((outcome) => outcome?.effect === "supports")) {
    return "applicable";
  }
  if (outcomes.every((outcome) => outcome?.effect === "contradicts")) {
    return "conflict";
  }
  if (outcomes.every((outcome) => outcome?.effect === "not_applicable")) {
    return "not_applicable";
  }
  return "unknown";
}

function mapEnvelope(
  envelope: JudgeEnvelopeV3,
  input: {
    readonly service_profile_id: string;
    readonly validator_binding_id: string;
    readonly questions: readonly ReviewQuestionRef[];
  }
): JudgeInvocationResult {
  const answers: NonNullable<JudgeInvocationResult["answers"]> = [];
  const missing: string[] = [];
  const outcomes: Array<SemanticOutcome | undefined> = [];
  for (const question of input.questions) {
    const outcome = envelope.semantic_outcomes[question.question_key];
    outcomes.push(outcome);
    if (outcome === undefined) missing.push(question.question_key);
    answers.push({
      question_id: question.question_id,
      choice: answerChoice(outcome)
    });
  }
  const accepted =
    envelope.validation.status === "accepted" && missing.length === 0;
  const result: JudgeInvocationResult = {
    status: accepted ? "accepted" : "degraded",
    invocation_id: envelope.request_id,
    envelope_id: envelope.envelope_id,
    envelope_key: envelope.envelope_key,
    binding_id: envelope.binding_id,
    validator_binding_id: input.validator_binding_id,
    validator_binding_key: envelope.validation.validator_binding_key,
    question_bindings_digest: envelope.question_bindings_digest,
    request_hash: envelope.request_hash,
    dispatch_key: envelope.dispatch_key,
    service_profile_id: input.service_profile_id,
    match_outcome: envelopeMatchOutcome(outcomes),
    answers,
    usage: reviewUsage(envelope.usage)
  };
  const bindings = reviewTemplateBindings(envelope);
  if (bindings !== undefined) result.template_bindings = bindings;
  const adapter = envelope.adapter_evidence;
  if (adapter !== null && adapter.kind === "jev_typed") {
    result.validator_version = adapter.validator_version;
  }
  if (!accepted) {
    delete result.match_outcome;
    result.failure_code =
      envelope.validation.primary_error ??
      (missing.length > 0 ? "E_JUDGE_OUTCOME_MISSING" : "E_JUDGE_DEGRADED");
    result.missing =
      envelope.validation.errors.length > 0
        ? [...envelope.validation.errors]
        : missing;
  }
  return result;
}

/**
 * Maps one gateway attempt to the REV result ABI. Unknown, cancelled and late
 * outcomes stay unknown; no verdict is inferred from an attempt id or a
 * partial envelope.
 */
export function mapJudgeAttemptToReviewResult(
  attempt: JudgeAttemptResult,
  input: {
    readonly service_profile_id: string;
    readonly validator_binding_id: string;
    readonly questions: readonly ReviewQuestionRef[];
  }
): ExperienceMatchJudgeResult {
  const wrap = (
    result: JudgeInvocationResult
  ): ExperienceMatchJudgeResult => ({
    schema_version: "rsi.experience_match_judge_result/1",
    candidate_disposition: "unverified",
    result
  });
  switch (attempt.status) {
    case "accepted":
    case "degraded": {
      const mapped = mapEnvelope(attempt.envelope, input);
      mapped.attempt_id = attempt.attempt.attempt_id;
      return wrap(mapped);
    }
    case "rejected":
      return wrap({
        status: "rejected",
        ...(attempt.attempt === null
          ? {}
          : { attempt_id: attempt.attempt.attempt_id }),
        failure_code: attempt.error.code
      });
    case "unknown":
      return wrap({
        status: "unknown",
        attempt_id: attempt.attempt.attempt_id,
        failure_code: attempt.error.code
      });
    case "cancelled":
      return wrap({
        status: "cancelled",
        attempt_id: attempt.attempt.attempt_id,
        failure_code: attempt.error.code
      });
    case "late_result_appended":
      return wrap({
        status: "unknown",
        attempt_id: attempt.attempt.attempt_id,
        failure_code: "E_LATE_RESULT_APPENDED"
      });
  }
}

/* ------------------------------------------------------------------ */
/* Default egress port                                                 */
/* ------------------------------------------------------------------ */

function defaultSnapshotEgress(
  approved: ReadonlySet<SourceRef>,
  profile: EvdJevServiceProfile
): EgressDecisionPort {
  return {
    async decide(input) {
      if (
        input.endpoint !== profile.base_url ||
        input.model_id !== profile.requested_model
      ) {
        return err(
          revError({
            code: "E_REVIEW_EGRESS_NOT_APPROVED",
            details: {
              kind: "egress",
              policy_version: "egress/default",
              denied_dimension: "endpoint",
              refs: input.sources
            }
          })
        );
      }
      const denied = input.sources.filter((ref) => !approved.has(ref));
      if (denied.length > 0) {
        return err(
          revError({
            code: "E_REVIEW_EGRESS_NOT_APPROVED",
            details: {
              kind: "egress",
              policy_version: "egress/default",
              denied_dimension: "approval",
              refs: denied
            }
          })
        );
      }
      const sources = sortedUniqueRefs(input.sources);
      return ok({
        allowed: true,
        approval_id: canonicalHash(
          toJsonValue({
            binding: input.binding,
            sources,
            endpoint: input.endpoint,
            model_id: input.model_id
          })
        ),
        decision_ref: null,
        sources
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Experience body and snapshot construction                           */
/* ------------------------------------------------------------------ */

interface LoadedExperienceBody {
  readonly experience: Experience;
  readonly source_refs: SourceRef[];
}

async function loadExperienceBody(
  sourceRefs: SourceRefPort,
  proposal: Proposal
): Promise<Result<LoadedExperienceBody, ErrorEnvelope>> {
  const bodyRef = proposal.experience.body_ref;
  const resolved = await sourceRefs.resolve(bodyRef);
  if (!resolved.ok) return resolved;
  if (!resolved.value.retrievable || resolved.value.bytes === null) {
    return err(fieldError("experience.body_ref", "unretrievable"));
  }
  const bytes = copyBytes(resolved.value.bytes);
  const text = decodeUtf8(bytes);
  if (text === null) return err(fieldError("experience.body_ref", "not_utf8"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(fieldError("experience.body_ref", "not_json"));
  }
  if (!isRecord(parsed) || parsed["schema_version"] !== "rsi.experience/1") {
    return err(fieldError("experience.body_ref", "schema"));
  }
  const experience = parsed as unknown as Experience;
  if (
    experience.experience_id !== proposal.experience.experience_id ||
    experience.version !== proposal.experience.version ||
    experience.content_hash !== proposal.experience.content_hash
  ) {
    return err(
      versionError(
        proposal.experience.content_hash,
        String(experience.content_hash ?? "")
      )
    );
  }
  if (experience.validation_plan_id !== proposal.experience.validation_plan_id) {
    return err(fieldError("experience.validation_plan_id", "mismatch"));
  }
  if (
    experience.validation_plan_hash !== proposal.experience.validation_plan_hash
  ) {
    return err(
      versionError(
        proposal.experience.validation_plan_hash,
        String(experience.validation_plan_hash ?? "")
      )
    );
  }
  if (!bytesEqual(bytes, experienceBodyBytes(experience))) {
    return err(fieldError("experience.body_ref", "not_canonical_body"));
  }
  const parsedRef = parseSourceRef(bodyRef);
  if (
    parsedRef.ok &&
    parsedRef.value.scheme === "blob" &&
    parsedRef.value.locator !== experienceBodyHash(experience)
  ) {
    return err(fieldError("experience.body_ref", "hash_mismatch"));
  }
  if (experienceContentHash(experience) !== proposal.experience.content_hash) {
    return err(
      versionError(
        proposal.experience.content_hash,
        experienceContentHash(experience)
      )
    );
  }
  const sourceRefsForCandidate = sortedUniqueRefs([
    ...refsOf(experience.evidence_refs),
    ...refsOf(proposal.evidence_refs),
    bodyRef
  ]);
  return ok({ experience, source_refs: sourceRefsForCandidate });
}

function coreTriggerView(experience: Experience): CoreTriggerView {
  return {
    description: experience.trigger.description,
    signal_kinds: [...experience.trigger.signal_kinds],
    task_family_ids: [...experience.trigger.task_family_ids],
    tool_names: [...experience.trigger.tool_names],
    path_patterns: [...experience.trigger.path_patterns],
    negative_triggers: [...experience.trigger.negative_triggers]
  };
}

function coreScopeView(experience: Experience): CoreScopeView {
  return {
    level: experience.scope.level,
    project_ids: [...experience.scope.project_ids],
    host_ids: [...experience.scope.host_ids],
    modes: [...experience.scope.modes],
    environment_fingerprints: [...experience.scope.environment_fingerprints],
    tool_version_ranges: experience.scope.tool_version_ranges.map((entry) => ({
      tool: entry.tool,
      range: entry.range
    })),
    model_families: [...experience.scope.model_families]
  };
}

function evdTriggerView(experience: Experience): EvdTriggerView {
  return {
    issue_types: [],
    keywords: [...new Set([
      ...experience.trigger.task_family_ids,
      ...experience.trigger.tool_names,
      ...experience.trigger.path_patterns
    ])].sort(compareUtf8)
  };
}

function evdScopeView(experience: Experience): EvdScopeView {
  return {
    paths: [...new Set(experience.trigger.path_patterns)].sort(compareUtf8),
    components: []
  };
}

function coreCandidateFromBody(input: {
  readonly experience: Experience;
  readonly excerpt: string;
  readonly source_refs: SourceRef[];
}): CoreReviewExperienceInput {
  const experience = input.experience;
  return {
    experience_id: experience.experience_id,
    version: experience.version,
    content_hash: experience.content_hash,
    type: experience.type,
    title: experience.title,
    summary: experience.summary,
    trigger: coreTriggerView(experience),
    scope: coreScopeView(experience),
    preconditions: experience.preconditions.map((entry) => ({
      precondition_id: entry.precondition_id,
      statement: entry.statement,
      check_kind: entry.check_kind
    })),
    steps: experience.steps.map((entry) => ({
      step_id: entry.step_id,
      action: entry.action,
      inputs: [...entry.inputs],
      expected_observation: entry.expected_observation,
      ...(entry.failure_branch === undefined
        ? {}
        : { failure_branch: entry.failure_branch })
    })),
    expected_effects: [...experience.expected_effects],
    completion_check: {
      kind: experience.completion_check.kind,
      description: experience.completion_check.description
    },
    counterexamples: experience.counterexamples.map((entry) => ({
      counterexample_id: entry.counterexample_id,
      condition: entry.condition,
      observed_failure: entry.observed_failure,
      excerpt: entry.observed_failure
    })),
    risk: experience.risk,
    validation_plan_id: experience.validation_plan_id,
    evidence_refs: [...experience.evidence_refs],
    excerpt: input.excerpt,
    source_refs: input.source_refs,
    text_hash: textHash(input.excerpt)
  };
}

function evdSnapshotFromBody(input: {
  readonly snapshot: ReviewSnapshot;
  readonly experience: Experience;
  readonly excerpt: string;
  readonly source_refs: SourceRef[];
}): EvdReviewSnapshotView {
  const experience = input.experience;
  return {
    schema_version: "rsi.review_snapshot_view/1",
    snapshot_id: input.snapshot.snapshot_id,
    snapshot_hash: input.snapshot.snapshot_hash,
    binding: input.snapshot.version_binding,
    watermark: input.snapshot.version_binding.watermark,
    candidate: {
      experience_id: experience.experience_id,
      version: experience.version,
      content_hash: experience.content_hash,
      type: experience.type,
      title: experience.title,
      summary: experience.summary,
      trigger: evdTriggerView(experience),
      scope: evdScopeView(experience),
      preconditions: experience.preconditions.map((entry) => toJsonValue(entry)),
      steps: experience.steps.map((entry) => toJsonValue(entry)),
      expected_effects: [...experience.expected_effects],
      completion_check: toJsonValue(experience.completion_check),
      counterexamples: experience.counterexamples.map((entry) =>
        toJsonValue(entry)
      ),
      risk: experience.risk,
      validation_plan_id: experience.validation_plan_id,
      evidence_refs: [...experience.evidence_refs],
      source_refs: input.source_refs,
      excerpt: input.excerpt,
      text_hash: textHash(input.excerpt)
    },
    shortlist: [],
    local_checks: { static_check_passed: true }
  };
}

/* ------------------------------------------------------------------ */
/* Approved evidence reads                                             */
/* ------------------------------------------------------------------ */

async function readApprovedEvidence(
  sourceRefs: SourceRefPort,
  refs: readonly SourceRef[],
  options: { readonly maxBytes: number; readonly maxItems: number }
): Promise<
  Result<
    PlannerJudgeDispatchPreparation["judge_dispatch"]["evidence"],
    ErrorEnvelope
  >
> {
  const items: PlannerJudgeDispatchPreparation["judge_dispatch"]["evidence"] =
    [];
  for (const ref of refs.slice(0, options.maxItems)) {
    const resolved = await sourceRefs.resolve(ref, {
      maxBytes: options.maxBytes
    });
    if (!resolved.ok) return resolved;
    if (!resolved.value.retrievable || resolved.value.bytes === null) {
      return err(fieldError("evidence_ref", "unretrievable"));
    }
    const contentHash =
      resolved.value.range_content_hash ?? resolved.value.contentVersion;
    if (contentHash === null) {
      return err(fieldError("evidence_ref", "content_hash_missing"));
    }
    const text = decodeUtf8(copyBytes(resolved.value.bytes));
    if (text === null) return err(fieldError("evidence_ref", "not_utf8"));
    items.push({
      evidence_id: ref,
      source_ref: ref,
      content_hash: contentHash,
      text,
      truncated: false
    });
  }
  return ok(items);
}

/* ------------------------------------------------------------------ */
/* Review profile/budget mapping                                       */
/* ------------------------------------------------------------------ */

function reviewAcceptance(
  status: EvdJevServiceProfile["acceptance"]["status"]
): ReviewJevServiceProfile["acceptance"]["status"] {
  switch (status) {
    case "eligible":
    case "shadow_only":
      return status;
    case "blocked":
      return "ineligible";
  }
}

function reviewProfile(
  profile: EvdJevServiceProfile,
  limits: RunBudget
): ReviewJevServiceProfile {
  const requestMax =
    profile.limits.request_max_tokens ?? limits.request_max_tokens ?? 0;
  const outputMax =
    profile.limits.question_max_tokens ??
    limits.question_max_tokens ??
    requestMax;
  return {
    schema_version: "rsi.jev_service_profile/1",
    service_profile_id: profile.profile_id,
    acceptance: {
      status: reviewAcceptance(profile.acceptance.status),
      evidence_ref: profile.h_evidence_refs[0] ?? null
    },
    limits: {
      request_max_tokens: requestMax,
      max_output_tokens: outputMax,
      rpm: null,
      concurrency: null
    }
  };
}

function reviewBudget(limits: RunBudget, now: number): JudgeRunBudget {
  return {
    max_input_tokens: limits.request_max_tokens ?? 0,
    max_output_tokens:
      limits.question_max_tokens ?? limits.request_max_tokens ?? 0,
    wall_ms: limits.deadline_ms,
    deadline_at: now + limits.deadline_ms
  };
}

/* ------------------------------------------------------------------ */
/* EVD compile / reuse                                                 */
/* ------------------------------------------------------------------ */

type RequestBindingRow = {
  readonly binding_id: string;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly request_hash: string;
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly service_profile_key: string;
  readonly validator_binding_key: string;
};

function readBindingRows(
  connection: SqliteConnection,
  planId: string,
  planHash: Hash
): RequestBindingRow[] {
  return connection
    .prepare<RequestBindingRow>(
      `SELECT binding_id, content_ref, content_hash, request_hash, plan_id, plan_hash,
              task_id, branch_id, input_epoch, goal_version, config_version, watermark,
              service_profile_key, validator_binding_key
         FROM evd_request_binding
        WHERE plan_id = :plan_id AND plan_hash = :plan_hash
        ORDER BY created_at ASC, binding_id ASC`
    )
    .all({ plan_id: planId, plan_hash: planHash });
}

function hasCompiledPackRows(
  connection: SqliteConnection,
  planId: string,
  planHash: Hash
): boolean {
  const row = connection
    .prepare<{ one: number }>(
      "SELECT 1 AS one FROM evd_evidence_pack WHERE plan_id = :plan_id AND plan_hash = :plan_hash LIMIT 1"
    )
    .get({ plan_id: planId, plan_hash: planHash });
  return row !== undefined;
}

function bindingMatchesPlan(
  binding: JudgeRequestBindingV3,
  plan: EvdQuestionPlan,
  resolved: ResolvedEvidenceBinding
): boolean {
  if (
    binding.plan_id !== plan.plan_id ||
    binding.plan_hash !== plan.plan_hash ||
    binding.service_profile_key !== resolved.service_profile_key ||
    binding.validator_binding_id !== resolved.validator_binding_id ||
    binding.validator_binding_key !== resolved.validator_binding_key
  ) {
    return false;
  }
  const planKeys = new Set(
    plan.questions.map((question) => question.question_key)
  );
  if (binding.question_bindings.length !== planKeys.size) return false;
  if (
    binding.question_bindings.some(
      (question) => !planKeys.has(question.question_key)
    )
  ) {
    return false;
  }
  if (binding.template_bindings.length !== planKeys.size) return false;
  for (const template of binding.template_bindings) {
    if (!planKeys.has(template.question_key)) return false;
    const planned = plan.questions.find(
      (question) => question.question_key === template.question_key
    );
    if (
      planned === undefined ||
      template.template_id !== planned.template_id ||
      template.template_version !== planned.template_version ||
      template.template_hash !== planned.template_hash
    ) {
      return false;
    }
  }
  return true;
}

function readPersistedBinding(
  blobStore: BlobStore,
  row: RequestBindingRow
): JudgeRequestBindingV3 | null {
  const parsed = parseSourceRef(row.content_ref);
  if (!parsed.ok || parsed.value.scheme !== "blob") return null;
  const read = blobStore.read(parsed.value.locator as Hash);
  if (!read.ok) return null;
  const bytes = copyBytes(read.value);
  if (hashBytes(bytes) !== row.content_hash) return null;
  if (bytes.byteLength !== bytes.length) return null;
  const text = decodeUtf8(bytes);
  if (text === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(decoded) ||
    decoded["schema_version"] !== "rsi.judge_request_binding/3"
  ) {
    return null;
  }
  const binding = decoded as unknown as JudgeRequestBindingV3;
  if (
    binding.binding_id !== row.binding_id ||
    binding.plan_id !== row.plan_id ||
    binding.plan_hash !== row.plan_hash ||
    binding.request_hash !== row.request_hash
  ) {
    return null;
  }
  return binding;
}

async function reuseOrCompileBinding(input: {
  readonly connection: SqliteConnection;
  readonly blob_store: BlobStore;
  readonly composition: DefaultEvidenceComposition;
  readonly bundle: DefaultQuestionPlannerBundle;
  readonly plan: EvdQuestionPlan;
  readonly resolved: ResolvedEvidenceBinding;
  readonly binding: VersionBinding;
  readonly now: () => number;
  readonly clock: Clock;
}): Promise<Result<JudgeRequestBindingV3, ErrorEnvelope>> {
  const rows = readBindingRows(
    input.connection,
    input.plan.plan_id,
    input.plan.plan_hash
  );
  const usable: JudgeRequestBindingV3[] = [];
  for (const row of rows) {
    if (
      row.task_id !== input.binding.task_id ||
      row.branch_id !== input.binding.branch_id ||
      row.input_epoch !== input.binding.input_epoch ||
      row.goal_version !== input.binding.goal_version ||
      row.config_version !== input.binding.config_version ||
      row.watermark !== input.binding.watermark ||
      row.service_profile_key !== input.resolved.service_profile_key ||
      row.validator_binding_key !== input.resolved.validator_binding_key
    ) {
      continue;
    }
    const persisted = readPersistedBinding(input.blob_store, row);
    if (
      persisted !== null &&
      sameBinding(persisted.binding, input.binding) &&
      bindingMatchesPlan(persisted, input.plan, input.resolved)
    ) {
      usable.push(persisted);
    }
  }
  if (usable.length > 1) {
    return err(
      kernelError("E_CONFLICT", {
        details: {
          kind: "field",
          path: "evd_request_binding",
          rule: "ambiguous_plan_binding"
        }
      })
    );
  }
  const reusable = usable[0];
  if (reusable !== undefined) {
    return ok(reusable);
  }
  if (
    rows.length > 0 ||
    hasCompiledPackRows(
      input.connection,
      input.plan.plan_id,
      input.plan.plan_hash
    )
  ) {
    // A previous dispatch left EVD rows that cannot be reused. Recompiling
    // would insert a second pack for the same plan; fail closed instead.
    return err(
      kernelError("E_CONFLICT", {
        details: {
          kind: "field",
          path: "evd_request_binding",
          rule: "stale_or_orphan_plan_state"
        }
      })
    );
  }

  const evidencePorts = createDefaultQuestionEvidencePorts({
    plans: input.bundle.plans,
    issues: input.bundle.issues
  });
  const compiler = createEvidenceCompiler({
    plans: evidencePorts.plans,
    plan_states: evidencePorts.plan_states,
    issues: evidencePorts.issues,
    now: input.now,
    monotonic_now: () => input.clock.monotonicNowMs(),
    binding: input.composition.binding
  });
  const snapshot = input.bundle.planner.deps
    .evidence as unknown as EvdEvidenceIndexSnapshot;
  const planId = input.plan.plan_id;
  const planHash = input.plan.plan_hash;
  const issueId = input.plan.issue_id;

  const compiledPack = await compiler.compilePack({
    schema_version: "rsi.pack_compile_input/1",
    plan_id: planId,
    plan_hash: planHash,
    issue_id: issueId,
    issue_key: input.plan.issue_key,
    binding: input.binding,
    snapshot,
    service_profile_key: input.resolved.service_profile_key,
    limits: input.resolved.limits,
    compiler_version: DEFAULT_COMPILER_VERSION,
    counting_method_version: DEFAULT_COUNTING_METHOD_VERSION
  });
  if (!compiledPack.ok) return compiledPack;
  const { pack, units } = compiledPack.value;
  const required = input.plan.questions.filter(
    (question) => question.required_for_issue
  );
  const optional = input.plan.questions.filter(
    (question) => !question.required_for_issue
  );
  const closure = compiler.expandClosure({
    schema_version: "rsi.closure_input/1",
    plan_id: planId,
    plan_hash: planHash,
    pack_key: pack.pack_key,
    required_question_keys: required.map((question) => question.question_key),
    optional_question_keys: optional.map((question) => question.question_key),
    units,
    limits: input.resolved.limits
  });
  if (!closure.ok) return closure;
  const shards = await compiler.planShards({
    schema_version: "rsi.shard_plan_input/1",
    plan_id: planId,
    plan_hash: planHash,
    issue_id: issueId,
    issue_key: input.plan.issue_key,
    pack,
    pack_key: pack.pack_key,
    closure: closure.value,
    snapshot,
    service_profile: input.resolved.service_profile,
    limits: input.resolved.limits,
    binding: input.binding,
    shard_policy_version: "per_shard/1"
  });
  if (!shards.ok) return shards;
  const dispatchable = shards.value.shards.filter(
    (shard) => shard.status !== "budget_rejected"
  );
  const shard = dispatchable[0];
  if (dispatchable.length !== 1 || shard === undefined) {
    return err(
      kernelError("E_INTERNAL", {
        details: {
          kind: "internal",
          incident_id: "review_judge_composition.experience_shard_count"
        }
      })
    );
  }
  const persist = await input.composition.writer.writer.commitCompile({
    binding: input.binding,
    pack,
    units,
    manifests: shards.value.manifests,
    shard_plan: shards.value.plan,
    shards: shards.value.shards,
    omissions: shards.value.omissions,
    estimates: shards.value.estimates
  });
  if (!persist.ok) return err(persist.error);
  const selected = input.plan.questions.filter((question) =>
    shard.question_keys.includes(question.question_key)
  );
  const built = await compiler.buildRequest({
    invocation_id: newId("jreq", input.now()),
    plan_id: planId,
    plan_hash: planHash,
    question_ids: [...shard.question_keys],
    version_binding: input.binding,
    pack_id: pack.pack_id,
    pack_key: pack.pack_key,
    shard_plan_id: shards.value.plan.shard_plan_id,
    shard_id: shard.shard_id,
    backend: input.resolved.backend,
    service_profile_id:
      "profile_id" in input.resolved.service_profile
        ? input.resolved.service_profile.profile_id
        : null,
    template_bindings: buildTemplateBindings(input.plan, selected),
    validator_binding_id: input.resolved.validator_binding_id,
    budget: input.resolved.limits,
    deadline_at_monotonic_ms:
      input.clock.monotonicNowMs() + input.resolved.limits.deadline_ms,
    created_at: input.now()
  });
  if (!built.ok) return built;
  const committed = await input.composition.writer.writer.commitBinding({
    binding: input.binding,
    request_binding: built.value,
    shard_id: shard.shard_id,
    shard_plan_key: shards.value.plan.shard_plan_key,
    validator_binding_key: input.resolved.validator_binding_key
  });
  if (!committed.ok) return err(committed.error);
  return ok(built.value);
}

/* ------------------------------------------------------------------ */
/* Attempt persistence adapter                                          */
/* ------------------------------------------------------------------ */

function attemptPersistence(
  composition: DefaultEvidenceComposition
): GatewayAttemptPersistence {
  const writer = composition.writer.writer;
  return {
    prepare: (input) => writer.prepareAttempt(input),
    markSending: (input) => writer.markSending(input),
    commitResponse: (input) => writer.commitResponse(input),
    commitTerminal: (input) => writer.commitAttemptTerminal(input)
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createPersistedReviewJudgeComposition(
  deps: PersistedReviewJudgeCompositionDeps
): PersistedReviewJudgeComposition {
  const now = deps.now;
  const clock = deps.clock ?? systemClock;
  const sourceRefs =
    deps.source_refs ??
    createSourceRefPort({
      connection: deps.connection,
      blob_store: deps.blob_store
    });
  const composition =
    deps.evidence_composition ??
    createDefaultEvidenceComposition({
      connection: deps.connection,
      read_connection: deps.read_connection,
      blob_store: deps.blob_store,
      journal: deps.journal,
      journal_relative_path: deps.journal_relative_path,
      jev_transport: deps.jev_transport,
      now: deps.now,
      clock,
      ...(deps.source_refs === undefined ? {} : { source_refs: deps.source_refs })
    });
  const registry = buildTemplateRegistry({
    registry_version: deps.registry_version ?? DEFAULT_REGISTRY_VERSION
  });
  const templateEntry = registry.templates.find(
    (entry) =>
      entry.template_id === EXPERIENCE_MATCH_TEMPLATE_ID &&
      entry.template_version === EXPERIENCE_MATCH_TEMPLATE_VERSION
  );
  if (templateEntry === undefined) {
    throw new Error(
      `template registry ${registry.registry_version} has no ${EXPERIENCE_MATCH_TEMPLATE_ID}@${EXPERIENCE_MATCH_TEMPLATE_VERSION}`
    );
  }
  const templateHash = templateEntry.template_hash as Hash;
  const maxEvidenceBytes = deps.max_evidence_bytes ?? DEFAULT_MAX_EVIDENCE_BYTES;
  const maxEvidenceItems =
    deps.max_evidence_items ?? DEFAULT_MAX_EVIDENCE_ITEMS;
  const state: CompositionState = {
    prepared: new Map(),
    planned: new Map()
  };

  const prepare: PlannerJudgePrepare = async ({
    job,
    snapshot,
    proposal,
    now: dispatchNow
  }) => {
    if (proposal.job_id !== job.job_id) {
      return err(fieldError("proposal.job_id", "mismatch"));
    }
    if (
      job.snapshot_id !== snapshot.snapshot_id ||
      job.snapshot_hash !== snapshot.snapshot_hash
    ) {
      return err(versionError(snapshot.snapshot_id, job.snapshot_id));
    }
    const binding = snapshot.version_binding;
    if (!sameScope(binding, job.scope)) {
      return err(fieldError("job.scope", "binding_mismatch"));
    }
    if (proposal.static_check.errors.length > 0) {
      return err(fieldError("proposal.static_check", "not_passed"));
    }
    if (
      job.authorization_ref === undefined ||
      snapshot.authorization_ref === undefined ||
      job.authorization_ref !== snapshot.authorization_ref
    ) {
      return err(fieldError("authorization_ref", "missing_or_mismatched"));
    }
    if (proposal.experience.version < 1) {
      return err(fieldError("proposal.experience.version", "invalid"));
    }

    const body = await loadExperienceBody(sourceRefs, proposal);
    if (!body.ok) return body;
    const experience = body.value.experience;
    const excerpt = (
      experience.summary.trim() || experience.title.trim()
    ).slice(0, 4096);
    if (excerpt.length === 0) {
      return err(fieldError("proposal.experience.excerpt", "empty"));
    }
    const candidateRefs = body.value.source_refs;
    if (candidateRefs.length === 0 || candidateRefs.length > MAX_SOURCE_REFS) {
      return err(
        fieldError("proposal.experience.source_refs", "count_out_of_range")
      );
    }
    const snapshotRefs = sortedUniqueRefs([
      ...snapshot.evidence_refs,
      ...candidateRefs
    ]);
    if (snapshotRefs.length > MAX_SOURCE_REFS) {
      return err(fieldError("snapshot.evidence_refs", "count_out_of_range"));
    }

    const resolved = await resolveDefaultEvidenceBinding(
      deps.connection,
      composition.binding
    );
    if (!resolved.ok) return resolved;
    const evdProfile = resolved.value.service_profile;
    if (evdProfile.schema_version !== "rsi.jev_service_profile/1") {
      return err(fieldError("evd.service_profile", "jev_typed_profile_required"));
    }

    const approvedRefs = new Set<SourceRef>([
      ...snapshot.coverage.egress_approved_refs,
      ...snapshot.coverage.egress_approved_experience_refs
    ]);
    const approved = [...approvedRefs].sort(compareUtf8);
    const evidence = await readApprovedEvidence(sourceRefs, approved, {
      maxBytes: maxEvidenceBytes,
      maxItems: maxEvidenceItems
    });
    if (!evidence.ok) return evidence;

    const localChecks = {
      static_check_passed: true,
      authorization_granted: true,
      scope_compatible: true,
      version_compatible: true
    };
    const candidate = coreCandidateFromBody({
      experience,
      excerpt,
      source_refs: candidateRefs
    });
    const coreSnapshot: CoreReviewSnapshotView = {
      schema_version: "rsi.review_snapshot_view/1",
      snapshot_id: snapshot.snapshot_id,
      snapshot_hash: snapshot.snapshot_hash,
      binding,
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      candidate,
      shortlist: [],
      local_checks: localChecks,
      source_refs: snapshotRefs
    };
    const reviewPlanning: ExperienceReviewPlanningInput = {
      schema_version: "rsi.experience_review_planning_in/1",
      binding,
      snapshot: {
        schema_version: "rsi.review_snapshot_view/1",
        snapshot_id: snapshot.snapshot_id,
        snapshot_hash: snapshot.snapshot_hash,
        binding,
        proposal_id: proposal.proposal_id,
        candidate: {
          experience_id: candidate.experience_id,
          version: candidate.version,
          content_hash: candidate.content_hash as Hash,
          type: candidate.type,
          risk: candidate.risk,
          scope: candidate.scope,
          excerpt: candidate.excerpt,
          source_refs: candidate.source_refs,
          text_hash: candidate.text_hash as Hash
        },
        shortlist: [],
        local_checks: localChecks,
        source_refs: snapshotRefs
      },
      template: {
        template_id: EXPERIENCE_MATCH_TEMPLATE_ID,
        template_version: EXPERIENCE_MATCH_TEMPLATE_VERSION,
        template_hash: templateHash,
        options: [...EXPERIENCE_MATCH_OPTIONS]
      },
      deadline_at: Math.max(0, Math.trunc(dispatchNow)) + resolved.value.limits.deadline_ms
    };
    const egress =
      deps.egress ?? defaultSnapshotEgress(new Set(approved), evdProfile);
    const context: PreparedContext = {
      proposal_id: proposal.proposal_id,
      snapshot_id: snapshot.snapshot_id,
      snapshot_hash: snapshot.snapshot_hash,
      binding,
      review_planning: reviewPlanning,
      core_snapshot: coreSnapshot,
      experience,
      excerpt,
      judge_dispatch: {
        binding,
        project_id: job.scope.project_id ?? null,
        service_profile: reviewProfile(evdProfile, resolved.value.limits),
        budget: reviewBudget(
          resolved.value.limits,
          Math.max(0, Math.trunc(dispatchNow))
        ),
        evidence: evidence.value,
        template_hash: templateHash,
        egress,
        endpoint: evdProfile.base_url,
        model_id: evdProfile.requested_model,
        approved_evidence_refs: new Set(approved)
      },
      approved_refs: new Set(approved),
      egress,
      endpoint: evdProfile.base_url,
      model_id: evdProfile.requested_model,
      resolved: resolved.value,
      evd_profile: evdProfile,
      template_hash: templateHash
    };
    state.prepared.set(
      contextKey(snapshot.snapshot_id, proposal.proposal_id),
      context
    );
    return ok({
      planning: reviewPlanning,
      judge_dispatch: context.judge_dispatch
    });
  };

  const planner: QuestionPlanner = {
    async planExperienceReview(input) {
      const key = contextKey(
        input.snapshot.snapshot_id,
        input.snapshot.proposal_id
      );
      const context = state.prepared.get(key);
      if (context === undefined) {
        return err(fieldError("planner", "prepared_context_missing"));
      }
      if (!sameBinding(context.binding, input.binding)) {
        return err(
          versionError(
            JSON.stringify(context.binding),
            JSON.stringify(input.binding)
          )
        );
      }
      const evdSnapshot = evdSnapshotFromBody({
        snapshot: {
          snapshot_id: context.snapshot_id,
          snapshot_hash: context.snapshot_hash,
          version_binding: context.binding
        } as ReviewSnapshot,
        experience: context.experience,
        excerpt: context.excerpt,
        source_refs: context.core_snapshot.candidate.source_refs
      });
      const loaded = await createDefaultQuestionPlanner(
        {
          connection: deps.connection,
          blob_store: deps.blob_store,
          source_refs: sourceRefs,
          journal: deps.journal,
          journal_relative_path: deps.journal_relative_path,
          now: deps.now,
          registry_version: deps.registry_version ?? DEFAULT_REGISTRY_VERSION,
          ...(deps.detector_version === undefined
            ? {}
            : { detector_version: deps.detector_version }),
          ...(deps.planner_version === undefined
            ? {}
            : { planner_version: deps.planner_version })
        },
        {
          binding: context.binding,
          progress_from_watermark: 0,
          review_snapshot_id: context.snapshot_id,
          review_snapshot: evdSnapshot
        }
      );
      if (!loaded.ok) return loaded;
      const bundle = loaded.value;
      const coreResult = await bundle.planner.planExperienceReview({
        binding: context.binding,
        snapshot: context.core_snapshot,
        registry: bundle.registry
      });
      const mapped = mapCoreExperiencePlanningResult(coreResult);
      if (!mapped.ok) return mapped;
      if (
        input.template.template_id !== EXPERIENCE_MATCH_TEMPLATE_ID ||
        input.template.template_version !== EXPERIENCE_MATCH_TEMPLATE_VERSION ||
        input.template.template_hash !== context.template_hash
      ) {
        return err(
          fieldError("template.template_hash", "prepared_template_mismatch")
        );
      }
      if (input.deadline_at <= nowMs(now)) {
        return err(
          fieldError("deadline_at", "expired", "E_DEADLINE_EXCEEDED")
        );
      }
      if (mapped.value.outcome === "planned") {
        if (
          mapped.value.plan.questions.some(
            (question) => question.template_hash !== context.template_hash
          )
        ) {
          return err(
            fieldError("plan.questions", "template_hash_mismatch")
          );
        }
        const planId = mapped.value.plan.plan_id;
        const prior = state.planned.get(planId);
        if (
          prior !== undefined &&
          prior.prepared.proposal_id !== context.proposal_id
        ) {
          return err(
            kernelError("E_CONFLICT", {
              details: {
                kind: "field",
                path: "plan_id",
                rule: "shared_experience_plan_across_proposals"
              }
            })
          );
        }
        if (coreResult.status === "planned") {
          state.planned.set(planId, {
            prepared: context,
            core_plan: coreResult.plan,
            bundle
          });
        }
      }
      return ok(mapped.value);
    }
  };

  const judge: JudgeService = {
    async judgeExperienceMatch(input: ExperienceMatchJudgeInput) {
      const planned = state.planned.get(input.plan_id);
      if (planned === undefined) {
        return err(fieldError("plan_id", "planned_context_missing"));
      }
      if (
        input.plan_hash !== planned.core_plan.plan_hash ||
        !sameBinding(input.version_binding, planned.prepared.binding)
      ) {
        return err(versionError(input.plan_hash, planned.core_plan.plan_hash));
      }
      if (input.budget.deadline_at <= nowMs(now)) {
        return err(
          fieldError("budget.deadline_at", "expired", "E_DEADLINE_EXCEEDED")
        );
      }
      const validation = validateExperienceMatchInput(input, {
        plan_id: planned.core_plan.plan_id,
        plan_hash: planned.core_plan.plan_hash,
        issue_id: planned.core_plan.issue_id,
        questions: planned.core_plan.questions.map((question) => ({
          question_key: question.question_key,
          question_id: question.question_id,
          template_id: question.template_id,
          template_version: question.template_version,
          template_hash: question.template_hash,
          options: question.options
        }))
      });
      if (validation.status === "rejected") {
        return err(fieldError(validation.error.rule, validation.error.code));
      }
      const resolved = await resolveDefaultEvidenceBinding(
        deps.connection,
        composition.binding
      );
      if (!resolved.ok) return resolved;
      const liveProfile = resolved.value.service_profile;
      if (
        liveProfile.schema_version !== "rsi.jev_service_profile/1" ||
        liveProfile.profile_id !== planned.prepared.evd_profile.profile_id ||
        resolved.value.service_profile_key !==
          planned.prepared.resolved.service_profile_key ||
        resolved.value.validator_binding_id !==
          planned.prepared.resolved.validator_binding_id ||
        resolved.value.validator_binding_key !==
          planned.prepared.resolved.validator_binding_key
      ) {
        return err(fieldError("evd.service_profile", "changed_since_prepare"));
      }
      const evidencePorts = createDefaultQuestionEvidencePorts({
        plans: planned.bundle.plans,
        issues: planned.bundle.issues
      });
      const plan = await evidencePorts.plans.readPlan({
        plan_id: input.plan_id as Id,
        plan_hash: input.plan_hash,
        binding: input.version_binding
      });
      if (!plan.ok) return plan;
      const compiled = await reuseOrCompileBinding({
        connection: deps.connection,
        blob_store: deps.blob_store,
        composition,
        bundle: planned.bundle,
        plan: plan.value,
        resolved: resolved.value,
        binding: input.version_binding,
        now,
        clock
      });
      if (!compiled.ok) return compiled;
      const request = compiled.value;
      const requestSources = sortedUniqueRefs(
        request.request.evidence.map((entry) => entry.source_ref)
      );
      const denied = requestSources.filter(
        (ref) => !planned.prepared.approved_refs.has(ref)
      );
      if (denied.length > 0) {
        return err(
          revError({
            code: "E_REVIEW_EGRESS_NOT_APPROVED",
            details: {
              kind: "egress",
              policy_version: "egress/default",
              denied_dimension: "approval",
              refs: denied
            }
          })
        );
      }
      const decision = await planned.prepared.egress.decide({
        purpose: "review_match",
        binding: input.version_binding,
        sources: requestSources,
        endpoint: planned.prepared.endpoint,
        model_id: planned.prepared.model_id
      });
      if (!decision.ok) return decision;
      if (!decision.value.allowed) {
        return err(
          revError({
            code: "E_REVIEW_EGRESS_NOT_APPROVED",
            details: {
              kind: "egress",
              policy_version: "egress/default",
              denied_dimension: "approval",
              refs: requestSources
            }
          })
        );
      }
      const decided = new Set(decision.value.sources);
      if (
        decided.size !== requestSources.length ||
        requestSources.some((ref) => !decided.has(ref))
      ) {
        return err(
          revError({
            code: "E_REVIEW_EGRESS_NOT_APPROVED",
            details: {
              kind: "egress",
              policy_version: "egress/default",
              denied_dimension: "approval",
              refs: requestSources
            }
          })
        );
      }
      const gateway = createJudgeGateway({
        backend: deps.jev_transport,
        late: composition.reader,
        now,
        clock,
        next_attempt_no: (bindingId) =>
          composition.reader.next_attempt_no(bindingId),
        attempts: attemptPersistence(composition),
        jev_profile: planned.prepared.evd_profile
      });
      const attempt = await gateway.dispatch(
        request,
        resolved.value.limits,
        new AbortController().signal
      );
      return ok(
        mapJudgeAttemptToReviewResult(attempt, {
          service_profile_id: input.service_profile_id,
          validator_binding_id: resolved.value.validator_binding_id,
          questions: planned.core_plan.questions.map((question) => ({
            question_key: question.question_key,
            question_id: question.question_id
          }))
        })
      );
    }
  };

  return {
    planner,
    judge,
    judge_prepare: prepare,
    review_options: { planner, judge, judge_prepare: prepare },
    composition
  };
}
