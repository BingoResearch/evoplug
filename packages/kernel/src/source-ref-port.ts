/**
 * FND `SourceRefPort` backed by the blob store and the journal projections
 * (DD-FND-032).
 *
 * Resolution order is fixed by DD-FND-032 and is not re-orderable:
 *
 *   1. ref syntax, scheme, locator and range integer format
 *   2. address object absent or tombstoned -> `Ok(retrievable=false)`
 *   3. full blob above 32 MiB or the per-read `maxBytes` -> `E_SOURCE_TOO_LARGE`
 *   4. journal `event`/`content_ref`/`byte_length` binding -> `E_SOURCE_HASH`
 *   5. recomputed full blob hash -> `E_SOURCE_HASH`
 *   6. exact range bounds and Unicode code point boundaries -> `E_SOURCE_OUT_OF_RANGE`
 *   7. range bytes are not valid UTF-8 -> `E_SOURCE_UTF8_INVALID`
 *   8. `range_content_hash = sha256(range bytes)`
 *
 * Errors never carry source text; they only name the ref and the reason.
 */

import type {
  ErrorEnvelope,
  Hash,
  ResolvedSource,
  Result,
  SourceRef,
  SourceRefPort,
  UnretrievableReason
} from "@evoplug/core";
import {
  DEFAULT_SOURCE_READ_MAX_BYTES,
  MAX_SOURCE_BLOB_BYTES,
  canonicalHash,
  err,
  hashBytes,
  isHash,
  makeErrorEnvelope,
  ok,
  parseSourceRef
} from "@evoplug/core";
import type { BlobStore, SqliteConnection, SqlRow } from "@evoplug/storage";

type Row = Readonly<Record<string, unknown>>;

interface SourceRefPortDeps {
  /** Open FND SQLite connection; only `blob`, `event_log`, `ledger_event_log` and `commit_record` are read. */
  readonly connection: SqliteConnection;
  /** Content-addressed blob store; `read` recomputes the full blob hash. */
  readonly blob_store: Pick<BlobStore, "read" | "stat">;
}

interface ResolvedOutcome {
  readonly kind: "resolved";
  readonly value: ResolvedSource;
}

interface UnretrievableOutcome {
  readonly kind: "unretrievable";
  readonly length: number;
  readonly contentVersion: Hash | null;
  readonly reason: UnretrievableReason;
}

interface FailureOutcome {
  readonly kind: "failure";
  readonly error: ErrorEnvelope;
  readonly length: number;
  readonly contentVersion: Hash | null;
}

type Outcome = ResolvedOutcome | UnretrievableOutcome | FailureOutcome;

interface BlobDescriptor {
  readonly byte_length: number;
  readonly state: string;
}

function sourceFailure(
  code: "E_SOURCE_HASH" | "E_SOURCE_OUT_OF_RANGE" | "E_SOURCE_TOO_LARGE" | "E_SOURCE_UTF8_INVALID",
  ref: SourceRef,
  length: number,
  contentVersion: Hash | null
): FailureOutcome {
  const reason =
    code === "E_SOURCE_HASH"
      ? "hash_mismatch"
      : code === "E_SOURCE_OUT_OF_RANGE"
        ? "out_of_range"
        : code === "E_SOURCE_TOO_LARGE"
          ? "too_large"
          : "not_utf8";
  return {
    kind: "failure",
    length,
    contentVersion,
    error: makeErrorEnvelope({
      code,
      category: "source",
      message_key: `error.${code.toLowerCase()}`,
      stage: "source_resolve",
      details: { kind: "source", source_ref: ref, reason }
    })
  };
}

function storageFailure(length: number, contentVersion: Hash | null): FailureOutcome {
  return {
    kind: "failure",
    length,
    contentVersion,
    error: makeErrorEnvelope({
      code: "E_STORAGE_IO",
      category: "storage",
      message_key: "error.io.failed",
      stage: "source_resolve",
      details: { kind: "none" }
    })
  };
}

function oneRow(
  connection: SqliteConnection,
  sql: string,
  params: Readonly<Record<string, string | number | null>>
): Row | null {
  const row: SqlRow | undefined = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row;
}

function rowString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function rowNumber(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readBlobDescriptor(
  connection: SqliteConnection,
  hash: Hash
): BlobDescriptor | "absent" {
  const row = oneRow(
    connection,
    "SELECT blob_hash, byte_length, state FROM blob WHERE blob_hash = :blob_hash",
    { blob_hash: hash }
  );
  if (row === null) {
    return "absent";
  }
  const byteLength = rowNumber(row, "byte_length");
  const state = rowString(row, "state");
  if (byteLength === null || byteLength < 0 || state === null) {
    return "absent";
  }
  return { byte_length: byteLength, state };
}

function unretrievable(
  reason: UnretrievableReason,
  length: number,
  contentVersion: Hash | null
): UnretrievableOutcome {
  return { kind: "unretrievable", reason, length, contentVersion };
}

function effectiveMaxBytes(opts: { maxBytes?: number } | undefined): number {
  const requested = opts?.maxBytes;
  if (requested === undefined) {
    return DEFAULT_SOURCE_READ_MAX_BYTES;
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return 1;
  }
  return Math.min(requested, MAX_SOURCE_BLOB_BYTES);
}

function isCodePointBoundary(bytes: Uint8Array, index: number): boolean {
  if (index <= 0 || index >= bytes.byteLength) {
    return true;
  }
  const byte = bytes[index];
  return byte !== undefined && (byte & 0xc0) !== 0x80;
}

function resolveRange(
  ref: SourceRef,
  content: Uint8Array,
  contentOffset: number,
  contentLength: number,
  start: number,
  end: number,
  maxBytes: number,
  contentVersion: Hash
): Outcome {
  const rangeLength = end - start;
  if (rangeLength > maxBytes) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentLength, contentVersion);
  }
  if (end > contentLength) {
    return sourceFailure("E_SOURCE_OUT_OF_RANGE", ref, contentLength, contentVersion);
  }
  const absoluteStart = contentOffset + start;
  const absoluteEnd = contentOffset + end;
  if (absoluteEnd > content.byteLength) {
    return sourceFailure("E_SOURCE_OUT_OF_RANGE", ref, contentLength, contentVersion);
  }
  if (!isCodePointBoundary(content, absoluteStart) || !isCodePointBoundary(content, absoluteEnd)) {
    return sourceFailure("E_SOURCE_OUT_OF_RANGE", ref, contentLength, contentVersion);
  }
  const rangeBytes = content.subarray(absoluteStart, absoluteEnd);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(rangeBytes);
  } catch {
    return sourceFailure("E_SOURCE_UTF8_INVALID", ref, contentLength, contentVersion);
  }
  return {
    kind: "resolved",
    value: {
      bytes: rangeBytes,
      length: contentLength,
      retrievable: true,
      contentVersion,
      range_content_hash: hashBytes(rangeBytes)
    }
  };
}

function readFullBlob(
  deps: SourceRefPortDeps,
  ref: SourceRef,
  hash: Hash,
  descriptor: BlobDescriptor,
  contentLength: number
): Outcome | Uint8Array {
  if (descriptor.byte_length > MAX_SOURCE_BLOB_BYTES) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentLength, hash);
  }
  const stat = deps.blob_store.stat(hash);
  if (!stat.ok) {
    return storageFailure(contentLength, hash);
  }
  if (stat.value === null) {
    return unretrievable("missing", contentLength, hash);
  }
  if (stat.value.byte_length > MAX_SOURCE_BLOB_BYTES) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentLength, hash);
  }
  const read = deps.blob_store.read(hash);
  if (!read.ok) {
    if (read.error.code === "E_BLOB_MISSING") {
      return unretrievable("missing", contentLength, hash);
    }
    if (read.error.code === "E_SOURCE_HASH") {
      return sourceFailure("E_SOURCE_HASH", ref, contentLength, hash);
    }
    return storageFailure(contentLength, hash);
  }
  if (read.value.byteLength > MAX_SOURCE_BLOB_BYTES) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentLength, hash);
  }
  return read.value;
}

function isUint8Array(value: Outcome | Uint8Array): value is Uint8Array {
  return value instanceof Uint8Array;
}

function resolveBlobRef(
  deps: SourceRefPortDeps,
  ref: SourceRef,
  parsed: { readonly locator: string; readonly start: number; readonly end: number },
  maxBytes: number
): Outcome {
  const hash = parsed.locator;
  if (!isHash(hash)) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, null);
  }
  const descriptor = readBlobDescriptor(deps.connection, hash);
  if (descriptor === "absent") {
    return unretrievable("missing", parsed.end, hash);
  }
  if (descriptor.state === "tombstoned") {
    return unretrievable("tombstoned", descriptor.byte_length, hash);
  }
  if (descriptor.state !== "present") {
    return unretrievable("missing", descriptor.byte_length, hash);
  }
  const contentLength = descriptor.byte_length;
  if (parsed.end - parsed.start > maxBytes) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentLength, hash);
  }
  const content = readFullBlob(deps, ref, hash, descriptor, contentLength);
  if (!isUint8Array(content)) {
    return content;
  }
  if (content.byteLength !== contentLength) {
    return sourceFailure("E_SOURCE_HASH", ref, contentLength, hash);
  }
  return resolveRange(ref, content, 0, contentLength, parsed.start, parsed.end, maxBytes, hash);
}

function resolveJournalEventContent(
  deps: SourceRefPortDeps,
  ref: SourceRef,
  eventId: string,
  parsed: { readonly start: number; readonly end: number },
  maxBytes: number
): Outcome {
  const event = oneRow(
    deps.connection,
    `SELECT journal_id, commit_seq, content_ref, content_hash, content_bytes
       FROM event_log
      WHERE event_id = :event_id`,
    { event_id: eventId }
  );
  if (event === null) {
    return resolveLedgerEventContent(deps, ref, eventId, parsed, maxBytes);
  }
  const commit = oneRow(
    deps.connection,
    `SELECT journal_id, commit_seq, payload_hash
       FROM commit_record
      WHERE event_id = :event_id`,
    { event_id: eventId }
  );
  if (commit === null) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, null);
  }
  if (
    rowString(commit, "journal_id") !== rowString(event, "journal_id") ||
    rowNumber(commit, "commit_seq") !== rowNumber(event, "commit_seq")
  ) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, null);
  }
  const contentRefText = rowString(event, "content_ref");
  const contentHash = rowString(event, "content_hash");
  const contentBytes = rowNumber(event, "content_bytes");
  if (contentRefText === null || contentHash === null || !isHash(contentHash) || contentBytes === null) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, null);
  }
  const contentRef = parseSourceRef(contentRefText);
  if (!contentRef.ok || contentRef.value.scheme !== "blob") {
    return sourceFailure("E_SOURCE_HASH", ref, contentBytes, null);
  }
  if (
    contentRef.value.locator !== contentHash ||
    contentRef.value.end - contentRef.value.start !== contentBytes
  ) {
    return sourceFailure("E_SOURCE_HASH", ref, contentBytes, null);
  }
  if (parsed.end - parsed.start > maxBytes) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentBytes, contentHash);
  }
  const descriptor = readBlobDescriptor(deps.connection, contentHash);
  if (descriptor === "absent") {
    return unretrievable("missing", contentBytes, contentHash);
  }
  if (descriptor.state === "tombstoned") {
    return unretrievable("tombstoned", contentBytes, contentHash);
  }
  if (descriptor.state !== "present") {
    return unretrievable("missing", contentBytes, contentHash);
  }
  const content = readFullBlob(deps, ref, contentHash, descriptor, contentBytes);
  if (!isUint8Array(content)) {
    return content;
  }
  if (contentRef.value.end > content.byteLength) {
    return sourceFailure("E_SOURCE_HASH", ref, contentBytes, contentHash);
  }
  return resolveRange(
    ref,
    content,
    contentRef.value.start,
    contentBytes,
    parsed.start,
    parsed.end,
    maxBytes,
    contentHash
  );
}

/**
 * Ledger events have no `event_log.content_ref`; their immutable logical
 * content is the frozen `row_json` and their content version is `after_hash`.
 */
function resolveLedgerEventContent(
  deps: SourceRefPortDeps,
  ref: SourceRef,
  eventId: string,
  parsed: { readonly start: number; readonly end: number },
  maxBytes: number
): Outcome {
  const event = oneRow(
    deps.connection,
    `SELECT journal_id, commit_seq, after_hash, row_schema, row_json
       FROM ledger_event_log
      WHERE event_id = :event_id`,
    { event_id: eventId }
  );
  if (event === null) {
    return unretrievable("missing", parsed.end, null);
  }
  const commit = oneRow(
    deps.connection,
    `SELECT journal_id, commit_seq, payload_hash
       FROM commit_record
      WHERE event_id = :event_id`,
    { event_id: eventId }
  );
  if (commit === null) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, null);
  }
  const afterHash = rowString(event, "after_hash");
  const rowSchema = rowString(event, "row_schema");
  const rowJson = rowString(event, "row_json");
  if (afterHash === null || !isHash(afterHash) || rowSchema === null || rowJson === null) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, null);
  }
  if (
    rowString(commit, "journal_id") !== rowString(event, "journal_id") ||
    rowNumber(commit, "commit_seq") !== rowNumber(event, "commit_seq") ||
    rowString(commit, "payload_hash") !== afterHash
  ) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, afterHash);
  }
  if (canonicalHash({ row_schema: rowSchema, row_json: rowJson }) !== afterHash) {
    return sourceFailure("E_SOURCE_HASH", ref, parsed.end, afterHash);
  }
  const content = new TextEncoder().encode(rowJson);
  const contentLength = content.byteLength;
  if (contentLength > MAX_SOURCE_BLOB_BYTES) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentLength, afterHash);
  }
  if (parsed.end - parsed.start > maxBytes) {
    return sourceFailure("E_SOURCE_TOO_LARGE", ref, contentLength, afterHash);
  }
  return resolveRange(ref, content, 0, contentLength, parsed.start, parsed.end, maxBytes, afterHash);
}

function resolveOutcome(
  deps: SourceRefPortDeps,
  ref: SourceRef,
  opts: { maxBytes?: number } | undefined
): Outcome {
  const parsed = parseSourceRef(ref);
  if (!parsed.ok) {
    return {
      kind: "failure",
      length: 0,
      contentVersion: null,
      error: parsed.error
    };
  }
  const maxBytes = effectiveMaxBytes(opts);
  try {
    if (parsed.value.scheme === "blob") {
      return resolveBlobRef(deps, ref, parsed.value, maxBytes);
    }
    return resolveJournalEventContent(deps, ref, parsed.value.locator, parsed.value, maxBytes);
  } catch {
    return storageFailure(parsed.value.end, null);
  }
}

function toResolvedSource(outcome: UnretrievableOutcome): ResolvedSource {
  return {
    bytes: null,
    length: outcome.length,
    retrievable: false,
    contentVersion: outcome.contentVersion,
    range_content_hash: null,
    reason: outcome.reason
  };
}

function toCheckResult(ref: SourceRef, outcome: Outcome): ResolvedSource {
  switch (outcome.kind) {
    case "resolved":
      return outcome.value;
    case "unretrievable":
      return toResolvedSource(outcome);
    case "failure": {
      const reason =
        outcome.error.code === "E_SOURCE_TOO_LARGE"
          ? "too_large"
          : outcome.error.code === "E_SOURCE_HASH"
            ? "hash_mismatch"
            : null;
      if (reason === null) {
        const parsed = parseSourceRef(ref);
        return {
          bytes: null,
          length: parsed.ok ? parsed.value.end : outcome.length,
          retrievable: false,
          contentVersion: null,
          range_content_hash: null
        };
      }
      return {
        bytes: null,
        length: outcome.length,
        retrievable: false,
        contentVersion: reason === "too_large" ? outcome.contentVersion : null,
        range_content_hash: null,
        reason
      };
    }
  }
}

/** Builds the read-only `SourceRefPort` over the blob store and journal projections. */
export function createSourceRefPort(deps: SourceRefPortDeps): SourceRefPort {
  return {
    async resolve(ref: SourceRef, opts?: { maxBytes?: number }): Promise<Result<ResolvedSource>> {
      const outcome = resolveOutcome(deps, ref, opts);
      switch (outcome.kind) {
        case "resolved":
          return ok(outcome.value);
        case "unretrievable":
          return ok(toResolvedSource(outcome));
        case "failure":
          return err(outcome.error);
      }
    },
    async checkRetrievable(refs: readonly SourceRef[]): Promise<ReadonlyMap<SourceRef, ResolvedSource>> {
      const result = new Map<SourceRef, ResolvedSource>();
      for (const ref of refs) {
        result.set(ref, toCheckResult(ref, resolveOutcome(deps, ref, undefined)));
      }
      return result;
    }
  };
}
