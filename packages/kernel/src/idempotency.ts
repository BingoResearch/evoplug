/**
 * `ipc_idempotency` persistence (DD-FND-041, DD-FND-097.7).
 *
 * Order is fixed: the journal frame is appended and fsynced by the journal port
 * first, then a short SQLite transaction inserts or CASes the row. The handler
 * never runs inside a transaction.
 *
 * The journal port is the FND journal writer face (`ipc_idempotency.started` /
 * `finished` ledger events). No package currently exports that event builder;
 * `createUnavailableIdempotencyJournal` makes the gap explicit instead of
 * writing a second event schema.
 */

import type { ErrorEnvelope, Hash, Id, JsonValue, Result } from "@evoplug/core";
import { isJsonValue } from "@evoplug/core";
import type {
  IdempotencyBeginInput,
  IdempotencyBeginOutcome,
  IdempotencyFinishInput,
  IdempotencyFinishOutcome,
  IdempotencyStorePort
} from "@evoplug/ipc";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";
import { internalError, kernelError } from "./errors.js";

export type IdempotencyRowState = "in_progress" | "succeeded" | "failed" | "uncertain";

/** Complete after-image row handed to the journal writer. */
export interface IdempotencyRowSnapshot {
  readonly client_id: Id<"adp">;
  readonly method: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly state: IdempotencyRowState;
  readonly response_json: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: number | null;
  readonly created_at: number;
  readonly expires_at: number;
}

/**
 * Journal face required before the SQLite step. Implemented by the FND journal
 * writer; a frame append failure aborts the request with zero row changes.
 */
export interface IdempotencyJournalPort {
  recordStarted(row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>>;
  recordFinished(row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>>;
  /**
   * True when the journal already holds a finished frame for this request.
   * A journal without this query cannot distinguish a live request from a
   * crashed one, so the caller keeps the `in_progress` behaviour.
   */
  hasFinished?(row: IdempotencyRowSnapshot): Promise<boolean>;
  /**
   * Transitions a crashed `in_progress` row to `uncertain`
   * (DD-FND-041). A journal without this transition keeps the row.
   */
  recordUncertain?(row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>>;
}

/** Test double: records every frame in memory and never fails. */
interface InMemoryIdempotencyJournal extends IdempotencyJournalPort {
  started(): readonly IdempotencyRowSnapshot[];
  finished(): readonly IdempotencyRowSnapshot[];
}

export function createInMemoryIdempotencyJournal(): InMemoryIdempotencyJournal {
  const started: IdempotencyRowSnapshot[] = [];
  const finished: IdempotencyRowSnapshot[] = [];
  return {
    recordStarted: async (row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>> => {
      started.push(row);
      return { ok: true, status: "ok", value: undefined };
    },
    recordFinished: async (row: IdempotencyRowSnapshot): Promise<Result<void, ErrorEnvelope>> => {
      finished.push(row);
      return { ok: true, status: "ok", value: undefined };
    },
    started: (): readonly IdempotencyRowSnapshot[] => started,
    finished: (): readonly IdempotencyRowSnapshot[] => finished
  };
}

type IdempotencyDbRow = SqlRow & {
  readonly state: string;
  readonly request_hash: Hash;
  readonly response_json: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: number | null;
  readonly created_at: number;
  readonly expires_at: number;
};

const SELECT_ROW = `SELECT state, request_hash, response_json, lease_owner, lease_expires_at, created_at, expires_at
  FROM ipc_idempotency
 WHERE client_id = :client_id AND method = :method AND idempotency_key = :idempotency_key`;

const INSERT_ROW = `INSERT INTO ipc_idempotency
  (client_id, method, idempotency_key, request_hash, state, response_json, lease_owner, lease_expires_at, created_at, expires_at)
  VALUES (:client_id, :method, :idempotency_key, :request_hash, :state, NULL, :lease_owner, :lease_expires_at, :created_at, :expires_at)`;

const FINISH_ROW = `UPDATE ipc_idempotency
  SET state = :state,
      response_json = :response_json,
      lease_owner = NULL,
      lease_expires_at = NULL,
      expires_at = :expires_at
WHERE client_id = :client_id AND method = :method AND idempotency_key = :idempotency_key
  AND state = 'in_progress' AND request_hash = :request_hash`;

/** The request crashed before its finished frame; the key is now uncertain. */
function idempotencyUncertain(
  key: string,
  existingHash: Hash,
  incomingHash: Hash
): ErrorEnvelope {
  return kernelError("E_IPC_IDEMPOTENCY_UNCERTAIN", {
    details: { kind: "idempotency", key, existing_hash: existingHash, incoming_hash: incomingHash }
  });
}

function conflict(existingHash: Hash, incomingHash: Hash, key: string): ErrorEnvelope {
  return kernelError("E_IDEMPOTENCY_CONFLICT", {
    details: { kind: "idempotency", key, existing_hash: existingHash, incoming_hash: incomingHash }
  });
}

function parseStoredResult(text: string | null): JsonValue | null {
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isJsonValue(parsed) ? parsed : null;
}

function readRow(input: {
  readonly client_id: Id<"adp">;
  readonly method: string;
  readonly idempotency_key: string;
}, connection: SqliteConnection): IdempotencyDbRow | null {
  const row = connection.prepare<IdempotencyDbRow>(SELECT_ROW).get({
    client_id: input.client_id,
    method: input.method,
    idempotency_key: input.idempotency_key
  });
  return row ?? null;
}

interface SqliteIdempotencyStoreOptions {
  readonly connection: SqliteConnection;
  readonly journal: IdempotencyJournalPort;
}

/**
 * SQLite-backed `IdempotencyStorePort`. The connection is the single writer
 * connection; inserts and CAS updates run as one statement each, so no
 * transaction can straddle a handler await.
 */
export function createSqliteIdempotencyStore(
  options: SqliteIdempotencyStoreOptions
): IdempotencyStorePort {
  const { connection, journal } = options;

  /**
   * True when the stored `in_progress` row comes from a crashed request:
   * the journal holds no finished frame for it (DD-FND-041).
   */
  const isCrashedInProgress = async (
    existing: IdempotencyDbRow,
    input: IdempotencyBeginInput
  ): Promise<boolean> => {
    if (journal.hasFinished === undefined) {
      return false;
    }
    const finished = await journal.hasFinished({
      client_id: input.client_id,
      method: input.method,
      idempotency_key: input.idempotency_key,
      request_hash: existing.request_hash,
      state: "in_progress",
      response_json: null,
      lease_owner: existing.lease_owner,
      lease_expires_at: existing.lease_expires_at,
      created_at: existing.created_at,
      expires_at: existing.expires_at
    });
    if (finished) {
      return false;
    }
    if (journal.recordUncertain !== undefined) {
      const uncertain = await journal.recordUncertain({
        client_id: input.client_id,
        method: input.method,
        idempotency_key: input.idempotency_key,
        request_hash: existing.request_hash,
        state: "uncertain",
        response_json: null,
        lease_owner: existing.lease_owner,
        lease_expires_at: existing.lease_expires_at,
        created_at: existing.created_at,
        expires_at: existing.expires_at
      });
      if (!uncertain.ok) {
        return false;
      }
    }
    return true;
  };

  const begin = async (
    input: IdempotencyBeginInput
  ): Promise<Result<IdempotencyBeginOutcome, ErrorEnvelope>> => {
      const existing = readRow(
        {
          client_id: input.client_id,
          method: input.method,
          idempotency_key: input.idempotency_key
        },
        connection
      );
      if (existing !== null) {
        if (existing.request_hash !== input.request_hash) {
          return { ok: false, status: "conflict", error: conflict(existing.request_hash, input.request_hash, input.idempotency_key) };
        }
        switch (existing.state) {
          case "in_progress": {
            // DD-FND-041: a crashed request leaves an `in_progress` row
            // without a finished frame. Such a row becomes `uncertain` and
            // the same key never runs the handler again.
            const crashed = await isCrashedInProgress(existing, input);
            if (crashed) {
              return {
                ok: false,
                status: "rejected",
                error: idempotencyUncertain(
                  input.idempotency_key,
                  existing.request_hash,
                  input.request_hash
                )
              };
            }
            return { ok: true, status: "ok", value: { state: "in_progress" } };
          }
          case "uncertain":
            return { ok: true, status: "ok", value: { state: "uncertain" } };
          case "succeeded":
          case "failed": {
            const stored = parseStoredResult(existing.response_json);
            if (stored === null) {
              return { ok: false, status: "rejected", error: internalError("kernel.idempotency_response_unreadable") };
            }
            return {
              ok: true,
              status: "ok",
              value: {
                state: "replay",
                status: existing.state === "succeeded" ? "ok" : "failed",
                result: stored
              }
            };
          }
          default:
            return { ok: false, status: "rejected", error: internalError("kernel.idempotency_state_unknown") };
        }
      }

      const snapshot: IdempotencyRowSnapshot = {
        client_id: input.client_id,
        method: input.method,
        idempotency_key: input.idempotency_key,
        request_hash: input.request_hash,
        state: "in_progress",
        response_json: null,
        lease_owner: input.lease_owner,
        lease_expires_at: input.lease_expires_at,
        created_at: input.created_at,
        expires_at: input.lease_expires_at
      };
      const journaled = await journal.recordStarted(snapshot);
      if (!journaled.ok) {
        return { ok: false, status: journaled.status, error: journaled.error };
      }
      try {
        connection.prepare(INSERT_ROW).run({
          client_id: input.client_id,
          method: input.method,
          idempotency_key: input.idempotency_key,
          request_hash: input.request_hash,
          state: "in_progress",
          lease_owner: input.lease_owner,
          lease_expires_at: input.lease_expires_at,
          created_at: input.created_at,
          expires_at: input.lease_expires_at
        });
      } catch {
        // A concurrent request won the unique key: report in-progress unless
        // its hash differs.
        const raced = readRow(
          {
            client_id: input.client_id,
            method: input.method,
            idempotency_key: input.idempotency_key
          },
          connection
        );
        if (raced !== null && raced.request_hash !== input.request_hash) {
          return { ok: false, status: "conflict", error: conflict(raced.request_hash, input.request_hash, input.idempotency_key) };
        }
        return { ok: true, status: "ok", value: { state: "in_progress" } };
      }
      return { ok: true, status: "ok", value: { state: "started" } };
  };

  const finish = async (
    input: IdempotencyFinishInput
  ): Promise<Result<IdempotencyFinishOutcome, ErrorEnvelope>> => {
      const existing = readRow(
        {
          client_id: input.client_id,
          method: input.method,
          idempotency_key: input.idempotency_key
        },
        connection
      );
      if (existing === null) {
        return { ok: false, status: "rejected", error: internalError("kernel.idempotency_row_missing") };
      }
      if (existing.request_hash !== input.request_hash) {
        return { ok: false, status: "conflict", error: conflict(existing.request_hash, input.request_hash, input.idempotency_key) };
      }
      if (existing.state !== "in_progress") {
        return { ok: true, status: "ok", value: { state: existing.state === "failed" ? "failed" : "succeeded" } };
      }
      const responseJson = JSON.stringify(input.result);
      const snapshot: IdempotencyRowSnapshot = {
        client_id: input.client_id,
        method: input.method,
        idempotency_key: input.idempotency_key,
        request_hash: input.request_hash,
        state: input.state,
        response_json: responseJson,
        lease_owner: null,
        lease_expires_at: null,
        created_at: existing.created_at,
        expires_at: input.expires_at
      };
      const journaled = await journal.recordFinished(snapshot);
      if (!journaled.ok) {
        return { ok: false, status: journaled.status, error: journaled.error };
      }
      const result = connection.prepare(FINISH_ROW).run({
        state: input.state,
        response_json: responseJson,
        expires_at: input.expires_at,
        client_id: input.client_id,
        method: input.method,
        idempotency_key: input.idempotency_key,
        request_hash: input.request_hash
      });
      if (result.changes !== 1) {
        return {
          ok: false,
          status: "degraded",
          error: kernelError("E_IPC_IDEMPOTENCY_UNCERTAIN", { details: { kind: "none" } })
        };
      }
      return { ok: true, status: "ok", value: { state: input.state } };
  };

  return { begin, finish };
}
