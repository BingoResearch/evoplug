import { existsSync } from "node:fs";
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

function eraKey(filePath: string, journalId: string): string {
  return `${resolve(dirname(filePath))}\0${journalId}`;
}

/** Blocks every writer of this era until `clearJournalEraPoison`. */
export function poisonJournalEra(filePath: string, journalId: string): void {
  POISONED_ERAS.add(eraKey(filePath, journalId));
}

/** True when the era has a known unknown-durability window. */
export function isJournalEraPoisoned(filePath: string, journalId: string): boolean {
  return POISONED_ERAS.has(eraKey(filePath, journalId));
}

/**
 * Releases the fence after recovery advanced the persisted tail past every
 * durable frame. A failed or partial recovery must not call this.
 */
export function clearJournalEraPoison(filePath: string, journalId: string): void {
  POISONED_ERAS.delete(eraKey(filePath, journalId));
}

export interface JournalSegment {
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
