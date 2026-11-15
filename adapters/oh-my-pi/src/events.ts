/**
 * Oh My Pi host-event to canonical-kind mapping (DD-HOST-020, DD-HOST-003).
 *
 * Only the events recorded in the OMP install/observation table are declared.
 * Pure observation events (`context`, provider hooks) carry an empty
 * `canonical_kinds` and never produce a `TriggerEvent`.
 *
 * `agent_end` is a boundary candidate only when the payload carries
 * `willContinue=false`; the contract declares the static candidate and the
 * normalizer carries `willContinue` in `retry_pending`, so the trigger policy
 * can refuse a continuing turn without a second event.
 *
 * `native_kind` is the FND identity closed set (`message`, `turn`, `event`,
 * `prompt`, `other`). Prompt and retry both use `prompt`; every other OMP hook
 * is a generic `event`. The HOST payload vocabulary (`input.received`,
 * `host.boundary`, ...) belongs to `payload.kind` and is never used here.
 */

import type { CapabilityName, EventContract, NativeMessageKind, TriggerKind, UnknownFact } from "./contract.js";
import { ompUnknown, OMP_UNKNOWN_REASON } from "./facts.js";

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

/** Declared OMP events, in the order of the DD-HOST-020 mapping table. */
export const OMP_EVENT_CONTRACTS: readonly EventContract[] = Object.freeze([
  contract("input", "prompt", ["new_input"], ["input_capture", "online_delivery"]),
  contract("before_agent_start", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("tool_call", "event", ["tool_fact"], ["tool_id"]),
  contract("tool_result", "event", ["tool_fact"], ["tool_id"]),
  contract("session_stop", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("agent_end", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("agent_settled", "event", ["task_stable"], ["stable_boundary"]),
  contract("session_shutdown", "event", ["session_end"], ["stable_boundary"]),
  contract("context", "event", [], ["request_observation"]),
  contract("before_provider_request", "event", [], ["request_observation"])
]);

const EVENT_CONTRACT_BY_NAME: ReadonlyMap<string, EventContract> = new Map(
  OMP_EVENT_CONTRACTS.map((entry) => [entry.host_event, entry] as const)
);

/** Every declared OMP host-event name. */
export const OMP_EVENT_NAMES: readonly string[] = Object.freeze(OMP_EVENT_CONTRACTS.map((entry) => entry.host_event));

/**
 * Pure observation events. They carry `canonical_kinds=[]`, write evidence
 * only and never become a `TriggerEvent` (DD-HOST-003).
 */
export const OMP_OBSERVATION_EVENTS: readonly string[] = Object.freeze(["context", "before_provider_request"]);

/** True for a declared observation event. */
export function isOmpObservationEvent(host_event: string): boolean {
  return OMP_OBSERVATION_EVENTS.includes(host_event);
}

/** Looks up the declared contract; returns `null` for an undeclared event. */
export function ompEventContract(host_event: string): EventContract | null {
  return EVENT_CONTRACT_BY_NAME.get(host_event) ?? null;
}

/** Canonical trigger kinds for an event name; empty for observation events. */
export function ompCanonicalKinds(host_event: string): readonly TriggerKind[] {
  return ompEventContract(host_event)?.canonical_kinds ?? [];
}

/** Required capabilities recorded by the event contract gate. */
export function ompRequiredCapabilities(host_event: string): readonly CapabilityName[] {
  return ompEventContract(host_event)?.required_capabilities ?? [];
}

/**
 * OMP has no `awaitingAsyncWork` field and `agent_settled` was not observed in
 * 18.12.3. Missing fields stay unknown; they are never reported as `false`.
 */
export function ompAsyncWorkUnknown(): UnknownFact {
  return ompUnknown(OMP_UNKNOWN_REASON.noBackgroundWorkField);
}

/** OMP exposes no queue-depth field on any observed hook payload. */
export function ompQueueEmptyUnknown(): UnknownFact {
  return ompUnknown(OMP_UNKNOWN_REASON.noQueueField);
}

/** OMP does not serialize retry state for boundary events. */
export function ompRetryStateUnknown(): UnknownFact {
  return ompUnknown(OMP_UNKNOWN_REASON.retryStateNotSerialized);
}

/** `agent_end.willContinue` is an unserialized state when the field is absent. */
export function ompWillContinueUnknown(): UnknownFact {
  return ompUnknown(OMP_UNKNOWN_REASON.agentEndWillContinueAbsent);
}
