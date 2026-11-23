/**
 * QP journal events and the FND commit port surface (DD-QP-02.11, DD-QP-27a).
 *
 * FND owns the concrete `QpJournalCommitPort` (DD-FND-059.1.6.3). Until the
 * FND package publishes its generated type, this module mirrors the documented
 * method and decision shape so QP repositories can be wired and tested. The
 * integration layer may substitute the FND type; QP never opens its own
 * transaction or writes a journal frame.
 */

import type { ErrorEnvelope } from "../errors.js";
import type { Hash } from "../hash.js";
import type { JsonValue } from "../json.js";
import type { IssueJudgment, IssueTransitionRecord, JudgmentRouteRecord, PlanState, QuestionPlan } from "./types.js";
import { hashJson } from "./hashes.js";

interface QpIssueEvent {
  schema_version: "rsi.qp_issue_event/1";
  event_type: "issue_transition_appended";
  entity_type: "issue_transition";
  entity_id: string;
  payload_hash: Hash;
  payload: { transition: IssueTransitionRecord; judgment: IssueJudgment | null };
}

export interface QpPlanEvent {
  schema_version: "rsi.qp_plan_event/1";
  event_type: "question_plan_put";
  entity_type: "question_plan";
  entity_id: string;
  payload_hash: Hash;
  payload: { plan: QuestionPlan; initial_state: PlanState };
}

export interface QpPlanStateEvent {
  schema_version: "rsi.qp_plan_state_event/1";
  event_type: "plan_state_appended";
  entity_type: "plan_state";
  entity_id: string;
  payload_hash: Hash;
  payload: { state: PlanState };
}

export interface QpJudgmentRouteEvent {
  schema_version: "rsi.qp_judgment_route_event/1";
  event_type: "judgment_route_recorded";
  entity_type: "judgment_route";
  entity_id: string;
  payload_hash: Hash;
  payload: { route: JudgmentRouteRecord };
}

/** QP-owned four-member journal event closed set. */
export type QpJournalEvent = QpIssueEvent | QpPlanEvent | QpPlanStateEvent | QpJudgmentRouteEvent;

/** Live stage inside the FND writer gate; only the transaction is exposed. */
export interface QpLiveStage {
  readonly tx: unknown;
}

/** Decision returned by `apply`; `commit` carries no payload of its own. */
export type QpJournalDecision =
  | { kind: "commit" }
  | { kind: "existing"; value: JsonValue };

export interface QpJournalCommitRequest {
  event: QpJournalEvent;
  apply(stage: QpLiveStage): QpJournalDecision;
}

export type QpLiveCommitOutcome =
  | { commit_state: "committed"; value: JsonValue | null }
  | { commit_state: "existing"; value: JsonValue }
  | { commit_state: "not_written"; error: ErrorEnvelope }
  | { commit_state: "unknown_recovery_required" };

export interface QpJournalCommitPort {
  commitQpJournal(request: QpJournalCommitRequest): QpLiveCommitOutcome;
}

/** Computes the payload hash for a QP journal event payload. */
export function qpEventPayloadHash(payload: JsonValue): Hash {
  return hashJson(payload);
}
