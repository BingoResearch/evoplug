#!/usr/bin/env node
/**
 * No-secret repository scanner.
 *
 * Usage:
 *   node tools/secret-scan/cli.mjs [--report-only] <root> [<root> ...]
 *
 * The scanner reports only `path`, `count`, `sha256` and per-pattern counts.
 * It never prints a matched value, a matched line, or file content. Binary
 * files, symlinks, `.git`, `node_modules`, `.cc-switch` and `.claude` are
 * skipped so a routine scan cannot pull credentials or transcripts into a
 * report.
 *
 * Exit codes:
 *   0  scan completed and no secret-shaped text was found
 *   1  secret-shaped text was found
 *   2  usage error or a requested root is missing
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import { scanSecrets } from "../../scripts/experiments/harbor-paired/secret-safety.mjs";

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".cc-switch",
  ".claude",
  "dist",
  "coverage",
  ".venv",
  "__pycache__"
]);
const MAX_BYTES = 8 * 1024 * 1024;

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: node tools/secret-scan/cli.mjs [--report-only] <root> [<root> ...]\n"
  );
}

function walk(root, files, visited) {
  const info = lstatSync(root);
  if (info.isSymbolicLink()) return;
  const real = realpathSync(root);
  if (visited.has(real)) return;
  visited.add(real);
  if (info.isDirectory()) {
    if (SKIP_DIRECTORIES.has(basename(root))) return;
    for (const entry of readdirSync(root).sort()) {
      walk(join(root, entry), files, visited);
    }
    return;
  }
  if (info.isFile() && info.size <= MAX_BYTES) files.push(root);
}

function main(argv) {
  let reportOnly = false;
  const roots = [];
  for (const arg of argv) {
    if (arg === "--report-only") {
      reportOnly = true;
    } else if (arg.startsWith("--")) {
      usage(`unknown option: ${arg}`);
      return 2;
    } else {
      roots.push(resolve(arg));
    }
  }
  if (roots.length === 0) {
    usage("at least one scan root is required");
    return 2;
  }

  const files = [];
  for (const root of roots) {
    try {
      walk(root, files, new Set());
    } catch {
      usage("a requested scan root is missing or unreadable");
      return 2;
    }
  }

  const findings = [];
  let scanned = 0;
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    if (bytes.includes(0)) continue;
    let text;
    try {
      text = bytes.toString("utf8");
    } catch {
      continue;
    }
    scanned += 1;
    const counts = scanSecrets(text);
    const count = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (count === 0) continue;
    findings.push({
      path: relative(process.cwd(), file).split(sep).join("/"),
      count,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      patterns: counts
    });
  }

  findings.sort((a, b) => a.path.localeCompare(b.path));
  const total = findings.reduce((sum, finding) => sum + finding.count, 0);
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: "evoplug.secret_scan/1",
        scanned_files: scanned,
        finding_files: findings.length,
        finding_count: total,
        credential_value_recorded: false,
        findings
      },
      null,
      2
    )}\n`
  );
  if (total > 0 && !reportOnly) return 1;
  return 0;
}

process.exitCode = main(process.argv.slice(2));
