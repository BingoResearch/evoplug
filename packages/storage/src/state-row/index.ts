/**
 * The concrete FND `StateRowPort` and `StateRowLiveCommitPort`
 * (DD-FND-059.1.6, DD-FND-059.1.6.1).
 *
 * The port is the single entry point for typed state rows: it owns the
 * registry admission rules, the single-frame journal commit, the SQLite
 * projection and the read-only snapshot reads.
 *
 * The caller owns the writer gate and the journal writer; the port never
 * opens a second connection and never nests a transaction.
 */

import type { AppendStateRowsRequest, AppendStateRowsResult, ErrorEnvelope, LiveCommitOutcome, Result, StateRowKeyMap, StateRowLiveCommitPort, StateRowPort, StateRowReadKey, StateRowSchema, StateRowSnapshot, StateRowTypeMap, VersionBinding } from "@evoplug/core";

import type { SqliteConnection } from "../sqlite/driver.js";
import type { BlobStore } from "../blob/store.js";
import type { JournalWriter } from "../journal/writer.js";
import { createStateRowReader } from "./read.js";
import {
  createFndLiveCommitPort as createLiveCommitPort,
  createFndStateRowWriter,
  type StateRowWriterOptions
} from "./write.js";

export * from "./registry.js";
export * from "./read.js";
export * from "./write.js";
export * from "./binding.js";

interface FndStateRowPortOptions extends StateRowWriterOptions {
  readonly connection: SqliteConnection;
  readonly writer: JournalWriter;
  readonly relative_path: string;
  readonly blob_store: BlobStore;
  /**
   * An independent read-only connection for the read ports.
   *
   * The design requires the read ports to run on their own read-only
   * connection or snapshot and never to read the writer connection. When it
   * is absent the reads run on the writer connection, which is only correct
   * while no write is in flight.
   */
  readonly read_connection?: SqliteConnection;
}

/**
 * Creates the FND `StateRowPort`.
 *
 * The returned object implements the four methods the design fixes:
 * `appendStateRows`, `getStateRow`, `listStateRows` and
 * `readStateRowsSnapshot`.
 */
export function createFndStateRowPort(options: FndStateRowPortOptions): StateRowPort {
  const reader = createStateRowReader({
    connection: options.read_connection ?? options.connection
  });
  const writer = createFndStateRowWriter(options);
  return {
    appendStateRows(input: AppendStateRowsRequest): Promise<LiveCommitOutcome<null>> {
      return writer.appendStateRows(input);
    },
    getStateRow<S extends StateRowSchema>(q: {
      row_schema: S;
      key: StateRowKeyMap[S];
      binding: VersionBinding | null;
    }): Promise<Result<StateRowTypeMap[S] | null, ErrorEnvelope>> {
      return reader.getStateRow(q);
    },
    listStateRows(q: {
      row_schemas: readonly StateRowSchema[];
      binding: VersionBinding | null;
      after_commit_seq?: number;
      limit: number;
    }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>> {
      return reader.listStateRows(q);
    },
    readStateRowsSnapshot(q: {
      binding: VersionBinding | null;
      keys: readonly StateRowReadKey[];
    }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>> {
      return reader.readStateRowsSnapshot(q);
    }
  };
}

/**
 * Alias for the FND `StateRowPort` factory.
 *
 * The port is the single entry point for typed state rows; the alias keeps
 * the name the DD-FND-059.1.6 contract uses.
 */
export function createStateRowPort(options: FndStateRowPortOptions): StateRowPort {
  return createFndStateRowPort(options);
}

/**
 * Creates the FND `StateRowLiveCommitPort`.
 *
 * The stage callback runs exactly once inside the single writer gate and
 * `BEGIN IMMEDIATE`; the port never awaits inside the stage.
 */
export function createFndLiveCommitPort(
  options: FndStateRowPortOptions
): StateRowLiveCommitPort {
  return createLiveCommitPort(options);
}

/** The receipt of one committed batch. */
export type { AppendStateRowsResult };
