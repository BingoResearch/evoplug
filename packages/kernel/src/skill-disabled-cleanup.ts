/**
 * Cleanup for the disabled copy of a whole-file managed object.
 *
 * `skills disable` moves the adopted file into `<managed root>/.evoplug-disabled/`
 * so the host stops loading it without deleting the only copy. Once the user
 * revokes the candidate, the evoplug store owns the historical snapshot, and
 * the host directory must return to its pre-adoption state. Leaving the
 * `.disabled` file behind keeps user-facing residue that no host reads.
 */

import { lstatSync, rmdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Deterministic path written by the disable path. */
export function disabledCopyPath(rootPath: string, proposalId: string): string {
  const name = proposalId.replace(/[^A-Za-z0-9._-]/gu, "_");
  return join(rootPath, ".evoplug-disabled", `${name}.disabled`);
}

/**
 * Removes the disabled copy and the stash directory when it becomes empty.
 * A missing file is already in the desired state, so this never throws for
 * the common "nothing to clean" case.
 *
 * When the adopted target path is known, also prune the now-empty directory
 * tree the host loaded the skill from. `skills disable` moves `SKILL.md` out
 * of `skills/evoplug/<name>/`, which leaves an empty directory that no host
 * reads. Only evoplug-owned path components are pruned; a shared top-level
 * host directory such as `skills/` is kept.
 */
export function removeDisabledCopy(
  rootPath: string,
  proposalId: string,
  targetPath?: string
): boolean {
  const target = disabledCopyPath(rootPath, proposalId);
  try {
    rmSync(target, { force: true });
  } catch {
    return false;
  }
  try {
    rmdirSync(join(rootPath, ".evoplug-disabled"));
  } catch {
    // Not empty (other disabled objects) or already absent; both are fine.
  }
  if (targetPath !== undefined) {
    pruneEmptyManagedParents(rootPath, targetPath);
  }
  return true;
}

function pruneEmptyManagedParents(rootPath: string, targetPath: string): void {
  if (isAbsolute(targetPath) || targetPath.includes("\0")) return;
  const root = resolve(rootPath);
  let current = resolve(root, dirname(targetPath));
  if (!isInside(current, root)) return;
  const firstRel = relative(root, current);
  while (current !== root && isInside(current, root)) {
    const rel = relative(root, current);
    const parts = rel.split(sep).filter((part) => part.length > 0);
    const immediate = rel === firstRel;
    // Only remove the directory that held evoplug's object and any
    // `evoplug` component below the shared host directory.
    if (!immediate && !parts.includes("evoplug")) return;
    try {
      if (!lstatSync(current).isDirectory()) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
