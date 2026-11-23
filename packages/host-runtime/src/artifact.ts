/**
 * Runtime artifact manifest, file hashing and load-time verification
 * (DD-HOST-200.1, DD-HOST-200.2).
 *
 * An artifact is a directory (or a single-file plugin plus `<name>.runtime/`)
 * whose files are ordinary, non-linked, relative paths. `manifest.json` lists
 * every file except `manifest.json` and `config.json`; `artifact_hash` is
 * `sha256(JCS(manifest))`. The entry recomputes every file hash before it
 * connects to IPC and reports the recomputed hash as `load_verified_hash`.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  canonicalJson,
  compareUtf8,
  hashBytes,
  isHash,
  isHostId,
  isId,
  isWellFormedUnicode,
  type Hash,
  type Id,
  type JsonValue
} from "@evoplug/core";
import type { HostId, HostMode } from "@evoplug/core/host";

export const HOST_RUNTIME_ARTIFACT_SCHEMA_VERSION = "rsi.host_runtime_artifact/1";
export const HOST_RUNTIME_CONFIG_SCHEMA_VERSION = "rsi.host_runtime_config/1";
export const HOST_RUNTIME_REDACTION_SCHEMA_VERSION = "rsi.host_runtime_redaction/1";

const HOST_RUNTIME_MANIFEST_FILE = "manifest.json";
const HOST_RUNTIME_CONFIG_FILE = "config.json";

/** `384` = 0600, `420` = 0644. No other mode may be listed. */
type HostRuntimeFileMode = 384 | 420;
export const HOST_RUNTIME_FILE_MODE_PRIVATE: HostRuntimeFileMode = 384;
export const HOST_RUNTIME_FILE_MODE_PUBLIC: HostRuntimeFileMode = 420;

export interface HostRuntimeArtifactFile {
  readonly path: string;
  readonly sha256: Hash;
  readonly mode: HostRuntimeFileMode;
}

export interface HostRuntimeArtifactManifest {
  readonly schema_version: "rsi.host_runtime_artifact/1";
  readonly host_id: HostId;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly entry: string;
  readonly files: readonly HostRuntimeArtifactFile[];
  readonly config_schema: "rsi.host_runtime_config/1";
}

export interface HostRuntimeConfigIpc {
  readonly evoplug_home: string;
  readonly socket_path?: string;
  readonly token_path?: string;
  readonly client_id: Id<"adp">;
  readonly client_kind: "host_runtime";
}

export interface HostRuntimeConfigBehavior {
  readonly submit_events: boolean;
  readonly allow_delivery: boolean;
  readonly max_payload_bytes: number;
  readonly redact_fields: readonly string[];
}

export type HostRuntimeLogLevel = "error" | "warn" | "info";

export interface HostRuntimeConfigLog {
  readonly path: string;
  readonly level: HostRuntimeLogLevel;
}

export interface HostRuntimeConfig {
  readonly schema_version: "rsi.host_runtime_config/1";
  readonly host_id: HostId;
  /** Real host version read by attach; absent on old configs. */
  readonly host_version?: string;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  /** Planned/applied registration hash; covered by `config_hash`. */
  readonly registration_hash: Hash;
  readonly ipc: HostRuntimeConfigIpc;
  readonly behavior: HostRuntimeConfigBehavior;
  readonly log: HostRuntimeConfigLog;
  readonly created_at: number;
}

export interface HostRuntimeArtifactIssue {
  readonly code: string;
  readonly path: string;
  readonly rule: string;
}

interface HostRuntimeArtifactBuild {
  readonly manifest: HostRuntimeArtifactManifest;
  readonly artifact_hash: Hash;
}

type HostRuntimeArtifactBuildResult =
  | { readonly ok: true; readonly value: HostRuntimeArtifactBuild }
  | { readonly ok: false; readonly issues: readonly HostRuntimeArtifactIssue[] };

interface VerifiedHostRuntimeArtifact {
  readonly artifact_root: string;
  readonly manifest_path: string;
  readonly manifest: HostRuntimeArtifactManifest;
  readonly artifact_hash: Hash;
  readonly load_verified_hash: Hash;
}

type HostRuntimeArtifactVerification =
  | { readonly ok: true; readonly value: VerifiedHostRuntimeArtifact }
  | { readonly ok: false; readonly issues: readonly HostRuntimeArtifactIssue[] };

interface CollectArtifactFilesOptions {
  /**
   * File names (relative POSIX paths) that are metadata and therefore never
   * part of `files`. Defaults to the manifest/config rules of DD-HOST-200.1.
   */
  readonly exclude?: (relativePath: string) => boolean;
}

function issue(code: string, path: string, rule: string): HostRuntimeArtifactIssue {
  return { code, path, rule };
}

/** True for `manifest.json`, `config.json` and `<name>.runtime/{manifest,config}.json`. */
export function isHostRuntimeMetadataPath(relativePath: string): boolean {
  if (relativePath === HOST_RUNTIME_MANIFEST_FILE || relativePath === HOST_RUNTIME_CONFIG_FILE) {
    return true;
  }
  const match = /^([^/]+)\.runtime\/(manifest|config)\.json$/.exec(relativePath);
  return match !== null;
}

/**
 * Validates one manifest-relative path. Returns `null` when the path is safe:
 * relative, POSIX separators, no empty/`.`/`..` segments, no NUL or backslash,
 * well-formed Unicode.
 */
export function validateArtifactRelativePath(path: string): HostRuntimeArtifactIssue | null {
  if (path.length === 0) {
    return issue("empty_path", path, "non_empty");
  }
  if (!isWellFormedUnicode(path)) {
    return issue("invalid_unicode", path, "well_formed_unicode");
  }
  if (path.includes("\0")) {
    return issue("nul_byte", path, "no_nul");
  }
  if (path.includes("\\")) {
    return issue("backslash", path, "posix_separator");
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return issue("absolute_path", path, "relative_path");
  }
  if (path.endsWith("/")) {
    return issue("trailing_separator", path, "file_path");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return issue("empty_segment", path, "no_empty_segment");
    }
    if (segment === ".") {
      return issue("dot_segment", path, "no_dot_segment");
    }
    if (segment === "..") {
      return issue("parent_segment", path, "no_parent_segment");
    }
  }
  return null;
}

/** NFC + case-folded key used only for collision detection. */
function artifactCollisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Validates a whole manifest's structure, ordering and collision rules. */
export function validateHostRuntimeArtifactManifest(
  value: unknown
): readonly HostRuntimeArtifactIssue[] {
  const issues: HostRuntimeArtifactIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [issue("manifest_shape", "$", "object")];
  }
  const record = value as Record<string, unknown>;
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
  for (const key of Object.keys(record)) {
    if (!knownKeys.includes(key)) {
      issues.push(issue("unknown_field", key, "closed_manifest"));
    }
  }
  for (const key of knownKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      issues.push(issue("missing_field", key, "required"));
    }
  }
  if (record["schema_version"] !== HOST_RUNTIME_ARTIFACT_SCHEMA_VERSION) {
    issues.push(issue("schema_version", "schema_version", HOST_RUNTIME_ARTIFACT_SCHEMA_VERSION));
  }
  if (record["config_schema"] !== HOST_RUNTIME_CONFIG_SCHEMA_VERSION) {
    issues.push(issue("config_schema", "config_schema", HOST_RUNTIME_CONFIG_SCHEMA_VERSION));
  }
  if (typeof record["host_id"] !== "string" || !isHostId(record["host_id"])) {
    issues.push(issue("host_id", "host_id", "host_id"));
  }
  if (typeof record["adapter_id"] !== "string" || !isId(record["adapter_id"], "adp")) {
    issues.push(issue("adapter_id", "adapter_id", "adp_id"));
  }
  if (typeof record["adapter_version"] !== "string" || record["adapter_version"].length === 0) {
    issues.push(issue("adapter_version", "adapter_version", "non_empty"));
  }
  if (typeof record["implementation_hash"] !== "string" || !isHash(record["implementation_hash"])) {
    issues.push(issue("implementation_hash", "implementation_hash", "sha256"));
  }
  const entry = record["entry"];
  if (typeof entry !== "string") {
    issues.push(issue("entry", "entry", "string"));
  } else {
    const entryIssue = validateArtifactRelativePath(entry);
    if (entryIssue !== null) {
      issues.push(entryIssue);
    }
  }
  const filesValue = record["files"];
  if (!Array.isArray(filesValue)) {
    issues.push(issue("files", "files", "array"));
    return issues;
  }
  const exactPaths = new Set<string>();
  const collisionKeys = new Map<string, string>();
  let previousPath: string | null = null;
  let entryListed = false;
  for (let index = 0; index < filesValue.length; index += 1) {
    const fileValue = filesValue[index];
    const filePath = `files[${String(index)}]`;
    if (typeof fileValue !== "object" || fileValue === null || Array.isArray(fileValue)) {
      issues.push(issue("file_shape", filePath, "object"));
      continue;
    }
    const file = fileValue as Record<string, unknown>;
    for (const key of Object.keys(file)) {
      if (key !== "path" && key !== "sha256" && key !== "mode") {
        issues.push(issue("unknown_field", `${filePath}.${key}`, "closed_file"));
      }
    }
    const path = file["path"];
    if (typeof path !== "string") {
      issues.push(issue("file_path", `${filePath}.path`, "string"));
      continue;
    }
    const pathIssue = validateArtifactRelativePath(path);
    if (pathIssue !== null) {
      issues.push(pathIssue);
      continue;
    }
    if (isHostRuntimeMetadataPath(path)) {
      issues.push(issue("metadata_in_files", path, "metadata_excluded"));
    }
    if (exactPaths.has(path)) {
      issues.push(issue("duplicate_path", path, "unique_path"));
    } else {
      exactPaths.add(path);
    }
    const collisionKey = artifactCollisionKey(path);
    const previous = collisionKeys.get(collisionKey);
    if (previous !== undefined && previous !== path) {
      issues.push(issue("case_or_nfc_collision", path, `collides_with:${previous}`));
    } else {
      collisionKeys.set(collisionKey, path);
    }
    if (previousPath !== null && compareUtf8(previousPath, path) >= 0) {
      issues.push(issue("not_utf8_sorted", path, "utf8_order"));
    }
    previousPath = path;
    const sha = file["sha256"];
    if (typeof sha !== "string" || !isHash(sha)) {
      issues.push(issue("file_sha256", `${filePath}.sha256`, "sha256"));
    }
    const mode = file["mode"];
    if (mode !== HOST_RUNTIME_FILE_MODE_PRIVATE && mode !== HOST_RUNTIME_FILE_MODE_PUBLIC) {
      issues.push(issue("file_mode", `${filePath}.mode`, "384_or_420"));
    }
    if (typeof entry === "string" && path === entry) {
      entryListed = true;
    }
  }
  if (typeof entry === "string" && !entryListed) {
    issues.push(issue("entry_missing", entry, "entry_in_files"));
  }
  return issues;
}

/** `sha256(JCS(manifest))`, the artifact identity of DD-HOST-200.2. */
export function computeArtifactHash(manifest: HostRuntimeArtifactManifest): Hash {
  return hashBytes(canonicalJson(manifest as unknown as JsonValue));
}

/**
 * `written_hash` from the attach side: the same formula over the manifest after
 * every file was written and read back. It equals `artifact_hash` exactly when
 * every file hash matched (DD-HOST-200.2).
 */
export function computeWrittenHash(manifest: HostRuntimeArtifactManifest): Hash {
  return computeArtifactHash(manifest);
}

/** Sorts file entries by the UTF-8 byte order of `path`. */
function sortArtifactFiles(
  files: readonly HostRuntimeArtifactFile[]
): HostRuntimeArtifactFile[] {
  const decorated = files.map((file) => ({ file, key: file.path }));
  decorated.sort((left, right) => compareUtf8(left.key, right.key));
  return decorated.map((entry) => entry.file);
}

interface BuildArtifactManifestInput {
  readonly host_id: HostId;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly entry: string;
  readonly files: readonly HostRuntimeArtifactFile[];
}

/** Builds, sorts and validates a manifest and its artifact hash. */
export function buildArtifactManifest(input: BuildArtifactManifestInput): HostRuntimeArtifactBuildResult {
  const files = sortArtifactFiles(input.files).map((file) => ({
    path: file.path,
    sha256: file.sha256,
    mode: file.mode
  }));
  const manifest: HostRuntimeArtifactManifest = {
    schema_version: HOST_RUNTIME_ARTIFACT_SCHEMA_VERSION,
    host_id: input.host_id,
    adapter_id: input.adapter_id,
    adapter_version: input.adapter_version,
    implementation_hash: input.implementation_hash,
    entry: input.entry,
    files,
    config_schema: HOST_RUNTIME_CONFIG_SCHEMA_VERSION
  };
  const issues = validateHostRuntimeArtifactManifest(manifest);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: { manifest, artifact_hash: computeArtifactHash(manifest) } };
}

async function sha256File(path: string): Promise<Hash> {
  const bytes = await readFile(path);
  return hashBytes(bytes);
}

function modeOf(stat: { mode: number }): number {
  return stat.mode & 0o777;
}

/**
 * Walks an artifact directory and returns every non-metadata regular file with
 * its hash and mode. Symlinks, hard links (`nlink > 1`), non-regular files and
 * unsupported modes are reported as issues.
 */
export async function collectArtifactFiles(
  root: string,
  options?: CollectArtifactFilesOptions
): Promise<{ readonly files: readonly HostRuntimeArtifactFile[]; readonly issues: readonly HostRuntimeArtifactIssue[] }> {
  const files: HostRuntimeArtifactFile[] = [];
  const issues: HostRuntimeArtifactIssue[] = [];
  const exclude = options?.exclude ?? isHostRuntimeMetadataPath;

  const rootStat = await lstat(root).catch(() => null);
  if (rootStat === null) {
    return { files, issues: [issue("artifact_root_unreadable", root, "directory")] };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { files, issues: [issue("root_not_directory", root, "directory")] };
  }

  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        issues.push(issue("symlink", relativePath, "regular_file"));
        continue;
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        issues.push(issue("not_regular_file", relativePath, "regular_file"));
        continue;
      }
      if (stat.nlink > 1) {
        issues.push(issue("hard_link", relativePath, "nlink_1"));
        continue;
      }
      if (exclude(relativePath)) {
        continue;
      }
      const rawMode = modeOf(stat);
      let mode: HostRuntimeFileMode;
      if (rawMode === HOST_RUNTIME_FILE_MODE_PRIVATE) {
        mode = HOST_RUNTIME_FILE_MODE_PRIVATE;
      } else if (rawMode === HOST_RUNTIME_FILE_MODE_PUBLIC) {
        mode = HOST_RUNTIME_FILE_MODE_PUBLIC;
      } else {
        issues.push(issue("unsupported_mode", relativePath, "384_or_420"));
        continue;
      }
      files.push({ path: relativePath, sha256: await sha256File(absolutePath), mode });
    }
  };

  try {
    await walk(root, "");
  } catch (error) {
    issues.push(issue("walk_failed", root, error instanceof Error ? error.message : String(error)));
  }
  return { files: sortArtifactFiles(files), issues };
}

async function locateManifest(root: string): Promise<
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly issues: readonly HostRuntimeArtifactIssue[] }
> {
  const direct = join(root, HOST_RUNTIME_MANIFEST_FILE);
  try {
    const stat = await lstat(direct);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      return { ok: true, path: direct };
    }
  } catch {
    // Fall through to the single-file layout.
  }
  const candidates: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith(".runtime")) {
        continue;
      }
      const candidate = join(root, entry.name, HOST_RUNTIME_MANIFEST_FILE);
      try {
        const stat = await lstat(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          candidates.push(candidate);
        }
      } catch {
        // no manifest in this runtime directory
      }
    }
  } catch (error) {
    return {
      ok: false,
      issues: [issue("artifact_root_unreadable", root, error instanceof Error ? error.message : String(error))]
    };
  }
  if (candidates.length === 0) {
    return { ok: false, issues: [issue("manifest_missing", root, "manifest.json")] };
  }
  if (candidates.length > 1) {
    return { ok: false, issues: [issue("manifest_ambiguous", root, "single_manifest")] };
  }
  const path = candidates[0];
  if (path === undefined) {
    return { ok: false, issues: [issue("manifest_missing", root, "manifest.json")] };
  }
  return { ok: true, path };
}

function issueListFromUnknown(error: unknown): readonly HostRuntimeArtifactIssue[] {
  return [issue("manifest_unreadable", HOST_RUNTIME_MANIFEST_FILE, error instanceof Error ? error.message : String(error))];
}

/**
 * Load-time verification (DD-HOST-200.1): reads `manifest.json`, recomputes
 * every listed file hash and mode, rejects unlisted or linked files, and
 * returns `load_verified_hash`. Any mismatch fails closed: the entry must not
 * connect to IPC.
 */
export async function verifyArtifactAtLoad(root: string): Promise<HostRuntimeArtifactVerification> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    return { ok: false, issues: issueListFromUnknown(error) };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { ok: false, issues: [issue("root_not_directory", root, "directory")] };
  }
  const manifestLocation = await locateManifest(root);
  if (!manifestLocation.ok) {
    return { ok: false, issues: manifestLocation.issues };
  }
  const manifestStat = await lstat(manifestLocation.path);
  if (manifestStat.nlink > 1) {
    return { ok: false, issues: [issue("hard_link", HOST_RUNTIME_MANIFEST_FILE, "nlink_1")] };
  }
  let parsed: unknown;
  try {
    const text = await readFile(manifestLocation.path, "utf8");
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, issues: issueListFromUnknown(error) };
  }
  const manifestIssues = validateHostRuntimeArtifactManifest(parsed);
  if (manifestIssues.length > 0) {
    return { ok: false, issues: manifestIssues };
  }
  const manifest = parsed as HostRuntimeArtifactManifest;
  const rootResolved = resolve(root);

  for (const file of manifest.files) {
    const pathIssue = validateArtifactRelativePath(file.path);
    if (pathIssue !== null) {
      return { ok: false, issues: [pathIssue] };
    }
    const absolute = resolve(root, ...file.path.split("/"));
    if (absolute !== rootResolved && !absolute.startsWith(rootResolved + sep)) {
      return { ok: false, issues: [issue("path_escape", file.path, "inside_artifact_root")] };
    }
    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      return { ok: false, issues: [issue("file_missing", file.path, "listed_file_exists")] };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, issues: [issue("symlink", file.path, "regular_file")] };
    }
    if (!stat.isFile()) {
      return { ok: false, issues: [issue("not_regular_file", file.path, "regular_file")] };
    }
    if (stat.nlink > 1) {
      return { ok: false, issues: [issue("hard_link", file.path, "nlink_1")] };
    }
    const actualMode = modeOf(stat);
    if (actualMode !== file.mode) {
      return {
        ok: false,
        issues: [issue("mode_mismatch", file.path, `expected_${String(file.mode)}_actual_${String(actualMode)}`)]
      };
    }
    let actualHash: Hash;
    try {
      actualHash = await sha256File(absolute);
    } catch (error) {
      return { ok: false, issues: issueListFromUnknown(error) };
    }
    if (actualHash !== file.sha256) {
      return { ok: false, issues: [issue("hash_mismatch", file.path, "sha256")] };
    }
  }

  const collected = await collectArtifactFiles(root);
  if (collected.issues.length > 0) {
    return { ok: false, issues: collected.issues };
  }
  // Appendix K.1: an adopted skill is written below the Claude plugin's own
  // `skills/` directory. That directory is managed output, not part of the
  // immutable runtime artifact, so it must not invalidate the manifest check
  // on the next host launch.
  const artifactFiles = collected.files.filter(
    (file) => !file.path.startsWith("skills/")
  );
  const declared = new Set(manifest.files.map((file) => file.path));
  for (const file of artifactFiles) {
    if (!declared.has(file.path)) {
      return { ok: false, issues: [issue("unlisted_file", file.path, "manifest_covers_all_files")] };
    }
  }
  if (artifactFiles.length !== manifest.files.length) {
    return {
      ok: false,
      issues: [issue("file_count_mismatch", root, `${String(artifactFiles.length)}_vs_${String(manifest.files.length)}`)]
    };
  }

  const artifactHash = computeArtifactHash(manifest);
  return {
    ok: true,
    value: {
      artifact_root: rootResolved,
      manifest_path: manifestLocation.path,
      manifest,
      artifact_hash: artifactHash,
      load_verified_hash: artifactHash
    }
  };
}
