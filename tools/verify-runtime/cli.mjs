#!/usr/bin/env node
// Runtime verification for evoplug (DD-FND-003, DD-FND-023).
//
// Usage:
//   node tools/verify-runtime/cli.mjs [--root DIR] [--manifest FILE] [--json]
//
// Verifies:
//   1. the running Node.js version equals the `.node-version` pin;
//   2. the workspace `engines.node` range accepts the running version;
//   3. `node:sqlite` is importable and reports a version;
//   4. `select sqlite_version()` satisfies the frozen admission predicate;
//   5. an optional runtime-manifest.json validates and agrees with reality.
//
// Exit codes:
//   0  every check passed
//   1  at least one verification failed
//   2  invalid arguments

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRuntimeManifest, RUNTIME_MANIFEST_FILE } from "./manifest.mjs";
import {
  PINNED_TOOLCHAIN,
  readNodeEngineRange,
  readPinnedNodeVersion,
  readToolchainVersions,
  querySqliteVersion,
  versionsEqual
} from "./runtime.mjs";
import { SUPPORTED_SQLITE_RANGES, isSupportedSqliteVersion, parseVersion } from "./sqlite-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

const USAGE = `Usage: node tools/verify-runtime/cli.mjs [options]

Options:
  --root DIR             workspace root (default: repository root)
  --manifest FILE        runtime-manifest.json path (default: <root>/${RUNTIME_MANIFEST_FILE})
  --node-version VERSION assume this Node.js version instead of process.versions.node
  --sqlite-version VER   assume this SQLite version instead of querying node:sqlite
  --json                 machine readable output
  --help                 show this message

Exit codes: 0 pass, 1 verification failure, 2 invalid arguments.
Accepted SQLite ranges (DD-FND-023): ${SUPPORTED_SQLITE_RANGES.join(", ")}
`;

function fail(message) {
  process.stderr.write(`verify-runtime: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    manifest: null,
    json: false,
    help: false,
    nodeVersion: null,
    sqliteVersion: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        fail(`${name} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      options.root = resolve(takeValue("--root"));
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else if (arg === "--manifest") {
      options.manifest = resolve(takeValue("--manifest"));
    } else if (arg.startsWith("--manifest=")) {
      options.manifest = resolve(arg.slice("--manifest=".length));
    } else if (arg === "--node-version") {
      options.nodeVersion = takeValue("--node-version");
    } else if (arg.startsWith("--node-version=")) {
      options.nodeVersion = arg.slice("--node-version=".length);
    } else if (arg === "--sqlite-version") {
      options.sqliteVersion = takeValue("--sqlite-version");
    } else if (arg.startsWith("--sqlite-version=")) {
      options.sqliteVersion = arg.slice("--sqlite-version=".length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const checks = [];
  const addCheck = (id, ok, detail) => {
    checks.push({ id, ok, detail });
  };

  const pin = readPinnedNodeVersion(options.root);
  const expectedNode = pin.ok ? pin.version : null;
  const actualNode = options.nodeVersion ?? process.versions.node;
  if (!pin.ok) {
    addCheck("node-version-pin", false, pin.message);
  } else if (!/^\d+\.\d+\.\d+$/.test(actualNode)) {
    addCheck("node-version-pin", false, `reported Node.js version "${actualNode}" is not "major.minor.patch"`);
  } else {
    addCheck(
      "node-version-pin",
      versionsEqual(actualNode, expectedNode),
      `expected ${expectedNode}, found ${actualNode}`
    );
  }

  const engines = readNodeEngineRange(options.root);
  if (engines === null) {
    addCheck("node-engines", true, "no parseable engines.node range; skipped");
  } else {
    addCheck("node-engines", engines.accepts(actualNode), `engines.node ${engines.range}, found ${actualNode}`);
  }

  const toolchain = readToolchainVersions(options.root);
  const pinMismatches = [];
  if (toolchain.packageManager !== PINNED_TOOLCHAIN.pnpm) {
    pinMismatches.push(`packageManager pnpm ${toolchain.packageManager ?? "<missing>"} != ${PINNED_TOOLCHAIN.pnpm}`);
  }
  for (const name of ["typescript", "vitest", "ajv"]) {
    if (toolchain[name] !== PINNED_TOOLCHAIN[name]) {
      pinMismatches.push(`${name} ${toolchain[name] ?? "<missing>"} != ${PINNED_TOOLCHAIN[name]}`);
    }
  }
  addCheck(
    "toolchain-pins",
    pinMismatches.length === 0,
    pinMismatches.length === 0 ? "typescript/pnpm/vitest/ajv match DD-FND-023" : pinMismatches.join("; ")
  );

  const probe = await querySqliteVersion();
  const observedSqlite = options.sqliteVersion ?? (probe.ok ? probe.version : null);
  addCheck("node-sqlite-import", probe.ok, probe.ok ? `node:sqlite reports ${probe.version}` : probe.message);

  if (observedSqlite === null) {
    addCheck("sqlite-version", false, "no SQLite version available");
  } else if (parseVersion(observedSqlite) === null) {
    addCheck("sqlite-version", false, `SQLite version "${observedSqlite}" is not "major.minor.patch"`);
  } else {
    addCheck(
      "sqlite-version",
      isSupportedSqliteVersion(observedSqlite),
      `SQLite ${observedSqlite}; accepted ranges: ${SUPPORTED_SQLITE_RANGES.join(", ")}`
    );
  }

  const manifestPath = options.manifest ?? resolve(options.root, RUNTIME_MANIFEST_FILE);
  const manifestReport = { path: manifestPath, present: false, ok: true, errors: [] };
  if (existsSync(manifestPath)) {
    manifestReport.present = true;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      manifestReport.ok = false;
      manifestReport.errors.push({
        field: "",
        message: `cannot parse manifest: ${error instanceof Error ? error.message : String(error)}`
      });
    }
    if (parsed !== undefined) {
      const validation = validateRuntimeManifest(parsed);
      manifestReport.errors.push(...validation.errors);
      manifestReport.ok = validation.ok;
      if (validation.ok) {
        if (expectedNode !== null && !versionsEqual(parsed.node_version, expectedNode)) {
          manifestReport.ok = false;
          manifestReport.errors.push({
            field: "node_version",
            message: `manifest records ${parsed.node_version} but .node-version pins ${expectedNode}`
          });
        }
        if (parsed.sqlite_version !== undefined && observedSqlite !== null) {
          if (!versionsEqual(parsed.sqlite_version, observedSqlite)) {
            manifestReport.ok = false;
            manifestReport.errors.push({
              field: "sqlite_version",
              message: `manifest records ${parsed.sqlite_version} but the runtime reports ${observedSqlite}`
            });
          }
        }
      }
    }
    addCheck(
      "runtime-manifest",
      manifestReport.ok,
      manifestReport.ok ? `validated ${manifestPath}` : `invalid ${manifestPath}`
    );
  } else {
    addCheck("runtime-manifest", true, `not present at ${manifestPath}; skipped`);
  }

  const ok = checks.every((check) => check.ok);
  const report = {
    ok,
    node: { expected: expectedNode, actual: actualNode },
    sqlite: { observed: observedSqlite, supported: observedSqlite === null ? false : isSupportedSqliteVersion(observedSqlite) },
    manifest: manifestReport,
    checks
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`verify-runtime: ${ok ? "ok" : "failed"} (${checks.length} checks)\n`);
    for (const check of checks) {
      const status = check.ok ? "ok  " : "FAIL";
      process.stdout.write(`  [${status}] ${check.id}: ${check.detail}\n`);
    }
    for (const error of manifestReport.errors) {
      process.stderr.write(`  manifest ${error.field || "<root>"}: ${error.message}\n`);
    }
  }
  return ok ? 0 : 1;
}

process.exitCode = await main();
