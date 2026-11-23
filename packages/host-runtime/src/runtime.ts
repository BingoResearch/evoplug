/**
 * Host-side runtime lifecycle (DD-HOST-200.4, DD-HOST-201, DD-HOST-202).
 *
 * `startHostRuntime` verifies the artifact, authenticates one runtime session,
 * and exposes the three runtime directions: raw event upload, long-polling for
 * RuntimeCalls, and result reporting. It never normalizes events, allocates
 * product ids or writes storage. Errors are mapped into the closed
 * `HostAdapterError` vocabulary.
 */

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalJsonText,
  formatSourceRef,
  hashBytes,
  hashUtf8,
  isHash,
  isWellFormedUnicode,
  type Hash,
  type JsonValue,
  type SourceRef
} from "@evoplug/core";
import {
  capabilityBindingKey,
  makeHostAdapterError,
  type ContentUpload,
  type HostAdapterError,
  type HostEventRejection,
  type HostRuntimeReadyResult,
  type NativeIds,
  type RawHostEventUpload,
  type RuntimeCall,
  type RuntimeCallResult
} from "@evoplug/core/host";
import type { ErrorEnvelope, IngestReceipt } from "@evoplug/core";
import { toJsonValue } from "@evoplug/ipc";

import {
  verifyArtifactAtLoad,
  type HostRuntimeArtifactIssue,
  type HostRuntimeConfig
} from "./artifact.js";
import {
  computeHostRuntimeConfigHash
} from "./config.js";
import {
  HostRuntimeClient,
  hostRuntimeIdempotencyKey
} from "./client.js";
import {
  DEFAULT_REDACT_PREFIXES,
  redactJsonPayload,
  type HostRuntimeRedactionManifest
} from "./redact.js";

/** Kernel-side decoded payload cap (DD-HOST-202); config may only lower it. */
const HOST_RUNTIME_MAX_PAYLOAD_BYTES = 8_388_608;
/** Encoded IPC body cap (DD-HOST-202). */
const HOST_RUNTIME_MAX_IPC_BODY_BYTES = 16_777_216;
const HOST_RUNTIME_DEFAULT_QUEUE_CAPACITY = 64;
const HOST_RUNTIME_REDACTION_CONTEXT_PREFIX = "rr1:";

export type HostRuntimePayload = string | Uint8Array | JsonValue;

interface EncodedHostRuntimePayload {
  readonly content: ContentUpload;
  readonly payload_hash: Hash;
  readonly redaction_manifest: HostRuntimeRedactionManifest | null;
  readonly redaction_manifest_hash: Hash | null;
}

type HostRuntimePayloadEncoding =
  | { readonly ok: true; readonly value: EncodedHostRuntimePayload }
  | { readonly ok: false; readonly error: HostAdapterError; readonly rule: string };

interface HostRuntimeHooks {
  /** Directory that contains `manifest.json` (or `<name>.runtime/`). */
  readonly artifact_root: string;
  /**
   * Optional cross-check of the registration hash stored in `config.json`.
   * When present it must equal `config.registration_hash`.
   */
  readonly registration_hash?: Hash;
  readonly host_version?: string;
  readonly binary_hash?: Hash | null;
  readonly ephemeral?: boolean;
  /**
   * Appendix L.1: `host_session` unless this process is a kernel-launched
   * probe. The probe environment pair overrides it to `evaluator`.
   */
  readonly session_role?: "evaluator" | "host_session";
  /**
   * Appendix M.1: the host session's working directory, normally the hook
   * payload's `cwd`. The kernel uses it to bind the task to a project; an
   * absent value leaves the task unbound.
   */
  readonly working_directory?: string | null;
  readonly instance_key?: string | null;
  /** Optional fixed ready key; a retry with the same key replays the session. */
  readonly ready_idempotency_key?: string;
  readonly product_version?: string;
  readonly pid?: number;
  readonly started_at?: number;
  readonly now?: () => number;
  readonly upload_queue_capacity?: number;
  /** Upper bound applied on top of the ready limit. */
  readonly poll_wait_max_ms?: number;
  readonly onCall?: (call: RuntimeCall) => void | Promise<void>;
  readonly onShutdown?: () => void;
  readonly onError?: (error: HostAdapterError) => void;
}

interface StartHostRuntimeOptions {
  readonly config: HostRuntimeConfig;
  readonly hooks: HostRuntimeHooks;
}

/**
 * Probe-only isolation channel. A kernel-launched host sets both values; the
 * runtime then authenticates an ephemeral session with its own instance key so
 * an observation run cannot reuse and overwrite a user's non-ephemeral session
 * row. Normal entries leave both unset and keep their declared hooks.
 */
export const PROBE_SESSION_MODE_ENV = "EVOPLUG_PROBE_SESSION_MODE";
export const PROBE_SESSION_INSTANCE_ENV = "EVOPLUG_PROBE_SESSION_INSTANCE";
export const PROBE_SESSION_INSTANCE_MAX_CHARS = 128;

type RuntimeSessionScopeResolution =
  | {
      readonly ok: true;
      readonly ephemeral: boolean;
      readonly session_role: "evaluator" | "host_session";
      readonly instance_key: string | null;
    }
  | {
      readonly ok: false;
      readonly rule: "probe_session_mode" | "probe_session_instance";
    };

/**
 * Resolves the effective session scope. The probe env pair is an override, not
 * a default: a launcher that asks for isolation must get it even when the
 * entry hard-codes `ephemeral: false`. A half-set pair fails closed instead of
 * silently falling back to the shared session.
 */
export function resolveRuntimeSessionScope(
  hooks: HostRuntimeHooks,
  env: NodeJS.ProcessEnv = process.env
): RuntimeSessionScopeResolution {
  const mode = env[PROBE_SESSION_MODE_ENV];
  const instance = env[PROBE_SESSION_INSTANCE_ENV];
  if (mode === undefined && instance === undefined) {
    return {
      ok: true,
      ephemeral: hooks.ephemeral ?? false,
      session_role: hooks.session_role ?? "host_session",
      instance_key: hooks.instance_key ?? null
    };
  }
  if (mode !== "ephemeral") {
    return { ok: false, rule: "probe_session_mode" };
  }
  if (
    instance === undefined ||
    instance.length === 0 ||
    instance.length > PROBE_SESSION_INSTANCE_MAX_CHARS ||
    instance.includes("\0")
  ) {
    return { ok: false, rule: "probe_session_instance" };
  }
  return { ok: true, ephemeral: true, session_role: "evaluator", instance_key: instance };
}

export interface HostRuntimeSubmitOutcome {
  readonly ok: boolean;
  readonly state: "ingested" | "duplicate" | "rejected" | "degraded";
  readonly receipt: IngestReceipt | null;
  readonly rejection: HostEventRejection | null;
  readonly redaction_manifest_hash: Hash | null;
  /**
   * CAS blob written by the kernel for an accepted upload. This is the real
   * `blob://<payload_hash>#bytes=0-<byte_length>` reference, not a synthetic
   * diagnostic seed. It is null when no accepted upload exists.
   */
  readonly content_ref: SourceRef | null;
  readonly error: HostAdapterError | null;
}

interface HostRuntimePollOutcome {
  readonly ok: boolean;
  readonly kind: "none" | "call" | "shutdown";
  readonly call: RuntimeCall | null;
  readonly error: HostAdapterError | null;
}

export interface HostRuntimeResultOutcome {
  readonly ok: boolean;
  readonly recorded: boolean;
  readonly error: HostAdapterError | null;
}

export interface HostRuntime {
  readonly session_id: string;
  readonly session_nonce: string;
  readonly limits: HostRuntimeReadyResult["limits"];
  readonly artifact_hash: Hash;
  readonly load_verified_hash: Hash;
  readonly config_hash: Hash;
  readonly allow_delivery: boolean;
  readonly closed: boolean;
  readonly queue_depth: number;
  submitHostEvent(
    hostEvent: string,
    nativeIds: NativeIds,
    payload: HostRuntimePayload,
    receivedAt: number
  ): Promise<HostRuntimeSubmitOutcome>;
  /**
   * One poll round. `waitMs` overrides the configured long-poll window for
   * this call: 0 returns immediately, which is what a backlog flush needs so
   * it never leaves a long poll in flight that the next hook collides with.
   */
  pollOnce(
    hookEvent: string | null,
    identityKey: Hash | null,
    waitMs?: number
  ): Promise<HostRuntimePollOutcome>;
  reportResult(callId: string, result: RuntimeCallResult): Promise<HostRuntimeResultOutcome>;
  close(): void;
}

type StartHostRuntimeResult =
  | { readonly ok: true; readonly runtime: HostRuntime }
  | {
      readonly ok: false;
      readonly error: HostAdapterError;
      readonly issues: readonly HostRuntimeArtifactIssue[];
    };

function nowMs(hooks: HostRuntimeHooks): number {
  return hooks.now === undefined ? Date.now() : hooks.now();
}

function traceStart(message: string): void {
  if (process.env["EVOPLUG_DEBUG_IPC"] !== "1") return;
  try {
    appendFileSync(
      process.env["EVOPLUG_RUNTIME_TRACE"] ?? join(tmpdir(), "evoplug-runtime-start.log"),
      `${JSON.stringify({ at: Date.now(), message })}\n`
    );
  } catch {
    // Trace only.
  }
}

/** Builds a real SourceRef over a diagnostic seed (no blob is written). */
function runtimeDetailRef(seed: string): SourceRef {
  const text = seed.length === 0 ? "host_runtime_error" : seed;
  const bytes = new TextEncoder().encode(text);
  return `blob://${hashBytes(bytes)}#bytes=0-${String(bytes.length)}` as SourceRef;
}

/**
 * Content address of the CAS blob the kernel writes for one encoded upload.
 * Call this only after an accepted upload outcome; the returned reference is
 * the real payload blob, not a diagnostic seed.
 */
export function hostRuntimeContentRef(encoded: EncodedHostRuntimePayload): SourceRef | null {
  const formatted = formatSourceRef({
    scheme: "blob",
    locator: encoded.payload_hash,
    start: 0,
    end: encoded.content.byte_length
  });
  return formatted.ok ? formatted.value : null;
}

/**
 * Diagnostic written by the runtime when it cannot observe a `probe` call.
 *
 * `source="runtime.call"` states the provenance explicitly: these bytes are a
 * runtime-call diagnostic, not a native host event. The upload carries a
 * registered input-family event name only because the frozen upload method has
 * no other CAS channel; the payload omits every prompt field and every native
 * id, so the kernel rejects it at finalize/phase B and never persists an
 * event. The rejection's `detail_ref` is the real CAS blob of these bytes.
 */
interface RuntimeCallDiagnostic {
  readonly schema_version: "rsi.runtime_call_diagnostic/1";
  readonly source: "runtime.call";
  readonly call_id: string;
  readonly call_kind: "probe";
  readonly code: "E_UNSUPPORTED";
  readonly reason: "no_host_observation";
  readonly observed_at: number;
  readonly probe_id: string;
  readonly probe_action: string;
  readonly binding_key: Hash;
}

/** Builds the runtime-call diagnostic; `null` for calls handled elsewhere. */
export function runtimeCallDiagnostic(
  call: RuntimeCall,
  observedAt: number = Date.now()
): RuntimeCallDiagnostic | null {
  if (call.kind !== "probe") {
    return null;
  }
  return {
    schema_version: "rsi.runtime_call_diagnostic/1",
    source: "runtime.call",
    call_id: call.call_id,
    call_kind: "probe",
    code: "E_UNSUPPORTED",
    reason: "no_host_observation",
    observed_at: observedAt,
    probe_id: call.request.probe_id,
    probe_action: call.request.probe_action,
    binding_key: capabilityBindingKey(call.request.binding)
  };
}

/**
 * The only honest result for a non-delivery call when the runtime has no
 * session readback or host observation:
 *
 * - `check_load` cannot prove the host loaded the written object, so it reports
 *   `unknown` with no evidence instead of claiming `loaded`;
 * - `probe` returns `E_UNSUPPORTED` whose `detail_ref` must be a real CAS blob
 *   produced by the diagnostic upload. Without that evidence the caller leaves
 *   the call unanswered rather than inventing a reference.
 *
 * `deliver` is never handled here: each runtime keeps its existing delivery
 * path so this helper cannot suppress injection.
 */
export function unavailableRuntimeCallResult(
  call: RuntimeCall,
  detailRef: SourceRef | null,
  observedAt: number = Date.now()
): RuntimeCallResult | null {
  if (call.kind === "check_load") {
    return {
      kind: "check_load",
      state: "completed",
      result: {
        request_id: call.request.request_id,
        state: "unknown",
        evidence_refs: []
      }
    };
  }
  if (call.kind === "probe") {
    if (detailRef === null) return null;
    return {
      kind: "error",
      error: makeHostAdapterError({
        code: "E_UNSUPPORTED",
        retryable: false,
        detail_ref: detailRef,
        observed_at: observedAt
      })
    };
  }
  return null;
}

interface RuntimeCallDiagnosticOptions {
  /**
   * Registered input-family host event used solely as the frozen upload
   * carrier. The diagnostic payload contains no prompt field or native id, so
   * the kernel rejects it and records the CAS reference as the rejection's
   * `detail_ref`; no native event is created.
   */
  readonly carrier_event: string;
  readonly observed_at?: number;
}

interface RuntimeCallDiagnosticOutcome {
  readonly handled: boolean;
  readonly detail_ref: SourceRef | null;
  readonly rejection_reason: HostEventRejection["reason"] | null;
}

/**
 * Answers one non-delivery runtime call honestly.
 *
 * `check_load` is answered locally with `unknown` and empty evidence. `probe`
 * first uploads {@link RuntimeCallDiagnostic} through the frozen upload method
 * and then reports `E_UNSUPPORTED` only when the kernel's phase-B rejection
 * names a real CAS `detail_ref`. If the diagnostic cannot be rejected with a
 * CAS reference (submission disabled, unbound carrier, transport failure), the
 * call stays unanswered so the host-side deadline applies instead of a
 * fabricated reference.
 *
 * `deliver` is ignored so the caller's own delivery path remains the only
 * producer of delivery results.
 */
export async function reportUnavailableRuntimeCall(
  runtime: HostRuntime,
  call: RuntimeCall,
  options: RuntimeCallDiagnosticOptions
): Promise<RuntimeCallDiagnosticOutcome> {
  const observedAt = options.observed_at ?? Date.now();
  if (call.kind === "deliver") {
    return { handled: false, detail_ref: null, rejection_reason: null };
  }
  if (call.kind === "check_load") {
    const result = unavailableRuntimeCallResult(call, null, observedAt);
    if (result === null) {
      return { handled: false, detail_ref: null, rejection_reason: null };
    }
    const reported = await runtime.reportResult(call.call_id, result);
    if (!reported.ok || !reported.recorded) {
      return { handled: false, detail_ref: null, rejection_reason: null };
    }
    return { handled: true, detail_ref: null, rejection_reason: null };
  }

  const diagnostic = runtimeCallDiagnostic(call, observedAt);
  if (diagnostic === null) {
    return { handled: false, detail_ref: null, rejection_reason: null };
  }
  const diagnosticPayload = toJsonValue(diagnostic);
  if (!diagnosticPayload.ok) {
    return { handled: false, detail_ref: null, rejection_reason: null };
  }
  const outcome = await runtime.submitHostEvent(
    options.carrier_event,
    {},
    diagnosticPayload.value,
    observedAt
  );
  const rejection = outcome.rejection;
  const detailRef =
    rejection !== null && rejection.phase === "B" ? rejection.detail_ref : null;
  if (detailRef === null) {
    return {
      handled: false,
      detail_ref: null,
      rejection_reason: rejection === null ? null : rejection.reason
    };
  }
  const result = unavailableRuntimeCallResult(call, detailRef, observedAt);
  if (result === null) {
    return {
      handled: false,
      detail_ref: null,
      rejection_reason: rejection === null ? null : rejection.reason
    };
  }
  const reported = await runtime.reportResult(call.call_id, result);
  if (!reported.ok || !reported.recorded) {
    return {
      handled: false,
      detail_ref: null,
      rejection_reason: rejection === null ? null : rejection.reason
    };
  }
  return {
    handled: true,
    detail_ref: detailRef,
    rejection_reason: rejection === null ? null : rejection.reason
  };
}

function adapterError(input: {
  code: HostAdapterError["code"];
  retryable: boolean;
  observed_at: number;
  seed: string;
}): HostAdapterError {
  return makeHostAdapterError({
    code: input.code,
    retryable: input.retryable,
    detail_ref: runtimeDetailRef(input.seed),
    observed_at: input.observed_at
  });
}

/** Maps one IPC error envelope into the closed adapter vocabulary. */
export function mapIpcErrorToHostAdapterError(
  error: ErrorEnvelope,
  observedAt: number
): HostAdapterError {
  const seed = `${error.code}:${error.stage}:${error.trace_id}`;
  switch (error.code) {
    case "E_DEADLINE_EXCEEDED":
      return adapterError({ code: "E_DEADLINE_EXCEEDED", retryable: true, observed_at: observedAt, seed });
    case "E_CANCELLED":
      return adapterError({ code: "E_CANCELLED", retryable: error.retryable, observed_at: observedAt, seed });
    case "E_IPC_AUTH":
    case "E_HOST_RUNTIME_SESSION":
    case "E_HOST_RUNTIME_UNBOUND":
      return adapterError({ code: "E_AUTH_UNAVAILABLE", retryable: false, observed_at: observedAt, seed });
    case "E_UNSUPPORTED":
      return adapterError({ code: "E_CAPABILITY", retryable: false, observed_at: observedAt, seed });
    case "E_HOST_RUNTIME_ARTIFACT":
    case "E_HOST_REJECTED":
      return adapterError({ code: "E_HOST_REJECTED", retryable: false, observed_at: observedAt, seed });
    case "E_ARTIFACT_MISMATCH":
    case "E_CONFLICT":
    case "E_HOST_RUNTIME_BUSY":
      return adapterError({ code: "E_CONFLICT", retryable: true, observed_at: observedAt, seed });
    case "E_EVENT_TOO_LARGE":
    case "E_SCHEMA":
      return adapterError({ code: "E_SCHEMA", retryable: false, observed_at: observedAt, seed });
    case "E_EVIDENCE_UNKNOWN":
      return adapterError({ code: "E_EVIDENCE_UNKNOWN", retryable: false, observed_at: observedAt, seed });
    case "E_IPC_DISCONNECTED":
    case "E_IPC_PROTOCOL":
    case "E_IPC_BUSY":
      return adapterError({ code: "E_IO", retryable: true, observed_at: observedAt, seed });
    default:
      return adapterError({ code: "E_INTERNAL", retryable: error.retryable, observed_at: observedAt, seed });
  }
}

function invalidPayload(observedAt: number, rule: string): HostRuntimePayloadEncoding {
  return {
    ok: false,
    rule,
    error: adapterError({
      code: "E_SCHEMA",
      retryable: false,
      observed_at: observedAt,
      seed: `payload:${rule}`
    })
  };
}

/**
 * Encodes one payload for upload. Text keeps its UTF-8 bytes, JSON values are
 * redacted structurally and then JCS-encoded, and binary values are base64.
 * Empty payloads are rejected; `payload_hash` is always `sha256(bytes)`.
 */
export function encodeHostRuntimePayload(
  payload: HostRuntimePayload,
  redactFields: readonly string[] = DEFAULT_REDACT_PREFIXES,
  maxPayloadBytes: number = HOST_RUNTIME_MAX_PAYLOAD_BYTES,
  observedAt: number = Date.now()
): HostRuntimePayloadEncoding {
  const limit = Math.min(maxPayloadBytes, HOST_RUNTIME_MAX_PAYLOAD_BYTES);
  if (typeof payload === "string") {
    if (payload.length === 0) {
      return invalidPayload(observedAt, "empty_payload");
    }
    if (!isWellFormedUnicode(payload)) {
      return invalidPayload(observedAt, "lone_surrogate");
    }
    const bytes = new TextEncoder().encode(payload);
    if (bytes.length > limit) {
      return invalidPayload(observedAt, "payload_too_large");
    }
    return {
      ok: true,
      value: {
        content: {
          media_type: "text/plain;charset=utf-8",
          encoding: "utf8",
          data: payload,
          byte_length: bytes.length
        },
        payload_hash: hashBytes(bytes),
        redaction_manifest: null,
        redaction_manifest_hash: null
      }
    };
  }
  if (payload instanceof Uint8Array) {
    if (payload.byteLength === 0) {
      return invalidPayload(observedAt, "empty_payload");
    }
    if (payload.byteLength > limit) {
      return invalidPayload(observedAt, "payload_too_large");
    }
    const bytes = Uint8Array.from(payload);
    return {
      ok: true,
      value: {
        content: {
          media_type: "application/octet-stream",
          encoding: "base64",
          data: Buffer.from(bytes).toString("base64"),
          byte_length: bytes.byteLength
        },
        payload_hash: hashBytes(bytes),
        redaction_manifest: null,
        redaction_manifest_hash: null
      }
    };
  }
  const converted = toJsonValue(payload);
  if (!converted.ok) {
    return invalidPayload(observedAt, converted.reason);
  }
  const redacted = redactJsonPayload(converted.value, redactFields);
  let bytes: Uint8Array;
  try {
    bytes = canonicalJson(redacted.value);
  } catch {
    return invalidPayload(observedAt, "invalid_json");
  }
  if (bytes.length === 0) {
    return invalidPayload(observedAt, "empty_payload");
  }
  if (bytes.length > limit) {
    return invalidPayload(observedAt, "payload_too_large");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    ok: true,
    value: {
      content: {
        media_type: "application/json",
        encoding: "utf8",
        data: text,
        byte_length: bytes.length
      },
      payload_hash: hashBytes(bytes),
      redaction_manifest: redacted.removed > 0 ? redacted.manifest : null,
      redaction_manifest_hash: redacted.removed > 0 ? redacted.redaction_manifest_hash : null
    }
  };
}

const NATIVE_ID_KEYS: readonly (keyof NativeIds)[] = [
  "session_id",
  "turn_id",
  "message_id",
  "event_id",
  "tool_call_id",
  "parent_tool_call_id",
  "injection_message_id",
  "persisted_message_id"
];

function normalizeNativeIds(nativeIds: NativeIds): NativeIds | null {
  const output: NativeIds = {};
  for (const key of NATIVE_ID_KEYS) {
    const value = nativeIds[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return null;
    }
    Object.assign(output, { [key]: value });
  }
  return output;
}

function rawEventId(input: {
  adapter_id: string;
  host_id: string;
  mode: string;
  config_space: string;
  host_event: string;
  received_at: number;
  native_ids: NativeIds;
  payload_hash: Hash;
}): string {
  const canonical = canonicalJsonText({
    schema_version: "rsi.host_runtime_raw_event/1",
    adapter_id: input.adapter_id,
    host_id: input.host_id,
    mode: input.mode,
    config_space: input.config_space,
    host_event: input.host_event,
    received_at: input.received_at,
    native_ids: input.native_ids as unknown as JsonValue,
    payload_hash: input.payload_hash
  });
  return `rt1-${hashUtf8(canonical).slice("sha256:".length)}`;
}

function submitOutcome(
  state: HostRuntimeSubmitOutcome["state"],
  input: {
    receipt?: IngestReceipt | null;
    rejection?: HostEventRejection | null;
    redaction_manifest_hash?: Hash | null;
    content_ref?: SourceRef | null;
    error?: HostAdapterError | null;
  }
): HostRuntimeSubmitOutcome {
  return {
    ok: state === "ingested" || state === "duplicate",
    state,
    receipt: input.receipt ?? null,
    rejection: input.rejection ?? null,
    redaction_manifest_hash: input.redaction_manifest_hash ?? null,
    content_ref: input.content_ref ?? null,
    error: input.error ?? null
  };
}

interface QueueJob {
  readonly run: () => Promise<HostRuntimeSubmitOutcome>;
  readonly resolve: (outcome: HostRuntimeSubmitOutcome) => void;
}

function localFailure(
  code: HostAdapterError["code"],
  retryable: boolean,
  observedAt: number,
  rule: string
): HostAdapterError {
  return adapterError({ code, retryable, observed_at: observedAt, seed: rule });
}

/**
 * Starts the runtime: verifies the artifact, connects, sends ready and returns
 * the upload/poll/result surface. Any artifact or identity mismatch fails
 * before the socket is opened or after a failed ready, and the client closes.
 */
export async function startHostRuntime(
  options: StartHostRuntimeOptions
): Promise<StartHostRuntimeResult> {
  const { config, hooks } = options;
  const startedAt = hooks.started_at ?? nowMs(hooks);
  const pid = hooks.pid ?? process.pid;
  const scope = resolveRuntimeSessionScope(hooks);
  if (!scope.ok) {
    return {
      ok: false,
      issues: [],
      error: localFailure("E_SCHEMA", false, startedAt, scope.rule)
    };
  }
  const ephemeral = scope.ephemeral;
  const instanceKey = scope.instance_key;
  if (!isHash(config.registration_hash)) {
    return {
      ok: false,
      issues: [],
      error: localFailure("E_SCHEMA", false, startedAt, "registration_hash")
    };
  }
  if (
    hooks.registration_hash !== undefined &&
    hooks.registration_hash !== config.registration_hash
  ) {
    return {
      ok: false,
      issues: [],
      error: localFailure("E_SCHEMA", false, startedAt, "registration_hash_mismatch")
    };
  }
  if (ephemeral && instanceKey === null) {
    return {
      ok: false,
      issues: [],
      error: localFailure("E_SCHEMA", false, startedAt, "ephemeral_instance_key")
    };
  }
  if (hooks.binary_hash !== undefined && hooks.binary_hash !== null && !isHash(hooks.binary_hash)) {
    return {
      ok: false,
      issues: [],
      error: localFailure("E_SCHEMA", false, startedAt, "binary_hash")
    };
  }

  const verification = await verifyArtifactAtLoad(hooks.artifact_root);
  if (!verification.ok) {
    return {
      ok: false,
      issues: verification.issues,
      error: localFailure("E_HOST_REJECTED", false, startedAt, "artifact_verification")
    };
  }
  const verified = verification.value;
  if (
    verified.manifest.host_id !== config.host_id ||
    verified.manifest.adapter_id !== config.adapter_id ||
    verified.manifest.adapter_version !== config.adapter_version ||
    verified.manifest.implementation_hash !== config.implementation_hash
  ) {
    return {
      ok: false,
      issues: [],
      error: localFailure("E_HOST_REJECTED", false, startedAt, "artifact_identity_mismatch")
    };
  }

  const configHash = computeHostRuntimeConfigHash(config);
  const connected = await HostRuntimeClient.connect(config, {
    product_version: hooks.product_version ?? "0.0.0",
    pid
  });
  if (!connected.ok) {
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug debug ipc connect code=${connected.error.code} stage=${connected.error.stage}\n`
      );
      traceStart(`connect code=${connected.error.code} stage=${connected.error.stage} details=${JSON.stringify(connected.error.details)} home=${config.ipc.evoplug_home}`);
    }
    return {
      ok: false,
      issues: [],
      error: mapIpcErrorToHostAdapterError(connected.error, nowMs(hooks))
    };
  }
  const client = connected.value;

  const readyKey =
    hooks.ready_idempotency_key ??
    hostRuntimeIdempotencyKey(
      config.registration_hash,
      "ready",
      `${String(pid)}:${String(startedAt)}:${instanceKey ?? ""}`
    );
  const readyPayload = {
    schema_version: "rsi.host_runtime_ready/1" as const,
    registration_hash: config.registration_hash,
    host_id: config.host_id,
    mode: config.mode,
    config_space: config.config_space,
    adapter_id: config.adapter_id,
    adapter_version: config.adapter_version,
    implementation_hash: config.implementation_hash,
    artifact_hash: verified.artifact_hash,
    config_hash: configHash,
    load_verified_hash: verified.load_verified_hash,
    host_version: hooks.host_version ?? "unknown",
    binary_hash: hooks.binary_hash ?? null,
    ephemeral,
    session_role: scope.session_role,
    working_directory: hooks.working_directory ?? process.cwd(),
    instance_key: instanceKey,
    pid,
    started_at: startedAt
  };
  const ready = await client.ready(readyPayload, readyKey);
  if (!ready.ok) {
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug debug ipc ready code=${ready.error.code} stage=${ready.error.stage}\n`
      );
      traceStart(`ready code=${ready.error.code} stage=${ready.error.stage}`);
    }
    client.close();
    return {
      ok: false,
      issues: [],
      error: mapIpcErrorToHostAdapterError(ready.error, nowMs(hooks))
    };
  }
  const session = ready.value;
  const queueCapacity = hooks.upload_queue_capacity ?? HOST_RUNTIME_DEFAULT_QUEUE_CAPACITY;
  const maxPayloadBytes = Math.min(
    config.behavior.max_payload_bytes,
    session.limits.max_payload_bytes
  );
  const queue: QueueJob[] = [];
  let draining = false;
  let closed = false;
  let shutdownReceived = false;
  let renewSequence = 0;
  /**
   * Re-authenticates after the session lease expired. A long host turn can
   * leave no upload or poll for longer than the resident lease; the first
   * request after that gap is rejected with `E_AUTH_UNAVAILABLE`, and without
   * this renewal every later event of the same session would be lost. A
   * renewal is an ordinary `ready` with a fresh idempotency key: the server
   * refreshes a ready session or creates a new one when the old row already
   * failed.
   */
  async function renewSession(): Promise<boolean> {
    renewSequence += 1;
    const renewed = await client.ready(
      readyPayload,
      `${readyKey}:renew:${String(renewSequence)}:${String(nowMs(hooks))}`
    );
    return renewed.ok;
  }
  function isSessionAuthFailure(error: { readonly code: string }): boolean {
    return (
      error.code === "E_HOST_RUNTIME_SESSION" ||
      error.code === "E_HOST_RUNTIME_UNBOUND" ||
      error.code === "E_IPC_AUTH"
    );
  }

  const startDrain = (): void => {
    if (draining) {
      return;
    }
    draining = true;
    void (async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) {
          break;
        }
        let outcome: HostRuntimeSubmitOutcome;
        try {
          outcome = await next.run();
        } catch {
          outcome = submitOutcome("degraded", {
            error: localFailure("E_INTERNAL", true, nowMs(hooks), "upload_queue")
          });
        }
        next.resolve(outcome);
      }
      draining = false;
      if (queue.length > 0) {
        startDrain();
      }
    })();
  };

  const runtime: HostRuntime = {
    session_id: session.session_id,
    session_nonce: session.session_nonce,
    limits: session.limits,
    artifact_hash: verified.artifact_hash,
    load_verified_hash: verified.load_verified_hash,
    config_hash: configHash,
    allow_delivery: config.behavior.allow_delivery,
    get closed(): boolean {
      return closed;
    },
    get queue_depth(): number {
      return queue.length;
    },
    async submitHostEvent(
      hostEvent: string,
      nativeIds: NativeIds,
      payload: HostRuntimePayload,
      receivedAt: number
    ): Promise<HostRuntimeSubmitOutcome> {
      if (closed) {
        return submitOutcome("rejected", {
          error: localFailure("E_CANCELLED", false, nowMs(hooks), "runtime_closed")
        });
      }
      if (!config.behavior.submit_events) {
        return submitOutcome("rejected", {
          error: localFailure("E_UNSUPPORTED", false, nowMs(hooks), "submit_events_disabled")
        });
      }
      if (typeof hostEvent !== "string" || hostEvent.length === 0) {
        return submitOutcome("rejected", {
          error: localFailure("E_SCHEMA", false, nowMs(hooks), "host_event")
        });
      }
      if (typeof nativeIds !== "object" || nativeIds === null) {
        return submitOutcome("rejected", {
          error: localFailure("E_SCHEMA", false, nowMs(hooks), "native_ids")
        });
      }
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
        return submitOutcome("rejected", {
          error: localFailure("E_SCHEMA", false, nowMs(hooks), "received_at")
        });
      }
      const normalizedIds = normalizeNativeIds(nativeIds);
      if (normalizedIds === null) {
        return submitOutcome("rejected", {
          error: localFailure("E_SCHEMA", false, nowMs(hooks), "native_ids")
        });
      }
      const encoded = encodeHostRuntimePayload(
        payload,
        config.behavior.redact_fields,
        maxPayloadBytes,
        nowMs(hooks)
      );
      if (!encoded.ok) {
        return submitOutcome("rejected", { error: encoded.error });
      }
      const eventId = rawEventId({
        adapter_id: config.adapter_id,
        host_id: config.host_id,
        mode: config.mode,
        config_space: config.config_space,
        host_event: hostEvent,
        received_at: receivedAt,
        native_ids: normalizedIds,
        payload_hash: encoded.value.payload_hash
      });
      const upload: RawHostEventUpload = {
        schema_version: "rsi.raw_host_event_upload/1",
        raw_event_id: eventId,
        adapter_id: config.adapter_id,
        host_id: config.host_id,
        mode: config.mode,
        config_space: config.config_space,
        host_event: hostEvent,
        received_at: receivedAt,
        payload: encoded.value.content,
        payload_hash: encoded.value.payload_hash,
        native_ids: normalizedIds,
        ...(encoded.value.redaction_manifest_hash === null
          ? {}
          : {
              adapter_context_ref: `${HOST_RUNTIME_REDACTION_CONTEXT_PREFIX}${encoded.value.redaction_manifest_hash.slice(
                "sha256:".length
              )}`
            })
      };
      const idempotencyKey = hostRuntimeIdempotencyKey(
        config.registration_hash,
        "upload",
        eventId
      );
      const encodedBodyBytes =
        Buffer.byteLength(
          JSON.stringify({
            schema_version: "rsi.host_runtime_upload/1",
            session_id: session.session_id,
            session_nonce: session.session_nonce,
            upload
          }),
          "utf8"
        ) + 1024;
      if (encodedBodyBytes > HOST_RUNTIME_MAX_IPC_BODY_BYTES) {
        return submitOutcome("rejected", {
          error: localFailure("E_SCHEMA", false, nowMs(hooks), "ipc_body_too_large")
        });
      }
      if (queue.length >= queueCapacity) {
        const error = localFailure("E_HOST_REJECTED", true, nowMs(hooks), "upload_queue_full");
        hooks.onError?.(error);
        return submitOutcome("degraded", { error });
      }
      return new Promise<HostRuntimeSubmitOutcome>((resolve) => {
        const job: QueueJob = {
          resolve,
          run: async () => {
            let response = await client.upload(upload, idempotencyKey);
            if (!response.ok && isSessionAuthFailure(response.error)) {
              // One renewal and one retry; a second failure keeps the original
              // rejected outcome instead of looping inside a queue worker.
              if (await renewSession()) {
                response = await client.upload(upload, `${idempotencyKey}:renew`);
              }
            }
            if (!response.ok) {
              if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
                process.stderr.write(
                  `evoplug debug ipc upload host_event=${String(hostEvent)} code=${response.error.code} stage=${response.error.stage}\n`
                );
              }
              const mapped = mapIpcErrorToHostAdapterError(response.error, nowMs(hooks));
              hooks.onError?.(mapped);
              return submitOutcome(mapped.retryable ? "degraded" : "rejected", {
                error: mapped,
                redaction_manifest_hash: encoded.value.redaction_manifest_hash
              });
            }
            const value = response.value;
            const accepted = value.state === "ingested" || value.state === "duplicate";
            return submitOutcome(value.state, {
              receipt: value.receipt,
              rejection: value.rejection,
              redaction_manifest_hash: encoded.value.redaction_manifest_hash,
              content_ref: accepted ? hostRuntimeContentRef(encoded.value) : null
            });
          }
        };
        queue.push(job);
        startDrain();
      });
    },
    async pollOnce(
      hookEvent: string | null,
      identityKey: Hash | null,
      waitMs?: number
    ): Promise<HostRuntimePollOutcome> {
      if (closed) {
        return {
          ok: false,
          kind: "shutdown",
          call: null,
          error: localFailure("E_CANCELLED", false, nowMs(hooks), "runtime_closed")
        };
      }
      if (shutdownReceived) {
        return { ok: true, kind: "shutdown", call: null, error: null };
      }
      const configured =
        hooks.poll_wait_max_ms === undefined
          ? session.limits.poll_wait_max_ms
          : Math.min(hooks.poll_wait_max_ms, session.limits.poll_wait_max_ms);
      const requested =
        waitMs === undefined || !Number.isSafeInteger(waitMs) || waitMs < 0
          ? configured
          : waitMs;
      const limit = Math.min(requested, session.limits.poll_wait_max_ms);
      let response = await client.poll(Math.max(0, limit), hookEvent, identityKey);
      if (!response.ok && isSessionAuthFailure(response.error)) {
        if (await renewSession()) {
          response = await client.poll(Math.max(0, limit), hookEvent, identityKey);
        }
      }
      if (!response.ok) {
        const mapped = mapIpcErrorToHostAdapterError(response.error, nowMs(hooks));
        hooks.onError?.(mapped);
        return { ok: false, kind: "none", call: null, error: mapped };
      }
      if (response.value.kind === "shutdown") {
        shutdownReceived = true;
        hooks.onShutdown?.();
        return { ok: true, kind: "shutdown", call: null, error: null };
      }
      const call = response.value.call;
      if (call !== null && hooks.onCall !== undefined) {
        void Promise.resolve(hooks.onCall(call)).catch(() => undefined);
      }
      return { ok: true, kind: response.value.kind, call, error: null };
    },
    async reportResult(
      callId: string,
      result: RuntimeCallResult
    ): Promise<HostRuntimeResultOutcome> {
      if (closed) {
        return {
          ok: false,
          recorded: false,
          error: localFailure("E_CANCELLED", false, nowMs(hooks), "runtime_closed")
        };
      }
      const response = await client.result(
        callId,
        result,
        hostRuntimeIdempotencyKey(config.registration_hash, "result", callId)
      );
      if (!response.ok) {
        const mapped = mapIpcErrorToHostAdapterError(response.error, nowMs(hooks));
        hooks.onError?.(mapped);
        return { ok: false, recorded: false, error: mapped };
      }
      return { ok: true, recorded: response.value.recorded, error: null };
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      shutdownReceived = true;
      client.close();
      const pending = queue.splice(0);
      for (const job of pending) {
        job.resolve(
          submitOutcome("rejected", {
            error: localFailure("E_CANCELLED", false, nowMs(hooks), "runtime_closed")
          })
        );
      }
    }
  };

  return { ok: true, runtime };
}
