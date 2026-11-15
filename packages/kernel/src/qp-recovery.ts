/**
 * QP journal replay reducer and SQLite read repositories
 * (DD-QP-27, DD-QP-27a, DD-FND-060).
 *
 * QP owns the four-member `QpJournalEvent` closed set and the five typed
 * tables. The storage package owns the journal scan and the SQLite
 * connection; this module owns the QP half of the recovery contract:
 *
 *   - `replayQpJournalFrame` validates one committed frame against the
 *     published payload schemas and payload hashes and applies it to the five
 *     typed tables plus `object_document` / `object_head`;
 *   - `replayQpJournal` replays a whole visible frame list in
 *     `(commit_seq, journal_seq)` order inside one transaction, idempotently;
 *   - `createIssueReadRepository` / `createPlanReadRepository` read the
 *     recovered rows back so a restarted process sees the same issue,
 *     judgment, plan and plan state.
 *
 * The reducer is deterministic and synchronous. It never calls a gateway, a
 * REV reader, a source reader or any other live dependency, and it never
 * re-plans: a replayed plan is read back exactly as it was committed.
 *
 * Failure is closed per frame. An unknown event type or a payload schema
 * mismatch rejects the whole frame with `E_SCHEMA`; a payload hash or object
 * hash mismatch rejects it with `E_PERSISTENCE_INTEGRITY`. Neither case
 * applies a partial projection.
 */

import { canonicalHash, canonicalJsonText, err, makeErrorEnvelope, ok } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  VersionBinding,
} from "@evoplug/core";
import type { StatementSource, Tx } from "@evoplug/storage";

/* ------------------------------------------------------------------ */
/* Published QP payload schemas (DD-QP-27a)                            */
/* ------------------------------------------------------------------ */

export const QP_ISSUE_EVENT_SCHEMA = "rsi.qp_issue_event/1";
export const QP_PLAN_EVENT_SCHEMA = "rsi.qp_plan_event/1";
export const QP_PLAN_STATE_EVENT_SCHEMA = "rsi.qp_plan_state_event/1";
export const QP_JUDGMENT_ROUTE_EVENT_SCHEMA = "rsi.qp_judgment_route_event/1";

/** The four published QP journal event types. */
export const QP_JOURNAL_EVENT_TYPES: readonly string[] = Object.freeze([
  "issue_transition_appended",
  "question_plan_put",
  "plan_state_appended",
  "judgment_route_recorded",
]);

/* ------------------------------------------------------------------ */
/* Minimal structural readers                                          */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readInteger(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    out.push(entry);
  }
  return out;
}

function readHash(record: Record<string, unknown>, key: string): Hash | null {
  const value = record[key];
  return typeof value === "string" ? (value as Hash) : null;
}

/* ------------------------------------------------------------------ */
/* Failure envelopes                                                   */
/* ------------------------------------------------------------------ */

function schemaError(detail: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    retryable: false,
    side_effect: "none",
    message_key: "error.schema",
    stage: "qp_recovery",
    details: { kind: "field", path: "qp.journal_event", rule: detail }
  });
}

function integrityError(detail: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_PERSISTENCE_INTEGRITY",
    category: "storage",
    retryable: false,
    side_effect: "none",
    message_key: "error.persistence_integrity",
    stage: "qp_recovery",
    details: { kind: "field", path: "qp.journal_event", rule: detail }
  });
}

/* ------------------------------------------------------------------ */
/* Journal frame shape                                                 */
/* ------------------------------------------------------------------ */

/** The minimal journal frame the reducer consumes. */
export interface QpJournalFrame {
  readonly commit_seq: number;
  readonly journal_seq: number;
  readonly payload: unknown;
}

/** One QP event extracted from a journal frame. */
export interface QpReplayEvent {
  readonly commit_seq: number;
  readonly journal_seq: number;
  readonly event_type: string;
  readonly schema_version: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly payload_hash: Hash;
  readonly payload: JsonValue;
}

function readFrameEvent(frame: QpJournalFrame): Record<string, unknown> | null {
  const payload = frame.payload;
  if (!isRecord(payload)) {
    return null;
  }
  if (payload["schema_version"] !== "rsi.journal_event/1") {
    return null;
  }
  const event = payload["event"];
  if (!isRecord(event)) {
    return null;
  }
  return event;
}

/**
 * Extracts the QP event from one journal frame.
 *
 * A frame that carries no QP event at all is not an error: the reducer only
 * owns QP frames and the journal also carries FND-owned events.
 */
export function readQpEvent(frame: QpJournalFrame): QpReplayEvent | null {
  const event = readFrameEvent(frame);
  if (event === null) {
    return null;
  }
  const eventType = readString(event, "event_type");
  if (eventType === null || !QP_JOURNAL_EVENT_TYPES.includes(eventType)) {
    return null;
  }
  const schemaVersion = readString(event, "schema_version");
  const entityType = readString(event, "entity_type");
  const entityId = readString(event, "entity_id");
  const payloadHash = readHash(event, "payload_hash");
  const payload = event["payload"];
  if (
    schemaVersion === null ||
    entityType === null ||
    entityId === null ||
    payloadHash === null ||
    !isRecord(payload)
  ) {
    return null;
  }
  return {
    commit_seq: frame.commit_seq,
    journal_seq: frame.journal_seq,
    event_type: eventType,
    schema_version: schemaVersion,
    entity_type: entityType,
    entity_id: entityId,
    payload_hash: payloadHash,
    payload: payload as JsonValue
  };
}

/* ------------------------------------------------------------------ */
/* Payload schema validation                                           */
/* ------------------------------------------------------------------ */

const ISSUE_STATES: readonly string[] = Object.freeze([
  "proposed",
  "open",
  "needs_evidence",
  "judged",
  "abstained",
  "closed",
  "stale_goal",
  "rejected"
]);

const TRANSITION_EVENTS: readonly string[] = Object.freeze([
  "propose",
  "confirm",
  "reject",
  "require_evidence",
  "supply_evidence",
  "judge",
  "abstain",
  "reopen_evidence",
  "close",
  "reopen",
  "review_handoff_close",
  "review_handoff_reject",
  "invalidate_goal",
  "reject_issue",
  "attach_evidence"
]);

const PLAN_STATE_VALUES: readonly string[] = Object.freeze([
  "active",
  "superseded",
  "stale_goal",
  "stale_binding",
  "stale_template",
  "rejected"
]);

function validateIssueTransition(record: Record<string, unknown>): boolean {
  return (
    record["schema_version"] === "rsi.issue_transition/1" &&
    readString(record, "transition_id") !== null &&
    readString(record, "issue_id") !== null &&
    readInteger(record, "expected_version") !== null &&
    readInteger(record, "issue_version") !== null &&
    (readString(record, "from_state") === "none" ||
      (readString(record, "from_state") !== null &&
        ISSUE_STATES.includes(readString(record, "from_state") as string))) &&
    (readString(record, "to_state") !== null &&
      ISSUE_STATES.includes(readString(record, "to_state") as string)) &&
    (readString(record, "event") !== null &&
      TRANSITION_EVENTS.includes(readString(record, "event") as string)) &&
    readStringArray(record, "evidence_refs") !== null &&
    readHash(record, "payload_hash") !== null &&
    readHash(record, "content_hash") !== null &&
    readString(record, "task_id") !== null &&
    readString(record, "branch_id") !== null &&
    readInteger(record, "recorded_at") !== null &&
    isRecord(record["issue_after"])
  );
}

function validateIssueJudgment(record: Record<string, unknown>): boolean {
  return (
    record["schema_version"] === "rsi.issue_judgment/1" &&
    readString(record, "judgment_id") !== null &&
    readString(record, "issue_key") !== null &&
    readString(record, "issue_id") !== null &&
    readInteger(record, "issue_version") !== null &&
    isRecord(record["decision"]) &&
    (readString(record, "basis") === "hard_fact" || readString(record, "basis") === "mixed") &&
    (readString(record, "outcome") === "consistent" ||
      readString(record, "outcome") === "inconsistent" ||
      readString(record, "outcome") === "satisfied" ||
      readString(record, "outcome") === "not_satisfied") &&
    Array.isArray(record["requirement_results"]) &&
    readBoolean(record, "accepted") === true &&
    readHash(record, "judgment_hash") !== null
  );
}

function validateQuestionPlan(record: Record<string, unknown>): boolean {
  return (
    record["schema_version"] === "rsi.question_plan/1" &&
    readString(record, "plan_id") !== null &&
    readHash(record, "plan_hash") !== null &&
    readString(record, "issue_id") !== null &&
    readString(record, "issue_key") !== null &&
    readString(record, "issue_type") !== null &&
    readInteger(record, "issue_version") !== null &&
    isRecord(record["binding"]) &&
    (readString(record, "state_profile") === "progress_issue" ||
      readString(record, "state_profile") === "experience_review") &&
    readString(record, "registry_version") !== null &&
    readHash(record, "registry_hash") !== null &&
    Array.isArray(record["sources"]) &&
    Array.isArray(record["questions"]) &&
    Array.isArray(record["dependencies"]) &&
    Array.isArray(record["required_source_ids"]) &&
    Array.isArray(record["required_views"]) &&
    readInteger(record, "planned_at") !== null
  );
}

function validatePlanState(record: Record<string, unknown>): boolean {
  return (
    record["schema_version"] === "rsi.question_plan_state/1" &&
    readString(record, "plan_id") !== null &&
    readInteger(record, "state_seq") !== null &&
    (readString(record, "state") !== null &&
      PLAN_STATE_VALUES.includes(readString(record, "state") as string)) &&
    (record["reason_code"] === null || typeof record["reason_code"] === "string") &&
    readHash(record, "plan_hash") !== null &&
    readString(record, "task_id") !== null &&
    readString(record, "branch_id") !== null &&
    readInteger(record, "recorded_at") !== null &&
    readHash(record, "content_hash") !== null
  );
}

/**
 * Validates the payload schema of one QP event.
 *
 * Returns the reason string when the frame does not match the published
 * schema. The caller maps it onto `E_SCHEMA`.
 */
export function validateQpEventSchema(event: QpReplayEvent): string | null {
  switch (event.event_type) {
    case "issue_transition_appended": {
      if (event.schema_version !== QP_ISSUE_EVENT_SCHEMA) {
        return "issue_event_schema_version";
      }
      if (event.entity_type !== "issue_transition") {
        return "issue_event_entity_type";
      }
      const payload = event.payload as unknown as Record<string, unknown>;
      const transition = payload["transition"];
      const judgment = payload["judgment"];
      if (!isRecord(transition) || !validateIssueTransition(transition)) {
        return "issue_transition_shape";
      }
      if (judgment !== null && judgment !== undefined) {
        if (!isRecord(judgment) || !validateIssueJudgment(judgment)) {
          return "issue_judgment_shape";
        }
        if (transition["event"] !== "judge") {
          return "judgment_without_judge_event";
        }
        if (judgment["judgment_id"] !== transition["judgment_ref"]) {
          return "judgment_ref_mismatch";
        }
      } else if (transition["event"] === "judge") {
        return "judge_event_without_judgment";
      }
      if (event.entity_id !== transition["transition_id"]) {
        return "issue_entity_id_mismatch";
      }
      return null;
    }
    case "question_plan_put": {
      if (event.schema_version !== QP_PLAN_EVENT_SCHEMA) {
        return "plan_event_schema_version";
      }
      if (event.entity_type !== "question_plan") {
        return "plan_event_entity_type";
      }
      const payload = event.payload as unknown as Record<string, unknown>;
      const plan = payload["plan"];
      const state = payload["initial_state"];
      if (!isRecord(plan) || !validateQuestionPlan(plan)) {
        return "question_plan_shape";
      }
      if (!isRecord(state) || !validatePlanState(state)) {
        return "plan_initial_state_shape";
      }
      if (state["plan_id"] !== plan["plan_id"] || state["plan_hash"] !== plan["plan_hash"]) {
        return "plan_initial_state_binding";
      }
      if (state["state_seq"] !== 1 || state["state"] !== "active") {
        return "plan_initial_state_sequence";
      }
      if (event.entity_id !== plan["plan_id"]) {
        return "plan_entity_id_mismatch";
      }
      return null;
    }
    case "plan_state_appended": {
      if (event.schema_version !== QP_PLAN_STATE_EVENT_SCHEMA) {
        return "plan_state_event_schema_version";
      }
      if (event.entity_type !== "plan_state") {
        return "plan_state_event_entity_type";
      }
      const payload = event.payload as unknown as Record<string, unknown>;
      const state = payload["state"];
      if (!isRecord(state) || !validatePlanState(state)) {
        return "plan_state_shape";
      }
      if (event.entity_id !== `plan_state:${String(state["plan_id"])}:${String(state["state_seq"])}`) {
        return "plan_state_entity_id_mismatch";
      }
      return null;
    }
    case "judgment_route_recorded": {
      if (event.schema_version !== QP_JUDGMENT_ROUTE_EVENT_SCHEMA) {
        return "route_event_schema_version";
      }
      if (event.entity_type !== "judgment_route") {
        return "route_event_entity_type";
      }
      const payload = event.payload as unknown as Record<string, unknown>;
      const route = payload["route"];
      if (!isRecord(route)) {
        return "judgment_route_shape";
      }
      if (route["schema_version"] !== "rsi.judgment_route/1") {
        return "judgment_route_schema_version";
      }
      if (readString(route, "route_id") !== event.entity_id) {
        return "route_entity_id_mismatch";
      }
      return null;
    }
    default:
      return "unknown_event_type";
  }
}

/* ------------------------------------------------------------------ */
/* Object document / head helpers                                     */
/* ------------------------------------------------------------------ */

/**
 * The object document id for one immutable revision.
 *
 * The id is the canonical hash of the `(owner, object_type, object_id,
 * revision)` tuple, exactly as the FND `rsi.object_document_key/1` shape.
 */
export function qpObjectDocumentId(input: {
  owner: "qp";
  object_type: string;
  object_id: string;
  revision: number;
}): Hash {
  return canonicalHash({
    schema_version: "rsi.object_document_key/1",
    owner: input.owner,
    object_type: input.object_type,
    object_id: input.object_id,
    revision: input.revision
  });
}

interface DocumentSpec {
  readonly object_id: string;
  readonly object_type: string;
  readonly schema_version: string;
  readonly revision: number;
  readonly state: string;
  readonly body: JsonValue;
  readonly binding: VersionBinding | null;
  readonly created_at: number;
  readonly content_hash: Hash;
}

function writeDocument(tx: Tx, spec: DocumentSpec): void {
  const documentId = qpObjectDocumentId({
    owner: "qp",
    object_type: spec.object_type,
    object_id: spec.object_id,
    revision: spec.revision
  });
  const canonical = canonicalJsonText(spec.body);
  const existing = tx
    .prepare<{ content_hash: string }>(
      "SELECT content_hash FROM object_document WHERE document_id = ?"
    )
    .get([documentId]);
  if (existing !== undefined) {
    // The reducer only补写 missing rows; a different body under the same id is
    // a divergence, never an overwrite.
    if (existing.content_hash !== spec.content_hash) {
      throw integrityError("object_document_divergence");
    }
    return;
  }
  tx.prepare(
    `INSERT INTO object_document (
       document_id, object_id, owner, object_type, schema_version, revision, state,
       task_id, branch_id, input_epoch, goal_version, config_version, watermark,
       content_hash, canonical_json, created_at
     ) VALUES (
       :document_id, :object_id, 'qp', :object_type, :schema_version, :revision, :state,
       :task_id, :branch_id, :input_epoch, :goal_version, :config_version, :watermark,
       :content_hash, :canonical_json, :created_at
     )`
  ).run({
    document_id: documentId,
    object_id: spec.object_id,
    object_type: spec.object_type,
    schema_version: spec.schema_version,
    revision: spec.revision,
    state: spec.state,
    task_id: spec.binding?.task_id ?? null,
    branch_id: spec.binding?.branch_id ?? null,
    input_epoch: spec.binding?.input_epoch ?? null,
    goal_version: spec.binding?.goal_version ?? null,
    config_version: spec.binding?.config_version ?? null,
    watermark: spec.binding?.watermark ?? null,
    content_hash: spec.content_hash,
    canonical_json: canonical,
    created_at: spec.created_at
  });
}

function writeHead(tx: Tx, spec: DocumentSpec): void {
  const documentId = qpObjectDocumentId({
    owner: "qp",
    object_type: spec.object_type,
    object_id: spec.object_id,
    revision: spec.revision
  });
  const existing = tx
    .prepare<{ content_hash: string; row_version: number; revision: number }>(
      "SELECT content_hash, row_version, revision FROM object_head WHERE object_id = ?"
    )
    .get([spec.object_id]);
  if (existing !== undefined) {
    // `object_head` is the current-version pointer, so a newer revision
    // advances it. Replaying the same revision must reproduce the same
    // pointer, so a different hash under the same revision is a divergence.
    if (existing.revision === spec.revision) {
      if (existing.content_hash !== spec.content_hash) {
        throw integrityError("object_head_divergence");
      }
      return;
    }
    if (existing.revision > spec.revision) {
      throw integrityError("object_head_regression");
    }
    tx.prepare(
      `UPDATE object_head
         SET revision = :revision, document_id = :document_id, state = :state,
             content_hash = :content_hash, row_version = row_version + 1,
             updated_at = :updated_at
       WHERE object_id = :object_id`
    ).run({
      object_id: spec.object_id,
      revision: spec.revision,
      document_id: documentId,
      state: spec.state,
      content_hash: spec.content_hash,
      updated_at: spec.created_at
    });
    return;
  }
  tx.prepare(
    `INSERT INTO object_head (
       object_id, owner, object_type, revision, document_id, state, content_hash,
       row_version, updated_at
     ) VALUES (
       :object_id, 'qp', :object_type, :revision, :document_id, :state, :content_hash,
       1, :updated_at
     )`
  ).run({
    object_id: spec.object_id,
    object_type: spec.object_type,
    revision: spec.revision,
    document_id: documentId,
    state: spec.state,
    content_hash: spec.content_hash,
    updated_at: spec.created_at
  });
}

/* ------------------------------------------------------------------ */
/* Typed row writers                                                   */
/* ------------------------------------------------------------------ */

function insertIssueTransition(tx: Tx, transition: Record<string, unknown>): void {
  const transitionId = String(transition["transition_id"]);
  const existing = tx
    .prepare<{ content_hash: string }>(
      "SELECT content_hash FROM issue_transition WHERE transition_id = ?"
    )
    .get([transitionId]);
  if (existing !== undefined) {
    if (existing.content_hash !== transition["content_hash"]) {
      throw integrityError("transition_id_collision");
    }
    return;
  }
  tx.prepare(
    `INSERT INTO issue_transition (
       object_id, row_version, transition_id, issue_id, expected_version,
       issue_version, from_state, to_state, event, payload_hash, content_hash,
       task_id, branch_id, created_at
     ) VALUES (
       :object_id, 1, :transition_id, :issue_id, :expected_version,
       :issue_version, :from_state, :to_state, :event, :payload_hash, :content_hash,
       :task_id, :branch_id, :created_at
     )`
  ).run({
    object_id: transitionId,
    transition_id: transitionId,
    issue_id: transition["issue_id"],
    expected_version: transition["expected_version"],
    issue_version: transition["issue_version"],
    from_state: transition["from_state"],
    to_state: transition["to_state"],
    event: transition["event"],
    payload_hash: transition["payload_hash"],
    content_hash: transition["content_hash"],
    task_id: transition["task_id"],
    branch_id: transition["branch_id"],
    created_at: transition["recorded_at"]
  });
}

function insertIssueJudgment(tx: Tx, judgment: Record<string, unknown>): void {
  const judgmentId = String(judgment["judgment_id"]);
  const existing = tx
    .prepare<{ judgment_hash: string }>(
      "SELECT judgment_hash FROM issue_judgment WHERE judgment_id = ?"
    )
    .get([judgmentId]);
  if (existing !== undefined) {
    if (existing.judgment_hash !== judgment["judgment_hash"]) {
      throw integrityError("judgment_id_collision");
    }
    return;
  }
  const decision = judgment["decision"] as Record<string, unknown>;
  tx.prepare(
    `INSERT INTO issue_judgment (
       object_id, row_version, judgment_id, issue_id, issue_key, issue_version,
       decision_kind, basis, outcome, accepted, judgment_hash, content_hash,
       task_id, branch_id, created_at
     ) VALUES (
       :object_id, 1, :judgment_id, :issue_id, :issue_key, :issue_version,
       :decision_kind, :basis, :outcome, 1, :judgment_hash, :content_hash,
       :task_id, :branch_id, :created_at
     )`
  ).run({
    object_id: judgmentId,
    judgment_id: judgmentId,
    issue_id: judgment["issue_id"],
    issue_key: judgment["issue_key"],
    issue_version: judgment["issue_version"],
    decision_kind: decision["kind"],
    basis: judgment["basis"],
    outcome: judgment["outcome"],
    judgment_hash: judgment["judgment_hash"],
    content_hash: judgment["judgment_hash"],
    task_id: judgment["task_id"] ?? null,
    branch_id: judgment["branch_id"] ?? null,
    created_at: judgment["recorded_at_watermark"] ?? 0
  });
}

function upsertIssueProjection(tx: Tx, issue: Record<string, unknown>, contentHash: Hash): void {
  const issueId = String(issue["issue_id"]);
  const binding = issue["binding"] as Record<string, unknown>;
  const existing = tx
    .prepare<{ issue_version: number; content_hash: string }>(
      "SELECT issue_version, content_hash FROM issue_projection WHERE issue_id = ?"
    )
    .get([issueId]);
  if (existing === undefined) {
    tx.prepare(
      `INSERT INTO issue_projection (
         object_id, row_version, issue_id, issue_key, issue_type, state,
         issue_version, input_epoch, goal_version, config_version, watermark,
         content_hash, task_id, branch_id, updated_at
       ) VALUES (
         :object_id, 1, :issue_id, :issue_key, :issue_type, :state,
         :issue_version, :input_epoch, :goal_version, :config_version, :watermark,
         :content_hash, :task_id, :branch_id, :updated_at
       )`
    ).run({
      object_id: issueId,
      issue_id: issueId,
      issue_key: issue["issue_key"],
      issue_type: issue["type"],
      state: issue["state"],
      issue_version: issue["issue_version"],
      input_epoch: binding["input_epoch"],
      goal_version: binding["goal_version"],
      config_version: binding["config_version"],
      watermark: binding["watermark"],
      content_hash: contentHash,
      task_id: binding["task_id"],
      branch_id: binding["branch_id"],
      updated_at: issue["updated_at"] ?? issue["created_at"] ?? 0
    });
    return;
  }
  const incomingVersion = Number(issue["issue_version"]);
  if (incomingVersion <= Number(existing.issue_version)) {
    // An older transition never overwrites a newer projection.
    return;
  }
  tx.prepare(
    `UPDATE issue_projection
        SET row_version = row_version + 1,
            issue_key = :issue_key,
            issue_type = :issue_type,
            state = :state,
            issue_version = :issue_version,
            input_epoch = :input_epoch,
            goal_version = :goal_version,
            config_version = :config_version,
            watermark = :watermark,
            content_hash = :content_hash,
            updated_at = :updated_at
      WHERE issue_id = :issue_id`
  ).run({
    issue_id: issueId,
    issue_key: issue["issue_key"],
    issue_type: issue["type"],
    state: issue["state"],
    issue_version: incomingVersion,
    input_epoch: binding["input_epoch"],
    goal_version: binding["goal_version"],
    config_version: binding["config_version"],
    watermark: binding["watermark"],
    content_hash: contentHash,
    updated_at: issue["updated_at"] ?? issue["created_at"] ?? 0
  });
}

function insertQuestionPlan(tx: Tx, plan: Record<string, unknown>): void {
  const planId = String(plan["plan_id"]);
  const binding = plan["binding"] as Record<string, unknown>;
  const existing = tx
    .prepare<{ plan_hash: string }>("SELECT plan_hash FROM question_plan WHERE plan_id = ?")
    .get([planId]);
  if (existing !== undefined) {
    if (existing.plan_hash !== plan["plan_hash"]) {
      throw integrityError("plan_id_collision");
    }
    return;
  }
  tx.prepare(
    `INSERT INTO question_plan (
       object_id, row_version, plan_id, plan_hash, planning_idempotency_key,
       issue_id, issue_key, issue_type, issue_version, state_profile,
       registry_version, registry_hash, content_hash, task_id, branch_id,
       goal_version, config_version, input_epoch, watermark, supersedes_plan_id, created_at
     ) VALUES (
       :object_id, 1, :plan_id, :plan_hash, :planning_idempotency_key,
       :issue_id, :issue_key, :issue_type, :issue_version, :state_profile,
       :registry_version, :registry_hash, :content_hash, :task_id, :branch_id,
       :goal_version, :config_version, :input_epoch, :watermark, :supersedes_plan_id, :created_at
     )`
  ).run({
    object_id: planId,
    plan_id: planId,
    plan_hash: plan["plan_hash"],
    planning_idempotency_key: canonicalHash({
      schema_version: "rsi.plan_idempotency/1",
      issue_key: String(plan["issue_key"]),
      plan_hash: String(plan["plan_hash"])
    }),
    issue_id: plan["issue_id"],
    issue_key: plan["issue_key"],
    issue_type: plan["issue_type"],
    issue_version: plan["issue_version"],
    state_profile: plan["state_profile"],
    registry_version: plan["registry_version"],
    registry_hash: plan["registry_hash"],
    content_hash: plan["plan_hash"],
    task_id: binding["task_id"],
    branch_id: binding["branch_id"],
    goal_version: binding["goal_version"],
    config_version: binding["config_version"],
    input_epoch: binding["input_epoch"],
    watermark: binding["watermark"],
    supersedes_plan_id: plan["supersedes_plan_id"] ?? null,
    created_at: plan["planned_at"] ?? 0
  });
}

function insertPlanState(tx: Tx, state: Record<string, unknown>): void {
  const planId = String(state["plan_id"]);
  const stateSeq = Number(state["state_seq"]);
  const objectId = `plan_state:${planId}:${String(stateSeq)}`;
  const existing = tx
    .prepare<{ content_hash: string }>(
      "SELECT content_hash FROM plan_state WHERE object_id = ?"
    )
    .get([objectId]);
  if (existing !== undefined) {
    if (existing.content_hash !== state["content_hash"]) {
      throw integrityError("plan_state_collision");
    }
    return;
  }
  tx.prepare(
    `INSERT INTO plan_state (
       object_id, row_version, plan_id, state_seq, state, reason_code,
       plan_hash, content_hash, task_id, branch_id, created_at
     ) VALUES (
       :object_id, 1, :plan_id, :state_seq, :state, :reason_code,
       :plan_hash, :content_hash, :task_id, :branch_id, :created_at
     )`
  ).run({
    object_id: objectId,
    plan_id: planId,
    state_seq: stateSeq,
    state: state["state"],
    reason_code: state["reason_code"] ?? null,
    plan_hash: state["plan_hash"],
    content_hash: state["content_hash"],
    task_id: state["task_id"],
    branch_id: state["branch_id"],
    created_at: state["recorded_at"] ?? 0
  });
}

/* ------------------------------------------------------------------ */
/* Frame reducer                                                       */
/* ------------------------------------------------------------------ */

export interface QpReplayReport {
  readonly applied_frames: number;
  readonly skipped_frames: number;
  readonly transition_ids: readonly string[];
  readonly plan_ids: readonly string[];
}

/**
 * Applies one validated QP event to the typed tables and object documents.
 *
 * The function is idempotent: replaying the same frame twice leaves the same
 * rows and never produces a second judgment, plan or plan state.
 */
function applyQpEvent(tx: Tx, event: QpReplayEvent): void {
  const payload = event.payload as unknown as Record<string, unknown>;
  switch (event.event_type) {
    case "issue_transition_appended": {
      const transition = payload["transition"] as Record<string, unknown>;
      const judgment = payload["judgment"];
      const issue = transition["issue_after"] as Record<string, unknown>;
      const issueBinding = issue["binding"] as Record<string, unknown>;
      insertIssueTransition(tx, transition);
      if (isRecord(judgment)) {
        insertIssueJudgment(tx, { ...judgment, task_id: issueBinding["task_id"], branch_id: issueBinding["branch_id"] });
      }
      upsertIssueProjection(tx, issue, transition["content_hash"] as Hash);
      writeDocument(tx, {
        object_id: String(transition["transition_id"]),
        object_type: "issue_transition",
        schema_version: "rsi.issue_transition/1",
        revision: 1,
        state: String(transition["to_state"]),
        body: transition as JsonValue,
        binding: issueBinding as unknown as VersionBinding,
        created_at: Number(transition["recorded_at"]),
        content_hash: transition["content_hash"] as Hash
      });
      writeHead(tx, {
        object_id: String(transition["transition_id"]),
        object_type: "issue_transition",
        schema_version: "rsi.issue_transition/1",
        revision: 1,
        state: String(transition["to_state"]),
        body: transition as JsonValue,
        binding: issueBinding as unknown as VersionBinding,
        created_at: Number(transition["recorded_at"]),
        content_hash: transition["content_hash"] as Hash
      });
      writeDocument(tx, {
        object_id: String(issue["issue_id"]),
        object_type: "issue",
        schema_version: "rsi.issue/1",
        revision: Number(issue["issue_version"]),
        state: String(issue["state"]),
        body: issue as JsonValue,
        binding: issueBinding as unknown as VersionBinding,
        created_at: Number(issue["updated_at"] ?? issue["created_at"] ?? 0),
        content_hash: transition["content_hash"] as Hash
      });
      writeHead(tx, {
        object_id: String(issue["issue_id"]),
        object_type: "issue",
        schema_version: "rsi.issue/1",
        revision: Number(issue["issue_version"]),
        state: String(issue["state"]),
        body: issue as JsonValue,
        binding: issueBinding as unknown as VersionBinding,
        created_at: Number(issue["updated_at"] ?? issue["created_at"] ?? 0),
        content_hash: transition["content_hash"] as Hash
      });
      if (isRecord(judgment)) {
        const judgmentBody = {
          ...judgment,
          task_id: issueBinding["task_id"],
          branch_id: issueBinding["branch_id"]
        } as unknown as JsonValue;
        writeDocument(tx, {
          object_id: String(judgment["judgment_id"]),
          object_type: "issue_judgment",
          schema_version: "rsi.issue_judgment/1",
          revision: Number(judgment["issue_version"]),
          state: "accepted",
          body: judgmentBody,
          binding: issueBinding as unknown as VersionBinding,
          created_at: Number(judgment["recorded_at_watermark"] ?? 0),
          content_hash: judgment["judgment_hash"] as Hash
        });
        writeHead(tx, {
          object_id: String(judgment["judgment_id"]),
          object_type: "issue_judgment",
          schema_version: "rsi.issue_judgment/1",
          revision: Number(judgment["issue_version"]),
          state: "accepted",
          body: judgmentBody,
          binding: issueBinding as unknown as VersionBinding,
          created_at: Number(judgment["recorded_at_watermark"] ?? 0),
          content_hash: judgment["judgment_hash"] as Hash
        });
      }
      break;
    }
    case "question_plan_put": {
      const plan = payload["plan"] as Record<string, unknown>;
      const state = payload["initial_state"] as Record<string, unknown>;
      const binding = plan["binding"] as Record<string, unknown>;
      insertQuestionPlan(tx, plan);
      insertPlanState(tx, state);
      writeDocument(tx, {
        object_id: String(plan["plan_id"]),
        object_type: "question_plan",
        schema_version: "rsi.question_plan/1",
        revision: 1,
        state: String(state["state"]),
        body: plan as JsonValue,
        binding: binding as unknown as VersionBinding,
        created_at: Number(plan["planned_at"] ?? 0),
        content_hash: plan["plan_hash"] as Hash
      });
      writeHead(tx, {
        object_id: String(plan["plan_id"]),
        object_type: "question_plan",
        schema_version: "rsi.question_plan/1",
        revision: 1,
        state: String(state["state"]),
        body: plan as JsonValue,
        binding: binding as unknown as VersionBinding,
        created_at: Number(plan["planned_at"] ?? 0),
        content_hash: plan["plan_hash"] as Hash
      });
      writePlanStateDocument(tx, state, binding);
      break;
    }
    case "plan_state_appended": {
      const state = payload["state"] as Record<string, unknown>;
      insertPlanState(tx, state);
      writePlanStateDocument(tx, state, null);
      break;
    }
    case "judgment_route_recorded": {
      const route = payload["route"] as Record<string, unknown>;
      const binding = route["binding"] as Record<string, unknown> | undefined;
      // DD-QP-31d: the object body is the route draft. `recorded_at` and
      // `content_hash` are envelope fields, so the body carries neither and
      // the document content hash is the hash of the document's own bytes.
      const { recorded_at: _recordedAt, content_hash: _contentHash, ...draft } = route;
      const body = draft as JsonValue;
      writeDocument(tx, {
        object_id: String(route["route_id"]),
        object_type: "judgment_route",
        schema_version: "rsi.judgment_route/1",
        revision: 1,
        state: String(route["route_status"]),
        body,
        binding: (binding ?? null) as unknown as VersionBinding | null,
        created_at: Number(route["recorded_at"] ?? 0),
        content_hash: route["content_hash"] as Hash
      });
      writeHead(tx, {
        object_id: String(route["route_id"]),
        object_type: "judgment_route",
        schema_version: "rsi.judgment_route/1",
        revision: 1,
        state: String(route["route_status"]),
        body,
        binding: (binding ?? null) as unknown as VersionBinding | null,
        created_at: Number(route["recorded_at"] ?? 0),
        content_hash: route["content_hash"] as Hash
      });
      break;
    }
    default:
      throw schemaError("unknown_event_type");
  }
}

function writePlanStateDocument(
  tx: Tx,
  state: Record<string, unknown>,
  fallbackBinding: Record<string, unknown> | null
): void {
  const planId = String(state["plan_id"]);
  const stateSeq = Number(state["state_seq"]);
  const objectId = `plan_state:${planId}:${String(stateSeq)}`;
  const binding = fallbackBinding ?? {
    task_id: state["task_id"],
    branch_id: state["branch_id"],
    input_epoch: 1,
    goal_version: "goal:v1",
    config_version: "cfg:v1",
    watermark: 0
  };
  writeDocument(tx, {
    object_id: objectId,
    object_type: "plan_state",
    schema_version: "rsi.question_plan_state/1",
    revision: 1,
    state: String(state["state"]),
    body: state as JsonValue,
    binding: binding as unknown as VersionBinding,
    created_at: Number(state["recorded_at"] ?? 0),
    content_hash: state["content_hash"] as Hash
  });
  writeHead(tx, {
    object_id: objectId,
    object_type: "plan_state",
    schema_version: "rsi.question_plan_state/1",
    revision: 1,
    state: String(state["state"]),
    body: state as JsonValue,
    binding: binding as unknown as VersionBinding,
    created_at: Number(state["recorded_at"] ?? 0),
    content_hash: state["content_hash"] as Hash
  });
}

/**
 * Validates and applies one journal frame.
 *
 * Non-QP frames are skipped without an error. A QP frame with an unknown
 * event type, a payload schema mismatch or a hash mismatch fails closed and
 * the whole transaction is rolled back by the caller.
 */
/**
 * The payload bytes a QP frame's `payload_hash` covers.
 *
 * DD-QP-27a fixes the frame rule as `payload_hash = sha256(JCS(payload))` over
 * the published payload. The `issue_transition_appended` payload is
 * `{transition, judgment}` where the transition is the complete
 * `IssueTransitionRecord` minus the two hash fields it cannot contain itself
 * (`payload_hash`, `content_hash`); removing them keeps the hash from being
 * self-referential and matches the producer in
 * `packages/core/src/evidence/issue_repository.ts`.
 *
 * The other three QP event types hash their payload as published, with no
 * self-referential field to remove.
 */
function qpFramePayloadPreimage(event: QpReplayEvent): JsonValue {
  if (event.event_type !== "issue_transition_appended") {
    return event.payload as JsonValue;
  }
  const payload = event.payload as unknown as Record<string, unknown>;
  const transition = payload["transition"];
  if (!isRecord(transition)) {
    return event.payload as JsonValue;
  }
  const { payload_hash: _payloadHash, content_hash: _contentHash, ...rest } = transition;
  return {
    transition: rest as JsonValue,
    judgment: (payload["judgment"] ?? null) as JsonValue
  } as JsonValue;
}

export function replayQpJournalFrame(
  tx: Tx,
  frame: QpJournalFrame
): Result<{ applied: boolean; event: QpReplayEvent | null }, ErrorEnvelope> {
  const event = readQpEvent(frame);
  if (event === null) {
    return ok({ applied: false, event: null });
  }
  const schemaProblem = validateQpEventSchema(event);
  if (schemaProblem !== null) {
    return err(schemaError(schemaProblem));
  }
  const recomputed = canonicalHash(qpFramePayloadPreimage(event));
  if (recomputed !== event.payload_hash) {
    return err(integrityError("payload_hash_mismatch"));
  }
  // The frame's `payload_hash` and the transition record's own `payload_hash`
  // field carry the same value for an `issue_transition_appended` frame.
  const transition = (event.payload as unknown as Record<string, unknown>)["transition"];
  if (
    event.event_type === "issue_transition_appended" &&
    isRecord(transition) &&
    typeof transition["payload_hash"] === "string" &&
    transition["payload_hash"] !== event.payload_hash
  ) {
    return err(integrityError("transition_payload_hash_mismatch"));
  }
  try {
    applyQpEvent(tx, event);
  } catch (error) {
    if (isRecord(error) && typeof error["code"] === "string") {
      return err(error as unknown as ErrorEnvelope);
    }
    return err(integrityError("projection_failed"));
  }
  return ok({ applied: true, event });
}

/* ------------------------------------------------------------------ */
/* Whole-journal replay                                                */
/* ------------------------------------------------------------------ */

export interface QpJournalReplayOptions {
  /** The transaction the replay runs in. */
  readonly tx: Tx;
  /** The visible frames, in `(commit_seq, journal_seq)` order. */
  readonly frames: readonly QpJournalFrame[];
}

export interface QpJournalReplayReport extends QpReplayReport {
  readonly replayed_frames: number;
  readonly skipped_frames: number;
}

/**
 * Replays the visible QP frames of one journal in order.
 *
 * The caller owns the transaction: the whole replay either commits or leaves
 * the database untouched, so a rejected frame never produces a partial
 * projection.
 */
export function replayQpJournal(
  options: QpJournalReplayOptions
): Result<QpJournalReplayReport, ErrorEnvelope> {
  const ordered = [...options.frames].sort((left, right) => {
    if (left.commit_seq !== right.commit_seq) {
      return left.commit_seq - right.commit_seq;
    }
    return left.journal_seq - right.journal_seq;
  });
  const transitionIds: string[] = [];
  const planIds: string[] = [];
  let applied = 0;
  let skipped = 0;
  for (const frame of ordered) {
    const result = replayQpJournalFrame(options.tx, frame);
    if (!result.ok) {
      return err(result.error);
    }
    if (!result.value.applied || result.value.event === null) {
      skipped += 1;
      continue;
    }
    applied += 1;
    const event = result.value.event;
    if (event.event_type === "issue_transition_appended") {
      const payload = event.payload as unknown as Record<string, unknown>;
      const transition = payload["transition"] as Record<string, unknown>;
      transitionIds.push(String(transition["transition_id"]));
    }
    if (event.event_type === "question_plan_put") {
      const payload = event.payload as unknown as Record<string, unknown>;
      const plan = payload["plan"] as Record<string, unknown>;
      planIds.push(String(plan["plan_id"]));
    }
  }
  return ok({
    applied_frames: applied,
    skipped_frames: skipped,
    replayed_frames: applied,
    transition_ids: transitionIds,
    plan_ids: planIds
  });
}

/* ------------------------------------------------------------------ */
/* SQLite read repositories                                            */
/* ------------------------------------------------------------------ */

/** The issue read surface a restarted process needs after a recovery. */
export interface QpIssueReadRepository {
  getTransition(transition_id: string): Record<string, unknown> | null;
  getIssueJudgment(judgment_id: string): Record<string, unknown> | null;
  getIssue(issue_id: string): Record<string, unknown> | null;
  listActive(q: {
    binding: VersionBinding;
    states?: readonly string[];
  }): readonly Record<string, unknown>[];
}

/** The plan read surface a restarted process needs after a recovery. */
export interface QpPlanReadRepository {
  getPlan(plan_id: string): Record<string, unknown> | null;
  getPlanState(plan_id: string): Record<string, unknown> | null;
  listPlanStates(plan_id: string): readonly Record<string, unknown>[];
}

function readJsonColumn(source: StatementSource, sql: string, params: Record<string, unknown>): Record<string, unknown> | null {
  const row = source.prepare<{ canonical_json: string }>(sql).get(params);
  if (row === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(row.canonical_json);
  return isRecord(parsed) ? parsed : null;
}

/**
 * Creates the SQLite-backed issue read repository.
 *
 * The repository reads the immutable `object_document` bodies, which are the
 * canonical storage for transitions, judgments and issues (DD-QP-27a).
 */
export function createIssueReadRepository(source: StatementSource): QpIssueReadRepository {
  return {
    getTransition(transition_id: string): Record<string, unknown> | null {
      return readJsonColumn(
        source,
        "SELECT canonical_json FROM object_document WHERE object_id = :object_id AND object_type = 'issue_transition' ORDER BY revision DESC LIMIT 1",
        { object_id: transition_id }
      );
    },
    getIssueJudgment(judgment_id: string): Record<string, unknown> | null {
      return readJsonColumn(
        source,
        "SELECT canonical_json FROM object_document WHERE object_id = :object_id AND object_type = 'issue_judgment' ORDER BY revision DESC LIMIT 1",
        { object_id: judgment_id }
      );
    },
    getIssue(issue_id: string): Record<string, unknown> | null {
      return readJsonColumn(
        source,
        "SELECT canonical_json FROM object_document WHERE object_id = :object_id AND object_type = 'issue' ORDER BY revision DESC LIMIT 1",
        { object_id: issue_id }
      );
    },
    listActive(q: { binding: VersionBinding; states?: readonly string[] }): readonly Record<string, unknown>[] {
      const states = q.states ?? ["proposed", "open", "needs_evidence", "judged", "abstained"];
      const placeholders = states.map((_state, index) => `:state${String(index)}`).join(", ");
      const params: Record<string, unknown> = {
        task_id: q.binding.task_id,
        branch_id: q.binding.branch_id
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
      const out: Record<string, unknown>[] = [];
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.canonical_json);
        if (isRecord(parsed)) {
          out.push(parsed);
        }
      }
      return out;
    }
  };
}

/**
 * Creates the SQLite-backed plan read repository.
 *
 * `getPlanState` returns the state with the highest `state_seq`, which is the
 * documented way to read the current plan state (DD-QP-27a).
 */
export function createPlanReadRepository(source: StatementSource): QpPlanReadRepository {
  return {
    getPlan(plan_id: string): Record<string, unknown> | null {
      return readJsonColumn(
        source,
        "SELECT canonical_json FROM object_document WHERE object_id = :object_id AND object_type = 'question_plan' ORDER BY revision DESC LIMIT 1",
        { object_id: plan_id }
      );
    },
    getPlanState(plan_id: string): Record<string, unknown> | null {
      const rows = source
        .prepare<{ canonical_json: string }>(
          "SELECT canonical_json FROM object_document WHERE object_id LIKE :prefix AND object_type = 'plan_state' ORDER BY revision DESC"
        )
        .all({ prefix: `plan_state:${plan_id}:%` });
      let best: Record<string, unknown> | null = null;
      let bestSeq = -1;
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.canonical_json);
        if (!isRecord(parsed)) {
          continue;
        }
        const seq = Number(parsed["state_seq"]);
        if (Number.isSafeInteger(seq) && seq > bestSeq) {
          bestSeq = seq;
          best = parsed;
        }
      }
      return best;
    },
    listPlanStates(plan_id: string): readonly Record<string, unknown>[] {
      const rows = source
        .prepare<{ canonical_json: string }>(
          "SELECT canonical_json FROM object_document WHERE object_id LIKE :prefix AND object_type = 'plan_state'"
        )
        .all({ prefix: `plan_state:${plan_id}:%` });
      const out: Record<string, unknown>[] = [];
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.canonical_json);
        if (isRecord(parsed)) {
          out.push(parsed);
        }
      }
      return out.sort((left, right) => Number(left["state_seq"]) - Number(right["state_seq"]));
    }
  };
}
