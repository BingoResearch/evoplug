import { newId } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type { HumanAttestation } from "../domain/common.js";
import type {
  ActiveRequirement,
  ExplicitLifecycleEvent,
  PendingWorkItem,
  SuccessEvidence,
  SuccessEvidenceKind,
  SuccessEvidenceProducerKind,
  TaskOutcomeRecord,
} from "../domain/outcome.js";
import type { LedgerPorts } from "../ports.js";
import type { SuccessEvidenceStateRow, TaskOutcomeStateRow } from "../rows.js";
import { evaluateTaskOutcome } from "../outcome/evaluate.js";
import { ledgerOk } from "../errors.js";
import { taskOutcomeRowJson } from "../rows.js";
import { parseAcceptanceText } from "../requirements/asof.js";
import { buildStateFactView } from "../facts/aggregate.js";
import { commitStateRows, stateRowWrite } from "./commit.js";
import { validateVersionBinding } from "../validation.js";

export interface EvaluateTaskOutcomeRequest {
  readonly binding: VersionBinding;
  readonly boundary_event_id: Id<"ev"> | null;
  readonly explicit_lifecycle_event: ExplicitLifecycleEvent | null;
  readonly pending_work: readonly PendingWorkItem[];
  readonly external_blockers: readonly string[];
}

/**
 * Task outcome service. It reads the current ledger projection and appends a
 * new outcome revision; it never updates or deletes earlier revisions.
 */
export class OutcomeService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  async evaluateTaskOutcome(
    request: EvaluateTaskOutcomeRequest,
  ): Promise<Result<TaskOutcomeRecord, ErrorEnvelope>> {
    const bindingResult = validateVersionBinding(request.binding);
    if (!bindingResult.ok) return bindingResult;

    const query = {
      task_id: request.binding.task_id,
      branch_id: request.binding.branch_id,
      watermark: request.binding.watermark,
    };
    const [requirementRows, headRows, evidenceRows, factRows, verificationRows, outcomeRows] =
      await Promise.all([
        this.#ports.projection.listRequirementRows(query),
        this.#ports.projection.listRequirementHeads(query),
        this.#ports.projection.listSuccessEvidenceRows(query),
        this.#ports.projection.listFactRows(query),
        this.#ports.projection.listFactVerificationRows(query),
        this.#ports.projection.listTaskOutcomeRows(query),
      ]);
    if (!requirementRows.ok) return requirementRows;
    if (!headRows.ok) return headRows;
    if (!evidenceRows.ok) return evidenceRows;
    if (!factRows.ok) return factRows;
    if (!verificationRows.ok) return verificationRows;
    if (!outcomeRows.ok) return outcomeRows;

    const activeRequirements = this.#activeRequirements(
      requirementRows.value,
      headRows.value,
      request.binding,
    );

    const evidence: SuccessEvidence[] = [];
    for (const row of evidenceRows.value) {
      const parsed = successEvidenceFromRow(row);
      if (parsed !== null) evidence.push(parsed);
    }

    const facts = [];
    for (const row of factRows.value) {
      const verifiers = verificationRows.value.filter(
        (verification) => verification.fact_id === row.fact_id,
      );
      const view = buildStateFactView(
        row,
        verifiers.map((verification) => ({
          schema_version: "rsi.fact_verification/1" as const,
          fact_id: verification.fact_id,
          event_id: verification.event_id,
          verifier_ref: verification.verifier_ref,
          verifier_id: verification.verifier_id,
          verifier_kind: verification.verifier_kind,
          method_ref: null,
          reservation_ids: [],
          independent: verification.independent === 1,
          verification_binding: request.binding,
          requirement_ids: [],
          proposition_ids: [],
          effect: verification.effect,
          artifact_version: verification.artifact_version,
          source_ids: [],
          source_refs: [],
          result: verification.result,
          status: verification.status,
          verified_at: verification.verified_at,
          row_version: verification.row_version,
        })),
      );
      if (view !== null) facts.push(view);
    }

    const previous = latestOutcome(outcomeRows.value);
    const evaluated = evaluateTaskOutcome({
      binding: request.binding,
      outcome_id: newId("out"),
      revision: previous === null ? 1 : previous.revision + 1,
      previous,
      active_requirements: activeRequirements,
      success_evidence: evidence,
      supporting_facts: facts,
      pending_work: request.pending_work,
      unresolved_issue_ids: [],
      explicit_lifecycle_event: request.explicit_lifecycle_event,
      external_blockers: request.external_blockers,
      boundary_event_id: request.boundary_event_id,
      decided_at: this.#ports.clock.now(),
    });
    if (!evaluated.ok) return evaluated;

    const commit = await commitStateRows(this.#ports, request.binding, [
      stateRowWrite(
        "rsi.task_outcome_row/1",
        "insert",
        taskOutcomeRowJson(evaluated.value.row),
      ),
    ]);
    if (!commit.ok) return commit;
    return ledgerOk(evaluated.value.record);
  }

  #activeRequirements(
    rows: ReadonlyArray<{
      readonly requirement_id: Id<"req">;
      readonly revision: number;
      readonly valid_from_event: number;
      readonly valid_to_event: number | null;
      readonly acceptance_json: string;
    }>,
    heads: ReadonlyArray<{ readonly requirement_id: Id<"req">; readonly revision: number; readonly status: string }>,
    binding: VersionBinding,
  ): ActiveRequirement[] {
    const headMap = new Map(heads.map((head) => [head.requirement_id, head]));
    const out: ActiveRequirement[] = [];
    for (const row of rows) {
      const head = headMap.get(row.requirement_id);
      if (head === undefined || head.status !== "active") continue;
      if (head.revision !== row.revision) continue;
      if (row.valid_from_event > binding.watermark) continue;
      if (row.valid_to_event !== null && row.valid_to_event <= binding.watermark) continue;
      const acceptance = parseAcceptanceText(row.acceptance_json);
      if (acceptance === null) continue;
      out.push({ requirement_id: row.requirement_id, acceptance });
    }
    return out.sort((a, b) => (a.requirement_id < b.requirement_id ? -1 : 1));
  }
}

function latestOutcome(rows: readonly TaskOutcomeStateRow[]): TaskOutcomeRecord | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.revision - a.revision);
  const latest = sorted[0];
  if (latest === undefined) return null;
  const binding = parseBinding(latest.version_binding_json);
  if (binding === null) return null;
  return {
    schema_version: "rsi.task_outcome/2",
    outcome_id: latest.outcome_id,
    task_id: latest.task_id,
    branch_id: latest.branch_id,
    binding,
    revision: latest.revision,
    outcome: latest.outcome,
    success_evidence_refs: parseArray<SourceRef>(latest.success_evidence_refs_json),
    uncovered_requirement_ids: parseArray<Id<"req">>(latest.uncovered_requirement_ids_json),
    pending_work: parsePendingWork(latest.pending_work_json),
    reason_code: latest.reason_code as TaskOutcomeRecord["reason_code"],
    boundary_event_id: latest.boundary_event_id,
    decided_at: latest.decided_at,
    outcome_hash: latest.outcome_hash,
  };
}

function successEvidenceFromRow(row: SuccessEvidenceStateRow): SuccessEvidence | null {
  const binding = parseBinding(row.version_binding_json);
  if (binding === null) return null;
  const attestation = row.human_attestation_json === null
    ? null
    : parseAttestation(row.human_attestation_json);
  return {
    schema_version: "rsi.success_evidence/2",
    evidence_id: row.evidence_id,
    task_id: row.task_id,
    branch_id: row.branch_id,
    kind: row.kind as SuccessEvidenceKind,
    source_event_id: row.source_event_id,
    source_ref: row.source_ref,
    producer_ref: row.producer_ref,
    producer_kind: row.producer_kind as SuccessEvidenceProducerKind,
    covered_requirement_ids: parseArray<Id<"req">>(row.covered_requirement_ids_json),
    binding,
    human_attestation: attestation,
    attestation_subject_hash: row.attestation_subject_hash,
    verified_at: row.verified_at,
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
    evidence_hash: row.evidence_hash,
    row_version: row.row_version,
  };
}

function parseBinding(text: string): VersionBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["task_id"] !== "string" ||
    typeof record["branch_id"] !== "string" ||
    typeof record["input_epoch"] !== "number" ||
    typeof record["goal_version"] !== "string" ||
    typeof record["config_version"] !== "string" ||
    typeof record["watermark"] !== "number"
  ) {
    return null;
  }
  return {
    task_id: record["task_id"] as Id<"task">,
    branch_id: record["branch_id"] as Id<"br">,
    input_epoch: record["input_epoch"],
    goal_version: record["goal_version"],
    config_version: record["config_version"],
    watermark: record["watermark"],
  };
}

function parseAttestation(text: string): HumanAttestation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
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
  return {
    kind,
    capability_id: record["capability_id"],
    evidence_ref: record["evidence_ref"] as SourceRef,
    confirmed_at: record["confirmed_at"],
  };
}

function parseArray<T extends string>(text: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is T => typeof item === "string");
}

function parsePendingWork(text: string): PendingWorkItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PendingWorkItem[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["kind"] !== "string" || typeof record["ref"] !== "string") continue;
    if (typeof record["reason_code"] !== "string") continue;
    out.push({
      kind: record["kind"] as PendingWorkItem["kind"],
      ref: record["ref"],
      reason_code: record["reason_code"] as PendingWorkItem["reason_code"],
    });
  }
  return out;
}
