/**
 * Consistent home snapshot export (DD-FND-101, DD-FND-024, DD-FND-062).
 *
 * Export order:
 *  1. refuse an existing target before touching the filesystem;
 *  2. take a SQLite backup of the live database (backup API semantics);
 *  3. verify the copy with `quick_check`, `foreign_key_check`, row counts and
 *     the persisted schema version;
 *  4. hash every journal file and every `present` blob, cross-checking
 *     `journal_state`, `blob` and `commit_record` references;
 *  5. write the versioned manifest and payload to a same-directory temporary
 *     file, hash-as-copied, fsync, then publish with an atomic hard link.
 *
 * Any failure removes the temporary file and the staged SQLite copy. The
 * target never exists in a partial state.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readdirSync, unlinkSync } from "node:fs";
import { link, lstat, open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { fieldDetails, storageDetails, storageError } from "../errors.js";
import { hashHex, sha256Bytes, sha256File } from "../hash.js";
import { SCHEMA_MAJOR, SCHEMA_META_KEYS, getSchemaMeta } from "../schema/meta.js";
import { openConfiguredConnection } from "../sqlite/pragmas.js";
import { readSqliteVersion } from "../sqlite/driver.js";
import type { SqliteConnection, SqliteDriver } from "../sqlite/driver.js";
import type { SqlRow } from "../types.js";
import {
  EXPORT_CONFIG_PATH,
  EXPORT_CONTAINER_MAGIC,
  EXPORT_CONTAINER_VERSION,
  EXPORT_DATABASE_PATH,
  EXPORT_FORMAT,
  EXPORT_HEADER_BYTES,
  EXPORT_MANIFEST_SCHEMA,
  MAX_EXPORT_MANIFEST_BYTES,
  computeManifestHash,
  isManifestHash,
  journalManifestPath,
  orderedSnapshotEntries,
  validateConfigText
} from "./format.js";
import type {
  ExportBlobEntry,
  ExportConfigEntry,
  ExportDatabaseEntry,
  ExportJournalEntry,
  ExportManifest,
  ExportManifestBody,
  SnapshotEntry,
  TableRowCount
} from "./format.js";

/** Absolute paths of the home parts a snapshot covers. */
interface SnapshotHomeLayout {
  readonly home: string;
  readonly db_path: string;
  readonly journal_dir: string;
  readonly blobs_dir: string;
  readonly config_path: string;
}

/** Builds the layout for a standard `<home>/db|journal|blobs` tree. */
export function snapshotHomeLayout(home: string): SnapshotHomeLayout {
  return {
    home,
    db_path: join(home, "db", "evoplug.sqlite"),
    journal_dir: join(home, "journal"),
    blobs_dir: join(home, "blobs"),
    config_path: join(home, EXPORT_CONFIG_PATH)
  };
}

interface ExportHomeSnapshotDeps {
  readonly layout: SnapshotHomeLayout;
  /** Package destination. Must not exist. */
  readonly out_path: string;
  readonly driver: SqliteDriver;
  /** Product version recorded in the manifest. */
  readonly product_version: string;
  /**
   * Canonical, already validated `config.json` text. The kernel reads and
   * validates the file before calling this function; a direct caller must do
   * the same. Secrets are re-checked here before the bytes enter the package.
   */
  readonly config_text: string;
  readonly now?: () => number;
}

interface ExportHomeSnapshotResult {
  readonly schema_version: "rsi.export_result/1";
  readonly out_path: string;
  readonly schema_major: number;
  readonly schema_minor: number;
  readonly manifest_hash: Hash;
  readonly database_bytes: number;
  readonly journal_files: number;
  readonly blob_files: number;
  /** Total package size in bytes. */
  readonly byte_length: number;
}

type SnapshotFailureStatus = "rejected" | "conflict" | "degraded" | "pending" | "unknown";

class SnapshotFailure extends Error {
  readonly status: SnapshotFailureStatus;
  readonly envelope: ErrorEnvelope;

  constructor(status: SnapshotFailureStatus, envelope: ErrorEnvelope) {
    super(envelope.code);
    this.name = "SnapshotFailure";
    this.status = status;
    this.envelope = envelope;
  }
}

function fail(status: SnapshotFailureStatus, envelope: ErrorEnvelope): never {
  throw new SnapshotFailure(status, envelope);
}

function ioFailure(operation: string, code?: string): ErrorEnvelope {
  return storageError({
    code: "E_STORAGE_IO",
    stage: "storage.snapshot.export",
    details: storageDetails(operation, code),
    side_effect: "none"
  });
}

function corruptFailure(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STORAGE_CORRUPT",
    stage: "storage.snapshot.export",
    details: fieldDetails(path, rule),
    side_effect: "none"
  });
}

function schemaFailure(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA",
    stage: "storage.snapshot.export",
    details: fieldDetails(path, rule),
    side_effect: "none"
  });
}

function unsupportedMajor(actual: number): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA_MAJOR_UNSUPPORTED",
    stage: "storage.snapshot.export",
    details: {
      kind: "version",
      expected: String(SCHEMA_MAJOR),
      actual: String(actual)
    },
    side_effect: "none"
  });
}

function conflictFailure(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_CONFLICT",
    stage: "storage.snapshot.export",
    details: fieldDetails(path, rule),
    side_effect: "none"
  });
}

function cleanupFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The file may not exist; cleanup is best effort.
  }
}

function cleanupSqliteFiles(path: string): void {
  cleanupFile(path);
  cleanupFile(`${path}-wal`);
  cleanupFile(`${path}-shm`);
}

function uniqueTempPath(target: string, suffix: string): string {
  return `${target}.${suffix}-${randomUUID()}`;
}

interface TableListRow extends SqlRow {
  readonly name: string;
}

interface CountRow extends SqlRow {
  readonly n: number;
}

function readTableRowCounts(connection: SqliteConnection): readonly TableRowCount[] {
  const tables = connection
    .prepare<TableListRow>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC`,
    )
    .all();
  const counts: TableRowCount[] = [];
  for (const row of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) {
      fail("rejected", corruptFailure("sqlite_master.name", "invalid_table_identifier"));
    }
    const count = connection
      .prepare<CountRow>(`SELECT COUNT(*) AS n FROM "${row.name}"`)
      .get();
    counts.push({ table: row.name, rows: count === undefined ? 0 : Number(count.n) });
  }
  return counts;
}

function assertQuickCheck(connection: SqliteConnection): void {
  const rows = connection.prepare<Record<string, string>>("PRAGMA quick_check").all();
  if (rows.length === 0) {
    fail("rejected", corruptFailure("database.quick_check", "no_result"));
  }
  for (const row of rows) {
    const value = Object.values(row)[0];
    if (value !== "ok") {
      fail("rejected", corruptFailure("database.quick_check", value ?? "failed"));
    }
  }
}

function assertForeignKeys(connection: SqliteConnection): void {
  const rows = connection.prepare<SqlRow>("PRAGMA foreign_key_check").all();
  if (rows.length > 0) {
    fail("rejected", corruptFailure("database.foreign_key_check", "violations"));
  }
}

interface JournalStateRow extends SqlRow {
  readonly journal_id: string;
  readonly relative_path: string;
  readonly trusted_prefix_end: number;
}

interface BlobRow extends SqlRow {
  readonly blob_hash: string;
  readonly byte_length: number;
  readonly relative_path: string;
}

interface CommitBlobRow extends SqlRow {
  readonly blob_hashes_json: string;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function listJournalFiles(directory: string): readonly string[] {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".rsij")) {
        names.push(entry.name);
      }
    }
    names.sort();
    return names;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return [];
    }
    fail("rejected", ioFailure("readdir_journal", typeof code === "string" ? code : undefined));
  }
}

function readJournalIds(
  connection: SqliteConnection,
): ReadonlyMap<string, { readonly journal_id: string; readonly trusted_prefix_end: number }> {
  const rows = connection
    .prepare<JournalStateRow>(
      `SELECT journal_id, relative_path, trusted_prefix_end
         FROM journal_state
        ORDER BY relative_path ASC`,
    )
    .all();
  const map = new Map<string, { readonly journal_id: string; readonly trusted_prefix_end: number }>();
  for (const row of rows) {
    map.set(journalManifestPath(row.relative_path), {
      journal_id: row.journal_id,
      trusted_prefix_end: Number(row.trusted_prefix_end)
    });
  }
  return map;
}

function readBlobRows(connection: SqliteConnection): readonly BlobRow[] {
  return connection
    .prepare<BlobRow>(
      `SELECT blob_hash, byte_length, relative_path
         FROM blob
        WHERE state = 'present'
        ORDER BY blob_hash ASC`,
    )
    .all();
}

function readReferencedBlobHashes(connection: SqliteConnection): ReadonlySet<Hash> {
  const hashes = new Set<Hash>();
  const rows = connection
    .prepare<CommitBlobRow>("SELECT blob_hashes_json FROM commit_record ORDER BY commit_seq ASC")
    .all();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.blob_hashes_json);
    } catch {
      fail("rejected", corruptFailure("commit_record.blob_hashes_json", "invalid_json"));
    }
    if (!Array.isArray(parsed)) {
      fail("rejected", corruptFailure("commit_record.blob_hashes_json", "not_an_array"));
    }
    for (const item of parsed) {
      if (typeof item !== "string" || !isManifestHash(item)) {
        fail("rejected", corruptFailure("commit_record.blob_hashes_json", "invalid_hash"));
      }
      hashes.add(item);
    }
  }
  return hashes;
}

async function buildJournalEntries(
  connection: SqliteConnection,
  layout: SnapshotHomeLayout,
): Promise<readonly ExportJournalEntry[]> {
  const states = readJournalIds(connection);
  const files = listJournalFiles(layout.journal_dir);
  const exported = new Set<string>();
  const entries: ExportJournalEntry[] = [];
  for (const name of files) {
    const relative = `journal/${name}`;
    const absolute = join(layout.journal_dir, name);
    let size: number;
    try {
      const stats = await stat(absolute);
      if (!stats.isFile()) {
        fail("rejected", corruptFailure(relative, "not_a_regular_file"));
      }
      size = stats.size;
    } catch (error) {
      if (error instanceof SnapshotFailure) {
        throw error;
      }
      fail("rejected", ioFailure("stat_journal"));
    }
    const state = states.get(relative);
    if (state !== undefined && state.trusted_prefix_end > size) {
      fail("rejected", corruptFailure(relative, "trusted_prefix_past_end"));
    }
    const hash = await sha256File(absolute).catch(() => {
      fail("rejected", ioFailure("hash_journal"));
    });
    entries.push({
      kind: "journal",
      path: relative,
      journal_id: state === undefined ? null : state.journal_id,
      byte_length: size,
      hash
    });
    exported.add(relative);
  }
  for (const relative of states.keys()) {
    if (!exported.has(relative)) {
      fail("rejected", corruptFailure(relative, "journal_file_missing"));
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

async function buildBlobEntries(
  connection: SqliteConnection,
  layout: SnapshotHomeLayout,
): Promise<readonly ExportBlobEntry[]> {
  const rows = readBlobRows(connection);
  const referenced = readReferencedBlobHashes(connection);
  const entries: ExportBlobEntry[] = [];
  const present = new Set<Hash>();
  for (const row of rows) {
    const hash = row.blob_hash;
    if (!isManifestHash(hash)) {
      fail("rejected", corruptFailure("blob.blob_hash", "invalid_hash"));
    }
    const expectedRelative = `sha256/${hashHex(hash)}`;
    if (normalizeRelativePath(row.relative_path) !== expectedRelative) {
      fail("rejected", corruptFailure("blob.relative_path", "path_does_not_match_hash"));
    }
    const absolute = join(layout.blobs_dir, "sha256", hashHex(hash));
    let size: number;
    try {
      const stats = await stat(absolute);
      if (!stats.isFile()) {
        fail("rejected", corruptFailure(`blobs/${expectedRelative}`, "not_a_regular_file"));
      }
      size = stats.size;
    } catch (error) {
      if (error instanceof SnapshotFailure) {
        throw error;
      }
      fail("rejected", corruptFailure(`blobs/${expectedRelative}`, "blob_file_missing"));
    }
    if (size !== Number(row.byte_length)) {
      fail("rejected", corruptFailure(`blobs/${expectedRelative}`, "byte_length_mismatch"));
    }
    const actual = await sha256File(absolute).catch(() => {
      fail("rejected", ioFailure("hash_blob"));
    });
    if (actual !== hash) {
      fail("rejected", corruptFailure(`blobs/${expectedRelative}`, "hash_mismatch"));
    }
    entries.push({
      kind: "blob",
      path: `blobs/${expectedRelative}`,
      hash,
      byte_length: size
    });
    present.add(hash);
  }
  for (const hash of referenced) {
    if (!present.has(hash)) {
      fail("rejected", corruptFailure("blob.blob_hash", "referenced_blob_not_present"));
    }
  }
  entries.sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0));
  return entries;
}

interface DatabaseSnapshot {
  readonly database: ExportDatabaseEntry;
  readonly schema_minor: number;
}

async function createDatabaseSnapshot(
  deps: ExportHomeSnapshotDeps,
  temporarySqlite: string,
): Promise<DatabaseSnapshot> {
  const opened = openConfiguredConnection(deps.driver, deps.layout.db_path, { readOnly: true });
  if (!opened.ok) {
    fail(opened.status, opened.error);
  }
  const source = opened.value.connection;
  let major: number;
  let minor: number;
  try {
    const majorText = getSchemaMeta(source, SCHEMA_META_KEYS.schema_major);
    const minorText = getSchemaMeta(source, SCHEMA_META_KEYS.schema_minor);
    const parsedMajor = majorText === null ? null : Number(majorText);
    const parsedMinor = minorText === null ? null : Number(minorText);
    if (
      parsedMajor === null ||
      parsedMinor === null ||
      !Number.isSafeInteger(parsedMajor) ||
      !Number.isSafeInteger(parsedMinor)
    ) {
      fail("rejected", corruptFailure("schema_meta", "invalid_schema_version"));
    }
    if (parsedMajor !== SCHEMA_MAJOR) {
      fail("rejected", unsupportedMajor(parsedMajor));
    }
    major = parsedMajor;
    minor = parsedMinor;
    await deps.driver.backup(source, temporarySqlite);
  } catch (error) {
    if (error instanceof SnapshotFailure) {
      throw error;
    }
    fail("rejected", ioFailure("sqlite_backup"));
  } finally {
    try {
      source.close();
    } catch {
      // The backup already completed or the connection is unusable.
    }
  }

  // Verify the copy itself. The copy is ours, so open it read-write to run the
  // checks and to leave a self-contained DELETE-journal file for transport.
  let connection: SqliteConnection;
  try {
    connection = deps.driver.open(temporarySqlite, { readOnly: false });
    readSqliteVersion(connection);
  } catch {
    fail("rejected", ioFailure("open_snapshot"));
  }
  let snapshotRowCounts: readonly TableRowCount[] = [];
  try {
    assertQuickCheck(connection);
    assertForeignKeys(connection);
    const copyMajor = getSchemaMeta(connection, SCHEMA_META_KEYS.schema_major);
    const copyMinor = getSchemaMeta(connection, SCHEMA_META_KEYS.schema_minor);
    if (copyMajor !== String(major) || copyMinor !== String(minor)) {
      fail("rejected", corruptFailure("schema_meta", "snapshot_schema_mismatch"));
    }
    const rowCounts = readTableRowCounts(connection);
    const journalMode = connection
      .prepare<Record<string, string>>("PRAGMA journal_mode=DELETE")
      .get();
    if (journalMode === undefined || Object.values(journalMode)[0] !== "delete") {
      fail("rejected", ioFailure("snapshot_journal_mode"));
    }
    snapshotRowCounts = rowCounts;
  } catch (error) {
    if (error instanceof SnapshotFailure) {
      throw error;
    }
    fail("rejected", corruptFailure("database", "snapshot_verification_failed"));
  } finally {
    try {
      connection.close();
    } catch {
      // Best effort; the staged file is deleted by the caller on failure.
    }
  }

  // Measure only after the connection is closed: the final close can still
  // checkpoint the staged file, so hashing before it would race with export.
  const bytes = await stat(temporarySqlite).catch(() => {
    fail("rejected", ioFailure("stat_snapshot"));
  });
  const hash = await sha256File(temporarySqlite).catch(() => {
    fail("rejected", ioFailure("hash_snapshot"));
  });
  return {
    database: {
      kind: "database",
      path: EXPORT_DATABASE_PATH,
      byte_length: bytes.size,
      hash,
      quick_check: "ok",
      foreign_key_check: "ok",
      table_row_counts: snapshotRowCounts
    },
    schema_minor: minor
  };
}

function buildConfigEntry(configText: string): ExportConfigEntry {
  const validated = validateConfigText(configText);
  if (!validated.ok) {
    fail("rejected", validated.error);
  }
  const bytes = Buffer.from(configText, "utf8");
  return {
    kind: "config",
    path: EXPORT_CONFIG_PATH,
    byte_length: bytes.byteLength,
    hash: sha256Bytes(new Uint8Array(bytes))
  };
}

function encodeHeader(manifestBytes: Uint8Array): Buffer {
  const header = Buffer.alloc(EXPORT_HEADER_BYTES);
  Buffer.from(EXPORT_CONTAINER_MAGIC).copy(header, 0);
  header.writeUInt32BE(EXPORT_CONTAINER_VERSION, 8);
  header.writeUInt32BE(manifestBytes.byteLength, 12);
  return header;
}

async function writeEntryPayload(
  handle: Awaited<ReturnType<typeof open>>,
  entry: SnapshotEntry,
  absolutePath: string,
): Promise<void> {
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of createReadStream(absolutePath)) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), "utf8");
      hash.update(bytes);
      total += bytes.byteLength;
      await handle.write(bytes);
    }
  } catch {
    fail("rejected", ioFailure("write_package_payload"));
  }
  if (total !== entry.byte_length) {
    fail("rejected", corruptFailure(entry.path, "byte_length_changed_during_export"));
  }
  const actual = `sha256:${hash.digest("hex")}`;
  if (actual !== entry.hash) {
    fail("rejected", corruptFailure(entry.path, "hash_changed_during_export"));
  }
}

function payloadPath(
  layout: SnapshotHomeLayout,
  entry: SnapshotEntry,
  databaseSnapshotPath: string,
): string {
  switch (entry.kind) {
    case "database":
      return databaseSnapshotPath;
    case "journal":
      return join(layout.home, entry.path);
    case "blob":
      return join(layout.home, entry.path);
    case "config":
      return layout.config_path;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => null);
  if (handle === null) {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform; the link is still
    // the atomic publication point.
  } finally {
    await handle.close();
  }
}

/**
 * Produces one `evoplug.export/1` package at `deps.out_path`.
 *
 * The database copy is verified before any journal, blob or config bytes are
 * read. The target is published with `link(2)` so an existing target is never
 * overwritten, even if it appears during the export.
 */
export async function exportHomeSnapshot(
  deps: ExportHomeSnapshotDeps,
): Promise<Result<ExportHomeSnapshotResult, ErrorEnvelope>> {
  const now = deps.now ?? ((): number => Date.now());
  const target = deps.out_path;
  const temporarySqlite = uniqueTempPath(target, "db");
  const temporaryPackage = uniqueTempPath(target, "pkg");
  let published = false;
  try {
    const existing = await lstat(target).catch(() => null);
    if (existing !== null) {
      return {
        ok: false,
        status: "conflict",
        error: conflictFailure("out", "target_exists")
      };
    }
    const parent = dirname(target);
    const parentStats = await stat(parent).catch(() => null);
    if (parentStats === null || !parentStats.isDirectory()) {
      return {
        ok: false,
        status: "rejected",
        error: ioFailure("out_parent", "ENOENT")
      };
    }

    const snapshot = await createDatabaseSnapshot(deps, temporarySqlite);
    let journal: readonly ExportJournalEntry[];
    let blobs: readonly ExportBlobEntry[];
    const snapshotConnection = deps.driver.open(temporarySqlite, { readOnly: true });
    try {
      journal = await buildJournalEntries(snapshotConnection, deps.layout);
      blobs = await buildBlobEntries(snapshotConnection, deps.layout);
    } finally {
      snapshotConnection.close();
    }
    const config = buildConfigEntry(deps.config_text);

    const body: ExportManifestBody = {
      schema_version: EXPORT_MANIFEST_SCHEMA,
      format: EXPORT_FORMAT,
      created_at: now(),
      product_version: deps.product_version,
      schema_major: SCHEMA_MAJOR,
      schema_minor: snapshot.schema_minor,
      database: snapshot.database,
      journal,
      blobs,
      config
    };
    const manifest: ExportManifest = {
      ...body,
      manifest_hash: computeManifestHash(body)
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    if (manifestBytes.byteLength > MAX_EXPORT_MANIFEST_BYTES) {
      return { ok: false, status: "rejected", error: schemaFailure("manifest", "too_large") };
    }

    const handle = await open(temporaryPackage, "wx", 0o600).catch((error: unknown) => {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      fail("rejected", ioFailure("create_package", typeof code === "string" ? code : undefined));
    });
    try {
      await handle.write(encodeHeader(manifestBytes));
      await handle.write(manifestBytes);
      for (const entry of orderedSnapshotEntries(manifest)) {
        await writeEntryPayload(handle, entry, payloadPath(deps.layout, entry, temporarySqlite));
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    const packageStats = await stat(temporaryPackage).catch(() => {
      fail("rejected", ioFailure("stat_package"));
    });
    try {
      await link(temporaryPackage, target);
      published = true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === "EEXIST") {
        return { ok: false, status: "conflict", error: conflictFailure("out", "target_exists") };
      }
      fail("rejected", ioFailure("publish_package", typeof code === "string" ? code : undefined));
    }
    await unlink(temporaryPackage).catch(() => undefined);
    await syncDirectory(parent);

    return {
      ok: true,
      status: "ok",
      value: {
        schema_version: "rsi.export_result/1",
        out_path: target,
        schema_major: SCHEMA_MAJOR,
        schema_minor: snapshot.schema_minor,
        manifest_hash: manifest.manifest_hash,
        database_bytes: snapshot.database.byte_length,
        journal_files: journal.length,
        blob_files: blobs.length,
        byte_length: packageStats.size
      }
    };
  } catch (error) {
    if (error instanceof SnapshotFailure) {
      return { ok: false, status: error.status, error: error.envelope };
    }
    return {
      ok: false,
      status: "rejected",
      error: ioFailure("export_unexpected")
    };
  } finally {
    if (!published) {
      cleanupFile(temporaryPackage);
    }
    cleanupSqliteFiles(temporarySqlite);
  }
}
