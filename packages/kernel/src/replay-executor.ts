/**
 * `replay.execute` (DD-FND-094, DD-FND-096.3, DD-FND-097.5).
 *
 * The handler never trusts a client-supplied classification, plan hash, token
 * or execution scope. It re-reads the persisted plan, re-runs the authorization
 * rules, appends the ordered ledger frames (approval consumed → execution
 * authorized → plan running), fsyncs each one, and only then performs the
 * single short SQLite transaction that CAS-consumes the approval, inserts the
 * unique active execution and moves the plan to `running`. A process is
 * spawned only after that transaction commits.
 *
 * `replay.execute` returns `running` as soon as the start transition is
 * durable. The terminal result is written by a background task that holds the
 * exact `(execution_id, fencing_token, row_version)` it was given.
 *
 * Isolation is delegated to a `ReplayProcessSpawner`. The built-in spawner
 * runs a host process with `isolation.mechanism="none"`; container/VM/OS
 * sandbox mechanisms require an injected spawner that owns that capability and
 * therefore fail closed with a stable `kernel.*` incident instead of claiming
 * an isolation the kernel cannot provide.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

import {
  canonicalHash,
  canonicalJsonText,
  err,
  newId,
  ok,
  parseSourceRef,
  parseVersionBinding,
} from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  NotPromise,
  Result,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";
import type { HumanAttestation } from "@evoplug/egress";
import { parseHumanAttestation } from "@evoplug/egress";
import { makeIpcError } from "@evoplug/ipc";
import type { IpcHandler } from "@evoplug/ipc";
import {
  authorizeReplay,
  completeReplayExecution,
  createReplayExecution,
  expireReplayApproval,
  generateFencingToken,
  isReplayClass,
  isReplayExecutionState,
  isReplayPlanState,
  parseReplayExecuteRequest,
  parseReplayIsolation,
  parseReplaySideEffectKinds,
  planStateForExecutionResult,
  replayApprovalExpiredError,
  replayApprovalMismatchError,
  replayApprovalNotFoundError,
  replayApprovalStateError,
  replayExecutionReconcileRequiredError,
  replayPlanHashMatches,
  replayPlanMismatchError,
  replayPlanNotFoundError,
  replayPlanStateError,
  startReplayExecution,
  transitionReplayPlan,
} from "@evoplug/replay";
import type {
  ReplayApproval,
  ReplayClass,
  ReplayExecution,
  ReplayIsolation,
  ReplayIsolationMechanism,
  ReplayPlan,
} from "@evoplug/replay";
import {
  createTransactionRunner,
  expectedCommitRecords,
  insertCommitRecord,
  receiptRelativePath,
  recordFrameDurability,
  storageDetails,
  storageError,
} from "@evoplug/storage";
import type {
  BlobStore,
  JournalAppendResult,
  JournalFramePayload,
  SqliteConnection,
  Tx,
} from "@evoplug/storage";

import { internalError } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Public dependency contract                                         */
/* ------------------------------------------------------------------ */

/** Minimal journal surface used here; `JournalWriter` satisfies it. */
export interface ReplayJournalPort {
  readonly journalId: string;
  append(payload: JournalFramePayload): Result<JournalAppendResult, ErrorEnvelope>;
  /**
   * Adopts the era-wide sequence and the current segment from
   * `journal_state`. Optional for test doubles; a real `JournalWriter`
   * implements it.
   */
  resyncFromDisk?(
    commitSeq: number,
    relativePath?: string,
    trustedPrefixEnd?: number
  ): void;
  /**
   * Fences the era after a durable frame whose projection failed. Optional
   * for test doubles; a real `JournalWriter` implements it.
   */
  markRecoveryRequired?(): void;
}

export interface ReplayEgressProxy {
  readonly host: string;
  readonly port: number;
}

export interface ReplaySpawnRequest {
  readonly execution_id: Id<"rex">;
  readonly replay_plan_id: Id<"rpl">;
  readonly fencing_token: string;
  readonly replay_class: ReplayClass;
  readonly command: string;
  readonly cwd: string;
  readonly isolation: ReplayIsolation;
  readonly allowed_network: boolean;
  readonly network_target: string | null;
  readonly egress_proxy: ReplayEgressProxy | null;
}

/** Terminal observation of one spawned process. */
export interface ReplayProcessOutcome {
  readonly process_exited: boolean;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly output_overflow: boolean;
}

export interface ReplayProcessHandle {
  readonly pid: number | null;
  /** Resolves when the process group is gone; never rejects. */
  wait(): Promise<ReplayProcessOutcome>;
  terminate(): void;
}

/**
 * Process execution port. `supported_isolation` is optional: when present the
 * handler refuses an unsupported mechanism before any state is written. When
 * absent the spawner owns the decision for every mechanism it is handed.
 */
export interface ReplayProcessSpawner {
  readonly supported_isolation?: readonly ReplayIsolationMechanism[];
  /** True when the spawner enforces the replay egress policy itself. */
  readonly handles_egress?: boolean;
  spawn(request: ReplaySpawnRequest): Promise<Result<ReplayProcessHandle, ErrorEnvelope>>;
}

export interface ReplayExecuteDeps {
  readonly connection: SqliteConnection;
  readonly journal: ReplayJournalPort;
  /** Path recorded in `journal_state.relative_path`, relative to EVOPLUG_HOME. */
  readonly journal_relative_path: string;
  readonly blob_store: BlobStore;
  readonly now: () => number;
  /** Defaults to the built-in host spawner. */
  readonly spawner?: ReplayProcessSpawner;
  /** Optional wall-clock cap; on expiry the process group is terminated. */
  readonly execution_timeout_ms?: number;
  /** Grace period after termination before the result becomes `unknown`. */
  readonly terminate_grace_ms?: number;
  /** Per-stream capture cap; exceeding it forces an `unknown` result. */
  readonly max_output_bytes?: number;
  /** Controlled egress entry handed to the built-in spawner. */
  readonly egress_proxy?: ReplayEgressProxy;
  /** Called when a storage CAS/commit failure forces `degraded_read_only`. */
  readonly on_degraded?: (reason: string) => void;
  /** Test/observability hook for the background result writer. */
  readonly on_background_task?: (task: Promise<void>) => void;
  readonly on_background_error?: (error: unknown) => void;
}

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 33_554_432;

const PLAN_ROW_SCHEMA = "rsi.replay_plan_row/1";
const APPROVAL_ROW_SCHEMA = "rsi.replay_approval_row/1";
const EXECUTION_ROW_SCHEMA = "rsi.replay_execution_row/1";

/* ------------------------------------------------------------------ */
/* Row helpers                                                        */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function asString(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function asNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

function asNullableString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asNullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonColumn(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

function corrupt(incident: string): ErrorEnvelope {
  return internalError(`kernel.replay_executor_row_corrupt:${incident}`);
}

/* ------------------------------------------------------------------ */
/* JSON serializers                                                   */
/* ------------------------------------------------------------------ */

function bindingJson(binding: VersionBinding): JsonValue {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
  };
}

function isolationJson(isolation: ReplayIsolation): JsonValue {
  return {
    mechanism: isolation.mechanism,
    verified: isolation.verified,
    evidence_ref: isolation.evidence_ref,
    network_namespace: isolation.network_namespace,
    writable_roots: [...isolation.writable_roots],
  };
}

function attestationJson(attestation: HumanAttestation): JsonValue {
  return {
    kind: attestation.kind,
    capability_id: attestation.capability_id,
    evidence_ref: attestation.evidence_ref,
    confirmed_at: attestation.confirmed_at,
  };
}

function sourceRefsJson(refs: readonly SourceRef[]): JsonValue {
  return [...refs];
}

function planRow(plan: ReplayPlan, createdAt: number): Record<string, JsonValue> {
  return {
    replay_plan_id: plan.replay_plan_id,
    validation_plan_id: plan.validation_plan_id,
    replay_class: plan.replay_class,
    command: plan.command,
    cwd: plan.cwd,
    allowed_network: plan.allowed_network ? 1 : 0,
    network_target: plan.network_target,
    classification_evidence: plan.classification_evidence,
    environment: plan.environment,
    isolation_json: canonicalJsonText(isolationJson(plan.isolation)),
    version_binding_json: canonicalJsonText(bindingJson(plan.version_binding)),
    side_effect_kinds_json: canonicalJsonText([...plan.side_effect_kinds]),
    side_effect_refs_json: canonicalJsonText(sourceRefsJson(plan.side_effect_refs)),
    state: plan.state,
    plan_hash: plan.plan_hash,
    created_at: createdAt,
    row_version: plan.row_version,
  };
}

function approvalRow(approval: ReplayApproval): Record<string, JsonValue> {
  return {
    approval_id: approval.approval_id,
    replay_plan_id: approval.replay_plan_id,
    plan_hash: approval.plan_hash,
    approved_by: approval.approved_by,
    human_attestation_json: canonicalJsonText(attestationJson(approval.human_attestation)),
    attestation_subject_hash: approval.attestation_subject_hash,
    approval_hash: approval.approval_hash,
    command: approval.command,
    cwd: approval.cwd,
    version_binding_json: canonicalJsonText(bindingJson(approval.version_binding)),
    allowed_network: approval.allowed_network ? 1 : 0,
    network_target: approval.network_target,
    ttl_ms: approval.ttl_ms,
    state: approval.state,
    created_at: approval.created_at,
    expires_at: approval.expires_at,
    consumed_at: approval.consumed_at,
    consumed_execution_id: approval.consumed_execution_id,
    revoked_at: approval.revoked_at,
    revoke_reason: approval.revoke_reason,
    row_version: approval.row_version,
  };
}

function executionRow(execution: ReplayExecution): Record<string, JsonValue> {
  return {
    execution_id: execution.execution_id,
    replay_plan_id: execution.replay_plan_id,
    approval_id: execution.approval_id,
    state: execution.state,
    fencing_token: execution.fencing_token,
    reconcile_required: execution.reconcile_required ? 1 : 0,
    reconciled_at: execution.reconciled_at,
    reconcile_evidence_ref: execution.reconcile_evidence_ref,
    started_at: execution.started_at,
    ended_at: execution.ended_at,
    exit_code: execution.exit_code,
    stdout_ref: execution.stdout_ref,
    stderr_ref: execution.stderr_ref,
    result_hash: execution.result_hash,
    error_code: execution.error_code,
    row_version: execution.row_version,
    created_at: execution.created_at,
  };
}

function sqlParams(row: Record<string, JsonValue>): Readonly<Record<string, string | number | null>> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || typeof value === "string" || typeof value === "number") {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value ? 1 : 0;
    } else {
      throw new TypeError(`replay row column ${key} is not a scalar`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Row parsers                                                        */
/* ------------------------------------------------------------------ */

function parseSourceRefList(value: unknown): Result<SourceRef[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(corrupt("side_effect_refs"));
  }
  const items: readonly unknown[] = value;
  const out: SourceRef[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      return err(corrupt("side_effect_refs_item"));
    }
    const parsed = parseSourceRef(item);
    if (!parsed.ok) {
      return err(corrupt("side_effect_refs_ref"));
    }
    out.push(parsed.value.source_ref);
  }
  return ok(out);
}

function parseNullableSourceRef(value: unknown, incident: string): Result<SourceRef | null, ErrorEnvelope> {
  if (value === null || value === undefined) {
    return ok(null);
  }
  if (typeof value !== "string") {
    return err(corrupt(incident));
  }
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    return err(corrupt(incident));
  }
  return ok(parsed.value.source_ref);
}

function planFromRow(row: Row): Result<ReplayPlan, ErrorEnvelope> {
  const replayClass = asString(row, "replay_class");
  if (!isReplayClass(replayClass)) {
    return err(corrupt("replay_class"));
  }
  const state = asString(row, "state");
  if (!isReplayPlanState(state)) {
    return err(corrupt("plan_state"));
  }
  const evidence = asString(row, "classification_evidence");
  if (evidence !== "tool_metadata" && evidence !== "observed_effects" && evidence !== "none") {
    return err(corrupt("classification_evidence"));
  }
  const environment = asString(row, "environment");
  if (environment !== "host" && environment !== "temp_copy" && environment !== "sandbox") {
    return err(corrupt("environment"));
  }
  const isolation = parseReplayIsolation(jsonColumn(row["isolation_json"]));
  if (!isolation.ok) {
    return err(corrupt("isolation_json"));
  }
  const binding = parseVersionBinding(jsonColumn(row["version_binding_json"]));
  if (!binding.ok) {
    return err(corrupt("version_binding_json"));
  }
  const kinds = parseReplaySideEffectKinds(jsonColumn(row["side_effect_kinds_json"]));
  if (!kinds.ok) {
    return err(corrupt("side_effect_kinds_json"));
  }
  const refs = parseSourceRefList(jsonColumn(row["side_effect_refs_json"]));
  if (!refs.ok) {
    return refs;
  }
  return ok({
    schema_version: "rsi.replay_plan/2",
    replay_plan_id: asString(row, "replay_plan_id") as Id<"rpl">,
    validation_plan_id: asString(row, "validation_plan_id"),
    replay_class: replayClass,
    command: asString(row, "command"),
    cwd: asString(row, "cwd"),
    allowed_network: asNumber(row, "allowed_network") === 1,
    network_target: asNullableString(row, "network_target"),
    classification_evidence: evidence,
    environment,
    isolation: isolation.value,
    side_effect_kinds: kinds.value,
    side_effect_refs: refs.value,
    version_binding: binding.value,
    state,
    plan_hash: asString(row, "plan_hash") as Hash,
    row_version: asNumber(row, "row_version"),
  });
}

function approvalFromRow(row: Row): Result<ReplayApproval, ErrorEnvelope> {
  if (asString(row, "approved_by") !== "human") {
    return err(corrupt("approved_by"));
  }
  const attestation = parseHumanAttestation(jsonColumn(row["human_attestation_json"]));
  if (!attestation.ok) {
    return err(corrupt("human_attestation_json"));
  }
  const binding = parseVersionBinding(jsonColumn(row["version_binding_json"]));
  if (!binding.ok) {
    return err(corrupt("approval_version_binding_json"));
  }
  const state = asString(row, "state");
  if (state !== "active" && state !== "consumed" && state !== "revoked" && state !== "expired") {
    return err(corrupt("approval_state"));
  }
  const revokeReason = asNullableString(row, "revoke_reason");
  if (
    revokeReason !== null &&
    revokeReason !== "human_revoked" &&
    revokeReason !== "plan_rejected" &&
    revokeReason !== "policy_replaced"
  ) {
    return err(corrupt("approval_revoke_reason"));
  }
  return ok({
    approval_id: asString(row, "approval_id") as Id<"rpa">,
    replay_plan_id: asString(row, "replay_plan_id") as Id<"rpl">,
    plan_hash: asString(row, "plan_hash") as Hash,
    approved_by: "human",
    human_attestation: attestation.value,
    attestation_subject_hash: asString(row, "attestation_subject_hash") as Hash,
    approval_hash: asString(row, "approval_hash") as Hash,
    command: asString(row, "command"),
    cwd: asString(row, "cwd"),
    version_binding: binding.value,
    allowed_network: asNumber(row, "allowed_network") === 1,
    network_target: asNullableString(row, "network_target"),
    ttl_ms: asNumber(row, "ttl_ms"),
    state,
    created_at: asNumber(row, "created_at"),
    expires_at: asNumber(row, "expires_at"),
    consumed_at: asNullableNumber(row, "consumed_at"),
    consumed_execution_id: asNullableString(row, "consumed_execution_id") as Id<"rex"> | null,
    revoked_at: asNullableNumber(row, "revoked_at"),
    revoke_reason: revokeReason as ReplayApproval["revoke_reason"],
    row_version: asNumber(row, "row_version"),
  });
}

function executionFromRow(row: Row): Result<ReplayExecution, ErrorEnvelope> {
  const state = asString(row, "state");
  if (!isReplayExecutionState(state)) {
    return err(corrupt("execution_state"));
  }
  const stdout = parseNullableSourceRef(row["stdout_ref"], "execution_stdout_ref");
  if (!stdout.ok) {
    return stdout;
  }
  const stderr = parseNullableSourceRef(row["stderr_ref"], "execution_stderr_ref");
  if (!stderr.ok) {
    return stderr;
  }
  const evidence = parseNullableSourceRef(
    row["reconcile_evidence_ref"],
    "execution_reconcile_evidence_ref",
  );
  if (!evidence.ok) {
    return evidence;
  }
  return ok({
    schema_version: "rsi.replay_execution/1",
    execution_id: asString(row, "execution_id") as Id<"rex">,
    replay_plan_id: asString(row, "replay_plan_id") as Id<"rpl">,
    approval_id: asNullableString(row, "approval_id") as Id<"rpa"> | null,
    state,
    fencing_token: asString(row, "fencing_token"),
    reconcile_required: asNumber(row, "reconcile_required") === 1,
    reconciled_at: asNullableNumber(row, "reconciled_at"),
    reconcile_evidence_ref: evidence.value,
    started_at: asNullableNumber(row, "started_at"),
    ended_at: asNullableNumber(row, "ended_at"),
    exit_code: asNullableNumber(row, "exit_code"),
    stdout_ref: stdout.value,
    stderr_ref: stderr.value,
    result_hash: asNullableString(row, "result_hash") as Hash | null,
    error_code: asNullableString(row, "error_code"),
    row_version: asNumber(row, "row_version"),
    created_at: asNumber(row, "created_at"),
  });
}

/* ------------------------------------------------------------------ */
/* Journal frames                                                     */
/* ------------------------------------------------------------------ */

interface FrameInput {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation: "insert" | "transition";
  readonly binding: VersionBinding;
  readonly row_schema: string;
  readonly row: Record<string, JsonValue>;
  readonly before: Record<string, JsonValue> | null;
}

interface PendingFrame {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation: "insert" | "transition";
  readonly binding: VersionBinding;
  readonly row_schema: string;
  readonly row_json: string;
  readonly payload_hash: Hash;
  readonly after_hash: Hash;
  readonly before_hash: Hash | null;
  readonly event_key: Hash;
  readonly event_id: Id<"ev">;
  readonly receipt: JournalAppendResult;
  readonly payload: JournalFramePayload;
  readonly recorded_at: number;
}

function appendFrame(
  journal: ReplayJournalPort,
  nowMs: number,
  input: FrameInput,
): Result<PendingFrame, ErrorEnvelope> {
  const rowJson = canonicalJsonText(input.row);
  const afterHash = canonicalHash({ row_schema: input.row_schema, row_json: rowJson });
  const beforeHash =
    input.before === null
      ? null
      : canonicalHash({
          row_schema: input.row_schema,
          row_json: canonicalJsonText(input.before),
        });
  const eventId = newId("ev", nowMs);
  const binding = bindingJson(input.binding);
  const eventKey = canonicalHash({
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    before_hash: beforeHash,
    after_hash: afterHash,
    binding,
  });
  const event: JsonValue = {
    schema_version: "rsi.ledger_event/1",
    event_id: eventId,
    event_key: eventKey,
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    binding,
    before_hash: beforeHash,
    after_hash: afterHash,
    row_schema: input.row_schema,
    row_json: rowJson,
    payload_hash: afterHash,
    recorded_at: nowMs,
  };
  const payload: JournalFramePayload = {
    schema_version: "rsi.journal_event/1",
    event,
    event_hash: canonicalHash(event),
    blob_hashes: [],
  };
  const appended = journal.append(payload);
  if (!appended.ok) {
    return appended;
  }
  return ok({
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    binding: input.binding,
    row_schema: input.row_schema,
    row_json: rowJson,
    payload_hash: afterHash,
    after_hash: afterHash,
    before_hash: beforeHash,
    event_key: eventKey,
    event_id: eventId,
    receipt: appended.value,
    payload,
    recorded_at: nowMs,
  });
}

function insertLedgerEventLog(tx: Tx, frame: PendingFrame, commitSeq: number): void {
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, :binding_mode, :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`,
  ).run({
    event_id: String(frame.event_id),
    event_key: frame.event_key,
    commit_seq: commitSeq,
    journal_id: frame.receipt.journal_id,
    event_type: frame.event_type,
    entity_type: frame.entity_type,
    entity_id: frame.entity_id,
    operation: frame.operation,
    binding_mode: "bound",
    task_id: frame.binding.task_id,
    branch_id: frame.binding.branch_id,
    input_epoch: frame.binding.input_epoch,
    goal_version: frame.binding.goal_version,
    config_version: frame.binding.config_version,
    watermark: frame.binding.watermark,
    before_hash: frame.before_hash,
    after_hash: frame.after_hash,
    row_schema: frame.row_schema,
    row_json: frame.row_json,
    payload_hash: frame.payload_hash,
    recorded_at: frame.recorded_at,
  });
}

function projectFrames(
  withTx: <T>(fn: (tx: Tx) => NotPromise<T>) => T,
  configuredRelativePath: string,
  nowMs: number,
  frames: readonly PendingFrame[],
  apply: (tx: Tx) => void,
): void {
  withTx((tx) => {
    for (const frame of frames) {
      const committedAt = nowMs;
      const relativePath = receiptRelativePath(
        configuredRelativePath,
        frame.receipt.file_path,
      );
      if (relativePath === null) {
        throw storageError({
          code: "E_STORAGE_CORRUPT",
          stage: "storage.replay",
          details: storageDetails("receipt.file_path", "not_a_journal_segment"),
          side_effect: "unknown",
        });
      }
      recordFrameDurability(tx, {
        journal_id: frame.receipt.journal_id,
        relative_path: relativePath,
        first_commit_seq: frame.receipt.first_commit_seq,
        member_count: frame.receipt.member_count,
        trusted_prefix_end: frame.receipt.file_offset + frame.receipt.frame_bytes,
        updated_at: committedAt,
      });
      const records = expectedCommitRecords({
        journal_id: frame.receipt.journal_id,
        commit_seq: frame.receipt.first_commit_seq,
        payload: frame.payload,
        committed_at: committedAt,
        indexed_at: null,
      });
      if (!records.ok) {
        throw records.error;
      }
      for (const record of records.value) {
        insertCommitRecord(tx, record);
      }
      insertLedgerEventLog(tx, frame, frame.receipt.first_commit_seq);
    }
    apply(tx);
  });
}

function storageBusy(operation: string): ErrorEnvelope {
  return storageError({
    code: "E_STORAGE_BUSY",
    stage: "replay_execute",
    details: storageDetails(operation),
    retryable: true,
    side_effect: "unknown",
  });
}

/* ------------------------------------------------------------------ */
/* Built-in host spawner                                              */
/* ------------------------------------------------------------------ */

function concatChunks(chunks: readonly Buffer[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createHostSpawner(maxOutputBytes: number): ReplayProcessSpawner {
  return {
    supported_isolation: ["none"],
    async spawn(request: ReplaySpawnRequest): Promise<Result<ReplayProcessHandle, ErrorEnvelope>> {
      if (request.isolation.mechanism !== "none") {
        return err(
          internalError(
            `kernel.replay_isolation_unavailable:${request.isolation.mechanism}`,
          ),
        );
      }
      const isWindows = process.platform === "win32";
      const executable = isWindows ? (process.env["ComSpec"] ?? "cmd.exe") : "/bin/sh";
      const args = isWindows ? ["/d", "/s", "/c", request.command] : ["-c", request.command];
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        EVOPLUG_REPLAY_CLASS: request.replay_class,
        EVOPLUG_REPLAY_PLAN_ID: request.replay_plan_id,
        EVOPLUG_REPLAY_EXECUTION_ID: request.execution_id,
      };
      if (request.network_target !== null) {
        environment["EVOPLUG_REPLAY_NETWORK_TARGET"] = request.network_target;
      }
      if (request.allowed_network && request.egress_proxy !== null) {
        const proxy = `http://${request.egress_proxy.host}:${String(request.egress_proxy.port)}`;
        environment["HTTP_PROXY"] = proxy;
        environment["HTTPS_PROXY"] = proxy;
        environment["ALL_PROXY"] = proxy;
      }

      const child = spawn(executable, args, {
        cwd: request.cwd,
        detached: !isWindows,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputOverflow = false;

      const terminate = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        try {
          if (!isWindows && child.pid !== undefined) {
            process.kill(-child.pid, "SIGTERM");
            return;
          }
        } catch {
          // Fall through to the single-process signal below.
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may already be gone; the wait result decides the state.
        }
      };

      const capture = (chunk: Buffer, target: Buffer[], size: number): number => {
        if (outputOverflow) {
          return size;
        }
        const next = size + chunk.byteLength;
        if (next > maxOutputBytes) {
          outputOverflow = true;
          stdoutChunks.length = 0;
          stderrChunks.length = 0;
          terminate();
          return 0;
        }
        target.push(chunk);
        return next;
      };

      const stdout = child.stdout;
      const stderr = child.stderr;
      if (stdout !== null) {
        stdout.on("data", (chunk: Buffer) => {
          stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes);
        });
      }
      if (stderr !== null) {
        stderr.on("data", (chunk: Buffer) => {
          stderrBytes = capture(chunk, stderrChunks, stderrBytes);
        });
      }

      const started = await new Promise<boolean>((resolve) => {
        const onSpawn = (): void => {
          cleanup();
          resolve(true);
        };
        const onError = (): void => {
          cleanup();
          resolve(false);
        };
        const cleanup = (): void => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      if (!started) {
        return err(internalError("kernel.replay_spawn_failed"));
      }

      const wait = new Promise<ReplayProcessOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: ReplayProcessOutcome): void => {
          if (!settled) {
            settled = true;
            resolve(outcome);
          }
        };
        child.once("close", (code, signal) => {
          settle({
            process_exited: true,
            exit_code: code,
            signal,
            stdout: concatChunks(stdoutChunks, stdoutBytes),
            stderr: concatChunks(stderrChunks, stderrBytes),
            output_overflow: outputOverflow,
          });
        });
        child.once("error", () => {
          settle({
            process_exited: false,
            exit_code: null,
            signal: null,
            stdout: new Uint8Array(0),
            stderr: new Uint8Array(0),
            output_overflow: outputOverflow,
          });
        });
      });

      return ok({
        pid: child.pid ?? null,
        wait: () => wait,
        terminate,
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Per-plan serialization                                             */
/* ------------------------------------------------------------------ */

type ReleaseFn = () => void;

function createPlanMutex(): <T>(planId: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(planId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(planId) ?? Promise.resolve();
    const deferred = Promise.withResolvers<void>();
    const tail = previous.then(() => deferred.promise);
    tails.set(planId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      deferred.resolve();
      if (tails.get(planId) === tail) {
        tails.delete(planId);
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Result helpers                                                     */
/* ------------------------------------------------------------------ */

function blobRef(
  blobStore: BlobStore,
  bytes: Uint8Array,
): Result<SourceRef | null, ErrorEnvelope> {
  if (bytes.byteLength === 0) {
    return ok(null);
  }
  const stored = blobStore.putSync(bytes);
  if (!stored.ok) {
    return stored;
  }
  const ref = `blob://${stored.value.hash}#bytes=0-${String(stored.value.byte_length)}`;
  const parsed = parseSourceRef(ref);
  if (!parsed.ok) {
    return err(internalError("kernel.replay_result_ref_invalid"));
  }
  return ok(parsed.value.source_ref);
}

function terminalExecution(
  execution: ReplayExecution,
  state: "failed" | "unknown" | "cancelled",
  endedAt: number,
  errorCode: string,
): ReplayExecution {
  if (state === "unknown") {
    return {
      ...execution,
      state,
      ended_at: endedAt,
      exit_code: null,
      stdout_ref: null,
      stderr_ref: null,
      result_hash: null,
      error_code: errorCode,
      reconcile_required: true,
      reconciled_at: null,
      reconcile_evidence_ref: null,
      row_version: execution.row_version + 1,
    };
  }
  return {
    ...execution,
    state,
    ended_at: endedAt,
    exit_code: null,
    stdout_ref: null,
    stderr_ref: null,
    result_hash: null,
    error_code: errorCode,
    reconcile_required: false,
    row_version: execution.row_version + 1,
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Builds the `replay.execute` handler. Every side effect is ordered:
 * journal frame + fsync → short synchronous SQLite projection → spawn.
 */
export function createReplayExecuteHandler(
  deps: ReplayExecuteDeps,
): IpcHandler<"replay.execute"> {
  const { connection, journal, blob_store, now } = deps;
  const runner = createTransactionRunner(connection);
  const withTx = <T>(fn: (tx: Tx) => NotPromise<T>): T => runner.withTxSync(fn);
  const resyncJournal = (): void => {
    if (typeof journal.resyncFromDisk !== "function") {
      return;
    }
    const row = connection
      .prepare<{
        last_commit_seq: number;
        trusted_prefix_end: number;
        relative_path: string;
      }>(
        "SELECT last_commit_seq, trusted_prefix_end, relative_path FROM journal_state WHERE journal_id = :journal_id",
      )
      .get({ journal_id: journal.journalId });
    if (row === undefined) {
      journal.resyncFromDisk(0);
      return;
    }
    journal.resyncFromDisk(
      Number(row.last_commit_seq),
      row.relative_path,
      Number(row.trusted_prefix_end)
    );
  };
  const appendJournalFrame = (
    nowMs: number,
    input: FrameInput,
  ): Result<PendingFrame, ErrorEnvelope> => {
    resyncJournal();
    return appendFrame(journal, nowMs, input);
  };
  const spawner = deps.spawner ?? createHostSpawner(deps.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const graceMs = deps.terminate_grace_ms ?? DEFAULT_TERMINATE_GRACE_MS;
  const withPlanLock = createPlanMutex();

  function readPlan(planId: Id<"rpl">): Result<ReplayPlan | null, ErrorEnvelope> {
    const row = connection
      .prepare<Row>("SELECT * FROM replay_plan WHERE replay_plan_id = :replay_plan_id")
      .get({ replay_plan_id: planId });
    if (row === undefined) {
      return ok(null);
    }
    return planFromRow(row);
  }

  function findActiveExecution(planId: Id<"rpl">): Result<ReplayExecution | null, ErrorEnvelope> {
    const row = connection
      .prepare<Row>(
        `SELECT * FROM replay_execution
          WHERE replay_plan_id = :replay_plan_id AND state IN ('authorized','running')
          ORDER BY created_at DESC, execution_id DESC LIMIT 1`,
      )
      .get({ replay_plan_id: planId });
    if (row === undefined) {
      return ok(null);
    }
    return executionFromRow(row);
  }

  function hasUnreconciledUnknown(planId: Id<"rpl">): boolean {
    const row = connection
      .prepare<Row>(
        `SELECT 1 AS present FROM replay_execution
          WHERE replay_plan_id = :replay_plan_id AND state = 'unknown' AND reconcile_required = 1
          LIMIT 1`,
      )
      .get({ replay_plan_id: planId });
    return row !== undefined;
  }

  function readApproval(approvalId: Id<"rpa">): Result<ReplayApproval | null, ErrorEnvelope> {
    const row = connection
      .prepare<Row>("SELECT * FROM replay_approval WHERE approval_id = :approval_id")
      .get({ approval_id: approvalId });
    if (row === undefined) {
      return ok(null);
    }
    return approvalFromRow(row);
  }

  function commitFrames(
    frames: readonly PendingFrame[],
    apply: (tx: Tx) => void,
    operation: string,
  ): Result<void, ErrorEnvelope> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        projectFrames(withTx, deps.journal_relative_path, now(), frames, apply);
        return ok(undefined);
      } catch (error) {
        // The first failure is retried with the same durable frames; a second
        // failure means the caller must stop and let recovery fence the row.
      }
    }
    deps.on_degraded?.(`${operation}_failed`);
    // The frames were fsynced before projection and are still durable. Block
    // every writer on the era until recovery advances the persisted tail.
    if (typeof journal.markRecoveryRequired === "function") {
      journal.markRecoveryRequired();
    }
    return err(storageBusy(operation));
  }

  function terminateQuietly(handle: ReplayProcessHandle): void {
    try {
      handle.terminate();
    } catch {
      // The persisted state, not the signal call, decides the result.
    }
  }

  function appendApprovalTransition(
    before: ReplayApproval,
    after: ReplayApproval,
    nowMs: number,
  ): Result<PendingFrame, ErrorEnvelope> {
    return appendJournalFrame(nowMs, {
      event_type: "replay.approval_transition",
      entity_type: "replay_approval",
      entity_id: after.approval_id,
      operation: "transition",
      binding: before.version_binding,
      row_schema: APPROVAL_ROW_SCHEMA,
      row: approvalRow(after),
      before: approvalRow(before),
    });
  }

  function expireActiveApproval(
    approval: ReplayApproval,
    nowMs: number,
  ): Result<void, ErrorEnvelope> {
    const expired = expireReplayApproval(approval, nowMs);
    if (expired.state === approval.state) {
      return ok(undefined);
    }
    const frame = appendApprovalTransition(approval, expired, nowMs);
    if (!frame.ok) {
      return frame;
    }
    return commitFrames(
      [frame.value],
      (tx) => {
        const result = tx
          .prepare(
            `UPDATE replay_approval SET
               state = :state, row_version = :row_version
             WHERE approval_id = :approval_id AND state = 'active'
               AND expires_at <= :now_ms AND row_version = :before_row_version`,
          )
          .run({
            state: expired.state,
            row_version: expired.row_version,
            approval_id: approval.approval_id,
            now_ms: nowMs,
            before_row_version: approval.row_version,
          });
        if (result.changes !== 1) {
          throw new Error("replay.approval_expire_cas");
        }
      },
      "replay_execute_approval_expire",
    );
  }

  function persistExecutionAndPlan(
    executionBefore: ReplayExecution,
    executionAfter: ReplayExecution,
    planBefore: ReplayPlan,
    planAfter: ReplayPlan,
    planCreatedAt: number,
    operation: string,
  ): Result<void, ErrorEnvelope> {
    const executionFrame = appendJournalFrame(now(), {
      event_type: "replay.execution_transition",
      entity_type: "replay_execution",
      entity_id: executionAfter.execution_id,
      operation: "transition",
      binding: planBefore.version_binding,
      row_schema: EXECUTION_ROW_SCHEMA,
      row: executionRow(executionAfter),
      before: executionRow(executionBefore),
    });
    if (!executionFrame.ok) {
      return executionFrame;
    }
    const planFrame = appendJournalFrame(now(), {
      event_type: "replay.plan_transition",
      entity_type: "replay_plan",
      entity_id: planAfter.replay_plan_id,
      operation: "transition",
      binding: planAfter.version_binding,
      row_schema: PLAN_ROW_SCHEMA,
      row: planRow(planAfter, planCreatedAt),
      before: planRow(planBefore, planCreatedAt),
    });
    if (!planFrame.ok) {
      return planFrame;
    }
    return commitFrames(
      [executionFrame.value, planFrame.value],
      (tx) => {
        const executionUpdate = tx
          .prepare(
            `UPDATE replay_execution SET
               state = :state, started_at = :started_at, ended_at = :ended_at,
               exit_code = :exit_code, stdout_ref = :stdout_ref, stderr_ref = :stderr_ref,
               result_hash = :result_hash, error_code = :error_code,
               reconcile_required = :reconcile_required, reconciled_at = :reconciled_at,
               reconcile_evidence_ref = :reconcile_evidence_ref, row_version = :row_version
             WHERE execution_id = :execution_id AND fencing_token = :fencing_token
               AND state = :before_state AND row_version = :before_row_version`,
          )
          .run({
            execution_id: executionAfter.execution_id,
            state: executionAfter.state,
            started_at: executionAfter.started_at,
            ended_at: executionAfter.ended_at,
            exit_code: executionAfter.exit_code,
            stdout_ref: executionAfter.stdout_ref,
            stderr_ref: executionAfter.stderr_ref,
            result_hash: executionAfter.result_hash,
            error_code: executionAfter.error_code,
            reconcile_required: executionAfter.reconcile_required ? 1 : 0,
            reconciled_at: executionAfter.reconciled_at,
            reconcile_evidence_ref: executionAfter.reconcile_evidence_ref,
            row_version: executionAfter.row_version,
            fencing_token: executionBefore.fencing_token,
            before_state: executionBefore.state,
            before_row_version: executionBefore.row_version,
          });
        if (executionUpdate.changes !== 1) {
          throw new Error("replay.execution_result_cas");
        }
        const planUpdate = tx
          .prepare(
            `UPDATE replay_plan SET state = :state, row_version = :row_version
              WHERE replay_plan_id = :replay_plan_id AND state = :before_state
                AND row_version = :before_row_version`,
          )
          .run({
            state: planAfter.state,
            row_version: planAfter.row_version,
            replay_plan_id: planAfter.replay_plan_id,
            before_state: planBefore.state,
            before_row_version: planBefore.row_version,
          });
        if (planUpdate.changes !== 1) {
          throw new Error("replay.plan_result_cas");
        }
      },
      operation,
    );
  }

  interface ObservedProcess {
    readonly outcome: ReplayProcessOutcome;
    readonly terminated: "deadline_exceeded" | null;
  }

  async function observeExecution(handle: ReplayProcessHandle): Promise<ObservedProcess> {
    let terminated: "deadline_exceeded" | null = null;
    let timer: NodeJS.Timeout | null = null;
    const waitPromise = handle.wait();
    const timeoutMs = deps.execution_timeout_ms;
    if (timeoutMs !== undefined) {
      const timeout = Promise.withResolvers<"timeout">();
      timer = setTimeout(() => {
        timeout.resolve("timeout");
      }, timeoutMs);
      const raced = await Promise.race([
        waitPromise.then((outcome) => ({ kind: "exit" as const, outcome })),
        timeout.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      if (raced.kind === "timeout") {
        terminated = "deadline_exceeded";
        try {
          handle.terminate();
        } catch {
          // The wait result below decides whether the group is confirmed gone.
        }
      }
    }

    let outcome: ReplayProcessOutcome | null = null;
    if (terminated === null) {
      outcome = await waitPromise;
    } else {
      const grace = Promise.withResolvers<null>();
      const graceTimer = setTimeout(() => {
        grace.resolve(null);
      }, graceMs);
      outcome = await Promise.race([waitPromise, grace.promise]);
      clearTimeout(graceTimer);
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (outcome === null) {
      outcome = {
        process_exited: false,
        exit_code: null,
        signal: null,
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        output_overflow: false,
      };
    }
    return { outcome, terminated };
  }

  /**
   * Classifies the observed process and writes the terminal execution+plan
   * pair. Runs only while holding the per-plan mutex, after the process wait.
   */
  function persistObservedResult(
    authorized: ReplayExecution,
    planRunning: ReplayPlan,
    planCreatedAt: number,
    observed: ObservedProcess,
  ): void {
    const outcome = observed.outcome;
    let state: "passed" | "failed" | "unknown" | "cancelled";
    let errorCode: string | null = null;
    if (!outcome.process_exited) {
      state = "unknown";
      errorCode =
        observed.terminated === "deadline_exceeded" ? "E_DEADLINE_EXCEEDED" : "execution_unknown";
    } else if (outcome.output_overflow) {
      state = "unknown";
      errorCode = "output_limit_exceeded";
    } else if (observed.terminated === "deadline_exceeded") {
      state = "failed";
      errorCode = "E_DEADLINE_EXCEEDED";
    } else if (outcome.exit_code === 0) {
      state = "passed";
    } else {
      state = "failed";
      if (outcome.exit_code === null) {
        errorCode = "process_signalled";
      }
    }

    let stdoutRef: SourceRef | null = null;
    let stderrRef: SourceRef | null = null;
    if (state === "passed" || state === "failed") {
      const stdout = blobRef(blob_store, outcome.stdout);
      const stderr = blobRef(blob_store, outcome.stderr);
      if (!stdout.ok || !stderr.ok) {
        state = "unknown";
        errorCode = "output_unavailable";
        stdoutRef = null;
        stderrRef = null;
      } else {
        stdoutRef = stdout.value;
        stderrRef = stderr.value;
      }
    }

    const endedAt = Math.max(now(), authorized.created_at);
    const submission = {
      expected_row_version: authorized.row_version,
      fencing_token: authorized.fencing_token,
      plan_hash: planRunning.plan_hash,
      state,
      ended_at: endedAt,
      exit_code: state === "unknown" ? null : outcome.exit_code,
      stdout_ref: stdoutRef,
      stderr_ref: stderrRef,
      explicit_empty_output: outcome.stdout.byteLength === 0 && outcome.stderr.byteLength === 0,
      error_code: errorCode,
    };
    const completed = completeReplayExecution(authorized, submission);
    if (!completed.ok) {
      deps.on_background_error?.(completed.error);
      return;
    }
    const planState = planStateForExecutionResult(completed.value.state);
    if (planState === null) {
      deps.on_background_error?.(new Error("replay result has no plan transition"));
      return;
    }
    const completedPlan = transitionReplayPlan(planRunning, planState);
    if (!completedPlan.ok) {
      deps.on_background_error?.(completedPlan.error);
      return;
    }
    const persisted = persistExecutionAndPlan(
      authorized,
      completed.value,
      planRunning,
      completedPlan.value,
      planCreatedAt,
      "replay_execute_result",
    );
    if (!persisted.ok) {
      deps.on_background_error?.(persisted.error);
    }
  }

  function persistAuthorizedTerminal(
    authorized: ReplayExecution,
    planRunning: ReplayPlan,
    planCreatedAt: number,
    state: "failed" | "unknown" | "cancelled",
    errorCode: string,
  ): Result<ReplayExecution, ErrorEnvelope> {
    const endedAt = Math.max(now(), authorized.created_at);
    const after = terminalExecution(authorized, state, endedAt, errorCode);
    const planState = planStateForExecutionResult(after.state);
    if (planState === null) {
      return err(internalError("kernel.replay_spawn_terminal_state"));
    }
    const planAfter = transitionReplayPlan(planRunning, planState);
    if (!planAfter.ok) {
      return planAfter;
    }
    const persisted = persistExecutionAndPlan(
      authorized,
      after,
      planRunning,
      planAfter.value,
      planCreatedAt,
      "replay_execute_spawn_result",
    );
    if (!persisted.ok) {
      return persisted;
    }
    return ok(after);
  }

  return async (context) => {
    const traceId = context.request_id;
    const startedMono = performance.now();
    const deadlineExpired = (): boolean =>
      context.deadline_ms - (performance.now() - startedMono) <= 0;
    if (context.signal.aborted) {
      return {
        ok: false,
        status: "degraded",
        error: makeIpcError("E_CANCELLED", { trace_id: traceId, method: "replay.execute" }),
      };
    }
    if (context.deadline_ms <= 0) {
      return {
        ok: false,
        status: "degraded",
        error: makeIpcError("E_DEADLINE_EXCEEDED", {
          trace_id: traceId,
          method: "replay.execute",
        }),
      };
    }
    const parsed = parseReplayExecuteRequest(context.params);
    if (!parsed.ok) {
      return parsed;
    }
    const request = parsed.value;

    return withPlanLock(request.replay_plan_id, async () => {
      // The request may have waited behind another execution on this plan.
      if (context.signal.aborted) {
        return {
          ok: false,
          status: "degraded",
          error: makeIpcError("E_CANCELLED", { trace_id: traceId, method: "replay.execute" }),
        };
      }
      if (deadlineExpired()) {
        return {
          ok: false,
          status: "degraded",
          error: makeIpcError("E_DEADLINE_EXCEEDED", {
            trace_id: traceId,
            method: "replay.execute",
          }),
        };
      }
      const planRead = readPlan(request.replay_plan_id);
      if (!planRead.ok) {
        return planRead;
      }
      if (planRead.value === null) {
        return { ok: false, status: "rejected", error: replayPlanNotFoundError() };
      }
      const plan = planRead.value;
      const planRowResult = connection
        .prepare<Row>("SELECT * FROM replay_plan WHERE replay_plan_id = :replay_plan_id")
        .get({ replay_plan_id: plan.replay_plan_id });
      if (planRowResult === undefined) {
        return { ok: false, status: "rejected", error: replayPlanNotFoundError() };
      }
      const planCreatedAt = asNumber(planRowResult, "created_at");

      if (
        request.expected_plan_hash !== plan.plan_hash ||
        !replayPlanHashMatches(plan)
      ) {
        return {
          ok: false,
          status: "rejected",
          error: replayPlanMismatchError(plan.replay_plan_id),
        };
      }

      // An authorized/running execution is the idempotent answer; it is
      // returned before any other check and never spawns a second process.
      const activeRead = findActiveExecution(plan.replay_plan_id);
      if (!activeRead.ok) {
        return activeRead;
      }
      if (activeRead.value !== null) {
        return { ok: true, status: "ok", value: activeRead.value };
      }
      if (hasUnreconciledUnknown(plan.replay_plan_id)) {
        return {
          ok: false,
          status: "rejected",
          error: replayExecutionReconcileRequiredError(plan.replay_plan_id),
        };
      }
      if (plan.state !== "planned" && plan.state !== "unverified") {
        return {
          ok: false,
          status: "rejected",
          error: replayPlanStateError(plan.replay_plan_id),
        };
      }

      const nowMs = now();
      let approval: ReplayApproval | null = null;
      if (plan.replay_class === "live_external") {
        if (request.approval_id === null) {
          return {
            ok: false,
            status: "rejected",
            error: replayApprovalMismatchError(plan.replay_plan_id),
          };
        }
        const approvalRead = readApproval(request.approval_id);
        if (!approvalRead.ok) {
          return approvalRead;
        }
        if (approvalRead.value === null) {
          return {
            ok: false,
            status: "rejected",
            error: replayApprovalNotFoundError(plan.replay_plan_id),
          };
        }
        approval = approvalRead.value;
        if (approval.state === "active" && approval.expires_at <= nowMs) {
          const expired = expireActiveApproval(approval, nowMs);
          if (!expired.ok) {
            return expired;
          }
          return {
            ok: false,
            status: "rejected",
            error: replayApprovalExpiredError(plan.replay_plan_id),
          };
        }
      } else if (request.approval_id !== null) {
        return {
          ok: false,
          status: "rejected",
          error: replayApprovalStateError(plan.replay_plan_id),
        };
      }

      // Re-run the authorization matrix over the persisted row. For automatic
      // classes a rejection is a plan/state failure. For `live_external` the
      // approval itself is checked by `consumeReplayApproval` below so that a
      // mismatch is reported as `E_REPLAY_APPROVAL_MISMATCH`, not as a plan
      // state error.
      const authorization = authorizeReplay({ plan, approval, now_ms: nowMs });
      if (!authorization.ok) {
        return authorization;
      }
      if (
        authorization.value.state === "rejected" &&
        plan.replay_class !== "live_external"
      ) {
        return {
          ok: false,
          status: "rejected",
          error: replayPlanStateError(plan.replay_plan_id),
        };
      }

      // The cwd must still resolve to the exact persisted path; a symlink
      // inserted after planning is an execution-scope change.
      let realCwd: string;
      try {
        realCwd = realpathSync(plan.cwd);
      } catch {
        return {
          ok: false,
          status: "rejected",
          error: replayPlanMismatchError(plan.replay_plan_id),
        };
      }
      if (realCwd !== plan.cwd) {
        return {
          ok: false,
          status: "rejected",
          error: replayPlanMismatchError(plan.replay_plan_id),
        };
      }

      const supported = spawner.supported_isolation;
      if (supported !== undefined && !supported.includes(plan.isolation.mechanism)) {
        return {
          ok: false,
          status: "rejected",
          error: internalError(
            `kernel.replay_isolation_unavailable:${plan.isolation.mechanism}`,
          ),
        };
      }
      // Network access must pass a controlled, auditable entry. The built-in
      // host spawner has no such entry unless a proxy is configured; an
      // injected spawner is trusted to own its egress policy.
      const hasControlledEgress =
        deps.egress_proxy !== undefined ||
        spawner.handles_egress === true ||
        deps.spawner !== undefined;
      if (plan.allowed_network && !hasControlledEgress) {
        return {
          ok: false,
          status: "rejected",
          error: internalError("kernel.replay_egress_proxy_unavailable"),
        };
      }

      const executionId = newId("rex", nowMs);
      const fencingToken = generateFencingToken();
      const created = createReplayExecution({
        execution_id: executionId,
        fencing_token: fencingToken,
        plan,
        approval,
        expected_plan_hash: request.expected_plan_hash,
        now_ms: nowMs,
        existing_execution: null,
        has_unreconciled_unknown: false,
        has_active_execution: false,
      });
      if (!created.ok) {
        return created;
      }
      if (created.value.kind !== "created") {
        return { ok: true, status: "ok", value: created.value.execution };
      }
      const createdExecution = created.value.execution;
      const consumedApproval = created.value.approval;
      const runningPlan = transitionReplayPlan(plan, "running");
      if (!runningPlan.ok) {
        return runningPlan;
      }

      // Frame order is fixed: approval consumed (live only) → execution
      // authorized → plan running. Append performs one fsync per frame.
      const frames: PendingFrame[] = [];
      if (consumedApproval !== null && approval !== null) {
        const approvalFrame = appendApprovalTransition(
          approval,
          consumedApproval,
          nowMs,
        );
        if (!approvalFrame.ok) {
          return approvalFrame;
        }
        frames.push(approvalFrame.value);
      }
      const executionFrame = appendJournalFrame(nowMs, {
        event_type: "replay.execution_recorded",
        entity_type: "replay_execution",
        entity_id: createdExecution.execution_id,
        operation: "insert",
        binding: plan.version_binding,
        row_schema: EXECUTION_ROW_SCHEMA,
        row: executionRow(createdExecution),
        before: null,
      });
      if (!executionFrame.ok) {
        return executionFrame;
      }
      frames.push(executionFrame.value);
      const planFrame = appendJournalFrame(nowMs, {
        event_type: "replay.plan_transition",
        entity_type: "replay_plan",
        entity_id: runningPlan.value.replay_plan_id,
        operation: "transition",
        binding: plan.version_binding,
        row_schema: PLAN_ROW_SCHEMA,
        row: planRow(runningPlan.value, planCreatedAt),
        before: planRow(plan, planCreatedAt),
      });
      if (!planFrame.ok) {
        return planFrame;
      }
      frames.push(planFrame.value);

      const projected = commitFrames(
        frames,
        (tx) => {
          if (consumedApproval !== null && approval !== null) {
            const approvalUpdate = tx
              .prepare(
                `UPDATE replay_approval SET
                   state = :state, consumed_at = :consumed_at,
                   consumed_execution_id = :consumed_execution_id,
                   row_version = :row_version
                 WHERE approval_id = :approval_id AND approval_hash = :approval_hash
                   AND state = 'active' AND expires_at > :now_ms
                   AND row_version = :before_row_version`,
              )
              .run({
                state: consumedApproval.state,
                consumed_at: consumedApproval.consumed_at,
                consumed_execution_id: consumedApproval.consumed_execution_id,
                row_version: consumedApproval.row_version,
                approval_id: consumedApproval.approval_id,
                approval_hash: approval.approval_hash,
                now_ms: nowMs,
                before_row_version: approval.row_version,
              });
            if (approvalUpdate.changes !== 1) {
              throw new Error("replay.approval_consume_cas");
            }
          }
          tx.prepare(
            `INSERT INTO replay_execution (
               execution_id, replay_plan_id, approval_id, state, fencing_token,
               reconcile_required, reconciled_at, reconcile_evidence_ref, started_at,
               ended_at, exit_code, stdout_ref, stderr_ref, result_hash, error_code,
               row_version, created_at
             ) VALUES (
               :execution_id, :replay_plan_id, :approval_id, :state, :fencing_token,
               :reconcile_required, :reconciled_at, :reconcile_evidence_ref, :started_at,
               :ended_at, :exit_code, :stdout_ref, :stderr_ref, :result_hash, :error_code,
               :row_version, :created_at
             )`,
          ).run(sqlParams(executionRow(createdExecution)));
          const planUpdate = tx
            .prepare(
              `UPDATE replay_plan SET state = :state, row_version = :row_version
                WHERE replay_plan_id = :replay_plan_id AND state = :before_state
                  AND row_version = :before_row_version`,
            )
            .run({
              state: runningPlan.value.state,
              row_version: runningPlan.value.row_version,
              replay_plan_id: runningPlan.value.replay_plan_id,
              before_state: plan.state,
              before_row_version: plan.row_version,
            });
          if (planUpdate.changes !== 1) {
            throw new Error("replay.plan_running_cas");
          }
        },
        "replay_execute_commit",
      );
      if (!projected.ok) {
        return projected;
      }

      const authorized = createdExecution;

      // A deadline/cancel that lands after the durable commit but before
      // spawn must not start a process. The execution stays authorized on
      // disk; persist an explicit unknown fence instead of claiming running.
      if (context.signal.aborted || deadlineExpired()) {
        const state = context.signal.aborted ? "cancelled" : "unknown";
        const code = context.signal.aborted ? "cancelled" : "E_DEADLINE_EXCEEDED";
        const terminal = persistAuthorizedTerminal(
          authorized,
          runningPlan.value,
          planCreatedAt,
          state,
          code,
        );
        if (!terminal.ok) {
          return terminal;
        }
        return { ok: true, status: "ok", value: terminal.value };
      }

      const spawnRequest: ReplaySpawnRequest = {
        execution_id: authorized.execution_id,
        replay_plan_id: plan.replay_plan_id,
        fencing_token: authorized.fencing_token,
        replay_class: plan.replay_class,
        command: plan.command,
        cwd: plan.cwd,
        isolation: plan.isolation,
        allowed_network: plan.allowed_network,
        network_target: plan.network_target,
        egress_proxy: deps.egress_proxy ?? null,
      };

      let handleResult: Result<ReplayProcessHandle, ErrorEnvelope>;
      let spawnUncertain = false;
      try {
        handleResult = await spawner.spawn(spawnRequest);
      } catch {
        spawnUncertain = true;
        handleResult = err(internalError("kernel.replay_spawn_result_unknown"));
      }
      if (!handleResult.ok) {
        // A returned error means the spawner confirmed that no process was
        // created; a thrown spawn is uncertain and must leave a reconcile
        // fence rather than a fabricated `failed`.
        const terminalState = spawnUncertain ? "unknown" : "failed";
        const terminalCode = spawnUncertain
          ? "spawn_result_unknown"
          : handleResult.error.code;
        const terminal = persistAuthorizedTerminal(
          authorized,
          runningPlan.value,
          planCreatedAt,
          terminalState,
          terminalCode,
        );
        if (!terminal.ok) {
          return terminal;
        }
        return { ok: true, status: "ok", value: terminal.value };
      }

      const handle = handleResult.value;
      if (context.signal.aborted || deadlineExpired()) {
        terminateQuietly(handle);
        const state = context.signal.aborted ? "cancelled" : "unknown";
        const code = context.signal.aborted ? "cancelled" : "E_DEADLINE_EXCEEDED";
        const terminal = persistAuthorizedTerminal(
          authorized,
          runningPlan.value,
          planCreatedAt,
          state,
          code,
        );
        if (!terminal.ok) {
          return terminal;
        }
        return { ok: true, status: "ok", value: terminal.value };
      }

      // `authorized → running` is durable before the handler answers.
      const startedAt = Math.max(now(), authorized.created_at);
      const running = startReplayExecution(authorized, startedAt);
      if (!running.ok) {
        terminateQuietly(handle);
        return running;
      }
      const runningFrame = appendJournalFrame(now(), {
        event_type: "replay.execution_transition",
        entity_type: "replay_execution",
        entity_id: running.value.execution_id,
        operation: "transition",
        binding: plan.version_binding,
        row_schema: EXECUTION_ROW_SCHEMA,
        row: executionRow(running.value),
        before: executionRow(authorized),
      });
      if (!runningFrame.ok) {
        terminateQuietly(handle);
        return runningFrame;
      }
      const runningPersisted = commitFrames(
        [runningFrame.value],
        (tx) => {
          const update = tx
            .prepare(
              `UPDATE replay_execution SET
                 state = :state, started_at = :started_at, row_version = :row_version
               WHERE execution_id = :execution_id AND fencing_token = :fencing_token
                 AND state = 'authorized' AND row_version = :before_row_version`,
            )
            .run({
              state: running.value.state,
              started_at: running.value.started_at,
              row_version: running.value.row_version,
              execution_id: running.value.execution_id,
              fencing_token: authorized.fencing_token,
              before_row_version: authorized.row_version,
            });
          if (update.changes !== 1) {
            throw new Error("replay.execution_running_cas");
          }
        },
        "replay_execute_running",
      );
      if (!runningPersisted.ok) {
        terminateQuietly(handle);
        return runningPersisted;
      }

      // Wait outside the per-plan mutex: a second execute must be able to
      // observe and return the existing running row while the process runs.
      const task = (async () => {
        try {
          const observed = await observeExecution(handle);
          await withPlanLock(plan.replay_plan_id, async () => {
            persistObservedResult(
              running.value,
              runningPlan.value,
              planCreatedAt,
              observed,
            );
          });
        } catch (error) {
          deps.on_background_error?.(error);
          deps.on_degraded?.("replay_execute_background_failed");
        }
      })();
      if (deps.on_background_task !== undefined) {
        deps.on_background_task(task);
      } else {
        void task;
      }
      return { ok: true, status: "ok", value: running.value };
    });
  };
}
