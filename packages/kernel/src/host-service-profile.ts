/**
 * HOST `HostServiceProfileReadPort` over the existing capability/probe tables
 * (DD-HOST-002, DD-CAP-004).
 *
 * The port is read-only. It never calls a probe producer, an adapter, EVD or
 * REV, and it never writes a capability, probe, blob or journal row. A usable
 * profile is the frozen copy derived from one verified `host_probe` and its
 * content-addressed `ServiceProfileEvidence` blob:
 *
 *   1. request schema, exact `host_contract` binding and `backend_id` gate;
 *   2. one read-only transaction over `capability_record` + `host_probe`;
 *   3. strict UTF-8/JCS evidence bytes through `SourceRefPort.resolve`;
 *   4. independent `service_profile_key` and `evidence_hash` recomputation;
 *   5. `ServiceProfile` construction from the evidence fields only.
 *
 * Missing rows, non-verified records, non-`read_only` probes and binding
 * mismatches are `Ok(null)`. Structural evidence errors are `E_CONFLICT`.
 * Unreadable storage is `E_IO`; unresolvable evidence is `E_EVIDENCE_UNKNOWN`.
 */

import type {
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  SourceRef,
  SourceRefPort,
  UnretrievableReason
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  hashBytes,
  isHash,
  isSourceRef,
  makeErrorEnvelope,
  ok,
  toJsonValue
} from "@evoplug/core";
import type {
  GenerationBackendSelection as ReviewGenerationBackendSelection,
  HostGenerationPort as ReviewHostGenerationPort
} from "@evoplug/review";
import type {
  CapabilityBinding,
  HostAdapterError as CoreHostAdapterError,
  HostAdapterResult,
  HostGenerationAdapterPort,
  HostServiceProfileReadPort,
  ServiceProfile,
  ServiceProfileEvidence
} from "@evoplug/core/host";
import {
  capabilityBindingKey,
  completeGenerationBackendSelection,
  hostErr,
  hostOk,
  validateCapabilityBinding,
  validateServiceProfileEvidence
} from "@evoplug/core/host";
import type { SqliteConnection, SqlRow } from "@evoplug/storage";

type Row = Readonly<Record<string, unknown>>;

const PROFILE_CAPABILITY = "generation.service_profile";
const PROFILE_PROBE_ACTION = "read_service_profile";
const MAX_DEADLINE_MS = 600_000;
const MAX_REQUEST_ID_LENGTH = 128;

const EVIDENCE_KEYS = new Set([
  "schema_version",
  "provider_scope",
  "backend_id",
  "host_id",
  "mode",
  "config_space",
  "request_max_tokens",
  "question_max_tokens",
  "max_output_tokens",
  "rpm",
  "concurrency",
  "pricing",
  "profile_hash",
  "observed_at"
]);

const DETAILS_KEYS = new Set([
  "profile_schema",
  "evidence_schema",
  "provider_scope",
  "profile_key",
  "observed_at"
]);

export interface HostServiceProfileReadDeps {
  /** Open FND SQLite connection; only read-only SELECTs are issued. */
  readonly connection: SqliteConnection;
  /** Retrievability and hash verification for the evidence blob. */
  readonly source_refs: Pick<SourceRefPort, "resolve">;
  /** Monotonic clock used for the entry deadline. */
  readonly now?: () => number;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function profileError(
  code: "E_SCHEMA" | "E_CONFLICT" | "E_IO" | "E_EVIDENCE_UNKNOWN" | "E_DEADLINE_EXCEEDED" | "E_CANCELLED",
  stage: string,
  details: ErrorEnvelope["details"],
  detailRef?: SourceRef
): ErrorEnvelope {
  const category =
    code === "E_SCHEMA"
      ? "schema"
      : code === "E_CONFLICT"
        ? "conflict"
        : code === "E_IO"
          ? "storage"
          : code === "E_EVIDENCE_UNKNOWN"
            ? "source"
            : "deadline";
  const messageKey =
    code === "E_IO"
      ? "error.io.failed"
      : code === "E_EVIDENCE_UNKNOWN"
        ? "error.evidence_unknown"
        : `error.${code.toLowerCase()}`;
  return makeErrorEnvelope({
    code,
    category,
    message_key: messageKey,
    stage,
    details,
    ...(detailRef === undefined ? {} : { detail_ref: detailRef })
  });
}

function fieldError(path: string, rule: string): ErrorEnvelope {
  return profileError("E_SCHEMA", "service_profile_read", { kind: "field", path, rule });
}

function conflictError(path: string, rule: string, detailRef?: SourceRef): ErrorEnvelope {
  return profileError("E_CONFLICT", "service_profile_read", { kind: "field", path, rule }, detailRef);
}

function storageError(): ErrorEnvelope {
  return profileError("E_IO", "service_profile_read", {
    kind: "storage",
    operation: "service_profile_read"
  });
}

function evidenceUnavailable(
  ref: SourceRef,
  reason: UnretrievableReason | "tombstoned" | "hash_mismatch"
): ErrorEnvelope {
  return profileError(
    "E_EVIDENCE_UNKNOWN",
    "service_profile_read",
    { kind: "source", source_ref: ref, reason },
    ref
  );
}

function deadlineError(): ErrorEnvelope {
  return profileError("E_DEADLINE_EXCEEDED", "service_profile_read", { kind: "none" });
}

function cancelledError(): ErrorEnvelope {
  return profileError("E_CANCELLED", "service_profile_read", { kind: "none" });
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function oneRow(
  connection: SqliteConnection,
  sql: string,
  params: Readonly<Record<string, string | number | null>>
): Row | null {
  const row: SqlRow | undefined = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function rowNumber(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Strict JCS text; a non-canonical row is not a usable binding. */
function parseJcs(text: string | null): JsonValue | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
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

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function pricingJson(pricing: ServiceProfileEvidence["pricing"]): JsonValue {
  return pricing.status === "unknown"
    ? { status: "unknown" }
    : {
        status: "known",
        input_micros_per_million: pricing.input_micros_per_million,
        output_micros_per_million: pricing.output_micros_per_million,
        fixed_micros: pricing.fixed_micros
      };
}

/** Independent DD-HOST-002 key recomputation (no producer value trusted). */
function recomputeServiceProfileKey(evidence: ServiceProfileEvidence): Hash {
  return canonicalHash({
    schema_version: "rsi.service_profile_key/1",
    provider_scope: evidence.provider_scope,
    backend_id: evidence.backend_id,
    host_id: evidence.host_id,
    mode: evidence.mode,
    config_space: evidence.config_space,
    request_max_tokens: evidence.request_max_tokens,
    question_max_tokens: evidence.question_max_tokens,
    max_output_tokens: evidence.max_output_tokens,
    rpm: evidence.rpm,
    concurrency: evidence.concurrency,
    pricing: pricingJson(evidence.pricing)
  });
}

/** Independent `evidence_hash = sha256(JCS(evidence))`. */
function recomputeEvidenceHash(evidence: ServiceProfileEvidence): Hash {
  return hashBytes(new TextEncoder().encode(canonicalJsonText(toJsonValue(evidence))));
}

function bindingMatches(
  binding: CapabilityBinding,
  expectedKey: Hash,
  backendId: string
): boolean {
  return (
    binding.subject === "host_contract" &&
    binding.adapter_version === "diagnostic" &&
    binding.backend_id === backendId &&
    capabilityBindingKey(binding) === expectedKey
  );
}

function becauseDeadline(deadlineAt: number, now: () => number): ErrorEnvelope | null {
  return now() > deadlineAt ? deadlineError() : null;
}

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

interface ValidRequest {
  readonly binding: CapabilityBinding;
  readonly bindingKey: Hash;
  readonly backendId: string;
  readonly deadlineAt: number;
}

function validateRequest(input: {
  request_id: string;
  binding: CapabilityBinding;
  backend_id: string;
  deadline_ms: number;
}, now: () => number): Result<ValidRequest, ErrorEnvelope> {
  if (
    typeof input.request_id !== "string" ||
    input.request_id.length === 0 ||
    input.request_id.length > MAX_REQUEST_ID_LENGTH
  ) {
    return err(fieldError("request_id", "1..128"));
  }
  if (
    !Number.isSafeInteger(input.deadline_ms) ||
    input.deadline_ms < 1 ||
    input.deadline_ms > MAX_DEADLINE_MS
  ) {
    return err(fieldError("deadline_ms", "1..600000"));
  }
  if (typeof input.backend_id !== "string" || input.backend_id.length === 0) {
    return err(fieldError("backend_id", "non_empty_string"));
  }
  const parsed = validateCapabilityBinding(input.binding);
  if (!parsed.ok) {
    return err(fieldError("binding", "capability_binding"));
  }
  const binding = parsed.value;
  if (binding.subject !== "host_contract") {
    return err(conflictError("binding.subject", "host_contract"));
  }
  if (binding.adapter_version !== "diagnostic") {
    return err(conflictError("binding.adapter_version", "diagnostic"));
  }
  if (binding.backend_id !== input.backend_id) {
    return err(conflictError("binding.backend_id", "backend_id"));
  }
  return ok({
    binding,
    bindingKey: capabilityBindingKey(binding),
    backendId: input.backend_id,
    deadlineAt: now() + input.deadline_ms
  });
}

/* ------------------------------------------------------------------ */
/* Persisted capability + probe read                                   */
/* ------------------------------------------------------------------ */

interface ProbeAssertion {
  readonly assertion_id: string;
  readonly capability: string;
  readonly expected: string;
  readonly observed_ref: SourceRef;
  readonly pass: boolean | "unknown";
}

interface ProbeResult {
  readonly name: string;
  readonly proposed_status: string;
  readonly evidence_stage: string;
  readonly evidence_refs: readonly string[];
}

interface PersistedProfile {
  readonly evidenceRef: SourceRef;
  readonly expectedEvidenceHash: Hash;
  readonly details: Record<string, unknown> | null;
}

type ProfileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly error: ErrorEnvelope }
  | { readonly kind: "found"; readonly value: PersistedProfile };

function parseEvidenceRefs(text: string | null): readonly string[] | null {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    return null;
  }
  return parsed;
}

function parseAssertion(value: unknown): ProbeAssertion | null {
  if (!isRecord(value)) return null;
  const assertionId = value["assertion_id"];
  const capability = value["capability"];
  const expected = value["expected"];
  const observedRef = value["observed_ref"];
  const pass = value["pass"];
  if (
    typeof assertionId !== "string" ||
    assertionId.length === 0 ||
    typeof capability !== "string" ||
    typeof expected !== "string" ||
    expected.length === 0 ||
    typeof observedRef !== "string" ||
    !isSourceRef(observedRef) ||
    (pass !== true && pass !== false && pass !== "unknown")
  ) {
    return null;
  }
  return {
    assertion_id: assertionId,
    capability,
    expected,
    observed_ref: observedRef,
    pass
  };
}

function parseCapabilityResult(value: unknown): ProbeResult | null {
  if (!isRecord(value)) return null;
  const name = value["name"];
  const proposedStatus = value["proposed_status"];
  const evidenceStage = value["evidence_stage"];
  const evidenceRefs = value["evidence_refs"];
  if (
    typeof name !== "string" ||
    typeof proposedStatus !== "string" ||
    typeof evidenceStage !== "string" ||
    !Array.isArray(evidenceRefs) ||
    !evidenceRefs.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return {
    name,
    proposed_status: proposedStatus,
    evidence_stage: evidenceStage,
    evidence_refs: evidenceRefs
  };
}

function readPersistedProfile(
  connection: SqliteConnection,
  crumb: {
    readonly binding: CapabilityBinding;
    readonly bindingKey: Hash;
    readonly backendId: string;
  }
): ProfileRead {
  const capability = oneRow(
    connection,
    `SELECT capability_id, binding_key, binding_json, name, status, evidence_stage,
            evidence_refs_json, probe_ref, probe_result, checked_at, details_json
       FROM capability_record
      WHERE binding_key = :binding_key AND name = :name`,
    { binding_key: crumb.bindingKey, name: PROFILE_CAPABILITY }
  );
  if (capability === null) {
    return { kind: "absent" };
  }
  const capabilityBindingText = rowString(capability, "binding_json");
  const capabilityBindingValue = parseJcs(capabilityBindingText);
  if (capabilityBindingValue === null || !isRecord(capabilityBindingValue)) {
    return { kind: "absent" };
  }
  const capabilityBinding = validateCapabilityBinding(capabilityBindingValue, {
    capabilityName: PROFILE_CAPABILITY
  });
  if (!capabilityBinding.ok) {
    return { kind: "absent" };
  }
  if (
    !bindingMatches(capabilityBinding.value, crumb.bindingKey, crumb.backendId) ||
    rowString(capability, "binding_key") !== crumb.bindingKey ||
    rowString(capability, "name") !== PROFILE_CAPABILITY ||
    rowString(capability, "status") !== "verified" ||
    rowString(capability, "evidence_stage") !== "roundtrip" ||
    rowString(capability, "probe_result") !== "passed"
  ) {
    return { kind: "absent" };
  }
  const probeRef = rowString(capability, "probe_ref");
  if (probeRef === null || probeRef.length === 0) {
    return { kind: "absent" };
  }
  const probe = oneRow(
    connection,
    `SELECT probe_id, binding_key, binding_json, subject, target_kind, probe_mode,
            probe_action, assertions_json, capability_results_json, result,
            expected, observed, evidence_refs_json, checked_at
       FROM host_probe
      WHERE probe_id = :probe_id AND binding_key = :binding_key`,
    { probe_id: probeRef, binding_key: crumb.bindingKey }
  );
  if (probe === null) {
    return { kind: "absent" };
  }
  const probeBindingValue = parseJcs(rowString(probe, "binding_json"));
  if (probeBindingValue === null || !isRecord(probeBindingValue)) {
    return { kind: "absent" };
  }
  const probeBinding = validateCapabilityBinding(probeBindingValue, {
    capabilityName: PROFILE_CAPABILITY
  });
  if (!probeBinding.ok) {
    return { kind: "absent" };
  }
  if (
    !bindingMatches(probeBinding.value, crumb.bindingKey, crumb.backendId) ||
    rowString(probe, "probe_id") !== probeRef ||
    rowString(probe, "binding_key") !== crumb.bindingKey ||
    rowString(probe, "subject") !== "host_contract" ||
    rowString(probe, "target_kind") !== "host" ||
    rowString(probe, "probe_mode") !== "read_only" ||
    rowString(probe, "probe_action") !== PROFILE_PROBE_ACTION ||
    rowString(probe, "result") !== "passed"
  ) {
    return { kind: "absent" };
  }

  const assertions = parseJson(rowString(probe, "assertions_json"));
  if (!Array.isArray(assertions)) {
    return { kind: "absent" };
  }
  if (assertions.length > 1) {
    return {
      kind: "invalid",
      error: conflictError("assertions", "duplicate")
    };
  }
  if (assertions.length === 0) {
    return { kind: "absent" };
  }
  const assertion = parseAssertion(assertions[0]);
  if (assertion === null) {
    return { kind: "absent" };
  }
  if (assertion.capability !== PROFILE_CAPABILITY || assertion.pass !== true) {
    return { kind: "absent" };
  }
  if (!isHash(assertion.expected)) {
    return { kind: "absent" };
  }
  const evidenceRef = assertion.observed_ref;

  const results = parseJson(rowString(probe, "capability_results_json"));
  if (!Array.isArray(results)) {
    return { kind: "absent" };
  }
  if (results.length > 1) {
    return {
      kind: "invalid",
      error: conflictError("capability_results", "duplicate")
    };
  }
  if (results.length === 0) {
    return { kind: "absent" };
  }
  const result = parseCapabilityResult(results[0]);
  if (result === null) {
    return { kind: "absent" };
  }
  if (
    result.name !== PROFILE_CAPABILITY ||
    result.proposed_status !== "verified" ||
    result.evidence_stage !== "roundtrip"
  ) {
    return { kind: "absent" };
  }
  if (result.evidence_refs.length !== 1 || result.evidence_refs[0] !== evidenceRef) {
    return {
      kind: "invalid",
      error: conflictError("capability_results.evidence_refs", "evidence_ref", evidenceRef)
    };
  }

  const capabilityEvidenceRefs = parseEvidenceRefs(rowString(capability, "evidence_refs_json"));
  if (
    capabilityEvidenceRefs === null ||
    capabilityEvidenceRefs.length !== 1 ||
    capabilityEvidenceRefs[0] !== evidenceRef
  ) {
    return {
      kind: "invalid",
      error: conflictError("capability.evidence_refs", "evidence_ref", evidenceRef)
    };
  }

  const detailsText = rowString(capability, "details_json");
  let details: Record<string, unknown> | null = null;
  if (detailsText !== null) {
    const parsedDetails = parseJson(detailsText);
    if (!isRecord(parsedDetails)) {
      return { kind: "invalid", error: conflictError("details", "object", evidenceRef) };
    }
    if (Object.keys(parsedDetails).some((key) => !DETAILS_KEYS.has(key))) {
      return { kind: "invalid", error: conflictError("details", "closed_subset", evidenceRef) };
    }
    details = parsedDetails;
  }

  return {
    kind: "found",
    value: {
      evidenceRef,
      expectedEvidenceHash: assertion.expected as Hash,
      details
    }
  };
}

/* ------------------------------------------------------------------ */
/* Evidence validation                                                 */
/* ------------------------------------------------------------------ */

interface DecodedEvidence {
  readonly evidence: ServiceProfileEvidence;
  readonly profileKey: Hash;
  readonly evidenceHash: Hash;
}

function decodeStrictEvidence(bytes: Uint8Array): Result<DecodedEvidence, ErrorEnvelope> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return err(conflictError("evidence", "utf8"));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return err(conflictError("evidence", "json"));
  }
  let canonicalValue: JsonValue;
  try {
    canonicalValue = toJsonValue(parsed);
  } catch {
    return err(conflictError("evidence", "json"));
  }
  if (canonicalJsonText(canonicalValue) !== text) {
    return err(conflictError("evidence", "jcs"));
  }
  if (!isRecord(canonicalValue) || !exactKeys(canonicalValue, EVIDENCE_KEYS)) {
    return err(conflictError("evidence", "closed_schema"));
  }
  const pricing = canonicalValue["pricing"];
  if (!isRecord(pricing)) {
    return err(conflictError("evidence.pricing", "object"));
  }
  if (pricing["status"] === "unknown") {
    if (Object.keys(pricing).length !== 1) {
      return err(conflictError("evidence.pricing", "unknown_branch"));
    }
  } else if (pricing["status"] === "known") {
    if (
      Object.keys(pricing).length !== 4 ||
      !Object.keys(pricing).every((key) =>
        ["status", "input_micros_per_million", "output_micros_per_million", "fixed_micros"].includes(key)
      )
    ) {
      return err(conflictError("evidence.pricing", "known_branch"));
    }
  } else {
    return err(conflictError("evidence.pricing", "status"));
  }
  const validated = validateServiceProfileEvidence(canonicalValue);
  if (!validated.ok) {
    return err(conflictError("evidence", "schema"));
  }
  const evidence = validated.value;
  const profileKey = recomputeServiceProfileKey(evidence);
  if (evidence.profile_hash !== profileKey) {
    return err(conflictError("evidence.profile_hash", "service_profile_key"));
  }
  return ok({
    evidence,
    profileKey,
    evidenceHash: recomputeEvidenceHash(evidence)
  });
}

function validateDetails(
  details: Record<string, unknown> | null,
  evidence: ServiceProfileEvidence,
  profileKey: Hash,
  evidenceRef: SourceRef
): ErrorEnvelope | null {
  if (details === null) return null;
  if (details["profile_schema"] !== undefined && details["profile_schema"] !== "rsi.service_profile/1") {
    return conflictError("details.profile_schema", "rsi.service_profile/1", evidenceRef);
  }
  if (
    details["evidence_schema"] !== undefined &&
    details["evidence_schema"] !== "rsi.service_profile_evidence/1"
  ) {
    return conflictError("details.evidence_schema", "rsi.service_profile_evidence/1", evidenceRef);
  }
  if (details["provider_scope"] !== undefined && details["provider_scope"] !== evidence.provider_scope) {
    return conflictError("details.provider_scope", "provider_scope", evidenceRef);
  }
  if (details["profile_key"] !== undefined && details["profile_key"] !== profileKey) {
    return conflictError("details.profile_key", "service_profile_key", evidenceRef);
  }
  if (details["observed_at"] !== undefined && details["observed_at"] !== evidence.observed_at) {
    return conflictError("details.observed_at", "observed_at", evidenceRef);
  }
  return null;
}

function freeze(evidence: ServiceProfileEvidence, profileKey: Hash, evidenceRef: SourceRef): ServiceProfile {
  return {
    schema_version: "rsi.service_profile/1",
    service_profile_id: profileKey,
    service_profile_key: profileKey,
    provider_scope: evidence.provider_scope,
    limits: {
      source: "verified_profile",
      profile_hash: profileKey,
      request_max_tokens: evidence.request_max_tokens,
      question_max_tokens: evidence.question_max_tokens,
      max_output_tokens: evidence.max_output_tokens,
      rpm: evidence.rpm,
      concurrency: evidence.concurrency,
      pricing: evidence.pricing
    },
    evidence_ref: evidenceRef
  };
}

/* ------------------------------------------------------------------ */
/* Public port                                                         */
/* ------------------------------------------------------------------ */

/** Builds the read-only `HostServiceProfileReadPort` over the HOST tables. */
export function createHostServiceProfileReadPort(
  deps: HostServiceProfileReadDeps
): HostServiceProfileReadPort {
  const now = deps.now ?? (() => Date.now());
  return {
    async select(input): Promise<Result<ServiceProfile | null, ErrorEnvelope>> {
      if (input.signal?.aborted === true) {
        return err(cancelledError());
      }
      const request = validateRequest(input, now);
      if (!request.ok) {
        return request;
      }
      const expired = becauseDeadline(request.value.deadlineAt, now);
      if (expired !== null) {
        return err(expired);
      }

      let read: ProfileRead;
      try {
        deps.connection.exec("BEGIN DEFERRED");
        try {
          read = readPersistedProfile(deps.connection, request.value);
          deps.connection.exec("COMMIT");
        } catch (error) {
          try {
            deps.connection.exec("ROLLBACK");
          } catch {
            // The original storage failure wins.
          }
          throw error;
        }
      } catch {
        return err(storageError());
      }
      if (input.signal?.aborted) {
        return err(cancelledError());
      }
      const afterRead = becauseDeadline(request.value.deadlineAt, now);
      if (afterRead !== null) {
        return err(afterRead);
      }
      if (read.kind === "absent") {
        return ok(null);
      }
      if (read.kind === "invalid") {
        return err(read.error);
      }

      const { evidenceRef, expectedEvidenceHash, details } = read.value;
      let resolved;
      try {
        resolved = await deps.source_refs.resolve(evidenceRef, { maxBytes: 4_194_304 });
      } catch {
        return err(storageError());
      }
      if (input.signal?.aborted) {
        return err(cancelledError());
      }
      const afterResolve = becauseDeadline(request.value.deadlineAt, now);
      if (afterResolve !== null) {
        return err(afterResolve);
      }
      if (!resolved.ok) {
        return err(
          resolved.error.code === "E_STORAGE_IO" || resolved.error.code === "E_IO"
            ? storageError()
            : evidenceUnavailable(evidenceRef, "missing")
        );
      }
      if (!resolved.value.retrievable || resolved.value.bytes === null) {
        return err(evidenceUnavailable(evidenceRef, resolved.value.reason ?? "missing"));
      }
      if (
        resolved.value.range_content_hash !== null &&
        resolved.value.range_content_hash !== hashBytes(resolved.value.bytes)
      ) {
        return err(evidenceUnavailable(evidenceRef, "hash_mismatch"));
      }
      const decoded = decodeStrictEvidence(resolved.value.bytes);
      if (!decoded.ok) {
        return decoded;
      }
      const { evidence, profileKey, evidenceHash } = decoded.value;
      if (expectedEvidenceHash !== evidenceHash) {
        return err(conflictError("assertion.expected", "evidence_hash", evidenceRef));
      }
      if (
        resolved.value.range_content_hash !== null &&
        resolved.value.range_content_hash !== evidenceHash
      ) {
        return err(conflictError("evidence", "content_hash", evidenceRef));
      }
      if (
        evidence.backend_id !== request.value.backendId ||
        evidence.host_id !== request.value.binding.host_id ||
        evidence.mode !== request.value.binding.mode ||
        evidence.config_space !== request.value.binding.config_space
      ) {
        return err(conflictError("evidence", "binding", evidenceRef));
      }
      const detailsError = validateDetails(details, evidence, profileKey, evidenceRef);
      if (detailsError !== null) {
        return err(detailsError);
      }
      return ok(freeze(evidence, profileKey, evidenceRef));
    }
  };
}

/* ------------------------------------------------------------------ */
/* HOST generation port wrapper                                        */
/* ------------------------------------------------------------------ */

export interface HostGenerationPortDeps {
  readonly adapter: HostGenerationAdapterPort;
  readonly profiles: HostServiceProfileReadPort;
  /**
   * Frozen `host_contract` coordinates. `null` means the composition root has
   * no installed host contract, so backend selection cannot be completed.
   */
  readonly host_contract: () => CapabilityBinding | null;
  /**
   * Clock used to convert the REV absolute `deadline_ms`
   * (`now + wall_ms`, DD-REV-040) into the relative 1..600000 ms window
   * required by `HostServiceProfileReadPort.select`.
   */
  readonly now?: () => number;
}

function blockedSelection(
  reason: "capability_unknown" | "capability_failed" | "no_approved_backend" | "isolation_unsupported",
  evidenceRefs: readonly string[] = []
): { state: "blocked_no_backend"; reason: typeof reason; missing: []; evidence_refs: string[] } {
  return { state: "blocked_no_backend", reason, missing: [], evidence_refs: [...evidenceRefs] };
}

const ISOLATION_RANK = { none: 0, process: 1, container: 2, sandbox: 3 } as const;
const NETWORK_RANK = { disabled: 0, restricted: 1, enabled: 2 } as const;

/** The selected backend must be at least as isolated/restricted as requested. */
function satisfiesRequirements(
  backend: { isolation: { mode: string; network: string } },
  requiredIsolation: keyof typeof ISOLATION_RANK,
  requiredNetwork: keyof typeof NETWORK_RANK
): boolean {
  const mode = backend.isolation.mode;
  const network = backend.isolation.network;
  const modeRank = mode in ISOLATION_RANK ? ISOLATION_RANK[mode as keyof typeof ISOLATION_RANK] : -1;
  const networkRank =
    network in NETWORK_RANK ? NETWORK_RANK[network as keyof typeof NETWORK_RANK] : -1;
  return modeRank >= ISOLATION_RANK[requiredIsolation] &&
    networkRank >= NETWORK_RANK[requiredNetwork];
}

/** The frozen host_contract must describe the same host event binding. */
function bindingMatchesRequest(
  base: CapabilityBinding,
  binding: { host_id: string; host_version: string; mode: string; config_space: string }
): boolean {
  return (
    binding.host_id === base.host_id &&
    binding.host_version === base.source_pin.host_version &&
    binding.mode === base.mode &&
    binding.config_space === base.config_space
  );
}

/** Core calls its evidence pointer `detail_ref`; Review calls it `details_ref`. */
function reviewAdapterError(error: CoreHostAdapterError) {
  return {
    code: error.code,
    retryable: error.retryable,
    details_ref: error.detail_ref
  };
}

async function forwardAdapterResult<T>(call: Promise<HostAdapterResult<T>>) {
  const result = await call;
  return result.ok ? result : { ok: false as const, error: reviewAdapterError(result.error) };
}

/**
 * Composes the adapter selection with the frozen-profile read.
 *
 * `completeGenerationBackendSelection` maps every profile error to
 * `capability_unknown`; the DD mapping distinguishes verified evidence
 * mismatches (`E_CONFLICT`) as `capability_failed` with the evidence ref. The
 * captured error preserves that mapping without a second profile read.
 *
 * The return type is the Review `HostGenerationPort` contract. The frozen
 * profile read narrows `limits.source` to `verified_profile`; the runtime
 * guard below rejects any other source instead of letting a malformed core
 * value cross the boundary.
 */
export function createHostGenerationPort(deps: HostGenerationPortDeps): ReviewHostGenerationPort {
  const now = deps.now ?? (() => Date.now());
  return {
    async selectBackend(req, signal) {
      if (signal.aborted) {
        return hostErr({ code: "E_CANCELLED", retryable: false });
      }
      const base = deps.host_contract();
      if (base === null) {
        return hostOk(blockedSelection("capability_unknown"));
      }
      if (!bindingMatchesRequest(base, req.host_binding)) {
        return hostErr({ code: "E_CONFLICT", retryable: false });
      }
      const remaining = req.deadline_ms - now();
      if (!Number.isSafeInteger(req.deadline_ms) || remaining < 1) {
        return hostErr({ code: "E_DEADLINE_EXCEEDED", retryable: true });
      }
      const selected = await deps.adapter.selectBackend(req, signal);
      if (!selected.ok) {
        return { ok: false as const, error: reviewAdapterError(selected.error) };
      }
      // The adapter may be slow: re-check the absolute deadline and abort
      // before any profile read, so the read never gets a stale window.
      if (signal.aborted) {
        return hostErr({ code: "E_CANCELLED", retryable: false });
      }
      const remainingAfterAdapter = req.deadline_ms - now();
      if (remainingAfterAdapter < 1) {
        return hostErr({ code: "E_DEADLINE_EXCEEDED", retryable: true });
      }
      if (selected.value.state === "available") {
        if (
          selected.value.backend === undefined ||
          !req.approved_backend_ids.includes(selected.value.backend.backend_id)
        ) {
          return hostOk(blockedSelection("no_approved_backend"));
        }
        if (
          !satisfiesRequirements(
            selected.value.backend,
            req.required_isolation,
            req.required_network
          )
        ) {
          return hostOk(blockedSelection("isolation_unsupported"));
        }
      }
      const captured: { error: ErrorEnvelope | null } = { error: null };
      const profiles: HostServiceProfileReadPort = {
        async select(input) {
          const result = await deps.profiles.select(input);
          if (!result.ok) {
            captured.error = result.error;
          }
          return result;
        }
      };
      const completed = await completeGenerationBackendSelection({
        selection: selected.value,
        binding: base,
        request_id: req.job_id,
        // DD-REV-040 sends an absolute deadline; the HOST read port takes a
        // relative window capped at its documented maximum.
        deadline_ms: Math.min(remainingAfterAdapter, MAX_DEADLINE_MS),
        profiles,
        signal
      });
      if (!completed.ok) {
        const code = completed.error.code;
        const mapped =
          code === "E_DEADLINE_EXCEEDED" ||
          code === "E_CANCELLED" ||
          code === "E_CONFLICT" ||
          code === "E_SCHEMA" ||
          code === "E_IO" ||
          code === "E_EVIDENCE_UNKNOWN" ||
          code === "E_CAPABILITY" ||
          code === "E_UNSUPPORTED" ||
          code === "E_HOST_REJECTED" ||
          code === "E_AUTH_UNAVAILABLE"
            ? code
            : "E_INTERNAL";
        return hostErr({
          code: mapped,
          retryable: completed.error.retryable,
          ...(completed.error.detail_ref === undefined
            ? {}
            : { details_ref: completed.error.detail_ref })
        });
      }
      const error = captured.error;
      if (
        completed.value.state === "blocked_no_backend" &&
        error !== null &&
        error.code === "E_CONFLICT"
      ) {
        const refs = error.detail_ref === undefined ? [] : [error.detail_ref];
        return hostOk(blockedSelection("capability_failed", refs));
      }
      if (
        completed.value.state === "available" &&
        completed.value.service_profile.limits.source !== "verified_profile"
      ) {
        return hostOk(blockedSelection("capability_unknown"));
      }
      // The runtime guard above proves the only core/review difference: the
      // Review `ServiceProfileLimits` narrows `source` to verified_profile.
      return hostOk(completed.value as ReviewGenerationBackendSelection);
    },
    // The Review request carries the same host-facing fields; the core type
    // additionally names the capability binding. The selected backend came
    // from that core descriptor, so the cast does not invent coordinates.
    create: (req, signal) =>
      forwardAdapterResult(
        deps.adapter.create(
          req as Parameters<HostGenerationAdapterPort["create"]>[0],
          signal
        )
      ),
    authenticate: (req, signal) => forwardAdapterResult(deps.adapter.authenticate(req, signal)),
    cancel: (req, signal) => forwardAdapterResult(deps.adapter.cancel(req, signal)),
    recover: (req, signal) => forwardAdapterResult(deps.adapter.recover(req, signal)),
    readOutput: (req, signal) => forwardAdapterResult(deps.adapter.readOutput(req, signal))
  };
}
