/**
 * OpenHands `normalizeEvent` (DD-TRG-004, DD-HOST-060, DD-HOST-100).
 *
 * Synchronous and pure: it reads only `raw` scalar fields and the frozen
 * payload view, never the clock, storage, network or host. It does not allocate
 * `normalized_id`, `input_epoch`, task or job, and does not produce
 * `source_seq`, `event_identity_key` or `receipt_seq`.
 *
 * Anything OpenHands does not serialize is reported as `UnknownFact`:
 * - `UserPromptSubmit` carries no origin field, so `is_auto_turn` is unknown;
 * - no hook exposes background work or queue depth;
 * - retry state is not serialized for boundary events;
 * - `message_id` identifies the unpersisted E0 event, so no join is attempted.
 *
 * `Stop` is only emitted by the host for `FINISHED`; the adapter does not
 * re-derive that condition and never treats a missing `Stop` as proof that no
 * pending work exists.
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
import { isOpenhandsConfigSpace, isOpenhandsMode, OPENHANDS_DESCRIPTOR_HASH } from "./descriptor.js";
import {
  openhandsAsyncWorkUnknown,
  openhandsAutoTurnUnknown,
  openhandsCanonicalKinds,
  openhandsEventContract,
  openhandsInputOriginUnknown,
  openhandsQueueEmptyUnknown,
  openhandsRetryStateUnknown
} from "./events.js";
import {
  OPENHANDS_ADAPTER_ID,
  OPENHANDS_ADAPTER_VERSION,
  OPENHANDS_HOST_ID,
  OPENHANDS_HOST_VERSION,
  OPENHANDS_IMPLEMENTATION_HASH
} from "./manifest.js";
import {
  booleanMember,
  objectMember,
  readOpenhandsPayload,
  safeIntegerMember,
  sortedMemberNames,
  stringMember,
  textMemberRef,
  valueMemberRef,
  type OpenhandsPayloadView
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

function buildHostBinding(raw: RawHostEvent, view: OpenhandsPayloadView): HostEventBindingDraft {
  const ids: NativeIds = raw.native_ids;
  const sourceSeqHint = safeIntegerMember(view.record, ["seq", "sequence", "source_seq"]);
  const occurrence = stringMember(view.record, ["native_occurrence_id", "occurrence_id"]);
  const retryOf = stringMember(view.record, ["retry_of"]);
  const occurredAt = safeIntegerMember(view.record, ["occurred_at", "timestamp"]);
  return {
    host_id: raw.host_id,
    host_version: OPENHANDS_HOST_VERSION,
    adapter_id: OPENHANDS_ADAPTER_ID,
    adapter_version: OPENHANDS_ADAPTER_VERSION,
    implementation_hash: OPENHANDS_IMPLEMENTATION_HASH,
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

function attribution(
  view: OpenhandsPayloadView,
  sender: EventAttribution["sender"],
  typedUserMessage: boolean
): EventAttribution {
  const names = view.record === null ? Object.freeze(["text"]) : sortedMemberNames(view.record);
  return {
    sender,
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

function observationPayload(view: OpenhandsPayloadView, nativeType: string): NormalizedHostEventPayload {
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
    async_work: openhandsAsyncWorkUnknown(),
    queue_empty: openhandsQueueEmptyUnknown(),
    background_refs: []
  };
}

function toolCallId(raw: RawHostEvent, view: OpenhandsPayloadView): string | null {
  if (raw.native_ids.tool_call_id !== undefined) {
    return raw.native_ids.tool_call_id;
  }
  return stringMember(view.record, ["action_id", "tool_call_id", "toolCallId", "call_id"]);
}

function toolResultStatus(view: OpenhandsPayloadView): "ok" | "error" | "unknown" {
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
  readonly correlation?: EventCorrelation;
  readonly sender: EventAttribution["sender"];
  readonly typedUserMessage: boolean;
}

function makeDraft(
  raw: RawHostEvent,
  view: OpenhandsPayloadView,
  contract: EventContract,
  parts: DraftParts,
  isAutoTurn: boolean | UnknownFact
): NormalizedHostEventDraft {
  return {
    schema_version: "rsi.normalized_host_event/1",
    host_binding: buildHostBinding(raw, view),
    native_kind: parts.nativeKind,
    kind_candidates: parts.kindCandidates,
    correlation: parts.correlation ?? {},
    origin_hint: parts.originHint,
    ...(parts.inputSourceLabel === undefined ? {} : { input_source_label: parts.inputSourceLabel }),
    is_auto_turn: isAutoTurn,
    payload: parts.payload,
    attribution: attribution(view, parts.sender, parts.typedUserMessage),
    required_capabilities: contract.required_capabilities,
    rejections: sortRejections(parts.rejections)
  };
}

function inputParts(raw: RawHostEvent, view: OpenhandsPayloadView): DraftParts {
  const plainText = view.mediaType === "text/plain;charset=utf-8" ? view.decodedText : null;
  // DD-HOST-060 names `hook_input` as the payload field. It may be a string or
  // an object that carries the prompt, so both shapes are read without copying
  // text out of the validated blob.
  const hookInput = objectMember(view.record, ["hook_input", "input"]);
  const directText = stringMember(view.record, ["prompt", "text", "message"]);
  const nestedText = stringMember(hookInput, ["prompt", "text", "message", "content"]);
  const text = directText ?? nestedText ?? plainText;
  const textRef =
    directText !== null
      ? textMemberRef(view, ["prompt", "text", "message"], directText)
      : nestedText !== null
        ? valueMemberRef(view, ["hook_input", "input"])
        : textMemberRef(view, ["prompt", "text", "message", "hook_input"], text);
  const directive = stringMember(view.record, ["directive_strength"]);
  const parentNativeId = stringMember(view.record, ["parent_native_id"]);
  const rejections: EventRejection[] = [];
  if (text === null) {
    rejections.push(rejection("E_FIELD_MISSING", "text", raw.payload_ref, true));
  }
  return {
    nativeKind: "prompt",
    kindCandidates: openhandsCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: directive === "explicit" ? "explicit" : "ambiguous",
      ...(parentNativeId === null ? {} : { parent_native_id: parentNativeId })
    },
    originHint: "unknown",
    rejections,
    // SDK 1.56 fires `UserPromptSubmit` only for `MessageEvent.source == "user"`
    // (conversation_hooks.py); model/assistant messages never raise it. That
    // host capability is weaker than a typed field but stronger than a bare
    // process check, so the kernel records basis `host_capability`.
    sender: "human",
    typedUserMessage: true,
    inputSourceLabel: "host_capability.user_prompt_hook"
  };
}

function toolCallParts(raw: RawHostEvent, view: OpenhandsPayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  const toolObject = objectMember(view.record, ["tool"]);
  const toolName =
    stringMember(view.record, ["tool_name", "toolName", "name"]) ??
    stringMember(toolObject, ["name", "tool_name", "toolName"]);
  if (callId === null || toolName === null) {
    // A tool payload that cannot form `tool.call` is a precondition failure:
    // a draft whose payload kind and kind_candidates disagree would be rejected
    // by finalize before any fatal rejection is recorded.
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  const parent = raw.native_ids.parent_tool_call_id;
  return adapterOk({
    nativeKind: "event",
    kindCandidates: openhandsCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.call",
      tool_call_id: callId,
      ...(parent === undefined ? {} : { parent_tool_call_id: parent }),
      tool_name: toolName,
      arguments_ref: valueMemberRef(view, ["arguments", "args", "input", "tool_input"])
    },
    originHint: "host_auto",
    rejections: [],
    sender: "tool",
    typedUserMessage: false,
    correlation: parent === undefined ? {} : { parent_call_id: parent }
  });
}

function toolResultParts(raw: RawHostEvent, view: OpenhandsPayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  if (callId === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  return adapterOk({
    nativeKind: "event",
    kindCandidates: openhandsCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.result",
      tool_call_id: callId,
      status: toolResultStatus(view),
      text_ref: textMemberRef(view, ["text", "result", "output", "content"])
    },
    originHint: "host_auto",
    rejections: [],
    sender: "tool",
    typedUserMessage: false
  });
}

function boundaryParts(raw: RawHostEvent, boundary: "stop" | "session_end"): DraftParts {
  return {
    nativeKind: "other",
    kindCandidates: openhandsCanonicalKinds(raw.host_event),
    payload: boundaryPayload(raw, boundary, openhandsRetryStateUnknown()),
    originHint: "host_auto",
    rejections: [],
    sender: "system",
    typedUserMessage: false
  };
}

function observationParts(raw: RawHostEvent, view: OpenhandsPayloadView): DraftParts {
  return {
    nativeKind: "event",
    kindCandidates: [],
    payload: observationPayload(view, raw.host_event),
    originHint: "host_auto",
    rejections: [],
    sender: "system",
    typedUserMessage: false
  };
}

function draftFor(
  raw: RawHostEvent,
  view: OpenhandsPayloadView,
  contract: EventContract
): AdapterResult<NormalizedHostEventDraft> {
  switch (raw.host_event) {
    case "UserPromptSubmit":
      return adapterOk(
        makeDraft(raw, view, contract, inputParts(raw, view), openhandsInputOriginUnknown())
      );
    case "PreToolUse": {
      const parts = toolCallParts(raw, view);
      return parts.ok
        ? adapterOk(makeDraft(raw, view, contract, parts.value, openhandsAutoTurnUnknown()))
        : parts;
    }
    case "PostToolUse": {
      const parts = toolResultParts(raw, view);
      return parts.ok
        ? adapterOk(makeDraft(raw, view, contract, parts.value, openhandsAutoTurnUnknown()))
        : parts;
    }
    case "Stop":
      return adapterOk(
        makeDraft(raw, view, contract, boundaryParts(raw, "stop"), openhandsAutoTurnUnknown())
      );
    case "SessionStart":
      return adapterOk(
        makeDraft(raw, view, contract, observationParts(raw, view), openhandsAutoTurnUnknown())
      );
    case "SessionEnd":
      return adapterOk(
        makeDraft(raw, view, contract, boundaryParts(raw, "session_end"), openhandsAutoTurnUnknown())
      );
    default:
      return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
}

function registrationMatches(raw: RawHostEvent): boolean {
  const registration: ActiveAdapterRegistration = raw.registration;
  return (
    registration.adapter_id === OPENHANDS_ADAPTER_ID &&
    registration.host_id === OPENHANDS_HOST_ID &&
    registration.adapter_version === OPENHANDS_ADAPTER_VERSION &&
    registration.implementation_hash === OPENHANDS_IMPLEMENTATION_HASH &&
    registration.descriptor_hash === OPENHANDS_DESCRIPTOR_HASH &&
    registration.mode === raw.mode &&
    registration.config_space === raw.config_space
  );
}

/**
 * Normalizes one OpenHands host event. Precondition failures return `Err`;
 * missing payload fields return a draft with fatal `rejections` so host core
 * records a `HostEventRejection` instead of ingesting a partial event.
 */
export function normalizeOpenhandsEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
  const raw = input.raw;
  const observedAt = raw.received_at;
  if (input.schema_version !== "rsi.normalize_host_event_input/1") {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  if (raw.host_id !== OPENHANDS_HOST_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (raw.adapter_id !== OPENHANDS_ADAPTER_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (!isOpenhandsMode(raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!isOpenhandsConfigSpace(raw.config_space)) {
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
  const contract = openhandsEventContract(raw.host_event);
  if (contract === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  const view = readOpenhandsPayload(input.payload);
  if (view === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  return draftFor(raw, view, contract);
}
