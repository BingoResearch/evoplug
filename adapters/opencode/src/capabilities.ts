/**
 * OpenCode capability declarations (DD-HOST-001 descriptor validation,
 * DD-CAP-003, DD-HOST-050).
 *
 * `declared_capabilities` is a manifest statement about the adapter surface,
 * not capability evidence. DD-HOST-050 records the 2.1.0 source surface as
 * `unknown/static` for `online_delivery`, `stable_boundary`, `host_budget` and
 * `association`, and every `product_adapter` capability as `unknown`; the
 * 2.1.4 install loaded no diagnostic plugin and stays `unknown/none`. The
 * probe in this package only raises `evidence_stage` to `static` for
 * capabilities the adapter statically handles, and only when the binding names
 * the 2.1.0 source commit. It never claims `verified`.
 *
 * `generation.service_profile` is HOST-reserved and is never declared or
 * probed by an adapter (DD-CAP-004).
 */

import type { CapabilityName } from "./contract.js";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const OPENCODE_CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
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
 * DD-HOST-050 maps `session.prompt`, tool `execute.before/after`,
 * `session.compaction`, durable execution events, `session.context`,
 * `model.request` and `http.request/response`. That surface justifies a static
 * declaration; it is not evidence of a passed roundtrip. `host_budget`,
 * `sync_wait` and `association` are absent because the section records them as
 * unknown and the adapter observes no field for them.
 */
export const OPENCODE_DECLARED_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "compaction_event",
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "request_observation",
  "stable_boundary",
  "tool_id"
]);

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(OPENCODE_CAPABILITY_NAMES);

/** Closed-set check for the DD-CAP-003 capability names. */
export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAME_SET.has(value);
}

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return OPENCODE_DECLARED_CAPABILITIES.includes(name);
}
