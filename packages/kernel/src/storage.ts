/**
 * Storage-backed ports used by the kernel composition root.
 *
 * SQLite, the journal and the blob store are only ever reached through
 * `@evoplug/storage`; this module owns the startup wiring (open, migrate,
 * recover) and the read-only axes behind `system.describe`/`status.get`/GC.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ErrorEnvelope, GcReport, Hash, JsonValue, Result } from "@evoplug/core";
import { canonicalHash, canonicalJsonText } from "@evoplug/core";
import { calculateBackupPath } from "./paths.js";
import {
  BlobStore,
  FND_STATE_ROW_PROJECTIONS,
  createSqliteDriver,
  createTransactionRunner,
  discoverMigrations,
  listJournalSegments,
  listJournalStates,
  openConfiguredConnection,
  payloadEvents,
  readSchemaMeta,
  recoverJournal,
  runDomainMigrations,
  runGarbageCollection,
  runMigrations,
  tryReadSchemaVersion,
  type JournalFrameRecord,
  type JournalRecoveryReport,
  type SqliteConnection,
  type SqliteDriver,
  type SchemaVersion,
  type StateRowProjectionRegistration,
  type StatementSource
} from "@evoplug/storage";
import {
  projectionFromRow,
  projectionHash,
  projectionRowFromProjection,
  REV_STATE_ROW_REGISTRATIONS,
  type ExperienceProjection,
  type ExperienceProjectionRow
} from "@evoplug/review";
import type { EvoplugConfig } from "./config.js";
import { canonicalConfigJson, computeConfigContentHash, computeConfigVersion } from "./config.js";
import {
  createEvidenceRecoveryReplay,
  EVD_ROW_SCHEMA_NAMES
} from "./default-evidence-recovery.js";
import { internalError, kernelError } from "./errors.js";
import type { HomeDatabasePort, HomeLayout } from "./home.js";
import type { GcPort, SystemStatusPort } from "./ports.js";
import type {
  BudgetStatusAxis,
  CapabilityStatusAxis,
  ConfigStatusAxis,
  GcParams,
  OutboxStatusAxis,
  StorageStatusAxis,
  SystemStatusAxes
} from "./system.js";

export interface KernelDatabase {
  readonly connection: SqliteConnection;
  readonly sqlite_version: string;
  readonly schema: SchemaVersion;
}

export interface MigrationsLocation {
  readonly directory: string;
  /** `<repo>/migrations/domains`, when present. */
  readonly domains_directory?: string;
}

/**
 * Finds `migrations/sql` by walking up from the running module (or the
 * `EVOPLUG_MIGRATIONS_DIR` override). Returns `null` when the build layout does
 * not carry the SQL files.
 */
export function discoverMigrationsLocation(start: string | URL): MigrationsLocation | null {
  const override = process.env["EVOPLUG_MIGRATIONS_DIR"];
  if (override !== undefined && override.length > 0) {
    return { directory: override };
  }
  let directory: string;
  if (start instanceof URL) {
    directory = start.pathname;
  } else {
    directory = start;
  }
  let current = join(directory, ".");
  for (;;) {
    const candidate = join(current, "migrations", "sql");
    const discovered = discoverMigrations(candidate);
    if (discovered.ok) {
      const domains = join(current, "migrations", "domains");
      return existsSync(domains)
        ? { directory: candidate, domains_directory: domains }
        : { directory: candidate };
    }
    const parent = join(current, "..");
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export interface OpenKernelDatabaseOptions {
  readonly home: string;
  readonly migrations: MigrationsLocation;
  readonly app_version: string;
  readonly now?: () => number;
  readonly driver?: SqliteDriver;
}

/** Opens the single writer connection, checks the SQLite version and migrates. */
export async function openKernelDatabase(
  options: OpenKernelDatabaseOptions
): Promise<Result<KernelDatabase, ErrorEnvelope>> {
  const driver = options.driver ?? createSqliteDriver();
  const clock = options.now ?? Date.now;
  const dbPath = join(options.home, "db", "evoplug.sqlite");
  const databaseExisted = existsSync(dbPath);
  const opened = openConfiguredConnection(driver, dbPath, {
    readOnly: false
  });
  if (!opened.ok) {
    return opened;
  }
  const backupPath = calculateBackupPath(join(options.home, "backups"), clock());
  const migrated = await runMigrations({
    connection: opened.value.connection,
    directory: options.migrations.directory,
    app_version: options.app_version,
    ...(options.now === undefined ? {} : { now: options.now }),
    backup: async (destination: string): Promise<void> => {
      await driver.backup(opened.value.connection, destination);
    },
    backup_path: backupPath
  });
  if (!migrated.ok) {
    opened.value.connection.close();
    return migrated;
  }
  if (options.migrations.domains_directory !== undefined) {
    const domains = await runDomainMigrations({
      connection: opened.value.connection,
      domains_root: options.migrations.domains_directory,
      app_version: options.app_version,
      ...(options.now === undefined ? {} : { now: options.now }),
      existing_database: databaseExisted,
      backup: async (destination: string): Promise<void> => {
        await driver.backup(opened.value.connection, destination);
      },
      backup_path: join(
        options.home,
        "backups",
        `pre-domain-migration-${String(clock())}.sqlite`
      )
    });
    if (!domains.ok) {
      opened.value.connection.close();
      return domains;
    }
  }
  const schema = tryReadSchemaVersion(opened.value.connection);
  if (schema === null) {
    opened.value.connection.close();
    return { ok: false, status: "rejected", error: internalError("kernel.schema_meta_missing") };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      connection: opened.value.connection,
      sqlite_version: opened.value.sqlite_version,
      schema
    }
  };
}

export interface JournalRecoveryOutcome {
  readonly reports: readonly JournalRecoveryReport[];
  readonly degraded_read_only: boolean;
}

function recoverRevProjectionRows(
  source: StatementSource,
  frame: JournalFrameRecord
): Result<void, ErrorEnvelope> {
  for (const event of payloadEvents(frame.payload)) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const record = event as Record<string, JsonValue>;
    if (
      record["event_type"] !== "state_row.recorded" ||
      record["row_schema"] !== "rsi.experience_lifecycle_event_row/1"
    ) {
      continue;
    }
    const rowJson = record["row_json"];
    if (typeof rowJson !== "string") {
      return { ok: false, status: "rejected", error: internalError("kernel.rev_projection_recovery_failed") };
    }
    let lifecycleRow: Record<string, JsonValue>;
    try {
      const parsed: unknown = JSON.parse(rowJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("row");
      lifecycleRow = parsed as Record<string, JsonValue>;
    } catch {
      return { ok: false, status: "rejected", error: internalError("kernel.rev_projection_recovery_failed") };
    }
    const projectionJson = lifecycleRow["projection_after_json"];
    const expectedHash = lifecycleRow["projection_after_hash"];
    if (typeof projectionJson !== "string" || typeof expectedHash !== "string") {
      return { ok: false, status: "rejected", error: internalError("kernel.rev_projection_recovery_failed") };
    }
    let projection: Record<string, JsonValue>;
    try {
      const parsed: unknown = JSON.parse(projectionJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("projection");
      projection = parsed as Record<string, JsonValue>;
    } catch {
      return { ok: false, status: "rejected", error: internalError("kernel.rev_projection_recovery_failed") };
    }
    if (projectionHash(projection as unknown as ExperienceProjection) !== expectedHash) {
      return { ok: false, status: "rejected", error: internalError("kernel.rev_projection_recovery_failed") };
    }
    const physical = projectionRowFromProjection(projection as unknown as ExperienceProjection) as unknown as ExperienceProjectionRow;
    const projectionId = physical.projection_id;
    const existing = source
      .prepare<Record<string, string | number | null>>(
        "SELECT * FROM experience_projections WHERE projection_id = :projection_id"
      )
      .get({ projection_id: projectionId });
    if (existing !== undefined) {
      try {
        const current = projectionFromRow(existing as unknown as ExperienceProjectionRow);
        if (projectionHash(current) === expectedHash) continue;
        if (current.row_version >= physical.row_version) {
          return { ok: false, status: "rejected", error: internalError("kernel.rev_projection_recovery_failed") };
        }
      } catch {
        return { ok: false, status: "rejected", error: internalError("kernel.rev_projection_recovery_failed") };
      }
      const updates = Object.keys(physical).filter((key) => key !== "projection_id");
      source
        .prepare(
          `UPDATE experience_projections SET ${updates.map((key) => `${key} = :${key}`).join(", ")} WHERE projection_id = :projection_id`
        )
        .run(physical as unknown as Record<string, string | number | null>);
      continue;
    }
    const columns = Object.keys(physical);
    source
      .prepare(
        `INSERT INTO experience_projections (${columns.join(", ")}) VALUES (${columns.map((key) => `:${key}`).join(", ")})`
      )
      .run(physical as unknown as Record<string, string | number | null>);
  }
  return { ok: true, status: "ok", value: undefined };
}

export interface KernelJournalRecoveryHooks {
  /**
   * Additional per-frame replay hook (for example the QP projection). The
   * evidence replay runs first in the same frame savepoint; an error from
   * either hook rolls the whole frame back.
   */
  readonly replay?: (
    source: StatementSource,
    frame: JournalFrameRecord
  ) => Result<void, ErrorEnvelope>;
  /**
   * Generic typed-row registrations. Omitted uses the FND registry; `[]`
   * disables the generic projector. Evidence rows are always owned by the
   * built-in replay hook and are excluded from the generic projector.
   */
  readonly project_state_rows?: readonly StateRowProjectionRegistration[];
}

/**
 * Verifies that every committed host event frame reached `event_log`.
 *
 * The `rsi.event/1` envelope is a lossy projection of the ingest draft: it
 * does not carry `host_id`, `config_space`, `occurred_at` or `source_seq`, so a
 * frame whose `event_log` row is absent cannot be rebuilt exactly. Recovery
 * must fail closed instead of advancing `journal_state` and reporting a clean
 * tail, which would hide the event forever.
 */
function verifyEventLogProjection(
  source: StatementSource,
  frame: JournalFrameRecord,
  journalId: string
): ErrorEnvelope | null {
  for (const event of payloadEvents(frame.payload)) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      continue;
    }
    const record = event as Record<string, JsonValue>;
    if (record["schema_version"] !== "rsi.event/1") {
      continue;
    }
    const eventId = record["event_id"];
    if (typeof eventId !== "string") {
      return kernelError("E_REBUILD_DIVERGENCE", {
        details: {
          kind: "internal",
          incident_id: `kernel.event_log_missing_event_id:${frame.commit_seq}`
        }
      });
    }
    const row = source
      .prepare<{ commit_seq: number; journal_id: string }>(
        `SELECT commit_seq, journal_id
           FROM event_log
          WHERE event_id = :event_id`
      )
      .get({ event_id: eventId });
    if (row === undefined) {
      return kernelError("E_REBUILD_DIVERGENCE", {
        details: {
          kind: "internal",
          incident_id: `kernel.event_log_unprojected:${eventId}`
        }
      });
    }
    if (Number(row.commit_seq) !== frame.commit_seq || row.journal_id !== journalId) {
      return kernelError("E_REBUILD_DIVERGENCE", {
        details: {
          kind: "internal",
          incident_id: `kernel.event_log_projection_mismatch:${eventId}`
        }
      });
    }
  }
  return null;
}

/**
 * Replays every journal era recorded in `journal_state`. A fresh database has
 * no eras, so this is a no-op. `degraded_read_only` is sticky.
 *
 * Evidence state rows are always rebuilt by `createEvidenceRecoveryReplay`;
 * the generic projector never sees them. A caller-supplied `replay` hook is
 * composed after it inside the same per-frame savepoint.
 */
export async function recoverKernelJournals(input: {
  readonly connection: SqliteConnection;
  readonly blob_store: BlobStore;
  readonly journal_dir: string;
  readonly now: number;
  readonly replay?: KernelJournalRecoveryHooks["replay"];
  readonly project_state_rows?: KernelJournalRecoveryHooks["project_state_rows"];
}): Promise<Result<JournalRecoveryOutcome, ErrorEnvelope>> {
  const evidenceReplay = createEvidenceRecoveryReplay();
  const additionalReplay = input.replay;
  const replay: NonNullable<KernelJournalRecoveryHooks["replay"]> = (
    source,
    frame
  ) => {
    const evidence = evidenceReplay(source, frame);
    if (!evidence.ok) return evidence;
    const rev = recoverRevProjectionRows(source, frame);
    if (!rev.ok) return rev;
    return additionalReplay === undefined ? rev : additionalReplay(source, frame);
  };
  const projectStateRows =
    input.project_state_rows === undefined
      ? [
          ...FND_STATE_ROW_PROJECTIONS,
          ...REV_STATE_ROW_REGISTRATIONS.map((registration) => ({
            row_schema: registration.row_schema,
            table: registration.table,
            primary_key: [...registration.primary_key],
            allowed_operations: [...registration.allowed_operations],
            row_versioned: registration.row_versioned,
            binding_source: registration.binding_source
          }))
        ]
      : [...input.project_state_rows];
  const reports: JournalRecoveryReport[] = [];
  const states = listJournalStates(input.connection);
  const coveredPaths = new Set(
    states.map((state) => join(input.journal_dir, state.relative_path))
  );
  const recoverEra = (args: {
    readonly journal_id: string;
    readonly journal_path: string;
    readonly relative_path: string;
    readonly trusted_prefix_end?: number;
    readonly last_commit_seq?: number;
    readonly base_commit_seq?: number;
  }): Result<JournalRecoveryReport, ErrorEnvelope> => {
    try {
      return recoverJournal({
        source: input.connection,
        blob_store: input.blob_store,
        journal_id: args.journal_id,
        journal_path: args.journal_path,
        relative_path: args.relative_path,
        now: input.now,
        ...(args.trusted_prefix_end === undefined
          ? {}
          : { trusted_prefix_end: args.trusted_prefix_end }),
        ...(args.last_commit_seq === undefined
          ? {}
          : { last_commit_seq: args.last_commit_seq }),
        ...(args.base_commit_seq === undefined
          ? {}
          : { base_commit_seq: args.base_commit_seq }),
        replay,
        verify_frame: (source, frame) =>
          verifyEventLogProjection(source, frame, args.journal_id),
        skip_row_schemas: EVD_ROW_SCHEMA_NAMES,
        project_state_rows: projectStateRows
      });
    } catch {
      return {
        ok: false,
        status: "rejected",
        error: internalError("kernel.journal_recovery_failed")
      };
    }
  };
  for (const state of states) {
    const recovered = recoverEra({
      journal_id: state.journal_id,
      journal_path: join(input.journal_dir, state.relative_path),
      relative_path: state.relative_path,
      trusted_prefix_end: state.trusted_prefix_end,
      last_commit_seq: state.last_commit_seq,
      base_commit_seq: state.base_commit_seq
    });
    if (!recovered.ok) {
      return { ok: false, status: recovered.status, error: recovered.error };
    }
    reports.push(recovered.value);
  }

  // An era whose very first projection failed has no `journal_state` row, so
  // the loop above cannot discover it. Walk the directory and recover every
  // contiguous segment chain that no state row names; a chain that reaches a
  // covered segment belongs to that era and was already scanned.
  let directoryEntries: string[] = [];
  try {
    directoryEntries = readdirSync(input.journal_dir);
  } catch {
    directoryEntries = [];
  }
  const seenSegments = new Set<string>();
  const segmentNames = directoryEntries
    .filter((name) => /^journal-\d{6}\.rsij$/.test(name))
    .sort();
  for (const name of segmentNames) {
    const firstPath = join(input.journal_dir, name);
    if (seenSegments.has(firstPath)) {
      continue;
    }
    const chain = listJournalSegments(firstPath);
    for (const segment of chain) {
      seenSegments.add(segment.path);
    }
    if (chain.some((segment) => coveredPaths.has(segment.path))) {
      continue;
    }
    const recovered = recoverEra({
      journal_id: basename(name, ".rsij"),
      journal_path: firstPath,
      relative_path: name
    });
    if (!recovered.ok) {
      return { ok: false, status: recovered.status, error: recovered.error };
    }
    reports.push(recovered.value);
  }
  return {
    ok: true,
    status: "ok",
    value: {
      reports,
      degraded_read_only: reports.some((report) => report.degraded_read_only)
    }
  };
}

function readCount(connection: SqliteConnection, sql: string, params?: Record<string, Hash | number>): number {
  const row = connection.prepare<{ count: number }>(sql).get(params);
  if (row === undefined) {
    return 0;
  }
  const count = Number(row.count);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function tableExists(connection: SqliteConnection, name: string): boolean {
  const row = connection
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = :name")
    .get({ name });
  return row !== undefined;
}

function readStorageAxis(connection: SqliteConnection): StorageStatusAxis {
  const row = connection
    .prepare<{ tail_state: string; trusted_prefix_end: number }>(
      `SELECT tail_state, trusted_prefix_end
         FROM journal_state
        ORDER BY base_commit_seq DESC, journal_id DESC
        LIMIT 1`
    )
    .get();
  const tailState: StorageStatusAxis["journal_tail_state"] =
    row === undefined
      ? "clean"
      : row.tail_state === "corrupt_middle"
        ? "corrupt_middle"
        : row.tail_state === "corrupt_tail"
          ? "corrupt_tail"
          : "clean";
  let quickCheck: StorageStatusAxis["db_quick_check"] = "not_run";
  try {
    const result = connection.prepare<{ quick_check: string }>("PRAGMA quick_check").get();
    if (result !== undefined && result.quick_check === "ok") {
      quickCheck = "ok";
    } else {
      quickCheck = "failed";
    }
  } catch {
    quickCheck = "not_run";
  }
  return {
    journal_tail_state: tailState,
    trusted_prefix_end: row === undefined ? 0 : Number(row.trusted_prefix_end),
    quarantine_count: readCount(connection, "SELECT COUNT(*) AS count FROM quarantine WHERE resolved_at IS NULL"),
    db_quick_check: quickCheck
  };
}

function readBudgetAxis(connection: SqliteConnection, now: number): BudgetStatusAxis {
  return {
    active_reservations: readCount(
      connection,
      "SELECT COUNT(*) AS count FROM budget_reservation WHERE state IN ('reserved','claimed')"
    ),
    unsettled_reservations: readCount(
      connection,
      "SELECT COUNT(*) AS count FROM budget_reservation WHERE state = 'unsettled'"
    ),
    cooldown_scopes: readCount(
      connection,
      "SELECT COUNT(*) AS count FROM rate_limit_state WHERE cooldown_until IS NOT NULL AND cooldown_until > :now",
      { now }
    )
  };
}

function readOutboxAxis(connection: SqliteConnection): OutboxStatusAxis {
  return {
    pending: readCount(connection, "SELECT COUNT(*) AS count FROM outbox WHERE state = 'pending'"),
    leased: readCount(connection, "SELECT COUNT(*) AS count FROM outbox WHERE state = 'leased'"),
    uncertain: readCount(connection, "SELECT COUNT(*) AS count FROM outbox WHERE state = 'uncertain'"),
    failed: readCount(connection, "SELECT COUNT(*) AS count FROM outbox WHERE state = 'failed'")
  };
}

function readConfigAxis(connection: SqliteConnection, config: EvoplugConfig): ConfigStatusAxis {
  const row = connection
    .prepare<{ config_version: string; content_hash: string }>(
      "SELECT config_version, content_hash FROM config_profile WHERE status = 'active' LIMIT 1"
    )
    .get();
  return {
    config_version: row === undefined ? computeConfigVersion(config) : row.config_version,
    config_hash: row === undefined ? computeConfigContentHash(config) : (row.content_hash as Hash),
    egress_policy_version: config.egress_policy_version
  };
}

function readCapabilityAxis(connection: SqliteConnection): readonly CapabilityStatusAxis[] {
  if (!tableExists(connection, "capability_binding")) {
    return [];
  }
  const rows = connection
    .prepare<{ host_id: string; status: string; evidence_stage: string }>(
      "SELECT host_id, status, evidence_stage FROM capability_binding ORDER BY host_id ASC, evidence_stage ASC"
    )
    .all();
  const out: CapabilityStatusAxis[] = [];
  for (const row of rows) {
    out.push({
      host_id: row.host_id as CapabilityStatusAxis["host_id"],
      status: row.status as CapabilityStatusAxis["status"],
      evidence_stage: row.evidence_stage as CapabilityStatusAxis["evidence_stage"]
    });
  }
  return out;
}

export interface SqliteStatusPortOptions {
  readonly connection: SqliteConnection;
  readonly config: EvoplugConfig;
  readonly now?: () => number;
  readonly runtime: {
    readonly status: SystemStatusAxes["status"] | (() => SystemStatusAxes["status"]);
    readonly recovery_state:
      | SystemStatusAxes["recovery_state"]
      | (() => SystemStatusAxes["recovery_state"]);
  };
}

/** Read-only `status.get` axes over the single writer connection. */
export function createSqliteStatusPort(options: SqliteStatusPortOptions): SystemStatusPort {
  const now = options.now ?? Date.now;
  return {
    readStatus: async (): Promise<Result<SystemStatusAxes, ErrorEnvelope>> => {
      try {
        return {
          ok: true,
          status: "ok",
          value: {
            status:
              typeof options.runtime.status === "function"
                ? options.runtime.status()
                : options.runtime.status,
            recovery_state:
              typeof options.runtime.recovery_state === "function"
                ? options.runtime.recovery_state()
                : options.runtime.recovery_state,
            storage: readStorageAxis(options.connection),
            budget: readBudgetAxis(options.connection, now()),
            outbox: readOutboxAxis(options.connection),
            config: readConfigAxis(options.connection, options.config),
            capabilities: readCapabilityAxis(options.connection)
          }
        };
      } catch {
        return {
          ok: false,
          status: "degraded",
          error: kernelError("E_STORAGE_BUSY", { details: { kind: "none" } })
        };
      }
    }
  };
}

export interface SqliteGcPortOptions {
  readonly connection: SqliteConnection;
  readonly blob_store: BlobStore;
  readonly now?: () => number;
}

/** `maintenance.gc`; the caller must already hold the single-writer lock. */
export function createSqliteGcPort(options: SqliteGcPortOptions): GcPort {
  const now = options.now ?? Date.now;
  return {
    run: async (params: GcParams): Promise<Result<GcReport, ErrorEnvelope>> => {
      const result = runGarbageCollection({
        source: options.connection,
        blobStore: options.blob_store,
        options: {
          mode: params.mode,
          now: now(),
          ...(params.retention_days === undefined ? {} : { retention_days: params.retention_days })
        }
      });
      if (!result.ok) {
        return { ok: false, status: "rejected", error: result.error };
      }
      return { ok: true, status: "ok", value: result.value };
    }
  };
}

/**
 * `HomeDatabasePort` for `evolve init`: creates the database, migrates, then
 * activates `config_profile` in a single `BEGIN IMMEDIATE` transaction. The
 * canonical JSON stored in the row is byte-identical to `config.json`.
 */
export function createSqliteHomeDatabasePort(options: {
  readonly migrations: MigrationsLocation;
  readonly app_version: string;
  readonly driver?: SqliteDriver;
}): HomeDatabasePort {
  const driver = options.driver ?? createSqliteDriver();
  return {
    prepareDatabase: async (input: {
      readonly home: string;
      readonly layout: HomeLayout;
      readonly config: EvoplugConfig;
      readonly config_version: string;
      readonly config_hash: Hash;
      readonly schema_major: number;
      readonly now: number;
    }): Promise<Result<{ readonly db_hash_marker: Hash | null }, ErrorEnvelope>> => {
      const databaseExisted = existsSync(input.layout.db_path);
      const opened = openConfiguredConnection(driver, input.layout.db_path, { readOnly: false });
      if (!opened.ok) {
        return opened;
      }
      const connection = opened.value.connection;
      try {
        const migrated = await runMigrations({
          connection,
          directory: options.migrations.directory,
          app_version: options.app_version,
          now: () => input.now,
          backup: async (destination: string): Promise<void> => {
            await driver.backup(connection, destination);
          },
          backup_path: calculateBackupPath(input.layout.backups_dir, input.now)
        });
        if (!migrated.ok) {
          return migrated;
        }
        if (options.migrations.domains_directory !== undefined) {
          const domains = await runDomainMigrations({
            connection,
            domains_root: options.migrations.domains_directory,
            app_version: options.app_version,
            now: () => input.now,
            existing_database: databaseExisted,
            backup: async (destination: string): Promise<void> => {
              await driver.backup(connection, destination);
            },
            backup_path: join(
              input.layout.backups_dir,
              `pre-domain-migration-${String(input.now)}.sqlite`
            )
          });
          if (!domains.ok) {
            return domains;
          }
        }
        const canonicalJson = canonicalConfigJson(input.config);
        const runner = createTransactionRunner(connection);
        runner.withTxSync((tx) => {
          tx.prepare(
            `UPDATE config_profile
                SET status = 'superseded'
              WHERE config_space = :config_space
                AND status = 'active'
                AND config_version <> :config_version`
          ).run({
            config_space: input.config.config_space,
            config_version: input.config_version
          });
          tx.prepare(
            `INSERT INTO config_profile (config_version, config_space, canonical_json, content_hash, status, created_at)
             VALUES (:config_version, :config_space, :canonical_json, :content_hash, 'active', :created_at)
             ON CONFLICT(config_version) DO UPDATE SET
               config_space = excluded.config_space,
               canonical_json = excluded.canonical_json,
               content_hash = excluded.content_hash,
               status = 'active'`
          ).run({
            config_version: input.config_version,
            config_space: input.config.config_space,
            canonical_json: canonicalJson,
            content_hash: input.config_hash,
            created_at: input.now
          });
          return undefined;
        });
        const meta = readSchemaMeta(connection);
        const marker = canonicalHash({
          schema_major: Number(meta.get("schema_major") ?? input.schema_major),
          schema_minor: Number(meta.get("schema_minor") ?? 0),
          config_version: input.config_version,
          config_hash: input.config_hash
        });
        return { ok: true, status: "ok", value: { db_hash_marker: marker } };
      } catch {
        return { ok: false, status: "rejected", error: internalError("kernel.home_database_failed") };
      } finally {
        connection.close();
      }
    }
  };
}
