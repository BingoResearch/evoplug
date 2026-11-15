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

import {
  canonicalHash,
  canonicalJsonText,
  compareUtf8,
  hashUtf8,
  isHash,
  isId,
  type Hash,
  type Id,
  type JsonValue,
  type SourceRef
} from "@evoplug/core";

import { HOST_RESERVED_CAPABILITY, OPENCODE_DECLARED_CAPABILITIES, isCapabilityName } from "./capabilities.js";
import type {
  AdapterDescriptor,
  ConfigSpace,
  EventContract,
  HostId,
  HostMode,
  LoadBoundary,
  RegistrationTarget
} from "./contract.js";
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

function stringArray(values: readonly string[]): JsonValue[] {
  return values.map((value) => value);
}

/** Canonical JSON projection of a descriptor (field set fixed by DD-HOST-001). */
export function descriptorToJson(descriptor: AdapterDescriptor): JsonValue {
  const targets: JsonValue = descriptor.registration_targets.map((target) => ({
    target_id: target.target_id,
    config_space: target.config_space,
    scope: target.scope,
    kind: target.kind,
    load_boundary: target.load_boundary,
    marker_id: target.marker_id
  }));
  const contracts: JsonValue = descriptor.event_contracts.map((entry) => ({
    host_event: entry.host_event,
    native_kind: entry.native_kind,
    canonical_kinds: stringArray(entry.canonical_kinds),
    required_capabilities: stringArray(entry.required_capabilities)
  }));
  return {
    schema_version: descriptor.schema_version,
    adapter_id: descriptor.adapter_id,
    host_id: descriptor.host_id,
    adapter_version: descriptor.adapter_version,
    implementation_hash: descriptor.implementation_hash,
    supported_modes: stringArray(descriptor.supported_modes),
    config_spaces: stringArray(descriptor.config_spaces),
    registration_targets: targets,
    event_contracts: contracts,
    declared_capabilities: stringArray(descriptor.declared_capabilities)
  };
}

/** `descriptor_hash = sha256(JCS(descriptor))`. */
export function computeDescriptorHash(descriptor: AdapterDescriptor): Hash {
  return canonicalHash(descriptorToJson(descriptor));
}

/** Input of the registration-hash formula. */
export interface RegistrationHashFields {
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly descriptor_hash: Hash;
  readonly target_id: string;
  readonly artifact_hash: Hash;
  readonly expected_previous_hash: Hash | null;
}

/**
 * `registration_hash = sha256(JCS({schema_version:"rsi.adapter_registration/1",
 * host_id,mode,config_space,adapter_id,adapter_version,implementation_hash,
 * descriptor_hash,target_id,artifact_hash,expected_previous_hash}))`.
 */
export function computeRegistrationHash(fields: RegistrationHashFields): Hash {
  return canonicalHash({
    schema_version: "rsi.adapter_registration/1",
    host_id: fields.host_id,
    mode: fields.mode,
    config_space: fields.config_space,
    adapter_id: fields.adapter_id,
    adapter_version: fields.adapter_version,
    implementation_hash: fields.implementation_hash,
    descriptor_hash: fields.descriptor_hash,
    target_id: fields.target_id,
    artifact_hash: fields.artifact_hash,
    expected_previous_hash: fields.expected_previous_hash
  });
}

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

const HOST_ID_VALUES: readonly HostId[] = Object.freeze([
  "pi",
  "oh-my-pi",
  "step-code",
  "codex",
  "opencode",
  "openhands-sdk",
  "claude-code"
]);

const HOST_MODE_VALUES: readonly HostMode[] = Object.freeze([
  "interactive",
  "print",
  "rpc",
  "acp",
  "sdk",
  "sdk_stdio",
  "exec",
  "app-server",
  "server",
  "local_conversation",
  "remote_conversation"
]);

const LOAD_BOUNDARY_VALUES: readonly LoadBoundary[] = Object.freeze([
  "next_request",
  "reload",
  "new_session",
  "restart",
  "unknown"
]);

const TRIGGER_KIND_VALUES: readonly string[] = Object.freeze([
  "new_input",
  "tool_fact",
  "compaction",
  "task_boundary_candidate",
  "task_stable",
  "session_end",
  "user_review_request",
  "experience_trigger",
  "config_signal"
]);

const NATIVE_KIND_VALUES: readonly string[] = Object.freeze([
  "message",
  "turn",
  "event",
  "prompt",
  "other"
]);

const CONFIG_SPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isSortedUniqueUtf8(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) {
      return false;
    }
    if (compareUtf8(previous, current) >= 0) {
      return false;
    }
  }
  return true;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function validateEventContract(contract: EventContract, violations: string[], index: number): void {
  const prefix = `event_contracts[${String(index)}]`;
  if (contract.host_event.length === 0) {
    violations.push(`${prefix}.host_event: empty`);
  }
  if (!NATIVE_KIND_VALUES.includes(contract.native_kind)) {
    violations.push(`${prefix}.native_kind: ${contract.native_kind} is not a NativeMessageKind`);
  }
  if (hasDuplicates(contract.canonical_kinds)) {
    violations.push(`${prefix}.canonical_kinds: duplicate`);
  }
  for (const kind of contract.canonical_kinds) {
    if (!TRIGGER_KIND_VALUES.includes(kind)) {
      violations.push(`${prefix}.canonical_kinds: ${kind} is not a TriggerKind`);
    }
  }
  const hasNewInput = contract.canonical_kinds.includes("new_input");
  if (hasNewInput && (contract.canonical_kinds.length !== 1 || contract.canonical_kinds[0] !== "new_input")) {
    violations.push(`${prefix}.canonical_kinds: new_input must be the only kind`);
  }
  if (contract.canonical_kinds.length === 0 && !isOpenCodeObservationEvent(contract.host_event)) {
    violations.push(`${prefix}.canonical_kinds: empty is only allowed for observation events`);
  }
  if (hasDuplicates(contract.required_capabilities)) {
    violations.push(`${prefix}.required_capabilities: duplicate`);
  }
  for (const capability of contract.required_capabilities) {
    if (!isCapabilityName(capability)) {
      violations.push(`${prefix}.required_capabilities: ${capability} is not a CapabilityName`);
    }
    if (capability === HOST_RESERVED_CAPABILITY) {
      violations.push(`${prefix}.required_capabilities: ${capability} is HOST-reserved`);
    }
  }
}

/**
 * Validates a descriptor against the DD-HOST-001 producer table. Returns the
 * violation list in declaration order; an empty list means valid.
 */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  const violations: string[] = [];
  if (descriptor.schema_version !== "rsi.adapter_descriptor/1") {
    violations.push("schema_version: expected rsi.adapter_descriptor/1");
  }
  if (!isId(descriptor.adapter_id, "adp")) {
    violations.push(`adapter_id: ${String(descriptor.adapter_id)} is not an adp id`);
  }
  if (!HOST_ID_VALUES.includes(descriptor.host_id)) {
    violations.push(`host_id: ${String(descriptor.host_id)} is not a HostId`);
  }
  if (!SEMVER_PATTERN.test(descriptor.adapter_version)) {
    violations.push(`adapter_version: ${descriptor.adapter_version} is not semver`);
  }
  if (!isHash(descriptor.implementation_hash)) {
    violations.push("implementation_hash: not a canonical hash");
  }
  if (descriptor.supported_modes.length === 0) {
    violations.push("supported_modes: empty");
  }
  if (!isSortedUniqueUtf8(descriptor.supported_modes)) {
    violations.push("supported_modes: must be unique and UTF-8 sorted");
  }
  for (const mode of descriptor.supported_modes) {
    if (!HOST_MODE_VALUES.includes(mode)) {
      violations.push(`supported_modes: ${mode} is not a HostMode`);
    }
  }
  if (descriptor.config_spaces.length === 0) {
    violations.push("config_spaces: empty");
  }
  if (!isSortedUniqueUtf8(descriptor.config_spaces)) {
    violations.push("config_spaces: must be unique and UTF-8 sorted");
  }
  for (const space of descriptor.config_spaces) {
    if (!CONFIG_SPACE_PATTERN.test(space)) {
      violations.push(`config_spaces: ${space} does not match the config space token pattern`);
    }
  }

  const targetIds = descriptor.registration_targets.map((target) => target.target_id);
  if (hasDuplicates(targetIds)) {
    violations.push("registration_targets.target_id: duplicate");
  }
  const targetSpaces = new Set<string>();
  descriptor.registration_targets.forEach((target, index) => {
    const prefix = `registration_targets[${String(index)}]`;
    if (target.target_id.length === 0) {
      violations.push(`${prefix}.target_id: empty`);
    }
    if (target.scope !== "user" && target.scope !== "project" && target.scope !== "managed") {
      violations.push(`${prefix}.scope: ${String(target.scope)} is not a scope`);
    }
    if (
      target.kind !== "extension" &&
      target.kind !== "plugin" &&
      target.kind !== "hook_config" &&
      target.kind !== "sdk_package"
    ) {
      violations.push(`${prefix}.kind: ${String(target.kind)} is not a target kind`);
    }
    if (!LOAD_BOUNDARY_VALUES.includes(target.load_boundary)) {
      violations.push(`${prefix}.load_boundary: ${String(target.load_boundary)} is not a LoadBoundary`);
    }
    if ((target.kind !== "hook_config" || target.scope !== "managed") && target.marker_id !== null) {
      violations.push(`${prefix}.marker_id: only a managed hook_config target may carry a marker`);
    }
    targetSpaces.add(target.config_space);
  });
  const declaredSpaces = [...targetSpaces].sort(compareUtf8);
  if (declaredSpaces.length !== descriptor.config_spaces.length) {
    violations.push("config_spaces: must equal registration_targets[].config_space");
  } else {
    for (let index = 0; index < declaredSpaces.length; index += 1) {
      if (declaredSpaces[index] !== descriptor.config_spaces[index]) {
        violations.push("config_spaces: must equal registration_targets[].config_space");
        break;
      }
    }
  }

  const eventNames = descriptor.event_contracts.map((entry) => entry.host_event);
  if (hasDuplicates(eventNames)) {
    violations.push("event_contracts.host_event: duplicate");
  }
  descriptor.event_contracts.forEach((entry, index) => validateEventContract(entry, violations, index));

  if (descriptor.declared_capabilities.length === 0) {
    violations.push("declared_capabilities: empty");
  }
  if (!isSortedUniqueUtf8(descriptor.declared_capabilities)) {
    violations.push("declared_capabilities: must be unique and UTF-8 sorted");
  }
  for (const capability of descriptor.declared_capabilities) {
    if (!isCapabilityName(capability)) {
      violations.push(`declared_capabilities: ${capability} is not a CapabilityName`);
    }
    if (capability === HOST_RESERVED_CAPABILITY) {
      violations.push(`declared_capabilities: ${capability} is HOST-reserved`);
    }
  }
  return Object.freeze([...violations]);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const OPENCODE_DESCRIPTOR_HASH: Hash = computeDescriptorHash(OPENCODE_ADAPTER_DESCRIPTOR);
