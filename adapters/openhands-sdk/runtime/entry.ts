/**
 * OpenHands SDK runtime entry (DD-HOST-204, `openhands-sdk` row).
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
  handleHumanConfirmationCall,
  handleRuntimeCall,
  handleSessionConfirmationCall,
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
  const eventName = typeof payload["event_type"] === "string" ? payload["event_type"] : "unknown";
  const holder: { current: HostRuntime | null } = { current: null };
  let pendingCall: Promise<void> = Promise.resolve();
  const started = await startHostRuntime({
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: loaded.config.host_version ?? process.env["EVOPLUG_HOST_VERSION"] ?? "unknown",
      ephemeral: true,
      instance_key: sessionId,
      onCall: (call: RuntimeCall) => {
        pendingCall = pendingCall
          .then(async () => {
            const active = holder.current;
            if (active === null) return;
            if (call.kind === "probe" && call.request.probe_action === "confirm_human_event") {
              await handleHumanConfirmationCall(active, call, {
                carrier_event: "input",
                observed_at: Date.now(),
                // This host runs the plugin as a one-shot hook process and
                // exposes no dialog surface. The confirmation is answered as
                // `unsupported`; the capability stays unknown.
                confirm_native: null
              });
              return;
            }
            if (
              call.kind === "probe" &&
              (call.request.probe_action === "confirm_human_setup" ||
                call.request.probe_action === "confirm_candidate")
            ) {
              // No dialog exists in a one-shot hook process. Reporting
              // `unsupported` writes the capability row as unknown instead of
              // leaving the status silent, and never upgrades it.
              await handleSessionConfirmationCall(active, call, {
                observed_at: Date.now(),
                confirm_native: null,
                choose_native: null
              });
              return;
            }
            await handleRuntimeCall(active, call, {
              artifact_root: root,
              carrier_event: "UserPromptSubmit",
              observed_at: Date.now(),
              host_observation: () => ({
                session_id: sessionId,
                message_id:
                  typeof payload["message_id"] === "string"
                    ? payload["message_id"]
                    : typeof payload["event_id"] === "string"
                      ? payload["event_id"]
                      : null,
                tool_call_id:
                  typeof payload["tool_call_id"] === "string" ? payload["tool_call_id"] : null,
                compaction: eventName === "condense" || eventName === "compaction"
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
