/**
 * Host-side runtime services (`host.runtime/ready|upload|poll|result`,
 * DD-HOST-200…206).
 *
 * The runtime artifact runs inside the host process and only talks to the
 * kernel over UDS IPC. This module owns the kernel side of that protocol:
 * peer/session binding, the host-core upload path (payload blob ->
 * `normalizeEvent` -> `finalizeNormalizedHostEvent` -> `EventDraft` ->
 * `event.ingest`), the long-poll claim of `host_runtime_call`, and the result
 * state machine.
 *
 * The runtime never normalizes, allocates identities or writes SQLite itself;
 * only this module does. The delivery/capability bridges that create calls are
 * outside M2; `HostRuntimeCallResolverPort` supplies the persisted request and
 * content for a claimed call.
 */

import { randomBytes, } from "node:crypto";

import { type Clock, type ErrorEnvelope, type EventDraft, type Hash, type HostId, type HostMode, type Id, type IngestReceipt, type JsonValue, type Result, type SourceRef, type SourceRefPort } from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  hashBytes,
  isHash,
  isHostId,
  isHostMode,
  isId,
  isJsonValue,
  isSourceRef,
  isWellFormedUnicode,
  makeErrorEnvelope,
  newId,
  ok
} from "@evoplug/core";
import type {
  ActiveAdapterRegistration,
  AdapterDescriptor,
  AdapterEventContract,
  CapabilityName,
  ContentUpload,
  HostAdapterError,
  HostAdapterResult,
  HostDeliveryResult,
  HostEventRejection,
  HostPayloadStorePort,
  NormalizedHostEventDraft,
  NormalizeHostEventInput,
  RawHostEvent,
  RawHostEventUpload,
  ResolvedHostPayload,
  HostRuntimePollRequest,
  HostRuntimePollResult,
  HostRuntimeReadyRequest,
  HostRuntimeReadyResult,
  HostRuntimeResultRequest,
  HostRuntimeResultResult,
  HostRuntimeUploadRequest,
  HostRuntimeUploadResult,
  RuntimeCall as RuntimeCallType,
  RuntimeCallResult,
  RuntimeProbeRequest
} from "@evoplug/core/host";
import { activeRegistrationFromDescriptor, adapterDescriptorHash, admitPhaseA, buildHostEventRejection, capabilityBindingKey, computeRegistrationHash, draftBindingMatchesRaw, draftMatchesContract, finalizeNormalizedHostEvent, isInputContract, MAX_HOST_PAYLOAD_BYTES, normalizeToEventDraft, parseRuntimeHumanConfirmationObserved, parseRuntimeConfirmationObservation, resolveHostPayload, selectSourceSeq, validateAdapterDescriptor, validateCapabilityBinding } from "@evoplug/core/host";
import type { IpcHandler, IpcHandlerContext } from "@evoplug/ipc";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";



import type { SessionScopeReadPort, StableEventScope } from "./session-scope.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Public dependency contract                                          */
/* ------------------------------------------------------------------ */

/** The wrapped `event.ingest` handler; the runtime never bypasses it. */
type HostRuntimeIngest = (
  draft: EventDraft
) => Promise<Result<IngestReceipt, ErrorEnvelope>>;

/** The only adapter-library surface the runtime ingress needs. */
export interface HostRuntimeAdapter {
  normalizeEvent(input: NormalizeHostEventInput): HostAdapterResult<NormalizedHostEventDraft>;
}

/** Resolves the registered adapter library for one applied binding. */
export interface HostRuntimeAdapterResolverPort {
  resolve(input: {
    readonly registration_hash: Hash;
    readonly adapter_id: Id<"adp">;
  }): HostRuntimeAdapter | null;
}

/** One claimed `host_runtime_call` row (physical projection). */
export interface HostRuntimeCallRow {
  readonly call_id: string;
  readonly kind: "deliver" | "check_load" | "probe";
  readonly registration_hash: Hash;
  readonly artifact_hash: Hash;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly native_session_id: string | null;
  readonly hook_event: string | null;
  readonly boundary_event_key: Hash | null;
  readonly goal_version: string | null;
  readonly config_version: string | null;
  readonly input_epoch: number | null;
  readonly object_ref: string;
  readonly deadline_at: number;
  readonly state: "pending" | "issued" | "completed" | "uncertain" | "expired";
  readonly issued_session_id: string | null;
  readonly issued_at: number | null;
  readonly result_hash: Hash | null;
  readonly result_ref: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** One `host_runtime_session` row (physical projection). */
export interface HostRuntimeSessionRow {
  readonly session_id: Id<"rts">;
  readonly session_nonce: string;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly registration_hash: Hash;
  readonly artifact_hash: Hash;
  readonly config_hash: Hash;
  readonly host_version: string;
  readonly binary_hash: Hash | null;
  readonly ephemeral: boolean;
  /** Appendix L.1: only `evaluator` is suppressed as probe traffic. */
  readonly session_role: "evaluator" | "host_session";
  /** Appendix M.1: working directory reported by the host session. */
  readonly working_directory: string | null;
  readonly instance_key: string | null;
  readonly native_session_id: string | null;
  readonly pid: number;
  readonly state: "ready" | "revoked" | "closed" | "failed";
  readonly lease_expires_at: number;
  readonly started_at: number;
  readonly last_seen_at: number;
  readonly closed_at: number | null;
}

/** Supplies the persisted request/content for a claimed call. */
export interface HostRuntimeCallResolverPort {
  resolve(input: {
    readonly row: HostRuntimeCallRow;
    readonly session: HostRuntimeSessionRow;
    readonly now: number;
    readonly delivery_max_chars: number;
  }): Promise<Result<RuntimeCallType | null, ErrorEnvelope>>;
}

/**
 * Limits applied to every runtime request/response.
 */
export interface HostRuntimeLimits {
  readonly max_payload_bytes: number;
  readonly poll_wait_max_ms: number;
  readonly delivery_max_chars: number;
}

/** One terminal probe/check-load result, delivered after the row commits. */
export interface HostRuntimeCallCompletion {
  readonly row: HostRuntimeCallRow;
  readonly session: HostRuntimeSessionRow;
  readonly result: RuntimeCallResult;
}

/** The receipt a runtime presents on one poll iteration. */
interface HostRuntimePollIntent {
  readonly session: HostRuntimeSessionRow;
  readonly event_identity_key: Hash | null;
  readonly hook_event: string | null;
  readonly now: number;
}

/**
 * Producer hooks for the probe/check-load chain. The kernel never decides what
 * a probe means; it only reports session lifecycle and terminal results. Every
 * hook is optional, so an unconfigured runtime behaves exactly as before.
 */
export interface HostRuntimeProbeLifecyclePort {
  /** Session reached `ready`; the producer may schedule attach-time calls. */
  onSessionReady?(input: { readonly session: HostRuntimeSessionRow }): void | Promise<void>;
  /**
   * Runs inside the poll transaction, before candidates are selected. The
   * producer may arm a null-boundary call with a real receipt key here; it
   * must stay synchronous and must not invent a boundary.
   */
  onSessionPoll?(input: HostRuntimePollIntent): void;
  /** Runs after the poll transaction; schedules retries when nothing is live. */
  onPollObserved?(input: {
    readonly session: HostRuntimeSessionRow;
    readonly now: number;
  }): void | Promise<void>;
  /** A probe/check-load call moved `issued` -> `completed`. */
  onCallCompleted?(input: HostRuntimeCallCompletion): void | Promise<void>;
}

/** Exact post-commit handoff for an authenticated runtime upload. */
export interface HostRuntimeUploadCommit {
  /** Session re-read by the kernel after the event committed. */
  readonly session: HostRuntimeSessionRow;
  readonly request: HostRuntimeUploadRequest;
  readonly result: HostRuntimeUploadResult;
}

/**
 * One refused upload, reduced to what an operator needs to act. The kernel also
 * stores the same object as a real CAS blob so the printed `detail_ref` is
 * retrievable, never a synthetic or zero-length reference.
 */
export interface HostRuntimeUploadDiagnostic {
  readonly session_id: string;
  readonly host_event: string;
  readonly raw_event_id: string;
  readonly state: "rejected" | "error";
  readonly reason: string;
  readonly field: string;
  readonly phase: "A" | "B" | null;
  readonly detail_ref: SourceRef | null;
}

interface HostRuntimeServiceDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: {
    putSync(bytes: Uint8Array): Result<
      { readonly hash: Hash; readonly byte_length: number; readonly relative_path: string },
      ErrorEnvelope
    >;
  };
  readonly source_refs: Pick<SourceRefPort, "resolve">;
  readonly session_scope: SessionScopeReadPort;
  readonly adapters: HostRuntimeAdapterResolverPort;
  readonly ingest: HostRuntimeIngest;
  /** Required for `poll`; the delivery bridge supplies it in M3. */
  readonly call_resolver?: HostRuntimeCallResolverPort;
  /** Optional W1 probe producer hooks; absent means probes are never scheduled. */
  readonly lifecycle?: HostRuntimeProbeLifecyclePort;
  /**
   * Existing upload ABI post-commit hook. Runs after `event.ingest` returns a
   * receipt and never changes the ACK; the composition uses it to select a
   * human-origin candidate without a new IPC method.
   */
  readonly human_attestation_upload?: (input: HostRuntimeUploadCommit) => void;
  /**
   * Appendix I.1: one registration can be installed under several host
   * directories. True when this exact config hash was produced by an attach
   * for that registration (see `host-installations.ts`).
   */
  readonly installation_config_allowed?: (
    registration_hash: string,
    config_hash: string
  ) => boolean;
  /**
   * Observes a refused upload. The hook is diagnostic only: it never changes
   * the ACK and must not throw. The composition prints one structured line.
   */
  readonly upload_diagnostic?: (input: HostRuntimeUploadDiagnostic) => void;
  readonly now: () => number;
  readonly limits?: Partial<HostRuntimeLimits>;
  readonly random_nonce?: () => string;
  /** Long-poll retry interval; defaults to 50 ms. */
  readonly poll_interval_ms?: number;
}

export type HostRuntimeHandlers = {
  readonly "host.runtime.ready": IpcHandler<"host.runtime.ready">;
  readonly "host.runtime.upload": IpcHandler<"host.runtime.upload">;
  readonly "host.runtime.poll": IpcHandler<"host.runtime.poll">;
  readonly "host.runtime.result": IpcHandler<"host.runtime.result">;
};

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_HOST_RUNTIME_LIMITS: HostRuntimeLimits = Object.freeze({
  max_payload_bytes: MAX_HOST_PAYLOAD_BYTES,
  poll_wait_max_ms: 25_000,
  delivery_max_chars: 8_000
});

/** Kernel-side independent cap on the encoded IPC body (DD-HOST-202). */
const MAX_ENCODED_RUNTIME_BODY_BYTES: number = 16 * 1_048_576;

const EPHEMERAL_SESSION_LEASE_MS: number = 24 * 60 * 60 * 1_000;

const RESIDENT_SESSION_LEASE_SLACK_MS: number = 30_000;

const HOST_RUNTIME_RETENTION_MS: number = 30 * 24 * 60 * 60 * 1_000;

const ALLOWED_CLIENT_KINDS: readonly string[] = ["host_runtime", "adapter"];

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MAX_ARGUMENTS_BYTES = 1_048_576;

const MAX_CONTEXT_REF_BYTES = 512;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function asString(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function asNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function asNullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

function runtimeError(
  code: `E_${string}`,
  stage: string,
  category: "authorization" | "schema" | "source" | "conflict" | "storage" | "deadline" | "policy" | "capacity" | "internal",
  details: ErrorEnvelope["details"],
  retryable = false
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category,
    message_key: `error.${code.toLowerCase()}`,
    stage,
    details,
    retryable,
    side_effect: "none"
  });
}

function fieldError(path: string, rule: string): ErrorEnvelope {
  return runtimeError("E_SCHEMA", "host_runtime_schema", "schema", { kind: "field", path, rule });
}

function sessionError(): ErrorEnvelope {
  return runtimeError("E_HOST_RUNTIME_SESSION", "host_runtime_session", "authorization", { kind: "none" });
}

function forbiddenError(context: { readonly method: string; readonly connection_id: string }): ErrorEnvelope {
  return runtimeError("E_IPC_METHOD_UNKNOWN", "ipc_dispatch", "policy", {
    kind: "ipc",
    method: context.method,
    connection_id: context.connection_id,
    frame_kind: "request"
  });
}

function unboundError(): ErrorEnvelope {
  return runtimeError("E_HOST_RUNTIME_UNBOUND", "host_runtime_ready", "authorization", { kind: "none" });
}

function artifactError(): ErrorEnvelope {
  return runtimeError("E_HOST_RUNTIME_ARTIFACT", "host_runtime_load", "source", { kind: "none" });
}

function artifactMismatchError(): ErrorEnvelope {
  return runtimeError("E_ARTIFACT_MISMATCH", "host_runtime_ready", "source", { kind: "none" });
}

function conflictError(path: string, rule: string): ErrorEnvelope {
  return runtimeError("E_CONFLICT", "host_runtime_schema", "conflict", { kind: "field", path, rule });
}

function busyError(): ErrorEnvelope {
  return runtimeError("E_HOST_RUNTIME_BUSY", "host_runtime_poll", "capacity", { kind: "none" }, true);
}

function tooLargeError(path: string, limit: number): ErrorEnvelope {
  return runtimeError("E_EVENT_TOO_LARGE", "event_ingest", "schema", {
    kind: "field",
    path,
    rule: `max_bytes:${String(limit)}`
  });
}

function internalRuntimeError(incident: string): ErrorEnvelope {
  return runtimeError("E_INTERNAL", "host_runtime", "internal", { kind: "internal", incident_id: incident });
}

function clockOf(now: () => number): Clock {
  return {
    utcNowMs: now,
    monotonicNowMs: now,
    monotonicRemainingMs: (deadline: number): number => Math.max(0, deadline - now())
  };
}

function leaseMsFor(ephemeral: boolean, pollWaitMaxMs: number): number {
  return ephemeral
    ? EPHEMERAL_SESSION_LEASE_MS
    : 2 * pollWaitMaxMs + RESIDENT_SESSION_LEASE_SLACK_MS;
}

/** True when the pid exists; EPERM still means the process is alive. */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function clientKindAllowed(context: { readonly client_kind?: string }): boolean {
  return context.client_kind !== undefined && ALLOWED_CLIENT_KINDS.includes(context.client_kind);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Row readers                                                         */
/* ------------------------------------------------------------------ */

const SESSION_COLUMNS_BASE = `session_id, session_nonce, host_id, mode, config_space, adapter_id,
  adapter_version, implementation_hash, registration_hash, artifact_hash, config_hash,
  host_version, binary_hash, ephemeral, instance_key, native_session_id, pid, state,
  lease_expires_at, started_at, last_seen_at, closed_at, session_role`;

/**
 * Appendix M.1 adds `working_directory` in a later domain migration. Tests and
 * upgraded fixtures may still run on a schema without it, so the projection
 * degrades to a NULL column instead of failing the whole ready handshake.
 */
function tableHasColumn(
  connection: SqliteConnection,
  table: string,
  column: string
): boolean {
  try {
    const rows = connection.prepare<SqlRow>(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => row["name"] === column);
  } catch {
    return false;
  }
}

function sessionColumns(connection: SqliteConnection): string {
  return tableHasColumn(connection, "host_runtime_session", "working_directory")
    ? `${SESSION_COLUMNS_BASE}, working_directory`
    : `${SESSION_COLUMNS_BASE}, NULL AS working_directory`;
}

const CALL_COLUMNS = `call_id, kind, registration_hash, artifact_hash, host_id, mode,
  config_space, native_session_id, hook_event, boundary_event_key, goal_version,
  config_version, input_epoch, object_ref, deadline_at, state, issued_session_id,
  issued_at, result_hash, result_ref, created_at, updated_at`;

function sessionFromRow(row: SqlRow): HostRuntimeSessionRow {
  return {
    session_id: asString(row, "session_id") as Id<"rts">,
    session_nonce: asString(row, "session_nonce"),
    host_id: asString(row, "host_id") as HostId,
    mode: asString(row, "mode") as HostMode,
    config_space: asString(row, "config_space"),
    adapter_id: asString(row, "adapter_id") as Id<"adp">,
    adapter_version: asString(row, "adapter_version"),
    implementation_hash: asString(row, "implementation_hash") as Hash,
    registration_hash: asString(row, "registration_hash") as Hash,
    artifact_hash: asString(row, "artifact_hash") as Hash,
    config_hash: asString(row, "config_hash") as Hash,
    host_version: asString(row, "host_version"),
    binary_hash: asNullableString(row, "binary_hash") as Hash | null,
    ephemeral: asNumber(row, "ephemeral") === 1,
    session_role: asString(row, "session_role") === "evaluator" ? "evaluator" : "host_session",
    working_directory: asNullableString(row, "working_directory"),
    instance_key: asNullableString(row, "instance_key"),
    native_session_id: asNullableString(row, "native_session_id"),
    pid: asNumber(row, "pid"),
    state: asString(row, "state") as HostRuntimeSessionRow["state"],
    lease_expires_at: asNumber(row, "lease_expires_at"),
    started_at: asNumber(row, "started_at"),
    last_seen_at: asNumber(row, "last_seen_at"),
    closed_at: asNullableNumber(row, "closed_at")
  };
}

function callFromRow(row: SqlRow): HostRuntimeCallRow {
  const inputEpoch = asNullableNumber(row, "input_epoch");
  return {
    call_id: asString(row, "call_id"),
    kind: asString(row, "kind") as HostRuntimeCallRow["kind"],
    registration_hash: asString(row, "registration_hash") as Hash,
    artifact_hash: asString(row, "artifact_hash") as Hash,
    host_id: asString(row, "host_id") as HostId,
    mode: asString(row, "mode") as HostMode,
    config_space: asString(row, "config_space"),
    native_session_id: asNullableString(row, "native_session_id"),
    hook_event: asNullableString(row, "hook_event"),
    boundary_event_key: asNullableString(row, "boundary_event_key") as Hash | null,
    goal_version: asNullableString(row, "goal_version"),
    config_version: asNullableString(row, "config_version"),
    input_epoch: inputEpoch === null ? null : Math.trunc(inputEpoch),
    object_ref: asString(row, "object_ref"),
    deadline_at: asNumber(row, "deadline_at"),
    state: asString(row, "state") as HostRuntimeCallRow["state"],
    issued_session_id: asNullableString(row, "issued_session_id"),
    issued_at: asNullableNumber(row, "issued_at"),
    result_hash: asNullableString(row, "result_hash") as Hash | null,
    result_ref: asNullableString(row, "result_ref"),
    created_at: asNumber(row, "created_at"),
    updated_at: asNumber(row, "updated_at")
  };
}

function readSession(connection: SqliteConnection, sessionId: string): HostRuntimeSessionRow | null {
  const row = connection
    .prepare<SqlRow>(`SELECT ${sessionColumns(connection)} FROM host_runtime_session WHERE session_id = :session_id`)
    .get({ session_id: sessionId });
  return row === undefined ? null : sessionFromRow(row);
}

function readCall(connection: SqliteConnection, callId: string): HostRuntimeCallRow | null {
  const row = connection
    .prepare<SqlRow>(`SELECT ${CALL_COLUMNS} FROM host_runtime_call WHERE call_id = :call_id`)
    .get({ call_id: callId });
  return row === undefined ? null : callFromRow(row);
}

interface RegistrationRow {
  readonly registration_hash: Hash;
  readonly adapter_id: Id<"adp">;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly target_id: string;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly descriptor_hash: Hash;
  readonly artifact_ref: SourceRef;
  readonly artifact_hash: Hash;
  readonly expected_previous_hash: Hash | null;
  readonly state: string;
  readonly written_hash: Hash | null;
  readonly config_hash: Hash | null;
  readonly created_at: number;
  readonly applied_at: number | null;
}

function registrationFromRow(row: SqlRow): RegistrationRow {
  return {
    registration_hash: asString(row, "registration_hash") as Hash,
    adapter_id: asString(row, "adapter_id") as Id<"adp">,
    host_id: asString(row, "host_id") as HostId,
    mode: asString(row, "mode") as HostMode,
    config_space: asString(row, "config_space"),
    target_id: asString(row, "target_id"),
    adapter_version: asString(row, "adapter_version"),
    implementation_hash: asString(row, "implementation_hash") as Hash,
    descriptor_hash: asString(row, "descriptor_hash") as Hash,
    artifact_ref: asString(row, "artifact_ref") as SourceRef,
    artifact_hash: asString(row, "artifact_hash") as Hash,
    expected_previous_hash: asNullableString(row, "expected_previous_hash") as Hash | null,
    state: asString(row, "state"),
    written_hash: asNullableString(row, "written_hash") as Hash | null,
    config_hash: asNullableString(row, "config_hash") as Hash | null,
    created_at: asNumber(row, "created_at"),
    applied_at: asNullableNumber(row, "applied_at")
  };
}

interface DescriptorSnapshot {
  readonly descriptor_hash: Hash;
  readonly descriptor: AdapterDescriptor;
}

function readSnapshot(
  connection: SqliteConnection,
  registrationHash: string
): DescriptorSnapshot | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT descriptor_hash, descriptor_json
         FROM adapter_descriptor_snapshot
        WHERE registration_hash = :registration_hash`
    )
    .get({ registration_hash: registrationHash });
  if (row === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(asString(row, "descriptor_json"));
  } catch {
    return null;
  }
  const validated = validateAdapterDescriptor(parsed);
  if (!validated.ok) {
    return null;
  }
  return {
    descriptor_hash: asString(row, "descriptor_hash") as Hash,
    descriptor: validated.value
  };
}

function isRegistrationApplied(connection: SqliteConnection, registrationHash: string): boolean {
  const row = connection
    .prepare<SqlRow>(
      `SELECT state FROM adapter_registration WHERE registration_hash = :registration_hash`
    )
    .get({ registration_hash: registrationHash });
  return row !== undefined && asString(row, "state") === "applied";
}

/** Revokes every live session of one binding or registration. */
export function revokeHostRuntimeSessions(input: {
  readonly connection: SqliteConnection;
  readonly now: number;
  readonly registration_hash?: Hash;
  readonly host_id?: HostId;
  readonly mode?: HostMode;
  readonly config_space?: string;
}): number {
  const conditions: string[] = ["state IN ('ready','closed')"];
  const params: Record<string, string | number | null> = { now: input.now };
  if (input.registration_hash !== undefined) {
    conditions.push("registration_hash = :registration_hash");
    params["registration_hash"] = input.registration_hash;
  }
  if (input.host_id !== undefined) {
    conditions.push("host_id = :host_id");
    params["host_id"] = input.host_id;
  }
  if (input.mode !== undefined) {
    conditions.push("mode = :mode");
    params["mode"] = input.mode;
  }
  if (input.config_space !== undefined) {
    conditions.push("config_space = :config_space");
    params["config_space"] = input.config_space;
  }
  const result = input.connection
    .prepare(
      `UPDATE host_runtime_session
          SET state = 'revoked', closed_at = :now
        WHERE ${conditions.join(" AND ")}`
    )
    .run(params);
  return result.changes;
}

/* ------------------------------------------------------------------ */
/* Session lease / call expiry housekeeping                             */
/* ------------------------------------------------------------------ */

interface HostRuntimeSweepReport {
  readonly failed_sessions: number;
  readonly expired_calls: number;
  readonly uncertain_calls: number;
  readonly deleted_sessions: number;
  readonly deleted_calls: number;
  readonly deleted_uploads: number;
}

/**
 * Startup and `maintenance.gc` sweep: expire leases and calls, then retain the
 * documented 30-day runtime state. It never re-sends a delivery.
 */
export function sweepHostRuntime(input: {
  readonly connection: SqliteConnection;
  readonly now: number;
  readonly retention_ms?: number;
  readonly upload_retention_ms?: number;
  /**
   * Appendix Q.2: a host process that is still alive but idle must not lose
   * its session to lease expiry. When supplied, an expired session whose pid
   * is alive is refreshed instead of failed.
   */
  readonly process_alive?: (pid: number) => boolean;
}): HostRuntimeSweepReport {
  const retention = input.retention_ms ?? HOST_RUNTIME_RETENTION_MS;
  const uploadRetention = input.upload_retention_ms ?? HOST_RUNTIME_RETENTION_MS;
  const cutoff = input.now - retention;
  const uploadCutoff = input.now - uploadRetention;
  const connection = input.connection;

  if (input.process_alive !== undefined) {
    const expiredReady = connection
      .prepare<SqlRow>(
        `SELECT session_id, pid FROM host_runtime_session
          WHERE state = 'ready' AND lease_expires_at <= :now AND pid IS NOT NULL`
      )
      .all({ now: input.now });
    for (const row of expiredReady) {
      const pid = row["pid"];
      const sessionId = row["session_id"];
      if (
        typeof pid === "number" && typeof sessionId === "string" &&
        input.process_alive(pid)
      ) {
        connection
          .prepare("UPDATE host_runtime_session SET lease_expires_at = :lease WHERE session_id = :id")
          .run({ lease: input.now + 80_000, id: sessionId });
      }
    }
  }

  const failed = connection
    .prepare(
      `UPDATE host_runtime_session
          SET state = 'failed', closed_at = :now
        WHERE state = 'ready' AND lease_expires_at <= :now`
    )
    .run({ now: input.now });
  const expired = connection
    .prepare(
      `UPDATE host_runtime_call
          SET state = 'expired', updated_at = :now
        WHERE state = 'pending' AND deadline_at <= :now`
    )
    .run({ now: input.now });
  const uncertain = connection
    .prepare(
      `UPDATE host_runtime_call
          SET state = 'uncertain', updated_at = :now
        WHERE state = 'issued' AND deadline_at <= :now`
    )
    .run({ now: input.now });
  const deletedSessions = connection
    .prepare(
      `DELETE FROM host_runtime_session
        WHERE state IN ('revoked','closed','failed') AND last_seen_at <= :cutoff`
    )
    .run({ cutoff });
  const deletedCalls = connection
    .prepare(
      `DELETE FROM host_runtime_call
        WHERE state IN ('completed','expired','uncertain') AND updated_at <= :cutoff`
    )
    .run({ cutoff });
  const deletedUploads = connection
    .prepare("DELETE FROM host_runtime_upload WHERE created_at <= :cutoff")
    .run({ cutoff: uploadCutoff });

  return {
    failed_sessions: failed.changes,
    expired_calls: expired.changes,
    uncertain_calls: uncertain.changes,
    deleted_sessions: deletedSessions.changes,
    deleted_calls: deletedCalls.changes,
    deleted_uploads: deletedUploads.changes
  };
}

/* ------------------------------------------------------------------ */
/* Payload store (blob fsync + `blob` projection)                       */
/* ------------------------------------------------------------------ */

function decodeContent(
  content: ContentUpload
): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false } {
  if (
    (content.media_type !== "text/plain;charset=utf-8" &&
      content.media_type !== "application/json" &&
      content.media_type !== "application/octet-stream") ||
    (content.encoding !== "utf8" && content.encoding !== "base64") ||
    typeof content.data !== "string" ||
    !isPositiveInt(content.byte_length) ||
    content.byte_length > MAX_HOST_PAYLOAD_BYTES
  ) {
    return { ok: false };
  }
  let bytes: Uint8Array;
  if (content.encoding === "base64") {
    if (!BASE64_PATTERN.test(content.data)) {
      return { ok: false };
    }
    bytes = Uint8Array.from(Buffer.from(content.data, "base64"));
  } else {
    if (!isWellFormedUnicode(content.data)) {
      return { ok: false };
    }
    bytes = new TextEncoder().encode(content.data);
  }
  if (bytes.byteLength !== content.byte_length) {
    return { ok: false };
  }
  return { ok: true, bytes };
}

function createPayloadStore(deps: HostRuntimeServiceDeps): Pick<HostPayloadStorePort, "put"> {
  return {
    async put(
      content: ContentUpload
    ): Promise<Result<{ content_ref: SourceRef; content_hash: Hash; byte_length: number }, ErrorEnvelope>> {
      const decoded = decodeContent(content);
      if (!decoded.ok) {
        return err(fieldError("upload.payload", "content_upload"));
      }
      const stored = deps.blob_store.putSync(decoded.bytes);
      if (!stored.ok) {
        return stored;
      }
      const at = deps.now();
      deps.connection
        .prepare(
          `INSERT INTO blob (
             blob_hash, byte_length, relative_path, state, verified_at, created_at,
             deleted_at, deletion_reason
           ) VALUES (
             :blob_hash, :byte_length, :relative_path, 'present', :now, :now, NULL, NULL
           )
           ON CONFLICT(blob_hash) DO UPDATE SET
             state = 'present',
             verified_at = excluded.verified_at,
             deleted_at = NULL,
             deletion_reason = NULL`
        )
        .run({
          blob_hash: stored.value.hash,
          byte_length: stored.value.byte_length,
          relative_path: stored.value.relative_path,
          now: at
        });
      return ok({
        content_ref: `blob://${stored.value.hash}#bytes=0-${String(stored.value.byte_length)}` as SourceRef,
        content_hash: stored.value.hash,
        byte_length: stored.value.byte_length
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Payload -> normalized draft -> EventDraft                            */
/* ------------------------------------------------------------------ */

function sourceEnvelope(
  code: "E_EVIDENCE_UNKNOWN" | "E_CONFLICT" | "E_SCHEMA" | "E_IO",
  stage: string,
  details: ErrorEnvelope["details"]
): ErrorEnvelope {
  const category =
    code === "E_EVIDENCE_UNKNOWN" ? "source" : code === "E_IO" ? "storage" : code === "E_CONFLICT" ? "conflict" : "schema";
  return runtimeError(code, stage, category, details, code === "E_IO");
}

function adapterEnvelope(error: HostAdapterError, stage: string): ErrorEnvelope {
  switch (error.code) {
    case "E_SCHEMA":
      return runtimeError("E_SCHEMA", stage, "schema", {
        kind: "field",
        path: "payload",
        rule: "adapter_schema"
      });
    case "E_CONFLICT":
      return runtimeError("E_CONFLICT", stage, "conflict", {
        kind: "field",
        path: "payload",
        rule: "adapter_conflict"
      });
    case "E_EVIDENCE_UNKNOWN":
    case "E_UNSUPPORTED":
      return sourceEnvelope("E_EVIDENCE_UNKNOWN", stage, { kind: "source_unretrievable", source_ref: error.detail_ref, upstream_code: error.code });
    case "E_DEADLINE_EXCEEDED":
      return runtimeError("E_DEADLINE_EXCEEDED", stage, "deadline", { kind: "none" }, true);
    case "E_CANCELLED":
      return runtimeError("E_CANCELLED", stage, "deadline", { kind: "none" });
    case "E_CAPABILITY":
      return runtimeError("E_EVIDENCE_UNKNOWN", stage, "source", { kind: "source_unretrievable", source_ref: error.detail_ref, upstream_code: error.code });
    case "E_HOST_REJECTED":
      return runtimeError("E_CONFLICT", stage, "conflict", { kind: "field", path: "upload", rule: "host_rejected" });
    case "E_AUTH_UNAVAILABLE":
      return runtimeError("E_AUTH_UNAVAILABLE", stage, "authorization", { kind: "none" });
    case "E_IO":
    case "E_INTERNAL":
      return runtimeError("E_IO", stage, "storage", { kind: "none" }, error.retryable);
  }
}

function contentUploadError(ref: SourceRef, reason: "unretrievable" | "hash" | "utf8" | "too_large"): ErrorEnvelope {
  if (reason === "unretrievable") {
    return runtimeError("E_EVIDENCE_UNKNOWN", "host_event_draft_map", "source", {
      kind: "source_unretrievable",
      source_ref: ref,
      upstream_code: "missing"
    });
  }
  if (reason === "hash") {
    return runtimeError("E_CONFLICT", "host_event_draft_map", "conflict", {
      kind: "source_conflict",
      source_ref: ref,
      expected: "blob_hash",
      actual: "content_version"
    });
  }
  if (reason === "too_large") {
    return runtimeError("E_SCHEMA", "host_event_draft_map", "schema", {
      kind: "field",
      path: "text_ref",
      rule: "too_large"
    });
  }
  return runtimeError("E_SCHEMA", "host_event_draft_map", "schema", {
    kind: "field",
    path: "text_ref",
    rule: "utf8"
  });
}

async function resolveContentRef(
  deps: HostRuntimeServiceDeps,
  ref: SourceRef
): Promise<Result<{ media_type: "text/plain;charset=utf-8"; encoding: "utf8"; data: string; byte_length: number }, ErrorEnvelope>> {
  const resolved = await deps.source_refs.resolve(ref, { maxBytes: MAX_HOST_PAYLOAD_BYTES });
  if (!resolved.ok) {
    return resolved;
  }
  const value = resolved.value;
  if (!value.retrievable || value.bytes === null) {
    return err(contentUploadError(ref, "unretrievable"));
  }
  if (value.bytes.byteLength > MAX_HOST_PAYLOAD_BYTES) {
    return err(contentUploadError(ref, "too_large"));
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
  } catch {
    return err(contentUploadError(ref, "utf8"));
  }
  if (new TextEncoder().encode(text).byteLength !== value.bytes.byteLength) {
    return err(contentUploadError(ref, "utf8"));
  }
  return ok({
    media_type: "text/plain;charset=utf-8",
    encoding: "utf8",
    data: text,
    byte_length: value.bytes.byteLength
  });
}

async function resolveJsonArgumentsRef(
  deps: HostRuntimeServiceDeps,
  ref: SourceRef
): Promise<Result<JsonValue, ErrorEnvelope>> {
  const resolved = await deps.source_refs.resolve(ref, { maxBytes: MAX_ARGUMENTS_BYTES });
  if (!resolved.ok) {
    return resolved;
  }
  const value = resolved.value;
  if (!value.retrievable || value.bytes === null) {
    return err(contentUploadError(ref, "unretrievable"));
  }
  if (value.bytes.byteLength > MAX_ARGUMENTS_BYTES) {
    return err(contentUploadError(ref, "too_large"));
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
  } catch {
    return err(contentUploadError(ref, "utf8"));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(contentUploadError(ref, "utf8"));
  }
  if (!isJsonValue(parsed)) {
    return err(contentUploadError(ref, "utf8"));
  }
  return ok(parsed);
}

interface ResolvedOrigin {
  readonly origin: "human" | "user" | "agent" | "evaluator" | "system" | "host" | "unknown";
  readonly origin_basis: "host_typed_field" | "host_tui_session" | "host_capability" | "explicit_event" | "inferred_from_agent" | "unavailable";
  readonly trigger_lineage: { readonly axis: "external" | "internal_evaluator" | "internal_review" | "unknown"; readonly root_event_id: string | null; readonly depth: number };
}

/**
 * DD-TRG-004 fixed mapping. Human origin needs a verifiable
 * `HumanAttestation`; runtime uploads carry none, so `human` and evaluator
 * roots (which need the generation registry) fail closed as
 * `E_ORIGIN_UNRESOLVED`.
 */
/**
 * Appendix H.3: probe sessions are marked by `host_runtime_session.ephemeral`.
 * Their events stay in the stream (probe evidence depends on the upload link)
 * but every downstream consumer that produces review signals, TaskOutcome or a
 * confirmation slot suppresses them; see `probe-session.ts`.
 */
function resolveOrigin(draft: NormalizedHostEventDraft): ResolvedOrigin | null {
  switch (draft.origin_hint) {
    case "human":
      return null;
    case "host_auto":
      return {
        origin: "host",
        origin_basis: "host_capability",
        trigger_lineage: { axis: "external", root_event_id: null, depth: 0 }
      };
    case "evaluator":
    case "evaluator_descendant":
      return null;
    case "unknown": {
      if (draft.attribution.typed_user_message && draft.input_source_label !== undefined) {
        // Appendix L.2: a command-line TUI judgement is recorded as its own,
        // weaker basis. Anything read from a host-written typed field keeps
        // `host_typed_field`.
        return {
          origin: "user",
          origin_basis:
            draft.input_source_label === "host_process.interactive_tui"
              ? "host_tui_session"
              : draft.input_source_label.startsWith("host_capability.")
                ? "host_capability"
                : "host_typed_field",
          trigger_lineage: { axis: "external", root_event_id: null, depth: 0 }
        };
      }
      return {
        origin: "unknown",
        origin_basis: "unavailable",
        trigger_lineage: { axis: "unknown", root_event_id: null, depth: 0 }
      };
    }
  }
}

function makeRejection(input: {
  readonly phase: "A" | "B";
  readonly reason: HostEventRejection["reason"];
  readonly field: string;
  readonly now: number;
  readonly rawEventRef?: SourceRef;
  readonly binding?: HostEventBindingDraftLike;
}): HostEventRejection {
  if (input.phase === "A") {
    return buildHostEventRejection({
      rejection_id: newId("ipc"),
      phase: "A",
      raw_event_ref: null,
      host_binding: null,
      reason: input.reason,
      field: input.field,
      detail_ref: null,
      created_at: input.now
    });
  }
  const rawRef = input.rawEventRef;
  const binding = input.binding;
  if (rawRef === undefined || binding === undefined) {
    throw new Error("phase B rejection requires a raw ref and host binding");
  }
  return buildHostEventRejection({
    rejection_id: newId("ipc"),
    phase: "B",
    raw_event_ref: rawRef,
    host_binding: binding,
    reason: input.reason,
    field: input.field,
    detail_ref: rawRef,
    created_at: input.now
  });
}

type HostEventBindingDraftLike = NormalizedHostEventDraft["host_binding"];

/**
 * `host_runtime_upload.session_id` is the authenticated session that delivered
 * the upload. It is added by the host migration track; older databases are
 * still readable, in which case uploads carry no session link and a kernel
 * observer must not treat them as probe evidence.
 */
const UPLOAD_SESSION_COLUMN = new WeakMap<SqliteConnection, boolean>();

function uploadHasSessionColumn(connection: SqliteConnection): boolean {
  const cached = UPLOAD_SESSION_COLUMN.get(connection);
  if (cached !== undefined) {
    return cached;
  }
  let present = false;
  try {
    const columns = connection.prepare<SqlRow>("PRAGMA table_info(host_runtime_upload)").all();
    present = columns.some((row) => row["name"] === "session_id");
  } catch {
    present = false;
  }
  UPLOAD_SESSION_COLUMN.set(connection, present);
  return present;
}

/* ------------------------------------------------------------------ */
/* Upload host-core path                                               */
/* ------------------------------------------------------------------ */

interface UploadContext {
  readonly upload: RawHostEventUpload;
  readonly session: HostRuntimeSessionRow;
  readonly registration: RegistrationRow;
  readonly active: ActiveAdapterRegistration;
  readonly adapter: HostRuntimeAdapter;
}

function validateNativeIds(value: unknown): value is RawHostEventUpload["native_ids"] {
  if (!isRecord(value)) {
    return false;
  }
  const allowed = new Set([
    "session_id",
    "turn_id",
    "message_id",
    "event_id",
    "tool_call_id",
    "parent_tool_call_id",
    "injection_message_id",
    "persisted_message_id"
  ]);
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) {
      return false;
    }
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512) {
      return false;
    }
  }
  return true;
}

function validateContextRef(value: unknown): value is string | undefined {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONTEXT_REF_BYTES) {
    return false;
  }
  return !value.includes("\u0000") && !value.includes("..") && !value.startsWith("/");
}

function parseUploadRequest(
  params: unknown
): Result<HostRuntimeUploadRequest, ErrorEnvelope> {
  if (!isRecord(params)) {
    return err(fieldError("params", "must_be_object"));
  }
  if (params["schema_version"] !== "rsi.host_runtime_upload/1") {
    return err(fieldError("schema_version", "const"));
  }
  const sessionId = params["session_id"];
  if (typeof sessionId !== "string" || !isId(sessionId, "rts")) {
    return err(fieldError("session_id", "rts_id"));
  }
  const nonce = params["session_nonce"];
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256) {
    return err(fieldError("session_nonce", "non_empty_string"));
  }
  const uploadValue = params["upload"];
  if (!isRecord(uploadValue)) {
    return err(fieldError("upload", "must_be_object"));
  }
  if (uploadValue["schema_version"] !== "rsi.raw_host_event_upload/1") {
    return err(fieldError("upload.schema_version", "const"));
  }
  const rawEventId = uploadValue["raw_event_id"];
  if (typeof rawEventId !== "string" || rawEventId.length === 0 || rawEventId.length > 512 || rawEventId.includes("\u0000")) {
    return err(fieldError("upload.raw_event_id", "opaque_id"));
  }
  const adapterId = uploadValue["adapter_id"];
  if (typeof adapterId !== "string" || !isId(adapterId, "adp")) {
    return err(fieldError("upload.adapter_id", "adp_id"));
  }
  const hostId = uploadValue["host_id"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return err(fieldError("upload.host_id", "host_id"));
  }
  const mode = uploadValue["mode"];
  if (typeof mode !== "string" || !isHostMode(mode)) {
    return err(fieldError("upload.mode", "host_mode"));
  }
  const configSpace = uploadValue["config_space"];
  if (typeof configSpace !== "string" || configSpace.length === 0) {
    return err(fieldError("upload.config_space", "non_empty_string"));
  }
  const hostEvent = uploadValue["host_event"];
  if (typeof hostEvent !== "string" || hostEvent.length === 0 || hostEvent.length > 128) {
    return err(fieldError("upload.host_event", "non_empty_string"));
  }
  const receivedAt = uploadValue["received_at"];
  if (!isEpochMs(receivedAt)) {
    return err(fieldError("upload.received_at", "epoch_ms"));
  }
  const payloadHash = uploadValue["payload_hash"];
  if (typeof payloadHash !== "string" || !isHash(payloadHash)) {
    return err(fieldError("upload.payload_hash", "hash"));
  }
  const payload = uploadValue["payload"];
  if (!isRecord(payload)) {
    return err(fieldError("upload.payload", "must_be_object"));
  }
  if (
    (payload["media_type"] !== "text/plain;charset=utf-8" &&
      payload["media_type"] !== "application/json" &&
      payload["media_type"] !== "application/octet-stream") ||
    (payload["encoding"] !== "utf8" && payload["encoding"] !== "base64") ||
    typeof payload["data"] !== "string" ||
    !isPositiveInt(payload["byte_length"])
  ) {
    return err(fieldError("upload.payload", "content_upload"));
  }
  if (!validateNativeIds(uploadValue["native_ids"])) {
    return err(fieldError("upload.native_ids", "native_ids"));
  }
  if (!validateContextRef(uploadValue["adapter_context_ref"])) {
    return err(fieldError("upload.adapter_context_ref", "opaque_ref"));
  }
  const upload: RawHostEventUpload = {
    schema_version: "rsi.raw_host_event_upload/1",
    raw_event_id: rawEventId,
    adapter_id: adapterId,
    host_id: hostId,
    mode,
    config_space: configSpace,
    host_event: hostEvent,
    received_at: receivedAt,
    payload: {
      media_type: payload["media_type"] as ContentUpload["media_type"],
      encoding: payload["encoding"] as ContentUpload["encoding"],
      data: payload["data"] as string,
      byte_length: payload["byte_length"] as number
    },
    payload_hash: payloadHash,
    native_ids: uploadValue["native_ids"] as RawHostEventUpload["native_ids"],
    ...(uploadValue["adapter_context_ref"] === undefined
      ? {}
      : { adapter_context_ref: uploadValue["adapter_context_ref"] as string })
  };
  return ok({ schema_version: "rsi.host_runtime_upload/1", session_id: sessionId as Id<"rts">, session_nonce: nonce, upload });
}

function encodeSize(data: string): number {
  return Buffer.byteLength(data, "utf8");
}

async function runHostCorePath(
  deps: HostRuntimeServiceDeps,
  context: UploadContext,
  scopeClaim: StableEventScope | undefined,
  remainingMs: number
): Promise<Result<HostRuntimeUploadResult, ErrorEnvelope>> {
  const { upload, session, registration, active, adapter } = context;
  const now = deps.now();

  const peer = {
    adapter_id: session.adapter_id,
    adapter_version: session.adapter_version,
    implementation_hash: session.implementation_hash,
    host_id: session.host_id,
    mode: session.mode,
    config_space: session.config_space,
    descriptor_hash: registration.descriptor_hash,
    registration_hash: session.registration_hash
  } as const;

  const admission = admitPhaseA({
    peer,
    registration: active,
    snapshot_descriptor_hash: registration.descriptor_hash,
    upload,
    ...(scopeClaim === undefined ? {} : { scope_claim: scopeClaim })
  });
  if (!admission.ok) {
    return ok({
      state: "rejected",
      receipt: null,
      rejection: makeRejection({ phase: "A", reason: admission.reason, field: admission.field, now })
    });
  }

  const resolvedPayload = await resolveHostPayload(
    upload.payload,
    {
      host_id: upload.host_id,
      config_space: upload.config_space,
      raw_event_id: upload.raw_event_id,
      payload_hash: upload.payload_hash
    },
    {
      store: createPayloadStore(deps),
      sourceRefs: deps.source_refs,
      clock: clockOf(deps.now)
    },
    Math.max(1, remainingMs)
  );
  if (!resolvedPayload.ok) {
    return err(adapterEnvelope(resolvedPayload.error, "host_payload_resolve"));
  }
  const resolved: ResolvedHostPayload = resolvedPayload.value;
  if (!Object.isFrozen(resolved)) {
    return err(internalRuntimeError("kernel.host_runtime_payload_not_frozen"));
  }
  if (hashBytes(resolved.bytes) !== resolved.payload_hash) {
    return err(conflictError("upload.payload", "payload_mutated"));
  }

  const raw: RawHostEvent = {
    raw_event_id: upload.raw_event_id,
    adapter_id: upload.adapter_id,
    host_id: upload.host_id,
    mode: upload.mode,
    config_space: upload.config_space,
    host_event: upload.host_event,
    received_at: upload.received_at,
    payload_ref: resolved.canonical_ref,
    payload_hash: resolved.payload_hash,
    native_ids: upload.native_ids,
    ...(upload.adapter_context_ref === undefined ? {} : { adapter_context_ref: upload.adapter_context_ref }),
    registration: active
  };

  const normalized = adapter.normalizeEvent({
    schema_version: "rsi.normalize_host_event_input/1",
    raw,
    payload: resolved
  });
  if (!normalized.ok) {
    return err(adapterEnvelope(normalized.error, "host_event_normalize"));
  }
  const draft = normalized.value;

  if (!draftMatchesContract(draft, admission.contract)) {
    return ok({
      state: "rejected",
      receipt: null,
      rejection: makeRejection({
        phase: "B",
        reason: "E_EVENT_POST_NORMALIZE_MISMATCH",
        field: "draft",
        now,
        rawEventRef: resolved.canonical_ref,
        binding: draft.host_binding
      })
    });
  }
  if (!draftBindingMatchesRaw(draft, raw)) {
    return ok({
      state: "rejected",
      receipt: null,
      rejection: makeRejection({
        phase: "B",
        reason: "E_EVENT_IDENTITY_MISMATCH",
        field: "host_binding",
        now,
        rawEventRef: resolved.canonical_ref,
        binding: draft.host_binding
      })
    });
  }

  const sourceSeq = selectSourceSeq({
    ...(draft.host_binding.native_message_id === undefined
      ? {}
      : { native_message_id: draft.host_binding.native_message_id }),
    ...(draft.host_binding.source_seq_hint === undefined
      ? {}
      : { source_seq_hint: draft.host_binding.source_seq_hint })
  });
  if (!sourceSeq.ok) {
    return ok({
      state: "rejected",
      receipt: null,
      rejection: makeRejection({
        phase: "B",
        reason: "E_EVENT_IDENTITY_MISMATCH",
        field: "source_seq_hint",
        now,
        rawEventRef: resolved.canonical_ref,
        binding: draft.host_binding
      })
    });
  }

  const finalized = finalizeNormalizedHostEvent({
    draft,
    normalized_id: newId("nev"),
    raw_event_ref: resolved.canonical_ref,
    payload_hash: resolved.payload_hash,
    normalized_at: now,
    source_seq: sourceSeq.source_seq,
    receipt_seq: 0,
    ...(scopeClaim === undefined ? {} : { event_scope: scopeClaim }),
    payload_retrievable: true
  });
  if (!finalized.ok) {
    return ok({
      state: "rejected",
      receipt: null,
      rejection: makeRejection({
        phase: "B",
        reason: finalized.reason,
        field: "draft",
        now,
        rawEventRef: resolved.canonical_ref,
        binding: draft.host_binding
      })
    });
  }

  const origin = resolveOrigin(draft);
  if (origin === null) {
    return ok({
      state: "rejected",
      receipt: null,
      rejection: makeRejection({
        phase: "B",
        reason: "E_ORIGIN_UNRESOLVED",
        field: "origin_hint",
        now,
        rawEventRef: resolved.canonical_ref,
        binding: draft.host_binding
      })
    });
  }

  const mapped = await normalizeToEventDraft({
    event:
      origin.origin === "unknown"
        ? {
            ...finalized.event,
            attribution: {
              ...finalized.event.attribution,
              sender: "unknown",
              typed_user_message: false
            }
          }
        : finalized.event,
    origin,
    resolvers: {
      resolveContent: (ref: SourceRef) => resolveContentRef(deps, ref),
      resolveJsonArguments: (ref: SourceRef) => resolveJsonArgumentsRef(deps, ref)
    }
  });
  if (!mapped.ok) {
    return mapped;
  }

  const receipt = await deps.ingest(mapped.value);
  if (!receipt.ok) {
    return receipt;
  }
  const state = receipt.value.duplicate ? "duplicate" : "ingested";
  return ok({
    state,
    receipt: receipt.value,
    rejection: null
  });
}

/* ------------------------------------------------------------------ */
/* RuntimeCall bounding                                                 */
/* ------------------------------------------------------------------ */

function sliceCodePoints(text: string, maxChars: number): string {
  if (maxChars < 0) {
    return "";
  }
  const points = Array.from(text);
  return points.length <= maxChars ? text : points.slice(0, maxChars).join("");
}

function boundCall(call: RuntimeCallType, row: HostRuntimeCallRow, now: number, maxChars: number): RuntimeCallType {
  const deadlineMs = Math.max(0, row.deadline_at - now);
  if (call.kind !== "deliver") {
    return { ...call, deadline_ms: Math.min(call.deadline_ms, deadlineMs) };
  }
  const text = sliceCodePoints(call.content.text, maxChars);
  const bytes = new TextEncoder().encode(text);
  return {
    ...call,
    deadline_ms: Math.min(call.deadline_ms, deadlineMs),
    content: {
      media_type: "text/plain;charset=utf-8",
      text,
      content_hash: hashBytes(bytes),
      byte_length: bytes.byteLength
    }
  };
}

/* ------------------------------------------------------------------ */
/* Request validators                                                  */
/* ------------------------------------------------------------------ */

function parseReadyRequest(params: unknown): Result<HostRuntimeReadyRequest, ErrorEnvelope> {
  if (!isRecord(params)) {
    return err(fieldError("params", "must_be_object"));
  }
  if (params["schema_version"] !== "rsi.host_runtime_ready/1") {
    return err(fieldError("schema_version", "const"));
  }
  const hashFields = [
    "registration_hash",
    "implementation_hash",
    "artifact_hash",
    "config_hash",
    "load_verified_hash"
  ] as const;
  for (const field of hashFields) {
    const value = params[field];
    if (typeof value !== "string" || !isHash(value)) {
      return err(fieldError(field, "hash"));
    }
  }
  const hostId = params["host_id"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return err(fieldError("host_id", "host_id"));
  }
  const mode = params["mode"];
  if (typeof mode !== "string" || !isHostMode(mode)) {
    return err(fieldError("mode", "host_mode"));
  }
  const configSpace = params["config_space"];
  if (typeof configSpace !== "string" || configSpace.length === 0) {
    return err(fieldError("config_space", "non_empty_string"));
  }
  const adapterId = params["adapter_id"];
  if (typeof adapterId !== "string" || !isId(adapterId, "adp")) {
    return err(fieldError("adapter_id", "adp_id"));
  }
  const adapterVersion = params["adapter_version"];
  if (typeof adapterVersion !== "string" || adapterVersion.length === 0) {
    return err(fieldError("adapter_version", "non_empty_string"));
  }
  const hostVersion = params["host_version"];
  if (typeof hostVersion !== "string" || hostVersion.length === 0 || hostVersion.length > 128) {
    return err(fieldError("host_version", "non_empty_string"));
  }
  const binaryHash = params["binary_hash"];
  if (binaryHash !== null && (typeof binaryHash !== "string" || !isHash(binaryHash))) {
    return err(fieldError("binary_hash", "hash_or_null"));
  }
  const ephemeral = params["ephemeral"];
  if (typeof ephemeral !== "boolean") {
    return err(fieldError("ephemeral", "boolean"));
  }
  const rawSessionRole = params["session_role"];
  if (
    rawSessionRole !== undefined &&
    rawSessionRole !== "evaluator" &&
    rawSessionRole !== "host_session"
  ) {
    return err(fieldError("session_role", "session_role"));
  }
  // Appendix L.1. Older artifacts do not send the field; keep their behaviour
  // (an ephemeral session was a probe) so an upgrade never reclassifies live
  // traffic. New one-shot hosts send `host_session` explicitly.
  const sessionRole: "evaluator" | "host_session" =
    rawSessionRole ?? (ephemeral ? "evaluator" : "host_session");
  if (sessionRole === "evaluator" && !ephemeral) {
    return err(fieldError("session_role", "evaluator_requires_ephemeral"));
  }
  // Appendix M.1. Optional: an older artifact never sends it and keeps a
  // task without a project binding.
  const rawWorkingDirectory = params["working_directory"];
  if (
    rawWorkingDirectory !== undefined &&
    rawWorkingDirectory !== null &&
    (typeof rawWorkingDirectory !== "string" ||
      rawWorkingDirectory.length === 0 ||
      rawWorkingDirectory.length > 4096)
  ) {
    return err(fieldError("working_directory", "path_or_null"));
  }
  const workingDirectory =
    typeof rawWorkingDirectory === "string" ? rawWorkingDirectory : null;
  const instanceKey = params["instance_key"];
  if (ephemeral) {
    if (typeof instanceKey !== "string" || instanceKey.length === 0 || instanceKey.length > 512) {
      return err(fieldError("instance_key", "required_for_ephemeral"));
    }
  } else if (instanceKey !== null) {
    return err(fieldError("instance_key", "null_for_resident"));
  }
  const pid = params["pid"];
  if (!isPositiveInt(pid)) {
    return err(fieldError("pid", "positive_int"));
  }
  const startedAt = params["started_at"];
  if (!isEpochMs(startedAt)) {
    return err(fieldError("started_at", "epoch_ms"));
  }
  return ok({
    schema_version: "rsi.host_runtime_ready/1",
    registration_hash: params["registration_hash"] as Hash,
    host_id: hostId,
    mode,
    config_space: configSpace,
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    implementation_hash: params["implementation_hash"] as Hash,
    artifact_hash: params["artifact_hash"] as Hash,
    config_hash: params["config_hash"] as Hash,
    load_verified_hash: params["load_verified_hash"] as Hash,
    host_version: hostVersion,
    binary_hash: binaryHash as Hash | null,
    ephemeral,
    session_role: sessionRole,
    working_directory: workingDirectory,
    instance_key: instanceKey as string | null,
    pid,
    started_at: startedAt
  });
}

function parsePollRequest(params: unknown): Result<HostRuntimePollRequest, ErrorEnvelope> {
  if (!isRecord(params)) {
    return err(fieldError("params", "must_be_object"));
  }
  if (params["schema_version"] !== "rsi.host_runtime_poll/1") {
    return err(fieldError("schema_version", "const"));
  }
  const sessionId = params["session_id"];
  if (typeof sessionId !== "string" || !isId(sessionId, "rts")) {
    return err(fieldError("session_id", "rts_id"));
  }
  const nonce = params["session_nonce"];
  if (typeof nonce !== "string" || nonce.length === 0) {
    return err(fieldError("session_nonce", "non_empty_string"));
  }
  const waitMs = params["wait_ms"];
  if (!isEpochMs(waitMs)) {
    return err(fieldError("wait_ms", "non_negative_int"));
  }
  const hookEvent = params["hook_event"];
  if (hookEvent !== null && typeof hookEvent !== "string") {
    return err(fieldError("hook_event", "string_or_null"));
  }
  const eventIdentityKey = params["event_identity_key"];
  if (eventIdentityKey !== null && (typeof eventIdentityKey !== "string" || !isHash(eventIdentityKey))) {
    return err(fieldError("event_identity_key", "hash_or_null"));
  }
  return ok({
    schema_version: "rsi.host_runtime_poll/1",
    session_id: sessionId as Id<"rts">,
    session_nonce: nonce,
    wait_ms: waitMs,
    hook_event: hookEvent as string | null,
    event_identity_key: eventIdentityKey as Hash | null
  });
}

function isHostAdapterErrorShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["code"] === "string" &&
    typeof value["retryable"] === "boolean" &&
    typeof value["detail_ref"] === "string" &&
    isEpochMs(value["observed_at"])
  );
}

const RUNTIME_PROBE_ACTIONS: ReadonlySet<string> = new Set([
  "read_only",
  "read_capacity_window",
  "read_service_profile",
  "confirm_control_plane",
  "confirm_human_event",
  "confirm_human_setup",
  "confirm_candidate"
]);

/**
 * runtime/1 probes are limited to read-only capabilities observed from hooks
 * (DD-HOST-206). Capacity/service-profile readings and confirmations belong to
 * host-core or runtime/2 producers.
 *
 * Exported so the W1 probe producer requests exactly the set the result gate
 * accepts instead of duplicating the list.
 */
export const RUNTIME_PROBE_CAPABILITIES: ReadonlySet<CapabilityName> = new Set([
  "input_capture",
  "stable_boundary",
  "compaction_event",
  "association"
]);

const PROBE_OBSERVATION_KEYS: ReadonlySet<string> = new Set([
  "probe_id",
  "probe_action",
  "binding_key",
  "observed",
  "claimed_evidence_stage",
  "claimed_status",
  "checked_at",
  "evidence_refs"
]);

const CHECK_LOAD_RESULT_KEYS: ReadonlySet<string> = new Set([
  "request_id",
  "state",
  "observed_hash",
  "evidence_refs",
  "readback_ref"
]);

const PROBE_RESULT_KEYS: ReadonlySet<string> = new Set(["kind", "state", "observation"]);
const CHECK_LOAD_RESULT_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["kind", "state", "result"]);

const CLAIMED_EVIDENCE_STAGES: ReadonlySet<string> = new Set([
  "none",
  "static",
  "loaded",
  "roundtrip"
]);

const CLAIMED_STATUSES: ReadonlySet<string> = new Set([
  "unknown",
  "verified",
  "unsupported",
  "failed"
]);

const CHECK_LOAD_STATES: ReadonlySet<string> = new Set([
  "loaded",
  "pending",
  "not_loaded",
  "unknown",
  "conflict"
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSourceRefArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && isSourceRef(entry));
}

function isValidProbeObservation(value: unknown): value is import("@evoplug/core/host").HostProbeObservation {
  if (!isRecord(value) || !hasOnlyKeys(value, PROBE_OBSERVATION_KEYS)) {
    return false;
  }
  const claimedStage = value["claimed_evidence_stage"];
  const claimedStatus = value["claimed_status"];
  return (
    typeof value["probe_id"] === "string" &&
    isId(value["probe_id"], "prb") &&
    typeof value["probe_action"] === "string" &&
    RUNTIME_PROBE_ACTIONS.has(value["probe_action"]) &&
    typeof value["binding_key"] === "string" &&
    isHash(value["binding_key"]) &&
    isJsonValue(value["observed"]) &&
    (claimedStage === undefined ||
      (typeof claimedStage === "string" && CLAIMED_EVIDENCE_STAGES.has(claimedStage))) &&
    (claimedStatus === undefined ||
      (typeof claimedStatus === "string" && CLAIMED_STATUSES.has(claimedStatus))) &&
    isEpochMs(value["checked_at"]) &&
    isSourceRefArray(value["evidence_refs"])
  );
}

function isValidLoadCheckResultShape(value: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(value, CHECK_LOAD_RESULT_KEYS)) {
    return false;
  }
  const observedHash = value["observed_hash"];
  const readbackRef = value["readback_ref"];
  return (
    typeof value["request_id"] === "string" &&
    value["request_id"].length > 0 &&
    value["request_id"].length <= 128 &&
    typeof value["state"] === "string" &&
    CHECK_LOAD_STATES.has(value["state"]) &&
    (observedHash === undefined || (typeof observedHash === "string" && isHash(observedHash))) &&
    isSourceRefArray(value["evidence_refs"]) &&
    (readbackRef === undefined ||
      (typeof readbackRef === "string" && isSourceRef(readbackRef)))
  );
}

function isValidRuntimeCallResult(value: unknown): value is RuntimeCallResult {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["kind"]) {
    case "deliver": {
      if (value["state"] === "not_injected") {
        return value["reason"] === "not_injected";
      }
      if (value["state"] === "blocked") {
        return isHostAdapterErrorShape(value["error"]);
      }
      if (value["state"] !== "completed" || !isRecord(value["result"])) {
        return false;
      }
      const result = value["result"];
      return (
        typeof result["delivery_id"] === "string" &&
        (result["submitted"] === "true" ||
          result["submitted"] === "false" ||
          result["submitted"] === "unknown") &&
        isRecord(result["inclusion"]) &&
        typeof result["inclusion"]["level"] === "string" &&
        typeof result["degraded"] === "boolean" &&
        isEpochMs(result["completed_at"])
      );
    }
    case "check_load":
      return (
        hasOnlyKeys(value, CHECK_LOAD_RESULT_ENVELOPE_KEYS) &&
        value["state"] === "completed" &&
        isRecord(value["result"]) &&
        isValidLoadCheckResultShape(value["result"])
      );
    case "probe":
      return (
        hasOnlyKeys(value, PROBE_RESULT_KEYS) &&
        value["state"] === "observed" &&
        isRecord(value["observation"]) &&
        isValidProbeObservation(value["observation"])
      );
    case "error":
      return isHostAdapterErrorShape(value["error"]);
    default:
      return false;
  }
}

function parseResultRequest(params: unknown): Result<HostRuntimeResultRequest, ErrorEnvelope> {
  if (!isRecord(params)) {
    return err(fieldError("params", "must_be_object"));
  }
  if (params["schema_version"] !== "rsi.host_runtime_result/1") {
    return err(fieldError("schema_version", "const"));
  }
  const sessionId = params["session_id"];
  if (typeof sessionId !== "string" || !isId(sessionId, "rts")) {
    return err(fieldError("session_id", "rts_id"));
  }
  const nonce = params["session_nonce"];
  if (typeof nonce !== "string" || nonce.length === 0) {
    return err(fieldError("session_nonce", "non_empty_string"));
  }
  const callId = params["call_id"];
  if (typeof callId !== "string" || callId.length === 0 || callId.length > 128) {
    return err(fieldError("call_id", "non_empty_string"));
  }
  const result = params["result"];
  if (!isRecord(result) || typeof result["kind"] !== "string") {
    return err(fieldError("result", "must_be_object"));
  }
  if (!isJsonValue(result)) {
    return err(fieldError("result", "json_value"));
  }
  if (!isValidRuntimeCallResult(result)) {
    return err(fieldError("result", "runtime_call_result"));
  }
  return ok({
    schema_version: "rsi.host_runtime_result/1",
    session_id: sessionId as Id<"rts">,
    session_nonce: nonce,
    call_id: callId,
    result: result as unknown as RuntimeCallResult
  });
}

/* ------------------------------------------------------------------ */
/* Result validation / mapping                                         */
/* ------------------------------------------------------------------ */

function sanitizeDeliveryResult(result: HostDeliveryResult): { readonly result: HostDeliveryResult; readonly degraded: boolean } {
  let degraded = result.degraded;
  let inclusion = result.inclusion.level;
  if (inclusion === "transport_body") {
    inclusion = "provider_payload";
    degraded = true;
  }
  return {
    result: {
      ...result,
      inclusion: { ...result.inclusion, level: inclusion },
      degraded
    },
    degraded
  };
}

function validateResultAgainstCall(call: HostRuntimeCallRow, result: RuntimeCallResult): boolean {
  if (result.kind !== "error" && result.kind !== call.kind) {
    return false;
  }
  switch (result.kind) {
    case "deliver":
      if (result.state === "completed") {
        return result.result.delivery_id === call.object_ref;
      }
      return true;
    case "check_load":
      return result.result.request_id === call.object_ref;
    case "probe":
      return result.observation.probe_id === call.object_ref;
    case "error":
      return true;
  }
}

/** The immutable fields a result was validated against. */
type IssuedResultSnapshot = HostRuntimeCallRow;

function sameIssuedCall(snapshot: IssuedResultSnapshot, call: HostRuntimeCallRow): boolean {
  return (
    snapshot.call_id === call.call_id &&
    snapshot.kind === call.kind &&
    snapshot.registration_hash === call.registration_hash &&
    snapshot.artifact_hash === call.artifact_hash &&
    snapshot.object_ref === call.object_ref &&
    snapshot.deadline_at === call.deadline_at &&
    snapshot.issued_at === call.issued_at &&
    snapshot.issued_session_id === call.issued_session_id &&
    snapshot.created_at === call.created_at
  );
}

function requestMatchesCallRow(row: HostRuntimeCallRow, call: RuntimeCallType): boolean {
  if (call.call_id !== row.call_id || call.kind !== row.kind) {
    return false;
  }
  switch (call.kind) {
    case "deliver":
      return call.request.delivery_id === row.object_ref;
    case "check_load":
      return call.request.request_id === row.object_ref;
    case "probe":
      return call.request.probe_id === row.object_ref;
  }
}

async function evidenceRefRecoverable(
  deps: HostRuntimeServiceDeps,
  ref: SourceRef
): Promise<boolean> {
  const resolved = await deps.source_refs.resolve(ref, { maxBytes: MAX_HOST_PAYLOAD_BYTES });
  return resolved.ok && resolved.value.retrievable && resolved.value.bytes !== null;
}

async function allEvidenceRefsRecoverable(
  deps: HostRuntimeServiceDeps,
  refs: readonly string[]
): Promise<boolean> {
  const outcomes = await Promise.all(refs.map((ref) => evidenceRefRecoverable(deps, ref as SourceRef)));
  return outcomes.every(Boolean);
}

function evidenceUnknownError(_path: string, sourceRef: string): ErrorEnvelope {
  return runtimeError("E_EVIDENCE_UNKNOWN", "host_runtime_result", "source", {
    kind: "source",
    source_ref: sourceRef,
    reason: "missing"
  });
}

/**
 * Validates a per-event native confirmation reported by the host runtime.
 *
 * This result does not describe a capability; the issuer owns the probe and
 * ledger writes. The runtime gate only proves the observation is bound to the
 * immutable request and that a confirmed answer names one recoverable CAS
 * evidence ref for the exact nonce/event/session. The issuer re-reads those
 * bytes and independently rebinds every field before writing `passed`.
 */
async function validateHumanConfirmationAgainstRequest(
  deps: HostRuntimeServiceDeps,
  row: HostRuntimeCallRow,
  request: RuntimeProbeRequest,
  observation: import("@evoplug/core/host").HostProbeObservation
): Promise<Result<void, ErrorEnvelope>> {
  if (observation.probe_action !== "confirm_human_event") {
    return err(conflictError("result.observation.probe_action", "probe_action_mismatch"));
  }
  if (!Array.isArray(request.capabilities) || request.capabilities.length > 0) {
    return err(
      conflictError("result.observation.probe_action", "confirmation_has_capabilities")
    );
  }
  const confirmation = request.human_confirmation;
  if (
    confirmation === undefined ||
    typeof confirmation.capability_id !== "string" ||
    !isId(confirmation.capability_id, "cap") ||
    typeof confirmation.confirmation_id !== "string" ||
    confirmation.confirmation_id.length === 0 ||
    typeof confirmation.challenge_nonce !== "string" ||
    confirmation.challenge_nonce.length === 0 ||
    typeof confirmation.event_identity_key !== "string" ||
    !isHash(confirmation.event_identity_key) ||
    typeof confirmation.native_session_id !== "string" ||
    confirmation.native_session_id.length === 0 ||
    typeof confirmation.host_version !== "string"
  ) {
    return err(conflictError("result.observation.probe_action", "confirmation_request_invalid"));
  }
  if (row.issued_at === null || observation.checked_at < row.issued_at) {
    return err(conflictError("result.observation.checked_at", "before_issued_at"));
  }
  if (observation.checked_at > deps.now()) {
    return err(conflictError("result.observation.checked_at", "after_now"));
  }
  const binding = validateCapabilityBinding(request.binding);
  if (!binding.ok) {
    return err(conflictError("result.observation.binding_key", "request_binding_invalid"));
  }
  if (observation.binding_key !== capabilityBindingKey(binding.value)) {
    return err(conflictError("result.observation.binding_key", "binding_key_mismatch"));
  }
  if (
    request.host_binding === undefined ||
    request.host_binding.event_identity_key !== confirmation.event_identity_key ||
    request.host_binding.native_session_id !== confirmation.native_session_id
  ) {
    return err(
      conflictError("result.observation.probe_action", "confirmation_host_binding_mismatch")
    );
  }
  const observed = parseRuntimeHumanConfirmationObserved(observation.observed);
  if (
    observed === null ||
    observed.nonce !== confirmation.challenge_nonce ||
    observed.event_identity_key !== confirmation.event_identity_key ||
    observed.native_session_id !== confirmation.native_session_id
  ) {
    return err(conflictError("result.observation.observed", "confirmation_observation_invalid"));
  }
  if (observed.state === "confirmed") {
    if (
      observed.confirmed_at === null ||
      observed.confirmed_at < row.issued_at ||
      observed.confirmed_at > deps.now() ||
      observed.evidence_ref === null ||
      observation.evidence_refs.length !== 1 ||
      observation.evidence_refs[0] !== observed.evidence_ref
    ) {
      return err(
        conflictError("result.observation.observed", "confirmation_evidence_missing")
      );
    }
    const recoverable = await evidenceRefRecoverable(deps, observed.evidence_ref);
    if (!recoverable) {
      return err(evidenceUnknownError("result.observation.evidence_refs", observed.evidence_ref));
    }
    return ok(undefined);
  }
  if (observation.evidence_refs.length > 0) {
    return err(conflictError("result.observation.evidence_refs", "unsolicited_confirmation_evidence"));
  }
  return ok(undefined);
}

/**
 * Validates the first-session setup and candidate-adoption observations. The
 * runtime may only answer its own request: the nonce, native session and (for
 * candidates) the candidate identity and subject hash must match the immutable
 * request, and no unsolicited evidence ref is accepted.
 */
function validateSessionConfirmationAgainstRequest(
  row: HostRuntimeCallRow,
  request: RuntimeProbeRequest,
  observation: import("@evoplug/core/host").HostProbeObservation
): Result<void, ErrorEnvelope> {
  if (observation.probe_action !== request.probe_action) {
    return err(conflictError("result.observation.probe_action", "probe_action_mismatch"));
  }
  if (!Array.isArray(request.capabilities) || request.capabilities.length > 0) {
    return err(conflictError("result.observation.probe_action", "confirmation_has_capabilities"));
  }
  if (row.issued_at === null || observation.checked_at < row.issued_at) {
    return err(conflictError("result.observation.checked_at", "before_issued_at"));
  }
  const binding = validateCapabilityBinding(request.binding);
  if (!binding.ok) {
    return err(conflictError("result.observation.binding_key", "request_binding_invalid"));
  }
  if (observation.binding_key !== capabilityBindingKey(binding.value)) {
    return err(conflictError("result.observation.binding_key", "binding_key_mismatch"));
  }
  const observed = parseRuntimeConfirmationObservation(observation.observed);
  if (observed === null) {
    return err(conflictError("result.observation.observed", "confirmation_observation_invalid"));
  }
  if (observation.evidence_refs.length > 0) {
    return err(conflictError("result.observation.evidence_refs", "unsolicited_confirmation_evidence"));
  }
  if (request.probe_action === "confirm_human_setup") {
    const setup = request.human_setup;
    if (
      setup === undefined ||
      observed.action !== "human_setup" ||
      observed.nonce !== setup.challenge_nonce ||
      observed.native_session_id !== setup.native_session_id ||
      observed.candidate_id !== null ||
      observed.subject_hash !== null
    ) {
      return err(conflictError("result.observation.observed", "setup_request_mismatch"));
    }
    return ok(undefined);
  }
  const candidate = request.candidate_confirmation;
  if (
    candidate === undefined ||
    observed.action !== "candidate_adoption" ||
    observed.nonce !== candidate.challenge_nonce ||
    observed.native_session_id !== candidate.native_session_id ||
    observed.candidate_id !== candidate.candidate_id ||
    observed.subject_hash !== candidate.subject_hash
  ) {
    return err(conflictError("result.observation.observed", "candidate_request_mismatch"));
  }
  return ok(undefined);
}

async function validateProbeResultAgainstRequest(
  deps: HostRuntimeServiceDeps,
  row: HostRuntimeCallRow,
  request: RuntimeProbeRequest,
  observation: import("@evoplug/core/host").HostProbeObservation
): Promise<Result<void, ErrorEnvelope>> {
  if (request.probe_mode !== "read_only") {
    return err(conflictError("result.observation.probe_action", "probe_mode_not_read_only"));
  }
  if (request.probe_action === "confirm_human_event") {
    return validateHumanConfirmationAgainstRequest(deps, row, request, observation);
  }
  if (
    request.probe_action === "confirm_human_setup" ||
    request.probe_action === "confirm_candidate"
  ) {
    return validateSessionConfirmationAgainstRequest(row, request, observation);
  }
  if (request.probe_action !== "read_only") {
    return err(conflictError("result.observation.probe_action", "probe_action_not_runtime_read_only"));
  }
  if (
    !Array.isArray(request.capabilities) ||
    !request.capabilities.every((capability) => RUNTIME_PROBE_CAPABILITIES.has(capability))
  ) {
    return err(conflictError("result.observation.probe_action", "capability_not_runtime_observable"));
  }
  if (observation.probe_action !== request.probe_action) {
    return err(conflictError("result.observation.probe_action", "probe_action_mismatch"));
  }
  if (row.issued_at === null || observation.checked_at < row.issued_at) {
    return err(conflictError("result.observation.checked_at", "before_issued_at"));
  }
  const binding = validateCapabilityBinding(request.binding);
  if (!binding.ok) {
    return err(conflictError("result.observation.binding_key", "request_binding_invalid"));
  }
  if (observation.binding_key !== capabilityBindingKey(binding.value)) {
    return err(conflictError("result.observation.binding_key", "binding_key_mismatch"));
  }
  if (observation.evidence_refs.length > 0) {
    if (!(await allEvidenceRefsRecoverable(deps, observation.evidence_refs))) {
      return err(evidenceUnknownError("result.observation.evidence_refs", observation.evidence_refs[0] as string));
    }
  }
  if (observation.claimed_evidence_stage === "loaded" && observation.evidence_refs.length === 0) {
    return err(evidenceUnknownError("result.observation.evidence_refs", "result.observation.evidence_refs"));
  }
  if (observation.checked_at > deps.now()) {
    return err(conflictError("result.observation.checked_at", "after_now"));
  }
  return ok(undefined);
}

async function validateLoadCheckResultAgainstRequest(
  deps: HostRuntimeServiceDeps,
  request: import("@evoplug/core/host").LoadCheckRequest,
  result: import("@evoplug/core/host").LoadCheckResult
): Promise<Result<void, ErrorEnvelope>> {
  if (typeof request.expected_hash !== "string" || !isHash(request.expected_hash)) {
    return err(conflictError("request.expected_hash", "expected_hash_invalid"));
  }
  if (result.request_id !== request.request_id) {
    return err(conflictError("result.request_id", "request_id_mismatch"));
  }
  let evidenceRecoverable = false;
  if (result.evidence_refs.length > 0) {
    evidenceRecoverable = await allEvidenceRefsRecoverable(deps, result.evidence_refs);
    if (!evidenceRecoverable) {
      return err(evidenceUnknownError("result.evidence_refs", result.evidence_refs[0] as string));
    }
  }
  let readbackRecoverable = false;
  if (result.readback_ref !== undefined) {
    readbackRecoverable = await evidenceRefRecoverable(deps, result.readback_ref);
    if (!readbackRecoverable) {
      return err(evidenceUnknownError("result.readback_ref", result.readback_ref));
    }
  }
  if (result.state === "loaded") {
    if (result.observed_hash === undefined || result.observed_hash !== request.expected_hash) {
      return err(conflictError("result.observed_hash", "expected_hash_mismatch"));
    }
    if (!evidenceRecoverable && !readbackRecoverable) {
      return err(evidenceUnknownError("result", "result.evidence_refs"));
    }
  }
  return ok(undefined);
}

async function validateIssuedResultAgainstRequest(
  deps: HostRuntimeServiceDeps,
  row: HostRuntimeCallRow,
  session: HostRuntimeSessionRow,
  result: RuntimeCallResult,
  limits: HostRuntimeLimits
): Promise<Result<void, ErrorEnvelope>> {
  if (deps.call_resolver === undefined) {
    return err(internalRuntimeError("kernel.host_runtime_call_resolver_unavailable"));
  }
  const resolved = await deps.call_resolver.resolve({
    row,
    session,
    now: deps.now(),
    delivery_max_chars: limits.delivery_max_chars
  });
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.value === null || !requestMatchesCallRow(row, resolved.value)) {
    return err(conflictError("call_id", "immutable_request_unavailable"));
  }
  const call = resolved.value;
  if (result.kind === "probe" && result.state === "observed" && call.kind === "probe") {
    return validateProbeResultAgainstRequest(deps, row, call.request, result.observation);
  }
  if (result.kind === "check_load" && result.state === "completed" && call.kind === "check_load") {
    return validateLoadCheckResultAgainstRequest(deps, call.request, result.result);
  }
  return ok(undefined);
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createHostRuntimeServices(deps: HostRuntimeServiceDeps): HostRuntimeHandlers {
  const limits: HostRuntimeLimits = {
    max_payload_bytes: Math.min(
      deps.limits?.max_payload_bytes ?? DEFAULT_HOST_RUNTIME_LIMITS.max_payload_bytes,
      MAX_HOST_PAYLOAD_BYTES
    ),
    poll_wait_max_ms: Math.max(0, deps.limits?.poll_wait_max_ms ?? DEFAULT_HOST_RUNTIME_LIMITS.poll_wait_max_ms),
    delivery_max_chars: Math.max(0, deps.limits?.delivery_max_chars ?? DEFAULT_HOST_RUNTIME_LIMITS.delivery_max_chars)
  };
  const pollInterval = Math.max(1, deps.poll_interval_ms ?? 50);
  const nonceOf = deps.random_nonce ?? ((): string => randomBytes(24).toString("base64url"));
  const activePolls = new Set<string>();

  function leaseDuration(ephemeral: boolean, instance_key?: string | null): number {
    // Appendix Q.2: the MCP confirmation process is a long-lived child of the
    // host even though it is registered as an ephemeral session (its native
    // session id is the channel instance key). Its liveness is the honest
    // host-liveness signal for one-shot hook hosts, so it keeps a resident
    // lease refreshed by its 5 s idle poll instead of the 24 h hook lease.
    if (instance_key !== undefined && instance_key !== null && instance_key.startsWith("mcp-confirm:")) {
      return 2 * limits.poll_wait_max_ms + RESIDENT_SESSION_LEASE_SLACK_MS;
    }
    return leaseMsFor(ephemeral, limits.poll_wait_max_ms);
  }

  /**
   * Runs an optional producer hook without letting it break the runtime
   * request. A scheduling or persistence failure is the producer's problem and
   * must not turn a successful ready/poll/result into an error.
   */
  function runLifecycleHook(hook: () => void | Promise<void>): void {
    try {
      const outcome = hook();
      if (outcome instanceof Promise) {
        outcome.catch(() => undefined);
      }
    } catch {
      // A producer hook is best-effort by contract.
    }
  }

  /** Synchronous hook executed inside the poll transaction. */
  function runPollIntentHook(hook: () => void): void {
    try {
      hook();
    } catch {
      // Arming is best-effort; a failed arm leaves the call pending.
    }
  }

  /**
   * Publishes one refused upload as a retrievable CAS blob and hands the exact
   * coordinates to the composition. Failure to store or to run the observer is
   * swallowed: the ACK has already been decided.
   */
  function reportUploadDiagnostic(input: {
    readonly session_id: string;
    readonly host_event: string;
    readonly raw_event_id: string;
    readonly state: "rejected" | "error";
    readonly reason: string;
    readonly field: string;
    readonly phase: "A" | "B" | null;
  }): void {
    if (deps.upload_diagnostic === undefined) return;
    let detailRef: SourceRef | null = null;
    try {
      const text = canonicalJsonText({
        schema_version: "rsi.host_upload_rejection/1",
        ...input,
        recorded_at: deps.now()
      } as unknown as JsonValue);
      const bytes = new TextEncoder().encode(text);
      const stored = deps.blob_store.putSync(bytes);
      if (stored.ok) {
        detailRef = `blob://${stored.value.hash}#bytes=0-${String(stored.value.byte_length)}` as SourceRef;
      }
    } catch {
      detailRef = null;
    }
    try {
      deps.upload_diagnostic({ ...input, detail_ref: detailRef });
    } catch {
      // Diagnostic only.
    }
  }

  function touchSession(session: HostRuntimeSessionRow): void {
    const now = deps.now();
    // Appendix Q.2: a session whose registered liveness pid is another process
    // (OpenCode's service plugin uses the TUI heartbeat pid) must not keep that
    // lease alive after the pid dies. The service may keep polling; the lease
    // stays at its last value so the sweeper can synthesize session_end.
    const externalLivenessDead =
      session.host_id === "opencode" &&
      session.pid !== process.pid &&
      !processAlive(session.pid);
    deps.connection
      .prepare(
        `UPDATE host_runtime_session
            SET last_seen_at = :now, lease_expires_at = :lease_expires_at
          WHERE session_id = :session_id`
      )
      .run({
        now,
        // Codex's MCP process can outlive a SIGKILLed TUI through its
        // app-server daemon. That process must not refresh the channel lease
        // forever: after 24 h the session expires and the review runs, as the
        // documented known limitation.
        lease_expires_at: externalLivenessDead
          ? session.lease_expires_at
          : session.instance_key !== null &&
              session.instance_key.startsWith("mcp-confirm:") &&
              now - session.started_at >= 24 * 60 * 60 * 1_000
            ? now - 1
            : now + leaseDuration(session.ephemeral, session.instance_key),
        session_id: session.session_id
      });
  }

  /**
   * Verifies the session id/nonce/binding. A revoked, expired or no-longer
   * applied session is failed/revoked and rejected.
   */
  function authenticate(
    sessionId: string,
    nonce: string,
    context: { readonly client_id: string }
  ): Result<HostRuntimeSessionRow, ErrorEnvelope> {
    const session = readSession(deps.connection, sessionId);
    if (session === null || session.session_nonce !== nonce) {
      return err(sessionError());
    }
    if (session.adapter_id !== context.client_id) {
      return err(sessionError());
    }
    if (session.state === "revoked" || session.state === "failed") {
      return err(sessionError());
    }
    if (session.state !== "ready") {
      return err(sessionError());
    }
    if (session.lease_expires_at <= deps.now()) {
      deps.connection
        .prepare(
          `UPDATE host_runtime_session
              SET state = 'failed', closed_at = :now
            WHERE session_id = :session_id AND state = 'ready'`
        )
        .run({ now: deps.now(), session_id: session.session_id });
      return err(sessionError());
    }
    if (!isRegistrationApplied(deps.connection, session.registration_hash)) {
      revokeHostRuntimeSessions({
        connection: deps.connection,
        now: deps.now(),
        registration_hash: session.registration_hash
      });
      return err(sessionError());
    }
    return ok(session);
  }

  function ready(context: IpcHandlerContext<"host.runtime.ready">): Result<HostRuntimeReadyResult, ErrorEnvelope> {
    if (!clientKindAllowed(context)) {
      return err(forbiddenError(context));
    }
    const parsed = parseReadyRequest(context.params);
    if (!parsed.ok) {
      return parsed;
    }
    const request = parsed.value;
    if (context.client_id !== request.adapter_id) {
      return err(unboundError());
    }

    const applied = deps.connection
      .prepare<SqlRow>(
        `SELECT registration_hash, adapter_id, host_id, mode, config_space, target_id,
                adapter_version, implementation_hash, descriptor_hash, artifact_ref,
                artifact_hash, expected_previous_hash, state, written_hash, config_hash,
                created_at, applied_at
           FROM adapter_registration
          WHERE host_id = :host_id AND mode = :mode AND config_space = :config_space
            AND state = 'applied'`
      )
      .all({
        host_id: request.host_id,
        mode: request.mode,
        config_space: request.config_space
      });
    if (applied.length !== 1) {
      const inflight = deps.connection
        .prepare<SqlRow>(
          `SELECT COUNT(*) AS total FROM adapter_registration
            WHERE host_id = :host_id AND mode = :mode AND config_space = :config_space
              AND state IN ('intent','applying','unknown')`
        )
        .get({
          host_id: request.host_id,
          mode: request.mode,
          config_space: request.config_space
        });
      if (applied.length === 0 && inflight !== undefined && asNumber(inflight, "total") > 0) {
        return err(
          runtimeError("E_CONFLICT", "host_runtime_ready", "conflict", {
            kind: "field",
            path: "registration",
            rule: "applying"
          }, true)
        );
      }
      return err(unboundError());
    }
    const row = registrationFromRow(applied[0] as SqlRow);
    if (
      request.registration_hash !== row.registration_hash ||
      request.adapter_id !== row.adapter_id ||
      request.host_id !== row.host_id ||
      request.mode !== row.mode ||
      request.config_space !== row.config_space ||
      request.adapter_version !== row.adapter_version ||
      request.implementation_hash !== row.implementation_hash
    ) {
      return err(unboundError());
    }
    const snapshot = readSnapshot(deps.connection, row.registration_hash);
    if (snapshot === null) {
      return err(unboundError());
    }
    const descriptor = snapshot.descriptor;
    if (
      snapshot.descriptor_hash !== row.descriptor_hash ||
      adapterDescriptorHash(descriptor) !== row.descriptor_hash ||
      descriptor.adapter_id !== row.adapter_id ||
      descriptor.host_id !== row.host_id ||
      descriptor.adapter_version !== row.adapter_version ||
      descriptor.implementation_hash !== row.implementation_hash ||
      !descriptor.config_spaces.includes(request.config_space)
    ) {
      return err(unboundError());
    }
    const recomputed = computeRegistrationHash({
      host_id: row.host_id,
      mode: row.mode,
      config_space: row.config_space,
      adapter_id: row.adapter_id,
      adapter_version: row.adapter_version,
      implementation_hash: row.implementation_hash,
      descriptor_hash: row.descriptor_hash,
      target_id: row.target_id,
      artifact_hash: row.artifact_hash,
      expected_previous_hash: row.expected_previous_hash
    });
    if (recomputed !== row.registration_hash) {
      return err(unboundError());
    }

    if (row.written_hash === null) {
      return err(artifactError());
    }
    if (request.artifact_hash !== row.artifact_hash || request.artifact_hash !== row.written_hash) {
      return err(artifactError());
    }
    if (request.load_verified_hash !== row.written_hash) {
      return err(artifactError());
    }
    if (row.config_hash === null || request.config_hash !== row.config_hash) {
      // A second attach root (e.g. the caller-local attach in appendix I.1)
      // records its own config hash. Accept any hash a real attach produced for
      // this registration; a hand-edited config is still refused.
      if (deps.installation_config_allowed?.(row.registration_hash, request.config_hash) !== true) {
        return err(artifactMismatchError());
      }
    }

    const now = deps.now();
    const lease = leaseDuration(request.ephemeral, request.instance_key);
    const nonce = nonceOf();
    const existing = deps.connection
      .prepare<SqlRow>(
        request.ephemeral
          ? `SELECT ${sessionColumns(deps.connection)} FROM host_runtime_session
              WHERE registration_hash = :registration_hash AND instance_key = :instance_key
                AND state IN ('ready','closed')
              ORDER BY last_seen_at DESC LIMIT 1`
          : `SELECT ${sessionColumns(deps.connection)} FROM host_runtime_session
              WHERE registration_hash = :registration_hash AND instance_key IS NULL
                AND state IN ('ready','closed')
              ORDER BY last_seen_at DESC LIMIT 1`
      )
      .get({
        registration_hash: row.registration_hash,
        ...(request.ephemeral ? { instance_key: request.instance_key } : {})
      });

    let sessionId: Id<"rts">;
    // Appendix M.1's column arrives with a later domain migration. Older test
    // fixtures keep working; a real home always has it after init/serve.
    const hasWorkingDirectory = tableHasColumn(
      deps.connection,
      "host_runtime_session",
      "working_directory"
    );
    if (existing === undefined) {
      sessionId = newId("rts");
      deps.connection
        .prepare(
          `INSERT INTO host_runtime_session (
             session_id, session_nonce, host_id, mode, config_space, adapter_id,
             adapter_version, implementation_hash, registration_hash, artifact_hash,
             config_hash, host_version, binary_hash, ephemeral, instance_key,
             native_session_id, pid, state, lease_expires_at, started_at, last_seen_at,
             closed_at, session_role${hasWorkingDirectory ? ", working_directory" : ""}
           ) VALUES (
             :session_id, :session_nonce, :host_id, :mode, :config_space, :adapter_id,
             :adapter_version, :implementation_hash, :registration_hash, :artifact_hash,
             :config_hash, :host_version, :binary_hash, :ephemeral, :instance_key,
             :native_session_id, :pid, 'ready', :lease_expires_at, :started_at, :last_seen_at,
             NULL, :session_role${hasWorkingDirectory ? ", :working_directory" : ""}
           )`
        )
        .run({
          session_id: sessionId,
          session_nonce: nonce,
          host_id: row.host_id,
          mode: row.mode,
          config_space: row.config_space,
          adapter_id: row.adapter_id,
          adapter_version: row.adapter_version,
          implementation_hash: row.implementation_hash,
          registration_hash: row.registration_hash,
          artifact_hash: row.artifact_hash,
          config_hash: row.config_hash,
          host_version: request.host_version,
          binary_hash: request.binary_hash,
          ephemeral: request.ephemeral ? 1 : 0,
          instance_key: request.instance_key,
          native_session_id: request.ephemeral ? request.instance_key : null,
          session_role: request.session_role ?? (request.ephemeral ? "evaluator" : "host_session"),
          ...(hasWorkingDirectory
            ? { working_directory: request.working_directory ?? null }
            : {}),
          pid: request.pid,
          lease_expires_at: now + lease,
          started_at: request.started_at,
          last_seen_at: now
        });
    } else {
      const prior = sessionFromRow(existing);
      sessionId = prior.session_id;
      // A new host process can reuse this runtime session when the host keeps
      // its native session id (Pi resumes the same session id across CLI
      // processes). Calls armed for the previous process cannot be rendered
      // by it any more; leaving them `pending`/`issued` blocked every later
      // confirmation arm with `live_call` until the 5-minute deadline. Expire
      // the pre-existing calls of this session before the new process polls.
      if (prior.pid !== request.pid) {
        deps.connection
          .prepare(
            `UPDATE host_runtime_call SET state = 'expired', updated_at = :now
              WHERE registration_hash = :registration_hash
                AND state IN ('pending','issued')
                AND created_at < :started_at
                AND (issued_session_id = :session_id
                     OR (issued_session_id IS NULL AND native_session_id = :native_session_id))`
          )
          .run({
            registration_hash: row.registration_hash,
            session_id: prior.session_id,
            native_session_id: prior.native_session_id,
            started_at: request.started_at,
            now
          });
      }
      deps.connection
        .prepare(
          `UPDATE host_runtime_session SET
             session_nonce = :session_nonce,
             pid = :pid,
             started_at = :started_at,
             last_seen_at = :last_seen_at,
             lease_expires_at = :lease_expires_at,
             state = 'ready',
             closed_at = NULL,
             host_version = :host_version,
             binary_hash = :binary_hash,
             native_session_id = :native_session_id,
             session_role = :session_role${hasWorkingDirectory
               ? ", working_directory = COALESCE(:working_directory, working_directory)"
               : ""}
           WHERE session_id = :session_id`
        )
        .run({
          session_nonce: nonce,
          pid: request.pid,
          started_at: request.started_at,
          last_seen_at: now,
          lease_expires_at: now + lease,
          host_version: request.host_version,
          binary_hash: request.binary_hash,
          native_session_id: request.ephemeral ? request.instance_key : prior.native_session_id,
          session_role: request.session_role ?? (request.ephemeral ? "evaluator" : "host_session"),
          ...(hasWorkingDirectory
            ? { working_directory: request.working_directory ?? null }
            : {}),
          session_id: sessionId
        });
    }

    const readySession = readSession(deps.connection, sessionId);
    if (readySession !== null) {
      runLifecycleHook(() => deps.lifecycle?.onSessionReady?.({ session: readySession }));
    }

    return ok({
      session_id: sessionId,
      session_nonce: nonce,
      limits: {
        max_payload_bytes: limits.max_payload_bytes,
        poll_wait_max_ms: limits.poll_wait_max_ms,
        delivery_max_chars: limits.delivery_max_chars,
        lease_ms: lease
      }
    });
  }

  async function upload(
    context: IpcHandlerContext<"host.runtime.upload">
  ): Promise<Result<HostRuntimeUploadResult, ErrorEnvelope>> {
    if (!clientKindAllowed(context)) {
      return err(forbiddenError(context));
    }
    const parsed = parseUploadRequest(context.params);
    if (!parsed.ok) {
      return parsed;
    }
    const request = parsed.value;
    const authenticated = authenticate(request.session_id, request.session_nonce, context);
    if (!authenticated.ok) {
      return authenticated;
    }
    const session = authenticated.value;
    const uploadValue = request.upload;
    if (
      uploadValue.adapter_id !== session.adapter_id ||
      uploadValue.host_id !== session.host_id ||
      uploadValue.mode !== session.mode ||
      uploadValue.config_space !== session.config_space
    ) {
      return Promise.resolve(err(conflictError("upload", "binding")));
    }
    if (uploadValue.payload.byte_length > limits.max_payload_bytes) {
      return Promise.resolve(err(tooLargeError("upload.payload.byte_length", limits.max_payload_bytes)));
    }
    if (uploadValue.payload.byte_length > MAX_HOST_PAYLOAD_BYTES) {
      return Promise.resolve(err(tooLargeError("upload.payload.byte_length", MAX_HOST_PAYLOAD_BYTES)));
    }
    if (encodeSize(uploadValue.payload.data) > MAX_ENCODED_RUNTIME_BODY_BYTES) {
      return Promise.resolve(err(tooLargeError("upload.payload.data", MAX_ENCODED_RUNTIME_BODY_BYTES)));
    }
    if (
      (uploadValue.payload.media_type === "text/plain;charset=utf-8" ||
        uploadValue.payload.media_type === "application/json") &&
      uploadValue.payload.byte_length === 0
    ) {
      return Promise.resolve(err(fieldError("upload.payload", "empty_text")));
    }

    const hasSessionColumn = uploadHasSessionColumn(deps.connection);
    const existingUpload = deps.connection
      .prepare<SqlRow>(
        `SELECT payload_hash, receipt_ref${hasSessionColumn ? ", session_id" : ""}
           FROM host_runtime_upload
          WHERE registration_hash = :registration_hash AND raw_event_id = :raw_event_id`
      )
      .get({
        registration_hash: session.registration_hash,
        raw_event_id: uploadValue.raw_event_id
      });
    if (existingUpload !== undefined && asString(existingUpload, "payload_hash") !== uploadValue.payload_hash) {
      return Promise.resolve(
        err(
          runtimeError("E_IDEMPOTENCY_CONFLICT", "host_runtime_upload", "conflict", {
            kind: "idempotency",
            key: uploadValue.raw_event_id,
            existing_hash: asString(existingUpload, "payload_hash") as Hash,
            incoming_hash: uploadValue.payload_hash
          })
        )
      );
    }

    const registration = deps.connection
      .prepare<SqlRow>(
        `SELECT registration_hash, adapter_id, host_id, mode, config_space, target_id,
                adapter_version, implementation_hash, descriptor_hash, artifact_ref,
                artifact_hash, expected_previous_hash, state, written_hash, config_hash,
                created_at, applied_at
           FROM adapter_registration
          WHERE registration_hash = :registration_hash AND state = 'applied'`
      )
      .get({ registration_hash: session.registration_hash });
    if (registration === undefined) {
      revokeHostRuntimeSessions({
        connection: deps.connection,
        now: deps.now(),
        registration_hash: session.registration_hash
      });
      return Promise.resolve(err(sessionError()));
    }
    const registrationRow = registrationFromRow(registration);
    const snapshot = readSnapshot(deps.connection, registrationRow.registration_hash);
    if (snapshot === null) {
      return Promise.resolve(err(unboundError()));
    }
    const adapter = deps.adapters.resolve({
      registration_hash: registrationRow.registration_hash,
      adapter_id: registrationRow.adapter_id
    });
    if (adapter === null) {
      return Promise.resolve(err(unboundError()));
    }
    const active = activeRegistrationFromDescriptor({
      registration_hash: registrationRow.registration_hash,
      descriptor: snapshot.descriptor,
      mode: registrationRow.mode,
      config_space: registrationRow.config_space,
      applied_at: registrationRow.applied_at ?? registrationRow.created_at
    });

    // Persist the upload idempotency key before the host-core path so a
    // concurrent retry observes the same `(registration_hash, raw_event_id)`.
    // `session_id` is the authenticated session from `session_id/session_nonce`,
    // never the upload payload's self-reported `native_ids.session_id`.
    if (hasSessionColumn) {
      deps.connection
        .prepare(
          `INSERT INTO host_runtime_upload (
             registration_hash, raw_event_id, payload_hash, receipt_ref, created_at,
             session_id
           ) SELECT
             :registration_hash, :raw_event_id, :payload_hash, NULL, :created_at,
             :session_id
           WHERE NOT EXISTS (
             SELECT 1 FROM host_runtime_upload
              WHERE registration_hash = :registration_hash AND raw_event_id = :raw_event_id
           )`
        )
        .run({
          registration_hash: registrationRow.registration_hash,
          raw_event_id: uploadValue.raw_event_id,
          payload_hash: uploadValue.payload_hash,
          created_at: deps.now(),
          session_id: session.session_id
        });
    } else {
      deps.connection
        .prepare(
          `INSERT INTO host_runtime_upload (
             registration_hash, raw_event_id, payload_hash, receipt_ref, created_at
           ) SELECT
             :registration_hash, :raw_event_id, :payload_hash, NULL, :created_at
           WHERE NOT EXISTS (
             SELECT 1 FROM host_runtime_upload
              WHERE registration_hash = :registration_hash AND raw_event_id = :raw_event_id
           )`
        )
        .run({
          registration_hash: registrationRow.registration_hash,
          raw_event_id: uploadValue.raw_event_id,
          payload_hash: uploadValue.payload_hash,
          created_at: deps.now()
        });
    }
    const now = deps.now();
    const nativeSession = uploadValue.native_ids.session_id ?? session.native_session_id ?? undefined;
    // Appendix M.1: a resident host session (Pi/OMP/Step/OpenCode) is reused
    // across host processes that each bring a new native session id, so the
    // upload binding follows the current process. A one-shot hook session
    // (`ephemeral`) took its native id from the hook at ready time; a payload
    // naming another native session there is an identity mismatch, not a
    // rebind, and the human-attestation trigger relies on that mismatch.
    if (
      session.ephemeral === false &&
      nativeSession !== undefined &&
      session.native_session_id !== nativeSession
    ) {
      deps.connection
        .prepare(
          `UPDATE host_runtime_session SET native_session_id = :native_session_id
            WHERE session_id = :session_id`
        )
        .run({
          native_session_id: nativeSession,
          session_id: session.session_id
        });
    }
    const contractMatches = active.event_contracts.filter(
      (contract: AdapterEventContract) => contract.host_event === uploadValue.host_event
    );
    let scopeClaim: StableEventScope | undefined;
    if (contractMatches.length === 1 && contractMatches[0] !== undefined && !isInputContract(contractMatches[0])) {
      if (nativeSession === undefined) {
        reportUploadDiagnostic({
          session_id: session.session_id,
          host_event: uploadValue.host_event,
          raw_event_id: uploadValue.raw_event_id,
          state: "rejected",
          reason: "E_EVENT_SCOPE_UNBOUND",
          field: "scope_claim",
          phase: "A"
        });
        return Promise.resolve(
          ok({
            state: "rejected",
            receipt: null,
            rejection: makeRejection({
              phase: "A",
              reason: "E_EVENT_SCOPE_UNBOUND",
              field: "scope_claim",
              now
            })
          })
        );
      }
      const scope = await deps.session_scope.get({
        host_id: session.host_id,
        config_space: session.config_space,
        native_session_id: nativeSession,
        remaining_ms: Math.max(1, context.remaining_ms),
        signal: context.signal
      });
      if (!scope.ok) {
        return scope;
      }
      if (scope.value === null) {
        reportUploadDiagnostic({
          session_id: session.session_id,
          host_event: uploadValue.host_event,
          raw_event_id: uploadValue.raw_event_id,
          state: "rejected",
          reason: "E_EVENT_SCOPE_UNBOUND",
          field: "scope_claim",
          phase: "A"
        });
        return ok({
          state: "rejected",
          receipt: null,
          rejection: makeRejection({
            phase: "A",
            reason: "E_EVENT_SCOPE_UNBOUND",
            field: "scope_claim",
            now
          })
        });
      }
      scopeClaim = scope.value;
    }

    return runHostCorePath(
      deps,
      { upload: uploadValue, session, registration: registrationRow, active, adapter },
      scopeClaim,
      context.remaining_ms
    ).then((rawOutcome) => {
      if (!rawOutcome.ok || rawOutcome.value.receipt === null) {
        if (!rawOutcome.ok) {
          reportUploadDiagnostic({
            session_id: session.session_id,
            host_event: uploadValue.host_event,
            raw_event_id: uploadValue.raw_event_id,
            state: "error",
            reason: rawOutcome.error.code,
            field: rawOutcome.error.stage,
            phase: null
          });
        } else {
          const rejection = rawOutcome.value.rejection;
          reportUploadDiagnostic({
            session_id: session.session_id,
            host_event: uploadValue.host_event,
            raw_event_id: uploadValue.raw_event_id,
            state: "rejected",
            reason: rejection?.reason ?? "unknown",
            field: rejection?.field ?? "",
            phase: rejection?.phase ?? null
          });
        }
        touchSession(session);
        return rawOutcome;
      }
      // Commit the receipt and the authenticated session in one transition.
      // A row with `receipt_ref IS NULL` is only a reservation: a failed or
      // crashed attempt never completed it, so a later success must report
      // `ingested` and own both columns. Losing the CAS means another attempt
      // already completed the upload, which is the only real duplicate.
      const committed = deps.connection
        .prepare(
          `UPDATE host_runtime_upload
              SET receipt_ref = :receipt_ref${hasSessionColumn ? ", session_id = :session_id" : ""}
            WHERE registration_hash = :registration_hash
              AND raw_event_id = :raw_event_id
              AND receipt_ref IS NULL`
        )
        .run({
          receipt_ref: rawOutcome.value.receipt.event_id,
          ...(hasSessionColumn ? { session_id: session.session_id } : {}),
          registration_hash: registrationRow.registration_hash,
          raw_event_id: uploadValue.raw_event_id
        });
      const outcome =
        committed.changes === 0
          ? ok({
              ...rawOutcome.value,
              state: "duplicate" as const,
              receipt: { ...rawOutcome.value.receipt, duplicate: true }
            })
          : rawOutcome;
      if (hasSessionColumn && committed.changes === 0) {
        // A row written before the session link existed (or by an older build)
        // gains the link only from an authenticated successful replay. A failed
        // attempt must not claim a receipt it did not commit.
        deps.connection
          .prepare(
            `UPDATE host_runtime_upload SET session_id = :session_id
              WHERE registration_hash = :registration_hash
                AND raw_event_id = :raw_event_id
                AND session_id IS NULL`
          )
          .run({
            session_id: session.session_id,
            registration_hash: registrationRow.registration_hash,
            raw_event_id: uploadValue.raw_event_id
          });
      }
      // A resident session is created before any native session id is known.
      // Bind the first observed native session so later poll calls can resolve
      // the delivery scope; per-call scope still wins when the call names one.
      if (
        outcome.ok &&
        outcome.value.state !== "rejected" &&
        nativeSession !== undefined &&
        session.native_session_id === null
      ) {
        // Bind the first observed native session only. A later upload that
        // names a different native session is not trusted to overwrite the
        // authenticated binding; the confirmation channel keeps the id the
        // session was registered with.
        deps.connection
          .prepare(
            `UPDATE host_runtime_session SET native_session_id = :native_session_id
              WHERE session_id = :session_id AND native_session_id IS NULL`
          )
          .run({
            native_session_id: nativeSession,
            session_id: session.session_id
          });
      }
      touchSession(session);
      // Run the human-attestation hook only after `receipt_ref` and the native
      // session id are durable: the hook resolves the upload row by that exact
      // receipt and reads the refreshed session row. It never changes the ACK.
      if (
        deps.human_attestation_upload !== undefined &&
        outcome.ok &&
        outcome.value.receipt !== null
      ) {
        try {
          const committedSession = readSession(deps.connection, session.session_id) ?? session;
          deps.human_attestation_upload({
            session: committedSession,
            request: {
              schema_version: "rsi.host_runtime_upload/1",
              session_id: session.session_id,
              session_nonce: session.session_nonce,
              upload: uploadValue
            },
            result: outcome.value
          });
        } catch {
          // The ACK is already decided; the hook owns its diagnostics.
        }
      }
      return outcome;
    });
  }

  async function waitForCall(
    session: HostRuntimeSessionRow,
    request: HostRuntimePollRequest,
    context: IpcHandlerContext<"host.runtime.poll">
  ): Promise<Result<HostRuntimePollResult, ErrorEnvelope>> {
    const waitDeadline = deps.now() + Math.min(request.wait_ms, context.remaining_ms);
    for (;;) {
      if (context.signal.aborted) {
        return err(runtimeError("E_CANCELLED", "host_runtime_poll", "deadline", { kind: "none" }));
      }
      const current = readSession(deps.connection, session.session_id);
      if (current === null || current.state === "revoked" || current.state === "failed" || current.state !== "ready") {
        return ok({ kind: "shutdown", call: null });
      }
      if (!isRegistrationApplied(deps.connection, current.registration_hash)) {
        revokeHostRuntimeSessions({
          connection: deps.connection,
          now: deps.now(),
          registration_hash: current.registration_hash
        });
        return ok({ kind: "shutdown", call: null });
      }

      const now = deps.now();
      // The version guard needs the current scope; read it outside the write
      // transaction so `BEGIN IMMEDIATE` stays short. Resolve both the session
      // binding and every native session named by a pending call: a resident
      // runtime serves many native sessions, and a deliver call carries the
      // scope it was produced for (DD-HOST-200.5).
      const scopeIds = new Set<string>();
      if (current.native_session_id !== null) {
        scopeIds.add(current.native_session_id);
      }
      const pendingNative = deps.connection
        .prepare<SqlRow>(
          `SELECT DISTINCT native_session_id FROM host_runtime_call
            WHERE registration_hash = :registration_hash
              AND state = 'pending' AND deadline_at > :now
              AND native_session_id IS NOT NULL`
        )
        .all({ registration_hash: current.registration_hash, now });
      for (const row of pendingNative) {
        const nativeId = asNullableString(row, "native_session_id");
        if (nativeId !== null) {
          scopeIds.add(nativeId);
        }
      }
      const expectedScopes = new Map<string, StableEventScope | null>();
      for (const nativeId of scopeIds) {
        const scope = await deps.session_scope.get({
          host_id: current.host_id,
          config_space: current.config_space,
          native_session_id: nativeId,
          remaining_ms: Math.max(1, context.remaining_ms),
          signal: context.signal
        });
        if (!scope.ok) {
          return scope;
        }
        expectedScopes.set(nativeId, scope.value);
      }

      deps.connection.exec("BEGIN IMMEDIATE");
      let claimed: HostRuntimeCallRow | null = null;
      let skipped: HostRuntimeCallRow | null = null;
      try {
        deps.connection
          .prepare(
            `UPDATE host_runtime_call SET state = 'expired', updated_at = :now
              WHERE registration_hash = :registration_hash
                AND state = 'pending' AND deadline_at <= :now`
          )
          .run({ now, registration_hash: current.registration_hash });
        deps.connection
          .prepare(
            `UPDATE host_runtime_call SET state = 'uncertain', updated_at = :now
              WHERE registration_hash = :registration_hash
                AND state = 'issued' AND deadline_at <= :now`
          )
          .run({ now, registration_hash: current.registration_hash });
        // Probe/check-load intent rows start with no boundary. They may only
        // be claimed once this runtime presents a real receipt that maps to a
        // committed trigger event; the producer arms them synchronously here.
        if (request.event_identity_key !== null && request.hook_event !== null) {
          runPollIntentHook(() => {
            deps.lifecycle?.onSessionPoll?.({
              session: current,
              event_identity_key: request.event_identity_key,
              hook_event: request.hook_event,
              now
            });
          });
        }
        const candidates = deps.connection
          .prepare<SqlRow>(
            `SELECT ${CALL_COLUMNS} FROM host_runtime_call
              WHERE registration_hash = :registration_hash
                AND state = 'pending' AND deadline_at > :now
              ORDER BY CASE
                         WHEN native_session_id = :current_native THEN 0
                         WHEN native_session_id IS NULL THEN 1
                         ELSE 2
                       END,
                       created_at ASC, call_id ASC`
          )
          .all({
            registration_hash: current.registration_hash,
            now,
            current_native: current.native_session_id ?? ""
          });
        if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
          process.stderr.write(
            `evoplug kernel: poll_candidates count=${String(candidates.length)} boundary=${String(request.event_identity_key)} hook=${String(request.hook_event)}\n`
          );
        }
        for (const candidate of candidates) {
          const row = callFromRow(candidate);
          if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
            process.stderr.write(
              `evoplug kernel: poll_call_probe call=${row.call_id} state=${row.state} boundary=${String(row.boundary_event_key)} hook=${String(row.hook_event)} request_boundary=${String(request.event_identity_key)} request_hook=${String(request.hook_event)}\n`
            );
          }
          if (row.boundary_event_key !== request.event_identity_key) {
            continue;
          }
          if (row.hook_event !== request.hook_event) {
            continue;
          }
          // A probe/confirmation call belongs to one native session. The
          // resident runtime serves many native sessions, so a sibling
          // session's poll with the same trigger key must not render (and
          // answer) a dialog meant for another session. Delivery calls keep
          // the broader scope rule below.
          if (
            row.kind === "probe" &&
            row.native_session_id !== null &&
            row.native_session_id !== current.native_session_id
          ) {
            continue;
          }
          if (row.kind === "deliver") {
            const scopeIdsForCall: string[] = [];
            if (row.native_session_id !== null) {
              scopeIdsForCall.push(row.native_session_id);
            }
            if (
              current.native_session_id !== null &&
              current.native_session_id !== row.native_session_id
            ) {
              scopeIdsForCall.push(current.native_session_id);
            }
            let matches = false;
            for (const nativeId of scopeIdsForCall) {
              const expectedScope = expectedScopes.get(nativeId);
              if (
                expectedScope !== undefined &&
                expectedScope !== null &&
                row.goal_version === expectedScope.goal_version &&
                row.config_version === expectedScope.config_version &&
                row.input_epoch === expectedScope.input_epoch
              ) {
                matches = true;
                break;
              }
            }
            if (!matches) {
              continue;
            }
          }
          const update = deps.connection
            .prepare(
              `UPDATE host_runtime_call SET
                 state = 'issued',
                 issued_session_id = :issued_session_id,
                 issued_at = :issued_at,
                 updated_at = :issued_at
               WHERE call_id = :call_id AND state = 'pending'`
            )
            .run({
              issued_session_id: current.session_id,
              issued_at: now,
              call_id: row.call_id
            });
          if (update.changes === 1) {
            claimed = { ...row, state: "issued", issued_session_id: current.session_id, issued_at: now, updated_at: now };
            break;
          }
        }
        deps.connection.exec("COMMIT");
      } catch (error) {
        try {
          deps.connection.exec("ROLLBACK");
        } catch {
          // ignore secondary rollback failure
        }
        throw error;
      }

      if (claimed !== null) {
        if (deps.call_resolver === undefined) {
          deps.connection
            .prepare(
              `UPDATE host_runtime_call SET state = 'uncertain', updated_at = :now
                WHERE call_id = :call_id AND state = 'issued'`
            )
            .run({ now: deps.now(), call_id: claimed.call_id });
          return err(internalRuntimeError("kernel.host_runtime_call_resolver_unavailable"));
        }
        const resolved = await deps.call_resolver.resolve({
          row: claimed,
          session: current,
          now: deps.now(),
          delivery_max_chars: limits.delivery_max_chars
        });
        if (!resolved.ok) {
          deps.connection
            .prepare(
              `UPDATE host_runtime_call SET state = 'uncertain', updated_at = :now
                WHERE call_id = :call_id AND state = 'issued'`
            )
            .run({ now: deps.now(), call_id: claimed.call_id });
          return resolved;
        }
        if (resolved.value === null) {
          deps.connection
            .prepare(
              `UPDATE host_runtime_call SET state = 'expired', updated_at = :now
                WHERE call_id = :call_id AND state = 'issued'`
            )
            .run({ now: deps.now(), call_id: claimed.call_id });
          skipped = claimed;
        } else {
          touchSession(current);
          return ok({
            kind: "call",
            call: boundCall(resolved.value, claimed, deps.now(), limits.delivery_max_chars)
          });
        }
      }

      if (skipped !== null) {
        continue;
      }
      if (deps.now() >= waitDeadline) {
        touchSession(current);
        return ok({ kind: "none", call: null });
      }
      runLifecycleHook(() =>
        deps.lifecycle?.onPollObserved?.({ session: current, now: deps.now() })
      );
      await sleep(Math.min(pollInterval, Math.max(1, waitDeadline - deps.now())));
    }
  }

  async function poll(
    context: IpcHandlerContext<"host.runtime.poll">
  ): Promise<Result<HostRuntimePollResult, ErrorEnvelope>> {
    if (!clientKindAllowed(context)) {
      return err(forbiddenError(context));
    }
    if (deps.call_resolver === undefined) {
      return err(internalRuntimeError("kernel.host_runtime_call_resolver_unavailable"));
    }
    const parsed = parsePollRequest(context.params);
    if (!parsed.ok) {
      return parsed;
    }
    const request = parsed.value;
    if (request.wait_ms > limits.poll_wait_max_ms) {
      return err(fieldError("wait_ms", "above_poll_wait_max_ms"));
    }
    // A revoked/failed session or a binding that left `applied` is a shutdown,
    // not a generic auth failure: the runtime must stop injecting.
    const existing = readSession(deps.connection, request.session_id);
    if (
      existing !== null &&
      existing.session_nonce === request.session_nonce &&
      existing.adapter_id === context.client_id &&
      (existing.state === "revoked" ||
        existing.state === "failed" ||
        !isRegistrationApplied(deps.connection, existing.registration_hash))
    ) {
      revokeHostRuntimeSessions({
        connection: deps.connection,
        now: deps.now(),
        registration_hash: existing.registration_hash
      });
      return ok({ kind: "shutdown", call: null });
    }
    const authenticated = authenticate(request.session_id, request.session_nonce, context);
    if (!authenticated.ok) {
      return authenticated;
    }
    const session = authenticated.value;
    if (activePolls.has(session.session_id)) {
      return err(busyError());
    }
    activePolls.add(session.session_id);
    try {
      return await waitForCall(session, request, context);
    } finally {
      activePolls.delete(session.session_id);
    }
  }

  async function result(
    context: IpcHandlerContext<"host.runtime.result">
  ): Promise<Result<HostRuntimeResultResult, ErrorEnvelope>> {
    if (!clientKindAllowed(context)) {
      return err(forbiddenError(context));
    }
    const parsed = parseResultRequest(context.params);
    if (!parsed.ok) {
      return parsed;
    }
    const request = parsed.value;
    const authenticated = authenticate(request.session_id, request.session_nonce, context);
    if (!authenticated.ok) {
      return authenticated;
    }
    const session = authenticated.value;

    let rawResult = request.result;
    if (rawResult.kind === "deliver" && rawResult.state === "completed") {
      const sanitized = sanitizeDeliveryResult(rawResult.result);
      rawResult = { ...rawResult, result: sanitized.result };
    }
    if (rawResult.kind === "probe" && rawResult.state === "observed") {
      // Runtime probes are self-attested: cap the claimed stage at `loaded`
      // and never let a claimed `verified` through (DD-HOST-206).
      const observation = rawResult.observation;
      const claimedStage = observation.claimed_evidence_stage;
      const cappedStage =
        claimedStage === undefined ||
        claimedStage === "none" ||
        claimedStage === "static" ||
        claimedStage === "loaded"
          ? claimedStage
          : "loaded";
      rawResult = {
        ...rawResult,
        observation: {
          ...observation,
          ...(cappedStage === undefined ? {} : { claimed_evidence_stage: cappedStage }),
          claimed_status:
            observation.claimed_status === "unsupported" || observation.claimed_status === "failed"
              ? observation.claimed_status
              : "unknown"
        }
      };
    }
    let now = deps.now();
    const preCall = readCall(deps.connection, request.call_id);
    let issuedSnapshot: IssuedResultSnapshot | null = null;
    if (
      preCall !== null &&
      preCall.state === "issued" &&
      preCall.issued_session_id === session.session_id &&
      preCall.registration_hash === session.registration_hash &&
      preCall.kind === rawResult.kind &&
      (rawResult.kind === "check_load" || rawResult.kind === "probe")
    ) {
      if (!validateResultAgainstCall(preCall, rawResult)) {
        return err(conflictError("result", "object_ref_mismatch"));
      }
      // The immutable request is not in the call row. Resolve it outside the
      // SQLite transaction; the transaction below re-checks the row identity,
      // state and issuing session before recording anything.
      const validated = await validateIssuedResultAgainstRequest(
        deps,
        preCall,
        session,
        rawResult,
        limits
      );
      if (!validated.ok) {
        return validated;
      }
      issuedSnapshot = preCall;
      now = deps.now();
    }

    const resultHash = canonicalHash(rawResult as unknown as JsonValue);

    deps.connection.exec("BEGIN IMMEDIATE");
    let outcome: Result<HostRuntimeResultResult, ErrorEnvelope>;
    try {
      const call = readCall(deps.connection, request.call_id);
      if (call === null) {
        outcome = err(conflictError("call_id", "not_found"));
      } else if (call.registration_hash !== session.registration_hash) {
        outcome = err(conflictError("call_id", "cross_binding"));
      } else if (call.state === "completed") {
        outcome =
          call.result_hash === null || call.result_hash === resultHash
            ? ok({ recorded: true })
            : err(
                runtimeError("E_IDEMPOTENCY_CONFLICT", "host_runtime_result", "conflict", {
                  kind: "idempotency",
                  key: call.call_id,
                  existing_hash: call.result_hash,
                  incoming_hash: resultHash
                })
              );
      } else if (call.state === "issued") {
        if (call.issued_session_id !== session.session_id) {
          outcome = err(conflictError("session_id", "cross_session"));
        } else if (
          (rawResult.kind === "check_load" || rawResult.kind === "probe") &&
          issuedSnapshot === null
        ) {
          // The request-dependent gate ran before the transaction. A call that
          // became issued after that read has not been checked; refusing is
          // safer than recording an unvalidated probe/load result.
          outcome = err(conflictError("call_id", "result_not_validated"));
        } else if (issuedSnapshot !== null && !sameIssuedCall(issuedSnapshot, call)) {
          outcome = err(conflictError("call_id", "call_changed"));
        } else if (!validateResultAgainstCall(call, rawResult)) {
          outcome = err(conflictError("result", "object_ref_mismatch"));
        } else if (
          rawResult.kind === "deliver" &&
          rawResult.state === "not_injected"
        ) {
          deps.connection
            .prepare(
              `UPDATE host_runtime_call SET
                 state = 'pending',
                 issued_session_id = NULL,
                 issued_at = NULL,
                 updated_at = :now
               WHERE call_id = :call_id AND state = 'issued'`
            )
            .run({ now, call_id: call.call_id });
          outcome = ok({ recorded: true });
        } else if (now > call.deadline_at) {
          deps.connection
            .prepare(
              `UPDATE host_runtime_call SET
                 state = 'uncertain',
                 result_hash = :result_hash,
                 result_ref = NULL,
                 updated_at = :now
               WHERE call_id = :call_id AND state = 'issued'`
            )
            .run({ now, result_hash: resultHash, call_id: call.call_id });
          outcome = ok({ recorded: true });
        } else {
          deps.connection
            .prepare(
              `UPDATE host_runtime_call SET
                 state = 'completed',
                 result_hash = :result_hash,
                 result_ref = NULL,
                 updated_at = :now
               WHERE call_id = :call_id AND state = 'issued'`
            )
            .run({ now, result_hash: resultHash, call_id: call.call_id });
          outcome = ok({ recorded: true });
        }
      } else if (call.state === "uncertain" || call.state === "expired") {
        if (call.result_hash === null) {
          deps.connection
            .prepare(
              `UPDATE host_runtime_call SET result_hash = :result_hash, updated_at = :now
                WHERE call_id = :call_id`
            )
            .run({ now, result_hash: resultHash, call_id: call.call_id });
          outcome = ok({ recorded: true });
        } else if (call.result_hash === resultHash) {
          outcome = ok({ recorded: true });
        } else {
          outcome = err(
            runtimeError("E_IDEMPOTENCY_CONFLICT", "host_runtime_result", "conflict", {
              kind: "idempotency",
              key: call.call_id,
              existing_hash: call.result_hash,
              incoming_hash: resultHash
            })
          );
        }
      } else {
        outcome = err(conflictError("call_id", "not_issued"));
      }
      deps.connection.exec("COMMIT");
    } catch (error) {
      try {
        deps.connection.exec("ROLLBACK");
      } catch {
        // ignore secondary rollback failure
      }
      throw error;
    }
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug kernel: result_applied call=${request.call_id} kind=${rawResult.kind} ok=${String(outcome.ok)} issued_snapshot=${String(issuedSnapshot !== null)} error=${String(outcome.ok ? null : outcome.error.code)} at=${String(deps.now())}\n`
      );
    }
    if (
      outcome.ok &&
      issuedSnapshot !== null &&
      (rawResult.kind === "probe" || rawResult.kind === "check_load")
    ) {
      const completed = readCall(deps.connection, request.call_id);
      if (completed !== null && completed.state === "completed") {
        runLifecycleHook(() =>
          deps.lifecycle?.onCallCompleted?.({
            row: completed,
            session,
            result: rawResult
          })
        );
      }
    }
    if (outcome.ok) {
      touchSession(session);
    }
    return outcome;
  }

  return {
    "host.runtime.ready": async (context) => ready(context),
    "host.runtime.upload": (context) => upload(context),
    "host.runtime.poll": (context) => poll(context),
    "host.runtime.result": (context) => result(context)
  };
}
