import type { ErrorEnvelope, Hash, Result, VersionBinding } from "@evoplug/core";
import type { JsonObject } from "../json.js";
import type {
  LedgerAppendReceipt,
  LedgerCommitOutcome,
  LedgerPorts,
  LedgerStateRowOperation,
  LedgerStateRowSchema,
  LedgerStateRowWrite,
} from "../ports.js";
import { ledgerOk } from "../errors.js";

export function stateRowWrite(
  rowSchema: LedgerStateRowSchema,
  operation: LedgerStateRowOperation,
  row: JsonObject,
  documentId: Hash | null = null,
): LedgerStateRowWrite {
  return { row_schema: rowSchema, operation, row, document_id: documentId };
}

export interface CommitResult {
  readonly receipt: LedgerAppendReceipt | null;
  readonly existing: boolean;
}

/** Maps the shared commit outcome onto a `Result` without a second envelope. */
export async function commitStateRows(
  ports: LedgerPorts,
  binding: VersionBinding,
  rows: readonly LedgerStateRowWrite[],
): Promise<Result<CommitResult, ErrorEnvelope>> {
  const outcome = await ports.store.appendStateRows({
    binding,
    rows,
  });
  return mapCommitOutcome(outcome);
}

export function mapCommitOutcome(
  outcome: LedgerCommitOutcome,
): Result<CommitResult, ErrorEnvelope> {
  if (outcome.ok) {
    if (outcome.commit_state === "committed") {
      return ledgerOk({ receipt: outcome.receipt, existing: false });
    }
    return ledgerOk({ receipt: null, existing: true });
  }
  return { ok: false, status: "rejected", error: outcome.error };
}
