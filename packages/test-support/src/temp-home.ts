/**
 * Isolated `EVOPLUG_HOME` for tests (DD-FND-025).
 *
 * The helper creates the documented directory tree under a fresh system temp
 * directory. It deliberately does not write `init.complete.json`: tests that
 * exercise initialization must be able to observe a partially created home.
 * A caller may opt into a starter `config.json` with `options.config`.
 *
 * Cleanup is explicit and idempotent. Nothing in this module mutates
 * `process.env`; callers pass `home.environment` to child processes instead,
 * so parallel test files cannot race on global environment state.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHash, type Hash, type JsonValue } from "@evoplug/core";

export interface TempHomeOptions {
  /** Directory-name prefix passed to `mkdtemp`. */
  readonly prefix?: string;
  /** Parent directory; defaults to `os.tmpdir()`. */
  readonly parentDir?: string;
  /** Optional starter config written with mode 0600. */
  readonly config?: JsonValue;
}

export interface TempHomeEnvironment {
  readonly HOME: string;
  readonly EVOPLUG_HOME: string;
}

export interface TempHomePaths {
  readonly root: string;
  readonly configFile: string;
  readonly configLockFile: string;
  readonly initCompleteFile: string;
  readonly dbDir: string;
  readonly dbFile: string;
  readonly journalDir: string;
  readonly blobsDir: string;
  readonly blobSha256Dir: string;
  readonly runtimeDir: string;
  readonly kernelLockFile: string;
  readonly kernelSockFile: string;
  readonly ipcTokenFile: string;
  readonly endpointFile: string;
  readonly quarantineDir: string;
  readonly backupsDir: string;
  readonly logsDir: string;
  /** Environment values for spawning a child process against this home. */
  readonly environment: TempHomeEnvironment;
}

export interface TempHome extends TempHomePaths {
  /** Writes a JSON config with mode 0600, replacing any existing file. */
  writeConfig(config: JsonValue): void;
  /** `<journalDir>/<journalId>.rsij`, rejecting path traversal. */
  journalFile(journalId: string): string;
  /** `<blobSha256Dir>/<64 hex>`, rejecting non-canonical hashes. */
  blobFile(hash: Hash): string;
  /** Removes the tree. Safe to call more than once. */
  cleanup(): void;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function assertSafeJournalId(journalId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(journalId)) {
    throw new RangeError(`journalId must be a safe file-name component, received ${JSON.stringify(journalId)}`);
  }
}

/**
 * Creates an isolated home tree:
 *
 * ```text
 * <root>/
 *   config.json              (optional, 0600)
 *   db/
 *   journal/
 *   blobs/sha256/
 *   runtime/
 *   quarantine/
 *   backups/
 *   logs/
 * ```
 *
 * All directories are mode 0700. `db/evoplug.sqlite` is a path only; SQLite is
 * created by the storage layer under test, not by this helper.
 */
export function createTempHome(options: TempHomeOptions = {}): TempHome {
  const parentDir = options.parentDir ?? tmpdir();
  const prefix = options.prefix ?? "evoplug-test-";
  const root = mkdtempSync(join(parentDir, prefix));
  chmodSync(root, 0o700);

  const dbDir = join(root, "db");
  const journalDir = join(root, "journal");
  const blobsDir = join(root, "blobs");
  const blobSha256Dir = join(blobsDir, "sha256");
  const runtimeDir = join(root, "runtime");
  const quarantineDir = join(root, "quarantine");
  const backupsDir = join(root, "backups");
  const logsDir = join(root, "logs");

  for (const directory of [
    dbDir,
    journalDir,
    blobsDir,
    blobSha256Dir,
    runtimeDir,
    quarantineDir,
    backupsDir,
    logsDir
  ]) {
    ensurePrivateDirectory(directory);
  }

  const configFile = join(root, "config.json");
  const paths: TempHomePaths = {
    root,
    configFile,
    configLockFile: join(root, "config.lock"),
    initCompleteFile: join(root, "init.complete.json"),
    dbDir,
    dbFile: join(dbDir, "evoplug.sqlite"),
    journalDir,
    blobsDir,
    blobSha256Dir,
    runtimeDir,
    kernelLockFile: join(runtimeDir, "kernel.lock"),
    kernelSockFile: join(runtimeDir, "kernel.sock"),
    ipcTokenFile: join(runtimeDir, "ipc.token"),
    endpointFile: join(runtimeDir, "endpoint.json"),
    quarantineDir,
    backupsDir,
    logsDir,
    environment: Object.freeze({
      HOME: root,
      EVOPLUG_HOME: root
    })
  };

  let cleaned = false;

  const writeConfig = (config: JsonValue): void => {
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configFile, 0o600);
  };

  if (options.config !== undefined) {
    writeConfig(options.config);
  }

  return {
    ...paths,
    writeConfig,
    journalFile(journalId: string): string {
      assertSafeJournalId(journalId);
      return join(journalDir, `${journalId}.rsij`);
    },
    blobFile(hash: Hash): string {
      if (!isHash(hash)) {
        throw new TypeError(`hash must be a canonical sha256 hash, received ${JSON.stringify(hash)}`);
      }
      return join(blobSha256Dir, hash.slice("sha256:".length));
    },
    cleanup(): void {
      if (cleaned) {
        return;
      }
      cleaned = true;
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  };
}

/**
 * Runs `fn` with a fresh home and always cleans it up. The callback may be
 * synchronous or asynchronous.
 */
export async function withTempHome<T>(
  fn: (home: TempHome) => T | Promise<T>,
  options: TempHomeOptions = {}
): Promise<T> {
  const home = createTempHome(options);
  try {
    return await fn(home);
  } finally {
    home.cleanup();
  }
}
