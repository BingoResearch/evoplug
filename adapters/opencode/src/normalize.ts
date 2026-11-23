/**
 * OpenCode `normalizeEvent` (DD-TRG-004, DD-HOST-050).
 *
 * Synchronous and pure: it reads only `raw` scalar fields and the frozen
 * payload view, never the clock, storage, network or host. It does not allocate
 * `normalized_id`, `input_epoch`, task or job, and does not produce
 * `source_seq`, `event_identity_key` or `receipt_seq`.
 *
 * Anything OpenCode does not serialize is reported as `UnknownFact`:
 * - `session.prompt` has no origin field, so `is_auto_turn` is unknown;
 * - no hook exposes background work or queue depth;
 * - retry state is not serialized for boundary events;
 * - the compaction hook carries no reason; only the durable event does, and
 *   the design does not enumerate its suffixes.
 *
 * Durable execution events are only normalized in server mode (DD-HOST-050).
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
import { OPENCODE_DESCRIPTOR_HASH, isOpenCodeConfigSpace, isOpenCodeMode } from "./descriptor.js";
import {
  isOpenCodeCompactionEvent,
  isOpenCodeServerOnlyEvent,
  openCodeAsyncWorkUnknown,
  openCodeCanonicalKinds,
  openCodeCompactionContract,
  openCodeEventContract,
  openCodeQueueEmptyUnknown,
  openCodeRetryStateUnknown
} from "./events.js";
import { openCodeUnknown, OPENCODE_UNKNOWN_REASON } from "./facts.js";
import {
  OPENCODE_ADAPTER_ID,
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_EVENT_HOST_VERSION,
  OPENCODE_HOST_ID,
  OPENCODE_IMPLEMENTATION_HASH
} from "./manifest.js";
import {
  booleanMember,
  readOpenCodePayload,
  safeIntegerMember,
  sortedMemberNames,
  stringMember,
  textMemberRef,
  valueMemberRef,
  type OpenCodePayloadView
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

function buildHostBinding(raw: RawHostEvent, view: OpenCodePayloadView): HostEventBindingDraft {
  const ids: NativeIds = raw.native_ids;
  const sourceSeqHint = safeIntegerMember(view.record, ["seq", "sequence", "source_seq"]);
  const occurrence = stringMember(view.record, ["native_occurrence_id", "occurrence_id"]);
  const retryOf = stringMember(view.record, ["retry_of"]);
  const occurredAt = safeIntegerMember(view.record, ["occurred_at", "timestamp"]);
  return {
    host_id: raw.host_id,
    host_version: OPENCODE_EVENT_HOST_VERSION,
    adapter_id: OPENCODE_ADAPTER_ID,
    adapter_version: OPENCODE_ADAPTER_VERSION,
    implementation_hash: OPENCODE_IMPLEMENTATION_HASH,
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
  view: OpenCodePayloadView,
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

function observationPayload(view: OpenCodePayloadView, nativeType: string): NormalizedHostEventPayload {
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
    async_work: openCodeAsyncWorkUnknown(),
    queue_empty: openCodeQueueEmptyUnknown(),
    background_refs: []
  };
}

/**
 * OpenCode's compaction hook carries no reason; the durable event may carry
 * one. Anything that is not explicitly `auto` or `manual` is recorded as a
 * host summary rather than guessed.
 */
function compactionKind(view: OpenCodePayloadView): "auto" | "manual" | "host_summary" {
  const value = stringMember(view.record, ["reason", "compaction_kind", "trigger", "type"]);
  if (value === "auto") {
    return "auto";
  }
  if (value === "manual") {
    return "manual";
  }
  return "host_summary";
}

function toolCallId(raw: RawHostEvent, view: OpenCodePayloadView): string | null {
  if (raw.native_ids.tool_call_id !== undefined) {
    return raw.native_ids.tool_call_id;
  }
  return stringMember(view.record, ["callID", "call_id", "toolCallId", "tool_call_id"]);
}

function toolResultStatus(view: OpenCodePayloadView): "ok" | "error" | "unknown" {
  const status = stringMember(view.record, ["status"]);
  if (status === "ok" || status === "error") {
    return status;
  }
  const isError = booleanMember(view.record, ["error", "isError", "is_error"]);
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
  readonly attribution: EventAttribution;
  readonly rejections: readonly EventRejection[];
  readonly inputSourceLabel?: string;
  readonly correlation?: EventCorrelation;
}

function makeDraft(
  raw: RawHostEvent,
  view: OpenCodePayloadView,
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
    is_auto_turn: openCodeUnknown(OPENCODE_UNKNOWN_REASON.inputOriginAbsent),
    payload: parts.payload,
    attribution: parts.attribution,
    required_capabilities: contract.required_capabilities,
    rejections: sortRejections(parts.rejections)
  };
}

function promptParts(raw: RawHostEvent, view: OpenCodePayloadView, contract: EventContract): DraftParts {
  const retryOf = stringMember(view.record, ["retry_of"]);
  if (retryOf !== null) {
    return {
      nativeKind: contract.native_kind,
      kindCandidates: openCodeCanonicalKinds(raw.host_event),
      payload: { kind: "input.retry", retry_of_native_event_id: retryOf, reason_code: "host_retry" },
      originHint: "unknown",
      attribution: attribution(view, "unknown", false),
      rejections: []
    };
  }
  const plainText = view.mediaType === "text/plain;charset=utf-8" ? view.decodedText : null;
  const text = stringMember(view.record, ["prompt", "text", "message"]) ?? plainText;
  const textRef = textMemberRef(view, ["prompt", "text", "message"], text);
  const delivery = stringMember(view.record, ["delivery"]);
  const source = delivery ?? stringMember(view.record, ["source"]);
  const directive = stringMember(view.record, ["directive_strength"]);
  const parentNativeId = stringMember(view.record, ["parent_native_id"]);
  const rejections: EventRejection[] = [];
  if (text === null) {
    rejections.push(rejection("E_FIELD_MISSING", "prompt", raw.payload_ref, true));
  }
  // The plugin marks prompts that came from the TUI process tree. That is the
  // only typed-input evidence OpenCode 2.1.4 exposes; everything else stays
  // `unknown` rather than being guessed.
  const typed = source === "host_process.interactive_tui";
  return {
    nativeKind: contract.native_kind,
    kindCandidates: openCodeCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: directive === "explicit" ? "explicit" : "ambiguous",
      ...(parentNativeId === null ? {} : { parent_native_id: parentNativeId })
    },
    originHint: "unknown",
    attribution: attribution(view, "unknown", typed),
    rejections,
    ...(source === null ? {} : { inputSourceLabel: source })
  };
}

function toolCallParts(raw: RawHostEvent, view: OpenCodePayloadView, contract: EventContract): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  const toolName = stringMember(view.record, ["tool", "tool_name", "toolName", "name"]);
  if (callId === null || toolName === null) {
    // A tool payload that cannot form `tool.call` is a precondition failure:
    // a draft whose payload kind and kind_candidates disagree would be rejected
    // by finalize before any fatal rejection is recorded.
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  const parent = raw.native_ids.parent_tool_call_id;
  return adapterOk({
    nativeKind: contract.native_kind,
    kindCandidates: openCodeCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.call",
      tool_call_id: callId,
      ...(parent === undefined ? {} : { parent_tool_call_id: parent }),
      tool_name: toolName,
      arguments_ref: valueMemberRef(view, ["arguments", "args", "input"])
    },
    originHint: "host_auto",
    attribution: attribution(view, "tool", false),
    rejections: [],
    correlation: parent === undefined ? {} : { parent_call_id: parent }
  });
}

function toolResultParts(
  raw: RawHostEvent,
  view: OpenCodePayloadView,
  contract: EventContract
): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  if (callId === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  return adapterOk({
    nativeKind: contract.native_kind,
    kindCandidates: openCodeCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.result",
      tool_call_id: callId,
      status: toolResultStatus(view),
      text_ref: textMemberRef(view, ["text", "result", "output", "content"])
    },
    originHint: "host_auto",
    attribution: attribution(view, "tool", false),
    rejections: []
  });
}

function compactionParts(view: OpenCodePayloadView, contract: EventContract): DraftParts {
  return {
    nativeKind: contract.native_kind,
    kindCandidates: contract.canonical_kinds,
    payload: { kind: "compaction.observed", compaction_kind: compactionKind(view) },
    originHint: "host_auto",
    attribution: attribution(view, "system", false),
    rejections: []
  };
}

function executionParts(raw: RawHostEvent, view: OpenCodePayloadView, contract: EventContract): DraftParts {
  const boundary = raw.host_event === "session.execution.failed"
    ? "error"
    : raw.host_event === "session.execution.interrupted"
      ? "stop"
      : "agent_end";
  return {
    nativeKind: contract.native_kind,
    kindCandidates: openCodeCanonicalKinds(raw.host_event),
    // Durable execution reports success/failure/interruption but no retry or
    // background-work semantics, so both stay unknown (DD-HOST-050).
    payload: boundaryPayload(raw, boundary, openCodeRetryStateUnknown()),
    originHint: "host_auto",
    attribution: attribution(view, "system", false),
    rejections: []
  };
}

function observationParts(raw: RawHostEvent, view: OpenCodePayloadView, contract: EventContract): DraftParts {
  return {
    nativeKind: contract.native_kind,
    kindCandidates: [],
    payload: observationPayload(view, raw.host_event),
    originHint: "host_auto",
    attribution: attribution(view, "system", false),
    rejections: []
  };
}

function draftFor(
  raw: RawHostEvent,
  view: OpenCodePayloadView,
  contract: EventContract
): AdapterResult<NormalizedHostEventDraft> {
  switch (raw.host_event) {
    case "session.prompt":
      return adapterOk(makeDraft(raw, view, contract, promptParts(raw, view, contract)));
    case "tool.execute.before": {
      const parts = toolCallParts(raw, view, contract);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "tool.execute.after": {
      const parts = toolResultParts(raw, view, contract);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "session.turn.completed":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return adapterOk(makeDraft(raw, view, contract, executionParts(raw, view, contract)));
    case "session.context":
    case "model.request":
    case "http.request":
    case "http.response":
    case "session.idle":
    case "session.status":
      return adapterOk(makeDraft(raw, view, contract, observationParts(raw, view, contract)));
    default:
      if (isOpenCodeCompactionEvent(raw.host_event)) {
        return adapterOk(makeDraft(raw, view, contract, compactionParts(view, contract)));
      }
      return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
}

function registrationMatches(raw: RawHostEvent): boolean {
  const registration: ActiveAdapterRegistration = raw.registration;
  return (
    registration.adapter_id === OPENCODE_ADAPTER_ID &&
    registration.host_id === OPENCODE_HOST_ID &&
    registration.adapter_version === OPENCODE_ADAPTER_VERSION &&
    registration.implementation_hash === OPENCODE_IMPLEMENTATION_HASH &&
    registration.descriptor_hash === OPENCODE_DESCRIPTOR_HASH &&
    registration.mode === raw.mode &&
    registration.config_space === raw.config_space
  );
}

/**
 * Normalizes one OpenCode host event. Precondition failures return `Err`;
 * missing payload fields return a draft with fatal `rejections` so host core
 * records a `HostEventRejection` instead of ingesting a partial event.
 */
export function normalizeOpenCodeEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
  const raw = input.raw;
  const observedAt = raw.received_at;
  if (input.schema_version !== "rsi.normalize_host_event_input/1") {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  if (raw.host_id !== OPENCODE_HOST_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (raw.adapter_id !== OPENCODE_ADAPTER_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (!isOpenCodeMode(raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!isOpenCodeConfigSpace(raw.config_space)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (isOpenCodeServerOnlyEvent(raw.host_event) && raw.mode !== "server") {
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
  const contract = openCodeEventContract(raw.host_event) ?? openCodeCompactionContract(raw.host_event);
  if (contract === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  const view = readOpenCodePayload(input.payload);
  if (view === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  return draftFor(raw, view, contract);
}
