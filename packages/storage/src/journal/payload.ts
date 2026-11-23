import { canonicalHash, canonicalJsonText, isRecord } from "@evoplug/core";
import type { Hash, JsonValue } from "@evoplug/core";
import { compareUtf8Bytes, isHash } from "../hash.js";
import {
  COMPLETE_STATE_ROW_SCHEMAS,
  STATE_ROW_COLUMNS
} from "../recovery/state-row-registry.js";

export const JOURNAL_EVENT_SCHEMA_VERSION = "rsi.journal_event/1";
export const STATE_ROW_BATCH_SCHEMA_VERSION = "rsi.state_row_batch/1";
const STATE_ROW_BATCH_MAX_MEMBERS = 256;
const STATE_ROW_BATCH_MIN_MEMBERS = 1;

/** One `rsi.journal_event/1` payload: a single host, ledger, QP or fact event. */
export interface JournalEventBody {
  readonly schema_version: typeof JOURNAL_EVENT_SCHEMA_VERSION;
  readonly event: JsonValue;
  readonly event_hash: Hash;
  readonly blob_hashes: readonly Hash[];
}

/** One member of an atomic `rsi.state_row_batch/1` frame. */
export interface StateRowBatchMember {
  readonly event: JsonValue;
  readonly event_hash: Hash;
  readonly blob_hashes: readonly Hash[];
}

/** One atomic multi-member frame (DD-FND-059.1.3). */
export interface StateRowBatchBody {
  readonly schema_version: typeof STATE_ROW_BATCH_SCHEMA_VERSION;
  readonly member_count: number;
  readonly batch_hash: Hash;
  readonly members: readonly StateRowBatchMember[];
}

/** The two payload shapes a journal frame may carry. */
export type JournalFramePayload = JournalEventBody | StateRowBatchBody;

type JournalPayloadErrorReason =
  | "not_object"
  | "unsupported_schema_version"
  | "invalid_event"
  | "event_hash_mismatch"
  | "invalid_blob_hashes"
  | "invalid_member_count"
  | "invalid_member"
  | "member_hash_mismatch"
  | "batch_hash_mismatch"
  | "batch_order"
  | "binding_scope"
  | "fact_verification_shape"
  | "row_json_invalid"
  | "missing_payload_hash"
  | "missing_event_id";

export interface JournalPayloadError {
  readonly reason: JournalPayloadErrorReason;
  readonly detail: string;
}

/** Local parse result; `Result` is restricted to `ErrorEnvelope` errors. */
type JournalParseResult<T> =
  | { readonly ok: true; readonly status: "ok"; readonly value: T }
  | { readonly ok: false; readonly status: "rejected"; readonly error: JournalPayloadError };

function ok<T>(value: T): JournalParseResult<T> {
  return { ok: true, status: "ok", value };
}

function err(
  reason: JournalPayloadErrorReason,
  detail: string,
): JournalParseResult<never> {
  return { ok: false, status: "rejected", error: { reason, detail } };
}

function jsonObject(value: unknown): Record<string, JsonValue> | null {
  if (!isRecord(value)) {
    return null;
  }
  return value as Record<string, JsonValue>;
}

/**
 * Narrows an already-validated JSON structure to `JsonValue`. The frame
 * validator proves the shape member by member; this helper keeps the single
 * assertion in one place.
 */
function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

/** Narrows an already-validated frame payload to `JsonValue` for canonicalisation. */
export function journalPayloadJson(payload: JournalFramePayload): JsonValue {
  return asJsonValue(payload);
}

function stringField(
  value: Record<string, JsonValue>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function numberField(
  value: Record<string, JsonValue>,
  key: string,
): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) ? field : null;
}

function hashArray(value: unknown): readonly Hash[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const hashes: Hash[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isHash(item)) {
      return null;
    }
    hashes.push(item);
  }
  return hashes;
}

function isStrictlySorted(hashes: readonly Hash[]): boolean {
  for (let index = 1; index < hashes.length; index += 1) {
    const previous = hashes[index - 1];
    const current = hashes[index];
    if (previous === undefined || current === undefined || compareUtf8Bytes(previous, current) >= 0) {
      return false;
    }
  }
  return true;
}

/** Parses JSON that is known to be a JSON value; returns null on failure. */
export function parseJsonValue(text: string): JsonValue | null {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

/** `member_hash = sha256(JCS({event_hash, blob_hashes}))` (DD-FND-059.1.3). */
export function stateRowBatchMemberHash(member: {
  readonly event_hash: Hash;
  readonly blob_hashes: readonly Hash[];
}): Hash {
  return canonicalHash({
    event_hash: member.event_hash,
    blob_hashes: [...member.blob_hashes]
  });
}

/** `batch_hash = sha256(JCS({schema_version, member_count, member_hashes}))`. */
export function stateRowBatchHash(memberHashes: readonly Hash[]): Hash {
  return canonicalHash({
    schema_version: STATE_ROW_BATCH_SCHEMA_VERSION,
    member_count: memberHashes.length,
    member_hashes: [...memberHashes]
  });
}

/** Number of `commit_seq` values consumed by one frame. */
export function journalFrameMemberCount(payload: JournalFramePayload): number {
  return payload.schema_version === STATE_ROW_BATCH_SCHEMA_VERSION
    ? payload.member_count
    : 1;
}

function orderRank(eventType: string | null): number | null {
  switch (eventType) {
    case "object_document.recorded":
      return 0;
    case "object_head.transition":
      return 1;
    case "state_row.recorded":
      return 2;
    case "outbox.enqueued":
      return 3;
    default:
      return null;
  }
}

function memberSortKey(event: JsonValue): readonly string[] | null {
  const object = jsonObject(event);
  if (object === null) {
    return null;
  }
  const eventType = stringField(object, "event_type");
  const rank = eventType === null ? null : orderRank(eventType);
  if (rank === null) {
    return null;
  }
  const entityId = stringField(object, "entity_id");
  if (entityId === null) {
    return null;
  }
  if (eventType === "state_row.recorded") {
    const rowSchema = stringField(object, "row_schema");
    return rowSchema === null ? null : [String(rank), rowSchema, entityId];
  }
  if (eventType === "outbox.enqueued") {
    const rowJson = stringField(object, "row_json");
    if (rowJson === null) {
      return null;
    }
    const row = parseJsonValue(rowJson);
    const rowObject = row === null ? null : jsonObject(row);
    const effectKey = rowObject === null ? null : stringField(rowObject, "effect_key");
    return effectKey === null ? null : [String(rank), effectKey, entityId];
  }
  return [String(rank), entityId];
}

function compareSortKeys(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? "";
    const b = right[index] ?? "";
    const compared = compareUtf8Bytes(a, b);
    if (compared !== 0) {
      return compared;
    }
  }
  return left.length - right.length;
}

/** Deterministic default member order for a batch frame (DD-FND-059.1.3). */
export function orderStateRowBatchMembers<T extends { readonly event: JsonValue }>(
  members: readonly T[],
): T[] {
  return [...members].sort((left, right) => {
    const leftKey = memberSortKey(left.event);
    const rightKey = memberSortKey(right.event);
    if (leftKey === null || rightKey === null) {
      return 0;
    }
    return compareSortKeys(leftKey, rightKey);
  });
}

function isFactVerificationFrame(members: readonly StateRowBatchMember[]): boolean {
  const first = members[0];
  if (first === undefined) {
    return false;
  }
  const event = jsonObject(first.event);
  return (
    event !== null &&
    stringField(event, "schema_version") === "rsi.fact_verification_event/1" &&
    stringField(event, "event_type") === "fact_verification.recorded"
  );
}

function validateBindingScope(members: readonly StateRowBatchMember[]): JournalPayloadError | null {
  let shared: string | null = null;
  let hasBound = false;
  let hasUnbound = false;
  for (const member of members) {
    const event = jsonObject(member.event);
    if (event === null) {
      return { reason: "invalid_member", detail: "member event is not an object" };
    }
    const binding = event["binding"];
    if (binding === undefined || binding === null) {
      hasUnbound = true;
      continue;
    }
    hasBound = true;
    const bindingObject = jsonObject(binding);
    if (bindingObject === null) {
      return { reason: "binding_scope", detail: "binding is not an object" };
    }
    const text = canonicalJsonText(bindingObject);
    if (shared === null) {
      shared = text;
    } else if (shared !== text) {
      return { reason: "binding_scope", detail: "batch members do not share one VersionBinding" };
    }
  }
  if (hasBound && hasUnbound) {
    return { reason: "binding_scope", detail: "none rows must not mix with bound rows" };
  }
  return null;
}

function validateFactVerificationFrame(
  members: readonly StateRowBatchMember[],
): JournalPayloadError | null {
  if (members.length !== 3) {
    return {
      reason: "fact_verification_shape",
      detail: "a fact verification frame has exactly three members"
    };
  }
  const factEvent = jsonObject(members[0]?.event ?? null);
  const factRow = jsonObject(members[1]?.event ?? null);
  const verificationRow = jsonObject(members[2]?.event ?? null);
  if (
    factEvent === null ||
    factRow === null ||
    verificationRow === null ||
    stringField(factRow, "event_type") !== "state_row.recorded" ||
    stringField(factRow, "row_schema") !== "rsi.state_fact_row/1" ||
    stringField(verificationRow, "event_type") !== "state_row.recorded" ||
    stringField(verificationRow, "row_schema") !== "rsi.fact_verification_row/1"
  ) {
    return {
      reason: "fact_verification_shape",
      detail: "expected event_log event, state_fact row, fact_verification row"
    };
  }
  const verificationBinding = jsonObject(factEvent["binding"] ?? null);
  const factBinding = jsonObject(factRow["binding"] ?? null);
  const rowBinding = jsonObject(verificationRow["binding"] ?? null);
  if (verificationBinding === null || factBinding === null || rowBinding === null) {
    return { reason: "binding_scope", detail: "fact verification bindings must be present" };
  }
  const task = stringField(verificationBinding, "task_id");
  const branch = stringField(verificationBinding, "branch_id");
  if (
    task === null ||
    branch === null ||
    stringField(factBinding, "task_id") !== task ||
    stringField(factBinding, "branch_id") !== branch
  ) {
    return { reason: "binding_scope", detail: "V and F task/branch differ" };
  }
  const verificationEpoch = numberField(verificationBinding, "input_epoch");
  const verificationWatermark = numberField(verificationBinding, "watermark");
  const factEpoch = numberField(factBinding, "input_epoch");
  const factWatermark = numberField(factBinding, "watermark");
  const verificationGoal = stringField(verificationBinding, "goal_version");
  const verificationConfig = stringField(verificationBinding, "config_version");
  const factGoal = stringField(factBinding, "goal_version");
  const factConfig = stringField(factBinding, "config_version");
  if (
    verificationEpoch === null ||
    verificationWatermark === null ||
    factEpoch === null ||
    factWatermark === null ||
    verificationGoal === null ||
    verificationConfig === null ||
    factGoal === null ||
    factConfig === null ||
    verificationEpoch < factEpoch ||
    verificationWatermark < factWatermark
  ) {
    return { reason: "binding_scope", detail: "V is earlier than F or incomplete" };
  }
  if (canonicalJsonText(verificationBinding) !== canonicalJsonText(rowBinding)) {
    return { reason: "binding_scope", detail: "fact_verification row must carry V" };
  }
  const factRowJson = stringField(factRow, "row_json");
  const factRowValue = factRowJson === null ? null : parseJsonValue(factRowJson);
  const factRowObject = factRowValue === null ? null : jsonObject(factRowValue);
  if (
    factRowObject === null ||
    stringField(factRowObject, "task_id") !== task ||
    stringField(factRowObject, "branch_id") !== branch ||
    numberField(factRowObject, "input_epoch") !== factEpoch ||
    stringField(factRowObject, "goal_version") !== factGoal ||
    stringField(factRowObject, "config_version") !== factConfig ||
    numberField(factRowObject, "watermark") !== factWatermark
  ) {
    return { reason: "binding_scope", detail: "state_fact row does not carry F" };
  }
  const rowJson = stringField(verificationRow, "row_json");
  const row = rowJson === null ? null : parseJsonValue(rowJson);
  const rowObject = row === null ? null : jsonObject(row);
  if (rowObject === null) {
    return { reason: "row_json_invalid", detail: "fact_verification row_json is not JSON" };
  }
  if (
    numberField(rowObject, "input_epoch") !== verificationEpoch ||
    stringField(rowObject, "goal_version") !== verificationGoal ||
    stringField(rowObject, "config_version") !== verificationConfig ||
    numberField(rowObject, "watermark") !== verificationWatermark
  ) {
    return { reason: "binding_scope", detail: "fact_verification row fields do not equal V" };
  }
  return null;
}

function validateMember(member: unknown): JournalParseResult<StateRowBatchMember> {
  if (!isRecord(member)) {
    return err("invalid_member", "member is not an object");
  }
  const event = member["event"];
  if (!isRecord(event)) {
    return err("invalid_member", "member event is not an object");
  }
  const eventHash = member["event_hash"];
  if (typeof eventHash !== "string" || !isHash(eventHash)) {
    return err("invalid_member", "member event_hash is malformed");
  }
  const blobHashes = hashArray(member["blob_hashes"]);
  if (blobHashes === null || !isStrictlySorted(blobHashes)) {
    return err("invalid_blob_hashes", "member blob_hashes must be sorted, unique hashes");
  }
  if (canonicalHash(asJsonValue(event)) !== eventHash) {
    return err("member_hash_mismatch", "member event_hash does not match JCS(event)");
  }
  const rowJson = event["row_json"];
  if (typeof rowJson === "string") {
    const parsed = parseJsonValue(rowJson);
    if (parsed === null || canonicalJsonText(parsed) !== rowJson) {
      return err("row_json_invalid", "row_json must be canonical JSON");
    }
    const rowSchema = event["row_schema"];
    // The strict column check covers the typed state rows. The object
    // document and head rows carry their own completeness rules in the
    // projection; the frame level only checks that the text is canonical.
    if (
      typeof rowSchema === "string" &&
      isCompleteStateRowSchema(rowSchema) &&
      !isObjectRowSchema(rowSchema)
    ) {
      const row = jsonObject(parsed);
      if (row === null) {
        return err("row_json_invalid", "row_json must be a JSON object");
      }
      const columns = STATE_ROW_COLUMNS[rowSchema];
      if (columns !== undefined && !matchesStateRowColumns(columns, row)) {
        return err("row_json_invalid", "row_json does not match the registered physical columns");
      }
    }
  }
  return ok({ event: asJsonValue(event), event_hash: eventHash, blob_hashes: blobHashes });
}

/**
 * True when the frozen row has to carry the complete physical column set.
 *
 * The HOST trust tables are the rows the design freezes as complete physical
 * rows: a logical DTO must never pass as one. The rows whose producer owns
 * the completeness rule (the REV rows, the object documents and heads) keep
 * their own rule at the producer side.
 */
function isCompleteStateRowSchema(rowSchema: string): boolean {
  return COMPLETE_STATE_ROW_SCHEMAS.has(rowSchema);
}

/** The object document and object head rows are not typed state rows. */
function isObjectRowSchema(rowSchema: string): boolean {
  return rowSchema === "rsi.object_document_row/1" || rowSchema === "rsi.object_head_row/1";
}

/**
 * True when the frozen row carries exactly the registered physical columns.
 *
 * An injected column (a `schema_version` the table does not have) and a
 * missing column are both rejected: the row must be the physical row, not a
 * logical DTO.
 */
function matchesStateRowColumns(
  columns: readonly { readonly name: string; readonly nullable: boolean }[],
  row: Record<string, JsonValue>
): boolean {
  const expected = new Set(columns.map((column) => column.name));
  for (const name of Object.keys(row)) {
    if (!expected.has(name)) {
      return false;
    }
  }
  for (const column of columns) {
    const value = row[column.name];
    if (value === undefined) {
      return false;
    }
    if (value === null && !column.nullable) {
      return false;
    }
  }
  return true;
}

/**
 * Validates a parsed frame payload. Returns the narrowed payload on success.
 * All hashing uses the canonical JSON implementation from `@evoplug/core`.
 */
export function validateJournalFramePayload(
  value: unknown,
): JournalParseResult<JournalFramePayload> {
  if (!isRecord(value)) {
    return err("not_object", "payload is not a JSON object");
  }
  const schemaVersion = value["schema_version"];
  if (schemaVersion === JOURNAL_EVENT_SCHEMA_VERSION) {
    const event = value["event"];
    if (!isRecord(event)) {
      return err("invalid_event", "event is not an object");
    }
    const eventHash = value["event_hash"];
    if (typeof eventHash !== "string" || !isHash(eventHash)) {
      return err("invalid_event", "event_hash is malformed");
    }
    const blobHashes = hashArray(value["blob_hashes"]);
    if (blobHashes === null || !isStrictlySorted(blobHashes)) {
      return err("invalid_blob_hashes", "blob_hashes must be sorted, unique hashes");
    }
    if (canonicalHash(asJsonValue(event)) !== eventHash) {
      return err("event_hash_mismatch", "event_hash does not match JCS(event)");
    }
    const rowJson = event["row_json"];
    if (typeof rowJson === "string") {
      const parsed = parseJsonValue(rowJson);
      if (parsed === null || canonicalJsonText(parsed) !== rowJson) {
        return err("row_json_invalid", "row_json must be canonical JSON");
      }
    }
    const payload: JournalEventBody = {
      schema_version: JOURNAL_EVENT_SCHEMA_VERSION,
      event: asJsonValue(event),
      event_hash: eventHash,
      blob_hashes: blobHashes
    };
    // The append path and the reader must agree on what a projectable event
    // is. `frameEventRecords` is the reader's rule (`commit_record` needs an
    // event id and the frozen `payload_hash`); validating with it here keeps
    // the writer from making a durable frame that recovery will classify as
    // corrupt forever.
    const records = frameEventRecords(payload);
    if (!records.ok) {
      return err(records.error.reason, records.error.detail);
    }
    return ok(payload);
  }
  if (schemaVersion === STATE_ROW_BATCH_SCHEMA_VERSION) {
    const memberCount = value["member_count"];
    const members = value["members"];
    const batchHash = value["batch_hash"];
    if (
      typeof memberCount !== "number" ||
      !Number.isSafeInteger(memberCount) ||
      memberCount < STATE_ROW_BATCH_MIN_MEMBERS ||
      memberCount > STATE_ROW_BATCH_MAX_MEMBERS
    ) {
      return err("invalid_member_count", "member_count must be 1..256");
    }
    if (!Array.isArray(members) || members.length !== memberCount) {
      return err("invalid_member_count", "member_count does not match members");
    }
    if (typeof batchHash !== "string" || !isHash(batchHash)) {
      return err("invalid_member", "batch_hash is malformed");
    }
    const validated: StateRowBatchMember[] = [];
    for (const member of members) {
      const result = validateMember(member);
      if (!result.ok) {
        return result;
      }
      validated.push(result.value);
    }
    const memberHashes = validated.map((member) => stateRowBatchMemberHash(member));
    if (stateRowBatchHash(memberHashes) !== batchHash) {
      return err("batch_hash_mismatch", "batch_hash does not match member hashes");
    }
    if (isFactVerificationFrame(validated)) {
      const factError = validateFactVerificationFrame(validated);
      if (factError !== null) {
        return { ok: false, status: "rejected", error: factError };
      }
    } else {
      for (const member of validated) {
        const event = jsonObject(member.event);
        const eventType = event === null ? null : stringField(event, "event_type");
        if (eventType === null || orderRank(eventType) === null) {
          return err("invalid_member", "unsupported batch event_type");
        }
        if (eventType === "fact_verification.recorded") {
          return err("fact_verification_shape", "fact event must lead its own three-member frame");
        }
      }
      const expected = orderStateRowBatchMembers(validated);
      for (let index = 0; index < validated.length; index += 1) {
        if (validated[index]?.event_hash !== expected[index]?.event_hash) {
          return err("batch_order", "members are not in the canonical batch order");
        }
      }
      const bindingError = validateBindingScope(validated);
      if (bindingError !== null) {
        return { ok: false, status: "rejected", error: bindingError };
      }
    }
    const payload: StateRowBatchBody = {
      schema_version: STATE_ROW_BATCH_SCHEMA_VERSION,
      member_count: memberCount,
      batch_hash: batchHash,
      members: validated
    };
    // Same single rule as the reader: every member owns a `commit_record`
    // row, so it needs an event id and a frozen `payload_hash`.
    const records = frameEventRecords(payload);
    if (!records.ok) {
      return err(records.error.reason, records.error.detail);
    }
    return ok(payload);
  }
  return err("unsupported_schema_version", "unknown journal payload schema_version");
}

/** The event objects carried by one payload, in member order. */
export function payloadEvents(payload: JournalFramePayload): readonly JsonValue[] {
  if (payload.schema_version === STATE_ROW_BATCH_SCHEMA_VERSION) {
    return payload.members.map((member) => member.event);
  }
  return [payload.event];
}

/** The blob closure of one payload, sorted and deduplicated. */
export function payloadBlobHashes(payload: JournalFramePayload): readonly Hash[] {
  if (payload.schema_version !== STATE_ROW_BATCH_SCHEMA_VERSION) {
    return payload.blob_hashes;
  }
  const unique = new Set<Hash>();
  for (const member of payload.members) {
    for (const hash of member.blob_hashes) {
      unique.add(hash);
    }
  }
  return [...unique].sort(compareUtf8Bytes);
}

/**
 * Event id used by `commit_record.event_id`. Host, ledger and fact events carry
 * `event_id`; QP journal events carry only `entity_id` and the design does not
 * assign them a separate event id, so the entity id is the deterministic
 * fallback.
 */
function eventRecordId(event: JsonValue): string | null {
  const object = jsonObject(event);
  if (object === null) {
    return null;
  }
  const eventId = stringField(object, "event_id");
  if (eventId !== null) {
    return eventId;
  }
  return stringField(object, "entity_id");
}

/** `payload_hash` of an event, as frozen by the producer. */
function eventPayloadHash(event: JsonValue): Hash | null {
  const object = jsonObject(event);
  if (object === null) {
    return null;
  }
  const payloadHash = stringField(object, "payload_hash");
  return payloadHash !== null && isHash(payloadHash) ? payloadHash : null;
}

/** One event's commit metadata derived from a frame payload. */
interface FrameEventRecord {
  readonly event_id: string;
  readonly payload_hash: Hash;
  readonly blob_hashes: readonly Hash[];
}

/** Derives the per-member `commit_record` inputs of a frame in commit_seq order. */
export function frameEventRecords(
  payload: JournalFramePayload,
): JournalParseResult<readonly FrameEventRecord[]> {
  const records: FrameEventRecord[] = [];
  if (payload.schema_version === STATE_ROW_BATCH_SCHEMA_VERSION) {
    for (const member of payload.members) {
      const eventId = eventRecordId(member.event);
      if (eventId === null) {
        return err("missing_event_id", "event has neither event_id nor entity_id");
      }
      const payloadHash = eventPayloadHash(member.event);
      if (payloadHash === null) {
        return err("missing_payload_hash", "event has no valid payload_hash");
      }
      records.push({
        event_id: eventId,
        payload_hash: payloadHash,
        blob_hashes: member.blob_hashes
      });
    }
    return ok(records);
  }
  const eventId = eventRecordId(payload.event);
  if (eventId === null) {
    return err("missing_event_id", "event has neither event_id nor entity_id");
  }
  const payloadHash = eventPayloadHash(payload.event);
  if (payloadHash === null) {
    return err("missing_payload_hash", "event has no valid payload_hash");
  }
  records.push({
    event_id: eventId,
    payload_hash: payloadHash,
    blob_hashes: payload.blob_hashes
  });
  return ok(records);
}

/** One member's event identity and exact blob closure, aligned with commit_seq order. */
interface PayloadMemberBlobs {
  readonly event_id: string;
  readonly blob_hashes: readonly Hash[];
}

/** Per-member blob closure used to rebuild `blob_ref(owner_type='journal')`. */
export function payloadMemberBlobs(
  payload: JournalFramePayload,
): JournalParseResult<readonly PayloadMemberBlobs[]> {
  if (payload.schema_version !== STATE_ROW_BATCH_SCHEMA_VERSION) {
    const eventId = eventRecordId(payload.event);
    if (eventId === null) {
      return err("missing_event_id", "event has neither event_id nor entity_id");
    }
    return ok([{ event_id: eventId, blob_hashes: payload.blob_hashes }]);
  }
  const out: PayloadMemberBlobs[] = [];
  for (const member of payload.members) {
    const eventId = eventRecordId(member.event);
    if (eventId === null) {
      return err("missing_event_id", "event has neither event_id nor entity_id");
    }
    out.push({ event_id: eventId, blob_hashes: member.blob_hashes });
  }
  return ok(out);
}
