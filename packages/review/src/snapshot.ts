/**
 * ReviewSnapshot construction, hashing and validity (DD-REV-010, -011, -012).
 *
 * All hashes are `sha256(JCS(...))` over an explicit preimage. Optional
 * fields are written as `null` where the design says so; the frozen snapshot
 * projection is the snapshot object without the four instance fields.
 */

import {
  canonicalHash,
  compareUtf8,
  isId,
  makeErrorEnvelope,
  sortUtf8,
  toJsonValue
} from "@evoplug/core";
import type { ErrorEnvelope, Hash, JsonValue, Result, SourceRef, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";


import type { ConfigVersionReadPort } from "@evoplug/core";
import type { GoalVersionReadPort } from "@evoplug/core";

import type { PendingWorkRef, TriggerEvent, VerifiedSignal } from "./host-contracts.js";
import type { ExperienceCandidateQuery, ReviewExperienceCandidate, ReviewOutputPolicyParams, ReviewOutputPolicyRef, ReviewOutputPolicySource, ReviewQuotaPolicy, ReviewSnapshot, ReviewSnapshotSourcePlan, ReviewSourceBinding, ReviewSourceFactQuery, SnapshotStaleReason, SnapshotValidity, TriggerEnqueueBinding } from "./types.js";
import { budgetInvalid, outputPolicyInvalid, quotaPolicyUnavailable, snapshotInvalid, versionBindingError } from "./errors.js";

export const REVIEW_EXPERIENCE_CANDIDATE_LIMIT = 32 as const;
const REVIEW_OUTPUT_DEFAULT_MAX_PROPOSALS = 8 as const;
const REVIEW_OUTPUT_DEFAULT_MAX_PROGRESS = 16 as const;
const REVIEW_OUTPUT_DEFAULT_MAX_BYTES = 16_777_216 as const;
const REVIEW_OUTPUT_DEFAULT_MAX_LINE_BYTES = 3_145_728 as const;
const REVIEW_OUTPUT_DEFAULT_MAX_LINES = 64 as const;
export const REVIEW_SOURCE_MAX_BYTES_PER_REF = 1_048_576 as const;
export const REVIEW_DIFF_MAX_BYTES = 1_048_576 as const;
export const REVIEW_EXPERIENCE_BODY_MAX_BYTES = 65_536 as const;

/* ------------------------------------------------------------------ */
/* Output policy                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_REVIEW_OUTPUT_POLICY_PARAMS: ReviewOutputPolicyParams = Object.freeze({
  max_proposals: REVIEW_OUTPUT_DEFAULT_MAX_PROPOSALS,
  max_progress_events: REVIEW_OUTPUT_DEFAULT_MAX_PROGRESS,
  max_output_bytes: REVIEW_OUTPUT_DEFAULT_MAX_BYTES,
  max_output_line_bytes: REVIEW_OUTPUT_DEFAULT_MAX_LINE_BYTES,
  max_output_lines: REVIEW_OUTPUT_DEFAULT_MAX_LINES
});

function reviewOutputPolicyHash(input: {
  max_proposals: number;
  max_progress_events: number;
  max_output_bytes: number;
  max_output_line_bytes: number;
  max_output_lines: number;
}): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: "rsi.review_output_policy_ref/1",
      output_policy_id: "rsi.review_output/default",
      owner: "rev",
      max_proposals: input.max_proposals,
      max_progress_events: input.max_progress_events,
      max_output_bytes: input.max_output_bytes,
      max_output_line_bytes: input.max_output_line_bytes,
      max_output_lines: input.max_output_lines
    })
  );
}

/** Copies the canonical parameters and computes `output_policy_hash`. */
export function buildReviewOutputPolicy(params: ReviewOutputPolicyParams): ReviewOutputPolicyRef {
  return {
    schema_version: "rsi.review_output_policy_ref/1",
    output_policy_id: "rsi.review_output/default",
    owner: "rev",
    max_proposals: params.max_proposals,
    max_progress_events: params.max_progress_events,
    max_output_bytes: params.max_output_bytes,
    max_output_line_bytes: params.max_output_line_bytes,
    max_output_lines: params.max_output_lines,
    output_policy_hash: reviewOutputPolicyHash(params)
  };
}

export const defaultReviewOutputPolicySource: ReviewOutputPolicySource = Object.freeze({
  load(): ReviewOutputPolicyRef {
    return buildReviewOutputPolicy(DEFAULT_REVIEW_OUTPUT_POLICY_PARAMS);
  }
});

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Validates owner, id, ranges and the recomputed hash (DD-REV-010 V12c). */
export function validateReviewOutputPolicy(policy: ReviewOutputPolicyRef): Result<ReviewOutputPolicyRef, ErrorEnvelope> {
  if (policy.schema_version !== "rsi.review_output_policy_ref/1") {
    return err(outputPolicyInvalid("output_policy.schema_version", "const"));
  }
  if (policy.output_policy_id !== "rsi.review_output/default" || policy.owner !== "rev") {
    return err(outputPolicyInvalid("output_policy.owner", "rev_owned"));
  }
  if (!Number.isSafeInteger(policy.max_proposals) || policy.max_proposals < 1 || policy.max_proposals > 16) {
    return err(outputPolicyInvalid("output_policy.max_proposals", "range_1_16"));
  }
  if (!isPositiveSafeInteger(policy.max_progress_events)) {
    return err(outputPolicyInvalid("output_policy.max_progress_events", "positive_safe_integer"));
  }
  if (!isPositiveSafeInteger(policy.max_output_bytes)) {
    return err(outputPolicyInvalid("output_policy.max_output_bytes", "positive_safe_integer"));
  }
  if (!isPositiveSafeInteger(policy.max_output_line_bytes)) {
    return err(outputPolicyInvalid("output_policy.max_output_line_bytes", "positive_safe_integer"));
  }
  if (!isPositiveSafeInteger(policy.max_output_lines)) {
    return err(outputPolicyInvalid("output_policy.max_output_lines", "positive_safe_integer"));
  }
  const expected = reviewOutputPolicyHash(policy);
  if (expected !== policy.output_policy_hash) {
    return err(outputPolicyInvalid("output_policy.output_policy_hash", "recomputed"));
  }
  return ok(policy);
}

/* ------------------------------------------------------------------ */
/* Quota policy                                                        */
/* ------------------------------------------------------------------ */

export function reviewQuotaPolicyHash(
  policy: Omit<ReviewQuotaPolicy, "quota_policy_hash">
): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: "rsi.review_quota_policy/1",
      budget_policy_ref: policy.budget_policy_ref,
      budget_policy_version: policy.budget_policy_version,
      budget_policy_hash: policy.budget_policy_hash,
      purpose: policy.purpose,
      max_attempts: policy.max_attempts,
      max_input_tokens: policy.max_input_tokens,
      max_output_tokens: policy.max_output_tokens,
      request_max_tokens: policy.request_max_tokens,
      question_max_tokens: policy.question_max_tokens,
      request_margin_tokens: policy.request_margin_tokens,
      question_margin_tokens: policy.question_margin_tokens,
      max_cost_micros: policy.max_cost_micros,
      wall_ms: policy.wall_ms,
      reserve_ms: policy.reserve_ms,
      min_work_ms: policy.min_work_ms,
      attempt_charge_at: policy.attempt_charge_at,
      attempt_refundable: policy.attempt_refundable
    })
  );
}

const QUOTA_NUMBER_FIELDS: readonly (keyof ReviewQuotaPolicy)[] = [
  "max_input_tokens",
  "max_output_tokens",
  "request_max_tokens",
  "question_max_tokens",
  "request_margin_tokens",
  "question_margin_tokens",
  "wall_ms",
  "reserve_ms",
  "min_work_ms"
];

function quotaInvalid(policy: ReviewQuotaPolicy): ErrorEnvelope {
  return budgetInvalid({
    scopeKey: `${policy.budget_policy_ref}:${policy.purpose}`,
    policyVersion: policy.budget_policy_version,
    budgetKind: "attempt",
    remaining: null
  });
}

export function validateReviewQuotaPolicy(
  policy: ReviewQuotaPolicy
): Result<ReviewQuotaPolicy, ErrorEnvelope> {
  if (policy.schema_version !== "rsi.review_quota_policy/1") {
    return err(snapshotInvalid("budget.schema_version", "const"));
  }
  if (policy.budget_policy_version !== "bpol/1") {
    return err(quotaPolicyUnavailable("bpol/1", policy.budget_policy_version));
  }
  if (policy.purpose !== "review_generate") {
    return err(quotaPolicyUnavailable("review_generate", policy.purpose));
  }
  if (!Number.isSafeInteger(policy.max_attempts) || policy.max_attempts < 1 || policy.max_attempts > 10) {
    return err(quotaInvalid(policy));
  }
  for (const field of QUOTA_NUMBER_FIELDS) {
    const value = policy[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return err(quotaInvalid(policy));
    }
  }
  if (policy.max_cost_micros !== null) {
    if (!Number.isSafeInteger(policy.max_cost_micros) || policy.max_cost_micros < 0) {
      return err(quotaInvalid(policy));
    }
  }
  if (policy.attempt_charge_at !== "claim") {
    return err(quotaInvalid(policy));
  }
  if (policy.attempt_refundable !== false) {
    return err(quotaInvalid(policy));
  }
  const expected = reviewQuotaPolicyHash(policy);
  if (expected !== policy.quota_policy_hash) {
    return err(quotaInvalid(policy));
  }
  return ok(policy);
}

/* ------------------------------------------------------------------ */
/* HOST trigger hashes recomputed by REV (DD-REV-002)                 */
/* ------------------------------------------------------------------ */

export function sortedUniqueRefs(refs: readonly SourceRef[]): SourceRef[] {
  return [...new Set(refs)].sort(compareUtf8);
}

function sortStringsUtf8(values: readonly string[]): string[] {
  return [...values].sort(compareUtf8);
}

export function computeReviewScopeKey(input: {
  scope: TriggerEvent["scope"];
  stable_watermark: number;
  stable_event_ids: readonly string[];
  pending_state: "none" | "pending" | "unknown";
  pending_work_refs: readonly PendingWorkRef[];
  review_kind: "auto" | "explicit";
}): Hash {
  const pendingFields = sortUtf8(
    input.pending_work_refs.map((pending) => ({
      pending_id: pending.pending_id,
      kind: pending.kind,
      state: pending.state
    })),
    (pending) => JSON.stringify({
      kind: pending.kind,
      pending_id: pending.pending_id,
      state: pending.state
    })
  );
  return canonicalHash(
    toJsonValue({
      task_id: input.scope.task_id,
      branch_id: input.scope.branch_id,
      input_epoch: input.scope.input_epoch,
      goal_version: input.scope.goal_version,
      config_version: input.scope.config_version,
      stable_watermark: input.stable_watermark,
      stable_event_ids: sortStringsUtf8(input.stable_event_ids),
      pending_state: input.pending_state,
      pending_fields: pendingFields,
      review_kind: input.review_kind
    })
  );
}

export function computeBoundaryKey(input: {
  scope: TriggerEvent["scope"];
  boundary_kind: "host_stable_event" | "exit" | "user_selected" | "none";
  stable_watermark: number;
  stable_event_ids: readonly string[];
}): Hash {
  return canonicalHash(
    toJsonValue({
      task_id: input.scope.task_id,
      branch_id: input.scope.branch_id,
      input_epoch: input.scope.input_epoch,
      goal_version: input.scope.goal_version,
      config_version: input.scope.config_version,
      boundary_kind: input.boundary_kind,
      stable_watermark: input.stable_watermark,
      stable_event_ids: sortStringsUtf8(input.stable_event_ids)
    })
  );
}

/**
 * Appendix J.4: dedupe identity for one input segment. Every stable boundary
 * in the same task/branch/input-epoch/goal/config segment shares this key, so
 * `agent_end`, `agent_settled`, `session_stop` and `session_shutdown` at one
 * user-visible watermark enqueue one review. A new input advances the epoch.
 */
export function computeStableBoundarySegmentKey(scope: TriggerEvent["scope"]): Hash {
  return computeBoundaryKey({
    scope,
    boundary_kind: "host_stable_event",
    stable_watermark: 0,
    stable_event_ids: []
  });
}

/**
 * Durable trigger identity for a stable automatic boundary. It deliberately
 * ignores the individual boundary event and the signal digest: appendix J.4
 * requires every stable hook in one input segment to enqueue one review.
 */
export function computeStableBoundaryDedupeKey(scope: TriggerEvent["scope"]): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: "rsi.trigger_dedupe_segment/1",
      segment_key: computeStableBoundarySegmentKey(scope),
      review_kind: "auto"
    })
  );
}

export function computeSignalDigest(signals: readonly VerifiedSignal[]): Hash {
  const canonicalSignals = signals.map((signal) =>
    JSON.stringify(
      toJsonValue({
        type: signal.type,
        strength: signal.strength,
        detector_version: signal.detector_version,
        evidence_refs: sortStringsUtf8(signal.evidence_refs),
        issue_ids: sortStringsUtf8(signal.issue_ids),
        requirement_ids: sortStringsUtf8(signal.requirement_ids)
      })
    )
  );
  canonicalSignals.sort(compareUtf8);
  return canonicalHash(toJsonValue(canonicalSignals));
}

export function computeTriggerDedupeKey(input: {
  boundary_key: Hash;
  signal_digest: Hash;
  review_kind: "auto" | "explicit";
}): Hash {
  return canonicalHash(
    toJsonValue({
      boundary_key: input.boundary_key,
      signal_digest: input.signal_digest,
      review_kind: input.review_kind
    })
  );
}

/** `triggerEnqueueBinding` removes exactly three fields, others become null. */
export function triggerEnqueueBinding(trigger: TriggerEvent): TriggerEnqueueBinding {
  return {
    schema_version: "rsi.trigger_enqueue_binding/1",
    trigger_event_id: trigger.trigger_event_id,
    trigger_kind: trigger.trigger_kind,
    source_event_ref: trigger.source_event_ref,
    raw_event_ref: trigger.raw_event_ref,
    local_input_id: trigger.local_input_id ?? null,
    host_binding: trigger.host_binding,
    policy_ref: trigger.policy_ref,
    origin: trigger.origin,
    request_intent: trigger.request_intent,
    scope: trigger.scope,
    identity_quality: trigger.identity_quality,
    signals: trigger.signals,
    boundary: trigger.boundary,
    stable_evidence_ref: trigger.stable_evidence_ref ?? null,
    review_scope_key: trigger.review_scope_key,
    capability_gate: trigger.capability_gate,
    dedupe: trigger.dedupe,
    decision: "enqueue",
    decision_reason: trigger.decision_reason,
    policy_snapshot_ref: trigger.policy_snapshot_ref,
    authorization_ref: trigger.authorization_ref ?? null,
    decision_version: 1,
    decided_at: trigger.decided_at,
    evidence_refs: sortStringsUtf8(trigger.evidence_refs)
  };
}

export function triggerBindingHash(trigger: TriggerEvent): Hash {
  return canonicalHash(toJsonValue(triggerEnqueueBinding(trigger)));
}

/** Six-field binding from the trigger scope and the frozen watermark. */
export function deriveVersionBinding(
  scope: TriggerEvent["scope"],
  watermark: number
): Result<VersionBinding, ErrorEnvelope> {
  if (!isId(scope.task_id, "task")) {
    return err(versionBindingError("task_id", "task_id"));
  }
  if (!isId(scope.branch_id, "br")) {
    return err(versionBindingError("branch_id", "branch_id"));
  }
  if (!Number.isSafeInteger(scope.input_epoch) || scope.input_epoch < 0) {
    return err(versionBindingError("input_epoch", "non_negative_safe_integer"));
  }
  if (typeof scope.goal_version !== "string" || scope.goal_version.length === 0) {
    return err(versionBindingError("goal_version", "non_empty"));
  }
  if (typeof scope.config_version !== "string" || scope.config_version.length === 0) {
    return err(versionBindingError("config_version", "non_empty"));
  }
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    return err(versionBindingError("watermark", "non_negative_safe_integer"));
  }
  return ok({
    task_id: scope.task_id,
    branch_id: scope.branch_id,
    input_epoch: scope.input_epoch,
    goal_version: scope.goal_version,
    config_version: scope.config_version,
    watermark
  });
}

/* ------------------------------------------------------------------ */
/* Source queries and metadata                                         */
/* ------------------------------------------------------------------ */

export function reviewSourceFactQueryHash(query: ReviewSourceFactQuery): Hash {
  return canonicalHash(toJsonValue(query));
}

export function experienceCandidateQueryHash(query: ExperienceCandidateQuery): Hash {
  return canonicalHash(toJsonValue(query));
}

export function reviewSnapshotSourcePlanHash(
  plan: Omit<ReviewSnapshotSourcePlan, "source_plan_hash">
): Hash {
  return canonicalHash(toJsonValue(plan));
}

/* ------------------------------------------------------------------ */
/* Snapshot hashes                                                     */
/* ------------------------------------------------------------------ */

type SnapshotFrozenProjection = Omit<
  ReviewSnapshot,
  "snapshot_id" | "snapshot_key" | "snapshot_hash" | "created_at"
>;

export function snapshotFrozenProjection(snapshot: ReviewSnapshot): JsonValue {
  const projection: SnapshotFrozenProjection = {
    schema_version: snapshot.schema_version,
    version_binding: snapshot.version_binding,
    snapshot_scope: snapshot.snapshot_scope,
    trigger: snapshot.trigger,
    host_event: snapshot.host_event,
    boundary: snapshot.boundary,
    outcome_ref: snapshot.outcome_ref,
    requirements: snapshot.requirements,
    issues: snapshot.issues,
    user_correction_refs: snapshot.user_correction_refs,
    verification_refs: snapshot.verification_refs,
    artifacts: snapshot.artifacts,
    evidence_refs: snapshot.evidence_refs,
    experience_candidates: snapshot.experience_candidates,
    experience_refs: snapshot.experience_refs,
    experience_candidate_query: snapshot.experience_candidate_query,
    source_bindings: snapshot.source_bindings,
    source_fact_queries: snapshot.source_fact_queries,
    coverage: snapshot.coverage,
    policy_version: snapshot.policy_version,
    policy_snapshot_ref: snapshot.policy_snapshot_ref,
    permission_scope_ref: snapshot.permission_scope_ref,
    budget: snapshot.budget,
    output_policy: snapshot.output_policy
  };
  if (snapshot.authorization_ref !== undefined) {
    projection.authorization_ref = snapshot.authorization_ref;
  }
  return toJsonValue(projection);
}

function reviewSnapshotKey(snapshot: ReviewSnapshot): Hash {
  return canonicalHash(snapshotFrozenProjection(snapshot));
}

interface SnapshotHashes {
  snapshot_key: Hash;
  snapshot_hash: Hash;
}

export function computeSnapshotHashes(snapshot: ReviewSnapshot): SnapshotHashes {
  const key = reviewSnapshotKey(snapshot);
  const hash = canonicalHash(
    toJsonValue({
      schema_version: snapshot.schema_version,
      snapshot_key: key,
      frozenProjection: snapshotFrozenProjection(snapshot)
    })
  );
  return { snapshot_key: key, snapshot_hash: hash };
}

/* ------------------------------------------------------------------ */
/* Validity                                                            */
/* ------------------------------------------------------------------ */

const VALID_SNAPSHOT: SnapshotValidity = Object.freeze({
  valid: true,
  stale_reason: null,
  block_reason: null
});

function staleValidity(reason: SnapshotStaleReason): SnapshotValidity {
  return { valid: false, stale_reason: reason, block_reason: null };
}

export function blockedValidity(reason: "egress_not_approved"): SnapshotValidity {
  return { valid: false, stale_reason: null, block_reason: reason };
}

/** Source refs this snapshot declares as required (DD-REV-011). */
function requiredSourceRefs(snapshot: ReviewSnapshot): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const requirement of snapshot.requirements) {
    refs.push(requirement.quote_ref);
  }
  for (const issue of snapshot.issues) {
    refs.push(issue.question_ref);
  }
  refs.push(...snapshot.user_correction_refs);
  refs.push(...snapshot.verification_refs);
  refs.push(snapshot.outcome_ref);
  return sortedUniqueRefs(refs);
}

/** Refs whose frozen `retrievable` is false, in required-source order. */
function missingRequiredSourceRefs(snapshot: ReviewSnapshot): SourceRef[] {
  const required = requiredSourceRefs(snapshot);
  const byRef = new Map<SourceRef, boolean>();
  for (const binding of snapshot.source_bindings) {
    byRef.set(binding.ref, binding.retrievable);
  }
  return required.filter((ref) => byRef.get(ref) !== true);
}

export interface SnapshotValidityPorts {
  goal: GoalVersionReadPort;
  config: ConfigVersionReadPort;
  policySupported: (policyVersion: string) => boolean;
  supersededByJobId: string | null;
}

/**
 * Out-of-transaction precheck (DD-REV-011). Goal kind/data mismatch is stale;
 * a goal read failure is returned as an error, never as stale.
 */
export async function isSnapshotValid(
  snapshot: ReviewSnapshot,
  now: number,
  ports: SnapshotValidityPorts
): Promise<Result<SnapshotValidity, ErrorEnvelope>> {
  void now;
  if (ports.supersededByJobId !== null) {
    return ok(staleValidity("superseded"));
  }
  if (!ports.policySupported(snapshot.policy_version)) {
    return ok(staleValidity("policy_unsupported"));
  }
  if (missingRequiredSourceRefs(snapshot).length > 0) {
    return ok(staleValidity("source_missing"));
  }
  const goal = await ports.goal.getCurrentGoal({
    task_id: snapshot.version_binding.task_id,
    branch_id: snapshot.version_binding.branch_id
  });
  if (!goal.ok) {
    if (goal.error.code === "E_VERSION_BINDING") {
      return err(goal.error);
    }
    return err(
      makeErrorEnvelope({
        code: "E_REVIEW_GOAL_UNAVAILABLE",
        category: "ipc",
        message_key: "error.e_review_goal_unavailable",
        stage: "snapshot_validate",
        retryable: true,
        details: {
          kind: "ipc",
          method: "getCurrentGoal",
          connection_id: "goal",
          frame_kind: "read"
        }
      })
    );
  }
  if (goal.value.goal_version !== snapshot.version_binding.goal_version) {
    return ok(staleValidity("target_changed"));
  }
  const config = await ports.config.getCurrentConfigVersion({
    config_space: snapshot.host_event.binding.config_space
  });
  if (!config.ok) {
    if (config.error.category === "storage") {
      return err(config.error);
    }
    return ok(staleValidity("config_changed"));
  }
  if (config.value.config_version !== snapshot.version_binding.config_version) {
    return ok(staleValidity("config_changed"));
  }
  return ok(VALID_SNAPSHOT);
}

interface SnapshotTransactionPorts {
  goal: Pick<GoalVersionReadPort, "getCurrentGoalInTransaction">;
  config: Pick<ConfigVersionReadPort, "getCurrentConfigVersionInTransaction">;
  policySupported: (policyVersion: string) => boolean;
  supersededByJobId: string | null;
}

/**
 * Final gate inside C4 / `acceptOutput` (DD-REV-011). Only synchronous,
 * tx-bound reads are allowed here.
 */
export function isSnapshotValidInTransaction(
  tx: import("@evoplug/core").Tx,
  snapshot: ReviewSnapshot,
  now: number,
  ports: SnapshotTransactionPorts
): Result<SnapshotValidity, ErrorEnvelope> {
  void now;
  if (ports.supersededByJobId !== null) {
    return ok(staleValidity("superseded"));
  }
  if (!ports.policySupported(snapshot.policy_version)) {
    return ok(staleValidity("policy_unsupported"));
  }
  if (missingRequiredSourceRefs(snapshot).length > 0) {
    return ok(staleValidity("source_missing"));
  }
  const goal = ports.goal.getCurrentGoalInTransaction(tx, {
    task_id: snapshot.version_binding.task_id,
    branch_id: snapshot.version_binding.branch_id
  });
  if (!goal.ok) {
    if (goal.error.code === "E_VERSION_BINDING") {
      return ok(staleValidity("target_changed"));
    }
    return err(goal.error);
  }
  if (goal.value.goal_version !== snapshot.version_binding.goal_version) {
    return ok(staleValidity("target_changed"));
  }
  const config = ports.config.getCurrentConfigVersionInTransaction(tx, {
    config_space: snapshot.host_event.binding.config_space
  });
  if (!config.ok) {
    if (config.error.category === "storage") {
      return err(config.error);
    }
    return ok(staleValidity("config_changed"));
  }
  if (config.value.config_version !== snapshot.version_binding.config_version) {
    return ok(staleValidity("config_changed"));
  }
  return ok(VALID_SNAPSHOT);
}

/* ------------------------------------------------------------------ */
/* Candidate ordering and projection                                   */
/* ------------------------------------------------------------------ */

export function scopeRank(level: ReviewExperienceCandidate["scope"]["level"]): 1 | 2 | 3 | 4 {
  switch (level) {
    case "project":
      return 4;
    case "host":
      return 3;
    case "user":
      return 2;
    case "global":
      return 1;
  }
}

export function compareExperienceCandidates(
  left: ReviewExperienceCandidate,
  right: ReviewExperienceCandidate
): number {
  if (left.scope_rank !== right.scope_rank) {
    return right.scope_rank - left.scope_rank;
  }
  if (left.created_at !== right.created_at) {
    return right.created_at - left.created_at;
  }
  if (left.experience_id !== right.experience_id) {
    return compareUtf8(left.experience_id, right.experience_id);
  }
  return right.version - left.version;
}

/** Applies the fixed candidate order and per-experience dedupe. */
export function orderExperienceCandidates(
  candidates: readonly ReviewExperienceCandidate[]
): { candidates: ReviewExperienceCandidate[]; truncated: boolean } {
  const ordered = [...candidates].sort(compareExperienceCandidates);
  const seen = new Set<string>();
  const unique: ReviewExperienceCandidate[] = [];
  for (const candidate of ordered) {
    if (seen.has(candidate.experience_id)) {
      continue;
    }
    seen.add(candidate.experience_id);
    unique.push(candidate);
  }
  const truncated = unique.length > REVIEW_EXPERIENCE_CANDIDATE_LIMIT;
  return {
    candidates: unique.slice(0, REVIEW_EXPERIENCE_CANDIDATE_LIMIT),
    truncated
  };
}

export function experienceRefsOf(candidates: readonly ReviewExperienceCandidate[]): SourceRef[] {
  return sortedUniqueRefs(candidates.map((candidate) => candidate.source_ref));
}

/** V13e requires approved arrays to be exact subsequences of the input. */
export function isExactSubsequence(
  input: readonly SourceRef[],
  approved: readonly SourceRef[]
): boolean {
  let cursor = 0;
  for (const ref of input) {
    if (cursor < approved.length && approved[cursor] === ref) {
      cursor += 1;
    }
  }
  return cursor === approved.length;
}

export function coverageCoversExactly(
  input: readonly SourceRef[],
  approved: readonly SourceRef[],
  rejected: readonly SourceRef[]
): boolean {
  const inputSet = new Set(input);
  if (approved.length + rejected.length !== inputSet.size) {
    return false;
  }
  const seen = new Set<string>();
  for (const ref of approved) {
    if (!inputSet.has(ref) || seen.has(ref)) {
      return false;
    }
    seen.add(ref);
  }
  for (const ref of rejected) {
    if (!inputSet.has(ref) || seen.has(ref)) {
      return false;
    }
    seen.add(ref);
  }
  return seen.size === inputSet.size;
}

export function sortedSourceBindings(bindings: readonly ReviewSourceBinding[]): ReviewSourceBinding[] {
  const gateOrder: Record<"V9b" | "V13", number> = { V9b: 0, V13: 1 };
  const kindOrder: Record<"evidence" | "experience", number> = { evidence: 0, experience: 1 };
  return [...bindings].sort((left, right) => {
    if (left.gate !== right.gate) {
      return gateOrder[left.gate] - gateOrder[right.gate];
    }
    if (left.source_kind !== right.source_kind) {
      return kindOrder[left.source_kind] - kindOrder[right.source_kind];
    }
    return compareUtf8(left.ref, right.ref);
  });
}
