/**
 * Config-write patch hashing and validation (DD-FND-095.1, DD-FND-095.3).
 *
 * `patch_hash` binds the normalized field/path/protected-subtree patch, never
 * the final file bytes and never `expected_file_hash` or
 * `expected_config_version`, which move with unrelated external edits or a new
 * lock.
 */
import type { ConfigWriteCommitRequest, ConfigWriteLockRequest, ConfigWritePatch, ErrorEnvelope, Hash, Result, VersionBinding } from "@evoplug/core";
import { CONFIG_WRITE_MAX_CONTENT_BYTES } from "@evoplug/core";
export declare const CONFIG_LOCK_KEY_SCHEMA_VERSION: "rsi.config_lock_key/1";
/** Lock TTL is fixed at 60 s (DD-FND-095.2); alias of the core constant. */
export declare const CONFIG_LOCK_TTL_MS: number;
/** Parser output ceiling, 8 MiB. */
export { CONFIG_WRITE_MAX_CONTENT_BYTES };
/** Idempotency key shape for `ConfigWriteCommitRequest`. */
export declare const CONFIG_IDEMPOTENCY_KEY_PATTERN: RegExp;
/**
 * `patch_hash = sha256(JCS({schema_version, config_space_id,
 * field_registry_snapshot_hash, layer_id, model_scope_key, target_path,
 * expected_fields, mutations, protected_subtrees, candidate_values}))`.
 */
export declare function configWritePatchHash(patch: Omit<ConfigWritePatch, "patch_hash">): Hash;
/**
 * Validates ordering, coverage, candidate correspondence, path rules and the
 * stored `patch_hash`.
 *
 * `E_WRITE_CONFIG_PATCH` covers hash, ordering and field-set failures;
 * `E_WRITE_CONFIG_PATH` covers path and pointer failures.
 */
export declare function validateConfigWritePatch(patch: ConfigWritePatch): Result<ConfigWritePatch, ErrorEnvelope>;
/**
 * `request_hash` for `ConfigWritePort.commit`.
 *
 * Excludes `lock_handle`, `fencing_token`, `base_file_hash`, `idempotency_key`,
 * `deadline_ms`, the abort signal, `approved_root`, the root pin and timestamps.
 */
export declare function configWriteRequestHash(input: {
    grant_id: string;
    action: "update" | "rollback";
    candidate_id: string;
    candidate_hash: Hash;
    patch_hash: Hash;
    binding: VersionBinding;
    config_space_id: Hash;
    field_registry_snapshot_hash: Hash;
    layer_id: string;
    model_scope_key: string;
    root_id: string;
    target_path: string;
    reason: "trial_write" | "trial_rollback";
}): Hash;
/** `lock_key = sha256(JCS({schema_version:"rsi.config_lock_key/1",root_id,target_path}))`. */
export declare function configLockKey(rootId: string, targetPath: string): Hash;
/** Validates the lock request up to the grant decision and root resolution. */
export declare function validateConfigWriteLockRequest(request: ConfigWriteLockRequest): Result<ConfigWriteLockRequest, ErrorEnvelope>;
/** Validates the commit request envelope; the patch is validated separately. */
export declare function validateConfigWriteCommitRequest(request: ConfigWriteCommitRequest): Result<ConfigWriteCommitRequest, ErrorEnvelope>;
