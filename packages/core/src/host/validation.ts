/**
 * Small structural validators shared by the HOST submodule.
 *
 * Runtime validation is mandatory at every persistence boundary (DD-TRG-010):
 * TypeScript types never provide it. These helpers stay pure and allocation
 * free on the success path so they can run inside read models as well.
 */

import { compareUtf8 } from "../canonical.js";
import { isHash } from "../hash.js";
import { isWellFormedUnicode } from "../json.js";
import { isSourceRef } from "../source-ref.js";
import { makeErrorEnvelope, type ErrorCode, type ErrorEnvelope } from "../errors.js";
import type { HostValidationIssue } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const CONFIG_SPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Adapter descriptor / construction path token (DD-CAP-002, DD-HOST-110). */
export function isConfigSpaceToken(value: unknown): value is string {
  return typeof value === "string" && CONFIG_SPACE_PATTERN.test(value);
}

export function isConstructionPathToken(value: unknown): value is string {
  return typeof value === "string" && CONFIG_SPACE_PATTERN.test(value);
}

export function isHashValue(value: unknown): value is import("../hash.js").Hash {
  return typeof value === "string" && isHash(value);
}

export function isSourceRefValue(value: unknown): value is import("../source-ref.js").SourceRef {
  return typeof value === "string" && isSourceRef(value);
}

/** UTF-8 byte-order comparison, used for every business array in HOST. */
export function compareUtf8Strings(left: string, right: string): number {
  return compareUtf8(left, right);
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

/** Builds a local `E_SCHEMA` envelope for a boundary violation. */
export function hostSchemaError(stage: string, path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage,
    details: { kind: "field", path, rule }
  });
}

/** Builds a local envelope with an explicit code and a field detail branch. */
export function hostFieldError(input: {
  code: ErrorCode;
  category: ErrorEnvelope["category"];
  stage: string;
  path: string;
  rule: string;
  retryable?: boolean;
}): ErrorEnvelope {
  return makeErrorEnvelope({
    code: input.code,
    category: input.category,
    message_key: `error.${input.code.toLowerCase()}`,
    stage: input.stage,
    details: { kind: "field", path: input.path, rule: input.rule },
    retryable: input.retryable ?? false
  });
}

/** Verifies a string is well-formed Unicode and within an optional byte cap. */
export function isBoundedString(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    return false;
  }
  return utf8ByteLength(value) <= maxBytes;
}

/** Validates a plain object's key set. Returns the first offending key. */
export function keySetIssue(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): HostValidationIssue | null {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return { code: "E_SCHEMA", path: key, rule: "required" };
    }
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      return { code: "E_SCHEMA", path: key, rule: "known_field" };
    }
  }
  return null;
}
