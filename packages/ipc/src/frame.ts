/**
 * 24-byte IPC frame codec (DD-FND-040).
 *
 * Layout, all integers big-endian:
 *
 *   0  u32  magic       ASCII "EVPC"
 *   4  u16  version     1
 *   6  u8   kind        1=hello 2=request 3=response 4=cancel
 *   7  u8   flags       must be 0 in v1
 *   8  u32  body_len    0..16777216
 *  12  u32  remaining_ms remaining milliseconds (hello is 1000, others 1..600000)
 *  16  u32  crc32c      coverage: 24 header bytes with this field zeroed, then body
 *  20  u32  reserved    must be 0 in v1
 */

import { crc32cUpdate } from "./crc32c.js";

const IPC_FRAME_VERSION = 1;
const IPC_FRAME_HEADER_BYTES = 24;
export const IPC_MAX_BODY_BYTES = 16_777_216;
export const IPC_MAX_FRAME_BYTES: number = IPC_FRAME_HEADER_BYTES + IPC_MAX_BODY_BYTES;
const IPC_CRC_OFFSET = 16;

export const IpcFrameKind: {
  readonly Hello: 1;
  readonly Request: 2;
  readonly Response: 3;
  readonly Cancel: 4;
} = {
  Hello: 1,
  Request: 2,
  Response: 3,
  Cancel: 4,
};

export type IpcFrameKind = (typeof IpcFrameKind)[keyof typeof IpcFrameKind];

function isIpcFrameKind(value: number): value is IpcFrameKind {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

type FrameErrorCode =
  | "E_IPC_PROTOCOL"
  | "E_IPC_BODY_TOO_LARGE"
  | "E_IPC_FRAME_TOO_LARGE"
  | "E_IPC_TRUNCATED";

interface IpcFrameHeader {
  readonly version: number;
  readonly kind: IpcFrameKind;
  readonly flags: number;
  readonly body_len: number;
  readonly remaining_ms: number;
  readonly crc32c: number;
  readonly reserved: number;
}

export interface IpcFrame {
  readonly header: IpcFrameHeader;
  readonly body: Uint8Array;
}

type FrameDecodeResult =
  | { readonly kind: "frame"; readonly frame: IpcFrame; readonly byte_length: number }
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid"; readonly code: FrameErrorCode; readonly reason: string };

type FrameReadResult =
  | { readonly kind: "frame"; readonly frame: IpcFrame }
  | { readonly kind: "error"; readonly code: FrameErrorCode; readonly reason: string };

/** Raised by the encoder for inputs that cannot form a legal v1 frame. */
export class IpcFrameError extends Error {
  public readonly code: FrameErrorCode;
  public readonly reason: string;

  public constructor(code: FrameErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "IpcFrameError";
    this.code = code;
    this.reason = reason;
  }
}

interface EncodeFrameInput {
  readonly kind: IpcFrameKind;
  readonly remaining_ms: number;
  readonly body: Uint8Array;
  readonly flags?: number;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function readU16(source: Uint8Array, offset: number): number {
  const high = source[offset] ?? 0;
  const low = source[offset + 1] ?? 0;
  return ((high << 8) | low) >>> 0;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readU32(source: Uint8Array, offset: number): number {
  const b0 = source[offset] ?? 0;
  const b1 = source[offset + 1] ?? 0;
  const b2 = source[offset + 2] ?? 0;
  const b3 = source[offset + 3] ?? 0;
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

function writeMagic(target: Uint8Array): void {
  target[0] = 0x45; // E
  target[1] = 0x56; // V
  target[2] = 0x50; // P
  target[3] = 0x43; // C
}

function hasMagic(source: Uint8Array, offset: number): boolean {
  return (
    source[offset] === 0x45 &&
    source[offset + 1] === 0x56 &&
    source[offset + 2] === 0x50 &&
    source[offset + 3] === 0x43
  );
}

/**
 * CRC coverage is "this header with the crc field zeroed, then the body".
 * The caller passes a header whose crc slot is already zero.
 */
function computeFrameCrc(headerWithZeroCrc: Uint8Array, body: Uint8Array): number {
  const headerCrc = crc32cUpdate(0, headerWithZeroCrc);
  return crc32cUpdate(headerCrc, body);
}

/**
 * Encodes one frame. Throws `IpcFrameError` when the body exceeds 16 MiB or the
 * deadline is outside the v1 range; the transport maps that to the matching
 * `E_IPC_*` envelope instead of writing a bad frame.
 */
export function encodeFrame(input: EncodeFrameInput): Uint8Array {
  const bodyLength = input.body.length;
  if (bodyLength > IPC_MAX_BODY_BYTES) {
    throw new IpcFrameError(
      "E_IPC_BODY_TOO_LARGE",
      `body_len ${String(bodyLength)} exceeds ${String(IPC_MAX_BODY_BYTES)}`,
    );
  }
  if (!Number.isInteger(input.remaining_ms) || input.remaining_ms < 0 || input.remaining_ms > 0xffffffff) {
    throw new IpcFrameError("E_IPC_PROTOCOL", "remaining_ms out of range");
  }
  const flags = input.flags ?? 0;
  if (flags !== 0) {
    throw new IpcFrameError("E_IPC_PROTOCOL", "flags must be 0 in v1");
  }

  const frame = new Uint8Array(IPC_FRAME_HEADER_BYTES + bodyLength);
  writeMagic(frame);
  writeU16(frame, 4, IPC_FRAME_VERSION);
  frame[6] = input.kind;
  frame[7] = flags;
  writeU32(frame, 8, bodyLength);
  writeU32(frame, 12, input.remaining_ms);
  writeU32(frame, 16, 0);
  writeU32(frame, 20, 0);
  frame.set(input.body, IPC_FRAME_HEADER_BYTES);

  const header = frame.subarray(0, IPC_FRAME_HEADER_BYTES);
  writeU32(frame, IPC_CRC_OFFSET, computeFrameCrc(header, input.body));
  return frame;
}

/**
 * Decodes one frame starting at `offset`.
 *
 * Returns `incomplete` when the buffer holds a valid prefix of a frame; the
 * streaming reader then waits for more bytes. Any header invariant violation
 * returns `invalid` and the caller must close the connection — the design
 * forbids resynchronising after a bad frame.
 */
export function decodeFrame(bytes: Uint8Array, offset = 0): FrameDecodeResult {
  if (bytes.length - offset < IPC_FRAME_HEADER_BYTES) {
    return { kind: "incomplete" };
  }
  if (!hasMagic(bytes, offset)) {
    return { kind: "invalid", code: "E_IPC_PROTOCOL", reason: "bad_magic" };
  }
  const version = readU16(bytes, offset + 4);
  if (version !== IPC_FRAME_VERSION) {
    return { kind: "invalid", code: "E_IPC_PROTOCOL", reason: "bad_version" };
  }
  const rawKind = bytes[offset + 6] ?? 0;
  if (!isIpcFrameKind(rawKind)) {
    return { kind: "invalid", code: "E_IPC_PROTOCOL", reason: "bad_kind" };
  }
  const flags = bytes[offset + 7] ?? 0;
  if (flags !== 0) {
    return { kind: "invalid", code: "E_IPC_PROTOCOL", reason: "bad_flags" };
  }
  const bodyLength = readU32(bytes, offset + 8);
  if (bodyLength > IPC_MAX_BODY_BYTES) {
    return { kind: "invalid", code: "E_IPC_BODY_TOO_LARGE", reason: "body_len_exceeds_limit" };
  }
  const deadline = readU32(bytes, offset + 12);
  const expectedCrc = readU32(bytes, offset + 16);
  const reserved = readU32(bytes, offset + 20);
  if (reserved !== 0) {
    return { kind: "invalid", code: "E_IPC_PROTOCOL", reason: "bad_reserved" };
  }
  const total = IPC_FRAME_HEADER_BYTES + bodyLength;
  if (bytes.length - offset < total) {
    return { kind: "incomplete" };
  }
  const header = bytes.slice(offset, offset + IPC_FRAME_HEADER_BYTES);
  header.fill(0, IPC_CRC_OFFSET, IPC_CRC_OFFSET + 4);
  const body = bytes.slice(offset + IPC_FRAME_HEADER_BYTES, offset + total);
  const actualCrc = computeFrameCrc(header, body);
  if (actualCrc !== expectedCrc) {
    return { kind: "invalid", code: "E_IPC_PROTOCOL", reason: "bad_crc32c" };
  }
  return {
    kind: "frame",
    byte_length: total,
    frame: {
      header: {
        version,
        kind: rawKind,
        flags,
        body_len: bodyLength,
        remaining_ms: deadline,
        crc32c: expectedCrc,
        reserved,
      },
      body,
    },
  };
}

/**
 * True when `remaining_ms` is legal for the frame kind: hello is fixed at
 * 1000 ms, every other frame carries 1..600000 ms of remaining work.
 */
export function isValidFrameDeadline(kind: IpcFrameKind, deadlineMs: number): boolean {
  if (kind === IpcFrameKind.Hello) {
    return deadlineMs === 1000;
  }
  return Number.isInteger(deadlineMs) && deadlineMs >= 1 && deadlineMs <= 600000;
}

/** Streaming decoder: feed socket chunks, get whole frames back. */
export class FrameReader {
  private buffer: Uint8Array = new Uint8Array(0);

  public get bufferedBytes(): number {
    return this.buffer.length;
  }

  public push(chunk: Uint8Array): FrameReadResult[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    const results: FrameReadResult[] = [];
    if (this.buffer.length > IPC_MAX_FRAME_BYTES) {
      this.buffer = new Uint8Array(0);
      results.push({ kind: "error", code: "E_IPC_FRAME_TOO_LARGE", reason: "buffer_exceeds_max_frame" });
      return results;
    }
    let consumed = 0;
    while (this.buffer.length - consumed >= IPC_FRAME_HEADER_BYTES) {
      const decoded = decodeFrame(this.buffer, consumed);
      if (decoded.kind === "incomplete") {
        break;
      }
      if (decoded.kind === "invalid") {
        results.push({ kind: "error", code: decoded.code, reason: decoded.reason });
        this.buffer = new Uint8Array(0);
        return results;
      }
      results.push({ kind: "frame", frame: decoded.frame });
      consumed += decoded.byte_length;
    }
    if (consumed > 0) {
      this.buffer = this.buffer.slice(consumed);
    }
    return results;
  }

  /** Bytes left over when the peer closed: a partial frame is a truncation. */
  public takeRemainder(): Uint8Array {
    const remainder = this.buffer;
    this.buffer = new Uint8Array(0);
    return remainder;
  }
}
