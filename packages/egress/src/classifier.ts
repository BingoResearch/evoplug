/**
 * `egress_classifier/1`: frozen local classification rules (DD-FND-093.1).
 *
 * Classification is derived only from the exact-range bytes plus the
 * `rsi.egress_provenance/1` tuple. Caller labels, filenames and model-declared
 * classes are never consulted. Insufficient, conflicting or multi-owner
 * provenance yields `null` (unknown) rather than a fallback to `public`.
 * Secret detection runs before any positive classification.
 */

import { canonicalHash, compareUtf8 } from "@evoplug/core";
import type { Hash, JsonValue, SourceRef } from "@evoplug/core";

import type { DataClass } from "./types.js";

export const EGRESS_CLASSIFIER_VERSION: "egress_classifier/1" = "egress_classifier/1";

export const EGRESS_PROVENANCE_SCHEMA_VERSION: "rsi.egress_provenance/1" =
  "rsi.egress_provenance/1";

export type EgressProvenanceOrigin =
  | "human"
  | "user"
  | "agent"
  | "evaluator"
  | "system"
  | "host"
  | "unknown";

export type EgressProvenanceOriginBasis =
  | "host_typed_field"
  | "host_capability"
  | "explicit_event"
  | "inferred_from_agent"
  | "unavailable";

export interface EgressBlobOwner {
  owner_type: string;
  owner_id: string;
}

/** Immutable SQLite provenance tuple used by the classifier and its digest. */
export interface EgressProvenance {
  source_kind: "evidence" | "experience";
  ref: SourceRef;
  event_id: string | null;
  origin: EgressProvenanceOrigin | null;
  origin_basis: EgressProvenanceOriginBasis | null;
  human_attestation_hash: Hash | null;
  content_ref: SourceRef | null;
  content_hash: Hash | null;
  /** Full owner set, sorted by `(owner_type, owner_id)` UTF-8. */
  blob_owners: EgressBlobOwner[];
}

/**
 * `provenance_digest = sha256(JCS({schema_version:"rsi.egress_provenance/1",
 * source_kind,ref,event_id,origin,origin_basis,human_attestation_hash,
 * content_ref,content_hash,blob_owners}))`.
 *
 * `blob_owners` is sorted by `(owner_type, owner_id)` UTF-8; missing address
 * objects or event rows use JSON `null`, never a synthesized value.
 */
export function computeEgressProvenanceDigest(provenance: EgressProvenance): Hash {
  const owners = [...provenance.blob_owners];
  owners.sort((left, right) => {
    const byType = compareUtf8(left.owner_type, right.owner_type);
    if (byType !== 0) {
      return byType;
    }
    return compareUtf8(left.owner_id, right.owner_id);
  });
  const preimage: JsonValue = {
    schema_version: EGRESS_PROVENANCE_SCHEMA_VERSION,
    source_kind: provenance.source_kind,
    ref: provenance.ref,
    event_id: provenance.event_id,
    origin: provenance.origin,
    origin_basis: provenance.origin_basis,
    human_attestation_hash: provenance.human_attestation_hash,
    content_ref: provenance.content_ref,
    content_hash: provenance.content_hash,
    blob_owners: owners.map((owner) => ({
      owner_type: owner.owner_type,
      owner_id: owner.owner_id,
    })),
  };
  return canonicalHash(preimage);
}

/** Secret owner kinds; a credential-owned blob is never forwarded. */
const SECRET_OWNER_TYPES: ReadonlySet<string> = new Set([
  "credential",
  "credential_ref",
  "secret",
]);

/**
 * Classifies one source from its immutable provenance.
 *
 * Rules (frozen):
 * 1. unretrievable (`content_hash=null`) or provenance owner set with anything
 *    other than exactly one owner → `null`;
 * 2. any secret owner type → `secret`;
 * 3. `human` without a verified attestation hash → `null`;
 * 4. `human`/`user` → `user_text`;
 * 5. `agent`/`evaluator` → `tool_output`;
 * 6. `system`/`host` → `tool_output`;
 * 7. missing or `unknown` origin, or `origin_basis="unavailable"` → `null`.
 */
export function classifyEgressSource(
  retrievable: boolean,
  provenance: EgressProvenance,
): DataClass | null {
  if (!retrievable || provenance.content_hash === null) {
    return null;
  }
  if (provenance.blob_owners.length !== 1) {
    return null;
  }
  const owner = provenance.blob_owners[0];
  if (owner !== undefined && SECRET_OWNER_TYPES.has(owner.owner_type)) {
    return "secret";
  }
  if (provenance.origin_basis === "unavailable") {
    return null;
  }
  switch (provenance.origin) {
    case "human":
      if (provenance.human_attestation_hash === null) {
        return null;
      }
      return "user_text";
    case "user":
      return "user_text";
    case "agent":
    case "evaluator":
      return "tool_output";
    case "system":
    case "host":
      return "tool_output";
    case "unknown":
    case null:
      return null;
    default:
      return null;
  }
}
