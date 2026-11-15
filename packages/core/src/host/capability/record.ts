/**
 * Capability four-state records, v1 migration, probe application and gates
 * (DD-CAP-001 … DD-CAP-008).
 *
 * `blocked` belongs only to `HostProbeRecord.result`; it never becomes a
 * capability status. Static or loaded evidence raises `evidence_stage` but
 * leaves the status `unknown`.
 */

import type { ErrorEnvelope } from "../../errors.js";
import { makeErrorEnvelope } from "../../errors.js";
import type { Hash } from "../../hash.js";
import { isHash } from "../../hash.js";
import type { Id } from "../../ids.js";
import { isHostId, isHostMode } from "../../generated/host-vocabulary.js";
import { computeCapabilitySnapshotHash } from "./snapshot.js";
import { err, ok, type Result } from "../../result.js";
import type {
  CapabilityBinding,
  CapabilityDetailsMap,
  CapabilityName,
  CapabilityRecord,
  CapabilityRecordOf,
  CapabilityStatus,
  EvidenceStage,
  HostProbeRecord,
  InclusionLevel,
  LegacyCapabilityRecordV1,
  UnknownFact
} from "../types.js";
import { capabilityBindingKey } from "../keys.js";
import { isConfigSpaceToken, isRecord, isSafeNonNegativeInt } from "../validation.js";

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "input_capture",
  "sync_wait",
  "source_trust",
  "tool_id",
  "compaction_event",
  "request_observation",
  "managed_object_load",
  "online_delivery",
  "stable_boundary",
  "host_budget",
  "association",
  "human_interaction_attested",
  "capacity_window",
  "generation.service_profile",
  "generation.create",
  "generation.auth",
  "generation.cancel",
  "generation.recover",
  "generation.output"
];

export const GENERATION_ACTION_NAMES: readonly CapabilityName[] = [
  "generation.create",
  "generation.auth",
  "generation.cancel",
  "generation.recover",
  "generation.output"
];

export const INCLUSION_LEVEL_ORDER: readonly InclusionLevel[] = [
  "none",
  "constructive",
  "context_projection",
  "provider_payload",
  "transport_body"
];

export function isCapabilityName(value: string): value is CapabilityName {
  return (CAPABILITY_NAMES as readonly string[]).includes(value);
}

/** Inclusion ordering: `unknown` never satisfies a required level. */
export function meetsInclusionLevel(actual: InclusionLevel, required: InclusionLevel): boolean {
  if (actual === "unknown" || required === "unknown") {
    return false;
  }
  return INCLUSION_LEVEL_ORDER.indexOf(actual) >= INCLUSION_LEVEL_ORDER.indexOf(required);
}

function bindingError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "capability_binding_validate",
    details: { kind: "field", path, rule }
  });
}

const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Validates a `CapabilityBinding` including the B-01..B-12 rules. */
export function validateCapabilityBinding(
  value: unknown,
  options: { capabilityName?: CapabilityName } = {}
): Result<CapabilityBinding, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(bindingError("$", "object"));
  }
  for (const field of [
    "host_id",
    "source_pin",
    "binary_pin",
    "adapter_version",
    "subject",
    "mode",
    "config_space",
    "root_id",
    "construction_path",
    "execution_environment",
    "mapping"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      return err(bindingError(field, "required"));
    }
  }
  const sourcePin = value["source_pin"];
  const binaryPin = value["binary_pin"];
  const environment = value["execution_environment"];
  if (!isRecord(sourcePin) || !isRecord(binaryPin) || !isRecord(environment)) {
    return err(bindingError("source_pin", "object"));
  }
  const hostVersion = sourcePin["host_version"];
  const hostVersionKind = sourcePin["host_version_kind"];
  const sourceCommit = sourcePin["source_commit"];
  if (typeof hostVersion !== "string" || hostVersion.length === 0) {
    return err(bindingError("source_pin.host_version", "non_empty_string"));
  }
  if (hostVersionKind !== "release" && hostVersionKind !== "source_commit" && hostVersionKind !== "binary_hash") {
    return err(bindingError("source_pin.host_version_kind", "host_version_kind"));
  }
  if (hostVersionKind === "source_commit") {
    if (typeof sourceCommit !== "string" || sourceCommit.length === 0) {
      return err(bindingError("source_pin.source_commit", "source_commit_required"));
    }
    if (hostVersion !== `source:${sourceCommit}`) {
      return err(bindingError("source_pin.host_version", "source_prefix_commit"));
    }
  } else if (sourceCommit !== null && typeof sourceCommit !== "string") {
    return err(bindingError("source_pin.source_commit", "string_or_null"));
  }
  const binaryVersion = binaryPin["binary_version"];
  const binaryHash = binaryPin["binary_hash"];
  if (binaryVersion !== null && typeof binaryVersion !== "string") {
    return err(bindingError("binary_pin.binary_version", "string_or_null"));
  }
  if (binaryHash !== null && (typeof binaryHash !== "string" || !isHash(binaryHash))) {
    return err(bindingError("binary_pin.binary_hash", "hash_or_null"));
  }
  const adapterVersion = value["adapter_version"];
  if (typeof adapterVersion !== "string" || (adapterVersion !== "diagnostic" && !SEMVER_PATTERN.test(adapterVersion))) {
    return err(bindingError("adapter_version", "semver_or_diagnostic"));
  }
  const subject = value["subject"];
  if (subject !== "host_contract" && subject !== "product_adapter") {
    return err(bindingError("subject", "capability_subject"));
  }
  const configSpace = value["config_space"];
  if (!isConfigSpaceToken(configSpace)) {
    return err(bindingError("config_space", "config_space_token"));
  }
  const rootId = value["root_id"];
  if (
    typeof rootId !== "string" ||
    rootId.length === 0 ||
    rootId === "." ||
    rootId === ".." ||
    rootId.includes("/") ||
    rootId.includes("\\") ||
    rootId.includes("\u0000")
  ) {
    return err(bindingError("root_id", "opaque_root_id"));
  }
  const constructionPath = value["construction_path"];
  if (!isConfigSpaceToken(constructionPath)) {
    return err(bindingError("construction_path", "registered_token"));
  }
  const os = environment["os"];
  const arch = environment["arch"];
  const isolation = environment["isolation"];
  if (typeof os !== "string" || os.length === 0 || typeof arch !== "string" || arch.length === 0) {
    return err(bindingError("execution_environment", "os_arch"));
  }
  if (isolation !== "local" && isolation !== "container" && isolation !== "remote") {
    return err(bindingError("execution_environment.isolation", "isolation"));
  }
  const mapping = value["mapping"];
  if (mapping !== "exact" && mapping !== "partial" && mapping !== "unmapped") {
    return err(bindingError("mapping", "mapping"));
  }
  const backendId = value["backend_id"];
  if (backendId !== undefined && (typeof backendId !== "string" || backendId.length === 0)) {
    return err(bindingError("backend_id", "non_empty_string"));
  }
  if (
    options.capabilityName !== undefined &&
    options.capabilityName.startsWith("generation.") &&
    backendId === undefined
  ) {
    return err(bindingError("backend_id", "required_for_generation"));
  }
  const hostId = value["host_id"];
  const mode = value["mode"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return err(bindingError("host_id", "host_id"));
  }
  if (typeof mode !== "string" || !isHostMode(mode)) {
    return err(bindingError("mode", "host_mode"));
  }
  const binding: CapabilityBinding = {
    host_id: hostId,
    source_pin: {
      host_version: hostVersion,
      host_version_kind: hostVersionKind,
      source_commit: sourceCommit === undefined ? null : (sourceCommit as string | null)
    },
    binary_pin: {
      binary_version: binaryVersion === undefined ? null : (binaryVersion as string | null),
      binary_hash: binaryHash === undefined ? null : (binaryHash as Hash | null)
    },
    adapter_version: adapterVersion,
    subject,
    mode,
    config_space: configSpace,
    root_id: rootId,
    construction_path: constructionPath,
    execution_environment: { os, arch, isolation },
    mapping
  };
  if (typeof backendId === "string") {
    binding.backend_id = backendId;
  }
  return ok(binding);
}

/* ------------------------------------------------------------------ */
/* Default details for unknown/none records                            */
/* ------------------------------------------------------------------ */

function unknownFact(reason: string): UnknownFact {
  return { kind: "unknown", reason_code: reason };
}

/** Builds the closed `details` value for a capability with no evidence. */
export function unknownDetails(name: CapabilityName): CapabilityRecord["details"] {
  const unverified = unknownFact("unverified");
  switch (name) {
    case "input_capture":
      return {
        source_fields: [],
        raw_text_before_expansion: unverified,
        input_source_label: "untrusted",
        duplicate_handling: unverified,
        covered_modes: []
      } as CapabilityRecord["details"];
    case "sync_wait":
      return {
        boundary: "unknown",
        handler_timeout_ms: unverified,
        host_waits_for_handler: unverified,
        timeout_behavior: unverified,
        hard_block: unverified
      } as CapabilityRecord["details"];
    case "source_trust":
      return {
        trust_level: unverified,
        project_trust_gate: unverified,
        config_layers: [],
        highest_precedence: "unknown"
      } as CapabilityRecord["details"];
    case "tool_id":
      return {
        call_id_field: unverified,
        parent_call_field: unverified,
        result_join: unverified,
        parallel_safe: unverified
      } as CapabilityRecord["details"];
    case "compaction_event":
      return {
        events: [],
        reason: unverified,
        summary_available: unverified,
        pre_boundary: unverified,
        post_boundary: unverified,
        summary_replaces_history: unverified
      } as CapabilityRecord["details"];
    case "request_observation":
      return {
        max_level: "none",
        mechanisms: [],
        final_body_available: unverified,
        redaction: []
      } as CapabilityRecord["details"];
    case "managed_object_load":
      return {
        reload_boundary: unverified,
        hot_reload: unverified,
        load_signal: unverified,
        readback: unverified
      } as CapabilityRecord["details"];
    case "online_delivery":
      return {
        return_entry: "unknown",
        transport: unverified,
        max_text_chars: unverified,
        inclusion_level: "none",
        accepted_signal: unverified,
        can_replace_user_text: unverified,
        async_first_request: unverified,
        block_with_context: "unknown"
      } as CapabilityRecord["details"];
    case "stable_boundary":
      return {
        candidate_events: [],
        stable_events: [],
        review_boundary_facets: [],
        pending_fields: [],
        pending_semantics: "unknown",
        stable_predicate_ref: unverified,
        background_work_visible: unverified,
        exit_budget_ms: unverified
      } as CapabilityRecord["details"];
    case "host_budget":
      return {
        handler_timeout_ms: unverified,
        total_budget_ms: unverified,
        serial_chain: unverified,
        timeout_behavior: unverified,
        hard_block: unverified,
        reserve_ms: 0
      } as CapabilityRecord["details"];
    case "association":
      return {
        message_join: unverified,
        tool_join: unverified,
        injection_id_preserved: unverified,
        native_ids: [],
        text_fallback: false
      } as CapabilityRecord["details"];
    case "human_interaction_attested":
      return {
        proof_kinds: [],
        subject_kinds: [],
        control_plane_purposes: [],
        evidence_schema: "rsi.human_proof_evidence/1",
        max_attestation_age_ms: 0
      } as CapabilityRecord["details"];
    case "capacity_window":
      return {
        scope: "window_tokens",
        unit: "tokens",
        readback_method: unverified,
        model_scope_keys: [],
        evidence_schema: "rsi.capacity_evidence_payload/1"
      } as CapabilityRecord["details"];
    case "generation.service_profile":
      return {
        profile_schema: "rsi.service_profile/1",
        evidence_schema: "rsi.service_profile_evidence/1",
        provider_scope: "unknown",
        profile_key: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        observed_at: 0
      } as CapabilityRecord["details"];
    case "generation.create":
      return {
        entry_kind: "host_subagent",
        entry_ref: "unknown",
        backend_version: unverified,
        protocol_versions: [],
        isolation: { mode: unverified, network: unverified, evidence_refs: [] },
        idempotent: unverified,
        max_concurrent: unverified,
        supported_resume: unverified
      } as CapabilityRecord["details"];
    case "generation.auth":
      return {
        mechanism: unverified,
        credential_ref_kind: unverified,
        profile_ref: unverified,
        data_scope: unverified,
        host_login_reuse: unverified,
        expiry_semantics: unverified
      } as CapabilityRecord["details"];
    case "generation.cancel":
      return {
        method: unverified,
        propagates_to_children: unverified,
        idempotent: unverified,
        cancel_window_ms: unverified,
        post_effect: unverified
      } as CapabilityRecord["details"];
    case "generation.recover":
      return {
        resume_kind: unverified,
        recovery_boundary: unverified,
        durable_state: unverified,
        lost_work_semantics: unverified
      } as CapabilityRecord["details"];
    case "generation.output":
      return {
        protocol: unverified,
        schema_ref: unverified,
        streaming: unverified,
        max_bytes: unverified,
        final_state_signal: unverified,
        artifact_refs: unverified
      } as CapabilityRecord["details"];
  }
  throw new RangeError(`unknown capability details: ${String(name)}`);
}

/* ------------------------------------------------------------------ */
/* Record construction and validation                                  */
/* ------------------------------------------------------------------ */

export function makeUnknownCapabilityRecord(input: {
  capability_id: Id<"cap">;
  name: CapabilityName;
  binding: CapabilityBinding;
  checked_at: number;
}): CapabilityRecord {
  return {
    schema_version: "rsi.capability/2",
    capability_id: input.capability_id,
    binding: input.binding,
    binding_key: capabilityBindingKey(input.binding),
    name: input.name,
    status: "unknown",
    evidence_stage: "none",
    evidence_refs: [],
    checked_at: input.checked_at,
    details: unknownDetails(input.name)
  } as CapabilityRecord;
}

/** Structural validation of a `CapabilityRecord/2`, plus key semantic gates. */
export function validateCapabilityRecord(
  value: unknown
): Result<CapabilityRecord, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(makeErrorEnvelope({
      code: "E_SCHEMA",
      category: "schema",
      message_key: "error.schema",
      stage: "capability_record_validate",
      details: { kind: "field", path: "$", rule: "object" }
    }));
  }
  const name = value["name"];
  if (typeof name !== "string" || !isCapabilityName(name)) {
    return err(capabilityError("name", "capability_name"));
  }
  for (const field of [
    "schema_version",
    "capability_id",
    "binding",
    "binding_key",
    "status",
    "evidence_stage",
    "evidence_refs",
    "checked_at",
    "details"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      return err(capabilityError(field, "required"));
    }
  }
  if (value["schema_version"] !== "rsi.capability/2") {
    return err(capabilityError("schema_version", "rsi.capability/2"));
  }
  const status = value["status"];
  if (status !== "unknown" && status !== "verified" && status !== "unsupported" && status !== "failed") {
    return err(capabilityError("status", "capability_status"));
  }
  const stage = value["evidence_stage"];
  if (stage !== "none" && stage !== "static" && stage !== "loaded" && stage !== "roundtrip") {
    return err(capabilityError("evidence_stage", "evidence_stage"));
  }
  if (status === "verified" && stage !== "roundtrip") {
    return err(capabilityError("evidence_stage", "verified_requires_roundtrip"));
  }
  const bindingResult = validateCapabilityBinding(value["binding"], { capabilityName: name });
  if (!bindingResult.ok) {
    return bindingResult;
  }
  if (name === "generation.service_profile" && bindingResult.value.subject !== "host_contract") {
    return err(capabilityError("binding.subject", "host_contract_required"));
  }
  const bindingKey = value["binding_key"];
  if (typeof bindingKey !== "string" || !isHash(bindingKey)) {
    return err(capabilityError("binding_key", "sha256_hash"));
  }
  if (capabilityBindingKey(bindingResult.value) !== bindingKey) {
    return err(capabilityError("binding_key", "binding_key_mismatch"));
  }
  if (!Array.isArray(value["evidence_refs"]) || !value["evidence_refs"].every((entry) => typeof entry === "string")) {
    return err(capabilityError("evidence_refs", "string[]"));
  }
  if (typeof value["capability_id"] !== "string" || !value["capability_id"].startsWith("cap:")) {
    return err(capabilityError("capability_id", "cap_id"));
  }
  if (!isSafeNonNegativeInt(value["checked_at"])) {
    return err(capabilityError("checked_at", "non_negative_safe_integer"));
  }
  if (!isRecord(value["details"])) {
    return err(capabilityError("details", "object"));
  }
  const detailsIssue = validateDetails(name, value["details"]);
  if (detailsIssue !== null) {
    return err(capabilityError("details", detailsIssue));
  }
  if (status === "verified" && value["evidence_refs"].length === 0) {
    return err(capabilityError("evidence_refs", "verified_requires_evidence"));
  }
  const record = {
    schema_version: "rsi.capability/2",
    capability_id: value["capability_id"] as Id<"cap">,
    binding: bindingResult.value,
    binding_key: bindingKey,
    name,
    status,
    evidence_stage: stage,
    evidence_refs: value["evidence_refs"] as string[],
    checked_at: value["checked_at"],
    details: value["details"] as CapabilityRecord["details"]
  } as CapabilityRecord;
  if (typeof value["probe_ref"] === "string") {
    record.probe_ref = value["probe_ref"];
  }
  if (value["probe_result"] === "passed" || value["probe_result"] === "failed" || value["probe_result"] === "blocked" || value["probe_result"] === "unknown") {
    record.probe_result = value["probe_result"];
  }
  if (typeof value["blocker_code"] === "string") {
    record.blocker_code = value["blocker_code"];
  }
  if (typeof value["failure_code"] === "string") {
    record.failure_code = value["failure_code"];
  }
  if (isSafeNonNegativeInt(value["verified_at"])) {
    record.verified_at = value["verified_at"];
  }
  if (isSafeNonNegativeInt(value["last_verified_at"])) {
    record.last_verified_at = value["last_verified_at"];
  }
  if (isRecord(value["legacy"])) {
    record.legacy = value["legacy"] as NonNullable<CapabilityRecord["legacy"]>;
  }
  return ok(record);
}

function capabilityError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "capability_record_validate",
    details: { kind: "field", path, rule }
  });
}

function validateDetails(name: CapabilityName, details: Record<string, unknown>): string | null {
  const allowed = DETAIL_KEYS[name];
  for (const key of Object.keys(details)) {
    if (!allowed.includes(key)) {
      return "closed";
    }
  }
  switch (name) {
    case "input_capture":
      if (!isStringArray(details["source_fields"])) return "source_fields";
      if (!isBoolOrUnknown(details["raw_text_before_expansion"])) return "raw_text_before_expansion";
      if (details["input_source_label"] !== "trusted" && details["input_source_label"] !== "label_only" && details["input_source_label"] !== "untrusted") {
        return "input_source_label";
      }
      if (!isEnumOrUnknown(details["duplicate_handling"], ["same_event_id", "content_hash", "none"])) return "duplicate_handling";
      if (!isStringArray(details["covered_modes"])) return "covered_modes";
      return null;
    case "sync_wait":
      if (typeof details["boundary"] !== "string") return "boundary";
      if (!isNumberOrUnknown(details["handler_timeout_ms"])) return "handler_timeout_ms";
      if (!isBoolOrUnknown(details["host_waits_for_handler"])) return "host_waits_for_handler";
      if (!isEnumOrUnknown(details["timeout_behavior"], ["continue", "drop_output", "block"])) return "timeout_behavior";
      if (!isBoolOrUnknown(details["hard_block"])) return "hard_block";
      if (details["hard_block_evidence_ref"] !== undefined && typeof details["hard_block_evidence_ref"] !== "string") {
        return "hard_block_evidence_ref";
      }
      return null;
    case "source_trust":
      if (!isEnumOrUnknown(details["trust_level"], ["managed", "trusted_project", "untrusted_project"])) return "trust_level";
      if (!isBoolOrUnknown(details["project_trust_gate"])) return "project_trust_gate";
      if (!isStringArray(details["config_layers"])) return "config_layers";
      if (typeof details["highest_precedence"] !== "string") return "highest_precedence";
      return null;
    case "tool_id":
      if (!isStringOrUnknown(details["call_id_field"])) return "call_id_field";
      if (!isStringOrUnknown(details["parent_call_field"])) return "parent_call_field";
      if (!isEnumOrUnknown(details["result_join"], ["direct", "weak", "none"])) return "result_join";
      if (!isBoolOrUnknown(details["parallel_safe"])) return "parallel_safe";
      return null;
    case "compaction_event":
      if (!isStringArray(details["events"])) return "events";
      if (!isEnumOrUnknown(details["reason"], ["structured", "name_only", "none"])) return "reason";
      if (!isBoolOrUnknown(details["summary_available"])) return "summary_available";
      if (!isStringOrUnknown(details["pre_boundary"])) return "pre_boundary";
      if (!isStringOrUnknown(details["post_boundary"])) return "post_boundary";
      if (!isBoolOrUnknown(details["summary_replaces_history"])) return "summary_replaces_history";
      return null;
    case "request_observation":
      if (!isEnumOrUnknown(details["max_level"], INCLUSION_LEVEL_ORDER)) return "max_level";
      if (!isStringArray(details["mechanisms"])) return "mechanisms";
      if (!isBoolOrUnknown(details["final_body_available"])) return "final_body_available";
      if (!isStringArray(details["redaction"])) return "redaction";
      return null;
    case "managed_object_load":
      if (!isEnumOrUnknown(details["reload_boundary"], ["next_request", "reload", "new_session", "restart"])) return "reload_boundary";
      if (!isBoolOrUnknown(details["hot_reload"])) return "hot_reload";
      if (!isStringOrUnknown(details["load_signal"])) return "load_signal";
      if (!isEnumOrUnknown(details["readback"], ["supported", "unsupported"])) return "readback";
      return null;
    case "online_delivery":
      if (typeof details["return_entry"] !== "string") return "return_entry";
      if (!isEnumOrUnknown(details["transport"], ["sync", "async"])) return "transport";
      if (!isNumberOrUnknown(details["max_text_chars"])) return "max_text_chars";
      if (!isEnumOrUnknown(details["inclusion_level"], INCLUSION_LEVEL_ORDER)) return "inclusion_level";
      if (!isStringOrUnknown(details["accepted_signal"])) return "accepted_signal";
      if (!isBoolOrUnknown(details["can_replace_user_text"])) return "can_replace_user_text";
      if (!isBoolOrUnknown(details["async_first_request"])) return "async_first_request";
      if (details["block_with_context"] !== "supported" && details["block_with_context"] !== "degraded" && details["block_with_context"] !== "unknown") {
        return "block_with_context";
      }
      return null;
    case "stable_boundary":
      if (!isStringArray(details["candidate_events"]) || !isStringArray(details["stable_events"])) return "events";
      if (
        !Array.isArray(details["review_boundary_facets"]) ||
        !details["review_boundary_facets"].every(
          (entry) => entry === "task_completion" || entry === "review_candidate" || entry === "session_exit"
        )
      ) {
        return "review_boundary_facets";
      }
      if (!isStringArray(details["pending_fields"])) return "pending_fields";
      if (details["pending_semantics"] !== "complete" && details["pending_semantics"] !== "partial" && details["pending_semantics"] !== "unknown") {
        return "pending_semantics";
      }
      if (!isStringOrUnknown(details["stable_predicate_ref"])) return "stable_predicate_ref";
      if (!isBoolOrUnknown(details["background_work_visible"])) return "background_work_visible";
      if (!isNumberOrUnknown(details["exit_budget_ms"])) return "exit_budget_ms";
      return null;
    case "host_budget":
      if (!isNumberOrUnknown(details["handler_timeout_ms"])) return "handler_timeout_ms";
      if (!isNumberOrUnknown(details["total_budget_ms"])) return "total_budget_ms";
      if (!isBoolOrUnknown(details["serial_chain"])) return "serial_chain";
      if (!isEnumOrUnknown(details["timeout_behavior"], ["continue", "drop_output", "block"])) return "timeout_behavior";
      if (!isBoolOrUnknown(details["hard_block"])) return "hard_block";
      if (details["hard_block_evidence_ref"] !== undefined && typeof details["hard_block_evidence_ref"] !== "string") {
        return "hard_block_evidence_ref";
      }
      if (!isSafeNonNegativeInt(details["reserve_ms"])) return "reserve_ms";
      return null;
    case "association":
      if (!isEnumOrUnknown(details["message_join"], ["direct_id", "stable_mapping", "session_only", "none"])) return "message_join";
      if (!isEnumOrUnknown(details["tool_join"], ["direct_id", "stable_mapping", "session_only", "none"])) return "tool_join";
      if (!isBoolOrUnknown(details["injection_id_preserved"])) return "injection_id_preserved";
      if (!isStringArray(details["native_ids"])) return "native_ids";
      if (details["mapping_ref"] !== undefined && typeof details["mapping_ref"] !== "string") return "mapping_ref";
      if (details["text_fallback"] !== false) return "text_fallback";
      return null;
    case "human_interaction_attested":
      if (!isStringArray(details["proof_kinds"]) || !isStringArray(details["subject_kinds"])) return "proof_kinds";
      if (!isStringArray(details["control_plane_purposes"])) return "control_plane_purposes";
      if (details["evidence_schema"] !== "rsi.human_proof_evidence/1") return "evidence_schema";
      if (!isSafeNonNegativeInt(details["max_attestation_age_ms"])) return "max_attestation_age_ms";
      return null;
    case "capacity_window":
      if (details["scope"] !== "window_tokens") return "scope";
      if (details["unit"] !== "tokens") return "unit";
      if (!isEnumOrUnknown(details["readback_method"], ["host_api", "provider_metadata", "ui_readback"])) {
        return "readback_method";
      }
      if (!isStringArray(details["model_scope_keys"])) return "model_scope_keys";
      if (details["evidence_schema"] !== "rsi.capacity_evidence_payload/1") return "evidence_schema";
      return null;
    case "generation.service_profile":
      if (details["profile_schema"] !== "rsi.service_profile/1") return "profile_schema";
      if (details["evidence_schema"] !== "rsi.service_profile_evidence/1") return "evidence_schema";
      if (typeof details["provider_scope"] !== "string" || details["provider_scope"].length === 0) {
        return "provider_scope";
      }
      if (typeof details["profile_key"] !== "string" || !isHash(details["profile_key"])) return "profile_key";
      if (!isSafeNonNegativeInt(details["observed_at"])) return "observed_at";
      return null;
    case "generation.create":
      if (!isEnumOrUnknown(details["entry_kind"], ["host_subagent", "sdk_import", "cli_spawn", "http_service"])) return "entry_kind";
      if (typeof details["entry_ref"] !== "string") return "entry_ref";
      if (!isStringOrUnknown(details["backend_version"])) return "backend_version";
      if (!isStringArray(details["protocol_versions"])) return "protocol_versions";
      if (!isRecord(details["isolation"])) return "isolation";
      if (!isBoolOrUnknown(details["idempotent"])) return "idempotent";
      if (!isNumberOrUnknown(details["max_concurrent"])) return "max_concurrent";
      if (!isBoolOrUnknown(details["supported_resume"])) return "supported_resume";
      return null;
    case "generation.auth":
      if (!isEnumOrUnknown(details["mechanism"], ["host_login", "profile_ref", "env_ref", "ambient", "none"])) return "mechanism";
      if (!isEnumOrUnknown(details["credential_ref_kind"], ["secret_ref", "profile_ref", "none"])) return "credential_ref_kind";
      if (!isStringOrUnknown(details["profile_ref"])) return "profile_ref";
      if (!isStringOrUnknown(details["data_scope"])) return "data_scope";
      if (!isBoolOrUnknown(details["host_login_reuse"])) return "host_login_reuse";
      if (!isStringOrUnknown(details["expiry_semantics"])) return "expiry_semantics";
      return null;
    case "generation.cancel":
      if (!isEnumOrUnknown(details["method"], ["host_api", "signal", "process_kill", "none"])) return "method";
      if (!isBoolOrUnknown(details["propagates_to_children"])) return "propagates_to_children";
      if (!isBoolOrUnknown(details["idempotent"])) return "idempotent";
      if (!isNumberOrUnknown(details["cancel_window_ms"])) return "cancel_window_ms";
      if (!isStringOrUnknown(details["post_effect"])) return "post_effect";
      return null;
    case "generation.recover":
      if (!isEnumOrUnknown(details["resume_kind"], ["reattach", "persisted_session", "replay_from_snapshot", "none"])) return "resume_kind";
      if (!isStringOrUnknown(details["recovery_boundary"])) return "recovery_boundary";
      if (!isBoolOrUnknown(details["durable_state"])) return "durable_state";
      if (!isStringOrUnknown(details["lost_work_semantics"])) return "lost_work_semantics";
      return null;
    case "generation.output":
      if (!isStringOrUnknown(details["protocol"])) return "protocol";
      if (!isStringOrUnknown(details["schema_ref"])) return "schema_ref";
      if (!isBoolOrUnknown(details["streaming"])) return "streaming";
      if (!isNumberOrUnknown(details["max_bytes"])) return "max_bytes";
      if (!isStringOrUnknown(details["final_state_signal"])) return "final_state_signal";
      if (!isBoolOrUnknown(details["artifact_refs"])) return "artifact_refs";
      return null;
  }
}

/**
 * Closed `details` key set per capability. Optional members are included;
 * any other key is rejected instead of being persisted into a record.
 */
const DETAIL_KEYS: Readonly<Record<CapabilityName, readonly string[]>> = {
  input_capture: [
    "source_fields",
    "raw_text_before_expansion",
    "input_source_label",
    "duplicate_handling",
    "covered_modes"
  ],
  sync_wait: [
    "boundary",
    "handler_timeout_ms",
    "host_waits_for_handler",
    "timeout_behavior",
    "hard_block",
    "hard_block_evidence_ref"
  ],
  source_trust: ["trust_level", "project_trust_gate", "config_layers", "highest_precedence"],
  tool_id: ["call_id_field", "parent_call_field", "result_join", "parallel_safe"],
  compaction_event: [
    "events",
    "reason",
    "summary_available",
    "pre_boundary",
    "post_boundary",
    "summary_replaces_history"
  ],
  request_observation: ["max_level", "mechanisms", "final_body_available", "redaction"],
  managed_object_load: ["reload_boundary", "hot_reload", "load_signal", "readback"],
  online_delivery: [
    "return_entry",
    "transport",
    "max_text_chars",
    "inclusion_level",
    "accepted_signal",
    "can_replace_user_text",
    "async_first_request",
    "block_with_context"
  ],
  stable_boundary: [
    "candidate_events",
    "stable_events",
    "review_boundary_facets",
    "pending_fields",
    "pending_semantics",
    "stable_predicate_ref",
    "background_work_visible",
    "exit_budget_ms"
  ],
  host_budget: [
    "handler_timeout_ms",
    "total_budget_ms",
    "serial_chain",
    "timeout_behavior",
    "hard_block",
    "hard_block_evidence_ref",
    "reserve_ms"
  ],
  association: [
    "message_join",
    "tool_join",
    "injection_id_preserved",
    "native_ids",
    "mapping_ref",
    "text_fallback"
  ],
  human_interaction_attested: [
    "proof_kinds",
    "subject_kinds",
    "control_plane_purposes",
    "evidence_schema",
    "max_attestation_age_ms"
  ],
  capacity_window: ["scope", "unit", "readback_method", "model_scope_keys", "evidence_schema"],
  "generation.service_profile": [
    "profile_schema",
    "evidence_schema",
    "provider_scope",
    "profile_key",
    "observed_at"
  ],
  "generation.create": [
    "entry_kind",
    "entry_ref",
    "backend_version",
    "protocol_versions",
    "isolation",
    "idempotent",
    "max_concurrent",
    "supported_resume"
  ],
  "generation.auth": [
    "mechanism",
    "credential_ref_kind",
    "profile_ref",
    "data_scope",
    "host_login_reuse",
    "expiry_semantics"
  ],
  "generation.cancel": [
    "method",
    "propagates_to_children",
    "idempotent",
    "cancel_window_ms",
    "post_effect"
  ],
  "generation.recover": [
    "resume_kind",
    "recovery_boundary",
    "durable_state",
    "lost_work_semantics"
  ],
  "generation.output": [
    "protocol",
    "schema_ref",
    "streaming",
    "max_bytes",
    "final_state_signal",
    "artifact_refs"
  ]
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isBoolOrUnknown(value: unknown): value is boolean | UnknownFact {
  return typeof value === "boolean" || isUnknownFact(value);
}

function isNumberOrUnknown(value: unknown): value is number | UnknownFact {
  return (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) || isUnknownFact(value);
}

function isStringOrUnknown(value: unknown): value is string | UnknownFact {
  return typeof value === "string" || isUnknownFact(value);
}

function isEnumOrUnknown(value: unknown, allowed: readonly string[]): boolean {
  return (typeof value === "string" && allowed.includes(value)) || isUnknownFact(value);
}

function isUnknownFact(value: unknown): value is UnknownFact {
  return isRecord(value) && value["kind"] === "unknown" && typeof value["reason_code"] === "string";
}

/* ------------------------------------------------------------------ */
/* v1 migration (DD-CAP-006)                                           */
/* ------------------------------------------------------------------ */

export function migrateLegacyCapability(v1: LegacyCapabilityRecordV1): CapabilityRecord {
  const stage: EvidenceStage =
    v1.status === "unknown" ? "none" : v1.status === "static" ? "static" : v1.status === "loaded" ? "loaded" : "roundtrip";
  const record = makeUnknownCapabilityRecord({
    capability_id: v1.capability_id,
    name: v1.name,
    binding: v1.binding,
    checked_at: v1.checked_at
  });
  const migrated = {
    ...record,
    status: "unknown",
    evidence_stage: stage,
    evidence_refs: v1.evidence_refs,
    legacy: {
      schema_version: "rsi.capability/1",
      status: v1.status
    }
  } as CapabilityRecord;
  if (v1.details !== undefined) {
    migrated.legacy = {
      schema_version: "rsi.capability/1",
      status: v1.status,
      details: v1.details
    };
  }
  return migrated;
}

/* ------------------------------------------------------------------ */
/* Probe application (DD-CAP-001, DD-CAP-004, DD-CAP-005)              */
/* ------------------------------------------------------------------ */

export interface ProbeApplicationOptions {
  /** Allocated `cap:` id used when no record exists yet. */
  capability_id: Id<"cap">;
  /** Current wall clock, used only to reject probes from the future. */
  now: number;
}

/**
 * Applies a terminal probe to one capability record. Returns `null` when the
 * probe does not change the capability's status or evidence (blocked/unknown,
 * or a late probe).
 */
export function applyProbeToCapability(
  current: CapabilityRecord | null,
  probe: HostProbeRecord,
  name: CapabilityName,
  options: ProbeApplicationOptions
): CapabilityRecord | null {
  const probeKey = capabilityBindingKey(probe.binding);
  if (probeKey !== probe.binding_key) {
    return null;
  }
  if (current !== null && current.binding_key !== probeKey) {
    return null;
  }
  if (current !== null && current.checked_at > probe.checked_at) {
    return null;
  }
  if (probe.checked_at > options.now) {
    return null;
  }
  if (probe.probe_contract_version !== "host-probe/2") {
    return null;
  }
  const proposed = probe.capability_results.find((result) => result.name === name);
  if (probe.result === "blocked" || probe.result === "unknown") {
    if (current === null) {
      return null;
    }
    const unchanged = {
      ...current,
      probe_ref: probe.probe_id,
      probe_result: probe.result,
      checked_at: probe.checked_at
    } as CapabilityRecord;
    if (probe.blocker !== undefined) {
      unchanged.blocker_code = probe.blocker.code;
    } else {
      delete unchanged.blocker_code;
    }
    return unchanged;
  }
  if (probe.result === "failed") {
    const failedAssertion = probe.assertions.find((assertion) => assertion.capability === name && assertion.pass === false);
    if (failedAssertion === undefined || proposed === undefined) {
      return null;
    }
    const base =
      current ??
      makeUnknownCapabilityRecord({
        capability_id: options.capability_id,
        name,
        binding: probe.binding,
        checked_at: probe.checked_at
      });
    const failed = {
      ...base,
      status: "failed",
      evidence_stage: proposed.evidence_stage,
      evidence_refs: proposed.evidence_refs,
      probe_ref: probe.probe_id,
      probe_result: "failed",
      checked_at: probe.checked_at
    } as CapabilityRecord;
    const failureCode = failedAssertion.failure_code ?? proposed.failure_code;
    if (failureCode !== undefined) {
      failed.failure_code = failureCode;
    }
    if (current?.verified_at !== undefined) {
      failed.last_verified_at = current.verified_at;
      failed.verified_at = current.verified_at;
    }
    return failed;
  }
  // passed
  if (proposed === undefined) {
    return null;
  }
  if (proposed.proposed_status === "unknown") {
    return current;
  }
  if (proposed.proposed_status === "verified" && proposed.evidence_stage !== "roundtrip") {
    return null;
  }
  if (proposed.evidence_refs.length === 0) {
    return null;
  }
  const base =
    current ??
    makeUnknownCapabilityRecord({
      capability_id: options.capability_id,
      name,
      binding: probe.binding,
      checked_at: probe.checked_at
    });
  const next = {
    ...base,
    status: proposed.proposed_status,
    evidence_stage: proposed.evidence_stage,
    evidence_refs: proposed.evidence_refs,
    probe_ref: probe.probe_id,
    probe_result: "passed",
    checked_at: probe.checked_at
  } as CapabilityRecord;
  if (proposed.proposed_status === "verified") {
    next.verified_at = probe.checked_at;
    next.last_verified_at = probe.checked_at;
  }
  if (proposed.failure_code !== undefined) {
    next.failure_code = proposed.failure_code;
  } else {
    delete next.failure_code;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Capability snapshot hash (DD-CAP-008)                               */
/* ------------------------------------------------------------------ */

export interface CapabilitySnapshotInput {
  records: readonly CapabilityRecord[];
}

/** `capability_snapshot_hash` over current `product_adapter` records. */
export function capabilitySnapshotHash(records: readonly CapabilityRecord[]): Hash {
  return computeCapabilitySnapshotHash(records);
}

/* ------------------------------------------------------------------ */
/* Gate matrix and strict (DD-CAP-007)                                 */
/* ------------------------------------------------------------------ */

export type GateOperation =
  | "local_hard_fact_archive"
  | "online_local_fact"
  | "online_semantic_reminder"
  | "automatic_review"
  | "generation_profile"
  | "generation_start"
  | "strict"
  | "message_association"
  | "tool_association"
  | "cancel_recover_claim"
  | "managed_write";

export const GATE_REQUIREMENTS: Readonly<Record<GateOperation, readonly CapabilityName[]>> = {
  local_hard_fact_archive: [],
  online_local_fact: ["input_capture", "online_delivery"],
  online_semantic_reminder: ["input_capture", "online_delivery", "host_budget"],
  automatic_review: ["stable_boundary"],
  generation_profile: ["generation.service_profile"],
  generation_start: ["generation.create", "generation.auth", "generation.output"],
  strict: ["sync_wait", "host_budget"],
  message_association: ["association"],
  tool_association: ["association"],
  cancel_recover_claim: ["generation.cancel", "generation.recover"],
  managed_write: ["source_trust", "managed_object_load"]
};

export interface CapabilityLookup {
  (name: CapabilityName): {
    status: CapabilityStatus;
    evidence_stage: EvidenceStage;
    probe_result?: HostProbeRecord["result"];
    checked_at: number;
    details?: unknown;
  } | null;
}

export interface GateEvaluation {
  operation: GateOperation;
  passed: boolean;
  missing: CapabilityName[];
}

/** Evaluates the required capabilities of one operation. */
export function evaluateGate(operation: GateOperation, lookup: CapabilityLookup): GateEvaluation {
  const required = GATE_REQUIREMENTS[operation];
  const missing: CapabilityName[] = [];
  for (const name of required) {
    const record = lookup(name);
    if (record === null || record.status !== "verified" || record.evidence_stage !== "roundtrip") {
      missing.push(name);
    }
  }
  return { operation, passed: missing.length === 0, missing };
}

/** Strict blockers, in the documented order (DD-CAP-007). */
export type StrictBlocker =
  | "sync_wait_not_verified"
  | "host_budget_not_verified"
  | "total_budget_unknown"
  | "hard_block_not_true"
  | "probe_stale";

export interface StrictEvaluation {
  strict_mode_enabled: boolean;
  blockers: StrictBlocker[];
}

export function evaluateStrictGate(input: {
  sync_wait: { status: CapabilityStatus; checked_at: number } | null;
  host_budget: { status: CapabilityStatus; checked_at: number; details: { total_budget_ms: unknown; hard_block: unknown } } | null;
  require_probe_freshness_ms: number;
  now: number;
}): StrictEvaluation {
  const blockers: StrictBlocker[] = [];
  if (input.sync_wait === null || input.sync_wait.status !== "verified") {
    blockers.push("sync_wait_not_verified");
  }
  if (input.host_budget === null || input.host_budget.status !== "verified") {
    blockers.push("host_budget_not_verified");
  }
  const total = input.host_budget?.details.total_budget_ms;
  if (typeof total !== "number") {
    blockers.push("total_budget_unknown");
  }
  if (input.host_budget?.details.hard_block !== true) {
    blockers.push("hard_block_not_true");
  }
  if (input.sync_wait !== null && input.host_budget !== null) {
    const fresh =
      input.now - input.sync_wait.checked_at <= input.require_probe_freshness_ms &&
      input.now - input.host_budget.checked_at <= input.require_probe_freshness_ms;
    if (!fresh) {
      blockers.push("probe_stale");
    }
  }
  return { strict_mode_enabled: blockers.length === 0, blockers };
}

/** True when the capability binding belongs to a supported generation subject. */
export function isGenerationSubject(binding: CapabilityBinding): boolean {
  return binding.subject === "product_adapter" || binding.subject === "host_contract";
}
