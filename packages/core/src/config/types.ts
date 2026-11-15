/**
 * CFG object model: field values, registry, trial plan and trial state
 * (DD-CFG-001 … DD-CFG-010, DD-CFG-020 … DD-CFG-030, DD-CFG-090, DD-CFG-110,
 * DD-CFG-120 … DD-CFG-130).
 *
 * Only the shared types are imported from the `@evoplug/core` package root;
 * `RootIdentityPin`, `ConfigProtectedSubtree` and the write-port DTOs are
 * type-only imports from the FND-owned port module (DD-FND-095).
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { SourceRef } from "../source-ref.js";
import type { VersionBinding } from "../version-binding.js";
import type { HostId, HostMode } from "../generated/host-vocabulary.js";
import type {
  BinaryPin,
  ExecutionEnvironment,
  HostVersionKind,
  SourcePin
} from "../host/types.js";
import type {
  ConfigFilePath,
  ConfigProtectedSubtree,
  ConfigWritePatch,
  RootIdentityPin
} from "../ports/config-write.js";

export type {
  BinaryPin,
  ExecutionEnvironment,
  HostVersionKind,
  RootIdentityPin,
  SourcePin
};

/**
 * Wall-clock milliseconds. `@evoplug/core` does not export `EpochMs`, so CFG
 * declares the alias locally; the runtime type is a non-negative safe integer.
 */
export type EpochMs = number;

/* ------------------------------------------------------------------ */
/* Field values (DD-CFG-020 … DD-CFG-026)                              */
/* ------------------------------------------------------------------ */

/** Configured space token: `^[a-z][a-z0-9_]{0,63}$` (DD-CFG-168). */
export type ConfigSpace = string;

export type ConfigScalar = string | number | boolean | null;

export type ConfigUnit =
  | "none"
  | "tokens"
  | "percent"
  | "ratio"
  | "ms"
  | "model_ref"
  | "effort_level";

/** Present value versus explicit removal (DD-CFG-020). */
export type AssignmentValue =
  | { presence: "present"; value: ConfigScalar }
  | { presence: "absent" };

export interface FieldAssignment {
  field_id: Id<"fld">;
  path: ConfigPath;
  value: AssignmentValue;
}

export interface TrialFieldChange {
  field_id: Id<"fld">;
  field_key: string;
  baseline: AssignmentValue;
  candidate: AssignmentValue;
}

export type ConfigValueSchema =
  | { kind: "boolean" }
  | { kind: "integer"; min: number; max: number | null; unit: ConfigUnit }
  | {
      kind: "number";
      min: number;
      max: number | null;
      unit: ConfigUnit;
      exclusive_min: boolean;
      exclusive_max: boolean;
    }
  | { kind: "enum"; values: readonly ConfigScalar[]; availability: "static" | "host_catalog" }
  | {
      kind: "integer_or_enum";
      min: number;
      max: number;
      unit: ConfigUnit;
      values: readonly ConfigScalar[];
      availability: "static" | "host_catalog";
    }
  | { kind: "string"; pattern: string; max_length: number; unit: "none" | "model_ref" }
  | {
      kind: "unverified";
      documented_shape: "boolean" | "integer" | "number" | "string" | "enum";
      known_values: readonly ConfigScalar[] | null;
      provenance: SourceRef;
    };

/* ------------------------------------------------------------------ */
/* Config paths                                                        */
/* ------------------------------------------------------------------ */

export type ConfigPath =
  | {
      kind: "file";
      format: "json" | "jsonc" | "yaml" | "toml";
      root: "user" | "project" | "managed" | "session";
      relative_path: string;
      pointer: string;
      create: boolean;
    }
  | {
      kind: "settings_api";
      api_id: "openhands_server_settings";
      key_path: readonly string[];
      merge: "deep_merge";
      readback: "api_get";
    }
  | { kind: "setter"; setter_id: string; scope: "session" | "agent" }
  | { kind: "env"; name: string };

/** CFG-owned closed set of construction paths (DD-CFG-169). */
export type ConstructionPath =
  | "cli"
  | "sdk"
  | "rpc"
  | "app_server"
  | "acp"
  | "sdk_stdio"
  | "server"
  | "server_settings"
  | "direct_agent"
  | "preset_agent"
  | "subagent_factory";

export type ModelScope =
  | { kind: "any" }
  | { kind: "family"; provider: string; model_pattern: string }
  | { kind: "exact"; provider: string; model_id: string; variant: string | null };

/** `any` | `family:<provider>:<pattern>` | `exact:<provider>:<model>:<variant>`. */
export type ModelScopeKey = string;

/** Coupling groups declared by CFG §5.1. */
export type CouplingGroupName =
  | "omp_threshold_mode"
  | "codex_compaction_limits"
  | "step_clm_projection"
  | "opencode_keep_tokens"
  | "openhands_condenser"
  | "claude_autocompact";

export interface ModelRef {
  provider: string;
  model_id: string;
  variant: string | null;
  resolution_source: "host_readback" | "explicit";
}

export type ApplyBoundary =
  | "next_request"
  | "next_session"
  | "conversation_start"
  | "reload"
  | "config_watch"
  | "process_restart"
  | "setter_immediate"
  | "app_server_thread";

export type FieldStatus = "active" | "h_unverified" | "source_only" | "unsupported";

export type AuthorizationClass =
  | "trialable"
  | "host_capacity"
  | "forbidden_credentials"
  | "forbidden_permissions"
  | "forbidden_sandbox"
  | "forbidden_shared_budget"
  | "forbidden_evoplug_policy"
  | "forbidden_managed_policy";

/* ------------------------------------------------------------------ */
/* Field registry (DD-CFG-030 … DD-CFG-036)                            */
/* ------------------------------------------------------------------ */

export interface SourceLayerSpec {
  layer_id: string;
  path: ConfigPath;
  /** Lower rank wins (DD-CFG-040). */
  precedence_rank: number;
  writable: boolean;
  trust_gate: "none" | "project_trust_required";
  merge: "replace" | "deep_merge" | "none";
}

export type DefaultSpec =
  | { kind: "fixed"; value: ConfigScalar; provenance: SourceRef }
  | { kind: "absent"; effective_rule_id: string }
  | {
      kind: "path_dependent";
      selector: "openhands_construction_path";
      cases: readonly { path: ConstructionPath; value: AssignmentValue }[];
    }
  | { kind: "unknown"; provenance: SourceRef };

export interface ReadbackSpec {
  method: "file_parse" | "setter_get" | "process_env" | "host_api";
  decoder_id: string;
  comparison: "exact" | "normalized_equal";
  accept_at: ApplyBoundary;
  timeout_ms: number;
}

export interface FieldSpec {
  schema_version: "rsi.field_spec/1";
  field_id: Id<"fld">;
  field_key: string;
  host_id: HostId;
  source_pin: SourcePin;
  binary_pin: BinaryPin;
  adapter_version: string;
  config_space: ConfigSpace;
  mapping: "exact" | "partial" | "unmapped";
  mode: HostMode;
  construction_path: ConstructionPath;
  model_scope: ModelScope;
  model_scope_key: ModelScopeKey;
  value_schema: ConfigValueSchema;
  unit: ConfigUnit;
  default_spec: DefaultSpec;
  source_layers: readonly SourceLayerSpec[];
  precedence: readonly string[];
  coupling_group: string | null;
  normalization_id: NormalizationId;
  apply_boundaries: readonly ApplyBoundary[];
  readback: ReadbackSpec;
  guardrail_profile_id: "G1";
  window_profile_id: "W1" | "W2";
  rollback_profile_id: "R1";
  authorization_class: AuthorizationClass;
  status: FieldStatus;
  status_reason: string;
  provenance: readonly SourceRef[];
  spec_hash: Hash;
}

export interface DenyRule {
  rule_id: string;
  authorization_class: Exclude<AuthorizationClass, "trialable" | "host_capacity">;
  match:
    | { kind: "path_exact"; segments: readonly string[] }
    | { kind: "path_prefix"; segments: readonly string[] }
    | { kind: "env_name"; name: string };
}

export interface FieldRegistrySnapshot {
  schema_version: "rsi.field_registry_snapshot/1";
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
  model_scope_key: ModelScopeKey;
  field_specs: readonly FieldSpec[];
  deny_rules: readonly DenyRule[];
  created_at: EpochMs;
  snapshot_hash: Hash;
}

/* ------------------------------------------------------------------ */
/* Config space (DD-CFG-040 … DD-CFG-058)                              */
/* ------------------------------------------------------------------ */

export interface FileState {
  path: ConfigFilePath;
  exists: boolean;
  content_hash: Hash | null;
  semantic_hash: Hash | null;
  parser_id: string;
  parser_version: string;
}

export interface ConfigSpaceRef {
  config_space_id: Hash;
  host: HostBinding;
  root_id: string;
  root_identity_pin: RootIdentityPin;
  source_layer_set_hash: Hash;
  config_version: string;
  semantic_hash: Hash;
}

export interface ConfigSpaceSnapshot {
  schema_version: "rsi.config_space_snapshot/1";
  config_space: ConfigSpaceRef;
  values: readonly FieldAssignment[];
  files: readonly FileState[];
  config_version: string;
  semantic_hash: Hash;
  captured_at: EpochMs;
}

export interface FieldReadback {
  field_id: Id<"fld">;
  layer_id: string;
  path: ConfigPath;
  observed: AssignmentValue;
  config_version: string;
  method: ReadbackSpec["method"];
  evidence_ref: SourceRef;
  observed_at: EpochMs;
}

/* ------------------------------------------------------------------ */
/* Capacity evidence (DD-CFG-072 … DD-CFG-074)                         */
/* ------------------------------------------------------------------ */

export type CapacitySourceKind = "host_capability_readback" | "model_catalog";

export interface CapacityEvidencePayload {
  schema_version: "rsi.capacity_evidence_payload/1";
  config_space_id: Hash;
  capability_binding_key: Hash;
  model: ModelRef;
  model_scope_key: ModelScopeKey;
  scope: "window_tokens";
  window_tokens: number;
  unit: "tokens";
  source_kind: CapacitySourceKind;
  observed_at: EpochMs;
}

export interface CapacityEvidence {
  schema_version: "rsi.capacity_evidence/1";
  config_space_id: Hash;
  capability_binding_key: Hash;
  model: ModelRef;
  model_scope_key: ModelScopeKey;
  scope: "window_tokens";
  window_tokens: number;
  unit: "tokens";
  source_kind: CapacitySourceKind;
  evidence_ref: SourceRef;
  evidence_hash: Hash;
  observed_at: EpochMs;
}

/* ------------------------------------------------------------------ */
/* Normalization (DD-CFG-060 … DD-CFG-075)                             */
/* ------------------------------------------------------------------ */

export type NormalizationId =
  | "identity"
  | "percent_token_floor_v1"
  | "omp_threshold_mode_v1"
  | "step_clm_projection_v1"
  | "codex_compaction_limits_v1"
  | "claude_autocompact_window_v1"
  | "pi_model_override_guard"
  | "opencode_keep_tokens_v1"
  | "openhands_condenser_v1";

export type NormalizationBinding =
  | { normalization_id: "identity"; normalization_version: "1" }
  | {
      normalization_id: "percent_token_floor_v1";
      normalization_version: "1";
      params: { percent_field_id: string; token_field_id: string; rounding: "floor" };
    }
  | {
      normalization_id: "omp_threshold_mode_v1";
      normalization_version: "1";
      params: { mode: "percent" | "tokens" };
    }
  | {
      normalization_id: "step_clm_projection_v1";
      normalization_version: "1";
      params: {
        projection_field_id: string;
        compaction_field_id: string;
        ratio_field_id: string;
      };
    }
  | {
      normalization_id: "codex_compaction_limits_v1";
      normalization_version: "1";
      params: {
        window_field_id: string;
        limit_field_id: string;
        scope_field_id: string;
        post_turn_percent_field_id: string;
        async_enabled_field_id: string;
        async_threshold_field_id: string;
      };
    }
  | {
      normalization_id: "claude_autocompact_window_v1";
      normalization_version: "1";
      params: {
        top_level_field_id: string;
        model_field_id: string;
        model_scoped_field_id: string;
      };
    }
  | {
      normalization_id: "pi_model_override_guard";
      normalization_version: "1";
      params: { global_field_id: string; override_key: string };
    }
  | {
      normalization_id: "opencode_keep_tokens_v1";
      normalization_version: "1";
      params: {
        auto_field_id: string;
        keep_field_id: string;
        buffer_field_id: string;
      };
    }
  | {
      normalization_id: "openhands_condenser_v1";
      normalization_version: "1";
      params: {
        max_size_field_id: string;
        keep_first_field_id: string;
        max_tokens_field_id: string;
      };
    };

export interface NormalizationRequest {
  binding: NormalizationBinding;
  baseline: readonly FieldAssignment[];
  candidate: readonly FieldAssignment[];
  /** Read-only gate/related fields from the pinned baseline; never written. */
  context: readonly FieldAssignment[];
  capacity_evidence: CapacityEvidence | null;
  /**
   * Sealing inputs of `formula_input_hash` (DD-CFG-186) and the host field
   * keys needed by `TrialFieldChange`. The design's request sketch omits
   * them; without them the normalizer cannot produce either required output.
   */
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  model_scope_key: ModelScopeKey;
  field_keys: ReadonlyMap<string, string>;
  construction_path: ConstructionPath | null;
}

export interface NormalizationOutput {
  changes: readonly TrialFieldChange[];
  formula_input_hash: Hash;
  /** Fields whose write is masked by a higher-priority sibling. */
  shadowed_field_ids: readonly Id<"fld">[];
}

export type Normalize = (input: NormalizationRequest) => ConfigResult<NormalizationOutput>;

/* ------------------------------------------------------------------ */
/* Authorization (DD-CFG-080 … DD-CFG-085)                             */
/* ------------------------------------------------------------------ */

export interface ConfigGrantScope {
  field_ids: readonly Id<"fld">[];
  source_layer_ids: readonly string[];
  model_scope_keys: readonly ModelScopeKey[];
}

export interface ConfigGrantLike {
  grant_id: Id<"grant">;
  object_type: "config";
  object_id: string;
  actions: readonly string[];
  mode: "once" | "standing";
  candidate_id: string | null;
  candidate_hash: Hash | null;
  expires_at: number | null;
  revoked_at: number | null;
  scope: { config_scope?: ConfigGrantScope | undefined };
}

/* ------------------------------------------------------------------ */
/* Guardrails and windows (DD-CFG-090 … DD-CFG-100)                    */
/* ------------------------------------------------------------------ */

export type MetricId =
  | "acceptance_pass_rate"
  | "task_success_rate"
  | "compaction_events_per_session"
  | "prompt_tokens_p95"
  | "billed_tokens_per_success"
  | "cost_usd_per_success"
  | "context_overflow_count"
  | "compaction_failure_count"
  | "forbidden_write_count";

export type GuardrailOracleId =
  | "host_usage_meter_v1"
  | "independent_verifier_v1"
  | "safety_write_audit_v1";

export type GuardrailSampling =
  | { kind: "every_matched_sample"; at: "sample_close"; require_close_audit: true }
  | { kind: "window_aggregate" };

export type GuardrailId =
  | "context_overflow"
  | "compaction_failure"
  | "quality_independent"
  | "cost_per_success"
  | "safety_zero";

export interface GuardrailSpec {
  guardrail_id: GuardrailId;
  metric_id: MetricId;
  comparator: "lte" | "gte" | "eq";
  threshold: number;
  unit: ConfigUnit | "count" | "usd";
  min_samples: number;
  on_breach: "rollback";
  evidence_source: "host_events" | "independent_verifier" | "usage_meter" | "write_audit";
  oracle_id: GuardrailOracleId;
  sampling: GuardrailSampling;
}

export interface WindowProfile {
  profile_id: "W1" | "W2";
  min_matched_samples: number;
  max_elapsed_ms: number;
  close_on: "min_samples_and_deadline" | "causal_protocol_end";
  missing_data_outcome: "inconclusive";
}

export interface RollbackProfile {
  profile_id: "R1";
  strategy: "restore_baseline";
  comparison: "exact";
  conflict_policy: "stop_no_overwrite";
  readback_required: true;
}

export interface GuardrailValue {
  guardrail_id: GuardrailId;
  metric_id: MetricId;
  value: number | null;
  status: "ok" | "breached" | "unknown";
  sample_count: number;
  evidence_ref: SourceRef | null;
}

export interface MetricSpec {
  metric_id: MetricId;
  direction: "increase" | "decrease";
  min_effect: number;
  unit: ConfigUnit | "count" | "usd";
  evidence_source: "independent_verifier" | "host_events" | "usage_meter";
}

export interface ObservationWindowSpec {
  profile_id: "W1" | "W2";
  min_matched_samples: number;
  max_elapsed_ms: number;
  match_predicate_id: string;
}

export type StopRule =
  | { kind: "window_close" }
  | { kind: "guardrail_or_window"; on_guardrail: "rollback" }
  | { kind: "causal_protocol"; protocol_id: Id; min_samples: number; max_samples: number };

export interface ExperimentBudget {
  max_sessions: number;
  max_model_requests: number;
  max_tokens: number;
  max_cost_usd: number;
  reservation_ref: Id;
  cannot_modify_shared_budget: true;
}

export interface RollbackPlan {
  profile_id: "R1";
  target: "baseline";
  field_ids: readonly string[];
  source_layer_id: string;
  apply_boundary: ApplyBoundary;
  deadline_ms: number;
}

/* ------------------------------------------------------------------ */
/* Trial plan (DD-CFG-110 … DD-CFG-115)                                */
/* ------------------------------------------------------------------ */

export interface HostBinding {
  host_id: HostId;
  source_pin: SourcePin;
  binary_pin: BinaryPin;
  adapter_version: string;
  subject: "product_adapter";
  mode: HostMode;
  config_space: ConfigSpace;
  root_id: string;
  execution_environment: ExecutionEnvironment;
  mapping: "exact" | "partial" | "unmapped";
  capability_binding_key: Hash;
  capability_snapshot_hash: Hash;
  model: ModelRef;
  construction_path: ConstructionPath;
}

export interface ConfigSpaceSelector {
  config_space_id: Hash;
  config_space: ConfigSpace;
  source_layer_id: string;
  source_layer_set_hash: Hash;
  root_id: string;
  trust_evidence_ref: SourceRef | null;
  capability_binding_key: Hash;
  capability_snapshot_hash: Hash;
}

export interface TrialFactor {
  factor_id: string;
  changes: readonly TrialFieldChange[];
  coupling_group: string | null;
  normalization: NormalizationBinding;
  formula_input_hash: Hash;
}

export interface AuthorizationRequirement {
  scope: {
    field_ids: readonly Id<"fld">[];
    source_layer_ids: readonly string[];
    model_scope_key: ModelScopeKey;
    config_space_id: Hash;
  };
  grants_by_kind: {
    write_and_observe: readonly ["update", "rollback"];
    observe_only: readonly [];
    rollback_only: readonly ["rollback"];
  };
  capacity_trial: boolean;
}

export interface RegistryPin {
  snapshot_hash: Hash;
  registry_version: string;
  specs: readonly { field_id: Id<"fld">; spec_hash: Hash }[];
}

export interface TrialPlan {
  schema_version: "rsi.trial_plan/2";
  plan_id: Id<"trial">;
  created_at: EpochMs;
  task_binding: VersionBinding;
  host: HostBinding;
  config_space_selector: ConfigSpaceSelector;
  registry_pin: RegistryPin;
  factor: TrialFactor;
  capacity_evidence: CapacityEvidence | null;
  patch_preview: {
    write: ConfigWritePatch | null;
    rollback: ConfigWritePatch | null;
  };
  selected_apply_boundary: ApplyBoundary;
  baseline_capture: {
    config_version: string;
    semantic_hash: Hash;
    source_layer_id: string;
    root_identity_pin: RootIdentityPin;
    readback_refs: readonly SourceRef[];
    captured_at: EpochMs;
  };
  primary_metric: MetricSpec;
  guardrails: readonly GuardrailSpec[];
  observation_window: ObservationWindowSpec;
  stop_rule: StopRule;
  experiment_budget: ExperimentBudget;
  rollback_plan: RollbackPlan;
  authorization_requirement: AuthorizationRequirement;
  plan_hash: Hash;
}

export interface CreateTrialPlan {
  request_id: string;
  task_binding: VersionBinding;
  host: HostBinding;
  config_space_selector: ConfigSpaceSelector;
  factor_input: {
    factor_id: string;
    field_ids: readonly string[];
    candidate: readonly FieldAssignment[];
    normalization: NormalizationBinding;
  };
  primary_metric: MetricSpec;
  guardrails: readonly GuardrailSpec[];
  observation_window: ObservationWindowSpec;
  stop_rule: StopRule;
  experiment_budget: ExperimentBudget;
  rollback_plan: RollbackPlan;
  authorization_requirement: AuthorizationRequirement;
}

/* ------------------------------------------------------------------ */
/* Trial state machine (DD-CFG-120 … DD-CFG-131)                       */
/* ------------------------------------------------------------------ */

export type TrialPhase =
  | "planned"
  | "authorized"
  | "writing"
  | "write_recorded"
  | "awaiting_apply"
  | "observing"
  | "rolling_back"
  | "recovery_required"
  | "closed"
  | "aborted";

export type EvidenceLevel = "none" | "written_unverified" | "applied" | "effective" | "causal";

export type TrialOutcome =
  | "running"
  | "not_exercised"
  | "inconclusive"
  | "effect_supported"
  | "effect_rejected"
  | "rolled_back"
  | "failed"
  | "aborted";

export type ExecutionKind = "write_and_observe" | "observe_only" | "rollback_only";

export type RollbackReason =
  | "guardrail"
  | "manual"
  | "external_drift"
  | "budget_exhausted"
  | "stop_rule";

export type CloseReason =
  | "window_closed"
  | "causal_complete"
  | "rollback_complete"
  | "failed"
  | "abandoned";

export interface RecoveryAttestation {
  operator_id: string;
  attestation_ref: SourceRef;
  conflict_evidence_ref: SourceRef;
  observed_config_version: string;
  observed_semantic_hash: Hash;
}

export interface CurrentConfigProjection {
  state: "baseline_confirmed" | "candidate_confirmed" | "drifted" | "unknown";
  values: readonly FieldAssignment[];
  observed_at: EpochMs | null;
  readback_ref: SourceRef | null;
  config_version: string | null;
}

export interface RollbackState {
  state:
    | "not_required"
    | "pending"
    | "in_progress"
    | "baseline_confirmed"
    | "conflict"
    | "unverified"
    | "abandoned";
  reason: RollbackReason | null;
  target_values: readonly FieldAssignment[];
  readback_ref: SourceRef | null;
}

export interface ObservationState {
  window_opened_at: EpochMs | null;
  window_closes_at: EpochMs | null;
  matched_samples: number;
  trigger_samples: number;
  probe_samples: number;
  guardrail_evaluations: number;
  last_sample_at: EpochMs | null;
}

export interface EffectiveProbe {
  source: "host_resolved_config" | "runtime_log_resolved" | "behavior_signature";
  resolved: readonly FieldAssignment[];
  evidence_ref: SourceRef;
  repeat_count: number;
  baseline_explainable: boolean;
  observed_at: EpochMs;
}

export interface ObservationRecord {
  schema_version: "rsi.config_observation/1";
  trial_id: Id<"ctr">;
  sample_id: string;
  observed_at: EpochMs;
  trigger: boolean;
  telemetry: { complete: boolean; trigger_data_present: boolean };
  probe: EffectiveProbe | null;
  guardrails: readonly GuardrailValue[];
  evidence_ref: SourceRef;
  record_hash: Hash;
}

export interface TrialAuthorization {
  candidate_id: Id<"ctr">;
  update_grant_id: Id | null;
  rollback_grant_id: Id | null;
  update_patch_hash: Hash | null;
  rollback_patch_hash: Hash | null;
  scope_hash: Hash;
  checked_at: EpochMs;
}

export interface RecoveryState {
  attestation: RecoveryAttestation;
  received_at: EpochMs;
  resolution: "rollback_requested" | "abandoned";
}

export interface ConfigTrial {
  schema_version: "rsi.config_trial/1";
  trial_id: Id<"ctr">;
  plan_id: Id<"trial">;
  plan_hash: Hash;
  config_space: ConfigSpaceRef;
  execution_kind: ExecutionKind;
  predecessor_trial_id: Id<"ctr"> | null;
  evidence_basis: "own_write" | "inherited_candidate" | "rollback_only";
  authorization: TrialAuthorization;
  capability_snapshot_hash: Hash;
  phase: TrialPhase;
  evidence_level: EvidenceLevel;
  outcome: TrialOutcome;
  current_config: CurrentConfigProjection;
  observation: ObservationState;
  close_audit_ref: SourceRef | null;
  rollback: RollbackState;
  recovery: RecoveryState | null;
  revision: number;
  created_at: EpochMs;
  updated_at: EpochMs;
  last_error: ConfigError | null;
}

export type AttemptKind =
  | "write"
  | "readback"
  | "apply_probe"
  | "rollback_write"
  | "rollback_readback"
  | "observation"
  | "reconcile";

export type AttemptResult =
  | {
      kind: "write";
      write_result_ref: Id;
      state: "committed" | "failed" | "uncertain";
      file_hash_after: Hash | null;
      changed_field_ids: readonly Id<"fld">[];
    }
  | { kind: "readback"; values: readonly FieldReadback[] }
  | { kind: "probe"; probe: EffectiveProbe }
  | {
      kind: "observation";
      sample_id: string;
      trigger: boolean;
      guardrails: readonly GuardrailValue[];
      telemetry_complete: boolean;
      trigger_data_present: boolean;
    }
  | {
      kind: "reconcile";
      reconciled_attempt: AttemptRef | null;
      action:
        | "marked_failed"
        | "recovered_readback"
        | "rollback_pending"
        | "no_action"
        | "recovery_required";
    }
  | { kind: "noop"; reason: "already_done" | "not_required" };

export interface AttemptRef {
  trial_id: Id<"ctr">;
  sequence: number;
}

export interface WriteAttemptAuditInput {
  schema_version: "rsi.cfg_write_attempt_audit/1";
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  root_id: string;
  target_path: string;
  attempted_field_ids: readonly Id<"fld">[];
  patch_hash: Hash;
  config_write_id: Id<"cwi"> | null;
}

export interface TrialAttempt {
  schema_version: "rsi.trial_attempt/1";
  trial_id: Id<"ctr">;
  sequence: number;
  kind: AttemptKind;
  phase_before: TrialPhase;
  phase_after: TrialPhase;
  idempotency_key: string;
  request_hash: Hash;
  audit_input: WriteAttemptAuditInput | null;
  started_at: EpochMs;
  finished_at: EpochMs | null;
  result: AttemptResult | null;
  error: ConfigError | null;
}

/* ------------------------------------------------------------------ */
/* Errors (DD-CFG-110 … DD-CFG-145)                                    */
/* ------------------------------------------------------------------ */

export type ConfigErrorCode =
  | "E_CFG_HOST_VERSION_UNBOUND"
  | "E_CFG_MODE_UNBOUND"
  | "E_CFG_MODEL_UNBOUND"
  | "E_CFG_FIELD_UNKNOWN"
  | "E_CFG_FIELD_NOT_EXECUTABLE"
  | "E_CFG_FIELD_TYPE"
  | "E_CFG_FIELD_RANGE"
  | "E_CFG_FIELD_UNIT"
  | "E_CFG_DEFAULT_UNKNOWN"
  | "E_CFG_COUPLING_INCOMPLETE"
  | "E_CFG_NORMALIZATION_MISSING"
  | "E_CFG_NORMALIZATION_MISMATCH"
  | "E_CFG_NORMALIZATION_SHADOWED"
  | "E_CFG_NORMALIZATION_UNVERIFIED"
  | "E_CFG_NORMALIZATION_INPUT"
  | "E_CFG_FORBIDDEN_FIELD"
  | "E_CFG_AUTHORIZATION_MISSING"
  | "E_CFG_AUTHORIZATION_SCOPE"
  | "E_CFG_STALE_BASELINE"
  | "E_CFG_FIELD_CONFLICT"
  | "E_CFG_EXTERNAL_CHANGE"
  | "E_CFG_APPLY_UNCONFIRMED"
  | "E_CFG_READBACK_TIMEOUT"
  | "E_CFG_MULTI_FILE_FACTOR"
  | "E_CFG_PROTECTED_SUBTREE"
  | "E_CFG_WRITE_FAILED"
  | "E_CFG_WRITE_UNCERTAIN"
  | "E_CFG_ROLLBACK_CONFLICT"
  | "E_CFG_RECOVERY_REQUIRED"
  | "E_CFG_FIELD_CLAIMED"
  | "E_CFG_ACTIVE_TRIAL"
  | "E_CFG_IDEMPOTENCY_CONFLICT"
  | "E_CFG_PLAN_NOT_FOUND"
  | "E_CFG_TRIAL_NOT_FOUND"
  | "E_CFG_TRIAL_TERMINAL"
  | "E_CFG_ILLEGAL_TRANSITION"
  | "E_CFG_BUDGET_EXHAUSTED"
  | "E_CFG_LEGACY_UNVERIFIED"
  | "E_CFG_REGISTRY_AMBIGUOUS"
  | "E_CFG_SNAPSHOT_HASH"
  | "E_CFG_GUARDRAIL_UNKNOWN"
  | "E_CFG_GUARDRAIL_SPEC"
  | "E_CFG_GUARDRAIL_BREACH"
  | "E_CFG_CAPABILITY_UNVERIFIED"
  | "E_CFG_CAPACITY_UNVERIFIED"
  | "E_CFG_CAPACITY_MISMATCH"
  | "E_CFG_ROOT_UNRESOLVED"
  | "E_CFG_ROOT_UNAVAILABLE"
  | "E_CFG_ROOT_INVALID"
  | "E_CFG_ROOT_AMBIGUOUS"
  | "E_CFG_ROOT_IDENTITY_MISMATCH"
  | "E_CFG_FORMULA_HASH"
  | "E_CFG_OBSERVATION_HASH"
  | "E_CFG_WRITE_PORT_UNSUPPORTED"
  | "E_CFG_ROLLBACK_UNCERTAIN"
  | "E_CFG_DEADLINE_EXCEEDED"
  | "E_CFG_CANCELLED";

export interface ConfigErrorDetail {
  key: string;
  value: ConfigScalar;
}

export interface ConfigError {
  code: ConfigErrorCode;
  message_key: string;
  field_id: string | null;
  path: string | null;
  retryable: boolean;
  details: readonly ConfigErrorDetail[];
}

export type ConfigResult<T> = { ok: true; value: T } | { ok: false; error: ConfigError };

/* ------------------------------------------------------------------ */
/* Service request/response types (DD-CFG-140 … DD-CFG-145)            */
/* ------------------------------------------------------------------ */

export interface StartTrial {
  trial_id: Id<"ctr">;
  plan_id: Id<"trial">;
  config_space_id: Hash;
  execution_kind: ExecutionKind;
  predecessor_trial_id: Id<"ctr"> | null;
  grant_ids: { update: Id | null; rollback: Id | null };
}

export interface RecordObservation {
  trial_id: Id;
  sample_id: string;
  trigger: boolean;
  telemetry: { complete: boolean; trigger_data_present: boolean };
  probe: EffectiveProbe | null;
  guardrails: readonly GuardrailValue[];
  observed_at: EpochMs;
}

export interface ExecuteAttempt {
  trial_id: Id;
  kind: AttemptKind;
  expected_revision: number;
  idempotency_key: string;
  deadline_ms: number;
  signal?: AbortSignal;
}

export interface RequestRollback {
  trial_id: Id;
  expected_revision: number;
  reason: RollbackReason;
  attestation: RecoveryAttestation | null;
}

export interface CloseTrial {
  trial_id: Id;
  expected_revision: number;
  reason: CloseReason;
  attestation: RecoveryAttestation | null;
}

export interface ReconcileEntry {
  trial_id: Id<"ctr">;
  attempt: AttemptRef | null;
  action:
    | "marked_failed"
    | "recovered_readback"
    | "rollback_pending"
    | "no_action"
    | "recovery_required";
  phase_after: TrialPhase;
  error_code: ConfigErrorCode | null;
}

export interface ReconcileReport {
  checked_at: EpochMs;
  scanned_trials: number;
  entries: readonly ReconcileEntry[];
  unresolved_trial_ids: readonly Id[];
}

export interface FieldRegistryQuery {
  host_id: HostId;
  source_pin: SourcePin;
  binary_pin: BinaryPin;
  adapter_version: string;
  config_space: ConfigSpace;
  construction_path: ConstructionPath;
  mode: HostMode;
  model_scope: ModelScope;
  model_scope_key: ModelScopeKey;
  field_key: string;
}
