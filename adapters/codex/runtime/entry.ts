/**
 * Codex runtime entry (DD-HOST-204, `codex` row).
 *
 * Command hook: reads the hook JSON from stdin, starts an ephemeral runtime
 * session keyed by the host session id, uploads the native event, polls once
 * for a pending delivery and prints the hook-specific JSON.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonValue } from "@evoplug/core";

import {
  detectInteractiveHostSession,
  handleHumanConfirmationCall,
  handleRuntimeCall,
  loadHostRuntimeConfig,
  runMcpConfirmServer,
  startHostRuntime,
  type HostRuntime,
  type RuntimeCall
} from "@evoplug/host-runtime";

import { CODEX_CONFIRM_SPEC, CODEX_MCP_CONFIRM_FLAG, ensureConfirmProfile } from "./confirm.js";
import { claimHookOccurrence, deriveHookEventId } from "../src/hook-identity.js";

function artifactPaths(metaUrl: string): { root: string; config: string } {
  const here = dirname(fileURLToPath(metaUrl));
  const singleFileConfig = join(here, "evoplug.runtime", "config.json");
  if (existsSync(singleFileConfig)) {
    return { root: here, config: singleFileConfig };
  }
  return { root: here, config: join(here, "config.json") };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const paths = artifactPaths(import.meta.url);
  // The host also launches this same bundle as its stdio MCP confirmation
  // server (appendix K.2). That mode owns stdin for JSON-RPC, so it must run
  // before the hook payload is read.
  if (process.argv.includes(CODEX_MCP_CONFIRM_FLAG)) {
    const confirmConfig = await loadHostRuntimeConfig(paths.config);
    if (confirmConfig.ok) {
      await runMcpConfirmServer({
        artifact_root: paths.root,
        config: confirmConfig.config,
        host: CODEX_CONFIRM_SPEC,
        input: process.stdin,
        output: process.stdout
      });
    }
    return;
  }
  const raw = await readStdin();
  let payload: Record<string, JsonValue> = {};
  try {
    payload = raw.trim().length === 0 ? {} : (JSON.parse(raw) as Record<string, JsonValue>);
  } catch {
    payload = {};
  }
  const root = paths.root;
  const loaded = await loadHostRuntimeConfig(paths.config);
  if (!loaded.ok) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  // Attach's static profile cannot carry an absolute path; this run knows its
  // own entry and rewrites the evoplug-owned profile when it is stale, so a
  // custom CODEX_HOME works from the second session on. Failures never block
  // the hook itself.
  const profile = ensureConfirmProfile({
    artifact_root: root,
    entry: fileURLToPath(import.meta.url),
    node: process.execPath,
    evoplug_home: loaded.config.ipc?.evoplug_home ?? null,
    disabled: process.env["EVOPLUG_DISABLE_CONFIRM_PROFILE"] === "1"
  });
  if (profile !== null && process.env["EVOPLUG_DEBUG_IPC"] === "1") {
    process.stderr.write(`evoplug runtime: confirm_profile=${profile}\n`);
  }
  const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : null;
  const eventName = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "unknown";
  const configuredPollWait = Number(process.env["EVOPLUG_HOST_RUNTIME_POLL_WAIT_MS"] ?? "NaN");
  // A command hook runs synchronously inside the host's turn; a long poll
  // blocks the editor until it expires. Calls are already pending when the
  // event is acknowledged, so a short wait is enough.
  const pollWaitMaxMs = Number.isSafeInteger(configuredPollWait) && configuredPollWait >= 0
    ? configuredPollWait
    : 500;
  const holder: { current: HostRuntime | null } = { current: null };
  let pendingCall: Promise<void> = Promise.resolve();
  const started = await startHostRuntime({
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: loaded.config.host_version ?? process.env["EVOPLUG_HOST_VERSION"] ?? "unknown",
      // Appendix L.1: one-shot hook process, real host session.
      ephemeral: true,
      session_role: "host_session",
      // Appendix M.1: the hook payload carries the session working directory.
      working_directory:
        typeof payload["cwd"] === "string" ? payload["cwd"] : process.cwd(),
      instance_key: sessionId ?? `hook:${String(process.pid)}:${String(Date.now())}`,
      ...(pollWaitMaxMs === undefined ? {} : { poll_wait_max_ms: pollWaitMaxMs }),
      onCall: (call: RuntimeCall) => {
        pendingCall = pendingCall
          .then(async () => {
            const active = holder.current;
            if (active === null) return;
            if (call.kind === "probe" && call.request.probe_action === "confirm_human_event") {
              await handleHumanConfirmationCall(active, call, {
                carrier_event: "UserPromptSubmit",
                observed_at: Date.now(),
                // This host runs the plugin as a one-shot hook process and
                // exposes no dialog surface. The confirmation is answered as
                // `unsupported`; the capability stays unknown.
                confirm_native: null
              });
              return;
            }
            await handleRuntimeCall(active, call, {
              artifact_root: root,
              carrier_event: "UserPromptSubmit",
              observed_at: Date.now(),
              // Codex hook JSON carries the native ids on the same event the
              // runtime is polling from; these are hook observations, not
              // provider proof.
              host_observation: () => ({
                session_id: sessionId,
                message_id: typeof payload["prompt_id"] === "string" ? payload["prompt_id"] : null,
                tool_call_id:
                  typeof payload["tool_use_id"] === "string" ? payload["tool_use_id"] : null,
                compaction: eventName === "PreCompact"
              })
            });
          })
          .catch(() => undefined);
      }
    }
  });
  if (!started.ok) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  const runtime = started.runtime;
  holder.current = runtime;
  // The host process command line is host-native: the TUI is interactive and
  // `codex exec` is not. Only the former can emit a user-typed prompt.
  const typedByHost =
    eventName === "UserPromptSubmit" && detectInteractiveHostSession("codex");
  // Appendix N.1: identify a hook by session + event + host payload content.
  // Codex emits several deliveries for one prompt; this keeps them one event
  // and keeps queued prompts with the same arrival millisecond apart.
  const hookEventId = deriveHookEventId({
    host_id: "codex",
    session_id: sessionId,
    hook_event: eventName,
    payload
  });
  const hostOccurredAt =
    typeof payload["occurred_at"] === "number"
      ? payload["occurred_at"]
      : typeof payload["timestamp"] === "number"
        ? payload["timestamp"]
        : null;
  const occurredAt =
    hostOccurredAt ??
    claimHookOccurrence(loaded.config.ipc?.evoplug_home ?? null, hookEventId, Date.now());
  const submitted = await runtime.submitHostEvent(
    eventName,
    {
      ...(sessionId === null ? {} : { session_id: sessionId }),
      ...(typeof payload["turn_id"] === "string" ? { turn_id: payload["turn_id"] } : {}),
      ...(typeof payload["prompt_id"] === "string" ? { message_id: payload["prompt_id"] } : {}),
      ...(typeof payload["tool_use_id"] === "string" ? { tool_call_id: payload["tool_use_id"] } : {}),
      event_id: hookEventId
    },
    {
      ...(typedByHost ? { ...payload, __evoplug_typed_user: "interactive_tui" } : payload),
      __evoplug_event_occurred_at: occurredAt
    },
    Date.now()
  );
  // The delivery bridge binds a pending delivery to the trigger event's
  // identity key and host event. Poll with the receipt of this exact upload;
  // a rejected/degraded upload has no receipt and therefore polls `null` so
  // the runtime fails closed instead of guessing a boundary.
  const boundaryKey = (submitted.receipt?.event_key ?? null) as Parameters<HostRuntime["pollOnce"]>[1];
  const polled = await runtime.pollOnce(eventName, boundaryKey);
  const call = polled.call;
  if (call !== null && call.kind === "deliver") {
    await runtime.reportResult(call.call_id, {
      kind: "deliver",
      state: "completed",
      result: {
        delivery_id: call.request.delivery_id,
        submitted: "true",
        inclusion: { level: "provider_payload" },
        degraded: false,
        completed_at: Date.now()
      }
    });
    process.stdout.write(
      JSON.stringify(
        eventName === "Stop"
          ? { decision: "block", reason: call.content.text }
          : { hookSpecificOutput: { hookEventName: eventName, additionalContext: call.content.text } }
      ) + "\n"
    );
  } else {
    process.stdout.write(JSON.stringify({}) + "\n");
  }
  // Non-delivery calls (check_load/probe) are answered by `onCall`; keep the
  // socket open until that report has been sent.
  await pendingCall;
  runtime.close();
}

void main().catch(() => {
  process.stdout.write(JSON.stringify({}) + "\n");
});
