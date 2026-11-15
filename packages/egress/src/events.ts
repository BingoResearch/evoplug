/**
 * Egress ledger event names, row schema and the DD-FND-097.2 row hash.
 *
 * `after_hash = sha256(JCS({row_schema, row_json}))` over the complete DDL
 * column set. The persistence layer supplies `row_json`; this helper only
 * fixes the preimage, never fills missing columns.
 */

import { canonicalHash } from "@evoplug/core";
import type { Hash, JsonValue } from "@evoplug/core";

export const EGRESS_APPROVAL_RECORDED_EVENT: "egress.approval_recorded" =
  "egress.approval_recorded";

export const EGRESS_APPROVAL_TRANSITION_EVENT: "egress.approval_transition" =
  "egress.approval_transition";

export const EGRESS_APPROVAL_ROW_SCHEMA: "rsi.egress_approval_row/1" =
  "rsi.egress_approval_row/1";

export function computeEgressApprovalRowHash(rowJson: JsonValue): Hash {
  return canonicalHash({
    row_schema: EGRESS_APPROVAL_ROW_SCHEMA,
    row_json: rowJson,
  });
}
