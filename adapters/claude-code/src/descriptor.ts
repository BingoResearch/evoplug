/**
 * Claude Code `AdapterDescriptor` (DD-HOST-001, DD-HOST-070, DD-HOST-110).
 *
 * The descriptor is built once from the install/observation table, frozen, and
 * returned by `describe()`. Host core validates it again and freezes the JCS
 * snapshot before registration; this module therefore also exposes the exact
 * hash formulas so the adapter can verify its own request inputs without
 * creating a second schema.
 *
 * DD-HOST-070: `mapping=unmapped`. Modes and config spaces are the design's
 * closed lists, not capability claims. `user`, `project`, `local` and
 * `managed` are the four settings layers; hooks from settings, plugin
 * `hooks/hooks.json` and skill/subagent frontmatter merge across them, and
 * `allowManagedHooksOnly` can restrict the effective set.
 */

import { descriptorToJson, computeDescriptorHash, validateAdapterDescriptor as validateSharedAdapterDescriptor } from "@evoplug/adapter-kit";

import { canonicalJsonText, hashUtf8, type Hash, type SourceRef } from "@evoplug/core";

import { CLAUDE_DECLARED_CAPABILITIES } from "./capabilities.js";
import type { AdapterDescriptor, ConfigSpace, HostMode, RegistrationTarget } from "./contract.js";
import { CLAUDE_EVENT_CONTRACTS, isClaudeObservationEvent } from "./events.js";
import { CLAUDE_ADAPTER_ID, CLAUDE_ADAPTER_VERSION, CLAUDE_HOST_ID, CLAUDE_IMPLEMENTATION_HASH } from "./manifest.js";

/**
 * Modes Claude Code exposes to the adapter (DD-HOST-070): `interactive`,
 * `print` (`-p`) and `sdk`. UTF-8 sorted.
 */
export const CLAUDE_SUPPORTED_MODES: readonly HostMode[] = Object.freeze(["interactive", "print", "sdk"]);

/**
 * Config spaces Claude Code exposes: the four settings layers, UTF-8 sorted.
 * Managed settings can restrict hooks through `allowManagedHooksOnly`.
 */
export const CLAUDE_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze([
  "local",
  "managed",
  "project",
  "user"
]);

/**
 * Registration targets from the Claude Code section, in design order.
 *
 * Hooks live in settings, plugin `hooks/hooks.json` and skill/subagent
 * frontmatter. Hook edits usually take effect on reload inside a session, so
 * hook targets declare `load_boundary="reload"`; plugin graphs and SDK
 * packages are session-static and declare `new_session`. Managed hooks carry a
 * marker because they are the only managed block this adapter writes.
 */
export const CLAUDE_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  Object.freeze({
    target_id: "claude.hooks.user",
    config_space: "user",
    scope: "user",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "claude.hooks.project",
    config_space: "project",
    scope: "project",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "claude.hooks.local",
    config_space: "local",
    scope: "project",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "claude.hooks.managed",
    config_space: "managed",
    scope: "managed",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: "claude/hooks"
  }),
  Object.freeze({
    target_id: "claude.plugin.user",
    config_space: "user",
    scope: "user",
    kind: "plugin",
    load_boundary: "new_session",
    marker_id: null
  }),
  Object.freeze({
    target_id: "claude.plugin.local_marketplace",
    config_space: "local",
    scope: "project",
    kind: "plugin",
    load_boundary: "new_session",
    marker_id: null
  }),
  Object.freeze({
    target_id: "claude.sdk_package",
    config_space: "user",
    scope: "user",
    kind: "sdk_package",
    load_boundary: "new_session",
    marker_id: null
  })
] satisfies readonly RegistrationTarget[]);

/** Frozen descriptor returned by `describe()`. */
export const CLAUDE_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: CLAUDE_ADAPTER_ID,
  host_id: CLAUDE_HOST_ID,
  adapter_version: CLAUDE_ADAPTER_VERSION,
  implementation_hash: CLAUDE_IMPLEMENTATION_HASH,
  supported_modes: CLAUDE_SUPPORTED_MODES,
  config_spaces: CLAUDE_CONFIG_SPACES,
  registration_targets: CLAUDE_REGISTRATION_TARGETS,
  event_contracts: CLAUDE_EVENT_CONTRACTS,
  declared_capabilities: CLAUDE_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describeClaudeAdapter(): AdapterDescriptor {
  return CLAUDE_ADAPTER_DESCRIPTOR;
}

/**
 * Construction path for a mode (DD-HOST-110 exact table, no aliases):
 * `interactive`/`print` → `cli`; `sdk` → `sdk`.
 */
export function claudeConstructionPathForMode(mode: HostMode): string | null {
  switch (mode) {
    case "interactive":
    case "print":
      return "cli";
    case "sdk":
      return "sdk";
    default:
      return null;
  }
}

/** True when the mode is declared by this adapter. */
export function isClaudeMode(mode: HostMode): boolean {
  return CLAUDE_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isClaudeConfigSpace(config_space: ConfigSpace): boolean {
  return CLAUDE_CONFIG_SPACES.includes(config_space);
}

/** Looks up a declared registration target by id. */
export function claudeRegistrationTarget(target_id: string): RegistrationTarget | null {
  return CLAUDE_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Exact JCS projections and hashes                                    */
/* ------------------------------------------------------------------ */

export {
  computeDescriptorHash,
  computeRegistrationHash,
  descriptorToJson,
  type RegistrationHashFields
} from "@evoplug/adapter-kit";

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(CLAUDE_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const CLAUDE_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
  new TextEncoder().encode(DESCRIPTOR_REF_TEXT).byteLength
)}` as SourceRef;

/* ------------------------------------------------------------------ */
/* Descriptor validation (DD-HOST-001 producer table)                  */
/* ------------------------------------------------------------------ */

/** Validates a descriptor against the DD-HOST-001 producer table. */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  return validateSharedAdapterDescriptor(descriptor, isClaudeObservationEvent);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const CLAUDE_DESCRIPTOR_HASH: Hash = computeDescriptorHash(CLAUDE_ADAPTER_DESCRIPTOR);
