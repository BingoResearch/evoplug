/**
 * Internal shape guards shared by kernel parsers.
 */

/** True for a non-null, non-array object, the only shape JSON objects take. */
export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
