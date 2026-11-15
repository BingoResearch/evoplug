/**
 * JSON boundary helpers.
 *
 * Frame bodies are UTF-8 JSON. Decoding is strict (fatal UTF-8, no BOM
 * tolerance beyond what `TextDecoder` accepts) so a corrupt body cannot be
 * papered over with replacement characters.
 */

import type { JsonValue } from "@evoplug/core";

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonDecodeFailure = "invalid_utf8" | "invalid_json";

export type JsonDecodeResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: JsonDecodeFailure };

export type JsonConvertResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly path: string; readonly reason: string };

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function encodeJson(value: JsonValue): Uint8Array {
  return UTF8_ENCODER.encode(JSON.stringify(value));
}

export function decodeJson(body: Uint8Array): JsonDecodeResult {
  let text: string;
  try {
    text = UTF8_DECODER.decode(body);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, value: parsed as JsonValue };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts an in-memory value into the JSON data model, rejecting everything
 * DD-FND-033 forbids (undefined, functions, symbols, bigint, NaN, infinities,
 * sparse arrays, Map/Set/Date, custom prototypes).
 *
 * This does not replace the canonicalizer: it only produces a value that the
 * canonicalizer is allowed to receive.
 */
export function toJsonValue(input: unknown, path = "$"): JsonConvertResult {
  if (input === null) {
    return { ok: true, value: null };
  }
  switch (typeof input) {
    case "string":
    case "boolean":
      return { ok: true, value: input };
    case "number":
      if (!Number.isFinite(input)) {
        return { ok: false, path, reason: "non_finite_number" };
      }
      return { ok: true, value: input };
    case "undefined":
      return { ok: false, path, reason: "undefined_value" };
    case "bigint":
    case "function":
    case "symbol":
      return { ok: false, path, reason: `unsupported_${typeof input}` };
    case "object":
      break;
    default:
      return { ok: false, path, reason: "unsupported_type" };
  }

  if (Array.isArray(input)) {
    const output: JsonValue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      if (!(index in input)) {
        return { ok: false, path: `${path}[${String(index)}]`, reason: "sparse_array" };
      }
      const converted = toJsonValue(input[index], `${path}[${String(index)}]`);
      if (!converted.ok) {
        return converted;
      }
      output.push(converted.value);
    }
    return { ok: true, value: output };
  }

  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, path, reason: "non_plain_object" };
  }
  const record = input as Record<string, unknown>;
  const output: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(record)) {
    const converted = toJsonValue(record[key], `${path}.${key}`);
    if (!converted.ok) {
      return converted;
    }
    output[key] = converted.value;
  }
  return { ok: true, value: output };
}
