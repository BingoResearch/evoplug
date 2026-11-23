/**
 * Codex generation declaration (W9, DD-HOST-002).
 *
 * The product entry is `codex exec --json --skip-git-repo-check PROMPT`.
 * The installed 0.160.1 binary answered through host-inherited auth on
 * 2026-10-26; the historical region block is no longer declared. The entry
 * stays `entry_observed` until a persisted capability row raises it.
 */

import { CODEX_HOST_ID, CODEX_HOST_VERSION } from "./manifest.js";

/**
 * Structural mirror of the kernel's `CliGenerationSpec`.
 *
 * Adapters may not import the kernel (DD-FND-021), so the declaration shape is
 * repeated here and checked structurally by the kernel factory.
 */
export interface GenerationSpecDeclaration {
  readonly schema_version: "rsi.cli_generation_spec/1";
  readonly backend_id: string;
  readonly host_id: string;
  readonly backend_version: string;
  readonly binary_name: string;
  readonly executable_env?: string;
  readonly argv_template: readonly string[];
  readonly prompt_transport: "stdin" | "argv" | "file";
  readonly output_protocol: "jsonl" | "json_result" | "text";
  readonly result_field?: string;
  /** Declarative text extraction from a `jsonl` host event stream. */
  readonly output_extract?: {
    readonly schema_version: "rsi.cli_output_extract/1";
    readonly select?: readonly {
      readonly path: string;
      readonly equals: string | number | boolean;
    }[];
    readonly text_paths: readonly string[];
    readonly combine?: "first" | "last" | "concat";
  };
  /** Declarative final-newline policy for the extracted candidate text. */
  readonly output_normalization?: {
    readonly schema_version: "rsi.cli_output_normalization/1";
    readonly final_newline?: "preserve" | "ensure";
  };
  readonly timeout_ms: number;
  readonly cancel_signal: "SIGTERM" | "SIGINT";
  readonly max_output_bytes: number;
  readonly availability: "available" | "blocked" | "unsupported";
  readonly verification: "native_verified" | "entry_observed" | "unverified" | "blocked";
  readonly blocker_code?: string;
  readonly protocol_versions: readonly string[];
  readonly network: "disabled" | "restricted" | "enabled";
  readonly glue_script?: string;
  readonly legacy_default_backend?: boolean;
}

export const CODEX_GENERATION_SPEC: GenerationSpecDeclaration = Object.freeze({
  schema_version: "rsi.cli_generation_spec/1" as const,
  backend_id: "codex.cli_spawn",
  host_id: CODEX_HOST_ID,
  backend_version: CODEX_HOST_VERSION,
  binary_name: "codex",
  argv_template: Object.freeze([
    "exec",
    "--json",
    "--skip-git-repo-check",
    // Appendix F.3/J.3/N.2: no tools and no extensions in the generation
    // child. 0.160.1 exposes no single "no tools" switch; these feature
    // switches remove shell/exec, browser, computer use, code mode, apps,
    // skills, sub-agents, goals and image tools. `--ephemeral` also keeps the
    // run out of the host's session history.
    "--ephemeral",
    // The generation child must not run evoplug's own hooks (appendix F.3).
    "--disable", "hooks",
    // No repository or execpolicy documents enter the prompt: the snapshot is
    // the complete generation context (appendix F.3/N.2).
    "--ignore-rules",
    "-c", "project_doc_max_bytes=0",
    "--disable", "shell_tool",
    "--disable", "unified_exec",
    "--disable", "unified_exec_tty",
    "--disable", "browser_use",
    "--disable", "browser_use_external",
    "--disable", "browser_use_full_cdp_access",
    "--disable", "computer_use",
    "--disable", "code_mode",
    "--disable", "apps",
    "--disable", "codex_apps_mcp_2026_07_28",
    "--disable", "skill_search",
    "--disable", "tool_suggest",
    "--disable", "request_permissions_tool",
    "--disable", "sleep_tool",
    "--disable", "goals",
    "--disable", "multi_agent",
    "--disable", "view_image",
    "--disable", "image_generation",
    "-c", "tools.web_search=false",
    "{{prompt}}"
  ]),
  prompt_transport: "argv" as const,
  output_protocol: "jsonl" as const,
  output_extract: Object.freeze({
    schema_version: "rsi.cli_output_extract/1" as const,
    select: Object.freeze([Object.freeze({ path: "item.type", equals: "agent_message" })]),
    text_paths: Object.freeze(["item.text"]),
    combine: "last" as const
  }),
  output_normalization: Object.freeze({
    schema_version: "rsi.cli_output_normalization/1" as const,
    final_newline: "ensure" as const
  }),
  // Appendix N.2: never below half of the 600,000 ms review wall budget.
  timeout_ms: 600_000,
  cancel_signal: "SIGTERM" as const,
  max_output_bytes: 32 * 1024 * 1024,
  availability: "available" as const,
  verification: "entry_observed" as const,
  protocol_versions: Object.freeze(["codex-exec-json/1"]),
  network: "enabled" as const
});
