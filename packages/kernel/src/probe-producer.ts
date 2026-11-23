/**
 * Runtime probe producer (W1/D6).
 *
 * This module turns the dormant `check_load` / `probe` call kinds into a real
 * producer/consumer chain:
 *
 * 1. `schedule` inserts one pending `probe` call and one `check_load` call for
 *    an applied registration. The rows have a null boundary, so the runtime can
 *    never claim them before it has a real receipt.
 * 2. `call_resolver` builds the immutable request from committed rows only.
 *    `host_runtime.poll` arms a null-boundary row with the receipt key of a real
 *    trigger event; the trigger's `host_binding` supplies the request binding.
 * 3. `onCallCompleted` re-reads every evidence reference, builds a
 *    `HostProbeRecord/2`, applies it through `applyProbeToCapability`, and
 *    appends `host_probe` + `capability_record` state rows through the FND
 *    append seam.
 *
 * Invariants enforced here:
 * - a runtime self-report can raise evidence at most to `loaded`;
 * - `verified` requires a nonce echo *and* an independently retrievable
 *   provider body or delivery receipt containing that nonce;
 * - a newer probe that does not re-verify a previously verified capability
 *   downgrades it to `unknown` (version/artifact change invalidation);
 * - nothing is guessed: a missing binding declaration, trigger binding or
 *   evidence reference leaves the capability unchanged and records a
 *   diagnostic.
 */

import {
  canonicalHash,
  canonicalJsonText,
  err,
  formatSourceRef,
  hashBytes,
  isId,
  isSourceRef,
  makeErrorEnvelope,
  newId,
  ok,
  parseSourceRef,
  toJsonValue,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type JsonValue,
  type Result,
  type SourceRef
} from "@evoplug/core";
import type { AdapterDescriptor, CapabilityBinding, CapabilityName, CapabilityRecord, HostEventBinding, HostProbeCapabilityResult, HostProbeRecord, HostProbeResult, LoadBoundary, RuntimeCall } from "@evoplug/core/host";
import {
  applyProbeToCapability,
  capabilityBindingKey,
  eventIdentityKey,
  makeUnknownCapabilityRecord,
  toCapabilityRecordPhysicalRow,
  toHostProbePhysicalRow,
  validateAdapterDescriptor,
  validateCapabilityBinding,
  validateHostProbeRecord
} from "@evoplug/core/host";
import type {
  HostStateRowAppendPort,
  HostStateRowInsertion
} from "@evoplug/core/host";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import type {
  HostRuntimeCallCompletion,
  HostRuntimeCallResolverPort,
  HostRuntimeCallRow,
  HostRuntimeProbeLifecyclePort,
  HostRuntimeSessionRow
} from "./host-runtime.js";
import { RUNTIME_PROBE_CAPABILITIES } from "./host-runtime.js";
import {
  insertRuntimeCall,
  readTriggerHostBinding
} from "./runtime-delivery-bridge.js";
import {
  declareCapabilityBinding,
  probeUnsupportedError,
  type CapabilityBindingDeclarationPort,
  type ProbeBindingRegistrationFacts
} from "./probe-binding.js";

/* ------------------------------------------------------------------ */
/* Public options                                                      */
/* ------------------------------------------------------------------ */

export interface ProbeFeatureOptions {
  /** Master switch. W1 ships with this false and no environment override. */
  readonly enabled: boolean;
  /** Run the first probe from `host-attach`; the kernel option, not a host flag. */
  readonly on_attach: boolean;
  /** Runtime-observable capabilities this build probes. */
  readonly capabilities: readonly CapabilityName[];
  /** Duplicate suppression for the same registration/artifact. */
  readonly dedupe_window_ms: number;
  /** How long an unarmed attach-intent row may wait for a real receipt. */
  readonly intent_ttl_ms: number;
  /** Deadline the runtime sees for one probe turn. */
  readonly probe_deadline_ms: number;
  /** Also probe whether the runtime host loaded the written artifact. */
  readonly check_load: boolean;
  /** Cap on bytes read from one evidence reference. */
  readonly max_evidence_bytes: number;
}

const PROBE_DEDUPE_WINDOW_MS: number = 24 * 60 * 60 * 1_000;
export const PROBE_INTENT_TTL_MS: number = 24 * 60 * 60 * 1_000;
const PROBE_DEADLINE_MS: number = 30_000;
const PROBE_MAX_EVIDENCE_BYTES: number = 8_388_608;

const DEFAULT_PROBE_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "stable_boundary",
  "input_capture",
  "compaction_event",
  "association"
]);

/** Fills defaults without ever turning the feature on implicitly. */
function resolveProbeFeatureOptions(
  partial: Partial<ProbeFeatureOptions> | undefined
): ProbeFeatureOptions {
  const capabilities = (partial?.capabilities ?? DEFAULT_PROBE_CAPABILITIES).filter(
    (name) => RUNTIME_PROBE_CAPABILITIES.has(name)
  );
  return {
    enabled: partial?.enabled === true,
    on_attach: partial?.on_attach !== false,
    capabilities: [...new Set(capabilities)],
    dedupe_window_ms: positiveInt(partial?.dedupe_window_ms, PROBE_DEDUPE_WINDOW_MS),
    intent_ttl_ms: positiveInt(partial?.intent_ttl_ms, PROBE_INTENT_TTL_MS),
    probe_deadline_ms: positiveInt(partial?.probe_deadline_ms, PROBE_DEADLINE_MS),
    check_load: partial?.check_load !== false,
    max_evidence_bytes: positiveInt(partial?.max_evidence_bytes, PROBE_MAX_EVIDENCE_BYTES)
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/* ------------------------------------------------------------------ */
/* Public contracts                                                    */
/* ------------------------------------------------------------------ */

interface RuntimeProbeProducerDeps {
  readonly connection: SqliteConnection;
  readonly blobs: {
    putSync(bytes: Uint8Array): Result<
      { readonly hash: Hash; readonly byte_length: number; readonly relative_path: string },
      ErrorEnvelope
    >;
    /**
     * Direct content-addressed read. The kernel collector persists its own
     * observation blobs with `putSync`, which does not insert a `blob` table
     * row; the source-ref port therefore reports them missing even though the
     * bytes are present. Reading the verified blob file by hash is the same
     * trust domain and does not accept runtime-authored refs.
     */
    read?(hash: Hash): Result<Uint8Array, ErrorEnvelope>;
  };
  readonly source_refs: {
    resolve(
      ref: SourceRef,
      opts?: { maxBytes?: number }
    ): Promise<
      Result<
        {
          readonly bytes: Uint8Array | null;
          readonly length: number;
          readonly retrievable: boolean;
        },
        ErrorEnvelope
      >
    >;
  };
  readonly state_rows: HostStateRowAppendPort;
  readonly binding?: CapabilityBindingDeclarationPort;
  /** Kernel-owned evidence collector; absent caps every result at `loaded`. */
  readonly evidence?: KernelProbeEvidencePort;
  readonly options?: Partial<ProbeFeatureOptions>;
  readonly now: () => number;
  readonly allocate_probe_id?: () => Id<"prb">;
  readonly allocate_capability_id?: () => Id<"cap">;
  readonly allocate_check_load_id?: () => string;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}

interface ProbeScheduleInput {
  readonly registration_hash: Hash;
  /** Optional caller observation; the committed registration row wins. */
  readonly artifact_hash?: Hash;
}

interface ProbeScheduleOutcome {
  readonly status: "disabled" | "probe_unsupported" | "scheduled" | "existing" | "stopped";
  readonly scheduled: readonly ("probe" | "check_load")[];
  readonly expired: number;
}

interface ProbeApplyOutcome {
  readonly status: "disabled" | "duplicate" | "applied" | "skipped" | "stopped";
  readonly rule?: string;
  readonly probe_id?: Id<"prb">;
  readonly applied_capabilities: readonly CapabilityName[];
}

interface RuntimeProbeStopInput {
  /** Bounded diagnostic label; never persisted or sent to a host. */
  readonly reason?: string;
}

/**
 * Durable outcome of a producer stop. `pending_expired` calls never left the
 * kernel, so they may be scheduled again. `issued_uncertain` calls may have
 * reached the host, so they are terminal for resend until the normal dedupe
 * window and are never re-issued by this producer.
 */
interface RuntimeProbeStopOutcome {
  readonly status: "stopped" | "already_stopped";
  readonly pending_expired: number;
  readonly issued_uncertain: number;
}

/**
 * Kernel-owned evidence collector (W1 security boundary).
 *
 * The runtime can upload any blob it likes, and a blob that is retrievable and
 * contains the nonce proves only that the runtime uploaded those bytes. A
 * capability therefore reaches `roundtrip` only when a kernel-owned collector,
 * which observes the provider path itself (egress log, provider receipt store,
 * transcript collector), persists a record that is explicitly associated with
 * this call, session, binding and nonce. Without a collector the producer caps
 * every observation at `loaded`.
 */
export interface KernelProbeEvidenceRequest {
  readonly kind: "probe" | "check_load";
  readonly call_id: string;
  /** The nonce the runtime saw: `probe_id` for probe, `request_id` for load. */
  readonly nonce: string;
  readonly session_id: Id<"rts">;
  readonly registration_hash: Hash;
  readonly artifact_hash: Hash;
  readonly binding_key: Hash;
  readonly capabilities: readonly CapabilityName[];
  /** Requested load boundary; only `check_load` carries one. */
  readonly load_boundary?: LoadBoundary;
  readonly issued_at: number;
  readonly deadline_at: number;
  readonly now: number;
}

/** One persisted collector record. Every association field is mandatory. */
export interface KernelProbeEvidence {
  readonly collector_id: string;
  readonly kind: "probe" | "check_load";
  readonly call_id: string;
  readonly nonce: string;
  readonly session_id: Id<"rts">;
  /** Session the call was issued to; equals `session_id` unless a verified child observed it. */
  readonly call_session_id: Id<"rts">;
  readonly registration_hash: Hash;
  readonly binding_key: Hash;
  readonly artifact_hash?: Hash;
  /** Capabilities this evidence actually demonstrates through the provider path. */
  readonly capabilities: readonly CapabilityName[];
  /**
   * Collector-owned refs. Runtime-supplied `provider_body_ref`/`receipt_ref`
   * are audit facts in the observation payload and are never accepted here.
   */
  readonly nonce_evidence_ref?: string;
  readonly evidence_refs: readonly string[];
  readonly observed_at: number;
}

export interface KernelProbeEvidencePort {
  collect(
    input: KernelProbeEvidenceRequest
  ): Promise<Result<KernelProbeEvidence | null, ErrorEnvelope>>;
}

interface VerifiedCollectorEvidence {
  readonly capabilities: ReadonlySet<CapabilityName>;
  readonly refs: readonly string[];
}

export interface RuntimeProbeProducer {
  readonly options: ProbeFeatureOptions;
  readonly lifecycle: HostRuntimeProbeLifecyclePort;
  readonly call_resolver: HostRuntimeCallResolverPort;
  schedule(input: ProbeScheduleInput): Promise<Result<ProbeScheduleOutcome, ErrorEnvelope>>;
  applyCompletion(
    input: HostRuntimeCallCompletion
  ): Promise<Result<ProbeApplyOutcome, ErrorEnvelope>>;
  /**
   * Resolves after every lifecycle-started async schedule/apply completion has
   * settled. Shutdown must await this before closing the journal or database.
   */
  drain(): Promise<void>;
  /**
   * Stops producing work before the host IPC channel closes.
   *
   * New schedules, resolver claims, poll arming and completions are refused.
   * Pending calls become `expired` (no external effect); issued calls become
   * `uncertain` (may have reached the host, durable fail-closed, never
   * re-issued). External evidence waits are abandoned at their next
   * checkpoint, so shutdown does not depend on a host that can no longer
   * answer. Idempotent.
   */
  stop(input?: RuntimeProbeStopInput): Result<RuntimeProbeStopOutcome, ErrorEnvelope>;
}

/* ------------------------------------------------------------------ */
/* Wire observation payload (produced by host-runtime/src/probe.ts)     */
/* ------------------------------------------------------------------ */

const OBSERVATION_PAYLOAD_SCHEMA = "rsi.runtime_probe_observation/1" as const;

interface ObservedCapabilityVerdict {
  readonly name: CapabilityName;
  readonly pass: boolean | "unknown";
  readonly failure_code?: string;
  readonly evidence_refs: readonly string[];
}

interface ObservedPayload {
  readonly nonce: string;
  readonly echo: "none" | "assistant_output" | "provider_body" | "receipt";
  readonly capabilities: readonly ObservedCapabilityVerdict[];
  readonly provider_body_ref?: string;
  readonly receipt_ref?: string;
  readonly blocker?: {
    readonly kind: string;
    readonly code: string;
    readonly detail_ref: string;
    readonly retry_allowed: boolean;
  };
}

const BLOCKER_KINDS: ReadonlySet<string> = new Set([
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
]);

function parseObservedPayload(value: JsonValue): ObservedPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, JsonValue>;
  if (record["schema_version"] !== OBSERVATION_PAYLOAD_SCHEMA) {
    return null;
  }
  const nonce = record["nonce"];
  if (typeof nonce !== "string") {
    return null;
  }
  const echo = record["echo"];
  if (
    echo !== "none" &&
    echo !== "assistant_output" &&
    echo !== "provider_body" &&
    echo !== "receipt"
  ) {
    return null;
  }
  const rawCapabilities = record["capabilities"];
  if (!Array.isArray(rawCapabilities)) {
    return null;
  }
  const capabilities: ObservedCapabilityVerdict[] = [];
  for (const entry of rawCapabilities) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const capability = entry as Record<string, JsonValue>;
    const name = capability["name"];
    const pass = capability["pass"];
    if (typeof name !== "string" || !RUNTIME_PROBE_CAPABILITIES.has(name as CapabilityName)) {
      return null;
    }
    if (pass !== true && pass !== false && pass !== "unknown") {
      return null;
    }
    const refs = capability["evidence_refs"];
    if (refs !== undefined && (!Array.isArray(refs) || !refs.every((ref) => typeof ref === "string"))) {
      return null;
    }
    capabilities.push({
      name: name as CapabilityName,
      pass,
      ...(typeof capability["failure_code"] === "string"
        ? { failure_code: capability["failure_code"] }
        : {}),
      evidence_refs: refs === undefined ? [] : (refs as string[])
    });
  }
  const blockerValue = record["blocker"];
  let blocker: ObservedPayload["blocker"];
  if (blockerValue !== undefined) {
    if (typeof blockerValue !== "object" || blockerValue === null || Array.isArray(blockerValue)) {
      return null;
    }
    const raw = blockerValue as Record<string, JsonValue>;
    if (
      typeof raw["kind"] !== "string" ||
      !BLOCKER_KINDS.has(raw["kind"]) ||
      typeof raw["code"] !== "string" ||
      typeof raw["detail_ref"] !== "string" ||
      typeof raw["retry_allowed"] !== "boolean"
    ) {
      return null;
    }
    blocker = {
      kind: raw["kind"],
      code: raw["code"],
      detail_ref: raw["detail_ref"],
      retry_allowed: raw["retry_allowed"]
    };
  }
  return {
    nonce,
    echo,
    capabilities,
    ...(typeof record["provider_body_ref"] === "string"
      ? { provider_body_ref: record["provider_body_ref"] }
      : {}),
    ...(typeof record["receipt_ref"] === "string" ? { receipt_ref: record["receipt_ref"] } : {}),
    ...(blocker === undefined ? {} : { blocker })
  };
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

interface RegistrationRow {
  readonly registration_hash: Hash;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly host_id: HostRuntimeSessionRow["host_id"];
  readonly mode: HostRuntimeSessionRow["mode"];
  readonly config_space: string;
  readonly target_id: string;
  readonly artifact_hash: Hash;
  readonly written_hash: Hash | null;
}

interface DescriptorSnapshot {
  readonly descriptor_hash: Hash;
  readonly descriptor: AdapterDescriptor;
}

interface CapabilityRowView {
  readonly record: CapabilityRecord;
  readonly row_version: number;
}

function asString(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function asNullableString(row: SqlRow, key: string): string | null {
  return typeof row[key] === "string" ? (row[key] as string) : null;
}

function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function asNullableNumber(row: SqlRow, key: string): number | null {
  return typeof row[key] === "number" ? (row[key] as number) : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readRegistration(
  connection: SqliteConnection,
  registrationHash: string
): RegistrationRow | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT registration_hash, adapter_id, adapter_version, host_id, mode,
              config_space, target_id, artifact_hash, written_hash
         FROM adapter_registration
        WHERE registration_hash = :registration_hash AND state = 'applied'`
    )
    .get({ registration_hash: registrationHash });
  if (row === undefined) {
    return null;
  }
  return {
    registration_hash: asString(row, "registration_hash") as Hash,
    adapter_id: asString(row, "adapter_id") as Id<"adp">,
    adapter_version: asString(row, "adapter_version"),
    host_id: asString(row, "host_id") as HostRuntimeSessionRow["host_id"],
    mode: asString(row, "mode") as HostRuntimeSessionRow["mode"],
    config_space: asString(row, "config_space"),
    target_id: asString(row, "target_id"),
    artifact_hash: asString(row, "artifact_hash") as Hash,
    written_hash: asNullableString(row, "written_hash") as Hash | null
  };
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
  const parsed = parseJsonObject(asString(row, "descriptor_json"));
  if (parsed === null) {
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

interface CommittedReceiptEvent {
  readonly event_id: string;
  readonly event_key: Hash;
  readonly event_type: "input.received" | "host.boundary";
  readonly host_id: string;
  readonly config_space: string;
  readonly session_id: string;
  readonly input_id: string | null;
  readonly occurred_at: number;
  readonly received_at: number;
  readonly source_seq: number | null;
  readonly watermark: number;
  readonly content_ref: SourceRef | null;
  readonly content_hash: Hash | null;
}

interface DerivedReceiptBinding {
  readonly binding: HostEventBinding;
  readonly event_id: string;
  readonly content_ref: SourceRef | null;
  readonly content_hash: Hash | null;
}

type ReceiptBindingLookup =
  | { readonly status: "none" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "ok"; readonly value: DerivedReceiptBinding };

function readCommittedReceiptEvent(
  connection: SqliteConnection,
  eventIdentityKey: Hash
): CommittedReceiptEvent | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT event_id, event_key, event_type, commit_seq, host_id, config_space,
              session_id, input_id, occurred_at, received_at, source_seq, watermark,
              content_ref, content_hash
         FROM event_log
        WHERE event_key = :event_key
        LIMIT 1`
    )
    .get({ event_key: eventIdentityKey });
  if (row === undefined) {
    return null;
  }
  const eventType = row["event_type"];
  const commitSeq = row["commit_seq"];
  const watermark = row["watermark"];
  if (
    typeof row["event_id"] !== "string" ||
    typeof row["event_key"] !== "string" ||
    (eventType !== "input.received" && eventType !== "host.boundary") ||
    typeof row["host_id"] !== "string" ||
    typeof row["config_space"] !== "string" ||
    typeof row["session_id"] !== "string" ||
    typeof row["occurred_at"] !== "number" ||
    typeof row["received_at"] !== "number" ||
    typeof commitSeq !== "number" ||
    !Number.isSafeInteger(commitSeq) ||
    commitSeq <= 0 ||
    typeof watermark !== "number" ||
    !Number.isSafeInteger(watermark) ||
    watermark <= 0 ||
    !(row["input_id"] === null || typeof row["input_id"] === "string") ||
    !(row["source_seq"] === null || (typeof row["source_seq"] === "number" && Number.isSafeInteger(row["source_seq"])))
  ) {
    return null;
  }
  const rawRef = row["content_ref"];
  const rawHash = row["content_hash"];
  if (
    !(rawRef === null || typeof rawRef === "string") ||
    !(rawHash === null || typeof rawHash === "string")
  ) {
    return null;
  }
  if (eventType === "input.received" && (rawRef === null || rawHash === null || !isSourceRef(rawRef))) {
    return null;
  }
  return {
    event_id: row["event_id"],
    event_key: row["event_key"] as Hash,
    event_type: eventType,
    host_id: row["host_id"],
    config_space: row["config_space"],
    session_id: row["session_id"],
    input_id: row["input_id"] as string | null,
    occurred_at: row["occurred_at"],
    received_at: row["received_at"],
    source_seq: row["source_seq"] as number | null,
    watermark,
    content_ref: rawRef === null ? null : (rawRef as SourceRef),
    content_hash: rawHash === null ? null : (rawHash as Hash)
  };
}

/**
 * Rebuilds the exact `HostEventBinding` of one committed authenticated runtime
 * upload without a `trigger_event`.
 *
 * Every coordinate comes from a row the runtime cannot author:
 * - the runtime session comes from the kernel session table;
 * - the event must be a committed `input.received`/`host.boundary` row whose
 *   host, config space and FND session match that authenticated session;
 * - `host_runtime_upload.receipt_ref`/`session_id` must link the exact event
 *   back to the authenticated upload (and its raw blob must still exist);
 * - the applied registration and its descriptor snapshot must still describe
 *   this session, and the descriptor must declare the polled host event;
 * - `native_id_map` supplies the one native message id the event identity
 *   used, when present.
 *
 * The candidate binding is accepted only when recomputing
 * `event_identity_key` from those facts equals the committed `event_log` key.
 * Any absent or ambiguous fact rejects the receipt; nothing is synthesized.
 * Delivery stays trigger-gated because this helper never writes a trigger.
 */
function deriveCommittedReceiptBinding(
  connection: SqliteConnection,
  input: {
    readonly session: HostRuntimeSessionRow;
    readonly event_identity_key: Hash;
    readonly hook_event: string | null;
    readonly now: number;
  }
): ReceiptBindingLookup {
  const session = input.session;
  if (input.hook_event === null || input.hook_event.length === 0) {
    return { status: "rejected", reason: "hook_event_missing" };
  }
  if (
    session.state !== "ready" ||
    session.lease_expires_at <= input.now ||
    session.native_session_id === null ||
    session.native_session_id.length === 0
  ) {
    return { status: "rejected", reason: "session_not_ready" };
  }
  const nativeSessionId = session.native_session_id;
  const registration = readRegistration(connection, session.registration_hash);
  if (registration === null) {
    return { status: "rejected", reason: "registration_not_applied" };
  }
  if (
    registration.host_id !== session.host_id ||
    registration.mode !== session.mode ||
    registration.config_space !== session.config_space ||
    registration.adapter_id !== session.adapter_id ||
    registration.adapter_version !== session.adapter_version
  ) {
    return { status: "rejected", reason: "registration_scope_mismatch" };
  }
  const snapshot = readSnapshot(connection, session.registration_hash);
  if (snapshot === null) {
    return { status: "rejected", reason: "descriptor_snapshot_missing" };
  }
  const descriptor = snapshot.descriptor;
  if (
    descriptor.host_id !== session.host_id ||
    descriptor.adapter_id !== session.adapter_id ||
    descriptor.adapter_version !== session.adapter_version ||
    descriptor.implementation_hash !== session.implementation_hash ||
    !descriptor.supported_modes.includes(session.mode) ||
    !descriptor.config_spaces.includes(session.config_space)
  ) {
    return { status: "rejected", reason: "descriptor_scope_mismatch" };
  }
  const event = readCommittedReceiptEvent(connection, input.event_identity_key);
  if (event === null) {
    // Not every polled receipt is a boundary candidate; a later poll may carry
    // one. This is not an error and must not be reported as one.
    return { status: "none" };
  }
  if (event.host_id !== session.host_id || event.config_space !== session.config_space) {
    return { status: "rejected", reason: "event_scope_mismatch" };
  }
  const nativeSession = connection
    .prepare<SqlRow>(
      `SELECT session_id FROM session
        WHERE host_id = :host_id
          AND config_space = :config_space
          AND external_session_id = :native_session_id
        LIMIT 1`
    )
    .get({
      host_id: session.host_id,
      config_space: session.config_space,
      native_session_id: nativeSessionId
    });
  if (nativeSession === undefined || nativeSession["session_id"] !== event.session_id) {
    return { status: "rejected", reason: "native_session_mismatch" };
  }
  const upload = connection
    .prepare<SqlRow>(
      `SELECT 1 AS present
         FROM host_runtime_upload u
         JOIN blob b ON b.blob_hash = u.payload_hash AND b.state = 'present'
        WHERE u.registration_hash = :registration_hash
          AND u.receipt_ref = :event_id
          AND u.session_id = :session_id
        LIMIT 1`
    )
    .get({
      registration_hash: session.registration_hash,
      event_id: event.event_id,
      session_id: session.session_id
    });
  if (upload === undefined) {
    return { status: "rejected", reason: "authenticated_upload_missing" };
  }
  const contracts = descriptor.event_contracts.filter(
    (contract) => contract.host_event === input.hook_event
  );
  if (contracts.length !== 1 || contracts[0] === undefined) {
    return { status: "rejected", reason: "event_contract_missing" };
  }
  const contract = contracts[0];
  const nativeMappings = connection
    .prepare<SqlRow>(
      `SELECT native_kind, native_message_id FROM native_id_map
        WHERE source_event_id = :event_id
          AND session_id = :session_id
          AND host_id = :host_id
          AND config_space = :config_space`
    )
    .all({
      event_id: event.event_id,
      session_id: event.session_id,
      host_id: session.host_id,
      config_space: session.config_space
    });
  if (nativeMappings.length > 1) {
    return { status: "rejected", reason: "native_message_id_ambiguous" };
  }
  const mapping = nativeMappings[0];
  const nativeMessageId =
    mapping === undefined ? null : (mapping["native_message_id"] as string);
  if (
    mapping !== undefined &&
    (typeof mapping["native_message_id"] !== "string" ||
      mapping["native_message_id"].length === 0 ||
      mapping["native_kind"] !== contract.native_kind)
  ) {
    return { status: "rejected", reason: "native_message_id_mismatch" };
  }
  if (event.event_type === "input.received") {
    if (event.input_id === null) {
      return { status: "rejected", reason: "input_projection_missing" };
    }
    const inputRow = connection
      .prepare<SqlRow>(
        `SELECT session_id, receipt_seq, content_ref, content_hash
           FROM input WHERE input_id = :input_id LIMIT 1`
      )
      .get({ input_id: event.input_id });
    if (
      inputRow === undefined ||
      inputRow["session_id"] !== event.session_id ||
      inputRow["receipt_seq"] !== event.watermark ||
      inputRow["content_ref"] !== event.content_ref ||
      inputRow["content_hash"] !== event.content_hash
    ) {
      return { status: "rejected", reason: "input_projection_mismatch" };
    }
  } else if (event.input_id !== null) {
    return { status: "rejected", reason: "boundary_input_unexpected" };
  }
  const identityKey = eventIdentityKey({
    host_id: session.host_id,
    config_space: session.config_space,
    mode: session.mode,
    native_session_id: nativeSessionId,
    native_kind: contract.native_kind,
    host_event: input.hook_event,
    native_message_id: nativeMessageId,
    native_event_id: null,
    source_seq: event.source_seq,
    occurred_at: event.occurred_at
  });
  if (identityKey !== event.event_key) {
    return { status: "rejected", reason: "event_identity_mismatch" };
  }
  const streamId = canonicalHash({
    host_id: session.host_id,
    config_space: session.config_space,
    mode: session.mode,
    native_session_id: nativeSessionId
  } as unknown as JsonValue);
  const binding: HostEventBinding = {
    host_id: session.host_id,
    host_version: session.host_version,
    adapter_id: session.adapter_id,
    adapter_version: session.adapter_version,
    implementation_hash: session.implementation_hash,
    mode: session.mode,
    config_space: session.config_space,
    host_event: input.hook_event,
    native_session_id: nativeSessionId,
    ...(nativeMessageId === null ? {} : { native_message_id: nativeMessageId }),
    stream_id: streamId as Hash,
    ...(event.source_seq === null ? {} : { source_seq: event.source_seq }),
    receipt_seq: event.watermark,
    event_identity_key: event.event_key,
    occurred_at: event.occurred_at,
    received_at: event.received_at
  };
  return {
    status: "ok",
    value: {
      binding,
      event_id: event.event_id,
      content_ref: event.content_ref,
      content_hash: event.content_hash
    }
  };
}

function readCapability(
  connection: SqliteConnection,
  bindingKey: Hash,
  name: CapabilityName
): CapabilityRowView | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT capability_id, binding_key, binding_json, name, status, evidence_stage,
              evidence_refs_json, probe_ref, probe_result, blocker_code, failure_code,
              checked_at, verified_at, last_verified_at, details_json, legacy_json, row_version
         FROM capability_record
        WHERE binding_key = :binding_key AND name = :name`
    )
    .get({ binding_key: bindingKey, name });
  if (row === undefined) {
    return null;
  }
  const bindingJson = parseJsonObject(asString(row, "binding_json"));
  if (bindingJson === null) {
    return null;
  }
  const binding = validateCapabilityBinding(bindingJson);
  if (!binding.ok) {
    return null;
  }
  let evidenceRefs: string[];
  try {
    const parsed: unknown = JSON.parse(asString(row, "evidence_refs_json"));
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      return null;
    }
    evidenceRefs = parsed as string[];
  } catch {
    return null;
  }
  const details = parseJsonObject(asString(row, "details_json"));
  if (details === null) {
    return null;
  }
  let legacy: CapabilityRecord["legacy"];
  const legacyJson = asNullableString(row, "legacy_json");
  if (legacyJson !== null) {
    try {
      legacy = JSON.parse(legacyJson) as CapabilityRecord["legacy"];
    } catch {
      return null;
    }
  }
  const probeRef = asNullableString(row, "probe_ref");
  const probeResult = asNullableString(row, "probe_result");
  const blockerCode = asNullableString(row, "blocker_code");
  const failureCode = asNullableString(row, "failure_code");
  const verifiedAt = asNullableNumber(row, "verified_at");
  const lastVerifiedAt = asNullableNumber(row, "last_verified_at");
  const record = {
    schema_version: "rsi.capability/2",
    capability_id: asString(row, "capability_id") as Id<"cap">,
    binding: binding.value,
    binding_key: asString(row, "binding_key") as Hash,
    name,
    status: asString(row, "status") as CapabilityRecord["status"],
    evidence_stage: asString(row, "evidence_stage") as CapabilityRecord["evidence_stage"],
    evidence_refs: evidenceRefs,
    ...(probeRef === null ? {} : { probe_ref: probeRef }),
    ...(probeResult === null
      ? {}
      : { probe_result: probeResult as NonNullable<CapabilityRecord["probe_result"]> }),
    ...(blockerCode === null ? {} : { blocker_code: blockerCode }),
    ...(failureCode === null ? {} : { failure_code: failureCode }),
    checked_at: asNumber(row, "checked_at"),
    ...(verifiedAt === null ? {} : { verified_at: verifiedAt }),
    ...(lastVerifiedAt === null ? {} : { last_verified_at: lastVerifiedAt }),
    details,
    ...(legacy === undefined ? {} : { legacy })
  } as unknown as CapabilityRecord;
  return { record, row_version: asNumber(row, "row_version") };
}

function previousProbeCheckedAt(
  connection: SqliteConnection,
  bindingKey: Hash
): number | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT MAX(checked_at) AS checked_at FROM host_probe WHERE binding_key = :binding_key`
    )
    .get({ binding_key: bindingKey });
  const value = row?.["checked_at"];
  return typeof value === "number" ? value : null;
}

function probeExists(connection: SqliteConnection, probeId: string): boolean {
  return (
    connection
      .prepare<SqlRow>(`SELECT 1 AS present FROM host_probe WHERE probe_id = :probe_id`)
      .get({ probe_id: probeId }) !== undefined
  );
}

function diagnostic(
  deps: RuntimeProbeProducerDeps,
  message: string,
  error?: ErrorEnvelope
): void {
  deps.on_diagnostic?.(message, error);
}

function unknownEvidence(path: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_EVIDENCE_UNKNOWN",
    category: "source",
    message_key: "error.evidence.unknown",
    stage: "runtime_probe",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule: "evidence_unknown" }
  });
}

function internalFailure(stage: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal.unexpected",
    stage,
    retryable: false,
    side_effect: "none",
    details: { kind: "internal", incident_id: stage }
  });
}

function probeUnsupported(stage: string, retryable = false): ErrorEnvelope {
  return {
    ...probeUnsupportedError(stage),
    retryable
  };
}

const STAGE_RANK: Readonly<Record<CapabilityRecord["evidence_stage"], number>> = {
  none: 0,
  static: 1,
  loaded: 2,
  roundtrip: 3
};

/**
 * Stage-only update for a self-reported pass that the kernel could not raise to
 * `roundtrip`. `applyProbeToCapability` intentionally leaves `unknown`
 * proposals untouched; this records the audit fact that the host ran the probe
 * without granting the capability.
 */
function applyLoadedStage(input: {
  readonly current: CapabilityRowView | null;
  readonly probe: HostProbeRecord;
  readonly result: HostProbeCapabilityResult;
  readonly capability_id: Id<"cap">;
}): CapabilityRecord | null {
  if (input.result.proposed_status !== "unknown") {
    return null;
  }
  if (input.result.evidence_stage !== "loaded" || input.result.evidence_refs.length === 0) {
    return null;
  }
  if (input.current === null) {
    const base = makeUnknownCapabilityRecord({
      capability_id: input.capability_id,
      name: input.result.name,
      binding: input.probe.binding,
      checked_at: input.probe.checked_at
    });
    return {
      ...base,
      evidence_stage: "loaded",
      evidence_refs: [...input.result.evidence_refs],
      probe_ref: input.probe.probe_id,
      probe_result: "unknown",
      checked_at: input.probe.checked_at
    } as CapabilityRecord;
  }
  const current = input.current.record;
  if (current.checked_at > input.probe.checked_at) {
    return null;
  }
  if (STAGE_RANK[input.result.evidence_stage] <= STAGE_RANK[current.evidence_stage]) {
    return null;
  }
  return {
    ...current,
    evidence_stage: input.result.evidence_stage,
    evidence_refs: [...input.result.evidence_refs],
    probe_ref: input.probe.probe_id,
    probe_result: "unknown",
    checked_at: input.probe.checked_at
  } as CapabilityRecord;
}

/**
 * Downgrades a previously verified capability when a newer observation of a
 * *different artifact* fails to reproduce the verification.
 *
 * The capability binding (and therefore `binding_key`) deliberately excludes
 * the artifact hash: the same host/adapter/config tuple keeps the same row
 * across artifact releases. The rule in appendix C — `roundtrip -> unknown` on
 * version or artifact change — therefore needs the call history: the artifact
 * this record was verified against is the `artifact_hash` of the newest older
 * call for this registration. When it differs from the current call, an
 * observation that did not re-verify at `roundtrip` invalidates the row.
 *
 * A blocked probe is not evidence of change and never invalidates.
 */
function invalidateVerified(input: {
  readonly current: CapabilityRowView;
  readonly probe: HostProbeRecord;
  readonly result: HostProbeCapabilityResult;
  readonly artifact_changed: boolean;
}): CapabilityRecord | null {
  const current = input.current.record;
  if (current.status !== "verified") {
    return null;
  }
  if (input.result.proposed_status === "verified") {
    return null;
  }
  if (!input.artifact_changed) {
    return null;
  }
  if (input.probe.result === "blocked") {
    return null;
  }
  if (current.checked_at > input.probe.checked_at) {
    return null;
  }
  const next = {
    ...current,
    status: "unknown",
    evidence_stage: input.result.evidence_stage,
    evidence_refs: [...input.result.evidence_refs],
    probe_ref: input.probe.probe_id,
    probe_result: input.probe.result,
    checked_at: input.probe.checked_at,
    last_verified_at: current.verified_at ?? current.last_verified_at ?? current.checked_at
  } as CapabilityRecord;
  delete next.verified_at;
  if (input.probe.blocker === undefined) {
    delete next.blocker_code;
  } else {
    next.blocker_code = input.probe.blocker.code;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createRuntimeProbeProducer(
  deps: RuntimeProbeProducerDeps
): RuntimeProbeProducer {
  const options = resolveProbeFeatureOptions(deps.options);
  const allocateProbeId = deps.allocate_probe_id ?? (() => newId("prb", deps.now()));
  const allocateCheckLoadId =
    deps.allocate_check_load_id ?? (() => newId("chk", deps.now()));
  const allocateCapabilityId =
    deps.allocate_capability_id ?? (() => newId("cap", deps.now()));

  /**
   * Stop gate shared by schedules, claims and in-flight evidence reads. It is
   * set synchronously before the durable close so no new work can begin while
   * the closing transaction runs.
   */
  let stopped = false;
  const armRejectionsReported = new Set<string>();
  const stoppedMarker: unique symbol = Symbol("runtime_probe_stopped");
  let signalStopped: () => void = () => {};
  const stoppedSignal = new Promise<void>((resolve) => {
    signalStopped = resolve;
  });

  /** Races an external read against the stop gate; DB writes are never raced. */
  async function whileActive<T>(task: Promise<T>): Promise<T | typeof stoppedMarker> {
    if (stopped) return stoppedMarker;
    const halt = stoppedSignal.then((): typeof stoppedMarker => stoppedMarker);
    return await Promise.race<T | typeof stoppedMarker>([task, halt]);
  }

  function stoppedApply(): Result<ProbeApplyOutcome, ErrorEnvelope> {
    return ok({ status: "stopped", applied_capabilities: [] });
  }

  function registrationFacts(registration: RegistrationRow): ProbeBindingRegistrationFacts {
    return {
      registration_hash: registration.registration_hash,
      adapter_id: registration.adapter_id,
      adapter_version: registration.adapter_version,
      host_id: registration.host_id,
      mode: registration.mode,
      config_space: registration.config_space,
      artifact_hash: registration.artifact_hash
    };
  }

  async function bindingFor(
    registration: RegistrationRow,
    session: HostRuntimeSessionRow
  ): Promise<Result<CapabilityBinding | null, ErrorEnvelope>> {
    return declareCapabilityBinding(
      deps.binding === undefined ? {} : { declaration: deps.binding },
      {
        registration: registrationFacts(registration),
        host_version: session.host_version,
        binary_hash: session.binary_hash,
        native_session_id: session.native_session_id
      }
    );
  }

  function expireStaleCalls(input: {
    readonly registration: RegistrationRow;
    readonly now: number;
  }): number {
    const outcome = deps.connection
      .prepare(
        `UPDATE host_runtime_call SET state = 'expired', updated_at = :now
          WHERE kind IN ('probe', 'check_load')
            AND state = 'pending'
            AND host_id = :host_id AND mode = :mode AND config_space = :config_space
            AND (registration_hash <> :registration_hash OR artifact_hash <> :artifact_hash)`
      )
      .run({
        now: input.now,
        host_id: input.registration.host_id,
        mode: input.registration.mode,
        config_space: input.registration.config_space,
        registration_hash: input.registration.registration_hash,
        artifact_hash: input.registration.artifact_hash
      });
    return outcome.changes;
  }

  function latestCall(kind: "probe" | "check_load", registration: RegistrationRow): SqlRow | null {
    return (
      deps.connection
        .prepare<SqlRow>(
          `SELECT call_id, state, artifact_hash, created_at, deadline_at
             FROM host_runtime_call
            WHERE kind = :kind
              AND host_id = :host_id AND mode = :mode AND config_space = :config_space
              AND registration_hash = :registration_hash
            ORDER BY created_at DESC, call_id DESC
            LIMIT 1`
        )
        .get({
          kind,
          host_id: registration.host_id,
          mode: registration.mode,
          config_space: registration.config_space,
          registration_hash: registration.registration_hash
        }) ?? null
    );
  }

  /**
   * The artifact hash the newest earlier call of the same kind observed. Used
   * to detect an artifact change, because the artifact hash is not part of the
   * capability binding key.
   */
  function previousArtifact(
    kind: "probe" | "check_load",
    registration: RegistrationRow,
    currentCallId: string
  ): Hash | null {
    // An artifact release re-registers with a new `artifact_hash` (which is part
    // of the registration hash), so the previous call is found across
    // registrations in the same binding scope. The capability binding key
    // excludes the artifact hash, which is exactly why the history is needed.
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT c.artifact_hash
           FROM host_runtime_call c
           JOIN adapter_registration r ON r.registration_hash = c.registration_hash
          WHERE c.kind = :kind
            AND c.host_id = :host_id AND c.mode = :mode AND c.config_space = :config_space
            AND r.adapter_id = :adapter_id
            AND c.call_id <> :call_id
            AND c.state IN ('completed', 'uncertain')
          ORDER BY c.created_at DESC, c.call_id DESC
          LIMIT 1`
      )
      .get({
        kind,
        host_id: registration.host_id,
        mode: registration.mode,
        config_space: registration.config_space,
        adapter_id: registration.adapter_id,
        call_id: currentCallId
      });
    if (row === undefined) {
      return null;
    }
    const value = row["artifact_hash"];
    return typeof value === "string" ? (value as Hash) : null;
  }

  function artifactChanged(
    kind: "probe" | "check_load",
    registration: RegistrationRow,
    currentCallId: string
  ): boolean {
    const previous = previousArtifact(kind, registration, currentCallId);
    return previous !== null && previous !== registration.artifact_hash;
  }

  /**
   * Dedupe rule: the same (registration, artifact) is probed at most once per
   * window. A still-pending/issued call blocks a duplicate. A newer artifact or
   * registration bypasses the window because the row lookup is scoped to both.
   */
  function shouldSchedule(kind: "probe" | "check_load", registration: RegistrationRow): boolean {
    const latest = latestCall(kind, registration);
    if (latest === null) {
      return true;
    }
    const now = deps.now();
    if (asString(latest, "artifact_hash") !== registration.artifact_hash) {
      return true;
    }
    const state = asString(latest, "state");
    if ((state === "pending" || state === "issued") && asNumber(latest, "deadline_at") > now) {
      return false;
    }
    if (state === "completed" || state === "uncertain") {
      return now - asNumber(latest, "created_at") >= options.dedupe_window_ms;
    }
    return true;
  }

  async function schedule(
    input: ProbeScheduleInput
  ): Promise<Result<ProbeScheduleOutcome, ErrorEnvelope>> {
    if (!options.enabled) {
      return ok({ status: "disabled", scheduled: [], expired: 0 });
    }
    if (stopped) {
      return ok({ status: "stopped", scheduled: [], expired: 0 });
    }
    const registration = readRegistration(deps.connection, input.registration_hash);
    if (registration === null) {
      return err(
        makeErrorEnvelope({
          code: "E_CAPABILITY",
          category: "policy",
          message_key: "error.capability",
          stage: "runtime_probe_schedule",
          retryable: false,
          side_effect: "none",
          details: { kind: "field", path: "registration_hash", rule: "not_applied" }
        })
      );
    }
    if (input.artifact_hash !== undefined && input.artifact_hash !== registration.artifact_hash) {
      return ok({ status: "existing", scheduled: [], expired: 0 });
    }
    const snapshot = readSnapshot(deps.connection, registration.registration_hash);
    if (snapshot === null) {
      return err(
        makeErrorEnvelope({
          code: "E_SCHEMA",
          category: "schema",
          message_key: "error.schema",
          stage: "runtime_probe_schedule",
          retryable: false,
          side_effect: "none",
          details: { kind: "field", path: "adapter_descriptor_snapshot", rule: "missing" }
        })
      );
    }
    const now = deps.now();
    const expired = expireStaleCalls({ registration, now });
    const scheduled: ("probe" | "check_load")[] = [];

    const declared = new Set(snapshot.descriptor.declared_capabilities);
    const probeCapabilities = options.capabilities.filter((name) => declared.has(name));
    const checkLoadWanted = options.check_load && shouldSchedule("check_load", registration);
    // `host_runtime.poll` claims the oldest pending call. Some native hosts
    // (pi, oh-my-pi, step-code) poll exactly once per run, so a check_load row
    // that sorts first would starve the probe. Order the probe one millisecond
    // earlier when both are scheduled; the check_load stays pending for the
    // next poll instead of blocking the capability roundtrip.
    const probeCreatedAt = now > 0 && checkLoadWanted ? now - 1 : now;
    if (probeCapabilities.length > 0) {
      if (deps.binding === undefined) {
        // No adapter-declared binding means no honest probe request can be
        // built. Insert nothing and report the gap instead of guessing.
        diagnostic(deps, "runtime_probe.binding_port_unavailable");
      } else if (shouldSchedule("probe", registration)) {
        const probeId = allocateProbeId();
        const created = insertRuntimeCall(
          deps.connection,
          {
            call_id: probeId,
            kind: "probe",
            object_ref: probeId,
            registration_hash: registration.registration_hash,
            artifact_hash: registration.artifact_hash,
            host_id: registration.host_id,
            mode: registration.mode,
            config_space: registration.config_space,
            // Attach-time intent has no receipt. The poll path arms it with a
            // real trigger event before the runtime can claim it.
            native_session_id: null,
            hook_event: null,
            boundary_event_key: null,
            goal_version: null,
            config_version: null,
            input_epoch: null,
            deadline_at: now + options.intent_ttl_ms
          },
          probeCreatedAt
        );
        if (created) scheduled.push("probe");
      }
    }

    if (checkLoadWanted) {
      const requestId = allocateCheckLoadId();
      const created = insertRuntimeCall(
        deps.connection,
        {
          call_id: requestId,
          kind: "check_load",
          object_ref: requestId,
          registration_hash: registration.registration_hash,
          artifact_hash: registration.artifact_hash,
          host_id: registration.host_id,
          mode: registration.mode,
          config_space: registration.config_space,
          native_session_id: null,
          hook_event: null,
          boundary_event_key: null,
          goal_version: null,
          config_version: null,
          input_epoch: null,
          deadline_at: now + options.intent_ttl_ms
        },
        now
      );
      if (created) scheduled.push("check_load");
    }

    return ok({
      status: scheduled.length > 0 ? "scheduled" : "existing",
      scheduled,
      expired
    });
  }

  function loadBoundaryFor(
    descriptor: AdapterDescriptor,
    configSpace: string
  ): LoadBoundary {
    const targets = descriptor.registration_targets.filter(
      (target) => target.config_space === configSpace
    );
    if (targets.length === 0) {
      return "unknown";
    }
    const boundaries = new Set(targets.map((target) => target.load_boundary));
    return boundaries.size === 1 ? (targets[0]?.load_boundary ?? "unknown") : "unknown";
  }

  /**
   * Verifies that an input boundary's committed content is still retrievable
   * and hashes to the committed `content_hash`. This is the async half of the
   * receipt checks; it runs during resolve, and a failure fails the claim
   * closed instead of issuing a call against unverified content.
   */
  async function resolveAuthenticatedContent(
    ref: SourceRef,
    expected: Hash | null
  ): Promise<boolean> {
    if (stopped || expected === null) {
      return false;
    }
    const resolved = await whileActive(
      deps.source_refs.resolve(ref, { maxBytes: options.max_evidence_bytes })
    );
    if (resolved === stoppedMarker) {
      return false;
    }
    if (!resolved.ok || !resolved.value.retrievable || resolved.value.bytes === null) {
      return false;
    }
    return (
      resolved.value.bytes.byteLength === resolved.value.length &&
      hashBytes(resolved.value.bytes) === expected
    );
  }

  /**
   * Resolves the call boundary from a committed trigger event when one exists,
   * otherwise from the exact authenticated runtime upload that produced the
   * poll receipt. The trigger remains preferred so the delivery path and the
   * probe path observe the same binding when review is enabled.
   */
  async function boundaryBindingFor(
    row: HostRuntimeCallRow,
    session: HostRuntimeSessionRow,
    now: number
  ): Promise<Result<HostEventBinding, ErrorEnvelope>> {
    if (row.boundary_event_key === null) {
      return err(unknownEvidence("host_runtime_call.boundary_event_key"));
    }
    const trigger = readTriggerHostBinding(deps.connection, row.boundary_event_key);
    if (trigger !== null) {
      return ok(trigger);
    }
    const derived = deriveCommittedReceiptBinding(deps.connection, {
      session,
      event_identity_key: row.boundary_event_key as Hash,
      hook_event: row.hook_event,
      now
    });
    if (derived.status !== "ok") {
      return err(unknownEvidence("authenticated_upload_receipt"));
    }
    if (
      derived.value.content_ref !== null &&
      !(await resolveAuthenticatedContent(derived.value.content_ref, derived.value.content_hash))
    ) {
      return err(unknownEvidence("authenticated_upload_receipt.content_ref"));
    }
    return ok(derived.value.binding);
  }

  async function resolveProbeCall(
    row: HostRuntimeCallRow,
    session: HostRuntimeSessionRow,
    now: number
  ): Promise<Result<null | RuntimeCall, ErrorEnvelope>> {
    if (row.boundary_event_key === null) {
      // Unarmed attach intent. `host_runtime.poll` arms it on a real receipt.
      return ok(null);
    }
    if (row.deadline_at <= now) {
      return ok(null);
    }
    const registration = readRegistration(deps.connection, row.registration_hash);
    if (registration === null) {
      return err(unknownEvidence("registration_hash"));
    }
    const snapshot = readSnapshot(deps.connection, row.registration_hash);
    if (snapshot === null) {
      return err(unknownEvidence("adapter_descriptor_snapshot"));
    }
    const boundary = await boundaryBindingFor(row, session, now);
    if (!boundary.ok) {
      return boundary;
    }
    const hostBinding = boundary.value;
    if (
      hostBinding.host_id !== session.host_id ||
      hostBinding.mode !== session.mode ||
      hostBinding.config_space !== session.config_space ||
      hostBinding.adapter_id !== registration.adapter_id ||
      hostBinding.adapter_version !== registration.adapter_version
    ) {
      return err(
        makeErrorEnvelope({
          code: "E_CONFLICT",
          category: "conflict",
          message_key: "error.conflict",
          stage: "runtime_probe_resolve",
          retryable: false,
          side_effect: "none",
          details: { kind: "field", path: "trigger_event.host_binding", rule: "scope_mismatch" }
        })
      );
    }
    const binding = await bindingFor(registration, session);
    if (!binding.ok) {
      return binding;
    }
    if (binding.value === null) {
      return err(probeUnsupported("runtime_probe_resolve"));
    }
    if (binding.value.host_id !== row.host_id || binding.value.mode !== row.mode) {
      return err(internalFailure("runtime_probe.binding_scope"));
    }
    const declared = new Set(snapshot.descriptor.declared_capabilities);
    const capabilities = options.capabilities.filter((name) => declared.has(name));
    if (capabilities.length === 0) {
      return ok(null);
    }
    const remaining = Math.max(1, row.deadline_at - now);
    return ok({
      kind: "probe",
      call_id: row.call_id,
      deadline_ms: Math.min(remaining, options.probe_deadline_ms),
      request: {
        probe_id: row.object_ref as Id<"prb">,
        probe_contract_version: "host-probe/2",
        binding: binding.value,
        host_binding: hostBinding,
        probe_action: "read_only",
        capabilities: [...capabilities],
        probe_mode: "read_only",
        deadline_ms: Math.max(1, Math.min(remaining, options.probe_deadline_ms, 600_000))
      }
    });
  }

  async function resolveCheckLoadCall(
    row: HostRuntimeCallRow,
    session: HostRuntimeSessionRow,
    now: number
  ): Promise<Result<null | RuntimeCall, ErrorEnvelope>> {
    if (row.boundary_event_key === null || row.deadline_at <= now) {
      return ok(null);
    }
    const boundary = await boundaryBindingFor(row, session, now);
    if (!boundary.ok) {
      return boundary;
    }
    const registration = readRegistration(deps.connection, row.registration_hash);
    if (registration === null) {
      return err(unknownEvidence("registration_hash"));
    }
    const snapshot = readSnapshot(deps.connection, row.registration_hash);
    if (snapshot === null) {
      return err(unknownEvidence("adapter_descriptor_snapshot"));
    }
    const expectedHash = registration.written_hash ?? registration.artifact_hash;
    const remaining = Math.max(1, row.deadline_at - now);
    return ok({
      kind: "check_load",
      call_id: row.call_id,
      deadline_ms: Math.min(remaining, options.probe_deadline_ms),
      request: {
        request_id: row.object_ref,
        object_ref: expectedHash,
        expected_hash: expectedHash,
        target_session_ref:
          row.native_session_id ?? session.native_session_id ?? session.session_id,
        load_boundary: loadBoundaryFor(snapshot.descriptor, registration.config_space),
        deadline_ms: Math.max(1, Math.min(remaining, options.probe_deadline_ms, 600_000))
      }
    });
  }

  const callResolver: HostRuntimeCallResolverPort = {
    async resolve(input) {
      if (!options.enabled || stopped) {
        return ok(null);
      }
      if (input.row.kind === "deliver") {
        return ok(null);
      }
      if (input.row.kind === "probe") {
        return resolveProbeCall(input.row, input.session, input.now);
      }
      return resolveCheckLoadCall(input.row, input.session, input.now);
    }
  };

  /**
   * Reads blob bytes by content address when the source-ref projection has no
   * `blob` row for them. Journal refs still go through the source-ref port.
   */
  function readBlobDirect(ref: string, maxBytes: number): Uint8Array | null {
    if (deps.blobs.read === undefined) return null;
    const parsed = parseSourceRef(ref);
    if (!parsed.ok || parsed.value.scheme !== "blob") return null;
    const { locator, start, end } = parsed.value;
    if (end < start || end - start > maxBytes) return null;
    const read = deps.blobs.read(locator as Hash);
    if (!read.ok) return null;
    if (end > read.value.byteLength) return null;
    return read.value.slice(start, end);
  }

  async function resolveNonceRef(ref: string, nonce: string): Promise<boolean> {
    if (stopped || !isSourceRef(ref)) {
      return false;
    }
    const resolved = await whileActive(deps.source_refs.resolve(ref, {
      maxBytes: options.max_evidence_bytes
    }));
    if (resolved === stoppedMarker) {
      return false;
    }
    let bytes: Uint8Array | null = null;
    if (resolved.ok && resolved.value.retrievable && resolved.value.bytes !== null) {
      bytes = resolved.value.bytes;
    } else {
      bytes = readBlobDirect(ref, options.max_evidence_bytes);
    }
    if (bytes === null) {
      return false;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return text.includes(nonce);
    } catch {
      return false;
    }
  }

  async function resolveReadableRef(ref: string): Promise<boolean> {
    if (stopped || !isSourceRef(ref)) {
      return false;
    }
    const resolved = await whileActive(deps.source_refs.resolve(ref, {
      maxBytes: options.max_evidence_bytes
    }));
    if (resolved === stoppedMarker) {
      return false;
    }
    if (resolved.ok && resolved.value.retrievable && resolved.value.bytes !== null) {
      return true;
    }
    return readBlobDirect(ref, options.max_evidence_bytes) !== null;
  }

  /**
   * Reads the collector record and verifies every association the runtime
   * cannot forge: kind, call, nonce, session, registration, binding and (when
   * present) artifact, plus the observation time inside the issued window.
   *
   * `require_nonce` is true for probes: the collector must point at a provider
   * body or receipt whose bytes contain the nonce. `check_load` has no nonce in
   * the provider path, so it instead requires a readable persisted evidence ref
   * and an explicit capability claim.
   */
  async function collectorEvidence(input: {
    readonly kind: "probe" | "check_load";
    readonly row: HostRuntimeCallRow;
    readonly session: HostRuntimeSessionRow;
    readonly registration: RegistrationRow;
    readonly binding_key: Hash;
    readonly nonce: string;
    readonly capabilities: readonly CapabilityName[];
    readonly require_nonce: boolean;
    readonly load_boundary?: LoadBoundary;
  }): Promise<Result<VerifiedCollectorEvidence | null, ErrorEnvelope>> {
    if (deps.evidence === undefined) {
      diagnostic(deps, `runtime_probe.collector_unavailable.${input.kind}`);
      return ok(null);
    }
    if (input.row.issued_at === null) {
      return ok(null);
    }
    let collected: Result<KernelProbeEvidence | null, ErrorEnvelope>;
    try {
      const pendingCollect = deps.evidence.collect({
        kind: input.kind,
        call_id: input.row.call_id,
        nonce: input.nonce,
        session_id: input.session.session_id,
        registration_hash: input.registration.registration_hash,
        artifact_hash: input.registration.artifact_hash,
        binding_key: input.binding_key,
        capabilities: [...input.capabilities],
        ...(input.load_boundary === undefined ? {} : { load_boundary: input.load_boundary }),
        issued_at: input.row.issued_at,
        deadline_at: input.row.deadline_at,
        now: deps.now()
      });
      const raced = await whileActive(pendingCollect);
      if (raced === stoppedMarker) {
        return ok(null);
      }
      collected = raced;
    } catch {
      diagnostic(deps, `runtime_probe.collector_failed.${input.kind}`);
      return err(internalFailure(`runtime_probe.collector_failed.${input.kind}`));
    }
    if (!collected.ok) {
      diagnostic(deps, `runtime_probe.collector_error.${input.kind}`, collected.error);
      return collected;
    }
    const evidence = collected.value;
    if (evidence === null) {
      return ok(null);
    }
    if (
      evidence.collector_id.trim() === "" ||
      evidence.kind !== input.kind ||
      evidence.call_id !== input.row.call_id ||
      evidence.nonce !== input.nonce ||
      evidence.call_session_id !== input.session.session_id ||
      evidence.registration_hash !== input.registration.registration_hash ||
      evidence.binding_key !== input.binding_key ||
      (evidence.artifact_hash !== undefined &&
        evidence.artifact_hash !== input.registration.artifact_hash) ||
      !Number.isSafeInteger(evidence.observed_at) ||
      evidence.observed_at < input.row.issued_at ||
      evidence.observed_at > input.row.deadline_at
    ) {
      diagnostic(deps, `runtime_probe.collector_association_mismatch.${input.kind}`);
      return ok(null);
    }
    const capabilities = new Set<CapabilityName>();
    for (const name of evidence.capabilities) {
      if (input.capabilities.includes(name)) {
        capabilities.add(name);
      }
    }
    if (capabilities.size === 0) {
      return ok(null);
    }
    const refs: string[] = [];
    for (const ref of evidence.evidence_refs) {
      if (await resolveReadableRef(ref)) {
        refs.push(ref);
      }
    }
    let nonceProven = false;
    const nonceRefs: string[] = [];
    for (const ref of [evidence.nonce_evidence_ref, ...evidence.evidence_refs]) {
      if (ref !== undefined && (await resolveNonceRef(ref, input.nonce))) {
        nonceProven = true;
        nonceRefs.push(ref);
      }
    }
    if (input.require_nonce) {
      if (!nonceProven) {
        diagnostic(deps, "runtime_probe.collector_nonce_unproven");
        return ok(null);
      }
    } else if (refs.length === 0) {
      // check_load evidence must be a persisted, retrievable collector artifact;
      // the runtime's own readback reference is never enough.
      diagnostic(deps, "runtime_probe.collector_evidence_unretrievable");
      return ok(null);
    }
    return ok({
      capabilities,
      refs: [...new Set([...nonceRefs, ...refs])]
    });
  }

  /** Persists the observation bytes as a real blob and returns its SourceRef. */
  function observationRef(observed: JsonValue): Result<SourceRef, ErrorEnvelope> {
    const bytes = new TextEncoder().encode(canonicalJsonText(observed));
    const stored = deps.blobs.putSync(bytes);
    if (!stored.ok) {
      return stored;
    }
    return formatSourceRef({
      scheme: "blob",
      locator: stored.value.hash,
      start: 0,
      end: stored.value.byte_length
    });
  }

  function appendRows(
    rows: readonly HostStateRowInsertion[]
  ): Promise<Result<void, ErrorEnvelope>> {
    return deps.state_rows.appendStateRows({ binding: null, rows, documents: [], heads: [] }).then(
      (outcome) =>
        outcome.ok
          ? ok(undefined)
          : err({ ...outcome.error, side_effect: outcome.commit_state === "not_written" ? "none" : "unknown" })
    );
  }

  async function applyProbe(
    input: HostRuntimeCallCompletion,
    result: Extract<HostRuntimeCallCompletion["result"], { kind: "probe" }>
  ): Promise<Result<ProbeApplyOutcome, ErrorEnvelope>> {
    const row = input.row;
    const session = input.session;
    const observation = result.observation;
    const probeId = row.object_ref as Id<"prb">;
    if (!isId(probeId, "prb")) {
      return ok({ status: "skipped", rule: "invalid_probe_id", applied_capabilities: [] });
    }
    if (probeExists(deps.connection, probeId)) {
      return ok({ status: "duplicate", applied_capabilities: [] });
    }
    const registration = readRegistration(deps.connection, row.registration_hash);
    if (registration === null) {
      diagnostic(deps, "runtime_probe.registration_missing");
      return ok({ status: "skipped", rule: "registration_missing", applied_capabilities: [] });
    }
    const snapshot = readSnapshot(deps.connection, row.registration_hash);
    if (snapshot === null) {
      diagnostic(deps, "runtime_probe.descriptor_missing");
      return ok({ status: "skipped", rule: "descriptor_missing", applied_capabilities: [] });
    }
    const binding = await whileActive(bindingFor(registration, session));
    if (binding === stoppedMarker) {
      return stoppedApply();
    }
    if (!binding.ok) {
      diagnostic(deps, "runtime_probe.binding_unavailable", binding.error);
      return binding;
    }
    if (binding.value === null) {
      diagnostic(deps, "runtime_probe.binding_null");
      return ok({ status: "skipped", rule: "binding_unsupported", applied_capabilities: [] });
    }
    const bindingKey = capabilityBindingKey(binding.value);
    if (observation.binding_key !== bindingKey) {
      return ok({ status: "skipped", rule: "binding_key_mismatch", applied_capabilities: [] });
    }
    const checkedAt = observation.checked_at;
    if (row.issued_at === null || checkedAt < row.issued_at) {
      return ok({ status: "skipped", rule: "checked_at_before_issued", applied_capabilities: [] });
    }
    if (checkedAt > deps.now()) {
      return ok({ status: "skipped", rule: "checked_at_after_now", applied_capabilities: [] });
    }
    const payload = parseObservedPayload(observation.observed);
    const nonceEchoed =
      payload !== null && payload.nonce === probeId && payload.echo !== "none";
    const declared = new Set(snapshot.descriptor.declared_capabilities);
    const requested = options.capabilities.filter((name) => declared.has(name));
    if (requested.length === 0) {
      return ok({ status: "skipped", rule: "no_requested_capability", applied_capabilities: [] });
    }
    if (stopped) {
      return stoppedApply();
    }

    // Runtime-authored refs in `observed` are audit facts only. Only the
    // kernel-owned collector can prove the nonce traversed the provider path.
    const collector = await collectorEvidence({
      kind: "probe",
      row,
      session,
      registration,
      binding_key: bindingKey,
      nonce: probeId,
      capabilities: requested,
      require_nonce: true
    });
    if (stopped) {
      return stoppedApply();
    }
    if (!collector.ok) {
      return collector;
    }
    const collectorVerified = collector.value;
    const independentRefs = collectorVerified?.refs ?? [];
    const observedRefResult = observationRef(
      toJsonValue({
        schema_version: OBSERVATION_PAYLOAD_SCHEMA,
        call_id: row.call_id,
        probe_id: probeId,
        observed: observation.observed,
        claimed_evidence_stage: observation.claimed_evidence_stage ?? null,
        claimed_status: observation.claimed_status ?? null,
        checked_at: checkedAt,
        evidence_refs: [...observation.evidence_refs]
      })
    );
    if (!observedRefResult.ok) {
      return observedRefResult;
    }
    const observedRef = observedRefResult.value;
    const evidenceRefs = [...new Set([observedRef, ...independentRefs, ...observation.evidence_refs])].sort();

    const assertions: HostProbeRecord["assertions"] = [];
    const capabilityResults: HostProbeCapabilityResult[] = [];
    let anyFailed = false;
    let anyVerified = false;
    for (const name of requested) {
      const verdict = payload?.capabilities.find((entry) => entry.name === name);
      const pass = verdict?.pass ?? "unknown";
      const capabilityVerified =
        pass !== false && collectorVerified !== null && collectorVerified.capabilities.has(name);
      if (pass === false) {
        anyFailed = true;
      }
      if (capabilityVerified) {
        anyVerified = true;
      }
      const failureCode =
        verdict?.failure_code ?? (pass === false ? "probe_reported_failure" : undefined);
      // Only an actually performed check becomes an assertion. A requested
      // capability the kernel collector could not observe stays an `unknown`
      // capability result instead of a permanently-false assertion, so the
      // probe can still report `passed` for the capabilities it did prove
      // while applying none of the unproven ones (DD-CAP-004).
      if (pass === false) {
        assertions.push({
          assertion_id: `${name}:nonce_roundtrip`,
          capability: name,
          expected:
            "a kernel-owned collector retrieves a provider body or receipt containing the probe nonce",
          observed_ref: observedRef,
          pass: false,
          ...(failureCode === undefined ? {} : { failure_code: failureCode })
        });
      } else if (capabilityVerified) {
        assertions.push({
          assertion_id: `${name}:nonce_roundtrip`,
          capability: name,
          expected:
            "a kernel-owned collector retrieves a provider body or receipt containing the probe nonce",
          observed_ref: observedRef,
          pass: true
        });
      }
      capabilityResults.push({
        name,
        proposed_status:
          pass === false
            ? "failed"
            : capabilityVerified
              ? "verified"
              : "unknown",
        evidence_stage:
          capabilityVerified
            ? "roundtrip"
            : nonceEchoed || observation.evidence_refs.length > 0
              ? "loaded"
              : "none",
        evidence_refs:
          capabilityVerified
            ? [...new Set([observedRef, ...independentRefs])]
            : nonceEchoed
              ? [observedRef]
              : [],
        ...(failureCode === undefined ? {} : { failure_code: failureCode })
      });
    }

    const blocker =
      payload?.blocker !== undefined && isSourceRef(payload.blocker.detail_ref)
        ? {
            kind: payload.blocker.kind as import("@evoplug/core/host").HostProbeBlocker["kind"],
            code: payload.blocker.code,
            detail_ref: payload.blocker.detail_ref as SourceRef,
            retry_allowed: payload.blocker.retry_allowed
          }
        : undefined;
    const probeResult: HostProbeResult =
      blocker !== undefined ? "blocked" : anyFailed ? "failed" : anyVerified ? "passed" : "unknown";

    const probe: HostProbeRecord = {
      schema_version: "rsi.host_probe/2",
      probe_id: probeId,
      probe_contract_version: "host-probe/2",
      target_kind: "host",
      binding: binding.value,
      binding_key: bindingKey,
      probe_mode: "read_only",
      probe_action: "read_only",
      assertions,
      capability_results: capabilityResults,
      result: probeResult,
      ...(blocker === undefined ? {} : { blocker }),
      expected:
        "The host echoes the probe nonce and makes the provider request body or delivery receipt independently retrievable.",
      observed: canonicalJsonText(
        toJsonValue({
          nonce_echoed: nonceEchoed,
          echo: payload?.echo ?? "none",
          independent_evidence_refs: independentRefs,
          capability_verdicts: payload?.capabilities ?? [],
          claimed_evidence_stage: observation.claimed_evidence_stage ?? null,
          claimed_status: observation.claimed_status ?? null
        })
      ),
      evidence_refs: evidenceRefs,
      duration_ms: Math.max(0, checkedAt - (row.issued_at ?? row.created_at)),
      checked_at: checkedAt
    };

    const validated = validateHostProbeRecord(probe);
    if (!validated.ok) {
      diagnostic(deps, "runtime_probe.record_invalid", validated.error);
      return validated;
    }

    const previousCheckedAt = previousProbeCheckedAt(deps.connection, bindingKey);
    const rows: HostStateRowInsertion[] = [
      {
        row_schema: "rsi.host_probe_row/1",
        operation: "insert",
        row: toHostProbePhysicalRow(validated.value, 1),
        document_id: null
      }
    ];
    const artifact_changed = artifactChanged("probe", registration, row.call_id);
    const applied: CapabilityName[] = [];
    for (const capabilityResult of capabilityResults) {
      const current = readCapability(deps.connection, bindingKey, capabilityResult.name);
      const capabilityId = current?.record.capability_id ?? allocateCapabilityId();
      let next =
        applyProbeToCapability(current?.record ?? null, validated.value, capabilityResult.name, {
          capability_id: capabilityId,
          now: deps.now()
        }) ?? applyLoadedStage({
          current,
          probe: validated.value,
          result: capabilityResult,
          capability_id: capabilityId
        });
      // applyProbeToCapability keeps the old status when a newer probe merely
      // records an audit fact. An artifact change turns that into a real
      // downgrade instead of silently extending a stale verification.
      if (current !== null && (next === null || next === current.record || next.status === "verified")) {
        const invalidated = invalidateVerified({
          current,
          probe: validated.value,
          result: capabilityResult,
          artifact_changed
        });
        if (invalidated !== null) {
          next = invalidated;
        }
      }
      if (next === null || (current !== null && next === current.record)) {
        continue;
      }
      rows.push({
        row_schema: "rsi.capability_record_row/1",
        operation: current === null ? "insert" : "transition",
        row: toCapabilityRecordPhysicalRow(
          next,
          current === null ? 1 : current.row_version + 1
        ),
        document_id: null
      });
      applied.push(capabilityResult.name);
    }

    if (stopped) {
      return stoppedApply();
    }
    const written = await appendRows(rows);
    if (!written.ok) {
      diagnostic(deps, "runtime_probe.append_failed", written.error);
      return written;
    }
    // A probe that did not advance any capability still supersedes older
    // evidence for this binding; the host_probe row is the audit anchor.
    if (previousCheckedAt !== null && previousCheckedAt > checkedAt) {
      diagnostic(deps, "runtime_probe.out_of_order_observation");
    }
    return ok({ status: "applied", probe_id: probeId, applied_capabilities: applied });
  }

  async function applyCheckLoad(
    input: HostRuntimeCallCompletion,
    result: Extract<HostRuntimeCallCompletion["result"], { kind: "check_load" }>
  ): Promise<Result<ProbeApplyOutcome, ErrorEnvelope>> {
    const row = input.row;
    const session = input.session;
    const load = result.result;
    const registration = readRegistration(deps.connection, row.registration_hash);
    if (registration === null) {
      return ok({ status: "skipped", rule: "registration_missing", applied_capabilities: [] });
    }
    const snapshot = readSnapshot(deps.connection, row.registration_hash);
    if (snapshot === null) {
      return ok({ status: "skipped", rule: "descriptor_missing", applied_capabilities: [] });
    }
    if (!snapshot.descriptor.declared_capabilities.includes("managed_object_load")) {
      return ok({ status: "skipped", rule: "capacity_not_declared", applied_capabilities: [] });
    }
    const binding = await whileActive(bindingFor(registration, session));
    if (binding === stoppedMarker) {
      return stoppedApply();
    }
    if (!binding.ok) {
      return ifBindingUnsupported(binding);
    }
    if (binding.value === null) {
      return ok({ status: "skipped", rule: "binding_unsupported", applied_capabilities: [] });
    }
    const bindingKey = capabilityBindingKey(binding.value);
    const expectedHash = registration.written_hash ?? registration.artifact_hash;
    const loaded =
      load.state === "loaded" &&
      load.observed_hash !== undefined &&
      load.observed_hash === expectedHash;
    const readbackRefs = [...new Set([
      ...(load.readback_ref === undefined ? [] : [load.readback_ref]),
      ...load.evidence_refs
    ])];
    let readable = false;
    for (const ref of readbackRefs) {
      if (stopped) {
        return stoppedApply();
      }
      if (await resolveReadableRef(ref)) {
        readable = true;
        break;
      }
    }
    if (stopped) {
      return stoppedApply();
    }
    // A readback that matches the artifact proves the host loaded *an artifact*.
    // It does not prove the `managed_object_load` capability through the
    // provider path, so only a matching collector record can reach `roundtrip`.
    const collector = await collectorEvidence({
      kind: "check_load",
      row,
      session,
      registration,
      binding_key: bindingKey,
      nonce: load.request_id,
      capabilities: ["managed_object_load"],
      require_nonce: false,
      load_boundary: loadBoundaryFor(snapshot.descriptor, registration.config_space)
    });
    if (stopped) {
      return stoppedApply();
    }
    if (!collector.ok) {
      return collector;
    }
    const collectorVerified = collector.value;
    const roundtrip =
      loaded && readable && collectorVerified !== null &&
      collectorVerified.capabilities.has("managed_object_load");
    const collectorRefs = collectorVerified?.refs ?? [];
    const observedRefResult = observationRef(
      toJsonValue({
        schema_version: "rsi.runtime_check_load_observation/1",
        call_id: row.call_id,
        request_id: load.request_id,
        state: load.state,
        observed_hash: load.observed_hash ?? null,
        expected_hash: expectedHash,
        readback_refs: readbackRefs,
        checked_at: deps.now()
      })
    );
    if (!observedRefResult.ok) {
      return observedRefResult;
    }
    const observedRef = observedRefResult.value;
    const probeId = allocateProbeId();
    const probeResult: HostProbeResult =
      load.state === "loaded" && !loaded
        ? "failed"
        : loaded
          ? roundtrip
            ? "passed"
            : "unknown"
          : load.state === "not_loaded" || load.state === "conflict"
            ? "failed"
            : "unknown";
    const probe: HostProbeRecord = {
      schema_version: "rsi.host_probe/2",
      probe_id: probeId,
      probe_contract_version: "host-probe/2",
      target_kind: "host",
      binding: binding.value,
      binding_key: bindingKey,
      probe_mode: "read_only",
      probe_action: "read_only",
      assertions: [
        {
          assertion_id: "managed_object_load:readback",
          capability: "managed_object_load",
          expected: `host reports loaded with observed_hash ${expectedHash} and a kernel collector confirms the provider path`,
          observed_ref: observedRef,
          pass: probeResult === "failed" ? false : roundtrip ? true : "unknown",
          ...(probeResult === "failed" ? { failure_code: `load_state_${load.state}` } : {})
        }
      ],
      capability_results: [
        {
          name: "managed_object_load",
          proposed_status: loaded ? (roundtrip ? "verified" : "unknown") : load.state === "unknown" || load.state === "pending" ? "unknown" : "failed",
          evidence_stage: roundtrip ? "roundtrip" : loaded ? "loaded" : load.state === "pending" ? "none" : "static",
          evidence_refs: loaded
            ? [...new Set([observedRef, ...readbackRefs, ...collectorRefs])]
            : [],
          ...(loaded ? {} : { failure_code: `load_state_${load.state}` })
        }
      ],
      result: probeResult,
      expected: "The runtime host read back the artifact hash that evoplug wrote.",
      observed: canonicalJsonText(
        toJsonValue({
          state: load.state,
          observed_hash: load.observed_hash ?? null,
          expected_hash: expectedHash,
          readback_refs: readbackRefs,
          collector_refs: collectorRefs
        })
      ),
      evidence_refs: [...new Set([observedRef, ...readbackRefs, ...collectorRefs])].sort(),
      duration_ms: Math.max(0, deps.now() - (row.issued_at ?? row.created_at)),
      checked_at: deps.now()
    };
    const validated = validateHostProbeRecord(probe);
    if (!validated.ok) {
      diagnostic(deps, "runtime_probe.check_load_record_invalid", validated.error);
      return validated;
    }
    if (probeExists(deps.connection, probeId)) {
      return ok({ status: "duplicate", applied_capabilities: [] });
    }
    const current = readCapability(deps.connection, bindingKey, "managed_object_load");
    const capabilityId = current?.record.capability_id ?? allocateCapabilityId();
    let next =
      applyProbeToCapability(current?.record ?? null, validated.value, "managed_object_load", {
        capability_id: capabilityId,
        now: deps.now()
      }) ?? applyLoadedStage({
        current,
        probe: validated.value,
        result: validated.value.capability_results[0]!,
        capability_id: capabilityId
      });
    if (current !== null && (next === null || next === current.record || next.status === "verified")) {
      const invalidated = invalidateVerified({
        current,
        probe: validated.value,
        result: validated.value.capability_results[0]!,
        artifact_changed: artifactChanged("check_load", registration, row.call_id)
      });
      if (invalidated !== null) {
        next = invalidated;
      }
    }
    const rows: HostStateRowInsertion[] = [
      {
        row_schema: "rsi.host_probe_row/1",
        operation: "insert",
        row: toHostProbePhysicalRow(validated.value, 1),
        document_id: null
      }
    ];
    const applied: CapabilityName[] = [];
    if (next !== null && (current === null || next !== current.record)) {
      rows.push({
        row_schema: "rsi.capability_record_row/1",
        operation: current === null ? "insert" : "transition",
        row: toCapabilityRecordPhysicalRow(next, current === null ? 1 : current.row_version + 1),
        document_id: null
      });
      applied.push("managed_object_load");
    }
    if (stopped) {
      return stoppedApply();
    }
    const written = await appendRows(rows);
    if (!written.ok) {
      diagnostic(deps, "runtime_probe.check_load_append_failed", written.error);
      return written;
    }
    return ok({ status: "applied", probe_id: probeId, applied_capabilities: applied });
  }

  function ifBindingUnsupported(
    binding: Result<CapabilityBinding | null, ErrorEnvelope>
  ): Result<ProbeApplyOutcome, ErrorEnvelope> {
    if (!binding.ok && binding.error.code === "E_PROBE_UNSUPPORTED") {
      return ok({ status: "skipped", rule: "binding_unsupported", applied_capabilities: [] });
    }
    return binding.ok
      ? ok({ status: "skipped", rule: "binding_unsupported", applied_capabilities: [] })
      : binding;
  }

  async function applyCompletion(
    input: HostRuntimeCallCompletion
  ): Promise<Result<ProbeApplyOutcome, ErrorEnvelope>> {
    if (!options.enabled) {
      return ok({ status: "disabled", applied_capabilities: [] });
    }
    if (stopped) {
      return stoppedApply();
    }
    if (input.result.kind === "probe" && input.result.state === "observed") {
      return applyProbe(input, input.result);
    }
    if (input.result.kind === "check_load" && input.result.state === "completed") {
      return applyCheckLoad(input, input.result);
    }
    return ok({ status: "skipped", rule: "not_a_probe_result", applied_capabilities: [] });
  }

  /**
   * Lifecycle hooks are fire-and-forget at the host-runtime seam, so the
   * producer owns the promises it starts. `drain` is the shutdown barrier.
   */
  const pending = new Set<Promise<void>>();

  function track(task: Promise<void>): Promise<void> {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task)
    );
    return task;
  }

  async function drain(): Promise<void> {
    // New work may be enqueued while an earlier batch settles (for example a
    // poll observed during shutdown), so keep draining until the set is empty.
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  function stop(input?: RuntimeProbeStopInput): Result<RuntimeProbeStopOutcome, ErrorEnvelope> {
    if (stopped) {
      return ok({ status: "already_stopped", pending_expired: 0, issued_uncertain: 0 });
    }
    stopped = true;
    signalStopped();
    // Issued first: it may have crossed the host boundary, so it must become
    // durable `uncertain` even if the second statement fails. Both statements
    // are idempotent and touch only this producer's call kinds.
    try {
      const issued = deps.connection
        .prepare(
          `UPDATE host_runtime_call SET state = 'uncertain', updated_at = :now
            WHERE kind IN ('probe', 'check_load') AND state = 'issued'`
        )
        .run({ now: deps.now() });
      const pendingClosed = deps.connection
        .prepare(
          `UPDATE host_runtime_call SET state = 'expired', updated_at = :now
            WHERE kind IN ('probe', 'check_load') AND state = 'pending'`
        )
        .run({ now: deps.now() });
      return ok({
        status: "stopped",
        pending_expired: pendingClosed.changes,
        issued_uncertain: issued.changes
      });
    } catch {
      diagnostic(deps, `runtime_probe.stop_failed${input?.reason === undefined ? "" : `.${input.reason}`}`);
      return err(internalFailure("runtime_probe.stop"));
    }
  }

  function scheduleQuietly(input: ProbeScheduleInput, rule: string): void {
    track(
      schedule(input)
        .then((outcome) => {
          if (!outcome.ok) {
            diagnostic(deps, rule, outcome.error);
          }
        })
        .catch(() => {
          diagnostic(deps, rule);
        })
    );
  }

  function hasLiveProbe(registrationHash: Hash): boolean {
    return (
      deps.connection
        .prepare<SqlRow>(
          `SELECT 1 AS present FROM host_runtime_call
            WHERE registration_hash = :registration_hash
              AND kind IN ('probe', 'check_load')
              AND state IN ('pending', 'issued')
            LIMIT 1`
        )
        .get({ registration_hash: registrationHash }) !== undefined
    );
  }

  /**
   * Synchronous arming, run inside the poll transaction.
   *
   * A probe/check_load intent row is inserted with a null boundary because at
   * attach time the kernel has no receipt. The first poll that carries a real
   * `event_identity_key` may arm the rows — but only when a committed
   * `trigger_event` exists for that key and its `host_binding` names this exact
   * runtime scope. No receipt, no arm; nothing is synthesized.
   */
  function armPendingProbeCalls(intent: {
    readonly session: HostRuntimeSessionRow;
    readonly event_identity_key: Hash | null;
    readonly hook_event: string | null;
    readonly now: number;
  }): void {
    if (!options.enabled || stopped) {
      return;
    }
    if (intent.event_identity_key === null || intent.hook_event === null) {
      return;
    }
    const session = intent.session;
    let hostBinding = readTriggerHostBinding(deps.connection, intent.event_identity_key);
    if (hostBinding === null) {
      // Review may never enqueue for a single-shot session, so a committed
      // trigger is not the only honest boundary. The exact binding of the
      // authenticated upload that produced this receipt is the alternative;
      // it is fully derived and verified above, never synthesized.
      const derived = deriveCommittedReceiptBinding(deps.connection, {
        session,
        event_identity_key: intent.event_identity_key,
        hook_event: intent.hook_event,
        now: intent.now
      });
      if (derived.status === "rejected") {
        if (!armRejectionsReported.has(derived.reason)) {
          armRejectionsReported.add(derived.reason);
          diagnostic(deps, `runtime_probe.arm_receipt_${derived.reason}`);
        }
        return;
      }
      if (derived.status !== "ok") {
        return;
      }
      hostBinding = derived.value.binding;
    }
    if (
      hostBinding.host_id !== session.host_id ||
      hostBinding.mode !== session.mode ||
      hostBinding.config_space !== session.config_space ||
      hostBinding.adapter_id !== session.adapter_id ||
      hostBinding.adapter_version !== session.adapter_version
    ) {
      diagnostic(deps, "runtime_probe.arm_scope_mismatch");
      return;
    }
    deps.connection
      .prepare(
        `UPDATE host_runtime_call SET
           boundary_event_key = :boundary_event_key,
           hook_event = :hook_event,
           updated_at = :now
         WHERE registration_hash = :registration_hash
           AND kind IN ('probe', 'check_load')
           AND state = 'pending'
           AND boundary_event_key IS NULL
           AND deadline_at > :now`
      )
      .run({
        boundary_event_key: intent.event_identity_key,
        hook_event: intent.hook_event,
        now: intent.now,
        registration_hash: session.registration_hash
      });
  }

  const lifecycle: HostRuntimeProbeLifecyclePort = {
    onSessionReady({ session }) {
      if (!options.on_attach || stopped) {
        return;
      }
      scheduleQuietly({ registration_hash: session.registration_hash }, "runtime_probe.ready_schedule");
    },
    onSessionPoll(intent) {
      if (stopped) {
        return;
      }
      // Throws are swallowed by the caller (`runPollIntentHook`); an unarmed
      // row simply stays pending for the next poll.
      armPendingProbeCalls(intent);
    },
    onPollObserved({ session }) {
      if (stopped || hasLiveProbe(session.registration_hash)) {
        return;
      }
      scheduleQuietly(
        { registration_hash: session.registration_hash },
        "runtime_probe.poll_schedule"
      );
    },
    async onCallCompleted(input) {
      if (stopped) {
        return;
      }
      return track(
        (async () => {
          const outcome = await applyCompletion(input);
          if (!outcome.ok) {
            diagnostic(deps, "runtime_probe.apply_completion", outcome.error);
          }
        })()
      );
    }
  };

  return {
    options,
    lifecycle,
    call_resolver: callResolver,
    schedule,
    applyCompletion,
    drain,
    stop
  };
}

/* ------------------------------------------------------------------ */
/* Kernel-owned evidence collector                                     */
/* ------------------------------------------------------------------ */

/**
 * One observation produced by a kernel-executed source.
 *
 * `source_id` identifies the concrete capture (a kernel-run SDK harness, a
 * kernel-managed provider proxy, a kernel-issued check command). It is chosen
 * by the kernel wiring, never by the host runtime.
 */
export interface KernelProbeObservation {
  readonly kind: "probe" | "check_load";
  readonly call_id: string;
  readonly nonce: string;
  readonly session_id: Id<"rts">;
  /** Session the call was issued to; defaults to `session_id` for same-session sources. */
  readonly call_session_id?: Id<"rts">;
  readonly registration_hash: Hash;
  readonly binding_key: Hash;
  readonly artifact_hash?: Hash;
  readonly native_session_id?: string | null;
  /** Capabilities this capture independently asserted for this call. */
  readonly capabilities: readonly CapabilityName[];
  /** The capture saw the probe nonce (roundtrip marker). */
  readonly nonce_observed: boolean;
  readonly observed_at: number;
  /** Raw capture bytes; persisted by the collector as provenance. */
  readonly evidence: readonly JsonValue[];
}

/**
 * A source the kernel executes itself. Implementations must derive their
 * observations from something the host runtime cannot author: kernel-run
 * native/SDK calls, controlled provider capture, or kernel-issued checks.
 * Runtime uploads, runtime session rows and runtime self-reports are not
 * admissible here.
 */
export interface KernelProbeObservationSource {
  readonly source_id: string;
  observe(
    input: KernelProbeEvidenceRequest
  ): Promise<Result<readonly KernelProbeObservation[], ErrorEnvelope>>;
}

interface KernelProbeEvidenceCollectorDeps {
  readonly blobs: {
    read(hash: Hash): Result<Uint8Array, ErrorEnvelope>;
    putSync(bytes: Uint8Array): Result<
      { readonly hash: Hash; readonly byte_length: number },
      ErrorEnvelope
    >;
  };
  /**
   * Kernel-executed observation source. When absent the collector returns
   * `null`, so the producer caps the result at `loaded`.
   */
  readonly source?: KernelProbeObservationSource;
  readonly now?: () => number;
  /** Bound on observations considered per call. */
  readonly max_observations?: number;
}

const KERNEL_COLLECTOR_ID = "kernel.native_observation";
const DEFAULT_MAX_OBSERVATIONS = 16;

/**
 * The production collector entry.
 *
 * Trust rules:
 * - Only observations returned by a kernel-executed `source` can upgrade a
 *   capability to `verified`/`roundtrip`. The collector never scans
 *   `host_runtime_upload`, never trusts `host_runtime_session.artifact_hash`,
 *   and never consults a runtime-supplied `provider_body_ref`/`receipt_ref`.
 * - Association (kind, call, nonce, session, registration, binding, artifact)
 *   must match the issued call exactly; any mismatch discards the observation.
 * - `probe` observations must have seen the nonce. `check_load` observations
 *   must supply at least one persisted evidence blob.
 * - Without a source, or with no admissible observation, the collector returns
 *   `null` and the producer keeps the capability at `loaded` or below.
 */
export function createKernelProbeEvidenceCollector(
  deps: KernelProbeEvidenceCollectorDeps
): KernelProbeEvidencePort {
  const nowFn = deps.now ?? Date.now;
void nowFn;
  const maxObservations = Math.max(1, deps.max_observations ?? DEFAULT_MAX_OBSERVATIONS);

  function refFor(hash: Hash, byteLength: number): string | null {
    const formatted = formatSourceRef({
      scheme: "blob",
      locator: hash,
      start: 0,
      end: byteLength
    });
    return formatted.ok ? formatted.value : null;
  }

  function persistObservation(
    observation: KernelProbeObservation,
    sourceId: string
  ): string[] | null {
    const fact = toJsonValue({
      schema_version: "rsi.kernel_probe_evidence/1",
      collector_id: KERNEL_COLLECTOR_ID,
      source: "kernel.observation",
      source_id: sourceId,
      kind: observation.kind,
      call_id: observation.call_id,
      nonce: observation.nonce,
      session_id: observation.session_id,
      call_session_id: observation.call_session_id ?? observation.session_id,
      registration_hash: observation.registration_hash,
      binding_key: observation.binding_key,
      artifact_hash: observation.artifact_hash ?? null,
      native_session_id: observation.native_session_id ?? null,
      capabilities: [...observation.capabilities],
      nonce_observed: observation.nonce_observed,
      observed_at: observation.observed_at,
      evidence: observation.evidence
    });
    const stored = deps.blobs.putSync(new TextEncoder().encode(canonicalJsonText(fact)));
    if (!stored.ok) {
      return null;
    }
    const ref = refFor(stored.value.hash, stored.value.byte_length);
    return ref === null ? null : [ref];
  }

  function admissible(input: KernelProbeEvidenceRequest, observation: KernelProbeObservation): boolean {
    if (
      observation.kind !== input.kind ||
      observation.call_id !== input.call_id ||
      observation.nonce !== input.nonce ||
      (observation.call_session_id ?? observation.session_id) !== input.session_id ||
      observation.registration_hash !== input.registration_hash ||
      observation.binding_key !== input.binding_key ||
      (observation.artifact_hash !== undefined &&
        observation.artifact_hash !== input.artifact_hash) ||
      !Number.isSafeInteger(observation.observed_at) ||
      observation.observed_at < input.issued_at ||
      observation.observed_at > input.deadline_at
    ) {
      return false;
    }
    if (observation.evidence.length === 0) {
      return false;
    }
    if (input.kind === "probe" && !observation.nonce_observed) {
      return false;
    }
    return observation.capabilities.some((name) => input.capabilities.includes(name));
  }

  return {
    async collect(input) {
      if (deps.source === undefined) {
        return ok(null);
      }
      let observed: Result<readonly KernelProbeObservation[], ErrorEnvelope>;
      try {
        observed = await deps.source.observe(input);
      } catch {
        return err(internalFailure(`kernel_probe_collector.${input.kind}`));
      }
      if (!observed.ok) {
        return observed;
      }
      const candidates = observed.value.slice(0, maxObservations);
      for (const observation of candidates) {
        if (!admissible(input, observation)) {
          continue;
        }
        const refs = persistObservation(observation, deps.source.source_id);
        if (refs === null) {
          continue;
        }
        const capabilities = observation.capabilities.filter((name) =>
          input.capabilities.includes(name)
        );
        return ok({
          collector_id: KERNEL_COLLECTOR_ID,
          kind: input.kind,
          call_id: input.call_id,
          nonce: input.nonce,
          session_id: observation.session_id,
          call_session_id: observation.call_session_id ?? observation.session_id,
          registration_hash: input.registration_hash,
          binding_key: input.binding_key,
          artifact_hash: input.artifact_hash,
          capabilities,
          ...(input.kind === "probe" ? { nonce_evidence_ref: refs[0] } : {}),
          evidence_refs: refs,
          // The observation's real kernel capture time, inside the call window.
          observed_at: observation.observed_at
        });
      }
      return ok(null);
    }
  };
}
