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

import {
  CAPABILITY_NAMES,
  hasStaticAdapterEvidence as hasSharedStaticEvidence
} from "@evoplug/adapter-kit";

import type { CapabilityName } from "./contract.js";

export { HOST_RESERVED_CAPABILITY, isCapabilityName } from "@evoplug/adapter-kit";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const OPENHANDS_CAPABILITY_NAMES: readonly CapabilityName[] = CAPABILITY_NAMES;

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

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return hasSharedStaticEvidence(name, OPENHANDS_STATIC_EVIDENCE_CAPABILITIES);
}
