/**
 * Trigger admission handoff (DD-TRG-003, DD-HOST-001).
 *
 * HOST freezes the TriggerEvent draft and the ReviewEnqueueRequest, calls REV
 * `prepareEnqueue` outside the transaction, then calls FND `commitLiveGated`
 * exactly once. The synchronous stage registers the Trigger root, real pending
 * changes, REV rows (inside REV) and the review outbox input.
 *
 * The FND/REV stage types are structural mirrors because HOST must not import
 * the REV implementation; their owners are DD-FND-059.1 and DD-TRG-003.
 */

import type { ErrorCode, ErrorEnvelope } from "../../errors.js";
import { makeErrorEnvelope } from "../../errors.js";
import type { Hash } from "../../hash.js";
import { canonicalJsonText } from "../../canonical.js";
import type { Result } from "../../result.js";
import { err, ok } from "../../result.js";
import type { VersionBinding } from "../../version-binding.js";
import type {
  PendingEntry,
  PrepareReviewEnqueueInput,
  PreparedReviewEnqueue,
  ReviewEnqueueRequest,
  ReviewEnqueueResult,
  TriggerAdmissionReceipt,
  TriggerEvent
} from "../types.js";
import {
  buildObjectDocument,
  buildObjectHead,
  toPendingEntryPhysicalRow,
  toTriggerEventPhysicalRow,
  triggerEventDocumentJson,
  pendingDocumentJson,
  type HostObjectDocumentRow,
  type HostObjectHeadRow,
  type HostStateRowInsertion,
  type LiveCommitReceipt,
  type LiveCommitState,
  type PendingEntryPhysicalRow,
  type TriggerEventPhysicalRow
} from "../persistence.js";

export const HOST_REVIEW_OUTBOX_PRIORITY = 5;

export const HOST_REVIEW_OUTBOX_MAX_ATTEMPTS = 5;

/** Structural `OutboxEnqueueInput` from DD-FND-059.1. */
export interface OutboxEnqueueInput {
  effect_kind: "review.enqueue";
  effect_key: string;
  payload: import("../../json.js").JsonValue;
  priority: 5;
  max_attempts: 5;
}

/** Structural `LiveCommitStage` from DD-FND-059.1. */
export interface LiveCommitStage {
  resolveStateRow(input: { row_schema: string; key: unknown }): unknown;
  resolveDocument(input: {
    owner: string;
    object_type: string;
    object_id: string;
    revision: number;
  }): unknown;
  resolveHead(input: { object_id: string }): unknown;
  stageRows(rows: readonly HostStateRowInsertion[]): void;
  stageDocuments(documents: readonly HostObjectDocumentRow[]): void;
  stageHeads(heads: readonly HostObjectHeadRow[]): void;
  stageOutbox(input: OutboxEnqueueInput): void;
}

export type LiveCommitDecision<Value> =
  | { kind: "commit"; value: Value }
  | { kind: "existing"; value: Value };

export type TriggerLiveCommitOutcome<Value> =
  | {
      ok: true;
      commit_state: "committed" | "existing";
      receipt?: LiveCommitReceipt;
      value: Value;
    }
  | { ok: false; commit_state: "not_written" | "unknown_recovery_required"; error: ErrorEnvelope };

export interface StateRowLiveCommitPort {
  commitLiveGated<Value>(input: {
    binding: VersionBinding;
    stage: (stage: LiveCommitStage) => Result<LiveCommitDecision<Value>, ErrorEnvelope>;
  }): Promise<TriggerLiveCommitOutcome<Value>>;
}

/** REV-owned scheduler surface; HOST only passes opaque values back. */
export interface ReviewSchedulerPort {
  prepareEnqueue(input: PrepareReviewEnqueueInput): Promise<PreparedReviewEnqueue>;
  enqueueInTransaction(
    stage: LiveCommitStage,
    req: ReviewEnqueueRequest,
    prepared: PreparedReviewEnqueue
  ): ReviewEnqueueResult;
}

export interface PendingChange {
  entry: PendingEntry;
  /** `watermark` binding coordinate used by the pending transition. */
  watermark: number;
  /** Physical revision; 1 for a new insert, incremented on transition. */
  row_version?: number;
  /** True when this is a new insert; false for a transition. */
  insert: boolean;
}

export interface TriggerAdmissionDeps {
  review: ReviewSchedulerPort;
  commit: StateRowLiveCommitPort;
}

export interface TriggerAdmissionInput {
  trigger: TriggerEvent;
  req: ReviewEnqueueRequest;
  binding: VersionBinding;
  pending: readonly PendingChange[];
}

function admissionError(code: ErrorCode, stage: string, path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: code === "E_IDEMPOTENCY_CONFLICT" ? "conflict" : "schema",
    message_key: `error.${code.toLowerCase()}`,
    stage,
    details: { kind: "field", path, rule }
  });
}

function documentJsonFromStage(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const canonical = record["canonical_json"];
  return typeof canonical === "string" ? canonical : null;
}

/**
 * Performs one admission. The caller must pass a fully frozen `decision="enqueue"`
 * TriggerEvent and the matching request; neither object may change afterwards.
 */
export async function admitTrigger(
  input: TriggerAdmissionInput,
  deps: TriggerAdmissionDeps
): Promise<Result<TriggerAdmissionReceipt, ErrorEnvelope>> {
  if (input.trigger.decision !== "enqueue") {
    return err(admissionError("E_SCHEMA", "trigger_admission", "trigger.decision", "enqueue"));
  }
  if (
    input.trigger.trigger_event_id !== input.req.trigger_event_id ||
    input.trigger.dedupe.trigger_dedupe_key !== input.req.trigger_dedupe_key ||
    input.trigger.review_scope_key !== input.req.review_scope_key ||
    input.trigger.dedupe.boundary_key !== input.req.boundary_key ||
    input.trigger.dedupe.signal_digest !== input.req.signal_digest
  ) {
    return err(admissionError("E_SCHEMA", "trigger_admission", "trigger", "request_binding"));
  }
  let prepared: PreparedReviewEnqueue;
  try {
    prepared = await deps.review.prepareEnqueue({
      schema_version: "rsi.prepare_review_enqueue_in/1",
      req: input.req,
      trigger: input.trigger
    });
  } catch {
    return err(admissionError("E_INTERNAL", "trigger_admission", "prepare", "unexpected_rejection"));
  }

  const triggerDocument = triggerEventDocumentJson(input.trigger);
  const triggerCanonical = canonicalJsonText(triggerDocument);
  const triggerPhysical = toTriggerEventPhysicalRow(input.trigger);
  const triggerDocumentRow = buildObjectDocument({
    owner: "host",
    object_type: "trigger_event",
    object_id: input.trigger.trigger_event_id,
    revision: 1,
    schema_version: "rsi.trigger_event/1",
    document: triggerDocument,
    binding: input.binding,
    createdAt: input.trigger.decided_at
  });
  const triggerHead = buildObjectHead({
    owner: "host",
    object_type: "trigger_event",
    object_id: input.trigger.trigger_event_id,
    revision: 1,
    document: triggerDocument
  });

  const pendingMembers: Array<{
    row: PendingEntryPhysicalRow;
    document: HostObjectDocumentRow;
    head: HostObjectHeadRow;
  }> = [];
  for (const change of input.pending) {
    const row = toPendingEntryPhysicalRow(change.entry, change.watermark, change.row_version ?? 1);
    const documentJson = pendingDocumentJson(change.entry);
    pendingMembers.push({
      row,
      document: buildObjectDocument({
        owner: "host",
        object_type: "pending_entry",
        object_id: change.entry.pending_id,
        revision: row.row_version,
        schema_version: "rsi.pending/1",
        document: documentJson,
        binding: input.binding,
        createdAt: change.entry.updated_at
      }),
      head: buildObjectHead({
        owner: "host",
        object_type: "pending_entry",
        object_id: change.entry.pending_id,
        revision: row.row_version,
        document: documentJson
      })
    });
  }

  let outcome: TriggerLiveCommitOutcome<{
    trigger_event_id: TriggerEvent["trigger_event_id"];
    review: ReviewEnqueueResult | null;
  }>;
  try {
    outcome = await deps.commit.commitLiveGated({
      binding: input.binding,
      stage: (stage) => {
        const existingDocument = stage.resolveDocument({
          owner: "host",
          object_type: "trigger_event",
          object_id: input.trigger.trigger_event_id,
          revision: 1
        });
        const existingHead = stage.resolveHead({ object_id: input.trigger.trigger_event_id });
        const rootExists = existingDocument !== null && existingDocument !== undefined;
        if (rootExists) {
          const stored = documentJsonFromStage(existingDocument);
          if (stored === null || stored !== triggerCanonical) {
            return err(admissionError(
              "E_IDEMPOTENCY_CONFLICT",
              "trigger_admission",
              "trigger_event",
              "frozen_root_bytes"
            ));
          }
          if (existingHead === null || existingHead === undefined) {
            return err(admissionError(
              "E_IDEMPOTENCY_CONFLICT",
              "trigger_admission",
              "trigger_event",
              "head_missing"
            ));
          }
        } else {
          stage.stageRows([
            {
              row_schema: "rsi.trigger_event_row/1",
              operation: "insert",
              row: triggerPhysical,
              document_id: triggerDocumentRow.document_id
            }
          ]);
          stage.stageDocuments([triggerDocumentRow]);
          stage.stageHeads([triggerHead]);
        }

        for (const member of pendingMembers) {
          stage.stageRows([
            {
              row_schema: "rsi.pending_entry_row/1",
              operation: "insert",
              row: member.row,
              document_id: member.document.document_id
            }
          ]);
          stage.stageDocuments([member.document]);
          stage.stageHeads([member.head]);
        }

        const review = deps.review.enqueueInTransaction(stage, input.req, prepared);
        if (review.disposition === "created") {
          if (review.review_job_id === undefined) {
            return err(admissionError("E_INTERNAL", "trigger_admission", "review_job_id", "missing"));
          }
          const effectKey = `review.enqueue:${review.review_job_id}`;
          stage.stageOutbox({
            effect_kind: "review.enqueue",
            effect_key: effectKey,
            payload: {
              schema_version: "rsi.review_enqueue_effect/1",
              job_id: review.review_job_id,
              request_id: input.req.request_id,
              trigger_event_id: input.trigger.trigger_event_id,
              trigger_dedupe_key: input.req.trigger_dedupe_key,
              binding: {
                task_id: input.binding.task_id,
                branch_id: input.binding.branch_id,
                input_epoch: input.binding.input_epoch,
                goal_version: input.binding.goal_version,
                config_version: input.binding.config_version,
                watermark: input.binding.watermark
              },
              created_at: input.trigger.decided_at
            },
            priority: HOST_REVIEW_OUTBOX_PRIORITY,
            max_attempts: HOST_REVIEW_OUTBOX_MAX_ATTEMPTS
          });
        }

        const value = {
          trigger_event_id: input.trigger.trigger_event_id,
          review
        };
        if (rootExists) {
          if (review.disposition === "created") {
            return err(admissionError(
              "E_IDEMPOTENCY_CONFLICT",
              "trigger_admission",
              "review.disposition",
              "created_on_existing_root"
            ));
          }
          if (pendingMembers.length > 0) {
            return err(admissionError(
              "E_IDEMPOTENCY_CONFLICT",
              "trigger_admission",
              "pending",
              "members_on_existing_root"
            ));
          }
          return ok({ kind: "existing", value });
        }
        return ok({ kind: "commit", value });
      }
    });
  } catch {
    return err(admissionError("E_INTERNAL", "trigger_admission", "stage", "unexpected_rejection"));
  }

  if (!outcome.ok) {
    return err(outcome.error);
  }
  if (outcome.commit_state === "existing") {
    return ok({
      schema_version: "rsi.trigger_admission_receipt/1",
      trigger_event_id: input.trigger.trigger_event_id,
      outcome: "existing",
      review: outcome.value.review,
      commit: null
    });
  }
  if (outcome.receipt === undefined) {
    return err(admissionError("E_INTERNAL", "trigger_admission", "receipt", "missing"));
  }
  return ok({
    schema_version: "rsi.trigger_admission_receipt/1",
    trigger_event_id: input.trigger.trigger_event_id,
    outcome: "committed",
    review: outcome.value.review,
    commit: {
      batch_hash: outcome.receipt.batch_hash,
      first_commit_seq: outcome.receipt.first_commit_seq,
      last_commit_seq: outcome.receipt.last_commit_seq
    }
  });
}

/** Exported for callers that only need the outbox constants. */
export type { Hash, LiveCommitState };
