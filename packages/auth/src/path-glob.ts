/**
 * Absolute path globs used by `GrantScope.path_globs` (DD-FND-090).
 *
 * Patterns are absolute POSIX paths. `*` matches within one segment, `?`
 * matches one character, and a `**` segment matches zero or more segments.
 * Matching is byte-exact and case-sensitive: no escape processing, no
 * percent-decoding, and no Unicode normalization. Symlink escape is prevented
 * at execution time by `realpath` and `lstat`, not by this matcher.
 */

import type { ErrorEnvelope, Result } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { fieldError } from "./errors.js";

/** True when `value` is a POSIX absolute path with no NUL or Windows drive/UNC. */
export function isAbsolutePosixPath(value: string): boolean {
  if (value.length === 0 || value.startsWith("//")) {
    return false;
  }
  if (!value.startsWith("/")) {
    return false;
  }
  if (value.includes("\u0000")) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return false;
  }
  return true;
}

/** Validates one scope glob. Failure is `E_GRANT_SCOPE`. */
export function validatePathGlob(glob: string, path = "scope.path_globs"): Result<string, ErrorEnvelope> {
  if (!isAbsolutePosixPath(glob)) {
    return err(fieldError("E_GRANT_SCOPE", path, "absolute_posix_glob"));
  }
  if (glob.includes("\\")) {
    return err(fieldError("E_GRANT_SCOPE", path, "no_backslash"));
  }
  const segments = glob.split("/").slice(1);
  for (const segment of segments) {
    if (segment.length === 0) {
      return err(fieldError("E_GRANT_SCOPE", path, "no_empty_segment"));
    }
    if (segment === "." || segment === "..") {
      return err(fieldError("E_GRANT_SCOPE", path, "no_dot_segments"));
    }
  }
  return ok(glob);
}

/** Returns true when `path` matches `glob`. Non-absolute inputs never match. */
export function matchPathGlob(glob: string, path: string): boolean {
  if (!isAbsolutePosixPath(glob) || !isAbsolutePosixPath(path)) {
    return false;
  }
  const patternSegments = glob.split("/").slice(1);
  const pathSegments = path.split("/").slice(1);
  return matchSegments(patternSegments, pathSegments, 0, 0);
}

/** True when any glob matches; an empty list never authorizes a path. */
export function matchAnyPathGlob(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => matchPathGlob(glob, path));
}

function matchSegments(
  pattern: readonly string[],
  segments: readonly string[],
  patternIndex: number,
  segmentIndex: number
): boolean {
  if (patternIndex === pattern.length) {
    return segmentIndex === segments.length;
  }
  const patternSegment = pattern[patternIndex];
  if (patternSegment === undefined) {
    return false;
  }
  if (patternSegment === "**") {
    for (let index = segmentIndex; index <= segments.length; index += 1) {
      if (matchSegments(pattern, segments, patternIndex + 1, index)) {
        return true;
      }
    }
    return false;
  }
  if (segmentIndex >= segments.length) {
    return false;
  }
  const segment = segments[segmentIndex];
  if (segment === undefined || !matchSegment(patternSegment, segment)) {
    return false;
  }
  return matchSegments(pattern, segments, patternIndex + 1, segmentIndex + 1);
}

function matchSegment(pattern: string, value: string): boolean {
  return matchChars(pattern, 0, value, 0);
}

function matchChars(pattern: string, patternIndex: number, value: string, valueIndex: number): boolean {
  if (patternIndex === pattern.length) {
    return valueIndex === value.length;
  }
  const character = pattern.charAt(patternIndex);
  if (character === "*") {
    for (let index = valueIndex; index <= value.length; index += 1) {
      if (matchChars(pattern, patternIndex + 1, value, index)) {
        return true;
      }
    }
    return false;
  }
  if (valueIndex >= value.length) {
    return false;
  }
  if (character === "?") {
    return matchChars(pattern, patternIndex + 1, value, valueIndex + 1);
  }
  if (character !== value.charAt(valueIndex)) {
    return false;
  }
  return matchChars(pattern, patternIndex + 1, value, valueIndex + 1);
}
