/**
 * Probe binding declaration for the `opencode` adapter (W1).
 *
 * These are the facts the adapter itself can state about how its runtime is
 * constructed. The kernel supplies host version, binary hash and session scope
 * when it turns this spec into a `CapabilityBinding`; nothing here branches on
 * the host inside the kernel.
 *
 * OpenCode 2.1.4 discovers named-export plugins in
 * `$XDG_CONFIG_HOME/opencode/plugin`; attach writes the single-file
 * `evoplug.js` artifact into that directory. The kernel re-hashes the
 * installed artifact and mounts those exact bytes at the same discovery path,
 * with an isolated XDG config home and an `@ai-sdk/openai-compatible` provider
 * pointing at the kernel capture endpoint.
 */

import { defineAdapterProbeSpec, type AdapterProbeSpec } from "@evoplug/host-runtime";

const PROVIDER = "evoplug-probe";
const MODEL = "probe-model";
const OPENCODE_VERSION = "2.1.4";
const CONFIG = JSON.stringify(
  {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    model: `${PROVIDER}/${MODEL}`,
    small_model: `${PROVIDER}/${MODEL}`,
    provider: {
      [PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Evoplug kernel probe",
        options: {
          baseURL: "{capture_base_url}/v1",
          apiKey: "local-probe"
        },
        models: { [MODEL]: { name: "Kernel-controlled probe model" } }
      }
    }
  },
  null,
  2
);

export const openCodeProbeSpec: AdapterProbeSpec = defineAdapterProbeSpec({
  adapter_id: "opencode",
  construction_path: "cli",
  isolation: "local",
  mapping: "partial",
  observation: {
    protocol: "openai_chat",
    launch: {
      command: "opencode",
      args: [
        "run",
        // A capability probe must not contend for the user's background
        // service port (49374 by default, commonly already taken). A private
        // server keeps the observation run isolated and lets the child exit
        // with the provider capture.
        "--standalone",
        "--model",
        `${PROVIDER}/${MODEL}`,
        "--title",
        "evoplug-probe",
        "{prompt}",
        "--format",
        "json"
      ],
      env: {
        HOME: "{setup_dir}/home",
        XDG_CONFIG_HOME: "{setup_dir}/xdg",
        XDG_DATA_HOME: "{setup_dir}/data",
        XDG_STATE_HOME: "{setup_dir}/state",
        XDG_CACHE_HOME: "{setup_dir}/cache",
        OPENAI_API_KEY: "local-probe",
        NO_COLOR: "1",
        EVOPLUG_PROBE_SESSION_MODE: "ephemeral",
        EVOPLUG_PROBE_SESSION_INSTANCE: "{nonce}"
      },
      setup_files: [
        { path: "home/.keep", content: "" },
        { path: "data/.keep", content: "" },
        { path: "state/.keep", content: "" },
        { path: "cache/.keep", content: "" },
        { path: "xdg/opencode/opencode.json", content: CONFIG },
        {
          path: "xdg/opencode/package.json",
          content: `${JSON.stringify(
            { dependencies: { "@opencode-ai/plugin": OPENCODE_VERSION }, type: "module" },
            null,
            2
          )}\n`
        },
        {
          path: "xdg/opencode/node_modules/@opencode-ai/plugin/package.json",
          content: `${JSON.stringify(
            {
              name: "@opencode-ai/plugin",
              version: OPENCODE_VERSION,
              type: "module",
              exports: { ".": "./index.js" }
            },
            null,
            2
          )}\n`
        },
        {
          path: "xdg/opencode/node_modules/@opencode-ai/plugin/index.js",
          content: "export {};\n"
        }
      ],
      // Attach writes the artifact directory contents directly into the
      // plugin directory; `evoplug.js` is the named-export entry.
      artifact_mount: "xdg/opencode/plugin",
      timeout_ms: 28_000
    },
    load_check: { boundaries: ["new_session", "restart"] }
  }
});
