/**
 * `system.describe`, `status.get` and `maintenance.gc` assembly (DD-FND-103).
 *
 * The kernel owns the envelopes and the `ipc` status axis; the storage, budget,
 * outbox, config and capability axes come from the read ports. No secret, user
 * name or provider token is ever placed in a description.
 */

import { type CapabilityName, type CapabilityStatus, type EvidenceStage, type Hash, type HostId, type OverloadPolicy, type SystemDescription, type SystemStatus, isRecord } from "@evoplug/core";
import type { ErrorEnvelope, Result } from "@evoplug/core";
import {
  DEFAULT_INGRESS_POLICY,
  overloadPolicyHash
} from "@evoplug/core";
import { fieldError } from "./errors.js";
import type { FeatureFlag } from "./features.js";

export { FEATURE_FLAGS, type FeatureFlag } from "./features.js";

const SYSTEM_DESCRIPTION_SCHEMA_VERSION: "rsi.system_description/1" = "rsi.system_description/1";
const SYSTEM_STATUS_SCHEMA_VERSION: "rsi.system_status/1" = "rsi.system_status/1";
const SYSTEM_PROTOCOL_VERSION = 1;
export const JOURNAL_FRAME_VERSION = 1;

export interface RuntimeFacts {
  readonly product_version: string;
  readonly protocol_version?: number;
  readonly schema_major: number;
  readonly schema_minor: number;
  readonly journal_frame_version?: number;
  readonly node_version: string;
  readonly sqlite_version: string;
  readonly sqlite_safe: boolean;
  readonly read_only: boolean;
  readonly feature_flags: readonly FeatureFlag[];
  /** The frozen overload policy reported by `system.describe`. */
  readonly overload_policy?: OverloadPolicy;
}

/**
 * Builds the `system.describe` payload. Field order matches the schema.
 *
 * `policy_version` and `policy_hash` report the frozen ingress overload
 * policy; `policy_hash = sha256(JCS(policy))` over the complete policy
 * object, so an independent party can recompute it from the same fields.
 */
export function buildSystemDescription(facts: RuntimeFacts): SystemDescription {
  const policy = facts.overload_policy ?? DEFAULT_INGRESS_POLICY;
  return {
    schema_version: SYSTEM_DESCRIPTION_SCHEMA_VERSION,
    protocol_version: facts.protocol_version ?? SYSTEM_PROTOCOL_VERSION,
    product_version: facts.product_version,
    schema_major: facts.schema_major,
    schema_minor: facts.schema_minor,
    journal_frame_version: facts.journal_frame_version ?? JOURNAL_FRAME_VERSION,
    runtime: {
      name: "node",
      version: facts.node_version,
      sqlite_version: facts.sqlite_version,
      sqlite_safe: facts.sqlite_safe
    },
    read_only: facts.read_only,
    feature_flags: facts.feature_flags,
    policy_version: policy.policy_version,
    policy_hash: overloadPolicyHash(policy)
  };
}

export type StatusAxis = "storage" | "ipc" | "budget" | "outbox" | "config" | "capabilities" | "recovery";

export const STATUS_AXES: readonly StatusAxis[] = [
  "storage",
  "ipc",
  "budget",
  "outbox",
  "config",
  "capabilities",
  "recovery"
];

export interface StorageStatusAxis {
  readonly journal_tail_state: "clean" | "corrupt_tail" | "corrupt_middle";
  readonly trusted_prefix_end: number;
  readonly quarantine_count: number;
  readonly db_quick_check: "ok" | "failed" | "not_run";
  /**
   * Appendix Q (journal fence): `recovery_required` means the running kernel
   * or the on-disk marker refused further journal writes after a projection
   * failure. Restarting serve runs recovery and clears it.
   */
  readonly journal: "ok" | "recovery_required";
  readonly journal_fence?: {
    readonly frame_type: string;
    readonly observed_at: number;
    readonly hint: "restart serve";
  };
}

export interface BudgetStatusAxis {
  readonly active_reservations: number;
  readonly unsettled_reservations: number;
  readonly cooldown_scopes: number;
}

export interface OutboxStatusAxis {
  readonly pending: number;
  readonly leased: number;
  readonly uncertain: number;
  readonly failed: number;
}

/**
 * Appendix P: progress of the post-endpoint background recovery. `pending`
 * and `terminal_failed` are durable, the remaining counters are progress
 * inside the current process.
 */
export interface RecoveryStatusAxis {
  readonly state: "idle" | "running" | "waiting" | "stopped";
  readonly pending: number;
  readonly terminal_failed: number;
  readonly processed: number;
  readonly failed: number;
  readonly last_run: {
    readonly started_at: number;
    readonly finished_at: number;
    readonly scanned: number;
    readonly recorded: number;
    readonly skipped: number;
    readonly failed: number;
    readonly terminal_failed: number;
    readonly remaining: number;
    readonly stopped_reason: "complete" | "item_limit" | "wall_limit";
  } | null;
}

/** Reported when the composition has no background recovery worker. */
export const IDLE_RECOVERY_STATUS: RecoveryStatusAxis = Object.freeze({
  state: "idle",
  pending: 0,
  terminal_failed: 0,
  processed: 0,
  failed: 0,
  last_run: null
});

export interface ConfigStatusAxis {
  readonly config_version: string;
  readonly config_hash: Hash;
  readonly egress_policy_version: string;
  /**
   * Appendix D: the effective standing egress policy, including its receiver.
   * Optional because an older home or a read-only fallback may have none.
   */
  readonly egress_policies?: readonly {
    readonly policy_version: string;
    readonly policy_hash: Hash;
    readonly receiver: {
      readonly kind: "host_cli";
      readonly host_id: string;
      readonly provider_host: string;
      readonly provider_model: string | null;
    } | null;
    readonly data_classes: readonly string[];
  }[];
}

export interface CapabilityStatusAxis {
  readonly host_id: HostId;
  /**
   * The capability the entry describes. Without it the axis could only say
   * "some capability of this host is unknown", and the confirmation state
   * (`human_interaction_attested`) would be indistinguishable from the rest.
   */
  readonly capability: CapabilityName;
  readonly status: CapabilityStatus;
  readonly evidence_stage: EvidenceStage;
  /** Failed generation rows carry the actionable class and provider detail. */
  readonly failure_code?: string;
  readonly failure?: {
    readonly code:
      | "auth_rejected"
      | "provider_rejected"
      | "process_exit_nonzero"
      | "output_unparseable"
      | "protocol_mismatch";
    readonly detail: string;
    readonly provider_status?: number;
    readonly provider_code?: string;
    readonly exit_code?: number;
  };
  /** One next-step sentence rendered beside the failed row. */
  readonly next_step?: string;
}

/** All axes except `ipc`, which the kernel reads from the live server. */
export interface SystemStatusAxes {
  readonly status: SystemStatus["status"];
  readonly recovery_state: SystemStatus["recovery_state"];
  readonly storage: StorageStatusAxis;
  readonly budget: BudgetStatusAxis;
  readonly outbox: OutboxStatusAxis;
  /**
   * Appendix P background recovery progress. Optional so injected service
   * maps and older callers need no synthetic value; the built status object
   * always carries an axis.
   */
  readonly recovery?: RecoveryStatusAxis;
  readonly config: ConfigStatusAxis;
  readonly capabilities: readonly CapabilityStatusAxis[];
  /**
   * Resolved feature-flag set. Present so `evolve status` shows whether
   * temporarily unavailable subsystems (for example `semantic_judge`) are off.
   */
  readonly feature_flags?: readonly string[];
  /** Q.6.3: candidates waiting for a native confirmation. */
  readonly pending_candidates?: number;
}

/** `include` must be non-empty, duplicate-free and drawn from the closed set. */
export function validateStatusInclude(value: unknown): Result<readonly StatusAxis[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return { ok: false, status: "rejected", error: fieldError("include", "must_be_array") };
  }
  if (value.length === 0) {
    return { ok: false, status: "rejected", error: fieldError("include", "must_be_non_empty") };
  }
  const out: StatusAxis[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== "string" || !STATUS_AXES.includes(item as StatusAxis)) {
      return {
        ok: false,
        status: "rejected",
        error: fieldError(`include[${String(index)}]`, "unknown_axis")
      };
    }
    if (out.includes(item as StatusAxis)) {
      return {
        ok: false,
        status: "rejected",
        error: fieldError(`include[${String(index)}]`, "duplicate")
      };
    }
    out.push(item as StatusAxis);
  }
  return { ok: true, status: "ok", value: out };
}

interface IpcStatusAxis {
  /** Only the fixed 0600/0600/0700 contract is representable. */
  readonly mode_verified: boolean;
  readonly active_connections: number;
}

interface BuildSystemStatusInput {
  readonly axes: SystemStatusAxes;
  readonly ipc: IpcStatusAxis;
}

/**
 * Assembles `SystemStatus`. All structural axes are present; the `ipc` axis is
 * the live server view. `mode_verified=false` downgrades the status to
 * `degraded_read_only` rather than reporting an unverified permission state as
 * ready.
 */
export function buildSystemStatus(input: BuildSystemStatusInput): SystemStatus {
  const status: SystemStatus["status"] =
    !input.ipc.mode_verified && input.axes.status === "ready" ? "degraded_read_only" : input.axes.status;
  return {
    schema_version: SYSTEM_STATUS_SCHEMA_VERSION,
    status,
    recovery_state: input.axes.recovery_state,
    storage: input.axes.storage,
    ipc: {
      socket_mode: "0600",
      token_mode: "0600",
      home_mode: "0700",
      active_connections: input.ipc.active_connections
    },
    budget: input.axes.budget,
    outbox: input.axes.outbox,
    recovery: input.axes.recovery ?? IDLE_RECOVERY_STATUS,
    config: input.axes.config,
    capabilities: input.axes.capabilities,
    ...(input.axes.feature_flags === undefined
      ? {}
      : {
          feature_flags: [...input.axes.feature_flags] as NonNullable<
            SystemStatus["feature_flags"]
          >
        }),
    ...(input.axes.pending_candidates === undefined
      ? {}
      : { pending_candidates: input.axes.pending_candidates })
  };
}

export interface GcParams {
  readonly mode: "dry_run" | "apply";
  readonly retention_days?: number;
}

const GC_MIN_RETENTION_DAYS = 0;
const GC_MAX_RETENTION_DAYS = 36_500;

/** `maintenance.gc` parameter gate; the default mode is `dry_run`. */
export function validateGcParams(value: unknown): Result<GcParams, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError("$", "must_be_object") };
  }
  const record = value;
  const mode = record["mode"];
  if (mode !== "dry_run" && mode !== "apply") {
    return { ok: false, status: "rejected", error: fieldError("mode", "unknown_enum") };
  }
  const retention = record["retention_days"];
  if (retention === undefined) {
    return { ok: true, status: "ok", value: { mode } };
  }
  if (
    typeof retention !== "number" ||
    !Number.isSafeInteger(retention) ||
    retention < GC_MIN_RETENTION_DAYS ||
    retention > GC_MAX_RETENTION_DAYS
  ) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError("retention_days", "integer_0_36500")
    };
  }
  return { ok: true, status: "ok", value: { mode, retention_days: retention } };
}

