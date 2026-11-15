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

import type { CapabilityName } from "./contract.js";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const PI_CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
  "association",
  "capacity_window",
  "compaction_event",
  "generation.auth",
  "generation.cancel",
  "generation.create",
  "generation.output",
  "generation.recover",
  "generation.service_profile",
  "host_budget",
  "human_interaction_attested",
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "request_observation",
  "source_trust",
  "stable_boundary",
  "sync_wait",
  "tool_id"
]);

/** HOST-reserved capability that an adapter must not declare or probe. */
export const HOST_RESERVED_CAPABILITY: CapabilityName = "generation.service_profile";

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

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(PI_CAPABILITY_NAMES);

/** Closed-set check for the DD-CAP-003 capability names. */
export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAME_SET.has(value);
}

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return PI_DECLARED_CAPABILITIES.includes(name);
}
