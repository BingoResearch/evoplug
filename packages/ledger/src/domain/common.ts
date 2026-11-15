import type { Id, SourceRef } from "@evoplug/core";

/**
 * `user` only means a host-declared user role; it is never a verified human.
 * `human` is the only origin that can authorize requirement changes.
 */
export type Origin = "human" | "user" | "agent" | "evaluator" | "system" | "host" | "unknown";

export type OriginBasis =
  | "host_typed_field"
  | "host_capability"
  | "explicit_event"
  | "inferred_from_agent"
  | "unavailable";

export type HumanAttestationKind =
  | "host_verified_interactive_user"
  | "control_plane_explicit_confirmation";

export interface HumanAttestation {
  readonly kind: HumanAttestationKind;
  /** Must be a capability the HOST has verified as `human_interaction_attested`. */
  readonly capability_id: string;
  readonly evidence_ref: SourceRef;
  readonly confirmed_at: number;
}

/** Trigger suppression depends only on this axis, never on origin or epoch. */
export type TriggerAxis = "external" | "internal_evaluator" | "internal_review" | "unknown";

export interface TriggerLineage {
  readonly axis: TriggerAxis;
  /** Non-null for `internal_*`; must be null for `external`/`unknown`. */
  readonly root_event_id: Id<"ev"> | null;
  /** 0 for `external`/`unknown`, >= 1 for `internal_*`. */
  readonly depth: number;
}

/** Task lifecycle axis (DD-FND-034). Kept separate from delivery and truth state. */
export type TaskOutcome =
  | "active"
  | "paused"
  | "cancelled"
  | "ended_unverified"
  | "succeeded"
  | "failed";

/** Fact truth axis; `stale` is a separate flag on the fact row. */
export type TruthState = "claim" | "observed" | "verified" | "contradicted" | "unknown";

export type DirectiveStrength = "explicit" | "ambiguous";

export type RequirementOpKind = "add" | "clarify" | "supersede" | "retract" | "confirm";

export type RequirementOpStatus = "applied" | "proposed" | "conflict" | "rejected";
