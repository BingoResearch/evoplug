/**
 * Delivery dedupe identity (DD-FND-092).
 *
 * `dedupe_key = canonicalHash({task_id, branch_id, requirement_ids (UTF-8
 * sorted), issue_id, goal_version, evidence_hash})`.
 *
 * `input_epoch`, `config_version`, submission state, delivery time and host
 * receipts never enter the key. An epoch change therefore never releases
 * dedupe; only a new evidence hash or a new issue/goal binding does.
 */

import { canonicalHash, sortUtf8 } from "@evoplug/core";
import type { Hash, Id, JsonValue } from "@evoplug/core";

export interface DeliveryDedupeIdentity {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly requirement_ids: readonly Id<"req">[];
  readonly issue_id: Id<"issue"> | null;
  readonly goal_version: string;
  readonly evidence_hash: Hash;
}

export function computeDeliveryDedupeKey(identity: DeliveryDedupeIdentity): Hash {
  const preimage: JsonValue = {
    task_id: identity.task_id,
    branch_id: identity.branch_id,
    requirement_ids: sortUtf8(identity.requirement_ids, (id) => id),
    issue_id: identity.issue_id,
    goal_version: identity.goal_version,
    evidence_hash: identity.evidence_hash,
  };
  return canonicalHash(preimage);
}

/**
 * Dedupe is the pair `(dedupe_key, evidence_hash)`. Comparing both catches a
 * stored row with the same key but a divergent evidence hash instead of
 * silently treating it as the same delivery.
 */
export function isDeliveryDedupeHit(
  existing: { dedupe_key: Hash; evidence_hash: Hash },
  candidate: { dedupe_key: Hash; evidence_hash: Hash },
): boolean {
  return (
    existing.dedupe_key === candidate.dedupe_key &&
    existing.evidence_hash === candidate.evidence_hash
  );
}
