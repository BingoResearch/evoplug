/**
 * The built-in typed state-row registry used by journal-only recovery
 * (DD-FND-059.1.7, DD-FND-060 stage 3).
 *
 * Only the FND-owned rows live here. The EVD, REV, HOST and CFG rows are
 * registered by their own owners; the storage package never guesses a table
 * name it does not know.
 */

import {
  STATE_ROW_COLUMNS as CORE_STATE_ROW_COLUMNS,
  STATE_ROW_REGISTRATIONS,
  type StateRowColumn
} from "@evoplug/core";

import type {
  StateRowProjectionRegistration,
  StateRowReference
} from "./state-row-projection.js";

/**
 * The typed rows the journal-only reducer may project.
 *
 * The list is derived from the central StateRow registry
 * (`schemas/ledger/state-row-registry.json`), so the reducer and the
 * registration table can never drift apart. The registry is the single
 * source of truth for the table, the key columns, the allowed operations and
 * the binding scope.
 */
export const FND_STATE_ROW_PROJECTIONS: readonly StateRowProjectionRegistration[] =
  STATE_ROW_REGISTRATIONS.map((registration) => ({
    row_schema: registration.row_schema,
    table: registration.table,
    primary_key: [...registration.primary_key],
    allowed_operations: [...registration.allowed_operations],
    row_versioned: registration.row_versioned,
    binding_source: registration.binding_source
  }));

/**
 * The foreign keys between the registered typed rows.
 *
 * The journal-only rebuild checks the reference closure after every frame: a
 * typed row that points at a row the journal never carried is a missing
 * reference and a divergence.
 */
export const STATE_ROW_REFERENCES: readonly StateRowReference[] = [
  {
    table: "adapter_descriptor_snapshot",
    column: "registration_hash",
    references_table: "adapter_registration",
    references_column: "registration_hash"
  },
  {
    table: "host_human_confirmation",
    column: "probe_id",
    references_table: "host_probe",
    references_column: "probe_id"
  }
];

/**
 * The typed rows whose frozen `row_json` must carry the complete physical
 * column set.
 *
 * The HOST trust tables are frozen by the design as complete physical rows:
 * a logical DTO, an injected `schema_version` or a missing column is a
 * schema failure, not a row.
 */
export const COMPLETE_STATE_ROW_SCHEMAS: ReadonlySet<string> = new Set(
  STATE_ROW_REGISTRATIONS.filter(
    (registration) =>
      registration.owner_domain === "host" ||
      registration.row_schema === "rsi.adapter_install_approval_row/1" ||
      registration.row_schema === "rsi.root_registration_row/1"
  ).map((registration) => registration.row_schema)
);

/** One physical column of a registered typed row. */
export type { StateRowColumn };

/**
 * The physical column set of every registered typed row.
 *
 * The journal-only reducer uses it to check the frozen `row_json`: an
 * injected column (such as a `schema_version` the table does not have) and a
 * missing column are both rejected, so a logical DTO can never pass as a
 * physical row.
 */
export const STATE_ROW_COLUMNS: Readonly<Record<string, readonly StateRowColumn[]>> =
  CORE_STATE_ROW_COLUMNS;
