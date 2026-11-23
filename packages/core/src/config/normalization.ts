/**
 * Coupling-field normalization (DD-CFG-060 … DD-CFG-075).
 *
 * `normalize` is pure: no clock, file, environment or host access. Inputs are
 * the sealed binding, baseline/candidate assignments, read-only context and
 * sealed capacity evidence. The validation order of DD-CFG-060.1 is fixed and
 * returns exactly one code.
 */

import type { Hash } from "../hash.js";
import type {
  AssignmentValue,
  CapacityEvidence,
  ConfigResult,
  FieldAssignment,
  NormalizationBinding,
  NormalizationOutput,
  NormalizationRequest,
  TrialFieldChange
} from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import { computeFormulaInputHash } from "./hash.js";
import { assignmentValueKey } from "./values.js";

/* ------------------------------------------------------------------ */
/* Small assignment helpers                                           */
/* ------------------------------------------------------------------ */

function findAssignment(values: readonly FieldAssignment[], fieldId: string): FieldAssignment | null {
  return values.find((value) => value.field_id === fieldId) ?? null;
}

function assignmentOf(values: readonly FieldAssignment[], fieldId: string): AssignmentValue {
  return findAssignment(values, fieldId)?.value ?? { presence: "absent" };
}

function assignmentOfAny(
  candidate: readonly FieldAssignment[],
  baseline: readonly FieldAssignment[],
  fieldId: string
): AssignmentValue {
  const fromCandidate = findAssignment(candidate, fieldId);
  if (fromCandidate !== null) {
    return fromCandidate.value;
  }
  return assignmentOf(baseline, fieldId);
}

function numberValue(value: AssignmentValue): number | null {
  if (value.presence === "absent" || typeof value.value !== "number" || !Number.isFinite(value.value)) {
    return null;
  }
  return value.value;
}

function stringValue(value: AssignmentValue): string | null {
  if (value.presence === "absent" || typeof value.value !== "string") {
    return null;
  }
  return value.value;
}

function booleanValue(value: AssignmentValue): boolean | null {
  if (value.presence === "absent" || typeof value.value !== "boolean") {
    return null;
  }
  return value.value;
}

function fieldKeyOf(input: NormalizationRequest, fieldId: string): string {
  return input.field_keys.get(fieldId) ?? fieldId;
}

function changeOf(input: NormalizationRequest, fieldId: string): TrialFieldChange {
  return {
    field_id: fieldId as TrialFieldChange["field_id"],
    field_key: fieldKeyOf(input, fieldId),
    baseline: assignmentOf(input.baseline, fieldId),
    candidate: assignmentOf(input.candidate, fieldId)
  };
}

function identityChanges(input: NormalizationRequest): TrialFieldChange[] {
  const ids = new Set<string>();
  for (const value of input.baseline) {
    ids.add(value.field_id);
  }
  for (const value of input.candidate) {
    ids.add(value.field_id);
  }
  return [...ids].sort().map((fieldId) => changeOf(input, fieldId));
}

class NormalizeAbort {
  readonly error: ReturnType<typeof configError>;
  constructor(error: ReturnType<typeof configError>) {
    this.error = error;
  }
}

/* ------------------------------------------------------------------ */
/* Capacity evidence checks                                           */
/* ------------------------------------------------------------------ */

export function requiresCapacityEvidence(binding: NormalizationBinding): boolean {
  switch (binding.normalization_id) {
    case "percent_token_floor_v1":
    case "codex_compaction_limits_v1":
      return true;
    case "omp_threshold_mode_v1":
      return binding.params.mode === "tokens";
    default:
      return false;
  }
}

function checkEvidenceBinding(input: NormalizationRequest, evidence: CapacityEvidence): ConfigResult<void> {
  if (evidence.schema_version !== "rsi.capacity_evidence/1") {
    return fail(configError("E_CFG_CAPACITY_MISMATCH", { details: [{ key: "schema_version", value: evidence.schema_version }] }));
  }
  if (evidence.scope !== "window_tokens" || evidence.unit !== "tokens") {
    return fail(configError("E_CFG_CAPACITY_MISMATCH"));
  }
  if (!Number.isSafeInteger(evidence.window_tokens) || evidence.window_tokens < 1) {
    return fail(configError("E_CFG_CAPACITY_MISMATCH", { details: [{ key: "window_tokens", value: evidence.window_tokens }] }));
  }
  if (evidence.config_space_id !== input.config_space_id) {
    return fail(configError("E_CFG_CAPACITY_MISMATCH", { details: [{ key: "dimension", value: "config_space_id" }] }));
  }
  if (evidence.model_scope_key !== input.model_scope_key) {
    return fail(configError("E_CFG_CAPACITY_MISMATCH", { details: [{ key: "dimension", value: "model_scope_key" }] }));
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Formula implementations                                            */
/* ------------------------------------------------------------------ */

/** `floor(window_tokens × percent / 100)`, exact integer arithmetic. */
export function percentToTokens(windowTokens: number, percent: number): number {
  return Math.floor((windowTokens * percent) / 100);
}

function normalizePercentTokenFloor(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "percent_token_floor_v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const evidence = input.capacity_evidence;
  if (evidence === null) {
    throw new NormalizeAbort(configError("E_CFG_CAPACITY_UNVERIFIED"));
  }
  const params = binding.params;
  for (const [fieldId, source] of [
    [params.percent_field_id, input.baseline],
    [params.token_field_id, input.baseline],
    [params.percent_field_id, input.candidate],
    [params.token_field_id, input.candidate]
  ] as const) {
    if (findAssignment(source, fieldId) === null) {
      throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { field_id: fieldId }));
    }
  }
  if (params.rounding !== "floor") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const check = (percent: number | null, token: number | null, source: "baseline" | "candidate"): void => {
    if (percent === null || token === null) {
      throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "side", value: source }] }));
    }
    if (!Number.isInteger(token)) {
      throw new NormalizeAbort(configError("E_CFG_FIELD_TYPE"));
    }
    if (percent < 0 || percent > 100) {
      throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { details: [{ key: "percent", value: percent }] }));
    }
    const expected = percentToTokens(evidence.window_tokens, percent);
    if (expected !== token) {
      throw new NormalizeAbort(
        configError("E_CFG_NORMALIZATION_MISMATCH", {
          details: [
            { key: "side", value: source },
            { key: "expected", value: expected },
            { key: "actual", value: token }
          ]
        })
      );
    }
  };
  check(
    numberValue(assignmentOf(input.baseline, params.percent_field_id)),
    numberValue(assignmentOf(input.baseline, params.token_field_id)),
    "baseline"
  );
  check(
    numberValue(assignmentOf(input.candidate, params.percent_field_id)),
    numberValue(assignmentOf(input.candidate, params.token_field_id)),
    "candidate"
  );
  return {
    changes: [changeOf(input, params.percent_field_id), changeOf(input, params.token_field_id)],
    formula_input_hash: computeFormulaInputHash({
      binding,
      capacity_evidence: evidence,
      config_space_id: input.config_space_id,
      field_registry_snapshot_hash: input.field_registry_snapshot_hash,
      model_scope_key: input.model_scope_key,
      baseline: input.baseline,
      candidate: input.candidate,
      context: input.context
    }),
    shadowed_field_ids: []
  };
}

function normalizeOmpThreshold(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "omp_threshold_mode_v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const percentField = firstFieldOfKind(input, /thresholdPercent|percent/i);
  const tokenField = firstFieldOfKind(input, /thresholdTokens|token/i);
  if (percentField === null || tokenField === null) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT"));
  }
  if (binding.params.mode === "tokens") {
    const evidence = input.capacity_evidence;
    if (evidence === null) {
      throw new NormalizeAbort(configError("E_CFG_CAPACITY_UNVERIFIED"));
    }
    const tokens = numberValue(assignmentOf(input.candidate, tokenField));
    if (tokens === null || !Number.isSafeInteger(tokens) || tokens < 1) {
      throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: tokenField }));
    }
    if (tokens > evidence.window_tokens) {
      throw new NormalizeAbort(
        configError("E_CFG_NORMALIZATION_MISMATCH", {
          field_id: tokenField,
          details: [
            { key: "limit", value: tokens },
            { key: "window_tokens", value: evidence.window_tokens }
          ]
        })
      );
    }
    const percentBaseline = assignmentOf(input.baseline, percentField);
    const percentCandidate = assignmentOf(input.candidate, percentField);
    const shadowedPercent =
      percentCandidate.presence === "present" && assignmentValueKey(percentCandidate) !== assignmentValueKey(percentBaseline);
    return {
      changes: [
        {
          ...changeOf(input, percentField),
          candidate: shadowedPercent ? percentBaseline : percentCandidate
        },
        changeOf(input, tokenField)
      ],
      formula_input_hash: formulaHashFor(input, evidence),
      shadowed_field_ids: [percentField as TrialFieldChange["field_id"]]
    };
  }
  const percent = numberValue(assignmentOf(input.candidate, percentField));
  if (percent === null) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { field_id: percentField }));
  }
  return {
    changes: [
      changeOf(input, percentField),
      {
        ...changeOf(input, tokenField),
        candidate: { presence: "present", value: -1 }
      }
    ],
    formula_input_hash: formulaHashFor(input, null),
    shadowed_field_ids: []
  };
}

function firstFieldOfKind(input: NormalizationRequest, pattern: RegExp): string | null {
  const ids = new Set<string>();
  for (const value of input.baseline) {
    ids.add(value.field_id);
  }
  for (const value of input.candidate) {
    ids.add(value.field_id);
  }
  const matches: string[] = [];
  for (const fieldId of [...ids].sort()) {
    const key = input.field_keys.get(fieldId) ?? "";
    if (pattern.test(key)) {
      matches.push(fieldId);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function formulaHashFor(input: NormalizationRequest, evidence: CapacityEvidence | null): Hash {
  return computeFormulaInputHash({
    binding: input.binding,
    capacity_evidence: evidence,
    config_space_id: input.config_space_id,
    field_registry_snapshot_hash: input.field_registry_snapshot_hash,
    model_scope_key: input.model_scope_key,
    baseline: input.baseline,
    candidate: input.candidate,
    context: input.context
  });
}

function normalizeStepProjection(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "step_clm_projection_v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const params = binding.params;
  const projection = stringValue(
    assignmentOfAny(input.candidate, input.baseline, params.projection_field_id)
  );
  const compactionEnabled = booleanValue(
    assignmentOfAny(input.candidate, input.baseline, params.compaction_field_id)
  );
  const effectiveProjection = projection ?? (compactionEnabled === true ? "clm-v1" : compactionEnabled === false ? "off" : null);
  const ratio = numberValue(assignmentOf(input.candidate, params.ratio_field_id));
  if (ratio !== null && (ratio < 0.3 || ratio > 0.85)) {
    throw new NormalizeAbort(
      configError("E_CFG_FIELD_RANGE", {
        field_id: params.ratio_field_id,
        details: [
          { key: "min", value: 0.3 },
          { key: "max", value: 0.85 }
        ]
      })
    );
  }
  if (assignmentOf(input.candidate, params.ratio_field_id).presence === "present" && effectiveProjection !== "clm-v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_SHADOWED", { field_id: params.ratio_field_id }));
  }
  return {
    changes: [changeOf(input, params.projection_field_id), changeOf(input, params.ratio_field_id)],
    formula_input_hash: formulaHashFor(input, null),
    shadowed_field_ids: []
  };
}

function normalizeCodexLimits(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "codex_compaction_limits_v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const evidence = input.capacity_evidence;
  if (evidence === null) {
    throw new NormalizeAbort(configError("E_CFG_CAPACITY_UNVERIFIED"));
  }
  const params = binding.params;
  const window = numberValue(assignmentOfAny(input.candidate, input.baseline, params.window_field_id));
  const limit = numberValue(assignmentOfAny(input.candidate, input.baseline, params.limit_field_id));
  const scope = stringValue(assignmentOfAny(input.candidate, input.baseline, params.scope_field_id));
  if (window === null || limit === null) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT"));
  }
  if (!Number.isSafeInteger(window) || window <= 0) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.window_field_id }));
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.limit_field_id }));
  }
  if (limit > window || limit > evidence.window_tokens) {
    throw new NormalizeAbort(
      configError("E_CFG_NORMALIZATION_MISMATCH", {
        field_id: params.limit_field_id,
        details: [
          { key: "limit", value: limit },
          { key: "window", value: window },
          { key: "window_tokens", value: evidence.window_tokens }
        ]
      })
    );
  }
  if (scope !== null && scope !== "total" && scope !== "body_after_prefix") {
    throw new NormalizeAbort(configError("E_CFG_FIELD_TYPE", { field_id: params.scope_field_id }));
  }
  if (scope === "body_after_prefix") {
    // The prefix size is unknown, so percent↔token conversion is forbidden
    // even when every other capacity check passes (DD-CFG-065).
    throw new NormalizeAbort(
      configError("E_CFG_NORMALIZATION_INPUT", {
        field_id: params.scope_field_id,
        details: [{ key: "scope", value: "body_after_prefix" }]
      })
    );
  }
  const postTurn = requireContextNumber(input, params.post_turn_percent_field_id);
  if (!Number.isSafeInteger(postTurn) || postTurn < 0 || postTurn > 100) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.post_turn_percent_field_id }));
  }
  const asyncEnabled = requireContextBoolean(input, params.async_enabled_field_id);
  const asyncThreshold = requireContextNumber(input, params.async_threshold_field_id);
  if (!Number.isSafeInteger(asyncThreshold) || asyncThreshold < 1 || asyncThreshold > 100) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.async_threshold_field_id }));
  }
  if (!asyncEnabled && assignmentOf(input.candidate, params.async_threshold_field_id).presence === "present") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_SHADOWED", { field_id: params.async_threshold_field_id }));
  }
  return {
    changes: [
      changeOf(input, params.window_field_id),
      changeOf(input, params.limit_field_id),
      changeOf(input, params.scope_field_id)
    ],
    formula_input_hash: formulaHashFor(input, evidence),
    shadowed_field_ids: []
  };
}

function contextAssignment(input: NormalizationRequest, fieldId: string): AssignmentValue {
  return assignmentOf(input.context, fieldId);
}

function requireContextNumber(input: NormalizationRequest, fieldId: string): number {
  const value = numberValue(contextAssignment(input, fieldId));
  if (value === null) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { field_id: fieldId }));
  }
  return value;
}

function requireContextBoolean(input: NormalizationRequest, fieldId: string): boolean {
  const value = booleanValue(contextAssignment(input, fieldId));
  if (value === null) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { field_id: fieldId }));
  }
  return value;
}

function normalizeClaudeWindow(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "claude_autocompact_window_v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const params = binding.params;
  const modelAssignment =
    findAssignment(input.candidate, params.model_field_id) ??
    findAssignment(input.baseline, params.model_field_id);
  const model = stringValue(
    modelAssignment === null ? contextAssignment(input, params.model_field_id) : modelAssignment.value
  );
  if (model === null) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { field_id: params.model_field_id }));
  }
  const perModel = assignmentOfAny(input.candidate, input.baseline, params.model_scoped_field_id);
  const perModelExists = perModel.presence === "present";
  const active =
    assignmentOf(input.candidate, params.model_scoped_field_id).presence === "present"
      ? assignmentOf(input.candidate, params.model_scoped_field_id)
      : assignmentOf(input.candidate, params.top_level_field_id);
  if (active.presence === "absent") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "factor", value: "no_window_location" }] }));
  }
  if (active.value !== "auto") {
    if (typeof active.value !== "number" || !Number.isSafeInteger(active.value)) {
      throw new NormalizeAbort(configError("E_CFG_FIELD_TYPE"));
    }
    if (active.value < 100000 || active.value > 1000000) {
      throw new NormalizeAbort(
        configError("E_CFG_FIELD_RANGE", {
          details: [
            { key: "min", value: 100000 },
            { key: "max", value: 1000000 }
          ]
        })
      );
    }
  }
  if (assignmentOf(input.candidate, params.top_level_field_id).presence === "present" && perModelExists) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_SHADOWED", { field_id: params.top_level_field_id }));
  }
  if (active.value === "auto") {
    // No pinned model catalog is part of the sealed input; "auto" stays unverified.
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_UNVERIFIED", { field_id: params.model_scoped_field_id }));
  }
  return {
    changes: [changeOf(input, params.top_level_field_id), changeOf(input, params.model_scoped_field_id)],
    formula_input_hash: formulaHashFor(input, null),
    shadowed_field_ids: []
  };
}

function normalizePiOverrideGuard(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "pi_model_override_guard") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const params = binding.params;
  const override = input.context.find((value) => value.field_id === params.override_key);
  if (override !== undefined && override.value.presence === "present") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_SHADOWED", { field_id: params.global_field_id }));
  }
  return {
    changes: [changeOf(input, params.global_field_id)],
    formula_input_hash: formulaHashFor(input, null),
    shadowed_field_ids: []
  };
}

function normalizeOpencodeKeep(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "opencode_keep_tokens_v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const params = binding.params;
  const keep = numberValue(assignmentOf(input.candidate, params.keep_field_id));
  const buffer = numberValue(assignmentOf(input.candidate, params.buffer_field_id));
  if (keep !== null && (!Number.isSafeInteger(keep) || keep < 0)) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.keep_field_id }));
  }
  if (buffer !== null && (!Number.isSafeInteger(buffer) || buffer < 0)) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.buffer_field_id }));
  }
  const auto = booleanValue(assignmentOfAny(input.candidate, input.baseline, params.auto_field_id));
  const factorHasKeepOrBuffer =
    assignmentOf(input.candidate, params.keep_field_id).presence === "present" ||
    assignmentOf(input.candidate, params.buffer_field_id).presence === "present";
  if (auto === false && factorHasKeepOrBuffer) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_SHADOWED", { field_id: params.keep_field_id }));
  }
  // Without an explicit buffer the plan relies on the unverified 15%/16k
  // reserve fallback; refuse instead of guessing a default (DD-CFG-068).
  const bufferPresent =
    assignmentOfAny(input.candidate, input.baseline, params.buffer_field_id).presence === "present";
  if (!bufferPresent) {
    throw new NormalizeAbort(
      configError("E_CFG_NORMALIZATION_UNVERIFIED", { field_id: params.buffer_field_id })
    );
  }
  return {
    changes: [
      changeOf(input, params.auto_field_id),
      changeOf(input, params.keep_field_id),
      changeOf(input, params.buffer_field_id)
    ],
    formula_input_hash: formulaHashFor(input, null),
    shadowed_field_ids: []
  };
}

function normalizeOpenhandsCondenser(input: NormalizationRequest): NormalizationOutput {
  const binding = input.binding;
  if (binding.normalization_id !== "openhands_condenser_v1") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  if (input.construction_path === null) {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "construction_path", value: "missing" }] }));
  }
  if (input.construction_path === "direct_agent") {
    throw new NormalizeAbort(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "construction_path", value: "direct_agent" }] }));
  }
  const params = binding.params;
  const maxSize = numberValue(assignmentOf(input.candidate, params.max_size_field_id));
  const keepFirst = numberValue(assignmentOf(input.candidate, params.keep_first_field_id));
  const maxTokens = numberValue(assignmentOf(input.candidate, params.max_tokens_field_id));
  if (maxSize !== null && (!Number.isSafeInteger(maxSize) || maxSize <= 0)) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.max_size_field_id }));
  }
  if (keepFirst !== null && (!Number.isSafeInteger(keepFirst) || keepFirst < 0)) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.keep_first_field_id }));
  }
  if (maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
    throw new NormalizeAbort(configError("E_CFG_FIELD_RANGE", { field_id: params.max_tokens_field_id }));
  }
  return {
    changes: [
      changeOf(input, params.max_size_field_id),
      changeOf(input, params.keep_first_field_id),
      changeOf(input, params.max_tokens_field_id)
    ],
    formula_input_hash: formulaHashFor(input, null),
    shadowed_field_ids: []
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

const NORMALIZER_IDS: ReadonlySet<string> = new Set([
  "identity",
  "percent_token_floor_v1",
  "omp_threshold_mode_v1",
  "step_clm_projection_v1",
  "codex_compaction_limits_v1",
  "claude_autocompact_window_v1",
  "pi_model_override_guard",
  "opencode_keep_tokens_v1",
  "openhands_condenser_v1"
]);

/**
 * Versions each normalizer can interpret. An upgraded plan keeps its frozen
 * version and is never recomputed by a newer function (DD-CFG-071).
 */
const NORMALIZATION_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  identity: ["1"],
  percent_token_floor_v1: ["1"],
  omp_threshold_mode_v1: ["1"],
  step_clm_projection_v1: ["1"],
  codex_compaction_limits_v1: ["1"],
  claude_autocompact_window_v1: ["1"],
  pi_model_override_guard: ["1"],
  opencode_keep_tokens_v1: ["1", "2"],
  openhands_condenser_v1: ["1"]
};

/** Exact sealed parameter keys per normalizer (DD-CFG-060). */
const NORMALIZATION_PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  identity: [],
  percent_token_floor_v1: ["percent_field_id", "token_field_id", "rounding"],
  omp_threshold_mode_v1: ["mode"],
  step_clm_projection_v1: ["projection_field_id", "compaction_field_id", "ratio_field_id"],
  codex_compaction_limits_v1: [
    "window_field_id",
    "limit_field_id",
    "scope_field_id",
    "post_turn_percent_field_id",
    "async_enabled_field_id",
    "async_threshold_field_id"
  ],
  claude_autocompact_window_v1: ["top_level_field_id", "model_field_id", "model_scoped_field_id"],
  pi_model_override_guard: ["global_field_id", "override_key"],
  opencode_keep_tokens_v1: ["auto_field_id", "keep_field_id", "buffer_field_id"],
  openhands_condenser_v1: ["max_size_field_id", "keep_first_field_id", "max_tokens_field_id"]
};

/**
 * `window_tokens` is not part of any sealed binding. A pure normalizer ignores
 * a caller-supplied value because it always reads the sealed evidence, but a
 * value that widens the sealed window is rejected rather than silently
 * dropped (DD-CFG-060, DD-CFG-072).
 */
function checkBindingParams(input: NormalizationRequest): ConfigResult<void> {
  const binding = input.binding;
  const expected = NORMALIZATION_PARAM_KEYS[binding.normalization_id] ?? [];
  if (binding.normalization_id === "identity") {
    if ("params" in binding && binding.params !== undefined) {
      return fail(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "param", value: "params" }] }));
    }
    return succeed(undefined);
  }
  if (!("params" in binding) || binding.params === null || typeof binding.params !== "object") {
    return fail(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "param", value: "params" }] }));
  }
  const params: Record<string, unknown> = { ...binding.params };
  for (const key of Object.keys(params)) {
    if (expected.includes(key)) {
      continue;
    }
    if (key === "window_tokens") {
      const claimed = params[key];
      const evidence = input.capacity_evidence;
      if (
        evidence !== null &&
        typeof claimed === "number" &&
        Number.isFinite(claimed) &&
        claimed > evidence.window_tokens
      ) {
        return fail(
          configError("E_CFG_CAPACITY_MISMATCH", {
            details: [{ key: "dimension", value: "window_tokens" }]
          })
        );
      }
      continue;
    }
    return fail(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "param", value: key }] }));
  }
  for (const key of expected) {
    if (!(key in params)) {
      return fail(configError("E_CFG_NORMALIZATION_INPUT", { details: [{ key: "param", value: key }] }));
    }
  }
  return succeed(undefined);
}

export function normalize(input: NormalizationRequest): ConfigResult<NormalizationOutput> {
  const binding = input.binding;
  // Step 1: binding presence, registration and version.
  if (binding === null || binding === undefined) {
    return fail(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  if (!NORMALIZER_IDS.has(binding.normalization_id)) {
    return fail(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  const versions = NORMALIZATION_VERSIONS[binding.normalization_id] ?? [];
  if (!versions.includes(binding.normalization_version)) {
    return fail(configError("E_CFG_NORMALIZATION_MISSING"));
  }
  // Step 2/3: capacity-evidence coupling.
  if (requiresCapacityEvidence(binding)) {
    if (input.capacity_evidence === null) {
      return fail(configError("E_CFG_CAPACITY_UNVERIFIED"));
    }
    const evidenceCheck = checkEvidenceBinding(input, input.capacity_evidence);
    if (!evidenceCheck.ok) {
      return fail(evidenceCheck.error);
    }
  } else if (input.capacity_evidence !== null) {
    return fail(configError("E_CFG_CAPACITY_MISMATCH"));
  }
  // Step 4: sealed parameter shape.
  const paramsCheck = checkBindingParams(input);
  if (!paramsCheck.ok) {
    return fail(paramsCheck.error);
  }
  try {
    switch (binding.normalization_id) {
      case "identity":
        return succeed({
          changes: identityChanges(input),
          formula_input_hash: formulaHashFor(input, null),
          shadowed_field_ids: []
        });
      case "percent_token_floor_v1":
        return succeed(normalizePercentTokenFloor(input));
      case "omp_threshold_mode_v1":
        return succeed(normalizeOmpThreshold(input));
      case "step_clm_projection_v1":
        return succeed(normalizeStepProjection(input));
      case "codex_compaction_limits_v1":
        return succeed(normalizeCodexLimits(input));
      case "claude_autocompact_window_v1":
        return succeed(normalizeClaudeWindow(input));
      case "pi_model_override_guard":
        return succeed(normalizePiOverrideGuard(input));
      case "opencode_keep_tokens_v1":
        return succeed(normalizeOpencodeKeep(input));
      case "openhands_condenser_v1":
        return succeed(normalizeOpenhandsCondenser(input));
    }
  } catch (error) {
    if (error instanceof NormalizeAbort) {
      return fail(error.error);
    }
    throw error;
  }
}

