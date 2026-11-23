import { isRecord as sharedIsRecord } from "@evoplug/core";

export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return sharedIsRecord(value);
}

/**
 * Internal shape guards shared by kernel parsers.
 */

/** True for a non-null, non-array object, the only shape JSON objects take. */
