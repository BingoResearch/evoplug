/**
 * Delivery ledger event name, row schema and DD-FND-097.2 row hash.
 *
 * `delivery.create`, every `delivery.update` and outbox `delivery.expire`
 * write one `delivery.recorded` frame with the complete post-update row.
 * `delivery_history` is a derived projection, not a ledger row schema.
 */

import { canonicalHash } from "@evoplug/core";
import type { Hash, JsonValue } from "@evoplug/core";

export const DELIVERY_RECORDED_EVENT: "delivery.recorded" = "delivery.recorded";

export const DELIVERY_RECEIPT_EVENT: "delivery.receipt" = "delivery.receipt";

export const DELIVERY_ROW_SCHEMA: "rsi.delivery_row/1" = "rsi.delivery_row/1";

export const DELIVERY_HISTORY_PROJECTION_SCHEMA: "rsi.delivery_history_projection/1" =
  "rsi.delivery_history_projection/1";

export function computeDeliveryRowHash(rowJson: JsonValue): Hash {
  return canonicalHash({ row_schema: DELIVERY_ROW_SCHEMA, row_json: rowJson });
}
