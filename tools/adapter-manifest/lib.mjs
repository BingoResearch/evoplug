// Adapter implementation-manifest source of truth (DD-HOST-001, DD-HOST-200.2).
//
// The implementation hash is computed over every adapter package source file:
// all of `src/**` except `src/manifest.ts` (it carries the value), plus every
// `runtime/**` file. Runtime entries are part of the adapter package, so they
// must enter `rsi.adapter_manifest/1`; the runtime artifact `artifact_hash` is
// a separate, runtime-subset hash.
//
// Paths are UTF-8 byte sorted and relative to the adapter package root.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ADAPTERS = Object.freeze([
  Object.freeze({ dir: "adapters/claude-code", prefix: "CLAUDE" }),
  Object.freeze({ dir: "adapters/codex", prefix: "CODEX" }),
  Object.freeze({ dir: "adapters/oh-my-pi", prefix: "OMP" }),
  Object.freeze({ dir: "adapters/opencode", prefix: "OPENCODE" }),
  Object.freeze({ dir: "adapters/openhands-sdk", prefix: "OPENHANDS" }),
  Object.freeze({ dir: "adapters/pi", prefix: "PI" }),
  Object.freeze({ dir: "adapters/step-code", prefix: "STEP" })
]);

export const MANIFEST_FILE = "src/manifest.ts";

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function walkFiles(root, relativeDir, output) {
  const absoluteDir = join(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absoluteDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const absolute = join(absoluteDir, name);
    const relative = `${relativeDir}/${name}`;
    if (statSync(absolute).isDirectory()) {
      walkFiles(root, relative, output);
    } else if (statSync(absolute).isFile()) {
      output.push(relative);
    }
  }
}

/**
 * Every implementation file of an adapter package, in UTF-8 byte order.
 * `src/manifest.ts` is excluded because it contains the resulting hash.
 */
export function listImplementationFiles(adapterDir) {
  const files = [];
  walkFiles(adapterDir, "src", files);
  walkFiles(adapterDir, "runtime", files);
  return files.filter((path) => path !== MANIFEST_FILE).sort(utf8Compare);
}

export function sha256File(adapterDir, relativePath) {
  const digest = createHash("sha256").update(readFileSync(join(adapterDir, relativePath))).digest("hex");
  return `sha256:${digest}`;
}

export function hashFiles(adapterDir, paths) {
  return paths.map((path) => ({ path, sha256: sha256File(adapterDir, path) }));
}

/** RFC 8785 JCS for the JSON subset used by the implementation manifest. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("non-finite number in canonical JSON");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function hashText(text) {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

export function canonicalHash(value) {
  return hashText(canonicalJson(value));
}

/** `sha256(JCS({schema_version:"rsi.adapter_manifest/1",...}))`. */
export function computeImplementationHash(input) {
  return canonicalHash({
    schema_version: "rsi.adapter_manifest/1",
    adapter_id: input.adapter_id,
    adapter_version: input.adapter_version,
    host_id: input.host_id,
    files: input.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    toolchain: input.toolchain
  });
}

/** Reads `adapter_id`, `adapter_version`, `host_id` and `toolchain` constants. */
export function readManifestIdentity(adapterDir, prefix) {
  const text = readFileSync(join(adapterDir, MANIFEST_FILE), "utf8");
  const id = /export const ([A-Z0-9_]+)_ADAPTER_ID[^=]*= "([^"]+)"/.exec(text);
  const version = /export const ([A-Z0-9_]+)_ADAPTER_VERSION = "([^"]+)"/.exec(text);
  const host = /export const ([A-Z0-9_]+)_HOST_ID[^=]*= "([^"]+)"/.exec(text);
  const toolchain = /export const ([A-Z0-9_]+)_TOOLCHAIN = "([^"]+)"/.exec(text);
  for (const match of [id, version, host, toolchain]) {
    if (match === null || match[1] !== prefix) {
      throw new Error(`${adapterDir}: cannot read ${prefix} manifest identity constants`);
    }
  }
  return {
    adapter_id: id[2],
    adapter_version: version[2],
    host_id: host[2],
    toolchain: toolchain[2]
  };
}

/** Parses the declared `*_IMPLEMENTATION_FILES` entries from manifest.ts. */
export function readDeclaredFiles(adapterDir, prefix) {
  const text = readFileSync(join(adapterDir, MANIFEST_FILE), "utf8");
  const start = text.indexOf(`export const ${prefix}_IMPLEMENTATION_FILES`);
  if (start < 0) {
    throw new Error(`${adapterDir}: ${prefix}_IMPLEMENTATION_FILES is missing`);
  }
  const open = text.indexOf("Object.freeze([", start);
  const close = text.indexOf("\n]);", open);
  if (open < 0 || close < 0) {
    throw new Error(`${adapterDir}: cannot parse ${prefix}_IMPLEMENTATION_FILES`);
  }
  const body = text.slice(open + "Object.freeze([".length, close);
  const files = [];
  const entry = /\{ path: "([^"]+)", sha256: "(sha256:[0-9a-f]{64})" \}/g;
  let match;
  while ((match = entry.exec(body)) !== null) {
    files.push({ path: match[1], sha256: match[2] });
  }
  return files;
}

/** Replaces the declared `*_IMPLEMENTATION_FILES` array with `files`. */
export function rewriteManifest(adapterDir, prefix, files) {
  const path = join(adapterDir, MANIFEST_FILE);
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(`export const ${prefix}_IMPLEMENTATION_FILES`);
  if (start < 0) {
    throw new Error(`${adapterDir}: ${prefix}_IMPLEMENTATION_FILES is missing`);
  }
  const open = text.indexOf("Object.freeze([", start);
  const close = text.indexOf("\n]);", open);
  if (open < 0 || close < 0) {
    throw new Error(`${adapterDir}: cannot rewrite ${prefix}_IMPLEMENTATION_FILES`);
  }
  const lines = files.map(
    (file) => `  { path: ${JSON.stringify(file.path)}, sha256: ${JSON.stringify(file.sha256)} }`
  );
  return {
    path,
    text: `${text.slice(0, open + "Object.freeze([".length)}\n${lines.join(",\n")}${text.slice(close)}`
  };
}

/**
 * Checks one adapter. `ok` is true when every declared entry exists at its
 * current bytes, the set is exactly the package source set and the list is
 * UTF-8 byte sorted.
 */
export function checkAdapter(root, adapter) {
  const adapterDir = join(root, adapter.dir);
  const issues = [];
  let identity;
  try {
    identity = readManifestIdentity(adapterDir, adapter.prefix);
  } catch (error) {
    return { ok: false, issues: [`${adapter.dir}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const expectedPaths = listImplementationFiles(adapterDir);
  const actualFiles = hashFiles(adapterDir, expectedPaths);
  let declared;
  try {
    declared = readDeclaredFiles(adapterDir, adapter.prefix);
  } catch (error) {
    return { ok: false, issues: [`${adapter.dir}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!expectedPaths.includes("runtime/entry.ts")) {
    issues.push(`${adapter.dir}: runtime/entry.ts is not an implementation file`);
  }
  const declaredPaths = declared.map((file) => file.path);
  const expectedText = expectedPaths.join("\n");
  const declaredText = declaredPaths.join("\n");
  if (expectedText !== declaredText) {
    const missing = expectedPaths.filter((path) => !declaredPaths.includes(path));
    const extra = declaredPaths.filter((path) => !expectedPaths.includes(path));
    if (missing.length > 0) {
      issues.push(`${adapter.dir}: missing implementation files: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      issues.push(`${adapter.dir}: undeclared implementation files: ${extra.join(", ")}`);
    }
    if (missing.length === 0 && extra.length === 0) {
      issues.push(`${adapter.dir}: implementation files are not UTF-8 byte sorted`);
    }
  }
  for (const file of declared) {
    let actual;
    try {
      actual = sha256File(adapterDir, file.path);
    } catch {
      issues.push(`${adapter.dir}: declared file does not exist: ${file.path}`);
      continue;
    }
    if (actual !== file.sha256) {
      issues.push(`${adapter.dir}: stale hash for ${file.path} (declared ${file.sha256}, actual ${actual})`);
    }
  }
  const implementationHash = computeImplementationHash({ ...identity, files: actualFiles });
  const sourceText = readFileSync(join(adapterDir, MANIFEST_FILE), "utf8");
  if (!sourceText.includes(`${adapter.prefix}_IMPLEMENTATION_HASH: Hash = computeImplementationHash({`)) {
    issues.push(`${adapter.dir}: ${adapter.prefix}_IMPLEMENTATION_HASH must be computed from the file list`);
  }
  return { ok: issues.length === 0, issues, implementation_hash: implementationHash, files: actualFiles };
}
