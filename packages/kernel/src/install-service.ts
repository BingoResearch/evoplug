/**
 * Adapter install approvals (DD-FND-096, DD-FND-102, DD-FND-097.9).
 *
 * FND owns `adapter_install_approval`. The four IPC handlers in this module are
 * the only writers of that table:
 *
 *   `install.approve`            active insert, one idempotency key, one TTL
 *   `install.revoke`             active -> revoked, proof gated, no refund
 *   `install.approval.get`       active and unexpired only, never evidence text
 *   `install.approval.consume`   active -> consumed, one registration hash
 *
 * Every state change writes one `install.approval_recorded` /
 * `install.approval_transition` journal frame first, fsyncs it, and only then
 * projects the row, `ledger_event_log` and `blob_ref` in one short SQLite
 * transaction. Both event types carry `binding=null`.
 *
 * Fail-closed seams: HOST supplies `AdapterInstallReadinessPort` and
 * `OriginProofPort`; without either, `install.approve` and `install.revoke`
 * answer `E_AUTH_UNAVAILABLE` before any write. The journal committer is also
 * required for every write. Attestation text, absolute paths and evidence
 * content never appear in a result or an error.
 */

import type {
  AdapterInstallApprovalView,
  AdapterInstallSubject,
  ErrorCategory,
  ErrorCode,
  ErrorDetails,
  ErrorEnvelope,
  FailureStatus,
  Hash,
  Id,
  JsonValue,
  NotPromise,
  Result,
  SourceRef,
  SourceRefPort,
  Tx
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  formatSourceRef,
  isHash,
  isHostId,
  isHostMode,
  isId,
  isSourceRef,
  makeErrorEnvelope,
  newId,
  parseSourceRef,
  toJsonValue
} from "@evoplug/core";
import type { IpcHandler, IpcResult } from "@evoplug/ipc";
import type { OriginProofPort } from "@evoplug/ledger";
import type {
  BlobStore,
  JournalAppendResult,
  JournalCommitter,
  JournalFramePayload,
  JournalWriter,
  SqlRow,
  SqliteConnection
} from "@evoplug/storage";
import { createJournalCommitter } from "@evoplug/storage";

/* ------------------------------------------------------------------ */
/* Public dependency contract                                          */
/* ------------------------------------------------------------------ */

export type ApprovalState = "active" | "consumed" | "revoked" | "expired";
export type BootstrapState =
  | "preinstall_ready"
  | "postinstall_ready"
  | "blocked_no_attested_source"
  | "unknown";
export type RevokeReason = "human_revoked" | "superseded" | "security";

/**
 * Structural copy of the HOST `AdapterInstallReadinessPort`. The core host
 * submodule is not an exported package subpath, so FND consumes the same
 * contract through this local declaration.
 */
export interface InstallReadinessView {
  readonly active_binding: "none" | "adapter" | "unknown";
  readonly host_contract:
    | {
        readonly status: "verified" | "unverified" | "unknown";
        readonly roundtrip: boolean;
        readonly probe_passed: boolean;
        readonly evidence_ref: SourceRef;
      }
    | null;
  readonly product_adapter:
    | {
        readonly active: boolean;
        readonly adapter_version: string | null;
        readonly implementation_hash: Hash | null;
        readonly evidence_ref: SourceRef;
      }
    | null;
}

export interface InstallReadinessPort {
  get(input: {
    readonly request_id: string;
    readonly subject: AdapterInstallSubject;
    readonly subject_hash: Hash;
  }): Promise<Result<InstallReadinessView, ErrorEnvelope>>;
}

/** Frozen journal resources shared with the FND committer. */
export interface InstallJournalResources {
  readonly writer: JournalWriter;
  readonly relative_path: string;
}

export interface InstallServiceDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: Pick<BlobStore, "putSync" | "verify" | "relativePath">;
  readonly now: () => number;
  /** HOST read-only readiness port. Absent fails closed before any write. */
  readonly readiness?: InstallReadinessPort;
  /** HOST control-plane proof port. Absent fails closed before any write. */
  readonly proof?: OriginProofPort;
  /** Retrievability check for readiness evidence; required for approval. */
  readonly source_refs?: Pick<SourceRefPort, "resolve">;
  /** Shared single-writer journal. Absent means no approval can be written. */
  readonly journal?: InstallJournalResources;
}

export interface InstallServiceHandlers {
  readonly "install.approve": IpcHandler<"install.approve">;
  readonly "install.revoke": IpcHandler<"install.revoke">;
  readonly "install.approval.get": IpcHandler<"install.approval.get">;
  readonly "install.approval.consume": IpcHandler<"install.approval.consume">;
}

export interface InstallService {
  readonly handlers: InstallServiceHandlers;
}

/* ------------------------------------------------------------------ */
/* Constants and errors                                                */
/* ------------------------------------------------------------------ */

const ROW_SCHEMA = "rsi.adapter_install_approval_row/1";
const ENTITY_TYPE = "adapter_install_approval";
const RECORDED_EVENT = "install.approval_recorded";
const TRANSITION_EVENT = "install.approval_transition";
const APPROVAL_SCHEMA_VERSION = "rsi.adapter_install_approval/1";
const SUBJECT_SCHEMA_VERSION = "rsi.adapter_install_subject/1";
const APPROVAL_HASH_SCHEMA_VERSION = "rsi.adapter_install_approval_hash/1";
const APPROVE_REQUEST_SCHEMA_VERSION = "rsi.adapter_install_approve_request/1";
const REVOKE_SUBJECT_SCHEMA_VERSION = "rsi.adapter_install_revoke_subject/1";
const MAX_TTL_MS = 600_000;
const MAX_JSON_BYTES = 1_048_576;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const ERROR_CATEGORY: Readonly<Record<string, ErrorCategory>> = {
  E_APPROVAL_INVALID: "schema",
  E_APPROVAL_NOT_FOUND: "not_found",
  E_APPROVAL_STATE: "conflict",
  E_APPROVAL_HASH: "conflict",
  E_APPROVAL_SUBJECT_MISMATCH: "conflict",
  E_APPROVAL_EXPIRED: "authorization",
  E_APPROVAL_CONSUMED: "authorization",
  E_APPROVAL_UNVERIFIED: "authorization",
  E_AUTH_UNAVAILABLE: "authorization",
  E_IDEMPOTENCY_CONFLICT: "conflict",
  E_REBUILD_DIVERGENCE: "internal",
  E_IO: "storage",
  E_INTERNAL: "internal"
};

const ERROR_MESSAGE_KEY: Readonly<Record<string, string>> = {
  E_APPROVAL_INVALID: "error.approval.invalid",
  E_APPROVAL_NOT_FOUND: "error.approval.not_found",
  E_APPROVAL_STATE: "error.approval.state",
  E_APPROVAL_HASH: "error.approval.hash",
  E_APPROVAL_SUBJECT_MISMATCH: "error.approval.subject_mismatch",
  E_APPROVAL_EXPIRED: "error.approval.expired",
  E_APPROVAL_CONSUMED: "error.approval.consumed",
  E_APPROVAL_UNVERIFIED: "error.approval.unverified",
  E_AUTH_UNAVAILABLE: "error.auth.unavailable",
  E_IDEMPOTENCY_CONFLICT: "error.idempotency.conflict",
  E_REBUILD_DIVERGENCE: "error.rebuild.divergence",
  E_IO: "error.io.failed",
  E_INTERNAL: "error.internal.unexpected"
};

function approvalError(
  code: ErrorCode,
  stage: string,
  details: ErrorDetails = { kind: "none" }
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: ERROR_CATEGORY[code] ?? "internal",
    message_key: ERROR_MESSAGE_KEY[code] ?? "error.internal.unexpected",
    stage,
    details,
    retryable: false,
    side_effect: "none"
  });
}

function invalidError(path: string, rule: string, stage: string): ErrorEnvelope {
  return approvalError("E_APPROVAL_INVALID", stage, { kind: "field", path, rule });
}

function divergenceError(detail: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_REBUILD_DIVERGENCE",
    category: "internal",
    message_key: "error.rebuild.divergence",
    stage: "install_rebuild",
    details: { kind: "internal", incident_id: detail },
    retryable: false,
    side_effect: "none"
  });
}

function internalError(incident: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal.unexpected",
    stage: "install_approval",
    details: { kind: "internal", incident_id: incident },
    retryable: false,
    side_effect: "none"
  });
}

function unavailableError(stage: string): ErrorEnvelope {
  return approvalError("E_AUTH_UNAVAILABLE", stage);
}

/* ------------------------------------------------------------------ */
/* Small typed helpers                                                 */
/* ------------------------------------------------------------------ */

type Row = Readonly<Record<string, unknown>>;

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

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

function oneRow(connection: SqliteConnection, sql: string, params: Record<string, string | number | null>): Row | null {
  const row: SqlRow | undefined = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row;
}

/* ------------------------------------------------------------------ */
/* Subject, hashes and attestation                                     */
/* ------------------------------------------------------------------ */

function validateSubject(value: unknown): Result<AdapterInstallSubject, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: invalidError("$", "object", "install_approve") };
  }
  if (value["schema_version"] !== SUBJECT_SCHEMA_VERSION || value["purpose"] !== "adapter_install") {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("purpose", "adapter_install", "install_approve")
    };
  }
  const hostId = value["host_id"];
  const mode = value["mode"];
  const configSpace = value["config_space"];
  const adapterId = value["adapter_id"];
  const adapterVersion = value["adapter_version"];
  const targetId = value["target_id"];
  const implementationHash = value["implementation_hash"];
  const artifactHash = value["artifact_hash"];
  const previousValue = value["expected_previous_hash"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("host_id", "host_id", "install_approve")
    };
  }
  if (typeof mode !== "string" || !isHostMode(mode)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("mode", "host_mode", "install_approve")
    };
  }
  if (!isNonEmptyString(configSpace, 128)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("config_space", "1..128", "install_approve")
    };
  }
  if (typeof adapterId !== "string" || !isId(adapterId, "adp")) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("adapter_id", "adp_id", "install_approve")
    };
  }
  if (!isNonEmptyString(adapterVersion, 64)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("adapter_version", "1..64", "install_approve")
    };
  }
  if (!isNonEmptyString(targetId, 256)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("target_id", "1..256", "install_approve")
    };
  }
  if (typeof implementationHash !== "string" || !isHash(implementationHash)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("implementation_hash", "sha256_hash", "install_approve")
    };
  }
  if (typeof artifactHash !== "string" || !isHash(artifactHash)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("artifact_hash", "sha256_hash", "install_approve")
    };
  }
  let previous: Hash | null;
  if (previousValue === null) {
    previous = null;
  } else if (typeof previousValue === "string" && isHash(previousValue)) {
    previous = previousValue;
  } else {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("expected_previous_hash", "hash_or_null", "install_approve")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      schema_version: SUBJECT_SCHEMA_VERSION,
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
    }
  };
}

function subjectJson(subject: AdapterInstallSubject): JsonValue {
  return toJsonValue({
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
  });
}

function subjectHash(subject: AdapterInstallSubject): Hash {
  return canonicalHash(subjectJson(subject));
}

function computeApprovalHash(subject: AdapterInstallSubject, subjectHashValue: Hash, issuedAt: number, expiresAt: number): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: APPROVAL_HASH_SCHEMA_VERSION,
      subject: subjectJson(subject),
      subject_hash: subjectHashValue,
      issued_at: issuedAt,
      expires_at: expiresAt
    })
  );
}

interface InstallAttestation {
  readonly kind: "host_verified_interactive_user" | "control_plane_explicit_confirmation";
  readonly capability_id: string;
  readonly evidence_ref: SourceRef;
  readonly confirmed_at: number;
}

interface ValidAttestation {
  readonly attestation: InstallAttestation;
  readonly canonical_text: string;
  readonly attestation_hash: Hash;
}

function validateAttestation(value: unknown): Result<ValidAttestation, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: invalidError("human_attestation", "object", "install_approve") };
  }
  if (value["kind"] !== "control_plane_explicit_confirmation") {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("human_attestation.kind", "control_plane_explicit_confirmation", "install_approve")
    };
  }
  const capabilityId = value["capability_id"];
  if (typeof capabilityId !== "string" || !isId(capabilityId, "cap")) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("human_attestation.capability_id", "cap_id", "install_approve")
    };
  }
  const evidenceRef = value["evidence_ref"];
  if (typeof evidenceRef !== "string" || !isSourceRef(evidenceRef)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("human_attestation.evidence_ref", "source_ref", "install_approve")
    };
  }
  const confirmedAt = value["confirmed_at"];
  if (!isSafeNonNegativeInt(confirmedAt)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("human_attestation.confirmed_at", "safe_non_negative_integer", "install_approve")
    };
  }
  const json = toJsonValue({
    kind: "control_plane_explicit_confirmation",
    capability_id: capabilityId,
    evidence_ref: evidenceRef,
    confirmed_at: confirmedAt
  });
  return {
    ok: true,
    status: "ok",
    value: {
      attestation: {
        kind: "control_plane_explicit_confirmation",
        capability_id: capabilityId,
        evidence_ref: evidenceRef,
        confirmed_at: confirmedAt
      },
      canonical_text: canonicalJsonText(json),
      attestation_hash: canonicalHash(json)
    }
  };
}

function issuanceRequestHash(
  subject: AdapterInstallSubject,
  ttlMs: number,
  attestationHashValue: Hash
): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: APPROVE_REQUEST_SCHEMA_VERSION,
      subject: subjectJson(subject),
      ttl_ms: ttlMs,
      attestation_hash: attestationHashValue
    })
  );
}

function revokeSubjectHash(subject: {
  approval_id: Id<"iap">;
  expected_approval_hash: Hash;
  reason: RevokeReason;
}): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: REVOKE_SUBJECT_SCHEMA_VERSION,
      purpose: "adapter_install",
      approval_id: subject.approval_id,
      expected_approval_hash: subject.expected_approval_hash,
      reason: subject.reason
    })
  );
}

/* ------------------------------------------------------------------ */
/* Row model                                                           */
/* ------------------------------------------------------------------ */

/**
 * The complete JSON row definition of `adapter_install_approval`
 * (DD-FND-102).
 *
 * This is the registry row of `state-row-registry.json` verbatim. The
 * generated `AdapterInstallApprovalRow` must equal it field by field; the
 * `row_json`, the `after_hash` and every snapshot read-back carry the fixed
 * `schema_version` constant.
 *
 * The `revoke_reason` set does not extend. An `expired` row has
 * `consumed_at`, `consumed_registration_hash`, `revoked_at` and
 * `revoke_reason` all null.
 */
export interface AdapterInstallApprovalRowShape {
  readonly schema_version: "rsi.adapter_install_approval_row/1";
  readonly approval_id: Id<"iap">;
  readonly idempotency_key: string;
  readonly request_hash: Hash;
  readonly subject: AdapterInstallSubject;
  readonly subject_hash: Hash;
  readonly state: "active" | "consumed" | "revoked" | "expired";
  readonly bootstrap_state: BootstrapState;
  readonly evidence_ref: SourceRef;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly consumed_at: number | null;
  readonly consumed_registration_hash: Hash | null;
  readonly revoked_at: number | null;
  readonly revoke_reason: "human_revoked" | "superseded" | "security" | null;
  readonly approval_hash: Hash;
  readonly row_version: number;
}

interface ApprovalRow {
  readonly approval_id: Id<"iap">;
  readonly idempotency_key: string;
  readonly request_hash: Hash;
  readonly subject: AdapterInstallSubject;
  readonly subject_hash: Hash;
  readonly state: ApprovalState;
  readonly bootstrap_state: BootstrapState;
  readonly evidence_ref: SourceRef;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly consumed_at: number | null;
  readonly consumed_registration_hash: Hash | null;
  readonly revoked_at: number | null;
  readonly revoke_reason: RevokeReason | null;
  readonly approval_hash: Hash;
  readonly row_version: number;
}

function approvalRowJson(row: ApprovalRow): JsonValue {
  return toJsonValue({
    schema_version: ROW_SCHEMA,
    approval_id: row.approval_id,
    idempotency_key: row.idempotency_key,
    request_hash: row.request_hash,
    subject: subjectJson(row.subject),
    subject_hash: row.subject_hash,
    state: row.state,
    bootstrap_state: row.bootstrap_state,
    evidence_ref: row.evidence_ref,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    consumed_registration_hash: row.consumed_registration_hash,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
    approval_hash: row.approval_hash,
    row_version: row.row_version
  });
}

function approvalRowHash(row: ApprovalRow): Hash {
  return canonicalHash(
    toJsonValue({
      row_schema: ROW_SCHEMA,
      row_json: canonicalJsonText(approvalRowJson(row))
    })
  );
}

function parseApprovalState(value: string): ApprovalState | null {
  switch (value) {
    case "active":
    case "consumed":
    case "revoked":
    case "expired":
      return value;
    default:
      return null;
  }
}

function parseBootstrapState(value: string): BootstrapState | null {
  switch (value) {
    case "preinstall_ready":
    case "postinstall_ready":
    case "blocked_no_attested_source":
    case "unknown":
      return value;
    default:
      return null;
  }
}

function parseRevokeReason(value: string): RevokeReason | null {
  switch (value) {
    case "human_revoked":
    case "superseded":
    case "security":
      return value;
    default:
      return null;
  }
}

function parseApprovalRow(row: Row): Result<ApprovalRow, ErrorEnvelope> {
  const approvalId = rowString(row, "approval_id");
  if (approvalId === null || !isId(approvalId, "iap")) {
    return { ok: false, status: "rejected", error: divergenceError("approval_id") };
  }
  const idempotencyKey = rowString(row, "idempotency_key");
  if (idempotencyKey === null) {
    return { ok: false, status: "rejected", error: divergenceError("idempotency_key") };
  }
  const requestHash = rowString(row, "request_hash");
  if (requestHash === null || !isHash(requestHash)) {
    return { ok: false, status: "rejected", error: divergenceError("request_hash") };
  }
  const subjectText = rowString(row, "subject_json");
  if (subjectText === null) {
    return { ok: false, status: "rejected", error: divergenceError("subject_json") };
  }
  let subjectValue: unknown;
  try {
    subjectValue = JSON.parse(subjectText);
  } catch {
    return { ok: false, status: "rejected", error: divergenceError("subject_json") };
  }
  const subject = validateSubject(subjectValue);
  if (!subject.ok) {
    return { ok: false, status: "rejected", error: divergenceError("subject_json") };
  }
  const subjectHashValue = rowString(row, "subject_hash");
  if (subjectHashValue === null || !isHash(subjectHashValue)) {
    return { ok: false, status: "rejected", error: divergenceError("subject_hash") };
  }
  const stateText = rowString(row, "state");
  const state = stateText === null ? null : parseApprovalState(stateText);
  if (state === null) {
    return { ok: false, status: "rejected", error: divergenceError("state") };
  }
  const bootstrapText = rowString(row, "bootstrap_state");
  const bootstrapState = bootstrapText === null ? null : parseBootstrapState(bootstrapText);
  if (bootstrapState === null) {
    return { ok: false, status: "rejected", error: divergenceError("bootstrap_state") };
  }
  const evidenceRef = rowString(row, "evidence_ref");
  if (evidenceRef === null || !isSourceRef(evidenceRef)) {
    return { ok: false, status: "rejected", error: divergenceError("evidence_ref") };
  }
  const issuedAt = rowNumber(row, "issued_at");
  const expiresAt = rowNumber(row, "expires_at");
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) {
    return { ok: false, status: "rejected", error: divergenceError("issued_at") };
  }
  const rowVersion = rowNumber(row, "row_version");
  if (rowVersion === null || rowVersion < 1) {
    return { ok: false, status: "rejected", error: divergenceError("row_version") };
  }
  const consumedAtRaw = row["consumed_at"];
  const consumedRegistrationRaw = row["consumed_registration_hash"];
  const revokedAtRaw = row["revoked_at"];
  const revokeReasonRaw = row["revoke_reason"];
  let consumedAt: number | null = null;
  if (consumedAtRaw !== null) {
    if (!isSafeNonNegativeInt(consumedAtRaw)) {
      return { ok: false, status: "rejected", error: divergenceError("consumed_at") };
    }
    consumedAt = consumedAtRaw;
  }
  let consumedRegistration: Hash | null = null;
  if (consumedRegistrationRaw !== null) {
    if (typeof consumedRegistrationRaw !== "string" || !isHash(consumedRegistrationRaw)) {
      return { ok: false, status: "rejected", error: divergenceError("consumed_registration_hash") };
    }
    consumedRegistration = consumedRegistrationRaw;
  }
  let revokedAt: number | null = null;
  if (revokedAtRaw !== null) {
    if (!isSafeNonNegativeInt(revokedAtRaw)) {
      return { ok: false, status: "rejected", error: divergenceError("revoked_at") };
    }
    revokedAt = revokedAtRaw;
  }
  let revokeReason: RevokeReason | null = null;
  if (revokeReasonRaw !== null) {
    if (typeof revokeReasonRaw !== "string") {
      return { ok: false, status: "rejected", error: divergenceError("revoke_reason") };
    }
    revokeReason = parseRevokeReason(revokeReasonRaw);
    if (revokeReason === null) {
      return { ok: false, status: "rejected", error: divergenceError("revoke_reason") };
    }
  }
  const approvalHash = rowString(row, "approval_hash");
  if (approvalHash === null || !isHash(approvalHash)) {
    return { ok: false, status: "rejected", error: divergenceError("approval_hash") };
  }
  const parsed: ApprovalRow = {
    approval_id: approvalId,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    subject: subject.value,
    subject_hash: subjectHashValue,
    state,
    bootstrap_state: bootstrapState,
    evidence_ref: evidenceRef,
    issued_at: issuedAt,
    expires_at: expiresAt,
    consumed_at: consumedAt,
    consumed_registration_hash: consumedRegistration,
    revoked_at: revokedAt,
    revoke_reason: revokeReason,
    approval_hash: approvalHash,
    row_version: rowVersion
  };
  if (parsed.subject_hash !== subjectHash(parsed.subject)) {
    return { ok: false, status: "rejected", error: divergenceError("subject_hash") };
  }
  if (parsed.approval_hash !== computeApprovalHash(parsed.subject, parsed.subject_hash, parsed.issued_at, parsed.expires_at)) {
    return { ok: false, status: "rejected", error: divergenceError("approval_hash") };
  }
  if (
    parsed.state === "consumed" &&
    (parsed.consumed_at === null || parsed.consumed_registration_hash === null)
  ) {
    return { ok: false, status: "rejected", error: divergenceError("consumed_fields") };
  }
  if (parsed.state === "revoked" && (parsed.revoked_at === null || parsed.revoke_reason === null)) {
    return { ok: false, status: "rejected", error: divergenceError("revoked_fields") };
  }
  if (
    (parsed.state === "active" || parsed.state === "expired") &&
    (parsed.consumed_at !== null ||
      parsed.consumed_registration_hash !== null ||
      parsed.revoked_at !== null ||
      parsed.revoke_reason !== null)
  ) {
    return { ok: false, status: "rejected", error: divergenceError("terminal_fields") };
  }
  return { ok: true, status: "ok", value: parsed };
}

function readApprovalRow(
  connection: SqliteConnection,
  approvalId: Id<"iap">
): Result<ApprovalRow | null, ErrorEnvelope> {
  const row = oneRow(connection, "SELECT * FROM adapter_install_approval WHERE approval_id = :approval_id", {
    approval_id: approvalId
  });
  if (row === null) {
    return { ok: true, status: "ok", value: null };
  }
  return parseApprovalRow(row);
}

function readApprovalRowByIdempotencyKey(
  connection: SqliteConnection,
  idempotencyKey: string
): Result<ApprovalRow | null, ErrorEnvelope> {
  const row = oneRow(
    connection,
    "SELECT * FROM adapter_install_approval WHERE idempotency_key = :idempotency_key",
    { idempotency_key: idempotencyKey }
  );
  if (row === null) {
    return { ok: true, status: "ok", value: null };
  }
  return parseApprovalRow(row);
}

function readConsumedRegistration(
  connection: SqliteConnection,
  registrationHash: Hash
): Result<Id<"iap"> | null, ErrorEnvelope> {
  const row = oneRow(
    connection,
    "SELECT approval_id FROM adapter_install_approval WHERE consumed_registration_hash = :registration_hash",
    { registration_hash: registrationHash }
  );
  if (row === null) {
    return { ok: true, status: "ok", value: null };
  }
  const approvalId = rowString(row, "approval_id");
  if (approvalId === null || !isId(approvalId, "iap")) {
    return { ok: false, status: "rejected", error: divergenceError("consumed_registration_hash") };
  }
  return { ok: true, status: "ok", value: approvalId };
}

function toView(row: ApprovalRow): AdapterInstallApprovalView {
  const base: AdapterInstallApprovalView = {
    schema_version: APPROVAL_SCHEMA_VERSION,
    approval_id: row.approval_id,
    state: row.state,
    bootstrap_state: row.bootstrap_state,
    subject: row.subject,
    subject_hash: row.subject_hash,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    approval_hash: row.approval_hash
  };
  if (row.state === "consumed" && row.consumed_at !== null && row.consumed_registration_hash !== null) {
    return {
      ...base,
      consumed_at: row.consumed_at,
      consumed_registration_hash: row.consumed_registration_hash
    };
  }
  if (row.state === "revoked" && row.revoked_at !== null) {
    return { ...base, revoked_at: row.revoked_at };
  }
  return base;
}

function evidenceHash(ref: SourceRef): Hash | null {
  const parsed = parseSourceRef(ref);
  if (!parsed.ok || parsed.value.scheme !== "blob" || !isHash(parsed.value.locator)) {
    return null;
  }
  return parsed.value.locator;
}

/* ------------------------------------------------------------------ */
/* Journal + projection                                                */
/* ------------------------------------------------------------------ */

interface InstallContext {
  readonly deps: InstallServiceDeps;
  readonly committer: JournalCommitter | null;
}

interface ApprovalEventInput {
  readonly event_type: typeof RECORDED_EVENT | typeof TRANSITION_EVENT;
  readonly operation: "insert" | "transition";
  readonly row: ApprovalRow;
  readonly before: ApprovalRow | null;
  readonly blob_hash: Hash;
  readonly apply: (tx: Tx) => void;
}

function createContext(deps: InstallServiceDeps): InstallContext {
  if (deps.journal === undefined) {
    return { deps, committer: null };
  }
  return {
    deps,
    committer: createJournalCommitter({
      writer: deps.journal.writer,
      connection: deps.connection,
      relative_path: deps.journal.relative_path,
      now: deps.now
    })
  };
}

function insertLedgerEventLog(
  tx: Tx,
  input: {
    readonly event_id: string;
    readonly event_key: Hash;
    readonly commit_seq: number;
    readonly journal_id: string;
    readonly event_type: string;
    readonly entity_id: string;
    readonly operation: string;
    readonly before_hash: Hash | null;
    readonly after_hash: Hash;
    readonly row_json: string;
    readonly payload_hash: Hash;
    readonly recorded_at: number;
  }
): void {
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, 'global', NULL, NULL, NULL, NULL, NULL, NULL,
       :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: input.event_id,
    event_key: input.event_key,
    commit_seq: input.commit_seq,
    journal_id: input.journal_id,
    event_type: input.event_type,
    entity_type: ENTITY_TYPE,
    entity_id: input.entity_id,
    operation: input.operation,
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    row_schema: ROW_SCHEMA,
    row_json: input.row_json,
    payload_hash: input.payload_hash,
    recorded_at: input.recorded_at
  });
}

function insertJournalBlobRef(
  tx: Tx,
  input: {
    readonly blob_hash: Hash;
    readonly byte_length: number;
    readonly relative_path: string;
    readonly event_id: string;
    readonly payload_length: number;
    readonly now: number;
  }
): void {
  tx.prepare(
    `INSERT INTO blob (
       blob_hash, byte_length, relative_path, state, verified_at, created_at,
       deleted_at, deletion_reason
     ) VALUES (
       :blob_hash, :byte_length, :relative_path, 'present', :now, :now, NULL, NULL
     )
     ON CONFLICT(blob_hash) DO NOTHING`
  ).run({
    blob_hash: input.blob_hash,
    byte_length: input.byte_length,
    relative_path: input.relative_path,
    now: input.now
  });
  tx.prepare(
    `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
     VALUES (:blob_hash, 'journal', :event_id, :source_ref, :created_at)
     ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
  ).run({
    blob_hash: input.blob_hash,
    event_id: input.event_id,
    source_ref: `journal://${input.event_id}#bytes=0-${input.payload_length}`,
    created_at: input.now
  });
}

function commitApprovalEvent<Value>(
  context: InstallContext,
  input: ApprovalEventInput,
  project: (tx: Tx, receipt: JournalAppendResult, eventId: Id<"ev">) => NotPromise<Value>
): Result<Value, ErrorEnvelope> {
  const committer = context.committer;
  if (committer === null) {
    return { ok: false, status: "rejected", error: internalError("kernel.install_journal_unavailable") };
  }
  const at = context.deps.now();
  const rowJson = canonicalJsonText(approvalRowJson(input.row));
  const afterHash = approvalRowHash(input.row);
  const beforeHash = input.before === null ? null : approvalRowHash(input.before);
  const eventId = newId("ev", at);
  const eventKey = canonicalHash(
    toJsonValue({
      event_type: input.event_type,
      entity_type: ENTITY_TYPE,
      entity_id: input.row.approval_id,
      operation: input.operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      binding: null
    })
  );
  const event = toJsonValue({
    schema_version: "rsi.ledger_event/1",
    event_id: eventId,
    event_key: eventKey,
    event_type: input.event_type,
    entity_type: ENTITY_TYPE,
    entity_id: input.row.approval_id,
    operation: input.operation,
    binding: null,
    before_hash: beforeHash,
    after_hash: afterHash,
    row_schema: ROW_SCHEMA,
    row_json: rowJson,
    payload_hash: afterHash,
    recorded_at: at
  });
  const payload: JournalFramePayload = {
    schema_version: "rsi.journal_event/1",
    event,
    event_hash: canonicalHash(event),
    blob_hashes: [input.blob_hash]
  };
  const payloadText = canonicalJsonText(toJsonValue(payload));
  const payloadLength = new TextEncoder().encode(payloadText).byteLength;
  const parsedEvidence = parseSourceRef(input.row.evidence_ref);
  const evidenceLength = parsedEvidence.ok ? parsedEvidence.value.end - parsedEvidence.value.start : 0;
  const outcome = committer.commitSync<Value>(payload, (tx, receipt) => {
    insertLedgerEventLog(tx, {
      event_id: eventId,
      event_key: eventKey,
      commit_seq: receipt.first_commit_seq,
      journal_id: receipt.journal_id,
      event_type: input.event_type,
      entity_id: input.row.approval_id,
      operation: input.operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      row_json: rowJson,
      payload_hash: afterHash,
      recorded_at: at
    });
    insertJournalBlobRef(tx, {
      blob_hash: input.blob_hash,
      byte_length: evidenceLength,
      relative_path: context.deps.blob_store.relativePath(input.blob_hash),
      event_id: eventId,
      payload_length: payloadLength,
      now: at
    });
    input.apply(tx);
    return project(tx, receipt, eventId);
  });
  if (!outcome.ok) {
    const status: FailureStatus =
      outcome.commit_state === "unknown_recovery_required" ? "unknown" : "rejected";
    return { ok: false, status, error: outcome.error };
  }
  if (outcome.value === null) {
    return { ok: false, status: "rejected", error: internalError("kernel.install_event_projection_missing") };
  }
  return { ok: true, status: "ok", value: outcome.value };
}

function insertApprovalRow(tx: Tx, row: ApprovalRow): void {
  tx.prepare(
    `INSERT INTO adapter_install_approval (
       approval_id, idempotency_key, request_hash, subject_json, subject_hash,
       state, bootstrap_state, evidence_ref, issued_at, expires_at,
       consumed_at, consumed_registration_hash, revoked_at, revoke_reason,
       approval_hash, row_version
     ) VALUES (
       :approval_id, :idempotency_key, :request_hash, :subject_json, :subject_hash,
       :state, :bootstrap_state, :evidence_ref, :issued_at, :expires_at,
       :consumed_at, :consumed_registration_hash, :revoked_at, :revoke_reason,
       :approval_hash, :row_version
     )`
  ).run({
    approval_id: row.approval_id,
    idempotency_key: row.idempotency_key,
    request_hash: row.request_hash,
    subject_json: canonicalJsonText(subjectJson(row.subject)),
    subject_hash: row.subject_hash,
    state: row.state,
    bootstrap_state: row.bootstrap_state,
    evidence_ref: row.evidence_ref,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    consumed_registration_hash: row.consumed_registration_hash,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
    approval_hash: row.approval_hash,
    row_version: row.row_version
  });
}

function updateApprovalRow(
  tx: Tx,
  before: ApprovalRow,
  after: ApprovalRow,
  now: number | null
): number {
  const result = tx
    .prepare(
      `UPDATE adapter_install_approval
          SET state = :state,
              consumed_at = :consumed_at,
              consumed_registration_hash = :consumed_registration_hash,
              revoked_at = :revoked_at,
              revoke_reason = :revoke_reason,
              row_version = :row_version
        WHERE approval_id = :approval_id
          AND state = 'active'
          AND row_version = :expected_row_version${now === null ? "" : " AND expires_at > :now"}`
    )
    .run({
      state: after.state,
      consumed_at: after.consumed_at,
      consumed_registration_hash: after.consumed_registration_hash,
      revoked_at: after.revoked_at,
      revoke_reason: after.revoke_reason,
      row_version: after.row_version,
      approval_id: before.approval_id,
      expected_row_version: before.row_version,
      ...(now === null ? {} : { now })
    });
  return result.changes;
}

/* ------------------------------------------------------------------ */
/* Readiness and evidence                                              */
/* ------------------------------------------------------------------ */

async function evidenceRetrievable(context: InstallContext, ref: SourceRef): Promise<boolean> {
  const sourceRefs = context.deps.source_refs;
  if (sourceRefs === undefined) {
    return false;
  }
  try {
    const resolved = await sourceRefs.resolve(ref, { maxBytes: MAX_JSON_BYTES });
    return resolved.ok && resolved.value.retrievable && resolved.value.bytes !== null;
  } catch {
    return false;
  }
}

async function determineBootstrapState(
  context: InstallContext,
  requestId: string,
  subject: AdapterInstallSubject,
  subjectHashValue: Hash
): Promise<Result<BootstrapState, ErrorEnvelope>> {
  const readiness = context.deps.readiness;
  if (readiness === undefined) {
    return { ok: false, status: "rejected", error: unavailableError("install_readiness") };
  }
  let read: Result<InstallReadinessView, ErrorEnvelope>;
  try {
    read = await readiness.get({ request_id: requestId, subject, subject_hash: subjectHashValue });
  } catch {
    return { ok: false, status: "rejected", error: unavailableError("install_readiness") };
  }
  if (!read.ok) {
    return { ok: false, status: "rejected", error: unavailableError("install_readiness") };
  }
  const view = read.value;
  if (view.active_binding === "unknown") {
    return { ok: false, status: "rejected", error: unavailableError("install_readiness") };
  }
  const product = view.product_adapter;
  const host = view.host_contract;
  if (view.active_binding === "adapter") {
    if (
      product === null ||
      !product.active ||
      product.adapter_version !== subject.adapter_version ||
      product.implementation_hash !== subject.implementation_hash ||
      !(await evidenceRetrievable(context, product.evidence_ref))
    ) {
      return { ok: false, status: "rejected", error: unavailableError("install_readiness") };
    }
    return { ok: true, status: "ok", value: "postinstall_ready" };
  }
  // `active_binding="none"`: only a verified host contract can bootstrap.
  if (
    product !== null ||
    host === null ||
    host.status !== "verified" ||
    !host.roundtrip ||
    !host.probe_passed ||
    !(await evidenceRetrievable(context, host.evidence_ref))
  ) {
    return { ok: false, status: "rejected", error: unavailableError("install_readiness") };
  }
  return { ok: true, status: "ok", value: "preinstall_ready" };
}

async function materializeAttestation(
  context: InstallContext,
  attestation: ValidAttestation
): Promise<Result<SourceRef, ErrorEnvelope>> {
  const bytes = new TextEncoder().encode(attestation.canonical_text);
  const stored = context.deps.blob_store.putSync(bytes);
  if (!stored.ok) {
    return { ok: false, status: "rejected", error: approvalError("E_IO", "install_attestation_blob") };
  }
  if (stored.value.hash !== attestation.attestation_hash || stored.value.byte_length !== bytes.byteLength) {
    return { ok: false, status: "rejected", error: divergenceError("attestation_blob") };
  }
  const verified = context.deps.blob_store.verify(stored.value.hash);
  if (
    !verified.ok ||
    !verified.value.present ||
    !verified.value.hash_matches ||
    verified.value.byte_length !== bytes.byteLength
  ) {
    return { ok: false, status: "rejected", error: approvalError("E_IO", "install_attestation_blob") };
  }
  const ref = formatSourceRef({
    scheme: "blob",
    locator: stored.value.hash,
    start: 0,
    end: bytes.byteLength
  });
  if (!ref.ok) {
    return { ok: false, status: "rejected", error: divergenceError("attestation_blob_ref") };
  }
  return { ok: true, status: "ok", value: ref.value };
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

function expireApproval(
  context: InstallContext,
  row: ApprovalRow
): Result<ApprovalRow, ErrorEnvelope> {
  const blobHash = evidenceHash(row.evidence_ref);
  if (blobHash === null) {
    return { ok: false, status: "rejected", error: divergenceError("evidence_ref") };
  }
  const after: ApprovalRow = {
    ...row,
    state: "expired",
    consumed_at: null,
    consumed_registration_hash: null,
    revoked_at: null,
    revoke_reason: null,
    row_version: row.row_version + 1
  };
  const committed = commitApprovalEvent(
    context,
    {
      event_type: TRANSITION_EVENT,
      operation: "transition",
      row: after,
      before: row,
      blob_hash: blobHash,
      apply: (tx) => {
        const changes = updateApprovalRow(tx, row, after, null);
        if (changes !== 1) {
          throw divergenceError("install_approval_expire_cas");
        }
      }
    },
    () => true
  );
  if (!committed.ok) {
    return committed;
  }
  return { ok: true, status: "ok", value: after };
}

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

interface ApproveInput {
  readonly subject: AdapterInstallSubject;
  readonly attestation: ValidAttestation;
  readonly ttl_ms: number;
  readonly idempotency_key: string;
}

function validateApproveParams(value: unknown): Result<ApproveInput, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: invalidError("$", "object", "install_approve") };
  }
  if (value["schema_version"] !== "rsi.adapter_install_approve/1") {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("schema_version", "rsi.adapter_install_approve/1", "install_approve")
    };
  }
  const subject = validateSubject(value["subject"]);
  if (!subject.ok) {
    return subject;
  }
  const attestation = validateAttestation(value["human_attestation"]);
  if (!attestation.ok) {
    return attestation;
  }
  const ttl = value["ttl_ms"];
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MS) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("ttl_ms", "1..600000", "install_approve")
    };
  }
  if (!validIdempotencyKey(value["idempotency_key"])) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("idempotency_key", "1..128_pattern", "install_approve")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      subject: subject.value,
      attestation: attestation.value,
      ttl_ms: ttl,
      idempotency_key: value["idempotency_key"]
    }
  };
}

interface RevokeInput {
  readonly approval_id: Id<"iap">;
  readonly expected_approval_hash: Hash;
  readonly reason: RevokeReason;
  readonly attestation: ValidAttestation;
  readonly idempotency_key: string;
}

function validateRevokeParams(value: unknown): Result<RevokeInput, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: invalidError("$", "object", "install_revoke") };
  }
  const subjectValue = value["subject"];
  if (!isRecord(subjectValue)) {
    return { ok: false, status: "rejected", error: invalidError("subject", "object", "install_revoke") };
  }
  if (
    subjectValue["schema_version"] !== REVOKE_SUBJECT_SCHEMA_VERSION ||
    subjectValue["purpose"] !== "adapter_install"
  ) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("subject.purpose", "adapter_install", "install_revoke")
    };
  }
  const approvalId = subjectValue["approval_id"];
  if (typeof approvalId !== "string" || !isId(approvalId, "iap")) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("subject.approval_id", "iap_id", "install_revoke")
    };
  }
  const expectedHash = subjectValue["expected_approval_hash"];
  if (typeof expectedHash !== "string" || !isHash(expectedHash)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("subject.expected_approval_hash", "sha256_hash", "install_revoke")
    };
  }
  const reasonValue = subjectValue["reason"];
  const reason =
    reasonValue === "human_revoked" || reasonValue === "superseded" || reasonValue === "security"
      ? reasonValue
      : null;
  if (reason === null) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("subject.reason", "revoke_reason", "install_revoke")
    };
  }
  const attestation = validateAttestation(value["human_attestation"]);
  if (!attestation.ok) {
    return attestation;
  }
  if (!validIdempotencyKey(value["idempotency_key"])) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("idempotency_key", "1..128_pattern", "install_revoke")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      approval_id: approvalId,
      expected_approval_hash: expectedHash,
      reason,
      attestation: attestation.value,
      idempotency_key: value["idempotency_key"]
    }
  };
}

interface ConsumeInput {
  readonly approval_id: Id<"iap">;
  readonly expected_approval_hash: Hash;
  readonly registration_hash: Hash;
  readonly request_id: string;
  readonly idempotency_key: string;
}

function validateConsumeParams(value: unknown): Result<ConsumeInput, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: invalidError("$", "object", "install_consume") };
  }
  const approvalId = value["approval_id"];
  if (typeof approvalId !== "string" || !isId(approvalId, "iap")) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("approval_id", "iap_id", "install_consume")
    };
  }
  const expectedHash = value["expected_approval_hash"];
  if (typeof expectedHash !== "string" || !isHash(expectedHash)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("expected_approval_hash", "sha256_hash", "install_consume")
    };
  }
  const registrationHash = value["registration_hash"];
  if (typeof registrationHash !== "string" || !isHash(registrationHash)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("registration_hash", "sha256_hash", "install_consume")
    };
  }
  const requestId = value["request_id"];
  if (!isNonEmptyString(requestId, 128)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("request_id", "1..128", "install_consume")
    };
  }
  if (!validIdempotencyKey(value["idempotency_key"])) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("idempotency_key", "1..128_pattern", "install_consume")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      approval_id: approvalId,
      expected_approval_hash: expectedHash,
      registration_hash: registrationHash,
      request_id: requestId,
      idempotency_key: value["idempotency_key"]
    }
  };
}

function validateGetParams(
  value: unknown
): Result<{ approval_id: Id<"iap">; expected_subject_hash: Hash }, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: invalidError("$", "object", "install_approval_get") };
  }
  const approvalId = value["approval_id"];
  if (typeof approvalId !== "string" || !isId(approvalId, "iap")) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("approval_id", "iap_id", "install_approval_get")
    };
  }
  const subjectHashValue = value["expected_subject_hash"];
  if (typeof subjectHashValue !== "string" || !isHash(subjectHashValue)) {
    return {
      ok: false,
      status: "rejected",
      error: invalidError("expected_subject_hash", "sha256_hash", "install_approval_get")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: { approval_id: approvalId, expected_subject_hash: subjectHashValue }
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

function approveHandler(context: InstallContext): IpcHandler<"install.approve"> {
  return async (
    ipcContext
  ): Promise<Result<IpcResult["install.approve"], ErrorEnvelope>> => {
    const parsed = validateApproveParams(ipcContext.params);
    if (!parsed.ok) {
      return parsed;
    }
    const input = parsed.value;
    if (context.deps.readiness === undefined || context.deps.proof === undefined) {
      return { ok: false, status: "rejected", error: unavailableError("install_readiness") };
    }
    if (context.deps.source_refs === undefined || context.committer === null) {
      return { ok: false, status: "rejected", error: internalError("kernel.install_journal_unavailable") };
    }
    const subjectHashValue = subjectHash(input.subject);
    const requestHash = issuanceRequestHash(
      input.subject,
      input.ttl_ms,
      input.attestation.attestation_hash
    );
    const existing = readApprovalRowByIdempotencyKey(
      context.deps.connection,
      input.idempotency_key
    );
    if (!existing.ok) {
      return existing;
    }
    if (existing.value !== null) {
      if (existing.value.request_hash !== requestHash) {
        return {
          ok: false,
          status: "rejected",
          error: approvalError("E_IDEMPOTENCY_CONFLICT", "install_approve", {
            kind: "idempotency",
            key: input.idempotency_key,
            existing_hash: existing.value.request_hash,
            incoming_hash: requestHash
          })
        };
      }
      return { ok: true, status: "ok", value: toView(existing.value) };
    }
    const bootstrap = await determineBootstrapState(
      context,
      ipcContext.request_id,
      input.subject,
      subjectHashValue
    );
    if (!bootstrap.ok) {
      return bootstrap;
    }
    const evidenceRef = await materializeAttestation(context, input.attestation);
    if (!evidenceRef.ok) {
      return evidenceRef;
    }
    let verdict: "verified" | "unverified" | "conflict";
    try {
      verdict = await context.deps.proof.verifyControlPlane({
        attestation: input.attestation.attestation,
        subject_hash: subjectHashValue,
        purpose: "adapter_install"
      });
    } catch {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_UNVERIFIED", "install_proof")
      };
    }
    if (verdict !== "verified") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_UNVERIFIED", "install_proof")
      };
    }
    const issuedAt = context.deps.now();
    const expiresAt = issuedAt + input.ttl_ms;
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
      return {
        ok: false,
        status: "rejected",
        error: invalidError("ttl_ms", "safe_integer_expiry", "install_approve")
      };
    }
    const approvalId = newId("iap", issuedAt);
    const row: ApprovalRow = {
      approval_id: approvalId,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      subject: input.subject,
      subject_hash: subjectHashValue,
      state: "active",
      bootstrap_state: bootstrap.value,
      evidence_ref: evidenceRef.value,
      issued_at: issuedAt,
      expires_at: expiresAt,
      consumed_at: null,
      consumed_registration_hash: null,
      revoked_at: null,
      revoke_reason: null,
      approval_hash: computeApprovalHash(
        input.subject,
        subjectHashValue,
        issuedAt,
        expiresAt
      ),
      row_version: 1
    };
    const committed = commitApprovalEvent(
      context,
      {
        event_type: RECORDED_EVENT,
        operation: "insert",
        row,
        before: null,
        blob_hash: input.attestation.attestation_hash,
        apply: (tx) => insertApprovalRow(tx, row)
      },
      () => true
    );
    if (!committed.ok) {
      return committed;
    }
    const readback = readApprovalRow(context.deps.connection, approvalId);
    if (!readback.ok) {
      return readback;
    }
    if (readback.value === null || readback.value.approval_hash !== row.approval_hash) {
      return { ok: false, status: "rejected", error: divergenceError("install_approval_readback") };
    }
    return { ok: true, status: "ok", value: toView(readback.value) };
  };
}

function revokeHandler(context: InstallContext): IpcHandler<"install.revoke"> {
  return async (
    ipcContext
  ): Promise<Result<IpcResult["install.revoke"], ErrorEnvelope>> => {
    const parsed = validateRevokeParams(ipcContext.params);
    if (!parsed.ok) {
      return parsed;
    }
    const input = parsed.value;
    if (context.deps.proof === undefined) {
      return { ok: false, status: "rejected", error: unavailableError("install_proof") };
    }
    if (context.committer === null) {
      return { ok: false, status: "rejected", error: internalError("kernel.install_journal_unavailable") };
    }
    let verdict: "verified" | "unverified" | "conflict";
    try {
      verdict = await context.deps.proof.verifyControlPlane({
        attestation: input.attestation.attestation,
        subject_hash: revokeSubjectHash({
          approval_id: input.approval_id,
          expected_approval_hash: input.expected_approval_hash,
          reason: input.reason
        }),
        purpose: "adapter_install"
      });
    } catch {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_UNVERIFIED", "install_proof")
      };
    }
    if (verdict !== "verified") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_UNVERIFIED", "install_proof")
      };
    }
    const read = readApprovalRow(context.deps.connection, input.approval_id);
    if (!read.ok) {
      return read;
    }
    if (read.value === null) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_NOT_FOUND", "install_revoke")
      };
    }
    const row = read.value;
    if (row.approval_hash !== input.expected_approval_hash) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_HASH", "install_revoke")
      };
    }
    if (row.state === "consumed") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_STATE", "install_revoke")
      };
    }
    if (row.state === "revoked") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_STATE", "install_revoke")
      };
    }
    if (row.state === "expired") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_EXPIRED", "install_revoke")
      };
    }
    const at = context.deps.now();
    if (row.expires_at <= at) {
      const expired = expireApproval(context, row);
      if (!expired.ok) {
        return expired;
      }
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_EXPIRED", "install_revoke")
      };
    }
    const blobHash = evidenceHash(row.evidence_ref);
    if (blobHash === null) {
      return { ok: false, status: "rejected", error: divergenceError("evidence_ref") };
    }
    const after: ApprovalRow = {
      ...row,
      state: "revoked",
      consumed_at: null,
      consumed_registration_hash: null,
      revoked_at: at,
      revoke_reason: input.reason,
      row_version: row.row_version + 1
    };
    const committed = commitApprovalEvent(
      context,
      {
        event_type: TRANSITION_EVENT,
        operation: "transition",
        row: after,
        before: row,
        blob_hash: blobHash,
        apply: (tx) => {
          if (updateApprovalRow(tx, row, after, null) !== 1) {
            throw divergenceError("install_approval_revoke_cas");
          }
        }
      },
      () => true
    );
    if (!committed.ok) {
      return committed;
    }
    const readback = readApprovalRow(context.deps.connection, row.approval_id);
    if (!readback.ok) {
      return readback;
    }
    if (readback.value === null || readback.value.state !== "revoked") {
      return { ok: false, status: "rejected", error: divergenceError("install_approval_readback") };
    }
    return { ok: true, status: "ok", value: toView(readback.value) };
  };
}

function getHandler(context: InstallContext): IpcHandler<"install.approval.get"> {
  return async (
    ipcContext
  ): Promise<Result<IpcResult["install.approval.get"], ErrorEnvelope>> => {
    const parsed = validateGetParams(ipcContext.params);
    if (!parsed.ok) {
      return parsed;
    }
    const read = readApprovalRow(context.deps.connection, parsed.value.approval_id);
    if (!read.ok) {
      return read;
    }
    if (read.value === null) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_NOT_FOUND", "install_approval_get")
      };
    }
    const row = read.value;
    if (row.subject_hash !== parsed.value.expected_subject_hash) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_SUBJECT_MISMATCH", "install_approval_get")
      };
    }
    if (row.state === "expired") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_EXPIRED", "install_approval_get")
      };
    }
    if (row.state === "consumed" || row.state === "revoked") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_STATE", "install_approval_get")
      };
    }
    if (row.expires_at <= context.deps.now()) {
      const expired = expireApproval(context, row);
      if (!expired.ok) {
        return expired;
      }
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_EXPIRED", "install_approval_get")
      };
    }
    return { ok: true, status: "ok", value: toView(row) };
  };
}

function consumeHandler(context: InstallContext): IpcHandler<"install.approval.consume"> {
  return async (
    ipcContext
  ): Promise<Result<IpcResult["install.approval.consume"], ErrorEnvelope>> => {
    const parsed = validateConsumeParams(ipcContext.params);
    if (!parsed.ok) {
      return parsed;
    }
    const input = parsed.value;
    if (context.committer === null) {
      return { ok: false, status: "rejected", error: internalError("kernel.install_journal_unavailable") };
    }
    const read = readApprovalRow(context.deps.connection, input.approval_id);
    if (!read.ok) {
      return read;
    }
    if (read.value === null) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_NOT_FOUND", "install_approval_consume")
      };
    }
    const row = read.value;
    if (row.approval_hash !== input.expected_approval_hash) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_HASH", "install_approval_consume")
      };
    }
    if (row.state === "consumed") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_CONSUMED", "install_approval_consume")
      };
    }
    if (row.state === "revoked") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_STATE", "install_approval_consume")
      };
    }
    if (row.state === "expired") {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_EXPIRED", "install_approval_consume")
      };
    }
    const consumedRegistrations = readConsumedRegistration(
      context.deps.connection,
      input.registration_hash
    );
    if (!consumedRegistrations.ok) {
      return consumedRegistrations;
    }
    if (consumedRegistrations.value !== null) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_CONSUMED", "install_approval_consume")
      };
    }
    const at = context.deps.now();
    if (row.expires_at <= at) {
      const expired = expireApproval(context, row);
      if (!expired.ok) {
        return expired;
      }
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_EXPIRED", "install_approval_consume")
      };
    }
    const blobHash = evidenceHash(row.evidence_ref);
    if (blobHash === null) {
      return { ok: false, status: "rejected", error: divergenceError("evidence_ref") };
    }
    const evidence = context.deps.blob_store.verify(blobHash);
    if (!evidence.ok || !evidence.value.present || !evidence.value.hash_matches) {
      return {
        ok: false,
        status: "rejected",
        error: approvalError("E_APPROVAL_UNVERIFIED", "install_approval_consume")
      };
    }
    const after: ApprovalRow = {
      ...row,
      state: "consumed",
      consumed_at: at,
      consumed_registration_hash: input.registration_hash,
      revoked_at: null,
      revoke_reason: null,
      row_version: row.row_version + 1
    };
    const committed = commitApprovalEvent(
      context,
      {
        event_type: TRANSITION_EVENT,
        operation: "transition",
        row: after,
        before: row,
        blob_hash: blobHash,
        apply: (tx) => {
          if (updateApprovalRow(tx, row, after, at) !== 1) {
            throw divergenceError("install_approval_consume_cas");
          }
        }
      },
      (_tx, receipt, eventId) => {
        const ref = formatSourceRef({
          scheme: "journal",
          locator: eventId,
          start: receipt.file_offset,
          end: receipt.file_offset + receipt.frame_bytes
        });
        if (!ref.ok) {
          throw divergenceError("install_approval_consumption_ref");
        }
        return ref.value;
      }
    );
    if (!committed.ok) {
      return committed;
    }
    const readback = readApprovalRow(context.deps.connection, row.approval_id);
    if (!readback.ok) {
      return readback;
    }
    if (
      readback.value === null ||
      readback.value.state !== "consumed" ||
      readback.value.consumed_registration_hash !== input.registration_hash
    ) {
      return { ok: false, status: "rejected", error: divergenceError("install_approval_readback") };
    }
    return {
      ok: true,
      status: "ok",
      value: { approval: toView(readback.value), consumption_ref: committed.value }
    };
  };
}

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

export function createInstallApproveHandler(
  deps: InstallServiceDeps
): IpcHandler<"install.approve"> {
  return approveHandler(createContext(deps));
}

export function createInstallRevokeHandler(
  deps: InstallServiceDeps
): IpcHandler<"install.revoke"> {
  return revokeHandler(createContext(deps));
}

export function createInstallApprovalGetHandler(
  deps: InstallServiceDeps
): IpcHandler<"install.approval.get"> {
  return getHandler(createContext(deps));
}

export function createInstallApprovalConsumeHandler(
  deps: InstallServiceDeps
): IpcHandler<"install.approval.consume"> {
  return consumeHandler(createContext(deps));
}

/** Builds the four install handlers over one journal committer. */
export function createInstallService(deps: InstallServiceDeps): InstallService {
  const context = createContext(deps);
  return {
    handlers: {
      "install.approve": approveHandler(context),
      "install.revoke": revokeHandler(context),
      "install.approval.get": getHandler(context),
      "install.approval.consume": consumeHandler(context)
    }
  };
}
