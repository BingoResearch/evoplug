/**
 * W10 compaction-only promotion rules (D7).
 *
 * The tunable surface is a closed allowlist of the eight taskbook compaction
 * classes. Model and thinking controls are denied independently of the
 * allowlist: they are never made tunable by adding a field key to
 * `auto_tune_fields`.
 *
 * Promotion is evidence driven. A write plus a matching readback can move
 * `source_only` to `h_unverified`. `active` additionally needs a real reload
 * or host-resolved-config readback: a `file_parse`/`next_session` declaration
 * is not effect evidence.
 */

import type { Id } from "../ids.js";
import type { Hash } from "../hash.js";
import type { SourceRef } from "../source-ref.js";
import type { HostId } from "../generated/host-vocabulary.js";
import type { EvidenceStage, HostProbeResult } from "../generated/host-vocabulary.js";
import type {
  ApplyBoundary,
  AssignmentValue,
  ConfigResult,
  EffectiveProbe,
  EpochMs,
  FieldAssignment,
  FieldReadback,
  FieldSpec,
  FieldStatus,
  HostBinding
} from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import { computeFieldSpecHash } from "./hash.js";
import { probeProvesEffective } from "./trial.js";
import { assignmentValueKey, validatePresentValue } from "./values.js";

/* ------------------------------------------------------------------ */
/* Closed tuning surface                                               */
/* ------------------------------------------------------------------ */

/** The eight taskbook compaction classes. No other field key is tunable. */
export const COMPACTION_TUNE_ALLOWLIST: readonly string[] = Object.freeze([
  "compaction.enabled",
  "compaction.reserveTokens",
  "compaction.keepRecentTokens",
  "compaction.thresholdPercent",
  "compaction.thresholdTokens",
  "compaction.auto",
  "compaction.keep.tokens",
  "compaction.buffer"
]);

const HARD_DENIED_KEYS: ReadonlySet<string> = new Set([
  "model",
  "reasoning_effort",
  "model_reasoning_effort",
  "llm.reasoning_effort",
  "alwaysThinkingEnabled"
]);

const HARD_DENIED_PREFIXES: readonly string[] = [
  "modelSettings.",
  "CLAUDE_CODE_MAX_",
  // Model-aware compaction overrides change the selected model's behaviour.
  // They are outside the eight closed classes even though the key starts with
  // `compaction.`.
  "compaction.modelOverrides."
];

/** True when the key is one of the eight taskbook compaction classes. */
export function isCompactionTuneKey(fieldKey: string): boolean {
  return COMPACTION_TUNE_ALLOWLIST.includes(fieldKey);
}

/**
 * True when the key is a model, thinking or model-override control. Hard
 * denial runs before the allowlist, so an allowlisted-looking key cannot
 * bypass it.
 */
export function isHardDeniedTuneKey(fieldKey: string): boolean {
  if (HARD_DENIED_KEYS.has(fieldKey)) {
    return true;
  }
  return HARD_DENIED_PREFIXES.some((prefix) => fieldKey.startsWith(prefix));
}

export interface TuneAdmissionOptions {
  /**
   * When true, only `active` + `exact` is admitted. Trial writes pass false:
   * `source_only` and `h_unverified` fields must remain writable so evidence
   * can be collected. An `active` field is always held to `exact`.
   */
  readonly require_active: boolean;
}

/**
 * Checks one field for a tune path. Order is fixed: hard denial, allowlist,
 * value-schema executability, status admissibility, then the strict
 * `active`+`exact` gate when requested.
 */
export function checkFieldTunable(
  spec: FieldSpec,
  allowlist: readonly string[],
  options: TuneAdmissionOptions
): ConfigResult<void> {
  if (isHardDeniedTuneKey(spec.field_key)) {
    return fail(
      configError("E_CFG_FORBIDDEN_FIELD", {
        field_id: spec.field_id,
        details: [{ key: "reason", value: "model_or_thinking_not_tunable" }]
      })
    );
  }
  if (!allowlist.includes(spec.field_key) || !isCompactionTuneKey(spec.field_key)) {
    return fail(
      configError("E_CFG_FIELD_NOT_EXECUTABLE", {
        field_id: spec.field_id,
        details: [
          { key: "field_key", value: spec.field_key },
          { key: "reason", value: "outside_compaction_allowlist" }
        ]
      })
    );
  }
  if (spec.value_schema.kind === "unverified") {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id }));
  }
  if (spec.status === "unsupported") {
    return fail(
      configError("E_CFG_FIELD_NOT_EXECUTABLE", {
        field_id: spec.field_id,
        details: [
          { key: "status", value: spec.status },
          { key: "status_reason", value: spec.status_reason }
        ]
      })
    );
  }
  if (options.require_active) {
    if (spec.status !== "active") {
      return fail(
        configError("E_CFG_FIELD_NOT_EXECUTABLE", {
          field_id: spec.field_id,
          details: [
            { key: "status", value: spec.status },
            { key: "status_reason", value: spec.status_reason }
          ]
        })
      );
    }
    if (spec.mapping !== "exact") {
      return fail(
        configError("E_CFG_CAPABILITY_UNVERIFIED", {
          field_id: spec.field_id,
          details: [{ key: "mapping", value: spec.mapping }]
        })
      );
    }
  }
  if (spec.status === "active" && spec.mapping !== "exact") {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        field_id: spec.field_id,
        details: [{ key: "mapping", value: spec.mapping }]
      })
    );
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Promotion evidence                                                  */
/* ------------------------------------------------------------------ */

export interface PromotionCapabilityEvidence {
  /**
   * The persisted capability record fields, passed through unchanged. The
   * evaluator itself requires `passed` + `roundtrip`; callers must not
   * synthesize that pair when the record says `unknown` or `none`.
   */
  readonly probe_result: HostProbeResult;
  readonly evidence_stage: EvidenceStage;
}

export interface PromotionEvidence {
  readonly host_id: HostId;
  readonly field_id: Id<"fld">;
  /** The value written by the trial and expected on readback. */
  readonly candidate: AssignmentValue;
  readonly write_evidence: SourceRef;
  readonly readback: FieldReadback;
  /**
   * Process reload or host-resolved-config evidence, never a declaration.
   * `null` is honest for `source_only -> h_unverified`, which needs only the
   * write/readback roundtrip; `h_unverified -> active` requires a non-null
   * probe with real resolved values.
   */
  readonly reload: EffectiveProbe | null;
  readonly capability: PromotionCapabilityEvidence;
}

export interface PromotionResult {
  readonly from: FieldStatus;
  readonly to: "h_unverified" | "active";
  readonly spec: FieldSpec;
}

/* ------------------------------------------------------------------ */
/* Adapter-injected declarations (W10)                                 */
/* ------------------------------------------------------------------ */

/** One physical file a config space reads or writes. */
export interface ConfigLayerTarget {
  readonly layer_id: string;
  readonly root_kind: "user" | "project" | "managed" | "session";
  /** FND root registration id for this file's root. */
  readonly root_id: string;
  readonly relative_path: string;
  readonly format: "json" | "jsonc" | "yaml" | "toml";
}

/** Field key → JSON pointer mapping for one layer. */
export interface CompactionFieldPath {
  readonly field_key: string;
  readonly layer_id: string;
  readonly pointer: string;
}

/**
 * Adapter declaration for one config space. This is the only place host
 * differences enter W10; the kernel never branches on `host_id`.
 */
export interface ConfigSpaceCatalogEntry {
  readonly config_space: string;
  readonly host: HostBinding;
  readonly root_id: string;
  readonly source_layer_id: string;
  readonly source_layer_set_hash: Hash;
  readonly capability_binding_key: Hash;
  readonly capability_snapshot_hash: Hash;
  readonly trust_evidence_ref: SourceRef | null;
  readonly layers: readonly ConfigLayerTarget[];
  readonly field_paths: readonly CompactionFieldPath[];
}

export interface ConfigSpaceCatalogPort {
  get(config_space_id: Hash): ConfigResult<ConfigSpaceCatalogEntry>;
}

/** One resolved config read produced by a real reload path. */
export interface ConfigReloadResolved {
  readonly assignments: readonly FieldAssignment[];
  readonly evidence_ref: SourceRef;
  readonly baseline_explainable: boolean;
  readonly repeat_count: number;
  readonly observed_at: EpochMs;
}

/**
 * Adapter declaration of a reload channel. `unsupported` maps the old
 * `next_session` declaration: a session boundary is not effect evidence.
 */
export interface ConfigReloadDeclaration {
  readonly config_space_id: Hash;
  /** Diagnostic only; the lookup key is `config_space_id`. */
  readonly config_space: string;
  readonly kind: "sdk_reload" | "new_process_parse" | "config_watch" | "unsupported";
  resolve(input: {
    readonly field_ids: readonly Id<"fld">[];
    readonly deadline_ms: number;
    readonly signal?: AbortSignal;
  }): Promise<ConfigResult<ConfigReloadResolved>>;
}

export interface ConfigReloadProbeInput {
  readonly trial_id: Id<"ctr">;
  readonly config_space_id: Hash;
  readonly field_ids: readonly Id<"fld">[];
  readonly layer_id: string;
  readonly deadline_ms: number;
  readonly signal?: AbortSignal;
}

/**
 * The probe keeps the declaration kind beside the frozen `EffectiveProbe`:
 * `process_reload` / `new_process_parse` are both real effects, while a
 * `next_session` declaration is `unsupported` and never produces evidence.
 */
export interface ConfigReloadProbeResult {
  readonly probe: EffectiveProbe;
  readonly evidence_kind: "sdk_reload" | "new_process_parse" | "config_watch";
}

export interface ConfigReloadProbePort {
  probe(input: ConfigReloadProbeInput): Promise<ConfigResult<ConfigReloadProbeResult>>;
}

function effectiveBoundaryCountsAsEffect(boundary: ApplyBoundary): boolean {
  return boundary === "reload" || boundary === "config_watch" || boundary === "process_restart";
}

function hasRealReloadEvidence(readback: FieldReadback, probe: EffectiveProbe): boolean {
  if (probe.source !== "host_resolved_config" && probe.source !== "runtime_log_resolved") {
    return false;
  }
  if (probe.resolved.length === 0 || probe.evidence_ref.length === 0) {
    return false;
  }
  if (probe.observed_at < readback.observed_at) {
    return false;
  }
  return probeProvesEffective(probe);
}

function assertEvidenceShape(
  spec: FieldSpec,
  evidence: PromotionEvidence,
  allowlist: readonly string[]
): ConfigResult<void> {
  const allowed = checkFieldTunable(spec, allowlist, { require_active: false });
  if (!allowed.ok) {
    return allowed;
  }
  if (spec.host_id !== evidence.host_id || spec.field_id !== evidence.field_id) {
    return fail(
      configError("E_CFG_AUTHORIZATION_SCOPE", {
        field_id: spec.field_id,
        details: [{ key: "dimension", value: "host_or_field" }]
      })
    );
  }
  if (evidence.write_evidence.length === 0 || evidence.readback.evidence_ref.length === 0) {
    return fail(configError("E_CFG_APPLY_UNCONFIRMED", { field_id: spec.field_id }));
  }
  if (evidence.capability.probe_result !== "passed" || evidence.capability.evidence_stage !== "roundtrip") {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { field_id: spec.field_id }));
  }
  if (evidence.candidate.presence === "present") {
    const checked = validatePresentValue(spec, evidence.candidate.value);
    if (!checked.ok) {
      return checked;
    }
  }
  if (evidence.readback.field_id !== spec.field_id) {
    return fail(configError("E_CFG_FIELD_CONFLICT", { field_id: spec.field_id }));
  }
  if (evidence.readback.config_version.length === 0) {
    return fail(configError("E_CFG_APPLY_UNCONFIRMED", { field_id: spec.field_id }));
  }
  if (assignmentValueKey(evidence.readback.observed) !== assignmentValueKey(evidence.candidate)) {
    return fail(
      configError("E_CFG_APPLY_UNCONFIRMED", {
        field_id: spec.field_id,
        details: [{ key: "readback", value: "candidate_mismatch" }]
      })
    );
  }
  return succeed(undefined);
}

function promotedSpec(spec: FieldSpec, status: "h_unverified" | "active", reason: string): FieldSpec {
  const { spec_hash: _ignored, ...body } = spec;
  void _ignored;
  const next = { ...body, status, status_reason: reason };
  return { ...next, spec_hash: computeFieldSpecHash(next) };
}

/**
 * Evaluates one promotion step.
 *
 * - `source_only` + write/readback roundtrip -> `h_unverified`.
 * - `h_unverified` + real reload/probe -> `active` (requires `mapping=exact`).
 * - `active` stays `active` when the same evidence validates.
 *
 * A reload without a prior `h_unverified` status still returns one step only;
 * callers can evaluate the returned spec a second time to reach `active`.
 */
export function evaluateCompactionPromotion(
  spec: FieldSpec,
  evidence: PromotionEvidence,
  allowlist: readonly string[] = COMPACTION_TUNE_ALLOWLIST
): ConfigResult<PromotionResult> {
  const shape = assertEvidenceShape(spec, evidence, allowlist);
  if (!shape.ok) {
    return shape;
  }
  if (spec.status === "unsupported") {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id }));
  }
  if (!effectiveBoundaryCountsAsEffect("reload")) {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id }));
  }
  if (spec.status === "active") {
    return succeed({ from: "active", to: "active", spec });
  }
  if (spec.status === "source_only") {
    return succeed({
      from: "source_only",
      to: "h_unverified",
      spec: promotedSpec(spec, "h_unverified", "h_unverified：写入与读回已核实，等待真实 reload 证据")
    });
  }
  // h_unverified -> active.
  if (evidence.reload === null || !hasRealReloadEvidence(evidence.readback, evidence.reload)) {
    return fail(
      configError("E_CFG_APPLY_UNCONFIRMED", {
        field_id: spec.field_id,
        details: [{ key: "reload", value: "not_host_resolved_config" }]
      })
    );
  }
  const resolved = evidence.reload.resolved.find((assignment) => assignment.field_id === spec.field_id);
  if (
    resolved === undefined ||
    assignmentValueKey(resolved.value) !== assignmentValueKey(evidence.candidate)
  ) {
    return fail(configError("E_CFG_APPLY_UNCONFIRMED", { field_id: spec.field_id }));
  }
  if (spec.mapping !== "exact") {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        field_id: spec.field_id,
        details: [{ key: "mapping", value: spec.mapping }]
      })
    );
  }
  return succeed({
    from: "h_unverified",
    to: "active",
    spec: promotedSpec(spec, "active", "active：H 写回读与 reload/resolved-config 已验证")
  });
}
