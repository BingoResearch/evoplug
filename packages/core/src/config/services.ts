/**
 * CFG service contracts and deterministic service helpers (DD-CFG-140 …
 * DD-CFG-155).
 *
 * The async orchestration (root resolution, capability snapshots, capacity
 * evidence, safety audit and `commitLiveGated`) belongs to the composition
 * root and FND ports; this module fixes the service ABI and the pure
 * comparisons/CAS predicates those services must run inside their stages.
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { SourceRef } from "../source-ref.js";
import type { VersionBinding } from "../version-binding.js";

import type { AttemptKind, EpochMs, AttemptRef, CloseTrial, ConfigError, ConfigErrorCode, ConfigResult, ConfigSpaceSelector, ConfigSpaceSnapshot, ConfigTrial, CreateTrialPlan, ExecuteAttempt, FieldAssignment, FieldReadback, GuardrailValue, ObservationRecord, ReconcileEntry, ReconcileReport, RecordObservation, RequestRollback, StartTrial, TrialAttempt, TrialPlan, TrialPhase } from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import { computeObservationRecordHash } from "./hash.js";
import { assignmentValueKey } from "./values.js";

/* ------------------------------------------------------------------ */
/* Service ABI                                                         */
/* ------------------------------------------------------------------ */

export interface ConfigSpaceService {
  capture(selector: ConfigSpaceSelector): Promise<ConfigResult<ConfigSpaceSnapshot>>;
  readFields(input: {
    config_space_id: Hash;
    field_ids: readonly Id<"fld">[];
    layer_id: string;
  }): Promise<ConfigResult<readonly FieldReadback[]>>;
}

export interface ConfigTrialService {
  createPlan(input: CreateTrialPlan): Promise<ConfigResult<TrialPlan>>;
  startTrial(input: StartTrial): Promise<ConfigResult<ConfigTrial>>;
  executeAttempt(input: ExecuteAttempt): Promise<ConfigResult<TrialAttempt>>;
  recordObservation(input: RecordObservation): Promise<ConfigResult<ConfigTrial>>;
  requestRollback(input: RequestRollback): Promise<ConfigResult<ConfigTrial>>;
  closeTrial(input: CloseTrial): Promise<ConfigResult<ConfigTrial>>;
  reconcile(now: EpochMs): Promise<ConfigResult<ReconcileReport>>;
}

/* ------------------------------------------------------------------ */
/* startTrial replay (DD-CFG-127)                                      */
/* ------------------------------------------------------------------ */

interface StartTrialFrozen {
  plan_id: Id<"trial">;
  config_space_id: Hash;
  execution_kind: StartTrial["execution_kind"];
  predecessor_trial_id: Id<"ctr"> | null;
  evidence_basis: ConfigTrial["evidence_basis"];
  authorization: {
    candidate_id: Id<"ctr">;
    update_grant_id: Id | null;
    rollback_grant_id: Id | null;
    update_patch_hash: Hash | null;
    rollback_patch_hash: Hash | null;
    scope_hash: Hash;
  };
  capability_snapshot_hash: Hash;
  binding: VersionBinding;
}

type ReplayDecision = "existing" | "new" | "conflict";

function sameNullable<T>(left: T | null, right: T | null): boolean {
  return left === right;
}

/**
 * Same `trial_id` is a replay only when every frozen field matches. A
 * different `trial_id` is a new request handled by the active/claim gate.
 */
export function startTrialReplayDecision(
  existing: { trial: ConfigTrial; binding: VersionBinding } | null,
  request: StartTrialFrozen
): ReplayDecision {
  if (existing === null) {
    return "new";
  }
  const trial = existing.trial;
  const authorizationMatches =
    trial.authorization.candidate_id === request.authorization.candidate_id &&
    sameNullable(trial.authorization.update_grant_id, request.authorization.update_grant_id) &&
    sameNullable(trial.authorization.rollback_grant_id, request.authorization.rollback_grant_id) &&
    sameNullable(trial.authorization.update_patch_hash, request.authorization.update_patch_hash) &&
    sameNullable(trial.authorization.rollback_patch_hash, request.authorization.rollback_patch_hash) &&
    trial.authorization.scope_hash === request.authorization.scope_hash;
  const bindingMatches =
    existing.binding.task_id === request.binding.task_id &&
    existing.binding.branch_id === request.binding.branch_id &&
    existing.binding.input_epoch === request.binding.input_epoch &&
    existing.binding.goal_version === request.binding.goal_version &&
    existing.binding.config_version === request.binding.config_version &&
    existing.binding.watermark === request.binding.watermark;
  const matches =
    trial.plan_id === request.plan_id &&
    trial.config_space.config_space_id === request.config_space_id &&
    trial.execution_kind === request.execution_kind &&
    trial.predecessor_trial_id === request.predecessor_trial_id &&
    trial.evidence_basis === request.evidence_basis &&
    trial.capability_snapshot_hash === request.capability_snapshot_hash &&
    authorizationMatches &&
    bindingMatches;
  return matches ? "existing" : "conflict";
}

/** `startTrial` checks active trial before a residual held claim (DD-CFG-012). */
export function startTrialAdmissionError(input: {
  active_trial_exists: boolean;
  held_claim_exists: boolean;
}): ConfigError | null {
  if (input.active_trial_exists) {
    return configError("E_CFG_ACTIVE_TRIAL");
  }
  if (input.held_claim_exists) {
    return configError("E_CFG_FIELD_CLAIMED");
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Attempt idempotency (DD-CFG-130, DD-CFG-131)                        */
/* ------------------------------------------------------------------ */

type AttemptReplayDecision =
  | { kind: "replay"; attempt: TrialAttempt }
  | { kind: "execute" }
  | { kind: "conflict" };

export function attemptReplayDecision(
  existing: TrialAttempt | null,
  requestHash: Hash
): AttemptReplayDecision {
  if (existing === null) {
    return { kind: "execute" };
  }
  if (existing.request_hash !== requestHash) {
    return { kind: "conflict" };
  }
  if (existing.result !== null) {
    return { kind: "replay", attempt: existing };
  }
  // Same key, same request, still running: callers keep polling the original
  // attempt; they never submit a second write.
  return { kind: "replay", attempt: existing };
}

/** `executeAttempt` refuses a closed or aborted trial (DD-CFG-126). */
export function assertTrialNotTerminal(trial: ConfigTrial): ConfigResult<void> {
  if (trial.phase === "closed" || trial.phase === "aborted") {
    return fail(configError("E_CFG_TRIAL_TERMINAL", { details: [{ key: "phase", value: trial.phase }] }));
  }
  return succeed(undefined);
}

/** A guardrail breach blocks every non-rollback attempt (DD-CFG-090.3). */
export function assertAttemptNotBreached(trial: ConfigTrial, kind: AttemptKind): ConfigResult<void> {
  const breach = trial.last_error?.code === "E_CFG_GUARDRAIL_BREACH";
  if (!breach) {
    return succeed(undefined);
  }
  const recoveryKinds: readonly AttemptKind[] = ["rollback_write", "rollback_readback", "reconcile"];
  if (recoveryKinds.includes(kind)) {
    return succeed(undefined);
  }
  return fail(configError("E_CFG_GUARDRAIL_BREACH", { details: [{ key: "kind", value: kind }] }));
}

/** `deadline_ms` must be `1..600000` for every config-write entry point. */
export function validateDeadline(deadlineMs: number): ConfigResult<void> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 600_000) {
    return fail(configError("E_CFG_DEADLINE_EXCEEDED", { details: [{ key: "deadline_ms", value: deadlineMs }] }));
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Observation (DD-CFG-143, DD-CFG-152)                                */
/* ------------------------------------------------------------------ */

export function buildObservationRecord(input: {
  trial_id: Id<"ctr">;
  sample_id: string;
  observed_at: EpochMs;
  trigger: boolean;
  telemetry: { complete: boolean; trigger_data_present: boolean };
  probe: ObservationRecord["probe"];
  guardrails: readonly GuardrailValue[];
  evidence_ref: SourceRef;
}): ObservationRecord {
  const body = {
    schema_version: "rsi.config_observation/1" as const,
    trial_id: input.trial_id,
    sample_id: input.sample_id,
    observed_at: input.observed_at,
    trigger: input.trigger,
    telemetry: input.telemetry,
    probe: input.probe,
    guardrails: input.guardrails,
    evidence_ref: input.evidence_ref
  };
  return { ...body, record_hash: computeObservationRecordHash(body) };
}

function nonSafetyGuardrails(guardrails: readonly GuardrailValue[]): readonly GuardrailValue[] {
  return guardrails.filter((guardrail) => guardrail.guardrail_id !== "safety_zero");
}

function guardrailValueKey(value: GuardrailValue): string {
  return [
    value.guardrail_id,
    value.metric_id,
    value.value === null ? "null" : String(value.value),
    value.status,
    String(value.sample_count),
    value.evidence_ref ?? "null"
  ].join("\u0000");
}

/**
 * Fast replay before auditing: identical sample content returns the existing
 * observation; any difference is a conflict (DD-CFG-152). `safety_zero` is
 * excluded because it is recomputed by the audit.
 */
export function observationReplayDecision(
  existing: ObservationRecord | null,
  request: Omit<RecordObservation, "trial_id"> & { trial_id: Id<"ctr"> }
): "existing" | "new" | "conflict" {
  if (existing === null) {
    return "new";
  }
  const sameProbe = JSON.stringify(existing.probe) === JSON.stringify(request.probe);
  const sameTelemetry =
    existing.telemetry.complete === request.telemetry.complete &&
    existing.telemetry.trigger_data_present === request.telemetry.trigger_data_present;
  const left = nonSafetyGuardrails(existing.guardrails).map(guardrailValueKey).sort();
  const right = nonSafetyGuardrails(request.guardrails).map(guardrailValueKey).sort();
  const sameGuardrails = left.length === right.length && left.every((value, index) => value === right[index]);
  const matches =
    existing.observed_at === request.observed_at &&
    existing.trigger === request.trigger &&
    sameTelemetry &&
    sameProbe &&
    sameGuardrails;
  return matches ? "existing" : "conflict";
}

/** `window_opened_at` starts at `created_at` for the safety audit lower bound. */
export function auditWindow(input: {
  created_at: EpochMs;
  previous_observed_at: EpochMs | null;
  observed_at: EpochMs;
  scope: "sample_close" | "window_close";
}): { opened_at: EpochMs; closed_at: EpochMs } {
  if (input.scope === "window_close") {
    return { opened_at: input.created_at, closed_at: input.observed_at };
  }
  return {
    opened_at: input.previous_observed_at ?? input.created_at,
    closed_at: input.observed_at
  };
}

/** A `complete=false` audit is `unknown`, never zero (DD-CFG-091). */
export function safetyGuardrailValue(input: {
  complete: boolean;
  forbidden_event_count: number;
  sample_count: number;
  evidence_ref: SourceRef | null;
  min_samples: number;
}): GuardrailValue {
  // DD-CFG-090.3: only `count>0` with `complete=true` breaches. The
  // sample minimum gates the "ok" conclusion, not the breach: a forbidden
  // write seen in the first sample must breach immediately.
  const status = !input.complete
    ? "unknown"
    : input.forbidden_event_count > 0
      ? "breached"
      : input.sample_count >= input.min_samples
        ? "ok"
        : "unknown";
  return {
    guardrail_id: "safety_zero",
    metric_id: "forbidden_write_count",
    value: status === "unknown" ? null : input.forbidden_event_count,
    status,
    sample_count: input.sample_count,
    evidence_ref: input.evidence_ref
  };
}

/* ------------------------------------------------------------------ */
/* Reconcile (DD-CFG-154)                                              */
/* ------------------------------------------------------------------ */

type FieldState = "baseline" | "candidate" | "third_value" | "unreadable";

interface ReconcileContext {
  trial_id: Id<"ctr">;
  attempt: AttemptRef | null;
  phase: TrialPhase;
  write_kind: "write" | "rollback_write" | "unknown";
  field_state: FieldState;
  rollback_requested: boolean;
  /** Existing operator-visible reason, preserved for `recovery_required`. */
  error_code?: ConfigErrorCode;
}

/**
 * Maps observed field state to a reconcile action. Readback is the highest
 * fact; no branch guesses a successful write.
 *
 * `recovery_required` is a quarantine, not a reconcile target: the trial may
 * only leave it through the named operator exits (`requestRollback` or
 * `closeTrial(abandoned)`). A readback observed while quarantined, even one
 * that looks like the candidate or the baseline, must not silently reopen
 * observation or close the trial and release its claims.
 */
export function reconcileEntryFor(context: ReconcileContext): ReconcileEntry {
  if (context.phase === "recovery_required") {
    return {
      trial_id: context.trial_id,
      attempt: context.attempt,
      action: "recovery_required",
      phase_after: "recovery_required",
      error_code: context.error_code ?? "E_CFG_RECOVERY_REQUIRED"
    };
  }
  if (context.field_state === "third_value") {
    return {
      trial_id: context.trial_id,
      attempt: context.attempt,
      action: "recovery_required",
      phase_after: "recovery_required",
      error_code: context.write_kind === "rollback_write" ? "E_CFG_ROLLBACK_CONFLICT" : "E_CFG_EXTERNAL_CHANGE"
    };
  }
  if (context.field_state === "unreadable") {
    return {
      trial_id: context.trial_id,
      attempt: context.attempt,
      action: "recovery_required",
      phase_after: "recovery_required",
      error_code: "E_CFG_RECOVERY_REQUIRED"
    };
  }
  if (context.field_state === "candidate") {
    if (context.write_kind === "rollback_write") {
      return {
        trial_id: context.trial_id,
        attempt: context.attempt,
        action: "rollback_pending",
        phase_after: "rolling_back",
        error_code: null
      };
    }
    return {
      trial_id: context.trial_id,
      attempt: context.attempt,
      action: "recovered_readback",
      phase_after: "observing",
      error_code: null
    };
  }
  // Baseline readback.
  if (context.write_kind === "rollback_write") {
    // A committed rollback write may only self-heal into `closed` while the
    // trial is still legally `rolling_back`; any other phase is inconsistent
    // and must not be closed by reconcile.
    if (context.phase !== "rolling_back") {
      return {
        trial_id: context.trial_id,
        attempt: context.attempt,
        action: "no_action",
        phase_after: context.phase,
        error_code: null
      };
    }
    return {
      trial_id: context.trial_id,
      attempt: context.attempt,
      action: "recovered_readback",
      phase_after: "closed",
      error_code: null
    };
  }
  if (context.phase === "writing" || context.phase === "authorized") {
    return {
      trial_id: context.trial_id,
      attempt: context.attempt,
      action: "marked_failed",
      phase_after: "closed",
      error_code: "E_CFG_WRITE_FAILED"
    };
  }
  return {
    trial_id: context.trial_id,
    attempt: context.attempt,
    action: "no_action",
    phase_after: context.phase,
    error_code: null
  };
}

export function reconcileReport(checkedAt: EpochMs, entries: readonly ReconcileEntry[], scanned: number): ReconcileReport {
  const unresolved = entries
    .filter((entry) => entry.action === "recovery_required" || entry.phase_after === "recovery_required")
    .map((entry) => entry.trial_id as Id);
  return {
    checked_at: checkedAt,
    scanned_trials: scanned,
    entries,
    unresolved_trial_ids: unresolved
  };
}

/* ------------------------------------------------------------------ */
/* Field value comparison for CAS                                      */
/* ------------------------------------------------------------------ */

export function fieldSetMatches(
  observed: readonly FieldReadback[],
  expected: readonly FieldAssignment[]
): boolean {
  if (observed.length !== expected.length) {
    return false;
  }
  const byId = new Map(observed.map((readback) => [readback.field_id, readback]));
  return expected.every((assignment) => {
    const readback = byId.get(assignment.field_id);
    if (readback === undefined) {
      return false;
    }
    return assignmentValueKey(readback.observed) === assignmentValueKey(assignment.value);
  });
}

