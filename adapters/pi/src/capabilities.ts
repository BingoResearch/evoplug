/**
 * Pi capability declarations (DD-HOST-001 descriptor validation, DD-CAP-003).
 *
 * `declared_capabilities` is a manifest statement about the adapter surface,
 * not capability evidence. Pi currently has no `product_adapter` roundtrip
 * probe, so every capability status stays `unknown`; the probe in this package
 * only raises `evidence_stage` to `static` for capabilities the adapter
 * statically handles.
 *
 * `generation.service_profile` is HOST-reserved and is never declared or
 * probed by an adapter (DD-CAP-004).
 */

import {
  CAPABILITY_NAMES,
  hasStaticAdapterEvidence as hasSharedStaticEvidence
} from "@evoplug/adapter-kit";

import type { CapabilityName } from "./contract.js";

export { HOST_RESERVED_CAPABILITY, isCapabilityName } from "@evoplug/adapter-kit";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const PI_CAPABILITY_NAMES: readonly CapabilityName[] = CAPABILITY_NAMES;

/**
 * Capabilities this adapter handles statically.
 *
 * Pi's host section records `input_capture` and `online_delivery` as verified
 * `host_contract` facts for print mode. For `subject=product_adapter` none of
 * these names is verified yet; they are declarations only.
 */
export const PI_DECLARED_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "compaction_event",
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "request_observation",
  "tool_id"
]);

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return hasSharedStaticEvidence(name, PI_DECLARED_CAPABILITIES);
}
