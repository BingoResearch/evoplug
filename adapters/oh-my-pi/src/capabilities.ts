/**
 * Oh My Pi capability declarations (DD-HOST-001 descriptor validation,
 * DD-CAP-003, DD-HOST-020).
 *
 * `declared_capabilities` is a manifest statement about the adapter surface,
 * not capability evidence. DD-HOST-020 records `input_capture` as
 * `unknown/static` for `host_contract` and every `product_adapter` capability
 * as `unknown`; the probe in this package only raises `evidence_stage` to
 * `static` for capabilities the adapter statically handles. It never claims
 * `verified`.
 *
 * `generation.service_profile` is HOST-reserved and is never declared or
 * probed by an adapter (DD-CAP-004).
 */

import type { CapabilityName } from "./contract.js";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const OMP_CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
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
 * DD-HOST-020 declares `input` (interactive/RPC), `before_agent_start`,
 * `tool_call`/`tool_result`, `session_stop`, `agent_end`, `agent_settled`,
 * `session_shutdown`, `context` and provider hooks, plus registration targets
 * with explicit load boundaries. That surface justifies a static declaration;
 * it is not evidence of a passed roundtrip. `compaction_event` is absent
 * because DD-HOST-020 lists no compaction hook for OMP.
 */
export const OMP_DECLARED_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "request_observation",
  "stable_boundary",
  "tool_id"
]);

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(OMP_CAPABILITY_NAMES);

/** Closed-set check for the DD-CAP-003 capability names. */
export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAME_SET.has(value);
}

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return OMP_DECLARED_CAPABILITIES.includes(name);
}
