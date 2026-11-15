/**
 * Plan repository (DD-QP-20, DD-QP-27).
 *
 * Plans are immutable. `putPlan` writes the plan and its `state_seq=1` active
 * state in one commit; `appendPlanState` appends a new sequence and never
 * updates an old row. Both paths check the journal identity before writing.
 */

import { systemClock, type Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { JsonValue } from "../json.js";
import type { VersionBinding } from "../version-binding.js";
import type {
  AggregatePlanQuestion,
  AggregatePlanView,
  AppendPlanStateCommand,
  AppendPlanStateResult,
  PlanReadResult,
  PlanState,
  PlanStateDraft,
  PutQuestionPlanCommand,
  PutQuestionPlanResult,
  QuestionPlan,
  QuestionPlanRepository
} from "./types.js";
import { QpDomainError, sameIsolationScope, type QpReadSource } from "./issue_repository.js";
import { qpFailure } from "./errors.js";
import { planHash, planIdempotencyKey, planStateContentHash, sortedUnique, toJsonValue } from "./hashes.js";
import { qpEventPayloadHash, type QpJournalCommitPort, type QpLiveCommitOutcome, type QpPlanEvent, type QpPlanStateEvent } from "./journal_port.js";

export interface PlanRepositoryOptions {
  clock?: Clock;
  commit?: QpJournalCommitPort;
  /**
   * A committed-read source over the same SQLite database the writer uses.
   *
   * DD-QP-20 puts the `putPlan` dedupe inside the writer gate, so the
   * `(issue_key, plan_hash)` lookup must see the rows that are already
   * committed, not only the ones this repository instance wrote. A repository
   * without a source keeps the in-memory behaviour and stays correct for the
   * single-writer case.
   */
  source?: QpReadSource;
}

/**
 * Plan ids observed per repository instance and issue key. The repository
 * surface does not expose a listing, but state transitions such as
 * `superseded`/`stale_goal` need the plans written for the same issue.
 */
const PLAN_IDS_BY_REPOSITORY = new WeakMap<object, Map<string, string[]>>();

function planIndex(repository: object): Map<string, string[]> {
  let index = PLAN_IDS_BY_REPOSITORY.get(repository);
  if (index === undefined) {
    index = new Map();
    PLAN_IDS_BY_REPOSITORY.set(repository, index);
  }
  return index;
}

/** Records a plan id for an issue key on a repository instance. */
export function rememberIssuePlan(repository: object, issue_key: string, plan_id: string): void {
  const index = planIndex(repository);
  const ids = index.get(issue_key) ?? [];
  if (!ids.includes(plan_id)) {
    ids.push(plan_id);
    index.set(issue_key, ids);
  }
}

/** Plan ids previously seen for an issue key on a repository instance. */
export function knownIssuePlans(repository: object, issue_key: string): readonly string[] {
  return planIndex(repository).get(issue_key) ?? [];
}

function bindingsMatchFive(left: VersionBinding, right: VersionBinding): boolean {
  return sameIsolationScope(left, right);
}

function validateInitialState(draft: PlanStateDraft, plan: QuestionPlan): void {
  // The repository computes `content_hash` and the audit clock writes
  // `recorded_at`; a caller that supplies either is refused.
  const supplied = draft as unknown as Record<string, unknown>;
  if (supplied["content_hash"] !== undefined || supplied["recorded_at"] !== undefined) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "plan_state", { field: "initial_state" }));
  }
  if (
    draft.state_seq !== 1 ||
    draft.state !== "active" ||
    draft.reason_code !== null ||
    draft.plan_id !== plan.plan_id ||
    draft.plan_hash !== plan.plan_hash ||
    draft.task_id !== plan.binding.task_id ||
    draft.branch_id !== plan.binding.branch_id
  ) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "plan_state", { field: "initial_state" }));
  }
}

function validatePlan(plan: QuestionPlan, idempotencyKey: string): void {
  const recomputed = planHash(plan);
  if (recomputed !== plan.plan_hash) {
    throw new QpDomainError(qpFailure("E_PLAN_HASH_MISMATCH", "plan_state", { field: "plan_hash" }));
  }
  const expectedKey = planIdempotencyKey(plan.issue_key, plan.plan_hash);
  if (expectedKey !== idempotencyKey) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "plan_state", { field: "planning_idempotency_key" }));
  }
  if (plan.questions.length === 0) {
    throw new QpDomainError(qpFailure("E_PLAN_CLOSURE_INCOMPLETE", "plan_state", { field: "questions" }));
  }
}

/** Creates a plan repository; without a commit port it is in-memory. */
export function createPlanRepository(options: PlanRepositoryOptions = {}): QuestionPlanRepository {
  const clock = options.clock ?? systemClock;
  const commitPort = options.commit;
  const source = options.source;
  const plans = new Map<string, QuestionPlan>();
  const states = new Map<string, PlanState[]>();
  const planByIssueHash = new Map<string, string>();
  const planByIdempotency = new Map<string, string>();

  function maxState(plan_id: string): PlanState | null {
    const rows = states.get(plan_id);
    if (rows === undefined || rows.length === 0) {
      return null;
    }
    return rows[rows.length - 1] ?? null;
  }

  /**
   * The committed plan with the given `(issue_key, plan_hash)`, if any.
   *
   * The `question_plan` row carries the identity columns and the object
   * document carries the plan body, so both are read back to rebuild the
   * existing plan.
   */
  function persistedPlanByIssueHash(issue_key: string, plan_hash: string): QuestionPlan | null {
    if (source === undefined) {
      return null;
    }
    const row = source
      .prepare<{ plan_id: string }>(
        `SELECT plan_id FROM question_plan
          WHERE issue_key = :issue_key AND plan_hash = :plan_hash`
      )
      .get({ issue_key, plan_hash });
    if (row === undefined) {
      return null;
    }
    return persistedPlanById(row.plan_id);
  }

  /** The committed plan body of one plan id, if any. */
  function persistedPlanById(plan_id: string): QuestionPlan | null {
    if (source === undefined) {
      return null;
    }
    const body = source
      .prepare<{ canonical_json: string }>(
        `SELECT canonical_json FROM object_document
          WHERE object_id = :object_id AND object_type = 'question_plan'
          ORDER BY revision DESC LIMIT 1`
      )
      .get({ object_id: plan_id });
    if (body === undefined) {
      return null;
    }
    try {
      return JSON.parse(body.canonical_json) as QuestionPlan;
    } catch {
      return null;
    }
  }

  /** The committed plan state with the highest `state_seq`. */
  function persistedPlanState(plan_id: string): PlanState | null {
    if (source === undefined) {
      return null;
    }
    const statement = source.prepare<{ canonical_json: string }>(
      `SELECT canonical_json FROM object_document
        WHERE object_type = 'plan_state' AND object_id LIKE :prefix`
    );
    const rows = typeof statement.all === "function" ? statement.all({ prefix: `plan_state:${plan_id}:%` }) : [];
    let best: PlanState | null = null;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.canonical_json) as PlanState;
        if (best === null || parsed.state_seq > best.state_seq) {
          best = parsed;
        }
      } catch {
        continue;
      }
    }
    return best;
  }

  function storePlan(plan: QuestionPlan, state: PlanState): void {
    plans.set(plan.plan_id, plan);
    states.set(plan.plan_id, [state]);
    planByIssueHash.set(`${plan.issue_key}\u0000${plan.plan_hash}`, plan.plan_id);
  }

  function storeState(state: PlanState): void {
    const rows = states.get(state.plan_id) ?? [];
    rows.push(state);
    states.set(state.plan_id, rows);
  }

  function putPlan(command: PutQuestionPlanCommand): PutQuestionPlanResult {
    validatePlan(command.plan, command.planning_idempotency_key);
    validateInitialState(command.initial_state, command.plan);
    const existingId = planByIdempotency.get(command.planning_idempotency_key);
    if (existingId !== undefined) {
      const existing = plans.get(existingId);
      const state = maxState(existingId);
      if (existing !== undefined && state !== null) {
        if (existing.plan_hash !== command.plan.plan_hash) {
          throw new QpDomainError(qpFailure("E_PLAN_HASH_MISMATCH", "plan_state", { plan_id: existingId }));
        }
        return { plan: existing, plan_state: state, deduplicated: true };
      }
    }
    const sameIssueHash = planByIssueHash.get(`${command.plan.issue_key}\u0000${command.plan.plan_hash}`);
    if (sameIssueHash !== undefined) {
      const existing = plans.get(sameIssueHash);
      const state = maxState(sameIssueHash);
      if (existing !== undefined && state !== null) {
        planByIdempotency.set(command.planning_idempotency_key, sameIssueHash);
        return { plan: existing, plan_state: state, deduplicated: true };
      }
    }
    // DD-QP-20: a different `planning_idempotency_key` for a plan whose
    // `(issue_key, plan_hash)` is already committed returns the existing
    // plan and plan state with `deduplicated=true`. The lookup covers the
    // committed rows, so a fresh repository instance after a restart sees
    // the plan a previous instance wrote.
    const persisted = persistedPlanByIssueHash(command.plan.issue_key, command.plan.plan_hash);
    if (persisted !== null) {
      const persistedState = persistedPlanState(persisted.plan_id);
      if (persistedState !== null) {
        storePlan(persisted, persistedState);
        planByIdempotency.set(command.planning_idempotency_key, persisted.plan_id);
        return { plan: persisted, plan_state: persistedState, deduplicated: true };
      }
    }
    const recorded_at = clock.utcNowMs();
    const content_hash = planStateContentHash({
      plan_id: command.plan.plan_id,
      state_seq: 1,
      state: "active",
      reason_code: null,
      plan_hash: command.plan.plan_hash,
      task_id: command.plan.binding.task_id,
      branch_id: command.plan.binding.branch_id
    });
    const state: PlanState = {
      schema_version: "rsi.question_plan_state/1",
      plan_id: command.plan.plan_id,
      state_seq: 1,
      state: "active",
      reason_code: null,
      plan_hash: command.plan.plan_hash,
      task_id: command.plan.binding.task_id,
      branch_id: command.plan.binding.branch_id,
      recorded_at,
      content_hash
    };
    if (commitPort !== undefined) {
      const payload = { plan: command.plan, initial_state: state };
      const event: QpPlanEvent = {
        schema_version: "rsi.qp_plan_event/1",
        event_type: "question_plan_put",
        entity_type: "question_plan",
        entity_id: command.plan.plan_id,
        payload_hash: qpEventPayloadHash(toJsonValue(payload)),
        payload
      };
      const outcome: QpLiveCommitOutcome = commitPort.commitQpJournal({
        event,
        apply: () => {
          if (plans.has(command.plan.plan_id)) {
            return { kind: "existing", value: toJsonValue({ plan: command.plan, plan_state: state }) };
          }
          storePlan(command.plan, state);
          planByIdempotency.set(command.planning_idempotency_key, command.plan.plan_id);
          return { kind: "commit" };
        }
      });
      if (outcome.commit_state === "not_written") {
        throw new QpDomainError(outcome.error);
      }
      if (outcome.commit_state === "unknown_recovery_required") {
        throw new QpDomainError(
          qpFailure("E_PERSISTENCE_INTEGRITY", "plan_state", { reason: "unknown_recovery_required" })
        );
      }
    } else {
      storePlan(command.plan, state);
      planByIdempotency.set(command.planning_idempotency_key, command.plan.plan_id);
    }
    const stored = plans.get(command.plan.plan_id);
    const storedState = maxState(command.plan.plan_id);
    if (stored === undefined || storedState === null || stored.plan_hash !== command.plan.plan_hash) {
      throw new QpDomainError(qpFailure("E_PERSISTENCE_INTEGRITY", "plan_state", { reason: "readback" }));
    }
    return { plan: stored, plan_state: storedState, deduplicated: false };
  }

  function appendPlanState(command: AppendPlanStateCommand): AppendPlanStateResult {
    let plan = plans.get(command.plan_id);
    let current = maxState(command.plan_id);
    if (plan === undefined || current === null) {
      // A repository that was rebuilt after a restart reads the committed
      // plan and its current state back from the database.
      const persisted = persistedPlanById(command.plan_id);
      const persistedState = persisted === null ? null : persistedPlanState(persisted.plan_id);
      if (persisted !== null && persistedState !== null) {
        storePlan(persisted, persistedState);
        plan = persisted;
        current = persistedState;
      }
    }
    if (plan === undefined || current === null) {
      throw new QpDomainError(qpFailure("E_PLAN_NOT_FOUND", "plan_state", { plan_id: command.plan_id }));
    }
    if (command.expected_state_seq !== current.state_seq) {
      throw new QpDomainError(
        qpFailure("E_PLAN_STATE_CONFLICT", "plan_state", {
          expected_state_seq: command.expected_state_seq,
          actual_state_seq: current.state_seq
        })
      );
    }
    if (current.state === command.state && current.reason_code === command.reason_code) {
      return { plan_state: current, deduplicated: true };
    }
    if (current.state !== "active" && command.state === "active") {
      throw new QpDomainError(qpFailure("E_PLAN_STATE_CONFLICT", "plan_state", { plan_id: command.plan_id }));
    }
    const nextSeq = current.state_seq + 1;
    const recorded_at = clock.utcNowMs();
    const content_hash = planStateContentHash({
      plan_id: plan.plan_id,
      state_seq: nextSeq,
      state: command.state,
      reason_code: command.reason_code,
      plan_hash: plan.plan_hash,
      task_id: command.task_id,
      branch_id: command.branch_id
    });
    const state: PlanState = {
      schema_version: "rsi.question_plan_state/1",
      plan_id: plan.plan_id,
      state_seq: nextSeq,
      state: command.state,
      reason_code: command.reason_code,
      plan_hash: plan.plan_hash,
      task_id: command.task_id,
      branch_id: command.branch_id,
      recorded_at,
      content_hash
    };
    if (commitPort !== undefined) {
      const statePayload = { state };
      const event: QpPlanStateEvent = {
        schema_version: "rsi.qp_plan_state_event/1",
        event_type: "plan_state_appended",
        entity_type: "plan_state",
        entity_id: `plan_state:${plan.plan_id}:${String(nextSeq)}`,
        payload_hash: qpEventPayloadHash(toJsonValue(statePayload)),
        payload: statePayload
      };
      const outcome = commitPort.commitQpJournal({
        event,
        apply: () => {
          const latest = maxState(command.plan_id);
          if (latest !== null && latest.state_seq >= nextSeq) {
            if (latest.content_hash !== state.content_hash) {
              throw new QpDomainError(qpFailure("E_PLAN_STATE_CONFLICT", "plan_state", { plan_id: plan.plan_id }));
            }
            return { kind: "existing", value: toJsonValue(latest) };
          }
          storeState(state);
          return { kind: "commit" };
        }
      });
      if (outcome.commit_state === "not_written") {
        throw new QpDomainError(outcome.error);
      }
      if (outcome.commit_state === "unknown_recovery_required") {
        throw new QpDomainError(
          qpFailure("E_PERSISTENCE_INTEGRITY", "plan_state", { reason: "unknown_recovery_required" })
        );
      }
    } else {
      storeState(state);
    }
    const stored = maxState(command.plan_id);
    if (stored === null || stored.content_hash !== state.content_hash) {
      throw new QpDomainError(qpFailure("E_PERSISTENCE_INTEGRITY", "plan_state", { reason: "readback" }));
    }
    return { plan_state: stored, deduplicated: false };
  }

  function readPlanForAggregate(q: {
    plan_id: string;
    expected_plan_hash: string;
    binding: VersionBinding;
  }): PlanReadResult {
    // DD-QP-29 and DD-QP-27: the port reads the persisted plan and the
    // `PlanState` with the highest `state_seq`. When the repository has a
    // committed-read source, the store is the truth: a plan or a state that
    // is gone from the store is gone for the port as well, and the in-memory
    // cache never resurrects it. A repository without a source stays purely
    // in-memory.
    const plan = source === undefined ? plans.get(q.plan_id) ?? null : persistedPlanById(q.plan_id);
    const state = source === undefined ? maxState(q.plan_id) : persistedPlanState(q.plan_id);
    if (plan === null || state === null) {
      return { status: "rejected", code: "E_PLAN_NOT_FOUND", details: { stage: "plan_read" } };
    }
    if (plan.plan_hash !== q.expected_plan_hash) {
      return { status: "rejected", code: "E_PLAN_HASH_MISMATCH", details: { stage: "plan_read" } };
    }
    if (!bindingsMatchFive(plan.binding, q.binding)) {
      return { status: "rejected", code: "E_VERSION_BINDING", details: { stage: "plan_read" } };
    }
    // DD-QP-29 item 2 and DD-QP-29a: the aggregation view never exposes the
    // local random `question_id`. The id is excluded from `plan_hash`
    // (DD-QP-21) and only joins the local wire, so a persisted plan that
    // carries one is still readable; the port drops the field instead of
    // refusing the plan. The port's closed error set stays
    // `E_PLAN_NOT_FOUND` / `E_PLAN_HASH_MISMATCH` / `E_VERSION_BINDING`.
    const questions: AggregatePlanQuestion[] = [...plan.questions]
      .sort((left, right) => (left.question_key < right.question_key ? -1 : left.question_key > right.question_key ? 1 : 0))
      .map((question) => ({
        question_key: question.question_key,
        question_type: question.question_type,
        template_id: question.template_id,
        template_version: question.template_version,
        template_hash: question.template_hash,
        instructions: question.instructions,
        criteria: { ...question.criteria },
        options: [...question.options],
        required_views: [...question.required_views],
        required_source_ids: [...question.required_source_ids],
        output_reserve_tokens: question.output_reserve_tokens,
        required_for_issue: true,
        proposition_id: question.proposition_id,
        requirement_ids: [...question.requirement_ids],
        option_effects: { ...question.option_effects },
        answer_to_issue_map: { ...question.answer_to_issue_map },
        independence: {
          answer_independent: true,
          state_profile: question.independence.state_profile,
          shareable: question.independence.shareable
        }
      }));
    const view: AggregatePlanView = {
      issue_id: plan.issue_id,
      issue_key: plan.issue_key,
      plan_hash: plan.plan_hash,
      plan_state: state.state,
      state_profile: plan.state_profile,
      binding: plan.binding,
      questions
    };
    return { status: "ok", view };
  }

  const repository: QuestionPlanRepository = {
    getPlan(plan_id: string): QuestionPlan | null {
      return source === undefined ? plans.get(plan_id) ?? null : persistedPlanById(plan_id);
    },
    getPlanState(plan_id: string): PlanState | null {
      return source === undefined ? maxState(plan_id) : persistedPlanState(plan_id);
    },
    putPlan,
    appendPlanState,
    readPlanForAggregate
  };
  return repository;
}

/** Allocates a new plan id (QP-local instance id). */
export function allocatePlanId(): string {
  return newId("plan");
}

/** Builds a plan state object without persisting it; used by tests. */
export function materializePlanState(input: {
  plan: QuestionPlan;
  state_seq: number;
  state: PlanState["state"];
  reason_code: string | null;
  recorded_at: number;
}): PlanState {
  return {
    schema_version: "rsi.question_plan_state/1",
    plan_id: input.plan.plan_id,
    state_seq: input.state_seq,
    state: input.state,
    reason_code: input.reason_code,
    plan_hash: input.plan.plan_hash,
    task_id: input.plan.binding.task_id,
    branch_id: input.plan.binding.branch_id,
    recorded_at: input.recorded_at,
    content_hash: planStateContentHash({
      plan_id: input.plan.plan_id,
      state_seq: input.state_seq,
      state: input.state,
      reason_code: input.reason_code,
      plan_hash: input.plan.plan_hash,
      task_id: input.plan.binding.task_id,
      branch_id: input.plan.binding.branch_id
    })
  };
}

/** Sorted unique required source ids, used by plan persistence checks. */
export function normalizeRequiredSourceIds(ids: readonly string[]): string[] {
  return sortedUnique(ids);
}

/** JSON helper for commit port decisions. */
export function planCommitValue(plan: QuestionPlan, state: PlanState): JsonValue {
  return toJsonValue({ plan, plan_state: state });
}
