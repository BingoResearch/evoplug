/**
 * Read side of the FND StateRow port (DD-FND-059.1.6).
 *
 * Every read runs inside one read-only transaction and returns committed rows
 * only: no repair, no refresh, no unprojected frame. `readStateRowsSnapshot`
 * reads an exact key set, returns the hits in ascending `commit_seq`, omits
 * missing keys without an error and fails the whole read on any storage error
 * — never with a partial array.
 *
 * Binding rules:
 *   - `binding=null` reads only rows registered as `none`;
 *   - a non-null binding reads only `row`/`batch` rows, and the row's own six
 *     binding fields must equal the passed binding byte-for-byte.
 */

import {
  equalVersionBinding,
  stateRowKey,
  type ErrorEnvelope,
  type Hash,
  type Result,
  type StateRowKeyMap,
  type StateRowReadKey,
  type StateRowSchema,
  type StateRowSnapshot,
  type StateRowTypeMap,
  type VersionBinding
} from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { fieldDetails, storageError } from "../errors.js";
import type { SqlRow } from "../types.js";
import type { SqliteConnection } from "../sqlite/driver.js";
import { mapSqliteFailure } from "../sqlite/tx.js";
import {
  buildVerificationBinding,
  readLedgerBinding,
  readRowBindingFields,
  readVerificationEventBinding
} from "./binding.js";
import { ARRAY_TEXT_COLUMNS, findRegistration, normalizeRowForTable } from "./registry.js";

/** The maximum number of rows one list call may return. */
const LIST_STATE_ROWS_MAX_LIMIT = 1000;

/** The minimum number of rows one list call may request. */
const LIST_STATE_ROWS_MIN_LIMIT = 1;

/** The projection metadata of one committed row. */
interface RowProjection {
  readonly commit_seq: number;
  readonly after_hash: Hash;
  readonly binding: VersionBinding | null;
}

function schemaError(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_SCHEMA",
    stage: "storage.state_row",
    details: fieldDetails(path, rule),
    message_key: "error.storage.state_row_schema_invalid"
  });
}

function bindingError(): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_BINDING",
    stage: "storage.state_row",
    details: { kind: "none" },
    message_key: "error.storage.state_row_binding_invalid"
  });
}

interface ReadSource {
  prepare<Row extends SqlRow = SqlRow>(sql: string): {
    get(params?: unknown): Row | undefined;
    all(params?: unknown): Row[];
  };
}

/** The `WHERE` clause that selects one row by its registered primary key. */
function primaryKeyClause(
  rowSchema: string,
  key: StateRowKeyMap[StateRowSchema]
): { sql: string; params: Record<string, unknown> } | null {
  const registration = findRegistration(rowSchema);
  if (registration === null) {
    return null;
  }
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const column of registration.primary_key) {
    const value = (key as Record<string, unknown>)[column];
    if (value === undefined || value === null) {
      return null;
    }
    params[column] = value;
    parts.push(`${column} = :${column}`);
  }
  return { sql: parts.join(" AND "), params };
}

/**
 * The newest committed projection of one typed row.
 *
 * `ledger_event_log` records every committed row event; the newest
 * `commit_seq` for the entity is the committed snapshot.
 */
function readProjection(
  source: ReadSource,
  rowSchema: string,
  entityId: string
): RowProjection | null {
  const row = source
    .prepare<{
      commit_seq: number;
      after_hash: string;
      binding_mode: string;
      task_id: string | null;
      branch_id: string | null;
      input_epoch: number | null;
      goal_version: string | null;
      config_version: string | null;
      watermark: number | null;
    }>(
      `SELECT commit_seq, after_hash, binding_mode, task_id, branch_id, input_epoch,
              goal_version, config_version, watermark
         FROM ledger_event_log
        WHERE entity_type = 'state_row'
          AND entity_id = :entity_id
          AND row_schema = :row_schema
        ORDER BY commit_seq DESC
        LIMIT 1`
    )
    .get({ entity_id: entityId, row_schema: rowSchema });
  if (row === undefined) {
    return null;
  }
  return {
    commit_seq: Number(row.commit_seq),
    after_hash: String(row.after_hash) as Hash,
    binding: readLedgerBinding(row as unknown as SqlRow)
  };
}

/**
 * The effective binding of a committed typed row.
 *
 * `none` rows have none, `batch` rows inherit the frozen batch binding and
 * `row` rows carry their own six fields. The verification row is read by V:
 * task/branch from the linked `event_log` row, four fields from the row.
 */
function readCommittedBinding(
  source: ReadSource,
  rowSchema: string,
  bindingSource: "row" | "batch" | "none",
  row: SqlRow,
  projection: RowProjection | null
): VersionBinding | null {
  if (bindingSource === "none") {
    return null;
  }
  if (rowSchema === "rsi.fact_verification_row/1") {
    const eventId = row["event_id"];
    if (typeof eventId !== "string") {
      return null;
    }
    const taskBranch = readVerificationEventBinding(source as never, eventId);
    return buildVerificationBinding(row, taskBranch);
  }
  if (bindingSource === "batch") {
    return projection?.binding ?? null;
  }
  return readRowBindingFields(row);
}

/**
 * The binding of a committed row, compared byte-for-byte with the requested
 * binding.
 */
function bindingMatches(
  rowBinding: VersionBinding | null,
  requested: VersionBinding | null
): boolean {
  if (requested === null) {
    return rowBinding === null;
  }
  if (rowBinding === null) {
    return false;
  }
  return equalVersionBinding(rowBinding, requested);
}

/**
 * Restores the registry's array columns from the physical TEXT column.
 *
 * The registry types `active_requirement_ids_json`,
 * `replacement_op_ids_json` and `invalidated_judgment_ids_json` as arrays
 * while the DDL stores them as canonical JSON text.
 */
function restoreRowColumns(row: SqlRow): SqlRow {
  const out: SqlRow = { ...row };
  for (const column of ARRAY_TEXT_COLUMNS) {
    const value = out[column];
    if (typeof value !== "string") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        out[column] = parsed;
      }
    } catch {
      // A non-JSON text column stays as it is.
    }
  }
  return out;
}

/**
 * The `object_key` of a committed row, per the registry primary key.
 *
 * The key is computed over the row as it was frozen, so the array columns are
 * still their canonical JSON text here.
 */
function objectKeyOf(rowSchema: string, row: SqlRow): string | null {
  try {
    return stateRowKey(
      rowSchema as StateRowSchema,
      normalizeRowForTable(rowSchema, row as Record<string, unknown>) as never
    );
  } catch {
    return null;
  }
}

/**
 * Reads one committed row by its exact key.
 *
 * Returns null when the row does not exist. A row whose scope does not match
 * the requested binding is not visible: the caller sees "missing", not a row
 * from another binding.
 */
function readOne(
  source: ReadSource,
  rowSchema: string,
  key: StateRowKeyMap[StateRowSchema],
  binding: VersionBinding | null
): StateRowSnapshot | null {
  const registration = findRegistration(rowSchema);
  const clause = primaryKeyClause(rowSchema, key);
  if (registration === null || clause === null) {
    return null;
  }
  if (binding === null && registration.binding_source !== "none") {
    return null;
  }
  if (binding !== null && registration.binding_source === "none") {
    return null;
  }
  const row = source
    .prepare<SqlRow>(`SELECT * FROM ${registration.table} WHERE ${clause.sql}`)
    .get(clause.params);
  if (row === undefined) {
    return null;
  }
  const entityId = objectKeyOf(rowSchema, row);
  const projection = entityId === null ? null : readProjection(source, rowSchema, entityId);
  if (projection === null) {
    return null;
  }
  const rowBinding = readCommittedBinding(
    source,
    rowSchema,
    registration.binding_source,
    row,
    projection
  );
  if (!bindingMatches(rowBinding, binding)) {
    return null;
  }
  return {
    row_schema: rowSchema as StateRowSchema,
    row: restoreRowColumns(row) as unknown as StateRowTypeMap[StateRowSchema],
    commit_seq: projection.commit_seq,
    after_hash: projection.after_hash
  };
}

/**
 * True when the key set mixes the fact key (F) with the verification key (V).
 *
 * The two rows are read by two different bindings and are joined by
 * `fact_id` afterwards; one read never mixes them.
 */
function mixesFactAndVerificationScopes(keys: readonly StateRowReadKey[]): boolean {
  let hasFact = false;
  let hasVerification = false;
  for (const key of keys) {
    if (key.row_schema === "rsi.state_fact_row/1") {
      hasFact = true;
    }
    if (key.row_schema === "rsi.fact_verification_row/1") {
      hasVerification = true;
    }
  }
  return hasFact && hasVerification;
}

/**
 * Runs `fn` inside one read-only transaction on the given connection.
 *
 * The transaction never re-reads the snapshot midway and any storage error
 * fails the whole call.
 */
function inReadTransaction<T>(
  connection: SqliteConnection,
  fn: (source: ReadSource) => T
): { ok: true; value: T } | { ok: false; error: ErrorEnvelope } {
  try {
    connection.exec("BEGIN DEFERRED");
  } catch (error) {
    return {
      ok: false,
      error: mapSqliteFailure(error, "storage.state_row", "begin_deferred")
    };
  }
  try {
    const value = fn(connection as unknown as ReadSource);
    connection.exec("COMMIT");
    return { ok: true, value };
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // The connection is already unusable; the original error wins.
    }
    return {
      ok: false,
      error: mapSqliteFailure(error, "storage.state_row", "read_state_rows")
    };
  }
}

/**
 * The read face of the FND `StateRowPort`.
 *
 * The caller owns the connection and the writer gate; the reads themselves use
 * one read-only transaction per call.
 */
export function createStateRowReader(options: {
  /**
   * The connection the reads run on.
   *
   * The design requires the read ports to use an independent read-only
   * connection or snapshot; passing the writer connection is only correct
   * when no write is in flight.
   */
  readonly connection: SqliteConnection;
}): {
  getStateRow<S extends StateRowSchema>(q: {
    row_schema: S;
    key: StateRowKeyMap[S];
    binding: VersionBinding | null;
  }): Promise<Result<StateRowTypeMap[S] | null, ErrorEnvelope>>;
  listStateRows(q: {
    row_schemas: readonly StateRowSchema[];
    binding: VersionBinding | null;
    after_commit_seq?: number;
    limit: number;
  }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>>;
  readStateRowsSnapshot(q: {
    binding: VersionBinding | null;
    keys: readonly StateRowReadKey[];
  }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>>;
} {
  const { connection } = options;

  return {
    async getStateRow<S extends StateRowSchema>(q: {
      row_schema: S;
      key: StateRowKeyMap[S];
      binding: VersionBinding | null;
    }): Promise<Result<StateRowTypeMap[S] | null, ErrorEnvelope>> {
      if (findRegistration(q.row_schema) === null) {
        return err(schemaError(`row_schema.${q.row_schema}`, "unregistered_row_schema"));
      }
      const read = inReadTransaction(connection, (source) =>
        readOne(source, q.row_schema, q.key as StateRowKeyMap[StateRowSchema], q.binding)
      );
      if (!read.ok) {
        return err(read.error);
      }
      if (read.value === null) {
        return ok(null);
      }
      return ok(read.value.row as unknown as StateRowTypeMap[S]);
    },

    async listStateRows(q: {
      row_schemas: readonly StateRowSchema[];
      binding: VersionBinding | null;
      after_commit_seq?: number;
      limit: number;
    }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>> {
      if (!Number.isSafeInteger(q.limit) || q.limit < LIST_STATE_ROWS_MIN_LIMIT) {
        return err(schemaError("limit", "min_1"));
      }
      if (q.limit > LIST_STATE_ROWS_MAX_LIMIT) {
        return err(schemaError("limit", "max_1000"));
      }
      for (const rowSchema of q.row_schemas) {
        if (findRegistration(rowSchema) === null) {
          return err(schemaError(`row_schemas.${rowSchema}`, "unregistered_row_schema"));
        }
      }
      const read = inReadTransaction(connection, (source) => {
        const snapshots: StateRowSnapshot[] = [];
        for (const rowSchema of q.row_schemas) {
          const registration = findRegistration(rowSchema);
          if (registration === null) {
            continue;
          }
          if (q.binding === null && registration.binding_source !== "none") {
            continue;
          }
          if (q.binding !== null && registration.binding_source === "none") {
            continue;
          }
          const rows = source
            .prepare<SqlRow>(`SELECT * FROM ${registration.table}`)
            .all();
          for (const row of rows) {
            const entityId = objectKeyOf(rowSchema, row);
            const projection =
              entityId === null ? null : readProjection(source, rowSchema, entityId);
            if (projection === null) {
              continue;
            }
            if (
              q.after_commit_seq !== undefined &&
              projection.commit_seq <= q.after_commit_seq
            ) {
              continue;
            }
            const rowBinding = readCommittedBinding(
              source,
              rowSchema,
              registration.binding_source,
              row,
              projection
            );
            if (!bindingMatches(rowBinding, q.binding)) {
              continue;
            }
            snapshots.push({
              row_schema: rowSchema,
              row: restoreRowColumns(row) as unknown as StateRowTypeMap[StateRowSchema],
              commit_seq: projection.commit_seq,
              after_hash: projection.after_hash
            });
          }
        }
        snapshots.sort((left, right) => {
          if (left.commit_seq !== right.commit_seq) {
            return left.commit_seq - right.commit_seq;
          }
          return left.row_schema < right.row_schema ? -1 : left.row_schema > right.row_schema ? 1 : 0;
        });
        return snapshots.slice(0, q.limit);
      });
      if (!read.ok) {
        return err(read.error);
      }
      return ok(read.value);
    },

    async readStateRowsSnapshot(q: {
      binding: VersionBinding | null;
      keys: readonly StateRowReadKey[];
    }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>> {
      // The key set is validated before the snapshot is opened: an unknown
      // schema fails the whole read instead of returning a partial array.
      for (const readKey of q.keys) {
        if (findRegistration(readKey.row_schema) === null) {
          return err(schemaError(`keys.${readKey.row_schema}`, "unregistered_row_schema"));
        }
      }
      // The fact row and the verification row are read by two different
      // bindings (F and V); one read never mixes the two key kinds.
      if (mixesFactAndVerificationScopes(q.keys)) {
        return err(bindingError());
      }
      const read = inReadTransaction(connection, (source) => {
        const snapshots: StateRowSnapshot[] = [];
        for (const readKey of q.keys) {
          const snapshot = readOne(
            source,
            readKey.row_schema,
            readKey.key as StateRowKeyMap[StateRowSchema],
            q.binding
          );
          if (snapshot !== null) {
            snapshots.push(snapshot);
          }
        }
        snapshots.sort((left, right) => {
          if (left.commit_seq !== right.commit_seq) {
            return left.commit_seq - right.commit_seq;
          }
          return left.row_schema < right.row_schema ? -1 : left.row_schema > right.row_schema ? 1 : 0;
        });
        return snapshots;
      });
      if (!read.ok) {
        return err(read.error);
      }
      return ok(read.value);
    }
  };
}
