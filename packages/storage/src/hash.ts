import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isHash as sharedIsHash, type Hash } from "@evoplug/core";

/** `sha256:` followed by 64 lowercase hexadecimal characters (71 chars). */
export const HASH_PATTERN: RegExp = /^sha256:[0-9a-f]{64}$/;

/** True when `value` is a well-formed content hash. */
export function isHash(value: string): value is Hash {
  return sharedIsHash(value);
}

/** Returns `value` as a `Hash` or `null` when it is malformed. */
export function asHash(value: string): Hash | null {
  return isHash(value) ? value : null;
}

/** SHA-256 of a byte sequence, formatted as a `Hash`. */
export function sha256Bytes(bytes: Uint8Array): Hash {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

/** SHA-256 of a UTF-8 string, formatted as a `Hash`. */
export function sha256Text(text: string): Hash {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

/** Returns the 64 hex characters of a well-formed hash. */
export function hashHex(hash: Hash): string {
  return hash.slice("sha256:".length);
}

/** Streaming SHA-256 of a file; rejects on read failure. */
export function sha256File(path: string): Promise<Hash> {
  return new Promise<Hash>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(`sha256:${hash.digest("hex")}`);
    });
  });
}

/** Compares two strings by their UTF-8 byte order (RFC 8785 string order for ASCII keys). */
export function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

