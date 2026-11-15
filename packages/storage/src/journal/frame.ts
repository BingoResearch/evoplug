import { canonicalJsonText } from "@evoplug/core";
import type { Hash } from "@evoplug/core";
import { sha256Bytes } from "../hash.js";
import { crc32c } from "./crc32c.js";
import {
  journalPayloadJson,
  validateJournalFramePayload
} from "./payload.js";
import type {
  JournalFramePayload,
  JournalPayloadError
} from "./payload.js";

/** ASCII `RSIJ` magic as a big-endian uint32. */
export const JOURNAL_FRAME_MAGIC = 0x5253494a;
/** ASCII `RSIJ`. */
export const JOURNAL_FRAME_MAGIC_TEXT = "RSIJ";
/** Current frame version. Unknown versions are refused, never guessed. */
export const JOURNAL_FRAME_VERSION = 1;
/** Fixed header size in bytes. */
export const JOURNAL_HEADER_BYTES = 24;
/** Maximum canonical JSON payload size: 8 MiB. */
export const JOURNAL_MAX_PAYLOAD_BYTES = 8388608;
/** Journal file rotation threshold: 256 MiB. */
export const JOURNAL_MAX_FILE_BYTES = 268435456;
/** Commit sequence ceiling: 2^53 - 1. */
export const JOURNAL_MAX_COMMIT_SEQ: number = Number.MAX_SAFE_INTEGER;

export interface JournalFrameHeader {
  readonly magic: number;
  readonly version: number;
  readonly flags: number;
  readonly payload_len: number;
  readonly crc32c: number;
  readonly commit_seq: number;
}

export type JournalFrameErrorReason =
  | "short_header"
  | "bad_magic"
  | "unsupported_version"
  | "nonzero_flags"
  | "payload_length"
  | "commit_seq"
  | "short_payload"
  | "crc_mismatch"
  | "invalid_utf8"
  | "invalid_json"
  | "non_canonical_json"
  | "invalid_payload"
  | "commit_seq_regression"
  | "duplicate_event_id";

/** Local frame result; `Result` is restricted to `ErrorEnvelope` errors. */
export type JournalFormatResult<T> =
  | { readonly ok: true; readonly status: "ok"; readonly value: T }
  | { readonly ok: false; readonly status: "rejected"; readonly error: JournalFrameError };

export interface JournalFrameError {
  readonly reason: JournalFrameErrorReason;
  readonly offset: number;
  readonly detail: string;
  readonly expected_crc32c?: number;
  readonly actual_crc32c?: number;
  readonly payload_error?: JournalPayloadError;
}

export interface DecodedJournalFrame {
  readonly header: JournalFrameHeader;
  readonly payload: JournalFramePayload;
  readonly payload_bytes: Uint8Array;
  readonly payload_text: string;
  readonly payload_hash: Hash;
  /** Total bytes consumed by the frame, header included. */
  readonly frame_bytes: number;
}

function ok<T>(value: T): JournalFormatResult<T> {
  return { ok: true, status: "ok", value };
}

function err(
  reason: JournalFrameErrorReason,
  offset: number,
  detail: string,
): JournalFormatResult<never> {
  return { ok: false, status: "rejected", error: { reason, offset, detail } };
}

/** Validates `commit_seq` against the frame header contract. */
export function isValidCommitSeq(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= JOURNAL_MAX_COMMIT_SEQ;
}

/** Decodes only the 24-byte header at `offset`. */
export function decodeJournalFrameHeader(
  bytes: Uint8Array,
  offset: number,
): JournalFormatResult<JournalFrameHeader> {
  if (offset < 0 || bytes.length - offset < JOURNAL_HEADER_BYTES) {
    return err("short_header", offset, "fewer than 24 bytes remain");
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset + offset, JOURNAL_HEADER_BYTES);
  const magic = buffer.readUInt32BE(0);
  if (magic !== JOURNAL_FRAME_MAGIC) {
    return err("bad_magic", offset, "frame magic is not RSIJ");
  }
  const version = buffer.readUInt16BE(4);
  if (version !== JOURNAL_FRAME_VERSION) {
    return err("unsupported_version", offset, `unsupported frame version ${version}`);
  }
  const flags = buffer.readUInt16BE(6);
  if (flags !== 0) {
    return err("nonzero_flags", offset, `unknown frame flags 0x${flags.toString(16)}`);
  }
  const payloadLen = buffer.readUInt32BE(8);
  if (payloadLen < 1 || payloadLen > JOURNAL_MAX_PAYLOAD_BYTES) {
    return err("payload_length", offset, `payload_len ${payloadLen} is outside 1..8388608`);
  }
  const checksum = buffer.readUInt32BE(12);
  const commitSeqBig = buffer.readBigUInt64BE(16);
  if (commitSeqBig > BigInt(JOURNAL_MAX_COMMIT_SEQ)) {
    return err("commit_seq", offset, "commit_seq exceeds 2^53-1");
  }
  const commitSeq = Number(commitSeqBig);
  if (!isValidCommitSeq(commitSeq)) {
    return err("commit_seq", offset, `commit_seq ${commitSeq} must be >= 1`);
  }
  return ok({
    magic,
    version,
    flags,
    payload_len: payloadLen,
    crc32c: checksum,
    commit_seq: commitSeq
  });
}

/** Encodes one frame with the supplied first `commit_seq`. */
export function encodeJournalFrame(
  payload: JournalFramePayload,
  commitSeq: number,
): JournalFormatResult<Uint8Array> {
  if (!isValidCommitSeq(commitSeq)) {
    return err("commit_seq", 0, `commit_seq ${commitSeq} is outside 1..2^53-1`);
  }
  const validation = validateJournalFramePayload(payload);
  if (!validation.ok) {
    return {
      ok: false,
      status: "rejected",
      error: {
        reason: "invalid_payload",
        offset: 0,
        detail: `payload failed validation: ${validation.error.detail}`,
        payload_error: validation.error
      }
    };
  }
  const payloadText = canonicalJsonText(journalPayloadJson(validation.value));
  const payloadBytes = Buffer.from(payloadText, "utf8");
  if (payloadBytes.length < 1 || payloadBytes.length > JOURNAL_MAX_PAYLOAD_BYTES) {
    return err("payload_length", 0, `payload is ${payloadBytes.length} bytes`);
  }
  const header = Buffer.alloc(JOURNAL_HEADER_BYTES);
  header.writeUInt32BE(JOURNAL_FRAME_MAGIC, 0);
  header.writeUInt16BE(JOURNAL_FRAME_VERSION, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(payloadBytes.length, 8);
  header.writeBigUInt64BE(BigInt(commitSeq), 16);
  const crcInput = Buffer.concat([header.subarray(4, 12), header.subarray(16, 24), payloadBytes]);
  header.writeUInt32BE(crc32c(crcInput), 12);
  return ok(new Uint8Array(Buffer.concat([header, payloadBytes])));
}

/**
 * Decodes and fully validates one frame at `offset`.
 *
 * `baseOffset` is added to reported error offsets so a scanner can report
 * absolute file offsets even when decoding from a window buffer.
 */
export function decodeJournalFrame(
  bytes: Uint8Array,
  offset = 0,
  baseOffset = 0,
): JournalFormatResult<DecodedJournalFrame> {
  const headerResult = decodeJournalFrameHeader(bytes, offset);
  if (!headerResult.ok) {
    return {
      ok: false,
      status: "rejected",
      error: { ...headerResult.error, offset: baseOffset + headerResult.error.offset }
    };
  }
  const header = headerResult.value;
  const payloadStart = offset + JOURNAL_HEADER_BYTES;
  if (bytes.length - payloadStart < header.payload_len) {
    return err("short_payload", baseOffset + offset, "payload is truncated");
  }
  const payloadBytes = bytes.subarray(payloadStart, payloadStart + header.payload_len);
  const headerBytes = Buffer.from(bytes.buffer, bytes.byteOffset + offset, JOURNAL_HEADER_BYTES);
  const crcInput = Buffer.concat([
    headerBytes.subarray(4, 12),
    headerBytes.subarray(16, 24),
    payloadBytes
  ]);
  const actualCrc = crc32c(crcInput);
  if (actualCrc !== header.crc32c) {
    return {
      ok: false,
      status: "rejected",
      error: {
        reason: "crc_mismatch",
        offset: baseOffset + offset,
        detail: "frame CRC-32C does not match",
        expected_crc32c: header.crc32c,
        actual_crc32c: actualCrc
      }
    };
  }
  const payloadText = Buffer.from(payloadBytes).toString("utf8");
  if (!Buffer.from(payloadText, "utf8").equals(Buffer.from(payloadBytes))) {
    return err("invalid_utf8", baseOffset + offset, "payload is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return err("invalid_json", baseOffset + offset, "payload is not JSON");
  }
  const payloadResult = validateJournalFramePayload(parsed);
  if (!payloadResult.ok) {
    return {
      ok: false,
      status: "rejected",
      error: {
        reason: "invalid_payload",
        offset: baseOffset + offset,
        detail: payloadResult.error.detail,
        payload_error: payloadResult.error
      }
    };
  }
  const canonical = canonicalJsonText(journalPayloadJson(payloadResult.value));
  if (canonical !== payloadText) {
    return err(
      "non_canonical_json",
      baseOffset + offset,
      "payload is not RFC 8785 canonical JSON",
    );
  }
  return ok({
    header,
    payload: payloadResult.value,
    payload_bytes: payloadBytes,
    payload_text: payloadText,
    payload_hash: sha256Bytes(payloadBytes),
    frame_bytes: JOURNAL_HEADER_BYTES + header.payload_len
  });
}
