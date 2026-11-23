/**
 * `identity.fork` and `identity.resume` kernel handlers (DD-FND-052, DD-FND-073).
 *
 * Domain rules stay in the ledger `IdentityService`:
 *   - the source branch must exist and `at_watermark` must be committed,
 *   - a fork copies only the requirement revisions in force at the watermark,
 *   - the new branch starts at `input_epoch = 1` with
 *     `goal_version = gv:<new_branch_id>:1`,
 *   - `resume` distinguishes `resumed` / `stale` / `recovery_required` and never
 *     trusts an observation ahead of the receipt sequence.
 *
 * This module owns only the kernel half: parameter validation, the single
 * journal frame, the SQLite projection and the audit `DecisionRecord`.
 *
 * Ordering follows DD-FND-070 and the existing `event.ingest` /
 * `write.apply` commits:
 *
 *   validate -> replay check -> IdentityService -> journal write + fsync
 *   -> one SQLite transaction:
 *        fork:   branch -> goal_snapshot -> input -> run -> session
 *                -> receipt_seq -> event_log -> decision_record
 *        resume: session CAS -> event_log -> decision_record
 *
 * Failure semantics:
 *   - validation and domain failures write nothing;
 *   - a retry of the same request returns the original branch/result with
 *     `created=false` and never writes a second frame;
 *   - a journal or session/config dependency that is missing fails closed with
 *     a typed `E_INTERNAL` / `E_VERSION_BINDING`;
 *   - a failure after journalling surfaces as `status="unknown"` with
 *     `side_effect="unknown"`, never as success.
 */

import { join, } from "node:path";

import { type ErrorEnvelope, type FailureStatus, type Hash, type HostId, type Id, type JsonValue, type Result, type SourceRef, type Tx, type VersionBinding } from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  formatSourceRef,
  isHostId,
  isId,
  newId,
  toJsonValue
} from "@evoplug/core";
import type { IpcHandler } from "@evoplug/ipc";
import { computeIdempotencyRequestHash } from "@evoplug/ipc";
import type { BranchForkResult, ForkIds, ForkOptions, ForkPlan, ForkRequest, GoalSnapshotStateRow, IdentityService, ResumePlan, ResumeResult } from "@evoplug/ledger";
import { checkDecisionActionReason, ledgerError } from "@evoplug/ledger";
import {
  JournalWriter,
  createJournalCommitter,
  listJournalStates,
  listActiveConfigProfiles,
  type JournalAppendResult,
  type JournalCommitOutcome,
  type JournalCommitter,
  type JournalFramePayload,
  type SqlRow,
  type SqliteConnection
} from "@evoplug/storage";

import { fieldError, internalError, kernelError, versionError } from "./errors.js";
import { homeLayout, type HomeLayout } from "./home.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Public dependency contract                                          */
/* ------------------------------------------------------------------ */

interface IdentityLifecycleDependencies {
  /** The single kernel writer connection. */
  readonly connection: SqliteConnection;
  readonly now: () => number;
  /** Pre-built FND committer; built from `home`/`layout` when omitted. */
  readonly journal?: JournalCommitter;
  /** Product home, used to locate the journal when `journal` is omitted. */
  readonly home?: string;
  readonly layout?: HomeLayout;
  /** Audit policy version stored on identity DecisionRecords. */
  readonly policy_version?: string;
  /** Audit classifier version stored on identity DecisionRecords. */
  readonly classifier_version?: string;
}

interface IdentityForkDependencies extends IdentityLifecycleDependencies {
  readonly identity: Pick<IdentityService, "fork">;
}

interface IdentityResumeDependencies extends IdentityLifecycleDependencies {
  readonly identity: Pick<IdentityService, "resume">;
}

/* ------------------------------------------------------------------ */
/* Constants and local primitives                                     */
/* ------------------------------------------------------------------ */

const EVENT_SCHEMA_VERSION = "rsi.event/1";
const JOURNAL_EVENT_SCHEMA_VERSION = "rsi.journal_event/1";
const DEFAULT_POLICY_VERSION = "dpolicy/1";
const DEFAULT_CLASSIFIER_VERSION = "fnd.identity/1";

type Row = Record<string, unknown>;

interface ForkParams {
  readonly source_branch_id: Id<"br">;
  readonly at_watermark: number;
}

interface ResumeParams {
  readonly session_id: Id<"sess">;
  readonly host_id: HostId;
  readonly config_space: string;
  readonly observed_watermark: number;
}

interface SourceContext {
  readonly session_id: Id<"sess">;
  readonly host_id: HostId;
  readonly config_space: string;
  readonly resume_generation: number;
  readonly config_version: string;
}

interface BranchContext {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly goal_version: string;
  readonly input_epoch: number;
  readonly config_version: string;
}

interface DecisionAuditInput {
  readonly binding: VersionBinding;
  readonly action: JsonValue;
  readonly action_kind: "identity_fork" | "identity_resume";
  readonly request_hash: Hash;
  readonly requirement_snapshot_hash: Hash;
  readonly rule_id: string;
  readonly policy_version: string;
  readonly classifier_version: string;
  readonly now: number;
}

interface DecisionAudit {
  readonly decision_id: Id<"dec">;
  readonly row: Record<string, JsonValue>;
  readonly decision_hash: Hash;
}

function ok<T>(value: T): Result<T, ErrorEnvelope> {
  return { ok: true, status: "ok", value };
}

function fail<T>(
  error: ErrorEnvelope,
  status: FailureStatus = "rejected"
): Result<T, ErrorEnvelope> {
  return { ok: false, status, error };
}

function asString(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function asNullableString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asNullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  return null;
}

function asNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  return 0;
}

function oneRow(
  connection: SqliteConnection,
  sql: string,
  params?: Readonly<Record<string, string | number | null>>
): Row | null {
  const row = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row;
}

function bindingJson(binding: VersionBinding): JsonValue {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

function jsonValueOf(value: unknown, incident: string): Result<JsonValue, ErrorEnvelope> {
  try {
    return ok(toJsonValue(value));
  } catch {
    return fail(internalError(incident));
  }
}

/* ------------------------------------------------------------------ */
/* Journal resources and per-connection serialization                  */
/* ------------------------------------------------------------------ */

function createJournal(deps: IdentityLifecycleDependencies): JournalCommitter | null {
  if (deps.journal !== undefined) {
    return deps.journal;
  }
  let layout: HomeLayout;
  if (deps.layout !== undefined) {
    layout = deps.layout;
  } else if (deps.home !== undefined) {
    layout = homeLayout(deps.home);
  } else {
    return null;
  }
  try {
    const states = listJournalStates(deps.connection);
    const latest = states[states.length - 1];
    const journalId = latest?.journal_id ?? "journal-000001";
    const relativePath = latest?.relative_path ?? "journal-000001.rsij";
    const writer = JournalWriter.open({
      file_path: join(layout.journal_dir, relativePath),
      journal_id: journalId,
      last_commit_seq: latest?.last_commit_seq ?? 0,
      trusted_prefix_end: latest?.trusted_prefix_end ?? 0,
      read_only: latest?.read_only === 1,
      tail_state: latest?.tail_state ?? "clean"
    });
    if (!writer.ok) {
      return null;
    }
    return createJournalCommitter({
      writer: writer.value,
      connection: deps.connection,
      relative_path: relativePath,
      now: deps.now
    });
  } catch {
    return null;
  }
}

interface Gate {
  tail: Promise<void>;
}

const GATES: WeakMap<SqliteConnection, Gate> = new WeakMap<SqliteConnection, Gate>();

/**
 * Serialises the authoritative read -> journal -> projection section. Fork and
 * resume share the gate per connection so a fork's receipt allocation cannot
 * interleave with a resume's generation CAS.
 */
function serialized<T>(connection: SqliteConnection, fn: () => Promise<T>): Promise<T> {
  let gate = GATES.get(connection);
  if (gate === undefined) {
    gate = { tail: Promise.resolve() };
    GATES.set(connection, gate);
  }
  const current = gate.tail;
  const result = current.then(fn, fn);
  gate.tail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function commitResult(outcome: JournalCommitOutcome<null>): Result<void, ErrorEnvelope> {
  if (outcome.ok) {
    return ok(undefined);
  }
  if (outcome.commit_state === "unknown_recovery_required") {
    return {
      ok: false,
      status: "unknown",
      error: { ...outcome.error, side_effect: "unknown" }
    };
  }
  return fail(outcome.error);
}

async function commitFrame(
  journal: JournalCommitter,
  body: JournalFramePayload,
  project: (tx: Tx, receipt: JournalAppendResult) => void
): Promise<Result<void, ErrorEnvelope>> {
  const outcome = await journal.commit(body, (tx, receipt) => {
    project(tx, receipt);
    return null;
  });
  return commitResult(outcome);
}

/* ------------------------------------------------------------------ */
/* Parameter validation                                               */
/* ------------------------------------------------------------------ */

function validateForkParams(value: unknown): Result<ForkParams, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(fieldError("params", "must_be_object"));
  }
  const sourceBranchId = value["source_branch_id"];
  if (typeof sourceBranchId !== "string" || !isId(sourceBranchId, "br")) {
    return fail(fieldError("source_branch_id", "id_prefix_br"));
  }
  const atWatermark = value["at_watermark"];
  if (typeof atWatermark !== "number" || !Number.isSafeInteger(atWatermark) || atWatermark < 0) {
    return fail(fieldError("at_watermark", "non_negative_safe_integer"));
  }
  const reason = value["reason"];
  if (reason !== "user_fork" && reason !== "host_fork") {
    return fail(fieldError("reason", "user_fork_or_host_fork"));
  }
  return ok({ source_branch_id: sourceBranchId, at_watermark: atWatermark });
}

function validateResumeParams(value: unknown): Result<ResumeParams, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(fieldError("params", "must_be_object"));
  }
  const sessionId = value["session_id"];
  if (typeof sessionId !== "string" || !isId(sessionId, "sess")) {
    return fail(fieldError("session_id", "id_prefix_sess"));
  }
  const hostId = value["host_id"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return fail(fieldError("host_id", "host_id"));
  }
  const configSpace = value["config_space"];
  if (typeof configSpace !== "string" || configSpace.length === 0) {
    return fail(fieldError("config_space", "non_empty_string"));
  }
  const observedWatermark = value["observed_watermark"];
  if (
    typeof observedWatermark !== "number" ||
    !Number.isSafeInteger(observedWatermark) ||
    observedWatermark < 0
  ) {
    return fail(fieldError("observed_watermark", "non_negative_safe_integer"));
  }
  return ok({
    session_id: sessionId,
    host_id: hostId,
    config_space: configSpace,
    observed_watermark: observedWatermark
  });
}

/* ------------------------------------------------------------------ */
/* Idempotency                                                        */
/* ------------------------------------------------------------------ */

function requestHashOf(
  params: unknown,
  method: "identity.fork" | "identity.resume",
  requestId: Id<"ipc">
): Hash {
  try {
    return computeIdempotencyRequestHash(toJsonValue(params));
  } catch {
    return canonicalHash({
      schema_version: "rsi.identity_fallback_request/1",
      method,
      request_id: requestId
    });
  }
}

/**
 * Recovers the dispatcher-assigned idempotency key from the `ipc_idempotency`
 * projection, the same way `write.apply` does. The key is hashed into a
 * `Hash` because the ledger's fork/resume request carries a `Hash`, not the
 * dispatcher's opaque string.
 */
function resolveIdempotencyHash(
  connection: SqliteConnection,
  clientId: Id<"adp">,
  method: "identity.fork" | "identity.resume",
  params: unknown,
  requestId: Id<"ipc">
): Hash {
  const requestHash = requestHashOf(params, method, requestId);
  let keyText: string | null = null;
  try {
    const row = connection
      .prepare<SqlRow>(
        `SELECT idempotency_key FROM ipc_idempotency
          WHERE client_id = :client_id
            AND method = :method
            AND request_hash = :request_hash
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get({ client_id: clientId, method, request_hash: requestHash });
    if (row !== undefined) {
      const value = row["idempotency_key"];
      if (typeof value === "string" && value.length > 0) {
        keyText = value;
      }
    }
  } catch {
    // Older databases may not carry the IPC idempotency projection.
  }
  return canonicalHash({
    schema_version: "rsi.identity_idempotency/1",
    method,
    idempotency_key: keyText ?? requestHash
  });
}

function forkEventKey(input: {
  readonly source_branch_id: Id<"br">;
  readonly at_watermark: number;
  readonly idempotency_key: Hash;
}): Hash {
  return canonicalHash({
    schema_version: "rsi.identity_fork_identity/1",
    source_branch_id: input.source_branch_id,
    at_watermark: input.at_watermark,
    reason: "explicit_request",
    idempotency_key: input.idempotency_key
  });
}

function resumeEventKey(input: {
  readonly session_id: Id<"sess">;
  readonly observed_watermark: number;
  readonly idempotency_key: Hash;
}): Hash {
  return canonicalHash({
    schema_version: "rsi.identity_resume_identity/1",
    session_id: input.session_id,
    observed_watermark: input.observed_watermark,
    idempotency_key: input.idempotency_key
  });
}

/* ------------------------------------------------------------------ */
/* Reads used by the kernel half                                      */
/* ------------------------------------------------------------------ */

function readEventByKey(connection: SqliteConnection, eventKey: Hash): Row | null {
  return oneRow(connection, "SELECT * FROM event_log WHERE event_key = :event_key", {
    event_key: eventKey
  });
}

function readSessionById(connection: SqliteConnection, sessionId: Id<"sess">): Row | null {
  return oneRow(connection, "SELECT * FROM session WHERE session_id = :session_id", {
    session_id: sessionId
  });
}

function readBranchById(connection: SqliteConnection, branchId: Id<"br">): Row | null {
  return oneRow(connection, "SELECT * FROM branch WHERE branch_id = :branch_id", {
    branch_id: branchId
  });
}

function readConfigVersion(
  connection: SqliteConnection,
  branchId: Id<"br">,
  configSpace: string
): Result<string, ErrorEnvelope> {
  const branchRow = oneRow(
    connection,
    `SELECT config_version FROM event_log
      WHERE branch_id = :branch_id AND config_version IS NOT NULL
      ORDER BY commit_seq DESC LIMIT 1`,
    { branch_id: branchId }
  );
  if (branchRow !== null) {
    const value = asString(branchRow, "config_version");
    if (value.length > 0) {
      return ok(value);
    }
  }
  const profiles = listActiveConfigProfiles(connection, configSpace);
  if (profiles.length === 1) {
    const profile = profiles[0];
    if (profile !== undefined && profile.config_version.length > 0) {
      return ok(profile.config_version);
    }
  }
  if (profiles.length > 1) {
    return fail(internalError("kernel.identity_lifecycle_config_multiple_active"));
  }
  return fail(versionError("active_config_profile", configSpace));
}

function readSourceContext(
  connection: SqliteConnection,
  sourceBranchId: Id<"br">
): Result<SourceContext, ErrorEnvelope> {
  const row = oneRow(
    connection,
    `SELECT i.session_id, s.host_id, s.config_space, s.resume_generation
       FROM input i
       JOIN session s ON s.session_id = i.session_id
      WHERE i.branch_id = :branch_id
      ORDER BY i.input_epoch DESC, i.receipt_seq DESC
      LIMIT 1`,
    { branch_id: sourceBranchId }
  );
  if (row === null) {
    return fail(versionError("existing_source_session", sourceBranchId));
  }
  const sessionId = asString(row, "session_id");
  const hostId = asString(row, "host_id");
  const configSpace = asString(row, "config_space");
  if (sessionId.length === 0 || configSpace.length === 0 || !isHostId(hostId)) {
    return fail(internalError("kernel.identity_fork_source_context_corrupt"));
  }
  const config = readConfigVersion(connection, sourceBranchId, configSpace);
  if (!config.ok) {
    return config;
  }
  return ok({
    session_id: sessionId as Id<"sess">,
    host_id: hostId,
    config_space: configSpace,
    resume_generation: asNumber(row, "resume_generation"),
    config_version: config.value
  });
}

function readBranchContext(
  connection: SqliteConnection,
  branch: Row,
  configSpace: string
): Result<BranchContext, ErrorEnvelope> {
  const branchId = asString(branch, "branch_id");
  const taskId = asString(branch, "task_id");
  const goalVersion = asString(branch, "current_goal_version");
  if (branchId.length === 0 || taskId.length === 0 || goalVersion.length === 0) {
    return fail(internalError("kernel.identity_resume_branch_row_corrupt"));
  }
  const epochRow = oneRow(
    connection,
    "SELECT MAX(input_epoch) AS epoch FROM input WHERE branch_id = :branch_id",
    { branch_id: branchId }
  );
  const rawEpoch = epochRow === null ? null : epochRow["epoch"];
  const inputEpoch =
    typeof rawEpoch === "number" && Number.isSafeInteger(rawEpoch) && rawEpoch >= 1
      ? rawEpoch
      : 1;
  const config = readConfigVersion(connection, branchId as Id<"br">, configSpace);
  if (!config.ok) {
    return config;
  }
  return ok({
    task_id: taskId as Id<"task">,
    branch_id: branchId as Id<"br">,
    goal_version: goalVersion,
    input_epoch: inputEpoch,
    config_version: config.value
  });
}

function readReceiptSeq(connection: SqliteConnection): number {
  const row = oneRow(connection, "SELECT value FROM schema_meta WHERE key = 'receipt_seq'");
  if (row === null) {
    return 0;
  }
  const value = Number(row["value"]);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isWatermarkCommitted(connection: SqliteConnection, watermark: number): boolean {
  if (watermark === 0) {
    return true;
  }
  const row = oneRow(
    connection,
    `SELECT 1 AS present
       FROM event_log e
       JOIN commit_record c ON c.commit_seq = e.commit_seq
      WHERE e.watermark = :watermark
      LIMIT 1`,
    { watermark }
  );
  return row !== null;
}

function readCommittedRanges(
  connection: SqliteConnection,
  upper: number
): Array<{ readonly from: number; readonly to: number }> {
  if (upper <= 0) {
    return [];
  }
  const rows = connection
    .prepare<SqlRow>(
      `SELECT DISTINCT e.watermark AS watermark
         FROM event_log e
         JOIN commit_record c ON c.commit_seq = e.commit_seq
        WHERE e.watermark >= 1 AND e.watermark <= :upper
        ORDER BY e.watermark ASC`
    )
    .all({ upper });
  const values: number[] = [];
  for (const row of rows) {
    const value = row["watermark"];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
      values.push(value);
    }
  }
  const ranges: Array<{ readonly from: number; readonly to: number }> = [];
  let start: number | null = null;
  let previous = 0;
  for (const value of values) {
    if (start === null) {
      start = value;
      previous = value;
      continue;
    }
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push({ from: start, to: previous });
    start = value;
    previous = value;
  }
  if (start !== null) {
    ranges.push({ from: start, to: previous });
  }
  return ranges;
}

function nextReceiptSeq(connection: SqliteConnection): Result<number, ErrorEnvelope> {
  const meta = oneRow(connection, "SELECT value FROM schema_meta WHERE key = 'receipt_seq'");
  const metaValue = meta === null ? 0 : Number(meta["value"]);
  const inputMax = oneRow(connection, "SELECT MAX(receipt_seq) AS value FROM input");
  const inputValue =
    inputMax === null || inputMax["value"] === null ? 0 : Number(inputMax["value"]);
  const candidate = Math.max(
    Number.isSafeInteger(metaValue) && metaValue >= 0 ? metaValue : 0,
    Number.isSafeInteger(inputValue) && inputValue >= 0 ? inputValue : 0
  );
  if (!Number.isSafeInteger(candidate) || candidate >= Number.MAX_SAFE_INTEGER) {
    return fail(internalError("kernel.identity_lifecycle_receipt_seq_exhausted"));
  }
  return ok(candidate + 1);
}

/* ------------------------------------------------------------------ */
/* Replay reconstruction                                              */
/* ------------------------------------------------------------------ */

function reconstructForkFromBranch(
  connection: SqliteConnection,
  branchId: Id<"br">
): Result<BranchForkResult, ErrorEnvelope> {
  const branch = readBranchById(connection, branchId);
  if (branch === null) {
    return fail(internalError("kernel.identity_fork_replay_branch_missing"));
  }
  const parentBranchId = asNullableString(branch, "parent_branch_id");
  const snapshotId =
    asNullableString(branch, "inherited_goal_snapshot_id") ??
    asNullableString(branch, "current_goal_snapshot_id");
  const forkedFrom = asNullableNumber(branch, "forked_from_watermark");
  if (parentBranchId === null || snapshotId === null || forkedFrom === null) {
    return fail(internalError("kernel.identity_fork_replay_branch_corrupt"));
  }
  const epochRow = oneRow(
    connection,
    "SELECT MIN(input_epoch) AS epoch FROM input WHERE branch_id = :branch_id",
    { branch_id: branchId }
  );
  const rawEpoch = epochRow === null ? null : epochRow["epoch"];
  const inputEpoch =
    typeof rawEpoch === "number" && Number.isSafeInteger(rawEpoch) && rawEpoch >= 1
      ? rawEpoch
      : 1;
  const snapshot = oneRow(
    connection,
    "SELECT local_goal_version FROM goal_snapshot WHERE snapshot_id = :snapshot_id",
    { snapshot_id: snapshotId }
  );
  if (snapshot === null) {
    return fail(internalError("kernel.identity_fork_replay_snapshot_missing"));
  }
  const goalVersion = asString(snapshot, "local_goal_version");
  if (goalVersion.length === 0) {
    return fail(internalError("kernel.identity_fork_replay_snapshot_corrupt"));
  }
  return ok({
    branch_id: asString(branch, "branch_id") as Id<"br">,
    parent_branch_id: parentBranchId as Id<"br">,
    forked_from_watermark: forkedFrom,
    goal_snapshot_id: snapshotId as Id<"gsnap">,
    task_id: asString(branch, "task_id") as Id<"task">,
    goal_version: goalVersion,
    input_epoch: inputEpoch,
    created: false
  });
}

function reconstructForkFromEvent(
  connection: SqliteConnection,
  eventRow: Row
): Result<BranchForkResult, ErrorEnvelope> {
  const branchId = asNullableString(eventRow, "branch_id");
  if (branchId === null || !isId(branchId, "br")) {
    return fail(internalError("kernel.identity_fork_replay_event_corrupt"));
  }
  return reconstructForkFromBranch(connection, branchId);
}

function observedWatermarkFromEvent(eventRow: Row, fallback: number): number {
  const text = asNullableString(eventRow, "payload_text");
  if (text === null) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const value = parsed["observed_watermark"];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return value;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function reconstructResumeFromEvent(
  connection: SqliteConnection,
  eventRow: Row,
  fallbackObserved: number
): Result<ResumeResult, ErrorEnvelope> {
  const sessionId = asString(eventRow, "session_id");
  const branchId = asNullableString(eventRow, "branch_id");
  if (sessionId.length === 0 || branchId === null || !isId(branchId, "br")) {
    return fail(internalError("kernel.identity_resume_replay_event_corrupt"));
  }
  const session = readSessionById(connection, sessionId as Id<"sess">);
  if (session === null) {
    return fail(internalError("kernel.identity_resume_replay_session_missing"));
  }
  return ok({
    session_id: sessionId as Id<"sess">,
    branch_id: branchId,
    resume_generation: asNumber(session, "resume_generation"),
    observed_watermark: observedWatermarkFromEvent(eventRow, fallbackObserved),
    current_watermark: asNumber(eventRow, "watermark"),
    status: "resumed",
    missing_ranges: [],
    replayed_events: 0
  });
}

function reconstructResumeFromDecision(
  connection: SqliteConnection,
  decisionRow: Row,
  fallbackObserved: number
): Result<ResumeResult, ErrorEnvelope> {
  const branchId = asString(decisionRow, "branch_id");
  const sessionId = asNullableString(decisionRow, "session_id");
  if (branchId.length === 0 || !isId(branchId, "br")) {
    return fail(internalError("kernel.identity_resume_replay_decision_corrupt"));
  }
  const branch = readBranchById(connection, branchId);
  if (branch === null) {
    return fail(internalError("kernel.identity_resume_replay_branch_missing"));
  }
  let resolvedSessionId = sessionId;
  if (resolvedSessionId === null) {
    const row = oneRow(
      connection,
      `SELECT session_id FROM input
        WHERE branch_id = :branch_id
        ORDER BY input_epoch DESC, receipt_seq DESC LIMIT 1`,
      { branch_id: branchId }
    );
    resolvedSessionId = row === null ? null : asNullableString(row, "session_id");
  }
  if (resolvedSessionId === null || !isId(resolvedSessionId, "sess")) {
    return fail(internalError("kernel.identity_resume_replay_session_missing"));
  }
  const session = readSessionById(connection, resolvedSessionId);
  if (session === null) {
    return fail(internalError("kernel.identity_resume_replay_session_missing"));
  }
  return ok({
    session_id: resolvedSessionId,
    branch_id: branchId,
    resume_generation: asNumber(session, "resume_generation"),
    observed_watermark: fallbackObserved,
    current_watermark: asNumber(decisionRow, "watermark"),
    status: "resumed",
    missing_ranges: [],
    replayed_events: 0
  });
}

function findDecisionByRequestHash(
  connection: SqliteConnection,
  actionKind: "identity_fork" | "identity_resume",
  requestHash: Hash
): Row | null {
  return oneRow(
    connection,
    `SELECT * FROM decision_record
      WHERE action_kind = :action_kind AND request_hash = :request_hash
      ORDER BY decided_at ASC
      LIMIT 1`,
    { action_kind: actionKind, request_hash: requestHash }
  );
}

/* ------------------------------------------------------------------ */
/* Decision audit                                                     */
/* ------------------------------------------------------------------ */

function buildDecisionAudit(
  input: DecisionAuditInput
): Result<DecisionAudit, ErrorEnvelope> {
  const policy = checkDecisionActionReason({
    action_kind: input.action_kind,
    reason_code: "explicit_request"
  });
  if (!policy.ok) {
    return fail(
      internalError("kernel.identity_lifecycle_decision_policy:" + policy.reason)
    );
  }

  const inputs: JsonValue = {
    requirement_snapshot_hash: input.requirement_snapshot_hash,
    fact_snapshot_hash: canonicalHash([]),
    feedback_snapshot_hash: canonicalHash([]),
    constraint_snapshot_hash: canonicalHash([]),
    outcome_current_hash: canonicalHash([]),
    budget_state_hash: canonicalHash([]),
    capability_snapshot_hash: canonicalHash([]),
    issue_snapshot_hash: null,
    evidence_refs: []
  };
  const diagnostics: JsonValue = {
    rule_ids: [input.rule_id],
    classifier_version: input.classifier_version,
    degraded_reasons: [],
    elapsed_ms: 0
  };
  const preimage: JsonValue = {
    binding: bindingJson(input.binding),
    policy_version: input.policy_version,
    issue_id: null,
    action: input.action,
    outcome: "ok",
    reason_code: "explicit_request",
    dedupe_key: null,
    evidence_hash: null,
    pack_hash: null,
    request_hash: input.request_hash,
    delivery_id: null,
    job_id: null,
    write_id: null,
    aggregate_id: null,
    inputs,
    rule_ids: [input.rule_id],
    classifier_version: input.classifier_version,
    degraded_reasons: []
  };
  const decisionHash = canonicalHash(preimage);
  const decisionId = newId("dec", input.now);
  const row: Record<string, JsonValue> = {
    decision_id: decisionId,
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    input_epoch: input.binding.input_epoch,
    goal_version: input.binding.goal_version,
    config_version: input.binding.config_version,
    watermark: input.binding.watermark,
    policy_version: input.policy_version,
    issue_id: null,
    action_kind: input.action_kind,
    outcome: "ok",
    reason_code: "explicit_request",
    dedupe_key: null,
    evidence_hash: null,
    pack_hash: null,
    request_hash: input.request_hash,
    delivery_id: null,
    job_id: null,
    write_id: null,
    aggregate_id: null,
    action_json: canonicalJsonText(input.action),
    inputs_json: canonicalJsonText(inputs),
    diagnostics_json: canonicalJsonText(diagnostics),
    decided_at: input.now,
    decision_hash: decisionHash
  };
  return ok({ decision_id: decisionId, row, decision_hash: decisionHash });
}

function insertDecision(tx: Tx, decision: DecisionAudit): void {
  tx.prepare(
    `INSERT INTO decision_record (
       decision_id, task_id, branch_id, input_epoch, goal_version, config_version,
       watermark, policy_version, issue_id, action_kind, outcome, reason_code,
       dedupe_key, evidence_hash, pack_hash, request_hash, delivery_id, job_id,
       write_id, aggregate_id, action_json, inputs_json, diagnostics_json,
       decided_at, decision_hash
     ) VALUES (
       :decision_id, :task_id, :branch_id, :input_epoch, :goal_version, :config_version,
       :watermark, :policy_version, :issue_id, :action_kind, :outcome, :reason_code,
       :dedupe_key, :evidence_hash, :pack_hash, :request_hash, :delivery_id, :job_id,
       :write_id, :aggregate_id, :action_json, :inputs_json, :diagnostics_json,
       :decided_at, :decision_hash
     )`
  ).run(decision.row);
}

/* ------------------------------------------------------------------ */
/* Event projection helpers                                           */
/* ------------------------------------------------------------------ */

interface EventLogRow {
  readonly event_id: Id<"ev">;
  readonly event_key: Hash;
  readonly commit_seq: number;
  readonly journal_id: string;
  readonly event_type: "identity.fork" | "identity.resume";
  readonly occurred_at: number;
  readonly received_at: number;
  readonly host_id: HostId;
  readonly config_space: string;
  readonly session_id: Id<"sess">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly input_id: Id<"input"> | null;
  readonly run_id: Id<"run"> | null;
  readonly input_epoch: number | null;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly correlation_id: Id<"corr">;
  readonly content_ref: SourceRef | null;
  readonly content_hash: Hash | null;
  readonly content_bytes: number | null;
  readonly payload_hash: Hash;
  readonly payload_text: string;
}

function insertEventLog(tx: Tx, row: EventLogRow): void {
  tx.prepare(
    `INSERT INTO event_log (
       event_id, event_key, commit_seq, journal_id, event_type, occurred_at, received_at,
       origin, origin_basis, human_attestation_json, trigger_axis, trigger_root_event_id,
       trigger_depth, host_id, config_space, session_id, task_id, branch_id, input_id,
       run_id, input_epoch, goal_version, config_version, watermark, source_seq,
       correlation_id, parent_event_id, call_id, content_ref, content_hash, content_bytes,
       payload_hash, payload_text
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :occurred_at,
       :received_at, 'system', 'explicit_event', NULL, 'unknown', NULL, 0,
       :host_id, :config_space, :session_id, :task_id, :branch_id, :input_id,
       :run_id, :input_epoch, :goal_version, :config_version, :watermark, NULL,
       :correlation_id, NULL, NULL, :content_ref, :content_hash, :content_bytes,
       :payload_hash, :payload_text
     )`
  ).run({
    event_id: row.event_id,
    event_key: row.event_key,
    commit_seq: row.commit_seq,
    journal_id: row.journal_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    host_id: row.host_id,
    config_space: row.config_space,
    session_id: row.session_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    input_id: row.input_id,
    run_id: row.run_id,
    input_epoch: row.input_epoch,
    goal_version: row.goal_version,
    config_version: row.config_version,
    watermark: row.watermark,
    correlation_id: row.correlation_id,
    content_ref: row.content_ref,
    content_hash: row.content_hash,
    content_bytes: row.content_bytes,
    payload_hash: row.payload_hash,
    payload_text: row.payload_text
  });
}

/* ------------------------------------------------------------------ */
/* Fork handler                                                       */
/* ------------------------------------------------------------------ */

interface ForkProjection {
  readonly plan: ForkPlan;
  readonly source: SourceContext;
  readonly seed_input_id: Id<"input">;
  readonly seed_run_id: Id<"run">;
  readonly receipt_seq: number;
  readonly event: EventLogRow;
  readonly decision: DecisionAudit;
  readonly now: number;
}

function projectFork(tx: Tx, input: ForkProjection): void {
  const fork = input.plan.fork;
  const snapshot: GoalSnapshotStateRow = input.plan.goal_snapshot;

  tx.prepare(
    `INSERT INTO branch (
       branch_id, task_id, parent_branch_id, forked_from_watermark,
       inherited_goal_snapshot_id, current_goal_version, current_goal_revision,
       current_goal_snapshot_id, created_at, updated_at
     ) VALUES (
       :branch_id, :task_id, :parent_branch_id, :forked_from_watermark,
       :inherited_goal_snapshot_id, :current_goal_version, 1,
       :current_goal_snapshot_id, :now, :now
     )`
  ).run({
    branch_id: fork.branch_id,
    task_id: fork.task_id,
    parent_branch_id: fork.parent_branch_id,
    forked_from_watermark: fork.forked_from_watermark,
    inherited_goal_snapshot_id: fork.goal_snapshot_id,
    current_goal_version: fork.goal_version,
    current_goal_snapshot_id: fork.goal_snapshot_id,
    now: input.now
  });

  tx.prepare(
    `INSERT INTO goal_snapshot (
       snapshot_id, task_id, source_branch_id, source_goal_version,
       local_goal_version, local_goal_revision, watermark,
       active_requirement_ids_json, snapshot_hash, created_at
     ) VALUES (
       :snapshot_id, :task_id, :source_branch_id, :source_goal_version,
       :local_goal_version, :local_goal_revision, :watermark,
       :active_requirement_ids_json, :snapshot_hash, :created_at
     )`
  ).run({
    snapshot_id: snapshot.snapshot_id,
    task_id: snapshot.task_id,
    source_branch_id: snapshot.source_branch_id,
    source_goal_version: snapshot.source_goal_version,
    local_goal_version: snapshot.local_goal_version,
    local_goal_revision: snapshot.local_goal_revision,
    watermark: snapshot.watermark,
    active_requirement_ids_json: snapshot.active_requirement_ids_json,
    snapshot_hash: snapshot.snapshot_hash,
    created_at: snapshot.created_at
  });

  tx.prepare(
    `INSERT INTO input (
       input_id, task_id, branch_id, session_id, input_epoch, parent_input_id,
       origin, human_attestation_json, directive_strength, content_ref, content_hash,
       received_at, receipt_seq
     ) VALUES (
       :input_id, :task_id, :branch_id, :session_id, 1, NULL,
       'system', NULL, 'ambiguous', :content_ref, :content_hash,
       :received_at, :receipt_seq
     )`
  ).run({
    input_id: input.seed_input_id,
    task_id: fork.task_id,
    branch_id: fork.branch_id,
    session_id: input.source.session_id,
    content_ref: input.event.content_ref,
    content_hash: input.event.content_hash,
    received_at: input.now,
    receipt_seq: input.receipt_seq
  });

  tx.prepare(
    `INSERT INTO run (run_id, input_id, session_id, attempt, state, started_at, ended_at)
     VALUES (:run_id, :input_id, :session_id, 1, 'started', :now, NULL)`
  ).run({
    run_id: input.seed_run_id,
    input_id: input.seed_input_id,
    session_id: input.source.session_id,
    now: input.now
  });

  tx.prepare(
    `UPDATE session SET current_branch_id = :branch_id, last_seen_at = :now
      WHERE session_id = :session_id`
  ).run({
    branch_id: fork.branch_id,
    now: input.now,
    session_id: input.source.session_id
  });

  tx.prepare(
    `INSERT INTO schema_meta (key, value, updated_at)
     VALUES ('receipt_seq', :value, :now)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run({ value: String(input.receipt_seq), now: input.now });

  insertEventLog(tx, input.event);
  insertDecision(tx, input.decision);
}

export function createIdentityForkHandler(
  deps: IdentityForkDependencies
): IpcHandler<"identity.fork"> {
  const journal = createJournal(deps);

  return async (context) => {
    if (context.signal.aborted) {
      return fail(kernelError("E_CANCELLED"));
    }
    const validated = validateForkParams(context.params);
    if (!validated.ok) {
      return validated;
    }
    const params = validated.value;

    return serialized(deps.connection, async (): Promise<Result<BranchForkResult, ErrorEnvelope>> => {
      try {
        const now = deps.now();
        const idempotencyKey = resolveIdempotencyHash(
          deps.connection,
          context.client_id,
          "identity.fork",
          context.params,
          context.request_id
        );
        const eventKey = forkEventKey({
          source_branch_id: params.source_branch_id,
          at_watermark: params.at_watermark,
          idempotency_key: idempotencyKey
        });

        const existingEvent = readEventByKey(deps.connection, eventKey);
        if (existingEvent !== null) {
          return reconstructForkFromEvent(deps.connection, existingEvent);
        }
        const existingDecision = findDecisionByRequestHash(
          deps.connection,
          "identity_fork",
          idempotencyKey
        );
        if (existingDecision !== null) {
          const branchId = asString(existingDecision, "branch_id");
          if (!isId(branchId, "br")) {
            return fail(internalError("kernel.identity_fork_replay_decision_corrupt"));
          }
          return reconstructForkFromBranch(deps.connection, branchId);
        }

        if (journal === null) {
          return fail(internalError("kernel.identity_fork_commit_unavailable"));
        }

        const watermarkCommitted = isWatermarkCommitted(
          deps.connection,
          params.at_watermark
        );
        const ids: ForkIds = {
          branch_id: newId("br", now),
          goal_snapshot_id: newId("gsnap", now)
        };
        const request: ForkRequest = {
          source_branch_id: params.source_branch_id,
          at_watermark: params.at_watermark,
          reason: "explicit_request",
          idempotency_key: idempotencyKey
        };
        const options: ForkOptions = { watermark_committed: watermarkCommitted };
        const planResult = await deps.identity.fork(request, ids, options);
        if (!planResult.ok) {
          return planResult;
        }
        const plan = planResult.value;
        if (!plan.created) {
          return ok(plan.fork);
        }

        const source = readSourceContext(deps.connection, params.source_branch_id);
        if (!source.ok) {
          return source;
        }
        const receipt = nextReceiptSeq(deps.connection);
        if (!receipt.ok) {
          return receipt;
        }

        const eventId = newId("ev", now);
        const seedInputId = newId("input", now);
        const seedRunId = newId("run", now);
        const correlationId = newId("corr", now);
        const payload: JsonValue = {
          kind: "identity.fork",
          source_branch_id: params.source_branch_id,
          at_watermark: params.at_watermark
        };
        const payloadText = canonicalJsonText(payload);
        const payloadHash = canonicalHash(payload);
        const payloadBytes = new TextEncoder().encode(payloadText).byteLength;
        const contentRefResult = formatSourceRef({
          scheme: "journal",
          locator: eventId,
          start: 0,
          end: payloadBytes
        });
        if (!contentRefResult.ok) {
          return fail(contentRefResult.error);
        }
        const contentRef = contentRefResult.value;

        const binding: VersionBinding = {
          task_id: plan.fork.task_id,
          branch_id: plan.fork.branch_id,
          input_epoch: plan.fork.input_epoch,
          goal_version: plan.fork.goal_version,
          config_version: source.value.config_version,
          watermark: receipt.value
        };

        const envelope: JsonValue = {
          schema_version: EVENT_SCHEMA_VERSION,
          event_id: eventId,
          event_key: eventKey,
          watermark: receipt.value,
          received_at: now,
          binding: bindingJson(binding),
          session_id: source.value.session_id,
          resume_generation: source.value.resume_generation,
          task_id: plan.fork.task_id,
          branch_id: plan.fork.branch_id,
          input_id: seedInputId,
          run_id: seedRunId,
          correlation_id: correlationId,
          origin: "system",
          origin_basis: "explicit_event",
          trigger_lineage: { axis: "unknown", root_event_id: null, depth: 0 },
          attribution: {
            sender: "system",
            typed_user_message: false,
            typed_field_names: []
          },
          payload,
          content_ref: contentRef,
          content_hash: payloadHash,
          payload_hash: payloadHash
        };

        const inheritedResult = jsonValueOf(
          {
            inherited_requirements: plan.inherited_requirements.map((requirement) => ({
              requirement_id: requirement.requirement_id,
              revision: requirement.revision,
              status: requirement.status,
              statement_ref: requirement.statement_ref,
              statement_text_hash: requirement.statement_text_hash,
              scope: requirement.scope,
              acceptance: requirement.acceptance
            })),
            active_requirement_ids: plan.active_requirement_ids
          },
          "kernel.identity_fork_requirement_snapshot_encode"
        );
        if (!inheritedResult.ok) {
          return inheritedResult;
        }

        const decision = buildDecisionAudit({
          binding: {
            task_id: plan.fork.task_id,
            branch_id: plan.fork.branch_id,
            input_epoch: plan.fork.input_epoch,
            goal_version: plan.fork.goal_version,
            config_version: source.value.config_version,
            watermark: params.at_watermark
          },
          action: {
            kind: "identity_fork",
            targets: [],
            source_branch_id: params.source_branch_id,
            new_branch_id: plan.fork.branch_id,
            at_watermark: params.at_watermark
          },
          action_kind: "identity_fork",
          request_hash: idempotencyKey,
          requirement_snapshot_hash: canonicalHash(inheritedResult.value),
          rule_id: "identity.fork.explicit_request",
          policy_version: deps.policy_version ?? DEFAULT_POLICY_VERSION,
          classifier_version: deps.classifier_version ?? DEFAULT_CLASSIFIER_VERSION,
          now
        });
        if (!decision.ok) {
          return decision;
        }

        const body: JournalFramePayload = {
          schema_version: JOURNAL_EVENT_SCHEMA_VERSION,
          event: envelope,
          event_hash: canonicalHash(envelope),
          blob_hashes: []
        };

        const committed = await commitFrame(journal, body, (tx, journalReceipt) => {
          projectFork(tx, {
            plan,
            source: source.value,
            seed_input_id: seedInputId,
            seed_run_id: seedRunId,
            receipt_seq: receipt.value,
            event: {
              event_id: eventId,
              event_key: eventKey,
              commit_seq: journalReceipt.first_commit_seq,
              journal_id: journalReceipt.journal_id,
              event_type: "identity.fork",
              occurred_at: now,
              received_at: now,
              host_id: source.value.host_id,
              config_space: source.value.config_space,
              session_id: source.value.session_id,
              task_id: plan.fork.task_id,
              branch_id: plan.fork.branch_id,
              input_id: seedInputId,
              run_id: seedRunId,
              input_epoch: plan.fork.input_epoch,
              goal_version: plan.fork.goal_version,
              config_version: source.value.config_version,
              watermark: receipt.value,
              correlation_id: correlationId,
              content_ref: contentRef,
              content_hash: payloadHash,
              content_bytes: payloadBytes,
              payload_hash: payloadHash,
              payload_text: payloadText
            },
            decision: decision.value,
            now
          });
        });
        if (!committed.ok) {
          return committed;
        }
        return ok(plan.fork);
      } catch {
        return fail(internalError("kernel.identity_fork_failed"));
      }
    });
  };
}

/* ------------------------------------------------------------------ */
/* Resume handler                                                     */
/* ------------------------------------------------------------------ */

interface ResumeProjection {
  readonly event: EventLogRow;
  readonly decision: DecisionAudit;
  readonly session_id: Id<"sess">;
  readonly expected_generation: number;
  readonly next_generation: number;
  readonly branch_id: Id<"br">;
  readonly now: number;
}

function projectResume(tx: Tx, input: ResumeProjection): void {
  const updated = tx.prepare(
    `UPDATE session
        SET current_branch_id = :branch_id,
            resume_generation = :resume_generation,
            last_seen_at = :now
      WHERE session_id = :session_id
        AND resume_generation = :expected_generation`
  ).run({
    branch_id: input.branch_id,
    resume_generation: input.next_generation,
    now: input.now,
    session_id: input.session_id,
    expected_generation: input.expected_generation
  });
  if (updated.changes !== 1) {
    throw ledgerError({
      code: "E_STALE_VERSION",
      category: "conflict",
      details: {
        kind: "version",
        expected: String(input.expected_generation),
        actual: "session_resume_generation_changed"
      },
      stage: "persist"
    });
  }
  insertEventLog(tx, input.event);
  insertDecision(tx, input.decision);
}

export function createIdentityResumeHandler(
  deps: IdentityResumeDependencies
): IpcHandler<"identity.resume"> {
  const journal = createJournal(deps);

  return async (context) => {
    if (context.signal.aborted) {
      return fail(kernelError("E_CANCELLED"));
    }
    const validated = validateResumeParams(context.params);
    if (!validated.ok) {
      return validated;
    }
    const params = validated.value;

    return serialized(deps.connection, async (): Promise<Result<ResumeResult, ErrorEnvelope>> => {
      try {
        const now = deps.now();
        const idempotencyKey = resolveIdempotencyHash(
          deps.connection,
          context.client_id,
          "identity.resume",
          context.params,
          context.request_id
        );
        const eventKey = resumeEventKey({
          session_id: params.session_id,
          observed_watermark: params.observed_watermark,
          idempotency_key: idempotencyKey
        });

        const session = readSessionById(deps.connection, params.session_id);
        if (session === null) {
          return fail(versionError("existing_session", params.session_id));
        }
        if (
          asString(session, "host_id") !== params.host_id ||
          asString(session, "config_space") !== params.config_space
        ) {
          return fail(
            versionError(
              `${params.host_id}/${params.config_space}`,
              `${asString(session, "host_id")}/${asString(session, "config_space")}`
            )
          );
        }
        const expectedGeneration = asNumber(session, "resume_generation");

        // Replay checks run before the branch read so a completed explicit
        // resume still answers after the session has been rebound elsewhere.
        const existingEvent = readEventByKey(deps.connection, eventKey);
        if (existingEvent !== null) {
          return reconstructResumeFromEvent(
            deps.connection,
            existingEvent,
            params.observed_watermark
          );
        }
        const existingDecision = findDecisionByRequestHash(
          deps.connection,
          "identity_resume",
          idempotencyKey
        );
        if (existingDecision !== null) {
          return reconstructResumeFromDecision(
            deps.connection,
            existingDecision,
            params.observed_watermark
          );
        }

        const currentBranch = asNullableString(session, "current_branch_id");
        if (currentBranch === null || !isId(currentBranch, "br")) {
          return fail(versionError("existing_current_branch", params.session_id));
        }
        const branch = readBranchById(deps.connection, currentBranch);
        if (branch === null) {
          return fail(versionError("existing_branch", currentBranch));
        }
        const branchContext = readBranchContext(
          deps.connection,
          branch,
          params.config_space
        );
        if (!branchContext.ok) {
          return branchContext;
        }

        const current = readReceiptSeq(deps.connection);
        const committedRanges = readCommittedRanges(deps.connection, current);
        const planResult = await deps.identity.resume({
          session_id: params.session_id,
          branch_id: currentBranch,
          resume_generation: expectedGeneration,
          observed_watermark: params.observed_watermark,
          committed_ranges: committedRanges,
          history_retained: journal !== null,
          idempotency_key: idempotencyKey
        });
        if (!planResult.ok) {
          return planResult;
        }
        const plan: ResumePlan = planResult.value;
        if (!plan.write_identity_resume_event || plan.audit === null) {
          return ok(plan.result);
        }
        if (journal === null) {
          return fail(internalError("kernel.identity_resume_commit_unavailable"));
        }
        if (plan.result.resume_generation !== expectedGeneration + 1) {
          return fail(internalError("kernel.identity_resume_generation_mismatch"));
        }

        const eventId = newId("ev", now);
        const correlationId = newId("corr", now);
        const payload: JsonValue = {
          kind: "identity.resume",
          session_id: params.session_id,
          observed_watermark: params.observed_watermark
        };
        const payloadText = canonicalJsonText(payload);
        const payloadHash = canonicalHash(payload);
        const binding: VersionBinding = {
          task_id: branchContext.value.task_id,
          branch_id: branchContext.value.branch_id,
          input_epoch: branchContext.value.input_epoch,
          goal_version: branchContext.value.goal_version,
          config_version: branchContext.value.config_version,
          watermark: plan.result.current_watermark
        };
        const envelope: JsonValue = {
          schema_version: EVENT_SCHEMA_VERSION,
          event_id: eventId,
          event_key: eventKey,
          watermark: plan.result.current_watermark,
          received_at: now,
          binding: bindingJson(binding),
          session_id: params.session_id,
          resume_generation: plan.result.resume_generation,
          task_id: branchContext.value.task_id,
          branch_id: branchContext.value.branch_id,
          correlation_id: correlationId,
          origin: "system",
          origin_basis: "explicit_event",
          trigger_lineage: { axis: "unknown", root_event_id: null, depth: 0 },
          attribution: {
            sender: "system",
            typed_user_message: false,
            typed_field_names: []
          },
          payload,
          payload_hash: payloadHash
        };

        // Resume reads no requirement rows; the canonical empty view is the
        // honest snapshot rather than branch metadata mislabelled as a
        // requirement snapshot.
        const requirementSnapshot = canonicalHash([]);

        const decision = buildDecisionAudit({
          binding,
          action: {
            kind: "identity_resume",
            targets: [],
            session_id: params.session_id,
            observed_watermark: params.observed_watermark
          },
          action_kind: "identity_resume",
          request_hash: idempotencyKey,
          requirement_snapshot_hash: requirementSnapshot,
          rule_id: "identity.resume.explicit_request",
          policy_version: deps.policy_version ?? DEFAULT_POLICY_VERSION,
          classifier_version: deps.classifier_version ?? DEFAULT_CLASSIFIER_VERSION,
          now
        });
        if (!decision.ok) {
          return decision;
        }

        const body: JournalFramePayload = {
          schema_version: JOURNAL_EVENT_SCHEMA_VERSION,
          event: envelope,
          event_hash: canonicalHash(envelope),
          blob_hashes: []
        };

        const committed = await commitFrame(journal, body, (tx, journalReceipt) => {
          projectResume(tx, {
            event: {
              event_id: eventId,
              event_key: eventKey,
              commit_seq: journalReceipt.first_commit_seq,
              journal_id: journalReceipt.journal_id,
              event_type: "identity.resume",
              occurred_at: now,
              received_at: now,
              host_id: params.host_id,
              config_space: params.config_space,
              session_id: params.session_id,
              task_id: branchContext.value.task_id,
              branch_id: branchContext.value.branch_id,
              input_id: null,
              run_id: null,
              input_epoch: null,
              goal_version: branchContext.value.goal_version,
              config_version: branchContext.value.config_version,
              watermark: plan.result.current_watermark,
              correlation_id: correlationId,
              content_ref: null,
              content_hash: null,
              content_bytes: null,
              payload_hash: payloadHash,
              payload_text: payloadText
            },
            decision: decision.value,
            session_id: params.session_id,
            expected_generation: expectedGeneration,
            next_generation: plan.result.resume_generation,
            branch_id: branchContext.value.branch_id,
            now
          });
        });
        if (!committed.ok) {
          return committed;
        }
        return ok(plan.result);
      } catch {
        return fail(internalError("kernel.identity_resume_failed"));
      }
    });
  };
}
