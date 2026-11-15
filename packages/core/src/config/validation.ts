/**
 * Runtime JSON Schema 2020-12 validation facade (DD-CFG-143).
 *
 * The validators are generated from `schemas/domains/config/**` by
 * `tools/schema-codegen`. TypeScript types never replace the runtime check:
 * every durable, IPC and readback payload is validated at the boundary with
 * the same schema that generated its type.
 *
 * `default` is documentation only; the generated validators never fill it.
 * Unknown top-level fields are rejected by the schemas themselves.
 */

import { validateConfigObservation as generatedConfigObservation } from "../generated/validators/config-observation.js";
import { validateConfigSpaceSnapshot as generatedConfigSpaceSnapshot } from "../generated/validators/config-space-snapshot.js";
import { validateConfigTrial as generatedConfigTrial } from "../generated/validators/config-trial.js";
import { validateTrialAttempt as generatedTrialAttempt } from "../generated/validators/trial-attempt.js";
import { validateTrialPlan as generatedTrialPlan } from "../generated/validators/trial-plan.js";

/** Validates a `ConfigSpaceSnapshot` payload at the boundary. */
export function validateConfigSpaceSnapshot(payload: unknown): boolean {
  return generatedConfigSpaceSnapshot(payload) === true;
}

/** Validates a `TrialPlan /2` payload at the boundary. */
export function validateTrialPlan(payload: unknown): boolean {
  return generatedTrialPlan(payload) === true;
}

/** Validates a `ConfigTrial /1` payload at the boundary. */
export function validateConfigTrial(payload: unknown): boolean {
  return generatedConfigTrial(payload) === true;
}

/** Validates a `TrialAttempt /1` payload at the boundary. */
export function validateTrialAttempt(payload: unknown): boolean {
  return generatedTrialAttempt(payload) === true;
}

/** Validates a `ConfigObservation /1` payload at the boundary. */
export function validateConfigObservation(payload: unknown): boolean {
  return generatedConfigObservation(payload) === true;
}
