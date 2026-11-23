/**
 * OpenHands SDK host-event to canonical-kind mapping (DD-HOST-060,
 * DD-HOST-003, DD-HOST-100).
 *
 * Only the six hook classes recorded in the DD-HOST-060 install/observation
 * table are declared. `SessionStart` is a pure observation event: it carries an
 * empty `canonical_kinds` and never produces a `TriggerEvent`. `Task` and
 * subagent work are synchronous blocking calls, not hooks, so they have no
 * host event name here (DD-HOST-060 "Task/subagent 为同步阻塞，`[]` 证据").
 *
 * `Stop` is a boundary candidate only when the conversation reaches
 * `FINISHED`; the host does not emit the hook for pause, cancel or close, so a
 * missing `Stop` never proves that no pending work exists.
 *
 * `native_kind` is the FND identity closed set (`message`, `turn`, `event`,
 * `prompt`, `other`). The HOST payload vocabulary (`input.received`,
 * `tool.call`, ...) belongs to `payload.kind` and is never used here.
 */

import type { CapabilityName, EventContract, NativeMessageKind, TriggerKind, UnknownFact } from "./contract.js";
import { openhandsUnknown, OPENHANDS_UNKNOWN_REASON } from "./facts.js";

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

/** Declared OpenHands events, in the order of the DD-HOST-060 mapping table. */
export const OPENHANDS_EVENT_CONTRACTS: readonly EventContract[] = Object.freeze([
  contract("UserPromptSubmit", "prompt", ["new_input"], ["input_capture", "online_delivery"]),
  contract("PreToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("PostToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("Stop", "other", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("SessionStart", "event", [], []),
  contract("SessionEnd", "other", ["session_end"], ["stable_boundary"])
]);

const EVENT_CONTRACT_BY_NAME: ReadonlyMap<string, EventContract> = new Map(
  OPENHANDS_EVENT_CONTRACTS.map((entry) => [entry.host_event, entry] as const)
);

/** Every declared OpenHands host-event name. */
export const OPENHANDS_EVENT_NAMES: readonly string[] = Object.freeze(
  OPENHANDS_EVENT_CONTRACTS.map((entry) => entry.host_event)
);

/**
 * Pure observation events. They carry `canonical_kinds=[]`, write evidence only
 * and never become a `TriggerEvent` (DD-HOST-003).
 */
export const OPENHANDS_OBSERVATION_EVENTS: readonly string[] = Object.freeze(["SessionStart"]);

/** True for a declared observation event. */
export function isOpenhandsObservationEvent(host_event: string): boolean {
  return OPENHANDS_OBSERVATION_EVENTS.includes(host_event);
}

/** Looks up the declared contract; returns `null` for an undeclared event. */
export function openhandsEventContract(host_event: string): EventContract | null {
  return EVENT_CONTRACT_BY_NAME.get(host_event) ?? null;
}

/** Canonical trigger kinds for an event name; empty for observation events. */
export function openhandsCanonicalKinds(host_event: string): readonly TriggerKind[] {
  return openhandsEventContract(host_event)?.canonical_kinds ?? [];
}

/** Required capabilities recorded by the event contract gate. */
export function openhandsRequiredCapabilities(host_event: string): readonly CapabilityName[] {
  return openhandsEventContract(host_event)?.required_capabilities ?? [];
}

/**
 * OpenHands exposes no background-work field on the conversation hooks.
 * `TaskManager` blocks synchronously and there is no subagent hook.
 */
export function openhandsAsyncWorkUnknown(): UnknownFact {
  return openhandsUnknown(OPENHANDS_UNKNOWN_REASON.noBackgroundWorkField);
}

/** OpenHands exposes no queue-depth field on the observed hook payloads. */
export function openhandsQueueEmptyUnknown(): UnknownFact {
  return openhandsUnknown(OPENHANDS_UNKNOWN_REASON.noQueueField);
}

/** OpenHands does not serialize retry state for boundary events. */
export function openhandsRetryStateUnknown(): UnknownFact {
  return openhandsUnknown(OPENHANDS_UNKNOWN_REASON.retryStateNotSerialized);
}

/** `UserPromptSubmit` carries no origin field, so an automatic turn cannot be excluded. */
export function openhandsInputOriginUnknown(): UnknownFact {
  return openhandsUnknown(OPENHANDS_UNKNOWN_REASON.inputOriginAbsent);
}

/** Non-input hooks do not serialize whether the turn was automatic. */
export function openhandsAutoTurnUnknown(): UnknownFact {
  return openhandsUnknown(OPENHANDS_UNKNOWN_REASON.autoTurnNotSerialized);
}

/** The hook `message_id` points at E0; the persisted event is a new E1 id. */
export function openhandsMessageIdUnknown(): UnknownFact {
  return openhandsUnknown(OPENHANDS_UNKNOWN_REASON.messageIdNotPreserved);
}
