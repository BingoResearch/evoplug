/**
 * QuestionPlanner (DD-QP-26, DD-QP-26a).
 *
 * The class constructor is module-private; `createQuestionPlanner` in
 * `question_planner_factory.ts` is the only public construction path. Every
 * command validates in the DD-QP-05a stage order, writes through the issue
 * repository, and returns the documented result shape.
 */

import { newId } from "../ids.js";
import { systemClock, type Clock } from "../clock.js";
import { MAX_EXCERPT_BYTES } from "./constants.js";
import { parseSourceRef } from "../source-ref.js";
import { equalVersionBinding } from "../version-binding.js";
import { compareUtf8, sortUtf8 } from "../canonical.js";
import type { VersionBinding } from "../version-binding.js";
import type { SourceRef } from "../source-ref.js";
import { MAX_SOURCE_REFS } from "./constants.js";
import { builtinTemplateMap, registryTemplateBodies, renderTemplate, requireTemplateFromRegistry } from "./templates.js";
import { QpDomainError } from "./issue_repository.js";
import { failureCode, qpFailure, type FailureCode } from "./errors.js";
import {
  applyTransition,
  confirmationKindAllowed,
  confirmationProjection,
  closeKindAllowed,
  createProposedIssue,
  transitionTarget,
  type IssueTransitionPatch
} from "./issue_lifecycle.js";
import { closeEvidenceHash, closePayloadHash, issueKey as computeIssueKey, sortRequirementResults, sortedUnique, sortedUniqueRefs } from "./hashes.js";
import { hashBytes, isHash } from "../hash.js";
import { err, ok, type Result } from "../result.js";
import type { ErrorEnvelope } from "../errors.js";
import { buildPlanIdempotencyKey, buildQuestionPlan, initialPlanStateDraft, QpPlanBuildError } from "./plan_builder.js";
import { knownIssuePlans, rememberIssuePlan } from "./plan_repository.js";
import { discoverIssues } from "./discovery.js";
import { projectJudgeState, validateJudgeState as validateJudgeStatePure, validateProjection } from "./projection.js";
import { unwrapAcceptedAggregate, unwrapReviewHandoff, type QpAggregateReadResult, type QpReviewHandoffReadResult } from "./boundaries.js";
import {
  buildExperienceNoOpRoute,
  buildExperiencePlannedRoute,
  createJudgmentRouteStore,
  type JudgmentRouteStore
} from "./judgment_route.js";
import { isEvidenceIndexSnapshot } from "./ports.js";
import type {
  JudgeState,
  JudgmentRouteDraft,
  JudgmentRouteReason,
  JudgmentRouteStageName
} from "./types.js";
import type { AbstainIssueCommand, AppendIssueTransitionResult, AttachEvidenceCommand, CloseEvidence, CloseIssueCommand, ConfirmIssueCommand, EvidenceGap, ExperienceReviewPlanningInput, ExperienceReviewPlanningResult, ExperienceReviewRouteRef, InvalidateGoalCommand, Issue, IssueDiscoveryInput, IssueDiscoveryResult, IssueJudgment, IssueJudgmentDraft, IssueTransitionEvent, IssueTransitionResult, JudgeStateValidationInput, JudgeStateValidationResult, JudgeExperienceCandidate, PlanState, PlanValidationInput, PlanValidationResult, PlanningInput, PlanningResult, ProjectionInput, ProjectionResult, ProjectionValidationInput, ProjectionValidationResult, QuestionPlan, QuestionPlanRepository, QuestionTemplate, RejectIssueCommand, ReopenEvidence, ReopenIssueCommand, RequireEvidenceCommand, ReviewHandoffClosure, RecordIssueJudgmentCommand, IssueWriteRepository, ConfirmationEvidence, ConfirmationOrigin, CloseEvidenceDraft } from "./types.js";
import type {
  AcceptedAggregateReadPort,
  EvidenceIndexSnapshot,
  ExperienceCandidateView,
  FrozenSourceExpectationPort,
  ReviewHandoffCloseView,
  ReviewHandoffReadPort,
  SourceCheckPort,
  SourceExpectationEntry
} from "./ports.js";
import type { SourceHashEntry } from "./types.js";
import { isRecord as sharedIsRecord } from "../json.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/** Planner dependencies; `evidence` is the only snapshot injection point. */
export interface QuestionPlannerDeps {
  evidence: EvidenceIndexSnapshot;
  issues: IssueWriteRepository;
  plans: QuestionPlanRepository;
  sourceExpectations: FrozenSourceExpectationPort;
  sources: SourceCheckPort;
  aggregates: AcceptedAggregateReadPort;
  handoffs: ReviewHandoffReadPort;
  /**
   * The route store the planner commits its experience route through.
   *
   * DD-QP-31a: the experience route is persisted before the planning result
   * is returned, and its `route_id`/`route_key`/`route_hash` are the ones the
   * result carries.
   */
  routes?: JudgmentRouteStore;
}

export interface QuestionPlanner {
  readonly deps: QuestionPlannerDeps;
  discover(input: IssueDiscoveryInput): IssueDiscoveryResult;
  confirm(command: ConfirmIssueCommand): IssueTransitionResult;
  attachEvidence(command: AttachEvidenceCommand): IssueTransitionResult;
  requireEvidence(command: RequireEvidenceCommand): IssueTransitionResult;
  recordJudgment(command: RecordIssueJudgmentCommand): Promise<IssueTransitionResult>;
  abstain(command: AbstainIssueCommand): IssueTransitionResult;
  rejectIssue(command: RejectIssueCommand): IssueTransitionResult;
  close(command: CloseIssueCommand): Promise<IssueTransitionResult>;
  reopen(command: ReopenIssueCommand): Promise<IssueTransitionResult>;
  invalidateGoal(command: InvalidateGoalCommand): IssueTransitionResult;
  plan(input: PlanningInput): PlanningResult;
  planExperienceReview(input: ExperienceReviewPlanningInput): Promise<ExperienceReviewPlanningResult>;
  validatePlan(input: PlanValidationInput): PlanValidationResult;
  project(input: ProjectionInput): ProjectionResult;
  validateProjection(input: ProjectionValidationInput): ProjectionValidationResult;
  validateJudgeState(input: JudgeStateValidationInput): JudgeStateValidationResult;
}

function rejectedResult(transition_id: string, code: string): IssueTransitionResult {
  return { status: "rejected", transition_id, deduplicated: false, errors: [failureCode(code)] };
}

function okResult(result: AppendIssueTransitionResult): IssueTransitionResult {
  if (result.judgment !== null) {
    return {
      status: "ok",
      transition_id: result.transition.transition_id,
      issue: result.issue,
      judgment: result.judgment,
      deduplicated: result.deduplicated,
      errors: []
    };
  }
  return {
    status: "ok",
    transition_id: result.transition.transition_id,
    issue: result.issue,
    deduplicated: result.deduplicated,
    errors: []
  };
}

function codeOf(error: QpDomainError): string {
  return error.envelope.code;
}

function excerptOk(snapshot: EvidenceIndexSnapshot, ref: SourceRef): boolean {
  const result = snapshot.readExcerpt(ref, { kind: "exact" }, MAX_EXCERPT_BYTES);
  return result.ok;
}

/**
 * Item-by-item equality of two already sorted and deduplicated ref lists.
 *
 * DD-QP-06 stage 7 and DD-QP-07 require the caller's draft refs to equal the
 * authoritative refs exactly; a length mismatch alone is not enough, because
 * one swapped content address keeps the count.
 */
function sameRefs(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Stage 7 source re-read for `confirm` (DD-QP-09). A ref must resolve, and a
 * full-blob ref must still hash to the digest frozen in its locator; a
 * retrievable ref outside the index's frozen ref set is a changed source.
 */
function recheckConfirmationSource(snapshot: EvidenceIndexSnapshot, ref: SourceRef): void {
  const result = snapshot.readExcerpt(ref, { kind: "exact" }, MAX_EXCERPT_BYTES);
  if (!result.ok) {
    throw new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "confirm"));
  }
  const parsed = parseSourceRef(ref);
  if (
    parsed.ok &&
    parsed.value.scheme === "blob" &&
    parsed.value.start === 0 &&
    parsed.value.end === result.bytes.length &&
    parsed.value.locator !== (result.content_hash ?? hashBytes(result.bytes))
  ) {
    throw new QpDomainError(qpFailure("E_SOURCE_CHANGED", "confirm"));
  }
}

function transitionIdFor(prefix: string, issue_id: string): string {
  const ulid = issue_id.startsWith("issue:") ? issue_id.slice("issue:".length) : issue_id;
  return `${prefix}:${ulid}`.slice(0, 128);
}

const CONFIRMATION_KINDS: readonly ConfirmationEvidence["kind"][] = Object.freeze([
  "human_input",
  "verified_fact",
  "coverage_gap",
  "stable_signal",
  "review_snapshot"
]);

const CONFIRMATION_ORIGINS: readonly ConfirmationOrigin[] = Object.freeze([
  "human",
  "agent",
  "tool",
  "evaluator",
  "system",
  "unknown"
]);

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const entries: unknown[] = value;
  for (const entry of entries) {
    if (typeof entry !== "string") {
      return false;
    }
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function confirmSchemaFailure(field: string): never {
  throw new QpDomainError(qpFailure("E_SCHEMA", "confirm", { field }));
}

const JUDGMENT_COMMAND_KEYS: readonly string[] = Object.freeze([
  "transition_id",
  "issue_id",
  "expected_version",
  "source"
]);

const AGGREGATE_SOURCE_KEYS: readonly string[] = Object.freeze([
  "kind",
  "aggregate_id",
  "expected_aggregate_hash",
  "plan_id",
  "plan_hash"
]);

const LOCAL_FACT_SOURCE_KEYS: readonly string[] = Object.freeze(["kind", "fact_keys"]);

/**
 * Stage 1 closed-shape check for `recordJudgment`. Callers reach this command
 * from JSON boundaries, so caller-supplied `outcome`/`basis`/`accepted` must
 * be rejected before any aggregate read.
 */
function assertJudgmentCommandShape(value: unknown): void {
  const fail = (field: string): never => {
    throw new QpDomainError(qpFailure("E_SCHEMA", "judgment", { field }));
  };
  if (!isRecord(value)) {
    fail("command");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!JUDGMENT_COMMAND_KEYS.includes(key)) {
      fail(key);
    }
  }
  if (!isNonEmptyString(record["transition_id"]) || !isNonEmptyString(record["issue_id"])) {
    fail("transition_id");
  }
  if (!Number.isSafeInteger(record["expected_version"]) || (record["expected_version"] as number) < 0) {
    fail("expected_version");
  }
  const source = record["source"];
  if (!isRecord(source)) {
    fail("source");
  }
  const sourceRecord = source as Record<string, unknown>;
  const kind = sourceRecord["kind"];
  if (kind === "answer_aggregate") {
    for (const key of Object.keys(sourceRecord)) {
      if (!AGGREGATE_SOURCE_KEYS.includes(key)) {
        fail(`source.${key}`);
      }
    }
    for (const field of ["aggregate_id", "expected_aggregate_hash", "plan_id", "plan_hash"]) {
      if (!isNonEmptyString(sourceRecord[field])) {
        fail(`source.${field}`);
      }
    }
    return;
  }
  if (kind === "local_facts") {
    for (const key of Object.keys(sourceRecord)) {
      if (!LOCAL_FACT_SOURCE_KEYS.includes(key)) {
        fail(`source.${key}`);
      }
    }
    if (!isStringArray(sourceRecord["fact_keys"])) {
      fail("source.fact_keys");
    }
    return;
  }
  fail("source.kind");
}

const CLOSE_DRAFT_KEYS: readonly string[] = Object.freeze([
  "kind",
  "evidence_id",
  "source_refs",
  "goal_version",
  "requirement_ids",
  "artifact_version",
  "verifier_ref"
]);

const CLOSE_DRAFT_KINDS: readonly CloseEvidenceDraft["kind"][] = Object.freeze([
  "verified_behavior",
  "verified_artifact",
  "human_acceptance",
  "coverage_completion"
]);

function closeDraftFailure(field: string): never {
  throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close", { field }));
}

/**
 * Stage 6 closed-shape check for `CloseEvidenceDraft`. Jev answers, aggregate
 * ids, confidence scores, agent self-reports and plan checkboxes are not
 * close evidence; unknown fields reject the whole draft.
 */
function assertCloseEvidenceDraft(value: unknown): asserts value is CloseEvidenceDraft {
  if (!isRecord(value)) {
    closeDraftFailure("close_evidence");
  }
  for (const key of Object.keys(value)) {
    if (!CLOSE_DRAFT_KEYS.includes(key)) {
      closeDraftFailure(`close_evidence.${key}`);
    }
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !(CLOSE_DRAFT_KINDS as readonly string[]).includes(kind)) {
    closeDraftFailure("close_evidence.kind");
  }
  if (!isNonEmptyString(value["evidence_id"])) {
    closeDraftFailure("close_evidence.evidence_id");
  }
  if (!isStringArray(value["source_refs"])) {
    closeDraftFailure("close_evidence.source_refs");
  }
  if (!isNonEmptyString(value["goal_version"])) {
    closeDraftFailure("close_evidence.goal_version");
  }
  if (!isStringArray(value["requirement_ids"])) {
    closeDraftFailure("close_evidence.requirement_ids");
  }
  const artifactVersion = value["artifact_version"];
  if (artifactVersion !== null && typeof artifactVersion !== "string") {
    closeDraftFailure("close_evidence.artifact_version");
  }
  const verifierRef = value["verifier_ref"];
  if (verifierRef !== null && typeof verifierRef !== "string") {
    closeDraftFailure("close_evidence.verifier_ref");
  }
}

/**
 * Stage 1 of DD-QP-05a for `confirm`: closed shapes and required fields.
 * `ConfirmationEvidence` is a compile-time contract, but callers reach this
 * command from JSON boundaries, so the same checks run at runtime.
 */
function assertConfirmationShape(value: unknown): void {
  if (!isRecord(value)) {
    confirmSchemaFailure("confirmation");
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !(CONFIRMATION_KINDS as readonly string[]).includes(kind)) {
    confirmSchemaFailure("confirmation.kind");
  }
  if (!isStringArray(value["source_refs"]) || value["source_refs"].length === 0) {
    confirmSchemaFailure("confirmation.source_refs");
  }
  switch (kind) {
    case "human_input":
      if (
        !isNonEmptyString(value["event_id"]) ||
        typeof value["origin"] !== "string" ||
        !(CONFIRMATION_ORIGINS as readonly string[]).includes(value["origin"]) ||
        (value["directive_strength"] !== "explicit" && value["directive_strength"] !== "ambiguous")
      ) {
        confirmSchemaFailure("confirmation.human_input");
      }
      break;
    case "verified_fact":
      if (
        !isStringArray(value["fact_ids"]) ||
        value["fact_ids"].length === 0 ||
        typeof value["artifact_version"] !== "string"
      ) {
        confirmSchemaFailure("confirmation.verified_fact");
      }
      break;
    case "coverage_gap":
      if (
        !isNonEmptyString(value["coverage_snapshot_id"]) ||
        !isNonEmptyString(value["requirement_id"]) ||
        !isStringArray(value["missing_codes"])
      ) {
        confirmSchemaFailure("confirmation.coverage_gap");
      }
      break;
    case "stable_signal":
      if (
        !isNonEmptyString(value["signal_id"]) ||
        value["comparable_checkpoints"] !== 2 ||
        !Array.isArray(value["exclusions"])
      ) {
        confirmSchemaFailure("confirmation.stable_signal");
      }
      break;
    case "review_snapshot":
      if (!isNonEmptyString(value["snapshot_id"]) || !isStringArray(value["experience_ids"])) {
        confirmSchemaFailure("confirmation.review_snapshot");
      }
      break;
    default:
      confirmSchemaFailure("confirmation.kind");
  }
}

function bindingMatchesSnapshot(issue: Issue, snapshotBinding: VersionBinding): boolean {
  return (
    issue.binding.task_id === snapshotBinding.task_id &&
    issue.binding.branch_id === snapshotBinding.branch_id &&
    issue.binding.input_epoch === snapshotBinding.input_epoch &&
    issue.binding.config_version === snapshotBinding.config_version
  );
}

function goalMatchesSnapshot(issue: Issue, snapshotBinding: VersionBinding): boolean {
  return issue.binding.goal_version === snapshotBinding.goal_version;
}

function gapsUnion(left: readonly EvidenceGap[], right: readonly EvidenceGap[]): EvidenceGap[] {
  const byKey = new Map<string, EvidenceGap>();
  for (const gap of [...left, ...right]) {
    const key = `${gap.code}\u0000${sortedUnique(gap.requirement_ids).join(",")}\u0000${sortedUnique(gap.source_refs).join(",")}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        code: gap.code,
        requirement_ids: sortedUnique(gap.requirement_ids),
        source_refs: sortedUniqueRefs(gap.source_refs),
        affects_question_keys: sortedUnique(gap.affects_question_keys)
      });
    }
  }
  return [...byKey.values()];
}

function resolveExpectedEntries(
  result: Awaited<ReturnType<FrozenSourceExpectationPort["resolveExpected"]>>
): SourceExpectationEntry[] {
  if (result.status === "rejected") {
    throw new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "expected_source_hashes"));
  }
  return result.expectations;
}

async function checkObserved(
  port: SourceCheckPort,
  binding: VersionBinding,
  refs: readonly SourceRef[],
  expected: readonly SourceExpectationEntry[]
): Promise<void> {
  const result = await port.check({ binding, refs });
  if (result.status === "rejected") {
    if (result.code === "E_SOURCE_CHANGED") {
      throw new QpDomainError(qpFailure("E_SOURCE_CHANGED", "source_check"));
    }
    throw new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "source_check"));
  }
  const expectedByRef = new Map(expected.map((entry) => [entry.source_ref, entry.content_hash]));
  for (const observed of result.results) {
    if (!observed.retrievable || observed.content_hash === null) {
      throw new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "source_check"));
    }
    const wanted = expectedByRef.get(observed.source_ref);
    if (wanted === undefined || wanted !== observed.content_hash) {
      throw new QpDomainError(qpFailure("E_SOURCE_CHANGED", "source_check"));
    }
  }
}

class QuestionPlannerImpl implements QuestionPlanner {
  readonly deps: QuestionPlannerDeps;
  private readonly clock: Clock;
  private readonly templates = builtinTemplateMap();
  private readonly usedEvidenceIds = new Set<string>();
  private readonly planByIssue = new Map<string, string>();

  constructor(deps: QuestionPlannerDeps, clock: Clock) {
    this.deps = deps;
    this.clock = clock;
  }

  private requireIssue(issue_id: string): Issue {
    const issue = this.deps.issues.getIssue(issue_id);
    if (issue === null) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "issue_command", { issue_id }));
    }
    return issue;
  }

  private guardScope(issue: Issue, expected_version: number): void {
    const snapshotBinding = this.deps.evidence.binding;
    if (!bindingMatchesSnapshot(issue, snapshotBinding)) {
      throw new QpDomainError(qpFailure("E_VERSION_BINDING", "issue_command"));
    }
    if (!goalMatchesSnapshot(issue, snapshotBinding)) {
      throw new QpDomainError(qpFailure("E_GOAL_STALE", "issue_command"));
    }
    if (issue.issue_version !== expected_version) {
      throw new QpDomainError(qpFailure("E_ISSUE_VERSION_CONFLICT", "issue_command"));
    }
  }

  /**
   * The result of an already committed transition with the same id, when the
   * replay belongs to the same issue. A different issue is a collision and
   * is left to the repository.
   */
  private replayTransition(
    transition_id: string,
    issue_id: string
  ): IssueTransitionResult | null {
    const existing = this.deps.issues.getTransition(transition_id);
    if (existing === null || existing.issue_id !== issue_id) {
      return null;
    }
    const stored =
      existing.judgment_ref === null
        ? null
        : this.deps.issues.getIssueJudgment(existing.judgment_ref);
    return {
      status: "ok",
      transition_id: existing.transition_id,
      issue: existing.issue_after,
      ...(stored === null ? {} : { judgment: stored }),
      deduplicated: true,
      errors: []
    };
  }

  private transition(
    issue: Issue,
    input: {
      transition_id: string;
      event: IssueTransitionEvent;
      patch?: IssueTransitionPatch;
      judgment?: IssueJudgmentDraft;
    }
  ): IssueTransitionResult {
    const target = transitionTarget(input.event, issue.state, issue.type);
    if (target === null) {
      throw new QpDomainError(
        qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "issue_command", {
          from_state: issue.state,
          event: input.event
        })
      );
    }
    const at = this.clock.utcNowMs();
    const next = applyTransition(issue, {
      event: input.event,
      to_state: target,
      transition_id: input.transition_id,
      at,
      watermark: this.deps.evidence.binding.watermark,
      ...(input.patch === undefined ? {} : { patch: input.patch })
    });
    const command = {
      transition_id: input.transition_id,
      issue_id: issue.issue_id,
      expected_version: issue.issue_version,
      from_state: issue.state,
      to_state: target,
      event: input.event,
      evidence_refs: sortedUniqueRefs(input.patch?.source_refs ?? issue.source_refs),
      issue: next,
      ...(input.judgment === undefined ? {} : { judgment: input.judgment })
    };
    const result = this.deps.issues.appendTransition(command);
    return okResult(result);
  }

  discover(input: IssueDiscoveryInput): IssueDiscoveryResult {
    if (!isEvidenceIndexSnapshot(this.deps.evidence)) {
      return { status: "rejected", issues: [], proposed_count: 0, errors: ["E_INDEX_NOT_LOADED"] };
    }
    const discovered = discoverIssues(input, {
      snapshot: this.deps.evidence,
      clock: this.clock,
      allocateIssueId: () => newId("issue")
    });
    if (discovered.status === "rejected") {
      return discovered;
    }
    // Targeting feedback is an observation on an existing issue, not a new
    // candidate (DD-QP-05: `open -> needs_evidence` on targeting feedback).
    const feedbackErrors = this.applyTargetingFeedback(input);
    if (discovered.status === "no_op") {
      return feedbackErrors.length === 0
        ? discovered
        : { ...discovered, errors: [...discovered.errors, ...feedbackErrors] };
    }
    const issues: Issue[] = [];
    const errors = [...discovered.errors];
    for (const candidate of discovered.issues) {
      const transition_id = transitionIdFor("propose", candidate.issue_id);
      const proposed: Issue = {
        ...candidate,
        last_transition_id: transition_id
      };
      try {
        const result = this.deps.issues.appendTransition({
          transition_id,
          issue_id: proposed.issue_id,
          expected_version: 0,
          from_state: "none",
          to_state: "proposed",
          event: "propose",
          evidence_refs: sortedUniqueRefs(proposed.source_refs),
          issue: proposed
        });
        issues.push(result.issue);
      } catch (error) {
        if (error instanceof QpDomainError) {
          errors.push(failureCode(codeOf(error)));
        } else {
          throw error;
        }
      }
    }
    if (issues.length === 0) {
      return { status: "no_op", issues: [], proposed_count: 0, no_op_reason: "no_issue", errors };
    }
    return {
      status: discovered.status === "truncated" ? "truncated" : "ok",
      issues,
      proposed_count: issues.length,
      errors
    };
  }

  /**
   * Applies targeting feedback to existing issues before discovery output is
   * computed. Feedback never creates requirements, changes the goal/epoch or
   * confirms an issue; a `needs_evidence` target only forces the open issue
   * down the `require_evidence` edge with its quote as the gap source.
   */
  private applyTargetingFeedback(input: IssueDiscoveryInput): FailureCode[] {
    const errors: FailureCode[] = [];
    const snapshot = this.deps.evidence;
    const binding = snapshot.binding;
    const feedback = sortUtf8(
      snapshot
        .listFeedback({ binding, watermark: input.watermark })
        .filter((entry) => entry.target_issue_id !== null && entry.status === "needs_evidence"),
      (entry) =>
        `${entry.target_issue_id ?? ""}\u0000${String(entry.recorded_at_watermark).padStart(16, "0")}\u0000${entry.feedback_id}`
    );
    if (feedback.length === 0) {
      return errors;
    }
    const active = this.deps.issues.listActive({ binding });
    for (const entry of feedback) {
      const targetId = entry.target_issue_id;
      if (targetId === null) {
        continue;
      }
      if (entry.goal_version !== binding.goal_version || entry.input_epoch !== binding.input_epoch) {
        continue;
      }
      if (entry.recorded_at_watermark > input.watermark) {
        continue;
      }
      const summary = active.find((candidate) => candidate.issue_id === targetId);
      if (summary === undefined) {
        continue;
      }
      if (summary.state !== "open" && summary.state !== "judged") {
        continue;
      }
      const issue = this.deps.issues.getIssue(targetId);
      if (issue === null) {
        continue;
      }
      const result = this.requireEvidence({
        transition_id: `feedback:${entry.feedback_id}`.slice(0, 128),
        issue_id: issue.issue_id,
        expected_version: issue.issue_version,
        gaps: [
          {
            code: "capture_gap",
            requirement_ids: sortedUnique(issue.requirement_ids),
            source_refs: sortedUniqueRefs(entry.source_refs),
            affects_question_keys: []
          }
        ],
        reason: "feedback_correction"
      });
      for (const code of result.errors) {
        errors.push(code);
      }
    }
    return errors;
  }

  confirm(command: ConfirmIssueCommand): IssueTransitionResult {
    try {
      assertConfirmationShape(command.confirmation);
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      if (issue.state !== "proposed") {
        throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "confirm", { from_state: issue.state }));
      }
      const confirmation = command.confirmation;
      if (!confirmationKindAllowed(issue.type, confirmation.kind)) {
        throw new QpDomainError(
          qpFailure("E_CONFIRMATION_KIND_NOT_ALLOWED", "confirm", { issue_type: issue.type, kind: confirmation.kind })
        );
      }
      this.validateConfirmationSources(issue, confirmation);
      const projected = confirmationProjection(confirmation, this.deps.evidence.binding.watermark);
      const templateId = this.templateFor(issue.type);
      const questionText =
        templateId === null
          ? null
          : renderTemplate(templateId.question_text_template, {
              requirement_ids: issue.requirement_ids,
              artifact_paths: issue.artifact_paths,
              experience_id: issue.experience_ref?.experience_id ?? null,
              issue_type: issue.type
            });
      const nextPatch: IssueTransitionPatch = { confirmation: projected };
      if (questionText !== null) {
        const at = this.clock.utcNowMs();
        return this.transition({ ...issue, question_text: questionText, updated_at: at }, {
          transition_id: command.transition_id,
          event: "confirm",
          patch: nextPatch
        });
      }
      return this.transition(issue, {
        transition_id: command.transition_id,
        event: "confirm",
        patch: nextPatch
      });
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  /**
   * Source refs frozen into the loaded index (plus the issue's own refs).
   * `confirm` only accepts refs the index already recorded; a different
   * retrievable blob is a source change, not fresh evidence.
   */
  private frozenSourceRefs(binding: VersionBinding, issue: Issue): ReadonlySet<SourceRef> {
    const snapshot = this.deps.evidence;
    const refs = new Set<SourceRef>(issue.source_refs);
    const add = (values: readonly SourceRef[]): void => {
      for (const ref of values) {
        refs.add(ref);
      }
    };
    for (const requirement of snapshot.listRequirements({ binding, watermark: binding.watermark })) {
      refs.add(requirement.statement_ref);
      add(requirement.source_refs);
    }
    for (const fact of snapshot.listFacts({ binding, watermark: binding.watermark })) {
      add(fact.source_refs);
    }
    const coverage = snapshot.getCoverageSnapshot({ binding, watermark: binding.watermark });
    add(coverage.source_refs);
    for (const entry of coverage.missing) {
      add(entry.source_refs);
    }
    return refs;
  }

  private validateConfirmationSources(issue: Issue, confirmation: ConfirmationEvidence): void {
    const snapshot = this.deps.evidence;
    const binding = snapshot.binding;
    const refs = sortedUniqueRefs(confirmation.source_refs);
    if (refs.length === 0) {
      throw new QpDomainError(qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "confirm", { reason: "no_refs" }));
    }
    // Stage 7 order: requirement existence, then re-read, then hash identity.
    if (confirmation.kind === "coverage_gap") {
      const requirements = snapshot.listRequirements({ binding, watermark: binding.watermark });
      if (!requirements.some((requirement) => requirement.requirement_id === confirmation.requirement_id)) {
        throw new QpDomainError(qpFailure("E_REQUIREMENT_UNKNOWN", "confirm"));
      }
    }
    for (const ref of refs) {
      recheckConfirmationSource(snapshot, ref);
    }
    const frozen = this.frozenSourceRefs(binding, issue);
    for (const ref of refs) {
      if (!frozen.has(ref)) {
        throw new QpDomainError(qpFailure("E_SOURCE_CHANGED", "confirm"));
      }
    }
    switch (confirmation.kind) {
      case "human_input": {
        if (confirmation.origin !== "human") {
          throw new QpDomainError(
            qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "confirm", { reason: "origin_not_human" })
          );
        }
        break;
      }
      case "verified_fact": {
        const facts = snapshot.listFacts({ binding, watermark: binding.watermark });
        for (const factId of confirmation.fact_ids) {
          const fact = facts.find((entry) => entry.fact_id === factId);
          if (fact === undefined || (fact.status !== "verified" && fact.status !== "contradicted")) {
            throw new QpDomainError(
              qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "confirm", { reason: "fact_not_verified" })
            );
          }
          if (!issue.artifact_versions.some((entry) => entry.version === confirmation.artifact_version)) {
            throw new QpDomainError(
              qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "confirm", { reason: "artifact_version" })
            );
          }
        }
        break;
      }
      case "coverage_gap": {
        const coverage = snapshot.getCoverageSnapshot({ binding, watermark: binding.watermark });
        const covered = coverage.missing.some(
          (entry) =>
            entry.requirement_id === confirmation.requirement_id &&
            confirmation.missing_codes.includes(entry.code)
        );
        if (!covered) {
          throw new QpDomainError(
            qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "confirm", { reason: "coverage_gap" })
          );
        }
        break;
      }
      case "stable_signal": {
        const signals = snapshot.listProgressSignals({
          binding,
          from_watermark: snapshot.progress_from_watermark,
          to_watermark: binding.watermark
        });
        const signal = signals.find((entry) => entry.signal_id === confirmation.signal_id);
        const comparable = signals.filter((entry) => entry.status === "comparable");
        if (signal === undefined || comparable.length < confirmation.comparable_checkpoints) {
          throw new QpDomainError(
            qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "confirm", { reason: "stable_signal" })
          );
        }
        for (const exclusion of confirmation.exclusions) {
          if (!excerptOk(snapshot, exclusion.source_ref)) {
            throw new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "confirm"));
          }
        }
        break;
      }
      case "review_snapshot": {
        if (snapshot.review_snapshot_id === null || snapshot.review_snapshot_id !== confirmation.snapshot_id) {
          throw new QpDomainError(
            qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "confirm", { reason: "review_snapshot" })
          );
        }
        break;
      }
    }
  }

  private templateFor(issueType: Issue["type"]): QuestionTemplate | null {
    const id =
      issueType === "constraint_violation" || issueType === "wrong_target"
        ? "qt.behavior_relation"
        : issueType === "missing_requirement"
          ? "qt.acceptance_relation"
          : issueType === "goal_change"
            ? "qt.intent_relation"
            : issueType === "stall_or_regression_candidate"
              ? "qt.step_effect"
              : issueType === "experience_applicability"
                ? "qt.experience_match"
                : null;
    if (id === null) {
      return null;
    }
    return this.templates.get(id) ?? null;
  }

  attachEvidence(command: AttachEvidenceCommand): IssueTransitionResult {
    try {
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      if (issue.state !== "needs_evidence") {
        throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "attach_evidence", { from_state: issue.state }));
      }
      const allRefs = sortedUniqueRefs(command.source_refs);
      if (allRefs.length > MAX_SOURCE_REFS) {
        throw new QpDomainError(qpFailure("E_SCHEMA", "attach_evidence", { field: "source_refs" }));
      }
      const refs = allRefs;
      for (const ref of refs) {
        if (!excerptOk(this.deps.evidence, ref)) {
          throw new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "attach_evidence"));
        }
      }
      const resolved = command.gaps.some((gap) =>
        issue.evidence_gap.some((existing) => existing.code === gap.code)
      );
      if (!resolved) {
        throw new QpDomainError(
          qpFailure("E_CONFIRMATION_EVIDENCE_INSUFFICIENT", "attach_evidence", { reason: "gap_not_resolved" })
        );
      }
      return this.transition(issue, {
        transition_id: command.transition_id,
        event: "supply_evidence",
        patch: {
          evidence_gap: issue.evidence_gap.filter(
            (existing) => !command.gaps.some((gap) => gap.code === existing.code)
          ),
          source_event_ids: sortedUnique([...issue.source_event_ids, ...command.source_event_ids]),
          source_refs: sortedUniqueRefs([...issue.source_refs, ...refs])
        }
      });
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  requireEvidence(command: RequireEvidenceCommand): IssueTransitionResult {
    try {
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      if (issue.state === "needs_evidence") {
        return {
          status: "no_op",
          transition_id: command.transition_id,
          issue: { ...issue, evidence_gap: gapsUnion(issue.evidence_gap, command.gaps) },
          deduplicated: true,
          errors: []
        };
      }
      if (issue.state !== "open" && issue.state !== "judged") {
        throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "require_evidence", { from_state: issue.state }));
      }
      return this.transition(issue, {
        transition_id: command.transition_id,
        event: "require_evidence",
        patch: { evidence_gap: gapsUnion(issue.evidence_gap, command.gaps) }
      });
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  abstain(command: AbstainIssueCommand): IssueTransitionResult {
    try {
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      return this.transition(issue, {
        transition_id: command.transition_id,
        event: "abstain",
        patch: { evidence_gap: gapsUnion(issue.evidence_gap, command.gaps) }
      });
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  rejectIssue(command: RejectIssueCommand): IssueTransitionResult {
    try {
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      const event: IssueTransitionEvent = issue.state === "proposed" ? "reject" : "reject_issue";
      return this.transition(issue, {
        transition_id: command.transition_id,
        event,
        patch: { rejection: command.rejection }
      });
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  invalidateGoal(command: InvalidateGoalCommand): IssueTransitionResult {
    try {
      const issue = this.requireIssue(command.issue_id);
      const snapshotBinding = this.deps.evidence.binding;
      if (!bindingMatchesSnapshot(issue, snapshotBinding)) {
        throw new QpDomainError(qpFailure("E_VERSION_BINDING", "issue_command"));
      }
      if (issue.issue_version !== command.expected_version) {
        throw new QpDomainError(qpFailure("E_ISSUE_VERSION_CONFLICT", "issue_command"));
      }
      if (issue.binding.goal_version === command.current_binding.goal_version) {
        return { status: "no_op", transition_id: command.transition_id, issue, deduplicated: true, errors: [] };
      }
      if (issue.state === "closed" || issue.state === "stale_goal" || issue.state === "rejected") {
        return { status: "no_op", transition_id: command.transition_id, issue, deduplicated: true, errors: [] };
      }
      const result = this.transition(issue, { transition_id: command.transition_id, event: "invalidate_goal" });
      this.staleGoalPlans(issue);
      return result;
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  async recordJudgment(command: RecordIssueJudgmentCommand): Promise<IssueTransitionResult> {
    try {
      assertJudgmentCommandShape(command);
      // DD-QP-27: a repeated `transition_id` with the same payload returns
      // the first result. The judgment id is minted per submission, so the
      // replay is resolved before a new id is created.
      const replay = this.replayTransition(command.transition_id, command.issue_id);
      if (replay !== null) {
        return replay;
      }
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      if (issue.state !== "open" && issue.state !== "needs_evidence" && issue.state !== "judged") {
        throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "judgment", { from_state: issue.state }));
      }
      const outcome =
        command.source.kind === "answer_aggregate"
          ? await this.judgmentFromAggregate(issue, command.source)
          : this.judgmentFromFacts(issue, command.source.fact_keys);
      const judgmentId = newId("judg");
      const draft: IssueJudgmentDraft = {
        schema_version: "rsi.issue_judgment/1",
        judgment_id: judgmentId,
        issue_key: issue.issue_key,
        issue_id: issue.issue_id,
        issue_version: issue.issue_version + 1,
        decision: outcome.decision,
        basis: outcome.basis,
        outcome: outcome.outcome,
        requirement_results: outcome.requirement_results,
        accepted: true
      };
      const nextIssue: Issue = { ...issue, judgment_ref: judgmentId };
      return this.transition(nextIssue, {
        transition_id: command.transition_id,
        event: "judge",
        patch: { judgment_ref: judgmentId },
        judgment: draft
      });
    } catch (error) {
      if (error instanceof QpDomainError) {
        if (codeOf(error) === "E_SCHEMA") {
          // Command-shape failures carry the coded detail object expected by
          // the JSON boundary; other rejections keep the plain code list.
          return {
            status: "rejected",
            transition_id: command.transition_id,
            deduplicated: false,
            errors: [{ code: "E_SCHEMA" } as unknown as FailureCode]
          };
        }
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  private async judgmentFromAggregate(
    issue: Issue,
    source: Extract<RecordIssueJudgmentCommand["source"], { kind: "answer_aggregate" }>
  ): Promise<{
    decision: IssueJudgment["decision"];
    basis: "hard_fact" | "mixed";
    outcome: IssueJudgment["outcome"];
    requirement_results: IssueJudgment["requirement_results"];
  }> {
    const planState = this.deps.plans.getPlanState(source.plan_id);
    if (planState === null || planState.state !== "active") {
      throw new QpDomainError(qpFailure("E_PLAN_STALE", "judgment"));
    }
    const read = await this.deps.aggregates.readAccepted({
      aggregate_id: source.aggregate_id,
      expected_aggregate_hash: source.expected_aggregate_hash,
      issue_id: issue.issue_id,
      plan_id: source.plan_id,
      plan_hash: source.plan_hash,
      binding: issue.binding
    });
    const unwrapped: QpAggregateReadResult = unwrapAcceptedAggregate(read);
    if (unwrapped.status === "rejected") {
      throw new QpDomainError(
        qpFailure(unwrapped.code, "aggregate_read", {
          upstream_code: unwrapped.details.upstream_code ?? unwrapped.code
        })
      );
    }
    const aggregate = unwrapped.aggregate;
    if (aggregate.plan_hash !== source.plan_hash) {
      throw new QpDomainError(qpFailure("E_AGGREGATE_HASH_MISMATCH", "aggregate_read"));
    }
    if (aggregate.binding.watermark < issue.opened_at_watermark) {
      throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
    }
    const basis = aggregate.final_basis;
    if (basis === null || basis === "semantic_shadow") {
      throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
    }
    if (aggregate.final_state !== "consistent" && aggregate.final_state !== "inconsistent") {
      throw new QpDomainError(qpFailure("E_AGGREGATE_NOT_ACCEPTED", "aggregate_read"));
    }
    if (aggregate.final_state === "inconsistent" && basis === "mixed") {
      throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
    }
    if (aggregate.propositions.length === 0) {
      throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
    }
    const requirementResults = this.aggregateRequirementResults(aggregate, basis);
    return {
      decision: {
        kind: "answer_aggregate",
        aggregate_id: aggregate.aggregate_id,
        aggregate_key: aggregate.aggregate_key,
        aggregate_hash: aggregate.aggregate_hash,
        plan_hash: aggregate.plan_hash
      },
      basis,
      outcome: aggregate.final_state,
      requirement_results: requirementResults
    };
  }

  private aggregateRequirementResults(
    aggregate: { aggregate_key: string; propositions: ReadonlyArray<{ proposition_id: string; requirement_ids: string[]; result: "supported_hard" | "contradicted_hard" | "supported_semantic" | "contradicted_semantic" | "conflict" | "unknown" | "missing" }> },
    basis: "hard_fact" | "mixed"
  ): IssueJudgment["requirement_results"] {
    const results: IssueJudgment["requirement_results"] = [];
    for (const proposition of aggregate.propositions) {
      for (const requirementId of sortedUnique(proposition.requirement_ids)) {
        results.push({
          requirement_id: requirementId,
          proposition_id: proposition.proposition_id,
          result: mapResult(proposition.result, basis),
          aggregate_key: aggregate.aggregate_key
        });
      }
    }
    return sortRequirementResults(results);
  }

  private judgmentFromFacts(
    issue: Issue,
    factKeys: readonly string[]
  ): {
    decision: IssueJudgment["decision"];
    basis: "hard_fact";
    outcome: IssueJudgment["outcome"];
    requirement_results: IssueJudgment["requirement_results"];
  } {
    const keys = sortedUnique(factKeys);
    if (keys.length === 0) {
      throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
    }
    const facts = this.deps.evidence.listHardFacts({
      binding: issue.binding,
      watermark: this.deps.evidence.binding.watermark
    });
    const selected = keys.map((key) => facts.find((fact) => fact.fact_key === key));
    if (selected.some((fact) => fact === undefined)) {
      throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
    }
    let supports = 0;
    let violates = 0;
    for (const fact of selected) {
      if (fact === undefined) {
        continue;
      }
      if (
        !fact.verified ||
        fact.binding.task_id !== issue.binding.task_id ||
        fact.binding.branch_id !== issue.binding.branch_id ||
        fact.binding.input_epoch !== issue.binding.input_epoch ||
        fact.binding.goal_version !== issue.binding.goal_version ||
        fact.binding.config_version !== issue.binding.config_version
      ) {
        throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
      }
      if (!issue.artifact_versions.some((entry) => entry.version === fact.artifact_version)) {
        throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
      }
      if (fact.effect === "supports") {
        supports += 1;
      } else if (fact.effect === "violates") {
        violates += 1;
      } else {
        throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
      }
    }
    if (supports > 0 && violates > 0) {
      throw new QpDomainError(qpFailure("E_JUDGMENT_BASIS_INSUFFICIENT", "judgment"));
    }
    const satisfiedType =
      issue.type === "missing_requirement" || issue.type === "missing_verification";
    const outcome: IssueJudgment["outcome"] =
      violates > 0
        ? satisfiedType
          ? "not_satisfied"
          : "inconsistent"
        : satisfiedType
          ? "satisfied"
          : "consistent";
    // Local facts carry no proposition identity; the design forbids inventing one.
    const requirementResults: IssueJudgment["requirement_results"] = [];
    return {
      decision: { kind: "local_facts", fact_keys: keys },
      basis: "hard_fact",
      outcome,
      requirement_results: requirementResults
    };
  }

  async close(command: CloseIssueCommand): Promise<IssueTransitionResult> {
    try {
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      if (command.mode === "judgment") {
        return await this.closeByJudgment(issue, command);
      }
      return await this.closeByHandoff(issue, command);
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  private async closeByJudgment(
    issue: Issue,
    command: Extract<CloseIssueCommand, { mode: "judgment" }>
  ): Promise<IssueTransitionResult> {
    if (issue.state !== "judged") {
      throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "close", { from_state: issue.state }));
    }
    if (issue.type === "experience_applicability") {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    assertCloseEvidenceDraft(command.close_evidence);
    const draft = command.close_evidence;
    if (!closeKindAllowed(issue.type, draft.kind)) {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    if (issue.judgment_ref === undefined) {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    const judgment = this.deps.issues.getIssueJudgment(issue.judgment_ref);
    if (
      judgment === null ||
      judgment.accepted !== true ||
      judgment.issue_id !== issue.issue_id ||
      judgment.issue_key !== issue.issue_key ||
      judgment.issue_version !== issue.issue_version
    ) {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    // DD-QP-05a stage 3: the goal gate runs before every path-specific
    // check, so a stale goal never reaches the source ports.
    if (draft.goal_version !== issue.binding.goal_version) {
      throw new QpDomainError(qpFailure("E_GOAL_STALE", "close"));
    }
    const allRefs = sortedUniqueRefs(draft.source_refs);
    if (allRefs.length === 0 || allRefs.length > MAX_SOURCE_REFS) {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    // DD-QP-06 / DD-QP-05a stage 7: the draft refs must equal the
    // authoritative refs of the persisted evidence record item by item. A
    // caller that swaps a ref for a fresh content address is refused before
    // any source port is called, so the swapped address is never adopted.
    const authoritativeRefs = sortedUniqueRefs(issue.source_refs);
    if (!sameRefs(allRefs, authoritativeRefs)) {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    const refs = authoritativeRefs;
    // Stage 7 runs the two source phases; stage 8 (the evidence semantics)
    // only runs once the source is retrievable and unchanged.
    const source_hashes = await this.freezeSourceHashes(refs);
    this.validateCloseSemantics(issue, draft);
    const evidence = await this.freezeEvidence({
      kind: draft.kind,
      evidence_id: draft.evidence_id,
      refs,
      source_hashes,
      goal_version: issue.binding.goal_version,
      requirement_ids: draft.requirement_ids,
      artifact_version: draft.artifact_version,
      verifier_ref: draft.verifier_ref,
      review_handoff: null
    });
    this.usedEvidenceIds.add(draft.evidence_id);
    return this.transition(issue, {
      transition_id: command.transition_id,
      event: "close",
      patch: { close_evidence: evidence }
    });
  }

  /**
   * Stage 8 of DD-QP-05a: the evidence semantics (independence, artifact
   * version, requirement coverage, watermark). The goal gate and the source
   * two-phase run before this method, so a source failure wins over a stale
   * artifact version.
   */
  private validateCloseSemantics(issue: Issue, draft: CloseEvidenceDraft): void {
    if (
      draft.kind === "verified_behavior" ||
      draft.kind === "verified_artifact"
    ) {
      if (draft.artifact_version === null || draft.verifier_ref === null) {
        throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
      }
      if (!issue.artifact_versions.some((entry) => entry.version === draft.artifact_version)) {
        throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
      }
    }
    if (issue.requirement_ids.some((id) => !draft.requirement_ids.includes(id))) {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    if (issue.binding.watermark <= issue.opened_at_watermark) {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
  }

  /**
   * Stage 7 of DD-QP-05a: freeze the expected per-ref range hash from the
   * immutable archive, then re-check the same refs independently.
   *
   * The two calls are independent: the expectation is not taken from the
   * observed result, and the observed result is not the expectation object.
   */
  private async freezeSourceHashes(refs: readonly SourceRef[]): Promise<SourceHashEntry[]> {
    const binding = this.deps.evidence.binding;
    const expected = resolveExpectedEntries(
      await this.deps.sourceExpectations.resolveExpected({ binding, refs })
    );
    await checkObserved(this.deps.sources, binding, refs, expected);
    return [...expected]
      .sort((left, right) => compareUtf8(left.source_ref, right.source_ref))
      .map((entry) => ({
        source_ref: entry.source_ref,
        content_hash: entry.content_hash
      }));
  }

  private async freezeEvidence(input: {
    kind: CloseEvidence["kind"];
    evidence_id: string;
    refs: readonly SourceRef[];
    source_hashes: readonly SourceHashEntry[];
    goal_version: string;
    requirement_ids: readonly string[];
    artifact_version: string | null;
    verifier_ref: string | null;
    review_handoff: CloseEvidence["review_handoff"];
  }): Promise<CloseEvidence> {
    const binding = this.deps.evidence.binding;
    const source_hashes = [...input.source_hashes];
    const withoutHash = {
      kind: input.kind,
      evidence_id: input.evidence_id,
      source_refs: [...input.refs],
      source_hashes,
      goal_version: input.goal_version,
      recorded_at_watermark: binding.watermark,
      requirement_ids: sortedUnique(input.requirement_ids),
      artifact_version: input.artifact_version,
      verifier_ref: input.verifier_ref,
      review_handoff: input.review_handoff
    };
    const evidence_hash = closeEvidenceHash({
      kind: withoutHash.kind,
      evidence_id: withoutHash.evidence_id,
      source_refs: withoutHash.source_refs,
      source_hashes: withoutHash.source_hashes,
      goal_version: withoutHash.goal_version,
      requirement_ids: withoutHash.requirement_ids,
      artifact_version: withoutHash.artifact_version,
      verifier_ref: withoutHash.verifier_ref,
      review_handoff: withoutHash.review_handoff
    });
    return { ...withoutHash, evidence_hash };
  }

  private async closeByHandoff(
    issue: Issue,
    command: Extract<CloseIssueCommand, { mode: "review_handoff" }>
  ): Promise<IssueTransitionResult> {
    if (issue.type !== "experience_applicability") {
      throw new QpDomainError(qpFailure("E_CLOSE_EVIDENCE_INSUFFICIENT", "close"));
    }
    if (issue.state !== "open" && issue.state !== "needs_evidence" && issue.state !== "judged") {
      throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "close", { from_state: issue.state }));
    }
    const read = await this.deps.handoffs.getHandoffCloseView({
      handoff_id: command.handoff_id,
      issue_id: issue.issue_id
    });
    const unwrapped: QpReviewHandoffReadResult = unwrapReviewHandoff(read);
    if (unwrapped.status === "rejected") {
      throw new QpDomainError(
        qpFailure(unwrapped.code, "review_handoff_read", {
          upstream_code: unwrapped.details.upstream_code ?? unwrapped.code
        })
      );
    }
    const view = unwrapped.view;
    if (view.job_state === "pending") {
      throw new QpDomainError(qpFailure("E_HANDOFF_NOT_READY", "review_handoff_read"));
    }
    if (view.binding === null) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    if (
      view.binding.task_id !== issue.binding.task_id ||
      view.binding.branch_id !== issue.binding.branch_id ||
      view.binding.input_epoch !== issue.binding.input_epoch ||
      view.binding.config_version !== issue.binding.config_version
    ) {
      throw new QpDomainError(qpFailure("E_VERSION_BINDING", "review_handoff_read"));
    }
    if (view.binding.goal_version !== issue.binding.goal_version) {
      throw new QpDomainError(qpFailure("E_GOAL_STALE", "review_handoff_read"));
    }
    if (view.issue_id !== issue.issue_id) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PROPOSAL_MISMATCH", "review_handoff_read"));
    }
    const jobResult = view.job_result;
    if (jobResult === null) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    if (jobResult === "no_candidate") {
      throw new QpDomainError(qpFailure("E_HANDOFF_PROPOSAL_MISMATCH", "review_handoff_read"));
    }
    if (jobResult === "all_rejected" || jobResult === "all_stale") {
      // A terminal view must not carry a proposal: the job decided that no
      // proposal was adopted.
      if (view.proposal_id !== null || view.proposal_hash !== null) {
        throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
      }

      this.usedEvidenceIds.add(command.handoff_id);
      return this.transition(issue, {
        transition_id: command.transition_id,
        event: "review_handoff_reject",
        patch: {
          rejection: { kind: "review_handoff_terminal", source_refs: sortedUniqueRefs(view.source_refs) }
        }
      });
    }
    this.validateProposedHandoff(view, issue);
    const closePayload = view.close_payload;
    if (closePayload === null || view.close_payload_hash === null) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    if (closePayloadHash(closePayload) !== view.close_payload_hash) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    if (view.source_refs.length === 0) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    // The top-level fields must repeat the close payload exactly.
    if (
      closePayload.plan_id !== view.plan_id ||
      closePayload.plan_hash !== view.plan_hash ||
      closePayload.question_key !== view.question_key ||
      closePayload.proposal_id !== view.proposal_id ||
      closePayload.proposal_hash !== view.proposal_hash ||
      closePayload.decision !== view.decision ||
      closePayload.snapshot_id !== view.snapshot_id ||
      closePayload.snapshot_hash !== view.snapshot_hash
    ) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    if (
      view.handoff_id !== closePayload.handoff_id ||
      view.proposal_id !== closePayload.proposal_id ||
      view.proposal_hash !== closePayload.proposal_hash ||
      view.plan_id !== closePayload.plan_id ||
      view.plan_hash !== closePayload.plan_hash ||
      view.question_key !== closePayload.question_key ||
      view.decision !== closePayload.decision ||
      view.snapshot_id !== closePayload.snapshot_id ||
      view.snapshot_hash !== closePayload.snapshot_hash
    ) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    const plan = this.deps.plans.getPlan(view.plan_id ?? "");
    if (plan === null || plan.plan_hash !== view.plan_hash) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PROPOSAL_MISMATCH", "review_handoff_read"));
    }
    const planState = this.deps.plans.getPlanState(plan.plan_id);
    if (planState === null || planState.state !== "active") {
      throw new QpDomainError(qpFailure("E_HANDOFF_PROPOSAL_MISMATCH", "review_handoff_read"));
    }
    if (view.question_key === null || !plan.questions.some((question) => question.question_key === view.question_key)) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PROPOSAL_MISMATCH", "review_handoff_read"));
    }
    const refs = sortedUniqueRefs(view.source_refs).slice(0, MAX_SOURCE_REFS);
    if (refs.length === 0) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    const reviewHandoff = {
      handoff_id: view.handoff_id,
      handoff_hash: closePayload.handoff_hash,
      proposal_id: closePayload.proposal_id,
      proposal_hash: closePayload.proposal_hash,
      decision: closePayload.decision,
      review_match_outcome: closePayload.review_match_outcome,
      snapshot_id: closePayload.snapshot_id,
      snapshot_hash: closePayload.snapshot_hash,
      plan_id: closePayload.plan_id,
      plan_hash: closePayload.plan_hash,
      question_key: closePayload.question_key,
      close_payload_hash: view.close_payload_hash
    };
    const source_hashes = await this.freezeSourceHashes(refs);
    const evidence = await this.freezeEvidence({
      kind: "review_handoff",
      evidence_id: view.handoff_id,
      refs,
      source_hashes,
      goal_version: issue.binding.goal_version,
      requirement_ids: [],
      artifact_version: null,
      verifier_ref: null,
      review_handoff: reviewHandoff
    });
    const closure: ReviewHandoffClosure = {
      handoff_id: view.handoff_id,
      handoff_hash: closePayload.handoff_hash,
      proposal_id: closePayload.proposal_id,
      proposal_hash: closePayload.proposal_hash,
      decision: closePayload.decision,
      review_match_outcome: closePayload.review_match_outcome,
      closure_disposition: closePayload.decision === "proceed" ? "handoff_proceed" : "handoff_unverified",
      snapshot_id: closePayload.snapshot_id,
      snapshot_hash: closePayload.snapshot_hash,
      plan_id: closePayload.plan_id,
      plan_hash: closePayload.plan_hash,
      question_key: closePayload.question_key
    };
    this.usedEvidenceIds.add(view.handoff_id);
    return this.transition(issue, {
      transition_id: command.transition_id,
      event: "review_handoff_close",
      patch: { close_evidence: evidence, review_handoff_closure: closure }
    });
  }

  private validateProposedHandoff(view: ReviewHandoffCloseView, issue: Issue): void {
    if (
      view.proposal_id === null ||
      view.proposal_hash === null ||
      view.plan_id === null ||
      view.plan_hash === null ||
      view.question_key === null ||
      view.decision === null ||
      view.snapshot_id === null ||
      view.snapshot_hash === null ||
      view.recorded_at_watermark === null ||
      view.close_payload === null ||
      view.close_payload_hash === null
    ) {
      throw new QpDomainError(qpFailure("E_HANDOFF_PAYLOAD_INVALID", "review_handoff_read"));
    }
    if (issue.experience_ref !== undefined) {
      if (
        view.snapshot_id !== issue.experience_ref.snapshot_id ||
        view.snapshot_hash !== issue.experience_ref.snapshot_hash ||
        view.proposal_id !== issue.experience_ref.proposal_id ||
        view.proposal_hash !== issue.experience_ref.proposal_hash
      ) {
        throw new QpDomainError(qpFailure("E_HANDOFF_PROPOSAL_MISMATCH", "review_handoff_read"));
      }
    }
  }

  async reopen(command: ReopenIssueCommand): Promise<IssueTransitionResult> {
    try {
      const issue = this.requireIssue(command.issue_id);
      this.guardScope(issue, command.expected_version);
      if (issue.state !== "closed" && issue.state !== "abstained") {
        throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "reopen", { from_state: issue.state }));
      }
      const draft = command.reopen_evidence;
      if (issue.state === "abstained" && draft.kind !== "new_evidence") {
        throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "reopen"));
      }
      if (issue.state === "closed" && draft.kind === "new_evidence") {
        throw new QpDomainError(qpFailure("E_ISSUE_TRANSITION_ILLEGAL", "reopen"));
      }
      this.validateReopenSemantics(issue, draft);
      const allRefs = sortedUniqueRefs(draft.source_refs);
      if (allRefs.length === 0 || allRefs.length > MAX_SOURCE_REFS) {
        throw new QpDomainError(qpFailure("E_REOPEN_EVIDENCE_INSUFFICIENT", "reopen"));
      }
      const refs = allRefs;
      const binding = this.deps.evidence.binding;
      const expected = resolveExpectedEntries(await this.deps.sourceExpectations.resolveExpected({ binding, refs }));
      await checkObserved(this.deps.sources, binding, refs, expected);
      const source_hashes = [...expected].sort((left, right) => compareUtf8(left.source_ref, right.source_ref)).map((entry) => ({
        source_ref: entry.source_ref,
        content_hash: entry.content_hash
      }));
      const withoutHash: Omit<ReopenEvidence, "evidence_hash"> = {
        kind: draft.kind,
        evidence_id: draft.evidence_id,
        source_refs: [...refs],
        source_hashes,
        recorded_at_watermark: binding.watermark
      };
      if (draft.artifact_version !== undefined) {
        withoutHash.artifact_version = draft.artifact_version;
      }
      if (draft.resolved_gap_codes !== undefined) {
        withoutHash.resolved_gap_codes = sortedUnique(draft.resolved_gap_codes);
      }
      this.usedEvidenceIds.add(draft.evidence_id);
      const event: IssueTransitionEvent = issue.state === "abstained" ? "reopen_evidence" : "reopen";
      return this.transition(issue, {
        transition_id: command.transition_id,
        event,
        patch: { reopen_count: issue.reopen_count + 1 }
      });
    } catch (error) {
      if (error instanceof QpDomainError) {
        return rejectedResult(command.transition_id, codeOf(error));
      }
      throw error;
    }
  }

  private validateReopenSemantics(
    issue: Issue,
    draft: ReopenIssueCommand["reopen_evidence"]
  ): void {
    if (this.usedEvidenceIds.has(draft.evidence_id) || issue.close_evidence?.evidence_id === draft.evidence_id) {
      throw new QpDomainError(qpFailure("E_REOPEN_EVIDENCE_REUSED", "reopen"));
    }
    if (issue.state === "closed") {
      const closeWatermark = issue.close_evidence?.recorded_at_watermark ?? 0;
      if (this.deps.evidence.binding.watermark <= closeWatermark) {
        throw new QpDomainError(qpFailure("E_REOPEN_EVIDENCE_INSUFFICIENT", "reopen"));
      }
      if (draft.kind === "artifact_changed") {
        const closedVersion = issue.close_evidence?.artifact_version ?? null;
        if (draft.artifact_version === undefined || draft.artifact_version === closedVersion) {
          throw new QpDomainError(qpFailure("E_REOPEN_EVIDENCE_INSUFFICIENT", "reopen"));
        }
      }
      if (draft.kind === "contradicting_verification") {
        if (
          draft.artifact_version === undefined ||
          !issue.artifact_versions.some((entry) => entry.version === draft.artifact_version)
        ) {
          throw new QpDomainError(qpFailure("E_REOPEN_EVIDENCE_INSUFFICIENT", "reopen"));
        }
      }
    } else {
      const gaps = issue.evidence_gap.map((gap) => gap.code);
      if (
        draft.resolved_gap_codes === undefined ||
        !draft.resolved_gap_codes.some((code) => gaps.includes(code))
      ) {
        throw new QpDomainError(qpFailure("E_REOPEN_EVIDENCE_INSUFFICIENT", "reopen"));
      }
    }
  }

  plan(input: PlanningInput): PlanningResult {
    if (input.whole_task_verdict_requested === true) {
      return { status: "rejected", reason: "E_WHOLE_TASK_SCOPE_NOT_ALLOWED", issue_id: input.issue.issue_id, missing: [] };
    }
    const issue = input.issue;
    const snapshotBinding = this.deps.evidence.binding;
    const scopeMismatch =
      input.binding.task_id !== snapshotBinding.task_id ||
      input.binding.branch_id !== snapshotBinding.branch_id ||
      input.binding.input_epoch !== snapshotBinding.input_epoch ||
      input.binding.config_version !== snapshotBinding.config_version ||
      input.binding.watermark !== snapshotBinding.watermark ||
      issue.binding.task_id !== snapshotBinding.task_id ||
      issue.binding.branch_id !== snapshotBinding.branch_id ||
      issue.binding.input_epoch !== snapshotBinding.input_epoch ||
      issue.binding.config_version !== snapshotBinding.config_version ||
      issue.binding.watermark > snapshotBinding.watermark;
    if (scopeMismatch) {
      return { status: "rejected", reason: "E_INDEX_SCOPE_MISMATCH", issue_id: issue.issue_id, missing: [] };
    }
    if (
      input.binding.goal_version !== snapshotBinding.goal_version ||
      issue.binding.goal_version !== snapshotBinding.goal_version
    ) {
      return { status: "rejected", reason: "E_GOAL_STALE", issue_id: issue.issue_id, missing: [] };
    }
    if (issue.state !== "open") {
      return { status: "no_op", reason: "not_planable_state", issue_id: issue.issue_id };
    }
    // Issue types whose mapping entry is explicitly empty plan no question at
    // all (DD-QP-12); the gap is a planning outcome, not a persisted gap.
    if (issue.type === "missing_verification" || issue.type === "insufficient_evidence") {
      return {
        status: "no_op",
        reason: "no_template",
        issue_id: issue.issue_id,
        gap: {
          code: "no_template_for_issue_type",
          requirement_ids: issue.requirement_ids,
          source_refs: [],
          affects_question_keys: []
        }
      };
    }
    try {
      const template = requireTemplateFromRegistry({
        registry: input.registry,
        issue_type: issue.type
      });
      const built = buildQuestionPlan({
        issue,
        binding: snapshotBinding,
        registry: input.registry,
        template,
        snapshot: this.deps.evidence,
        state_profile: issue.type === "experience_applicability" ? "experience_review" : "progress_issue",
        planned_at: this.clock.utcNowMs()
      });
      const result = this.deps.plans.putPlan({
        plan: built,
        initial_state: initialPlanStateDraft(built),
        planning_idempotency_key: buildPlanIdempotencyKey(built)
      });
      this.planByIssue.set(issue.issue_id, result.plan.plan_id);
      if (!result.deduplicated) {
        this.supersedePreviousPlans(issue, result.plan.plan_id);
      }
      rememberIssuePlan(this.deps.plans, issue.issue_key, result.plan.plan_id);
      return {
        status: "planned",
        plan: result.plan,
        plan_state: result.plan_state,
        deduplicated: result.deduplicated
      };
    } catch (error) {
      if (error instanceof QpDomainError) {
        const code = failureCode(codeOf(error));
        const missing: EvidenceGap[] =
          error instanceof QpPlanBuildError
            ? error.gaps
            : code === "E_REQUIRED_SOURCE_MISSING"
              ? [
                  {
                    code: "template_role_unresolved",
                    requirement_ids: issue.requirement_ids,
                    source_refs: [],
                    affects_question_keys: []
                  }
                ]
              : [];
        return { status: "rejected", reason: code, issue_id: issue.issue_id, missing };
      }
      throw error;
    }
  }

  /** Marks every earlier active plan for the same issue `superseded`. */
  private supersedePreviousPlans(issue: Issue, current_plan_id: string): void {
    for (const planId of knownIssuePlans(this.deps.plans, issue.issue_key)) {
      if (planId === current_plan_id) {
        continue;
      }
      const state = this.deps.plans.getPlanState(planId);
      if (state === null || state.state !== "active") {
        continue;
      }
      this.deps.plans.appendPlanState({
        plan_id: planId,
        expected_state_seq: state.state_seq,
        state: "superseded",
        reason_code: null,
        task_id: issue.binding.task_id,
        branch_id: issue.binding.branch_id
      });
    }
  }

  /** Marks every active plan for the issue's key as `stale_goal`. */
  private staleGoalPlans(issue: Issue): void {
    for (const planId of knownIssuePlans(this.deps.plans, issue.issue_key)) {
      const state = this.deps.plans.getPlanState(planId);
      if (state === null || state.state !== "active") {
        continue;
      }
      this.deps.plans.appendPlanState({
        plan_id: planId,
        expected_state_seq: state.state_seq,
        state: "stale_goal",
        reason_code: null,
        task_id: state.task_id,
        branch_id: state.branch_id
      });
    }
  }

  async planExperienceReview(input: ExperienceReviewPlanningInput): Promise<ExperienceReviewPlanningResult> {
    const snapshot = this.deps.evidence;
    const binding = input.binding;
    const review = input.snapshot;
    // DD-QP-31h fixes the gate order: the frozen review snapshot is checked
    // first, then the scope (task/branch/epoch/config) and the goal.
    if (snapshot.review_snapshot_id === null) {
      return { status: "rejected", reason: "E_INDEX_REVIEW_SNAPSHOT_MISSING", missing: [], route: null };
    }
    if (snapshot.review_snapshot_id !== review.snapshot_id || snapshot.review_snapshot_hash !== review.snapshot_hash) {
      return { status: "rejected", reason: "E_INDEX_REVIEW_SNAPSHOT_INVALID", missing: [], route: null };
    }
    // A malformed snapshot hash is an invalid shape, not a match.
    if (!isHash(snapshot.review_snapshot_hash) || !isHash(review.snapshot_hash)) {
      return { status: "rejected", reason: "E_INDEX_REVIEW_SNAPSHOT_INVALID", missing: [], route: null };
    }
    if (
      review.binding.task_id !== binding.task_id ||
      review.binding.branch_id !== binding.branch_id ||
      review.binding.input_epoch !== binding.input_epoch ||
      review.binding.config_version !== binding.config_version
    ) {
      return { status: "rejected", reason: "E_INDEX_SCOPE_MISMATCH", missing: [], route: null };
    }
    if (review.binding.goal_version !== binding.goal_version) {
      return { status: "rejected", reason: "E_GOAL_STALE", missing: [], route: null };
    }
    const checks = review.local_checks;
    if (
      !checks.static_check_passed ||
      !checks.authorization_granted ||
      !checks.scope_compatible ||
      !checks.version_compatible
    ) {
      return {
        status: "rejected",
        reason: "E_CONFIRMATION_EVIDENCE_INSUFFICIENT",
        missing: [],
        route: null
      };
    }
    if (review.source_refs.length === 0 || review.source_refs.length > MAX_SOURCE_REFS) {
      return {
        status: "rejected",
        reason: "E_CONFIRMATION_EVIDENCE_INSUFFICIENT",
        missing: [],
        route: null
      };
    }
    try {
      const existing = this.deps.issues
        /*
         * DD-QP-26: an experience issue in `needs_evidence` is an active
         * issue the planner cannot advance. It is a `not_planable_state`
         * no-op with a persisted route, not a rejection.
         */
        .listActive({ binding: snapshot.binding, states: ["proposed", "open", "needs_evidence"] })
        .find((summary) => summary.type === "experience_applicability");
      if (existing !== undefined) {
        const issue = this.deps.issues.getIssue(existing.issue_id);
        if (issue !== null) {
          const activePlan = this.findActivePlanForIssue(issue);
          if (activePlan !== null) {
            const route = await this.commitExperienceRoute(activePlan.plan);
            if (!route.ok) {
              return { status: "rejected", reason: failureCode(route.error.code), missing: [], route: null };
            }
            return {
              status: "planned",
              issue,
              plan: activePlan.plan,
              plan_state: activePlan.state,
              question_key: activePlan.plan.questions[0]?.question_key ?? "",
              deduplicated: true,
              route: route.value,
              ...this.experienceState(input, activePlan.plan)
            };
          }
          /*
           * DD-QP-26: an issue that exists but cannot be planned is a
           * no-op, not a rejection. An active issue without a plan is the
           * `duplicate_issue` path (`route_state="duplicate"`); an issue in
           * a state the planner cannot advance is `not_planable_state`
           * (`route_state="degraded"`). Both carry a persisted route and
           * never express the no-op as `route=null`.
           */
          if (issue.state !== "open" && issue.state !== "proposed") {
            /*
             * `needs_evidence` is the state the planner cannot advance:
             * the issue waits for more evidence, so the result is
             * `not_planable_state` / `route_state="degraded"`. Every other
             * non-planable state is the `duplicate_issue` path.
             */
            const notPlanable = issue.state === "needs_evidence";
            const route = await this.commitExperienceNoOpRoute({
              issue_key: issue.issue_key,
              subject_key: issue.subject_key,
              subject_versions: [String(issue.issue_version)],
              route_state: notPlanable ? "degraded" : "duplicate",
              stage_reasons: notPlanable
                ? {
                    deterministic: ["owner_unavailable"],
                    retrieval: ["owner_unavailable"],
                    semantic: ["semantic_not_needed"],
                    verification: ["verification_absent"]
                  }
                : {
                    deterministic: ["deterministic_inconclusive"],
                    retrieval: ["skipped_by_order"],
                    semantic: ["semantic_not_needed"],
                    verification: ["verification_absent"]
                  }
            });
            if (!route.ok) {
              return { status: "rejected", reason: failureCode(route.error.code), missing: [], route: null };
            }
            return {
              status: "no_op",
              reason: notPlanable ? "not_planable_state" : "duplicate_issue",
              issue_id: issue.issue_id,
              route: route.value
            };
          }
          if (issue.state === "open") {
            return await this.planExperienceIssue(issue, input.registry, input);
          }
          if (issue.state === "proposed") {
            const confirmation = confirmationProjection(
              {
                kind: "review_snapshot",
                snapshot_id: review.snapshot_id,
                source_refs: review.source_refs,
                experience_ids: [review.candidate.experience_id]
              },
              snapshot.binding.watermark
            );
            const confirmed = this.transition(issue, {
              transition_id: transitionIdFor("confirm", issue.issue_id),
              event: "confirm",
              patch: { confirmation }
            });
            if (confirmed.issue === undefined) {
              return {
                status: "rejected",
                reason: confirmed.errors[0] ?? "E_CONFIRMATION_EVIDENCE_INSUFFICIENT",
                issue_id: issue.issue_id,
                missing: [],
                route: null
              };
            }
            return await this.planExperienceIssue(confirmed.issue, input.registry, input);
          }
        }
      }
      const subjectKey =
        `experience:${review.candidate.experience_id}:v${String(review.candidate.version)}:${review.candidate.content_hash}`.slice(0, 512);
      const issueId = newId("issue");
      const proposed = createProposedIssue({
        issue_id: issueId,
        issue_key: requireIssueKey({
          type: "experience_applicability",
          binding: snapshot.binding,
          requirement_ids: [],
          subject_key: subjectKey
        }),
        binding: snapshot.binding,
        type: "experience_applicability",
        subject_key: subjectKey,
        question_text: null,
        requirement_ids: [],
        artifact_paths: [],
        artifact_versions: [],
        contract_required: false,
        contract_paths: [],
        trigger: {
          kind: "review_snapshot",
          event_ids: [review.snapshot_id],
          detector_id: "experience/1",
          detector_version: "qp.issue_detector/1"
        },
        source_event_ids: [review.snapshot_id],
        source_refs: review.source_refs,
        evidence_gap: [],
        created_at: this.clock.utcNowMs(),
        experience_ref: {
          snapshot_id: review.snapshot_id,
          snapshot_hash: review.snapshot_hash,
          proposal_id: review.proposal_id,
          proposal_hash: review.proposal_hash ?? review.snapshot_hash,
          experience_id: review.candidate.experience_id,
          experience_version: review.candidate.version,
          experience_content_hash: review.candidate.content_hash
        }
      });
      const proposeId = transitionIdFor("propose", issueId);
      const opened = this.deps.issues.appendTransition({
        transition_id: proposeId,
        issue_id: issueId,
        expected_version: 0,
        from_state: "none",
        to_state: "proposed",
        event: "propose",
        evidence_refs: sortedUniqueRefs(review.source_refs),
        issue: { ...proposed, last_transition_id: proposeId }
      }).issue;
      const confirmation = confirmationProjection(
        {
          kind: "review_snapshot",
          snapshot_id: review.snapshot_id,
          source_refs: review.source_refs,
          experience_ids: [review.candidate.experience_id]
        },
        snapshot.binding.watermark
      );
      const confirmId = transitionIdFor("confirm", issueId);
      const confirmed = this.transition({ ...opened, question_text: null }, {
        transition_id: confirmId,
        event: "confirm",
        patch: { confirmation }
      });
      if (confirmed.issue === undefined) {
        return { status: "rejected", reason: confirmed.errors[0] ?? "E_CONFIRMATION_EVIDENCE_INSUFFICIENT", missing: [], route: null };
      }
      const planned = this.plan({
        binding: snapshot.binding,
        issue: confirmed.issue,
        registry: input.registry,
        policy_version: "qp.planner/1"
      });
      if (planned.status !== "planned") {
        return {
          status: "rejected",
          reason: planned.status === "rejected" ? planned.reason : "E_PLAN_REQUIRED",
          issue_id: confirmed.issue.issue_id,
          missing: planned.status === "rejected" ? planned.missing : [],
          route: null
        };
      }
      const route = await this.commitExperienceRoute(planned.plan);
      if (!route.ok) {
        return { status: "rejected", reason: failureCode(route.error.code), missing: [], route: null };
      }
      return {
        status: "planned",
        issue: confirmed.issue,
        plan: planned.plan,
        plan_state: planned.plan_state,
        question_key: planned.plan.questions[0]?.question_key ?? "",
        deduplicated: planned.deduplicated,
        route: route.value,
        ...this.experienceState(input, planned.plan)
      };
    } catch (error) {
      if (error instanceof QpDomainError) {
        return { status: "rejected", reason: failureCode(codeOf(error)), missing: [], route: null };
      }
      throw error;
    }
  }

  /**
   * Persists the experience route of a plan and returns its reference.
   *
   * DD-QP-31a: the route is committed before the planning result is
   * returned, and the result carries the committed route's identity. A
   * rejected route is not persisted and yields a `null` reference.
   */
  private async commitExperienceRoute(
    plan: QuestionPlan
  ): Promise<Result<ExperienceReviewRouteRef, ErrorEnvelope>> {
    const store = this.deps.routes ?? createJudgmentRouteStore();
    const draft = experienceRouteDraft(plan);
    const appended = await store.appendJudgmentRoute({
      draft,
      current_action: null,
      escalation_source: null
    });
    if (!appended.ok) {
      // A route that cannot be committed is not a planning result
      // (DD-QP-31a): the caller rejects instead of publishing a route
      // reference that was never persisted.
      return err(appended.error);
    }
    const record = appended.value.record;
    return ok({
      route_id: record.route_id,
      route_key: record.route_key,
      route_hash: record.route_hash,
      route_class: "experience_match",
      // The persisted route of a planning result is `planned`.
      route_state: "planned"
    });
  }

  /**
   * Persists the `no_op` route of an experience review and returns its
   * reference.
   *
   * DD-QP-26: a no-op result still carries a complete route; the semantic
   * stage reads `skipped/semantic_not_needed` and the record's
   * `route_status` is `no_op`. `route=null` never expresses a no-op.
   */
  private async commitExperienceNoOpRoute(input: {
    issue_key: string | null;
    subject_key: string;
    subject_versions: string[];
    route_state: "not_required" | "duplicate" | "degraded";
    stage_reasons?: Partial<Record<JudgmentRouteStageName, readonly JudgmentRouteReason[]>>;
  }): Promise<Result<ExperienceReviewRouteRef, ErrorEnvelope>> {
    const store = this.deps.routes ?? createJudgmentRouteStore();
    const draft = buildExperienceNoOpRoute({
      binding: this.deps.evidence.binding,
      issue_key: input.issue_key,
      subject_key: input.subject_key,
      subject_versions: input.subject_versions,
      ...(input.stage_reasons === undefined ? {} : { stage_reasons: input.stage_reasons })
    });
    const appended = await store.appendJudgmentRoute({
      draft,
      current_action: null,
      escalation_source: null
    });
    if (!appended.ok) {
      return err(appended.error);
    }
    const record = appended.value.record;
    return ok({
      route_id: record.route_id,
      route_key: record.route_key,
      route_hash: record.route_hash,
      route_class: "experience_match",
      route_state: input.route_state
    });
  }

  private async planExperienceIssue(
    issue: Issue,
    registry: PlanningInput["registry"],
    review: ExperienceReviewPlanningInput
  ): Promise<ExperienceReviewPlanningResult> {
    const planned = this.plan({
      binding: this.deps.evidence.binding,
      issue,
      registry,
      policy_version: "qp.planner/1"
    });
    if (planned.status !== "planned") {
      return {
        status: "rejected",
        reason: planned.status === "rejected" ? planned.reason : "E_PLAN_REQUIRED",
        issue_id: issue.issue_id,
        missing: planned.status === "rejected" ? planned.missing : [],
        route: null
      };
    }
    const route = await this.commitExperienceRoute(planned.plan);
    if (!route.ok) {
      return { status: "rejected", reason: failureCode(route.error.code), missing: [], route: null };
    }
    return {
      status: "planned",
      issue,
      plan: planned.plan,
      plan_state: planned.plan_state,
      question_key: planned.plan.questions[0]?.question_key ?? "",
      deduplicated: planned.deduplicated,
      route: route.value,
      ...this.experienceState(review, planned.plan)
    };
  }

  /** Projects the single-candidate review state for the REV handoff. */
  private experienceState(
    review: ExperienceReviewPlanningInput,
    plan: QuestionPlan
  ): { state?: JudgeState } {
    const planState = this.deps.plans.getPlanState(plan.plan_id);
    if (planState === null) {
      return {};
    }
    const result = projectJudgeState({
      plan,
      snapshot: experienceReviewSnapshot(this.deps.evidence, review),
      shard: {
        shard_id: `review:${plan.plan_id}`,
        question_keys: plan.questions.map((question) => question.question_key),
        pack_hash: plan.plan_hash
      },
      plan_state: planState,
      review_snapshot_id: review.snapshot.snapshot_id
    });
    return result.status === "ok" ? { state: result.state } : {};
  }

  private findActivePlanForIssue(issue: Issue): { plan: QuestionPlan; state: PlanState } | null {
    const planId = this.planByIssue.get(issue.issue_id);
    if (planId === undefined) {
      return null;
    }
    const plan = this.deps.plans.getPlan(planId);
    const state = this.deps.plans.getPlanState(planId);
    if (plan === null || state === null || state.state !== "active") {
      return null;
    }
    return { plan, state };
  }

  validatePlan(input: PlanValidationInput): PlanValidationResult {
    const snapshot = this.deps.evidence;
    const planBinding = input.plan.binding;
    if (
      planBinding.task_id !== snapshot.binding.task_id ||
      planBinding.branch_id !== snapshot.binding.branch_id ||
      planBinding.input_epoch !== snapshot.binding.input_epoch ||
      planBinding.config_version !== snapshot.binding.config_version
    ) {
      return { status: "stale", plan_state: "stale_binding", errors: ["E_PLAN_STALE"] };
    }
    if (planBinding.goal_version !== input.current_binding.goal_version) {
      return { status: "stale", plan_state: "stale_goal", errors: ["E_PLAN_STALE"] };
    }
    if (
      planBinding.watermark !== snapshot.binding.watermark ||
      input.current_binding.task_id !== snapshot.binding.task_id ||
      input.current_binding.branch_id !== snapshot.binding.branch_id ||
      input.current_binding.input_epoch !== snapshot.binding.input_epoch ||
      input.current_binding.config_version !== snapshot.binding.config_version ||
      input.current_binding.watermark < snapshot.binding.watermark
    ) {
      return { status: "stale", plan_state: "stale_binding", errors: ["E_INDEX_SCOPE_MISMATCH"] };
    }
    if (input.registry.registry_hash !== input.plan.registry_hash) {
      return { status: "stale", plan_state: "stale_template", errors: ["E_TEMPLATE_HASH_MISMATCH"] };
    }
    const bodies = registryTemplateBodies(input.registry) ?? [...this.templates.values()];
    for (const question of input.plan.questions) {
      const summary = input.registry.templates.find(
        (entry) =>
          entry.template_id === question.template_id && entry.template_version === question.template_version
      );
      const template = bodies.find(
        (entry) => entry.template_id === question.template_id && entry.template_version === question.template_version
      );
      if (summary === undefined || template === undefined) {
        return { status: "stale", plan_state: "stale_template", errors: ["E_TEMPLATE_NOT_FOUND"] };
      }
      if (template.status === "deprecated" || summary.status === "deprecated") {
        return { status: "stale", plan_state: "stale_template", errors: ["E_TEMPLATE_DEPRECATED"] };
      }
      if (template.template_hash !== question.template_hash || summary.template_hash !== question.template_hash) {
        return { status: "stale", plan_state: "stale_template", errors: ["E_TEMPLATE_HASH_MISMATCH"] };
      }
    }
    return { status: "valid" };
  }

  project(input: ProjectionInput): ProjectionResult {
    if (!equalVersionBinding(input.plan.binding, this.deps.evidence.binding)) {
      return {
        status: "rejected",
        errors: [{ code: "E_INDEX_SCOPE_MISMATCH", question_keys: [] }]
      };
    }
    if (
      input.plan.state_profile === "experience_review" &&
      input.review_snapshot_id !== undefined &&
      input.review_snapshot_id !== this.deps.evidence.review_snapshot_id
    ) {
      return {
        status: "rejected",
        errors: [{ code: "E_INDEX_REVIEW_SNAPSHOT_MISSING", question_keys: [] }]
      };
    }
    const planState = this.deps.plans.getPlanState(input.plan.plan_id);
    return projectJudgeState({
      plan: input.plan,
      snapshot: this.deps.evidence,
      shard: input.shard,
      plan_state: planState,
      ...(input.review_snapshot_id === undefined ? {} : { review_snapshot_id: input.review_snapshot_id })
    });
  }

  validateProjection(input: ProjectionValidationInput): ProjectionValidationResult {
    return validateProjection(input, this.deps.plans.getPlanState(input.plan.plan_id));
  }

  validateJudgeState(input: JudgeStateValidationInput): JudgeStateValidationResult {
    return validateJudgeStatePure(input);
  }
}

function mapResult(
  result:
    | "supported_hard"
    | "contradicted_hard"
    | "supported_semantic"
    | "contradicted_semantic"
    | "conflict"
    | "unknown"
    | "missing",
  basis: "hard_fact" | "mixed"
): "supports" | "contradicts" | "unknown" {
  switch (result) {
    case "supported_hard":
      return "supports";
    case "contradicted_hard":
      return "contradicts";
    case "supported_semantic":
      return basis === "mixed" ? "supports" : "unknown";
    case "contradicted_semantic":
      return basis === "mixed" ? "contradicts" : "unknown";
    case "conflict":
    case "unknown":
    case "missing":
      return "unknown";
  }
}

function completionCheckFor(review: ExperienceReviewPlanningInput["snapshot"]["candidate"]): JudgeExperienceCandidate["completion_check"] {
  const raw = review.completion_check as { kind?: unknown; description?: unknown; criterion?: unknown };
  const description = typeof raw.description === "string" ? raw.description : typeof raw.criterion === "string" ? raw.criterion : "";
  switch (raw.kind) {
    case "test_pass":
      return { kind: "test_pass", description };
    case "artifact_check":
      return { kind: "artifact_check", description };
    case "state_predicate":
      return { kind: "state_predicate", description };
    case "human_acceptance":
      return { kind: "human_acceptance", description };
    case "external_verification":
      return { kind: "external_verification", description };
    case "test":
      return { kind: "test_pass", description };
    case "artifact":
      return { kind: "artifact_check", description };
    case "constraint":
      return { kind: "state_predicate", description };
    default:
      return { kind: "none", description };
  }
}

/**
 * The review snapshot carries the full candidate body and shortlist; the
 * frozen index view may only carry identity. Projection reads the review body
 * without a second REV read port.
 */
function experienceReviewSnapshot(
  snapshot: EvidenceIndexSnapshot,
  review: ExperienceReviewPlanningInput
): EvidenceIndexSnapshot {
  const candidate = review.snapshot.candidate;
  const shortlist = review.snapshot.shortlist.map((entry, index) => ({
    display_id: `X${String(index + 2)}`,
    logical_id: `experience:${entry.experience_id}@${String(entry.version)}`,
    experience_id: entry.experience_id,
    version: entry.version,
    content_hash: entry.content_hash,
    relation: entry.relation,
    excerpt: entry.excerpt
  }));
  const projected: JudgeExperienceCandidate = {
    display_id: "",
    logical_id: `experience:${candidate.experience_id}@${String(candidate.version)}`,
    experience_id: candidate.experience_id,
    version: candidate.version,
    content_hash: candidate.content_hash,
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    trigger: candidate.trigger,
    scope: candidate.scope,
    preconditions: [...candidate.preconditions],
    steps: [...candidate.steps],
    expected_effects: [...candidate.expected_effects],
    completion_check: completionCheckFor(candidate),
    counterexamples: [...candidate.counterexamples],
    risk: candidate.risk,
    excerpt: candidate.excerpt,
    shortlist
  };
  return {
    ...snapshot,
    listExperienceCandidates: (query: {
      binding: VersionBinding;
      review_snapshot_id: string;
    }): readonly ExperienceCandidateView[] =>
      snapshot
        .listExperienceCandidates(query)
        .map((view) =>
          view.candidate.experience_id === candidate.experience_id
            ? { ...view, candidate: projected }
            : view
        )
  };
}

/** Builds the planning route reference from the canonical route identity. */
/**
 * Builds the experience route draft for a plan.
 *
 * The draft is the same one the route store appends; the planner builds it
 * here so the identity it returns is the identity the store persists.
 */
function experienceRouteDraft(plan: QuestionPlan): JudgmentRouteDraft {
  const question = plan.questions[0];
  return buildExperiencePlannedRoute({
    plan: {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      issue_key: plan.issue_key,
      binding: plan.binding
    },
    question_key: question?.question_key ?? "",
    template_binding: {
      template_id: question?.template_id ?? "qt.experience_match",
      template_version: question?.template_version ?? "1.0.0",
      template_hash: question?.template_hash ?? `sha256:${"0".repeat(64)}`
    },
    project_id: null,
    subject_key: plan.issue_key,
    subject_versions: [String(plan.issue_version)]
  });
}

function requireIssueKey(input: {
  type: "experience_applicability";
  binding: VersionBinding;
  requirement_ids: readonly string[];
  subject_key: string;
}): string {
  return computeIssueKey(input);
}

/**
 * Internal constructor used by the async factory. The class itself is not
 * exported, so `createQuestionPlanner` remains the only public entry point.
 */
export function instantiateQuestionPlanner(
  deps: QuestionPlannerDeps,
  clock: Clock = systemClock
): QuestionPlanner {
  return new QuestionPlannerImpl(deps, clock);
}
