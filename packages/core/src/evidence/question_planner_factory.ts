/**
 * Async QuestionPlanner factory (DD-QP-26a).
 *
 * Loads the frozen evidence index exactly once, validates the snapshot
 * contract, then constructs the planner. There is no refresh, reload or
 * setter; a new watermark requires a new planner.
 */

import { makeErrorEnvelope } from "../errors.js";
import type { EvdIndexErrorCode } from "./errors.js";
import type {
  AcceptedAggregateReadPort,
  EvidenceIndexLoadRequest,
  EvidenceIndexSnapshot,
  EvdIndexLoadError,
  EvidenceIndexSnapshotLoader,
  FrozenSourceExpectationPort,
  ReviewHandoffReadPort,
  SourceCheckPort
} from "./ports.js";
import { isEvidenceIndexSnapshot } from "./ports.js";
import type { IssueWriteRepository, QuestionPlanRepository } from "./types.js";
import { createPlanRepository } from "./plan_repository.js";
import { instantiateQuestionPlanner, type QuestionPlanner, type QuestionPlannerDeps } from "./question_planner.js";
import type { JudgmentRouteStore } from "./judgment_route.js";

export interface CreateQuestionPlannerCommand {
  loader: EvidenceIndexSnapshotLoader;
  load_request: EvidenceIndexLoadRequest;
  issues: IssueWriteRepository;
  /** Defaults to an in-memory repository when the caller has no persistence. */
  plans?: QuestionPlanRepository;
  sourceExpectations?: FrozenSourceExpectationPort;
  sources?: SourceCheckPort;
  aggregates?: AcceptedAggregateReadPort;
  handoffs?: ReviewHandoffReadPort;
  /**
   * The route store the planner commits its experience route through.
   *
   * DD-QP-31a: the route is persisted before the planning result is returned.
   * When the caller supplies no store, an in-memory one is used and the route
   * is not durable.
   */
  routes?: JudgmentRouteStore;
  signal?: AbortSignal;
}

export type CreateQuestionPlannerResult =
  | { status: "ok"; planner: QuestionPlanner }
  | { status: "rejected"; code: EvdIndexErrorCode; stage: "load"; error: EvdIndexLoadError }
  | { status: "rejected"; code: EvdIndexErrorCode; stage: "contract" };

function sameBinding(
  binding: EvidenceIndexSnapshot["binding"],
  request: EvidenceIndexLoadRequest["binding"]
): boolean {
  return (
    binding.task_id === request.task_id &&
    binding.branch_id === request.branch_id &&
    binding.input_epoch === request.input_epoch &&
    binding.goal_version === request.goal_version &&
    binding.config_version === request.config_version &&
    binding.watermark === request.watermark
  );
}

function contractFailure(code: EvdIndexErrorCode): CreateQuestionPlannerResult {
  return { status: "rejected", code, stage: "contract" };
}

const unavailableExpectations: FrozenSourceExpectationPort = {
  async resolveExpected() {
    return { status: "rejected", code: "E_SOURCE_UNRETRIEVABLE", details: { stage: "expected_source_hashes" } };
  }
};

const unavailableSourceCheck: SourceCheckPort = {
  async check() {
    return { status: "rejected", code: "E_SOURCE_UNRETRIEVABLE", details: { stage: "source_check" } };
  }
};

const unavailableAggregates: AcceptedAggregateReadPort = {
  async readAccepted() {
    return {
      ok: false,
      status: "rejected",
      error: makeErrorEnvelope({
        code: "E_AGGREGATE_NOT_FOUND",
        category: "not_found",
        message_key: "error.aggregate.not_found",
        stage: "aggregate_read",
        details: { kind: "none" }
      })
    };
  }
};

const unavailableHandoffs: ReviewHandoffReadPort = {
  async getHandoffCloseView() {
    return {
      ok: false,
      status: "rejected",
      error: makeErrorEnvelope({
        code: "E_HANDOFF_NOT_READY",
        category: "not_found",
        message_key: "error.handoff.not_ready",
        stage: "review_handoff_read",
        details: { kind: "none" }
      })
    };
  }
};

/** Validates the loaded snapshot against the request (DD-QP-26a step 3). */
export function validateSnapshotContract(
  snapshot: unknown,
  request: EvidenceIndexLoadRequest
): EvdIndexErrorCode | null {
  if (!isEvidenceIndexSnapshot(snapshot) || snapshot.schema_version !== "rsi.evidence_index_snapshot/1") {
    return "E_INDEX_NOT_LOADED";
  }
  if (!sameBinding(snapshot.binding, request.binding)) {
    return "E_INDEX_SCOPE_MISMATCH";
  }
  if (snapshot.watermark !== request.watermark || request.watermark !== request.binding.watermark) {
    return "E_INDEX_WINDOW_INVALID";
  }
  if (snapshot.progress_from_watermark !== request.progress_from_watermark) {
    return "E_INDEX_WINDOW_INVALID";
  }
  const requestedReview = request.review_snapshot_id ?? null;
  if (snapshot.review_snapshot_id !== requestedReview) {
    return "E_INDEX_REVIEW_SNAPSHOT_INVALID";
  }
  if ((snapshot.review_snapshot_hash !== null) !== (snapshot.review_snapshot_id !== null)) {
    return "E_INDEX_REVIEW_SNAPSHOT_INVALID";
  }
  return null;
}

/** Loads once and constructs the planner; the only public construction path. */
export async function createQuestionPlanner(
  cmd: CreateQuestionPlannerCommand
): Promise<CreateQuestionPlannerResult> {
  const loadOptions = cmd.signal === undefined ? {} : { signal: cmd.signal };
  const loaded = await cmd.loader.load(cmd.load_request, loadOptions);
  if (!loaded.ok) {
    return { status: "rejected", code: loaded.error.code, stage: "load", error: loaded.error };
  }
  const failure = validateSnapshotContract(loaded.value, cmd.load_request);
  if (failure !== null) {
    return contractFailure(failure);
  }
  const deps: QuestionPlannerDeps = {
    evidence: loaded.value,
    issues: cmd.issues,
    plans: cmd.plans ?? createPlanRepository(),
    sourceExpectations: cmd.sourceExpectations ?? unavailableExpectations,
    sources: cmd.sources ?? unavailableSourceCheck,
    aggregates: cmd.aggregates ?? unavailableAggregates,
    handoffs: cmd.handoffs ?? unavailableHandoffs,
    ...(cmd.routes === undefined ? {} : { routes: cmd.routes })
  };
  return { status: "ok", planner: instantiateQuestionPlanner(deps) };
}
