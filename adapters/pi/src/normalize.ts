/**
 * Pi `normalizeEvent` (DD-TRG-004, DD-HOST-010).
 *
 * Synchronous and pure: it reads only `raw` scalar fields and the frozen
 * payload view, never the clock, storage, network or host. It does not allocate
 * `normalized_id`, `input_epoch`, task or job, and does not produce
 * `source_seq`, `event_identity_key` or `receipt_seq`.
 *
 * Anything Pi does not serialize is reported as `UnknownFact`:
 * - `input` has no origin field, so `is_auto_turn` is unknown;
 * - no hook exposes background work or queue depth;
 * - `agent_end.willRetry` is absent in some payloads;
 * - retry state is not serialized for boundary events.
 */

import { canonicalHash, compareUtf8, type Hash } from "@evoplug/core";

import { adapterErr, adapterOk } from "./contract.js";
import type {
  ActiveAdapterRegistration,
  AdapterResult,
  CapabilityName,
  EventAttribution,
  EventContract,
  EventCorrelation,
  EventRejection,
  HostAdapterError,
  HostAdapterErrorCode,
  HostEventBindingDraft,
  NativeIds,
  NativeMessageKind,
  NormalizeHostEventInput,
  NormalizedHostEventDraft,
  NormalizedHostEventPayload,
  OriginKind,
  RawHostEvent,
  TriggerKind,
  UnknownFact
} from "./contract.js";
import { isPiConfigSpace, isPiMode, PI_DESCRIPTOR_HASH } from "./descriptor.js";
import { piCanonicalKinds, piEventContract, piAsyncWorkUnknown, piQueueEmptyUnknown, piRetryStateUnknown } from "./events.js";
import { piUnknown, PI_UNKNOWN_REASON } from "./facts.js";
import { PI_ADAPTER_ID, PI_ADAPTER_VERSION, PI_HOST_ID, PI_HOST_VERSION, PI_IMPLEMENTATION_HASH } from "./manifest.js";
import {
  booleanMember,
  readPiPayload,
  safeIntegerMember,
  sortedMemberNames,
  stringMember,
  textMemberRef,
  valueMemberRef,
  type PiPayloadView
} from "./payload.js";

function normalizeError(
  code: HostAdapterErrorCode,
  detailRef: RawHostEvent["payload_ref"],
  observedAt: number,
  capability?: CapabilityName
): HostAdapterError {
  const base: HostAdapterError = {
    code,
    retryable: false,
    detail_ref: detailRef,
    observed_at: observedAt
  };
  return capability === undefined ? base : { ...base, capability };
}

/**
 * Stream identity. The design states only that `stream_id` is computed from
 * host/session/mode/config and does not publish the preimage, so this adapter
 * uses the minimal deterministic form over those four coordinates. Host core
 * may recompute it, but the draft requires a value before finalization.
 */
function streamId(raw: RawHostEvent): Hash {
  return canonicalHash({
    host_id: raw.host_id,
    config_space: raw.config_space,
    mode: raw.mode,
    native_session_id: raw.native_ids.session_id ?? null
  });
}

function buildHostBinding(raw: RawHostEvent, view: PiPayloadView): HostEventBindingDraft {
  const ids: NativeIds = raw.native_ids;
  const sourceSeqHint = safeIntegerMember(view.record, ["seq", "sequence", "source_seq"]);
  const occurrence = stringMember(view.record, ["native_occurrence_id", "occurrence_id"]);
  const retryOf = stringMember(view.record, ["retry_of"]);
  const occurredAt = safeIntegerMember(view.record, ["occurred_at", "timestamp"]);
  return {
    host_id: raw.host_id,
    host_version: PI_HOST_VERSION,
    adapter_id: PI_ADAPTER_ID,
    adapter_version: PI_ADAPTER_VERSION,
    implementation_hash: PI_IMPLEMENTATION_HASH,
    mode: raw.mode,
    config_space: raw.config_space,
    host_event: raw.host_event,
    ...(ids.session_id === undefined ? {} : { native_session_id: ids.session_id }),
    ...(ids.turn_id === undefined ? {} : { native_turn_id: ids.turn_id }),
    ...(ids.message_id === undefined ? {} : { native_message_id: ids.message_id }),
    ...(ids.event_id === undefined ? {} : { native_event_id: ids.event_id }),
    stream_id: streamId(raw),
    ...(sourceSeqHint === null ? {} : { source_seq_hint: sourceSeqHint }),
    ...(occurrence === null ? {} : { native_occurrence_id: occurrence }),
    ...(retryOf === null ? {} : { retry_of: retryOf }),
    ...(occurredAt === null ? {} : { occurred_at: occurredAt }),
    received_at: raw.received_at
  };
}

function sortRejections(rejections: readonly EventRejection[]): readonly EventRejection[] {
  return [...rejections].sort((left, right) => {
    if (left.fatal !== right.fatal) {
      return left.fatal ? -1 : 1;
    }
    const byField = compareUtf8(left.field, right.field);
    return byField === 0 ? compareUtf8(left.code, right.code) : byField;
  });
}

function attribution(view: PiPayloadView, typedUserMessage = false): EventAttribution {
  const names =
    view.record === null ? Object.freeze(["text"]) : sortedMemberNames(view.record);
  return {
    sender: "unknown",
    typed_user_message: typedUserMessage,
    typed_field_names: names
  };
}

function rejection(
  code: EventRejection["code"],
  field: string,
  detailRef: RawHostEvent["payload_ref"],
  fatal: boolean
): EventRejection {
  return { code, field, detail_ref: detailRef, fatal };
}

function observationPayload(view: PiPayloadView, nativeType: string): NormalizedHostEventPayload {
  return { kind: "host.unclassified", native_type: nativeType, content_ref: view.canonicalRef, reason_code: "no_mapping" };
}

function boundaryPayload(
  raw: RawHostEvent,
  boundary: "stop" | "agent_end" | "session_end" | "error",
  retryPending: boolean | UnknownFact
): NormalizedHostEventPayload {
  return {
    kind: "host.boundary",
    boundary,
    host_stable_event: raw.host_event,
    retry_pending: retryPending,
    async_work: piAsyncWorkUnknown(),
    queue_empty: piQueueEmptyUnknown(),
    background_refs: []
  };
}

/**
 * Pi's compaction payloads carry a reason/type label but no structured reason
 * enum; anything that is not explicitly `auto` or `manual` is recorded as a
 * host summary rather than guessed.
 */
function compactionKind(view: PiPayloadView): "auto" | "manual" | "host_summary" {
  const value = stringMember(view.record, ["compaction_kind", "reason", "trigger", "type"]);
  if (value === "auto") {
    return "auto";
  }
  if (value === "manual") {
    return "manual";
  }
  return "host_summary";
}

function toolCallId(raw: RawHostEvent, view: PiPayloadView): string | null {
  if (raw.native_ids.tool_call_id !== undefined) {
    return raw.native_ids.tool_call_id;
  }
  return stringMember(view.record, ["tool_call_id", "toolCallId", "call_id"]);
}

function toolResultStatus(view: PiPayloadView): "ok" | "error" | "unknown" {
  const status = stringMember(view.record, ["status"]);
  if (status === "ok" || status === "error") {
    return status;
  }
  const isError = booleanMember(view.record, ["isError", "is_error"]);
  if (isError === true) {
    return "error";
  }
  if (isError === false) {
    return "ok";
  }
  return "unknown";
}

interface DraftParts {
  readonly nativeKind: NativeMessageKind;
  readonly kindCandidates: readonly TriggerKind[];
  readonly payload: NormalizedHostEventPayload;
  readonly originHint: OriginKind;
  readonly rejections: readonly EventRejection[];
  readonly inputSourceLabel?: string;
  readonly typedUserMessage?: boolean;
  readonly correlation?: EventCorrelation;
}

function makeDraft(
  raw: RawHostEvent,
  view: PiPayloadView,
  contract: EventContract,
  parts: DraftParts
): NormalizedHostEventDraft {
  return {
    schema_version: "rsi.normalized_host_event/1",
    host_binding: buildHostBinding(raw, view),
    native_kind: parts.nativeKind,
    kind_candidates: parts.kindCandidates,
    correlation: parts.correlation ?? {},
    origin_hint: parts.originHint,
    ...(parts.inputSourceLabel === undefined ? {} : { input_source_label: parts.inputSourceLabel }),
    is_auto_turn: piUnknown(PI_UNKNOWN_REASON.inputOriginAbsent),
    payload: parts.payload,
    attribution: attribution(view, parts.typedUserMessage === true),
    required_capabilities: contract.required_capabilities,
    rejections: sortRejections(parts.rejections)
  };
}

function inputParts(raw: RawHostEvent, view: PiPayloadView): DraftParts {
  const retryOf = stringMember(view.record, ["retry_of"]);
  if (retryOf !== null) {
    return {
      nativeKind: "prompt",
      kindCandidates: piCanonicalKinds(raw.host_event),
      payload: { kind: "input.retry", retry_of_native_event_id: retryOf, reason_code: "host_retry" },
      originHint: "unknown",
      rejections: []
    };
  }
  const plainText = view.mediaType === "text/plain;charset=utf-8" ? view.decodedText : null;
  const text = stringMember(view.record, ["text", "prompt", "message"]) ?? plainText;
  const textRef = textMemberRef(view, ["text", "prompt", "message"], text);
  const source = stringMember(view.record, ["source"]);
  const directive = stringMember(view.record, ["directive_strength"]);
  const parentNativeId = stringMember(view.record, ["parent_native_id"]);
  const rejections: EventRejection[] = [];
  if (text === null) {
    rejections.push(rejection("E_FIELD_MISSING", "text", raw.payload_ref, true));
  }
  return {
    nativeKind: "prompt",
    kindCandidates: piCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: directive === "explicit" ? "explicit" : "ambiguous",
      ...(parentNativeId === null ? {} : { parent_native_id: parentNativeId })
    },
    originHint: "unknown",
    rejections,
    // Pi 1.2+ reports `source: "interactive"` only for input typed into its own
    // TUI; extension-injected (`extension`) and API (`rpc`) turns differ. That
    // host-native field is the trusted source design §6.1 names, so it marks
    // the input as typed. Print/json input has no such source and stays unknown.
    ...(source === null ? {} : { inputSourceLabel: source }),
    ...(source === "interactive" ? { typedUserMessage: true } : {})
  };
}

function toolCallParts(raw: RawHostEvent, view: PiPayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  const toolName = stringMember(view.record, ["tool_name", "toolName", "name"]);
  if (callId === null || toolName === null) {
    // A tool payload that cannot form `tool.call` is a precondition failure:
    // a draft whose payload kind and kind_candidates disagree would be rejected
    // by finalize before any fatal rejection is recorded.
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  const parent = raw.native_ids.parent_tool_call_id;
  return adapterOk({
    nativeKind: "event",
    kindCandidates: piCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.call",
      tool_call_id: callId,
      ...(parent === undefined ? {} : { parent_tool_call_id: parent }),
      tool_name: toolName,
      arguments_ref: valueMemberRef(view, ["arguments", "args", "input"])
    },
    originHint: "host_auto",
    rejections: [],
    correlation: parent === undefined ? {} : { parent_call_id: parent }
  });
}

function toolResultParts(raw: RawHostEvent, view: PiPayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  if (callId === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  return adapterOk({
    nativeKind: "event",
    kindCandidates: piCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.result",
      tool_call_id: callId,
      status: toolResultStatus(view),
      text_ref: textMemberRef(view, ["text", "result", "output", "content"])
    },
    originHint: "host_auto",
    rejections: []
  });
}

function agentEndParts(raw: RawHostEvent, view: PiPayloadView): DraftParts {
  const willRetry = booleanMember(view.record, ["willRetry", "will_retry"]);
  const retryPending = willRetry === null ? piUnknown(PI_UNKNOWN_REASON.agentEndWillRetryAbsent) : willRetry;
  const hasError = view.record !== null && view.record["error"] !== undefined && view.record["error"] !== null;
  return {
    nativeKind: "event",
    // The contract kind is fixed; `retry_pending` carries the willRetry value so
    // the trigger policy can refuse a retrying turn without a second event.
    kindCandidates: piCanonicalKinds(raw.host_event),
    payload: boundaryPayload(raw, hasError ? "error" : "agent_end", retryPending),
    originHint: "host_auto",
    rejections: []
  };
}

function draftFor(raw: RawHostEvent, view: PiPayloadView, contract: EventContract): AdapterResult<NormalizedHostEventDraft> {
  switch (raw.host_event) {
    case "input":
      return adapterOk(makeDraft(raw, view, contract, inputParts(raw, view)));
    case "before_agent_start":
      // Pi starts a turn here; the boundary payload's closed set has no
      // "turn_start" member, so the prior stop is recorded as the boundary and
      // the host event name keeps the distinction.
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: piCanonicalKinds(raw.host_event),
          payload: boundaryPayload(raw, "stop", piRetryStateUnknown()),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "tool_call": {
      const parts = toolCallParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "tool_result": {
      const parts = toolResultParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "session_compact":
    case "session_compact_failed":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: piCanonicalKinds(raw.host_event),
          payload: { kind: "compaction.observed", compaction_kind: compactionKind(view) },
          originHint: "host_auto",
          rejections: []
        })
      );
    case "agent_end":
      return adapterOk(makeDraft(raw, view, contract, agentEndParts(raw, view)));
    case "agent_settled":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: piCanonicalKinds(raw.host_event),
          payload: boundaryPayload(raw, "stop", piRetryStateUnknown()),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "session_shutdown":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: piCanonicalKinds(raw.host_event),
          payload: boundaryPayload(raw, "session_end", piRetryStateUnknown()),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "context":
    case "before_provider_request":
    case "session_start":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: [],
          payload: observationPayload(view, raw.host_event),
          originHint: "host_auto",
          rejections: []
        })
      );
    default:
      return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
}

function registrationMatches(raw: RawHostEvent): boolean {
  const registration: ActiveAdapterRegistration = raw.registration;
  return (
    registration.adapter_id === PI_ADAPTER_ID &&
    registration.host_id === PI_HOST_ID &&
    registration.adapter_version === PI_ADAPTER_VERSION &&
    registration.implementation_hash === PI_IMPLEMENTATION_HASH &&
    registration.descriptor_hash === PI_DESCRIPTOR_HASH &&
    registration.mode === raw.mode &&
    registration.config_space === raw.config_space
  );
}

/**
 * Normalizes one Pi host event. Precondition failures return `Err`; missing
 * payload fields return a draft with fatal `rejections` so host core records a
 * `HostEventRejection` instead of ingesting a partial event.
 */
export function normalizePiEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
  const raw = input.raw;
  const observedAt = raw.received_at;
  if (input.schema_version !== "rsi.normalize_host_event_input/1") {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  if (raw.host_id !== PI_HOST_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (raw.adapter_id !== PI_ADAPTER_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (!isPiMode(raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!isPiConfigSpace(raw.config_space)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!registrationMatches(raw)) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (input.payload.payload_hash !== raw.payload_hash) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (input.payload.canonical_ref !== raw.payload_ref) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  const contract = piEventContract(raw.host_event);
  if (contract === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  const view = readPiPayload(input.payload);
  if (view === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  return draftFor(raw, view, contract);
}
