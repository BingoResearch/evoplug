/**
 * HostProbeRecord/2 validation and probe-request rules (DD-CAP-004).
 *
 * A probe reports facts and evidence only. HOST validates the closed shape
 * before applying any capability and never lets adapter-declared results
 * bypass `binding_key` recomputation.
 */

import type { ErrorEnvelope } from "../../errors.js";
import { makeErrorEnvelope } from "../../errors.js";
import { isHash } from "../../hash.js";
import { err, ok, type Result } from "../../result.js";
import type {
  CapabilityName,
  HostProbeRecord,
  HostProbeRequest,
  UnknownFact
} from "../types.js";
import { capabilityBindingKey } from "../keys.js";
import { validateCapabilityBinding } from "./record.js";
import { isCapabilityName } from "./record.js";
import { isRecord, isSafeNonNegativeInt } from "../validation.js";

const RESERVED_CAPABILITY: CapabilityName = "generation.service_profile";

const BLOCKER_KINDS: readonly string[] = [
  "credentials_unavailable",
  "region_blocked",
  "provider_unavailable",
  "host_not_installed",
  "version_unmapped",
  "permission_denied",
  "fixture_unavailable",
  "deadline_exceeded",
  "operator_aborted",
  "unknown_environment"
];

function probeError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "host_probe_validate",
    details: { kind: "field", path, rule }
  });
}

/** Adapters must never declare or probe the HOST-reserved capability. */
export function assertNoReservedCapability(
  capabilities: readonly string[],
  path: string
): Result<void, ErrorEnvelope> {
  if (capabilities.includes(RESERVED_CAPABILITY)) {
    return err(probeError(path, "reserved_capability"));
  }
  return ok(undefined);
}

/** Validates a `HostProbeRequest` before the adapter is called. */
export function validateHostProbeRequest(value: unknown): Result<HostProbeRequest, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(probeError("$", "object"));
  }
  if (value["probe_contract_version"] !== "host-probe/2") {
    return err(probeError("probe_contract_version", "host-probe/2"));
  }
  if (typeof value["probe_id"] !== "string" || !value["probe_id"].startsWith("prb:")) {
    return err(probeError("probe_id", "prb_id"));
  }
  const binding = validateCapabilityBinding(value["binding"]);
  if (!binding.ok) {
    return err(binding.error);
  }
  if (value["probe_mode"] !== "read_only" && value["probe_mode"] !== "temp_fixture") {
    return err(probeError("probe_mode", "probe_mode"));
  }
  const capabilities = value["capabilities"];
  if (!Array.isArray(capabilities) || !capabilities.every((entry) => typeof entry === "string" && isCapabilityName(entry))) {
    return err(probeError("capabilities", "capability_name[]"));
  }
  const reserved = assertNoReservedCapability(capabilities, "capabilities");
  if (!reserved.ok) {
    return err(reserved.error);
  }
  if (!isSafeNonNegativeInt(value["deadline_ms"]) || value["deadline_ms"] < 1 || value["deadline_ms"] > 600_000) {
    return err(probeError("deadline_ms", "1..600000"));
  }
  return ok({
    probe_id: value["probe_id"] as HostProbeRequest["probe_id"],
    probe_contract_version: "host-probe/2",
    binding: binding.value,
    host_binding: value["host_binding"] as HostProbeRequest["host_binding"],
    capabilities: capabilities as CapabilityName[],
    probe_mode: value["probe_mode"],
    deadline_ms: value["deadline_ms"]
  });
}

/** True when every assertion of a passed probe is exactly `true`. */
export function passedProbeHasAllAssertions(probe: HostProbeRecord): boolean {
  return probe.assertions.every((assertion) => assertion.pass === true);
}

/**
 * Full structural validation of a terminal `HostProbeRecord/2` as returned by
 * an adapter or produced by a HOST-internal probe.
 */
export function validateHostProbeRecord(value: unknown): Result<HostProbeRecord, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(probeError("$", "object"));
  }
  if (value["schema_version"] !== "rsi.host_probe/2") {
    return err(probeError("schema_version", "rsi.host_probe/2"));
  }
  if (value["probe_contract_version"] !== "host-probe/2") {
    return err(probeError("probe_contract_version", "host-probe/2"));
  }
  if (typeof value["probe_id"] !== "string" || !value["probe_id"].startsWith("prb:")) {
    return err(probeError("probe_id", "prb_id"));
  }
  const targetKind = value["target_kind"];
  if (targetKind !== "host" && targetKind !== "jev_api" && targetKind !== "filesystem") {
    return err(probeError("target_kind", "target_kind"));
  }
  const bindingResult = validateCapabilityBinding(value["binding"]);
  if (!bindingResult.ok) {
    return err(bindingResult.error);
  }
  const bindingKey = value["binding_key"];
  if (typeof bindingKey !== "string" || !isHash(bindingKey)) {
    return err(probeError("binding_key", "sha256_hash"));
  }
  if (capabilityBindingKey(bindingResult.value) !== bindingKey) {
    return err(probeError("binding_key", "binding_key_mismatch"));
  }
  const probeMode = value["probe_mode"];
  if (probeMode !== "read_only" && probeMode !== "temp_fixture") {
    return err(probeError("probe_mode", "probe_mode"));
  }
  if (typeof value["probe_action"] !== "string" || value["probe_action"].length === 0) {
    return err(probeError("probe_action", "non_empty_string"));
  }
  const assertions = value["assertions"];
  const capabilityResults = value["capability_results"];
  if (!Array.isArray(assertions) || !Array.isArray(capabilityResults)) {
    return err(probeError("assertions", "array"));
  }
  const assertionIds = new Set<string>();
  const parsedAssertions: import("../types.js").HostProbeAssertion[] = [];
  for (const assertion of assertions) {
    if (
      !isRecord(assertion) ||
      typeof assertion["assertion_id"] !== "string" ||
      assertion["assertion_id"].length === 0 ||
      typeof assertion["capability"] !== "string" ||
      !isCapabilityName(assertion["capability"]) ||
      typeof assertion["expected"] !== "string" ||
      typeof assertion["observed_ref"] !== "string" ||
      (assertion["pass"] !== true && assertion["pass"] !== false && assertion["pass"] !== "unknown")
    ) {
      return err(probeError("assertions", "assertion_shape"));
    }
    if (assertionIds.has(assertion["assertion_id"])) {
      return err(probeError("assertions.assertion_id", "unique"));
    }
    assertionIds.add(assertion["assertion_id"]);
    if (assertion["capability"] === RESERVED_CAPABILITY) {
      return err(probeError("assertions.capability", "reserved_capability"));
    }
    const parsed: import("../types.js").HostProbeAssertion = {
      assertion_id: assertion["assertion_id"],
      capability: assertion["capability"],
      expected: assertion["expected"],
      observed_ref: assertion["observed_ref"] as import("../../source-ref.js").SourceRef,
      pass: assertion["pass"]
    };
    if (typeof assertion["failure_code"] === "string") {
      parsed.failure_code = assertion["failure_code"];
    }
    parsedAssertions.push(parsed);
  }
  const resultNames = new Set<string>();
  const parsedResults: import("../types.js").HostProbeCapabilityResult[] = [];
  for (const result of capabilityResults) {
    if (
      !isRecord(result) ||
      typeof result["name"] !== "string" ||
      !isCapabilityName(result["name"]) ||
      !isCapabilityStatus(result["proposed_status"]) ||
      !isEvidenceStage(result["evidence_stage"]) ||
      !Array.isArray(result["evidence_refs"]) ||
      !result["evidence_refs"].every((entry) => typeof entry === "string")
    ) {
      return err(probeError("capability_results", "capability_result_shape"));
    }
    if (result["name"] === RESERVED_CAPABILITY) {
      return err(probeError("capability_results.name", "reserved_capability"));
    }
    if (resultNames.has(result["name"])) {
      return err(probeError("capability_results.name", "unique"));
    }
    resultNames.add(result["name"]);
    const parsed: import("../types.js").HostProbeCapabilityResult = {
      name: result["name"],
      proposed_status: result["proposed_status"] as import("../types.js").CapabilityStatus,
      evidence_stage: result["evidence_stage"] as import("../types.js").EvidenceStage,
      evidence_refs: result["evidence_refs"]
    };
    if (typeof result["proposed_details_ref"] === "string") {
      parsed.proposed_details_ref = result["proposed_details_ref"] as import("../../source-ref.js").SourceRef;
    }
    if (typeof result["failure_code"] === "string") {
      parsed.failure_code = result["failure_code"];
    }
    parsedResults.push(parsed);
  }
  const result = value["result"];
  if (result !== "passed" && result !== "failed" && result !== "blocked" && result !== "unknown") {
    return err(probeError("result", "host_probe_result"));
  }
  if (typeof value["expected"] !== "string" || typeof value["observed"] !== "string") {
    return err(probeError("expected", "string"));
  }
  if (!Array.isArray(value["evidence_refs"]) || !value["evidence_refs"].every((entry) => typeof entry === "string")) {
    return err(probeError("evidence_refs", "string[]"));
  }
  if (!isSafeNonNegativeInt(value["duration_ms"]) || !isSafeNonNegativeInt(value["checked_at"])) {
    return err(probeError("duration_ms", "non_negative_safe_integer"));
  }
  const blocker = value["blocker"];
  if (result === "blocked" && blocker === undefined) {
    return err(probeError("blocker", "required_for_blocked"));
  }
  let parsedBlocker: import("../types.js").HostProbeBlocker | undefined;
  if (blocker !== undefined) {
    if (
      !isRecord(blocker) ||
      typeof blocker["kind"] !== "string" ||
      !BLOCKER_KINDS.includes(blocker["kind"]) ||
      typeof blocker["code"] !== "string" ||
      typeof blocker["detail_ref"] !== "string" ||
      typeof blocker["retry_allowed"] !== "boolean"
    ) {
      return err(probeError("blocker", "blocker_shape"));
    }
    parsedBlocker = {
      kind: blocker["kind"] as import("../types.js").HostProbeBlockerKind,
      code: blocker["code"],
      detail_ref: blocker["detail_ref"] as import("../../source-ref.js").SourceRef,
      retry_allowed: blocker["retry_allowed"]
    };
  }
  if (result === "passed") {
    if (!assertions.every((assertion) => isRecord(assertion) && assertion["pass"] === true)) {
      return err(probeError("assertions", "passed_requires_all_true"));
    }
  }
  if (result === "failed") {
    const hasFalse = assertions.some((assertion) => isRecord(assertion) && assertion["pass"] === false);
    const hasFailureCode = assertions.some(
      (assertion) => isRecord(assertion) && typeof assertion["failure_code"] === "string"
    );
    if (!hasFalse || !hasFailureCode) {
      return err(probeError("result", "failed_requires_false_and_failure_code"));
    }
  }
  const record: HostProbeRecord = {
    schema_version: "rsi.host_probe/2",
    probe_id: value["probe_id"] as import("../../ids.js").Id<"prb">,
    probe_contract_version: "host-probe/2",
    target_kind: targetKind,
    binding: bindingResult.value,
    binding_key: bindingKey,
    probe_mode: probeMode,
    probe_action: value["probe_action"],
    assertions: parsedAssertions,
    capability_results: parsedResults,
    result,
    expected: value["expected"],
    observed: value["observed"],
    evidence_refs: value["evidence_refs"] as string[],
    duration_ms: value["duration_ms"],
    checked_at: value["checked_at"]
  };
  if (typeof value["fixture_ref"] === "string") {
    record.fixture_ref = value["fixture_ref"] as import("../../source-ref.js").SourceRef;
  }
  if (parsedBlocker !== undefined) {
    record.blocker = parsedBlocker;
  }
  return ok(record);
}

function isCapabilityStatus(value: unknown): boolean {
  return value === "unknown" || value === "verified" || value === "unsupported" || value === "failed";
}

function isEvidenceStage(value: unknown): boolean {
  return value === "none" || value === "static" || value === "loaded" || value === "roundtrip";
}

/** A probe on a non-host target never updates host capabilities. */
export function probeMayUpdateHostCapabilities(probe: HostProbeRecord): boolean {
  return probe.target_kind === "host";
}

/** Unknown facts in probe evidence keep the probe from being treated as passed. */
export function hasUnknownAssertions(probe: HostProbeRecord): boolean {
  return probe.assertions.some((assertion) => assertion.pass === "unknown");
}

/** True when a capability result may be applied to a host capability row. */
export function capabilityResultApplies(
  probe: HostProbeRecord,
  name: CapabilityName
): { applies: boolean; reason: "target_not_host" | "mapping_unmapped" | "no_result" | null } {
  if (!probeMayUpdateHostCapabilities(probe)) {
    return { applies: false, reason: "target_not_host" };
  }
  if (probe.binding.mapping === "unmapped" && name !== RESERVED_CAPABILITY) {
    return { applies: false, reason: "mapping_unmapped" };
  }
  if (!probe.capability_results.some((result) => result.name === name)) {
    return { applies: false, reason: "no_result" };
  }
  return { applies: true, reason: null };
}

/** `UnknownFact` guard shared by probe validation call sites. */
export function isUnknownFact(value: unknown): value is UnknownFact {
  return isRecord(value) && value["kind"] === "unknown" && typeof value["reason_code"] === "string";
}
