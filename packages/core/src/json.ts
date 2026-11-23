/**
 * JSON value algebra shared by every domain (DD-FND-033).
 *
 * `JsonValue` is the only payload shape allowed through canonicalization and
 * content hashing. `undefined`, functions, symbols, bigints, non-finite
 * numbers, sparse arrays, non-plain objects, symbol keys and cycles are not
 * JSON and are rejected with `E_SCHEMA` (see {@link JsonValueError}).
 */

type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValueRule =
  | "undefined"
  | "function"
  | "symbol"
  | "bigint"
  | "non_finite_number"
  | "sparse_array"
  | "array_extra_key"
  | "non_plain_object"
  | "symbol_key"
  | "circular_reference"
  | "lone_surrogate";

/**
 * Structural rejection of a non-JSON value. The error code is fixed to
 * `E_SCHEMA` (DD-FND-103 G9 row) so callers can map it onto an
 * `ErrorEnvelope` without a second classification step.
 */
export class JsonValueError extends Error {
  readonly code: "E_SCHEMA" = "E_SCHEMA";
  readonly path: string;
  readonly rule: JsonValueRule;

  constructor(path: string, rule: JsonValueRule) {
    super(`E_SCHEMA: ${path} violates ${rule}`);
    this.name = "JsonValueError";
    this.path = path;
    this.rule = rule;
  }
}

/** True for a non-null, non-array object, the only shape JSON objects take. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape guard for the object variant of `JsonValue`. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWellFormedUnicode(value: string): boolean {
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

/**
 * Returns true when `value` is exactly representable as JSON: plain objects,
 * dense arrays, finite numbers, strings without lone surrogates, booleans and
 * null, with no cycles.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return validateJsonValue(value, "$", new Set<object>(), () => undefined);
}

/**
 * Throws {@link JsonValueError} when `value` is not a JSON value.
 */
export function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  validateJsonValue(value, path, new Set<object>(), (error) => {
    throw error;
  });
}

/**
 * Throws {@link JsonValueError} when `value` is not JSON; otherwise returns it.
 * Used by adapters that receive `unknown` at an IPC boundary.
 */
export function toJsonValue(value: unknown, path = "$"): JsonValue {
  assertJsonValue(value, path);
  return value;
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

function validateJsonValue(  value: unknown,
  path: string,
  stack: Set<object>,
  report: (error: JsonValueError) => void
): value is JsonValue {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "boolean":
      return true;
    case "number":
      if (Number.isFinite(value)) {
        return true;
      }
      report(new JsonValueError(path, "non_finite_number"));
      return false;
    case "string":
      if (isWellFormedUnicode(value)) {
        return true;
      }
      report(new JsonValueError(path, "lone_surrogate"));
      return false;
    case "object":
      break;
    default:
      report(new JsonValueError(path, nonJsonRule(value)));
      return false;
  }
  const object = value as object;
  if (stack.has(object)) {
    report(new JsonValueError(path, "circular_reference"));
    return false;
  }
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getOwnPropertySymbols(object).length > 0) {
        report(new JsonValueError(path, "symbol_key"));
        return false;
      }
      if (Object.keys(object).length !== object.length) {
        report(new JsonValueError(path, "sparse_array"));
        return false;
      }
      for (let index = 0; index < object.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(object, index)) {
          report(new JsonValueError(`${path}[${index}]`, "sparse_array"));
          return false;
        }
        if (!validateJsonValue(object[index], `${path}[${index}]`, stack, report)) {
          return false;
        }
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      report(new JsonValueError(path, "non_plain_object"));
      return false;
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      report(new JsonValueError(path, "symbol_key"));
      return false;
    }
    const record = object as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!isWellFormedUnicode(key)) {
        report(new JsonValueError(`${path}.${key}`, "lone_surrogate"));
        return false;
      }
      if (!validateJsonValue(record[key], `${path}.${key}`, stack, report)) {
        return false;
      }
    }
    return true;
  } finally {
    stack.delete(object);
  }
}
