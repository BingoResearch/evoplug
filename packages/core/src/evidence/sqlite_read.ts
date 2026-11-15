/**
 * SQLite-backed read repositories for the QP typed tables (DD-QP-27,
 * DD-QP-27a).
 *
 * The five QP tables are relationship indexes; the immutable bodies live in
 * `object_document` / `object_head`. After a journal-only recovery a
 * restarted process must be able to read the recovered issue, judgment,
 * transition, plan and plan state back, so the QP repositories accept an
 * optional read source.
 *
 * The read source is the structural transaction port of `@evoplug/core`, not
 * a storage-package type: QP never imports the storage package.
 */

import type { Tx } from "../tx.js";
import type { JsonValue } from "../json.js";
import type {
  Issue,
  IssueJudgment,
  IssueJudgmentDraft,
  IssueTransitionRecord,
  PlanState,
  QuestionPlan
} from "./types.js";
import { judgmentHash } from "./hashes.js";

/** A JSON row read back from SQLite. */
type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDocument(source: Tx, objectId: string, objectType: string): Row | null {
  const row = source
    .prepare<{ canonical_json: string }>(
      `SELECT canonical_json FROM object_document
        WHERE object_id = :object_id AND object_type = :object_type
        ORDER BY revision DESC LIMIT 1`
    )
    .get({ object_id: objectId, object_type: objectType });
  if (row === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.canonical_json);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** Reads one `IssueTransitionRecord` back from the persisted object document. */
export function readSqliteTransition(source: Tx, transition_id: string): IssueTransitionRecord | null {
  const body = readDocument(source, transition_id, "issue_transition");
  return body === null ? null : (body as unknown as IssueTransitionRecord);
}

/**
 * Reads one `IssueJudgment` back and re-verifies its hash.
 *
 * A judgment whose recomputed hash differs from the stored `judgment_hash` is
 * not trusted: the read returns `null` rather than a corrupt body.
 */
export function readSqliteJudgment(source: Tx, judgment_id: string): IssueJudgment | null {
  const body = readDocument(source, judgment_id, "issue_judgment");
  if (body === null) {
    return null;
  }
  const judgment = body as unknown as IssueJudgment;
  if (judgment.accepted !== true) {
    return null;
  }
  const recomputed = judgmentHash(judgment as unknown as IssueJudgmentDraft);
  return recomputed === judgment.judgment_hash ? judgment : null;
}

/** Reads one `Issue` back from the persisted object document. */
export function readSqliteIssue(source: Tx, issue_id: string): Issue | null {
  const body = readDocument(source, issue_id, "issue");
  return body === null ? null : (body as unknown as Issue);
}

/** Reads one `QuestionPlan` back from the persisted object document. */
export function readSqlitePlan(source: Tx, plan_id: string): QuestionPlan | null {
  const body = readDocument(source, plan_id, "question_plan");
  return body === null ? null : (body as unknown as QuestionPlan);
}

/** Reads every persisted plan state of one plan, ordered by `state_seq`. */
export function readSqlitePlanStates(source: Tx, plan_id: string): PlanState[] {
  const rows = source
    .prepare<{ canonical_json: string }>(
      `SELECT canonical_json FROM object_document
        WHERE object_type = 'plan_state' AND object_id LIKE :prefix`
    )
    .all({ prefix: `plan_state:${plan_id}:%` });
  const out: PlanState[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonical_json);
    } catch {
      continue;
    }
    if (isRecord(parsed)) {
      out.push(parsed as unknown as PlanState);
    }
  }
  return out.sort((left, right) => left.state_seq - right.state_seq);
}

/** Reads the current plan state, i.e. the one with the highest `state_seq`. */
export function readSqlitePlanState(source: Tx, plan_id: string): PlanState | null {
  const states = readSqlitePlanStates(source, plan_id);
  return states.length === 0 ? null : (states[states.length - 1] ?? null);
}

/**
 * Reads the active issue summaries of one isolation scope.
 *
 * The projection rows carry the indexed columns; the object documents carry
 * the body. Only rows in one of the requested states are returned.
 */
export function readSqliteActiveIssues(
  source: Tx,
  query: { binding: { task_id: string; branch_id: string }; states?: readonly string[] }
): Issue[] {
  const states = query.states ?? ["proposed", "open", "needs_evidence", "judged", "abstained"];
  const placeholders = states.map((_state, index) => `:state${String(index)}`).join(", ");
  const params: Record<string, unknown> = {
    task_id: query.binding.task_id,
    branch_id: query.binding.branch_id
  };
  states.forEach((state, index) => {
    params[`state${String(index)}`] = state;
  });
  const rows = source
    .prepare<{ canonical_json: string }>(
      `SELECT canonical_json FROM object_document
        WHERE object_type = 'issue'
          AND task_id = :task_id
          AND branch_id = :branch_id
          AND state IN (${placeholders})
        ORDER BY object_id ASC, revision DESC`
    )
    .all(params);
  const out: Issue[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonical_json);
    } catch {
      continue;
    }
    if (isRecord(parsed)) {
      out.push(parsed as unknown as Issue);
    }
  }
  return out;
}

/** The canonical JSON body of one persisted object, for read-back checks. */
export function readSqliteObjectBody(
  source: Tx,
  objectId: string,
  objectType: string
): JsonValue | null {
  const body = readDocument(source, objectId, objectType);
  return body === null ? null : (body as JsonValue);
}
