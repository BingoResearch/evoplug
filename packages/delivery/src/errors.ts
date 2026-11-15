/**
 * Delivery errors (DD-FND-092).
 *
 * `E_DELIVERY_CONTENT` is the only delivery-owned registry code. CAS failures
 * use the shared `E_STALE_VERSION`; malformed requests and illegal axis
 * transitions use `E_SCHEMA`. No second delivery error vocabulary is invented.
 */

import { makeErrorEnvelope } from "@evoplug/core";
import type { ErrorEnvelope, Id, SourceRef } from "@evoplug/core";

export function deliveryContentError(
  ref: SourceRef,
  reason: "missing" | "hash_mismatch" | "out_of_range",
): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_DELIVERY_CONTENT",
    category: "source",
    message_key: "error.delivery_content",
    stage: "delivery_create",
    details: {
      kind: "source",
      source_ref: ref,
      reason,
    },
  });
}

export function deliveryStaleVersionError(
  deliveryId: Id<"del">,
  expected: number,
  actual: number,
): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STALE_VERSION",
    category: "version",
    message_key: "error.stale_version",
    stage: "delivery_cas",
    details: {
      kind: "version",
      expected: `${String(expected)}@${deliveryId}`,
      actual: String(actual),
    },
  });
}

export function deliverySchemaError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "delivery_schema",
    details: { kind: "field", path, rule },
  });
}
