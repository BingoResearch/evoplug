/**
 * Read-only workspace port for W4 targeted evidence supplementation
 * (add_task.md W4, D2).
 *
 * The port is deliberately small and fail-closed:
 *
 *   - a path is admitted only when it resolves inside an approved root that
 *     the HOST activation flow already registered; the kernel never searches
 *     for or invents a root;
 *   - every component is inspected with `lstat`; a symlink anywhere in the
 *     path is a denial, and `O_NOFOLLOW` protects the final open;
 *   - `.env*`, credential material and `.git` internals are denied by name
 *     before any file descriptor is opened;
 *   - one read is capped at 1 MiB, and the cap is clamped here, never raised
 *     by the caller;
 *   - the file identity and version are compared before and after the open
 *     and after the read, so a swapped or rewritten path yields
 *     `E_WORKSPACE_CHANGED` instead of bytes;
 *   - binary payloads are returned as bytes with `text=null`; the port never
 *     decodes or indexes binary content;
 *   - absolute paths never appear in an error envelope, a hash or a record.
 *     Callers receive `root_id` + `path_rel`; `path` is only ever a call-stack
 *     value.
 *
 * The port owns no policy about what an observation means. Observed bytes are
 * not verified facts; `evidence-supplement.ts` is responsible for keeping them
 * out of the hard-fact decision gate.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  isAbsolute,
  join,
  normalize as normalizePath,
  posix as posixPath,
  relative as relativePath,
  resolve as resolvePath
} from "node:path";

import type {
  ErrorCategory,
  ErrorDetails,
  ErrorEnvelope,
  Hash,
  Result
} from "@evoplug/core";
import { err, hashBytes, makeErrorEnvelope, ok } from "@evoplug/core";
import type { SqliteConnection } from "@evoplug/storage";

import type { RootRegistry } from "./root-registry.js";

/** Default and hard maximum for one `read` call. */
export const WORKSPACE_READ_MAX_BYTES = 1_048_576;

/** Default and hard maximum number of entries one `list` call may return. */
export const WORKSPACE_LIST_MAX_ENTRIES = 200;
export const WORKSPACE_LIST_ABSOLUTE_MAX_ENTRIES = 1_000;

/** Default hard ceiling for one call when the caller supplies no deadline. */
const DEFAULT_CALL_DEADLINE_MS = 2_000;

/** One approved directory, as observed by the HOST activation flow. */
export interface WorkspaceReadRoot {
  readonly root_id: string;
  /**
   * Absolute approved directory. Call-stack only: never persisted, hashed,
   * logged or echoed in an error.
   */
  readonly path: string;
}

export interface WorkspaceReadPortDeps {
  /**
   * Current approved roots. A function keeps the port correct when the HOST
   * registers a root after the port was constructed. An empty list is a
   * normal state: the port stays unavailable and supplementation falls back
   * to retrievable HOST attachments.
   */
  readonly roots: () => readonly WorkspaceReadRoot[];
  /** Wall clock for returned timestamps. */
  readonly now?: () => number;
  /** Monotonic clock for deadlines. Defaults to `performance.now`. */
  readonly monotonic?: () => number;
  /** Caller-tunable per-call cap; clamped to `WORKSPACE_READ_MAX_BYTES`. */
  readonly max_read_bytes?: number;
  /** Caller-tunable list cap; clamped to the absolute maximum. */
  readonly max_list_entries?: number;
}

export interface WorkspaceCallOptions {
  /** Per-call duration budget from start until the result is produced. */
  readonly deadline_ms?: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceListInput extends WorkspaceCallOptions {
  /** Root-relative directory prefix. Empty string lists the root. */
  readonly path_prefix?: string;
  /** Optional root selector; when omitted the longest matching root wins. */
  readonly root_id?: string;
  readonly limit: number;
}

export interface WorkspaceReadRange {
  /** Inclusive UTF-8 byte offset. */
  readonly start: number;
  /** Exclusive UTF-8 byte offset. */
  readonly end: number;
}

export interface WorkspaceReadInput extends WorkspaceCallOptions {
  readonly path: string;
  readonly root_id?: string;
  readonly range?: WorkspaceReadRange;
  readonly max_bytes?: number;
}

export interface WorkspaceStatInput extends WorkspaceCallOptions {
  readonly path: string;
  readonly root_id?: string;
}

export type WorkspaceEntryKind = "file" | "directory" | "other";

export interface WorkspacePrunedEntry {
  readonly path_rel: string;
  readonly reason:
    | "sensitive"
    | "symlink"
    | "special"
    | "not_found"
    | "escaped_root"
    | "limit";
}

export interface WorkspaceListEntry {
  readonly name: string;
  readonly path_rel: string;
  readonly kind: WorkspaceEntryKind;
  readonly byte_length: number;
  readonly modified_at: number;
}

export interface WorkspaceListResult {
  readonly root_id: string;
  readonly path_rel: string;
  readonly entries: readonly WorkspaceListEntry[];
  readonly truncated: boolean;
  readonly pruned: readonly WorkspacePrunedEntry[];
}

export type WorkspaceContentEncoding = "utf8" | "binary" | "invalid_utf8";

export interface WorkspaceReadResult {
  readonly root_id: string;
  readonly path_rel: string;
  /** Full file length, not the length of the returned range. */
  readonly byte_length: number;
  readonly range: WorkspaceReadRange;
  /** Bytes of the returned range; bounded by the 1 MiB cap. */
  readonly bytes: Uint8Array;
  /** Decoded text, or `null` when the range is binary or not valid UTF-8. */
  readonly text: string | null;
  readonly binary: boolean;
  readonly encoding: WorkspaceContentEncoding;
  /** `sha256` over the returned range bytes. */
  readonly content_hash: Hash;
  readonly modified_at: number;
}

export interface WorkspaceStatResult {
  readonly root_id: string;
  readonly path_rel: string;
  readonly kind: WorkspaceEntryKind;
  readonly byte_length: number;
  readonly modified_at: number;
  /** `stat` never reads content, so the hash is always `null`. */
  readonly content_hash: Hash | null;
}

export interface WorkspaceReadPort {
  list(input: WorkspaceListInput): Promise<Result<WorkspaceListResult, ErrorEnvelope>>;
  read(input: WorkspaceReadInput): Promise<Result<WorkspaceReadResult, ErrorEnvelope>>;
  stat(input: WorkspaceStatInput): Promise<Result<WorkspaceStatResult, ErrorEnvelope>>;
}

type WorkspaceFailureCode =
  | "E_WORKSPACE_READ_DENIED"
  | "E_WORKSPACE_READ_TOO_LARGE"
  | "E_WORKSPACE_READ_UNSUPPORTED"
  | "E_WORKSPACE_CHANGED"
  | "E_SOURCE_NOT_FOUND"
  | "E_DEADLINE_EXCEEDED"
  | "E_CANCELLED";

const WORKSPACE_ERROR_META: Readonly<
  Record<
    WorkspaceFailureCode,
    { readonly category: ErrorCategory; readonly retryable: boolean; readonly message_key: string }
  >
> = {
  E_WORKSPACE_READ_DENIED: {
    category: "authorization",
    retryable: false,
    message_key: "error.workspace.read_denied"
  },
  E_WORKSPACE_READ_TOO_LARGE: {
    category: "source",
    retryable: false,
    message_key: "error.workspace.read_too_large"
  },
  E_WORKSPACE_READ_UNSUPPORTED: {
    category: "policy",
    retryable: false,
    message_key: "error.workspace.read_unsupported"
  },
  E_WORKSPACE_CHANGED: {
    category: "conflict",
    retryable: true,
    message_key: "error.workspace.changed"
  },
  E_SOURCE_NOT_FOUND: {
    category: "not_found",
    retryable: false,
    message_key: "error.source.not_found"
  },
  E_DEADLINE_EXCEEDED: {
    category: "deadline",
    retryable: true,
    message_key: "error.deadline.exceeded"
  },
  E_CANCELLED: {
    category: "deadline",
    retryable: false,
    message_key: "error.request.cancelled"
  }
};

const DENIED_DETAILS: ErrorDetails = {
  kind: "authorization",
  object_type: "workspace_path",
  denied_dimension: "path"
};

const CHANGED_DETAILS: ErrorDetails = { kind: "none" };

function workspaceFailure(
  code: WorkspaceFailureCode,
  rule: string,
  details: ErrorDetails = DENIED_DETAILS
): Result<never, ErrorEnvelope> {
  const meta = WORKSPACE_ERROR_META[code];
  return err(
    makeErrorEnvelope({
      code,
      category: meta.category,
      message_key: meta.message_key,
      stage: "workspace_read",
      details,
      retryable: meta.retryable,
      side_effect: "none"
    })
  );
}

function fieldFailure(code: WorkspaceFailureCode, rule: string): Result<never, ErrorEnvelope> {
  return workspaceFailure(code, rule, { kind: "field", path: "request", rule });
}

function tooLargeFailure(): Result<never, ErrorEnvelope> {
  return workspaceFailure(
    "E_WORKSPACE_READ_TOO_LARGE",
    "max_1mib",
    {
      kind: "source",
      source_ref: "blob://sha256:" + "0".repeat(64) + "#bytes=0-0",
      reason: "too_large"
    }
  );
}

/* ------------------------------------------------------------------ */
/* Sensitive-name policy                                               */
/* ------------------------------------------------------------------ */

const SENSITIVE_EXACT_NAMES: ReadonlySet<string> = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  ".gitconfig",
  "credentials",
  "credentials.json",
  "secrets.json",
  "auth.json",
  "tokens.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);

const SENSITIVE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
  ".terraform.d"
]);

const SENSITIVE_SUFFIXES: readonly string[] = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".ppk"
];

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".git" || lower === ".git/objects") {
    return true;
  }
  if (SENSITIVE_DIRECTORY_NAMES.has(lower) || SENSITIVE_EXACT_NAMES.has(lower)) {
    return true;
  }
  if (lower.startsWith(".env.") || lower.startsWith("credentials.") || lower.startsWith("secrets.")) {
    return true;
  }
  return SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** True for a path name the port never lists or reads. */
export function isWorkspacePathDenied(name: string): boolean {
  return isSensitiveName(name);
}

/* ------------------------------------------------------------------ */
/* Path resolution                                                    */
/* ------------------------------------------------------------------ */

interface ResolvedRoot {
  readonly root_id: string;
  readonly path: string;
  readonly stats: BigIntStats;
}

interface Candidate {
  readonly root: ResolvedRoot;
  readonly path_rel: string;
  readonly absolute: string;
}

interface TargetStat {
  readonly root: ResolvedRoot;
  readonly path_rel: string;
  readonly absolute: string;
  readonly stats: BigIntStats;
}

function inspectRoot(root: WorkspaceReadRoot): ResolvedRoot | null {
  if (!isAbsolute(root.path) || root.path.includes("\u0000")) {
    return null;
  }
  const normalized = normalizePath(root.path);
  if (normalized !== root.path || resolvePath(root.path) !== root.path) {
    return null;
  }
  let stats: BigIntStats;
  try {
    stats = lstatSync(root.path, { bigint: true });
  } catch {
    return null;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return null;
  }
  let real: string;
  try {
    real = realpathSync(root.path);
  } catch {
    return null;
  }
  if (real !== root.path) {
    return null;
  }
  return { root_id: root.root_id, path: root.path, stats };
}

function usableRoots(deps: WorkspaceReadPortDeps): readonly ResolvedRoot[] {
  const roots: ResolvedRoot[] = [];
  for (const root of deps.roots()) {
    const inspected = inspectRoot(root);
    if (inspected !== null) {
      roots.push(inspected);
    }
  }
  return roots;
}

function normalizeRelative(input: string): string | null {
  if (input.includes("\u0000")) {
    return null;
  }
  if (input.startsWith("\\\\") || input.startsWith("//") || /^[A-Za-z]:/.test(input)) {
    return null;
  }
  const candidate = input.replace(/\\/g, "/");
  if (candidate.startsWith("/")) {
    return null;
  }
  if (candidate === "") {
    return "";
  }
  const normalized = posixPath.normalize(candidate);
  if (normalized === ".") {
    return "";
  }
  if (normalized === ".." || normalized.startsWith("../") || posixPath.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function candidateFor(root: ResolvedRoot, input: string): Candidate | null {
  if (isAbsolute(input)) {
    const normalized = normalizePath(input);
    if (normalized !== input) {
      return null;
    }
    const rel = relativePath(root.path, input).replace(/\\/g, "/");
    if (rel === "" || rel === ".") {
      return { root, path_rel: "", absolute: root.path };
    }
    if (rel.startsWith("..") || posixPath.isAbsolute(rel)) {
      return null;
    }
    return { root, path_rel: rel, absolute: input };
  }
  const rel = normalizeRelative(input);
  if (rel === null) {
    return null;
  }
  const absolute = rel === "" ? root.path : join(root.path, ...rel.split("/"));
  const relativeCheck = relativePath(root.path, absolute).replace(/\\/g, "/");
  if (relativeCheck.startsWith("..") || posixPath.isAbsolute(relativeCheck)) {
    return null;
  }
  return { root, path_rel: rel, absolute };
}

function resolveCandidates(
  deps: WorkspaceReadPortDeps,
  inputPath: string,
  rootId: string | undefined
): readonly Candidate[] {
  const roots = rootId === undefined ? usableRoots(deps) : usableRoots(deps).filter((r) => r.root_id === rootId);
  const candidates: Candidate[] = [];
  for (const root of roots) {
    const candidate = candidateFor(root, inputPath);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  // Longest root first so a nested approved root wins over its parent.
  candidates.sort((left, right) => right.root.path.length - left.root.path.length);
  return candidates;
}

function inspectTarget(candidate: Candidate): Result<TargetStat, ErrorEnvelope> {
  if (candidate.path_rel === "") {
    return ok({
      root: candidate.root,
      path_rel: "",
      absolute: candidate.root.path,
      stats: candidate.root.stats
    });
  }
  const segments = candidate.path_rel.split("/").filter((segment) => segment.length > 0);
  let current = candidate.root.path;
  let finalStats: BigIntStats = candidate.root.stats;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return fieldFailure("E_WORKSPACE_READ_DENIED", "segment");
    }
    if (isSensitiveName(segment)) {
      return fieldFailure("E_WORKSPACE_READ_DENIED", "sensitive_path");
    }
    current = join(current, segment);
    let stats: BigIntStats;
    try {
      stats = lstatSync(current, { bigint: true });
    } catch {
      return fieldFailure("E_SOURCE_NOT_FOUND", "not_found");
    }
    if (stats.isSymbolicLink()) {
      return fieldFailure("E_WORKSPACE_READ_DENIED", "symlink_component");
    }
    const last = index === segments.length - 1;
    if (!last && !stats.isDirectory()) {
      return fieldFailure("E_SOURCE_NOT_FOUND", "parent_not_directory");
    }
    if (last) {
      finalStats = stats;
    }
  }
  if (
    finalStats.isFIFO() ||
    finalStats.isSocket() ||
    finalStats.isCharacterDevice() ||
    finalStats.isBlockDevice()
  ) {
    return fieldFailure("E_WORKSPACE_READ_DENIED", "special_file");
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    return fieldFailure("E_SOURCE_NOT_FOUND", "not_found");
  }
  if (real !== current) {
    return fieldFailure("E_WORKSPACE_READ_DENIED", "realpath_escape");
  }
  return ok({
    root: candidate.root,
    path_rel: candidate.path_rel,
    absolute: current,
    stats: finalStats
  });
}

function inspectTargetByPath(
  deps: WorkspaceReadPortDeps,
  input: { readonly path: string; readonly root_id?: string | undefined }
): Result<TargetStat, ErrorEnvelope> {
  const candidates = resolveCandidates(deps, input.path, input.root_id);
  if (candidates.length === 0) {
    return usableRoots(deps).length === 0
      ? fieldFailure("E_WORKSPACE_READ_UNSUPPORTED", "no_approved_roots")
      : fieldFailure("E_WORKSPACE_READ_DENIED", "outside_approved_roots");
  }
  let last: Result<TargetStat, ErrorEnvelope> | null = null;
  for (const candidate of candidates) {
    const inspected = inspectTarget(candidate);
    if (inspected.ok) {
      return inspected;
    }
    last = inspected;
    if (inspected.error.code === "E_SOURCE_NOT_FOUND") {
      continue;
    }
    return inspected;
  }
  return last ?? fieldFailure("E_SOURCE_NOT_FOUND", "not_found");
}

/* ------------------------------------------------------------------ */
/* Identity / version checks                                          */
/* ------------------------------------------------------------------ */

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function changed(): Result<never, ErrorEnvelope> {
  return workspaceFailure("E_WORKSPACE_CHANGED", "identity_changed", CHANGED_DETAILS);
}

/* ------------------------------------------------------------------ */
/* Binary detection                                                   */
/* ------------------------------------------------------------------ */

function scanContent(bytes: Uint8Array): { readonly binary: boolean; readonly encoding: WorkspaceContentEncoding } {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0) {
      return { binary: true, encoding: "binary" };
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { binary: false, encoding: "utf8" };
  } catch {
    return { binary: true, encoding: "invalid_utf8" };
  }
}

/* ------------------------------------------------------------------ */
/* Call guards                                                        */
/* ------------------------------------------------------------------ */

interface ClockView {
  readonly started: number;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
}

function checkCall(clock: ClockView, monotonic: () => number): ErrorEnvelope | null {
  if (clock.signal !== undefined && clock.signal.aborted) {
    const failure = workspaceFailure("E_CANCELLED", "cancelled");
    return failure.ok ? null : failure.error;
  }
  if (monotonic() - clock.started >= clock.deadline) {
    const failure = workspaceFailure("E_DEADLINE_EXCEEDED", "deadline");
    return failure.ok ? null : failure.error;
  }
  return null;
}

function readGuard(clock: ClockView, monotonic: () => number): Result<void, ErrorEnvelope> {
  const failure = checkCall(clock, monotonic);
  return failure === null ? ok(undefined) : err(failure);
}

/* ------------------------------------------------------------------ */
/* Port factory                                                       */
/* ------------------------------------------------------------------ */

function effectiveMaxBytes(deps: WorkspaceReadPortDeps, requested: number | undefined): number {
  const base = deps.max_read_bytes ?? WORKSPACE_READ_MAX_BYTES;
  const configured = Math.min(base, WORKSPACE_READ_MAX_BYTES);
  if (requested === undefined) {
    return configured;
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return 1;
  }
  return Math.min(requested, configured);
}

function effectiveListLimit(deps: WorkspaceReadPortDeps, requested: number): number {
  const base = deps.max_list_entries ?? WORKSPACE_LIST_MAX_ENTRIES;
  const configured = Math.min(base, WORKSPACE_LIST_ABSOLUTE_MAX_ENTRIES);
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return 1;
  }
  return Math.min(requested, configured);
}

function makeClock(
  deps: WorkspaceReadPortDeps,
  options: WorkspaceCallOptions
): ClockView {
  const monotonic = deps.monotonic ?? ((): number => performance.now());
  const deadline =
    options.deadline_ms !== undefined && Number.isSafeInteger(options.deadline_ms) && options.deadline_ms > 0
      ? options.deadline_ms
      : DEFAULT_CALL_DEADLINE_MS;
  return { started: monotonic(), deadline, signal: options.signal };
}

/** Builds the read-only workspace port over the HOST-approved roots. */
export function createWorkspaceReadPort(deps: WorkspaceReadPortDeps): WorkspaceReadPort {
  const now = deps.now ?? ((): number => Date.now());
  const monotonic = deps.monotonic ?? ((): number => performance.now());

  async function list(input: WorkspaceListInput): Promise<Result<WorkspaceListResult, ErrorEnvelope>> {
    const clock = makeClock(deps, input);
    const guarded = readGuard(clock, monotonic);
    if (!guarded.ok) {
      return guarded;
    }
    const prefix = input.path_prefix ?? "";
    const target = inspectTargetByPath(deps, { path: prefix, root_id: input.root_id });
    if (!target.ok) {
      return target;
    }
    if (!target.value.stats.isDirectory()) {
      return fieldFailure("E_WORKSPACE_READ_DENIED", "not_a_directory");
    }

    const limit = effectiveListLimit(deps, input.limit);
    let names: string[];
    try {
      names = readdirSync(target.value.absolute);
    } catch {
      return fieldFailure("E_SOURCE_NOT_FOUND", "list_failed");
    }
    names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

    const entries: WorkspaceListEntry[] = [];
    const pruned: WorkspacePrunedEntry[] = [];
    let truncated = false;
    for (const name of names) {
      if (entries.length >= limit) {
        truncated = true;
        pruned.push({ path_rel: joinRel(target.value.path_rel, name), reason: "limit" });
        break;
      }
      const afterGuard = readGuard(clock, monotonic);
      if (!afterGuard.ok) {
        return afterGuard;
      }
      if (isSensitiveName(name)) {
        pruned.push({ path_rel: joinRel(target.value.path_rel, name), reason: "sensitive" });
        continue;
      }
      const absolute = join(target.value.absolute, name);
      let stats: BigIntStats;
      try {
        stats = lstatSync(absolute, { bigint: true });
      } catch {
        pruned.push({ path_rel: joinRel(target.value.path_rel, name), reason: "not_found" });
        continue;
      }
      if (stats.isSymbolicLink()) {
        pruned.push({ path_rel: joinRel(target.value.path_rel, name), reason: "symlink" });
        continue;
      }
      const kind: WorkspaceEntryKind = stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : "other";
      if (kind === "other") {
        pruned.push({ path_rel: joinRel(target.value.path_rel, name), reason: "special" });
        continue;
      }
      entries.push({
        name,
        path_rel: joinRel(target.value.path_rel, name),
        kind,
        byte_length: kind === "file" ? Number(stats.size) : 0,
        modified_at: Number(stats.mtimeMs)
      });
    }
    return ok({
      root_id: target.value.root.root_id,
      path_rel: target.value.path_rel,
      entries,
      truncated,
      pruned
    });
  }

  async function readFile(input: WorkspaceReadInput): Promise<Result<WorkspaceReadResult, ErrorEnvelope>> {
    const clock = makeClock(deps, input);
    const guarded = readGuard(clock, monotonic);
    if (!guarded.ok) {
      return guarded;
    }
    const candidate = inspectTargetByPath(deps, { path: input.path, root_id: input.root_id });
    if (!candidate.ok) {
      return candidate;
    }
    if (!candidate.value.stats.isFile()) {
      return fieldFailure("E_WORKSPACE_READ_DENIED", "not_a_file");
    }

    const maxBytes = effectiveMaxBytes(deps, input.max_bytes);
    const pre = candidate.value.stats;
    const fullLength = Number(pre.size);

    let range: WorkspaceReadRange;
    if (input.range !== undefined) {
      const { start, end } = input.range;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > fullLength
      ) {
        return fieldFailure("E_WORKSPACE_READ_TOO_LARGE", "range_out_of_bounds");
      }
      if (end - start > maxBytes) {
        return tooLargeFailure();
      }
      range = { start, end };
    } else {
      if (fullLength > maxBytes) {
        return tooLargeFailure();
      }
      range = { start: 0, end: fullLength };
    }

    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = openSync(candidate.value.absolute, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code;
      if (code === "ELOOP" || code === "EMLINK") {
        return fieldFailure("E_WORKSPACE_READ_DENIED", "symlink_component");
      }
      if (code === "ENOENT") {
        return fieldFailure("E_SOURCE_NOT_FOUND", "not_found");
      }
      return fieldFailure("E_WORKSPACE_READ_DENIED", "open_failed");
    }

    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()) {
        return fieldFailure("E_WORKSPACE_READ_DENIED", "not_a_file");
      }
      if (!sameIdentity(pre, opened) || !sameVersion(pre, opened)) {
        return changed();
      }
      const openedLength = Number(opened.size);
      if (openedLength !== fullLength) {
        return changed();
      }
      if (range.end > openedLength) {
        return fieldFailure("E_WORKSPACE_READ_TOO_LARGE", "range_out_of_bounds");
      }

      const length = range.end - range.start;
      const buffer = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const guardedRead = readGuard(clock, monotonic);
        if (!guardedRead.ok) {
          return guardedRead;
        }
        const bytesRead = readSync(fd, buffer, offset, length - offset, range.start + offset);
        if (bytesRead <= 0) {
          // Short read against a file whose stats did not move is an unstable
          // source; do not return partial bytes.
          return changed();
        }
        offset += bytesRead;
      }

      const after = fstatSync(fd, { bigint: true });
      if (!sameIdentity(opened, after) || !sameVersion(opened, after) || Number(after.size) !== openedLength) {
        return changed();
      }
      let onPath: BigIntStats;
      try {
        onPath = lstatSync(candidate.value.absolute, { bigint: true });
      } catch {
        return changed();
      }
      if (!sameIdentity(after, onPath) || onPath.isSymbolicLink()) {
        return changed();
      }
      try {
        if (realpathSync(candidate.value.absolute) !== candidate.value.absolute) {
          return changed();
        }
      } catch {
        return changed();
      }

      const scan = scanContent(buffer);
      const text = scan.binary ? null : new TextDecoder("utf-8").decode(buffer);
      return ok({
        root_id: candidate.value.root.root_id,
        path_rel: candidate.value.path_rel,
        byte_length: openedLength,
        range,
        bytes: buffer,
        text,
        binary: scan.binary,
        encoding: scan.encoding,
        content_hash: hashBytes(buffer),
        modified_at: Number(opened.mtimeMs)
      });
    } catch {
      return changed();
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Closing a read-only descriptor has no business meaning here.
      }
    }
  }

  async function statFile(input: WorkspaceStatInput): Promise<Result<WorkspaceStatResult, ErrorEnvelope>> {
    const clock = makeClock(deps, input);
    const guarded = readGuard(clock, monotonic);
    if (!guarded.ok) {
      return guarded;
    }
    const target = inspectTargetByPath(deps, { path: input.path, root_id: input.root_id });
    if (!target.ok) {
      return target;
    }
    const kind: WorkspaceEntryKind = target.value.stats.isFile()
      ? "file"
      : target.value.stats.isDirectory()
        ? "directory"
        : "other";
    if (kind === "other") {
      return fieldFailure("E_WORKSPACE_READ_DENIED", "special_file");
    }
    // A file stat is not trusted until an open confirms the same inode, so a
    // path swapped between `lstat` and the answer is reported, not returned.
    if (kind === "file") {
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      let fd: number;
      try {
        fd = openSync(target.value.absolute, fsConstants.O_RDONLY | noFollow);
      } catch {
        return fieldFailure("E_WORKSPACE_READ_DENIED", "open_failed");
      }
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (!sameIdentity(opened, target.value.stats) || !sameVersion(opened, target.value.stats)) {
          return changed();
        }
      } finally {
        closeSync(fd);
      }
    }
    return ok({
      root_id: target.value.root.root_id,
      path_rel: target.value.path_rel,
      kind,
      byte_length: kind === "file" ? Number(target.value.stats.size) : 0,
      modified_at: Number(target.value.stats.mtimeMs),
      content_hash: null
    });
  }

  return {
    list,
    read: readFile,
    stat: statFile
  };
}

function joinRel(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`;
}

/** Re-exported for callers that build a root list from a HOST registry. */
export interface WorkspaceReadRootView {
  readonly root_id: string;
  readonly path: string;
}

/**
 * Builds the port's `roots` callback from the FND root registry.
 *
 * Only root ids already present in `root_registration` are considered. The
 * absolute path comes from the registry's in-memory `approved_root`, never
 * from SQLite, a hash or a caller-supplied directory. A row whose live
 * approval is absent is skipped, so an empty result is the normal "no
 * workspace" state and supplementation falls back to HOST attachments.
 */
export interface WorkspaceRootRegistryDeps {
  readonly connection: Pick<SqliteConnection, "prepare">;
  readonly registry: Pick<RootRegistry, "lookup">;
}

export function createWorkspaceRootsFromRegistry(
  deps: WorkspaceRootRegistryDeps
): () => readonly WorkspaceReadRoot[] {
  return () => {
    let rows: Array<{ readonly root_id: string }>;
    try {
      rows = deps.connection
        .prepare<{ readonly root_id: string }>(
          "SELECT root_id FROM root_registration ORDER BY root_id ASC"
        )
        .all();
    } catch {
      return [];
    }
    const seen = new Set<string>();
    const roots: WorkspaceReadRoot[] = [];
    for (const row of rows) {
      const rootId = row.root_id;
      if (typeof rootId !== "string" || rootId.length === 0 || seen.has(rootId)) {
        continue;
      }
      seen.add(rootId);
      const found = deps.registry.lookup(rootId);
      if (!found.ok || found.value.approved_root === null) {
        continue;
      }
      roots.push({ root_id: found.value.root_id, path: found.value.approved_root });
    }
    return roots;
  };
}
