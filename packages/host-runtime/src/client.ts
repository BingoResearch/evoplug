/**
 * Thin IPC client wrapper for the host-side runtime (DD-HOST-201).
 *
 * The wrapper owns the `host_runtime` client kind, the session nonce, the
 * limits returned by ready, and the per-session single-poll rule. It adds no
 * normalization, identity or persistence; those stay in host core.
 */

import {
  hashUtf8,
  makeErrorEnvelope,
  ok,
  type ErrorEnvelope,
  type Hash,
  type Result
} from "@evoplug/core";
import type {
  HostRuntimePollRequest,
  HostRuntimePollResult,
  HostRuntimeReadyRequest,
  HostRuntimeReadyResult,
  HostRuntimeResultRequest,
  HostRuntimeResultResult,
  HostRuntimeUploadRequest,
  HostRuntimeUploadResult,
  RawHostEventUpload,
  RuntimeCallResult
} from "@evoplug/core/host";
import { IPC_MAX_REQUEST_DEADLINE_MS, IpcClient } from "@evoplug/ipc";

import type { HostRuntimeConfig } from "./artifact.js";
import { resolveHostRuntimeEndpoints } from "./config.js";

export const HOST_RUNTIME_CLIENT_KIND = "host_runtime";
export const HOST_RUNTIME_READY_DEADLINE_MS = 60_000;
export const HOST_RUNTIME_CALL_DEADLINE_MS = 60_000;
export const HOST_RUNTIME_POLL_DEADLINE_SLACK_MS = 5_000;

export interface HostRuntimeClientConnectOptions {
  readonly connect_timeout_ms?: number;
  readonly product_version?: string;
  readonly pid?: number;
}

export type RuntimeMethodKind = "ready" | "upload" | "result";

const IDEMPOTENCY_PREFIX: Readonly<Record<RuntimeMethodKind, string>> = Object.freeze({
  ready: "hr.rdy",
  upload: "hr.upl",
  result: "hr.res"
});

function hashHex(value: Hash): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function shortHash(seed: string): string {
  return hashUtf8(seed).slice("sha256:".length, "sha256:".length + 32);
}

/**
 * Builds an idempotency key that contains the full registration hash (so the
 * same adapter client id cannot collide across bindings) and a 128-bit digest
 * of a per-operation seed. The result matches `^[A-Za-z0-9._:-]{8,128}$`.
 */
export function hostRuntimeIdempotencyKey(
  registrationHash: Hash,
  kind: RuntimeMethodKind,
  seed: string
): string {
  return `${IDEMPOTENCY_PREFIX[kind]}.${hashHex(registrationHash)}.${shortHash(seed)}`;
}

function localError(input: {
  code: ErrorEnvelope["code"];
  category: ErrorEnvelope["category"];
  retryable: boolean;
  stage: string;
}): ErrorEnvelope {
  return makeErrorEnvelope({
    code: input.code,
    category: input.category,
    retryable: input.retryable,
    message_key: `error.${input.code.toLowerCase()}`,
    details: { kind: "none" },
    stage: input.stage
  });
}

export class HostRuntimeClient {
  private readonly client: IpcClient;
  private readyResult: HostRuntimeReadyResult | null = null;
  private pollInFlight = false;

  private constructor(client: IpcClient) {
    this.client = client;
  }

  /** Connects with `client_kind="host_runtime"` and the config identity. */
  public static async connect(
    config: HostRuntimeConfig,
    options?: HostRuntimeClientConnectOptions
  ): Promise<Result<HostRuntimeClient, ErrorEnvelope>> {
    const endpoints = resolveHostRuntimeEndpoints(config);
    const connected = await IpcClient.connect({
      evoplug_home: endpoints.evoplug_home,
      client_id: config.ipc.client_id,
      client_kind: HOST_RUNTIME_CLIENT_KIND,
      socket_path: endpoints.socket_path,
      token_path: endpoints.token_path,
      ...(options?.connect_timeout_ms === undefined
        ? {}
        : { connect_timeout_ms: options.connect_timeout_ms }),
      ...(options?.product_version === undefined ? {} : { product_version: options.product_version }),
      ...(options?.pid === undefined ? {} : { pid: options.pid })
    });
    if (!connected.ok) {
      return connected;
    }
    return ok(new HostRuntimeClient(connected.value));
  }

  public get connected(): boolean {
    return this.client.connected;
  }

  public get session(): HostRuntimeReadyResult | null {
    return this.readyResult;
  }

  /** Sends ready and remembers the session id, nonce and limits. */
  public async ready(
    request: HostRuntimeReadyRequest,
    idempotencyKey: string
  ): Promise<Result<HostRuntimeReadyResult, ErrorEnvelope>> {
    const result = await this.client.request("host.runtime.ready", request, {
      idempotency_key: idempotencyKey,
      deadline_ms: HOST_RUNTIME_READY_DEADLINE_MS
    });
    if (result.ok) {
      this.readyResult = result.value;
    }
    return result;
  }

  /** Uploads one raw host event with the current session nonce. */
  public async upload(
    upload: RawHostEventUpload,
    idempotencyKey: string
  ): Promise<Result<HostRuntimeUploadResult, ErrorEnvelope>> {
    const session = this.readyResult;
    if (session === null) {
      return this.sessionError("host.runtime.upload");
    }
    const request: HostRuntimeUploadRequest = {
      schema_version: "rsi.host_runtime_upload/1",
      session_id: session.session_id,
      session_nonce: session.session_nonce,
      upload
    };
    return this.client.request("host.runtime.upload", request, {
      idempotency_key: idempotencyKey,
      deadline_ms: HOST_RUNTIME_CALL_DEADLINE_MS
    });
  }

  /**
   * Issues at most one outstanding poll for this session. A concurrent caller
   * receives `E_HOST_RUNTIME_BUSY` without touching the socket.
   */
  public async poll(
    waitMs: number,
    hookEvent: string | null,
    eventIdentityKey: Hash | null
  ): Promise<Result<HostRuntimePollResult, ErrorEnvelope>> {
    const session = this.readyResult;
    if (session === null) {
      return this.sessionError("host.runtime.poll");
    }
    if (this.pollInFlight) {
      return {
        ok: false,
        status: "rejected",
        error: localError({
          code: "E_HOST_RUNTIME_BUSY",
          category: "capacity",
          retryable: true,
          stage: "host_runtime_poll"
        })
      };
    }
    const maxWait = session.limits.poll_wait_max_ms;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > maxWait) {
      return {
        ok: false,
        status: "rejected",
        error: makeErrorEnvelope({
          code: "E_SCHEMA",
          category: "schema",
          retryable: false,
          message_key: "error.e_schema",
          details: { kind: "field", path: "wait_ms", rule: "range_0_poll_wait_max_ms" },
          stage: "host_runtime_poll"
        })
      };
    }
    const request: HostRuntimePollRequest = {
      schema_version: "rsi.host_runtime_poll/1",
      session_id: session.session_id,
      session_nonce: session.session_nonce,
      wait_ms: waitMs,
      hook_event: hookEvent,
      event_identity_key: eventIdentityKey
    };
    this.pollInFlight = true;
    try {
      return await this.client.request("host.runtime.poll", request, {
        deadline_ms: Math.min(
          Math.max(waitMs + HOST_RUNTIME_POLL_DEADLINE_SLACK_MS, 1),
          IPC_MAX_REQUEST_DEADLINE_MS
        )
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Reports one RuntimeCall result keyed by the call id. */
  public async result(
    callId: string,
    result: RuntimeCallResult,
    idempotencyKey: string
  ): Promise<Result<HostRuntimeResultResult, ErrorEnvelope>> {
    const session = this.readyResult;
    if (session === null) {
      return this.sessionError("host.runtime.result");
    }
    const request: HostRuntimeResultRequest = {
      schema_version: "rsi.host_runtime_result/1",
      session_id: session.session_id,
      session_nonce: session.session_nonce,
      call_id: callId,
      result
    };
    return this.client.request("host.runtime.result", request, {
      idempotency_key: idempotencyKey,
      deadline_ms: HOST_RUNTIME_CALL_DEADLINE_MS
    });
  }

  public close(): void {
    this.client.close();
    this.readyResult = null;
  }

  private sessionError(method: string): Result<never, ErrorEnvelope> {
    return {
      ok: false,
      status: "rejected",
      error: makeErrorEnvelope({
        code: "E_HOST_RUNTIME_SESSION",
        category: "authorization",
        retryable: false,
        message_key: "error.e_host_runtime_session",
        details: { kind: "none" },
        stage: "host_runtime_session"
      })
    };
  }
}
