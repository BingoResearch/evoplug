// SQLite version admission predicate (DD-FND-023, frozen 2026-10-21).
//
// Supported versions are exactly:
//   - version >= 3.51.3
//   - version >= 3.50.7 and < 3.51.0
//   - exactly 3.44.6
// Any other version refuses service with E_STORAGE_SQLITE_UNSAFE.

/**
 * Parse a dotted numeric version. Accepts the leading `major.minor.patch`
 * triple of a longer SQLite version string such as "3.51.3" or
 * "3.45.1 2024-01-01".
 *
 * @param {string} text
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parseVersion(text) {
  if (typeof text !== "string") {
    return null;
  }
  const match = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Compare two parsed versions. Returns a negative number when `left < right`.
 *
 * @param {{ major: number, minor: number, patch: number }} left
 * @param {{ major: number, minor: number, patch: number }} right
 * @returns {number}
 */
export function compareVersions(left, right) {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

const V3_44_6 = Object.freeze({ major: 3, minor: 44, patch: 6 });
const V3_50_7 = Object.freeze({ major: 3, minor: 50, patch: 7 });
const V3_51_0 = Object.freeze({ major: 3, minor: 51, patch: 0 });
const V3_51_3 = Object.freeze({ major: 3, minor: 51, patch: 3 });

/**
 * The frozen admission predicate from DD-FND-023.
 *
 * @param {string} version
 * @returns {boolean} true only for the three supported ranges
 */
export function isSupportedSqliteVersion(version) {
  const parsed = parseVersion(version);
  if (parsed === null) {
    return false;
  }
  if (compareVersions(parsed, V3_51_3) >= 0) {
    return true;
  }
  if (compareVersions(parsed, V3_50_7) >= 0 && compareVersions(parsed, V3_51_0) < 0) {
    return true;
  }
  return compareVersions(parsed, V3_44_6) === 0;
}

export const SUPPORTED_SQLITE_RANGES = Object.freeze([
  ">=3.51.3",
  ">=3.50.7 <3.51.0",
  "=3.44.6"
]);
