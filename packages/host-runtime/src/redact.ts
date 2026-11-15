/**
 * Structural redaction before JCS (DD-HOST-202).
 *
 * Credential-looking object keys are removed whole before the payload is
 * canonicalized. Non-credential keys keep their names, values and order; the
 * redaction manifest records every removed key by JSON Pointer and is hashed
 * with JCS so an upload can declare exactly what was stripped.
 */

import { canonicalHash, compareUtf8, type Hash, type JsonValue } from "@evoplug/core";

import { HOST_RUNTIME_REDACTION_SCHEMA_VERSION } from "./artifact.js";

/** Default deny prefixes from DD-HOST-202, lowercase. */
export const DEFAULT_REDACT_PREFIXES: readonly string[] = Object.freeze([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "token",
  "secret",
  "password",
  "credential"
]);

export interface RedactionManifestEntry {
  /** JSON Pointer to the removed key, e.g. `/headers/authorization`. */
  readonly path: string;
  /** The deny prefix that matched. */
  readonly prefix: string;
}

export interface HostRuntimeRedactionManifest {
  readonly schema_version: "rsi.host_runtime_redaction/1";
  readonly entries: readonly RedactionManifestEntry[];
}

export interface RedactionResult {
  /** A copy of the input with every matching key removed. */
  readonly value: JsonValue;
  readonly manifest: HostRuntimeRedactionManifest;
  readonly redaction_manifest_hash: Hash;
  readonly removed: number;
}

function normalizePrefixes(prefixes: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const prefix of prefixes) {
    const trimmed = prefix.trim().toLowerCase();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }
  return [...normalized].sort(compareUtf8);
}

/** Returns the matching deny prefix, or `null` when the key is allowed. */
export function matchDenyPrefix(key: string, prefixes: readonly string[] = DEFAULT_REDACT_PREFIXES): string | null {
  const lowered = key.toLowerCase();
  for (const prefix of prefixes) {
    if (lowered.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}

function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactValue(
  value: JsonValue,
  pointer: string,
  prefixes: readonly string[],
  entries: RedactionManifestEntry[]
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue(entry, `${pointer}/${String(index)}`, prefixes, entries));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const output: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    const matched = matchDenyPrefix(key, prefixes);
    if (matched !== null) {
      entries.push({ path: `${pointer}/${pointerSegment(key)}`, prefix: matched });
      continue;
    }
    output[key] = redactValue(value[key] as JsonValue, `${pointer}/${pointerSegment(key)}`, prefixes, entries);
  }
  return output;
}

/** Hashes a redaction manifest with the same JCS hash used for payloads. */
export function redactionManifestHash(manifest: HostRuntimeRedactionManifest): Hash {
  return canonicalHash(manifest as unknown as JsonValue);
}

/**
 * Copies `value`, deletes every key whose lowercase name starts with a deny
 * prefix, and returns the manifest with its JCS hash. The input is never
 * mutated and removed values are never copied into the output.
 */
export function redactJsonPayload(
  value: JsonValue,
  prefixes: readonly string[] = DEFAULT_REDACT_PREFIXES
): RedactionResult {
  const normalized = normalizePrefixes(prefixes);
  const entries: RedactionManifestEntry[] = [];
  const redacted = redactValue(value, "", normalized, entries);
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const manifest: HostRuntimeRedactionManifest = {
    schema_version: HOST_RUNTIME_REDACTION_SCHEMA_VERSION,
    entries
  };
  return {
    value: redacted,
    manifest,
    redaction_manifest_hash: redactionManifestHash(manifest),
    removed: entries.length
  };
}
