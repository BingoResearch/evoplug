/**
 * Overload policy freeze and lookup (DD-FND-103, TST LOAD §2.3).
 *
 * The policy is read once at startup from the versioned operational config and
 * frozen by `policy_version`. Runtime reads are read-only: changing the policy
 * needs a restart and a new version. `policy_hash = sha256(JCS(policy))` over
 * the complete policy object, so an independent party can recompute it from
 * the same field set.
 */

import { canonicalHash } from "../hash.js";
import type { Hash } from "../hash.js";
import type { JsonValue } from "../json.js";
import type { OverloadPolicy } from "../ports/admission.js";
import { OVERLOAD_POLICY_SCHEMA_VERSION } from "../ports/admission.js";

/**
 * The canonical policy field set. The hash preimage contains exactly these
 * eight fields, in this order.
 */
export const OVERLOAD_POLICY_FIELDS = [
  "schema_version",
  "policy_version",
  "scope",
  "queue_capacity",
  "max_inflight",
  "overflow",
  "retry_after_ms",
  "admission_deadline_ms"
] as const;

/** `sha256(JCS(policy))` over the complete policy object. */
export function overloadPolicyHash(policy: OverloadPolicy): Hash {
  const preimage: JsonValue = {
    schema_version: policy.schema_version,
    policy_version: policy.policy_version,
    scope: policy.scope,
    queue_capacity: policy.queue_capacity,
    max_inflight: policy.max_inflight,
    overflow: policy.overflow,
    retry_after_ms: policy.retry_after_ms,
    admission_deadline_ms: policy.admission_deadline_ms
  };
  return canonicalHash(preimage);
}

/**
 * A frozen policy together with its hash. The hash travels with the policy so
 * `system.describe` and every admission decision report the same pair.
 */
export interface FrozenOverloadPolicy {
  readonly policy: OverloadPolicy;
  readonly policy_hash: Hash;
}

export interface OverloadPolicyValidation {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Structural gate for a policy read from configuration. The bounds are the
 * ones TST §2.3 fixes: `queue_capacity >= max_inflight >= 1`,
 * `retry_after_ms >= 1` and `admission_deadline_ms > 0`.
 */
export function validateOverloadPolicy(policy: OverloadPolicy): OverloadPolicyValidation {
  if (policy.schema_version !== OVERLOAD_POLICY_SCHEMA_VERSION) {
    return { ok: false, reason: "schema_version" };
  }
  if (policy.policy_version.length === 0) {
    return { ok: false, reason: "policy_version" };
  }
  if (policy.scope !== "ingress" && policy.scope !== "delivery") {
    return { ok: false, reason: "scope" };
  }
  if (!Number.isSafeInteger(policy.queue_capacity) || policy.queue_capacity < 1) {
    return { ok: false, reason: "queue_capacity" };
  }
  if (!Number.isSafeInteger(policy.max_inflight) || policy.max_inflight < 1) {
    return { ok: false, reason: "max_inflight" };
  }
  if (policy.queue_capacity < policy.max_inflight) {
    return { ok: false, reason: "queue_capacity_lt_max_inflight" };
  }
  if (policy.overflow !== "reject" && policy.overflow !== "block") {
    return { ok: false, reason: "overflow" };
  }
  if (!Number.isSafeInteger(policy.retry_after_ms) || policy.retry_after_ms < 1) {
    return { ok: false, reason: "retry_after_ms" };
  }
  if (!Number.isSafeInteger(policy.admission_deadline_ms) || policy.admission_deadline_ms < 1) {
    return { ok: false, reason: "admission_deadline_ms" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * The frozen-policy registry. One policy is active per scope; the registry
 * never mutates a frozen policy and never hands out a mutable reference.
 */
export class OverloadPolicyRegistry {
  readonly #byVersion: ReadonlyMap<string, FrozenOverloadPolicy>;

  readonly #byScope: ReadonlyMap<OverloadPolicy["scope"], FrozenOverloadPolicy>;

  constructor(policies: readonly OverloadPolicy[]) {
    const byVersion = new Map<string, FrozenOverloadPolicy>();
    const byScope = new Map<OverloadPolicy["scope"], FrozenOverloadPolicy>();
    for (const policy of policies) {
      const validation = validateOverloadPolicy(policy);
      if (!validation.ok) {
        throw new RangeError(`overload policy is invalid at ${validation.reason}`);
      }
      const frozen: FrozenOverloadPolicy = Object.freeze({
        policy: Object.freeze({ ...policy }),
        policy_hash: overloadPolicyHash(policy)
      });
      byVersion.set(policy.policy_version, frozen);
      byScope.set(policy.scope, frozen);
    }
    this.#byVersion = byVersion;
    this.#byScope = byScope;
  }

  /** Looks up a frozen policy by version; `null` when the version is unknown. */
  byVersion(policyVersion: string): FrozenOverloadPolicy | null {
    return this.#byVersion.get(policyVersion) ?? null;
  }

  /** Looks up the frozen policy of a scope; `null` when the scope has none. */
  byScope(scope: OverloadPolicy["scope"]): FrozenOverloadPolicy | null {
    return this.#byScope.get(scope) ?? null;
  }

  /** Every frozen policy, in registration order. */
  all(): readonly FrozenOverloadPolicy[] {
    return [...this.#byVersion.values()];
  }
}

/**
 * The built-in fallback policies. A deployment reads its own versioned
 * operational policy at startup and replaces these; the fallback exists so
 * `system.describe` always reports a policy version and hash.
 */
export const DEFAULT_INGRESS_POLICY: OverloadPolicy = Object.freeze({
  schema_version: OVERLOAD_POLICY_SCHEMA_VERSION,
  policy_version: "overload/ingress/1",
  scope: "ingress",
  queue_capacity: 1024,
  max_inflight: 64,
  overflow: "reject",
  retry_after_ms: 100,
  admission_deadline_ms: 5000
});

export const DEFAULT_DELIVERY_POLICY: OverloadPolicy = Object.freeze({
  schema_version: OVERLOAD_POLICY_SCHEMA_VERSION,
  policy_version: "overload/delivery/1",
  scope: "delivery",
  queue_capacity: 512,
  max_inflight: 32,
  overflow: "block",
  retry_after_ms: 100,
  admission_deadline_ms: 10000
});

/** The default policy pair, one per scope. */
export const DEFAULT_OVERLOAD_POLICIES: readonly OverloadPolicy[] = Object.freeze([
  DEFAULT_INGRESS_POLICY,
  DEFAULT_DELIVERY_POLICY
]);
