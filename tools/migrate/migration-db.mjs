// SQLite migration planning and execution (DD-FND-051, DD-FND-063).
//
// node:sqlite is used only by this development tool. Production code reaches
// SQLite exclusively through the SqliteDriver port in @evoplug/storage.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MIGRATION_CODES, hasForeignKeysOffDirective } from "./migration-files.mjs";

export const SCHEMA_META_DDL = `CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;`;

export const SCHEMA_MIGRATION_DDL = `CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  CHECK (version > 0)
) STRICT;`;

/**
 * Domain migrations have their own ledger in @evoplug/storage so their 0001
 * sequences cannot collide with schema_migration.version. This tool writes the
 * same shape; otherwise an app opening a home migrated here would see unknown
 * baseline rows.
 */
export const DOMAIN_SCHEMA_MIGRATION_DDL = `CREATE TABLE IF NOT EXISTS domain_schema_migration (
  owner TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  PRIMARY KEY (owner, sequence)
) STRICT;`;

/**
 * Open a SQLite database through node:sqlite.
 *
 * @param {string} file
 * @param {{ readOnly?: boolean }} [options]
 * @returns {DatabaseSync}
 */
export function openDatabase(file, options = {}) {
  return new DatabaseSync(file, options);
}

/**
 * Read the bundled SQLite version of an open connection.
 *
 * @param {DatabaseSync} db
 * @returns {string}
 */
export function readSqliteVersion(db) {
  const row = db.prepare("select sqlite_version() as version").get();
  return String(row?.version ?? "");
}

/**
 * True when a table exists in the main schema.
 *
 * @param {DatabaseSync} db
 * @param {string} name
 * @returns {boolean}
 */
export function hasTable(db, name) {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

/**
 * Create the two metadata tables when they are absent. The DDL is the
 * DD-FND-051 text with IF NOT EXISTS: a baseline artifact normally creates
 * them, so this only fills the gap for domain-only or empty migration sets and
 * is always called inside the migration transaction.
 *
 * @param {DatabaseSync} db
 */
export function ensureMetadataTables(db) {
  db.exec(SCHEMA_META_DDL);
  db.exec(SCHEMA_MIGRATION_DDL);
}

/**
 * @param {DatabaseSync} db
 * @returns {Array<{ version: number, name: string, checksum: string, applied_at: number, app_version: string }>}
 */
export function readAppliedMigrations(db) {
  if (!hasTable(db, "schema_migration")) {
    return [];
  }
  return db
    .prepare("SELECT version, name, checksum, applied_at, app_version FROM schema_migration ORDER BY version")
    .all();
}

/**
 * @param {DatabaseSync} db
 * @returns {Array<{ owner: string, sequence: number, name: string, checksum: string }>}
 */
export function readAppliedDomainMigrations(db) {
  if (!hasTable(db, "domain_schema_migration")) {
    return [];
  }
  return db
    .prepare("SELECT owner, sequence, name, checksum FROM domain_schema_migration ORDER BY owner, sequence")
    .all();
}

/**
 * @param {DatabaseSync} db
 * @returns {{ major: number | null, minor: number | null }}
 */
export function readSchemaMeta(db) {
  if (!hasTable(db, "schema_meta")) {
    return { major: null, minor: null };
  }
  const rows = db.prepare("SELECT key, value FROM schema_meta WHERE key IN ('schema_major','schema_minor')").all();
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const parse = (value) => {
    if (typeof value !== "string" || value === "") {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  return { major: parse(values.get("schema_major")), minor: parse(values.get("schema_minor")) };
}

/**
 * @param {DatabaseSync} db
 * @param {number} major
 * @param {number} minor
 * @param {number} now
 */
export function writeSchemaMeta(db, major, minor, now) {
  ensureMetadataTables(db);
  const statement = db.prepare(
    "INSERT INTO schema_meta(key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  statement.run("schema_major", String(major), now);
  statement.run("schema_minor", String(minor), now);
  db.exec(`PRAGMA user_version = ${major}`);
}

/**
 * Compute pending migrations and every integrity error.
 *
 * @param {Array<object>} entries ordered migration descriptors
 * @param {Array<{ version: number, name: string, checksum: string }>} applied
 * @returns {{
 *   errors: Array<{ code: string, message: string }>,
 *   pending: Array<{ entry: object, version: number }>
 * }}
 */
export function planMigrations(entries, applied) {
  const errors = [];
  const appliedByName = new Map(applied.map((row) => [row.name, row]));
  const entryByName = new Map(entries.map((entry) => [entry.baseName, entry]));

  for (const entry of entries) {
    const row = appliedByName.get(entry.baseName);
    if (row !== undefined && row.checksum !== entry.checksum) {
      errors.push({
        code: MIGRATION_CODES.checksum,
        message: `${entry.relativePath} checksum ${entry.checksum} does not match recorded ${row.checksum}`
      });
    }
  }
  for (const row of applied) {
    if (!entryByName.has(row.name)) {
      errors.push({
        code: MIGRATION_CODES.missingArtifact,
        message: `schema_migration records ${row.name}, but no migration artifact with that name exists`
      });
    }
  }

  const pending = entries.filter((entry) => !appliedByName.has(entry.baseName));

  let lastAppliedIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (appliedByName.has(entries[index].baseName)) {
      lastAppliedIndex = index;
    }
  }
  if (pending.length > 0) {
    const firstPendingIndex = entries.findIndex((entry) => !appliedByName.has(entry.baseName));
    if (firstPendingIndex < lastAppliedIndex) {
      errors.push({
        code: MIGRATION_CODES.order,
        message: `${entries[firstPendingIndex].relativePath} sorts before an already applied migration`
      });
    }
  }

  const highestVersion = applied.reduce((max, row) => (Number.isSafeInteger(row.version) && row.version > max ? row.version : max), 0);
  let nextVersion = highestVersion;
  const pendingWithVersions = pending.map((entry) => {
    const explicit = Number.isSafeInteger(entry.version) && entry.version > 0 ? entry.version : null;
    const version = explicit !== null && explicit > nextVersion ? explicit : nextVersion + 1;
    nextVersion = version;
    return { entry, version };
  });
  return { errors, pending: pendingWithVersions };
}

/**
 * Compute pending domain migrations against domain_schema_migration. Rows are
 * keyed by (owner, sequence), matching @evoplug/storage.
 *
 * @param {Array<object>} entries ordered domain descriptors
 * @param {Array<{ owner: string, sequence: number, checksum: string }>} applied
 * @returns {{ errors: Array<{ code: string, message: string }>, pending: Array<{ entry: object }> }}
 */
export function planDomainMigrations(entries, applied) {
  const keyOf = (value) => `${value.owner}:${String(value.sequence)}`;
  const errors = [];
  const appliedByKey = new Map(applied.map((row) => [keyOf(row), row]));
  const entryByKey = new Map(entries.map((entry) => [keyOf(entry), entry]));

  for (const entry of entries) {
    const row = appliedByKey.get(keyOf(entry));
    if (row !== undefined && row.checksum !== entry.checksum) {
      errors.push({
        code: MIGRATION_CODES.checksum,
        message: `${entry.relativePath} checksum ${entry.checksum} does not match recorded ${row.checksum}`
      });
    }
  }
  for (const row of applied) {
    if (!entryByKey.has(keyOf(row))) {
      errors.push({
        code: MIGRATION_CODES.missingArtifact,
        message: `domain_schema_migration records ${row.owner}/${String(row.sequence)}, but no migration artifact with that key exists`
      });
    }
  }

  const pending = entries.filter((entry) => !appliedByKey.has(keyOf(entry)));
  if (pending.length > 0) {
    const firstPendingIndex = entries.findIndex((entry) => !appliedByKey.has(keyOf(entry)));
    let lastAppliedIndex = -1;
    for (let index = 0; index < entries.length; index += 1) {
      if (appliedByKey.has(keyOf(entries[index]))) {
        lastAppliedIndex = index;
      }
    }
    if (firstPendingIndex < lastAppliedIndex) {
      errors.push({
        code: MIGRATION_CODES.order,
        message: `${entries[firstPendingIndex].relativePath} sorts before an already applied domain migration`
      });
    }
  }
  return { errors, pending: pending.map((entry) => ({ entry })) };
}

/**
 * Execute pending migrations, one BEGIN IMMEDIATE transaction per artifact.
 *
 * @param {DatabaseSync} db
 * @param {Array<{ entry: object, version: number }>} pending
 * @param {{ appVersion: string, now: number }} options
 * @returns {Array<{ name: string, version: number, checksum: string }>}
 */
export function applyMigrations(db, pending, options) {
  const applied = [];
  for (const { entry, version } of pending) {
    const foreignKeysOff = hasForeignKeysOffDirective(entry.sql);
    if (foreignKeysOff) {
      // PRAGMA foreign_keys is a no-op inside a transaction, so switch before
      // BEGIN and restore after COMMIT/ROLLBACK, exactly like the storage
      // runner's domain migration path.
      db.exec("PRAGMA foreign_keys = OFF");
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(entry.sql);
        if (foreignKeysOff) {
          const violations = db.prepare("PRAGMA foreign_key_check").all();
          if (violations.length > 0) {
            const first = violations[0];
            throw new Error(
              `foreign_key_check_failed:${String(first?.table ?? "?")}:${String(first?.rowid ?? "?")}:${String(
                first?.parent ?? "?"
              )}`
            );
          }
        }
        // A baseline artifact usually creates schema_migration itself; create it
        // only when the artifact did not, before recording the row.
        if (entry.group === 1) {
          db.exec(DOMAIN_SCHEMA_MIGRATION_DDL);
          db.prepare(
            "INSERT INTO domain_schema_migration(owner, sequence, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(entry.owner, entry.sequence, `${entry.owner}/${entry.baseName}`, entry.checksum, options.now, options.appVersion);
          applied.push({ name: `${entry.owner}/${entry.baseName}`, version: entry.sequence, checksum: entry.checksum });
        } else {
          ensureMetadataTables(db);
          db.prepare(
            "INSERT INTO schema_migration(version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)"
          ).run(version, entry.baseName, entry.checksum, options.now, options.appVersion);
          applied.push({ name: entry.baseName, version, checksum: entry.checksum });
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction may already be rolled back by SQLite.
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${entry.relativePath} failed: ${message}`);
      }
    } finally {
      if (foreignKeysOff) {
        db.exec("PRAGMA foreign_keys = ON");
      }
    }
  }
  return applied;
}

function quoteSqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Produce a consistent SQLite snapshot with VACUUM INTO and verify it with
 * PRAGMA quick_check (DD-FND-063: a failed backup blocks the migration).
 *
 * @param {DatabaseSync} db
 * @param {{ dbPath: string, backupDir: string, now: number }} options
 * @returns {{ ok: true, path: string } | { ok: false, message: string }}
 */
export function backupDatabase(db, options) {
  const stamp = new Date(options.now).toISOString().replace(/[:.]/g, "-");
  const target = resolve(join(options.backupDir, `${stamp}-${sanitizeFileName(options.dbPath)}`));
  try {
    mkdirSync(options.backupDir, { recursive: true });
  } catch (error) {
    return { ok: false, message: `cannot create backup directory: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    db.exec(`VACUUM INTO ${quoteSqlString(target)}`);
  } catch (error) {
    return { ok: false, message: `VACUUM INTO failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  let snapshot;
  try {
    snapshot = new DatabaseSync(target, { readOnly: true });
    const rows = snapshot.prepare("PRAGMA quick_check").all();
    const values = rows.map((row) => String(row.quick_check ?? row["quick_check"] ?? ""));
    if (values.length !== 1 || values[0] !== "ok") {
      return { ok: false, message: `backup quick_check returned ${values.join(", ") || "<empty>"}` };
    }
  } catch (error) {
    return { ok: false, message: `backup verification failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (snapshot !== undefined) {
      try {
        snapshot.close();
      } catch {
        // ignore close failures on an already unusable snapshot
      }
    }
  }
  return { ok: true, path: target };
}

function sanitizeFileName(value) {
  const base = value.replace(/\\/g, "/").split("/").pop() ?? "database.sqlite";
  return base.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * True when a database file exists and already holds content worth backing up.
 *
 * @param {string} dbPath
 * @returns {boolean}
 */
export function databaseNeedsBackup(dbPath) {
  return existsSync(dbPath) && statSync(dbPath).size > 0;
}
