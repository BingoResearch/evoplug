/**
 * ConfigTrial / TrialAttempt state machine (DD-CFG-120 … DD-CFG-131,
 * DD-CFG-141, DD-CFG-171).
 *
 * Three independent axes: `phase` (execution), `evidence_level` (highest
 * evidence reached, monotonic) and `outcome` (disposition). Rollback never
 * lowers the historical level and `not_exercised` never touches the level.
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { SourceRef } from "../source-ref.js";
import type {
  AttemptKind,
  EpochMs,
  RollbackReason,
  CloseReason,
  ConfigResult,
  ConfigTrial,
  CurrentConfigProjection,
  EvidenceLevel,
  ExecutionKind,
  EffectiveProbe,
  FieldReadback,
  ObservationRecord,
  RecoveryAttestation,
  TrialAttempt,
  RollbackState,
  TrialOutcome,
  TrialPhase
} from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import { windowProfile } from "./guardrails.js";

export const TRIAL_PHASES: readonly TrialPhase[] = [
  "planned",
  "authorized",
  "writing",
  "write_recorded",
  "awaiting_apply",
  "observing",
  "rolling_back",
  "recovery_required",
  "closed",
  "aborted"
];

export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  "none",
  "written_unverified",
  "applied",
  "effective",
  "causal"
];

export function isTerminalPhase(phase: TrialPhase): boolean {
  return phase === "closed" || phase === "aborted";
}

export function isActivePhase(phase: TrialPhase): boolean {
  return !isTerminalPhase(phase);
}

/** §10.2 transition table. `planned` exists only in the precheck projection. */
const TRANSITIONS: Readonly<Record<TrialPhase, readonly TrialPhase[]>> = {
  planned: ["authorized", "aborted"],
  authorized: ["writing", "observing", "rolling_back", "closed", "aborted"],
  writing: ["authorized", "write_recorded", "closed", "rolling_back", "recovery_required"],
  write_recorded: ["awaiting_apply", "closed", "rolling_back", "recovery_required"],
  awaiting_apply: ["observing", "rolling_back", "recovery_required"],
  observing: ["closed", "rolling_back"],
  rolling_back: ["closed", "recovery_required"],
  recovery_required: ["rolling_back", "closed"],
  closed: [],
  aborted: []
};

export function canTransition(from: TrialPhase, to: TrialPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertPhaseTransition(from: TrialPhase, to: TrialPhase): ConfigResult<void> {
  if (isTerminalPhase(from)) {
    return fail(configError("E_CFG_TRIAL_TERMINAL", { details: [{ key: "phase", value: from }] }));
  }
  if (!canTransition(from, to)) {
    return fail(
      configError("E_CFG_ILLEGAL_TRANSITION", {
        details: [
          { key: "from", value: from },
          { key: "to", value: to }
        ]
      })
    );
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Attempt kind / phase gate (DD-CFG-141)                              */
/* ------------------------------------------------------------------ */

export function isAttemptKindAllowed(
  kind: AttemptKind,
  executionKind: ExecutionKind,
  phase: TrialPhase
): boolean {
  switch (kind) {
    case "write":
      return executionKind === "write_and_observe" && phase === "authorized";
    case "readback":
      if (executionKind === "write_and_observe") {
        return phase === "write_recorded" || phase === "awaiting_apply";
      }
      if (executionKind === "observe_only") {
        return phase === "authorized";
      }
      return false;
    case "apply_probe":
      return phase === "awaiting_apply" || phase === "observing";
    case "rollback_write":
      if (executionKind === "rollback_only" && phase === "authorized") {
        return true;
      }
      return phase === "rolling_back";
    case "rollback_readback":
      return phase === "rolling_back";
    case "reconcile":
      return false;
    case "observation":
      return false;
  }
}

export function checkAttemptKind(kind: AttemptKind, executionKind: ExecutionKind, phase: TrialPhase): ConfigResult<void> {
  if (!isAttemptKindAllowed(kind, executionKind, phase)) {
    return fail(
      configError("E_CFG_ILLEGAL_TRANSITION", {
        details: [
          { key: "kind", value: kind },
          { key: "execution_kind", value: executionKind },
          { key: "phase", value: phase }
        ]
      })
    );
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Evidence level upgrade (DD-CFG-123)                                 */
/* ------------------------------------------------------------------ */

export function levelRank(level: EvidenceLevel): number {
  return EVIDENCE_LEVELS.indexOf(level);
}

/** Levels only move upward; rollback never resets them (DD-CFG-121). */
export function upgradeEvidenceLevel(current: EvidenceLevel, target: EvidenceLevel): ConfigResult<EvidenceLevel> {
  if (levelRank(target) < levelRank(current)) {
    return fail(
      configError("E_CFG_ILLEGAL_TRANSITION", {
        details: [
          { key: "evidence_level", value: current },
          { key: "target", value: target }
        ]
      })
    );
  }
  return succeed(target);
}

/** A probe proves effectiveness only with the DD-CFG-094 / DD-CFG-123 rules. */
export function probeProvesEffective(probe: EffectiveProbe): boolean {
  if (probe.baseline_explainable) {
    return false;
  }
  if (probe.source === "behavior_signature") {
    return probe.repeat_count >= 2;
  }
  return probe.resolved.length > 0;
}

/**
 * Applies an observation's probe to the level. `effective` needs a valid
 * probe; `causal` is only set by the pre-registered experiment path.
 */
export function levelAfterProbe(current: EvidenceLevel, probe: EffectiveProbe | null): EvidenceLevel {
  if (probe === null || !probeProvesEffective(probe)) {
    return current;
  }
  return levelRank(current) < levelRank("effective") ? "effective" : current;
}

/* ------------------------------------------------------------------ */
/* Outcome legality (DD-CFG-125)                                       */
/* ------------------------------------------------------------------ */

export function validateOutcomeCombination(trial: {
  phase: TrialPhase;
  evidence_level: EvidenceLevel;
  outcome: TrialOutcome;
  rollback: { state: RollbackState["state"] };
  has_write_attempt: boolean;
}): ConfigResult<void> {
  const { phase, evidence_level: level, outcome, rollback } = trial;
  const closedOnly: readonly TrialOutcome[] = [
    "not_exercised",
    "inconclusive",
    "effect_supported",
    "effect_rejected",
    "rolled_back",
    "failed"
  ];
  if (outcome === "running") {
    if (isTerminalPhase(phase)) {
      return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "outcome", value: "running" }] }));
    }
    return succeed(undefined);
  }
  if (closedOnly.includes(outcome) && phase !== "closed") {
    return fail(
      configError("E_CFG_ILLEGAL_TRANSITION", {
        details: [
          { key: "phase", value: phase },
          { key: "outcome", value: outcome }
        ]
      })
    );
  }
  if ((outcome === "effect_supported" || outcome === "effect_rejected") && level !== "causal") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "outcome", value: outcome }] }));
  }
  if (outcome === "rolled_back" && rollback.state !== "baseline_confirmed") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "rollback_state", value: rollback.state }] }));
  }
  if (outcome === "aborted") {
    if (phase !== "aborted" || level !== "none" || trial.has_write_attempt) {
      return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "outcome", value: "aborted" }] }));
    }
  }
  if (outcome === "not_exercised" && levelRank(level) < levelRank("applied")) {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "outcome", value: "not_exercised" }] }));
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* DD-CFG-171 write-result mapping                                     */
/* ------------------------------------------------------------------ */

export type WriteTerminalState =
  | "verified"
  | "conflict"
  | "path_rejected"
  | "write_failed"
  | "uncertain"
  | "recovery_required";

export type IndependentEvidence =
  | "baseline_no_write"
  | "candidate_or_partial"
  | "unreadable_or_third_value";

export interface WriteResultMapping {
  phase: TrialPhase;
  outcome: TrialOutcome;
  last_error_code: string | null;
  rollback_state: RollbackState["state"];
  rollback_required: boolean;
  current_config_state: CurrentConfigProjection["state"] | null;
  claim: "held" | "released";
  update_grant_consumed: boolean;
  rollback_grant_consumed: boolean;
}

/**
 * Fixed mapping for a forward candidate commit. The state label never replaces
 * independent readback evidence; `conflict` still enters `recovery_required`.
 */
export function mapWriteResult(state: WriteTerminalState, evidence: IndependentEvidence): WriteResultMapping {
  switch (state) {
    case "verified":
      return {
        phase: "write_recorded",
        outcome: "running",
        last_error_code: null,
        rollback_state: "not_required",
        rollback_required: false,
        current_config_state: null,
        claim: "held",
        update_grant_consumed: true,
        rollback_grant_consumed: false
      };
    case "write_failed":
    case "path_rejected": {
      const code = state === "write_failed" ? "E_CFG_WRITE_FAILED" : "E_CFG_FIELD_NOT_EXECUTABLE";
      if (evidence === "baseline_no_write") {
        return {
          phase: "closed",
          outcome: "failed",
          last_error_code: code,
          rollback_state: "not_required",
          rollback_required: false,
          current_config_state: "baseline_confirmed",
          claim: "released",
          update_grant_consumed: false,
          rollback_grant_consumed: false
        };
      }
      if (evidence === "candidate_or_partial") {
        return {
          phase: "rolling_back",
          outcome: "running",
          last_error_code: code,
          rollback_state: "pending",
          rollback_required: true,
          current_config_state: null,
          claim: "held",
          update_grant_consumed: false,
          rollback_grant_consumed: false
        };
      }
      return {
        phase: "recovery_required",
        outcome: "running",
        last_error_code: "E_CFG_RECOVERY_REQUIRED",
        rollback_state: "unverified",
        rollback_required: true,
        current_config_state: null,
        claim: "held",
        update_grant_consumed: false,
        rollback_grant_consumed: false
      };
    }
    case "uncertain":
      return {
        phase: "recovery_required",
        outcome: "running",
        last_error_code: "E_CFG_WRITE_UNCERTAIN",
        rollback_state: "unverified",
        rollback_required: true,
        current_config_state: null,
        claim: "held",
        update_grant_consumed: false,
        rollback_grant_consumed: false
      };
    case "conflict":
      return {
        phase: "recovery_required",
        outcome: "running",
        last_error_code: "E_CFG_FIELD_CONFLICT",
        rollback_state: "unverified",
        rollback_required: true,
        current_config_state: null,
        claim: "held",
        update_grant_consumed: false,
        rollback_grant_consumed: false
      };
    case "recovery_required":
      return {
        phase: "recovery_required",
        outcome: "running",
        last_error_code: "E_CFG_RECOVERY_REQUIRED",
        rollback_state: "unverified",
        rollback_required: true,
        current_config_state: null,
        claim: "held",
        update_grant_consumed: false,
        rollback_grant_consumed: false
      };
  }
}

/**
 * Mapping for a rollback write. It deliberately differs from the forward
 * mapping: a verified rollback write is not a candidate commit. The trial must
 * stay in `rolling_back` until `rollback_readback` independently observes the
 * baseline, because only that phase permits the readback and only a restored
 * readback may close the trial and release claims.
 */
export function mapRollbackWriteResult(
  state: WriteTerminalState,
  evidence: IndependentEvidence
): WriteResultMapping {
  const pendingReadback = (
    lastError: string | null,
    rollbackState: RollbackState["state"],
    currentConfigState: CurrentConfigProjection["state"] | null
  ): WriteResultMapping => ({
    phase: "rolling_back",
    outcome: "running",
    last_error_code: lastError,
    rollback_state: rollbackState,
    rollback_required: true,
    current_config_state: currentConfigState,
    claim: "held",
    update_grant_consumed: false,
    rollback_grant_consumed: state === "verified"
  });
  const recovery = (code: string, rollbackState: RollbackState["state"]): WriteResultMapping => ({
    phase: "recovery_required",
    outcome: "running",
    last_error_code: code,
    rollback_state: rollbackState,
    rollback_required: true,
    current_config_state: null,
    claim: "held",
    update_grant_consumed: false,
    rollback_grant_consumed: state === "verified"
  });
  if (state === "verified") {
    if (evidence === "baseline_no_write") {
      return pendingReadback(null, "in_progress", "baseline_confirmed");
    }
    return evidence === "candidate_or_partial"
      ? recovery("E_CFG_ROLLBACK_CONFLICT", "conflict")
      : recovery("E_CFG_ROLLBACK_CONFLICT", "unverified");
  }
  if (state === "write_failed" || state === "path_rejected") {
    const code = state === "write_failed" ? "E_CFG_WRITE_FAILED" : "E_CFG_FIELD_NOT_EXECUTABLE";
    if (evidence === "baseline_no_write") {
      // The write failed, but the live file is independently confirmed at the
      // baseline. Keep the trial in rolling_back so the mandatory rollback
      // readback records the restoration and closes it.
      return pendingReadback(code, "in_progress", "baseline_confirmed");
    }
    return evidence === "candidate_or_partial"
      ? recovery(code, "conflict")
      : recovery(code, "unverified");
  }
  if (state === "uncertain") {
    return recovery("E_CFG_WRITE_UNCERTAIN", "unverified");
  }
  if (state === "conflict") {
    return recovery("E_CFG_FIELD_CONFLICT", "unverified");
  }
  return recovery("E_CFG_RECOVERY_REQUIRED", "unverified");
}

/* ------------------------------------------------------------------ */
/* Initial trial state (DD-CFG-127)                                    */
/* ------------------------------------------------------------------ */

export interface InitialTrialInput {
  trial_id: Id<"ctr">;
  plan_id: Id<"trial">;
  plan_hash: Hash;
  config_space: ConfigTrial["config_space"];
  execution_kind: ExecutionKind;
  predecessor_trial_id: Id<"ctr"> | null;
  evidence_basis: ConfigTrial["evidence_basis"];
  authorization: ConfigTrial["authorization"];
  capability_snapshot_hash: Hash;
  baseline_confirmed: boolean;
  created_at: EpochMs;
  target_values: CurrentConfigProjection["values"];
}

export function initialTrial(input: InitialTrialInput): ConfigTrial {
  const observeOnly = input.execution_kind === "observe_only";
  const rollbackOnly = input.execution_kind === "rollback_only";
  return {
    schema_version: "rsi.config_trial/1",
    trial_id: input.trial_id,
    plan_id: input.plan_id,
    plan_hash: input.plan_hash,
    config_space: input.config_space,
    execution_kind: input.execution_kind,
    predecessor_trial_id: input.predecessor_trial_id,
    evidence_basis: input.evidence_basis,
    authorization: input.authorization,
    capability_snapshot_hash: input.capability_snapshot_hash,
    phase: "authorized",
    evidence_level: "none",
    outcome: "running",
    current_config: {
      state: observeOnly || rollbackOnly ? "unknown" : input.baseline_confirmed ? "baseline_confirmed" : "unknown",
      values: observeOnly || rollbackOnly ? [] : input.target_values,
      observed_at: null,
      readback_ref: null,
      config_version: null
    },
    observation: {
      window_opened_at: null,
      window_closes_at: null,
      matched_samples: 0,
      trigger_samples: 0,
      probe_samples: 0,
      guardrail_evaluations: 0,
      last_sample_at: null
    },
    close_audit_ref: null,
    rollback: {
      state: rollbackOnly ? "pending" : "not_required",
      reason: rollbackOnly ? "manual" : null,
      target_values: input.target_values,
      readback_ref: null
    },
    recovery: null,
    revision: 1,
    created_at: input.created_at,
    updated_at: input.created_at,
    last_error: null
  };
}

/* ------------------------------------------------------------------ */
/* Observation application                                             */
/* ------------------------------------------------------------------ */

/**
 * Counter update for one accepted observation. Window opening is a separate
 * transition; `window_opened_at` is never re-derived from a sample.
 */
export function applyObservationCounters(trial: ConfigTrial, record: ObservationRecord): ConfigTrial {
  const observation = {
    ...trial.observation,
    matched_samples: trial.observation.matched_samples + 1,
    trigger_samples: trial.observation.trigger_samples + (record.trigger ? 1 : 0),
    probe_samples: trial.observation.probe_samples + (record.probe === null ? 0 : 1),
    guardrail_evaluations: trial.observation.guardrail_evaluations + record.guardrails.length,
    last_sample_at: record.observed_at
  };
  return {
    ...trial,
    observation,
    evidence_level: levelAfterProbe(trial.evidence_level, record.probe),
    revision: trial.revision + 1,
    updated_at: record.observed_at
  };
}

/** Opens the window exactly once when entering `observing` at `applied`. */
export function openObservationWindow(
  trial: ConfigTrial,
  profileId: "W1" | "W2"
): ConfigResult<ConfigTrial> {
  if (trial.phase !== "observing") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "phase", value: trial.phase }] }));
  }
  if (trial.evidence_level === "none" || trial.evidence_level === "written_unverified") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "evidence_level", value: trial.evidence_level }] }));
  }
  if (trial.observation.window_opened_at !== null) {
    return succeed(trial);
  }
  const maxElapsedMs = windowProfile(profileId).max_elapsed_ms;
  return succeed({
    ...trial,
    observation: {
      ...trial.observation,
      window_opened_at: trial.updated_at,
      window_closes_at: trial.updated_at + maxElapsedMs
    }
  });
}

/** `recordObservation` before the window opens is illegal (DD-CFG-092). */
export function requireOpenWindow(trial: ConfigTrial): ConfigResult<void> {
  if (trial.phase !== "observing") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "phase", value: trial.phase }] }));
  }
  if (trial.observation.window_opened_at === null) {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "window_opened_at", value: "missing" }] }));
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Recovery / close (DD-CFG-155)                                       */
/* ------------------------------------------------------------------ */

export interface RollbackReadBack {
  /** The current config version read back from the live config space. */
  readonly config_version?: string | null;
  /** The current semantic hash read back from the live config space. */
  readonly semantic_hash?: string | null;
}

export function requestRollbackTransition(
  trial: ConfigTrial,
  reason: RollbackReason,
  attestation: RecoveryAttestation | null,
  receivedAt: EpochMs,
  expectedRevision?: number,
  readBack?: RollbackReadBack
): ConfigResult<ConfigTrial> {
  if (trial.phase !== "recovery_required") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "phase", value: trial.phase }] }));
  }
  if (attestation === null) {
    return fail(configError("E_CFG_RECOVERY_REQUIRED", { details: [{ key: "attestation", value: "missing" }] }));
  }
  if (reason !== "manual") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "reason", value: reason }] }));
  }
  // DD-CFG-155: the named exits require an `expected_revision` CAS.
  if (expectedRevision !== undefined && expectedRevision !== trial.revision) {
    return fail(
      configError("E_CFG_STALE_BASELINE", {
        details: [
          { key: "expected_revision", value: String(expectedRevision) },
          { key: "revision", value: String(trial.revision) }
        ]
      })
    );
  }
  // DD-CFG-155: the read-back must agree with the attestation. The
  // read-back values come from the live config space; the trial's frozen
  // projection is not a read-back.
  const currentConfigVersion =
    readBack?.config_version !== undefined
      ? readBack.config_version
      : trial.current_config.config_version;
  const currentSemanticHash = readBack?.semantic_hash;
  const versionMismatch =
    currentConfigVersion !== null && currentConfigVersion !== attestation.observed_config_version;
  const semanticMismatch =
    currentSemanticHash !== undefined &&
    currentSemanticHash !== null &&
    currentSemanticHash !== attestation.observed_semantic_hash;
  if (versionMismatch || semanticMismatch) {
    return fail(
      configError("E_CFG_STALE_BASELINE", {
        details: [
          { key: "observed_config_version", value: attestation.observed_config_version },
          { key: "observed_semantic_hash", value: attestation.observed_semantic_hash }
        ]
      })
    );
  }
  return succeed({
    ...trial,
    phase: "rolling_back",
    rollback: {
      ...trial.rollback,
      state: "pending",
      reason: "manual"
    },
    current_config: {
      ...trial.current_config,
      state: "unknown",
      observed_at: null,
      readback_ref: null
    },
    recovery: { attestation, received_at: receivedAt, resolution: "rollback_requested" },
    revision: trial.revision + 1,
    updated_at: receivedAt
  });
}

export function closeAbandonedTransition(
  trial: ConfigTrial,
  attestation: RecoveryAttestation | null,
  receivedAt: EpochMs
): ConfigResult<ConfigTrial> {
  if (trial.phase !== "recovery_required") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "phase", value: trial.phase }] }));
  }
  if (attestation === null) {
    return fail(configError("E_CFG_RECOVERY_REQUIRED", { details: [{ key: "attestation", value: "missing" }] }));
  }
  return succeed({
    ...trial,
    phase: "closed",
    outcome: "failed",
    rollback: { ...trial.rollback, state: "abandoned" },
    recovery: { attestation, received_at: receivedAt, resolution: "abandoned" },
    revision: trial.revision + 1,
    updated_at: receivedAt
  });
}

/** Only `recovery_required` closes through the two named exits. */
export function checkCloseReason(phase: TrialPhase, reason: CloseReason): ConfigResult<void> {
  if (phase === "recovery_required") {
    if (reason !== "abandoned") {
      return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "reason", value: reason }] }));
    }
    return succeed(undefined);
  }
  if (reason === "abandoned") {
    return fail(configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "phase", value: phase }] }));
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Legacy /1 projection (DD-CFG-160)                                   */
/* ------------------------------------------------------------------ */

export type LegacyPlanState =
  | "planned"
  | "written_unverified"
  | "applied"
  | "not_exercised"
  | "effective"
  | "causal_supported"
  | "inconclusive"
  | "rolled_back"
  | "failed";

export interface LegacyProjection {
  phase: TrialPhase;
  evidence_level: EvidenceLevel;
  outcome: TrialOutcome;
  executable: false;
}

/** `/1` objects are read-only and never become executable (DD-CFG-160). */
export function projectLegacyState(
  state: LegacyPlanState,
  highestEvidence: EvidenceLevel = "none"
): LegacyProjection {
  switch (state) {
    case "planned":
      return { phase: "planned", evidence_level: "none", outcome: "running", executable: false };
    case "written_unverified":
      return { phase: "awaiting_apply", evidence_level: "written_unverified", outcome: "running", executable: false };
    case "applied":
      return { phase: "observing", evidence_level: "applied", outcome: "running", executable: false };
    case "not_exercised":
      return { phase: "closed", evidence_level: "applied", outcome: "not_exercised", executable: false };
    case "effective":
      return { phase: "closed", evidence_level: "effective", outcome: "inconclusive", executable: false };
    case "causal_supported":
      return { phase: "closed", evidence_level: "causal", outcome: "inconclusive", executable: false };
    case "inconclusive":
      return { phase: "closed", evidence_level: highestEvidence, outcome: "inconclusive", executable: false };
    case "rolled_back":
      return { phase: "closed", evidence_level: highestEvidence, outcome: "rolled_back", executable: false };
    case "failed":
      return { phase: "closed", evidence_level: highestEvidence, outcome: "failed", executable: false };
  }
}

/** Test-side booleans derived from the three axes (DD-CFG-162 truth table). */
export function legacyBooleans(trial: Pick<ConfigTrial, "phase" | "evidence_level" | "outcome">): {
  applied: boolean;
  effective: boolean;
  causal: boolean;
  success_claim: boolean;
} {
  return {
    applied: levelRank(trial.evidence_level) >= levelRank("applied"),
    effective: levelRank(trial.evidence_level) >= levelRank("effective"),
    causal: trial.evidence_level === "causal",
    success_claim:
      trial.phase === "closed" && trial.evidence_level === "causal" && trial.outcome === "effect_supported"
  };
}

/**
 * `audit_input` is mandatory for write attempts and must be null for every
 * other kind (DD-CFG-130). It is written once and never re-collected.
 */
export function validateAttemptAuditInput(
  kind: AttemptKind,
  auditInput: TrialAttempt["audit_input"]
): ConfigResult<void> {
  if (kind === "write" || kind === "rollback_write") {
    if (auditInput === null) {
      return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "audit_input", value: "missing" }] }));
    }
    if (auditInput.target_path.startsWith("/") || auditInput.target_path.includes("..")) {
      return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "target_path", value: "not_relative" }] }));
    }
    return succeed(undefined);
  }
  if (auditInput !== null) {
    return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "audit_input", value: "unexpected" }] }));
  }
  return succeed(undefined);
}

/** Attempt identity: `(trial_id, sequence)` plus a globally unique key. */
export function nextAttemptSequence(attempts: readonly { sequence: number }[]): number {
  let max = 0;
  for (const attempt of attempts) {
    if (attempt.sequence > max) {
      max = attempt.sequence;
    }
  }
  return max + 1;
}

/** Readback evidence reference is mandatory for level upgrades. */
export function hasEvidenceRef(ref: SourceRef | null): ref is SourceRef {
  return ref !== null && ref.length > 0;
}

/** Field claims are released only on the two named close states (DD-CFG-158). */
export function shouldReleaseClaims(trial: Pick<ConfigTrial, "phase" | "current_config" | "rollback">): boolean {
  if (!isTerminalPhase(trial.phase)) {
    return false;
  }
  if (trial.current_config.state === "baseline_confirmed" || trial.current_config.state === "candidate_confirmed") {
    return true;
  }
  return trial.rollback.state === "abandoned";
}

/* ------------------------------------------------------------------ */
/* Apply readback classification (DD-CFG-048 … DD-CFG-050)             */
/* ------------------------------------------------------------------ */

export type ApplyReadbackClass =
  | { state: "applied" }
  | { state: "unconfirmed"; code: "E_CFG_APPLY_UNCONFIRMED" }
  | { state: "shadowed"; code: "E_CFG_NORMALIZATION_SHADOWED" }
  | { state: "timeout"; code: "E_CFG_READBACK_TIMEOUT" }
  | { state: "conflict"; code: "E_CFG_FIELD_CONFLICT" };

function sameAssignment(
  left: { presence: "present"; value: string | number | boolean | null } | { presence: "absent" },
  right: { presence: "present"; value: string | number | boolean | null } | { presence: "absent" }
): boolean {
  if (left.presence !== right.presence) {
    return false;
  }
  if (left.presence === "absent" || right.presence === "absent") {
    return true;
  }
  return Object.is(left.value, right.value);
}

/**
 * Classifies an apply-boundary readback. A write that reads back as the
 * baseline is `E_CFG_APPLY_UNCONFIRMED` (never `applied`); a value served from
 * a higher-precedence layer is shadowed.
 */
export function classifyApplyReadback(input: {
  observed: FieldReadback | null;
  timed_out: boolean;
  expected_candidate: { presence: "present"; value: string | number | boolean | null } | { presence: "absent" };
  baseline: { presence: "present"; value: string | number | boolean | null } | { presence: "absent" };
  selected_layer_id: string;
}): ApplyReadbackClass {
  if (input.timed_out || input.observed === null) {
    return { state: "timeout", code: "E_CFG_READBACK_TIMEOUT" };
  }
  if (input.observed.layer_id !== input.selected_layer_id) {
    return { state: "shadowed", code: "E_CFG_NORMALIZATION_SHADOWED" };
  }
  if (sameAssignment(input.observed.observed, input.expected_candidate)) {
    return { state: "applied" };
  }
  if (sameAssignment(input.observed.observed, input.baseline)) {
    return { state: "unconfirmed", code: "E_CFG_APPLY_UNCONFIRMED" };
  }
  return { state: "conflict", code: "E_CFG_FIELD_CONFLICT" };
}

/** Highest historical level survives rollback (DD-CFG-121). */
export function historicalHighWater(levels: readonly EvidenceLevel[]): EvidenceLevel {
  let highest: EvidenceLevel = "none";
  for (const level of levels) {
    if (levelRank(level) > levelRank(highest)) {
      highest = level;
    }
  }
  return highest;
}
