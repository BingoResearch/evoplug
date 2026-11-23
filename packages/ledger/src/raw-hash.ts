/// <reference types="node" />
import { createHash } from "node:crypto";
import { isHash as sharedIsHash, type Hash } from "@evoplug/core";

/** Raw SHA-256 over a byte sequence, formatted as `sha256:<64 lowercase hex>`. */
export function sha256Bytes(bytes: Uint8Array): Hash {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Raw SHA-256 over the UTF-8 bytes of a string. Used exactly where the design
 * says `sha256(UTF8(text))`: `statement_text_hash`, `quote_hash`,
 * `payload_text` hashes and event body hashes. It is not a JCS preimage.
 */
export function sha256Utf8(text: string): Hash {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

export function isHash(value: string): value is Hash {
  return sharedIsHash(value);
}

export function hashEquals(a: string, b: string): boolean {
  return a === b;
}
