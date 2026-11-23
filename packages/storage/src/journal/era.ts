import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";

/**
 * Process-local recovery fence for a journal era.
 *
 * A durable frame whose SQLite projection did not commit leaves the era's
 * persisted tail behind the file. No writer may allocate from that stale tail
 * again: doing so reuses `commit_seq`, making the physical file corrupt and
 * letting cold recovery skip the first frame. Every writer for the era is
 * therefore blocked until a successful recovery has advanced the persisted
 * tail over the durable frames.
 *
 * The key includes the absolute journal directory because separate homes and
 * tests may reuse the logical `journal_id` in one process.
 */
const POISONED_ERAS = new Set<string>();

const FENCE_SCHEMA_VERSION = "rsi.journal_fence/1";
const FENCE_SUFFIX = ".recovery-required.json";

/** Sanitised description of the frame that could not be projected. */
export interface JournalFenceDetail {
  readonly frame_type: string;
  readonly commit_seq?: number;
  readonly error_code?: string;
  readonly observed_at?: number;
}

/** Durable fence record read by `status`, `doctor` and a new writer. */
export interface JournalFenceRecord {
  readonly schema_version: typeof FENCE_SCHEMA_VERSION;
  readonly journal_id: string;
  readonly frame_type: string;
  readonly commit_seq?: number;
  readonly error_code?: string;
  readonly observed_at: number;
  readonly hint: "restart serve";
}

function eraKey(filePath: string, journalId: string): string {
  return `${resolve(dirname(filePath))}\0${journalId}`;
}

function fencePath(filePath: string): string {
  return `${filePath}${FENCE_SUFFIX}`;
}

function parseFence(text: string, journalId?: string): JournalFenceRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value["schema_version"] !== FENCE_SCHEMA_VERSION ||
      typeof value["journal_id"] !== "string" ||
      typeof value["frame_type"] !== "string" ||
      typeof value["observed_at"] !== "number"
    ) {
      return null;
    }
    if (journalId !== undefined && value["journal_id"] !== journalId) return null;
    return {
      schema_version: FENCE_SCHEMA_VERSION,
      journal_id: value["journal_id"],
      frame_type: value["frame_type"],
      ...(typeof value["commit_seq"] === "number" ? { commit_seq: value["commit_seq"] } : {}),
      ...(typeof value["error_code"] === "string" ? { error_code: value["error_code"] } : {}),
      observed_at: value["observed_at"],
      hint: "restart serve"
    };
  } catch {
    return null;
  }
}

/** Blocks every writer of this era until `clearJournalEraPoison`. */
export function poisonJournalEra(
  filePath: string,
  journalId: string,
  detail?: JournalFenceDetail
): void {
  POISONED_ERAS.add(eraKey(filePath, journalId));
  // The in-memory set dies with the process; the marker is what makes the
  // fence visible to `status`, `doctor` and the next process.
  const record: JournalFenceRecord = {
    schema_version: FENCE_SCHEMA_VERSION,
    journal_id: journalId,
    frame_type: detail?.frame_type ?? "unknown",
    ...(detail?.commit_seq === undefined ? {} : { commit_seq: detail.commit_seq }),
    ...(detail?.error_code === undefined ? {} : { error_code: detail.error_code }),
    observed_at: detail?.observed_at ?? Date.now(),
    hint: "restart serve"
  };
  const path = fencePath(filePath);
  // The first fence is the root cause. Later writers hitting the same era
  // (prefix mismatches, repeated appends) must not overwrite its frame type
  // and timestamp with a consequence.
  if (existsSync(path)) return;
  try {
    const temporary = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // The in-memory fence still blocks this process. A marker write failure
    // must not turn a projection failure into a different error.
  }
}

/** True when the era has a known unknown-durability window. */
export function isJournalEraPoisoned(filePath: string, journalId: string): boolean {
  return POISONED_ERAS.has(eraKey(filePath, journalId));
}

/** Reads the durable marker without consulting the in-memory set. */
export function readJournalFence(filePath: string, journalId?: string): JournalFenceRecord | null {
  try {
    return parseFence(readFileSync(fencePath(filePath), "utf8"), journalId);
  } catch {
    return null;
  }
}

/**
 * Seeds the process-local set from the durable marker. A writer opened against
 * an already-fenced era must refuse appends before startup recovery ran.
 */
export function loadJournalEraFence(filePath: string, journalId: string): JournalFenceRecord | null {
  const record = readJournalFence(filePath, journalId);
  if (record !== null) POISONED_ERAS.add(eraKey(filePath, journalId));
  return record;
}

/** Finds the newest fence marker below a journal directory, if any. */
export function readJournalFenceInDirectory(directory: string): JournalFenceRecord | null {
  let newest: JournalFenceRecord | null = null;
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(FENCE_SUFFIX)) continue;
      const record = parseFence(readFileSync(join(directory, name), "utf8"));
      if (record !== null && (newest === null || record.observed_at > newest.observed_at)) {
        newest = record;
      }
    }
  } catch {
    return newest;
  }
  return newest;
}

/**
 * Releases the fence after recovery advanced the persisted tail past every
 * durable frame. A failed or partial recovery must not call this.
 */
export function clearJournalEraPoison(filePath: string, journalId: string): void {
  POISONED_ERAS.delete(eraKey(filePath, journalId));
  try {
    unlinkSync(fencePath(filePath));
  } catch {
    // No marker, or a rotation already moved to another segment.
  }
}

interface JournalSegment {
  readonly path: string;
  readonly sequence: number;
}

const SEGMENT_NAME = /^journal-(\d{6})\.rsij$/;

function segmentSequence(path: string): number | null {
  const match = SEGMENT_NAME.exec(basename(path));
  if (match === null) {
    return null;
  }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

/**
 * Lists the era's segments from `currentPath` forward.
 *
 * Rotation always names the next segment with the next six-digit number in
 * the same directory. Only a contiguous run is returned: a gap means an
 * unrelated file, not a part of this era. The current path is returned even
 * when its name is not a standard segment so recovery keeps its existing
 * single-file behaviour.
 */
export function listJournalSegments(currentPath: string): readonly JournalSegment[] {
  const first = segmentSequence(currentPath);
  if (first === null) {
    return [{ path: currentPath, sequence: 0 }];
  }
  const directory = dirname(currentPath);
  const segments: JournalSegment[] = [];
  for (let sequence = first; ; sequence += 1) {
    const path = join(
      directory,
      `journal-${String(sequence).padStart(6, "0")}.rsij`,
    );
    if (!existsSync(path)) {
      break;
    }
    segments.push({ path, sequence });
  }
  return segments;
}
