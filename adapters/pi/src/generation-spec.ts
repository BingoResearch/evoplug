/**
 * Pi non-interactive generation declaration (W9, DD-HOST-002).
 *
 * `pi --mode json -p PROMPT` is the print-mode entry measured on 2026-10-20.
 * The prompt is positional; output is one structured JSON line per event.
 * Provider and model configuration belong to Pi and are never appended here.
 */

import { PI_HOST_ID, PI_HOST_VERSION } from "./manifest.js";

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
    readonly output_protocol: "models_table" | "model_lines" | "json";
    readonly fields?: Readonly<Record<string, readonly string[]>>;
    readonly size_fields?: readonly string[];
    readonly static_fields?: Readonly<Record<string, string>>;
    readonly timeout_ms: number;
    readonly max_output_bytes: number;
    readonly cancel_signal: "SIGTERM" | "SIGINT";
  };
}

export const PI_GENERATION_SPEC: GenerationSpecDeclaration = Object.freeze({
  schema_version: "rsi.cli_generation_spec/1" as const,
  backend_id: "pi.cli_spawn",
  host_id: PI_HOST_ID,
  backend_version: PI_HOST_VERSION,
  binary_name: "pi",
  argv_template: Object.freeze([
    "--mode",
    "json",
    "--no-tools",
    "--no-extensions",
    "--system-prompt",
    "You are a deterministic JSON Lines generator. Never call tools, never read files, and never emit tool-call markup. Reply only with the requested protocol lines.",
    "-p",
    "{{prompt}}"
  ]),
  prompt_transport: "argv" as const,
  output_protocol: "jsonl" as const,
  output_extract: Object.freeze({
    schema_version: "rsi.cli_output_extract/1" as const,
    select: Object.freeze([
      Object.freeze({ path: "type", equals: "message_end" }),
      Object.freeze({ path: "message.role", equals: "assistant" })
    ]),
    text_paths: Object.freeze(["message.content.*.text"]),
    combine: "last" as const
  }),
  output_normalization: Object.freeze({
    schema_version: "rsi.cli_output_normalization/1" as const,
    final_newline: "ensure" as const
  }),
  // Reasoning models can spend minutes before the first protocol line; the
  // closure fake provider answers immediately, but a real OpenRouter run needs
  // headroom beyond the previous 120 s cap.
  timeout_ms: 300_000,
  cancel_signal: "SIGTERM" as const,
  max_output_bytes: 32 * 1024 * 1024,
  availability: "available" as const,
  verification: "entry_observed" as const,
  protocol_versions: Object.freeze(["pi-print-json/1"]),
  network: "enabled" as const,
  metadata_probe: Object.freeze({
    schema_version: "rsi.cli_metadata_probe/1" as const,
    argv_template: Object.freeze(["--list-models"]),
    output_protocol: "models_table" as const,
    fields: Object.freeze({
      provider_scope: Object.freeze(["provider"]),
      model_id: Object.freeze(["model"]),
      request_max_tokens: Object.freeze(["context"]),
      question_max_tokens: Object.freeze(["context"]),
      max_output_tokens: Object.freeze(["max-out"])
    }),
    size_fields: Object.freeze(["context", "max-out"]),
    timeout_ms: 20_000,
    max_output_bytes: 1_048_576,
    cancel_signal: "SIGTERM" as const
  })
});
