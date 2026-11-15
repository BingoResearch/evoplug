/**
 * Adapter install approval consumption and install readiness (DD-HOST-001).
 *
 * HOST consumes FND approvals; it never issues, reuses or revives one. The
 * readiness port is read-only and returns `unknown` rather than guessing an
 * active binding or a verified host contract.
 */

import type { Clock } from "../clock.js";
import type { ErrorCode, ErrorEnvelope } from "../errors.js";
import { makeErrorEnvelope } from "../errors.js";
import type { Hash } from "../hash.js";
import { isHash } from "../hash.js";
import type { Id } from "../ids.js";
import { canonicalJsonText } from "../canonical.js";
import { toJsonValue } from "../json.js";
import type { NotPromise, Tx } from "../tx.js";
import type { SourceRef, SourceRefPort } from "../source-ref.js";
import { isSourceRef } from "../source-ref.js";
import { err, ok, type Result } from "../result.js";
import { adapterErr, type HostAdapterResult } from "./errors.js";
import type {
  AdapterInstallApprovalView,
  AdapterInstallReadinessPort,
  AdapterInstallReadinessView,
  AdapterInstallSubject,
  CapabilityBinding,
  CapabilityRecord,
  HostProbeRecord,
  PreinstallHostContext
} from "./types.js";
import type { HostAdapterError } from "./errors.js";
import {
  adapterInstallSubjectHash,
  controlPlaneProbeExpected,
  installConsumeIdempotencyKey,
  nativeRootId
} from "./keys.js";
import { isRecord, isSafeNonNegativeInt, isSafePositiveInt } from "./validation.js";

/** Validates an `AdapterInstallSubject` and its coordinates. */
export function validateAdapterInstallSubject(value: unknown): Result<AdapterInstallSubject, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(installError("E_SCHEMA", "$", "object"));
  }
  if (value["schema_version"] !== "rsi.adapter_install_subject/1" || value["purpose"] !== "adapter_install") {
    return err(installError("E_SCHEMA", "purpose", "adapter_install"));
  }
  for (const field of ["host_id", "mode", "config_space", "adapter_id", "adapter_version", "target_id"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      return err(installError("E_SCHEMA", field, "non_empty_string"));
    }
  }
  if (typeof value["implementation_hash"] !== "string" || !isHash(value["implementation_hash"])) {
    return err(installError("E_SCHEMA", "implementation_hash", "sha256_hash"));
  }
  if (typeof value["artifact_hash"] !== "string" || !isHash(value["artifact_hash"])) {
    return err(installError("E_SCHEMA", "artifact_hash", "sha256_hash"));
  }
  const previous = value["expected_previous_hash"];
  if (previous !== null && (typeof previous !== "string" || !isHash(previous))) {
    return err(installError("E_SCHEMA", "expected_previous_hash", "hash_or_null"));
  }
  const subject: AdapterInstallSubject = {
    schema_version: "rsi.adapter_install_subject/1",
    purpose: "adapter_install",
    host_id: value["host_id"] as AdapterInstallSubject["host_id"],
    mode: value["mode"] as AdapterInstallSubject["mode"],
    config_space: value["config_space"] as string,
    adapter_id: value["adapter_id"] as import("../ids.js").Id<"adp">,
    adapter_version: value["adapter_version"] as string,
    implementation_hash: value["implementation_hash"] as Hash,
    target_id: value["target_id"] as string,
    artifact_hash: value["artifact_hash"] as Hash,
    expected_previous_hash: previous === null ? null : (previous as Hash)
  };
  return ok(subject);
}

function installError(code: ErrorCode, path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: code === "E_CONFLICT" ? "conflict" : code === "E_AUTH_UNAVAILABLE" ? "authorization" : "schema",
    message_key: `error.${code.toLowerCase()}`,
    stage: "adapter_install_preflight",
    details: { kind: "field", path, rule }
  });
}

export type ApprovalPreflight =
  | { ok: true; approval: AdapterInstallApprovalView }
  | { ok: false; kind: "rejected"; code: import("./errors.js").RegistrationConflictCode }
  | { ok: false; kind: "unavailable" };

/**
 * Pure approval preflight. `approval` is the `get` result; `null` means the
 * port was unavailable or the request carried no approval.
 */
export function evaluateApprovalPreflight(input: {
  request_approval: { approval_id: Id<"iap">; approval_hash: Hash } | null;
  subject: AdapterInstallSubject;
  subject_hash: Hash;
  approval: AdapterInstallApprovalView | null;
  approval_error_code: string | null;
  has_active_product_adapter: boolean;
}): ApprovalPreflight {
  if (input.request_approval === null) {
    return { ok: false, kind: "unavailable" };
  }
  if (input.approval_error_code !== null) {
    switch (input.approval_error_code) {
      case "E_APPROVAL_NOT_FOUND":
      case "E_APPROVAL_SUBJECT_MISMATCH":
      case "E_APPROVAL_STATE":
      case "E_APPROVAL_EXPIRED":
        return { ok: false, kind: "rejected", code: input.approval_error_code };
      default:
        return { ok: false, kind: "unavailable" };
    }
  }
  if (input.approval === null) {
    return { ok: false, kind: "unavailable" };
  }
  if (input.approval.state !== "active") {
    return { ok: false, kind: "rejected", code: "E_APPROVAL_STATE" };
  }
  if (input.approval.approval_hash !== input.request_approval.approval_hash) {
    return { ok: false, kind: "rejected", code: "E_APPROVAL_HASH" };
  }
  if (
    input.approval.subject_hash !== input.subject_hash ||
    adapterInstallSubjectHash(input.approval.subject) !== input.subject_hash
  ) {
    return { ok: false, kind: "rejected", code: "E_APPROVAL_SUBJECT_MISMATCH" };
  }
  if (
    input.approval.bootstrap_state === "blocked_no_attested_source" ||
    input.approval.bootstrap_state === "unknown" ||
    (input.approval.bootstrap_state === "preinstall_ready" && input.has_active_product_adapter)
  ) {
    return { ok: false, kind: "unavailable" };
  }
  return { ok: true, approval: input.approval };
}

/** Deterministic consume idempotency key. */
export function approvalConsumeKey(approvalId: Id<"iap">, registrationHash: Hash): string {
  return installConsumeIdempotencyKey(approvalId, registrationHash);
}

/** `root_id` from the native install root, never from a path or approval. */
export function rootIdFromNative(input: {
  host_id: string;
  mode: string;
  config_space: string;
  native_root_ref: SourceRef;
  identity_pin: { device_id: string; file_id: string };
}): string {
  return nativeRootId(input);
}

/** Exact `host_contract` binding built from a preinstall context. */
export function preinstallCapabilityBinding(input: {
  context: PreinstallHostContext;
  adapter_version: string;
}): CapabilityBinding {
  return {
    host_id: input.context.host_id,
    source_pin: input.context.source_pin,
    binary_pin: input.context.binary_pin,
    adapter_version: input.adapter_version,
    subject: "host_contract",
    mode: input.context.mode,
    config_space: input.context.config_space,
    root_id: input.context.root_id,
    construction_path: input.context.construction_path,
    execution_environment: input.context.execution_environment,
    mapping: "exact"
  };
}

/** Expected assertion value for a `confirm_control_plane` probe. */
export function confirmControlPlaneExpected(subjectHash: Hash, challengeNonce: string): Hash {
  return controlPlaneProbeExpected({ subject_hash: subjectHash, challenge_nonce: challengeNonce });
}

/** Validates a `PreinstallHostContext` read result. */
export function validatePreinstallContext(
  value: unknown,
  detailRef: SourceRef
): HostAdapterResult<PreinstallHostContext> {
  if (!isRecord(value)) {
    return adapterErr(preinstallError("E_SCHEMA", detailRef));
  }
  if (value["schema_version"] !== "rsi.preinstall_host_context/1") {
    return adapterErr(preinstallError("E_SCHEMA", detailRef));
  }
  if (typeof value["root_id"] !== "string" || !value["root_id"].startsWith("root:")) {
    return adapterErr(preinstallError("E_CONFLICT", detailRef));
  }
  if (typeof value["root_identity_ref"] !== "string" || !isSourceRef(value["root_identity_ref"])) {
    return adapterErr(preinstallError("E_CONFLICT", detailRef));
  }
  if (typeof value["read_at"] !== "number" || !Number.isSafeInteger(value["read_at"]) || value["read_at"] < 0) {
    return adapterErr(preinstallError("E_SCHEMA", detailRef));
  }
  if (!isRecord(value["source_pin"]) || !isRecord(value["binary_pin"]) || !isRecord(value["execution_environment"])) {
    return adapterErr(preinstallError("E_SCHEMA", detailRef));
  }
  const sourcePin = value["source_pin"];
  const binaryPin = value["binary_pin"];
  const environment = value["execution_environment"];
  return ok({
    schema_version: "rsi.preinstall_host_context/1",
    host_id: value["host_id"] as PreinstallHostContext["host_id"],
    mode: value["mode"] as PreinstallHostContext["mode"],
    config_space: value["config_space"] as string,
    root_id: value["root_id"],
    root_identity_ref: value["root_identity_ref"] as SourceRef,
    source_pin: {
      host_version: sourcePin["host_version"] as string,
      host_version_kind: sourcePin["host_version_kind"] as PreinstallHostContext["source_pin"]["host_version_kind"],
      source_commit: sourcePin["source_commit"] as string | null
    },
    binary_pin: {
      binary_version: binaryPin["binary_version"] as string | null,
      binary_hash: binaryPin["binary_hash"] as Hash | null
    },
    construction_path: value["construction_path"] as string,
    execution_environment: {
      os: environment["os"] as string,
      arch: environment["arch"] as string,
      isolation: environment["isolation"] as PreinstallHostContext["execution_environment"]["isolation"]
    },
    read_at: value["read_at"]
  });
}

function preinstallError(code: HostAdapterError["code"], detailRef: SourceRef): HostAdapterError {
  return {
    code,
    retryable: code === "E_IO",
    detail_ref: detailRef,
    observed_at: Date.now()
  };
}

/* ------------------------------------------------------------------ */
/* Readiness port                                                      */
/* ------------------------------------------------------------------ */

export interface ReadinessRegistrationRow {
  state: string;
  adapter_version: string | null;
  implementation_hash: Hash | null;
  artifact_ref: SourceRef | null;
  binding: CapabilityBinding;
}

export interface AdapterInstallReadinessDeps {
  withTx<T>(fn: (tx: Tx) => NotPromise<T>): Promise<T>;
  clock: Clock;
  sourceRefs: Pick<SourceRefPort, "resolve">;
  readRegistrations(
    tx: Tx,
    q: { host_id: string; mode: string; config_space: string }
  ): Result<readonly ReadinessRegistrationRow[], ErrorEnvelope>;
  readCapabilities(
    tx: Tx,
    q: { host_id: string; mode: string; config_space: string; subject: "host_contract" | "product_adapter" }
  ): Result<readonly CapabilityRecord[], ErrorEnvelope>;
  readProbe(tx: Tx, probeId: string): Result<HostProbeRecord | null, ErrorEnvelope>;
}

interface ParsedProof {
  purpose: string;
  subject_hash: Hash;
  nonce: string;
  confirmed_at: number;
}

function parseControlPlaneEvidence(text: string): ParsedProof | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["schema_version"] !== "rsi.human_proof_evidence/1") {
    return null;
  }
  if (parsed["proof_kind"] !== "control_plane_explicit_confirmation") {
    return null;
  }
  const subject = parsed["subject"];
  if (
    !isRecord(subject) ||
    subject["kind"] !== "control_plane" ||
    typeof subject["purpose"] !== "string" ||
    typeof subject["subject_hash"] !== "string" ||
    !isHash(subject["subject_hash"]) ||
    typeof parsed["nonce"] !== "string" ||
    !isSafeNonNegativeInt(parsed["confirmed_at"])
  ) {
    return null;
  }
  return {
    purpose: subject["purpose"],
    subject_hash: subject["subject_hash"],
    nonce: parsed["nonce"],
    confirmed_at: parsed["confirmed_at"]
  };
}

async function readProof(
  deps: AdapterInstallReadinessDeps,
  ref: SourceRef
): Promise<ParsedProof | null> {
  try {
    const resolved = await deps.sourceRefs.resolve(ref, { maxBytes: 1_048_576 });
    if (!resolved.ok || !resolved.value.retrievable || resolved.value.bytes === null) {
      return null;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(resolved.value.bytes);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(parsed) || canonicalJsonText(toJsonValue(parsed)) !== text) {
      return null;
    }
    return parseControlPlaneEvidence(text);
  } catch {
    return null;
  }
}

/** HOST implementation of FND's read-only readiness contract. */
export function createAdapterInstallReadinessPort(
  deps: AdapterInstallReadinessDeps
): AdapterInstallReadinessPort {
  return {
    async get(input: {
      request_id: string;
      subject: AdapterInstallSubject;
      subject_hash: Hash;
    }): Promise<Result<AdapterInstallReadinessView, ErrorEnvelope>> {
      const subjectResult = validateAdapterInstallSubject(input.subject);
      if (!subjectResult.ok) {
        return err(subjectResult.error);
      }
      if (
        typeof input.request_id !== "string" ||
        input.request_id.length === 0 ||
        input.request_id.length > 128 ||
        typeof input.subject_hash !== "string" ||
        !isHash(input.subject_hash)
      ) {
        return err(installError("E_SCHEMA", "request_id", "1..128"));
      }
      if (adapterInstallSubjectHash(subjectResult.value) !== input.subject_hash) {
        return err(installError("E_CONFLICT", "subject_hash", "subject_hash_mismatch"));
      }
      const subject = subjectResult.value;
      let snapshot:
        | {
            registrations: readonly ReadinessRegistrationRow[];
            hostContract: CapabilityRecord | null;
            hostProbe: HostProbeRecord | null;
            product: CapabilityRecord | null;
            productProbe: HostProbeRecord | null;
          }
        | null = null;
      try {
        snapshot = await deps.withTx((tx) => {
          const registrations = deps.readRegistrations(tx, {
            host_id: subject.host_id,
            mode: subject.mode,
            config_space: subject.config_space
          });
          if (!registrations.ok) {
            return null;
          }
          const hostCapabilities = deps.readCapabilities(tx, {
            host_id: subject.host_id,
            mode: subject.mode,
            config_space: subject.config_space,
            subject: "host_contract"
          });
          if (!hostCapabilities.ok) {
            return null;
          }
          const hostContract =
            hostCapabilities.value.find((record: CapabilityRecord) => record.name === "human_interaction_attested") ?? null;
          const hostProbe =
            hostContract?.probe_ref === undefined ? null : deps.readProbe(tx, hostContract.probe_ref);
          if (hostProbe !== null && !hostProbe.ok) {
            return null;
          }
          const applied = registrations.value.some((row: ReadinessRegistrationRow) => row.state === "applied");
          const productCapabilities = applied
            ? deps.readCapabilities(tx, {
                host_id: subject.host_id,
                mode: subject.mode,
                config_space: subject.config_space,
                subject: "product_adapter"
              })
            : ok([]);
          if (!productCapabilities.ok) {
            return null;
          }
          const product =
            productCapabilities.value.find((record: CapabilityRecord) => record.name === "human_interaction_attested") ?? null;
          const productProbe =
            product?.probe_ref === undefined ? null : deps.readProbe(tx, product.probe_ref);
          if (productProbe !== null && !productProbe.ok) {
            return null;
          }
          return {
            registrations: registrations.value,
            hostContract,
            hostProbe: hostProbe === null ? null : hostProbe.value,
            product,
            productProbe: productProbe === null ? null : productProbe.value
          };
        });
      } catch {
        return err(installError("E_IO", "readiness", "storage"));
      }
      if (snapshot === null) {
        return err(installError("E_IO", "readiness", "storage"));
      }
      const states = snapshot.registrations.map((row: ReadinessRegistrationRow) => row.state);
      const appliedRows = snapshot.registrations.filter((row: ReadinessRegistrationRow) => row.state === "applied");
      const inflight = states.some((state) => state === "intent" || state === "applying" || state === "unknown");
      const relevant = states.filter(
        (state) => state === "applied" || state === "intent" || state === "applying" || state === "unknown"
      );
      let activeBinding: AdapterInstallReadinessView["active_binding"];
      if (relevant.length === 0) {
        activeBinding = "none";
      } else if (appliedRows.length === 1 && !inflight) {
        activeBinding = "adapter";
      } else {
        activeBinding = "unknown";
      }
      const hostContract = await evaluateHostContract(deps, subject, input.subject_hash, snapshot.hostContract, snapshot.hostProbe);
      let productAdapter: AdapterInstallReadinessView["product_adapter"] = null;
      if (activeBinding === "adapter") {
        const applied = appliedRows[0];
        if (applied !== undefined) {
          productAdapter = await evaluateProductAdapter(
            deps,
            subject,
            input.subject_hash,
            applied,
            snapshot.product,
            snapshot.productProbe
          );
        }
      }
      return ok({
        active_binding: activeBinding,
        host_contract: hostContract,
        product_adapter: productAdapter
      });
    }
  };
}

async function evaluateHostContract(
  deps: AdapterInstallReadinessDeps,
  subject: AdapterInstallSubject,
  subjectHash: Hash,
  capability: CapabilityRecord | null,
  probe: HostProbeRecord | null
): Promise<AdapterInstallReadinessView["host_contract"]> {
  if (capability === null || capability.probe_ref === undefined) {
    return null;
  }
  const assertion = probe?.assertions.find(
    (entry) => entry.capability === "human_interaction_attested" && entry.pass === true
  );
  const evidenceRef = firstEvidenceRef(capability, assertion);
  if (evidenceRef === null) {
    return null;
  }
  if (
    capability.status !== "verified" ||
    capability.evidence_stage !== "roundtrip" ||
    capability.probe_result !== "passed" ||
    probe === null ||
    probe.probe_action !== "confirm_control_plane" ||
    probe.result !== "passed"
  ) {
    return {
      status: "unverified",
      roundtrip: capability.evidence_stage === "roundtrip",
      probe_passed: probe !== null && probe.result === "passed",
      evidence_ref: evidenceRef
    };
  }
  if (assertion === undefined || !isHash(assertion.expected) || !isSourceRef(assertion.observed_ref)) {
    return { status: "unverified", roundtrip: true, probe_passed: true, evidence_ref: evidenceRef };
  }
  const proof = await readProof(deps, assertion.observed_ref);
  if (proof === null) {
    return { status: "unknown", roundtrip: true, probe_passed: true, evidence_ref: assertion.observed_ref };
  }
  const expected = confirmControlPlaneExpected(proof.subject_hash, proof.nonce);
  if (
    proof.purpose !== "adapter_install" ||
    proof.subject_hash !== subjectHash ||
    assertion.expected !== expected
  ) {
    return { status: "unverified", roundtrip: true, probe_passed: true, evidence_ref: assertion.observed_ref };
  }
  return { status: "verified", roundtrip: true, probe_passed: true, evidence_ref: assertion.observed_ref };
}

function firstEvidenceRef(
  capability: CapabilityRecord,
  assertion: { observed_ref: string } | undefined
): SourceRef | null {
  if (assertion !== undefined && isSourceRef(assertion.observed_ref)) {
    return assertion.observed_ref;
  }
  for (const ref of capability.evidence_refs) {
    if (isSourceRef(ref)) {
      return ref;
    }
  }
  return null;
}

async function evaluateProductAdapter(
  deps: AdapterInstallReadinessDeps,
  subject: AdapterInstallSubject,
  subjectHash: Hash,
  applied: ReadinessRegistrationRow,
  capability: CapabilityRecord | null,
  probe: HostProbeRecord | null
): Promise<AdapterInstallReadinessView["product_adapter"]> {
  if (capability === null || capability.probe_ref === undefined || applied.artifact_ref === null) {
    return null;
  }
  const evidenceRef = applied.artifact_ref;
  if (
    capability.status !== "verified" ||
    capability.evidence_stage !== "roundtrip" ||
    capability.probe_result !== "passed" ||
    probe === null ||
    probe.result !== "passed"
  ) {
    return {
      active: false,
      adapter_version: applied.adapter_version,
      implementation_hash: applied.implementation_hash,
      evidence_ref: evidenceRef
    };
  }
  const assertion = probe.assertions.find(
    (entry) => entry.capability === "human_interaction_attested" && entry.pass === true
  );
  if (assertion === undefined || !isSourceRef(assertion.observed_ref)) {
    return {
      active: false,
      adapter_version: applied.adapter_version,
      implementation_hash: applied.implementation_hash,
      evidence_ref: evidenceRef
    };
  }
  const proof = await readProof(deps, assertion.observed_ref);
  if (proof === null) {
    return null;
  }
  if (proof.purpose !== "adapter_install" || proof.subject_hash !== subjectHash) {
    return {
      active: false,
      adapter_version: applied.adapter_version,
      implementation_hash: applied.implementation_hash,
      evidence_ref: evidenceRef
    };
  }
  return {
    active: true,
    adapter_version: applied.adapter_version,
    implementation_hash: applied.implementation_hash,
    evidence_ref: assertion.observed_ref
  };
}

/** Reads a monotonic remaining budget; `1..600000` at the call site. */
export function validDeadline(value: unknown): value is number {
  return isSafePositiveInt(value) && value <= 600_000;
}
