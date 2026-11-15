/**
 * Immutable content references and the source read port (DD-FND-032).
 *
 * A `SourceRef` addresses a half-open UTF-8 byte range inside committed
 * journal content (`journal://ev:...`) or a content-addressed blob
 * (`blob://sha256:...`). Host-mutable absolute paths never enter a SourceRef.
 */

import { isId, type Id } from "./ids.js";
import { isHash, type Hash } from "./hash.js";
import { makeErrorEnvelope, type ErrorEnvelope } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type SourceRef =
  | `journal://${Id<"ev">}#bytes=${number}-${number}`
  | `blob://${Hash}#bytes=${number}-${number}`;

export type SourceScheme = "journal" | "blob";

export type UnretrievableReason = "missing" | "tombstoned" | "hash_mismatch" | "too_large";

export interface ResolvedSource {
  bytes: Uint8Array | null;
  length: number;
  retrievable: boolean;
  contentVersion: Hash | null;
  range_content_hash: Hash | null;
  reason?: UnretrievableReason;
}

export interface SourceRefPort {
  resolve(ref: SourceRef, opts?: { maxBytes?: number }): Promise<Result<ResolvedSource>>;
  checkRetrievable(refs: readonly SourceRef[]): Promise<ReadonlyMap<SourceRef, ResolvedSource>>;
}

export interface ParsedSourceRef {
  readonly source_ref: SourceRef;
  readonly scheme: SourceScheme;
  readonly locator: string;
  readonly start: number;
  readonly end: number;
}

/** Full blob limit for any SourceRef read, 32 MiB (DD-FND-032). */
export const MAX_SOURCE_BLOB_BYTES = 33_554_432;

/** Default per-read limit, 1 MiB; ports may lower it through `maxBytes`. */
export const DEFAULT_SOURCE_READ_MAX_BYTES = 1_048_576;

const SOURCE_REF_PATTERN = /^(journal|blob):\/\/([^#]+)#bytes=(0|[1-9][0-9]{0,15})-(0|[1-9][0-9]{0,15})$/;

/** Raised by callers that need a throwing parser; `parseSourceRef` stays `Result`. */
export class SourceRefFormatError extends Error {
  readonly code: "E_SOURCE_REF_INVALID" = "E_SOURCE_REF_INVALID";
  readonly path: string;
  readonly rule: string;

  constructor(path: string, rule: string) {
    super(`E_SOURCE_REF_INVALID: ${path} violates ${rule}`);
    this.name = "SourceRefFormatError";
    this.path = path;
    this.rule = rule;
  }
}

/**
 * Parses and validates a SourceRef. Syntax and locator validation happen here;
 * existence, hashing, range bounds and UTF-8 validity are decided by the
 * `SourceRefPort` implementation in the fixed priority order of DD-FND-032.
 */
export function parseSourceRef(value: string): Result<ParsedSourceRef, ErrorEnvelope> {
  const match = SOURCE_REF_PATTERN.exec(value);
  if (match === null) {
    return err(sourceRefInvalid("source_ref", "scheme_locator_range_syntax"));
  }
  const schemeText = match[1];
  const locator = match[2];
  const startText = match[3];
  const endText = match[4];
  if (schemeText === undefined || locator === undefined || startText === undefined || endText === undefined) {
    return err(sourceRefInvalid("source_ref", "scheme_locator_range_syntax"));
  }
  if (schemeText !== "journal" && schemeText !== "blob") {
    return err(sourceRefInvalid("source_ref.scheme", "journal_or_blob"));
  }
  const scheme: SourceScheme = schemeText;
  if (scheme === "journal") {
    if (!isId(locator, "ev")) {
      return err(sourceRefInvalid("source_ref.locator", "ev_id"));
    }
  } else if (!isHash(locator)) {
    return err(sourceRefInvalid("source_ref.locator", "sha256_full_hash"));
  }
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return err(sourceRefInvalid("source_ref.range", "safe_integer"));
  }
  if (start >= end) {
    return err(sourceRefInvalid("source_ref.range", "start_less_than_end"));
  }
  return ok({
    source_ref: value as SourceRef,
    scheme,
    locator,
    start,
    end
  });
}

/** Non-throwing SourceRef check. */
export function isSourceRef(value: string): value is SourceRef {
  return parseSourceRef(value).ok;
}

/**
 * Formats and validates a SourceRef from its parts. Ranges are half-open and
 * must satisfy `0 <= start < end`.
 */
export function formatSourceRef(input: {
  scheme: SourceScheme;
  locator: string;
  start: number;
  end: number;
}): Result<SourceRef, ErrorEnvelope> {
  if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end)) {
    return err(sourceRefInvalid("source_ref.range", "safe_integer"));
  }
  if (input.start < 0 || input.start >= input.end) {
    return err(sourceRefInvalid("source_ref.range", "start_less_than_end"));
  }
  if (input.scheme === "journal" && !isId(input.locator, "ev")) {
    return err(sourceRefInvalid("source_ref.locator", "ev_id"));
  }
  if (input.scheme === "blob" && !isHash(input.locator)) {
    return err(sourceRefInvalid("source_ref.locator", "sha256_full_hash"));
  }
  const candidate = `${input.scheme}://${input.locator}#bytes=${String(input.start)}-${String(input.end)}`;
  const parsed = parseSourceRef(candidate);
  if (!parsed.ok) {
    return parsed;
  }
  return ok(parsed.value.source_ref);
}

function sourceRefInvalid(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SOURCE_REF_INVALID",
    category: "source",
    message_key: "error.source_ref_invalid",
    stage: "source_ref_parse",
    details: { kind: "field", path, rule }
  });
}
