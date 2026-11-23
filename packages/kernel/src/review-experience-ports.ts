/**
 * Production REV Experience ports (DD-REV-110, DD-REV-111, DD-REV-130,
 * DD-REV-140, DD-REV-150, DD-REV-151).
 *
 * This module owns the `ExperienceCommitPort`, the FND verifier projection and
 * the FND/HOST lifecycle-fact adapters. It intentionally does not edit
 * `review-service.ts`: the review service exposes
 * `createReviewStateRowCommit(...)`, which reuses the same single journal
 * writer and `rsi.state_row_batch/1` frame as the REV write port. That seam is
 * injected here through `journal`, so lifecycle events, blobs, the proposal
 * transition and the derived projection row commit in one SQLite transaction.
 *
 * A lifecycle transition is committed as:
 *   - one `rsi.experience_lifecycle_event_row/1` journal member;
 *   - the frozen event body and (for `host_change`) the frozen host facts as
 *     experience blobs;
 *   - the `experience_projections` after-image materialised inside the same
 *     transaction. The projection is derived, never a journal member.
 *
 * Admission reads (`getAdoption`, goal, HOST facts) happen immediately before
 * the frame is built because the review service owns the journal writer lock.
 * Every unresolved external capability fails closed; none is synthesized.
 */

import { err, ok, newId, toJsonValue, canonicalJson, hashBytes, makeErrorEnvelope } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
  RootIdentityPin,
  SourceRef,
  Tx,
  WriteApplyRequest
} from "@evoplug/core";
import type { IpcHandler, IpcHandlerContext } from "@evoplug/ipc";
import { createWriteAdoptionReadPort, matchPathGlob } from "@evoplug/auth";
import { isAbsolute } from "node:path";
import type { GoalVersionReadPort } from "@evoplug/core";
import {
  blobRef,
  adoptionBindingHash,
  buildAdoptionBinding,
  buildLifecycleEvent,
  confirmedRegressionPredicate,
  concurrentUpdate,
  createInitialProjection,
  disabledProjection,
  evaluateLifecycle,
  experienceHostFactsUnavailable,
  experienceRowFromExperience,
  experienceUsageKeyCollision,
  experienceVerifierBinding,
  expiredPredicate,
  goalUnavailable,
  hostIncompatiblePredicate,
  illegalProjectionTransition,
  lifecycleEventRowFromEvent,
  nextSequence,
  noVerifier,
  projectionRowFromProjection,
  proposalRowFromProposal,
  retainedPredicate,
  revError,
  createRollbackTargetResolver,
  triggerKindForReason,
  usageRowFromRecord,
  validateAdoptionView,
  windowLimit,
  type Experience,
  type ExperienceCommitPort,
  type ExperienceLifecycleEvent,
  type ExperienceProjection,
  type ResolvedRollbackTarget,
  type AuthorizationGrantView,
  type HostLifecycleFacts,
  type HostLifecycleFactsPort,
  type LifecycleAction,
  type Proposal,
  type ReviewRepository,
  type UsageVerificationRecord,
  type ValidationPlan,
  type VerifierRegistryEntry,
  type VerifierRegistryPort,
  type WriteAdoptionReadPort,
  type WriteAdoptionView
} from "@evoplug/review";
import {
  type BlobStore,
  type JournalCommitter,
  type JournalWriter,
  type SqlRow,
  type SqliteConnection
} from "@evoplug/storage";
import { createReviewStateRowCommit } from "./review-service.js";
import type {
  ReviewStateBlobInput,
  ReviewStateRowCommit,
  ReviewStateRowInput
} from "./review-service.js";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** Structural mirror of the review service's private journal handle. */
export interface ReviewExperienceJournal {
  readonly writer: JournalWriter;
  readonly relativePath: string;
  readonly committer: JournalCommitter;
}

/**
 * Async part of FND's adoption read. The concrete view is verified and
 * projected by {@link createExperienceWriteAdoptionPort} because FND's own
 * reader returns its internal `WriteIntent` view, not REV's projected
 * `rsi.write_adoption_view/1` shape.
 */
export interface ReviewExperienceAdoptionSource {
  getAdoption(
    write_id: Id<"wi">
  ): Promise<Result<unknown, ErrorEnvelope>>;
}

/**
 * Typed FND-to-REV rollback seam. The executor owns write-intent validation,
 * grant re-evaluation, filesystem effects, and FND durability. REV only
 * materializes the returned verified adoption view.
 */
export interface ReviewExperienceRollbackExecutor {
  execute(input: {
    readonly operation_id: string;
    readonly source_projection: ExperienceProjection;
    readonly target_projection: ExperienceProjection;
    /**
     * Frozen, chain-validated target from the resolver. Present only when
     * `rollback_target_resolution` is enabled; the executor then builds the
     * FND request from the *source* intent (the write being undone) and uses
     * the resolved snapshot/hashes instead of re-deriving them.
     */
    readonly resolved_target?: ResolvedRollbackTarget;
    readonly grant_id: string;
    readonly now: number;
  }): Promise<Result<WriteAdoptionView, ErrorEnvelope>>;
  /** Marks the REV after-image as durable after FND has been verified. */
  readonly complete?: (input: {
    readonly operation_id: string;
    readonly write_id: Id<"wi">;
  }) => Promise<Result<void, ErrorEnvelope>>;
}

interface ExperienceRootResolveInput {
  readonly root_id: string;
  readonly request_id: string;
  readonly deadline_ms: number;
  readonly signal?: AbortSignal;
}

interface ExperienceRootResolution {
  readonly approved_root: string;
  readonly root_identity_pin: RootIdentityPin;
}

/**
 * Minimal HOST root-resolution port. The shape is structurally compatible
 * with FND's `RootResolver`; an implementation may be synchronous (a registry
 * lookup) or asynchronous (the live-identity resolver).
 */
export interface ExperienceRootResolver {
  resolve(
    input: ExperienceRootResolveInput
  ):
    | Result<ExperienceRootResolution, ErrorEnvelope>
    | Promise<Result<ExperienceRootResolution, ErrorEnvelope>>;
}

interface ReviewExperiencePortOptions {
  readonly connection: SqliteConnection;
  readonly blobStore: BlobStore;
  readonly repository: ReviewRepository;
  /**
   * The journal the review service already opened. Passing `null` keeps every
   * write fail-closed; this module never opens a second writer.
   */
  readonly journal: ReviewExperienceJournal | null;
  readonly now: () => number;
  /** Overrides the commit seam (used by tests and by a different composition). */
  readonly commitRows?: ReviewStateRowCommit;
  readonly writeAdoption?: ReviewExperienceAdoptionSource;
  /** FND managed-write executor used by rollback; absent keeps rollback inert. */
  readonly rollbackExecutor?: ReviewExperienceRollbackExecutor;
  /**
   * Enables deterministic rollback target resolution
   * (`E_ROLLBACK_TARGET_UNRESOLVED` on any broken chain link). Defaults to
   * false so behaviour is unchanged until the flag is turned on.
   */
  readonly rollbackTargetResolutionEnabled?: boolean;
  /**
   * HOST root resolution used only when FND's adoption view cannot carry
   * `intent.approved_root`. The resolved pin must equal the pin recorded on
   * the write intent; the proposal's path is never used as a fallback.
   */
  readonly rootResolver?: ExperienceRootResolver;
  readonly goal?: GoalVersionReadPort;
  readonly hostFacts?: HostLifecycleFactsPort;
  readonly readHostFacts?: (
    projection: ExperienceProjection
  ) => Promise<Result<HostLifecycleFacts, ErrorEnvelope>>;
}

interface ReviewExperiencePortBundle {
  readonly commit: ExperienceCommitPort;
  readonly verifierRegistry: VerifierRegistryPort;
  readonly writeAdoption: WriteAdoptionReadPort;
  readonly hostFacts: HostLifecycleFactsPort;
  readonly readHostFacts: (
    projection: ExperienceProjection
  ) => Promise<Result<HostLifecycleFacts, ErrorEnvelope>>;
}

interface WriteApplyRollbackExecutorOptions {
  readonly connection: SqliteConnection;
  readonly handler: IpcHandler<"write.apply">;
  readonly rootResolver?: ExperienceRootResolver;
  readonly now: () => number;
}

function bridgeError(path: string, rule: string): ErrorEnvelope {
  return revError({
    code: "E_WRITE_STATE",
    stage: "rollback",
    details: { kind: "field", path, rule }
  });
}

function rowString(row: SqlRow | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

function rowNullableString(row: SqlRow | undefined, key: string): string | null | undefined {
  const value = row?.[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function rowJson(row: SqlRow | undefined, key: string): unknown | null {
  const value = rowString(row, key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isBinding(value: unknown): value is ExperienceProjection["adoption_binding"]["version_binding"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["task_id"] === "string" &&
    typeof record["branch_id"] === "string" &&
    typeof record["input_epoch"] === "number" &&
    typeof record["goal_version"] === "string" &&
    typeof record["config_version"] === "string" &&
    typeof record["watermark"] === "number";
}

/**
 * Bridges REV rollback to the already composed FND `write.apply` handler.
 * The handler remains the only owner of grants, snapshots, filesystem effects,
 * journalling and readback. This adapter only reads the frozen source/target
 * rows, invokes that handler, and projects its committed adoption view.
 */
export function createWriteApplyRollbackExecutor(
  options: WriteApplyRollbackExecutorOptions
): ReviewExperienceRollbackExecutor {
  const adoption = createWriteAdoptionReadPort({ connection: options.connection });
  const pendingWriteId = (operationId: string): string => `pending:${operationId}`;

  async function recordPending(input: {
    readonly operation_id: string;
    readonly source_projection_id: string;
    readonly target_projection_id: string;
    readonly target_experience_id: string;
    readonly target_experience_version: number;
    readonly target_snapshot_id: string;
    readonly target_snapshot_hash: string;
    readonly now: number;
  }): Promise<Result<void, ErrorEnvelope>> {
    try {
      options.connection.prepare(
        `INSERT INTO experience_rollback_reconciliation (
           operation_id, fnd_write_id, source_projection_id, target_projection_id,
           target_experience_id, target_experience_version, target_snapshot_id,
           target_snapshot_hash, state, error_code, created_at, updated_at
         ) SELECT
           :operation_id, :fnd_write_id, :source_projection_id, :target_projection_id,
           :target_experience_id, :target_experience_version, :target_snapshot_id,
           :target_snapshot_hash, 'pending_fnd', NULL, :now, :now
         WHERE NOT EXISTS (
           SELECT 1 FROM experience_rollback_reconciliation WHERE operation_id = :operation_id
         )`
      ).run({ ...input, fnd_write_id: pendingWriteId(input.operation_id) });
      return ok(undefined);
    } catch {
      return err(bridgeError("experience_rollback_reconciliation", "migration_or_write_unavailable"));
    }
  }

  async function markFndVerified(
    operationId: string,
    writeId: Id<"wi">,
    now: number
  ): Promise<Result<void, ErrorEnvelope>> {
    try {
      const placeholder = pendingWriteId(operationId);
      const updated = options.connection.prepare(
        `UPDATE experience_rollback_reconciliation
            SET fnd_write_id = :fnd_write_id, state = 'fnd_verified',
                error_code = NULL, updated_at = :updated_at
          WHERE operation_id = :operation_id
            AND state = 'pending_fnd'
            AND fnd_write_id = :placeholder`
      ).run({
        operation_id: operationId,
        fnd_write_id: writeId,
        placeholder,
        updated_at: now
      });
      if (updated.changes === 1) {
        return ok(undefined);
      }
      const existing = options.connection
        .prepare<{ state: string; fnd_write_id: string }>(
          `SELECT state, fnd_write_id
             FROM experience_rollback_reconciliation
            WHERE operation_id = :operation_id`
        )
        .get({ operation_id: operationId });
      if (existing?.state === "fnd_verified" && existing.fnd_write_id === writeId) {
        return ok(undefined);
      }
      return err(bridgeError("experience_rollback_reconciliation", "pending_row_fence_conflict"));
    } catch {
      return err(bridgeError("experience_rollback_reconciliation", "mark_fnd_verified"));
    }
  }

  async function completeReconciliation(
    operationId: string,
    writeId: Id<"wi">,
    now: number
  ): Promise<Result<void, ErrorEnvelope>> {
    try {
      const row = options.connection
        .prepare<{ state: string }>(
          `SELECT state
             FROM experience_rollback_reconciliation
            WHERE operation_id = :operation_id AND fnd_write_id = :fnd_write_id`
        )
        .get({ operation_id: operationId, fnd_write_id: writeId });
      if (row === undefined) {
        return err(bridgeError("experience_rollback_reconciliation", "fnd_verified_row_missing"));
      }
      if (row.state === "rev_committed") {
        return ok(undefined);
      }
      if (row.state !== "fnd_verified") {
        return err(bridgeError("experience_rollback_reconciliation", "fnd_verified_row_missing"));
      }
      const updated = options.connection.prepare(
        `UPDATE experience_rollback_reconciliation
            SET state = 'rev_committed', error_code = NULL, updated_at = :updated_at
          WHERE operation_id = :operation_id AND fnd_write_id = :fnd_write_id
            AND state = 'fnd_verified'`
      ).run({ operation_id: operationId, fnd_write_id: writeId, updated_at: now });
      if (updated.changes !== 1) {
        return err(bridgeError("experience_rollback_reconciliation", "fnd_verified_row_missing"));
      }
      return ok(undefined);
    } catch {
      return err(bridgeError("experience_rollback_reconciliation", "mark_rev_committed"));
    }
  }

  async function discardPending(operationId: string): Promise<void> {
    try {
      options.connection
        .prepare(
          `DELETE FROM experience_rollback_reconciliation
            WHERE operation_id = :operation_id AND state = 'pending_fnd'`
        )
        .run({ operation_id: operationId });
    } catch {
      /* Best effort: a leftover pending row is reconciled separately. */
    }
  }

  /**
   * FND reported a concurrent-modification conflict (`state='conflict'` or
   * `E_CONFLICT`). The rollback neither wrote content nor left a lifecycle
   * change, so the reservation row is removed to keep retries clean. The
   * observed current hash is not exposed by FND's conflict result; the
   * three-way diff ref carries the evidence.
   */
  function rollbackConflictEnvelope(detailRef: SourceRef | null | undefined): ErrorEnvelope {
    return revError({
      code: "E_REVIEW_ROLLBACK_CONFLICT",
      stage: "rollback",
      details: { kind: "none" },
      ...(detailRef === null || detailRef === undefined ? {} : { detail_ref: detailRef })
    });
  }

  async function executeResolved(
    input: {
      readonly operation_id: string;
      readonly source_projection: ExperienceProjection;
      readonly grant_id: string;
      readonly now: number;
    },
    resolved: ResolvedRollbackTarget
  ): Promise<Result<WriteAdoptionView, ErrorEnvelope>> {
    const sourceWriteId = input.source_projection.write.write_id;
    if (sourceWriteId === undefined) {
      return err(bridgeError("projection.write.write_id", "required"));
    }
    if (resolved.write_mode !== "whole_file") {
      /* FND `write.apply` rollback is whole-file only. */
      return err(
        makeErrorEnvelope({
          code: "E_WRITE_ROLLBACK_TARGET" as ErrorEnvelope["code"],
          category: "conflict",
          message_key: "error.write.rollback_target",
          stage: "rollback",
          retryable: false,
          side_effect: "none",
          details: { kind: "field", path: "write_mode", rule: "whole_file" }
        })
      );
    }
    const sourceIntent = options.connection
      .prepare<SqlRow>("SELECT * FROM write_intent WHERE write_id = :write_id")
      .get({ write_id: sourceWriteId });
    if (sourceIntent === undefined) {
      return err(bridgeError("write_intent", "source_required"));
    }
    const scopeKind = rowString(sourceIntent, "scope_kind");
    const scopeRefId = rowString(sourceIntent, "scope_ref_id");
    const rootId = rowString(sourceIntent, "root_id");
    const targetPath = rowString(sourceIntent, "target_path");
    const objectType = rowString(sourceIntent, "object_type");
    const candidateId = rowString(sourceIntent, "candidate_id");
    const candidateHash = rowString(sourceIntent, "candidate_hash");
    const writeMode = rowString(sourceIntent, "write_mode");
    const unattendedPolicy = rowString(sourceIntent, "unattended_policy");
    const binding = rowJson(sourceIntent, "binding_json");
    if (
      (scopeKind !== "task" && scopeKind !== "session") ||
      scopeRefId === null || rootId === null || targetPath === null ||
      (objectType !== "skill" && objectType !== "memory" && objectType !== "instructions") ||
      candidateId === null || candidateHash === null ||
      writeMode !== "whole_file" ||
      (unattendedPolicy !== "auto_allowed" && unattendedPolicy !== "pending_approval" &&
        unattendedPolicy !== "rsi_managed_file_only") ||
      !isBinding(binding)
    ) {
      return err(bridgeError("write_intent", "rollback_fields"));
    }

    const pending = await recordPending({
      operation_id: input.operation_id,
      source_projection_id: input.source_projection.projection_id,
      target_projection_id: resolved.target_projection.projection_id,
      target_experience_id: resolved.target_projection.experience_id,
      target_experience_version: resolved.target_version,
      target_snapshot_id: resolved.snapshot_id,
      target_snapshot_hash: resolved.snapshot_hash,
      now: input.now
    });
    if (!pending.ok) return pending;

    const request: WriteApplyRequest = {
      schema_version: "rsi.write_apply/1",
      deadline_ms: 60_000,
      grant_id: input.grant_id,
      action: "rollback",
      object_type: objectType,
      candidate_id: candidateId,
      candidate_hash: candidateHash as Hash,
      binding,
      scope_ref: scopeKind === "task"
        ? { kind: "task", task_id: scopeRefId }
        : { kind: "session", session_id: scopeRefId },
      root_id: rootId,
      target_path: targetPath,
      write_mode: "whole_file",
      block_action: null,
      block_selector: null,
      expected_file_hash: resolved.expected_current_file_hash,
      expected_block_hash: null,
      new_content: null,
      new_content_hash: null,
      rollback_of_write_id: sourceWriteId as Id<"wi">,
      target_snapshot_id: resolved.snapshot_id as Id<"wsnap">,
      target_snapshot_hash: resolved.snapshot_hash,
      unattended_policy: unattendedPolicy
    };
    const context: IpcHandlerContext<"write.apply"> = {
      request_id: newId("ipc", input.now),
      method: "write.apply",
      params: request,
      client_id: newId("adp", input.now),
      connection_id: input.operation_id,
      remaining_ms: request.deadline_ms,
      signal: new AbortController().signal
    };
    const applied = await options.handler(context);
    if (!applied.ok) {
      /* A conflict and any deterministic `side_effect=none` rejection prove
       * FND wrote nothing, so the pending reservation must not survive: if it
       * did, startup would mark it `recovery_required` and permanently refuse
       * the retry. Unknown or partial side effects keep the row for recovery. */
      if (applied.error.code === "E_CONFLICT" || applied.error.side_effect === "none") {
        await discardPending(input.operation_id);
      }
      if (applied.error.code === "E_CONFLICT") {
        return err(rollbackConflictEnvelope(null));
      }
      return err(applied.error);
    }
    if (applied.value.state === "conflict") {
      await discardPending(input.operation_id);
      return err(rollbackConflictEnvelope(applied.value.three_way_diff_ref as SourceRef | null));
    }
    if (applied.value.state !== "verified" || !applied.value.readback_verified) {
      return err(bridgeError("write.apply.result", "verified_readback_required"));
    }
    /* Post-execution readback must equal the target version's frozen content. */
    if (applied.value.new_file_hash !== resolved.restored_file_hash) {
      return err(bridgeError("write.apply.result.new_file_hash", "restored_hash_mismatch"));
    }
    if (
      resolved.restored_block_hash !== null &&
      applied.value.new_block_hash !== resolved.restored_block_hash
    ) {
      return err(bridgeError("write.apply.result.new_block_hash", "restored_hash_mismatch"));
    }
    const appliedWriteId = applied.value.write_id as Id<"wi">;
    const marked = await markFndVerified(input.operation_id, appliedWriteId, input.now);
    if (!marked.ok) return marked;
    const read = await adoption.getAdoption(appliedWriteId);
    if (!read.ok) return err(read.error);
    return projectAdoptionView(read.value, options.rootResolver);
  }

  return {
    async execute(input) {
      if (input.resolved_target !== undefined) {
        return executeResolved(input, input.resolved_target);
      }
      const sourceWriteId = input.source_projection.write.write_id;
      const targetWriteId = input.target_projection.write.write_id;
      if (sourceWriteId === undefined || targetWriteId === undefined) {
        return err(bridgeError("projection.write.write_id", "required"));
      }
      const sourceIntent = options.connection
        .prepare<SqlRow>("SELECT * FROM write_intent WHERE write_id = :write_id")
        .get({ write_id: sourceWriteId });
      const targetIntent = options.connection
        .prepare<SqlRow>("SELECT * FROM write_intent WHERE write_id = :write_id")
        .get({ write_id: targetWriteId });
      if (sourceIntent === undefined || targetIntent === undefined) {
        return err(bridgeError("write_intent", "source_and_target_required"));
      }

      const scopeKind = rowString(targetIntent, "scope_kind");
      const scopeRefId = rowString(targetIntent, "scope_ref_id");
      const rootId = rowString(targetIntent, "root_id");
      const targetPath = rowString(targetIntent, "target_path");
      const objectType = rowString(targetIntent, "object_type");
      const candidateId = rowString(targetIntent, "candidate_id");
      const candidateHash = rowString(targetIntent, "candidate_hash");
      const writeMode = rowString(targetIntent, "write_mode");
      const unattendedPolicy = rowString(targetIntent, "unattended_policy");
      const binding = rowJson(targetIntent, "binding_json");
      const grantId = input.grant_id;
      if (
        (scopeKind !== "task" && scopeKind !== "session") ||
        scopeRefId === null || rootId === null || targetPath === null ||
        (objectType !== "skill" && objectType !== "memory" && objectType !== "instructions") ||
        candidateId === null || candidateHash === null ||
        (writeMode !== "whole_file" && writeMode !== "managed_block") ||
        (unattendedPolicy !== "auto_allowed" && unattendedPolicy !== "pending_approval" &&
          unattendedPolicy !== "rsi_managed_file_only") ||
        !isBinding(binding)
      ) {
        return err(bridgeError("write_intent", "rollback_fields"));
      }

      const expectedFileHash = input.source_projection.write.written_file_hash;
      if (expectedFileHash === undefined) {
        return err(bridgeError("projection.write.written_file_hash", "required"));
      }
      const expectedBlockHash = input.source_projection.write.written_block_hash ?? null;
      const blockSelector = rowNullableString(targetIntent, "block_selector");
      const blockActionValue = rowNullableString(targetIntent, "block_action");
      if (blockSelector === undefined || blockActionValue === undefined) {
        return err(bridgeError("write_intent.block_action", "shape"));
      }
      const blockAction = blockActionValue === null
        ? null
        : blockActionValue === "update" || blockActionValue === "attach" || blockActionValue === "detach"
          ? blockActionValue
          : null;
      if (blockActionValue !== null && blockAction === null) {
        return err(bridgeError("write_intent.block_action", "known_value"));
      }

      const targetResult = options.connection
        .prepare<SqlRow>(
          `SELECT snapshot_id, state, readback_verified
             FROM write_result
            WHERE write_id = :write_id
            ORDER BY attempt DESC LIMIT 1`
        )
        .get({ write_id: targetWriteId });
      const targetSnapshotId = rowString(targetResult, "snapshot_id");
      const targetState = rowString(targetResult, "state");
      const readback = targetResult?.["readback_verified"];
      if (targetSnapshotId === null || targetState !== "verified" || readback !== 1) {
        return err(bridgeError("target_write", "verified_readback_required"));
      }
      const targetSnapshot = options.connection
        .prepare<SqlRow>(
          "SELECT snapshot_hash, write_id FROM write_snapshot WHERE snapshot_id = :snapshot_id"
        )
        .get({ snapshot_id: targetSnapshotId });
      const targetSnapshotHash = rowString(targetSnapshot, "snapshot_hash");
      if (targetSnapshotHash === null || rowString(targetSnapshot, "write_id") !== targetWriteId) {
        return err(bridgeError("target_snapshot", "owned_and_hashed"));
      }
      const pending = await recordPending({
        operation_id: input.operation_id,
        source_projection_id: input.source_projection.projection_id,
        target_projection_id: input.target_projection.projection_id,
        target_experience_id: input.target_projection.experience_id,
        target_experience_version: input.target_projection.experience_version,
        target_snapshot_id: targetSnapshotId,
        target_snapshot_hash: targetSnapshotHash,
        now: input.now
      });
      if (!pending.ok) return pending;

      const request: WriteApplyRequest = {
        schema_version: "rsi.write_apply/1",
        deadline_ms: 60_000,
        grant_id: grantId,
        action: "rollback",
        object_type: objectType,
        candidate_id: candidateId,
        candidate_hash: candidateHash as Hash,
        binding,
        scope_ref: scopeKind === "task"
          ? { kind: "task", task_id: scopeRefId }
          : { kind: "session", session_id: scopeRefId },
        root_id: rootId,
        target_path: targetPath,
        write_mode: writeMode,
        block_action: writeMode === "managed_block" ? blockAction : null,
        block_selector: writeMode === "managed_block" ? blockSelector : null,
        expected_file_hash: expectedFileHash,
        expected_block_hash: writeMode === "managed_block" ? expectedBlockHash : null,
        new_content: null,
        new_content_hash: null,
        rollback_of_write_id: sourceWriteId as Id<"wi">,
        target_snapshot_id: targetSnapshotId as Id<"wsnap">,
        target_snapshot_hash: targetSnapshotHash as Hash,
        unattended_policy: unattendedPolicy
      };
      const context: IpcHandlerContext<"write.apply"> = {
        request_id: newId("ipc", input.now),
        method: "write.apply",
        params: request,
        client_id: newId("adp", input.now),
        connection_id: input.operation_id,
        remaining_ms: request.deadline_ms,
        signal: new AbortController().signal
      };
      const applied = await options.handler(context);
      if (!applied.ok) return err(applied.error);
      if (applied.value.state !== "verified" || !applied.value.readback_verified) {
        return err(bridgeError("write.apply.result", "verified_readback_required"));
      }
      const appliedWriteId = applied.value.write_id as Id<"wi">;
      const marked = await markFndVerified(input.operation_id, appliedWriteId, input.now);
      if (!marked.ok) return marked;
      const read = await adoption.getAdoption(appliedWriteId);
      if (!read.ok) return err(read.error);
      return projectAdoptionView(read.value, options.rootResolver);
    },
    complete: async (input) => completeReconciliation(input.operation_id, input.write_id, options.now())
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function objectRow(value: unknown): Record<string, JsonValue> {
  const converted = toJsonValue(value);
  if (typeof converted !== "object" || converted === null || Array.isArray(converted)) {
    throw new TypeError("state row must be an object");
  }
  return converted as Record<string, JsonValue>;
}

function freezeBytes(
  value: JsonValue,
  ownerType: "experience" | "review",
  ownerId: string
): { readonly bytes: Uint8Array; readonly ref: SourceRef; readonly blob: ReviewStateBlobInput } {
  const bytes = canonicalJson(value);
  const ref = blobRef(hashBytes(bytes), bytes.byteLength);
  return { bytes, ref, blob: { bytes, ref, owner_type: ownerType, owner_id: ownerId } };
}

function freezeEvent(event: ExperienceLifecycleEvent): {
  readonly ref: SourceRef;
  readonly blob: ReviewStateBlobInput;
} {
  const frozen = freezeBytes(toJsonValue(event), "experience", event.event_id);
  return { ref: frozen.ref, blob: frozen.blob };
}

function freezeHostFacts(
  facts: HostLifecycleFacts,
  ownerId: string
): { readonly ref: SourceRef; readonly blob: ReviewStateBlobInput } {
  const frozen = freezeBytes(
    toJsonValue({
      host_id: facts.host_id,
      mode: facts.mode,
      host_version: facts.host_version,
      tool_versions: facts.tool_versions,
      model_family: facts.model_family,
      facts_hash: facts.facts_hash,
      evidence_ref: facts.evidence_ref
    }),
    "experience",
    ownerId
  );
  return { ref: frozen.ref, blob: frozen.blob };
}

/**
 * The commit seam writes the `blob`/`blob_ref` metadata inside the frame but
 * deliberately does not write bytes. Experience blobs are content-addressed and
 * immutable, so they are materialised immediately before the commit; an
 * unwritable store fails the transition instead of journalling a dangling ref.
 */
function stageBlobs(
  store: BlobStore,
  blobs: readonly ReviewStateBlobInput[]
): ErrorEnvelope | null {
  for (const blob of blobs) {
    const stored = store.putSync(blob.bytes);
    if (!stored.ok) {
      return storageUnavailable("experience_blob_store", stored.error.code);
    }
  }
  return null;
}

function writeNotFound(stage: string): ErrorEnvelope {
  return revError({ code: "E_WRITE_NOT_FOUND", stage, details: { kind: "none" } });
}

function storageUnavailable(stage: string, rule: string): ErrorEnvelope {
  return revError({
    code: "E_STORAGE_UNAVAILABLE",
    stage,
    details: { kind: "internal", incident_id: rule }
  });
}

function actionError(stage: string, rule: string): ErrorEnvelope {
  return revError({
    code: "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION",
    stage,
    details: { kind: "field", path: "action", rule }
  });
}

function readbackVerified(view: WriteAdoptionView): ErrorEnvelope | null {
  if (view.result.state !== "verified" || !view.result.readback_verified) {
    return revError({
      code: "E_WRITE_STATE",
      stage: "adoption",
      details: { kind: "field", path: "result.state", rule: view.result.state }
    });
  }
  return null;
}

function pathCovered(paths: readonly string[], target: string): boolean {
  return paths.some((root) => {
    if (target === root) return true;
    if (matchPathGlob(root, target)) return true;
    return target.startsWith(root.endsWith("/") ? root : `${root}/`);
  });
}

/**
 * Projections persist the target path relative to `approved_root`, while an
 * FND grant carries absolute `path_globs`. Lifecycle admission must compare
 * the same absolute path the write authorization used at adoption time; a
 * relative path only ever matches by accident.
 */
function absoluteProjectionPath(projection: ExperienceProjection): string {
  const path = projection.path_or_block;
  if (isAbsolute(path)) return path;
  const root = projection.adoption_binding.target.approved_root;
  return `${root.endsWith("/") ? root.slice(0, -1) : root}/${path.replace(/^\/+/, "")}`;
}

/**
 * Ongoing grant admission for transitions after adoption. The same axes as
 * the T7 admission are re-checked against the projection's target; a revoked
 * or expired grant never authorises a lifecycle write.
 */
function grantAllows(
  view: WriteAdoptionView,
  projection: ExperienceProjection,
  now: number
): ErrorEnvelope | null {
  const grant = view.grant;
  const binding = projection.adoption_binding;
  if (grant.grant_id !== binding.grant_id || grant.grant_hash !== binding.grant_hash) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "object" }
    });
  }
  if (grant.revoked_at !== undefined && grant.revoked_at !== null) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "expiry" }
    });
  }
  if (grant.expires_at !== undefined && grant.expires_at !== null && now >= grant.expires_at) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "expiry" }
    });
  }
  if (grant.object_type !== projection.object_type) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "object" }
    });
  }
  if (!grant.actions.includes("update") && !grant.actions.includes("create")) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "action" }
    });
  }
  const scope = grant.scope;
  if (
    scope.host_ids !== undefined &&
    (scope.host_ids.length === 0 || !scope.host_ids.includes(String(projection.host_id)))
  ) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "object" }
    });
  }
  if (
    scope.config_spaces !== undefined &&
    (scope.config_spaces.length === 0 || !scope.config_spaces.includes(projection.config_space))
  ) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "config_space" }
    });
  }
  if (
    scope.paths !== undefined &&
    (scope.paths.length === 0 || !pathCovered(scope.paths, absoluteProjectionPath(projection)))
  ) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "lifecycle",
      details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "path" }
    });
  }
  if (scope.block_ids !== undefined) {
    if (
      projection.block_id === null ||
      scope.block_ids.length === 0 ||
      !scope.block_ids.includes(projection.block_id)
    ) {
      return revError({
        code: "E_AUTH_DENIED",
        stage: "lifecycle",
        details: { kind: "authorization", object_type: projection.object_type, denied_dimension: "object" }
      });
    }
  }
  return null;
}

function projectionRowUpdate(
  projection: ExperienceProjection,
  expectedRowVersion: number,
  tx: Tx,
  stage: string
): ErrorEnvelope | null {
  const row = objectRow(projectionRowFromProjection(projection));
  const params: Record<string, JsonValue> = {
    projection_id: projection.projection_id,
    expected_row_version: expectedRowVersion
  };
  const setters: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (key === "projection_id") continue;
    params[key] = value;
    setters.push(`${key} = :${key}`);
  }
  const result = tx
    .prepare(
      `UPDATE experience_projections SET ${setters.join(", ")}
        WHERE projection_id = :projection_id AND row_version = :expected_row_version`
    )
    .run(params);
  if (Number(result.changes) === 0) {
    return concurrentUpdate(String(expectedRowVersion), "changed");
  }
  void stage;
  return null;
}

function projectionRowInsert(projection: ExperienceProjection, tx: Tx): ErrorEnvelope | null {
  const row = objectRow(projectionRowFromProjection(projection));
  const entries = Object.entries(row);
  const keys = entries.map(([key]) => key);
  const params: Record<string, JsonValue> = {};
  for (const [key, value] of entries) params[key] = value;
  try {
    tx.prepare(
      `INSERT INTO experience_projections (${keys.join(", ")}) VALUES (${keys
        .map((key) => `:${key}`)
        .join(", ")})`
    ).run(params);
  } catch (error) {
    return storageUnavailable("experience_projection_insert", String(error));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* FND verifier registry                                              */
/* ------------------------------------------------------------------ */

function verifierKind(value: unknown): VerifierRegistryEntry["kind"] | null {
  switch (value) {
    case "test":
      return "test_pass";
    case "artifact_check":
      return "artifact_check";
    case "external":
      return "external_verification";
    case "human":
      return "human_acceptance";
    default:
      return null;
  }
}

/**
 * Projects FND's `fact_verification` rows into the REV verifier binding.
 *
 * A verification row is usable only while `status='valid'`. Every valid row
 * for one `verifier_ref` must agree on kind and independence; a disagreement
 * is reported instead of choosing one row. `result` is deliberately not used
 * as the lifecycle outcome: the usage record carries the outcome, and the
 * registry binding only identifies the verifier.
 */
export function createFactVerificationRegistry(
  connection: SqliteConnection
): VerifierRegistryPort {
  return {
    async resolve(verifierRef: SourceRef): Promise<Result<VerifierRegistryEntry, ErrorEnvelope>> {
      const rows = connection
        .prepare<Record<string, unknown>>(
          `SELECT verifier_kind, independent, status
             FROM fact_verification
            WHERE verifier_ref = :ref
            ORDER BY verified_at DESC, fact_id DESC`
        )
        .all({ ref: String(verifierRef) });
      const valid = rows.filter((row) => row["status"] === "valid");
      if (valid.length === 0) {
        return err(experienceVerifierBinding(String(verifierRef), "missing_or_invalidated"));
      }
      const kinds = new Set<string>();
      const independences = new Set<string>();
      for (const row of valid) {
        const kind = verifierKind(row["verifier_kind"]);
        if (kind === null) {
          return err(experienceVerifierBinding(String(verifierRef), String(row["verifier_kind"])));
        }
        kinds.add(kind);
        independences.add(row["independent"] === 1 ? "independent" : "same_task_replay");
      }
      if (kinds.size !== 1 || independences.size !== 1) {
        return err(experienceVerifierBinding(String(verifierRef), "ambiguous_verifier_rows"));
      }
      const kind = [...kinds][0] as VerifierRegistryEntry["kind"];
      const independence = [...independences][0] as VerifierRegistryEntry["independence"];
      return ok({ binding_ref: verifierRef, kind, independence });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Fail-closed external ports                                          */
/* ------------------------------------------------------------------ */

function adoptionViewError(path: string, rule: string): ErrorEnvelope {
  return revError({
    code: "E_WRITE_STATE",
    stage: "adoption",
    details: { kind: "field", path, rule }
  });
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

const ROOT_RESOLVE_DEADLINE_MS = 5_000;

function readRootPin(value: unknown): RootIdentityPin | null {
  const pin = recordValue(value);
  if (pin === null) return null;
  const identityKind = pin["identity_kind"];
  if (
    pin["schema_version"] !== "rsi.root_identity/1" ||
    typeof pin["root_id"] !== "string" ||
    (identityKind !== "dev_inode" && identityKind !== "file_id") ||
    typeof pin["device_id"] !== "string" ||
    pin["device_id"].length === 0 ||
    typeof pin["file_id"] !== "string" ||
    pin["file_id"].length === 0
  ) {
    return null;
  }
  return {
    schema_version: "rsi.root_identity/1",
    root_id: pin["root_id"],
    identity_kind: identityKind,
    device_id: pin["device_id"],
    file_id: pin["file_id"]
  };
}

function pinsEqual(left: RootIdentityPin, right: RootIdentityPin): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.root_id === right.root_id &&
    left.identity_kind === right.identity_kind &&
    left.device_id === right.device_id &&
    left.file_id === right.file_id
  );
}

function validApprovedRoot(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    isAbsolute(value)
    ? value
    : null;
}

async function resolveAdoptedRoot(
  resolver: ExperienceRootResolver,
  rootId: string,
  pin: RootIdentityPin,
  writeId: string
): Promise<Result<string, ErrorEnvelope>> {
  let resolved: Result<ExperienceRootResolution, ErrorEnvelope>;
  try {
    resolved = await resolver.resolve({
      root_id: rootId,
      request_id: `rev.adoption:${writeId}`,
      deadline_ms: ROOT_RESOLVE_DEADLINE_MS
    });
  } catch {
    return err(storageUnavailable("adoption", "root_resolver_threw"));
  }
  if (!resolved.ok) return err(resolved.error);
  const value = resolved.value;
  const resolvedPin = readRootPin(value.root_identity_pin);
  if (resolvedPin === null || !pinsEqual(resolvedPin, pin)) {
    return err(adoptionViewError("intent.root_identity_pin", "resolver_pin_mismatch"));
  }
  const approvedRoot = validApprovedRoot(value.approved_root);
  if (approvedRoot === null) {
    return err(adoptionViewError("intent.approved_root", "resolver_absolute"));
  }
  return ok(approvedRoot);
}

/**
 * Projects either REV's own `WriteAdoptionView` or FND's internal
 * `WriteAdoptionView` (`rsi.write_adoption_view/1` over `WriteIntent`) into the
 * shape REV admission expects.
 *
 * FND deliberately does not persist `approved_root`; it resolves the absolute
 * root at execution time. Its current reader therefore cannot supply
 * `intent.approved_root`, and this projection fails closed for that view rather
 * than substituting the proposal's path (which would turn the admission check
 * into a tautology).
 */
async function projectAdoptionView(
  value: unknown,
  rootResolver: ExperienceRootResolver | undefined
): Promise<Result<WriteAdoptionView, ErrorEnvelope>> {
  const view = recordValue(value);
  if (view === null) return err(adoptionViewError("$", "object"));
  const intent = recordValue(view["intent"]);
  const result = recordValue(view["result"]);
  const grant = recordValue(view["grant"]);
  if (intent === null || result === null || grant === null) {
    return err(adoptionViewError("$", "intent_result_grant"));
  }
  const binding = recordValue(intent["binding"]);
  const scope = recordValue(grant["scope"]);
  if (binding === null || scope === null) {
    return err(adoptionViewError("$", "binding_scope"));
  }
  const rawApprovedRoot = intent["approved_root"];
  const rootId = intent["root_id"];
  const intentPin = readRootPin(intent["root_identity_pin"]);
  let approvedRoot: string;
  if (rootResolver === undefined) {
    if (typeof rawApprovedRoot !== "string") {
      return err(adoptionViewError("intent.approved_root", "missing"));
    }
    approvedRoot = rawApprovedRoot;
  } else {
    if (typeof rootId !== "string" || rootId.length === 0) {
      return err(adoptionViewError("intent.root_id", "missing"));
    }
    if (intentPin === null) {
      return err(adoptionViewError("intent.root_identity_pin", "shape"));
    }
    if (intentPin.root_id !== rootId) {
      return err(adoptionViewError("intent.root_identity_pin", "root_id_mismatch"));
    }
    const writeId = typeof intent["write_id"] === "string" ? intent["write_id"] : "unknown";
    const resolved = await resolveAdoptedRoot(rootResolver, rootId, intentPin, writeId);
    if (!resolved.ok) return err(resolved.error);
    if (typeof rawApprovedRoot === "string" && rawApprovedRoot !== resolved.value) {
      return err(adoptionViewError("intent.approved_root", "resolver_mismatch"));
    }
    approvedRoot = resolved.value;
  }
  const configSpaceId = intent["config_space_id"];
  if (typeof configSpaceId !== "string") {
    return err(adoptionViewError("intent.config_space_id", "missing"));
  }
  const newFileHash = result["new_file_hash"];
  const snapshotId = result["snapshot_id"];
  if (typeof newFileHash !== "string") {
    return err(adoptionViewError("result.new_file_hash", "missing"));
  }
  if (typeof snapshotId !== "string") {
    return err(adoptionViewError("result.snapshot_id", "missing"));
  }
  const requiredIntent = [
    "write_id",
    "object_type",
    "action",
    "candidate_id",
    "candidate_hash",
    "write_mode",
    "target_path",
    "target_ownership",
    "grant_id",
    "state"
  ] as const;
  for (const key of requiredIntent) {
    if (typeof intent[key] !== "string") {
      return err(adoptionViewError(`intent.${key}`, "missing"));
    }
  }
  const requiredResult = ["write_id", "state", "path"] as const;
  for (const key of requiredResult) {
    if (typeof result[key] !== "string") {
      return err(adoptionViewError(`result.${key}`, "missing"));
    }
  }
  if (typeof result["attempt"] !== "number" || !Number.isSafeInteger(result["attempt"])) {
    return err(adoptionViewError("result.attempt", "integer"));
  }
  if (typeof result["readback_verified"] !== "boolean") {
    return err(adoptionViewError("result.readback_verified", "boolean"));
  }
  const actions = stringArray(grant["actions"]);
  if (actions === undefined || typeof grant["grant_id"] !== "string" || typeof grant["grant_hash"] !== "string" ||
      typeof grant["object_type"] !== "string" || typeof grant["mode"] !== "string") {
    return err(adoptionViewError("grant", "shape"));
  }
  const hostIds = stringArray(scope["host_ids"]);
  const configSpaces = stringArray(scope["config_spaces"]);
  const paths = stringArray(scope["paths"]) ?? stringArray(scope["path_globs"]);
  const blockIds = stringArray(scope["block_ids"]);
  const objectIds = stringArray(scope["object_ids"]);
  const projectedGrant: AuthorizationGrantView = {
    grant_id: grant["grant_id"] as Id<"grant">,
    grant_hash: grant["grant_hash"] as Hash,
    object_type: grant["object_type"] as AuthorizationGrantView["object_type"],
    actions,
    mode: grant["mode"] as AuthorizationGrantView["mode"],
    scope: {
      ...(hostIds === undefined ? {} : { host_ids: hostIds }),
      ...(configSpaces === undefined ? {} : { config_spaces: configSpaces }),
      ...(paths === undefined ? {} : { paths }),
      ...(blockIds === undefined ? {} : { block_ids: blockIds }),
      ...(objectIds === undefined ? {} : { object_ids: objectIds })
    }
  };
  for (const key of ["revoked_at", "expires_at"] as const) {
    const entry = grant[key];
    if (typeof entry === "number" && Number.isSafeInteger(entry)) {
      projectedGrant[key] = entry;
    }
  }
  for (const key of ["candidate_id", "candidate_hash"] as const) {
    const entry = grant[key];
    if (typeof entry === "string") {
      if (key === "candidate_id") projectedGrant.candidate_id = entry as Id<"prop">;
      else projectedGrant.candidate_hash = entry as Hash;
    }
  }
  const expectedFileHash = intent["expected_file_hash"];
  const expectedBlockHash = intent["expected_block_hash"];
  const blockSelector = intent["block_selector"];
  const newBlockHash = result["new_block_hash"];
  if (
    (expectedFileHash !== null && typeof expectedFileHash !== "string") ||
    (expectedBlockHash !== null && typeof expectedBlockHash !== "string") ||
    (blockSelector !== null && typeof blockSelector !== "string") ||
    (newBlockHash !== null && typeof newBlockHash !== "string")
  ) {
    return err(adoptionViewError("$", "nullable_fields"));
  }
  if (
    typeof binding["task_id"] !== "string" ||
    typeof binding["branch_id"] !== "string" ||
    typeof binding["input_epoch"] !== "number" ||
    typeof binding["goal_version"] !== "string" ||
    typeof binding["config_version"] !== "string" ||
    typeof binding["watermark"] !== "number"
  ) {
    return err(adoptionViewError("intent.binding", "shape"));
  }
  return ok({
    intent: {
      write_id: intent["write_id"] as Id<"wi">,
      object_type: intent["object_type"] as WriteAdoptionView["intent"]["object_type"],
      action: intent["action"] as WriteAdoptionView["intent"]["action"],
      candidate_id: intent["candidate_id"] as Id<"prop">,
      candidate_hash: intent["candidate_hash"] as Hash,
      expected_file_hash: expectedFileHash as Hash | null,
      expected_block_hash: expectedBlockHash as Hash | null,
      write_mode: intent["write_mode"] as WriteAdoptionView["intent"]["write_mode"],
      target_path: intent["target_path"] as string,
      approved_root: approvedRoot,
      target_ownership: intent["target_ownership"] as WriteAdoptionView["intent"]["target_ownership"],
      block_selector: blockSelector as string | null,
      config_space_id: configSpaceId,
      grant_id: intent["grant_id"] as Id<"grant">,
      binding: {
        task_id: binding["task_id"] as Id<"task">,
        branch_id: binding["branch_id"] as Id<"br">,
        input_epoch: binding["input_epoch"] as number,
        goal_version: binding["goal_version"] as string,
        config_version: binding["config_version"] as string,
        watermark: binding["watermark"] as number
      },
      state: intent["state"] as string
    },
    result: {
      write_id: result["write_id"] as Id<"wi">,
      attempt: result["attempt"] as number,
      state: result["state"] as string,
      path: result["path"] as string,
      new_file_hash: newFileHash as Hash,
      new_block_hash: newBlockHash as Hash | null,
      snapshot_id: snapshotId,
      readback_verified: result["readback_verified"] as boolean
    },
    grant: projectedGrant
  });
}

/**
 * Adapts FND's adoption reader into the REV port.
 *
 * `read` may be the synchronous in-transaction reader REV prefers, FND's
 * async `createWriteAdoptionReadPort(...)` result, or a full
 * `WriteAdoptionReadPort`. REV never reconstructs writes or grants from its own
 * tables, so a missing reader reports `E_WRITE_NOT_FOUND`.
 *
 * The async FND reader is bound to the caller's connection and is safe for the
 * pre-frame admission in this module (`recordAdoption`, `beginTrial`,
 * `extendWindow`). It cannot serve a synchronous in-transaction request; that
 * member fails closed rather than blocking the event loop or opening a second
 * connection.
 */
export function createExperienceWriteAdoptionPort(
  read:
    | ((writeId: Id<"wi">) => Result<WriteAdoptionView, ErrorEnvelope>)
    | ReviewExperienceAdoptionSource
    | null,
  rootResolver?: ExperienceRootResolver
): WriteAdoptionReadPort {
  if (read === null) {
    return {
      getAdoptionInTransaction: (_tx, _writeId) => err(writeNotFound("adoption")),
      getAdoption: async () => err(writeNotFound("adoption"))
    };
  }
  if (typeof read === "function") {
    return {
      getAdoptionInTransaction: (_tx, writeId) =>
        rootResolver === undefined
          ? read(writeId)
          : err(storageUnavailable("adoption", "root_resolver_not_tx_bound")),
      getAdoption: async (writeId) => {
        const readResult = read(writeId as Id<"wi">);
        if (!readResult.ok) return readResult;
        return projectAdoptionView(readResult.value, rootResolver);
      }
    };
  }
  if ("getAdoptionInTransaction" in read) {
    return read as WriteAdoptionReadPort;
  }
  return {
    getAdoptionInTransaction: (_tx) =>
      err(storageUnavailable("adoption", "async_reader_not_tx_bound")),
    getAdoption: async (writeId) => {
      const readResult = await read.getAdoption(writeId);
      if (!readResult.ok) return readResult;
      return projectAdoptionView(readResult.value, rootResolver);
    }
  };
}

const failClosedAdoption: WriteAdoptionReadPort = {
  getAdoptionInTransaction: (_tx, _writeId) => err(writeNotFound("adoption")),
  getAdoption: async (_writeId) => err(writeNotFound("adoption"))
};

const failClosedGoal: GoalVersionReadPort = {
  getCurrentGoal: async () => err(goalUnavailable("getCurrentGoal")),
  getCurrentGoalInTransaction: () => err(goalUnavailable("getCurrentGoalInTransaction"))
};

const failClosedHostFacts: HostLifecycleFactsPort = {
  readInTransaction: () =>
    err(experienceHostFactsUnavailable("readHostLifecycleFacts"))
};

async function failClosedReadHostFacts(): Promise<Result<HostLifecycleFacts, ErrorEnvelope>> {
  return err(experienceHostFactsUnavailable("readHostLifecycleFacts"));
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createReviewExperiencePorts(
  options: ReviewExperiencePortOptions
): ReviewExperiencePortBundle {
  const { connection, repository, journal, now, blobStore } = options;
  const commitRows: ReviewStateRowCommit =
    options.commitRows ??
    (journal === null
      ? async () => err(storageUnavailable("experience_commit", "review_journal_unavailable"))
      : createReviewStateRowCommit({
          journal,
          connection,
          blobStore: options.blobStore,
          now
        }));
  const writeAdoption =
    options.writeAdoption === undefined
      ? failClosedAdoption
      : createExperienceWriteAdoptionPort(options.writeAdoption, options.rootResolver);
  const goal = options.goal ?? failClosedGoal;
  const hostFacts = options.hostFacts ?? failClosedHostFacts;
  const readHostFacts = options.readHostFacts ?? failClosedReadHostFacts;
  const verifierRegistry = createFactVerificationRegistry(connection);
  const resolveRollbackTarget =
    options.rollbackTargetResolutionEnabled === true
      ? createRollbackTargetResolver({ connection, repository })
      : null;

  const lifecycleExtensionReady = (): boolean => {
    const row = connection
      .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = 'experience_lifecycle_events'")
      .get() as { sql?: unknown } | undefined;
    if (typeof row?.sql !== "string") return false;
    const schema = row.sql.toLowerCase();
    if (schema.startsWith("create view")) {
      // The consolidated major-4 schema always carries the final lifecycle
      // shape; the CHECK literals live in the frozen row contract, not in the
      // view projection.
      return true;
    }
    return schema.includes("window_extended") && schema.includes("window_extension");
  };

  const adoptionOf = (writeId: string): Promise<Result<WriteAdoptionView, ErrorEnvelope>> =>
    writeAdoption.getAdoption(writeId as Id<"wi">);

  /* ------------------------------ adoption ------------------------------ */

  async function recordAdoption(input: {
    proposal_id: string;
    write_id: string;
    grant_id: string;
    projection_id?: string;
    now: number;
  }): Promise<Result<ExperienceProjection, ErrorEnvelope>> {
    const replay = await repository.getProjectionByWriteId(input.write_id);
    if (replay !== null) return ok(replay);
    const proposal = await repository.getProposal(input.proposal_id);
    if (proposal === null || proposal.state !== "proposed") {
      return err(
        revError({
          code: "E_PROPOSAL_ILLEGAL_TRANSITION",
          stage: "adoption",
          details: {
            kind: "field",
            path: "proposal.state",
            rule: proposal?.state ?? "missing"
          }
        })
      );
    }
    const view = await adoptionOf(input.write_id);
    if (!view.ok) return err(view.error);
    const job = await repository.getJob(proposal.job_id);
    if (job === null) return err(writeNotFound("adoption"));
    const snapshot = await repository.getSnapshot(job.snapshot_id);
    if (snapshot === null) return err(writeNotFound("adoption"));
    const validated = validateAdoptionView({
      proposal,
      view: view.value,
      grant_id: input.grant_id,
      snapshot_binding: snapshot.version_binding
    });
    if (!validated.ok) return err(validated.error);
    const plan = await repository.getValidationPlan(proposal.experience.validation_plan_id);
    if (plan === null) return err(writeNotFound("adoption"));
    const versions = await repository.listExperiences(proposal.experience.experience_id);
    const experience = versions.find(
      (entry) => entry.version === proposal.experience.version
    );
    if (experience === undefined) return err(writeNotFound("adoption"));

    const timestamp = input.now;
    const projectionId = input.projection_id ?? String(newId("prj", timestamp));
    const eventId = newId("lif", timestamp);
    const writeResult = freezeBytes(
      toJsonValue({
        intent: view.value.intent,
        result: view.value.result,
        grant: view.value.grant
      }),
      "experience",
      input.write_id
    );
    const binding = buildAdoptionBinding({
      proposal,
      view: view.value,
      write_result_ref: writeResult.ref,
      now: timestamp
    });
    const write: ExperienceProjection["write"] = {
      write_id: view.value.intent.write_id,
      write_state: "verified",
      candidate_hash: proposal.candidate_hash,
      written_file_hash: view.value.result.new_file_hash,
      adoption_ref: writeResult.ref,
      grant_id: view.value.grant.grant_id,
      written_at: timestamp
    };
    if (view.value.result.new_block_hash !== null) {
      write.written_block_hash = view.value.result.new_block_hash;
    }
    const verifier: ExperienceProjection["verifier"] = {
      kind: proposal.experience.verifier.kind,
      independence: proposal.experience.verifier.independence
    };
    if (proposal.experience.verifier.binding_ref !== undefined) {
      verifier.binding_ref = proposal.experience.verifier.binding_ref;
    }
    const projection = createInitialProjection({
      projection_id: projectionId,
      experience,
      validation_plan: plan,
      adoption_binding: binding,
      verifier,
      retention_rule_id: plan.retention_rule.rule_id,
      write,
      first_event_id: eventId,
      now: timestamp
    });
    let event: ExperienceLifecycleEvent;
    try {
      event = buildLifecycleEvent({
        event_id: eventId,
        projection_before: null,
        projection_after: projection,
        sequence: 1,
        reason: "adopted",
        trigger: { kind: "adoption", ref: writeResult.ref, usage_ids: [] },
        write_id: view.value.intent.write_id,
        version_binding: view.value.intent.binding,
        now: timestamp
      });
    } catch {
      return err(illegalProjectionTransition("none", "checked"));
    }
    const frozenEvent = freezeEvent(event);
    const adopted = proposalAfterAdoption(proposal, writeResult.ref, timestamp);
    const members: ReviewStateRowInput[] = [
      {
        row_schema: "rsi.proposal_row/2",
        object_key: proposal.proposal_id,
        operation: "update",
        row: objectRow(proposalRowFromProposal(adopted)),
        before: objectRow(proposalRowFromProposal(proposal)),
        expected: { version: proposal.version }
      },
      {
        row_schema: "rsi.experience_lifecycle_event_row/1",
        object_key: event.event_id,
        operation: "insert",
        row: objectRow(lifecycleEventRowFromEvent(event, frozenEvent.ref))
      }
    ];
    const cache = await adoptedVersionCacheRow(
      repository,
      proposal.experience.experience_id,
      proposal.experience.version
    );
    if (cache !== null) members.push(cache);
    const blobs = [writeResult.blob, frozenEvent.blob];
    const staged = stageBlobs(blobStore, blobs);
    if (staged !== null) return err(staged);
    const committed = await commitRows({
      members,
      blobs,
      apply: (tx) => projectionRowInsert(projection, tx)
    });
    if (!committed.ok) return err(committed.error);
    return ok(projection);
  }

  /* ------------------------------ begin trial --------------------------- */

  async function beginTrial(input: {
    projection: ExperienceProjection;
    plan: ValidationPlan;
    now: number;
  }): Promise<Result<{ projection: ExperienceProjection; event: ExperienceLifecycleEvent }, ErrorEnvelope>> {
    const current = await repository.getProjection(input.projection.projection_id);
    if (current === null) return err(writeNotFound("begin_trial"));
    if (current.row_version !== input.projection.row_version) {
      return err(
        concurrentUpdate(String(input.projection.row_version), String(current.row_version))
      );
    }
    if (current.lifecycle !== "checked") {
      return err(illegalProjectionTransition(current.lifecycle, "trial"));
    }
    if (current.no_verifier || input.plan.verifier.kind === "none") {
      return err(noVerifier());
    }
    if (input.plan.verifier.independence !== "independent") {
      return err(
        experienceVerifierBinding("independent", input.plan.verifier.independence)
      );
    }
    if (current.validation_plan_hash !== input.plan.plan_hash) {
      return err(
        experienceVerifierBinding(current.validation_plan_hash, input.plan.plan_hash)
      );
    }
    const view = await adoptionOf(current.adoption_binding.write_id);
    if (!view.ok) return err(view.error);
    const readback = readbackVerified(view.value);
    if (readback !== null) return err(readback);
    const grant = grantAllows(view.value, current, input.now);
    if (grant !== null) return err(grant);
    const currentGoal = await goal.getCurrentGoal({
      task_id: current.adoption_binding.version_binding.task_id,
      branch_id: current.adoption_binding.version_binding.branch_id
    });
    if (!currentGoal.ok) return err(currentGoal.error);
    if (
      currentGoal.value.goal_version !==
      current.adoption_binding.version_binding.goal_version
    ) {
      return err(
        revError({
          code: "E_VERSION_BINDING",
          stage: "begin_trial",
          details: {
            kind: "version",
            expected: current.adoption_binding.version_binding.goal_version,
            actual: currentGoal.value.goal_version
          }
        })
      );
    }
    const facts = await readHostFacts(current);
    if (!facts.ok) return err(facts.error);
    const factScope = hostFactScopeError(facts.value, current);
    if (factScope !== null) return err(factScope);
    const timestamp = input.now;
    const after: ExperienceProjection = {
      ...current,
      lifecycle: "trial",
      lifecycle_reason: "trial_started",
      retention: {
        ...current.retention,
        window_started_at: timestamp,
        window_end_at: timestamp + input.plan.observation_window.window_ms,
        window_extensions: 0,
        last_evaluated_at: timestamp
      },
      baseline: {
        host_version: facts.value.host_version,
        tool_versions: { ...facts.value.tool_versions },
        model_family: facts.value.model_family,
        captured_at: timestamp
      },
      row_version: current.row_version + 1,
      updated_at: timestamp
    };
    const events = await repository.listLifecycleEvents(current.projection_id);
    const eventId = newId("lif", timestamp);
    let event: ExperienceLifecycleEvent;
    try {
      event = buildLifecycleEvent({
        event_id: eventId,
        projection_before: current,
        projection_after: after,
        sequence: nextSequence(events),
        reason: "trial_started",
        trigger: { kind: "begin_trial", ref: null, usage_ids: [] },
        write_id: current.adoption_binding.write_id,
        version_binding: current.adoption_binding.version_binding,
        now: timestamp
      });
    } catch {
      return err(illegalProjectionTransition("checked", "trial"));
    }
    const frozen = freezeEvent(event);
    const committed = await commitRows({
      members: [lifecycleMember(event, frozen.ref)],
      blobs: [frozen.blob],
      apply: (tx) => projectionRowUpdate(event.projection_after, current.row_version, tx, "begin_trial")
    });
    if (!committed.ok) return err(committed.error);
    return ok({ projection: event.projection_after, event });
  }

  /* ------------------------------ usage -------------------------------- */

  async function recordUsage(input: {
    projection: ExperienceProjection;
    record: UsageVerificationRecord;
    now: number;
  }): Promise<Result<UsageVerificationRecord, ErrorEnvelope>> {
    const current = await repository.getProjection(input.projection.projection_id);
    if (current === null) return err(writeNotFound("usage_record"));
    if (current.lifecycle !== "checked" && current.lifecycle !== "trial" && current.lifecycle !== "retained") {
      return err(actionError("usage_record", current.lifecycle));
    }
    const record = input.record;
    if (
      record.projection_id !== current.projection_id ||
      record.experience_id !== current.experience_id ||
      record.experience_version !== current.experience_version ||
      record.validation_plan_id !== current.validation_plan_id ||
      record.validation_plan_hash !== current.validation_plan_hash
    ) {
      return err(
        revError({
          code: "E_VERSION_BINDING",
          stage: "usage_record",
          details: { kind: "version", expected: current.projection_id, actual: record.projection_id }
        })
      );
    }
    const duplicate = connection
      .prepare<Record<string, unknown>>(
        "SELECT usage_id, evidence_hash FROM usage_verification_records WHERE usage_key = :key"
      )
      .get({ key: record.usage_key });
    if (duplicate !== undefined) {
      const existingEvidence = duplicate["evidence_hash"];
      return err(
        experienceUsageKeyCollision(
          record.usage_key,
          typeof existingEvidence === "string" ? (existingEvidence as Hash) : record.evidence_hash,
          record.evidence_hash
        )
      );
    }
    const incPass =
      record.result === "positive_evidence" && record.verification.independence === "independent"
        ? 1
        : 0;
    const incFail =
      record.result === "negative_evidence" || record.result === "counterexample" ? 1 : 0;
    const incNotExercised = record.result === "not_exercised" ? 1 : 0;
    const committed = await commitRows({
      members: [
        {
          row_schema: "rsi.usage_verification_row/1",
          object_key: record.usage_id,
          operation: "insert",
          row: objectRow(usageRowFromRecord(record))
        }
      ],
      blobs: [],
      apply: (tx) => {
        const result = tx
          .prepare(
            `UPDATE experience_projections SET
               usage_record_ids_json = json_insert(usage_record_ids_json, '$[#]', :usage_id),
               loading_evidence_json = :loading,
               retention_json = json_set(
                 retention_json,
                 '$.independent_passes',
                 json_extract(retention_json, '$.independent_passes') + :inc_pass,
                 '$.failed_observations',
                 json_extract(retention_json, '$.failed_observations') + :inc_fail,
                 '$.not_exercised_count',
                 json_extract(retention_json, '$.not_exercised_count') + :inc_not_exercised
               ),
               updated_at = :now
             WHERE projection_id = :projection_id`
          )
          .run({
            usage_id: record.usage_id,
            loading: JSON.stringify(toJsonValue(record.loading)),
            inc_pass: incPass,
            inc_fail: incFail,
            inc_not_exercised: incNotExercised,
            now: input.now,
            projection_id: current.projection_id
          });
        if (Number(result.changes) === 0) return writeNotFound("usage_record");
        return null;
      }
    });
    if (!committed.ok) return err(committed.error);
    return ok(record);
  }

  /* ------------------------------ lifecycle ---------------------------- */

  async function applyLifecycle(input: {
    projection: ExperienceProjection;
    action: LifecycleAction;
    now: number;
  }): Promise<Result<{ projection: ExperienceProjection; event: ExperienceLifecycleEvent }, ErrorEnvelope>> {
    const current = await repository.getProjection(input.projection.projection_id);
    if (current === null) return err(writeNotFound("lifecycle"));
    if (current.row_version !== input.projection.row_version) {
      return err(
        concurrentUpdate(String(input.projection.row_version), String(current.row_version))
      );
    }
    const action = input.action;
    if (action.kind === "none") return err(actionError("lifecycle", "none"));
    if (action.kind === "begin_trial") {
      const plan = await repository.getValidationPlan(current.validation_plan_id);
      if (plan === null) return err(writeNotFound("begin_trial"));
      return beginTrial({ projection: current, plan, now: input.now });
    }
    if (action.kind === "retained") {
      if (current.lifecycle !== "trial") {
        return err(illegalProjectionTransition(current.lifecycle, "retained"));
      }
      const plan = await repository.getValidationPlan(current.validation_plan_id);
      if (plan === null) return err(writeNotFound("lifecycle"));
      const usages = await repository.listUsage(current.projection_id);
      if (!retainedPredicate(lifecycleFacts(current, plan, usages, input.now))) {
        return err(actionError("lifecycle", "retained_predicate"));
      }
      const after: ExperienceProjection = {
        ...current,
        lifecycle: "retained",
        lifecycle_reason: "retention_rule_met",
        retention: {
          ...current.retention,
          last_evaluated_at: input.now,
          retained_at: input.now,
          review_after_at: input.now + plan.retention_rule.max_age_ms
        },
        row_version: current.row_version + 1,
        updated_at: input.now
      };
      const positiveIds = usages
        .filter((usage) => usage.result === "positive_evidence")
        .map((usage) => usage.usage_id);
      return commitTransition({
        current,
        after,
        reason: "retention_rule_met",
        trigger: { kind: "retention_evaluated", ref: null, usage_ids: positiveIds },
        blobs: [],
        now: input.now
      });
    }

    /* disabled / revoked */
    if (
      current.lifecycle !== "checked" &&
      current.lifecycle !== "trial" &&
      current.lifecycle !== "retained"
    ) {
      return err(illegalProjectionTransition(current.lifecycle, "disabled"));
    }
    const reason = action.kind === "disabled" ? action.reason : action.reason;
    const usages = await repository.listUsage(current.projection_id);
    const plan = await repository.getValidationPlan(current.validation_plan_id);
    if (plan === null) return err(writeNotFound("lifecycle"));
    const facts = lifecycleFacts(current, plan, usages, input.now);
    if (reason === "confirmed_regression" && !confirmedRegressionPredicate(facts)) {
      return err(actionError("lifecycle", "confirmed_regression_predicate"));
    }
    if (reason === "expired" && !expiredPredicate(facts)) {
      return err(actionError("lifecycle", "expired_predicate"));
    }
    if (reason === "superseded" && current.superseded_by_projection_id === null) {
      return err(actionError("lifecycle", "superseded_target"));
    }
    const blobs: ReviewStateBlobInput[] = [];
    let trigger: ExperienceLifecycleEvent["trigger"] = {
      kind: triggerKindForReason(reason),
      ref: null,
      usage_ids:
        reason === "confirmed_regression"
          ? usages
              .filter(
                (usage) =>
                  usage.verification.status === "failed" &&
                  (usage.attribution === "isolated_replay" ||
                    usage.attribution === "controlled_trial")
              )
              .map((usage) => usage.usage_id)
          : []
    };
    if (reason === "host_incompatible") {
      const host = await readHostFacts(current);
      if (!host.ok) return err(host.error);
      const incompatible = hostIncompatiblePredicate({
        ...facts,
        host_facts: host.value,
        host_facts_error: null
      });
      if (!incompatible.ok) return err(incompatible.error);
      if (!incompatible.value) {
        return err(actionError("lifecycle", "host_incompatible_predicate"));
      }
      const frozen = freezeHostFacts(host.value, current.projection_id);
      blobs.push(frozen.blob);
      trigger = { kind: "host_change", ref: frozen.ref, usage_ids: [] };
    }
    const after = disabledProjection(
      current,
      reason,
      input.now,
      current.superseded_by_projection_id
    );
    return commitTransition({
      current,
      after,
      reason,
      trigger,
      blobs,
      now: input.now
    });
  }

  async function commitTransition(input: {
    current: ExperienceProjection;
    after: ExperienceProjection;
    reason: ExperienceLifecycleEvent["reason"];
    trigger: ExperienceLifecycleEvent["trigger"];
    blobs: ReviewStateBlobInput[];
    now: number;
  }): Promise<Result<{ projection: ExperienceProjection; event: ExperienceLifecycleEvent }, ErrorEnvelope>> {
    const events = await repository.listLifecycleEvents(input.current.projection_id);
    const eventId = newId("lif", input.now);
    let event: ExperienceLifecycleEvent;
    try {
      event = buildLifecycleEvent({
        event_id: eventId,
        projection_before: input.current,
        projection_after: input.after,
        sequence: nextSequence(events),
        reason: input.reason,
        trigger: input.trigger,
        write_id: input.current.adoption_binding.write_id,
        version_binding: input.current.adoption_binding.version_binding,
        now: input.now
      });
    } catch {
      return err(illegalProjectionTransition(input.current.lifecycle, input.after.lifecycle));
    }
    const frozen = freezeEvent(event);
    const blobs = [frozen.blob, ...input.blobs];
    const staged = stageBlobs(blobStore, blobs);
    if (staged !== null) return err(staged);
    const committed = await commitRows({
      members: [lifecycleMember(event, frozen.ref)],
      blobs,
      apply: (tx) =>
        projectionRowUpdate(
          event.projection_after,
          input.current.row_version,
          tx,
          String(input.reason)
        )
    });
    if (!committed.ok) return err(committed.error);
    return ok({ projection: event.projection_after, event });
  }

  /* ------------------------------ window ------------------------------- */

  async function extendWindow(input: {
    projection: ExperienceProjection;
    plan: ValidationPlan;
    now: number;
  }): Promise<Result<ExperienceProjection, ErrorEnvelope>> {
    const current = await repository.getProjection(input.projection.projection_id);
    if (current === null) return err(writeNotFound("extend_window"));
    if (current.row_version !== input.projection.row_version) {
      return err(
        concurrentUpdate(String(input.projection.row_version), String(current.row_version))
      );
    }
    if (current.lifecycle !== "trial") {
      return err(illegalProjectionTransition(current.lifecycle, "trial"));
    }
    if (
      current.retention.window_end_at === undefined ||
      input.now >= current.retention.window_end_at
    ) {
      return err(windowLimit("retention.window_end_at", "expired"));
    }
    if (current.retention.window_extensions >= input.plan.observation_window.max_extensions) {
      return err(
        windowLimit(
          "retention.window_extensions",
          String(current.retention.window_extensions)
        )
      );
    }
    if (!lifecycleExtensionReady()) {
      return err(storageUnavailable("extend_window", "lifecycle_extension_migration_missing"));
    }
    const view = await adoptionOf(current.adoption_binding.write_id);
    if (!view.ok) return err(view.error);
    const grant = grantAllows(view.value, current, input.now);
    if (grant !== null) return err(grant);
    const after: ExperienceProjection = {
      ...current,
      lifecycle_reason: "window_extended",
      retention: {
        ...current.retention,
        window_end_at: current.retention.window_end_at + input.plan.observation_window.window_ms,
        window_extensions: current.retention.window_extensions + 1,
        last_evaluated_at: input.now
      },
      row_version: current.row_version + 1,
      updated_at: input.now
    };
    const committed = await commitTransition({
      current,
      after,
      reason: "window_extended",
      trigger: { kind: "window_extension", ref: null, usage_ids: [] },
      blobs: [],
      now: input.now
    });
    if (!committed.ok) return err(committed.error);
    return ok(committed.value.projection);
  }

  /* ------------------------------ revoke ------------------------------- */

  async function revoke(input: {
    projection: ExperienceProjection;
    reason: "user_revoked" | "authorization_revoked";
    now: number;
  }): Promise<Result<ExperienceProjection, ErrorEnvelope>> {
    const applied = await applyLifecycle({
      projection: input.projection,
      action: { kind: "revoked", reason: input.reason },
      now: input.now
    });
    if (!applied.ok) return err(applied.error);
    return ok(applied.value.projection);
  }

  /* ------------------------------ rollback ----------------------------- */

  async function rollback(input: {
    projection: ExperienceProjection;
    target_version?: number;
    grant_id: string;
    now: number;
  }): Promise<Result<{ projection: ExperienceProjection; write_id: string }, ErrorEnvelope>> {
    const current = await repository.getProjection(input.projection.projection_id);
    if (current === null) return err(writeNotFound("rollback"));
    if (current.row_version !== input.projection.row_version) {
      return err(concurrentUpdate(String(input.projection.row_version), String(current.row_version)));
    }

    /* Target resolution. When enabled the resolver owns both the choice of the
     * nearest older adopted version and the full chain validation; a broken
     * link is `E_ROLLBACK_TARGET_UNRESOLVED` before any writer runs. When
     * disabled the caller-supplied version is used exactly as before. */
    let resolvedTarget: ResolvedRollbackTarget | null = null;
    let targetVersion: number;
    if (resolveRollbackTarget !== null) {
      const resolved = await resolveRollbackTarget({
        projection: current,
        ...(input.target_version === undefined ? {} : { target_version: input.target_version })
      });
      if (!resolved.ok) return err(resolved.error);
      resolvedTarget = resolved.value;
      targetVersion = resolved.value.target_version;
    } else if (input.target_version !== undefined) {
      targetVersion = input.target_version;
    } else {
      return err(
        revError({
          code: "E_WRITE_STATE",
          stage: "rollback",
          details: { kind: "field", path: "target_version", rule: "required_without_resolution" }
        })
      );
    }

    if (targetVersion >= current.experience_version) {
      return err(
        revError({
          code: "E_WRITE_STATE",
          stage: "rollback",
          details: { kind: "field", path: "target_version", rule: "must_be_older" }
        })
      );
    }
    const executor = options.rollbackExecutor;
    const operationId = `rollback:${current.projection_id}:${targetVersion}:${input.grant_id}`;
    const reconciliation = options.connection
      .prepare<SqlRow>(
        `SELECT operation_id, fnd_write_id, source_projection_id, target_projection_id,
                target_experience_id, target_experience_version, state
           FROM experience_rollback_reconciliation
          WHERE operation_id = :operation_id`
      )
      .get({ operation_id: operationId });
    const existing = (await repository.listProjections(current.experience_id, targetVersion)).find(
      (projection) => projection.restored_from_projection_id === current.projection_id
    );
    if (existing !== undefined) {
      if (executor?.complete !== undefined) {
        const reconciled = await executor.complete({
          operation_id: operationId,
          write_id: existing.adoption_binding.write_id
        });
        if (!reconciled.ok) return err(reconciled.error);
      }
      return ok({ projection: existing, write_id: existing.adoption_binding.write_id });
    }
    if (current.lifecycle !== "checked" && current.lifecycle !== "trial" && current.lifecycle !== "retained") {
      return err(illegalProjectionTransition(current.lifecycle, "disabled"));
    }
    let target: ExperienceProjection | undefined;
    if (resolvedTarget !== null) {
      target = resolvedTarget.target_projection;
    } else {
      target = (await repository.listProjections(current.experience_id, targetVersion)).find(
        (projection) =>
          projection.host_id === current.host_id &&
          projection.config_space === current.config_space &&
          projection.mode === current.mode &&
          projection.object_type === current.object_type &&
          projection.path_or_block === current.path_or_block &&
          projection.block_id === current.block_id &&
          projection.lifecycle !== "revoked"
      );
    }
    if (target === undefined) return err(writeNotFound("rollback_target"));
    if (target.write.write_id === undefined) return err(writeNotFound("rollback_target_write"));
    const targetView = await adoptionOf(target.write.write_id);
    if (!targetView.ok) return err(targetView.error);
    const targetReadback = readbackVerified(targetView.value);
    if (targetReadback !== null) return err(targetReadback);
    /* A rollback may be authorized by its own `rollback` grant; it need not be
     * the grant that authorized the source write. FND `write.apply` validates
     * and consumes the supplied grant, and the executed view is checked below
     * so the durable reconciliation records the actual rollback grant. */

    let rollbackView: WriteAdoptionView;
    if (reconciliation?.["state"] === "fnd_verified") {
      const operationSource = rowString(reconciliation, "source_projection_id");
      const operationTarget = rowString(reconciliation, "target_projection_id");
      const operationExperience = rowString(reconciliation, "target_experience_id");
      const operationVersion = reconciliation["target_experience_version"];
      const fndWriteId = rowString(reconciliation, "fnd_write_id");
      if (
        operationSource !== current.projection_id ||
        operationTarget !== target.projection_id ||
        operationExperience !== target.experience_id ||
        operationVersion !== target.experience_version ||
        fndWriteId === null ||
        fndWriteId.startsWith("pending:")
      ) {
        return err(bridgeError("experience_rollback_reconciliation", "fnd_verified_binding_mismatch"));
      }
      const verified = await adoptionOf(fndWriteId as Id<"wi">);
      if (!verified.ok) return err(verified.error);
      rollbackView = verified.value;
    } else {
      if (reconciliation?.["state"] === "recovery_required") {
        return err(bridgeError("experience_rollback_reconciliation", "recovery_required"));
      }
      if (executor === undefined) {
        return err(
          revError({
            code: "E_WRITE_NOT_FOUND",
            stage: "rollback",
            details: { kind: "none" }
          })
        );
      }
      const executed = await executor.execute({
        operation_id: operationId,
        source_projection: current,
        target_projection: target,
        ...(resolvedTarget === null ? {} : { resolved_target: resolvedTarget }),
        grant_id: input.grant_id,
        now: input.now
      });
      if (!executed.ok) return err(executed.error);
      rollbackView = executed.value;
    }
    const rollbackReadback = readbackVerified(rollbackView);
    if (rollbackReadback !== null) return err(rollbackReadback);
    if (rollbackView.intent.action !== "rollback") {
      return err(
        revError({
          code: "E_WRITE_STATE",
          stage: "rollback",
          details: { kind: "field", path: "intent.action", rule: "rollback_required" }
        })
      );
    }
    if (rollbackView.grant.grant_id !== input.grant_id) {
      return err(
        revError({
          code: "E_AUTH_DENIED",
          stage: "rollback",
          details: {
            kind: "authorization",
            object_type: current.object_type,
            denied_dimension: "action"
          }
        })
      );
    }
    const rollbackWriteId = rollbackView.intent.write_id;
    const persistedGrant = options.connection
      .prepare<SqlRow>("SELECT grant_id FROM write_intent WHERE write_id = :write_id")
      .get({ write_id: rollbackWriteId });
    if (rowString(persistedGrant, "grant_id") !== rollbackView.grant.grant_id) {
      return err(
        revError({
          code: "E_AUTH_DENIED",
          stage: "rollback",
          details: {
            kind: "authorization",
            object_type: current.object_type,
            denied_dimension: "action"
          }
        })
      );
    }

    const timestamp = input.now;
    const newProjectionId = String(newId("prj", timestamp));
    const resultBlob = freezeBytes(
      toJsonValue({ intent: rollbackView.intent, result: rollbackView.result, grant: rollbackView.grant }),
      "experience",
      newProjectionId
    );
    const targetBindingBase = {
      ...target.adoption_binding,
      write_id: rollbackView.intent.write_id,
      write_attempt: rollbackView.result.attempt,
      write_result_ref: resultBlob.ref,
      grant_id: rollbackView.grant.grant_id,
      grant_hash: rollbackView.grant.grant_hash,
      candidate_hash: rollbackView.intent.candidate_hash,
      adopted_at: undefined,
      binding_hash: undefined
    };
    const { adopted_at: _adoptedAt, binding_hash: _bindingHash, ...bindingWithoutDerived } = targetBindingBase;
    const restoredBinding = {
      ...bindingWithoutDerived,
      adopted_at: timestamp,
      binding_hash: adoptionBindingHash(bindingWithoutDerived)
    };
    const restored: ExperienceProjection = {
      ...target,
      projection_id: newProjectionId,
      adoption_binding: restoredBinding,
      lifecycle: "checked",
      lifecycle_reason: "rollback",
      checked_at: timestamp,
      write: {
        ...target.write,
        write_id: rollbackView.result.write_id,
        write_state: rollbackView.result.state,
        candidate_hash: rollbackView.intent.candidate_hash,
        written_file_hash: rollbackView.result.new_file_hash,
        adoption_ref: resultBlob.ref,
        grant_id: rollbackView.grant.grant_id,
        written_at: timestamp,
        ...(rollbackView.result.new_block_hash === null
          ? {}
          : { written_block_hash: rollbackView.result.new_block_hash })
      },
      retention: {
        window_extensions: 0,
        independent_passes: 0,
        failed_observations: 0,
        not_exercised_count: 0
      },
      baseline: null,
      usage_record_ids: [],
      restored_from_projection_id: current.projection_id,
      superseded_by_projection_id: null,
      last_lifecycle_event_id: "",
      row_version: 1,
      created_at: timestamp,
      updated_at: timestamp
    };
    const oldAfter: ExperienceProjection = {
      ...current,
      lifecycle: "disabled",
      lifecycle_reason: "rollback",
      superseded_by_projection_id: restored.projection_id,
      row_version: current.row_version + 1,
      updated_at: timestamp
    };
    const oldEvents = await repository.listLifecycleEvents(current.projection_id);
    const restoredEventId = newId("lif", timestamp);
    const oldEventId = newId("lif", timestamp);
    let restoredEvent: ExperienceLifecycleEvent;
    let oldEvent: ExperienceLifecycleEvent;
    try {
      restoredEvent = buildLifecycleEvent({
        event_id: restoredEventId,
        projection_before: null,
        projection_after: restored,
        sequence: 1,
        reason: "rollback",
        trigger: { kind: "rollback", ref: resultBlob.ref, usage_ids: [] },
        write_id: rollbackView.intent.write_id,
        version_binding: rollbackView.intent.binding,
        now: timestamp
      });
      oldEvent = buildLifecycleEvent({
        event_id: oldEventId,
        projection_before: current,
        projection_after: oldAfter,
        sequence: nextSequence(oldEvents),
        reason: "rollback",
        trigger: { kind: "rollback", ref: resultBlob.ref, usage_ids: [] },
        write_id: rollbackView.intent.write_id,
        version_binding: rollbackView.intent.binding,
        now: timestamp
      });
    } catch {
      return err(illegalProjectionTransition(current.lifecycle, "disabled"));
    }
    const restoredFrozen = freezeEvent(restoredEvent);
    const oldFrozen = freezeEvent(oldEvent);
    const staged = stageBlobs(blobStore, [resultBlob, restoredFrozen.blob, oldFrozen.blob]);
    if (staged !== null) return err(staged);
    const committed = await commitRows({
      members: [
        lifecycleMember(restoredEvent, restoredFrozen.ref),
        lifecycleMember(oldEvent, oldFrozen.ref)
      ],
      blobs: [resultBlob, restoredFrozen.blob, oldFrozen.blob],
      apply: (tx) => {
        const inserted = projectionRowInsert(restored, tx);
        if (inserted !== null) return inserted;
        return projectionRowUpdate(oldAfter, current.row_version, tx, "rollback");
      }
    });
    if (!committed.ok) return err(committed.error);
    const complete = executor?.complete;
    if (complete !== undefined) {
      const reconciled = await complete({
        operation_id: operationId,
        write_id: rollbackView.intent.write_id
      });
      if (!reconciled.ok) return err(reconciled.error);
    }
    return ok({ projection: restored, write_id: rollbackView.intent.write_id });
  }

  return {
    commit: {
      recordAdoption,
      beginTrial,
      recordUsage,
      applyLifecycle,
      extendWindow,
      revoke,
      rollback
    },
    verifierRegistry,
    writeAdoption,
    hostFacts,
    readHostFacts
  };
}

/* ------------------------------------------------------------------ */
/* Internal construction helpers                                       */
/* ------------------------------------------------------------------ */

function lifecycleMember(
  event: ExperienceLifecycleEvent,
  eventBlob: SourceRef
): ReviewStateRowInput {
  return {
    row_schema: "rsi.experience_lifecycle_event_row/1",
    object_key: event.event_id,
    operation: "insert",
    row: objectRow(lifecycleEventRowFromEvent(event, eventBlob))
  };
}

function proposalAfterAdoption(
  proposal: Proposal,
  adoptionRef: SourceRef,
  now: number
): Proposal {
  return {
    ...proposal,
    state: "adopted",
    adoption_ref: String(adoptionRef),
    version: proposal.version + 1,
    updated_at: now
  };
}

async function adoptedVersionCacheRow(
  repository: ReviewRepository,
  experienceId: string,
  adoptedVersion: number
): Promise<ReviewStateRowInput | null> {
  const adopted = await repository.listAdoptedVersions(experienceId);
  if (adopted.length === 0) return null;
  const maximum = Math.max(...adopted);
  if (adoptedVersion === maximum) return null;
  const versions = await repository.listExperiences(experienceId);
  if (adoptedVersion > maximum) {
    const previous = versions.find((entry) => entry.version === maximum);
    if (previous === undefined || previous.superseded_by_version !== undefined) return null;
    return experienceCacheMember(previous, adoptedVersion);
  }
  const target = versions.find((entry) => entry.version === adoptedVersion);
  if (target === undefined || target.superseded_by_version !== undefined) return null;
  return experienceCacheMember(target, maximum);
}

function experienceCacheMember(experience: Experience, supersededBy: number): ReviewStateRowInput {
  const after: Experience = { ...experience, superseded_by_version: supersededBy };
  return {
    row_schema: "rsi.experience_row/1",
    object_key: `${experience.experience_id}:${String(experience.version)}`,
    operation: "update",
    row: objectRow(experienceRowFromExperience(after)),
    before: objectRow(experienceRowFromExperience(experience))
  };
}

function hostFactScopeError(
  facts: HostLifecycleFacts,
  projection: ExperienceProjection
): ErrorEnvelope | null {
  if (facts.host_id !== projection.host_id || facts.mode !== projection.mode) {
    return experienceHostFactsUnavailable("readHostLifecycleFacts");
  }
  return null;
}

/**
 * Minimal lifecycle-fact set for the predicates that do not read HOST facts.
 * HOST-dependent predicates are evaluated only after a successful fact read.
 */
function lifecycleFacts(
  projection: ExperienceProjection,
  plan: ValidationPlan,
  usages: readonly UsageVerificationRecord[],
  now: number
): Parameters<typeof evaluateLifecycle>[0] {
  return {
    projection,
    plan,
    usages,
    now,
    grant_valid: true,
    write_state: projection.write.write_state ?? "verified",
    readback_verified: true,
    current_goal_version: projection.adoption_binding.version_binding.goal_version,
    host_facts: null,
    host_facts_error: null,
    overlapping_regression: false,
    retention_policy: {
      invalidate_on_host_version_change: true,
      invalidate_on_tool_version_change: true,
      invalidate_on_model_family_change: true
    }
  };
}
