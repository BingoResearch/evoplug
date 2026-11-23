import { newId } from "@evoplug/core";
import type { ErrorEnvelope, Result, VersionBinding } from "@evoplug/core";
import type { LedgerCorrectionDraft } from "../domain/feedback.js";
import type { CorrectionPlan } from "../corrections/apply.js";
import type { LedgerPorts } from "../ports.js";
import { finalizeLedgerCorrection } from "../corrections/apply.js";
import { ledgerOk } from "../errors.js";
import { ledgerCorrectionRowJson } from "../rows.js";
import { commitStateRows, stateRowWrite } from "./commit.js";

/**
 * Applies a ledger correction. The original source is resolved first; a
 * missing or hash-mismatched original records `rejected_original_missing`
 * with no replacement ops. Replacements never bypass origin rules.
 */
export class CorrectionService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  async applyLedgerCorrection(
    binding: VersionBinding,
    draft: LedgerCorrectionDraft,
  ): Promise<Result<CorrectionPlan, ErrorEnvelope>> {
    const resolved = await this.#ports.sources.resolve(draft.original_source_ref);
    if (!resolved.ok) return resolved;

    const retrievable = resolved.value.retrievable;
    const hashMatches =
      retrievable &&
      resolved.value.range_content_hash !== null &&
      resolved.value.range_content_hash === draft.original_text_hash;

    const plan = finalizeLedgerCorrection({
      draft,
      correction_id: newId("lcor"),
      recorded_at: this.#ports.clock.now(),
      original_retrievable: retrievable,
      original_hash_matches: hashMatches,
    });
    if (!plan.ok) return plan;

    const commit = await commitStateRows(this.#ports, binding, [
      stateRowWrite(
        "rsi.ledger_correction_row/1",
        "insert",
        ledgerCorrectionRowJson(plan.value.row),
      ),
    ]);
    if (!commit.ok) return commit;
    return ledgerOk(plan.value);
  }
}
