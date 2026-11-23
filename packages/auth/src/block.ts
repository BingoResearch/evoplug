/// <reference types="node" />
/**
 * Managed block byte grammar (DD-FND-091).
 *
 * ```abnf
 * managed-block = begin-line block-content end-line
 * begin-line    = "<!-- rsi:managed:begin " selector " -->" line-end
 * end-line      = "<!-- rsi:managed:end " selector " -->" [ line-end ]
 * selector      = segment *( "/" segment )
 * segment       = 1*( ALPHA / DIGIT / "-" / "_" / "." )
 * line-end      = LF / CRLF
 * ```
 *
 * Marker bytes are compared exactly. A line with leading or trailing spaces, a
 * tab, a BOM or a case variant is an ordinary line, not a marker. Only a line
 * whose start is byte-exactly a marker prefix but whose grammar is incomplete
 * is a syntax error.
 */

import { canonicalHash, hashBytes } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { fieldError } from "./errors.js";

const BEGIN_PREFIX = "<!-- rsi:managed:begin ";
const END_PREFIX = "<!-- rsi:managed:end ";
const MARKER_SUFFIX = " -->";

const MANAGED_BLOCK_SCHEMA_VERSION: "rsi.managed_block/1" = "rsi.managed_block/1";

/** Maximum selector length in bytes. */
const MAX_BLOCK_SELECTOR_BYTES = 128;

export type BlockAction = "update" | "attach" | "detach";

export interface ManagedBlockSpan {
  selector: string;
  /** Byte offset of the begin marker; the snapshot's `block_start`. */
  begin_start: number;
  /** Byte offset just after the begin line terminator. */
  content_start: number;
  /** Byte offset of the end marker start; equals `content_end`. */
  end_start: number;
  /** Byte offset just after the end marker line (may equal EOF). */
  end_end: number;
  /** Full byte length from the begin marker through the end line ending. */
  block_byte_length: number;
  content_byte_length: number;
  content_hash: Hash;
  block_hash: Hash;
}

interface ParsedFile {
  bytes: Uint8Array;
  blocks: readonly ManagedBlockSpan[];
}

/**
 * Parses every managed block in `bytes`.
 *
 * Failures: `E_BLOCK_MALFORMED` for missing/orphan/mismatched markers and an
 * unterminated begin line; `E_BLOCK_AMBIGUOUS` for duplicate selectors or a
 * nested block. Empty input is valid and has no blocks.
 */
export function parseManagedBlocks(bytes: Uint8Array): Result<ParsedFile, ErrorEnvelope> {
  const text = bytesToByteString(bytes);
  const blocks: ManagedBlockSpan[] = [];
  const seen = new Set<string>();
  let pending: { selector: string; beginStart: number; contentStart: number } | null = null;
  let lineStart = 0;
  for (;;) {
    const lf = text.indexOf("\n", lineStart);
    const rawEnd = lf === -1 ? text.length : lf + 1;
    let bodyEnd = lf === -1 ? text.length : lf;
    let terminatorLength = lf === -1 ? 0 : 1;
    if (lf !== -1 && bodyEnd > lineStart && text.charCodeAt(bodyEnd - 1) === 0x0d) {
      bodyEnd -= 1;
      terminatorLength = 2;
    }
    const line = text.slice(lineStart, bodyEnd);
    const isBegin = line.startsWith(BEGIN_PREFIX);
    const isEnd = line.startsWith(END_PREFIX);
    if (isBegin || isEnd) {
      const selector = parseMarkerSelector(line, isBegin ? BEGIN_PREFIX : END_PREFIX);
      if (!selector.ok) {
        return selector;
      }
      if (isBegin) {
        if (terminatorLength === 0) {
          return err(fieldError("E_BLOCK_MALFORMED", "begin-line", "line_end_required"));
        }
        if (pending !== null) {
          return err(fieldError("E_BLOCK_AMBIGUOUS", "block", "nested_or_overlapping"));
        }
        pending = { selector: selector.value, beginStart: lineStart, contentStart: rawEnd };
      } else {
        if (pending === null) {
          return err(fieldError("E_BLOCK_MALFORMED", "end-line", "orphan_end"));
        }
        if (pending.selector !== selector.value) {
          return err(fieldError("E_BLOCK_MALFORMED", "end-line", "selector_mismatch"));
        }
        if (seen.has(selector.value)) {
          return err(fieldError("E_BLOCK_AMBIGUOUS", "block", "duplicate_selector"));
        }
        seen.add(selector.value);
        const content = bytes.subarray(pending.contentStart, lineStart);
        blocks.push({
          selector: selector.value,
          begin_start: pending.beginStart,
          content_start: pending.contentStart,
          end_start: lineStart,
          end_end: rawEnd,
          block_byte_length: rawEnd - pending.beginStart,
          content_byte_length: content.length,
          content_hash: hashBytes(content),
          block_hash: managedBlockHash(selector.value, content)
        });
        pending = null;
      }
    }
    if (lf === -1) {
      break;
    }
    lineStart = rawEnd;
  }
  if (pending !== null) {
    return err(fieldError("E_BLOCK_MALFORMED", "begin-line", "missing_end"));
  }
  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    if (previous !== undefined && current !== undefined && current.begin_start < previous.end_end) {
      return err(fieldError("E_BLOCK_AMBIGUOUS", "block", "nested_or_overlapping"));
    }
  }
  return ok({ bytes, blocks });
}

/** Validates one selector against the grammar and the 1..128-byte limit. */
export function validateBlockSelector(selector: string): Result<string, ErrorEnvelope> {
  if (selector.length === 0 || selector.length > MAX_BLOCK_SELECTOR_BYTES) {
    return err(fieldError("E_BLOCK_SELECTOR", "block_selector", "1..128_bytes"));
  }
  if (!isValidSelector(selector)) {
    return err(fieldError("E_BLOCK_SELECTOR", "block_selector", "managed_block_selector"));
  }
  return ok(selector);
}

/** `block_hash` over selector, raw content hash and content byte length. */
export function managedBlockHash(selector: string, content: Uint8Array): Hash {
  return canonicalHash({
    schema_version: MANAGED_BLOCK_SCHEMA_VERSION,
    selector,
    content_hash: hashBytes(content),
    content_byte_length: content.length
  });
}

/**
 * Validates new block content: valid UTF-8 and free of any complete marker
 * line. Failure is `E_BLOCK_CONTENT`.
 */
export function validateBlockContent(content: Uint8Array): Result<Uint8Array, ErrorEnvelope> {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return err(fieldError("E_BLOCK_CONTENT", "new_content", "valid_utf8"));
  }
  if (content.length > 0 && content[content.length - 1] !== 0x0a) {
    return err(fieldError("E_BLOCK_CONTENT", "new_content", "ends_with_line_end"));
  }
  const text = bytesToByteString(content);
  let lineStart = 0;
  for (;;) {
    const lf = text.indexOf("\n", lineStart);
    const bodyEnd = lf === -1 ? text.length : lf;
    const line = text.slice(lineStart, bodyEnd).replace(/\r$/, "");
    if (line.startsWith(BEGIN_PREFIX) || line.startsWith(END_PREFIX)) {
      return err(fieldError("E_BLOCK_CONTENT", "new_content", "no_marker_lines"));
    }
    if (lf === -1) {
      break;
    }
    lineStart = lf + 1;
  }
  return ok(content);
}

interface BlockEditResult {
  bytes: Uint8Array;
  before: ManagedBlockSpan | null;
  new_block_hash: Hash | null;
}

/**
 * Applies `update`, `attach` or `detach` to `bytes`.
 *
 * Existence is checked before any byte is produced: `update`/`detach` require
 * exactly one block, `attach` requires none. `attach` on a non-empty file that
 * does not end with a line-end fails with `E_BLOCK_STATE` and never inserts a
 * blank separator line.
 */
export function applyManagedBlockEdit(input: {
  bytes: Uint8Array;
  selector: string;
  block_action: BlockAction;
  content: Uint8Array | null;
}): Result<BlockEditResult, ErrorEnvelope> {
  const selector = validateBlockSelector(input.selector);
  if (!selector.ok) {
    return selector;
  }
  const parsed = parseManagedBlocks(input.bytes);
  if (!parsed.ok) {
    return parsed;
  }
  const existing = parsed.value.blocks.filter((block) => block.selector === input.selector);
  if (existing.length > 1) {
    return err(fieldError("E_BLOCK_AMBIGUOUS", "block", "duplicate_selector"));
  }
  const block = existing[0] ?? null;
  if (input.block_action === "detach") {
    if (block === null) {
      return err(fieldError("E_BLOCK_STATE", "block_selector", "detach_requires_existing"));
    }
    if (input.content !== null) {
      return err(fieldError("E_BLOCK_CONTENT", "new_content", "null_for_detach"));
    }
    const bytes = concatBytes([
      input.bytes.subarray(0, block.begin_start),
      input.bytes.subarray(block.end_end)
    ]);
    return ok({ bytes, before: block, new_block_hash: null });
  }
  if (input.content === null) {
    return err(fieldError("E_BLOCK_CONTENT", "new_content", "required"));
  }
  const content = validateBlockContent(input.content);
  if (!content.ok) {
    return content;
  }
  if (input.block_action === "update") {
    if (block === null) {
      return err(fieldError("E_BLOCK_STATE", "block_selector", "update_requires_existing"));
    }
    const bytes = concatBytes([
      input.bytes.subarray(0, block.content_start),
      content.value,
      input.bytes.subarray(block.end_start)
    ]);
    return ok({
      bytes,
      before: block,
      new_block_hash: managedBlockHash(input.selector, content.value)
    });
  }
  if (block !== null) {
    return err(fieldError("E_BLOCK_STATE", "block_selector", "attach_requires_absent"));
  }
  if (!endsWithLineEnd(input.bytes)) {
    return err(fieldError("E_BLOCK_STATE", "target_file", "empty_or_line_end"));
  }
  const rendered = renderManagedBlock(input.selector, content.value);
  const bytes = concatBytes([input.bytes, rendered]);
  return ok({
    bytes,
    before: null,
    new_block_hash: managedBlockHash(input.selector, content.value)
  });
}

/** Renders a block with LF line endings and no trailing content separator. */
export function renderManagedBlock(selector: string, content: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`${BEGIN_PREFIX}${selector}${MARKER_SUFFIX}\n`);
  const tail = new TextEncoder().encode(`${END_PREFIX}${selector}${MARKER_SUFFIX}\n`);
  return concatBytes([head, content, tail]);
}

/**
 * Checks `expected_block_hash` against the parsed block for the requested
 * action: `update`/`detach` require a non-null expected hash equal to the
 * current one, `attach` requires `null`.
 */
export function checkExpectedBlockHash(input: {
  block_action: BlockAction;
  block: ManagedBlockSpan | null;
  expected_block_hash: Hash | null;
}): Result<null, ErrorEnvelope> {
  if (input.block_action === "attach") {
    if (input.expected_block_hash !== null) {
      return err(fieldError("E_BLOCK_HASH_MISMATCH", "expected_block_hash", "null_for_attach"));
    }
    return ok(null);
  }
  if (input.block === null) {
    return err(fieldError("E_BLOCK_STATE", "block_selector", "requires_existing"));
  }
  if (input.expected_block_hash === null) {
    return err(fieldError("E_BLOCK_HASH_MISMATCH", "expected_block_hash", "required"));
  }
  if (input.expected_block_hash !== input.block.block_hash) {
    return err(fieldError("E_BLOCK_HASH_MISMATCH", "expected_block_hash", "current_block_hash"));
  }
  return ok(null);
}

/** True when the file is empty or its final byte is LF. */
function endsWithLineEnd(bytes: Uint8Array): boolean {
  return bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
}

function parseMarkerSelector(
  line: string,
  prefix: string
): Result<string, ErrorEnvelope> {
  if (!line.endsWith(MARKER_SUFFIX)) {
    return err(fieldError("E_BLOCK_MALFORMED", "marker", "complete_marker_line"));
  }
  const selector = line.slice(prefix.length, line.length - MARKER_SUFFIX.length);
  if (!isValidSelector(selector) || selector.length > MAX_BLOCK_SELECTOR_BYTES) {
    return err(fieldError("E_BLOCK_MALFORMED", "marker.selector", "managed_block_selector"));
  }
  return ok(selector);
}

function isValidSelector(selector: string): boolean {
  if (selector.length === 0) {
    return false;
  }
  const segments = selector.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return false;
    }
    for (let index = 0; index < segment.length; index += 1) {
      const code = segment.charCodeAt(index);
      const allowed =
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2d ||
        code === 0x5f ||
        code === 0x2e;
      if (!allowed) {
        return false;
      }
    }
  }
  return true;
}

function bytesToByteString(bytes: Uint8Array): string {
  let text = "";
  const chunk = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return text;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
