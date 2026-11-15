/**
 * Probe binding declaration for the `oh-my-pi` adapter (W1).
 *
 * These are the facts the adapter itself can state about how its runtime is
 * constructed. The kernel supplies host version, binary hash and session scope
 * when it turns this spec into a `CapabilityBinding`; nothing here branches on
 * the host inside the kernel.
 *
 * The launch uses OMP's RPC headless entry (`--mode rpc --no-ui`). OMP only
 * emits its declared `input` hook when the user input arrives through the
 * interactive or RPC entry; print mode emits `before_agent_start`/`context`
 * instead, and those events are non-input contracts, so the kernel refuses
 * them for a session without an admitted scope and never stores their payload.
 * An `input` event is what admits the ephemeral probe session and lets the
 * kernel read the nonce-bearing upload.
 *
 * RPC mode takes prompts as JSON frames on stdin, while the kernel spawns the
 * declared command with stdin closed. `launcher.mjs` is therefore a small
 * declared client: it starts `omp`, waits for its `ready` frame, submits the
 * probe prompt, and closes stdin after the prompt result. The host, its input
 * event, its session and its provider request are all still produced by OMP
 * itself; the launcher invents no host fact.
 *
 * The kernel re-hashes the installed artifact and mounts those exact bytes in
 * `<agentDir>/extensions/evoplug`; `index.js` is the directory-discovery shim
 * attach also generates.
 */

import { defineAdapterProbeSpec, type AdapterProbeSpec } from "@evoplug/host-runtime";

const PROVIDER = "evoplug-probe";
const MODEL = "probe-model";
const AGENT_DIR = "agent";

/**
 * Tiny RPC client for the kernel-launched probe. It is declared as a setup
 * file (bytes the kernel writes, not part of the installed artifact) and is
 * deliberately dumb: no host event is fabricated here, it only forwards the
 * kernel's prompt to the host's own stdin protocol.
 */
const LAUNCHER = `import { spawn } from "node:child_process";

const [prompt, ...args] = process.argv.slice(2);
if (typeof prompt !== "string" || prompt.length === 0) process.exit(2);
const child = spawn("omp", args, { stdio: ["pipe", "pipe", "ignore"], env: process.env });
let seen = "";
let submitted = false;
const timer = setTimeout(() => {
  try {
    child.kill("SIGKILL");
  } catch {}
}, 26000);
child.on("error", () => {
  clearTimeout(timer);
  process.exit(1);
});
child.on("close", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 0);
});
child.stdout.on("data", (chunk) => {
  seen += chunk.toString("utf8");
  if (!submitted && seen.includes('"type":"ready"')) {
    submitted = true;
    child.stdin.write(
      JSON.stringify({ id: "evoplug-probe", type: "prompt", message: prompt }) + "\\n"
    );
  }
  if (submitted && seen.includes('"type":"prompt_result"')) {
    clearTimeout(timer);
    try {
      child.stdin.end();
    } catch {}
  }
});
`;

const MODELS = JSON.stringify(
  {
    providers: {
      [PROVIDER]: {
        baseUrl: "{capture_base_url}/v1",
        api: "openai-completions",
        apiKey: "local-probe",
        auth: "apiKey",
        models: [
          {
            id: MODEL,
            name: "Kernel-controlled probe model",
            api: "openai-completions",
            contextWindow: 32768,
            maxTokens: 1024,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  },
  null,
  2
);

export const ohMyPiProbeSpec: AdapterProbeSpec = defineAdapterProbeSpec({
  adapter_id: "oh-my-pi",
  construction_path: "cli",
  isolation: "local",
  mapping: "exact",
  observation: {
    protocol: "openai_chat",
    launch: {
      // `omp` itself is a Bun script; the launcher only supplies the RPC
      // prompt frame the kernel cannot write (its child stdin is closed).
      command: "bun",
      args: [
        "{setup_dir}/launcher.mjs",
        "{prompt}",
        "--mode",
        "rpc",
        "--no-ui",
        `--model=${PROVIDER}/${MODEL}`,
        "--thinking=off",
        "--no-tools",
        "--no-lsp",
        "--no-pty",
        "--no-skills",
        "--no-rules",
        "--no-title",
        "--max-time=20s"
      ],
      env: {
        PI_CODING_AGENT_DIR: `{setup_dir}/${AGENT_DIR}`,
        OMP_PROFILE: "",
        PI_PROFILE: "",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
        EVOPLUG_PROBE_SESSION_MODE: "ephemeral",
        EVOPLUG_PROBE_SESSION_INSTANCE: "{nonce}"
      },
      setup_files: [
        { path: `${AGENT_DIR}/models.yml`, content: MODELS },
        { path: "launcher.mjs", content: LAUNCHER }
      ],
      artifact_mount: `${AGENT_DIR}/extensions/evoplug`,
      discovery_entry: "index.js",
      timeout_ms: 28_000
    },
    load_check: { boundaries: ["new_session", "restart"] }
  }
});
