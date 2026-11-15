import { makeErrorEnvelope } from "@evoplug/core";
import type { ErrorEnvelope } from "@evoplug/core";
import type { NotPromise } from "../types.js";
import type { StorageErrorCode } from "../errors.js";
import { storageDetails, storageError } from "../errors.js";

import type { SqliteConnection } from "../sqlite/driver.js";
import { createTransactionRunner, isErrorEnvelope, mapSqliteFailure } from "../sqlite/tx.js";
import type { Tx } from "../sqlite/tx.js";
import { expectedCommitRecords, insertCommitRecord } from "./commit-record.js";
import type { JournalFramePayload } from "./payload.js";
import type { JournalAppendResult } from "./writer.js";
import { JournalWriter, receiptRelativePath } from "./writer.js";
import { recordFrameDurability } from "./state.js";

/**
 * Outcome of one journal commit. Mirrors the four legal combinations of the
 * live-commit outcome: `commit_state` lives only here, never inside an
 * `ErrorEnvelope`.
 */
export type JournalCommitOutcome<Value = null> =
  | {
      readonly ok: true;
      readonly commit_state: "committed";
      readonly receipt: JournalAppendResult;
      readonly value: Value | null;
    }
  | {
      readonly ok: false;
      readonly commit_state: "not_written";
      readonly error: ErrorEnvelope;
    }
  | {
      readonly ok: false;
      readonly commit_state: "unknown_recovery_required";
      readonly error: ErrorEnvelope;
      readonly receipt?: JournalAppendResult;
    };

export interface JournalCommitter {
  /**
   * Writes one frame and fsyncs it, then projects `commit_record` and the
   * journal tail in one SQLite transaction before calling `project`. The
   * callback is synchronous and runs inside that transaction.
   */
  commit<Value = null>(
    payload: JournalFramePayload,
    project?: (tx: Tx, receipt: JournalAppendResult) => NotPromise<Value>,
    options?: {
      readonly enospc_code?: StorageErrorCode | undefined;
      readonly expected_first_commit_seq?: number | undefined;
    },
  ): Promise<JournalCommitOutcome<Value>>;
  /** Synchronous variant for callers already inside the writer gate. */
  commitSync<Value = null>(
    payload: JournalFramePayload,
    project?: (tx: Tx, receipt: JournalAppendResult) => NotPromise<Value>,
    options?: {
      readonly enospc_code?: StorageErrorCode | undefined;
      /**
       * First sequence the payload was hashed with. Allocation happens after
       * the re-sync, so a mismatch means another writer took that sequence;
       * the frame is not appended and the caller may re-plan it.
       */
      readonly expected_first_commit_seq?: number | undefined;
    },
  ): JournalCommitOutcome<Value>;
  /**
   * Writes several frames in order, fsyncing each one, and then projects all
   * of them in a single SQLite transaction (DD-FND-096.2 step 3: the approval
   * revocation frames precede the plan transition frame and share one short
   * transaction).
   */
  commitFrames<Value = null>(
    frames: readonly JournalFrameBatchEntry[],
  ): Promise<JournalCommitOutcome<Value>>;
  /** Synchronous variant of `commitFrames`. */
  commitFramesSync<Value = null>(
    frames: readonly JournalFrameBatchEntry[],
  ): JournalCommitOutcome<Value>;
}

/** One frame of a multi-frame commit plus its in-transaction projection. */
export interface JournalFrameBatchEntry {
  readonly payload: JournalFramePayload;
  readonly project?: (tx: Tx, receipt: JournalAppendResult) => NotPromise<void>;
}

function emptyFrameBatchError(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_LEDGER_EVENT_INVALID",
    category: "schema",
    message_key: "error.ledger_event_invalid",
    stage: "storage.journal",
    details: { kind: "internal", incident_id: "storage.journal.empty_frame_batch" }
  });
}

export interface JournalCommitterOptions {
  readonly writer: JournalWriter;
  readonly connection: SqliteConnection;
  /** Path recorded in `journal_state.relative_path`, relative to the evoplug home. */
  readonly relative_path: string;
  readonly now?: () => number;
  /**
   * Canonical ENOSPC code for this write stage (DD-FND-103). The stages are
   * `journal_write`, `ack_finish` and `delivery_enqueue`.
   */
  readonly enospc_code?: StorageErrorCode | undefined;
}

function invalidReceiptPath(): ErrorEnvelope {
  return storageError({
    code: "E_STORAGE_CORRUPT",
    stage: "storage.journal",
    details: storageDetails("receipt.file_path", "not_a_journal_segment"),
    side_effect: "unknown"
  });
}

/**
 * Creates the deterministic single-frame commit helper:
 *
 *   journal write + fsync  ->  SQLite commit_record/tail + caller projection.
 *
 * A failure after the fsync returns `unknown_recovery_required`; the frame is
 * durable and must be replayed, never retried as if it were unwritten.
 */
export function createJournalCommitter(options: JournalCommitterOptions): JournalCommitter {
  const runner = createTransactionRunner(options.connection);
  const now = options.now ?? (() => Date.now());

  /**
   * Re-syncs the writer against the shared commit sequence and the current
   * journal segment.
   *
   * `commit_seq` is a global monotonic sequence over the whole journal era
   * (DD-FND-059). A journal era may carry more than one writer — the
   * kernel's event writer and its ACK writer are two `JournalWriter`
   * instances on the same file — and each instance allocates from its own
   * private counter. The persisted `journal_state` is what they agree on:
   * its `last_commit_seq` allocates disjoint sequences, and its
   * `relative_path` names the segment after a rotation that another writer
   * performed. Without the path re-sync a non-rotating writer keeps
   * appending to the old segment and the next rotation fails on the
   * existing next file.
   */
  const resyncWriter = (): void => {
    const row = options.connection
      .prepare<{
        last_commit_seq: number;
        trusted_prefix_end: number;
        relative_path: string;
      }>(
        "SELECT last_commit_seq, trusted_prefix_end, relative_path FROM journal_state WHERE journal_id = :journal_id"
      )
      .get({ journal_id: options.writer.journalId });
    const shared = row === undefined ? 0 : Number(row.last_commit_seq);
    // A writer that does not implement the re-sync (a test double, or a
    // writer that owns the whole era) keeps its own counter.
    if (typeof options.writer.resyncFromDisk === "function") {
      if (row === undefined) {
        // No state row: a non-empty file is an orphaned first projection and
        // must not be appended to. Passing prefix 0 makes the writer reject it.
        options.writer.resyncFromDisk(shared);
      } else {
        options.writer.resyncFromDisk(
          shared,
          row.relative_path,
          Number(row.trusted_prefix_end)
        );
      }
    }
  };

  const durabilityPath = (receipt: JournalAppendResult): string | null =>
    receiptRelativePath(options.relative_path, receipt.file_path);

  const fenceWriter = (): void => {
    if (typeof options.writer.markRecoveryRequired === "function") {
      options.writer.markRecoveryRequired();
    }
  };

  const commitSeqConflict = (expected: number, actual: number): ErrorEnvelope =>
    storageError({
      code: "E_STORAGE_BUSY",
      stage: "storage.journal",
      details: storageDetails(
        "append",
        `commit_seq_conflict:${expected}:${actual}`,
      ),
      side_effect: "none"
    });

  const commitSync = <Value>(
    payload: JournalFramePayload,
    project?: (tx: Tx, receipt: JournalAppendResult) => NotPromise<Value>,
    callOptions?: {
      readonly enospc_code?: StorageErrorCode | undefined;
      readonly expected_first_commit_seq?: number | undefined;
    }
  ): JournalCommitOutcome<Value> => {
    resyncWriter();
    const expected = callOptions?.expected_first_commit_seq;
    if (
      expected !== undefined &&
      options.writer.lastCommitSeq + 1 !== expected
    ) {
      return {
        ok: false,
        commit_state: "not_written",
        error: commitSeqConflict(expected, options.writer.lastCommitSeq + 1)
      };
    }
    const append = options.writer.append(payload, {
      enospc_code: callOptions?.enospc_code ?? options.enospc_code,
      expected_first_commit_seq: callOptions?.expected_first_commit_seq
    });
    if (!append.ok) {
      if (options.writer.needsRecovery) {
        return {
          ok: false,
          commit_state: "unknown_recovery_required",
          error: append.error
        };
      }
      return { ok: false, commit_state: "not_written", error: append.error };
    }
    const receipt = append.value;
    const relativePath = durabilityPath(receipt);
    if (relativePath === null) {
      fenceWriter();
      return {
        ok: false,
        commit_state: "unknown_recovery_required",
        error: invalidReceiptPath(),
        receipt
      };
    }
    try {
      const value: Value | null = runner.withTxSync<Value | null>((tx) => {
        recordFrameDurability(tx, {
          journal_id: receipt.journal_id,
          relative_path: relativePath,
          first_commit_seq: receipt.first_commit_seq,
          member_count: receipt.member_count,
          trusted_prefix_end: receipt.file_offset + receipt.frame_bytes,
          updated_at: now()
        });
        const records = expectedCommitRecords({
          journal_id: receipt.journal_id,
          commit_seq: receipt.first_commit_seq,
          payload,
          committed_at: now(),
          indexed_at: null
        });
        if (!records.ok) {
          throw records.error;
        }
        for (const record of records.value) {
          insertCommitRecord(tx, record);
        }
        if (project === undefined) {
          return null;
        }
        return project(tx, receipt);
      });
      return { ok: true, commit_state: "committed", receipt, value };
    } catch (error) {
      fenceWriter();
      return {
        ok: false,
        commit_state: "unknown_recovery_required",
        error: isErrorEnvelope(error)
          ? error
          : mapSqliteFailure(error, "storage.journal", "project_frame"),
        receipt
      };
    }
  };

  const commitFramesSync = <Value>(
    frames: readonly JournalFrameBatchEntry[],
  ): JournalCommitOutcome<Value> => {
    if (frames.length === 0) {
      return {
        ok: false,
        commit_state: "not_written",
        error: emptyFrameBatchError()
      };
    }
    resyncWriter();
    const receipts: JournalAppendResult[] = [];
    for (const frame of frames) {
      const append = options.writer.append(frame.payload, { enospc_code: options.enospc_code });
      if (!append.ok) {
        if (options.writer.needsRecovery) {
          return {
            ok: false,
            commit_state: "unknown_recovery_required",
            error: append.error
          };
        }
        return { ok: false, commit_state: "not_written", error: append.error };
      }
      receipts.push(append.value);
    }
    const first = receipts[0];
    if (first === undefined) {
      return {
        ok: false,
        commit_state: "not_written",
        error: emptyFrameBatchError()
      };
    }
    const relativePaths: string[] = [];
    for (const receipt of receipts) {
      const relativePath = durabilityPath(receipt);
      if (relativePath === null) {
        fenceWriter();
        return {
          ok: false,
          commit_state: "unknown_recovery_required",
          error: invalidReceiptPath(),
          receipt: first
        };
      }
      relativePaths.push(relativePath);
    }
    try {
      const value: Value | null = runner.withTxSync<Value | null>((tx) => {
        for (let index = 0; index < frames.length; index += 1) {
          const frame = frames[index]!;
          const receipt = receipts[index]!;
          recordFrameDurability(tx, {
            journal_id: receipt.journal_id,
            relative_path: relativePaths[index]!,
            first_commit_seq: receipt.first_commit_seq,
            member_count: receipt.member_count,
            trusted_prefix_end: receipt.file_offset + receipt.frame_bytes,
            updated_at: now()
          });
          const records = expectedCommitRecords({
            journal_id: receipt.journal_id,
            commit_seq: receipt.first_commit_seq,
            payload: frame.payload,
            committed_at: now(),
            indexed_at: null
          });
          if (!records.ok) {
            throw records.error;
          }
          for (const record of records.value) {
            insertCommitRecord(tx, record);
          }
          frame.project?.(tx, receipt);
        }
        return null;
      });
      return { ok: true, commit_state: "committed", receipt: first, value };
    } catch (error) {
      fenceWriter();
      return {
        ok: false,
        commit_state: "unknown_recovery_required",
        error: isErrorEnvelope(error)
          ? error
          : mapSqliteFailure(error, "storage.journal", "project_frame"),
        receipt: first
      };
    }
  };

  return {
    commitSync,
    async commit<Value = null>(
      payload: JournalFramePayload,
      project?: (tx: Tx, receipt: JournalAppendResult) => NotPromise<Value>,
      callOptions?: {
        readonly enospc_code?: StorageErrorCode | undefined;
        readonly expected_first_commit_seq?: number | undefined;
      },
    ): Promise<JournalCommitOutcome<Value>> {
      return Promise.resolve().then(() => commitSync(payload, project, callOptions));
    },
    commitFramesSync,
    async commitFrames<Value = null>(
      frames: readonly JournalFrameBatchEntry[],
    ): Promise<JournalCommitOutcome<Value>> {
      return Promise.resolve().then(() => commitFramesSync(frames));
    }
  };
}
