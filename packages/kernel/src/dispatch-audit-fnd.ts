/**
 * Durable `DispatchAuditAppend` over the FND state-row ABI (W3).
 *
 * `enforce` must persist a skip decision before it stops dispatching, and the
 * record has to survive journal replay and recovery. This module stores the
 * complete `rsi.dispatch_audit/1` record as an `object_document` owned by
 * `evd`:
 *
 *   - the document is written through the FND live-gated commit port, so it
 *     joins the single frame, the journal fsync and the SQLite projection the
 *     rest of the evidence rows use;
 *   - the document id is the canonical ABI key over
 *     `(owner="evd", object_type="dispatch_audit", object_id=audit_id,
 *     revision=1)`, and `content_hash` is the canonical hash of the record;
 *   - replaying the same decision keeps the same `audit_id`, so the idempotent
 *     retry finds the existing document instead of writing a second one.
 *
 * Nothing here is a log line or an in-memory note: a reader can recover the
 * full binding, the plan, the decision kind and both shard lists from the
 * committed row.
 */

import type {
  ErrorEnvelope,
  LiveCommitOutcome,
  ObjectDocumentRow,
  ObjectHeadRow,
  Result,
  StateRowLiveCommitPort,
  VersionBinding
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  objectDocumentId,
  ok
} from "@evoplug/core";

import type { DispatchAuditAppend, DispatchAuditRecord } from "./dispatch-audit.js";
import { dispatchAuditRecord } from "./dispatch-audit.js";
import type { DispatchAuditInput } from "./online-pipeline.js";

export const DISPATCH_AUDIT_OWNER = "evd";
export const DISPATCH_AUDIT_OBJECT_TYPE = "dispatch_audit";
export const DISPATCH_AUDIT_REVISION = 1;

/** The live-gated FND commit member the append needs. */
export interface DispatchAuditLiveCommit {
  commitLiveGated: StateRowLiveCommitPort["commitLiveGated"];
}

function bindingOf(record: DispatchAuditRecord): VersionBinding {
  return record.binding;
}

/** Builds the `object_document` row for one audit record. */
export function dispatchAuditDocumentRow(
  record: DispatchAuditRecord
): ObjectDocumentRow {
  const binding = bindingOf(record);
  return {
    document_id: objectDocumentId({
      owner: DISPATCH_AUDIT_OWNER,
      object_type: DISPATCH_AUDIT_OBJECT_TYPE,
      object_id: record.audit_id,
      revision: DISPATCH_AUDIT_REVISION
    }),
    object_id: record.audit_id,
    owner: DISPATCH_AUDIT_OWNER,
    object_type: DISPATCH_AUDIT_OBJECT_TYPE,
    schema_version: record.schema_version,
    revision: DISPATCH_AUDIT_REVISION,
    state: "recorded",
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    content_hash: canonicalHash(record as never),
    canonical_json: canonicalJsonText(record as never),
    created_at: record.recorded_at
  };
}

/** Builds the `object_head` row for one audit record. */
export function dispatchAuditHeadRow(
  record: DispatchAuditRecord
): ObjectHeadRow {
  const document = dispatchAuditDocumentRow(record);
  return {
    object_id: document.object_id,
    owner: document.owner,
    object_type: document.object_type,
    revision: document.revision,
    document_id: document.document_id,
    state: document.state,
    content_hash: document.content_hash,
    row_version: 1,
    updated_at: record.recorded_at
  };
}

/**
 * Creates the durable append seam used by `DispatchPipelineOptions`.
 *
 * `live_commit` is the FND live-gated commit port (`createFndLiveCommitPort`).
 * The stage resolves the content-addressed document inside the writer gate, so
 * a replay returns `existing` without writing a second frame. The document is
 * self-contained: the canonical JSON lives in the row, `content_hash` is its
 * content address and all six binding fields are on the row itself.
 */
export function createFndDispatchAuditAppend(deps: {
  readonly live_commit: DispatchAuditLiveCommit;
  readonly now: () => number;
}): DispatchAuditAppend {
  return {
    async append(
      record: DispatchAuditRecord
    ): Promise<Result<{ readonly audit_id: string }, ErrorEnvelope>> {
      const document = dispatchAuditDocumentRow(record);
      const head = dispatchAuditHeadRow(record);
      const outcome: LiveCommitOutcome<{ readonly audit_id: string }> =
        await deps.live_commit.commitLiveGated({
          // The batch carries no typed row, so the ABI classifies it as global.
          // The document row is `row`-scoped: it carries all six binding fields
          // itself and is resolved by `(owner, object_type, object_id,
          // revision)` inside the gate.
          binding: null,
          stage(stage) {
            const existing = stage.resolveDocument({
              owner: DISPATCH_AUDIT_OWNER,
              object_type: DISPATCH_AUDIT_OBJECT_TYPE,
              object_id: record.audit_id,
              revision: DISPATCH_AUDIT_REVISION
            });
            if (!existing.ok) {
              return existing;
            }
            if (existing.value !== null) {
              return ok({ kind: "existing", value: { audit_id: record.audit_id } });
            }
            const stagedDocument = stage.stageDocuments([document]);
            if (!stagedDocument.ok) {
              return stagedDocument;
            }
            const stagedHead = stage.stageHeads([head]);
            if (!stagedHead.ok) {
              return stagedHead;
            }
            return ok({ kind: "commit", value: { audit_id: record.audit_id } });
          }
        });
      if (!outcome.ok) {
        return err(outcome.error);
      }
      return ok({ audit_id: record.audit_id });
    }
  };
}

/**
 * Creates a `DispatchAuditAppend` that builds the canonical record itself.
 *
 * The pipeline wraps an append seam with `createJournalDispatchAuditPort`,
 * which is convenient when the caller also holds the record fields. This
 * factory is for compositions that already have the FND port and want the
 * canonical record built and persisted in one call.
 */
export function createFndDispatchAuditRecorder(deps: {
  readonly live_commit: DispatchAuditLiveCommit;
  readonly now: () => number;
}): {
  record(
    input: DispatchAuditInput
  ): Promise<Result<{ readonly audit_id: string }, ErrorEnvelope>>;
} {
  const append = createFndDispatchAuditAppend(deps);
  return {
    record(input) {
      const record = dispatchAuditRecord(input, deps.now());
      return append.append(record);
    }
  };
}
