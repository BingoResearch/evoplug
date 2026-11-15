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
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
export declare const MANAGED_BLOCK_SCHEMA_VERSION: "rsi.managed_block/1";
/** Maximum selector length in bytes. */
export declare const MAX_BLOCK_SELECTOR_BYTES = 128;
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
export interface ParsedFile {
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
export declare function parseManagedBlocks(bytes: Uint8Array): Result<ParsedFile, ErrorEnvelope>;
/** Validates one selector against the grammar and the 1..128-byte limit. */
export declare function validateBlockSelector(selector: string): Result<string, ErrorEnvelope>;
/** `block_hash` over selector, raw content hash and content byte length. */
export declare function managedBlockHash(selector: string, content: Uint8Array): Hash;
/**
 * Validates new block content: valid UTF-8 and free of any complete marker
 * line. Failure is `E_BLOCK_CONTENT`.
 */
export declare function validateBlockContent(content: Uint8Array): Result<Uint8Array, ErrorEnvelope>;
export interface BlockEditResult {
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
export declare function applyManagedBlockEdit(input: {
    bytes: Uint8Array;
    selector: string;
    block_action: BlockAction;
    content: Uint8Array | null;
}): Result<BlockEditResult, ErrorEnvelope>;
/** Renders a block with LF line endings and no trailing content separator. */
export declare function renderManagedBlock(selector: string, content: Uint8Array): Uint8Array;
/**
 * Checks `expected_block_hash` against the parsed block for the requested
 * action: `update`/`detach` require a non-null expected hash equal to the
 * current one, `attach` requires `null`.
 */
export declare function checkExpectedBlockHash(input: {
    block_action: BlockAction;
    block: ManagedBlockSpan | null;
    expected_block_hash: Hash | null;
}): Result<null, ErrorEnvelope>;
/** True when the file is empty or its final byte is LF. */
export declare function endsWithLineEnd(bytes: Uint8Array): boolean;
