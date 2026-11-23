/**
 * Oh My Pi `normalizeEvent` (DD-TRG-004, DD-HOST-020).
 *
 * Synchronous and pure: it reads only `raw` scalar fields and the frozen
 * payload view, never the clock, storage, network or host. It does not allocate
 * `normalized_id`, `input_epoch`, task or job, and does not produce
 * `source_seq`, `event_identity_key` or `receipt_seq`.
 *
 * Anything OMP does not serialize is reported as `UnknownFact`:
 * - `input` has no origin field, so `is_auto_turn` is unknown;
 * - no hook exposes background work or queue depth;
 * - `agent_end.willContinue` is an unserialized state when absent;
 * - retry state is not serialized for boundary events.
 *
 * `input` is only emitted by the interactive and RPC modes (DD-HOST-020); a
 * print/acp/sdk process that claims an `input` event is rejected rather than
 * normalized into a `new_input` trigger the host cannot produce.
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
import { isOmpConfigSpace, isOmpMode, OMP_DESCRIPTOR_HASH } from "./descriptor.js";
import {
  ompAsyncWorkUnknown,
  ompCanonicalKinds,
  ompEventContract,
  ompQueueEmptyUnknown,
  ompRetryStateUnknown,
  ompWillContinueUnknown
} from "./events.js";
import { ompUnknown, OMP_UNKNOWN_REASON } from "./facts.js";
import {
  OMP_ADAPTER_ID,
  OMP_ADAPTER_VERSION,
  OMP_HOST_ID,
  OMP_HOST_VERSION,
  OMP_IMPLEMENTATION_HASH
} from "./manifest.js";
import {
  booleanMember,
  readOmpPayload,
  safeIntegerMember,
  sortedMemberNames,
  stringMember,
  textMemberRef,
  valueMemberRef,
  type OmpPayloadView
} from "./payload.js";

/** Modes that emit the `input` hook (DD-HOST-020). */
const INPUT_MODES: readonly string[] = Object.freeze(["interactive", "rpc"]);

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

function buildHostBinding(raw: RawHostEvent, view: OmpPayloadView): HostEventBindingDraft {
  const ids: NativeIds = raw.native_ids;
  const sourceSeqHint = safeIntegerMember(view.record, ["seq", "sequence", "source_seq"]);
  const occurrence = stringMember(view.record, ["native_occurrence_id", "occurrence_id"]);
  const retryOf = stringMember(view.record, ["retry_of"]);
  const occurredAt = safeIntegerMember(view.record, ["occurred_at", "timestamp"]);
  return {
    host_id: raw.host_id,
    host_version: OMP_HOST_VERSION,
    adapter_id: OMP_ADAPTER_ID,
    adapter_version: OMP_ADAPTER_VERSION,
    implementation_hash: OMP_IMPLEMENTATION_HASH,
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
  view: OmpPayloadView,
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

function observationPayload(view: OmpPayloadView, nativeType: string): NormalizedHostEventPayload {
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
    async_work: ompAsyncWorkUnknown(),
    queue_empty: ompQueueEmptyUnknown(),
    background_refs: []
  };
}

function toolCallId(raw: RawHostEvent, view: OmpPayloadView): string | null {
  if (raw.native_ids.tool_call_id !== undefined) {
    return raw.native_ids.tool_call_id;
  }
  return stringMember(view.record, ["tool_call_id", "toolCallId", "call_id"]);
}

function toolResultStatus(view: OmpPayloadView): "ok" | "error" | "unknown" {
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
  view: OmpPayloadView,
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

function inputParts(raw: RawHostEvent, view: OmpPayloadView): DraftParts {
  const retryOf = stringMember(view.record, ["retry_of"]);
  if (retryOf !== null) {
    return {
      nativeKind: "prompt",
      kindCandidates: ompCanonicalKinds(raw.host_event),
      payload: { kind: "input.retry", retry_of_native_event_id: retryOf, reason_code: "host_retry" },
      originHint: "unknown",
      rejections: [],
      sender: "unknown",
      typedUserMessage: false
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
    kindCandidates: ompCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: directive === "explicit" ? "explicit" : "ambiguous",
      ...(parentNativeId === null ? {} : { parent_native_id: parentNativeId })
    },
    originHint: "unknown",
    rejections,
    sender: "unknown",
    // OMP shares Pi's hook contract: `source: "interactive"` is present only
    // when the text came from the host's own TUI. Extension-injected and RPC
    // turns carry a different source, so only this label is a typed input.
    typedUserMessage: source === "interactive",
    ...(source === null ? {} : { inputSourceLabel: source })
  };
}

function toolCallParts(raw: RawHostEvent, view: OmpPayloadView): AdapterResult<DraftParts> {
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
    kindCandidates: ompCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.call",
      tool_call_id: callId,
      ...(parent === undefined ? {} : { parent_tool_call_id: parent }),
      tool_name: toolName,
      arguments_ref: valueMemberRef(view, ["arguments", "args", "input"])
    },
    originHint: "host_auto",
    rejections: [],
    sender: "tool",
    typedUserMessage: false,
    correlation: parent === undefined ? {} : { parent_call_id: parent }
  });
}

function toolResultParts(raw: RawHostEvent, view: OmpPayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  if (callId === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  return adapterOk({
    nativeKind: "event",
    kindCandidates: ompCanonicalKinds(raw.host_event),
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

function agentEndParts(raw: RawHostEvent, view: OmpPayloadView): DraftParts {
  const willContinue = booleanMember(view.record, ["willContinue", "will_continue"]);
  const retryPending: boolean | UnknownFact =
    willContinue === null ? ompWillContinueUnknown() : willContinue;
  const hasError = view.record !== null && view.record["error"] !== undefined && view.record["error"] !== null;
  return {
    nativeKind: "event",
    // The contract kind is fixed; `retry_pending` carries `willContinue` so the
    // trigger policy can refuse a continuing turn without a second event.
    kindCandidates: ompCanonicalKinds(raw.host_event),
    payload: boundaryPayload(raw, hasError ? "error" : "agent_end", retryPending),
    originHint: "host_auto",
    rejections: [],
    sender: "system",
    typedUserMessage: false
  };
}

function boundaryParts(raw: RawHostEvent, boundary: "stop" | "session_end"): DraftParts {
  return {
    nativeKind: "event",
    kindCandidates: ompCanonicalKinds(raw.host_event),
    payload: boundaryPayload(raw, boundary, ompRetryStateUnknown()),
    originHint: "host_auto",
    rejections: [],
    sender: "system",
    typedUserMessage: false
  };
}

function observationParts(raw: RawHostEvent, view: OmpPayloadView): DraftParts {
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
  view: OmpPayloadView,
  contract: EventContract
): AdapterResult<NormalizedHostEventDraft> {
  switch (raw.host_event) {
    case "input":
      return adapterOk(
        makeDraft(
          raw,
          view,
          contract,
          inputParts(raw, view),
          ompUnknown(OMP_UNKNOWN_REASON.inputOriginAbsent)
        )
      );
    case "before_agent_start":
      // OMP starts a turn here; the boundary payload's closed set has no
      // "turn_start" member, so the prior stop is recorded as the boundary and
      // the host event name keeps the distinction.
      return adapterOk(
        makeDraft(raw, view, contract, boundaryParts(raw, "stop"), ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized))
      );
    case "tool_call": {
      const parts = toolCallParts(raw, view);
      return parts.ok
        ? adapterOk(
            makeDraft(raw, view, contract, parts.value, ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized))
          )
        : parts;
    }
    case "tool_result": {
      const parts = toolResultParts(raw, view);
      return parts.ok
        ? adapterOk(
            makeDraft(raw, view, contract, parts.value, ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized))
          )
        : parts;
    }
    case "session_stop":
      return adapterOk(
        makeDraft(raw, view, contract, boundaryParts(raw, "stop"), ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized))
      );
    case "agent_end":
      return adapterOk(
        makeDraft(raw, view, contract, agentEndParts(raw, view), ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized))
      );
    case "agent_settled":
      return adapterOk(
        makeDraft(raw, view, contract, boundaryParts(raw, "stop"), ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized))
      );
    case "session_shutdown":
      return adapterOk(
        makeDraft(
          raw,
          view,
          contract,
          boundaryParts(raw, "session_end"),
          ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized)
        )
      );
    case "session_start":
      // Declared as an observation event; only its identity is recorded so a
      // later first-input scope can be bound to the same native session.
      return adapterOk(
        makeDraft(
          raw,
          view,
          contract,
          observationParts(raw, view),
          ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized)
        )
      );
    case "context":
    case "before_provider_request":
      return adapterOk(
        makeDraft(
          raw,
          view,
          contract,
          observationParts(raw, view),
          ompUnknown(OMP_UNKNOWN_REASON.autoTurnNotSerialized)
        )
      );
    default:
      return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
}

function registrationMatches(raw: RawHostEvent): boolean {
  const registration: ActiveAdapterRegistration = raw.registration;
  return (
    registration.adapter_id === OMP_ADAPTER_ID &&
    registration.host_id === OMP_HOST_ID &&
    registration.adapter_version === OMP_ADAPTER_VERSION &&
    registration.implementation_hash === OMP_IMPLEMENTATION_HASH &&
    registration.descriptor_hash === OMP_DESCRIPTOR_HASH &&
    registration.mode === raw.mode &&
    registration.config_space === raw.config_space
  );
}

/**
 * Normalizes one OMP host event. Precondition failures return `Err`; missing
 * payload fields return a draft with fatal `rejections` so host core records a
 * `HostEventRejection` instead of ingesting a partial event.
 */
export function normalizeOmpEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
  const raw = input.raw;
  const observedAt = raw.received_at;
  if (input.schema_version !== "rsi.normalize_host_event_input/1") {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  if (raw.host_id !== OMP_HOST_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (raw.adapter_id !== OMP_ADAPTER_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (!isOmpMode(raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!isOmpConfigSpace(raw.config_space)) {
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
  if (raw.host_event === "input" && !INPUT_MODES.includes(raw.mode)) {
    // DD-HOST-020: `input` exists only in interactive and RPC. A one-shot or
    // SDK process cannot produce it, so an upload claiming it is not a
    // `new_input` occurrence.
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  const contract = ompEventContract(raw.host_event);
  if (contract === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  const view = readOmpPayload(input.payload);
  if (view === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  return draftFor(raw, view, contract);
}
