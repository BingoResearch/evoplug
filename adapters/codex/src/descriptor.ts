/**
 * Codex `AdapterDescriptor` (DD-HOST-001, DD-HOST-040, DD-HOST-110).
 *
 * The descriptor is built once from the Codex install/observation table,
 * frozen, and returned by `describe()`. Host core validates it again and
 * freezes the JCS snapshot before registration; this module therefore also
 * exposes the exact hash formulas so the adapter can verify its own request
 * inputs without creating a second schema.
 *
 * DD-HOST-040: `mapping=unmapped`; the installed 0.160.1 build cannot inherit
 * source-derived capability from commit `e18a20d6…`. Modes and config spaces
 * are the design's closed lists, not capability claims.
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

import { CODEX_DECLARED_CAPABILITIES, HOST_RESERVED_CAPABILITY, isCapabilityName } from "./capabilities.js";
import type {
  AdapterDescriptor,
  ConfigSpace,
  EventContract,
  HostId,
  HostMode,
  LoadBoundary,
  RegistrationTarget
} from "./contract.js";
import { CODEX_EVENT_CONTRACTS, isCodexObservationEvent } from "./events.js";
import { CODEX_ADAPTER_ID, CODEX_ADAPTER_VERSION, CODEX_HOST_ID, CODEX_IMPLEMENTATION_HASH } from "./manifest.js";

/**
 * Modes Codex exposes to the adapter (DD-HOST-040): `interactive`, `exec`,
 * `app-server`, and `sdk` (SDK spawns the CLI). UTF-8 sorted.
 */
export const CODEX_SUPPORTED_MODES: readonly HostMode[] = Object.freeze([
  "app-server",
  "exec",
  "interactive",
  "sdk"
]);

/**
 * Config spaces Codex exposes: `$CODEX_HOME` (`user`), the trusted and
 * untrusted project layers, and the managed policy layer. Layer precedence is
 * low to high; a project layer is ineffective while the project is untrusted.
 */
export const CODEX_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze([
  "managed",
  "project_trusted",
  "project_untrusted",
  "user"
]);

/**
 * Registration targets from the Codex section, in design order.
 *
 * Hooks are discovered in `hooks.json` or config TOML at every layer; only
 * enabled and trusted/bypass handlers execute. `refresh_hooks` reloads hooks,
 * while session-static model and instruction state needs a new session, so
 * every target declares `load_boundary="reload"` for the hook artifact.
 * The untrusted project layer is declared but cannot take effect, so its
 * boundary stays `unknown`.
 */
export const CODEX_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  Object.freeze({
    target_id: "codex.runtime.user",
    config_space: "user",
    scope: "user",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.runtime.project_trusted",
    config_space: "project_trusted",
    scope: "project",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.runtime.project_untrusted",
    config_space: "project_untrusted",
    scope: "project",
    kind: "extension",
    load_boundary: "unknown",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.user",
    config_space: "user",
    scope: "user",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.project_trusted",
    config_space: "project_trusted",
    scope: "project",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.project_untrusted",
    config_space: "project_untrusted",
    scope: "project",
    kind: "hook_config",
    load_boundary: "unknown",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.managed",
    config_space: "managed",
    scope: "managed",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: "codex/hooks"
  })
] satisfies readonly RegistrationTarget[]);

/** Frozen descriptor returned by `describe()`. */
export const CODEX_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: CODEX_ADAPTER_ID,
  host_id: CODEX_HOST_ID,
  adapter_version: CODEX_ADAPTER_VERSION,
  implementation_hash: CODEX_IMPLEMENTATION_HASH,
  supported_modes: CODEX_SUPPORTED_MODES,
  config_spaces: CODEX_CONFIG_SPACES,
  registration_targets: CODEX_REGISTRATION_TARGETS,
  event_contracts: CODEX_EVENT_CONTRACTS,
  declared_capabilities: CODEX_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describeCodexAdapter(): AdapterDescriptor {
  return CODEX_ADAPTER_DESCRIPTOR;
}

/**
 * Construction path for a mode (DD-HOST-110 exact table, no aliases):
 * `interactive`/`exec` → `cli`; `app-server` → `app_server`; `sdk` → `sdk`.
 */
export function codexConstructionPathForMode(mode: HostMode): string | null {
  switch (mode) {
    case "interactive":
    case "exec":
      return "cli";
    case "app-server":
      return "app_server";
    case "sdk":
      return "sdk";
    default:
      return null;
  }
}

/** True when the mode is declared by this adapter. */
export function isCodexMode(mode: HostMode): boolean {
  return CODEX_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isCodexConfigSpace(config_space: ConfigSpace): boolean {
  return CODEX_CONFIG_SPACES.includes(config_space);
}

/** Looks up a declared registration target by id. */
export function codexRegistrationTarget(target_id: string): RegistrationTarget | null {
  return CODEX_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
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

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(CODEX_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const CODEX_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
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

/** FND closed set for `EventDraft.native_kind` (DD-TRG-004). */
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
  if (contract.canonical_kinds.length === 0 && !isCodexObservationEvent(contract.host_event)) {
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
  descriptor.event_contracts.forEach((entry, index) => validateEventContract(entry, violations, index));

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

/** Frozen descriptor hash reused by registration-hash verification. */
export const CODEX_DESCRIPTOR_HASH: Hash = computeDescriptorHash(CODEX_ADAPTER_DESCRIPTOR);
