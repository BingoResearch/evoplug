/**
 * Shared capability vocabulary for adapters (DD-HOST-001, DD-CAP-003).
 *
 * `generation.service_profile` is HOST-reserved and is never declared or
 * probed by an adapter (DD-CAP-004).
 */

import type { CapabilityName } from "./contract.js";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
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

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(CAPABILITY_NAMES);

/** Closed-set check for the DD-CAP-003 capability names. */
export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAME_SET.has(value);
}

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(
  name: CapabilityName,
  declared: readonly CapabilityName[]
): boolean {
  return declared.includes(name);
}
