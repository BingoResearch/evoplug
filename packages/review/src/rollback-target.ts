/**
 * Deterministic rollback target resolution (DD-REV-110, DD-REV-130).
 *
 * A rollback restores the managed content of one older adopted Experience
 * version. The resolver reads the adopted version chain, picks the target
 * projection with an explicit ORDER, then walks the frozen FND chain
 *
 *   adopted version -> projection.write_id -> write_result -> write_snapshot -> hash
 *
 * and refuses to guess: any missing link, any hash mismatch, any ambiguous
 * chain returns `E_ROLLBACK_TARGET_UNRESOLVED` before a writer is invoked.
 *
 * The restore snapshot itself belongs to the *current* (source) managed write,
 * because FND's `write.apply` rollback restores the snapshot taken before the
 * write it replaces. The resolver therefore requires that snapshot content to
 * equal the target version's written content; otherwise the chain does not
 * describe an adjacent, restorable state and the target stays unresolved.
 */

import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { err, makeErrorEnvelope, ok } from "@evoplug/core";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import type { ReviewRepository } from "./ports.js";
import type { ExperienceProjection } from "./types.js";

/** Frozen, fully validated rollback target. */
export interface ResolvedRollbackTarget {
  /** The older adopted projection selected for restore. */
  readonly target_projection: ExperienceProjection;
  /** The Experience version of {@link target_projection}. */
  readonly target_version: number;
  /** Write id of the target version; kept for audit and reconciliation. */
  readonly write_id: string;
  /** Snapshot of the source managed write that carries the restored bytes. */
  readonly snapshot_id: string;
  /** Snapshot record hash passed to FND `write.apply`. */
  readonly snapshot_hash: Hash;
  /** File hash of the restored bytes (whole_file mode). */
  readonly restored_file_hash: Hash | null;
  /** Managed-block content hash of the restored bytes (managed_block mode). */
  readonly restored_block_hash: Hash | null;
  /** Current file hash the source write must still observe before restoring. */
  readonly expected_current_file_hash: Hash;
  /** Current managed-block hash the source write must still observe. */
  readonly expected_current_block_hash: Hash | null;
  readonly write_mode: "whole_file" | "managed_block";
}

export interface RollbackTargetResolverInput {
  readonly projection: ExperienceProjection;
  readonly target_version?: number;
}

export interface RollbackTargetResolverOptions {
  readonly connection: SqliteConnection;
  readonly repository: Pick<
    ReviewRepository,
    "listAdoptedVersions" | "getProjection" | "listProjections"
  >;
}

export type RollbackTargetResolver = (
  input: RollbackTargetResolverInput
) => Promise<Result<ResolvedRollbackTarget, ErrorEnvelope>>;

/**
 * `E_ROLLBACK_TARGET_UNRESOLVED` is defined by the closure task book and its
 * registry row is added by the integration owner. Building the envelope
 * directly keeps the named code (never `E_INTERNAL`) until the row lands.
 */
export function rollbackTargetUnresolved(_path: string, _rule: string): ErrorEnvelope {
  /* The registry row is `category=not_found`, `details_kind=none`,
   * `stage=rollback_resolution`; the internal diagnostic stays out of the
   * wire envelope so the code, category, stage and details all match it. */
  return makeErrorEnvelope({
    code: "E_ROLLBACK_TARGET_UNRESOLVED" as ErrorEnvelope["code"],
    category: "not_found",
    retryable: false,
    side_effect: "none",
    message_key: "error.e_rollback_target_unresolved",
    details: { kind: "none" },
    stage: "rollback_resolution"
  });
}

/**
 * A read failure is not an unresolvable chain, but it is still a refusal: the
 * resolver returns an error envelope and never reaches a writer.
 */
export function rollbackTargetStorageError(operation: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STORAGE_UNAVAILABLE",
    category: "storage",
    retryable: true,
    side_effect: "none",
    message_key: "error.storage_unavailable",
    details: { kind: "storage", operation },
    stage: "rollback"
  });
}

function rowString(row: SqlRow | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

function isHash(value: string | null): value is Hash {
  return value !== null && /^sha256:[0-9a-f]{64}$/.test(value);
}

interface WriteResultChainRow {
  readonly state: string | null;
  readonly readback_verified: number | null;
  readonly snapshot_id: string | null;
  readonly new_file_hash: string | null;
  readonly new_block_hash: string | null;
}

function latestWriteResult(
  connection: SqliteConnection,
  writeId: string
): WriteResultChainRow | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT state, readback_verified, snapshot_id, new_file_hash, new_block_hash
         FROM write_result
        WHERE write_id = :write_id
        ORDER BY attempt DESC
        LIMIT 1`
    )
    .get({ write_id: writeId });
  if (row === undefined) return null;
  const state = rowString(row, "state");
  const readback = row["readback_verified"];
  return {
    state,
    readback_verified: typeof readback === "number" ? readback : null,
    snapshot_id: rowString(row, "snapshot_id"),
    new_file_hash: rowString(row, "new_file_hash"),
    new_block_hash: rowString(row, "new_block_hash")
  };
}

/**
 * Builds the resolver. Every call is read-only; it never opens a writer, never
 * touches the journal and never mutates the projection.
 */
export function createRollbackTargetResolver(
  options: RollbackTargetResolverOptions
): RollbackTargetResolver {
  return async (input) => {
    try {
      return await resolveRollbackTarget(options, input);
    } catch (error) {
      return err(
        rollbackTargetStorageError(
          `rollback_target:${error instanceof Error ? error.name : "unknown"}`
        )
      );
    }
  };
}

async function resolveRollbackTarget(
  options: RollbackTargetResolverOptions,
  input: RollbackTargetResolverInput
): Promise<Result<ResolvedRollbackTarget, ErrorEnvelope>> {
  const current = input.projection;
  const experienceId = current.experience_id;

  const adopted = [...(await options.repository.listAdoptedVersions(experienceId))]
    .filter((version) => Number.isSafeInteger(version) && version >= 1)
    .sort((left, right) => left - right);

  let candidates: number[];
  if (input.target_version !== undefined) {
    if (!Number.isSafeInteger(input.target_version) || input.target_version < 1) {
      return err(rollbackTargetUnresolved("target_version", "positive_safe_integer"));
    }
    if (input.target_version >= current.experience_version) {
      return err(rollbackTargetUnresolved("target_version", "must_be_older"));
    }
    if (!adopted.includes(input.target_version)) {
      return err(rollbackTargetUnresolved("target_version", "not_adopted"));
    }
    candidates = [input.target_version];
  } else {
    /* Nearest first. A version whose frozen chain cannot be parsed is skipped
     * so an older, parseable adopted version can still be restored; the task
     * asks for the nearest adopted *and resolvable* version. */
    candidates = adopted
      .filter((version) => version < current.experience_version)
      .sort((left, right) => right - left);
    if (candidates.length === 0) {
      return err(rollbackTargetUnresolved("adopted_chain", "no_older_adopted_version"));
    }
  }

  let firstError: ErrorEnvelope | null = null;
  for (const targetVersion of candidates) {
    const resolved = await resolveRollbackVersion(options, current, targetVersion);
    if (resolved.ok) return resolved;
    if (firstError === null) firstError = resolved.error;
    if (input.target_version !== undefined) return resolved;
  }
  return err(firstError ?? rollbackTargetUnresolved("adopted_chain", "no_resolvable_target"));
}

/**
 * Resolves and validates the complete frozen chain for one adopted version:
 *
 *   target projection -> write_id -> verified write_result -> source
 *   write snapshot/hash -> target content hash
 *
 * FND `write.apply` rollback is whole-file only, so a `managed_block` target is
 * deliberately not resolvable here; the resolver must not hand the executor a
 * target the writer can never execute.
 */
async function resolveRollbackVersion(
  options: RollbackTargetResolverOptions,
  current: ExperienceProjection,
  targetVersion: number
): Promise<Result<ResolvedRollbackTarget, ErrorEnvelope>> {
  const experienceId = current.experience_id;

  /* Deterministic ORDER: the newest projection for the exact same managed
   * target wins; `projection_id` breaks remaining ties. Revoked projections
   * are never restore candidates. */
  const rows = options.connection
    .prepare<SqlRow>(
      `SELECT projection_id
         FROM experience_projections
        WHERE experience_id = :experience_id
          AND experience_version = :experience_version
          AND host_id = :host_id
          AND config_space = :config_space
          AND mode = :mode
          AND object_type = :object_type
          AND path_or_block = :path_or_block
          AND block_id IS :block_id
          AND lifecycle <> 'revoked'
        ORDER BY created_at DESC, projection_id ASC
        LIMIT 2`
    )
    .all({
      experience_id: experienceId,
      experience_version: targetVersion,
      host_id: current.host_id,
      config_space: current.config_space,
      mode: current.mode,
      object_type: current.object_type,
      path_or_block: current.path_or_block,
      block_id: current.block_id
    });
  const first = rows[0];
  const targetProjectionId = first === undefined ? null : rowString(first, "projection_id");
  if (targetProjectionId === null) {
    return err(rollbackTargetUnresolved("target_projection", "missing"));
  }
  const target = await options.repository.getProjection(targetProjectionId);
  if (target === null) {
    return err(rollbackTargetUnresolved("target_projection", "missing"));
  }

  /* Link 1: target projection -> write id. */
  const targetWriteId = target.write.write_id;
  if (typeof targetWriteId !== "string" || targetWriteId.length === 0) {
    return err(rollbackTargetUnresolved("target_projection.write.write_id", "required"));
  }

  /* Link 2: write intent + verified result of the target write. */
  const targetIntent = options.connection
    .prepare<SqlRow>(
      `SELECT write_mode, object_type, target_path
         FROM write_intent
        WHERE write_id = :write_id`
    )
    .get({ write_id: targetWriteId });
  if (targetIntent === undefined) {
    return err(rollbackTargetUnresolved("target_write.intent", "missing"));
  }
  const writeMode = rowString(targetIntent, "write_mode");
  if (writeMode !== "whole_file") {
    return err(rollbackTargetUnresolved("target_write.write_mode", "whole_file"));
  }
  const targetResult = latestWriteResult(options.connection, targetWriteId);
  if (
    targetResult === null ||
    targetResult.state !== "verified" ||
    targetResult.readback_verified !== 1
  ) {
    return err(rollbackTargetUnresolved("target_write.result", "verified_readback_required"));
  }
  const targetContentHash = targetResult.new_file_hash;
  if (!isHash(targetContentHash)) {
    return err(rollbackTargetUnresolved("target_write.new_file_hash", "sha256_required"));
  }
  if (
    target.write.written_file_hash !== undefined &&
    target.write.written_file_hash !== targetContentHash
  ) {
    return err(
      rollbackTargetUnresolved("target_projection.write.written_file_hash", "result_mismatch")
    );
  }

  /* Link 3: the source managed write that took the snapshot to restore. */
  const sourceWriteId = current.write.write_id;
  if (typeof sourceWriteId !== "string" || sourceWriteId.length === 0) {
    return err(rollbackTargetUnresolved("source_projection.write.write_id", "required"));
  }
  const sourceResult = latestWriteResult(options.connection, sourceWriteId);
  if (
    sourceResult === null ||
    sourceResult.state !== "verified" ||
    sourceResult.readback_verified !== 1
  ) {
    return err(rollbackTargetUnresolved("source_write.result", "verified_readback_required"));
  }
  const expectedCurrentFileHash = sourceResult.new_file_hash;
  if (!isHash(expectedCurrentFileHash)) {
    return err(rollbackTargetUnresolved("source_write.new_file_hash", "sha256_required"));
  }
  if (
    current.write.written_file_hash !== undefined &&
    current.write.written_file_hash !== expectedCurrentFileHash
  ) {
    return err(
      rollbackTargetUnresolved("source_projection.write.written_file_hash", "result_mismatch")
    );
  }
  const snapshotId = sourceResult.snapshot_id;
  if (snapshotId === null || snapshotId.length === 0) {
    return err(rollbackTargetUnresolved("source_write.snapshot_id", "required"));
  }

  /* Link 4: snapshot row ownership + hash. */
  const snapshot = options.connection
    .prepare<SqlRow>(
      `SELECT write_id, write_mode, file_hash, block_content_hash, snapshot_hash
         FROM write_snapshot
        WHERE snapshot_id = :snapshot_id`
    )
    .get({ snapshot_id: snapshotId });
  if (snapshot === undefined) {
    return err(rollbackTargetUnresolved("source_write.snapshot_id", "missing"));
  }
  if (rowString(snapshot, "write_id") !== sourceWriteId) {
    return err(rollbackTargetUnresolved("source_write.snapshot_id", "belongs_to_source_write"));
  }
  if (rowString(snapshot, "write_mode") !== writeMode) {
    return err(rollbackTargetUnresolved("source_write.snapshot_id", "write_mode_mismatch"));
  }
  const snapshotHash = rowString(snapshot, "snapshot_hash");
  if (!isHash(snapshotHash)) {
    return err(rollbackTargetUnresolved("source_write.snapshot_hash", "sha256_required"));
  }
  const snapshotFileHash = rowString(snapshot, "file_hash");
  if (!isHash(snapshotFileHash)) {
    return err(rollbackTargetUnresolved("source_write.snapshot.file_hash", "sha256_required"));
  }

  /* Link 5: restored content must equal the target version's content. */
  if (snapshotFileHash !== targetContentHash) {
    return err(rollbackTargetUnresolved("snapshot.file_hash", "target_content_mismatch"));
  }

  return ok({
    target_projection: target,
    target_version: targetVersion,
    write_id: targetWriteId,
    snapshot_id: snapshotId,
    snapshot_hash: snapshotHash,
    restored_file_hash: snapshotFileHash,
    restored_block_hash: null,
    expected_current_file_hash: expectedCurrentFileHash,
    expected_current_block_hash: null,
    write_mode: writeMode
  });
}
