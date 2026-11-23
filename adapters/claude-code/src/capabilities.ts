/**
 * Claude Code capability declarations (DD-HOST-001 descriptor validation,
 * DD-CAP-003, DD-HOST-070).
 *
 * `declared_capabilities` is a manifest statement about the adapter surface,
 * not capability evidence. DD-HOST-070 records the 2.1.304 `-p` roundtrip for
 * `input_capture` at the `host_contract` level; every `subject=product_adapter`
 * capability stays `unknown` because the product adapter has not produced its
 * own roundtrip. This module never upgrades a status.
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
export const CLAUDE_CAPABILITY_NAMES: readonly CapabilityName[] = CAPABILITY_NAMES;

/**
 * Capabilities this adapter handles statically.
 *
 * DD-HOST-070 maps input (`UserPromptSubmit`/`UserPromptExpansion`), tool
 * facts (`Pre/PostToolUse`, `PostToolBatch`), boundaries (`Stop`,
 * `StopFailure`, `SessionEnd`), compaction (`Pre/PostCompact`) and native ids
 * (`session_id`, `prompt_id`, `tool_use_id`). The list only says which event
 * surfaces the adapter can map; it raises no status and never becomes
 * evidence. `request_observation`, `host_budget`, `sync_wait`, `source_trust`,
 * `capacity_window`, `human_interaction_attested` and every `generation.*`
 * capability have no mapped surface in this host section and are not declared.
 */
export const CLAUDE_DECLARED_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
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
  return hasSharedStaticEvidence(name, CLAUDE_DECLARED_CAPABILITIES);
}
