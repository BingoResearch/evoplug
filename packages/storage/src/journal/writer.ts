import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ErrorEnvelope, Result } from "@evoplug/core";
import { fieldDetails, storageDetails, storageError, type StorageErrorCode } from "../errors.js";
import { JOURNAL_MAX_FILE_BYTES, JOURNAL_MAX_PAYLOAD_BYTES, encodeJournalFrame } from "./frame.js";
import {
  isJournalEraPoisoned,
  loadJournalEraFence,
  poisonJournalEra,
  type JournalFenceDetail
} from "./era.js";
import { journalFrameMemberCount, validateJournalFramePayload } from "./payload.js";
import type { JournalFramePayload } from "./payload.js";
import { scanJournalBytes } from "./reader.js";
import type { JournalTailState } from "./reader.js";

interface JournalWriterOptions {
  /** Absolute path of the `.rsij` file. */
  readonly file_path: string;
  /** Logical journal identity stored in `journal_state.journal_id`. */
  readonly journal_id: string;
  /** Last durable commit sequence in this journal era. */
  readonly last_commit_seq: number;
  /**
   * `journal_state.trusted_prefix_end` of the segment being opened.
   *
   * A writer must never append behind a durable frame whose SQLite projection
   * did not commit. The persisted prefix is the byte boundary recovery proved
   * trustworthy; when the file is longer, an unprojected frame (or a corrupt
   * tail) sits after it and appending would shadow it forever. Supplying the
   * prefix turns that condition into a fail-closed open instead of a silent
   * sequence reuse. Callers that know the era's state row should always pass
   * it, including `0` when no row exists, so a non-empty orphan file is
   * rejected rather than appended to.
   */
  readonly trusted_prefix_end?: number;
  /**
   * `journal_state.read_only`. A read-only era needs explicit recovery; a
   * writer opened for it must fail closed instead of appending.
   */
  readonly read_only?: boolean;
  /**
   * `journal_state.tail_state`. Only a `clean` era may be appended to; a
   * corrupt tail has to be quarantined into a new era first (DD-FND-060).
   */
  readonly tail_state?: JournalTailState;
  /** Rotation threshold; defaults to 256 MiB. */
  readonly max_file_bytes?: number;
  /** Hard single-frame payload limit; defaults to 8 MiB. */
  readonly max_payload_bytes?: number;
  /** Rotate automatically when the next frame would exceed `max_file_bytes`. */
  readonly auto_rotate?: boolean;
  /**
   * Reads the shared commit sequence of this journal era.
   *
   * `commit_seq` is global over the journal era (DD-FND-059): the kernel's
   * event writer and the IPC idempotency writer are two `JournalWriter`
   * instances on the same file, and each allocates from its own private
   * counter. The persisted `journal_state.last_commit_seq` is the one counter
   * both writers agree on, so a writer re-syncs against it before every
   * append. Without that re-sync the two counters collide, the
   * `commit_record` primary key rejects the loser, and a frame is silently
   * dropped.
   */
  readonly shared_commit_seq?: () => number;
}

export interface JournalAppendResult {
  readonly journal_id: string;
  readonly file_path: string;
  readonly file_offset: number;
  readonly frame_bytes: number;
  readonly first_commit_seq: number;
  readonly last_commit_seq: number;
  readonly member_count: number;
}

function fenceReasonOf(error: ErrorEnvelope): string {
  const details = error.details as { readonly sqlite_code?: unknown };
  return typeof details.sqlite_code === "string" && details.sqlite_code.length > 0
    ? details.sqlite_code
    : "journal_fence";
}

function fsFailure(
  error: unknown,
  operation: string,
  stage: string,
  enospcCode: StorageErrorCode = "E_STORAGE_JOURNAL_ENOSPC"
): ErrorEnvelope {
  const code =
    typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "ENOSPC") {
    return storageError({
      code: enospcCode,
      stage,
      details: storageDetails(operation, "ENOSPC"),
      side_effect: "unknown"
    });
  }
  return storageError({
    code: "E_STORAGE_IO",
    stage,
    details: storageDetails(operation, typeof code === "string" ? code : undefined),
    side_effect: "unknown"
  });
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function nextJournalPath(filePath: string): string | null {
  const directory = dirname(filePath);
  const base = filePath.slice(directory.length + 1);
  const match = /^journal-(\d{6})\.rsij$/.exec(base);
  if (match === null) {
    return null;
  }
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence)) {
    return null;
  }
  return join(directory, `journal-${String(sequence + 1).padStart(6, "0")}.rsij`);
}

const JOURNAL_SEGMENT = /^journal-(\d{6})\.rsij$/;

function isSafeHomeRelative(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    return false;
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:\//.test(relativePath)) {
    return false;
  }
  const parts = relativePath.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * The home-relative path to record in `journal_state` for a receipt.
 *
 * Rotation moves the writer to the next `journal-<NNNNNN>.rsij` segment while
 * the configured relative path still names the first segment. Recording the
 * configured path with an offset from the new file would make recovery read
 * the wrong bytes, so the receipt's actual file decides the directory entry.
 *
 * The receipt is only trusted to name a standard journal segment inside the
 * configured directory. An unchanged basename keeps the caller's configured
 * path verbatim (it may use a nested directory); otherwise the standard name
 * is joined to the configured directory. Absolute, traversal and malformed
 * names return `null`, which callers must treat as a fail-closed recovery
 * condition.
 */
export function receiptRelativePath(
  configuredRelativePath: string,
  receiptFilePath: string
): string | null {
  const receiptName = basename(receiptFilePath);
  if (receiptName === basename(configuredRelativePath)) {
    return configuredRelativePath;
  }
  if (!JOURNAL_SEGMENT.test(receiptName)) {
    return null;
  }
  const normalized = configuredRelativePath.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  const directory = slash === -1 ? "" : normalized.slice(0, slash);
  if (directory !== "" && !isSafeHomeRelative(directory)) {
    return null;
  }
  return directory === "" ? receiptName : `${directory}/${receiptName}`;
}

/**
 * Canonical ENOSPC code for the stage a journal frame belongs to
 * (DD-FND-103). The frame's `event_type` names the write stage:
 * `ipc_idempotency.finished` finishes an ACK, `outbox.enqueued` and
 * `delivery.recorded` enqueue a delivery, every other frame is a plain
 * journal write.
 */
function enospcCodeForFrame(payload: JournalFramePayload): StorageErrorCode {
  const eventTypes: string[] = [];
  const event = (payload as { readonly event?: unknown }).event;
  if (typeof event === "object" && event !== null) {
    const eventType = (event as { readonly event_type?: unknown }).event_type;
    if (typeof eventType === "string") {
      eventTypes.push(eventType);
    }
  }
  const members = (payload as { readonly members?: unknown }).members;
  if (Array.isArray(members)) {
    for (const member of members) {
      const memberEvent = (member as { readonly event?: unknown }).event;
      if (typeof memberEvent === "object" && memberEvent !== null) {
        const eventType = (memberEvent as { readonly event_type?: unknown }).event_type;
        if (typeof eventType === "string") {
          eventTypes.push(eventType);
        }
      }
    }
  }
  if (eventTypes.includes("ipc_idempotency.finished")) {
    return "E_STORAGE_ACK_ENOSPC";
  }
  if (
    eventTypes.includes("outbox.enqueued") ||
    eventTypes.includes("delivery.recorded") ||
    eventTypes.includes("outbox.attempt_started")
  ) {
    return "E_STORAGE_DELIVERY_ENOSPC";
  }
  return "E_STORAGE_JOURNAL_ENOSPC";
}

/**
 * Append-only journal writer. Every `append` performs `write` + `fsync(fd)`;
 * the returned sequence range only becomes durable when `append` returns Ok.
 *
 * The class is synchronous by design: journal fsync is a blocking system call
 * and the single writer gate must not interleave two appends.
 */
export class JournalWriter {
  readonly #journalId: string;
  readonly #maxFileBytes: number;
  readonly #maxPayloadBytes: number;
  readonly #autoRotate: boolean;
  #filePath: string;
  #fd: number;
  #size: number;
  #lastCommitSeq: number;
  readonly #sharedCommitSeq: (() => number) | null;
  /**
   * Last byte offset this writer proved to be a projected frame boundary.
   * `null` means the caller supplied no persisted prefix, so append-time
   * validation is limited to what the writer itself has written.
   */
  #validatedPrefixEnd: number | null;
  /** Last commit sequence covered by `#validatedPrefixEnd`. */
  #validatedLastSeq: number;
  readonly #optionsReadOnly: boolean;
  readonly #optionsTailState: JournalTailState | undefined;
  /** True after this instance wrote a frame and before its next re-sync. */
  #appendedSinceResync: boolean;
  /** Last fence reason, exposed only through the error detail. */
  #fenceReason: string | null;
  #failed: boolean;
  #closed: boolean;

  private constructor(options: JournalWriterOptions, fd: number, size: number) {
    this.#journalId = options.journal_id;
    this.#maxFileBytes = options.max_file_bytes ?? JOURNAL_MAX_FILE_BYTES;
    this.#maxPayloadBytes = options.max_payload_bytes ?? JOURNAL_MAX_PAYLOAD_BYTES;
    this.#autoRotate = options.auto_rotate ?? true;
    this.#filePath = options.file_path;
    this.#fd = fd;
    this.#size = size;
    this.#lastCommitSeq = options.last_commit_seq;
    this.#sharedCommitSeq = options.shared_commit_seq ?? null;
    this.#validatedPrefixEnd = options.trusted_prefix_end ?? null;
    this.#validatedLastSeq = options.last_commit_seq;
    this.#optionsReadOnly = options.read_only === true;
    this.#optionsTailState = options.tail_state;
    this.#appendedSinceResync = false;
    const existingFence = loadJournalEraFence(this.#filePath, this.#journalId);
    this.#fenceReason = existingFence === null ? null : "journal_recovery_required";
    this.#failed = false;
    this.#closed = false;
  }

  /**
   * Opens (creating when absent) a journal file. A new file and its directory
   * are fsynced before the first frame is allowed.
   *
   * An existing file is not fsynced again: its durable prefix was already
   * synced by the appends that wrote it, and opening for append writes no
   * bytes. The first `append` still syncs the file before it returns, so
   * skipping the open-time flush cannot make a frame visible before it is
   * durable.
   */
  static open(options: JournalWriterOptions): Result<JournalWriter, ErrorEnvelope> {
    const directory = dirname(options.file_path);
    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        status: "rejected",
        error: fsFailure(error, "mkdir", "storage.journal")
      };
    }
    const existed = existsSync(options.file_path);
    let fd: number;
    try {
      fd = openSync(options.file_path, "a");
    } catch (error) {
      return {
        ok: false,
        status: "rejected",
        error: fsFailure(error, "open", "storage.journal")
      };
    }
    try {
      if (!existed) {
        fsyncSync(fd);
        fsyncDirectory(directory);
      }
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Ignore secondary close failure.
      }
      return {
        ok: false,
        status: "rejected",
        error: fsFailure(error, "fsync", "storage.journal")
      };
    }
    let size: number;
    try {
      size = statSync(options.file_path).size;
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Ignore secondary close failure.
      }
      return {
        ok: false,
        status: "rejected",
        error: fsFailure(error, "stat", "storage.journal")
      };
    }
    const writer = new JournalWriter(options, fd, size);
    const fenced = writer.#openFenceError();
    if (fenced !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore secondary close failure.
      }
      return { ok: false, status: "rejected", error: fenced };
    }
    return { ok: true, status: "ok", value: writer };
  }

  /**
   * Refuses to open an era that recovery has not made writable, and checks
   * the persisted trusted prefix against the file's real tail.
   *
   * A file longer than `trusted_prefix_end` carries bytes the last SQLite
   * transaction did not project: either a durable frame from the
   * fsync-before-commit window or a corrupt tail. Appending behind them would
   * reuse a `commit_seq` and make recovery report a clean prefix while the
   * old frame stays shadowed forever. A file shorter than the prefix means
   * the state row is ahead of the bytes (truncation or a foreign file).
   *
   * Both are recovery-required conditions, not writer-level poison: a fresh
   * process has no in-memory fence, so the check has to come from the
   * persisted state and the bytes on disk.
   */
  #openFenceError(): ErrorEnvelope | null {
    if (this.#closed) {
      return null;
    }
    // The option fields are not kept individually; re-check them from the
    // constructor-time copies. Read-only and non-clean tails are persisted
    // fail-closed markers.
    if (this.#optionsReadOnly) {
      return this.#fencedOpenError("journal_read_only");
    }
    if (this.#optionsTailState !== undefined && this.#optionsTailState !== "clean") {
      return this.#fencedOpenError(`journal_tail_${this.#optionsTailState}`);
    }
    if (this.#validatedPrefixEnd === null) {
      return null;
    }
    const prefix = this.#validatedPrefixEnd;
    if (!Number.isSafeInteger(prefix) || prefix < 0) {
      return this.#fencedOpenError("journal_prefix_invalid");
    }
    if (this.#size !== prefix) {
      return this.#fencedOpenError(
        `journal_prefix_mismatch:file=${this.#size}:state=${prefix}`
      );
    }
    if (prefix === 0) {
      this.#validatedLastSeq = this.#lastCommitSeq;
      return null;
    }
    return this.#validateRange({
      start: 0,
      end: prefix,
      previousSeq: -1,
      expectedLastSeq: this.#lastCommitSeq,
      operation: "open"
    });
  }

  #fencedOpenError(detail: string): ErrorEnvelope {
    return storageError({
      code: "E_STORAGE_CORRUPT",
      stage: "storage.journal",
      details: storageDetails("open", detail),
      side_effect: "none"
    });
  }

  /**
   * Scans `[start, end)` and proves it is a contiguous, valid frame range
   * ending exactly at `end`, with the last frame's sequence equal to the
   * persisted sequence.
   *
   * `previousSeq` is the last sequence already trusted before `start`; `-1`
   * means "no lower bound" for the first segment of an era whose base is
   * above zero.
   */
  #validateRange(input: {
    readonly start: number;
    readonly end: number;
    readonly previousSeq: number;
    readonly expectedLastSeq: number;
    readonly operation: string;
  }): ErrorEnvelope | null {
    const length = input.end - input.start;
    if (length <= 0) {
      this.#validatedPrefixEnd = input.end;
      this.#validatedLastSeq = input.expectedLastSeq;
      return null;
    }
    let bytes: Buffer = Buffer.alloc(0);
    let readFd: number | null = null;
    try {
      bytes = Buffer.allocUnsafe(length);
      // The writer descriptor is opened write-only; validation reads through
      // a separate read-only descriptor.
      readFd = openSync(this.#filePath, "r");
      let read = 0;
      while (read < length) {
        const chunk = readSync(readFd, bytes, read, length - read, input.start + read);
        if (chunk <= 0) {
          return this.#fencedOpenError(
            `journal_prefix_unreadable:${input.start}:${length}`
          );
        }
        read += chunk;
      }
    } catch {
      return this.#fencedOpenError(`journal_prefix_unreadable:${input.start}:${length}`);
    } finally {
      if (readFd !== null) {
        try {
          closeSync(readFd);
        } catch {
          // Ignore secondary close failure.
        }
      }
    }
    const scan = scanJournalBytes(bytes, {
      start_offset: 0,
      last_commit_seq: input.previousSeq
    });
    if (
      scan.tail_state !== "clean" ||
      scan.trusted_prefix_end !== length ||
      scan.frames.length === 0
    ) {
      return this.#fencedOpenError(
        `journal_prefix_invalid:${input.start}:${scan.tail_state}`
      );
    }
    const last = scan.frames[scan.frames.length - 1]!;
    const lastSeq = last.commit_seq + last.commit_seq_span - 1;
    if (lastSeq !== input.expectedLastSeq) {
      return this.#fencedOpenError(
        `journal_sequence_mismatch:state=${input.expectedLastSeq}:file=${lastSeq}`
      );
    }
    this.#validatedPrefixEnd = input.end;
    this.#validatedLastSeq = lastSeq;
    return null;
  }

  /** Last durable commit sequence. */
  get lastCommitSeq(): number {
    return this.#lastCommitSeq;
  }

  /**
   * Adopts a commit sequence that another writer on the same journal era has
   * already reached.
   *
   * `commit_seq` is a global monotonic sequence over the whole journal
   * (DD-FND-059), but a `JournalWriter` instance only knows the sequence up
   * to the frame it wrote itself. Two writers on the same file therefore
   * allocate from independent counters and collide. The persisted
   * `journal_state.last_commit_seq` is the counter they agree on, so a
   * writer re-syncs against it before its next append.
   *
   * The sequence is only ever moved *forward*: a lower value is ignored, so
   * the writer never reuses a sequence it already wrote.
   */
  adoptCommitSeq(commitSeq: number): void {
    if (!Number.isSafeInteger(commitSeq) || commitSeq < 0) {
      return;
    }
    if (commitSeq > this.#lastCommitSeq) {
      this.#lastCommitSeq = commitSeq;
    }
  }

  /**
   * Re-reads the file size, the shared commit sequence and the persisted
   * trusted prefix.
   *
   * Two `JournalWriter` instances on one file each track their own append
   * offset; without a re-sync the second writer overwrites the bytes the
   * first one wrote. The re-sync moves the append offset to the end of the
   * file and the commit sequence to the shared counter, so the two writers
   * append instead of overwriting.
   *
   * When `relativePath` is supplied it is the `journal_state.relative_path`
   * of the era. If it names a different journal segment (another writer
   * rotated the era), the writer reopens that segment and adopts it. A path
   * that is absolute, escapes the writer's directory, is not a
   * `journal-<NNNNNN>.rsij` name, does not exist, or moves the segment
   * backwards puts the writer into recovery-required mode; it never falls
   * back to writing the stale file.
   *
   * When `trustedPrefixEnd` is supplied it is the era's persisted prefix for
   * that segment. The file must end exactly there and every frame the state
   * row already covers must be present with the persisted sequence. A crash
   * after the journal fsync but before the SQLite transaction leaves the
   * file longer than the prefix; a fresh process has no in-memory fence, so
   * this check is what stops it from reusing the durable frame's
   * `commit_seq`. A mismatch marks the writer recovery-required and poisons
   * the era; no bytes are written.
   */
  resyncFromDisk(
    commitSeq: number,
    relativePath?: string,
    trustedPrefixEnd?: number
  ): void {
    if (this.#closed) {
      this.#failed = true;
      return;
    }
    if (relativePath !== undefined) {
      const previousPath = this.#filePath;
      if (!this.#adoptStatePath(relativePath)) {
        // Not a physical write failure: the state row disagrees with this
        // writer's segment. Fence the era only, so a successful recovery that
        // repairs the path lets the same instance re-sync and continue.
        poisonJournalEra(this.#filePath, this.#journalId);
        this.#failed = true;
        return;
      }
      if (this.#filePath !== previousPath) {
        // A different segment has its own prefix; discard the old proof.
        this.#validatedPrefixEnd = null;
        this.#validatedLastSeq = commitSeq;
      }
    }
    const actualSize = this.#currentFileSize();
    if (trustedPrefixEnd !== undefined) {
      const violation = this.#validatePersistedPrefix(
        trustedPrefixEnd,
        commitSeq
      );
      if (violation !== null) {
        this.#failed = true;
        this.#fenceReason = fenceReasonOf(violation);
        poisonJournalEra(this.#filePath, this.#journalId);
        return;
      }
      this.#size = trustedPrefixEnd;
    } else {
      // No persisted prefix was supplied. The file tail must still agree with
      // the sequence this writer already knows: a frame beyond it is a crash
      // window this process has not replayed, and a tail below it means the
      // counter was taken from a state row whose frames are gone.
      const expected = Math.max(commitSeq, this.#lastCommitSeq);
      const violation = this.#validateHeadSequence(expected);
      if (violation !== null) {
        this.#failed = true;
        this.#fenceReason = fenceReasonOf(violation);
        poisonJournalEra(this.#filePath, this.#journalId);
        return;
      }
      this.#size = Math.max(this.#size, actualSize);
    }
    this.adoptCommitSeq(commitSeq);
    this.#appendedSinceResync = false;
  }

  /**
   * Validates the whole current segment against a sequence this writer
   * already trusts, without a `journal_state` prefix.
   *
   * This covers writers that append several frames before writing their
   * `journal_state` row (a multi-frame commit projects all of them in one
   * transaction) and openers that only know `last_commit_seq`. A non-empty
   * file whose tail is ahead of that sequence is an unprojected crash window;
   * one whose tail is behind it means the counter no longer describes the
   * bytes.
   */
  #validateHeadSequence(expectedLastSeq: number): ErrorEnvelope | null {
    const size = this.#currentFileSize();
    if (size === 0) {
      this.#validatedPrefixEnd = 0;
      this.#validatedLastSeq = expectedLastSeq;
      return null;
    }
    if (this.#validatedPrefixEnd === size) {
      return this.#validatedLastSeq === expectedLastSeq
        ? null
        : this.#fencedOpenError(
            `journal_sequence_regression:file=${this.#validatedLastSeq}:state=${expectedLastSeq}`
          );
    }
    return this.#validateRange({
      start: 0,
      end: size,
      previousSeq: -1,
      expectedLastSeq,
      operation: "resync"
    });
  }

  /**
   * Checks the persisted prefix against the bytes of the current segment.
   *
   * The first call after open (or after adopting a new segment) validates the
   * whole `[0, prefix)` range. Later calls only scan the bytes another writer
   * added since the last proof, so the common per-append case is one `stat`.
   */
  #validatePersistedPrefix(prefix: number, commitSeq: number): ErrorEnvelope | null {
    if (!Number.isSafeInteger(prefix) || prefix < 0) {
      return this.#fencedOpenError("journal_prefix_invalid");
    }
    const size = this.#currentFileSize();
    if (this.#validatedPrefixEnd === null) {
      if (size !== prefix) {
        return this.#fencedOpenError(
          `journal_prefix_mismatch:file=${size}:state=${prefix}`
        );
      }
      if (prefix === 0) {
        this.#validatedPrefixEnd = 0;
        this.#validatedLastSeq = commitSeq;
        return null;
      }
      return this.#validateRange({
        start: 0,
        end: prefix,
        previousSeq: -1,
        expectedLastSeq: commitSeq,
        operation: "resync"
      });
    }
    const validated = this.#validatedPrefixEnd;
    if (prefix < validated) {
      // A multi-frame commit appends every frame before its one SQLite
      // transaction records the tail, so a re-sync in the middle legitimately
      // sees the state row behind this writer's own frames. Accept only that
      // shape: this instance appended since the last re-sync, the file ends
      // exactly at the bytes it wrote, and the state sequence did not move
      // past them. An external rollback with no append is still rejected.
      if (
        this.#appendedSinceResync &&
        size === validated &&
        commitSeq <= this.#validatedLastSeq
      ) {
        return null;
      }
      return this.#fencedOpenError(
        `journal_prefix_regression:validated=${validated}:state=${prefix}`
      );
    }
    if (size !== prefix) {
      return this.#fencedOpenError(
        `journal_prefix_mismatch:file=${size}:state=${prefix}`
      );
    }
    if (prefix === validated) {
      // No new bytes are covered by the state row. The sequence must not have
      // moved on its own; that would mean the state was advanced without a
      // durable frame.
      return commitSeq === this.#validatedLastSeq
        ? null
        : this.#fencedOpenError(
            `journal_sequence_regression:validated=${this.#validatedLastSeq}:state=${commitSeq}`
          );
    }
    return this.#validateRange({
      start: validated,
      end: prefix,
      previousSeq: this.#validatedLastSeq,
      expectedLastSeq: commitSeq,
      operation: "resync"
    });
  }

  /**
   * Reopens the segment named by `journal_state.relative_path`.
   *
   * Returns `true` when the writer already points at that segment or has
   * adopted it, and `false` for any path that cannot be trusted. The caller
   * turns `false` into a recovery-required writer.
   */
  #adoptStatePath(relativePath: string): boolean {
    const normalized = relativePath.replaceAll("\\", "/");
    if (!isSafeHomeRelative(normalized)) {
      return false;
    }
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    const target = JOURNAL_SEGMENT.exec(name);
    if (target === null) {
      return false;
    }
    // The writer's own path is authoritative for the directory: journal
    // segments are colocated, and `journal_state.relative_path` may carry a
    // home-relative `journal/` prefix that the writer's absolute path already
    // includes.
    if (name === basename(this.#filePath)) {
      return true;
    }
    const candidate = join(dirname(this.#filePath), name);
    // The era only moves forward. A state row that still names an older
    // segment is stale (its writer rotated but the projection failed), so
    // appending to it would fork the journal.
    const current = JOURNAL_SEGMENT.exec(basename(this.#filePath));
    if (current !== null && Number(target[1]) < Number(current[1])) {
      return false;
    }
    let fd: number | null = null;
    let size: number;
    try {
      fd = openSync(candidate, "a");
      size = statSync(candidate).size;
    } catch {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Ignore secondary close failure.
        }
      }
      return false;
    }
    const previous = this.#fd;
    this.#fd = fd;
    this.#filePath = candidate;
    this.#size = size;
    try {
      closeSync(previous);
    } catch {
      // The old descriptor is no longer needed.
    }
    return true;
  }

  /** The size of the journal file right now, or 0 when it cannot be read. */
  #currentFileSize(): number {
    try {
      return statSync(this.#filePath).size;
    } catch {
      return 0;
    }
  }

  /** Current journal file path. */
  get filePath(): string {
    return this.#filePath;
  }

  /** Current journal file size in bytes. */
  get size(): number {
    return this.#size;
  }

  /** Journal identity recorded in `journal_state`. */
  get journalId(): string {
    return this.#journalId;
  }

  /** True when a previous append failed after the write started. */
  get needsRecovery(): boolean {
    return (
      this.#failed ||
      isJournalEraPoisoned(this.#filePath, this.#journalId)
    );
  }

  /**
   * Marks the whole era recovery-required after a durable frame whose SQLite
   * projection did not commit. Every writer instance in this process refuses
   * further appends until recovery has advanced the persisted tail past the
   * frame; otherwise a second writer would reuse its `commit_seq`.
   *
   * The fence is the shared era registry, not an instance flag, so a
   * successful recovery can lift it for every live writer. A physical
   * partial write keeps its own `#failed` flag and stays blocked.
   */
  markRecoveryRequired(detail?: JournalFenceDetail): void {
    this.#fenceReason = detail?.error_code ?? "journal_recovery_required";
    poisonJournalEra(this.#filePath, this.#journalId, detail);
  }

  /** Recovery-required envelope with unknown side effects for a durable era. */
  #recoveryRequired(operation: string): ErrorEnvelope {
    return storageError({
      code: "E_STORAGE_JOURNAL_RECOVERY_REQUIRED",
      stage: "storage.journal",
      details: storageDetails(
        operation,
        this.#fenceReason === null
          ? "writer_recovery_required"
          : `writer_recovery_required:${this.#fenceReason}`
      ),
      side_effect: "unknown"
    });
  }

  /**
   * Appends one frame. On any write/fsync failure the writer refuses further
   * appends; the caller must run journal recovery and start a new era.
   */
  append(
    payload: JournalFramePayload,
    options?: {
      readonly enospc_code?: StorageErrorCode | undefined;
      /**
       * Sequence the payload was already hashed with. The append re-syncs the
       * shared counter first; if another writer consumed that sequence the
       * frame is rejected before any byte is written, so an envelope cannot
       * become durable under a header sequence it does not hash to.
       */
      readonly expected_first_commit_seq?: number | undefined;
    }
  ): Result<JournalAppendResult, ErrorEnvelope> {
    if (this.#closed) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_IO",
          stage: "storage.journal",
          details: storageDetails("append", "writer_closed")
        })
      };
    }
    // The append offset is re-read from the OS before every frame. A
    // journal era may carry more than one writer (the kernel's event writer
    // and its ACK writer are two instances on the same file); each instance
    // tracks its own offset, so without the re-read the second writer
    // overwrites the bytes the first one wrote. The re-read costs one
    // `fstat` and makes the two writers append instead of overwrite.
    this.#size = Math.max(this.#size, this.#currentFileSize());
    if (
      this.#failed ||
      isJournalEraPoisoned(this.#filePath, this.#journalId)
    ) {
      return {
        ok: false,
        status: "rejected",
        error: this.#recoveryRequired("append")
      };
    }
    // A prefix-aware writer refuses bytes beyond the projected boundary.
    // Reaching here with a longer file means another process (or a crashed
    // one) wrote a frame this process has not resynced to; appending now
    // would put a new frame behind an unprojected one.
    if (
      this.#validatedPrefixEnd !== null &&
      this.#size !== this.#validatedPrefixEnd
    ) {
      this.#failed = true;
      this.#fenceReason = `journal_prefix_mismatch:file=${this.#size}:state=${this.#validatedPrefixEnd}`;
      poisonJournalEra(this.#filePath, this.#journalId);
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_CORRUPT",
          stage: "storage.journal",
          details: storageDetails("append", this.#fenceReason),
          side_effect: "none"
        })
      };
    }
    const validation = validateJournalFramePayload(payload);
    if (!validation.ok) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_LEDGER_EVENT_INVALID",
          stage: "storage.journal",
          details: fieldDetails("payload", validation.error.reason)
        })
      };
    }
    const memberCount = journalFrameMemberCount(validation.value);
    // Re-sync against the shared commit sequence of the era before allocating:
    // another writer on the same file may have moved it forward.
    if (this.#sharedCommitSeq !== null) {
      this.adoptCommitSeq(this.#sharedCommitSeq());
    }
    const firstCommitSeq = this.#lastCommitSeq + 1;
    const expected = options?.expected_first_commit_seq;
    if (expected !== undefined && firstCommitSeq !== expected) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_BUSY",
          stage: "storage.journal",
          details: storageDetails(
            "append",
            `commit_seq_conflict:${expected}:${firstCommitSeq}`
          ),
          side_effect: "none"
        })
      };
    }
    const lastCommitSeq = firstCommitSeq + memberCount - 1;
    const encoded = encodeJournalFrame(validation.value, firstCommitSeq);
    if (!encoded.ok) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_LEDGER_EVENT_INVALID",
          stage: "storage.journal",
          details: fieldDetails("frame", encoded.error.reason)
        })
      };
    }
    const frame = encoded.value;
    if (frame.byteLength > this.#maxPayloadBytes + 24) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_LEDGER_EVENT_INVALID",
          stage: "storage.journal",
          details: fieldDetails("frame.payload_len", "exceeds_max_payload"),
          message_key: "error.storage.journal_frame_too_large"
        })
      };
    }
    if (this.#size > 0 && this.#size + frame.byteLength > this.#maxFileBytes) {
      if (!this.#autoRotate) {
        return {
          ok: false,
          status: "rejected",
          error: storageError({
            code: "E_STORAGE_IO",
            stage: "storage.journal",
            details: storageDetails("append", "journal_full")
          })
        };
      }
      const rotated = this.rotate();
      if (!rotated.ok) {
        return rotated;
      }
    }
    const offset = this.#size;
    try {
      let written = 0;
      while (written < frame.byteLength) {
        const chunk = writeSync(this.#fd, frame, written, frame.byteLength - written);
        if (chunk <= 0) {
          throw new Error("short write");
        }
        written += chunk;
      }
      fsyncSync(this.#fd);
    } catch (error) {
      // A failure before any byte of this frame reached the file is a clean
      // not-written outcome: nothing is durable and the caller may retry
      // (ENOSPC is cleared and the same event is accepted). A partial write
      // or a failed fsync after the bytes were written is an unknown
      // durability window and fences the era.
      let failedSize = this.#size;
      try {
        failedSize = statSync(this.#filePath).size;
      } catch {
        // Keep the previous size for diagnostics.
      }
      this.#size = Math.max(this.#size, failedSize);
      if (failedSize !== offset) {
        this.#failed = true;
        poisonJournalEra(this.#filePath, this.#journalId);
      }
      return {
        ok: false,
        status: "rejected",
        error: fsFailure(
          error,
          "append",
          "storage.journal",
          options?.enospc_code ?? enospcCodeForFrame(payload)
        )
      };
    }
    this.#size += frame.byteLength;
    this.#lastCommitSeq = lastCommitSeq;
    this.#appendedSinceResync = true;
    if (this.#validatedPrefixEnd !== null) {
      this.#validatedPrefixEnd = offset + frame.byteLength;
      this.#validatedLastSeq = lastCommitSeq;
    }
    return {
      ok: true,
      status: "ok",
      value: {
        journal_id: this.#journalId,
        file_path: this.#filePath,
        file_offset: offset,
        frame_bytes: frame.byteLength,
        first_commit_seq: firstCommitSeq,
        last_commit_seq: lastCommitSeq,
        member_count: memberCount
      }
    };
  }

  /**
   * Starts a new journal era in the next `journal-<NNNNNN>.rsij` file. The new
   * file and its directory are fsynced before the first frame is written.
   */
  rotate(): Result<void, ErrorEnvelope> {
    if (this.#closed) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_IO",
          stage: "storage.journal",
          details: storageDetails("rotate", "writer_closed")
        })
      };
    }
    const nextPath = nextJournalPath(this.#filePath);
    if (nextPath === null) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_SCHEMA",
          stage: "storage.journal",
          details: fieldDetails("file_path", "not_rotatable"),
          message_key: "error.storage.journal_not_rotatable"
        })
      };
    }
    if (existsSync(nextPath)) {
      // A previous rotation created the next segment but its writer died
      // before the SQLite path/sequence advanced. The bytes belong to this era
      // and must be replayed, not overwritten or skipped.
      this.markRecoveryRequired();
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_STORAGE_IO",
          stage: "storage.journal",
          details: storageDetails("rotate", "next_journal_exists"),
          side_effect: "unknown"
        })
      };
    }
    let fd: number;
    try {
      fd = openSync(nextPath, "a");
      fsyncSync(fd);
      fsyncDirectory(dirname(nextPath));
    } catch (error) {
      this.markRecoveryRequired();
      return {
        ok: false,
        status: "rejected",
        error: fsFailure(error, "rotate", "storage.journal")
      };
    }
    try {
      closeSync(this.#fd);
    } catch {
      // The old descriptor is no longer needed.
    }
    this.#fd = fd;
    this.#filePath = nextPath;
    this.#size = 0;
    if (this.#validatedPrefixEnd !== null) {
      // The new segment starts empty at the current durable sequence.
      this.#validatedPrefixEnd = 0;
      this.#validatedLastSeq = this.#lastCommitSeq;
    }
    return { ok: true, status: "ok", value: undefined };
  }

  /** Flushes and closes the file descriptor. Idempotent. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      fsyncSync(this.#fd);
    } catch {
      // Closing still proceeds; the durability point was the last append.
    }
    try {
      closeSync(this.#fd);
    } catch {
      // Ignore close failure.
    }
  }
}
