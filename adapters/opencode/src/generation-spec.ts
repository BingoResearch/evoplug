/**
 * OpenCode non-interactive generation declaration (W9, DD-HOST-002).
 *
 * `opencode run --format json PROMPT` is the existing, real entry. The kernel
 * owns the process boundary; this file is plain data and never imports
 * `@evoplug/kernel`. Provider/model selection stays in the user's OpenCode
 * configuration and is deliberately not part of the argv.
 */

import { OPENCODE_HOST_ID, OPENCODE_HOST_VERSION } from "./manifest.js";
import {
  OPENCODE_OUTPUT_EXTRACT,
  OPENCODE_OUTPUT_NORMALIZATION
} from "./generation-output.js";

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

export const OPENCODE_GENERATION_SPEC: GenerationSpecDeclaration = Object.freeze({
  schema_version: "rsi.cli_generation_spec/1" as const,
  backend_id: "opencode.cli_spawn",
  host_id: OPENCODE_HOST_ID,
  backend_version: OPENCODE_HOST_VERSION,
  binary_name: "opencode",
  // 2.1.4's `run [message...]` treats a positional message as a JSON string:
  // a prompt containing quotes arrives with every quote escaped, so the model
  // sees `\"` in protocol instructions and the frozen snapshot no longer
  // parses. Piping the prompt to stdin delivers the exact bytes and keeps the
  // argv free of prompt text.
  argv_template: Object.freeze(["run", "--standalone", "--format", "json", "--agent", "evoplug-generation"]),
  prompt_transport: "stdin" as const,
  output_protocol: "jsonl" as const,
  output_extract: OPENCODE_OUTPUT_EXTRACT,
  output_normalization: OPENCODE_OUTPUT_NORMALIZATION,
  // Appendix N.2: the wall-clock budget matches the review budget and is far
  // above the shortest real-model generation observed for a full snapshot.
  timeout_ms: 600_000,
  cancel_signal: "SIGTERM" as const,
  max_output_bytes: 32 * 1024 * 1024,
  availability: "available" as const,
  verification: "entry_observed" as const,
  protocol_versions: Object.freeze(["opencode-run-json/1"]),
  network: "enabled" as const,
  legacy_default_backend: true as const,
  metadata_probe: Object.freeze({
    schema_version: "rsi.cli_metadata_probe/1" as const,
    argv_template: Object.freeze(["models"]),
    output_protocol: "model_lines" as const,
    timeout_ms: 15_000,
    max_output_bytes: 1_048_576,
    cancel_signal: "SIGTERM" as const
  })
});
