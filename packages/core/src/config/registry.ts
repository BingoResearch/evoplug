/**
 * Field registry resolution and registry pin verification (DD-CFG-030 …
 * DD-CFG-036, DD-CFG-181 … DD-CFG-183).
 *
 * The registry is content-addressed: `snapshot_hash` covers the sorted
 * `FieldSpec` array and deny rules. Resolution never falls back to a nearby
 * version, another mode, or a semantically similar key.
 */

import type { Hash } from "../hash.js";
import { isId } from "../ids.js";
import type { ConfigFilePath } from "../ports/config-write.js";
import { sortUtf8 } from "../canonical.js";
import type {
  BinaryPin,
  ConfigResult,
  ConfigSpace,
  ConstructionPath,
  DenyRule,
  FieldRegistryQuery,
  FieldRegistrySnapshot,
  FieldSpec,
  FieldStatus,
  ModelScope,
  RegistryPin,
  SourceLayerSpec,
  SourcePin,
  TrialFactor
} from "./types.js";
import {
  computeFieldSpecHash,
  computeSnapshotHash,
  computeSourceLayerSetHash,
  modelScopeKey,
  sortByFieldId,
  sortByLayerId,
  sortByRuleId
} from "./hash.js";
import { configError, fail, succeed } from "./errors.js";
import { validateSpecSchema } from "./values.js";
import type { HostId, HostMode } from "../generated/host-vocabulary.js";
import { isHostId } from "../generated/host-vocabulary.js";

const CONFIG_SPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONSTRUCTION_PATHS: ReadonlySet<string> = new Set([
  "cli",
  "sdk",
  "rpc",
  "app_server",
  "acp",
  "sdk_stdio",
  "server",
  "server_settings",
  "direct_agent",
  "preset_agent",
  "subagent_factory"
]);

export function isConfigSpace(value: string): value is ConfigSpace {
  return CONFIG_SPACE_PATTERN.test(value);
}

export function isConstructionPath(value: string): value is ConstructionPath {
  return CONSTRUCTION_PATHS.has(value);
}

export function isFieldStatus(value: string): value is FieldStatus {
  return (
    value === "active" ||
    value === "h_unverified" ||
    value === "source_only" ||
    value === "unsupported"
  );
}

/** Lower rank wins; the winning layer is the field's effective layer. */
export function effectiveLayer(spec: FieldSpec): SourceLayerSpec | null {
  let winner: SourceLayerSpec | null = null;
  for (const layerId of spec.precedence) {
    const layer = spec.source_layers.find((candidate) => candidate.layer_id === layerId);
    if (layer === undefined) {
      continue;
    }
    if (winner === null || layer.precedence_rank < winner.precedence_rank) {
      winner = layer;
    }
  }
  if (winner !== null) {
    return winner;
  }
  let lowest: SourceLayerSpec | null = null;
  for (const layer of spec.source_layers) {
    if (lowest === null || layer.precedence_rank < lowest.precedence_rank) {
      lowest = layer;
    }
  }
  return lowest;
}

function validateSourceLayersAndPrecedence(spec: FieldSpec): ConfigResult<void> {
  const seenLayerIds = new Map<string, SourceLayerSpec>();
  for (const layer of spec.source_layers) {
    const existing = seenLayerIds.get(layer.layer_id);
    if (existing !== undefined) {
      const identical =
        existing.precedence_rank === layer.precedence_rank &&
        existing.writable === layer.writable &&
        existing.trust_gate === layer.trust_gate &&
        existing.merge === layer.merge &&
        JSON.stringify(existing.path) === JSON.stringify(layer.path);
      if (!identical) {
        return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
      }
      continue;
    }
    seenLayerIds.set(layer.layer_id, layer);
  }
  const seenPrecedence = new Set<string>();
  let previousRank = Number.NEGATIVE_INFINITY;
  for (const layerId of spec.precedence) {
    if (seenPrecedence.has(layerId)) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
    }
    seenPrecedence.add(layerId);
    const layer = seenLayerIds.get(layerId);
    if (layer === undefined || layer.precedence_rank <= previousRank) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
    }
    previousRank = layer.precedence_rank;
  }
  return succeed(undefined);
}

export interface BuildSnapshotInput {
  registry_version: string;
  host_id: HostId;
  source_pin: SourcePin;
  binary_pin: BinaryPin;
  adapter_version: string;
  config_space: ConfigSpace;
  mapping: "exact" | "partial" | "unmapped";
  mode: HostMode;
  construction_path: ConstructionPath;
  model_scope: ModelScope;
  model_scope_key?: string;
  field_specs: readonly FieldSpec[];
  deny_rules: readonly DenyRule[];
  created_at: number;
}

export type SnapshotBody = Omit<FieldRegistrySnapshot, "snapshot_hash">;

/**
 * Builds a validated snapshot. Each `spec_hash` is recomputed first; a
 * mismatch is `E_CFG_SNAPSHOT_HASH` and never silently repaired.
 */
export function buildFieldRegistrySnapshot(input: BuildSnapshotInput): ConfigResult<FieldRegistrySnapshot> {
  if (!isConfigSpace(input.config_space) || !isConstructionPath(input.construction_path)) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED"));
  }
  if (!isHostId(input.host_id)) {
    return fail(configError("E_CFG_HOST_VERSION_UNBOUND"));
  }
  const expectedKey = input.model_scope_key ?? modelScopeKey(input.model_scope);
  if (expectedKey !== modelScopeKey(input.model_scope)) {
    return fail(configError("E_CFG_REGISTRY_AMBIGUOUS"));
  }
  const specs = sortByFieldId(input.field_specs);
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const spec of specs) {
    if (!isId(spec.field_id, "fld")) {
      return fail(configError("E_CFG_FIELD_TYPE", { field_id: spec.field_id }));
    }
    if (seenIds.has(spec.field_id)) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
    }
    seenIds.add(spec.field_id);
    const composite = `${spec.field_key}\u0000${spec.mode}\u0000${spec.construction_path}\u0000${spec.model_scope_key}`;
    if (seenKeys.has(composite)) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
    }
    seenKeys.add(composite);
    if (spec.host_id !== input.host_id || spec.config_space !== input.config_space) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
    }
    if (spec.mode !== input.mode || spec.construction_path !== input.construction_path) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
    }
    if (spec.model_scope_key !== modelScopeKey(spec.model_scope)) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
    }
    if (spec.schema_version !== "rsi.field_spec/1") {
      return fail(configError("E_CFG_SNAPSHOT_HASH", { field_id: spec.field_id }));
    }
    const recomputed = computeFieldSpecHash(stripSpecHash(spec));
    if (recomputed !== spec.spec_hash) {
      return fail(configError("E_CFG_SNAPSHOT_HASH", { field_id: spec.field_id }));
    }
    const layerCheck = validateSourceLayersAndPrecedence(spec);
    if (!layerCheck.ok) {
      return fail(layerCheck.error);
    }
    const schemaCheck = validateSpecSchema(spec);
    if (!schemaCheck.ok) {
      return fail(schemaCheck.error);
    }
  }
  const groupHasNormalization = new Map<string, boolean>();
  for (const spec of specs) {
    if (spec.coupling_group === null) {
      continue;
    }
    const current = groupHasNormalization.get(spec.coupling_group) ?? false;
    groupHasNormalization.set(spec.coupling_group, current || spec.normalization_id !== "identity");
  }
  for (const [group, hasNormalization] of groupHasNormalization) {
    if (!hasNormalization) {
      return fail(configError("E_CFG_NORMALIZATION_MISSING", { details: [{ key: "coupling_group", value: group }] }));
    }
  }
  const denyRules = sortByRuleId(input.deny_rules);
  const ruleIds = new Set<string>();
  for (const rule of denyRules) {
    if (ruleIds.has(rule.rule_id)) {
      return fail(configError("E_CFG_REGISTRY_AMBIGUOUS"));
    }
    ruleIds.add(rule.rule_id);
  }
  const body: SnapshotBody = {
    schema_version: "rsi.field_registry_snapshot/1",
    registry_version: input.registry_version,
    host_id: input.host_id,
    source_pin: input.source_pin,
    binary_pin: input.binary_pin,
    adapter_version: input.adapter_version,
    config_space: input.config_space,
    mapping: input.mapping,
    mode: input.mode,
    construction_path: input.construction_path,
    model_scope: input.model_scope,
    model_scope_key: expectedKey,
    field_specs: specs,
    deny_rules: denyRules,
    created_at: input.created_at
  };
  return succeed({ ...body, snapshot_hash: computeSnapshotHash(body) });
}

function stripSpecHash(spec: FieldSpec): Omit<FieldSpec, "spec_hash"> {
  return {
    schema_version: spec.schema_version,
    field_id: spec.field_id,
    field_key: spec.field_key,
    host_id: spec.host_id,
    source_pin: spec.source_pin,
    binary_pin: spec.binary_pin,
    adapter_version: spec.adapter_version,
    config_space: spec.config_space,
    mapping: spec.mapping,
    mode: spec.mode,
    construction_path: spec.construction_path,
    model_scope: spec.model_scope,
    model_scope_key: spec.model_scope_key,
    value_schema: spec.value_schema,
    unit: spec.unit,
    default_spec: spec.default_spec,
    source_layers: spec.source_layers,
    precedence: spec.precedence,
    coupling_group: spec.coupling_group,
    normalization_id: spec.normalization_id,
    apply_boundaries: spec.apply_boundaries,
    readback: spec.readback,
    guardrail_profile_id: spec.guardrail_profile_id,
    window_profile_id: spec.window_profile_id,
    rollback_profile_id: spec.rollback_profile_id,
    authorization_class: spec.authorization_class,
    status: spec.status,
    status_reason: spec.status_reason,
    provenance: spec.provenance
  };
}

/**
 * Recomputes every spec hash and the snapshot hash (DD-CFG-034). Any mismatch
 * returns `E_CFG_SNAPSHOT_HASH`; the stored values are never replaced.
 */
export function verifyFieldRegistrySnapshot(snapshot: FieldRegistrySnapshot): ConfigResult<void> {
  if (snapshot.schema_version !== "rsi.field_registry_snapshot/1") {
    return fail(configError("E_CFG_SNAPSHOT_HASH"));
  }
  if (snapshot.snapshot_hash !== computeSnapshotHash(snapshot)) {
    return fail(configError("E_CFG_SNAPSHOT_HASH"));
  }
  for (const spec of snapshot.field_specs) {
    if (spec.spec_hash !== computeFieldSpecHash(stripSpecHash(spec))) {
      return fail(configError("E_CFG_SNAPSHOT_HASH", { field_id: spec.field_id }));
    }
  }
  return succeed(undefined);
}

function scopeSpecificity(scope: ModelScope): number {
  switch (scope.kind) {
    case "exact":
      return 2;
    case "family":
      return 1;
    case "any":
      return 0;
  }
}

function sameVersionAxes(
  snapshot: FieldRegistrySnapshot,
  query: Pick<FieldRegistryQuery, "host_id" | "source_pin" | "binary_pin">
): boolean {
  return (
    snapshot.host_id === query.host_id &&
    snapshot.source_pin.host_version === query.source_pin.host_version &&
    snapshot.source_pin.host_version_kind === query.source_pin.host_version_kind &&
    snapshot.source_pin.source_commit === query.source_pin.source_commit &&
    snapshot.binary_pin.binary_version === query.binary_pin.binary_version &&
    snapshot.binary_pin.binary_hash === query.binary_pin.binary_hash
  );
}

function sameCapabilityAxes(
  snapshot: FieldRegistrySnapshot,
  query: Pick<FieldRegistryQuery, "adapter_version" | "config_space" | "construction_path">
): boolean {
  return (
    snapshot.adapter_version === query.adapter_version &&
    snapshot.config_space === query.config_space &&
    snapshot.construction_path === query.construction_path
  );
}

/**
 * Resolves one FieldSpec in the fixed axis order of DD-CFG-030:
 * mode → model → host/version → capability axes → field key.
 */
export function resolveFieldSpec(
  snapshot: FieldRegistrySnapshot,
  query: FieldRegistryQuery
): ConfigResult<FieldSpec> {
  const envelope = validateSnapshotEnvelope(snapshot);
  if (!envelope.ok) {
    return fail(envelope.error);
  }
  if (snapshot.mode !== query.mode) {
    return fail(configError("E_CFG_MODE_UNBOUND"));
  }
  const queryScopeKey = query.model_scope_key;
  if (queryScopeKey !== modelScopeKey(query.model_scope)) {
    return fail(configError("E_CFG_MODEL_UNBOUND"));
  }
  const candidatesAtKey = snapshot.field_specs.filter((spec) => spec.model_scope_key === queryScopeKey);
  if (candidatesAtKey.length === 0) {
    return fail(configError("E_CFG_MODEL_UNBOUND"));
  }
  if (!sameVersionAxes(snapshot, query)) {
    return fail(configError("E_CFG_HOST_VERSION_UNBOUND"));
  }
  if (!sameCapabilityAxes(snapshot, query)) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED"));
  }
  const byKey = snapshot.field_specs.filter((spec) => spec.field_key === query.field_key);
  if (byKey.length === 0) {
    return fail(configError("E_CFG_FIELD_UNKNOWN"));
  }
  let best: readonly FieldSpec[] = [];
  let bestSpecificity = -1;
  for (const spec of byKey) {
    if (!scopeMatches(spec.model_scope, query.model_scope)) {
      continue;
    }
    const specificity = scopeSpecificity(spec.model_scope);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      best = [spec];
    } else if (specificity === bestSpecificity) {
      best = [...best, spec];
    }
  }
  if (best.length === 0) {
    return fail(configError("E_CFG_MODEL_UNBOUND"));
  }
  if (best.length > 1) {
    return fail(configError("E_CFG_REGISTRY_AMBIGUOUS"));
  }
  const winner = best[0];
  if (winner === undefined) {
    return fail(configError("E_CFG_FIELD_UNKNOWN"));
  }
  return succeed(winner);
}

function validateSnapshotEnvelope(snapshot: FieldRegistrySnapshot): ConfigResult<void> {
  if (snapshot.schema_version !== "rsi.field_registry_snapshot/1" || snapshot.snapshot_hash.length === 0) {
    return fail(configError("E_CFG_SNAPSHOT_HASH"));
  }
  return succeed(undefined);
}

function scopeMatches(specScope: ModelScope, queryScope: ModelScope): boolean {
  if (specScope.kind === "any") {
    return true;
  }
  if (queryScope.kind === "any") {
    return false;
  }
  return specScope.kind === queryScope.kind && modelScopeKey(specScope) === modelScopeKey(queryScope);
}

/**
 * Union of declared layers for one registry axis group (DD-CFG-183). A layer id
 * with two different bodies makes the registry invalid.
 */
export function collectSourceLayers(specs: readonly FieldSpec[]): ConfigResult<readonly SourceLayerSpec[]> {
  const byId = new Map<string, SourceLayerSpec>();
  for (const spec of specs) {
    for (const layer of spec.source_layers) {
      const existing = byId.get(layer.layer_id);
      if (existing === undefined) {
        byId.set(layer.layer_id, layer);
        continue;
      }
      const identical =
        existing.precedence_rank === layer.precedence_rank &&
        existing.writable === layer.writable &&
        existing.trust_gate === layer.trust_gate &&
        existing.merge === layer.merge &&
        JSON.stringify(existing.path) === JSON.stringify(layer.path);
      if (!identical) {
        return fail(configError("E_CFG_REGISTRY_AMBIGUOUS"));
      }
    }
  }
  return succeed(sortByLayerId([...byId.values()]));
}

export function sourceLayerSetHashFor(snapshot: FieldRegistrySnapshot): ConfigResult<Hash> {
  const layers = collectSourceLayers(snapshot.field_specs);
  if (!layers.ok) {
    return fail(layers.error);
  }
  return succeed(
    computeSourceLayerSetHash({
      host_id: snapshot.host_id,
      source_pin: snapshot.source_pin,
      binary_pin: snapshot.binary_pin,
      adapter_version: snapshot.adapter_version,
      config_space: snapshot.config_space,
      mode: snapshot.mode,
      construction_path: snapshot.construction_path,
      layers: layers.value
    })
  );
}

/**
 * Verifies `TrialPlan.registry_pin` against a snapshot and a factor
 * (DD-CFG-034, DD-CFG-181). The spec list must equal the factor field set.
 */
export function verifyRegistryPin(
  pin: RegistryPin,
  snapshot: FieldRegistrySnapshot,
  factor: TrialFactor
): ConfigResult<void> {
  const verified = verifyFieldRegistrySnapshot(snapshot);
  if (!verified.ok) {
    return fail(verified.error);
  }
  if (pin.snapshot_hash !== snapshot.snapshot_hash || pin.registry_version !== snapshot.registry_version) {
    return fail(configError("E_CFG_SNAPSHOT_HASH"));
  }
  const sorted = sortUtf8(pin.specs, (entry) => entry.field_id);
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.field_id)) {
      return fail(configError("E_CFG_SNAPSHOT_HASH", { field_id: entry.field_id }));
    }
    seen.add(entry.field_id);
    const spec = snapshot.field_specs.find((candidate) => candidate.field_id === entry.field_id);
    if (spec === undefined) {
      return fail(configError("E_CFG_FIELD_UNKNOWN", { field_id: entry.field_id }));
    }
    if (spec.spec_hash !== entry.spec_hash) {
      return fail(configError("E_CFG_SNAPSHOT_HASH", { field_id: entry.field_id }));
    }
  }
  const factorIds = sortUtf8(factor.changes.map((change) => change.field_id), (value) => value);
  if (factorIds.length !== sorted.length) {
    return fail(configError("E_CFG_COUPLING_INCOMPLETE"));
  }
  for (let index = 0; index < factorIds.length; index += 1) {
    if (factorIds[index] !== sorted[index]?.field_id) {
      return fail(configError("E_CFG_COUPLING_INCOMPLETE", { field_id: factorIds[index] ?? null }));
    }
  }
  return succeed(undefined);
}

export type ResolvedFileLayer = { layer: SourceLayerSpec; path: ConfigFilePath };

/** Returns the writable file layer of a spec, or null when none is executable. */
export function writableFileLayer(spec: FieldSpec): ResolvedFileLayer | null {
  for (const layerId of spec.precedence) {
    const layer = spec.source_layers.find((candidate) => candidate.layer_id === layerId);
    if (layer === undefined || !layer.writable || layer.path.kind !== "file") {
      continue;
    }
    return { layer, path: layer.path };
  }
  return null;
}

/** Number of registered fields by status, used by registry tests and reports. */
export function countByStatus(specs: readonly FieldSpec[]): Readonly<Record<FieldStatus, number>> {
  const counts: Record<FieldStatus, number> = {
    active: 0,
    h_unverified: 0,
    source_only: 0,
    unsupported: 0
  };
  for (const spec of specs) {
    counts[spec.status] += 1;
  }
  return counts;
}
