#!/usr/bin/env node
// Host runtime artifact builder (DD-HOST-200.1, DD-HOST-200.2).
//
// Usage:
//   node tools/runtime-artifact/cli.mjs --host pi \
//     --adapter-package adapters/pi --entry path/to/host-entry.mjs --out dist/runtime/pi
//   node tools/runtime-artifact/cli.mjs --single-file --host opencode ...
//   node tools/runtime-artifact/cli.mjs --check dist/runtime/pi
//
// The builder bundles the host entry with the runtime package and the IPC/JCS
// subset into one ESM file (Node builtins external), then writes manifest.json,
// a config.json template, per-file SHA-256 values, artifact_hash and
// implementation_hash.
//
// Exit codes: 0 success, 1 build/check failure, 2 invalid arguments.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build as esbuild } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const ARTIFACT_SCHEMA = "rsi.host_runtime_artifact/1";
const CONFIG_SCHEMA = "rsi.host_runtime_config/1";
const DEFAULT_ENTRY_FILE = "entry.mjs";
const SINGLE_FILE_ENTRY = "evoplug.js";
const SINGLE_FILE_DIR = "evoplug.runtime";
const FILE_MODE_PUBLIC = 0o644;
const FILE_MODE_PRIVATE = 0o600;
const MAX_PAYLOAD_DEFAULT = 8_388_608;
// Runtime build toolchain. It is compared with the adapter's declared build
// toolchain for diagnostics and never feeds `implementation_hash`.
const DEFAULT_TOOLCHAIN = "node@24.22.0;esbuild@0.28.2";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const DEFAULT_REDACT_FIELDS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "token",
  "secret",
  "password",
  "credential"
];

const USAGE = `Usage:
  node tools/runtime-artifact/cli.mjs --host <HostId> --adapter-package <dir> \\
    --entry <file> [--entry-name <name>] --out <dir> [--single-file] [--force]

  node tools/runtime-artifact/cli.mjs --check <artifact-dir> [--expect-artifact-hash HASH]
    [--expect-implementation-hash HASH]

Build options:
  --host ID              HostId (pi, oh-my-pi, step-code, codex, opencode,
                         openhands-sdk, claude-code)
  --adapter-package DIR  Adapter package root (reads package.json and the
                         exported descriptor for adapter id/version)
  --adapter-id ID        Fallback adapter id when the package is not importable
  --entry FILE           Host runtime entry module
  --entry-name NAME      Output entry filename (default entry.mjs)
  --out DIR              Artifact output directory
  --single-file          Write <out>/evoplug.js + <out>/evoplug.runtime/
  --force                Replace an existing runtime artifact directory; any
                         other non-empty directory is refused
  --registration-hash H  Value written to the config template; defaults to an
                         all-zero placeholder that attach must rewrite
  --implementation-hash H  Adapter-package implementation hash fallback (must
                           match the adapter manifest, not the runtime bundle)
  --mode MODE            Template HostMode (default interactive)
  --config-space SPACE   Template config space (default user)
  --toolchain STR        Runtime build toolchain, cross-checked against the
                         adapter's declared toolchain (default ${DEFAULT_TOOLCHAIN})

Check options:
  --check DIR            Verify an existing artifact (directory or single-file)
  --expect-artifact-hash H  Fail unless the recomputed artifact hash matches
  --expect-implementation-hash H  Fail unless manifest.implementation_hash
                         matches the adapter package implementation hash

Exit codes: 0 success, 1 failure, 2 invalid arguments.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    host: null,
    adapterPackage: null,
    adapterId: null,
    entry: null,
  entryName: DEFAULT_ENTRY_FILE,
    out: null,
    singleFile: false,
    force: false,
    check: null,
    expectArtifactHash: null,
    expectImplementationHash: null,
    registrationHash: null,
    implementationHash: null,
    mode: "interactive",
    configSpace: "user",
    toolchain: DEFAULT_TOOLCHAIN,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${name} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--single-file") {
      options.singleFile = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--check") {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        index += 1;
        options.check = resolve(next);
      } else {
        options.check = true;
      }
    } else if (arg.startsWith("--check=")) {
      options.check = resolve(arg.slice("--check=".length));
    } else if (arg === "--host") {
      options.host = take("--host");
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--adapter-package") {
      options.adapterPackage = resolve(take("--adapter-package"));
    } else if (arg.startsWith("--adapter-package=")) {
      options.adapterPackage = resolve(arg.slice("--adapter-package=".length));
    } else if (arg === "--adapter-id") {
      options.adapterId = take("--adapter-id");
    } else if (arg.startsWith("--adapter-id=")) {
      options.adapterId = arg.slice("--adapter-id=".length);
    } else if (arg === "--entry") {
      options.entry = resolve(take("--entry"));
    } else if (arg.startsWith("--entry=")) {
      options.entry = resolve(arg.slice("--entry=".length));
    } else if (arg === "--entry-name") {
      options.entryName = take("--entry-name");
    } else if (arg.startsWith("--entry-name=")) {
      options.entryName = arg.slice("--entry-name=".length);
    } else if (arg === "--out") {
      options.out = resolve(take("--out"));
    } else if (arg.startsWith("--out=")) {
      options.out = resolve(arg.slice("--out=".length));
    } else if (arg === "--expect-artifact-hash") {
      options.expectArtifactHash = take("--expect-artifact-hash");
    } else if (arg.startsWith("--expect-artifact-hash=")) {
      options.expectArtifactHash = arg.slice("--expect-artifact-hash=".length);
    } else if (arg === "--expect-implementation-hash") {
      options.expectImplementationHash = take("--expect-implementation-hash");
    } else if (arg.startsWith("--expect-implementation-hash=")) {
      options.expectImplementationHash = arg.slice("--expect-implementation-hash=".length);
    } else if (arg === "--registration-hash") {
      options.registrationHash = take("--registration-hash");
    } else if (arg.startsWith("--registration-hash=")) {
      options.registrationHash = arg.slice("--registration-hash=".length);
    } else if (arg === "--implementation-hash") {
      options.implementationHash = take("--implementation-hash");
    } else if (arg.startsWith("--implementation-hash=")) {
      options.implementationHash = arg.slice("--implementation-hash=".length);
    } else if (arg === "--mode") {
      options.mode = take("--mode");
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--config-space") {
      options.configSpace = take("--config-space");
    } else if (arg.startsWith("--config-space=")) {
      options.configSpace = arg.slice("--config-space=".length);
    } else if (arg === "--toolchain") {
      options.toolchain = take("--toolchain");
    } else if (arg.startsWith("--toolchain=")) {
      options.toolchain = arg.slice("--toolchain=".length);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.check !== null && options.check !== true && options.out === null) {
    options.out = options.check;
  }
  return options;
}

function canonicalJson(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  throw new TypeError(`not JSON: ${typeof value}`);
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function artifactHash(manifest) {
  return sha256Text(canonicalJson(manifest));
}

function isHash(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * The manifest `implementation_hash` is the adapter package manifest hash
 * (`rsi.adapter_manifest/1` over every adapter implementation file), never a
 * hash of the runtime artifact subset. `identity.adapter_implementation_hash`
 * comes from the adapter descriptor and is authoritative; the explicit flag is
 * only a fallback for packages whose descriptor cannot be imported.
 */
function resolveImplementationHash(identity, options) {
  const value = identity.adapter_implementation_hash ?? options.implementationHash;
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(
      "cannot determine adapter implementation_hash: the adapter package must export a descriptor with implementation_hash (or pass --implementation-hash); the runtime bundle hash is not a valid substitute"
    );
  }
  return value;
}

function isMetadataPath(path) {
  if (path === "manifest.json" || path === "config.json") {
    return true;
  }
  return /^[^/]+\.runtime\/(manifest|config)\.json$/.test(path);
}

function pathIssue(path) {
  if (typeof path !== "string" || path.length === 0) {
    return "empty_path";
  }
  if (path.includes("\0")) {
    return "nul_byte";
  }
  if (path.includes("\\")) {
    return "backslash";
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return "absolute_path";
  }
  if (path.endsWith("/")) {
    return "trailing_separator";
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "empty_segment";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "dot_or_parent_segment";
  }
  return null;
}

function validateManifest(manifest) {
  const issues = [];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest is not an object"];
  }
  const knownKeys = [
    "schema_version",
    "host_id",
    "adapter_id",
    "adapter_version",
    "implementation_hash",
    "entry",
    "files",
    "config_schema"
  ];
  for (const key of Object.keys(manifest)) {
    if (!knownKeys.includes(key)) {
      issues.push(`unknown manifest field: ${key}`);
    }
  }
  if (manifest.schema_version !== ARTIFACT_SCHEMA) {
    issues.push(`schema_version must be ${ARTIFACT_SCHEMA}`);
  }
  if (manifest.config_schema !== CONFIG_SCHEMA) {
    issues.push(`config_schema must be ${CONFIG_SCHEMA}`);
  }
  if (typeof manifest.host_id !== "string" || manifest.host_id.length === 0) {
    issues.push("host_id must be a non-empty string");
  }
  if (typeof manifest.adapter_id !== "string" || !/^adp:[0-9A-HJKMNP-TV-Z]{26}$/.test(manifest.adapter_id)) {
    issues.push("adapter_id must be an adp id");
  }
  if (typeof manifest.adapter_version !== "string" || manifest.adapter_version.length === 0) {
    issues.push("adapter_version must be a non-empty string");
  }
  if (!isHash(manifest.implementation_hash)) {
    issues.push("implementation_hash must be a sha256 hash");
  }
  const entryProblem = pathIssue(manifest.entry);
  if (entryProblem !== null) {
    issues.push(`entry: ${entryProblem}`);
  }
  if (!Array.isArray(manifest.files)) {
    issues.push("files must be an array");
    return issues;
  }
  const exact = new Set();
  const folded = new Map();
  let previous = null;
  let entryListed = false;
  for (const file of manifest.files) {
    if (file === null || typeof file !== "object") {
      issues.push("file entry must be an object");
      continue;
    }
    const problem = pathIssue(file.path);
    if (problem !== null) {
      issues.push(`file ${String(file.path)}: ${problem}`);
      continue;
    }
    if (isMetadataPath(file.path)) {
      issues.push(`metadata file must not enter files: ${file.path}`);
    }
    if (exact.has(file.path)) {
      issues.push(`duplicate path: ${file.path}`);
    }
    exact.add(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (folded.has(key) && folded.get(key) !== file.path) {
      issues.push(`case/NFC collision: ${file.path} vs ${folded.get(key)}`);
    }
    folded.set(key, file.path);
    if (previous !== null) {
      const a = Buffer.from(previous, "utf8");
      const b = Buffer.from(file.path, "utf8");
      if (Buffer.compare(a, b) >= 0) {
        issues.push(`files are not UTF-8 sorted: ${file.path}`);
      }
    }
    previous = file.path;
    if (!isHash(file.sha256)) {
      issues.push(`file sha256 invalid: ${file.path}`);
    }
    if (file.mode !== 384 && file.mode !== 420) {
      issues.push(`file mode must be 384 or 420: ${file.path}`);
    }
    if (file.path === manifest.entry) {
      entryListed = true;
    }
  }
  if (!entryListed) {
    issues.push(`entry is not listed in files: ${String(manifest.entry)}`);
  }
  return issues;
}

function walkFiles(root, prefix = "") {
  const output = [];
  const issues = [];
  const entries = readdirSync(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      issues.push(`symlink: ${relative}`);
      continue;
    }
    if (stat.isDirectory()) {
      const nested = walkFiles(root, relative);
      output.push(...nested.files);
      issues.push(...nested.issues);
      continue;
    }
    if (!stat.isFile()) {
      issues.push(`not a regular file: ${relative}`);
      continue;
    }
    if (stat.nlink > 1) {
      issues.push(`hard link (nlink=${stat.nlink}): ${relative}`);
      continue;
    }
    output.push({
      path: relative,
      sha256: sha256File(absolute),
      mode: stat.mode & 0o777
    });
  }
  return { files: output, issues };
}

function locateManifest(root) {
  const direct = join(root, "manifest.json");
  if (existsSync(direct) && lstatSync(direct).isFile()) {
    return direct;
  }
  if (!existsSync(root)) {
    return null;
  }
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".runtime")) {
      continue;
    }
    const candidate = join(root, entry.name, "manifest.json");
    if (existsSync(candidate) && lstatSync(candidate).isFile()) {
      candidates.push(candidate);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function checkArtifact(root, expectArtifactHash, expectImplementationHash) {
  const issues = [];
  const manifestPath = locateManifest(root);
  if (manifestPath === null) {
    return { ok: false, issues: [`manifest.json not found under ${root}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, issues: [`cannot parse manifest: ${error instanceof Error ? error.message : String(error)}`] };
  }
  issues.push(...validateManifest(manifest));
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const declared = new Set();
  for (const file of manifest.files) {
    declared.add(file.path);
    const absolute = resolve(root, ...file.path.split("/"));
    if (!existsSync(absolute)) {
      issues.push(`missing file: ${file.path}`);
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      issues.push(`symlink: ${file.path}`);
      continue;
    }
    if (!stat.isFile()) {
      issues.push(`not a regular file: ${file.path}`);
      continue;
    }
    if (stat.nlink > 1) {
      issues.push(`hard link (nlink=${stat.nlink}): ${file.path}`);
      continue;
    }
    if ((stat.mode & 0o777) !== file.mode) {
      issues.push(`mode mismatch: ${file.path} expected ${file.mode} actual ${stat.mode & 0o777}`);
    }
    const actual = sha256File(absolute);
    if (actual !== file.sha256) {
      issues.push(`hash mismatch: ${file.path}`);
    }
  }
  const walked = walkFiles(root);
  issues.push(...walked.issues);
  for (const file of walked.files) {
    if (isMetadataPath(file.path)) {
      continue;
    }
    if (!declared.has(file.path)) {
      issues.push(`unlisted file: ${file.path}`);
    }
  }
  const configPath = join(dirname(manifestPath), "config.json");
  if (existsSync(configPath)) {
    const configStat = lstatSync(configPath);
    if ((configStat.mode & 0o777) !== FILE_MODE_PRIVATE) {
      issues.push(`config.json must be 0600: ${configPath}`);
    }
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.schema_version !== CONFIG_SCHEMA) {
        issues.push(`config.json schema_version must be ${CONFIG_SCHEMA}`);
      }
      if (!isHash(config.registration_hash)) {
        issues.push("config.json registration_hash must be a sha256 hash");
      }
      if (config.implementation_hash !== manifest.implementation_hash) {
        issues.push("config.json implementation_hash must equal manifest.implementation_hash");
      }
    } catch (error) {
      issues.push(`cannot parse config.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const computedArtifactHash = artifactHash(manifest);
  if (expectArtifactHash !== null && computedArtifactHash !== expectArtifactHash) {
    issues.push(`artifact_hash mismatch: expected ${expectArtifactHash} actual ${computedArtifactHash}`);
  }
  // `implementation_hash` covers the adapter package file list, which is not
  // available inside the runtime artifact; only compare an explicit expected
  // value. It is never recomputed from `manifest.files`.
  if (
    expectImplementationHash !== null &&
    manifest.implementation_hash !== expectImplementationHash
  ) {
    issues.push(
      `implementation_hash mismatch: expected ${expectImplementationHash} actual ${manifest.implementation_hash}`
    );
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    manifest,
    artifact_hash: computedArtifactHash,
    implementation_hash: manifest.implementation_hash,
    files: manifest.files.length
  };
}

function listAdapterExports(module) {
  const descriptorCandidates = [];
  const toolchains = [];
  for (const value of Object.values(module)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (value.schema_version === "rsi.adapter_descriptor/1") {
        descriptorCandidates.push(value);
      }
    }
    if (typeof value === "string" && /^node@[^;]+;/.test(value)) {
      toolchains.push(value);
    }
  }
  return { descriptorCandidates, toolchains };
}

async function loadIdentity(adapterPackage, host, explicitAdapterId) {
  const packagePath = join(adapterPackage, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const exportField = pkg.exports?.["."];
  const importTarget = typeof exportField === "string"
    ? exportField
    : typeof exportField?.import === "string"
      ? exportField.import
      : pkg.main ?? "dist/index.js";
  let descriptor = null;
  let discoveredToolchain = null;
  try {
    const modulePath = resolve(adapterPackage, importTarget);
    const loaded = await import(pathToFileURL(modulePath).href);
    const scanned = listAdapterExports(loaded);
    descriptor = scanned.descriptorCandidates.find((candidate) => candidate.host_id === host) ??
      scanned.descriptorCandidates[0] ??
      null;
    discoveredToolchain = scanned.toolchains[0] ?? null;
  } catch (error) {
    process.stderr.write(
      `runtime-artifact: adapter module not importable (${error instanceof Error ? error.message : String(error)}); using package.json identity\n`
    );
  }
  const adapterId = descriptor?.adapter_id ?? explicitAdapterId;
  if (typeof adapterId !== "string") {
    throw new Error(
      "cannot determine adapter_id: import the adapter descriptor or pass --adapter-id"
    );
  }
  const hostId = descriptor?.host_id ?? host;
  if (hostId !== host) {
    throw new Error(`adapter descriptor host_id ${String(hostId)} does not match --host ${host}`);
  }
  const adapterVersion = descriptor?.adapter_version ?? pkg.version;
  if (typeof adapterVersion !== "string" || adapterVersion.length === 0) {
    throw new Error("adapter_version is empty");
  }
  return {
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    host_id: host,
    package_version: pkg.version,
    adapter_implementation_hash: descriptor?.implementation_hash ?? null,
    discovered_toolchain: discoveredToolchain
  };
}

function validateEntryName(name) {
  const problem = pathIssue(name);
  if (problem !== null) {
    throw new UsageError(`--entry-name: ${problem}`);
  }
  if (name.includes("/")) {
    throw new UsageError("--entry-name must name a file at the artifact root");
  }
  if (name === "." || name === "..") {
    throw new UsageError("--entry-name must not be . or ..");
  }
  if (isMetadataPath(name)) {
    throw new UsageError("--entry-name must not be manifest.json or config.json");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new UsageError("--entry-name contains unsupported characters");
  }
}

function isRuntimeArtifactRoot(root) {
  for (const manifestPath of [
    join(root, "manifest.json"),
    join(root, SINGLE_FILE_DIR, "manifest.json")
  ]) {
    if (!existsSync(manifestPath)) {
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest?.schema_version === ARTIFACT_SCHEMA) {
        return true;
      }
    } catch {
      // A corrupt manifest is not proof that the directory is a product artifact.
    }
  }
  return false;
}

function ensureEmptyOutput(out, force) {
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true, mode: 0o755 });
    return;
  }
  const stat = lstatSync(out);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`--out must be a directory: ${out}`);
  }
  if (readdirSync(out).length > 0) {
    if (!force) {
      throw new Error(`--out is not empty: ${out} (use --force to replace)`);
    }
    if (!isRuntimeArtifactRoot(out)) {
      throw new Error(
        `--out is not empty and contains no ${ARTIFACT_SCHEMA} manifest; refusing to remove unrelated files: ${out}`
      );
    }
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true, mode: 0o755 });
  }
}

async function bundleEntry(entry, outfile) {
  await esbuild({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["node:*"],
    legalComments: "none",
    sourcemap: false,
    logLevel: "silent",
    banner: {
      js: `// evoplug host runtime artifact (manifest.json is authoritative)`
    }
  });
  chmodSync(outfile, FILE_MODE_PUBLIC);
}

function writeJson(path, value, mode) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function configTemplate(options, identity, implementation) {
  return {
    schema_version: CONFIG_SCHEMA,
    host_id: identity.host_id,
    mode: options.mode,
    config_space: options.configSpace,
    adapter_id: identity.adapter_id,
    adapter_version: identity.adapter_version,
    implementation_hash: implementation,
    registration_hash: options.registrationHash ?? ZERO_HASH,
    ipc: {
      evoplug_home: "<EVOPLUG_HOME>",
      client_id: identity.adapter_id,
      client_kind: "host_runtime"
    },
    behavior: {
      submit_events: true,
      allow_delivery: true,
      max_payload_bytes: MAX_PAYLOAD_DEFAULT,
      redact_fields: DEFAULT_REDACT_FIELDS
    },
    log: {
      path: "<EVOPLUG_HOME>/logs/host-runtime.log",
      level: "info"
    },
    created_at: Date.now()
  };
}

async function runBuild(options) {
  if (options.host === null) throw new UsageError("--host is required");
  if (options.adapterPackage === null) throw new UsageError("--adapter-package is required");
  if (options.entry === null) throw new UsageError("--entry is required");
  if (options.out === null) throw new UsageError("--out is required");
  if (!existsSync(options.entry)) {
    throw new Error(`entry not found: ${options.entry}`);
  }
  if (options.registrationHash !== null && !isHash(options.registrationHash)) {
    throw new Error("--registration-hash must be sha256:<64 lowercase hex>");
  }
  if (options.implementationHash !== null && !isHash(options.implementationHash)) {
    throw new Error("--implementation-hash must be sha256:<64 lowercase hex>");
  }
  if (!options.singleFile) {
    validateEntryName(options.entryName);
  }
  const identity = await loadIdentity(options.adapterPackage, options.host, options.adapterId ?? null);
  if (
    identity.discovered_toolchain !== null &&
    identity.discovered_toolchain !== options.toolchain
  ) {
    process.stderr.write(
      `runtime-artifact: note: adapter toolchain ${identity.discovered_toolchain} differs from runtime toolchain ${options.toolchain}\n`
    );
  }

  ensureEmptyOutput(options.out, options.force);
  const entryPath = options.singleFile ? SINGLE_FILE_ENTRY : options.entryName;
  const bundlePath = join(options.out, entryPath);
  await bundleEntry(options.entry, bundlePath);

  const files = [
    {
      path: entryPath,
      sha256: sha256File(bundlePath),
      mode: 420
    }
  ];
  const implementation = resolveImplementationHash(identity, options);
  const manifest = {
    schema_version: ARTIFACT_SCHEMA,
    host_id: identity.host_id,
    adapter_id: identity.adapter_id,
    adapter_version: identity.adapter_version,
    implementation_hash: implementation,
    entry: entryPath,
    files,
    config_schema: CONFIG_SCHEMA
  };
  const manifestIssues = validateManifest(manifest);
  if (manifestIssues.length > 0) {
    throw new Error(`generated manifest is invalid: ${manifestIssues.join("; ")}`);
  }
  const metadataDir = options.singleFile ? join(options.out, SINGLE_FILE_DIR) : options.out;
  mkdirSync(metadataDir, { recursive: true, mode: 0o755 });
  writeJson(join(metadataDir, "manifest.json"), manifest, FILE_MODE_PUBLIC);
  writeJson(
    join(metadataDir, "config.json"),
    configTemplate(options, identity, implementation),
    FILE_MODE_PRIVATE
  );
  return {
    ok: true,
    artifact_root: options.out,
    entry: entryPath,
    manifest_path: join(metadataDir, "manifest.json"),
    config_path: join(metadataDir, "config.json"),
    artifact_hash: artifactHash(manifest),
    implementation_hash: implementation,
    adapter_implementation_hash: implementation,
    toolchain: options.toolchain,
    files
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`runtime-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.check !== null) {
    const target = options.check === true ? options.out : options.check;
    if (target === null) {
      process.stderr.write("runtime-artifact: --check requires an artifact directory\n");
      return 2;
    }
    const result = checkArtifact(
      target,
      options.expectArtifactHash,
      options.expectImplementationHash
    );
    if (!result.ok) {
      for (const message of result.issues) {
        process.stderr.write(`runtime-artifact: ${message}\n`);
      }
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          artifact_root: target,
          artifact_hash: result.artifact_hash,
          implementation_hash: result.implementation_hash,
          toolchain: options.toolchain,
          files: result.files
        },
        null,
        2
      )}\n`
    );
    return 0;
  }
  try {
    const result = await runBuild(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`runtime-artifact: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`runtime-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = await main();
