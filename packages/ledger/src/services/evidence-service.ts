import { newId } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result } from "@evoplug/core";
import type {
  RecordSuccessEvidenceRequest,
  SuccessEvidence,
} from "../domain/outcome.js";
import type { VerifierEvidenceFacts } from "../evidence/record.js";
import type { LedgerPorts } from "../ports.js";
import {
  isDuplicateSuccessEvidence,
  validateSuccessEvidence,
} from "../evidence/record.js";
import { ledgerOk, schemaError } from "../errors.js";
import { successEvidenceRowJson } from "../rows.js";
import { isRevisionValidAt } from "../requirements/asof.js";
import { commitStateRows, stateRowWrite } from "./commit.js";
import { validateVersionBinding } from "../validation.js";

/**
 * Success-evidence write service (DD-FND-054).
 *
 * Only the verification/termination services call this after the source event
 * is committed. It never trusts IPC or CLI self-signing: the source event, the
 * verification row and the source references are all re-read here.
 */
export class SuccessEvidenceService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  async recordSuccessEvidence(
    request: RecordSuccessEvidenceRequest,
  ): Promise<Result<SuccessEvidence, ErrorEnvelope>> {
    const bindingResult = validateVersionBinding(request.binding);
    if (!bindingResult.ok) return bindingResult;

    const event = await this.#ports.events.getEvent(request.source_event_id);
    if (!event.ok) return event;
    if (event.value === null) {
      return schemaError<SuccessEvidence>("source_event_id", "committed_event");
    }
    const sourceEvent = event.value;

    const query = {
      task_id: request.binding.task_id,
      branch_id: request.binding.branch_id,
      watermark: request.binding.watermark,
    };
    const [verificationRows, factRows, requirementRows, headRows, evidenceRows] =
      await Promise.all([
        this.#ports.projection.listFactVerificationRows(query),
        this.#ports.projection.listFactRows(query),
        this.#ports.projection.listRequirementRows(query),
        this.#ports.projection.listRequirementHeads(query),
        this.#ports.projection.listSuccessEvidenceRows(query),
      ]);
    if (!verificationRows.ok) return verificationRows;
    if (!factRows.ok) return factRows;
    if (!requirementRows.ok) return requirementRows;
    if (!headRows.ok) return headRows;
    if (!evidenceRows.ok) return evidenceRows;

    let verifierFacts: VerifierEvidenceFacts | null = null;
    if (request.kind !== "human_acceptance") {
      const verification = verificationRows.value.find(
        (row) => row.event_id === request.source_event_id,
      );
      if (verification === undefined) {
        return schemaError<SuccessEvidence>(
          "source_event_id",
          "fact_verification_recorded_event",
        );
      }
      const fact = factRows.value.find((row) => row.fact_id === verification.fact_id);
      if (fact === undefined) {
        return schemaError<SuccessEvidence>("fact_id", "existing_state_fact");
      }
      verifierFacts = {
        event_type: sourceEvent.event_type,
        verification_status: verification.status,
        result: verification.result,
        effect: verification.effect,
        independent: verification.independent === 1,
        verification_artifact_version: verification.artifact_version,
        fact_truth_state: fact.truth_state,
        fact_stale: fact.stale === 1,
        fact_artifact_version: fact.artifact_version,
      };
    }

    const activeRequirementIds = new Set<string>();
    const heads = new Map<string, { readonly status: string }>();
    for (const head of headRows.value) heads.set(head.requirement_id, head);
    for (const row of requirementRows.value) {
      const head = heads.get(row.requirement_id);
      if (head === undefined) continue;
      if (head.status !== "active") continue;
      if (!isRevisionValidAt(row, request.binding.watermark)) continue;
      activeRequirementIds.add(row.requirement_id);
    }

    let humanProof: "verified" | "unverified" | "conflict" | null = null;
    if (request.kind === "human_acceptance" && sourceEvent.human_attestation !== null) {
      if (sourceEvent.native_session_id === null) {
        return schemaError<SuccessEvidence>("source_event.native_session_id", "available");
      }
      humanProof = await this.#ports.proof.verifyHuman({
        attestation: sourceEvent.human_attestation,
        host_id: sourceEvent.host_id,
        config_space: sourceEvent.config_space,
        native_session_id: sourceEvent.native_session_id,
        event_key: sourceEvent.event_key,
      });
    }

    const [sourceResolved, producerResolved] = await Promise.all([
      this.#ports.sources.resolve(request.source_ref),
      this.#ports.sources.resolve(request.producer_ref),
    ]);
    if (!sourceResolved.ok) return sourceResolved;
    if (!producerResolved.ok) return producerResolved;

    const plan = validateSuccessEvidence(request, {
      evidence_id: newId("sev"),
      source_event: sourceEvent,
      verifier_facts: verifierFacts,
      active_requirement_ids: activeRequirementIds,
      human_proof: humanProof,
      source_retrievable: sourceResolved.value.retrievable,
      producer_retrievable: producerResolved.value.retrievable,
      source_hash_matches: sourceResolved.value.retrievable,
      producer_hash_matches: producerResolved.value.retrievable,
      recorded_at: this.#ports.clock.now(),
    });
    if (!plan.ok) return plan;

    const duplicate = evidenceRows.value.find(
      (row) =>
        row.branch_id === request.binding.branch_id &&
        isDuplicateSuccessEvidence(row, plan.value.evidence),
    );
    if (duplicate !== undefined) {
      return ledgerOk({
        ...plan.value.evidence,
        evidence_id: duplicate.evidence_id,
        recorded_at: duplicate.recorded_at,
        recorded_at_watermark: duplicate.recorded_at_watermark,
        row_version: duplicate.row_version,
      });
    }

    const commit = await commitStateRows(this.#ports, request.binding, [
      stateRowWrite(
        "rsi.success_evidence_row/1",
        "insert",
        successEvidenceRowJson(plan.value.row),
      ),
    ]);
    if (!commit.ok) return commit;
    return ledgerOk(plan.value.evidence);
  }
}

/** Active requirement IDs at a watermark, exposed for reuse by outcome tests. */
export function activeRequirementIdsAt(
  requirementRows: ReadonlyArray<{
    readonly requirement_id: Id<"req">;
    readonly valid_from_event: number;
    readonly valid_to_event: number | null;
  }>,
  headStatus: ReadonlyMap<string, string>,
  watermark: number,
): Id<"req">[] {
  const ids: Id<"req">[] = [];
  for (const row of requirementRows) {
    if (headStatus.get(row.requirement_id) !== "active") continue;
    if (!isRevisionValidAt(row, watermark)) continue;
    ids.push(row.requirement_id);
  }
  return ids.sort();
}
