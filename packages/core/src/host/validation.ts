/**
 * Small structural validators shared by the HOST submodule.
 *
 * Runtime validation is mandatory at every persistence boundary (DD-TRG-010):
 * TypeScript types never provide it. These helpers stay pure and allocation
 * free on the success path so they can run inside read models as well.
 */

import { compareUtf8 } from "../canonical.js";
import { isHash } from "../hash.js";

import { isSourceRef } from "../source-ref.js";
import { isRecord as sharedIsRecord } from "../json.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}



export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

const CONFIG_SPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Adapter descriptor / construction path token (DD-CAP-002, DD-HOST-110). */
export function isConfigSpaceToken(value: unknown): value is string {
  return typeof value === "string" && CONFIG_SPACE_PATTERN.test(value);
}

export function isHashValue(value: unknown): value is import("../hash.js").Hash {
  return typeof value === "string" && isHash(value);
}

export function isSourceRefValue(value: unknown): value is import("../source-ref.js").SourceRef {
  return typeof value === "string" && isSourceRef(value);
}

/** Returns a UTF-8 sorted, de-duplicated copy. */
export function sortedUnique(values: readonly string[]): string[] {
  const unique = Array.from(new Set(values));
  unique.sort(compareUtf8);
  return unique;
}

export function isUtf8SortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) {
      return false;
    }
    if (compareUtf8(previous, current) >= 0) {
      return false;
    }
  }
  return true;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** UTF-8 byte length without constructing a second string. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

