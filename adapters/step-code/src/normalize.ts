/**
 * Step Code `normalizeEvent` (DD-TRG-004, DD-HOST-030, DD-HOST-100).
 *
 * Synchronous and pure: it reads only `raw` scalar fields and the frozen
 * payload view, never the clock, storage, network or host. It does not allocate
 * `normalized_id`, `input_epoch`, task or job, and does not produce
 * `source_seq`, `event_identity_key` or `receipt_seq`.
 *
 * The extension surface and the `sdk_stdio` surface are disjoint: an event of
 * one surface is rejected in the other mode (DD-HOST-100 "Step stdio 分界").
 *
 * Boundary facts are contract-derived, not payload-observed. The pinned 0.1.5
 * `agent_settled` payload is exactly `{"type":"agent_settled"}`. Its emitter
 * runs in the `finally` block after `_handlePostAgentRun` has drained automatic
 * retry, compaction recovery and queued steering/follow-up continuations, so
 * the event name carries main-loop settle semantics even though the payload
 * has no queue, retry or async field. The derived scope is the main agent loop
 * only; lane, cron and subagent work are separate wake-up sources and are not
 * claimed by this boundary.
 *
 * Source pin: Step Code source commit
 * e08c6dd21310e75b296597d22910094fc786ccd6,
 * `packages/coding-agent/src/core/agent-session.ts:1108-1112` and
 * `:1696-1715`; `packages/coding-agent/src/core/extensions/types.ts:809-812`;
 * `packages/coding-agent/docs/rpc.md:865,905-910`.
 *
 * Anything the contract does not establish is reported as `UnknownFact`:
 * - `input` has no origin field, so `is_auto_turn` is unknown;
 * - `agent_end.willRetry` is absent in some payloads;
 * - `before_agent_start`, `session_shutdown` and stdio hooks carry no settle
 *   evidence, so their retry, queue and async facts stay unknown;
 * - `sdk_stdio` does not consume `UserPromptSubmit.additionalContext` and a
 *   `Stop` block does not drive a continuation.
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
import { isStepConfigSpace, isStepMode, isStepStdioMode, STEP_DESCRIPTOR_HASH } from "./descriptor.js";
import {
  isStepStdioEvent,
  stepAsyncWorkUnknown,
  stepCanonicalKinds,
  stepEventContract,
  stepInputOriginUnknown,
  stepQueueEmptyUnknown,
  stepRetryStateUnknown
} from "./events.js";
import { STEP_ADAPTER_ID, STEP_ADAPTER_VERSION, STEP_HOST_ID, STEP_HOST_VERSION, STEP_IMPLEMENTATION_HASH } from "./manifest.js";
import {
  booleanMember,
  readStepPayload,
  safeIntegerMember,
  sortedMemberNames,
  stringMember,
  textMemberRef,
  valueMemberRef,
  type StepPayloadView
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

function buildHostBinding(raw: RawHostEvent, view: StepPayloadView): HostEventBindingDraft {
  const ids: NativeIds = raw.native_ids;
  const sourceSeqHint = safeIntegerMember(view.record, ["seq", "sequence", "source_seq"]);
  const occurrence = stringMember(view.record, ["native_occurrence_id", "occurrence_id"]);
  const retryOf = stringMember(view.record, ["retry_of"]);
  const occurredAt = safeIntegerMember(view.record, ["occurred_at", "timestamp"]);
  return {
    host_id: raw.host_id,
    host_version: STEP_HOST_VERSION,
    adapter_id: STEP_ADAPTER_ID,
    adapter_version: STEP_ADAPTER_VERSION,
    implementation_hash: STEP_IMPLEMENTATION_HASH,
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

function attribution(view: StepPayloadView): EventAttribution {
  const names = view.record === null ? Object.freeze(["text"]) : sortedMemberNames(view.record);
  return {
    sender: "unknown",
    typed_user_message: false,
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

function observationPayload(view: StepPayloadView, nativeType: string): NormalizedHostEventPayload {
  return {
    kind: "host.unclassified",
    native_type: nativeType,
    content_ref: view.canonicalRef,
    reason_code: "no_mapping"
  };
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
    async_work: stepAsyncWorkUnknown(),
    queue_empty: stepQueueEmptyUnknown(),
    background_refs: []
  };
}

/**
 * `agent_settled` is the pinned host's main-loop settle signal (DD-HOST-030).
 * The measured 0.1.5 payload is exactly `{"type":"agent_settled"}`, so the
 * settle facts are derived from the event contract and emitter control flow,
 * not read from payload fields. The source pin is in this module's header.
 *
 * Scope stays on the main agent loop. `async_work=false` means no work remains
 * inside that loop. Lane/cron wakeups and subagents are separate input sources
 * and are not evidence against this boundary; `background_refs` stays empty
 * because the event serializes no background reference.
 *
 * If the payload grows any member beyond `type`, the contract no longer matches
 * the measured event. Keep every pending fact unknown instead of overriding a
 * possible host claim with derived `false` values.
 */
const SETTLED_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["type"]);

function settledBoundaryPayload(
  raw: RawHostEvent,
  view: StepPayloadView
): NormalizedHostEventPayload {
  const unexpected =
    view.record === null
      ? ["<non-object>"]
      : Object.keys(view.record).filter((key) => !SETTLED_PAYLOAD_KEYS.has(key));
  if (
    view.record === null ||
    unexpected.length > 0 ||
    view.record["type"] !== "agent_settled"
  ) {
    return boundaryPayload(raw, "stop", stepRetryStateUnknown());
  }
  return {
    kind: "host.boundary",
    boundary: "stop",
    host_stable_event: raw.host_event,
    retry_pending: false,
    async_work: false,
    queue_empty: true,
    background_refs: []
  };
}

/**
 * Step Code compaction payloads carry a reason/type label; the CLM path has no
 * structured enum in the observation table, so anything that is not explicitly
 * `auto` or `manual` is recorded as a host summary rather than guessed.
 */
function compactionKind(view: StepPayloadView): "auto" | "manual" | "host_summary" {
  const value = stringMember(view.record, ["compaction_kind", "reason", "trigger", "type"]);
  if (value === "auto") {
    return "auto";
  }
  if (value === "manual") {
    return "manual";
  }
  return "host_summary";
}

function toolCallId(raw: RawHostEvent, view: StepPayloadView): string | null {
  if (raw.native_ids.tool_call_id !== undefined) {
    return raw.native_ids.tool_call_id;
  }
  return stringMember(view.record, ["tool_call_id", "toolCallId", "tool_use_id", "call_id"]);
}

function toolResultStatus(view: StepPayloadView): "ok" | "error" | "unknown" {
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
}

function makeDraft(
  raw: RawHostEvent,
  view: StepPayloadView,
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
    is_auto_turn: stepInputOriginUnknown(),
    payload: parts.payload,
    attribution: attribution(view),
    required_capabilities: contract.required_capabilities,
    rejections: sortRejections(parts.rejections)
  };
}

function inputParts(raw: RawHostEvent, view: StepPayloadView): DraftParts {
  const retryOf = stringMember(view.record, ["retry_of"]);
  if (retryOf !== null) {
    return {
      nativeKind: "prompt",
      kindCandidates: stepCanonicalKinds(raw.host_event),
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
    kindCandidates: stepCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: directive === "explicit" ? "explicit" : "ambiguous",
      ...(parentNativeId === null ? {} : { parent_native_id: parentNativeId })
    },
    originHint: "unknown",
    rejections,
    ...(source === null ? {} : { inputSourceLabel: source })
  };
}

function toolCallParts(raw: RawHostEvent, view: StepPayloadView): AdapterResult<DraftParts> {
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
    kindCandidates: stepCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.call",
      tool_call_id: callId,
      ...(parent === undefined ? {} : { parent_tool_call_id: parent }),
      tool_name: toolName,
      arguments_ref: valueMemberRef(view, ["arguments", "args", "input", "tool_input"])
    },
    originHint: "host_auto",
    rejections: [],
    correlation: parent === undefined ? {} : { parent_call_id: parent }
  });
}

function toolResultParts(raw: RawHostEvent, view: StepPayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  if (callId === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  return adapterOk({
    nativeKind: "event",
    kindCandidates: stepCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.result",
      tool_call_id: callId,
      status: toolResultStatus(view),
      text_ref: textMemberRef(view, ["text", "result", "output", "content", "tool_response"])
    },
    originHint: "host_auto",
    rejections: []
  });
}

/**
 * `agent_end` is a boundary candidate only when the payload proves
 * `willRetry=false` (DD-HOST-030). The condition is carried in
 * `retry_pending` rather than by dropping the candidate: host core requires a
 * draft's `kind_candidates` to equal the declared event contract exactly
 * (`draftMatchesContract`), so the trigger policy refuses a retrying turn from
 * the payload fact. An absent field stays unknown and is never read as `false`.
 */
function agentEndParts(raw: RawHostEvent, view: StepPayloadView): DraftParts {
  const willRetry = booleanMember(view.record, ["willRetry", "will_retry"]);
  const retryPending = willRetry === null ? stepRetryStateUnknown() : willRetry;
  const hasError = view.record !== null && view.record["error"] !== undefined && view.record["error"] !== null;
  return {
    nativeKind: "event",
    kindCandidates: stepCanonicalKinds(raw.host_event),
    payload: boundaryPayload(raw, hasError ? "error" : "agent_end", retryPending),
    originHint: "host_auto",
    rejections: []
  };
}

function stdioPromptParts(raw: RawHostEvent, view: StepPayloadView): DraftParts {
  // `additionalContext` is not consumed by Step Code's stdio host
  // (DD-HOST-100). It is deliberately ignored here; the input text is the only
  // content this adapter may claim.
  const plainText = view.mediaType === "text/plain;charset=utf-8" ? view.decodedText : null;
  const text = stringMember(view.record, ["prompt", "text", "message", "user_prompt"]) ?? plainText;
  const textRef = textMemberRef(view, ["prompt", "text", "message", "user_prompt"], text);
  const rejections: EventRejection[] = [];
  if (text === null) {
    rejections.push(rejection("E_FIELD_MISSING", "prompt", raw.payload_ref, true));
  }
  return {
    nativeKind: "prompt",
    kindCandidates: stepCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: "ambiguous"
    },
    originHint: "unknown",
    rejections
  };
}

function draftFor(
  raw: RawHostEvent,
  view: StepPayloadView,
  contract: EventContract
): AdapterResult<NormalizedHostEventDraft> {
  switch (raw.host_event) {
    case "input":
    case "UserPromptSubmit": {
      const parts = raw.host_event === "UserPromptSubmit" ? stdioPromptParts(raw, view) : inputParts(raw, view);
      return adapterOk(makeDraft(raw, view, contract, parts));
    }
    case "before_agent_start":
      // Step Code starts a turn here; the boundary payload's closed set has no
      // "turn_start" member, so the prior stop is recorded as the boundary and
      // the host event name keeps the distinction.
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: stepCanonicalKinds(raw.host_event),
          payload: boundaryPayload(raw, "stop", stepRetryStateUnknown()),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "tool_call":
    case "PreToolUse": {
      const parts = toolCallParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "tool_result":
    case "PostToolUse": {
      const parts = toolResultParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "compaction":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: stepCanonicalKinds(raw.host_event),
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
          kindCandidates: stepCanonicalKinds(raw.host_event),
          payload: settledBoundaryPayload(raw, view),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "session_shutdown":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: stepCanonicalKinds(raw.host_event),
          payload: boundaryPayload(raw, "session_end", stepRetryStateUnknown()),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "Stop":
      // A stdio `Stop` block does not drive a continuation (DD-HOST-100); the
      // boundary is still evidence, but retry and async work stay unknown.
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: stepCanonicalKinds(raw.host_event),
          payload: boundaryPayload(raw, "stop", stepRetryStateUnknown()),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "lane":
    case "cron":
    case "context":
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
    registration.adapter_id === STEP_ADAPTER_ID &&
    registration.host_id === STEP_HOST_ID &&
    registration.adapter_version === STEP_ADAPTER_VERSION &&
    registration.implementation_hash === STEP_IMPLEMENTATION_HASH &&
    registration.descriptor_hash === STEP_DESCRIPTOR_HASH &&
    registration.mode === raw.mode &&
    registration.config_space === raw.config_space
  );
}

/**
 * The extension and stdio surfaces are separate bindings. An event from one
 * surface in the other mode is refused instead of being reinterpreted with the
 * other surface's delivery semantics (DD-HOST-100).
 */
function eventAllowedForMode(host_event: string, mode: RawHostEvent["mode"]): boolean {
  return isStepStdioMode(mode) ? isStepStdioEvent(host_event) : !isStepStdioEvent(host_event);
}

/**
 * Normalizes one Step Code host event. Precondition failures return `Err`;
 * missing payload fields return a draft with fatal `rejections` so host core
 * records a `HostEventRejection` instead of ingesting a partial event.
 */
export function normalizeStepEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
  const raw = input.raw;
  const observedAt = raw.received_at;
  if (input.schema_version !== "rsi.normalize_host_event_input/1") {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  if (raw.host_id !== STEP_HOST_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (raw.adapter_id !== STEP_ADAPTER_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (!isStepMode(raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!isStepConfigSpace(raw.config_space)) {
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
  if (!eventAllowedForMode(raw.host_event, raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  const contract = stepEventContract(raw.host_event);
  if (contract === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  const view = readStepPayload(input.payload);
  if (view === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  return draftFor(raw, view, contract);
}
