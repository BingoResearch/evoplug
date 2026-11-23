/**
 * Version binding extraction for committed state rows (DD-FND-059.1.3,
 * DD-FND-059.1.6).
 *
 * The read ports compare the effective binding of a committed row against the
 * binding the caller passed, byte-for-byte across all six fields:
 *
 *   - `binding_source="none"` rows are global and carry no binding;
 *   - `binding_source="row"` rows carry the six fields inside the row, either
 *     as plain columns (`state_fact`) or as one JSON text column
 *     (`binding_json`, `version_binding_json`);
 *   - `binding_source="batch"` rows inherit the binding of the batch that
 *     committed them, which the `ledger_event_log` projection froze;
 *   - `rsi.fact_verification_row/1` is read by V: the task/branch come from
 *     the one-to-one `event_log` row and the four remaining fields from the
 *     row itself.
 */

import type { VersionBinding } from "@evoplug/core";
import { parseVersionBinding } from "@evoplug/core";

import type { SqlRow, StatementSource } from "../types.js";

/** The JSON text columns a `row`-scoped row may carry its binding in. */
const BINDING_JSON_COLUMNS: readonly string[] = ["binding_json", "version_binding_json"];

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * The six binding fields of a row, or null when the row carries none.
 *
 * A JSON text column wins over the plain columns; the caller decides what a
 * missing binding means for its scope.
 */
export function readRowBindingFields(row: SqlRow): VersionBinding | null {
  for (const column of BINDING_JSON_COLUMNS) {
    const text = row[column];
    if (typeof text !== "string") {
      continue;
    }
    const parsed = parseJsonObject(text);
    if (parsed === null) {
      return null;
    }
    const result = parseVersionBinding(parsed);
    return result.ok ? result.value : null;
  }
  const taskId = row["task_id"];
  const branchId = row["branch_id"];
  const inputEpoch = row["input_epoch"];
  const goalVersion = row["goal_version"];
  const configVersion = row["config_version"];
  const watermark = row["watermark"];
  if (
    typeof taskId !== "string" ||
    typeof branchId !== "string" ||
    typeof inputEpoch !== "number" ||
    typeof goalVersion !== "string" ||
    typeof configVersion !== "string" ||
    typeof watermark !== "number"
  ) {
    return null;
  }
  const result = parseVersionBinding({
    task_id: taskId,
    branch_id: branchId,
    input_epoch: inputEpoch,
    goal_version: goalVersion,
    config_version: configVersion,
    watermark
  });
  return result.ok ? result.value : null;
}

/** The task/branch of the `event_log` row a verification row points at. */
export function readVerificationEventBinding(
  source: StatementSource,
  eventId: string
): { task_id: string; branch_id: string } | null {
  const row = source
    .prepare<{ task_id: string | null; branch_id: string | null }>(
      "SELECT task_id, branch_id FROM event_log WHERE event_id = :event_id"
    )
    .get({ event_id: eventId });
  if (row === undefined) {
    return null;
  }
  if (typeof row.task_id !== "string" || typeof row.branch_id !== "string") {
    return null;
  }
  return { task_id: row.task_id, branch_id: row.branch_id };
}

/**
 * Rebuilds the V binding of a `fact_verification` row: the task/branch of the
 * linked `event_log` row plus the four fields frozen in the row.
 */
export function buildVerificationBinding(
  row: SqlRow,
  eventTaskBranch: { task_id: string; branch_id: string } | null
): VersionBinding | null {
  if (eventTaskBranch === null) {
    return null;
  }
  const inputEpoch = row["input_epoch"];
  const goalVersion = row["goal_version"];
  const configVersion = row["config_version"];
  const watermark = row["watermark"];
  if (
    typeof inputEpoch !== "number" ||
    typeof goalVersion !== "string" ||
    typeof configVersion !== "string" ||
    typeof watermark !== "number"
  ) {
    return null;
  }
  const result = parseVersionBinding({
    task_id: eventTaskBranch.task_id,
    branch_id: eventTaskBranch.branch_id,
    input_epoch: inputEpoch,
    goal_version: goalVersion,
    config_version: configVersion,
    watermark
  });
  return result.ok ? result.value : null;
}

/** The binding frozen on a `ledger_event_log` row. */
export function readLedgerBinding(row: SqlRow): VersionBinding | null {
  if (row["binding_mode"] !== "bound") {
    return null;
  }
  const taskId = row["task_id"];
  const branchId = row["branch_id"];
  const inputEpoch = row["input_epoch"];
  const goalVersion = row["goal_version"];
  const configVersion = row["config_version"];
  const watermark = row["watermark"];
  if (
    typeof taskId !== "string" ||
    typeof branchId !== "string" ||
    typeof inputEpoch !== "number" ||
    typeof goalVersion !== "string" ||
    typeof configVersion !== "string" ||
    typeof watermark !== "number"
  ) {
    return null;
  }
  const result = parseVersionBinding({
    task_id: taskId,
    branch_id: branchId,
    input_epoch: inputEpoch,
    goal_version: goalVersion,
    config_version: configVersion,
    watermark
  });
  return result.ok ? result.value : null;
}
