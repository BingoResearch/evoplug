/**
 * Pi host-event to canonical-kind mapping (DD-HOST-010, DD-HOST-003).
 *
 * Only the events recorded in the Pi install/observation table are declared.
 * Pure observation events (`context`, provider hooks, `session_start`) carry an
 * empty `canonical_kinds` and never produce a `TriggerEvent`.
 *
 * `agent_end` is a boundary candidate only when the payload carries
 * `willRetry=false`; the contract declares the static candidate and the
 * normalizer applies the condition.
 */

import type {
  CapabilityName,
  EventContract,
  NativeMessageKind,
  TriggerKind,
  UnknownFact
} from "./contract.js";
import { piUnknown, PI_UNKNOWN_REASON } from "./facts.js";

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

/** Declared Pi events, in the order of the design's mapping table. */
export const PI_EVENT_CONTRACTS: readonly EventContract[] = Object.freeze([
  contract("input", "prompt", ["new_input"], ["input_capture", "online_delivery"]),
  contract("before_agent_start", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("tool_call", "event", ["tool_fact"], ["tool_id"]),
  contract("tool_result", "event", ["tool_fact"], ["tool_id"]),
  contract("session_before_compact", "event", ["compaction"], ["compaction_event"]),
  contract("session_compaction", "event", ["compaction"], ["compaction_event"]),
  contract("agent_end", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("agent_settled", "event", ["task_stable"], ["stable_boundary"]),
  contract("session_shutdown", "event", ["session_end"], ["stable_boundary"]),
  contract("context", "event", [], ["request_observation"]),
  contract("before_provider_request", "event", [], ["request_observation"]),
  contract("session_start", "event", [], [])
]);

const EVENT_CONTRACT_BY_NAME: ReadonlyMap<string, EventContract> = new Map(
  PI_EVENT_CONTRACTS.map((entry) => [entry.host_event, entry] as const)
);

/** Every declared Pi host-event name. */
export const PI_EVENT_NAMES: readonly string[] = Object.freeze(PI_EVENT_CONTRACTS.map((entry) => entry.host_event));

/**
 * Pure observation events. They carry `canonical_kinds=[]`, write evidence
 * only and never become a `TriggerEvent` (DD-HOST-003).
 */
export const PI_OBSERVATION_EVENTS: readonly string[] = Object.freeze([
  "context",
  "before_provider_request",
  "session_start"
]);

/** True for a declared observation event. */
export function isPiObservationEvent(host_event: string): boolean {
  return PI_OBSERVATION_EVENTS.includes(host_event);
}

/** Looks up the declared contract; returns `null` for an undeclared event. */
export function piEventContract(host_event: string): EventContract | null {
  return EVENT_CONTRACT_BY_NAME.get(host_event) ?? null;
}

/** Canonical trigger kinds for an event name; empty for observation events. */
export function piCanonicalKinds(host_event: string): readonly TriggerKind[] {
  return piEventContract(host_event)?.canonical_kinds ?? [];
}

/** Required capabilities recorded by the event contract gate. */
export function piRequiredCapabilities(host_event: string): readonly CapabilityName[] {
  return piEventContract(host_event)?.required_capabilities ?? [];
}

/**
 * Pi has no native async-work field. `agent_settled` proves only that the host
 * loop settled; it does not prove that external background work finished.
 */
export function piAsyncWorkUnknown(): UnknownFact {
  return piUnknown(PI_UNKNOWN_REASON.noBackgroundWorkField);
}

/** Pi has no queue-depth field on any observed hook payload. */
export function piQueueEmptyUnknown(): UnknownFact {
  return piUnknown(PI_UNKNOWN_REASON.noQueueField);
}

/** Pi does not serialize retry state for boundary events. */
export function piRetryStateUnknown(): UnknownFact {
  return piUnknown(PI_UNKNOWN_REASON.retryStateNotSerialized);
}
