/**
 * TriggerPolicy construction, validation, scope resolution and safe defaults
 * (DD-TRG-002).
 *
 * Validation returns the exact documented `E_POLICY_*` codes. These codes are
 * HOST-local and never enter the FND error registry.
 */

import type { Id } from "../../ids.js";
import { makeErrorEnvelope, type ErrorCode, type ErrorEnvelope } from "../../errors.js";
import { err, ok, type Result } from "../../result.js";
import type {
  CapabilityGatePolicy,
  ConfigSpace,
  HostId,
  HostMode,
  OnlinePolicy,
  OriginPolicy,
  PolicyBudgetRef,
  PolicyScope,
  ProgressPolicy,
  ReviewPolicy,
  SignalType,
  TriggerPolicy
} from "../types.js";
import { policyScopeKey, triggerPolicyHash } from "../keys.js";
import { isConfigSpaceToken, isRecord, isSafeNonNegativeInt } from "../validation.js";

const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const VERIFIED_SIGNALS: readonly SignalType[] = ["repeated_correction", "reproducible_error", "stable_recovery"];

const ALL_SIGNALS: readonly SignalType[] = [
  "repeated_correction",
  "reproducible_error",
  "stable_recovery",
  "completion_claim",
  "user_request"
];

const SCOPE_KINDS: readonly PolicyScope["scope_kind"][] = [
  "global",
  "host",
  "host_mode",
  "project",
  "project_host",
  "project_host_mode"
];

const TASK_STATES: readonly string[] = [
  "advancing",
  "information_gain",
  "stalled_candidate",
  "regressing",
  "baseline",
  "waiting",
  "blocked",
  "paused",
  "cancelled",
  "collection_gap",
  "unknown"
];

const INCLUSION_LEVELS: readonly string[] = [
  "none",
  "constructive",
  "context_projection",
  "provider_payload",
  "transport_body",
  "unknown"
];

interface PolicyValidationOptions {
  /** Resolves the referenced budget policy; omit to validate shape only. */
  budgetPolicyExists?: (budgetPolicyRef: string) => boolean;
}

function policyError(code: ErrorCode, path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: "policy",
    message_key: `error.${code.toLowerCase()}`,
    stage: "trigger_policy_validate",
    details: { kind: "field", path, rule }
  });
}

/** Validates a complete `rsi.trigger_policy/1` object. */
export function validateTriggerPolicy(
  value: unknown,
  options: PolicyValidationOptions = {}
): Result<TriggerPolicy, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "$", "object"));
  }
  const allowed = new Set([
    "schema_version",
    "policy_id",
    "policy_version",
    "policy_hash",
    "lifecycle",
    "scope",
    "online",
    "progress",
    "review",
    "origin",
    "capabilities",
    "budget",
    "created_at",
    "updated_at"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return err(policyError("E_POLICY_SCOPE_INVALID", key, "known_field"));
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return err(policyError("E_POLICY_SCOPE_INVALID", key, "required"));
    }
  }
  if (value["schema_version"] !== "rsi.trigger_policy/1") {
    return err(policyError("E_POLICY_SCOPE_INVALID", "schema_version", "rsi.trigger_policy/1"));
  }
  if (value["lifecycle"] !== "active" && value["lifecycle"] !== "superseded") {
    return err(policyError("E_POLICY_LIFECYCLE", "lifecycle", "active_or_superseded"));
  }
  if (typeof value["policy_version"] !== "string" || !SEMVER_PATTERN.test(value["policy_version"])) {
    return err(policyError("E_POLICY_VERSION_CONFLICT", "policy_version", "semver"));
  }
  if (typeof value["policy_id"] !== "string" || !value["policy_id"].startsWith("pol:")) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "policy_id", "pol_id"));
  }
  if (typeof value["policy_hash"] !== "string" || !value["policy_hash"].startsWith("sha256:")) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "policy_hash", "sha256_hash"));
  }
  if (!isSafeNonNegativeInt(value["created_at"]) || !isSafeNonNegativeInt(value["updated_at"])) {
    return err(policyError("E_POLICY_RANGE", "created_at", "non_negative_safe_integer"));
  }

  const scope = validateScope(value["scope"]);
  if (!scope.ok) {
    return scope;
  }
  const online = validateOnline(value["online"]);
  if (!online.ok) {
    return online;
  }
  const progress = validateProgress(value["progress"]);
  if (!progress.ok) {
    return progress;
  }
  const review = validateReview(value["review"]);
  if (!review.ok) {
    return review;
  }
  const origin = validateOrigin(value["origin"]);
  if (!origin.ok) {
    return origin;
  }
  const capabilities = validateCapabilityGate(value["capabilities"]);
  if (!capabilities.ok) {
    return capabilities;
  }
  const budget = validateBudget(value["budget"], options);
  if (!budget.ok) {
    return budget;
  }

  return ok({
    schema_version: "rsi.trigger_policy/1",
    policy_id: value["policy_id"] as Id<"pol">,
    policy_version: value["policy_version"],
    policy_hash: value["policy_hash"] as TriggerPolicy["policy_hash"],
    lifecycle: value["lifecycle"],
    scope: scope.value,
    online: online.value,
    progress: progress.value,
    review: review.value,
    origin: origin.value,
    capabilities: capabilities.value,
    budget: budget.value,
    created_at: value["created_at"],
    updated_at: value["updated_at"]
  });
}

function validateScope(value: unknown): Result<PolicyScope, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope", "object"));
  }
  const allowed = new Set(["scope_kind", "host_id", "mode", "config_space", "project_id"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return err(policyError("E_POLICY_SCOPE_INVALID", `scope.${key}`, "known_field"));
    }
  }
  const scopeKind = value["scope_kind"];
  if (typeof scopeKind !== "string" || !(SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope.scope_kind", "closed_set"));
  }
  const hostId = value["host_id"];
  const mode = value["mode"];
  const configSpace = value["config_space"];
  const projectId = value["project_id"];
  if (hostId !== undefined && typeof hostId !== "string") {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope.host_id", "string"));
  }
  if (mode !== undefined && typeof mode !== "string") {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope.mode", "string"));
  }
  if (configSpace !== undefined && (typeof configSpace !== "string" || !isConfigSpaceToken(configSpace))) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope.config_space", "config_space_token"));
  }
  if (projectId !== undefined && (typeof projectId !== "string" || projectId.length === 0)) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope.project_id", "non_empty_string"));
  }
  const needsHost =
    scopeKind === "host" || scopeKind === "host_mode" || scopeKind === "project_host" || scopeKind === "project_host_mode";
  if (needsHost && hostId === undefined) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope.host_id", "required_for_scope_kind"));
  }
  if (scopeKind === "host_mode" || scopeKind === "project_host_mode") {
    if (mode === undefined || configSpace === undefined) {
      return err(policyError("E_POLICY_SCOPE_INVALID", "scope.mode", "mode_and_config_space_required"));
    }
  }
  const needsProject = scopeKind === "project" || scopeKind === "project_host" || scopeKind === "project_host_mode";
  if (needsProject && projectId === undefined) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope.project_id", "required_for_scope_kind"));
  }
  if (scopeKind === "global" && (hostId !== undefined || mode !== undefined || configSpace !== undefined || projectId !== undefined)) {
    return err(policyError("E_POLICY_SCOPE_INVALID", "scope", "global_has_no_coordinates"));
  }
  const scope: PolicyScope = { scope_kind: scopeKind as PolicyScope["scope_kind"] };
  if (hostId !== undefined) {
    scope.host_id = hostId as HostId;
  }
  if (mode !== undefined) {
    scope.mode = mode as HostMode;
  }
  if (configSpace !== undefined) {
    scope.config_space = configSpace as ConfigSpace;
  }
  if (projectId !== undefined) {
    scope.project_id = projectId;
  }
  return ok(scope);
}

function validateOnline(value: unknown): Result<OnlinePolicy, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_RANGE", "online", "object"));
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["online.enabled", value["enabled"], true],
    ["online.on_input", value["on_input"], true],
    ["online.on_tool_event", value["on_tool_event"], "update_only"],
    ["online.on_compaction", value["on_compaction"], "refresh_refs"],
    ["online.remote_semantics", value["remote_semantics"], "shadow"],
    ["online.local_fact_priority", value["local_fact_priority"], "always_sync"]
  ];
  for (const [path, actual, expected] of checks) {
    if (actual !== expected) {
      return err(policyError("E_POLICY_RANGE", path, String(expected)));
    }
  }
  const minInterval = value["min_interval_ms"];
  if (!isSafeNonNegativeInt(minInterval) || minInterval > 60_000) {
    return err(policyError("E_POLICY_RANGE", "online.min_interval_ms", "0..60000"));
  }
  for (const field of [
    "max_remote_checks_per_input",
    "max_remote_checks_per_minute",
    "semantic_merge_window_ms"
  ]) {
    if (!isSafeNonNegativeInt(value[field])) {
      return err(policyError("E_POLICY_RANGE", `online.${field}`, "non_negative_safe_integer"));
    }
  }
  const inclusion = value["delivery_min_inclusion"];
  if (typeof inclusion !== "string" || !INCLUSION_LEVELS.includes(inclusion)) {
    return err(policyError("E_POLICY_RANGE", "online.delivery_min_inclusion", "inclusion_level"));
  }
  return ok({
    enabled: true,
    on_input: true,
    on_tool_event: "update_only",
    on_compaction: "refresh_refs",
    remote_semantics: "shadow",
    min_interval_ms: minInterval,
    max_remote_checks_per_input: value["max_remote_checks_per_input"] as number,
    max_remote_checks_per_minute: value["max_remote_checks_per_minute"] as number,
    semantic_merge_window_ms: value["semantic_merge_window_ms"] as number,
    local_fact_priority: "always_sync",
    delivery_min_inclusion: inclusion as OnlinePolicy["delivery_min_inclusion"]
  });
}

function validateProgress(value: unknown): Result<ProgressPolicy, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_RANGE", "progress", "object"));
  }
  if (value["enabled"] !== true || value["on_input_boundary"] !== true || value["on_stable_boundary"] !== true) {
    return err(policyError("E_POLICY_RANGE", "progress", "enabled_boundaries_true"));
  }
  if (value["min_checks"] !== 2) {
    return err(policyError("E_POLICY_RANGE", "progress.min_checks", "2"));
  }
  const minSpan = value["min_span_ms"];
  const windowMs = value["window_ms"];
  if (!isSafeNonNegativeInt(minSpan) || minSpan < 1_000 || minSpan > 3_600_000) {
    return err(policyError("E_POLICY_RANGE", "progress.min_span_ms", "1000..3600000"));
  }
  if (!isSafeNonNegativeInt(windowMs) || windowMs < minSpan || windowMs > 3_600_000) {
    return err(policyError("E_POLICY_RANGE", "progress.window_ms", "min_span..3600000"));
  }
  if (!isSafeNonNegativeInt(value["max_checks_per_window"])) {
    return err(policyError("E_POLICY_RANGE", "progress.max_checks_per_window", "non_negative_safe_integer"));
  }
  const excluded = value["excluded_task_states"];
  if (!Array.isArray(excluded) || !excluded.every((entry) => typeof entry === "string" && TASK_STATES.includes(entry))) {
    return err(policyError("E_POLICY_RANGE", "progress.excluded_task_states", "task_process_state[]"));
  }
  if (typeof value["stall_opens_issue"] !== "boolean") {
    return err(policyError("E_POLICY_RANGE", "progress.stall_opens_issue", "boolean"));
  }
  if (value["step_effect_mode"] !== "shadow") {
    return err(policyError("E_POLICY_RANGE", "progress.step_effect_mode", "shadow"));
  }
  const semantic = value["semantic_compare"];
  if (semantic !== "disabled" && semantic !== "shadow") {
    return err(policyError("E_POLICY_RANGE", "progress.semantic_compare", "disabled_or_shadow"));
  }
  return ok({
    enabled: true,
    on_input_boundary: true,
    on_stable_boundary: true,
    min_checks: 2,
    min_span_ms: minSpan,
    window_ms: windowMs,
    max_checks_per_window: value["max_checks_per_window"] as number,
    excluded_task_states: excluded as ProgressPolicy["excluded_task_states"],
    stall_opens_issue: value["stall_opens_issue"],
    step_effect_mode: "shadow",
    semantic_compare: semantic
  });
}

function validateReview(value: unknown): Result<ReviewPolicy, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review", "object"));
  }
  if (value["mode"] !== "signal_gated") {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review.mode", "signal_gated"));
  }
  const auto = value["auto"];
  if (!isRecord(auto)) {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review.auto", "object"));
  }
  if (typeof auto["enabled"] !== "boolean" || auto["require_stable_boundary"] !== true || auto["signal_match"] !== "any") {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review.auto", "enabled_stable_any"));
  }
  const minSignals = auto["min_signals"];
  if (!Array.isArray(minSignals) || minSignals.length === 0) {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review.auto.min_signals", "non_empty"));
  }
  const seen = new Set<string>();
  for (const signal of minSignals) {
    if (typeof signal !== "string" || !(ALL_SIGNALS as readonly string[]).includes(signal)) {
      return err(policyError("E_POLICY_SIGNAL_GATE", "review.auto.min_signals", "signal_type"));
    }
    if (!(VERIFIED_SIGNALS as readonly string[]).includes(signal)) {
      return err(policyError("E_POLICY_SIGNAL_GATE", "review.auto.min_signals", "verified_signal_only"));
    }
    if (seen.has(signal)) {
      return err(policyError("E_POLICY_SIGNAL_GATE", "review.auto.min_signals", "unique"));
    }
    seen.add(signal);
  }
  for (const field of ["max_open_jobs_per_task", "max_auto_jobs_per_task_24h"]) {
    if (!isSafeNonNegativeInt(auto[field])) {
      return err(policyError("E_POLICY_RANGE", `review.auto.${field}`, "non_negative_safe_integer"));
    }
  }
  const explicit = value["explicit"];
  if (!isRecord(explicit)) {
    return err(policyError("E_POLICY_RANGE", "review.explicit", "object"));
  }
  if (
    explicit["enabled"] !== true ||
    explicit["allowed_when_auto_disabled"] !== true ||
    explicit["unstable_snapshot"] !== "stage_with_gaps" ||
    explicit["require_grant"] !== true
  ) {
    return err(policyError("E_POLICY_RANGE", "review.explicit", "explicit_contract"));
  }
  const pending = value["pending"];
  if (!isRecord(pending)) {
    return err(policyError("E_POLICY_RANGE", "review.pending", "object"));
  }
  const deferMax = pending["defer_max_ms"];
  if (!isSafeNonNegativeInt(deferMax) || deferMax < 60_000 || deferMax > 1_800_000) {
    return err(policyError("E_POLICY_RANGE", "review.pending.defer_max_ms", "60000..1800000"));
  }
  if (pending["on_timeout"] !== "expire_await_explicit" || pending["resume_on_verified_stable"] !== true) {
    return err(policyError("E_POLICY_RANGE", "review.pending", "timeout_contract"));
  }
  const signalPolicy = value["signal_policy"];
  if (!isRecord(signalPolicy)) {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review.signal_policy", "object"));
  }
  const repeated = signalPolicy["repeated_correction"];
  const reproducible = signalPolicy["reproducible_error"];
  const recovery = signalPolicy["stable_recovery"];
  if (!isRecord(repeated) || !isRecord(reproducible) || !isRecord(recovery)) {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review.signal_policy", "known_branches"));
  }
  if (
    repeated["min_distinct_events"] !== 2 ||
    !isSafeNonNegativeInt(repeated["window_ms"]) ||
    reproducible["min_independent_runs"] !== 2 ||
    reproducible["same_failure_signature"] !== true ||
    recovery["verified_failure_required"] !== true ||
    recovery["min_consecutive_passes"] !== 2 ||
    signalPolicy["completion_claim_max_strength"] !== "unverified_claim"
  ) {
    return err(policyError("E_POLICY_SIGNAL_GATE", "review.signal_policy", "fixed_thresholds"));
  }
  return ok({
    mode: "signal_gated",
    auto: {
      enabled: auto["enabled"],
      require_stable_boundary: true,
      signal_match: "any",
      min_signals: minSignals as SignalType[],
      max_open_jobs_per_task: auto["max_open_jobs_per_task"] as number,
      max_auto_jobs_per_task_24h: auto["max_auto_jobs_per_task_24h"] as number
    },
    explicit: {
      enabled: true,
      allowed_when_auto_disabled: true,
      unstable_snapshot: "stage_with_gaps",
      require_grant: true
    },
    pending: {
      defer_max_ms: deferMax,
      on_timeout: "expire_await_explicit",
      resume_on_verified_stable: true
    },
    signal_policy: {
      repeated_correction: { min_distinct_events: 2, window_ms: repeated["window_ms"] as number },
      reproducible_error: { min_independent_runs: 2, same_failure_signature: true },
      stable_recovery: { verified_failure_required: true, min_consecutive_passes: 2 },
      completion_claim_max_strength: "unverified_claim"
    }
  });
}

function validateOrigin(value: unknown): Result<OriginPolicy, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_RANGE", "origin", "object"));
  }
  if (
    value["evaluator_suppression"] !== true ||
    value["descendant_suppression"] !== true ||
    value["unknown_origin_auto_review"] !== "suppress" ||
    value["unknown_origin_online_checks"] !== "local_only" ||
    value["unknown_origin_explicit_review"] !== "grant_required" ||
    !isSafeNonNegativeInt(value["registry_ttl_ms"])
  ) {
    return err(policyError("E_POLICY_RANGE", "origin", "fixed_origin_contract"));
  }
  return ok({
    evaluator_suppression: true,
    descendant_suppression: true,
    unknown_origin_auto_review: "suppress",
    unknown_origin_online_checks: "local_only",
    unknown_origin_explicit_review: "grant_required",
    registry_ttl_ms: value["registry_ttl_ms"]
  });
}

function validateCapabilityGate(value: unknown): Result<CapabilityGatePolicy, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_CAPABILITY_GATE", "capabilities", "object"));
  }
  if (
    value["profile_version"] !== "cap-gate/1" ||
    value["subject"] !== "product_adapter" ||
    value["allow_unverified_auto_review"] !== false ||
    value["allow_unverified_online_semantics"] !== false ||
    !isSafeNonNegativeInt(value["require_probe_freshness_ms"])
  ) {
    return err(policyError("E_POLICY_CAPABILITY_GATE", "capabilities", "cap-gate/1"));
  }
  return ok({
    profile_version: "cap-gate/1",
    subject: "product_adapter",
    allow_unverified_auto_review: false,
    allow_unverified_online_semantics: false,
    require_probe_freshness_ms: value["require_probe_freshness_ms"]
  });
}

function validateBudget(value: unknown, options: PolicyValidationOptions): Result<PolicyBudgetRef, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(policyError("E_POLICY_BUDGET_MISSING", "budget", "object"));
  }
  const ref = value["budget_policy_ref"];
  if (typeof ref !== "string" || ref.length === 0) {
    return err(policyError("E_POLICY_BUDGET_MISSING", "budget.budget_policy_ref", "non_empty_string"));
  }
  if (
    value["require_budget_for_paid_request"] !== true ||
    value["require_budget_for_generation"] !== true
  ) {
    return err(policyError("E_POLICY_BUDGET_MISSING", "budget", "require_true"));
  }
  if (options.budgetPolicyExists !== undefined && !options.budgetPolicyExists(ref)) {
    return err(policyError("E_POLICY_BUDGET_MISSING", "budget.budget_policy_ref", "exists"));
  }
  return ok({
    budget_policy_ref: ref,
    require_budget_for_paid_request: true,
    require_budget_for_generation: true
  });
}

interface DefaultPolicyInput {
  policy_id: Id<"pol">;
  created_at: number;
  budget_policy_ref?: string;
}

/** Builds the documented default policy (DD-TRG-002) with a computed hash. */
export function makeDefaultTriggerPolicy(input: DefaultPolicyInput): TriggerPolicy {
  const policy: TriggerPolicy = {
    schema_version: "rsi.trigger_policy/1",
    policy_id: input.policy_id,
    policy_version: "1.0.0",
    policy_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    lifecycle: "active",
    scope: { scope_kind: "global" },
    online: {
      enabled: true,
      on_input: true,
      on_tool_event: "update_only",
      on_compaction: "refresh_refs",
      remote_semantics: "shadow",
      min_interval_ms: 1_000,
      max_remote_checks_per_input: 1,
      max_remote_checks_per_minute: 20,
      semantic_merge_window_ms: 1_000,
      local_fact_priority: "always_sync",
      delivery_min_inclusion: "provider_payload"
    },
    progress: {
      enabled: true,
      on_input_boundary: true,
      on_stable_boundary: true,
      min_checks: 2,
      min_span_ms: 60_000,
      window_ms: 900_000,
      max_checks_per_window: 4,
      excluded_task_states: ["waiting", "blocked", "paused", "cancelled", "collection_gap", "unknown"],
      stall_opens_issue: true,
      step_effect_mode: "shadow",
      semantic_compare: "disabled"
    },
    review: {
      mode: "signal_gated",
      auto: {
        enabled: true,
        require_stable_boundary: true,
        signal_match: "any",
        min_signals: ["repeated_correction", "reproducible_error", "stable_recovery"],
        max_open_jobs_per_task: 1,
        max_auto_jobs_per_task_24h: 4
      },
      explicit: {
        enabled: true,
        allowed_when_auto_disabled: true,
        unstable_snapshot: "stage_with_gaps",
        require_grant: true
      },
      pending: {
        defer_max_ms: 300_000,
        on_timeout: "expire_await_explicit",
        resume_on_verified_stable: true
      },
      signal_policy: {
        repeated_correction: { min_distinct_events: 2, window_ms: 604_800_000 },
        reproducible_error: { min_independent_runs: 2, same_failure_signature: true },
        stable_recovery: { verified_failure_required: true, min_consecutive_passes: 2 },
        completion_claim_max_strength: "unverified_claim"
      }
    },
    origin: {
      evaluator_suppression: true,
      descendant_suppression: true,
      unknown_origin_auto_review: "suppress",
      unknown_origin_online_checks: "local_only",
      unknown_origin_explicit_review: "grant_required",
      registry_ttl_ms: 604_800_000
    },
    capabilities: {
      profile_version: "cap-gate/1",
      subject: "product_adapter",
      allow_unverified_auto_review: false,
      allow_unverified_online_semantics: false,
      require_probe_freshness_ms: 86_400_000
    },
    budget: {
      budget_policy_ref: input.budget_policy_ref ?? "budget://default",
      require_budget_for_paid_request: true,
      require_budget_for_generation: true
    },
    created_at: input.created_at,
    updated_at: input.created_at
  };
  return { ...policy, policy_hash: triggerPolicyHash(policy) };
}

/** Safe-default view applied when no policy row is resolvable (DD-TRG-002). */
interface SafeDefaultPolicy {
  automatic_review: false;
  remote_semantics: false;
  generation: false;
  explicit_review: true;
  local_hard_facts: true;
  reason_code: "E_POLICY_UNAVAILABLE";
}

export function safeDefaultPolicy(): SafeDefaultPolicy {
  return {
    automatic_review: false,
    remote_semantics: false,
    generation: false,
    explicit_review: true,
    local_hard_facts: true,
    reason_code: "E_POLICY_UNAVAILABLE"
  };
}

const SCOPE_PRIORITY: readonly PolicyScope["scope_kind"][] = [
  "project_host_mode",
  "project_host",
  "project",
  "host_mode",
  "host",
  "global"
];

export interface PolicyResolveTarget {
  host_id?: HostId;
  mode?: HostMode;
  config_space?: ConfigSpace;
  project_id?: string;
}

function scopeMatches(scope: PolicyScope, target: PolicyResolveTarget): boolean {
  if (scope.host_id !== undefined && scope.host_id !== target.host_id) {
    return false;
  }
  if (scope.mode !== undefined && scope.mode !== target.mode) {
    return false;
  }
  if (scope.config_space !== undefined && scope.config_space !== target.config_space) {
    return false;
  }
  if (scope.project_id !== undefined && scope.project_id !== target.project_id) {
    return false;
  }
  return true;
}

/**
 * Resolves the single active policy for a target. Highest priority wins and
 * the whole object replaces lower scopes; fields are never merged.
 */
export function resolveTriggerPolicy(
  policies: readonly TriggerPolicy[],
  target: PolicyResolveTarget,
  options: { authorizedProjects?: ReadonlySet<string> } = {}
): Result<TriggerPolicy, ErrorEnvelope> {
  for (const kind of SCOPE_PRIORITY) {
    const candidates = policies.filter(
      (policy) =>
        policy.lifecycle === "active" &&
        policy.scope.scope_kind === kind &&
        scopeMatches(policy.scope, target) &&
        (policy.scope.project_id === undefined ||
          options.authorizedProjects === undefined ||
          options.authorizedProjects.has(policy.scope.project_id))
    );
    if (candidates.length > 1) {
      return err(policyError("E_POLICY_SCOPE_INVALID", "scope_key", "duplicate_priority"));
    }
    const candidate = candidates[0];
    if (candidate !== undefined) {
      // DD-TRG-002: a row whose stored hash no longer matches the recomputed
      // semantic hash is not usable and must not be written back.
      if (candidate.policy_hash !== triggerPolicyHash(candidate)) {
        return err(policyError("E_POLICY_UNAVAILABLE", "policy", "hash_mismatch"));
      }
      return ok(candidate);
    }
  }
  return err(policyError("E_POLICY_UNAVAILABLE", "policy", "no_active_scope"));
}

/** Returns the policy ref stored on a decision. */
export function policyRefOf(policy: TriggerPolicy): import("../types.js").TriggerPolicyRef {
  return {
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_hash: policy.policy_hash,
    scope_key: policyScopeKey(policy.scope)
  };
}
