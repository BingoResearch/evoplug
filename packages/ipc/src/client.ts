/**
 * Unix-domain-socket IPC client (DD-FND-040, DD-FND-041).
 *
 * The client sends one hello per connection, then correlates responses by
 * `request_id`; responses may arrive out of order. A local timeout or an
 * explicit `cancel` resolves the caller with `E_CANCELLED` /
 * `E_DEADLINE_EXCEEDED` and sends a cancel frame so the server can stop work.
 */

import { connect, type Socket } from "node:net";
import type { ErrorEnvelope, Id, Result } from "@evoplug/core";
import { newId } from "@evoplug/core";
import {
  FrameReader,
  IpcFrameKind,
  encodeFrame,
  type IpcFrame,
} from "./frame.js";
import {
  IPC_MAX_INFLIGHT_PER_CONNECTION,
  IPC_PROTOCOL_VERSION,
  isRequestDeadlineInRange,
  type HelloFrame,
  type IpcClientKind,
} from "./protocol.js";
import { decodeJson, encodeJson, toJsonValue } from "./json.js";
import { IPC_ERROR_REGISTRY, isIpcErrorCode, makeIpcError, schemaError, type IpcErrorCode } from "./errors.js";
import type { IpcMethod, IpcParams, IpcResult } from "./methods.js";
import { isValidIdempotencyKey } from "./methods.js";
import { validateResponse, type DecodedResult } from "./validation.js";
import {
  readEndpointDescriptor,
  readIpcToken,
  runtimePaths,
  type EndpointDescriptor,
} from "./endpoint.js";

export const DEFAULT_CLIENT_DEADLINE_MS = 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;

export interface IpcClientOptions {
  readonly evoplug_home: string;
  readonly client_id: Id<"adp">;
  readonly client_kind: IpcClientKind;
  readonly product_version?: string;
  readonly pid?: number;
  readonly default_deadline_ms?: number;
  readonly connect_timeout_ms?: number;
  /** Explicit socket path; defaults to `endpoint.json`. */
  readonly socket_path?: string;
  /** Explicit token path; defaults to `endpoint.json`. */
  readonly token_path?: string;
}

export interface IpcRequestOptions {
  /** Remaining milliseconds; 1..600000. Defaults to `default_deadline_ms`. */
  readonly deadline_ms?: number;
  /** Required for mutating methods, forbidden for read-only ones. */
  readonly idempotency_key?: string;
  /** Aborting sends a cancel frame and resolves the caller with `E_CANCELLED`. */
  readonly signal?: AbortSignal;
}

type ClientOutcome =
  | { readonly kind: "response"; readonly result: DecodedResult }
  | { readonly kind: "error"; readonly error: ErrorEnvelope };

interface PendingRequest {
  readonly method: IpcMethod;
  readonly settle: (outcome: ClientOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
}

export class IpcClient {
  private readonly socket: Socket;
  private readonly reader: FrameReader = new FrameReader();
  private readonly pending: Map<Id<"ipc">, PendingRequest> = new Map<Id<"ipc">, PendingRequest>();
  private readonly slotWaiters: Array<() => void> = [];
  private readonly maxInflight: number;
  private readonly defaultDeadlineMs: number;
  private readonly endpoint: EndpointDescriptor | null;
  private closed = false;

  private constructor(socket: Socket, endpoint: EndpointDescriptor | null, options: IpcClientOptions) {
    this.socket = socket;
    this.endpoint = endpoint;
    this.maxInflight = IPC_MAX_INFLIGHT_PER_CONNECTION;
    this.defaultDeadlineMs = options.default_deadline_ms ?? DEFAULT_CLIENT_DEADLINE_MS;

    socket.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on("error", () => {
      this.failAll("E_IPC_DISCONNECTED");
    });
    socket.on("close", () => {
      this.failAll("E_IPC_DISCONNECTED");
    });
  }

  public static async connect(options: IpcClientOptions): Promise<Result<IpcClient, ErrorEnvelope>> {
    const traceId = newId("ipc");
    const paths = runtimePaths(options.evoplug_home);
    let endpoint: EndpointDescriptor | null = null;
    let socketPath: string;
    let tokenPath: string;

    if (options.socket_path !== undefined && options.token_path !== undefined) {
      socketPath = options.socket_path;
      tokenPath = options.token_path;
    } else {
      const descriptor = await readEndpointDescriptor(paths.endpoint_path);
      if (!descriptor.ok) {
        return {
          ok: false,
          status: "rejected",
          error: makeIpcError("E_IPC_DISCONNECTED", {
            trace_id: traceId,
            method: "hello",
            connection_id: "-",
            frame_kind: "hello",
          }),
        };
      }
      endpoint = descriptor.value;
      socketPath = options.socket_path ?? descriptor.value.socket_path;
      tokenPath = options.token_path ?? descriptor.value.token_path;
    }

    const token = await readIpcToken(tokenPath);
    if (!token.ok) {
      return {
        ok: false,
        status: "rejected",
        error: makeIpcError("E_IPC_AUTH", {
          trace_id: traceId,
          method: "hello",
          connection_id: "-",
          frame_kind: "hello",
        }),
      };
    }

    const socket = await openSocket(socketPath, options.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS);
    if (!socket.ok) {
      return {
        ok: false,
        status: "rejected",
        error: makeIpcError("E_IPC_DISCONNECTED", {
          trace_id: traceId,
          method: "hello",
          connection_id: "-",
          frame_kind: "hello",
        }),
      };
    }

    const hello: HelloFrame = {
      schema_version: "rsi.ipc_hello/1",
      protocol_version: IPC_PROTOCOL_VERSION,
      client_id: options.client_id,
      client_kind: options.client_kind,
      product_version: options.product_version ?? "0.0.0",
      pid: options.pid ?? process.pid,
      token: token.value,
    };
    const helloJson = toJsonValue(hello);
    if (!helloJson.ok) {
      socket.value.destroy();
      return {
        ok: false,
        status: "rejected",
        error: schemaError({
          trace_id: traceId,
          path: "hello",
          rule: helloJson.reason,
          method: "hello",
          frame_kind: "hello",
        }),
      };
    }
    const frame = encodeFrame({
      kind: IpcFrameKind.Hello,
      deadline_ms: 1000,
      body: encodeJson(helloJson.value),
    });
    const client = new IpcClient(socket.value, endpoint, options);
    await new Promise<void>((resolve, reject) => {
      socket.value.write(frame, (error?: Error | null) => {
        if (error === undefined || error === null) {
          resolve();
          return;
        }
        reject(error);
      });
    }).catch(() => {
      // The socket close handler surfaces E_IPC_DISCONNECTED to later requests.
    });
    return { ok: true, status: "ok", value: client };
  }

  public get connected(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  public get descriptor(): EndpointDescriptor | null {
    return this.endpoint;
  }

  public async request<M extends IpcMethod>(
    method: M,
    params: IpcParams[M],
    options?: IpcRequestOptions,
  ): Promise<Result<IpcResult[M], ErrorEnvelope>> {
    const traceId = newId("ipc");
    const deadlineMs = options?.deadline_ms ?? this.defaultDeadlineMs;
    if (!isRequestDeadlineInRange(deadlineMs)) {
      return {
        ok: false,
        status: "rejected",
        error: schemaError({
          trace_id: traceId,
          path: "deadline_ms",
          rule: "range_1_600000",
          method,
          frame_kind: "request",
        }),
      };
    }
    const key = options?.idempotency_key;
    if (key !== undefined && !isValidIdempotencyKey(key)) {
      return {
        ok: false,
        status: "rejected",
        error: schemaError({
          trace_id: traceId,
          path: "idempotency_key",
          rule: "pattern",
          method,
          frame_kind: "request",
        }),
      };
    }
    if (!this.connected) {
      return failure("E_IPC_DISCONNECTED", traceId, method);
    }

    await this.acquireSlot();
    if (!this.connected) {
      this.releaseSlot();
      return failure("E_IPC_DISCONNECTED", traceId, method);
    }

    const requestId = newId("ipc");
    const body = toJsonValue({
      schema_version: "rsi.ipc_request/1",
      request_id: requestId,
      method,
      ...(key === undefined ? {} : { idempotency_key: key }),
      params,
    });
    if (!body.ok) {
      this.releaseSlot();
      return {
        ok: false,
        status: "rejected",
        error: schemaError({
          trace_id: traceId,
          path: `params${body.path.slice(1)}`,
          rule: body.reason,
          method,
          frame_kind: "request",
        }),
      };
    }

    const outcomePromise = new Promise<ClientOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.sendCancel(requestId);
        this.finishRequest(requestId, {
          kind: "error",
          error: makeIpcError("E_DEADLINE_EXCEEDED", {
            trace_id: requestId,
            method,
            connection_id: this.connectionId(),
            frame_kind: "request",
          }),
        });
      }, deadlineMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      const external = options?.signal;
      const onAbort = (): void => {
        this.cancel(requestId);
      };
      const cleanup = (): void => {
        if (external !== undefined) {
          external.removeEventListener("abort", onAbort);
        }
      };
      this.pending.set(requestId, { method, settle: resolve, timer, cleanup });
      if (external !== undefined) {
        if (external.aborted) {
          onAbort();
        } else {
          external.addEventListener("abort", onAbort, { once: true });
        }
      }
    });

    try {
      if (this.pending.has(requestId)) {
        const frame = encodeFrame({
          kind: IpcFrameKind.Request,
          deadline_ms: deadlineMs,
          body: encodeJson(body.value),
        });
        this.socket.write(frame);
      }
    } catch {
      this.finishRequest(requestId, {
        kind: "error",
        error: makeIpcError("E_IPC_PROTOCOL", {
          trace_id: requestId,
          method,
          connection_id: this.connectionId(),
          frame_kind: "request",
        }),
      });
    }

    const outcome = await outcomePromise;
    if (outcome.kind === "error") {
      return { ok: false, status: statusOf(outcome.error, "rejected"), error: outcome.error };
    }
    if (outcome.result.kind === "failure") {
      return { ok: false, status: outcome.result.status, error: outcome.result.error };
    }
    // Wire payloads are typed by the method table; the envelope was validated.
    return {
      ok: true,
      status: outcome.result.status,
      value: outcome.result.value as IpcResult[M],
    };
  }

  /**
   * Cancels the local wait for `requestId` and asks the server to abort. The
   * server still emits a final response, which is ignored because no waiter
   * remains.
   */
  public cancel(requestId: Id<"ipc">): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.sendCancel(requestId);
    this.finishRequest(requestId, {
      kind: "error",
      error: makeIpcError("E_CANCELLED", {
        trace_id: requestId,
        method: pending.method,
        connection_id: this.connectionId(),
        frame_kind: "cancel",
      }),
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.failAll("E_IPC_DISCONNECTED");
  }

  private onData(chunk: Uint8Array): void {
    const results = this.reader.push(chunk);
    for (const result of results) {
      if (result.kind === "error") {
        this.failAll("E_IPC_PROTOCOL");
        this.socket.destroy();
        return;
      }
      this.onFrame(result.frame);
    }
  }

  private onFrame(frame: IpcFrame): void {
    if (frame.header.kind !== IpcFrameKind.Response) {
      this.failAll("E_IPC_PROTOCOL");
      this.socket.destroy();
      return;
    }
    const decoded = decodeJson(frame.body);
    if (!decoded.ok) {
      this.failAll("E_IPC_PROTOCOL");
      this.socket.destroy();
      return;
    }
    const response = validateResponse(decoded.value);
    if (!response.ok) {
      this.failAll("E_IPC_PROTOCOL");
      this.socket.destroy();
      return;
    }
    const pending = this.pending.get(response.value.request_id);
    if (pending === undefined) {
      return;
    }
    this.finishRequest(response.value.request_id, { kind: "response", result: response.value.result });
  }

  private finishRequest(requestId: Id<"ipc">, outcome: ClientOutcome): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.cleanup();
    pending.settle(outcome);
    this.releaseSlot();
  }

  private sendCancel(requestId: Id<"ipc">): void {
    if (!this.connected) {
      return;
    }
    const body = toJsonValue({ schema_version: "rsi.ipc_cancel/1", request_id: requestId });
    if (!body.ok) {
      return;
    }
    try {
      this.socket.write(encodeFrame({ kind: IpcFrameKind.Cancel, deadline_ms: 1, body: encodeJson(body.value) }));
    } catch {
      // the connection is already gone
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.pending.size + this.slotWaiters.length < this.maxInflight) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  private failAll(code: IpcErrorCode): void {
    for (const [requestId, pending] of [...this.pending.entries()]) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.settle({
        kind: "error",
        error: makeIpcError(code, {
          trace_id: requestId,
          method: pending.method,
          connection_id: this.connectionId(),
          frame_kind: "response",
        }),
      });
    }
    while (this.slotWaiters.length > 0) {
      const waiter = this.slotWaiters.shift();
      waiter?.();
    }
  }

  private connectionId(): string {
    return this.endpoint?.boot_id ?? "-";
  }
}

function statusOf(
  error: ErrorEnvelope,
  fallback: "rejected",
): "degraded" | "rejected" | "conflict" | "pending" | "unknown" {
  if (isIpcErrorCode(error.code)) {
    return IPC_ERROR_REGISTRY[error.code].failure_status;
  }
  return fallback;
}

function failure<M extends IpcMethod>(
  code: IpcErrorCode,
  traceId: Id<"ipc">,
  method: M,
): Result<IpcResult[M], ErrorEnvelope> {
  return {
    ok: false,
    status: IPC_ERROR_REGISTRY[code].failure_status,
    error: makeIpcError(code, { trace_id: traceId, method, connection_id: "-", frame_kind: "request" }),
  };
}

async function openSocket(
  path: string,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly value: Socket } | { readonly ok: false }> {
  return new Promise((resolve) => {
    const socket = connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false });
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({ ok: true, value: socket });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false });
    });
  });
}
