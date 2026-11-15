#!/usr/bin/env node
// Kernel process entry bundler (DD-FND-101 performance).
//
// Usage:
//   node tools/kernel-bundle/cli.mjs [--root DIR]
//   node tools/kernel-bundle/cli.mjs [--root DIR] --check
//
// The `evolve serve` entrypoint loads the whole composition root, the seven
// host adapters and the domain packages as several hundred ESM modules. Node
// resolves, stats and compiles each of them on every process start, which is
// the dominant share of the warm-start gate (TC-PERF-02). This tool rewrites
// `apps/kernel/dist/main.js` into one ESM bundle (Node builtins external) so
// a process start resolves a single file. The compiled package entry points,
// declarations and the IPC/schema ABI do not change; only the process entry
// is pre-bundled.
//
// The tool runs after `tsc -b` and always rebuilds the bundle. `tsc -b` only
// re-emits files whose own emit changed, so a dependency change can update
// `bootstrap.js` while leaving `main.js` untouched. The first bundle copies
// the unbundled `main.js` to a sibling build artifact and every run bundles
// from that copy, so dependency-only rebuilds still refresh the entry. The
// copy is never the bundled file itself; re-bundling a previous bundle would
// preserve whatever stale dependency code it already inlined.
//
// Exit codes:
//   0  bundled, already bundled, or the check passed
//   1  build or check failed
//   2  invalid arguments

import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");
const ENTRY = join("apps", "kernel", "dist", "main.js");
const UNBUNDLED_ENTRY = join("apps", "kernel", "dist", ".main.entry.js");
const MARKER = "/* EVOPLUG_KERNEL_ENTRY_BUNDLE */";

const USAGE = `Usage: node tools/kernel-bundle/cli.mjs [--root DIR] [--check]

Bundles apps/kernel/dist/main.js into one ESM file after \`tsc -b\`.

Options:
  --root DIR   workspace root (default: repository root)
  --check      verify that the built entry is bundled; write nothing
  --help       show this message
`;

function fail(message) {
  process.stderr.write(`kernel-bundle: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        process.stderr.write("kernel-bundle: --root requires a directory\n");
        process.exitCode = 2;
        return null;
      }
      options.root = resolve(value);
      index += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else {
      process.stderr.write(`kernel-bundle: unknown argument: ${arg}\n`);
      process.exitCode = 2;
      return null;
    }
  }
  return options;
}

function isBundled(path) {
  try {
    return readFileSync(path, "utf8").startsWith(MARKER);
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const entry = join(options.root, ENTRY);
  const unbundledEntry = join(options.root, UNBUNDLED_ENTRY);
  if (!existsSync(entry)) {
    fail(`missing ${ENTRY}; run \`tsc -b tsconfig.build.json\` first`);
    return;
  }
  const bundled = isBundled(entry);
  if (bundled) {
    if (options.check) {
      process.stdout.write(`kernel-bundle: ${ENTRY} is bundled\n`);
      return;
    }
    if (!existsSync(unbundledEntry)) {
      fail(
        `missing ${UNBUNDLED_ENTRY}; run \`tsc -b tsconfig.build.json --force\` to regenerate the unbundled entry`
      );
      return;
    }
  } else {
    if (options.check) {
      fail(`${ENTRY} is not bundled`);
      return;
    }
    // Keep the emit of `main.ts` as the bundle input. A later dependency-only
    // rebuild re-emits other files but not `main.js`, so this copy is what
    // lets the next run pick those changes up.
    copyFileSync(entry, unbundledEntry);
  }
  // Bundle from the unbundled copy, never from the bundled file. The copy is
  // also a stable input path, so the same sources always produce the same
  // bundle bytes whether or not `tsc -b` re-emitted `main.js`.
  const source = unbundledEntry;

  // Bundle into a sibling temporary file, then rename both the code and its
  // source map over the tsc output. A failed build leaves the tsc output in
  // place rather than truncating the entry.
  const temporary = join(dirname(entry), ".main.bundle.js");
  const temporaryMap = `${temporary}.map`;
  try {
    await esbuild({
      entryPoints: [source],
      outfile: temporary,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["node:*"],
      sourcemap: "external",
      sourcesContent: true,
      banner: { js: MARKER },
      logLevel: "warning",
      allowOverwrite: true
    });
    renameSync(temporary, entry);
    if (existsSync(temporaryMap)) {
      renameSync(temporaryMap, `${entry}.map`);
    } else {
      rmSync(`${entry}.map`, { force: true });
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    rmSync(temporaryMap, { force: true });
    fail(`bundle failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  process.stdout.write(
    `kernel-bundle: bundled ${ENTRY} (${String(statSync(entry).size)} bytes)\n`
  );
}

await main();
