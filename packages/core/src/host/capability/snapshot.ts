/**
 * CapabilitySnapshotPort and the canonical `capability_snapshot_hash`
 * (DD-CAP-008).
 *
 * A snapshot covers only current `subject="product_adapter"` records. The
 * bytes are content addressed; `get` never returns live aggregates and always
 * recomputes the stored content before reporting `found`.
 */

import { canonicalHash } from "../../hash.js";
import type { Hash } from "../../hash.js";
import { toJsonValue } from "../../json.js";
import type { JsonValue } from "../../json.js";





import type { CapabilityRecord } from "../types.js";

/** Canonical snapshot preimage (DD-CAP-008). */
export function capabilitySnapshotPreimage(records: readonly CapabilityRecord[]): JsonValue {
  const product = records.filter((record) => record.binding.subject === "product_adapter");
  const bindingKeys = Array.from(new Set(product.map((record) => record.binding_key))).sort();
  const sorted = product.slice().sort((left, right) => {
    if (left.binding_key !== right.binding_key) {
      return left.binding_key < right.binding_key ? -1 : 1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return {
    schema_version: "rsi.capability_snapshot/1",
    subject: "product_adapter",
    binding_keys: bindingKeys,
    records: sorted.map<JsonValue>((record) => ({
      binding_key: record.binding_key,
      name: record.name,
      status: record.status,
      evidence_stage: record.evidence_stage,
      details: toJsonValue(record.details),
      evidence_refs: Array.from(new Set(record.evidence_refs)).sort(),
      probe_ref: record.probe_ref ?? null,
      probe_result: record.probe_result ?? null,
      blocker_code: record.blocker_code ?? null,
      failure_code: record.failure_code ?? null,
      checked_at: record.checked_at,
      verified_at: record.verified_at ?? null
    }))
  };
}

export function computeCapabilitySnapshotHash(records: readonly CapabilityRecord[]): Hash {
  return canonicalHash(capabilitySnapshotPreimage(records));
}

