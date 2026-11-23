/**
 * `rsi.cli/1` result object (DD-FND-101).
 *
 * With `--json` stdout carries exactly one object: `command`, `ok` and either
 * `result` or `error`. Errors are also written to stderr as the bare
 * `ErrorEnvelope`. Human text is deliberately not a stable contract.
 */

import type { ErrorDiagnostic, ErrorEnvelope, JsonValue } from "@evoplug/core";
import { errorDiagnostic, toJsonValue } from "@evoplug/core";

const CLI_RESULT_SCHEMA_VERSION: "rsi.cli/1" = "rsi.cli/1";

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
      /** Two-layer projection: category code, reason and the next action. */
      readonly diagnostic: ErrorDiagnostic;
    };

export function cliSuccess(command: string, result: JsonValue): CliJsonOutput {
  return { schema_version: CLI_RESULT_SCHEMA_VERSION, command, ok: true, result };
}

export function cliFailure(command: string, error: ErrorEnvelope): CliJsonOutput {
  const base = errorDiagnostic(error.code);
  // A disabled feature carries its stable reason in the envelope rule; the
  // generic category reason ("disabled") is less specific than the contract.
  const diagnostic =
    error.code === "E_DISABLED" && error.details.kind === "field"
      ? { ...base, reason: error.details.rule }
      : base;
  return {
    schema_version: CLI_RESULT_SCHEMA_VERSION,
    command,
    ok: false,
    error,
    diagnostic
  };
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
  const diagnostic = output.diagnostic ?? errorDiagnostic(output.error.code);
  const nextAction = output.error.code === "E_DISABLED"
    ? "该功能暂时没有启用；开启对应开关后再试"
    : diagnostic.next_action;
  return `evolve ${output.command}: ${diagnostic.category_code} (${diagnostic.reason}, ${output.error.stage})\n下一步：${nextAction}\n${JSON.stringify(output.error, null, 2)}`;
}
