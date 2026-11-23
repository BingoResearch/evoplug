import { type JsonValue, type NotPromise as CoreNotPromise, type SqlParams as CoreSqlParams, type SqlRow as CoreSqlRow } from "@evoplug/core";
import { isRecord as sharedIsRecord } from "@evoplug/core";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/**
 * SQLite port primitives shared by every storage submodule.
 *
 * These are storage-local structural types; business identifiers keep using the
 * shared `@evoplug/core` types.
 */

/** A value accepted by SQLite as a bound parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** A row returned by SQLite (the shared FND shape). */
export type SqlRow = CoreSqlRow;

/** Positional or named statement parameters (the shared FND shape). */
export type SqlParams = CoreSqlParams;

/**
 * Rejects PromiseLike returns at the type level. Transaction callbacks must be
 * synchronous; awaiting network, file, IPC or timers inside a transaction is
 * forbidden (DD-FND-024).
 */
export type NotPromise<T> = CoreNotPromise<T>;

/** Minimal read-only statement source used by helpers that accept a Tx or a connection. */
export interface StatementSource {
  prepare<Row extends SqlRow = SqlRow>(sql: string): {
    run(params?: SqlParams): { changes: number; lastInsertRowid: number };
    get(params?: SqlParams): Row | undefined;
    all(params?: SqlParams): Row[];
  };
}

/** True when the value is a non-array, non-null object. */
/** Reads a string field from an untyped JSON object. */
export function readStringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

/** Narrows an already-validated plain object to `JsonValue` for canonicalisation. */
export function jsonValueOf(value: unknown): JsonValue {
  return value as JsonValue;
}
