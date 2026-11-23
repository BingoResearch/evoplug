/**
 * Request dispatcher: method lookup, deadline accounting, idempotency gating
 * and handler invocation (DD-FND-041, DD-FND-042).
 *
 * The dispatcher is transport- and storage-agnostic. Journal/SQLite work lives
 * behind `IdempotencyStorePort`; domain work lives behind `IpcHandler`.
 */

import type { ErrorEnvelope, Id, JsonValue, Result } from "@evoplug/core";
import { IPC_METHOD_IDEMPOTENCY, type IpcMethod, type IpcParams, type IpcResult } from "./methods.js";
import type { IpcClientKind } from "./protocol.js";
import { ipcFailure, schemaError } from "./errors.js";
import { toJsonValue } from "./json.js";
import {
  computeIdempotencyRequestHash,
  idempotencyExpiresAt,
  type IdempotencyStorePort,
} from "./idempotency.js";
import { IPC_MIN_WORK_MS } from "./protocol.js";
import type { DecodedRequest } from "./validation.js";

export interface IpcConnectionContext {
  readonly connection_id: string;
  readonly client_id: Id<"adp">;
  /**
   * Client kind from the authenticated hello. Optional so existing in-process
   * test harnesses keep working; absent means "unknown" and method
   * authorization that requires a kind must reject.
   */
  readonly client_kind?: IpcClientKind;
  readonly protocol_version: string;
}

export interface IpcHandlerContext<M extends IpcMethod> {
  readonly request_id: Id<"ipc">;
  readonly method: M;
  readonly params: IpcParams[M];
  readonly client_id: Id<"adp">;
  readonly client_kind?: IpcClientKind;
  readonly connection_id: string;
  /** Remaining work budget in milliseconds; never exceeds what the frame carried. */
  readonly remaining_ms: number;
  readonly signal: AbortSignal;
}

export type IpcHandler<M extends IpcMethod> = (
  context: IpcHandlerContext<M>,
) => Promise<Result<IpcResult[M], ErrorEnvelope>>;

export type IpcHandlerMap = { readonly [M in IpcMethod]?: IpcHandler<M> };

interface IpcDispatchInput<M extends IpcMethod> {
  readonly connection: IpcConnectionContext;
  readonly request: DecodedRequest & { readonly method: M };
  /** Remaining milliseconds at dispatch entry, after queue time was subtracted. */
  readonly remaining_ms: number;
  readonly signal: AbortSignal;
}

export type IpcDispatchOutcome<M extends IpcMethod> =
  | { readonly kind: "result"; readonly result: Result<IpcResult[M], ErrorEnvelope> }
  | { readonly kind: "replayed"; readonly result: JsonValue };

interface IpcDispatcherOptions {
  readonly handlers: IpcHandlerMap;
  readonly idempotency: IdempotencyStorePort;
  /** Monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now_mono?: () => number;
  /** Wall clock used only for persisted timestamps; defaults to `Date.now`. */
  readonly now_epoch?: () => number;
  readonly lease_owner?: string;
  readonly lease_ttl_ms?: number;
  readonly min_work_ms?: number;
}

const DEFAULT_LEASE_TTL_MS = 60_000;

export class IpcDispatcher {
  private readonly handlers: IpcHandlerMap;
  private readonly idempotency: IdempotencyStorePort;
  private readonly nowMono: () => number;
  private readonly nowEpoch: () => number;
  private readonly leaseOwner: string;
  private readonly leaseTtlMs: number;
  private readonly minWorkMs: number;

  public constructor(options: IpcDispatcherOptions) {
    this.handlers = options.handlers;
    this.idempotency = options.idempotency;
    this.nowMono = options.now_mono ?? ((): number => performance.now());
    this.nowEpoch = options.now_epoch ?? ((): number => Date.now());
    this.leaseOwner = options.lease_owner ?? `ipc:${String(process.pid)}`;
    this.leaseTtlMs = options.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS;
    this.minWorkMs = options.min_work_ms ?? IPC_MIN_WORK_MS;
  }

  public async dispatch<M extends IpcMethod>(input: IpcDispatchInput<M>): Promise<IpcDispatchOutcome<M>> {
    const { connection, request, signal } = input;
    const method = request.method;
    const traceId = request.request_id;
    const errorContext = {
      trace_id: traceId,
      method,
      connection_id: connection.connection_id,
      frame_kind: "request",
    } as const;

    const handler = this.handlers[method];
    if (handler === undefined) {
      return { kind: "result", result: ipcFailure("E_IPC_METHOD_UNKNOWN", errorContext) };
    }

    const policy = IPC_METHOD_IDEMPOTENCY[method];
    const idempotencyKey = request.idempotency_key;
    if (policy === "forbidden" && idempotencyKey !== undefined) {
      return { kind: "result", result: ipcFailure("E_IPC_METHOD_NOT_IDEMPOTENT", errorContext) };
    }
    if (policy === "required" && idempotencyKey === undefined) {
      return {
        kind: "result",
        result: {
          ok: false,
          status: "rejected",
          error: schemaError({
            trace_id: traceId,
            path: "idempotency_key",
            rule: "required",
            method,
            connection_id: connection.connection_id,
            frame_kind: "request",
          }),
        },
      };
    }

    if (signal.aborted) {
      return { kind: "result", result: ipcFailure("E_CANCELLED", errorContext) };
    }
    const startedAt = this.nowMono();
    const deadlineAt = startedAt + input.remaining_ms;
    if (input.remaining_ms < this.minWorkMs) {
      return { kind: "result", result: ipcFailure("E_DEADLINE_EXCEEDED", errorContext) };
    }

    if (policy === "required" && idempotencyKey !== undefined) {
      return this.dispatchIdempotent(input, handler, idempotencyKey, deadlineAt);
    }
    return {
      kind: "result",
      result: await this.invoke(handler, input, deadlineAt),
    };
  }

  private async dispatchIdempotent<M extends IpcMethod>(
    input: IpcDispatchInput<M>,
    handler: IpcHandler<M>,
    idempotencyKey: string,
    deadlineAt: number,
  ): Promise<IpcDispatchOutcome<M>> {
    const { connection, request, signal } = input;
    const method = request.method;
    const traceId = request.request_id;
    const errorContext = {
      trace_id: traceId,
      method,
      connection_id: connection.connection_id,
      frame_kind: "request",
    } as const;

    const paramsJson = toJsonValue(request.params);
    if (!paramsJson.ok) {
      return {
        kind: "result",
        result: {
          ok: false,
          status: "rejected",
          error: schemaError({
            trace_id: traceId,
            path: `params${paramsJson.path.slice(1)}`,
            rule: paramsJson.reason,
            method,
            connection_id: connection.connection_id,
            frame_kind: "request",
          }),
        },
      };
    }
    const requestHash = computeIdempotencyRequestHash(paramsJson.value);

    const began = await this.idempotency.begin({
      client_id: connection.client_id,
      method,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      lease_owner: this.leaseOwner,
      lease_expires_at: this.nowEpoch() + this.leaseTtlMs,
      created_at: this.nowEpoch(),
      trace_id: traceId,
    });
    if (!began.ok) {
      return {
        kind: "result",
        result: { ok: false, status: began.status, error: began.error },
      };
    }
    switch (began.value.state) {
      case "replay":
        return { kind: "replayed", result: began.value.result };
      case "in_progress":
        return { kind: "result", result: ipcFailure("E_IPC_IN_PROGRESS", errorContext) };
      case "uncertain":
        return { kind: "result", result: ipcFailure("E_IPC_IDEMPOTENCY_UNCERTAIN", errorContext) };
      case "started":
        break;
    }

    // `started` was journaled and fsynced; the row is in progress from here on.
    const remaining = deadlineAt - this.nowMono();
    let outcome: Result<IpcResult[M], ErrorEnvelope>;
    if (signal.aborted) {
      outcome = ipcFailure("E_CANCELLED", errorContext);
    } else if (remaining < this.minWorkMs) {
      outcome = ipcFailure("E_DEADLINE_EXCEEDED", errorContext);
    } else {
      outcome = await this.invoke(handler, input, deadlineAt);
    }

    const serialized = toJsonValue(outcome);
    if (!serialized.ok) {
      // The handler produced a non-JSON value; the idempotency row cannot be
      // closed with a faithful response, so success must not be reported.
      return { kind: "result", result: ipcFailure("E_INTERNAL", errorContext) };
    }
    const finished = await this.idempotency.finish({
      client_id: connection.client_id,
      method,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      state: outcome.ok ? "succeeded" : "failed",
      result: serialized.value,
      expires_at: idempotencyExpiresAt(method, this.nowEpoch()),
      trace_id: traceId,
    });
    if (!finished.ok) {
      return {
        kind: "result",
        result: { ok: false, status: finished.status, error: finished.error },
      };
    }
    return { kind: "result", result: outcome };
  }

  private async invoke<M extends IpcMethod>(
    handler: IpcHandler<M>,
    input: IpcDispatchInput<M>,
    deadlineAt: number,
  ): Promise<Result<IpcResult[M], ErrorEnvelope>> {
    const remaining = deadlineAt - this.nowMono();
    if (remaining < this.minWorkMs) {
      return ipcFailure("E_DEADLINE_EXCEEDED", {
        trace_id: input.request.request_id,
        method: input.request.method,
        connection_id: input.connection.connection_id,
        frame_kind: "request",
      });
    }
    if (input.signal.aborted) {
      return ipcFailure("E_CANCELLED", {
        trace_id: input.request.request_id,
        method: input.request.method,
        connection_id: input.connection.connection_id,
        frame_kind: "request",
      });
    }
    const context: IpcHandlerContext<M> = {
      request_id: input.request.request_id,
      method: input.request.method,
      params: input.request.params as IpcParams[M],
      client_id: input.connection.client_id,
      ...(input.connection.client_kind === undefined
        ? {}
        : { client_kind: input.connection.client_kind }),
      connection_id: input.connection.connection_id,
      remaining_ms: Math.max(0, Math.floor(remaining)),
      signal: input.signal,
    };
    try {
      return await handler(context);
    } catch {
      return ipcFailure(input.signal.aborted ? "E_CANCELLED" : "E_INTERNAL", {
        trace_id: input.request.request_id,
        method: input.request.method,
        connection_id: input.connection.connection_id,
        frame_kind: "request",
      });
    }
  }
}
