/**
 * Local command bridge for `evolve` (DD-FND-101, DD-FND-102).
 *
 * `apps/cli` may only import `@evoplug/core` and `@evoplug/ipc` (DD-FND-021), so
 * every command that needs the storage, kernel or home bootstrap runs here.
 * The CLI spawns this file with the resolved home and the parsed command as a
 * JSON request on argv/stdin, and reads exactly one JSON response from stdout.
 *
 * The bridge never fabricates success. Commands whose implementation needs a
 * capability this build does not ship (HOST adapter registration, REV review
 * services, the storage export/import package format) answer a structured
 * `E_INTERNAL` with the missing capability named in the diagnostic.
 */

import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ErrorEnvelope,
  FailureStatus,
  Hash,
  Id,
  JsonValue,
  Result
} from "@evoplug/core";
import { canonicalHash, err, hashBytes, isHash, makeErrorEnvelope, newId, ok, toJsonValue } from "@evoplug/core";
import type { HostInstallApprovalPort, HostMode } from "@evoplug/core/host";
import {
  acquireWriterLock,
  attachHost,
  canonicalConfigJson,
  computeConfigContentHash,
  computeConfigVersion,
  createDefaultConfig,
  createHostStateRowAppendAdapter,
  createRuntimeProbeProducer,
  createSourceRefPort,
  resolveFeatureConfig,
  createInstallApprovalConsumeHandler,
  createInstallApprovalGetHandler,
  createReviewService,
  createDefaultEvidenceWriter,
  provisionJevBinding,
  createSqliteHomeDatabasePort,
  detachHost,
  discoverMigrationsLocation,
  fieldError,
  findPlaintextSecret,
  homeLayout,
  initializeHome,
  internalError,
  kernelError,
  parseConfigText,
  readConfigFile,
  readInitCompleteMarker,
  revokeHostRuntimeSessions,
  writeFileAtomicDurable
} from "@evoplug/kernel";
import type {
  EvoplugConfig,
  HostAttachDeps,
  InitCompleteMarker,
  KernelReviewServices,
  JevProvisioningInput,
  MigrationsLocation,
  ReviewServiceError
} from "@evoplug/kernel";
import {
  BlobStore,
  JournalWriter,
  SCHEMA_MAJOR,
  createSqliteDriver,
  createFndStateRowPort,
  createTransactionRunner,
  exportHomeSnapshot,
  importHomeSnapshot,
  listJournalStates,
  openConfiguredConnection,
  readSchemaMeta,
  snapshotHomeLayout
} from "@evoplug/storage";
import type { SqliteConnection } from "@evoplug/storage";
import { runServe } from "./main.js";
import { attachDefaults, createHostAdapterRegistry, createProbeBindingDeclarationPort } from "./host-registry.js";

export const LOCAL_CLI_REQUEST_SCHEMA: "rsi.local_cli_request/1" = "rsi.local_cli_request/1";
export const LOCAL_CLI_RESULT_SCHEMA: "rsi.local_cli_result/1" = "rsi.local_cli_result/1";
export const PRODUCT_VERSION = "0.0.0";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 3;
export const EXIT_CONFLICT = 4;
export const EXIT_DEGRADED = 5;
export const EXIT_CANCELLED = 130;

export type LocalCliOptionValue = string | true;

export interface LocalCliRequest {
  readonly schema_version: "rsi.local_cli_request/1";
  /** Command id from `apps/cli/src/commands.ts`, e.g. `skills.diff`. */
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, LocalCliOptionValue>>;
  readonly home: string;
  readonly json: boolean;
}

export type LocalCliOutcome =
  | {
      readonly schema_version: "rsi.local_cli_result/1";
      readonly ok: true;
      readonly status: "ok";
      readonly value: JsonValue;
      readonly exit_code: number;
    }
  | {
      readonly schema_version: "rsi.local_cli_result/1";
      readonly ok: false;
      readonly status: FailureStatus;
      readonly error: ErrorEnvelope;
      readonly exit_code: number;
      readonly diagnostic?: string;
    };

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(value: JsonValue, exitCode: number = EXIT_OK): LocalCliOutcome {
  return {
    schema_version: LOCAL_CLI_RESULT_SCHEMA,
    ok: true,
    status: "ok",
    value,
    exit_code: exitCode
  };
}

function failure(
  status: FailureStatus,
  error: ErrorEnvelope,
  exitCode: number,
  diagnostic?: string
): LocalCliOutcome {
  const base = {
    schema_version: LOCAL_CLI_RESULT_SCHEMA,
    ok: false as const,
    status,
    error,
    exit_code: exitCode
  };
  return diagnostic === undefined ? base : { ...base, diagnostic };
}

function unsupported(command: string, reason: string): LocalCliOutcome {
  return failure(
    "rejected",
    internalError(`kernel.local_cli_capability_unavailable:${command}`),
    EXIT_UNAVAILABLE,
    reason
  );
}

const INPUT_CODES: ReadonlySet<string> = new Set([
  "E_SCHEMA",
  "E_EGRESS_REQUEST_PREIMAGE",
  "E_EGRESS_REQUEST_INVALID"
]);

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "E_HOME_INCOMPATIBLE",
  "E_SCHEMA_MAJOR_UNSUPPORTED",
  "E_LEGACY_READ_ONLY",
  "E_IPC_DISCONNECTED",
  "E_IPC_METHOD_UNKNOWN",
  "E_UNSUPPORTED",
  "E_TARGET_NOT_DECLARED",
  "E_ADAPTER_MISMATCH"
]);

const CONFLICT_CODES: ReadonlySet<string> = new Set([
  "E_INSTALL_CONFLICT",
  "E_UNINSTALL_NONMANAGED",
  "E_PATH_ESCAPE",
  "E_IPC_AUTH",
  "E_CONFLICT"
]);

/** Mirrors `apps/cli/src/exit-codes.ts` for bridge-owned commands. */
function exitCodeForFailure(status: FailureStatus, error: ErrorEnvelope): number {
  if (error.code === "E_CANCELLED") {
    return EXIT_CANCELLED;
  }
  switch (status) {
    case "conflict":
      return EXIT_CONFLICT;
    case "degraded":
    case "pending":
      return EXIT_DEGRADED;
    case "unknown":
      return EXIT_FAILED;
    case "rejected":
      break;
  }
  if (INPUT_CODES.has(error.code)) {
    return EXIT_USAGE;
  }
  if (UNAVAILABLE_CODES.has(error.code)) {
    return EXIT_UNAVAILABLE;
  }
  if (CONFLICT_CODES.has(error.code) || error.category === "authorization") {
    return EXIT_CONFLICT;
  }
  return EXIT_FAILED;
}

function ioExit(status: FailureStatus, error: ErrorEnvelope): number {
  if (error.code === "E_IO" || error.code === "E_STORAGE_IO" || error.code === "E_STORAGE_BUSY") {
    return EXIT_DEGRADED;
  }
  return exitCodeForFailure(status, error);
}

function stringOption(request: LocalCliRequest, name: string): string | null {
  const value = request.options[name];
  return typeof value === "string" ? value : null;
}

function flagOption(request: LocalCliRequest, name: string): boolean {
  return request.options[name] === true;
}

function missingOption(name: string): LocalCliOutcome {
  return failure("rejected", fieldError(`--${name}`, "missing_required"), EXIT_USAGE);
}

function migrationsLocation(): MigrationsLocation | null {
  return discoverMigrationsLocation(new URL("../..", import.meta.url));
}

function openHomeDatabase(home: string): Result<SqliteConnection, ErrorEnvelope> {
  const opened = openConfiguredConnection(createSqliteDriver(), homeLayout(home).db_path, {
    readOnly: false
  });
  if (!opened.ok) {
    return opened;
  }
  return { ok: true, status: "ok", value: opened.value.connection };
}

/**
 * Opens the current journal era for a local write path.
 *
 * The persisted `trusted_prefix_end`, `read_only` and `tail_state` come from
 * `journal_state`, so a writer never appends behind a durable frame whose
 * SQLite projection did not commit (DD-FND-059). These commands do not run
 * recovery themselves: when an era needs it the open fails closed and
 * `evolve serve` performs recovery first.
 */
export function openLocalJournalWriter(input: {
  readonly connection: SqliteConnection;
  readonly journal_dir: string;
}): Result<
  {
    readonly writer: JournalWriter;
    readonly journal_id: string;
    readonly relative_path: string;
  },
  ErrorEnvelope
> {
  const latest = listJournalStates(input.connection).at(-1);
  const journalId = latest?.journal_id ?? "journal-000001";
  const relativePath = latest?.relative_path ?? "journal-000001.rsij";
  const writer = JournalWriter.open({
    file_path: join(input.journal_dir, relativePath),
    journal_id: journalId,
    last_commit_seq: latest?.last_commit_seq ?? 0,
    trusted_prefix_end: latest?.trusted_prefix_end ?? 0,
    ...(latest === undefined
      ? {}
      : { read_only: latest.read_only === 1, tail_state: latest.tail_state }),
    shared_commit_seq: () => {
      const row = input.connection
        .prepare<{ last_commit_seq: number }>(
          "SELECT last_commit_seq FROM journal_state WHERE journal_id = :journal_id"
        )
        .get({ journal_id: journalId });
      return row === undefined ? 0 : Number(row.last_commit_seq);
    }
  });
  return writer.ok
    ? {
        ok: true,
        status: "ok",
        value: {
          writer: writer.value,
          journal_id: journalId,
          relative_path: relativePath
        }
      }
    : writer;
}

/**
 * Local FND install-approval port (DD-HOST-205).
 *
 * The local bridge has no IPC client, so it invokes the same FND handlers the
 * dispatcher would call. Consume still appends its journal frame through the
 * shared commit sequence before the SQL CAS; no approval is fabricated here.
 */
function createLocalApprovalPort(input: {
  readonly connection: SqliteConnection;
  readonly layout: ReturnType<typeof homeLayout>;
  readonly blob_store: BlobStore;
  readonly now: () => number;
}): Result<{ readonly port: HostInstallApprovalPort; readonly close: () => void }, ErrorEnvelope> {
  const opened = openLocalJournalWriter({
    connection: input.connection,
    journal_dir: input.layout.journal_dir
  });
  if (!opened.ok) {
    return opened;
  }
  const deps = {
    connection: input.connection,
    blob_store: input.blob_store,
    now: input.now,
    journal: {
      writer: opened.value.writer,
      relative_path: opened.value.relative_path
    }
  };
  const get = createInstallApprovalGetHandler(deps);
  const consume = createInstallApprovalConsumeHandler(deps);
  const context = (method: string, params: Record<string, unknown>): never =>
    ({
      request_id: newId("ipc"),
      method,
      params,
      client_id: "adp:00000000000000000000000000",
      client_kind: "cli",
      connection_id: "local-cli",
      deadline_ms: 30_000,
      signal: new AbortController().signal
    }) as never;
  return {
    ok: true,
    status: "ok",
    value: {
      port: {
        get(params) {
          return get(context("install.approval.get", { ...params }));
        },
        consume(params) {
          return consume(context("install.approval.consume", { ...params }));
        }
      },
      close: () => {
        opened.value.writer.close();
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* REV local commands                                                 */
/* ------------------------------------------------------------------ */

interface ReviewRuntime {
  readonly services: KernelReviewServices;
  readonly connection: SqliteConnection;
}

function reviewErrorCategory(code: string): "usage" | "schema" | "version" | "not_found" | "policy" | "authorization" | "budget" | "deadline" | "source" | "conflict" | "storage" | "ipc" | "capacity" | "external" | "internal" {
  if (code === "E_AUTH_DENIED" || code === "E_AUTH_UNAVAILABLE" || code === "E_REVIEW_EGRESS_NOT_APPROVED") {
    return "authorization";
  }
  if (code === "E_SCHEMA") return "schema";
  if (code === "E_VERSION_BINDING") return "version";
  if (code === "E_WRITE_NOT_FOUND") return "not_found";
  if (code.startsWith("E_STORAGE")) return "storage";
  if (code.startsWith("E_REVIEW_BUDGET") || code === "E_REVIEW_BUDGET_EXHAUSTED") return "budget";
  if (code === "E_DEADLINE_EXCEEDED") return "deadline";
  if (code === "E_SOURCE_UNRETRIEVABLE" || code === "E_SOURCE_TOO_LARGE" || code === "E_REVIEW_SNAPSHOT_SOURCE_MISSING") {
    return "source";
  }
  if (code.includes("CONFLICT") || code.includes("FENCING") || code.includes("LEASE")) return "conflict";
  if (code.startsWith("E_REVIEW_") || code.startsWith("E_PROPOSAL_") || code.startsWith("E_EXPERIENCE_")) return "policy";
  return "internal";
}

function reviewErrorEnvelope(error: ReviewServiceError): ErrorEnvelope {
  return makeErrorEnvelope({
    code: error.code as ErrorEnvelope["code"],
    category: reviewErrorCategory(error.code),
    message_key: `error.${error.code.toLowerCase()}`,
    stage: error.stage,
    retryable: error.retryable,
    side_effect: "none",
    details: { kind: "field", path: "review", rule: error.cause ?? error.code }
  });
}

function reviewFailureStatus(error: ReviewServiceError): FailureStatus {
  if (error.code === "E_AUTH_DENIED" || error.code === "E_AUTH_UNAVAILABLE") return "conflict";
  if (
    error.code === "E_REVIEW_BACKEND_UNAVAILABLE" ||
    error.code === "E_REVIEW_BUDGET_EXHAUSTED" ||
    error.code === "E_REVIEW_LEASE_EXPIRED" ||
    error.code === "E_HANDOFF_INCOMPLETE"
  ) {
    return "degraded";
  }
  return "rejected";
}

function reviewExitCode(error: ReviewServiceError): number {
  const category = reviewErrorCategory(error.code);
  if (category === "usage" || category === "schema") return EXIT_USAGE;
  if (category === "authorization" || category === "conflict") return EXIT_CONFLICT;
  if (category === "storage") return EXIT_DEGRADED;
  if (reviewFailureStatus(error) === "degraded") return EXIT_DEGRADED;
  return EXIT_FAILED;
}

async function openReviewRuntime(home: string, write: boolean): Promise<Result<ReviewRuntime, ErrorEnvelope>> {
  const config = await readConfigFile(home);
  if (!config.ok) {
    return { ok: false, status: config.status, error: config.error };
  }
  const opened = openHomeDatabase(home);
  if (!opened.ok) {
    return opened;
  }
  void write;
  const services = createReviewService({
    connection: opened.value,
    config: config.value,
    home,
    blob_store: BlobStore.open(homeLayout(home).blobs_dir),
    now: () => Date.now()
  });
  return { ok: true, status: "ok", value: { services, connection: opened.value } };
}

async function runReview(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) {
    return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  }
  const runtime = await openReviewRuntime(request.home, true);
  if (!runtime.ok) {
    await lock.value.release();
    return failure(runtime.status, runtime.error, ioExit(runtime.status, runtime.error));
  }
  try {
    const task = request.positionals[0] ?? null;
    const enqueued = await runtime.value.services.enqueueReview({ task });
    if (!enqueued.ok) {
      return failure(
        reviewFailureStatus(enqueued.error),
        reviewErrorEnvelope(enqueued.error),
        reviewExitCode(enqueued.error),
        enqueued.error.cause
      );
    }
    const value = enqueued.value;
    return success(
      {
        status: value.status,
        request_id: value.request_id,
        job_id: value.review_job_id,
        review_job_id: value.review_job_id,
        snapshot_id: value.snapshot_id,
        job_state: value.job_state,
        stage: value.stage,
        watermark: value.watermark,
        block_reason: value.block_reason ?? null
      },
      value.status === "blocked_no_backend" || value.job_state === "blocked_no_backend"
        ? EXIT_DEGRADED
        : EXIT_OK
    );
  } finally {
    runtime.value.connection.close();
    await lock.value.release();
  }
}

async function runSkillsDiff(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const id = request.positionals[0];
  if (id === undefined || id.length === 0) {
    return missingOption("id");
  }
  const runtime = await openReviewRuntime(request.home, false);
  if (!runtime.ok) {
    return failure(runtime.status, runtime.error, ioExit(runtime.status, runtime.error));
  }
  try {
    const diff = await runtime.value.services.skillDiff({ id });
    if (!diff.ok) {
      return failure(
        reviewFailureStatus(diff.error),
        reviewErrorEnvelope(diff.error),
        reviewExitCode(diff.error),
        diff.error.cause
      );
    }
    return success({
      status: diff.value.status,
      id: diff.value.id,
      kind: diff.value.kind,
      state: diff.value.state,
      diff_format: diff.value.diff_format ?? null,
      diff_ref: diff.value.diff_ref ?? null,
      diff_hash: diff.value.diff_hash ?? null,
      diff: diff.value.diff ?? null,
      target_object_type: diff.value.target_object_type ?? null,
      target_path_or_block: diff.value.target_path_or_block ?? null,
      experience_id: diff.value.experience_id ?? null
    });
  } finally {
    runtime.value.connection.close();
  }
}

async function runSkillsRevoke(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const id = request.positionals[0];
  if (id === undefined || id.length === 0) {
    return missingOption("id");
  }
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) {
    return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  }
  const runtime = await openReviewRuntime(request.home, true);
  if (!runtime.ok) {
    await lock.value.release();
    return failure(runtime.status, runtime.error, ioExit(runtime.status, runtime.error));
  }
  try {
    const revoked = await runtime.value.services.skillRevoke({ id, actor: "user" });
    if (!revoked.ok) {
      return failure(
        reviewFailureStatus(revoked.error),
        reviewErrorEnvelope(revoked.error),
        reviewExitCode(revoked.error),
        revoked.error.cause
      );
    }
    return success({
      status: revoked.value.status,
      id: revoked.value.id,
      kind: revoked.value.kind,
      lifecycle: revoked.value.lifecycle ?? null,
      state: revoked.value.state ?? null,
      row_version: revoked.value.row_version ?? null
    });
  } finally {
    runtime.value.connection.close();
    await lock.value.release();
  }
}

async function runSkillsResolve(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const id = request.positionals[0];
  if (id === undefined || id.length === 0) {
    return missingOption("id");
  }
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) {
    return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  }
  const runtime = await openReviewRuntime(request.home, true);
  if (!runtime.ok) {
    await lock.value.release();
    return failure(runtime.status, runtime.error, ioExit(runtime.status, runtime.error));
  }
  try {
    const resolved = await runtime.value.services.skillResolve({ id });
    if (!resolved.ok) {
      return failure(
        reviewFailureStatus(resolved.error),
        reviewErrorEnvelope(resolved.error),
        reviewExitCode(resolved.error),
        resolved.error.cause
      );
    }
    return success(
      {
        status: resolved.value.status,
        id: resolved.value.id,
        kind: resolved.value.kind,
        proposal_id: resolved.value.proposal_id ?? null,
        write_id: resolved.value.write_id ?? null,
        write_state: resolved.value.write_state ?? null,
        three_way_diff_ref: resolved.value.three_way_diff_ref ?? null,
        three_way_diff: resolved.value.three_way_diff ?? null,
        options: [...(resolved.value.options ?? [])]
      },
      resolved.value.status === "pending_manual_merge" ? EXIT_DEGRADED : EXIT_OK
    );
  } finally {
    runtime.value.connection.close();
    await lock.value.release();
  }
}

/* ------------------------------------------------------------------ */
/* init                                                               */
/* ------------------------------------------------------------------ */

export async function runInit(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const migrations = migrationsLocation();
  if (migrations === null) {
    return failure("rejected", internalError("kernel.migrations_not_found"), EXIT_UNAVAILABLE);
  }
  const marker = await readInitCompleteMarker(request.home);
  if (!marker.ok) {
    return failure(marker.status, marker.error, ioExit(marker.status, marker.error));
  }
  if (marker.value !== null && marker.value.schema_major > SCHEMA_MAJOR) {
    return failure("rejected", kernelError("E_SCHEMA_MAJOR_UNSUPPORTED", {
      details: { kind: "version", expected: String(SCHEMA_MAJOR), actual: String(marker.value.schema_major) }
    }), EXIT_UNAVAILABLE);
  }
  const persisted = marker.value === null ? null : await readConfigFile(request.home);
  if (persisted !== null && !persisted.ok) {
    return failure(persisted.status, persisted.error, ioExit(persisted.status, persisted.error));
  }
  const config = persisted?.value ?? createDefaultConfig({ config_space: "default", product_home: request.home });
  const database = createSqliteHomeDatabasePort({
    migrations,
    app_version: PRODUCT_VERSION
  });
  const initialized = await initializeHome({
    home: request.home,
    config,
    product_version: PRODUCT_VERSION,
    schema_major: marker.value?.schema_major ?? SCHEMA_MAJOR,
    database
  });
  if (!initialized.ok) {
    return failure(initialized.status, initialized.error, ioExit(initialized.status, initialized.error));
  }
  return success({
    status: initialized.value.status,
    config_version: initialized.value.config_version,
    config_hash: initialized.value.config_hash,
    schema_major: initialized.value.marker.schema_major
  });
}

/* ------------------------------------------------------------------ */
/* configure (write modes)                                            */
/* ------------------------------------------------------------------ */

function applyConfigProfile(
  connection: SqliteConnection,
  config: EvoplugConfig,
  configVersion: string,
  configHash: Hash,
  now: number
): void {
  const canonicalJson = canonicalConfigJson(config);
  const runner = createTransactionRunner(connection);
  runner.withTxSync((tx) => {
    tx.prepare(
      `UPDATE config_profile
          SET status = 'superseded'
        WHERE config_space = :config_space
          AND status = 'active'
          AND config_version <> :config_version`
    ).run({ config_space: config.config_space, config_version: configVersion });
    tx.prepare(
      `INSERT INTO config_profile (config_version, config_space, canonical_json, content_hash, status, created_at)
       VALUES (:config_version, :config_space, :canonical_json, :content_hash, 'active', :created_at)
       ON CONFLICT(config_version) DO UPDATE SET
         config_space = excluded.config_space,
         canonical_json = excluded.canonical_json,
         content_hash = excluded.content_hash,
         status = 'active'`
    ).run({
      config_version: configVersion,
      config_space: config.config_space,
      canonical_json: canonicalJson,
      content_hash: configHash,
      created_at: now
    });
    return undefined;
  });
}

function markerWithConfig(
  marker: InitCompleteMarker,
  configVersion: string,
  configHash: Hash,
  schemaMinor: number
): InitCompleteMarker {
  return {
    root: marker.root,
    product_version: marker.product_version,
    schema_major: marker.schema_major,
    config_version: configVersion,
    db_hash_marker: canonicalHash({
      schema_major: marker.schema_major,
      schema_minor: schemaMinor,
      config_version: configVersion,
      config_hash: configHash
    }),
    created_at: marker.created_at
  };
}

/**
 * Applies the `--credential-stdin` secret reference to the enabled backends.
 * The value is an opaque keychain/secret-store reference, never the secret
 * itself: values that look like raw credentials are rejected by the same
 * plaintext-secret rule `parseConfigText` applies to the config tree.
 */
function applyStdinSecretRef(
  config: EvoplugConfig,
  secretRef: string
): Result<EvoplugConfig, ErrorEnvelope> {
  if (secretRef.length === 0) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError("--credential-stdin", "empty_secret_ref")
    };
  }
  if (findPlaintextSecret(secretRef) !== null) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError("--credential-stdin", "plaintext_secret")
    };
  }
  const remoteEnabled = config.remote_inference.enabled;
  const reviewEnabled = config.review_backend.enabled;
  if (!remoteEnabled && !reviewEnabled) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError("--credential-stdin", "secret_ref_target_unavailable")
    };
  }

  const updated: EvoplugConfig = {
    ...config,
    remote_inference:
      remoteEnabled && config.remote_inference.enabled
        ? { ...config.remote_inference, secret_ref: secretRef }
        : config.remote_inference,
    review_backend:
      reviewEnabled && config.review_backend.enabled
        ? { ...config.review_backend, secret_ref: secretRef }
        : config.review_backend
  };
  return parseConfigText(canonicalConfigJson(updated));
}

async function runJevProvisionWrite(
  request: LocalCliRequest,
  inputPath: string
): Promise<LocalCliOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    return failure("rejected", fieldError(inputPath, "invalid_json"), EXIT_USAGE);
  }
  if (!isRecord(parsed) || !isRecord(parsed["profile"]) || !isRecord(parsed["capability"])) {
    return failure("rejected", fieldError(inputPath, "jev_provision_schema"), EXIT_USAGE);
  }
  const profile = parsed["profile"];
  const credentialRef = profile["credential_ref"];
  if (typeof credentialRef !== "string" || credentialRef.length === 0) {
    return failure("rejected", fieldError("profile.credential_ref", "missing"), EXIT_USAGE);
  }
  const plaintextPath = findPlaintextSecret(parsed);
  if (plaintextPath !== null) {
    return failure(
      "rejected",
      fieldError(plaintextPath.replace(/^\$\./u, ""), "plaintext_secret"),
      EXIT_USAGE
    );
  }
  const marker = await readInitCompleteMarker(request.home);
  if (!marker.ok) return failure(marker.status, marker.error, ioExit(marker.status, marker.error));
  if (marker.value === null) {
    return failure(
      "rejected",
      kernelError("E_HOME_INCOMPATIBLE", {
        details: { kind: "version", expected: "initialized_home", actual: "missing_init_complete" }
      }),
      EXIT_UNAVAILABLE
    );
  }
  const expectedProfile = parsed["expected_profile_version"];
  const expectedCapability = parsed["expected_capability_version"];
  if (
    (expectedProfile !== undefined &&
      (typeof expectedProfile !== "number" || !Number.isSafeInteger(expectedProfile) || expectedProfile < 0)) ||
    (expectedCapability !== undefined &&
      (typeof expectedCapability !== "number" || !Number.isSafeInteger(expectedCapability) || expectedCapability < 0))
  ) {
    return failure("rejected", fieldError(inputPath, "invalid_expected_version"), EXIT_USAGE);
  }

  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  const opened = openHomeDatabase(request.home);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  const layout = homeLayout(request.home);
  const blobs = BlobStore.open(layout.blobs_dir);
  const journal = openLocalJournalWriter({
    connection: opened.value,
    journal_dir: layout.journal_dir
  });
  if (!journal.ok) {
    opened.value.close();
    await lock.value.release();
    return failure(journal.status, journal.error, ioExit(journal.status, journal.error));
  }
  try {
    const writer = createDefaultEvidenceWriter({
      connection: opened.value,
      writer: journal.value.writer,
      relative_path: journal.value.relative_path,
      blob_store: blobs,
      now: () => Date.now()
    });
    let provisioning: Awaited<ReturnType<typeof provisionJevBinding>>;
    try {
      provisioning = await provisionJevBinding(writer.writer, {
        profile: profile as unknown as JevProvisioningInput["profile"],
        capability: parsed["capability"] as unknown as JevProvisioningInput["capability"],
        now: Date.now(),
        expected_profile_version: typeof expectedProfile === "number" ? expectedProfile : null,
        expected_capability_version: typeof expectedCapability === "number" ? expectedCapability : null
      });
    } catch {
      return failure("rejected", fieldError(inputPath, "jev_provision_schema"), EXIT_USAGE);
    }
    if (!provisioning.ok) {
      return failure(provisioning.status, provisioning.error, exitCodeForFailure(provisioning.status, provisioning.error));
    }
    return success({
      status: provisioning.commit_state === "existing" ? "existing" : "created",
      profile_key: provisioning.value.profile.profile_key,
      capability_key: provisioning.value.capability.capability_key,
      validator_binding_key: provisioning.value.validator.validator_binding_key
    });
  } finally {
    journal.value.writer.close();
    opened.value.close();
    await lock.value.release();
  }
}

export async function runConfigureWrite(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const jevInputPath = stringOption(request, "jev-input");
  if (jevInputPath !== null) {
    return runJevProvisionWrite(request, jevInputPath);
  }
  const credentialOption = request.options["credential-stdin"];
  if (credentialOption === true) {
    return failure(
      "rejected",
      fieldError("--credential-stdin", "secret_ref_required"),
      EXIT_USAGE
    );
  }
  const credentialRef = typeof credentialOption === "string" ? credentialOption : null;
  const inputPath = stringOption(request, "input");
  if (inputPath === null && credentialRef === null) {
    return missingOption("input");
  }

  const layout = homeLayout(request.home);
  const marker = await readInitCompleteMarker(request.home);
  if (!marker.ok) {
    return failure(marker.status, marker.error, ioExit(marker.status, marker.error));
  }
  if (marker.value === null) {
    return failure(
      "rejected",
      kernelError("E_HOME_INCOMPATIBLE", {
        details: { kind: "version", expected: "initialized_home", actual: "missing_init_complete" }
      }),
      EXIT_UNAVAILABLE
    );
  }
  const markerValue = marker.value;
  const current = await readConfigFile(request.home);
  if (!current.ok) {
    return failure(current.status, current.error, ioExit(current.status, current.error));
  }

  let next = current.value;
  if (inputPath !== null) {
    let text: string;
    try {
      text = await readFile(inputPath, "utf8");
    } catch {
      return failure("rejected", fieldError(inputPath, "file_not_found"), EXIT_USAGE);
    }
    const parsed = parseConfigText(text);
    if (!parsed.ok) {
      return failure(parsed.status, parsed.error, exitCodeForFailure(parsed.status, parsed.error));
    }
    next = parsed.value;
  }
  if (credentialRef !== null) {
    const applied = applyStdinSecretRef(next, credentialRef);
    if (!applied.ok) {
      return failure(applied.status, applied.error, exitCodeForFailure(applied.status, applied.error));
    }
    next = applied.value;
  }
  if (next.product_home !== request.home) {
    return failure(
      "rejected",
      fieldError("$.product_home", "must_equal_home"),
      EXIT_USAGE
    );
  }
  if (current.value.config_space !== next.config_space) {
    return failure("rejected", fieldError("$.config_space", "must_match_existing"), EXIT_USAGE);
  }

  const nextVersion = computeConfigVersion(next);
  const nextHash = computeConfigContentHash(next);
  const previousText = await readFile(layout.config_path, "utf8").catch((): null => null);
  const previousMarkerText = await readFile(layout.init_complete_path, "utf8").catch((): null => null);

  if (
    nextVersion === markerValue.config_version &&
    previousText !== null &&
    canonicalConfigJson(next) === previousText
  ) {
    return success({
      status: "no_op",
      config_version: nextVersion,
      config_hash: nextHash
    });
  }

  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) {
    return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  }

  const rollback = async (): Promise<void> => {
    if (previousText !== null) {
      await writeFileAtomicDurable(layout.config_path, previousText);
    }
    if (previousMarkerText !== null) {
      await writeFileAtomicDurable(layout.init_complete_path, previousMarkerText);
    }
    const reopened = openHomeDatabase(request.home);
    if (reopened.ok) {
      try {
        applyConfigProfile(
          reopened.value,
          current.value,
          markerValue.config_version,
          computeConfigContentHash(current.value),
          Date.now()
        );
      } catch {
        // best-effort rollback only
      } finally {
        reopened.value.close();
      }
    }
  };

  try {
    const written = await writeFileAtomicDurable(layout.config_path, canonicalConfigJson(next));
    if (!written.ok) {
      await rollback();
      return failure(written.status, written.error, ioExit(written.status, written.error));
    }

    const opened = openHomeDatabase(request.home);
    if (!opened.ok) {
      await rollback();
      return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
    }
    let schemaMinor = 0;
    try {
      applyConfigProfile(opened.value, next, nextVersion, nextHash, Date.now());
      schemaMinor = Number(readSchemaMeta(opened.value).get("schema_minor") ?? 0);
    } catch (error) {
      await rollback();
      return failure(
        "rejected",
        internalError("kernel.local_cli_configure_db_failed"),
        EXIT_DEGRADED,
        error instanceof Error ? error.name : "unknown_error"
      );
    } finally {
      opened.value.close();
    }

    const nextMarker = markerWithConfig(markerValue, nextVersion, nextHash, schemaMinor);
    const markerWritten = await writeFileAtomicDurable(
      layout.init_complete_path,
      `${JSON.stringify(nextMarker)}\n`
    );
    if (!markerWritten.ok) {
      await rollback();
      return failure(markerWritten.status, markerWritten.error, ioExit(markerWritten.status, markerWritten.error));
    }
    return success({
      status: "created",
      config_version: nextVersion,
      config_hash: nextHash
    });
  } finally {
    await lock.value.release();
  }
}

/* ------------------------------------------------------------------ */
/* install / uninstall (DD-FND-102)                                   */
/* ------------------------------------------------------------------ */

const INSTALL_MANIFEST_SCHEMA: "rsi.install_manifest/1" = "rsi.install_manifest/1";
const INSTALL_CURRENT_SCHEMA: "rsi.install_current/1" = "rsi.install_current/1";
const INSTALL_MANIFEST_FILE = ".rsi-install.json";
const INSTALL_CURRENT_FILE = "current.json";

type InstallEntryKind = "file" | "directory";

interface InstallEntry {
  readonly path: string;
  readonly kind: InstallEntryKind;
  readonly hash: Hash | null;
}

interface InstallManifestFile {
  readonly schema_version: "rsi.install_manifest/1";
  readonly install_id: string;
  readonly product_version: string;
  readonly schema_major: number;
  readonly install_root: string;
  readonly home_root: string;
  readonly status: "installed";
  readonly files: readonly InstallEntry[];
  readonly created_at: number;
  readonly updated_at: number;
}

interface InstallCurrentPointer {
  readonly schema_version: "rsi.install_current/1";
  readonly product_version: string;
  readonly install_root: string;
  readonly manifest_hash: Hash;
  readonly updated_at: number;
}

function installRoot(home: string): string {
  return join(home, "install");
}

function installDestination(home: string): string {
  return join(installRoot(home), PRODUCT_VERSION);
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // directory fsync is best effort on platforms that refuse to open dirs
  }
}

async function walkSource(root: string): Promise<Result<readonly InstallEntry[], ErrorEnvelope>> {
  const entries: InstallEntry[] = [];
  const visit = async (directory: string): Promise<ErrorEnvelope | null> => {
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch {
      return kernelError("E_IO", { details: { kind: "field", path: "install_source", rule: "readdir_failed" } });
    }
    dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const dirent of dirents) {
      const absolute = join(directory, dirent.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (dirent.isSymbolicLink()) {
        return kernelError("E_PATH_ESCAPE", {
          details: { kind: "field", path: rel, rule: "symlink_not_allowed" }
        });
      }
      if (dirent.isDirectory()) {
        entries.push({ path: rel, kind: "directory", hash: null });
        const nested = await visit(absolute);
        if (nested !== null) {
          return nested;
        }
        continue;
      }
      if (!dirent.isFile()) {
        return kernelError("E_INSTALL_CONFLICT", {
          details: { kind: "field", path: rel, rule: "unsupported_entry" }
        });
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(absolute);
      } catch {
        return kernelError("E_IO", { details: { kind: "field", path: rel, rule: "read_failed" } });
      }
      entries.push({ path: rel, kind: "file", hash: hashBytes(bytes) });
    }
    return null;
  };
  const failed = await visit(root);
  if (failed !== null) {
    return { ok: false, status: "rejected", error: failed };
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { ok: true, status: "ok", value: entries };
}

function entriesMatch(left: readonly InstallEntry[], right: readonly InstallEntry[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return false;
    }
    if (a.path !== b.path || a.kind !== b.kind || a.hash !== b.hash) {
      return false;
    }
  }
  return true;
}

async function readInstallManifest(path: string): Promise<InstallManifestFile | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["schema_version"] !== INSTALL_MANIFEST_SCHEMA) {
    return null;
  }
  const files = parsed["files"];
  if (!Array.isArray(files)) {
    return null;
  }
  const entries: InstallEntry[] = [];
  for (const item of files) {
    if (!isRecord(item)) {
      return null;
    }
    const pathValue = item["path"];
    const kind = item["kind"];
    const hash = item["hash"];
    if (
      typeof pathValue !== "string" ||
      (kind !== "file" && kind !== "directory") ||
      (hash !== null && !(typeof hash === "string" && isHash(hash)))
    ) {
      return null;
    }
    entries.push({ path: pathValue, kind, hash: typeof hash === "string" ? hash : null });
  }
  const installId = parsed["install_id"];
  const productVersion = parsed["product_version"];
  const schemaMajor = parsed["schema_major"];
  const root = parsed["install_root"];
  const homeRoot = parsed["home_root"];
  const createdAt = parsed["created_at"];
  const updatedAt = parsed["updated_at"];
  if (
    typeof installId !== "string" ||
    typeof productVersion !== "string" ||
    typeof schemaMajor !== "number" ||
    typeof root !== "string" ||
    typeof homeRoot !== "string" ||
    typeof createdAt !== "number" ||
    typeof updatedAt !== "number"
  ) {
    return null;
  }
  return {
    schema_version: INSTALL_MANIFEST_SCHEMA,
    install_id: installId,
    product_version: productVersion,
    schema_major: schemaMajor,
    install_root: root,
    home_root: homeRoot,
    status: "installed",
    files: entries,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

async function recordInstallInDatabase(
  home: string,
  manifest: InstallManifestFile
): Promise<void> {
  const marker = await readInitCompleteMarker(home);
  if (!marker.ok || marker.value === null) {
    return;
  }
  recordInstallRows(home, manifest);
}

function recordInstallRows(home: string, manifest: InstallManifestFile): void {
  const opened = openHomeDatabase(home);
  if (!opened.ok) {
    return;
  }
  try {
    const runner = createTransactionRunner(opened.value);
    runner.withTxSync((tx) => {
      const existing = tx
        .prepare<{ install_id: string }>(
          "SELECT install_id FROM install_manifest WHERE install_root = :install_root"
        )
        .get({ install_root: manifest.install_root });
      const installId = existing === undefined ? manifest.install_id : existing.install_id;
      tx.prepare(
        `INSERT INTO install_manifest
           (install_id, product_version, schema_major, install_root, home_root, status, created_at, updated_at)
         VALUES (:install_id, :product_version, :schema_major, :install_root, :home_root, 'installed', :created_at, :updated_at)
         ON CONFLICT(install_root) DO UPDATE SET
           product_version = excluded.product_version,
           schema_major = excluded.schema_major,
           status = 'installed',
           updated_at = excluded.updated_at`
      ).run({
        install_id: installId,
        product_version: manifest.product_version,
        schema_major: manifest.schema_major,
        install_root: manifest.install_root,
        home_root: manifest.home_root,
        created_at: manifest.created_at,
        updated_at: manifest.updated_at
      });
      tx.prepare("DELETE FROM install_path WHERE install_id = :install_id").run({
        install_id: installId
      });
      const insert = tx.prepare(
        `INSERT INTO install_path
           (install_id, path, kind, ownership, marker_id, installed_hash, origin_hash, state, created_at, updated_at)
         VALUES (:install_id, :path, :kind, 'managed', NULL, :installed_hash, :origin_hash, 'present', :created_at, :updated_at)`
      );
      for (const entry of manifest.files) {
        insert.run({
          install_id: installId,
          path: join(manifest.install_root, entry.path),
          kind: entry.kind,
          installed_hash: entry.hash,
          origin_hash: entry.hash,
          created_at: manifest.created_at,
          updated_at: manifest.updated_at
        });
      }
      return undefined;
    });
  } catch {
    // the file manifest stays authoritative; the index is best effort
  } finally {
    opened.value.close();
  }
}

async function destinationMatchesEntries(
  root: string,
  entries: readonly InstallEntry[]
): Promise<boolean> {
  for (const entry of entries) {
    const absolute = join(root, entry.path);
    try {
      if (entry.kind === "directory") {
        const stats = await stat(absolute);
        if (!stats.isDirectory()) {
          return false;
        }
        continue;
      }
      const bytes = await readFile(absolute);
      if (entry.hash === null || hashBytes(bytes) !== entry.hash) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export async function runInstall(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const from = stringOption(request, "from");
  if (from === null) {
    return missingOption("from");
  }
  let sourceStats;
  try {
    sourceStats = await stat(from);
  } catch {
    return failure("rejected", fieldError("--from", "directory_not_found"), EXIT_USAGE);
  }
  if (!sourceStats.isDirectory()) {
    return failure("rejected", fieldError("--from", "must_be_directory"), EXIT_USAGE);
  }
  const walked = await walkSource(from);
  if (!walked.ok) {
    return failure(walked.status, walked.error, ioExit(walked.status, walked.error));
  }

  const root = installRoot(request.home);
  const destination = installDestination(request.home);
  const currentPath = join(root, INSTALL_CURRENT_FILE);
  const existing = await readInstallManifest(join(destination, INSTALL_MANIFEST_FILE));
  if (
    existing !== null &&
    entriesMatch(existing.files, walked.value) &&
    (await destinationMatchesEntries(destination, existing.files))
  ) {
    if (flagOption(request, "dry-run")) {
      return success({
        status: "no_op",
        product_version: PRODUCT_VERSION,
        file_count: walked.value.filter((entry) => entry.kind === "file").length,
        dry_run: true
      });
    }
    await recordInstallInDatabase(request.home, existing);
    return success({
      status: "no_op",
      product_version: PRODUCT_VERSION,
      file_count: walked.value.filter((entry) => entry.kind === "file").length
    });
  }
  if (existing !== null) {
    return failure(
      "rejected",
      kernelError("E_INSTALL_CONFLICT", {
        details: { kind: "field", path: "install_root", rule: "managed_files_differ" }
      }),
      EXIT_CONFLICT
    );
  }
  let destinationEntries: readonly string[] = [];
  try {
    destinationEntries = await readdir(destination);
  } catch {
    destinationEntries = [];
  }
  if (destinationEntries.length > 0) {
    return failure(
      "rejected",
      kernelError("E_INSTALL_CONFLICT", {
        details: { kind: "field", path: "install_root", rule: "not_product_managed" }
      }),
      EXIT_CONFLICT
    );
  }

  // A dry run reports the planned install and writes nothing: no install
  // root, no staging directory, no manifest and no current pointer.
  if (flagOption(request, "dry-run")) {
    return success({
      status: "created",
      product_version: PRODUCT_VERSION,
      file_count: walked.value.filter((entry) => entry.kind === "file").length,
      dry_run: true
    });
  }

  const staging = join(root, `.staging-${String(process.pid)}-${String(Date.now())}`);
  const now = Date.now();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await cp(from, staging, { recursive: true, force: false, errorOnExist: false });
    await chmod(staging, 0o700);
  } catch {
    await rm(staging, { recursive: true, force: true }).catch((): void => undefined);
    return failure("rejected", internalError("kernel.local_cli_install_stage_failed"), EXIT_DEGRADED);
  }

  const installed = await walkSource(staging);
  if (!installed.ok || !entriesMatch(installed.value, walked.value)) {
    await rm(staging, { recursive: true, force: true }).catch((): void => undefined);
    return failure("rejected", internalError("kernel.local_cli_install_verify_failed"), EXIT_DEGRADED);
  }

  const manifest: InstallManifestFile = {
    schema_version: INSTALL_MANIFEST_SCHEMA,
    install_id: newId("ev"),
    product_version: PRODUCT_VERSION,
    schema_major: SCHEMA_MAJOR,
    install_root: destination,
    home_root: request.home,
    status: "installed",
    files: walked.value,
    created_at: now,
    updated_at: now
  };
  const manifestWritten = await writeFileAtomicDurable(
    join(staging, INSTALL_MANIFEST_FILE),
    `${JSON.stringify(manifest)}\n`
  );
  if (!manifestWritten.ok) {
    await rm(staging, { recursive: true, force: true }).catch((): void => undefined);
    return failure(manifestWritten.status, manifestWritten.error, ioExit(manifestWritten.status, manifestWritten.error));
  }

  // The rename that publishes the staging tree is the crash window: after it
  // the install root exists but the current pointer may not. The staged tree
  // is therefore copied into `<home>/backups/install-*` first, so a crashed
  // install always leaves a restorable copy (DD-FND-102).
  const backupRoot = join(request.home, "backups");
  const backupPath = join(backupRoot, `install-${String(now)}-${manifest.install_id}`);
  try {
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await cp(staging, backupPath, { recursive: true, force: false, errorOnExist: false });
    await chmod(backupPath, 0o700);
  } catch {
    // A missing backup does not block the install; the staging tree and the
    // manifest remain the authoritative recovery sources.
  }

  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    await fsyncDirectory(root);
  } catch {
    await rm(staging, { recursive: true, force: true }).catch((): void => undefined);
    return failure("rejected", internalError("kernel.local_cli_install_rename_failed"), EXIT_DEGRADED);
  }

  const pointer: InstallCurrentPointer = {
    schema_version: INSTALL_CURRENT_SCHEMA,
    product_version: PRODUCT_VERSION,
    install_root: destination,
    manifest_hash: hashBytes(new TextEncoder().encode(JSON.stringify(manifest))),
    updated_at: now
  };
  const pointerWritten = await writeFileAtomicDurable(
    currentPath,
    `${JSON.stringify(pointer)}\n`
  );
  if (!pointerWritten.ok) {
    return failure(pointerWritten.status, pointerWritten.error, ioExit(pointerWritten.status, pointerWritten.error));
  }

  await recordInstallInDatabase(request.home, manifest);
  return success({
    status: "created",
    product_version: PRODUCT_VERSION,
    file_count: walked.value.filter((entry) => entry.kind === "file").length
  });
}

const HOME_LAYOUT_ENTRIES: ReadonlySet<string> = new Set([
  "config.json",
  "config.json.tmp",
  "config.lock",
  "init.complete.json",
  "db",
  "journal",
  "blobs",
  "runtime",
  "quarantine",
  "backups",
  "logs",
  "install"
]);

async function purgeHome(home: string): Promise<Result<void, ErrorEnvelope>> {
  let entries;
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    return { ok: false, status: "rejected", error: kernelError("E_IO", { details: { kind: "none" } }) };
  }
  for (const entry of entries) {
    if (!HOME_LAYOUT_ENTRIES.has(entry.name)) {
      return {
        ok: false,
        status: "conflict",
        error: kernelError("E_UNINSTALL_NONMANAGED", {
          details: { kind: "field", path: entry.name, rule: "non_managed_entry" }
        })
      };
    }
  }
  try {
    await rm(home, { recursive: true, force: true });
  } catch {
    return { ok: false, status: "rejected", error: kernelError("E_IO", { details: { kind: "none" } }) };
  }
  return { ok: true, status: "ok", value: undefined };
}

async function recordUninstallInDatabase(
  home: string,
  manifest: InstallManifestFile,
  states: ReadonlyMap<string, "removed" | "modified_by_user" | "missing">
): Promise<void> {
  const marker = await readInitCompleteMarker(home);
  if (!marker.ok || marker.value === null) {
    return;
  }
  const opened = openHomeDatabase(home);
  if (!opened.ok) {
    return;
  }
  try {
    const runner = createTransactionRunner(opened.value);
    const now = Date.now();
    runner.withTxSync((tx) => {
      tx.prepare(
        `UPDATE install_manifest
            SET status = 'uninstalled', updated_at = :now
          WHERE install_root = :install_root`
      ).run({ now, install_root: manifest.install_root });
      const update = tx.prepare(
        `UPDATE install_path
            SET state = :state, updated_at = :now
          WHERE install_id = (
                  SELECT install_id FROM install_manifest WHERE install_root = :install_root
                )
            AND path = :path`
      );
      for (const [path, state] of states) {
        update.run({ state, now, install_root: manifest.install_root, path });
      }
      return undefined;
    });
  } catch {
    // the file manifest stays authoritative; the index is best effort
  } finally {
    opened.value.close();
  }
}

export async function runUninstall(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const root = installRoot(request.home);
  const currentPath = join(root, INSTALL_CURRENT_FILE);
  let manifest = await readInstallManifest(join(installDestination(request.home), INSTALL_MANIFEST_FILE));
  if (manifest === null) {
    try {
      const pointer: unknown = JSON.parse(await readFile(currentPath, "utf8"));
      if (isRecord(pointer) && typeof pointer["install_root"] === "string") {
        manifest = await readInstallManifest(join(pointer["install_root"], INSTALL_MANIFEST_FILE));
      }
    } catch {
      manifest = null;
    }
  }
  if (manifest === null) {
    try {
      const candidates = await readdir(root, { withFileTypes: true });
      for (const candidate of candidates) {
        if (!candidate.isDirectory() || candidate.name.startsWith(".staging-")) {
          continue;
        }
        const found = await readInstallManifest(
          join(root, candidate.name, INSTALL_MANIFEST_FILE)
        );
        if (found !== null) {
          manifest = found;
          break;
        }
      }
    } catch {
      manifest = null;
    }
  }
  if (manifest === null) {
    if (flagOption(request, "purge-data")) {
      if (flagOption(request, "dry-run")) {
        return success({ status: "no_op", removed: 0, modified: 0, purged: true, dry_run: true });
      }
      const purged = await purgeHome(request.home);
      if (!purged.ok) {
        return failure(purged.status, purged.error, exitCodeForFailure(purged.status, purged.error));
      }
      return success({ status: "no_op", removed: 0, modified: 0, purged: true });
    }
    return success({ status: "no_op", removed: 0, modified: 0, purged: false, dry_run: flagOption(request, "dry-run") });
  }

  // A dry run classifies every manifest path and deletes nothing: no
  // unlink, no rmdir, no manifest removal and no current-pointer removal.
  if (flagOption(request, "dry-run")) {
    let removable = 0;
    let modified = 0;
    let missing = 0;
    for (const entry of manifest.files) {
      if (entry.kind === "directory") {
        removable += 1;
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(join(manifest.install_root, entry.path));
      } catch {
        missing += 1;
        continue;
      }
      if (entry.hash !== null && hashBytes(bytes) === entry.hash) {
        removable += 1;
      } else {
        modified += 1;
      }
    }
    const status = modified > 0 ? "partial" : "removed";
    return success(
      { status, removed: removable, modified, missing, purged: false, dry_run: true },
      modified > 0 ? EXIT_DEGRADED : EXIT_OK
    );
  }

  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) {
    return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  }
  const activeManifest = manifest;

  let removed = 0;
  let modified = 0;
  let missing = 0;
  const directories: string[] = [];
  const states = new Map<string, "removed" | "modified_by_user" | "missing">();
  try {
    for (const entry of activeManifest.files) {
      const absolute = join(activeManifest.install_root, entry.path);
      if (entry.kind === "directory") {
        directories.push(absolute);
        states.set(absolute, "removed");
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(absolute);
      } catch {
        missing += 1;
        states.set(absolute, "missing");
        continue;
      }
      if (entry.hash !== null && hashBytes(bytes) === entry.hash) {
        await unlink(absolute).catch((): void => undefined);
        removed += 1;
        states.set(absolute, "removed");
      } else {
        modified += 1;
        states.set(absolute, "modified_by_user");
      }
    }
    directories.sort((left, right) => right.length - left.length);
    for (const directory of directories) {
      await rmdir(directory).catch((): void => undefined);
    }
    await recordUninstallInDatabase(request.home, activeManifest, states);
    await rm(join(activeManifest.install_root, INSTALL_MANIFEST_FILE), { force: true }).catch(
      (): void => undefined
    );
    await rm(currentPath, { force: true }).catch((): void => undefined);
    await rmdir(activeManifest.install_root).catch((): void => undefined);
    await rmdir(root).catch((): void => undefined);
  } finally {
    await lock.value.release();
  }

  if (flagOption(request, "purge-data")) {
    const purged = await purgeHome(request.home);
    if (!purged.ok) {
      return failure(purged.status, purged.error, exitCodeForFailure(purged.status, purged.error));
    }
    return success({ status: "removed", removed, modified, purged: true });
  }

  const status = modified > 0 ? "partial" : "removed";
  return success({ status, removed, modified, missing, purged: false }, modified > 0 ? EXIT_DEGRADED : EXIT_OK);
}

/* ------------------------------------------------------------------ */
/* serve                                                              */
/* ------------------------------------------------------------------ */

export async function runServeCommand(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const argv: string[] = ["--home", request.home];
  if (flagOption(request, "foreground")) {
    argv.push("--foreground");
  }
  for (const name of [
    "generation-binding-key",
    "generation-executable",
    "config-reload-host",
    "config-reload-executable",
    "config-reload-workspace"
  ]) {
    const value = stringOption(request, name);
    if (value !== null) argv.push(`--${name}`, value);
  }
  const credentialEnv = stringOption(request, "jev-credential-env");
  if (credentialEnv !== null) {
    argv.push("--jev-credential-env", credentialEnv);
  }
  const credentialRef = stringOption(request, "jev-credential-ref");
  if (credentialRef !== null) {
    argv.push("--jev-credential-ref", credentialRef);
  }
  const allowedHosts = stringOption(request, "jev-allowed-hosts");
  if (allowedHosts !== null) {
    for (const host of allowedHosts.split(",").map((value) => value.trim()).filter((value) => value.length > 0)) {
      argv.push("--jev-allowed-host", host);
    }
  }
  const served = await runServe(argv, process.env);
  if (served.exit_code === EXIT_OK) {
    return success({ status: "stopped" });
  }
  if (served.exit_code === EXIT_CANCELLED) {
    return failure("rejected", kernelError("E_CANCELLED"), EXIT_CANCELLED);
  }
  return failure(
    "rejected",
    internalError(`kernel.serve_exit:${String(served.exit_code)}`),
    served.exit_code
  );
}

/* ------------------------------------------------------------------ */
/* export / import                                                    */
/* ------------------------------------------------------------------ */

export async function runExport(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const outPath = stringOption(request, "out");
  if (outPath === null || outPath.length === 0) {
    return missingOption("out");
  }
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) {
    return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  }
  try {
    // Read the config under the writer lock so the exported config bytes and
    // the database snapshot describe the same instant.
    const config = await readConfigFile(request.home);
    if (!config.ok) {
      return failure(config.status, config.error, ioExit(config.status, config.error));
    }
    const exported = await exportHomeSnapshot({
      layout: snapshotHomeLayout(request.home),
      out_path: outPath,
      driver: createSqliteDriver(),
      product_version: PRODUCT_VERSION,
      config_text: canonicalConfigJson(config.value)
    });
    if (!exported.ok) {
      return failure(exported.status, exported.error, ioExit(exported.status, exported.error));
    }
    const value = exported.value;
    return success({
      status: "created",
      out_path: value.out_path,
      schema_major: value.schema_major,
      schema_minor: value.schema_minor,
      manifest_hash: value.manifest_hash,
      database_bytes: value.database_bytes,
      journal_files: value.journal_files,
      blob_files: value.blob_files,
      byte_length: value.byte_length
    });
  } finally {
    await lock.value.release();
  }
}

export async function runImport(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const inPath = stringOption(request, "in");
  if (inPath === null || inPath.length === 0) {
    return missingOption("in");
  }
  const imported = await importHomeSnapshot({
    home: request.home,
    in_path: inPath,
    driver: createSqliteDriver(),
    product_version: PRODUCT_VERSION,
    validate_config_text: (text) => {
      const parsed = parseConfigText(text);
      return parsed.ok
        ? { ok: true, status: "ok", value: undefined }
        : { ok: false, status: parsed.status, error: parsed.error };
    }
  });
  if (!imported.ok) {
    return failure(imported.status, imported.error, ioExit(imported.status, imported.error));
  }
  const value = imported.value;
  return success({
    status: value.status,
    home: value.home,
    schema_major: value.schema_major,
    schema_minor: value.schema_minor,
    manifest_hash: value.manifest_hash,
    database_hash: value.database_hash,
    journal_files: value.journal_files,
    blob_files: value.blob_files,
    table_rows: value.table_rows,
    byte_length: value.byte_length,
    config_restored: value.config_restored
  });
}

/* ------------------------------------------------------------------ */
/* Host attach / detach                                             */
/* ------------------------------------------------------------------ */

function hostAttachStatus(error: ErrorEnvelope): FailureStatus {
  if (error.category === "authorization" || error.category === "conflict") {
    return "conflict";
  }
  if (error.category === "storage" || error.category === "deadline") {
    return "degraded";
  }
  return "rejected";
}

/**
 * A release artifact root holds either a directory-form `manifest.json` or the
 * single-file form's `<name>.runtime/manifest.json`.
 */
function isArtifactRoot(dir: string): boolean {
  return (
    existsSync(join(dir, "manifest.json")) ||
    existsSync(join(dir, "evoplug.runtime", "manifest.json"))
  );
}

/**
 * Resolves the artifact source for `attach` when `--artifact-dir` is absent
 * (DD-HOST-200.2: attach consumes a published artifact, it never builds one).
 *
 * `EVOPLUG_RUNTIME_ARTIFACT_DIR` names a directory that is either the artifact
 * root itself or a parent holding one directory per host id. Otherwise the
 * installed release layout `<install>/<version>/runtime/<host>` is used. When
 * neither exists the caller reports `artifact_source_required`.
 */
function defaultArtifactDir(home: string, host_id: string): string | undefined {
  const configured = process.env["EVOPLUG_RUNTIME_ARTIFACT_DIR"];
  if (configured !== undefined && configured.length > 0) {
    const root = resolve(configured);
    if (isArtifactRoot(root)) {
      return root;
    }
    const perHost = join(root, host_id);
    if (isArtifactRoot(perHost)) {
      return perHost;
    }
  }
  const installed = join(installDestination(home), "runtime", host_id);
  if (isArtifactRoot(installed)) {
    return installed;
  }
  return undefined;
}

/** Queue an unarmed intent; a later authenticated runtime boundary can claim it. */
async function scheduleLocalAttachProbe(input: {
  readonly connection: SqliteConnection;
  readonly blobs: BlobStore;
  readonly layout: ReturnType<typeof homeLayout>;
  readonly now: () => number;
  readonly registration_hash: Hash;
  readonly artifact_hash: Hash;
}): Promise<void> {
  const opened = openLocalJournalWriter({
    connection: input.connection,
    journal_dir: input.layout.journal_dir
  });
  if (!opened.ok) throw opened.error;
  try {
    const producer = createRuntimeProbeProducer({
      connection: input.connection,
      blobs: input.blobs,
      source_refs: createSourceRefPort({ connection: input.connection, blob_store: input.blobs }),
      state_rows: createHostStateRowAppendAdapter(createFndStateRowPort({
        connection: input.connection,
        writer: opened.value.writer,
        relative_path: opened.value.relative_path,
        blob_store: input.blobs,
        now: input.now
      })),
      binding: createProbeBindingDeclarationPort(input.connection),
      options: { enabled: true, on_attach: true },
      now: input.now
    });
    try {
      const result = await producer.schedule({
        registration_hash: input.registration_hash,
        artifact_hash: input.artifact_hash
      });
      if (!result.ok) throw result.error;
    } finally {
      await producer.drain();
    }
  } finally {
    opened.value.writer.close();
  }
}

async function runHostAttach(
  request: LocalCliRequest,
  command: "attach" | "detach"
): Promise<LocalCliOutcome> {
  const host = request.positionals[0];
  if (host === undefined || host.length === 0) {
    return missingOption("host");
  }
  const defaults = attachDefaults(host);
  if (defaults === null) {
    return failure(
      "rejected",
      makeErrorEnvelope({
        code: "E_UNSUPPORTED",
        category: "policy",
        message_key: "error.e_unsupported",
        stage: "host_attach_registry",
        details: { kind: "field", path: "host", rule: host }
      }),
      EXIT_UNAVAILABLE,
      `no packaged registration artifact for host ${host}`
    );
  }
  const configSpace = stringOption(request, "config-space") ?? defaults.config_space;
  const mode = (stringOption(request, "mode") ?? defaults.mode) as HostMode;
  const targetId = stringOption(request, "target") ?? undefined;
  const explicitArtifactDir = stringOption(request, "artifact-dir");
  const artifactDir =
    explicitArtifactDir === null
      ? defaultArtifactDir(request.home, defaults.host_id)
      : resolve(explicitArtifactDir);
  const approvalId = stringOption(request, "approval-id");
  const approvalHash = stringOption(request, "approval-hash");
  if ((approvalId === null) !== (approvalHash === null)) {
    return missingOption(approvalId === null ? "approval-id" : "approval-hash");
  }
  if (approvalId !== null && approvalHash !== null && !isHash(approvalHash)) {
    return failure(
      "rejected",
      fieldError("--approval-hash", "sha256_hash"),
      EXIT_USAGE
    );
  }
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) {
    return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  }
  const opened = openHomeDatabase(request.home);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  let approvalPort: ReturnType<typeof createLocalApprovalPort> | null = null;
  try {
    const layout = homeLayout(request.home);
    const blobs = BlobStore.open(layout.blobs_dir);
    const now = (): number => Date.now();
    const config = await readConfigFile(request.home);
    if (!config.ok) {
      return failure(config.status, config.error, ioExit(config.status, config.error));
    }
    const probeOnAttach = command === "attach" &&
      config.value.features?.includes("runtime_probe") === true &&
      resolveFeatureConfig(config.value).probe.on_attach;
    if (command === "attach" && approvalId !== null && approvalHash !== null) {
      const created = createLocalApprovalPort({
        connection: opened.value,
        layout,
        blob_store: blobs,
        now
      });
      if (!created.ok) {
        return failure(created.status, created.error, exitCodeForFailure(created.status, created.error));
      }
      approvalPort = created;
    }
    const deps: HostAttachDeps = {
      connection: opened.value,
      blobs,
      ...(probeOnAttach ? {
        probe: {
          onAttached: (attached) => scheduleLocalAttachProbe({
            connection: opened.value,
            blobs,
            layout,
            now,
            registration_hash: attached.registration_hash,
            artifact_hash: attached.artifact_hash
          })
        }
      } satisfies Pick<HostAttachDeps, "probe"> : {}),
      registry: createHostAdapterRegistry({
        ...(artifactDir === undefined ? {} : { artifact_dir: artifactDir }),
        // Detach must resolve the managed `json_merge` entries it wrote even
        // when no build artifact directory is supplied; the installed artifact
        // root recorded during attach carries the same manifest.
        ...(command === "detach" ? { resolve_installed_artifact: true } : {})
      }),
      ...(approvalPort === null
        ? {}
        : {
            approvals: approvalPort.value.port,
            approval_request: {
              approval_id: approvalId as string,
              approval_hash: approvalHash as Hash
            }
          }),
      ...(command === "detach"
        ? {
            sessions: {
              revokeBindingSessions: (registrationHash: Hash) => {
                try {
                  return ok(
                    revokeHostRuntimeSessions({
                      connection: opened.value,
                      now: now(),
                      registration_hash: registrationHash
                    })
                  );
                } catch {
                  return err(internalError("kernel.host_detach_session_revoke"));
                }
              }
            }
          }
        : {}),
      now,
      home_root: request.home,
      product_version: PRODUCT_VERSION,
      schema_major: SCHEMA_MAJOR
    };
    const operation = command === "attach" ? attachHost(deps) : detachHost(deps);
    const result = await operation({
      host_id: defaults.host_id,
      mode,
      config_space: configSpace,
      ...(targetId === undefined ? {} : { target_id: targetId })
    });
    if (!result.ok) {
      const status = hostAttachStatus(result.error);
      return failure(status, result.error, exitCodeForFailure(status, result.error));
    }
    return success(
      toJsonValue(result.value),
      result.value.status === "partial" ? EXIT_DEGRADED : EXIT_OK
    );
  } finally {
    approvalPort?.value.close();
    await lock.value.release();
  }
}

/* ------------------------------------------------------------------ */
/* Commands without a shipped capability                              */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Request parsing and dispatch                                       */
/* ------------------------------------------------------------------ */

function parseRequest(value: unknown): LocalCliRequest | null {
  if (!isRecord(value) || value["schema_version"] !== LOCAL_CLI_REQUEST_SCHEMA) {
    return null;
  }
  const command = value["command"];
  const home = value["home"];
  if (typeof command !== "string" || command.length === 0 || typeof home !== "string" || home.length === 0) {
    return null;
  }
  const positionalsRaw = value["positionals"];
  const positionals: string[] = [];
  if (positionalsRaw !== undefined) {
    if (!Array.isArray(positionalsRaw)) {
      return null;
    }
    for (const item of positionalsRaw) {
      if (typeof item !== "string") {
        return null;
      }
      positionals.push(item);
    }
  }
  const options: Record<string, LocalCliOptionValue> = {};
  const optionsRaw = value["options"];
  if (optionsRaw !== undefined) {
    if (!isRecord(optionsRaw)) {
      return null;
    }
    for (const [key, item] of Object.entries(optionsRaw)) {
      if (item !== true && typeof item !== "string") {
        return null;
      }
      options[key] = item;
    }
  }
  return {
    schema_version: LOCAL_CLI_REQUEST_SCHEMA,
    command,
    positionals,
    options,
    home,
    json: value["json"] === true
  };
}

export async function dispatch(request: LocalCliRequest): Promise<LocalCliOutcome> {
  switch (request.command) {
    case "init":
      return runInit(request);
    case "configure":
      return runConfigureWrite(request);
    case "install":
      return runInstall(request);
    case "uninstall":
      return runUninstall(request);
    case "serve":
      return runServeCommand(request);
    case "export":
      return runExport(request);
    case "import":
      return runImport(request);
    case "review":
      return runReview(request);
    case "skills.diff":
      return runSkillsDiff(request);
    case "skills.revoke":
      return runSkillsRevoke(request);
    case "skills.resolve":
      return runSkillsResolve(request);
    case "attach":
      return runHostAttach(request, "attach");
    case "detach":
      return runHostAttach(request, "detach");
    default:
      return failure(
        "rejected",
        internalError(`kernel.local_cli_unknown_command:${request.command}`),
        EXIT_USAGE
      );
  }
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
    }
  }
  return chunks.join("");
}

async function main(): Promise<void> {
  const inline = process.argv[2];
  const text = inline !== undefined && inline.length > 0 ? inline : await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const request = parseRequest(parsed);
  if (request === null) {
    const outcome = failure(
      "rejected",
      fieldError("request", "invalid_local_cli_request"),
      EXIT_USAGE
    );
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    process.exitCode = outcome.exit_code;
    return;
  }
  let outcome: LocalCliOutcome;
  try {
    outcome = await dispatch(request);
  } catch (error) {
    outcome = failure(
      "rejected",
      internalError(`kernel.local_cli_unhandled:${error instanceof Error ? error.name : "unknown"}`),
      EXIT_FAILED
    );
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exitCode = outcome.exit_code;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
