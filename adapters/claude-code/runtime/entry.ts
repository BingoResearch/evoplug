/**
 * Claude Code runtime entry (DD-HOST-204, `claude-code` row).
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
  handleRuntimeCall,
  loadHostRuntimeConfig,
  startHostRuntime,
  type HostRuntime,
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: Record<string, JsonValue> = {};
  try {
    payload = raw.trim().length === 0 ? {} : (JSON.parse(raw) as Record<string, JsonValue>);
  } catch {
    payload = {};
  }
  const paths = artifactPaths(import.meta.url);
  const root = paths.root;
  const loaded = await loadHostRuntimeConfig(paths.config);
  if (!loaded.ok) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : null;
  const eventName = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "unknown";
  const configuredPollWait = Number(process.env["EVOPLUG_HOST_RUNTIME_POLL_WAIT_MS"] ?? "NaN");
  const pollWaitMaxMs = Number.isSafeInteger(configuredPollWait) && configuredPollWait >= 0
    ? configuredPollWait
    : undefined;
  const holder: { current: HostRuntime | null } = { current: null };
  let pendingCall: Promise<void> = Promise.resolve();
  const started = await startHostRuntime({
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: process.env["EVOPLUG_HOST_VERSION"] ?? "2.1.309",
      ephemeral: true,
      instance_key: sessionId,
      ...(pollWaitMaxMs === undefined ? {} : { poll_wait_max_ms: pollWaitMaxMs }),
      onCall: (call: RuntimeCall) => {
        pendingCall = pendingCall
          .then(async () => {
            const active = holder.current;
            if (active === null) return;
            await handleRuntimeCall(active, call, {
              artifact_root: root,
              carrier_event: "UserPromptSubmit",
              observed_at: Date.now(),
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
  const submitted = await runtime.submitHostEvent(
    eventName,
    {
      ...(sessionId === null ? {} : { session_id: sessionId }),
      ...(typeof payload["prompt_id"] === "string" ? { message_id: payload["prompt_id"] } : {}),
      ...(typeof payload["tool_use_id"] === "string" ? { tool_call_id: payload["tool_use_id"] } : {})
    },
    payload,
    Date.now()
  );
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
        inclusion: { level: "constructive" },
        degraded: false,
        completed_at: Date.now()
      }
    });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: eventName, additionalContext: call.content.text }
      }) + "\n"
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
