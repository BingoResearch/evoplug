/**
 * W10 config IPC handlers.
 *
 * The central method table and its schemas are owned elsewhere. This module
 * fixes the exact request/response shapes so the method-table addition is a
 * mechanical splice: every key here must appear once in `IpcParams`,
 * `IpcResult`, `IPC_METHODS` and `schemas/ipc/methods.json`.
 *
 * The handlers never construct state. They call the real `ConfigSpaceService`
 * and `ConfigTrialService`; when either is absent (the default
 * `config_autotune=false` composition) every method fails closed.
 */

import type {
  ErrorCategory,
  ErrorEnvelope,
  FailureStatus,
  Hash,
  Id,
  Result
} from "@evoplug/core";
import { err, makeErrorEnvelope, ok } from "@evoplug/core";
import type {
  CloseTrial,
  ConfigError,
  ConfigErrorCode,
  ConfigResult,
  ConfigSpaceSelector,
  ConfigSpaceService,
  ConfigSpaceSnapshot,
  ConfigTrial,
  ConfigTrialService,
  CreateTrialPlan,
  EpochMs,
  ExecuteAttempt,
  FieldReadback,
  PromotionEvidence,
  ReconcileReport,
  RecordObservation,
  RequestRollback,
  StartTrial,
  TrialAttempt,
  TrialPlan
} from "@evoplug/core/config";
import { fail } from "@evoplug/core/config";
import type { IpcClientKind } from "@evoplug/ipc";

import type { CompactionPromotionService } from "./config-trial-service.js";

/* ------------------------------------------------------------------ */
/* Closed method surface                                               */
/* ------------------------------------------------------------------ */

export type ConfigIpcMethod =
  | "config.space.capture"
  | "config.space.read_fields"
  | "config.trial.create_plan"
  | "config.trial.start"
  | "config.trial.execute_attempt"
  | "config.trial.record_observation"
  | "config.trial.request_rollback"
  | "config.trial.close"
  | "config.trial.reconcile"
  | "config.promotion.collect";

export type ConfigAttemptRequest = Omit<ExecuteAttempt, "signal">;

export type ConfigPromotionRequest = {
  readonly trial_id: Id<"ctr">;
  readonly field_id: Id<"fld">;
  readonly deadline_ms?: number;
};

export interface ConfigIpcParams {
  "config.space.capture": ConfigSpaceSelector;
  "config.space.read_fields": {
    readonly config_space_id: Hash;
    readonly field_ids: readonly Id<"fld">[];
    readonly layer_id: string;
  };
  "config.trial.create_plan": CreateTrialPlan;
  "config.trial.start": StartTrial;
  "config.trial.execute_attempt": ConfigAttemptRequest;
  "config.trial.record_observation": RecordObservation;
  "config.trial.request_rollback": RequestRollback;
  "config.trial.close": CloseTrial;
  "config.trial.reconcile": Record<string, never>;
  "config.promotion.collect": ConfigPromotionRequest;
}

export interface ConfigIpcResult {
  "config.space.capture": ConfigSpaceSnapshot;
  "config.space.read_fields": readonly FieldReadback[];
  "config.trial.create_plan": TrialPlan;
  "config.trial.start": ConfigTrial;
  "config.trial.execute_attempt": TrialAttempt;
  "config.trial.record_observation": ConfigTrial;
  "config.trial.request_rollback": ConfigTrial;
  "config.trial.close": ConfigTrial;
  "config.trial.reconcile": ReconcileReport;
  "config.promotion.collect": PromotionEvidence;
}

/** Mirrors `IpcHandlerContext` once the methods join the central union. */
export interface ConfigIpcHandlerContext<M extends ConfigIpcMethod> {
  readonly request_id: Id<"ipc">;
  readonly method: M;
  readonly params: ConfigIpcParams[M];
  readonly client_id: Id<"adp">;
  readonly client_kind?: IpcClientKind;
  readonly connection_id: string;
  readonly deadline_ms: number;
  readonly signal: AbortSignal;
}

export type ConfigIpcHandler<M extends ConfigIpcMethod> = (
  context: ConfigIpcHandlerContext<M>
) => Promise<Result<ConfigIpcResult[M], ErrorEnvelope>>;

export type ConfigIpcHandlers = {
  readonly [M in ConfigIpcMethod]: ConfigIpcHandler<M>;
};

export const CONFIG_IPC_METHODS: readonly ConfigIpcMethod[] = Object.freeze([
  "config.space.capture",
  "config.space.read_fields",
  "config.trial.create_plan",
  "config.trial.start",
  "config.trial.execute_attempt",
  "config.trial.record_observation",
  "config.trial.request_rollback",
  "config.trial.close",
  "config.trial.reconcile",
  "config.promotion.collect"
] satisfies readonly ConfigIpcMethod[]);

/* ------------------------------------------------------------------ */
/* ConfigError -> ErrorEnvelope                                        */
/* ------------------------------------------------------------------ */

/** Registry categories for the closed CFG code set (schemas/errors/fragments/cfg.json). */
const CONFIG_ERROR_CATEGORY: Readonly<Record<ConfigErrorCode, ErrorCategory>> = Object.freeze({
  E_CFG_ACTIVE_TRIAL: "conflict",
  E_CFG_APPLY_UNCONFIRMED: "schema",
  E_CFG_AUTHORIZATION_MISSING: "authorization",
  E_CFG_AUTHORIZATION_SCOPE: "authorization",
  E_CFG_BUDGET_EXHAUSTED: "budget",
  E_CFG_CANCELLED: "deadline",
  E_CFG_CAPABILITY_UNVERIFIED: "version",
  E_CFG_CAPACITY_MISMATCH: "conflict",
  E_CFG_CAPACITY_UNVERIFIED: "source",
  E_CFG_COUPLING_INCOMPLETE: "schema",
  E_CFG_DEADLINE_EXCEEDED: "deadline",
  E_CFG_DEFAULT_UNKNOWN: "not_found",
  E_CFG_EXTERNAL_CHANGE: "conflict",
  E_CFG_FIELD_CLAIMED: "conflict",
  E_CFG_FIELD_CONFLICT: "conflict",
  E_CFG_FIELD_NOT_EXECUTABLE: "usage",
  E_CFG_FIELD_RANGE: "schema",
  E_CFG_FIELD_TYPE: "schema",
  E_CFG_FIELD_UNIT: "schema",
  E_CFG_FIELD_UNKNOWN: "not_found",
  E_CFG_FORBIDDEN_FIELD: "authorization",
  E_CFG_FORMULA_HASH: "schema",
  E_CFG_GUARDRAIL_BREACH: "schema",
  E_CFG_GUARDRAIL_SPEC: "schema",
  E_CFG_GUARDRAIL_UNKNOWN: "schema",
  E_CFG_HOST_VERSION_UNBOUND: "version",
  E_CFG_IDEMPOTENCY_CONFLICT: "conflict",
  E_CFG_ILLEGAL_TRANSITION: "conflict",
  E_CFG_LEGACY_UNVERIFIED: "source",
  E_CFG_MODEL_UNBOUND: "version",
  E_CFG_MODE_UNBOUND: "version",
  E_CFG_MULTI_FILE_FACTOR: "conflict",
  E_CFG_NORMALIZATION_INPUT: "schema",
  E_CFG_NORMALIZATION_MISMATCH: "schema",
  E_CFG_NORMALIZATION_MISSING: "schema",
  E_CFG_NORMALIZATION_SHADOWED: "schema",
  E_CFG_NORMALIZATION_UNVERIFIED: "schema",
  E_CFG_OBSERVATION_HASH: "conflict",
  E_CFG_PLAN_NOT_FOUND: "not_found",
  E_CFG_PROTECTED_SUBTREE: "schema",
  E_CFG_READBACK_TIMEOUT: "storage",
  E_CFG_RECOVERY_REQUIRED: "storage",
  E_CFG_REGISTRY_AMBIGUOUS: "conflict",
  E_CFG_ROLLBACK_CONFLICT: "conflict",
  E_CFG_ROLLBACK_UNCERTAIN: "storage",
  E_CFG_ROOT_AMBIGUOUS: "conflict",
  E_CFG_ROOT_IDENTITY_MISMATCH: "conflict",
  E_CFG_ROOT_INVALID: "schema",
  E_CFG_ROOT_UNAVAILABLE: "schema",
  E_CFG_ROOT_UNRESOLVED: "schema",
  E_CFG_SNAPSHOT_HASH: "conflict",
  E_CFG_STALE_BASELINE: "conflict",
  E_CFG_TRIAL_NOT_FOUND: "not_found",
  E_CFG_TRIAL_TERMINAL: "schema",
  E_CFG_WRITE_FAILED: "internal",
  E_CFG_WRITE_PORT_UNSUPPORTED: "usage",
  E_CFG_WRITE_UNCERTAIN: "storage"
});

/** CFG registry stages are `cfg_<lowercased code suffix>`. */
export function configErrorStage(code: ConfigErrorCode): string {
  return `cfg_${code.slice("E_CFG_".length).toLowerCase()}`;
}

/**
 * CFG registry entries declare `details_kind=none`. Structured detail pairs
 * stay on the domain `ConfigError`; the IPC envelope carries the canonical
 * code, stage, category and retryability only.
 */
export function configErrorEnvelope(error: ConfigError): ErrorEnvelope {
  return makeErrorEnvelope({
    code: error.code,
    category: CONFIG_ERROR_CATEGORY[error.code] ?? "schema",
    message_key: error.message_key,
    stage: configErrorStage(error.code),
    details: { kind: "none" },
    retryable: error.retryable,
    side_effect: "none"
  });
}

function failureStatus(error: ConfigError): FailureStatus {
  switch (CONFIG_ERROR_CATEGORY[error.code] ?? "schema") {
    case "conflict":
      return "conflict";
    case "deadline":
    case "storage":
      return "degraded";
    case "internal":
      return "unknown";
    default:
      return "rejected";
  }
}

function toIpc<T>(result: ConfigResult<T>): Result<T, ErrorEnvelope> {
  if (result.ok) {
    return ok(result.value);
  }
  return err(configErrorEnvelope(result.error), failureStatus(result.error));
}

function disabledEnvelope(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CFG_FIELD_NOT_EXECUTABLE",
    category: "usage",
    message_key: "cfg.field_not_executable",
    stage: "cfg_field_not_executable",
    details: { kind: "none" }
  });
}

/* ------------------------------------------------------------------ */
/* Handler composition                                                 */
/* ------------------------------------------------------------------ */

export interface ConfigHandlerDeps {
  /** The `config_autotune` flag. `false` is the default composition. */
  readonly enabled: boolean;
  /**
   * Why composition could not be built while the feature is enabled. Every
   * method fails with this named error instead of the generic disabled code.
   */
  readonly blocked_error?: ConfigError;
  readonly space?: ConfigSpaceService;
  readonly trial?: ConfigTrialService;
  readonly promotion?: CompactionPromotionService;
  readonly now: () => EpochMs;
}

async function disabledResult<M extends ConfigIpcMethod>(
  blocked_error: ConfigError | undefined
): Promise<Result<ConfigIpcResult[M], ErrorEnvelope>> {
  if (blocked_error !== undefined) {
    return toIpc(fail(blocked_error));
  }
  return err(disabledEnvelope(), "rejected");
}

/**
 * Builds the ten handlers. All-or-nothing: a missing service fails every
 * method of that area instead of silently degrading to a no-op success.
 */
export function createConfigHandlers(deps: ConfigHandlerDeps): ConfigIpcHandlers {
  const space = deps.space;
  const trial = deps.trial;
  const promotion = deps.promotion;
  // `config_autotune=false` keeps the generic disabled code; a named error is
  // only surfaced when the feature is enabled but composition was blocked.
  const blocked = deps.enabled ? deps.blocked_error : undefined;

  return {
    "config.space.capture": async (context) => {
      if (!deps.enabled || space === undefined) {
        return disabledResult<"config.space.capture">(blocked);
      }
      return toIpc(await space.capture(context.params));
    },
    "config.space.read_fields": async (context) => {
      if (!deps.enabled || space === undefined) {
        return disabledResult<"config.space.read_fields">(blocked);
      }
      return toIpc(await space.readFields(context.params));
    },
    "config.trial.create_plan": async (context) => {
      if (!deps.enabled || trial === undefined) {
        return disabledResult<"config.trial.create_plan">(blocked);
      }
      return toIpc(await trial.createPlan(context.params));
    },
    "config.trial.start": async (context) => {
      if (!deps.enabled || trial === undefined) {
        return disabledResult<"config.trial.start">(blocked);
      }
      return toIpc(await trial.startTrial(context.params));
    },
    "config.trial.execute_attempt": async (context) => {
      if (!deps.enabled || trial === undefined) {
        return disabledResult<"config.trial.execute_attempt">(blocked);
      }
      const input: ExecuteAttempt = { ...context.params, signal: context.signal };
      return toIpc(await trial.executeAttempt(input));
    },
    "config.trial.record_observation": async (context) => {
      if (!deps.enabled || trial === undefined) {
        return disabledResult<"config.trial.record_observation">(blocked);
      }
      return toIpc(await trial.recordObservation(context.params));
    },
    "config.trial.request_rollback": async (context) => {
      if (!deps.enabled || trial === undefined) {
        return disabledResult<"config.trial.request_rollback">(blocked);
      }
      return toIpc(await trial.requestRollback(context.params));
    },
    "config.trial.close": async (context) => {
      if (!deps.enabled || trial === undefined) {
        return disabledResult<"config.trial.close">(blocked);
      }
      return toIpc(await trial.closeTrial(context.params));
    },
    "config.trial.reconcile": async (context) => {
      if (!deps.enabled || trial === undefined) {
        return disabledResult<"config.trial.reconcile">(blocked);
      }
      return toIpc(await trial.reconcile(deps.now()));
    },
    "config.promotion.collect": async (context) => {
      if (!deps.enabled || promotion === undefined) {
        return disabledResult<"config.promotion.collect">(blocked);
      }
      const params = context.params;
      const input = {
        trial_id: params.trial_id,
        field_id: params.field_id,
        ...(params.deadline_ms === undefined ? {} : { deadline_ms: params.deadline_ms })
      };
      return toIpc(await promotion.collect(input));
    }
  };
}
