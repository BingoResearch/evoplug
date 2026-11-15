/**
 * Codex host-event to canonical-kind mapping (DD-HOST-040, DD-HOST-003).
 *
 * Only the events recorded in the Codex install/observation table are declared.
 * Pure observation events (`Interrupt`, `SubagentStart/Stop`,
 * `PreModelRequest/PostModelRequest`, `PermissionRequest`, `SessionStart`)
 * carry an empty `canonical_kinds` and never produce a `TriggerEvent`.
 *
 * `Stop` is a boundary candidate. Codex can return a continuation after
 * `Stop`, so the normalizer carries `retry_pending=unknown`; the trigger policy
 * decides, the adapter never does.
 */

import type { CapabilityName, EventContract, NativeMessageKind, TriggerKind, UnknownFact } from "./contract.js";
import { codexUnknown, CODEX_UNKNOWN_REASON } from "./facts.js";

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
 * Declared Codex events, in the order of DD-HOST-040's mapping line.
 *
 * `PreCompact`/`PostCompact` do not carry a summary (DD-HOST-100); they are
 * still compaction observations and never yield a review trigger.
 */
export const CODEX_EVENT_CONTRACTS: readonly EventContract[] = Object.freeze([
  contract("UserPromptSubmit", "prompt", ["new_input"], ["input_capture", "online_delivery"]),
  contract("PreToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("PostToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("Stop", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("SessionEnd", "event", ["session_end"], ["stable_boundary"]),
  contract("PreCompact", "event", ["compaction"], ["compaction_event"]),
  contract("PostCompact", "event", ["compaction"], ["compaction_event"]),
  contract("Interrupt", "event", [], []),
  contract("SubagentStart", "event", [], []),
  contract("SubagentStop", "event", [], []),
  contract("PreModelRequest", "event", [], ["request_observation"]),
  contract("PostModelRequest", "event", [], ["request_observation"]),
  contract("PermissionRequest", "event", [], []),
  contract("SessionStart", "event", [], [])
]);

const EVENT_CONTRACT_BY_NAME: ReadonlyMap<string, EventContract> = new Map(
  CODEX_EVENT_CONTRACTS.map((entry) => [entry.host_event, entry] as const)
);

/** Every declared Codex host-event name. */
export const CODEX_EVENT_NAMES: readonly string[] = Object.freeze(
  CODEX_EVENT_CONTRACTS.map((entry) => entry.host_event)
);

/**
 * Pure observation events. They carry `canonical_kinds=[]`, write evidence
 * only and never become a `TriggerEvent` (DD-HOST-003).
 */
export const CODEX_OBSERVATION_EVENTS: readonly string[] = Object.freeze([
  "Interrupt",
  "PermissionRequest",
  "PostModelRequest",
  "PreModelRequest",
  "SessionStart",
  "SubagentStart",
  "SubagentStop"
]);

/** True for a declared observation event. */
export function isCodexObservationEvent(host_event: string): boolean {
  return CODEX_OBSERVATION_EVENTS.includes(host_event);
}

/** Looks up the declared contract; returns `null` for an undeclared event. */
export function codexEventContract(host_event: string): EventContract | null {
  return EVENT_CONTRACT_BY_NAME.get(host_event) ?? null;
}

/** Canonical trigger kinds for an event name; empty for observation events. */
export function codexCanonicalKinds(host_event: string): readonly TriggerKind[] {
  return codexEventContract(host_event)?.canonical_kinds ?? [];
}

/** Required capabilities recorded by the event contract gate. */
export function codexRequiredCapabilities(host_event: string): readonly CapabilityName[] {
  return codexEventContract(host_event)?.required_capabilities ?? [];
}

/** Codex does not serialize background work on any observed hook payload. */
export function codexAsyncWorkUnknown(): UnknownFact {
  return codexUnknown(CODEX_UNKNOWN_REASON.noBackgroundWorkField);
}

/** Codex exposes no queue-depth field on any observed hook payload. */
export function codexQueueEmptyUnknown(): UnknownFact {
  return codexUnknown(CODEX_UNKNOWN_REASON.noQueueField);
}

/** Codex does not serialize retry/continuation state for boundary events. */
export function codexRetryStateUnknown(): UnknownFact {
  return codexUnknown(CODEX_UNKNOWN_REASON.retryStateNotSerialized);
}

/** app-server durable `thread/inject_items` semantics are unverified. */
export function codexAppServerDurableUnknown(): UnknownFact {
  return codexUnknown(CODEX_UNKNOWN_REASON.appServerDurableUnknown);
}
