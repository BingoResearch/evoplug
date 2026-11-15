// Runtime probes shared by tools/verify-runtime.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion } from "./sqlite-version.mjs";

// Toolchain pin from DD-FND-023 (2026-10-21). The design records these as
// version selections that must be re-checked against the official pages at
// release time; this module only compares the repository against the pin.
export const PINNED_TOOLCHAIN = Object.freeze({
  node: "24.22.0",
  typescript: "7.0.2",
  pnpm: "12.14.0",
  vitest: "5.0.5",
  ajv: "8.20.0"
});

/**
 * Read the toolchain versions declared by the workspace manifests.
 *
 * @param {string} rootDir
 * @returns {{ node: string | null, packageManager: string | null, typescript: string | null, vitest: string | null, ajv: string | null }}
 */
export function readToolchainVersions(rootDir) {
  const empty = { node: null, packageManager: null, typescript: null, vitest: null, ajv: null };
  const manifestPath = join(rootDir, "package.json");
  if (!existsSync(manifestPath)) {
    return empty;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return empty;
  }
  const dev = typeof manifest.devDependencies === "object" && manifest.devDependencies !== null ? manifest.devDependencies : {};
  const pin = readPinnedNodeVersion(rootDir);
  const packageManager =
    typeof manifest.packageManager === "string" && manifest.packageManager.includes("@")
      ? manifest.packageManager.split("@").pop() ?? null
      : null;
  return {
    node: pin.ok ? pin.version : null,
    packageManager,
    typescript: typeof dev.typescript === "string" ? dev.typescript : null,
    vitest: typeof dev.vitest === "string" ? dev.vitest : null,
    ajv: typeof dev.ajv === "string" ? dev.ajv : null
  };
}

/**
 * Compare two dotted versions for equality after parsing.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function versionsEqual(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) {
    return left === right;
  }
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Read the pinned runtime version from the repository `.node-version` file.
 *
 * @param {string} rootDir
 * @returns {{ ok: true, version: string, path: string } | { ok: false, message: string, path: string }}
 */
export function readPinnedNodeVersion(rootDir) {
  const path = join(rootDir, ".node-version");
  if (!existsSync(path)) {
    return { ok: false, path, message: ".node-version is missing" };
  }
  const version = readFileSync(path, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return { ok: false, path, message: `.node-version must contain one "major.minor.patch" version, found "${version}"` };
  }
  return { ok: true, version, path };
}

/**
 * Read the workspace `engines.node` range, when present.
 *
 * @param {string} rootDir
 * @returns {{ range: string, accepts: (version: string) => boolean } | null}
 */
export function readNodeEngineRange(rootDir) {
  const path = join(rootDir, "package.json");
  if (!existsSync(path)) {
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const range = manifest?.engines?.node;
  if (typeof range !== "string") {
    return null;
  }
  const match = /^>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+(?:\.\d+){0,2})$/.exec(range.trim());
  if (!match) {
    return null;
  }
  const toTriple = (value) => {
    const parts = value.split(".").map(Number);
    while (parts.length < 3) {
      parts.push(0);
    }
    return parts;
  };
  const lower = toTriple(match[1]);
  const upper = toTriple(match[2]);
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) {
        return left[index] - right[index];
      }
    }
    return 0;
  };
  return {
    range,
    accepts(version) {
      const parsed = version.split(".").map(Number);
      if (parsed.length !== 3 || parsed.some((part) => !Number.isInteger(part))) {
        return false;
      }
      return compare(parsed, lower) >= 0 && compare(parsed, upper) < 0;
    }
  };
}

/**
 * Query the bundled SQLite version through the `node:sqlite` port module.
 * Business modules must not import node:sqlite; this probe is a development
 * tool and only reports the version.
 *
 * @returns {Promise<{ ok: true, version: string } | { ok: false, message: string }>}
 */
export async function querySqliteVersion() {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    return { ok: false, message: `node:sqlite is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const DatabaseSync = sqlite.DatabaseSync;
  if (typeof DatabaseSync !== "function") {
    return { ok: false, message: "node:sqlite does not export DatabaseSync" };
  }
  let database;
  try {
    database = new DatabaseSync(":memory:");
    const row = database.prepare("select sqlite_version() as version").get();
    const version = row?.version;
    if (typeof version !== "string" || version === "") {
      return { ok: false, message: "select sqlite_version() returned no version" };
    }
    return { ok: true, version };
  } catch (error) {
    return { ok: false, message: `node:sqlite probe failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch {
        // Closing an already failed handle is not itself a verification error.
      }
    }
  }
}
