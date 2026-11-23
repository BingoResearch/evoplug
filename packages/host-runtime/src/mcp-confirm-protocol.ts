/**
 * Stdio MCP confirmation channel (closure design §5.1, appendix K.2).
 *
 * The host launches this server as an ordinary stdio MCP server. The server is
 * the only party that talks to the kernel; the model only sees one read-only
 * tool whose result is "processed" or "not processed". The user's answer is
 * produced by the host's own elicitation form:
 *
 *   server --elicitation/create--> host --renders form--> user
 *   server <--{action, content}--- host <--clicks-------- user
 *
 * Security properties this module owns:
 *
 * - a JSON-RPC *response* is accepted only when its id belongs to an
 *   elicitation request this process sent and that is still pending; a late,
 *   duplicated, unknown or pre-emptively injected response is dropped;
 * - a tool call's arguments are ignored: the model cannot name a candidate,
 *   supply a decision, or answer on the user's behalf;
 * - the tool result never contains candidate content, only processing state;
 * - no elicitation is sent unless the client advertised the `elicitation`
 *   form capability in `initialize`;
 * - a client that never answers leaves the request `unknown`; nothing is
 *   guessed for it.
 *
 * This module is transport-only. It never decides whether a confirmation is
 * required and never writes to the ledger.
 */

import type { JsonValue } from "@evoplug/core";

/** Tool name advertised to the host; the model can call it, not answer it. */
export const MCP_CONFIRM_TOOL_NAME = "evoplug_confirm_pending";

/** Result text the model is allowed to see. */
export const MCP_CONFIRM_PROCESSED = "processed";
export const MCP_CONFIRM_NOT_PROCESSED = "not processed";

const DEFAULT_ELICITATION_TIMEOUT_MS = 5 * 60_000;
/** Server-initiated request ids start well above client ids. */
const FIRST_SERVER_REQUEST_ID = 1_000_000;

export interface McpElicitationSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly required?: readonly string[];
}

export interface McpElicitationRequest {
  readonly message: string;
  readonly requestedSchema: McpElicitationSchema;
  /** Applied when the client never answers. */
  readonly timeout_ms?: number;
}

export type McpElicitationOutcome =
  | {
      readonly state: "accepted";
      readonly request_id: number;
      readonly content: Readonly<Record<string, string>>;
    }
  | { readonly state: "declined"; readonly request_id: number }
  | { readonly state: "cancelled"; readonly request_id: number }
  | { readonly state: "unsupported"; readonly request_id: null }
  | { readonly state: "unknown"; readonly request_id: number | null };

export interface McpConfirmProtocolOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  /** Runs one confirmation cycle. Returns the model-visible processing state. */
  readonly on_tool_call: () => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (entry: Record<string, JsonValue>) => void;
  readonly server_name?: string;
  readonly server_version?: string;
}

export interface McpConfirmProtocol {
  /** True once `initialize` advertised an elicitation form capability. */
  clientSupportsElicitation(): boolean;
  /** True once the client sent `notifications/initialized`. */
  ready(): boolean;
  /** Sends one elicitation request and waits for the host's own answer. */
  elicit(request: McpElicitationRequest): Promise<McpElicitationOutcome>;
  /** Number of elicitation requests still waiting for an answer. */
  pendingCount(): number;
  close(): void;
  /** Resolves when the input stream ends. */
  readonly closed: Promise<void>;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: JsonValue;
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: JsonValue;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: JsonValue;
  readonly error?: { readonly code: number; readonly message: string };
}

type Incoming = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

interface PendingElicitation {
  readonly resolve: (outcome: McpElicitationOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(message: Incoming): message is JsonRpcResponse {
  return (message as { method?: unknown }).method === undefined;
}

/** Extracts the `{action, content}` answer; anything else is not an answer. */
export function parseElicitationAnswer(
  value: JsonValue,
  requestId: number
): McpElicitationOutcome {
  if (!isRecord(value)) return { state: "unknown", request_id: requestId };
  const action = value["action"];
  if (action === "decline") return { state: "declined", request_id: requestId };
  if (action === "cancel") return { state: "cancelled", request_id: requestId };
  if (action !== "accept") return { state: "unknown", request_id: requestId };
  const raw = value["content"];
  const content: Record<string, string> = {};
  if (isRecord(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      if (typeof entry === "string") content[key] = entry;
      else if (typeof entry === "boolean") content[key] = entry ? "true" : "false";
      else if (typeof entry === "number") content[key] = String(entry);
      else return { state: "unknown", request_id: requestId };
    }
  }
  return { state: "accepted", request_id: requestId, content };
}

export function createMcpConfirmProtocol(
  options: McpConfirmProtocolOptions
): McpConfirmProtocol {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const serverName = options.server_name ?? "evoplug-confirm";
  const serverVersion = options.server_version ?? "0.0.0";
  const pending = new Map<number, PendingElicitation>();
  let nextRequestId = FIRST_SERVER_REQUEST_ID;
  let supportsElicitation = false;
  let initialized = false;
  let closed = false;
  let buffer = "";
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const send = (message: JsonValue): void => {
    if (closed) return;
    try {
      options.output.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A closed host pipe is a shutdown, not a confirmation.
    }
  };

  const respond = (id: string | number, result: JsonValue): void => {
    send({ jsonrpc: "2.0", id, result });
  };

  const respondError = (id: string | number, code: number, message: string): void => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  function settle(id: number, outcome: McpElicitationOutcome): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  }

  async function handleRequest(message: JsonRpcRequest): Promise<void> {
    const method = message.method;
    if (method === "initialize") {
      const params = isRecord(message.params === undefined ? null : message.params)
        ? (message.params as Record<string, JsonValue>)
        : {};
      const capabilities = isRecord(params["capabilities"])
        ? (params["capabilities"] as Record<string, JsonValue>)
        : {};
      // The capability object itself is the signal; `form`/`url` name the
      // shapes the client understands. Unknown shapes stay supported because
      // the host decides how to render `requestedSchema`.
      const elicitation = capabilities["elicitation"];
      supportsElicitation = isRecord(elicitation);
      log({
        event: "initialize",
        client_capabilities: capabilities,
        elicitation_capability: supportsElicitation
      });
      respond(message.id, {
        protocolVersion:
          typeof params["protocolVersion"] === "string"
            ? params["protocolVersion"]
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: serverVersion }
      });
      return;
    }
    if (method === "ping") {
      respond(message.id, {});
      return;
    }
    if (method === "tools/list") {
      respond(message.id, {
        tools: [
          {
            name: MCP_CONFIRM_TOOL_NAME,
            description:
              "Ask the host user about any pending EvoPlug confirmation. Returns only whether something was processed.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true }
          }
        ]
      });
      return;
    }
    if (method === "tools/call") {
      const params = isRecord(message.params === undefined ? null : message.params)
        ? (message.params as Record<string, JsonValue>)
        : {};
      if (params["name"] !== MCP_CONFIRM_TOOL_NAME) {
        respondError(message.id, -32602, "unknown tool");
        return;
      }
      // Arguments are deliberately ignored: they are model-controlled input.
      let processed = false;
      try {
        processed = await options.on_tool_call();
      } catch {
        processed = false;
      }
      respond(message.id, {
        content: [
          {
            type: "text",
            text: processed ? MCP_CONFIRM_PROCESSED : MCP_CONFIRM_NOT_PROCESSED
          }
        ]
      });
      return;
    }
    respondError(message.id, -32601, `unknown method ${method}`);
  }

  async function handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      log({ event: "bad_json", at: now() });
      return;
    }
    if (!isRecord(parsed) || parsed["jsonrpc"] !== "2.0") {
      log({ event: "bad_message", at: now() });
      return;
    }
    const message = parsed as unknown as Incoming;
    if (isResponse(message)) {
      const id = message.id;
      // The model can write tool arguments and its own text, never this pipe.
      // An id that this process did not allocate is still dropped loudly so a
      // forged answer can be seen in the log.
      if (typeof id !== "number" || !pending.has(id)) {
        log({ event: "unmatched_elicitation_response", id: id === null ? null : String(id), at: now() });
        return;
      }
      settle(id, parseElicitationAnswer(message.result === undefined ? null : message.result, id));
      return;
    }
    if (!("id" in (parsed as Record<string, unknown>))) {
      const method = (message as JsonRpcNotification).method;
      if (method === "notifications/initialized") {
        initialized = true;
        log({ event: "initialized", at: now() });
      }
      return;
    }
    await handleRequest(message as JsonRpcRequest);
  }

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      void handleLine(line);
    }
  };
  const onEnd = (): void => {
    if (closed) return;
    closed = true;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ state: "cancelled", request_id: id });
    }
    pending.clear();
    resolveClosed();
    log({ event: "stdin_closed", at: now() });
  };
  options.input.on("data", onData);
  options.input.on("end", onEnd);
  options.input.on("close", onEnd);

  return {
    clientSupportsElicitation: () => supportsElicitation,
    ready: () => initialized,
    pendingCount: () => pending.size,
    close: () => {
      onEnd();
    },
    closed: closedPromise,
    elicit: (request) => {
      if (closed) return Promise.resolve({ state: "unknown", request_id: null });
      if (!initialized || !supportsElicitation) {
        log({ event: "elicitation_unsupported", at: now() });
        return Promise.resolve({ state: "unsupported", request_id: null });
      }
      const id = nextRequestId;
      nextRequestId += 1;
      const timeout = Math.max(1, request.timeout_ms ?? DEFAULT_ELICITATION_TIMEOUT_MS);
      return new Promise<McpElicitationOutcome>((resolve) => {
        const timer = setTimeout(() => {
          log({ event: "elicitation_timeout", id, at: now() });
          settle(id, { state: "unknown", request_id: id });
        }, timeout);
        pending.set(id, { resolve, timer });
        log({ event: "elicitation_sent", id, at: now() });
        send({
          jsonrpc: "2.0",
          id,
          method: "elicitation/create",
          params: {
            message: request.message,
            requestedSchema: request.requestedSchema as unknown as JsonValue
          }
        });
      });
    }
  };
}
