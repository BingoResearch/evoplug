#!/usr/bin/env node
// Static boundary check for the evoplug pnpm workspace (DD-FND-021).
//
// Usage:
//   node tools/check-boundaries/cli.mjs [--root DIR] [--json]
//
// Exit codes:
//   0  no boundary violations
//   1  at least one violation
//   2  invalid arguments

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkspace } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

const USAGE = `Usage: node tools/check-boundaries/cli.mjs [--root DIR] [--json]

Checks each workspace package.json dependency list and every actual import
specifier against the DD-FND-021 dependency rules.

Options:
  --root DIR   workspace root (default: repository root)
  --json       machine readable output
  --help       show this message
`;

function fail(message) {
  process.stderr.write(`check-boundaries: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        fail("--root requires a directory");
      }
      options.root = resolve(value);
      index += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let report;
  try {
    report = checkWorkspace(options.root);
  } catch (error) {
    process.stderr.write(`check-boundaries: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `check-boundaries: ${report.packages.length} workspace packages, ${report.violations.length} violation(s)\n`
    );
    for (const violation of report.violations) {
      const location = violation.line === null ? violation.file : `${violation.file}:${violation.line}`;
      process.stderr.write(`${location}: ${violation.code}: ${violation.message}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main();
