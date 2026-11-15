import { compareUtf8 } from "@evoplug/core";
import type { ContentKey, ErrorEnvelope, Hash, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type {
  LedgerCorrection,
  LedgerFeedbackRow,
  FeedbackRecord,
} from "../domain/feedback.js";
import type {
  LedgerEvidenceSnapshot,
  LedgerView,
  PendingWorkItem,
  SuccessEvidence,
  SuccessEvidenceKind,
  SuccessEvidenceProducerKind,
  TaskOutcomeRecord,
} from "../domain/outcome.js";
import type { HumanAttestation } from "../domain/common.js";
import type {
  CurrentRequirement,
  UnverifiedConstraint,
  RequirementScope,
} from "../domain/requirements.js";
import type { VerifierRegistryView } from "../domain/facts.js";
import type { LedgerPorts } from "../ports.js";
import type {
  FactVerificationStateRow,
  FeedbackStateRow,
  LedgerCorrectionStateRow,
  UnverifiedConstraintStateRow,
} from "../rows.js";
import { asofUnavailable, ledgerOk, watermarkAheadError, versionBindingError } from "../errors.js";
import { constraintsViewHash, evidenceSnapshotViewHash, ledgerViewHash } from "../hashes.js";
import {
  parseBindingFromJson,
  parseJsonArrayStrings,
  parseJsonObject,
  parseJsonValueText,
  parseMethodRefFromJson,
  parseScopeFromJson,
  parseSourceRefArray,
} from "../repositories/parse.js";
import { isSourceRef } from "../source-ref.js";
import { projectRequirementsAsOf } from "../requirements/asof.js";
import { buildStateFactView } from "../facts/aggregate.js";
import { validateVersionBinding } from "../validation.js";

function bindingMatchesText(bindingJson: string, binding: VersionBinding): boolean {
  const parsed = parseBindingFromJson(bindingJson);
  if (parsed === null) return false;
  return (
    parsed.task_id === binding.task_id &&
    parsed.branch_id === binding.branch_id &&
    parsed.input_epoch === binding.input_epoch &&
    parsed.goal_version === binding.goal_version &&
    parsed.config_version === binding.config_version &&
    parsed.watermark === binding.watermark
  );
}

/**
 * Read side for `readLedger` and `readEvidenceLedger`. Every method reads one
 * committed snapshot and never creates, repairs or refreshes rows.
 */
export class LedgerReadService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  async readEvidenceLedger(input: {
    readonly binding: VersionBinding;
  }): Promise<Result<LedgerEvidenceSnapshot, ErrorEnvelope>> {
    const binding = input.binding;
    const bindingResult = validateVersionBinding(binding);
    if (!bindingResult.ok) return bindingResult;

    const receipt = await this.#ports.identity.getReceiptSeq();
    if (!receipt.ok) return receipt;
    if (binding.watermark > receipt.value) return watermarkAheadError();

    const query = {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      watermark: binding.watermark,
    };
    const [
      requirementRows,
      opRows,
      sourceRows,
      snapshotRows,
      feedbackRows,
      constraintRows,
    ] = await Promise.all([
      this.#ports.projection.listRequirementRows(query),
      this.#ports.projection.listRequirementOpRows(query),
      this.#ports.projection.listRequirementSources(query),
      this.#ports.projection.listGoalSnapshots({
        task_id: binding.task_id,
        branch_id: binding.branch_id,
        goal_version: binding.goal_version,
        watermark_max: binding.watermark,
      }),
      this.#ports.projection.listFeedbackRows(query),
      this.#ports.projection.listConstraintRows(query),
    ]);
    if (!requirementRows.ok) return requirementRows;
    if (!opRows.ok) return opRows;
    if (!sourceRows.ok) return sourceRows;
    if (!snapshotRows.ok) return snapshotRows;
    if (!feedbackRows.ok) return feedbackRows;
    if (!constraintRows.ok) return constraintRows;

    for (const row of requirementRows.value) {
      if (row.task_id !== binding.task_id || row.branch_id !== binding.branch_id) {
        return versionBindingError();
      }
    }

    const eventWatermarks = new Map<string, number>();
    for (const op of opRows.value) {
      const event = await this.#ports.events.getEvent(op.source_event_id);
      if (!event.ok) return event;
      if (event.value === null) return asofUnavailable();
      eventWatermarks.set(op.source_event_id, event.value.watermark);
    }

    const projected = projectRequirementsAsOf({
      binding,
      requirements: requirementRows.value,
      requirement_ops: opRows.value,
      requirement_sources: sourceRows.value,
      goal_snapshots: snapshotRows.value,
      event_watermarks: eventWatermarks,
    });
    if (!projected.ok) return projected;

    const feedback: LedgerFeedbackRow[] = [];
    for (const row of feedbackRows.value) {
      if (row.task_id !== binding.task_id || row.branch_id !== binding.branch_id) {
        return versionBindingError();
      }
      const event = await this.#ports.events.getEvent(row.source_event_id);
      if (!event.ok) return event;
      if (event.value === null) return asofUnavailable();
      if (event.value.watermark > binding.watermark) continue;
      feedback.push({
        feedback_id: row.feedback_id,
        target_issue_id: row.target_issue_id,
        origin: event.value.origin,
        signal_kind: row.kind,
        status: row.status,
        goal_version: row.goal_version,
        input_epoch: row.input_epoch,
        source_refs: [row.quote_ref],
        recorded_at: row.recorded_at,
        recorded_at_watermark: event.value.watermark,
      });
    }
    feedback.sort((a, b) => {
      const aTarget = a.target_issue_id;
      const bTarget = b.target_issue_id;
      if (aTarget !== bTarget) {
        if (aTarget === null) return 1;
        if (bTarget === null) return -1;
        return compareUtf8(aTarget, bTarget);
      }
      if (a.recorded_at_watermark !== b.recorded_at_watermark) {
        return a.recorded_at_watermark - b.recorded_at_watermark;
      }
      return compareUtf8(a.feedback_id, b.feedback_id);
    });

    const constraints: UnverifiedConstraint[] = [];
    for (const row of constraintRows.value) {
      if (row.task_id !== binding.task_id || row.branch_id !== binding.branch_id) {
        return versionBindingError();
      }
      if (!bindingMatchesText(row.binding_json, binding)) continue;
      if (row.recorded_at_watermark > binding.watermark) continue;
      const parsed = constraintFromRow(row);
      if (parsed === null) return asofUnavailable();
      constraints.push(parsed);
    }
    constraints.sort((a, b) => {
      if (a.recorded_at_watermark !== b.recorded_at_watermark) {
        return a.recorded_at_watermark - b.recorded_at_watermark;
      }
      return compareUtf8(a.constraint_id, b.constraint_id);
    });

    const constraintsHash = constraintsViewHash(binding, constraints);
    const withoutHash = {
      schema_version: "rsi.ledger_evidence_snapshot/1" as const,
      binding,
      constraints_view_hash: constraintsHash,
      active_requirement_ids: projected.value.active_requirement_ids,
      requirements: projected.value.requirements,
      requirement_ops: projected.value.requirement_ops,
      feedback,
      constraints,
    };
    return ledgerOk({ ...withoutHash, view_hash: evidenceSnapshotViewHash(withoutHash) });
  }

  async readLedger(input: {
    readonly binding: VersionBinding;
  }): Promise<Result<LedgerView, ErrorEnvelope>> {
    const binding = input.binding;
    const snapshot = await this.readEvidenceLedger({ binding });
    if (!snapshot.ok) return snapshot;

    const query = {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      watermark: binding.watermark,
    };
    const [factRows, verificationRows, correctionRows, outcomeRows, feedbackRows] =
      await Promise.all([
        this.#ports.projection.listFactRows(query),
        this.#ports.projection.listFactVerificationRows(query),
        this.#ports.projection.listCorrectionRows(query),
        this.#ports.projection.listTaskOutcomeRows(query),
        this.#ports.projection.listFeedbackRows(query),
      ]);
    if (!factRows.ok) return factRows;
    if (!verificationRows.ok) return verificationRows;
    if (!correctionRows.ok) return correctionRows;
    if (!outcomeRows.ok) return outcomeRows;
    if (!feedbackRows.ok) return feedbackRows;

    const requirements: CurrentRequirement[] = snapshot.value.requirements
      .filter((row) => row.status === "active" || row.status === "proposed")
      .map((row) => ({
        requirement_id: row.requirement_id,
        revision: row.revision,
        statement_ref: row.statement_ref,
        statement_text_hash: row.statement_text_hash,
        scope: row.scope,
        acceptance: row.acceptance,
        status: row.status === "active" ? "active" : "proposed",
        source_refs: row.source_refs,
      }));

    const facts = [];
    for (const row of factRows.value) {
      const verifiers = verificationRows.value
        .filter((verification) => verification.fact_id === row.fact_id)
        .map((verification) => registryViewFromRow(verification, binding))
        .filter((view): view is VerifierRegistryView => view !== null);
      const view = buildStateFactView(row, verifiers);
      if (view !== null) facts.push(view);
    }
    facts.sort((a, b) => compareUtf8(a.fact_id, b.fact_id));

    const feedback: FeedbackRecord[] = [];
    for (const row of feedbackRows.value) {
      const record = await this.#feedbackRecord(row, binding);
      if (!record.ok) return record;
      if (record.value !== null) feedback.push(record.value);
    }

    const corrections: LedgerCorrection[] = [];
    for (const row of correctionRows.value) {
      const correction = correctionFromRow(row);
      if (correction === null) return asofUnavailable();
      corrections.push(correction);
    }
    corrections.sort((a, b) => compareUtf8(a.correction_id, b.correction_id));

    const outcome = currentOutcome(outcomeRows.value);
    if (outcome === null && outcomeRows.value.length > 0) return asofUnavailable();

    const viewWithoutHash = {
      binding,
      requirements,
      facts,
      feedback,
      corrections,
      constraints: [...snapshot.value.constraints],
      outcome,
    };
    return ledgerOk({ ...viewWithoutHash, view_hash: ledgerViewHash(viewWithoutHash) });
  }

  async #feedbackRecord(
    row: FeedbackStateRow,
    binding: VersionBinding,
  ): Promise<Result<FeedbackRecord | null, ErrorEnvelope>> {
    if (row.task_id !== binding.task_id || row.branch_id !== binding.branch_id) {
      return versionBindingError();
    }
    const event = await this.#ports.events.getEvent(row.source_event_id);
    if (!event.ok) return event;
    if (event.value === null) return asofUnavailable();
    if (event.value.watermark > binding.watermark) return ledgerOk(null);
    return ledgerOk({
      schema_version: "rsi.feedback/2",
      feedback_id: row.feedback_id,
      task_id: row.task_id,
      branch_id: row.branch_id,
      source_event_id: row.source_event_id,
      kind: row.kind,
      quote_ref: row.quote_ref,
      target_issue_id: row.target_issue_id,
      status: row.status,
      goal_version: row.goal_version,
      input_epoch: row.input_epoch,
      recorded_at: row.recorded_at,
    });
  }
}

function constraintFromRow(row: UnverifiedConstraintStateRow): UnverifiedConstraint | null {
  const binding = parseBindingFromJson(row.binding_json);
  if (binding === null) return null;
  let scopeHint: RequirementScope | null = null;
  if (row.scope_hint_json !== null) {
    scopeHint = parseScopeFromJson(row.scope_hint_json);
    if (scopeHint === null) return null;
  }
  const usableFor = parseJsonArrayStrings(row.usable_for_json);
  if (usableFor === null) return null;
  const conflicts = parseJsonArrayStrings(row.conflict_with_requirement_ids_json);
  if (conflicts === null) return null;
  const usable: Array<"context" | "review" | "trial"> = [];
  for (const value of usableFor) {
    if (value !== "context" && value !== "review" && value !== "trial") return null;
    usable.push(value);
  }
  return {
    schema_version: "rsi.unverified_constraint/2",
    constraint_id: row.constraint_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    binding,
    source_event_id: row.source_event_id,
    source_ref: row.source_ref,
    quote: row.quote,
    quote_hash: row.quote_hash,
    scope_hint: scopeHint,
    status: row.status,
    authorization: 0,
    usable_for: usable,
    conflict_with_requirement_ids: conflicts as Id<"req">[],
    confirmed_by_event_id: row.confirmed_by_event_id,
    recorded_at_watermark: row.recorded_at_watermark,
    created_at: row.created_at,
    row_version: row.row_version,
  };
}

function correctionFromRow(row: LedgerCorrectionStateRow): LedgerCorrection | null {
  const replacements = parseJsonArrayStrings(row.replacement_op_ids_json);
  const judgments = parseJsonArrayStrings(row.invalidated_judgment_ids_json);
  if (replacements === null || judgments === null) return null;
  return {
    schema_version: "rsi.ledger_correction/2",
    correction_id: row.correction_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    corrected_record_id: row.corrected_record_id,
    correction_kind: row.correction_kind,
    original_source_event_id: row.original_source_event_id,
    original_source_ref: row.original_source_ref,
    original_text_hash: row.original_text_hash,
    status: row.status,
    recorded_at: row.recorded_at,
    valid_from_event: row.valid_from_event,
    replacement_op_ids: replacements as Id<"reqop">[],
    invalidated_judgment_ids: judgments,
    correction_hash: row.correction_hash,
  };
}

function registryViewFromRow(
  row: FactVerificationStateRow,
  binding: VersionBinding,
): VerifierRegistryView | null {
  const reservationIds = parseJsonArrayStrings(row.reservation_ids_json);
  const requirementIds = parseJsonArrayStrings(row.requirement_ids_json);
  const propositionIds = parseJsonArrayStrings(row.proposition_ids_json);
  const sourceIds = parseJsonArrayStrings(row.source_ids_json);
  const sourceRefs = parseSourceRefArray(row.source_refs_json);
  if (
    reservationIds === null ||
    requirementIds === null ||
    propositionIds === null ||
    sourceIds === null ||
    sourceRefs === null
  ) {
    return null;
  }
  return {
    schema_version: "rsi.fact_verification/1",
    fact_id: row.fact_id,
    event_id: row.event_id,
    verifier_ref: row.verifier_ref,
    verifier_id: row.verifier_id,
    verifier_kind: row.verifier_kind,
    method_ref: row.method_ref_json === null ? null : parseMethodRefFromJson(row.method_ref_json),
    reservation_ids: reservationIds as Id<"resv">[],
    independent: row.independent === 1,
    verification_binding: binding,
    requirement_ids: requirementIds as Id<"req">[],
    proposition_ids: propositionIds as ContentKey<"propo">[],
    effect: row.effect,
    artifact_version: row.artifact_version,
    source_ids: sourceIds,
    source_refs: sourceRefs,
    result: row.result,
    status: row.status,
    verified_at: row.verified_at,
    row_version: row.row_version,
  };
}

function currentOutcome(
  rows: ReadonlyArray<{
    readonly outcome_id: Id<"out">;
    readonly task_id: Id<"task">;
    readonly branch_id: Id<"br">;
    readonly revision: number;
    readonly outcome: TaskOutcomeRecord["outcome"];
    readonly success_evidence_refs_json: string;
    readonly uncovered_requirement_ids_json: string;
    readonly pending_work_json: string;
    readonly reason_code: string;
    readonly boundary_event_id: Id<"ev"> | null;
    readonly version_binding_json: string;
    readonly decided_at: number;
    readonly outcome_hash: Hash;
  }>,
): TaskOutcomeRecord | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.revision - a.revision);
  const latest = sorted[0];
  if (latest === undefined) return null;
  const binding = parseBindingFromJson(latest.version_binding_json);
  if (binding === null) return null;
  const refs = parseSourceRefArray(latest.success_evidence_refs_json);
  const uncovered = parseJsonArrayStrings(latest.uncovered_requirement_ids_json);
  const pending = parsePendingWork(latest.pending_work_json);
  if (refs === null || uncovered === null || pending === null) return null;
  return {
    schema_version: "rsi.task_outcome/2",
    outcome_id: latest.outcome_id,
    task_id: latest.task_id,
    branch_id: latest.branch_id,
    binding,
    revision: latest.revision,
    outcome: latest.outcome,
    success_evidence_refs: refs,
    uncovered_requirement_ids: uncovered as Id<"req">[],
    pending_work: pending,
    reason_code: latest.reason_code as TaskOutcomeRecord["reason_code"],
    boundary_event_id: latest.boundary_event_id,
    decided_at: latest.decided_at,
    outcome_hash: latest.outcome_hash,
  };
}

function parsePendingWork(text: string): PendingWorkItem[] | null {
  const parsed = parseJsonValueText(text);
  if (!Array.isArray(parsed)) return null;
  const out: PendingWorkItem[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const kind = record["kind"];
    const ref = record["ref"];
    const reason = record["reason_code"];
    if (
      (kind !== "issue" &&
        kind !== "review" &&
        kind !== "write" &&
        kind !== "delivery" &&
        kind !== "verification" &&
        kind !== "human_decision") ||
      typeof ref !== "string" ||
      (reason !== "queued" &&
        reason !== "in_progress" &&
        reason !== "awaiting_human" &&
        reason !== "awaiting_evidence")
    ) {
      return null;
    }
    out.push({ kind, ref, reason_code: reason });
  }
  return out;
}

/** Parses a success-evidence row into its domain shape; `null` if malformed. */
export function successEvidenceFromRow(row: {
  readonly evidence_id: Id<"sev">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly kind: SuccessEvidenceKind;
  readonly source_event_id: Id<"ev">;
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  readonly producer_kind: SuccessEvidenceProducerKind;
  readonly covered_requirement_ids_json: string;
  readonly version_binding_json: string;
  readonly human_attestation_json: string | null;
  readonly attestation_subject_hash: Hash | null;
  readonly verified_at: number;
  readonly recorded_at: number;
  readonly recorded_at_watermark: number;
  readonly evidence_hash: Hash;
  readonly row_version: number;
}): SuccessEvidence | null {
  const binding = parseBindingFromJson(row.version_binding_json);
  if (binding === null) return null;
  const covered = parseJsonArrayStrings(row.covered_requirement_ids_json);
  if (covered === null) return null;
  let attestation = null;
  if (row.human_attestation_json !== null) {
    const parsed = parseJsonObject(row.human_attestation_json);
    if (parsed === null) return null;
    attestation = parsed;
  }
  return {
    schema_version: "rsi.success_evidence/2",
    evidence_id: row.evidence_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    kind: row.kind,
    source_event_id: row.source_event_id,
    source_ref: row.source_ref,
    producer_ref: row.producer_ref,
    producer_kind: row.producer_kind,
    covered_requirement_ids: covered as Id<"req">[],
    binding,
    human_attestation: attestation === null ? null : parseAttestation(attestation),
    attestation_subject_hash: row.attestation_subject_hash,
    verified_at: row.verified_at,
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
    evidence_hash: row.evidence_hash,
    row_version: row.row_version,
  };
}

function parseAttestation(record: Record<string, unknown>): HumanAttestation | null {
  const kind = record["kind"];
  if (
    (kind !== "host_verified_interactive_user" &&
      kind !== "control_plane_explicit_confirmation") ||
    typeof record["capability_id"] !== "string" ||
    typeof record["evidence_ref"] !== "string" ||
    typeof record["confirmed_at"] !== "number"
  ) {
    return null;
  }
  if (!isSourceRef(record["evidence_ref"])) return null;
  return {
    kind,
    capability_id: record["capability_id"],
    evidence_ref: record["evidence_ref"],
    confirmed_at: record["confirmed_at"],
  };
}


