import { randomUUID } from "node:crypto";
import type { Hash } from "@evoplug/core";
import type { SqlRow, StatementSource } from "../types.js";
import { fieldDetails, storageError } from "../errors.js";

/** Closed set of quarantine scopes from the `quarantine` CHECK constraint. */
export type QuarantineScope = "journal" | "event" | "transition" | "idempotency";

/** Persisted `quarantine` row. */
export interface QuarantineEntry extends SqlRow {
  readonly quarantine_id: string;
  readonly scope: QuarantineScope;
  readonly journal_id: string | null;
  readonly byte_offset: number | null;
  readonly commit_seq: number | null;
  readonly reason_code: string;
  readonly payload_hash: string | null;
  readonly bytes_ref: string | null;
  readonly discovered_at: number;
  readonly resolved_at: number | null;
}

export interface QuarantineInsert {
  readonly scope: QuarantineScope;
  readonly reason_code: string;
  readonly discovered_at: number;
  readonly journal_id?: string;
  readonly byte_offset?: number;
  readonly commit_seq?: number;
  readonly payload_hash?: Hash;
  readonly bytes_ref?: string;
}

/**
 * Allocates a quarantine row identity. The design does not register a local ID
 * prefix for quarantine, so a random UUID is used; it never enters an event or
 * a content hash.
 */
export function newQuarantineId(): string {
  return randomUUID();
}

/** Inserts one quarantine row and returns its id. */
export function insertQuarantine(source: StatementSource, input: QuarantineInsert): string {
  if (input.byte_offset !== undefined && (!Number.isSafeInteger(input.byte_offset) || input.byte_offset < 0)) {
    throw storageError({
      code: "E_SCHEMA",
      stage: "storage.quarantine",
      details: fieldDetails("byte_offset", "must_be_non_negative_safe_integer")
    });
  }
  const quarantineId = newQuarantineId();
  source
    .prepare(
      `INSERT INTO quarantine (
         quarantine_id, scope, journal_id, byte_offset, commit_seq,
         reason_code, payload_hash, bytes_ref, discovered_at, resolved_at
       ) VALUES (
         :quarantine_id, :scope, :journal_id, :byte_offset, :commit_seq,
         :reason_code, :payload_hash, :bytes_ref, :discovered_at, NULL
       )`,
    )
    .run({
      quarantine_id: quarantineId,
      scope: input.scope,
      journal_id: input.journal_id ?? null,
      byte_offset: input.byte_offset ?? null,
      commit_seq: input.commit_seq ?? null,
      reason_code: input.reason_code,
      payload_hash: input.payload_hash ?? null,
      bytes_ref: input.bytes_ref ?? null,
      discovered_at: input.discovered_at
    });
  return quarantineId;
}

export interface QuarantineQuery {
  readonly include_resolved?: boolean;
  readonly limit?: number;
}

/** Lists quarantine rows, newest discovery first. */
export function listQuarantine(
  source: StatementSource,
  query: QuarantineQuery = {},
): readonly QuarantineEntry[] {
  const includeResolved = query.include_resolved ?? false;
  const limit = query.limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
    throw storageError({
      code: "E_SCHEMA",
      stage: "storage.quarantine",
      details: fieldDetails("limit", "must_be_1..10000")
    });
  }
  const where = includeResolved ? "" : "WHERE resolved_at IS NULL";
  return source
    .prepare<QuarantineEntry>(
      `SELECT quarantine_id, scope, journal_id, byte_offset, commit_seq,
              reason_code, payload_hash, bytes_ref, discovered_at, resolved_at
         FROM quarantine
         ${where}
        ORDER BY discovered_at DESC, quarantine_id ASC
        LIMIT :limit`,
    )
    .all({ limit });
}

/** Marks one quarantine row resolved. Returns false when it was already resolved or absent. */
export function resolveQuarantine(
  source: StatementSource,
  quarantineId: string,
  resolvedAt: number,
): boolean {
  const result = source
    .prepare(
      `UPDATE quarantine
          SET resolved_at = :resolved_at
        WHERE quarantine_id = :quarantine_id AND resolved_at IS NULL`,
    )
    .run({ quarantine_id: quarantineId, resolved_at: resolvedAt });
  return result.changes === 1;
}

/** Counts unresolved quarantine rows. */
export function countOpenQuarantine(source: StatementSource): number {
  const row = source
    .prepare<{ total: number }>(
      "SELECT COUNT(*) AS total FROM quarantine WHERE resolved_at IS NULL",
    )
    .get();
  return row === undefined ? 0 : Number(row.total);
}
