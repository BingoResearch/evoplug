/**
 * Five-stage review pipeline ordering and failure mapping (DD-REV-080).
 */

import type { ReviewJobResult, ReviewJobStage } from "./types.js";

export const PIPELINE_STAGES: readonly ReviewJobStage[] = [
  "snapshot",
  "generate",
  "static_check",
  "experience_match_judge",
  "handoff"
];

export interface StageFailureEffect {
  failure_point: string;
  candidate_effect: string;
  job_effect: ReviewJobStage | "not_enqueued";
  visible_result: string;
}

/** DD-REV-080 stage-failure table, verbatim in machine form. */
export const STAGE_FAILURE_EFFECTS: readonly StageFailureEffect[] = [
  {
    failure_point: "snapshot_source_missing",
    candidate_effect: "none",
    job_effect: "not_enqueued",
    visible_result: "E_REVIEW_SNAPSHOT_SOURCE_MISSING"
  },
  {
    failure_point: "no_backend",
    candidate_effect: "none",
    job_effect: "snapshot",
    visible_result: "blocked_no_backend"
  },
  {
    failure_point: "egress_not_approved",
    candidate_effect: "none",
    job_effect: "snapshot",
    visible_result: "blocked_no_backend"
  },
  {
    failure_point: "backend_spawn_failed",
    candidate_effect: "none",
    job_effect: "generate",
    visible_result: "attempt_error_and_charge"
  },
  {
    failure_point: "output_invalid",
    candidate_effect: "none",
    job_effect: "generate",
    visible_result: "output_hash_and_line"
  },
  {
    failure_point: "static_partial_failure",
    candidate_effect: "rejected",
    job_effect: "static_check",
    visible_result: "accepted_proposals_with_reasons"
  },
  {
    failure_point: "static_all_failed",
    candidate_effect: "rejected",
    job_effect: "handoff",
    visible_result: "all_rejected"
  },
  {
    failure_point: "all_stale",
    candidate_effect: "stale",
    job_effect: "handoff",
    visible_result: "all_stale"
  },
  {
    failure_point: "no_candidate",
    candidate_effect: "none",
    job_effect: "handoff",
    visible_result: "no_candidate"
  },
  {
    failure_point: "judge_conflict",
    candidate_effect: "proposal_unverified",
    job_effect: "experience_match_judge",
    visible_result: "match_outcome_bound"
  },
  {
    failure_point: "judge_degraded",
    candidate_effect: "proposal_unverified",
    job_effect: "handoff",
    visible_result: "candidate_retained_no_auto_adopt"
  },
  {
    failure_point: "target_changed",
    candidate_effect: "stale",
    job_effect: "snapshot",
    visible_result: "old_snapshot_not_reused_new_supersede"
  },
  {
    failure_point: "user_cancelled",
    candidate_effect: "withdrawn",
    job_effect: "generate",
    visible_result: "attempt_terminated_charge_not_refunded"
  },
  {
    failure_point: "handoff_write_failed",
    candidate_effect: "proposed",
    job_effect: "handoff",
    visible_result: "recover_rebuild"
  }
];

export function nextPipelineStage(stage: ReviewJobStage): ReviewJobStage | null {
  if (stage === "closed") {
    return null;
  }
  const index = PIPELINE_STAGES.indexOf(stage);
  if (index < 0 || index === PIPELINE_STAGES.length - 1) {
    return null;
  }
  return PIPELINE_STAGES[index + 1] ?? null;
}

export function stageIndex(stage: ReviewJobStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}

export function stageAfterStaticCheck(hasAcceptedProposal: boolean): ReviewJobStage {
  return hasAcceptedProposal ? "experience_match_judge" : "handoff";
}

export function jobStageAfterJudge(hasPending: boolean): ReviewJobStage {
  return hasPending ? "experience_match_judge" : "handoff";
}

export function jobStageAfterHandoff(): ReviewJobStage {
  return "closed";
}

export function jobResultAfterHandoff(input: {
  proposalCount: number;
  candidateCount: number;
  rejectedCandidates: number;
  staleCandidates: number;
  staleProposals: number;
}): ReviewJobResult {
  if (input.proposalCount > 0) {
    return "proposed";
  }
  if (input.candidateCount === 0) {
    return "no_candidate";
  }
  if (input.rejectedCandidates > 0) {
    return "all_rejected";
  }
  if (input.staleCandidates > 0 || input.staleProposals > 0) {
    return "all_stale";
  }
  return "all_stale";
}

export function failureEffect(failurePoint: string): StageFailureEffect | null {
  return STAGE_FAILURE_EFFECTS.find((effect) => effect.failure_point === failurePoint) ?? null;
}

/** A candidate failure never changes the job until T4 completes. */
export function candidateFailureAffectsJob(code: string): boolean {
  return code === "E_REVIEW_BUDGET_EXHAUSTED" || code === "E_REVIEW_OUTPUT_TOO_LARGE";
}

export function isTerminalPipelineStage(stage: ReviewJobStage): boolean {
  return stage === "closed";
}
