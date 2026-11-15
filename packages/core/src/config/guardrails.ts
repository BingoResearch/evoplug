/**
 * Guardrail profiles G1, observation windows W1/W2 and rollback profile R1
 * (DD-CFG-090 … DD-CFG-100, DD-CFG-124).
 *
 * Guardrail thresholds other than `safety_zero` are supplied by the caller;
 * the registry only fixes the five required categories, their metrics and the
 * safety instance. Missing data is `unknown`, never zero.
 */

import type { SourceRef } from "../source-ref.js";
import type {
  ConfigResult,
  GuardrailSpec,
  GuardrailValue,
  ObservationWindowSpec,
  RollbackProfile,
  TrialOutcome,
  WindowProfile
} from "./types.js";
import { configError, fail, succeed } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Fixed profiles                                                      */
/* ------------------------------------------------------------------ */

/** The only legal `safety_zero` instance (DD-CFG-090). */
export const G1_SAFETY_ZERO: GuardrailSpec = {
  guardrail_id: "safety_zero",
  metric_id: "forbidden_write_count",
  comparator: "lte",
  threshold: 0,
  unit: "count",
  min_samples: 20,
  on_breach: "rollback",
  evidence_source: "write_audit",
  oracle_id: "safety_write_audit_v1",
  sampling: { kind: "every_matched_sample", at: "sample_close", require_close_audit: true }
};

export const G1_GUARDRAIL_IDS: readonly GuardrailSpec["guardrail_id"][] = [
  "compaction_failure",
  "context_overflow",
  "cost_per_success",
  "quality_independent",
  "safety_zero"
];

const DAY_MS = 86_400_000;

export const W1_PROFILE: WindowProfile = {
  profile_id: "W1",
  min_matched_samples: 20,
  max_elapsed_ms: 7 * DAY_MS,
  close_on: "min_samples_and_deadline",
  missing_data_outcome: "inconclusive"
};

export const W2_PROFILE: WindowProfile = {
  profile_id: "W2",
  min_matched_samples: 40,
  max_elapsed_ms: 14 * DAY_MS,
  close_on: "min_samples_and_deadline",
  missing_data_outcome: "inconclusive"
};

export const R1_PROFILE: RollbackProfile = {
  profile_id: "R1",
  strategy: "restore_baseline",
  comparison: "exact",
  conflict_policy: "stop_no_overwrite",
  readback_required: true
};

export function windowProfile(profileId: "W1" | "W2"): WindowProfile {
  return profileId === "W1" ? W1_PROFILE : W2_PROFILE;
}

/** `safety_zero.min_samples` must equal the window profile (DD-CFG-090). */
export function safetyZeroFor(profileId: "W1" | "W2"): GuardrailSpec {
  return { ...G1_SAFETY_ZERO, min_samples: windowProfile(profileId).min_matched_samples };
}

/* ------------------------------------------------------------------ */
/* Guardrail validation                                                */
/* ------------------------------------------------------------------ */

const CATEGORY_METRICS: Readonly<Record<string, readonly string[]>> = {
  compaction_failure: ["compaction_failure_count"],
  context_overflow: ["context_overflow_count"],
  cost_per_success: ["cost_usd_per_success", "billed_tokens_per_success"],
  quality_independent: ["acceptance_pass_rate", "task_success_rate"],
  safety_zero: ["forbidden_write_count"]
};

const CATEGORY_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  compaction_failure: ["host_events"],
  context_overflow: ["host_events"],
  cost_per_success: ["usage_meter"],
  quality_independent: ["independent_verifier"],
  safety_zero: ["write_audit"]
};

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Structural validation of G1 (DD-CFG-090.2): five categories, one each,
 * ascending by `guardrail_id`, exact `safety_zero` instance, and
 * `window_aggregate` sampling for every other guardrail.
 */
export function validateGuardrailSpecs(
  specs: readonly GuardrailSpec[],
  profileId: "W1" | "W2"
): ConfigResult<void> {
  if (specs.length !== G1_GUARDRAIL_IDS.length) {
    return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "count", value: specs.length }] }));
  }
  const ids = specs.map((spec) => spec.guardrail_id);
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== G1_GUARDRAIL_IDS[index]) {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "guardrail_id", value: ids[index] ?? "missing" }] }));
    }
  }
  for (const spec of specs) {
    const metrics = CATEGORY_METRICS[spec.guardrail_id] ?? [];
    if (!metrics.includes(spec.metric_id)) {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "metric_id", value: spec.metric_id }] }));
    }
    const evidence = CATEGORY_EVIDENCE[spec.guardrail_id] ?? [];
    if (!evidence.includes(spec.evidence_source)) {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "evidence_source", value: spec.evidence_source }] }));
    }
    if (spec.on_breach !== "rollback") {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "on_breach", value: spec.on_breach }] }));
    }
    if (typeof spec.threshold !== "number" || !Number.isFinite(spec.threshold)) {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "threshold", value: "non_finite" }] }));
    }
    if (spec.guardrail_id === "safety_zero") {
      if (!sameValue(spec, safetyZeroFor(profileId))) {
        return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "guardrail_id", value: "safety_zero" }] }));
      }
    } else if (spec.sampling.kind !== "window_aggregate") {
      return fail(configError("E_CFG_GUARDRAIL_SPEC", { details: [{ key: "sampling", value: spec.sampling.kind }] }));
    }
  }
  return succeed(undefined);
}

/** Observation window must equal its profile exactly (DD-CFG-112). */
export function validateObservationWindow(spec: ObservationWindowSpec): ConfigResult<void> {
  const profile = windowProfile(spec.profile_id);
  if (
    spec.min_matched_samples !== profile.min_matched_samples ||
    spec.max_elapsed_ms !== profile.max_elapsed_ms ||
    spec.match_predicate_id.length === 0
  ) {
    return fail(
      configError("E_CFG_GUARDRAIL_SPEC", {
        details: [
          { key: "profile_id", value: spec.profile_id },
          { key: "min_matched_samples", value: spec.min_matched_samples },
          { key: "max_elapsed_ms", value: spec.max_elapsed_ms }
        ]
      })
    );
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Guardrail evaluation                                                */
/* ------------------------------------------------------------------ */

function compare(value: number, comparator: GuardrailSpec["comparator"], threshold: number): boolean {
  switch (comparator) {
    case "lte":
      return value <= threshold;
    case "gte":
      return value >= threshold;
    case "eq":
      return value === threshold;
  }
}

/**
 * Evaluates one guardrail. `null` metric data or too few samples is
 * `unknown`, which never closes a window as success (DD-CFG-091).
 */
export function evaluateGuardrail(
  spec: GuardrailSpec,
  metricValue: number | null,
  sampleCount: number,
  evidenceRef: SourceRef | null,
  telemetryComplete = true
): GuardrailValue {
  if (metricValue === null || !telemetryComplete || sampleCount < spec.min_samples) {
    return {
      guardrail_id: spec.guardrail_id,
      metric_id: spec.metric_id,
      value: null,
      status: "unknown",
      sample_count: sampleCount,
      evidence_ref: evidenceRef
    };
  }
  return {
    guardrail_id: spec.guardrail_id,
    metric_id: spec.metric_id,
    value: metricValue,
    status: compare(metricValue, spec.comparator, spec.threshold) ? "ok" : "breached",
    sample_count: sampleCount,
    evidence_ref: evidenceRef
  };
}

/** Any `breached` value stops the window and starts rollback (DD-CFG-090.3). */
export function hasBreach(values: readonly GuardrailValue[]): boolean {
  return values.some((value) => value.status === "breached");
}

/* ------------------------------------------------------------------ */
/* Outcome derivation                                                  */
/* ------------------------------------------------------------------ */

export interface OutcomeFacts {
  rollback_confirmed: boolean;
  guardrail_breached: boolean;
  causal_complete: boolean;
  causal_supported: boolean | null;
  evidence_level: "none" | "written_unverified" | "applied" | "effective" | "causal";
  matched_samples: number;
  min_matched_samples: number;
  trigger_samples: number;
  telemetry_complete: boolean;
  trigger_data_present: boolean;
  operation_failed: boolean;
  has_valid_result: boolean;
}

const LEVEL_ORDER: readonly string[] = ["none", "written_unverified", "applied", "effective", "causal"];

export function evidenceLevelRank(level: OutcomeFacts["evidence_level"]): number {
  return LEVEL_ORDER.indexOf(level);
}

/**
 * Window-close outcome priority (DD-CFG-124). `aborted` is decided by the
 * abort path, not here.
 */
export function deriveWindowOutcome(facts: OutcomeFacts): TrialOutcome {
  if (facts.rollback_confirmed) {
    return "rolled_back";
  }
  if (facts.guardrail_breached) {
    return facts.rollback_confirmed ? "rolled_back" : "inconclusive";
  }
  if (facts.causal_complete) {
    return facts.causal_supported === true ? "effect_supported" : "effect_rejected";
  }
  const appliedOrHigher = evidenceLevelRank(facts.evidence_level) >= evidenceLevelRank("applied");
  const telemetryComplete = facts.telemetry_complete && facts.trigger_data_present;
  if (
    appliedOrHigher &&
    facts.matched_samples >= facts.min_matched_samples &&
    facts.trigger_samples === 0 &&
    telemetryComplete
  ) {
    return "not_exercised";
  }
  if (!telemetryComplete || facts.guardrail_breached) {
    return "inconclusive";
  }
  if (facts.operation_failed && !facts.has_valid_result) {
    return "failed";
  }
  return "inconclusive";
}

/** `not_exercised` requires level ≥ applied and complete telemetry (DD-CFG-093). */
export function canBeNotExercised(facts: OutcomeFacts): boolean {
  return (
    evidenceLevelRank(facts.evidence_level) >= evidenceLevelRank("applied") &&
    facts.matched_samples >= facts.min_matched_samples &&
    facts.trigger_samples === 0 &&
    facts.telemetry_complete &&
    facts.trigger_data_present
  );
}

/** Window open/close instants; `window_opened_at` is frozen on entering observing. */
export function computeWindowClosesAt(windowOpenedAt: number, profileId: "W1" | "W2"): number {
  return windowOpenedAt + windowProfile(profileId).max_elapsed_ms;
}

/** Window close when minimum samples and deadline are both reached, or causal end. */
export function windowShouldClose(input: {
  matched_samples: number;
  min_matched_samples: number;
  observed_at: number;
  window_closes_at: number;
  causal_protocol_end: boolean;
}): boolean {
  if (input.causal_protocol_end) {
    return true;
  }
  return input.matched_samples >= input.min_matched_samples && input.observed_at >= input.window_closes_at;
}
