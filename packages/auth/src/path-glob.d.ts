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
/** True when `value` is a POSIX absolute path with no NUL or Windows drive/UNC. */
export declare function isAbsolutePosixPath(value: string): boolean;
/** Validates one scope glob. Failure is `E_GRANT_SCOPE`. */
export declare function validatePathGlob(glob: string, path?: string): Result<string, ErrorEnvelope>;
/** Returns true when `path` matches `glob`. Non-absolute inputs never match. */
export declare function matchPathGlob(glob: string, path: string): boolean;
/** True when any glob matches; an empty list never authorizes a path. */
export declare function matchAnyPathGlob(globs: readonly string[], path: string): boolean;
