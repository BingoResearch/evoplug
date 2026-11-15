/**
 * `rsi.cli/1` result object (DD-FND-101).
 *
 * With `--json` stdout carries exactly one object: `command`, `ok` and either
 * `result` or `error`. Errors are also written to stderr as the bare
 * `ErrorEnvelope`. Human text is deliberately not a stable contract.
 */

import type { ErrorEnvelope, JsonValue } from "@evoplug/core";
import { toJsonValue } from "@evoplug/core";

export const CLI_RESULT_SCHEMA_VERSION: "rsi.cli/1" = "rsi.cli/1";

export type CliJsonOutput =
  | {
      readonly schema_version: "rsi.cli/1";
      readonly command: string;
      readonly ok: true;
      readonly result: JsonValue;
    }
  | {
      readonly schema_version: "rsi.cli/1";
      readonly command: string;
      readonly ok: false;
      readonly error: ErrorEnvelope;
    };

export class CliResultEncodingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliResultEncodingError";
  }
}

export function cliSuccess(command: string, result: JsonValue): CliJsonOutput {
  return { schema_version: CLI_RESULT_SCHEMA_VERSION, command, ok: true, result };
}

export function cliFailure(command: string, error: ErrorEnvelope): CliJsonOutput {
  return { schema_version: CLI_RESULT_SCHEMA_VERSION, command, ok: false, error };
}

/** Converts a typed service result into the JSON body of `rsi.cli/1`. */
export function encodeResultValue(value: unknown): JsonValue {
  return toJsonValue(value);
}

/** One-line human summary; the structured object remains the contract. */
export function renderHuman(output: CliJsonOutput): string {
  if (output.ok) {
    return `evolve ${output.command}: ok\n${JSON.stringify(output.result, null, 2)}`;
  }
  return `evolve ${output.command}: ${output.error.code} (${output.error.stage})\n${JSON.stringify(output.error, null, 2)}`;
}
