/**
 * OpenHands SDK capability declarations (DD-HOST-001 descriptor validation,
 * DD-CAP-003, DD-HOST-060).
 *
 * `declared_capabilities` is a manifest statement about the adapter surface,
 * not capability evidence. DD-HOST-060 records `product_adapter` capabilities
 * as `unknown`; the probe in this package only raises `evidence_stage` to
 * `static` for capabilities the adapter statically handles. It never claims
 * `verified`.
 *
 * `compaction_event` is absent because 1.56.0 has no native compaction hook.
 * `request_observation` is absent because there is no final request-body hook.
 * `generation.service_profile` is HOST-reserved and is never declared or probed
 * by an adapter (DD-CAP-004).
 */

import type { CapabilityName } from "./contract.js";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const OPENHANDS_CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
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
 * DD-HOST-060 declares `UserPromptSubmit`, `PreToolUse`/`PostToolUse`, `Stop`,
 * `SessionStart` and `SessionEnd`, plus plugin registration targets with an
 * explicit `new_session` load boundary. That surface justifies a static
 * declaration; it is not evidence of a passed roundtrip. `association` is
 * declared because the adapter maps the hook ids, while the join itself stays
 * `unknown` (E0 and E1 ids differ).
 */
export const OPENHANDS_DECLARED_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "association",
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "stable_boundary",
  "tool_id"
]);

/**
 * Capabilities with a static adapter-side fact, used only to set
 * `evidence_stage="static"` in a probe result. `compaction_event` is included
 * because DD-HOST-060 records that 1.56.0's six hook classes contain no native
 * compaction hook; that is a static fact about the surface, not a declaration
 * of support.
 */
export const OPENHANDS_STATIC_EVIDENCE_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "association",
  "compaction_event",
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "stable_boundary",
  "tool_id"
]);

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(OPENHANDS_CAPABILITY_NAMES);

/** Closed-set check for the DD-CAP-003 capability names. */
export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAME_SET.has(value);
}

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return OPENHANDS_STATIC_EVIDENCE_CAPABILITIES.includes(name);
}
