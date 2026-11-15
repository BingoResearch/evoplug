/**
 * Default HOST progress preparation and the explicit FND append adapter.
 *
 * The checkpoint writer owns validation, idempotency, ordering, source-reference
 * resolution and durable projection. This module only prepares a complete draft
 * from committed facts and adapts the FND state-row port without erasing the
 * difference between admission-free append and live-gated commit.
 */

import type {
  AppendStateRowsRequest,
  Clock,
  ErrorEnvelope,
  Hash,
  Id,
  StateRowLiveCommitPort,
  StateRowPort,
  VersionBinding
} from "@evoplug/core";
import {
  canonicalHash,
  err,
  isHash,
  makeErrorEnvelope,
  newId,
  ok,
  type Result,
  toJsonValue
} from "@evoplug/core";
import type {
  CommittedHostEvent,
  HostTriggerFacts,
  ProgressPipelinePort,
  OnlinePipelineStage
} from "./online-pipeline.js";
import type {
  ProgressCheckpointDraft,
  ProgressCheckpointWriteDeps,
  ProgressInputEpochReadPort,
  TriggerDecision,
  TriggerEvent,
  TriggerPolicy
} from "@evoplug/core/host";
import {
  buildObjectDocument,
  buildObjectHead,
  classifyTaskProcessState,
  ensureProgressCheckpoint,
  toTriggerEventPhysicalRow,
  triggerEventDocumentJson
} from "@evoplug/core/host";
import type {
  HostStateRowAppendInput,
  HostStateRowAppendPort
} from "@evoplug/core/host";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";
import type { SourceRefPort } from "@evoplug/core";
import { createTransactionRunner } from "@evoplug/storage";

function unknownFact(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_EVIDENCE_UNKNOWN",
    category: "source",
    message_key: "error.evidence.unknown",
    stage: "progress_checkpoint" as OnlinePipelineStage,
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function storageFailure(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal.unexpected",
    stage: "progress_checkpoint" as OnlinePipelineStage,
    retryable: false,
    side_effect: "none",
    details: { kind: "internal", incident_id: "progress_producer.storage" }
  });
}

/**
 * Named refusal for a boundary that cannot produce a truthful checkpoint.
 * The rule string is the block reason; no default value is substituted.
 */
function boundaryBlocked(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_EVIDENCE_UNKNOWN",
    category: "source",
    message_key: "error.evidence.unknown",
    stage: "progress_checkpoint" as OnlinePipelineStage,
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Trigger kinds that can carry a committed progress checkpoint. */
const CHECKPOINT_KINDS: ReadonlySet<string> = new Set([
  "new_input",
  "task_stable",
  "session_end"
]);

/**
 * Real stable-boundary kinds. `task_boundary_candidate` (Stop/agent_end) is
 * only a candidate and never produces a stable checkpoint.
 */
const STABLE_BOUNDARY_KINDS: ReadonlySet<string> = new Set([
  "task_stable",
  "session_end"
]);

function integer(row: SqlRow | undefined, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function text(row: SqlRow | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

function bindingFromEvent(event: CommittedHostEvent): VersionBinding {
  return event.binding;
}

function inputEpochs(connection: SqliteConnection): ProgressInputEpochReadPort {
  return {
    hasEpoch(tx, input) {
      try {
        const row = tx
          .prepare(
            `SELECT 1 AS present FROM input
             WHERE task_id = ? AND branch_id = ? AND input_epoch = ?
             LIMIT 1`
          )
          .all([input.task_id, input.branch_id, input.input_epoch])[0];
        return ok(row !== undefined);
      } catch {
        return err(storageFailure());
      }
    }
  };
}

interface PriorCheckpointView {
  readonly latest: {
    readonly checkpoint_id: string;
    readonly comparability_key: Hash | null;
    readonly watermark: number;
  } | null;
  readonly segment_baseline: {
    readonly checkpoint_id: string;
    readonly created_at: number;
  } | null;
}

/**
 * Reads the latest checkpoint in scope and, when it exists, the first
 * checkpoint of that checkpoint's comparability segment. The writer requires
 * `baseline_checkpoint_id` to name the segment baseline and
 * `previous_comparable_checkpoint_id` to name the latest row (DD-TRG-008);
 * both pointers cannot be the same row after the second checkpoint.
 */
function priorCheckpoint(
  connection: SqliteConnection,
  binding: VersionBinding
): PriorCheckpointView {
  const scopeParams = {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version
  };
  const latestRow = connection
    .prepare<SqlRow>(
      `SELECT pc.checkpoint_id, pc.watermark,
              json_extract(d.canonical_json, '$.comparability_key') AS comparability_key
         FROM progress_checkpoint pc
         JOIN object_document d
           ON d.object_id = pc.checkpoint_id
          AND d.revision = pc.revision
          AND d.owner = 'host'
          AND d.object_type = 'progress_checkpoint'
        WHERE pc.task_id = :task_id
          AND pc.branch_id = :branch_id
          AND pc.input_epoch = :input_epoch
          AND pc.goal_version = :goal_version
          AND pc.config_version = :config_version
          AND pc.watermark < :watermark
        ORDER BY pc.watermark DESC, pc.checkpoint_id COLLATE BINARY DESC
        LIMIT 1`
    )
    .get({ ...scopeParams, watermark: binding.watermark });
  const latestId = text(latestRow, "checkpoint_id");
  const latestWatermark = integer(latestRow, "watermark");
  if (latestId === null || latestWatermark === null) {
    return { latest: null, segment_baseline: null };
  }
  const latest: PriorCheckpointView["latest"] = {
    checkpoint_id: latestId,
    comparability_key: text(latestRow, "comparability_key") as Hash | null,
    watermark: latestWatermark
  };
  if (latest.comparability_key === null) {
    return { latest, segment_baseline: null };
  }
  const segmentRow = connection
    .prepare<SqlRow>(
      `SELECT pc.checkpoint_id, pc.created_at
         FROM progress_checkpoint pc
         JOIN object_document d
           ON d.object_id = pc.checkpoint_id
          AND d.revision = pc.revision
          AND d.owner = 'host'
          AND d.object_type = 'progress_checkpoint'
        WHERE pc.task_id = :task_id
          AND pc.branch_id = :branch_id
          AND pc.input_epoch = :input_epoch
          AND pc.goal_version = :goal_version
          AND pc.config_version = :config_version
          AND json_extract(d.canonical_json, '$.comparability_key') = :comparability_key
          AND pc.watermark <= :watermark
        ORDER BY pc.watermark ASC, pc.checkpoint_id COLLATE BINARY ASC
        LIMIT 1`
    )
    .get({
      ...scopeParams,
      comparability_key: latest.comparability_key,
      watermark: binding.watermark
    });
  const segmentId = text(segmentRow, "checkpoint_id");
  const segmentCreatedAt = integer(segmentRow, "created_at");
  return {
    latest,
    segment_baseline:
      segmentId === null || segmentCreatedAt === null
        ? null
        : { checkpoint_id: segmentId, created_at: segmentCreatedAt }
  };
}

function pendingObservation(): ProgressCheckpointDraft["pending_observation"] {
  return {
    state: "none",
    fields: [
      { field: "delivery", state: "none" },
      { field: "review_defer", state: "none" },
      { field: "generation_resume", state: "none" },
      { field: "host_background", state: "none" }
    ]
  };
}

function stepEffectShadow(): ProgressCheckpointDraft["step_effect_shadow"] {
  return {
    status: "not_applicable",
    evidence_refs: [],
    skip_reason: "deterministic_sufficient",
    escalation: "none",
    stale: "current",
    cost: {
      status: "unknown",
      elapsed_ms: 0,
      cpu_ms: null,
      read_bytes: 0,
      retrieval_count: 0,
      model_invocations: 0,
      verifier_invocations: 0
    }
  };
}

/** Prepares a checkpoint from facts already committed by HOST/FND. */
export interface ProgressFactsPort {
  prepare(input: {
    readonly event: CommittedHostEvent;
    readonly trigger: import("@evoplug/core/host").TriggerEvent;
    readonly decision: import("@evoplug/core/host").TriggerDecision;
  }): Promise<Result<ProgressCheckpointDraft, ErrorEnvelope>>;
}

export interface DefaultProgressFactsDeps {
  readonly connection: SqliteConnection;
  readonly now: () => number;
}

interface CheckpointSourceFacts {
  readonly binding: VersionBinding;
  /** Frozen event identity; absent when only a version binding is known. */
  readonly event_identity_key: string | null | undefined;
  readonly trigger: TriggerEvent;
}

function prepareCheckpointDraft(
  deps: DefaultProgressFactsDeps,
  input: CheckpointSourceFacts
): Result<ProgressCheckpointDraft, ErrorEnvelope> {
  const binding = input.binding;
  const trigger = input.trigger;
  if (!CHECKPOINT_KINDS.has(trigger.trigger_kind)) {
    return err(unknownFact("trigger.trigger_kind", "progress_boundary_kind_undefined"));
  }
  if (trigger.host_binding.receipt_seq !== binding.watermark) {
    return err(unknownFact("trigger.host_binding.receipt_seq", "binding_mismatch"));
  }
  if (trigger.source_event_ref.length === 0 || trigger.evidence_refs.length === 0) {
    return err(unknownFact("trigger.evidence_refs", "required_retrievable_evidence_missing"));
  }
  const prior = priorCheckpoint(deps.connection, binding);
  const comparabilityKey = canonicalHash({
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version
  });
  if (prior.latest !== null && prior.latest.comparability_key === null) {
    return err(
      unknownFact("progress_checkpoint.comparability_key", "prior_comparability_key_missing")
    );
  }
  const sameSegment =
    prior.latest !== null && prior.latest.comparability_key === comparabilityKey;
  if (sameSegment && prior.segment_baseline === null) {
    return err(
      unknownFact("progress_checkpoint.baseline_checkpoint_id", "segment_baseline_missing")
    );
  }
  // The writer treats the first row of every comparability segment as the
  // baseline, not only the first row of the whole scope.
  const isFirstComparable = !sameSegment;
  const spanFromBaselineMs =
    sameSegment && prior.segment_baseline !== null
      ? Math.max(0, trigger.decided_at - prior.segment_baseline.created_at)
      : 0;
  const evidenceRefs = [...new Set([trigger.source_event_ref, ...trigger.evidence_refs])].sort();
  const evidenceDigest = canonicalHash(evidenceRefs);
  // No artifact producer exists yet. The constant is explicit instead of
  // hashing an empty set that could be mistaken for an observed result.
  const artifactDigest = canonicalHash({ artifacts: [] });
  const verificationDigest = canonicalHash(
    toJsonValue({
      signals: trigger.signals,
      boundary: trigger.boundary
    })
  );
  // The frozen draft hash: event identity plus boundary kind plus the
  // version binding in force, including the ledger watermark. Decision
  // and reason are deliberately excluded so the same stable boundary is
  // comparable whether admission skipped or enqueued.
  //
  // Callers that hold only a binding (no event draft) cannot name the
  // boundary. They hash the explicit absence instead of inventing an
  // identity; a committed trigger that does carry `dedupe.source_event_key`
  // will then fail the writer's equality check.
  const sourceEventKey = input.event_identity_key;
  const informationDigest = canonicalHash({
    event_identity_key:
      typeof sourceEventKey === "string" && isHash(sourceEventKey) ? sourceEventKey : null,
    trigger_kind: trigger.trigger_kind,
    binding: {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version,
      watermark: binding.watermark
    }
  });
  const state = classifyTaskProcessState({
    isFirstComparable,
    excludedState: null,
    pendingUnknown: trigger.boundary.pending_state === "unknown",
    coverageGap: trigger.boundary.unstable_reasons.length > 0,
    verifiedRegression: false,
    consecutiveNoInfo: 0,
    minChecks: 2,
    hasNewVerificationOrClosedIssue: trigger.signals.length > 0,
    hasOtherNewInformation: evidenceRefs.length > 0
  });
  const checkpointKind = trigger.trigger_kind === "new_input" ? "input_boundary" : "stable_boundary";
  const checkpoint: ProgressCheckpointDraft = {
    schema_version: "rsi.progress_checkpoint/1",
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    trigger_event_id: trigger.trigger_event_id,
    checkpoint_kind: checkpointKind,
    task_process_state: state,
    comparability_key: comparabilityKey,
    requirement_versions: [
      {
        requirement_id: "goal",
        version: binding.goal_version,
        state: "active"
      }
    ],
    evidence_digest: evidenceDigest,
    artifact_digest: artifactDigest,
    verification_digest: verificationDigest,
    information_digest: informationDigest,
    new_information: {
      evidence: evidenceRefs.length,
      artifacts: 0,
      verification: trigger.signals.length,
      requirement_transitions: 0,
      issue_transitions: 0
    },
    consecutive_no_info: 0,
    span_from_baseline_ms: spanFromBaselineMs,
    ...(sameSegment && prior.segment_baseline !== null && prior.latest !== null
      ? {
          baseline_checkpoint_id: prior.segment_baseline
            .checkpoint_id as import("@evoplug/core").Id<"chk">,
          previous_comparable_checkpoint_id: prior.latest
            .checkpoint_id as import("@evoplug/core").Id<"chk">
        }
      : {}),
    pending_observation: pendingObservation(),
    evidence_coverage: trigger.boundary.stable && trigger.boundary.unstable_reasons.length === 0
      ? "complete"
      : "gap",
    step_effect_shadow: stepEffectShadow(),
    policy_ref: trigger.policy_ref,
    created_at: trigger.decided_at
  };
  return ok(checkpoint);
}

export function createDefaultProgressFactsPort(deps: DefaultProgressFactsDeps): ProgressFactsPort {
  return {
    async prepare({ event, trigger }) {
      return prepareCheckpointDraft(deps, {
        binding: bindingFromEvent(event),
        event_identity_key: event.draft?.event_identity_key,
        trigger
      });
    }
  };
}

/** Explicitly adapts the FND append port to the HOST-owned port. */
export function createHostStateRowAppendAdapter(
  port: Pick<StateRowPort, "appendStateRows">
): HostStateRowAppendPort {
  return {
    appendStateRows(input: HostStateRowAppendInput) {
      const request: AppendStateRowsRequest = {
        binding: input.binding,
        rows: input.rows.map((row) => ({
          row_schema: row.row_schema as AppendStateRowsRequest["rows"][number]["row_schema"],
          operation: row.operation,
          row: row.row as AppendStateRowsRequest["rows"][number]["row"],
          document_id: row.document_id
        })),
        documents: input.documents.map((document) => ({
          document_id: document.document_id,
          object_id: document.object_id,
          owner: document.owner,
          object_type: document.object_type,
          schema_version: document.schema_version,
          revision: document.revision,
          state: document.state,
          task_id: document.task_id,
          branch_id: document.branch_id,
          input_epoch: document.input_epoch,
          goal_version: document.goal_version,
          config_version: document.config_version,
          watermark: document.watermark,
          content_hash: document.content_hash,
          canonical_json: document.canonical_json,
          created_at: document.created_at
        })),
        heads: input.heads.map((head) => ({
          object_id: head.object_id,
          owner: head.owner,
          object_type: head.object_type,
          revision: head.revision,
          document_id: head.document_id,
          state: head.state,
          content_hash: head.content_hash,
          row_version: 1,
          updated_at: 0
        }))
      };
      return port.appendStateRows(request);
    }
  };
}

export interface DefaultProgressPipelineDeps extends DefaultProgressFactsDeps {
  readonly source_refs: Pick<SourceRefPort, "resolve">;
  readonly state_rows: HostStateRowAppendPort;
  readonly clock: Clock;
}

/** The single write-dependency assembly shared by both progress entry points. */
function progressWriteDeps(deps: DefaultProgressPipelineDeps): ProgressCheckpointWriteDeps {
  return {
    withTx: createTransactionRunner(deps.connection).withTx,
    clock: deps.clock,
    sourceRefs: deps.source_refs,
    inputEpochs: inputEpochs(deps.connection),
    allocateCheckpointId: () => newId("chk", deps.now()),
    stateRows: deps.state_rows
  };
}

export function createDefaultProgressPipeline(
  deps: DefaultProgressPipelineDeps
): ProgressPipelinePort {
  const facts = createDefaultProgressFactsPort(deps);
  const writeDeps = progressWriteDeps(deps);
  return {
    async ensure(input) {
      const prepared = await facts.prepare(input);
      if (!prepared.ok) return prepared;
      const result = await ensureProgressCheckpoint(writeDeps, {
        request_id: `${input.trigger.trigger_event_id}:progress`,
        checkpoint: prepared.value
      });
      if (!result.ok) {
        return err(unknownFact("progress_checkpoint", result.error.code));
      }
      return ok(result.value);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Stable-boundary progress (W2)                                       */
/* ------------------------------------------------------------------ */

/**
 * Why a stable boundary did not need a checkpoint. These are observed facts,
 * not failures: a candidate boundary, a disabled policy or outstanding work
 * genuinely has no baseline to record.
 */
export type ProgressBoundarySkipReason =
  | "progress_disabled"
  | "trigger_kind_not_stable"
  | "boundary_not_stable"
  | "pending_work_outstanding"
  /**
   * A checkpoint already exists in this scope at the same input watermark.
   * The writer enforces strict watermark monotonicity, so committing a second
   * trigger first would leave an orphan that can never produce a checkpoint.
   */
  | "watermark_not_advanced";

export interface ProgressBoundaryEstablished {
  readonly applicable: true;
  readonly trigger_event_id: Id<"trg">;
  readonly checkpoint_id: Id<"chk">;
  /** Derived from the committed row: `task_process_state === "baseline"`. */
  readonly baseline_established: boolean;
  readonly reused: boolean;
}

export type ProgressBoundaryOutcome =
  | ProgressBoundaryEstablished
  | { readonly applicable: false; readonly reason: ProgressBoundarySkipReason };

export interface ProgressBoundaryInput {
  readonly event: CommittedHostEvent;
  readonly facts: HostTriggerFacts;
  readonly policy: TriggerPolicy;
  readonly decision: TriggerDecision;
  /**
   * TriggerEvent built from the same facts with the real non-enqueue
   * decision. The producer persists it before the checkpoint so the writer
   * can resolve its committed preimage.
   */
  readonly trigger: TriggerEvent;
}

export interface ProgressBoundaryPort {
  ensure(input: ProgressBoundaryInput): Promise<Result<ProgressBoundaryOutcome, ErrorEnvelope>>;
  /**
   * Completes stable-boundary triggers that were committed but never reached a
   * checkpoint (a crash between the two writes). Production duplicates never
   * reach the online runner, so replay alone cannot repair these rows; startup
   * wiring calls this sweep explicitly.
   */
  reconcile?(input?: ProgressBoundaryReconcileInput): Promise<
    Result<ProgressBoundaryReconcileOutcome, ErrorEnvelope>
  >;
}

export interface ProgressBoundaryReconcileInput {
  /** Maximum orphan triggers inspected in one sweep; defaults to 64. */
  readonly limit?: number;
}

export interface ProgressBoundaryReconcileOutcome {
  readonly scanned: number;
  readonly recovered: readonly {
    readonly trigger_event_id: Id<"trg">;
    readonly checkpoint_id: Id<"chk">;
  }[];
  /** An orphan whose watermark is already owned by another checkpoint. */
  readonly superseded: readonly {
    readonly trigger_event_id: Id<"trg">;
    readonly checkpoint_id: Id<"chk">;
  }[];
  /**
   * Frozen facts say this trigger cannot produce a checkpoint
   * (`boundary_not_stable`, `pending_work_outstanding`). No write is due;
   * a composition root may record these without failing readiness.
   */
  readonly skipped: readonly {
    readonly trigger_event_id: Id<"trg">;
    readonly reason: string;
  }[];
  /**
   * Durable state is corrupt or a checkpoint write failed. External input
   * cannot repair these rows, so a composition root must not claim `ready`
   * while this list is non-empty. Non-empty `recovered` / `superseded` do not
   * block readiness; non-empty `unresolved` does.
   */
  readonly unresolved: readonly {
    readonly trigger_event_id: Id<"trg">;
    readonly reason: string;
  }[];
}

export interface DefaultProgressBoundaryDeps extends DefaultProgressPipelineDeps {
  /** Same live-gated writer admission uses; no live grant is required. */
  readonly commit: StateRowLiveCommitPort;
}

function scopeBinding(facts: HostTriggerFacts): VersionBinding {
  return {
    task_id: facts.scope.task_id as Id<"task">,
    branch_id: facts.scope.branch_id as Id<"br">,
    input_epoch: facts.scope.input_epoch,
    goal_version: facts.scope.goal_version,
    config_version: facts.scope.config_version,
    watermark: facts.boundary.stable_watermark
  };
}

function sameBinding(left: VersionBinding, right: VersionBinding): boolean {
  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version &&
    left.watermark === right.watermark
  );
}

interface PersistedBoundaryTrigger {
  readonly trigger_event_id: Id<"trg">;
  readonly decided_at: number;
  readonly decision: string | null;
  readonly decision_reason: string | null;
  readonly reused: boolean;
}

/** Returns the already-committed trigger for one dedupe key, if any. */
function findBoundaryTrigger(
  connection: SqliteConnection,
  triggerDedupeKey: Hash
): PersistedBoundaryTrigger | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT trigger_event_id, decided_at, decision, decision_reason
         FROM trigger_event
        WHERE trigger_dedupe_key = ?
        ORDER BY decided_at ASC, trigger_event_id COLLATE BINARY ASC
        LIMIT 1`
    )
    .get([triggerDedupeKey]);
  const triggerEventId = text(row, "trigger_event_id");
  const decidedAt = integer(row, "decided_at");
  if (triggerEventId === null || decidedAt === null) {
    return null;
  }
  return {
    trigger_event_id: triggerEventId as Id<"trg">,
    decided_at: decidedAt,
    decision: text(row, "decision"),
    decision_reason: text(row, "decision_reason"),
    reused: true
  };
}

/** Returns the checkpoint already committed for one stable trigger, if any. */
function findBoundaryCheckpoint(
  connection: SqliteConnection,
  triggerEventId: Id<"trg">
): { readonly checkpoint_id: Id<"chk">; readonly task_process_state: string | null } | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT pc.checkpoint_id,
              json_extract(d.canonical_json, '$.task_process_state') AS task_process_state
         FROM progress_checkpoint pc
         JOIN object_document d
           ON d.document_id = (
                SELECT document_id FROM object_head WHERE object_id = pc.checkpoint_id
              )
        WHERE pc.trigger_event_id = ?
          AND pc.checkpoint_kind = 'stable_boundary'
        ORDER BY pc.created_at ASC, pc.checkpoint_id COLLATE BINARY ASC
        LIMIT 1`
    )
    .get([triggerEventId]);
  const checkpointId = text(row, "checkpoint_id");
  if (checkpointId === null) return null;
  return {
    checkpoint_id: checkpointId as Id<"chk">,
    task_process_state: text(row, "task_process_state")
  };
}

interface CheckpointAtWatermark {
  readonly checkpoint_id: Id<"chk">;
  readonly trigger_event_id: string;
  readonly task_process_state: string | null;
}

/**
 * Reads the first checkpoint in this version scope at or above the input
 * watermark. The writer accepts only strictly increasing watermarks, so a
 * boundary at or below an existing checkpoint can never own one. This read
 * runs before any trigger commit so the losing boundary leaves no orphan.
 */
function findCheckpointAtOrAboveWatermark(
  connection: SqliteConnection,
  binding: VersionBinding
): CheckpointAtWatermark | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT pc.checkpoint_id, pc.trigger_event_id,
              json_extract(d.canonical_json, '$.task_process_state') AS task_process_state
         FROM progress_checkpoint pc
         LEFT JOIN object_head h ON h.object_id = pc.checkpoint_id
         LEFT JOIN object_document d ON d.document_id = h.document_id
        WHERE pc.task_id = ?
          AND pc.branch_id = ?
          AND pc.input_epoch = ?
          AND pc.goal_version = ?
          AND pc.config_version = ?
          AND pc.watermark >= ?
        ORDER BY pc.watermark ASC, pc.created_at ASC, pc.checkpoint_id COLLATE BINARY ASC
        LIMIT 1`
    )
    .get([
      binding.task_id,
      binding.branch_id,
      binding.input_epoch,
      binding.goal_version,
      binding.config_version,
      binding.watermark
    ]);
  const checkpointId = text(row, "checkpoint_id");
  const triggerEventId = text(row, "trigger_event_id");
  if (checkpointId === null || triggerEventId === null) return null;
  return {
    checkpoint_id: checkpointId as Id<"chk">,
    trigger_event_id: triggerEventId,
    task_process_state: text(row, "task_process_state")
  };
}

interface StoredBoundaryTrigger {
  readonly trigger: TriggerEvent;
  readonly binding: VersionBinding;
}

/**
 * Rebuilds the committed `TriggerEvent` from its frozen document. Recovery
 * reads only bytes this producer already committed; it never re-derives a
 * boundary from live adapter state.
 */
function readStoredBoundaryTrigger(
  connection: SqliteConnection,
  triggerEventId: string
): StoredBoundaryTrigger | null {
  let row: SqlRow | undefined;
  try {
    row = connection
      .prepare<SqlRow>(
        `SELECT d.canonical_json AS canonical_json
           FROM object_document d
          WHERE d.owner = 'host'
            AND d.object_type = 'trigger_event'
            AND d.object_id = ?
          ORDER BY d.revision DESC
          LIMIT 1`
      )
      .get([triggerEventId]);
  } catch {
    return null;
  }
  const canonical = text(row, "canonical_json");
  if (canonical === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return null;
  }
  if (!plainRecord(parsed)) return null;
  const scope = parsed["scope"];
  const hostBinding = parsed["host_binding"];
  const boundary = parsed["boundary"];
  const dedupe = parsed["dedupe"];
  if (
    !plainRecord(scope) ||
    !plainRecord(hostBinding) ||
    !plainRecord(boundary) ||
    !plainRecord(dedupe)
  ) {
    return null;
  }
  const taskId = nonEmptyText(scope["task_id"]);
  const branchId = nonEmptyText(scope["branch_id"]);
  const goalVersion = nonEmptyText(scope["goal_version"]);
  const configVersion = nonEmptyText(scope["config_version"]);
  const inputEpoch = scope["input_epoch"];
  const watermark = hostBinding["receipt_seq"];
  if (
    taskId === null ||
    branchId === null ||
    goalVersion === null ||
    configVersion === null ||
    typeof inputEpoch !== "number" ||
    typeof watermark !== "number" ||
    typeof boundary["candidate"] !== "boolean" ||
    typeof boundary["stable"] !== "boolean" ||
    typeof boundary["pending_state"] !== "string" ||
    !Array.isArray(boundary["pending_work_refs"]) ||
    !Array.isArray(boundary["unstable_reasons"]) ||
    !Array.isArray(parsed["signals"]) ||
    !Array.isArray(parsed["evidence_refs"]) ||
    parsed["schema_version"] !== "rsi.trigger_event/1" ||
    parsed["trigger_event_id"] !== triggerEventId
  ) {
    return null;
  }
  return {
    trigger: {
      schema_version: "rsi.trigger_event/1",
      trigger_event_id: triggerEventId as Id<"trg">,
      trigger_kind: parsed["trigger_kind"],
      source_event_ref: parsed["source_event_ref"],
      raw_event_ref: parsed["raw_event_ref"],
      host_binding: hostBinding,
      policy_ref: parsed["policy_ref"],
      origin: parsed["origin"],
      request_intent: parsed["request_intent"],
      scope,
      identity_quality: parsed["identity_quality"],
      signals: parsed["signals"],
      boundary,
      review_scope_key: parsed["review_scope_key"],
      capability_gate: parsed["capability_gate"],
      dedupe,
      decision: parsed["decision"],
      decision_reason: parsed["decision_reason"],
      policy_snapshot_ref: parsed["policy_snapshot_ref"],
      decision_version: 1,
      decided_at: parsed["decided_at"],
      evidence_refs: parsed["evidence_refs"]
    } as unknown as TriggerEvent,
    binding: {
      task_id: taskId as Id<"task">,
      branch_id: branchId as Id<"br">,
      input_epoch: inputEpoch,
      goal_version: goalVersion,
      config_version: configVersion,
      watermark
    }
  };
}

function recoverySkipReason(trigger: TriggerEvent): ProgressBoundarySkipReason | null {
  if (!STABLE_BOUNDARY_KINDS.has(trigger.trigger_kind)) return "trigger_kind_not_stable";
  if (!trigger.boundary.candidate || !trigger.boundary.stable) return "boundary_not_stable";
  if (
    trigger.boundary.pending_state !== "none" ||
    trigger.boundary.pending_work_refs.length > 0 ||
    trigger.boundary.unstable_reasons.length > 0
  ) {
    return "pending_work_outstanding";
  }
  return null;
}

interface OrphanTriggerRow {
  readonly trigger_event_id: string;
  readonly decided_at: number;
}

/**
 * Committed stable-boundary triggers whose checkpoint write never completed.
 *
 * Excluded here so a bounded sweep cannot be starved by rows that can never
 * be repaired: triggers that already own a checkpoint, and triggers whose
 * version scope already has a checkpoint at or above their watermark (the
 * strict-monotonicity winner). `after` is the keyset cursor; callers must pass
 * the last row of the previous batch so a long history is drained in full.
 */
function orphanStableTriggers(
  connection: SqliteConnection,
  limit: number,
  after?: OrphanTriggerRow
): readonly OrphanTriggerRow[] {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT t.trigger_event_id AS trigger_event_id, t.decided_at AS decided_at
         FROM trigger_event t
        WHERE t.trigger_kind IN ('task_stable', 'session_end')
          AND t.decision <> 'enqueue'
          AND NOT EXISTS (
                SELECT 1 FROM progress_checkpoint pc
                 WHERE pc.trigger_event_id = t.trigger_event_id
                   AND pc.checkpoint_kind = 'stable_boundary'
              )
          AND NOT EXISTS (
                SELECT 1 FROM progress_checkpoint pc2
                 WHERE pc2.task_id = t.task_id
                   AND pc2.branch_id = t.branch_id
                   AND pc2.input_epoch = t.input_epoch
                   AND pc2.goal_version = t.goal_version
                   AND pc2.config_version = t.config_version
                   AND pc2.watermark >= t.watermark
              )
          AND (
                :after_id IS NULL
                OR t.decided_at > :after_decided
                OR (t.decided_at = :after_decided AND t.trigger_event_id > :after_id)
              )
        ORDER BY t.decided_at ASC, t.trigger_event_id COLLATE BINARY ASC
        LIMIT :limit`
    )
    .all({
      limit,
      after_id: after?.trigger_event_id ?? null,
      after_decided: after?.decided_at ?? 0
    });
  const result: OrphanTriggerRow[] = [];
  for (const row of rows) {
    const triggerEventId = text(row, "trigger_event_id");
    const decidedAt = integer(row, "decided_at");
    if (triggerEventId !== null && decidedAt !== null) {
      result.push({ trigger_event_id: triggerEventId, decided_at: decidedAt });
    }
  }
  return result;
}

/**
 * Persists the skip/defer TriggerEvent through the same live-gated writer the
 * admission path uses. Replaying the same dedupe key reuses the committed row
 * instead of minting a second identity for one boundary.
 */
async function commitBoundaryTrigger(
  deps: DefaultProgressBoundaryDeps,
  input: ProgressBoundaryInput,
  trigger: TriggerEvent
): Promise<Result<PersistedBoundaryTrigger, ErrorEnvelope>> {
  const prior = findBoundaryTrigger(deps.connection, trigger.dedupe.trigger_dedupe_key);
  if (prior !== null) {
    if (
      prior.decision !== trigger.decision ||
      prior.decision_reason !== trigger.decision_reason
    ) {
      return err(boundaryBlocked("trigger_event.decision", "prior_trigger_decision_mismatch"));
    }
    return ok(prior);
  }

  const document = triggerEventDocumentJson(trigger);
  const documentRow = buildObjectDocument({
    owner: "host",
    object_type: "trigger_event",
    object_id: trigger.trigger_event_id,
    revision: 1,
    schema_version: "rsi.trigger_event/1",
    document,
    binding: input.event.binding,
    createdAt: trigger.decided_at
  });
  const head = buildObjectHead({
    owner: "host",
    object_type: "trigger_event",
    object_id: trigger.trigger_event_id,
    revision: 1,
    document
  });
  const physical = toTriggerEventPhysicalRow(trigger);

  let outcome: import("@evoplug/core").LiveCommitOutcome<null>;
  try {
    outcome = await deps.commit.commitLiveGated({
      binding: input.event.binding,
      stage: (stage) => {
        const existingDocument = stage.resolveDocument({
          owner: "host",
          object_type: "trigger_event",
          object_id: trigger.trigger_event_id,
          revision: 1
        });
        if (!existingDocument.ok) return existingDocument;
        const existingHead = stage.resolveHead({ object_id: trigger.trigger_event_id });
        if (!existingHead.ok) return existingHead;
        const existing = existingDocument.value;
        if (existing !== null) {
          if (
            existing.canonical_json !== documentRow.canonical_json ||
            existingHead.value === null
          ) {
            return err(boundaryBlocked("trigger_event", "frozen_root_bytes"));
          }
          return ok({ kind: "existing" as const, value: null });
        }
        const stagedRow = stage.stageRows([
          {
            row_schema: "rsi.trigger_event_row/1",
            operation: "insert",
            row: physical,
            document_id: documentRow.document_id
          }
        ]);
        if (!stagedRow.ok) return stagedRow;
        const stagedDocument = stage.stageDocuments([documentRow]);
        if (!stagedDocument.ok) return stagedDocument;
        const stagedHead = stage.stageHeads([
          { ...head, row_version: 1, updated_at: trigger.decided_at }
        ]);
        if (!stagedHead.ok) return stagedHead;
        return ok({ kind: "commit" as const, value: null });
      }
    });
  } catch {
    return err(boundaryBlocked("trigger_event", "live_commit_rejected"));
  }
  if (!outcome.ok) {
    return err(
      boundaryBlocked(
        "trigger_event",
        outcome.commit_state === "unknown_recovery_required"
          ? "live_commit_unknown_recovery"
          : `live_commit_failed:${outcome.error.code}`
      )
    );
  }
  return ok({
    trigger_event_id: trigger.trigger_event_id,
    decided_at: trigger.decided_at,
    decision: trigger.decision,
    decision_reason: trigger.decision_reason,
    reused: false
  });
}

function boundaryApplicability(input: ProgressBoundaryInput): ProgressBoundarySkipReason | null {
  if (!input.policy.progress.enabled) return "progress_disabled";
  if (!STABLE_BOUNDARY_KINDS.has(input.facts.trigger_kind)) return "trigger_kind_not_stable";
  if (!input.facts.boundary.stable) return "boundary_not_stable";
  if (
    input.facts.boundary.pending_state !== "none" ||
    input.facts.boundary.pending_work_refs.length > 0
  ) {
    return "pending_work_outstanding";
  }
  return null;
}

/**
 * Refuses any boundary whose event, facts, trigger draft or version binding
 * disagree. A drifted binding or a trigger rebuilt for another event would
 * otherwise persist a checkpoint under the wrong identity.
 */
function validateBoundaryInput(
  input: ProgressBoundaryInput,
  trigger: TriggerEvent
): ErrorEnvelope | null {
  const { event, facts, decision } = input;
  if (trigger.decision === "enqueue" || decision.decision === "enqueue") {
    return boundaryBlocked("trigger.decision", "enqueue_path_owns_progress");
  }
  if (facts.adapter.event_identity_key !== event.draft.event_identity_key) {
    return boundaryBlocked("facts.adapter.event_identity_key", "event_identity_drift");
  }
  if (!sameBinding(scopeBinding(facts), event.binding)) {
    return boundaryBlocked("facts.scope", "version_drift");
  }
  if (facts.boundary.stable_watermark !== event.receipt.watermark) {
    return boundaryBlocked("facts.boundary.stable_watermark", "watermark_drift");
  }
  if (facts.boundary.goal_version !== event.binding.goal_version) {
    return boundaryBlocked("facts.boundary.goal_version", "goal_version_drift");
  }
  if (
    trigger.trigger_kind !== facts.trigger_kind ||
    trigger.host_binding.receipt_seq !== event.binding.watermark ||
    trigger.decision !== decision.decision ||
    trigger.decision_reason !== decision.reason ||
    trigger.dedupe.source_event_key !== facts.adapter.event_identity_key ||
    !sameBinding(
      {
        task_id: trigger.scope.task_id as Id<"task">,
        branch_id: trigger.scope.branch_id as Id<"br">,
        input_epoch: trigger.scope.input_epoch,
        goal_version: trigger.scope.goal_version,
        config_version: trigger.scope.config_version,
        watermark: trigger.host_binding.receipt_seq
      },
      event.binding
    )
  ) {
    return boundaryBlocked("trigger", "trigger_draft_mismatch");
  }
  return null;
}

/**
 * Produces the baseline checkpoint for a real stable boundary before
 * admission decides anything.
 *
 * On a fresh home no verified signal exists, so automatic admission returns
 * `no_verified_signal` and the post-admission progress hook never runs. This
 * producer writes the same frozen TriggerEvent the decision observed (with its
 * real non-enqueue decision) and then the checkpoint the writer validates
 * against it. It never mints a signal, promotes a capability or changes the
 * admission rules; it only makes the boundary fact durable so the next
 * admitted round has a comparable history.
 */
export function createProgressBoundaryProducer(
  deps: DefaultProgressBoundaryDeps
): ProgressBoundaryPort {
  const factsPort = createDefaultProgressFactsPort(deps);
  const writeDeps = progressWriteDeps(deps);

  return {
    async ensure(input) {
      const skip = boundaryApplicability(input);
      if (skip !== null) {
        return ok({ applicable: false, reason: skip });
      }
      const trigger = input.trigger;
      const invalid = validateBoundaryInput(input, trigger);
      if (invalid !== null) {
        return err(invalid);
      }

      // Strict watermark monotonicity means only one stable boundary per input
      // watermark can own a checkpoint. Decide before persisting the trigger:
      // a committed trigger that cannot get its checkpoint is an orphan, and
      // replaying it fails forever with `E_PROGRESS_ENSURE_REQUEST`.
      const atWatermark = findCheckpointAtOrAboveWatermark(
        deps.connection,
        scopeBinding(input.facts)
      );
      if (atWatermark !== null) {
        const prior = findBoundaryTrigger(deps.connection, trigger.dedupe.trigger_dedupe_key);
        const ownsCheckpoint =
          atWatermark.trigger_event_id === trigger.trigger_event_id ||
          (prior !== null && prior.trigger_event_id === atWatermark.trigger_event_id);
        if (!ownsCheckpoint) {
          return ok({ applicable: false, reason: "watermark_not_advanced" });
        }
        return ok({
          applicable: true,
          trigger_event_id: atWatermark.trigger_event_id as Id<"trg">,
          checkpoint_id: atWatermark.checkpoint_id,
          baseline_established: atWatermark.task_process_state === "baseline",
          reused: true
        });
      }

      const persisted = await commitBoundaryTrigger(deps, input, trigger);
      if (!persisted.ok) return persisted;

      // A reused trigger already owns exactly one stable checkpoint. Read it
      // back instead of re-deriving a snapshot from a history that the first
      // write changed: the second derivation would describe a different
      // segment position and the writer would rightly refuse it as a conflict.
      const committed = findBoundaryCheckpoint(deps.connection, persisted.value.trigger_event_id);
      if (committed !== null) {
        return ok({
          applicable: true,
          trigger_event_id: persisted.value.trigger_event_id,
          checkpoint_id: committed.checkpoint_id,
          baseline_established: committed.task_process_state === "baseline",
          reused: true
        });
      }

      // A reused trigger keeps its original identity and decision time so the
      // writer compares the replay against the exact frozen preimage.
      const effective: TriggerEvent =
        persisted.value.reused &&
        (persisted.value.trigger_event_id !== trigger.trigger_event_id ||
          persisted.value.decided_at !== trigger.decided_at)
          ? {
              ...trigger,
              trigger_event_id: persisted.value.trigger_event_id,
              decided_at: persisted.value.decided_at
            }
          : trigger;

      const prepared = await factsPort.prepare({
        event: input.event,
        trigger: effective,
        decision: input.decision
      });
      if (!prepared.ok) return prepared;

      const written = await ensureProgressCheckpoint(writeDeps, {
        request_id: `${effective.trigger_event_id}:progress`,
        checkpoint: prepared.value
      });
      if (!written.ok) {
        return err(
          boundaryBlocked("progress_checkpoint", `ensure_${written.error.code.toLowerCase()}`)
        );
      }
      return ok({
        applicable: true,
        trigger_event_id: effective.trigger_event_id,
        checkpoint_id: written.value.checkpoint_id,
        baseline_established: prepared.value.task_process_state === "baseline",
        reused: !written.value.created
      });
    },

    async reconcile(input) {
      const limit = Math.min(Math.max(input?.limit ?? 64, 1), 512);
      const recovered: ProgressBoundaryReconcileOutcome["recovered"][number][] = [];
      const superseded: ProgressBoundaryReconcileOutcome["superseded"][number][] = [];
      const skipped: ProgressBoundaryReconcileOutcome["skipped"][number][] = [];
      const unresolved: ProgressBoundaryReconcileOutcome["unresolved"][number][] = [];
      let scanned = 0;
      let after: OrphanTriggerRow | undefined;
      // Drain in keyset batches. Rows that stay skipped or unresolved must not
      // pin the page window and starve later recoverable triggers.
      for (;;) {
        let batch: readonly OrphanTriggerRow[];
        try {
          batch = orphanStableTriggers(deps.connection, limit, after);
        } catch {
          return err(storageFailure());
        }
        if (batch.length === 0) break;
        scanned += batch.length;
        for (const row of batch) {
          const triggerEventId = row.trigger_event_id;
          const id = triggerEventId as Id<"trg">;
          const stored = readStoredBoundaryTrigger(deps.connection, triggerEventId);
          if (stored === null) {
            // The frozen trigger document is missing or malformed. Waiting
            // for external input cannot repair it.
            unresolved.push({ trigger_event_id: id, reason: "trigger_unreadable" });
            continue;
          }
          const { trigger, binding } = stored;
          const skip = recoverySkipReason(trigger);
          if (skip !== null) {
            skipped.push({ trigger_event_id: id, reason: skip });
            continue;
          }
          const atWatermark = findCheckpointAtOrAboveWatermark(deps.connection, binding);
          if (atWatermark !== null) {
            if (atWatermark.trigger_event_id === triggerEventId) {
              recovered.push({
                trigger_event_id: id,
                checkpoint_id: atWatermark.checkpoint_id
              });
            } else {
              superseded.push({
                trigger_event_id: id,
                checkpoint_id: atWatermark.checkpoint_id
              });
            }
            continue;
          }
          const prepared = prepareCheckpointDraft(deps, {
            binding,
            event_identity_key: trigger.dedupe.source_event_key,
            trigger
          });
          if (!prepared.ok) {
            const details = prepared.error.details as unknown as
              | Record<string, unknown>
              | undefined;
            const rule = nonEmptyText(details?.["rule"]);
            unresolved.push({
              trigger_event_id: id,
              reason: `prepare_failed:${prepared.error.code}${
                rule === null ? "" : `:${rule}`
              }`
            });
            continue;
          }
          const written = await ensureProgressCheckpoint(writeDeps, {
            request_id: `${triggerEventId}:progress`,
            checkpoint: prepared.value
          });
          if (!written.ok) {
            // Another writer may have claimed this watermark after the read.
            const winner = findCheckpointAtOrAboveWatermark(deps.connection, binding);
            if (winner !== null) {
              if (winner.trigger_event_id === triggerEventId) {
                recovered.push({
                  trigger_event_id: id,
                  checkpoint_id: winner.checkpoint_id
                });
              } else {
                superseded.push({
                  trigger_event_id: id,
                  checkpoint_id: winner.checkpoint_id
                });
              }
              continue;
            }
            unresolved.push({
              trigger_event_id: id,
              reason: `ensure_${written.error.code.toLowerCase()}`
            });
            continue;
          }
          recovered.push({
            trigger_event_id: id,
            checkpoint_id: written.value.checkpoint_id
          });
        }
        const last = batch[batch.length - 1];
        if (last === undefined) break;
        after = {
          trigger_event_id: last.trigger_event_id,
          decided_at: last.decided_at
        };
        if (batch.length < limit) break;
      }
      return ok({
        scanned,
        recovered,
        superseded,
        skipped,
        unresolved
      });
    }
  };
}
