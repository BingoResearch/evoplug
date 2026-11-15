/**
 * Default ExperienceService orchestration (DD-REV-140, DD-REV-120).
 *
 * `recordUsage` derives loading state, verifier kind/independence,
 * attribution, result, window index and both hashes from FND/HOST facts. The
 * caller supplies evidence refs and persisted IDs only.
 */

import { newId } from "@evoplug/core";
import type { ErrorEnvelope, Result, SourceRef, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { GoalVersionReadPort } from "@evoplug/core";

export * from "./rollback-target.js";

import type { HostLifecycleFacts } from "./budget-contracts.js";
import {
  revError
} from "./errors.js";
import type { HostLifecycleFactsPort, ReviewRepository, ReviewWritePort, WriteAdoptionReadPort } from "./ports.js";
import {
  evaluateLifecycle,
  extendWindowPredicate,
  revokeReason,
  type LifecycleAction,
  type LifecycleFacts
} from "./lifecycle.js";
import { projectionHash } from "./experience.js";
import { buildAdoptionBinding, validateAdoptionView } from "./adoption.js";
import {
  computeUsageRecord,
  duplicateUsagePayload,
  validateUsageRecord,
  windowIndexFor
} from "./usage.js";
import type { VerifierRegistryPort } from "./judge-contracts.js";
import type {
  ExperienceLifecycleEvent,
  ExperienceProjection,
  LoadingIncludedState,
  LoadingStageState,
  UsageVerificationRecord,
  ValidationPlan
} from "./types.js";
import {
  revErr,
  revErrorFromEnvelope,
  revOk,
  type ExperienceService,
  type RevError,
  type RevResult
} from "./service.js";

export interface RecordUsageInput {
  projection_id: string;
  trigger_event_id: string;
  loading_evidence_refs: SourceRef[];
  behavior_evidence_refs: SourceRef[];
  verification_ref: SourceRef;
  outcome_ref?: SourceRef;
  other_change_refs: SourceRef[];
  now: number;
}

export interface UsageTriggerFacts {
  version_binding: VersionBinding;
  task_family_id: string;
  trigger_result: "triggered" | "not_triggered" | "unknown";
  loading: {
    written: LoadingStageState;
    discovered: LoadingStageState;
    included: LoadingIncludedState;
    observed: "unknown" | "claimed" | "verified";
    evidence_refs: SourceRef[];
  };
  behavior_summary: string;
  verification_version_binding: VersionBinding;
  verification_status: "passed" | "failed" | "not_available" | "not_applicable";
}

export interface ExperienceCommitPort {
  recordAdoption(input: {
    proposal_id: string;
    write_id: string;
    grant_id: string;
    /** Resolved by the service before the commit stage. */
    projection_id?: string;
    now: number;
  }): Promise<Result<ExperienceProjection, ErrorEnvelope>>;
  beginTrial(input: {
    projection: ExperienceProjection;
    plan: ValidationPlan;
    now: number;
  }): Promise<Result<{ projection: ExperienceProjection; event: ExperienceLifecycleEvent }, ErrorEnvelope>>;
  recordUsage(input: {
    projection: ExperienceProjection;
    record: UsageVerificationRecord;
    now: number;
  }): Promise<Result<UsageVerificationRecord, ErrorEnvelope>>;
  applyLifecycle(input: {
    projection: ExperienceProjection;
    action: LifecycleAction;
    now: number;
  }): Promise<Result<{ projection: ExperienceProjection; event: ExperienceLifecycleEvent }, ErrorEnvelope>>;
  extendWindow(input: {
    projection: ExperienceProjection;
    plan: ValidationPlan;
    now: number;
  }): Promise<Result<ExperienceProjection, ErrorEnvelope>>;
  revoke(input: {
    projection: ExperienceProjection;
    reason: "user_revoked" | "authorization_revoked";
    now: number;
  }): Promise<Result<ExperienceProjection, ErrorEnvelope>>;
  rollback(input: {
    projection: ExperienceProjection;
    /**
     * Omitted means "resolve the nearest older adopted version". The commit
     * adapter resolves the full adoption -> write -> snapshot chain and fails
     * closed with `E_ROLLBACK_TARGET_UNRESOLVED`.
     */
    target_version?: number;
    grant_id: string;
    now: number;
  }): Promise<Result<{ projection: ExperienceProjection; write_id: string }, ErrorEnvelope>>;
}

export interface ExperienceServiceDeps {
  repo: ReviewRepository;
  write: ReviewWritePort;
  commit: ExperienceCommitPort;
  verifierRegistry: VerifierRegistryPort;
  writeAdoption: WriteAdoptionReadPort;
  goal: GoalVersionReadPort;
  hostFacts: HostLifecycleFactsPort;
  readHostFacts(
    projection: ExperienceProjection
  ): Promise<Result<HostLifecycleFacts, ErrorEnvelope>>;
  triggerFacts(trigger_event_id: string): Promise<Result<UsageTriggerFacts, ErrorEnvelope>>;
  now(utc: number): number;
}

export class DefaultExperienceService implements ExperienceService {
  private readonly deps: ExperienceServiceDeps;

  constructor(deps: ExperienceServiceDeps) {
    this.deps = deps;
  }

  async recordAdoption(input: {
    proposal_id: string;
    write_id: string;
    grant_id: string;
    now: number;
  }): Promise<RevResult<ExperienceProjection>> {
    // Same-write replay returns the existing projection; a first adoption is
    // admitted only while the Proposal is still `proposed`.
    const replay = await this.projectionForWrite(input.write_id);
    if (replay !== null) {
      const committed = await this.deps.commit.recordAdoption({
        ...input,
        projection_id: replay.projection_id
      });
      if (!committed.ok) {
        return revErr(revErrorFromEnvelope(committed.error));
      }
      return revOk(committed.value);
    }
    const getProposal = this.deps.repo.getProposal;
    const proposal =
      typeof getProposal === "function" ? await getProposal(input.proposal_id) : null;
    if (proposal === null || proposal.state !== "proposed") {
      return revErr({
        code: "E_PROPOSAL_ILLEGAL_TRANSITION",
        retryable: false,
        stage: "adoption",
        cause: input.proposal_id
      });
    }
    const committed = await this.deps.commit.recordAdoption(input);
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  /** Same-write replay lookup; never opens a second connection. */
  private async projectionForWrite(write_id: string): Promise<ExperienceProjection | null> {
    const byWrite = this.deps.repo.getProjectionByWriteId;
    if (typeof byWrite === "function") {
      const found = await byWrite(write_id);
      if (found !== null && found !== undefined) {
        return found;
      }
    }
    const list = this.deps.repo.listProjections;
    if (typeof list !== "function") {
      return null;
    }
    const all = await list("", 0);
    return all.find((entry) => entry.adoption_binding.write_id === write_id) ?? null;
  }

  async beginTrial(input: { projection_id: string; now: number }): Promise<RevResult<ExperienceProjection>> {
    const projection = await this.deps.repo.getProjection(input.projection_id);
    if (projection === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "begin_trial", false));
    }
    const plan = await this.deps.repo.getValidationPlan(projection.validation_plan_id);
    if (plan === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "begin_trial", false));
    }
    const committed = await this.deps.commit.beginTrial({ projection, plan, now: input.now });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value.projection);
  }

  async recordUsage(input: RecordUsageInput): Promise<RevResult<UsageVerificationRecord>> {
    const projection = await this.deps.repo.getProjection(input.projection_id);
    if (projection === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "usage_record", false));
    }
    const plan = await this.deps.repo.getValidationPlan(projection.validation_plan_id);
    if (plan === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "usage_record", false));
    }
    const trigger = await this.deps.triggerFacts(input.trigger_event_id);
    if (!trigger.ok) {
      return revErr(revErrorFromEnvelope(trigger.error));
    }
    const verifier = await this.deps.verifierRegistry.resolve(input.verification_ref);
    if (!verifier.ok) {
      return revErr(revErrorFromEnvelope(verifier.error));
    }
    const existing = await this.deps.repo.listUsage(projection.projection_id);
    const windowIndex = windowIndexFor(projection, existing);
    const record = computeUsageRecord({
      projection,
      plan,
      version_binding: trigger.value.version_binding,
      task_family_id: trigger.value.task_family_id,
      trigger_result: trigger.value.trigger_result,
      loading: trigger.value.loading,
      behavior_evidence_refs: input.behavior_evidence_refs,
      behavior_summary: trigger.value.behavior_summary,
      verification: {
        kind: verifier.value.kind,
        independence: verifier.value.independence,
        status: trigger.value.verification_status,
        verifier_ref: input.verification_ref,
        binding_ref: verifier.value.binding_ref,
        validation_plan_hash: projection.validation_plan_hash,
        version_binding: trigger.value.verification_version_binding
      },
      outcome_ref: input.outcome_ref ?? null,
      other_change_refs: input.other_change_refs,
      window_index: windowIndex,
      now: input.now
    });
    record.usage_id = newId("usg");
    const duplicate = existing.find((usage) => usage.usage_key === record.usage_key);
    if (duplicate !== undefined) {
      if (duplicateUsagePayload(duplicate, record)) {
        return revOk(duplicate);
      }
      return revErr({
        code: "E_EXPERIENCE_USAGE_KEY_COLLISION",
        retryable: false,
        stage: "usage_record",
        cause: record.usage_key
      });
    }
    const valid = validateUsageRecord(record);
    if (!valid.ok) {
      return revErr(revErrorFromEnvelope(valid.error));
    }
    const committed = await this.deps.commit.recordUsage({
      projection,
      record,
      now: input.now
    });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  async evaluateLifecycle(input: {
    projection_id: string;
    now: number;
  }): Promise<RevResult<{ projection: ExperienceProjection; event: ExperienceLifecycleEvent }>> {
    const projection = await this.deps.repo.getProjection(input.projection_id);
    if (projection === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "lifecycle_evaluate", false));
    }
    const plan = await this.deps.repo.getValidationPlan(projection.validation_plan_id);
    if (plan === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "lifecycle_evaluate", false));
    }
    const usages = await this.deps.repo.listUsage(projection.projection_id);
    const hostFacts = this.deps.hostFacts.readInTransaction as unknown;
    void hostFacts;
    let facts: HostLifecycleFacts | null = null;
    let factsError: ErrorEnvelope | null = null;
    if (projection.baseline !== null) {
      try {
        const read = await this.deps.readHostFacts(projection);
        if (read.ok) {
          facts = read.value;
        } else {
          factsError = read.error;
        }
      } catch {
        factsError = revError({
          code: "E_EXPERIENCE_HOST_FACTS_UNAVAILABLE",
          details: { kind: "ipc", method: "readHostLifecycleFacts", connection_id: "host", frame_kind: "read" }
        });
      }
    }
    const lifecycleFacts: LifecycleFacts = {
      projection,
      plan,
      usages,
      now: input.now,
      grant_valid: true,
      write_state: projection.write.write_state ?? "verified",
      readback_verified: true,
      current_goal_version: projection.adoption_binding.version_binding.goal_version,
      host_facts: facts,
      host_facts_error: factsError,
      overlapping_regression: false,
      retention_policy: {
        invalidate_on_host_version_change: true,
        invalidate_on_tool_version_change: true,
        invalidate_on_model_family_change: true
      }
    };
    const evaluation = evaluateLifecycle(lifecycleFacts);
    if (!evaluation.ok) {
      return revErr(revErrorFromEnvelope(evaluation.error));
    }
    if (evaluation.value.action.kind === "none") {
      return revErr({
        code: "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION",
        retryable: false,
        stage: "lifecycle_evaluate",
        cause: "no_predicate"
      });
    }
    const committed = await this.deps.commit.applyLifecycle({
      projection,
      action: evaluation.value.action,
      now: input.now
    });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  async extendWindow(input: { projection_id: string; now: number }): Promise<RevResult<ExperienceProjection>> {
    const projection = await this.deps.repo.getProjection(input.projection_id);
    if (projection === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "extend_window", false));
    }
    const plan = await this.deps.repo.getValidationPlan(projection.validation_plan_id);
    if (plan === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "extend_window", false));
    }
    const predicate = extendWindowPredicate({
      projection,
      plan,
      usages: [],
      now: input.now,
      grant_valid: true,
      write_state: projection.write.write_state ?? "verified",
      readback_verified: true,
      current_goal_version: projection.adoption_binding.version_binding.goal_version,
      host_facts: null,
      host_facts_error: null,
      overlapping_regression: false,
      retention_policy: {
        invalidate_on_host_version_change: true,
        invalidate_on_tool_version_change: true,
        invalidate_on_model_family_change: true
      }
    });
    if (!predicate.ok) {
      return revErr(revErrorFromEnvelope(predicate.error));
    }
    const committed = await this.deps.commit.extendWindow({ projection, plan, now: input.now });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  async revoke(input: {
    projection_id: string;
    actor: "user" | "authorization_owner";
    now: number;
  }): Promise<RevResult<ExperienceProjection>> {
    const projection = await this.deps.repo.getProjection(input.projection_id);
    if (projection === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "lifecycle", false));
    }
    if (
      projection.lifecycle !== "checked" &&
      projection.lifecycle !== "trial" &&
      projection.lifecycle !== "retained"
    ) {
      return revErr({
        code: "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION",
        retryable: false,
        stage: "lifecycle",
        cause: projection.lifecycle
      });
    }
    const reason = revokeReason(input.actor);
    const committed = await this.deps.commit.revoke({
      projection,
      reason: reason.reason === "authorization_revoked" ? "authorization_revoked" : "user_revoked",
      now: input.now
    });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  async rollback(input: {
    projection_id: string;
    target_version?: number;
    grant_id: string;
    now: number;
  }): Promise<RevResult<{ projection: ExperienceProjection; write_id: string }>> {
    const projection = await this.deps.repo.getProjection(input.projection_id);
    if (projection === null) {
      return revErr(revErrorFromCode("E_WRITE_NOT_FOUND", "rollback", false));
    }
    if (input.target_version !== undefined && input.target_version >= projection.experience_version) {
      return revErr({
        code: "E_WRITE_ROLLBACK_TARGET",
        retryable: false,
        stage: "rollback",
        cause: String(input.target_version)
      });
    }
    const committed = await this.deps.commit.rollback({ ...input, projection });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

}

function revErrorFromCode(code: string, stage: string, retryable: boolean): RevError {
  return { code, retryable, stage };
}

export function projectionIdentity(projection: ExperienceProjection): string {
  return `${projection.projection_id}:${projectionHash(projection)}`;
}

export interface AdoptionAdmissionInput {
  proposal: import("./types.js").Proposal;
  view: import("./host-contracts.js").WriteAdoptionView;
  grant_id: string;
  snapshot_binding: VersionBinding;
  write_result_ref: SourceRef;
  now: number;
}

/**
 * T7 synchronous-stage admission: validates the FND `WriteAdoptionView` and
 * freezes the `AdoptionBinding` inside the writer-lock callback. The caller
 * commits the returned binding; no I/O happens here.
 */
export function admissionRecordAdoption(
  input: AdoptionAdmissionInput
): Result<import("./types.js").AdoptionBinding, ErrorEnvelope> {
  const validated = validateAdoptionView({
    proposal: input.proposal,
    view: input.view,
    grant_id: input.grant_id,
    snapshot_binding: input.snapshot_binding
  });
  if (!validated.ok) {
    return err(validated.error);
  }
  return ok(
    buildAdoptionBinding({
      proposal: input.proposal,
      view: input.view,
      write_result_ref: input.write_result_ref,
      now: input.now
    })
  );
}

/** Alias used by FND `commitLiveGated` adapters. */
export const commitAdoptionAdmission: (
  input: AdoptionAdmissionInput
) => Result<import("./types.js").AdoptionBinding, ErrorEnvelope> = admissionRecordAdoption;
