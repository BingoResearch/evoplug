import { newId } from "@evoplug/core";
import { canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result } from "@evoplug/core";
import { fieldDetails, storageError } from "../errors.js";
import { sha256Text } from "../hash.js";
import { jsonValueOf } from "../types.js";
import type { SqlRow, StatementSource } from "../types.js";
import { insertQuarantine } from "../schema/quarantine.js";
import type { BlobStore } from "../blob/store.js";

/** Default blob retention: 30 days. */
const BLOB_RETENTION_DAYS = 30;
/** Default IPC idempotency retention: 7 days; `event.ingest` rows carry 30 days in `expires_at`. */
const IDEMPOTENCY_RETENTION_DAYS = 7;
/** Event ingest idempotency retention: 30 days. */
const EVENT_INGEST_IDEMPOTENCY_RETENTION_DAYS = 30;
/** Temporary blob files become collectable after one hour. */
const TEMP_FILE_GRACE_MS = 3600000;
/** Milliseconds per day. */
export const DAY_MS = 86400000;

export interface GcReport {
  readonly schema_version: "rsi.gc_report/1";
  readonly mode: "dry_run" | "apply";
  readonly keep_blobs: number;
  readonly delete_blobs: number;
  readonly quarantine_blobs: number;
  readonly reclaimed_bytes: number;
  readonly expired_idempotency_rows: number;
  readonly deleted_temp_files: number;
  readonly run_id: Id<"mnt"> | null;
}

interface GcOptions {
  readonly mode: "dry_run" | "apply";
  readonly now: number;
  readonly retention_days?: number;
  readonly idempotency_retention_days?: number;
  readonly event_ingest_retention_days?: number;
}

interface BlobRow extends SqlRow {
  readonly blob_hash: string;
  readonly byte_length: number;
  readonly relative_path: string;
  readonly state: string;
  readonly created_at: number;
}

interface BlobRefCount extends SqlRow {
  readonly blob_hash: string;
  readonly total: number;
}

function parseBlobHashes(json: string): readonly Hash[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Hash[] = [];
  for (const item of parsed) {
    if (typeof item !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item)) {
      return null;
    }
    out.push(item as Hash);
  }
  return out;
}

/**
 * Journal closure: any blob referenced by any `commit_record` frame is kept
 * forever. The closure is read from SQLite first; an unreadable closure aborts
 * the whole run because it can no longer prove a blob is unreferenced.
 */
function readJournalBlobClosure(
  source: StatementSource,
): Result<ReadonlySet<Hash>, ErrorEnvelope> {
  const rows = source
    .prepare<{ blob_hashes_json: string }>(
      "SELECT blob_hashes_json FROM commit_record",
    )
    .all();
  const closure = new Set<Hash>();
  for (const row of rows) {
    const hashes = parseBlobHashes(row.blob_hashes_json);
    if (hashes === null) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_CORRUPT",
          stage: "storage.gc",
          details: fieldDetails("commit_record.blob_hashes_json", "invalid_json")
        })
      };
    }
    for (const hash of hashes) {
      closure.add(hash);
    }
  }
  return { ok: true, status: "ok", value: closure };
}

/**
 * Runs one GC pass. `dry_run` only counts. `apply` deletes only blobs with no
 * `blob_ref`, no journal frame reference, and a verified hash; a hash mismatch
 * or missing file quarantines the row instead of deleting it.
 *
 * The caller runs this inside the single writer lock.
 */
export function runGarbageCollection(args: {
  readonly source: StatementSource;
  readonly blobStore: BlobStore;
  readonly options: GcOptions;
}): Result<GcReport, ErrorEnvelope> {
  const { source, blobStore, options } = args;
  const mode = options.mode;
  const now = options.now;
  const retentionDays = options.retention_days ?? BLOB_RETENTION_DAYS;
  const idempotencyDays = options.idempotency_retention_days ?? IDEMPOTENCY_RETENTION_DAYS;
  const eventIngestDays =
    options.event_ingest_retention_days ?? EVENT_INGEST_IDEMPOTENCY_RETENTION_DAYS;
  if (retentionDays < 0 || idempotencyDays < 0 || eventIngestDays < 0) {
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_SCHEMA",
        stage: "storage.gc",
        details: fieldDetails("retention_days", "must_be_non_negative")
      })
    };
  }
  const closureResult = readJournalBlobClosure(source);
  if (!closureResult.ok) {
    return closureResult;
  }
  const journalClosure = closureResult.value;
  const blobRows = source
    .prepare<BlobRow>(
      `SELECT blob_hash, byte_length, relative_path, state, created_at
         FROM blob
        ORDER BY blob_hash ASC`,
    )
    .all();
  const refRows = source
    .prepare<BlobRefCount>(
      "SELECT blob_hash, COUNT(*) AS total FROM blob_ref GROUP BY blob_hash",
    )
    .all();
  const refCounts = new Map<string, number>();
  for (const row of refRows) {
    refCounts.set(row.blob_hash, Number(row.total));
  }
  const cutoff = now - retentionDays * DAY_MS;
  let deleteBlobs = 0;
  let quarantineBlobs = 0;
  let reclaimedBytes = 0;
  let keepBlobs = 0;

  for (const row of blobRows) {
    const hash = row.blob_hash;
    const byteLength = Number(row.byte_length);
    const referenced =
      (refCounts.get(hash) ?? 0) > 0 || journalClosure.has(hash as Hash);
    if (row.state !== "present" || referenced || Number(row.created_at) > cutoff) {
      keepBlobs += 1;
      continue;
    }
    const verification = blobStore.verify(hash as Hash);
    if (!verification.ok) {
      return verification;
    }
    if (!verification.value.present || !verification.value.hash_matches) {
      quarantineBlobs += 1;
      if (mode === "apply") {
        insertQuarantine(source, {
          scope: "event",
          reason_code: verification.value.present ? "blob_hash_mismatch" : "blob_missing",
          payload_hash: hash as Hash,
          bytes_ref: `blob://${hash}#bytes=0-${byteLength}`,
          discovered_at: now
        });
      }
      continue;
    }
    if (verification.value.byte_length !== byteLength) {
      quarantineBlobs += 1;
      if (mode === "apply") {
        insertQuarantine(source, {
          scope: "event",
          reason_code: "blob_length_mismatch",
          payload_hash: hash as Hash,
          bytes_ref: `blob://${hash}#bytes=0-${byteLength}`,
          discovered_at: now
        });
      }
      continue;
    }
    deleteBlobs += 1;
    reclaimedBytes += byteLength;
    if (mode === "apply") {
      const deleted = blobStore.deleteFile(hash as Hash);
      if (!deleted.ok) {
        return deleted;
      }
      source
        .prepare(
          `UPDATE blob
              SET state = 'tombstoned',
                  verified_at = :now,
                  deleted_at = :now,
                  deletion_reason = 'retention'
            WHERE blob_hash = :blob_hash AND state = 'present'`,
        )
        .run({ now, blob_hash: hash });
    }
  }

  let expiredIdempotency = 0;
  const expired = source
    .prepare<{ total: number }>(
      "SELECT COUNT(*) AS total FROM ipc_idempotency WHERE expires_at < :now",
    )
    .get({ now });
  expiredIdempotency = expired === undefined ? 0 : Number(expired.total);
  if (mode === "apply") {
    source
      .prepare("DELETE FROM ipc_idempotency WHERE expires_at < :now")
      .run({ now });
  }

  const tempFiles = blobStore.listTempFiles(TEMP_FILE_GRACE_MS, now);
  let deletedTempFiles = 0;
  for (const tempFile of tempFiles) {
    if (mode === "apply") {
      const removed = blobStore.deleteTempFile(tempFile);
      if (!removed.ok) {
        return removed;
      }
      deletedTempFiles += 1;
    } else {
      deletedTempFiles += 1;
    }
  }

  const runId = mode === "apply" ? newId("mnt") : null;
  const report: GcReport = {
    schema_version: "rsi.gc_report/1",
    mode,
    keep_blobs: keepBlobs,
    delete_blobs: deleteBlobs,
    quarantine_blobs: quarantineBlobs,
    reclaimed_bytes: reclaimedBytes,
    expired_idempotency_rows: expiredIdempotency,
    deleted_temp_files: deletedTempFiles,
    run_id: runId
  };
  if (mode === "apply" && runId !== null) {
    const reportJson = canonicalJsonText(jsonValueOf(report));
    const runHash = sha256Text(reportJson);
    source
      .prepare(
        `INSERT INTO maintenance_run (
           run_id, kind, mode, started_at, finished_at, report_json, run_hash
         ) VALUES (
           :run_id, 'gc', :mode, :started_at, :finished_at, :report_json, :run_hash
         )`,
      )
      .run({
        run_id: runId,
        mode,
        started_at: now,
        finished_at: now,
        report_json: reportJson,
        run_hash: runHash
      });
  }
  return { ok: true, status: "ok", value: report };
}
