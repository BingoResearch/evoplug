/**
 * CFG error surface and cross-domain error mapping (DD-CFG-055, DD-CFG-057,
 * DD-CFG-073, DD-CFG-144 … DD-CFG-171).
 *
 * Every CFG operation returns one `ConfigError`; the code set is closed. The
 * `message_key` is derived from the code (`E_CFG_FIELD_UNKNOWN` →
 * `cfg.field_unknown`) so the pair stays one-to-one. `details` carries only
 * registered `ConfigScalar` pairs.
 */

import type { ErrorEnvelope } from "../errors.js";
import type { ConfigError, ConfigErrorCode, ConfigErrorDetail, ConfigResult, ConfigScalar } from "./types.js";

export const CONFIG_ERROR_CODES: readonly ConfigErrorCode[] = [
  "E_CFG_HOST_VERSION_UNBOUND",
  "E_CFG_MODE_UNBOUND",
  "E_CFG_MODEL_UNBOUND",
  "E_CFG_FIELD_UNKNOWN",
  "E_CFG_FIELD_NOT_EXECUTABLE",
  "E_CFG_FIELD_TYPE",
  "E_CFG_FIELD_RANGE",
  "E_CFG_FIELD_UNIT",
  "E_CFG_DEFAULT_UNKNOWN",
  "E_CFG_COUPLING_INCOMPLETE",
  "E_CFG_NORMALIZATION_MISSING",
  "E_CFG_NORMALIZATION_MISMATCH",
  "E_CFG_NORMALIZATION_SHADOWED",
  "E_CFG_NORMALIZATION_UNVERIFIED",
  "E_CFG_NORMALIZATION_INPUT",
  "E_CFG_FORBIDDEN_FIELD",
  "E_CFG_AUTHORIZATION_MISSING",
  "E_CFG_AUTHORIZATION_SCOPE",
  "E_CFG_STALE_BASELINE",
  "E_CFG_FIELD_CONFLICT",
  "E_CFG_EXTERNAL_CHANGE",
  "E_CFG_APPLY_UNCONFIRMED",
  "E_CFG_READBACK_TIMEOUT",
  "E_CFG_MULTI_FILE_FACTOR",
  "E_CFG_PROTECTED_SUBTREE",
  "E_CFG_WRITE_FAILED",
  "E_CFG_WRITE_UNCERTAIN",
  "E_CFG_ROLLBACK_CONFLICT",
  "E_CFG_RECOVERY_REQUIRED",
  "E_CFG_FIELD_CLAIMED",
  "E_CFG_ACTIVE_TRIAL",
  "E_CFG_IDEMPOTENCY_CONFLICT",
  "E_CFG_PLAN_NOT_FOUND",
  "E_CFG_TRIAL_NOT_FOUND",
  "E_CFG_TRIAL_TERMINAL",
  "E_CFG_ILLEGAL_TRANSITION",
  "E_CFG_BUDGET_EXHAUSTED",
  "E_CFG_LEGACY_UNVERIFIED",
  "E_CFG_REGISTRY_AMBIGUOUS",
  "E_CFG_SNAPSHOT_HASH",
  "E_CFG_GUARDRAIL_UNKNOWN",
  "E_CFG_GUARDRAIL_SPEC",
  "E_CFG_GUARDRAIL_BREACH",
  "E_CFG_CAPABILITY_UNVERIFIED",
  "E_CFG_CAPACITY_UNVERIFIED",
  "E_CFG_CAPACITY_MISMATCH",
  "E_CFG_ROOT_UNRESOLVED",
  "E_CFG_ROOT_UNAVAILABLE",
  "E_CFG_ROOT_INVALID",
  "E_CFG_ROOT_AMBIGUOUS",
  "E_CFG_ROOT_IDENTITY_MISMATCH",
  "E_CFG_FORMULA_HASH",
  "E_CFG_OBSERVATION_HASH",
  "E_CFG_WRITE_PORT_UNSUPPORTED",
  "E_CFG_ROLLBACK_UNCERTAIN",
  "E_CFG_DEADLINE_EXCEEDED",
  "E_CFG_CANCELLED"
];

/**
 * Codes whose operation may be repeated without changing durable or host
 * state (read-only retry paths only). All other codes require a new plan,
 * trial, attempt or operator decision.
 */
const RETRYABLE_CODES: ReadonlySet<ConfigErrorCode> = new Set([
  "E_CFG_READBACK_TIMEOUT",
  "E_CFG_WRITE_UNCERTAIN",
  "E_CFG_DEADLINE_EXCEEDED",
  "E_CFG_CANCELLED",
  "E_CFG_ROOT_UNAVAILABLE"
]);

/** `E_CFG_FIELD_UNKNOWN` → `cfg.field_unknown`. */
export function messageKeyFor(code: ConfigErrorCode): string {
  return `cfg.${code.slice("E_CFG_".length).toLowerCase()}`;
}

export function isConfigErrorCode(value: string): value is ConfigErrorCode {
  return (CONFIG_ERROR_CODES as readonly string[]).includes(value);
}

export function isRetryable(code: ConfigErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

interface ConfigErrorInit {
  field_id?: string | null;
  path?: string | null;
  details?: readonly ConfigErrorDetail[];
}

/** Builds a `ConfigError` with the registry `message_key` and retryability. */
export function configError(code: ConfigErrorCode, init: ConfigErrorInit = {}): ConfigError {
  return {
    code,
    message_key: messageKeyFor(code),
    field_id: init.field_id ?? null,
    path: init.path ?? null,
    retryable: isRetryable(code),
    details: init.details ?? []
  };
}

export function fail<T>(error: ConfigError): ConfigResult<T> {
  return { ok: false, error };
}

export function succeed<T>(value: T): ConfigResult<T> {
  return { ok: true, value };
}

/**
 * `ConfigError.path` may only carry a relative file path, a settings key path,
 * a setter id or an env name (DD-CFG-144). Absolute paths and `~` are rejected.
 */
export function isValidConfigErrorPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) {
    return false;
  }
  if (path.startsWith("/") || path.startsWith("~") || path.startsWith("$")) {
    return false;
  }
  if (path.includes("\\") || path.includes("\u0000")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(path) || path.startsWith("//")) {
    return false;
  }
  return true;
}

/** Validates the closed detail set: unique keys, scalar values, safe path. */
export function validateConfigError(error: ConfigError): ConfigResult<ConfigError> {
  if (error.message_key !== messageKeyFor(error.code)) {
    return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "message_key", value: "mismatch" }] }));
  }
  if (error.path !== null && !isValidConfigErrorPath(error.path)) {
    return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "path", value: "absolute_or_unsafe" }] }));
  }
  const keys = new Set<string>();
  for (const entry of error.details) {
    if (keys.has(entry.key) || entry.key.length === 0 || entry.key.length > 64) {
      return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "detail_key", value: entry.key }] }));
    }
    keys.add(entry.key);
    if (
      entry.value !== null &&
      typeof entry.value !== "string" &&
      typeof entry.value !== "number" &&
      typeof entry.value !== "boolean"
    ) {
      return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "detail_value", value: entry.key }] }));
    }
    if (typeof entry.value === "number" && !Number.isFinite(entry.value)) {
      return fail(configError("E_CFG_FIELD_TYPE", { details: [{ key: "detail_value", value: entry.key }] }));
    }
  }
  return succeed(error);
}

/** Detail helper restricted to scalar values. */
export function detail(key: string, value: ConfigScalar): ConfigErrorDetail {
  return { key, value };
}

/* ------------------------------------------------------------------ */
/* FND config-write error mapping (DD-CFG-055)                         */
/* ------------------------------------------------------------------ */

type ConfigApplyReason =
  | "expected_field_mismatch"
  | "candidate_mismatch"
  | "protected_subtree_mismatch"
  | "parser_failed"
  | "serializer_failed"
  | "forbidden_field"
  | "unsupported_field"
  | "path_invalid";

const APPLY_REASON_CODES: Readonly<Record<ConfigApplyReason, ConfigErrorCode>> = {
  expected_field_mismatch: "E_CFG_FIELD_CONFLICT",
  candidate_mismatch: "E_CFG_FIELD_CONFLICT",
  protected_subtree_mismatch: "E_CFG_PROTECTED_SUBTREE",
  parser_failed: "E_CFG_PROTECTED_SUBTREE",
  serializer_failed: "E_CFG_PROTECTED_SUBTREE",
  forbidden_field: "E_CFG_FORBIDDEN_FIELD",
  unsupported_field: "E_CFG_FIELD_NOT_EXECUTABLE",
  path_invalid: "E_CFG_FIELD_NOT_EXECUTABLE"
};

function isConfigApplyReason(value: string): value is ConfigApplyReason {
  return value in APPLY_REASON_CODES;
}

/** Maps a FND `details.apply_reason` onto the CFG-side code (DD-CFG-055). */
export function mapApplyReason(reason: string | undefined): ConfigErrorCode {
  if (reason === undefined || !isConfigApplyReason(reason)) {
    return "E_CFG_WRITE_UNCERTAIN";
  }
  return APPLY_REASON_CODES[reason];
}

/**
 * Maps a FND config-write `ErrorEnvelope` onto `ConfigError`.
 *
 * `E_WRITE_CONFIG_IN_PROGRESS` is not a failure: callers keep polling with the
 * same idempotency key (DD-CFG-055), so it maps to `E_CFG_WRITE_UNCERTAIN`
 * only when the deadline expires. Unknown upstream codes map to
 * `E_CFG_WRITE_UNCERTAIN`, never to a zero-write success.
 */
export function mapConfigWriteError(envelope: ErrorEnvelope): ConfigError {
  const details = envelope.details;
  const structured = details.kind === "config_write" ? details : null;
  switch (envelope.code) {
    case "E_WRITE_CONFIG_PATCH":
      return configError("E_CFG_FIELD_CONFLICT", { details: [detail("upstream_code", envelope.code)] });
    case "E_WRITE_CONFIG_FIELD":
      return configError("E_CFG_AUTHORIZATION_SCOPE", { details: [detail("upstream_code", envelope.code)] });
    case "E_WRITE_CONFIG_UNSUPPORTED":
    case "E_WRITE_CONFIG_PATH":
    case "E_WRITE_CONFIG_CONTENT":
      return configError("E_CFG_FIELD_NOT_EXECUTABLE", {
        field_id: structured?.field_id ?? null,
        path: structured?.path ?? null,
        details: [detail("upstream_code", envelope.code)]
      });
    case "E_WRITE_CONFIG_APPLY": {
      const code = mapApplyReason(structured?.apply_reason);
      return configError(code, {
        field_id: structured?.field_id ?? null,
        path: structured?.path ?? null,
        details: [
          detail("upstream_code", envelope.code),
          detail("apply_reason", structured?.apply_reason ?? "missing")
        ]
      });
    }
    case "E_WRITE_CONFIG_READBACK":
    case "E_WRITE_CONFIG_NOT_FOUND":
    case "E_WRITE_CONFIG_IN_PROGRESS":
      return configError("E_CFG_WRITE_UNCERTAIN", { details: [detail("upstream_code", envelope.code)] });
    case "E_WRITE_CONFIG_RECOVERY_REQUIRED":
      return configError("E_CFG_RECOVERY_REQUIRED", { details: [detail("upstream_code", envelope.code)] });
    case "E_WRITE_CONFIG_LOCKED":
      return configError("E_CFG_EXTERNAL_CHANGE", { details: [detail("upstream_code", envelope.code)] });
    case "E_WRITE_CONFIG_STALE":
      return configError("E_CFG_STALE_BASELINE", {
        details: [
          detail("upstream_code", envelope.code),
          detail("stale_reason", structured?.stale_reason ?? "unknown")
        ]
      });
    case "E_WRITE_STATE":
      return configError("E_CFG_WRITE_UNCERTAIN", { details: [detail("upstream_code", envelope.code)] });
    case "E_AUTH_CONFIG_SCOPE":
    case "E_AUTH_DENIED":
      return configError("E_CFG_AUTHORIZATION_SCOPE", { details: [detail("upstream_code", envelope.code)] });
    case "E_IDEMPOTENCY_CONFLICT":
      return configError("E_CFG_IDEMPOTENCY_CONFLICT", { details: [detail("upstream_code", envelope.code)] });
    case "E_DEADLINE_EXCEEDED":
      return configError("E_CFG_DEADLINE_EXCEEDED", { details: [detail("upstream_code", envelope.code)] });
    case "E_CANCELLED":
      return configError("E_CFG_CANCELLED", { details: [detail("upstream_code", envelope.code)] });
    default:
      return configError("E_CFG_WRITE_UNCERTAIN", { details: [detail("upstream_code", envelope.code)] });
  }
}

/* ------------------------------------------------------------------ */
/* Root resolver, capacity and safety-audit mapping                    */
/* ------------------------------------------------------------------ */

/** Fixed `RootResolver` error mapping (DD-CFG-057). */
export function mapRootResolverError(code: string): ConfigErrorCode {
  switch (code) {
    case "E_ROOT_NOT_FOUND":
      return "E_CFG_ROOT_UNRESOLVED";
    case "E_ROOT_UNAVAILABLE":
      return "E_CFG_ROOT_UNAVAILABLE";
    case "E_ROOT_INVALID":
      return "E_CFG_ROOT_INVALID";
    case "E_ROOT_AMBIGUOUS":
      return "E_CFG_ROOT_AMBIGUOUS";
    case "E_ROOT_IDENTITY_MISMATCH":
      return "E_CFG_ROOT_IDENTITY_MISMATCH";
    case "E_DEADLINE_EXCEEDED":
      return "E_CFG_DEADLINE_EXCEEDED";
    case "E_CANCELLED":
      return "E_CFG_CANCELLED";
    default:
      return "E_CFG_ROOT_UNRESOLVED";
  }
}

/** Fixed `CapacityEvidencePort` error mapping (DD-CFG-073). */
export function mapCapacityError(code: string): ConfigErrorCode {
  switch (code) {
    case "E_CAPACITY_BINDING_MISMATCH":
      return "E_CFG_CAPACITY_MISMATCH";
    case "E_CAPACITY_NOT_FOUND":
    case "E_CAPACITY_UNAVAILABLE":
    case "E_CAPACITY_HASH_MISMATCH":
      return "E_CFG_CAPACITY_UNVERIFIED";
    case "E_DEADLINE_EXCEEDED":
      return "E_CFG_DEADLINE_EXCEEDED";
    case "E_CANCELLED":
      return "E_CFG_CANCELLED";
    default:
      return "E_CFG_CAPACITY_UNVERIFIED";
  }
}

/** Any safety-audit port failure is one code (DD-CFG-090.1). */
export function mapSafetyAuditError(code: string): ConfigError {
  return configError("E_CFG_GUARDRAIL_UNKNOWN", { details: [detail("upstream_code", code)] });
}
