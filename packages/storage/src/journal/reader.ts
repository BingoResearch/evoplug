import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Hash } from "@evoplug/core";
import {
  JOURNAL_HEADER_BYTES,
  JOURNAL_MAX_PAYLOAD_BYTES,
  decodeJournalFrame,
  decodeJournalFrameHeader
} from "./frame.js";
import type { JournalFrameErrorReason } from "./frame.js";
import {
  frameEventRecords,
  journalFrameMemberCount,
  payloadBlobHashes
} from "./payload.js";
import type { JournalFramePayload } from "./payload.js";

/** Tail classification after a sequential scan (DD-FND-060). */
export type JournalTailState = "clean" | "corrupt_tail" | "corrupt_middle";

export interface JournalScanOptions {
  /** Byte offset to start scanning from; normally `journal_state.trusted_prefix_end`. */
  readonly start_offset?: number;
  /** Last already-trusted commit sequence. Frames must be strictly greater. */
  readonly last_commit_seq?: number;
  /** Stop after this many frames and report the consumed prefix as trustworthy. */
  readonly max_frames?: number;
}

export interface JournalFrameRecord {
  readonly file_offset: number;
  readonly frame_bytes: number;
  readonly payload_len: number;
  readonly commit_seq: number;
  readonly commit_seq_span: number;
  readonly payload: JournalFramePayload;
  readonly payload_hash: Hash;
  readonly event_ids: readonly string[];
  readonly blob_hashes: readonly Hash[];
}

export interface JournalScanResult {
  readonly frames: readonly JournalFrameRecord[];
  /** Byte offset immediately after the last trustworthy frame. */
  readonly trusted_prefix_end: number;
  readonly tail_state: JournalTailState;
  readonly corrupt_offset: number | null;
  readonly corrupt_reason: JournalFrameErrorReason | null;
  readonly corrupt_detail: string | null;
  readonly bytes_total: number;
}

interface ScanBudget {
  readonly startOffset: number;
  readonly lastCommitSeq: number;
  readonly maxFrames: number | null;
}

function initialResult(bytesTotal: number, startOffset: number): JournalScanResult {
  return {
    frames: [],
    trusted_prefix_end: startOffset,
    tail_state: "clean",
    corrupt_offset: null,
    corrupt_reason: null,
    corrupt_detail: null,
    bytes_total: bytesTotal
  };
}

interface DecodedAt {
  readonly record: JournalFrameRecord | null;
  readonly failure: {
    readonly reason: JournalFrameErrorReason;
    readonly detail: string;
  } | null;
}

/**
 * Decodes one frame from an in-memory buffer and applies the monotonic
 * `commit_seq` and event identity rules of DD-FND-060.
 */
function decodeAt(
  bytes: Uint8Array,
  offset: number,
  previousCommitSeq: number,
  seenEventIds: ReadonlySet<string>,
): DecodedAt {
  const decoded = decodeJournalFrame(bytes, offset, offset);
  if (!decoded.ok) {
    return {
      record: null,
      failure: { reason: decoded.error.reason, detail: decoded.error.detail }
    };
  }
  const frame = decoded.value;
  if (frame.header.commit_seq <= previousCommitSeq) {
    return {
      record: null,
      failure: {
        reason: "commit_seq_regression",
        detail: `commit_seq ${frame.header.commit_seq} is not greater than ${previousCommitSeq}`
      }
    };
  }
  const records = frameEventRecords(frame.payload);
  if (!records.ok) {
    return {
      record: null,
      failure: { reason: "invalid_payload", detail: records.error.detail }
    };
  }
  const eventIds: string[] = [];
  for (const record of records.value) {
    if (seenEventIds.has(record.event_id)) {
      return {
        record: null,
        failure: {
          reason: "duplicate_event_id",
          detail: `event_id ${record.event_id} appears twice`
        }
      };
    }
    eventIds.push(record.event_id);
  }
  return {
    record: {
      file_offset: offset,
      frame_bytes: frame.frame_bytes,
      payload_len: frame.header.payload_len,
      commit_seq: frame.header.commit_seq,
      commit_seq_span: journalFrameMemberCount(frame.payload),
      payload: frame.payload,
      payload_hash: frame.payload_hash,
      event_ids: eventIds,
      blob_hashes: payloadBlobHashes(frame.payload)
    },
    failure: null
  };
}

function probeLaterValidFrame(
  bytes: Uint8Array,
  fromOffset: number,
  previousCommitSeq: number,
): boolean {
  const magic = Buffer.from("RSIJ", "ascii");
  for (let offset = fromOffset; offset + JOURNAL_HEADER_BYTES <= bytes.length; offset += 1) {
    if (
      bytes[offset] !== magic[0] ||
      bytes[offset + 1] !== magic[1] ||
      bytes[offset + 2] !== magic[2] ||
      bytes[offset + 3] !== magic[3]
    ) {
      continue;
    }
    const decoded = decodeJournalFrame(bytes, offset, offset);
    if (decoded.ok && decoded.value.header.commit_seq > previousCommitSeq) {
      return true;
    }
  }
  return false;
}

function scanBuffer(bytes: Uint8Array, budget: ScanBudget): JournalScanResult {
  const frames: JournalFrameRecord[] = [];
  const seenEventIds = new Set<string>();
  let offset = budget.startOffset;
  let previousCommitSeq = budget.lastCommitSeq;
  let result = initialResult(bytes.length, budget.startOffset);

  while (offset < bytes.length) {
    if (budget.maxFrames !== null && frames.length >= budget.maxFrames) {
      result = {
        ...result,
        frames,
        trusted_prefix_end: offset,
        tail_state: "clean"
      };
      return result;
    }
    if (bytes.length - offset < JOURNAL_HEADER_BYTES) {
      result = {
        ...result,
        frames,
        trusted_prefix_end: offset,
        tail_state: "corrupt_tail",
        corrupt_offset: offset,
        corrupt_reason: "short_header",
        corrupt_detail: "fewer than 24 header bytes remain"
      };
      return result;
    }
    const header = decodeJournalFrameHeader(bytes, offset);
    if (!header.ok) {
      const middle = probeLaterValidFrame(bytes, offset + 1, previousCommitSeq);
      result = {
        ...result,
        frames,
        trusted_prefix_end: offset,
        tail_state: middle ? "corrupt_middle" : "corrupt_tail",
        corrupt_offset: offset,
        corrupt_reason: header.error.reason,
        corrupt_detail: header.error.detail
      };
      return result;
    }
    const frameBytes = JOURNAL_HEADER_BYTES + header.value.payload_len;
    if (header.value.payload_len > JOURNAL_MAX_PAYLOAD_BYTES || bytes.length - offset < frameBytes) {
      const middle = probeLaterValidFrame(bytes, offset + 1, previousCommitSeq);
      result = {
        ...result,
        frames,
        trusted_prefix_end: offset,
        tail_state: middle ? "corrupt_middle" : "corrupt_tail",
        corrupt_offset: offset,
        corrupt_reason: "short_payload",
        corrupt_detail: "frame payload is truncated"
      };
      return result;
    }
    const decoded = decodeAt(bytes, offset, previousCommitSeq, seenEventIds);
    if (decoded.record === null) {
      const middle = probeLaterValidFrame(bytes, offset + 1, previousCommitSeq);
      result = {
        ...result,
        frames,
        trusted_prefix_end: offset,
        tail_state: middle ? "corrupt_middle" : "corrupt_tail",
        corrupt_offset: offset,
        corrupt_reason: decoded.failure?.reason ?? "invalid_payload",
        corrupt_detail: decoded.failure?.detail ?? "invalid frame"
      };
      return result;
    }
    for (const eventId of decoded.record.event_ids) {
      seenEventIds.add(eventId);
    }
    frames.push(decoded.record);
    previousCommitSeq = decoded.record.commit_seq + decoded.record.commit_seq_span - 1;
    offset += frameBytes;
  }
  result = {
    ...result,
    frames,
    trusted_prefix_end: offset,
    tail_state: "clean"
  };
  return result;
}

/** Scans an in-memory journal image. Used by tests and by the file scanner. */
export function scanJournalBytes(
  bytes: Uint8Array,
  options: JournalScanOptions = {},
): JournalScanResult {
  return scanBuffer(bytes, {
    startOffset: options.start_offset ?? 0,
    lastCommitSeq: options.last_commit_seq ?? 0,
    maxFrames: options.max_frames ?? null
  });
}

function readExact(fd: number, length: number, position: number): Buffer | null {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const chunk = readSync(fd, buffer, read, length - read, position + read);
    if (chunk === 0) {
      return null;
    }
    read += chunk;
  }
  return buffer;
}

/**
 * Sequentially scans a journal file from the trusted prefix. A bad frame stops
 * the scan at the first invalid byte; later valid frames are only probed to
 * classify the tail as `corrupt_middle`, never to resume replay.
 */
export function scanJournalFile(
  filePath: string,
  options: JournalScanOptions = {},
): JournalScanResult {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const startOffset = options.start_offset ?? 0;
    if (startOffset > size) {
      return {
        frames: [],
        trusted_prefix_end: size,
        tail_state: "corrupt_tail",
        corrupt_offset: size,
        corrupt_reason: "short_header",
        corrupt_detail: "trusted_prefix_end is past end of file",
        bytes_total: size
      };
    }
    const remaining = readExact(fd, size - startOffset, startOffset);
    if (remaining === null && size > startOffset) {
      return {
        frames: [],
        trusted_prefix_end: startOffset,
        tail_state: "corrupt_tail",
        corrupt_offset: startOffset,
        corrupt_reason: "short_header",
        corrupt_detail: "journal file could not be read",
        bytes_total: size
      };
    }
    const buffer = remaining === null ? Buffer.alloc(0) : remaining;
    const scan = scanBuffer(buffer, {
      startOffset: 0,
      lastCommitSeq: options.last_commit_seq ?? 0,
      maxFrames: options.max_frames ?? null
    });
    return {
      ...scan,
      frames: scan.frames.map((frame) => ({
        ...frame,
        file_offset: frame.file_offset + startOffset
      })),
      trusted_prefix_end: scan.trusted_prefix_end + startOffset,
      corrupt_offset: scan.corrupt_offset === null ? null : scan.corrupt_offset + startOffset,
      bytes_total: size
    };
  } finally {
    closeSync(fd);
  }
}
