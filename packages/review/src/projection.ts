/**
 * ExperienceProjection materialization and lifecycle events
 * (DD-REV-110, DD-REV-151).
 *
 * Projections are written only from `ExperienceLifecycleEvent.projection_after`.
 * Events carry a complete before/after hash chain; the reducer applies the
 * after-image and never re-runs predicates.
 */

import { canonicalHash, compareUtf8, toJsonValue } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import {
  experienceEventConflict,
  illegalProjectionTransition,
  revError
} from "./errors.js";
import { adoptionBindingHash, projectionHash } from "./experience.js";
import type {
  AdoptionBinding,
  Experience,
  ExperienceLifecycleEvent,
  ExperienceProjection,
  LifecycleTriggerKind,
  ProjectionLifecycle,
  ProjectionLifecycleReason,
  ReviewJob,
  ValidationPlan
} from "./types.js";

export function projectionAfterHash(projection: ExperienceProjection): Hash {
  return projectionHash(projection);
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

const LEGAL_LIFECYCLE_EDGES: Readonly<Record<ProjectionLifecycle, readonly ProjectionLifecycle[]>> = {
  checked: ["trial", "disabled", "revoked"],
  trial: ["trial", "retained", "disabled", "revoked"],
  retained: ["disabled", "revoked"],
  disabled: [],
  revoked: []
};

export function lifecycleTransitionAllowed(
  from: ProjectionLifecycle,
  to: ProjectionLifecycle
): boolean {
  // An unknown source state has no legal transition; it is not an error.
  return (LEGAL_LIFECYCLE_EDGES[from] ?? []).includes(to);
}

export function projectionTransitionError(
  from: ProjectionLifecycle,
  to: ProjectionLifecycle
): ErrorEnvelope | null {
  return lifecycleTransitionAllowed(from, to) ? null : illegalProjectionTransition(from, to);
}

export function lifecycleReasonForTransition(
  from: ProjectionLifecycle | null,
  to: ProjectionLifecycle,
  explicit:
    | "confirmed_regression"
    | "expired"
    | "superseded"
    | "user_revoked"
    | "authorization_revoked"
    | "host_incompatible"
    | "window_extended"
    | "rollback"
    | null
): ProjectionLifecycleReason {
  if (from === null) {
    if (to !== "checked") {
      throw new RangeError("the first lifecycle event must enter checked");
    }
    return "adopted";
  }
  if (from === "checked" && to === "trial") {
    return "trial_started";
  }
  if (from === "trial" && to === "retained") {
    return "retention_rule_met";
  }
  if (to === "revoked") {
    return explicit === "authorization_revoked" ? "authorization_revoked" : "user_revoked";
  }
  if (explicit !== null) {
    return explicit;
  }
  return "expired";
}

export function triggerKindForReason(reason: ProjectionLifecycleReason): LifecycleTriggerKind {
  switch (reason) {
    case "adopted":
      return "adoption";
    case "trial_started":
      return "begin_trial";
    case "retention_rule_met":
      return "retention_evaluated";
    case "confirmed_regression":
      return "usage_verification";
    case "expired":
      return "expiry";
    case "superseded":
      return "supersede";
    case "user_revoked":
      return "user_action";
    case "authorization_revoked":
      return "authorization_change";
    case "host_incompatible":
      return "host_change";
    case "window_extended":
      return "window_extension";
    case "rollback":
      return "rollback";
  }
}

/* ------------------------------------------------------------------ */
/* Initial projection                                                  */
/* ------------------------------------------------------------------ */

export interface InitialProjectionInput {
  projection_id: string;
  experience: Experience;
  validation_plan: ValidationPlan;
  adoption_binding: AdoptionBinding;
  verifier: ExperienceProjection["verifier"];
  retention_rule_id: string;
  write: ExperienceProjection["write"];
  first_event_id: Id<"lif">;
  now: number;
}

export function createInitialProjection(input: InitialProjectionInput): ExperienceProjection {
  const bindingHash = adoptionBindingHash(input.adoption_binding);
  return {
    schema_version: "rsi.experience_projection/2",
    projection_id: input.projection_id,
    experience_id: input.experience.experience_id,
    experience_version: input.experience.version,
    experience_content_hash: input.experience.content_hash,
    host_id: input.adoption_binding.target.host_id,
    config_space: input.adoption_binding.target.config_space,
    mode: input.adoption_binding.target.mode,
    object_type: input.adoption_binding.target.object_type,
    path_or_block: input.adoption_binding.target.path_or_block,
    block_id: input.adoption_binding.target.block_id,
    adoption_binding: { ...input.adoption_binding, binding_hash: bindingHash },
    lifecycle: "checked",
    lifecycle_reason: "adopted",
    checked_at: input.now,
    write: { ...input.write },
    loading_evidence: {
      written: "unknown",
      discovered: "unknown",
      included: "unknown",
      observed: "unknown",
      evidence_refs: []
    },
    validation_plan_id: input.validation_plan.validation_plan_id,
    validation_plan_hash: input.validation_plan.plan_hash,
    verifier: { ...input.verifier },
    no_verifier: input.validation_plan.verifier.kind === "none",
    retention_rule_id: input.retention_rule_id,
    retention: {
      window_end_at: input.now + input.validation_plan.observation_window.window_ms,
      window_extensions: 0,
      independent_passes: 0,
      failed_observations: 0,
      not_exercised_count: 0
    },
    baseline: null,
    usage_record_ids: [],
    restored_from_projection_id: null,
    superseded_by_projection_id: null,
    last_lifecycle_event_id: input.first_event_id,
    causal_supported: false,
    row_version: 1,
    created_at: input.now,
    updated_at: input.now
  };
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export interface BuildLifecycleEventInput {
  event_id: Id<"lif">;
  projection_before: ExperienceProjection | null;
  projection_after: ExperienceProjection;
  sequence: number;
  reason: ProjectionLifecycleReason;
  trigger: ExperienceLifecycleEvent["trigger"];
  write_id: Id<"wi">;
  version_binding: VersionBinding;
  now: number;
}

/** `event_hash` excludes `event_id`, `projection_after` and itself. */
export function experienceLifecycleEventHash(
  event: Omit<ExperienceLifecycleEvent, "event_hash">
): Hash {
  return canonicalHash(
    toJsonValue({
      schema_version: event.schema_version,
      projection_id: event.projection_id,
      experience_id: event.experience_id,
      experience_version: event.experience_version,
      experience_content_hash: event.experience_content_hash,
      adoption_binding_hash: event.adoption_binding_hash,
      sequence: event.sequence,
      from_lifecycle: event.from_lifecycle,
      to_lifecycle: event.to_lifecycle,
      reason: event.reason,
      trigger: event.trigger,
      write_id: event.write_id,
      version_binding: event.version_binding,
      projection_before_hash: event.projection_before_hash,
      projection_after_hash: event.projection_after_hash,
      row_version_before: event.row_version_before,
      row_version_after: event.row_version_after,
      recorded_at: event.recorded_at
    })
  );
}

export function buildLifecycleEvent(input: BuildLifecycleEventInput): ExperienceLifecycleEvent {
  const before = input.projection_before;
  const after: ExperienceProjection = {
    ...input.projection_after,
    last_lifecycle_event_id: input.event_id
  };
  if (before !== null) {
    const transitionError = projectionTransitionError(before.lifecycle, after.lifecycle);
    if (transitionError !== null) {
      throw new RangeError(`illegal lifecycle transition ${before.lifecycle}->${after.lifecycle}`);
    }
    if (
      before.lifecycle === "trial" &&
      after.lifecycle === "trial" &&
      input.reason !== "window_extended"
    ) {
      throw new RangeError("trial -> trial requires window_extended");
    }
  }
  const eventBase: Omit<ExperienceLifecycleEvent, "event_hash"> = {
    schema_version: "rsi.experience_lifecycle_event/1",
    event_id: input.event_id,
    projection_id: after.projection_id,
    experience_id: after.experience_id,
    experience_version: after.experience_version,
    experience_content_hash: after.experience_content_hash,
    adoption_binding_hash: after.adoption_binding.binding_hash,
    sequence: input.sequence,
    from_lifecycle: before === null ? null : before.lifecycle,
    to_lifecycle: after.lifecycle,
    reason: input.reason,
    trigger: {
      kind: input.trigger.kind,
      ref: input.trigger.ref,
      usage_ids: [...input.trigger.usage_ids].sort(compareUtf8)
    },
    write_id: input.write_id,
    version_binding: input.version_binding,
    projection_before_hash: before === null ? null : projectionHash(before),
    projection_after_hash: projectionHash(after),
    projection_after: after,
    row_version_before: before === null ? 0 : before.row_version,
    row_version_after: after.row_version,
    recorded_at: input.now
  };
  return { ...eventBase, event_hash: experienceLifecycleEventHash(eventBase) };
}

/** Applies the after-image; never re-evaluates predicates. */
export function applyLifecycleEvent(
  current: ExperienceProjection | null,
  event: ExperienceLifecycleEvent
): Result<ExperienceProjection, ErrorEnvelope> {
  const after = event.projection_after;
  if (current === null) {
    if (
      event.sequence !== 1 ||
      event.from_lifecycle !== null ||
      event.row_version_before !== 0 ||
      event.projection_before_hash !== null ||
      after.lifecycle !== "checked" ||
      (after.lifecycle_reason !== "adopted" && after.lifecycle_reason !== "rollback") ||
      (after.lifecycle_reason === "adopted" && event.trigger.kind !== "adoption") ||
      (after.lifecycle_reason === "rollback" && event.trigger.kind !== "rollback")
    ) {
      return err(
        revError({
          code: "E_REBUILD_DIVERGENCE",
          stage: "journal_rebuild",
          details: { kind: "field", path: "experience_lifecycle_event", rule: "first_event" }
        })
      );
    }
    if (after.last_lifecycle_event_id !== event.event_id) {
      return err(
        revError({
          code: "E_REBUILD_DIVERGENCE",
          stage: "journal_rebuild",
          details: { kind: "field", path: "last_lifecycle_event_id", rule: "event_id" }
        })
      );
    }
    return ok(after);
  }
  if (projectionHash(current) === event.projection_after_hash) {
    return ok(current);
  }
  if (event.projection_before_hash === null) {
    return err(
      revError({
        code: "E_REBUILD_DIVERGENCE",
        stage: "journal_rebuild",
        details: { kind: "field", path: "projection_before_hash", rule: "null_for_existing" }
      })
    );
  }
  if (projectionHash(current) !== event.projection_before_hash) {
    return err(
      revError({
        code: "E_REBUILD_DIVERGENCE",
        stage: "journal_rebuild",
        details: { kind: "field", path: "projection_before_hash", rule: "current_row" }
      })
    );
  }
  if (current.row_version !== event.row_version_before) {
    return err(
      revError({
        code: "E_REBUILD_DIVERGENCE",
        stage: "journal_rebuild",
        details: { kind: "field", path: "row_version_before", rule: "current_row" }
      })
    );
  }
  if (after.last_lifecycle_event_id !== event.event_id) {
    return err(
      revError({
        code: "E_REBUILD_DIVERGENCE",
        stage: "journal_rebuild",
        details: { kind: "field", path: "last_lifecycle_event_id", rule: "event_id" }
      })
    );
  }
  return ok(after);
}

export function rebuildProjection(
  events: readonly ExperienceLifecycleEvent[]
): Result<ExperienceProjection, ErrorEnvelope> {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  let current: ExperienceProjection | null = null;
  let expectedSequence = 1;
  for (const event of sorted) {
    if (event.sequence !== expectedSequence) {
      return err(
        revError({
          code: "E_REBUILD_DIVERGENCE",
          stage: "journal_rebuild",
          details: { kind: "field", path: "sequence", rule: String(expectedSequence) }
        })
      );
    }
    const applied = applyLifecycleEvent(current, event);
    if (!applied.ok) {
      return err(applied.error);
    }
    current = applied.value;
    expectedSequence += 1;
  }
  if (current === null) {
    return err(
      revError({
        code: "E_REBUILD_DIVERGENCE",
        stage: "journal_rebuild",
        details: { kind: "field", path: "events", rule: "non_empty" }
      })
    );
  }
  return ok(current);
}

export function nextSequence(events: readonly ExperienceLifecycleEvent[]): number {
  if (events.length === 0) {
    return 1;
  }
  return Math.max(...events.map((event) => event.sequence)) + 1;
}

export function sameEventSlot(
  existing: ExperienceLifecycleEvent,
  incoming: ExperienceLifecycleEvent
): ErrorEnvelope | null {
  if (
    existing.event_id !== incoming.event_id ||
    existing.event_hash !== incoming.event_hash
  ) {
    return experienceEventConflict(existing.event_hash, incoming.event_hash);
  }
  return null;
}

export function eventMatchesProjection(
  event: ExperienceLifecycleEvent,
  projection: ExperienceProjection
): boolean {
  return (
    event.projection_id === projection.projection_id &&
    event.projection_after_hash === projectionHash(projection) &&
    event.projection_after.last_lifecycle_event_id === event.event_id
  );
}

/** Compares a cache value with the 0/1 transition rule result. */
export function projectionRetentionFromPlan(
  projection: ExperienceProjection,
  plan: ValidationPlan,
  now: number
): { retained_at: number; review_after_at: number } {
  return {
    retained_at: now,
    review_after_at: now + plan.retention_rule.max_age_ms
  };
}

export function disabledProjection(
  projection: ExperienceProjection,
  reason: ProjectionLifecycleReason,
  now: number,
  supersededBy: string | null
): ExperienceProjection {
  return {
    ...projection,
    lifecycle: reason === "user_revoked" || reason === "authorization_revoked" ? "revoked" : "disabled",
    lifecycle_reason: reason,
    superseded_by_projection_id: supersededBy,
    retention: { ...projection.retention, last_evaluated_at: now },
    row_version: projection.row_version + 1,
    updated_at: now
  };
}

export function jobHandoffKey(job: ReviewJob): string {
  return `${job.job_id}:${job.snapshot_id}`;
}
