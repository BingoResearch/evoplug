/**
 * Unix-domain-socket IPC server (DD-FND-040, DD-FND-043).
 *
 * Authentication order is fixed: hello within 1000 ms, token constant-time
 * comparison, protocol major, frame/body limits. Any header invariant violation
 * closes the connection immediately; the stream is never resynchronised.
 */

import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import type { ErrorEnvelope, Id, JsonValue } from "@evoplug/core";
import { isId, newId } from "@evoplug/core";
import {
  FrameReader,
  IpcFrameKind,
  encodeFrame,
  isValidFrameDeadline,
  type IpcFrame,
} from "./frame.js";
import {
  IPC_HELLO_TIMEOUT_MS,
  IPC_MAX_INFLIGHT_PER_CONNECTION,
  IPC_MAX_REQUEST_DEADLINE_MS,
  IPC_PROTOCOL_MAJOR,
  IPC_PROTOCOL_VERSION,
  IPC_RESPONSE_SCHEMA_VERSION,
  isRequestDeadlineInRange,
  protocolMajor,
  type IpcClientKind,
} from "./protocol.js";
import { decodeJson, encodeJson, toJsonValue } from "./json.js";
import { makeIpcError, schemaError, type IpcErrorCode } from "./errors.js";
import { isIpcMethod, type IpcMethod } from "./methods.js";
import {
  IpcDispatcher,
  type IpcConnectionContext,
  type IpcDispatchOutcome,
  type IpcHandlerMap,
} from "./dispatcher.js";
import type { IdempotencyStorePort } from "./idempotency.js";
import {
  IPC_FILE_MODE,
  ensureRuntimeDir,
  rotateIpcToken,
  runtimePaths,
  tokensEqual,
  verifyRuntimePermissions,
  writeEndpointDescriptor,
  type EndpointDescriptor,
  type RuntimePaths,
} from "./endpoint.js";
import { validateCancel, validateHello, validateRequest, type DecodedRequest } from "./validation.js";

export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_MAX_INFLIGHT_TOTAL = 128;

export type IpcCloseReason =
  | "peer_closed"
  | "hello_timeout"
  | "hello_invalid"
  | "auth_failed"
  | "protocol_violation"
  | "truncated"
  | "socket_error"
  | "server_shutdown"
  | "connection_limit";

/** Per-connection record. Never contains body text, token or evidence excerpts. */
export interface IpcConnectionRecord {
  readonly connection_id: string;
  readonly client_id: Id<"adp"> | null;
  readonly client_kind: IpcClientKind | null;
  readonly protocol_version: string | null;
  readonly opened_at: number;
  readonly closed_at: number;
  readonly close_reason: IpcCloseReason;
  readonly request_count: number;
  readonly bad_frame_count: number;
}

export interface IpcConnectionLogSink {
  record(entry: IpcConnectionRecord): void;
}

export interface IpcServerStats {
  readonly active_connections: number;
  readonly total_connections: number;
  readonly rejected_connections: number;
  readonly bad_frames: number;
  readonly requests_total: number;
  readonly requests_failed: number;
  readonly inflight_requests: number;
}

export interface IpcServerOptions {
  /** `<EVOPLUG_HOME>`; the runtime tree is derived from it. */
  readonly evoplug_home: string;
  readonly handlers: IpcHandlerMap;
  readonly idempotency: IdempotencyStorePort;
  readonly max_connections?: number;
  readonly max_inflight_per_connection?: number;
  readonly max_inflight_total?: number;
  readonly hello_timeout_ms?: number;
  readonly min_work_ms?: number;
  readonly boot_id?: string;
  readonly connection_log?: IpcConnectionLogSink;
  readonly now_epoch?: () => number;
  readonly now_mono?: () => number;
}

export class IpcServerStartError extends Error {
  public readonly reason: string;

  public constructor(reason: string) {
    super(`ipc_server_start_failed: ${reason}`);
    this.name = "IpcServerStartError";
    this.reason = reason;
  }
}

interface ConnectionState {
  readonly socket: Socket;
  readonly reader: FrameReader;
  readonly opened_at: number;
  readonly inflight: Map<string, AbortController>;
  connection_id: string;
  client_id: Id<"adp"> | null;
  client_kind: IpcClientKind | null;
  hello_received: boolean;
  closed: boolean;
  request_count: number;
  bad_frame_count: number;
  hello_timer: ReturnType<typeof setTimeout> | null;
  write_chain: Promise<void>;
}

export class IpcServer {
  private readonly paths: RuntimePaths;
  private readonly dispatcher: IpcDispatcher;
  private readonly maxConnections: number;
  private readonly maxInflightPerConnection: number;
  private readonly maxInflightTotal: number;
  private readonly helloTimeoutMs: number;
  private readonly bootId: string;
  private readonly connectionLog: IpcConnectionLogSink | null;
  private readonly nowEpoch: () => number;
  private readonly nowMono: () => number;

  private readonly sockets: Map<string, ConnectionState> = new Map<string, ConnectionState>();
  /**
   * Every request dispatch that has not settled yet. `server.close()` stops the
   * listening socket but not an already-running handler, so shutdown must await
   * these before the owner closes the database those handlers use.
   */
  private readonly inflightDispatches: Set<Promise<void>> = new Set<Promise<void>>();
  private server: Server | null = null;
  private token: string | null = null;
  private endpoint: EndpointDescriptor | null = null;
  private shuttingDown = false;
  private totalConnections = 0;
  private rejectedConnections = 0;
  private badFrames = 0;
  private requestsTotal = 0;
  private requestsFailed = 0;

  private constructor(options: IpcServerOptions) {
    this.paths = runtimePaths(options.evoplug_home);
    this.maxConnections = options.max_connections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxInflightPerConnection = options.max_inflight_per_connection ?? IPC_MAX_INFLIGHT_PER_CONNECTION;
    this.maxInflightTotal = options.max_inflight_total ?? DEFAULT_MAX_INFLIGHT_TOTAL;
    this.helloTimeoutMs = options.hello_timeout_ms ?? IPC_HELLO_TIMEOUT_MS;
    this.bootId = options.boot_id ?? newId("ipc");
    this.connectionLog = options.connection_log ?? null;
    this.nowEpoch = options.now_epoch ?? ((): number => Date.now());
    this.nowMono = options.now_mono ?? ((): number => performance.now());
    this.dispatcher = new IpcDispatcher({
      handlers: options.handlers,
      idempotency: options.idempotency,
      now_epoch: this.nowEpoch,
      now_mono: this.nowMono,
      ...(options.min_work_ms === undefined ? {} : { min_work_ms: options.min_work_ms }),
    });
  }

  /**
   * Prepares the runtime tree, rotates the token, binds the socket and writes
   * `endpoint.json`. Throws `IpcServerStartError` when the runtime tree cannot
   * be trusted (wrong modes, symlink, bind failure).
   */
  public static async start(options: IpcServerOptions): Promise<IpcServer> {
    const server = new IpcServer(options);
    try {
      await server.listen();
    } catch (error) {
      await server.close();
      throw error;
    }
    return server;
  }

  public get descriptor(): EndpointDescriptor {
    if (this.endpoint === null) {
      throw new IpcServerStartError("not_listening");
    }
    return this.endpoint;
  }

  public get stats(): IpcServerStats {
    let inflight = 0;
    for (const connection of this.sockets.values()) {
      inflight += connection.inflight.size;
    }
    return {
      active_connections: this.sockets.size,
      total_connections: this.totalConnections,
      rejected_connections: this.rejectedConnections,
      bad_frames: this.badFrames,
      requests_total: this.requestsTotal,
      requests_failed: this.requestsFailed,
      inflight_requests: inflight,
    };
  }

  public async close(): Promise<void> {
    this.shuttingDown = true;
    // Abort first: handlers that honor the signal can settle on their own, and
    // the socket destruction below is only a transport action.
    for (const connection of [...this.sockets.values()]) {
      this.closeConnection(connection, "server_shutdown");
    }
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    // `server.close` resolves when the listening socket closes, not when a
    // dispatch already running in-process finishes. Wait for the real handler
    // promises so the owner can safely close the database they read.
    await Promise.allSettled([...this.inflightDispatches]);
    try {
      await unlink(this.paths.socket_path);
    } catch {
      // the socket may already be gone
    }
    try {
      await unlink(this.paths.endpoint_path);
    } catch {
      // the descriptor may already be gone
    }
  }

  private async listen(): Promise<void> {
    const directory = await ensureRuntimeDir(this.paths.runtime_dir);
    if (!directory.ok) {
      throw new IpcServerStartError(`runtime_dir:${directory.reason}`);
    }
    const token = await rotateIpcToken(this.paths.token_path);
    if (!token.ok) {
      throw new IpcServerStartError(`token:${token.reason}`);
    }
    this.token = token.value;

    try {
      await unlink(this.paths.socket_path);
    } catch {
      // a stale socket file is expected after an unclean shutdown
    }

    const server = createServer((socket: Socket) => {
      this.handleConnection(socket);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(new IpcServerStartError(`bind:${error.message}`));
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.paths.socket_path);
    });
    try {
      await chmod(this.paths.socket_path, IPC_FILE_MODE);
    } catch (error) {
      throw new IpcServerStartError(`socket_chmod:${error instanceof Error ? error.message : "unknown"}`);
    }

    const permissions = await verifyRuntimePermissions(this.paths);
    if (!permissions.ok) {
      throw new IpcServerStartError(`permissions:${permissions.reason}`);
    }

    const endpoint: EndpointDescriptor = {
      protocol_version: IPC_PROTOCOL_VERSION,
      socket_path: this.paths.socket_path,
      token_path: this.paths.token_path,
      boot_id: this.bootId,
      pid: process.pid,
      started_at: this.nowEpoch(),
    };
    const written = await writeEndpointDescriptor(this.paths.endpoint_path, endpoint);
    if (!written.ok) {
      throw new IpcServerStartError(`endpoint:${written.reason}`);
    }
    this.endpoint = endpoint;
  }

  private handleConnection(socket: Socket): void {
    if (this.shuttingDown || this.sockets.size >= this.maxConnections) {
      this.rejectedConnections += 1;
      socket.destroy();
      return;
    }
    this.totalConnections += 1;
    socket.setNoDelay(true);
    const state: ConnectionState = {
      socket,
      reader: new FrameReader(),
      opened_at: this.nowEpoch(),
      inflight: new Map<string, AbortController>(),
      connection_id: newId("ipc"),
      client_id: null,
      client_kind: null,
      hello_received: false,
      closed: false,
      request_count: 0,
      bad_frame_count: 0,
      hello_timer: null,
      write_chain: Promise.resolve(),
    };
    this.sockets.set(state.connection_id, state);

    state.hello_timer = setTimeout(() => {
      this.closeConnection(state, "hello_timeout");
    }, this.helloTimeoutMs);
    if (typeof state.hello_timer.unref === "function") {
      state.hello_timer.unref();
    }

    socket.on("data", (chunk: Buffer) => {
      this.onData(state, chunk);
    });
    socket.on("error", () => {
      this.closeConnection(state, "socket_error");
    });
    socket.on("close", () => {
      this.closeConnection(state, this.shuttingDown ? "server_shutdown" : "peer_closed");
    });
  }

  private onData(state: ConnectionState, chunk: Uint8Array): void {
    if (state.closed) {
      return;
    }
    const results = state.reader.push(chunk);
    for (const result of results) {
      if (state.closed) {
        return;
      }
      if (result.kind === "error") {
        state.bad_frame_count += 1;
        this.badFrames += 1;
        this.closeConnection(state, result.code === "E_IPC_TRUNCATED" ? "truncated" : "protocol_violation");
        return;
      }
      this.handleFrame(state, result.frame);
    }
  }

  private handleFrame(state: ConnectionState, frame: IpcFrame): void {
    if (!state.hello_received) {
      if (frame.header.kind !== IpcFrameKind.Hello) {
        this.closeConnection(state, "protocol_violation");
        return;
      }
      this.handleHello(state, frame);
      return;
    }
    switch (frame.header.kind) {
      case IpcFrameKind.Request: {
        const dispatch = this.handleRequest(state, frame).catch(() => {
          this.closeConnection(state, "protocol_violation");
        });
        this.inflightDispatches.add(dispatch);
        void dispatch.then(
          () => {
            this.inflightDispatches.delete(dispatch);
          },
          () => {
            this.inflightDispatches.delete(dispatch);
          },
        );
        return;
      }
      case IpcFrameKind.Cancel:
        this.handleCancel(state, frame);
        return;
      case IpcFrameKind.Hello:
      case IpcFrameKind.Response:
        this.closeConnection(state, "protocol_violation");
        return;
    }
  }

  private handleHello(state: ConnectionState, frame: IpcFrame): void {
    if (state.hello_timer !== null) {
      clearTimeout(state.hello_timer);
      state.hello_timer = null;
    }
    if (!isValidFrameDeadline(frame.header.kind, frame.header.deadline_ms)) {
      this.closeConnection(state, "hello_invalid");
      return;
    }
    const decoded = decodeJson(frame.body);
    if (!decoded.ok) {
      this.closeConnection(state, "hello_invalid");
      return;
    }
    const hello = validateHello(decoded.value);
    if (!hello.ok) {
      this.closeConnection(state, "hello_invalid");
      return;
    }
    const major = protocolMajor(hello.value.protocol_version);
    if (major === null || major !== IPC_PROTOCOL_MAJOR) {
      this.closeConnection(state, "protocol_violation");
      return;
    }
    const expected = this.token;
    if (expected === null || !tokensEqual(expected, hello.value.token)) {
      this.closeConnection(state, "auth_failed");
      return;
    }
    state.client_id = hello.value.client_id;
    state.client_kind = hello.value.client_kind;
    state.hello_received = true;
  }

  private handleCancel(state: ConnectionState, frame: IpcFrame): void {
    const decoded = decodeJson(frame.body);
    if (!decoded.ok) {
      state.bad_frame_count += 1;
      this.badFrames += 1;
      return;
    }
    const cancel = validateCancel(decoded.value);
    if (!cancel.ok) {
      state.bad_frame_count += 1;
      this.badFrames += 1;
      return;
    }
    const controller = state.inflight.get(cancel.value.request_id);
    if (controller !== undefined) {
      controller.abort();
    }
  }

  private async handleRequest(state: ConnectionState, frame: IpcFrame): Promise<void> {
    const receivedAt = this.nowMono();
    const connection = this.connectionContext(state);

    const decoded = decodeJson(frame.body);
    if (!decoded.ok) {
      this.requestsTotal += 1;
      this.requestsFailed += 1;
      this.respondFailure(state, null, "E_IPC_PROTOCOL", connection);
      return;
    }
    const requestId = extractRequestId(decoded.value);
    const declaredMethod = extractMethod(decoded.value);
    const traceId = requestId ?? newId("ipc");

    if (frame.header.deadline_ms === 0 || !isRequestDeadlineInRange(frame.header.deadline_ms)) {
      state.bad_frame_count += 1;
      this.badFrames += 1;
      this.requestsTotal += 1;
      this.requestsFailed += 1;
      this.respondFailure(state, requestId, "E_IPC_PROTOCOL", connection);
      return;
    }
    if (state.inflight.size >= this.maxInflightPerConnection) {
      this.requestsTotal += 1;
      this.requestsFailed += 1;
      this.respondFailure(state, requestId, "E_IPC_PEER_LIMIT", connection, { retry_after_ms: 100 });
      return;
    }
    if (this.totalInflight() >= this.maxInflightTotal) {
      this.requestsTotal += 1;
      this.requestsFailed += 1;
      this.respondFailure(state, requestId, "E_IPC_BUSY", connection, { retry_after_ms: 100 });
      return;
    }
    if (declaredMethod !== null && !isIpcMethod(declaredMethod)) {
      this.requestsTotal += 1;
      this.requestsFailed += 1;
      this.respondErrorBody(
        state,
        requestId,
        declaredMethod,
        {
          ok: false,
          status: "rejected",
          error: makeIpcError("E_IPC_METHOD_UNKNOWN", {
            trace_id: traceId,
            method: declaredMethod,
            connection_id: connection.connection_id,
            frame_kind: "request",
          }),
        },
        frame.header.deadline_ms,
      );
      return;
    }
    const validated = validateRequest(decoded.value);
    if (!validated.ok) {
      this.requestsTotal += 1;
      this.requestsFailed += 1;
      this.respondErrorBody(
        state,
        requestId,
        declaredMethod ?? "unknown",
        {
          ok: false,
          status: "rejected",
          error: schemaError({
            trace_id: traceId,
            path: validated.path,
            rule: validated.rule,
            method: declaredMethod ?? "unknown",
            connection_id: connection.connection_id,
            frame_kind: "request",
          }),
        },
        frame.header.deadline_ms,
      );
      return;
    }

    const request: DecodedRequest = validated.value;
    const controller = new AbortController();
    state.inflight.set(request.request_id, controller);
    this.requestsTotal += 1;
    const queueCost = this.nowMono() - receivedAt;
    const remaining = Math.max(0, Math.floor(frame.header.deadline_ms - queueCost));

    try {
      const outcome = await this.dispatcher.dispatch({
        connection,
        request,
        deadline_ms: remaining,
        signal: controller.signal,
      });
      this.writeResponse(state, request, outcome, remaining);
      if (outcome.kind === "result" && !outcome.result.ok) {
        this.requestsFailed += 1;
      }
    } catch {
      this.requestsFailed += 1;
      this.writeResponse(
        state,
        request,
        {
          kind: "result",
          result: {
            ok: false,
            status: "rejected",
            error: makeIpcError("E_INTERNAL", {
              trace_id: request.request_id,
              method: request.method,
              connection_id: connection.connection_id,
              frame_kind: "request",
            }),
          },
        },
        remaining,
      );
    } finally {
      state.inflight.delete(request.request_id);
      state.request_count += 1;
    }
  }

  private writeResponse(
    state: ConnectionState,
    request: DecodedRequest,
    outcome: IpcDispatchOutcome<IpcMethod>,
    remainingMs: number,
  ): void {
    let resultValue: JsonValue = null;
    if (outcome.kind === "replayed") {
      resultValue = outcome.result;
    } else {
      const converted = toJsonValue(outcome.result);
      if (converted.ok) {
        resultValue = converted.value;
      }
    }
    const body: JsonValue = {
      schema_version: IPC_RESPONSE_SCHEMA_VERSION,
      request_id: request.request_id,
      method: request.method,
      result: resultValue,
    };
    this.writeFrame(state, IpcFrameKind.Response, clampDeadline(remainingMs), encodeJson(body));
  }

  private respondFailure(
    state: ConnectionState,
    requestId: Id<"ipc"> | null,
    code: IpcErrorCode,
    connection: IpcConnectionContext,
    options?: { readonly retry_after_ms?: number },
  ): void {
    const traceId = requestId ?? newId("ipc");
    this.respondErrorBody(
      state,
      requestId,
      "unknown",
      {
        ok: false,
        status: "rejected",
        error: makeIpcError(code, {
          trace_id: traceId,
          connection_id: connection.connection_id,
          frame_kind: "request",
          ...(options?.retry_after_ms === undefined ? {} : { retry_after_ms: options.retry_after_ms }),
        }),
      },
      IPC_MAX_REQUEST_DEADLINE_MS,
    );
  }

  private respondErrorBody(
    state: ConnectionState,
    requestId: Id<"ipc"> | null,
    method: string,
    result: { readonly ok: false; readonly status: string; readonly error: ErrorEnvelope },
    remainingMs: number,
  ): void {
    const converted = toJsonValue(result.error);
    const body: JsonValue = {
      schema_version: IPC_RESPONSE_SCHEMA_VERSION,
      request_id: requestId ?? newId("ipc"),
      method,
      result: {
        ok: false,
        status: result.status,
        error: converted.ok ? converted.value : null,
      },
    };
    this.writeFrame(state, IpcFrameKind.Response, clampDeadline(remainingMs), encodeJson(body));
  }

  private writeFrame(state: ConnectionState, kind: IpcFrameKind, deadlineMs: number, body: Uint8Array): void {
    const frame = encodeFrame({ kind, deadline_ms: deadlineMs, body });
    state.write_chain = state.write_chain.then(
      () =>
        new Promise<void>((resolve) => {
          if (state.closed || state.socket.destroyed) {
            resolve();
            return;
          }
          state.socket.write(frame, () => resolve());
        }),
    );
  }

  private connectionContext(state: ConnectionState): IpcConnectionContext {
    if (state.client_id === null || state.client_kind === null) {
      throw new IpcServerStartError("connection_not_authenticated");
    }
    return {
      connection_id: state.connection_id,
      client_id: state.client_id,
      client_kind: state.client_kind,
      protocol_version: IPC_PROTOCOL_VERSION,
    };
  }

  private totalInflight(): number {
    let total = 0;
    for (const connection of this.sockets.values()) {
      total += connection.inflight.size;
    }
    return total;
  }

  private closeConnection(state: ConnectionState, reason: IpcCloseReason): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    if (state.hello_timer !== null) {
      clearTimeout(state.hello_timer);
      state.hello_timer = null;
    }
    for (const controller of state.inflight.values()) {
      controller.abort();
    }
    state.inflight.clear();
    const remainder = state.reader.takeRemainder();
    let effectiveReason: IpcCloseReason = reason;
    if (remainder.length > 0 && reason === "peer_closed") {
      effectiveReason = "truncated";
      state.bad_frame_count += 1;
      this.badFrames += 1;
    }
    this.sockets.delete(state.connection_id);
    state.socket.destroy();
    if (this.connectionLog !== null) {
      this.connectionLog.record({
        connection_id: state.connection_id,
        client_id: state.client_id,
        client_kind: state.client_kind,
        protocol_version: state.hello_received ? IPC_PROTOCOL_VERSION : null,
        opened_at: state.opened_at,
        closed_at: this.nowEpoch(),
        close_reason: effectiveReason,
        request_count: state.request_count,
        bad_frame_count: state.bad_frame_count,
      });
    }
  }
}

function clampDeadline(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs < 1) {
    return 1;
  }
  return Math.min(IPC_MAX_REQUEST_DEADLINE_MS, Math.floor(remainingMs));
}

function extractRequestId(value: JsonValue): Id<"ipc"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value["request_id"];
  if (typeof candidate !== "string" || !isId(candidate, "ipc")) {
    return null;
  }
  return candidate;
}

function extractMethod(value: JsonValue): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value["method"];
  return typeof candidate === "string" ? candidate : null;
}
