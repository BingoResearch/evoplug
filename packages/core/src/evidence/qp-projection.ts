/**
 * QP projection rows (DD-FND-059.1.6.3).
 *
 * QP owns five typed tables and the four-member `QpJournalEvent` closed set.
 * A QP commit carries the typed rows it projects plus the object documents
 * and heads; FND validates them and writes one frame.
 *
 * A projection row is the complete physical row, never an incremental patch.
 * The five physical row shapes below are the DDL column sets of
 * `migrations/domains/qp/0001_qp_issue_plan.sql`; the row schemas are the
 * object mappings of DD-QP-27a. The `row_schema` of a projection must equal
 * the schema of its table; the `after_hash` is `sha256(JCS(row))`.
 */

import type { Hash } from "../hash.js";

/* ------------------------------------------------------------------ */
/* Physical rows                                                       */
/* ------------------------------------------------------------------ */

/** Physical row of the `issue_transition` table. */
interface QpIssueTransitionPhysicalRow {
  readonly object_id: string;
  readonly row_version: number;
  readonly transition_id: string;
  readonly issue_id: string;
  readonly expected_version: number;
  readonly issue_version: number;
  readonly from_state:
    | "none"
    | "proposed"
    | "open"
    | "needs_evidence"
    | "judged"
    | "abstained"
    | "closed"
    | "stale_goal"
    | "rejected";
  readonly to_state:
    | "proposed"
    | "open"
    | "needs_evidence"
    | "judged"
    | "abstained"
    | "closed"
    | "stale_goal"
    | "rejected";
  readonly event:
    | "propose"
    | "confirm"
    | "reject"
    | "require_evidence"
    | "supply_evidence"
    | "judge"
    | "abstain"
    | "reopen_evidence"
    | "close"
    | "reopen"
    | "review_handoff_close"
    | "review_handoff_reject"
    | "invalidate_goal"
    | "reject_issue"
    | "attach_evidence";
  readonly payload_hash: string;
  readonly content_hash: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly created_at: number;
}

/** Physical row of the `issue_judgment` table. */
interface QpIssueJudgmentPhysicalRow {
  readonly object_id: string;
  readonly row_version: number;
  readonly judgment_id: string;
  readonly issue_id: string;
  readonly issue_key: string;
  readonly issue_version: number;
  readonly decision_kind: "answer_aggregate" | "local_facts";
  readonly basis: "hard_fact" | "mixed";
  readonly outcome: "consistent" | "inconsistent" | "satisfied" | "not_satisfied";
  readonly accepted: number;
  readonly judgment_hash: string;
  readonly content_hash: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly created_at: number;
}

/** Physical row of the `issue_projection` table. */
interface QpIssueProjectionPhysicalRow {
  readonly object_id: string;
  readonly row_version: number;
  readonly issue_id: string;
  readonly issue_key: string;
  readonly issue_type: string;
  readonly state:
    | "proposed"
    | "open"
    | "needs_evidence"
    | "judged"
    | "abstained"
    | "closed"
    | "stale_goal"
    | "rejected";
  readonly issue_version: number;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly content_hash: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly updated_at: number;
}

/** Physical row of the `question_plan` table. */
interface QpQuestionPlanPhysicalRow {
  readonly object_id: string;
  readonly row_version: number;
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly planning_idempotency_key: string;
  readonly issue_id: string;
  readonly issue_key: string;
  readonly issue_type: string;
  readonly issue_version: number;
  readonly state_profile: "progress_issue" | "experience_review";
  readonly registry_version: string;
  readonly registry_hash: string;
  readonly content_hash: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly goal_version: string;
  readonly config_version: string;
  readonly input_epoch: number;
  readonly watermark: number;
  readonly supersedes_plan_id: string | null;
  readonly created_at: number;
}

/** Physical row of the `plan_state` table. */
interface QpPlanStatePhysicalRow {
  readonly object_id: string;
  readonly row_version: number;
  readonly plan_id: string;
  readonly state_seq: number;
  readonly state:
    | "active"
    | "superseded"
    | "stale_goal"
    | "stale_binding"
    | "stale_template"
    | "rejected";
  readonly reason_code: string | null;
  readonly plan_hash: string;
  readonly content_hash: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly created_at: number;
}

/* ------------------------------------------------------------------ */
/* Row schema and physical row maps                                    */
/* ------------------------------------------------------------------ */

/** The row schema each QP projection table must carry. */
interface QpRowSchemaMap {
  readonly issue_transition: "rsi.issue_transition/1";
  readonly issue_judgment: "rsi.issue_judgment/1";
  readonly issue_projection: "rsi.issue/1";
  readonly question_plan: "rsi.question_plan/1";
  readonly plan_state: "rsi.question_plan_state/1";
}

/** The complete physical row of each QP projection table. */
interface QpPhysicalRowMap {
  readonly issue_transition: QpIssueTransitionPhysicalRow;
  readonly issue_judgment: QpIssueJudgmentPhysicalRow;
  readonly issue_projection: QpIssueProjectionPhysicalRow;
  readonly question_plan: QpQuestionPlanPhysicalRow;
  readonly plan_state: QpPlanStatePhysicalRow;
}

/* ------------------------------------------------------------------ */
/* Projection row                                                      */
/* ------------------------------------------------------------------ */

export type QpProjectionTable =
  | "issue_transition" | "issue_judgment" | "issue_projection"
  | "question_plan" | "plan_state";

export type QpProjectionRow<T extends QpProjectionTable = QpProjectionTable> = {
  readonly [K in T]: {
    readonly table: K;
    readonly operation: K extends "issue_projection" ? "insert" | "update" : "insert";
    readonly object_id: string;
    readonly expected_row_version: number | null; // insert 为 null；update 必填且为当前 row_version
    readonly row_schema: QpRowSchemaMap[K];
    readonly row: QpPhysicalRowMap[K];            // QP 完整物理行，不是增量补丁
    readonly after_hash: Hash;                    // sha256(JCS(row))
  };
}[T];

/** Every QP projection table, in the design's declaration order. */
export const QP_PROJECTION_TABLES: readonly QpProjectionTable[] = Object.freeze([
  "issue_transition",
  "issue_judgment",
  "issue_projection",
  "question_plan",
  "plan_state"
] as const);

/** The row schema each projection table must carry. */
export const QP_PROJECTION_ROW_SCHEMAS: Readonly<Record<QpProjectionTable, string>> = Object.freeze({
  issue_transition: "rsi.issue_transition/1",
  issue_judgment: "rsi.issue_judgment/1",
  issue_projection: "rsi.issue/1",
  question_plan: "rsi.question_plan/1",
  plan_state: "rsi.question_plan_state/1"
} as const);

const QP_PROJECTION_TABLE_SET: ReadonlySet<string> = new Set<string>(QP_PROJECTION_TABLES);

/** True when `value` is one of the five QP projection tables. */
export function isQpProjectionTable(value: unknown): value is QpProjectionTable {
  return typeof value === "string" && QP_PROJECTION_TABLE_SET.has(value);
}
