/**
 * PendingRegistry values, validation and state machine (DD-TRG-007).
 *
 * Persistence is owned by DD-HOST-001: every transition is a new document
 * revision and a physical `pending_entry` row written in one StateRow batch.
 * This module only decides whether a transition is legal and shapes the value.
 */

import type { Id } from "../../ids.js";
import type { Hash } from "../../hash.js";
import type { SourceRef } from "../../source-ref.js";
import type { ErrorEnvelope } from "../../errors.js";
import { makeErrorEnvelope } from "../../errors.js";
import { err, ok, type Result } from "../../result.js";
import type { ConfigSpace, DeliveryPending, GenerationResumePending, HostId, HostMode, PendingBase, PendingEntry, PendingKind, ReviewDeferPending } from "../types.js";
import {
  isHashValue,
  isRecord,
  isSafeNonNegativeInt,
  isSafePositiveInt,
  isSourceRefValue,
  isStringArray
} from "../validation.js";

export const GENERATION_RESUME_MAX_ATTEMPTS = 3;

/** Terminal pending rows are retained for seven days (DD-TRG-007). */
export const PENDING_GC_RETENTION_MS = 604_800_000;

const DELIVERY_STATES: readonly string[] = [
  "pending",
  "submitted_not_verified",
  "included",
  "expired",
  "superseded",
  "rejected"
];
const REVIEW_DEFER_STATES: readonly string[] = ["waiting", "resumed", "expired_await_explicit", "cancelled"];
const GENERATION_RESUME_STATES: readonly string[] = ["queued", "resuming", "resumed", "blocked_no_backend", "expired"];

const DELIVERY_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ["submitted_not_verified", "included", "expired", "superseded", "rejected"],
  submitted_not_verified: ["included"],
  included: [],
  expired: [],
  superseded: [],
  rejected: []
};

const REVIEW_DEFER_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  waiting: ["resumed", "expired_await_explicit", "cancelled"],
  expired_await_explicit: ["resumed"],
  resumed: [],
  cancelled: []
};

const GENERATION_RESUME_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  queued: ["resuming", "blocked_no_backend", "expired"],
  resuming: ["resumed", "blocked_no_backend", "expired"],
  blocked_no_backend: ["queued"],
  resumed: [],
  expired: []
};

function isPendingKind(value: string): value is PendingKind {
  return value === "delivery" || value === "review_defer" || value === "generation_resume";
}

/** True only for an edge present in the documented state machine. */
export function canTransitionPending(kind: PendingKind, from: string, to: string): boolean {
  switch (kind) {
    case "delivery":
      return (DELIVERY_TRANSITIONS[from] ?? []).includes(to);
    case "review_defer":
      return (REVIEW_DEFER_TRANSITIONS[from] ?? []).includes(to);
    case "generation_resume":
      return (GENERATION_RESUME_TRANSITIONS[from] ?? []).includes(to);
  }
}

function pendingError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "pending_validate",
    details: { kind: "field", path, rule }
  });
}

const BASE_FIELDS: readonly string[] = [
  "schema_version",
  "pending_id",
  "pending_key",
  "kind",
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "host_id",
  "mode",
  "config_space",
  "trigger_event_id",
  "policy_ref",
  "created_at",
  "updated_at",
  "deadline_at",
  "attempt",
  "evidence_refs",
  "last_error",
  "origin"
];

const VARIANT_FIELDS: Readonly<Record<PendingKind, readonly string[]>> = {
  delivery: [
    "state",
    "delivery_id",
    "session_ref",
    "boundary_event_ref",
    "delivery_target_hash",
    "content_ref",
    "content_hash",
    "nonce",
    "wait_mode",
    "capability_snapshot_hash",
    "submitted_certainty",
    "inclusion_level",
    "inclusion_evidence_ref",
    "no_blind_retry"
  ],
  review_defer: [
    "state",
    "boundary_key",
    "review_scope_key",
    "stable_event_ids",
    "stable_watermark",
    "goal_version",
    "pending_work_refs",
    "resume_requires",
    "resume_trigger_event_id"
  ],
  generation_resume: [
    "state",
    "review_job_id",
    "snapshot_ref",
    "backend_selection_ref",
    "resume_entry",
    "attempts",
    "max_attempts"
  ]
};

/** Runtime validation of a logical PendingEntry (not the physical row). */
export function validatePendingEntry(value: unknown): Result<PendingEntry, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(pendingError("$", "object"));
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !isPendingKind(kind)) {
    return err(pendingError("kind", "pending_kind"));
  }
  const allowed = new Set([...BASE_FIELDS, ...VARIANT_FIELDS[kind]]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return err(pendingError(key, "known_field"));
    }
  }
  for (const key of BASE_FIELDS) {
    if (key === "trigger_event_id" || key === "deadline_at" || key === "last_error") {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return err(pendingError(key, "required"));
    }
  }
  if (value["schema_version"] !== "rsi.pending/1") {
    return err(pendingError("schema_version", "rsi.pending/1"));
  }
  if (typeof value["pending_id"] !== "string" || !value["pending_id"].startsWith("pen:")) {
    return err(pendingError("pending_id", "pen_id"));
  }
  if (!isHashValue(value["pending_key"])) {
    return err(pendingError("pending_key", "sha256_hash"));
  }
  if (!isSafePositiveInt(value["input_epoch"])) {
    return err(pendingError("input_epoch", "positive_safe_integer"));
  }
  if (!isSafeNonNegativeInt(value["attempt"])) {
    return err(pendingError("attempt", "non_negative_safe_integer"));
  }
  if (!isSafeNonNegativeInt(value["created_at"]) || !isSafeNonNegativeInt(value["updated_at"])) {
    return err(pendingError("updated_at", "non_negative_safe_integer"));
  }
  if (typeof value["updated_at"] === "number" && typeof value["created_at"] === "number" && value["updated_at"] < value["created_at"]) {
    return err(pendingError("updated_at", "after_created_at"));
  }
  if (value["deadline_at"] !== undefined && !isSafeNonNegativeInt(value["deadline_at"])) {
    return err(pendingError("deadline_at", "non_negative_safe_integer"));
  }
  if (!isStringArray(value["evidence_refs"])) {
    return err(pendingError("evidence_refs", "string[]"));
  }
  if (!isRecord(value["policy_ref"])) {
    return err(pendingError("policy_ref", "object"));
  }
  const base = readPendingBase(value, kind);
  if (!base.ok) {
    return base;
  }
  switch (kind) {
    case "delivery":
      return validateDelivery(value, base.value);
    case "review_defer":
      return validateReviewDefer(value, base.value);
    case "generation_resume":
      return validateGenerationResume(value, base.value);
  }
}

type PendingBaseFields = Omit<PendingBase, "kind">;

function readPendingBase(value: Record<string, unknown>, kind: PendingKind): Result<PendingBaseFields, ErrorEnvelope> {
  for (const field of ["task_id", "branch_id", "goal_version", "config_version", "host_id", "mode", "config_space"]) {
    if (typeof value[field] !== "string" || value[field] === "") {
      return err(pendingError(field, "non_empty_string"));
    }
  }
  const policyRef = value["policy_ref"];
  if (!isRecord(policyRef)) {
    return err(pendingError("policy_ref", "object"));
  }
  if (
    typeof policyRef["policy_id"] !== "string" ||
    typeof policyRef["policy_version"] !== "string" ||
    !isHashValue(policyRef["policy_hash"]) ||
    !isHashValue(policyRef["scope_key"])
  ) {
    return err(pendingError("policy_ref", "trigger_policy_ref"));
  }
  const origin = value["origin"];
  if (
    origin !== "human" &&
    origin !== "host_auto" &&
    origin !== "evaluator" &&
    origin !== "evaluator_descendant" &&
    origin !== "unknown"
  ) {
    return err(pendingError("origin", "origin_kind"));
  }
  const deadlineAt = value["deadline_at"];
  const lastError = value["last_error"];
  const triggerEventId = value["trigger_event_id"];
  let parsedLastError: import("../types.js").PendingError | undefined;
  if (lastError !== undefined) {
    if (
      !isRecord(lastError) ||
      typeof lastError["code"] !== "string" ||
      typeof lastError["retryable"] !== "boolean" ||
      !isSourceRefValue(lastError["detail_ref"])
    ) {
      return err(pendingError("last_error", "pending_error"));
    }
    parsedLastError = {
      code: lastError["code"],
      retryable: lastError["retryable"],
      detail_ref: lastError["detail_ref"]
    };
  }
  const base: PendingBaseFields = {
    schema_version: "rsi.pending/1",
    pending_id: value["pending_id"] as Id<"pen">,
    pending_key: value["pending_key"] as Hash,
    task_id: value["task_id"] as string,
    branch_id: value["branch_id"] as string,
    input_epoch: value["input_epoch"] as number,
    goal_version: value["goal_version"] as string,
    config_version: value["config_version"] as string,
    host_id: value["host_id"] as HostId,
    mode: value["mode"] as HostMode,
    config_space: value["config_space"] as ConfigSpace,
    policy_ref: {
      policy_id: policyRef["policy_id"] as Id<"pol">,
      policy_version: policyRef["policy_version"] as string,
      policy_hash: policyRef["policy_hash"] as Hash,
      scope_key: policyRef["scope_key"] as Hash
    },
    created_at: value["created_at"] as number,
    updated_at: value["updated_at"] as number,
    attempt: value["attempt"] as number,
    evidence_refs: value["evidence_refs"] as string[],
    origin: origin as import("../types.js").OriginKind
  };
  if (deadlineAt !== undefined) {
    base.deadline_at = deadlineAt as number;
  }
  if (triggerEventId !== undefined) {
    if (typeof triggerEventId !== "string" || !triggerEventId.startsWith("trg:")) {
      return err(pendingError("trigger_event_id", "trg_id"));
    }
    base.trigger_event_id = triggerEventId as Id<"trg">;
  }
  if (parsedLastError !== undefined) {
    base.last_error = parsedLastError;
  }
  void kind;
  return ok(base);
}

function validateDelivery(
  value: Record<string, unknown>,
  base: PendingBaseFields
): Result<DeliveryPending, ErrorEnvelope> {
  const state = value["state"];
  if (typeof state !== "string" || !DELIVERY_STATES.includes(state)) {
    return err(pendingError("state", "delivery_state"));
  }
  for (const field of ["delivery_id", "session_ref", "boundary_event_ref", "nonce"]) {
    if (typeof value[field] !== "string" || value[field] === "") {
      return err(pendingError(field, "non_empty_string"));
    }
  }
  if (!isHashValue(value["delivery_target_hash"]) || !isHashValue(value["capability_snapshot_hash"])) {
    return err(pendingError("delivery_target_hash", "sha256_hash"));
  }
  if (!isSourceRefValue(value["content_ref"])) {
    return err(pendingError("content_ref", "source_ref"));
  }
  if (!isHashValue(value["content_hash"])) {
    return err(pendingError("content_hash", "sha256_hash"));
  }
  if (value["wait_mode"] !== "bounded" && value["wait_mode"] !== "strict") {
    return err(pendingError("wait_mode", "bounded_or_strict"));
  }
  if (
    value["submitted_certainty"] !== "true" &&
    value["submitted_certainty"] !== "false" &&
    value["submitted_certainty"] !== "unknown"
  ) {
    return err(pendingError("submitted_certainty", "three_state"));
  }
  if (value["no_blind_retry"] !== true) {
    return err(pendingError("no_blind_retry", "true"));
  }
  if (value["inclusion_evidence_ref"] !== undefined && typeof value["inclusion_evidence_ref"] !== "string") {
    return err(pendingError("inclusion_evidence_ref", "string"));
  }
  const delivery: DeliveryPending = {
    ...base,
    kind: "delivery",
    state: state as DeliveryPending["state"],
    delivery_id: value["delivery_id"] as string,
    session_ref: value["session_ref"] as string,
    boundary_event_ref: value["boundary_event_ref"] as string,
    delivery_target_hash: value["delivery_target_hash"] as Hash,
    content_ref: value["content_ref"] as SourceRef,
    content_hash: value["content_hash"] as Hash,
    nonce: value["nonce"] as string,
    wait_mode: value["wait_mode"] as DeliveryPending["wait_mode"],
    capability_snapshot_hash: value["capability_snapshot_hash"] as Hash,
    submitted_certainty: value["submitted_certainty"] as DeliveryPending["submitted_certainty"],
    inclusion_level: value["inclusion_level"] as DeliveryPending["inclusion_level"],
    no_blind_retry: true
  };
  if (value["inclusion_evidence_ref"] !== undefined) {
    delivery.inclusion_evidence_ref = value["inclusion_evidence_ref"] as string;
  }
  return ok(delivery);
}

function validateReviewDefer(
  value: Record<string, unknown>,
  base: PendingBaseFields
): Result<ReviewDeferPending, ErrorEnvelope> {
  const state = value["state"];
  if (typeof state !== "string" || !REVIEW_DEFER_STATES.includes(state)) {
    return err(pendingError("state", "review_defer_state"));
  }
  if (!isHashValue(value["boundary_key"]) || !isHashValue(value["review_scope_key"])) {
    return err(pendingError("boundary_key", "sha256_hash"));
  }
  if (!isStringArray(value["stable_event_ids"])) {
    return err(pendingError("stable_event_ids", "string[]"));
  }
  if (!isSafeNonNegativeInt(value["stable_watermark"])) {
    return err(pendingError("stable_watermark", "non_negative_safe_integer"));
  }
  if (!Array.isArray(value["pending_work_refs"])) {
    return err(pendingError("pending_work_refs", "array"));
  }
  if (value["resume_requires"] !== "verified_stable_event_or_user") {
    return err(pendingError("resume_requires", "verified_stable_event_or_user"));
  }
  if (state === "waiting" && !isSafeNonNegativeInt(value["deadline_at"])) {
    return err(pendingError("deadline_at", "required_for_waiting"));
  }
  const workRefs: import("../types.js").PendingWorkRef[] = [];
  for (const entry of value["pending_work_refs"]) {
    if (
      !isRecord(entry) ||
      typeof entry["pending_id"] !== "string" ||
      typeof entry["kind"] !== "string" ||
      !isPendingKind(entry["kind"]) ||
      typeof entry["state"] !== "string" ||
      typeof entry["evidence_ref"] !== "string"
    ) {
      return err(pendingError("pending_work_refs", "pending_work_ref"));
    }
    workRefs.push({
      pending_id: entry["pending_id"] as Id<"pen">,
      kind: entry["kind"],
      state: entry["state"],
      evidence_ref: entry["evidence_ref"]
    });
  }
  const defer: ReviewDeferPending = {
    ...base,
    kind: "review_defer",
    state: state as ReviewDeferPending["state"],
    boundary_key: value["boundary_key"] as Hash,
    review_scope_key: value["review_scope_key"] as Hash,
    stable_event_ids: value["stable_event_ids"] as string[],
    stable_watermark: value["stable_watermark"] as number,
    goal_version: value["goal_version"] as string,
    pending_work_refs: workRefs,
    resume_requires: "verified_stable_event_or_user"
  };
  if (value["resume_trigger_event_id"] !== undefined) {
    if (typeof value["resume_trigger_event_id"] !== "string") {
      return err(pendingError("resume_trigger_event_id", "string"));
    }
    defer.resume_trigger_event_id = value["resume_trigger_event_id"] as Id<"trg">;
  }
  return ok(defer);
}

function validateGenerationResume(
  value: Record<string, unknown>,
  base: PendingBaseFields
): Result<GenerationResumePending, ErrorEnvelope> {
  const state = value["state"];
  if (typeof state !== "string" || !GENERATION_RESUME_STATES.includes(state)) {
    return err(pendingError("state", "generation_resume_state"));
  }
  if (typeof value["review_job_id"] !== "string" || !value["review_job_id"].startsWith("job:")) {
    return err(pendingError("review_job_id", "job_id"));
  }
  if (!isSourceRefValue(value["snapshot_ref"])) {
    return err(pendingError("snapshot_ref", "source_ref"));
  }
  if (typeof value["backend_selection_ref"] !== "string" || value["backend_selection_ref"] === "") {
    return err(pendingError("backend_selection_ref", "non_empty_string"));
  }
  if (value["resume_entry"] !== "coordinator_start" && value["resume_entry"] !== "next_input" && value["resume_entry"] !== "manual") {
    return err(pendingError("resume_entry", "resume_entry"));
  }
  if (!isSafeNonNegativeInt(value["attempts"])) {
    return err(pendingError("attempts", "non_negative_safe_integer"));
  }
  if (value["max_attempts"] !== GENERATION_RESUME_MAX_ATTEMPTS) {
    return err(pendingError("max_attempts", "3"));
  }
  return ok({
    ...base,
    kind: "generation_resume",
    state: state as GenerationResumePending["state"],
    review_job_id: value["review_job_id"] as Id<"job">,
    snapshot_ref: value["snapshot_ref"] as SourceRef,
    backend_selection_ref: value["backend_selection_ref"] as string,
    resume_entry: value["resume_entry"] as GenerationResumePending["resume_entry"],
    attempts: value["attempts"] as number,
    max_attempts: GENERATION_RESUME_MAX_ATTEMPTS
  });
}

/** `deadline_at = created_at + policy.review.pending.defer_max_ms`. */
export function reviewDeferDeadline(createdAt: number, deferMaxMs: number): number {
  return createdAt + deferMaxMs;
}

interface PendingTransitionPatch {
  updated_at: number;
  state: string;
  attempt?: number;
  deadline_at?: number;
  last_error?: import("../types.js").PendingError;
  resume_trigger_event_id?: string;
  evidence_refs?: string[];
}

/**
 * Applies one legal transition. Illegal edges and variant-crossing patches are
 * rejected; the caller persists the returned value as a new revision.
 */
export function transitionPending(
  entry: PendingEntry,
  patch: PendingTransitionPatch
): Result<PendingEntry, ErrorEnvelope> {
  if (!canTransitionPending(entry.kind, entry.state, patch.state)) {
    return err(pendingError("state", `illegal_transition:${entry.state}->${patch.state}`));
  }
  const next = { ...entry, state: patch.state, updated_at: patch.updated_at } as PendingEntry;
  if (patch.attempt !== undefined) {
    next.attempt = patch.attempt;
  }
  if (patch.deadline_at !== undefined) {
    next.deadline_at = patch.deadline_at;
  }
  if (patch.last_error !== undefined) {
    next.last_error = patch.last_error;
  }
  if (patch.evidence_refs !== undefined) {
    next.evidence_refs = patch.evidence_refs;
  }
  if (patch.resume_trigger_event_id !== undefined && next.kind === "review_defer") {
    next.resume_trigger_event_id = patch.resume_trigger_event_id as Id<"trg">;
  }
  if (next.kind === "generation_resume" && patch.state === "resuming") {
    next.attempts = patch.attempt ?? next.attempts + 1;
  }
  return validatePendingEntry(next);
}

/** Collects every `SourceRef` actually present on an entry. */
export function pendingSourceRefs(entry: PendingEntry): string[] {
  const refs: string[] = [];
  refs.push(...entry.evidence_refs);
  if (entry.last_error !== undefined) {
    refs.push(entry.last_error.detail_ref);
  }
  if (entry.kind === "delivery") {
    refs.push(entry.content_ref);
    if (entry.inclusion_evidence_ref !== undefined) {
      refs.push(entry.inclusion_evidence_ref);
    }
  } else if (entry.kind === "review_defer") {
    for (const work of entry.pending_work_refs) {
      refs.push(work.evidence_ref);
    }
  } else {
    refs.push(entry.snapshot_ref);
  }
  return Array.from(new Set(refs));
}

/** True when the row is terminal and eligible for the seven-day GC. */
export function isTerminalPending(entry: PendingEntry): boolean {
  switch (entry.kind) {
    case "delivery":
      return entry.state === "included" || entry.state === "expired" || entry.state === "superseded" || entry.state === "rejected";
    case "review_defer":
      return entry.state === "resumed" || entry.state === "cancelled";
    case "generation_resume":
      return entry.state === "resumed" || entry.state === "expired";
  }
}
