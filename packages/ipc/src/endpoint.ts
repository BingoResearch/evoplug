/**
 * Runtime endpoint layout and token handling (DD-FND-040).
 *
 * Fixed tree under `<EVOPLUG_HOME>/runtime/`:
 *
 *   kernel.sock     Unix domain socket, mode 0600, parent directory 0700
 *   ipc.token       32 random bytes, base64url, mode 0600, rotated on every boot
 *   endpoint.json   {protocol_version, socket_path, token_path, boot_id, pid, started_at}, 0600
 *
 * The token never enters logs, errors, SQLite, the journal, CLI output or
 * adapter configuration. Isolation is the filesystem same-user boundary:
 * Node's `net` exposes no peer-UID API, so this cannot resist a malicious
 * process running as the same user with HOME read access.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const IPC_RUNTIME_DIR_NAME = "runtime";
const IPC_SOCKET_FILE_NAME = "kernel.sock";
const IPC_TOKEN_FILE_NAME = "ipc.token";
const IPC_ENDPOINT_FILE_NAME = "endpoint.json";

const IPC_DIR_MODE = 0o700;
export const IPC_FILE_MODE = 0o600;
const IPC_TOKEN_BYTES = 32;

const IPC_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

export interface RuntimePaths {
  readonly home: string;
  readonly runtime_dir: string;
  readonly socket_path: string;
  readonly token_path: string;
  readonly endpoint_path: string;
}

export function runtimePaths(evoplugHome: string): RuntimePaths {
  const runtimeDir = join(evoplugHome, IPC_RUNTIME_DIR_NAME);
  return {
    home: evoplugHome,
    runtime_dir: runtimeDir,
    socket_path: join(runtimeDir, IPC_SOCKET_FILE_NAME),
    token_path: join(runtimeDir, IPC_TOKEN_FILE_NAME),
    endpoint_path: join(runtimeDir, IPC_ENDPOINT_FILE_NAME),
  };
}

export interface EndpointDescriptor {
  readonly protocol_version: string;
  readonly socket_path: string;
  readonly token_path: string;
  readonly boot_id: string;
  readonly pid: number;
  readonly started_at: number;
}

type EndpointIoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** 32 CSPRNG bytes, unpadded base64url (43 characters). */
function generateIpcToken(): string {
  return randomBytes(IPC_TOKEN_BYTES).toString("base64url");
}

function isValidIpcToken(value: string): boolean {
  return IPC_TOKEN_PATTERN.test(value);
}

/**
 * Constant-time comparison. Both inputs are hashed first so the comparison takes
 * the same time regardless of the presented length.
 */
export function tokensEqual(expected: string, presented: string): boolean {
  if (expected.length === 0) {
    return false;
  }
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(left, right);
}

export async function ensureRuntimeDir(directory: string): Promise<EndpointIoResult<string>> {
  try {
    await mkdir(directory, { recursive: true, mode: IPC_DIR_MODE });
    await chmod(directory, IPC_DIR_MODE);
    return { ok: true, value: directory };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function writeFileAtomic(path: string, data: string): Promise<EndpointIoResult<string>> {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode: IPC_FILE_MODE });
    await chmod(temporary, IPC_FILE_MODE);
    await rename(temporary, path);
    await chmod(path, IPC_FILE_MODE);
    return { ok: true, value: path };
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // best effort: the temporary file may never have been created
    }
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Writes a fresh token with mode 0600, replacing any previous token. */
async function writeIpcToken(path: string, token: string): Promise<EndpointIoResult<string>> {
  if (!isValidIpcToken(token)) {
    return { ok: false, reason: "token_format_invalid" };
  }
  return writeFileAtomic(path, token);
}

/** Rotates the token: a new value is generated and persisted on each boot. */
export async function rotateIpcToken(path: string): Promise<EndpointIoResult<string>> {
  const token = generateIpcToken();
  const written = await writeIpcToken(path, token);
  return written.ok ? { ok: true, value: token } : written;
}

export async function readIpcToken(path: string): Promise<EndpointIoResult<string>> {
  try {
    const raw = await readFile(path, "utf8");
    const token = raw.trim();
    if (!isValidIpcToken(token)) {
      return { ok: false, reason: "token_format_invalid" };
    }
    return { ok: true, value: token };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export async function writeEndpointDescriptor(
  path: string,
  descriptor: EndpointDescriptor,
): Promise<EndpointIoResult<string>> {
  return writeFileAtomic(path, `${JSON.stringify(descriptor)}\n`);
}

function parseEndpointDescriptor(text: string): EndpointIoResult<EndpointDescriptor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "endpoint_json_invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "endpoint_json_invalid" };
  }
  const record = parsed as Record<string, unknown>;
  const protocolVersion = record["protocol_version"];
  const socketPath = record["socket_path"];
  const tokenPath = record["token_path"];
  const bootId = record["boot_id"];
  const pid = record["pid"];
  const startedAt = record["started_at"];
  if (typeof protocolVersion !== "string") {
    return { ok: false, reason: "protocol_version_invalid" };
  }
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    return { ok: false, reason: "socket_path_invalid" };
  }
  if (typeof tokenPath !== "string" || tokenPath.length === 0) {
    return { ok: false, reason: "token_path_invalid" };
  }
  if (typeof bootId !== "string" || bootId.length === 0) {
    return { ok: false, reason: "boot_id_invalid" };
  }
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, reason: "pid_invalid" };
  }
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt)) {
    return { ok: false, reason: "started_at_invalid" };
  }
  return {
    ok: true,
    value: {
      protocol_version: protocolVersion,
      socket_path: socketPath,
      token_path: tokenPath,
      boot_id: bootId,
      pid,
      started_at: startedAt,
    },
  };
}

export async function readEndpointDescriptor(path: string): Promise<EndpointIoResult<EndpointDescriptor>> {
  try {
    return parseEndpointDescriptor(await readFile(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

interface RuntimePermissions {
  readonly runtime_dir_mode: number;
  readonly socket_mode: number;
  readonly token_mode: number;
}

/**
 * Verifies the parent directory is 0700 and socket/token are 0600, following the
 * server's fixed authentication order. Symlinks are rejected outright.
 */
export async function verifyRuntimePermissions(
  paths: RuntimePaths,
): Promise<EndpointIoResult<RuntimePermissions>> {
  const directory = await lstatMode(paths.runtime_dir);
  if (!directory.ok) {
    return directory;
  }
  if (!directory.value.is_directory) {
    return { ok: false, reason: "runtime_dir_not_directory" };
  }
  if (directory.value.mode !== IPC_DIR_MODE) {
    return { ok: false, reason: "runtime_dir_mode_not_0700" };
  }
  const socket = await lstatMode(paths.socket_path);
  if (!socket.ok) {
    return socket;
  }
  if (!socket.value.is_socket) {
    return { ok: false, reason: "socket_not_socket" };
  }
  if (socket.value.mode !== IPC_FILE_MODE) {
    return { ok: false, reason: "socket_mode_not_0600" };
  }
  const token = await lstatMode(paths.token_path);
  if (!token.ok) {
    return token;
  }
  if (!token.value.is_file) {
    return { ok: false, reason: "token_not_file" };
  }
  if (token.value.mode !== IPC_FILE_MODE) {
    return { ok: false, reason: "token_mode_not_0600" };
  }
  return {
    ok: true,
    value: {
      runtime_dir_mode: directory.value.mode,
      socket_mode: socket.value.mode,
      token_mode: token.value.mode,
    },
  };
}

interface FileStatView {
  readonly mode: number;
  readonly is_directory: boolean;
  readonly is_file: boolean;
  readonly is_socket: boolean;
}

async function lstatMode(path: string): Promise<EndpointIoResult<FileStatView>> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return { ok: false, reason: "symlink_rejected" };
    }
    return {
      ok: true,
      value: {
        mode: stats.mode & 0o777,
        is_directory: stats.isDirectory(),
        is_file: stats.isFile(),
        is_socket: stats.isSocket(),
      },
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}
