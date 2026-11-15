/**
 * Content hashing (DD-FND-006, DD-FND-033).
 *
 * `Hash` is always the full `sha256:<64 lowercase hex>` string; short hashes
 * never enter fixtures, logs or assertions.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical.js";
import type { JsonValue } from "./json.js";

export type Hash = `sha256:${string}`;

/** Number of hex characters in a full SHA-256 hash. */
export const HASH_HEX_LENGTH = 64;

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Hashes raw bytes with SHA-256. This is the primitive used for
 * `range_content_hash` (DD-FND-032): SHA-256 over the exact byte sequence,
 * without JCS and without a length prefix.
 */
export function hashBytes(bytes: Uint8Array): Hash {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

/** Hashes a string's UTF-8 encoding with SHA-256. */
export function hashUtf8(text: string): Hash {
  return hashBytes(new TextEncoder().encode(text));
}

/**
 * Hashes the RFC 8785 canonical form of a JSON value:
 * `sha256(JCS(value))`, rendered as `sha256:<64 lowercase hex>`.
 */
export function canonicalHash(value: JsonValue): Hash {
  return hashBytes(canonicalJson(value));
}

/** Returns true only for the canonical full-hash form (lowercase hex). */
export function isHash(value: string): value is Hash {
  return HASH_PATTERN.test(value);
}

/** Raised when a boundary value is not a canonical full hash. */
export class HashFormatError extends Error {
  readonly code: "E_SCHEMA" = "E_SCHEMA";
  readonly value: string;

  constructor(value: string) {
    super(`E_SCHEMA: invalid hash ${JSON.stringify(value)}`);
    this.name = "HashFormatError";
    this.value = value;
  }
}

/**
 * Validates a hash string at a boundary.
 *
 * @throws {HashFormatError} when the value is not a canonical full hash.
 */
export function parseHash(value: string): Hash {
  if (!isHash(value)) {
    throw new HashFormatError(value);
  }
  return value;
}
