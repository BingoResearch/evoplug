/**
 * Single-writer process lock (DD-FND-024 step 1).
 *
 * `<EVOPLUG_HOME>/runtime/kernel.lock` holds `{pid, process_start_token,
 * boot_id, started_at}`. A private record is fsynced and published with an
 * exclusive hard link. A record whose pid is gone (or whose start token differs
 * from the live process with that pid) is reclaimed under a separate lock;
 * a live record rejects the new process with `E_CONFLICT`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { type ErrorEnvelope, type Result, isRecord } from "@evoplug/core";
import { kernelError } from "./errors.js";

const KERNEL_LOCK_FILE_NAME = "kernel.lock";
const KERNEL_LOCK_FILE_MODE = 0o600;

interface WriterLockRecord {
  readonly pid: number;
  readonly process_start_token: string;
  readonly boot_id: string;
  readonly started_at: number;
}

export interface WriterLock {
  readonly record: WriterLockRecord;
  readonly path: string;
  release(): Promise<void>;
}

export function kernelLockPath(home: string): string {
  return join(home, "runtime", KERNEL_LOCK_FILE_NAME);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
    return code !== "ESRCH";
  }
}

/**
 * Best-effort process start token. Linux reads field 22 of `/proc/<pid>/stat`;
 * macOS uses `ps -o lstart=`. An empty string means "unknown", in which case a
 * live pid alone is treated as the lock holder.
 */
function readProcessStartToken(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return "";
  }
  if (process.platform === "linux") {
    try {
      const stat = execFileSync("cat", [`/proc/${String(pid)}/stat`], { encoding: "utf8", timeout: 1000 });
      const close = stat.lastIndexOf(")");
      if (close < 0) {
        return "";
      }
      const fields = stat.slice(close + 2).split(" ");
      return fields[19] ?? "";
    } catch {
      return "";
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
    return out.trim();
  } catch {
    return "";
  }
}

function parseRecord(text: string): WriterLockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const record = parsed;
  const pid = record["pid"];
  const token = record["process_start_token"];
  const bootId = record["boot_id"];
  const startedAt = record["started_at"];
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (typeof token !== "string" || typeof bootId !== "string") {
    return null;
  }
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0) {
    return null;
  }
  return { pid, process_start_token: token, boot_id: bootId, started_at: startedAt };
}

export async function readWriterLock(path: string): Promise<WriterLockRecord | null> {
  try {
    return parseRecord(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** True when the recorded process is still the same process. */
function isLockHolderLive(record: WriterLockRecord): boolean {
  if (!isProcessAlive(record.pid)) {
    return false;
  }
  if (record.process_start_token.length === 0) {
    return true;
  }
  const current = readProcessStartToken(record.pid);
  if (current.length === 0) {
    return true;
  }
  return current === record.process_start_token;
}

type AcquireRead =
  | { readonly kind: "missing" }
  | { readonly kind: "record"; readonly record: WriterLockRecord }
  | { readonly kind: "invalid" };

async function readForAcquire(path: string): Promise<AcquireRead> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      const code = typeof error === "object" && error !== null
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code === "ENOENT") {
        return { kind: "missing" };
      }
      if (attempt === 7) {
        return { kind: "invalid" };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      continue;
    }
    const record = parseRecord(text);
    if (record !== null) {
      return { kind: "record", record };
    }
    if (attempt < 7) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  return { kind: "invalid" };
}

async function tryCreate(
  path: string,
  record: WriterLockRecord
): Promise<Result<WriterLock, ErrorEnvelope>> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", KERNEL_LOCK_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link publishes a complete record without replacing an existing name.
    await link(temporary, path);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined;
    if (code === "EEXIST") {
      return { ok: false, status: "conflict", error: kernelError("E_CONFLICT", {
        details: { kind: "field", path: "kernel.lock", rule: "already_held" }
      }) };
    }
    return {
      ok: false,
      status: "rejected",
      error: kernelError("E_IO", { details: { kind: "field", path: "kernel.lock", rule: "open_failed" } })
    };
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return {
    ok: true,
    status: "ok",
    value: {
      record,
      path,
      release: async (): Promise<void> => {
        const current = await readWriterLock(path);
        if (current === null) {
          return;
        }
        if (
          current.pid === record.pid &&
          current.process_start_token === record.process_start_token &&
          current.boot_id === record.boot_id
        ) {
          try {
            await unlink(path);
          } catch {
            // already removed
          }
        }
      }
    }
  };
}

interface AcquireWriterLockOptions {
  readonly home: string;
  readonly boot_id: string;
  readonly now?: () => number;
}

/** Acquires the single-writer lock, replacing one stale record at most. */
export async function acquireWriterLock(
  options: AcquireWriterLockOptions
): Promise<Result<WriterLock, ErrorEnvelope>> {
  const path = kernelLockPath(options.home);
  const record: WriterLockRecord = {
    pid: process.pid,
    process_start_token: readProcessStartToken(process.pid),
    boot_id: options.boot_id,
    started_at: (options.now ?? ((): number => Date.now()))()
  };
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return {
      ok: false,
      status: "rejected",
      error: kernelError("E_IO", { details: { kind: "field", path: "runtime", rule: "mkdir_failed" } })
    };
  }

  return acquireAt(path, record, 0);
}

async function acquireAt(
  path: string,
  record: WriterLockRecord,
  depth: number
): Promise<Result<WriterLock, ErrorEnvelope>> {
  const first = await tryCreate(path, record);
  if (first.ok) {
    return first;
  }
  if (first.status !== "conflict") {
    return first;
  }

  // An unreadable or incomplete record is not evidence that its owner died.
  const existing = await readForAcquire(path);
  if (existing.kind === "missing") {
    return tryCreate(path, record);
  }
  if (existing.kind !== "record" || isLockHolderLive(existing.record) || depth >= 8) {
    return first;
  }

  // Serialize reclamation so two observers of one stale record cannot
  // remove each other's replacement. A crashed reclaimer is reclaimed by
  // the same protocol, with a bounded nesting depth.
  const reclaim = await acquireAt(`${path}.reclaim`, record, depth + 1);
  if (!reclaim.ok) {
    return first;
  }
  let second: Result<WriterLock, ErrorEnvelope>;
  try {
    const current = await readForAcquire(path);
    if (current.kind === "invalid" ||
        (current.kind === "record" && isLockHolderLive(current.record))) {
      return first;
    }
    if (current.kind === "record") {
      try {
        await unlink(path);
      } catch {
        return first;
      }
    }
    second = await tryCreate(path, record);
  } finally {
    await reclaim.value.release();
  }
  if (!second.ok) {
    return second.status === "conflict"
      ? {
          ok: false,
          status: "conflict",
          error: kernelError("E_CONFLICT", {
            details: { kind: "field", path: "kernel.lock", rule: "already_held" }
          })
        }
      : second;
  }
  return second;
}
