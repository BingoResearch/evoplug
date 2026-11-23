/**
 * Step Code `AdapterDescriptor` (DD-HOST-001, DD-HOST-030, DD-HOST-110).
 *
 * The descriptor is built once from the Step Code install/observation table,
 * frozen, and returned by `describe()`. Host core validates it again and freezes
 * the JCS snapshot before registration; this module therefore also exposes the
 * exact hash formulas so the adapter can verify its own request inputs without
 * creating a second schema.
 *
 * `config_spaces` follows DD-HOST-030: `user`, `project_trusted`,
 * `project_untrusted`, plus the independent `sdk_stdio` space. DD-HOST-030
 * states both "配置空间 `user`、`project_trusted`、`project_untrusted`" and
 * "SDK stdio 是独立配置空间"; the independent token is declared so the stdio
 * registration target has a space of its own and no extension target can claim
 * it (see `validateAdapterDescriptor`).
 */

import { descriptorToJson, computeDescriptorHash, validateAdapterDescriptor as validateSharedAdapterDescriptor } from "@evoplug/adapter-kit";

import { canonicalJsonText, hashUtf8, type Hash, type SourceRef } from "@evoplug/core";

import { STEP_DECLARED_CAPABILITIES } from "./capabilities.js";
import type { AdapterDescriptor, ConfigSpace, HostMode, RegistrationTarget } from "./contract.js";
import { STEP_EVENT_CONTRACTS, isStepObservationEvent } from "./events.js";
import { STEP_ADAPTER_ID, STEP_ADAPTER_VERSION, STEP_HOST_ID, STEP_IMPLEMENTATION_HASH } from "./manifest.js";

/** Modes Step Code exposes to the adapter (DD-HOST-030). */
export const STEP_SUPPORTED_MODES: readonly HostMode[] = Object.freeze([
  "interactive",
  "print",
  "rpc",
  "sdk_stdio"
]);

/**
 * Config spaces Step Code exposes. `project_untrusted` is declared because the
 * design records it as a space whose project input is treated as untrusted;
 * the target exists so the descriptor has no orphan space, not to claim that a
 * write is permitted there. `sdk_stdio` is the independent stdio space and is
 * served only by the process-scoped hook target.
 */
export const STEP_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze([
  "project_trusted",
  "project_untrusted",
  "sdk_stdio",
  "user"
]);

/** Registration targets from the Step Code section, in design order. */
export const STEP_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  Object.freeze({
    target_id: "stepcode.extensions.user",
    config_space: "user",
    scope: "user",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "stepcode.extensions.project",
    config_space: "project_trusted",
    scope: "project",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "stepcode.settings.extensions",
    config_space: "project_trusted",
    scope: "project",
    kind: "extension",
    load_boundary: "new_session",
    marker_id: null
  }),
  Object.freeze({
    target_id: "stepcode.extensions.project_untrusted",
    config_space: "project_untrusted",
    scope: "project",
    kind: "extension",
    load_boundary: "unknown",
    marker_id: null
  }),
  Object.freeze({
    target_id: "stepcode.stdio.hook",
    config_space: "sdk_stdio",
    scope: "user",
    kind: "hook_config",
    load_boundary: "new_session",
    marker_id: null
  })
] satisfies readonly RegistrationTarget[]);

/** Frozen descriptor returned by `describe()`. */
export const STEP_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: STEP_ADAPTER_ID,
  host_id: STEP_HOST_ID,
  adapter_version: STEP_ADAPTER_VERSION,
  implementation_hash: STEP_IMPLEMENTATION_HASH,
  supported_modes: STEP_SUPPORTED_MODES,
  config_spaces: STEP_CONFIG_SPACES,
  registration_targets: STEP_REGISTRATION_TARGETS,
  event_contracts: STEP_EVENT_CONTRACTS,
  declared_capabilities: STEP_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describeStepAdapter(): AdapterDescriptor {
  return STEP_ADAPTER_DESCRIPTOR;
}

/**
 * Construction path for a mode (DD-HOST-110 exact table, no aliases).
 *
 * Step Code maps `interactive`/`print` to `cli`, `rpc` to `rpc` and
 * `sdk_stdio` to `sdk_stdio`. The extension `sdk` path must not be reused.
 */
export function stepConstructionPathForMode(mode: HostMode): string | null {
  switch (mode) {
    case "interactive":
    case "print":
      return "cli";
    case "rpc":
      return "rpc";
    case "sdk_stdio":
      return "sdk_stdio";
    default:
      return null;
  }
}

/** True when the mode is declared by this adapter. */
export function isStepMode(mode: HostMode): boolean {
  return STEP_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isStepConfigSpace(config_space: ConfigSpace): boolean {
  return STEP_CONFIG_SPACES.includes(config_space);
}

/** True when the mode uses the independent stdio binding. */
export function isStepStdioMode(mode: HostMode): boolean {
  return mode === "sdk_stdio";
}

/** Looks up a declared registration target by id. */
export function stepRegistrationTarget(target_id: string): RegistrationTarget | null {
  return STEP_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
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

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(STEP_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const STEP_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
  new TextEncoder().encode(DESCRIPTOR_REF_TEXT).byteLength
)}` as SourceRef;

/* ------------------------------------------------------------------ */
/* Descriptor validation (DD-HOST-001 producer table)                  */
/* ------------------------------------------------------------------ */

/** Validates a descriptor against the DD-HOST-001 producer table. */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  return validateSharedAdapterDescriptor(descriptor, isStepObservationEvent);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const STEP_DESCRIPTOR_HASH: Hash = computeDescriptorHash(STEP_ADAPTER_DESCRIPTOR);
