/// <reference types="node" />
import { compareUtf8 } from "@evoplug/core";
import type { JsonValue } from "@evoplug/core";

/** Sorted-by-UTF-8 copy of a string list, without duplicates. */
export function uniqueSortedStrings<T extends string>(values: readonly T[]): T[] {
  const copy = [...values];
  copy.sort(compareUtf8);
  const out: T[] = [];
  for (const value of copy) {
    const last = out[out.length - 1];
    if (last === undefined || compareUtf8(last, value) !== 0) {
      out.push(value);
    }
  }
  return out;
}

/** True when values are strictly ascending by UTF-8 byte order and unique. */
export function isSortedUniqueStrings(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    const previous = values[i - 1];
    const current = values[i];
    if (previous === undefined || current === undefined) return false;
    if (compareUtf8(previous, current) >= 0) return false;
  }
  return true;
}

export function stringSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  const left = uniqueSortedStrings(a);
  const right = uniqueSortedStrings(b);
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 1;
}

/** Shape guard for the object variant of `JsonValue`. */
export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a property from a JSON object without throwing on missing keys. */
export function jsonField(value: JsonValue, key: string): JsonValue | undefined {
  if (!isJsonObject(value)) return undefined;
  return value[key];
}

/** Parses JSON text into `JsonValue`, returning `null` on any parse failure. */
export function parseJsonValue(text: string): JsonValue | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isJsonValue(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Object.keys(value)) {
      const child: unknown = Reflect.get(value, key);
      if (!isJsonValue(child)) return false;
    }
    return true;
  }
  return false;
}

/** True when a path is relative, NUL-free and has no empty segment. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.includes("\u0000")) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  return path.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
