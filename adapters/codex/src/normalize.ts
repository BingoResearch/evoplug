/**
 * Codex `normalizeEvent` (DD-TRG-004, DD-HOST-040).
 *
 * Synchronous and pure: it reads only `raw` scalar fields and the frozen
 * payload view, never the clock, storage, network or host. It does not allocate
 * `normalized_id`, `input_epoch`, task or job, and does not produce
 * `source_seq`, `event_identity_key` or `receipt_seq`.
 *
 * Anything Codex does not serialize is reported as `UnknownFact`:
 * - `UserPromptSubmit` has no origin field, so `is_auto_turn` is unknown and
 *   origin never rises above `unknown`;
 * - no hook exposes background work or queue depth;
 * - `Stop` may be followed by a continuation, and the payload does not carry a
 *   retry flag, so `retry_pending` is unknown;
 * - app-server durable `thread/inject_items` semantics are unverified.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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
import { isCodexConfigSpace, isCodexMode, CODEX_DESCRIPTOR_HASH } from "./descriptor.js";
import {
  codexAsyncWorkUnknown,
  codexCanonicalKinds,
  codexEventContract,
  codexQueueEmptyUnknown,
  codexRetryStateUnknown
} from "./events.js";
import { codexUnknown, CODEX_UNKNOWN_REASON } from "./facts.js";
import { CODEX_ADAPTER_ID, CODEX_ADAPTER_VERSION, CODEX_HOST_ID, CODEX_HOST_VERSION, CODEX_IMPLEMENTATION_HASH } from "./manifest.js";
import {
  booleanMember,
  readCodexPayload,
  safeIntegerMember,
  sortedMemberNames,
  stringMember,
  textMemberRef,
  valueMemberRef,
  type CodexPayloadView
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

function buildHostBinding(raw: RawHostEvent, view: CodexPayloadView): HostEventBindingDraft {
  const ids: NativeIds = raw.native_ids;
  const sourceSeqHint = safeIntegerMember(view.record, ["seq", "sequence", "source_seq"]);
  const occurrence = stringMember(view.record, ["native_occurrence_id", "occurrence_id"]);
  const occurredAt = safeIntegerMember(view.record, [
    "occurred_at",
    "timestamp",
    "__evoplug_event_occurred_at"
  ]);
  return {
    host_id: raw.host_id,
    host_version: CODEX_HOST_VERSION,
    adapter_id: CODEX_ADAPTER_ID,
    adapter_version: CODEX_ADAPTER_VERSION,
    implementation_hash: CODEX_IMPLEMENTATION_HASH,
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

function attribution(view: CodexPayloadView, typed = false): EventAttribution {
  const names = view.record === null ? Object.freeze(["text"]) : sortedMemberNames(view.record);
  return {
    sender: typed ? "human" : "unknown",
    typed_user_message: typed,
    typed_field_names: typed ? Object.freeze(["user_message"]) : names
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

function observationPayload(view: CodexPayloadView, nativeType: string): NormalizedHostEventPayload {
  return { kind: "host.unclassified", native_type: nativeType, content_ref: view.canonicalRef, reason_code: "no_mapping" };
}

function boundaryPayload(
  raw: RawHostEvent,
  boundary: "stop" | "agent_end" | "session_end" | "error",
  retryPending: boolean | UnknownFact,
  exitBudgetMs?: number
): NormalizedHostEventPayload {
  return {
    kind: "host.boundary",
    boundary,
    host_stable_event: raw.host_event,
    retry_pending: retryPending,
    async_work: codexAsyncWorkUnknown(),
    queue_empty: codexQueueEmptyUnknown(),
    background_refs: [],
    ...(exitBudgetMs === undefined ? {} : { exit_budget_ms: exitBudgetMs })
  };
}

/**
 * Codex `PreCompact`/`PostCompact` carry no summary (DD-HOST-100). The payload
 * kind has no `unknown` member, so a missing trigger is reported as the host's
 * own compaction event; `summary_available` is never claimed by this adapter.
 */
function compactionKind(view: CodexPayloadView): "auto" | "manual" | "host_summary" {
  const value = stringMember(view.record, ["compaction_kind", "reason", "trigger", "type"]);
  if (value === "auto") {
    return "auto";
  }
  if (value === "manual") {
    return "manual";
  }
  return "host_summary";
}

function toolCallId(raw: RawHostEvent, view: CodexPayloadView): string | null {
  if (raw.native_ids.tool_call_id !== undefined) {
    return raw.native_ids.tool_call_id;
  }
  return stringMember(view.record, ["tool_use_id", "tool_call_id", "toolCallId", "call_id"]);
}

function toolResultStatus(view: CodexPayloadView): "ok" | "error" | "unknown" {
  const status = stringMember(view.record, ["status"]);
  if (status === "ok" || status === "error") {
    return status;
  }
  const isError = booleanMember(view.record, ["is_error", "isError"]);
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
  readonly correlation?: EventCorrelation;
  /** Host-native field that proves the input came from the user's terminal. */
  readonly inputSourceLabel?: string;
}

function makeDraft(
  raw: RawHostEvent,
  view: CodexPayloadView,
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
    is_auto_turn: parts.inputSourceLabel === undefined
      ? codexUnknown(CODEX_UNKNOWN_REASON.inputOriginAbsent)
      : false,
    payload: parts.payload,
    attribution: attribution(view, parts.inputSourceLabel !== undefined),
    ...(parts.inputSourceLabel === undefined ? {} : { input_source_label: parts.inputSourceLabel }),
    required_capabilities: contract.required_capabilities,
    rejections: sortRejections(parts.rejections)
  };
}


/**
 * Appendix K.1/§6.1: Codex writes the conversation as a rollout JSONL. The
 * hook payload names that file, and a prompt typed into the TUI appears as a
 * `response_item` message with `role: "user"` whose text equals the hook
 * prompt. Injected context messages start with `<environment_context>` and are
 * not qualified. An unreadable/mismatched rollout stays `unknown`.
 */
function transcriptTypedPrompt(transcriptPath: string | null, prompt: string | null): string | null {
  if (transcriptPath === null || prompt === null || !transcriptPath.startsWith("/")) return null;
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let match: string | null = null;
    for (const line of buffer.toString("utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record["type"] !== "response_item") continue;
      const payload = record["payload"];
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
      const item = payload as Record<string, unknown>;
      if (item["type"] !== "message" || item["role"] !== "user") continue;
      const content = item["content"];
      if (!Array.isArray(content)) continue;
      const text = content
        .map((part) => {
          if (typeof part !== "object" || part === null) return "";
          const value = (part as Record<string, unknown>)["text"];
          return typeof value === "string" ? value : "";
        })
        .join("");
      if (text.trim().length === 0) continue;
      if (text.trim().startsWith("<environment_context>")) continue;
      match = text;
    }
    return match !== null && match.trim() === prompt.trim() ? "transcript.user_message" : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function userPromptParts(raw: RawHostEvent, view: CodexPayloadView): DraftParts {
  const plainText = view.mediaType === "text/plain;charset=utf-8" ? view.decodedText : null;
  const text = stringMember(view.record, ["prompt", "text", "message"]) ?? plainText;
  const textRef = textMemberRef(view, ["prompt", "text", "message"], text);
  const directive = stringMember(view.record, ["directive_strength"]);
  const parentNativeId = stringMember(view.record, ["parent_native_id"]);
  const rejections: EventRejection[] = [];
  if (text === null) {
    rejections.push(rejection("E_FIELD_MISSING", "text", raw.payload_ref, true));
  }
  const typedField =
    transcriptTypedPrompt(stringMember(view.record, ["transcript_path"]), text) ??
    (view.record !== null && view.record["__evoplug_typed_user"] === "interactive_tui"
      ? "host_process.interactive_tui"
      : null);
  return {
    nativeKind: "prompt",
    kindCandidates: codexCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: directive === "explicit" ? "explicit" : "ambiguous",
      ...(parentNativeId === null ? {} : { parent_native_id: parentNativeId })
    },
    // The hook payload has no source field. The rollout's matching user
    // message is the measured trusted field; otherwise origin stays unknown.
    originHint: "unknown",
    ...(typedField === null ? {} : { inputSourceLabel: typedField }),
    rejections
  };
}

function toolCallParts(raw: RawHostEvent, view: CodexPayloadView): AdapterResult<DraftParts> {
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
    kindCandidates: codexCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.call",
      tool_call_id: callId,
      ...(parent === undefined ? {} : { parent_tool_call_id: parent }),
      tool_name: toolName,
      arguments_ref: valueMemberRef(view, ["tool_input", "arguments", "args", "input"])
    },
    originHint: "host_auto",
    rejections: [],
    correlation: parent === undefined ? {} : { parent_call_id: parent }
  });
}

function toolResultParts(raw: RawHostEvent, view: CodexPayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  if (callId === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  return adapterOk({
    nativeKind: "event",
    kindCandidates: codexCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.result",
      tool_call_id: callId,
      status: toolResultStatus(view),
      text_ref: textMemberRef(view, ["tool_response", "result", "output", "content", "text"])
    },
    originHint: "host_auto",
    rejections: []
  });
}

function draftFor(
  raw: RawHostEvent,
  view: CodexPayloadView,
  contract: EventContract
): AdapterResult<NormalizedHostEventDraft> {
  switch (raw.host_event) {
    case "UserPromptSubmit":
      return adapterOk(makeDraft(raw, view, contract, userPromptParts(raw, view)));
    case "PreToolUse": {
      const parts = toolCallParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "PostToolUse": {
      const parts = toolResultParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "Stop":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: codexCanonicalKinds(raw.host_event),
          payload: boundaryPayload(raw, "stop", codexRetryStateUnknown()),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "SessionEnd":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: codexCanonicalKinds(raw.host_event),
          // DD-HOST-040: SessionEnd default 1 s, clamped to 3 s; it covers the
          // root session only and flushes rollout before executing.
          payload: boundaryPayload(raw, "session_end", codexRetryStateUnknown(), 1000),
          originHint: "host_auto",
          rejections: []
        })
      );
    case "PreCompact":
    case "PostCompact":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: codexCanonicalKinds(raw.host_event),
          payload: { kind: "compaction.observed", compaction_kind: compactionKind(view) },
          originHint: "host_auto",
          rejections: []
        })
      );
    case "Interrupt":
    case "SubagentStart":
    case "SubagentStop":
    case "PreModelRequest":
    case "PostModelRequest":
    case "PermissionRequest":
    case "SessionStart":
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
    registration.adapter_id === CODEX_ADAPTER_ID &&
    registration.host_id === CODEX_HOST_ID &&
    registration.adapter_version === CODEX_ADAPTER_VERSION &&
    registration.implementation_hash === CODEX_IMPLEMENTATION_HASH &&
    registration.descriptor_hash === CODEX_DESCRIPTOR_HASH &&
    registration.mode === raw.mode &&
    registration.config_space === raw.config_space
  );
}

/**
 * Normalizes one Codex host event. Precondition failures return `Err`; missing
 * payload fields return a draft with fatal `rejections` so host core records a
 * `HostEventRejection` instead of ingesting a partial event.
 */
export function normalizeCodexEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
  const raw = input.raw;
  const observedAt = raw.received_at;
  if (input.schema_version !== "rsi.normalize_host_event_input/1") {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  if (raw.host_id !== CODEX_HOST_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (raw.adapter_id !== CODEX_ADAPTER_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (!isCodexMode(raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!isCodexConfigSpace(raw.config_space)) {
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
  const contract = codexEventContract(raw.host_event);
  if (contract === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  const view = readCodexPayload(input.payload);
  if (view === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  return draftFor(raw, view, contract);
}
