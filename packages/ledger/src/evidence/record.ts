import { canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result } from "@evoplug/core";
import type { HumanAttestation } from "../domain/common.js";
import type {
  RecordSuccessEvidenceRequest,
  SuccessEvidence,
  SuccessEvidenceKind,
} from "../domain/outcome.js";
import type { SuccessEvidenceStateRow } from "../rows.js";
import type { LedgerSourceEvent, HumanProofVerdict } from "../ports.js";
import { ledgerFailure, ledgerOk, schemaError } from "../errors.js";
import { successEvidenceHash } from "../hashes.js";
import { humanAttestationJson, versionBindingJson } from "../json.js";
import { isSourceRef } from "../source-ref.js";
import { isSortedUniqueStrings, uniqueSortedStrings } from "../util.js";
import { validateVersionBinding } from "../validation.js";

export const SUCCESS_EVIDENCE_KINDS: readonly SuccessEvidenceKind[] = [
  "human_acceptance",
  "test_pass",
  "artifact_check",
  "external_verification",
];

/** Verification facts needed for the non-human evidence gate. */
export interface VerifierEvidenceFacts {
  readonly event_type: string;
  readonly verification_status: "valid" | "invalidated" | "unknown";
  readonly result: "verified" | "contradicted" | "unknown";
  readonly effect: "supports" | "violates" | "unknown";
  readonly independent: boolean;
  readonly verification_artifact_version: string | null;
  readonly fact_truth_state: string;
  readonly fact_stale: boolean;
  readonly fact_artifact_version: string | null;
}

export interface SuccessEvidenceContext {
  readonly evidence_id: Id<"sev">;
  readonly source_event: LedgerSourceEvent;
  /** `null` for `human_acceptance`. */
  readonly verifier_facts: VerifierEvidenceFacts | null;
  /** Requirement IDs active at `binding.watermark` in this task/branch. */
  readonly active_requirement_ids: ReadonlySet<string>;
  /** Result of `OriginProofPort.verifyHuman` for human acceptance. */
  readonly human_proof: HumanProofVerdict | null;
  readonly source_retrievable: boolean;
  readonly producer_retrievable: boolean;
  readonly source_hash_matches: boolean;
  readonly producer_hash_matches: boolean;
  readonly recorded_at: number;
}

export interface SuccessEvidencePlan {
  readonly evidence: SuccessEvidence;
  readonly row: SuccessEvidenceStateRow;
  /** True when an identical `(branch_id, evidence_hash)` row already exists. */
  readonly duplicate: boolean;
}

function bindingError<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SUCCESS_EVIDENCE_BINDING",
    category: "version",
    details: { kind: "none" },
    stage: "success_evidence_write",
  });
}

function attestationError<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SUCCESS_EVIDENCE_ATTESTATION",
    category: "authorization",
    details: { kind: "none" },
    stage: "success_evidence_write",
  });
}

function unverifiedError<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SUCCESS_EVIDENCE_UNVERIFIED",
    category: "authorization",
    details: { kind: "none" },
    stage: "success_evidence_write",
  });
}

function requirementError<T>(requirementId: string): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SUCCESS_EVIDENCE_REQUIREMENT",
    category: "conflict",
    details: { kind: "field", path: "covered_requirement_ids", rule: "active_" + requirementId },
    stage: "success_evidence_write",
  });
}

function attestationEqual(a: HumanAttestation, b: HumanAttestation): boolean {
  return (
    a.kind === b.kind &&
    a.capability_id === b.capability_id &&
    a.evidence_ref === b.evidence_ref &&
    a.confirmed_at === b.confirmed_at
  );
}

/**
 * `recordSuccessEvidence` validation (DD-FND-054, DD-FND-074).
 *
 * The task/branch check runs first; only then are the event type and
 * verification content checked. Failure codes are distinct so callers can
 * tell a binding error from an attestation or verification error.
 */
export function validateSuccessEvidence(
  request: RecordSuccessEvidenceRequest,
  context: SuccessEvidenceContext,
): Result<SuccessEvidencePlan, ErrorEnvelope> {
  const bindingResult = validateVersionBinding(request.binding);
  if (!bindingResult.ok) return bindingResult;
  if (!SUCCESS_EVIDENCE_KINDS.includes(request.kind)) {
    return schemaError<SuccessEvidencePlan>("kind", "closed_enum");
  }
  if (!isSourceRef(request.source_ref)) {
    return schemaError<SuccessEvidencePlan>("source_ref", "source_ref_format");
  }
  if (!isSourceRef(request.producer_ref)) {
    return schemaError<SuccessEvidencePlan>("producer_ref", "source_ref_format");
  }

  const event = context.source_event;
  if (event.task_id !== request.binding.task_id || event.branch_id !== request.binding.branch_id) {
    return bindingError();
  }
  if (request.source_event_id !== event.event_id) {
    return bindingError();
  }

  let attestationSubjectHash: Hash | null = null;

  if (request.kind === "human_acceptance") {
    if (event.origin !== "human" || event.human_attestation === null) {
      return attestationError();
    }
    if (request.human_attestation === null) {
      return attestationError();
    }
    if (!attestationEqual(request.human_attestation, event.human_attestation)) {
      return attestationError();
    }
    if (request.producer_kind !== "human") {
      return attestationError();
    }
    if (context.human_proof !== "verified") {
      return attestationError();
    }
    attestationSubjectHash = event.event_key;
  } else {
    if (request.human_attestation !== null) {
      return attestationError();
    }
    if (request.producer_kind === "human") {
      return attestationError();
    }
    const facts = context.verifier_facts;
    if (facts === null) return unverifiedError();
    if (facts.event_type !== "fact_verification.recorded") return unverifiedError();
    if (facts.verification_status !== "valid") return unverifiedError();
    if (facts.result !== "verified") return unverifiedError();
    if (facts.effect !== "supports") return unverifiedError();
    if (!facts.independent) return unverifiedError();
    if (facts.fact_truth_state !== "verified") return unverifiedError();
    if (facts.fact_stale) return unverifiedError();
    if (facts.verification_artifact_version !== facts.fact_artifact_version) {
      return unverifiedError();
    }
  }

  if (!context.source_retrievable || !context.source_hash_matches) {
    return ledgerFailure<SuccessEvidencePlan>(
      {
        code: "E_SOURCE_NOT_FOUND",
        category: "source",
        details: { kind: "source", source_ref: request.source_ref, reason: "missing" },
        stage: "source_resolve",
      },
    );
  }
  if (!context.producer_retrievable || !context.producer_hash_matches) {
    return ledgerFailure<SuccessEvidencePlan>(
      {
        code: "E_SOURCE_HASH",
        category: "source",
        details: { kind: "source", source_ref: request.producer_ref, reason: "hash_mismatch" },
        stage: "source_verify",
      },
    );
  }

  if (!isSortedUniqueStrings(request.covered_requirement_ids)) {
    return requirementError("sorted_unique_utf8");
  }
  const covered = uniqueSortedStrings(request.covered_requirement_ids);
  for (const requirementId of covered) {
    if (!context.active_requirement_ids.has(requirementId)) {
      return requirementError(requirementId);
    }
  }

  const evidenceHash = successEvidenceHash({
    task_id: request.binding.task_id,
    branch_id: request.binding.branch_id,
    kind: request.kind,
    source_event_id: request.source_event_id,
    source_ref: request.source_ref,
    producer_ref: request.producer_ref,
    producer_kind: request.producer_kind,
    covered_requirement_ids: covered,
    binding: request.binding,
    attestation_subject_hash: attestationSubjectHash,
  });

  const evidence: SuccessEvidence = {
    schema_version: "rsi.success_evidence/2",
    evidence_id: context.evidence_id,
    task_id: request.binding.task_id,
    branch_id: request.binding.branch_id,
    kind: request.kind,
    source_event_id: request.source_event_id,
    source_ref: request.source_ref,
    producer_ref: request.producer_ref,
    producer_kind: request.producer_kind,
    covered_requirement_ids: covered,
    binding: request.binding,
    human_attestation: request.kind === "human_acceptance" ? request.human_attestation : null,
    attestation_subject_hash: attestationSubjectHash,
    verified_at: request.verified_at,
    recorded_at: context.recorded_at,
    recorded_at_watermark: event.watermark,
    evidence_hash: evidenceHash,
    row_version: 1,
  };

  const row: SuccessEvidenceStateRow = {
    evidence_id: evidence.evidence_id,
    task_id: evidence.task_id,
    branch_id: evidence.branch_id,
    kind: evidence.kind,
    source_event_id: evidence.source_event_id,
    source_ref: evidence.source_ref,
    producer_ref: evidence.producer_ref,
    producer_kind: evidence.producer_kind,
    covered_requirement_ids_json: canonicalJsonText(evidence.covered_requirement_ids),
    version_binding_json: canonicalJsonText(versionBindingJson(evidence.binding)),
    human_attestation_json:
      evidence.human_attestation === null
        ? null
        : canonicalJsonText(humanAttestationJson(evidence.human_attestation)),
    attestation_subject_hash: evidence.attestation_subject_hash,
    verified_at: evidence.verified_at,
    recorded_at: evidence.recorded_at,
    recorded_at_watermark: evidence.recorded_at_watermark,
    evidence_hash: evidence.evidence_hash,
    row_version: evidence.row_version,
  };

  return ledgerOk({ evidence, row, duplicate: false });
}

/**
 * A duplicate is the same `(branch_id, evidence_hash)`; the existing row is
 * returned unchanged and no second row is appended.
 */
export function isDuplicateSuccessEvidence(
  existing: { readonly evidence_hash: string } | null,
  incoming: { readonly evidence_hash: string },
): boolean {
  return existing !== null && existing.evidence_hash === incoming.evidence_hash;
}
