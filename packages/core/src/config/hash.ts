/**
 * Canonical content hashes for CFG (DD-CFG-180 … DD-CFG-188).
 *
 * Every hash uses `H(x) = "sha256:" + lowerhex(sha256(UTF8(JCS(x))))`. Each
 * preimage is a closed object with a domain-separating `schema_version`;
 * business arrays are sorted and deduplicated exactly as the design states,
 * ordered-semantic arrays keep their declared order.
 */

import { canonicalJsonText, sortUtf8 } from "../canonical.js";
import { canonicalHash, hashBytes, type Hash } from "../hash.js";
import type { Id } from "../ids.js";
import { toJsonValue } from "../json.js";
import type { SourceRef } from "../source-ref.js";
import type { ConfigWritePatch } from "../ports/config-write.js";
import type {
  CapacityEvidence,
  ConfigScalar,
  ConfigValueSchema,
  DenyRule,
  FieldAssignment,
  FieldRegistrySnapshot,
  FieldSpec,
  GuardrailValue,
  ModelScope,
  ModelScopeKey,
  NormalizationBinding,
  ObservationRecord,
  SourceLayerSpec,
  TrialFieldChange,
  TrialPlan
} from "./types.js";

/** `H(x)` over any JSON-encodable closed object. */
export function hashJson(value: unknown): Hash {
  return canonicalHash(toJsonValue(value));
}

function hashCanonicalText(value: unknown): string {
  return canonicalJsonText(toJsonValue(value));
}

/** JCS text of a `ConfigScalar`; used as the sort key for business arrays. */
export function configScalarKey(value: ConfigScalar): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError("non-finite ConfigScalar");
  }
  return Object.is(value, -0) ? "0" : String(JSON.stringify(value));
}

/** Deterministic model scope key: `any`, `family:...`, `exact:...`. */
export function modelScopeKey(scope: ModelScope): ModelScopeKey {
  switch (scope.kind) {
    case "any":
      return "any";
    case "family":
      return `family:${scope.provider}:${scope.model_pattern}`;
    case "exact":
      return `exact:${scope.provider}:${scope.model_id}:${scope.variant === null ? "null" : scope.variant}`;
  }
}

/** Sorted by `field_id`, duplicate ids rejected by the caller. */
export function sortByFieldId<T extends { field_id: string }>(values: readonly T[]): T[] {
  return sortUtf8(values, (value) => value.field_id);
}

/** Sorted by `field_id`, duplicate ids rejected by the caller. */
function sortAssignments(values: readonly FieldAssignment[]): FieldAssignment[] {
  return sortByFieldId(values);
}

/** Sorted by `layer_id`. */
export function sortByLayerId(values: readonly SourceLayerSpec[]): SourceLayerSpec[] {
  return sortUtf8(values, (value) => value.layer_id);
}

/** Sorted by `rule_id`. */
export function sortByRuleId(values: readonly DenyRule[]): DenyRule[] {
  return sortUtf8(values, (value) => value.rule_id);
}

function sortScalars(values: readonly ConfigScalar[]): ConfigScalar[] {
  return sortUtf8(values, (value) => configScalarKey(value));
}

function sortRefs(refs: readonly SourceRef[]): SourceRef[] {
  return sortUtf8(refs, (ref) => ref);
}

function sortGuardrails(values: readonly GuardrailValue[]): GuardrailValue[] {
  return sortUtf8(values, (value) => value.guardrail_id);
}

function assignmentPreimage(assignment: FieldAssignment): Record<string, unknown> {
  const row: Record<string, unknown> = {
    field_id: assignment.field_id,
    path: assignment.path
  };
  if (assignment.value.presence === "present") {
    row["value"] = assignment.value.value;
  }
  return row;
}

function changePreimage(change: TrialFieldChange): Record<string, unknown> {
  return {
    field_id: change.field_id,
    field_key: change.field_key,
    baseline: change.baseline,
    candidate: change.candidate
  };
}

function valueSchemaPreimage(schema: ConfigValueSchema): Record<string, unknown> {
  switch (schema.kind) {
    case "enum":
      return { kind: schema.kind, values: sortScalars(schema.values), availability: schema.availability };
    case "integer_or_enum":
      return {
        kind: schema.kind,
        min: schema.min,
        max: schema.max,
        unit: schema.unit,
        values: sortScalars(schema.values),
        availability: schema.availability
      };
    case "unverified":
      return {
        kind: schema.kind,
        documented_shape: schema.documented_shape,
        known_values: schema.known_values === null ? null : sortScalars(schema.known_values),
        provenance: schema.provenance
      };
    case "boolean":
      return { kind: schema.kind };
    case "integer":
      return { kind: schema.kind, min: schema.min, max: schema.max, unit: schema.unit };
    case "number":
      return {
        kind: schema.kind,
        min: schema.min,
        max: schema.max,
        unit: schema.unit,
        exclusive_min: schema.exclusive_min,
        exclusive_max: schema.exclusive_max
      };
    case "string":
      return {
        kind: schema.kind,
        pattern: schema.pattern,
        max_length: schema.max_length,
        unit: schema.unit
      };
  }
}

function defaultSpecPreimage(spec: FieldSpec["default_spec"]): Record<string, unknown> {
  switch (spec.kind) {
    case "fixed":
      return { kind: spec.kind, value: spec.value, provenance: spec.provenance };
    case "absent":
      return { kind: spec.kind, effective_rule_id: spec.effective_rule_id };
    case "path_dependent":
      return {
        kind: spec.kind,
        selector: spec.selector,
        cases: sortUtf8(spec.cases, (entry) => entry.path).map((entry) => ({
          path: entry.path,
          value: entry.value
        }))
      };
    case "unknown":
      return { kind: spec.kind, provenance: spec.provenance };
  }
}

function layerPreimage(layer: SourceLayerSpec): Record<string, unknown> {
  return {
    layer_id: layer.layer_id,
    path: layer.path,
    precedence_rank: layer.precedence_rank,
    writable: layer.writable,
    trust_gate: layer.trust_gate,
    merge: layer.merge
  };
}

function denyRulePreimage(rule: DenyRule): Record<string, unknown> {
  return { rule_id: rule.rule_id, authorization_class: rule.authorization_class, match: rule.match };
}

/* ------------------------------------------------------------------ */
/* DD-CFG-181: FieldSpec.spec_hash                                     */
/* ------------------------------------------------------------------ */

type FieldSpecHashInput = Omit<FieldSpec, "spec_hash">;

export function computeFieldSpecHash(spec: FieldSpecHashInput): Hash {
  return hashJson({
    schema_version: "rsi.field_spec_hash/1",
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
    value_schema: valueSchemaPreimage(spec.value_schema),
    unit: spec.unit,
    default_spec: defaultSpecPreimage(spec.default_spec),
    source_layers: sortByLayerId(spec.source_layers).map(layerPreimage),
    precedence: [...spec.precedence],
    coupling_group: spec.coupling_group,
    normalization_id: spec.normalization_id,
    apply_boundaries: sortUtf8(spec.apply_boundaries, (value) => value),
    readback: spec.readback,
    guardrail_profile_id: spec.guardrail_profile_id,
    window_profile_id: spec.window_profile_id,
    rollback_profile_id: spec.rollback_profile_id,
    authorization_class: spec.authorization_class,
    status: spec.status,
    status_reason: spec.status_reason,
    provenance: sortRefs(spec.provenance)
  });
}

/* ------------------------------------------------------------------ */
/* DD-CFG-182: FieldRegistrySnapshot.snapshot_hash                     */
/* ------------------------------------------------------------------ */

type SnapshotHashInput = Omit<FieldRegistrySnapshot, "snapshot_hash" | "created_at">;

export function computeSnapshotHash(snapshot: SnapshotHashInput): Hash {
  return hashJson({
    schema_version: "rsi.registry_snapshot_hash/1",
    registry_version: snapshot.registry_version,
    host_id: snapshot.host_id,
    source_pin: snapshot.source_pin,
    binary_pin: snapshot.binary_pin,
    adapter_version: snapshot.adapter_version,
    config_space: snapshot.config_space,
    mapping: snapshot.mapping,
    mode: snapshot.mode,
    construction_path: snapshot.construction_path,
    model_scope: snapshot.model_scope,
    model_scope_key: snapshot.model_scope_key,
    field_specs: sortByFieldId(snapshot.field_specs).map((spec) => ({
      ...spec,
      value_schema: valueSchemaPreimage(spec.value_schema),
      default_spec: defaultSpecPreimage(spec.default_spec),
      source_layers: sortByLayerId(spec.source_layers).map(layerPreimage),
      apply_boundaries: sortUtf8(spec.apply_boundaries, (value) => value),
      provenance: sortRefs(spec.provenance)
    })),
    deny_rules: sortByRuleId(snapshot.deny_rules).map(denyRulePreimage)
  });
}

/* ------------------------------------------------------------------ */
/* DD-CFG-183: source_layer_set_hash                                   */
/* ------------------------------------------------------------------ */

interface SourceLayerSetHashInput {
  host_id: string;
  source_pin: unknown;
  binary_pin: unknown;
  adapter_version: string;
  config_space: string;
  mode: string;
  construction_path: string;
  layers: readonly SourceLayerSpec[];
}

export function computeSourceLayerSetHash(input: SourceLayerSetHashInput): Hash {
  return hashJson({
    schema_version: "rsi.source_layer_set/1",
    host_id: input.host_id,
    source_pin: input.source_pin,
    binary_pin: input.binary_pin,
    adapter_version: input.adapter_version,
    config_space: input.config_space,
    mode: input.mode,
    construction_path: input.construction_path,
    layers: sortByLayerId(input.layers).map(layerPreimage)
  });
}

/* ------------------------------------------------------------------ */
/* DD-CFG-184: file and config semantic hashes                         */
/* ------------------------------------------------------------------ */

export type SemanticTree =
  | { kind: "object"; entries: readonly { key: string; value: SemanticTree }[] }
  | { kind: "array"; items: readonly SemanticTree[] }
  | {
      kind: "scalar";
      scalar_type: "string" | "number" | "boolean" | "null";
      value: string | number | boolean | null;
    };

interface FilePathIdentity {
  format: "json" | "jsonc" | "yaml" | "toml";
  root: "user" | "project" | "managed" | "session";
  relative_path: string;
}

export function fileContentHash(bytes: Uint8Array): Hash {
  return hashBytes(bytes);
}

export function computeFileSemanticHash(path: FilePathIdentity, tree: SemanticTree): Hash {
  return hashJson({
    schema_version: "rsi.file_semantic_hash/1",
    format: path.format,
    root: path.root,
    relative_path: path.relative_path,
    tree: normalizeTree(tree)
  });
}

function normalizeTree(tree: SemanticTree): unknown {
  switch (tree.kind) {
    case "object":
      return {
        kind: "object",
        entries: sortUtf8(tree.entries, (entry) => entry.key).map((entry) => ({
          key: entry.key,
          value: normalizeTree(entry.value)
        }))
      };
    case "array":
      return { kind: "array", items: tree.items.map((item) => normalizeTree(item)) };
    case "scalar":
      return { kind: "scalar", scalar_type: tree.scalar_type, value: tree.value };
  }
}

interface ConfigSemanticHashInput {
  config_space_id: Hash;
  source_layer_set_hash: Hash;
  values: readonly FieldAssignment[];
  files: readonly {
    path: { format: string; root: string; relative_path: string };
    exists: boolean;
    content_hash: Hash | null;
    semantic_hash: Hash | null;
  }[];
}

export function computeConfigSemanticHash(input: ConfigSemanticHashInput): Hash {
  const files = sortUtf8(input.files, (file) =>
    `${file.path.root}\u0000${file.path.relative_path}\u0000${file.path.format}`
  );
  return hashJson({
    schema_version: "rsi.config_semantic_hash/1",
    config_space_id: input.config_space_id,
    source_layer_set_hash: input.source_layer_set_hash,
    values: sortAssignments(input.values).map(assignmentPreimage),
    files: files.map((file) => ({
      path: { format: file.path.format, root: file.path.root, relative_path: file.path.relative_path, pointer: "", create: false },
      exists: file.exists,
      content_hash: file.content_hash,
      semantic_hash: file.semantic_hash
    }))
  });
}

/* ------------------------------------------------------------------ */
/* DD-CFG-185: config_space_id                                         */
/* ------------------------------------------------------------------ */

export interface ConfigSpaceIdInput {
  host_id: string;
  source_pin: unknown;
  binary_pin: unknown;
  adapter_version: string;
  mode: string;
  construction_path: string;
  config_space: string;
  source_layer_set_hash: Hash;
  root_id: string;
  execution_environment: { os: string; arch: string; isolation: string };
}

const ROOT_ID_MAX_BYTES = 256;

/** `root_id` shape rules shared by the config-space id and the selector. */
export function isValidRootId(rootId: string): boolean {
  if (rootId.length === 0 || rootId === "." || rootId === "..") {
    return false;
  }
  if (rootId.includes("/") || rootId.includes("\\") || rootId.includes("\u0000")) {
    return false;
  }
  if (new TextEncoder().encode(rootId).length > ROOT_ID_MAX_BYTES) {
    return false;
  }
  if (/^[A-Za-z]:/.test(rootId) || rootId.startsWith("//")) {
    return false;
  }
  return true;
}

export function computeConfigSpaceId(input: ConfigSpaceIdInput): Hash {
  return hashJson({
    schema_version: "rsi.config_space_id/1",
    host_id: input.host_id,
    source_pin: input.source_pin,
    binary_pin: input.binary_pin,
    adapter_version: input.adapter_version,
    mode: input.mode,
    construction_path: input.construction_path,
    config_space: input.config_space,
    source_layer_set_hash: input.source_layer_set_hash,
    root_id: input.root_id,
    execution_environment: {
      os: input.execution_environment.os,
      arch: input.execution_environment.arch,
      isolation: input.execution_environment.isolation
    }
  });
}

/* ------------------------------------------------------------------ */
/* DD-CFG-186: formula_input_hash                                      */
/* ------------------------------------------------------------------ */

interface FormulaInputHashInput {
  binding: NormalizationBinding;
  capacity_evidence: CapacityEvidence | null;
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  model_scope_key: ModelScopeKey;
  baseline: readonly FieldAssignment[];
  candidate: readonly FieldAssignment[];
  context: readonly FieldAssignment[];
}

export function computeFormulaInputHash(input: FormulaInputHashInput): Hash {
  const params = input.binding.normalization_id === "identity" ? null : input.binding.params;
  return hashJson({
    schema_version: "rsi.formula_input_hash/1",
    normalization_id: input.binding.normalization_id,
    normalization_version: input.binding.normalization_version,
    params,
    capacity_evidence: input.capacity_evidence,
    config_space_id: input.config_space_id,
    field_registry_snapshot_hash: input.field_registry_snapshot_hash,
    model_scope_key: input.model_scope_key,
    baseline: sortAssignments(input.baseline).map(assignmentPreimage),
    candidate: sortAssignments(input.candidate).map(assignmentPreimage),
    context: sortAssignments(input.context).map(assignmentPreimage)
  });
}

/* ------------------------------------------------------------------ */
/* DD-CFG-187: scope_hash                                              */
/* ------------------------------------------------------------------ */

export interface ScopeGrantBinding {
  grant_id: Id<"grant">;
  action: "update" | "rollback";
  patch_hash: Hash;
}

export interface ScopeHashInput {
  plan_id: Id<"trial">;
  plan_hash: Hash;
  trial_id: Id<"ctr">;
  candidate_id: Id<"ctr">;
  object_id: Hash;
  field_ids: readonly Id<"fld">[];
  source_layer_ids: readonly string[];
  model_scope_keys: readonly ModelScopeKey[];
  update: ScopeGrantBinding | null;
  rollback: ScopeGrantBinding | null;
}

function grantBindingPreimage(binding: ScopeGrantBinding): unknown {
  return { grant_id: binding.grant_id, action: binding.action, patch_hash: binding.patch_hash };
}

export function computeScopeHash(input: ScopeHashInput): Hash {
  return hashJson({
    schema_version: "rsi.config_scope_hash/1",
    plan_id: input.plan_id,
    plan_hash: input.plan_hash,
    trial_id: input.trial_id,
    candidate_id: input.candidate_id,
    object_type: "config",
    object_id: input.object_id,
    field_ids: sortUtf8(input.field_ids, (value) => value),
    source_layer_ids: sortUtf8(input.source_layer_ids, (value) => value),
    model_scope_keys: sortUtf8(input.model_scope_keys, (value) => value),
    update: input.update === null ? null : grantBindingPreimage(input.update),
    rollback: input.rollback === null ? null : grantBindingPreimage(input.rollback)
  });
}

/* ------------------------------------------------------------------ */
/* DD-CFG-188: ObservationRecord.record_hash                           */
/* ------------------------------------------------------------------ */

type ObservationRecordHashInput = Omit<ObservationRecord, "record_hash">;

export function computeObservationRecordHash(record: ObservationRecordHashInput): Hash {
  const probe = record.probe;
  return hashJson({
    schema_version: "rsi.observation_record_hash/1",
    trial_id: record.trial_id,
    sample_id: record.sample_id,
    observed_at: record.observed_at,
    trigger: record.trigger,
    telemetry: { complete: record.telemetry.complete, trigger_data_present: record.telemetry.trigger_data_present },
    probe:
      probe === null
        ? null
        : {
            source: probe.source,
            resolved: sortAssignments(probe.resolved).map(assignmentPreimage),
            evidence_ref: probe.evidence_ref,
            repeat_count: probe.repeat_count,
            baseline_explainable: probe.baseline_explainable,
            observed_at: probe.observed_at
          },
    guardrails: sortGuardrails(record.guardrails),
    evidence_ref: record.evidence_ref
  });
}

/* ------------------------------------------------------------------ */
/* TrialPlan.plan_hash and ConfigWritePatch.patch_hash                 */
/* ------------------------------------------------------------------ */

export type PlanHashInput = Omit<TrialPlan, "plan_id" | "created_at" | "plan_hash">;

export function computePlanHash(plan: PlanHashInput): Hash {
  return hashJson({
    schema_version: "rsi.trial_plan/2",
    task_binding: plan.task_binding,
    host: plan.host,
    config_space_selector: plan.config_space_selector,
    registry_pin: {
      snapshot_hash: plan.registry_pin.snapshot_hash,
      registry_version: plan.registry_pin.registry_version,
      specs: sortUtf8(plan.registry_pin.specs, (spec) => spec.field_id).map((spec) => ({
        field_id: spec.field_id,
        spec_hash: spec.spec_hash
      }))
    },
    factor: {
      factor_id: plan.factor.factor_id,
      changes: sortUtf8(plan.factor.changes, (change) => change.field_id).map(changePreimage),
      coupling_group: plan.factor.coupling_group,
      normalization: plan.factor.normalization,
      formula_input_hash: plan.factor.formula_input_hash
    },
    capacity_evidence: plan.capacity_evidence,
    patch_preview: { write: plan.patch_preview.write, rollback: plan.patch_preview.rollback },
    selected_apply_boundary: plan.selected_apply_boundary,
    baseline_capture: {
      config_version: plan.baseline_capture.config_version,
      semantic_hash: plan.baseline_capture.semantic_hash,
      source_layer_id: plan.baseline_capture.source_layer_id,
      root_identity_pin: plan.baseline_capture.root_identity_pin,
      readback_refs: [...plan.baseline_capture.readback_refs],
      captured_at: plan.baseline_capture.captured_at
    },
    primary_metric: plan.primary_metric,
    guardrails: sortUtf8(plan.guardrails, (guardrail) => guardrail.guardrail_id),
    observation_window: plan.observation_window,
    stop_rule: plan.stop_rule,
    experiment_budget: plan.experiment_budget,
    rollback_plan: plan.rollback_plan,
    authorization_requirement: plan.authorization_requirement
  });
}

type PatchHashInput = Omit<ConfigWritePatch, "patch_hash">;

export function computePatchHash(patch: PatchHashInput): Hash {
  const mutations = sortUtf8(
    patch.mutations,
    (mutation) => `${mutation.field_id}\u0000${hashCanonicalText(toJsonValue(mutation.path))}`
  );
  const expected = sortByFieldId(patch.expected_fields);
  const candidates = sortByFieldId(patch.candidate_values);
  const protectedSubtrees = sortUtf8(patch.protected_subtrees, (subtree) => subtree.path);
  return hashJson({
    schema_version: patch.schema_version,
    config_space_id: patch.config_space_id,
    field_registry_snapshot_hash: patch.field_registry_snapshot_hash,
    layer_id: patch.layer_id,
    model_scope_key: patch.model_scope_key,
    target_path: patch.target_path,
    expected_fields: expected,
    mutations,
    protected_subtrees: protectedSubtrees,
    candidate_values: candidates
  });
}

/** `after_hash` of a typed state-row event (DD-CFG-159). */
export function computeRowAfterHash(rowSchema: string, rowJson: string): Hash {
  return hashJson({ row_schema: rowSchema, row_json: rowJson });
}

