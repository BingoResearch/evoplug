/**
 * Host event type vocabulary (DD-FND-070).
 *
 * `EventType` is the closed set of host event kinds a committed
 * `EventEnvelope` may carry. The members are the `kind` discriminants of the
 * `EventPayload` union; an event whose payload kind is outside this set is
 * not a host event.
 *
 * This is a type-only vocabulary plus the runtime guard that rejects unknown
 * members. The guard is the only runtime form of the set: it never accepts a
 * member that the design does not publish.
 */

export type EventType =
  | "input.received" | "input.retry" | "agent.message" | "tool.call" | "tool.result"
  | "host.boundary" | "compaction.observed" | "subagent.started" | "subagent.ended"
  | "delivery.receipt" | "feedback.observed" | "ledger.correction" | "review.requested"
  | "capability.observed" | "config.applied" | "identity.fork" | "identity.resume"
  | "host.unclassified";

/** Every member of {@link EventType}, in the design's declaration order. */
export const EVENT_TYPES: readonly EventType[] = Object.freeze([
  "input.received",
  "input.retry",
  "agent.message",
  "tool.call",
  "tool.result",
  "host.boundary",
  "compaction.observed",
  "subagent.started",
  "subagent.ended",
  "delivery.receipt",
  "feedback.observed",
  "ledger.correction",
  "review.requested",
  "capability.observed",
  "config.applied",
  "identity.fork",
  "identity.resume",
  "host.unclassified"
] as const);

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

/** True when `value` is a member of the closed {@link EventType} set. */
export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}
