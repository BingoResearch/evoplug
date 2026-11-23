/**
 * FND, HOST, QP and EVD ports consumed by REV (DD-REV-140, DD-REV-170).
 *
 * The commit ABI mirrors the FND `state_row_batch` contract: one synchronous
 * stage callback inside the writer lock, synchronous reads only, and an outer
 * `commit_state`. REV never opens a second transaction or writes a journal.
 */

import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  Tx,
  VersionBinding
} from "@evoplug/core";







import type { ExperienceCandidatePage, ExperienceCandidateQuery, ExperienceLifecycleEvent, ExperienceProjection, Proposal, ProposalCandidateRecord, ReviewAttempt, ReviewHandoff, ReviewJob, ReviewSnapshot, ReviewSnapshotSourcePlan, ReviewSourceFactPage, ReviewSourceFactQuery, UsageVerificationRecord, ValidationPlan } from "./types.js";

/* ------------------------------------------------------------------ */
/* FND commit ABI                                                      */
/* ------------------------------------------------------------------ */

export interface AppendStateRowsResult {
  commit_seq: number;
  batch_hash: Hash;
  member_count: number;
}

export type LiveCommitOutcome<T> =
  | { ok: true; commit_state: "committed"; receipt: AppendStateRowsResult; value: T | null }
  | { ok: true; commit_state: "existing"; value: T | null }
  | { ok: false; commit_state: "not_written"; error: ErrorEnvelope }
  | { ok: false; commit_state: "unknown_recovery_required"; error: ErrorEnvelope };

interface StageStateRowRead<S extends string = string> {
  row_schema: S;
  key: Readonly<Record<string, string>>;
}

export interface StageDocumentKey {
  object_id: string;
  document_kind: string;
}

export interface ObjectDocumentRow {
  object_id: string;
  document_kind: string;
  body_ref: SourceRef;
  version: number;
}

export interface ObjectHeadRow {
  object_id: string;
  version: number;
  head_ref: SourceRef;
}

export interface StageStateRow {
  row_schema: string;
  row_json: JsonValue;
  object_key: string;
  before_hash: Hash | null;
  operation: "insert" | "transition";
  binding?: VersionBinding;
  blob_ref_paths?: string[];
}

/** FND `LiveCommitStage`: read staged objects and register members. */
export interface LiveCommitStage {
  readonly tx: Tx;
  resolveStateRow<S extends string>(input: StageStateRowRead<S>): Result<JsonValue | null, ErrorEnvelope>;
  resolveDocument(input: StageDocumentKey): Result<ObjectDocumentRow | null, ErrorEnvelope>;
  resolveHead(input: { object_id: string }): Result<ObjectHeadRow | null, ErrorEnvelope>;
  stageRows(rows: readonly StageStateRow[]): Result<void, ErrorEnvelope>;
  stageDocuments(documents: readonly JsonValue[]): Result<void, ErrorEnvelope>;
  stageHeads(heads: readonly JsonValue[]): Result<void, ErrorEnvelope>;
  stageOutbox(rows: readonly JsonValue[]): Result<void, ErrorEnvelope>;
  stageBlob(bytes: Uint8Array): Result<SourceRef, ErrorEnvelope>;
}

interface LiveCommitInput<T> {
  binding: VersionBinding | null;
  stage(stage: LiveCommitStage): Result<T, ErrorEnvelope>;
}

export interface StateRowLiveCommitPort {
  commitLiveGated<T>(input: LiveCommitInput<T>): Promise<LiveCommitOutcome<T>>;
}

export interface AppendStateRowsRequest {
  binding: VersionBinding;
  rows: readonly StageStateRow[];
  derived_reducers?: readonly string[];
}

export interface StateRowPort {
  appendStateRows(input: AppendStateRowsRequest): Promise<LiveCommitOutcome<null>>;
}

/* ------------------------------------------------------------------ */
/* FND read ports                                                      */
/* ------------------------------------------------------------------ */

export interface ReviewSourceFactReadPort {
  readFacts(input: ReviewSourceFactQuery): Promise<Result<ReviewSourceFactPage, ErrorEnvelope>>;
  recheckMetadataInTransaction(
    tx: Tx,
    input: ReviewSourceFactQuery,
    prepared: ReviewSourceFactPage
  ): Result<import("./types.js").ReviewSourceMetadataCheck, ErrorEnvelope>;
}

export interface ReviewSnapshotSourceReadPort {
  readSourcePlan(
    input: import("./types.js").ReviewSnapshotSourceQuery
  ): Promise<Result<ReviewSnapshotSourcePlan, ErrorEnvelope>>;
}

export interface ExperienceCandidateReadPort {
  listCandidates(input: ExperienceCandidateQuery): Promise<Result<ExperienceCandidatePage, ErrorEnvelope>>;
}

export interface WriteAdoptionReadPort {
  getAdoptionInTransaction(
    tx: Tx,
    write_id: Id<"wi">
  ): Result<import("./host-contracts.js").WriteAdoptionView, ErrorEnvelope>;
  getAdoption(write_id: Id<"wi">): Promise<Result<import("./host-contracts.js").WriteAdoptionView, ErrorEnvelope>>;
}

export interface HostLifecycleFactsPort {
  readInTransaction(
    tx: Tx,
    input: { host_id: string; config_space: string; mode: string }
  ): Result<import("./budget-contracts.js").HostLifecycleFacts, ErrorEnvelope>;
}

export interface SourceBytesPort {
  read(ref: SourceRef, opts?: { maxBytes?: number }): Promise<Result<Uint8Array, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* REV persistence                                                     */
/* ------------------------------------------------------------------ */

export interface ReviewRepository {
  getSnapshot(snapshot_id: string): Promise<ReviewSnapshot | null>;
  getJob(job_id: string): Promise<ReviewJob | null>;
  getJobByDedupeKey(trigger_dedupe_key: Hash): Promise<ReviewJob | null>;
  getRequest(request_id: string): Promise<{
    request_hash: Hash;
    review_job_id: string;
    result_json: JsonValue;
  } | null>;
  getAttempt(attempt_id: string): Promise<ReviewAttempt | null>;
  /**
   * Existing T3 acceptance point for an attempt, if it was already accepted.
   * Optional: a repository without this read port cannot short-circuit a
   * repeated acceptance, so the caller keeps the non-idempotent behaviour.
   */
  getAcceptance?(attempt_id: string): Promise<import("./storage.js").ReviewOutputAcceptanceRow | null>;
  listAttempts(job_id: string): Promise<ReviewAttempt[]>;
  getCandidates(job_id: string): Promise<ProposalCandidateRecord[]>;
  getCandidateJson(candidate: ProposalCandidateRecord): Promise<JsonValue | null>;
  getProposal(proposal_id: string): Promise<Proposal | null>;
  listProposals(job_id: string): Promise<Proposal[]>;
  getHandoff(handoff_id: string): Promise<ReviewHandoff | null>;
  getHandoffByJob(job_id: string): Promise<ReviewHandoff | null>;
  getProjection(projection_id: string): Promise<ExperienceProjection | null>;
  getProjectionByWriteId(write_id: string): Promise<ExperienceProjection | null>;
  listProjections(experience_id: string, experience_version: number): Promise<ExperienceProjection[]>;
  getValidationPlan(plan_id: string): Promise<ValidationPlan | null>;
  listExperiences(experience_id: string): Promise<import("./types.js").Experience[]>;
  listAdoptedVersions(experience_id: string): Promise<number[]>;
  listUsage(projection_id: string): Promise<UsageVerificationRecord[]>;
  listLifecycleEvents(projection_id: string): Promise<ExperienceLifecycleEvent[]>;
  findClaimableJob(now: number): Promise<ReviewJob | null>;
  listExpiredAttempts(now: number): Promise<ReviewAttempt[]>;
  listJobsInStage(stage: import("./types.js").ReviewJobStage): Promise<ReviewJob[]>;
}

/** Persistence writes; implementations must route each batch through `commit`. */
export interface ReviewWritePort {
  saveSnapshot(snapshot: ReviewSnapshot): Promise<Result<void, ErrorEnvelope>>;
  saveJob(job: ReviewJob, expected_version: number): Promise<Result<void, ErrorEnvelope>>;
  saveAttempt(attempt: ReviewAttempt, expected_row_version: number): Promise<Result<void, ErrorEnvelope>>;
  insertAcceptance(row: import("./storage.js").ReviewOutputAcceptanceRow): Promise<Result<void, ErrorEnvelope>>;
  saveCandidate(
    record: ProposalCandidateRecord,
    expected_row_version: number
  ): Promise<Result<void, ErrorEnvelope>>;
  saveProposal(proposal: Proposal, expected_version: number): Promise<Result<void, ErrorEnvelope>>;
  saveExperience(experience: import("./types.js").Experience): Promise<Result<void, ErrorEnvelope>>;
  saveValidationPlan(plan: ValidationPlan): Promise<Result<void, ErrorEnvelope>>;
  saveHandoff(handoff: ReviewHandoff, body_ref: SourceRef): Promise<Result<void, ErrorEnvelope>>;
  saveProjection(
    projection: ExperienceProjection,
    expected_row_version: number
  ): Promise<Result<void, ErrorEnvelope>>;
  saveUsage(record: UsageVerificationRecord): Promise<Result<void, ErrorEnvelope>>;
  saveLifecycleEvent(
    event: ExperienceLifecycleEvent,
    event_blob: SourceRef
  ): Promise<Result<void, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Aggregate dependencies                                              */
/* ------------------------------------------------------------------ */

