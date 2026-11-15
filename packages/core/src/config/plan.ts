/**
 * `TrialPlan /2` assembly and create-plan validation (DD-CFG-110 …
 * DD-CFG-115, DD-CFG-145).
 *
 * `createPlan` is read-only: it freezes the registry pin, the factor, the
 * capacity evidence, both patch previews and the authorization requirement.
 * Non-active fields may be registered; they are rejected at execution time.
 */

import type { Hash } from "../hash.js";
import { isId, type Id } from "../ids.js";
import type { ConfigWritePatch, ConfigFilePath } from "../ports/config-write.js";
import type { SourceRef } from "../source-ref.js";
import type {
  CapacityEvidence,
  ConfigResult,
  ConfigSpaceSelector,
  ConfigSpaceSnapshot,
  CreateTrialPlan,
  FieldAssignment,
  FieldRegistrySnapshot,
  FieldSpec,
  RegistryPin,
  SourceLayerSpec,
  TrialFactor,
  TrialFieldChange,
  TrialPlan
} from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import {
  computeConfigSpaceId,
  computeFieldSpecHash,
  computePlanHash,
  computeSourceLayerSetHash,
  sortByFieldId
} from "./hash.js";
import { sortUtf8 } from "../canonical.js";
import { isForbiddenClass, matchDenyRule } from "./authorization.js";
import { requiresCapacityEvidence } from "./normalization.js";
import { validateGuardrailSpecs, validateObservationWindow, windowProfile } from "./guardrails.js";
import { collectSourceLayers } from "./registry.js";
import { modelScopeKey } from "./hash.js";

/* ------------------------------------------------------------------ */
/* Factor resolution                                                   */
/* ------------------------------------------------------------------ */

function findSpec(snapshot: FieldRegistrySnapshot, identifier: string): FieldSpec | null {
  const byId = snapshot.field_specs.find((spec) => spec.field_id === identifier);
  if (byId !== undefined) {
    return byId;
  }
  const byKey = snapshot.field_specs.filter((spec) => spec.field_key === identifier);
  if (byKey.length > 1) {
    return null;
  }
  return byKey[0] ?? null;
}

export function resolveFactorSpecs(
  snapshot: FieldRegistrySnapshot,
  fieldIdentifiers: readonly string[]
): ConfigResult<readonly FieldSpec[]> {
  if (fieldIdentifiers.length === 0) {
    return fail(configError("E_CFG_COUPLING_INCOMPLETE", { details: [{ key: "factor", value: "empty" }] }));
  }
  const specs: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const identifier of fieldIdentifiers) {
    const spec = findSpec(snapshot, identifier);
    if (spec === null) {
      return fail(configError("E_CFG_FIELD_UNKNOWN", { details: [{ key: "field", value: identifier }] }));
    }
    if (seen.has(spec.field_id)) {
      return fail(configError("E_CFG_COUPLING_INCOMPLETE", { field_id: spec.field_id, details: [{ key: "duplicate", value: spec.field_id }] }));
    }
    seen.add(spec.field_id);
    specs.push(spec);
  }
  return succeed(sortByFieldId([...specs]));
}

/**
 * Coupling completeness (DD-CFG-024): a group is all-or-nothing, and fields
 * from different groups cannot share one factor. `coupling_group=null`
 * fields are standalone.
 */
export function validateCouplingCompleteness(snapshot: FieldRegistrySnapshot, specs: readonly FieldSpec[]): ConfigResult<void> {
  const groups = new Set<string>();
  for (const spec of specs) {
    if (spec.coupling_group !== null) {
      groups.add(spec.coupling_group);
    }
  }
  if (groups.size > 1) {
    return fail(configError("E_CFG_COUPLING_INCOMPLETE", { details: [{ key: "groups", value: groups.size }] }));
  }
  const group = groups.size === 0 ? null : [...groups][0] ?? null;
  if (group !== null) {
    const members = snapshot.field_specs.filter((spec) => spec.coupling_group === group);
    const selected = new Set(specs.map((spec) => spec.field_id));
    for (const member of members) {
      if (!selected.has(member.field_id)) {
        return fail(configError("E_CFG_COUPLING_INCOMPLETE", { field_id: member.field_id, details: [{ key: "missing_member", value: member.field_id }] }));
      }
    }
    for (const spec of specs) {
      if (spec.coupling_group !== group) {
        return fail(configError("E_CFG_COUPLING_INCOMPLETE", { field_id: spec.field_id, details: [{ key: "outside_group", value: spec.field_id }] }));
      }
    }
  }
  return succeed(undefined);
}

/**
 * A factor may only touch one file and one layer (DD-CFG-013). A factor whose
 * selected layer is not a writable file is registrable with a null patch
 * (DD-CFG-111, DD-CFG-112); only two distinct writable files are an error.
 */
export function validateSingleFileFactor(
  specs: readonly FieldSpec[],
  layerId: string
): ConfigResult<ConfigFilePath | null> {
  const files = new Map<string, ConfigFilePath>();
  for (const spec of specs) {
    const layer = spec.source_layers.find((candidate) => candidate.layer_id === layerId);
    if (layer === undefined) {
      return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { field_id: spec.field_id, details: [{ key: "layer_id", value: layerId }] }));
    }
    if (layer.path.kind !== "file" || !layer.writable) {
      continue;
    }
    const key = `${layer.path.root}\u0000${layer.path.relative_path}\u0000${layer.path.format}`;
    if (!files.has(key)) {
      files.set(key, layer.path);
    }
  }
  if (files.size > 1) {
    return fail(configError("E_CFG_MULTI_FILE_FACTOR"));
  }
  return succeed(files.values().next().value ?? null);
}

/* ------------------------------------------------------------------ */
/* Selector / capability self-consistency                              */
/* ------------------------------------------------------------------ */

export function validateSelector(
  selector: ConfigSpaceSelector,
  registry: FieldRegistrySnapshot,
  host: TrialPlan["host"],
  layers: readonly SourceLayerSpec[]
): ConfigResult<void> {
  if (selector.root_id !== host.root_id) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "root_id" }] }));
  }
  if (selector.capability_binding_key !== host.capability_binding_key) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "capability_binding_key" }] }));
  }
  if (selector.capability_snapshot_hash !== host.capability_snapshot_hash) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "capability_snapshot_hash" }] }));
  }
  if (!layers.some((layer) => layer.layer_id === selector.source_layer_id)) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "source_layer_id" }] }));
  }
  if (selector.config_space !== registry.config_space || host.config_space !== registry.config_space) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "config_space" }] }));
  }
  const layerSet = computeSourceLayerSetHash({
    host_id: registry.host_id,
    source_pin: registry.source_pin,
    binary_pin: registry.binary_pin,
    adapter_version: registry.adapter_version,
    config_space: registry.config_space,
    mode: registry.mode,
    construction_path: registry.construction_path,
    layers
  });
  if (layerSet !== selector.source_layer_set_hash) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "source_layer_set_hash" }] }));
  }
  const recomputed = computeConfigSpaceId({
    host_id: host.host_id,
    source_pin: host.source_pin,
    binary_pin: host.binary_pin,
    adapter_version: host.adapter_version,
    mode: host.mode,
    construction_path: host.construction_path,
    config_space: host.config_space,
    source_layer_set_hash: selector.source_layer_set_hash,
    root_id: host.root_id,
    execution_environment: host.execution_environment
  });
  if (recomputed !== selector.config_space_id) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "config_space_id" }] }));
  }
  if (host.subject !== "product_adapter") {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "subject" }] }));
  }
  if (registry.host_id !== host.host_id || registry.config_space !== host.config_space) {
    return fail(configError("E_CFG_HOST_VERSION_UNBOUND"));
  }
  return succeed(undefined);
}

/** Baseline readback must match the plan's selector layer and hashes (DD-CFG-042). */
export function validateBaseline(
  baseline: ConfigSpaceSnapshot,
  selector: ConfigSpaceSelector,
  specs: readonly FieldSpec[]
): ConfigResult<void> {
  if (baseline.config_version.length === 0 || baseline.semantic_hash.length === 0) {
    return fail(configError("E_CFG_STALE_BASELINE"));
  }
  if (baseline.config_space.config_space_id !== selector.config_space_id) {
    return fail(configError("E_CFG_STALE_BASELINE"));
  }
  if (baseline.config_space.source_layer_set_hash !== selector.source_layer_set_hash) {
    return fail(configError("E_CFG_STALE_BASELINE"));
  }
  for (const spec of specs) {
    const value = baseline.values.find((assignment) => assignment.field_id === spec.field_id);
    if (value === undefined) {
      return fail(configError("E_CFG_DEFAULT_UNKNOWN", { field_id: spec.field_id, details: [{ key: "baseline", value: "missing" }] }));
    }
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Create-plan validation pipeline                                     */
/* ------------------------------------------------------------------ */

export interface CreatePlanContext {
  request: CreateTrialPlan;
  registry: FieldRegistrySnapshot;
  baseline: ConfigSpaceSnapshot;
  capacity_evidence: CapacityEvidence | null;
}

export interface CreatePlanResolution {
  specs: readonly FieldSpec[];
  /** `null` when the selected layer is not a writable file (patch stays null). */
  target_path: ConfigFilePath | null;
  layers: readonly SourceLayerSpec[];
  selected_apply_boundary: TrialPlan["selected_apply_boundary"];
}

/**
 * Runs the fixed create-plan checks in DD-CFG-145 order, stopping at the first
 * failure. Field status is inspected but not gated here.
 */
export function validateCreatePlan(context: CreatePlanContext): ConfigResult<CreatePlanResolution> {
  const { request, registry, baseline } = context;
  // 1. request shape and factor identifiers.
  const specs = resolveFactorSpecs(registry, request.factor_input.field_ids);
  if (!specs.ok) {
    return fail(specs.error);
  }
  // 2. registry axes: every spec must belong to this snapshot.
  for (const spec of specs.value) {
    if (!registry.field_specs.some((candidate) => candidate.field_id === spec.field_id)) {
      return fail(configError("E_CFG_FIELD_UNKNOWN", { field_id: spec.field_id }));
    }
    if (spec.authorization_class === "host_capacity" && request.observation_window.profile_id !== "W2") {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { field_id: spec.field_id, details: [{ key: "window", value: "W2_required" }] }));
    }
    if (spec.window_profile_id !== request.observation_window.profile_id) {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { field_id: spec.field_id, details: [{ key: "window", value: spec.window_profile_id }] }));
    }
    if (request.observation_window.profile_id === "W2" && spec.authorization_class !== "host_capacity") {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { field_id: spec.field_id, details: [{ key: "window", value: "W2_requires_host_capacity" }] }));
    }
  }
  // 3. forbidden classes and deny rules on the selected layer only.
  for (const spec of specs.value) {
    if (isForbiddenClass(spec.authorization_class)) {
      return fail(configError("E_CFG_FORBIDDEN_FIELD", { field_id: spec.field_id }));
    }
    const layer = spec.source_layers.find(
      (candidate) => candidate.layer_id === request.config_space_selector.source_layer_id
    );
    if (layer !== undefined && layer.writable) {
      const denied = matchDenyRule(registry.deny_rules, layer.path);
      if (denied !== null) {
        return fail(configError("E_CFG_FORBIDDEN_FIELD", { field_id: spec.field_id, details: [{ key: "deny_rule", value: denied.rule_id }] }));
      }
    }
  }
  // 4. coupling and factor set equality.
  const coupling = validateCouplingCompleteness(registry, specs.value);
  if (!coupling.ok) {
    return fail(coupling.error);
  }
  const factorFieldIds = sortUtf8(specs.value.map((spec) => spec.field_id), (value) => value);
  const candidateFieldIds = sortUtf8(request.factor_input.candidate.map((value) => value.field_id), (value) => value);
  if (factorFieldIds.length !== candidateFieldIds.length || factorFieldIds.some((id, index) => id !== candidateFieldIds[index])) {
    return fail(configError("E_CFG_COUPLING_INCOMPLETE", { details: [{ key: "candidate", value: "field_set_mismatch" }] }));
  }
  // 5. selected apply boundary is allowed by every field.
  const boundary = chosenBoundary(specs.value);
  if (boundary === null) {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { details: [{ key: "apply_boundary", value: "no_common_boundary" }] }));
  }
  // 6. guardrail and window structure.
  const guardrails = validateGuardrailSpecs(request.guardrails, request.observation_window.profile_id);
  if (!guardrails.ok) {
    return fail(guardrails.error);
  }
  const window = validateObservationWindow(request.observation_window);
  if (!window.ok) {
    return fail(window.error);
  }
  // 7. capacity evidence coupling.
  const needsCapacity = requiresCapacityEvidence(request.factor_input.normalization);
  if (needsCapacity && context.capacity_evidence === null) {
    return fail(configError("E_CFG_CAPACITY_UNVERIFIED"));
  }
  if (!needsCapacity && context.capacity_evidence !== null) {
    return fail(configError("E_CFG_CAPACITY_MISMATCH"));
  }
  // 8. config-space identity and capability self-consistency.
  // The single-file factor check (DD-CFG-013) runs before the registry layer
  // aggregation: a factor that spans two files of one layer is a multi-file
  // factor, not an ambiguous registry. The aggregation would otherwise fail
  // first with `E_CFG_REGISTRY_AMBIGUOUS` and the documented multi-file code
  // would be unreachable through `createPlan`.
  const target = validateSingleFileFactor(specs.value, request.config_space_selector.source_layer_id);
  if (!target.ok) {
    return fail(target.error);
  }
  const layers = collectSourceLayers(registry.field_specs);
  if (!layers.ok) {
    return fail(layers.error);
  }
  const selector = validateSelector(request.config_space_selector, registry, request.host, layers.value);
  if (!selector.ok) {
    return fail(selector.error);
  }
  // 9. baseline.
  if (request.task_binding.config_version.length === 0) {
    return fail(configError("E_CFG_STALE_BASELINE"));
  }
  const baselineCheck = validateBaseline(baseline, request.config_space_selector, specs.value);
  if (!baselineCheck.ok) {
    return fail(baselineCheck.error);
  }
  // 10. authorization requirement.
  const requirement = request.authorization_requirement;
  if (requirement === undefined || requirement === null) {
    return fail(configError("E_CFG_AUTHORIZATION_MISSING"));
  }
  if (requirement.scope.config_space_id !== request.config_space_selector.config_space_id) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "config_space_id" }] }));
  }
  if (requirement.scope.model_scope_key !== registry.model_scope_key) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "model_scope_key" }] }));
  }
  for (const spec of specs.value) {
    if (!requirement.scope.field_ids.includes(spec.field_id)) {
      return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { field_id: spec.field_id }));
    }
  }
  if (!requirement.scope.source_layer_ids.includes(request.config_space_selector.source_layer_id)) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "source_layer_id" }] }));
  }
  // 11. budget and rollback plan.
  const budget = request.experiment_budget;
  if (
    !Number.isSafeInteger(budget.max_sessions) ||
    !Number.isSafeInteger(budget.max_model_requests) ||
    !Number.isSafeInteger(budget.max_tokens) ||
    !Number.isFinite(budget.max_cost_usd) ||
    budget.max_sessions < 0 ||
    budget.max_model_requests < 0 ||
    budget.max_tokens < 0 ||
    budget.max_cost_usd < 0
  ) {
    return fail(configError("E_CFG_BUDGET_EXHAUSTED", { details: [{ key: "budget", value: "invalid" }] }));
  }
  if (request.rollback_plan.profile_id !== "R1" || request.rollback_plan.target !== "baseline") {
    return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "rollback_plan", value: "profile" }] }));
  }
  if (request.rollback_plan.source_layer_id !== request.config_space_selector.source_layer_id) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "rollback_layer" }] }));
  }
  return succeed({
    specs: specs.value,
    target_path: target.value,
    layers: layers.value,
    selected_apply_boundary: boundary
  });
}

function chosenBoundary(specs: readonly FieldSpec[]): TrialPlan["selected_apply_boundary"] | null {
  const first = specs[0];
  if (first === undefined) {
    return null;
  }
  for (const boundary of first.apply_boundaries) {
    if (specs.every((spec) => spec.apply_boundaries.includes(boundary))) {
      return boundary;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface AssemblePlanInput {
  plan_id: Id<"trial">;
  created_at: number;
  request: CreateTrialPlan;
  registry: FieldRegistrySnapshot;
  resolved: CreatePlanResolution;
  changes: readonly TrialFieldChange[];
  formula_input_hash: Hash;
  capacity_evidence: CapacityEvidence | null;
  patch_preview: { write: ConfigWritePatch | null; rollback: ConfigWritePatch | null };
  baseline: ConfigSpaceSnapshot;
  readback_refs: readonly SourceRef[];
}

export function buildRegistryPin(
  registry: FieldRegistrySnapshot,
  specs: readonly FieldSpec[]
): RegistryPin {
  return {
    snapshot_hash: registry.snapshot_hash,
    registry_version: registry.registry_version,
    specs: sortUtf8(specs, (spec) => spec.field_id).map((spec) => ({
      field_id: spec.field_id,
      spec_hash: spec.spec_hash
    }))
  };
}

/** Builds the sealed plan object and its `plan_hash`. */
export function assembleTrialPlan(input: AssemblePlanInput): TrialPlan {
  const { request, registry, resolved } = input;
  const factor: TrialFactor = {
    factor_id: request.factor_input.factor_id,
    changes: sortUtf8(input.changes, (change) => change.field_id),
    coupling_group: resolved.specs[0]?.coupling_group ?? null,
    normalization: request.factor_input.normalization,
    formula_input_hash: input.formula_input_hash
  };
  const planWithoutHash: Omit<TrialPlan, "plan_id" | "created_at" | "plan_hash"> = {
    schema_version: "rsi.trial_plan/2",
    task_binding: request.task_binding,
    host: request.host,
    config_space_selector: request.config_space_selector,
    registry_pin: buildRegistryPin(registry, resolved.specs),
    factor,
    capacity_evidence: input.capacity_evidence,
    patch_preview: input.patch_preview,
    selected_apply_boundary: resolved.selected_apply_boundary,
    baseline_capture: {
      config_version: input.baseline.config_version,
      semantic_hash: input.baseline.semantic_hash,
      source_layer_id: request.config_space_selector.source_layer_id,
      root_identity_pin: input.baseline.config_space.root_identity_pin,
      readback_refs: input.readback_refs,
      captured_at: input.baseline.captured_at
    },
    primary_metric: request.primary_metric,
    guardrails: sortUtf8(request.guardrails, (guardrail) => guardrail.guardrail_id),
    observation_window: request.observation_window,
    stop_rule: request.stop_rule,
    experiment_budget: request.experiment_budget,
    rollback_plan: request.rollback_plan,
    authorization_requirement: request.authorization_requirement
  };
  const planHash = computePlanHash(planWithoutHash);
  return {
    ...planWithoutHash,
    plan_id: input.plan_id,
    created_at: input.created_at,
    plan_hash: planHash
  };
}

/** Registry pin equality, used by `startTrial` replays. */
export function sameRegistryPin(left: RegistryPin, right: RegistryPin): boolean {
  if (left.snapshot_hash !== right.snapshot_hash || left.registry_version !== right.registry_version) {
    return false;
  }
  if (left.specs.length !== right.specs.length) {
    return false;
  }
  return left.specs.every((spec, index) => {
    const other = right.specs[index];
    return other !== undefined && other.field_id === spec.field_id && other.spec_hash === spec.spec_hash;
  });
}

/** Recomputes `spec_hash` for a plan pin and rejects any drift. */
export function verifyPinnedSpecHashes(registry: FieldRegistrySnapshot, pin: RegistryPin): ConfigResult<void> {
  for (const entry of pin.specs) {
    const spec = registry.field_specs.find((candidate) => candidate.field_id === entry.field_id);
    if (spec === undefined) {
      return fail(configError("E_CFG_FIELD_UNKNOWN", { field_id: entry.field_id }));
    }
    const recomputed = computeFieldSpecHash(stripSpecHash(spec));
    if (recomputed !== entry.spec_hash || recomputed !== spec.spec_hash) {
      return fail(configError("E_CFG_SNAPSHOT_HASH", { field_id: entry.field_id }));
    }
  }
  return succeed(undefined);
}

function stripSpecHash(spec: FieldSpec): Omit<FieldSpec, "spec_hash"> {
  const { spec_hash: _ignored, ...rest } = spec;
  void _ignored;
  return rest;
}

/** Selected model scope key must be the registry's declared key. */
export function selectedModelScopeKey(registry: FieldRegistrySnapshot): string {
  return modelScopeKey(registry.model_scope);
}

/** Factor field assignments must equal the resolved baseline/candidate set. */
export function changesMatchCandidate(changes: readonly TrialFieldChange[], candidate: readonly FieldAssignment[]): boolean {
  const byId = new Map(candidate.map((assignment) => [assignment.field_id, assignment]));
  if (byId.size !== changes.length) {
    return false;
  }
  return changes.every((change) => {
    const assignment = byId.get(change.field_id);
    if (assignment === undefined) {
      return false;
    }
    return JSON.stringify(assignment.value) === JSON.stringify(change.candidate);
  });
}

/** `TrialPlan /2` requires unique registered `fld` ids for the factor. */
export function factorIdsAreRegistered(changes: readonly TrialFieldChange[]): boolean {
  return changes.every((change) => isId(change.field_id, "fld"));
}

/** Plan ids use the `trial` prefix; trials use `ctr` (DD-CFG-034). */
export function isPlanId(value: string): value is Id<"trial"> {
  return isId(value, "trial");
}

export function isTrialId(value: string): value is Id<"ctr"> {
  return isId(value, "ctr");
}
