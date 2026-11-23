/**
 * Human proof types consumed by egress and replay.
 *
 * DD-FND-070 owns these declarations. `@evoplug/core` does not currently
 * export them from its package root (the generated modules are namespaced), so
 * this module carries the exact structural contract until the core owner
 * publishes the canonical export. When that lands, replace this file with a
 * type-only re-export; no field may change.
 */

import { err, ok, parseSourceRef } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Result, SourceRef } from "@evoplug/core";

import { egressSchemaError } from "./errors.js";

export type HumanAttestationKind =
  | "host_verified_interactive_user"
  | "control_plane_explicit_confirmation";

/** Verified proof that a control-plane action was confirmed by a human. */
export interface HumanAttestation {
  kind: HumanAttestationKind;
  /** HOST capability verified as `human_interaction_attested`. */
  capability_id: string;
  evidence_ref: SourceRef;
  confirmed_at: number;
}

export type HumanProofVerdict = "verified" | "unverified" | "conflict";

export type HumanProofPurpose =
  | "replay_approve"
  | "replay_revoke"
  | "replay_reject"
  | "replay_reconcile"
  | "egress_approve"
  | "grant_issue"
  | "grant_revoke"
  | "adapter_install";

/** Port implemented by HOST; FND consumes only the `verified` verdict. */
export interface OriginProofPort {
  verifyHuman(input: {
    attestation: HumanAttestation;
    host_id: string;
    config_space: string;
    native_session_id: string;
    event_key: Hash;
  }): Promise<HumanProofVerdict>;
  verifyControlPlane(input: {
    attestation: HumanAttestation;
    subject_hash: Hash;
    purpose: HumanProofPurpose;
  }): Promise<HumanProofVerdict>;
}

/** Parses a `HumanAttestation` at a control-plane approval boundary. */
export function parseHumanAttestation(
  value: unknown,
): Result<HumanAttestation, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("human_attestation", "object"));
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const capabilityId = record["capability_id"];
  const evidenceRef = record["evidence_ref"];
  const confirmedAt = record["confirmed_at"];
  if (
    kind !== "control_plane_explicit_confirmation" &&
    kind !== "host_verified_interactive_user"
  ) {
    return err(egressSchemaError("human_attestation.kind", "attestation_kind"));
  }
  if (typeof capabilityId !== "string" || capabilityId.length === 0) {
    return err(egressSchemaError("human_attestation.capability_id", "non_empty_string"));
  }
  if (typeof evidenceRef !== "string") {
    return err(egressSchemaError("human_attestation.evidence_ref", "source_ref"));
  }
  const parsedEvidence = parseSourceRef(evidenceRef);
  if (!parsedEvidence.ok) {
    return parsedEvidence;
  }
  if (
    typeof confirmedAt !== "number" ||
    !Number.isSafeInteger(confirmedAt) ||
    confirmedAt < 0
  ) {
    return err(egressSchemaError("human_attestation.confirmed_at", "epoch_ms"));
  }
  return ok({
    kind,
    capability_id: capabilityId,
    evidence_ref: parsedEvidence.value.source_ref,
    confirmed_at: confirmedAt,
  });
}
