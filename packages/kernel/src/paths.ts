/**
 * Filesystem path helpers shared by the kernel bootstrap and the CLI.
 */

import { join } from "node:path";

/** Pre-migration backup destination; never overwrites an earlier backup. */
export function calculateBackupPath(backupsDir: string, now: number): string {
  return join(backupsDir, `pre-migration-${String(now)}.sqlite`);
}

export function journalPath(journalDir: string, relativePath: string): string {
  return join(journalDir, relativePath);
}
