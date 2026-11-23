/**
 * OpenCode host-event to canonical-kind mapping (DD-HOST-050, DD-HOST-003).
 *
 * Only the events recorded in the OpenCode install/observation table are
 * declared. Pure observation events (`session.context`, `model.request`,
 * `http.request`, `http.response`, `session.idle`, `session.status`) carry an
 * empty `canonical_kinds` and never produce a `TriggerEvent`.
 *
 * DD-HOST-050 writes the durable compaction family as `session.compaction.*`
 * without enumerating suffixes. The descriptor field `host_event` is an exact
 * string, so only the hook name `session.compaction` can be declared there;
 * `isOpenCodeCompactionEvent` and `openCodeCompactionContract` recognise the
 * family for normalization once host core has admitted a concrete suffix.
 *
 * Durable execution events are server-mode observations (DD-HOST-050); the
 * normalizer rejects them in interactive mode rather than inventing TUI
 * visibility.
 */

import type { CapabilityName, EventContract, NativeMessageKind, TriggerKind, UnknownFact } from "./contract.js";
import { openCodeUnknown, OPENCODE_UNKNOWN_REASON } from "./facts.js";

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

/** Declared OpenCode events, in the order of the DD-HOST-050 mapping table. */
export const OPENCODE_EVENT_CONTRACTS: readonly EventContract[] = Object.freeze([
  contract("session.prompt", "prompt", ["new_input"], ["input_capture", "online_delivery"]),
  contract("tool.execute.before", "event", ["tool_fact"], ["tool_id"]),
  contract("tool.execute.after", "event", ["tool_fact"], ["tool_id"]),
  contract("session.compaction", "event", ["compaction"], ["compaction_event"]),
  // Interactive TUI boundary: the plugin proves the previous turn ended when
  // the user submits the next prompt. The server-only execution reports are
  // not available to an interactive-mode plugin in 2.1.4.
  contract("session.turn.completed", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("session.execution.succeeded", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("session.execution.failed", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("session.execution.interrupted", "event", ["task_boundary_candidate"], ["stable_boundary"]),
  contract("session.context", "event", [], ["request_observation"]),
  contract("model.request", "event", [], ["request_observation"]),
  contract("http.request", "event", [], ["request_observation"]),
  contract("http.response", "event", [], ["request_observation"]),
  contract("session.idle", "event", [], []),
  contract("session.status", "event", [], [])
]);

const EVENT_CONTRACT_BY_NAME: ReadonlyMap<string, EventContract> = new Map(
  OPENCODE_EVENT_CONTRACTS.map((entry) => [entry.host_event, entry] as const)
);

/** Every declared OpenCode host-event name. */
export const OPENCODE_EVENT_NAMES: readonly string[] = Object.freeze(
  OPENCODE_EVENT_CONTRACTS.map((entry) => entry.host_event)
);

/**
 * Pure observation events. They carry `canonical_kinds=[]`, write evidence
 * only and never become a `TriggerEvent` (DD-HOST-003).
 */
export const OPENCODE_OBSERVATION_EVENTS: readonly string[] = Object.freeze([
  "session.context",
  "model.request",
  "http.request",
  "http.response",
  "session.idle",
  "session.status"
]);

/** True for a declared observation event. */
export function isOpenCodeObservationEvent(host_event: string): boolean {
  return OPENCODE_OBSERVATION_EVENTS.includes(host_event);
}

/** Looks up the declared contract; returns `null` for an undeclared event. */
export function openCodeEventContract(host_event: string): EventContract | null {
  return EVENT_CONTRACT_BY_NAME.get(host_event) ?? null;
}

/** Canonical trigger kinds for an event name; empty for observation events. */
export function openCodeCanonicalKinds(host_event: string): readonly TriggerKind[] {
  return openCodeEventContract(host_event)?.canonical_kinds ?? [];
}

/** Required capabilities recorded by the event contract gate. */
export function openCodeRequiredCapabilities(host_event: string): readonly CapabilityName[] {
  return openCodeEventContract(host_event)?.required_capabilities ?? [];
}

/**
 * Prefix of the durable compaction event family. DD-HOST-050 names the family
 * `session.compaction.*` but does not enumerate its suffixes.
 */
export const OPENCODE_DURABLE_COMPACTION_PREFIX = "session.compaction.";

/**
 * True for the compaction hook and every durable `session.compaction.*`
 * member. The descriptor can only declare the hook name exactly; this helper
 * lets normalization treat a concrete durable event the same way.
 */
export function isOpenCodeCompactionEvent(host_event: string): boolean {
  return host_event === "session.compaction" || host_event.startsWith(OPENCODE_DURABLE_COMPACTION_PREFIX);
}

/**
 * Contract for the compaction family. Durable suffixes reuse the hook's
 * contract because DD-HOST-050 maps both to `compaction`.
 */
export function openCodeCompactionContract(host_event: string): EventContract | null {
  return isOpenCodeCompactionEvent(host_event) ? openCodeEventContract("session.compaction") : null;
}

/** Durable execution events are visible in server mode only (DD-HOST-050). */
export const OPENCODE_SERVER_ONLY_EVENTS: readonly string[] = Object.freeze([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted"
]);

/** True when the event may only be normalized in `mode="server"`. */
export function isOpenCodeServerOnlyEvent(host_event: string): boolean {
  return OPENCODE_SERVER_ONLY_EVENTS.includes(host_event);
}

/**
 * OpenCode records no hook timeout and no host total budget (DD-HOST-050);
 * `session.idle` is ephemeral and does not prove that background work ended.
 */
export function openCodeAsyncWorkUnknown(): UnknownFact {
  return openCodeUnknown(OPENCODE_UNKNOWN_REASON.noBackgroundWorkField);
}

/** No observed OpenCode hook payload carries a queue-depth field. */
export function openCodeQueueEmptyUnknown(): UnknownFact {
  return openCodeUnknown(OPENCODE_UNKNOWN_REASON.noQueueField);
}

/** OpenCode does not serialize retry state for boundary events. */
export function openCodeRetryStateUnknown(): UnknownFact {
  return openCodeUnknown(OPENCODE_UNKNOWN_REASON.retryStateNotSerialized);
}

/** The server inbox is not readable from the adapter process without a bridge. */
export function openCodePendingUnknown(): UnknownFact {
  return openCodeUnknown(OPENCODE_UNKNOWN_REASON.pendingInboxNotExposed);
}
