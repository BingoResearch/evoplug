/**
 * Home snapshot import (DD-FND-101, DD-FND-024, DD-FND-062, DD-FND-063).
 *
 * Import is staged: the package is extracted and every claim is verified in a
 * sibling directory, the staged home is made self-consistent (config
 * `product_home`, active `config_profile`, `init.complete.json`), and only then
 * is the staging directory renamed onto an empty target home. A failure before
 * the rename leaves the target untouched and removes the staging tree.
 *
 * Verification covers the container header, `manifest_hash`, every entry byte
 * count and SHA-256, `quick_check`, `foreign_key_check`, per-table row counts,
 * `journal_state` / `blob` / `commit_record` references, and the schema major.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { canonicalHash } from "@evoplug/core";
import { fieldDetails, storageDetails, storageError } from "../errors.js";
import { isHash } from "../hash.js";
import { createTransactionRunner } from "../sqlite/tx.js";
import { SCHEMA_MAJOR, SCHEMA_MINOR, SCHEMA_META_KEYS, getSchemaMeta } from "../schema/meta.js";
import type { SqliteConnection, SqliteDriver } from "../sqlite/driver.js";
import type { SqlRow } from "../types.js";
import { isRecord, jsonValueOf, readStringField } from "../types.js";
import {
  EXPORT_CONTAINER_MAGIC,
  EXPORT_CONTAINER_VERSION,
  EXPORT_HEADER_BYTES,
  MAX_EXPORT_MANIFEST_BYTES,
  journalManifestPath,
  orderedSnapshotEntries,
  parseExportManifest,
  rehomeConfigText,
  validateConfigText
} from "./format.js";
import type { ExportManifest, SnapshotEntry } from "./format.js";

export interface ImportHomeSnapshotDeps {
  readonly home: string;
  readonly in_path: string;
  readonly driver: SqliteDriver;
  /** Product version written to `init.complete.json`. */
  readonly product_version: string;
  /**
   * Schema major this importer supports (defaults to the binary's current
   * major). A package produced by a newer binary is rejected with
   * `E_SCHEMA_MAJOR_UNSUPPORTED`, never partially extracted.
   */
  readonly supported_schema_major?: number;
  /** Schema minor this importer supports; defaults to the binary's current. */
  readonly supported_schema_minor?: number;
  /**
   * Optional full config validation after `product_home` is rewritten to the
   * target home. The kernel passes its config parser; storage itself only
   * checks JSON shape and the plaintext-secret rule.
   */
  readonly validate_config_text?: (text: string) => Result<void, ErrorEnvelope>;
  readonly now?: () => number;
}

export interface ImportHomeSnapshotResult {
  readonly schema_version: "rsi.import_result/1";
  readonly home: string;
  readonly status: "imported";
  readonly schema_major: number;
  readonly schema_minor: number;
  readonly manifest_hash: Hash;
  readonly database_hash: Hash;
  readonly journal_files: number;
  readonly blob_files: number;
  readonly table_rows: number;
  readonly byte_length: number;
  /** True when `config.json` and `init.complete.json` were materialized. */
  readonly config_restored: boolean;
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
    stage: "storage.snapshot.import",
    details: storageDetails(operation, code),
    side_effect: "none"
  });
}

function corruptFailure(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STORAGE_CORRUPT",
    stage: "storage.snapshot.import",
    details: fieldDetails(path, rule),
    side_effect: "none"
  });
}

function schemaFailure(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA",
    stage: "storage.snapshot.import",
    details: fieldDetails(path, rule),
    side_effect: "none"
  });
}

function unsupportedVersion(expected: string, actual: string): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA_MAJOR_UNSUPPORTED",
    stage: "storage.snapshot.import",
    details: { kind: "version", expected, actual },
    side_effect: "none"
  });
}

function conflictFailure(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_CONFLICT",
    stage: "storage.snapshot.import",
    details: fieldDetails(path, rule),
    side_effect: "none"
  });
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) {
      fail("rejected", corruptFailure("package", "unexpected_eof"));
    }
    read += result.bytesRead;
  }
  return buffer;
}

function decodeHeader(header: Buffer): number {
  const magic = Buffer.from(EXPORT_CONTAINER_MAGIC);
  if (!header.subarray(0, magic.byteLength).equals(magic)) {
    fail("rejected", schemaFailure("package.magic", "invalid"));
  }
  const version = header.readUInt32BE(8);
  if (version !== EXPORT_CONTAINER_VERSION) {
    fail("rejected", schemaFailure("package.version", "unsupported"));
  }
  const manifestBytes = header.readUInt32BE(12);
  if (manifestBytes === 0 || manifestBytes > MAX_EXPORT_MANIFEST_BYTES) {
    fail("rejected", schemaFailure("package.manifest_bytes", "out_of_range"));
  }
  return manifestBytes;
}

function manifestFromBytes(bytes: Buffer): ExportManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("rejected", schemaFailure("manifest", "invalid_json"));
  }
  const manifest = parseExportManifest(parsed);
  if (!manifest.ok) {
    fail(manifest.status, manifest.error);
  }
  return manifest.value;
}

interface PackageLayout {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly manifest: ExportManifest;
  readonly payload_offset: number;
  readonly byte_length: number;
}

function entriesByteLength(entries: readonly SnapshotEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.byte_length;
    if (!Number.isSafeInteger(total)) {
      fail("rejected", schemaFailure("manifest", "payload_length_overflow"));
    }
  }
  return total;
}

async function readPackageLayout(path: string): Promise<PackageLayout> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    fail("rejected", ioFailure("open_package", errnoOf(error)));
  }
  try {
    const stats = await handle.stat();
    if (stats.size < EXPORT_HEADER_BYTES) {
      fail("rejected", schemaFailure("package", "short_header"));
    }
    const header = await readExact(handle, 0, EXPORT_HEADER_BYTES);
    const manifestBytes = decodeHeader(header);
    const payloadOffset = EXPORT_HEADER_BYTES + manifestBytes;
    if (stats.size < payloadOffset) {
      fail("rejected", schemaFailure("package", "short_manifest"));
    }
    const manifest = manifestFromBytes(await readExact(handle, EXPORT_HEADER_BYTES, manifestBytes));
    const payloadBytes = entriesByteLength(orderedSnapshotEntries(manifest));
    if (stats.size !== payloadOffset + payloadBytes) {
      fail("rejected", schemaFailure("package", "length_mismatch"));
    }
    return {
      handle,
      manifest,
      payload_offset: payloadOffset,
      byte_length: stats.size
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function safeDestination(staging: string, relativePath: string): string {
  const destination = resolve(staging, relativePath);
  const prefix = staging.endsWith(sep) ? staging : `${staging}${sep}`;
  if (!destination.startsWith(prefix)) {
    fail("rejected", schemaFailure(relativePath, "path_escape"));
  }
  return destination;
}

async function extractEntry(
  handle: Awaited<ReturnType<typeof open>>,
  entry: SnapshotEntry,
  position: number,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const output = await open(destination, "wx", 0o600).catch((error: unknown) => {
    fail("rejected", ioFailure("create_extracted_file", errnoOf(error)));
  });
  const hash = createHash("sha256");
  let remaining = entry.byte_length;
  let offset = position;
  const chunk = Buffer.allocUnsafe(Math.min(1_048_576, Math.max(1, entry.byte_length)));
  try {
    while (remaining > 0) {
      const length = Math.min(chunk.byteLength, remaining);
      const result = await handle.read(chunk, 0, length, offset);
      if (result.bytesRead === 0) {
        fail("rejected", corruptFailure(entry.path, "unexpected_eof"));
      }
      hash.update(chunk.subarray(0, result.bytesRead));
      await output.write(chunk, 0, result.bytesRead);
      offset += result.bytesRead;
      remaining -= result.bytesRead;
    }
    await output.sync();
  } finally {
    await output.close().catch(() => undefined);
  }
  const actual = `sha256:${hash.digest("hex")}`;
  if (actual !== entry.hash) {
    fail("rejected", corruptFailure(entry.path, "hash_mismatch"));
  }
}

interface TableCountRow extends SqlRow {
  readonly name: string;
}

interface CountRow extends SqlRow {
  readonly n: number;
}

function actualTableCounts(connection: SqliteConnection): ReadonlyMap<string, number> {
  const tables = connection
    .prepare<TableCountRow>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC`,
    )
    .all();
  const counts = new Map<string, number>();
  for (const row of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) {
      fail("rejected", corruptFailure("sqlite_master.name", "invalid_table_identifier"));
    }
    const count = connection.prepare<CountRow>(`SELECT COUNT(*) AS n FROM "${row.name}"`).get();
    counts.set(row.name, count === undefined ? 0 : Number(count.n));
  }
  return counts;
}

function verifyQuickCheck(connection: SqliteConnection): void {
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
  const foreignKeys = connection.prepare<SqlRow>("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    fail("rejected", corruptFailure("database.foreign_key_check", "violations"));
  }
}

function verifyRowCounts(connection: SqliteConnection, manifest: ExportManifest): number {
  const actual = actualTableCounts(connection);
  const expected = new Map<string, number>();
  for (const row of manifest.database.table_row_counts) {
    expected.set(row.table, row.rows);
  }
  if (actual.size !== expected.size) {
    fail("rejected", corruptFailure("database.table_row_counts", "table_set_mismatch"));
  }
  let total = 0;
  for (const [table, rows] of expected) {
    const found = actual.get(table);
    if (found === undefined || found !== rows) {
      fail("rejected", corruptFailure(`database.table_row_counts.${table}`, "row_count_mismatch"));
    }
    total += rows;
  }
  return total;
}

interface JournalStateRow extends SqlRow {
  readonly journal_id: string;
  readonly relative_path: string;
  readonly trusted_prefix_end: number;
}

function verifyJournalReferences(connection: SqliteConnection, manifest: ExportManifest): void {
  const byPath = new Map(manifest.journal.map((entry) => [entry.path, entry]));
  const rows = connection
    .prepare<JournalStateRow>(
      `SELECT journal_id, relative_path, trusted_prefix_end FROM journal_state`,
    )
    .all();
  const databaseIds = new Set<string>();
  for (const row of rows) {
    const relative = journalManifestPath(row.relative_path);
    const entry = byPath.get(relative);
    if (entry === undefined) {
      fail("rejected", corruptFailure(relative, "journal_file_not_in_package"));
    }
    if (entry.journal_id !== row.journal_id) {
      fail("rejected", corruptFailure(relative, "journal_id_mismatch"));
    }
    if (Number(row.trusted_prefix_end) > entry.byte_length) {
      fail("rejected", corruptFailure(relative, "trusted_prefix_past_end"));
    }
    databaseIds.add(row.journal_id);
  }
  for (const entry of manifest.journal) {
    if (entry.journal_id !== null && !databaseIds.has(entry.journal_id)) {
      fail("rejected", corruptFailure(entry.path, "journal_state_missing"));
    }
  }
}

interface BlobRow extends SqlRow {
  readonly blob_hash: string;
  readonly byte_length: number;
  readonly relative_path: string;
  readonly state: string;
}

interface CommitBlobRow extends SqlRow {
  readonly blob_hashes_json: string;
}

function verifyBlobReferences(connection: SqliteConnection, manifest: ExportManifest): void {
  const expected = new Map<string, { readonly byte_length: number }>();
  for (const entry of manifest.blobs) {
    expected.set(entry.hash, { byte_length: entry.byte_length });
  }
  const rows = connection
    .prepare<BlobRow>(`SELECT blob_hash, byte_length, relative_path, state FROM blob ORDER BY blob_hash ASC`)
    .all();
  const present = new Set<string>();
  for (const row of rows) {
    if (!isHash(row.blob_hash)) {
      fail("rejected", corruptFailure("blob.blob_hash", "invalid_hash"));
    }
    if (row.state !== "present") {
      if (expected.has(row.blob_hash)) {
        fail("rejected", corruptFailure("blob.state", "non_present_blob_exported"));
      }
      continue;
    }
    const entry = expected.get(row.blob_hash);
    if (entry === undefined) {
      fail("rejected", corruptFailure("blob.blob_hash", "present_blob_not_in_package"));
    }
    if (Number(row.byte_length) !== entry.byte_length) {
      fail("rejected", corruptFailure("blob.byte_length", "byte_length_mismatch"));
    }
    const hex = row.blob_hash.slice("sha256:".length);
    if (row.relative_path.replaceAll("\\", "/") !== `sha256/${hex}`) {
      fail("rejected", corruptFailure("blob.relative_path", "path_does_not_match_hash"));
    }
    present.add(row.blob_hash);
  }
  for (const hash of expected.keys()) {
    if (!present.has(hash)) {
      fail("rejected", corruptFailure("blob.blob_hash", "package_blob_not_present"));
    }
  }
  const commits = connection
    .prepare<CommitBlobRow>("SELECT blob_hashes_json FROM commit_record ORDER BY commit_seq ASC")
    .all();
  for (const commit of commits) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(commit.blob_hashes_json);
    } catch {
      fail("rejected", corruptFailure("commit_record.blob_hashes_json", "invalid_json"));
    }
    if (!Array.isArray(parsed)) {
      fail("rejected", corruptFailure("commit_record.blob_hashes_json", "not_an_array"));
    }
    for (const item of parsed) {
      if (typeof item !== "string" || !isHash(item)) {
        fail("rejected", corruptFailure("commit_record.blob_hashes_json", "invalid_hash"));
      }
      if (!expected.has(item)) {
        fail("rejected", corruptFailure("commit_record.blob_hashes_json", "referenced_blob_not_present"));
      }
    }
  }
}

interface ConfigIdentifiers {
  readonly config_version: string;
  readonly config_hash: Hash;
}

function computeConfigIdentifiers(canonicalText: string): ConfigIdentifiers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalText);
  } catch {
    fail("rejected", schemaFailure("config", "invalid_json"));
  }
  if (!isRecord(parsed)) {
    fail("rejected", schemaFailure("config", "must_be_object"));
  }
  const versionBody: Record<string, unknown> = { ...parsed };
  delete versionBody["product_home"];
  return {
    config_version: `cfgv:${canonicalHash(jsonValueOf(versionBody))}`,
    config_hash: canonicalHash(jsonValueOf(parsed))
  };
}

function applyConfigProfile(
  connection: SqliteConnection,
  configSpace: string,
  configVersion: string,
  configHash: Hash,
  canonicalText: string,
  now: number,
): void {
  const runner = createTransactionRunner(connection);
  runner.withTxSync((tx) => {
    tx.prepare(
      `UPDATE config_profile
          SET status = 'superseded'
        WHERE config_space = :config_space
          AND status = 'active'
          AND config_version <> :config_version`,
    ).run({ config_space: configSpace, config_version: configVersion });
    tx.prepare(
      `INSERT INTO config_profile (config_version, config_space, canonical_json, content_hash, status, created_at)
       VALUES (:config_version, :config_space, :canonical_json, :content_hash, 'active', :created_at)
       ON CONFLICT(config_version) DO UPDATE SET
         config_space = excluded.config_space,
         canonical_json = excluded.canonical_json,
         content_hash = excluded.content_hash,
         status = 'active'`,
    ).run({
      config_version: configVersion,
      config_space: configSpace,
      canonical_json: canonicalText,
      content_hash: configHash,
      created_at: now
    });
    return undefined;
  });
}

async function writeDurable(path: string, data: string): Promise<void> {
  const handle = await open(path, "w", 0o600).catch((error: unknown) => {
    fail("rejected", ioFailure("create_home_file", errnoOf(error)));
  });
  try {
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function materializeHomeMetadata(
  deps: ImportHomeSnapshotDeps,
  staging: string,
  manifest: ExportManifest,
  now: number,
  targetHome: string,
): Promise<boolean> {
  const configEntry = manifest.config;
  if (configEntry === null) {
    return false;
  }
  const stagedConfigPath = join(staging, configEntry.path);
  let raw: string;
  try {
    raw = await readFile(stagedConfigPath, "utf8");
  } catch {
    fail("rejected", ioFailure("read_staged_config"));
  }
  const validated = validateConfigText(raw);
  if (!validated.ok) {
    fail(validated.status, validated.error);
  }
  const rehomed = rehomeConfigText(raw, targetHome);
  if (!rehomed.ok) {
    fail(rehomed.status, rehomed.error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rehomed.value);
  } catch {
    fail("rejected", schemaFailure("config", "invalid_json"));
  }
  if (!isRecord(parsed)) {
    fail("rejected", schemaFailure("config", "must_be_object"));
  }
  const configSpace = readStringField(parsed, "config_space");
  if (configSpace === null || configSpace.length === 0) {
    fail("rejected", schemaFailure("config.config_space", "missing"));
  }
  const identifiers = computeConfigIdentifiers(rehomed.value);
  if (deps.validate_config_text !== undefined) {
    const validatedConfig = deps.validate_config_text(rehomed.value);
    if (!validatedConfig.ok) {
      fail(validatedConfig.status, validatedConfig.error);
    }
  }

  await writeDurable(stagedConfigPath, rehomed.value);

  const dbPath = join(staging, manifest.database.path);
  const connection = deps.driver.open(dbPath, { readOnly: false });
  let schemaMajor: number;
  let schemaMinor: number;
  try {
    const majorText = getSchemaMeta(connection, SCHEMA_META_KEYS.schema_major);
    const minorText = getSchemaMeta(connection, SCHEMA_META_KEYS.schema_minor);
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
    schemaMajor = parsedMajor;
    schemaMinor = parsedMinor;
    applyConfigProfile(
      connection,
      configSpace,
      identifiers.config_version,
      identifiers.config_hash,
      rehomed.value,
      now,
    );
  } finally {
    connection.close();
  }

  const marker = {
    root: targetHome,
    product_version: deps.product_version,
    schema_major: schemaMajor,
    config_version: identifiers.config_version,
    db_hash_marker: canonicalHash({
      schema_major: schemaMajor,
      schema_minor: schemaMinor,
      config_version: identifiers.config_version,
      config_hash: identifiers.config_hash
    }),
    created_at: now
  };
  await writeDurable(join(staging, "init.complete.json"), `${JSON.stringify(marker)}\n`);
  return true;
}

async function inspectTarget(home: string): Promise<"absent" | "empty"> {
  const view = await lstat(home).catch(() => null);
  if (view === null) {
    return "absent";
  }
  if (view.isSymbolicLink()) {
    fail("rejected", schemaFailure("home", "symlink_root"));
  }
  if (!view.isDirectory()) {
    fail("conflict", conflictFailure("home", "not_a_directory"));
  }
  let entries: readonly string[];
  try {
    entries = await readdir(home);
  } catch {
    fail("rejected", ioFailure("readdir_home"));
  }
  if (entries.length > 0) {
    fail("conflict", conflictFailure("home", "target_not_empty"));
  }
  return "empty";
}

async function createStagingTree(staging: string): Promise<void> {
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const directory of ["db", "journal", "blobs", "runtime", "quarantine", "backups", "logs"]) {
      await mkdir(join(staging, directory), { recursive: true, mode: 0o700 });
    }
    await mkdir(join(staging, "blobs", "sha256"), { recursive: true, mode: 0o700 });
  } catch (error) {
    fail("rejected", ioFailure("create_staging", errnoOf(error)));
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
    // Directory fsync is optional on some platforms.
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Verifies and imports one `evoplug.export/1` package into an absent or empty
 * home. The target is only replaced after the staged tree is complete and
 * verified; a failure never switches the home.
 */
export async function importHomeSnapshot(
  deps: ImportHomeSnapshotDeps,
): Promise<Result<ImportHomeSnapshotResult, ErrorEnvelope>> {
  const now = deps.now ?? ((): number => Date.now());
  const home = resolve(deps.home);
  const supportedMajor = deps.supported_schema_major ?? SCHEMA_MAJOR;
  const supportedMinor = deps.supported_schema_minor ?? SCHEMA_MINOR;
  if (
    !Number.isSafeInteger(supportedMajor) ||
    supportedMajor < 1 ||
    !Number.isSafeInteger(supportedMinor) ||
    supportedMinor < 0
  ) {
    return {
      ok: false,
      status: "rejected",
      error: schemaFailure("supported_schema_version", "invalid")
    };
  }
  let staging: string | null = null;
  let packageHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const layout = await readPackageLayout(deps.in_path);
    packageHandle = layout.handle;
    const manifest = layout.manifest;
    if (manifest.schema_major !== supportedMajor) {
      fail("rejected", unsupportedVersion(String(supportedMajor), String(manifest.schema_major)));
    }
    if (manifest.schema_minor > supportedMinor) {
      fail(
        "rejected",
        unsupportedVersion(
          `${String(supportedMajor)}.${String(supportedMinor)}`,
          `${String(manifest.schema_major)}.${String(manifest.schema_minor)}`,
        ),
      );
    }
    const targetState = await inspectTarget(home);
    const parent = dirname(home);
    const parentStats = await stat(parent).catch(() => null);
    if (parentStats === null || !parentStats.isDirectory()) {
      fail("rejected", ioFailure("home_parent", "ENOENT"));
    }
    staging = join(parent, `.${basename(home)}.import-${randomUUID()}`);
    await createStagingTree(staging);

    let position = layout.payload_offset;
    for (const entry of orderedSnapshotEntries(manifest)) {
      const destination = safeDestination(staging, entry.path);
      await extractEntry(layout.handle, entry, position, destination);
      position += entry.byte_length;
    }

    const dbPath = join(staging, manifest.database.path);
    const readOnly = deps.driver.open(dbPath, { readOnly: true });
    let tableRows: number;
    try {
      verifyQuickCheck(readOnly);
      tableRows = verifyRowCounts(readOnly, manifest);
      verifyJournalReferences(readOnly, manifest);
      verifyBlobReferences(readOnly, manifest);
      const persistedMajor = getSchemaMeta(readOnly, SCHEMA_META_KEYS.schema_major);
      const persistedMinor = getSchemaMeta(readOnly, SCHEMA_META_KEYS.schema_minor);
      if (persistedMajor !== String(manifest.schema_major)) {
        fail("rejected", corruptFailure("schema_meta.schema_major", "manifest_mismatch"));
      }
      if (persistedMinor !== String(manifest.schema_minor)) {
        fail("rejected", corruptFailure("schema_meta.schema_minor", "manifest_mismatch"));
      }
    } finally {
      readOnly.close();
    }

    const materialized = await materializeHomeMetadata(deps, staging, manifest, now(), home);
    // Publish only after every read and write succeeded.
    if (targetState === "empty") {
      try {
        await rmdir(home);
      } catch (error) {
        fail("conflict", conflictFailure("home", `rmdir_failed:${errnoOf(error) ?? "unknown"}`));
      }
    }
    try {
      await rename(staging, home);
    } catch (error) {
      if (targetState === "empty") {
        await mkdir(home, { mode: 0o700 }).catch(() => undefined);
        await syncDirectory(parent);
      }
      fail("rejected", ioFailure("publish_home", errnoOf(error)));
    }
    staging = null;
    await syncDirectory(parent);

    return {
      ok: true,
      status: "ok",
      value: {
        schema_version: "rsi.import_result/1",
        home,
        status: "imported",
        schema_major: manifest.schema_major,
        schema_minor: manifest.schema_minor,
        manifest_hash: manifest.manifest_hash,
        database_hash: manifest.database.hash,
        journal_files: manifest.journal.length,
        blob_files: manifest.blobs.length,
        table_rows: tableRows,
        byte_length: layout.byte_length,
        config_restored: materialized
      }
    };
  } catch (error) {
    if (error instanceof SnapshotFailure) {
      return { ok: false, status: error.status, error: error.envelope };
    }
    return { ok: false, status: "rejected", error: ioFailure("import_unexpected") };
  } finally {
    if (packageHandle !== null) {
      await packageHandle.close().catch(() => undefined);
    }
    if (staging !== null) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
