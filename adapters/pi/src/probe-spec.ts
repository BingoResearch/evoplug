/**
 * Probe binding declaration for the `pi` adapter (W1).
 *
 * These are the facts the adapter itself can state about how its runtime is
 * constructed. The kernel supplies host version, binary hash and session scope
 * when it turns this spec into a `CapabilityBinding`; nothing here branches on
 * the host inside the kernel.
 */

import { defineAdapterProbeSpec, type AdapterProbeSpec } from "@evoplug/host-runtime";

export const piProbeSpec: AdapterProbeSpec = defineAdapterProbeSpec({
  adapter_id: "pi",
  construction_path: "cli",
  isolation: "local",
  mapping: "exact",
  // Kernel-executed native contract: the kernel runs the real Pi CLI against a
  // loopback capture endpoint it owns. The declaration is Pi-specific; the
  // kernel has no host branch. Until the child proves it loaded this exact
  // registration artifact under its own native session, the result is recorded
  // as `native_cli_contract` and no capability is upgraded.
  observation: {
    protocol: "openai_chat",
    launch: {
      command: "pi",
      args: [
        "--print",
        "--mode", "json",
        "--provider", "evoplug-probe",
        "--model", "probe-model",
        "--thinking", "off",
        "{prompt}"
      ],
      env: {
        PI_CODING_AGENT_DIR: "{setup_dir}",
        NO_COLOR: "1",
        EVOPLUG_PROBE_SESSION_MODE: "ephemeral",
        EVOPLUG_PROBE_SESSION_INSTANCE: "{nonce}"
      },
      setup_files: [
        {
          path: "models.json",
          content: JSON.stringify(
            {
              providers: {
                "evoplug-probe": {
                  baseUrl: "{capture_base_url}/v1",
                  api: "openai-completions",
                  apiKey: "local-probe",
                  models: [
                    {
                      id: "probe-model",
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
          )
        }
      ],
      // Pi loads the installed Evoplug extension from this agent-dir path. The
      // kernel verifies the installed artifact hashes and copies those exact
      // bytes here, so the child runs the same artifact as the registration.
      artifact_mount: "extensions/evoplug",
      discovery_entry: "index.js",
      timeout_ms: 120_000
    },
    // A kernel-run Pi process loads the mounted extension before the print
    // turn, so it is a readback for a fresh session/restart, not for reload.
    load_check: { boundaries: ["new_session", "restart"] }
  }
});
