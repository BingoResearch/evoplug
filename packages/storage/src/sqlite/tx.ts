import type { ErrorEnvelope, NotPromise as CoreNotPromise, Tx as CoreTx } from "@evoplug/core";
import type { SqlRow } from "../types.js";
import { fieldDetails, storageDetails, storageError } from "../errors.js";
import type { SqliteConnection, SqliteStatement } from "./driver.js";

/**
 * A synchronous SQLite write transaction (DD-FND-024). The structural type is
 * owned by `@evoplug/core` so callers in every domain share one `Tx`.
 */
export type Tx = CoreTx;

export interface TransactionRunner {
  withTx<T>(fn: (tx: Tx) => CoreNotPromise<T>): Promise<T>;
  withTxSync<T>(fn: (tx: Tx) => CoreNotPromise<T>): T;
}

const BUSY_PRIMARY_CODES: ReadonlySet<number> = new Set([5, 6]);

/** SQLITE_FULL: the database or disk is full. */
const SQLITE_FULL_PRIMARY_CODE = 13;

function readSqliteErrorField(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

/** Maps a thrown `node:sqlite` error to a storage `ErrorEnvelope`. */
export function mapSqliteFailure(
  error: unknown,
  stage: string,
  operation: string,
): ErrorEnvelope {
  const errcode = readSqliteErrorField(error, "errcode");
  const code =
    typeof errcode === "number" || typeof errcode === "bigint" ? Number(errcode) : undefined;
  if (code !== undefined && BUSY_PRIMARY_CODES.has(code & 0xff)) {
    return storageError({
      code: "E_STORAGE_BUSY",
      stage,
      details: storageDetails(operation, String(code)),
      retryable: true
    });
  }
  // SQLITE_FULL (13) is the disk-full condition; it has its own canonical
  // code so the caller can retry with the same idempotency key.
  if (code !== undefined && (code & 0xff) === SQLITE_FULL_PRIMARY_CODE) {
    return storageError({
      code: "E_STORAGE_SQLITE_ENOSPC",
      stage,
      details: storageDetails(operation, String(code)),
      retryable: true
    });
  }
  return storageError({
    code: "E_STORAGE_IO",
    stage,
    details: storageDetails(operation, code === undefined ? undefined : String(code)),
    side_effect: "unknown"
  });
}

/** True when `value` is an `ErrorEnvelope` raised by a domain layer. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate["schema_version"] === "rsi.error/1" &&
    typeof candidate["code"] === "string" &&
    typeof candidate["stage"] === "string" &&
    typeof candidate["message_key"] === "string"
  );
}

function assertSynchronous(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  ) {
    throw storageError({
      code: "E_SCHEMA",
      stage: "storage.tx",
      details: fieldDetails("tx.callback", "must_be_synchronous"),
      message_key: "error.storage.transaction_await_forbidden"
    });
  }
}

class SqliteTx {
  readonly #connection: SqliteConnection;

  constructor(connection: SqliteConnection) {
    this.#connection = connection;
  }

  prepare<Row extends SqlRow = SqlRow>(sql: string): SqliteStatement<Row> {
    return this.#connection.prepare<Row>(sql);
  }

  exec(sql: string): void {
    this.#connection.exec(sql);
  }
}

const ACTIVE_CONNECTIONS: WeakSet<SqliteConnection> = new WeakSet();

function runTransaction<T>(connection: SqliteConnection, fn: (tx: Tx) => CoreNotPromise<T>): T {
  if (ACTIVE_CONNECTIONS.has(connection)) {
    throw storageError({
      code: "E_SCHEMA",
      stage: "storage.tx",
      details: fieldDetails("tx", "nested_write_transaction"),
      message_key: "error.storage.transaction_nested"
    });
  }
  ACTIVE_CONNECTIONS.add(connection);
  const tx = new SqliteTx(connection);
  try {
    connection.exec("BEGIN IMMEDIATE");
  } catch (error) {
    ACTIVE_CONNECTIONS.delete(connection);
    throw mapSqliteFailure(error, "storage.tx", "begin_immediate");
  }
  let result: T;
  try {
    result = fn(tx as unknown as Tx);
    assertSynchronous(result);
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // A failed rollback leaves the connection unusable; the original error wins.
    }
    ACTIVE_CONNECTIONS.delete(connection);
    throw error;
  }
  try {
    connection.exec("COMMIT");
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // Ignore secondary rollback failure.
    }
    ACTIVE_CONNECTIONS.delete(connection);
    throw mapSqliteFailure(error, "storage.tx", "commit");
  }
  ACTIVE_CONNECTIONS.delete(connection);
  return result;
}

/** Binds the single kernel write connection used by the bare `withTx` helpers. */
export function createTransactionRunner(connection: SqliteConnection): TransactionRunner {
  return {
    withTx<T>(fn: (tx: Tx) => CoreNotPromise<T>): Promise<T> {
      return Promise.resolve().then(() => runTransaction(connection, fn));
    },
    withTxSync<T>(fn: (tx: Tx) => CoreNotPromise<T>): T {
      return runTransaction(connection, fn);
    }
  };
}

let boundWriteConnection: SqliteConnection | null = null;

/** Binds the process-wide write connection. Called once by the kernel composition root. */
export function bindWriteConnection(connection: SqliteConnection): void {
  if (boundWriteConnection !== null) {
    throw storageError({
      code: "E_SCHEMA",
      stage: "storage.tx",
      details: fieldDetails("write_connection", "already_bound"),
      message_key: "error.storage.write_connection_already_bound"
    });
  }
  boundWriteConnection = connection;
}

/** Releases the process-wide write connection binding. */
export function unbindWriteConnection(): void {
  boundWriteConnection = null;
}

/** Returns the bound write connection or throws when the kernel is not initialised. */
export function requireWriteConnection(): SqliteConnection {
  if (boundWriteConnection === null) {
    throw storageError({
      code: "E_STORAGE_IO",
      stage: "storage.tx",
      details: storageDetails("with_tx", "unbound_write_connection"),
      message_key: "error.storage.write_connection_unbound"
    });
  }
  return boundWriteConnection;
}

/** Runs `fn` in a `BEGIN IMMEDIATE` transaction on the bound write connection. */
export function withTxSync<T>(fn: (tx: Tx) => CoreNotPromise<T>): T {
  return runTransaction(requireWriteConnection(), fn);
}

/** Promise-shaped variant required by service signatures; the callback stays synchronous. */
export function withTx<T>(fn: (tx: Tx) => CoreNotPromise<T>): Promise<T> {
  return Promise.resolve().then(() => withTxSync(fn));
}
