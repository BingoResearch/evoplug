/**
 * Shared `delivery` row reader/writer projection (DD-FND-092).
 *
 * The outbox worker and the W5 expiry paths must agree byte-for-byte on the
 * row shape they journal and compare. Keeping the parser and the JSON
 * projection in one module prevents the invalidator from minting a different
 * preimage than the worker.
 */

import { canonicalJsonText, isHash, isId, parseSourceRef } from "@evoplug/core";
import type { ErrorEnvelope, Id, JsonValue, Result, SourceRef, VersionBinding } from "@evoplug/core";
import {
  isAdoptionEvidence,
  isDeliveryState,
  isDeliveryTerminalReason,
  isInclusionEvidence,
  type DeliveryRecord
} from "@evoplug/delivery";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import { internalError } from "./errors.js";

export type JsonRecord = Record<string, JsonValue>;

export const DELIVERY_COLUMNS = `delivery_id, task_id, branch_id, input_epoch, goal_version,
  config_version, watermark, requirement_ids_json, issue_id, dedupe_key, pack_hash,
  evidence_hash, content_hash, content_ref, state, inclusion_evidence,
  transport_body_verified, submission_ref, inclusion_ref, adoption, adoption_ref,
  terminal_reason, expires_at, row_version, created_at, updated_at`;

function readString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function readNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readBoolean(row: SqlRow, key: string): boolean {
  return readNumber(row, key) === 1;
}

function parseJsonObject(text: string): JsonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonRecord;
}

/** Parses one `delivery` row; `null` means the row is structurally corrupt. */
export function deliveryFromRow(row: SqlRow): DeliveryRecord | null {
  const requirementIdsJson = parseJsonObject(
    `{"items":${String(readString(row, "requirement_ids_json"))}}`
  );
  const items = requirementIdsJson === null ? null : requirementIdsJson["items"];
  if (!Array.isArray(items)) {
    return null;
  }
  const requirementIds: Id<"req">[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !isId(item, "req")) {
      return null;
    }
    requirementIds.push(item);
  }
  const deliveryText = readString(row, "delivery_id");
  const taskText = readString(row, "task_id");
  const branchText = readString(row, "branch_id");
  const inputEpoch = readNumber(row, "input_epoch");
  const goalVersion = readString(row, "goal_version");
  const configVersion = readString(row, "config_version");
  const issueText = readString(row, "issue_id");
  const dedupeKey = readString(row, "dedupe_key");
  const packHash = readString(row, "pack_hash");
  const evidenceHash = readString(row, "evidence_hash");
  const contentHash = readString(row, "content_hash");
  const contentRefText = readString(row, "content_ref");
  const state = readString(row, "state");
  const inclusionEvidence = readString(row, "inclusion_evidence");
  const submissionRef = readString(row, "submission_ref");
  const inclusionRef = readString(row, "inclusion_ref");
  const adoption = readString(row, "adoption");
  const adoptionRef = readString(row, "adoption_ref");
  const terminalReason = readString(row, "terminal_reason");
  const expiresAt = readNumber(row, "expires_at");
  const rowVersion = readNumber(row, "row_version");
  const createdAt = readNumber(row, "created_at");
  const updatedAt = readNumber(row, "updated_at");
  if (
    deliveryText === null ||
    !isId(deliveryText, "del") ||
    taskText === null ||
    !isId(taskText, "task") ||
    branchText === null ||
    !isId(branchText, "br") ||
    inputEpoch === null ||
    inputEpoch < 1 ||
    goalVersion === null ||
    configVersion === null ||
    dedupeKey === null ||
    !isHash(dedupeKey) ||
    packHash === null ||
    !isHash(packHash) ||
    evidenceHash === null ||
    !isHash(evidenceHash) ||
    contentHash === null ||
    !isHash(contentHash) ||
    contentRefText === null ||
    state === null ||
    !isDeliveryState(state) ||
    inclusionEvidence === null ||
    !isInclusionEvidence(inclusionEvidence) ||
    adoption === null ||
    !isAdoptionEvidence(adoption) ||
    expiresAt === null ||
    rowVersion === null ||
    rowVersion < 1 ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const contentRef = parseSourceRef(contentRefText);
  if (!contentRef.ok) {
    return null;
  }
  if (terminalReason !== null && !isDeliveryTerminalReason(terminalReason)) {
    return null;
  }
  if (issueText !== null && !isId(issueText, "issue")) {
    return null;
  }
  if (submissionRef !== null && submissionRef.length === 0) {
    return null;
  }
  if (inclusionRef !== null && !parseSourceRef(inclusionRef).ok) {
    return null;
  }
  if (adoptionRef !== null && !parseSourceRef(adoptionRef).ok) {
    return null;
  }
  return {
    schema_version: "rsi.delivery/2",
    delivery_id: deliveryText,
    task_id: taskText,
    branch_id: branchText,
    input_epoch: inputEpoch,
    config_version: configVersion,
    goal_version: goalVersion,
    requirement_ids: requirementIds,
    issue_id: issueText,
    evidence_hash: evidenceHash,
    pack_hash: packHash,
    content_hash: contentHash,
    content_ref: contentRef.value.source_ref,
    expires_at: expiresAt,
    dedupe_key: dedupeKey,
    state,
    terminal_reason: terminalReason,
    inclusion_evidence: inclusionEvidence,
    transport_body_verified: readBoolean(row, "transport_body_verified"),
    submission_ref: submissionRef,
    inclusion_ref: inclusionRef === null ? null : (inclusionRef as SourceRef),
    adoption,
    adoption_ref: adoptionRef === null ? null : (adoptionRef as SourceRef),
    row_version: rowVersion,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

export function readDeliveryRecord(
  connection: SqliteConnection,
  deliveryId: string
): DeliveryRecord | null {
  const row = connection
    .prepare<SqlRow>(`SELECT ${DELIVERY_COLUMNS} FROM delivery WHERE delivery_id = :delivery_id`)
    .get({ delivery_id: deliveryId });
  return row === undefined ? null : deliveryFromRow(row);
}

/** Rows for an older input epoch that may still be sent. */
export function readPendingDeliveriesBelowEpoch(
  connection: SqliteConnection,
  binding: Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">,
  limit: number
): Result<readonly DeliveryRecord[], ErrorEnvelope> {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM delivery
        WHERE task_id = :task_id AND branch_id = :branch_id
          AND input_epoch < :input_epoch AND state = 'pending'
        ORDER BY input_epoch ASC, created_at ASC, delivery_id ASC
        LIMIT :limit`
    )
    .all({
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      limit
    });
  const records: DeliveryRecord[] = [];
  for (const row of rows) {
    const record = deliveryFromRow(row);
    if (record === null) {
      return { ok: false, status: "rejected", error: internalError("kernel.delivery_row_corrupt") };
    }
    records.push(record);
  }
  return { ok: true, status: "ok", value: records };
}

export function deliveryRowJson(record: DeliveryRecord): JsonRecord {
  return {
    delivery_id: record.delivery_id,
    task_id: record.task_id,
    branch_id: record.branch_id,
    input_epoch: record.input_epoch,
    goal_version: record.goal_version,
    config_version: record.config_version,
    watermark: 0,
    requirement_ids_json: canonicalJsonText(record.requirement_ids),
    issue_id: record.issue_id,
    dedupe_key: record.dedupe_key,
    pack_hash: record.pack_hash,
    evidence_hash: record.evidence_hash,
    content_hash: record.content_hash,
    content_ref: record.content_ref,
    state: record.state,
    inclusion_evidence: record.inclusion_evidence,
    transport_body_verified: record.transport_body_verified ? 1 : 0,
    submission_ref: record.submission_ref,
    inclusion_ref: record.inclusion_ref,
    adoption: record.adoption,
    adoption_ref: record.adoption_ref,
    terminal_reason: record.terminal_reason,
    expires_at: record.expires_at,
    row_version: record.row_version,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function bindingJson(binding: VersionBinding): JsonRecord {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

export function bindingOf(record: DeliveryRecord): VersionBinding {
  return {
    task_id: record.task_id,
    branch_id: record.branch_id,
    input_epoch: record.input_epoch,
    goal_version: record.goal_version,
    config_version: record.config_version,
    watermark: 0
  };
}
