/**
 * Executable CFG service seams (DD-CFG-112, DD-CFG-140, DD-CFG-143).
 *
 * The design places the durable transaction and journal commit in the
 * composition root. These functions own the pure validation order and the
 * deterministic object construction that root drives: `createPlan` freezes a
 * `TrialPlan /2`, `startTrial` applies the admission order, and
 * `recordObservation` applies replay, safety audit and guardrail state.
 *
 * Ports are injected. `createPlan` calls `CapacityEvidencePort` at most once
 * and only when the factor's normalizer requires a sealed window
 * (DD-CFG-072); a failed port call maps to the fixed CFG code and produces no
 * plan value.
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { SourceRef } from "../source-ref.js";
import type { CapacityEvidencePort } from "../host/capability/capacity.js";
import type {
  ConfigProtectedSubtree,
  ConfigWritePatch,
  RootIdentityPin,
  SafetyAuditPort
} from "../ports/config-write.js";
import type {
  CapacityEvidence,
  ConfigResult,
  ConfigSpaceRef,
  ConfigSpaceSnapshot,
  ConfigTrial,
  CreateTrialPlan,
  FieldRegistrySnapshot,
  ObservationRecord,
  ObservationWindowSpec,
  RecordObservation,
  StartTrial,
  TrialAuthorization,
  TrialPlan
} from "./types.js";
import { configError, fail, mapCapacityError, mapSafetyAuditError, succeed } from "./errors.js";
import { applyObservationCounters, initialTrial } from "./trial.js";
import { auditWindow, buildObservationRecord, observationReplayDecision, safetyGuardrailValue, startTrialAdmissionError } from "./services.js";
import { hasBreach } from "./guardrails.js";
import { normalize, requiresCapacityEvidence } from "./normalization.js";
import { assembleTrialPlan, validateCreatePlan } from "./plan.js";

/* ------------------------------------------------------------------ */
/* createPlan (DD-CFG-112, DD-CFG-140)                                 */
/* ------------------------------------------------------------------ */

interface CreatePlanRuntimeDeps {
  registry: FieldRegistrySnapshot;
  baseline: ConfigSpaceSnapshot;
  /** Injected read-only HOST port; `null` when the factor needs no window. */
  capacity_evidence: CapacityEvidencePort | null;
  plan_id: Id<"trial">;
  created_at: number;
  readback_refs: readonly SourceRef[];
  deadline_ms?: number;
  patch_preview?: { write: ConfigWritePatch | null; rollback: ConfigWritePatch | null };
}

const DEFAULT_CAPACITY_DEADLINE_MS = 600_000;

/**
 * Runs the fixed create-plan order after the caller has supplied the pinned
 * registry, baseline and HOST capacity port. The plan is returned, not
 * persisted; the composition root writes it inside its own transaction.
 */
export async function createPlan(
  request: CreateTrialPlan,
  deps: CreatePlanRuntimeDeps
): Promise<ConfigResult<TrialPlan>> {
  const needsCapacity = requiresCapacityEvidence(request.factor_input.normalization);
  // Run the pre-capacity stages first so an earlier error never triggers a
  // HOST port call (DD-CFG-145 order). With `capacity_evidence=null`, a
  // window normalizer stops at step 7, which is exactly the port boundary.
  const preflight = validateCreatePlan({
    request,
    registry: deps.registry,
    baseline: deps.baseline,
    capacity_evidence: null
  });
  if (!preflight.ok && !(needsCapacity && preflight.error.code === "E_CFG_CAPACITY_UNVERIFIED")) {
    return fail(preflight.error);
  }

  let capacityEvidence: CapacityEvidence | null = null;
  if (needsCapacity) {
    // DD-CFG-072: exactly one port call with the sealed binding fields.
    const deadlineMs = deps.deadline_ms ?? DEFAULT_CAPACITY_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 600_000) {
      return fail(configError("E_CFG_DEADLINE_EXCEEDED", { details: [{ key: "deadline_ms", value: deadlineMs }] }));
    }
    if (deps.capacity_evidence === null) {
      return fail(configError("E_CFG_CAPACITY_UNVERIFIED"));
    }
    const evidence = await deps.capacity_evidence.get({
      request_id: request.request_id,
      config_space_id: request.config_space_selector.config_space_id,
      capability_binding_key: request.host.capability_binding_key,
      model: request.host.model,
      model_scope_key: deps.registry.model_scope_key,
      deadline_ms: deadlineMs
    });
    if (!evidence.ok) {
      return fail(configError(mapCapacityError(evidence.error.code)));
    }
    capacityEvidence = evidence.value;
  }

  const validated = validateCreatePlan({
    request,
    registry: deps.registry,
    baseline: deps.baseline,
    capacity_evidence: capacityEvidence
  });
  if (!validated.ok) {
    return fail(validated.error);
  }

  const fieldKeys = new Map(validated.value.specs.map((spec) => [spec.field_id, spec.field_key]));
  const normalized = normalize({
    binding: request.factor_input.normalization,
    baseline: deps.baseline.values,
    candidate: request.factor_input.candidate,
    context: [],
    capacity_evidence: capacityEvidence,
    config_space_id: request.config_space_selector.config_space_id,
    field_registry_snapshot_hash: deps.registry.snapshot_hash,
    model_scope_key: deps.registry.model_scope_key,
    field_keys: fieldKeys,
    construction_path: request.host.construction_path
  });
  if (!normalized.ok) {
    return fail(normalized.error);
  }

  const plan = assembleTrialPlan({
    plan_id: deps.plan_id,
    created_at: deps.created_at,
    request,
    registry: deps.registry,
    resolved: validated.value,
    changes: normalized.value.changes,
    formula_input_hash: normalized.value.formula_input_hash,
    capacity_evidence: capacityEvidence,
    patch_preview: deps.patch_preview ?? { write: null, rollback: null },
    baseline: deps.baseline,
    readback_refs: deps.readback_refs
  });
  return succeed(plan);
}

/* ------------------------------------------------------------------ */
/* startTrial (DD-CFG-012, DD-CFG-127, DD-CFG-140)                     */
/* ------------------------------------------------------------------ */

interface StartTrialRuntimeDeps {
  plan: TrialPlan | null;
  /** Config space resolved by the FND root resolver for this start. */
  config_space: ConfigSpaceRef;
  authorization: TrialAuthorization;
  active_trial_exists: boolean;
  held_claim_exists: boolean;
  created_at: number;
  target_values?: ConfigTrial["current_config"]["values"];
  baseline_confirmed?: boolean;
  /** Current values, only compared for `write_and_observe`. */
  current_config_version?: string;
  current_semantic_hash?: Hash;
}

/**
 * Admission order: plan presence, plan/config-space identity, active trial,
 * held claim, then the `write_and_observe` baseline equality. No trial is
 * returned on any failure.
 */
export function startTrial(
  input: StartTrial,
  deps: StartTrialRuntimeDeps
): ConfigResult<ConfigTrial> {
  if (deps.plan === null || deps.plan.plan_id !== input.plan_id) {
    return fail(configError("E_CFG_PLAN_NOT_FOUND", { details: [{ key: "plan_id", value: input.plan_id }] }));
  }
  const plan = deps.plan;
  const spaceMatches =
    plan.config_space_selector.config_space_id === input.config_space_id &&
    deps.config_space.config_space_id === input.config_space_id &&
    plan.config_space_selector.source_layer_set_hash === deps.config_space.source_layer_set_hash &&
    plan.config_space_selector.root_id === deps.config_space.root_id &&
    plan.host.root_id === deps.config_space.root_id;
  if (!spaceMatches) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "config_space" }] }));
  }
  // DD-CFG-058.3: the `capability_binding_key` is compared inside CFG, never
  // by the resolver. A key that differs from the resolved space's binding is
  // `E_CFG_CAPABILITY_UNVERIFIED` and no trial is created.
  const bindingMatches =
    plan.host.capability_binding_key === deps.config_space.host.capability_binding_key &&
    plan.config_space_selector.capability_binding_key === deps.config_space.host.capability_binding_key;
  if (!bindingMatches) {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "capability_binding_key" }] })
    );
  }
  const admission = startTrialAdmissionError({
    active_trial_exists: deps.active_trial_exists,
    held_claim_exists: deps.held_claim_exists
  });
  if (admission !== null) {
    return fail(admission);
  }
  if (input.execution_kind === "write_and_observe") {
    if (
      (deps.current_config_version !== undefined &&
        deps.current_config_version !== plan.baseline_capture.config_version) ||
      (deps.current_semantic_hash !== undefined &&
        deps.current_semantic_hash !== plan.baseline_capture.semantic_hash)
    ) {
      return fail(configError("E_CFG_STALE_BASELINE"));
    }
  }
  const evidenceBasis: ConfigTrial["evidence_basis"] =
    input.execution_kind === "observe_only"
      ? "inherited_candidate"
      : input.execution_kind === "rollback_only"
        ? "rollback_only"
        : "own_write";
  const trial = initialTrial({
    trial_id: input.trial_id,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    config_space: deps.config_space,
    execution_kind: input.execution_kind,
    predecessor_trial_id: input.predecessor_trial_id,
    evidence_basis: evidenceBasis,
    authorization: deps.authorization,
    capability_snapshot_hash: plan.host.capability_snapshot_hash,
    baseline_confirmed: deps.baseline_confirmed ?? true,
    created_at: deps.created_at,
    target_values: deps.target_values ?? []
  });
  return succeed(trial);
}

/* ------------------------------------------------------------------ */
/* recordObservation (DD-CFG-091, DD-CFG-152)                          */
/* ------------------------------------------------------------------ */

interface RecordObservationRuntimeDeps {
  trial: ConfigTrial | null;
  existing_observation: ObservationRecord | null;
  evidence_ref: SourceRef;
  observation_window: ObservationWindowSpec;
  safety_audit: SafetyAuditPort | null;
  audit_request: {
    request_id: string;
    config_space_id: Hash;
    field_registry_snapshot_hash: Hash;
    root_id: string;
    root_identity_pin: RootIdentityPin;
    protected_subtrees: readonly ConfigProtectedSubtree[];
    attempt_refs: readonly { trial_id: Id<"ctr">; sequence: number }[];
    deadline_ms: number;
    signal?: AbortSignal;
  };
}

/**
 * Fast replay runs before the audit; the audit result replaces any
 * caller-supplied `safety_zero` value. An incomplete audit stays `unknown`
 * (value `null`) and never contributes zero. A breach is committed on the
 * observation and moves the trial to `rolling_back`.
 */
export async function recordObservation(
  input: RecordObservation,
  deps: RecordObservationRuntimeDeps
): Promise<ConfigResult<ConfigTrial>> {
  const trial = deps.trial;
  if (trial === null) {
    return fail(configError("E_CFG_TRIAL_NOT_FOUND", { details: [{ key: "trial_id", value: input.trial_id }] }));
  }
  const replay = observationReplayDecision(deps.existing_observation, {
    trial_id: trial.trial_id,
    sample_id: input.sample_id,
    observed_at: input.observed_at,
    trigger: input.trigger,
    telemetry: input.telemetry,
    probe: input.probe,
    guardrails: input.guardrails
  });
  if (replay === "existing") {
    return succeed(trial);
  }
  if (replay === "conflict") {
    return fail(configError("E_CFG_IDEMPOTENCY_CONFLICT", { details: [{ key: "sample_id", value: input.sample_id }] }));
  }

  const window = auditWindow({
    created_at: trial.created_at,
    previous_observed_at: trial.observation.last_sample_at,
    observed_at: input.observed_at,
    scope: "sample_close"
  });
  let guardrails = input.guardrails;
  if (deps.safety_audit !== null) {
    const audit = await deps.safety_audit.audit({
      schema_version: "rsi.safety_audit_request/1",
      ...deps.audit_request,
      trial_id: trial.trial_id,
      sample_id: input.sample_id,
      audit_scope: "sample_close",
      window
    });
    if (!audit.ok) {
      return fail(mapSafetyAuditError(audit.error.code));
    }
    const safety = safetyGuardrailValue({
      complete: audit.value.complete,
      forbidden_event_count: audit.value.forbidden_event_count,
      sample_count: trial.observation.matched_samples + 1,
      evidence_ref: audit.value.evidence_ref,
      min_samples: deps.observation_window.min_matched_samples
    });
    guardrails = [...guardrails.filter((value) => value.guardrail_id !== "safety_zero"), safety];
  }

  const record = buildObservationRecord({
    trial_id: trial.trial_id,
    sample_id: input.sample_id,
    observed_at: input.observed_at,
    trigger: input.trigger,
    telemetry: input.telemetry,
    probe: input.probe,
    guardrails,
    evidence_ref: deps.evidence_ref
  });
  const counted = applyObservationCounters(trial, record);
  if (!hasBreach(guardrails)) {
    return succeed(counted);
  }
  return succeed({
    ...counted,
    phase: "rolling_back",
    rollback: {
      ...counted.rollback,
      state: "pending",
      reason: "guardrail"
    },
    last_error: configError("E_CFG_GUARDRAIL_BREACH")
  });
}
