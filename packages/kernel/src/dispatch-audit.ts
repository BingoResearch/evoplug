/**
 * Durable producers for `DispatchAuditPort` (W3).
 *
 * `enforce` skips shards before any request is built, so the skip decision
 * must reach durable storage first. The online pipeline accepts the port
 * directly; this module supplies the two usable forms:
 *
 *   - `createJournalDispatchAuditPort({ append, now })` wraps any durable
 *     append seam (the journal/outbox writer the composition already has)
 *     with a canonical `rsi.dispatch_audit/1` record and a content-addressed
 *     `audit_id`;
 *   - `resolveDispatchAuditPort(options, now)` lets a composition that has an
 *     append seam but no pre-built port rely on `DispatchPipelineOptions`
 *     alone, so `enforce` is never permanently gated on a missing producer.
 *
 * The record names the complete `VersionBinding` and the full plan decision.
 * It never invents a shard, a fact or a question key.
 */

import type {
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  VersionBinding
} from "@evoplug/core";
import { canonicalHash, ok } from "@evoplug/core";
import type {
  JournalAppendResult,
  JournalFramePayload
} from "@evoplug/storage";
import { JOURNAL_EVENT_SCHEMA_VERSION } from "@evoplug/storage";

import type {
  DispatchAuditInput,
  DispatchAuditPort,
  DispatchPipelineOptions
} from "./online-pipeline.js";

export const DISPATCH_AUDIT_SCHEMA = "rsi.dispatch_audit/1";

export type DispatchAuditMode = DispatchAuditInput["mode"];

/**
 * Durable skip record.
 *
 * `audit_id` is content-addressed over the plan, binding, mode, decision and
 * both shard lists. A replay of the same decision under the same binding
 * therefore yields the same id and the append seam can deduplicate it.
 */
export interface DispatchAuditRecord {
  readonly schema_version: "rsi.dispatch_audit/1";
  readonly audit_id: Hash;
  readonly recorded_at: number;
  readonly mode: DispatchAuditMode;
  readonly binding: VersionBinding;
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly policy_version: string;
  readonly kind: DispatchAuditInput["decision"]["kind"];
  readonly decided_question_keys: readonly string[];
  readonly gap_question_keys: readonly string[];
  readonly semantic_question_keys: readonly string[];
  readonly fact_keys: readonly Hash[];
  readonly skipped_shard_keys: readonly string[];
  readonly dispatched_shard_keys: readonly string[];
  readonly reason_codes: readonly string[];
}

/**
 * Durable append seam. The composition supplies the real journal/outbox
 * writer; a failure is returned unchanged so `enforce` can fail closed.
 */
export interface DispatchAuditAppend {
  append(
    record: DispatchAuditRecord
  ): Promise<Result<{ readonly audit_id: string }, ErrorEnvelope>>;
}

/**
 * Minimal journal surface used by the foundation producer. `JournalWriter`
 * satisfies it directly; keeping the interface structural lets callers inject
 * a test journal without importing the writer class.
 */
export interface DispatchAuditJournal {
  append(
    payload: JournalFramePayload
  ): Result<JournalAppendResult, ErrorEnvelope>;
}

/** Journal event type written by `createFndDispatchAuditPort`. */
export const DISPATCH_AUDIT_EVENT_TYPE = "evd.dispatch_audit.recorded";

/** Builds the canonical record for one plan decision. */
export function dispatchAuditRecord(
  input: DispatchAuditInput,
  recordedAt: number
): DispatchAuditRecord {
  const decision = input.decision;
  const body = {
    schema_version: DISPATCH_AUDIT_SCHEMA as "rsi.dispatch_audit/1",
    mode: input.mode,
    binding: {
      task_id: input.binding.task_id,
      branch_id: input.binding.branch_id,
      input_epoch: input.binding.input_epoch,
      goal_version: input.binding.goal_version,
      config_version: input.binding.config_version,
      watermark: input.binding.watermark
    },
    plan_id: input.plan_id,
    plan_hash: decision.plan_hash,
    policy_version: decision.policy_version,
    kind: decision.kind,
    decided_question_keys: [...decision.decided_question_keys].sort(),
    gap_question_keys: [...decision.gap_question_keys].sort(),
    semantic_question_keys: [...decision.semantic_question_keys].sort(),
    fact_keys: [...decision.fact_keys].sort(),
    skipped_shard_keys: [...input.skipped_shard_keys].sort(),
    dispatched_shard_keys: [...input.dispatched_shard_keys].sort(),
    reason_codes: [...decision.reason_codes].sort()
  };
  return {
    ...body,
    audit_id: canonicalHash(body as never),
    recorded_at: recordedAt
  };
}

/**
 * Port over an injected durable append. `now` is the wall clock for
 * `recorded_at`; the audit id excludes it so an idempotent retry of the same
 * decision maps to the same id.
 */
export function createJournalDispatchAuditPort(deps: {
  readonly append: DispatchAuditAppend;
  readonly now: () => number;
}): DispatchAuditPort {
  return {
    async record(input) {
      const record = dispatchAuditRecord(input, deps.now());
      const appended = await deps.append.append(record);
      if (!appended.ok) {
        return appended;
      }
      return ok({ audit_id: appended.value.audit_id });
    }
  };
}

/**
 * Producer over the foundation journal.
 *
 * The online pipeline runs before any request exists, so `enforce` needs a
 * durable append that does not depend on the EVD row tables. The shared FND
 * journal writer is exactly that primitive: `bootstrap` already opens it and
 * hands the same writer to the EVD composition, so an audit frame lands in
 * the same durable log as the rest of the event.
 *
 * Replay ignores unknown event types, so the frame is append-only evidence,
 * not a new table. `audit_id` is content-addressed; the frame itself is a
 * `rsi.journal_event/1` body with the canonical record nested under `record`,
 * which keeps every future reader able to parse it without schema work.
 */
export function createFndDispatchAuditPort(deps: {
  readonly journal: DispatchAuditJournal;
  readonly now: () => number;
}): DispatchAuditPort {
  return {
    async record(input) {
      const record = dispatchAuditRecord(input, deps.now());
      const event = {
        schema_version: "rsi.ledger_event/1",
        event_type: DISPATCH_AUDIT_EVENT_TYPE,
        entity_type: "dispatch_audit",
        entity_id: record.audit_id,
        record
      } as unknown as JsonValue;
      const payload: JournalFramePayload = {
        schema_version: JOURNAL_EVENT_SCHEMA_VERSION,
        event,
        event_hash: canonicalHash(event),
        blob_hashes: []
      };
      const appended = deps.journal.append(payload);
      if (!appended.ok) {
        return appended;
      }
      return ok({ audit_id: record.audit_id });
    }
  };
}

/**
 * Resolves the effective audit port.
 *
 * A directly injected port wins, then the foundation journal producer, then a
 * generic append seam. The journal is the form bootstrap already has; the
 * append seam stays for compositions whose durable writer is not a
 * `JournalWriter`. `undefined` means the caller supplied none and `enforce`
 * must fail closed.
 */
export function resolveDispatchAuditPort(
  options: DispatchPipelineOptions | undefined,
  now: () => number
): DispatchAuditPort | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (options.audit !== undefined) {
    return options.audit;
  }
  if (options.journal !== undefined) {
    return createFndDispatchAuditPort({ journal: options.journal, now });
  }
  if (options.journal_append !== undefined) {
    return createJournalDispatchAuditPort({ append: options.journal_append, now });
  }
  return undefined;
}
