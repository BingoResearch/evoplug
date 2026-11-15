/**
 * Signal detectors (DD-TRG-009).
 *
 * Detectors are pure: callers supply already-verified observations with
 * retrievable evidence refs. Model text alone can never become a signal.
 */

import type { VerifiedSignal } from "../types.js";
import { sortedUnique } from "../validation.js";

export interface CorrectionObservation {
  message_id: string;
  issue_id: string;
  requirement_ids: readonly string[];
  /** The message is a genuine user correction, not a model restatement. */
  user_correction: boolean;
  /** Independent of the previous observation (distinct source). */
  independent: boolean;
  /** An independent verification closed the issue/requirement. */
  verified_closed: boolean;
  evidence_ref: string;
  observed_at: number;
}

/**
 * `repeated_correction`: at least two independent user corrections on the same
 * issue/requirement, with no independent verification closure in between.
 */
export function detectRepeatedCorrection(
  observations: readonly CorrectionObservation[],
  policy: { min_distinct_events: number; window_ms: number }
): VerifiedSignal | null {
  const corrections = observations
    .filter((observation) => observation.user_correction && observation.independent)
    .slice()
    .sort((left, right) => left.observed_at - right.observed_at);
  for (let index = 0; index < corrections.length; index += 1) {
    const seed = corrections[index];
    if (seed === undefined) {
      continue;
    }
    const windowEnd = seed.observed_at + policy.window_ms;
    const group: CorrectionObservation[] = [];
    for (let cursor = index; cursor < corrections.length; cursor += 1) {
      const observation = corrections[cursor];
      if (observation === undefined || observation.observed_at > windowEnd) {
        break;
      }
      if (observation.issue_id !== seed.issue_id) {
        continue;
      }
      const sharedRequirement = observation.requirement_ids.some((id) => seed.requirement_ids.includes(id));
      if (!sharedRequirement) {
        continue;
      }
      if (observation.verified_closed) {
        break;
      }
      group.push(observation);
    }
    const distinctMessages = new Set(group.map((observation) => observation.message_id));
    if (distinctMessages.size >= policy.min_distinct_events) {
      const evidenceRefs = sortedUnique(group.map((observation) => observation.evidence_ref));
      const requirementIds = sortedUnique(group.flatMap((observation) => Array.from(observation.requirement_ids)));
      return {
        type: "repeated_correction",
        strength: "verified",
        detector_version: "sigdet/1",
        evidence_refs: evidenceRefs,
        issue_ids: [seed.issue_id],
        requirement_ids: requirementIds,
        detected_at: Math.max(...group.map((observation) => observation.observed_at))
      };
    }
  }
  return null;
}

export interface FailureObservation {
  run_id: string;
  verifier: string;
  failure_code: string;
  subject_hash: string;
  subject_lineage: string;
  evidence_ref: string;
  observed_at: number;
  independent: boolean;
}

/**
 * `reproducible_error`: at least two independent failures with the same
 * verifier/failure_code/subject_lineage, and at least one failure after the
 * last subject change.
 */
export function detectReproducibleError(
  observations: readonly FailureObservation[],
  policy: { min_independent_runs: number; same_failure_signature: true }
): VerifiedSignal | null {
  const failures = observations
    .filter((observation) => observation.independent)
    .slice()
    .sort((left, right) => left.observed_at - right.observed_at);
  const groups = new Map<string, FailureObservation[]>();
  for (const failure of failures) {
    const key = `${failure.verifier}\u0000${failure.failure_code}\u0000${failure.subject_lineage}`;
    const group = groups.get(key) ?? [];
    group.push(failure);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const distinctRuns = new Set(group.map((failure) => failure.run_id));
    if (distinctRuns.size < policy.min_independent_runs) {
      continue;
    }
    return {
      type: "reproducible_error",
      strength: "verified",
      detector_version: "sigdet/1",
      evidence_refs: sortedUnique(group.map((failure) => failure.evidence_ref)),
      issue_ids: [],
      requirement_ids: [],
      detected_at: Math.max(...group.map((failure) => failure.observed_at))
    };
  }
  return null;
}

export interface RecoveryObservation {
  run_id: string;
  verifier: string;
  outcome: "failed" | "passed";
  subject_hash: string;
  evidence_ref: string;
  observed_at: number;
}

/**
 * `stable_recovery`: H1 verified failure, switch to H2, then two consecutive
 * verified passes from the same verifier with no intermediate failure.
 */
export function detectStableRecovery(
  observations: readonly RecoveryObservation[],
  policy: { verified_failure_required: true; min_consecutive_passes: number }
): VerifiedSignal | null {
  const ordered = observations.slice().sort((left, right) => left.observed_at - right.observed_at);
  for (let index = 0; index < ordered.length; index += 1) {
    const failure = ordered[index];
    if (failure === undefined || failure.outcome !== "failed") {
      continue;
    }
    const recoverySubject = ordered[index + 1]?.subject_hash;
    if (recoverySubject === undefined || recoverySubject === failure.subject_hash) {
      continue;
    }
    const passes: RecoveryObservation[] = [];
    let broken = false;
    for (let cursor = index + 1; cursor < ordered.length; cursor += 1) {
      const observation = ordered[cursor];
      if (observation === undefined) {
        break;
      }
      if (observation.subject_hash !== recoverySubject) {
        break;
      }
      if (observation.outcome === "failed") {
        broken = true;
        break;
      }
      if (observation.verifier !== failure.verifier) {
        broken = true;
        break;
      }
      passes.push(observation);
      if (passes.length >= policy.min_consecutive_passes) {
        break;
      }
    }
    if (broken || passes.length < policy.min_consecutive_passes) {
      continue;
    }
    return {
      type: "stable_recovery",
      strength: "verified",
      detector_version: "sigdet/1",
      evidence_refs: sortedUnique([failure, ...passes].map((observation) => observation.evidence_ref)),
      issue_ids: [],
      requirement_ids: [],
      detected_at: Math.max(...passes.map((observation) => observation.observed_at))
    };
  }
  return null;
}

export interface CompletionClaimObservation {
  claim_ref: string;
  issue_id?: string;
  requirement_ids: readonly string[];
  observed_at: number;
}

/**
 * `completion_claim` is recorded at claim strength only and can never be used
 * as an automatic trigger on its own.
 */
export function detectCompletionClaim(observation: CompletionClaimObservation): VerifiedSignal {
  return {
    type: "completion_claim",
    strength: "claim",
    detector_version: "sigdet/1",
    evidence_refs: [observation.claim_ref],
    issue_ids: observation.issue_id === undefined ? [] : [observation.issue_id],
    requirement_ids: sortedUnique(Array.from(observation.requirement_ids)),
    detected_at: observation.observed_at
  };
}

/** `user_request` records explicit intent; it is never an automatic signal. */
export function detectUserRequest(input: {
  request_ref: string;
  requirement_ids: readonly string[];
  observed_at: number;
}): VerifiedSignal {
  return {
    type: "user_request",
    strength: "verified",
    detector_version: "sigdet/1",
    evidence_refs: [input.request_ref],
    issue_ids: [],
    requirement_ids: sortedUnique(Array.from(input.requirement_ids)),
    detected_at: input.observed_at
  };
}

/** True when at least one non-claim verified signal is present. */
export function hasVerifiedAutoSignal(signals: readonly VerifiedSignal[]): boolean {
  return signals.some(
    (signal) =>
      signal.strength === "verified" && signal.type !== "completion_claim" && signal.type !== "user_request"
  );
}

/** True when the only signal is `completion_claim`. */
export function isCompletionClaimOnly(signals: readonly VerifiedSignal[]): boolean {
  return signals.length > 0 && signals.every((signal) => signal.type === "completion_claim");
}

/** Restricts a signal set to the policy's automatic `min_signals`. */
export function filterAutoSignals(
  signals: readonly VerifiedSignal[],
  minSignals: readonly VerifiedSignal["type"][]
): VerifiedSignal[] {
  return signals.filter((signal) => signal.strength === "verified" && minSignals.includes(signal.type));
}
