import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { fieldDetails, storageDetails, storageError } from "../errors.js";
import { asHash, hashHex, sha256Bytes } from "../hash.js";

interface StoredBlob {
  readonly hash: Hash;
  readonly byte_length: number;
  /** Path relative to the blob root, e.g. `sha256/<hex>`. */
  readonly relative_path: string;
  readonly absolute_path: string;
  /** True when an identical blob already existed and was verified, not rewritten. */
  readonly existed: boolean;
}

interface BlobVerification {
  readonly hash: Hash;
  readonly present: boolean;
  readonly byte_length: number | null;
  readonly hash_matches: boolean;
}

function fsFailure(error: unknown, operation: string): ErrorEnvelope {
  const code =
    typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "ENOSPC") {
    return storageError({
      code: "E_STORAGE_BLOB_ENOSPC",
      stage: "storage.blob",
      details: storageDetails(operation, "ENOSPC"),
      side_effect: "none"
    });
  }
  return storageError({
    code: "E_STORAGE_IO",
    stage: "storage.blob",
    details: storageDetails(operation, typeof code === "string" ? code : undefined),
    side_effect: "none"
  });
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const chunk = writeSync(fd, bytes, written, bytes.byteLength - written);
    if (chunk <= 0) {
      throw new Error("short write");
    }
    written += chunk;
  }
}

function parseHash(value: string): Hash | null {
  return asHash(value);
}

/**
 * Content-addressed blob store under `<root>/sha256/<hex>`.
 *
 * Writes go to a same-directory temporary file, `fsync(file)`, atomic rename,
 * then `fsync(dir)`. An existing identical blob is verified and reused. The DB
 * row is only inserted by the caller after the file is durable.
 */
export class BlobStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  /** Creates a blob store rooted at `<home>/blobs` (or the given root). */
  static open(root: string): BlobStore {
    mkdirSync(join(root, "sha256"), { recursive: true, mode: 0o700 });
    return new BlobStore(root);
  }

  /** Blob root directory. */
  get root(): string {
    return this.#root;
  }

  /** `<hash>` without the `sha256:` prefix. */
  hashHex(hash: Hash): string {
    return hashHex(hash);
  }

  /** Path relative to the blob root; this is the value stored in `blob.relative_path`. */
  relativePath(hash: Hash): string {
    return join("sha256", hashHex(hash));
  }

  /** Absolute path of the blob file. */
  absolutePath(hash: Hash): string {
    return join(this.#root, this.relativePath(hash));
  }

  /** Stores bytes, returning the verified content address. */
  putSync(bytes: Uint8Array): Result<StoredBlob, ErrorEnvelope> {
    const hash = sha256Bytes(bytes);
    const directory = join(this.#root, "sha256");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      return { ok: false, status: "rejected", error: fsFailure(error, "mkdir") };
    }
    const relative = this.relativePath(hash);
    const absolute = this.absolutePath(hash);
    const temporary = join(directory, `.tmp-${randomUUID()}`);
    let fd: number;
    try {
      fd = openSync(temporary, "wx", 0o600);
    } catch (error) {
      return { ok: false, status: "rejected", error: fsFailure(error, "create_temp") };
    }
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Ignore secondary close failure.
      }
      try {
        unlinkSync(temporary);
      } catch {
        // Ignore cleanup failure.
      }
      return { ok: false, status: "rejected", error: fsFailure(error, "write_temp") };
    }
    const existing = this.verify(hash);
    if (existing.ok && existing.value.present) {
      if (!existing.value.hash_matches || existing.value.byte_length !== bytes.byteLength) {
        let actual = "";
        try {
          actual = sha256Bytes(new Uint8Array(readFileSync(absolute)));
        } catch {
          actual = "";
        }
        try {
          unlinkSync(temporary);
        } catch {
          // Ignore cleanup failure.
        }
        return {
          ok: false,
          status: "conflict",
          error: storageError({
            code: "E_SOURCE_HASH",
            stage: "storage.blob",
            details: {
              kind: "source_conflict",
              source_ref: `blob://${hash}#bytes=0-${bytes.byteLength}`,
              expected: hash,
              actual
            }
          })
        };
      }
      try {
        unlinkSync(temporary);
      } catch {
        // Ignore cleanup failure.
      }
      return {
        ok: true,
        status: "ok",
        value: {
          hash,
          byte_length: bytes.byteLength,
          relative_path: relative,
          absolute_path: absolute,
          existed: true
        }
      };
    }
    try {
      renameSync(temporary, absolute);
      fsyncDirectory(directory);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Ignore cleanup failure.
      }
      return { ok: false, status: "rejected", error: fsFailure(error, "rename") };
    }
    return {
      ok: true,
      status: "ok",
      value: {
        hash,
        byte_length: bytes.byteLength,
        relative_path: relative,
        absolute_path: absolute,
        existed: false
      }
    };
  }

  /** Promise-shaped wrapper for service signatures. */
  async put(bytes: Uint8Array): Promise<Result<StoredBlob, ErrorEnvelope>> {
    return this.putSync(bytes);
  }

  /** Reads and re-verifies a blob. */
  read(hash: Hash): Result<Uint8Array, ErrorEnvelope> {
    const parsed = parseHash(hash);
    if (parsed === null) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_SCHEMA",
          stage: "storage.blob",
          details: fieldDetails("blob_hash", "not_a_content_hash")
        })
      };
    }
    const path = this.absolutePath(parsed);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        return {
          ok: false,
          status: "rejected",
          error: storageError({
            code: "E_BLOB_MISSING",
            stage: "storage.blob",
            details: { kind: "source", source_ref: `blob://${parsed}#bytes=0-0`, reason: "missing" }
          })
        };
      }
      return { ok: false, status: "rejected", error: fsFailure(error, "read") };
    }
    const bytesView = new Uint8Array(bytes);
    if (sha256Bytes(bytesView) !== parsed) {
      return {
        ok: false,
        status: "conflict",
        error: storageError({
          code: "E_SOURCE_HASH",
          stage: "storage.blob",
          details: {
            kind: "source",
            source_ref: `blob://${parsed}#bytes=0-${bytes.byteLength}`,
            reason: "hash_mismatch"
          }
        })
      };
    }
    return { ok: true, status: "ok", value: bytesView };
  }

  /** Returns the file length or null when the file is absent. */
  stat(hash: Hash): Result<{ readonly byte_length: number } | null, ErrorEnvelope> {
    try {
      const stats = statSync(this.absolutePath(hash));
      return {
        ok: true,
        status: "ok",
        value: { byte_length: stats.size }
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        return { ok: true, status: "no_op", value: null };
      }
      return { ok: false, status: "rejected", error: fsFailure(error, "stat") };
    }
  }

  /** Recomputes the file hash without returning bytes. */
  verify(hash: Hash): Result<BlobVerification, ErrorEnvelope> {
    const parsed = parseHash(hash);
    if (parsed === null) {
      return {
        ok: false,
        status: "rejected",
        error: storageError({
          code: "E_SCHEMA",
          stage: "storage.blob",
          details: fieldDetails("blob_hash", "not_a_content_hash")
        })
      };
    }
    const path = this.absolutePath(parsed);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        return {
          ok: true,
          status: "no_op",
          value: { hash: parsed, present: false, byte_length: null, hash_matches: false }
        };
      }
      return { ok: false, status: "rejected", error: fsFailure(error, "verify") };
    }
    const actual = sha256Bytes(new Uint8Array(bytes));
    return {
      ok: true,
      status: "ok",
      value: {
        hash: parsed,
        present: true,
        byte_length: bytes.byteLength,
        hash_matches: actual === parsed
      }
    };
  }

  /** Removes the file. A missing file is a no-op. */
  deleteFile(hash: Hash): Result<void, ErrorEnvelope> {
    try {
      unlinkSync(this.absolutePath(hash));
      return { ok: true, status: "ok", value: undefined };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        return { ok: true, status: "no_op", value: undefined };
      }
      return { ok: false, status: "rejected", error: fsFailure(error, "delete") };
    }
  }

  /** Lists temporary files older than `olderThanMs`, as absolute paths. */
  listTempFiles(olderThanMs: number, now: number): readonly string[] {
    const directory = join(this.#root, "sha256");
    let names: readonly string[];
    try {
      names = readdirSync(directory);
    } catch {
      return [];
    }
    const stale: string[] = [];
    for (const name of names) {
      if (!name.startsWith(".tmp-")) {
        continue;
      }
      const absolute = join(directory, name);
      try {
        const stats = statSync(absolute);
        if (stats.mtimeMs < now - olderThanMs) {
          stale.push(absolute);
        }
      } catch {
        continue;
      }
    }
    return stale;
  }

  /** Deletes a stale temporary file. */
  deleteTempFile(absolutePath: string): Result<void, ErrorEnvelope> {
    try {
      unlinkSync(absolutePath);
      return { ok: true, status: "ok", value: undefined };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        return { ok: true, status: "no_op", value: undefined };
      }
      return { ok: false, status: "rejected", error: fsFailure(error, "delete_temp") };
    }
  }
}
