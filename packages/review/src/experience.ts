/**
 * Experience and ValidationPlan content identity, normalization and version
 * allocation (DD-REV-090, DD-REV-100).
 *
 * Content hash covers 16 semantic fields. Lineage, random IDs, creation time
 * and the supersession cache never enter it.
 */

import {
  canonicalHash,
  canonicalJson,
  compareUtf8,
  toJsonValue
} from "@evoplug/core";
import type { Hash, JsonValue, Result, SourceRef, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ErrorEnvelope } from "@evoplug/core";

import {
  experiencePlanSourceChanged,
  experienceVerifierBinding,
  snapshotInvalid
} from "./errors.js";
import type {
  Experience,
  ExperienceCandidate,
  ExperienceProjection,
  ExperienceRisk,
  ExperienceScope,
  ExperienceType,
  LoadingIncludedState,
  LoadingStageState,
  Proposal,
  ReviewSnapshot,
  ValidationPlan,
  ValidationPlanCandidate
} from "./types.js";

export interface ValidationPlanDefaults {
  readonly window_ms: number;
  readonly min_triggered_uses: number;
  readonly max_triggered_uses: number;
  readonly max_extensions: number;
}

export const VALIDATION_PLAN_DEFAULTS: ValidationPlanDefaults = Object.freeze({
  window_ms: 1_209_600_000,
  min_triggered_uses: 2,
  max_triggered_uses: 20,
  max_extensions: 1
});

export interface ExperienceLimits {
  readonly title_max: number;
  readonly summary_max: number;
  readonly trigger_description_max: number;
  readonly path_patterns_max: number;
  readonly negative_triggers_max: number;
  readonly counterexamples_user_preference_max: number;
}

export const EXPERIENCE_LIMITS: ExperienceLimits = Object.freeze({
  title_max: 200,
  summary_max: 2048,
  trigger_description_max: 1024,
  path_patterns_max: 16,
  negative_triggers_max: 16,
  counterexamples_user_preference_max: 8
});

/* ------------------------------------------------------------------ */
/* Hashes                                                              */
/* ------------------------------------------------------------------ */

export interface ExperienceContentInput {
  type: ExperienceType;
  title: string;
  summary: string;
  trigger: Experience["trigger"];
  scope: ExperienceScope;
  preconditions: Experience["preconditions"];
  steps: Experience["steps"];
  expected_effects: string[];
  completion_check: Experience["completion_check"];
  failure_branches: Experience["failure_branches"];
  counterexamples: Experience["counterexamples"];
  validation_plan_hash: Hash;
  risk: ExperienceRisk;
  expiry_policy: Experience["expiry_policy"];
  evidence_refs: SourceRef[];
}

export function experienceContentHash(experience: ExperienceContentInput): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: "rsi.experience/1",
      type: experience.type,
      title: experience.title,
      summary: experience.summary,
      trigger: experience.trigger,
      scope: experience.scope,
      preconditions: experience.preconditions,
      steps: experience.steps,
      expected_effects: experience.expected_effects,
      completion_check: experience.completion_check,
      failure_branches: experience.failure_branches,
      counterexamples: experience.counterexamples,
      validation_plan_hash: experience.validation_plan_hash,
      risk: experience.risk,
      expiry_policy: experience.expiry_policy,
      evidence_refs: experience.evidence_refs
    })
  );
}

/** Body bytes exclude `body_ref` and `superseded_by_version` only. */
export function experienceBodyValue(experience: Experience): JsonValue {
  const value: JsonValue = toJsonValue({
    schema_version: experience.schema_version,
    experience_id: experience.experience_id,
    version: experience.version,
    lineage: experience.lineage,
    type: experience.type,
    title: experience.title,
    summary: experience.summary,
    trigger: experience.trigger,
    scope: experience.scope,
    preconditions: experience.preconditions,
    steps: experience.steps,
    expected_effects: experience.expected_effects,
    completion_check: experience.completion_check,
    failure_branches: experience.failure_branches,
    counterexamples: experience.counterexamples,
    validation_plan_id: experience.validation_plan_id,
    validation_plan_hash: experience.validation_plan_hash,
    risk: experience.risk,
    expiry_policy: experience.expiry_policy,
    evidence_refs: experience.evidence_refs,
    content_hash: experience.content_hash,
    created_at: experience.created_at
  });
  return value;
}

export function experienceBodyBytes(experience: Experience): Uint8Array {
  return canonicalJson(experienceBodyValue(experience));
}

export function experienceBodyHash(experience: Experience): Hash {
  return canonicalHash(experienceBodyValue(experience));
}

export function validationPlanHash(plan: Omit<ValidationPlan, "validation_plan_id" | "created_at" | "plan_hash">): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: plan.schema_version,
      experience_id: plan.experience_id,
      experience_version: plan.experience_version,
      source_requirement_refs: plan.source_requirement_refs,
      expected_behavior: plan.expected_behavior,
      required_loading_evidence: plan.required_loading_evidence,
      verifier: plan.verifier,
      observation_window: plan.observation_window,
      retention_rule: plan.retention_rule,
      stop_conditions: plan.stop_conditions,
      replay: plan.replay
    })
  );
}

export function adoptionBindingHash(binding: Omit<import("./types.js").AdoptionBinding, "adopted_at" | "binding_hash">): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: binding.schema_version,
      write_id: binding.write_id,
      write_attempt: binding.write_attempt,
      write_result_ref: binding.write_result_ref,
      grant_id: binding.grant_id,
      grant_hash: binding.grant_hash,
      proposal_id: binding.proposal_id,
      proposal_hash: binding.proposal_hash,
      candidate_hash: binding.candidate_hash,
      target: binding.target,
      version_binding: binding.version_binding
    })
  );
}

export function projectionHash(projection: ExperienceProjection): Hash {
  return canonicalHash(toJsonValue(projection));
}

/* ------------------------------------------------------------------ */
/* Type matrix and content validation                                  */
/* ------------------------------------------------------------------ */

export interface TypeRequirements {
  trigger: boolean;
  min_preconditions: number;
  min_steps: number;
  completion_check: boolean;
  min_counterexamples: number;
  max_counterexamples: number | null;
  retention_kind: ValidationPlan["retention_rule"]["kind"];
}

export const TYPE_REQUIREMENTS: Readonly<Record<ExperienceType, TypeRequirements>> = {
  recovery_procedure: {
    trigger: true,
    min_preconditions: 1,
    min_steps: 1,
    completion_check: true,
    min_counterexamples: 1,
    max_counterexamples: null,
    retention_kind: "deterministic_check"
  },
  tool_workflow: {
    trigger: true,
    min_preconditions: 1,
    min_steps: 1,
    completion_check: true,
    min_counterexamples: 1,
    max_counterexamples: null,
    retention_kind: "workflow_evidence"
  },
  project_constraint: {
    trigger: true,
    min_preconditions: 1,
    min_steps: 0,
    completion_check: true,
    min_counterexamples: 1,
    max_counterexamples: null,
    retention_kind: "constraint_recheck"
  },
  user_preference: {
    trigger: true,
    min_preconditions: 0,
    min_steps: 0,
    completion_check: false,
    min_counterexamples: 0,
    max_counterexamples: 8,
    retention_kind: "preference_confirmation"
  },
  validation_check: {
    trigger: true,
    min_preconditions: 1,
    min_steps: 1,
    completion_check: true,
    min_counterexamples: 1,
    max_counterexamples: null,
    retention_kind: "deterministic_check"
  }
};

export function validateExperienceTypeMatrix(experience: Experience): Result<Experience, ErrorEnvelope> {
  const requirements = TYPE_REQUIREMENTS[experience.type];
  if (experience.preconditions.length < requirements.min_preconditions) {
    return err(snapshotInvalid("experience.preconditions", `min_${requirements.min_preconditions}`));
  }
  if (experience.steps.length < requirements.min_steps) {
    return err(snapshotInvalid("experience.steps", `min_${requirements.min_steps}`));
  }
  if (requirements.completion_check && experience.completion_check.kind === "none") {
    return err(snapshotInvalid("experience.completion_check", "required"));
  }
  if (experience.counterexamples.length < requirements.min_counterexamples) {
    return err(snapshotInvalid("experience.counterexamples", `min_${requirements.min_counterexamples}`));
  }
  if (
    requirements.max_counterexamples !== null &&
    experience.counterexamples.length > requirements.max_counterexamples
  ) {
    return err(
      snapshotInvalid("experience.counterexamples", `max_${requirements.max_counterexamples}`)
    );
  }
  // `user_preference` allows zero preconditions, steps and counterexamples
  // individually, but DD-REV-090 still requires a confirmation anchor: a
  // preference with no precondition, step, counterexample or completion check
  // has no observable condition to confirm and is rejected by the matrix.
  if (
    experience.type === "user_preference" &&
    experience.preconditions.length === 0 &&
    experience.steps.length === 0 &&
    experience.counterexamples.length === 0 &&
    experience.completion_check.kind === "none"
  ) {
    return err(snapshotInvalid("experience.content", "preference_requires_anchor"));
  }
  if (experience.title.length < 1 || experience.title.length > EXPERIENCE_LIMITS.title_max) {
    return err(snapshotInvalid("experience.title", "length_1_200"));
  }
  if (experience.summary.length < 1 || experience.summary.length > EXPERIENCE_LIMITS.summary_max) {
    return err(snapshotInvalid("experience.summary", "length_1_2048"));
  }
  if (experience.trigger.description.length < 1 || experience.trigger.description.length > EXPERIENCE_LIMITS.trigger_description_max) {
    return err(snapshotInvalid("experience.trigger.description", "length_1_1024"));
  }
  if (experience.trigger.path_patterns.length > EXPERIENCE_LIMITS.path_patterns_max) {
    return err(snapshotInvalid("experience.trigger.path_patterns", "max_16"));
  }
  if (experience.trigger.negative_triggers.length > EXPERIENCE_LIMITS.negative_triggers_max) {
    return err(snapshotInvalid("experience.trigger.negative_triggers", "max_16"));
  }
  const expected = experienceContentHash(experience);
  if (expected !== experience.content_hash) {
    return err(snapshotInvalid("experience.content_hash", "recomputed"));
  }
  return ok(experience);
}

/* ------------------------------------------------------------------ */
/* Risk, scope and lineage                                             */
/* ------------------------------------------------------------------ */

const RISK_ORDER: Readonly<Record<ExperienceRisk, number>> = { low: 0, medium: 1, high: 2 };

export function maxRisk(left: ExperienceRisk, right: ExperienceRisk): ExperienceRisk {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}

/** Highest risk wins; candidates cannot lower the policy floor. */
export function normalizeRisk(input: {
  type: ExperienceType;
  ownership: Proposal["target"]["ownership"];
  counterexampleCount: number;
  policyFloor: ExperienceRisk;
  restoreFrom?: ExperienceRisk;
}): ExperienceRisk {
  let risk: ExperienceRisk = input.policyFloor;
  if (input.restoreFrom !== undefined) {
    risk = maxRisk(risk, input.restoreFrom);
  }
  if (input.type === "recovery_procedure" || input.type === "validation_check") {
    risk = maxRisk(risk, "medium");
  }
  if (input.ownership === "shared_handwritten") {
    risk = maxRisk(risk, "medium");
  }
  if (input.counterexampleCount >= 3) {
    risk = maxRisk(risk, "high");
  }
  return risk;
}

export interface ScopeDerivationInput {
  snapshot: ReviewSnapshot;
  targetHostId: ExperienceScope["host_ids"][number];
  projectId: string | null;
  attemptEnvironmentFingerprints: string[];
  attemptToolVersionRanges: Array<{ tool: string; range: string }>;
  attemptModelFamilies: string[];
  allowGlobal: boolean;
  requestedLevel?: ExperienceScope["level"];
}

/** Derives scope from the snapshot, target and attempt; never expands it. */
export function deriveExperienceScope(input: ScopeDerivationInput): ExperienceScope {
  const level: ExperienceScope["level"] =
    input.attemptModelFamilies.length > 0 && input.projectId === null
      ? input.allowGlobal
        ? "global"
        : "host"
      : input.projectId !== null
        ? "project"
        : "host";
  const chosen = input.requestedLevel === undefined ? level : narrowerScope(input.requestedLevel, level);
  const scope: ExperienceScope = {
    level: chosen,
    project_ids: [],
    host_ids: [],
    modes: [],
    environment_fingerprints: [...input.attemptEnvironmentFingerprints],
    tool_version_ranges: [...input.attemptToolVersionRanges],
    model_families: [...input.attemptModelFamilies]
  };
  if (chosen === "project" && input.projectId !== null) {
    scope.project_ids = [input.projectId];
  }
  if (chosen === "host" || chosen === "project") {
    scope.host_ids = [input.targetHostId];
    scope.modes = [input.snapshot.host_event.binding.mode];
  }
  if (chosen === "global" && !input.allowGlobal) {
    scope.level = "host";
    scope.host_ids = [input.targetHostId];
    scope.modes = [input.snapshot.host_event.binding.mode];
  }
  return scope;
}

function narrowerScope(
  requested: ExperienceScope["level"],
  derived: ExperienceScope["level"]
): ExperienceScope["level"] {
  const order: Record<ExperienceScope["level"], number> = { project: 4, host: 3, user: 2, global: 1 };
  return order[requested] <= order[derived] ? requested : derived;
}

export interface RefineSource {
  experience: Experience;
  validation_plan: ValidationPlan;
}

export interface LineageDecision {
  kind: "create" | "refine" | "restore";
  predecessor_version?: number;
  restored_from_version?: number;
  source_experience_id?: string;
  source_plan?: ValidationPlan;
}

/** Lineage is derived, never declared by the generator (DD-REV-090). */
export function resolveLineage(
  candidate: ExperienceCandidate,
  planCandidate: ValidationPlanCandidate,
  refines: RefineSource | null,
  sourceIds: { job_id: string; proposal_id: string; snapshot_id: string }
): LineageDecision {
  if (refines === null) {
    return { kind: "create" };
  }
  const source = refines.experience;
  const planSemanticsEqual = validationPlanSemanticsEqual(planCandidate, refines.validation_plan);
  const contentEqual = experienceSemanticsEqual(
    candidate,
    source,
    planCandidate,
    refines.validation_plan
  );
  if (planSemanticsEqual && contentEqual) {
    return {
      kind: "restore",
      restored_from_version: source.version,
      source_experience_id: source.experience_id,
      source_plan: refines.validation_plan
    };
  }
  return {
    kind: "refine",
    predecessor_version: source.version,
    source_experience_id: source.experience_id
  };
}

export function experienceSemanticsEqual(
  candidate: ExperienceCandidate,
  source: Experience,
  planCandidate: ValidationPlanCandidate,
  sourcePlan: ValidationPlan
): boolean {
  if (!validationPlanSemanticsEqual(planCandidate, sourcePlan)) {
    return false;
  }
  return (
    candidate.type === source.type &&
    candidate.title === source.title &&
    canonicalText(triggerSemantics(candidate.trigger)) === canonicalText(triggerSemantics(source.trigger)) &&
    canonicalText(candidate.preconditions) === canonicalText(source.preconditions) &&
    canonicalText(candidate.steps) === canonicalText(source.steps) &&
    canonicalText(candidate.expected_effects) === canonicalText(source.expected_effects) &&
    canonicalText(candidate.completion_check) === canonicalText(source.completion_check) &&
    canonicalText(candidate.failure_branches) === canonicalText(source.failure_branches) &&
    canonicalText(candidate.counterexamples) === canonicalText(source.counterexamples) &&
    canonicalText(candidate.expiry_policy) === canonicalText(source.expiry_policy) &&
    canonicalText(candidate.evidence_refs) === canonicalText(source.evidence_refs)
  );
}

/** Trigger matching keys; the free-text description is presentation only. */
function triggerSemantics(
  trigger: ExperienceCandidate["trigger"]
): Omit<ExperienceCandidate["trigger"], "description"> {
  return {
    signal_kinds: trigger.signal_kinds,
    task_family_ids: trigger.task_family_ids,
    tool_names: trigger.tool_names,
    path_patterns: trigger.path_patterns,
    negative_triggers: trigger.negative_triggers
  };
}

function canonicalText(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

export function validationPlanSemanticsEqual(
  candidate: ValidationPlanCandidate,
  source: ValidationPlan
): boolean {
  return (
    candidate.expected_behavior === source.expected_behavior &&
    canonicalText(candidate.required_loading_evidence) === canonicalText(source.required_loading_evidence) &&
    candidate.verifier.description === source.verifier.description &&
    canonicalText(candidate.observation_window) === canonicalText(source.observation_window) &&
    canonicalText(candidate.retention_rule) === canonicalText(source.retention_rule) &&
    canonicalText(candidate.stop_conditions) === canonicalText(source.stop_conditions) &&
    canonicalText(candidate.replay) === canonicalText(source.replay)
  );
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

export function nextExperienceVersion(existingVersions: readonly number[]): number {
  if (existingVersions.length === 0) {
    return 1;
  }
  return Math.max(...existingVersions) + 1;
}

export interface VersionAllocation {
  experience_id: string;
  version: number;
}

/** Allocates versions in candidate ordinal order; earlier values join `max`. */
export function allocateExperienceVersions(
  candidates: ReadonlyArray<{ ordinal: number; experience_id: string; existing_versions: readonly number[] }>
): VersionAllocation[] {
  const ordered = [...candidates].sort((left, right) => left.ordinal - right.ordinal);
  const prior = new Map<string, number>();
  const result: VersionAllocation[] = [];
  for (const candidate of ordered) {
    const version = allocateNextVersion(candidate.experience_id, candidate.existing_versions, prior);
    prior.set(candidate.experience_id, version);
    result.push({ experience_id: candidate.experience_id, version });
  }
  return result;
}

/** One version at a time, in ordinal order; returns the assigned number. */
export function allocateNextVersion(
  experienceId: string,
  existingVersions: readonly number[],
  priorAssignments: ReadonlyMap<string, number>
): number {
  const previous = priorAssignments.get(experienceId);
  if (previous !== undefined) {
    return previous + 1;
  }
  return nextExperienceVersion(existingVersions);
}

/**
 * 0 or 1 cache transition for an adoption (DD-REV-090). `cache` maps each
 * adopted version to its current `superseded_by_version`.
 */
export interface CacheTransition {
  version: number;
  from: number | null;
  to: number;
}

export function experienceCacheTransition(
  adoptedVersions: readonly number[],
  cache: ReadonlyMap<number, number | null>,
  newVersion: number
): CacheTransition | null {
  if (adoptedVersions.length === 0) {
    return null;
  }
  const currentMax = Math.max(...adoptedVersions);
  if (newVersion > currentMax) {
    const current = cache.get(currentMax) ?? null;
    if (current === null) {
      return { version: currentMax, from: null, to: newVersion };
    }
    return null;
  }
  if (newVersion < currentMax) {
    const current = cache.get(newVersion) ?? null;
    if (current === null) {
      return { version: newVersion, from: null, to: currentMax };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* ValidationPlan                                                      */
/* ------------------------------------------------------------------ */

export interface BuildValidationPlanInput {
  candidate: ValidationPlanCandidate;
  validation_plan_id: string;
  experience_id: string;
  experience_version: number;
  source_requirement_refs: ValidationPlan["source_requirement_refs"];
  verifier: ValidationPlan["verifier"];
  now: number;
}

export function defaultObservationWindow(candidate: ValidationPlanCandidate): ValidationPlan["observation_window"] {
  return {
    window_ms: candidate.observation_window.window_ms,
    min_triggered_uses: candidate.observation_window.min_triggered_uses,
    max_triggered_uses: candidate.observation_window.max_triggered_uses,
    max_extensions: candidate.observation_window.max_extensions
  };
}

export function buildValidationPlan(input: BuildValidationPlanInput): ValidationPlan {
  const base: Omit<ValidationPlan, "plan_hash"> = {
    schema_version: "rsi.validation_plan/1",
    validation_plan_id: input.validation_plan_id,
    experience_id: input.experience_id,
    experience_version: input.experience_version,
    source_requirement_refs: [...input.source_requirement_refs].sort((left, right) =>
      compareUtf8(`${left.requirement_id}\u0000${String(left.version)}`, `${right.requirement_id}\u0000${String(right.version)}`)
    ),
    expected_behavior: input.candidate.expected_behavior,
    required_loading_evidence: [...input.candidate.required_loading_evidence],
    verifier: input.verifier,
    observation_window: defaultObservationWindow(input.candidate),
    retention_rule: {
      rule_id: input.candidate.retention_rule.rule_id,
      kind: input.candidate.retention_rule.kind,
      min_independent_passes: input.candidate.retention_rule.min_independent_passes,
      required_verifier_kinds: [...input.candidate.retention_rule.required_verifier_kinds],
      max_age_ms: input.candidate.retention_rule.max_age_ms
    },
    stop_conditions: [...input.candidate.stop_conditions],
    replay: {
      requirement: input.candidate.replay.requirement,
      allowed_classes: [...input.candidate.replay.allowed_classes],
      live_external_policy: input.candidate.replay.live_external_policy
    },
    created_at: input.now
  };
  return { ...base, plan_hash: validationPlanHash(base) };
}

export function validateValidationPlan(plan: ValidationPlan): Result<ValidationPlan, ErrorEnvelope> {
  if (plan.expected_behavior.length < 1) {
    return err(snapshotInvalid("validation_plan.expected_behavior", "non_empty"));
  }
  const window = plan.observation_window;
  if (!Number.isSafeInteger(window.window_ms) || window.window_ms < 1 || window.window_ms > 2_592_000_000) {
    return err(snapshotInvalid("validation_plan.observation_window.window_ms", "range_1_2592000000"));
  }
  if (!Number.isSafeInteger(window.min_triggered_uses) || window.min_triggered_uses < 1 || window.min_triggered_uses > 100) {
    return err(snapshotInvalid("validation_plan.observation_window.min_triggered_uses", "range_1_100"));
  }
  if (!Number.isSafeInteger(window.max_triggered_uses) || window.max_triggered_uses < window.min_triggered_uses) {
    return err(snapshotInvalid("validation_plan.observation_window.max_triggered_uses", "gte_min"));
  }
  if (!Number.isSafeInteger(window.max_extensions) || window.max_extensions < 0 || window.max_extensions > 3) {
    return err(snapshotInvalid("validation_plan.observation_window.max_extensions", "range_0_3"));
  }
  if (!Number.isSafeInteger(plan.retention_rule.min_independent_passes) || plan.retention_rule.min_independent_passes < 1 || plan.retention_rule.min_independent_passes > 20) {
    return err(snapshotInvalid("validation_plan.retention_rule.min_independent_passes", "range_1_20"));
  }
  if (!Number.isSafeInteger(plan.retention_rule.max_age_ms) || plan.retention_rule.max_age_ms < 1 || plan.retention_rule.max_age_ms > 31_536_000_000) {
    return err(snapshotInvalid("validation_plan.retention_rule.max_age_ms", "range_1_31536000000"));
  }
  if (plan.verifier.kind === "none") {
    if (plan.verifier.verifier_ref !== undefined || plan.verifier.binding_ref !== undefined) {
      return err(snapshotInvalid("validation_plan.verifier", "none_has_no_ref"));
    }
  } else if (plan.verifier.verifier_ref === undefined || plan.verifier.binding_ref === undefined) {
    return err(experienceVerifierBinding("binding_ref", "required"));
  }
  const expected = validationPlanHash(plan);
  if (expected !== plan.plan_hash) {
    return err(snapshotInvalid("validation_plan.plan_hash", "recomputed"));
  }
  return ok(plan);
}

/** S7a: plan requirements must be an exact subset of the snapshot's. */
export function validatePlanSourceRefs(
  plan: ValidationPlan,
  snapshot: ReviewSnapshot
): Result<ValidationPlan, ErrorEnvelope> {
  const frozen = new Map<string, number>();
  for (const requirement of snapshot.requirements) {
    frozen.set(requirement.requirement_id, requirement.version);
  }
  for (const source of plan.source_requirement_refs) {
    const version = frozen.get(source.requirement_id);
    if (version === undefined || version !== source.version) {
      return err(experiencePlanSourceChanged(source.source_ref, "missing"));
    }
  }
  return ok(plan);
}

export function planHasNoVerifier(plan: ValidationPlan): boolean {
  return plan.verifier.kind === "none";
}

/** Loading-evidence lower bound per required stage (DD-REV-100). */
export function loadingStageSatisfied(
  stage: "written" | "discovered" | "included" | "observed",
  loading: {
    written: LoadingStageState;
    discovered: LoadingStageState;
    included: LoadingIncludedState;
    observed: "unknown" | "claimed" | "verified";
  }
): boolean {
  switch (stage) {
    case "written":
      return loading.written === "verified";
    case "discovered":
      return loading.discovered === "verified";
    case "included":
      return (
        loading.included === "provider_payload" ||
        loading.included === "transport_body" ||
        loading.included === "verified"
      );
    case "observed":
      return loading.observed === "verified";
  }
}

export function hasBehavioralLoadingEvidence(loading: {
  written: LoadingStageState;
  discovered: LoadingStageState;
  included: LoadingIncludedState;
  observed: "unknown" | "claimed" | "verified";
}): boolean {
  const included =
    loading.included === "provider_payload" ||
    loading.included === "transport_body" ||
    loading.included === "verified";
  return included && loading.observed !== "unknown";
}

/** Restore reuses the source plan identity and hash unchanged. */
export function restoredPlanProjection(source: ValidationPlan): ValidationPlan {
  return { ...source };
}

export function planExpiryAt(plan: ValidationPlan, from: number): number {
  return from + plan.retention_rule.max_age_ms;
}

/** `content_hash` for an Experience built from a validated plan. */
export function computeExperienceContentHash(experience: Experience): Hash {
  return experienceContentHash(experience);
}

export function sameExperienceVersion(experience: Experience, version: number): boolean {
  return experience.version === version;
}

export function planMatchesHash(plan: ValidationPlan, hash: Hash): boolean {
  return plan.plan_hash === hash;
}

export function projectionVersionBinding(projection: ExperienceProjection): VersionBinding {
  return projection.adoption_binding.version_binding;
}
