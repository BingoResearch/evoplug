/**
 * Overload policy, admission and resource-statistics contracts
 * (DD-FND-103, TST LOAD §2.3).
 *
 * These are the only typed contracts for capacity control. A producer asks
 * the frozen policy whether a subject may enter the queue; the answer is an
 * `AdmissionDecision` with exactly three mutually exclusive shapes
 * (admitted / rejected+E_OVERLOAD / rejected+E_DEADLINE_EXCEEDED). The
 * resource-statistics port is a read-only observation surface and never
 * mutates the queue, the journal, SQLite, the outbox or the budget.
 */

import type { ErrorEnvelope } from "../errors.js";
import type { Id } from "../ids.js";
import type { Result } from "../result.js";

export const OVERLOAD_POLICY_SCHEMA_VERSION: "rsi.overload_policy/1" = "rsi.overload_policy/1";

export const ADMISSION_REQUEST_SCHEMA_VERSION: "rsi.admission_request/1" = "rsi.admission_request/1";

export const ADMISSION_DECISION_SCHEMA_VERSION: "rsi.admission_decision/1" = "rsi.admission_decision/1";

export const RESOURCE_STATS_REQUEST_SCHEMA_VERSION: "rsi.resource_stats_request/1" =
  "rsi.resource_stats_request/1";

export const RESOURCE_STATS_SNAPSHOT_SCHEMA_VERSION: "rsi.resource_stats_snapshot/1" =
  "rsi.resource_stats_snapshot/1";

/** Scope of the frozen policy: event ingress or delivery. */
type OverloadPolicyScope = "ingress" | "delivery";

/** What happens when `depth + inflight` reaches `queue_capacity`. */
type OverloadOverflow = "reject" | "block";

/**
 * The frozen capacity policy. `queue_capacity` is the total outstanding
 * limit (`depth + inflight`); `max_inflight` only limits how many subjects
 * may be processed at the same time.
 */
export interface OverloadPolicy {
  schema_version: "rsi.overload_policy/1";
  policy_version: string;
  scope: OverloadPolicyScope;
  queue_capacity: number;
  max_inflight: number;
  overflow: OverloadOverflow;
  retry_after_ms: number;
  admission_deadline_ms: number;
}

/** The subject an admission request refers to. */
export type AdmissionSubject =
  | { kind: "event"; event_id: Id<"ev"> }
  | { kind: "delivery"; delivery_id: Id<"del"> };

export interface AdmissionRequest {
  schema_version: "rsi.admission_request/1";
  subject: AdmissionSubject;
  policy_version: string;
  /** Monotonic ms; the moment the request first entered admission. */
  enqueued_at_mono_ms: number;
  /** Monotonic ms; absolute deadline, may be earlier than now. */
  deadline_mono_ms: number;
}

/**
 * The three mutually exclusive decision shapes. `admitted` carries a null
 * code and a null retry hint; the capacity rejection carries `E_OVERLOAD`
 * and a positive retry hint; the deadline rejection carries
 * `E_DEADLINE_EXCEEDED` and a null retry hint. No other combination exists.
 */
export interface AdmissionDecision {
  schema_version: "rsi.admission_decision/1";
  subject: AdmissionSubject;
  outcome: "admitted" | "rejected";
  code: "E_OVERLOAD" | "E_DEADLINE_EXCEEDED" | null;
  retry_after_ms: number | null;
  policy_version: string;
  queue_depth: number;
  queue_capacity: number;
  inflight: number;
  max_inflight: number;
  decided_at_mono_ms: number;
}

/** The four observable axes of a resource-statistics snapshot. */
type ResourceStatsAxis = "queue" | "process" | "storage" | "io";

export interface ResourceStatsRequest {
  schema_version: "rsi.resource_stats_request/1";
  include: ResourceStatsAxis[];
  timeout_ms: number;
}

export interface QueueStats {
  depth: number;
  capacity: number;
  inflight: number;
  max_inflight: number;
  overflow: OverloadOverflow;
  admitted_total: number;
  rejected_total: number;
  deadline_rejected_total: number;
  completed_total: number;
  failed_total: number;
  timed_out_total: number;
}

export interface ProcessStats {
  rss_bytes: number;
  fd_count: number;
  child_process_count: number;
  thread_count: number | null;
  cpu_user_ms: number;
  cpu_system_ms: number;
}

export interface StorageStats {
  journal_bytes: number;
  sqlite_wal_bytes: number;
  blob_bytes: number;
  blob_count: number;
  quarantine_count: number;
}

export interface IoStats {
  read_bytes: number;
  write_bytes: number;
  fsync_count: number;
}

/**
 * A read-only observation. Every axis that was not requested reads back as
 * `null` — never as `0` and never as an empty object.
 */
export interface ResourceStatsSnapshot {
  schema_version: "rsi.resource_stats_snapshot/1";
  process_instance_id: string;
  sample_seq: number;
  sampled_at_mono_ms: number;
  policy_version: string;
  queue: QueueStats | null;
  process: ProcessStats | null;
  storage: StorageStats | null;
  io: IoStats | null;
}

export interface AdmissionPort {
  admit(input: AdmissionRequest): Promise<Result<AdmissionDecision, ErrorEnvelope>>;
}

export interface ResourceStatsPort {
  read(input: ResourceStatsRequest): Promise<Result<ResourceStatsSnapshot, ErrorEnvelope>>;
}
