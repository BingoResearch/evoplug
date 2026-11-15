/**
 * Transaction port needed by FND read ports that must run inside a caller's
 * `BEGIN IMMEDIATE` transaction (DD-FND-024, DD-FND-031.1).
 *
 * Only the structural transaction surface is declared here so that
 * `@evoplug/storage` can implement `withTx` without `core` importing the
 * SQLite driver. `node:sqlite` never leaks through this file.
 */

export type SqlRow = Record<string, unknown>;

export type SqlParams = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface SqliteStatement<Row extends SqlRow = SqlRow> {
  run(params?: SqlParams): { changes: number; lastInsertRowid: number };
  get(params?: SqlParams): Row | undefined;
  all(params?: SqlParams): Row[];
}

export interface Tx {
  prepare<Row extends SqlRow = SqlRow>(sql: string): SqliteStatement<Row>;
  exec(sql: string): void;
}

/** Rejects async callbacks in transaction scope. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;
