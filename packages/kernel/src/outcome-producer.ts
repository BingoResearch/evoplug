/**
 * TaskOutcome producer (design §6.2, G5).
 *
 * A committed `host.boundary` event is the only trigger. When the host reports
 * no pending work and the boundary is a stop/agent_end/session_end, the ledger
 * evaluates the task outcome: `succeeded` only when independent success
 * evidence covers every active requirement, `ended_unverified` otherwise. A
 * boundary that still claims pending work leaves the outcome `active`, so a
 * review never starts from a half-finished turn.
 */

import type { ErrorEnvelope, Id, Result, VersionBinding } from "@evoplug/core";
import { OutcomeService, type LedgerPorts } from "@evoplug/ledger";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import type { CommittedHostEvent } from "./online-pipeline.js";
import { isKernelProbeNativeSession } from "./probe-session.js";

export interface OutcomeIntakeDeps {
  readonly connection: SqliteConnection;
  readonly ledger: LedgerPorts;
  readonly now: () => number;
  readonly on_error?: (error: ErrorEnvelope) => void;
  readonly on_evaluated?: (info: {
    readonly event_type: string;
    readonly boundary: boolean;
    readonly pending_tool: boolean;
  }) => void;
}

export interface OutcomeIntake {
  onCommitted(event: CommittedHostEvent): Promise<void>;
  /**
   * Evaluates the outcome at an explicit binding. Session-end flush uses this
   * after a resume advanced the input epoch without a new host boundary, so a
   * stale outcome revision cannot block the review.
   */
  evaluateAt(
    binding: VersionBinding,
    boundary_event_id: Id<"ev">
  ): Promise<Result<unknown, ErrorEnvelope>>;
  drain(): Promise<void>;
}

const BOUNDARIES = new Set(["stop", "agent_end", "session_end"]);
const BOUNDARY_NATIVE_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "session_stop",
  "session_shutdown",
  "stop",
  "session_end",
  // Claude Code and Codex spell the same host events in camel case.
  "Stop",
  "SessionEnd",
  // OpenCode interactive mode has no execution report; the adapter proves the
  // previous turn ended when the next prompt arrives.
  "session.turn.completed"
]);

/**
 * True when a committed payload is an outcome boundary. A boundary whose
 * async/queue facts are unknown is committed as `host.unclassified` by the
 * payload mapper; the native hook still names a real boundary, and the runtime
 * stream itself proves whether a tool result is outstanding, so those events
 * are evaluated too instead of being dropped forever.
 */
export function isOutcomeBoundary(payload: unknown, hostEvent?: string): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record["kind"] === "host.boundary") {
    return (
      typeof record["boundary"] === "string" &&
      BOUNDARIES.has(record["boundary"]) &&
      record["pending_work_claimed"] !== true
    );
  }
  return (
    record["kind"] === "host.unclassified" &&
    typeof hostEvent === "string" &&
    BOUNDARY_NATIVE_TYPES.has(hostEvent)
  );
}

/** A committed tool call without its result keeps the task `active`. */
function hasPendingTool(connection: SqliteConnection, branchId: string): boolean {
  const row = connection
    .prepare<SqlRow>(
      `SELECT
         SUM(CASE WHEN event_type = 'tool.call' THEN 1 ELSE 0 END) AS calls,
         SUM(CASE WHEN event_type = 'tool.result' THEN 1 ELSE 0 END) AS results
       FROM event_log WHERE branch_id = :branch_id`
    )
    .get({ branch_id: branchId });
  const calls = Number(row?.["calls"] ?? 0);
  const results = Number(row?.["results"] ?? 0);
  return calls > results;
}

export function createOutcomeIntake(deps: OutcomeIntakeDeps): OutcomeIntake {
  const service = new OutcomeService(deps.ledger);
  const pending = new Set<Promise<void>>();

  async function evaluate(event: CommittedHostEvent): Promise<Result<unknown, ErrorEnvelope> | null> {
    // Appendix H.3: a kernel probe session never creates a TaskOutcome.
    if (isKernelProbeNativeSession(deps.connection, event.draft.native_session_id)) {
      return null;
    }
    const boundary = isOutcomeBoundary(event.draft.payload, event.draft.host_event);
    const binding: VersionBinding = event.binding;
    const pendingTool = hasPendingTool(deps.connection, binding.branch_id);
    try {
      deps.on_evaluated?.({
        event_type: event.draft.payload.kind,
        boundary,
        pending_tool: pendingTool
      });
    } catch {
      // Diagnostic only.
    }
    if (!boundary) return null;
    if (pendingTool) return null;
    return await service.evaluateTaskOutcome({
      binding,
      boundary_event_id: event.receipt.event_id as Id<"ev">,
      explicit_lifecycle_event: null,
      pending_work: [],
      external_blockers: []
    });
  }

  function onCommitted(event: CommittedHostEvent): Promise<void> {
    const work = evaluate(event)
      .then((result) => {
        if (result !== null && !result.ok) deps.on_error?.(result.error);
      })
      .catch(() => undefined)
      .finally(() => {
        pending.delete(work);
      });
    pending.add(work);
    return work;
  }

  async function evaluateAt(
    binding: VersionBinding,
    boundary_event_id: Id<"ev">
  ): Promise<Result<unknown, ErrorEnvelope>> {
    return await service.evaluateTaskOutcome({
      binding,
      boundary_event_id,
      explicit_lifecycle_event: null,
      pending_work: [],
      external_blockers: []
    });
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  return { onCommitted, evaluateAt, drain };
}
