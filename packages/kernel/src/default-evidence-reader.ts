/**
 * Default FND-side evidence read ports (DD-FND-59.1.6.2, DD-EVD-024).
 *
 * One reader object serves the four consumers that need durable EVD rows:
 *
 * - `EvdStateReadPort` for the aggregator: the aggregate snapshot is read in a
 *   single `BEGIN DEFERRED` transaction with the row order the design fixes,
 *   and the accepted aggregate read returns the exact canonical bytes.
 * - `EnvelopeObjectReadPort` for the reducer: `JudgeEnvelope/2 | /3` content is
 *   resolved through the row's `content_ref` and verified byte for byte.
 * - `GatewayLateStore` for the judge gateway: attempts and late results are
 *   read by exact key; `commitLate` is forwarded to the real EVD writer so the
 *   reader never opens a second persistence path.
 * - `next_attempt_no` for the gateway: the next number is `max(attempt_no)+1`
 *   inside the same binding, allocated by the database rather than memory.
 *
 * The reader never runs reducers, never writes rows, never mints defaults and
 * never returns a partial snapshot. Missing required rows are an explicit
 * typed error; a missing optional row is `null` or an empty array.
 */

import {
  canonicalJsonText,
  err,
  hashBytes,
  isHash,
  makeErrorEnvelope,
  ok,
  parseSourceRef,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type JsonValue,
  type Result,
  type SourceRef,
  type VersionBinding,
} from "@evoplug/core";
import {
  evdError,
  evdForwardedError,
  evidencePackHash,
  type EnvelopeObjectReadPort,
  type EvdAcceptedAggregateRead,
  type EvdAggregateInputs,
  type EvdAggregateRow,
  type EvdAttemptRow,
  type EvdContentMeta,
  type EvdEnvelopeRow,
  type EvdEvidencePackRow,
  type EvdLateResultRow,
  type EvdOmissionRow,
  type EvdRequestBindingRow,
  type EvdShardPlanRow,
  type EvdShardRow,
  type EvdStateReadPort,
  type EvdStateWritePort,
  type EvdValidatorBindingRow,
  type EvidencePack,
  type GatewayLateStore,
  type JudgeAttempt,
  type JudgeAttemptV2,
  type JudgeEnvelopeV3,
  type LateJudgeResultV2,
  type LiveCommitOutcome,
} from "@evoplug/evidence";
import {
  mapSqliteFailure,
  type SqlRow,
  type SqliteConnection,
} from "@evoplug/storage";

/** The slice of the blob store the reader needs; `BlobStore` satisfies it. */
export interface EvidenceReadBlobSource {
  read(hash: Hash): Result<Uint8Array, ErrorEnvelope>;
}

export interface DefaultEvidenceReaderDeps {
  /** The writer connection; used only when no read connection is supplied. */
  readonly connection: SqliteConnection;
  /**
   * The independent read-only connection the design requires. When absent the
   * reads fall back to `connection`, which is only correct while no write is in
   * flight.
   */
  readonly read_connection?: SqliteConnection;
  /** Content-addressed blob store that resolves `content_ref` rows. */
  readonly blobs: EvidenceReadBlobSource;
  /**
   * The real EVD writer. `commitLate` is forwarded unchanged so the reader
   * owns no persistence path of its own.
   */
  readonly writer: Pick<EvdStateWritePort, "commitLate">;
}

export interface DefaultEvidenceReader
  extends EvdStateReadPort,
    EnvelopeObjectReadPort,
    GatewayLateStore {
  next_attempt_no(binding_id: string): number;
}

/* ------------------------------------------------------------------ */
/* Typed read failures                                                 */
/* ------------------------------------------------------------------ */

class ReadFailure extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.code);
    this.name = "ReadFailure";
    this.envelope = envelope;
  }
}

function fail(envelope: ErrorEnvelope): never {
  throw new ReadFailure(envelope);
}

function stateRowError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STATE_ROW_SCHEMA",
    category: "schema",
    retryable: false,
    side_effect: "none",
    message_key: "error.state_row.schema",
    stage: "state_row_read",
    details: { kind: "field", path, rule },
  });
}

function bindingError(field: string, expected: string, actual: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_VERSION_BINDING",
    category: "version",
    retryable: false,
    side_effect: "none",
    message_key: "error.version.binding",
    stage: "binding",
    details: { kind: "version", expected, actual },
  });
}

function contentError(
  contentRef: SourceRef,
  expected: string,
  actual: string
): ErrorEnvelope {
  return evdError("E_CONTENT_HASH_MISMATCH", {
    content_ref: contentRef,
    expected,
    actual,
  });
}

function incomplete(
  reason: string,
  shardPlanKey: Hash,
  shardKey = ""
): ErrorEnvelope {
  return evdError("E_AGGREGATE_BINDING_INCOMPLETE", {
    reason,
    shard_plan_key: shardPlanKey,
    shard_key: shardKey,
  });
}

function withReadFailure<T>(
  stage: string,
  read: () => T
): Result<T, ErrorEnvelope> {
  try {
    return ok(read());
  } catch (error: unknown) {
    if (error instanceof ReadFailure) {
      return err(error.envelope);
    }
    return err(mapSqliteFailure(error, stage, "read"));
  }
}

/**
 * Runs `read` in one `BEGIN DEFERRED` transaction. The callback is synchronous
 * so no other write can interleave between the statements of the snapshot.
 */
function withReadTransaction<T>(
  connection: SqliteConnection,
  stage: string,
  read: () => T
): Result<T, ErrorEnvelope> {
  let began = false;
  try {
    connection.exec("BEGIN DEFERRED");
    began = true;
    const value = read();
    connection.exec("COMMIT");
    return ok(value);
  } catch (error: unknown) {
    if (began) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    if (error instanceof ReadFailure) {
      return err(error.envelope);
    }
    return err(mapSqliteFailure(error, stage, "read"));
  }
}

/* ------------------------------------------------------------------ */
/* Row decoding                                                        */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    fail(stateRowError(key, "string_required"));
  }
  return value;
}

function numberField(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(stateRowError(key, "safe_integer_required"));
  }
  return value;
}

function booleanField(row: SqlRow, key: string): boolean {
  const value = numberField(row, key);
  if (value !== 0 && value !== 1) {
    fail(stateRowError(key, "boolean_integer_required"));
  }
  return value === 1;
}

function nullableStringField(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    fail(stateRowError(key, "nullable_string_required"));
  }
  return value;
}

function nullableNumberField(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(stateRowError(key, "nullable_safe_integer_required"));
  }
  return value;
}

function nullableIdField(row: SqlRow, key: string): Id | null {
  const value = nullableStringField(row, key);
  if (value === null) {
    return null;
  }
  if (value.length === 0) {
    fail(stateRowError(key, "non_empty_id"));
  }
  return value as Id;
}

function nullableHashField(row: SqlRow, key: string): Hash | null {
  const value = nullableStringField(row, key);
  if (value === null) {
    return null;
  }
  if (!isHash(value)) {
    fail(stateRowError(key, "sha256_full_hash"));
  }
  return value;
}

function hashField(row: SqlRow, key: string): Hash {
  const value = stringField(row, key);
  if (!isHash(value)) {
    fail(stateRowError(key, "sha256_full_hash"));
  }
  return value;
}

function idField(row: SqlRow, key: string): Id {
  const value = stringField(row, key);
  if (value.length === 0) {
    fail(stateRowError(key, "non_empty_id"));
  }
  return value as Id;
}

function sourceRefField(row: SqlRow, key: string): SourceRef {
  const value = stringField(row, key);
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    fail(parsed.error);
  }
  return parsed.value.source_ref;
}

function jsonArrayField(row: SqlRow, key: string): unknown[] {
  const text = stringField(row, key);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail(stateRowError(key, "json_array"));
  }
  if (!Array.isArray(decoded)) {
    fail(stateRowError(key, "json_array"));
  }
  return decoded;
}

function stringArrayField(row: SqlRow, key: string): string[] {
  const values: string[] = [];
  for (const entry of jsonArrayField(row, key)) {
    if (typeof entry !== "string") {
      fail(stateRowError(key, "string_array"));
    }
    values.push(entry);
  }
  return values;
}

function sourceRefArrayField(row: SqlRow, key: string): SourceRef[] {
  const values: SourceRef[] = [];
  for (const entry of stringArrayField(row, key)) {
    const parsed = parseSourceRef(entry);
    if (!parsed.ok) {
      fail(parsed.error);
    }
    values.push(parsed.value.source_ref);
  }
  return values;
}

function jsonObjectField(row: SqlRow, key: string): Record<string, unknown> {
  const text = stringField(row, key);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail(stateRowError(key, "json_object"));
  }
  if (!isRecord(decoded)) {
    fail(stateRowError(key, "json_object"));
  }
  return decoded;
}

function schemaVersionOf(value: unknown, path: string): string {
  if (!isRecord(value) || typeof value["schema_version"] !== "string") {
    fail(stateRowError(path, "schema_version_required"));
  }
  return value["schema_version"];
}

function bindingOf(row: SqlRow): VersionBinding {
  return {
    task_id: idField(row, "task_id") as VersionBinding["task_id"],
    branch_id: idField(row, "branch_id") as VersionBinding["branch_id"],
    input_epoch: numberField(row, "input_epoch"),
    goal_version: stringField(row, "goal_version"),
    config_version: stringField(row, "config_version"),
    watermark: numberField(row, "watermark"),
  };
}

function sameBinding(left: VersionBinding, right: VersionBinding): boolean {
  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version &&
    left.watermark === right.watermark
  );
}

function assertBinding(
  row: SqlRow,
  expected: VersionBinding,
  field: string
): void {
  const persisted = bindingOf(row);
  if (!sameBinding(persisted, expected)) {
    fail(bindingError(field, JSON.stringify(expected), JSON.stringify(persisted)));
  }
}

function auditOf(row: SqlRow): { row_version: number; created_at: number } {
  return {
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
  };
}

interface ContentMetaRow extends EvdContentMeta {
  readonly content_hash: Hash;
  readonly content_ref: SourceRef;
  readonly content_bytes: number;
}

function contentMetaOf(row: SqlRow): ContentMetaRow {
  return {
    content_hash: hashField(row, "content_hash"),
    content_ref: sourceRefField(row, "content_ref"),
    content_bytes: numberField(row, "content_bytes"),
    source_blob_refs: sourceRefArrayField(row, "source_blob_refs"),
  };
}

function decodeContent(
  blobs: EvidenceReadBlobSource,
  meta: ContentMetaRow
): unknown {
  const parsedRef = parseSourceRef(meta.content_ref);
  if (!parsedRef.ok) {
    fail(parsedRef.error);
  }
  if (parsedRef.value.scheme !== "blob") {
    fail(stateRowError("content_ref", "blob_scheme"));
  }
  if (
    parsedRef.value.start !== 0 ||
    parsedRef.value.end !== meta.content_bytes
  ) {
    fail(
      contentError(
        meta.content_ref,
        `bytes=0-${String(meta.content_bytes)}`,
        `bytes=${String(parsedRef.value.start)}-${String(parsedRef.value.end)}`
      )
    );
  }
  const locator = parsedRef.value.locator;
  if (!isHash(locator)) {
    fail(stateRowError("content_ref.locator", "sha256_full_hash"));
  }
  const read = blobs.read(locator);
  if (!read.ok) {
    fail(read.error);
  }
  const bytes = read.value;
  if (bytes.byteLength !== meta.content_bytes) {
    fail(
      contentError(
        meta.content_ref,
        String(meta.content_bytes),
        String(bytes.byteLength)
      )
    );
  }
  const recomputed = hashBytes(bytes);
  if (recomputed !== meta.content_hash) {
    fail(contentError(meta.content_ref, recomputed, meta.content_hash));
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(stateRowError("content_ref", "utf8"));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail(stateRowError("content_ref", "json"));
  }
  let canonical: string;
  try {
    canonical = canonicalJsonText(decoded as JsonValue);
  } catch {
    fail(stateRowError("content_ref", "json_value"));
  }
  if (canonical !== text) {
    fail(stateRowError("content_ref", "canonical_json"));
  }
  return decoded;
}

/* ------------------------------------------------------------------ */
/* SQL helpers                                                         */
/* ------------------------------------------------------------------ */

function oneRow(
  connection: SqliteConnection,
  sql: string,
  params: Readonly<Record<string, string | number | null>>
): SqlRow | null {
  const row = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row;
}

function allRows(
  connection: SqliteConnection,
  sql: string,
  params: Readonly<Record<string, string | number | null>>
): SqlRow[] {
  return connection.prepare<SqlRow>(sql).all(params);
}

/* ------------------------------------------------------------------ */
/* Row constructors                                                    */
/* ------------------------------------------------------------------ */

function packRowOf(row: SqlRow): EvdEvidencePackRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    ...contentMetaOf(row),
    pack_id: idField(row, "pack_id"),
    pack_key: hashField(row, "pack_key"),
    pack_hash: hashField(row, "pack_hash"),
    evidence_hash: hashField(row, "evidence_hash"),
    plan_id: idField(row, "plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    issue_id: idField(row, "issue_id"),
    issue_key: stringField(row, "issue_key"),
    pack_state: packStateOf(row),
  };
}

function packStateOf(row: SqlRow): EvdEvidencePackRow["pack_state"] {
  const value = stringField(row, "pack_state");
  if (value !== "valid" && value !== "invalidated") {
    fail(stateRowError("pack_state", "valid_or_invalidated"));
  }
  return value;
}

function shardPlanRowOf(row: SqlRow): EvdShardPlanRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    ...contentMetaOf(row),
    shard_plan_id: idField(row, "shard_plan_id"),
    shard_plan_key: hashField(row, "shard_plan_key"),
    shard_plan_hash: hashField(row, "shard_plan_hash"),
    plan_id: idField(row, "plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    issue_id: idField(row, "issue_id"),
    pack_id: idField(row, "pack_id"),
    pack_key: hashField(row, "pack_key"),
    service_profile_id: idField(row, "service_profile_id"),
    service_profile_key: hashField(row, "service_profile_key"),
    state: shardPlanStateOf(row),
  };
}

function shardPlanStateOf(row: SqlRow): EvdShardPlanRow["state"] {
  const value = stringField(row, "state");
  if (
    value !== "planned" &&
    value !== "partially_rejected" &&
    value !== "bound" &&
    value !== "dispatched" &&
    value !== "completed" &&
    value !== "rejected"
  ) {
    fail(stateRowError("state", "shard_plan_state"));
  }
  return value;
}

const SHARD_STATUSES: readonly EvdShardRow["status"][] = [
  "planned",
  "deterministic_skip",
  "budget_rejected",
  "projection_rejected",
  "bound",
  "sent",
  "accepted",
  "degraded",
  "unknown",
  "cancelled",
];

function shardStatusOf(row: SqlRow): EvdShardRow["status"] {
  const value = stringField(row, "status");
  for (const allowed of SHARD_STATUSES) {
    if (value === allowed) {
      return allowed;
    }
  }
  fail(stateRowError("status", "shard_status"));
}

function shardRowOf(row: SqlRow): EvdShardRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    shard_id: idField(row, "shard_id"),
    shard_plan_id: idField(row, "shard_plan_id"),
    shard_plan_key: hashField(row, "shard_plan_key"),
    shard_key: hashField(row, "shard_key"),
    shard_order: numberField(row, "shard_order"),
    status: shardStatusOf(row),
    request_binding_id: nullableIdField(row, "request_binding_id"),
    attempt_ids: stringArrayField(row, "attempt_ids") as Id[],
    envelope_keys: stringArrayField(row, "envelope_keys") as Hash[],
    reason_codes: stringArrayField(row, "reason_codes"),
    body_json: jsonObjectField(row, "body_json") as unknown as EvdShardRow["body_json"],
  };
}

function requestBindingRowOf(row: SqlRow): EvdRequestBindingRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    ...contentMetaOf(row),
    binding_id: idField(row, "binding_id"),
    request_hash: hashField(row, "request_hash"),
    dispatch_key: hashField(row, "dispatch_key"),
    plan_id: idField(row, "plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    shard_id: idField(row, "shard_id"),
    shard_key: hashField(row, "shard_key"),
    shard_plan_id: idField(row, "shard_plan_id"),
    shard_plan_key: hashField(row, "shard_plan_key"),
    service_profile_key: hashField(row, "service_profile_key"),
    validator_binding_key: hashField(row, "validator_binding_key"),
    state_hash: hashField(row, "state_hash"),
    state_content_hash: hashField(row, "state_content_hash"),
    questions_hash: hashField(row, "questions_hash"),
    template_bindings_digest: hashField(row, "template_bindings_digest"),
    question_bindings_digest: hashField(row, "question_bindings_digest"),
    proposition_bindings_digest: hashField(row, "proposition_bindings_digest"),
  };
}

const ATTEMPT_STATES: readonly EvdAttemptRow["state"][] = [
  "prepared",
  "sending",
  "response_received",
  "accepted",
  "degraded",
  "transport_error",
  "timeout",
  "outcome_unknown",
  "cancelled",
];

function attemptStateOf(row: SqlRow): EvdAttemptRow["state"] {
  const value = stringField(row, "state");
  for (const allowed of ATTEMPT_STATES) {
    if (value === allowed) {
      return allowed;
    }
  }
  fail(stateRowError("state", "attempt_state"));
}

function attemptRowOf(row: SqlRow): EvdAttemptRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    attempt_id: idField(row, "attempt_id"),
    attempt_key: hashField(row, "attempt_key"),
    binding_id: idField(row, "binding_id"),
    request_id: idField(row, "request_id"),
    dispatch_key: hashField(row, "dispatch_key"),
    attempt_no: numberField(row, "attempt_no"),
    state: attemptStateOf(row),
    http_status: nullableNumberField(row, "http_status"),
    error_code: nullableStringField(row, "error_code"),
    response_envelope_id: nullableIdField(row, "response_envelope_id"),
    late_result_id: nullableIdField(row, "late_result_id"),
    body_json: jsonObjectField(row, "body_json") as unknown as
      | JudgeAttempt
      | JudgeAttemptV2,
  };
}

function envelopeRowOf(row: SqlRow): EvdEnvelopeRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    ...contentMetaOf(row),
    envelope_id: idField(row, "envelope_id"),
    envelope_key: hashField(row, "envelope_key"),
    binding_id: idField(row, "binding_id"),
    attempt_id: idField(row, "attempt_id"),
    request_hash: hashField(row, "request_hash"),
    dispatch_key: hashField(row, "dispatch_key"),
    shard_id: idField(row, "shard_id"),
    shard_key: hashField(row, "shard_key"),
    validation_status: validationStatusOf(row),
    received_at: numberField(row, "received_at"),
  };
}

function validationStatusOf(row: SqlRow): EvdEnvelopeRow["validation_status"] {
  const value = stringField(row, "validation_status");
  if (value !== "accepted" && value !== "degraded") {
    fail(stateRowError("validation_status", "accepted_or_degraded"));
  }
  return value;
}

function lateResultRowOf(row: SqlRow): EvdLateResultRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    ...contentMetaOf(row),
    late_result_id: idField(row, "late_result_id"),
    late_result_key: hashField(row, "late_result_key"),
    attempt_id: idField(row, "attempt_id"),
    envelope_key: nullableHashField(row, "envelope_key"),
    disposition: dispositionOf(row),
    received_at: numberField(row, "received_at"),
  };
}

function dispositionOf(row: SqlRow): EvdLateResultRow["disposition"] {
  const value = stringField(row, "disposition");
  if (value !== "appended_history" && value !== "conflict_rejected") {
    fail(stateRowError("disposition", "durable_late_disposition"));
  }
  return value;
}

function omissionRowOf(row: SqlRow): EvdOmissionRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    ...contentMetaOf(row),
    omission_id: idField(row, "omission_id"),
    omission_key: hashField(row, "omission_key"),
    shard_plan_id: idField(row, "shard_plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    shard_id: nullableIdField(row, "shard_id"),
    question_keys: stringArrayField(row, "question_keys"),
    unit_keys: stringArrayField(row, "unit_keys") as Hash[],
    impact: omissionImpactOf(row),
    reason: omissionReasonOf(row),
    required_for_issue: booleanField(row, "required_for_issue"),
    recoverable: booleanField(row, "recoverable"),
  };
}

function omissionImpactOf(row: SqlRow): EvdOmissionRow["impact"] {
  const value = stringField(row, "impact");
  if (value !== "none" && value !== "may_change_answer" && value !== "blocking") {
    fail(stateRowError("impact", "omission_impact"));
  }
  return value;
}

function omissionReasonOf(row: SqlRow): EvdOmissionRow["reason"] {
  const value = stringField(row, "reason");
  const allowed: readonly EvdOmissionRow["reason"][] = [
    "not_required",
    "deterministic_skip",
    "dedup_same_content",
    "budget_context",
    "budget_exceeds",
    "limits_unknown",
    "outside_scope",
    "unretrievable",
    "template_filtered",
    "retrieval_gap",
  ];
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  fail(stateRowError("reason", "omission_reason"));
}

function aggregateRowOf(row: SqlRow): EvdAggregateRow {
  return {
    ...bindingOf(row),
    ...auditOf(row),
    ...contentMetaOf(row),
    aggregate_id: idField(row, "aggregate_id"),
    aggregate_key: hashField(row, "aggregate_key"),
    aggregate_hash: hashField(row, "aggregate_hash"),
    plan_hash: hashField(row, "plan_hash"),
    shard_plan_key: hashField(row, "shard_plan_key"),
    final_state: finalStateOf(row),
    final_basis: finalBasisOf(row),
    coverage_complete: booleanField(row, "coverage_complete"),
    supersedes_aggregate_id: nullableIdField(row, "supersedes_aggregate_id"),
  };
}

const FINAL_STATES: readonly EvdAggregateRow["final_state"][] = [
  "consistent",
  "inconsistent",
  "unknown",
  "abstain",
  "needs_evidence",
];

function finalStateOf(row: SqlRow): EvdAggregateRow["final_state"] {
  const value = stringField(row, "final_state");
  for (const allowed of FINAL_STATES) {
    if (value === allowed) {
      return allowed;
    }
  }
  fail(stateRowError("final_state", "final_state"));
}

function finalBasisOf(row: SqlRow): EvdAggregateRow["final_basis"] {
  const value = nullableStringField(row, "final_basis");
  if (value === null) {
    return null;
  }
  if (value !== "hard_fact" && value !== "semantic_shadow" && value !== "mixed") {
    fail(stateRowError("final_basis", "final_basis"));
  }
  return value;
}

function validatorBindingRowOf(row: SqlRow): EvdValidatorBindingRow {
  return {
    ...auditOf(row),
    validator_binding_id: idField(row, "validator_binding_id"),
    validator_binding_key: hashField(row, "validator_binding_key"),
    validator_policy_hash: hashField(row, "validator_policy_hash"),
    service_profile_key: hashField(row, "service_profile_key"),
    body_json: jsonObjectField(row, "body_json") as unknown as
      | EvdValidatorBindingRow["body_json"]
      | never,
  } as EvdValidatorBindingRow;
}

/* ------------------------------------------------------------------ */
/* Content verification helpers                                        */
/* ------------------------------------------------------------------ */

function recomputePackHash(pack: EvidencePack): Hash {
  return evidencePackHash({
    plan_hash: pack.plan_hash,
    question_keys: pack.question_keys,
    compiler_version: pack.compiler_version,
    counting_method_version: pack.counting_method_version,
    source_manifest_version: pack.source_manifest_version,
    issue_key: pack.issue_key,
    binding: {
      task_id: pack.task_id as VersionBinding["task_id"],
      branch_id: pack.branch_id as VersionBinding["branch_id"],
      input_epoch: pack.input_epoch,
      goal_version: pack.goal_version,
      config_version: pack.config_version,
      watermark: pack.watermark,
    },
    evidence_hash: pack.evidence_hash,
  });
}

function packContentOf(
  blobs: EvidenceReadBlobSource,
  row: EvdEvidencePackRow
): EvidencePack {
  const decoded = decodeContent(blobs, {
    content_hash: row.content_hash,
    content_ref: row.content_ref,
    content_bytes: row.content_bytes,
    source_blob_refs: row.source_blob_refs,
  });
  const schema = schemaVersionOf(decoded, "pack.schema_version");
  if (schema === "rsi.evidence_pack/1") {
    fail(evdError("E_EVIDENCE_PACK_V1_READ_ONLY", { schema_version: schema }));
  }
  if (schema !== "rsi.evidence_pack/2") {
    fail(stateRowError("pack.schema_version", "rsi.evidence_pack/2"));
  }
  const pack = decoded as EvidencePack;
  if (!isRecord(pack) || !Array.isArray(pack.question_keys)) {
    fail(stateRowError("pack.question_keys", "string_array"));
  }
  for (const key of pack.question_keys) {
    if (typeof key !== "string") {
      fail(stateRowError("pack.question_keys", "string_array"));
    }
  }
  for (const field of [
    "plan_hash",
    "evidence_hash",
    "pack_key",
    "pack_hash",
  ] as const) {
    if (!isHash(pack[field])) {
      fail(stateRowError(`pack.${field}`, "sha256_full_hash"));
    }
  }
  for (const field of [
    "compiler_version",
    "counting_method_version",
    "source_manifest_version",
    "issue_key",
    "goal_version",
    "config_version",
  ] as const) {
    if (typeof pack[field] !== "string") {
      fail(stateRowError(`pack.${field}`, "string"));
    }
  }
  if (
    typeof pack.input_epoch !== "number" ||
    typeof pack.watermark !== "number" ||
    typeof pack.task_id !== "string" ||
    typeof pack.branch_id !== "string"
  ) {
    fail(stateRowError("pack.binding", "complete"));
  }
  if (pack.pack_id !== row.pack_id) {
    fail(stateRowError("pack.pack_id", "row_matches_content"));
  }
  if (pack.pack_key !== row.pack_key) {
    fail(stateRowError("pack.pack_key", "row_matches_content"));
  }
  return pack;
}

function uniqueValidatorKey(
  bindings: readonly EvdRequestBindingRow[],
  shardPlanKey: Hash
): Hash {
  if (bindings.length === 0) {
    fail(incomplete("validator_binding_key_missing", shardPlanKey));
  }
  const first = bindings[0];
  if (first === undefined) {
    fail(incomplete("validator_binding_key_missing", shardPlanKey));
  }
  for (const binding of bindings) {
    if (binding.validator_binding_key !== first.validator_binding_key) {
      fail(incomplete("validator_binding_key_not_unique", shardPlanKey));
    }
  }
  return first.validator_binding_key;
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createDefaultEvidenceReader(
  deps: DefaultEvidenceReaderDeps
): DefaultEvidenceReader {
  const { connection, blobs, writer } = deps;
  const readConnection = deps.read_connection ?? connection;

  function readAggregateSnapshot(q: {
    binding: VersionBinding;
    shard_plan_key: Hash;
  }): Result<EvdAggregateInputs, ErrorEnvelope> {
    return withReadTransaction(readConnection, "aggregate_snapshot_read", () => {
      const planRaw = oneRow(
        readConnection,
        `SELECT * FROM evd_shard_plan WHERE shard_plan_key = :shard_plan_key`,
        { shard_plan_key: q.shard_plan_key }
      );
      if (planRaw === null) {
        fail(incomplete("E_AGGREGATE_SHARD_PLAN_MISSING", q.shard_plan_key));
      }
      const duplicates = allRows(
        readConnection,
        `SELECT shard_plan_id FROM evd_shard_plan WHERE shard_plan_key = :shard_plan_key`,
        { shard_plan_key: q.shard_plan_key }
      );
      if (duplicates.length !== 1) {
        fail(incomplete("E_AGGREGATE_SHARD_PLAN_NOT_UNIQUE", q.shard_plan_key));
      }
      assertBinding(planRaw, q.binding, "shard_plan.binding");
      const shardPlan = shardPlanRowOf(planRaw);
      if (shardPlan.shard_plan_key !== q.shard_plan_key) {
        fail(incomplete("E_AGGREGATE_SHARD_PLAN_KEY_MISMATCH", q.shard_plan_key));
      }

      const packRaw = oneRow(
        readConnection,
        `SELECT * FROM evd_evidence_pack WHERE pack_id = :pack_id`,
        { pack_id: shardPlan.pack_id }
      );
      if (packRaw === null) {
        fail(incomplete("E_AGGREGATE_PACK_MISSING", q.shard_plan_key));
      }
      assertBinding(packRaw, q.binding, "pack.binding");
      const pack = packRowOf(packRaw);
      if (pack.pack_id !== shardPlan.pack_id) {
        fail(incomplete("E_AGGREGATE_PACK_KEY_MISMATCH", q.shard_plan_key));
      }
      if (pack.pack_key !== shardPlan.pack_key) {
        fail(incomplete("E_AGGREGATE_PACK_KEY_MISMATCH", q.shard_plan_key));
      }
      const packContent = packContentOf(blobs, pack);
      const recomputed = recomputePackHash(packContent);
      if (recomputed !== pack.pack_hash) {
        fail(
          contentError(
            pack.content_ref,
            recomputed,
            pack.pack_hash
          )
        );
      }

      const shardRaw = allRows(
        readConnection,
        `SELECT * FROM evd_shard
          WHERE shard_plan_id = :shard_plan_id
          ORDER BY shard_order ASC`,
        { shard_plan_id: shardPlan.shard_plan_id }
      );
      const shards = shardRaw.map((row) => {
        assertBinding(row, q.binding, "shard.binding");
        return shardRowOf(row);
      });

      const bindingRaw = allRows(
        readConnection,
        `SELECT * FROM evd_request_binding
          WHERE shard_plan_id = :shard_plan_id
          ORDER BY shard_id COLLATE BINARY ASC, binding_id COLLATE BINARY ASC`,
        { shard_plan_id: shardPlan.shard_plan_id }
      );
      const requestBindings = bindingRaw.map((row) => {
        assertBinding(row, q.binding, "request_binding.binding");
        return requestBindingRowOf(row);
      });

      const attemptRaw = allRows(
        readConnection,
        `SELECT * FROM evd_attempt
          WHERE binding_id IN (
            SELECT binding_id FROM evd_request_binding
            WHERE shard_plan_id = :shard_plan_id
          )
          ORDER BY binding_id COLLATE BINARY ASC, attempt_no ASC`,
        { shard_plan_id: shardPlan.shard_plan_id }
      );
      const attempts = attemptRaw.map((row) => {
        assertBinding(row, q.binding, "attempt.binding");
        return attemptRowOf(row);
      });

      const envelopeRaw = allRows(
        readConnection,
        `SELECT * FROM evd_envelope
          WHERE attempt_id IN (
            SELECT attempt_id FROM evd_attempt
            WHERE binding_id IN (
              SELECT binding_id FROM evd_request_binding
              WHERE shard_plan_id = :shard_plan_id
            )
          )
          ORDER BY attempt_id COLLATE BINARY ASC`,
        { shard_plan_id: shardPlan.shard_plan_id }
      );
      const envelopes = envelopeRaw.map((row) => {
        assertBinding(row, q.binding, "envelope.binding");
        return envelopeRowOf(row);
      });

      const lateRaw = allRows(
        readConnection,
        `SELECT * FROM evd_late_result
          WHERE attempt_id IN (
            SELECT attempt_id FROM evd_attempt
            WHERE binding_id IN (
              SELECT binding_id FROM evd_request_binding
              WHERE shard_plan_id = :shard_plan_id
            )
          )
          ORDER BY received_at ASC, late_result_id COLLATE BINARY ASC`,
        { shard_plan_id: shardPlan.shard_plan_id }
      );
      const lateResults = lateRaw.map((row) => {
        assertBinding(row, q.binding, "late_result.binding");
        return lateResultRowOf(row);
      });

      const omissionRaw = allRows(
        readConnection,
        `SELECT * FROM evd_omission
          WHERE shard_plan_id = :shard_plan_id
          ORDER BY omission_key COLLATE BINARY ASC`,
        { shard_plan_id: shardPlan.shard_plan_id }
      );
      const omissions = omissionRaw.map((row) => {
        assertBinding(row, q.binding, "omission.binding");
        return omissionRowOf(row);
      });

      const aggregateRaw = allRows(
        readConnection,
        `SELECT * FROM evd_aggregate
          WHERE shard_plan_key = :shard_plan_key
          ORDER BY created_at ASC, aggregate_id COLLATE BINARY ASC`,
        { shard_plan_key: q.shard_plan_key }
      );
      const aggregates = aggregateRaw.map((row) => {
        assertBinding(row, q.binding, "aggregate.binding");
        return aggregateRowOf(row);
      });

      // Cross-row referential integrity. The snapshot is all or nothing.
      const shardsById = new Map<string, EvdShardRow>();
      for (const shard of shards) {
        if (shard.shard_plan_id !== shardPlan.shard_plan_id) {
          fail(incomplete("E_AGGREGATE_SHARD_PLAN_MISMATCH", q.shard_plan_key, shard.shard_key));
        }
        shardsById.set(shard.shard_id, shard);
      }
      const bindingsById = new Map<string, EvdRequestBindingRow>();
      for (const binding of requestBindings) {
        if (binding.shard_plan_id !== shardPlan.shard_plan_id) {
          fail(incomplete("E_AGGREGATE_BINDING_SHARD_PLAN_MISMATCH", q.shard_plan_key, binding.shard_key));
        }
        const shard = shardsById.get(binding.shard_id);
        if (shard === undefined) {
          fail(incomplete("E_AGGREGATE_BINDING_SHARD_MISSING", q.shard_plan_key, binding.shard_key));
        }
        if (shard.request_binding_id !== binding.binding_id) {
          fail(incomplete("E_AGGREGATE_SHARD_BINDING_MISMATCH", q.shard_plan_key, binding.shard_key));
        }
        bindingsById.set(binding.binding_id, binding);
      }
      // Deterministic-only plans have no request bindings. Their caller must
      // supply the validator key explicitly; nonempty bindings still agree.
      if (requestBindings.length > 0) {
        uniqueValidatorKey(requestBindings, q.shard_plan_key);
      }

      for (const shard of shards) {
        if (
          (shard.status === "budget_rejected" ||
            shard.status === "projection_rejected") &&
          shard.request_binding_id !== null
        ) {
          fail(incomplete("E_AGGREGATE_REJECTED_SHARD_BOUND", q.shard_plan_key, shard.shard_key));
        }
        if (shard.request_binding_id !== null) {
          if (!bindingsById.has(shard.request_binding_id)) {
            fail(incomplete("E_AGGREGATE_SHARD_BINDING_MISSING", q.shard_plan_key, shard.shard_key));
          }
        } else if (shard.envelope_keys.length > 0) {
          fail(incomplete("E_AGGREGATE_ENVELOPE_WITHOUT_BINDING", q.shard_plan_key, shard.shard_key));
        }
      }

      const attemptsById = new Map<string, EvdAttemptRow>();
      for (const attempt of attempts) {
        if (!bindingsById.has(attempt.binding_id)) {
          fail(incomplete("E_AGGREGATE_ATTEMPT_BINDING_MISSING", q.shard_plan_key));
        }
        attemptsById.set(attempt.attempt_id, attempt);
      }

      for (const envelope of envelopes) {
        const attempt = attemptsById.get(envelope.attempt_id);
        if (attempt === undefined) {
          fail(incomplete("E_AGGREGATE_ENVELOPE_ATTEMPT_MISSING", q.shard_plan_key, envelope.shard_key));
        }
        const binding = bindingsById.get(envelope.binding_id);
        if (binding === undefined) {
          fail(incomplete("E_AGGREGATE_ENVELOPE_WITHOUT_REQUEST_BINDING", q.shard_plan_key, envelope.shard_key));
        }
        if (attempt.binding_id !== envelope.binding_id) {
          fail(incomplete("E_AGGREGATE_ENVELOPE_BINDING_MISMATCH", q.shard_plan_key, envelope.shard_key));
        }
        if (!shardsById.has(envelope.shard_id)) {
          fail(incomplete("E_AGGREGATE_ENVELOPE_SHARD_MISSING", q.shard_plan_key, envelope.shard_key));
        }
      }

      for (const late of lateResults) {
        if (!attemptsById.has(late.attempt_id)) {
          fail(incomplete("E_AGGREGATE_LATE_ATTEMPT_MISSING", q.shard_plan_key));
        }
      }

      for (const omission of omissions) {
        if (
          omission.shard_id !== null &&
          !shardsById.has(omission.shard_id)
        ) {
          fail(incomplete("E_AGGREGATE_OMISSION_SHARD_MISSING", q.shard_plan_key));
        }
      }

      return {
        binding: { ...q.binding },
        shard_plan: shardPlan,
        pack,
        shards,
        request_bindings: requestBindings,
        attempts,
        envelopes,
        late_results: lateResults,
        omissions,
        aggregates,
      };
    });
  }

  function readValidatorBinding(q: {
    validator_binding_key: Hash;
  }): Result<EvdValidatorBindingRow | null, ErrorEnvelope> {
    return withReadFailure("state_row_read", () => {
      const row = oneRow(
        readConnection,
        `SELECT * FROM evd_validator_binding WHERE validator_binding_key = :validator_binding_key`,
        { validator_binding_key: q.validator_binding_key }
      );
      return row === null ? null : validatorBindingRowOf(row);
    });
  }

  function readAcceptedAggregate(q: {
    aggregate_id: Id;
    task_id: Id;
    branch_id: Id;
    input_epoch: number;
    goal_version: string;
    config_version: string;
  }): Result<EvdAcceptedAggregateRead | null, ErrorEnvelope> {
    return withReadTransaction(readConnection, "state_row_read", () => {
      const row = oneRow(
        readConnection,
        `SELECT * FROM evd_aggregate WHERE aggregate_id = :aggregate_id`,
        { aggregate_id: q.aggregate_id }
      );
      if (row === null) {
        return null;
      }
      // The five scope fields are checked before any blob read: a row outside
      // the caller's scope is absent, not a storage failure and not stale.
      if (
        stringField(row, "task_id") !== q.task_id ||
        stringField(row, "branch_id") !== q.branch_id ||
        numberField(row, "input_epoch") !== q.input_epoch ||
        stringField(row, "goal_version") !== q.goal_version ||
        stringField(row, "config_version") !== q.config_version
      ) {
        return null;
      }
      const aggregate = aggregateRowOf(row);
      const parsedRef = parseSourceRef(aggregate.content_ref);
      if (!parsedRef.ok) {
        fail(parsedRef.error);
      }
      if (parsedRef.value.scheme !== "blob") {
        fail(stateRowError("content_ref", "blob_scheme"));
      }
      if (
        parsedRef.value.start !== 0 ||
        parsedRef.value.end !== aggregate.content_bytes
      ) {
        fail(
          contentError(
            aggregate.content_ref,
            `bytes=0-${String(aggregate.content_bytes)}`,
            `bytes=${String(parsedRef.value.start)}-${String(parsedRef.value.end)}`
          )
        );
      }
      const locator = parsedRef.value.locator;
      if (!isHash(locator)) {
        fail(stateRowError("content_ref.locator", "sha256_full_hash"));
      }
      const read = blobs.read(locator);
      if (!read.ok) {
        fail(read.error);
      }
      const bytes = read.value;
      if (bytes.byteLength !== aggregate.content_bytes) {
        fail(
          contentError(
            aggregate.content_ref,
            String(aggregate.content_bytes),
            String(bytes.byteLength)
          )
        );
      }
      const recomputed = hashBytes(bytes);
      if (recomputed !== aggregate.content_hash) {
        fail(contentError(aggregate.content_ref, recomputed, aggregate.content_hash));
      }
      return { row: aggregate, content_bytes: bytes };
    });
  }

  function readEnvelope(envelopeId: string): Result<JudgeEnvelopeV3 | null, ErrorEnvelope> {
    return withReadFailure("envelope_read", () => {
      const row = oneRow(
        readConnection,
        `SELECT * FROM evd_envelope WHERE envelope_id = :envelope_id`,
        { envelope_id: envelopeId }
      );
      if (row === null) {
        return null;
      }
      const persisted = envelopeRowOf(row);
      const decoded = decodeContent(blobs, {
        content_hash: persisted.content_hash,
        content_ref: persisted.content_ref,
        content_bytes: persisted.content_bytes,
        source_blob_refs: persisted.source_blob_refs,
      });
      const schema = schemaVersionOf(decoded, "envelope.schema_version");
      if (
        schema !== "rsi.judge_envelope/2" &&
        schema !== "rsi.judge_envelope/3"
      ) {
        fail(stateRowError("envelope.schema_version", "rsi.judge_envelope/2_or_3"));
      }
      if (!isRecord(decoded)) {
        fail(stateRowError("envelope", "object"));
      }
      if (decoded["envelope_id"] !== persisted.envelope_id) {
        fail(stateRowError("envelope.envelope_id", "row_matches_content"));
      }
      if (decoded["envelope_key"] !== persisted.envelope_key) {
        fail(stateRowError("envelope.envelope_key", "row_matches_content"));
      }
      return decoded as unknown as JudgeEnvelopeV3;
    });
  }

  function readAttempt(attemptId: string): Result<JudgeAttemptV2 | null, ErrorEnvelope> {
    return withReadFailure("attempt_read", () => {
      const row = oneRow(
        readConnection,
        `SELECT * FROM evd_attempt WHERE attempt_id = :attempt_id`,
        { attempt_id: attemptId }
      );
      if (row === null) {
        return null;
      }
      const attempt = attemptRowOf(row);
      // The gateway decides whether a `/1` body is usable. The reader returns
      // the persisted object without upgrading or rebuilding it.
      schemaVersionOf(attempt.body_json, "attempt.schema_version");
      if (!isRecord(attempt.body_json) || attempt.body_json["attempt_id"] !== attempt.attempt_id) {
        fail(stateRowError("attempt.body_json.attempt_id", "row_matches_content"));
      }
      return attempt.body_json as JudgeAttemptV2;
    });
  }

  function readLateResults(attemptId: string): Result<LateJudgeResultV2[], ErrorEnvelope> {
    return withReadFailure("late_result_read", () => {
      const rows = allRows(
        readConnection,
        `SELECT * FROM evd_late_result
          WHERE attempt_id = :attempt_id
          ORDER BY received_at ASC, late_result_id COLLATE BINARY ASC`,
        { attempt_id: attemptId }
      );
      return rows.map((row) => {
        const persisted = lateResultRowOf(row);
        const decoded = decodeContent(blobs, {
          content_hash: persisted.content_hash,
          content_ref: persisted.content_ref,
          content_bytes: persisted.content_bytes,
          source_blob_refs: persisted.source_blob_refs,
        });
        const schema = schemaVersionOf(decoded, "late_result.schema_version");
        if (
          schema !== "rsi.late_judge_result/1" &&
          schema !== "rsi.late_judge_result/2"
        ) {
          fail(stateRowError("late_result.schema_version", "rsi.late_judge_result/1_or_2"));
        }
        if (!isRecord(decoded)) {
          fail(stateRowError("late_result", "object"));
        }
        if (decoded["late_result_id"] !== persisted.late_result_id) {
          fail(stateRowError("late_result.late_result_id", "row_matches_content"));
        }
        if (decoded["attempt_id"] !== persisted.attempt_id) {
          fail(stateRowError("late_result.attempt_id", "row_matches_content"));
        }
        if (decoded["disposition"] !== persisted.disposition) {
          fail(stateRowError("late_result.disposition", "row_matches_content"));
        }
        return decoded as unknown as LateJudgeResultV2;
      });
    });
  }

  function bindingForLate(
    late: LateJudgeResultV2
  ): Result<VersionBinding, ErrorEnvelope> {
    try {
      const attempt = oneRow(
        readConnection,
        `SELECT * FROM evd_attempt WHERE attempt_id = :attempt_id`,
        { attempt_id: late.attempt_id }
      );
      if (attempt === null) {
        return err(
          evdForwardedError("E_VERSION_BINDING", {
            field: "attempt_id",
            expected: late.attempt_id,
            actual: "missing",
          })
        );
      }
      const persistedBindingId = stringField(attempt, "binding_id");
      if (persistedBindingId !== late.binding_id) {
        return err(
          evdForwardedError("E_VERSION_BINDING", {
            field: "binding_id",
            expected: late.binding_id,
            actual: persistedBindingId,
          })
        );
      }
      return ok(bindingOf(attempt));
    } catch (error: unknown) {
      if (error instanceof ReadFailure) {
        return err(error.envelope);
      }
      return err(mapSqliteFailure(error, "state_row_read", "late_attempt_read"));
    }
  }

  function commitLate(input: {
    late: LateJudgeResultV2;
  }): Promise<LiveCommitOutcome<null>> {
    const binding = bindingForLate(input.late);
    if (!binding.ok) {
      return Promise.resolve({
        ok: false,
        commit_state: "not_written",
        error: binding.error,
      });
    }
    return writer.commitLate({ binding: binding.value, late: input.late });
  }

  function nextAttemptNo(bindingId: string): number {
    const row = readConnection
      .prepare<{ next_attempt_no: number | null }>(
        `SELECT MAX(attempt_no) + 1 AS next_attempt_no
          FROM evd_attempt WHERE binding_id = :binding_id`
      )
      .get({ binding_id: bindingId });
    const value = row?.next_attempt_no ?? null;
    if (value === null) {
      return 1;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw stateRowError("attempt_no", "max_plus_one");
    }
    return value;
  }

  return {
    async readEvdAggregateSnapshot(q) {
      return readAggregateSnapshot(q);
    },
    async readValidatorBinding(q) {
      return readValidatorBinding(q);
    },
    async readEvdAcceptedAggregate(q) {
      return readAcceptedAggregate(q);
    },
    async readEnvelope(envelopeId) {
      return readEnvelope(envelopeId);
    },
    async readAttempt(attemptId) {
      return readAttempt(attemptId);
    },
    async readLateResults(attemptId) {
      return readLateResults(attemptId);
    },
    commitLate,
    next_attempt_no: nextAttemptNo,
  };
}
