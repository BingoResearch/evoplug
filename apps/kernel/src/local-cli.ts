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

import { existsSync, readFileSync } from "node:fs";
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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type ErrorEnvelope, type FailureStatus, type Hash, type JsonValue, type Result } from "@evoplug/core";
import { canonicalHash, canonicalJsonText, err, hashBytes, isHash, makeErrorEnvelope, newId, ok, systemClock, toJsonValue } from "@evoplug/core";
import type { HostInstallApprovalPort, HostMode } from "@evoplug/core/host";
import { createOriginProofPort } from "@evoplug/core/host";
import {
  createGrant,
  grantIssueSubjectHash,
  grantRevokeSubjectHash,
  revokeGrant,
  toGrantPublicView,
  validateGrantIssueRequest
} from "@evoplug/kernel";
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
  createWriteApplyHandler,
  approveHostRoots,
  candidateRoot,
  createManagedRootResolver,
  ensureConfirmationRow,
  markAdopted,
  performAdoption,
  toHumanAttestationKind,
  readCandidate,
  candidateSkillName,
  candidateFullText,
  listPendingCandidateInfos,
  requeueCandidate,
  writePathOf,
  detachManagedBlock,
  registerManagedRoots,
  resolveManagedRootPath,
  revokeManagedRootsForHost,
  createDefaultEvidenceWriter,
  provisionJevBinding,
  createSqliteHomeDatabasePort,
  createSqliteStatusPort,
  buildSystemStatus,
  activateStandingEgressPolicy,
  resolveGenerationEgressPolicy,
  createTestModeMarker,
  detachHost,
  discoverMigrationsLocation,
  fieldError,
  findPlaintextSecret,
  homeLayout,
  hostManagedRoots,
  activeManagedDeclarations,
  initializeHome,
  internalError,
  kernelError,
  oldHomeError,
  parseConfigText,
  readConfigFile,
  readInitCompleteMarker,
  readTestModeMarker,
  revokeHostRuntimeSessions,
  testModeRequiresAllowEnv,
  writeFileAtomicDurable
} from "@evoplug/kernel";
import type {
  AuthorizationGrant,
  GrantIssueRequest,
  GrantRevokeRequest,
  EvoplugConfig,
  ReviewBackendPricing,
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
  activateConfigProfile as activateConfigProfileRecord,
  createSqliteDriver,
  createFndStateRowPort,
  createJournalCommitter,
  createTransactionRunner,
  exportHomeSnapshot,
  importHomeSnapshot,
  listJournalStates,
  openConfiguredConnection,
  readJournalFenceInDirectory,
  readSchemaMeta,
  snapshotHomeLayout
} from "@evoplug/storage";
import type { SqliteConnection } from "@evoplug/storage";
import type { SqlRow } from "@evoplug/storage";
import { IpcClient } from "@evoplug/ipc";
import { runServe } from "./main.js";
import { attachDefaults, createHostAdapterRegistry, createPackagedGenerationRegistry, createProbeBindingDeclarationPort } from "./host-registry.js";
import { HOST_COMPATIBILITY, isVersionInRange, readHostVersion } from "./host-version.js";
import {
  clearHostEnvironment,
  loadHostEnvironment,
  persistHostEnvironment,
  snapshotHostEnvironment,
  withCredentialEnv
} from "./host-environment.js";
import { resolveGenerationExecutable } from "./review-generation.js";
import { attachedHosts, runGenerationProbe } from "./generation-probe.js";
import { buildJevInputWithProbe, parseLimitsOptions, validateCredentialEnv } from "./configure-input.js";
import {
  mirrorOpenCodePluginDir,
  removeOpenCodePluginMirror,
  shouldMirrorOpenCodePluginDir
} from "./opencode-mirror.js";
import { installOpenCodeTuiPlugin, removeOpenCodeTuiPlugin } from "./opencode-tui.js";


import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}


/** `E_AUTH_DENIED` is a taxonomy root, not a kernel BY_CODE entry. */
function authDenied(rule: string, detailsPath = "authorization"): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_AUTH_DENIED",
    category: "authorization",
    message_key: "error.auth.denied",
    stage: "authorization",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path: detailsPath, rule }
  });
}

export const LOCAL_CLI_REQUEST_SCHEMA: "rsi.local_cli_request/1" = "rsi.local_cli_request/1";
export const LOCAL_CLI_RESULT_SCHEMA: "rsi.local_cli_result/1" = "rsi.local_cli_result/1";
export const PRODUCT_VERSION = "0.1.0-alpha.1";

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

type LocalCliOutcome =
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
void unsupported;

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
      remaining_ms: 30_000,
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
  readonly blobs: ReturnType<typeof BlobStore.open>;
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

/** Unknown adopted-experience id: a named not-found, never an internal crash. */
function writeNotFound(stage: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_WRITE_NOT_FOUND",
    category: "not_found",
    message_key: "error.e_write_not_found",
    stage,
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path: "write", rule: "id_not_found" }
  });
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
  const blobs = BlobStore.open(homeLayout(home).blobs_dir);
  const services = createReviewService({
    connection: opened.value,
    config: config.value,
    home,
    blob_store: blobs,
    now: () => Date.now()
  });
  return { ok: true, status: "ok", value: { services, connection: opened.value, blobs } };
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

async function runSkillsPending(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const runtime = await openReviewRuntime(request.home, false);
  if (!runtime.ok) {
    return failure(runtime.status, runtime.error, ioExit(runtime.status, runtime.error));
  }
  try {
    const config = await readConfigFile(request.home);
    const ttl = config.ok && config.value.candidate !== undefined
      ? config.value.candidate.pending_ttl_ms
      : 14 * 24 * 60 * 60 * 1_000;
    const rows = listPendingCandidateInfos(runtime.value.connection, Date.now(), ttl);
    return success({
      status: "ok",
      count: rows.length,
      candidates: rows.map((row) => ({
        id: row.candidate_id,
        name: row.name,
        description: row.description,
        created_at: row.created_at,
        state: row.state
      }))
    });
  } finally {
    runtime.value.connection.close();
  }
}

async function runSkillsShow(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const id = request.positionals[0];
  if (id === undefined || id.length === 0) {
    return missingOption("id");
  }
  const runtime = await openReviewRuntime(request.home, false);
  if (!runtime.ok) {
    return failure(runtime.status, runtime.error, ioExit(runtime.status, runtime.error));
  }
  try {
    const candidate = readCandidate(runtime.value.connection, id);
    if (candidate === null) {
      return failure("rejected", fieldError("id", "not_found"), EXIT_USAGE);
    }
    const content = candidateFullText(runtime.value.blobs, runtime.value.connection, candidate);
    return success({
      status: "ok",
      id: candidate.candidate_id,
      name: candidateSkillName(candidate),
      description: candidate.skill_description ?? "",
      change_kind: candidate.change_kind,
      target_path: candidate.target_path,
      content
    });
  } finally {
    runtime.value.connection.close();
  }
}

async function runSkillsAsk(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const id = request.positionals[0];
  if (id === undefined || id.length === 0) {
    return missingOption("id");
  }
  const runtime = await openReviewRuntime(request.home, true);
  if (!runtime.ok) {
    return failure(runtime.status, runtime.error, ioExit(runtime.status, runtime.error));
  }
  try {
    const requeued = requeueCandidate(runtime.value.connection, id, Date.now());
    if (!requeued) {
      return failure("rejected", fieldError("id", "not_pending"), EXIT_USAGE);
    }
    return success({ status: "ok", id, scheduled: "next_session_start" });
  } finally {
    runtime.value.connection.close();
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
/* Candidate confirmation, adoption and grants (local writer)         */
/* ------------------------------------------------------------------ */

async function readJsonOption(path: string): Promise<Result<unknown, ErrorEnvelope>> {
  try {
    return ok(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return err(fieldError(path, "invalid_json"));
  }
}


export async function runTestConfirm(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const candidateId = request.positionals[0];
  if (candidateId === undefined || candidateId.length === 0) return missingOption("candidate_id");
  const marker = await readTestModeMarker(request.home);
  if (!marker.ok) return failure(marker.status, marker.error, ioExit(marker.status, marker.error));
  if (marker.value === null) {
    return failure(
      "rejected",
      authDenied("not_a_test_mode_home", "--test-mode"),
      EXIT_CONFLICT
    );
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
  const journal = openLocalJournalWriter({ connection: opened.value, journal_dir: layout.journal_dir });
  if (!journal.ok) {
    opened.value.close();
    await lock.value.release();
    return failure(journal.status, journal.error, ioExit(journal.status, journal.error));
  }
  try {
    const candidate = readCandidate(opened.value, candidateId);
    if (candidate === null) {
      return failure(
        "rejected",
        writeNotFound("skills_confirm"),
        EXIT_FAILED
      );
    }
    const root = candidateRoot(opened.value, candidate);
    if (!root.ok) return failure(root.status, root.error, exitCodeForFailure(root.status, root.error));
    const confirmation = ensureConfirmationRow(opened.value, candidate, root.value, Date.now());
    if (!confirmation.ok) {
      return failure(confirmation.status, confirmation.error, exitCodeForFailure(confirmation.status, confirmation.error));
    }
    const now = Date.now();
    const capabilityId = newId("cap");
    const evidence = {
      schema_version: "rsi.human_proof_evidence/1",
      capability_id: capabilityId,
      proof_kind: "test_backdoor_confirmation",
      subject: {
        kind: "control_plane",
        purpose: "grant_issue",
        subject_hash: confirmation.value.subject_hash
      },
      confirmed_at: now,
      nonce: newId("ipc", now)
    };
    const stored = await blobs.putSync(new TextEncoder().encode(canonicalJsonText(evidence as unknown as JsonValue)));
    if (!stored.ok) return failure(stored.status, stored.error, ioExit(stored.status, stored.error));
    try {
      opened.value
        .prepare(
          `INSERT INTO blob (
             blob_hash, byte_length, relative_path, state, verified_at,
             created_at, deleted_at, deletion_reason
           ) VALUES (
             :blob_hash, :byte_length, :relative_path, 'present', :now,
             :now, NULL, NULL
           )
           ON CONFLICT(blob_hash) DO UPDATE SET
             byte_length = excluded.byte_length,
             relative_path = excluded.relative_path,
             state = 'present',
             verified_at = excluded.verified_at,
             deleted_at = NULL,
             deletion_reason = NULL`
        )
        .run({
          blob_hash: stored.value.hash,
          byte_length: stored.value.byte_length,
          relative_path: `sha256/${stored.value.hash.replace(/^sha256:/u, "")}`,
          now
        });
    } catch {
      return failure("rejected", internalError("kernel.test_confirm_blob_projection_failed"), EXIT_FAILED);
    }
    const proof = {
      kind: "test_backdoor_confirmation" as const,
      capability_id: capabilityId,
      evidence_ref: `blob://${stored.value.hash}#bytes=0-${stored.value.byte_length}` as never,
      confirmed_at: now
    };
    const proofPort = createOriginProofPort({
      withTx: createTransactionRunner(opened.value).withTx,
      clock: systemClock,
      sourceRefs: createSourceRefPort({ connection: opened.value, blob_store: blobs }),
      test_mode: true
    });
    const committer = createJournalCommitter({
      writer: journal.value.writer,
      connection: opened.value,
      relative_path: journal.value.relative_path,
      now: () => Date.now()
    });
    const handler = createWriteApplyHandler({
      connection: opened.value,
      blob_store: blobs,
      now: () => Date.now(),
      home: request.home,
      layout,
      root_resolver: createManagedRootResolver(opened.value),
      journal: committer
    });
    const adopted = await performAdoption({
      connection: opened.value,
      home: request.home,
      blob_store: blobs,
      candidate_id: candidateId,
      proof,
      verify_proof: async (attestation, subjectHash) => {
        const verdict = await proofPort.verifyControlPlane({
          attestation: {
            schema_version: "rsi.human_attestation/1",
            kind: toHumanAttestationKind(attestation.kind),
            capability_id: attestation.capability_id as never,
            evidence_ref: attestation.evidence_ref as never,
            confirmed_at: attestation.confirmed_at
          },
          subject_hash: subjectHash,
          purpose: "grant_issue"
        });
        return verdict;
      },
      write_apply: (params, signal) =>
        handler({
          request_id: newId("ipc", Date.now()),
          method: "write.apply",
          params: params as never,
          client_id: newId("adp"),
          client_kind: "cli",
          connection_id: "local-cli",
          remaining_ms: 30_000,
          signal
        }).then((result) => result.ok ? ok(toJsonValue(result.value)) : result),
      policy_version: "policy:evoplug/1",
      now: () => Date.now()
    });
    if (!adopted.ok) {
      return failure(adopted.status, adopted.error, ioExit(adopted.status, adopted.error));
    }
    return success(toJsonValue({ ...adopted.value, attestation: "test_backdoor" }));
  } finally {
    journal.value.writer.close();
    opened.value.close();
    await lock.value.release();
  }
}

export async function runSkillsAdopt(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const id = request.positionals[0];
  if (id === undefined || id.length === 0) return missingOption("id");
  const requestPath = stringOption(request, "request");
  if (requestPath === null) return missingOption("request");
  const parsed = await readJsonOption(requestPath);
  if (!parsed.ok) return failure(parsed.status, parsed.error, EXIT_USAGE);
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  const opened = openHomeDatabase(request.home);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  const layout = homeLayout(request.home);
  const journal = openLocalJournalWriter({ connection: opened.value, journal_dir: layout.journal_dir });
  if (!journal.ok) {
    opened.value.close();
    await lock.value.release();
    return failure(journal.status, journal.error, ioExit(journal.status, journal.error));
  }
  try {
    const committer = createJournalCommitter({
      writer: journal.value.writer,
      connection: opened.value,
      relative_path: journal.value.relative_path,
      now: () => Date.now()
    });
    const handler = createWriteApplyHandler({
      connection: opened.value,
      blob_store: BlobStore.open(layout.blobs_dir),
      now: () => Date.now(),
      home: request.home,
      layout,
      root_resolver: createManagedRootResolver(opened.value),
      journal: committer
    });
    const outcome = await handler({
      request_id: newId("ipc", Date.now()),
      method: "write.apply",
      params: parsed.value as never,
      client_id: "adp:local-cli" as never,
      client_kind: "cli",
      connection_id: "local-cli",
      remaining_ms: 30_000,
      signal: new AbortController().signal
    });
    if (!outcome.ok) {
      return failure(outcome.status, outcome.error, exitCodeForFailure(outcome.status, outcome.error));
    }
    const candidate = readCandidate(opened.value, id);
    if (candidate !== null) {
      const root = candidateRoot(opened.value, candidate);
      if (root.ok) {
        const confirmation = ensureConfirmationRow(opened.value, candidate, root.value, Date.now());
        if (confirmation.ok) {
          const record = outcome.value as unknown as Record<string, JsonValue>;
          markAdopted(
            opened.value,
            confirmation.value,
            "host_native_confirmation",
            String(record["write_id"] ?? ""),
            Date.now()
          );
          approveHostRoots(opened.value, candidate.host_id, Date.now());
        }
      }
    }
    return success(toJsonValue({ ...outcome.value, via: "local" }));
  } finally {
    journal.value.writer.close();
    opened.value.close();
    await lock.value.release();
  }
}

export async function runSkillsDisable(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const id = request.positionals[0];
  if (id === undefined || id.length === 0) return missingOption("id");
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  const opened = openHomeDatabase(request.home);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  try {
    const candidate = readCandidate(opened.value, id);
    if (candidate === null) {
      return failure("rejected", writeNotFound("skills_write"), EXIT_FAILED);
    }
    const root = candidateRoot(opened.value, candidate);
    if (!root.ok) return failure(root.status, root.error, exitCodeForFailure(root.status, root.error));
    let rootPath: string;
    try {
      rootPath = resolveManagedRootPath(root.value);
    } catch {
      return failure("rejected", kernelError("E_ROOT_UNAVAILABLE"), EXIT_FAILED);
    }
    const target = join(rootPath, writePathOf(candidate));
    let movedTo: string | null = null;
    if (candidate.write_mode === "managed_block") {
      // Appendix K.1: detach only the managed block; user text is preserved.
      try {
        const bytes = readFileSync(target);
        const detached = detachManagedBlock(bytes, candidate.block_selector ?? "evoplug");
        if (!detached.ok) return failure(detached.status, detached.error, exitCodeForFailure(detached.status, detached.error));
        const written = await writeFileAtomicDurable(target, new TextDecoder().decode(detached.value));
        if (!written.ok) return failure(written.status, written.error, ioExit(written.status, written.error));
      } catch (error) {
        return failure("rejected", internalError("kernel.disable_block_failed"), EXIT_FAILED, String(error));
      }
    } else {
      try {
        const disabledDir = join(rootPath, ".evoplug-disabled");
        await mkdir(disabledDir, { recursive: true });
        const destination = join(disabledDir, `${candidate.proposal_id.replace(/[^A-Za-z0-9._-]/gu, "_")}.disabled`);
        await rename(target, destination);
        movedTo = destination;
      } catch {
        // A missing file is already not loadable; keep the projection update.
      }
    }
    opened.value
      .prepare(
        "UPDATE proposals SET state = 'withdrawn', updated_at = :now WHERE proposal_id = :id AND state = 'adopted'"
      )
      .run({ id: candidate.proposal_id, now: Date.now() });
    opened.value
      .prepare(
        "UPDATE candidate_confirmation SET state = 'rejected', updated_at = :now WHERE candidate_id = :id"
      )
      .run({ id: candidate.candidate_id, now: Date.now() });
    return success(toJsonValue({ status: "disabled", id: candidate.candidate_id, moved_to: movedTo }));
  } finally {
    opened.value.close();
    await lock.value.release();
  }
}

export async function runGrantIssue(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const requestPath = stringOption(request, "request");
  const attestationPath = stringOption(request, "attestation");
  if (requestPath === null) return missingOption("request");
  if (attestationPath === null) return missingOption("attestation");
  const requestJson = await readJsonOption(requestPath);
  if (!requestJson.ok) return failure(requestJson.status, requestJson.error, EXIT_USAGE);
  const attestationJson = await readJsonOption(attestationPath);
  if (!attestationJson.ok) return failure(attestationJson.status, attestationJson.error, EXIT_USAGE);
  if (!isRecord(requestJson.value)) {
    return failure("rejected", fieldError(requestPath, "grant_issue_shape"), EXIT_USAGE);
  }
  const grantRequest = {
    ...requestJson.value,
    human_attestation: attestationJson.value
  } as unknown as GrantIssueRequest;
  const validated = validateGrantIssueRequest(grantRequest);
  if (!validated.ok) return failure(validated.status, validated.error, EXIT_USAGE);
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  const opened = openHomeDatabase(request.home);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  try {
    const testMode = await readTestModeMarker(request.home);
    const proof = createOriginProofPort({
      withTx: createTransactionRunner(opened.value).withTx,
      clock: systemClock,
      sourceRefs: createSourceRefPort({
        connection: opened.value,
        blob_store: BlobStore.open(homeLayout(request.home).blobs_dir)
      }),
      test_mode: testMode.ok && testMode.value !== null
    });
    const subjectHash = grantIssueSubjectHash(grantRequest);
    const verdict = await proof.verifyControlPlane({
      attestation: grantRequest.human_attestation as never,
      subject_hash: subjectHash,
      purpose: "grant_issue"
    });
    if (verdict !== "verified") {
      return failure("rejected", authDenied("denied"), EXIT_CONFLICT);
    }
    const now = Date.now();
    const created = createGrant({
      request: grantRequest,
      grant_id: newId("grant", now),
      issued_at: now
    });
    if (!created.ok) return failure(created.status, created.error, ioExit(created.status, created.error));
    const grant = created.value.grant;
    opened.value
      .prepare(
        `INSERT INTO authorization_grant (
           grant_id, issued_by, human_attestation_json, subject, object_type, scope_json,
           actions_json, mode, candidate_id, candidate_hash, policy_version, issued_at,
           expires_at, revoked_at, grant_hash
         ) VALUES (
           :grant_id, :issued_by, :human_attestation_json, :subject, :object_type, :scope_json,
           :actions_json, :mode, :candidate_id, :candidate_hash, :policy_version, :issued_at,
           :expires_at, NULL, :grant_hash
         )`
      )
      .run({
        grant_id: grant.grant_id,
        issued_by: grant.issued_by,
        human_attestation_json: canonicalJsonText(toJsonValue(grant.human_attestation)),
        subject: grant.subject,
        object_type: grant.object_type,
        scope_json: canonicalJsonText(toJsonValue(grant.scope)),
        actions_json: canonicalJsonText(toJsonValue(grant.actions)),
        mode: grant.mode,
        candidate_id: grant.candidate_id,
        candidate_hash: grant.candidate_hash,
        policy_version: grant.policy_version,
        issued_at: grant.issued_at,
        expires_at: grant.expires_at,
        grant_hash: grant.grant_hash
      });
    return success(toJsonValue({ grant: toGrantPublicView(grant), via: "local" }));
  } finally {
    opened.value.close();
    await lock.value.release();
  }
}

export async function runGrantRevoke(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const grantId = request.positionals[0];
  const expectedHash = stringOption(request, "expected-hash");
  const reason = stringOption(request, "reason");
  const attestationPath = stringOption(request, "attestation");
  if (grantId === undefined || grantId.length === 0) return missingOption("grant_id");
  if (expectedHash === null) return missingOption("expected-hash");
  if (reason === null) return missingOption("reason");
  if (attestationPath === null) return missingOption("attestation");
  const attestation = await readJsonOption(attestationPath);
  if (!attestation.ok) return failure(attestation.status, attestation.error, EXIT_USAGE);
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  const opened = openHomeDatabase(request.home);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  try {
    const revokeRequest = {
      schema_version: "rsi.grant_revoke/1",
      grant_id: grantId,
      expected_grant_hash: expectedHash,
      human_attestation: attestation.value,
      reason
    } as unknown as GrantRevokeRequest;
    const testMode = await readTestModeMarker(request.home);
    const proof = createOriginProofPort({
      withTx: createTransactionRunner(opened.value).withTx,
      clock: systemClock,
      sourceRefs: createSourceRefPort({
        connection: opened.value,
        blob_store: BlobStore.open(homeLayout(request.home).blobs_dir)
      }),
      test_mode: testMode.ok && testMode.value !== null
    });
    const verdict = await proof.verifyControlPlane({
      attestation: revokeRequest.human_attestation as never,
      subject_hash: grantRevokeSubjectHash(revokeRequest),
      purpose: "grant_revoke"
    });
    if (verdict !== "verified") {
      return failure("rejected", authDenied("denied"), EXIT_CONFLICT);
    }
    const row = opened.value
      .prepare<SqlRow>("SELECT * FROM authorization_grant WHERE grant_id = :grant_id")
      .get({ grant_id: grantId });
    if (row === undefined) {
      return failure("rejected", writeNotFound("skills_write"), EXIT_FAILED);
    }
    const existing = rowToGrant(row);
    if (existing === null) {
      return failure("rejected", kernelError("E_INTERNAL"), EXIT_FAILED);
    }
    const revoked = revokeGrant({ grant: existing, request: revokeRequest, revoked_at: Date.now() });
    if (!revoked.ok) return failure(revoked.status, revoked.error, EXIT_CONFLICT);
    opened.value
      .prepare("UPDATE authorization_grant SET revoked_at = :revoked_at WHERE grant_id = :grant_id")
      .run({ revoked_at: revoked.value.revoked_at, grant_id: revoked.value.grant_id });
    return success(toJsonValue({ grant: toGrantPublicView(revoked.value), via: "local" }));
  } finally {
    opened.value.close();
    await lock.value.release();
  }
}

export async function runGrantList(request: LocalCliRequest): Promise<LocalCliOutcome> {  const opened = openHomeDatabase(request.home);
  if (!opened.ok) return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  try {
    const objectType = stringOption(request, "object-type");
    const state = stringOption(request, "state");
    const limit = stringOption(request, "limit");
    const rows = opened.value
      .prepare<SqlRow>("SELECT * FROM authorization_grant ORDER BY issued_at DESC LIMIT :limit")
      .all({ limit: limit === null ? 100 : Number(limit) });
    const grants = rows
      .map((row) => {
        const parsed = rowToGrant(row);
        return parsed === null ? null : toGrantPublicView(parsed);
      })
      .filter((grant): grant is NonNullable<typeof grant> => grant !== null)
      .filter((grant) => objectType === null || grant.object_type === objectType)
      .filter((grant) => {
        if (state === null) return true;
        if (state === "revoked") return grant.revoked_at !== null;
        if (state === "expired") return grant.expires_at !== null && grant.expires_at <= Date.now();
        if (state === "active") return grant.revoked_at === null && (grant.expires_at === null || grant.expires_at > Date.now());
        return true;
      });
    return success(toJsonValue({ grants, via: "local" }));
  } finally {
    opened.value.close();
  }
}

function rowToGrant(row: SqlRow): AuthorizationGrant | null {
  try {
    return {
      schema_version: "rsi.authorization_grant/1",
      grant_id: String(row["grant_id"]) as never,
      issued_by: row["issued_by"] as never,
      human_attestation: JSON.parse(String(row["human_attestation_json"])) as never,
      subject: String(row["subject"]) as never,
      object_type: row["object_type"] as never,
      scope: JSON.parse(String(row["scope_json"])) as never,
      actions: JSON.parse(String(row["actions_json"])) as never,
      mode: row["mode"] as never,
      candidate_id: row["candidate_id"] === null ? null : (String(row["candidate_id"]) as never),
      candidate_hash: row["candidate_hash"] === null ? null : (String(row["candidate_hash"]) as never),
      policy_version: String(row["policy_version"]),
      issued_at: Number(row["issued_at"]),
      expires_at: row["expires_at"] === null ? null : Number(row["expires_at"]),
      revoked_at: row["revoked_at"] === null ? null : Number(row["revoked_at"]),
      grant_hash: String(row["grant_hash"]) as never
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* init                                                               */
/* ------------------------------------------------------------------ */

export async function runInit(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const testMode = flagOption(request, "test-mode");
  if (testMode) {
    const existingTestMode = await readTestModeMarker(request.home);
    if (!existingTestMode.ok) {
      return failure(existingTestMode.status, existingTestMode.error, ioExit(existingTestMode.status, existingTestMode.error));
    }
    if (existingTestMode.value === null) {
      const marker = await readInitCompleteMarker(request.home);
      if (!marker.ok) {
        return failure(marker.status, marker.error, ioExit(marker.status, marker.error));
      }
      if (marker.value !== null) {
        return failure(
          "rejected",
          authDenied("existing_home_is_not_test_mode", "--test-mode"),
          EXIT_CONFLICT
        );
      }
      if (testModeRequiresAllowEnv(import.meta.dirname) && process.env["EVOPLUG_ALLOW_TEST_MODE"] !== "1") {
        return failure(
          "rejected",
          authDenied("EVOPLUG_ALLOW_TEST_MODE_required", "--test-mode"),
          EXIT_CONFLICT
        );
      }
    }
  }
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
  if (marker.value !== null && marker.value.schema_major < SCHEMA_MAJOR) {
    return failure(
      "rejected",
      oldHomeError(String(SCHEMA_MAJOR), String(marker.value.schema_major)),
      EXIT_UNAVAILABLE
    );
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
  if (testMode) {
    const created = await createTestModeMarker(request.home, Date.now());
    if (!created.ok) {
      return failure(created.status, created.error, ioExit(created.status, created.error));
    }
  }
  return success({
    status: initialized.value.status,
    config_version: initialized.value.config_version,
    config_hash: initialized.value.config_hash,
    schema_major: initialized.value.marker.schema_major,
    ...(testMode ? { test_mode: true } : {})
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
    activateConfigProfileRecord(tx, {
      config_space: config.config_space,
      config_version: configVersion,
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
  return runJevProvisionInput(request, parsed, inputPath);
}

/** Persists a Jev profile/capability pair; the shape is checked here, not trusted. */
async function runJevProvisionInput(
  request: LocalCliRequest,
  parsed: unknown,
  sourceLabel: string,
  extra: { readonly evidence_bytes?: Uint8Array | null; readonly warnings?: readonly string[] } = {}
): Promise<LocalCliOutcome> {
  if (!isRecord(parsed) || !isRecord(parsed["profile"]) || !isRecord(parsed["capability"])) {
    return failure("rejected", fieldError(sourceLabel, "jev_provision_schema"), EXIT_USAGE);
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
    return failure("rejected", fieldError(sourceLabel, "invalid_expected_version"), EXIT_USAGE);
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
  if (extra.evidence_bytes !== null && extra.evidence_bytes !== undefined) {
    const stored = blobs.putSync(extra.evidence_bytes);
    if (!stored.ok) {
      opened.value.close();
      await lock.value.release();
      return failure(stored.status, stored.error, ioExit(stored.status, stored.error));
    }
    // The evidence must be resolvable through SourceRefPort, which requires a
    // `blob` projection row, not only the CAS file.
    opened.value
      .prepare(
        `INSERT INTO blob (
           blob_hash, byte_length, relative_path, state, verified_at, created_at,
           deleted_at, deletion_reason
         ) VALUES (
           :blob_hash, :byte_length, :relative_path, 'present', :now, :now, NULL, NULL
         )
         ON CONFLICT(blob_hash) DO UPDATE SET
           state = 'present',
           verified_at = excluded.verified_at,
           deleted_at = NULL,
           deletion_reason = NULL`
      )
      .run({
        blob_hash: stored.value.hash,
        byte_length: stored.value.byte_length,
        relative_path: stored.value.relative_path,
        now: Date.now()
      });
  }
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
        expected_capability_version: typeof expectedCapability === "number" ? expectedCapability : null,
        connection: opened.value
      });
    } catch {
      return failure("rejected", fieldError(sourceLabel, "jev_provision_schema"), EXIT_USAGE);
    }
    if (!provisioning.ok) {
      return failure(provisioning.status, provisioning.error, exitCodeForFailure(provisioning.status, provisioning.error));
    }
    return success({
      status: provisioning.commit_state === "existing" ? "existing" : "created",
      profile_key: provisioning.value.profile.profile_key,
      capability_key: provisioning.value.capability.capability_key,
      validator_binding_key: provisioning.value.validator.validator_binding_key,
      acceptance: provisioning.value.profile.acceptance.status,
      ...(provisioning.value.profile.acceptance.reasons.length === 0
        ? {}
        : { acceptance_reasons: provisioning.value.profile.acceptance.reasons }),
      ...(extra.warnings === undefined || extra.warnings.length === 0
        ? {}
        : { warnings: [...extra.warnings] })
    });
  } finally {
    journal.value.writer.close();
    opened.value.close();
    await lock.value.release();
  }
}

/* ------------------------------------------------------------------ */
/* G9 user-facing configure commands                                  */
/* ------------------------------------------------------------------ */

async function runConfigureJev(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const credentialEnv = validateCredentialEnv(stringOption(request, "credential-env"));
  if (!credentialEnv.ok) {
    return failure(credentialEnv.status, credentialEnv.error, EXIT_USAGE);
  }
  const limits = parseLimitsOptions(
    stringOption(request, "request-max-tokens"),
    stringOption(request, "question-max-tokens")
  );
  if (!limits.ok) {
    return failure(limits.status, limits.error, EXIT_USAGE);
  }
  const credential = process.env[credentialEnv.value];
  const input = await buildJevInputWithProbe({
    endpoint: stringOption(request, "endpoint"),
    model: stringOption(request, "model"),
    credentialEnv: credentialEnv.value,
    limits: limits.value,
    skip_probe: flagOption(request, "skip-probe"),
    ...(credential === undefined ? {} : { credential })
  });
  if (!input.ok) {
    return failure(input.status, input.error, EXIT_USAGE);
  }
  return runJevProvisionInput(
    request,
    { profile: input.value.profile, capability: input.value.capability },
    "configure jev",
    {
      evidence_bytes: input.value.evidence_bytes,
      warnings: input.value.warnings
    }
  );
}

function parseGenerationPricing(
  request: LocalCliRequest
): Result<ReviewBackendPricing | null, ErrorEnvelope> {
  const free = flagOption(request, "pricing-free");
  const file = stringOption(request, "pricing-file");
  if (free && file !== null) {
    return { ok: false, status: "rejected", error: fieldError("--pricing", "choose_one_source") };
  }
  if (free) {
    return {
      ok: true,
      status: "ok",
      value: {
        status: "known",
        input_micros_per_million: 0,
        output_micros_per_million: 0,
        fixed_micros: 0
      }
    };
  }
  if (file === null) {
    return { ok: true, status: "ok", value: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return { ok: false, status: "rejected", error: fieldError("--pricing-file", "unreadable_json") };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: "rejected", error: fieldError("--pricing-file", "must_be_object") };
  }
  const input = parsed["input_micros_per_million"];
  const output = parsed["output_micros_per_million"];
  const fixed = parsed["fixed_micros"];
  if (
    !Number.isSafeInteger(input) || Number(input) < 0 ||
    !Number.isSafeInteger(output) || Number(output) < 0 ||
    !Number.isSafeInteger(fixed) || Number(fixed) < 0
  ) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError("--pricing-file", "non_negative_safe_integer")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      status: "known",
      input_micros_per_million: Number(input),
      output_micros_per_million: Number(output),
      fixed_micros: Number(fixed)
    }
  };
}

async function runConfigureGeneration(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const host = stringOption(request, "host");
  if (host === null || host.length === 0) {
    return missingOption("host");
  }
  if (attachDefaults(host) === null) {
    return failure(
      "rejected",
      fieldError("--host", "unknown_host"),
      EXIT_USAGE
    );
  }
  const credentialEnv = validateCredentialEnv(stringOption(request, "credential-env"));
  if (!credentialEnv.ok) {
    return failure(credentialEnv.status, credentialEnv.error, EXIT_USAGE);
  }
  const pricing = parseGenerationPricing(request);
  if (!pricing.ok) {
    return failure("rejected", pricing.error, EXIT_USAGE);
  }
  const layout = homeLayout(request.home);
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
  const current = await readConfigFile(request.home);
  if (!current.ok) {
    return failure(current.status, current.error, ioExit(current.status, current.error));
  }
  const model = stringOption(request, "model");
  const policy = resolveGenerationEgressPolicy({
    host_id: host,
    model,
    provider_endpoint: stringOption(request, "provider-endpoint"),
    project_exclusions: current.value.projects.excluded_project_ids,
    env: process.env,
    read_file: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    }
  });
  if (!policy.ok) {
    return failure(policy.status, policy.error, EXIT_USAGE);
  }
  const nextPricing =
    pricing.value ??
    (current.value.review_backend.enabled ? current.value.review_backend.pricing : undefined);
  const next = parseConfigText(canonicalConfigJson({
    ...current.value,
    egress_policy_version: policy.value.policy.policy_version,
    review_backend: {
      enabled: true,
      backend_id: host,
      secret_ref: `env:${credentialEnv.value}`,
      ...(model === null ? {} : { model }),
      ...(nextPricing === undefined ? {} : { pricing: nextPricing })
    }
  }));
  if (!next.ok) {
    return failure(next.status, next.error, exitCodeForFailure(next.status, next.error));
  }
  const committed = await commitConfigWrite(request, current.value, next.value, layout, marker.value);
  if (committed.status !== "ok") return committed;
  try {
    const opened = openHomeDatabase(request.home);
    if (!opened.ok) return failure(opened.status, opened.error, EXIT_DEGRADED);
    try {
      const activated = activateStandingEgressPolicy(opened.value, policy.value, Date.now());
      if (!activated.ok) {
        return failure(activated.status, activated.error, EXIT_DEGRADED);
      }
    } finally {
      opened.value.close();
    }
  } catch {
    return failure("rejected", internalError("kernel.configure_egress_policy_failed"), EXIT_DEGRADED);
  }
  // Product behaviour: `configure generation` may run after attach. The
  // attach probe wrote the service profile, so refresh it here with the new
  // credential/model/pricing; otherwise the first review sees the old profile
  // and fails closed with `E_BUDGET pricing_unknown`.
  let refreshedProbe: JsonValue | null = null;
  try {
    const opened = openHomeDatabase(request.home);
    if (opened.ok) {
      try {
        const registration = opened.value
          .prepare<{ mode: string; config_space: string }>(
            `SELECT mode, config_space FROM adapter_registration
              WHERE host_id = :host ORDER BY updated_at DESC LIMIT 1`
          )
          .get({ host });
        if (registration !== undefined) {
          refreshedProbe = await probeGenerationAfterAttach({
            connection: opened.value,
            blobs: BlobStore.open(homeLayout(request.home).blobs_dir),
            home: request.home,
            host_id: host,
            mode: String(registration.mode),
            config_space: String(registration.config_space),
            host_env: loadHostEnvironment(request.home, host) ?? {},
            ...(credentialEnv.value.length === 0 ? {} : { credential_env: credentialEnv.value }),
            ...(nextPricing === undefined ? {} : { pricing: nextPricing }),
            now: () => Date.now()
          });
        }
      } finally {
        opened.value.close();
      }
    }
  } catch {
    refreshedProbe = null;
  }
  const base = committed.value as Record<string, unknown>;
  return success({
    ...base,
    ...(refreshedProbe === null ? {} : { generation_probe: refreshedProbe }),
    // Appendix I.5: without --model the host CLI runs with the model the
    // current host session already uses; the backend passes no model argv.
    generation_model: model ?? "host_default",
    generation_model_source: model === null ? "host_session_default" : "explicit",
    egress_policy: {
      policy_version: policy.value.policy.policy_version,
      receiver: policy.value.receiver,
      data_classes: policy.value.policy.endpoints[0]?.data_classes ?? []
    },
    ...(nextPricing === undefined ? {} : { pricing: nextPricing }),
    notice:
      "复盘时会把本宿主会话的证据交给本宿主 CLI 生成候选；接收方限定为本宿主 CLI 与其已配置的 provider，证据中的项目排除项与凭据形态文本不会进入快照。跨源路由（其他宿主或其他 provider）不在本版支持范围内。"
  } as unknown as JsonValue);
}

async function runConfigureShow(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const ready = await readInitCompleteMarker(request.home);
  if (!ready.ok) return failure(ready.status, ready.error, ioExit(ready.status, ready.error));
  if (ready.value === null) {
    return failure(
      "rejected",
      kernelError("E_HOME_INCOMPATIBLE", {
        details: { kind: "version", expected: "initialized_home", actual: "missing_init_complete" }
      }),
      EXIT_UNAVAILABLE
    );
  }
  try {
    return success(JSON.parse(await readFile(homeLayout(request.home).config_path, "utf8")) as JsonValue);
  } catch {
    return failure("rejected", kernelError("E_IO"), EXIT_DEGRADED);
  }
}

/* ------------------------------------------------------------------ */
/* status (local read-only fallback, G2)                              */
/* ------------------------------------------------------------------ */

async function runStatusLocal(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const config = await readConfigFile(request.home);
  if (!config.ok) {
    return failure(config.status, config.error, ioExit(config.status, config.error));
  }
  const opened = openConfiguredConnection(createSqliteDriver(), homeLayout(request.home).db_path, {
    readOnly: true
  });
  if (!opened.ok) {
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  try {
    const port = createSqliteStatusPort({
      connection: opened.value.connection,
      config: config.value,
      journal_dir: homeLayout(request.home).journal_dir,
      runtime: { status: "degraded_read_only", recovery_state: "complete" }
    });
    const axes = await port.readStatus(request.options["include"] === "all"
      ? ["storage", "ipc", "budget", "outbox", "config", "capabilities", "recovery"]
      : ["storage", "ipc", "budget", "outbox", "config", "capabilities", "recovery"]);
    if (!axes.ok) {
      return failure(axes.status, axes.error, ioExit(axes.status, axes.error));
    }
    return success(toJsonValue(buildSystemStatus({
      axes: axes.value,
      ipc: { mode_verified: false, active_connections: 0 }
    })) as JsonValue);
  } finally {
    opened.value.connection.close();
  }
}

async function commitConfigWrite(
  request: LocalCliRequest,
  current: EvoplugConfig,
  next: EvoplugConfig,
  layout: ReturnType<typeof homeLayout>,
  markerValue: InitCompleteMarker
): Promise<LocalCliOutcome> {
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
          current,
          markerValue.config_version,
          computeConfigContentHash(current),
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
  return commitConfigWrite(request, current.value, next, layout, markerValue);
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

async function runExport(request: LocalCliRequest): Promise<LocalCliOutcome> {
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

async function runImport(request: LocalCliRequest): Promise<LocalCliOutcome> {
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

/** `env:NAME` secret refs name the variable the host CLI reads, never a value. */
function configuredCredentialEnv(config: EvoplugConfig | undefined): string | undefined {
  const backend = config?.review_backend;
  if (backend === undefined || !backend.enabled) return undefined;
  const ref = (backend as { readonly secret_ref?: string | null }).secret_ref;
  return typeof ref === "string" && ref.startsWith("env:") ? ref.slice("env:".length) : undefined;
}

async function probeGenerationAfterAttach(input: {
  readonly connection: SqliteConnection;
  readonly blobs: BlobStore;
  readonly home: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  /**
   * Attach-registered host environment (appendix J.5). The probe never falls
   * back to the kernel process environment.
   */
  readonly host_env: Readonly<Record<string, string>>;
  readonly credential_env?: string;
  readonly pricing?: {
    readonly status: "known";
    readonly input_micros_per_million: number;
    readonly output_micros_per_million: number;
    readonly fixed_micros: number;
  };
  readonly now: () => number;
}): Promise<JsonValue | null> {
  const registry = createPackagedGenerationRegistry();
  const entry = registry.list?.().find((candidate) => candidate.spec.host_id === input.host_id) ?? null;
  if (entry === null) return null;
  const probeEnv = withCredentialEnv(input.host_env, input.credential_env, process.env);
  const executable = resolveGenerationExecutable(entry.spec, undefined, probeEnv);
  if (executable === null) {
    return toJsonValue({ status: "blocked", reason: "generation_executable_not_found", backend_id: entry.spec.backend_id });
  }
  const detected = readHostVersion(input.host_id as never, probeEnv);
  if (detected.host_version === null) {
    return toJsonValue({ status: "blocked", reason: "host_version_unavailable", backend_id: entry.spec.backend_id });
  }
  const probed = await runGenerationProbe({
    home: input.home,
    connection: input.connection,
    blobs: input.blobs,
    spec: entry.spec,
    ...(entry.glue_path === undefined ? {} : { glue_path: entry.glue_path }),
    backend_id: entry.spec.backend_id,
    host_id: input.host_id,
    mode: input.mode,
    config_space: input.config_space,
    executable,
    host_version: detected.host_version,
    host_env: probeEnv,
    ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
    now: input.now
  });
  if (!probed.ok) {
    return toJsonValue({ status: "failed", reason: probed.error.code, backend_id: entry.spec.backend_id });
  }
  return toJsonValue({
    status: probed.value.verdict.output === "passed" ? "verified" : "failed",
    backend_id: entry.spec.backend_id,
    binding_key: probed.value.binding_key,
    create: probed.value.verdict.create,
    auth: probed.value.verdict.auth,
    output: probed.value.verdict.output,
    blocker: probed.value.verdict.blocker,
    failure: probed.value.verdict.failure,
    ...(probed.value.next_step === null ? {} : { next_step: probed.value.next_step })
  });
}

function doctorStorage(home: string): JsonValue {
  const fence = readJournalFenceInDirectory(homeLayout(home).journal_dir);
  return fence === null
    ? { journal: "ok" }
    : {
        journal: "recovery_required",
        fence: {
          frame_type: fence.frame_type,
          observed_at: fence.observed_at,
          hint: fence.hint
        }
      };
}

async function runDoctorGeneration(request: LocalCliRequest): Promise<LocalCliOutcome> {
  const lock = await acquireWriterLock({ home: request.home, boot_id: newId("ipc") });
  if (!lock.ok) return failure(lock.status, lock.error, exitCodeForFailure(lock.status, lock.error));
  const opened = openHomeDatabase(request.home);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.status, opened.error, ioExit(opened.status, opened.error));
  }
  try {
    const blobs = BlobStore.open(homeLayout(request.home).blobs_dir);
    const config = await readConfigFile(request.home);
    const pricing =
      config.ok && config.value.review_backend.enabled
        ? config.value.review_backend.pricing
        : undefined;
    const hosts = attachedHosts(opened.value);
    const results: JsonValue[] = [];
    for (const host of hosts) {
      const hostEnv = loadHostEnvironment(request.home, host.host_id);
      if (hostEnv === null) {
        results.push(toJsonValue({
          host_id: host.host_id,
          config_space: host.config_space,
          probe: { status: "blocked", reason: "host_env_unregistered" }
        }));
        continue;
      }
      const credentialEnv = configuredCredentialEnv(config.ok ? config.value : undefined);
      const probed = await probeGenerationAfterAttach({
        connection: opened.value,
        blobs,
        home: request.home,
        host_id: host.host_id,
        mode: host.mode,
        config_space: host.config_space,
        host_env: hostEnv,
        ...(credentialEnv === undefined ? {} : { credential_env: credentialEnv }),
        ...(pricing === undefined ? {} : { pricing }),
        now: () => Date.now()
      });
      results.push(toJsonValue({ host_id: host.host_id, config_space: host.config_space, probe: probed }));
    }
    return success(toJsonValue({
      schema_version: "rsi.cli_doctor/1",
      home: request.home,
      status: results.some((entry) => (entry as Record<string, unknown>)["probe"] !== null) ? "ok" : "warn",
      probe: "generation",
      storage: doctorStorage(request.home),
      hosts: results,
      via: "local"
    }));
  } finally {
    opened.value.close();
    await lock.value.release();
  }
}

/**
 * Appendix I.1. When `serve` is running, this process still owns the caller's
 * host environment: it resolves the artifact targets and managed-root absolute
 * paths, then hands that exact resolution to the kernel writer over IPC.
 * Returns null when no kernel endpoint is reachable, so the caller takes the
 * local writer lock instead.
 */
async function runHostAttachViaServe(input: {
  readonly request: LocalCliRequest;
  readonly host_id: string;
  readonly command: "attach" | "detach";
  readonly mode: HostMode;
  readonly config_space: string;
  readonly target_id: string | undefined;
  readonly artifact_dir: string | undefined;
}): Promise<LocalCliOutcome | null> {
  const endpointPath = join(input.request.home, "runtime", "endpoint.json");
  let client = await IpcClient.connect({
    evoplug_home: input.request.home,
    client_id: newId("adp"),
    client_kind: "cli",
    product_version: PRODUCT_VERSION,
    connect_timeout_ms: 1000
  });
  // A busy serve can miss one connect window. Retry while its endpoint is
  // present; falling back to the local writer lock while serve owns it would
  // fail and leave the caller's roots/snapshot half-switched.
  for (let attempt = 0; attempt < 10 && !client.ok && existsSync(endpointPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    client = await IpcClient.connect({
      evoplug_home: input.request.home,
      client_id: newId("adp"),
      client_kind: "cli",
      product_version: PRODUCT_VERSION,
      connect_timeout_ms: 1000
    });
  }
  if (!client.ok) {
    if (existsSync(endpointPath)) {
      return failure(
        "degraded",
        makeErrorEnvelope({
          code: "E_IO",
          category: "ipc",
          message_key: "error.e_io",
          stage: "host_attach_ipc",
          retryable: true,
          side_effect: "none",
          details: { kind: "none" }
        }),
        EXIT_UNAVAILABLE
      );
    }
    return null;
  }
  try {
    const defaults = attachDefaults(input.host_id);
    if (defaults === null) return null;
    const registry = createHostAdapterRegistry({
      ...(input.artifact_dir === undefined ? {} : { artifact_dir: input.artifact_dir }),
      host_env: process.env,
      ...(input.command === "detach" ? { resolve_installed_artifact: true } : {})
    });
    const resolved = await registry.resolve({
      host_id: defaults.host_id,
      mode: input.mode,
      config_space: input.config_space,
      ...(input.target_id === undefined ? {} : { target_id: input.target_id })
    });
    if (!resolved.ok) {
      return failure(resolved.status, resolved.error, exitCodeForFailure(resolved.status, resolved.error));
    }
    if (resolved.value === null) {
      return failure(
        "rejected",
        makeErrorEnvelope({
          code: "E_UNSUPPORTED",
          category: "policy",
          message_key: "error.e_unsupported",
          stage: "host_attach_registry",
          details: { kind: "field", path: "host", rule: input.host_id }
        }),
        EXIT_UNAVAILABLE
      );
    }
    const declaration = hostManagedRoots(defaults.host_id);
    const home = declaration === null ? null : declaration.host_home(process.env);
    if (declaration !== null && (home === null || !isAbsolute(home))) {
      return failure(
        "rejected",
        fieldError("host_env", "unresolved_host_home"),
        EXIT_USAGE
      );
    }
    // Appendix Q.1: the caller resolves the same declaration subset the
    // server registers, so a disabled memory/instructions root is never sent.
    const callerConfig = await readConfigFile(input.request.home);
    const managedBlocks = callerConfig.ok &&
      callerConfig.value.features?.includes("managed_blocks") === true;
    const roots = declaration === null || home === null
      ? []
      : activeManagedDeclarations(declaration, managedBlocks).map((root) => ({
          kind: root.kind,
          absolute_path: root.base === "project_root"
            ? join(process.cwd(), root.relative_path)
            : join(home, root.relative_path)
        }));
    const callerEnv = snapshotHostEnvironment(process.env);
    const detected = readHostVersion(defaults.host_id, callerEnv);
    const supportedRange = HOST_COMPATIBILITY[defaults.host_id].supported_range;
    const result = await client.value.request(
      "host.attach.execute",
      {
        command: input.command,
        host_id: defaults.host_id,
        mode: input.mode,
        config_space: input.config_space,
        ...(input.target_id === undefined ? {} : { target_id: input.target_id }),
        resolution: toJsonValue(resolved.value),
        host_version: detected.host_version,
        supported_range: supportedRange,
        version_supported:
          detected.host_version !== null &&
          isVersionInRange(detected.host_version, supportedRange),
        roots,
        // Appendix M.1: the caller's project root decides the instructions
        // root's project id. The server never derives it from its own cwd.
        project_root: process.cwd(),
        // Appendix J.5: the server persists and only ever uses this snapshot
        // for version reads, generation probes and review generation.
        host_env: callerEnv
      },
      // Attach runs the host's own capability/generation probe inside the
      // handler (Claude Code and Codex start a real CLI process). It is a
      // long operation; the default 60 s control deadline cut it off while
      // the probe was still running and made a healthy serve look unreachable.
      { idempotency_key: newId("ipc"), deadline_ms: 300_000 }
    );
    if (!result.ok) {
      return failure(result.status, result.error, exitCodeForFailure(result.status, result.error));
    }
    return success(result.value);
  } finally {
    client.value.close();
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
  const viaServe = await runHostAttachViaServe({
    request,
    host_id: defaults.host_id,
    command,
    mode,
    config_space: configSpace,
    target_id: targetId,
    artifact_dir: artifactDir
  });
  if (viaServe !== null) {
    return viaServe;
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
    // Appendix J.5: capture the caller's host environment once. Every host
    // command this attach triggers (version read, generation probe) and every
    // later kernel command for this host uses this registration.
    const hostEnv = command === "attach"
      ? persistHostEnvironment({ home: request.home, host_id: defaults.host_id, env: process.env, now: now() })
      : (loadHostEnvironment(request.home, defaults.host_id) ?? {});
    const detected = readHostVersion(defaults.host_id, hostEnv);
    const supportedRange = HOST_COMPATIBILITY[defaults.host_id].supported_range;
    const versionSupported =
      detected.host_version !== null && isVersionInRange(detected.host_version, supportedRange);
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
        // The bridge inherits the attach caller's environment; host directory
        // templates expand from that snapshot (appendix H.1).
        host_env: process.env,
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
      schema_major: SCHEMA_MAJOR,
      host_version: detected.host_version,
      supported_range: supportedRange,
      version_supported: versionSupported
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
    let openCodeTui: JsonValue | null = null;
    if (defaults.host_id === "opencode") {
      if (command === "attach") {
        if (shouldMirrorOpenCodePluginDir(detected.host_version)) {
          mirrorOpenCodePluginDir(configSpace, process.env);
        }
        // Appendix O.1: the server plugin has no UI. Install the TUI companion
        // and register it in tui.json; without it the confirmation capability
        // stays unknown and adoption is impossible, which attach must report.
        const installed = installOpenCodeTuiPlugin(configSpace, process.env);
        openCodeTui = toJsonValue({
          installed: installed.ok,
          ...(installed.path === undefined ? {} : { path: installed.path }),
          ...(installed.reason === undefined ? {} : { reason: installed.reason })
        });
      } else {
        removeOpenCodePluginMirror(configSpace, process.env);
        removeOpenCodeTuiPlugin(configSpace, process.env);
      }
    }
    let managedRootsJson: JsonValue;
    if (command === "attach") {
      const registered = registerManagedRoots({
        connection: opened.value,
        host_id: defaults.host_id,
        mode,
        config_space: configSpace,
        adapter_id: (result.value as unknown as { adapter_id: never }).adapter_id,
        host_env: hostEnv,
        project_root: process.cwd(),
        // Appendix Q.1: skills only unless `managed_blocks` is enabled.
        managed_blocks: config.value.features?.includes("managed_blocks") === true,
        now: Date.now()
      });
      if (!registered.ok) {
        return failure(registered.status, registered.error, exitCodeForFailure(registered.status, registered.error));
      }
      managedRootsJson = toJsonValue(registered.value.map((root) => ({
        root_id: root.root_id,
        kind: root.kind,
        state: root.state
      })));
    } else {
      managedRootsJson = toJsonValue({
        revoked: revokeManagedRootsForHost(opened.value, defaults.host_id, Date.now())
      });
      clearHostEnvironment(request.home, defaults.host_id);
    }
    const attachCredentialEnv = configuredCredentialEnv(config.value);
    const generationProbe = command === "attach" && versionSupported
      ? await probeGenerationAfterAttach({
          connection: opened.value,
          blobs,
          home: request.home,
          host_id: defaults.host_id,
          mode,
          config_space: configSpace,
          host_env: hostEnv,
          ...(attachCredentialEnv === undefined ? {} : { credential_env: attachCredentialEnv }),
          ...(config.value.review_backend.enabled && config.value.review_backend.pricing !== undefined
            ? { pricing: config.value.review_backend.pricing }
            : {}),
          now: () => Date.now()
        })
      : null;
    return success(
      toJsonValue({
        ...result.value,
        ...(openCodeTui === null ? {} : { opencode_tui: openCodeTui }),
        managed_roots: managedRootsJson,
        ...(generationProbe === null ? {} : { generation_probe: generationProbe })
      }),
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
    case "doctor":
      return runDoctorGeneration(request);
    case "configure":
      return runConfigureWrite(request);
    case "configure.jev":
      return runConfigureJev(request);
    case "configure.generation":
      return runConfigureGeneration(request);
    case "configure.show":
      return runConfigureShow(request);
    case "status.local":
      return runStatusLocal(request);
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
    case "skills.pending":
      return runSkillsPending(request);
    case "skills.show":
      return runSkillsShow(request);
    case "skills.ask":
      return runSkillsAsk(request);
    case "skills.diff":
      return runSkillsDiff(request);
    case "skills.revoke":
      return runSkillsRevoke(request);
    case "skills.resolve":
      return runSkillsResolve(request);
    case "skills.adopt":
      return runSkillsAdopt(request);
    case "skills.disable":
      return runSkillsDisable(request);
    case "grant.issue":
      return runGrantIssue(request);
    case "grant.revoke":
      return runGrantRevoke(request);
    case "grant.list":
      return runGrantList(request);
    case "test.confirm":
      return runTestConfirm(request);
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
