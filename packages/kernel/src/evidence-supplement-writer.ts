/**
 * Journal-backed writer for W4 supplement records (add_task.md W4, §7).
 *
 * Two rows share one journal frame:
 *
 *   - `rsi.evidence_supplement_record/1` binds the original evidence pack,
 *     the answer aggregate, every round, the read manifest, the pruning
 *     reasons and the final deterministic decision;
 *   - `rsi.workspace_read_record/1` records one admitted workspace action.
 *     It carries `root_id` + `path_rel` only. The approved absolute root, the
 *     file bytes and every excerpt stay in the caller's memory and never
 *     enter a row, a hash or a journal frame.
 *
 * The writer never touches SQLite directly. It stages the rows through the
 * FND `StateRowLiveCommitPort`, so the frame is fsynced and projected by the
 * single journal writer exactly like every other state row. The physical row
 * registration is owned by the unified schema track; until it lands, the
 * commit port rejects the row with `E_STATE_ROW_SCHEMA`, and the caller must
 * treat the supplement as unwritten rather than fall back to an unlogged
 * insert.
 */

import type {
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  StateRowLiveCommitPort,
  StateRowPort,
  StateRowSchema,
  StateRowTypeMap,
  VersionBinding
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  isHash,
  isVersionBinding,
  makeErrorEnvelope,
  ok,
  toJsonValue
} from "@evoplug/core";

import type {
  SupplementDispatchDecision,
  SupplementQuestionDecision
} from "./evidence-supplement.js";

/** Registered by the unified schema track (see W4-schema-request.json). */
export const EVIDENCE_SUPPLEMENT_ROW_SCHEMA = "rsi.evidence_supplement_record/1";
export const WORKSPACE_READ_ROW_SCHEMA = "rsi.workspace_read_record/1";

export type EvidenceSupplementOutcomeStatus = "resolved" | "insufficient" | "disabled";

export type SupplementReadStatus =
  | "ok"
  | "denied"
  | "too_large"
  | "not_found"
  | "changed"
  | "unsupported"
  | "binary";

export interface EvidenceSupplementReadRecord {
  readonly action: "list" | "read" | "stat" | "attachment";
  readonly root_id: string | null;
  readonly path_rel: string | null;
  readonly source_ref: string | null;
  readonly status: SupplementReadStatus;
  readonly reason_code: string | null;
  readonly content_hash: Hash | null;
  readonly byte_length: number;
  readonly range_start: number | null;
  readonly range_end: number | null;
  readonly binary: 0 | 1;
}

export interface EvidenceSupplementPrunedRecord {
  readonly path_rel: string | null;
  readonly source_ref: string | null;
  readonly reason: string;
}

export interface EvidenceSupplementRound {
  readonly round: number;
  readonly strategies: readonly string[];
  readonly reads: readonly EvidenceSupplementReadRecord[];
  readonly pruned: readonly EvidenceSupplementPrunedRecord[];
  readonly decisions: readonly SupplementQuestionDecision[];
  readonly fact_keys: readonly Hash[];
}

/** Caller-built draft; the writer appends ids and hashes. */
export interface EvidenceSupplementDraft {
  readonly issue_id: string;
  readonly plan_id: string;
  readonly plan_hash: Hash;
  readonly pack_id: string;
  readonly pack_key: Hash;
  readonly pack_hash: Hash;
  readonly aggregate_id: string;
  readonly aggregate_hash: Hash;
  readonly gap_codes: readonly string[];
  readonly outcome: EvidenceSupplementOutcomeStatus;
  readonly budget_cap: boolean;
  readonly stop_reason: string;
  readonly decision: SupplementDispatchDecision | null;
  readonly rounds: readonly EvidenceSupplementRound[];
  readonly read_manifest: readonly EvidenceSupplementReadRecord[];
  readonly pruned: readonly EvidenceSupplementPrunedRecord[];
  readonly requires_repack: boolean;
}

export interface EvidenceSupplementRow {
  readonly schema_version: "rsi.evidence_supplement_record/1";
  readonly supplement_id: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly issue_id: string;
  readonly plan_id: string;
  readonly plan_hash: Hash;
  readonly pack_id: string;
  readonly pack_key: Hash;
  readonly pack_hash: Hash;
  readonly aggregate_id: string;
  readonly aggregate_hash: Hash;
  readonly rounds_json: string;
  readonly read_manifest_json: string;
  readonly pruned_json: string;
  readonly gap_codes_json: string;
  readonly decision_json: string;
  readonly outcome: EvidenceSupplementOutcomeStatus;
  readonly budget_cap: 0 | 1;
  readonly stop_reason: string;
  readonly requires_repack: 0 | 1;
  readonly record_hash: Hash;
  readonly created_at: number;
  readonly row_version: number;
}

export interface WorkspaceReadRow {
  readonly schema_version: "rsi.workspace_read_record/1";
  readonly read_id: string;
  readonly task_id: string;
  readonly branch_id: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly supplement_id: string;
  readonly action: "list" | "read" | "stat" | "attachment";
  readonly root_id: string;
  readonly path_rel: string;
  readonly path_hash: Hash;
  readonly content_hash: Hash | null;
  readonly byte_length: number;
  readonly range_start: number | null;
  readonly range_end: number | null;
  readonly binary: 0 | 1;
  readonly status: SupplementReadStatus;
  readonly reason_code: string | null;
  readonly observed_at: number;
  readonly row_version: number;
}

export interface EvidenceSupplementAppendResult {
  readonly supplement_id: string;
  readonly record_hash: Hash;
  readonly first_commit_seq: number;
  readonly last_commit_seq: number;
  /** Exact staged row, including canonical JSON columns. */
  readonly row: EvidenceSupplementRow;
}

export interface EvidenceSupplementWriterPort {
  append(input: {
    readonly binding: VersionBinding;
    readonly draft: EvidenceSupplementDraft;
  }): Promise<Result<EvidenceSupplementAppendResult, ErrorEnvelope>>;
}

export interface EvidenceSupplementWriterDeps {
  /** FND live commit port; the only write path. */
  readonly commit: Pick<StateRowLiveCommitPort, "commitLiveGated">;
  /** Wall clock for `created_at`/`observed_at`. */
  readonly now: () => number;
  /** Optional read-back port for tests and recovery diagnostics. */
  readonly reader?: Pick<StateRowPort, "getStateRow">;
}

export interface EvidenceSupplementWriter extends EvidenceSupplementWriterPort {
  read(
    supplementId: string,
    binding: VersionBinding
  ): Promise<Result<EvidenceSupplementRow | null, ErrorEnvelope>>;
}

function writerFailure(stage: string, operation: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STORAGE_IO",
    category: "storage",
    message_key: "error.storage.io",
    stage,
    details: { kind: "storage", operation },
    retryable: true,
    side_effect: "none"
  });
}

function schemaFailure(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "evidence_supplement_write",
    details: { kind: "field", path, rule },
    retryable: false,
    side_effect: "none"
  });
}

function isHexHash(value: string): value is Hash {
  return isHash(value);
}

function asJson(value: unknown): JsonValue {
  return toJsonValue(value, "$");
}

function hashId(prefix: "sup" | "wrd", preimage: JsonValue): string {
  return `${prefix}:${canonicalHash(preimage).slice("sha256:".length)}`;
}

function supplementIdFor(binding: VersionBinding, draft: EvidenceSupplementDraft): string {
  return hashId("sup", asJson({
    schema_version: EVIDENCE_SUPPLEMENT_ROW_SCHEMA,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    issue_id: draft.issue_id,
    plan_id: draft.plan_id,
    plan_hash: draft.plan_hash,
    pack_key: draft.pack_key,
    aggregate_hash: draft.aggregate_hash,
    gap_codes: [...draft.gap_codes],
    outcome: draft.outcome,
    decision: draft.decision
  }));
}

function workspaceReadRows(
  binding: VersionBinding,
  supplementId: string,
  observedAt: number,
  reads: readonly EvidenceSupplementReadRecord[]
): readonly WorkspaceReadRow[] {
  const rows: WorkspaceReadRow[] = [];
  let index = 0;
  for (const read of reads) {
    if (read.root_id === null || read.path_rel === null) {
      continue;
    }
    const pathHash = canonicalHash({
      schema_version: WORKSPACE_READ_ROW_SCHEMA,
      root_id: read.root_id,
      path_rel: read.path_rel
    });
    const readId = hashId("wrd", {
      schema_version: WORKSPACE_READ_ROW_SCHEMA,
      supplement_id: supplementId,
      index,
      root_id: read.root_id,
      path_rel: read.path_rel,
      action: read.action,
      range_start: read.range_start,
      range_end: read.range_end
    });
    rows.push({
      schema_version: WORKSPACE_READ_ROW_SCHEMA,
      read_id: readId,
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version,
      watermark: binding.watermark,
      supplement_id: supplementId,
      action: read.action,
      root_id: read.root_id,
      path_rel: read.path_rel,
      path_hash: pathHash,
      content_hash: read.content_hash,
      byte_length: read.byte_length,
      range_start: read.range_start,
      range_end: read.range_end,
      binary: read.binary,
      status: read.status,
      reason_code: read.reason_code,
      observed_at: observedAt,
      row_version: 1
    });
    index += 1;
  }
  return rows;
}

function buildSupplementRow(
  binding: VersionBinding,
  draft: EvidenceSupplementDraft,
  now: number
): EvidenceSupplementRow {
  const supplementId = supplementIdFor(binding, draft);
  const withoutHash = {
    schema_version: EVIDENCE_SUPPLEMENT_ROW_SCHEMA,
    supplement_id: supplementId,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    issue_id: draft.issue_id,
    plan_id: draft.plan_id,
    plan_hash: draft.plan_hash,
    pack_id: draft.pack_id,
    pack_key: draft.pack_key,
    pack_hash: draft.pack_hash,
    aggregate_id: draft.aggregate_id,
    aggregate_hash: draft.aggregate_hash,
    rounds_json: canonicalJsonText(asJson(draft.rounds)),
    read_manifest_json: canonicalJsonText(asJson(draft.read_manifest)),
    pruned_json: canonicalJsonText(asJson(draft.pruned)),
    gap_codes_json: canonicalJsonText(asJson([...draft.gap_codes])),
    decision_json: canonicalJsonText(asJson(draft.decision)),
    outcome: draft.outcome,
    budget_cap: (draft.budget_cap ? 1 : 0) as 0 | 1,
    stop_reason: draft.stop_reason,
    requires_repack: (draft.requires_repack ? 1 : 0) as 0 | 1,
    created_at: now,
    row_version: 1
  } as const;
  return {
    ...withoutHash,
    record_hash: canonicalHash(asJson(withoutHash))
  };
}

/** Builds the journal-backed supplement writer. */
export function createEvidenceSupplementWriter(
  deps: EvidenceSupplementWriterDeps
): EvidenceSupplementWriter {
  async function append(input: {
    readonly binding: VersionBinding;
    readonly draft: EvidenceSupplementDraft;
  }): Promise<Result<EvidenceSupplementAppendResult, ErrorEnvelope>> {
    if (!isVersionBinding(input.binding)) {
      return err(schemaFailure("binding", "six_fields"));
    }
    const draft = input.draft;
    if (
      draft.plan_hash === undefined ||
      !isHexHash(draft.plan_hash) ||
      !isHexHash(draft.pack_key) ||
      !isHexHash(draft.pack_hash) ||
      !isHexHash(draft.aggregate_hash)
    ) {
      return err(schemaFailure("draft.hash", "sha256"));
    }
    const createdAt = deps.now();
    const row = buildSupplementRow(input.binding, draft, createdAt);
    const reads = workspaceReadRows(input.binding, row.supplement_id, createdAt, draft.read_manifest);

    const outcome = await deps.commit.commitLiveGated<null>({
      binding: input.binding,
      stage: (stage) => {
        const rows = [
          {
            row_schema: EVIDENCE_SUPPLEMENT_ROW_SCHEMA as StateRowSchema,
            operation: "insert" as const,
            row: row as unknown as StateRowTypeMap[StateRowSchema],
            document_id: null
          },
          ...reads.map((read) => ({
            row_schema: WORKSPACE_READ_ROW_SCHEMA as StateRowSchema,
            operation: "insert" as const,
            row: read as unknown as StateRowTypeMap[StateRowSchema],
            document_id: null
          }))
        ];
        const staged = stage.stageRows(rows);
        if (!staged.ok) {
          return err(staged.error, staged.status);
        }
        return ok({ kind: "commit" as const, value: null });
      }
    });
    if (!outcome.ok) {
      return err(
        outcome.error,
        outcome.commit_state === "unknown_recovery_required" ? "unknown" : "rejected"
      );
    }
    if (outcome.commit_state !== "committed") {
      return err(writerFailure("evidence_supplement_write", "unexpected_existing_frame"), "conflict");
    }
    return ok({
      supplement_id: row.supplement_id,
      record_hash: row.record_hash,
      first_commit_seq: outcome.receipt.first_commit_seq,
      last_commit_seq: outcome.receipt.last_commit_seq,
      row
    });
  }

  async function read(
    supplementId: string,
    binding: VersionBinding
  ): Promise<Result<EvidenceSupplementRow | null, ErrorEnvelope>> {
    if (deps.reader === undefined) {
      return err(writerFailure("evidence_supplement_read", "reader_unavailable"), "degraded");
    }
    const found = await deps.reader.getStateRow({
      row_schema: EVIDENCE_SUPPLEMENT_ROW_SCHEMA as StateRowSchema,
      key: { supplement_id: supplementId } as never,
      binding
    });
    if (!found.ok) {
      return found;
    }
    if (found.value === null) {
      return ok(null);
    }
    return ok(found.value as unknown as EvidenceSupplementRow);
  }

  return { append, read };
}

/** Exposed for tests that assert the exact row shape. */
export function buildEvidenceSupplementRow(
  binding: VersionBinding,
  draft: EvidenceSupplementDraft,
  now: number
): EvidenceSupplementRow {
  return buildSupplementRow(binding, draft, now);
}
