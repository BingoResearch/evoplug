import type { ErrorEnvelope, Result } from "@evoplug/core";
import { storageDetails, storageError } from "../errors.js";
import type { SqliteConnection, SqliteDriver } from "./driver.js";
import { readSqliteVersion } from "./driver.js";
import { isSupportedSqliteVersion } from "./version.js";

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const WAL_AUTOCHECKPOINT_PAGES = 1000;
export const JOURNAL_SIZE_LIMIT_BYTES = 67108864;

/** Pragmas applied to every connection, read-only included (DD-FND-024 step 2). */
export const CONNECTION_PRAGMAS: readonly string[] = [
  "PRAGMA foreign_keys=ON",
  `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`,
  "PRAGMA trusted_schema=OFF"
];

/** Pragmas applied only to the single writer connection. */
export const WRITER_PRAGMAS: readonly string[] = [
  "PRAGMA journal_mode=WAL",
  "PRAGMA synchronous=FULL",
  `PRAGMA wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES}`,
  `PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}`
];

export interface ConfiguredConnection {
  readonly connection: SqliteConnection;
  readonly sqlite_version: string;
}

/**
 * Applies the connection pragmas. Writers additionally switch to WAL with
 * `synchronous=FULL`; readers only get the safety pragmas.
 */
export function applyConnectionPragmas(connection: SqliteConnection, readOnly: boolean): void {
  for (const pragma of CONNECTION_PRAGMAS) {
    connection.exec(pragma);
  }
  if (!readOnly) {
    for (const pragma of WRITER_PRAGMAS) {
      connection.exec(pragma);
    }
  }
  const foreignKeys = connection.prepare<{ foreign_keys: number }>("PRAGMA foreign_keys").get();
  if (foreignKeys === undefined || Number(foreignKeys.foreign_keys) !== 1) {
    throw storageError({
      code: "E_STORAGE_IO",
      stage: "storage.sqlite",
      details: storageDetails("pragma", "foreign_keys_not_enabled"),
      message_key: "error.storage.foreign_keys_disabled"
    });
  }
}

/**
 * Opens a connection, admits the bundled SQLite version and applies pragmas.
 * An unsupported version closes the connection immediately and never runs a
 * migration or a write.
 */
export function openConfiguredConnection(
  driver: SqliteDriver,
  file: string,
  opts: { readOnly: boolean },
): Result<ConfiguredConnection, ErrorEnvelope> {
  let connection: SqliteConnection;
  try {
    connection = driver.open(file, { readOnly: opts.readOnly });
  } catch (error) {
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_STORAGE_IO",
        stage: "storage.sqlite",
        details: storageDetails("open", error instanceof Error ? error.name : undefined),
        message_key: "error.storage.sqlite_open_failed",
        side_effect: "none"
      })
    };
  }
  try {
    const version = readSqliteVersion(connection);
    if (!isSupportedSqliteVersion(version)) {
      connection.close();
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_SQLITE_UNSAFE",
          stage: "storage.sqlite",
          details: storageDetails("sqlite_version", version)
        })
      };
    }
    applyConnectionPragmas(connection, opts.readOnly);
    return { ok: true, status: "ok", value: { connection, sqlite_version: version } };
  } catch (error) {
    try {
      connection.close();
    } catch {
      // The connection is already unusable.
    }
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_STORAGE_IO",
        stage: "storage.sqlite",
        details: storageDetails("configure"),
        message_key: "error.storage.sqlite_configure_failed"
      })
    };
  }
}
