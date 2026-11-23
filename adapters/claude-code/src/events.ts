/**
 * Claude Code host-event to canonical-kind mapping (DD-HOST-070, DD-HOST-003,
 * DD-HOST-100).
 *
 * Only the events enumerated in the DD-HOST-070 mapping line are declared.
 * The host documents 33 classic hook events; the design records this subset as
 * the observed/mapped surface, so the remaining names stay unmapped and are
 * never guessed here. Pure observation events (`SessionStart`,
 * `SubagentStart/Stop`, `TaskCreated/Completed`, `PostModelSwitch`,
 * `ConfigChange`) carry `canonical_kinds=[]`, write evidence only and never
 * produce a `TriggerEvent`.
 *
 * `UserPromptSubmit` is also emitted for automatic turns (scheduled tasks,
 * `/loop`, background subagent reports, cross-session messages). The payload
 * has no source field, so origin stays `unknown` (DD-HOST-100) and the trigger
 * policy — not the adapter — decides what may be reviewed.
 */

import type { CapabilityName, EventContract, NativeMessageKind, TriggerKind, UnknownFact } from "./contract.js";
import { claudeUnknown, CLAUDE_UNKNOWN_REASON } from "./facts.js";

function contract(
  host_event: string,
  native_kind: NativeMessageKind,
  canonical_kinds: readonly TriggerKind[],
  required_capabilities: readonly CapabilityName[]
): EventContract {
  return Object.freeze({
    host_event,
    native_kind,
    canonical_kinds: Object.freeze([...canonical_kinds]),
    required_capabilities: Object.freeze([...required_capabilities])
  });
}

/**
 * Declared Claude Code events, in the order of DD-HOST-070's mapping line.
 *
 * `UserPromptExpansion` is a second input entry point and maps to `new_input`
 * exactly like `UserPromptSubmit`. `PostToolBatch` is still a `tool_fact`; the
 * normalizer requires a call id from the batch payload or native ids.
 */
export const CLAUDE_EVENT_CONTRACTS: readonly EventContract[] = Object.freeze([
  contract("UserPromptSubmit", "prompt", ["new_input"], ["input_capture", "online_delivery"]),
  contract("UserPromptExpansion", "prompt", ["new_input"], ["input_capture"]),
  contract("PreToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("PostToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("PostToolBatch", "event", ["tool_fact"], ["tool_id"]),
  contract("Stop", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("StopFailure", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("SessionEnd", "event", ["session_end"], ["stable_boundary"]),
  contract("PreCompact", "event", ["compaction"], ["compaction_event"]),
  contract("PostCompact", "event", ["compaction"], ["compaction_event"]),
  contract("SessionStart", "event", [], []),
  contract("SubagentStart", "event", [], []),
  contract("SubagentStop", "event", [], []),
  contract("TaskCreated", "event", [], []),
  contract("TaskCompleted", "event", [], []),
  contract("PostModelSwitch", "event", [], []),
  contract("ConfigChange", "event", [], [])
]);

/** Number of classic hook events documented for the 2.1.304 surface. */
export const CLAUDE_OFFICIAL_CLASSIC_EVENT_COUNT: number = 33;

const EVENT_CONTRACT_BY_NAME: ReadonlyMap<string, EventContract> = new Map(
  CLAUDE_EVENT_CONTRACTS.map((entry) => [entry.host_event, entry] as const)
);

/** Every declared Claude Code host-event name. */
export const CLAUDE_EVENT_NAMES: readonly string[] = Object.freeze(
  CLAUDE_EVENT_CONTRACTS.map((entry) => entry.host_event)
);

/**
 * Pure observation events. They carry `canonical_kinds=[]`, write evidence
 * only and never become a `TriggerEvent` (DD-HOST-003).
 */
export const CLAUDE_OBSERVATION_EVENTS: readonly string[] = Object.freeze([
  "ConfigChange",
  "PostModelSwitch",
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "TaskCompleted",
  "TaskCreated"
]);

/** True for a declared observation event. */
export function isClaudeObservationEvent(host_event: string): boolean {
  return CLAUDE_OBSERVATION_EVENTS.includes(host_event);
}

/** Looks up the declared contract; returns `null` for an undeclared event. */
export function claudeEventContract(host_event: string): EventContract | null {
  return EVENT_CONTRACT_BY_NAME.get(host_event) ?? null;
}

/** Canonical trigger kinds for an event name; empty for observation events. */
export function claudeCanonicalKinds(host_event: string): readonly TriggerKind[] {
  return claudeEventContract(host_event)?.canonical_kinds ?? [];
}

/** Required capabilities recorded by the event contract gate. */
export function claudeRequiredCapabilities(host_event: string): readonly CapabilityName[] {
  return claudeEventContract(host_event)?.required_capabilities ?? [];
}

/** `Stop`/`StopFailure` carry no serialized retry/continuation flag. */
export function claudeRetryStateUnknown(): UnknownFact {
  return claudeUnknown(CLAUDE_UNKNOWN_REASON.retryStateNotSerialized);
}

/** Claude exposes no queue-depth field on any observed hook payload. */
export function claudeQueueEmptyUnknown(): UnknownFact {
  return claudeUnknown(CLAUDE_UNKNOWN_REASON.queueDepthNotSerialized);
}

/** Background-task and cron semantics are exposed but not verified. */
export function claudeBackgroundSemanticsUnknown(): UnknownFact {
  return claudeUnknown(CLAUDE_UNKNOWN_REASON.backgroundSemanticsUnverified);
}

/** Pending state cannot be cleared from an empty `Stop` field. */
export function claudePendingSemanticsUnknown(): UnknownFact {
  return claudeUnknown(CLAUDE_UNKNOWN_REASON.pendingSemanticsUnverified);
}

/** `PostCompact` carries a summary but a hook cannot read or rewrite it. */
export function claudeCompactionSummaryUnknown(): UnknownFact {
  return claudeUnknown(CLAUDE_UNKNOWN_REASON.compactionSummaryNotRewriteable);
}

/** No host-side load readback is available for the hook graph. */
export function claudeLoadReadbackUnknown(): UnknownFact {
  return claudeUnknown(CLAUDE_UNKNOWN_REASON.loadReadbackUnavailable);
}
