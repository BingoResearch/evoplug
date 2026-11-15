/**
 * Claude Code non-interactive generation declaration (W9, DD-HOST-002).
 *
 * `claude -p PROMPT --output-format json` returns one JSON object; the
 * candidate text is the `result` field. Without OTEL raw bodies this path is
 * only `loaded` evidence, which is why the spec never claims verification.
 */

import { CLAUDE_HOST_ID, CLAUDE_HOST_VERSION } from "./manifest.js";

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
  /** Read-only native metadata command for ServiceProfile production. */
  readonly metadata_probe?: {
    readonly schema_version: "rsi.cli_metadata_probe/1";
    readonly argv_template: readonly string[];
    readonly output_protocol: "models_table" | "model_lines" | "json" | "text";
    readonly fields?: Readonly<Record<string, readonly string[]>>;
    readonly size_fields?: readonly string[];
    readonly static_fields?: Readonly<Record<string, string>>;
    readonly timeout_ms: number;
    readonly max_output_bytes: number;
    readonly cancel_signal: "SIGTERM" | "SIGINT";
  };
}

export const CLAUDE_CODE_GENERATION_SPEC: GenerationSpecDeclaration = Object.freeze({
  schema_version: "rsi.cli_generation_spec/1" as const,
  backend_id: "claude-code.cli_spawn",
  host_id: CLAUDE_HOST_ID,
  backend_version: CLAUDE_HOST_VERSION,
  binary_name: "claude",
  argv_template: Object.freeze(["-p", "{{prompt}}", "--output-format", "json"]),
  prompt_transport: "argv" as const,
  output_protocol: "json_result" as const,
  result_field: "result",
  output_normalization: Object.freeze({
    schema_version: "rsi.cli_output_normalization/1" as const,
    final_newline: "ensure" as const
  }),
  timeout_ms: 180_000,
  cancel_signal: "SIGTERM" as const,
  max_output_bytes: 32 * 1024 * 1024,
  availability: "available" as const,
  verification: "entry_observed" as const,
  protocol_versions: Object.freeze(["claude-print-json/1"]),
  network: "enabled" as const,
  metadata_probe: Object.freeze({
    schema_version: "rsi.cli_metadata_probe/1" as const,
    argv_template: Object.freeze(["doctor"]),
    output_protocol: "text" as const,
    static_fields: Object.freeze({ provider_scope: "anthropic" }),
    timeout_ms: 20_000,
    max_output_bytes: 1_048_576,
    cancel_signal: "SIGTERM" as const
  })
});
