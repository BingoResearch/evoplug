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

/**
 * Hook-event name a confirmation channel uses only as its poll key. It is not
 * a host event and never names a committed upload. The kernel arms MCP
 * confirmation calls on this poll so the same poll can claim them
 * (appendix K.2/L.4).
 */
export const MCP_CONFIRM_POLL_EVENT = "evoplug_confirm" as const;

export type RuntimeProbeAction =
  | "read_only"
  | "read_capacity_window"
  | "read_service_profile"
  | "confirm_control_plane"
  | "confirm_human_event"
  | "confirm_human_setup"
  | "confirm_candidate";

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

export interface HostRuntimeReadyRequest {  schema_version: "rsi.host_runtime_ready/1";
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
  /**
   * Appendix L.1: `evaluator` marks a kernel-launched probe; `host_session` is
   * a real user session. The runtime declares it on `ready`; the kernel owns
   * the probe launch and overrides it through the probe isolation environment.
   */
  session_role?: "evaluator" | "host_session";
  /**
   * Appendix M.1: the host session's working directory. The kernel binds a new
   * task to the attach-registered project whose root contains this directory.
   * Optional so an older artifact keeps working without a project binding.
   */
  working_directory?: string | null;
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
  /**
   * Present only for `probe_action="confirm_human_setup"`. The first native
   * confirmation in an interactive session establishes the
   * `human_interaction_attested` capability (closure design §5.2).
   */
  human_setup?: RuntimeHumanSetup;
  /**
   * Present only for `probe_action="confirm_candidate"`. The host runtime
   * shows the adoption summary and returns adopt / reject / later (§5.3).
   */
  candidate_confirmation?: RuntimeCandidateConfirmation;
}

/** Coordinates for the capability-establishing native prompt (§5.2). */
export interface RuntimeHumanSetup {
  readonly capability_id: Id<"cap">;
  readonly challenge_nonce: string;
  readonly native_session_id: string;
  readonly host_version: string;
  readonly title: string;
  readonly message: string;
}

/** Coordinates for one candidate adoption prompt (§5.3). */
export interface RuntimeCandidateConfirmation {
  readonly confirmation_id: string;
  readonly candidate_id: string;
  readonly subject_hash: Hash;
  readonly challenge_nonce: string;
  readonly native_session_id: string;
  readonly object_type: "skill" | "memory" | "instructions";
  readonly target_path: string;
  readonly change_summary: string;
  readonly basis_evidence_refs: readonly string[];
  readonly verification_plan: string;
  /** Appendix Q.5: Chinese display fields; optional for older runtimes. */
  readonly display?: {
    readonly name: string;
    readonly description: string;
    readonly change: string;
    readonly basis: readonly string[];
    readonly content: string;
    readonly preview_path: string;
    readonly show_command: string;
  };
  readonly title: string;
  readonly options: {
    readonly adopt: string;
    readonly reject: string;
    /** Present only when the asking session produced the candidate. */
    readonly incomplete?: string;
  };
}

/** Observation the host runtime reports for setup and candidate prompts. */
export interface RuntimeConfirmationObservation {
  readonly schema_version: "rsi.runtime_confirmation/1";
  readonly action: "human_setup" | "candidate_adoption";
  readonly decision:
    | "confirmed"
    | "not_confirmed"
    | "adopt"
    | "incomplete"
    | "reject"
    | "unsupported"
    | "unknown";
  /** Optional redacted text supplied with "内容不对". */
  readonly reason?: string | null;
  readonly nonce: string;
  readonly native_session_id: string;
  readonly candidate_id: string | null;
  readonly subject_hash: Hash | null;
  readonly decided_at: number | null;
}

/** Parses the runtime's setup/candidate observation. */
export function parseRuntimeConfirmationObservation(
  value: JsonValue
): RuntimeConfirmationObservation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, JsonValue>;
  if (record["schema_version"] !== "rsi.runtime_confirmation/1") return null;
  const action = record["action"];
  if (action !== "human_setup" && action !== "candidate_adoption") return null;
  const decision = record["decision"];
  if (typeof decision !== "string") return null;
  const allowed =
    action === "human_setup"
      ? decision === "confirmed" || decision === "not_confirmed"
      : decision === "adopt" || decision === "incomplete" || decision === "reject";
  if (!allowed && decision !== "unsupported" && decision !== "unknown") return null;
  const nonce = record["nonce"];
  const nativeSessionId = record["native_session_id"];
  const candidateId = record["candidate_id"];
  const subjectHash = record["subject_hash"];
  const decidedAt = record["decided_at"];
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) return null;
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) return null;
  if (!(candidateId === null || typeof candidateId === "string")) return null;
  if (!(subjectHash === null || (typeof subjectHash === "string" && isHash(subjectHash)))) return null;
  const terminal = decision !== "unsupported" && decision !== "unknown";
  if (terminal) {
    if (
      typeof decidedAt !== "number" ||
      !Number.isSafeInteger(decidedAt) ||
      decidedAt < 0 ||
      (action === "candidate_adoption" &&
        (candidateId === null || subjectHash === null))
    ) {
      return null;
    }
  } else if (decidedAt !== null) {
    return null;
  }
  const reasonRaw = record["reason"];
  if (
    reasonRaw !== undefined &&
    reasonRaw !== null &&
    (typeof reasonRaw !== "string" || reasonRaw.length > 500)
  ) {
    return null;
  }
  return {
    schema_version: "rsi.runtime_confirmation/1",
    action,
    decision: decision as RuntimeConfirmationObservation["decision"],
    ...(typeof reasonRaw === "string" ? { reason: reasonRaw } : {}),
    nonce,
    native_session_id: nativeSessionId,
    candidate_id: candidateId,
    subject_hash: subjectHash,
    decided_at: terminal ? (decidedAt as number) : null
  };
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

