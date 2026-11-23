import type { Hash, Id } from "@evoplug/core";

export type IdentityState = "resolved" | "not_found" | "ambiguous" | "stale";

export interface BranchCandidate {
  readonly branch_id: Id<"br">;
  readonly task_id: Id<"task">;
  readonly watermark: number;
}

export interface IdentityResolution {
  readonly state: IdentityState;
  readonly session_id?: Id<"sess">;
  readonly task_id?: Id<"task">;
  readonly branch_id?: Id<"br">;
  readonly input_id?: Id<"input">;
  readonly input_epoch?: number;
  readonly goal_version?: string;
  readonly watermark?: number;
  readonly candidates?: BranchCandidate[];
  readonly reason_code: "native_not_mapped" | "multiple_branches" | "host_conflict" | "none";
}

export interface BranchForkResult {
  readonly branch_id: Id<"br">;
  readonly parent_branch_id: Id<"br">;
  readonly forked_from_watermark: number;
  readonly goal_snapshot_id: Id<"gsnap">;
  readonly task_id: Id<"task">;
  readonly goal_version: string;
  readonly input_epoch: number;
  readonly created: boolean;
}

export interface ResumeResult {
  readonly session_id: Id<"sess">;
  readonly branch_id: Id<"br">;
  readonly resume_generation: number;
  readonly observed_watermark: number;
  readonly current_watermark: number;
  readonly status: "resumed" | "stale" | "recovery_required";
  readonly missing_ranges: Array<{ readonly from: number; readonly to: number }>;
  readonly replayed_events: number;
}

/** Input to the pure identity resolver; all fields come from committed rows. */
export interface IdentityResolveInput {
  readonly host_id: string;
  readonly config_space: string;
  readonly native_session_id: string;
  /** Mappings registered for this native session key. */
  readonly mappings: readonly NativeSessionMapping[];
  /** Watermark of the session's current branch, when the session row exists. */
  readonly current_branch_watermark?: number;
  /** True when the host reported a session that conflicts with the mapping. */
  readonly host_conflict?: boolean;
}

export interface NativeSessionMapping {
  readonly session_id: Id<"sess">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly watermark: number;
  readonly input_id: Id<"input"> | null;
  readonly input_epoch: number;
  readonly goal_version: string;
}

export interface ForkRequest {
  readonly source_branch_id: Id<"br">;
  readonly at_watermark: number;
  readonly reason: "explicit_request";
  readonly idempotency_key: Hash;
}

export interface ForkSourceBranch {
  readonly branch_id: Id<"br">;
  readonly task_id: Id<"task">;
  readonly current_watermark: number;
  readonly current_goal_version: string;
  readonly current_goal_revision: number;
}

export interface ForkIdempotencyRecord {
  readonly source_branch_id: Id<"br">;
  readonly at_watermark: number;
  readonly reason: "explicit_request";
  readonly idempotency_key: Hash;
  readonly branch_id: Id<"br">;
  readonly goal_snapshot_id: Id<"gsnap">;
  readonly task_id: Id<"task">;
  readonly goal_version: string;
  readonly input_epoch: number;
}

export interface ResumeObservation {
  readonly session_id: Id<"sess">;
  readonly branch_id: Id<"br">;
  readonly resume_generation: number;
  readonly observed_watermark: number;
  readonly current_watermark: number;
  /** Contiguous committed ranges still available for replay. */
  readonly committed_ranges: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}
