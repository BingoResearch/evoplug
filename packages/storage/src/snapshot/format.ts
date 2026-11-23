/**
 * `evolve export` / `evolve import` package format (DD-FND-101, DD-FND-024,
 * DD-FND-062).
 *
 * The design fixes the semantics (consistent SQLite snapshot plus a journal and
 * blob manifest with per-file hashes and byte counts) but not the container
 * bytes. This module owns the versioned container:
 *
 * ```text
 * offset 0   magic "RSIEXPKG" (8 bytes)
 * offset 8   uint32 big-endian container version (1)
 * offset 12  uint32 big-endian manifest length
 * offset 16  manifest JSON (UTF-8, RFC 8785 canonical form)
 * then       payload entries in the order database, journal[], blobs[], config
 * ```
 *
 * Each payload entry occupies exactly `byte_length` bytes and must hash to the
 * `hash` recorded in the manifest. The manifest itself carries
 * `manifest_hash = sha256(JCS(manifest without manifest_hash))`.
 *
 * `config.json` is the only home file outside `db/`, `journal/` and `blobs/`
 * that the package carries. It never contains plaintext credentials: values
 * are `secret_ref` pointers, and both export and import reject a config that
 * fails the plaintext-secret scan.
 */

import { type ErrorEnvelope, type Hash, type Result, isRecord } from "@evoplug/core";
import { canonicalHash, canonicalJsonText, newId } from "@evoplug/core";
import { fieldDetails } from "../errors.js";
import { HASH_PATTERN } from "../hash.js";
import { jsonValueOf } from "../types.js";

export const EXPORT_CONTAINER_MAGIC: Uint8Array = new TextEncoder().encode("RSIEXPKG");
export const EXPORT_CONTAINER_VERSION: 1 = 1;
export const EXPORT_HEADER_BYTES: 16 = 16;
export const MAX_EXPORT_MANIFEST_BYTES: number = 67_108_864;
export const EXPORT_MANIFEST_SCHEMA: "rsi.export_manifest/1" = "rsi.export_manifest/1";
export const EXPORT_FORMAT: "evoplug.export/1" = "evoplug.export/1";
export const EXPORT_DATABASE_PATH: "db/evoplug.sqlite" = "db/evoplug.sqlite";
export const EXPORT_CONFIG_PATH: "config.json" = "config.json";

const SECRET_KEY_PATTERN: RegExp =
  /(^|_)(secret|token|cookie|password|passwd|api_?key|private_?key|credential)(_|$)/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
];

export interface TableRowCount {
  readonly table: string;
  readonly rows: number;
}

export interface ExportDatabaseEntry {
  readonly kind: "database";
  readonly path: typeof EXPORT_DATABASE_PATH;
  readonly byte_length: number;
  readonly hash: Hash;
  readonly quick_check: "ok";
  readonly foreign_key_check: "ok";
  readonly table_row_counts: readonly TableRowCount[];
}

export interface ExportJournalEntry {
  readonly kind: "journal";
  /** Path relative to the home root, always `journal/<name>.rsij`. */
  readonly path: string;
  readonly journal_id: string | null;
  readonly byte_length: number;
  readonly hash: Hash;
}

export interface ExportBlobEntry {
  readonly kind: "blob";
  /** Path relative to the home root, always `blobs/sha256/<64 hex>`. */
  readonly path: string;
  readonly hash: Hash;
  readonly byte_length: number;
}

export interface ExportConfigEntry {
  readonly kind: "config";
  readonly path: typeof EXPORT_CONFIG_PATH;
  readonly byte_length: number;
  readonly hash: Hash;
}

export interface ExportManifest {
  readonly schema_version: typeof EXPORT_MANIFEST_SCHEMA;
  readonly format: typeof EXPORT_FORMAT;
  readonly created_at: number;
  readonly product_version: string;
  readonly schema_major: number;
  readonly schema_minor: number;
  readonly database: ExportDatabaseEntry;
  readonly journal: readonly ExportJournalEntry[];
  readonly blobs: readonly ExportBlobEntry[];
  readonly config: ExportConfigEntry | null;
  readonly manifest_hash: Hash;
}

/** Manifest fields covered by `manifest_hash`. */
export type ExportManifestBody = Omit<ExportManifest, "manifest_hash">;

export type SnapshotEntry = ExportDatabaseEntry | ExportJournalEntry | ExportBlobEntry | ExportConfigEntry;

/** Payload order is part of the v1 container format. */
export function orderedSnapshotEntries(  manifest: ExportManifest | ExportManifestBody,
): readonly SnapshotEntry[] {
  const entries: SnapshotEntry[] = [manifest.database];
  for (const entry of manifest.journal) {
    entries.push(entry);
  }
  for (const entry of manifest.blobs) {
    entries.push(entry);
  }
  if (manifest.config !== null) {
    entries.push(manifest.config);
  }
  return entries;
}

/** `sha256(JCS(manifest without manifest_hash))`. */
export function computeManifestHash(body: ExportManifestBody): Hash {
  return canonicalHash(jsonValueOf(body));
}

/**
 * Normalizes `journal_state.relative_path` to the manifest path. The kernel
 * stores the file name relative to `<home>/journal`; older/manual rows may
 * already carry the `journal/` prefix.
 */
export function journalManifestPath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith("journal/") ? normalized : `journal/${normalized}`;
}

/** True when the value is a well-formed content hash. */
export function isManifestHash(value: string): value is Hash {
  return HASH_PATTERN.test(value);
}

/**
 * Rejects plaintext credentials in `config.json`. `*_ref` keys are pointers
 * into an external keychain and are allowed. Mirrors the kernel config rule so
 * a hand-built package cannot smuggle a secret into an imported home.
 */
export function findPlaintextSecret(value: unknown, path = "$"): string | null {
  if (typeof value === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        return path;
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPlaintextSecret(value[index], `${path}[${String(index)}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key) && !key.endsWith("_ref")) {
        return `${path}.${key}`;
      }
      const found = findPlaintextSecret(item, `${path}.${key}`);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function formatFailure(path: string, rule: string): ErrorEnvelope {
  return {
    schema_version: "rsi.error/1",
    code: "E_SCHEMA",
    category: "schema",
    retryable: false,
    side_effect: "none",
    message_key: "error.schema.invalid",
    details: fieldDetails(path, rule),
    stage: "storage.snapshot",
    trace_id: newId("ipc")
  };
}

/** Internal validator failure; converted to a `Result` by `parseExportManifest`. */
class ManifestFailure extends Error {
  readonly path: string;
  readonly rule: string;

  constructor(path: string, rule: string) {
    super(`${path}: ${rule}`);
    this.name = "ManifestFailure";
    this.path = path;
    this.rule = rule;
  }
}

function need(condition: boolean, path: string, rule: string): asserts condition {
  if (!condition) {
    throw new ManifestFailure(path, rule);
  }
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    need(keys.includes(key), `${path}.${key}`, "unknown_field");
  }
  for (const key of keys) {
    need(Object.prototype.hasOwnProperty.call(value, key), `${path}.${key}`, "missing_field");
  }
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  need(isRecord(value), path, "must_be_object");
  return value;
}

function requireString(value: unknown, path: string): string {
  need(typeof value === "string" && value.length > 0, path, "must_be_non_empty_string");
  return value;
}

function requireNonNegativeInt(value: unknown, path: string): number {
  need(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    path,
    "must_be_non_negative_safe_integer",
  );
  return value;
}

function requireHash(value: unknown, path: string): Hash {
  need(typeof value === "string" && HASH_PATTERN.test(value), path, "must_be_content_hash");
  return value as Hash;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  need(Array.isArray(value), path, "must_be_array");
  return value;
}

function requireLiteral<T extends string>(value: unknown, expected: T, path: string): T {
  need(value === expected, path, `must_equal_${expected}`);
  return expected;
}

function parseTableRowCounts(value: unknown, path: string): readonly TableRowCount[] {
  const rows: TableRowCount[] = [];
  const seen = new Set<string>();
  const raw = requireArray(value, path);
  for (let index = 0; index < raw.length; index += 1) {
    const item = requireRecord(raw[index], `${path}[${String(index)}]`);
    exactKeys(item, ["table", "rows"], `${path}[${String(index)}]`);
    const table = requireString(item["table"], `${path}[${String(index)}].table`);
    need(/^[A-Za-z_][A-Za-z0-9_]*$/.test(table), `${path}[${String(index)}].table`, "invalid_identifier");
    need(!seen.has(table), `${path}[${String(index)}].table`, "duplicate_table");
    seen.add(table);
    rows.push({
      table,
      rows: requireNonNegativeInt(item["rows"], `${path}[${String(index)}].rows`)
    });
  }
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    need(
      previous !== undefined && current !== undefined && previous.table < current.table,
      `${path}[${String(index)}].table`,
      "not_sorted_unique",
    );
  }
  return rows;
}

function parseDatabaseEntry(value: unknown): ExportDatabaseEntry {
  const record = requireRecord(value, "database");
  exactKeys(
    record,
    [
      "kind",
      "path",
      "byte_length",
      "hash",
      "quick_check",
      "foreign_key_check",
      "table_row_counts"
    ],
    "database",
  );
  return {
    kind: requireLiteral(record["kind"], "database", "database.kind"),
    path: requireLiteral(record["path"], EXPORT_DATABASE_PATH, "database.path"),
    byte_length: requireNonNegativeInt(record["byte_length"], "database.byte_length"),
    hash: requireHash(record["hash"], "database.hash"),
    quick_check: requireLiteral(record["quick_check"], "ok", "database.quick_check"),
    foreign_key_check: requireLiteral(
      record["foreign_key_check"],
      "ok",
      "database.foreign_key_check",
    ),
    table_row_counts: parseTableRowCounts(record["table_row_counts"], "database.table_row_counts")
  };
}

function parseJournalEntries(value: unknown): readonly ExportJournalEntry[] {
  const raw = requireArray(value, "journal");
  const entries: ExportJournalEntry[] = [];
  const paths = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const path = `journal[${String(index)}]`;
    const record = requireRecord(raw[index], path);
    exactKeys(record, ["kind", "path", "journal_id", "byte_length", "hash"], path);
    const entryPath = requireString(record["path"], `${path}.path`);
    need(/^journal\/[A-Za-z0-9._-]+\.rsij$/.test(entryPath), `${path}.path`, "invalid_journal_path");
    need(!paths.has(entryPath), `${path}.path`, "duplicate_path");
    paths.add(entryPath);
    const journalId = record["journal_id"];
    need(
      journalId === null || (typeof journalId === "string" && journalId.length > 0),
      `${path}.journal_id`,
      "must_be_string_or_null",
    );
    entries.push({
      kind: requireLiteral(record["kind"], "journal", `${path}.kind`),
      path: entryPath,
      journal_id: journalId === null ? null : journalId,
      byte_length: requireNonNegativeInt(record["byte_length"], `${path}.byte_length`),
      hash: requireHash(record["hash"], `${path}.hash`)
    });
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    need(
      previous !== undefined && current !== undefined && previous.path < current.path,
      `journal[${String(index)}].path`,
      "not_sorted_unique",
    );
  }
  return entries;
}

function parseBlobEntries(value: unknown): readonly ExportBlobEntry[] {
  const raw = requireArray(value, "blobs");
  const entries: ExportBlobEntry[] = [];
  const paths = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const path = `blobs[${String(index)}]`;
    const record = requireRecord(raw[index], path);
    exactKeys(record, ["kind", "path", "hash", "byte_length"], path);
    const hash = requireHash(record["hash"], `${path}.hash`);
    const entryPath = requireString(record["path"], `${path}.path`);
    const expectedPath = `blobs/sha256/${hash.slice("sha256:".length)}`;
    need(entryPath === expectedPath, `${path}.path`, "path_does_not_match_hash");
    need(!paths.has(entryPath), `${path}.path`, "duplicate_path");
    paths.add(entryPath);
    entries.push({
      kind: requireLiteral(record["kind"], "blob", `${path}.kind`),
      path: entryPath,
      hash,
      byte_length: requireNonNegativeInt(record["byte_length"], `${path}.byte_length`)
    });
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    need(
      previous !== undefined && current !== undefined && previous.hash < current.hash,
      `blobs[${String(index)}].hash`,
      "not_sorted_unique",
    );
  }
  return entries;
}

function parseConfigEntry(value: unknown): ExportConfigEntry | null {
  if (value === null) {
    return null;
  }
  const record = requireRecord(value, "config");
  exactKeys(record, ["kind", "path", "byte_length", "hash"], "config");
  return {
    kind: requireLiteral(record["kind"], "config", "config.kind"),
    path: requireLiteral(record["path"], EXPORT_CONFIG_PATH, "config.path"),
    byte_length: requireNonNegativeInt(record["byte_length"], "config.byte_length"),
    hash: requireHash(record["hash"], "config.hash")
  };
}

/**
 * Parses and fully validates an `rsi.export_manifest/1` object. Unknown fields
 * anywhere in the manifest are rejected; path, hash and length formats are
 * checked before any file is written.
 */
export function parseExportManifest(
  value: unknown,
): Result<ExportManifest, ErrorEnvelope> {
  try {
    const record = requireRecord(value, "manifest");
    exactKeys(
      record,
      [
        "schema_version",
        "format",
        "created_at",
        "product_version",
        "schema_major",
        "schema_minor",
        "database",
        "journal",
        "blobs",
        "config",
        "manifest_hash"
      ],
      "manifest",
    );
    const body: ExportManifestBody = {
      schema_version: requireLiteral(
        record["schema_version"],
        EXPORT_MANIFEST_SCHEMA,
        "manifest.schema_version",
      ),
      format: requireLiteral(record["format"], EXPORT_FORMAT, "manifest.format"),
      created_at: requireNonNegativeInt(record["created_at"], "manifest.created_at"),
      product_version: requireString(record["product_version"], "manifest.product_version"),
      schema_major: requireNonNegativeInt(record["schema_major"], "manifest.schema_major"),
      schema_minor: requireNonNegativeInt(record["schema_minor"], "manifest.schema_minor"),
      database: parseDatabaseEntry(record["database"]),
      journal: parseJournalEntries(record["journal"]),
      blobs: parseBlobEntries(record["blobs"]),
      config: parseConfigEntry(record["config"])
    };
    const manifestHash = requireHash(record["manifest_hash"], "manifest.manifest_hash");
    need(
      computeManifestHash(body) === manifestHash,
      "manifest.manifest_hash",
      "manifest_hash_mismatch",
    );
    const paths = new Set<string>();
    for (const entry of orderedSnapshotEntries(body)) {
      need(!paths.has(entry.path), `manifest.${entry.path}`, "duplicate_path");
      paths.add(entry.path);
    }
    return { ok: true, status: "ok", value: { ...body, manifest_hash: manifestHash } };
  } catch (error) {
    if (error instanceof ManifestFailure) {
      return { ok: false, status: "rejected", error: formatFailure(error.path, error.rule) };
    }
    return {
      ok: false,
      status: "rejected",
      error: formatFailure("manifest", "unreadable")
    };
  }
}

/** Checks that the config bytes parse and contain no plaintext credential. */
export function validateConfigText(text: string): Result<void, ErrorEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: "rejected", error: formatFailure("config", "invalid_json") };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: "rejected", error: formatFailure("config", "must_be_object") };
  }
  const secretPath = findPlaintextSecret(parsed);
  if (secretPath !== null) {
    return { ok: false, status: "rejected", error: formatFailure(secretPath, "plaintext_secret") };
  }
  return { ok: true, status: "ok", value: undefined };
}

/** Re-serializes the config with `product_home` set to the import target. */
export function rehomeConfigText(
  text: string,
  targetHome: string,
): Result<string, ErrorEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: "rejected", error: formatFailure("config", "invalid_json") };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: "rejected", error: formatFailure("config", "must_be_object") };
  }
  const configSpace = parsed["config_space"];
  if (typeof configSpace !== "string" || configSpace.length === 0) {
    return { ok: false, status: "rejected", error: formatFailure("config.config_space", "missing") };
  }
  if (parsed["schema_version"] !== "rsi.config/1") {
    return { ok: false, status: "rejected", error: formatFailure("config.schema_version", "unsupported") };
  }
  const rewritten: Record<string, unknown> = { ...parsed, product_home: targetHome };
  try {
    return { ok: true, status: "ok", value: canonicalJsonText(jsonValueOf(rewritten)) };
  } catch {
    return { ok: false, status: "rejected", error: formatFailure("config", "not_canonicalizable") };
  }
}
