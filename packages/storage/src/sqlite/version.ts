/**
 * SQLite version admission policy (DD-FND-023).
 *
 * Accepted ranges:
 *   - >= 3.51.3
 *   - >= 3.50.7 < 3.51.0
 *   - exactly 3.44.6
 *
 * Anything else refuses service with `E_STORAGE_SQLITE_UNSAFE` before any
 * migration or write happens.
 */

interface SqliteVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parses `X.Y.Z` (an optional suffix after the patch number is ignored, as SQLite reports one). */
function parseSqliteVersion(value: string): SqliteVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

function compareVersion(left: SqliteVersion, right: SqliteVersion): number {
  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1;
  }
  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1;
  }
  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1;
  }
  return 0;
}

/** The frozen admission predicate for the bundled SQLite version. */
export function isSupportedSqliteVersion(value: string): boolean {
  const version = parseSqliteVersion(value);
  if (version === null) {
    return false;
  }
  if (compareVersion(version, { major: 3, minor: 51, patch: 3 }) >= 0) {
    return true;
  }
  if (
    compareVersion(version, { major: 3, minor: 50, patch: 7 }) >= 0 &&
    compareVersion(version, { major: 3, minor: 51, patch: 0 }) < 0
  ) {
    return true;
  }
  return version.major === 3 && version.minor === 44 && version.patch === 6;
}
