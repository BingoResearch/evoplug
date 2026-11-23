// Migration artifact discovery and ordering (DD-FND-050, DD-FND-063).
//
// Two file name forms exist in the design:
//   migrations/sql/<sequence>_<name>.sql                    (frozen baselines)
//   migrations/domains/<owner>/<sequence>_<name>.sql        (domain artifacts)
// DD-FND-063 additionally describes migrations/sql/<major>_<minor>_<owner>_<name>.sql.
// The parser accepts both; the four-token form is recognised only when the
// third token is a known owner, so ordinary names such as 0001_evd_state_rows
// are never misread.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const MIGRATION_OWNERS = Object.freeze(["fnd", "qp", "evd", "rev", "host", "cfg"]);

/**
 * Frozen one-part baselines predate per-artifact version directives and carry
 * the schema major 2.0 they create. `-- evoplug:schema_major` overrides this
 * exactly like the storage runner.
 */
export const BASELINE_SCHEMA_MAJOR = 2;
export const BASELINE_SCHEMA_MINOR = 0;

const SCHEMA_MAJOR_DIRECTIVE = /^\s*--\s*evoplug:schema_major\s*=\s*(\d+)\s*$/im;
const SCHEMA_MINOR_DIRECTIVE = /^\s*--\s*evoplug:schema_minor\s*=\s*(\d+)\s*$/im;
const DIRECTIVE_BLOCK_BEGIN = /^\s*--\s*evoplug:directive:begin\s*$/;
const DIRECTIVE_BLOCK_END = /^\s*--\s*evoplug:directive:end\s*$/;
const FOREIGN_KEYS_OFF_DIRECTIVE = /^\s*--\s*evoplug:foreign_keys\s*=\s*off\s*$/im;

export const MIGRATION_CODES = Object.freeze({
  fileName: "E_SCHEMA_MIGRATION_NAME",
  duplicate: "E_SCHEMA_MIGRATION_DUPLICATE",
  checksum: "E_SCHEMA_CHECKSUM",
  order: "E_SCHEMA_MIGRATION_ORDER",
  missingArtifact: "E_SCHEMA_MIGRATION_MISSING",
  unsupportedMajor: "E_SCHEMA_MAJOR_UNSUPPORTED",
  sqlite: "E_STORAGE_SQLITE_UNSAFE"
});

/**
 * Parse a migration file name.
 *
 * @param {string} baseName
 * @returns {{ sequence: number, major: number | null, minor: number | null, owner: string | null, name: string } | null}
 */
export function parseMigrationFileName(baseName) {
  const match = /^(.+)\.sql$/i.exec(baseName);
  if (!match) {
    return null;
  }
  const stem = match[1];
  const parts = stem.split("_");
  if (parts.length >= 4) {
    const [majorToken, minorToken, ownerToken, ...rest] = parts;
    if (
      /^\d+$/.test(majorToken) &&
      /^\d+$/.test(minorToken) &&
      MIGRATION_OWNERS.includes(ownerToken) &&
      rest.length > 0
    ) {
      return {
        sequence: Number(majorToken),
        major: Number(majorToken),
        minor: Number(minorToken),
        owner: ownerToken,
        name: rest.join("_")
      };
    }
  }
  if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
    return {
      sequence: Number(parts[0]),
      major: null,
      minor: null,
      owner: null,
      name: parts.slice(1).join("_")
    };
  }
  return null;
}

/**
 * SHA-256 of a byte buffer, stored as the evoplug Hash form.
 *
 * @param {Buffer} bytes
 * @returns {string} "sha256:<64 lowercase hex>"
 */
export function sha256Checksum(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Remove a fenced `-- evoplug:directive:begin/end` block. Earlier binaries
 * shipped 0002 without this block and recorded the checksum of the bytes that
 * remain, so the storage runner and this tool both hash the stripped text.
 *
 * @param {string} sql
 * @returns {string | null} stripped text, or null when there is no complete fence
 */
export function stripDirectiveBlock(sql) {
  const lines = sql.split("\n");
  const begin = lines.findIndex((line) => DIRECTIVE_BLOCK_BEGIN.test(line));
  if (begin < 0) {
    return null;
  }
  const end = lines.findIndex((line, index) => index > begin && DIRECTIVE_BLOCK_END.test(line));
  if (end < 0) {
    return null;
  }
  return [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n");
}

/**
 * Parse the schema version an artifact targets, if it declares one.
 *
 * @param {string} sql
 * @returns {{ major: number, minor: number } | null}
 */
export function parseSchemaDirective(sql) {
  const majorMatch = SCHEMA_MAJOR_DIRECTIVE.exec(sql);
  if (majorMatch === null) {
    return null;
  }
  const major = Number(majorMatch[1]);
  if (!Number.isSafeInteger(major) || major < 1) {
    return null;
  }
  const minorMatch = SCHEMA_MINOR_DIRECTIVE.exec(sql);
  const minor = minorMatch === null ? 0 : Number(minorMatch[1]);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    return null;
  }
  return { major, minor };
}

/**
 * Checksum recorded in schema_migration for an artifact. For fenced artifacts
 * this is the checksum of the pre-directive bytes so an existing home that
 * applied the earlier artifact still matches.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function migrationChecksum(bytes) {
  const stripped = stripDirectiveBlock(bytes.toString("utf8"));
  return sha256Checksum(stripped === null ? bytes : Buffer.from(stripped, "utf8"));
}

/**
 * True when an artifact opts out of foreign key enforcement (mirrors the
 * storage runner's domain migration directive).
 *
 * @param {string} sql
 * @returns {boolean}
 */
export function hasForeignKeysOffDirective(sql) {
  return FOREIGN_KEYS_OFF_DIRECTIVE.test(sql);
}

function readSqlDirectory(dir, owner, group, rootDir, errors) {
  const entries = [];
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of names) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }
    const parsed = parseMigrationFileName(entry.name);
    if (parsed === null) {
      errors.push({
        code: MIGRATION_CODES.fileName,
        message: `migration file ${entry.name} does not start with a numeric sequence`
      });
      continue;
    }
    const file = join(dir, entry.name);
    const bytes = readFileSync(file);
    const sql = bytes.toString("utf8");
    const declared = parseSchemaDirective(sql);
    const isBaseline = owner === "fnd" && group === 0;
    // Domain naming in @evoplug/storage is always <sequence>_<name>.sql inside
    // the owner directory; only baselines use the four-token version form.
    const domainMatch = isBaseline ? null : /^(\d+)_(.+)\.sql$/i.exec(entry.name);
    const sequence = domainMatch?.[1] === undefined ? parsed.sequence : Number(domainMatch[1]);
    const name = domainMatch?.[2] ?? parsed.name;
    // Only baselines carry a target schema version; the storage runner's domain
    // discovery ignores version directives and keys artifacts by (owner, sequence).
    const targetMajor = isBaseline ? (declared?.major ?? parsed.major ?? BASELINE_SCHEMA_MAJOR) : null;
    const targetMinor = isBaseline ? (declared?.minor ?? parsed.minor ?? BASELINE_SCHEMA_MINOR) : null;
    entries.push({
      file,
      relativePath: join("migrations", owner === "fnd" && group === 0 ? "sql" : join("domains", owner), entry.name),
      owner: isBaseline ? "fnd" : owner,
      sequence,
      major: isBaseline ? parsed.major : null,
      minor: isBaseline ? parsed.minor : null,
      targetMajor,
      targetMinor,
      // Baseline ledger versions follow the storage runner: an explicit
      // <major>_<minor>_ name is major*10000+minor, a one-part baseline uses
      // its sequence. Domain artifacts are keyed by (owner, sequence) instead.
      version: !isBaseline
        ? null
        : parsed.major !== null && parsed.minor !== null
          ? parsed.major * 10000 + parsed.minor
          : parsed.sequence,
      name: name ?? parsed.name,
      baseName: entry.name,
      checksum: isBaseline ? migrationChecksum(bytes) : sha256Checksum(bytes),
      sql
    });
  }
  return entries;
}

/**
 * Discover every migration artifact under <root>/migrations.
 *
 * FND baselines (migrations/sql) come first, then domain artifacts ordered by
 * (owner, sequence), matching DD-FND-050 / DD-FND-063.
 *
 * @param {string} rootDir
 * @returns {{ entries: Array<object>, errors: Array<{ code: string, message: string }> }}
 */
export function discoverMigrationFiles(rootDir) {
  const errors = [];
  const baseline = readSqlDirectory(join(rootDir, "migrations", "sql"), "fnd", 0, rootDir, errors);
  const domainRoot = join(rootDir, "migrations", "domains");
  const domains = [];
  if (existsSync(domainRoot)) {
    const owners = readdirSync(domainRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const owner of owners) {
      domains.push(...readSqlDirectory(join(domainRoot, owner), owner, 1, rootDir, errors));
    }
  }
  const sortKey = (entry, group) => {
    if (group === 0) {
      return [0, entry.targetMajor ?? 0, entry.targetMinor ?? 0, entry.sequence, entry.relativePath];
    }
    return [1, entry.owner, entry.sequence, entry.relativePath];
  };
  const comparator = (left, right) => {
    const a = sortKey(left, left.group);
    const b = sortKey(right, right.group);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] < b[index]) {
        return -1;
      }
      if (a[index] > b[index]) {
        return 1;
      }
    }
    return 0;
  };
  for (const entry of baseline) {
    entry.group = 0;
  }
  for (const entry of domains) {
    entry.group = 1;
  }
  const entries = [...baseline, ...domains].sort(comparator);

  const seen = new Map();
  const seenNames = new Map();
  for (const entry of entries) {
    const key = `${entry.owner}:${entry.sequence}`;
    if (seen.has(key)) {
      errors.push({
        code: MIGRATION_CODES.duplicate,
        message: `duplicate order key (${entry.owner}, ${entry.sequence}) in ${seen.get(key)} and ${entry.relativePath}`
      });
    } else {
      seen.set(key, entry.relativePath);
    }
    if (entry.group === 0 && seenNames.has(entry.baseName)) {
      errors.push({
        code: MIGRATION_CODES.duplicate,
        message: `migration file name ${entry.baseName} is used by ${seenNames.get(entry.baseName)} and ${entry.relativePath}; schema_migration.name is UNIQUE`
      });
    } else if (entry.group === 0) {
      seenNames.set(entry.baseName, entry.relativePath);
    }
  }
  return { entries, errors };
}

/**
 * Schema major a baseline artifact creates. A `-- evoplug:schema_major`
 * directive wins, then an explicit `<major>_<minor>_<owner>_<name>` name, then
 * the frozen 2.0 carried by one-part baselines such as 0001_core.sql. The
 * sequence number of a one-part name is an ordering key, not a schema major.
 *
 * @param {{ targetMajor?: number | null, major?: number | null, sequence?: number }} entry
 * @returns {number}
 */
export function baselineMajor(entry) {
  if (typeof entry.targetMajor === "number") {
    return entry.targetMajor;
  }
  if (typeof entry.major === "number") {
    return entry.major;
  }
  return BASELINE_SCHEMA_MAJOR;
}

/**
 * Choose the migration set for one database. Baselines are cumulative: every
 * artifact whose target major is <= the requested (or newest available) major
 * is applied, so a 2.0 home reaches 3.0 by running 0001 and 0002 in order.
 * Domain artifacts belong to the target major.
 *
 * @param {Array<object>} entries
 * @param {number | null} schemaMajor
 * @returns {{
 *   selected: Array<object>,
 *   major: number | null,
 *   minor: number | null,
 *   errors: Array<{ code: string, message: string }>
 * }}
 */
export function selectMigrationSet(entries, schemaMajor) {
  const baselines = entries.filter((entry) => entry.group === 0);
  const domains = entries.filter((entry) => entry.group === 1);
  const errors = [];

  if (baselines.length === 0) {
    const major = schemaMajor;
    for (const entry of domains) {
      const domainMajor = entry.targetMajor ?? entry.major;
      if (domainMajor !== null && domainMajor !== undefined && domainMajor !== major) {
        errors.push({
          code: MIGRATION_CODES.unsupportedMajor,
          message: `${entry.relativePath} belongs to schema major ${domainMajor}, not ${major}`
        });
      }
    }
    return { selected: domains, major, minor: major === null ? null : BASELINE_SCHEMA_MINOR, errors };
  }

  const availableMajor = Math.max(...baselines.map((entry) => baselineMajor(entry)));
  const major = schemaMajor ?? availableMajor;
  const selectedBaselines = baselines.filter((entry) => baselineMajor(entry) <= major);
  if (!selectedBaselines.some((entry) => baselineMajor(entry) === major)) {
    errors.push({
      code: MIGRATION_CODES.unsupportedMajor,
      message: `no baseline artifact for schema major ${major}`
    });
    return { selected: [], major, minor: BASELINE_SCHEMA_MINOR, errors };
  }
  const targetBaselines = selectedBaselines.filter((entry) => baselineMajor(entry) === major);
  const minor = targetBaselines.reduce(
    (highest, entry) => Math.max(highest, entry.targetMinor ?? entry.minor ?? BASELINE_SCHEMA_MINOR),
    BASELINE_SCHEMA_MINOR
  );

  for (const entry of domains) {
    const domainMajor = entry.targetMajor ?? entry.major;
    if (domainMajor !== null && domainMajor !== undefined && domainMajor !== major) {
      errors.push({
        code: MIGRATION_CODES.unsupportedMajor,
        message: `${entry.relativePath} belongs to schema major ${domainMajor}, not ${major}`
      });
    }
  }

  const selected = [...selectedBaselines, ...domains].sort((left, right) => {
    if (left.group !== right.group) {
      return left.group - right.group;
    }
    if (left.group === 0) {
      const majorDelta = baselineMajor(left) - baselineMajor(right);
      if (majorDelta !== 0) {
        return majorDelta;
      }
      const minorDelta = (left.targetMinor ?? 0) - (right.targetMinor ?? 0);
      if (minorDelta !== 0) {
        return minorDelta;
      }
      return left.sequence - right.sequence;
    }
    if (left.owner !== right.owner) {
      return left.owner < right.owner ? -1 : 1;
    }
    return left.sequence - right.sequence;
  });
  return { selected, major, minor, errors };
}
