/**
 * Claude Code `normalizeEvent` (DD-TRG-004, DD-HOST-070, DD-HOST-100).
 *
 * Synchronous and pure: it reads only `raw` scalar fields and the frozen
 * payload view, never the clock, storage, network or host. It does not allocate
 * `normalized_id`, `input_epoch`, task or job, and does not produce
 * `source_seq`, `event_identity_key` or `receipt_seq`.
 *
 * Anything Claude Code does not serialize is reported as `UnknownFact`:
 * - `UserPromptSubmit` has no origin field and is also emitted for automatic
 *   turns, so `is_auto_turn` is unknown and origin never rises above
 *   `unknown` (DD-HOST-100);
 * - no hook exposes queue depth or the consumption point of queued input;
 * - `Stop`/`StopFailure` carry no retry/continuation flag, and background-task
 *   semantics are unverified;
 * - `PreCompact`/`PostCompact` carry a summary a hook cannot read or rewrite.
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
import { CLAUDE_DESCRIPTOR_HASH, isClaudeConfigSpace, isClaudeMode } from "./descriptor.js";
import {
  claudeBackgroundSemanticsUnknown,
  claudeCanonicalKinds,
  claudeEventContract,
  claudeQueueEmptyUnknown,
  claudeRetryStateUnknown
} from "./events.js";
import { claudeUnknown, CLAUDE_UNKNOWN_REASON } from "./facts.js";
import {
  CLAUDE_ADAPTER_ID,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_HOST_ID,
  CLAUDE_HOST_VERSION,
  CLAUDE_IMPLEMENTATION_HASH
} from "./manifest.js";
import {
  backgroundRefs,
  booleanMember,
  readClaudePayload,
  safeIntegerMember,
  sortedMemberNames,
  stringArrayMember,
  stringMember,
  textMemberRef,
  valueMemberRef,
  type ClaudePayloadView
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

function buildHostBinding(raw: RawHostEvent, view: ClaudePayloadView): HostEventBindingDraft {
  const ids: NativeIds = raw.native_ids;
  const sourceSeqHint = safeIntegerMember(view.record, ["seq", "sequence", "source_seq"]);
  const occurrence = stringMember(view.record, ["native_occurrence_id", "occurrence_id"]);
  const retryOf = stringMember(view.record, ["retry_of"]);
  const occurredAt = safeIntegerMember(view.record, [
    "occurred_at",
    "timestamp",
    "__evoplug_event_occurred_at"
  ]);
  return {
    host_id: raw.host_id,
    host_version: CLAUDE_HOST_VERSION,
    adapter_id: CLAUDE_ADAPTER_ID,
    adapter_version: CLAUDE_ADAPTER_VERSION,
    implementation_hash: CLAUDE_IMPLEMENTATION_HASH,
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

function attribution(view: ClaudePayloadView, typed = false): EventAttribution {
  const names = view.record === null ? Object.freeze(["text"]) : sortedMemberNames(view.record);
  return {
    sender: typed ? "human" : "unknown",
    typed_user_message: typed,
    typed_field_names: typed ? Object.freeze(["userType"]) : names
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

function observationPayload(view: ClaudePayloadView, nativeType: string): NormalizedHostEventPayload {
  return { kind: "host.unclassified", native_type: nativeType, content_ref: view.canonicalRef, reason_code: "no_mapping" };
}

const BACKGROUND_TASK_KEYS: readonly string[] = ["background_tasks", "session_crons"];

function boundaryPayload(
  raw: RawHostEvent,
  view: ClaudePayloadView,
  boundary: "stop" | "agent_end" | "session_end" | "error",
  exitBudgetMs?: number
): NormalizedHostEventPayload {
  const refs = backgroundRefs(view.record, BACKGROUND_TASK_KEYS);
  // A non-empty `background_tasks`/`session_crons` list is an observed fact.
  // An absent or empty list is not evidence of "no background work"
  // (DD-HOST-070), so it stays unknown.
  const asyncWork: boolean | UnknownFact = refs.length > 0 ? true : claudeBackgroundSemanticsUnknown();
  return {
    kind: "host.boundary",
    boundary,
    host_stable_event: raw.host_event,
    retry_pending: claudeRetryStateUnknown(),
    async_work: asyncWork,
    queue_empty: claudeQueueEmptyUnknown(),
    background_refs: refs,
    ...(exitBudgetMs === undefined ? {} : { exit_budget_ms: exitBudgetMs })
  };
}

/**
 * `PreCompact`/`PostCompact` carry a summary that a hook cannot read or
 * rewrite (DD-HOST-100). The payload kind has no `unknown` member, so a
 * missing trigger is reported as the host's own summary event; the adapter
 * never claims the summary is readable.
 */
function compactionKind(view: ClaudePayloadView): "auto" | "manual" | "host_summary" {
  const value = stringMember(view.record, ["compaction_kind", "trigger", "reason", "type"]);
  if (value === "auto") {
    return "auto";
  }
  if (value === "manual") {
    return "manual";
  }
  return "host_summary";
}

function toolCallId(raw: RawHostEvent, view: ClaudePayloadView): string | null {
  if (raw.native_ids.tool_call_id !== undefined) {
    return raw.native_ids.tool_call_id;
  }
  const direct = stringMember(view.record, ["tool_use_id", "tool_call_id", "toolCallId", "call_id"]);
  if (direct !== null) {
    return direct;
  }
  const batch = stringArrayMember(view.record, ["tool_use_ids", "tool_call_ids"]);
  return batch === null || batch.length === 0 ? null : (batch[0] ?? null);
}

function toolResultStatus(view: ClaudePayloadView): "ok" | "error" | "unknown" {
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
  readonly isAutoTurn: boolean | UnknownFact;
  readonly rejections: readonly EventRejection[];
  readonly correlation?: EventCorrelation;
  /** Host-native field that proves the input came from the user's terminal. */
  readonly inputSourceLabel?: string;
}

function makeDraft(
  raw: RawHostEvent,
  view: ClaudePayloadView,
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
    is_auto_turn: parts.isAutoTurn,
    payload: parts.payload,
    attribution: attribution(view, parts.inputSourceLabel !== undefined),
    ...(parts.inputSourceLabel === undefined ? {} : { input_source_label: parts.inputSourceLabel }),
    required_capabilities: contract.required_capabilities,
    rejections: sortRejections(parts.rejections)
  };
}


/**
 * Appendix K.1/§6.1: the hook payload has no source field, but the host writes
 * the typed user message into its own transcript with `userType: "external"`
 * before it emits `UserPromptSubmit`. Reading that host-written entry (bounded
 * to the tail of the file) is the measured trusted field for this version;
 * an unreadable or mismatched transcript stays `unknown`.
 */
function transcriptTypedField(transcriptPath: string | null, promptId: string | null): string | null {
  if (transcriptPath === null || !transcriptPath.startsWith("/")) return null;
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    let match: Record<string, unknown> | null = null;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record["type"] !== "user") continue;
      if (promptId !== null && record["promptId"] !== promptId) continue;
      match = record;
    }
    if (match === null) return null;
    if (match["isMeta"] === true) return null;
    return match["userType"] === "external" ? "transcript.userType=external" : null;
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

function userPromptParts(raw: RawHostEvent, view: ClaudePayloadView): DraftParts {
  const retryOf = stringMember(view.record, ["retry_of"]);
  if (retryOf !== null) {
    return {
      nativeKind: "prompt",
      kindCandidates: claudeCanonicalKinds(raw.host_event),
      payload: { kind: "input.retry", retry_of_native_event_id: retryOf, reason_code: "host_retry" },
      originHint: "unknown",
      isAutoTurn: claudeUnknown(CLAUDE_UNKNOWN_REASON.inputOriginAbsent),
      rejections: []
    };
  }
  const plainText = view.mediaType === "text/plain;charset=utf-8" ? view.decodedText : null;
  const textKeys = ["prompt", "expanded_prompt", "text", "message"];
  const text = stringMember(view.record, textKeys) ?? plainText;
  const textRef = textMemberRef(view, textKeys, text);
  const directive = stringMember(view.record, ["directive_strength"]);
  const parentNativeId = stringMember(view.record, ["parent_native_id"]);
  const rejections: EventRejection[] = [];
  if (text === null) {
    rejections.push(rejection("E_FIELD_MISSING", "text", raw.payload_ref, true));
  }
  const typedField =
    transcriptTypedField(
      stringMember(view.record, ["transcript_path"]),
      stringMember(view.record, ["prompt_id"])
    ) ??
    (view.record !== null && view.record["__evoplug_typed_user"] === "interactive_tui"
      ? "host_process.interactive_tui"
      : null);
  return {
    nativeKind: "prompt",
    kindCandidates: claudeCanonicalKinds(raw.host_event),
    payload: {
      kind: "input.received",
      text_ref: textRef,
      directive_strength: directive === "explicit" ? "explicit" : "ambiguous",
      ...(parentNativeId === null ? {} : { parent_native_id: parentNativeId })
    },
    // The payload has no source field, but the host-written transcript entry
    // carries `userType: "external"` for a prompt typed into the TUI. Without
    // that measured field origin stays `unknown` (DD-HOST-100).
    originHint: "unknown",
    isAutoTurn: typedField === null ? claudeUnknown(CLAUDE_UNKNOWN_REASON.inputOriginAbsent) : false,
    ...(typedField === null ? {} : { inputSourceLabel: typedField }),
    rejections
  };
}

function toolCallParts(raw: RawHostEvent, view: ClaudePayloadView): AdapterResult<DraftParts> {
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
    kindCandidates: claudeCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.call",
      tool_call_id: callId,
      ...(parent === undefined ? {} : { parent_tool_call_id: parent }),
      tool_name: toolName,
      arguments_ref: valueMemberRef(view, ["tool_input", "arguments", "args", "input"])
    },
    originHint: "host_auto",
    isAutoTurn: claudeUnknown(CLAUDE_UNKNOWN_REASON.autoTurnNotApplicable),
    rejections: [],
    correlation: parent === undefined ? {} : { parent_call_id: parent }
  });
}

function toolResultParts(raw: RawHostEvent, view: ClaudePayloadView): AdapterResult<DraftParts> {
  const callId = toolCallId(raw, view);
  if (callId === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, raw.received_at));
  }
  return adapterOk({
    nativeKind: "event",
    kindCandidates: claudeCanonicalKinds(raw.host_event),
    payload: {
      kind: "tool.result",
      tool_call_id: callId,
      status: toolResultStatus(view),
      text_ref: textMemberRef(view, ["tool_response", "result", "output", "content", "text"])
    },
    originHint: "host_auto",
    isAutoTurn: claudeUnknown(CLAUDE_UNKNOWN_REASON.autoTurnNotApplicable),
    rejections: []
  });
}

function boundaryParts(
  raw: RawHostEvent,
  view: ClaudePayloadView,
  boundary: "stop" | "agent_end" | "session_end" | "error",
  exitBudgetMs?: number
): DraftParts {
  return {
    nativeKind: "event",
    kindCandidates: claudeCanonicalKinds(raw.host_event),
    payload: boundaryPayload(raw, view, boundary, exitBudgetMs),
    originHint: "host_auto",
    isAutoTurn: claudeUnknown(CLAUDE_UNKNOWN_REASON.autoTurnNotApplicable),
    rejections: []
  };
}

function draftFor(
  raw: RawHostEvent,
  view: ClaudePayloadView,
  contract: EventContract
): AdapterResult<NormalizedHostEventDraft> {
  switch (raw.host_event) {
    case "UserPromptSubmit":
    case "UserPromptExpansion":
      return adapterOk(makeDraft(raw, view, contract, userPromptParts(raw, view)));
    case "PreToolUse": {
      const parts = toolCallParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "PostToolUse":
    case "PostToolBatch": {
      const parts = toolResultParts(raw, view);
      return parts.ok ? adapterOk(makeDraft(raw, view, contract, parts.value)) : parts;
    }
    case "Stop":
      return adapterOk(makeDraft(raw, view, contract, boundaryParts(raw, view, "stop")));
    case "StopFailure":
      return adapterOk(makeDraft(raw, view, contract, boundaryParts(raw, view, "error")));
    case "SessionEnd":
      // DD-HOST-070: SessionEnd shares a 1.5 s default exit budget; settings
      // can raise it to at most 60 s. This is an exit budget, not a total
      // host budget.
      return adapterOk(makeDraft(raw, view, contract, boundaryParts(raw, view, "session_end", 1500)));
    case "PreCompact":
    case "PostCompact":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: claudeCanonicalKinds(raw.host_event),
          payload: { kind: "compaction.observed", compaction_kind: compactionKind(view) },
          originHint: "host_auto",
          isAutoTurn: claudeUnknown(CLAUDE_UNKNOWN_REASON.autoTurnNotApplicable),
          rejections: []
        })
      );
    case "SessionStart":
    case "SubagentStart":
    case "SubagentStop":
    case "TaskCreated":
    case "TaskCompleted":
    case "PostModelSwitch":
    case "ConfigChange":
      return adapterOk(
        makeDraft(raw, view, contract, {
          nativeKind: "event",
          kindCandidates: [],
          payload: observationPayload(view, raw.host_event),
          originHint: "host_auto",
          isAutoTurn: claudeUnknown(CLAUDE_UNKNOWN_REASON.autoTurnNotApplicable),
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
    registration.adapter_id === CLAUDE_ADAPTER_ID &&
    registration.host_id === CLAUDE_HOST_ID &&
    registration.adapter_version === CLAUDE_ADAPTER_VERSION &&
    registration.implementation_hash === CLAUDE_IMPLEMENTATION_HASH &&
    registration.descriptor_hash === CLAUDE_DESCRIPTOR_HASH &&
    registration.mode === raw.mode &&
    registration.config_space === raw.config_space
  );
}

/**
 * Normalizes one Claude Code host event. Precondition failures return `Err`;
 * missing payload fields return a draft with fatal `rejections` so host core
 * records a `HostEventRejection` instead of ingesting a partial event.
 */
export function normalizeClaudeEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
  const raw = input.raw;
  const observedAt = raw.received_at;
  if (input.schema_version !== "rsi.normalize_host_event_input/1") {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  if (raw.host_id !== CLAUDE_HOST_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (raw.adapter_id !== CLAUDE_ADAPTER_ID) {
    return adapterErr(normalizeError("E_CONFLICT", raw.payload_ref, observedAt));
  }
  if (!isClaudeMode(raw.mode)) {
    return adapterErr(normalizeError("E_UNSUPPORTED", raw.payload_ref, observedAt));
  }
  if (!isClaudeConfigSpace(raw.config_space)) {
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
  const contract = claudeEventContract(raw.host_event);
  if (contract === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  const view = readClaudePayload(input.payload);
  if (view === null) {
    return adapterErr(normalizeError("E_SCHEMA", raw.payload_ref, observedAt));
  }
  return draftFor(raw, view, contract);
}
