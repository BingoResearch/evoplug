/**
 * QP consumption ports (DD-QP-08, DD-QP-19, DD-QP-25, DD-QP-26a).
 *
 * EVD and REV own these DTOs and ports. Until their packages publish the
 * generated types, this module declares the structural surface QP consumes,
 * with the exact field names from DD-QP-29a. Owners remain authoritative;
 * QP never copies fields or defines a second getter surface.
 */

import type { ErrorEnvelope } from "../errors.js";
import type { Result } from "../result.js";
import type { SourceRef } from "../source-ref.js";
import type { VersionBinding } from "../version-binding.js";
import type { EvidenceGapCode, ConfirmationOrigin, JudgeExperienceCandidate } from "./types.js";
import type { EvdIndexErrorCode } from "./errors.js";

/** A read-only requirement view from the frozen ledger (FND projection). */
interface RequirementAcceptanceView {
  kind: "human_acceptance" | "test" | "artifact" | "constraint";
  criterion: string;
  acceptance_ref_id?: string;
}

/** Per-acceptance-item view used by `per_acceptance_item` templates. */
interface AcceptanceItemView {
  criterion_id?: string;
  text?: string;
  source_ref?: SourceRef;
}

export interface RequirementView {
  requirement_id: string;
  statement_ref: SourceRef;
  statement_text_hash: string;
  scope: {
    paths?: string[];
    excluded_paths?: string[];
    objects?: string[];
  };
  acceptance: RequirementAcceptanceView | readonly AcceptanceItemView[];
  status: "active" | "proposed" | "retracted";
  goal_version: string;
  valid_from_event: number;
  source_refs: SourceRef[];
}

export interface RequirementOpView {
  op_id: string;
  status: "applied" | "proposed" | "conflict";
  op: "add" | "clarify" | "supersede" | "retract" | "confirm";
  actor_origin: ConfirmationOrigin;
  directive_strength: "explicit" | "ambiguous";
  target_requirement_id: string | null;
  created_requirement_id: string | null;
  goal_version_before: string;
  goal_version_after: string;
  valid_from_event: number;
  content_hash: string;
  source_quote_ref: SourceRef | null;
  source_refs: SourceRef[];
}

export interface FeedbackView {
  schema_version: "rsi.feedback_view/1";
  feedback_id: string;
  target_issue_id: string | null;
  signal_kind: string;
  origin: ConfirmationOrigin;
  status: "recorded" | "needs_evidence";
  goal_version: string;
  input_epoch: number;
  source_refs: SourceRef[];
  recorded_at: number;
  recorded_at_watermark: number;
}

export interface EvidenceFactView {
  schema_version?: string;
  fact_id: string;
  /**
   * EVD freezes one requirement per fact (`requirement_id`); the QP fixture
   * projection may carry the plural form. Consumers use
   * `factRequirementIds()` so both arrive at the same view.
   */
  requirement_id?: string;
  requirement_ids?: string[];
  proposition_id?: string;
  kind:
    | "code"
    | "interface_contract"
    | "call"
    | "result"
    | "diff"
    | "test"
    | "message";
  status: "claim" | "observed" | "verified" | "contradicted" | "unknown";
  stale: boolean;
  artifact_version?: string;
  subject?: string | null;
  value: string;
  verifier_ref?: string | null;
  verified?: boolean;
  effect?: "supports" | "violates" | "unknown";
  source_refs: SourceRef[];
}

/** Requirement ids a fact contributes, accepting both frozen view shapes. */
export function factRequirementIds(fact: EvidenceFactView): string[] {
  if (Array.isArray(fact.requirement_ids)) {
    return fact.requirement_ids;
  }
  if (typeof fact.requirement_id === "string" && fact.requirement_id.length > 0) {
    return [fact.requirement_id];
  }
  return [];
}

/** Fact subject normalised to `null` when the owner omits it. */
export function factSubject(fact: EvidenceFactView): string | null {
  return typeof fact.subject === "string" ? fact.subject : null;
}

/** Fact artifact version normalised to `null` when the owner omits it. */
export function factArtifactVersion(fact: EvidenceFactView): string | null {
  return typeof fact.artifact_version === "string" ? fact.artifact_version : null;
}

/** True when the fact carries an independent verifier result. */
export function factHasVerifier(fact: EvidenceFactView): boolean {
  return (typeof fact.verifier_ref === "string" && fact.verifier_ref.length > 0) || fact.verified === true;
}

export interface ProgressSignalView {
  signal_id: string;
  status: "comparable" | "pending" | "blocked" | "paused" | "cancelled" | "capture_gap";
  to_watermark: number;
  comparability_key: string;
  kind: "advancing" | "stalled_candidate" | "regressing" | "unknown";
  source_refs: SourceRef[];
  evidence_digest: string;
}

export interface CoverageMissingEntry {
  code: EvidenceGapCode;
  requirement_id: string | null;
  logical_id: string | null;
  source_refs: SourceRef[];
}

export interface CoverageSnapshotView {
  view_key: string;
  missing: CoverageMissingEntry[];
  checked_requirement_ids: string[];
  source_refs: SourceRef[];
}

interface HardFactView {
  fact_key: string;
  verified: boolean;
  binding: VersionBinding;
  artifact_version: string;
  effect: "supports" | "violates" | "unknown";
  requirement_ids: string[];
  source_refs: SourceRef[];
}

export interface UnverifiedConstraintView {
  constraint_id: string;
  logical_id: string;
  version_binding: VersionBinding;
  recorded_at_watermark: number;
  status: "unverified_constraint" | "confirmed" | "rejected";
  authorization: false;
  source_refs: SourceRef[];
  quote_hash: string;
  scope_hint: string | null;
  row_version: number;
}

export interface ComparisonView {
  view_key: string;
  comparability_key: string;
  before_watermark: number;
  after_watermark: number;
  goal_version: string;
  baseline_evidence_digest: string;
  current_evidence_digest: string;
  before_source_refs: SourceRef[];
  after_source_refs: SourceRef[];
  pending_calls: string[];
  excluded_hypothesis_ids: string[];
}

export interface CoverageView {
  view_key: string;
  source_refs: SourceRef[];
  missing_codes: EvidenceGapCode[];
}

export interface TaskConditionView {
  logical_id: string;
  condition_id: string;
  value: string;
  origin: "human" | "fact" | "config" | "review";
  source_refs: SourceRef[];
}

export interface ExperienceCandidateView {
  logical_id: string;
  candidate: JudgeExperienceCandidate;
  review_snapshot_id: string;
  source_refs: SourceRef[];
}

export type ExcerptWindow =
  | { kind: "exact" }
  | { kind: "sentence"; max_sentences?: number }
  | { kind: "line" }
  | { kind: "around_offset"; offset: number; max_sentences?: number };

export type ExcerptReadResult =
  | {
      ok: true;
      bytes: Uint8Array;
      text_hash: string;
      source_ref: SourceRef;
      /** Convenience fields accepted from older in-memory ports. */
      text?: string;
      content_hash?: string;
    }
  | {
      ok: false;
      code:
        | "E_SOURCE_REF_INVALID"
        | "E_SOURCE_NOT_FOUND"
        | "E_SOURCE_OUT_OF_RANGE"
        | "E_SOURCE_UTF8_INVALID"
        | "E_SOURCE_TOO_LARGE";
      source_ref: SourceRef;
    };

/** Frozen read-only evidence index snapshot (EVD owner). */
export interface EvidenceIndexSnapshot {
  readonly schema_version: "rsi.evidence_index_snapshot/1";
  readonly binding: VersionBinding;
  readonly watermark: number;
  readonly progress_from_watermark: number;
  readonly review_snapshot_id: string | null;
  readonly review_snapshot_hash: string | null;
  listRequirements(q: { binding: VersionBinding; watermark: number }): readonly RequirementView[];
  listRequirementOps(q: {
    binding: VersionBinding;
    watermark: number;
    statuses: readonly ("applied" | "proposed" | "conflict")[];
  }): readonly RequirementOpView[];
  listFeedback(q: { binding: VersionBinding; watermark: number }): readonly FeedbackView[];
  listFacts(q: { binding: VersionBinding; watermark: number }): readonly EvidenceFactView[];
  listProgressSignals(q: {
    binding: VersionBinding;
    from_watermark: number;
    to_watermark: number;
  }): readonly ProgressSignalView[];
  getCoverageSnapshot(q: { binding: VersionBinding; watermark: number }): CoverageSnapshotView;
  listHardFacts(q: {
    binding: VersionBinding;
    watermark: number;
    requirement_ids?: readonly string[];
    proposition_ids?: readonly string[];
    artifact_version?: string;
  }): readonly HardFactView[];
  listUnverifiedConstraints(q: {
    binding: VersionBinding;
    watermark: number;
    statuses?: readonly ("unverified_constraint" | "confirmed" | "rejected")[];
  }): readonly UnverifiedConstraintView[];
  listComparisons(q: {
    binding: VersionBinding;
    watermark: number;
    view_keys?: readonly string[];
  }): readonly ComparisonView[];
  listCoverageViews(q: {
    binding: VersionBinding;
    watermark: number;
    view_keys?: readonly string[];
  }): readonly CoverageView[];
  listTaskConditions(q: {
    binding: VersionBinding;
    watermark: number;
    requirement_ids?: readonly string[];
  }): readonly TaskConditionView[];
  listExperienceCandidates(q: {
    binding: VersionBinding;
    review_snapshot_id: string;
    experience_ids?: readonly string[];
  }): readonly ExperienceCandidateView[];
  readExcerpt(ref: SourceRef, window: ExcerptWindow, maxBytes?: number): ExcerptReadResult;
}

export interface EvidenceIndexLoadRequest {
  binding: VersionBinding;
  watermark: number;
  progress_from_watermark: number;
  review_snapshot_id?: string | null;
}

/** EVD index load failure (owner shape; `code` is `E_INDEX_*`). */
export interface EvdIndexLoadError extends ErrorEnvelope {
  code: EvdIndexErrorCode;
}

export interface EvidenceIndexSnapshotLoader {
  load(
    request: EvidenceIndexLoadRequest,
    opts?: { signal?: AbortSignal }
  ): Promise<Result<EvidenceIndexSnapshot, EvdIndexLoadError>>;
}

/** Runtime brand check for a loaded snapshot (DD-QP-26a step 3). */
export function isEvidenceIndexSnapshot(value: unknown): value is EvidenceIndexSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record["schema_version"] === "rsi.evidence_index_snapshot/1" &&
    typeof record["watermark"] === "number" &&
    typeof record["progress_from_watermark"] === "number" &&
    typeof record["listRequirements"] === "function"
  );
}

/* ------------------------------------------------------------------------- */
/* Source expectation and check ports (QP-owned narrow read ports)           */
/* ------------------------------------------------------------------------- */

export interface SourceExpectationEntry {
  source_ref: SourceRef;
  content_hash: string;
}

type FrozenSourceExpectationResult =
  | { status: "ok"; expectations: SourceExpectationEntry[] }
  | {
      status: "rejected";
      code: "E_SOURCE_UNRETRIEVABLE";
      details: { stage: "expected_source_hashes"; upstream_code?: string; source_ref?: SourceRef };
    };

export interface FrozenSourceExpectationPort {
  resolveExpected(q: {
    binding: VersionBinding;
    refs: readonly SourceRef[];
  }): Promise<FrozenSourceExpectationResult>;
}

type SourceCheckResult =
  | {
      status: "ok";
      results: Array<{ source_ref: SourceRef; retrievable: boolean; content_hash: string | null }>;
    }
  | {
      status: "rejected";
      code: "E_SOURCE_UNRETRIEVABLE" | "E_SOURCE_CHANGED";
      details: { stage: "source_check"; upstream_code?: string; source_ref?: SourceRef };
    };

export interface SourceCheckPort {
  check(q: { binding: VersionBinding; refs: readonly SourceRef[] }): Promise<SourceCheckResult>;
}

/* ------------------------------------------------------------------------- */
/* EVD accepted aggregate read port (DD-QP-05b step 1)                       */
/* ------------------------------------------------------------------------- */

interface PropositionAggregateView {
  proposition_id: string;
  requirement_ids: string[];
  result:
    | "supported_hard"
    | "contradicted_hard"
    | "supported_semantic"
    | "contradicted_semantic"
    | "conflict"
    | "unknown"
    | "missing";
}

export interface AnswerAggregate {
  schema_version: "rsi.answer_aggregate/1";
  aggregate_id: string;
  aggregate_key: string;
  aggregate_hash: string;
  issue_id: string;
  plan_id: string;
  plan_hash: string;
  binding: VersionBinding;
  final_state: "consistent" | "inconsistent" | "satisfied" | "unsatisfied" | "unknown" | "needs_evidence" | "abstain";
  final_basis: "hard_fact" | "mixed" | "semantic_shadow" | null;
  propositions: PropositionAggregateView[];
  request_human_review?: boolean;
}

export interface AnswerAggregateV2 {
  schema_version: "rsi.answer_aggregate/2";
  aggregate_id: string;
  aggregate_key: string;
  aggregate_hash: string;
  issue_id: string;
  plan_id: string;
  plan_hash: string;
  binding: VersionBinding;
  final_state: "consistent" | "inconsistent" | "satisfied" | "unsatisfied" | "unknown" | "needs_evidence" | "abstain";
  final_basis: "hard_fact" | "mixed" | "semantic_shadow" | null;
  propositions: PropositionAggregateView[];
  human_review_candidate?: boolean;
}

export type AcceptedAggregateView = AnswerAggregate | AnswerAggregateV2;

export interface EvdError extends ErrorEnvelope {}

export interface AcceptedAggregateReadRequest {
  aggregate_id: string;
  expected_aggregate_hash: string;
  issue_id: string;
  plan_id: string;
  plan_hash: string;
  binding: VersionBinding;
}

export interface AcceptedAggregateReadPort {
  readAccepted(q: AcceptedAggregateReadRequest): Promise<Result<AcceptedAggregateView, EvdError>>;
}

/* ------------------------------------------------------------------------- */
/* REV handoff read port (DD-REV-071 / DD-QP-06)                             */
/* ------------------------------------------------------------------------- */

export interface ReviewHandoffClosePayload {
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

export interface ReviewHandoffCloseView {
  schema_version: "rsi.review_handoff_close_view/1";
  handoff_id: string;
  issue_id: string;
  job_state: "pending" | "done";
  job_result: "proposed" | "no_candidate" | "all_rejected" | "all_stale" | null;
  binding: VersionBinding | null;
  snapshot_id: string | null;
  snapshot_hash: string | null;
  proposal_id: string | null;
  proposal_hash: string | null;
  plan_id: string | null;
  plan_hash: string | null;
  question_key: string | null;
  decision: "proceed" | "unverified" | null;
  review_match_outcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  close_payload: Omit<ReviewHandoffClosePayload, "close_payload_hash"> | null;
  close_payload_hash: string | null;
  source_refs: SourceRef[];
  recorded_at_watermark: number | null;
}

export interface ReviewHandoffReadPort {
  getHandoffCloseView(q: { handoff_id: string; issue_id: string }): Promise<Result<ReviewHandoffCloseView, ErrorEnvelope>>;
}
