#!/usr/bin/env node
// Ordered SQL migration runner for evoplug (DD-FND-050, DD-FND-063).
//
// Usage:
//   node tools/migrate/cli.mjs --db FILE [--root DIR] [--dry-run] [--json]
//   node tools/migrate/cli.mjs --home DIR [--dry-run]
//
// Applies migrations/sql/*.sql (FND baselines, cumulative by target major)
// followed by migrations/domains/<owner>/*.sql in (owner, sequence) order.
// Artifact targets come from `-- evoplug:schema_major/minor` directives, an
// explicit <major>_<minor>_<owner>_<name> name, or the frozen 2.0 baseline.
// Fenced directive blocks are stripped before checksumming so artifacts
// shipped by earlier binaries still match their recorded checksums. Every artifact
// is checksummed before and after the fact; a changed or missing artifact
// refuses the run. Migration happens inside BEGIN IMMEDIATE and is preceded by
// a mandatory VACUUM INTO backup verified with PRAGMA quick_check.
//
// Exit codes:
//   0  applied or nothing to do
//   1  checksum, order, schema or execution failure
//   2  invalid arguments
//   3  node:sqlite unavailable, unsafe SQLite version or unsupported schema major

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIGRATION_CODES,
  discoverMigrationFiles,
  selectMigrationSet
} from "./migration-files.mjs";
import { isSupportedSqliteVersion, SUPPORTED_SQLITE_RANGES } from "../verify-runtime/sqlite-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

const USAGE = `Usage: node tools/migrate/cli.mjs (--db FILE | --home DIR) [options]

Options:
  --db FILE            SQLite database file to migrate
  --home DIR           evoplug home; uses <DIR>/db/evoplug.sqlite
  --root DIR           repository root holding migrations/ (default: repository root)
  --schema-major N     target schema major (default: newest artifact)
  --backup-dir DIR     backup output directory (default: <database directory>/backups)
  --app-version VALUE  schema_migration.app_version (default: root package version)
  --dry-run            list pending migrations without writing anything
  --json               machine readable output
  --help               show this message

Exit codes: 0 applied/no-op, 1 failure, 2 invalid arguments, 3 unsupported runtime or schema major.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    db: null,
    home: null,
    root: DEFAULT_ROOT,
    schemaMajor: null,
    backupDir: null,
    appVersion: null,
    dryRun: false,
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${name} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--db") {
      options.db = resolve(takeValue("--db"));
    } else if (arg.startsWith("--db=")) {
      options.db = resolve(arg.slice("--db=".length));
    } else if (arg === "--home") {
      options.home = resolve(takeValue("--home"));
    } else if (arg.startsWith("--home=")) {
      options.home = resolve(arg.slice("--home=".length));
    } else if (arg === "--root") {
      options.root = resolve(takeValue("--root"));
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else if (arg === "--schema-major") {
      options.schemaMajor = parsePositiveInteger(takeValue("--schema-major"), "--schema-major");
    } else if (arg.startsWith("--schema-major=")) {
      options.schemaMajor = parsePositiveInteger(arg.slice("--schema-major=".length), "--schema-major");
    } else if (arg === "--backup-dir") {
      options.backupDir = resolve(takeValue("--backup-dir"));
    } else if (arg.startsWith("--backup-dir=")) {
      options.backupDir = resolve(arg.slice("--backup-dir=".length));
    } else if (arg === "--app-version") {
      options.appVersion = takeValue("--app-version");
    } else if (arg.startsWith("--app-version=")) {
      options.appVersion = arg.slice("--app-version=".length);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.help) {
    return options;
  }
  if (options.db !== null && options.home !== null) {
    throw new UsageError("--db and --home are mutually exclusive");
  }
  if (options.db === null && options.home === null) {
    throw new UsageError("one of --db or --home is required");
  }
  return options;
}

function parsePositiveInteger(value, name) {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new UsageError(`${name} must be a positive integer`);
  }
  return Number(value);
}

function readRootAppVersion(rootDir) {
  const manifestPath = join(rootDir, "package.json");
  if (!existsSync(manifestPath)) {
    return "0.0.0";
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function describeEntry(entry) {
  return {
    name: entry.baseName,
    path: entry.relativePath,
    owner: entry.owner,
    sequence: entry.sequence,
    checksum: entry.checksum
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`migrate: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const dbPath = options.db ?? join(options.home, "db", "evoplug.sqlite");
  const backupDir = options.backupDir ?? join(dirname(dbPath), "backups");
  const appVersion = options.appVersion ?? readRootAppVersion(options.root);
  const now = Date.now();

  const discovery = discoverMigrationFiles(options.root);
  const report = {
    ok: false,
    db: dbPath,
    root: options.root,
    sqlite_version: null,
    schema_major: options.schemaMajor,
    schema_minor: null,
    applied: [],
    pending: [],
    backup: null,
    errors: [...discovery.errors]
  };

  if (discovery.errors.length > 0) {
    output(report, options.json);
    return 1;
  }

  let dbModule;
  try {
    dbModule = await import("./migration-db.mjs");
  } catch (error) {
    process.stderr.write(
      `migrate: node:sqlite is unavailable: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 3;
  }

  const databaseExists = existsSync(dbPath);
  if (options.dryRun && !databaseExists) {
    const selection = selectMigrationSet(discovery.entries, options.schemaMajor);
    report.schema_major = selection.major;
    report.schema_minor = selection.minor;
    report.pending = selection.selected.map((entry, index) => ({ ...describeEntry(entry), version: index + 1 }));
    report.errors.push(...selection.errors);
    report.ok = report.errors.length === 0;
    output(report, options.json);
    return report.ok ? 0 : 1;
  }

  let db;
  try {
    if (!options.dryRun) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    db = dbModule.openDatabase(dbPath, options.dryRun ? { readOnly: true } : {});
  } catch (error) {
    process.stderr.write(
      `migrate: cannot open ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }

  try {
    const sqliteVersion = dbModule.readSqliteVersion(db);
    report.sqlite_version = sqliteVersion;
    if (!isSupportedSqliteVersion(sqliteVersion)) {
      process.stderr.write(
        `migrate: ${MIGRATION_CODES.sqlite}: SQLite ${sqliteVersion} is not supported; accepted ranges are ${SUPPORTED_SQLITE_RANGES.join(", ")}\n`
      );
      return 3;
    }

    let applied = [];
    let appliedDomains = [];
    let meta = { major: null, minor: null };
    if (options.dryRun) {
      try {
        applied = dbModule.readAppliedMigrations(db);
        appliedDomains = dbModule.readAppliedDomainMigrations(db);
        meta = dbModule.readSchemaMeta(db);
      } catch {
        applied = [];
        appliedDomains = [];
        meta = { major: null, minor: null };
      }
    } else {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA journal_mode = WAL");
      applied = dbModule.readAppliedMigrations(db);
      appliedDomains = dbModule.readAppliedDomainMigrations(db);
      meta = dbModule.readSchemaMeta(db);
    }

    const selection = selectMigrationSet(discovery.entries, options.schemaMajor);
    report.schema_major = selection.major;
    report.errors.push(...selection.errors);
    if (selection.errors.length > 0) {
      output(report, options.json);
      return 1;
    }

    if (meta.major !== null && selection.major !== null && meta.major > selection.major) {
      process.stderr.write(
        `migrate: ${MIGRATION_CODES.unsupportedMajor}: database schema major ${meta.major} is newer than ${selection.major}\n`
      );
      return 3;
    }

    const baselineEntries = selection.selected.filter((entry) => entry.group === 0);
    const domainEntries = selection.selected.filter((entry) => entry.group === 1);
    const plan = dbModule.planMigrations(baselineEntries, applied);
    const domainPlan = dbModule.planDomainMigrations(domainEntries, appliedDomains);
    const pending = [...plan.pending, ...domainPlan.pending];
    const planErrors = [...plan.errors, ...domainPlan.errors];
    report.errors.push(...planErrors);
    report.applied = [
      ...applied.map((row) => ({ name: row.name, version: row.version, checksum: row.checksum })),
      ...appliedDomains.map((row) => ({
        name: row.name,
        version: row.sequence,
        checksum: row.checksum
      }))
    ];
    report.pending = [
      ...plan.pending.map(({ entry, version }) => ({ ...describeEntry(entry), version })),
      ...domainPlan.pending.map(({ entry }) => ({ ...describeEntry(entry), version: entry.sequence }))
    ];
    if (planErrors.length > 0) {
      output(report, options.json);
      return 1;
    }
    if (pending.length === 0) {
      // Metadata-only upgrade: a 2.0 home whose artifacts are all recorded
      // reaches 3.0 without re-running them (the storage runner does the same).
      report.schema_minor = meta.minor ?? selection.minor;
      if (!options.dryRun && selection.major !== null) {
        const targetMinor = selection.minor ?? 0;
        const currentMinor = meta.minor ?? 0;
        if (
          meta.major === null ||
          selection.major > meta.major ||
          (selection.major === meta.major && targetMinor > currentMinor)
        ) {
          dbModule.writeSchemaMeta(db, selection.major, targetMinor, now);
          report.schema_minor = targetMinor;
        }
      }
      report.ok = true;
      output(report, options.json);
      return 0;
    }
    if (options.dryRun) {
      report.ok = true;
      output(report, options.json);
      return 0;
    }

    if (dbModule.databaseNeedsBackup(dbPath)) {
      const backup = dbModule.backupDatabase(db, { dbPath, backupDir, now });
      if (!backup.ok) {
        process.stderr.write(`migrate: backup refused, no migration applied: ${backup.message}\n`);
        report.errors.push({ code: MIGRATION_CODES.checksum, message: backup.message });
        output(report, options.json);
        return 1;
      }
      report.backup = backup.path;
    }

    const execution = dbModule.applyMigrations(db, pending, { appVersion, now });
    if (execution.length !== pending.length) {
      report.errors.push({
        code: MIGRATION_CODES.order,
        message: `applied ${execution.length} of ${pending.length} pending migrations`
      });
      output(report, options.json);
      return 1;
    }
    if (selection.major !== null) {
      const minor = selection.minor ?? meta.minor ?? 0;
      dbModule.writeSchemaMeta(db, selection.major, minor, now);
      report.schema_minor = minor;
    }
    report.applied = [
      ...dbModule.readAppliedMigrations(db).map((row) => ({
        name: row.name,
        version: row.version,
        checksum: row.checksum
      })),
      ...dbModule.readAppliedDomainMigrations(db).map((row) => ({
        name: row.name,
        version: row.sequence,
        checksum: row.checksum
      }))
    ];
    report.pending = [];
    report.ok = true;
    output(report, options.json);
    return 0;
  } catch (error) {
    process.stderr.write(`migrate: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function output(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const verb = report.pending.length > 0 ? "pending" : "applied";
  process.stdout.write(
    `migrate: ${report.ok ? "ok" : "failed"} db=${report.db} schema_major=${report.schema_major ?? "?"} ${verb}=${
      report.pending.length > 0 ? report.pending.length : report.applied.length
    }\n`
  );
  for (const entry of report.pending) {
    process.stdout.write(`  pending ${entry.path} (version ${entry.version})\n`);
  }
  for (const entry of report.applied) {
    process.stdout.write(`  applied ${entry.name} (version ${entry.version})\n`);
  }
  if (report.backup !== null) {
    process.stdout.write(`  backup ${report.backup}\n`);
  }
  for (const error of report.errors) {
    process.stderr.write(`  ${error.code}: ${error.message}\n`);
  }
}

process.exitCode = await main();
