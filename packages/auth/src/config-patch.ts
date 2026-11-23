/**
 * Config-write patch hashing and validation (DD-FND-095.1, DD-FND-095.3).
 *
 * `patch_hash` binds the normalized field/path/protected-subtree patch, never
 * the final file bytes and never `expected_file_hash` or
 * `expected_config_version`, which move with unrelated external edits or a new
 * lock.
 */

import { canonicalHash, canonicalJsonText, compareUtf8, isHash, isId } from "@evoplug/core";
import type {
  ConfigAssignmentValue,
  ConfigFieldAssignment,
  ConfigFieldMutation,
  ConfigFilePath,
  ConfigWriteCommitRequest,
  ConfigWriteLockRequest,
  ConfigWritePatch,
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  VersionBinding,
} from "@evoplug/core";
import { CONFIG_WRITE_LOCK_TTL_MS, CONFIG_WRITE_MAX_CONTENT_BYTES, CONFIG_WRITE_SCHEMA_VERSION } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { fieldError } from "./errors.js";
import { validateRelativeTargetPath } from "./write-intent.js";

const CONFIG_LOCK_KEY_SCHEMA_VERSION: "rsi.config_lock_key/1" = "rsi.config_lock_key/1";

/** Lock TTL is fixed at 60 s (DD-FND-095.2); alias of the core constant. */
export const CONFIG_LOCK_TTL_MS: number = CONFIG_WRITE_LOCK_TTL_MS;

/** Parser output ceiling, 8 MiB. */
export { CONFIG_WRITE_MAX_CONTENT_BYTES };

/** Idempotency key shape for `ConfigWriteCommitRequest`. */
const CONFIG_IDEMPOTENCY_KEY_PATTERN: RegExp = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * `patch_hash = sha256(JCS({schema_version, config_space_id,
 * field_registry_snapshot_hash, layer_id, model_scope_key, target_path,
 * expected_fields, mutations, protected_subtrees, candidate_values}))`.
 */
export function configWritePatchHash(patch: Omit<ConfigWritePatch, "patch_hash">): Hash {
  return canonicalHash({
    schema_version: patch.schema_version,
    config_space_id: patch.config_space_id,
    field_registry_snapshot_hash: patch.field_registry_snapshot_hash,
    layer_id: patch.layer_id,
    model_scope_key: patch.model_scope_key,
    target_path: patch.target_path,
    expected_fields: patch.expected_fields.map(assignmentJson),
    mutations: patch.mutations.map(mutationJson),
    protected_subtrees: patch.protected_subtrees.map((subtree) => ({
      path: subtree.path,
      semantic_hash: subtree.semantic_hash
    })),
    candidate_values: patch.candidate_values.map(assignmentJson)
  });
}

/**
 * Validates ordering, coverage, candidate correspondence, path rules and the
 * stored `patch_hash`.
 *
 * `E_WRITE_CONFIG_PATCH` covers hash, ordering and field-set failures;
 * `E_WRITE_CONFIG_PATH` covers path and pointer failures.
 */
export function validateConfigWritePatch(
  patch: ConfigWritePatch
): Result<ConfigWritePatch, ErrorEnvelope> {
  if (patch.schema_version !== CONFIG_WRITE_SCHEMA_VERSION) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "schema_version", CONFIG_WRITE_SCHEMA_VERSION));
  }
  if (!isHash(patch.config_space_id)) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "config_space_id", "sha256"));
  }
  if (!isHash(patch.field_registry_snapshot_hash)) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "field_registry_snapshot_hash", "sha256"));
  }
  if (patch.layer_id.length === 0) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "layer_id", "non_empty"));
  }
  if (patch.model_scope_key.length === 0) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "model_scope_key", "non_empty"));
  }
  const targetPath = validateRelativeTargetPath(patch.target_path);
  if (!targetPath.ok) {
    return err(fieldError("E_WRITE_CONFIG_PATH", "target_path", "relative_path"));
  }

  const expected = indexAssignments(patch.expected_fields, "expected_fields");
  if (!expected.ok) {
    return expected;
  }
  const candidate = indexAssignments(patch.candidate_values, "candidate_values");
  if (!candidate.ok) {
    return candidate;
  }
  const mutations = checkMutations(patch.mutations);
  if (!mutations.ok) {
    return mutations;
  }
  const protectedSubtrees = checkProtectedSubtrees(patch);
  if (!protectedSubtrees.ok) {
    return protectedSubtrees;
  }

  const mutatedFields = new Set<string>();
  for (const mutation of mutations.value) {
    mutatedFields.add(mutation.field_id);
    if (!expected.value.has(mutation.field_id)) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "expected_fields", "covers_mutations"));
    }
    const candidateEntry = candidate.value.get(mutation.field_id);
    if (candidateEntry === undefined) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "candidate_values", "covers_mutations"));
    }
    const mismatch = candidateMatchesMutation(candidateEntry, mutation);
    if (mismatch !== null) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "candidate_values", mismatch));
    }
  }
  for (const fieldId of candidate.value.keys()) {
    if (!mutatedFields.has(fieldId)) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "candidate_values", "no_extra_fields"));
    }
  }

  let expectedRoot: string | null = null;
  let expectedFormat: string | null = null;
  const allAssignments: readonly (ConfigFieldAssignment | ConfigFieldMutation)[] = [
    ...patch.expected_fields,
    ...patch.candidate_values,
    ...patch.mutations
  ];
  for (const entry of allAssignments) {
    const pathResult = validateConfigFilePath(entry.path, patch.target_path);
    if (!pathResult.ok) {
      return pathResult;
    }
    if (expectedRoot === null) {
      expectedRoot = entry.path.root;
      expectedFormat = entry.path.format;
    } else if (entry.path.root !== expectedRoot || entry.path.format !== expectedFormat) {
      return err(fieldError("E_WRITE_CONFIG_PATH", "path", "uniform_root_and_format"));
    }
  }

  const recomputed = configWritePatchHash(patch);
  if (recomputed !== patch.patch_hash) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "patch_hash", "recomputed"));
  }
  return ok(patch);
}

/**
 * `request_hash` for `ConfigWritePort.commit`.
 *
 * Excludes `lock_handle`, `fencing_token`, `base_file_hash`, `idempotency_key`,
 * `deadline_ms`, the abort signal, `approved_root`, the root pin and timestamps.
 */
export function configWriteRequestHash(input: {
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
}): Hash {
  return canonicalHash({
    schema_version: CONFIG_WRITE_SCHEMA_VERSION,
    grant_id: input.grant_id,
    action: input.action,
    candidate_id: input.candidate_id,
    candidate_hash: input.candidate_hash,
    patch_hash: input.patch_hash,
    binding: {
      task_id: input.binding.task_id,
      branch_id: input.binding.branch_id,
      input_epoch: input.binding.input_epoch,
      goal_version: input.binding.goal_version,
      config_version: input.binding.config_version,
      watermark: input.binding.watermark
    },
    config_space_id: input.config_space_id,
    field_registry_snapshot_hash: input.field_registry_snapshot_hash,
    layer_id: input.layer_id,
    model_scope_key: input.model_scope_key,
    root_id: input.root_id,
    target_path: input.target_path,
    reason: input.reason
  });
}

/** `lock_key = sha256(JCS({schema_version:"rsi.config_lock_key/1",root_id,target_path}))`. */
export function configLockKey(rootId: string, targetPath: string): Hash {
  return canonicalHash({
    schema_version: CONFIG_LOCK_KEY_SCHEMA_VERSION,
    root_id: rootId,
    target_path: targetPath
  });
}

/** Validates the lock request up to the grant decision and root resolution. */
export function validateConfigWriteLockRequest(
  request: ConfigWriteLockRequest
): Result<ConfigWriteLockRequest, ErrorEnvelope> {
  if (request.schema_version !== CONFIG_WRITE_SCHEMA_VERSION) {
    return err(fieldError("E_SCHEMA", "schema_version", CONFIG_WRITE_SCHEMA_VERSION));
  }
  if (request.object_type !== "config") {
    return err(fieldError("E_SCHEMA", "object_type", "config"));
  }
  if (!isId(request.grant_id, "grant")) {
    return err(fieldError("E_SCHEMA", "grant_id", "grant_id"));
  }
  if (!isId(request.candidate_id, "ctr")) {
    return err(fieldError("E_WRITE_CANDIDATE_ID", "candidate_id", "ctr_id"));
  }
  if (!isHash(request.candidate_hash)) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "candidate_hash", "sha256"));
  }
  if (!isHash(request.config_space_id)) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "config_space_id", "sha256"));
  }
  if (!isHash(request.field_registry_snapshot_hash)) {
    return err(fieldError("E_WRITE_CONFIG_PATCH", "field_registry_snapshot_hash", "sha256"));
  }
  if (
    !Number.isSafeInteger(request.deadline_ms) ||
    request.deadline_ms < 1 ||
    request.deadline_ms > 600_000
  ) {
    return err(fieldError("E_SCHEMA", "deadline_ms", "1..600000"));
  }
  if (request.binding.config_version !== request.expected_config_version) {
    return err(fieldError("E_VERSION_BINDING", "expected_config_version", "binding_config_version"));
  }
  if (!(request.action === "update" && request.reason === "trial_write") &&
      !(request.action === "rollback" && request.reason === "trial_rollback")) {
    return err(fieldError("E_SCHEMA", "reason", "action_reason_pair"));
  }
  const targetPath = validateRelativeTargetPath(request.target_path);
  if (!targetPath.ok) {
    return targetPath;
  }
  if (request.approved_root.length === 0 || !request.approved_root.startsWith("/")) {
    return err(fieldError("E_WRITE_CONFIG_PATH", "approved_root", "absolute_realpath"));
  }
  return ok(request);
}

/** Validates the commit request envelope; the patch is validated separately. */
export function validateConfigWriteCommitRequest(
  request: ConfigWriteCommitRequest
): Result<ConfigWriteCommitRequest, ErrorEnvelope> {
  if (request.schema_version !== CONFIG_WRITE_SCHEMA_VERSION) {
    return err(fieldError("E_SCHEMA", "schema_version", CONFIG_WRITE_SCHEMA_VERSION));
  }
  if (!CONFIG_IDEMPOTENCY_KEY_PATTERN.test(request.idempotency_key)) {
    return err(fieldError("E_SCHEMA", "idempotency_key", "8..128_key_chars"));
  }
  if (!Number.isSafeInteger(request.fencing_token) || request.fencing_token < 1) {
    return err(fieldError("E_WRITE_CONFIG_STALE", "fencing_token", "positive_integer"));
  }
  if (!isHash(request.base_file_hash)) {
    return err(fieldError("E_WRITE_CONFIG_STALE", "base_file_hash", "sha256"));
  }
  if (
    !Number.isSafeInteger(request.deadline_ms) ||
    request.deadline_ms < 1 ||
    request.deadline_ms > 600_000
  ) {
    return err(fieldError("E_SCHEMA", "deadline_ms", "1..600000"));
  }
  if (request.lock_handle.length === 0) {
    return err(fieldError("E_WRITE_CONFIG_STALE", "lock_handle", "non_empty"));
  }
  return ok(request);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function indexAssignments(
  assignments: readonly ConfigFieldAssignment[],
  path: string
): Result<ReadonlyMap<string, ConfigFieldAssignment>, ErrorEnvelope> {
  const index = new Map<string, ConfigFieldAssignment>();
  let previous: string | null = null;
  for (const assignment of assignments) {
    if (!isId(assignment.field_id, "fld")) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", `${path}.field_id`, "fld_id"));
    }
    if (previous !== null && compareUtf8(previous, assignment.field_id) >= 0) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", path, "ascending_unique_field_id"));
    }
    previous = assignment.field_id;
    if (index.has(assignment.field_id)) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", path, "unique_field_id"));
    }
    index.set(assignment.field_id, assignment);
  }
  return ok(index);
}

function checkMutations(
  mutations: readonly ConfigFieldMutation[]
): Result<readonly ConfigFieldMutation[], ErrorEnvelope> {
  let previous: string | null = null;
  for (const mutation of mutations) {
    if (!isId(mutation.field_id, "fld")) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "mutations.field_id", "fld_id"));
    }
    const key = `${mutation.field_id}\u0000${canonicalJsonText(pathJson(mutation.path))}`;
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      return err(
        fieldError("E_WRITE_CONFIG_PATCH", "mutations", "ascending_unique_field_and_path")
      );
    }
    previous = key;
  }
  return ok(mutations);
}

function checkProtectedSubtrees(patch: ConfigWritePatch): Result<null, ErrorEnvelope> {
  let previous: string | null = null;
  for (const subtree of patch.protected_subtrees) {
    if (subtree.path.length === 0 || subtree.path.includes("\u0000")) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "protected_subtrees.path", "non_empty"));
    }
    if (!isHash(subtree.semantic_hash)) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "protected_subtrees.semantic_hash", "sha256"));
    }
    if (previous !== null && compareUtf8(previous, subtree.path) >= 0) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "protected_subtrees", "ascending_unique_path"));
    }
    previous = subtree.path;
  }
  return ok(null);
}

function candidateMatchesMutation(
  candidate: ConfigFieldAssignment,
  mutation: ConfigFieldMutation
): string | null {
  if (mutation.op === "set") {
    if (candidate.value.presence !== "present") {
      return "set_requires_present";
    }
    if (candidate.value.value !== mutation.value) {
      return "set_value_equals_mutation";
    }
    return null;
  }
  return candidate.value.presence === "absent" ? null : "remove_requires_absent";
}

function validateConfigFilePath(
  path: ConfigFilePath,
  targetPath: string
): Result<ConfigFilePath, ErrorEnvelope> {
  if (path.kind !== "file") {
    return err(fieldError("E_WRITE_CONFIG_PATH", "path.kind", "file"));
  }
  if (path.create) {
    return err(fieldError("E_WRITE_CONFIG_PATH", "path.create", "false"));
  }
  const relative = validateRelativeTargetPath(path.relative_path);
  if (!relative.ok) {
    return err(fieldError("E_WRITE_CONFIG_PATH", "path.relative_path", "relative_path"));
  }
  if (path.relative_path !== targetPath) {
    return err(fieldError("E_WRITE_CONFIG_PATH", "path.relative_path", "equals_target_path"));
  }
  if (path.pointer.length === 0 || !path.pointer.startsWith("/")) {
    return err(fieldError("E_WRITE_CONFIG_PATH", "path.pointer", "json_pointer"));
  }
  for (const segment of path.pointer.split("/").slice(1)) {
    if (segment === "-") {
      return err(fieldError("E_WRITE_CONFIG_PATH", "path.pointer", "no_array_append"));
    }
  }
  return ok(path);
}

function pathJson(path: ConfigFilePath): JsonValue {
  return {
    kind: path.kind,
    format: path.format,
    root: path.root,
    relative_path: path.relative_path,
    pointer: path.pointer,
    create: path.create
  };
}

function assignmentJson(assignment: ConfigFieldAssignment): JsonValue {
  return {
    field_id: assignment.field_id,
    path: pathJson(assignment.path),
    value: assignmentValueJson(assignment.value)
  };
}

function assignmentValueJson(value: ConfigAssignmentValue): JsonValue {
  return value.presence === "present"
    ? { presence: "present", value: value.value }
    : { presence: "absent" };
}

function mutationJson(mutation: ConfigFieldMutation): JsonValue {
  if (mutation.op === "set") {
    return {
      op: "set",
      field_id: mutation.field_id,
      path: pathJson(mutation.path),
      value: mutation.value
    };
  }
  return {
    op: "remove",
    field_id: mutation.field_id,
    path: pathJson(mutation.path)
  };
}
