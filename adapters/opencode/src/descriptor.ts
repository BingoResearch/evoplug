/**
 * OpenCode `AdapterDescriptor` (DD-HOST-001, DD-HOST-050, DD-HOST-110).
 *
 * The descriptor is built once from the OpenCode install/observation table,
 * frozen, and returned by `describe()`. Host core validates it again and
 * freezes the JCS snapshot before registration; this module therefore also
 * exposes the exact hash formulas so the adapter can verify its own request
 * inputs without creating a second schema.
 *
 * The source baseline (core/server 2.1.0) and the installed build (2.1.4)
 * are separate facts (DD-HOST-050, DD-HOST-100). The descriptor declares the
 * 2.1.0 plugin surface because 2.1.4 loaded no diagnostic plugin; the
 * capability records still stay `unknown` until a host roundtrip exists.
 */

import { descriptorToJson, computeDescriptorHash, validateAdapterDescriptor as validateSharedAdapterDescriptor } from "@evoplug/adapter-kit";

import { canonicalJsonText, hashUtf8, type Hash, type SourceRef } from "@evoplug/core";

import { OPENCODE_DECLARED_CAPABILITIES } from "./capabilities.js";
import type { AdapterDescriptor, ConfigSpace, HostMode, RegistrationTarget } from "./contract.js";
import { OPENCODE_EVENT_CONTRACTS, isOpenCodeObservationEvent } from "./events.js";
import { OPENCODE_ADAPTER_ID, OPENCODE_ADAPTER_VERSION, OPENCODE_HOST_ID, OPENCODE_IMPLEMENTATION_HASH } from "./manifest.js";

/** Modes OpenCode exposes to the adapter (DD-HOST-050). */
export const OPENCODE_SUPPORTED_MODES: readonly HostMode[] = Object.freeze(["interactive", "server"]);

/**
 * Config spaces OpenCode exposes (DD-HOST-050). `user`, `project` and
 * `managed` are the three declared spaces; no project trust gate is recorded,
 * so registration does not require a host trust decision.
 */
export const OPENCODE_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze(["managed", "project", "user"]);

/**
 * Registration targets from the OpenCode section, in design order.
 *
 * DD-HOST-050 discovers plugins through the config keys `plugin`/`plugins`
 * and through same-named directories. `InstancePlugins` is a birth list that
 * cannot change after instance creation (`new_session`/new instance), while
 * config-discovered, local-path and package plugins can be hot-swapped through
 * `PluginSupervisor` generation (`reload`).
 */
export const OPENCODE_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  Object.freeze({
    target_id: "opencode.plugin.user.config",
    config_space: "user",
    scope: "user",
    kind: "plugin",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "opencode.plugin.user.directory",
    config_space: "user",
    scope: "user",
    kind: "plugin",
    load_boundary: "new_session",
    marker_id: null
  }),
  Object.freeze({
    target_id: "opencode.plugin.project.config",
    config_space: "project",
    scope: "project",
    kind: "plugin",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "opencode.plugin.project.directory",
    config_space: "project",
    scope: "project",
    kind: "plugin",
    load_boundary: "new_session",
    marker_id: null
  }),
  Object.freeze({
    target_id: "opencode.plugin.managed.config",
    config_space: "managed",
    scope: "managed",
    kind: "plugin",
    load_boundary: "reload",
    marker_id: null
  })
] satisfies readonly RegistrationTarget[]);

/** Frozen descriptor returned by `describe()`. */
export const OPENCODE_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: OPENCODE_ADAPTER_ID,
  host_id: OPENCODE_HOST_ID,
  adapter_version: OPENCODE_ADAPTER_VERSION,
  implementation_hash: OPENCODE_IMPLEMENTATION_HASH,
  supported_modes: OPENCODE_SUPPORTED_MODES,
  config_spaces: OPENCODE_CONFIG_SPACES,
  registration_targets: OPENCODE_REGISTRATION_TARGETS,
  event_contracts: OPENCODE_EVENT_CONTRACTS,
  declared_capabilities: OPENCODE_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describeOpenCodeAdapter(): AdapterDescriptor {
  return OPENCODE_ADAPTER_DESCRIPTOR;
}

/** Construction path for a mode (DD-HOST-110 exact table, no aliases). */
export function openCodeConstructionPathForMode(mode: HostMode): string | null {
  switch (mode) {
    case "interactive":
      return "cli";
    case "server":
      return "server";
    default:
      return null;
  }
}

/** True when the mode is declared by this adapter. */
export function isOpenCodeMode(mode: HostMode): boolean {
  return OPENCODE_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isOpenCodeConfigSpace(config_space: ConfigSpace): boolean {
  return OPENCODE_CONFIG_SPACES.includes(config_space);
}

/** Looks up a declared registration target by id. */
export function openCodeRegistrationTarget(target_id: string): RegistrationTarget | null {
  return OPENCODE_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
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

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(OPENCODE_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const OPENCODE_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
  new TextEncoder().encode(DESCRIPTOR_REF_TEXT).byteLength
)}` as SourceRef;

/* ------------------------------------------------------------------ */
/* Descriptor validation (DD-HOST-001 producer table)                  */
/* ------------------------------------------------------------------ */

/** Validates a descriptor against the DD-HOST-001 producer table. */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  return validateSharedAdapterDescriptor(descriptor, isOpenCodeObservationEvent);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const OPENCODE_DESCRIPTOR_HASH: Hash = computeDescriptorHash(OPENCODE_ADAPTER_DESCRIPTOR);
