
import type { SqlRow, StatementSource } from "../types.js";
import type { JournalTailState } from "./reader.js";

/** Persisted row of `journal_state`. */
export interface JournalStateRow extends SqlRow {
  readonly journal_id: string;
  readonly relative_path: string;
  readonly base_commit_seq: number;
  readonly last_commit_seq: number;
  readonly trusted_prefix_end: number;
  readonly tail_state: JournalTailState;
  readonly read_only: number;
  readonly quarantine_ref: string | null;
  readonly updated_at: number;
}

interface FrameDurabilityInput {
  readonly journal_id: string;
  readonly relative_path: string;
  /** First commit sequence of the durable frame. */
  readonly first_commit_seq: number;
  /** Number of commit sequences consumed by the frame. */
  readonly member_count: number;
  /** Absolute byte offset immediately after the frame. */
  readonly trusted_prefix_end: number;
  readonly updated_at: number;
  /** Defaults to `first_commit_seq - 1` for a fresh journal era. */
  readonly base_commit_seq?: number;
  readonly tail_state?: JournalTailState;
}

/** Reads one `journal_state` row. */
export function readJournalState(
  source: StatementSource,
  journalId: string,
): JournalStateRow | null {
  const row = source
    .prepare<JournalStateRow>(
      `SELECT journal_id, relative_path, base_commit_seq, last_commit_seq,
              trusted_prefix_end, tail_state, read_only, quarantine_ref, updated_at
         FROM journal_state
        WHERE journal_id = :journal_id`,
    )
    .get({ journal_id: journalId });
  return row ?? null;
}

/** Reads all journal eras, oldest base sequence first. */
export function listJournalStates(source: StatementSource): readonly JournalStateRow[] {
  return source
    .prepare<JournalStateRow>(
      `SELECT journal_id, relative_path, base_commit_seq, last_commit_seq,
              trusted_prefix_end, tail_state, read_only, quarantine_ref, updated_at
         FROM journal_state
        ORDER BY base_commit_seq ASC, journal_id ASC`,
    )
    .all();
}

/** Creates the journal era row if absent, otherwise advances its durable tail. */
export function recordFrameDurability(
  source: StatementSource,
  input: FrameDurabilityInput,
): void {
  const lastCommitSeq = input.first_commit_seq + input.member_count - 1;
  source
    .prepare(
      `INSERT INTO journal_state (
         journal_id, relative_path, base_commit_seq, last_commit_seq,
         trusted_prefix_end, tail_state, read_only, quarantine_ref, updated_at
       ) VALUES (
         :journal_id, :relative_path, :base_commit_seq, :last_commit_seq,
         :trusted_prefix_end, :tail_state, 0, NULL, :updated_at
       )
       ON CONFLICT(journal_id) DO UPDATE SET
         relative_path = excluded.relative_path,
         last_commit_seq = excluded.last_commit_seq,
         trusted_prefix_end = excluded.trusted_prefix_end,
         tail_state = excluded.tail_state,
         updated_at = excluded.updated_at`,
    )
    .run({
      journal_id: input.journal_id,
      relative_path: input.relative_path,
      base_commit_seq: input.base_commit_seq ?? input.first_commit_seq - 1,
      last_commit_seq: lastCommitSeq,
      trusted_prefix_end: input.trusted_prefix_end,
      tail_state: input.tail_state ?? "clean",
      updated_at: input.updated_at
    });
}

/**
 * Points the era at a segment whose frames are already accounted for in
 * `last_commit_seq`.
 *
 * Recovery uses this when a crash created (or fsynced) the next segment but
 * wrote no frame into it: the era must adopt that empty segment so the next
 * rotation does not fail on an existing file, while the durable sequence
 * stays where the replayed prefix ended.
 */
export function adoptJournalSegment(
  source: StatementSource,
  input: {
    readonly journal_id: string;
    readonly relative_path: string;
    readonly trusted_prefix_end: number;
    readonly tail_state: JournalTailState;
    readonly updated_at: number;
  },
): void {
  source
    .prepare(
      `UPDATE journal_state
          SET relative_path = :relative_path,
              trusted_prefix_end = :trusted_prefix_end,
              tail_state = :tail_state,
              updated_at = :updated_at
        WHERE journal_id = :journal_id`,
    )
    .run({
      journal_id: input.journal_id,
      relative_path: input.relative_path,
      trusted_prefix_end: input.trusted_prefix_end,
      tail_state: input.tail_state,
      updated_at: input.updated_at
    });
}

/** Inserts a journal era without advancing its durable sequence. */
export function ensureJournalEra(  source: StatementSource,
  input: {
    readonly journal_id: string;
    readonly relative_path: string;
    readonly base_commit_seq: number;
    readonly last_commit_seq: number;
    readonly trusted_prefix_end: number;
    readonly tail_state: JournalTailState;
    readonly updated_at: number;
  },
): void {
  source
    .prepare(
      `INSERT INTO journal_state (
         journal_id, relative_path, base_commit_seq, last_commit_seq,
         trusted_prefix_end, tail_state, read_only, quarantine_ref, updated_at
       ) VALUES (
         :journal_id, :relative_path, :base_commit_seq, :last_commit_seq,
         :trusted_prefix_end, :tail_state, 0, NULL, :updated_at
       )
       ON CONFLICT(journal_id) DO NOTHING`,
    )
    .run({
      journal_id: input.journal_id,
      relative_path: input.relative_path,
      base_commit_seq: input.base_commit_seq,
      last_commit_seq: input.last_commit_seq,
      trusted_prefix_end: input.trusted_prefix_end,
      tail_state: input.tail_state,
      updated_at: input.updated_at
    });
}

/** Marks a journal era read-only and records its tail classification. */
export function setJournalTailState(
  source: StatementSource,
  journalId: string,
  tailState: JournalTailState,
  readOnly: boolean,
  trustedPrefixEnd: number,
  updatedAt: number,
): void {
  source
    .prepare(
      `UPDATE journal_state
          SET tail_state = :tail_state,
              read_only = :read_only,
              trusted_prefix_end = :trusted_prefix_end,
              updated_at = :updated_at
        WHERE journal_id = :journal_id`,
    )
    .run({
      journal_id: journalId,
      tail_state: tailState,
      read_only: readOnly ? 1 : 0,
      trusted_prefix_end: trustedPrefixEnd,
      updated_at: updatedAt
    });
}

/** Loads the durable tail sequence, or 0 when the era row does not exist yet. */
export function readJournalTailSeq(source: StatementSource, journalId: string): number {
  const row = source
    .prepare<{ last_commit_seq: number }>(
      "SELECT last_commit_seq FROM journal_state WHERE journal_id = :journal_id",
    )
    .get({ journal_id: journalId });
  return row === undefined ? 0 : Number(row.last_commit_seq);
}

