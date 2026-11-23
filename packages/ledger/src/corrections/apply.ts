import { canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result } from "@evoplug/core";
import type {
  CorrectionKind,
  LedgerCorrection,
  LedgerCorrectionDraft,
} from "../domain/feedback.js";
import type { LedgerCorrectionStateRow } from "../rows.js";
import { ledgerOk, schemaError } from "../errors.js";
import { isHash } from "../raw-hash.js";
import { isSourceRef } from "../source-ref.js";
import { isNonNegativeSafeInteger, isSortedUniqueStrings, uniqueSortedStrings } from "../util.js";
import { ledgerCorrectionHash } from "../hashes.js";

export const CORRECTION_KINDS: readonly CorrectionKind[] = [
  "missed_extraction",
  "wrong_extraction",
  "wrong_link",
];

export interface CorrectionApplyInput {
  readonly draft: LedgerCorrectionDraft;
  readonly correction_id: Id<"lcor">;
  readonly recorded_at: number;
  /** True when `original_source_ref` resolves through `SourceRefPort`. */
  readonly original_retrievable: boolean;
  /** True when the resolved bytes hash equals `original_text_hash`. */
  readonly original_hash_matches: boolean;
}

export interface CorrectionPlan {
  readonly correction: LedgerCorrection;
  readonly row: LedgerCorrectionStateRow;
  /** False when the original text is missing or its hash does not match. */
  readonly applied: boolean;
}

/**
 * Corrections only append. A missing or hash-mismatched original yields
 * `rejected_original_missing` with no replacement ops and leaves the active
 * requirements untouched. A correction never upgrades a proposed op to
 * active; each replacement op still follows the origin rules.
 */
export function finalizeLedgerCorrection(
  input: CorrectionApplyInput,
): Result<CorrectionPlan, ErrorEnvelope> {
  const draft = input.draft;
  if (draft.schema_version !== "rsi.ledger_correction_draft/1") {
    return schemaError<CorrectionPlan>("schema_version", "rsi.ledger_correction_draft/1");
  }
  if (!CORRECTION_KINDS.includes(draft.correction_kind)) {
    return schemaError<CorrectionPlan>("correction_kind", "closed_enum");
  }
  if (draft.corrected_record_id.length === 0) {
    return schemaError<CorrectionPlan>("corrected_record_id", "non_empty");
  }
  if (!isSourceRef(draft.original_source_ref)) {
    return schemaError<CorrectionPlan>("original_source_ref", "source_ref_format");
  }
  if (!isHash(draft.original_text_hash)) {
    return schemaError<CorrectionPlan>("original_text_hash", "sha256_lower_hex");
  }
  if (!isNonNegativeSafeInteger(draft.valid_from_event)) {
    return schemaError<CorrectionPlan>("valid_from_event", "non_negative_safe_integer");
  }
  if (!isNonNegativeSafeInteger(input.recorded_at)) {
    return schemaError<CorrectionPlan>("recorded_at", "non_negative_safe_integer");
  }
  if (!isSortedUniqueStrings(draft.replacement_op_ids)) {
    return schemaError<CorrectionPlan>("replacement_op_ids", "sorted_unique_utf8");
  }
  if (!isSortedUniqueStrings(draft.invalidated_judgment_ids)) {
    return schemaError<CorrectionPlan>("invalidated_judgment_ids", "sorted_unique_utf8");
  }

  const originalOk = input.original_retrievable && input.original_hash_matches;
  const status: LedgerCorrection["status"] = originalOk
    ? "applied"
    : "rejected_original_missing";

  if (originalOk && draft.replacement_op_ids.length === 0) {
    return schemaError<CorrectionPlan>("replacement_op_ids", "non_empty_for_applied");
  }

  const replacementOpIds = originalOk ? uniqueSortedStrings(draft.replacement_op_ids) : [];
  const invalidated =
    originalOk ? uniqueSortedStrings(draft.invalidated_judgment_ids) : [];

  const correctionBase = {
    schema_version: "rsi.ledger_correction/2" as const,
    correction_id: input.correction_id,
    task_id: draft.task_id,
    branch_id: draft.branch_id,
    corrected_record_id: draft.corrected_record_id,
    correction_kind: draft.correction_kind,
    original_source_event_id: draft.original_source_event_id,
    original_source_ref: draft.original_source_ref,
    original_text_hash: draft.original_text_hash,
    status,
    recorded_at: input.recorded_at,
    valid_from_event: draft.valid_from_event,
    replacement_op_ids: replacementOpIds,
    invalidated_judgment_ids: invalidated,
  };
  const correction: LedgerCorrection = {
    ...correctionBase,
    correction_hash: ledgerCorrectionHash(correctionBase),
  };

  const row: LedgerCorrectionStateRow = {
    correction_id: correction.correction_id,
    task_id: correction.task_id,
    branch_id: correction.branch_id,
    corrected_record_id: correction.corrected_record_id,
    correction_kind: correction.correction_kind,
    original_source_event_id: correction.original_source_event_id,
    original_source_ref: correction.original_source_ref,
    original_text_hash: correction.original_text_hash,
    status: correction.status,
    recorded_at: correction.recorded_at,
    valid_from_event: correction.valid_from_event,
    replacement_op_ids_json: canonicalJsonText(correction.replacement_op_ids),
    invalidated_judgment_ids_json: canonicalJsonText(correction.invalidated_judgment_ids),
    correction_hash: correction.correction_hash,
  };

  return ledgerOk({ correction, row, applied: originalOk });
}
