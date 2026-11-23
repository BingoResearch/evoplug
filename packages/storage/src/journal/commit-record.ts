import { canonicalJsonText } from "@evoplug/core";
import type { Hash, Result, ErrorEnvelope } from "@evoplug/core";
import { fieldDetails, storageError } from "../errors.js";
import type { SqlRow, StatementSource } from "../types.js";
import {
  STATE_ROW_BATCH_SCHEMA_VERSION,
  frameEventRecords
} from "./payload.js";
import type { JournalFramePayload } from "./payload.js";

/** One fully frozen `commit_record` row. */
export interface CommitRecord {
  readonly journal_id: string;
  readonly commit_seq: number;
  readonly event_id: string;
  readonly payload_hash: Hash;
  readonly blob_hashes_json: string;
  readonly batch_hash: Hash | null;
  readonly batch_first_commit_seq: number | null;
  readonly batch_ordinal: number | null;
  readonly committed_at: number;
  readonly indexed_at: number | null;
}

/** Derives every `commit_record` row a frame must have, in commit_seq order. */
export function expectedCommitRecords(input: {
  readonly journal_id: string;
  readonly commit_seq: number;
  readonly payload: JournalFramePayload;
  readonly committed_at: number;
  readonly indexed_at?: number | null;
}): Result<readonly CommitRecord[], ErrorEnvelope> {
  const records = frameEventRecords(input.payload);
  if (!records.ok) {
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_LEDGER_EVENT_INVALID",
        stage: "storage.journal",
        details: fieldDetails("payload", records.error.reason)
      })
    };
  }
  const isBatch = input.payload.schema_version === STATE_ROW_BATCH_SCHEMA_VERSION;
  const batchHash = isBatch ? input.payload.batch_hash : null;
  const indexedAt = input.indexed_at ?? null;
  const out: CommitRecord[] = [];
  for (let ordinal = 0; ordinal < records.value.length; ordinal += 1) {
    const record = records.value[ordinal];
    if (record === undefined) {
      continue;
    }
    out.push({
      journal_id: input.journal_id,
      commit_seq: input.commit_seq + ordinal,
      event_id: record.event_id,
      payload_hash: record.payload_hash,
      blob_hashes_json: canonicalJsonText([...record.blob_hashes]),
      batch_hash: batchHash,
      batch_first_commit_seq: isBatch ? input.commit_seq : null,
      batch_ordinal: isBatch ? ordinal : null,
      committed_at: input.committed_at,
      indexed_at: indexedAt
    });
  }
  return { ok: true, status: "ok", value: out };
}

export interface CommitRecordRow extends SqlRow {
  readonly journal_id: string;
  readonly commit_seq: number;
  readonly event_id: string;
  readonly payload_hash: string;
  readonly blob_hashes_json: string;
  readonly batch_hash: string | null;
  readonly batch_first_commit_seq: number | null;
  readonly batch_ordinal: number | null;
  readonly committed_at: number;
  readonly indexed_at: number | null;
}

/** Reads every `commit_record` row of one journal, ordered by `commit_seq`. */
export function readCommitRecords(
  source: StatementSource,
  journalId: string,
): readonly CommitRecordRow[] {
  return source
    .prepare<CommitRecordRow>(
      `SELECT journal_id, commit_seq, event_id, payload_hash, blob_hashes_json,
              batch_hash, batch_first_commit_seq, batch_ordinal, committed_at, indexed_at
         FROM commit_record
        WHERE journal_id = :journal_id
        ORDER BY commit_seq ASC`,
    )
    .all({ journal_id: journalId });
}

/** Inserts a missing commit record; an existing row is left untouched. */
export function insertCommitRecord(source: StatementSource, record: CommitRecord): void {
  source
    .prepare(
      `INSERT INTO commit_record (
         journal_id, commit_seq, event_id, payload_hash, blob_hashes_json,
         batch_hash, batch_first_commit_seq, batch_ordinal, committed_at, indexed_at
       ) VALUES (
         :journal_id, :commit_seq, :event_id, :payload_hash, :blob_hashes_json,
         :batch_hash, :batch_first_commit_seq, :batch_ordinal, :committed_at, :indexed_at
       )
       ON CONFLICT(commit_seq) DO NOTHING`,
    )
    .run({
      journal_id: record.journal_id,
      commit_seq: record.commit_seq,
      event_id: record.event_id,
      payload_hash: record.payload_hash,
      blob_hashes_json: record.blob_hashes_json,
      batch_hash: record.batch_hash,
      batch_first_commit_seq: record.batch_first_commit_seq,
      batch_ordinal: record.batch_ordinal,
      committed_at: record.committed_at,
      indexed_at: record.indexed_at
    });
}

/** True when an existing row carries exactly the frozen frame metadata. */
export function commitRecordMatches(existing: CommitRecordRow, expected: CommitRecord): boolean {
  return (
    existing.journal_id === expected.journal_id &&
    Number(existing.commit_seq) === expected.commit_seq &&
    existing.event_id === expected.event_id &&
    existing.payload_hash === expected.payload_hash &&
    existing.blob_hashes_json === expected.blob_hashes_json &&
    existing.batch_hash === expected.batch_hash &&
    (existing.batch_first_commit_seq === null
      ? expected.batch_first_commit_seq === null
      : Number(existing.batch_first_commit_seq) === expected.batch_first_commit_seq) &&
    (existing.batch_ordinal === null
      ? expected.batch_ordinal === null
      : Number(existing.batch_ordinal) === expected.batch_ordinal)
  );
}
