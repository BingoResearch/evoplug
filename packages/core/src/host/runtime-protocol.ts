/**
 * Host runtime wire protocol (`host.runtime/1`, DD-HOST-201).
 *
 * The runtime artifact runs inside the host process and talks to the kernel
 * over the local UDS IPC. These types are the request/result shapes of the
 * four runtime methods; the kernel host core owns normalization, identity
 * and every persistent write.
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { JsonValue } from "../json.js";
import type { SourceRef } from "../source-ref.js";
import { isHash } from "../hash.js";
import { isSourceRef } from "../source-ref.js";
import type { IngestReceipt } from "../generated/types/ingest-receipt.js";
import type { HostAdapterError } from "./errors.js";
import type {
  ConfigSpace,
  HostDeliveryRequest,
  HostDeliveryResult,
  HostEventRejection,
  HostId,
  HostMode,
  HostProbeRequest,
  LoadCheckRequest,
  LoadCheckResult,
  RawHostEventUpload
} from "./types.js";

export const HOST_RUNTIME_PROTOCOL_VERSION = "host.runtime/1";

export type RuntimeProbeAction =
  | "read_only"
  | "read_capacity_window"
  | "read_service_profile"
  | "confirm_control_plane"
  | "confirm_human_event";

export interface HostProbeObservation {
  probe_id: Id<"prb">;
  probe_action: RuntimeProbeAction;
  binding_key: Hash;
  observed: JsonValue;
  claimed_evidence_stage?: "none" | "static" | "loaded" | "roundtrip";
  claimed_status?: "unknown" | "verified" | "unsupported" | "failed";
  checked_at: number;
  evidence_refs: SourceRef[];
}

export interface HostRuntimeReadyRequest {
  schema_version: "rsi.host_runtime_ready/1";
  registration_hash: Hash;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  adapter_id: Id<"adp">;
  adapter_version: string;
  implementation_hash: Hash;
  artifact_hash: Hash;
  config_hash: Hash;
  load_verified_hash: Hash;
  host_version: string;
  binary_hash: Hash | null;
  ephemeral: boolean;
  instance_key: string | null;
  pid: number;
  started_at: number;
}

export interface HostRuntimeReadyResult {
  session_id: Id<"rts">;
  session_nonce: string;
  limits: {
    max_payload_bytes: number;
    poll_wait_max_ms: number;
    delivery_max_chars: number;
    lease_ms: number;
  };
}

export interface HostRuntimeUploadRequest {
  schema_version: "rsi.host_runtime_upload/1";
  session_id: Id<"rts">;
  session_nonce: string;
  upload: RawHostEventUpload;
}

export interface HostRuntimeUploadResult {
  state: "ingested" | "duplicate" | "rejected";
  receipt: IngestReceipt | null;
  rejection: HostEventRejection | null;
}

export interface HostRuntimePollRequest {
  schema_version: "rsi.host_runtime_poll/1";
  session_id: Id<"rts">;
  session_nonce: string;
  wait_ms: number;
  hook_event: string | null;
  event_identity_key: Hash | null;
}

export interface RuntimeProbeRequest extends HostProbeRequest {
  probe_action: RuntimeProbeAction;
  probe_mode: "read_only";
  /**
   * Present only for `probe_action="confirm_human_event"`. The host runtime
   * renders a native confirmation and writes `rsi.human_proof_evidence/1`
   * bound to these exact coordinates; it never answers on its own.
   */
  human_confirmation?: RuntimeHumanConfirmation;
}

/**
 * Per-event native confirmation coordinates. `probe_id` (the probe request id)
 * is the call id; these fields are the independent, user-visible challenge.
 */
export interface RuntimeHumanConfirmation {
  readonly capability_id: Id<"cap">;
  readonly confirmation_id: string;
  readonly challenge_nonce: string;
  readonly event_identity_key: Hash;
  readonly native_session_id: string;
  readonly host_version: string;
}

/** Payload the host runtime puts in `observation.observed` for a confirmation. */
export interface RuntimeHumanConfirmationObserved {
  readonly schema_version: "rsi.runtime_human_confirmation/1";
  readonly state: "confirmed" | "not_confirmed" | "unsupported" | "unknown";
  readonly nonce: string;
  readonly event_identity_key: Hash;
  readonly native_session_id: string;
  readonly confirmed_at: number | null;
  readonly evidence_ref: SourceRef | null;
}

/**
 * Parses the host runtime's confirmation observation. A confirmed result must
 * name a retrievable evidence ref; every other state must not claim one.
 */
export function parseRuntimeHumanConfirmationObserved(
  value: JsonValue
): RuntimeHumanConfirmationObserved | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, JsonValue>;
  if (record["schema_version"] !== "rsi.runtime_human_confirmation/1") {
    return null;
  }
  const state = record["state"];
  if (
    state !== "confirmed" &&
    state !== "not_confirmed" &&
    state !== "unsupported" &&
    state !== "unknown"
  ) {
    return null;
  }
  const nonce = record["nonce"];
  const eventKey = record["event_identity_key"];
  const nativeSessionId = record["native_session_id"];
  const confirmedAt = record["confirmed_at"];
  const evidenceRef = record["evidence_ref"];
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) {
    return null;
  }
  if (typeof eventKey !== "string" || !isHash(eventKey)) {
    return null;
  }
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) {
    return null;
  }
  if (state === "confirmed") {
    if (
      typeof confirmedAt !== "number" ||
      !Number.isSafeInteger(confirmedAt) ||
      confirmedAt < 0 ||
      typeof evidenceRef !== "string" ||
      !isSourceRef(evidenceRef)
    ) {
      return null;
    }
    return {
      schema_version: "rsi.runtime_human_confirmation/1",
      state,
      nonce,
      event_identity_key: eventKey,
      native_session_id: nativeSessionId,
      confirmed_at: confirmedAt,
      evidence_ref: evidenceRef
    };
  }
  if (confirmedAt !== null || evidenceRef !== null) {
    return null;
  }
  return {
    schema_version: "rsi.runtime_human_confirmation/1",
    state,
    nonce,
    event_identity_key: eventKey,
    native_session_id: nativeSessionId,
    confirmed_at: null,
    evidence_ref: null
  };
}

export type RuntimeCall =
  | {
      kind: "deliver";
      call_id: string;
      deadline_ms: number;
      request: HostDeliveryRequest;
      content: {
        media_type: "text/plain;charset=utf-8";
        text: string;
        content_hash: Hash;
        byte_length: number;
      };
    }
  | { kind: "check_load"; call_id: string; deadline_ms: number; request: LoadCheckRequest }
  | { kind: "probe"; call_id: string; deadline_ms: number; request: RuntimeProbeRequest };

export interface HostRuntimePollResult {
  kind: "none" | "call" | "shutdown";
  call: RuntimeCall | null;
}

export type RuntimeCallResult =
  | { kind: "deliver"; state: "completed"; result: HostDeliveryResult }
  | { kind: "deliver"; state: "not_injected"; reason: "not_injected" }
  | { kind: "deliver"; state: "blocked"; error: HostAdapterError }
  | { kind: "check_load"; state: "completed"; result: LoadCheckResult }
  | { kind: "probe"; state: "observed"; observation: HostProbeObservation }
  | { kind: "error"; error: HostAdapterError };

export interface HostRuntimeResultRequest {
  schema_version: "rsi.host_runtime_result/1";
  session_id: Id<"rts">;
  session_nonce: string;
  call_id: string;
  result: RuntimeCallResult;
}

export interface HostRuntimeResultResult {
  recorded: true;
}

