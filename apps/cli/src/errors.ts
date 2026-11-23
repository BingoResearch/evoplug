/**
 * CLI-owned error envelopes (DD-FND-101, DD-FND-103).
 *
 * `apps/cli` depends on `@evoplug/core` and `@evoplug/ipc` only (DD-FND-021),
 * so the two codes the dispatcher emits carry their registry rows locally.
 * Category, retryable, side-effect, detail branch and stage are copied
 * verbatim from DD-FND-103.1; `E_CLI_UNKNOWN_COMMAND` uses the `none` detail
 * branch, `E_SCHEMA` the `field` branch.
 */

import type { ErrorCategory, ErrorDetails, ErrorEnvelope } from "@evoplug/core";
import { makeErrorEnvelope } from "@evoplug/core";

type CliErrorCode = "E_SCHEMA" | "E_CLI_UNKNOWN_COMMAND";

interface CliErrorSpec {
  readonly code: CliErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly message_key: string;
  readonly stage: string;
}

const CLI_ERROR_REGISTRY: Readonly<Record<CliErrorCode, CliErrorSpec>> = {
  E_SCHEMA: {
    code: "E_SCHEMA",
    category: "schema",
    retryable: false,
    message_key: "error.schema.invalid",
    stage: "schema_validate"
  },
  E_CLI_UNKNOWN_COMMAND: {
    code: "E_CLI_UNKNOWN_COMMAND",
    category: "usage",
    retryable: false,
    message_key: "error.cli.unknown_command",
    stage: "cli_dispatch"
  }
};

/** Builds a complete envelope from one of the CLI registry rows. */
function cliError(code: CliErrorCode, details: ErrorDetails): ErrorEnvelope {
  const spec = CLI_ERROR_REGISTRY[code];
  return makeErrorEnvelope({
    code: spec.code,
    category: spec.category,
    retryable: spec.retryable,
    message_key: spec.message_key,
    details,
    stage: spec.stage
  });
}

/** `E_SCHEMA` with the `field` detail branch (DD-FND-035). */
export function cliFieldError(path: string, rule: string): ErrorEnvelope {
  return cliError("E_SCHEMA", { kind: "field", path, rule });
}

/** `E_CLI_UNKNOWN_COMMAND`: the registry row carries no detail payload. */
export function cliUnknownCommandError(): ErrorEnvelope {
  return cliError("E_CLI_UNKNOWN_COMMAND", { kind: "none" });
}
