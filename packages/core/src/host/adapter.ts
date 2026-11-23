/**
 * HostAdapter contract validation and registration algebra (DD-HOST-001).
 *
 * `HostAdapter`, `AdapterDescriptor` and the registration DTOs live in
 * `types.ts`; this module owns their runtime validation and the descriptor /
 * registration hashes.
 */

import type { ErrorEnvelope } from "../errors.js";
import { makeErrorEnvelope } from "../errors.js";
import type { Hash } from "../hash.js";
import { isHash } from "../hash.js";
import type { Id } from "../ids.js";
import { err, ok, type Result } from "../result.js";
import { isHostId, isHostMode } from "../generated/host-vocabulary.js";
import type {
  ActiveAdapterRegistration,
  AdapterDescriptor,
  AdapterEventContract,
  CapabilityName,
  HostEventBinding,
  LoadBoundary,
  NativeMessageKind,
  RegistrationRequest,
  RegistrationState
} from "./types.js";
import { adapterDescriptorHash, registrationHash } from "./keys.js";
import { isCapabilityName, CAPABILITY_NAMES } from "./capability/record.js";
import { isConfigSpaceToken, isRecord, isSafePositiveInt, isUtf8SortedUnique } from "./validation.js";

const NATIVE_MESSAGE_KINDS: readonly NativeMessageKind[] = [
  "input.received",
  "input.retry",
  "agent.message",
  "tool.call",
  "tool.result",
  "host.boundary",
  "compaction.observed",
  "subagent.started",
  "subagent.ended",
  "delivery.receipt",
  "feedback.observed",
  "host.unclassified",
  "message",
  "turn",
  "event",
  "prompt",
  "other"
];

const LOAD_BOUNDARIES: readonly LoadBoundary[] = ["next_request", "reload", "new_session", "restart", "unknown"];

const TARGET_KINDS: readonly string[] = ["extension", "plugin", "hook_config", "sdk_package"];

const RESERVED_CAPABILITY = "generation.service_profile";

const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function descriptorError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "adapter_descriptor_validate",
    details: { kind: "field", path, rule }
  });
}

/** Validates every `AdapterDescriptor` field that has a builder-time owner. */
export function validateAdapterDescriptor(value: unknown): Result<AdapterDescriptor, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(descriptorError("$", "object"));
  }
  for (const field of [
    "schema_version",
    "adapter_id",
    "host_id",
    "adapter_version",
    "implementation_hash",
    "supported_modes",
    "config_spaces",
    "registration_targets",
    "event_contracts",
    "declared_capabilities"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      return err(descriptorError(field, "required"));
    }
  }
  if (value["schema_version"] !== "rsi.adapter_descriptor/1") {
    return err(descriptorError("schema_version", "rsi.adapter_descriptor/1"));
  }
  const adapterId = value["adapter_id"];
  if (typeof adapterId !== "string" || !adapterId.startsWith("adp:")) {
    return err(descriptorError("adapter_id", "adp_id"));
  }
  const hostId = value["host_id"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return err(descriptorError("host_id", "host_id"));
  }
  const adapterVersion = value["adapter_version"];
  if (typeof adapterVersion !== "string" || !SEMVER_PATTERN.test(adapterVersion)) {
    return err(descriptorError("adapter_version", "semver"));
  }
  const implementationHash = value["implementation_hash"];
  if (typeof implementationHash !== "string" || !isHash(implementationHash)) {
    return err(descriptorError("implementation_hash", "sha256_hash"));
  }
  const modes = value["supported_modes"];
  if (
    !Array.isArray(modes) ||
    modes.length === 0 ||
    !modes.every((mode) => typeof mode === "string" && isHostMode(mode)) ||
    !isUtf8SortedUnique(modes)
  ) {
    return err(descriptorError("supported_modes", "sorted_unique_host_modes"));
  }
  const configSpaces = value["config_spaces"];
  if (!Array.isArray(configSpaces) || configSpaces.length === 0) {
    return err(descriptorError("config_spaces", "non_empty"));
  }
  for (const space of configSpaces) {
    if (typeof space !== "string" || !isConfigSpaceToken(space)) {
      return err(descriptorError("config_spaces", "config_space_token"));
    }
  }
  if (!isUtf8SortedUnique(configSpaces)) {
    return err(descriptorError("config_spaces", "sorted_unique"));
  }
  const targets = value["registration_targets"];
  if (!Array.isArray(targets)) {
    return err(descriptorError("registration_targets", "array"));
  }
  const targetIds = new Set<string>();
  const declaredSpaces = new Set<string>();
  const parsedTargets: AdapterDescriptor["registration_targets"] = [];
  for (const target of targets) {
    if (
      !isRecord(target) ||
      typeof target["target_id"] !== "string" ||
      target["target_id"].length === 0 ||
      typeof target["config_space"] !== "string" ||
      !isConfigSpaceToken(target["config_space"]) ||
      (target["scope"] !== "user" && target["scope"] !== "project" && target["scope"] !== "managed") ||
      typeof target["kind"] !== "string" ||
      !TARGET_KINDS.includes(target["kind"]) ||
      typeof target["load_boundary"] !== "string" ||
      !(LOAD_BOUNDARIES as readonly string[]).includes(target["load_boundary"]) ||
      (target["marker_id"] !== null && typeof target["marker_id"] !== "string")
    ) {
      return err(descriptorError("registration_targets", "target_shape"));
    }
    if (targetIds.has(target["target_id"])) {
      return err(descriptorError("registration_targets.target_id", "unique"));
    }
    targetIds.add(target["target_id"]);
    declaredSpaces.add(target["config_space"]);
    const markerId = target["marker_id"];
    const isManagedBlock = target["scope"] === "managed" && target["kind"] === "hook_config";
    if ((markerId === null) === isManagedBlock) {
      return err(descriptorError("registration_targets.marker_id", "managed_block_only"));
    }
    parsedTargets.push({
      target_id: target["target_id"],
      config_space: target["config_space"],
      scope: target["scope"] as AdapterDescriptor["registration_targets"][number]["scope"],
      kind: target["kind"] as AdapterDescriptor["registration_targets"][number]["kind"],
      load_boundary: target["load_boundary"] as LoadBoundary,
      marker_id: markerId as string | null
    });
  }
  const targetSpaces = Array.from(declaredSpaces).sort();
  if (targetSpaces.length !== configSpaces.length || targetSpaces.some((space, index) => space !== configSpaces[index])) {
    return err(descriptorError("config_spaces", "equals_registration_targets"));
  }
  const contracts = value["event_contracts"];
  if (!Array.isArray(contracts) || contracts.length === 0) {
    return err(descriptorError("event_contracts", "non_empty"));
  }
  const eventNames = new Set<string>();
  const parsedContracts: AdapterEventContract[] = [];
  for (const contract of contracts) {
    if (
      !isRecord(contract) ||
      typeof contract["host_event"] !== "string" ||
      contract["host_event"].length === 0 ||
      typeof contract["native_kind"] !== "string" ||
      !(NATIVE_MESSAGE_KINDS as readonly string[]).includes(contract["native_kind"]) ||
      !Array.isArray(contract["canonical_kinds"]) ||
      !Array.isArray(contract["required_capabilities"])
    ) {
      return err(descriptorError("event_contracts", "event_contract_shape"));
    }
    if (eventNames.has(contract["host_event"])) {
      return err(descriptorError("event_contracts.host_event", "unique"));
    }
    eventNames.add(contract["host_event"]);
    const canonicalKinds = contract["canonical_kinds"];
    if (
      !canonicalKinds.every((kind) => typeof kind === "string") ||
      !isUtf8SortedUnique(canonicalKinds)
    ) {
      return err(descriptorError("event_contracts.canonical_kinds", "sorted_unique"));
    }
    const hasNewInput = canonicalKinds.includes("new_input");
    if (hasNewInput && (canonicalKinds.length !== 1 || canonicalKinds[0] !== "new_input")) {
      return err(descriptorError("event_contracts.canonical_kinds", "new_input_alone"));
    }
    for (const capability of contract["required_capabilities"]) {
      if (typeof capability !== "string" || !isCapabilityName(capability)) {
        return err(descriptorError("event_contracts.required_capabilities", "capability_name"));
      }
      if (capability === RESERVED_CAPABILITY) {
        return err(descriptorError("event_contracts.required_capabilities", "reserved_capability"));
      }
    }
    parsedContracts.push({
      host_event: contract["host_event"],
      native_kind: contract["native_kind"] as NativeMessageKind,
      canonical_kinds: canonicalKinds as AdapterDescriptor["event_contracts"][number]["canonical_kinds"],
      required_capabilities: contract["required_capabilities"] as CapabilityName[]
    });
  }
  const declaredCapabilities = value["declared_capabilities"];
  if (
    !Array.isArray(declaredCapabilities) ||
    declaredCapabilities.length === 0 ||
    !declaredCapabilities.every((entry) => typeof entry === "string" && isCapabilityName(entry)) ||
    !isUtf8SortedUnique(declaredCapabilities)
  ) {
    return err(descriptorError("declared_capabilities", "sorted_unique_capabilities"));
  }
  if (declaredCapabilities.includes(RESERVED_CAPABILITY)) {
    return err(descriptorError("declared_capabilities", "reserved_capability"));
  }
  return ok({
    schema_version: "rsi.adapter_descriptor/1",
    adapter_id: adapterId as AdapterDescriptor["adapter_id"],
    host_id: hostId,
    adapter_version: adapterVersion,
    implementation_hash: implementationHash as Hash,
    supported_modes: modes as AdapterDescriptor["supported_modes"],
    config_spaces: configSpaces as string[],
    registration_targets: parsedTargets,
    event_contracts: parsedContracts,
    declared_capabilities: declaredCapabilities as CapabilityName[]
  });
}

/** `descriptor_hash = sha256(JCS(descriptor))`; the descriptor must be valid. */
export function computeDescriptorHash(descriptor: AdapterDescriptor): Hash {
  return adapterDescriptorHash(descriptor);
}

/** Validates a registration request's shape and closed fields. */
export function validateRegistrationRequest(value: unknown): Result<RegistrationRequest, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(descriptorError("$", "object"));
  }
  if (value["schema_version"] !== "rsi.registration_request/1") {
    return err(descriptorError("schema_version", "rsi.registration_request/1"));
  }
  if (typeof value["request_id"] !== "string" || value["request_id"].length === 0 || value["request_id"].length > 128) {
    return err(descriptorError("request_id", "1..128"));
  }
  if (typeof value["registration_hash"] !== "string" || !isHash(value["registration_hash"])) {
    return err(descriptorError("registration_hash", "sha256_hash"));
  }
  if (typeof value["host_id"] !== "string" || !isHostId(value["host_id"])) {
    return err(descriptorError("host_id", "host_id"));
  }
  if (typeof value["mode"] !== "string" || !isHostMode(value["mode"])) {
    return err(descriptorError("mode", "host_mode"));
  }
  if (typeof value["config_space"] !== "string" || !isConfigSpaceToken(value["config_space"])) {
    return err(descriptorError("config_space", "config_space_token"));
  }
  if (typeof value["adapter_id"] !== "string" || !value["adapter_id"].startsWith("adp:")) {
    return err(descriptorError("adapter_id", "adp_id"));
  }
  if (typeof value["adapter_version"] !== "string" || !SEMVER_PATTERN.test(value["adapter_version"])) {
    return err(descriptorError("adapter_version", "semver"));
  }
  if (typeof value["implementation_hash"] !== "string" || !isHash(value["implementation_hash"])) {
    return err(descriptorError("implementation_hash", "sha256_hash"));
  }
  if (typeof value["target_id"] !== "string" || value["target_id"].length === 0) {
    return err(descriptorError("target_id", "non_empty_string"));
  }
  if (!isSafePositiveInt(value["deadline_ms"]) || value["deadline_ms"] > 600_000) {
    return err(descriptorError("deadline_ms", "1..600000"));
  }
  if (typeof value["artifact_ref"] !== "string") {
    return err(descriptorError("artifact_ref", "source_ref"));
  }
  if (typeof value["artifact_hash"] !== "string" || !isHash(value["artifact_hash"])) {
    return err(descriptorError("artifact_hash", "sha256_hash"));
  }
  const expectedPrevious = value["expected_previous_hash"];
  if (expectedPrevious !== null && (typeof expectedPrevious !== "string" || !isHash(expectedPrevious))) {
    return err(descriptorError("expected_previous_hash", "hash_or_null"));
  }
  const approval = value["approval"];
  if (approval !== null) {
    if (
      !isRecord(approval) ||
      typeof approval["approval_id"] !== "string" ||
      !approval["approval_id"].startsWith("iap:") ||
      typeof approval["approval_hash"] !== "string" ||
      !isHash(approval["approval_hash"])
    ) {
      return err(descriptorError("approval", "approval_ref"));
    }
  }
  if (typeof value["dry_run"] !== "boolean") {
    return err(descriptorError("dry_run", "boolean"));
  }
  let parsedApproval: { approval_id: Id<"iap">; approval_hash: Hash } | null = null;
  if (approval !== null) {
    parsedApproval = {
      approval_id: approval["approval_id"] as Id<"iap">,
      approval_hash: approval["approval_hash"] as Hash
    };
  }
  return ok({
    schema_version: "rsi.registration_request/1",
    request_id: value["request_id"],
    registration_hash: value["registration_hash"] as Hash,
    host_id: value["host_id"],
    adapter_id: value["adapter_id"] as Id<"adp">,
    adapter_version: value["adapter_version"],
    implementation_hash: value["implementation_hash"] as Hash,
    mode: value["mode"],
    config_space: value["config_space"],
    target_id: value["target_id"],
    dry_run: value["dry_run"],
    artifact_ref: value["artifact_ref"] as RegistrationRequest["artifact_ref"],
    artifact_hash: value["artifact_hash"] as Hash,
    expected_previous_hash: expectedPrevious === null ? null : (expectedPrevious as Hash),
    approval: parsedApproval,
    deadline_ms: value["deadline_ms"]
  });
}

/** Recomputes the registration hash from the request coordinates. */
export function computeRegistrationHash(input: {
  host_id: string;
  mode: string;
  config_space: string;
  adapter_id: string;
  adapter_version: string;
  implementation_hash: Hash;
  descriptor_hash: Hash;
  target_id: string;
  artifact_hash: Hash;
  expected_previous_hash: Hash | null;
}): Hash {
  return registrationHash(input);
}

const REGISTRATION_TRANSITIONS: Readonly<Record<RegistrationState, readonly RegistrationState[]>> = {
  intent: ["applying", "failed"],
  applying: ["applied", "failed", "unknown"],
  unknown: ["applied", "failed"],
  applied: ["superseded", "detached"],
  failed: [],
  superseded: [],
  detached: []
};

/** True only for edges in the registration state machine. */
export function canTransitionRegistration(from: RegistrationState, to: RegistrationState): boolean {
  return REGISTRATION_TRANSITIONS[from].includes(to);
}

/** Builds the immutable active-registration view used by event admission. */
export function activeRegistrationFromDescriptor(input: {
  registration_hash: Hash;
  descriptor: AdapterDescriptor;
  mode: HostEventBinding["mode"];
  config_space: string;
  applied_at: number;
}): ActiveAdapterRegistration {
  return {
    schema_version: "rsi.active_adapter_registration/1",
    registration_hash: input.registration_hash,
    adapter_id: input.descriptor.adapter_id,
    host_id: input.descriptor.host_id,
    mode: input.mode,
    config_space: input.config_space,
    adapter_version: input.descriptor.adapter_version,
    implementation_hash: input.descriptor.implementation_hash,
    descriptor_hash: adapterDescriptorHash(input.descriptor),
    config_spaces: input.descriptor.config_spaces,
    event_contracts: input.descriptor.event_contracts,
    applied_at: input.applied_at
  };
}

/** Capability names permitted in a descriptor; re-exported for adapters. */
export const ADAPTER_CAPABILITY_NAMES: readonly CapabilityName[] = CAPABILITY_NAMES.filter(
  (name) => name !== RESERVED_CAPABILITY
);
