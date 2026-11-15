/**
 * HOST `AdapterInstallReadinessPort` backed by the five HOST trust tables
 * (DD-HOST-001, DD-FND-102).
 *
 * The port is read-only. It reads the current `(host_id, mode, config_space)`
 * registrations, the exact `host_contract` / `product_adapter` capability
 * records and their referenced probes, then verifies every evidence reference
 * through the `SourceRefPort`.
 *
 * Fail-closed rules:
 *   - no applied/in-flight registration -> `active_binding="none"`
 *   - exactly one applied and no in-flight registration -> `"adapter"`
 *   - in-flight, duplicate or ambiguous rows -> `"unknown"`
 *   - missing capability or probe -> `null`
 *   - partial/unreadable records -> `"unknown"` (never `"verified"`)
 *   - state, binding, probe action, expected hash or proof mismatch -> `"unverified"`
 *   - only a retrievable `control_plane_explicit_confirmation` proof whose
 *     `purpose`/`subject_hash` match the request yields `"verified"`
 *
 * This module never writes, never calls an adapter and never invents a
 * capability, probe or verification.
 */

import type {
  AdapterInstallSubject,
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  SourceRef,
  SourceRefPort
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  isHash,
  isHostId,
  isHostMode,
  isId,
  isSourceRef,
  makeErrorEnvelope,
  ok,
  toJsonValue
} from "@evoplug/core";
import type { SqliteConnection, SqlRow } from "@evoplug/storage";

import type { InstallReadinessPort, InstallReadinessView } from "./install-service.js";

type Row = Readonly<Record<string, unknown>>;

type HostContractView = NonNullable<InstallReadinessView["host_contract"]>;
type ProductAdapterView = NonNullable<InstallReadinessView["product_adapter"]>;

export interface InstallReadinessDeps {
  /** Open FND SQLite connection; only read-only SELECTs are issued. */
  readonly connection: SqliteConnection;
  /** Retrievability and hash verification for capability/probe evidence. */
  readonly source_refs: Pick<SourceRefPort, "resolve">;
}

interface CapabilityBindingShape {
  readonly host_id: string;
  readonly source_pin: {
    readonly host_version: string;
    readonly host_version_kind: string;
    readonly source_commit: string | null;
  };
  readonly binary_pin: {
    readonly binary_version: string | null;
    readonly binary_hash: Hash | null;
  };
  readonly adapter_version: string;
  readonly subject: "host_contract" | "product_adapter";
  readonly mode: string;
  readonly config_space: string;
  readonly root_id: string;
  readonly construction_path: string;
  readonly execution_environment: {
    readonly os: string;
    readonly arch: string;
    readonly isolation: "local" | "container" | "remote";
  };
  readonly mapping: "exact" | "partial" | "unmapped";
  readonly backend_id?: string;
}

interface CapabilityCandidate {
  readonly capability_id: string;
  readonly binding_key: Hash;
  readonly binding: CapabilityBindingShape;
  readonly status: string;
  readonly evidence_stage: string;
  readonly evidence_refs: readonly SourceRef[];
  readonly probe_ref: string | null;
  readonly probe_result: string | null;
}

type CandidateLookup =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly candidate: CapabilityCandidate }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unreadable" };

interface ProbeAssertion {
  readonly capability: string;
  readonly expected: string;
  readonly observed_ref: SourceRef | null;
  readonly pass: boolean | "unknown";
}

interface ProbeShape {
  readonly probe_id: string;
  readonly binding_key: Hash;
  readonly binding: CapabilityBindingShape;
  readonly probe_action: string;
  readonly result: string;
  readonly assertions: readonly ProbeAssertion[];
  readonly evidence_refs: readonly SourceRef[];
}

type ProbeLookup =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly probe: ProbeShape }
  | { readonly kind: "invalid" };

interface ControlPlaneProof {
  readonly purpose: string;
  readonly subject_hash: Hash;
  readonly nonce: string;
  readonly confirmed_at: number;
}

type ProofRead =
  | { readonly kind: "ok"; readonly proof: ControlPlaneProof }
  | { readonly kind: "invalid" }
  | { readonly kind: "unreadable" };

interface AppliedRegistration {
  readonly adapter_version: string | null;
  readonly implementation_hash: Hash | null;
  readonly artifact_ref: SourceRef | null;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function readinessError(
  code: "E_SCHEMA" | "E_CONFLICT" | "E_IO",
  stage: string,
  details: ErrorEnvelope["details"]
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: code === "E_SCHEMA" ? "schema" : code === "E_CONFLICT" ? "conflict" : "storage",
    message_key: code === "E_IO" ? "error.io.failed" : `error.${code.toLowerCase()}`,
    stage,
    details
  });
}

function fieldError(path: string, rule: string): Result<never, ErrorEnvelope> {
  return err(readinessError("E_SCHEMA", "install_readiness", { kind: "field", path, rule }));
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function oneRow(
  connection: SqliteConnection,
  sql: string,
  params: Readonly<Record<string, string | number | null>>
): Row | null {
  const row: SqlRow | undefined = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row;
}

function allRows(
  connection: SqliteConnection,
  sql: string,
  params: Readonly<Record<string, string | number | null>>
): readonly Row[] {
  return connection.prepare<SqlRow>(sql).all(params);
}

function parseJcs(text: string): JsonValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  try {
    const value = toJsonValue(parsed);
    return canonicalJsonText(value) === text ? value : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/* ------------------------------------------------------------------ */
/* Subject and binding identities                                      */
/* ------------------------------------------------------------------ */

function validateSubject(value: unknown): Result<AdapterInstallSubject, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fieldError("subject", "object");
  }
  if (value["schema_version"] !== "rsi.adapter_install_subject/1" || value["purpose"] !== "adapter_install") {
    return fieldError("subject.purpose", "adapter_install");
  }
  const hostId = value["host_id"];
  const mode = value["mode"];
  const configSpace = value["config_space"];
  const adapterId = value["adapter_id"];
  const adapterVersion = value["adapter_version"];
  const targetId = value["target_id"];
  const implementationHash = value["implementation_hash"];
  const artifactHash = value["artifact_hash"];
  const previous = value["expected_previous_hash"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return fieldError("subject.host_id", "host_id");
  }
  if (typeof mode !== "string" || !isHostMode(mode)) {
    return fieldError("subject.mode", "host_mode");
  }
  if (!nonEmptyString(configSpace, 128)) {
    return fieldError("subject.config_space", "1..128");
  }
  if (typeof adapterId !== "string" || !isId(adapterId, "adp")) {
    return fieldError("subject.adapter_id", "adp_id");
  }
  if (!nonEmptyString(adapterVersion, 64)) {
    return fieldError("subject.adapter_version", "1..64");
  }
  if (!nonEmptyString(targetId, 256)) {
    return fieldError("subject.target_id", "1..256");
  }
  if (typeof implementationHash !== "string" || !isHash(implementationHash)) {
    return fieldError("subject.implementation_hash", "sha256_hash");
  }
  if (typeof artifactHash !== "string" || !isHash(artifactHash)) {
    return fieldError("subject.artifact_hash", "sha256_hash");
  }
  if (previous !== null && (typeof previous !== "string" || !isHash(previous))) {
    return fieldError("subject.expected_previous_hash", "hash_or_null");
  }
  return ok({
    schema_version: "rsi.adapter_install_subject/1",
    purpose: "adapter_install",
    host_id: hostId,
    mode,
    config_space: configSpace,
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    implementation_hash: implementationHash,
    target_id: targetId,
    artifact_hash: artifactHash,
    expected_previous_hash: previous
  });
}

function computeSubjectHash(subject: AdapterInstallSubject): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: subject.schema_version,
      purpose: subject.purpose,
      host_id: subject.host_id,
      mode: subject.mode,
      config_space: subject.config_space,
      adapter_id: subject.adapter_id,
      adapter_version: subject.adapter_version,
      implementation_hash: subject.implementation_hash,
      target_id: subject.target_id,
      artifact_hash: subject.artifact_hash,
      expected_previous_hash: subject.expected_previous_hash
    })
  );
}

function bindingJson(binding: CapabilityBindingShape): JsonValue {
  return toJsonValue({
    host_id: binding.host_id,
    source_pin: {
      host_version: binding.source_pin.host_version,
      host_version_kind: binding.source_pin.host_version_kind,
      source_commit: binding.source_pin.source_commit
    },
    binary_pin: {
      binary_version: binding.binary_pin.binary_version,
      binary_hash: binding.binary_pin.binary_hash
    },
    adapter_version: binding.adapter_version,
    subject: binding.subject,
    mode: binding.mode,
    config_space: binding.config_space,
    root_id: binding.root_id,
    construction_path: binding.construction_path,
    execution_environment: {
      os: binding.execution_environment.os,
      arch: binding.execution_environment.arch,
      isolation: binding.execution_environment.isolation
    },
    mapping: binding.mapping,
    backend_id: binding.backend_id ?? null
  });
}

function capabilityBindingKey(binding: CapabilityBindingShape): Hash {
  return canonicalHash(bindingJson(binding));
}

function parseBinding(value: JsonValue): CapabilityBindingShape | null {
  if (!isRecord(value)) {
    return null;
  }
  const hostId = value["host_id"];
  const adapterVersion = value["adapter_version"];
  const subject = value["subject"];
  const mode = value["mode"];
  const configSpace = value["config_space"];
  const rootId = value["root_id"];
  const constructionPath = value["construction_path"];
  const mapping = value["mapping"];
  const sourcePin = value["source_pin"];
  const binaryPin = value["binary_pin"];
  const environment = value["execution_environment"];
  if (typeof hostId !== "string" || !isHostId(hostId)) return null;
  if (typeof mode !== "string" || !isHostMode(mode)) return null;
  if (typeof configSpace !== "string" || configSpace.length === 0) return null;
  if (subject !== "host_contract" && subject !== "product_adapter") return null;
  if (typeof adapterVersion !== "string" || adapterVersion.length === 0) return null;
  if (typeof rootId !== "string" || rootId.length === 0) return null;
  if (typeof constructionPath !== "string" || constructionPath.length === 0) return null;
  if (mapping !== "exact" && mapping !== "partial" && mapping !== "unmapped") return null;
  if (!isRecord(sourcePin)) return null;
  if (typeof sourcePin["host_version"] !== "string") return null;
  if (typeof sourcePin["host_version_kind"] !== "string") return null;
  const sourceCommit = sourcePin["source_commit"];
  if (sourceCommit !== null && typeof sourceCommit !== "string") return null;
  if (!isRecord(binaryPin)) return null;
  const binaryVersion = binaryPin["binary_version"];
  const binaryHash = binaryPin["binary_hash"];
  if (binaryVersion !== null && typeof binaryVersion !== "string") return null;
  if (binaryHash !== null && (typeof binaryHash !== "string" || !isHash(binaryHash))) return null;
  if (!isRecord(environment)) return null;
  if (typeof environment["os"] !== "string" || typeof environment["arch"] !== "string") return null;
  const isolation = environment["isolation"];
  if (isolation !== "local" && isolation !== "container" && isolation !== "remote") return null;
  const backendId = value["backend_id"];
  if (backendId !== undefined && typeof backendId !== "string") return null;
  const binding: CapabilityBindingShape = {
    host_id: hostId,
    source_pin: {
      host_version: sourcePin["host_version"],
      host_version_kind: sourcePin["host_version_kind"],
      source_commit: sourceCommit
    },
    binary_pin: {
      binary_version: binaryVersion,
      binary_hash: binaryHash
    },
    adapter_version: adapterVersion,
    subject,
    mode,
    config_space: configSpace,
    root_id: rootId,
    construction_path: constructionPath,
    execution_environment: {
      os: environment["os"],
      arch: environment["arch"],
      isolation
    },
    mapping,
    ...(backendId === undefined ? {} : { backend_id: backendId })
  };
  return binding;
}

/* ------------------------------------------------------------------ */
/* Capability and probe reads                                          */
/* ------------------------------------------------------------------ */

function parseEvidenceRefs(text: string | null): readonly SourceRef[] | null {
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const refs: SourceRef[] = [];
  for (const value of parsed) {
    if (typeof value !== "string" || !isSourceRef(value)) {
      return null;
    }
    refs.push(value);
  }
  return refs;
}

function readCapabilities(
  connection: SqliteConnection,
  subject: AdapterInstallSubject,
  capabilitySubject: "host_contract" | "product_adapter"
): CandidateLookup {
  const rows = allRows(
    connection,
    `SELECT capability_id, binding_key, binding_json, name, status, evidence_stage,
            evidence_refs_json, probe_ref, probe_result
       FROM capability_record
      WHERE name = :name`,
    { name: "human_interaction_attested" }
  );
  const byBinding = new Map<string, CapabilityCandidate>();
  let malformed = false;
  for (const row of rows) {
    const bindingText = rowString(row, "binding_json");
    const bindingKeyText = rowString(row, "binding_key");
    const capabilityId = rowString(row, "capability_id");
    const status = rowString(row, "status");
    const evidenceStage = rowString(row, "evidence_stage");
    if (
      bindingText === null ||
      bindingKeyText === null ||
      !isHash(bindingKeyText) ||
      capabilityId === null ||
      status === null ||
      evidenceStage === null
    ) {
      malformed = true;
      continue;
    }
    const value = parseJcs(bindingText);
    const binding = value === null ? null : parseBinding(value);
    if (binding === null) {
      malformed = true;
      continue;
    }
    if (capabilityBindingKey(binding) !== bindingKeyText) {
      malformed = true;
      continue;
    }
    if (
      binding.host_id !== subject.host_id ||
      binding.mode !== subject.mode ||
      binding.config_space !== subject.config_space ||
      binding.subject !== capabilitySubject
    ) {
      continue;
    }
    const evidenceRefs = parseEvidenceRefs(rowString(row, "evidence_refs_json"));
    if (evidenceRefs === null) {
      malformed = true;
      continue;
    }
    const probeRef = rowString(row, "probe_ref");
    const probeResult = rowString(row, "probe_result");
    const existing = byBinding.get(bindingKeyText);
    if (existing === undefined) {
      byBinding.set(bindingKeyText, {
        capability_id: capabilityId,
        binding_key: bindingKeyText,
        binding,
        status,
        evidence_stage: evidenceStage,
        evidence_refs: evidenceRefs,
        probe_ref: probeRef,
        probe_result: probeResult
      });
    } else {
      // Duplicate rows for one binding key are not a second candidate.
      malformed = true;
    }
  }
  if (byBinding.size > 1) {
    return { kind: "ambiguous" };
  }
  const candidate = [...byBinding.values()][0];
  if (candidate === undefined) {
    return malformed ? { kind: "unreadable" } : { kind: "none" };
  }
  return { kind: "one", candidate };
}

function parseAssertions(text: string | null): readonly ProbeAssertion[] | null {
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const assertions: ProbeAssertion[] = [];
  for (const value of parsed) {
    if (!isRecord(value)) {
      return null;
    }
    const capability = value["capability"];
    const expected = value["expected"];
    const observedRef = value["observed_ref"];
    const pass = value["pass"];
    if (typeof capability !== "string" || typeof expected !== "string") {
      return null;
    }
    if (observedRef !== undefined && (typeof observedRef !== "string" || !isSourceRef(observedRef))) {
      return null;
    }
    if (pass !== true && pass !== false && pass !== "unknown") {
      return null;
    }
    assertions.push({
      capability,
      expected,
      observed_ref: observedRef === undefined ? null : observedRef,
      pass
    });
  }
  return assertions;
}

function readProbe(connection: SqliteConnection, probeId: string): ProbeLookup {
  const row = oneRow(
    connection,
    `SELECT probe_id, binding_key, binding_json, subject, probe_action, result,
            assertions_json, evidence_refs_json
       FROM host_probe
      WHERE probe_id = :probe_id`,
    { probe_id: probeId }
  );
  if (row === null) {
    return { kind: "none" };
  }
  const probeIdValue = rowString(row, "probe_id");
  const bindingKeyText = rowString(row, "binding_key");
  const bindingText = rowString(row, "binding_json");
  const probeSubject = rowString(row, "subject");
  const probeAction = rowString(row, "probe_action");
  const result = rowString(row, "result");
  const evidenceRefs = parseEvidenceRefs(rowString(row, "evidence_refs_json"));
  const assertions = parseAssertions(rowString(row, "assertions_json"));
  if (
    probeIdValue === null ||
    bindingKeyText === null ||
    !isHash(bindingKeyText) ||
    bindingText === null ||
    probeSubject === null ||
    probeAction === null ||
    result === null ||
    evidenceRefs === null ||
    assertions === null
  ) {
    return { kind: "invalid" };
  }
  const value = parseJcs(bindingText);
  const binding = value === null ? null : parseBinding(value);
  if (binding === null || binding.subject !== probeSubject || capabilityBindingKey(binding) !== bindingKeyText) {
    return { kind: "invalid" };
  }
  return {
    kind: "one",
    probe: {
      probe_id: probeIdValue,
      binding_key: bindingKeyText,
      binding,
      probe_action: probeAction,
      result,
      assertions,
      evidence_refs: evidenceRefs
    }
  };
}

/* ------------------------------------------------------------------ */
/* Evidence verification                                               */
/* ------------------------------------------------------------------ */

async function safeResolve(
  deps: InstallReadinessDeps,
  ref: SourceRef
): Promise<{ readonly ok: boolean; readonly bytes: Uint8Array | null }> {
  try {
    const resolved = await deps.source_refs.resolve(ref, { maxBytes: 1_048_576 });
    if (!resolved.ok || !resolved.value.retrievable || resolved.value.bytes === null) {
      return { ok: false, bytes: null };
    }
    return { ok: true, bytes: resolved.value.bytes };
  } catch {
    return { ok: false, bytes: null };
  }
}

function parseProof(text: string): ControlPlaneProof | null {
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
  if (!isRecord(subject) || subject["kind"] !== "control_plane") {
    return null;
  }
  const purpose = subject["purpose"];
  const subjectHash = subject["subject_hash"];
  const nonce = parsed["nonce"];
  const confirmedAt = parsed["confirmed_at"];
  if (typeof purpose !== "string") return null;
  if (typeof subjectHash !== "string" || !isHash(subjectHash)) return null;
  if (typeof nonce !== "string") return null;
  if (typeof confirmedAt !== "number" || !Number.isSafeInteger(confirmedAt) || confirmedAt < 0) return null;
  return { purpose, subject_hash: subjectHash, nonce, confirmed_at: confirmedAt };
}

async function readProof(deps: InstallReadinessDeps, ref: SourceRef): Promise<ProofRead> {
  const resolved = await safeResolve(deps, ref);
  if (!resolved.ok || resolved.bytes === null) {
    return { kind: "unreadable" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes);
  } catch {
    return { kind: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  let value: JsonValue;
  try {
    value = toJsonValue(parsed);
  } catch {
    return { kind: "unreadable" };
  }
  if (canonicalJsonText(value) !== text) {
    return { kind: "unreadable" };
  }
  const proof = parseProof(text);
  return proof === null ? { kind: "invalid" } : { kind: "ok", proof };
}

function controlPlaneExpected(subjectHash: Hash, nonce: string): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: "rsi.confirm_control_plane_probe/1",
      subject_hash: subjectHash,
      challenge_nonce: nonce
    })
  );
}

function assertionFor(probe: ProbeShape): ProbeAssertion | undefined {
  return probe.assertions.find(
    (assertion) => assertion.capability === "human_interaction_attested" && assertion.pass === true
  );
}

function firstEvidenceRef(candidate: CapabilityCandidate, assertion: ProbeAssertion | undefined): SourceRef | null {
  if (assertion !== undefined && assertion.observed_ref !== null) {
    return assertion.observed_ref;
  }
  return candidate.evidence_refs[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Readiness evaluation                                                */
/* ------------------------------------------------------------------ */

async function evaluateHostContract(
  deps: InstallReadinessDeps,
  lookup: CandidateLookup,
  subjectHash: Hash
): Promise<HostContractView | null> {
  if (lookup.kind !== "one") {
    return null;
  }
  const candidate = lookup.candidate;
  if (candidate.probe_ref === null) {
    return null;
  }
  const probeLookup = readProbe(deps.connection, candidate.probe_ref);
  const probe = probeLookup.kind === "one" ? probeLookup.probe : null;
  const assertion = probe === null ? undefined : assertionFor(probe);
  const evidenceRef = firstEvidenceRef(candidate, assertion);
  if (evidenceRef === null) {
    return null;
  }
  const roundtrip = candidate.evidence_stage === "roundtrip";
  const probePassed = probe !== null && probe.result === "passed";
  if (probeLookup.kind !== "one") {
    return {
      status: "unknown",
      roundtrip,
      probe_passed: probePassed,
      evidence_ref: evidenceRef
    };
  }
  const unverified: HostContractView = {
    status: "unverified",
    roundtrip,
    probe_passed: probePassed,
    evidence_ref: evidenceRef
  };
  if (
    candidate.status !== "verified" ||
    !roundtrip ||
    candidate.probe_result !== "passed" ||
    probe === null ||
    probe.probe_action !== "confirm_control_plane" ||
    probe.result !== "passed" ||
    probe.binding_key !== candidate.binding_key ||
    probe.binding.host_id !== candidate.binding.host_id ||
    probe.binding.mode !== candidate.binding.mode ||
    probe.binding.config_space !== candidate.binding.config_space ||
    probe.binding.subject !== "host_contract"
  ) {
    return unverified;
  }
  if (assertion === undefined || assertion.observed_ref === null || !isHash(assertion.expected)) {
    return { ...unverified, evidence_ref: assertion?.observed_ref ?? evidenceRef };
  }
  const read = await readProof(deps, assertion.observed_ref);
  if (read.kind !== "ok") {
    return {
      status: "unknown",
      roundtrip: true,
      probe_passed: true,
      evidence_ref: assertion.observed_ref
    };
  }
  if (
    read.proof.purpose !== "adapter_install" ||
    read.proof.subject_hash !== subjectHash ||
    assertion.expected !== controlPlaneExpected(read.proof.subject_hash, read.proof.nonce)
  ) {
    return {
      status: "unverified",
      roundtrip: true,
      probe_passed: true,
      evidence_ref: assertion.observed_ref
    };
  }
  return {
    status: "verified",
    roundtrip: true,
    probe_passed: true,
    evidence_ref: assertion.observed_ref
  };
}

async function evaluateProductAdapter(
  deps: InstallReadinessDeps,
  lookup: CandidateLookup,
  applied: AppliedRegistration,
  subjectHash: Hash
): Promise<ProductAdapterView | null> {
  if (lookup.kind !== "one") {
    return null;
  }
  const candidate = lookup.candidate;
  const probeRef = candidate.probe_ref;
  if (probeRef === null) {
    return null;
  }
  const probeLookup = readProbe(deps.connection, probeRef);
  if (probeLookup.kind !== "one") {
    return null;
  }
  const probe = probeLookup.probe;
  const assertion = assertionFor(probe);
  const evidenceRef = applied.artifact_ref ?? firstEvidenceRef(candidate, assertion);
  if (evidenceRef === null) {
    return null;
  }
  const inactive: ProductAdapterView = {
    active: false,
    adapter_version: applied.adapter_version,
    implementation_hash: applied.implementation_hash,
    evidence_ref: evidenceRef
  };
  if (
    candidate.status !== "verified" ||
    candidate.evidence_stage !== "roundtrip" ||
    candidate.probe_result !== "passed" ||
    probe.result !== "passed" ||
    applied.adapter_version === null ||
    applied.implementation_hash === null ||
    probe.binding_key !== candidate.binding_key ||
    probe.binding.host_id !== candidate.binding.host_id ||
    probe.binding.mode !== candidate.binding.mode ||
    probe.binding.config_space !== candidate.binding.config_space ||
    probe.binding.subject !== "product_adapter"
  ) {
    return inactive;
  }
  if (assertion === undefined || assertion.observed_ref === null) {
    return inactive;
  }
  const read = await readProof(deps, assertion.observed_ref);
  if (read.kind !== "ok") {
    // Evidence that cannot be read or parsed is an evidence-verification
    // failure for product_adapter, not a reason to claim activity.
    return inactive;
  }
  if (
    read.proof.purpose !== "adapter_install" ||
    read.proof.subject_hash !== subjectHash
  ) {
    return inactive;
  }
  return {
    active: true,
    adapter_version: applied.adapter_version,
    implementation_hash: applied.implementation_hash,
    evidence_ref: assertion.observed_ref
  };
}

function readApplied(
  connection: SqliteConnection,
  subject: AdapterInstallSubject
): {
  readonly activeBinding: "none" | "adapter" | "unknown";
  readonly applied: AppliedRegistration | null;
} {
  const rows = allRows(
    connection,
    `SELECT state, adapter_version, implementation_hash, artifact_ref
       FROM adapter_registration
      WHERE host_id = :host_id AND mode = :mode AND config_space = :config_space`,
    {
      host_id: subject.host_id,
      mode: subject.mode,
      config_space: subject.config_space
    }
  );
  const relevant = rows.filter((row) => {
    const state = rowString(row, "state");
    return state === "applied" || state === "intent" || state === "applying" || state === "unknown";
  });
  const appliedRows = relevant.filter((row) => rowString(row, "state") === "applied");
  const inflight = relevant.some((row) => {
    const state = rowString(row, "state");
    return state === "intent" || state === "applying" || state === "unknown";
  });
  if (relevant.length === 0) {
    return { activeBinding: "none", applied: null };
  }
  if (appliedRows.length === 1 && !inflight) {
    const row = appliedRows[0];
    if (row === undefined) {
      return { activeBinding: "unknown", applied: null };
    }
    const version = rowString(row, "adapter_version");
    const implementationHash = rowString(row, "implementation_hash");
    const artifactRef = rowString(row, "artifact_ref");
    return {
      activeBinding: "adapter",
      applied: {
        adapter_version: version !== null && version.length > 0 ? version : null,
        implementation_hash:
          implementationHash !== null && isHash(implementationHash) ? implementationHash : null,
        artifact_ref: artifactRef !== null && isSourceRef(artifactRef) ? artifactRef : null
      }
    };
  }
  return { activeBinding: "unknown", applied: null };
}

/** Builds the read-only HOST readiness port consumed by FND install approval. */
export function createInstallReadinessPort(deps: InstallReadinessDeps): InstallReadinessPort {
  return {
    async get(input: {
      readonly request_id: string;
      readonly subject: AdapterInstallSubject;
      readonly subject_hash: Hash;
    }): Promise<Result<InstallReadinessView, ErrorEnvelope>> {
      if (
        typeof input.request_id !== "string" ||
        input.request_id.length === 0 ||
        input.request_id.length > 128
      ) {
        return fieldError("request_id", "1..128");
      }
      if (typeof input.subject_hash !== "string" || !isHash(input.subject_hash)) {
        return fieldError("subject_hash", "sha256_hash");
      }
      const subject = validateSubject(input.subject);
      if (!subject.ok) {
        return subject;
      }
      if (computeSubjectHash(subject.value) !== input.subject_hash) {
        return err(readinessError("E_CONFLICT", "install_readiness", { kind: "field", path: "subject_hash", rule: "subject_hash_mismatch" }));
      }
      try {
        const { activeBinding: registrationBinding, applied } = readApplied(deps.connection, subject.value);
        let activeBinding = registrationBinding;
        const hostLookup = readCapabilities(deps.connection, subject.value, "host_contract");
        const productLookup =
          activeBinding === "adapter" && applied !== null
            ? readCapabilities(deps.connection, subject.value, "product_adapter")
            : ({ kind: "none" } as const);
        if (hostLookup.kind === "ambiguous" || productLookup.kind === "ambiguous") {
          activeBinding = "unknown";
        }
        const hostContract = await evaluateHostContract(deps, hostLookup, input.subject_hash);
        const productAdapter =
          activeBinding === "adapter" && applied !== null
            ? await evaluateProductAdapter(deps, productLookup, applied, input.subject_hash)
            : null;
        return ok({
          active_binding: activeBinding,
          host_contract: hostContract,
          product_adapter: productAdapter
        });
      } catch {
        return err(readinessError("E_IO", "install_readiness", { kind: "none" }));
      }
    }
  };
}
