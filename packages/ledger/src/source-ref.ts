import type { SourceRef } from "@evoplug/core";

const SOURCE_REF_PATTERN =
  /^(?:journal:\/\/[^#\s]+|blob:\/\/sha256:[0-9a-f]{64})#bytes=[0-9]+-[0-9]+$/;

/**
 * Structural parse of the two legal `SourceRef` schemes. Byte-range bounds,
 * retrievability and UTF-8 boundaries are checked by `SourceRefPort`.
 */
export function isSourceRef(value: string): value is SourceRef {
  if (!SOURCE_REF_PATTERN.test(value)) return false;
  const range = value.slice(value.lastIndexOf("#bytes=") + "#bytes=".length);
  const separator = range.indexOf("-");
  if (separator <= 0) return false;
  const start = Number(range.slice(0, separator));
  const end = Number(range.slice(separator + 1));
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end;
}

export function parseSourceRef(value: string): SourceRef | null {
  return isSourceRef(value) ? value : null;
}
