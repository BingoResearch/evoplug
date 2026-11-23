/**
 * Requirement origin truth table (DD-FND-051, DD-FND-071).
 *
 * Only a human event with a verified attestation and explicit directive
 * strength can produce an applied requirement op. Every other origin is
 * proposed at most; an unknown origin additionally yields an
 * `UnverifiedConstraint`. The predicate is pure: proof verification itself is
 * performed by `OriginProofPort` before this decision.
 */

import type { DirectiveStrength, Origin } from "../domain/common.js";

/** Result of verifying the source event's human attestation. */
export type OriginProofVerdict = "verified" | "unverified" | "conflict";

export type RequirementOriginRejectionCode =
  | "E_EVENT_ORIGIN_UNVERIFIED"
  | "E_EVENT_ORIGIN_CONFLICT";

export type RequirementOriginDecision =
  | {
      readonly status: "applied";
      readonly create_unverified_constraint: false;
    }
  | {
      readonly status: "proposed";
      readonly create_unverified_constraint: boolean;
    }
  | {
      readonly status: "rejected";
      readonly error_code: RequirementOriginRejectionCode;
    };

export interface RequirementOriginInput {
  readonly origin: Origin;
  readonly directive_strength: DirectiveStrength;
  /** True when the source event carries a `HumanAttestation`. */
  readonly human_attestation_present: boolean;
  /** Verdict returned by `OriginProofPort.verifyHuman` for the source event. */
  readonly proof: OriginProofVerdict;
}

/**
 * Maps origin, attestation and directive strength to the only legal outcome.
 *
 * A `human` origin without a present, verified attestation is rejected rather
 * than downgraded to `unknown`; a conflict is reported separately so callers
 * never collapse the two failure modes.
 */
export function decideRequirementOrigin(
  input: RequirementOriginInput
): RequirementOriginDecision {
  if (input.origin === "human") {
    if (input.proof === "conflict") {
      return { status: "rejected", error_code: "E_EVENT_ORIGIN_CONFLICT" };
    }
    if (!input.human_attestation_present || input.proof !== "verified") {
      return { status: "rejected", error_code: "E_EVENT_ORIGIN_UNVERIFIED" };
    }
    if (input.directive_strength === "explicit") {
      return { status: "applied", create_unverified_constraint: false };
    }
    return { status: "proposed", create_unverified_constraint: false };
  }
  return {
    status: "proposed",
    create_unverified_constraint: input.origin === "unknown",
  };
}
