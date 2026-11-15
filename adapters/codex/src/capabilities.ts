/**
 * Codex capability declarations (DD-HOST-001 descriptor validation, DD-CAP-003).
 *
 * `declared_capabilities` is a manifest statement about the adapter surface,
 * not capability evidence. DD-HOST-040 records the 0.160.1 probe as `blocked`
 * (server-side 403 region restriction) with no hook loaded, so every
 * `subject=product_adapter` capability stays `unknown`; the adapter's own
 * `probe` raises `evidence_stage` to `static` only for surfaces it statically
 * normalizes.
 *
 * `generation.service_profile` is HOST-reserved and is never declared or
 * probed by an adapter (DD-CAP-004).
 */

import type { CapabilityName } from "./contract.js";

/** Every `CapabilityName` in the DD-CAP-003 closed set. */
export const CODEX_CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
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
 * DD-HOST-040 records `input_capture`, `online_delivery`, `stable_boundary`,
 * `host_budget` and `association` as `unknown` for the blocked 0.160.1 probe.
 * This list only says which event surfaces the adapter can normalize; it does
 * not raise any status and never becomes evidence.
 */
export const CODEX_DECLARED_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "compaction_event",
  "input_capture",
  "managed_object_load",
  "online_delivery",
  "request_observation",
  "stable_boundary",
  "tool_id"
]);

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set(CODEX_CAPABILITY_NAMES);

/** Closed-set check for the DD-CAP-003 capability names. */
export function isCapabilityName(value: string): value is CapabilityName {
  return CAPABILITY_NAME_SET.has(value);
}

/** True when the adapter statically handles the capability's observation surface. */
export function hasStaticAdapterEvidence(name: CapabilityName): boolean {
  return CODEX_DECLARED_CAPABILITIES.includes(name);
}
