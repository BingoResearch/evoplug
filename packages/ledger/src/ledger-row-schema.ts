/**
 * Ledger row schema vocabulary (DD-FND-070).
 *
 * `LedgerRowSchema` is the closed set of row schemas a `LedgerEvent` may
 * carry. It has two parts: the ledger-owned row schemas (grants, budget,
 * write, config-write, outbox, delivery, replay, egress, ipc-idempotency,
 * rate limit, install approval, root registration, decision) and the typed
 * `StateRowSchema` set.
 *
 * The typed part is not a second list: it is exactly the `StateRowSchema`
 * union that the state-row registry generates. The registry
 * (`schemas/ledger/state-row-registry.json`) is the machine source of truth;
 * a new or changed registration row must be reflected here, in
 * `LedgerEventType`, in the `ledger_event_log` CHECK and in the generated
 * artifacts. Writing an unregistered schema fails with `E_STATE_ROW_SCHEMA`;
 * there is no runtime row whitelist.
 */

import { STATE_ROW_REGISTRATIONS, type StateRowSchema } from "@evoplug/core";

export type LedgerRowSchema =
  | "rsi.authorization_grant/1" | "rsi.grant_consumption/1" | "rsi.grant_consumption/2"
  | "rsi.budget_reservation/1" | "rsi.allowance_charge/1" | "rsi.provider_usage/1"
  | "rsi.write_intent/2" | "rsi.write_snapshot/1" | "rsi.write_result/2"
  | "rsi.config_write_intent/1" | "rsi.config_write_snapshot/1" | "rsi.config_write_result/1"
  | "rsi.outbox/1" | "rsi.outbox_attempt/1"
  | "rsi.delivery_row/1" | "rsi.replay_plan_row/1" | "rsi.replay_approval_row/1"
  | "rsi.replay_execution_row/1" | "rsi.egress_approval_row/1"
  | "rsi.ipc_idempotency_row/1" | "rsi.rate_limit_state_row/1"
  | "rsi.adapter_install_approval_row/1" | "rsi.root_registration_row/1"
  | StateRowSchema
  | "rsi.decision/1";

/**
 * The ledger-owned row schemas, i.e. the members of {@link LedgerRowSchema}
 * that no typed state row registration owns. The typed remainder is derived
 * from the registry, never restated here.
 */
const LEDGER_OWNED_ROW_SCHEMAS: readonly LedgerRowSchema[] = Object.freeze([
  "rsi.authorization_grant/1",
  "rsi.grant_consumption/1",
  "rsi.grant_consumption/2",
  "rsi.budget_reservation/1",
  "rsi.allowance_charge/1",
  "rsi.provider_usage/1",
  "rsi.write_intent/2",
  "rsi.write_snapshot/1",
  "rsi.write_result/2",
  "rsi.config_write_intent/1",
  "rsi.config_write_snapshot/1",
  "rsi.config_write_result/1",
  "rsi.outbox/1",
  "rsi.outbox_attempt/1",
  "rsi.delivery_row/1",
  "rsi.replay_plan_row/1",
  "rsi.replay_approval_row/1",
  "rsi.replay_execution_row/1",
  "rsi.egress_approval_row/1",
  "rsi.ipc_idempotency_row/1",
  "rsi.rate_limit_state_row/1",
  "rsi.adapter_install_approval_row/1",
  "rsi.root_registration_row/1",
  "rsi.decision/1"
] as const);

/**
 * Every registered ledger row schema: the ledger-owned rows plus the typed
 * state rows from the registry. `rsi.adapter_install_approval_row/1` and
 * `rsi.root_registration_row/1` are registered typed rows as well, so they
 * appear once.
 */
export const LEDGER_ROW_SCHEMAS: readonly LedgerRowSchema[] = Object.freeze([
  ...LEDGER_OWNED_ROW_SCHEMAS,
  ...STATE_ROW_REGISTRATIONS.map((registration) => registration.row_schema as LedgerRowSchema)
]);

const LEDGER_ROW_SCHEMA_SET: ReadonlySet<string> = new Set<string>(LEDGER_ROW_SCHEMAS);

/**
 * True when `value` is a registered ledger row schema. Unknown members are
 * rejected: they are not registered rows and may not be written.
 */
export function isLedgerRowSchema(value: unknown): value is LedgerRowSchema {
  return typeof value === "string" && LEDGER_ROW_SCHEMA_SET.has(value);
}
