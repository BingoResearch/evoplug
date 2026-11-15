/**
 * OpenCode 2.1.4 plugin entry (DD-HOST-204, `opencode` row).
 *
 * Auto-discovered from `$XDG_CONFIG_HOME/opencode/plugin/evoplug.js` (the
 * single-file artifact variant). OpenCode 1.18.x registers only *named*
 * exports as plugins; a default-export factory runs but its hooks are never
 * called. It uploads `session.prompt`, tool and compaction facts, and injects
 * a pending delivery into the message parts at
 * `experimental.chat.messages.transform`.
 *
 * The adapter's declared event names differ from the OpenCode hook names, so
 * each hook uploads the declared name and a flat record holding the fields the
 * normalizer reads (`prompt`, `tool`, `callID`, ...). Hook outputs
 * (`parts`, `args`) are nested, so they are flattened here instead of being
 * forwarded verbatim.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadHostRuntimeConfig,
  handleRuntimeCall,
  startHostRuntime,
  type HostRuntime,
  type HostRuntimeSubmitOutcome,
  type RuntimeCall
} from "@evoplug/host-runtime";

function artifactPaths(metaUrl: string): { root: string; config: string } {
  const here = dirname(fileURLToPath(metaUrl));
  const singleFileConfig = join(here, "evoplug.runtime", "config.json");
  if (existsSync(singleFileConfig)) {
    return { root: here, config: singleFileConfig };
  }
  return { root: here, config: join(here, "config.json") };
}

function textFromParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (part !== null && typeof part === "object") {
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.length > 0) {
        return candidate.text;
      }
    }
  }
  return null;
}

function nativeIds(input: any, extra: Record<string, string> = {}): Record<string, string> {
  const ids: Record<string, string> = {};
  if (typeof input?.sessionID === "string") ids["session_id"] = input.sessionID;
  if (typeof input?.messageID === "string") ids["message_id"] = input.messageID;
  return { ...ids, ...extra };
}

/**
 * Session correlation for `experimental.chat.messages.transform`. The 2.1.4
 * typings do not pin this hook's input shape, so every observed spelling is
 * accepted, including the session id carried by the projected messages. An
 * unknown shape yields `null` and the entry fails closed instead of borrowing
 * another session's boundary key.
 */
function transformSessionId(input: any, output: any): string | null {
  if (typeof input?.sessionID === "string") return input.sessionID;
  if (typeof input?.session_id === "string") return input.session_id;
  if (typeof input?.session?.id === "string") return input.session.id;
  const messages = output?.messages;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as any;
      if (typeof message?.info?.sessionID === "string") return message.info.sessionID;
      if (typeof message?.info?.session_id === "string") return message.info.session_id;
      if (typeof message?.sessionID === "string") return message.sessionID;
    }
  }
  return null;
}

type EventKey = NonNullable<HostRuntimeSubmitOutcome["receipt"]>["event_key"];

interface PromptBoundary {
  readonly event_key: EventKey;
  readonly message_id: string | null;
}

/**
 * The id of the last user message in the projected request. It ties the
 * transform back to the `chat.message` that uploaded the prompt, so a new
 * prompt arriving while an older request is in flight cannot make that older
 * request claim the newer prompt's boundary.
 */
function projectedUserMessageId(output: any): string | null {
  const messages = output?.messages;
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as any;
    const info = message?.info ?? message;
    if (info?.role === "user" && typeof info.id === "string") return info.id;
  }
  return null;
}

/**
 * Appends the delivery to the last projected message part. The transform hook
 * cannot confirm that OpenCode accepted a return value, so the mutation is the
 * only observable projection. A missing or malformed carrier is not a success:
 * the delivery must be reported as `not_injected` so the bridge can re-arm it
 * instead of recording a body the provider never saw.
 */
function projectDelivery(output: any, text: string): boolean {
  const messages = output?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== "object") return false;
  // OpenCode 1.x carries parts beside `info`; 2.x carries the part array in
  // `content`. Both are the model-visible projection, so both are valid
  // carriers for the delivery text.
  const candidate = (last as { parts?: unknown; content?: unknown });
  const parts = Array.isArray(candidate.parts)
    ? candidate.parts
    : Array.isArray(candidate.content)
      ? candidate.content
      : null;
  if (parts === null) return false;
  try {
    (parts as unknown[]).push({ type: "text", text });
    return true;
  } catch {
    return false;
  }
}

export async function evoplugOpenCodePlugin(_input: any): Promise<Record<string, unknown>> {
  const paths = artifactPaths(import.meta.url);
  const root = paths.root;
  const loaded = await loadHostRuntimeConfig(paths.config);
  if (!loaded.ok) return {};
  const holder: { current: HostRuntime | null } = { current: null };
  const runtimePromise: Promise<HostRuntime | null> = startHostRuntime({
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: process.env["EVOPLUG_HOST_VERSION"] ?? "2.1.4",
      ephemeral: false,
      onError: (error) => {
        if (process.env["EVOPLUG_OPENCODE_RUNTIME_DEBUG"] !== "1") return;
        const detail = (error as { details?: unknown }).details;
        process.stderr.write(
          `evoplug_runtime_error ${error.code} ${JSON.stringify(detail ?? null).slice(0, 600)}\n`
        );
      },
      onCall: async (call: RuntimeCall) => {
        const active = holder.current;
        if (active === null) return;
        try {
          const handled = await handleRuntimeCall(active, call, {
            artifact_root: root,
            carrier_event: "session.prompt",
            observed_at: Date.now(),
            host_observation: () => null
          });
          if (!handled.handled && process.env["EVOPLUG_OPENCODE_RUNTIME_DEBUG"] === "1") {
            process.stderr.write(`evoplug_runtime_call_unhandled ${call.kind}\n`);
          }
        } catch (error) {
          if (process.env["EVOPLUG_OPENCODE_RUNTIME_DEBUG"] === "1") {
            process.stderr.write(
              `evoplug_runtime_call_threw ${call.kind} ${error instanceof Error ? error.message : String(error)}\n`.slice(0, 800)
            );
          }
        }
      }
    }
  })
    .then((started) => {
      if (!started.ok) return null;
      holder.current = started.runtime;
      return started.runtime;
    })
    .catch(() => null);

  /**
   * The latest `session.prompt` boundary per native session. The messages
   * transform hook runs later in the same turn and has no event of its own
   * (it uploads nothing), so it can only poll the prompt event that triggered
   * the delivery. The map is replaced on every prompt and cleared when that
   * prompt upload is not accepted, which prevents a stale key from being
   * reused after a rejected upload.
   */
  const promptBoundaries = new Map<string, PromptBoundary>();
  const submit = async (
    event: string,
    payload: Record<string, unknown>,
    native: Record<string, string> = {}
  ): Promise<HostRuntimeSubmitOutcome | null> => {
    const runtime = await runtimePromise;
    if (runtime === null) return null;
    try {
      return await runtime.submitHostEvent(event, native, payload as never, Date.now());
    } catch {
      return null;
    }
  };

  return {
    "chat.message": async (hookInput: any, hookOutput: any) => {
      const text = textFromParts(hookOutput?.parts);
      const record: Record<string, unknown> = {};
      if (text !== null) record["prompt"] = text;
      if (typeof hookInput?.agent === "string") record["agent"] = hookInput.agent;
      if (typeof hookOutput?.message?.role === "string") record["role"] = hookOutput.message.role;
      const sessionId =
        typeof hookInput?.sessionID === "string"
          ? hookInput.sessionID
          : typeof hookOutput?.message?.sessionID === "string"
            ? hookOutput.message.sessionID
            : null;
      const submitted = await submit("session.prompt", record, {
        ...nativeIds(hookInput),
        ...(typeof hookOutput?.message?.id === "string" ? { message_id: hookOutput.message.id } : {})
      });
      if (sessionId !== null) {
        const eventKey = submitted?.receipt?.event_key;
        if (eventKey === undefined) promptBoundaries.delete(sessionId);
        else {
          promptBoundaries.set(sessionId, {
            event_key: eventKey,
            message_id:
              typeof hookOutput?.message?.id === "string"
                ? hookOutput.message.id
                : typeof hookInput?.messageID === "string"
                  ? hookInput.messageID
                  : null
          });
        }
      }
    },
    "tool.execute.before": async (hookInput: any, hookOutput: any) => {
      const record: Record<string, unknown> = {};
      if (typeof hookInput?.tool === "string") record["tool"] = hookInput.tool;
      if (typeof hookInput?.callID === "string") record["callID"] = hookInput.callID;
      if (hookOutput?.args !== undefined) record["arguments"] = hookOutput.args;
      await submit("tool.execute.before", record, nativeIds(hookInput, {
        ...(typeof hookInput?.callID === "string" ? { tool_call_id: hookInput.callID } : {})
      }));
    },
    "tool.execute.after": async (hookInput: any, hookOutput: any) => {
      const record: Record<string, unknown> = {};
      if (typeof hookInput?.tool === "string") record["tool"] = hookInput.tool;
      if (typeof hookInput?.callID === "string") record["callID"] = hookInput.callID;
      if (typeof hookOutput?.output === "string") record["text"] = hookOutput.output;
      if (typeof hookOutput?.title === "string") record["title"] = hookOutput.title;
      await submit("tool.execute.after", record, nativeIds(hookInput, {
        ...(typeof hookInput?.callID === "string" ? { tool_call_id: hookInput.callID } : {})
      }));
    },
    "experimental.session.compacting": async (hookInput: any, hookOutput: any) => {
      const record: Record<string, unknown> = {};
      if (typeof hookOutput?.prompt === "string") record["summary"] = hookOutput.prompt;
      if (Array.isArray(hookOutput?.context)) record["context_items"] = hookOutput.context.length;
      await submit("session.compaction", record, nativeIds(hookInput));
    },
    "experimental.chat.messages.transform": async (hookInput: any, hookOutput: any) => {
      const runtime = await runtimePromise;
      // The delivery bridge stores the *trigger* event (the prompt) as the
      // boundary, so the poll must ask for `session.prompt` with that prompt's
      // receipt key. A different projected user message means this request
      // belongs to another turn; no correlation at all also fails closed
      // instead of picking an arbitrary boundary.
      const sessionId = transformSessionId(hookInput, hookOutput);
      const boundary = sessionId === null ? undefined : promptBoundaries.get(sessionId);
      const projectedMessageId = projectedUserMessageId(hookOutput);
      const correlated =
        boundary !== undefined &&
        (boundary.message_id === null ||
          projectedMessageId === null ||
          boundary.message_id === projectedMessageId);
      const eventKey = boundary !== undefined && correlated ? boundary.event_key : null;
      // The kernel claims one call per poll, oldest first. Attach schedules a
      // check-load and a probe on the same boundary, so a single poll would
      // consume the check-load and leave the probe pending forever in a
      // one-step session. Two polls per injection point drain both; non-deliver
      // calls are executed by the runtime's `onCall` handler.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const polled = await runtime?.pollOnce(
          "session.prompt",
          eventKey as Parameters<HostRuntime["pollOnce"]>[1]
        );
        const call = polled?.call ?? null;
        if (call === null) return;
        if (call.kind !== "deliver") continue;
        // Report completion only after the delivery is actually present in the
        // carrier. Reporting first would record `context_projection` for a body
        // that a malformed or empty message list never received.
        if (!projectDelivery(hookOutput, call.content.text)) {
          await runtime?.reportResult(call.call_id, {
            kind: "deliver",
            state: "not_injected",
            reason: "not_injected"
          });
          return;
        }
        await runtime?.reportResult(call.call_id, {
          kind: "deliver",
          state: "completed",
          result: {
            delivery_id: call.request.delivery_id,
            submitted: "true",
            inclusion: { level: "context_projection" },
            degraded: false,
            completed_at: Date.now()
          }
        });
        return;
      }
    }
  };
}

/**
 * OpenCode 2.x plugin contract. The loader requires a default definition with
 * an id plus `setup` (or `effect`); the v1 named factory above stays for hosts
 * that still call named exports. All v2 callbacks receive one mutable event,
 * so the v1 hook implementations are fed an event that carries the same
 * fields under both spellings.
 */
export interface OpenCodePluginSessionContext {
  hook(name: string, handler: (event: any) => Promise<void> | void): unknown;
}

export interface OpenCodePluginToolContext {
  hook(name: string, handler: (event: any) => Promise<void> | void): unknown;
}

export interface OpenCodePluginSetupContext {
  readonly session: OpenCodePluginSessionContext;
  readonly tool: OpenCodePluginToolContext;
}

export interface OpenCodePluginDefinition {
  readonly id: string;
  readonly setup: (ctx: OpenCodePluginSetupContext) => Promise<void>;
}

export const openCodePluginDefinition: OpenCodePluginDefinition = {
  id: "evoplug",
  async setup(ctx: OpenCodePluginSetupContext): Promise<void> {
    type V1Hook = (input: any, output?: any) => Promise<void> | void;
    const hooks = (await evoplugOpenCodePlugin(ctx)) as unknown as Readonly<
      Record<string, V1Hook | undefined>
    >;
    const { session, tool } = ctx;
    session.hook("prompt", async (event: any) => {
      const text = typeof event?.prompt?.text === "string" ? event.prompt.text : null;
      await hooks["chat.message"]?.(
        event,
        {
          parts: text === null ? [] : [{ type: "text", text }],
          message: { role: "user", id: event?.messageID, sessionID: event?.sessionID }
        }
      );
    });
    tool.hook("execute.before", async (event: any) => {
      await hooks["tool.execute.before"]?.(event, {
        args: event?.input ?? event?.args
      });
    });
    tool.hook("execute.after", async (event: any) => {
      await hooks["tool.execute.after"]?.(event, {
        output: event?.output,
        title: event?.title
      });
    });
    session.hook("compaction", async (event: any) => {
      await hooks["experimental.session.compacting"]?.(event, event);
    });
    // 2.x splits the one v1 message transform into per-call-site hooks. The
    // delivery must reach ordinary calls and the auxiliary generation paths.
    for (const name of ["context", "generate", "title"]) {
      session.hook(name, async (event: any) => {
        await hooks["experimental.chat.messages.transform"]?.(event, {
          messages: event?.messages
        });
      });
    }
  }
};

export default openCodePluginDefinition;
