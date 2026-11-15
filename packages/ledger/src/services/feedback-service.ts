import { canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, VersionBinding } from "@evoplug/core";
import type { FeedbackDraft, FeedbackRecord } from "../domain/feedback.js";
import type { Origin } from "../domain/common.js";
import type { FeedbackPlan } from "../feedback/record.js";
import type { LedgerPorts, LedgerSourceEvent } from "../ports.js";
import type { FeedbackStateRow } from "../rows.js";
import { buildFeedbackRecord } from "../feedback/record.js";
import { ledgerFailure, ledgerOk } from "../errors.js";
import { feedbackRowJson } from "../rows.js";
import { sha256Utf8 } from "../raw-hash.js";
import { commitStateRows, stateRowWrite } from "./commit.js";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Deterministic feedback identifier.
 *
 * The idempotency key is `(source_event_id, kind, target_issue_id)`. Deriving
 * the id from that key means a crash-and-replay cannot insert a second row for
 * the same observation even before the unique index lands: the second insert
 * collides on the primary key, and the retry path re-reads the existing row.
 *
 * The ULID body keeps the 26-character Crockford Base32 shape the `Id`
 * contract requires; the leading time bits are not meaningful here because the
 * value is content-addressed, not allocated from a clock.
 */
export function feedbackIdempotencyKey(input: {
  readonly source_event_id: Id<"ev">;
  readonly kind: FeedbackDraft["kind"];
  readonly target_issue_id: Id<"issue"> | null;
}): string {
  return canonicalJsonText({
    source_event_id: input.source_event_id,
    kind: input.kind,
    target_issue_id: input.target_issue_id,
  });
}

export function deterministicFeedbackId(key: string): Id<"fb"> {
  const hex = sha256Utf8(key).slice("sha256:".length);
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    body += CROCKFORD_ALPHABET.charAt(Number.parseInt(hex.charAt(index), 16));
  }
  return `fb:${body}` as Id<"fb">;
}

export interface FeedbackRecordOptions {
  /**
   * Pre-allocated id from the caller's typed quote construction. When absent
   * the deterministic id of the idempotency key is used, never a fresh
   * timestamp id, so a retry always targets the same row.
   */
  readonly feedback_id?: Id<"fb">;
}

export interface FeedbackRecordOutcome {
  readonly plan: FeedbackPlan;
  /** True when the same `(source_event_id, kind, target_issue_id)` existed. */
  readonly duplicate: boolean;
}

function sourceMissing<T>(eventId: Id<"ev">): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_REQUIREMENT_SOURCE",
    category: "source",
    details: {
      kind: "source",
      source_ref: "journal://" + eventId + "#bytes=0-1",
      reason: "missing",
    },
    stage: "ledger_write",
  });
}

function originNotHuman<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_EVENT_ORIGIN_UNVERIFIED",
    category: "authorization",
    details: { kind: "none" },
    stage: "event_origin",
  });
}

function planFromStateRow(
  row: FeedbackStateRow,
  origin: Origin,
  sourceEventWatermark: number,
): FeedbackPlan {
  const record: FeedbackRecord = {
    schema_version: "rsi.feedback/2",
    feedback_id: row.feedback_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    source_event_id: row.source_event_id,
    kind: row.kind,
    quote_ref: row.quote_ref,
    target_issue_id: row.target_issue_id,
    status: row.status,
    goal_version: row.goal_version,
    input_epoch: row.input_epoch,
    recorded_at: row.recorded_at,
  };
  return {
    record,
    row,
    ledger_row: {
      feedback_id: row.feedback_id,
      target_issue_id: row.target_issue_id,
      origin,
      signal_kind: row.kind,
      status: row.status,
      goal_version: row.goal_version,
      input_epoch: row.input_epoch,
      source_refs: [row.quote_ref],
      recorded_at: row.recorded_at,
      recorded_at_watermark: sourceEventWatermark,
    },
  };
}

/**
 * Feedback write path. Only a verified human source may enter the ledger; an
 * automatic or unattested event stays a candidate in `event_log` and is never
 * promoted here. The record keeps the source event and the quote; it never
 * creates a requirement op by itself.
 */
export class FeedbackService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  /** Deterministic id for the idempotency key; stable across retries. */
  static feedbackIdFor(input: {
    readonly source_event_id: Id<"ev">;
    readonly kind: FeedbackDraft["kind"];
    readonly target_issue_id: Id<"issue"> | null;
  }): Id<"fb"> {
    return deterministicFeedbackId(feedbackIdempotencyKey(input));
  }

  /** Compatibility entry: a duplicate returns the previously recorded plan. */
  async recordFeedback(draft: FeedbackDraft): Promise<Result<FeedbackPlan, ErrorEnvelope>> {
    const outcome = await this.recordFeedbackOnce(draft);
    if (!outcome.ok) return outcome;
    return ledgerOk(outcome.value.plan);
  }

  /**
   * Idempotent write. The origin is read from the committed source event and
   * verified through the HOST proof port; a caller can never claim `human`.
   */
  async recordFeedbackOnce(
    draft: FeedbackDraft,
    options: FeedbackRecordOptions = {},
  ): Promise<Result<FeedbackRecordOutcome, ErrorEnvelope>> {
    const event = await this.#ports.events.getEvent(draft.source_event_id);
    if (!event.ok) return event;
    if (event.value === null) return sourceMissing(draft.source_event_id);
    const sourceEvent = event.value;
    if (
      sourceEvent.task_id !== draft.task_id ||
      sourceEvent.branch_id !== draft.branch_id
    ) {
      return sourceMissing(draft.source_event_id);
    }
    if (sourceEvent.input_epoch === null) {
      return ledgerFailure<FeedbackRecordOutcome>({
        code: "E_VERSION_BINDING",
        category: "version",
        details: { kind: "none" },
        stage: "binding",
      });
    }
    if (!(await this.#verifiedHuman(sourceEvent))) {
      return originNotHuman();
    }

    const existing = await this.#findExisting(sourceEvent, draft);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return ledgerOk({
        plan: planFromStateRow(existing.value, sourceEvent.origin, sourceEvent.watermark),
        duplicate: true,
      });
    }

    const feedbackId =
      options.feedback_id ??
      FeedbackService.feedbackIdFor({
        source_event_id: draft.source_event_id,
        kind: draft.kind,
        target_issue_id: draft.target_issue_id,
      });
    const plan = buildFeedbackRecord(draft, {
      feedback_id: feedbackId,
      origin: sourceEvent.origin,
      recorded_at: this.#ports.clock.now(),
      source_event_watermark: sourceEvent.watermark,
    });
    if (!plan.ok) return plan;

    const binding: VersionBinding = {
      task_id: draft.task_id,
      branch_id: draft.branch_id,
      input_epoch: sourceEvent.input_epoch,
      goal_version: sourceEvent.goal_version,
      config_version: sourceEvent.config_version,
      watermark: sourceEvent.watermark,
    };
    const commit = await commitStateRows(this.#ports, binding, [
      stateRowWrite("rsi.feedback_row/1", "insert", feedbackRowJson(plan.value.row)),
    ]);
    if (!commit.ok) {
      // A concurrent writer may have won the same deterministic id; re-read
      // before reporting failure so a retry stays idempotent.
      const raced = await this.#findExisting(sourceEvent, draft);
      if (raced.ok && raced.value !== null) {
        return ledgerOk({
          plan: planFromStateRow(raced.value, sourceEvent.origin, sourceEvent.watermark),
          duplicate: true,
        });
      }
      return commit;
    }
    return ledgerOk({ plan: plan.value, duplicate: false });
  }

  /** True only for a `human` event whose attestation the HOST verifies. */
  async #verifiedHuman(sourceEvent: LedgerSourceEvent): Promise<boolean> {
    if (sourceEvent.origin !== "human") return false;
    if (sourceEvent.human_attestation === null) return false;
    if (sourceEvent.native_session_id === null) return false;
    try {
      const verdict = await this.#ports.proof.verifyHuman({
        attestation: sourceEvent.human_attestation,
        host_id: sourceEvent.host_id,
        config_space: sourceEvent.config_space,
        native_session_id: sourceEvent.native_session_id,
        event_key: sourceEvent.event_key,
      });
      return verdict === "verified";
    } catch {
      return false;
    }
  }

  async #findExisting(
    sourceEvent: LedgerSourceEvent,
    draft: FeedbackDraft,
  ): Promise<Result<FeedbackStateRow | null, ErrorEnvelope>> {
    const rows = await this.#ports.projection.listFeedbackRows({
      task_id: sourceEvent.task_id,
      branch_id: sourceEvent.branch_id,
      watermark: sourceEvent.watermark,
    });
    if (!rows.ok) return rows;
    const target = draft.target_issue_id;
    const match = rows.value.find(
      (row) =>
        row.source_event_id === draft.source_event_id &&
        row.kind === draft.kind &&
        (row.target_issue_id ?? null) === (target ?? null),
    );
    return ledgerOk(match ?? null);
  }
}
