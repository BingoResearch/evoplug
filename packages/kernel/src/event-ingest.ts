/**
 * `event.ingest` — the single host event entry point (DD-FND-070, DD-FND-071).
 *
 * The handler is deliberately self-contained at the kernel seam:
 *
 *   validate EventDraft -> decode ContentUpload -> event_key / payload_hash
 *   -> duplicate check -> origin proof -> session/task/branch resolution
 *   -> scope re-read -> blob file + fsync -> journal frame + fsync
 *   -> SQLite projection (commit_record is written by the journal committer)
 *   -> IngestReceipt.
 *
 * Domain rules are not re-implemented here. Identity resolution goes through
 * the ledger `IdentityService` (structurally typed as
 * `EventIdentityResolver`); schema, hash, id and source-ref helpers come from
 * `@evoplug/core`; journal, blob and SQLite primitives come from
 * `@evoplug/storage`. The kernel only orders the documented steps and writes
 * the physical `event_log`, `input`, `run`, `session`, `task`, `branch`,
 * `native_id_map`, `blob` and `blob_ref` rows.
 *
 * The frozen `EventDraft` schema carries no requirement-op or fact payloads,
 * so this handler does not call `RequirementService` or `FactService`. Those
 * are separate post-ingest ledger services (DD-FND-074) that consume the
 * committed event id and binding.
 *
 * Fail-closed dependencies:
 *   - `proof` is required for `origin="human"`; without it the handler returns
 *     `E_EVENT_ORIGIN_UNVERIFIED` and never downgrades or fabricates a human.
 *   - a journal writer/committer is required; when it cannot be opened every
 *     call returns `E_INTERNAL` with `kernel.event_ingest_journal_unavailable`.
 *   - an active `config_profile` row (or a matching in-process config) is
 *     required for the binding; absence returns `E_VERSION_BINDING`.
 */

import { basename, join, } from "node:path";
import { type ContentUpload, type ErrorCategory, type ErrorCode, type ErrorDetails, type ErrorEnvelope, type ErrorSideEffect, type EventDraft, type FailureStatus, type Hash, type HostId, type Id, type IngestReceipt, type JsonValue, type NativeMessageKind, type Result, type SourceRef, type VersionBinding } from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  compareUtf8,
  formatSourceRef,
  hashBytes,
  isHash,
  isHostId,
  isHostMode,
  isId,
  isJsonValue,
  isWellFormedUnicode,
  isValidConfigVersion,
  isValidGoalVersion,
  newId,
  parseSourceRef
} from "@evoplug/core";
import type { IpcHandler } from "@evoplug/ipc";
import type {
  HumanAttestation,
  IdentityResolution,
  Origin,
  OriginBasis,
  OriginProofPort,
  TriggerLineage
} from "@evoplug/ledger";
import { goalSnapshotHash } from "@evoplug/ledger";
import type {
  JournalEventBody,
  JournalWriter,
  SqlRow,
  SqliteConnection,
  StatementSource,
  Tx
} from "@evoplug/storage";
import {
  BlobStore,
  JournalWriter as StorageJournalWriter,
  createJournalCommitter,
  listJournalStates,
  listActiveConfigProfiles
} from "@evoplug/storage";
import type { EvoplugConfig } from "./config.js";
import { computeConfigVersion } from "./config.js";
import { internalError } from "./errors.js";
import { resolveProjectIdForSession } from "./managed-roots.js";
import { homeLayout, type HomeLayout } from "./home.js";
import type { CommittedHostEvent } from "./online-pipeline.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Public dependency contract                                          */
/* ------------------------------------------------------------------ */

/**
 * The identity read face used by ingest. `IdentityService` satisfies this
 * shape; keeping the dependency narrow avoids forcing callers to construct a
 * full `LedgerPorts` graph just to ingest.
 */
interface EventIdentityResolver {
  resolve(input: {
    readonly host_id: HostId;
    readonly config_space: string;
    readonly native_session_id: string;
  }): Promise<Result<IdentityResolution, ErrorEnvelope>>;
}

export interface EventIngestDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: BlobStore;
  readonly config: EvoplugConfig;
  readonly now: () => number;
  readonly identity: EventIdentityResolver;
  /** HOST capability proof; required only for `origin="human"`. */
  readonly proof?: OriginProofPort;
  /** Shared single-writer journal. Opened from `home`/`layout` when omitted. */
  readonly journal?: JournalWriter;
  /** Value stored in `journal_state.relative_path`; derived when omitted. */
  readonly journal_relative_path?: string;
  readonly home?: string;
  readonly layout?: HomeLayout;
  /** JSON nesting limit for the inbound draft; DD-FND-071 default is 64. */
  readonly max_json_depth?: number;
  /** Decoded content limit; DD-FND-070 fixes it at 8 MiB. */
  readonly max_content_bytes?: number;
  /**
   * Optional post-commit hook (online RSI pipeline). It runs after the ACK is
   * produced and never changes the ACK: a rejection or throw is swallowed by
   * the handler, while the hook's own error sink reports it.
   */
  readonly post_commit?: (event: CommittedHostEvent) => void | Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const EVENT_DRAFT_SCHEMA_VERSION = "rsi.event_draft/1";
const EVENT_SCHEMA_VERSION = "rsi.event/1";
const JOURNAL_EVENT_SCHEMA_VERSION = "rsi.journal_event/1";
const HOST_EVENT_IDENTITY_SCHEMA_VERSION = "rsi.host_event_identity/1";
const STABLE_EVENT_SCOPE_SCHEMA_VERSION = "rsi.stable_event_scope/1";

const DEFAULT_MAX_JSON_DEPTH = 64;
const DEFAULT_MAX_CONTENT_BYTES = 8_388_608;
const MAX_TOOL_ARGUMENTS_BYTES = 1_048_576;
const MAX_ID_TEXT_LENGTH = 512;

const NATIVE_KINDS: readonly NativeMessageKind[] = [
  "message",
  "turn",
  "event",
  "prompt",
  "other"
];

const ORIGINS: readonly Origin[] = [
  "human",
  "user",
  "agent",
  "evaluator",
  "system",
  "host",
  "unknown"
];

const ORIGIN_BASES: readonly OriginBasis[] = [
  "host_typed_field",
  "host_tui_session",
  "host_capability",
  "explicit_event",
  "inferred_from_agent",
  "unavailable"
];

const TRIGGER_AXES: readonly TriggerLineage["axis"][] = [
  "external",
  "internal_evaluator",
  "internal_review",
  "unknown"
];

const SENDERS: readonly NativeAttribution["sender"][] = [
  "human",
  "agent",
  "tool",
  "system",
  "unknown"
];

const DIRECTIVE_STRENGTHS: readonly ("explicit" | "ambiguous")[] = ["explicit", "ambiguous"];
const MEDIA_TYPES: readonly ContentUpload["media_type"][] = [
  "text/plain;charset=utf-8",
  "application/json",
  "application/octet-stream"
];
const ENCODINGS: readonly ContentUpload["encoding"][] = ["utf8", "base64"];

const EVENT_DRAFT_KEYS: readonly string[] = [
  "schema_version",
  "host_id",
  "config_space",
  "mode",
  "native_session_id",
  "native_message_id",
  "native_event_id",
  "host_event",
  "native_kind",
  "source_seq",
  "occurred_at",
  "event_identity_key",
  "scope_claim",
  "origin",
  "origin_basis",
  "human_attestation",
  "trigger_lineage",
  "attribution",
  "payload"
];

const SCOPE_KEYS: readonly string[] = [
  "schema_version",
  "host_id",
  "config_space",
  "native_session_id",
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "watermark",
  "scope_hash"
];

const ATTESTATION_KEYS: readonly string[] = [
  "kind",
  "capability_id",
  "evidence_ref",
  "confirmed_at"
];

const TRIGGER_KEYS: readonly string[] = ["axis", "root_event_id", "depth"];
const ATTRIBUTION_KEYS: readonly string[] = ["sender", "typed_user_message", "typed_field_names"];
const CONTENT_KEYS: readonly string[] = ["media_type", "encoding", "data", "byte_length"];

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/* ------------------------------------------------------------------ */
/* Error helpers                                                       */
/* ------------------------------------------------------------------ */

interface Failure {
  readonly ok: false;
  readonly status: FailureStatus;
  readonly error: ErrorEnvelope;
}

function fail(error: ErrorEnvelope, status: FailureStatus = "rejected"): Failure {
  return { ok: false, status, error };
}

function schemaError(path: string, rule: string): ErrorEnvelope {
  return {
    schema_version: "rsi.error/1",
    code: "E_SCHEMA",
    category: "schema",
    retryable: false,
    side_effect: "none",
    message_key: "error.schema.invalid",
    details: { kind: "field", path, rule },
    stage: "schema_validate",
    trace_id: newId("ipc")
  };
}

function eventError(input: {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly stage: string;
  readonly message_key: string;
  readonly details?: ErrorDetails;
  readonly retryable?: boolean;
  readonly side_effect?: ErrorSideEffect;
}): ErrorEnvelope {
  return {
    schema_version: "rsi.error/1",
    code: input.code,
    category: input.category,
    retryable: input.retryable ?? false,
    side_effect: input.side_effect ?? "none",
    message_key: input.message_key,
    details: input.details ?? { kind: "none" },
    stage: input.stage,
    trace_id: newId("ipc")
  };
}

function eventKeyMismatch(_expected: string, _actual: string): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_KEY_MISMATCH",
    category: "conflict",
    stage: "event_key",
    message_key: "error.event.key_mismatch"
  });
}

function scopeRequired(): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_SCOPE_REQUIRED",
    category: "usage",
    stage: "event_scope",
    message_key: "error.event.scope_required"
  });
}

/**
 * Starts the post-commit hook without awaiting it. The ACK is already decided;
 * a pipeline failure must not turn a committed event into a rejection.
 */
function dispatchPostCommit(
  hook: EventIngestDeps["post_commit"],
  event: CommittedHostEvent
): void {
  if (hook === undefined) {
    return;
  }
  try {
    const pending = hook(event);
    if (pending !== undefined) {
      void pending.then(undefined, () => undefined);
    }
  } catch {
    // The hook owns its error reporting; ingest never fails after commit.
  }
}

function scopeForbidden(): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_SCOPE_FORBIDDEN",
    category: "usage",
    stage: "event_scope",
    message_key: "error.event.scope_forbidden"
  });
}

function scopeStale(_path: string, _expected: string, _actual: string): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_SCOPE_STALE",
    category: "version",
    stage: "event_scope",
    message_key: "error.event.scope_stale"
  });
}

function originUnverified(_detail: string): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_ORIGIN_UNVERIFIED",
    category: "authorization",
    stage: "event_ingest",
    message_key: "error.event.origin_unverified"
  });
}

function originConflict(_detail: string): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_ORIGIN_CONFLICT",
    category: "conflict",
    stage: "event_ingest",
    message_key: "error.event.origin_conflict"
  });
}

function retryInvalid(path: string, rule: string): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_RETRY_INVALID",
    category: "usage",
    stage: "event_ingest",
    message_key: "error.event.retry_invalid",
    details: { kind: "field", path, rule }
  });
}

function triggerLineageError(_rule: string): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_TRIGGER_LINEAGE",
    category: "conflict",
    stage: "event_ingest",
    message_key: "error.event.trigger_lineage"
  });
}

function tooLarge(path: string, limit: number): ErrorEnvelope {
  return eventError({
    code: "E_EVENT_TOO_LARGE",
    category: "schema",
    stage: "event_ingest",
    message_key: "error.event.too_large",
    details: { kind: "field", path, rule: `max_${String(limit)}_bytes` }
  });
}

function idempotencyConflict(
  key: string,
  existingHash: Hash,
  incomingHash: Hash
): ErrorEnvelope {
  return eventError({
    code: "E_IDEMPOTENCY_CONFLICT",
    category: "conflict",
    stage: "persist",
    message_key: "error.idempotency.conflict",
    details: {
      kind: "idempotency",
      key,
      existing_hash: existingHash,
      incoming_hash: incomingHash
    }
  });
}

function versionBindingError(expected: string, actual: string): ErrorEnvelope {
  return eventError({
    code: "E_VERSION_BINDING",
    category: "version",
    stage: "binding",
    message_key: "error.version.binding",
    details: { kind: "version", expected, actual }
  });
}

function cancelled(): ErrorEnvelope {
  return eventError({
    code: "E_CANCELLED",
    category: "deadline",
    stage: "request_control",
    message_key: "error.request.cancelled"
  });
}

/* ------------------------------------------------------------------ */
/* Small validation helpers                                            */
/* ------------------------------------------------------------------ */

function extraKey(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      return key;
    }
  }
  return null;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  minLength = 1,
  maxLength = Number.MAX_SAFE_INTEGER
): Result<string, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    return fail(schemaError(path, "string_length"));
  }
  return { ok: true, status: "ok", value };
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  minLength = 1,
  maxLength = MAX_ID_TEXT_LENGTH
): Result<string | undefined, ErrorEnvelope> {
  const value = record[key];
  if (value === undefined) {
    return { ok: true, status: "ok", value: undefined };
  }
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    return fail(schemaError(path, "string_length"));
  }
  return { ok: true, status: "ok", value };
}

function requiredInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): Result<number, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(schemaError(path, "safe_integer_range"));
  }
  return { ok: true, status: "ok", value };
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): Result<number | undefined, ErrorEnvelope> {
  const value = record[key];
  if (value === undefined) {
    return { ok: true, status: "ok", value: undefined };
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(schemaError(path, "safe_integer_range"));
  }
  return { ok: true, status: "ok", value };
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string
): Result<boolean, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "boolean") {
    return fail(schemaError(path, "boolean"));
  }
  return { ok: true, status: "ok", value };
}

function enumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  values: readonly T[]
): Result<T, ErrorEnvelope> {
  const value = record[key];
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) {
    return fail(schemaError(path, "closed_enum"));
  }
  return { ok: true, status: "ok", value: match };
}

function requiredHash(
  record: Record<string, unknown>,
  key: string,
  path: string
): Result<Hash, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "string" || !isHash(value)) {
    return fail(schemaError(path, "sha256_lower_hex"));
  }
  return { ok: true, status: "ok", value };
}

function requiredSourceRef(
  record: Record<string, unknown>,
  key: string,
  path: string
): Result<SourceRef, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "string") {
    return fail(schemaError(path, "source_ref"));
  }
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    return fail(schemaError(path, "source_ref"));
  }
  return { ok: true, status: "ok", value: parsed.value.source_ref };
}

function optionalSourceRef(
  record: Record<string, unknown>,
  key: string,
  path: string
): Result<SourceRef | undefined, ErrorEnvelope> {
  const value = record[key];
  if (value === undefined) {
    return { ok: true, status: "ok", value: undefined };
  }
  if (typeof value !== "string") {
    return fail(schemaError(path, "source_ref"));
  }
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    return fail(schemaError(path, "source_ref"));
  }
  return { ok: true, status: "ok", value: parsed.value.source_ref };
}

function requiredId<P extends IdPrefixName>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  prefix: P
): Result<Id<P>, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "string" || !isId(value, prefix)) {
    return fail(schemaError(path, `id_prefix_${prefix}`));
  }
  return { ok: true, status: "ok", value };
}

function optionalId<P extends IdPrefixName>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  prefix: P
): Result<Id<P> | undefined, ErrorEnvelope> {
  const value = record[key];
  if (value === undefined) {
    return { ok: true, status: "ok", value: undefined };
  }
  if (typeof value !== "string" || !isId(value, prefix)) {
    return fail(schemaError(path, `id_prefix_${prefix}`));
  }
  return { ok: true, status: "ok", value };
}

/** The id prefixes this module mints or validates. */
type IdPrefixName =
  | "ev"
  | "ipc"
  | "corr"
  | "task"
  | "br"
  | "sess"
  | "input"
  | "run"
  | "del"
  | "issue";

function jsonDepthExceeds(value: unknown, limit: number): boolean {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 1 }
  ];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    if (entry.depth > limit) {
      return true;
    }
    const current = entry.value;
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (seen.has(current)) {
      return true;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push({ value: item, depth: entry.depth + 1 });
      }
      continue;
    }
    for (const item of Object.values(current)) {
      stack.push({ value: item, depth: entry.depth + 1 });
    }
  }
  return false;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

/* ------------------------------------------------------------------ */
/* ContentUpload decoding                                              */
/* ------------------------------------------------------------------ */

interface StoredContent {
  readonly content_ref: SourceRef;
  readonly content_hash: Hash;
  readonly byte_length: number;
}

interface DecodedContent {
  readonly upload: ContentUpload;
  readonly bytes: Uint8Array;
  readonly stored: StoredContent;
}

function decodeBase64(text: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(text)) {
    return null;
  }
  const bytes = Buffer.from(text, "base64");
  if (Buffer.from(bytes).toString("base64") !== text) {
    return null;
  }
  return new Uint8Array(bytes);
}

function validateContentUpload(
  value: unknown,
  path: string
): Result<ContentUpload, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaError(path, "must_be_object"));
  }
  const extra = extraKey(value, CONTENT_KEYS);
  if (extra !== null) {
    return fail(schemaError(`${path}.${extra}`, "unknown_field"));
  }
  const mediaType = enumValue(value, "media_type", `${path}.media_type`, MEDIA_TYPES);
  if (!mediaType.ok) return mediaType;
  const encoding = enumValue(value, "encoding", `${path}.encoding`, ENCODINGS);
  if (!encoding.ok) return encoding;
  const data = requiredString(value, "data", `${path}.data`, 0, Number.MAX_SAFE_INTEGER);
  if (!data.ok) return data;
  const byteLength = requiredInteger(
    value,
    "byte_length",
    `${path}.byte_length`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (!byteLength.ok) return byteLength;
  return {
    ok: true,
    status: "ok",
    value: {
      media_type: mediaType.value,
      encoding: encoding.value,
      data: data.value,
      byte_length: byteLength.value
    }
  };
}

function decodeContent(
  upload: ContentUpload,
  path: string,
  maxBytes: number
): Result<DecodedContent, ErrorEnvelope> {
  if (upload.byte_length > maxBytes) {
    return fail(tooLarge(`${path}.byte_length`, maxBytes));
  }
  let bytes: Uint8Array;
  if (upload.encoding === "utf8") {
    if (!isWellFormedUnicode(upload.data)) {
      return fail(schemaError(`${path}.data`, "well_formed_utf8"));
    }
    bytes = new TextEncoder().encode(upload.data);
  } else {
    const decoded = decodeBase64(upload.data);
    if (decoded === null) {
      return fail(schemaError(`${path}.data`, "canonical_base64_padding"));
    }
    bytes = decoded;
  }
  if (bytes.byteLength !== upload.byte_length) {
    return fail(schemaError(`${path}.byte_length`, "decoded_length_mismatch"));
  }
  if (bytes.byteLength === 0) {
    // DD-FND-032 SourceRef ranges are half-open and require start < end.
    return fail(schemaError(`${path}.byte_length`, "empty_content_has_no_source_ref"));
  }
  const contentHash = hashBytes(bytes);
  const ref = formatSourceRef({
    scheme: "blob",
    locator: contentHash,
    start: 0,
    end: bytes.byteLength
  });
  if (!ref.ok) {
    return fail(ref.error);
  }
  return {
    ok: true,
    status: "ok",
    value: {
      upload,
      bytes,
      stored: {
        content_ref: ref.value,
        content_hash: contentHash,
        byte_length: bytes.byteLength
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* EventDraft validation                                              */
/* ------------------------------------------------------------------ */

interface NativeAttribution {
  readonly sender: "human" | "agent" | "tool" | "system" | "unknown";
  readonly typed_user_message: boolean;
  readonly typed_field_names: readonly string[];
}

type DraftPayload = EventDraft["payload"];

/**
 * The validated draft keeps the ledger's branded `HumanAttestation` and
 * `TriggerLineage` types. They are structurally subtypes of the generated
 * EventDraft fields but preserve `Id`/`SourceRef` narrowing for the proof port
 * and the envelope builder.
 */
interface ValidatedDraft extends EventDraft {
  readonly human_attestation?: HumanAttestation;
  readonly trigger_lineage: TriggerLineage;
}

type StoredPayload = DraftPayload extends infer P
  ? P extends { readonly content: ContentUpload }
    ? Omit<P, "content"> & { readonly content: StoredContent }
    : P
  : never;

interface ValidationOptions {
  readonly max_json_depth: number;
  readonly max_content_bytes: number;
}

function validateAttestation(value: unknown): Result<HumanAttestation, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaError("human_attestation", "must_be_object"));
  }
  const extra = extraKey(value, ATTESTATION_KEYS);
  if (extra !== null) {
    return fail(schemaError(`human_attestation.${extra}`, "unknown_field"));
  }
  const kind = enumValue(value, "kind", "human_attestation.kind", [
    "host_verified_interactive_user",
    "control_plane_explicit_confirmation"
  ] as const);
  if (!kind.ok) return kind;
  const capabilityId = requiredString(
    value,
    "capability_id",
    "human_attestation.capability_id",
    1,
    256
  );
  if (!capabilityId.ok) return capabilityId;
  const evidenceRef = requiredSourceRef(value, "evidence_ref", "human_attestation.evidence_ref");
  if (!evidenceRef.ok) return evidenceRef;
  const confirmedAt = requiredInteger(
    value,
    "confirmed_at",
    "human_attestation.confirmed_at",
    0
  );
  if (!confirmedAt.ok) return confirmedAt;
  return {
    ok: true,
    status: "ok",
    value: {
      kind: kind.value,
      capability_id: capabilityId.value,
      evidence_ref: evidenceRef.value,
      confirmed_at: confirmedAt.value
    }
  };
}

function validateTriggerLineage(value: unknown): Result<TriggerLineage, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaError("trigger_lineage", "must_be_object"));
  }
  const extra = extraKey(value, TRIGGER_KEYS);
  if (extra !== null) {
    return fail(schemaError(`trigger_lineage.${extra}`, "unknown_field"));
  }
  const axis = enumValue(value, "axis", "trigger_lineage.axis", TRIGGER_AXES);
  if (!axis.ok) return axis;
  const rootValue = value["root_event_id"];
  let rootEventId: Id<"ev"> | null = null;
  if (rootValue !== null) {
    if (typeof rootValue !== "string" || !isId(rootValue, "ev")) {
      return fail(schemaError("trigger_lineage.root_event_id", "null_or_ev_id"));
    }
    rootEventId = rootValue;
  }
  const depth = requiredInteger(value, "depth", "trigger_lineage.depth", 0, 64);
  if (!depth.ok) return depth;
  if (axis.value === "external" || axis.value === "unknown") {
    if (rootEventId !== null || depth.value !== 0) {
      return fail(triggerLineageError("external_null_root_zero_depth"));
    }
  } else if (rootEventId === null || depth.value < 1) {
    return fail(triggerLineageError("internal_root_and_depth"));
  }
  return {
    ok: true,
    status: "ok",
    value: { axis: axis.value, root_event_id: rootEventId, depth: depth.value }
  };
}

function validateAttribution(value: unknown): Result<NativeAttribution, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaError("attribution", "must_be_object"));
  }
  const extra = extraKey(value, ATTRIBUTION_KEYS);
  if (extra !== null) {
    return fail(schemaError(`attribution.${extra}`, "unknown_field"));
  }
  const sender = enumValue(value, "sender", "attribution.sender", SENDERS);
  if (!sender.ok) return sender;
  const typedUserMessage = requiredBoolean(
    value,
    "typed_user_message",
    "attribution.typed_user_message"
  );
  if (!typedUserMessage.ok) return typedUserMessage;
  const names = value["typed_field_names"];
  if (!Array.isArray(names)) {
    return fail(schemaError("attribution.typed_field_names", "array"));
  }
  const validated: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (typeof name !== "string" || name.length < 1 || name.length > 128) {
      return fail(schemaError(`attribution.typed_field_names[${String(index)}]`, "string_length"));
    }
    validated.push(name);
  }
  return {
    ok: true,
    status: "ok",
    value: {
      sender: sender.value,
      typed_user_message: typedUserMessage.value,
      typed_field_names: sortedUnique(validated)
    }
  };
}

function validateScopeClaim(value: unknown): Result<EventDraft["scope_claim"], ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaError("scope_claim", "must_be_object"));
  }
  const extra = extraKey(value, SCOPE_KEYS);
  if (extra !== null) {
    return fail(schemaError(`scope_claim.${extra}`, "unknown_field"));
  }
  if (value["schema_version"] !== STABLE_EVENT_SCOPE_SCHEMA_VERSION) {
    return fail(schemaError("scope_claim.schema_version", "const"));
  }
  const hostIdValue = value["host_id"];
  if (typeof hostIdValue !== "string" || !isHostId(hostIdValue)) {
    return fail(schemaError("scope_claim.host_id", "host_id"));
  }
  const configSpace = requiredString(value, "config_space", "scope_claim.config_space", 1, 128);
  if (!configSpace.ok) return configSpace;
  const nativeSessionId = requiredString(
    value,
    "native_session_id",
    "scope_claim.native_session_id",
    1,
    512
  );
  if (!nativeSessionId.ok) return nativeSessionId;
  const taskId = requiredId(value, "task_id", "scope_claim.task_id", "task");
  if (!taskId.ok) return taskId;
  const branchId = requiredId(value, "branch_id", "scope_claim.branch_id", "br");
  if (!branchId.ok) return branchId;
  const inputEpoch = requiredInteger(value, "input_epoch", "scope_claim.input_epoch", 1);
  if (!inputEpoch.ok) return inputEpoch;
  const goalVersion = requiredString(value, "goal_version", "scope_claim.goal_version", 1, 256);
  if (!goalVersion.ok) return goalVersion;
  if (!isValidGoalVersion(goalVersion.value)) {
    return fail(schemaError("scope_claim.goal_version", "goal_version"));
  }
  const configVersion = requiredString(
    value,
    "config_version",
    "scope_claim.config_version",
    1,
    128
  );
  if (!configVersion.ok) return configVersion;
  if (!isValidConfigVersion(configVersion.value)) {
    return fail(schemaError("scope_claim.config_version", "config_version"));
  }
  const watermark = requiredInteger(value, "watermark", "scope_claim.watermark", 0);
  if (!watermark.ok) return watermark;
  const scopeHash = requiredHash(value, "scope_hash", "scope_claim.scope_hash");
  if (!scopeHash.ok) return scopeHash;
  return {
    ok: true,
    status: "ok",
    value: {
      schema_version: STABLE_EVENT_SCOPE_SCHEMA_VERSION,
      host_id: hostIdValue,
      config_space: configSpace.value,
      native_session_id: nativeSessionId.value,
      task_id: taskId.value,
      branch_id: branchId.value,
      input_epoch: inputEpoch.value,
      goal_version: goalVersion.value,
      config_version: configVersion.value,
      watermark: watermark.value,
      scope_hash: scopeHash.value
    }
  };
}

function validatePayload(value: unknown, options: ValidationOptions): Result<DraftPayload, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaError("payload", "must_be_object"));
  }
  const kind = value["kind"];
  if (typeof kind !== "string") {
    return fail(schemaError("payload.kind", "closed_enum"));
  }
  switch (kind) {
    case "input.received": {
      const content = validateContentUpload(value["content"], "payload.content");
      if (!content.ok) return content;
      const directive = enumValue(
        value,
        "directive_strength",
        "payload.directive_strength",
        DIRECTIVE_STRENGTHS
      );
      if (!directive.ok) return directive;
      const parent = optionalString(value, "parent_native_id", "payload.parent_native_id", 1, 512);
      if (!parent.ok) return parent;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "input.received",
          content: content.value,
          directive_strength: directive.value,
          ...(parent.value === undefined ? {} : { parent_native_id: parent.value })
        }
      };
    }
    case "input.retry": {
      const retryOf = requiredHash(value, "retry_of_event_key", "payload.retry_of_event_key");
      if (!retryOf.ok) return retryOf;
      const reason = enumValue(value, "reason_code", "payload.reason_code", [
        "host_retry",
        "transport_retry"
      ] as const);
      if (!reason.ok) return reason;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "input.retry",
          retry_of_event_key: retryOf.value,
          reason_code: reason.value
        }
      };
    }
    case "agent.message": {
      const content = validateContentUpload(value["content"], "payload.content");
      if (!content.ok) return content;
      const phase = enumValue(value, "phase", "payload.phase", [
        "assistant",
        "tool_preface",
        "final"
      ] as const);
      if (!phase.ok) return phase;
      return {
        ok: true,
        status: "ok",
        value: { kind: "agent.message", content: content.value, phase: phase.value }
      };
    }
    case "tool.call": {
      const toolCallId = requiredString(value, "tool_call_id", "payload.tool_call_id", 1, 512);
      if (!toolCallId.ok) return toolCallId;
      const toolName = requiredString(value, "tool_name", "payload.tool_name", 1, 512);
      if (!toolName.ok) return toolName;
      const args = value["arguments_json"];
      if (!isJsonValue(args)) {
        return fail(schemaError("payload.arguments_json", "json_value"));
      }
      if (jsonDepthExceeds(args, options.max_json_depth)) {
        return fail(schemaError("payload.arguments_json", "json_depth"));
      }
      if (new TextEncoder().encode(canonicalJsonText(args)).byteLength > MAX_TOOL_ARGUMENTS_BYTES) {
        return fail(tooLarge("payload.arguments_json", MAX_TOOL_ARGUMENTS_BYTES));
      }
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "tool.call",
          tool_call_id: toolCallId.value,
          tool_name: toolName.value,
          arguments_json: args
        }
      };
    }
    case "tool.result": {
      const toolCallId = requiredString(value, "tool_call_id", "payload.tool_call_id", 1, 512);
      if (!toolCallId.ok) return toolCallId;
      const status = enumValue(value, "status", "payload.status", [
        "ok",
        "error",
        "unknown"
      ] as const);
      if (!status.ok) return status;
      const content = validateContentUpload(value["content"], "payload.content");
      if (!content.ok) return content;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "tool.result",
          tool_call_id: toolCallId.value,
          status: status.value,
          content: content.value
        }
      };
    }
    case "host.boundary": {
      const boundary = enumValue(value, "boundary", "payload.boundary", [
        "stop",
        "agent_end",
        "session_end",
        "error"
      ] as const);
      if (!boundary.ok) return boundary;
      const pending = requiredBoolean(
        value,
        "pending_work_claimed",
        "payload.pending_work_claimed"
      );
      if (!pending.ok) return pending;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "host.boundary",
          boundary: boundary.value,
          pending_work_claimed: pending.value
        }
      };
    }
    case "compaction.observed": {
      const compactionKind = enumValue(
        value,
        "compaction_kind",
        "payload.compaction_kind",
        ["auto", "manual", "host_summary"] as const
      );
      if (!compactionKind.ok) return compactionKind;
      const checkpointRef = optionalSourceRef(
        value,
        "checkpoint_ref",
        "payload.checkpoint_ref"
      );
      if (!checkpointRef.ok) return checkpointRef;
      let omittedRange: { readonly from_watermark: number; readonly to_watermark: number } | undefined;
      const rangeValue = value["omitted_range"];
      if (rangeValue !== undefined) {
        if (!isRecord(rangeValue)) {
          return fail(schemaError("payload.omitted_range", "must_be_object"));
        }
        const from = requiredInteger(
          rangeValue,
          "from_watermark",
          "payload.omitted_range.from_watermark",
          0
        );
        if (!from.ok) return from;
        const to = requiredInteger(
          rangeValue,
          "to_watermark",
          "payload.omitted_range.to_watermark",
          0
        );
        if (!to.ok) return to;
        if (from.value > to.value) {
          return fail(schemaError("payload.omitted_range", "from_le_to"));
        }
        omittedRange = { from_watermark: from.value, to_watermark: to.value };
      }
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "compaction.observed",
          compaction_kind: compactionKind.value,
          ...(checkpointRef.value === undefined ? {} : { checkpoint_ref: checkpointRef.value }),
          ...(omittedRange === undefined ? {} : { omitted_range: omittedRange })
        }
      };
    }
    case "subagent.started": {
      const nativeAgentId = requiredString(
        value,
        "native_agent_id",
        "payload.native_agent_id",
        1,
        512
      );
      if (!nativeAgentId.ok) return nativeAgentId;
      const relation = enumValue(value, "relation", "payload.relation", [
        "child",
        "sibling"
      ] as const);
      if (!relation.ok) return relation;
      const parentEventId = optionalId(value, "parent_event_id", "payload.parent_event_id", "ev");
      if (!parentEventId.ok) return parentEventId;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "subagent.started",
          native_agent_id: nativeAgentId.value,
          relation: relation.value,
          ...(parentEventId.value === undefined ? {} : { parent_event_id: parentEventId.value })
        }
      };
    }
    case "subagent.ended": {
      const nativeAgentId = requiredString(
        value,
        "native_agent_id",
        "payload.native_agent_id",
        1,
        512
      );
      if (!nativeAgentId.ok) return nativeAgentId;
      const status = enumValue(value, "status", "payload.status", [
        "ok",
        "error",
        "unknown"
      ] as const);
      if (!status.ok) return status;
      const summaryRef = optionalSourceRef(value, "summary_ref", "payload.summary_ref");
      if (!summaryRef.ok) return summaryRef;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "subagent.ended",
          native_agent_id: nativeAgentId.value,
          status: status.value,
          ...(summaryRef.value === undefined ? {} : { summary_ref: summaryRef.value })
        }
      };
    }
    case "delivery.receipt": {
      const deliveryId = requiredId(value, "delivery_id", "payload.delivery_id", "del");
      if (!deliveryId.ok) return deliveryId;
      const axis = enumValue(value, "axis", "payload.axis", [
        "transport",
        "inclusion",
        "adoption"
      ] as const);
      if (!axis.ok) return axis;
      // D3-DEFERRED: `independent_verifier` stays on the wire for forward
      // compatibility only. No production verifier exists, and accepting the
      // value grants no capability, raises no adoption axis and is never
      // promoted to verified evidence.
      const evidenceKind = enumValue(value, "evidence_kind", "payload.evidence_kind", [
        "hook_return_accepted",
        "context_projection_seen",
        "provider_payload_captured",
        "transport_body_captured",
        "host_confirmed",
        "behavior_observed",
        "independent_verifier"
      ] as const);
      if (!evidenceKind.ok) return evidenceKind;
      const evidenceRef = optionalSourceRef(value, "evidence_ref", "payload.evidence_ref");
      if (!evidenceRef.ok) return evidenceRef;
      const observedAt = requiredInteger(value, "observed_at", "payload.observed_at", 0);
      if (!observedAt.ok) return observedAt;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "delivery.receipt",
          delivery_id: deliveryId.value,
          axis: axis.value,
          evidence_kind: evidenceKind.value,
          ...(evidenceRef.value === undefined ? {} : { evidence_ref: evidenceRef.value }),
          observed_at: observedAt.value
        }
      };
    }
    case "feedback.observed": {
      const feedbackKind = enumValue(value, "feedback_kind", "payload.feedback_kind", [
        "correction",
        "dissatisfaction",
        "new_goal",
        "acceptance"
      ] as const);
      if (!feedbackKind.ok) return feedbackKind;
      const content = validateContentUpload(value["content"], "payload.content");
      if (!content.ok) return content;
      const targetIssueId = optionalId(
        value,
        "target_issue_id",
        "payload.target_issue_id",
        "issue"
      );
      if (!targetIssueId.ok) return targetIssueId;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "feedback.observed",
          feedback_kind: feedbackKind.value,
          content: content.value,
          ...(targetIssueId.value === undefined ? {} : { target_issue_id: targetIssueId.value })
        }
      };
    }
    case "ledger.correction": {
      const correctedRecordId = requiredString(
        value,
        "corrected_record_id",
        "payload.corrected_record_id",
        1,
        256
      );
      if (!correctedRecordId.ok) return correctedRecordId;
      const correctionKind = enumValue(
        value,
        "correction_kind",
        "payload.correction_kind",
        ["missed_extraction", "wrong_extraction", "wrong_link"] as const
      );
      if (!correctionKind.ok) return correctionKind;
      const originalSourceRef = requiredSourceRef(
        value,
        "original_source_ref",
        "payload.original_source_ref"
      );
      if (!originalSourceRef.ok) return originalSourceRef;
      const originalTextHash = requiredHash(
        value,
        "original_text_hash",
        "payload.original_text_hash"
      );
      if (!originalTextHash.ok) return originalTextHash;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "ledger.correction",
          corrected_record_id: correctedRecordId.value,
          correction_kind: correctionKind.value,
          original_source_ref: originalSourceRef.value,
          original_text_hash: originalTextHash.value
        }
      };
    }
    case "review.requested": {
      const issueIdsValue = value["issue_ids"];
      if (!Array.isArray(issueIdsValue)) {
        return fail(schemaError("payload.issue_ids", "array"));
      }
      const issueIds: Id<"issue">[] = [];
      for (let index = 0; index < issueIdsValue.length; index += 1) {
        const issueId = issueIdsValue[index];
        if (typeof issueId !== "string" || !isId(issueId, "issue")) {
          return fail(schemaError(`payload.issue_ids[${String(index)}]`, "id_prefix_issue"));
        }
        issueIds.push(issueId);
      }
      const scope = enumValue(value, "scope", "payload.scope", [
        "explicit_user",
        "explicit_host"
      ] as const);
      if (!scope.ok) return scope;
      return {
        ok: true,
        status: "ok",
        value: { kind: "review.requested", issue_ids: issueIds, scope: scope.value }
      };
    }
    case "capability.observed": {
      const capability = requiredString(value, "capability", "payload.capability", 1, 256);
      if (!capability.ok) return capability;
      const observedValue = enumValue(
        value,
        "observed_value",
        "payload.observed_value",
        ["present", "absent"] as const
      );
      if (!observedValue.ok) return observedValue;
      const evidenceRef = requiredSourceRef(value, "evidence_ref", "payload.evidence_ref");
      if (!evidenceRef.ok) return evidenceRef;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "capability.observed",
          capability: capability.value,
          observed_value: observedValue.value,
          evidence_ref: evidenceRef.value
        }
      };
    }
    case "config.applied": {
      const configVersion = requiredString(
        value,
        "config_version",
        "payload.config_version",
        1,
        128
      );
      if (!configVersion.ok) return configVersion;
      const configSpace = requiredString(
        value,
        "config_space",
        "payload.config_space",
        1,
        128
      );
      if (!configSpace.ok) return configSpace;
      const evidenceRef = requiredSourceRef(value, "evidence_ref", "payload.evidence_ref");
      if (!evidenceRef.ok) return evidenceRef;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "config.applied",
          config_version: configVersion.value,
          config_space: configSpace.value,
          evidence_ref: evidenceRef.value
        }
      };
    }
    case "identity.fork": {
      const sourceBranchId = requiredId(
        value,
        "source_branch_id",
        "payload.source_branch_id",
        "br"
      );
      if (!sourceBranchId.ok) return sourceBranchId;
      const atWatermark = requiredInteger(value, "at_watermark", "payload.at_watermark", 0);
      if (!atWatermark.ok) return atWatermark;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "identity.fork",
          source_branch_id: sourceBranchId.value,
          at_watermark: atWatermark.value
        }
      };
    }
    case "identity.resume": {
      const sessionId = requiredId(value, "session_id", "payload.session_id", "sess");
      if (!sessionId.ok) return sessionId;
      const observedWatermark = requiredInteger(
        value,
        "observed_watermark",
        "payload.observed_watermark",
        0
      );
      if (!observedWatermark.ok) return observedWatermark;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "identity.resume",
          session_id: sessionId.value,
          observed_watermark: observedWatermark.value
        }
      };
    }
    case "host.unclassified": {
      const nativeType = requiredString(value, "native_type", "payload.native_type", 1, 128);
      if (!nativeType.ok) return nativeType;
      const content = validateContentUpload(value["content"], "payload.content");
      if (!content.ok) return content;
      const reasonCode = enumValue(value, "reason_code", "payload.reason_code", [
        "no_mapping",
        "unsupported_version"
      ] as const);
      if (!reasonCode.ok) return reasonCode;
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "host.unclassified",
          native_type: nativeType.value,
          content: content.value,
          reason_code: reasonCode.value
        }
      };
    }
    default:
      return fail(schemaError("payload.kind", "closed_enum"));
  }
}

function validateDraft(
  value: unknown,
  options: ValidationOptions
): Result<ValidatedDraft, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaError("$", "must_be_object"));
  }
  if (jsonDepthExceeds(value, options.max_json_depth)) {
    return fail(schemaError("$", "json_depth"));
  }
  const extra = extraKey(value, EVENT_DRAFT_KEYS);
  if (extra !== null) {
    return fail(schemaError(extra, "unknown_field"));
  }
  if (value["schema_version"] !== EVENT_DRAFT_SCHEMA_VERSION) {
    return fail(schemaError("schema_version", "const"));
  }
  // Size is an ingress guard and precedes field-level attribution validation:
  // an over-limit body is rejected as `E_EVENT_TOO_LARGE` even when unrelated
  // optional fields are absent.
  const earlyPayload = value["payload"];
  if (isRecord(earlyPayload)) {
    const earlyContent = earlyPayload["content"];
    if (isRecord(earlyContent)) {
      const earlyLength = earlyContent["byte_length"];
      if (
        typeof earlyLength === "number" &&
        Number.isSafeInteger(earlyLength) &&
        earlyLength > options.max_content_bytes
      ) {
        return fail(tooLarge("payload.content.byte_length", options.max_content_bytes));
      }
    }
  }
  const hostIdValue = value["host_id"];
  if (typeof hostIdValue !== "string" || !isHostId(hostIdValue)) {
    return fail(schemaError("host_id", "host_id"));
  }
  const configSpace = requiredString(value, "config_space", "config_space", 1, 128);
  if (!configSpace.ok) return configSpace;
  const modeValue = value["mode"];
  if (typeof modeValue !== "string" || !isHostMode(modeValue)) {
    return fail(schemaError("mode", "host_mode"));
  }
  const nativeSessionId = requiredString(
    value,
    "native_session_id",
    "native_session_id",
    1,
    512
  );
  if (!nativeSessionId.ok) return nativeSessionId;
  const nativeMessageId = optionalString(
    value,
    "native_message_id",
    "native_message_id",
    1,
    512
  );
  if (!nativeMessageId.ok) return nativeMessageId;
  const nativeEventId = optionalString(value, "native_event_id", "native_event_id", 1, 512);
  if (!nativeEventId.ok) return nativeEventId;
  const hostEvent = requiredString(value, "host_event", "host_event", 1, 128);
  if (!hostEvent.ok) return hostEvent;
  const nativeKind = enumValue(value, "native_kind", "native_kind", NATIVE_KINDS);
  if (!nativeKind.ok) return nativeKind;
  const sourceSeq = optionalInteger(value, "source_seq", "source_seq", 0);
  if (!sourceSeq.ok) return sourceSeq;
  const occurredAt = requiredInteger(value, "occurred_at", "occurred_at", 0);
  if (!occurredAt.ok) return occurredAt;
  const eventIdentityKey = requiredHash(value, "event_identity_key", "event_identity_key");
  if (!eventIdentityKey.ok) return eventIdentityKey;

  let scopeClaim: EventDraft["scope_claim"];
  if (value["scope_claim"] !== undefined) {
    const scope = validateScopeClaim(value["scope_claim"]);
    if (!scope.ok) return scope;
    if (scope.value === undefined) {
      return fail(schemaError("scope_claim", "must_be_object"));
    }
    scopeClaim = scope.value;
  }

  const origin = enumValue(value, "origin", "origin", ORIGINS);
  if (!origin.ok) return origin;
  const originBasis = enumValue(value, "origin_basis", "origin_basis", ORIGIN_BASES);
  if (!originBasis.ok) return originBasis;

  let humanAttestation: HumanAttestation | undefined;
  if (value["human_attestation"] !== undefined) {
    const attestation = validateAttestation(value["human_attestation"]);
    if (!attestation.ok) return attestation;
    humanAttestation = attestation.value;
  }

  const triggerLineage = validateTriggerLineage(value["trigger_lineage"]);
  if (!triggerLineage.ok) return triggerLineage;
  const attribution = validateAttribution(value["attribution"]);
  if (!attribution.ok) return attribution;
  const payload = validatePayload(value["payload"], options);
  if (!payload.ok) return payload;

  const isInput = payload.value.kind === "input.received" || payload.value.kind === "input.retry";
  if (isInput && scopeClaim !== undefined) {
    return fail(scopeForbidden());
  }
  if (!isInput && scopeClaim === undefined) {
    return fail(scopeRequired());
  }

  if (origin.value === "unknown") {
    if (originBasis.value !== "unavailable") {
      return fail(originConflict("unknown_requires_unavailable"));
    }
    if (attribution.value.sender !== "unknown") {
      return fail(originConflict("unknown_requires_unknown_sender"));
    }
  }
  if (origin.value === "human") {
    if (humanAttestation === undefined) {
      return fail(originUnverified("missing_human_attestation"));
    }
    if (humanAttestation.kind !== "host_verified_interactive_user") {
      return fail(originUnverified("host_event_requires_interactive_attestation"));
    }
    if (originBasis.value !== "host_capability") {
      return fail(originConflict("human_requires_host_capability"));
    }
  } else if (humanAttestation !== undefined) {
    return fail(originConflict("attestation_on_non_human_origin"));
  }
  if (origin.value === "host" && originBasis.value !== "host_capability") {
    return fail(originConflict("host_requires_host_capability"));
  }
  if (origin.value === "evaluator") {
    if (originBasis.value !== "explicit_event") {
      return fail(originConflict("evaluator_requires_explicit_event"));
    }
    if (triggerLineage.value.axis !== "internal_evaluator" && triggerLineage.value.axis !== "internal_review") {
      return fail(triggerLineageError("evaluator_requires_internal_axis"));
    }
  }
  if (origin.value === "user") {
    if (
      originBasis.value !== "host_typed_field" &&
      originBasis.value !== "host_tui_session" &&
      // A host hook that fires only for user-sourced messages (OpenHands SDK
      // `UserPromptSubmit`) proves intent without a typed field. It is weaker
      // than a typed field and stronger than a process check.
      originBasis.value !== "host_capability" &&
      originBasis.value !== "explicit_event"
    ) {
      return fail(originConflict("user_requires_typed_field_or_explicit_event"));
    }
    if (!attribution.value.typed_user_message && attribution.value.sender !== "human") {
      return fail(originConflict("user_requires_typed_or_explicit_role"));
    }
  }
  if (
    (origin.value === "agent" ||
      origin.value === "evaluator" ||
      origin.value === "system" ||
      origin.value === "host") &&
    attribution.value.typed_user_message
  ) {
    return fail(originConflict("non_user_origin_typed_user_message"));
  }
  if (
    originBasis.value === "inferred_from_agent" &&
    origin.value !== "agent" &&
    origin.value !== "unknown"
  ) {
    return fail(originConflict("inferred_from_agent_origin"));
  }

  return {
    ok: true,
    status: "ok",
    value: {
      schema_version: EVENT_DRAFT_SCHEMA_VERSION,
      host_id: hostIdValue,
      config_space: configSpace.value,
      mode: modeValue,
      native_session_id: nativeSessionId.value,
      ...(nativeMessageId.value === undefined ? {} : { native_message_id: nativeMessageId.value }),
      ...(nativeEventId.value === undefined ? {} : { native_event_id: nativeEventId.value }),
      host_event: hostEvent.value,
      native_kind: nativeKind.value,
      ...(sourceSeq.value === undefined ? {} : { source_seq: sourceSeq.value }),
      occurred_at: occurredAt.value,
      event_identity_key: eventIdentityKey.value,
      ...(scopeClaim === undefined ? {} : { scope_claim: scopeClaim }),
      origin: origin.value,
      origin_basis: originBasis.value,
      ...(humanAttestation === undefined ? {} : { human_attestation: humanAttestation }),
      trigger_lineage: triggerLineage.value,
      attribution: attribution.value,
      payload: payload.value
    }
  };
}

/* ------------------------------------------------------------------ */
/* Stored payload construction                                         */
/* ------------------------------------------------------------------ */

interface StoredPayloadBundle {
  readonly payload: StoredPayload;
  readonly content: StoredContent | null;
  readonly bytes: Uint8Array | null;
}

function storePayload(
  payload: DraftPayload,
  options: ValidationOptions
): Result<StoredPayloadBundle, ErrorEnvelope> {
  switch (payload.kind) {
    case "input.received": {
      const decoded = decodeContent(payload.content, "payload.content", options.max_content_bytes);
      if (!decoded.ok) return decoded;
      return {
        ok: true,
        status: "ok",
        value: {
          payload: { ...payload, content: decoded.value.stored },
          content: decoded.value.stored,
          bytes: decoded.value.bytes
        }
      };
    }
    case "agent.message": {
      const decoded = decodeContent(payload.content, "payload.content", options.max_content_bytes);
      if (!decoded.ok) return decoded;
      return {
        ok: true,
        status: "ok",
        value: {
          payload: { ...payload, content: decoded.value.stored },
          content: decoded.value.stored,
          bytes: decoded.value.bytes
        }
      };
    }
    case "tool.result": {
      const decoded = decodeContent(payload.content, "payload.content", options.max_content_bytes);
      if (!decoded.ok) return decoded;
      return {
        ok: true,
        status: "ok",
        value: {
          payload: { ...payload, content: decoded.value.stored },
          content: decoded.value.stored,
          bytes: decoded.value.bytes
        }
      };
    }
    case "feedback.observed": {
      const decoded = decodeContent(payload.content, "payload.content", options.max_content_bytes);
      if (!decoded.ok) return decoded;
      return {
        ok: true,
        status: "ok",
        value: {
          payload: { ...payload, content: decoded.value.stored },
          content: decoded.value.stored,
          bytes: decoded.value.bytes
        }
      };
    }
    case "host.unclassified": {
      const decoded = decodeContent(payload.content, "payload.content", options.max_content_bytes);
      if (!decoded.ok) return decoded;
      return {
        ok: true,
        status: "ok",
        value: {
          payload: { ...payload, content: decoded.value.stored },
          content: decoded.value.stored,
          bytes: decoded.value.bytes
        }
      };
    }
    default:
      return {
        ok: true,
        status: "ok",
        value: { payload, content: null, bytes: null }
      };
  }
}

/* ------------------------------------------------------------------ */
/* Identity and hash preimages                                        */
/* ------------------------------------------------------------------ */

function eventKeyFor(draft: ValidatedDraft): Hash {
  return canonicalHash({
    schema_version: HOST_EVENT_IDENTITY_SCHEMA_VERSION,
    host_id: draft.host_id,
    config_space: draft.config_space,
    mode: draft.mode,
    native_session_id: draft.native_session_id,
    native_kind: draft.native_kind,
    host_event: draft.host_event,
    native_message_id: draft.native_message_id ?? null,
    native_event_id: draft.native_event_id ?? null,
    source_seq: draft.source_seq ?? null,
    occurred_at: draft.occurred_at
  });
}

function attestationJson(attestation: HumanAttestation): JsonValue {
  return {
    kind: attestation.kind,
    capability_id: attestation.capability_id,
    evidence_ref: attestation.evidence_ref,
    confirmed_at: attestation.confirmed_at
  };
}

function triggerLineageJson(lineage: TriggerLineage): JsonValue {
  return {
    axis: lineage.axis,
    root_event_id: lineage.root_event_id,
    depth: lineage.depth
  };
}

function attributionJson(attribution: NativeAttribution): JsonValue {
  return {
    sender: attribution.sender,
    typed_user_message: attribution.typed_user_message,
    typed_field_names: [...attribution.typed_field_names]
  };
}

function payloadHashFor(draft: ValidatedDraft, storedPayload: StoredPayload): Result<Hash, ErrorEnvelope> {
  if (!isJsonValue(storedPayload)) {
    return fail(schemaError("payload", "json_value"));
  }
  const preimage: JsonValue = {
    schema_version: draft.schema_version,
    host_id: draft.host_id,
    config_space: draft.config_space,
    mode: draft.mode,
    native_session_id: draft.native_session_id,
    native_kind: draft.native_kind,
    host_event: draft.host_event,
    native_message_id: draft.native_message_id ?? null,
    native_event_id: draft.native_event_id ?? null,
    source_seq: draft.source_seq ?? null,
    occurred_at: draft.occurred_at,
    origin: draft.origin,
    origin_basis: draft.origin_basis,
    human_attestation:
      draft.human_attestation === undefined ? null : attestationJson(draft.human_attestation),
    trigger_lineage: triggerLineageJson(draft.trigger_lineage),
    attribution: attributionJson(draft.attribution),
    payload: storedPayload
  };
  return { ok: true, status: "ok", value: canonicalHash(preimage) };
}

function scopeHashFor(scope: {
  readonly host_id: HostId;
  readonly config_space: string;
  readonly native_session_id: string;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
}): Hash {
  return canonicalHash({
    schema_version: STABLE_EVENT_SCOPE_SCHEMA_VERSION,
    host_id: scope.host_id,
    config_space: scope.config_space,
    native_session_id: scope.native_session_id,
    task_id: scope.task_id,
    branch_id: scope.branch_id,
    input_epoch: scope.input_epoch,
    goal_version: scope.goal_version,
    config_version: scope.config_version,
    watermark: scope.watermark
  });
}

/* ------------------------------------------------------------------ */
/* SQL row shapes and reads                                           */
/* ------------------------------------------------------------------ */

type SessionRow = SqlRow & {
  readonly session_id: Id<"sess">;
  readonly host_id: string;
  readonly config_space: string;
  readonly external_session_id: string | null;
  readonly current_branch_id:Id<"br"> | null;
  readonly resume_generation: number;
};

type BranchRow = SqlRow & {
  readonly branch_id: Id<"br">;
  readonly task_id: Id<"task">;
  readonly current_goal_version: string;
  readonly current_goal_revision: number;
};

type InputRow = SqlRow & {
  readonly input_id: Id<"input">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly session_id: Id<"sess">;
  readonly input_epoch: number;
  readonly origin: string;
  readonly human_attestation_json: string | null;
  readonly directive_strength: string;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly receipt_seq: number;
};

type EventLogRow = SqlRow & {
  readonly event_id: string;
  readonly event_key: Hash;
  readonly commit_seq: number;
  readonly event_type: string;
  readonly task_id: string | null;
  readonly branch_id: string | null;
  readonly session_id: string;
  readonly input_id: string | null;
  readonly input_epoch: number | null;
  readonly goal_version: string | null;
  readonly config_version: string | null;
  readonly watermark: number;
  readonly payload_hash: Hash;
  readonly content_hash: Hash | null;
  readonly source_seq: number | null;
  readonly origin: string;
  readonly correlation_id: Id<"corr">;
};

type NativeMapRow = SqlRow & {
  readonly session_id: Id<"sess">;
  readonly input_id: Id<"input">;
  readonly source_event_id: Id<"ev">;
  readonly native_kind: string;
  readonly native_message_id: string;
};

type LatestInputRow = SqlRow & {
  readonly input_id: Id<"input">;
  readonly input_epoch: number;
  readonly receipt_seq: number;
};

function one<Row extends SqlRow>(
  source: StatementSource,
  sql: string,
  params?: Readonly<Record<string, unknown>>
): Row | undefined {
  return source.prepare<Row>(sql).get(params);
}

function all<Row extends SqlRow>(
  source: StatementSource,
  sql: string,
  params?: Readonly<Record<string, unknown>>
): Row[] {
  return source.prepare<Row>(sql).all(params);
}

function readEventByKey(connection: SqliteConnection, eventKey: Hash): EventLogRow | undefined {
  return one<EventLogRow>(
    connection,
    `SELECT event_id, event_key, commit_seq, event_type, task_id, branch_id, session_id,
            input_id, input_epoch, goal_version, config_version, watermark, payload_hash,
            content_hash, source_seq, origin, correlation_id
       FROM event_log
      WHERE event_key = :event_key`,
    { event_key: eventKey }
  );
}

function readEventById(connection: SqliteConnection, eventId: Id<"ev">): EventLogRow | undefined {
  return one<EventLogRow>(
    connection,
    `SELECT event_id, event_key, commit_seq, event_type, task_id, branch_id, session_id,
            input_id, input_epoch, goal_version, config_version, watermark, payload_hash,
            content_hash, source_seq, origin, correlation_id
       FROM event_log
      WHERE event_id = :event_id`,
    { event_id: eventId }
  );
}

function receiptFromRow(row: EventLogRow, duplicate: boolean): Result<IngestReceipt, ErrorEnvelope> {
  if (row.task_id === null || row.branch_id === null) {
    return fail(internalError("kernel.event_ingest_event_log_missing_identity"));
  }
  if (row.goal_version === null || row.config_version === null) {
    return fail(internalError("kernel.event_ingest_event_log_missing_binding"));
  }
  return {
    ok: true,
    status: "ok",
    value: {
      event_id: row.event_id,
      event_key: row.event_key,
      commit_seq: Number(row.commit_seq),
      watermark: Number(row.watermark),
      duplicate,
      task_id: row.task_id,
      branch_id: row.branch_id,
      session_id: row.session_id,
      ...(row.input_id === null ? {} : { input_id: row.input_id }),
      ...(row.input_epoch === null ? {} : { input_epoch: Number(row.input_epoch) }),
      goal_version: row.goal_version,
      config_version: row.config_version
    }
  };
}

/* ------------------------------------------------------------------ */
/* Branch state                                                       */
/* ------------------------------------------------------------------ */

interface BranchState {
  readonly session_id: Id<"sess">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly goal_version: string;
  readonly goal_revision: number;
  readonly config_version: string;
  readonly resume_generation: number;
  readonly session_exists: boolean;
  readonly branch_exists: boolean;
  readonly latest_input_id: Id<"input"> | null;
  readonly latest_input_epoch: number;
  readonly watermark: number;
}

function readActiveConfigVersion(
  connection: SqliteConnection,
  configSpace: string,
  config: EvoplugConfig
): Result<string, ErrorEnvelope> {
  const rows = listActiveConfigProfiles(connection, configSpace);
  if (rows.length === 1) {
    const row = rows[0];
    if (row === undefined) {
      return fail(internalError("kernel.event_ingest_config_row_missing"));
    }
    return { ok: true, status: "ok", value: row.config_version };
  }
  if (rows.length > 1) {
    return fail(internalError("kernel.event_ingest_config_multiple_active"));
  }
  if (config.config_space === configSpace) {
    return { ok: true, status: "ok", value: computeConfigVersion(config) };
  }
  return fail(versionBindingError("active_config_profile", configSpace));
}

function readSession(
  connection: SqliteConnection,
  input: {
    readonly session_id?: Id<"sess">;
    readonly host_id: HostId;
    readonly config_space: string;
    readonly native_session_id: string;
  }
): SessionRow | undefined {
  if (input.session_id !== undefined) {
    return one<SessionRow>(
      connection,
      `SELECT session_id, host_id, config_space, external_session_id, current_branch_id,
              resume_generation
         FROM session
        WHERE session_id = :session_id`,
      { session_id: input.session_id }
    );
  }
  return one<SessionRow>(
    connection,
    `SELECT session_id, host_id, config_space, external_session_id, current_branch_id,
            resume_generation
       FROM session
      WHERE host_id = :host_id
        AND config_space = :config_space
        AND external_session_id = :native_session_id`,
    {
      host_id: input.host_id,
      config_space: input.config_space,
      native_session_id: input.native_session_id
    }
  );
}

function readLatestInput(
  connection: SqliteConnection,
  branchId: Id<"br">
): LatestInputRow | undefined {
  return one<LatestInputRow>(
    connection,
    `SELECT input_id, input_epoch, receipt_seq
       FROM input
      WHERE branch_id = :branch_id
      ORDER BY input_epoch DESC
      LIMIT 1`,
    { branch_id: branchId }
  );
}

function loadBranchState(
  connection: SqliteConnection,
  draft: ValidatedDraft,
  resolution: IdentityResolution,
  configVersion: string,
  now: number
): Result<BranchState, ErrorEnvelope> {
  if (resolution.state === "ambiguous") {
    return fail(
      versionBindingError(
        "single_branch",
        (resolution.candidates ?? []).map((candidate) => candidate.branch_id).join(",")
      )
    );
  }
  if (resolution.state === "stale") {
    return fail(versionBindingError("resolved_session", resolution.reason_code));
  }

  const sessionRow = readSession(connection, {
    ...(resolution.session_id === undefined ? {} : { session_id: resolution.session_id }),
    host_id: draft.host_id,
    config_space: draft.config_space,
    native_session_id: draft.native_session_id
  });

  if (sessionRow !== undefined) {
    if (
      sessionRow.host_id !== draft.host_id ||
      sessionRow.config_space !== draft.config_space ||
      sessionRow.external_session_id !== draft.native_session_id
    ) {
      return fail(internalError("kernel.event_ingest_session_conflict"));
    }
    const branchIdCandidate =
      resolution.state === "resolved" && resolution.branch_id !== undefined
        ? resolution.branch_id
        : sessionRow.current_branch_id;
    if (branchIdCandidate !== null) {
      if (!isId(branchIdCandidate, "br")) {
        return fail(internalError("kernel.event_ingest_branch_id_invalid"));
      }
      const branchId = branchIdCandidate;
      const branch = one<BranchRow>(
        connection,
        `SELECT branch_id, task_id, current_goal_version, current_goal_revision
           FROM branch
          WHERE branch_id = :branch_id`,
        { branch_id: branchId }
      );
      if (branch === undefined) {
        return fail(internalError("kernel.event_ingest_branch_missing"));
      }
      if (
        resolution.state === "resolved" &&
        (resolution.task_id === undefined || resolution.task_id !== branch.task_id)
      ) {
        return fail(internalError("kernel.event_ingest_task_branch_mismatch"));
      }
      const latest = readLatestInput(connection, branch.branch_id);
      return {
        ok: true,
        status: "ok",
        value: {
          session_id: sessionRow.session_id,
          task_id: branch.task_id,
          branch_id: branch.branch_id,
          goal_version: branch.current_goal_version,
          goal_revision: Number(branch.current_goal_revision),
          config_version: configVersion,
          resume_generation: Number(sessionRow.resume_generation),
          session_exists: true,
          branch_exists: true,
          latest_input_id: latest === undefined ? null : latest.input_id,
          latest_input_epoch: latest === undefined ? 0 : Number(latest.input_epoch),
          watermark: latest === undefined ? 0 : Number(latest.receipt_seq)
        }
      };
    }

    // Existing session with no branch yet: create a fresh task/branch.
    const taskId = newId("task", now);
    const newBranchId = newId("br", now);
    return {
      ok: true,
      status: "ok",
      value: {
        session_id: sessionRow.session_id,
        task_id: taskId,
        branch_id: newBranchId,
        goal_version: makeGoalVersion(newBranchId),
        goal_revision: 1,
        config_version: configVersion,
        resume_generation: Number(sessionRow.resume_generation),
        session_exists: true,
        branch_exists: false,
        latest_input_id: null,
        latest_input_epoch: 0,
        watermark: 0
      }
    };
  }

  if (resolution.state !== "not_found") {
    return fail(internalError("kernel.event_ingest_resolution_missing_session"));
  }

  const taskId = newId("task", now);
  const branchId = newId("br", now);
  const sessionId = newId("sess", now);
  return {
    ok: true,
    status: "ok",
    value: {
      session_id: sessionId,
      task_id: taskId,
      branch_id: branchId,
      goal_version: makeGoalVersion(branchId),
      goal_revision: 1,
      config_version: configVersion,
      resume_generation: 1,
      session_exists: false,
      branch_exists: false,
      latest_input_id: null,
      latest_input_epoch: 0,
      watermark: 0
    }
  };
}

function makeGoalVersion(branchId: Id<"br">): string {
  return `gv:${branchId}:1`;
}

/* ------------------------------------------------------------------ */
/* Scope re-read                                                      */
/* ------------------------------------------------------------------ */

interface AuthoritativeScope {
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
}

function readAuthoritativeScope(
  connection: SqliteConnection,
  state: BranchState
): Result<AuthoritativeScope, ErrorEnvelope> {
  const session = one<SessionRow>(
    connection,
    `SELECT session_id, host_id, config_space, external_session_id, current_branch_id,
            resume_generation
       FROM session
      WHERE session_id = :session_id`,
    { session_id: state.session_id }
  );
  if (session === undefined) {
    return fail(scopeStale("scope_claim.task_id", state.task_id, "session_missing"));
  }
  if (
    session.external_session_id === null ||
    (session.current_branch_id !== null && session.current_branch_id !== state.branch_id)
  ) {
    return fail(scopeStale("scope_claim.branch_id", state.branch_id, "session_branch_mismatch"));
  }
  const branch = one<BranchRow>(
    connection,
    `SELECT branch_id, task_id, current_goal_version, current_goal_revision
       FROM branch
      WHERE branch_id = :branch_id`,
    { branch_id: state.branch_id }
  );
  if (branch === undefined) {
    return fail(scopeStale("scope_claim.branch_id", state.branch_id, "branch_missing"));
  }
  if (branch.task_id !== state.task_id) {
    return fail(scopeStale("scope_claim.task_id", state.task_id, branch.task_id));
  }
  const latest = readLatestInput(connection, state.branch_id);
  if (latest === undefined) {
    return fail(scopeStale("scope_claim.input_epoch", "1", "0"));
  }
  return {
    ok: true,
    status: "ok",
    value: {
      input_epoch: Number(latest.input_epoch),
      goal_version: branch.current_goal_version,
      config_version: state.config_version,
      watermark: Number(latest.receipt_seq)
    }
  };
}

function assertScopeClaim(
  draft: ValidatedDraft,
  state: BranchState,
  scope: AuthoritativeScope
): Failure | null {
  const claim = draft.scope_claim;
  if (claim === undefined) {
    return fail(scopeRequired());
  }
  if (claim.host_id !== draft.host_id) {
    return fail(scopeStale("scope_claim.host_id", draft.host_id, claim.host_id));
  }
  if (claim.config_space !== draft.config_space) {
    return fail(scopeStale("scope_claim.config_space", draft.config_space, claim.config_space));
  }
  if (claim.native_session_id !== draft.native_session_id) {
    return fail(
      scopeStale("scope_claim.native_session_id", draft.native_session_id, claim.native_session_id)
    );
  }
  if (claim.task_id !== state.task_id) {
    return fail(scopeStale("scope_claim.task_id", state.task_id, claim.task_id));
  }
  if (claim.branch_id !== state.branch_id) {
    return fail(scopeStale("scope_claim.branch_id", state.branch_id, claim.branch_id));
  }
  if (claim.input_epoch !== scope.input_epoch) {
    return fail(
      scopeStale("scope_claim.input_epoch", String(scope.input_epoch), String(claim.input_epoch))
    );
  }
  if (claim.goal_version !== scope.goal_version) {
    return fail(
      scopeStale("scope_claim.goal_version", scope.goal_version, claim.goal_version)
    );
  }
  if (claim.config_version !== scope.config_version) {
    return fail(
      scopeStale("scope_claim.config_version", scope.config_version, claim.config_version)
    );
  }
  if (claim.watermark !== scope.watermark) {
    return fail(scopeStale("scope_claim.watermark", String(scope.watermark), String(claim.watermark)));
  }
  const recomputed = scopeHashFor({
    host_id: claim.host_id,
    config_space: claim.config_space,
    native_session_id: claim.native_session_id,
    task_id: claim.task_id,
    branch_id: claim.branch_id,
    input_epoch: claim.input_epoch,
    goal_version: claim.goal_version,
    config_version: claim.config_version,
    watermark: claim.watermark
  });
  if (recomputed !== claim.scope_hash) {
    return fail(scopeStale("scope_claim.scope_hash", recomputed, claim.scope_hash));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Receipt sequence                                                   */
/* ------------------------------------------------------------------ */

function nextReceiptSeq(connection: SqliteConnection): Result<number, ErrorEnvelope> {
  const meta = one<{ readonly value: string }>(
    connection,
    "SELECT value FROM schema_meta WHERE key = 'receipt_seq'"
  );
  const metaValue = meta === undefined ? 0 : Number(meta.value);
  const inputMax = one<{ readonly value: number | null }>(
    connection,
    "SELECT MAX(receipt_seq) AS value FROM input"
  );
  const inputValue = inputMax === undefined || inputMax.value === null ? 0 : Number(inputMax.value);
  const candidate = Math.max(
    Number.isSafeInteger(metaValue) && metaValue >= 0 ? metaValue : 0,
    Number.isSafeInteger(inputValue) && inputValue >= 0 ? inputValue : 0
  );
  if (!Number.isSafeInteger(candidate) || candidate >= Number.MAX_SAFE_INTEGER) {
    return fail(internalError("kernel.event_ingest_receipt_seq_exhausted"));
  }
  return { ok: true, status: "ok", value: candidate + 1 };
}

/* ------------------------------------------------------------------ */
/* Retry, lineage and native-id helpers                               */
/* ------------------------------------------------------------------ */

function readNativeMapping(
  connection: SqliteConnection,
  sessionId: Id<"sess">,
  hostId: HostId,
  configSpace: string,
  nativeKind: NativeMessageKind,
  nativeMessageId: string
): NativeMapRow | undefined {
  return one<NativeMapRow>(
    connection,
    `SELECT session_id, input_id, source_event_id, native_kind, native_message_id
       FROM native_id_map
      WHERE session_id = :session_id
        AND host_id = :host_id
        AND config_space = :config_space
        AND native_kind = :native_kind
        AND native_message_id = :native_message_id`,
    {
      session_id: sessionId,
      host_id: hostId,
      config_space: configSpace,
      native_kind: nativeKind,
      native_message_id: nativeMessageId
    }
  );
}

function lookupNativeMapping(
  connection: SqliteConnection,
  sessionId: Id<"sess">,
  hostId: HostId,
  configSpace: string,
  nativeMessageId: string
): NativeMapRow | undefined {
  return one<NativeMapRow>(
    connection,
    `SELECT session_id, input_id, source_event_id, native_kind, native_message_id
       FROM native_id_map
      WHERE session_id = :session_id
        AND host_id = :host_id
        AND config_space = :config_space
        AND native_message_id = :native_message_id
      ORDER BY native_kind ASC
      LIMIT 1`,
    {
      session_id: sessionId,
      host_id: hostId,
      config_space: configSpace,
      native_message_id: nativeMessageId
    }
  );
}

function lookupNativeInput(
  connection: SqliteConnection,
  sessionId: Id<"sess">,
  hostId: HostId,
  configSpace: string,
  nativeMessageId: string
): Id<"input"> | null {
  const mapping = lookupNativeMapping(
    connection,
    sessionId,
    hostId,
    configSpace,
    nativeMessageId
  );
  return mapping === undefined ? null : mapping.input_id;
}

function readInputById(connection: SqliteConnection, inputId: Id<"input">): InputRow | undefined {
  return one<InputRow>(
    connection,
    `SELECT input_id, task_id, branch_id, session_id, input_epoch, origin,
            human_attestation_json, directive_strength, content_ref, content_hash, receipt_seq
       FROM input
      WHERE input_id = :input_id`,
    { input_id: inputId }
  );
}

function checkTriggerLineage(
  connection: SqliteConnection,
  draft: ValidatedDraft,
  state: BranchState
): Failure | null {
  const rootEventId = draft.trigger_lineage.root_event_id;
  if (rootEventId === null) {
    return null;
  }
  const root = readEventById(connection, rootEventId);
  if (root === undefined) {
    return fail(triggerLineageError("root_event_missing"), "conflict");
  }
  if (root.task_id === null || root.task_id !== state.task_id) {
    return fail(triggerLineageError("root_event_cross_task"), "conflict");
  }
  return null;
}

interface RetryPlan {
  readonly input_id: Id<"input">;
  readonly input_epoch: number;
  readonly directive_strength: "explicit" | "ambiguous";
  readonly watermark: number;
  readonly next_attempt: number;
}

function validateRetry(
  connection: SqliteConnection,
  draft: ValidatedDraft,
  state: BranchState
): Result<RetryPlan, ErrorEnvelope> {
  if (draft.payload.kind !== "input.retry") {
    return fail(retryInvalid("payload.kind", "input_retry"));
  }
  const retryOf = draft.payload.retry_of_event_key;
  if (!isHash(retryOf)) {
    return fail(retryInvalid("payload.retry_of_event_key", "sha256_lower_hex"));
  }
  const original = readEventByKey(connection, retryOf);
  if (original === undefined || original.event_type !== "input.received") {
    return fail(retryInvalid("payload.retry_of_event_key", "existing_input_received"));
  }
  if (original.session_id !== state.session_id) {
    return fail(retryInvalid("payload.retry_of_event_key", "same_session"));
  }
  if (original.task_id !== state.task_id || original.branch_id !== state.branch_id) {
    return fail(retryInvalid("payload.retry_of_event_key", "same_task_branch"));
  }
  if (original.origin !== draft.origin) {
    return fail(retryInvalid("origin", "equals_original_origin"));
  }
  if (
    draft.source_seq !== undefined &&
    original.source_seq !== null &&
    draft.source_seq !== original.source_seq
  ) {
    return fail(retryInvalid("source_seq", "equals_original_source_seq"));
  }
  if (original.input_id === null) {
    return fail(retryInvalid("payload.retry_of_event_key", "original_input_missing"));
  }
  if (!isId(original.input_id, "input")) {
    return fail(retryInvalid("payload.retry_of_event_key", "original_input_id"));
  }
  const input = readInputById(connection, original.input_id);
  if (input === undefined) {
    return fail(retryInvalid("payload.retry_of_event_key", "original_input_row_missing"));
  }
  if (original.content_hash === null || original.content_hash !== input.content_hash) {
    return fail(retryInvalid("payload.retry_of_event_key", "content_hash"));
  }

  const mappings = all<NativeMapRow>(
    connection,
    `SELECT session_id, input_id, source_event_id, native_kind, native_message_id
       FROM native_id_map
      WHERE input_id = :input_id
      ORDER BY native_kind ASC, native_message_id ASC`,
    { input_id: input.input_id }
  );
  if (mappings.length > 0) {
    const kindMatches = mappings.some((row) => row.native_kind === draft.native_kind);
    if (!kindMatches) {
      return fail(retryInvalid("native_kind", "equals_original_native_kind"));
    }
    if (draft.native_message_id !== undefined) {
      const messageMatches = mappings.some(
        (row) => row.native_message_id === draft.native_message_id
      );
      if (!messageMatches) {
        return fail(retryInvalid("native_message_id", "equals_original_native_message_id"));
      }
    }
  }
  if (draft.native_message_id !== undefined) {
    const direct = lookupNativeMapping(
      connection,
      state.session_id,
      draft.host_id,
      draft.config_space,
      draft.native_message_id
    );
    if (direct !== undefined && direct.input_id !== input.input_id) {
      return fail(retryInvalid("native_message_id", "maps_to_original_input"));
    }
  }

  const attemptRow = one<{ readonly attempt: number | null }>(
    connection,
    "SELECT MAX(attempt) AS attempt FROM run WHERE input_id = :input_id",
    { input_id: input.input_id }
  );
  const maxAttempt =
    attemptRow === undefined || attemptRow.attempt === null ? 0 : Number(attemptRow.attempt);
  if (!Number.isSafeInteger(maxAttempt) || maxAttempt < 0) {
    return fail(internalError("kernel.event_ingest_retry_attempt_invalid"));
  }
  const directive = DIRECTIVE_STRENGTHS.find(
    (candidate) => candidate === input.directive_strength
  );
  if (directive === undefined) {
    return fail(internalError("kernel.event_ingest_retry_directive_invalid"));
  }
  return {
    ok: true,
    status: "ok",
    value: {
      input_id: input.input_id,
      input_epoch: Number(input.input_epoch),
      directive_strength: directive,
      watermark: Number(input.receipt_seq),
      next_attempt: maxAttempt + 1
    }
  };
}

function checkBlobRow(
  connection: SqliteConnection,
  content: StoredContent
): Failure | null {
  const row = one<{ readonly blob_hash: string; readonly byte_length: number }>(
    connection,
    "SELECT blob_hash, byte_length FROM blob WHERE blob_hash = :blob_hash",
    { blob_hash: content.content_hash }
  );
  if (row !== undefined && Number(row.byte_length) !== content.byte_length) {
    return fail(
      {
        schema_version: "rsi.error/1",
        code: "E_SOURCE_HASH",
        category: "source",
        retryable: false,
        side_effect: "none",
        message_key: "error.source.hash",
        details: {
          kind: "source",
          source_ref: content.content_ref,
          reason: "hash_mismatch"
        },
        stage: "source_verify",
        trace_id: newId("ipc")
      },
      "conflict"
    );
  }
  return null;
}

function resolveParentEventId(
  connection: SqliteConnection,
  draft: ValidatedDraft,
  state: BranchState
): Id<"ev"> | null {
  if (draft.payload.kind === "subagent.started" && draft.payload.parent_event_id !== undefined) {
    const parentEventId = draft.payload.parent_event_id;
    return isId(parentEventId, "ev") ? parentEventId : null;
  }
  if (draft.payload.kind === "input.received" && draft.payload.parent_native_id !== undefined) {
    const mapping = lookupNativeMapping(
      connection,
      state.session_id,
      draft.host_id,
      draft.config_space,
      draft.payload.parent_native_id
    );
    return mapping === undefined ? null : mapping.source_event_id;
  }
  if (
    draft.trigger_lineage.axis === "internal_evaluator" ||
    draft.trigger_lineage.axis === "internal_review"
  ) {
    return draft.trigger_lineage.root_event_id;
  }
  return null;
}

interface JournalSetup {
  readonly writer: JournalWriter | null;
  readonly relative_path: string;
  readonly error: ErrorEnvelope | null;
}

function createJournalSetup(deps: EventIngestDeps): JournalSetup {
  if (deps.journal !== undefined) {
    return {
      writer: deps.journal,
      relative_path: deps.journal_relative_path ?? basename(deps.journal.filePath),
      error: null
    };
  }
  const layout = deps.layout ?? homeLayout(deps.home ?? deps.config.product_home);
  try {
    const states = listJournalStates(deps.connection);
    const latest = states[states.length - 1];
    const journalId = latest?.journal_id ?? "journal-000001";
    const relativePath = latest?.relative_path ?? "journal-000001.rsij";
    const opened = StorageJournalWriter.open({
      file_path: join(layout.journal_dir, relativePath),
      journal_id: journalId,
      last_commit_seq: latest?.last_commit_seq ?? 0,
      // Fail closed on an era recovery has not made writable. Without the
      // persisted prefix a fresh process would reuse the sequence of a frame
      // that was fsynced before its SQLite transaction.
      trusted_prefix_end: latest?.trusted_prefix_end ?? 0,
      read_only: latest?.read_only === 1,
      tail_state: latest?.tail_state ?? "clean"
    });
    if (!opened.ok) {
      return {
        writer: null,
        relative_path: relativePath,
        error: internalError("kernel.event_ingest_journal_unavailable")
      };
    }
    return { writer: opened.value, relative_path: relativePath, error: null };
  } catch {
    return {
      writer: null,
      relative_path: "journal-000001.rsij",
      error: internalError("kernel.event_ingest_journal_unavailable")
    };
  }
}

/* ------------------------------------------------------------------ */
/* Projection                                                         */
/* ------------------------------------------------------------------ */

interface ProjectionInput {
  readonly draft: ValidatedDraft;
  readonly state: BranchState;
  readonly event_id: Id<"ev">;
  readonly event_key: Hash;
  readonly commit_seq: number;
  readonly journal_id: string;
  readonly correlation_id: Id<"corr">;
  readonly parent_event_id: Id<"ev"> | null;
  readonly watermark: number;
  readonly input_id: Id<"input"> | null;
  readonly run_id: Id<"run"> | null;
  readonly run_attempt: number | null;
  readonly input_epoch: number | null;
  readonly input_origin: Origin;
  readonly directive_strength: "explicit" | "ambiguous" | null;
  readonly parent_input_id: Id<"input"> | null;
  readonly content: StoredContent | null;
  readonly content_relative_path: string | null;
  readonly payload_text: string;
  readonly payload_hash: Hash;
  readonly received_at: number;
  readonly now: number;
  readonly is_new_input: boolean;
  readonly is_retry: boolean;
}

function projectEvent(tx: Tx, input: ProjectionInput): void {
  const draft = input.draft;

  if (!input.state.session_exists) {
    tx.prepare(
      `INSERT INTO session (
         session_id, host_id, config_space, external_session_id, current_branch_id,
         resume_generation, started_at, last_seen_at
       ) VALUES (
         :session_id, :host_id, :config_space, :native_session_id, :branch_id,
         1, :now, :now
       )`
    ).run({
      session_id: input.state.session_id,
      host_id: draft.host_id,
      config_space: draft.config_space,
      native_session_id: draft.native_session_id,
      branch_id: input.state.branch_id,
      now: input.now
    });
  } else {
    tx.prepare(
      `UPDATE session
          SET current_branch_id = :branch_id,
              last_seen_at = :now
        WHERE session_id = :session_id`
    ).run({
      branch_id: input.state.branch_id,
      now: input.now,
      session_id: input.state.session_id
    });
  }

  if (!input.state.branch_exists) {
    // A branch is created together with its baseline goal snapshot. The
    // as-of ledger projection (`projectRequirementsAsOf`) refuses a binding
    // whose goal version has no snapshot (`E_LEDGER_ASOF_UNAVAILABLE`), and
    // the snapshot only used to appear when the first requirement op changed
    // the goal. A branch whose first requirements stay `proposed` therefore
    // made the online pipeline unreadable.
    const goalSnapshotId = newId("gsnap", input.now);
    const activeRequirementIds: Id<"req">[] = [];
    // Appendix M.1: a new task belongs to the project whose registered
    // instructions root contains the host session's working directory. An
    // unmatched session stays on the user scope and gets no instructions
    // candidates.
    const projectId = resolveProjectIdForSession(tx, {
      host_id: draft.host_id,
      config_space: draft.config_space,
      native_session_id: draft.native_session_id
    });
    tx.prepare(
      `INSERT INTO task (task_id, project_id, root_task_id, parent_task_id, created_at, updated_at)
       VALUES (:task_id, :project_id, :task_id, NULL, :now, :now)`
    ).run({ task_id: input.state.task_id, project_id: projectId, now: input.now });
    tx.prepare(
      `INSERT INTO branch (
         branch_id, task_id, parent_branch_id, forked_from_watermark,
         inherited_goal_snapshot_id, current_goal_version, current_goal_revision,
         current_goal_snapshot_id, created_at, updated_at
       ) VALUES (
         :branch_id, :task_id, NULL, NULL, NULL, :goal_version, 1, NULL, :now, :now
       )`
    ).run({
      branch_id: input.state.branch_id,
      task_id: input.state.task_id,
      goal_version: input.state.goal_version,
      now: input.now
    });
    tx.prepare(
      `INSERT INTO goal_snapshot (
         snapshot_id, task_id, source_branch_id, source_goal_version,
         local_goal_version, local_goal_revision, watermark,
         active_requirement_ids_json, snapshot_hash, created_at
       ) VALUES (
         :snapshot_id, :task_id, :branch_id, :goal_version,
         :goal_version, 1, :watermark,
         :active_requirement_ids_json, :snapshot_hash, :now
       )`
    ).run({
      snapshot_id: goalSnapshotId,
      task_id: input.state.task_id,
      branch_id: input.state.branch_id,
      goal_version: input.state.goal_version,
      watermark: input.watermark,
      active_requirement_ids_json: canonicalJsonText(activeRequirementIds),
      snapshot_hash: goalSnapshotHash({
        task_id: input.state.task_id,
        source_branch_id: input.state.branch_id,
        source_goal_version: input.state.goal_version,
        local_goal_version: input.state.goal_version,
        local_goal_revision: 1,
        watermark: input.watermark,
        active_requirement_ids: activeRequirementIds
      }),
      now: input.now
    });
    tx.prepare(
      `UPDATE branch SET current_goal_snapshot_id = :snapshot_id WHERE branch_id = :branch_id`
    ).run({ snapshot_id: goalSnapshotId, branch_id: input.state.branch_id });
  } else {
    tx.prepare(
      `UPDATE branch
          SET updated_at = :now
        WHERE branch_id = :branch_id`
    ).run({ now: input.now, branch_id: input.state.branch_id });
  }

  if (input.draft.payload.kind === "input.received") {
    tx.prepare(
      `UPDATE run
          SET state = 'interrupted',
              ended_at = :now
        WHERE state IN ('started', 'active')
          AND input_id IN (
            SELECT input_id FROM input WHERE branch_id = :branch_id
          )`
    ).run({ now: input.now, branch_id: input.state.branch_id });
  } else if (input.is_retry && input.input_id !== null) {
    tx.prepare(
      `UPDATE run
          SET state = 'interrupted',
              ended_at = :now
        WHERE state IN ('started', 'active')
          AND input_id = :input_id`
    ).run({ now: input.now, input_id: input.input_id });
  }

  if (input.is_new_input && input.input_id !== null) {
    if (input.input_epoch === null || input.directive_strength === null || input.content === null) {
      throw internalError("kernel.event_ingest_input_projection_incomplete");
    }
    tx.prepare(
      `INSERT INTO input (
         input_id, task_id, branch_id, session_id, input_epoch, parent_input_id,
         origin, human_attestation_json, directive_strength, content_ref, content_hash,
         received_at, receipt_seq
       ) VALUES (
         :input_id, :task_id, :branch_id, :session_id, :input_epoch, :parent_input_id,
         :origin, :human_attestation_json, :directive_strength, :content_ref, :content_hash,
         :received_at, :receipt_seq
       )`
    ).run({
      input_id: input.input_id,
      task_id: input.state.task_id,
      branch_id: input.state.branch_id,
      session_id: input.state.session_id,
      input_epoch: input.input_epoch,
      parent_input_id: input.parent_input_id,
      origin: input.input_origin,
      human_attestation_json:
        draft.human_attestation === undefined
          ? null
          : canonicalJsonText(attestationJson(draft.human_attestation)),
      directive_strength: input.directive_strength,
      content_ref: input.content.content_ref,
      content_hash: input.content.content_hash,
      received_at: input.received_at,
      receipt_seq: input.watermark
    });
  }

  if (input.run_id !== null) {
    if (input.input_id === null || input.run_attempt === null) {
      throw internalError("kernel.event_ingest_run_projection_incomplete");
    }
    tx.prepare(
      `INSERT INTO run (
         run_id, input_id, session_id, attempt, state, started_at, ended_at
       ) VALUES (
         :run_id, :input_id, :session_id, :attempt, 'started', :now, NULL
       )`
    ).run({
      run_id: input.run_id,
      input_id: input.input_id,
      session_id: input.state.session_id,
      attempt: input.run_attempt,
      now: input.now
    });
  }

  if (input.is_new_input && input.input_id !== null && draft.native_message_id !== undefined) {
    tx.prepare(
      `INSERT INTO native_id_map (
         session_id, host_id, config_space, native_kind, native_message_id,
         input_id, source_event_id, first_seen_at
       ) VALUES (
         :session_id, :host_id, :config_space, :native_kind, :native_message_id,
         :input_id, :source_event_id, :now
       )
       ON CONFLICT(session_id, host_id, config_space, native_kind, native_message_id)
       DO NOTHING`
    ).run({
      session_id: input.state.session_id,
      host_id: draft.host_id,
      config_space: draft.config_space,
      native_kind: draft.native_kind,
      native_message_id: draft.native_message_id,
      input_id: input.input_id,
      source_event_id: input.event_id,
      now: input.now
    });
  }

  if (input.content !== null) {
    if (input.content_relative_path === null) {
      throw internalError("kernel.event_ingest_blob_relative_path_missing");
    }
    tx.prepare(
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
    ).run({
      blob_hash: input.content.content_hash,
      byte_length: input.content.byte_length,
      relative_path: input.content_relative_path,
      now: input.now
    });

    tx.prepare(
      `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
       VALUES (:blob_hash, 'event', :owner_id, :source_ref, :now)
       ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
    ).run({
      blob_hash: input.content.content_hash,
      owner_id: input.event_id,
      source_ref: input.content.content_ref,
      now: input.now
    });
    tx.prepare(
      `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
       VALUES (:blob_hash, 'journal', :owner_id, :source_ref, :now)
       ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
    ).run({
      blob_hash: input.content.content_hash,
      owner_id: input.event_id,
      source_ref: input.content.content_ref,
      now: input.now
    });
  }

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
       :received_at, :origin, :origin_basis, :human_attestation_json, :trigger_axis,
       :trigger_root_event_id, :trigger_depth, :host_id, :config_space, :session_id,
       :task_id, :branch_id, :input_id, :run_id, :input_epoch, :goal_version,
       :config_version, :watermark, :source_seq, :correlation_id, :parent_event_id,
       NULL, :content_ref, :content_hash, :content_bytes, :payload_hash, :payload_text
     )`
  ).run({
    event_id: input.event_id,
    event_key: input.event_key,
    commit_seq: input.commit_seq,
    journal_id: input.journal_id,
    event_type: draft.payload.kind,
    occurred_at: draft.occurred_at,
    received_at: input.received_at,
    origin: draft.origin,
    origin_basis: draft.origin_basis,
    human_attestation_json:
      draft.human_attestation === undefined
        ? null
        : canonicalJsonText(attestationJson(draft.human_attestation)),
    trigger_axis: draft.trigger_lineage.axis,
    trigger_root_event_id: draft.trigger_lineage.root_event_id,
    trigger_depth: draft.trigger_lineage.depth,
    host_id: draft.host_id,
    config_space: draft.config_space,
    session_id: input.state.session_id,
    task_id: input.state.task_id,
    branch_id: input.state.branch_id,
    // A retry reuses the original input and creates only a new run; the
    // event row carries no second input occurrence.
    input_id: input.is_retry ? null : input.input_id,
    run_id: input.run_id,
    input_epoch: input.input_epoch,
    goal_version: input.state.goal_version,
    config_version: input.state.config_version,
    watermark: input.watermark,
    source_seq: draft.source_seq ?? null,
    correlation_id: input.correlation_id,
    parent_event_id: input.parent_event_id,
    content_ref: input.content === null ? null : input.content.content_ref,
    content_hash: input.content === null ? null : input.content.content_hash,
    content_bytes: input.content === null ? null : input.content.byte_length,
    payload_hash: input.payload_hash,
    payload_text: input.payload_text
  });

  if (input.is_new_input) {
    tx.prepare(
      `INSERT INTO schema_meta (key, value, updated_at)
       VALUES ('receipt_seq', :value, :now)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run({ value: String(input.watermark), now: input.now });
  }
}

/* ------------------------------------------------------------------ */
/* Handler                                                            */
/* ------------------------------------------------------------------ */

interface EventPlan {
  readonly state: BranchState;
  readonly input_id: Id<"input"> | null;
  readonly input_epoch: number | null;
  readonly directive_strength: "explicit" | "ambiguous" | null;
  readonly parent_input_id: Id<"input"> | null;
  readonly run_id: Id<"run"> | null;
  readonly run_attempt: number | null;
  readonly watermark: number;
  readonly is_new_input: boolean;
  readonly is_retry: boolean;
}

export function createEventIngestHandler(deps: EventIngestDeps): IpcHandler<"event.ingest"> {
  const options: ValidationOptions = {
    max_json_depth: deps.max_json_depth ?? DEFAULT_MAX_JSON_DEPTH,
    max_content_bytes: deps.max_content_bytes ?? DEFAULT_MAX_CONTENT_BYTES
  };
  const setup = createJournalSetup(deps);
  const committer =
    setup.writer === null
      ? null
      : createJournalCommitter({
          writer: setup.writer,
          connection: deps.connection,
          relative_path: setup.relative_path,
          now: deps.now
        });

  // Serialises the authoritative check -> blob -> journal -> projection
  // critical section. JavaScript is single-threaded, but handlers await the
  // origin proof; the gate keeps two ingests from interleaving their event_key
  // check, commit_seq allocation and receipt_seq allocation.
  let gateTail: Promise<void> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = gateTail.then(fn, fn);
    gateTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  return async (context): Promise<Result<IngestReceipt, ErrorEnvelope>> => {
    if (context.signal.aborted) {
      return fail(cancelled());
    }
    if (setup.error !== null || committer === null || setup.writer === null) {
      return fail(setup.error ?? internalError("kernel.event_ingest_journal_unavailable"));
    }
    const writer = setup.writer;
    const params: unknown = context.params;
    if (!isRecord(params)) {
      return fail(schemaError("params", "must_be_object"));
    }
    const validated = validateDraft(params["draft"], options);
    if (!validated.ok) {
      return validated;
    }
    const draft = validated.value;

    const eventKey = eventKeyFor(draft);
    if (eventKey !== draft.event_identity_key) {
      return fail(eventKeyMismatch(eventKey, draft.event_identity_key), "conflict");
    }

    const stored = storePayload(draft.payload, options);
    if (!stored.ok) {
      return stored;
    }
    const content = stored.value.content;
    const bytes = stored.value.bytes;
    const payloadHash = payloadHashFor(draft, stored.value.payload);
    if (!payloadHash.ok) {
      return payloadHash;
    }

    const duplicate = readEventByKey(deps.connection, eventKey);
    if (duplicate !== undefined) {
      if (duplicate.payload_hash !== payloadHash.value) {
        // An explicit retry may collide on identity with the event it retries
        // (same native ids/source_seq). Its retry semantics (origin, session,
        // task/branch, content) must be classified before the idempotency
        // conflict is reported, so the normal path below validates it first.
        if (draft.payload.kind !== "input.retry") {
          return fail(
            idempotencyConflict(eventKey, duplicate.payload_hash, payloadHash.value),
            "conflict"
          );
        }
      } else {
        return receiptFromRow(duplicate, true);
      }
    }

    if (draft.origin === "human") {
      const attestation = draft.human_attestation;
      if (attestation === undefined) {
        return fail(originUnverified("missing_human_attestation"));
      }
      if (deps.proof === undefined) {
        return fail(originUnverified("origin_proof_port_unavailable"));
      }
      let verdict: "verified" | "unverified" | "conflict";
      try {
        verdict = await deps.proof.verifyHuman({
          attestation,
          host_id: draft.host_id,
          config_space: draft.config_space,
          native_session_id: draft.native_session_id,
          event_key: eventKey
        });
      } catch {
        return fail(originUnverified("origin_proof_unretrievable"));
      }
      if (verdict === "conflict") {
        return fail(originConflict("origin_proof_conflict"), "conflict");
      }
      if (verdict !== "verified") {
        return fail(originUnverified("origin_proof_unverified"));
      }
    }

    return serialized(async (): Promise<Result<IngestReceipt, ErrorEnvelope>> => {
      const receivedAt = deps.now();

      // Re-check under the writer gate: a concurrent ingest may have committed
      // the same event_key while the proof was pending.
      const existing = readEventByKey(deps.connection, eventKey);
      if (existing !== undefined) {
        if (existing.payload_hash !== payloadHash.value) {
          if (draft.payload.kind !== "input.retry") {
            return fail(
              idempotencyConflict(eventKey, existing.payload_hash, payloadHash.value),
              "conflict"
            );
          }
        } else {
          return receiptFromRow(existing, true);
        }
      }

      const resolutionResult = await deps.identity.resolve({
        host_id: draft.host_id,
        config_space: draft.config_space,
        native_session_id: draft.native_session_id
      });
      if (!resolutionResult.ok) {
        return resolutionResult;
      }
      const resolution = resolutionResult.value;

      const configVersion = readActiveConfigVersion(
        deps.connection,
        draft.config_space,
        deps.config
      );
      if (!configVersion.ok) {
        return configVersion;
      }

      const stateResult = loadBranchState(
        deps.connection,
        draft,
        resolution,
        configVersion.value,
        receivedAt
      );
      if (!stateResult.ok) {
        return stateResult;
      }
      const state = stateResult.value;

      const payloadKind = draft.payload.kind;
      const isInputReceived = payloadKind === "input.received";
      const isRetry = payloadKind === "input.retry";
      const isInputEvent = isInputReceived || isRetry;

      // Retry classification runs before any duplicate/idempotency decision
      // and before any write, so an illegal retry is never reported as a
      // generic event-key conflict.
      let retryPlan: RetryPlan | null = null;
      if (isRetry) {
        if (!state.session_exists) {
          return fail(retryInvalid("payload.retry_of_event_key", "original_input_missing"));
        }
        const retry = validateRetry(deps.connection, draft, state);
        if (!retry.ok) {
          return retry;
        }
        retryPlan = retry.value;
        if (existing !== undefined && existing.payload_hash !== payloadHash.value) {
          return fail(
            idempotencyConflict(eventKey, existing.payload_hash, payloadHash.value),
            "conflict"
          );
        }
      }

      if (!isInputEvent) {
        if (!state.session_exists || !state.branch_exists || state.latest_input_epoch < 1) {
          return fail(scopeStale("scope_claim.input_epoch", "1", String(state.latest_input_epoch)));
        }
        const scope = readAuthoritativeScope(deps.connection, state);
        if (!scope.ok) {
          return scope;
        }
        const scopeFailure = assertScopeClaim(draft, state, scope.value);
        if (scopeFailure !== null) {
          return scopeFailure;
        }
      }

      const triggerFailure = checkTriggerLineage(deps.connection, draft, state);
      if (triggerFailure !== null) {
        return triggerFailure;
      }

      let plan: EventPlan;
      if (isInputReceived) {
        const receipt = nextReceiptSeq(deps.connection);
        if (!receipt.ok) {
          return receipt;
        }
        const inputId = newId("input", receivedAt);
        const runId = newId("run", receivedAt);
        const parentInput =
          draft.payload.kind === "input.received" && draft.payload.parent_native_id !== undefined
            ? lookupNativeInput(
                deps.connection,
                state.session_id,
                draft.host_id,
                draft.config_space,
                draft.payload.parent_native_id
              )
            : null;
        plan = {
          state,
          input_id: inputId,
          input_epoch: state.latest_input_epoch + 1,
          directive_strength: draft.payload.directive_strength,
          parent_input_id: parentInput,
          run_id: runId,
          run_attempt: 1,
          watermark: receipt.value,
          is_new_input: true,
          is_retry: false
        };
      } else if (isRetry && draft.payload.kind === "input.retry" && retryPlan !== null) {
        plan = {
          state,
          input_id: retryPlan.input_id,
          input_epoch: retryPlan.input_epoch,
          directive_strength: retryPlan.directive_strength,
          parent_input_id: null,
          run_id: newId("run", receivedAt),
          run_attempt: retryPlan.next_attempt,
          watermark: retryPlan.watermark,
          is_new_input: false,
          is_retry: true
        };
      } else {
        const scope = readAuthoritativeScope(deps.connection, state);
        if (!scope.ok) {
          return scope;
        }
        plan = {
          state,
          input_id: null,
          input_epoch: scope.value.input_epoch,
          directive_strength: null,
          parent_input_id: null,
          run_id: null,
          run_attempt: null,
          watermark: scope.value.watermark,
          is_new_input: false,
          is_retry: false
        };
      }

      if (plan.input_id !== null && isInputReceived && draft.native_message_id !== undefined) {
        const mapped = readNativeMapping(
          deps.connection,
          state.session_id,
          draft.host_id,
          draft.config_space,
          draft.native_kind,
          draft.native_message_id
        );
        if (mapped !== undefined && mapped.input_id !== plan.input_id) {
          const mappedEvent = readEventById(
            deps.connection,
            mapped.source_event_id as Id<"ev">
          );
          return fail(
            idempotencyConflict(
              `${draft.native_kind}:${draft.native_message_id}`,
              mappedEvent?.event_key ?? eventKey,
              eventKey
            ),
            "conflict"
          );
        }
      }

      let contentRelativePath: string | null = null;
      if (content !== null && bytes !== null) {
        const blobRowConflict = checkBlobRow(deps.connection, content);
        if (blobRowConflict !== null) {
          return blobRowConflict;
        }
        const blob = deps.blob_store.putSync(bytes);
        if (!blob.ok) {
          return { ok: false, status: blob.status, error: blob.error };
        }
        if (
          blob.value.hash !== content.content_hash ||
          blob.value.byte_length !== content.byte_length
        ) {
          return fail(internalError("kernel.event_ingest_blob_address_mismatch"));
        }
        contentRelativePath = blob.value.relative_path;
      }

      const binding: VersionBinding = {
        task_id: state.task_id,
        branch_id: state.branch_id,
        input_epoch: plan.input_epoch ?? 1,
        goal_version: state.goal_version,
        config_version: state.config_version,
        watermark: plan.watermark
      };

      const parentEventId = resolveParentEventId(deps.connection, draft, state);
      const correlationId =
        parentEventId === null
          ? newId("corr", receivedAt)
          : (readEventById(deps.connection, parentEventId)?.correlation_id ??
            newId("corr", receivedAt));

      // The envelope embeds `commit_seq`, so the writer must adopt the era's
      // persisted sequence and segment before the envelope (and its hash) is
      // built. The committer re-syncs again immediately before allocating;
      // planning from a stale private counter would project an event whose
      // `event_log.commit_seq` and source ref disagree with the receipt.
      const journalState = deps.connection
        .prepare<{
          last_commit_seq: number;
          trusted_prefix_end: number;
          relative_path: string;
        }>(
          "SELECT last_commit_seq, trusted_prefix_end, relative_path FROM journal_state WHERE journal_id = :journal_id"
        )
        .get({ journal_id: writer.journalId });
      if (journalState !== undefined) {
        if (typeof writer.resyncFromDisk === "function") {
          writer.resyncFromDisk(
            Number(journalState.last_commit_seq),
            journalState.relative_path,
            Number(journalState.trusted_prefix_end)
          );
        }
      } else if (typeof writer.resyncFromDisk === "function") {
        // No era row: an existing non-empty segment belongs to an unprojected
        // first frame and must be recovered before it is appended to.
        writer.resyncFromDisk(writer.lastCommitSeq);
      }
      const commitSeq = writer.lastCommitSeq + 1;
      const eventId = newId("ev", receivedAt);

      if (!isJsonValue(stored.value.payload)) {
        return fail(schemaError("payload", "json_value"));
      }
      const storedPayloadJson: JsonValue = stored.value.payload;
      const payloadText = canonicalJsonText(storedPayloadJson);

      const envelope: JsonValue = {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: eventId,
        event_key: eventKey,
        commit_seq: commitSeq,
        watermark: plan.watermark,
        received_at: receivedAt,
        binding: {
          task_id: binding.task_id,
          branch_id: binding.branch_id,
          input_epoch: binding.input_epoch,
          goal_version: binding.goal_version,
          config_version: binding.config_version,
          watermark: binding.watermark
        },
        session_id: state.session_id,
        resume_generation: state.resume_generation,
        ...(plan.input_id === null ? {} : { input_id: plan.input_id }),
        ...(plan.run_id === null ? {} : { run_id: plan.run_id }),
        ...(parentEventId === null ? {} : { parent_event_id: parentEventId }),
        correlation_id: correlationId,
        origin: draft.origin,
        origin_basis: draft.origin_basis,
        ...(draft.human_attestation === undefined
          ? {}
          : { human_attestation: attestationJson(draft.human_attestation) }),
        trigger_lineage: triggerLineageJson(draft.trigger_lineage),
        attribution: attributionJson(draft.attribution),
        payload: storedPayloadJson,
        ...(content === null
          ? {}
          : { content_ref: content.content_ref, content_hash: content.content_hash }),
        payload_hash: payloadHash.value
      };

      const body: JournalEventBody = {
        schema_version: JOURNAL_EVENT_SCHEMA_VERSION,
        event: envelope,
        event_hash: canonicalHash(envelope),
        blob_hashes: content === null ? [] : [content.content_hash]
      };

      const projection: ProjectionInput = {
        draft,
        state,
        event_id: eventId,
        event_key: eventKey,
        commit_seq: commitSeq,
        watermark: plan.watermark,
        input_id: plan.input_id,
        run_id: plan.run_id,
        run_attempt: plan.run_attempt,
        input_epoch: plan.input_epoch,
        input_origin: draft.origin,
        directive_strength: plan.directive_strength,
        parent_input_id: plan.parent_input_id,
        content,
        content_relative_path: contentRelativePath,
        payload_text: payloadText,
        payload_hash: payloadHash.value,
        received_at: receivedAt,
        now: deps.now(),
        is_new_input: plan.is_new_input,
        is_retry: plan.is_retry,
        correlation_id: correlationId,
        parent_event_id: parentEventId,
        journal_id: writer.journalId
      };

      // The envelope hash commits to `commit_seq`, so planning and appending
      // must be one synchronous step. An `await` here yields to the microtask
      // queue, letting another writer allocate the planned sequence and making
      // the durable header (N+1) disagree with the hashed envelope (N).
      const outcome = committer.commitSync(
        body,
        (tx, receipt) => {
          // The committer refuses to append when the shared counter moved, so
          // this is a defensive check that never fires; if it does, the frame
          // is already durable and must be recovered rather than projected.
          if (receipt.first_commit_seq !== commitSeq) {
            throw internalError("kernel.event_ingest_commit_seq_mismatch");
          }
          projectEvent(tx, projection);
        },
        { expected_first_commit_seq: commitSeq }
      );
      if (!outcome.ok) {
        if (outcome.commit_state === "unknown_recovery_required") {
          return {
            ok: false,
            status: "unknown",
            error: { ...outcome.error, side_effect: "unknown" }
          };
        }
        return { ok: false, status: "rejected", error: outcome.error };
      }

      const receipt: IngestReceipt = {
        event_id: eventId,
        event_key: eventKey,
        commit_seq: commitSeq,
        watermark: plan.watermark,
        duplicate: false,
        task_id: state.task_id,
        branch_id: state.branch_id,
        session_id: state.session_id,
        ...(plan.input_id === null ? {} : { input_id: plan.input_id }),
        ...(plan.input_epoch === null ? {} : { input_epoch: plan.input_epoch }),
        goal_version: state.goal_version,
        config_version: state.config_version
      };
      dispatchPostCommit(deps.post_commit, { receipt, draft, binding });
      return { ok: true, status: "ok", value: receipt };
    });
  };
}
