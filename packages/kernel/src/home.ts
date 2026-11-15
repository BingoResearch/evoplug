/**
 * Product home layout, initialization and compatibility checks
 * (DD-FND-025, DD-FND-100).
 *
 * Initialization order is fixed: parse and validate the home, refuse a symlink
 * or foreign directory, create the 0700 tree, atomically write `config.json`,
 * let the storage port create the database and activate `config_profile`, then
 * write `init.complete.json`. A missing marker resumes from the config step;
 * an existing marker is only accepted when root, schema major and
 * `config_version` all match.
 */

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { isHash } from "@evoplug/core";
import {
  IPC_FILE_MODE,
  ensureRuntimeDir,
  rotateIpcToken,
  runtimePaths
} from "@evoplug/ipc";
import type { EvoplugConfig } from "./config.js";
import {
  canonicalConfigJson,
  computeConfigContentHash,
  computeConfigVersion,
  isConfigVersion,
  parseConfigText
} from "./config.js";
import { fieldError, kernelError, versionError } from "./errors.js";
import { isRecord } from "./guards.js";

export const EVOPLUG_HOME_ENV = "EVOPLUG_HOME";
export const DEFAULT_HOME_DIR_NAME = ".evoplug";
export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_TEMP_SUFFIX = ".tmp";
export const CONFIG_LOCK_FILE_NAME = "config.lock";
export const INIT_COMPLETE_FILE_NAME = "init.complete.json";
export const HOME_DIR_MODE = 0o700;
export const HOME_FILE_MODE = 0o600;

/** Required subdirectories, all 0700 (DD-FND-025). */
export const HOME_LAYOUT_DIRS: readonly string[] = [
  "db",
  "journal",
  "blobs",
  "runtime",
  "quarantine",
  "backups",
  "logs"
];

export interface HomeLayout {
  readonly home: string;
  readonly config_path: string;
  readonly config_lock_path: string;
  readonly init_complete_path: string;
  readonly db_dir: string;
  readonly db_path: string;
  readonly journal_dir: string;
  readonly blobs_dir: string;
  readonly runtime_dir: string;
  readonly quarantine_dir: string;
  readonly backups_dir: string;
  readonly logs_dir: string;
}

export function homeLayout(home: string): HomeLayout {
  return {
    home,
    config_path: join(home, CONFIG_FILE_NAME),
    config_lock_path: join(home, CONFIG_LOCK_FILE_NAME),
    init_complete_path: join(home, INIT_COMPLETE_FILE_NAME),
    db_dir: join(home, "db"),
    db_path: join(home, "db", "evoplug.sqlite"),
    journal_dir: join(home, "journal"),
    blobs_dir: join(home, "blobs"),
    runtime_dir: join(home, "runtime"),
    quarantine_dir: join(home, "quarantine"),
    backups_dir: join(home, "backups"),
    logs_dir: join(home, "logs")
  };
}

/** Fields carried by the atomic completion marker (DD-FND-100 step 5). */
export interface InitCompleteMarker {
  readonly root: string;
  readonly product_version: string;
  readonly schema_major: number;
  readonly config_version: string;
  readonly db_hash_marker: Hash | null;
  readonly created_at: number;
}

export interface ResolveHomeOptions {
  readonly explicit?: string | undefined;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly home_directory?: string;
}

/**
 * `--home` wins, then `EVOPLUG_HOME`, then `~/.evoplug`. A relative path is a
 * schema error, never silently resolved against the cwd.
 */
export function resolveEvoplugHome(options?: ResolveHomeOptions): Result<string, ErrorEnvelope> {
  const explicit = options?.explicit;
  const env = options?.env ?? process.env;
  const fromEnv = env[EVOPLUG_HOME_ENV];
  const candidate = explicit !== undefined && explicit.length > 0 ? explicit : fromEnv;
  const chosen = candidate !== undefined && candidate.length > 0
    ? candidate
    : join(options?.home_directory ?? homedir(), DEFAULT_HOME_DIR_NAME);
  if (!isAbsolute(chosen)) {
    return { ok: false, status: "rejected", error: fieldError("home", "must_be_absolute") };
  }
  return { ok: true, status: "ok", value: chosen };
}

function errorEnvelope(code: string, path: string, rule: string): ErrorEnvelope {
  return kernelError(code, { details: { kind: "field", path, rule } });
}

export interface HomeDirectoryView {
  readonly path: string;
  readonly exists: boolean;
  readonly is_directory: boolean;
  readonly is_symlink: boolean;
  readonly mode: number;
}

/** `lstat` view that never follows a symlink. */
export async function inspectDirectory(path: string): Promise<HomeDirectoryView> {
  try {
    const stats = await lstat(path);
    return {
      path,
      exists: true,
      is_directory: stats.isDirectory(),
      is_symlink: stats.isSymbolicLink(),
      mode: stats.mode & 0o777
    };
  } catch {
    return { path, exists: false, is_directory: false, is_symlink: false, mode: 0 };
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileDurable(path: string, data: string, mode: number): Promise<void> {
  const handle = await open(path, "w", mode);
  try {
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

/**
 * Atomic replace: `<path>.tmp` at 0600, fsync, rename, fsync the parent. On any
 * failure the temporary file is removed and the previous file is untouched.
 */
export async function writeFileAtomicDurable(path: string, data: string): Promise<Result<void, ErrorEnvelope>> {
  const temporary = `${path}${CONFIG_TEMP_SUFFIX}`;
  try {
    await writeFileDurable(temporary, data, HOME_FILE_MODE);
    await rename(temporary, path);
    await chmod(path, HOME_FILE_MODE);
    await syncDirectory(join(path, ".."));
    return { ok: true, status: "ok", value: undefined };
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // the temporary file may never have been created
    }
    return { ok: false, status: "rejected", error: errorEnvelope("E_IO", path, "write_failed") };
  }
}

export async function readConfigFile(home: string): Promise<Result<EvoplugConfig, ErrorEnvelope>> {
  let text: string;
  try {
    text = await readFile(homeLayout(home).config_path, "utf8");
  } catch {
    return { ok: false, status: "rejected", error: errorEnvelope("E_HOME_INCOMPATIBLE", CONFIG_FILE_NAME, "missing") };
  }
  return parseConfigText(text);
}

/** Returns `null` when no completion marker exists yet. */
export async function readInitCompleteMarker(
  home: string
): Promise<Result<InitCompleteMarker | null, ErrorEnvelope>> {
  let text: string;
  try {
    text = await readFile(homeLayout(home).init_complete_path, "utf8");
  } catch {
    return { ok: true, status: "ok", value: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", INIT_COMPLETE_FILE_NAME, "invalid_json")
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", INIT_COMPLETE_FILE_NAME, "must_be_object")
    };
  }
  const record = parsed;
  const root = record["root"];
  const productVersion = record["product_version"];
  const schemaMajor = record["schema_major"];
  const configVersion = record["config_version"];
  const dbHashMarker = record["db_hash_marker"];
  const createdAt = record["created_at"];
  if (typeof root !== "string" || !isAbsolute(root)) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", `${INIT_COMPLETE_FILE_NAME}.root`, "invalid")
    };
  }
  if (typeof productVersion !== "string" || productVersion.length === 0) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", `${INIT_COMPLETE_FILE_NAME}.product_version`, "invalid")
    };
  }
  if (typeof schemaMajor !== "number" || !Number.isSafeInteger(schemaMajor) || schemaMajor < 1) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", `${INIT_COMPLETE_FILE_NAME}.schema_major`, "invalid")
    };
  }
  if (typeof configVersion !== "string" || !isConfigVersion(configVersion)) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", `${INIT_COMPLETE_FILE_NAME}.config_version`, "invalid")
    };
  }
  if (dbHashMarker !== null && (typeof dbHashMarker !== "string" || !isHash(dbHashMarker))) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", `${INIT_COMPLETE_FILE_NAME}.db_hash_marker`, "invalid")
    };
  }
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", `${INIT_COMPLETE_FILE_NAME}.created_at`, "invalid")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      root,
      product_version: productVersion,
      schema_major: schemaMajor,
      config_version: configVersion,
      db_hash_marker: dbHashMarker,
      created_at: createdAt
    }
  };
}

async function createLayoutDirectories(home: string): Promise<Result<HomeLayout, ErrorEnvelope>> {
  try {
    await mkdir(home, { recursive: true, mode: HOME_DIR_MODE });
    await chmod(home, HOME_DIR_MODE);
  } catch {
    return { ok: false, status: "rejected", error: errorEnvelope("E_IO", home, "mkdir_failed") };
  }
  for (const name of HOME_LAYOUT_DIRS) {
    const path = join(home, name);
    try {
      await mkdir(path, { recursive: true, mode: HOME_DIR_MODE });
      await chmod(path, HOME_DIR_MODE);
    } catch {
      return { ok: false, status: "rejected", error: errorEnvelope("E_IO", name, "mkdir_failed") };
    }
    const view = await inspectDirectory(path);
    if (view.is_symlink || !view.is_directory) {
      return { ok: false, status: "rejected", error: errorEnvelope("E_HOME_INCOMPATIBLE", name, "not_a_directory") };
    }
  }
  const runtime = await ensureRuntimeDir(homeLayout(home).runtime_dir);
  if (!runtime.ok) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_IO", "runtime", "mkdir_failed")
    };
  }
  return { ok: true, status: "ok", value: homeLayout(home) };
}

/**
 * A pre-existing home is only adopted when it is empty or already carries this
 * product's marker files. No user directory is taken over.
 */
async function inspectExistingRoot(home: string): Promise<Result<"absent" | "empty" | "product", ErrorEnvelope>> {
  const view = await inspectDirectory(home);
  if (!view.exists) {
    return { ok: true, status: "ok", value: "absent" };
  }
  if (view.is_symlink) {
    return { ok: false, status: "rejected", error: errorEnvelope("E_HOME_INCOMPATIBLE", home, "symlink_root") };
  }
  if (!view.is_directory) {
    return { ok: false, status: "rejected", error: errorEnvelope("E_HOME_INCOMPATIBLE", home, "not_a_directory") };
  }
  const marker = await readInitCompleteMarker(home);
  if (!marker.ok) {
    return marker;
  }
  if (marker.value !== null) {
    return { ok: true, status: "ok", value: "product" };
  }
  try {
    await readFile(homeLayout(home).config_path, "utf8");
    return { ok: true, status: "ok", value: "product" };
  } catch {
    // fall through to the empty check
  }
  let entries: readonly string[];
  try {
    entries = await readdir(home);
  } catch {
    return { ok: false, status: "rejected", error: errorEnvelope("E_IO", home, "readdir_failed") };
  }
  if (entries.length > 0) {
    return { ok: false, status: "rejected", error: errorEnvelope("E_HOME_INCOMPATIBLE", home, "foreign_directory") };
  }
  return { ok: true, status: "ok", value: "empty" };
}

/**
 * Database half of initialization. The storage owner creates the database,
 * runs migrations, sets the db hash marker and activates `config_profile`
 * inside one `BEGIN IMMEDIATE` transaction (DD-FND-100 step 4).
 */
export interface HomeDatabasePort {
  prepareDatabase(input: {
    readonly home: string;
    readonly layout: HomeLayout;
    readonly config: EvoplugConfig;
    readonly config_version: string;
    readonly config_hash: Hash;
    readonly schema_major: number;
    readonly now: number;
  }): Promise<Result<{ readonly db_hash_marker: Hash | null }, ErrorEnvelope>>;
}

export interface InitializeHomeOptions {
  readonly home: string;
  readonly config: EvoplugConfig;
  readonly product_version: string;
  readonly schema_major: number;
  readonly database: HomeDatabasePort;
  readonly now?: () => number;
}

export type InitializeHomeStatus = "created" | "no_op" | "resumed";

export interface InitializeHomeResult {
  readonly status: InitializeHomeStatus;
  readonly layout: HomeLayout;
  readonly config: EvoplugConfig;
  readonly config_version: string;
  readonly config_hash: Hash;
  readonly marker: InitCompleteMarker;
}

/**
 * Runs the five initialization steps. `no_op` means the marker, root, schema
 * major and config version all match; nothing is overwritten.
 */
export async function initializeHome(
  options: InitializeHomeOptions
): Promise<Result<InitializeHomeResult, ErrorEnvelope>> {
  const now = options.now ?? ((): number => Date.now());
  const home = options.home;
  const config = options.config;
  const configVersion = computeConfigVersion(config);
  const configHash = computeConfigContentHash(config);

  const existing = await inspectExistingRoot(home);
  if (!existing.ok) {
    return existing;
  }
  if (config.product_home !== home) {
    return {
      ok: false,
      status: "rejected",
      error: versionError(home, config.product_home, "E_HOME_INCOMPATIBLE")
    };
  }

  const layoutResult = await createLayoutDirectories(home);
  if (!layoutResult.ok) {
    return layoutResult;
  }
  const layout = layoutResult.value;

  const existingMarker = await readInitCompleteMarker(home);
  if (!existingMarker.ok) {
    return existingMarker;
  }
  if (existingMarker.value !== null) {
    const marker = existingMarker.value;
    if (marker.root !== home) {
      return { ok: false, status: "rejected", error: versionError(home, marker.root, "E_HOME_INCOMPATIBLE") };
    }
    if (marker.schema_major !== options.schema_major) {
      return {
        ok: false,
        status: "rejected",
        error: versionError(String(options.schema_major), String(marker.schema_major), "E_HOME_INCOMPATIBLE")
      };
    }
    if (marker.config_version !== configVersion) {
      return {
        ok: false,
        status: "rejected",
        error: versionError(configVersion, marker.config_version, "E_HOME_INCOMPATIBLE")
      };
    }
    return {
      ok: true,
      status: "ok",
      value: {
        status: "no_op",
        layout,
        config,
        config_version: configVersion,
        config_hash: configHash,
        marker
      }
    };
  }

  const configText = canonicalConfigJson(config);
  const written = await writeFileAtomicDurable(layout.config_path, configText);
  if (!written.ok) {
    return written;
  }

  const token = await ensureInitToken(home);
  if (!token.ok) {
    return token;
  }

  const timestamp = now();
  const prepared = await options.database.prepareDatabase({
    home,
    layout,
    config,
    config_version: configVersion,
    config_hash: configHash,
    schema_major: options.schema_major,
    now: timestamp
  });
  if (!prepared.ok) {
    return prepared;
  }

  const marker: InitCompleteMarker = {
    root: home,
    product_version: options.product_version,
    schema_major: options.schema_major,
    config_version: configVersion,
    db_hash_marker: prepared.value.db_hash_marker,
    created_at: timestamp
  };
  const markerWritten = await writeFileAtomicDurable(
    layout.init_complete_path,
    `${JSON.stringify(marker)}\n`
  );
  if (!markerWritten.ok) {
    return markerWritten;
  }

  return {
    ok: true,
    status: "ok",
    value: {
      status: existing.value === "product" ? "resumed" : "created",
      layout,
      config,
      config_version: configVersion,
      config_hash: configHash,
      marker
    }
  };
}

async function ensureInitToken(home: string): Promise<Result<string, ErrorEnvelope>> {
  const runtime = await ensureRuntimeDir(homeLayout(home).runtime_dir);
  if (!runtime.ok) {
    return { ok: false, status: "rejected", error: errorEnvelope("E_IO", "runtime", "mkdir_failed") };
  }
  const rotated = await rotateIpcToken(runtimePaths(home).token_path);
  if (!rotated.ok) {
    return { ok: false, status: "rejected", error: errorEnvelope("E_IO", "ipc.token", rotated.reason) };
  }
  return { ok: true, status: "ok", value: rotated.value };
}

export interface HomeCompatibilityOptions {
  readonly home: string;
  readonly config: EvoplugConfig;
  readonly supported_schema_major: number;
}

export interface HomeCompatibility {
  readonly marker: InitCompleteMarker;
  readonly config_version: string;
  readonly config_hash: Hash;
}

/**
 * Startup gate: an uninitialized or foreign home is `E_HOME_INCOMPATIBLE`, a
 * newer schema major is `E_SCHEMA_MAJOR_UNSUPPORTED`, and a config whose
 * canonical bytes no longer match the marker is incompatible.
 */
export async function verifyHomeCompatibility(
  options: HomeCompatibilityOptions
): Promise<Result<HomeCompatibility, ErrorEnvelope>> {
  const marker = await readInitCompleteMarker(options.home);
  if (!marker.ok) {
    return marker;
  }
  if (marker.value === null) {
    return {
      ok: false,
      status: "rejected",
      error: errorEnvelope("E_HOME_INCOMPATIBLE", INIT_COMPLETE_FILE_NAME, "missing")
    };
  }
  if (marker.value.schema_major > options.supported_schema_major) {
    return {
      ok: false,
      status: "rejected",
      error: versionError(
        String(options.supported_schema_major),
        String(marker.value.schema_major),
        "E_SCHEMA_MAJOR_UNSUPPORTED"
      )
    };
  }
  const configVersion = computeConfigVersion(options.config);
  if (configVersion !== marker.value.config_version) {
    return {
      ok: false,
      status: "rejected",
      error: versionError(configVersion, marker.value.config_version, "E_HOME_INCOMPATIBLE")
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      marker: marker.value,
      config_version: configVersion,
      config_hash: computeConfigContentHash(options.config)
    }
  };
}

export interface HomePathProbe {
  readonly path: string;
  readonly kind: "missing" | "file" | "directory" | "socket" | "symlink" | "other";
  readonly mode: number;
  readonly ok: boolean;
}

/** Read-only permission probe used by `evolve doctor`; never mutates. */
export async function probeHomePath(path: string, expected: "file" | "directory" | "socket"): Promise<HomePathProbe> {
  try {
    const stats = await lstat(path);
    const mode = stats.mode & 0o777;
    if (stats.isSymbolicLink()) {
      return { path, kind: "symlink", mode, ok: false };
    }
    if (stats.isDirectory()) {
      return { path, kind: "directory", mode, ok: expected === "directory" && mode === HOME_DIR_MODE };
    }
    if (stats.isSocket()) {
      return { path, kind: "socket", mode, ok: expected === "socket" && mode === IPC_FILE_MODE };
    }
    if (stats.isFile()) {
      return { path, kind: "file", mode, ok: expected === "file" && mode === IPC_FILE_MODE };
    }
    return { path, kind: "other", mode, ok: false };
  } catch {
    return { path, kind: "missing", mode: 0, ok: false };
  }
}
