import type { SqlRow, StatementSource } from "../types.js";
import { fieldDetails, storageError } from "../errors.js";

/**
 * Schema major carried by the current binary (DD-FND-063). Major 4 is the
 * consolidated data model: mixed-lifecycle records share a record table keyed
 * by `record_kind`, and the former table names are compatibility views. Homes
 * persisted below major 4 are not read online; they are exported offline and
 * replaced by a fresh home (see the 精简设计 §4).
 */
export const SCHEMA_MAJOR = 4;

/** Initial minor version of a fresh database at the current major. */
export const SCHEMA_MINOR = 0;

/**
 * Schema version described by the frozen one-part baseline artifacts such as
 * `migrations/sql/0001_core.sql`. These artifacts predate per-file version
 * directives, so the runner starts a fresh database at this version and then
 * advances it from the target declared by each later artifact.
 */
export const BASELINE_SCHEMA_MAJOR = 2;
export const BASELINE_SCHEMA_MINOR = 0;

/** Keys stored in `schema_meta`. */
export const SCHEMA_META_KEYS = {
  schema_major: "schema_major",
  schema_minor: "schema_minor",
  receipt_seq: "receipt_seq",
  imported_from_major: "imported_from_major",
  import_manifest_hash: "import_manifest_hash",
  journal_seq: "journal_seq",
  db_path: "db_path"
} as const;

export interface SchemaVersion {
  readonly schema_major: number;
  readonly schema_minor: number;
}

interface SchemaMetaRow extends SqlRow {
  readonly key: string;
  readonly value: string;
  readonly updated_at: number;
}

/** Reads every `schema_meta` row. */
export function readSchemaMeta(source: StatementSource): ReadonlyMap<string, string> {
  const rows = source
    .prepare<SchemaMetaRow>("SELECT key, value, updated_at FROM schema_meta")
    .all();
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }
  return map;
}

/** Reads one `schema_meta` value. */
export function getSchemaMeta(source: StatementSource, key: string): string | null {
  const row = source
    .prepare<SchemaMetaRow>("SELECT key, value, updated_at FROM schema_meta WHERE key = :key")
    .get({ key });
  return row === undefined ? null : row.value;
}

/** Inserts or replaces one `schema_meta` value. */
export function setSchemaMeta(
  source: StatementSource,
  key: string,
  value: string,
  updatedAt: number,
): void {
  source
    .prepare(
      `INSERT INTO schema_meta (key, value, updated_at)
       VALUES (:key, :value, :updated_at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run({ key, value, updated_at: updatedAt });
}

function parseNonNegativeInt(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Ensures the mandatory `schema_meta` keys exist. A missing key is initialised
 * with `initial` (the current binary's version by default); an existing value
 * is never rewritten.
 */
export function ensureSchemaMeta(
  source: StatementSource,
  now: number,
  initial: SchemaVersion = { schema_major: SCHEMA_MAJOR, schema_minor: SCHEMA_MINOR },
): SchemaVersion {
  const defaults: Readonly<Record<string, string>> = {
    [SCHEMA_META_KEYS.schema_major]: String(initial.schema_major),
    [SCHEMA_META_KEYS.schema_minor]: String(initial.schema_minor),
    [SCHEMA_META_KEYS.receipt_seq]: "0"
  };
  for (const [key, value] of Object.entries(defaults)) {
    source
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at)
         VALUES (:key, :value, :updated_at)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run({ key, value, updated_at: now });
  }
  const version = tryReadSchemaVersion(source);
  if (version === null) {
    throw storageError({
      code: "E_STORAGE_CORRUPT",
      stage: "storage.schema",
      details: fieldDetails("schema_meta", "invalid_schema_version")
    });
  }
  return version;
}

/** Reads the persisted schema version, or null when a key is missing/invalid. */
export function tryReadSchemaVersion(source: StatementSource): SchemaVersion | null {
  const major = parseNonNegativeInt(getSchemaMeta(source, SCHEMA_META_KEYS.schema_major));
  const minor = parseNonNegativeInt(getSchemaMeta(source, SCHEMA_META_KEYS.schema_minor));
  if (major === null || minor === null) {
    return null;
  }
  return { schema_major: major, schema_minor: minor };
}

type SchemaMajorDisposition = "current" | "migrate" | "unsupported";

/** Orders two schema versions; positive when `left` is newer. */
export function compareSchemaVersions(left: SchemaVersion, right: SchemaVersion): number {
  if (left.schema_major !== right.schema_major) {
    return left.schema_major - right.schema_major;
  }
  return left.schema_minor - right.schema_minor;
}

/** Classifies a persisted major against the binary's supported major. */
export function classifySchemaMajor(dbMajor: number): SchemaMajorDisposition {
  if (dbMajor === SCHEMA_MAJOR) {
    return "current";
  }
  if (dbMajor < SCHEMA_MAJOR) {
    return "migrate";
  }
  return "unsupported";
}

/** Reads `schema_meta.receipt_seq`; defaults to 0 on a fresh database. */
export function readReceiptSeq(source: StatementSource): number {
  return parseNonNegativeInt(getSchemaMeta(source, SCHEMA_META_KEYS.receipt_seq)) ?? 0;
}

