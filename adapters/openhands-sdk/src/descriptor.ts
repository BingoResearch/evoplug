/**
 * OpenHands SDK `AdapterDescriptor` (DD-HOST-001, DD-HOST-060, DD-HOST-110).
 *
 * The descriptor is built once from the OpenHands install/observation table,
 * frozen, and returned by `describe()`. Host core validates it again and
 * freezes the JCS snapshot before registration; this module therefore also
 * exposes the exact hash formulas so the adapter can verify its own request
 * inputs without creating a second schema.
 *
 * OpenHands declares three config spaces and two plugin directories. Plugin
 * discovery is per config space, so each `(directory, config_space)` pair is a
 * registration target. `load_boundary` is `new_session` because explicit and
 * ambient plugins are merged lazily on the first run/send of a conversation.
 *
 * The construction path is never derived from the mode (DD-HOST-110): the
 * caller must choose one of `server_settings`, `direct_agent`, `preset_agent`
 * or `subagent_factory` explicitly.
 */

import { descriptorToJson, computeDescriptorHash, validateAdapterDescriptor as validateSharedAdapterDescriptor } from "@evoplug/adapter-kit";

import { canonicalJsonText, hashUtf8, type Hash, type SourceRef } from "@evoplug/core";

import { OPENHANDS_DECLARED_CAPABILITIES } from "./capabilities.js";
import type { AdapterDescriptor, ConfigSpace, HostMode, RegistrationTarget } from "./contract.js";
import { OPENHANDS_EVENT_CONTRACTS, isOpenhandsObservationEvent } from "./events.js";
import { OPENHANDS_ADAPTER_ID, OPENHANDS_ADAPTER_VERSION, OPENHANDS_HOST_ID, OPENHANDS_IMPLEMENTATION_HASH } from "./manifest.js";

/** Modes OpenHands exposes to the adapter (DD-HOST-060). */
export const OPENHANDS_SUPPORTED_MODES: readonly HostMode[] = Object.freeze([
  "local_conversation",
  "remote_conversation"
]);

/**
 * Config spaces OpenHands exposes: the user HOME, the project and an isolated
 * HOME. `isolated_home` is the space used when `HOME`, `OH_PERSISTENCE_DIR` and
 * the workspace are isolated for a run.
 */
export const OPENHANDS_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze([
  "isolated_home",
  "project",
  "user_home"
]);

/** Plugin directories recorded by DD-HOST-060, without a leading path. */
export const OPENHANDS_PLUGIN_DIRECTORIES: readonly string[] = Object.freeze([
  ".agents/plugins",
  ".openhands/plugins"
]);

function pluginTarget(
  directory: string,
  config_space: ConfigSpace,
  scope: RegistrationTarget["scope"]
): RegistrationTarget {
  const slug = directory.replace(/^\./, "").replace(/[^a-z0-9]+/g, "_").replace(/_+$/g, "");
  return Object.freeze({
    target_id: `openhands.${slug}.${config_space}`,
    config_space,
    scope,
    kind: "plugin",
    load_boundary: "new_session",
    marker_id: null
  });
}

/**
 * Registration targets from the DD-HOST-060 section.
 *
 * Both plugin directories are discovered relative to the active config space;
 * ambient plugins have no disable switch, so isolation is provided by the
 * `isolated_home` space and the persistence directory rather than by a target
 * flag.
 */
export const OPENHANDS_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  pluginTarget(".agents/plugins", "isolated_home", "user"),
  pluginTarget(".openhands/plugins", "isolated_home", "user"),
  pluginTarget(".agents/plugins", "project", "project"),
  pluginTarget(".openhands/plugins", "project", "project"),
  pluginTarget(".agents/plugins", "user_home", "user"),
  pluginTarget(".openhands/plugins", "user_home", "user")
]);

/** Frozen descriptor returned by `describe()`. */
export const OPENHANDS_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: OPENHANDS_ADAPTER_ID,
  host_id: OPENHANDS_HOST_ID,
  adapter_version: OPENHANDS_ADAPTER_VERSION,
  implementation_hash: OPENHANDS_IMPLEMENTATION_HASH,
  supported_modes: OPENHANDS_SUPPORTED_MODES,
  config_spaces: OPENHANDS_CONFIG_SPACES,
  registration_targets: OPENHANDS_REGISTRATION_TARGETS,
  event_contracts: OPENHANDS_EVENT_CONTRACTS,
  declared_capabilities: OPENHANDS_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describeOpenhandsAdapter(): AdapterDescriptor {
  return OPENHANDS_ADAPTER_DESCRIPTOR;
}

/**
 * Construction paths recorded by DD-HOST-110. OpenHands requires an explicit
 * choice; the mode never implies one.
 */
export const OPENHANDS_CONSTRUCTION_PATHS: readonly string[] = Object.freeze([
  "direct_agent",
  "preset_agent",
  "server_settings",
  "subagent_factory"
]);

/**
 * OpenHands has no mode-to-path mapping. This always returns `null` so callers
 * cannot silently derive a path from `local_conversation` or
 * `remote_conversation`.
 */
export function openhandsConstructionPathForMode(mode: HostMode): string | null {
  void mode;
  return null;
}

/** True when the value is one of the four explicit OpenHands construction paths. */
export function isOpenhandsConstructionPath(value: string): boolean {
  return OPENHANDS_CONSTRUCTION_PATHS.includes(value);
}

/** True when the mode is declared by this adapter. */
export function isOpenhandsMode(mode: HostMode): boolean {
  return OPENHANDS_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isOpenhandsConfigSpace(config_space: ConfigSpace): boolean {
  return OPENHANDS_CONFIG_SPACES.includes(config_space);
}

/** Looks up a declared registration target by id. */
export function openhandsRegistrationTarget(target_id: string): RegistrationTarget | null {
  return OPENHANDS_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
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

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(OPENHANDS_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const OPENHANDS_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
  new TextEncoder().encode(DESCRIPTOR_REF_TEXT).byteLength
)}` as SourceRef;

/* ------------------------------------------------------------------ */
/* Descriptor validation (DD-HOST-001 producer table)                  */
/* ------------------------------------------------------------------ */

/** Validates a descriptor against the DD-HOST-001 producer table. */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  return validateSharedAdapterDescriptor(descriptor, isOpenhandsObservationEvent);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const OPENHANDS_DESCRIPTOR_HASH: Hash = computeDescriptorHash(OPENHANDS_ADAPTER_DESCRIPTOR);
