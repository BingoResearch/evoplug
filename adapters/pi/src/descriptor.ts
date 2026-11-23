/**
 * Pi `AdapterDescriptor` (DD-HOST-001, DD-HOST-010, DD-HOST-110).
 *
 * The descriptor is built once from the Pi install/observation table, frozen,
 * and returned by `describe()`. Host core validates it again and freezes the
 * JCS snapshot before registration; this module therefore also exposes the
 * exact hash formulas so the adapter can verify its own request inputs without
 * creating a second schema.
 */

import { descriptorToJson, computeDescriptorHash, validateAdapterDescriptor as validateSharedAdapterDescriptor } from "@evoplug/adapter-kit";

import { canonicalJsonText, hashUtf8, type Hash, type SourceRef } from "@evoplug/core";

import { PI_DECLARED_CAPABILITIES } from "./capabilities.js";
import type { AdapterDescriptor, ConfigSpace, HostMode, RegistrationTarget } from "./contract.js";
import { PI_EVENT_CONTRACTS, isPiObservationEvent } from "./events.js";
import { PI_ADAPTER_ID, PI_ADAPTER_VERSION, PI_HOST_ID, PI_IMPLEMENTATION_HASH } from "./manifest.js";

/** Modes Pi exposes to the adapter (DD-HOST-010). */
export const PI_SUPPORTED_MODES: readonly HostMode[] = Object.freeze(["interactive", "print", "rpc", "sdk"]);

/**
 * Config spaces Pi exposes. `project_untrusted` is declared because the design
 * records it as a space whose settings/extensions are trust-rejected; the
 * target exists so the descriptor has no orphan space, not to claim that a
 * write is permitted there.
 */
export const PI_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze(["project_trusted", "project_untrusted", "user"]);

/** Registration targets from the Pi section, in design order. */
export const PI_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  Object.freeze({
    target_id: "pi.extensions.user",
    config_space: "user",
    scope: "user",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "pi.extensions.project",
    config_space: "project_trusted",
    scope: "project",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "pi.settings.extensions",
    config_space: "project_trusted",
    scope: "project",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "pi.extensions.project_untrusted",
    config_space: "project_untrusted",
    scope: "project",
    kind: "extension",
    load_boundary: "unknown",
    marker_id: null
  })
] satisfies readonly RegistrationTarget[]);

/** Frozen descriptor returned by `describe()`. */
export const PI_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: PI_ADAPTER_ID,
  host_id: PI_HOST_ID,
  adapter_version: PI_ADAPTER_VERSION,
  implementation_hash: PI_IMPLEMENTATION_HASH,
  supported_modes: PI_SUPPORTED_MODES,
  config_spaces: PI_CONFIG_SPACES,
  registration_targets: PI_REGISTRATION_TARGETS,
  event_contracts: PI_EVENT_CONTRACTS,
  declared_capabilities: PI_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describePiAdapter(): AdapterDescriptor {
  return PI_ADAPTER_DESCRIPTOR;
}

/** Construction path for a mode (DD-HOST-110 exact table, no aliases). */
export function piConstructionPathForMode(mode: HostMode): string | null {
  switch (mode) {
    case "interactive":
    case "print":
      return "cli";
    case "rpc":
      return "rpc";
    case "sdk":
      return "sdk";
    default:
      return null;
  }
}

/** True when the mode is declared by this adapter. */
export function isPiMode(mode: HostMode): boolean {
  return PI_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isPiConfigSpace(config_space: ConfigSpace): boolean {
  return PI_CONFIG_SPACES.includes(config_space);
}

/** Looks up a declared registration target by id. */
export function piRegistrationTarget(target_id: string): RegistrationTarget | null {
  return PI_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
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

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(PI_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const PI_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
  new TextEncoder().encode(DESCRIPTOR_REF_TEXT).byteLength
)}` as SourceRef;

/* ------------------------------------------------------------------ */
/* Descriptor validation (DD-HOST-001 producer table)                  */
/* ------------------------------------------------------------------ */

/** Validates a descriptor against the DD-HOST-001 producer table. */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  return validateSharedAdapterDescriptor(descriptor, isPiObservationEvent);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const PI_DESCRIPTOR_HASH: Hash = computeDescriptorHash(PI_ADAPTER_DESCRIPTOR);
