import type { ErrorEnvelope, Hash, Id, Result } from "@evoplug/core";
import type { ResumeObservation, ResumeResult } from "../domain/identity.js";
import { ledgerOk, ledgerFailure, watermarkAheadError } from "../errors.js";
import { compareUtf8 } from "@evoplug/core";

export interface ResumePlanInput {
  readonly observation: ResumeObservation;
  /** False when the journal no longer retains the needed history. */
  readonly history_retained: boolean;
  /** Idempotency key of the explicit resume request. */
  readonly idempotency_key: Hash;
  readonly now: number;
}

export interface ResumeAuditDecision {
  readonly action_kind: "identity_resume";
  readonly reason_code: "explicit_request";
  readonly session_id: Id<"sess">;
  readonly observed_watermark: number;
}

export interface ResumePlan {
  readonly result: ResumeResult;
  /** True only for a successful explicit resume. */
  readonly write_identity_resume_event: boolean;
  /** Audit record is written only for a successful explicit resume. */
  readonly audit: ResumeAuditDecision | null;
  /** Receipts to resend; always empty for `stale` and `recovery_required`. */
  readonly replay_ranges: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

interface Range {
  readonly from: number;
  readonly to: number;
}

function normalizeRanges(ranges: readonly Range[], upper: number): Range[] {
  const clamped: Range[] = [];
  for (const range of ranges) {
    const from = Number.isSafeInteger(range.from) ? range.from : 0;
    const to = Number.isSafeInteger(range.to) ? range.to : 0;
    if (from < 0 || to < from) continue;
    if (to > upper) continue;
    clamped.push({ from, to });
  }
  clamped.sort((a, b) => a.from - b.from);
  const merged: Range[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to + 1) {
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, range.to) };
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/**
 * Missing half-open ranges in `(observed, current]` that no committed range
 * covers. Ranges are inclusive on both ends in the result shape used by the
 * design (`{from,to}`).
 */
export function missingRanges(
  observed: number,
  current: number,
  committedRanges: readonly Range[],
): Range[] {
  if (observed >= current) return [];
  const covered = normalizeRanges(committedRanges, current);
  const missing: Range[] = [];
  let cursor = observed + 1;
  for (const range of covered) {
    if (range.to < cursor) continue;
    if (range.from > cursor) {
      missing.push({ from: cursor, to: range.from - 1 });
    }
    cursor = Math.max(cursor, range.to + 1);
    if (cursor > current) break;
  }
  if (cursor <= current) {
    missing.push({ from: cursor, to: current });
  }
  return missing;
}

/**
 * Resume rule validation (DD-FND-073).
 *
 * `observed == current` resumes and only resends undelivered receipts.
 * `observed < current` is `stale`: no host history replay is demanded, the
 * missing ranges are returned and the caller explicitly chooses resume or
 * fork. `observed > current` is never trusted and returns
 * `E_WATERMARK_AHEAD`.
 */
export function planResume(input: ResumePlanInput): Result<ResumePlan, ErrorEnvelope> {
  const observation = input.observation;

  if (!Number.isSafeInteger(observation.observed_watermark) || observation.observed_watermark < 0) {
    return ledgerFailure<ResumePlan>({
      code: "E_SCHEMA",
      category: "schema",
      details: { kind: "field", path: "observed_watermark", rule: "non_negative_safe_integer" },
      stage: "ledger_validate",
    });
  }
  if (!Number.isSafeInteger(observation.current_watermark) || observation.current_watermark < 0) {
    return ledgerFailure<ResumePlan>({
      code: "E_SCHEMA",
      category: "schema",
      details: { kind: "field", path: "current_watermark", rule: "non_negative_safe_integer" },
      stage: "ledger_validate",
    });
  }

  if (observation.observed_watermark > observation.current_watermark) {
    return watermarkAheadError<ResumePlan>();
  }

  if (observation.observed_watermark === observation.current_watermark) {
    const result: ResumeResult = {
      session_id: observation.session_id,
      branch_id: observation.branch_id,
      resume_generation: observation.resume_generation + 1,
      observed_watermark: observation.observed_watermark,
      current_watermark: observation.current_watermark,
      status: "resumed",
      missing_ranges: [],
      replayed_events: 0,
    };
    return ledgerOk({
      result,
      write_identity_resume_event: true,
      audit: {
        action_kind: "identity_resume",
        reason_code: "explicit_request",
        session_id: observation.session_id,
        observed_watermark: observation.observed_watermark,
      },
      replay_ranges: [],
    });
  }

  const missing = missingRanges(
    observation.observed_watermark,
    observation.current_watermark,
    observation.committed_ranges,
  );

  if (!input.history_retained) {
    const result: ResumeResult = {
      session_id: observation.session_id,
      branch_id: observation.branch_id,
      resume_generation: observation.resume_generation,
      observed_watermark: observation.observed_watermark,
      current_watermark: observation.current_watermark,
      status: "recovery_required",
      missing_ranges: missing,
      replayed_events: 0,
    };
    return ledgerOk({
      result,
      write_identity_resume_event: false,
      audit: null,
      replay_ranges: [],
    });
  }

  const result: ResumeResult = {
    session_id: observation.session_id,
    branch_id: observation.branch_id,
    resume_generation: observation.resume_generation,
    observed_watermark: observation.observed_watermark,
    current_watermark: observation.current_watermark,
    status: "stale",
    missing_ranges: missing,
    replayed_events: 0,
  };
  return ledgerOk({
    result,
    write_identity_resume_event: false,
    audit: null,
    replay_ranges: [],
  });
}

/**
 * A lost native ID must start a new input epoch; the old input is never
 * re-marked as current.
 */
export function resumeStartsNewEpoch(previousInputEpoch: number): number {
  if (!Number.isSafeInteger(previousInputEpoch) || previousInputEpoch < 0) {
    return 1;
  }
  return previousInputEpoch + 1;
}

/** Sorts resolution candidates by branch ID for deterministic reporting. */
export function sortCandidatesByBranch<T extends { readonly branch_id: Id<"br"> }>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((a, b) => compareUtf8(a.branch_id, b.branch_id));
}
