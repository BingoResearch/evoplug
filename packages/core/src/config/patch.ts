/**
 * Structured config patches and the pure apply port (DD-CFG-043 … DD-CFG-056,
 * DD-CFG-171).
 *
 * A patch is a closed preview frozen at plan time: expected field values,
 * mutations, protected subtree hashes and candidate values. Apply only sees
 * locked base bytes; it never reads a file, the clock, the environment or a
 * grant.
 */

import { hashBytes, type Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type {
  ConfigFieldAssignment,
  ConfigFieldMutation,
  ConfigFilePath,
  ConfigPatchApplyFailure,
  ConfigPatchApplyInput,
  ConfigPatchApplyOutput,
  ConfigPatchApplyResult,
  ConfigProtectedSubtree,
  ConfigProtectedSubtreeProof,
  ConfigWritePatch
} from "../ports/config-write.js";
import type { AssignmentValue, ConfigPath, ConfigResult, TrialFieldChange } from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import { computeFileSemanticHash, computePatchHash } from "./hash.js";
import { sortUtf8 } from "../canonical.js";
import { formatForPath, getNode, parseDocument, removeNode, scalarNode, serializeDocument, setNode, treeEquals, type DocumentFormat } from "./semantic-tree.js";
import type { SemanticTree } from "./hash.js";


/* ------------------------------------------------------------------ */
/* Building patch previews                                             */
/* ------------------------------------------------------------------ */

interface BuildPatchesInput {
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  layer_id: string;
  model_scope_key: string;
  target_path: ConfigFilePath;
  changes: readonly TrialFieldChange[];
  field_paths: ReadonlyMap<string, ConfigPath>;
  protected_subtrees: readonly ConfigProtectedSubtree[];
}

function toFieldPath(fieldId: string, path: ConfigPath | undefined): ConfigResult<ConfigFilePath> {
  if (path === undefined) {
    return fail(configError("E_CFG_FIELD_UNKNOWN", { field_id: fieldId }));
  }
  if (path.kind !== "file") {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: fieldId, details: [{ key: "path_kind", value: path.kind }] }));
  }
  return succeed(path);
}

function sameFile(left: ConfigFilePath, right: ConfigFilePath): boolean {
  return left.root === right.root && left.relative_path === right.relative_path && left.format === right.format;
}

function assignment(fieldId: string, path: ConfigFilePath, value: AssignmentValue): ConfigFieldAssignment {
  return { field_id: fieldId as Id<"fld">, path, value };
}

function mutationFor(change: TrialFieldChange, path: ConfigFilePath): ConfigFieldMutation {
  if (change.candidate.presence === "absent") {
    return { op: "remove", field_id: change.field_id, path };
  }
  return { op: "set", field_id: change.field_id, path, value: change.candidate.value };
}

interface PatchParts {
  expected_fields: ConfigFieldAssignment[];
  mutations: ConfigFieldMutation[];
  candidate_values: ConfigFieldAssignment[];
}

function partsFor(
  changes: readonly TrialFieldChange[],
  fieldPaths: ReadonlyMap<string, ConfigPath>,
  target: ConfigFilePath,
  reversed: boolean
): ConfigResult<PatchParts> {
  const expected: ConfigFieldAssignment[] = [];
  const candidates: ConfigFieldAssignment[] = [];
  const mutations: ConfigFieldMutation[] = [];
  for (const change of changes) {
    const path = toFieldPath(change.field_id, fieldPaths.get(change.field_id));
    if (!path.ok) {
      return fail(path.error);
    }
    if (!sameFile(path.value, target)) {
      return fail(configError("E_CFG_MULTI_FILE_FACTOR", { field_id: change.field_id }));
    }
    const before = reversed ? change.candidate : change.baseline;
    const after = reversed ? change.baseline : change.candidate;
    expected.push(assignment(change.field_id, path.value, before));
    candidates.push(assignment(change.field_id, path.value, after));
    mutations.push(reversed ? reverseMutation(change, path.value) : mutationFor(change, path.value));
  }
  return succeed({ expected_fields: expected, mutations, candidate_values: candidates });
}

function reverseMutation(change: TrialFieldChange, path: ConfigFilePath): ConfigFieldMutation {
  if (change.baseline.presence === "absent") {
    return { op: "remove", field_id: change.field_id, path };
  }
  return { op: "set", field_id: change.field_id, path, value: change.baseline.value };
}

/**
 * Builds the forward and reverse patch previews. Both hashes are frozen into
 * the plan; a patch is never recomputed after sealing.
 */
export function buildWritePatches(input: BuildPatchesInput): ConfigResult<{
  write: ConfigWritePatch;
  rollback: ConfigWritePatch;
}> {
  const forward = partsFor(input.changes, input.field_paths, input.target_path, false);
  if (!forward.ok) {
    return fail(forward.error);
  }
  const reverse = partsFor(input.changes, input.field_paths, input.target_path, true);
  if (!reverse.ok) {
    return fail(reverse.error);
  }
  const base = {
    schema_version: "rsi.config_write/1" as const,
    config_space_id: input.config_space_id,
    field_registry_snapshot_hash: input.field_registry_snapshot_hash,
    layer_id: input.layer_id,
    model_scope_key: input.model_scope_key,
    target_path: input.target_path.relative_path,
    protected_subtrees: [...input.protected_subtrees]
  };
  const writeBody = { ...base, ...forward.value };
  const rollbackBody = { ...base, ...reverse.value };
  return succeed({
    write: { ...writeBody, patch_hash: computePatchHash(writeBody) },
    rollback: { ...rollbackBody, patch_hash: computePatchHash(rollbackBody) }
  });
}

/** Verifies a patch's stored hash (DD-CFG-054). */
export function verifyPatchHash(patch: ConfigWritePatch): ConfigResult<void> {
  if (computePatchHash(patch) !== patch.patch_hash) {
    return fail(configError("E_CFG_FIELD_CONFLICT", { details: [{ key: "patch_hash", value: "mismatch" }] }));
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

function failure(reason: ConfigPatchApplyFailure["reason"], fieldId: string | null, path: string | null): ConfigPatchApplyResult {
  return { ok: false, status: "rejected", error: { reason, field_id: fieldId as Id<"fld"> | null, path } };
}

function assignmentMatches(node: SemanticTree | undefined, expected: AssignmentValue): boolean {
  if (expected.presence === "absent") {
    return node === undefined;
  }
  if (node === undefined || node.kind !== "scalar") {
    return false;
  }
  const expectedNode = scalarNode(expected.value);
  return treeEquals(node, expectedNode);
}

function fieldPointer(path: ConfigFilePath): string {
  return path.pointer;
}

export interface ApplyOptions {
  /** Physical file root; the patch carries no root, only a relative path. */
  root: "user" | "project" | "managed" | "session";
  /**
   * Concrete syntax of the bound file. `ConfigWritePatch` carries only a
   * relative path, so the port instance supplies the format; without it the
   * extension decides and `.jsonc` content in a `.json` file is not accepted.
   */
  format?: DocumentFormat;
}

function protectedProof(tree: SemanticTree, subtrees: readonly ConfigProtectedSubtree[], after: SemanticTree): ConfigProtectedSubtreeProof[] | null {
  const proofs: ConfigProtectedSubtreeProof[] = [];
  for (const subtree of subtrees) {
    const beforeNode = getNode(tree, subtree.path);
    const afterNode = getNode(after, subtree.path);
    if (beforeNode === undefined || afterNode === undefined) {
      return null;
    }
    const beforeHash = semanticHashOfNode(beforeNode);
    const afterHash = semanticHashOfNode(afterNode);
    proofs.push({
      path: subtree.path,
      expected_semantic_hash: subtree.semantic_hash,
      before_semantic_hash: beforeHash,
      after_semantic_hash: afterHash
    });
    if (beforeHash !== subtree.semantic_hash) {
      return null;
    }
  }
  return proofs;
}

/**
 * Semantic hash of one protected subtree. The file identity is fixed so the
 * value is comparable before and after the patch; callers use the same
 * function when freezing `protected_subtrees`.
 */
export function computeProtectedSubtreeHash(node: SemanticTree): Hash {
  return computeFileSemanticHash({ format: "json", root: "user", relative_path: "" }, node);
}

function semanticHashOfNode(node: SemanticTree): Hash {
  return computeProtectedSubtreeHash(node);
}

/**
 * Applies a frozen patch to locked base bytes. The transform is pure: parse,
 * verify expected values, apply mutations, verify protected subtrees, verify
 * candidate values, serialize.
 */
export async function applyConfigPatch(
  input: ConfigPatchApplyInput,
  options: ApplyOptions = { root: "user" }
): Promise<ConfigPatchApplyResult> {
  const observedHash = hashBytes(input.base_bytes);
  if (observedHash !== input.base_file_hash) {
    return failure("expected_field_mismatch", null, input.patch.target_path);
  }
  const format = options.format ?? formatForPath(input.patch.target_path);
  if (format === null) {
    return failure("path_invalid", null, input.patch.target_path);
  }
  const parsed = parseDocument(input.base_bytes, format);
  if (!parsed.ok) {
    return failure("parser_failed", null, input.patch.target_path);
  }
  const before = parsed.value.tree;
  for (const expected of input.patch.expected_fields) {
    const node = getNode(before, fieldPointer(expected.path));
    if (!assignmentMatches(node, expected.value)) {
      return failure("expected_field_mismatch", expected.field_id, expected.path.relative_path);
    }
  }
  let working = before;
  for (const mutation of input.patch.mutations) {
    if (mutation.op === "set") {
      const next = setNode(working, fieldPointer(mutation.path), scalarNode(mutation.value), mutation.path.create);
      if (!next.ok) {
        return failure("path_invalid", mutation.field_id, mutation.path.relative_path);
      }
      working = next.value;
      continue;
    }
    const removed = removeNode(working, fieldPointer(mutation.path));
    if (!removed.ok) {
      return failure("expected_field_mismatch", mutation.field_id, mutation.path.relative_path);
    }
    working = removed.value;
  }
  for (const candidate of input.patch.candidate_values) {
    const node = getNode(working, fieldPointer(candidate.path));
    if (!assignmentMatches(node, candidate.value)) {
      return failure("candidate_mismatch", candidate.field_id, candidate.path.relative_path);
    }
  }
  const proofs = protectedProof(before, input.patch.protected_subtrees, working);
  if (proofs === null) {
    return failure("protected_subtree_mismatch", null, input.patch.target_path);
  }
  const serialized = serializeDocument(working, format);
  if (!serialized.ok) {
    return failure("serializer_failed", null, input.patch.target_path);
  }
  const output: ConfigPatchApplyOutput = {
    new_content: serialized.value,
    candidate_content_hash: hashBytes(serialized.value),
    new_semantic_hash: computeFileSemanticHash(
      { format, root: options.root, relative_path: input.patch.target_path },
      working
    ),
    applied_fields: sortUtf8(input.patch.candidate_values, (assignment) => assignment.field_id),
    protected_subtrees_verified: true,
    protected_subtree_proof: proofs
  };
  return { ok: true, status: "ok", value: output };
}

/* ------------------------------------------------------------------ */
/* Tree helpers used by tests and callers                              */
/* ------------------------------------------------------------------ */

