/**
 * The seven versioned host field registries (CFG §8, DD-CFG-101 …
 * DD-CFG-103).
 *
 * All 37 fields are registered and none is executable (`active=0`,
 * `source_only=24`, `h_unverified=5`, `unsupported=8`). Field ids are stable
 * `fld:` identities derived once from `<host>.<field_key>`; `field_key` is the
 * host-side key and is compared exactly.
 */

import { hashUtf8 } from "../hash.js";
import type { Id } from "../ids.js";
import type { SourceRef } from "../source-ref.js";
import type { HostId } from "../generated/host-vocabulary.js";
import type {
  ApplyBoundary,
  AuthorizationClass,
  BinaryPin,
  ConfigResult,
  ConfigUnit,
  ConfigValueSchema,
  ConstructionPath,
  CouplingGroupName,
  DefaultSpec,
  FieldRegistrySnapshot,
  FieldSpec,
  FieldStatus,
  ModelScope,
  NormalizationId,
  ReadbackSpec,
  SourceLayerSpec,
  SourcePin
} from "./types.js";
import { computeFieldSpecHash, modelScopeKey } from "./hash.js";
import { buildFieldRegistrySnapshot } from "./registry.js";
import { defaultDenyRules } from "./authorization.js";

/* ------------------------------------------------------------------ */
/* Provenance and pin helpers                                          */
/* ------------------------------------------------------------------ */

/** Content-addressed provenance marker for the versioned research tables. */
export function researchRef(label: string): SourceRef {
  return `blob://${hashUtf8(`evoplug.cfg.provenance.${label}`)}#bytes=0-1`;
}

function pin(hostVersion: string, kind: "release" | "source_commit" | "binary_hash", commit: string | null): SourcePin {
  return { host_version: hostVersion, host_version_kind: kind, source_commit: commit };
}

function binary(version: string | null): BinaryPin {
  return { binary_version: version, binary_hash: null };
}

/** Adapter version is a semver produced by the product adapter (assumption). */
const ADAPTER_VERSION = "1.0.0";

interface HostProfile {
  host_id: HostId;
  config_space: string;
  mode: "interactive" | "server";
  construction_path: ConstructionPath;
  source_pin: SourcePin;
  binary_pin: BinaryPin;
  mapping: "exact" | "partial" | "unmapped";
}

const HOST_PROFILES: Readonly<Record<HostId, HostProfile>> = {
  pi: {
    host_id: "pi",
    config_space: "pi_settings",
    mode: "interactive",
    construction_path: "cli",
    source_pin: pin("1.3.0", "release", null),
    binary_pin: binary("0.87.1"),
    mapping: "unmapped"
  },
  "oh-my-pi": {
    host_id: "oh-my-pi",
    config_space: "omp_settings",
    mode: "interactive",
    construction_path: "acp",
    source_pin: pin("18.12.3", "release", null),
    binary_pin: binary("18.12.3"),
    mapping: "partial"
  },
  "step-code": {
    host_id: "step-code",
    config_space: "step_config",
    mode: "interactive",
    construction_path: "sdk_stdio",
    source_pin: pin("0.84.4", "release", null),
    binary_pin: binary("0.1.5"),
    mapping: "unmapped"
  },
  codex: {
    host_id: "codex",
    config_space: "codex_config",
    mode: "interactive",
    construction_path: "app_server",
    source_pin: pin("0.160.1", "release", null),
    binary_pin: binary("0.160.1"),
    mapping: "unmapped"
  },
  opencode: {
    host_id: "opencode",
    config_space: "opencode_config",
    mode: "interactive",
    construction_path: "server",
    source_pin: pin("2.1.0", "release", null),
    binary_pin: binary("1.18.32"),
    mapping: "unmapped"
  },
  "openhands-sdk": {
    host_id: "openhands-sdk",
    config_space: "openhands_settings",
    mode: "server",
    construction_path: "server_settings",
    source_pin: pin("1.56.0", "release", null),
    binary_pin: binary(null),
    mapping: "partial"
  },
  "claude-code": {
    host_id: "claude-code",
    config_space: "claude_settings",
    mode: "interactive",
    construction_path: "cli",
    source_pin: pin("2.1.304", "release", null),
    binary_pin: binary("2.1.304"),
    mapping: "exact"
  }
};

export function hostProfile(hostId: HostId): HostProfile {
  return HOST_PROFILES[hostId];
}

/* ------------------------------------------------------------------ */
/* Spec construction                                                   */
/* ------------------------------------------------------------------ */

interface SpecInput {
  field_id: string;
  field_key: string;
  host: HostProfile;
  value_schema: ConfigValueSchema;
  unit: ConfigUnit;
  default_spec: DefaultSpec;
  source_layers: readonly SourceLayerSpec[];
  precedence: readonly string[];
  coupling_group: CouplingGroupName | null;
  normalization_id: NormalizationId;
  apply_boundaries: readonly ApplyBoundary[];
  readback: ReadbackSpec;
  model_scope?: ModelScope;
  window_profile_id?: "W1" | "W2";
  authorization_class?: AuthorizationClass;
  status: FieldStatus;
  status_reason: string;
  provenance: readonly SourceRef[];
}

function buildSpec(input: SpecInput): FieldSpec {
  const modelScope: ModelScope = input.model_scope ?? { kind: "any" };
  const body: Omit<FieldSpec, "spec_hash"> = {
    schema_version: "rsi.field_spec/1",
    field_id: input.field_id as Id<"fld">,
    field_key: input.field_key,
    host_id: input.host.host_id,
    source_pin: input.host.source_pin,
    binary_pin: input.host.binary_pin,
    adapter_version: ADAPTER_VERSION,
    config_space: input.host.config_space,
    mapping: input.host.mapping,
    mode: input.host.mode,
    construction_path: input.host.construction_path,
    model_scope: modelScope,
    model_scope_key: modelScopeKey(modelScope),
    value_schema: input.value_schema,
    unit: input.unit,
    default_spec: input.default_spec,
    source_layers: input.source_layers,
    precedence: input.precedence,
    coupling_group: input.coupling_group,
    normalization_id: input.normalization_id,
    apply_boundaries: input.apply_boundaries,
    readback: input.readback,
    guardrail_profile_id: "G1",
    window_profile_id: input.window_profile_id ?? "W1",
    rollback_profile_id: "R1",
    authorization_class: input.authorization_class ?? "trialable",
    status: input.status,
    status_reason: input.status_reason,
    provenance: input.provenance
  };
  return { ...body, spec_hash: computeFieldSpecHash(body) };
}

function fileLayer(
  layerId: string,
  root: "user" | "project" | "managed" | "session",
  relativePath: string,
  format: "json" | "jsonc" | "yaml" | "toml",
  rank: number,
  writable: boolean,
  trustGate: "none" | "project_trust_required",
  merge: "replace" | "deep_merge" | "none"
): SourceLayerSpec {
  return {
    layer_id: layerId,
    path: {
      kind: "file",
      format,
      root,
      relative_path: relativePath,
      pointer: "",
      create: true
    },
    precedence_rank: rank,
    writable,
    trust_gate: trustGate,
    merge
  };
}

function settingsApiLayer(layerId: string): SourceLayerSpec {
  return {
    layer_id: layerId,
    path: {
      kind: "settings_api",
      api_id: "openhands_server_settings",
      key_path: ["condenser"],
      merge: "deep_merge",
      readback: "api_get"
    },
    precedence_rank: 0,
    writable: false,
    trust_gate: "none",
    merge: "deep_merge"
  };
}

function envLayer(layerId: string, name: string): SourceLayerSpec {
  return {
    layer_id: layerId,
    path: { kind: "env", name },
    precedence_rank: 0,
    writable: false,
    trust_gate: "none",
    merge: "none"
  };
}

function readback(
  method: ReadbackSpec["method"],
  acceptAt: ApplyBoundary,
  comparison: ReadbackSpec["comparison"] = "exact",
  decoderId = "file_parse_v1"
): ReadbackSpec {
  return { method, decoder_id: decoderId, comparison, accept_at: acceptAt, timeout_ms: 5_000 };
}

/* ------------------------------------------------------------------ */
/* Status reasons (DD-CFG-003, §8 tables)                              */
/* ------------------------------------------------------------------ */

const SOURCE_ONLY_BINARY = "source_only：binary 映射未建立";
const OMP_RANGE = "source_only：范围/default 未核实";
const OMP_LOAD = "source_only：加载与读回未核实";
const STEP_TOML = "source_only：TOML 段路径未核实";
const CODEX_BINARY = "source_only：binary 映射未建立";
const CODEX_DEFAULT = "source_only：binary 映射/default 未核实";
const CODEX_PATH = "source_only：feature 路径未在 binary 核实";
const OPENCODE_VERSION = "source_only：binary 版本不匹配";
const OPENHANDS_UNSUPPORTED = "unsupported：settings API 写端口未移植";
const CLAUDE_H = "h_unverified：H 写回读未执行";
const CLAUDE_ENV = "unsupported：env-only，不可配置回读";

/* ------------------------------------------------------------------ */
/* Pi (CFG §8.2)                                                       */
/* ------------------------------------------------------------------ */

const PI_LAYERS: readonly SourceLayerSpec[] = [
  fileLayer("pi_project_settings", "project", ".pi/settings.json", "json", 0, true, "project_trust_required", "replace"),
  fileLayer("pi_user_settings", "user", "settings.json", "json", 1, true, "none", "replace")
];
const PI_PRECEDENCE = ["pi_project_settings", "pi_user_settings"] as const;
const PI_APPLY: readonly ApplyBoundary[] = ["reload", "next_session"];

function piSpecs(): readonly FieldSpec[] {
  const host = HOST_PROFILES.pi;
  const provenance = [researchRef("R-PI")];
  return [
    buildSpec({
      field_id: "fld:A3HDPDYA48PSFF585KT906N3TE",
      field_key: "compaction.enabled",
      host,
      value_schema: { kind: "boolean" },
      unit: "none",
      default_spec: { kind: "fixed", value: true, provenance: researchRef("R-PI.compaction.enabled") },
      source_layers: PI_LAYERS,
      precedence: PI_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: PI_APPLY,
      readback: readback("file_parse", "reload"),
      status: "source_only",
      status_reason: SOURCE_ONLY_BINARY,
      provenance
    }),
    buildSpec({
      field_id: "fld:42C4YWWME6WASVXAXT63WCHFR0",
      field_key: "compaction.reserveTokens",
      host,
      value_schema: { kind: "integer", min: 0, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "fixed", value: 16384, provenance: researchRef("R-PI.compaction.reserveTokens") },
      source_layers: PI_LAYERS,
      precedence: PI_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: PI_APPLY,
      readback: readback("file_parse", "reload"),
      status: "source_only",
      status_reason: SOURCE_ONLY_BINARY,
      provenance
    }),
    buildSpec({
      field_id: "fld:43TJSKFYKAH9PVX2BMA92S4G5Y",
      field_key: "compaction.keepRecentTokens",
      host,
      value_schema: { kind: "integer", min: 0, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "fixed", value: 20000, provenance: researchRef("R-PI.compaction.keepRecentTokens") },
      source_layers: PI_LAYERS,
      precedence: PI_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: PI_APPLY,
      readback: readback("file_parse", "reload"),
      status: "source_only",
      status_reason: SOURCE_ONLY_BINARY,
      provenance
    }),
    buildSpec({
      field_id: "fld:0W63R6PJS8N76SJ88DC081EA4P",
      field_key: "compaction.modelOverrides.<provider>/<modelId>.*",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "string",
        known_values: null,
        provenance: researchRef("R-PI.modelOverrides")
      },
      unit: "none",
      default_spec: { kind: "unknown", provenance: researchRef("R-PI.modelOverrides") },
      source_layers: PI_LAYERS,
      precedence: PI_PRECEDENCE,
      coupling_group: null,
      normalization_id: "pi_model_override_guard",
      apply_boundaries: ["reload"],
      readback: readback("setter_get", "reload", "exact", "setter_get_v1"),
      model_scope: { kind: "exact", provider: "pi", model_id: "<modelId>", variant: null },
      status: "unsupported",
      status_reason: "unsupported：动态键与映射未核实",
      provenance
    })
  ];
}

/* ------------------------------------------------------------------ */
/* oh-my-pi (CFG §8.3)                                                 */
/* ------------------------------------------------------------------ */

const OMP_LAYERS: readonly SourceLayerSpec[] = [
  fileLayer("omp_project_claude_settings", "project", ".claude/settings.json", "json", 0, false, "none", "deep_merge"),
  fileLayer("omp_project_omp_settings", "project", ".omp/settings.json", "json", 1, false, "none", "deep_merge"),
  fileLayer("omp_project_omp_config", "project", ".omp/config.yml", "yaml", 2, false, "none", "deep_merge"),
  fileLayer("omp_user_config", "user", "config.yml", "yaml", 3, true, "none", "deep_merge")
];
const OMP_PRECEDENCE = [
  "omp_project_claude_settings",
  "omp_project_omp_settings",
  "omp_project_omp_config",
  "omp_user_config"
] as const;
const OMP_APPLY: readonly ApplyBoundary[] = ["config_watch", "next_session"];

function ompSpecs(): readonly FieldSpec[] {
  const host = HOST_PROFILES["oh-my-pi"];
  const provenance = [researchRef("R-OMP")];
  return [
    buildSpec({
      field_id: "fld:62MGQ9W0V7DGW4AXP1ZKYEJQY5",
      field_key: "compaction.thresholdPercent",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "number",
        known_values: null,
        provenance: researchRef("R-OMP.thresholdPercent")
      },
      unit: "percent",
      default_spec: { kind: "unknown", provenance: researchRef("R-OMP.thresholdPercent") },
      source_layers: OMP_LAYERS,
      precedence: OMP_PRECEDENCE,
      coupling_group: "omp_threshold_mode",
      normalization_id: "omp_threshold_mode_v1",
      apply_boundaries: OMP_APPLY,
      readback: readback("file_parse", "config_watch", "normalized_equal", "yaml_parse_v1"),
      status: "source_only",
      status_reason: OMP_RANGE,
      provenance
    }),
    buildSpec({
      field_id: "fld:28J07HCCEQFKXKNPTW0Y6CPEFH",
      field_key: "compaction.thresholdTokens",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "integer",
        known_values: [-1],
        provenance: researchRef("R-OMP.thresholdTokens")
      },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-OMP.thresholdTokens") },
      source_layers: OMP_LAYERS,
      precedence: OMP_PRECEDENCE,
      coupling_group: "omp_threshold_mode",
      normalization_id: "omp_threshold_mode_v1",
      apply_boundaries: OMP_APPLY,
      readback: readback("file_parse", "config_watch", "normalized_equal", "yaml_parse_v1"),
      status: "source_only",
      status_reason: OMP_RANGE,
      provenance
    }),
    buildSpec({
      field_id: "fld:SCFRTD7BPKM4Y1ZS3XD223TNTW",
      field_key: "compaction.reserveTokens",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "integer",
        known_values: null,
        provenance: researchRef("R-OMP.reserveTokens")
      },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-OMP.reserveTokens") },
      source_layers: OMP_LAYERS,
      precedence: OMP_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: OMP_APPLY,
      readback: readback("file_parse", "config_watch", "exact", "yaml_parse_v1"),
      status: "source_only",
      status_reason: OMP_RANGE,
      provenance
    }),
    buildSpec({
      field_id: "fld:N8WKYAK2S8VK4Z2DSQ1H5TXAKH",
      field_key: "compaction.keepRecentTokens",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "integer",
        known_values: null,
        provenance: researchRef("R-OMP.keepRecentTokens")
      },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-OMP.keepRecentTokens") },
      source_layers: OMP_LAYERS,
      precedence: OMP_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: OMP_APPLY,
      readback: readback("file_parse", "config_watch", "exact", "yaml_parse_v1"),
      status: "source_only",
      status_reason: OMP_RANGE,
      provenance
    }),
    buildSpec({
      field_id: "fld:X74CN277BK9VVCMBJ4AJ94BMC5",
      field_key: "memory.backend",
      host,
      value_schema: {
        kind: "enum",
        values: ["off", "local", "hindsight", "mnemopi", "sharpshooter"],
        availability: "static"
      },
      unit: "none",
      default_spec: { kind: "fixed", value: "off", provenance: researchRef("R-OMP.memory.backend") },
      source_layers: OMP_LAYERS,
      precedence: OMP_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: OMP_APPLY,
      readback: readback("file_parse", "config_watch", "exact", "yaml_parse_v1"),
      status: "source_only",
      status_reason: OMP_LOAD,
      provenance
    })
  ];
}

/* ------------------------------------------------------------------ */
/* Step Code (CFG §8.4)                                                */
/* ------------------------------------------------------------------ */

const STEP_LAYERS: readonly SourceLayerSpec[] = [
  fileLayer("step_project_config", "project", "config.toml", "toml", 0, true, "project_trust_required", "replace"),
  fileLayer("step_user_config", "user", "config.toml", "toml", 1, true, "none", "replace")
];
const STEP_PRECEDENCE = ["step_project_config", "step_user_config"] as const;
const STEP_APPLY: readonly ApplyBoundary[] = ["reload", "next_session"];

function stepSpecs(): readonly FieldSpec[] {
  const host = HOST_PROFILES["step-code"];
  const provenance = [researchRef("R-STEP")];
  return [
    buildSpec({
      field_id: "fld:HJC2GY4XQV4NEH6KCM137Y3J7F",
      field_key: "compaction.contextProjection",
      host,
      value_schema: { kind: "enum", values: ["lightweight-v1", "clm-v1", "off"], availability: "static" },
      unit: "none",
      default_spec: { kind: "absent", effective_rule_id: "step_projection_effective_default" },
      source_layers: STEP_LAYERS,
      precedence: STEP_PRECEDENCE,
      coupling_group: "step_clm_projection",
      normalization_id: "step_clm_projection_v1",
      apply_boundaries: STEP_APPLY,
      readback: readback("file_parse", "reload", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: STEP_TOML,
      provenance
    }),
    buildSpec({
      field_id: "fld:68A1QDXZQR1SH3CXKYDPGW0W5Z",
      field_key: "compaction.autoClm.softThresholdRatio",
      host,
      value_schema: { kind: "number", min: 0.3, max: 0.85, unit: "ratio", exclusive_min: false, exclusive_max: false },
      unit: "ratio",
      default_spec: { kind: "unknown", provenance: researchRef("R-STEP.softThresholdRatio") },
      source_layers: STEP_LAYERS,
      precedence: STEP_PRECEDENCE,
      coupling_group: "step_clm_projection",
      normalization_id: "step_clm_projection_v1",
      apply_boundaries: STEP_APPLY,
      readback: readback("file_parse", "reload", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: "source_only：default 与段路径未核实",
      provenance
    }),
    buildSpec({
      field_id: "fld:J0NY7KMDB3CRMFGD9XVKEZHQRK",
      field_key: "compaction.enabled",
      host,
      value_schema: { kind: "boolean" },
      unit: "none",
      default_spec: { kind: "unknown", provenance: researchRef("R-STEP.compaction.enabled") },
      source_layers: STEP_LAYERS,
      precedence: STEP_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: STEP_APPLY,
      readback: readback("file_parse", "reload", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: "source_only：default 未核实",
      provenance
    }),
    buildSpec({
      field_id: "fld:1VGCNVC162YVP2CWRBE2QKZ6V5",
      field_key: "compaction.reserveTokens",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "integer",
        known_values: null,
        provenance: researchRef("R-STEP.reserveTokens")
      },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-STEP.reserveTokens") },
      source_layers: STEP_LAYERS,
      precedence: STEP_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: STEP_APPLY,
      readback: readback("file_parse", "reload", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: OMP_RANGE,
      provenance
    }),
    buildSpec({
      field_id: "fld:8BGGZFFYJJE6ZRQY9JFDE3E8BC",
      field_key: "compaction.keepRecentTokens",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "integer",
        known_values: null,
        provenance: researchRef("R-STEP.keepRecentTokens")
      },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-STEP.keepRecentTokens") },
      source_layers: STEP_LAYERS,
      precedence: STEP_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: STEP_APPLY,
      readback: readback("file_parse", "reload", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: OMP_RANGE,
      provenance
    })
  ];
}

/* ------------------------------------------------------------------ */
/* Codex (CFG §8.5)                                                    */
/* ------------------------------------------------------------------ */

const CODEX_LAYERS: readonly SourceLayerSpec[] = [
  fileLayer("codex_project_config", "project", ".codex/config.toml", "toml", 0, true, "project_trust_required", "replace"),
  fileLayer("codex_user_config", "user", ".codex/config.toml", "toml", 1, true, "none", "replace"),
  fileLayer("codex_managed_config", "managed", ".codex/config.toml", "toml", 2, false, "none", "replace")
];
const CODEX_PRECEDENCE = ["codex_project_config", "codex_user_config", "codex_managed_config"] as const;
const CODEX_APPLY: readonly ApplyBoundary[] = ["next_session"];

function codexSpecs(): readonly FieldSpec[] {
  const host = HOST_PROFILES.codex;
  const provenance = [researchRef("R-CODEX")];
  return [
    buildSpec({
      field_id: "fld:086D6Y9CYD493TSMY783WX40V6",
      field_key: "model_context_window",
      host,
      value_schema: { kind: "integer", min: 1, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-CODEX.model_context_window") },
      source_layers: CODEX_LAYERS,
      precedence: CODEX_PRECEDENCE,
      coupling_group: "codex_compaction_limits",
      normalization_id: "identity",
      apply_boundaries: CODEX_APPLY,
      readback: readback("file_parse", "next_session", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: CODEX_BINARY,
      provenance
    }),
    buildSpec({
      field_id: "fld:JFG1W6Z657VXAN9NJAGKPHG2KQ",
      field_key: "model_auto_compact_token_limit",
      host,
      value_schema: { kind: "integer", min: 1, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-CODEX.model_auto_compact_token_limit") },
      source_layers: CODEX_LAYERS,
      precedence: CODEX_PRECEDENCE,
      coupling_group: "codex_compaction_limits",
      normalization_id: "codex_compaction_limits_v1",
      apply_boundaries: CODEX_APPLY,
      readback: readback("file_parse", "next_session", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: CODEX_DEFAULT,
      provenance
    }),
    buildSpec({
      field_id: "fld:709CP973EP4M6CMAQYMB2RSPWR",
      field_key: "model_auto_compact_token_limit_scope",
      host,
      value_schema: { kind: "enum", values: ["total", "body_after_prefix"], availability: "static" },
      unit: "none",
      default_spec: { kind: "unknown", provenance: researchRef("R-CODEX.model_auto_compact_token_limit_scope") },
      source_layers: CODEX_LAYERS,
      precedence: CODEX_PRECEDENCE,
      coupling_group: "codex_compaction_limits",
      normalization_id: "codex_compaction_limits_v1",
      apply_boundaries: CODEX_APPLY,
      readback: readback("file_parse", "next_session", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: "source_only：default 未核实",
      provenance
    }),
    buildSpec({
      field_id: "fld:R5B73DDDTVCWFRF6Z2HGKWFGAP",
      field_key: "model_post_turn_compact_threshold_percent",
      host,
      value_schema: { kind: "integer", min: 0, max: 100, unit: "percent" },
      unit: "percent",
      default_spec: { kind: "unknown", provenance: researchRef("R-CODEX.post_turn_percent") },
      source_layers: CODEX_LAYERS,
      precedence: CODEX_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: CODEX_APPLY,
      readback: readback("file_parse", "next_session", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: CODEX_BINARY,
      provenance
    }),
    buildSpec({
      field_id: "fld:CE8EJTDXRA07NGKN5VBAFBDT2E",
      field_key: "features.async_compaction.enabled",
      host,
      value_schema: { kind: "boolean" },
      unit: "none",
      default_spec: { kind: "fixed", value: false, provenance: researchRef("R-CODEX.async_compaction.enabled") },
      source_layers: CODEX_LAYERS,
      precedence: CODEX_PRECEDENCE,
      coupling_group: null,
      normalization_id: "codex_compaction_limits_v1",
      apply_boundaries: CODEX_APPLY,
      readback: readback("file_parse", "next_session", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: CODEX_PATH,
      provenance
    }),
    buildSpec({
      field_id: "fld:EJA16THH1V2HKPEA0B8J4CZBFF",
      field_key: "features.async_compaction.model_async_compact_threshold_percent",
      host,
      value_schema: { kind: "integer", min: 1, max: 100, unit: "percent" },
      unit: "percent",
      default_spec: { kind: "fixed", value: 65, provenance: researchRef("R-CODEX.async_threshold_percent") },
      source_layers: CODEX_LAYERS,
      precedence: CODEX_PRECEDENCE,
      coupling_group: null,
      normalization_id: "codex_compaction_limits_v1",
      apply_boundaries: CODEX_APPLY,
      readback: readback("file_parse", "next_session", "exact", "toml_parse_v1"),
      status: "source_only",
      status_reason: CODEX_PATH,
      provenance
    }),
    buildSpec({
      field_id: "fld:2G3SR65DQKF4PD2DP6PQ8M4572",
      field_key: "model_reasoning_effort",
      host,
      value_schema: {
        kind: "enum",
        values: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent", "custom"],
        availability: "host_catalog"
      },
      unit: "effort_level",
      default_spec: { kind: "fixed", value: "medium", provenance: researchRef("R-CODEX.model_reasoning_effort") },
      source_layers: CODEX_LAYERS,
      precedence: CODEX_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: CODEX_APPLY,
      readback: readback("file_parse", "next_session", "exact", "toml_parse_v1"),
      model_scope: { kind: "exact", provider: "openai", model_id: "<model>", variant: null },
      status: "source_only",
      status_reason: "source_only：可用值未按模型核实",
      provenance
    })
  ];
}

/* ------------------------------------------------------------------ */
/* OpenCode (CFG §8.6)                                                 */
/* ------------------------------------------------------------------ */

const OPENCODE_LAYERS: readonly SourceLayerSpec[] = [
  fileLayer("opencode_project_config", "project", "opencode.json", "json", 0, true, "project_trust_required", "replace"),
  fileLayer("opencode_user_config", "user", "opencode.json", "json", 1, true, "none", "replace")
];
const OPENCODE_PRECEDENCE = ["opencode_project_config", "opencode_user_config"] as const;
const OPENCODE_APPLY: readonly ApplyBoundary[] = ["next_session"];

function opencodeSpecs(): readonly FieldSpec[] {
  const host = HOST_PROFILES.opencode;
  const provenance = [researchRef("R-OPENCODE")];
  return [
    buildSpec({
      field_id: "fld:4V10G0ZD9R0NQFY7PE7DYZPQ92",
      field_key: "compaction.auto",
      host,
      value_schema: { kind: "boolean" },
      unit: "none",
      default_spec: { kind: "fixed", value: true, provenance: researchRef("R-OPENCODE.compaction.auto") },
      source_layers: OPENCODE_LAYERS,
      precedence: OPENCODE_PRECEDENCE,
      // `opencode_keep_tokens_v1` always projects auto/keep/buffer together,
      // and auto=false shadows the keep trio, so the three form one coupled
      // factor. A standalone auto would make every projected factor violate
      // the single-group rule before it could be written.
      coupling_group: "opencode_keep_tokens",
      normalization_id: "opencode_keep_tokens_v1",
      apply_boundaries: OPENCODE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      status: "source_only",
      status_reason: OPENCODE_VERSION,
      provenance
    }),
    buildSpec({
      field_id: "fld:W6T4A1ARSV7FZ35QHS9GGSY4XP",
      field_key: "compaction.keep.tokens",
      host,
      value_schema: { kind: "integer", min: 0, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "fixed", value: 15000, provenance: researchRef("R-OPENCODE.compaction.keep.tokens") },
      source_layers: OPENCODE_LAYERS,
      precedence: OPENCODE_PRECEDENCE,
      coupling_group: "opencode_keep_tokens",
      normalization_id: "opencode_keep_tokens_v1",
      apply_boundaries: OPENCODE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      status: "source_only",
      status_reason: OPENCODE_VERSION,
      provenance
    }),
    buildSpec({
      field_id: "fld:YTJTH4C6EA6N5DSQBJ50EXB27D",
      field_key: "compaction.buffer",
      host,
      value_schema: { kind: "integer", min: 0, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "unknown", provenance: researchRef("R-OPENCODE.compaction.buffer") },
      source_layers: OPENCODE_LAYERS,
      precedence: OPENCODE_PRECEDENCE,
      coupling_group: "opencode_keep_tokens",
      normalization_id: "opencode_keep_tokens_v1",
      apply_boundaries: OPENCODE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      status: "source_only",
      status_reason: "source_only：default/上限未核实",
      provenance
    }),
    buildSpec({
      field_id: "fld:4MZG11DKG26CRMF75WPM2WA5R2",
      field_key: "model",
      host,
      value_schema: {
        kind: "unverified",
        documented_shape: "string",
        known_values: null,
        provenance: researchRef("R-OPENCODE.model")
      },
      unit: "model_ref",
      default_spec: { kind: "unknown", provenance: researchRef("R-OPENCODE.model") },
      source_layers: OPENCODE_LAYERS,
      precedence: OPENCODE_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: OPENCODE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      model_scope: { kind: "exact", provider: "<provider>", model_id: "<model>", variant: null },
      status: "source_only",
      status_reason: "source_only：variant 映射未核实",
      provenance
    })
  ];
}

/* ------------------------------------------------------------------ */
/* OpenHands SDK (CFG §8.7)                                            */
/* ------------------------------------------------------------------ */

const OPENHANDS_LAYERS: readonly SourceLayerSpec[] = [settingsApiLayer("openhands_server_settings")];
const OPENHANDS_PRECEDENCE = ["openhands_server_settings"] as const;

function openhandsSpecs(): readonly FieldSpec[] {
  const host = HOST_PROFILES["openhands-sdk"];
  const provenance = [researchRef("R-OPENHANDS")];
  const base = {
    host,
    source_layers: OPENHANDS_LAYERS,
    precedence: OPENHANDS_PRECEDENCE,
    normalization_id: "openhands_condenser_v1" as const,
    apply_boundaries: ["conversation_start"] as readonly ApplyBoundary[],
    readback: readback("host_api", "conversation_start", "exact", "openhands_settings_v1"),
    status: "unsupported" as const,
    status_reason: OPENHANDS_UNSUPPORTED,
    provenance
  };
  return [
    buildSpec({
      ...base,
      field_id: "fld:ZVRWNENTRY8Y9KYVE9C4F35RFE",
      field_key: "condenser.max_size",
      value_schema: { kind: "integer", min: 1, max: null, unit: "none" },
      unit: "none",
      default_spec: {
        kind: "path_dependent",
        selector: "openhands_construction_path",
        cases: [
          { path: "server_settings", value: { presence: "present", value: 240 } },
          { path: "preset_agent", value: { presence: "present", value: 80 } },
          { path: "subagent_factory", value: { presence: "present", value: 80 } },
          { path: "direct_agent", value: { presence: "absent" } }
        ]
      },
      coupling_group: "openhands_condenser"
    }),
    buildSpec({
      ...base,
      field_id: "fld:VDKEKC9K5ZEGZ5CCSN31GYGR3C",
      field_key: "condenser.keep_first",
      value_schema: { kind: "integer", min: 0, max: null, unit: "none" },
      unit: "none",
      default_spec: {
        kind: "path_dependent",
        selector: "openhands_construction_path",
        cases: [
          { path: "server_settings", value: { presence: "present", value: 2 } },
          { path: "preset_agent", value: { presence: "present", value: 4 } },
          { path: "subagent_factory", value: { presence: "present", value: 4 } },
          { path: "direct_agent", value: { presence: "absent" } }
        ]
      },
      coupling_group: "openhands_condenser"
    }),
    buildSpec({
      ...base,
      field_id: "fld:FXAA98S1D2JF5JKMMKGMZ82R9G",
      field_key: "condenser.max_tokens",
      value_schema: {
        kind: "unverified",
        documented_shape: "integer",
        known_values: [null],
        provenance: researchRef("R-OPENHANDS.condenser.max_tokens")
      },
      unit: "tokens",
      default_spec: {
        kind: "fixed",
        value: null,
        provenance: researchRef("R-OPENHANDS.condenser.max_tokens")
      },
      coupling_group: "openhands_condenser"
    }),
    buildSpec({
      ...base,
      field_id: "fld:RSXV3Q5KFJ6DA146YKAG5Q608Z",
      field_key: "llm.reasoning_effort",
      value_schema: {
        kind: "enum",
        values: ["low", "medium", "high", "xhigh", "none"],
        availability: "host_catalog"
      },
      unit: "effort_level",
      default_spec: { kind: "fixed", value: "high", provenance: researchRef("R-OPENHANDS.llm.reasoning_effort") },
      coupling_group: null,
      normalization_id: "identity",
      model_scope: { kind: "exact", provider: "<provider>", model_id: "<model>", variant: null }
    }),
    buildSpec({
      field_id: "fld:29MGN6F6VP66N463WCSY67CQCR",
      field_key: "context.load_memory",
      host,
      value_schema: { kind: "boolean" },
      unit: "none",
      default_spec: { kind: "fixed", value: false, provenance: researchRef("R-OPENHANDS.context.load_memory") },
      source_layers: OPENHANDS_LAYERS,
      precedence: OPENHANDS_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: ["conversation_start"],
      readback: readback("host_api", "conversation_start", "exact", "openhands_settings_v1"),
      status: "unsupported",
      status_reason: "unsupported：constructor-only",
      provenance
    })
  ];
}

/* ------------------------------------------------------------------ */
/* Claude Code (CFG §8.8)                                              */
/* ------------------------------------------------------------------ */

const CLAUDE_LAYERS: readonly SourceLayerSpec[] = [
  fileLayer("claude_managed_settings", "managed", "managed-settings.json", "json", 0, false, "none", "replace"),
  fileLayer("claude_local_settings", "project", ".claude/settings.local.json", "json", 1, true, "project_trust_required", "replace"),
  fileLayer("claude_project_settings", "project", ".claude/settings.json", "json", 2, true, "project_trust_required", "replace"),
  fileLayer("claude_user_settings", "user", ".claude/settings.json", "json", 3, true, "none", "replace")
];
const CLAUDE_PRECEDENCE = [
  "claude_managed_settings",
  "claude_local_settings",
  "claude_project_settings",
  "claude_user_settings"
] as const;
const CLAUDE_APPLY: readonly ApplyBoundary[] = ["next_session"];

function claudeSpecs(): readonly FieldSpec[] {
  const host = HOST_PROFILES["claude-code"];
  const provenance = [researchRef("R-CLAUDE")];
  return [
    buildSpec({
      field_id: "fld:HEBC6RXFFKDAHYZX87MKSD5ZJX",
      field_key: "model",
      host,
      value_schema: {
        kind: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
        max_length: 128,
        unit: "model_ref"
      },
      unit: "model_ref",
      default_spec: { kind: "absent", effective_rule_id: "claude_model_host_default" },
      source_layers: CLAUDE_LAYERS,
      precedence: CLAUDE_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: CLAUDE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      status: "h_unverified",
      status_reason: CLAUDE_H,
      provenance
    }),
    buildSpec({
      field_id: "fld:2TGVQ7S662T6MHYTA0QK4BH997",
      field_key: "modelSettings.<canonical>.effortLevel",
      host,
      value_schema: { kind: "enum", values: ["low", "medium", "high", "xhigh"], availability: "static" },
      unit: "effort_level",
      default_spec: { kind: "absent", effective_rule_id: "claude_effort_model_default" },
      source_layers: CLAUDE_LAYERS,
      precedence: CLAUDE_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: CLAUDE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      model_scope: { kind: "exact", provider: "anthropic", model_id: "<canonical>", variant: null },
      status: "h_unverified",
      status_reason: CLAUDE_H,
      provenance
    }),
    buildSpec({
      field_id: "fld:38CBTF3JXKAXEMBQB7PAF8BGW5",
      field_key: "autoCompactWindow",
      host,
      value_schema: { kind: "integer", min: 100000, max: 1000000, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "absent", effective_rule_id: "claude_autocompact_host_default" },
      source_layers: CLAUDE_LAYERS,
      precedence: CLAUDE_PRECEDENCE,
      coupling_group: "claude_autocompact",
      normalization_id: "claude_autocompact_window_v1",
      apply_boundaries: CLAUDE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      status: "h_unverified",
      status_reason: CLAUDE_H,
      provenance
    }),
    buildSpec({
      field_id: "fld:A8227F383RTREE1CJ2CN2PEFGY",
      field_key: "modelSettings.<canonical>.autoCompactWindow",
      host,
      value_schema: {
        kind: "integer_or_enum",
        min: 100000,
        max: 1000000,
        unit: "tokens",
        values: ["auto"],
        availability: "host_catalog"
      },
      unit: "tokens",
      default_spec: { kind: "absent", effective_rule_id: "claude_autocompact_host_default" },
      source_layers: CLAUDE_LAYERS,
      precedence: CLAUDE_PRECEDENCE,
      coupling_group: "claude_autocompact",
      normalization_id: "claude_autocompact_window_v1",
      apply_boundaries: CLAUDE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      model_scope: { kind: "exact", provider: "anthropic", model_id: "<canonical>", variant: null },
      status: "h_unverified",
      status_reason: "h_unverified：`auto` 解析未核实",
      provenance
    }),
    buildSpec({
      field_id: "fld:WQRV7R4SJC35MRZVMWNXAQG9DX",
      field_key: "alwaysThinkingEnabled",
      host,
      value_schema: { kind: "boolean" },
      unit: "none",
      default_spec: { kind: "unknown", provenance: researchRef("R-CLAUDE.alwaysThinkingEnabled") },
      source_layers: CLAUDE_LAYERS,
      precedence: CLAUDE_PRECEDENCE,
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: CLAUDE_APPLY,
      readback: readback("file_parse", "next_session", "exact", "json_parse_v1"),
      status: "h_unverified",
      status_reason: "h_unverified：默认值与 H 未核实",
      provenance
    }),
    buildSpec({
      field_id: "fld:5HH1N7GEZT4M77GVNA9EX7S2JM",
      field_key: "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      host,
      value_schema: { kind: "integer", min: 1, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "absent", effective_rule_id: "claude_max_output_host_default" },
      source_layers: [envLayer("claude_process_env", "CLAUDE_CODE_MAX_OUTPUT_TOKENS")],
      precedence: ["claude_process_env"],
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: ["process_restart"],
      readback: readback("process_env", "process_restart", "exact", "process_env_v1"),
      window_profile_id: "W2",
      authorization_class: "host_capacity",
      status: "unsupported",
      status_reason: CLAUDE_ENV,
      provenance
    }),
    buildSpec({
      field_id: "fld:6M97KPBX9Y87WTVCRCC1S30T44",
      field_key: "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      host,
      value_schema: { kind: "integer", min: 1, max: null, unit: "tokens" },
      unit: "tokens",
      default_spec: { kind: "absent", effective_rule_id: "claude_max_context_host_default" },
      source_layers: [envLayer("claude_process_env", "CLAUDE_CODE_MAX_CONTEXT_TOKENS")],
      precedence: ["claude_process_env"],
      coupling_group: null,
      normalization_id: "identity",
      apply_boundaries: ["process_restart"],
      readback: readback("process_env", "process_restart", "exact", "process_env_v1"),
      window_profile_id: "W2",
      authorization_class: "host_capacity",
      status: "unsupported",
      status_reason: CLAUDE_ENV,
      provenance
    })
  ];
}

/* ------------------------------------------------------------------ */
/* Public registry tables                                              */
/* ------------------------------------------------------------------ */

export const PI_FIELD_SPECS: readonly FieldSpec[] = piSpecs();
const OMP_FIELD_SPECS: readonly FieldSpec[] = ompSpecs();
export const STEP_FIELD_SPECS: readonly FieldSpec[] = stepSpecs();
const CODEX_FIELD_SPECS: readonly FieldSpec[] = codexSpecs();
const OPENCODE_FIELD_SPECS: readonly FieldSpec[] = opencodeSpecs();
const OPENHANDS_FIELD_SPECS: readonly FieldSpec[] = openhandsSpecs();
const CLAUDE_FIELD_SPECS: readonly FieldSpec[] = claudeSpecs();

export const HOST_FIELD_SPECS: Readonly<Record<HostId, readonly FieldSpec[]>> = {
  pi: PI_FIELD_SPECS,
  "oh-my-pi": OMP_FIELD_SPECS,
  "step-code": STEP_FIELD_SPECS,
  codex: CODEX_FIELD_SPECS,
  opencode: OPENCODE_FIELD_SPECS,
  "openhands-sdk": OPENHANDS_FIELD_SPECS,
  "claude-code": CLAUDE_FIELD_SPECS
};

/** All 37 registered field specs, ascending by `field_id`. */
export const ALL_FIELD_SPECS: readonly FieldSpec[] = [
  ...PI_FIELD_SPECS,
  ...OMP_FIELD_SPECS,
  ...STEP_FIELD_SPECS,
  ...CODEX_FIELD_SPECS,
  ...OPENCODE_FIELD_SPECS,
  ...OPENHANDS_FIELD_SPECS,
  ...CLAUDE_FIELD_SPECS
];

export const REGISTRY_VERSION = "rsi-field-registry/2026-10-21";

/**
 * Builds the content-addressed registry snapshot for one host. The snapshot
 * uses the host profile axes and model scope `any`; per-field model scopes are
 * retained on each `FieldSpec` and resolved by specificity.
 */
export function buildHostFieldRegistry(
  hostId: HostId,
  createdAt: number
): ConfigResult<FieldRegistrySnapshot> {
  const profile = HOST_PROFILES[hostId];
  return buildFieldRegistrySnapshot({
    registry_version: REGISTRY_VERSION,
    host_id: hostId,
    source_pin: profile.source_pin,
    binary_pin: profile.binary_pin,
    adapter_version: ADAPTER_VERSION,
    config_space: profile.config_space,
    mapping: profile.mapping,
    mode: profile.mode,
    construction_path: profile.construction_path,
    model_scope: { kind: "any" },
    field_specs: HOST_FIELD_SPECS[hostId],
    deny_rules: defaultDenyRules(),
    created_at: createdAt
  });
}

