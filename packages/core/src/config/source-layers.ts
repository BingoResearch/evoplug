/**
 * Source layers, config spaces and effective-layer resolution (DD-CFG-040 …
 * DD-CFG-046, DD-CFG-184, DD-CFG-191).
 *
 * One field has exactly one effective layer. A plan selects an explicit
 * writable layer; there is no "highest layer at runtime" target.
 */

import type { Hash } from "../hash.js";
import type { ConfigFilePath } from "../ports/config-write.js";
import type {
  AssignmentValue,
  ConfigResult,
  ConfigSpaceSnapshot,
  ConfigSpaceSelector,
  FieldReadback,
  FieldSpec,
  FileState,
  SourceLayerSpec
} from "./types.js";
import type { SemanticTree } from "./hash.js";
import {
  computeConfigSemanticHash,
  computeFileSemanticHash,
  fileContentHash,
  sortByLayerId
} from "./hash.js";
import { configError, fail, succeed } from "./errors.js";
import { assignmentValueKey, configPathKey, isValidConfigPath } from "./values.js";
import { effectiveLayer } from "./registry.js";

/* ------------------------------------------------------------------ */
/* Layer selection                                                     */
/* ------------------------------------------------------------------ */

export interface SelectedLayer {
  layer: SourceLayerSpec;
  path: ConfigFilePath;
}

/**
 * Selects the explicitly requested writable file layer (DD-CFG-040, DD-CFG-041).
 * Managed layers are never writable; a project layer with a trust gate needs
 * host trust evidence.
 */
export function selectWritableLayer(
  spec: FieldSpec,
  layerId: string,
  trustEvidencePresent: boolean
): ConfigResult<SelectedLayer> {
  const layer = spec.source_layers.find((candidate) => candidate.layer_id === layerId);
  if (layer === undefined) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { field_id: spec.field_id, details: [{ key: "layer_id", value: layerId }] }));
  }
  if (!spec.precedence.includes(layerId)) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { field_id: spec.field_id, details: [{ key: "layer_id", value: layerId }] }));
  }
  if (layer.path.kind !== "file") {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id, details: [{ key: "path_kind", value: layer.path.kind }] }));
  }
  if (!layer.writable || layer.path.root === "managed") {
    return fail(configError("E_CFG_FORBIDDEN_FIELD", { field_id: spec.field_id, details: [{ key: "layer_id", value: layerId }] }));
  }
  if (layer.trust_gate === "project_trust_required" && !trustEvidencePresent) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { field_id: spec.field_id, details: [{ key: "trust_gate", value: "missing" }] }));
  }
  if (!isValidConfigPath(layer.path)) {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id }));
  }
  return succeed({ layer, path: layer.path });
}

/** Effective layer of a field, used for baseline reads. */
export function effectiveSourceLayer(spec: FieldSpec): SourceLayerSpec | null {
  return effectiveLayer(spec);
}

/** True when a higher-precedence layer shadows the selected layer (DD-CFG-050). */
export function isShadowedByHigherLayer(spec: FieldSpec, selectedLayerId: string): boolean {
  const selected = spec.source_layers.find((layer) => layer.layer_id === selectedLayerId);
  if (selected === undefined) {
    return true;
  }
  for (const layerId of spec.precedence) {
    if (layerId === selectedLayerId) {
      return false;
    }
    const layer = spec.source_layers.find((candidate) => candidate.layer_id === layerId);
    if (layer !== undefined && layer.precedence_rank < selected.precedence_rank) {
      return true;
    }
  }
  return false;
}

/** Every writable file layer in precedence order (highest first). */
export function writableLayers(spec: FieldSpec): readonly SourceLayerSpec[] {
  const ordered: SourceLayerSpec[] = [];
  for (const layerId of spec.precedence) {
    const layer = spec.source_layers.find((candidate) => candidate.layer_id === layerId);
    if (layer !== undefined && layer.writable && layer.path.kind === "file" && layer.path.root !== "managed") {
      ordered.push(layer);
    }
  }
  return ordered;
}

/* ------------------------------------------------------------------ */
/* File and config semantic hashing                                    */
/* ------------------------------------------------------------------ */

export function buildFileState(input: {
  path: ConfigFilePath;
  bytes: Uint8Array | null;
  tree: SemanticTree | null;
  parser_id: string;
  parser_version: string;
}): FileState {
  if (input.bytes === null || input.tree === null) {
    return {
      path: input.path,
      exists: false,
      content_hash: null,
      semantic_hash: null,
      parser_id: input.parser_id,
      parser_version: input.parser_version
    };
  }
  return {
    path: input.path,
    exists: true,
    content_hash: fileContentHash(input.bytes),
    semantic_hash: computeFileSemanticHash(input.path, input.tree),
    parser_id: input.parser_id,
    parser_version: input.parser_version
  };
}

/** `config_version` and `semantic_hash` are both compared (DD-CFG-042). */
export function isStaleBaseline(
  snapshot: ConfigSpaceSnapshot,
  expectedConfigVersion: string,
  expectedSemanticHash: Hash
): boolean {
  return snapshot.config_version !== expectedConfigVersion || snapshot.semantic_hash !== expectedSemanticHash;
}

export function configSpaceSemanticHash(
  selector: ConfigSpaceSelector,
  values: ConfigSpaceSnapshot["values"],
  files: readonly FileState[]
): Hash {
  return computeConfigSemanticHash({
    config_space_id: selector.config_space_id,
    source_layer_set_hash: selector.source_layer_set_hash,
    values,
    files: files.map((file) => ({
      path: { format: file.path.format, root: file.path.root, relative_path: file.path.relative_path },
      exists: file.exists,
      content_hash: file.content_hash,
      semantic_hash: file.semantic_hash
    }))
  });
}

/** Verifies a captured snapshot's semantic hash (DD-CFG-184). */
export function verifyConfigSpaceSnapshot(snapshot: ConfigSpaceSnapshot): ConfigResult<void> {
  const recomputed = computeConfigSemanticHash({
    config_space_id: snapshot.config_space.config_space_id,
    source_layer_set_hash: snapshot.config_space.source_layer_set_hash,
    values: snapshot.values,
    files: snapshot.files.map((file) => ({
      path: { format: file.path.format, root: file.path.root, relative_path: file.path.relative_path },
      exists: file.exists,
      content_hash: file.content_hash,
      semantic_hash: file.semantic_hash
    }))
  });
  if (recomputed !== snapshot.semantic_hash) {
    return fail(configError("E_CFG_STALE_BASELINE"));
  }
  return succeed(undefined);
}

/** Unique physical file key: `(root, relative_path, format)`. */
export function fileKey(path: ConfigFilePath): string {
  return `${path.root}\u0000${path.relative_path}\u0000${path.format}`;
}

/** Rejects two `FileState`s for the same physical file. */
export function validateFileSet(files: readonly FileState[]): ConfigResult<void> {
  const seen = new Set<string>();
  for (const file of files) {
    const key = fileKey(file.path);
    if (seen.has(key)) {
      return fail(configError("E_CFG_FIELD_TYPE", { path: file.path.relative_path, details: [{ key: "duplicate_file", value: file.path.relative_path }] }));
    }
    seen.add(key);
    if (!isValidConfigPath(file.path)) {
      return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { path: file.path.relative_path }));
    }
  }
  return succeed(undefined);
}

/** Readback acceptance: exact or normalized equality (DD-CFG-048). */
export function readbackAccepted(
  readback: FieldReadback,
  expected: AssignmentValue,
  comparison: "exact" | "normalized_equal",
  normalizedKey?: (value: AssignmentValue) => string
): boolean {
  if (comparison === "exact") {
    return assignmentValueKey(readback.observed) === assignmentValueKey(expected);
  }
  if (normalizedKey === undefined) {
    // `normalized_equal` cannot be proved without the field's normalizer;
    // treating it as accepted would claim evidence the caller does not have.
    return false;
  }
  return normalizedKey(readback.observed) === normalizedKey(expected);
}

/** Readback equals the baseline after a successful write (DD-CFG-049). */
export function readbackIsBaseline(readback: FieldReadback, baseline: AssignmentValue): boolean {
  return assignmentValueKey(readback.observed) === assignmentValueKey(baseline);
}

/** Stable layer ordering helper for reports. */
export function orderedLayers(layers: readonly SourceLayerSpec[]): readonly SourceLayerSpec[] {
  return sortByLayerId(layers);
}

/** Deterministic text for a readback tuple; never contains an absolute path. */
export function readbackKey(readback: FieldReadback): string {
  return `${readback.field_id}\u0000${configPathKey(readback.path)}\u0000${assignmentValueKey(readback.observed)}`;
}
