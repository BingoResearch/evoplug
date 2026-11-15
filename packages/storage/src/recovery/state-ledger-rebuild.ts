/**
 * Journal-only rebuild of the seven state ledgers (DD-FND-060 stage 4,
 * DD-FND-097).
 *
 * `delivery`, `replay_plan`/`replay_approval`/`replay_execution`,
 * `egress_approval`, `ipc_idempotency` and `rate_limit_state` are rebuilt
 * from the frozen `row_json` of the committed ledger frames. The rebuild is
 * history, not a second admission: it never re-reads a live goal or config
 * version, never re-grants an authorization, never re-runs a business CAS and
 * never sends an external request.
 *
 * Each frame is validated against the registered row schema and the frozen
 * `after_hash`. An entity that already carries the same `after_hash` is an
 * idempotent replay and is skipped; an entity that carries a different
 * `after_hash` for the same event id, or a second event that contradicts the
 * projected row, is a divergence.
 *
 * `delivery_history` is rebuilt in a second pass, after every delivery row
 * exists. The transition frames carry the frozen history row; create frames
 * from older journals are recovered from the insert row image. A transition
 * frame without the frozen history is a divergence: the final delivery row
 * cannot identify which axis changed.
 */

import { canonicalHash, canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Hash, JsonValue } from "@evoplug/core";

import { storageError, internalDetails, fieldDetails } from "../errors.js";
import type { StatementSource } from "../types.js";
import { payloadEvents } from "../journal/payload.js";
import type { JournalFrameRecord } from "../journal/reader.js";
import { projectDeliveryHistoryEvent } from "./delivery-history-projection.js";

/** The seven state ledgers and the ledger events that project into them. */
export const STATE_LEDGER_TABLES: readonly string[] = [
  "delivery",
  "replay_plan",
  "replay_approval",
  "replay_execution",
  "egress_approval",
  "ipc_idempotency",
  "rate_limit_state"
];

interface LedgerProjection {
  readonly entity_type: string;
  readonly table: string;
  readonly primary_key: readonly string[];
  readonly event_types: readonly string[];
  /** Frozen row schemas produced for this ledger by the real writers. */
  readonly row_schemas: readonly string[];
}

const LEDGER_PROJECTIONS: readonly LedgerProjection[] = [
  {
    entity_type: "delivery",
    table: "delivery",
    primary_key: ["delivery_id"],
    event_types: ["delivery.recorded"],
    row_schemas: ["rsi.delivery_row/1"]
  },
  {
    entity_type: "replay_plan",
    table: "replay_plan",
    primary_key: ["replay_plan_id"],
    event_types: ["replay.plan_recorded", "replay.plan_transition"],
    row_schemas: ["rsi.replay_plan_row/1"]
  },
  {
    entity_type: "replay_approval",
    table: "replay_approval",
    primary_key: ["approval_id"],
    event_types: ["replay.approval_recorded", "replay.approval_transition"],
    row_schemas: ["rsi.replay_approval_row/1"]
  },
  {
    entity_type: "replay_execution",
    table: "replay_execution",
    primary_key: ["execution_id"],
    event_types: ["replay.execution_recorded", "replay.execution_transition"],
    row_schemas: ["rsi.replay_execution_row/1"]
  },
  {
    entity_type: "egress_approval",
    table: "egress_approval",
    primary_key: ["approval_id"],
    event_types: ["egress.approval_recorded", "egress.approval_transition"],
    row_schemas: ["rsi.egress_approval_row/1"]
  },
  {
    entity_type: "ipc_idempotency",
    table: "ipc_idempotency",
    primary_key: ["client_id", "method", "idempotency_key"],
    event_types: ["ipc_idempotency.started", "ipc_idempotency.finished", "ipc_idempotency.uncertain"],
    row_schemas: ["rsi.ipc_idempotency_row/1"]
  },
  {
    entity_type: "rate_limit_state",
    table: "rate_limit_state",
    primary_key: ["scope_key"],
    event_types: ["rate_limit.updated", "rate_limit.cleared"],
    row_schemas: ["rsi.rate_limit_state_row/1"]
  }
];

export interface StateLedgerRebuildReport {
  readonly projected_rows: number;
  readonly skipped_replays: number;
  /** `delivery_history` rows appended after the delivery rows are rebuilt. */
  readonly projected_delivery_history_rows: number;
}

export interface StateLedgerRebuildOptions {
  readonly source: StatementSource;
  readonly frames: readonly JournalFrameRecord[];
  readonly now: number;
}

function divergence(detail: string): ErrorEnvelope {
  return storageError({
    code: "E_REBUILD_DIVERGENCE",
    stage: "storage.state_ledger_rebuild",
    details: internalDetails(detail),
    message_key: "error.storage.rebuild_divergence"
  });
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds the seven state ledgers from the committed frames.
 *
 * The frames must already be in commit_seq order; the caller is the recovery
 * loop, which scans them in that order.
 */
export function rebuildStateLedgers(
  options: StateLedgerRebuildOptions
): { ok: true; value: StateLedgerRebuildReport } | { ok: false; error: ErrorEnvelope } {
  let projectedRows = 0;
  let skippedReplays = 0;
  for (const frame of options.frames) {
    for (const event of payloadEvents(frame.payload)) {
      if (!isRecord(event)) {
        continue;
      }
      const eventType = event["event_type"];
      const entityType = event["entity_type"];
      const rowSchema = event["row_schema"];
      const rowJson = event["row_json"];
      const afterHash = event["after_hash"];
      if (
        typeof eventType !== "string" ||
        typeof entityType !== "string" ||
        typeof rowSchema !== "string" ||
        typeof rowJson !== "string" ||
        typeof afterHash !== "string"
      ) {
        continue;
      }
      const projection = LEDGER_PROJECTIONS.find(
        (candidate) =>
          candidate.entity_type === entityType &&
          candidate.event_types.includes(eventType) &&
          candidate.row_schemas.includes(rowSchema)
      );
      if (projection === undefined) {
        // The event belongs to another owner (a host or typed-row schema that
        // merely shares an entity name) or to a schema version this rebuild
        // does not own. It is not a ledger divergence.
        continue;
      }
      let row: Record<string, JsonValue>;
      try {
        const parsed: unknown = JSON.parse(rowJson);
        if (!isRecord(parsed)) {
          return { ok: false, error: divergence(`row_json_not_object:${rowSchema}`) };
        }
        row = parsed;
      } catch {
        return { ok: false, error: divergence(`row_json_not_json:${rowSchema}`) };
      }
      if (canonicalJsonText(row as unknown as JsonValue) !== rowJson) {
        return { ok: false, error: divergence(`row_json_not_canonical:${rowSchema}`) };
      }
      const computed = canonicalHash({
        row_schema: rowSchema,
        row_json: rowJson
      });
      if (computed !== afterHash) {
        return { ok: false, error: divergence(`after_hash_mismatch:${rowSchema}`) };
      }
      const key: Record<string, JsonValue> = {};
      for (const column of projection.primary_key) {
        const value = row[column];
        if (value === undefined || value === null) {
          return { ok: false, error: divergence(`primary_key_missing:${rowSchema}`) };
        }
        key[column] = value;
      }
      const existing = readProjectionRow(options.source, projection, key);
      if (existing !== null) {
        // The same event replayed: the frozen after-image is identical, so the
        // row is already there. A different after-image for the same entity
        // is a divergence.
        const existingHash = canonicalHash({
          row_schema: rowSchema,
          row_json: canonicalJsonText(existing as unknown as JsonValue)
        });
        if (existingHash === computed) {
          skippedReplays += 1;
          continue;
        }
        const operation = event["operation"];
        if (operation === "insert") {
          return { ok: false, error: divergence(`insert_over_existing:${rowSchema}`) };
        }
        replaceProjectionRow(options.source, projection, key, row);
        projectedRows += 1;
        continue;
      }
      insertProjectionRow(options.source, projection, row);
      projectedRows += 1;
    }
  }
  // Delivery history is appended after every delivery row exists, because the
  // projection enforces the foreign key. The pass stays in commit order, which
  // preserves the history sequence.
  let projectedHistoryRows = 0;
  for (const frame of options.frames) {
    for (const event of payloadEvents(frame.payload)) {
      const history = projectDeliveryHistoryEvent(options.source, event);
      if (!history.ok) {
        return { ok: false, error: history.error };
      }
      if (history.value.projected) {
        projectedHistoryRows += 1;
      }
    }
  }
  return {
    ok: true,
    value: {
      projected_rows: projectedRows,
      skipped_replays: skippedReplays,
      projected_delivery_history_rows: projectedHistoryRows
    }
  };
}

function readProjectionRow(
  source: StatementSource,
  projection: LedgerProjection,
  key: Record<string, JsonValue>
): Record<string, JsonValue> | null {
  const where = projection.primary_key.map((column) => `${column} = :${column}`).join(" AND ");
  const row = source
    .prepare<Record<string, JsonValue>>(`SELECT * FROM ${projection.table} WHERE ${where}`)
    .get(key);
  return row === undefined ? null : row;
}

function insertProjectionRow(
  source: StatementSource,
  projection: LedgerProjection,
  row: Record<string, JsonValue>
): void {
  const columns = Object.keys(row);
  const placeholders = columns.map((column) => `:${column}`).join(", ");
  source
    .prepare(`INSERT INTO ${projection.table} (${columns.join(", ")}) VALUES (${placeholders})`)
    .run(row);
}

function replaceProjectionRow(
  source: StatementSource,
  projection: LedgerProjection,
  key: Record<string, JsonValue>,
  row: Record<string, JsonValue>
): void {
  const keyColumns = projection.primary_key;
  const where = keyColumns.map((column) => `${column} = :${column}`).join(" AND ");
  const assignments = Object.keys(row)
    .filter((column) => !keyColumns.includes(column))
    .map((column) => `${column} = :${column}`)
    .join(", ");
  source
    .prepare(`UPDATE ${projection.table} SET ${assignments} WHERE ${where}`)
    .run(row);
}

/** The error the coordinator raises when a frame carries no ledger event. */
export function stateLedgerFieldError(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA",
    stage: "storage.state_ledger_rebuild",
    details: fieldDetails(path, rule)
  });
}
