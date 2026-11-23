/**
 * Shared adapter descriptor projections, hashes and validation
 * (DD-HOST-001, DD-HOST-010, DD-HOST-110).
 *
 * The projections are fixed by DD-HOST-001; adapters reuse them verbatim so a
 * descriptor hash is computed the same way for every host.
 */

import {
  canonicalHash,
  compareUtf8,
  isHash,
  isId,
  type Hash,
  type Id,
  type JsonValue
} from "@evoplug/core";

import { HOST_RESERVED_CAPABILITY, isCapabilityName } from "./capabilities.js";
import type {
  AdapterDescriptor,
  ConfigSpace,
  EventContract,
  HostId,
  HostMode,
  LoadBoundary
} from "./contract.js";

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

const NATIVE_KIND_VALUES: readonly string[] = Object.freeze(["message", "turn", "event", "prompt", "other"]);

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

function validateEventContract(
  contract: EventContract,
  violations: string[],
  index: number,
  isObservationEvent: (hostEvent: string) => boolean
): void {
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
  if (contract.canonical_kinds.length === 0 && !isObservationEvent(contract.host_event)) {
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
export function validateAdapterDescriptor(
  descriptor: AdapterDescriptor,
  isObservationEvent: (hostEvent: string) => boolean
): readonly string[] {
  const violations: string[] = [];
  if (descriptor.schema_version !== "rsi.adapter_descriptor/1") {
    violations.push(`schema_version: expected rsi.adapter_descriptor/1`);
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
    violations.push(`implementation_hash: not a canonical hash`);
  }
  if (descriptor.supported_modes.length === 0) {
    violations.push(`supported_modes: empty`);
  }
  if (!isSortedUniqueUtf8(descriptor.supported_modes)) {
    violations.push(`supported_modes: must be unique and UTF-8 sorted`);
  }
  for (const mode of descriptor.supported_modes) {
    if (!HOST_MODE_VALUES.includes(mode)) {
      violations.push(`supported_modes: ${mode} is not a HostMode`);
    }
  }
  if (descriptor.config_spaces.length === 0) {
    violations.push(`config_spaces: empty`);
  }
  if (!isSortedUniqueUtf8(descriptor.config_spaces)) {
    violations.push(`config_spaces: must be unique and UTF-8 sorted`);
  }
  for (const space of descriptor.config_spaces) {
    if (!CONFIG_SPACE_PATTERN.test(space)) {
      violations.push(`config_spaces: ${space} does not match the config space token pattern`);
    }
  }

  const targetIds = descriptor.registration_targets.map((target) => target.target_id);
  if (hasDuplicates(targetIds)) {
    violations.push(`registration_targets.target_id: duplicate`);
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
    violations.push(`config_spaces: must equal registration_targets[].config_space`);
  } else {
    for (let index = 0; index < declaredSpaces.length; index += 1) {
      if (declaredSpaces[index] !== descriptor.config_spaces[index]) {
        violations.push(`config_spaces: must equal registration_targets[].config_space`);
        break;
      }
    }
  }

  const eventNames = descriptor.event_contracts.map((entry) => entry.host_event);
  if (hasDuplicates(eventNames)) {
    violations.push(`event_contracts.host_event: duplicate`);
  }
  descriptor.event_contracts.forEach((entry, index) =>
    validateEventContract(entry, violations, index, isObservationEvent)
  );

  if (descriptor.declared_capabilities.length === 0) {
    violations.push(`declared_capabilities: empty`);
  }
  if (!isSortedUniqueUtf8(descriptor.declared_capabilities)) {
    violations.push(`declared_capabilities: must be unique and UTF-8 sorted`);
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

