/**
 * Session-end review state (appendix Q.2, 2026-11-20 revision).
 *
 * A completed turn is still a stable boundary, but it never enqueues a review.
 * The online runner records the boundary facts, the frozen trigger and the
 * version binding here. When the host reports the session end, or the runtime
 * lease of the host process expires, the kernel re-evaluates the signals that
 * arrived after the previous review watermark and admits at most one review at
 * the recorded stable boundary. An unfinished turn therefore never enters the
 * snapshot.
 */

import { canonicalJsonText, makeErrorEnvelope, toJsonValue, type ErrorEnvelope, type Result } from "@evoplug/core";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

export interface SessionReviewState {
  readonly session_id: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly native_session_id: string | null;
  readonly host_id: string;
  readonly config_space: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly stable_watermark: number;
  readonly last_stable_at: number;
  readonly facts_json: string;
  readonly trigger_json: string;
  readonly binding_json: string;
  readonly policy_json: string;
  readonly last_review_watermark: number;
  readonly last_review_job_id: string | null;
  readonly last_flushed_at: number | null;
  readonly last_flush_reason: "session_end" | "lease_expired" | null;
  readonly last_flush_job_id: string | null;
  readonly updated_at: number;
}

export interface RecordStableBoundaryInput {
  readonly session_id: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly native_session_id: string | null;
  readonly host_id: string;
  readonly config_space: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly stable_watermark: number;
  readonly now: number;
  /** Frozen `HostTriggerFacts` snapshot used by the session-end flush. */
  readonly facts: unknown;
  /** Frozen `TriggerEvent` with a non-enqueue decision. */
  readonly trigger: unknown;
  /** Frozen `VersionBinding` of the boundary. */
  readonly binding: unknown;
  /** Frozen `rsi.trigger_policy/1` snapshot. */
  readonly policy: unknown;
}

function stringOf(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function numberOf(row: SqlRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Inserts or replaces the boundary row for one internal session. */
export function recordStableBoundary(
  connection: SqliteConnection,
  input: RecordStableBoundaryInput
): Result<void, ErrorEnvelope> {
  try {
    // An upgraded home already has review jobs but no state row. Seed the
    // watermark from the newest auto job so its already-reviewed signals do
    // not mint a duplicate session-end review.
    const existing = connection
      .prepare<SqlRow>("SELECT last_review_watermark AS wm FROM session_review_state WHERE session_id = :id")
      .get({ id: input.session_id });
    const initialWatermark = existing === undefined
      ? lastReviewWatermark(connection, input.task_id)
      : (typeof existing["wm"] === "number" ? existing["wm"] : 0);
    connection
      .prepare(
        `INSERT INTO session_review_state (
           session_id, task_id, branch_id, native_session_id, host_id, config_space,
           input_epoch, goal_version, config_version, stable_watermark, last_stable_at,
           facts_json, trigger_json, binding_json, policy_json, last_review_watermark, updated_at
         ) VALUES (
           :session_id, :task_id, :branch_id, :native_session_id, :host_id, :config_space,
           :input_epoch, :goal_version, :config_version, :stable_watermark, :last_stable_at,
           :facts_json, :trigger_json, :binding_json, :policy_json, :last_review_watermark, :updated_at
         )
         ON CONFLICT(session_id) DO UPDATE SET
           task_id = excluded.task_id,
           branch_id = excluded.branch_id,
           native_session_id = excluded.native_session_id,
           host_id = excluded.host_id,
           config_space = excluded.config_space,
           input_epoch = excluded.input_epoch,
           goal_version = excluded.goal_version,
           config_version = excluded.config_version,
           stable_watermark = excluded.stable_watermark,
           last_stable_at = excluded.last_stable_at,
           facts_json = excluded.facts_json,
           trigger_json = excluded.trigger_json,
           binding_json = excluded.binding_json,
           policy_json = excluded.policy_json,
           updated_at = excluded.updated_at`
      )
      .run({
        session_id: input.session_id,
        task_id: input.task_id,
        branch_id: input.branch_id,
        native_session_id: input.native_session_id,
        host_id: input.host_id,
        config_space: input.config_space,
        input_epoch: input.input_epoch,
        goal_version: input.goal_version,
        config_version: input.config_version,
        stable_watermark: input.stable_watermark,
        last_stable_at: input.now,
        facts_json: canonicalJsonText(toJsonValue(input.facts as never)),
        trigger_json: canonicalJsonText(toJsonValue(input.trigger as never)),
        binding_json: canonicalJsonText(toJsonValue(input.binding as never)),
        policy_json: canonicalJsonText(toJsonValue(input.policy as never)),
        last_review_watermark: initialWatermark,
        updated_at: input.now
      });
    return { ok: true, status: "ok", value: undefined };
  } catch {
    return {
      ok: false,
      status: "rejected",
      error: makeInternal("kernel.session_review_state_write_failed")
    };
  }
}

export function readSessionReviewState(
  connection: SqliteConnection,
  sessionId: string
): SessionReviewState | null {
  const row = connection
    .prepare<SqlRow>("SELECT * FROM session_review_state WHERE session_id = :id")
    .get({ id: sessionId });
  return row === undefined ? null : stateFromRow(row);
}

export function readSessionReviewStateByTask(
  connection: SqliteConnection,
  taskId: string
): SessionReviewState | null {
  const row = connection
    .prepare<SqlRow>(
      "SELECT * FROM session_review_state WHERE task_id = :task ORDER BY last_stable_at DESC, session_id DESC LIMIT 1"
    )
    .get({ task: taskId });
  return row === undefined ? null : stateFromRow(row);
}

function stateFromRow(row: SqlRow): SessionReviewState | null {
  const strings = [
    "session_id",
    "task_id",
    "branch_id",
    "host_id",
    "config_space",
    "goal_version",
    "config_version",
    "facts_json",
    "trigger_json",
    "binding_json",
    "policy_json"
  ] as const;
  const values: Record<string, string> = {};
  for (const key of strings) {
    const value = stringOf(row, key);
    if (value === null) return null;
    values[key] = value;
  }
  const epoch = numberOf(row, "input_epoch");
  const watermark = numberOf(row, "stable_watermark");
  const stableAt = numberOf(row, "last_stable_at");
  const updatedAt = numberOf(row, "updated_at");
  if (epoch === null || watermark === null || stableAt === null || updatedAt === null) {
    return null;
  }
  const reason = stringOf(row, "last_flush_reason");
  return {
    session_id: values["session_id"] as string,
    task_id: values["task_id"] as string,
    branch_id: values["branch_id"] as string,
    native_session_id: stringOf(row, "native_session_id"),
    host_id: values["host_id"] as string,
    config_space: values["config_space"] as string,
    input_epoch: epoch,
    goal_version: values["goal_version"] as string,
    config_version: values["config_version"] as string,
    stable_watermark: watermark,
    last_stable_at: stableAt,
    facts_json: values["facts_json"] as string,
    trigger_json: values["trigger_json"] as string,
    binding_json: values["binding_json"] as string,
    policy_json: values["policy_json"] as string,
    last_review_watermark: numberOf(row, "last_review_watermark") ?? 0,
    last_review_job_id: stringOf(row, "last_review_job_id"),
    last_flushed_at: numberOf(row, "last_flushed_at"),
    last_flush_reason: reason === "session_end" || reason === "lease_expired" ? reason : null,
    last_flush_job_id: stringOf(row, "last_flush_job_id"),
    updated_at: updatedAt
  };
}

/** Marks the row as flushed; a later resume overwrites it at its next turn. */
export function markSessionFlushed(
  connection: SqliteConnection,
  sessionId: string,
  reason: "session_end" | "lease_expired",
  jobId: string | null,
  now: number
): void {
  connection
    .prepare(
      `UPDATE session_review_state
          SET last_flushed_at = :now, last_flush_reason = :reason,
              last_flush_job_id = :job_id, updated_at = :now
        WHERE session_id = :id`
    )
    .run({ id: sessionId, reason, job_id: jobId, now });
}

/**
 * The watermark of the newest automatic review snapshot for a task. Signals at
 * or below it were already considered; only later ones can trigger the next
 * session-end review.
 */
export function lastReviewWatermark(connection: SqliteConnection, taskId: string): number {
  const row = connection
    .prepare<SqlRow>(
      `SELECT MAX(stable_watermark) AS watermark
         FROM review_jobs
        WHERE task_id = :task AND review_kind = 'auto'`
    )
    .get({ task: taskId });
  const value = row === undefined ? null : row["watermark"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Maps a host-native session id back to the internal session row. Resume keeps
 * the native id, so this is the bridge that lets a lease-expired MCP channel
 * flush the same task and watermark.
 */
export function internalSessionForNative(
  connection: SqliteConnection,
  hostId: string,
  configSpace: string,
  nativeSessionId: string
): { readonly session_id: string; readonly task_id: string | null } | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT s.session_id AS session_id, b.task_id AS task_id
         FROM session s
         LEFT JOIN branch b ON b.branch_id = s.current_branch_id
        WHERE s.host_id = :host AND s.config_space = :cs
          AND s.external_session_id = :native
        LIMIT 1`
    )
    .get({ host: hostId, cs: configSpace, native: nativeSessionId });
  if (row === undefined) return null;
  const sessionId = stringOf(row, "session_id");
  if (sessionId === null) return null;
  return { session_id: sessionId, task_id: stringOf(row, "task_id") };
}

export interface ExpiredRuntimeSession {
  readonly session_id: string;
  readonly host_id: string;
  readonly config_space: string;
  readonly registration_hash: string;
  readonly instance_key: string | null;
  readonly native_session_id: string | null;
  readonly pid: number | null;
  readonly started_at: number;
  readonly state: string;
}

/** Runtime sessions whose lease has expired, collected before the sweep. */
export function expiredRuntimeSessions(
  connection: SqliteConnection,
  now: number
): readonly ExpiredRuntimeSession[] {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT session_id, host_id, config_space, registration_hash, instance_key,
              native_session_id, pid, started_at, state
         FROM host_runtime_session
        WHERE state IN ('ready','failed') AND lease_expires_at <= :now`
    )
    .all({ now });
  const out: ExpiredRuntimeSession[] = [];
  for (const row of rows) {
    const sessionId = stringOf(row, "session_id");
    const host = stringOf(row, "host_id");
    const space = stringOf(row, "config_space");
    const registration = stringOf(row, "registration_hash");
    const state = stringOf(row, "state");
    const startedAt = numberOf(row, "started_at");
    if (
      sessionId === null || host === null || space === null ||
      registration === null || state === null || startedAt === null
    ) {
      continue;
    }
    out.push({
      session_id: sessionId,
      host_id: host,
      config_space: space,
      registration_hash: registration,
      instance_key: stringOf(row, "instance_key"),
      native_session_id: stringOf(row, "native_session_id"),
      pid: numberOf(row, "pid"),
      started_at: startedAt,
      state
    });
  }
  return out;
}

/**
 * The newest hook-reported native session for one registration. A one-shot hook
 * host's current session is whichever native session the hooks last wrote; the
 * MCP channel session itself uses a generated `mcp-confirm:` instance key.
 */
export function latestHookNativeSession(
  connection: SqliteConnection,
  registrationHash: string,
  hostId: string,
  configSpace: string,
  since?: number
): string | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT native_session_id
         FROM host_runtime_session
        WHERE registration_hash = :registration
          AND host_id = :host AND config_space = :cs
          AND native_session_id IS NOT NULL
          AND (instance_key IS NULL OR instance_key NOT LIKE 'mcp-confirm:%')
          ${since === undefined ? "" : "AND last_seen_at >= :since"}
        ORDER BY last_seen_at DESC, session_id DESC
        LIMIT 1`
    )
    .get({
      registration: registrationHash,
      host: hostId,
      cs: configSpace,
      ...(since === undefined ? {} : { since })
    });
  return row === undefined ? null : stringOf(row, "native_session_id");
}

/**
 * Q.4: the host-native session this runtime process is currently serving,
 * taken from the session registry updated by authenticated uploads since the
 * process started. It is never written back to the runtime binding.
 */
export function latestSessionNativeSince(
  connection: SqliteConnection,
  hostId: string,
  configSpace: string,
  since: number
): string | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT external_session_id AS native
         FROM session
        WHERE host_id = :host AND config_space = :cs
          AND external_session_id IS NOT NULL
          AND last_seen_at >= :since
        ORDER BY last_seen_at DESC, started_at DESC
        LIMIT 1`
    )
    .get({ host: hostId, cs: configSpace, since });
  return row === undefined ? null : stringOf(row, "native");
}

/** The internal task for one internal session id. */
export function taskForInternalSession(
  connection: SqliteConnection,
  sessionId: string
): string | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT b.task_id AS task_id
         FROM session s
         LEFT JOIN branch b ON b.branch_id = s.current_branch_id
        WHERE s.session_id = :id`
    )
    .get({ id: sessionId });
  return row === undefined ? null : stringOf(row, "task_id");
}

/** True when the recorded boundary has not yet been flushed by a session end. */
export function sessionNeedsFlush(
  connection: SqliteConnection,
  sessionId: string
): boolean {
  const state = readSessionReviewState(connection, sessionId);
  if (state === null) return false;
  return state.last_flushed_at === null || state.updated_at > state.last_flushed_at;
}

/**
 * Watermark future reviews must exceed. The session row is authoritative: a
 * review whose candidate was answered "还没做完", "稍后", or not answered
 * leaves it unchanged, so the next session-end review re-covers those signals.
 */
export function effectiveReviewWatermark(
  connection: SqliteConnection,
  taskId: string
): number {
  const row = connection
    .prepare<SqlRow>(
      `SELECT last_review_watermark AS watermark
         FROM session_review_state
        WHERE task_id = :task
        ORDER BY updated_at DESC, session_id DESC
        LIMIT 1`
    )
    .get({ task: taskId });
  if (row !== undefined) {
    const value = row["watermark"];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return lastReviewWatermark(connection, taskId);
}

/** Records the review job that owns the current pending watermark. */
export function markReviewPending(
  connection: SqliteConnection,
  taskId: string,
  jobId: string | null,
  stableWatermark: number
): void {
  connection
    .prepare(
      `UPDATE session_review_state
          SET last_review_job_id = :job, pending_review_watermark = :watermark
        WHERE task_id = :task`
    )
    .run({ task: taskId, job: jobId, watermark: stableWatermark });
}

/** Advances the watermark when the candidate answer accepts the review. */
export function advanceReviewWatermark(
  connection: SqliteConnection,
  taskId: string
): void {
  connection
    .prepare(
      `UPDATE session_review_state
          SET last_review_watermark = MAX(last_review_watermark, COALESCE(pending_review_watermark, 0))
        WHERE task_id = :task`
    )
    .run({ task: taskId });
}

/**
 * A review that produced no undecided candidate is complete: its watermark
 * advances even without a dialog answer. Pending, deferred and
 * `withdrawn_incomplete` candidates keep it unadvanced; adopted and rejected
 * ones do not.
 */
export function maybeAdvanceSettledReview(
  connection: SqliteConnection,
  taskId: string
): void {
  const blocked = connection
    .prepare<SqlRow>(
      `SELECT COUNT(*) AS count
         FROM proposals p
         JOIN review_jobs rj ON rj.job_id = p.job_id
         LEFT JOIN candidate_confirmation cc ON cc.proposal_id = p.proposal_id
        WHERE rj.task_id = :task AND rj.review_kind = 'auto'
          AND (p.state IN ('checked','proposed')
               OR cc.state IN ('pending','deferred','withdrawn_incomplete'))`
    )
    .get({ task: taskId });
  const count = blocked === undefined ? 0 : blocked["count"];
  if (typeof count === "number" && count > 0) return;
  const job = connection
    .prepare<SqlRow>(
      `SELECT job_id, stable_watermark
         FROM review_jobs
        WHERE task_id = :task AND review_kind = 'auto' AND state = 'done'
        ORDER BY created_at DESC, job_id DESC
        LIMIT 1`
    )
    .get({ task: taskId });
  if (job === undefined) return;
  const jobId = stringOf(job, "job_id");
  const watermark = numberOf(job, "stable_watermark");
  if (jobId === null || watermark === null) return;
  connection
    .prepare(
      `UPDATE session_review_state
          SET pending_review_watermark = :watermark, last_review_job_id = :job,
              last_review_watermark = MAX(last_review_watermark, :watermark)
        WHERE task_id = :task`
    )
    .run({ task: taskId, watermark, job: jobId });
}

function makeInternal(incident: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal.unexpected",
    stage: "session_review_state",
    retryable: false,
    side_effect: "none",
    details: { kind: "internal", incident_id: incident }
  });
}
