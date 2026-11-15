/**
 * ReviewScheduler: two-phase enqueue (DD-REV-010, DD-REV-140, DD-REV-151).
 *
 * `prepareEnqueue` is out-of-transaction and read-only. `enqueueInTransaction`
 * runs inside the HOST-triggered FND `commitLiveGated` stage: synchronous
 * reads only, staged Trigger via `resolveStateRow`, and exactly three REV
 * insert members (snapshot, request, job).
 */

import { canonicalHash, canonicalJson, canonicalJsonText, newId, toJsonValue } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, JsonValue, Result, SourceRef, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ConfigVersionView, GoalVersionReadPort } from "@evoplug/core";

import type { BudgetScopePolicyViewLike } from "./budget-contracts.js";
import {
  boundaryPending,
  egressNotApproved,
  idempotencyConflict,
  outputPolicyInvalid,
  quotaPolicyUnavailable,
  revError,
  schemaError,
  snapshotCollision,
  snapshotInvalid,
  snapshotSourceMissing,
  triggerInvalid,
  versionBindingError
} from "./errors.js";
import type {
  EgressApprovedSourcesInput,
  EgressApprovedSourcesPrepared,
  EgressApprovedSourcesView,
  EgressPolicyPreparationPort,
  EgressPolicyReadPort
} from "./egress-contracts.js";
import type {
  ReviewEnqueueRequest,
  ReviewEnqueueResult,
  TriggerEvent
} from "./host-contracts.js";
import type {
  DeferredReviewEnqueueError,
  ExperienceCandidatePage,
  ExperienceCandidateQuery,
  PreparedReviewEnqueue,
  ReviewEnqueueGate,
  ReviewEnqueueRequestRecord,
  ReviewOutputPolicySource,
  ReviewQuotaPolicy,
  ReviewSnapshot,
  ReviewSnapshotSourcePlan,
  ReviewSourceBinding,
  ReviewSourceFactPage,
  ReviewSourceFactQuery
} from "./types.js";
import { PREPARED_REVIEW_ENQUEUE_BRAND } from "./types.js";
import type {
  ExperienceCandidateReadPort,
  ReviewRepository,
  ReviewSnapshotSourceReadPort,
  ReviewSourceFactReadPort
} from "./ports.js";
import {
  REVIEW_EXPERIENCE_CANDIDATE_LIMIT,
  REVIEW_SOURCE_MAX_BYTES_PER_REF,
  computeBoundaryKey,
  computeReviewScopeKey,
  computeSnapshotHashes,
  computeTriggerDedupeKey,
  coverageCoversExactly,
  deriveVersionBinding,
  experienceCandidateQueryHash,
  experienceRefsOf,
  isExactSubsequence,
  orderExperienceCandidates,
  reviewQuotaPolicyHash,
  reviewSourceFactQueryHash,
  sortedUniqueRefs,
  sortedSourceBindings,
  triggerBindingHash,
  triggerEnqueueBinding,
  validateReviewOutputPolicy,
  validateReviewQuotaPolicy
} from "./snapshot.js";
import type { ReviewJob } from "./types.js";
import { buildReviewJob } from "./job.js";
import { blobRef, jobRowFromJob, snapshotRowFromSnapshot } from "./storage.js";
import type { LiveCommitStage } from "./ports.js";

/* ------------------------------------------------------------------ */
/* Preparation                                                         */
/* ------------------------------------------------------------------ */

export interface EnqueuePreparationDeps {
  repository: Pick<ReviewRepository, "getRequest" | "getJobByDedupeKey">;
  sourcePlan: ReviewSnapshotSourceReadPort;
  candidates: ExperienceCandidateReadPort;
  sourceFacts: ReviewSourceFactReadPort;
  egressPreparation: EgressPolicyPreparationPort;
  policySupported(policyVersion: string): boolean;
}

function deferred(
  gate: ReviewEnqueueGate,
  order: number,
  error: ErrorEnvelope,
  recovery: "reprepare" | "none"
): DeferredReviewEnqueueError {
  return {
    schema_version: "rsi.deferred_review_enqueue_error/1",
    gate,
    order,
    error,
    recovery
  };
}

const PREPARED_OBJECTS = new WeakSet<object>();

function emptyPrepared(
  overrides: Partial<PreparedReviewEnqueue> & Pick<PreparedReviewEnqueue, "preflight">
): PreparedReviewEnqueue {
  const prepared: PreparedReviewEnqueue = {
    [PREPARED_REVIEW_ENQUEUE_BRAND]: true,
    schema_version: "rsi.review_enqueue_prepared/1",
    request_id: null,
    request_hash: null,
    trigger_event_id: null,
    trigger_binding_hash: null,
    trigger_dedupe_key: null,
    existing: null,
    source_plan: null,
    experience_candidates: null,
    experience_candidate_query_hash: null,
    experience_candidates_truncated: null,
    evidence_refs: null,
    experience_refs: null,
    source_bindings: null,
    source_fact_queries: null,
    egress_input: null,
    egress_prepared: null,
    deferred: [],
    ...overrides,
    preflight: overrides.preflight
  };
  const frozen = deepFreeze(prepared);
  PREPARED_OBJECTS.add(frozen);
  return frozen;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

/**
 * `prepareEnqueue` steps 1–8. Business failures are frozen into `deferred`
 * and never thrown to HOST.
 */
export async function prepareReviewEnqueue(
  deps: EnqueuePreparationDeps,
  input: import("./types.js").PrepareReviewEnqueueInput
): Promise<PreparedReviewEnqueue> {
  const req = input.req;
  const trigger = input.trigger;

  let requestHash: Hash;
  let bindingHash: Hash;
  try {
    requestHash = canonicalHash(toJsonValue(req));
    bindingHash = triggerBindingHash(trigger);
  } catch {
    return emptyPrepared({ preflight: "not_prepared" });
  }
  if (trigger.decision !== "enqueue") {
    return emptyPrepared({
      preflight: "not_prepared",
      request_id: req.request_id,
      request_hash: requestHash,
      trigger_event_id: trigger.trigger_event_id,
      trigger_binding_hash: bindingHash,
      trigger_dedupe_key: req.trigger_dedupe_key
    });
  }

  try {
    const existingRequest = await deps.repository.getRequest(req.request_id);
    if (existingRequest !== null) {
      return emptyPrepared({
        preflight: "existing_request",
        request_id: req.request_id,
        request_hash: requestHash,
        trigger_event_id: trigger.trigger_event_id,
        trigger_binding_hash: bindingHash,
        trigger_dedupe_key: req.trigger_dedupe_key,
        existing: {
          request_id: req.request_id,
          request_hash: existingRequest.request_hash,
          review_job_id: existingRequest.review_job_id as Id<"job">
        }
      });
    }
    const existingJob = await deps.repository.getJobByDedupeKey(req.trigger_dedupe_key);
    if (existingJob !== null) {
      return emptyPrepared({
        preflight: "existing_dedupe",
        request_id: req.request_id,
        request_hash: requestHash,
        trigger_event_id: trigger.trigger_event_id,
        trigger_binding_hash: bindingHash,
        trigger_dedupe_key: req.trigger_dedupe_key,
        existing: {
          request_id: req.request_id,
          request_hash: requestHash,
          review_job_id: existingJob.job_id
        }
      });
    }
  } catch (error) {
    return emptyPrepared({
      preflight: "preflight_unavailable",
      request_id: req.request_id,
      request_hash: requestHash,
      trigger_event_id: trigger.trigger_event_id,
      trigger_binding_hash: bindingHash,
      trigger_dedupe_key: req.trigger_dedupe_key,
      deferred: [
        deferred("V13", 0, revError({
          code: "E_STORAGE_UNAVAILABLE",
          details: { kind: "storage", operation: "prepare_preflight" }
        }), "reprepare")
      ]
    });
  }

  const deferredErrors: DeferredReviewEnqueueError[] = [];
  const sourcePlan = await deps.sourcePlan.readSourcePlan({
    schema_version: "rsi.review_snapshot_source_query/1",
    request: req,
    trigger,
    now: req.created_at
  });
  let plan: ReviewSnapshotSourcePlan | null = null;
  if (sourcePlan.ok) {
    plan = sourcePlan.value;
  } else {
    deferredErrors.push(deferred("V13", 1, sourcePlan.error, "reprepare"));
  }

  let candidatePage: ExperienceCandidatePage | null = null;
  let candidateQueryHash: Hash | null = null;
  let experienceRefs: SourceRef[] | null = null;
  if (plan !== null) {
    const candidateQuery: ExperienceCandidateQuery = {
      schema_version: "rsi.experience_candidate_query/1",
      version_binding: plan.version_binding,
      host_binding: trigger.host_binding,
      project_id: trigger.scope.project_id ?? null,
      now: req.created_at,
      limit: REVIEW_EXPERIENCE_CANDIDATE_LIMIT
    };
    candidateQueryHash = experienceCandidateQueryHash(candidateQuery);
    const page = await deps.candidates.listCandidates(candidateQuery);
    if (page.ok) {
      const ordered = orderExperienceCandidates(page.value.candidates);
      candidatePage = { ...page.value, candidates: ordered.candidates, truncated: ordered.truncated };
      experienceRefs = experienceRefsOf(ordered.candidates);
    } else {
      deferredErrors.push(deferred("V13", 2, page.error, "reprepare"));
    }
  }

  const evidenceRefs = plan === null ? null : sortedUniqueRefs(plan.evidence_refs);
  const v9bRefs = plan === null
    ? null
    : sortedUniqueRefs([plan.stable_evidence_ref, ...plan.missing_evidence_refs]);
  const v13Refs = evidenceRefs === null || experienceRefs === null
    ? null
    : sortedUniqueRefs([...evidenceRefs, ...experienceRefs]);

  let facts: ReviewSourceBinding[] | null = null;
  let sourceFactQueries: { v9b: Hash; v13: Hash } | null = null;
  if (v9bRefs !== null && v13Refs !== null) {
    const v9bQuery: ReviewSourceFactQuery = {
      schema_version: "rsi.review_source_fact_query/1",
      gate: "V9b",
      refs: v9bRefs,
      deadline_at: req.created_at + 60_000,
      max_bytes_per_ref: REVIEW_SOURCE_MAX_BYTES_PER_REF
    };
    const v13Query: ReviewSourceFactQuery = {
      schema_version: "rsi.review_source_fact_query/1",
      gate: "V13",
      refs: v13Refs,
      deadline_at: req.created_at + 60_000,
      max_bytes_per_ref: REVIEW_SOURCE_MAX_BYTES_PER_REF
    };
    sourceFactQueries = {
      v9b: reviewSourceFactQueryHash(v9bQuery),
      v13: reviewSourceFactQueryHash(v13Query)
    };
    const v9bPage = await deps.sourceFacts.readFacts(v9bQuery);
    const v13Page = await deps.sourceFacts.readFacts(v13Query);
    if (v9bPage.ok && v13Page.ok) {
      facts = sortedSourceBindings([...v9bPage.value.facts, ...v13Page.value.facts]);
    } else {
      if (!v9bPage.ok) deferredErrors.push(deferred("V9b", 0, v9bPage.error, "none"));
      if (!v13Page.ok) deferredErrors.push(deferred("V13", 3, v13Page.error, "none"));
    }
  }

  let egressInput: EgressApprovedSourcesInput | null = null;
  let egressPrepared: EgressApprovedSourcesPrepared | null = null;
  if (evidenceRefs !== null && experienceRefs !== null) {
    egressInput = {
      schema_version: "rsi.egress_approved_sources_in/1",
      policy_ref: "egress://default",
      evidence_refs: evidenceRefs,
      experience_refs: experienceRefs
    };
    const prepared = await deps.egressPreparation.prepareApprovedSources(egressInput);
    if (prepared.ok) {
      egressPrepared = prepared.value;
    } else {
      deferredErrors.push(deferred("V13e", 0, prepared.error, "reprepare"));
    }
  }

  const early = earlyGateErrors(req, plan, facts);
  for (const entry of early) {
    deferredErrors.push(entry);
  }
  deferredErrors.sort((left, right) => {
    const gateOrder: Record<ReviewEnqueueGate, number> = { V9b: 0, V13: 1, V13e: 2 };
    return gateOrder[left.gate] - gateOrder[right.gate] || left.order - right.order;
  });

  return emptyPrepared({
    preflight: "new",
    request_id: req.request_id,
    request_hash: requestHash,
    trigger_event_id: trigger.trigger_event_id,
    trigger_binding_hash: bindingHash,
    trigger_dedupe_key: req.trigger_dedupe_key,
    source_plan: plan,
    experience_candidates: candidatePage === null ? null : candidatePage.candidates,
    experience_candidate_query_hash: candidateQueryHash,
    experience_candidates_truncated: candidatePage === null ? null : candidatePage.truncated,
    evidence_refs: evidenceRefs,
    experience_refs: experienceRefs === null ? null : [...experienceRefs],
    source_bindings: facts,
    source_fact_queries: sourceFactQueries,
    egress_input: egressInput,
    egress_prepared: egressPrepared,
    deferred: deferredErrors
  });
}

function earlyGateErrors(
  req: ReviewEnqueueRequest,
  plan: ReviewSnapshotSourcePlan | null,
  facts: ReviewSourceBinding[] | null
): DeferredReviewEnqueueError[] {
  const errors: DeferredReviewEnqueueError[] = [];
  if (plan === null || facts === null) {
    return errors;
  }
  const byRef = new Map(facts.map((binding) => [binding.ref, binding]));
  const stable = byRef.get(plan.stable_evidence_ref);
  if (stable === undefined || !stable.retrievable) {
    errors.push(
      deferred(
        "V9b",
        1,
        snapshotSourceMissing(plan.stable_evidence_ref, stable === undefined ? "missing" : "tombstoned"),
        "none"
      )
    );
  }
  for (const ref of plan.missing_evidence_refs) {
    const binding = byRef.get(ref);
    if (binding === undefined || !binding.retrievable) {
      errors.push(
        deferred("V9b", 2, snapshotSourceMissing(ref, binding === undefined ? "missing" : "tombstoned"), "none")
      );
    }
  }
  if (req.snapshot_request.completeness === "complete") {
    if (plan.missing_requirement_ids.length > 0) {
      errors.push(
        deferred("V13", 4, snapshotSourceMissing("requirements", "missing"), "none")
      );
    }
    if (plan.outcome_ref === null) {
      errors.push(deferred("V13", 5, snapshotSourceMissing("outcome", "missing"), "none"));
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Gate predicates                                                     */
/* ------------------------------------------------------------------ */

const ENVELOPE_KEYS: readonly string[] = [
  "schema_version",
  "request_id",
  "trigger_event_id",
  "trigger_kind",
  "review_scope_key",
  "boundary_key",
  "signal_digest",
  "trigger_dedupe_key",
  "stable_event_ids",
  "stable_watermark",
  "goal_version",
  "scope",
  "pending_state",
  "pending_work_refs",
  "stable",
  "stable_evidence_ref",
  "policy_ref",
  "origin",
  "capability_snapshot_hash",
  "budget_policy_ref",
  "review_kind",
  "authorization_ref",
  "snapshot_request",
  "created_at"
];

const PENDING_WORK_REF_KEYS: readonly string[] = [
  "pending_id",
  "kind",
  "state",
  "evidence_ref"
];

const PENDING_WORK_KINDS: readonly string[] = [
  "delivery",
  "review_defer",
  "generation_resume"
];

function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: JsonValue): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * V1 structural envelope check (DD-REV-010). The generated validator is the
 * integration seam; this keeps the same closed shape and the HOST
 * `PendingWorkRef` object shape used by persisted snapshot/job rows.
 */
export function validateEnqueueEnvelope(req: ReviewEnqueueRequest): Result<ReviewEnqueueRequest, ErrorEnvelope> {
  const value = toJsonValue(req);
  if (!isJsonRecord(value)) {
    return err(schemaError("$", "object"));
  }
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.includes(key) && key !== "supersedes_job_id") {
      // DD-REV-010 V1: unknown fields are a structural failure and the gate
      // has exactly one failure code, `E_SCHEMA`.
      return err(schemaError(key, "known_field"));
    }
  }
  if (value["schema_version"] !== "rsi.review_enqueue/1") {
    return err(schemaError("schema_version", "const"));
  }
  for (const field of [
    "request_id",
    "trigger_event_id",
    "trigger_kind",
    "review_scope_key",
    "boundary_key",
    "signal_digest",
    "trigger_dedupe_key",
    "goal_version",
    "stable_evidence_ref",
    "capability_snapshot_hash",
    "budget_policy_ref"
  ]) {
    const entry = value[field];
    if (typeof entry !== "string" || entry.length === 0) {
      return err(schemaError(field, "non_empty_string"));
    }
  }
  if (!isStringArray(value["stable_event_ids"] ?? null)) {
    return err(schemaError("stable_event_ids", "string_array"));
  }
  if (!Number.isSafeInteger(value["stable_watermark"])) {
    return err(schemaError("stable_watermark", "safe_integer"));
  }
  if (!isJsonRecord(value["scope"] ?? null)) {
    return err(schemaError("scope", "object"));
  }
  const pendingState = value["pending_state"];
  if (pendingState !== "none" && pendingState !== "pending" && pendingState !== "unknown") {
    return err(schemaError("pending_state", "enum"));
  }
  const pendingRefs = value["pending_work_refs"];
  if (!Array.isArray(pendingRefs)) {
    return err(schemaError("pending_work_refs", "array"));
  }
  for (let index = 0; index < pendingRefs.length; index += 1) {
    const entry = pendingRefs[index];
    const path = `pending_work_refs[${String(index)}]`;
    if (entry === undefined || !isJsonRecord(entry)) {
      return err(schemaError(path, "object"));
    }
    const keys = Object.keys(entry);
    if (keys.length !== PENDING_WORK_REF_KEYS.length || keys.some((key) => !PENDING_WORK_REF_KEYS.includes(key))) {
      return err(schemaError(path, "pending_work_ref_shape"));
    }
    for (const key of PENDING_WORK_REF_KEYS) {
      const fieldValue = entry[key];
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        return err(schemaError(`${path}.${key}`, "non_empty_string"));
      }
    }
    const kind = entry["kind"];
    if (typeof kind !== "string" || !PENDING_WORK_KINDS.includes(kind)) {
      return err(schemaError(`${path}.kind`, "enum"));
    }
  }
  if (typeof value["stable"] !== "boolean") {
    return err(schemaError("stable", "boolean"));
  }
  if (!isJsonRecord(value["policy_ref"] ?? null)) {
    return err(schemaError("policy_ref", "object"));
  }
  if (!isJsonRecord(value["origin"] ?? null)) {
    return err(schemaError("origin", "object"));
  }
  const reviewKind = value["review_kind"];
  if (reviewKind !== "auto" && reviewKind !== "explicit") {
    return err(schemaError("review_kind", "enum"));
  }
  const authorizationRef = value["authorization_ref"];
  if (authorizationRef !== null && (typeof authorizationRef !== "string" || authorizationRef.length === 0)) {
    return err(schemaError("authorization_ref", "string_or_null"));
  }
  if (!Number.isSafeInteger(value["created_at"])) {
    return err(schemaError("created_at", "safe_integer"));
  }
  const snapshotRequest = value["snapshot_request"];
  if (!isJsonRecord(snapshotRequest)) {
    return err(schemaError("snapshot_request", "object"));
  }
  const mode = snapshotRequest["mode"];
  if (mode !== "stable" && mode !== "explicit_stage") {
    return err(schemaError("snapshot_request.mode", "enum"));
  }
  const completeness = snapshotRequest["completeness"];
  if (completeness !== "complete" && completeness !== "staged_with_gaps") {
    return err(schemaError("snapshot_request.completeness", "enum"));
  }
  if (!isStringArray(snapshotRequest["missing_evidence_refs"] ?? null)) {
    return err(schemaError("snapshot_request.missing_evidence_refs", "source_ref_array"));
  }
  return ok(req);
}

/**
 * V2: the four HOST keys in the request must equal the values recomputed from
 * the reloaded TriggerEvent (DD-REV-010). A caller-injected mutation of any
 * key is a trigger binding failure, not a schema failure.
 */
export function validateTriggerKeys(
  req: ReviewEnqueueRequest,
  trigger: TriggerEvent
): ErrorEnvelope | null {
  if (trigger.decision !== "enqueue") {
    return triggerInvalid("decision", "enqueue");
  }
  if (req.trigger_event_id !== trigger.trigger_event_id) {
    return triggerInvalid("trigger_event_id", "reloaded");
  }
  const reviewKind: "auto" | "explicit" =
    trigger.request_intent === "explicit_review" ? "explicit" : "auto";
  const reviewScopeKey = computeReviewScopeKey({
    scope: trigger.scope,
    stable_watermark: trigger.boundary.stable_watermark,
    stable_event_ids: trigger.boundary.stable_event_ids,
    pending_state: trigger.boundary.pending_state,
    pending_work_refs: trigger.boundary.pending_work_refs,
    review_kind: reviewKind
  });
  const boundaryKey = computeBoundaryKey({
    scope: trigger.scope,
    boundary_kind: trigger.boundary.boundary_kind,
    stable_watermark: trigger.boundary.stable_watermark,
    stable_event_ids: trigger.boundary.stable_event_ids
  });
  // HOST owns the signal digest formula; REV recomputes the keys it derives
  // from the stored HOST digest instead of re-deriving signals locally.
  const signalDigest = trigger.dedupe.signal_digest;
  const triggerDedupeKey = computeTriggerDedupeKey({
    boundary_key: boundaryKey,
    signal_digest: signalDigest,
    review_kind: reviewKind
  });
  if (req.review_scope_key !== reviewScopeKey) {
    return triggerInvalid("review_scope_key", "host_recompute");
  }
  if (req.boundary_key !== boundaryKey) {
    return triggerInvalid("boundary_key", "host_recompute");
  }
  if (req.signal_digest !== signalDigest) {
    return triggerInvalid("signal_digest", "host_recompute");
  }
  if (req.trigger_dedupe_key !== triggerDedupeKey) {
    return triggerInvalid("trigger_dedupe_key", "host_recompute");
  }
  return null;
}

/** V5: review_kind vs snapshot_request discriminant. */
export function validateReviewKindDiscriminant(req: ReviewEnqueueRequest): ErrorEnvelope | null {
  const request = req.snapshot_request;
  if (req.review_kind === "auto") {
    if (
      request.mode !== "stable" ||
      request.completeness !== "complete" ||
      request.missing_evidence_refs.length !== 0 ||
      req.authorization_ref !== null
    ) {
      return triggerInvalid("review_kind", "auto_stable_complete_no_grant");
    }
    return null;
  }
  if (req.authorization_ref === null) {
    return triggerInvalid("authorization_ref", "explicit_requires_grant");
  }
  if (req.stable) {
    return request.mode === "stable" &&
      request.completeness === "complete" &&
      request.missing_evidence_refs.length === 0
      ? null
      : triggerInvalid("snapshot_request", "explicit_stable_complete");
  }
  return request.mode === "explicit_stage" && request.completeness === "staged_with_gaps"
    ? null
    : triggerInvalid("snapshot_request", "explicit_stage_gaps");
}

/** V6: origin and suppression. */
export function validateOrigin(req: ReviewEnqueueRequest): ErrorEnvelope | null {
  if (req.origin.kind === "evaluator" || req.origin.kind === "evaluator_descendant") {
    return triggerInvalid("origin.kind", "evaluator_forbidden");
  }
  if (req.review_kind === "auto") {
    if (req.origin.suppress_automatic) {
      return triggerInvalid("origin.suppress_automatic", "false");
    }
    if (req.origin.kind !== "human" && req.origin.kind !== "host_auto") {
      return triggerInvalid("origin.kind", "human_or_host_auto");
    }
  }
  return null;
}

/** V7: automatic boundary. */
export function validateAutoBoundary(req: ReviewEnqueueRequest, trigger: TriggerEvent): ErrorEnvelope | null {
  if (req.review_kind !== "auto") {
    return null;
  }
  if (
    !trigger.boundary.stable ||
    trigger.boundary.pending_state !== "none" ||
    trigger.boundary.pending_work_refs.length !== 0 ||
    req.snapshot_request.completeness !== "complete" ||
    trigger.identity_quality === "missing"
  ) {
    return boundaryPending("boundary", "auto_requires_stable_complete_no_pending");
  }
  return null;
}

/** V8: explicit authorization presence; FND revalidates scope/actions/mode. */
export function validateExplicitAuthorization(req: ReviewEnqueueRequest): ErrorEnvelope | null {
  if (req.review_kind !== "explicit") {
    return null;
  }
  if (req.authorization_ref === null) {
    return revError({
      code: "E_AUTH_DENIED",
      stage: "trigger_validate",
      details: { kind: "authorization", object_type: "experience", denied_dimension: "action" }
    });
  }
  return null;
}

/** V9a: explicit boundary shape. */
export function validateExplicitBoundaryShape(req: ReviewEnqueueRequest): ErrorEnvelope | null {
  if (req.review_kind !== "explicit") {
    return null;
  }
  if (req.stable) {
    if (
      req.pending_state !== "none" ||
      req.pending_work_refs.length !== 0 ||
      req.snapshot_request.mode !== "stable" ||
      req.snapshot_request.missing_evidence_refs.length !== 0
    ) {
      return boundaryPending("snapshot_request", "explicit_stable_shape");
    }
    return null;
  }
  if (
    req.snapshot_request.mode !== "explicit_stage" ||
    req.snapshot_request.completeness !== "staged_with_gaps" ||
    req.snapshot_request.missing_evidence_refs.length === 0
  ) {
    return boundaryPending("snapshot_request", "explicit_stage_missing_refs");
  }
  return null;
}

/** V10: request fields equal the reloaded TriggerEvent. */
export function validateRequestAgainstTrigger(req: ReviewEnqueueRequest, trigger: TriggerEvent): ErrorEnvelope | null {
  if (req.stable !== trigger.boundary.stable) {
    return triggerInvalid("stable", "trigger_equality");
  }
  if (req.pending_state !== trigger.boundary.pending_state) {
    return triggerInvalid("pending_state", "trigger_equality");
  }
  if (canonicalJsonText(toJsonValue(req.pending_work_refs)) !== canonicalJsonText(toJsonValue(trigger.boundary.pending_work_refs))) {
    return triggerInvalid("pending_work_refs", "trigger_equality");
  }
  if (req.goal_version !== trigger.scope.goal_version) {
    return triggerInvalid("goal_version", "trigger_equality");
  }
  if (req.stable_watermark !== trigger.boundary.stable_watermark) {
    return triggerInvalid("stable_watermark", "trigger_equality");
  }
  if (req.policy_ref.policy_id !== trigger.policy_ref.policy_id) {
    return triggerInvalid("policy_ref", "trigger_equality");
  }
  return null;
}

/** V11: derives the six-field binding and compares scope fields. */
export function validateVersionBinding(
  req: ReviewEnqueueRequest,
  trigger: TriggerEvent,
  watermark: number
): Result<VersionBinding, ErrorEnvelope> {
  const derived = deriveVersionBinding(trigger.scope, watermark);
  if (!derived.ok) {
    return err(derived.error);
  }
  if (req.scope.task_id !== derived.value.task_id || req.scope.branch_id !== derived.value.branch_id) {
    return err(versionBindingError("scope", "trigger_scope"));
  }
  if (req.scope.input_epoch !== derived.value.input_epoch) {
    return err(versionBindingError("input_epoch", String(derived.value.input_epoch)));
  }
  if (req.goal_version !== derived.value.goal_version) {
    return err(versionBindingError("goal_version", derived.value.goal_version));
  }
  if (req.scope.config_version !== derived.value.config_version) {
    return err(versionBindingError("config_version", derived.value.config_version));
  }
  return ok(derived.value);
}

/** V12a/V12b: copies the FND scope and validates the quota hash. */
export function buildQuotaPolicyFromView(
  view: BudgetScopePolicyViewLike
): Result<ReviewQuotaPolicy, ErrorEnvelope> {
  if (view.budget_policy_version !== "bpol/1") {
    return err(quotaPolicyUnavailable("bpol/1", view.budget_policy_version));
  }
  if (view.scope.purpose !== "review_generate") {
    return err(quotaPolicyUnavailable("review_generate", view.scope.purpose));
  }
  const base: Omit<ReviewQuotaPolicy, "quota_policy_hash"> = {
    schema_version: "rsi.review_quota_policy/1",
    budget_policy_ref: view.budget_policy_ref,
    budget_policy_version: view.budget_policy_version,
    budget_policy_hash: view.content_hash,
    purpose: "review_generate",
    max_attempts: view.scope.max_attempts,
    max_input_tokens: view.scope.max_input_tokens,
    max_output_tokens: view.scope.max_output_tokens,
    request_max_tokens: view.scope.request_max_tokens,
    question_max_tokens: view.scope.question_max_tokens,
    request_margin_tokens: view.scope.request_margin_tokens,
    question_margin_tokens: view.scope.question_margin_tokens,
    max_cost_micros: view.scope.max_cost_micros,
    wall_ms: view.scope.wall_ms,
    reserve_ms: view.scope.reserve_ms,
    min_work_ms: view.scope.min_work_ms,
    attempt_charge_at: "claim",
    attempt_refundable: false
  };
  const policy: ReviewQuotaPolicy = { ...base, quota_policy_hash: reviewQuotaPolicyHash(base) };
  const valid = validateReviewQuotaPolicy(policy);
  return valid.ok ? ok(valid.value) : err(valid.error);
}

export function validateOutputPolicy(
  source: ReviewOutputPolicySource
): Result<import("./types.js").ReviewOutputPolicyRef, ErrorEnvelope> {
  const policy = source.load();
  const valid = validateReviewOutputPolicy(policy);
  return valid.ok ? ok(valid.value) : err(valid.error);
}

/** V13: the tx-derived source plan must match the frozen hash. */
export function validateSourcePlan(
  frozen: ReviewSnapshotSourcePlan,
  recomputed: ReviewSnapshotSourcePlan
): ErrorEnvelope | null {
  if (frozen.source_plan_hash !== recomputed.source_plan_hash) {
    return snapshotSourceMissing("source_plan", "hash_mismatch");
  }
  return null;
}

/** V13e: approved arrays are exact subsequences of the frozen input. */
export function validateEgressView(
  input: EgressApprovedSourcesInput,
  view: EgressApprovedSourcesView
): ErrorEnvelope | null {
  if (!isExactSubsequence(input.evidence_refs, view.approved_evidence_refs)) {
    return egressNotApproved({
      policyVersion: view.egress_policy_version,
      refs: view.approved_evidence_refs
    });
  }
  if (!isExactSubsequence(input.experience_refs, view.approved_experience_refs)) {
    return egressNotApproved({
      policyVersion: view.egress_policy_version,
      refs: view.approved_experience_refs
    });
  }
  const approved = [...view.approved_evidence_refs, ...view.approved_experience_refs];
  const rejected = view.rejected_sources.map((item) => item.ref);
  const union = sortedUniqueRefs([...input.evidence_refs, ...input.experience_refs]);
  if (!coverageCoversExactly(union, approved, rejected)) {
    return egressNotApproved({
      policyVersion: view.egress_policy_version,
      refs: approved,
      deniedDimension: "approval"
    });
  }
  return null;
}

/** V14: recompute both hashes and reject a same-key collision. */
export function validateSnapshotHash(
  snapshot: ReviewSnapshot,
  existing: { snapshot_hash: Hash } | null
): ErrorEnvelope | null {
  const computed = computeSnapshotHashes(snapshot);
  if (computed.snapshot_key !== snapshot.snapshot_key || computed.snapshot_hash !== snapshot.snapshot_hash) {
    return snapshotInvalid("snapshot_hash", "recomputed");
  }
  if (existing !== null && existing.snapshot_hash !== computed.snapshot_hash) {
    return snapshotCollision(existing.snapshot_hash, computed.snapshot_hash);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Snapshot construction                                               */
/* ------------------------------------------------------------------ */

export interface BuildSnapshotInput {
  snapshot_id: Id<"snap">;
  request: ReviewEnqueueRequest;
  trigger: TriggerEvent;
  prepared: PreparedReviewEnqueue;
  version_binding: VersionBinding;
  quota: ReviewQuotaPolicy;
  output_policy: import("./types.js").ReviewOutputPolicyRef;
  egress: EgressApprovedSourcesView;
  permission_scope_ref: string;
  now: number;
}

export function buildReviewSnapshot(input: BuildSnapshotInput): ReviewSnapshot {
  const plan = input.prepared.source_plan;
  if (plan === null) {
    throw new RangeError("snapshot requires a source plan");
  }
  const candidates = input.prepared.experience_candidates ?? [];
  const experienceRefs = input.prepared.experience_refs ?? [];
  const sourceBindings = input.prepared.source_bindings ?? [];
  const queries = input.prepared.source_fact_queries ?? {
    v9b: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    v13: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  };
  if (plan.outcome_ref === null) {
    throw new RangeError("snapshot requires a retrievable outcome_ref");
  }
  const snapshot: ReviewSnapshot = {
    schema_version: "rsi.review_snapshot/1",
    snapshot_id: input.snapshot_id,
    snapshot_key: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    version_binding: input.version_binding,
    snapshot_scope: input.request.stable ? "stable_boundary" : "explicit_stage",
    trigger: {
      trigger_event_id: input.trigger.trigger_event_id,
      trigger_kind: input.request.trigger_kind as ReviewSnapshot["trigger"]["trigger_kind"],
      origin: input.request.origin,
      review_kind: input.request.review_kind,
      signal_kinds: [...new Set(input.trigger.signals.map((signal) => signal.type))].sort(),
      stable_event_ids: [...input.trigger.boundary.stable_event_ids].sort(),
      review_scope_key: input.request.review_scope_key,
      boundary_key: input.request.boundary_key,
      signal_digest: input.request.signal_digest,
      trigger_dedupe_key: input.request.trigger_dedupe_key,
      policy_ref: input.request.policy_ref,
      policy_hash: input.request.policy_ref.policy_hash,
      capability_snapshot_hash: input.request.capability_snapshot_hash
    },
    host_event: {
      binding: input.trigger.host_binding,
      source_event_ref: input.trigger.source_event_ref,
      raw_event_ref: input.trigger.raw_event_ref
    },
    boundary: {
      stable: input.trigger.boundary.stable,
      boundary_kind: input.trigger.boundary.boundary_kind,
      stable_watermark: input.trigger.boundary.stable_watermark,
      goal_version: input.trigger.scope.goal_version,
      pending_state: input.trigger.boundary.pending_state,
      pending_work_refs: [...input.trigger.boundary.pending_work_refs],
      completeness: input.request.snapshot_request.completeness,
      missing_evidence_refs:
        input.request.snapshot_request.mode === "explicit_stage"
          ? [...input.request.snapshot_request.missing_evidence_refs]
          : [],
      stable_evidence_ref: input.request.stable_evidence_ref
    },
    outcome_ref: plan.outcome_ref,
    requirements: plan.requirements,
    issues: plan.issues,
    user_correction_refs: plan.user_correction_refs,
    verification_refs: plan.verification_refs,
    artifacts: plan.artifacts,
    evidence_refs: plan.evidence_refs,
    experience_candidates: [...candidates],
    experience_refs: [...experienceRefs],
    experience_candidate_query: {
      query_hash:
        input.prepared.experience_candidate_query_hash ??
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      limit: REVIEW_EXPERIENCE_CANDIDATE_LIMIT,
      truncated: input.prepared.experience_candidates_truncated ?? false
    },
    source_bindings: [...sourceBindings],
    source_fact_queries: queries,
    coverage: {
      included: plan.requirements.length > 0
        ? ["requirements", "issues", "user_corrections", "verifications", "artifacts", "outcome", "experience_candidates"]
        : ["outcome", "experience_candidates"],
      omitted_refs: [],
      missing_requirement_ids: plan.missing_requirement_ids,
      egress_policy_ref: input.egress.egress_policy_ref,
      egress_policy_version: input.egress.egress_policy_version,
      egress_approved_refs: input.egress.approved_evidence_refs,
      egress_approved_experience_refs: input.egress.approved_experience_refs
    },
    policy_version: input.request.policy_ref.policy_version,
    policy_snapshot_ref: input.trigger.policy_snapshot_ref,
    permission_scope_ref: input.permission_scope_ref,
    budget: input.quota,
    output_policy: input.output_policy,
    snapshot_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    created_at: input.now
  };
  if (input.request.review_kind === "explicit") {
    snapshot.authorization_ref = input.request.authorization_ref;
  }
  const hashes = computeSnapshotHashes(snapshot);
  snapshot.snapshot_key = hashes.snapshot_key;
  snapshot.snapshot_hash = hashes.snapshot_hash;
  return snapshot;
}

export function snapshotBodyRef(snapshot: ReviewSnapshot): SourceRef {
  return blobRef(snapshot.snapshot_hash, canonicalJsonLength(snapshot));
}

function canonicalJsonLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJsonText(toJsonValue(value))).byteLength;
}

/* ------------------------------------------------------------------ */
/* Final transaction                                                   */
/* ------------------------------------------------------------------ */

export interface SchedulerTransactionDeps {
  budgetPolicy: import("./budget-contracts.js").BudgetPolicyReadPortLike;
  outputPolicy: ReviewOutputPolicySource;
  egressRead: EgressPolicyReadPort;
  permissionScopeRef: string;
  policySupported(policyVersion: string): boolean;
}

export interface EnqueueTransactionInput {
  stage: LiveCommitStage;
  req: ReviewEnqueueRequest;
  prepared: PreparedReviewEnqueue;
  trigger: TriggerEvent;
  deps: SchedulerTransactionDeps;
  now: number;
}

/**
 * V1..V14 inside the synchronous stage. The caller has already reloaded the
 * staged TriggerEvent through `stage.resolveStateRow`.
 */
export function enqueueInTransactionSync(
  input: EnqueueTransactionInput
): Result<{ snapshot: ReviewSnapshot; job: ReviewJob; result: ReviewEnqueueResult }, ErrorEnvelope> {
  const { req, prepared, stage } = input;
  if (!PREPARED_OBJECTS.has(prepared)) {
    return err(schemaError("prepared", "rev_brand"));
  }
  const envelope = validateEnqueueEnvelope(req);
  if (!envelope.ok) {
    return err(envelope.error);
  }
  if (
    prepared.request_hash === null ||
    prepared.trigger_binding_hash === null ||
    prepared.request_hash !== canonicalHash(toJsonValue(req)) ||
    prepared.trigger_binding_hash !== triggerBindingHash(input.trigger)
  ) {
    return err(schemaError("prepared", "abi_binding"));
  }
  const v2 = validateTriggerKeys(req, input.trigger);
  if (v2 !== null) {
    return err(v2);
  }
  if (
    req.trigger_kind !== "task_stable" &&
    req.trigger_kind !== "user_review_request" &&
    req.trigger_kind !== "experience_trigger" &&
    req.trigger_kind !== "session_end"
  ) {
    return err(triggerInvalid("trigger_kind", "review_trigger_kind"));
  }
  if (req.review_kind === "auto" && req.trigger_kind === "user_review_request") {
    return err(triggerInvalid("trigger_kind", "auto_excludes_user_review_request"));
  }
  const v5 = validateReviewKindDiscriminant(req);
  if (v5 !== null) return err(v5);
  const v6 = validateOrigin(req);
  if (v6 !== null) return err(v6);
  const v7 = validateAutoBoundary(req, input.trigger);
  if (v7 !== null) return err(v7);
  const v8 = validateExplicitAuthorization(req);
  if (v8 !== null) return err(v8);
  const v9 = validateExplicitBoundaryShape(req);
  if (v9 !== null) return err(v9);
  const v10 = validateRequestAgainstTrigger(req, input.trigger);
  if (v10 !== null) return err(v10);
  const v11 = validateVersionBinding(req, input.trigger, input.prepared.source_plan?.version_binding.watermark ?? input.trigger.boundary.stable_watermark);
  if (!v11.ok) return err(v11.error);

  const budgetView = input.deps.budgetPolicy.getScopeInTransaction(stage.tx, {
    budget_policy_ref: req.budget_policy_ref,
    purpose: "review_generate"
  });
  if (!budgetView.ok) {
    return err(quotaPolicyUnavailable(req.budget_policy_ref, budgetView.error.code));
  }
  const quota = buildQuotaPolicyFromView(budgetView.value);
  if (!quota.ok) return err(quota.error);
  const outputPolicy = validateOutputPolicy(input.deps.outputPolicy);
  if (!outputPolicy.ok) return err(outputPolicy.error);

  if (prepared.egress_input === null || prepared.egress_prepared === null) {
    const deferredError = prepared.deferred.find((entry) => entry.gate === "V13e");
    if (deferredError !== undefined) {
      return err(deferredError.error);
    }
    return err(egressNotApproved({ policyVersion: "egress/default", refs: [] }));
  }
  const egress = input.deps.egressRead.getApprovedSourcesInTransaction(
    stage.tx,
    prepared.egress_input,
    prepared.egress_prepared
  );
  if (!egress.ok) {
    return err(egress.error);
  }
  const egressError = validateEgressView(prepared.egress_input, egress.value);
  if (egressError !== null) {
    return err(egressError);
  }

  const snapshotId = newId("snap");
  const snapshot = buildReviewSnapshot({
    snapshot_id: snapshotId,
    request: req,
    trigger: input.trigger,
    prepared,
    version_binding: v11.value,
    quota: quota.value,
    output_policy: outputPolicy.value,
    egress: egress.value,
    permission_scope_ref: input.deps.permissionScopeRef,
    now: input.now
  });
  const computed = computeSnapshotHashes(snapshot);
  if (computed.snapshot_key !== snapshot.snapshot_key || computed.snapshot_hash !== snapshot.snapshot_hash) {
    return err(snapshotInvalid("snapshot_hash", "recomputed"));
  }
  const job = buildReviewJob({
    job_id: newId("job"),
    snapshot,
    request: req,
    now: input.now,
    supersedesJobId: req.supersedes_job_id ?? null,
    supersessionDepth: 0
  });
  const result: ReviewEnqueueResult = {
    schema_version: "rsi.review_enqueue_result/1",
    request_id: req.request_id,
    disposition: "created",
    review_job_id: job.job_id,
    stored_trigger_event_id: req.trigger_event_id
  };

  const snapshotBody = canonicalJson(toJsonValue(snapshot));
  const snapshotBlob = stage.stageBlob(snapshotBody);
  if (!snapshotBlob.ok) {
    return err(snapshotBlob.error);
  }
  const rows = [
    {
      row_schema: "rsi.review_snapshot/1",
      row_json: toJsonValue(snapshotRowFromSnapshot(snapshot, snapshotBlob.value)),
      object_key: snapshot.snapshot_id,
      before_hash: null,
      operation: "insert" as const
    },
    {
      row_schema: "rsi.review_enqueue_request_row/1",
      row_json: toJsonValue({
        request_id: req.request_id,
        schema_version: "rsi.review_enqueue/1",
        request_hash: canonicalHash(toJsonValue(req)),
        trigger_event_id: req.trigger_event_id,
        trigger_kind: req.trigger_kind,
        trigger_dedupe_key: req.trigger_dedupe_key,
        version_binding_json: canonicalJsonText(toJsonValue(v11.value)),
        stable_evidence_ref: req.stable_evidence_ref,
        request_json: canonicalJsonText(toJsonValue(req)),
        result_json: canonicalJsonText(toJsonValue(result)),
        review_job_id: job.job_id,
        created_at: input.now
      }),
      object_key: req.request_id,
      before_hash: null,
      operation: "insert" as const
    },
    {
      row_schema: "rsi.review_job/2",
      row_json: toJsonValue(jobRowFromJob(job)),
      object_key: job.job_id,
      before_hash: null,
      operation: "insert" as const
    }
  ];
  const staged = stage.stageRows(rows);
  if (!staged.ok) {
    return err(staged.error);
  }
  return ok({ snapshot, job, result });
}


/* ------------------------------------------------------------------ */
/* Scheduler class                                                     */
/* ------------------------------------------------------------------ */

export class ReviewCommitError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(`${envelope.code}: ${envelope.message_key}`);
    this.name = "ReviewCommitError";
    this.envelope = envelope;
  }
}

export interface SchedulerStageDeps {
  resolveTrigger(stage: LiveCommitStage, triggerEventId: Id<"trg">): Result<TriggerEvent, ErrorEnvelope>;
  requestInTransaction(stage: LiveCommitStage, requestId: string): {
    request_hash: Hash;
    review_job_id: string;
    result_json: JsonValue;
  } | null;
  jobByDedupeInTransaction(stage: LiveCommitStage, dedupeKey: Hash): ReviewJob | null;
  existingSnapshot(snapshotKey: Hash): { snapshot_id: string; snapshot_hash: Hash } | null;
}

export interface DefaultReviewSchedulerDeps extends SchedulerTransactionDeps {
  preparation: EnqueuePreparationDeps;
  stage: SchedulerStageDeps;
}

export class DefaultReviewScheduler {
  private readonly deps: DefaultReviewSchedulerDeps;

  constructor(deps: DefaultReviewSchedulerDeps) {
    this.deps = deps;
  }

  async prepareEnqueue(input: import("./types.js").PrepareReviewEnqueueInput): Promise<PreparedReviewEnqueue> {
    return prepareReviewEnqueue(this.deps.preparation, input);
  }

  enqueueInTransaction(
    stage: LiveCommitStage,
    req: ReviewEnqueueRequest,
    prepared: PreparedReviewEnqueue
  ): ReviewEnqueueResult {
    const existingRequest = this.deps.stage.requestInTransaction(stage, req.request_id);
    if (existingRequest !== null) {
      const incoming = canonicalHash(toJsonValue(req));
      if (existingRequest.request_hash !== incoming) {
        throw idempotencyConflict(req.request_id, existingRequest.request_hash, incoming);
      }
      return JSON.parse(JSON.stringify(existingRequest.result_json)) as ReviewEnqueueResult;
    }
    const existingJob = this.deps.stage.jobByDedupeInTransaction(stage, req.trigger_dedupe_key);
    if (existingJob !== null) {
      return {
        schema_version: "rsi.review_enqueue_result/1",
        request_id: req.request_id,
        disposition: "existing",
        review_job_id: existingJob.job_id,
        stored_trigger_event_id: existingJob.trigger_event_id
      };
    }
    const trigger = this.deps.stage.resolveTrigger(stage, req.trigger_event_id);
    if (!trigger.ok) {
      throw trigger.error;
    }
    const computed = enqueueInTransactionSync({
      stage,
      req,
      prepared,
      trigger: trigger.value,
      deps: this.deps,
      now: trigger.value.decided_at
    });
    if (!computed.ok) {
      throw computed.error;
    }
    return computed.value.result;
  }
}

/** HOST business rejection; never used for schema/binding/storage failures. */
export function rejectedEnqueueResult(
  req: ReviewEnqueueRequest,
  rejection_code: import("./host-contracts.js").ReviewEnqueueRejectionReason,
  stored_trigger_event_id: Id<"trg">
): ReviewEnqueueResult {
  return {
    schema_version: "rsi.review_enqueue_result/1",
    request_id: req.request_id,
    disposition: "rejected",
    rejection_code,
    stored_trigger_event_id
  };
}
