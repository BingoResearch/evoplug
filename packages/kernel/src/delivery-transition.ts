/**
 * Journal-first delivery transition writer (DD-FND-092, W5).
 *
 * Both the outbox worker (`delivery.expire`, host ACK) and the input-epoch
 * invalidator must project a `delivery` transition and its history row through
 * the same ledger frame. This module owns that write so the two paths cannot
 * drift.
 *
 * Order is journal frame (fsynced) then one SQLite transaction that inserts
 * `ledger_event_log`, updates `delivery` by `row_version` CAS and appends
 * `delivery_history`. Without a committer the projection still runs in one
 * local transaction; production always supplies the shared journal.
 */

import { canonicalHash, canonicalJsonText, newId } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Id,
  JsonValue,
  Result,
  Tx,
  VersionBinding
} from "@evoplug/core";
import { deriveDeliveryHistory, type DeliveryRecord, type DeliveryUpdateOutcome } from "@evoplug/delivery";
import {
  createTransactionRunner,
  isErrorEnvelope,
  type JournalAppendResult,
  type JournalCommitter,
  type JournalFramePayload,
  type SqliteConnection
} from "@evoplug/storage";

import { internalError } from "./errors.js";
import { bindingJson, bindingOf, deliveryRowJson, readDeliveryRecord } from "./delivery-row.js";

const STALE_TRANSITION_INCIDENT = "kernel.delivery_transition_stale";

/** True when the row changed after the caller selected it and before append. */
export function isDeliveryTransitionStale(error: ErrorEnvelope): boolean {
  return (
    error.details.kind === "internal" &&
    error.details.incident_id === STALE_TRANSITION_INCIDENT
  );
}

interface DeliveryTransitionWriterDeps {
  readonly connection: SqliteConnection;
  /** Supplied by production composition; absence keeps a local transaction. */
  readonly journal?: JournalCommitter;
  readonly now?: () => number;
}

export interface DeliveryTransitionWriter {
  commit(
    before: DeliveryRecord,
    outcome: DeliveryUpdateOutcome
  ): Promise<Result<void, ErrorEnvelope>>;
}

interface LedgerEventLogInput {
  readonly receipt: JournalAppendResult;
  readonly event_id: string;
  readonly event_key: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation: "insert" | "update" | "transition";
  readonly binding: VersionBinding | null;
  readonly before_hash: string | null;
  readonly after_hash: string;
  readonly row_schema: string;
  readonly row_json: string;
  readonly recorded_at: number;
}

function insertLedgerEventLog(tx: Tx, input: LedgerEventLogInput): void {
  const binding = input.binding;
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, :binding_mode, :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: input.event_id,
    event_key: input.event_key,
    commit_seq: input.receipt.first_commit_seq,
    journal_id: input.receipt.journal_id,
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    binding_mode: binding === null ? "global" : "bound",
    task_id: binding?.task_id ?? null,
    branch_id: binding?.branch_id ?? null,
    input_epoch: binding?.input_epoch ?? null,
    goal_version: binding?.goal_version ?? null,
    config_version: binding?.config_version ?? null,
    watermark: binding?.watermark ?? null,
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    row_schema: input.row_schema,
    row_json: input.row_json,
    payload_hash: input.after_hash,
    recorded_at: input.recorded_at
  });
}

export function createDeliveryTransitionWriter(
  deps: DeliveryTransitionWriterDeps
): DeliveryTransitionWriter {
  const { connection } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const journal = deps.journal;
  const runner = createTransactionRunner(connection);

  function project(
    tx: Tx,
    before: DeliveryRecord,
    outcome: DeliveryUpdateOutcome,
    eventId: Id<"ev">
  ): void {
    const noteCode = outcome.note_code;
    if (noteCode === null) {
      return;
    }
    const updated = tx.prepare(
      `UPDATE delivery SET
         state=:state, inclusion_evidence=:inclusion_evidence,
         transport_body_verified=:transport_body_verified, submission_ref=:submission_ref,
         inclusion_ref=:inclusion_ref, adoption=:adoption, adoption_ref=:adoption_ref,
         terminal_reason=:terminal_reason, row_version=:row_version, updated_at=:updated_at
       WHERE delivery_id=:delivery_id AND row_version=:expected_row_version`
    ).run({
      delivery_id: outcome.record.delivery_id,
      expected_row_version: before.row_version,
      state: outcome.record.state,
      inclusion_evidence: outcome.record.inclusion_evidence,
      transport_body_verified: outcome.record.transport_body_verified ? 1 : 0,
      submission_ref: outcome.record.submission_ref,
      inclusion_ref: outcome.record.inclusion_ref,
      adoption: outcome.record.adoption,
      adoption_ref: outcome.record.adoption_ref,
      terminal_reason: outcome.record.terminal_reason,
      row_version: outcome.record.row_version,
      updated_at: outcome.record.updated_at
    });
    if (updated.changes !== 1) {
      throw internalError("kernel.delivery_transition_cas_failed");
    }
    const history = deriveDeliveryHistory(
      outcome.record,
      eventId,
      noteCode,
      outcome.record.updated_at,
      outcome.evidence_ref
    );
    tx.prepare(
      `INSERT INTO delivery_history (
         delivery_id, event_id, at, state, inclusion_evidence, adoption,
         evidence_ref, terminal_reason, note_code
       ) SELECT
         :delivery_id, :event_id, :at, :state, :inclusion_evidence, :adoption,
         :evidence_ref, :terminal_reason, :note_code
       WHERE NOT EXISTS (
         SELECT 1 FROM delivery_history WHERE delivery_id = :delivery_id AND event_id = :event_id
       )`
    ).run({
      delivery_id: history.delivery_id,
      event_id: history.event_id,
      at: history.at,
      state: history.state,
      inclusion_evidence: history.inclusion_evidence,
      adoption: history.adoption,
      evidence_ref: history.evidence_ref,
      terminal_reason: history.terminal_reason,
      note_code: history.note_code
    });
  }

  return {
    async commit(
      before: DeliveryRecord,
      outcome: DeliveryUpdateOutcome
    ): Promise<Result<void, ErrorEnvelope>> {
      if (!outcome.changed || outcome.note_code === null) {
        return { ok: true, status: "ok", value: undefined };
      }
      // Recheck the CAS before the journal append. Another writer may have
      // moved the row after the caller selected it; appending first would
      // leave a durable frame that can never project and would latch the
      // invalidator into unknown-recovery.
      const current = readDeliveryRecord(connection, before.delivery_id);
      if (current === null || current.row_version !== before.row_version) {
        return {
          ok: false,
          status: "conflict",
          error: internalError(STALE_TRANSITION_INCIDENT)
        };
      }
      const row = deliveryRowJson(outcome.record);
      const rowJson = canonicalJsonText(row);
      const afterHash = canonicalHash({ row_schema: "rsi.delivery_row/1", row_json: rowJson });
      const beforeHash = canonicalHash({
        row_schema: "rsi.delivery_row/1",
        row_json: canonicalJsonText(deliveryRowJson(before))
      });
      const eventId = newId("ev", now());
      const history = deriveDeliveryHistory(
        outcome.record,
        eventId,
        outcome.note_code,
        outcome.record.updated_at,
        outcome.evidence_ref
      );
      // The frozen history row lets journal-only recovery rebuild
      // `delivery_history` without re-running the transition or guessing a
      // note code from the final delivery row.
      const historyJson: JsonValue = {
        at: history.at,
        state: history.state,
        inclusion_evidence: history.inclusion_evidence,
        adoption: history.adoption,
        evidence_ref: history.evidence_ref,
        terminal_reason: history.terminal_reason,
        note_code: history.note_code
      };
      const eventKey = canonicalHash({
        event_type: "delivery.recorded",
        entity_type: "delivery",
        entity_id: before.delivery_id,
        operation: "transition",
        before_hash: beforeHash,
        after_hash: afterHash,
        binding: bindingJson(bindingOf(before))
      });
      if (journal === undefined) {
        try {
          runner.withTxSync((tx) => {
            execProjection(tx, before, outcome, eventId);
            return null;
          });
          return { ok: true, status: "ok", value: undefined };
        } catch (error) {
          if (isErrorEnvelope(error)) {
            return { ok: false, status: "rejected", error };
          }
          return {
            ok: false,
            status: "rejected",
            error: internalError("kernel.delivery_transition_projection_failed")
          };
        }
      }
      const event: JsonValue = {
        schema_version: "rsi.ledger_event/1",
        event_id: eventId,
        event_key: eventKey,
        event_type: "delivery.recorded",
        entity_type: "delivery",
        entity_id: before.delivery_id,
        operation: "transition",
        binding: bindingJson(bindingOf(before)),
        before_hash: beforeHash,
        after_hash: afterHash,
        row_schema: "rsi.delivery_row/1",
        row_json: rowJson,
        history: historyJson,
        payload_hash: afterHash,
        recorded_at: now()
      };
      const payload: JournalFramePayload = {
        schema_version: "rsi.journal_event/1",
        event,
        event_hash: canonicalHash(event),
        blob_hashes: []
      };
      const outcomeResult = await journal.commit(
        payload,
        (tx, receipt) => {
          insertLedgerEventLog(tx, {
            receipt,
            event_id: eventId,
            event_key: eventKey,
            event_type: "delivery.recorded",
            entity_type: "delivery",
            entity_id: before.delivery_id,
            operation: "transition",
            binding: bindingOf(before),
            before_hash: beforeHash,
            after_hash: afterHash,
            row_schema: "rsi.delivery_row/1",
            row_json: rowJson,
            recorded_at: now()
          });
          execProjection(tx, before, outcome, eventId);
          return null;
        },
        { enospc_code: "E_STORAGE_DELIVERY_ENOSPC" }
      );
      if (!outcomeResult.ok) {
        return {
          ok: false,
          status: outcomeResult.commit_state === "unknown_recovery_required" ? "unknown" : "rejected",
          error: outcomeResult.error
        };
      }
      return { ok: true, status: "ok", value: undefined };
    }
  };

  function execProjection(
    tx: Tx,
    before: DeliveryRecord,
    outcome: DeliveryUpdateOutcome,
    eventId: Id<"ev">
  ): void {
    project(tx, before, outcome, eventId);
  }
}
