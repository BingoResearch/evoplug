/**
 * `DecisionDraft` is the accepted input to `decision.record` (DD-FND-072).
 * The kernel assigns the decision id, action kind, timestamp and hash.
 */

import type { DecisionRecord } from "../generated/types/decision-record.js";

export type DecisionDraft = Omit<
  DecisionRecord,
  "schema_version" | "decision_id" | "action_kind" | "decided_at" | "decision_hash"
> & { readonly schema_version: "rsi.decision_draft/1" };
