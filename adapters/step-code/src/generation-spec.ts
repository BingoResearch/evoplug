/**
 * Step Code non-interactive generation declaration (W9, DD-HOST-002).
 *
 * `step --mode json -p PROMPT` is the print entry measured on 2026-10-20.
 * `registerProvider` remains a session concern of Step itself; the declaration
 * carries no provider flags.
 */

import { STEP_HOST_ID, STEP_HOST_VERSION } from "./manifest.js";

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

export const STEP_GENERATION_SPEC: GenerationSpecDeclaration = Object.freeze({
  schema_version: "rsi.cli_generation_spec/1" as const,
  backend_id: "step-code.cli_spawn",
  host_id: STEP_HOST_ID,
  backend_version: STEP_HOST_VERSION,
  binary_name: "step",
  argv_template: Object.freeze(["--mode", "json", "-p", "{{prompt}}"]),
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
  timeout_ms: 120_000,
  cancel_signal: "SIGTERM" as const,
  max_output_bytes: 32 * 1024 * 1024,
  availability: "available" as const,
  verification: "entry_observed" as const,
  protocol_versions: Object.freeze(["step-print-json/1"]),
  network: "enabled" as const
});
