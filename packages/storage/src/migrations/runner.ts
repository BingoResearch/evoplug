import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { fieldDetails, storageDetails, storageError } from "../errors.js";
import { sha256Bytes, sha256Text } from "../hash.js";
import type { SqlRow } from "../types.js";
import type { SqliteConnection } from "../sqlite/driver.js";
import { createTransactionRunner } from "../sqlite/tx.js";
import {
  BASELINE_SCHEMA_MAJOR,
  BASELINE_SCHEMA_MINOR,
  SCHEMA_MAJOR,
  SCHEMA_MINOR,
  SCHEMA_META_KEYS,
  compareSchemaVersions,
  ensureSchemaMeta,
  setSchemaMeta,
  tryReadSchemaVersion
} from "../schema/meta.js";
import type { SchemaVersion } from "../schema/meta.js";

export interface MigrationFile {
  /** Ordering key recorded in `schema_migration.version`. */
  readonly version: number;
  readonly major: number;
  readonly minor: number;
  readonly owner: string;
  readonly name: string;
  readonly file_name: string;
  readonly path: string;
  readonly checksum: Hash;
  /**
   * Checksum recorded by homes that applied this artifact before its fenced
   * directive block existed. The block only carries version metadata, so the
   * stripped artifact is byte-identical to the previously shipped file and has
   * the same SQL effect. `null` when the artifact has no directive block.
   */
  readonly legacy_checksum: Hash | null;
  readonly sql: string;
  /**
   * Schema version the database must report after this artifact is applied.
   * Declared by a `-- evoplug:schema_major=N` directive, by the two-part
   * `<major>_<minor>_<owner>_<name>` name, or by the frozen baseline version.
   */
  readonly target_schema: SchemaVersion;
}

export interface AppliedMigration extends SqlRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: number;
  readonly app_version: string;
}

export interface MigrationResult {
  readonly applied: readonly MigrationFile[];
  readonly already_applied: number;
  readonly schema: SchemaVersion;
}

export interface RunMigrationsOptions {
  readonly connection: SqliteConnection;
  /** Directory containing `*.sql` migrations. */
  readonly directory: string;
  readonly app_version: string;
  readonly now?: () => number;
  /** Mandatory before applying migrations to a populated database. */
  readonly backup?: (destination: string) => Promise<void>;
  /** Destination for the pre-migration backup. */
  readonly backup_path?: string;
}

interface ParsedName {
  readonly major: number;
  readonly minor: number;
  readonly owner: string;
  readonly name: string;
  readonly version: number;
  /** True for the documented `<major>_<minor>_<owner>_<name>` form. */
  readonly two_part: boolean;
}

/** Baseline artifacts written before per-file version directives existed. */
const BASELINE_SCHEMA: SchemaVersion = Object.freeze({
  schema_major: BASELINE_SCHEMA_MAJOR,
  schema_minor: BASELINE_SCHEMA_MINOR
});

/**
 * A migration may declare the schema version it produces. This keeps the
 * frozen file names (and their checksums) untouched while still allowing a
 * major upgrade in place:
 *
 *   -- evoplug:schema_major=3
 *   -- evoplug:schema_minor=0
 *
 * An artifact without a directive is either a two-part name (whose major and
 * minor are authoritative) or a frozen baseline (major 2.0).
 */
const SCHEMA_MAJOR_DIRECTIVE = /^\s*--\s*evoplug:schema_major\s*=\s*(\d+)\s*$/im;
const SCHEMA_MINOR_DIRECTIVE = /^\s*--\s*evoplug:schema_minor\s*=\s*(\d+)\s*$/im;
const DIRECTIVE_BLOCK_BEGIN = /^\s*--\s*evoplug:directive:begin\s*$/;
const DIRECTIVE_BLOCK_END = /^\s*--\s*evoplug:directive:end\s*$/;

/**
 * Removes a fenced directive block, reproducing the bytes of the artifact as
 * it shipped before the block was added. Artifacts with no fence return
 * `null`, so only artifacts that explicitly opt in gain a legacy checksum.
 */
function stripDirectiveBlock(text: string): string | null {
  const lines = text.split("\n");
  const begin = lines.findIndex((line) => DIRECTIVE_BLOCK_BEGIN.test(line));
  if (begin < 0) {
    return null;
  }
  const end = lines.findIndex(
    (line, index) => index > begin && DIRECTIVE_BLOCK_END.test(line),
  );
  if (end < 0) {
    return null;
  }
  return [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n");
}

function parseSchemaTarget(sql: string): SchemaVersion | null {
  const majorMatch = SCHEMA_MAJOR_DIRECTIVE.exec(sql);
  if (majorMatch === null) {
    return null;
  }
  const major = Number(majorMatch[1]);
  if (!Number.isSafeInteger(major) || major < 1) {
    return null;
  }
  const minorMatch = SCHEMA_MINOR_DIRECTIVE.exec(sql);
  const minor = minorMatch === null ? 0 : Number(minorMatch[1]);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    return null;
  }
  return { schema_major: major, schema_minor: minor };
}

function targetSchemaOf(parsed: ParsedName, sql: string): SchemaVersion | null {
  const declared = parseSchemaTarget(sql);
  if (declared !== null) {
    return declared;
  }
  if (parsed.two_part) {
    return { schema_major: parsed.major, schema_minor: parsed.minor };
  }
  return BASELINE_SCHEMA;
}

function parseMigrationFileName(fileName: string): ParsedName | null {
  if (!fileName.endsWith(".sql")) {
    return null;
  }
  const base = fileName.slice(0, -".sql".length);
  const full = /^(\d+)_(\d+)_([a-z][a-z0-9]*)_(.+)$/.exec(base);
  if (full !== null) {
    const major = Number(full[1]);
    const minor = Number(full[2]);
    const owner = full[3];
    const name = full[4];
    if (
      !Number.isSafeInteger(major) ||
      !Number.isSafeInteger(minor) ||
      owner === undefined ||
      name === undefined
    ) {
      return null;
    }
    return { major, minor, owner, name, version: major * 10000 + minor, two_part: true };
  }
  const baseline = /^(\d+)_([a-z][a-z0-9_]*)$/.exec(base);
  if (baseline !== null) {
    const major = Number(baseline[1]);
    const name = baseline[2];
    if (!Number.isSafeInteger(major) || name === undefined) {
      return null;
    }
    return { major, minor: 0, owner: "fnd", name, version: major, two_part: false };
  }
  return null;
}

/** Reads and checksums every migration in `directory`, ordered by version. */
export function discoverMigrations(
  directory: string,
): Result<readonly MigrationFile[], ErrorEnvelope> {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_SCHEMA",
        stage: "storage.migration",
        details: storageDetails("read_directory", typeof code === "string" ? code : undefined)
      })
    };
  }
  const files: MigrationFile[] = [];
  const versions = new Set<number>();
  for (const entry of entries) {
    const parsed = parseMigrationFileName(entry);
    if (parsed === null) {
      continue;
    }
    const path = join(directory, entry);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_MIGRATION",
          stage: "storage.migration",
          details: storageDetails("read_migration", entry),
          message_key: "error.storage.migration_unreadable"
        })
      };
    }
    if (versions.has(parsed.version)) {
      return {
        ok: false,
        status: "conflict",
        error: storageError({
          code: "E_SCHEMA",
          stage: "storage.migration",
          details: fieldDetails("version", `duplicate_${parsed.version}`)
        })
      };
    }
    versions.add(parsed.version);
    const sql = bytes.toString("utf8");
    const targetSchema = targetSchemaOf(parsed, sql);
    if (targetSchema === null) {
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure("invalid_schema_target", entry)
      };
    }
    const stripped = stripDirectiveBlock(sql);
    files.push({
      version: parsed.version,
      major: parsed.major,
      minor: parsed.minor,
      owner: parsed.owner,
      name: parsed.name,
      file_name: entry,
      path,
      checksum: sha256Bytes(new Uint8Array(bytes)),
      legacy_checksum: stripped === null ? null : sha256Text(stripped),
      sql,
      target_schema: targetSchema
    });
  }
  files.sort((left, right) => left.version - right.version);
  return { ok: true, status: "ok", value: files };
}

function hasSchemaMigrationTable(connection: SqliteConnection): boolean {
  const row = connection
    .prepare<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'`,
    )
    .get();
  return row !== undefined;
}

function readAppliedMigrations(connection: SqliteConnection): readonly AppliedMigration[] {
  return connection
    .prepare<AppliedMigration>(
      `SELECT version, name, checksum, applied_at, app_version
         FROM schema_migration
        ORDER BY version ASC`,
    )
    .all();
}

function hasTable(connection: SqliteConnection, name: string): boolean {
  const row = connection
    .prepare<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = :name`,
    )
    .get({ name });
  return row !== undefined;
}

function schemaFailure(detail: string, path = "schema_migration"): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA",
    stage: "storage.migration",
    details: fieldDetails(path, detail)
  });
}

function unsupportedSchemaVersion(expected: SchemaVersion, actual: SchemaVersion): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA_MAJOR_UNSUPPORTED",
    stage: "storage.migration",
    details: {
      kind: "version",
      expected: `${String(expected.schema_major)}.${String(expected.schema_minor)}`,
      actual: `${String(actual.schema_major)}.${String(actual.schema_minor)}`
    }
  });
}

function backupFailure(rule: "required_before_migration" | "failed"): ErrorEnvelope {
  return storageError({
    code: "E_STORAGE_MIGRATION",
    stage: "storage.migration",
    details: fieldDetails("backup", rule),
    message_key:
      rule === "required_before_migration"
        ? "error.storage.migration_backup_required"
        : "error.storage.migration_backup_failed"
  });
}

/** A backup counts only when the callback actually left a non-empty file. */
function backupWasWritten(destination: string): boolean {
  try {
    const info = statSync(destination);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Advances `schema_meta` to `target`. A target older than the persisted
 * version is a migration-order defect, never a silent downgrade.
 */
function applySchemaTarget(
  source: Parameters<typeof ensureSchemaMeta>[0],
  target: SchemaVersion,
  now: number,
): SchemaVersion {
  ensureSchemaMeta(source, now, target);
  const current = tryReadSchemaVersion(source);
  if (current === null) {
    throw new Error("schema_major_missing");
  }
  const order = compareSchemaVersions(target, current);
  if (order < 0) {
    throw new Error(
      `schema_version_regression_${String(current.schema_major)}.${String(current.schema_minor)}_to_${String(target.schema_major)}.${String(target.schema_minor)}`,
    );
  }
  if (order === 0) {
    return current;
  }
  setSchemaMeta(source, SCHEMA_META_KEYS.schema_major, String(target.schema_major), now);
  setSchemaMeta(source, SCHEMA_META_KEYS.schema_minor, String(target.schema_minor), now);
  return target;
}

/** Highest target version declared by the artifacts already recorded. */
function inferSchemaVersion(
  appliedRows: readonly AppliedMigration[],
  byVersion: ReadonlyMap<number, MigrationFile>,
): SchemaVersion {
  let version = BASELINE_SCHEMA;
  for (const row of appliedRows) {
    const file = byVersion.get(Number(row.version));
    if (file !== undefined && compareSchemaVersions(file.target_schema, version) > 0) {
      version = file.target_schema;
    }
  }
  return version;
}

/**
 * Accepts the current artifact checksum and the checksum recorded by homes
 * that ran the artifact before its fenced directive block existed. The fence
 * contains version metadata only, so both bytes describe the same schema.
 */
function appliedChecksumMatches(applied: AppliedMigration, file: MigrationFile): boolean {
  return (
    applied.checksum === file.checksum ||
    (file.legacy_checksum !== null && applied.checksum === file.legacy_checksum)
  );
}

/**
 * Applies pending migrations in `BEGIN IMMEDIATE` transactions and records
 * their SHA-256 checksums. Applied migrations are never edited in place: a
 * checksum mismatch refuses startup instead of repairing silently.
 *
 * A migrated database is upgraded in place only after a backup callback has
 * produced a non-empty file at `backup_path`; a missing, throwing or no-op
 * backup leaves every migration unapplied. A fresh database (no
 * `schema_migration` table) has nothing to back up and is created directly.
 *
 * A database whose persisted major is newer than this binary refuses with
 * `E_SCHEMA_MAJOR_UNSUPPORTED` before any checksum comparison, so a downgrade
 * never looks like a checksum defect. An older major is upgraded by the
 * pending artifacts, whose target version comes from their directive or name.
 */
export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<Result<MigrationResult, ErrorEnvelope>> {
  const discovered = discoverMigrations(options.directory);
  if (!discovered.ok) {
    return discovered;
  }
  const files = discovered.value;
  if (files.length === 0) {
    return {
      ok: false,
      status: "rejected",
      error: schemaFailure("no_migrations_found", "directory")
    };
  }
  const now = options.now ?? (() => Date.now());
  const populated = hasSchemaMigrationTable(options.connection);
  const appliedRows = populated ? readAppliedMigrations(options.connection) : [];
  const byVersion = new Map<number, MigrationFile>();
  for (const file of files) {
    byVersion.set(file.version, file);
  }
  const stored =
    populated && hasTable(options.connection, "schema_meta")
      ? tryReadSchemaVersion(options.connection)
      : null;
  const binaryVersion: SchemaVersion = {
    schema_major: SCHEMA_MAJOR,
    schema_minor: SCHEMA_MINOR
  };
  if (stored !== null && compareSchemaVersions(stored, binaryVersion) > 0) {
    return {
      ok: false,
      status: "rejected",
      error: unsupportedSchemaVersion(binaryVersion, stored)
    };
  }
  for (const applied of appliedRows) {
    const file = byVersion.get(Number(applied.version));
    if (file === undefined || !appliedChecksumMatches(applied, file)) {
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure(`checksum_mismatch_${applied.version}`)
      };
    }
  }
  const appliedVersions = new Set(appliedRows.map((row) => Number(row.version)));
  const pending = files.filter((file) => !appliedVersions.has(file.version));
  if (pending.length === 0) {
    /*
     * An old binary recorded 2.0 even after applying 0002, whose current
     * artifact declares 3.0. When every artifact is applied, the version
     * implied by the ledger is at least as authoritative as `schema_meta`;
     * advancing only the metadata runs no DDL, so no backup is involved.
     */
    const inferred = inferSchemaVersion(appliedRows, byVersion);
    const current =
      stored === null || compareSchemaVersions(inferred, stored) > 0 ? inferred : stored;
    if (compareSchemaVersions(current, binaryVersion) > 0) {
      return {
        ok: false,
        status: "rejected",
        error: unsupportedSchemaVersion(binaryVersion, current)
      };
    }
    if (current.schema_major !== SCHEMA_MAJOR) {
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure(`schema_major_incomplete_${String(current.schema_major)}`)
      };
    }
    if (populated) {
      try {
        createTransactionRunner(options.connection).withTxSync((tx) => {
          applySchemaTarget(tx, current, now());
          return undefined;
        });
      } catch (error) {
        return {
          ok: false,
          status: "rejected",
          error: schemaFailure(
            typeof error === "object" && error !== null && "message" in error
              ? String((error as { readonly message?: unknown }).message)
              : "schema_meta_unavailable",
          )
        };
      }
    }
    return {
      ok: true,
      status:
        stored === null || compareSchemaVersions(current, stored) > 0 ? "ok" : "no_op",
      value: {
        applied: [],
        already_applied: appliedRows.length,
        schema: current
      }
    };
  }
  let floor = stored ?? inferSchemaVersion(appliedRows, byVersion);
  for (const file of pending) {
    if (compareSchemaVersions(file.target_schema, binaryVersion) > 0) {
      return {
        ok: false,
        status: "rejected",
        error: unsupportedSchemaVersion(binaryVersion, file.target_schema)
      };
    }
    if (compareSchemaVersions(file.target_schema, floor) < 0) {
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure(`schema_target_regression_${file.file_name}`)
      };
    }
    floor = file.target_schema;
  }
  if (populated) {
    if (options.backup === undefined || options.backup_path === undefined) {
      return { ok: false, status: "rejected", error: backupFailure("required_before_migration") };
    }
    try {
      await options.backup(options.backup_path);
    } catch {
      return { ok: false, status: "rejected", error: backupFailure("failed") };
    }
    if (!backupWasWritten(options.backup_path)) {
      return { ok: false, status: "rejected", error: backupFailure("failed") };
    }
  }
  const runner = createTransactionRunner(options.connection);
  const appliedNow: MigrationFile[] = [];
  for (const file of pending) {
    try {
      runner.withTxSync((tx) => {
        tx.exec(file.sql);
        tx.prepare(
          `INSERT INTO schema_migration (version, name, checksum, applied_at, app_version)
           VALUES (:version, :name, :checksum, :applied_at, :app_version)`,
        ).run({
          version: file.version,
          name: file.file_name,
          /*
           * Record the directive-free checksum when the artifact has a fenced
           * block. Older binaries compare against the pre-directive bytes they
           * ship, so this keeps an upgraded home readable by a rollback binary
           * instead of surfacing a spurious `checksum_mismatch`.
           */
          checksum: file.legacy_checksum ?? file.checksum,
          applied_at: now(),
          app_version: options.app_version
        });
        applySchemaTarget(tx, file.target_schema, now());
        return undefined;
      });
    } catch (error) {
      const detail =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { readonly message?: unknown }).message)
          : "migration_failed";
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure(_truncate(detail, 200), file.file_name)
      };
    }
    appliedNow.push(file);
  }
  const schema = tryReadSchemaVersion(options.connection);
  if (schema === null) {
    return {
      ok: false,
      status: "rejected",
      error: schemaFailure("schema_major_missing")
    };
  }
  if (compareSchemaVersions(schema, binaryVersion) > 0) {
    return {
      ok: false,
      status: "rejected",
      error: unsupportedSchemaVersion(binaryVersion, schema)
    };
  }
  if (schema.schema_major !== SCHEMA_MAJOR) {
    return {
      ok: false,
      status: "rejected",
      error: schemaFailure(`schema_major_incomplete_${String(schema.schema_major)}`)
    };
  }
  return {
    ok: true,
    status: appliedNow.length > 0 ? "ok" : "no_op",
    value: { applied: appliedNow, already_applied: appliedRows.length, schema }
  };
}

function _truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/* ------------------------------------------------------------------ */
/* Domain migrations                                                   */
/* ------------------------------------------------------------------ */

export interface DomainMigrationOptions {
  readonly connection: SqliteConnection;
  /** Directory containing `<owner>/<sequence>_<name>.sql`. */
  readonly domains_root: string;
  readonly app_version: string;
  readonly now?: () => number;
  /**
   * True when the database file existed before this open. The kernel passes
   * `true` for serve/re-init of an existing home and `false` for a brand-new
   * home, so a destructive pending migration is never protected merely by the
   * domain ledger happening to have started.
   */
  readonly existing_database?: boolean;
  /**
   * Mandatory before applying a pending destructive domain migration to an
   * existing database. The callback must write a non-empty file to
   * `destination`; a missing, throwing or no-op backup applies nothing.
   */
  readonly backup?: (destination: string) => Promise<void>;
  /** Destination for the pre-domain-migration backup. */
  readonly backup_path?: string;
}

export interface DomainMigrationResult {
  readonly applied: readonly string[];
  readonly already_applied: number;
}

interface DomainMigrationFile {
  readonly owner: string;
  readonly sequence: number;
  readonly name: string;
  readonly path: string;
  readonly checksum: Hash;
  readonly sql: string;
}

function discoverDomainMigrationFiles(
  domainsRoot: string,
): Result<readonly DomainMigrationFile[], ErrorEnvelope> {
  if (!existsSync(domainsRoot)) {
    return { ok: true, status: "ok", value: [] };
  }
  const files: DomainMigrationFile[] = [];
  let owners: readonly string[];
  try {
    owners = readdirSync(domainsRoot)
      .filter((entry) => {
        try {
          return statSync(join(domainsRoot, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return {
      ok: false,
      status: "rejected",
      error: storageError({
        code: "E_SCHEMA",
        stage: "storage.migration",
        details: storageDetails("read_domains", typeof code === "string" ? code : undefined)
      })
    };
  }
  for (const owner of owners) {
    const ownerDir = join(domainsRoot, owner);
    let entries: readonly string[];
    try {
      entries = readdirSync(ownerDir).sort();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_SCHEMA",
          stage: "storage.migration",
          details: storageDetails("read_domain_directory", typeof code === "string" ? code : undefined)
        })
      };
    }
    for (const entry of entries) {
      if (!entry.endsWith(".sql")) continue;
      const match = /^(\d+)_(.+)\.sql$/.exec(entry);
      if (match === null) continue;
      const sequence = Number(match[1]);
      const name = match[2];
      if (!Number.isSafeInteger(sequence) || sequence <= 0 || name === undefined) {
        return {
          ok: false,
          status: "rejected",
          error: schemaFailure(`invalid_domain_migration_${owner}_${entry}`, entry)
        };
      }
      const path = join(ownerDir, entry);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (error) {
        return {
          ok: false,
          status: "rejected",
          error: storageError({
            code: "E_STORAGE_MIGRATION",
            stage: "storage.migration",
            details: storageDetails("read_domain_migration", entry),
            message_key: "error.storage.migration_unreadable"
          })
        };
      }
      files.push({
        owner,
        sequence,
        name: `${owner}/${entry}`,
        path,
        checksum: sha256Bytes(new Uint8Array(bytes)),
        sql: bytes.toString("utf8")
      });
    }
  }
  files.sort((left, right) =>
    left.owner === right.owner
      ? left.sequence - right.sequence
      : left.owner < right.owner
        ? -1
        : 1,
  );
  return { ok: true, status: "ok", value: files };
}

/**
 * A migration may opt into rebuilding a table that other tables reference.
 * SQLite cannot drop such a table while `foreign_keys=ON`, so the directive
 * turns the pragma off around the transaction and requires a
 * `PRAGMA foreign_key_check` pass before commit. The pragma is restored even
 * when the migration fails.
 */
const FOREIGN_KEYS_OFF_DIRECTIVE = /^\s*--\s*evoplug:foreign_keys\s*=\s*off\s*$/im;

/**
 * DDL that can remove rows or storage objects. Additive `ADD COLUMN` and
 * guarded `INSERT ... WHERE NOT EXISTS` seeds are not destructive.
 */
const DESTRUCTIVE_DDL =
  /\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b|\bALTER\s+TABLE\s+\S+\s+(?:RENAME\s+TO|DROP\s+COLUMN)\b/i;

const DESTRUCTIVE_TARGET =
  /\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)|\bALTER\s+TABLE\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+(?:RENAME\s+TO|DROP\s+COLUMN)\b/gi;

function isDestructiveDomainMigration(sql: string): boolean {
  return DESTRUCTIVE_DDL.test(sql.replace(/--[^\n]*/g, ""));
}

/** Schema objects a destructive migration removes or renames. */
function destructiveTargets(sql: string): readonly string[] {
  const names: string[] = [];
  for (const match of sql.replace(/--[^\n]*/g, "").matchAll(DESTRUCTIVE_TARGET)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/**
 * True when a destructive artifact would act on an object that already
 * exists. This detects a populated database even when the domain ledger is
 * empty, while a first pass on a fresh database sees none of its own objects.
 */
function destructiveTargetExists(connection: SqliteConnection, sql: string): boolean {
  for (const name of destructiveTargets(sql)) {
    const row = connection
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE name = :name")
      .get({ name });
    if (row !== undefined) {
      return true;
    }
  }
  return false;
}

interface AppliedDomainMigration extends SqlRow {
  readonly owner: string;
  readonly sequence: number;
  readonly name: string;
  readonly checksum: string;
}

function domainKey(owner: string, sequence: number): string {
  return `${owner}:${String(sequence)}`;
}

/**
 * Applies every domain owner's migrations in `(owner, sequence)` order.
 *
 * Domain migrations are tracked separately from the FND baseline so their
 * `0001` sequence numbers cannot collide with `schema_migration.version`.
 *
 * Pending detection is per `(owner, sequence)`. When an existing database has
 * a pending destructive migration (`DROP`/`RENAME`/`DROP COLUMN`), a verified
 * backup is produced first; otherwise — including a throwing or no-op backup —
 * no pending migration is executed. A database counts as existing when the
 * caller says so, when the domain ledger has rows, or when a destructive
 * artifact targets an object already present (so a legacy home with an empty
 * ledger is protected too). A first domain pass on a fresh database is created
 * directly because none of those objects exist yet.
 */
export async function runDomainMigrations(
  options: DomainMigrationOptions,
): Promise<Result<DomainMigrationResult, ErrorEnvelope>> {
  const discovered = discoverDomainMigrationFiles(options.domains_root);
  if (!discovered.ok) {
    return discovered;
  }
  const files = discovered.value;
  if (files.length === 0) {
    return { ok: true, status: "no_op", value: { applied: [], already_applied: 0 } };
  }
  const now = options.now ?? (() => Date.now());
  const populated = hasTable(options.connection, "domain_schema_migration");
  const appliedRows: readonly AppliedDomainMigration[] = populated
    ? options.connection
        .prepare<AppliedDomainMigration>(
          `SELECT owner, sequence, name, checksum
             FROM domain_schema_migration
            ORDER BY owner, sequence`,
        )
        .all()
    : [];
  const byKey = new Map<string, DomainMigrationFile>();
  for (const file of files) {
    byKey.set(domainKey(file.owner, file.sequence), file);
  }
  const appliedKeys = new Set<string>();
  for (const row of appliedRows) {
    const key = domainKey(row.owner, row.sequence);
    const file = byKey.get(key);
    if (file === undefined) {
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure(
          `domain_migration_missing_${row.owner}_${String(row.sequence)}`,
          row.name,
        )
      };
    }
    if (file.checksum !== row.checksum) {
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure(`domain_checksum_mismatch_${file.name}`, file.name)
      };
    }
    appliedKeys.add(key);
  }
  const pending = files.filter((file) => !appliedKeys.has(domainKey(file.owner, file.sequence)));
  if (pending.length === 0) {
    return {
      ok: true,
      status: "no_op",
      value: { applied: [], already_applied: appliedRows.length }
    };
  }
  const destructivePending = pending.filter((file) => isDestructiveDomainMigration(file.sql));
  const existing =
    options.existing_database ??
    (populated ||
      appliedRows.length > 0 ||
      destructivePending.some((file) => destructiveTargetExists(options.connection, file.sql)));
  if (existing && destructivePending.length > 0) {
    if (options.backup === undefined || options.backup_path === undefined) {
      return { ok: false, status: "rejected", error: backupFailure("required_before_migration") };
    }
    try {
      await options.backup(options.backup_path);
    } catch {
      return { ok: false, status: "rejected", error: backupFailure("failed") };
    }
    if (!backupWasWritten(options.backup_path)) {
      return { ok: false, status: "rejected", error: backupFailure("failed") };
    }
  }
  options.connection.exec(
    `CREATE TABLE IF NOT EXISTS domain_schema_migration (
       owner TEXT NOT NULL,
       sequence INTEGER NOT NULL CHECK (sequence > 0),
       name TEXT NOT NULL,
       checksum TEXT NOT NULL,
       applied_at INTEGER NOT NULL,
       app_version TEXT NOT NULL,
       PRIMARY KEY (owner, sequence)
     ) STRICT;`
  );
  const appliedNow: string[] = [];
  const runner = createTransactionRunner(options.connection);
  for (const file of pending) {
    const foreignKeysOff = FOREIGN_KEYS_OFF_DIRECTIVE.test(file.sql);
    if (foreignKeysOff) {
      options.connection.exec("PRAGMA foreign_keys = OFF");
    }
    try {
      runner.withTxSync((tx) => {
        tx.exec(file.sql);
        if (foreignKeysOff) {
          const violations = tx.prepare<{ table: string; rowid: number; parent: string }>(
            `PRAGMA foreign_key_check`
          ).all();
          if (violations.length > 0) {
            const first = violations[0];
            throw new Error(
              `foreign_key_check_failed:${first?.table ?? "?"}:${String(first?.rowid ?? "?")}:${first?.parent ?? "?"}`
            );
          }
        }
        tx.prepare(
          `INSERT INTO domain_schema_migration
             (owner, sequence, name, checksum, applied_at, app_version)
           VALUES (:owner, :sequence, :name, :checksum, :applied_at, :app_version)`
        ).run({
          owner: file.owner,
          sequence: file.sequence,
          name: file.name,
          checksum: file.checksum,
          applied_at: now(),
          app_version: options.app_version
        });
        return undefined;
      });
    } catch (error) {
      const detail =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { readonly message?: unknown }).message)
          : "domain_migration_failed";
      return {
        ok: false,
        status: "rejected",
        error: schemaFailure(_truncate(detail, 200), file.name)
      };
    } finally {
      if (foreignKeysOff) {
        options.connection.exec("PRAGMA foreign_keys = ON");
      }
    }
    appliedNow.push(file.name);
  }
  return {
    ok: true,
    status: appliedNow.length > 0 ? "ok" : "no_op",
    value: { applied: appliedNow, already_applied: appliedRows.length }
  };
}
