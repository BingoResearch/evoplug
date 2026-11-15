/**
 * Pi payload inspection for `normalizeEvent` (DD-TRG-004).
 *
 * The adapter sees only the frozen `ResolvedHostPayload`: read-only bytes plus,
 * for text/JSON payloads, the decoded text and parsed JSON value. Content
 * references must point into that same blob, so text and tool-argument fields
 * are located by scanning the payload's top-level JSON members and converting
 * character offsets to UTF-8 byte offsets. No new blob is created and no text
 * is copied into the draft.
 */

import { formatSourceRef, parseSourceRef, sortUtf8, type JsonValue, type SourceRef } from "@evoplug/core";

import type { ResolvedHostPayload } from "./contract.js";

export interface JsonRecord {
  readonly [key: string]: JsonValue;
}

export interface PiPayloadView {
  readonly canonicalRef: SourceRef;
  readonly locator: string;
  readonly byteLength: number;
  readonly mediaType: ResolvedHostPayload["media_type"];
  readonly decodedText: string | null;
  readonly record: JsonRecord | null;
}

/** Returns true for a plain JSON object (not `null`, not an array). */
export function asJsonRecord(value: JsonValue | undefined): JsonRecord | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/** Reads the frozen payload into the adapter's view; `null` means invalid ref. */
export function readPiPayload(payload: ResolvedHostPayload): PiPayloadView | null {
  const parsed = parseSourceRef(payload.canonical_ref);
  if (!parsed.ok) {
    return null;
  }
  const decodedText = decodeUtf8Text(payload);
  return {
    canonicalRef: payload.canonical_ref,
    locator: parsed.value.locator,
    byteLength: parsed.value.end - parsed.value.start,
    mediaType: payload.media_type,
    decodedText,
    record: asJsonRecord(payload.json_value)
  };
}

/**
 * Uses the host-provided decoded text, or decodes the frozen bytes when the
 * payload is a text media type. Invalid UTF-8 yields `null`, never mojibake.
 */
function decodeUtf8Text(payload: ResolvedHostPayload): string | null {
  if (payload.decoded_text !== undefined) {
    return payload.decoded_text;
  }
  if (payload.media_type !== "text/plain;charset=utf-8" && payload.media_type !== "application/json") {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload.bytes);
  } catch {
    return null;
  }
}

/** First present string member among `keys`. */
export function stringMember(record: JsonRecord | null, keys: readonly string[]): string | null {
  if (record === null) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/** First present boolean member among `keys`. */
export function booleanMember(record: JsonRecord | null, keys: readonly string[]): boolean | null {
  if (record === null) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

/** First present safe non-negative integer member among `keys`. */
export function safeIntegerMember(record: JsonRecord | null, keys: readonly string[]): number | null {
  if (record === null) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

/** First present JSON object member among `keys`. */
export function objectMember(record: JsonRecord | null, keys: readonly string[]): JsonRecord | null {
  if (record === null) {
    return null;
  }
  for (const key of keys) {
    const value = asJsonRecord(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

interface MemberSpan {
  readonly start: number;
  readonly end: number;
}

interface StringToken {
  readonly end: number;
  readonly value: string;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

function readStringToken(text: string, start: number): StringToken | null {
  if (text[start] !== '"') {
    return null;
  }
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') {
      const raw = text.slice(start, index + 1);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "string") {
          return null;
        }
        return { end: index + 1, value: parsed };
      } catch {
        return null;
      }
    }
    index += 1;
  }
  return null;
}

function skipComposite(text: string, start: number): number | null {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") {
    return null;
  }
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const token = readStringToken(text, index);
      if (token === null) {
        return null;
      }
      index = token.end;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return null;
}

function skipValue(text: string, start: number): number | null {
  const char = text[start];
  if (char === undefined) {
    return null;
  }
  if (char === '"') {
    const token = readStringToken(text, start);
    return token === null ? null : token.end;
  }
  if (char === "{" || char === "[") {
    return skipComposite(text, start);
  }
  let index = start;
  while (index < text.length) {
    const current = text[index];
    if (current === "," || current === "}" || current === "]" || current === " " || current === "\t" || current === "\n" || current === "\r") {
      break;
    }
    index += 1;
  }
  return index === start ? null : index;
}

/** Finds the first top-level JSON member with `key`, returning its value span. */
export function findTopLevelMember(text: string, key: string): MemberSpan | null {
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") {
    return null;
  }
  index = skipWhitespace(text, index + 1);
  if (text[index] === "}") {
    return null;
  }
  for (;;) {
    const keyToken = readStringToken(text, index);
    if (keyToken === null) {
      return null;
    }
    index = skipWhitespace(text, keyToken.end);
    if (text[index] !== ":") {
      return null;
    }
    index = skipWhitespace(text, index + 1);
    const valueStart = index;
    const valueEnd = skipValue(text, index);
    if (valueEnd === null) {
      return null;
    }
    if (keyToken.value === key) {
      return { start: valueStart, end: valueEnd };
    }
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    return null;
  }
}

function utf8PrefixBytes(text: string, charIndex: number): number {
  return new TextEncoder().encode(text.slice(0, charIndex)).byteLength;
}

function spanToRef(view: PiPayloadView, startChar: number, endChar: number): SourceRef | null {
  if (startChar < 0 || endChar <= startChar) {
    return null;
  }
  const start = utf8PrefixBytes(view.decodedText ?? "", startChar);
  const end = utf8PrefixBytes(view.decodedText ?? "", endChar);
  const formatted = formatSourceRef({ scheme: "blob", locator: view.locator, start, end });
  return formatted.ok ? formatted.value : null;
}

/**
 * SourceRef for a string member. Falls back to the whole payload blob when the
 * payload is plain text or the member cannot be located; the fallback still
 * points at payload bytes the host core validated.
 */
export function textMemberRef(
  view: PiPayloadView,
  keys: readonly string[],
  expectedText?: string | null
): SourceRef {
  const text = view.decodedText;
  if (text === null) {
    return view.canonicalRef;
  }
  for (const key of keys) {
    const span = findTopLevelMember(text, key);
    if (span === null || text[span.start] !== '"') {
      continue;
    }
    const token = readStringToken(text, span.start);
    if (token === null || token.end !== span.end) {
      continue;
    }
    if (expectedText !== undefined && expectedText !== null && token.value !== expectedText) {
      continue;
    }
    const ref = spanToRef(view, span.start + 1, span.end - 1);
    if (ref !== null) {
      return ref;
    }
  }
  return view.canonicalRef;
}

/** SourceRef for an arbitrary member value (including JSON containers). */
export function valueMemberRef(view: PiPayloadView, keys: readonly string[]): SourceRef {
  const text = view.decodedText;
  if (text === null) {
    return view.canonicalRef;
  }
  for (const key of keys) {
    const span = findTopLevelMember(text, key);
    if (span === null) {
      continue;
    }
    const ref = spanToRef(view, span.start, span.end);
    if (ref !== null) {
      return ref;
    }
  }
  return view.canonicalRef;
}

/** Sorted UTF-8 member names for `attribution.typed_field_names`. */
export function sortedMemberNames(record: JsonRecord | null): readonly string[] {
  if (record === null) {
    return Object.freeze([]);
  }
  return Object.freeze(sortUtf8(Object.keys(record), (name) => name));
}
