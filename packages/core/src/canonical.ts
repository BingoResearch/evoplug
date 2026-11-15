/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) for evoplug content hashing
 * (DD-FND-005, DD-FND-033).
 *
 * Rules implemented here:
 * - object keys are ordered by UTF-16 code unit (RFC 8785, ECMAScript sort);
 * - arrays keep caller order; the canonicalizer never sorts an array;
 * - numbers use ECMAScript JSON number serialization (`-0` becomes `0`);
 * - non-JSON values and lone surrogates are rejected with `E_SCHEMA`.
 */

import { JsonValueError, type JsonValue, type JsonValueRule } from "./json.js";

/**
 * Serializes `value` to the RFC 8785 canonical JSON text.
 *
 * @throws {JsonValueError} when the value is not canonicalizable JSON.
 */
export function canonicalJsonText(value: JsonValue): string {
  return serializeCanonical(value, "$", new Set<object>());
}

/**
 * Serializes `value` to RFC 8785 canonical JSON bytes (UTF-8, no BOM).
 *
 * @throws {JsonValueError} when the value is not canonicalizable JSON.
 */
export function canonicalJson(value: JsonValue): Uint8Array {
  const text = canonicalJsonText(value);
  return new TextEncoder().encode(text);
}

/**
 * Compares two strings by Unicode code point order, which is byte-order
 * equivalent to comparing their UTF-8 encodings. This is the ordering required
 * for business arrays (DD-FND-005); it deliberately differs from UTF-16 code
 * unit order for scalar values above U+FFFF.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const leftNext = left.next();
    const rightNext = right.next();
    if (leftNext.done === true || rightNext.done === true) {
      if (leftNext.done === true && rightNext.done === true) {
        return 0;
      }
      return leftNext.done === true ? -1 : 1;
    }
    const leftCodePoint = leftNext.value.codePointAt(0);
    const rightCodePoint = rightNext.value.codePointAt(0);
    if (leftCodePoint === undefined || rightCodePoint === undefined) {
      return 0;
    }
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
}

/**
 * Returns a new array sorted by the UTF-8 byte order of `key(value)`.
 * Callers must opt in explicitly; the canonicalizer never sorts arrays.
 */
export function sortUtf8<T>(values: readonly T[], key: (value: T) => string): T[] {
  const decorated = values.map((value) => ({ value, sortKey: key(value) }));
  decorated.sort((left, right) => compareUtf8(left.sortKey, right.sortKey));
  return decorated.map((entry) => entry.value);
}

function serializeCanonical(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new JsonValueError(path, "non_finite_number");
      }
      return JSON.stringify(value);
    case "string":
      if (!isWellFormedString(value)) {
        throw new JsonValueError(path, "lone_surrogate");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new JsonValueError(path, nonJsonRule(value));
  }
  const object = value as object;
  if (stack.has(object)) {
    throw new JsonValueError(path, "circular_reference");
  }
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw new JsonValueError(path, "symbol_key");
      }
      if (Object.keys(object).length !== object.length) {
        throw new JsonValueError(path, "sparse_array");
      }
      const items: string[] = [];
      for (let index = 0; index < object.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(object, index)) {
          throw new JsonValueError(`${path}[${index}]`, "sparse_array");
        }
        items.push(serializeCanonical(object[index], `${path}[${index}]`, stack));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonValueError(path, "non_plain_object");
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new JsonValueError(path, "symbol_key");
    }
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) {
      if (!isWellFormedString(key)) {
        throw new JsonValueError(`${path}.${key}`, "lone_surrogate");
      }
      entries.push(`${JSON.stringify(key)}:${serializeCanonical(record[key], `${path}.${key}`, stack)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(object);
  }
}

function nonJsonRule(value: unknown): JsonValueRule {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return "bigint";
  }
  if (typeof value === "function") {
    return "function";
  }
  return "symbol";
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
