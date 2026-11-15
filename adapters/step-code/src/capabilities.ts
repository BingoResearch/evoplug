/**
 * Step Code capability declarations (DD-HOST-001 descriptor validation,
 * DD-CAP-003, DD-HOST-030).
 *
 * `declared_capabilities` is a manifest statement about the adapter surface,
 * not capability evidence. The Step Code host section records only
 * `host_contract` facts for the installed 0.1.5 print build; no
 * `product_adapter` roundtrip exists, so every capability status stays
 * `unknown`. The probe in this package raises `evidence_stage` to `static`
 * only for capabilities the adapter statically handles.
 *
 * `generation.service_profile` is HOST-reserved and is never declared or
 * probed by an adapter (DD-CAP-004).
 */

import type { CapabilityName } from "./contract.js";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const STEP_CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
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
 * Step Code exposes `input`, `context`, tool hooks and a compaction event; the
 * extension surface is the managed object the adapter registers. None of these
 * declarations is evidence for `subject=product_adapter` (DD-HOST-030 initial
 * capability row is `unknown` except the `host_contract` print facts).
 */
export const STEP_DECLARED_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "compaction_event",
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "request_observation",
  "tool_id"
]);

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(STEP_CAPABILITY_NAMES);

/** Closed-set check for the DD-CAP-003 capability names. */
export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAME_SET.has(value);
}

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return STEP_DECLARED_CAPABILITIES.includes(name);
}
