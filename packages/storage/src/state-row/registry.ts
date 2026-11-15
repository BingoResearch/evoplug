/**
 * Registry access and batch admission rules for the FND StateRow ABI
 * (DD-FND-059.1.6).
 *
 * The registry (`schemas/ledger/state-row-registry.json`, generated into
 * `@evoplug/core`) is the single source of what may be written. This module
 * reads it and enforces the two admission rules the design states for
 * `appendStateRows`:
 *
 *   - a batch of only `none`-scope rows requires `binding=null` and every
 *     event binding null;
 *   - a batch containing any `row`/`batch` row requires a non-null binding and
 *     all bound rows share that exact six-field binding;
 *   - `none` rows may not share a batch with bound rows (`E_STATE_ROW_BINDING`);
 *   - `adapter_install_approval_row` and `root_registration_row` may never be
 *     written through `appendStateRows` even though they are registered as
 *     `none` (`E_STATE_ROW_SCHEMA`).
 *
 * A rejected batch writes nothing: admission happens before any frame is
 * assembled.
 */

import {
  STATE_ROW_REGISTRATIONS,
  canonicalJsonText,
  type ErrorEnvelope,
  type StateRowRegistration,
  type StateRowSchema,
  type VersionBinding
} from "@evoplug/core";

import { fieldDetails, storageError } from "../errors.js";

/**
 * Rows that only their dedicated writer may commit.
 *
 * `adapter_install_approval_row` and `root_registration_row` are registered
 * as `none` but are written by the `install.approval_*` and
 * `root.registration_*` writers, never through `appendStateRows`.
 */
export const DEDICATED_WRITER_ROW_SCHEMAS: readonly StateRowSchema[] = [
  "rsi.adapter_install_approval_row/1",
  "rsi.root_registration_row/1"
];

const REGISTRATIONS_BY_SCHEMA: ReadonlyMap<string, StateRowRegistration> = new Map(
  STATE_ROW_REGISTRATIONS.map((registration) => [registration.row_schema, registration])
);

/** The registration of one row schema, or null when it is not registered. */
export function findRegistration(rowSchema: string): StateRowRegistration | null {
  return REGISTRATIONS_BY_SCHEMA.get(rowSchema) ?? null;
}

/** Every registered row schema, in registry order. */
export function registeredRowSchemas(): readonly StateRowSchema[] {
  return STATE_ROW_REGISTRATIONS.map((registration) => registration.row_schema);
}

/**
 * The registry columns that hold a JSON array but land in a TEXT column.
 *
 * The registry types `active_requirement_ids_json`,
 * `replacement_op_ids_json` and `invalidated_judgment_ids_json` as arrays while
 * the physical DDL stores them as TEXT; the value is written as the canonical
 * JSON text of the array.
 */
export const ARRAY_TEXT_COLUMNS: readonly string[] = [
  "active_requirement_ids_json",
  "replacement_op_ids_json",
  "invalidated_judgment_ids_json"
];

/**
 * Normalises one row for the physical table.
 *
 * Array columns become their canonical JSON text; every other column keeps
 * its value. The normalised row is what `row_json` freezes and what the
 * projection writes.
 */
export function normalizeRowForTable(rowSchema: string, row: Record<string, unknown>): Record<string, unknown> {
  const registration = findRegistration(rowSchema);
  if (registration === null) {
    return { ...row };
  }
  const out: Record<string, unknown> = { ...row };
  for (const column of ARRAY_TEXT_COLUMNS) {
    const value = out[column];
    if (Array.isArray(value)) {
      out[column] = canonicalJsonText(value as never);
    }
  }
  return out;
}

/** True when the row schema may only be written by its dedicated writer. */
export function isDedicatedWriterRow(rowSchema: string): boolean {
  return DEDICATED_WRITER_ROW_SCHEMAS.includes(rowSchema as StateRowSchema);
}

function schemaError(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_SCHEMA",
    stage: "storage.state_row",
    details: fieldDetails(path, rule),
    message_key: "error.storage.state_row_schema_invalid"
  });
}

function bindingError(rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_BINDING",
    stage: "storage.state_row",
    details: { kind: "none" },
    message_key: "error.storage.state_row_binding_invalid"
  });
}

/** One row of a batch, reduced to the facts admission needs. */
export interface BatchRowScope {
  readonly row_schema: string;
  readonly binding_source: "row" | "batch" | "none";
}

/**
 * The admission verdict for one batch.
 *
 * `bound` is true when the batch carries at least one `row`/`batch` member;
 * the caller then has to pass the shared six-field binding.
 */
export interface BatchScope {
  readonly bound: boolean;
  readonly rowSchemas: readonly string[];
}

/**
 * Computes the scope of a batch.
 *
 * The binding source of every member is given by the caller, which reads it
 * from the registry. A batch never mixes `none` members with bound members:
 * such a batch is rejected with `E_STATE_ROW_BINDING`.
 */
export function resolveBatchScope(
  members: readonly BatchRowScope[]
): { ok: true; scope: BatchScope } | { ok: false; error: ErrorEnvelope } {
  const rowSchemas: string[] = [];
  let hasBound = false;
  let hasNone = false;
  for (const member of members) {
    rowSchemas.push(member.row_schema);
    if (member.binding_source === "none") {
      hasNone = true;
    } else {
      hasBound = true;
    }
  }
  if (hasBound && hasNone) {
    return { ok: false, error: bindingError("none_rows_must_not_mix_with_bound_rows") };
  }
  return { ok: true, scope: { bound: hasBound, rowSchemas } };
}

/**
 * Checks the request binding against the batch scope.
 *
 * An all-`none` batch must carry `binding=null`; a batch with any `row`/`batch`
 * member must carry a non-null binding. The shared six fields are compared
 * byte-for-byte by the caller through {@link equalVersionBinding}.
 */
export function checkBatchBinding(
  scope: BatchScope,
  binding: VersionBinding | null
): { ok: true } | { ok: false; error: ErrorEnvelope } {
  if (!scope.bound) {
    if (binding !== null) {
      return { ok: false, error: bindingError("global_batch_requires_null_binding") };
    }
    return { ok: true };
  }
  if (binding === null) {
    return { ok: false, error: bindingError("bound_batch_requires_binding") };
  }
  return { ok: true };
}
