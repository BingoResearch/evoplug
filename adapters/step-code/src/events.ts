/**
 * Step Code host-event to canonical-kind mapping (DD-HOST-030, DD-HOST-003,
 * DD-HOST-100).
 *
 * Only the events recorded in the Step Code install/observation table are
 * declared. The extension surface and the `sdk_stdio` surface are separate
 * bindings (DD-HOST-100 "Step stdio 分界"): the stdio names are declared here
 * because the descriptor is one table per adapter package, but they are marked
 * so the adapter can refuse to apply extension injection semantics to them.
 *
 * Pure observation events (`context`, lane/cron notifications) carry an empty
 * `canonical_kinds` and never produce a `TriggerEvent`. Lane/cron notification
 * only proves that the lane or cron finished; it does not prove that the main
 * agent settled.
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
import { stepUnknown, STEP_UNKNOWN_REASON } from "./facts.js";

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

/** Declared Step Code events, in the order of the design's mapping table. */
export const STEP_EVENT_CONTRACTS: readonly EventContract[] = Object.freeze([
  contract("input", "prompt", ["new_input"], ["input_capture", "online_delivery"]),
  contract("before_agent_start", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("tool_call", "event", ["tool_fact"], ["tool_id"]),
  contract("tool_result", "event", ["tool_fact"], ["tool_id"]),
  contract("compaction", "event", ["compaction"], ["compaction_event"]),
  contract("agent_end", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("agent_settled", "event", ["task_stable"], ["stable_boundary"]),
  contract("lane", "event", [], []),
  contract("cron", "event", [], []),
  contract("session_shutdown", "event", ["session_end"], ["stable_boundary"]),
  contract("context", "event", [], ["request_observation"]),
  contract("UserPromptSubmit", "prompt", ["new_input"], ["input_capture"]),
  contract("PreToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("PostToolUse", "event", ["tool_fact"], ["tool_id"]),
  contract("Stop", "event", ["task_boundary_candidate"], ["stable_boundary"])
]);

const EVENT_CONTRACT_BY_NAME: ReadonlyMap<string, EventContract> = new Map(
  STEP_EVENT_CONTRACTS.map((entry) => [entry.host_event, entry] as const)
);

/** Every declared Step Code host-event name. */
export const STEP_EVENT_NAMES: readonly string[] = Object.freeze(
  STEP_EVENT_CONTRACTS.map((entry) => entry.host_event)
);

/**
 * Pure observation events. They carry `canonical_kinds=[]`, write evidence
 * only and never become a `TriggerEvent` (DD-HOST-003).
 */
export const STEP_OBSERVATION_EVENTS: readonly string[] = Object.freeze(["context", "cron", "lane"]);

/**
 * Events of the `sdk_stdio` surface. DD-HOST-100 fixes the set to
 * `UserPromptSubmit/PreToolUse/PostToolUse/Stop`; extension-only events
 * (`input`, `before_agent_start`, `context`, `compaction`, ...) do not apply.
 */
export const STEP_STDIO_EVENTS: readonly string[] = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop"
]);

/** Extension-surface events, i.e. every declared event outside `sdk_stdio`. */
export const STEP_EXTENSION_EVENTS: readonly string[] = Object.freeze(
  STEP_EVENT_NAMES.filter((name) => !STEP_STDIO_EVENTS.includes(name))
);

/** True for a declared observation event. */
export function isStepObservationEvent(host_event: string): boolean {
  return STEP_OBSERVATION_EVENTS.includes(host_event);
}

/** True for an event of the `sdk_stdio` surface. */
export function isStepStdioEvent(host_event: string): boolean {
  return STEP_STDIO_EVENTS.includes(host_event);
}

/** Looks up the declared contract; returns `null` for an undeclared event. */
export function stepEventContract(host_event: string): EventContract | null {
  return EVENT_CONTRACT_BY_NAME.get(host_event) ?? null;
}

/** Canonical trigger kinds for an event name; empty for observation events. */
export function stepCanonicalKinds(host_event: string): readonly TriggerKind[] {
  return stepEventContract(host_event)?.canonical_kinds ?? [];
}

/** Required capabilities recorded by the event contract gate. */
export function stepRequiredCapabilities(host_event: string): readonly CapabilityName[] {
  return stepEventContract(host_event)?.required_capabilities ?? [];
}

/**
 * Step Code exposes no native async-work field. Lane/cron notification wakes
 * the agent but is not proof that the main agent settled.
 */
export function stepAsyncWorkUnknown(): UnknownFact {
  return stepUnknown(STEP_UNKNOWN_REASON.noBackgroundWorkField);
}

/** Step Code exposes no queue-depth field on the observed hook payloads. */
export function stepQueueEmptyUnknown(): UnknownFact {
  return stepUnknown(STEP_UNKNOWN_REASON.noQueueField);
}

/** Step Code does not serialize retry state for boundary events. */
export function stepRetryStateUnknown(): UnknownFact {
  return stepUnknown(STEP_UNKNOWN_REASON.retryStateNotSerialized);
}

/** `input` carries no origin field, so an automatic turn cannot be excluded. */
export function stepInputOriginUnknown(): UnknownFact {
  return stepUnknown(STEP_UNKNOWN_REASON.inputOriginAbsent);
}
