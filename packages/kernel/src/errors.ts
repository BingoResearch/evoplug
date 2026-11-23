/**
 * Kernel-owned error construction (DD-FND-034, DD-FND-103).
 *
 * `schemas/errors/registry.json` is the single machine source for error
 * metadata. Until the generated `ErrorCode` union lands in `@evoplug/core`,
 * this module carries the registry rows for the codes the composition root,
 * the home bootstrap and the CLI dispatch actually emit. Category, stage,
 * retryable and side-effect values are copied verbatim from DD-FND-103.1.
 */

import type {
  ErrorCategory,
  ErrorCode,
  ErrorDetails,
  ErrorEnvelope,
  ErrorSideEffect
} from "@evoplug/core";
import { makeErrorEnvelope } from "@evoplug/core";

interface KernelErrorSpec {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly stage: string;
  readonly message_key: string;
  readonly retryable: boolean;
  readonly side_effect: ErrorSideEffect;
}

const specs: readonly KernelErrorSpec[] = [
  {
    code: "E_SCHEMA",
    category: "schema",
    stage: "schema_validate",
    message_key: "error.schema.invalid",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_CLI_UNKNOWN_COMMAND",
    category: "usage",
    stage: "cli_dispatch",
    message_key: "error.cli.unknown_command",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_HOME_INCOMPATIBLE",
    category: "version",
    stage: "home_init",
    message_key: "error.home.incompatible",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_SCHEMA_MAJOR_UNSUPPORTED",
    category: "version",
    stage: "startup",
    message_key: "error.schema.major_unsupported",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_LEGACY_READ_ONLY",
    category: "version",
    stage: "legacy_read",
    message_key: "error.legacy.read_only",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_VERSION_BINDING",
    category: "version",
    stage: "binding",
    message_key: "error.version.binding",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_PATH_ESCAPE",
    category: "authorization",
    stage: "path_check",
    message_key: "error.path.escape",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_INSTALL_CONFLICT",
    category: "conflict",
    stage: "install_scan",
    message_key: "error.install.conflict",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_UNINSTALL_NONMANAGED",
    category: "conflict",
    stage: "uninstall",
    message_key: "error.uninstall.nonmanaged",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_IDEMPOTENCY_CONFLICT",
    category: "conflict",
    stage: "persist",
    message_key: "error.idempotency.conflict",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_IPC_IN_PROGRESS",
    category: "conflict",
    stage: "ipc_idempotency",
    message_key: "error.ipc.in_progress",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_IPC_IDEMPOTENCY_UNCERTAIN",
    category: "internal",
    stage: "ipc_idempotency",
    message_key: "error.ipc.idempotency_uncertain",
    retryable: false,
    side_effect: "unknown"
  },
  {
    code: "E_REBUILD_DIVERGENCE",
    category: "internal",
    stage: "rebuild",
    message_key: "error.rebuild.divergence",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_JOURNAL_CORRUPT_MIDDLE",
    category: "storage",
    stage: "recovery",
    message_key: "error.journal.corrupt_middle",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_SCHEMA_COMPAT_UNPROVEN",
    category: "version",
    stage: "startup",
    message_key: "error.schema.compat_unproven",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_EGRESS_REQUEST_PREIMAGE",
    category: "schema",
    stage: "egress_request",
    message_key: "error.egress.request_preimage",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_EGRESS_REQUEST_INVALID",
    category: "schema",
    stage: "egress_request",
    message_key: "error.egress.request_invalid",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_CONFLICT",
    category: "conflict",
    stage: "persist",
    message_key: "error.conflict.generic",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_IO",
    category: "storage",
    stage: "io",
    message_key: "error.io.failed",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_STORAGE_BUSY",
    category: "storage",
    stage: "persist",
    message_key: "error.storage.busy",
    retryable: true,
    side_effect: "none"
  },
  {
    code: "E_OVERLOAD",
    category: "capacity",
    stage: "admission",
    message_key: "error.capacity.overload",
    retryable: true,
    side_effect: "none"
  },
  {
    code: "E_IPC_AUTH",
    category: "authorization",
    stage: "ipc_auth",
    message_key: "error.ipc.auth",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_IPC_DISCONNECTED",
    category: "ipc",
    stage: "ipc_transport",
    message_key: "error.ipc.disconnected",
    retryable: true,
    side_effect: "none"
  },
  {
    code: "E_IPC_METHOD_UNKNOWN",
    category: "usage",
    stage: "ipc_dispatch",
    message_key: "error.ipc.method_unknown",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_DEADLINE_EXCEEDED",
    category: "deadline",
    stage: "request_control",
    message_key: "error.deadline.exceeded",
    retryable: true,
    side_effect: "none"
  },
  {
    code: "E_CANCELLED",
    category: "deadline",
    stage: "request_control",
    message_key: "error.request.cancelled",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_INTERNAL",
    category: "internal",
    stage: "internal",
    message_key: "error.internal.unexpected",
    retryable: false,
    side_effect: "none"
  },
  {
    code: "E_CONFIG_FIELD_NOT_ACTIVE",
    category: "policy",
    stage: "config_autotune",
    message_key: "error.config.field_not_active",
    retryable: false,
    side_effect: "none"
  }
];

const BY_CODE: ReadonlyMap<string, KernelErrorSpec> = new Map(specs.map((spec) => [spec.code, spec]));

class UnknownKernelErrorCodeError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(`kernel error code is not registered: ${code}`);
    this.name = "UnknownKernelErrorCodeError";
    this.code = code;
  }
}

function kernelErrorSpec(code: string): KernelErrorSpec {
  const spec = BY_CODE.get(code);
  if (spec === undefined) {
    throw new UnknownKernelErrorCodeError(code);
  }
  return spec;
}

interface KernelErrorOptions {
  readonly details?: ErrorDetails;
  readonly retryable?: boolean;
  readonly side_effect?: ErrorSideEffect;
  readonly retry_after_ms?: number;
}

/** Builds an envelope with the registered metadata for `code`. */
export function kernelError(code: string, options?: KernelErrorOptions): ErrorEnvelope {
  const spec = kernelErrorSpec(code);
  return makeErrorEnvelope({
    code: spec.code,
    category: spec.category,
    message_key: spec.message_key,
    stage: spec.stage,
    details: options?.details ?? { kind: "none" },
    retryable: options?.retryable ?? spec.retryable,
    side_effect: options?.side_effect ?? spec.side_effect,
    ...(options?.retry_after_ms === undefined ? {} : { retry_after_ms: options.retry_after_ms })
  });
}

/** Field-level schema rejection used by config parsing and CLI argument parsing. */
export function fieldError(path: string, rule: string, code = "E_SCHEMA"): ErrorEnvelope {
  return kernelError(code, { details: { kind: "field", path, rule } });
}

export function internalError(incidentId: string): ErrorEnvelope {
  return kernelError("E_INTERNAL", { details: { kind: "internal", incident_id: incidentId } });
}

export function versionError(expected: string, actual: string, code = "E_VERSION_BINDING"): ErrorEnvelope {
  return kernelError(code, { details: { kind: "version", expected, actual } });
}

/** A home persisted below the current schema major is exported, not migrated. */
export function oldHomeError(expected: string, actual: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA_MAJOR_UNSUPPORTED",
    category: "version",
    retryable: false,
    side_effect: "none",
    message_key: "error.schema.old_home_export_required",
    stage: "startup",
    details: { kind: "version", expected, actual }
  });
}
