/**
 * Structural mirror of the HOST-owned adapter boundary (DD-HOST-001,
 * DD-TRG-004, DD-CAP-002, DD-CAP-004).
 *
 * The authoritative declarations live in `packages/core/src/host/*` and the
 * generated host vocabulary. An adapter package may only depend on
 * `@evoplug/core` and `@evoplug/ipc` (DD-FND-021), and the HOST package does
 * not yet export these names from the core root, so this file restates the
 * frozen wire shapes verbatim. It contains no behaviour and no second schema:
 * field names, closed sets and optionality are copied from the design.
 *
 * When host core publishes its public surface, this module is replaced by
 * type-only imports from `@evoplug/core`; adapters must not diverge from it.
 */

import type { Hash, Id, JsonValue, SourceRef } from "@evoplug/core";

/* ------------------------------------------------------------------ */
/* Generated host vocabulary (DD-CAP-001, packages/core/src/generated) */
/* ------------------------------------------------------------------ */

export type HostId =
  | "pi"
  | "oh-my-pi"
  | "step-code"
  | "codex"
  | "opencode"
  | "openhands-sdk"
  | "claude-code";

export type HostMode =
  | "interactive"
  | "print"
  | "rpc"
  | "acp"
  | "sdk"
  | "sdk_stdio"
  | "exec"
  | "app-server"
  | "server"
  | "local_conversation"
  | "remote_conversation";

export type CapabilityStatus = "unknown" | "verified" | "unsupported" | "failed";

export type EvidenceStage = "none" | "static" | "loaded" | "roundtrip";

export type HostProbeResult = "passed" | "failed" | "blocked" | "unknown";

export type CapabilitySubject = "host_contract" | "product_adapter";

export type HostVersionKind = "release" | "source_commit" | "binary_hash";

export interface UnknownFact {
  readonly kind: "unknown";
  readonly reason_code: string;
}

/* ---------------------------------------------------------- */
/* Host trigger vocabulary (DD-TRG-004, DD-CAP-003)           */
/* ---------------------------------------------------------- */

export type NativeMessageKind = "message" | "turn" | "event" | "prompt" | "other";

export type TriggerKind =
  | "new_input"
  | "tool_fact"
  | "compaction"
  | "task_boundary_candidate"
  | "task_stable"
  | "session_end"
  | "user_review_request"
  | "experience_trigger"
  | "config_signal";

export type OriginKind = "human" | "host_auto" | "evaluator" | "evaluator_descendant" | "unknown";

export type CapabilityName =
  | "input_capture"
  | "sync_wait"
  | "source_trust"
  | "tool_id"
  | "compaction_event"
  | "request_observation"
  | "managed_object_load"
  | "online_delivery"
  | "stable_boundary"
  | "host_budget"
  | "association"
  | "human_interaction_attested"
  | "capacity_window"
  | "generation.service_profile"
  | "generation.create"
  | "generation.auth"
  | "generation.cancel"
  | "generation.recover"
  | "generation.output";

export type InclusionLevel =
  | "none"
  | "constructive"
  | "context_projection"
  | "provider_payload"
  | "transport_body"
  | "unknown";

export type ConfigSpace = string;

/* ---------------------------------------------------------- */
/* Capability binding (DD-CAP-002)                            */
/* ---------------------------------------------------------- */

export interface SourcePin {
  readonly host_version: string;
  readonly host_version_kind: HostVersionKind;
  readonly source_commit: string | null;
}

export interface BinaryPin {
  readonly binary_version: string | null;
  readonly binary_hash: Hash | null;
}

export interface ExecutionEnvironment {
  readonly os: string;
  readonly arch: string;
  readonly isolation: "local" | "container" | "remote";
}

export interface CapabilityBinding {
  readonly host_id: HostId;
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly adapter_version: string;
  readonly subject: CapabilitySubject;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly root_id: string;
  readonly construction_path: string;
  readonly execution_environment: ExecutionEnvironment;
  readonly mapping: "exact" | "partial" | "unmapped";
  readonly backend_id?: string;
}

/* ---------------------------------------------------------- */
/* HostAdapter error envelope (DD-HOST-001)                   */
/* ---------------------------------------------------------- */

export type HostAdapterErrorCode =
  | "E_DEADLINE_EXCEEDED"
  | "E_CAPABILITY"
  | "E_UNSUPPORTED"
  | "E_CONFLICT"
  | "E_HOST_REJECTED"
  | "E_AUTH_UNAVAILABLE"
  | "E_EVIDENCE_UNKNOWN"
  | "E_SCHEMA"
  | "E_IO"
  | "E_CANCELLED"
  | "E_INTERNAL";

export interface HostAdapterError {
  readonly code: HostAdapterErrorCode;
  readonly retryable: boolean;
  readonly capability?: CapabilityName;
  readonly detail_ref: SourceRef;
  readonly observed_at: number;
}

/* ---------------------------------------------------------- */
/* Adapter descriptor and registration (DD-HOST-001)          */
/* ---------------------------------------------------------- */

export type LoadBoundary = "next_request" | "reload" | "new_session" | "restart" | "unknown";

export interface RegistrationTarget {
  readonly target_id: string;
  readonly config_space: ConfigSpace;
  readonly scope: "user" | "project" | "managed";
  readonly kind: "extension" | "plugin" | "hook_config" | "sdk_package";
  readonly load_boundary: LoadBoundary;
  readonly marker_id: string | null;
}

export interface EventContract {
  readonly host_event: string;
  readonly native_kind: NativeMessageKind;
  readonly canonical_kinds: readonly TriggerKind[];
  readonly required_capabilities: readonly CapabilityName[];
}

export interface AdapterDescriptor {
  readonly schema_version: "rsi.adapter_descriptor/1";
  readonly adapter_id: Id<"adp">;
  readonly host_id: HostId;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly supported_modes: readonly HostMode[];
  readonly config_spaces: readonly ConfigSpace[];
  readonly registration_targets: readonly RegistrationTarget[];
  readonly event_contracts: readonly EventContract[];
  readonly declared_capabilities: readonly CapabilityName[];
}

export interface RegistrationRequest {
  readonly schema_version: "rsi.registration_request/1";
  readonly request_id: string;
  readonly registration_hash: Hash;
  readonly host_id: HostId;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly target_id: string;
  readonly dry_run: boolean;
  readonly artifact_ref: SourceRef;
  readonly artifact_hash: Hash;
  readonly expected_previous_hash: Hash | null;
  readonly approval: { readonly approval_id: Id<"iap">; readonly approval_hash: Hash } | null;
  readonly deadline_ms: number;
}

export type RegistrationConflictCode =
  | "E_ADAPTER_NOT_DECLARED"
  | "E_CONFIG_SPACE_NOT_DECLARED"
  | "E_TARGET_NOT_DECLARED"
  | "E_ADAPTER_MISMATCH"
  | "E_ACTIVE_BINDING_MISMATCH"
  | "E_ARTIFACT_MISMATCH"
  | "E_MARKER_MISMATCH"
  | "E_APPROVAL_NOT_FOUND"
  | "E_APPROVAL_SUBJECT_MISMATCH"
  | "E_APPROVAL_STATE"
  | "E_APPROVAL_EXPIRED"
  | "E_APPROVAL_HASH"
  | "E_APPROVAL_CONSUMED";

export interface RegistrationConflict {
  readonly code: RegistrationConflictCode;
  readonly detail_ref: SourceRef;
}

export interface RegistrationResult {
  readonly request_id: string;
  readonly registration_hash: Hash;
  readonly status: "planned" | "applied" | "no_change" | "conflict" | "rejected" | "failed" | "unknown";
  readonly diff_ref?: SourceRef;
  readonly written_hash?: Hash;
  readonly load_boundary: LoadBoundary;
  readonly requires_trust: boolean;
  readonly trust_state: "ready" | "pending" | "unknown";
  readonly conflicts: readonly RegistrationConflict[];
  readonly approval_ref: Id<"iap"> | null;
  readonly approval_consumption_ref: SourceRef | null;
  readonly evidence_refs: readonly SourceRef[];
  readonly completed_at: number;
}

/* ---------------------------------------------------------- */
/* Probe, confirmation, pending, delivery, load (DD-HOST-001) */
/* ---------------------------------------------------------- */

export interface HostEventBindingDraft {
  readonly host_id: HostId;
  readonly host_version: string;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly host_event: string;
  readonly native_session_id?: string;
  readonly native_turn_id?: string;
  readonly native_message_id?: string;
  readonly native_event_id?: string;
  readonly stream_id: Hash;
  readonly source_seq_hint?: number;
  readonly native_occurrence_id?: string;
  readonly retry_of?: string;
  readonly occurred_at?: number;
  readonly received_at: number;
}

export interface HostProbeRequest {
  readonly probe_id: Id<"prb">;
  readonly probe_contract_version: "host-probe/2";
  readonly binding: CapabilityBinding;
  readonly host_binding: HostEventBindingDraft;
  readonly capabilities: readonly CapabilityName[];
  readonly probe_mode: "read_only" | "temp_fixture";
  readonly fixture_ref?: SourceRef;
  readonly deadline_ms: number;
}

export interface ProbeAssertion {
  readonly assertion_id: string;
  readonly capability: CapabilityName;
  readonly expected: string;
  readonly observed_ref: SourceRef;
  readonly pass: boolean | "unknown";
  readonly failure_code?: string;
}

export interface ProbeCapabilityResult {
  readonly name: CapabilityName;
  readonly proposed_status: CapabilityStatus;
  readonly evidence_stage: EvidenceStage;
  readonly evidence_refs: readonly string[];
  readonly proposed_details_ref?: SourceRef;
  readonly failure_code?: string;
}

export interface HostProbeBlocker {
  readonly kind:
    | "credentials_unavailable"
    | "region_blocked"
    | "provider_unavailable"
    | "host_not_installed"
    | "version_unmapped"
    | "permission_denied"
    | "fixture_unavailable"
    | "deadline_exceeded"
    | "operator_aborted"
    | "unknown_environment";
  readonly code: string;
  readonly detail_ref: SourceRef;
  readonly retry_allowed: boolean;
}

export interface HostProbeRecord {
  readonly schema_version: "rsi.host_probe/2";
  readonly probe_id: Id<"prb">;
  readonly probe_contract_version: "host-probe/2";
  readonly target_kind: "host" | "jev_api" | "filesystem";
  readonly binding: CapabilityBinding;
  readonly binding_key: Hash;
  readonly probe_mode: "read_only" | "temp_fixture";
  readonly fixture_ref?: SourceRef;
  readonly probe_action: string;
  readonly assertions: readonly ProbeAssertion[];
  readonly capability_results: readonly ProbeCapabilityResult[];
  readonly result: HostProbeResult;
  readonly blocker?: HostProbeBlocker;
  readonly expected: string;
  readonly observed: string;
  readonly evidence_refs: readonly string[];
  readonly duration_ms: number;
  readonly checked_at: number;
}

export interface HostHumanConfirmationRequest {
  readonly schema_version: "rsi.host_human_confirmation_request/1";
  readonly request_id: string;
  readonly confirmation_id: string;
  readonly probe_id: Id<"prb">;
  readonly binding: CapabilityBinding;
  readonly host_binding: HostEventBindingDraft;
  readonly event_identity_key: Hash;
  readonly challenge_nonce: string;
  readonly native_session_id: string;
  readonly deadline_ms: number;
}

export interface HostHumanConfirmationResult {
  readonly state: "confirmed" | "not_confirmed" | "unsupported" | "unknown";
  readonly evidence_ref?: SourceRef;
  readonly confirmed_at?: number;
}

export interface PendingInspectRequest {
  readonly request_id: string;
  readonly host_binding: HostEventBindingDraft;
  readonly boundary_event_ref: SourceRef;
  readonly deadline_ms: number;
}

export interface PendingSignal {
  readonly field: string;
  readonly state: "none" | "present" | "unknown";
  readonly ref?: SourceRef;
}

export interface PendingInspectResult {
  readonly request_id: string;
  readonly state: "none" | "pending" | "unknown";
  readonly signals: readonly PendingSignal[];
  readonly fields_observed: readonly string[];
  readonly fields_unknown: readonly string[];
  readonly evidence_refs: readonly string[];
}

export interface HostDeliveryRequest {
  readonly delivery_id: string;
  readonly trigger_event_id?: Id<"trg">;
  readonly host_binding: HostEventBindingDraft;
  readonly boundary_event_ref: SourceRef;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly content_ref: SourceRef;
  readonly content_hash: Hash;
  readonly nonce: string;
  readonly max_chars: number;
  readonly wait_mode: "bounded" | "strict";
  readonly idempotency_key: string;
  readonly deadline_ms: number;
}

export interface HostDeliveryResult {
  readonly delivery_id: string;
  readonly submitted: "true" | "false" | "unknown";
  readonly host_ack_ref?: SourceRef;
  readonly inclusion: { readonly level: InclusionLevel; readonly evidence_ref?: SourceRef };
  readonly degraded: boolean;
  readonly error?: HostAdapterError;
  readonly completed_at: number;
}

export interface LoadCheckRequest {
  readonly request_id: string;
  readonly object_ref: string;
  readonly expected_hash: Hash;
  readonly target_session_ref: string;
  readonly load_boundary: LoadBoundary;
  readonly deadline_ms: number;
}

export interface LoadCheckResult {
  readonly request_id: string;
  readonly state: "loaded" | "pending" | "not_loaded" | "unknown" | "conflict";
  readonly observed_hash?: Hash;
  readonly evidence_refs: readonly string[];
  readonly readback_ref?: SourceRef;
}

/* ---------------------------------------------------------- */
/* Normalized event draft (DD-TRG-004)                        */
/* ---------------------------------------------------------- */

export interface NativeIds {
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly message_id?: string;
  readonly event_id?: string;
  readonly tool_call_id?: string;
  readonly parent_tool_call_id?: string;
  readonly injection_message_id?: string;
  readonly persisted_message_id?: string;
}

export interface ResolvedHostPayload {
  readonly schema_version: "rsi.resolved_host_payload/1";
  readonly canonical_ref: SourceRef;
  readonly content_version: Hash;
  readonly payload_hash: Hash;
  readonly media_type: "text/plain;charset=utf-8" | "application/json" | "application/octet-stream";
  readonly encoding: "utf8" | "base64";
  readonly byte_length: number;
  readonly bytes: Readonly<Uint8Array>;
  readonly decoded_text?: string;
  readonly json_value?: JsonValue;
  readonly resolved_at: number;
}

export interface ActiveAdapterRegistration {
  readonly schema_version: "rsi.active_adapter_registration/1";
  readonly registration_hash: Hash;
  readonly adapter_id: Id<"adp">;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly descriptor_hash: Hash;
  readonly config_spaces: readonly ConfigSpace[];
  readonly event_contracts: readonly EventContract[];
  readonly applied_at: number;
}

export interface RawHostEvent {
  readonly raw_event_id: string;
  readonly adapter_id: Id<"adp">;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly host_event: string;
  readonly received_at: number;
  readonly payload_ref: SourceRef;
  readonly payload_hash: Hash;
  readonly native_ids: NativeIds;
  readonly adapter_context_ref?: string;
  readonly registration: ActiveAdapterRegistration;
}

export interface NormalizeHostEventInput {
  readonly schema_version: "rsi.normalize_host_event_input/1";
  readonly raw: RawHostEvent;
  readonly payload: ResolvedHostPayload;
}

export type NormalizedHostEventPayload =
  | {
      readonly kind: "input.received";
      readonly text_ref: SourceRef;
      readonly directive_strength: "explicit" | "ambiguous";
      readonly parent_native_id?: string;
    }
  | {
      readonly kind: "input.retry";
      readonly retry_of_native_event_id: string;
      readonly reason_code: "host_retry" | "transport_retry";
    }
  | { readonly kind: "agent.message"; readonly text_ref: SourceRef; readonly phase: "assistant" | "tool_preface" | "final" }
  | {
      readonly kind: "tool.call";
      readonly tool_call_id: string;
      readonly parent_tool_call_id?: string;
      readonly tool_name: string;
      readonly arguments_ref: SourceRef;
    }
  | {
      readonly kind: "tool.result";
      readonly tool_call_id: string;
      readonly status: "ok" | "error" | "unknown";
      readonly text_ref: SourceRef;
    }
  | {
      readonly kind: "host.boundary";
      readonly boundary: "stop" | "agent_end" | "session_end" | "error";
      readonly host_stable_event: string;
      readonly retry_pending: boolean | UnknownFact;
      readonly async_work: boolean | UnknownFact;
      readonly queue_empty: boolean | UnknownFact;
      readonly background_refs: readonly string[];
      readonly exit_budget_ms?: number;
    }
  | {
      readonly kind: "compaction.observed";
      readonly compaction_kind: "auto" | "manual" | "host_summary";
      readonly checkpoint_ref?: SourceRef;
      readonly omitted_range?: { readonly from_watermark: number; readonly to_watermark: number };
    }
  | {
      readonly kind: "subagent.started";
      readonly native_agent_id: string;
      readonly relation: "child" | "sibling";
      readonly parent_native_event_id?: string;
    }
  | {
      readonly kind: "subagent.ended";
      readonly native_agent_id: string;
      readonly status: "ok" | "error" | "unknown";
      readonly summary_ref?: SourceRef;
    }
  | {
      readonly kind: "delivery.receipt";
      readonly delivery_id: Id<"del">;
      readonly axis: "transport" | "inclusion" | "adoption";
      readonly evidence_kind:
        | "hook_return_accepted"
        | "context_projection_seen"
        | "provider_payload_captured"
        | "transport_body_captured"
        | "host_confirmed"
        | "behavior_observed"
        | "independent_verifier";
      readonly evidence_ref?: SourceRef;
      readonly observed_at: number;
    }
  | {
      readonly kind: "feedback.observed";
      readonly feedback_kind: "correction" | "dissatisfaction" | "new_goal" | "acceptance";
      readonly text_ref: SourceRef;
      readonly target_issue_id?: Id<"issue">;
    }
  | {
      readonly kind: "host.unclassified";
      readonly native_type: string;
      readonly content_ref: SourceRef;
      readonly reason_code: "no_mapping" | "unsupported_version";
    };

export interface EventCorrelation {
  readonly parent_call_id?: string;
  readonly correlation_id?: string;
  readonly task_hint?: string;
  readonly branch_hint?: string;
}

export interface EventAttribution {
  readonly sender: "human" | "agent" | "tool" | "system" | "unknown";
  readonly typed_user_message: boolean;
  readonly typed_field_names: readonly string[];
}

export interface EventRejection {
  readonly code: "E_FIELD_MISSING" | "E_ENUM_UNKNOWN" | "E_IDENTITY_MISSING" | "E_ORIGIN_UNRESOLVED" | "E_VERSION_UNMAPPED";
  readonly field: string;
  readonly detail_ref: string;
  readonly fatal: boolean;
}

export interface NormalizedHostEventDraft {
  readonly schema_version: "rsi.normalized_host_event/1";
  readonly host_binding: HostEventBindingDraft;
  readonly native_kind: NativeMessageKind;
  readonly kind_candidates: readonly TriggerKind[];
  readonly correlation: EventCorrelation;
  readonly origin_hint: OriginKind;
  readonly input_source_label?: string;
  readonly is_auto_turn: boolean | UnknownFact;
  readonly payload: NormalizedHostEventPayload;
  readonly attribution: EventAttribution;
  readonly required_capabilities: readonly CapabilityName[];
  readonly rejections: readonly EventRejection[];
}

/* ---------------------------------------------------------- */
/* The port itself (DD-HOST-001)                              */
/* ---------------------------------------------------------- */

/**
 * Adapter-call result.
 *
 * The design types adapter calls as `Result<T,HostAdapterError>`, while the
 * FND `Result` from `@evoplug/core` constrains its error slot to
 * `ErrorEnvelope`. `HostAdapterError` is a separate closed union
 * (DD-HOST-001), so this boundary uses the same success/failure axis with the
 * adapter error slot. The shape is identical to the shared `Result` and is
 * never used inside a domain package.
 */
export type AdapterSuccessStatus = "ok" | "no_op";

export type AdapterFailureStatus = "degraded" | "rejected" | "conflict" | "pending" | "unknown";

export type AdapterResult<T> =
  | { readonly ok: true; readonly status: AdapterSuccessStatus; readonly value: T }
  | { readonly ok: false; readonly status: AdapterFailureStatus; readonly error: HostAdapterError };

/** Success constructor for the adapter boundary. */
export function adapterOk<T>(value: T, status: AdapterSuccessStatus = "ok"): AdapterResult<T> {
  return { ok: true, status, value };
}

/** Failure constructor for the adapter boundary. */
export function adapterErr<T = never>(
  error: HostAdapterError,
  status: AdapterFailureStatus = "rejected"
): AdapterResult<T> {
  return { ok: false, status, error };
}

export interface HostAdapter {
  describe(): AdapterDescriptor;
  register(req: RegistrationRequest, signal: AbortSignal): Promise<AdapterResult<RegistrationResult>>;
  probe(req: HostProbeRequest, signal: AbortSignal): Promise<AdapterResult<HostProbeRecord>>;
  normalizeEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft>;
  confirmHuman?(
    req: HostHumanConfirmationRequest,
    signal: AbortSignal
  ): Promise<AdapterResult<HostHumanConfirmationResult>>;
  inspectPending(req: PendingInspectRequest, signal?: AbortSignal): Promise<AdapterResult<PendingInspectResult>>;
  deliver(req: HostDeliveryRequest, signal: AbortSignal): Promise<AdapterResult<HostDeliveryResult>>;
  checkLoad(req: LoadCheckRequest, signal: AbortSignal): Promise<AdapterResult<LoadCheckResult>>;
}
