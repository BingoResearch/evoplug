/**
 * Grant consumption (DD-FND-056, DD-FND-091, DD-FND-095.5).
 *
 * `grant_consumption` is the v2 unified consumption key: one row per grant,
 * and exactly one of `managed_write_id` / `config_write_id` is non-null.
 *
 * - `mode="once"` managed writes insert the consumption in the same
 *   transaction that creates the intent; a primary-key conflict is
 *   `mode_consumed` and is never refunded afterwards.
 * - `mode="once"` config writes insert it only in the terminal `verified`
 *   transaction, after `grant.consumed` is journalled.
 * - `standing` grants never write a consumption row.
 */

import type { ErrorEnvelope, Id, Result, Tx } from "@evoplug/core";
import { err, isId, ok } from "@evoplug/core";

import { fieldError } from "./errors.js";

export type GrantWriteKind = "managed" | "config";

export interface GrantConsumption {
  grant_id: Id<"grant">;
  write_kind: GrantWriteKind;
  managed_write_id: Id<"wi"> | null;
  config_write_id: Id<"cwi"> | null;
  consumed_at: number;
}

export type ConsumeGrantOutcome =
  | { state: "inserted"; consumption: GrantConsumption }
  | { state: "mode_consumed"; existing: GrantConsumption }
  | { state: "failed"; error: ErrorEnvelope };

/**
 * Builds a consumption record.
 *
 * The write reference must match `write_kind`; the other reference stays
 * `null`. No row is created for a standing grant by the callers.
 */
export function planGrantConsumption(input: {
  grant_id: Id<"grant">;
  write_kind: GrantWriteKind;
  write_id: Id<"wi"> | Id<"cwi">;
  consumed_at: number;
}): Result<GrantConsumption, ErrorEnvelope> {
  if (!isId(input.grant_id, "grant")) {
    return err(fieldError("E_SCHEMA", "grant_id", "grant_id"));
  }
  if (!Number.isSafeInteger(input.consumed_at) || input.consumed_at < 0) {
    return err(fieldError("E_SCHEMA", "consumed_at", "epoch_ms"));
  }
  if (input.write_kind === "managed") {
    if (!isId(input.write_id, "wi")) {
      return err(fieldError("E_SCHEMA", "managed_write_id", "wi_id"));
    }
    return ok({
      grant_id: input.grant_id,
      write_kind: "managed",
      managed_write_id: input.write_id,
      config_write_id: null,
      consumed_at: input.consumed_at
    });
  }
  if (!isId(input.write_id, "cwi")) {
    return err(fieldError("E_SCHEMA", "config_write_id", "cwi_id"));
  }
  return ok({
    grant_id: input.grant_id,
    write_kind: "config",
    managed_write_id: null,
    config_write_id: input.write_id,
    consumed_at: input.consumed_at
  });
}

/**
 * Inserts a consumption row inside the caller's transaction.
 *
 * The pre-check reproduces the primary-key conflict deterministically under
 * the single-writer transaction; a race that still reaches SQLite surfaces as
 * a thrown storage error and the caller maps it to the same `mode_consumed`
 * outcome after rereading the row.
 */
export function consumeGrantInTransaction(
  tx: Tx,
  consumption: GrantConsumption
): ConsumeGrantOutcome {
  const existing = readGrantConsumptionInTransaction(tx, consumption.grant_id);
  if (!existing.ok) {
    return { state: "failed", error: existing.error };
  }
  if (existing.value !== null) {
    return { state: "mode_consumed", existing: existing.value };
  }
  tx.prepare(
    `INSERT INTO grant_consumption
       (grant_id, write_kind, managed_write_id, config_write_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run([
    consumption.grant_id,
    consumption.write_kind,
    consumption.managed_write_id,
    consumption.config_write_id,
    consumption.consumed_at
  ]);
  return { state: "inserted", consumption };
}

interface ConsumptionRow extends Record<string, unknown> {
  grant_id: string;
  write_kind: string;
  managed_write_id: string | null;
  config_write_id: string | null;
  consumed_at: number;
}

/** Reads the single consumption row for a grant, if any. */
export function readGrantConsumptionInTransaction(
  tx: Tx,
  grantId: Id<"grant">
): Result<GrantConsumption | null, ErrorEnvelope> {
  let row: ConsumptionRow | undefined;
  try {
    row = tx
      .prepare<ConsumptionRow>("SELECT * FROM grant_consumption WHERE grant_id = ?")
      .get([grantId]);
  } catch {
    return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption", "read"));
  }
  if (row === undefined) {
    return ok(null);
  }
  if (row.write_kind !== "managed" && row.write_kind !== "config") {
    return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption.write_kind", "managed_or_config"));
  }
  const writeKind: GrantWriteKind = row.write_kind;
  if (writeKind === "managed") {
    if (row.managed_write_id === null || row.config_write_id !== null) {
      return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption", "managed_reference"));
    }
    if (!isId(row.managed_write_id, "wi")) {
      return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption.managed_write_id", "wi_id"));
    }
    if (!isId(row.grant_id, "grant")) {
      return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption.grant_id", "grant_id"));
    }
    return ok({
      grant_id: row.grant_id,
      write_kind: "managed",
      managed_write_id: row.managed_write_id,
      config_write_id: null,
      consumed_at: row.consumed_at
    });
  }
  if (row.config_write_id === null || row.managed_write_id !== null) {
    return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption", "config_reference"));
  }
  if (!isId(row.config_write_id, "cwi")) {
    return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption.config_write_id", "cwi_id"));
  }
  if (!isId(row.grant_id, "grant")) {
    return err(fieldError("E_WRITE_NOT_FOUND", "grant_consumption.grant_id", "grant_id"));
  }
  return ok({
    grant_id: row.grant_id,
    write_kind: "config",
    managed_write_id: null,
    config_write_id: row.config_write_id,
    consumed_at: row.consumed_at
  });
}

/** True when the grant has already been consumed by any write kind. */
export function isGrantConsumedInTransaction(tx: Tx, grantId: Id<"grant">): boolean {
  const consumption = readGrantConsumptionInTransaction(tx, grantId);
  return consumption.ok && consumption.value !== null;
}
