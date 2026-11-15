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
export type GrantWriteKind = "managed" | "config";
export interface GrantConsumption {
    grant_id: Id<"grant">;
    write_kind: GrantWriteKind;
    managed_write_id: Id<"wi"> | null;
    config_write_id: Id<"cwi"> | null;
    consumed_at: number;
}
export type ConsumeGrantOutcome = {
    state: "inserted";
    consumption: GrantConsumption;
} | {
    state: "mode_consumed";
    existing: GrantConsumption;
} | {
    state: "failed";
    error: ErrorEnvelope;
};
/**
 * Builds a consumption record.
 *
 * The write reference must match `write_kind`; the other reference stays
 * `null`. No row is created for a standing grant by the callers.
 */
export declare function planGrantConsumption(input: {
    grant_id: Id<"grant">;
    write_kind: GrantWriteKind;
    write_id: Id<"wi"> | Id<"cwi">;
    consumed_at: number;
}): Result<GrantConsumption, ErrorEnvelope>;
/**
 * Inserts a consumption row inside the caller's transaction.
 *
 * The pre-check reproduces the primary-key conflict deterministically under
 * the single-writer transaction; a race that still reaches SQLite surfaces as
 * a thrown storage error and the caller maps it to the same `mode_consumed`
 * outcome after rereading the row.
 */
export declare function consumeGrantInTransaction(tx: Tx, consumption: GrantConsumption): ConsumeGrantOutcome;
/** Reads the single consumption row for a grant, if any. */
export declare function readGrantConsumptionInTransaction(tx: Tx, grantId: Id<"grant">): Result<GrantConsumption | null, ErrorEnvelope>;
/** True when the grant has already been consumed by any write kind. */
export declare function isGrantConsumedInTransaction(tx: Tx, grantId: Id<"grant">): boolean;
