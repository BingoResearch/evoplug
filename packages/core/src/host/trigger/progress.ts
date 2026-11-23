/**
 * ProgressCheckpoint read and write ports (DD-TRG-008, DD-TRG-011).
 *
 * `ProgressCheckpointReadPort` is the EVD-facing read surface. The write entry
 * `ensureProgressCheckpoint` is HOST-internal and is never exported from the
 * package root or exposed over IPC.
 */



import { canonicalHash, isHash } from "../../hash.js";
import type { Hash } from "../../hash.js";
import type { Clock } from "../../clock.js";
import type { Id } from "../../ids.js";
import { type JsonValue, isRecord } from "../../json.js";
import type { SourceRef } from "../../source-ref.js";
import { isSourceRef, type SourceRefPort } from "../../source-ref.js";
import type { NotPromise, Tx } from "../../tx.js";
import type { VersionBinding } from "../../version-binding.js";
import { isVersionBinding } from "../../version-binding.js";
import type { ErrorEnvelope } from "../../errors.js";
import { ok, type Result } from "../../result.js";
import { hostErr, type HostResult } from "../errors.js";
import type {
  ProgressCheckpoint,
  StableBoundaryEvidence,
  StepEffectShadow,
  TaskProcessState,
  TriggerKind,
  TriggerOrigin,
  TriggerReasonCode,
  TriggerScope
} from "../types.js";
import {
  buildObjectDocument,
  buildObjectHead,
  parseJcsColumn,
  progressCheckpointDocumentJson,
  toProgressCheckpointPhysicalRow,
  type HostStateRowAppendPort,
  type LiveCommitOutcome,
  type ProgressCheckpointPhysicalRow
} from "../persistence.js";
import { isSafeNonNegativeInt, isSafePositiveInt, sortedUnique } from "../validation.js";

export const MAX_PROGRESS_CHECKPOINTS = 10_000;

export const MAX_PROGRESS_WATERMARK_SPAN = 1_000_000;

/* ------------------------------------------------------------------ */
/* Read surface                                                        */
/* ------------------------------------------------------------------ */

export interface ListProgressCheckpointsQuery {
  request_id: string;
  binding: VersionBinding;
  from_watermark: number;
  to_watermark: number;
  read_only_history: true;
  deadline_ms: number;
  /**
   * The absolute deadline on the clock's monotonic timeline. When present it
   * is the authority for the timeout; `deadline_ms` is the remaining budget
   * the caller declared.
   */
  deadline_at_monotonic_ms?: number;
  signal?: AbortSignal;
}

export interface ProgressCheckpointReadView {
  schema_version: "rsi.progress_checkpoint_read/1";
  checkpoint_id: Id<"chk">;
  binding: VersionBinding;
  task_process_state: TaskProcessState;
  comparability_key: Hash;
  evidence_digest: Hash;
  baseline_checkpoint_id?: Id<"chk">;
  previous_comparable_checkpoint_id?: Id<"chk">;
  evidence_coverage: "complete" | "partial" | "gap";
  pending_state: "none" | "pending" | "unknown";
  source_refs: readonly SourceRef[];
  created_at: number;
}

type ProgressCheckpointReadErrorCode =
  | "E_PROGRESS_REQUEST"
  | "E_PROGRESS_WINDOW"
  | "E_PROGRESS_HISTORY_MISSING"
  | "E_PROGRESS_LIMIT"
  | "E_PROGRESS_SCOPE_MISMATCH"
  | "E_PROGRESS_DATA"
  | "E_PROGRESS_STORAGE"
  | "E_PROGRESS_DEADLINE"
  | "E_PROGRESS_CANCELLED";

export interface ProgressCheckpointReadError {
  schema_version: "rsi.progress_checkpoint_read_error/1";
  code: ProgressCheckpointReadErrorCode;
  request_id?: string;
  retryable: boolean;
  upstream_code?: string;
  detail_ref?: SourceRef;
  observed_at: number;
}

export interface ProgressCheckpointReadPort {
  listCheckpoints(
    q: ListProgressCheckpointsQuery
  ): Promise<HostResult<readonly ProgressCheckpointReadView[], ProgressCheckpointReadError>>;
}

interface ProgressCheckpointReadDeps {
  withTx<T>(fn: (tx: Tx) => NotPromise<T>): Promise<T>;
  clock: Clock;
}

function readError(
  code: ProgressCheckpointReadErrorCode,
  observedAt: number,
  requestId?: string,
  upstreamCode?: string
): ProgressCheckpointReadError {
  const error: ProgressCheckpointReadError = {
    schema_version: "rsi.progress_checkpoint_read_error/1",
    code,
    retryable: code === "E_PROGRESS_STORAGE" || code === "E_PROGRESS_DEADLINE",
    observed_at: observedAt
  };
  if (requestId !== undefined && requestId.length > 0 && requestId.length <= 128) {
    error.request_id = requestId;
  }
  if (upstreamCode !== undefined) {
    error.upstream_code = upstreamCode;
  }
  return error;
}

/** Shape, scope and window validation for a read request. */
function validateProgressReadQuery(
  value: unknown
): { ok: true; query: ListProgressCheckpointsQuery } | { ok: false; code: "E_PROGRESS_REQUEST" | "E_PROGRESS_WINDOW" } {
  if (!isRecord(value)) {
    return { ok: false, code: "E_PROGRESS_REQUEST" };
  }
  const requestId = value["request_id"];
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    return { ok: false, code: "E_PROGRESS_REQUEST" };
  }
  const binding = value["binding"];
  if (!isVersionBinding(binding)) {
    return { ok: false, code: "E_PROGRESS_REQUEST" };
  }
  if (!isSafePositiveInt(binding.input_epoch) || !isSafeNonNegativeInt(binding.watermark)) {
    return { ok: false, code: "E_PROGRESS_REQUEST" };
  }
  if (value["read_only_history"] !== true) {
    return { ok: false, code: "E_PROGRESS_REQUEST" };
  }
  const deadline = value["deadline_ms"];
  if (!isSafePositiveInt(deadline) || deadline > 600_000) {
    return { ok: false, code: "E_PROGRESS_REQUEST" };
  }
  const from = value["from_watermark"];
  const to = value["to_watermark"];
  if (!isSafeNonNegativeInt(from) || !isSafeNonNegativeInt(to)) {
    return { ok: false, code: "E_PROGRESS_WINDOW" };
  }
  if (from > to || to > binding.watermark) {
    return { ok: false, code: "E_PROGRESS_WINDOW" };
  }
  if (to - from > MAX_PROGRESS_WATERMARK_SPAN) {
    return { ok: false, code: "E_PROGRESS_WINDOW" };
  }
  const query: ListProgressCheckpointsQuery = {
    request_id: requestId,
    binding,
    from_watermark: from,
    to_watermark: to,
    read_only_history: true,
    deadline_ms: deadline
  };
  if (value["signal"] instanceof AbortSignal) {
    query.signal = value["signal"];
  }
  const absoluteDeadline = value["deadline_at_monotonic_ms"];
  if (absoluteDeadline !== undefined) {
    if (!isSafeNonNegativeInt(absoluteDeadline)) {
      return { ok: false, code: "E_PROGRESS_REQUEST" };
    }
    query.deadline_at_monotonic_ms = absoluteDeadline;
  }
  return { ok: true, query };
}

type Row = Record<string, unknown>;

function str(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function num(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function deadlineFrom(clock: Clock, remainingMs: number): number {
  return clock.monotonicNowMs() + remainingMs;
}

function checkDeadline(
  clock: Clock,
  deadline: number,
  signal: AbortSignal | undefined
): ProgressCheckpointReadErrorCode | null {
  if (signal?.aborted === true) {
    return "E_PROGRESS_CANCELLED";
  }
  if (clock.monotonicRemainingMs(deadline) <= 0) {
    return "E_PROGRESS_DEADLINE";
  }
  return null;
}

const CHECKPOINT_SELECT = `
SELECT pc.checkpoint_id, pc.owner AS typed_owner, pc.object_type AS typed_object_type,
       pc.revision AS typed_revision, pc.state AS typed_state,
       pc.checkpoint_kind, pc.task_id, pc.branch_id, pc.input_epoch,
       pc.goal_version, pc.config_version, pc.watermark, pc.trigger_event_id,
       pc.source_event_ref, pc.source_refs_json, pc.content_hash, pc.created_at,
       d.document_id AS document_id, d.owner AS document_owner,
       d.object_type AS document_object_type, d.revision AS document_revision,
       d.schema_version AS document_schema_version,
       d.state AS document_state, d.task_id AS document_task_id,
       d.branch_id AS document_branch_id, d.input_epoch AS document_input_epoch,
       d.goal_version AS document_goal_version,
       d.config_version AS document_config_version,
       d.watermark AS document_watermark, d.content_hash AS document_content_hash,
       d.canonical_json, d.created_at AS document_created_at,
       h.document_id AS head_document_id, h.revision AS head_revision,
       h.state AS head_state, h.content_hash AS head_content_hash
FROM progress_checkpoint pc
LEFT JOIN object_document d
  ON d.object_id = pc.checkpoint_id AND d.revision = pc.revision
 AND d.owner = 'host' AND d.object_type = 'progress_checkpoint'
LEFT JOIN object_head h
  ON h.object_id = pc.checkpoint_id
 AND h.owner = 'host' AND h.object_type = 'progress_checkpoint'`;

/**
 * Production read port. All SQL runs inside one synchronous `withTx` and never
 * writes rows, consumes grants or emits a journal frame.
 */
export function createProgressCheckpointReadPort(deps: ProgressCheckpointReadDeps): ProgressCheckpointReadPort {
  return {
    async listCheckpoints(
      q: ListProgressCheckpointsQuery
    ): Promise<HostResult<readonly ProgressCheckpointReadView[], ProgressCheckpointReadError>> {
      const validation = validateProgressReadQuery(q);
      if (!validation.ok) {
        return hostErr(readError(validation.code, deps.clock.utcNowMs(), q.request_id));
      }
      const query = validation.query;
      const deadline =
        query.deadline_at_monotonic_ms ?? deadlineFrom(deps.clock, query.deadline_ms);
      const pre = checkDeadline(deps.clock, deadline, query.signal);
      if (pre !== null) {
        return hostErr(readError(pre, deps.clock.utcNowMs(), query.request_id));
      }
      const binding = query.binding;
      const scopeParams = [
        binding.task_id,
        binding.branch_id,
        binding.input_epoch,
        binding.goal_version,
        binding.config_version
      ];
      try {
        return await deps.withTx((tx): HostResult<readonly ProgressCheckpointReadView[], ProgressCheckpointReadError> => {
          const history = tx
            .prepare(
              `SELECT 1 FROM progress_checkpoint
               WHERE task_id = ? AND branch_id = ? AND input_epoch = ?
                 AND goal_version = ? AND config_version = ? AND watermark <= ?
               LIMIT 1`
            )
            .all([...scopeParams, binding.watermark]);
          const afterHistory = checkDeadline(deps.clock, deadline, query.signal);
          if (afterHistory !== null) {
            return hostErr(readError(afterHistory, deps.clock.utcNowMs(), query.request_id));
          }
          const rows = tx
            .prepare(
              `${CHECKPOINT_SELECT}
               WHERE pc.task_id = ? AND pc.branch_id = ? AND pc.input_epoch = ?
                 AND pc.goal_version = ? AND pc.config_version = ?
                 AND pc.watermark BETWEEN ? AND ?
               ORDER BY pc.watermark ASC, pc.checkpoint_id COLLATE BINARY ASC
               LIMIT ?`
            )
            .all([...scopeParams, query.from_watermark, query.to_watermark, MAX_PROGRESS_CHECKPOINTS + 1]);
          const afterWindow = checkDeadline(deps.clock, deadline, query.signal);
          if (afterWindow !== null) {
            return hostErr(readError(afterWindow, deps.clock.utcNowMs(), query.request_id));
          }
          if (rows.length > MAX_PROGRESS_CHECKPOINTS) {
            return hostErr(readError("E_PROGRESS_LIMIT", deps.clock.utcNowMs(), query.request_id));
          }
          if (history.length === 0) {
            return hostErr(readError("E_PROGRESS_HISTORY_MISSING", deps.clock.utcNowMs(), query.request_id));
          }
          if (rows.length === 0) {
            return ok([]);
          }
          let predecessor: Row | null = null;
          const firstRow = rows[0];
          if (firstRow !== undefined) {
            const firstWatermark = num(firstRow, "watermark");
            const firstId = str(firstRow, "checkpoint_id");
            if (firstWatermark === null || firstId === null) {
              return hostErr(readError("E_PROGRESS_DATA", deps.clock.utcNowMs(), query.request_id));
            }
            const predecessors = tx
              .prepare(
                `${CHECKPOINT_SELECT}
                 WHERE pc.task_id = ? AND pc.branch_id = ? AND pc.input_epoch = ?
                   AND pc.goal_version = ? AND pc.config_version = ?
                   AND (pc.watermark < ? OR (pc.watermark = ? AND pc.checkpoint_id < ?))
                 ORDER BY pc.watermark DESC, pc.checkpoint_id COLLATE BINARY DESC
                 LIMIT 1`
              )
              .all([...scopeParams, firstWatermark, firstWatermark, firstId]);
            predecessor = predecessors[0] ?? null;
          }
          const afterPredecessor = checkDeadline(deps.clock, deadline, query.signal);
          if (afterPredecessor !== null) {
            return hostErr(readError(afterPredecessor, deps.clock.utcNowMs(), query.request_id));
          }
          const parsed: ProgressCheckpointReadView[] = [];
          const segments: SegmentContext[] = [];
          for (const row of rows) {
            const parsedRow = parseCheckpointRow(row, query.from_watermark, false);
            if (!parsedRow.ok) {
              return hostErr(readError(parsedRow.code, deps.clock.utcNowMs(), query.request_id));
            }
            parsed.push(parsedRow.view);
            segments.push(parsedRow.segment);
          }
          if (predecessor !== null) {
            const predecessorContext = parseCheckpointRow(predecessor, query.from_watermark, true);
            if (!predecessorContext.ok) {
              return hostErr(readError(predecessorContext.code, deps.clock.utcNowMs(), query.request_id));
            }
            segments.unshift(predecessorContext.segment);
          }
          for (let index = 1; index < segments.length; index += 1) {
            const previous = segments[index - 1];
            const current = segments[index];
            if (previous === undefined || current === undefined) {
              return hostErr(readError("E_PROGRESS_DATA", deps.clock.utcNowMs(), query.request_id));
            }
            const shouldBeBaseline = previous.comparability_key !== current.comparability_key;
            const isBaseline = current.task_process_state === "baseline";
            if (shouldBeBaseline !== isBaseline) {
              return hostErr(readError("E_PROGRESS_DATA", deps.clock.utcNowMs(), query.request_id));
            }
            if (
              isBaseline &&
              (current.consecutive_no_info !== 0 ||
                current.span_from_baseline_ms !== 0 ||
                current.has_baseline_ptr ||
                current.has_previous_ptr)
            ) {
              return hostErr(readError("E_PROGRESS_DATA", deps.clock.utcNowMs(), query.request_id));
            }
          }
          if (segments.length === 1 && predecessor === null) {
            const only = segments[0];
            if (only !== undefined && only.task_process_state !== "baseline") {
              return hostErr(readError("E_PROGRESS_DATA", deps.clock.utcNowMs(), query.request_id));
            }
          }
          const afterParse = checkDeadline(deps.clock, deadline, query.signal);
          if (afterParse !== null) {
            return hostErr(readError(afterParse, deps.clock.utcNowMs(), query.request_id));
          }
          return ok(parsed);
        });
      } catch {
        return hostErr(readError("E_PROGRESS_STORAGE", deps.clock.utcNowMs(), q.request_id, "E_IO"));
      }
    }
  };
}

interface SegmentContext {
  comparability_key: string;
  task_process_state: string;
  consecutive_no_info: number;
  span_from_baseline_ms: number;
  has_baseline_ptr: boolean;
  has_previous_ptr: boolean;
}

type ParsedCheckpointRow =
  | { ok: true; view: ProgressCheckpointReadView; segment: SegmentContext }
  | { ok: false; code: ProgressCheckpointReadErrorCode };

function parseCheckpointRow(row: Row, firstWindowWatermark: number, predecessor: boolean): ParsedCheckpointRow {
  const checkpointId = str(row, "checkpoint_id");
  if (checkpointId === null) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (
    str(row, "typed_owner") !== "host" ||
    str(row, "typed_object_type") !== "progress_checkpoint" ||
    num(row, "typed_revision") !== 1 ||
    str(row, "typed_state") !== "recorded" ||
    str(row, "document_state") !== "recorded" ||
    str(row, "head_state") !== "recorded" ||
    num(row, "head_revision") !== 1
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const documentId = str(row, "document_id");
  const contentHash = str(row, "content_hash");
  if (
    documentId === null ||
    documentId !== str(row, "head_document_id") ||
    contentHash === null ||
    contentHash !== str(row, "document_content_hash") ||
    contentHash !== str(row, "head_content_hash")
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const canonicalJson = str(row, "canonical_json");
  if (canonicalJson === null) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const parsedDocument = parseJcsColumn(canonicalJson, "canonical_json");
  if (!parsedDocument.ok || !isRecord(parsedDocument.value)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const document = parsedDocument.value;
  if (canonicalHash(parsedDocument.value) !== contentHash) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (document["schema_version"] !== "rsi.progress_checkpoint/1" || document["checkpoint_id"] !== checkpointId) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const typedWatermark = num(row, "watermark");
  if (
    str(row, "task_id") !== document["task_id"] ||
    str(row, "branch_id") !== document["branch_id"] ||
    num(row, "input_epoch") !== document["input_epoch"] ||
    str(row, "goal_version") !== document["goal_version"] ||
    str(row, "config_version") !== document["config_version"] ||
    typedWatermark !== document["watermark"]
  ) {
    return { ok: false, code: "E_PROGRESS_SCOPE_MISMATCH" };
  }
  if (typedWatermark === null) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (!predecessor) {
    if (typedWatermark < firstWindowWatermark) {
      return { ok: false, code: "E_PROGRESS_SCOPE_MISMATCH" };
    }
  } else if (typedWatermark >= firstWindowWatermark) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (
    num(row, "created_at") !== document["created_at"] ||
    document["trigger_event_id"] !== str(row, "trigger_event_id")
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const comparabilityKey = document["comparability_key"];
  const evidenceDigest = document["evidence_digest"];
  if (typeof comparabilityKey !== "string" || !isHash(comparabilityKey)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (typeof evidenceDigest !== "string" || !isHash(evidenceDigest)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const taskProcessState = document["task_process_state"];
  if (typeof taskProcessState !== "string") {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const evidenceCoverage = document["evidence_coverage"];
  if (evidenceCoverage !== "complete" && evidenceCoverage !== "partial" && evidenceCoverage !== "gap") {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const pendingObservation = document["pending_observation"];
  if (!isRecord(pendingObservation)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const pendingState = pendingObservation["state"];
  if (pendingState !== "none" && pendingState !== "pending" && pendingState !== "unknown") {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const sourceEventRef = str(row, "source_event_ref");
  const sourceRefsJson = str(row, "source_refs_json");
  if (sourceEventRef === null || sourceRefsJson === null) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const parsedRefs = parseJcsColumn(sourceRefsJson, "source_refs_json");
  if (!parsedRefs.ok || !Array.isArray(parsedRefs.value)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const sourceRefs: SourceRef[] = [];
  for (const entry of parsedRefs.value) {
    if (typeof entry !== "string" || !isSourceRef(entry)) {
      return { ok: false, code: "E_PROGRESS_DATA" };
    }
    sourceRefs.push(entry);
  }
  const fields = pendingObservation["fields"];
  const expectedRefs = sortedUnique([
    sourceEventRef,
    ...(Array.isArray(fields) ? collectPresentRefs(fields) : [])
  ]);
  if (
    sourceRefs.length === 0 ||
    sourceRefs.length !== expectedRefs.length ||
    sourceRefs.some((ref, index) => ref !== expectedRefs[index])
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const baselineId = document["baseline_checkpoint_id"];
  const previousId = document["previous_comparable_checkpoint_id"];
  const consecutive = document["consecutive_no_info"];
  const span = document["span_from_baseline_ms"];
  if (!isSafeNonNegativeInt(consecutive) || !isSafeNonNegativeInt(span)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const view: ProgressCheckpointReadView = {
    schema_version: "rsi.progress_checkpoint_read/1",
    checkpoint_id: checkpointId as Id<"chk">,
    binding: {
      task_id: document["task_id"] as Id<"task">,
      branch_id: document["branch_id"] as Id<"br">,
      input_epoch: document["input_epoch"] as number,
      goal_version: document["goal_version"] as string,
      config_version: document["config_version"] as string,
      watermark: typedWatermark
    },
    task_process_state: taskProcessState as TaskProcessState,
    comparability_key: comparabilityKey,
    evidence_digest: evidenceDigest,
    evidence_coverage: evidenceCoverage,
    pending_state: pendingState,
    source_refs: sourceRefs,
    created_at: document["created_at"] as number
  };
  if (typeof baselineId === "string") {
    view.baseline_checkpoint_id = baselineId as Id<"chk">;
  }
  if (typeof previousId === "string") {
    view.previous_comparable_checkpoint_id = previousId as Id<"chk">;
  }
  return {
    ok: true,
    view,
    segment: {
      comparability_key: comparabilityKey,
      task_process_state: taskProcessState,
      consecutive_no_info: consecutive,
      span_from_baseline_ms: span,
      has_baseline_ptr: baselineId !== undefined,
      has_previous_ptr: previousId !== undefined
    }
  };
}

function collectPresentRefs(fields: unknown[]): string[] {
  const refs: string[] = [];
  for (const field of fields) {
    if (isRecord(field) && field["state"] === "present" && typeof field["ref"] === "string") {
      refs.push(field["ref"]);
    }
  }
  return refs;
}

/* ------------------------------------------------------------------ */
/* Write surface                                                       */
/* ------------------------------------------------------------------ */

export type ProgressCheckpointDraft = Omit<ProgressCheckpoint, "checkpoint_id">;

interface EnsureProgressCheckpointRequest {
  request_id: string;
  checkpoint: ProgressCheckpointDraft;
}

interface ProgressCheckpointCommitted {
  schema_version: "rsi.progress_checkpoint_commit/1";
  request_id: string;
  checkpoint_id: Id<"chk">;
  binding: VersionBinding;
  watermark: number;
  trigger_event_id: Id<"trg">;
  checkpoint_kind: "input_boundary" | "stable_boundary";
  created_at: number;
  content_hash: Hash;
  batch_hash: Hash;
  first_commit_seq: number;
  last_commit_seq: number;
  committed: true;
  created: boolean;
}

type ProgressCheckpointEnsureErrorCode =
  | "E_PROGRESS_ENSURE_REQUEST"
  | "E_PROGRESS_ENSURE_CONFLICT"
  | "E_PROGRESS_ENSURE_DATA"
  | "E_PROGRESS_ENSURE_STORAGE"
  | "E_PROGRESS_ENSURE_RECOVERY";

interface ProgressCheckpointEnsureError {
  schema_version: "rsi.progress_checkpoint_ensure_error/1";
  code: ProgressCheckpointEnsureErrorCode;
  request_id?: string;
  retryable: boolean;
  upstream_code?: string;
  detail_ref?: SourceRef;
  observed_at: number;
}

export interface ProgressInputEpochReadPort {
  hasEpoch(tx: Tx, input: { task_id: string; branch_id: string; input_epoch: number }): Result<boolean, ErrorEnvelope>;
}

export interface ProgressCheckpointWriteDeps {
  withTx<T>(fn: (tx: Tx) => NotPromise<T>): Promise<T>;
  clock: Clock;
  sourceRefs: Pick<SourceRefPort, "resolve">;
  inputEpochs: Pick<ProgressInputEpochReadPort, "hasEpoch">;
  allocateCheckpointId: () => Id<"chk">;
  stateRows: Pick<HostStateRowAppendPort, "appendStateRows">;
}

function ensureError(
  code: ProgressCheckpointEnsureErrorCode,
  observedAt: number,
  requestId?: string,
  upstreamCode?: string
): ProgressCheckpointEnsureError {
  const error: ProgressCheckpointEnsureError = {
    schema_version: "rsi.progress_checkpoint_ensure_error/1",
    code,
    retryable: code === "E_PROGRESS_ENSURE_STORAGE",
    observed_at: observedAt
  };
  if (requestId !== undefined && requestId.length > 0 && requestId.length <= 128) {
    error.request_id = requestId;
  }
  if (upstreamCode !== undefined) {
    error.upstream_code = upstreamCode;
  }
  return error;
}

/**
 * The subset of a committed TriggerEvent that `ensureProgressCheckpoint` reads.
 * A full `TriggerEvent` is assignable to it.
 */
export interface ProgressCheckpointTriggerFacts {
  trigger_event_id: Id<"trg">;
  trigger_kind: TriggerKind;
  source_event_ref: SourceRef;
  local_input_id?: string;
  stable_evidence_ref?: SourceRef;
  host_binding: { receipt_seq: number };
  scope: TriggerScope;
  boundary: StableBoundaryEvidence;
  origin: TriggerOrigin;
  decision_reason: TriggerReasonCode;
  decided_at: number;
  /**
   * Frozen event identity read from the committed TriggerEvent's `dedupe`
   * block. Rows written before the draft-hash rule existed do not carry it;
   * such legacy rows skip the hash comparison instead of failing to read.
   */
  source_event_key?: Hash;
}

/**
 * Frozen draft-hash preimage (W2, DD-TRG-008).
 *
 * The hash names exactly the boundary that produced the checkpoint: the
 * committed event identity, the boundary kind and the version binding in
 * force when the boundary was received, including the ledger watermark. It
 * deliberately excludes the decision, the reason and any signal count, so the
 * same stable boundary hashes identically whether admission skipped it or
 * enqueued a review for it.
 */
interface ProgressDraftHashInput {
  event_identity_key: Hash;
  trigger_kind: TriggerKind;
  binding: VersionBinding;
}

function progressDraftHashPreimage(input: ProgressDraftHashInput): JsonValue {
  return {
    event_identity_key: input.event_identity_key,
    trigger_kind: input.trigger_kind,
    binding: {
      task_id: input.binding.task_id,
      branch_id: input.binding.branch_id,
      input_epoch: input.binding.input_epoch,
      goal_version: input.binding.goal_version,
      config_version: input.binding.config_version,
      watermark: input.binding.watermark
    }
  };
}

/** JCS hash of the frozen draft preimage. */
export function computeProgressDraftHash(input: ProgressDraftHashInput): Hash {
  return canonicalHash(progressDraftHashPreimage(input));
}

function bindingOfEventFacts(event: ProgressCheckpointTriggerFacts): VersionBinding {
  return {
    task_id: event.scope.task_id as Id<"task">,
    branch_id: event.scope.branch_id as Id<"br">,
    input_epoch: event.scope.input_epoch,
    goal_version: event.scope.goal_version,
    config_version: event.scope.config_version,
    watermark: event.host_binding.receipt_seq
  };
}

/** True when the draft's five-field scope matches the event scope exactly. */
export function checkpointScopeMatchesTrigger(
  checkpoint: ProgressCheckpointDraft,
  event: ProgressCheckpointTriggerFacts
): boolean {
  return (
    checkpoint.task_id === event.scope.task_id &&
    checkpoint.branch_id === event.scope.branch_id &&
    checkpoint.input_epoch === event.scope.input_epoch &&
    checkpoint.goal_version === event.scope.goal_version &&
    checkpoint.config_version === event.scope.config_version &&
    checkpoint.watermark === event.host_binding.receipt_seq &&
    checkpoint.trigger_event_id === event.trigger_event_id
  );
}

/** Validates the draft against its committed TriggerEvent. */
export function validateProgressCheckpointDraft(
  checkpoint: ProgressCheckpointDraft,
  event: ProgressCheckpointTriggerFacts
): ProgressCheckpointEnsureErrorCode | null {
  if (!isRecord(checkpoint) || checkpoint.schema_version !== "rsi.progress_checkpoint/1") {
    return "E_PROGRESS_ENSURE_REQUEST";
  }
  if (!checkpointScopeMatchesTrigger(checkpoint, event)) {
    return "E_PROGRESS_ENSURE_REQUEST";
  }
  if (checkpoint.created_at !== event.decided_at) {
    return "E_PROGRESS_ENSURE_REQUEST";
  }
  if (!isHash(checkpoint.comparability_key)) {
    return "E_PROGRESS_ENSURE_REQUEST";
  }
  for (const digest of [
    checkpoint.evidence_digest,
    checkpoint.artifact_digest,
    checkpoint.verification_digest,
    checkpoint.information_digest
  ]) {
    if (!isHash(digest)) {
      return "E_PROGRESS_ENSURE_REQUEST";
    }
  }
  if (!isSafeNonNegativeInt(checkpoint.watermark) || !isSafePositiveInt(checkpoint.input_epoch)) {
    return "E_PROGRESS_ENSURE_REQUEST";
  }
  // The information digest freezes the boundary identity. When the committed
  // TriggerEvent carries its `dedupe` block, the draft must hash exactly the
  // event identity, boundary kind and version binding; a checkpoint prepared
  // under another version or with a tampered digest is refused here.
  if (event.source_event_key !== undefined) {
    const expected = computeProgressDraftHash({
      event_identity_key: event.source_event_key,
      trigger_kind: event.trigger_kind,
      binding: bindingOfEventFacts(event)
    });
    if (checkpoint.information_digest !== expected) {
      return "E_PROGRESS_ENSURE_REQUEST";
    }
  }
  if (!validateStepEffectShadow(checkpoint.step_effect_shadow)) {
    return "E_PROGRESS_ENSURE_REQUEST";
  }
  const pendingObservation = checkpoint.pending_observation;
  if (!isValidPendingObservation(pendingObservation)) {
    return "E_PROGRESS_ENSURE_REQUEST";
  }
  // A malformed source reference is a request problem, not a storage
  // failure: it is refused before any blob or row write.
  for (const field of pendingObservation.fields) {
    if (field.state !== "present") {
      continue;
    }
    if (field.ref === undefined || !isSourceRef(field.ref)) {
      return "E_PROGRESS_ENSURE_REQUEST";
    }
  }
  if (checkpoint.checkpoint_kind === "input_boundary") {
    if (event.trigger_kind !== "new_input" || event.local_input_id === undefined) {
      return "E_PROGRESS_ENSURE_REQUEST";
    }
  } else {
    // A committed `session_end` is the host's exit boundary (Claude Code's
    // `SessionEnd`); it keeps its own trigger kind and is written as a
    // `stable_boundary` checkpoint. It is never rewritten as `task_stable`.
    if (
      (event.trigger_kind !== "task_stable" && event.trigger_kind !== "session_end") ||
      event.local_input_id !== undefined
    ) {
      return "E_PROGRESS_ENSURE_REQUEST";
    }
    if (!stableBoundaryAllowsCheckpoint(checkpoint, event)) {
      return "E_PROGRESS_ENSURE_REQUEST";
    }
  }
  return null;
}

function stableBoundaryAllowsCheckpoint(
  checkpoint: ProgressCheckpointDraft,
  event: ProgressCheckpointTriggerFacts
): boolean {
  const boundary = event.boundary;
  if (!boundary.candidate || !boundary.stable || boundary.pending_state !== "none") {
    return false;
  }
  if (boundary.pending_work_refs.length !== 0 || boundary.unstable_reasons.length !== 0) {
    return false;
  }
  if (boundary.stable_watermark !== event.host_binding.receipt_seq) {
    return false;
  }
  if (boundary.goal_version !== checkpoint.goal_version) {
    return false;
  }
  if (boundary.stable_event_ids.length === 0) {
    return false;
  }
  if (new Set(boundary.stable_event_ids).size !== boundary.stable_event_ids.length) {
    return false;
  }
  if (event.stable_evidence_ref === undefined) {
    return false;
  }
  if (event.origin.kind !== "human" && event.origin.kind !== "host_auto") {
    return false;
  }
  if (event.origin.suppress_automatic) {
    return false;
  }
  const forbidden: readonly string[] = [
    "watermark_gap",
    "late_event",
    "origin_unknown",
    "internal_origin",
    "schema_rejected"
  ];
  if (forbidden.includes(event.decision_reason)) {
    return false;
  }
  if (checkpoint.evidence_coverage !== "complete") {
    return false;
  }
  if (event.origin.kind === "human" && event.origin.evidence_ref === undefined) {
    return false;
  }
  return true;
}

/** Validates the closed step-effect shadow combination for a new write. */
export function validateStepEffectShadow(shadow: unknown): shadow is StepEffectShadow {
  if (!isRecord(shadow)) {
    return false;
  }
  const status = shadow["status"];
  if (status !== "not_applicable" && status !== "observed" && status !== "unknown") {
    return false;
  }
  const evidenceRefs = shadow["evidence_refs"];
  if (!Array.isArray(evidenceRefs) || !evidenceRefs.every((ref) => typeof ref === "string")) {
    return false;
  }
  const skipReason = shadow["skip_reason"];
  if (status === "observed") {
    if (skipReason !== undefined || typeof shadow["route_ref"] !== "string" || evidenceRefs.length === 0) {
      return false;
    }
  } else if (
    skipReason !== "deterministic_sufficient" &&
    skipReason !== "evidence_missing" &&
    skipReason !== "not_comparable" &&
    skipReason !== "scope_mismatch" &&
    skipReason !== "backend_disabled" &&
    skipReason !== "budget_blocked"
  ) {
    return false;
  }
  const escalation = shadow["escalation"];
  if (
    escalation !== "none" &&
    escalation !== "retrieval" &&
    escalation !== "semantic" &&
    escalation !== "verification"
  ) {
    return false;
  }
  const stale = shadow["stale"];
  if (stale !== "current" && stale !== "stale") {
    return false;
  }
  const staleReason = shadow["stale_reason"];
  if (stale === "stale") {
    if (status !== "unknown" || staleReason === undefined) {
      return false;
    }
  } else if (staleReason !== undefined) {
    return false;
  }
  const cost = shadow["cost"];
  if (!isRecord(cost)) {
    return false;
  }
  const costStatus = cost["status"];
  if (costStatus !== "observed" && costStatus !== "unknown") {
    return false;
  }
  const elapsedMs = cost["elapsed_ms"];
  const readBytes = cost["read_bytes"];
  const retrievalCount = cost["retrieval_count"];
  const modelInvocations = cost["model_invocations"];
  const verifierInvocations = cost["verifier_invocations"];
  if (
    !isSafeNonNegativeInt(elapsedMs) ||
    !isSafeNonNegativeInt(readBytes) ||
    !isSafeNonNegativeInt(retrievalCount) ||
    !isSafeNonNegativeInt(modelInvocations) ||
    !isSafeNonNegativeInt(verifierInvocations)
  ) {
    return false;
  }
  const cpuMs = cost["cpu_ms"];
  if (cpuMs !== null && !isSafeNonNegativeInt(cpuMs)) {
    return false;
  }
  if (costStatus === "observed" && cost["receipt_ref"] === undefined) {
    return false;
  }
  if (escalation === "retrieval" && retrievalCount < 1) {
    return false;
  }
  if (escalation === "semantic" && modelInvocations < 1) {
    return false;
  }
  if (escalation === "verification" && verifierInvocations < 1) {
    return false;
  }
  return true;
}

function isValidPendingObservation(value: unknown): value is ProgressCheckpointDraft["pending_observation"] {
  if (!isRecord(value)) {
    return false;
  }
  const state = value["state"];
  if (state !== "none" && state !== "pending" && state !== "unknown") {
    return false;
  }
  const fields = value["fields"];
  if (!Array.isArray(fields)) {
    return false;
  }
  return fields.every((field) => {
    if (!isRecord(field) || typeof field["field"] !== "string") {
      return false;
    }
    const fieldState = field["state"];
    if (fieldState !== "none" && fieldState !== "present" && fieldState !== "unknown") {
      return false;
    }
    if (fieldState === "present") {
      const ref = field["ref"];
      return typeof ref === "string" && isSourceRef(ref);
    }
    return field["ref"] === undefined;
  });
}

interface ProgressClassificationInput {
  isFirstComparable: boolean;
  excludedState: TaskProcessState | null;
  pendingUnknown: boolean;
  coverageGap: boolean;
  verifiedRegression: boolean;
  consecutiveNoInfo: number;
  minChecks: 2;
  hasNewVerificationOrClosedIssue: boolean;
  hasOtherNewInformation: boolean;
}

/** Classifies a checkpoint state from computed facts (DD-TRG-008). */
export function classifyTaskProcessState(input: ProgressClassificationInput): TaskProcessState {
  if (input.excludedState !== null) {
    return input.excludedState;
  }
  if (input.isFirstComparable) {
    return "baseline";
  }
  if (input.pendingUnknown || input.coverageGap) {
    return "unknown";
  }
  if (input.verifiedRegression) {
    return "regressing";
  }
  if (input.consecutiveNoInfo >= input.minChecks) {
    return "stalled_candidate";
  }
  if (input.hasNewVerificationOrClosedIssue) {
    return "advancing";
  }
  if (input.hasOtherNewInformation) {
    return "information_gain";
  }
  return "unknown";
}

/** Evidence refs that must be retrievable before a checkpoint is written. */
export function checkpointRequiredRefs(
  checkpoint: ProgressCheckpointDraft,
  event: ProgressCheckpointTriggerFacts
): string[] {
  const refs: string[] = [event.source_event_ref];
  if (event.stable_evidence_ref !== undefined) {
    refs.push(event.stable_evidence_ref);
  }
  for (const field of checkpoint.pending_observation.fields) {
    if (field.state === "present") {
      if (field.ref === undefined) {
        throw new RangeError("present pending field without ref");
      }
      refs.push(field.ref);
    }
  }
  return sortedUnique(refs);
}

type TriggerRead =
  | { ok: true; value: ProgressCheckpointTriggerFacts }
  | { ok: false; code: ProgressCheckpointEnsureErrorCode };

/** Reads and structurally validates the committed TriggerEvent in `tx`. */
function readTriggerEventForCheckpoint(tx: Tx, triggerEventId: Id<"trg">): TriggerRead {
  const rows = tx
    .prepare(
      `SELECT d.canonical_json, d.content_hash
       FROM object_document d
       WHERE d.owner = 'host' AND d.object_type = 'trigger_event' AND d.object_id = ?
       ORDER BY d.revision DESC LIMIT 1`
    )
    .all([triggerEventId]);
  const row = rows[0];
  if (row === undefined) {
    return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
  }
  const canonicalJson = str(row, "canonical_json");
  const contentHash = str(row, "content_hash");
  if (canonicalJson === null || contentHash === null) {
    return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
  }
  const parsed = parseJcsColumn(canonicalJson, "trigger_event.canonical_json");
  if (!parsed.ok || !isRecord(parsed.value) || canonicalHash(parsed.value) !== contentHash) {
    return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
  }
  if (parsed.value["schema_version"] !== "rsi.trigger_event/1") {
    return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
  }
  const facts = parseTriggerEventFacts(parsed.value);
  if (facts === null) {
    return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
  }
  return { ok: true, value: facts };
}

function parseTriggerEventFacts(document: Record<string, JsonValue>): ProgressCheckpointTriggerFacts | null {
  const scope = document["scope"];
  const hostBinding = document["host_binding"];
  const boundary = document["boundary"];
  const origin = document["origin"];
  if (!isRecord(scope) || !isRecord(hostBinding) || !isRecord(boundary) || !isRecord(origin)) {
    return null;
  }
  if (
    typeof document["trigger_event_id"] !== "string" ||
    typeof document["source_event_ref"] !== "string" ||
    !isSourceRef(document["source_event_ref"] as SourceRef)
  ) {
    return null;
  }
  if (typeof document["trigger_kind"] !== "string" || typeof document["decision_reason"] !== "string") {
    return null;
  }
  if (typeof document["review_scope_key"] !== "string" || typeof document["decided_at"] !== "number") {
    return null;
  }
  if (typeof scope["task_id"] !== "string" || typeof scope["branch_id"] !== "string") {
    return null;
  }
  if (typeof scope["input_epoch"] !== "number" || typeof scope["goal_version"] !== "string" || typeof scope["config_version"] !== "string") {
    return null;
  }
  if (typeof hostBinding["receipt_seq"] !== "number") {
    return null;
  }
  if (typeof boundary["stable_watermark"] !== "number" || typeof boundary["goal_version"] !== "string") {
    return null;
  }
  const stableEventIds = boundary["stable_event_ids"];
  const unstableReasons = boundary["unstable_reasons"];
  const pendingWorkRefs = boundary["pending_work_refs"];
  const sourceEventIds = boundary["source_event_ids"];
  if (
    !Array.isArray(stableEventIds) ||
    !stableEventIds.every((entry) => typeof entry === "string") ||
    !Array.isArray(unstableReasons) ||
    !unstableReasons.every((entry) => typeof entry === "string") ||
    !Array.isArray(pendingWorkRefs) ||
    !Array.isArray(sourceEventIds) ||
    !sourceEventIds.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  const pendingState = boundary["pending_state"];
  if (pendingState !== "none" && pendingState !== "pending" && pendingState !== "unknown") {
    return null;
  }
  const boundaryKind = boundary["boundary_kind"];
  if (boundaryKind !== "host_stable_event" && boundaryKind !== "exit" && boundaryKind !== "user_selected" && boundaryKind !== "none") {
    return null;
  }
  const originKind = origin["kind"];
  if (
    originKind !== "human" &&
    originKind !== "host_auto" &&
    originKind !== "evaluator" &&
    originKind !== "evaluator_descendant" &&
    originKind !== "unknown"
  ) {
    return null;
  }
  const parsedPendingWorkRefs = pendingWorkRefs.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["pending_id"] !== "string" ||
      typeof entry["kind"] !== "string" ||
      typeof entry["state"] !== "string" ||
      typeof entry["evidence_ref"] !== "string"
    ) {
      return null;
    }
    return {
      pending_id: entry["pending_id"] as Id<"pen">,
      kind: entry["kind"] as "delivery" | "review_defer" | "generation_resume",
      state: entry["state"],
      evidence_ref: entry["evidence_ref"]
    };
  });
  if (parsedPendingWorkRefs.some((entry) => entry === null)) {
    return null;
  }
  const localInputId = document["local_input_id"];
  const stableEvidenceRef = document["stable_evidence_ref"];
  const facts: ProgressCheckpointTriggerFacts = {
    trigger_event_id: document["trigger_event_id"] as Id<"trg">,
    trigger_kind: document["trigger_kind"] as TriggerKind,
    source_event_ref: document["source_event_ref"] as SourceRef,
    host_binding: { receipt_seq: hostBinding["receipt_seq"] },
    scope: {
      task_id: scope["task_id"],
      branch_id: scope["branch_id"],
      input_epoch: scope["input_epoch"],
      goal_version: scope["goal_version"],
      config_version: scope["config_version"]
    },
    boundary: {
      candidate: boundary["candidate"] === true,
      stable: boundary["stable"] === true,
      boundary_kind: boundaryKind,
      stable_event_ids: stableEventIds,
      source_event_ids: sourceEventIds,
      stable_watermark: boundary["stable_watermark"],
      goal_version: boundary["goal_version"],
      pending_state: pendingState,
      pending_work_refs: parsedPendingWorkRefs.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null
      ),
      unstable_reasons: unstableReasons
    },
    origin: {
      kind: originKind,
      evidence_kind: "none",
      suppress_automatic: origin["suppress_automatic"] === true
    },
    decision_reason: document["decision_reason"] as TriggerReasonCode,
    decided_at: document["decided_at"]
  };
  if (typeof localInputId === "string") {
    facts.local_input_id = localInputId;
  }
  if (stableEvidenceRef !== undefined) {
    if (typeof stableEvidenceRef !== "string" || !isSourceRef(stableEvidenceRef as SourceRef)) {
      return null;
    }
    facts.stable_evidence_ref = stableEvidenceRef as SourceRef;
  }
  if (origin["evidence_ref"] !== undefined) {
    if (typeof origin["evidence_ref"] !== "string" || !isSourceRef(origin["evidence_ref"] as SourceRef)) {
      return null;
    }
    facts.origin.evidence_ref = origin["evidence_ref"];
  }
  const dedupe = document["dedupe"];
  if (dedupe !== undefined) {
    if (!isRecord(dedupe)) {
      return null;
    }
    const sourceEventKey = dedupe["source_event_key"];
    if (typeof sourceEventKey !== "string" || !isHash(sourceEventKey)) {
      return null;
    }
    facts.source_event_key = sourceEventKey;
  }
  return facts;
}

/**
 * Internal write entry. The caller must have committed the TriggerEvent before
 * invoking this function.
 */
export async function ensureProgressCheckpoint(
  deps: ProgressCheckpointWriteDeps,
  request: EnsureProgressCheckpointRequest
): Promise<HostResult<ProgressCheckpointCommitted, ProgressCheckpointEnsureError>> {
  const observedAt = deps.clock.utcNowMs();
  if (
    typeof request.request_id !== "string" ||
    request.request_id.length === 0 ||
    request.request_id.length > 128 ||
    !isRecord(request.checkpoint)
  ) {
    return hostErr(ensureError("E_PROGRESS_ENSURE_REQUEST", observedAt));
  }
  const draft = request.checkpoint;
  const triggerEventId = draft.trigger_event_id;
  if (typeof triggerEventId !== "string" || !triggerEventId.startsWith("trg:")) {
    return hostErr(ensureError("E_PROGRESS_ENSURE_REQUEST", observedAt, request.request_id));
  }

  // Step 4/5: load the committed TriggerEvent and validate the draft first.
  let event: ProgressCheckpointTriggerFacts | null = null;
  try {
    const read = await deps.withTx((tx) => readTriggerEventForCheckpoint(tx, triggerEventId));
    if (!read.ok) {
      return hostErr(ensureError(read.code, observedAt, request.request_id));
    }
    event = read.value;
  } catch {
    return hostErr(ensureError("E_PROGRESS_ENSURE_STORAGE", observedAt, request.request_id, "E_IO"));
  }
  if (event === null) {
    return hostErr(ensureError("E_PROGRESS_ENSURE_DATA", observedAt, request.request_id));
  }
  const triggerFacts = event;
  const validation = validateProgressCheckpointDraft(draft, triggerFacts);
  if (validation !== null) {
    return hostErr(ensureError(validation, observedAt, request.request_id));
  }

  // Step 6: every actual ref must resolve outside the write transaction.
  let requiredRefs: string[];
  try {
    requiredRefs = checkpointRequiredRefs(draft, triggerFacts);
  } catch {
    return hostErr(ensureError("E_PROGRESS_ENSURE_REQUEST", observedAt, request.request_id));
  }
  const shadowRefs: string[] = [...draft.step_effect_shadow.evidence_refs];
  if (draft.step_effect_shadow.route_ref !== undefined) {
    shadowRefs.push(draft.step_effect_shadow.route_ref);
  }
  if (draft.step_effect_shadow.cost?.receipt_ref !== undefined) {
    shadowRefs.push(draft.step_effect_shadow.cost.receipt_ref);
  }
  try {
    for (const ref of [...requiredRefs, ...shadowRefs]) {
      if (!isSourceRef(ref)) {
        return hostErr(ensureError("E_PROGRESS_ENSURE_REQUEST", observedAt, request.request_id));
      }
      const resolved = await deps.sourceRefs.resolve(ref);
      if (!resolved.ok || !resolved.value.retrievable) {
        return hostErr(ensureError("E_PROGRESS_ENSURE_REQUEST", observedAt, request.request_id));
      }
    }
  } catch {
    return hostErr(ensureError("E_PROGRESS_ENSURE_STORAGE", observedAt, request.request_id, "E_IO"));
  }

  // Steps 3/7: idempotency and segment preflight in one read-only snapshot.
  type Preflight =
    | { ok: true; existing: ExistingCheckpoint | null }
    | { ok: false; code: ProgressCheckpointEnsureErrorCode; upstreamCode?: string };
  let preflight: Preflight;
  try {
    preflight = await deps.withTx((tx): Preflight => {
      const existing = readExistingCheckpoint(tx, triggerEventId, draft.checkpoint_kind);
      if (existing !== null) {
        if (!existing.ok) {
          return { ok: false, code: existing.code };
        }
        const incoming = progressCheckpointDocumentJson({
          ...draft,
          checkpoint_id: existing.physical.checkpoint_id
        });
        if (canonicalHash(incoming) !== existing.contentHash) {
          return { ok: false, code: "E_PROGRESS_ENSURE_CONFLICT" };
        }
        return { ok: true, existing };
      }
      const scopeRows = tx
        .prepare(
          `SELECT MAX(watermark) AS max_watermark FROM progress_checkpoint
           WHERE task_id = ? AND branch_id = ? AND input_epoch = ? AND goal_version = ? AND config_version = ?`
        )
        .all([draft.task_id, draft.branch_id, draft.input_epoch, draft.goal_version, draft.config_version]);
      const maxWatermark = num(scopeRows[0] ?? {}, "max_watermark");
      if (maxWatermark !== null && maxWatermark >= draft.watermark) {
        return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
      }
      const latestRows = tx
        .prepare(
          `SELECT pc.checkpoint_id,
                  json_extract(d.canonical_json, '$.comparability_key') AS comparability_key,
                  json_extract(d.canonical_json, '$.task_process_state') AS task_process_state
           FROM progress_checkpoint pc
           JOIN object_document d
             ON d.object_id = pc.checkpoint_id AND d.revision = pc.revision
            AND d.owner = 'host' AND d.object_type = 'progress_checkpoint'
           WHERE pc.task_id = ? AND pc.branch_id = ? AND pc.input_epoch = ?
             AND pc.goal_version = ? AND pc.config_version = ? AND pc.watermark <= ?
           ORDER BY pc.watermark DESC, pc.checkpoint_id COLLATE BINARY DESC
           LIMIT 1`
        )
        .all([draft.task_id, draft.branch_id, draft.input_epoch, draft.goal_version, draft.config_version, draft.watermark]);
      const latest = latestRows[0];
      if (latest === undefined) {
        if (
          draft.task_process_state !== "baseline" ||
          draft.consecutive_no_info !== 0 ||
          draft.span_from_baseline_ms !== 0 ||
          draft.baseline_checkpoint_id !== undefined ||
          draft.previous_comparable_checkpoint_id !== undefined
        ) {
          return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
        }
        const epochCheck = deps.inputEpochs.hasEpoch(tx, {
          task_id: draft.task_id,
          branch_id: draft.branch_id,
          input_epoch: draft.input_epoch
        });
        if (!epochCheck.ok) {
          return { ok: false, code: "E_PROGRESS_ENSURE_STORAGE", upstreamCode: epochCheck.error.code };
        }
        if (!epochCheck.value) {
          return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
        }
        return { ok: true, existing: null };
      }
      const latestComparability = str(latest, "comparability_key");
      if (latestComparability === null) {
        return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
      }
      const segmentRows = tx
        .prepare(
          `SELECT pc.checkpoint_id,
                  json_extract(d.canonical_json, '$.comparability_key') AS comparability_key,
                  json_extract(d.canonical_json, '$.task_process_state') AS task_process_state
           FROM progress_checkpoint pc
           JOIN object_document d
             ON d.object_id = pc.checkpoint_id AND d.revision = pc.revision
            AND d.owner = 'host' AND d.object_type = 'progress_checkpoint'
           WHERE pc.task_id = ? AND pc.branch_id = ? AND pc.input_epoch = ?
             AND pc.goal_version = ? AND pc.config_version = ?
             AND json_extract(d.canonical_json, '$.comparability_key') = ?
           ORDER BY pc.watermark DESC, pc.checkpoint_id COLLATE BINARY DESC`
        )
        .all([
          draft.task_id,
          draft.branch_id,
          draft.input_epoch,
          draft.goal_version,
          draft.config_version,
          latestComparability
        ]);
      const segmentBaseline = segmentRows[segmentRows.length - 1];
      if (segmentBaseline === undefined || str(segmentBaseline, "task_process_state") !== "baseline") {
        return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
      }
      if (latestComparability !== draft.comparability_key) {
        if (
          draft.task_process_state !== "baseline" ||
          draft.consecutive_no_info !== 0 ||
          draft.span_from_baseline_ms !== 0 ||
          draft.baseline_checkpoint_id !== undefined ||
          draft.previous_comparable_checkpoint_id !== undefined
        ) {
          return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
        }
      } else {
        if (draft.task_process_state === "baseline") {
          return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
        }
        if (str(segmentBaseline, "checkpoint_id") !== draft.baseline_checkpoint_id) {
          return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
        }
        if (str(latest, "checkpoint_id") !== draft.previous_comparable_checkpoint_id) {
          return { ok: false, code: "E_PROGRESS_ENSURE_REQUEST" };
        }
      }
      return { ok: true, existing: null };
    });
  } catch {
    return hostErr(ensureError("E_PROGRESS_ENSURE_STORAGE", observedAt, request.request_id, "E_IO"));
  }

  if (!preflight.ok) {
    return hostErr(ensureError(preflight.code, observedAt, request.request_id, preflight.upstreamCode));
  }

  if (preflight.existing !== null) {
    const existing = preflight.existing;
    if (!existing.ok) {
      return hostErr(ensureError(existing.code, observedAt, request.request_id));
    }
    return ok({
      schema_version: "rsi.progress_checkpoint_commit/1",
      request_id: request.request_id,
      checkpoint_id: existing.physical.checkpoint_id,
      binding: {
        task_id: existing.physical.task_id as Id<"task">,
        branch_id: existing.physical.branch_id as Id<"br">,
        input_epoch: existing.physical.input_epoch,
        goal_version: existing.physical.goal_version,
        config_version: existing.physical.config_version,
        watermark: existing.physical.watermark
      },
      watermark: existing.physical.watermark,
      trigger_event_id: existing.physical.trigger_event_id,
      checkpoint_kind: existing.physical.checkpoint_kind,
      created_at: existing.physical.created_at,
      content_hash: existing.physical.content_hash,
      // A replay has no new batch. DD-TRG-011 does not define a receipt field
      // for the original frame, so this zero hash marks "no batch from this
      // call"; callers must not treat it as a retrievable journal frame.
      batch_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      first_commit_seq: 0,
      last_commit_seq: 0,
      committed: true,
      created: false
    });
  }

  // Step 8: allocate once, build the three members, append once.
  const checkpointId = deps.allocateCheckpointId();
  const checkpoint: ProgressCheckpoint = { ...draft, checkpoint_id: checkpointId };
  const binding: VersionBinding = {
    task_id: checkpoint.task_id as Id<"task">,
    branch_id: checkpoint.branch_id as Id<"br">,
    input_epoch: checkpoint.input_epoch,
    goal_version: checkpoint.goal_version,
    config_version: checkpoint.config_version,
    watermark: checkpoint.watermark
  };
  const documentJson = progressCheckpointDocumentJson(checkpoint);
  const physical = toProgressCheckpointPhysicalRow(checkpoint, triggerFacts);
  const document = buildObjectDocument({
    owner: "host",
    object_type: "progress_checkpoint",
    object_id: checkpointId,
    revision: 1,
    schema_version: "rsi.progress_checkpoint/1",
    document: documentJson,
    binding,
    createdAt: checkpoint.created_at
  });
  const head = buildObjectHead({
    owner: "host",
    object_type: "progress_checkpoint",
    object_id: checkpointId,
    revision: 1,
    document: documentJson,
    updated_at: checkpoint.created_at
  });
  let outcome: LiveCommitOutcome<null>;
  try {
    outcome = await deps.stateRows.appendStateRows({
      binding,
      rows: [
        {
          row_schema: "rsi.progress_checkpoint_row/1",
          operation: "insert",
          row: physical,
          document_id: document.document_id
        }
      ],
      documents: [document],
      heads: [head]
    });
  } catch {
    return hostErr(ensureError("E_PROGRESS_ENSURE_STORAGE", observedAt, request.request_id, "E_IO"));
  }

  if (!outcome.ok) {
    if (outcome.commit_state === "unknown_recovery_required") {
      return hostErr(ensureError("E_PROGRESS_ENSURE_RECOVERY", observedAt, request.request_id, outcome.error.code));
    }
    const code = outcome.error.code;
    if (code === "E_IDEMPOTENCY_CONFLICT") {
      return hostErr(ensureError("E_PROGRESS_ENSURE_CONFLICT", observedAt, request.request_id));
    }
    if (code === "E_STATE_ROW_SCHEMA" || code === "E_STATE_ROW_BINDING") {
      return hostErr(ensureError("E_PROGRESS_ENSURE_DATA", observedAt, request.request_id));
    }
    return hostErr(ensureError("E_PROGRESS_ENSURE_STORAGE", observedAt, request.request_id, code));
  }
  if (outcome.commit_state === "existing" || outcome.receipt === undefined) {
    return hostErr(ensureError("E_PROGRESS_ENSURE_DATA", observedAt, request.request_id));
  }
  return ok({
    schema_version: "rsi.progress_checkpoint_commit/1",
    request_id: request.request_id,
    checkpoint_id: checkpointId,
    binding,
    watermark: checkpoint.watermark,
    trigger_event_id: checkpoint.trigger_event_id,
    checkpoint_kind: checkpoint.checkpoint_kind,
    created_at: checkpoint.created_at,
    content_hash: physical.content_hash,
    batch_hash: outcome.receipt.batch_hash,
    first_commit_seq: outcome.receipt.first_commit_seq,
    last_commit_seq: outcome.receipt.last_commit_seq,
    committed: true,
    created: true
  });
}

type ExistingCheckpoint =
  | { ok: true; physical: ProgressCheckpointPhysicalRow; document: JsonValue; contentHash: string }
  | { ok: false; code: ProgressCheckpointEnsureErrorCode };

function readExistingCheckpoint(
  tx: Tx,
  triggerEventId: Id<"trg">,
  checkpointKind: "input_boundary" | "stable_boundary"
): ExistingCheckpoint | null {
  const rows = tx
    .prepare(
      `SELECT pc.checkpoint_id, pc.checkpoint_kind, pc.task_id, pc.branch_id,
              pc.input_epoch, pc.goal_version, pc.config_version, pc.watermark,
              pc.trigger_event_id, pc.source_event_ref, pc.source_refs_json,
              pc.content_hash, pc.created_at,
              d.document_id, d.canonical_json, d.content_hash AS document_content_hash,
              h.document_id AS head_document_id, h.content_hash AS head_content_hash
       FROM progress_checkpoint pc
       LEFT JOIN object_document d
         ON d.object_id = pc.checkpoint_id AND d.revision = pc.revision
        AND d.owner = 'host' AND d.object_type = 'progress_checkpoint'
       LEFT JOIN object_head h
         ON h.object_id = pc.checkpoint_id
        AND h.owner = 'host' AND h.object_type = 'progress_checkpoint'
       WHERE pc.trigger_event_id = ? AND pc.checkpoint_kind = ?
       LIMIT 1`
    )
    .all([triggerEventId, checkpointKind]);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const documentId = str(row, "document_id");
  const canonicalJson = str(row, "canonical_json");
  const contentHash = str(row, "content_hash");
  if (
    documentId === null ||
    canonicalJson === null ||
    contentHash === null ||
    documentId !== str(row, "head_document_id") ||
    contentHash !== str(row, "document_content_hash") ||
    contentHash !== str(row, "head_content_hash")
  ) {
    return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
  }
  const parsed = parseJcsColumn(canonicalJson, "canonical_json");
  if (!parsed.ok || canonicalHash(parsed.value) !== contentHash || !isRecord(parsed.value)) {
    return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
  }
  const document = parsed.value;
  if (
    document["schema_version"] !== "rsi.progress_checkpoint/1" ||
    document["checkpoint_id"] !== str(row, "checkpoint_id") ||
    document["task_id"] !== str(row, "task_id") ||
    document["branch_id"] !== str(row, "branch_id") ||
    document["input_epoch"] !== num(row, "input_epoch") ||
    document["goal_version"] !== str(row, "goal_version") ||
    document["config_version"] !== str(row, "config_version") ||
    document["watermark"] !== num(row, "watermark") ||
    document["trigger_event_id"] !== str(row, "trigger_event_id") ||
    document["checkpoint_kind"] !== str(row, "checkpoint_kind") ||
    document["created_at"] !== num(row, "created_at")
  ) {
    return { ok: false, code: "E_PROGRESS_ENSURE_DATA" };
  }
  const physical: ProgressCheckpointPhysicalRow = {
    checkpoint_id: str(row, "checkpoint_id") as Id<"chk">,
    owner: "host",
    object_type: "progress_checkpoint",
    revision: 1,
    state: "recorded",
    checkpoint_kind: str(row, "checkpoint_kind") as ProgressCheckpointPhysicalRow["checkpoint_kind"],
    task_id: str(row, "task_id") as string,
    branch_id: str(row, "branch_id") as string,
    input_epoch: num(row, "input_epoch") as number,
    goal_version: str(row, "goal_version") as string,
    config_version: str(row, "config_version") as string,
    watermark: num(row, "watermark") as number,
    trigger_event_id: str(row, "trigger_event_id") as Id<"trg">,
    source_event_ref: str(row, "source_event_ref") as SourceRef,
    source_refs_json: str(row, "source_refs_json") as string,
    content_hash: contentHash as Hash,
    created_at: num(row, "created_at") as number
  };
  return { ok: true, physical, document: parsed.value, contentHash };
}
