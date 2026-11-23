/**
 * `evolve` exit codes (DD-FND-101).
 *
 * | 0 success/no_op | 1 rejected/unknown/failed | 2 argument/config input |
 * | 3 uninitialized/unsupported/unavailable | 4 conflict/approval/auth |
 * | 5 degraded/partial | 130 cancelled |
 *
 * Failure status wins first (`conflict`→4, `degraded`/`pending`→5,
 * `unknown`→1), then the registered code and category refine a `rejected`
 * result. `E_SCHEMA` and `E_CLI_UNKNOWN_COMMAND` are the input-shape codes and
 * map to 2.
 */

import type { ErrorEnvelope, FailureStatus } from "@evoplug/core";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 3;
export const EXIT_CONFLICT = 4;
export const EXIT_DEGRADED = 5;
export const EXIT_CANCELLED = 130;

export const EXIT_CODES: {
  readonly ok: 0;
  readonly failed: 1;
  readonly usage: 2;
  readonly unavailable: 3;
  readonly conflict: 4;
  readonly degraded: 5;
  readonly cancelled: 130;
} = {
  ok: 0,
  failed: 1,
  usage: 2,
  unavailable: 3,
  conflict: 4,
  degraded: 5,
  cancelled: 130
};

const INPUT_CODES: ReadonlySet<string> = new Set([
  "E_SCHEMA",
  "E_CLI_UNKNOWN_COMMAND",
  "E_EGRESS_REQUEST_PREIMAGE",
  "E_EGRESS_REQUEST_INVALID"
]);

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "E_HOME_INCOMPATIBLE",
  "E_SCHEMA_MAJOR_UNSUPPORTED",
  "E_LEGACY_READ_ONLY",
  "E_IPC_DISCONNECTED",
  "E_IPC_METHOD_UNKNOWN"
]);

const CONFLICT_CODES: ReadonlySet<string> = new Set([
  "E_INSTALL_CONFLICT",
  "E_UNINSTALL_NONMANAGED",
  "E_PATH_ESCAPE",
  "E_IPC_AUTH"
]);

/** Maps one failed `Result` to the documented exit code. */
export function exitCodeForFailure(status: FailureStatus, error: ErrorEnvelope): number {
  if (error.code === "E_CANCELLED") {
    return EXIT_CANCELLED;
  }
  switch (status) {
    case "conflict":
      return EXIT_CONFLICT;
    case "degraded":
    case "pending":
      return EXIT_DEGRADED;
    case "unknown":
      return EXIT_FAILED;
    case "rejected":
      break;
  }
  if (INPUT_CODES.has(error.code)) {
    return EXIT_USAGE;
  }
  if (UNAVAILABLE_CODES.has(error.code)) {
    return EXIT_UNAVAILABLE;
  }
  if (CONFLICT_CODES.has(error.code) || error.category === "authorization") {
    return EXIT_CONFLICT;
  }
  return EXIT_FAILED;
}
