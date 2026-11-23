/**
 * Oh My Pi `AdapterDescriptor` (DD-HOST-001, DD-HOST-020, DD-HOST-110).
 *
 * The descriptor is built once from the OMP install/observation table, frozen,
 * and returned by `describe()`. Host core validates it again and freezes the
 * JCS snapshot before registration; this module therefore also exposes the
 * exact hash formulas so the adapter can verify its own request inputs without
 * creating a second schema.
 */

import { descriptorToJson, computeDescriptorHash, validateAdapterDescriptor as validateSharedAdapterDescriptor } from "@evoplug/adapter-kit";

import { canonicalJsonText, hashUtf8, type Hash, type SourceRef } from "@evoplug/core";

import { OMP_DECLARED_CAPABILITIES } from "./capabilities.js";
import type { AdapterDescriptor, ConfigSpace, HostMode, RegistrationTarget } from "./contract.js";
import { OMP_EVENT_CONTRACTS, isOmpObservationEvent } from "./events.js";
import { OMP_ADAPTER_ID, OMP_ADAPTER_VERSION, OMP_HOST_ID, OMP_IMPLEMENTATION_HASH } from "./manifest.js";

/** Modes OMP exposes to the adapter (DD-HOST-020). */
export const OMP_SUPPORTED_MODES: readonly HostMode[] = Object.freeze(["acp", "interactive", "print", "rpc", "sdk"]);

/**
 * Config spaces OMP exposes. `project` carries `.omp` configuration and the
 * `.claude/settings.json` compatibility layer; `project_pi_compat` is the Pi
 * compatibility root. OMP has no project trust gate, so every space is
 * declared and project input is still treated as untrusted.
 */
export const OMP_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze(["project", "project_pi_compat", "user"]);

/**
 * Registration targets from the OMP section, in design order.
 *
 * DD-HOST-020 splits the load boundary by mechanism: settings hot-reload,
 * extensions require a restart because `reload()` only reloads session files
 * and an extension-graph change needs a restart.
 */
export const OMP_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  Object.freeze({
    target_id: "omp.extensions.user",
    config_space: "user",
    scope: "user",
    kind: "extension",
    load_boundary: "restart",
    marker_id: null
  }),
  Object.freeze({
    target_id: "omp.extensions.project",
    config_space: "project",
    scope: "project",
    kind: "extension",
    load_boundary: "restart",
    marker_id: null
  }),
  Object.freeze({
    target_id: "omp.extensions.pi_compat",
    config_space: "project_pi_compat",
    scope: "project",
    kind: "extension",
    load_boundary: "restart",
    marker_id: null
  }),
  Object.freeze({
    target_id: "omp.settings.user",
    config_space: "user",
    scope: "user",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "omp.settings.project",
    config_space: "project",
    scope: "project",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  })
] satisfies readonly RegistrationTarget[]);

/** Frozen descriptor returned by `describe()`. */
export const OMP_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: OMP_ADAPTER_ID,
  host_id: OMP_HOST_ID,
  adapter_version: OMP_ADAPTER_VERSION,
  implementation_hash: OMP_IMPLEMENTATION_HASH,
  supported_modes: OMP_SUPPORTED_MODES,
  config_spaces: OMP_CONFIG_SPACES,
  registration_targets: OMP_REGISTRATION_TARGETS,
  event_contracts: OMP_EVENT_CONTRACTS,
  declared_capabilities: OMP_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describeOmpAdapter(): AdapterDescriptor {
  return OMP_ADAPTER_DESCRIPTOR;
}

/** Construction path for a mode (DD-HOST-110 exact table, no aliases). */
export function ompConstructionPathForMode(mode: HostMode): string | null {
  switch (mode) {
    case "interactive":
    case "print":
      return "cli";
    case "rpc":
      return "rpc";
    case "sdk":
      return "sdk";
    case "acp":
      return "acp";
    default:
      return null;
  }
}

/** True when the mode is declared by this adapter. */
export function isOmpMode(mode: HostMode): boolean {
  return OMP_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isOmpConfigSpace(config_space: ConfigSpace): boolean {
  return OMP_CONFIG_SPACES.includes(config_space);
}

/** Looks up a declared registration target by id. */
export function ompRegistrationTarget(target_id: string): RegistrationTarget | null {
  return OMP_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
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

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(OMP_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const OMP_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
  new TextEncoder().encode(DESCRIPTOR_REF_TEXT).byteLength
)}` as SourceRef;

/* ------------------------------------------------------------------ */
/* Descriptor validation (DD-HOST-001 producer table)                  */
/* ------------------------------------------------------------------ */

/** Validates a descriptor against the DD-HOST-001 producer table. */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  return validateSharedAdapterDescriptor(descriptor, isOmpObservationEvent);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const OMP_DESCRIPTOR_HASH: Hash = computeDescriptorHash(OMP_ADAPTER_DESCRIPTOR);
