import { compareUtf8 } from "@evoplug/core";
import type { SourceRef, VersionBinding } from "@evoplug/core";
import type { StateFactView, VerifierRegistryView } from "../domain/facts.js";
import type { FactVerificationStateRow, StateFactStateRow } from "../rows.js";
import { isSourceRef } from "../source-ref.js";

/** Verifiers ordered by `verifier_ref` UTF-8 ascending, including invalidated. */
export function sortVerifiers(
  verifiers: readonly VerifierRegistryView[],
): VerifierRegistryView[] {
  return [...verifiers].sort((a, b) => compareUtf8(a.verifier_ref, b.verifier_ref));
}

/**
 * Recompute rule (DD-FND-074): any valid `contradicted` wins; otherwise any
 * valid `verified`; otherwise `unknown`. Invalidated and unknown records never
 * contribute.
 */
export function recomputeTruthState(
  verifiers: readonly VerifierRegistryView[],
): "verified" | "contradicted" | "unknown" {
  return recomputeTruthStateFromResults(verifiers);
}

export function recomputeTruthStateFromResults(
  results: readonly {
    readonly status: "valid" | "invalidated" | "unknown";
    readonly result: "verified" | "contradicted" | "unknown";
  }[],
): "verified" | "contradicted" | "unknown" {
  let sawVerified = false;
  for (const verifier of results) {
    if (verifier.status !== "valid") continue;
    if (verifier.result === "contradicted") return "contradicted";
    if (verifier.result === "verified") sawVerified = true;
  }
  return sawVerified ? "verified" : "unknown";
}

/** Most recent valid verifier by `(verified_at, verifier_ref)`. */
export function latestValidVerifierRef(
  verifiers: readonly VerifierRegistryView[],
): SourceRef | null {
  let selected: VerifierRegistryView | null = null;
  for (const verifier of verifiers) {
    if (verifier.status !== "valid") continue;
    if (selected === null) {
      selected = verifier;
      continue;
    }
    if (verifier.verified_at > selected.verified_at) {
      selected = verifier;
      continue;
    }
    if (
      verifier.verified_at === selected.verified_at &&
      compareUtf8(verifier.verifier_ref, selected.verifier_ref) > 0
    ) {
      selected = verifier;
    }
  }
  return selected === null ? null : selected.verifier_ref;
}

/** `independent` only proves the evidence references differ. */
export function isIndependent(verifierRef: SourceRef, producerRef: SourceRef): boolean {
  return verifierRef !== producerRef;
}

/**
 * Builds the read projection. `truth_state` and `verifier_ref` are derived
 * from verification records; `stale` and `stale_reason` are read from the row
 * and are never cleared by verification.
 */
export function buildStateFactView(
  row: StateFactStateRow,
  verifiers: readonly VerifierRegistryView[],
): StateFactView | null {
  if (!isSourceRef(row.source_ref) || !isSourceRef(row.producer_ref)) return null;
  const sorted = sortVerifiers(verifiers);
  const derivedTruth = recomputeTruthState(sorted);
  const verifierRef = latestValidVerifierRef(sorted);
  const view: StateFactView = {
    schema_version: "rsi.state_fact/1",
    fact_id: row.fact_id,
    binding: {
      task_id: row.task_id,
      branch_id: row.branch_id,
      input_epoch: row.input_epoch,
      goal_version: row.goal_version,
      config_version: row.config_version,
      watermark: row.watermark,
    },
    kind: row.kind,
    subject: row.subject,
    value: row.value,
    truth_state: derivedTruth,
    stale: row.stale === 1,
    stale_reason: row.stale_reason,
    source_ref: row.source_ref,
    producer_ref: row.producer_ref,
    verifier_ref: verifierRef,
    artifact_version: row.artifact_version,
    observed_at: row.observed_at,
    verifiers: sorted,
    row_version: row.row_version,
  };
  return view;
}

/**
 * Fact visibility under read binding V: same task/branch and
 * `F.input_epoch <= V.input_epoch`, `F.watermark <= V.watermark`. Goal and
 * config versions are deliberately not compared.
 */
export function factVisibleAt(row: StateFactStateRow, binding: VersionBinding): boolean {
  return (
    row.task_id === binding.task_id &&
    row.branch_id === binding.branch_id &&
    row.input_epoch <= binding.input_epoch &&
    row.watermark <= binding.watermark
  );
}

/** Verification rows are visible only when their V watermark is not ahead. */
export function verifierVisibleAt(
  row: FactVerificationStateRow,
  binding: VersionBinding,
): boolean {
  return row.watermark <= binding.watermark;
}

/** Sorts facts by `fact_id` for stable view hashing. */
export function sortFactsById<T extends { readonly fact_id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => compareUtf8(a.fact_id, b.fact_id));
}

