#!/usr/bin/env node
// Adapter implementation-manifest generator/checker (DD-HOST-001, DD-HOST-200.2).
//
// Usage:
//   node tools/adapter-manifest/cli.mjs [--check] [--root DIR] [--json]
//   node tools/adapter-manifest/cli.mjs --write [--root DIR]
//
// The implementation hash covers every adapter package source file: all of
// `src/**` except `src/manifest.ts`, plus every `runtime/**` file. The runtime
// entry therefore participates in the adapter implementation identity, while
// the runtime artifact `artifact_hash` covers only the runtime subset.
//
// Exit codes: 0 consistent, 1 drift or write failure, 2 invalid arguments.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADAPTERS,
  checkAdapter,
  hashFiles,
  listImplementationFiles,
  rewriteManifest
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

const USAGE = `Usage:
  node tools/adapter-manifest/cli.mjs [--check] [--root DIR] [--json]
  node tools/adapter-manifest/cli.mjs --write [--root DIR]

Checks or rewrites each adapter's _IMPLEMENTATION_FILES list from the real
source bytes. The checked set is src/** except src/manifest.ts plus runtime/**.

Options:
  --check      verify the checked-in lists (default)
  --write      rewrite each _IMPLEMENTATION_FILES list
  --root DIR   workspace root (default: repository root)
  --json       machine readable check output
  --help       show this message

Exit codes: 0 consistent, 1 drift, 2 invalid arguments.
`;

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, write: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--check") {
      options.write = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--root requires a directory");
      }
      options.root = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function write(adapter, root) {
  const adapterDir = resolve(root, adapter.dir);
  const files = hashFiles(adapterDir, listImplementationFiles(adapterDir));
  const result = rewriteManifest(adapterDir, adapter.prefix, files);
  writeFileSync(result.path, result.text, "utf8");
  return result;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`adapter-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (options.write) {
    const rewritten = [];
    for (const adapter of ADAPTERS) {
      try {
        const result = write(adapter, options.root);
        rewritten.push({ adapter: adapter.dir, path: result.path });
      } catch (error) {
        process.stderr.write(
          `adapter-manifest: ${adapter.dir}: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exit(1);
      }
    }
    process.stdout.write(`adapter-manifest: rewrote ${rewritten.length} manifests\n`);
    return;
  }

  const results = [];
  const failures = [];
  for (const adapter of ADAPTERS) {
    const result = checkAdapter(options.root, adapter);
    results.push({
      adapter: adapter.dir,
      implementation_hash: result.implementation_hash ?? null,
      files: result.files === undefined ? 0 : result.files.length,
      ok: result.ok === true,
      issues: result.issues
    });
    if (result.ok !== true) {
      failures.push(...result.issues);
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, adapters: results }, null, 2)}\n`);
  } else if (failures.length === 0) {
    for (const entry of results) {
      process.stdout.write(`ok ${entry.adapter} (${entry.files} files) ${entry.implementation_hash}\n`);
    }
  } else {
    for (const issue of failures) {
      process.stderr.write(`adapter-manifest: ${issue}\n`);
    }
  }
  if (failures.length > 0) {
    process.exit(1);
  }
}

main();
