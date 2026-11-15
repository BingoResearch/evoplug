/**
 * JudgeState /2 projection and validation (DD-QP-24, DD-QP-25).
 *
 * Projection reads only the frozen snapshot and the persisted plan. Wire
 * state carries display ids and excerpts; source refs and text hashes stay in
 * the EVD manifest. `validateJudgeState` is a pure function over the state,
 * plan and selected question keys.
 */

import { compareUtf8, sortUtf8 } from "../canonical.js";
import type { SourceRef } from "../source-ref.js";
import type { FailureCode } from "./errors.js";
import { hashJson } from "./hashes.js";
import type { VersionBinding } from "../version-binding.js";
import { MAX_EXCERPT_BYTES } from "./constants.js";
import { QpDomainError } from "./issue_repository.js";
import { failureCode, isFailureCode, qpFailure } from "./errors.js";
import { sortedUnique, sortedUniqueRefs } from "./hashes.js";
import { mapExcerptFailure, parseFactValue } from "./plan_builder.js";
import type {
  EvidenceDependency,
  EvidenceGapCode,
  IssueType,
  JudgeCoverage,
  JudgeEvidence,
  JudgeExperienceCandidate,
  JudgeLatestInput,
  JudgeRequirement,
  JudgeState,
  JudgeStateViewName,
  JudgeTaskCondition,
  JudgeComparison,
  PlanState,
  PlanSource,
  PlannedQuestion,
  ProjectionResult,
  ProjectionValidationInput,
  ProjectionValidationResult,
  QuestionPlan,
  SourceRole
} from "./types.js";
import type {
  ComparisonView,
  CoverageSnapshotView,
  EvidenceFactView,
  EvidenceIndexSnapshot,
  ExperienceCandidateView,
  FeedbackView,
  RequirementView,
  TaskConditionView,
  UnverifiedConstraintView
} from "./ports.js";
import { factArtifactVersion, factSubject } from "./ports.js";

const ROLE_RANK: Readonly<Record<SourceRole, number>> = Object.freeze({
  target: 0,
  support: 1,
  counter: 2,
  definition: 3,
  context: 4
});

const VOLATILE_KEYS: readonly string[] = Object.freeze([
  "request_hash",
  "request_id",
  "pack_id",
  "shard_id",
  "binding_id",
  "deadline_ms",
  "expires_at",
  "nonce",
  "random_seed",
  "question_id",
  "plan_id",
  "issue_id"
]);

function excerptOf(snapshot: EvidenceIndexSnapshot, ref: SourceRef): string {
  const result = snapshot.readExcerpt(ref, { kind: "exact" }, MAX_EXCERPT_BYTES);
  if (!result.ok) {
    throw mapExcerptFailure(result.code);
  }
  if (typeof result.text === "string") return result.text;
  return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
}

function firstRef(source: PlanSource): SourceRef {
  const ref = source.source_refs[0];
  if (ref === undefined) {
    throw new QpDomainError(qpFailure("E_PROJECTION_SOURCE_MISSING", "project", { source_id: source.source_id }));
  }
  return ref;
}

function contractIdFor(fact: EvidenceFactView): string {
  return hashJson({
    schema_version: "rsi.contract_id/1",
    path: factSubject(fact) ?? "",
    artifact_version: factArtifactVersion(fact)
  }).slice("sha256:".length);
}

function dependencyForSource(plan: QuestionPlan, sourceId: string): EvidenceDependency | null {
  return plan.dependencies.find((dependency) => dependency.source_ids.includes(sourceId)) ?? null;
}

function requirementAcceptance(view: RequirementView): { kind: JudgeRequirement["acceptance"]["kind"]; criterion: string; acceptance_ref_id?: string } {
  const acceptance = view.acceptance;
  if (Array.isArray(acceptance)) {
    const first = acceptance[0];
    return {
      kind: "test",
      criterion: typeof first?.text === "string" ? first.text : view.requirement_id
    };
  }
  const single = acceptance as { kind?: unknown; criterion?: unknown; acceptance_ref_id?: unknown };
  const kind =
    single.kind === "human_acceptance" || single.kind === "test" || single.kind === "artifact" || single.kind === "constraint"
      ? single.kind
      : "test";
  return {
    kind,
    criterion: typeof single.criterion === "string" ? single.criterion : view.requirement_id,
    ...(typeof single.acceptance_ref_id === "string" ? { acceptance_ref_id: single.acceptance_ref_id } : {})
  };
}

function requirementLeaf(
  snapshot: EvidenceIndexSnapshot,
  view: RequirementView,
  display_id: string
): JudgeRequirement {
  const acceptanceView = requirementAcceptance(view);
  const leaf: JudgeRequirement = {
    display_id,
    logical_id: `requirement:${view.requirement_id}`,
    quote: excerptOf(snapshot, view.statement_ref),
    valid_from_event: view.valid_from_event,
    goal_version: view.goal_version,
    acceptance: {
      kind: acceptanceView.kind,
      criterion: acceptanceView.criterion
    }
  };
  if (acceptanceView.acceptance_ref_id !== undefined) {
    leaf.acceptance.acceptance_ref_id = acceptanceView.acceptance_ref_id;
  }
  const scope: NonNullable<JudgeRequirement["scope"]> = {};
  if (view.scope.paths !== undefined) {
    scope.paths = sortedUnique(view.scope.paths);
  }
  if (view.scope.excluded_paths !== undefined) {
    scope.excluded_paths = sortedUnique(view.scope.excluded_paths);
  }
  if (view.scope.objects !== undefined) {
    scope.objects = sortedUnique(view.scope.objects);
  }
  if (Object.keys(scope).length > 0) {
    leaf.scope = scope;
  }
  return leaf;
}

function factLeaf(
  snapshot: EvidenceIndexSnapshot,
  fact: EvidenceFactView,
  source: PlanSource,
  display_id: string,
  plan: QuestionPlan
): JudgeEvidence {
  const excerpt = excerptOf(snapshot, firstRef(source));
  const factVersion = factArtifactVersion(fact) ?? "";
  const base = {
    display_id,
    logical_id: source.source_id,
    role: sourceRoleToTransport(source.role),
    excerpt,
    requirement_ids: [...source.requirement_ids]
  };
  switch (fact.kind) {
    case "code":
      return {
        ...base,
        artifact_version: factVersion,
        kind: "code",
        path: source.subject ?? "",
        version: factVersion
      };
    case "interface_contract":
      return {
        ...base,
        artifact_version: factVersion,
        kind: "interface_contract",
        path: source.subject ?? "",
        version: factVersion
      };
    case "test": {
      const value = parseFactValue("test", fact.value);
      if (value.schema_version !== "rsi.fact_value/test/1") {
        throw new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "project", { fact_kind: "test" }));
      }
      return {
        ...base,
        artifact_version: factVersion,
        kind: "test",
        command: value.command,
        tested_snapshot: value.tested_snapshot,
        exit_code: value.exit_code,
        assertions: value.assertions.map((entry) => ({
          name: entry.name,
          result: entry.result,
          requirement_id: entry.requirement_id
        })),
        not_covered: [...value.not_covered]
      };
    }
    case "call": {
      const value = parseFactValue("call", fact.value);
      if (value.schema_version !== "rsi.fact_value/call/1") {
        throw new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "project", { fact_kind: "call" }));
      }
      const dependency = dependencyForSource(plan, source.source_id);
      if (dependency === null) {
        throw new QpDomainError(
          qpFailure("E_PLAN_CLOSURE_INCOMPLETE", "project", { source_id: source.source_id })
        );
      }
      return {
        ...base,
        artifact_version: factVersion,
        kind: "call",
        tool: value.tool,
        call_status: value.call_status,
        call_id: dependency.dependency_key
      };
    }
    case "result": {
      const value = parseFactValue("result", fact.value);
      if (value.schema_version !== "rsi.fact_value/result/1") {
        throw new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "project", { fact_kind: "result" }));
      }
      const dependency = dependencyForSource(plan, source.source_id);
      if (dependency === null) {
        throw new QpDomainError(
          qpFailure("E_PLAN_CLOSURE_INCOMPLETE", "project", { source_id: source.source_id })
        );
      }
      return {
        ...base,
        artifact_version: factVersion,
        kind: "result",
        call_id: dependency.dependency_key,
        exit_code: value.exit_code,
        truncated: value.truncated
      };
    }
    case "diff": {
      const value = parseFactValue("diff", fact.value);
      if (value.schema_version !== "rsi.fact_value/diff/1") {
        throw new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "project", { fact_kind: "diff" }));
      }
      return {
        ...base,
        artifact_version: factVersion,
        kind: "diff",
        path: source.subject ?? "",
        before_version: value.before_version,
        after_version: value.after_version,
        diff_excerpt: excerpt
      };
    }
    case "message": {
      const value = parseFactValue("message", fact.value);
      if (value.schema_version !== "rsi.fact_value/message/1") {
        throw new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "project", { fact_kind: "message" }));
      }
      return {
        ...base,
        artifact_version: factVersion,
        kind: "message",
        message_status: value.message_status,
        origin: parseOrigin(value.origin)
      };
    }
  }
}

function parseOrigin(value: string): "human" | "agent" | "tool" | "evaluator" | "system" | "unknown" {
  switch (value) {
    case "human":
    case "agent":
    case "tool":
    case "evaluator":
    case "system":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function sourceRoleToTransport(role: SourceRole): "requirement" | "feedback" | "artifact" | "verifier" | "counter" | "history" | "context" {
  switch (role) {
    case "target":
      return "artifact";
    case "support":
      return "artifact";
    case "counter":
      return "counter";
    case "definition":
      return "artifact";
    case "context":
      return "context";
  }
}

function feedbackLeaf(snapshot: EvidenceIndexSnapshot, view: FeedbackView, source: PlanSource, display_id: string): JudgeEvidence {
  return {
    display_id,
    logical_id: source.source_id,
    role: "feedback",
    excerpt: excerptOf(snapshot, firstRef(source)),
    requirement_ids: [...source.requirement_ids],
    kind: "feedback",
    signal_kind: view.signal_kind,
    target_issue_id: view.target_issue_id
  };
}

function unverifiedLeaf(
  snapshot: EvidenceIndexSnapshot,
  view: UnverifiedConstraintView,
  source: PlanSource,
  display_id: string
): JudgeEvidence {
  return {
    display_id,
    logical_id: source.source_id,
    role: "context",
    excerpt: excerptOf(snapshot, firstRef(source)),
    requirement_ids: [],
    kind: "unverified_constraint",
    constraint_status: view.status,
    authorization: false
  };
}

function experienceLeaf(
  snapshot: EvidenceIndexSnapshot,
  view: ExperienceCandidateView,
  source: PlanSource,
  display_id: string
): JudgeExperienceCandidate {
  const candidate = view.candidate;
  return {
    display_id,
    logical_id: source.source_id,
    experience_id: candidate.experience_id,
    version: candidate.version,
    content_hash: candidate.content_hash,
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    trigger: candidate.trigger,
    scope: candidate.scope,
    preconditions: candidate.preconditions,
    steps: candidate.steps,
    expected_effects: [...candidate.expected_effects],
    completion_check: candidate.completion_check,
    counterexamples: candidate.counterexamples,
    risk: candidate.risk,
    excerpt: excerptOf(snapshot, firstRef(source)),
    shortlist: candidate.shortlist
  };
}

function firstTaskRef(view: TaskConditionView): SourceRef {
  const ref = view.source_refs[0];
  if (ref === undefined) {
    throw new QpDomainError(qpFailure("E_PROJECTION_SOURCE_MISSING", "project", { logical_id: view.logical_id }));
  }
  return ref;
}

function taskConditionLeaf(snapshot: EvidenceIndexSnapshot, view: TaskConditionView, display_id: string): JudgeTaskCondition {
  return {
    display_id,
    logical_id: view.logical_id,
    condition_id: view.condition_id,
    value: view.value,
    quote: excerptOf(snapshot, firstTaskRef(view)),
    origin: view.origin
  };
}

function findRequirement(snapshot: EvidenceIndexSnapshot, binding: VersionBinding, id: string): RequirementView | null {
  return (
    snapshot
      .listRequirements({ binding, watermark: binding.watermark })
      .find((requirement) => requirement.requirement_id === id) ?? null
  );
}

function findFact(snapshot: EvidenceIndexSnapshot, binding: VersionBinding, id: string): EvidenceFactView | null {
  return (
    snapshot
      .listFacts({ binding, watermark: binding.watermark })
      .find((fact) => fact.fact_id === id) ?? null
  );
}

function sourceIdKind(sourceId: string): "requirement" | "fact" | "interface_contract" | "feedback" | "comparison" | "coverage" | "task_condition" | "experience" | "unverified_constraint" | "unknown" {
  if (sourceId.startsWith("requirement:")) {
    return "requirement";
  }
  if (sourceId.startsWith("fact:")) {
    return "fact";
  }
  if (sourceId.startsWith("interface_contract:")) {
    return "interface_contract";
  }
  if (sourceId.startsWith("feedback:")) {
    return "feedback";
  }
  if (sourceId.startsWith("view:comparison:")) {
    return "comparison";
  }
  if (sourceId.startsWith("view:coverage:")) {
    return "coverage";
  }
  if (sourceId.startsWith("task_condition:")) {
    return "task_condition";
  }
  if (sourceId.startsWith("experience:")) {
    return "experience";
  }
  if (sourceId.startsWith("unverified_constraint:")) {
    return "unverified_constraint";
  }
  return "unknown";
}

/** Builds a JudgeState /2 for a selected shard. */
export function projectJudgeState(input: {
  plan: QuestionPlan;
  snapshot: EvidenceIndexSnapshot;
  shard: { shard_id: string; question_keys: string[]; pack_hash: string };
  /**
   * Only the lifecycle belongs to this decision. Callers that hold the full
   * `PlanState` row pass it unchanged; EVD's shard planner reads the lifecycle
   * through `PlanReadPort` and passes the projected view.
   */
  plan_state: Pick<PlanState, "state"> | null;
  review_snapshot_id?: string;
}): ProjectionResult {
  const { plan, snapshot } = input;
  if (input.plan_state === null || input.plan_state.state !== "active") {
    return {
      status: "rejected",
      errors: [{ code: "E_PLAN_STALE", question_keys: [] }]
    };
  }
  const selectedKeys = sortedUnique(input.shard.question_keys);
  for (const key of selectedKeys) {
    if (!plan.questions.some((question) => question.question_key === key)) {
      return {
        status: "rejected",
        errors: [{ code: "E_TEMPLATE_BINDING_MISSING", question_keys: [key] }]
      };
    }
  }
  const selectedQuestions = plan.questions.filter((question) => selectedKeys.includes(question.question_key));
  const usedSourceIds = sortedUnique(selectedQuestions.flatMap((question) => question.required_source_ids));
  const sourcesById = new Map(plan.sources.map((source) => [source.source_id, source]));
  const errors: Array<{ code: FailureCode; question_keys: string[]; logical_ids?: string[] }> = [];
  const missingSources: string[] = [];
  for (const sourceId of usedSourceIds) {
    if (!sourcesById.has(sourceId)) {
      missingSources.push(sourceId);
    }
  }
  if (missingSources.length > 0) {
    return {
      status: "rejected",
      errors: [{ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: missingSources }]
    };
  }

  const requirements: JudgeRequirement[] = [];
  const evidence: JudgeEvidence[] = [];
  const taskConditions: JudgeTaskCondition[] = [];
  const experienceCandidates: JudgeExperienceCandidate[] = [];
  let comparison: JudgeComparison | null = null;
  let coverageView: CoverageSnapshotView | null = null;
  let latestInput: JudgeLatestInput | null = null;

  const requirementSources: Array<{ source: PlanSource; view: RequirementView }> = [];
  const factSources: Array<{ source: PlanSource; view: EvidenceFactView }> = [];
  const feedbackSources: Array<{ source: PlanSource; view: FeedbackView }> = [];
  const experienceSources: Array<{ source: PlanSource; view: ExperienceCandidateView }> = [];
  const unverifiedSources: Array<{ source: PlanSource; view: UnverifiedConstraintView }> = [];
  const taskConditionViews: Array<{ source: PlanSource; view: TaskConditionView }> = [];

  for (const sourceId of usedSourceIds) {
    const source = sourcesById.get(sourceId);
    if (source === undefined) {
      continue;
    }
    switch (source.kind) {
      case "requirement": {
        const id = sourceId.slice("requirement:".length);
        const view = findRequirement(snapshot, plan.binding, id);
        if (view === null) {
          errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        requirementSources.push({ source, view });
        break;
      }
      case "code":
      case "interface_contract":
      case "call":
      case "result":
      case "diff":
      case "test":
      case "message": {
        let view: EvidenceFactView | null = null;
        if (sourceId.startsWith("fact:")) {
          view = findFact(snapshot, plan.binding, sourceId.slice("fact:".length));
        } else if (sourceId.startsWith("interface_contract:")) {
          const contractId = sourceId.slice("interface_contract:".length);
          view =
            snapshot
              .listFacts({ binding: plan.binding, watermark: plan.binding.watermark })
              .find((fact) => fact.kind === "interface_contract" && contractIdFor(fact) === contractId) ?? null;
        }
        if (view === null || view.kind !== source.kind) {
          errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        factSources.push({ source, view });
        break;
      }
      case "feedback": {
        const id = sourceId.slice("feedback:".length);
        const view =
          snapshot
            .listFeedback({ binding: plan.binding, watermark: plan.binding.watermark })
            .find((entry) => entry.feedback_id === id) ?? null;
        if (view === null) {
          errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        feedbackSources.push({ source, view });
        break;
      }
      case "comparison": {
        const view =
          snapshot
            .listComparisons({ binding: plan.binding, watermark: plan.binding.watermark })
            .find((entry) => `view:comparison:${entry.view_key}` === sourceId) ?? null;
        if (view === null) {
          errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        if (comparison === null) {
          comparison = {
            comparison_view_key: `view:comparison:${view.view_key}`,
            before_watermark: view.before_watermark,
            after_watermark: view.after_watermark,
            goal_version: view.goal_version,
            before_evidence_ids: [],
            after_evidence_ids: [],
            new_information: [],
            pending_calls: sortedUnique(view.pending_calls),
            excluded_hypothesis_ids: sortedUnique(view.excluded_hypothesis_ids)
          };
        }
        break;
      }
      case "coverage": {
        coverageView = snapshot.getCoverageSnapshot({ binding: plan.binding, watermark: plan.binding.watermark });
        break;
      }
      case "experience": {
        const view =
          snapshot
            .listExperienceCandidates({
              binding: plan.binding,
              review_snapshot_id: snapshot.review_snapshot_id ?? ""
            })
            .find((entry) => entry.logical_id === sourceId) ?? null;
        if (view === null) {
          errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        experienceSources.push({ source, view });
        break;
      }
      case "task_condition": {
        const view =
          snapshot
            .listTaskConditions({ binding: plan.binding, watermark: plan.binding.watermark })
            .find((entry) => entry.logical_id === sourceId) ?? null;
        if (view === null) {
          errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        taskConditionViews.push({ source, view });
        break;
      }
      case "unverified_constraint": {
        const view =
          snapshot
            .listUnverifiedConstraints({ binding: plan.binding, watermark: plan.binding.watermark })
            .find((entry) => entry.logical_id === sourceId) ?? null;
        if (view === null) {
          errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        if (
          view.authorization !== false ||
          !["unverified_constraint", "confirmed", "rejected"].includes(view.status)
        ) {
          errors.push({ code: "E_SCHEMA", question_keys: selectedKeys, logical_ids: [sourceId] });
          continue;
        }
        unverifiedSources.push({ source, view });
        break;
      }
      case "fact":
        errors.push({ code: "E_PROJECTION_SOURCE_MISSING", question_keys: selectedKeys, logical_ids: [sourceId] });
        break;
    }
  }
  if (errors.length > 0) {
    return { status: "rejected", errors };
  }

  // Requirements first so R display ids do not depend on evidence ordering.
  const orderedRequirements = sortUtf8(requirementSources, (entry) => entry.source.source_id);
  orderedRequirements.forEach((entry, index) => {
    requirements.push(requirementLeaf(snapshot, entry.view, `R${String(index + 1)}`));
  });
  const orderedFacts = sortUtf8(factSources, (entry) => entry.source.source_id);
  orderedFacts.forEach((entry, index) => {
    evidence.push(
      factLeaf(snapshot, entry.view, entry.source, `E${String(index + 1)}`, plan)
    );
  });
  const orderedFeedback = sortUtf8(feedbackSources, (entry) => entry.source.source_id);
  orderedFeedback.forEach((entry) => {
    evidence.push(feedbackLeaf(snapshot, entry.view, entry.source, `E${String(evidence.length + 1)}`));
  });
  const orderedUnverified = sortUtf8(unverifiedSources, (entry) => entry.source.source_id);
  orderedUnverified.forEach((entry) => {
    evidence.push(unverifiedLeaf(snapshot, entry.view, entry.source, `E${String(evidence.length + 1)}`));
  });
  const orderedConditions = sortUtf8(taskConditionViews, (entry) => entry.source.source_id);
  orderedConditions.forEach((entry, index) => {
    taskConditions.push(taskConditionLeaf(snapshot, entry.view, `C${String(index + 1)}`));
  });
  const orderedExperience = sortUtf8(experienceSources, (entry) => entry.source.source_id);
  orderedExperience.forEach((entry, index) => {
    experienceCandidates.push(experienceLeaf(snapshot, entry.view, entry.source, `X${String(index + 1)}`));
  });

  // Latest input is built from the applied/proposed operation quote when present.
  const ops = snapshot.listRequirementOps({
    binding: plan.binding,
    watermark: plan.binding.watermark,
    statuses: ["applied", "proposed", "conflict"]
  });
  const latestOp = sortUtf8(ops, (entry) => entry.op_id).find(
    (entry) => entry.source_quote_ref !== null && entry.status !== "conflict"
  );
  if (latestOp !== undefined && latestOp.source_quote_ref !== null) {
    latestInput = {
      display_id: "U1",
      logical_id: latestOp.created_requirement_id === null ? "requirement:input" : `requirement:${latestOp.created_requirement_id}`,
      quote: excerptOf(snapshot, latestOp.source_quote_ref),
      origin: latestOp.actor_origin,
      directive_strength: latestOp.directive_strength,
      requirement_operation: latestOp.op,
      requirement_op_status: latestOp.status,
      goal_changed: latestOp.goal_version_before !== latestOp.goal_version_after
    };
  }

  const coverageSnapshot =
    coverageView ?? snapshot.getCoverageSnapshot({ binding: plan.binding, watermark: plan.binding.watermark });
  const coverage = buildCoverage(plan, selectedQuestions, coverageSnapshot, evidence);

  const scope = {
    issue_key: plan.issue_key,
    issue_type: plan.issue_type,
    scope_kind: plan.state_profile === "experience_review" ? ("experience_review" as const) : ("issue" as const),
    requirement_ids: sortedUnique(plan.questions.flatMap((question) => question.requirement_ids)),
    artifact_paths: sortedUnique(plan.artifact_paths),
    whole_task_verdict_requested: false
  };

  if (plan.state_profile === "experience_review") {
    const reviewId = input.review_snapshot_id ?? snapshot.review_snapshot_id;
    if (reviewId === null || reviewId === undefined) {
      return {
        status: "rejected",
        errors: [{ code: "E_INDEX_REVIEW_SNAPSHOT_MISSING", question_keys: selectedKeys }]
      };
    }
    const state: JudgeState = {
      schema_version: "rsi.judge_state/2",
      binding: plan.binding,
      question_scope: scope,
      coverage,
      profile: "experience_review",
      requirements,
      task_conditions: taskConditions,
      experience_candidates: experienceCandidates,
      evidence
    };
    return { status: "ok", state };
  }
  const progressState: JudgeState = {
    schema_version: "rsi.judge_state/2",
    binding: plan.binding,
    question_scope: scope,
    coverage,
    profile: "progress_issue",
    requirements,
    evidence
  };
  if (latestInput !== null) {
    progressState.latest_input = latestInput;
  }
  if (comparison !== null) {
    progressState.comparison = comparison;
  }
  return { status: "ok", state: progressState };
}

function buildCoverage(
  plan: QuestionPlan,
  questions: readonly PlannedQuestion[],
  snapshot: CoverageSnapshotView,
  evidence: readonly JudgeEvidence[]
): JudgeCoverage {
  const counterEvidenceIds = evidence
    .filter((entry) => entry.role === "counter")
    .map((entry) => entry.display_id);
  const missing = snapshot.missing.map((entry) => {
    const affected = questions
      .filter((question) => entry.requirement_id === null || question.requirement_ids.includes(entry.requirement_id))
      .map((question) => question.question_key);
    return {
      code: entry.code,
      requirement_id: entry.requirement_id,
      logical_id: entry.logical_id,
      affects_question_keys: sortedUnique(affected)
    };
  });
  missing.sort((left, right) => {
    const byLogical = compareUtf8(left.logical_id ?? "", right.logical_id ?? "");
    return byLogical !== 0 ? byLogical : compareUtf8(left.code, right.code);
  });
  return {
    checked_requirement_ids: sortedUnique(snapshot.checked_requirement_ids),
    searched_sources: sortedUnique(questions.flatMap((question) => question.required_source_ids)),
    counterevidence_evidence_ids: sortedUnique(counterEvidenceIds),
    counterevidence_search_complete_for: sortedUnique(snapshot.checked_requirement_ids),
    omitted: [],
    missing,
    whole_task_coverage_complete: false
  };
}

/** Validates the projection contract (DD-QP-25 step 5). */
export function validateProjection(
  input: ProjectionValidationInput,
  planState: PlanState | null
): ProjectionValidationResult {
  if (planState === null || planState.state !== "active") {
    return {
      status: "rejected",
      errors: [{ code: "E_PLAN_STALE", question_keys: [] }]
    };
  }
  const selected = sortedUnique(input.question_keys);
  const planByKey = new Map(input.plan.questions.map((question) => [question.question_key, question]));
  for (const key of selected) {
    const question = planByKey.get(key);
    if (question === undefined) {
      return {
        status: "rejected",
        errors: [{ code: "E_TEMPLATE_BINDING_MISSING", question_keys: [key] }]
      };
    }
    const presentViews = presentViewNames(input.state);
    const missingViews = question.required_views.filter((view) => !presentViews.has(view));
    if (missingViews.length > 0) {
      return {
        status: "rejected",
        errors: [{ code: "E_PROJECTION_VIEW_MISSING", question_keys: [key] }]
      };
    }
    const logicalIds = presentDerivedLogicalIds(input.state, input.plan);
    const missingSources = question.required_source_ids.filter((sourceId) => !logicalIds.has(sourceId));
    if (missingSources.length > 0) {
      return {
        status: "rejected",
        errors: [
          { code: "E_PROJECTION_SOURCE_MISSING", question_keys: [key], logical_ids: missingSources }
        ]
      };
    }
    if (
      typeof question.template_id !== "string" ||
      question.template_id.length === 0 ||
      typeof question.template_version !== "string" ||
      question.template_version.length === 0 ||
      typeof question.template_hash !== "string" ||
      question.template_hash.length === 0
    ) {
      return {
        status: "rejected",
        errors: [{ code: "E_TEMPLATE_BINDING_MISSING", question_keys: [key] }]
      };
    }
    if (!input.plan.questions.some((planQuestion) => planQuestion.question_key === key && planQuestion.template_hash === question.template_hash)) {
      return {
        status: "rejected",
        errors: [{ code: "E_TEMPLATE_BINDING_MISSING", question_keys: [key] }]
      };
    }
  }
  const required = sortedUnique(selected.flatMap((key) => planByKey.get(key)?.required_source_ids ?? []));
  const present = presentDerivedLogicalIds(input.state, input.plan);
  return {
    status: "ok",
    required_logical_ids: required,
    present_logical_ids: [...present].sort(compareUtf8)
  };
}

function presentViewNames(state: JudgeState): Set<JudgeStateViewName> {
  const views = new Set<JudgeStateViewName>([
    "binding",
    "question_scope",
    "requirements",
    "evidence",
    "coverage"
  ]);
  if (state.profile === "progress_issue") {
    if (state.latest_input !== undefined) {
      views.add("latest_input");
    }
    if (state.comparison !== undefined) {
      views.add("comparison");
    }
  } else {
    views.add("task_conditions");
    views.add("experience_candidates");
  }
  return views;
}

function presentDerivedLogicalIds(state: JudgeState, plan: QuestionPlan): Set<string> {
  const ids = presentLogicalIds(state);
  for (const source of plan.sources) {
    if (source.source_id.startsWith("view:coverage:")) {
      ids.add(source.source_id);
    }
    if (source.source_id.startsWith("view:comparison:") && state.profile === "progress_issue" && state.comparison !== undefined) {
      ids.add(source.source_id);
    }
  }
  return ids;
}

function presentLogicalIds(state: JudgeState): Set<string> {
  const ids = new Set<string>();
  for (const requirement of state.requirements) {
    ids.add(requirement.logical_id);
  }
  for (const entry of state.evidence) {
    ids.add(entry.logical_id);
  }
  if (state.profile === "experience_review") {
    for (const condition of state.task_conditions) {
      ids.add(condition.logical_id);
    }
    for (const candidate of state.experience_candidates) {
      ids.add(candidate.logical_id);
    }
  }
  if (state.profile === "progress_issue" && state.latest_input !== undefined) {
    ids.add(state.latest_input.logical_id);
  }
  return ids;
}

function containsVolatileKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsVolatileKey(entry));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (VOLATILE_KEYS.includes(key)) {
      return true;
    }
    if (containsVolatileKey(entry)) {
      return true;
    }
  }
  return false;
}

/** Pure JudgeState /2 validation in the fixed stage order (DD-QP-25). */
export function validateJudgeState(input: {
  state: JudgeState;
  plan: QuestionPlan;
  question_keys: string[];
}): { status: "ok" } | { status: "rejected"; errors: Array<{ code: FailureCode; question_keys: string[] }> } {
  const raw: Record<string, unknown> = Object.fromEntries(
    Object.entries(input.state)
  );
  const version = raw["schema_version"];
  if (version === "rsi.judge_state/1") {
    return { status: "rejected", errors: [{ code: "E_JUDGE_STATE_V1_READ_ONLY", question_keys: [] }] };
  }
  if (version !== "rsi.judge_state/2") {
    return { status: "rejected", errors: [{ code: "E_STATE_VERSION_UNSUPPORTED", question_keys: [] }] };
  }
  const profile = raw["profile"];
  if (profile !== "progress_issue" && profile !== "experience_review") {
    return { status: "rejected", errors: [{ code: "E_VIEW_PROFILE_MISMATCH", question_keys: [] }] };
  }
  const selected = sortedUnique(input.question_keys);
  const planByKey = new Map(input.plan.questions.map((question) => [question.question_key, question]));
  for (const key of selected) {
    const question = planByKey.get(key);
    if (question === undefined) {
      continue;
    }
    if (question.independence.state_profile !== profile) {
      return { status: "rejected", errors: [{ code: "E_VIEW_PROFILE_MISMATCH", question_keys: [key] }] };
    }
  }
  const presentViews = presentViewNames(input.state);
  for (const key of selected) {
    const question = planByKey.get(key);
    if (question === undefined) {
      continue;
    }
    const missing = question.required_views.filter((view) => !presentViews.has(view));
    if (missing.length > 0) {
      return { status: "rejected", errors: [{ code: "E_PROJECTION_VIEW_MISSING", question_keys: [key] }] };
    }
  }
  const scope = input.state.question_scope;
  if (
    (scope.scope_kind !== "issue" && scope.scope_kind !== "experience_review") ||
    scope.whole_task_verdict_requested !== false ||
    input.state.coverage.whole_task_coverage_complete !== false ||
    scope.requirement_ids.some((id) => !input.plan.questions.some((question) => question.requirement_ids.includes(id))) ||
    scope.artifact_paths.some((path) => !input.plan.artifact_paths.includes(path))
  ) {
    return { status: "rejected", errors: [{ code: "E_STATE_WHOLE_TASK_SCOPE", question_keys: selected }] };
  }
  if (containsVolatileKey(raw)) {
    return { status: "rejected", errors: [{ code: "E_STATE_VOLATILE_FIELD", question_keys: selected }] };
  }
  const planKeys = input.plan.questions.map((question) => question.question_key).filter((key) => selected.includes(key));
  if (new Set(selected).size !== selected.length || sortedUnique(planKeys).length !== selected.length) {
    return { status: "rejected", errors: [{ code: "E_TEMPLATE_BINDING_MISSING", question_keys: selected }] };
  }
  for (const key of selected) {
    const question = planByKey.get(key);
    if (question === undefined) {
      return { status: "rejected", errors: [{ code: "E_TEMPLATE_BINDING_MISSING", question_keys: [key] }] };
    }
    const optionKeys = question.options;
    const criteriaKeys = Object.keys(question.criteria);
    if (
      optionKeys.length !== criteriaKeys.length ||
      optionKeys.some((option) => !criteriaKeys.includes(option)) ||
      !optionKeys.includes("unknown") ||
      question.required_for_issue !== true
    ) {
      return { status: "rejected", errors: [{ code: "E_TEMPLATE_BINDING_MISSING", question_keys: [key] }] };
    }
    const effectKeys = Object.keys(question.option_effects);
    if (
      effectKeys.length !== optionKeys.length ||
      effectKeys.some((effectKey) => !optionKeys.includes(effectKey)) ||
      Object.values(question.option_effects).some(
        (effect) => effect !== "supports" && effect !== "contradicts" && effect !== "unknown"
      )
    ) {
      return { status: "rejected", errors: [{ code: "E_PLAN_AGGREGATION_BINDING", question_keys: [key] }] };
    }
    for (const option of question.options) {
      const effect = question.answer_to_issue_map[option];
      if (effect === undefined) {
        return { status: "rejected", errors: [{ code: "E_PLAN_AGGREGATION_BINDING", question_keys: [key] }] };
      }
      if (effect.can_close_issue !== false || effect.can_satisfy_task !== false) {
        return { status: "rejected", errors: [{ code: "E_CONFIRMATION_KIND_NOT_ALLOWED", question_keys: [key] }] };
      }
    }
    if (question.template_id === "qt.experience_match" && profile !== "experience_review") {
      return { status: "rejected", errors: [{ code: "E_VIEW_PROFILE_MISMATCH", question_keys: [key] }] };
    }
  }
  return { status: "ok" };
}

/** Assertion helper used by callers that want a thrown domain error. */
export function assertValidJudgeState(input: {
  state: JudgeState;
  plan: QuestionPlan;
  question_keys: string[];
}): void {
  const result = validateJudgeState(input);
  if (result.status === "rejected") {
    const first = result.errors[0];
    throw new QpDomainError(qpFailure(first === undefined ? "E_SCHEMA" : first.code, "validate_state"));
  }
}
