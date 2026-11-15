/**
 * HOST human OriginProof issuer (DD-CAP-009).
 *
 * This is the write side of `OriginProofPort.verifyHuman`. It produces the
 * per-event `confirm_human_event` probe and the `host_human_confirmation`
 * ledger row that the proof port later validates:
 *
 *   1. authenticate the caller against a ready `host_runtime_session` and
 *      require an exact, already verified `human_interaction_attested`
 *      capability binding (capability probe and event probe are distinct);
 *   2. write an `unknown` event probe batch, then a `pending` ledger batch;
 *   3. call the adapter's native confirmation with a CSPRNG challenge;
 *   4. resolve and validate `rsi.human_proof_evidence/1` outside any write
 *      transaction;
 *   5. close the probe (`passed`) and ledger (`confirmed`) in one global
 *      `appendStateRows` batch, then read both rows back before returning
 *      `verified`.
 *
 * Every failure path leaves the ledger `failed` or `expired` and the probe
 * `unknown`; no failure path writes an attestation. Rows are only ever written
 * through the FND StateRow seam, never with direct SQL.
 */

import { randomBytes } from "node:crypto";

import type {
  ErrorEnvelope,
  ErrorSideEffect,
  Hash,
  Id,
  Result,
  SourceRef,
  SourceRefPort
} from "@evoplug/core";
import {
  canonicalJsonText,
  err,
  hashBytes,
  isHash,
  isId,
  isSourceRef,
  makeErrorEnvelope,
  newId,
  ok,
  toJsonValue
} from "@evoplug/core";
import type {
  CapabilityBinding,
  HostAdapter,
  HostAdapterResult,
  HostEventBinding,
  HostHumanConfirmationRequest,
  HostHumanConfirmationResult,
  HostHumanConfirmationView,
  HostProbeRecord,
  HostStateRowAppendPort,
  HumanProofEvidence
} from "@evoplug/core/host";
import {
  capabilityBindingKey,
  parseHumanProofEvidence,
  toHostHumanConfirmationPhysicalRow,
  toHostProbePhysicalRow,
  validateCapabilityBinding,
  validateHostProbeRecord
} from "@evoplug/core/host";
import type { SqliteConnection } from "@evoplug/storage";

const CAPABILITY_NAME = "human_interaction_attested" as const;
const PROBE_ACTION = "confirm_human_event" as const;
const PROBE_CONTRACT_VERSION = "host-probe/2" as const;
const EVIDENCE_SCHEMA = "rsi.human_proof_evidence/1" as const;
const PROOF_KIND = "host_native_confirmation" as const;
const DEFAULT_MAX_EVIDENCE_BYTES = 4_194_304;
const MAX_DEADLINE_MS = 600_000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ATTESTATION_AGE_MS = 600_000;

/** One authenticated runtime session, reduced to the fields needed here. */
export interface HumanAttestationSession {
  readonly session_id: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly host_version: string;
  readonly adapter_version: string;
  readonly registration_hash: Hash;
  readonly native_session_id: string | null;
  readonly state: "ready" | "revoked" | "closed" | "failed";
  readonly lease_expires_at: number;
}

/** Native confirmation surface. The composition supplies the adapter method. */
export interface HumanConfirmationPort {
  confirm(
    input: HostHumanConfirmationRequest,
    signal?: AbortSignal
  ): Promise<HostAdapterResult<HostHumanConfirmationResult>>;
}

/**
 * Adapts a real `HostAdapter.confirmHuman` method to the issuer port. Returns
 * `null` when the adapter cannot confirm a human event, so the composition can
 * fail closed instead of inventing a confirmation surface.
 */
export function hostAdapterConfirmationPort(
  adapter: Pick<HostAdapter, "confirmHuman">
): HumanConfirmationPort | null {
  const confirmHuman = adapter.confirmHuman;
  if (confirmHuman === undefined) return null;
  return {
    confirm: (input, signal) =>
      confirmHuman.call(adapter, input, signal ?? new AbortController().signal)
  };
}

export interface HumanAttestationIssuerDeps {
  readonly connection: SqliteConnection;
  readonly state_rows: HostStateRowAppendPort;
  readonly source_refs: Pick<SourceRefPort, "resolve">;
  readonly now?: () => number;
  readonly max_evidence_bytes?: number;
  readonly allocate_probe_id?: () => Id<"prb">;
  readonly allocate_confirmation_id?: () => string;
  readonly challenge_nonce?: () => string;
  /** Test/composition seam; defaults to a read of `host_runtime_session`. */
  readonly read_runtime_session?: (session_id: string) => HumanAttestationSession | null;
}

export interface IssueHumanAttestationInput {
  readonly request_id: string;
  /** Session authenticated by `host.runtime.ready`; never inferred from input. */
  readonly runtime_session_id: Id<"rts">;
  readonly binding: CapabilityBinding;
  readonly host_binding: HostEventBinding;
  readonly event_identity_key: Hash;
  readonly native_session_id: string;
  readonly deadline_ms: number;
  /** Exact capability row; omitted means lookup by binding and capability name. */
  readonly capability_id?: Id<"cap">;
  readonly confirm: HumanConfirmationPort;
}

export type HumanAttestationStatus = "verified" | "unverified" | "conflict";

export interface HumanAttestationIssue {
  readonly status: HumanAttestationStatus;
  readonly request_id: string;
  readonly confirmation_id: string | null;
  readonly probe_id: Id<"prb"> | null;
  readonly binding_key: Hash | null;
  readonly event_identity_key: Hash;
  readonly challenge_nonce: string | null;
  readonly evidence_ref: SourceRef | null;
  readonly evidence_hash: Hash | null;
  readonly confirmed_at: number | null;
  /** True once a probe/ledger row was written for this event. */
  readonly wrote_rows: boolean;
  /** True when the terminal probe/ledger batch committed and was read back. */
  readonly terminal: boolean;
  readonly reason:
    | null
    | "runtime_session"
    | "capability"
    | "adapter_not_confirmed"
    | "adapter_error"
    | "deadline"
    | "evidence_unavailable"
    | "evidence_conflict";
}

export interface HumanAttestationIssuer {
  issue(
    input: IssueHumanAttestationInput
  ): Promise<Result<HumanAttestationIssue, ErrorEnvelope>>;
}

interface CapabilityRow {
  readonly capability_id: string;
  readonly binding_key: string;
  readonly binding_json: string;
  readonly status: string;
  readonly evidence_stage: string;
  readonly probe_ref: string | null;
  readonly probe_result: string | null;
  readonly verified_at: number | null;
  readonly details_json: string;
}

interface ProbeRow {
  readonly probe_id: string;
  readonly binding_key: string;
  readonly result: string;
  readonly probe_action: string;
}

interface Details {
  readonly proof_kinds: readonly string[];
  readonly subject_kinds: readonly string[];
  readonly control_plane_purposes: readonly string[];
  readonly evidence_schema: string;
  readonly max_attestation_age_ms: number;
}

const CAPABILITY_COLUMNS = `capability_id, binding_key, binding_json, status,
  evidence_stage, probe_ref, probe_result, verified_at, details_json`;

function schemaFailure(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "human_attestation_issue",
    details: { kind: "field", path, rule }
  });
}

function storageFailure(
  operation: string,
  sideEffect: ErrorSideEffect = "none"
): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_IO",
    category: "storage",
    message_key: "error.io.failed",
    stage: "human_attestation_issue",
    side_effect: sideEffect,
    details: { kind: "field", path: operation, rule: "storage" }
  });
}

function isNonEmptyString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseBinding(text: string): CapabilityBinding | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const validated = validateCapabilityBinding(parsed);
    if (!validated.ok) return null;
    if (canonicalJsonText(toJsonValue(parsed)) !== text) return null;
    return validated.value;
  } catch {
    return null;
  }
}

function uniqueStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return new Set(value).size === value.length ? [...value] : null;
}

function parseDetails(text: string): Details | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 5 ||
    !keys.includes("proof_kinds") ||
    !keys.includes("subject_kinds") ||
    !keys.includes("control_plane_purposes") ||
    !keys.includes("evidence_schema") ||
    !keys.includes("max_attestation_age_ms")
  ) {
    return null;
  }
  const proofKinds = uniqueStrings(record["proof_kinds"]);
  const subjectKinds = uniqueStrings(record["subject_kinds"]);
  const purposes = uniqueStrings(record["control_plane_purposes"]);
  const age = record["max_attestation_age_ms"];
  if (proofKinds === null || subjectKinds === null || purposes === null) return null;
  if (record["evidence_schema"] !== EVIDENCE_SCHEMA) return null;
  if (!isSafeNonNegativeInt(age) || age < 1 || age > MAX_ATTESTATION_AGE_MS) return null;
  return {
    proof_kinds: proofKinds,
    subject_kinds: subjectKinds,
    control_plane_purposes: purposes,
    evidence_schema: EVIDENCE_SCHEMA,
    max_attestation_age_ms: age
  };
}

function readCapability(
  deps: HumanAttestationIssuerDeps,
  input: IssueHumanAttestationInput,
  bindingKey: Hash
): CapabilityRow | null {
  const row =
    input.capability_id === undefined
      ? deps.connection
          .prepare<Record<string, unknown>>(
            `SELECT ${CAPABILITY_COLUMNS} FROM capability_record
              WHERE binding_key = :binding_key AND name = :name LIMIT 1`
          )
          .get({ binding_key: bindingKey, name: CAPABILITY_NAME })
      : deps.connection
          .prepare<Record<string, unknown>>(
            `SELECT ${CAPABILITY_COLUMNS} FROM capability_record
              WHERE capability_id = :capability_id LIMIT 1`
          )
          .get({ capability_id: input.capability_id });
  if (row === undefined) return null;
  const capabilityId = row["capability_id"];
  const rowBindingKey = row["binding_key"];
  const bindingJson = row["binding_json"];
  const status = row["status"];
  const stage = row["evidence_stage"];
  const detailsJson = row["details_json"];
  const verifiedAt = row["verified_at"];
  if (
    typeof capabilityId !== "string" ||
    typeof rowBindingKey !== "string" ||
    rowBindingKey !== bindingKey ||
    typeof bindingJson !== "string" ||
    typeof status !== "string" ||
    typeof stage !== "string" ||
    typeof detailsJson !== "string" ||
    !(verifiedAt === null || isSafeNonNegativeInt(verifiedAt))
  ) {
    return null;
  }
  if (status !== "verified" || stage !== "roundtrip") return null;
  return {
    capability_id: capabilityId,
    binding_key: rowBindingKey,
    binding_json: bindingJson,
    status,
    evidence_stage: stage,
    probe_ref: typeof row["probe_ref"] === "string" ? row["probe_ref"] : null,
    probe_result: typeof row["probe_result"] === "string" ? row["probe_result"] : null,
    verified_at: verifiedAt,
    details_json: detailsJson
  };
}

function readProbe(deps: HumanAttestationIssuerDeps, probeId: string): ProbeRow | null {
  const row = deps.connection
    .prepare<Record<string, unknown>>(
      `SELECT probe_id, binding_key, result, probe_action
         FROM host_probe WHERE probe_id = :probe_id LIMIT 1`
    )
    .get({ probe_id: probeId });
  if (row === undefined) return null;
  const probeIdValue = row["probe_id"];
  const bindingKey = row["binding_key"];
  const result = row["result"];
  const action = row["probe_action"];
  if (
    typeof probeIdValue !== "string" ||
    typeof bindingKey !== "string" ||
    typeof result !== "string" ||
    typeof action !== "string"
  ) {
    return null;
  }
  return { probe_id: probeIdValue, binding_key: bindingKey, result, probe_action: action };
}

function defaultSessionReader(
  connection: SqliteConnection
): (sessionId: string) => HumanAttestationSession | null {
  return (sessionId: string): HumanAttestationSession | null => {
    const row = connection
      .prepare<Record<string, unknown>>(
        `SELECT session_id, host_id, mode, config_space, host_version,
                adapter_version, registration_hash, native_session_id, state,
                lease_expires_at
           FROM host_runtime_session WHERE session_id = :session_id LIMIT 1`
      )
      .get({ session_id: sessionId });
    if (row === undefined) return null;
    const sessionIdValue = row["session_id"];
    const hostId = row["host_id"];
    const mode = row["mode"];
    const configSpace = row["config_space"];
    const hostVersion = row["host_version"];
    const adapterVersion = row["adapter_version"];
    const registrationHash = row["registration_hash"];
    const nativeSessionId = row["native_session_id"];
    const state = row["state"];
    const lease = row["lease_expires_at"];
    if (
      typeof sessionIdValue !== "string" ||
      typeof hostId !== "string" ||
      typeof mode !== "string" ||
      typeof configSpace !== "string" ||
      typeof hostVersion !== "string" ||
      typeof adapterVersion !== "string" ||
      typeof registrationHash !== "string" ||
      !(nativeSessionId === null || typeof nativeSessionId === "string") ||
      typeof state !== "string" ||
      !isSafeNonNegativeInt(lease)
    ) {
      return null;
    }
    if (
      state !== "ready" &&
      state !== "revoked" &&
      state !== "closed" &&
      state !== "failed"
    ) {
      return null;
    }
    return {
      session_id: sessionIdValue,
      host_id: hostId,
      mode,
      config_space: configSpace,
      host_version: hostVersion,
      adapter_version: adapterVersion,
      registration_hash: registrationHash as Hash,
      native_session_id: nativeSessionId,
      state,
      lease_expires_at: lease
    };
  };
}

function sessionMatches(
  session: HumanAttestationSession,
  input: IssueHumanAttestationInput,
  binding: CapabilityBinding,
  now: number
): boolean {
  return (
    session.state === "ready" &&
    session.lease_expires_at >= now &&
    session.host_id === binding.host_id &&
    session.mode === binding.mode &&
    session.config_space === binding.config_space &&
    session.host_version === binding.source_pin.host_version &&
    session.adapter_version === binding.adapter_version &&
    session.native_session_id === input.native_session_id
  );
}

function hostBindingMatches(
  hostBinding: HostEventBinding,
  input: IssueHumanAttestationInput,
  binding: CapabilityBinding
): boolean {
  return (
    hostBinding.host_id === binding.host_id &&
    hostBinding.mode === binding.mode &&
    hostBinding.config_space === binding.config_space &&
    hostBinding.host_version === binding.source_pin.host_version &&
    hostBinding.adapter_version === binding.adapter_version &&
    hostBinding.event_identity_key === input.event_identity_key &&
    hostBinding.native_session_id === input.native_session_id
  );
}

function parseEvidenceBytes(
  bytes: Uint8Array
): { text: string; raw: Record<string, unknown> } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (canonicalJsonText(toJsonValue(parsed)) !== text) return null;
  return { text, raw: parsed as Record<string, unknown> };
}

const EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "capability_id",
  "proof_kind",
  "host_id",
  "host_version",
  "mode",
  "config_space",
  "subject",
  "confirmed_at",
  "nonce"
]);

const EVIDENCE_SUBJECT_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "event_key",
  "native_session_id"
]);

function closedEvidenceShape(raw: Record<string, unknown>): boolean {
  if (!Object.keys(raw).every((key) => EVIDENCE_KEYS.has(key))) return false;
  const subject = raw["subject"];
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
    return false;
  }
  return Object.keys(subject).every((key) => EVIDENCE_SUBJECT_KEYS.has(key));
}

function evidenceMatches(input: {
  evidence: HumanProofEvidence;
  capabilityId: string;
  binding: CapabilityBinding;
  request: IssueHumanAttestationInput;
  challengeNonce: string;
  confirmedAt: number;
}): boolean {
  const { evidence, binding, request } = input;
  if (evidence.proof_kind !== PROOF_KIND) return false;
  if (evidence.capability_id !== input.capabilityId) return false;
  if (evidence.host_id !== binding.host_id) return false;
  if (evidence.host_version !== binding.source_pin.host_version) return false;
  if (evidence.mode !== binding.mode) return false;
  if (evidence.config_space !== binding.config_space) return false;
  if (evidence.subject.kind !== "event_key") return false;
  if (evidence.subject.event_key !== request.event_identity_key) return false;
  if (evidence.subject.native_session_id !== request.native_session_id) return false;
  if (evidence.nonce !== input.challengeNonce) return false;
  if (evidence.confirmed_at !== input.confirmedAt) return false;
  return true;
}

async function resolveEvidence(input: {
  deps: HumanAttestationIssuerDeps;
  ref: SourceRef;
  maxBytes: number;
}): Promise<
  | { state: "ok"; evidence: HumanProofEvidence; hash: Hash }
  | { state: "unavailable" }
  | { state: "conflict" }
> {
  let resolved: Awaited<ReturnType<SourceRefPort["resolve"]>>;
  try {
    resolved = await input.deps.source_refs.resolve(input.ref, {
      maxBytes: input.maxBytes
    });
  } catch {
    return { state: "unavailable" };
  }
  if (
    !resolved.ok ||
    !resolved.value.retrievable ||
    resolved.value.bytes === null
  ) {
    return { state: "unavailable" };
  }
  const bytes = resolved.value.bytes;
  const digest = hashBytes(bytes);
  if (
    (resolved.value.contentVersion !== null &&
      resolved.value.contentVersion !== digest) ||
    (resolved.value.range_content_hash !== null &&
      resolved.value.range_content_hash !== digest)
  ) {
    return { state: "conflict" };
  }
  const parsed = parseEvidenceBytes(bytes);
  if (parsed === null || !closedEvidenceShape(parsed.raw)) {
    return { state: "conflict" };
  }
  const evidence = parseHumanProofEvidence(parsed.raw);
  if (evidence === null) return { state: "conflict" };
  return { state: "ok", evidence, hash: digest };
}

function terminalProbe(input: {
  probeId: Id<"prb">;
  binding: CapabilityBinding;
  bindingKey: Hash;
  eventKey: Hash;
  evidenceRef: SourceRef;
  evidenceText: string;
  startedAt: number;
  checkedAt: number;
}): HostProbeRecord | null {
  const record: HostProbeRecord = {
    schema_version: "rsi.host_probe/2",
    probe_id: input.probeId,
    probe_contract_version: PROBE_CONTRACT_VERSION,
    target_kind: "host",
    binding: input.binding,
    binding_key: input.bindingKey,
    probe_mode: "read_only",
    probe_action: PROBE_ACTION,
    assertions: [
      {
        assertion_id: `${CAPABILITY_NAME}:${PROBE_ACTION}`,
        capability: CAPABILITY_NAME,
        expected: input.eventKey,
        observed_ref: input.evidenceRef,
        pass: true
      }
    ],
    capability_results: [],
    result: "passed",
    expected: input.eventKey,
    observed: input.evidenceText,
    evidence_refs: [input.evidenceRef],
    duration_ms: Math.max(0, input.checkedAt - input.startedAt),
    checked_at: input.checkedAt
  };
  const validated = validateHostProbeRecord(record);
  return validated.ok ? validated.value : null;
}

function pendingView(input: {
  confirmationId: string;
  binding: CapabilityBinding;
  bindingKey: Hash;
  hostBinding: HostEventBinding;
  eventKey: Hash;
  nonce: string;
  probeId: Id<"prb">;
  now: number;
}): HostHumanConfirmationView {
  return {
    confirmation_id: input.confirmationId,
    binding: input.binding,
    binding_key: input.bindingKey,
    host_binding: input.hostBinding,
    event_identity_key: input.eventKey,
    challenge_nonce: input.nonce,
    probe_id: input.probeId,
    state: "pending",
    evidence_ref: null,
    created_at: input.now,
    confirmed_at: null,
    updated_at: input.now,
    row_version: 1
  };
}

function confirmedView(
  pending: HostHumanConfirmationView,
  evidenceRef: SourceRef,
  confirmedAt: number,
  updatedAt: number
): HostHumanConfirmationView {
  return {
    ...pending,
    state: "confirmed",
    evidence_ref: evidenceRef,
    confirmed_at: confirmedAt,
    updated_at: updatedAt,
    row_version: pending.row_version + 1
  };
}

function failedView(
  pending: HostHumanConfirmationView,
  state: "failed" | "expired",
  updatedAt: number
): HostHumanConfirmationView {
  return {
    ...pending,
    state,
    evidence_ref: null,
    confirmed_at: null,
    updated_at: updatedAt,
    row_version: pending.row_version + 1
  };
}

export function createHumanAttestationIssuer(
  deps: HumanAttestationIssuerDeps
): HumanAttestationIssuer {
  const now = deps.now ?? ((): number => Date.now());
  const maxEvidenceBytes = deps.max_evidence_bytes ?? DEFAULT_MAX_EVIDENCE_BYTES;
  const allocateProbeId = deps.allocate_probe_id ?? ((): Id<"prb"> => newId("prb", now()));
  const allocateConfirmationId =
    deps.allocate_confirmation_id ??
    ((): string => `cfm:${randomBytes(16).toString("hex")}`);
  const challengeNonce =
    deps.challenge_nonce ?? ((): string => randomBytes(16).toString("base64url"));
  const readSession = deps.read_runtime_session ?? defaultSessionReader(deps.connection);

  async function append(
    rows: Parameters<HostStateRowAppendPort["appendStateRows"]>[0]["rows"]
  ): Promise<Result<void, ErrorEnvelope>> {
    const outcome = await deps.state_rows.appendStateRows({
      binding: null,
      rows,
      documents: [],
      heads: []
    });
    if (!outcome.ok) {
      return err(
        storageFailure(
          "state_row_append",
          outcome.commit_state === "not_written" ? "none" : "unknown"
        )
      );
    }
    return ok(undefined);
  }

  return {
    async issue(
      input: IssueHumanAttestationInput
    ): Promise<Result<HumanAttestationIssue, ErrorEnvelope>> {
      const startedAt = now();

      if (
        !isNonEmptyString(input.request_id, MAX_REQUEST_ID_LENGTH) ||
        !isId(input.runtime_session_id, "rts") ||
        !isNonEmptyString(input.native_session_id, 256) ||
        !isHash(input.event_identity_key) ||
        !Number.isSafeInteger(input.deadline_ms) ||
        input.deadline_ms < 1 ||
        input.deadline_ms > MAX_DEADLINE_MS ||
        input.confirm === null ||
        typeof input.confirm.confirm !== "function"
      ) {
        return err(schemaFailure("$", "issue_request"));
      }
      const bindingResult = validateCapabilityBinding(input.binding, {
        capabilityName: CAPABILITY_NAME
      });
      if (!bindingResult.ok) return bindingResult;
      const binding = bindingResult.value;
      if (binding.subject !== "host_contract" && binding.subject !== "product_adapter") {
        return err(schemaFailure("binding.subject", "host_contract_or_product_adapter"));
      }
      if (
        input.host_binding === null ||
        typeof input.host_binding !== "object" ||
        !isHash(input.host_binding.event_identity_key) ||
        !isNonEmptyString(input.host_binding.host_event, 128)
      ) {
        return err(schemaFailure("host_binding", "event_binding"));
      }
      const bindingKey = capabilityBindingKey(binding);
      const deadlineAt = startedAt + input.deadline_ms;

      const base = {
        request_id: input.request_id,
        event_identity_key: input.event_identity_key
      };

      // --- preconditions: nothing is written when these fail. ------------
      const session = readSession(input.runtime_session_id);
      if (
        session === null ||
        session.session_id !== input.runtime_session_id ||
        !sessionMatches(session, input, binding, startedAt) ||
        !hostBindingMatches(input.host_binding, input, binding)
      ) {
        return ok({
          ...base,
          status: "unverified",
          confirmation_id: null,
          probe_id: null,
          binding_key: bindingKey,
          challenge_nonce: null,
          evidence_ref: null,
          evidence_hash: null,
          confirmed_at: null,
          wrote_rows: false,
          terminal: false,
          reason: "runtime_session"
        });
      }

      const capability = readCapability(deps, input, bindingKey);
      if (capability === null) {
        return ok({
          ...base,
          status: "unverified",
          confirmation_id: null,
          probe_id: null,
          binding_key: bindingKey,
          challenge_nonce: null,
          evidence_ref: null,
          evidence_hash: null,
          confirmed_at: null,
          wrote_rows: false,
          terminal: false,
          reason: "capability"
        });
      }
      const capabilityProbe =
        capability.probe_ref === null ? null : readProbe(deps, capability.probe_ref);
      const details = parseDetails(capability.details_json);
      if (
        capability.probe_result !== "passed" ||
        capability.probe_ref === null ||
        capabilityProbe === null ||
        capabilityProbe.binding_key !== bindingKey ||
        capabilityProbe.result !== "passed" ||
        capabilityProbe.probe_action === PROBE_ACTION ||
        details === null ||
        !details.proof_kinds.includes(PROOF_KIND) ||
        !details.subject_kinds.includes("event_key")
      ) {
        return ok({
          ...base,
          status: "unverified",
          confirmation_id: null,
          probe_id: null,
          binding_key: bindingKey,
          challenge_nonce: null,
          evidence_ref: null,
          evidence_hash: null,
          confirmed_at: null,
          wrote_rows: false,
          terminal: false,
          reason: "capability"
        });
      }

      // --- phase 1: unknown event probe, then pending ledger -------------
      const probeId = allocateProbeId();
      const confirmationId = allocateConfirmationId();
      const nonce = challengeNonce();
      if (
        !isNonEmptyString(confirmationId, 128) ||
        !isNonEmptyString(nonce, 128)
      ) {
        return err(schemaFailure("challenge", "csprng_ids"));
      }

      const unknownProbe: HostProbeRecord = {
        schema_version: "rsi.host_probe/2",
        probe_id: probeId,
        probe_contract_version: PROBE_CONTRACT_VERSION,
        target_kind: "host",
        binding,
        binding_key: bindingKey,
        probe_mode: "read_only",
        probe_action: PROBE_ACTION,
        assertions: [],
        capability_results: [],
        result: "unknown",
        expected: input.event_identity_key,
        observed: "awaiting native host confirmation",
        evidence_refs: [],
        duration_ms: 0,
        checked_at: startedAt
      };
      const validatedUnknown = validateHostProbeRecord(unknownProbe);
      if (!validatedUnknown.ok) return validatedUnknown;

      const probeWrite = await append([
        {
          row_schema: "rsi.host_probe_row/1",
          operation: "insert",
          row: toHostProbePhysicalRow(validatedUnknown.value, 1),
          document_id: null
        }
      ]);
      if (!probeWrite.ok) return probeWrite;

      const pending = pendingView({
        confirmationId,
        binding,
        bindingKey,
        hostBinding: input.host_binding,
        eventKey: input.event_identity_key,
        nonce,
        probeId,
        now: startedAt
      });
      const ledgerWrite = await append([
        {
          row_schema: "rsi.host_human_confirmation_row/1",
          operation: "insert",
          row: toHostHumanConfirmationPhysicalRow(pending, 1),
          document_id: null
        }
      ]);
      if (!ledgerWrite.ok) return ledgerWrite;

      const closeWithoutEvidence = async (
        status: HumanAttestationStatus,
        reason: HumanAttestationIssue["reason"],
        state: "failed" | "expired" = "failed"
      ): Promise<Result<HumanAttestationIssue, ErrorEnvelope>> => {
        const closed = await append([
          {
            row_schema: "rsi.host_human_confirmation_row/1",
            operation: "transition",
            row: toHostHumanConfirmationPhysicalRow(
              failedView(pending, state, now()),
              2
            ),
            document_id: null
          }
        ]);
        if (!closed.ok) return closed;
        return ok({
          ...base,
          status,
          confirmation_id: confirmationId,
          probe_id: probeId,
          binding_key: bindingKey,
          challenge_nonce: nonce,
          evidence_ref: null,
          evidence_hash: null,
          confirmed_at: null,
          wrote_rows: true,
          terminal: true,
          reason
        });
      };

      if (now() > deadlineAt) {
        return closeWithoutEvidence("unverified", "deadline", "expired");
      }

      let result: HostAdapterResult<HostHumanConfirmationResult> | null = null;
      try {
        const remaining = Math.max(1, deadlineAt - now());
        result = await input.confirm.confirm(
          {
            schema_version: "rsi.host_human_confirmation_request/1",
            request_id: input.request_id,
            confirmation_id: confirmationId,
            probe_id: probeId,
            binding,
            host_binding: input.host_binding,
            event_identity_key: input.event_identity_key,
            challenge_nonce: nonce,
            native_session_id: input.native_session_id,
            deadline_ms: remaining
          },
          AbortSignal.timeout(remaining)
        );
      } catch {
        result = null;
      }

      if (now() > deadlineAt) {
        return closeWithoutEvidence("unverified", "deadline", "expired");
      }
      if (result === null || !result.ok) {
        return closeWithoutEvidence("unverified", "adapter_error");
      }
      const outcome = result.value;
      if (
        outcome === null ||
        typeof outcome !== "object" ||
        (outcome.state !== "confirmed" &&
          outcome.state !== "not_confirmed" &&
          outcome.state !== "unsupported" &&
          outcome.state !== "unknown")
      ) {
        return closeWithoutEvidence("unverified", "adapter_error");
      }
      if (outcome.state !== "confirmed") {
        return closeWithoutEvidence("unverified", "adapter_not_confirmed");
      }
      const evidenceRef = outcome.evidence_ref;
      const confirmedAt = outcome.confirmed_at;
      if (
        evidenceRef === undefined ||
        !isSourceRef(evidenceRef) ||
        !isSafeNonNegativeInt(confirmedAt)
      ) {
        return closeWithoutEvidence("unverified", "adapter_error");
      }
      const age = now() - confirmedAt;
      if (age < 0 || age > details.max_attestation_age_ms) {
        return closeWithoutEvidence("unverified", "evidence_conflict");
      }

      const resolvedEvidence = await resolveEvidence({
        deps,
        ref: evidenceRef,
        maxBytes: maxEvidenceBytes
      });
      if (resolvedEvidence.state === "unavailable") {
        return closeWithoutEvidence("unverified", "evidence_unavailable");
      }
      if (resolvedEvidence.state === "conflict") {
        return closeWithoutEvidence("conflict", "evidence_conflict");
      }
      if (
        !evidenceMatches({
          evidence: resolvedEvidence.evidence,
          capabilityId: capability.capability_id,
          binding,
          request: input,
          challengeNonce: nonce,
          confirmedAt
        })
      ) {
        return closeWithoutEvidence("conflict", "evidence_conflict");
      }

      const checkedAt = now();
      if (checkedAt > deadlineAt) {
        return closeWithoutEvidence("unverified", "deadline", "expired");
      }
      const passedProbe = terminalProbe({
        probeId,
        binding,
        bindingKey,
        eventKey: input.event_identity_key,
        evidenceRef,
        evidenceText: canonicalJsonText(toJsonValue(resolvedEvidence.evidence)),
        startedAt,
        checkedAt
      });
      if (passedProbe === null) {
        return closeWithoutEvidence("conflict", "evidence_conflict");
      }

      const terminal = await append([
        {
          row_schema: "rsi.host_probe_row/1",
          operation: "transition",
          row: toHostProbePhysicalRow(passedProbe, 2),
          document_id: null
        },
        {
          row_schema: "rsi.host_human_confirmation_row/1",
          operation: "transition",
          row: toHostHumanConfirmationPhysicalRow(
            confirmedView(pending, evidenceRef, confirmedAt, checkedAt),
            2
          ),
          document_id: null
        }
      ]);
      if (!terminal.ok) return terminal;

      // The batch must be readable back before `verified` is returned.
      const probeReadback = readProbe(deps, probeId);
      const confirmationReadback = deps.connection
        .prepare<Record<string, unknown>>(
          `SELECT state, evidence_ref, confirmed_at, probe_id
             FROM host_human_confirmation WHERE confirmation_id = :confirmation_id`
        )
        .get({ confirmation_id: confirmationId });
      if (
        probeReadback === null ||
        probeReadback.result !== "passed" ||
        probeReadback.binding_key !== bindingKey ||
        confirmationReadback === undefined ||
        confirmationReadback["state"] !== "confirmed" ||
        confirmationReadback["evidence_ref"] !== evidenceRef ||
        confirmationReadback["confirmed_at"] !== confirmedAt ||
        confirmationReadback["probe_id"] !== probeId
      ) {
        return err(storageFailure("state_row_readback", "committed"));
      }

      return ok({
        ...base,
        status: "verified",
        confirmation_id: confirmationId,
        probe_id: probeId,
        binding_key: bindingKey,
        challenge_nonce: nonce,
        evidence_ref: evidenceRef,
        evidence_hash: resolvedEvidence.hash,
        confirmed_at: confirmedAt,
        wrote_rows: true,
        terminal: true,
        reason: null
      });
    }
  };
}
