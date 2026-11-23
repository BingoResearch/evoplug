/**
 * W6 — human feedback intake (D10).
 *
 * The intake is the missing producer between a committed host event and the
 * ledger feedback/requirement writers. It deliberately does not run inside the
 * synchronous `projectEvent` transaction: the durable intent is the committed
 * `event_log` row (and, for classified input, the online classifier result),
 * and this worker consumes it after the ACK. `recover()` re-scans the same
 * durable intent, so a crash between the feedback row and the proposal is
 * replayed idempotently instead of being lost.
 *
 * Guarantees:
 *   - only a `human` event with a HOST-verified attestation enters the ledger;
 *     every other origin stays a candidate in `event_log` and returns a named
 *     `skipped:non_human`;
 *   - no classifier means `skipped:unclassified`; the worker never guesses;
 *   - `correction`/`new_goal` produce a `proposed` requirement only; the goal
 *     version moves only when a later explicit human `acceptance` confirms it
 *     through `RequirementService`;
 *   - `dissatisfaction` never creates a requirement.
 */

import { canonicalJsonText, hashUtf8, makeErrorEnvelope } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Id,
  Result,
  SourceRef,
  SourceRefPort
} from "@evoplug/core";
import {
  FeedbackService,
  RequirementService,
  type FeedbackDraft,
  type FeedbackKind,
  type FeedbackStateRow,
  type LedgerPorts,
  type LedgerSourceEvent,
  type RequirementOpDraft,
  type RequirementScope
} from "@evoplug/ledger";
import type { SqliteConnection } from "@evoplug/storage";
import type { CommittedHostEvent } from "./online-pipeline.js";
import { isKernelProbeEvent } from "./probe-session.js";

/* ------------------------------------------------------------------ */
/* Public vocabulary                                                   */
/* ------------------------------------------------------------------ */

/** Local classifier result; the adapter never classifies by itself. */
export interface FeedbackIntent {
  readonly kind: FeedbackKind;
  readonly confidence: number;
  /** Optional evidence-backed target; absent means the event carries none. */
  readonly target_issue_id?: Id<"issue"> | null;
}

export interface FeedbackIntentInput {
  readonly event_id: Id<"ev">;
  readonly content_ref: SourceRef;
  readonly target_issue_id: Id<"issue"> | null;
}

/**
 * Injected intent classification. The kernel owns classification; adapters
 * only report `new_input` and their capability declarations.
 */
export interface FeedbackIntentClassifier {
  classify(
    input: FeedbackIntentInput
  ): Promise<Result<FeedbackIntent | null, ErrorEnvelope>>;
}

export type FeedbackSkipReason =
  | "event_missing"
  | "not_feedback"
  | "duplicate"
  | "non_human"
  | "origin_unverified"
  | "unclassified"
  | "no_content"
  | "content_unavailable";

export interface FeedbackRecordedOutcome {
  readonly status: "recorded";
  readonly event_id: Id<"ev">;
  readonly feedback_id: Id<"fb">;
  readonly kind: FeedbackKind;
  readonly target_issue_id: Id<"issue"> | null;
  readonly feedback_status: "recorded" | "needs_evidence";
  readonly duplicate: boolean;
  readonly requirement_op_id: Id<"reqop"> | null;
  readonly requirement_id: Id<"req"> | null;
  readonly goal_version_before: string;
  readonly goal_version_after: string;
  readonly confirmation: "applied" | "none" | "no_proposal" | "not_eligible";
}

export interface FeedbackSkippedOutcome {
  readonly status: "skipped";
  readonly event_id: Id<"ev">;
  readonly reason: FeedbackSkipReason;
  readonly detail: string;
}

export type FeedbackOutcome = FeedbackRecordedOutcome | FeedbackSkippedOutcome;

export type FeedbackRecoveryStopReason = "complete" | "item_limit" | "wall_limit";

export interface FeedbackRecoverySummary {
  readonly scanned: number;
  readonly recorded: number;
  readonly skipped: number;
  readonly failed: number;
  /** Failures that reached their attempt ceiling during this batch. */
  readonly terminal_failed: number;
  /** Candidate rows still eligible for a later batch. */
  readonly remaining: number;
  readonly stopped_reason: FeedbackRecoveryStopReason;
}

/**
 * Appendix P: a single background batch is bounded by item count and wall
 * clock. Items left over are picked up by the next idle batch.
 */
export interface FeedbackRecoveryBatchOptions {
  readonly max_items?: number;
  readonly max_wall_ms?: number;
  /** Failed batches after which one event becomes terminal. */
  readonly max_attempts?: number;
}

export interface FeedbackRecoveryStats {
  /** Durable candidates that are neither recorded nor terminally failed. */
  readonly pending: number;
  /** Events this composition will no longer replay automatically. */
  readonly terminal_failed: number;
}

export const DEFAULT_FEEDBACK_RECOVERY_MAX_ITEMS = 25;
export const DEFAULT_FEEDBACK_RECOVERY_MAX_WALL_MS = 30_000;
export const DEFAULT_FEEDBACK_RECOVERY_MAX_ATTEMPTS = 3;

export interface FeedbackIntakePort {
  /**
   * Observes a committed (already ACKed) event. Returns a promise that settles
   * when this event is processed; the caller may await it in the background
   * but must never delay the ACK on it.
   */
  onCommitted(event: CommittedHostEvent): Promise<void>;
  /** Processes one committed event id and returns its outcome. */
  process(event_id: Id<"ev">): Promise<Result<FeedbackOutcome, ErrorEnvelope>>;
  /**
   * Replays `feedback.observed` events that have no feedback row yet. Safe to
   * run at every startup; every write is idempotent.
   */
  recover(): Promise<FeedbackRecoverySummary>;
  /**
   * Appendix P: one bounded replay batch. Startup no longer awaits this before
   * publishing the endpoint; the background worker calls it for a limited
   * number of items and a limited wall clock, then yields.
   */
  recoverBatch(options?: FeedbackRecoveryBatchOptions): Promise<FeedbackRecoverySummary>;
  /** Durable replay backlog for `status.get` and the background worker. */
  recoveryStats(): FeedbackRecoveryStats;
  /** Resolves once the online queue is empty. */
  drain(): Promise<void>;
  /** Outcomes observed by the online path, newest last. */
  outcomes(): readonly FeedbackOutcome[];
  /** Failures observed by the online path, newest last. */
  errors(): readonly ErrorEnvelope[];
}

export interface FeedbackIntakeDeps {
  readonly connection: SqliteConnection;
  readonly ledger: LedgerPorts;
  readonly sources: Pick<SourceRefPort, "resolve">;
  readonly now: () => number;
  readonly classifier?: FeedbackIntentClassifier;
  /**
   * Observes intake outcomes. The online path stays silent by default; the app
   * composition uses this to make a skipped classification visible instead of
   * a zero-row feedback table with no diagnostic.
   */
  readonly on_outcome?: (outcome: FeedbackOutcome) => void;
  /** Observes hard failures (not skips) from the online path. */
  readonly on_failure?: (error: ErrorEnvelope) => void;
}

/* ------------------------------------------------------------------ */
/* Payload / row helpers                                               */
/* ------------------------------------------------------------------ */

interface EventRow extends Record<string, unknown> {
  readonly event_id: string;
  readonly event_type: string;
  readonly payload_text: string;
}

interface StoredPayload {
  readonly kind: string;
  readonly feedback_kind?: FeedbackKind;
  readonly target_issue_id?: string;
  readonly content?: { readonly content_ref?: string };
}

const EMPTY_SCOPE: RequirementScope = {
  paths: [],
  hosts: [],
  modes: [],
  project_ids: []
};

function unclassified(): Result<FeedbackIntent | null, ErrorEnvelope> {
  return { ok: true, status: "ok", value: null };
}

function asKind(value: unknown): FeedbackKind | null {
  return value === "correction" ||
    value === "dissatisfaction" ||
    value === "new_goal" ||
    value === "acceptance"
    ? value
    : null;
}

function skipped(
  eventId: Id<"ev">,
  reason: FeedbackSkipReason,
  detail: string
): Result<FeedbackOutcome, ErrorEnvelope> {
  return { ok: true, status: "ok", value: { status: "skipped", event_id: eventId, reason, detail } };
}

function recorded(outcome: FeedbackRecordedOutcome): Result<FeedbackOutcome, ErrorEnvelope> {
  return { ok: true, status: "ok", value: outcome };
}

/* ------------------------------------------------------------------ */
/* Intake                                                              */
/* ------------------------------------------------------------------ */

export function createFeedbackIntake(deps: FeedbackIntakeDeps): FeedbackIntakePort {
  const feedback = new FeedbackService(deps.ledger);
  const requirements = new RequirementService(deps.ledger);
  const seen: FeedbackOutcome[] = [];
  const failures: ErrorEnvelope[] = [];
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let idleWaiters: Array<() => void> = [];

  /**
   * Serializes one unit of work behind everything already queued and counts it
   * until its queue link settles. `drain()` uses the count, so it observes
   * work that is enqueued after the call as well as startup recovery.
   */
  function enqueue<Value>(run: () => Promise<Value>): Promise<Value> {
    pending += 1;
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined
    ).then(() => {
      pending -= 1;
      if (pending === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
    return next;
  }

  function record(outcome: FeedbackOutcome): void {
    seen.push(outcome);
    if (seen.length > 256) seen.shift();
  }

  function recordFailure(error: ErrorEnvelope): void {
    failures.push(error);
    if (failures.length > 64) failures.shift();
  }

  /**
   * Homes migrated before appendix P do not carry the bookkeeping table.
   * Recovery stays functional (bounded, idempotent) and simply cannot persist
   * a terminal state there.
   */
  function hasRecoveryTable(): boolean {
    const row = deps.connection
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback_recovery'"
      )
      .get();
    return row !== undefined;
  }

  function recoveryCandidates(limit: number): readonly string[] {
    const terminalGuard = hasRecoveryTable()
      ? `AND NOT EXISTS (
           SELECT 1 FROM feedback_recovery r
            WHERE r.event_id = e.event_id
              AND r.state IN ('terminal_failed','skipped')
         )`
      : "";
    const rows = deps.connection
      .prepare<{ event_id: string }>(
        `SELECT e.event_id
           FROM event_log e
          WHERE (e.event_type = 'feedback.observed'
                 OR (e.event_type = 'input.received' AND :has_classifier = 1))
            AND NOT EXISTS (
              SELECT 1 FROM feedback f WHERE f.source_event_id = e.event_id
            )
            ${terminalGuard}
          ORDER BY e.commit_seq ASC, e.event_id ASC
          LIMIT :limit`
      )
      .all({
        has_classifier: deps.classifier === undefined ? 0 : 1,
        limit
      });
    return rows.map((row) => row.event_id);
  }

  function pendingRecoveryCount(): number {
    const terminalGuard = hasRecoveryTable()
      ? `AND NOT EXISTS (
           SELECT 1 FROM feedback_recovery r
            WHERE r.event_id = e.event_id
              AND r.state IN ('terminal_failed','skipped')
         )`
      : "";
    const row = deps.connection
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM event_log e
          WHERE (e.event_type = 'feedback.observed'
                 OR (e.event_type = 'input.received' AND :has_classifier = 1))
            AND NOT EXISTS (
              SELECT 1 FROM feedback f WHERE f.source_event_id = e.event_id
            )
            ${terminalGuard}`
      )
      .get({ has_classifier: deps.classifier === undefined ? 0 : 1 });
    return Number(row?.n ?? 0);
  }

  function terminalRecoveryCount(): number {
    if (!hasRecoveryTable()) return 0;
    const row = deps.connection
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM feedback_recovery r
          WHERE r.state = 'terminal_failed'
            AND NOT EXISTS (
              SELECT 1 FROM feedback f WHERE f.source_event_id = r.event_id
            )`
      )
      .get();
    return Number(row?.n ?? 0);
  }

  /**
   * Persists one failed replay attempt and returns the new state. The attempt
   * count is per event and survives restarts, so a backend that keeps timing
   * out reaches `terminal_failed` instead of replaying on every start.
   */
  function recordRecoveryFailure(
    eventId: Id<"ev">,
    error: ErrorEnvelope,
    maxAttempts: number
  ): "pending" | "terminal_failed" {
    if (!hasRecoveryTable()) return "pending";
    const existing = deps.connection
      .prepare<{ attempts: number }>(
        "SELECT attempts FROM feedback_recovery WHERE event_id = :event_id"
      )
      .get({ event_id: eventId });
    const attempts = Number(existing?.attempts ?? 0) + 1;
    const state = attempts >= maxAttempts ? "terminal_failed" : "pending";
    deps.connection
      .prepare(
        `INSERT INTO feedback_recovery (
           event_id, attempts, state, last_error_code, last_error_stage,
           last_error_retryable, updated_at
         ) VALUES (
           :event_id, :attempts, :state, :code, :stage, :retryable, :updated_at
         )
         ON CONFLICT(event_id) DO UPDATE SET
           attempts = excluded.attempts,
           state = excluded.state,
           last_error_code = excluded.last_error_code,
           last_error_stage = excluded.last_error_stage,
           last_error_retryable = excluded.last_error_retryable,
           updated_at = excluded.updated_at`
      )
      .run({
        event_id: eventId,
        attempts,
        state,
        code: error.code,
        stage: error.stage,
        retryable: error.retryable ? 1 : 0,
        updated_at: deps.now()
      });
    return state;
  }

  /**
   * A skipped classification ("not feedback") is durable too: without it the
   * same input row would be reclassified forever by every idle batch.
   */
  function recordRecoverySkip(eventId: Id<"ev">): void {
    if (!hasRecoveryTable()) return;
    const existing = deps.connection
      .prepare<{ attempts: number }>(
        "SELECT attempts FROM feedback_recovery WHERE event_id = :event_id"
      )
      .get({ event_id: eventId });
    deps.connection
      .prepare(
        `INSERT INTO feedback_recovery (
           event_id, attempts, state, last_error_code, last_error_stage,
           last_error_retryable, updated_at
         ) VALUES (:event_id, :attempts, 'skipped', NULL, NULL, NULL, :updated_at)
         ON CONFLICT(event_id) DO UPDATE SET
           state = 'skipped',
           updated_at = excluded.updated_at`
      )
      .run({
        event_id: eventId,
        attempts: Number(existing?.attempts ?? 0),
        updated_at: deps.now()
      });
  }

  function clearRecovery(eventId: Id<"ev">): void {
    if (!hasRecoveryTable()) return;
    deps.connection
      .prepare("DELETE FROM feedback_recovery WHERE event_id = :event_id")
      .run({ event_id: eventId });
  }

  async function runRecoveryBatch(
    options?: FeedbackRecoveryBatchOptions
  ): Promise<FeedbackRecoverySummary> {
    const maxItems = options?.max_items ?? DEFAULT_FEEDBACK_RECOVERY_MAX_ITEMS;
    const maxWallMs = options?.max_wall_ms ?? DEFAULT_FEEDBACK_RECOVERY_MAX_WALL_MS;
    const maxAttempts = options?.max_attempts ?? DEFAULT_FEEDBACK_RECOVERY_MAX_ATTEMPTS;
    const startedAt = deps.now();
    let recordedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let terminalCount = 0;
    let hitWallLimit = false;
    let processed = 0;

    const candidates = recoveryCandidates(maxItems);
    for (let index = 0; index < candidates.length; index += 1) {
      if (index > 0 && deps.now() - startedAt >= maxWallMs) {
        hitWallLimit = true;
        break;
      }
      const eventId = candidates[index] as Id<"ev">;
      const outcome = await processEvent(eventId);
      processed += 1;
      if (!outcome.ok) {
        failedCount += 1;
        recordFailure(outcome.error);
        if (recordRecoveryFailure(eventId, outcome.error, maxAttempts) === "terminal_failed") {
          terminalCount += 1;
        }
        continue;
      }
      if (outcome.value.status === "recorded") {
        clearRecovery(eventId);
        recordedCount += 1;
      } else {
        recordRecoverySkip(eventId);
        skippedCount += 1;
      }
      record(outcome.value);
    }

    const remaining = pendingRecoveryCount();
    return {
      scanned: processed,
      recorded: recordedCount,
      skipped: skippedCount,
      failed: failedCount,
      terminal_failed: terminalCount,
      remaining,
      stopped_reason:
        remaining === 0 ? "complete" : hitWallLimit ? "wall_limit" : "item_limit"
    };
  }

  async function recoverAll(): Promise<FeedbackRecoverySummary> {
    // Compatibility path for callers that explicitly want a complete replay.
    // Startup uses `recoverBatch` through the background worker instead.
    return enqueue(() =>
      runRecoveryBatch({
        max_items: Number.MAX_SAFE_INTEGER,
        max_wall_ms: Number.MAX_SAFE_INTEGER,
        max_attempts: DEFAULT_FEEDBACK_RECOVERY_MAX_ATTEMPTS
      })
    );
  }

  function readEvent(eventId: Id<"ev">): EventRow | null {
    const row = deps.connection
      .prepare<EventRow>(
        "SELECT event_id, event_type, payload_text FROM event_log WHERE event_id = :event_id"
      )
      .get({ event_id: eventId });
    return row === undefined ? null : row;
  }

  function parsePayload(row: EventRow): StoredPayload | null {
    try {
      const parsed = JSON.parse(row.payload_text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      return parsed as StoredPayload;
    } catch {
      return null;
    }
  }

  function contentRefOf(payload: StoredPayload): SourceRef | null {
    const ref = payload.content?.content_ref;
    return typeof ref === "string" && ref.length > 0 ? (ref as SourceRef) : null;
  }

  async function readContent(ref: SourceRef): Promise<string | null> {
    const resolved = await deps.sources.resolve(ref);
    if (!resolved.ok) return null;
    if (!resolved.value.retrievable || resolved.value.bytes === null) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(resolved.value.bytes);
    } catch {
      return null;
    }
  }

  async function currentGoalVersion(branchId: Id<"br">): Promise<string | null> {
    const branch = await deps.ledger.identity.getBranch(branchId);
    return branch.ok && branch.value !== null ? branch.value.current_goal_version : null;
  }

  /**
   * The typed `rsi.correction_observation/1` blob a correction must point at.
   * The existing online consumer parses this envelope and requires
   * `message_id == feedback_id` and `issue_id == target_issue_id`.
   */
  async function correctionObservationRef(input: {
    readonly feedback_id: Id<"fb">;
    readonly issue_id: Id<"issue">;
    readonly user_content_ref: SourceRef;
    readonly origin: string;
  }): Promise<Result<SourceRef, ErrorEnvelope>> {
    const envelope = {
      schema_version: "rsi.correction_observation/1",
      message_id: input.feedback_id,
      issue_id: input.issue_id,
      requirement_ids: [] as string[],
      user_correction: true,
      independent: true,
      verified_closed: false,
      origin: input.origin,
      user_content_ref: input.user_content_ref
    };
    const stored = await deps.ledger.blobs.putText(canonicalJsonText(envelope));
    if (!stored.ok) return stored;
    return { ok: true, status: "ok", value: stored.value.source_ref };
  }

  async function existingProposal(
    source: LedgerSourceEvent
  ): Promise<{ readonly op_id: Id<"reqop">; readonly requirement_id: Id<"req"> | null } | null> {
    const ops = await deps.ledger.projection.listRequirementOpRows({
      task_id: source.task_id,
      branch_id: source.branch_id,
      watermark: source.watermark
    });
    if (!ops.ok) return null;
    const match = [...ops.value]
      .reverse()
      .find((op) => op.source_event_id === source.event_id);
    if (match === undefined) return null;
    return { op_id: match.op_id, requirement_id: match.created_requirement_id };
  }

  async function propose(input: {
    readonly source: LedgerSourceEvent;
    readonly kind: "correction" | "new_goal";
    readonly target: Id<"issue">;
    readonly quote_ref: SourceRef;
    readonly statement_text: string;
  }): Promise<
    Result<
      { readonly op_id: Id<"reqop">; readonly requirement_id: Id<"req"> | null },
      ErrorEnvelope
    >
  > {
    const existing = await existingProposal(input.source);
    if (existing !== null) return { ok: true, status: "ok", value: existing };

    const sourceEvent: LedgerSourceEvent = input.source;
    const draft: RequirementOpDraft = {
      schema_version: "rsi.requirement_op/1",
      task_id: sourceEvent.task_id,
      branch_id: sourceEvent.branch_id,
      source_event_id: sourceEvent.event_id,
      actor_origin: sourceEvent.origin,
      directive_strength: sourceEvent.directive_strength ?? "ambiguous",
      op: "add",
      target_requirement_id: null,
      superseded_requirement_ids: [],
      statement_text: input.statement_text,
      scope: EMPTY_SCOPE,
      acceptance: [],
      source_quote_ref: input.quote_ref,
      source_text_hash: hashUtf8(input.statement_text)
    };
    const result = await requirements.recordRequirementOps({
      binding: {
        task_id: sourceEvent.task_id,
        branch_id: sourceEvent.branch_id,
        input_epoch: sourceEvent.input_epoch ?? 1,
        goal_version: sourceEvent.goal_version,
        config_version: sourceEvent.config_version,
        watermark: sourceEvent.watermark
      },
      source_event_id: sourceEvent.event_id,
      // Model/extractor inference is always `proposed`; only an explicit
      // human confirm may apply it later.
      results: [
        { draft, extractor_status: "proposed", conflict_requirement_ids: [] }
      ],
      constraints: []
    });
    if (!result.ok) return result;
    return {
      ok: true,
      status: "ok",
      value: {
        op_id: result.value.op_ids[0] ?? ("" as Id<"reqop">),
        requirement_id: result.value.requirement_ids[0] ?? null
      }
    };
  }

  /**
   * An explicit, human-attested acceptance confirms the newest proposal that a
   * correction/new_goal made for the same issue. This is the only path that
   * advances `goal_version`.
   */
  async function confirmFromAcceptance(input: {
    readonly source: LedgerSourceEvent;
    readonly target: Id<"issue">;
    readonly quote_ref: SourceRef;
  }): Promise<
    Result<
      { readonly status: "applied" | "no_proposal" | "not_eligible"; readonly op_id: Id<"reqop"> | null },
      ErrorEnvelope
    >
  > {
    if (input.source.directive_strength !== "explicit") {
      return { ok: true, status: "ok", value: { status: "not_eligible", op_id: null } };
    }
    const ops = await deps.ledger.projection.listRequirementOpRows({
      task_id: input.source.task_id,
      branch_id: input.source.branch_id,
      watermark: input.source.watermark
    });
    if (!ops.ok) return ops;
    // A replay of the same acceptance event must not append a second confirm
    // op; the first one already moved the goal version.
    const prior = ops.value.find(
      (op) => op.source_event_id === input.source.event_id && op.op === "confirm"
    );
    if (prior !== undefined) {
      return { ok: true, status: "ok", value: { status: "applied", op_id: prior.op_id } };
    }
    const feedbackRows = await deps.ledger.projection.listFeedbackRows({
      task_id: input.source.task_id,
      branch_id: input.source.branch_id,
      watermark: input.source.watermark
    });
    if (!feedbackRows.ok) return feedbackRows;
    const candidateEventIds = feedbackRows.value
      .filter(
        (row: FeedbackStateRow) =>
          row.target_issue_id === input.target &&
          (row.kind === "correction" || row.kind === "new_goal")
      )
      .sort((left, right) => right.recorded_at - left.recorded_at)
      .map((row) => row.source_event_id);
    if (candidateEventIds.length === 0) {
      return { ok: true, status: "ok", value: { status: "no_proposal", op_id: null } };
    }
    const heads = await deps.ledger.projection.listRequirementHeads({
      task_id: input.source.task_id,
      branch_id: input.source.branch_id,
      watermark: input.source.watermark
    });
    if (!heads.ok) return heads;
    const proposedHeads = new Set(
      heads.value.filter((head) => head.status === "proposed").map((head) => head.requirement_id)
    );
    const candidate = [...ops.value]
      .reverse()
      .find(
        (op) =>
          candidateEventIds.includes(op.source_event_id) &&
          op.created_requirement_id !== null &&
          proposedHeads.has(op.created_requirement_id)
      );
    if (candidate === undefined || candidate.created_requirement_id === null) {
      return { ok: true, status: "ok", value: { status: "no_proposal", op_id: null } };
    }
    const draft: RequirementOpDraft = {
      schema_version: "rsi.requirement_op/1",
      task_id: input.source.task_id,
      branch_id: input.source.branch_id,
      source_event_id: input.source.event_id,
      actor_origin: input.source.origin,
      directive_strength: "explicit",
      op: "confirm",
      target_requirement_id: candidate.created_requirement_id,
      superseded_requirement_ids: [],
      statement_text: "",
      scope: EMPTY_SCOPE,
      acceptance: [],
      source_quote_ref: input.quote_ref,
      source_text_hash: hashUtf8("")
    };
    const result = await requirements.recordRequirementOps({
      binding: {
        task_id: input.source.task_id,
        branch_id: input.source.branch_id,
        input_epoch: input.source.input_epoch ?? 1,
        goal_version: input.source.goal_version,
        config_version: input.source.config_version,
        watermark: input.source.watermark
      },
      source_event_id: input.source.event_id,
      results: [{ draft, extractor_status: null, conflict_requirement_ids: [] }],
      constraints: []
    });
    if (!result.ok) return result;
    return {
      ok: true,
      status: "ok",
      value: { status: "applied", op_id: result.value.op_ids[0] ?? null }
    };
  }

  async function processEvent(
    eventId: Id<"ev">
  ): Promise<Result<FeedbackOutcome, ErrorEnvelope>> {
    // Appendix H.3: probe-session events are evaluator work and must not
    // create feedback signals.
    if (isKernelProbeEvent(deps.connection, eventId)) {
      return skipped(eventId, "non_human", "probe_session");
    }
    const row = readEvent(eventId);
    if (row === null) return skipped(eventId, "event_missing", "no committed event_log row");
    const payload = parsePayload(row);
    if (payload === null) return skipped(eventId, "no_content", "payload_text is not an object");
    if (payload.kind !== "feedback.observed" && payload.kind !== "input.received") {
      return skipped(eventId, "not_feedback", payload.kind);
    }
    const event = await deps.ledger.events.getEvent(eventId);
    if (!event.ok) return event;
    if (event.value === null) return skipped(eventId, "event_missing", "ledger view missing");
    const source = event.value;

    const contentRef = contentRefOf(payload);
    if (contentRef === null) return skipped(eventId, "no_content", "content_ref missing");

    let kind: FeedbackKind | null = null;
    let target: Id<"issue"> | null = null;
    if (payload.kind === "feedback.observed") {
      kind = asKind(payload.feedback_kind);
      target =
        typeof payload.target_issue_id === "string"
          ? (payload.target_issue_id as Id<"issue">)
          : null;
    } else if (deps.classifier !== undefined) {
      // The classifier is a remote model call. A transient transport failure
      // must not silently drop a user correction, so retry the retryable codes
      // a small bounded number of times.
      let classified = await deps.classifier.classify({
        event_id: eventId,
        content_ref: contentRef,
        target_issue_id: null
      });
      for (let attempt = 1; attempt < 3 && !classified.ok; attempt += 1) {
        if (!classified.error.retryable) break;
        classified = await deps.classifier.classify({
          event_id: eventId,
          content_ref: contentRef,
          target_issue_id: null
        });
      }
      if (!classified.ok) return classified;
      if (classified.value !== null) {
        kind = classified.value.kind;
        target = classified.value.target_issue_id ?? null;
      }
    } else {
      return skipped(eventId, "unclassified", "no classifier installed");
    }
    if (kind === null) return skipped(eventId, "unclassified", "classifier returned no intent");

    // Design §6.1: a verified human source is preferred, but an `unknown`
    // origin is still recorded so it can count towards `repeated_correction`.
    // Unknown corrections never create requirements and never grant write
    // authorisation; the ledger row keeps its real origin.
    const humanVerified = source.origin === "human" && source.human_attestation !== null;
    // A host-typed input (`origin=user`, basis `host_typed_field`) is stronger
    // evidence than `unknown` but is not a HOST human attestation. Per the
    // summary design §4.2 it may only produce a `proposed` requirement: the
    // goal version moves exclusively on an explicit human acceptance, and the
    // requirement still cannot authorise a managed write.
    const typedUser = source.origin === "user";
    if (!humanVerified && source.origin !== "unknown" && !typedUser) {
      return skipped(eventId, "non_human", `origin=${source.origin}; attestation_absent`);
    }

    const needsTarget = kind === "correction" || kind === "new_goal";
    // A typed-user correction also becomes a `proposed` requirement, so the
    // statement must be retrievable before any write. Read the feedback text
    // before the row is recorded: a correction that cannot be decoded must not
    // leave a `recorded` feedback row with no requirement.
    let statementText: string | null = null;
    if (needsTarget && (target !== null || (typedUser && kind === "correction"))) {
      statementText = await readContent(contentRef);
      if (statementText === null || statementText.trim().length === 0) {
        return skipped(eventId, "content_unavailable", "feedback text is not retrievable");
      }
    }
    const feedbackId = FeedbackService.feedbackIdFor({
      source_event_id: eventId,
      kind,
      target_issue_id: target
    });
    let quoteRef: SourceRef = contentRef;
    // A typed-user correction in a fresh task has no issue to target yet. It
    // still produces a correction observation so the first review can be
    // bootstrapped from two independent typed corrections; the synthetic issue
    // id is branch-local. The requirement it later proposes is `proposed`
    // only (summary design §4.2).
    const unboundTypedCorrection =
      kind === "correction" && target === null && typedUser;
    if (kind === "correction" && (target !== null || unboundTypedCorrection)) {
      const observation = await correctionObservationRef({
        feedback_id: feedbackId,
        issue_id: (target ?? ("issue:unbound" as Id<"issue">)) as Id<"issue">,
        user_content_ref: contentRef,
        origin: source.origin
      });
      if (!observation.ok) return observation;
      quoteRef = observation.value;
    }
    const draft: FeedbackDraft = {
      schema_version: "rsi.feedback_draft/1",
      task_id: source.task_id,
      branch_id: source.branch_id,
      source_event_id: eventId,
      kind,
      quote_ref: quoteRef,
      target_issue_id: target,
      status: needsTarget && target === null && !unboundTypedCorrection ? "needs_evidence" : "recorded",
      goal_version: source.goal_version,
      input_epoch: source.input_epoch ?? 1
    };
    const written = await feedback.recordFeedbackOnce(
      draft,
      humanVerified
        ? {}
        : source.origin === "unknown"
          ? { allow_unknown_origin: true }
          : { allow_user_origin: true }
    );
    if (!written.ok) {
      if (written.error.code === "E_EVENT_ORIGIN_UNVERIFIED") {
        return skipped(eventId, "origin_unverified", "HOST proof did not verify the attestation");
      }
      return written;
    }

    let requirementOpId: Id<"reqop"> | null = null;
    let requirementId: Id<"req"> | null = null;
    let confirmation: FeedbackRecordedOutcome["confirmation"] = "none";

    if (humanVerified && needsTarget && target !== null) {
      if (statementText === null) {
        return skipped(eventId, "content_unavailable", "feedback text is not retrievable");
      }
      const proposal = await propose({
        source,
        kind: kind === "correction" ? "correction" : "new_goal",
        target,
        quote_ref: quoteRef,
        statement_text: statementText
      });
      if (!proposal.ok) return proposal;
      requirementOpId = proposal.value.op_id;
      requirementId = proposal.value.requirement_id;
    } else if (humanVerified && kind === "acceptance" && target !== null) {
      const confirmed = await confirmFromAcceptance({ source, target, quote_ref: quoteRef });
      if (!confirmed.ok) return confirmed;
      confirmation = confirmed.value.status;
      requirementOpId = confirmed.value.op_id;
    } else if (typedUser && kind === "correction") {
      // Summary design §4.2: a host-typed user field may produce a `proposed`
      // requirement, never an applied one. `RequirementService` downgrades the
      // op because the source origin is `user`, so the goal version is
      // untouched and only an explicit human acceptance can apply it.
      if (statementText === null) {
        return skipped(eventId, "content_unavailable", "feedback text is not retrievable");
      }
      const proposal = await propose({
        source,
        kind: "correction",
        target: target ?? ("issue:unbound" as Id<"issue">),
        quote_ref: quoteRef,
        statement_text: statementText
      });
      if (!proposal.ok) return proposal;
      requirementOpId = proposal.value.op_id;
      requirementId = proposal.value.requirement_id;
    }

    const goalBefore = source.goal_version;
    const goalAfter = (await currentGoalVersion(source.branch_id)) ?? goalBefore;
    const outcome: FeedbackRecordedOutcome = {
      status: "recorded",
      event_id: eventId,
      feedback_id: written.value.plan.record.feedback_id,
      kind,
      target_issue_id: target,
      feedback_status: written.value.plan.record.status,
      duplicate: written.value.duplicate,
      requirement_op_id: requirementOpId,
      requirement_id: requirementId,
      goal_version_before: goalBefore,
      goal_version_after: goalAfter,
      confirmation
    };
    return recorded(outcome);
  }

  function schedule(eventId: Id<"ev">): Promise<Result<FeedbackOutcome, ErrorEnvelope>> {
    return enqueue(() => processEvent(eventId));
  }

  async function consume(eventId: Id<"ev">): Promise<void> {
    const outcome = await schedule(eventId);
    if (outcome.ok) {
      record(outcome.value);
      try {
        deps.on_outcome?.(outcome.value);
      } catch {
        // Diagnostic only.
      }
    } else {
      recordFailure(outcome.error);
      try {
        deps.on_failure?.(outcome.error);
      } catch {
        // Diagnostic only.
      }
    }
  }

  return {
    async onCommitted(event: CommittedHostEvent): Promise<void> {
      if (event.receipt.duplicate) return;
      await consume(event.receipt.event_id as Id<"ev">);
    },
    async process(eventId: Id<"ev">): Promise<Result<FeedbackOutcome, ErrorEnvelope>> {
      return processEvent(eventId);
    },
    async recover(): Promise<FeedbackRecoverySummary> {
      return recoverAll();
    },
    async recoverBatch(options?: FeedbackRecoveryBatchOptions): Promise<FeedbackRecoverySummary> {
      // The batch is one queue unit: `drain()` observes it, and no row is
      // scheduled behind it that could run after the caller thinks it stopped.
      return enqueue(() => runRecoveryBatch(options));
    },
    recoveryStats(): FeedbackRecoveryStats {
      return {
        pending: pendingRecoveryCount(),
        terminal_failed: terminalRecoveryCount()
      };
    },
    async drain(): Promise<void> {
      // Wait until the queue is genuinely idle, including startup recovery and
      // work enqueued while waiting. A bare `await queue` would snapshot only
      // the current tail and could return before a later scheduled row.
      while (pending > 0) {
        await new Promise<void>((resolve) => {
          idleWaiters.push(resolve);
        });
      }
    },
    outcomes(): readonly FeedbackOutcome[] {
      return [...seen];
    },
    errors(): readonly ErrorEnvelope[] {
      return [...failures];
    }
  };
}

/** Exported for tests and future wiring: never guesses an intent. */
export function noFeedbackIntent(): Result<FeedbackIntent | null, ErrorEnvelope> {
  return unclassified();
}

/* ------------------------------------------------------------------ */
/* Default classifier: thin adapter over an injected model port        */
/* ------------------------------------------------------------------ */

/** The only four intents the intake can act on. */
export const FEEDBACK_KINDS: readonly FeedbackKind[] = Object.freeze([
  "correction",
  "dissatisfaction",
  "new_goal",
  "acceptance"
]);

export interface FeedbackIntentModelRequest {
  readonly event_id: Id<"ev">;
  /** Decoded UTF-8 prompt text; never a raw credential or binary blob. */
  readonly content: string;
  readonly candidate_kinds: readonly FeedbackKind[];
}

export interface FeedbackIntentModelReply {
  /** `null` means "this input is not feedback"; the intake skips it. */
  readonly kind: FeedbackKind | null;
  /** Calibrated confidence in `[0, 1]`; rejected outside the range. */
  readonly confidence: number;
  readonly target_issue_id?: Id<"issue"> | null;
}

/**
 * Model seam for new-input classification. The HOST/product supplies the
 * implementation; the kernel never calls a remote provider by itself.
 */
export interface FeedbackIntentModelPort {
  classify(
    request: FeedbackIntentModelRequest
  ): Promise<Result<FeedbackIntentModelReply | null, ErrorEnvelope>>;
}

export interface FeedbackIntentClassifierOptions {
  readonly model: FeedbackIntentModelPort;
  readonly sources: Pick<SourceRefPort, "resolve">;
  /** Prompts above this size are not classified; default 64 KiB. */
  readonly max_content_bytes?: number;
}

const DEFAULT_MAX_CLASSIFY_BYTES = 64 * 1024;

function invalidClassifierReply(
  rule: "kind" | "confidence"
): Result<FeedbackIntent | null, ErrorEnvelope> {
  return {
    ok: false,
    status: "rejected",
    error: makeErrorEnvelope({
      code: "E_SCHEMA",
      category: "schema",
      message_key: "error.e_schema",
      stage: "feedback_classify",
      details: { kind: "field", path: "feedback_intent", rule }
    })
  };
}

/**
 * Real public entry for `input.received` classification.
 *
 * Reads the immutable prompt bytes through the source port, hands the decoded
 * text to the injected model, and validates the reply against `FEEDBACK_KINDS`
 * and a numeric `[0, 1]` confidence. Unretrievable, empty, oversized or
 * non-decoding content returns `ok(null)` — the intake then reports
 * `skipped:unclassified`; it never guesses from a filename or a hint.
 */
export function createFeedbackIntentClassifier(
  options: FeedbackIntentClassifierOptions
): FeedbackIntentClassifier {
  const maxBytes = options.max_content_bytes ?? DEFAULT_MAX_CLASSIFY_BYTES;
  return {
    async classify(input) {
      const resolved = await options.sources.resolve(input.content_ref);
      if (!resolved.ok) return resolved;
      if (!resolved.value.retrievable || resolved.value.bytes === null) return unclassified();
      if (resolved.value.bytes.byteLength === 0) return unclassified();
      if (resolved.value.bytes.byteLength > maxBytes) return unclassified();
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(resolved.value.bytes);
      } catch {
        return unclassified();
      }
      if (content.trim().length === 0) return unclassified();
      const reply = await options.model.classify({
        event_id: input.event_id,
        content,
        candidate_kinds: FEEDBACK_KINDS
      });
      if (!reply.ok) return reply;
      if (reply.value === null || reply.value.kind === null) return unclassified();
      if (!FEEDBACK_KINDS.includes(reply.value.kind)) {
        return invalidClassifierReply("kind");
      }
      const confidence = reply.value.confidence;
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return invalidClassifierReply("confidence");
      }
      return {
        ok: true,
        status: "ok",
        value: {
          kind: reply.value.kind,
          confidence,
          target_issue_id: reply.value.target_issue_id ?? null
        }
      };
    }
  };
}
