/**
 * EVD recovery matrix and rebuild guard (DD-EVD-025).
 *
 * Recovery never guesses HTTP outcomes and never resends automatically. The
 * matrix is data; the journal replay applies `EVD_ROW_REDUCERS` in
 * `commit_seq` order and fails closed on the first divergence.
 */

import { canonicalJsonText, err, type Result } from "@evoplug/core";

import { evdErr, evdRebuildDivergence } from "./errors.js";
import { EVD_ROW_REDUCERS, type EvdReduceContext, type EvdRowSchema } from "./store.js";
import type { EvdError } from "./types.js";

export type RecoverySituation =
  | "t1_uncommitted"
  | "t1_committed_before_t2"
  | "t2_committed_before_send"
  | "t3a_prepared_before_mark_sending"
  | "t3b_sending_before_network"
  | "crash_during_send"
  | "response_received_before_t4"
  | "t4_committed_before_t5"
  | "t5_commit_crash"
  | "late_result"
  | "profile_batch_before_commit"
  | "capability_batch_before_commit"
  | "binding_envelope_crash"
  | "legacy_aggregate_read"
  | "profile_state_crash"
  | "blob_deleted";

export interface RecoveryDecision {
  action:
    | "rollback_and_replan"
    | "resume_binding"
    | "hold_bound"
    | "hold_prepared"
    | "mark_outcome_unknown"
    | "replay_response"
    | "reaggregate"
    | "retry_same_key"
    | "append_late_history"
    | "zero_batch"
    | "read_only_original"
    | "repair_read_only"
    | "invalidate_pack";
  resend: false;
  resulting_state: string;
}

const MATRIX: Readonly<Record<RecoverySituation, RecoveryDecision>> = {
  t1_uncommitted: { action: "rollback_and_replan", resend: false, resulting_state: "no_pack" },
  t1_committed_before_t2: { action: "resume_binding", resend: false, resulting_state: "planned" },
  t2_committed_before_send: { action: "hold_bound", resend: false, resulting_state: "bound" },
  t3a_prepared_before_mark_sending: { action: "hold_prepared", resend: false, resulting_state: "prepared" },
  t3b_sending_before_network: { action: "mark_outcome_unknown", resend: false, resulting_state: "outcome_unknown" },
  crash_during_send: { action: "mark_outcome_unknown", resend: false, resulting_state: "outcome_unknown" },
  response_received_before_t4: { action: "replay_response", resend: false, resulting_state: "accepted_or_degraded" },
  t4_committed_before_t5: { action: "reaggregate", resend: false, resulting_state: "aggregated" },
  t5_commit_crash: { action: "retry_same_key", resend: false, resulting_state: "no_partial_aggregate" },
  late_result: { action: "append_late_history", resend: false, resulting_state: "unchanged" },
  profile_batch_before_commit: { action: "zero_batch", resend: false, resulting_state: "no_new_version" },
  capability_batch_before_commit: { action: "zero_batch", resend: false, resulting_state: "backend_unknown" },
  binding_envelope_crash: { action: "replay_response", resend: false, resulting_state: "single_frame" },
  legacy_aggregate_read: { action: "read_only_original", resend: false, resulting_state: "legacy_read_only" },
  profile_state_crash: { action: "repair_read_only", resend: false, resulting_state: "service_state_inconsistent" },
  blob_deleted: { action: "invalidate_pack", resend: false, resulting_state: "invalidated" },
};

export function recoveryDecision(situation: RecoverySituation): RecoveryDecision {
  return MATRIX[situation];
}

export interface ReplayMember {
  schema: EvdRowSchema;
  row: import("@evoplug/core").JsonValue;
}

/**
 * The typed identity of an EVD row, mirroring the row registry's primary and
 * unique keys.
 *
 * DD-EVD-025: "两行出现同一分配值时 `E_REBUILD_DIVERGENCE`，不重新编号". The
 * replay therefore groups members by their row identity, not by their full
 * JSON body: two members that claim the same identity are a divergence unless
 * the reducer accepts the transition, and two members with the same identity
 * and the same content are the same row.
 */
function rowIdentity(schema: EvdRowSchema, row: import("@evoplug/core").JsonValue): string {
  const record = (row ?? {}) as Record<string, unknown>;
  const pick = (...keys: readonly string[]): string =>
    keys.map((key) => `${key}=${String(record[key] ?? "")}`).join(",");
  switch (schema) {
    case "rsi.evd_evidence_pack_row/1":
      return pick("pack_key");
    case "rsi.evd_dependency_unit_row/1":
      return pick("pack_id", "unit_key");
    case "rsi.evd_state_manifest_row/1":
      return pick("manifest_key");
    case "rsi.evd_shard_plan_row/1":
      return pick("shard_plan_key");
    case "rsi.evd_shard_row/1":
      return pick("shard_plan_id", "shard_key");
    case "rsi.evd_omission_row/1":
      return pick("shard_plan_id", "omission_key");
    case "rsi.evd_budget_estimate_row/1":
      return pick("estimate_key");
    case "rsi.evd_service_profile_row/1":
      return pick("profile_key", "profile_version");
    case "rsi.evd_service_state_row/1":
      return pick("profile_key");
    case "rsi.evd_validator_binding_row/1":
      return pick("validator_binding_key");
    case "rsi.evd_request_binding_row/1":
      return pick("dispatch_key", "state_hash");
    case "rsi.evd_attempt_row/1":
      return pick("binding_id", "attempt_no");
    case "rsi.evd_envelope_row/1":
      return pick("envelope_key");
    case "rsi.evd_late_result_row/1":
      return pick("late_result_key");
    case "rsi.evd_aggregate_row/1":
      return pick("aggregate_key");
    default:
      return pick("row_version");
  }
}

export async function replayMembers(
  members: readonly ReplayMember[],
  ctx: EvdReduceContext
): Promise<Result<import("@evoplug/core").JsonValue[], EvdError>> {
  const state = new Map<string, import("@evoplug/core").JsonValue>();
  for (const member of members) {
    const reducer = EVD_ROW_REDUCERS[member.schema];
    const key = `${member.schema}|${rowIdentity(member.schema, member.row)}`;
    const previous = state.get(key) ?? null;
    if (previous !== null && canonicalJsonText(previous) === canonicalJsonText(member.row)) {
      // The same identity with the same content is an idempotent re-apply of
      // an already projected row, not a second row and not a divergence.
      continue;
    }
    const reduced = reducer.reduce(previous, member.row);
    if (!reduced.ok) {
      return err(evdRebuildDivergence());
    }
    const verified = await reducer.verify(member.row, ctx);
    if (!verified.ok) {
      return verified;
    }
    state.set(key, reduced.value);
  }
  return { ok: true, status: "ok", value: [...state.values()] };
}
