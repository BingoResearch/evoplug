/**
 * In-memory `IdempotencyStorePort` for tests and local harnesses.
 *
 * Production uses the journal + SQLite implementation in storage/kernel; this
 * store has no fsync and must never be wired as a production default.
 */

import type { ErrorEnvelope, Hash, JsonValue, Result } from "@evoplug/core";
import { idempotencyConflictError, makeIpcError } from "../errors.js";
import type {
  IdempotencyBeginInput,
  IdempotencyBeginOutcome,
  IdempotencyFinishInput,
  IdempotencyFinishOutcome,
  IdempotencyState,
  IdempotencyStorePort,
} from "../idempotency.js";

interface Row {
  request_hash: Hash;
  state: IdempotencyState;
  result: JsonValue | null;
  expires_at: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStorePort {
  private readonly rows: Map<string, Row> = new Map<string, Row>();

  public async begin(input: IdempotencyBeginInput): Promise<Result<IdempotencyBeginOutcome, ErrorEnvelope>> {
    const key = rowKey(input);
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      if (existing.request_hash !== input.request_hash) {
        return {
          ok: false,
          status: "conflict",
          error: idempotencyConflictError({
            trace_id: input.trace_id,
            key: input.idempotency_key,
            existing_hash: existing.request_hash,
            incoming_hash: input.request_hash,
            method: input.method,
          }),
        };
      }
      switch (existing.state) {
        case "in_progress":
          return { ok: true, status: "ok", value: { state: "in_progress" } };
        case "uncertain":
          return { ok: true, status: "ok", value: { state: "uncertain" } };
        case "succeeded":
          return {
            ok: true,
            status: "ok",
            value: { state: "replay", status: "ok", result: existing.result ?? null },
          };
        case "failed":
          return {
            ok: true,
            status: "ok",
            value: { state: "replay", status: "failed", result: existing.result ?? null },
          };
      }
    }
    this.rows.set(key, {
      request_hash: input.request_hash,
      state: "in_progress",
      result: null,
      expires_at: input.lease_expires_at,
    });
    return { ok: true, status: "ok", value: { state: "started" } };
  }

  public async finish(input: IdempotencyFinishInput): Promise<Result<IdempotencyFinishOutcome, ErrorEnvelope>> {
    const key = rowKey(input);
    const existing = this.rows.get(key);
    if (existing === undefined) {
      return {
        ok: false,
        status: "unknown",
        error: makeIpcError("E_IPC_IDEMPOTENCY_UNCERTAIN", {
          trace_id: input.trace_id,
          method: input.method,
          connection_id: "-",
          frame_kind: "request",
        }),
      };
    }
    existing.state = input.state;
    existing.result = input.result;
    existing.expires_at = input.expires_at;
    return { ok: true, status: "ok", value: { state: input.state } };
  }

  /** Test hook: marks a row uncertain, as crash recovery does. */
  public markUncertain(client_id: string, method: string, idempotency_key: string): boolean {
    const key = `${client_id}:${method}:${idempotency_key}`;
    const existing = this.rows.get(key);
    if (existing === undefined) {
      return false;
    }
    existing.state = "uncertain";
    return true;
  }

  public get size(): number {
    return this.rows.size;
  }
}

function rowKey(input: {
  readonly client_id: string;
  readonly method: string;
  readonly idempotency_key: string;
}): string {
  return `${input.client_id}:${input.method}:${input.idempotency_key}`;
}
