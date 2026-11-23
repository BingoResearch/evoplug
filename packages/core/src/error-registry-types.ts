/**
 * Error registry owner vocabulary (DD-FND-103).
 *
 * `ErrorOwner` names the domain that owns a canonical error code. The merged
 * registry (`schemas/errors/registry.json`, root `rsi.error_registry/1`) is the
 * machine source; each owner contributes one fragment under
 * `schemas/errors/fragments/`. A code has exactly one owner and one canonical
 * row; alias rows never become an owner of their own.
 *
 * This module holds the closed owner set and its runtime guard. It is kept
 * apart from `errors.ts` because the owner set describes the registry, not the
 * runtime error envelope.
 */

export type ErrorOwner = "fnd" | "qp" | "cfg" | "evd" | "rev" | "host";

/** Every owner, in the design's declaration order. */
export const ERROR_OWNERS: readonly ErrorOwner[] = Object.freeze([
  "fnd",
  "qp",
  "cfg",
  "evd",
  "rev",
  "host"
] as const);

const ERROR_OWNER_SET: ReadonlySet<string> = new Set<string>(ERROR_OWNERS);

/** True when `value` is one of the six registered owners. */
export function isErrorOwner(value: unknown): value is ErrorOwner {
  return typeof value === "string" && ERROR_OWNER_SET.has(value);
}
