/**
 * FND `SessionScopeReadPort` (DD-FND-071, DD-FND-102).
 *
 * HOST calls `get` before writing a raw-event blob to learn the currently
 * admitted `StableEventScope` for a native session. The port is read-only: it
 * allocates no epoch, writes no ledger row and never trusts a client claim.
 * `event.ingest` re-reads the same projection inside its writer transaction and
 * recomputes `scope_hash`, so this result is a precheck, not an authority.
 */

import type {
  ErrorEnvelope,
  Hash,
  HostId,
  Result,
  SqlRow
} from "@evoplug/core";
import { canonicalHash, makeErrorEnvelope } from "@evoplug/core";
import type { SqliteConnection } from "@evoplug/storage";

export interface StableEventScope {
  readonly schema_version: "rsi.stable_event_scope/1";
  readonly host_id: HostId;
  readonly config_space: string;
  readonly native_session_id: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly scope_hash: Hash;
}

export interface SessionScopeReadInput {
  readonly host_id: HostId;
  readonly config_space: string;
  readonly native_session_id: string;
  readonly deadline_ms: number;
  readonly signal?: AbortSignal;
}

export interface SessionScopeReadPort {
  get(input: SessionScopeReadInput): Promise<Result<StableEventScope | null, ErrorEnvelope>>;
}

export interface SessionScopeReadDeps {
  readonly connection: SqliteConnection;
  readonly now?: () => number;
}

function scopeError(
  code: "E_EVIDENCE_UNKNOWN" | "E_IO" | "E_DEADLINE_EXCEEDED" | "E_CANCELLED",
  stage: string
): ErrorEnvelope {
  const category = code === "E_IO" ? "storage" : code === "E_EVIDENCE_UNKNOWN" ? "source" : "deadline";
  return makeErrorEnvelope({
    code,
    category,
    message_key: `error.${code.toLowerCase()}`,
    stage,
    details: { kind: "none" }
  });
}

interface ScopeRow extends SqlRow {
  readonly task_id: string;
  readonly branch_id: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
}

export function scopeHashFor(scope: Omit<StableEventScope, "scope_hash">): Hash {
  return canonicalHash({
    schema_version: "rsi.stable_event_scope/1",
    host_id: scope.host_id,
    config_space: scope.config_space,
    native_session_id: scope.native_session_id,
    task_id: scope.task_id,
    branch_id: scope.branch_id,
    input_epoch: scope.input_epoch,
    goal_version: scope.goal_version,
    config_version: scope.config_version,
    watermark: scope.watermark
  });
}

export function createSessionScopeReadPort(deps: SessionScopeReadDeps): SessionScopeReadPort {
  return {
    async get(input: SessionScopeReadInput): Promise<Result<StableEventScope | null, ErrorEnvelope>> {
      if (input.signal?.aborted === true) {
        return { ok: false, status: "degraded", error: scopeError("E_CANCELLED", "session_scope_read") };
      }
      if (!Number.isSafeInteger(input.deadline_ms) || input.deadline_ms <= 0) {
        return {
          ok: false,
          status: "degraded",
          error: scopeError("E_DEADLINE_EXCEEDED", "session_scope_read")
        };
      }
      let row: ScopeRow | undefined;
      try {
        row = deps.connection
          .prepare<ScopeRow>(
            `SELECT e.task_id, e.branch_id, e.input_epoch, e.goal_version, e.config_version, e.watermark
               FROM event_log e
               JOIN session s ON s.session_id = e.session_id
              WHERE s.host_id = :host_id
                AND s.config_space = :config_space
                AND s.external_session_id = :native_session_id
                AND e.event_type IN ('input.received','input.retry')
                AND e.task_id IS NOT NULL
                AND e.branch_id IS NOT NULL
                AND e.input_epoch IS NOT NULL
                AND e.goal_version IS NOT NULL
                AND e.config_version IS NOT NULL
              ORDER BY e.watermark DESC
              LIMIT 1`
          )
          .get({
            host_id: input.host_id,
            config_space: input.config_space,
            native_session_id: input.native_session_id
          });
      } catch {
        return { ok: false, status: "rejected", error: scopeError("E_IO", "session_scope_read") };
      }
      if (row === undefined) {
        return { ok: true, status: "ok", value: null };
      }
      const base = {
        schema_version: "rsi.stable_event_scope/1" as const,
        host_id: input.host_id,
        config_space: input.config_space,
        native_session_id: input.native_session_id,
        task_id: String(row.task_id),
        branch_id: String(row.branch_id),
        input_epoch: Number(row.input_epoch),
        goal_version: String(row.goal_version),
        config_version: String(row.config_version),
        watermark: Number(row.watermark)
      };
      return { ok: true, status: "ok", value: { ...base, scope_hash: scopeHashFor(base) } };
    }
  };
}

/** Alias kept so composition roots may use either factory name. */
export function createSessionScopeReadService(deps: SessionScopeReadDeps): SessionScopeReadPort {
  return createSessionScopeReadPort(deps);
}
