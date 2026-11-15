import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { SqlParams, SqlRow, SqlValue } from "../types.js";
import { noneDetails, storageDetails, storageError } from "../errors.js";

/** One prepared statement exposed through the storage port. */
export interface SqliteStatement<Row extends SqlRow = SqlRow> {
  run(params?: SqlParams): { changes: number; lastInsertRowid: number };
  get(params?: SqlParams): Row | undefined;
  all(params?: SqlParams): Row[];
}

/** One SQLite connection. Business modules never see `node:sqlite` directly. */
export interface SqliteConnection {
  exec(sql: string): void;
  prepare<Row extends SqlRow = SqlRow>(sql: string): SqliteStatement<Row>;
  close(): void;
}

/** The only supported entry point to SQLite (DD-FND-003/DD-FND-024). */
export interface SqliteDriver {
  open(file: string, opts: { readOnly: boolean }): SqliteConnection;
  backup(conn: SqliteConnection, destination: string): Promise<void>;
}

const RAW_CONNECTIONS: WeakMap<SqliteConnection, DatabaseSync> = new WeakMap();

function isPositional(params: SqlParams): boolean {
  // A bare scalar/array is positional; only plain records are named params.
  return Array.isArray(params) || isSqlValue(params);
}

function isNamedParams(params: SqlParams): params is Readonly<Record<string, SqlValue>> {
  return typeof params === "object" && params !== null && !Array.isArray(params);
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  );
}

function positionalParams(params: SqlParams | unknown): readonly SqlValue[] {
  const values = Array.isArray(params) ? params : [params];
  return values.map((value) => {
    if (!isSqlValue(value)) {
      throw new TypeError("sqlite parameter must be null, number, bigint, string or Uint8Array");
    }
    return value;
  });
}

function namedParams(params: Readonly<Record<string, unknown>>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!isSqlValue(value)) {
      throw new TypeError("sqlite parameter must be null, number, bigint, string or Uint8Array");
    }
    out[key] = value;
  }
  return out;
}

function bindAndRun(
  statement: StatementSync,
  params: SqlParams | undefined,
): { changes: number; lastInsertRowid: number } {
  const result =
    params === undefined
      ? statement.run()
      : isPositional(params)
        ? statement.run(...positionalParams(params))
        : isNamedParams(params)
          ? statement.run(namedParams(params))
          : statement.run(...positionalParams(params));
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid)
  };
}

function bindAndGet<Row extends SqlRow>(
  statement: StatementSync,
  params: SqlParams | undefined,
): Row | undefined {
  const row =
    params === undefined
      ? statement.get()
      : isPositional(params)
        ? statement.get(...positionalParams(params))
        : isNamedParams(params)
          ? statement.get(namedParams(params))
          : statement.get(...positionalParams(params));
  return row === undefined ? undefined : (row as Row);
}

function bindAndAll<Row extends SqlRow>(
  statement: StatementSync,
  params: SqlParams | undefined,
): Row[] {
  const rows =
    params === undefined
      ? statement.all()
      : isPositional(params)
        ? statement.all(...positionalParams(params))
        : isNamedParams(params)
          ? statement.all(namedParams(params))
          : statement.all(...positionalParams(params));
  return rows as Row[];
}

class NodeSqliteStatement<Row extends SqlRow> implements SqliteStatement<Row> {
  readonly #statement: StatementSync;

  constructor(statement: StatementSync) {
    this.#statement = statement;
    // Projection statements bind a domain row object whose key set is a
    // superset of the statement's columns (for example a `schema_version`
    // carried only by the journal row). node:sqlite rejects unbound named
    // parameters by default; the row-shaped binding contract (DD-FND-059)
    // requires the statement to consume the columns it names and ignore the
    // rest. Unknown parameters are never persisted, so this does not weaken
    // column or value validation.
    this.#statement.setAllowUnknownNamedParameters(true);
  }

  run(params?: SqlParams): { changes: number; lastInsertRowid: number } {
    return bindAndRun(this.#statement, params);
  }

  get(params?: SqlParams): Row | undefined {
    return bindAndGet<Row>(this.#statement, params);
  }

  all(params?: SqlParams): Row[] {
    return bindAndAll<Row>(this.#statement, params);
  }
}

class NodeSqliteConnection implements SqliteConnection {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare<Row extends SqlRow = SqlRow>(sql: string): SqliteStatement<Row> {
    return new NodeSqliteStatement<Row>(this.#database.prepare(sql));
  }

  close(): void {
    this.#database.close();
  }
}

/** Creates the production `SqliteDriver` backed by `node:sqlite`. */
export function createSqliteDriver(): SqliteDriver {
  return {
    open(file: string, opts: { readOnly: boolean }): SqliteConnection {
      const database = new DatabaseSync(file, {
        readOnly: opts.readOnly,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false
      });
      const connection = new NodeSqliteConnection(database);
      RAW_CONNECTIONS.set(connection, database);
      return connection;
    },
    async backup(conn: SqliteConnection, destination: string): Promise<void> {
      const database = RAW_CONNECTIONS.get(conn);
      if (database === undefined) {
        throw storageError({
          code: "E_STORAGE_IO",
          stage: "storage.sqlite",
          details: storageDetails("backup", "unknown_connection"),
          message_key: "error.storage.backup_unknown_connection"
        });
      }
      await sqliteBackup(database, destination);
    }
  };
}

/** Reads `select sqlite_version()` through the port. */
export function readSqliteVersion(connection: SqliteConnection): string {
  const row = connection.prepare<{ version: string }>("SELECT sqlite_version() AS version").get();
  if (row === undefined || typeof row.version !== "string") {
    throw storageError({
      code: "E_STORAGE_IO",
      stage: "storage.sqlite",
      details: noneDetails(),
      message_key: "error.storage.sqlite_version_unreadable"
    });
  }
  return row.version;
}
