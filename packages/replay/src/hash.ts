/**
 * Replay hash preimages (DD-FND-094).
 *
 * `plan_hash` white list: schema_version, validation_plan_id, replay_class,
 * command, cwd, allowed_network, network_target, classification_evidence,
 * environment, isolation (including evidence_ref, excluding verification
 * time), sorted side_effect_kinds, sorted side_effect_refs, version_binding.
 * `replay_plan_id`, `state` and `plan_hash` are excluded.
 */

import { canonicalHash, sortUtf8, parseSourceRef } from "@evoplug/core";
import type { Hash, JsonValue, SourceRef } from "@evoplug/core";

import type { ReplayPlan, ReplayPlanDraft } from "./types.js";

const REPLAY_RESULT_SCHEMA_VERSION: "rsi.replay_result/1" = "rsi.replay_result/1";

export function computeReplayPlanHash(plan: ReplayPlanDraft | ReplayPlan): Hash {
  const preimage: JsonValue = {
    schema_version: plan.schema_version,
    validation_plan_id: plan.validation_plan_id,
    replay_class: plan.replay_class,
    command: plan.command,
    cwd: plan.cwd,
    allowed_network: plan.allowed_network,
    network_target: plan.network_target,
    classification_evidence: plan.classification_evidence,
    environment: plan.environment,
    isolation: {
      mechanism: plan.isolation.mechanism,
      verified: plan.isolation.verified,
      evidence_ref: plan.isolation.evidence_ref,
      network_namespace: plan.isolation.network_namespace,
      writable_roots: [...plan.isolation.writable_roots],
    },
    side_effect_kinds: sortUtf8(plan.side_effect_kinds, (kind) => kind),
    side_effect_refs: sortUtf8(plan.side_effect_refs, (ref) => ref),
    version_binding: {
      task_id: plan.version_binding.task_id,
      branch_id: plan.version_binding.branch_id,
      input_epoch: plan.version_binding.input_epoch,
      goal_version: plan.version_binding.goal_version,
      config_version: plan.version_binding.config_version,
      watermark: plan.version_binding.watermark,
    },
  };
  return canonicalHash(preimage);
}

/**
 * `result_hash` covers the exit code, the stdout/stderr content hashes and the
 * plan hash. The schema tag is the only extra field; the execution identity
 * is already bound transitively by `plan_hash`.
 */
export function computeReplayResultHash(input: {
  plan_hash: Hash;
  exit_code: number | null;
  stdout_ref: SourceRef | null;
  stderr_ref: SourceRef | null;
}): Hash {
  const preimage: JsonValue = {
    schema_version: REPLAY_RESULT_SCHEMA_VERSION,
    plan_hash: input.plan_hash,
    exit_code: input.exit_code,
    stdout_hash: sourceRefContentHash(input.stdout_ref),
    stderr_hash: sourceRefContentHash(input.stderr_ref),
  };
  return canonicalHash(preimage);
}

/**
 * Extracts the content hash a blob SourceRef already carries. A journal ref
 * has no self-contained content hash, so it contributes `null`; callers that
 * need a full output digest must pass a blob ref.
 */
function sourceRefContentHash(ref: SourceRef | null): Hash | null {
  if (ref === null) {
    return null;
  }
  const parsed = parseSourceRef(ref);
  if (!parsed.ok || parsed.value.scheme !== "blob") {
    return null;
  }
  return `sha256:${parsed.value.locator.slice("sha256:".length)}` as Hash;
}
