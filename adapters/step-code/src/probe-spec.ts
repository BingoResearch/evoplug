/**
 * Probe binding declaration for the `step-code` adapter (W1).
 *
 * These are the facts the adapter itself can state about how its runtime is
 * constructed. The kernel supplies host version, binary hash and session scope
 * when it turns this spec into a `CapabilityBinding`; nothing here branches on
 * the host inside the kernel.
 *
 * Step Code 0.1.5 discovers Pi-compatible extensions in
 * `<agentDir>/extensions/evoplug` and reads custom providers from
 * `<configRoot>/models.json`, where the SDK path accepts the same document in
 * the agent directory. The kernel writes both locations, re-hashes the
 * installed artifact and mounts those exact bytes with the `index.js`
 * discovery shim.
 */

import { defineAdapterProbeSpec, type AdapterProbeSpec } from "@evoplug/host-runtime";

const PROVIDER = "evoplug-probe";
const MODEL = "probe-model";
const AGENT_DIR = "agent";
const MODELS = JSON.stringify(
  {
    providers: {
      [PROVIDER]: {
        baseUrl: "{capture_base_url}/v1",
        api: "openai-completions",
        apiKey: "local-probe",
        models: [
          {
            id: MODEL,
            name: "Kernel-controlled probe model",
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  },
  null,
  2
);

export const stepCodeProbeSpec: AdapterProbeSpec = defineAdapterProbeSpec({
  adapter_id: "step-code",
  construction_path: "cli",
  isolation: "local",
  mapping: "exact",
  observation: {
    protocol: "openai_chat",
    launch: {
      command: "step",
      args: [
        "--provider",
        PROVIDER,
        "--model",
        MODEL,
        "--thinking",
        "off",
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-update-check",
        "--non-interactive-approval",
        "deny",
        "--context-projection",
        "off",
        "--mode",
        "json",
        "-p",
        "{prompt}"
      ],
      env: {
        STEP_CODING_AGENT_DIR: `{setup_dir}/${AGENT_DIR}`,
        STEPCODE_DISABLE_PI_SERVICES: "1",
        NO_COLOR: "1",
        EVOPLUG_PROBE_SESSION_MODE: "ephemeral",
        EVOPLUG_PROBE_SESSION_INSTANCE: "{nonce}"
      },
      setup_files: [
        { path: `${AGENT_DIR}/models.json`, content: MODELS },
        { path: "models.json", content: MODELS }
      ],
      artifact_mount: `${AGENT_DIR}/extensions/evoplug`,
      discovery_entry: "index.js",
      timeout_ms: 28_000
    },
    load_check: { boundaries: ["new_session", "restart"] }
  }
});
