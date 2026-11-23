/**
 * Asynchronous evidence snapshot loader (DD-EVD-003a).
 *
 * The loader performs every upstream read, validates bindings, watermarks,
 * sources and capacity gates, then freezes one immutable
 * `EvidenceIndexSnapshot`. It never returns a partial snapshot and never maps a
 * failure to an empty result.
 */

import { canonicalJsonText, hashBytes, isHash, newId, parseSourceRef, type Hash, type JsonValue, type SourceRef, type VersionBinding } from "@evoplug/core";

import { MAX_EXCERPT_BYTES, MAX_INDEX_ROWS, MAX_INDEX_SOURCE_REFS, MAX_SOURCE_BYTES, MAX_TOTAL_FROZEN_BYTES, EVIDENCE_INDEX_LOAD_DEADLINE_MS, DEFAULT_CONFLICT_RETRIES, type CoverageSnapshotView, type CoverageView, type EvidenceFactView, type EvidenceIndexLoadRequest, type EvidenceIndexSnapshot, type EvidenceIndexSnapshotLoader, type EvidenceIndexSnapshotLoaderDeps, type EvdIndexLoadError, type EvdIndexLoadResult, type ExperienceCandidateView, type FeedbackView, type HardFactReadView, type LedgerEvidenceSnapshot, type LedgerRequirementOpRow, type LedgerRequirementRow, type ProgressCheckpointReadView, type ProgressSignalStatus, type ProgressSignalView, type RequirementOpView, type RequirementView, type ReviewSnapshotView, type StateFactView, type TaskConditionView, type TaskProcessState, type UnverifiedConstraintView, type VerifierRegistryView, type ComparisonView, type FrozenResolvedSource } from "./types.js";
import {
  createEvidenceIndexSnapshot,
  snapshotRowsProjection,
  type EvidenceIndexSnapshotData,
  type FrozenSourceRecord,
} from "./evidence-index-snapshot.js";
import {
  comparisonViewKey,
  coverageSnapshotId,
  coverageViewKey,
  factKey,
  independenceKey,
  jcsHash,
  sortUtf8Strings,
  textHash,
  utf8Length,
} from "./hashing.js";

type LoadStage = EvdIndexLoadError["stage"];

const CATEGORY: Record<string, EvdIndexLoadError["category"]> = {
  E_INDEX_REQUEST_INVALID: "schema",
  E_INDEX_BINDING_INVALID: "version",
  E_INDEX_WATERMARK_INVALID: "usage",
  E_INDEX_WINDOW_INVALID: "usage",
  E_INDEX_REVIEW_SNAPSHOT_INVALID: "schema",
  E_INDEX_REVIEW_SNAPSHOT_MISSING: "not_found",
  E_INDEX_UPSTREAM_UNAVAILABLE: "external",
  E_INDEX_PROGRESS_UNSUPPORTED: "source",
  E_INDEX_SOURCE_UNRETRIEVABLE: "source",
  E_INDEX_SOURCE_UTF8_INVALID: "source",
  E_INDEX_SOURCE_HASH_MISMATCH: "conflict",
  E_INDEX_SOURCE_CONFLICT: "conflict",
  E_INDEX_SOURCE_TOO_LARGE: "capacity",
  E_INDEX_LIMIT_EXCEEDED: "capacity",
  E_INDEX_VERSION_CONFLICT: "version",
  E_INDEX_DERIVATION_FAILED: "internal",
  E_INDEX_ABORTED: "deadline",
  E_INDEX_SCOPE_MISMATCH: "version",
  E_INDEX_SNAPSHOT_ID_MISMATCH: "version",
  E_INDEX_NOT_LOADED: "not_found",
  E_INDEX_DEADLINE_EXCEEDED: "deadline",
};

const RETRYABLE = new Set([
  "E_INDEX_UPSTREAM_UNAVAILABLE",
  "E_INDEX_VERSION_CONFLICT",
  "E_INDEX_DEADLINE_EXCEEDED",
]);

function upstreamDetails(error: unknown): Record<string, JsonValue> {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return { upstream_code: code };
    }
  }
  return {};
}

function loadError(
  code: string,
  stage: LoadStage,
  details: Record<string, JsonValue>,
  message_key = `error.${code.toLowerCase()}`
): EvdIndexLoadError {
  return {
    schema_version: "rsi.evidence_index_load_error/1",
    code,
    category: CATEGORY[code] ?? "internal",
    stage,
    retryable: RETRYABLE.has(code),
    side_effect: "none",
    message_key,
    details,
  };
}

function ok<T>(value: T): EvdIndexLoadResult<T> {
  return { ok: true, status: "ok", value };
}

function err<T>(error: EvdIndexLoadError): EvdIndexLoadResult<T> {
  return { ok: false, status: "rejected", error };
}

function fail<T>(
  code: string,
  stage: LoadStage,
  details: Record<string, JsonValue>,
  message_key?: string
): EvdIndexLoadResult<T> {
  return err(loadError(code, stage, details, message_key));
}

function bindingFields(_binding: VersionBinding): readonly (keyof VersionBinding)[] {
  return ["task_id", "branch_id", "input_epoch", "goal_version", "config_version", "watermark"];
}

function nonWatermarkEqual(a: VersionBinding, b: VersionBinding): boolean {
  return (
    a.task_id === b.task_id &&
    a.branch_id === b.branch_id &&
    a.input_epoch === b.input_epoch &&
    a.goal_version === b.goal_version &&
    a.config_version === b.config_version
  );
}

function sortRefs(refs: readonly SourceRef[]): SourceRef[] {
  return sortUtf8Strings(refs) as SourceRef[];
}

function mergeRefs(...groups: ReadonlyArray<readonly SourceRef[]>): SourceRef[] {
  const set = new Set<SourceRef>();
  for (const group of groups) {
    for (const ref of group) {
      set.add(ref);
    }
  }
  return sortRefs([...set]);
}

interface DeadlineState {
  readonly deadline: number;
  readonly now: () => number;
}

function remainingMs(state: DeadlineState): number {
  return state.deadline - state.now();
}

function checkDeadline(state: DeadlineState): EvdIndexLoadError | null {
  if (remainingMs(state) < 1) {
    return loadError("E_INDEX_DEADLINE_EXCEEDED", "validate", {
      deadline_ms: EVIDENCE_INDEX_LOAD_DEADLINE_MS,
      stage: "deadline",
    });
  }
  return null;
}

async function withinDeadline<T>(
  promise: Promise<T>,
  state: DeadlineState
): Promise<EvdIndexLoadResult<T>> {
  const remaining = remainingMs(state);
  if (remaining < 1) {
    return fail("E_INDEX_DEADLINE_EXCEEDED", "validate", {
      deadline_ms: EVIDENCE_INDEX_LOAD_DEADLINE_MS,
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), remaining);
  });
  try {
    const raced = await Promise.race([
      promise.then((value) => ({ timeout: false as const, value })),
      timeout,
    ]);
    if (raced.timeout) {
      return fail("E_INDEX_DEADLINE_EXCEEDED", "validate", {
        deadline_ms: EVIDENCE_INDEX_LOAD_DEADLINE_MS,
      });
    }
    return ok(raced.value);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function sha256BytesHash(bytes: Uint8Array): Hash {
  return hashBytes(bytes);
}

function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJsonCanonical(value: string): { ok: true; text: string } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(value);
    const canonical = canonicalJsonText(parsed as JsonValue);
    return { ok: true, text: canonical };
  } catch {
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* Ledger projections                                                  */
/* ------------------------------------------------------------------ */

function projectRequirement(row: LedgerRequirementRow): RequirementView {
  return {
    schema_version: "rsi.requirement_view/1",
    requirement_id: row.requirement_id,
    revision: row.revision,
    statement_ref: row.statement_ref,
    statement_text_hash: row.statement_text_hash,
    scope: row.scope,
    acceptance: row.acceptance,
    source_refs: sortRefs(row.source_refs),
    status: row.status,
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
    valid_from_event: row.valid_from_event,
    valid_to_event: row.valid_to_event,
    goal_version: row.goal_version,
    content_hash: row.content_hash,
  };
}

function projectRequirementOp(row: LedgerRequirementOpRow): RequirementOpView {
  return {
    schema_version: "rsi.requirement_op_view/1",
    op_id: row.op_id,
    status: row.status,
    op: row.op,
    actor_origin: row.actor_origin,
    directive_strength: row.directive_strength,
    target_requirement_id: row.target_requirement_id,
    created_requirement_id: row.created_requirement_id,
    effective_input_epoch: row.effective_input_epoch,
    goal_version_before: row.goal_version_before,
    goal_version_after: row.goal_version_after,
    valid_from_event: row.valid_from_event,
    valid_to_event: row.valid_to_event,
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
    source_quote_ref: row.source_quote_ref,
    content_hash: row.content_hash,
  };
}

function projectFeedback(row: {
  feedback_id: string;
  target_issue_id: string | null;
  origin: FeedbackView["origin"];
  signal_kind: FeedbackView["signal_kind"];
  status: FeedbackView["status"];
  goal_version: string;
  input_epoch: number;
  source_refs: SourceRef[];
  recorded_at: number;
  recorded_at_watermark: number;
}): FeedbackView {
  return {
    schema_version: "rsi.feedback_view/1",
    feedback_id: row.feedback_id,
    target_issue_id: row.target_issue_id,
    origin: row.origin,
    signal_kind: row.signal_kind,
    status: row.status,
    goal_version: row.goal_version,
    input_epoch: row.input_epoch,
    source_refs: sortRefs(row.source_refs),
    recorded_at: row.recorded_at,
    recorded_at_watermark: row.recorded_at_watermark,
  };
}

function projectConstraint(row: {
  constraint_id: string;
  version_binding: VersionBinding;
  recorded_at_watermark: number;
  source_event_id: string;
  source_ref: SourceRef;
  quote: string;
  quote_hash: Hash;
  scope_hint: RequirementView["scope"] | null;
  status: "unverified_constraint" | "confirmed" | "rejected";
  confirmed_by_event_id: string | null;
  created_at: number;
  row_version: number;
}): UnverifiedConstraintView {
  return {
    schema_version: "rsi.unverified_constraint_view/1",
    logical_id: `unverified_constraint:${row.constraint_id}`,
    constraint_id: row.constraint_id,
    version_binding: row.version_binding,
    recorded_at_watermark: row.recorded_at_watermark,
    source_event_id: row.source_event_id,
    source_refs: [row.source_ref],
    quote: row.quote,
    quote_hash: row.quote_hash,
    scope_hint: row.scope_hint,
    status: row.status,
    authorization: false,
    confirmed_by_event_id: row.confirmed_by_event_id,
    created_at: row.created_at,
    row_version: row.row_version,
  };
}

/* ------------------------------------------------------------------ */
/* Facts and hard facts                                                */
/* ------------------------------------------------------------------ */

interface FactBindingInfo {
  requirement_id?: string;
  proposition_id?: string;
  effect: "supports" | "violates" | "unknown";
  verified: boolean;
}

function bindingMatches(
  verifier: VerifierRegistryView,
  binding: VersionBinding
): boolean {
  return (
    verifier.verification_binding.task_id === binding.task_id &&
    verifier.verification_binding.branch_id === binding.branch_id &&
    verifier.verification_binding.input_epoch === binding.input_epoch &&
    verifier.verification_binding.goal_version === binding.goal_version &&
    verifier.verification_binding.config_version === binding.config_version &&
    verifier.verification_binding.watermark <= binding.watermark
  );
}

function artifactEqual(a: string | null, b: string | null): boolean {
  return a === b;
}

function uniqueBindingInfo(
  fact: StateFactView,
  verifiers: readonly VerifierRegistryView[],
  binding: VersionBinding
): FactBindingInfo {
  const candidates = verifiers.filter(
    (verifier) =>
      verifier.fact_id === fact.fact_id &&
      verifier.status === "valid" &&
      verifier.independent &&
      artifactEqual(verifier.artifact_version, fact.artifact_version) &&
      bindingMatches(verifier, binding) &&
      verifier.requirement_ids.length === 1 &&
      verifier.proposition_ids.length <= 1
  );
  if (candidates.length !== 1) {
    return { effect: "unknown", verified: false };
  }
  const verifier = candidates[0];
  if (verifier === undefined) {
    return { effect: "unknown", verified: false };
  }
  const verified = fact.truth_state === "verified" && verifier.result === "verified";
  const requirementId = verifier.requirement_ids[0];
  const propositionId = verifier.proposition_ids[0];
  const info: FactBindingInfo = {
    effect: verified && verifier.effect !== "unknown" ? verifier.effect : "unknown",
    verified,
  };
  if (requirementId !== undefined) {
    info.requirement_id = requirementId;
  }
  if (propositionId !== undefined) {
    info.proposition_id = propositionId;
  }
  return info;
}

function projectFact(
  fact: StateFactView,
  verifiers: readonly VerifierRegistryView[],
  binding: VersionBinding
): EvidenceFactView {
  const info = uniqueBindingInfo(fact, verifiers, binding);
  const rowVersion = fact.row_version;
  const row: EvidenceFactView = {
    schema_version: "rsi.evidence_fact_view/1",
    fact_id: fact.fact_id,
    kind: fact.kind,
    subject: fact.subject,
    value: fact.value,
    fact_value_hash: textHash(fact.value),
    status:
      fact.truth_state === "claim" || fact.truth_state === "observed"
        ? "observed"
        : fact.truth_state,
    effect: info.effect,
    stale: false,
    source_refs: sortRefs([fact.source_ref]),
    verified: info.verified,
    recorded_at: fact.observed_at,
    recorded_at_watermark: fact.binding.watermark,
    row_version: rowVersion,
  };
  if (fact.artifact_version !== null) {
    row.artifact_version = fact.artifact_version;
  }
  if (info.requirement_id !== undefined) {
    row.requirement_id = info.requirement_id;
  }
  if (info.proposition_id !== undefined) {
    row.proposition_id = info.proposition_id;
  }
  return row;
}

function projectHardFacts(
  facts: readonly StateFactView[],
  verifiers: readonly VerifierRegistryView[],
  binding: VersionBinding
): HardFactReadView[] {
  const results: HardFactReadView[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.stale || fact.truth_state !== "verified") {
      continue;
    }
    for (const verifier of verifiers) {
      if (
        verifier.fact_id !== fact.fact_id ||
        verifier.status !== "valid" ||
        !verifier.independent ||
        verifier.effect === "unknown" ||
        verifier.result !== "verified" ||
        !artifactEqual(verifier.artifact_version, fact.artifact_version) ||
        !bindingMatches(verifier, binding) ||
        verifier.requirement_ids.length !== 1 ||
        verifier.proposition_ids.length > 1
      ) {
        continue;
      }
      const requirementId = verifier.requirement_ids[0];
      if (requirementId === undefined) {
        continue;
      }
      const propositionId = verifier.proposition_ids[0];
      const dedupeKey = JSON.stringify([verifier.verifier_ref, requirementId, propositionId ?? null]);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      const fk = factKey({
        requirement_id: requirementId,
        ...(propositionId !== undefined ? { proposition_id: propositionId } : {}),
        effect: verifier.effect,
        ...(fact.artifact_version !== null ? { artifact_version: fact.artifact_version } : {}),
        source_ids: verifier.source_ids,
        source_refs: sortRefs([fact.source_ref, ...verifier.source_refs]),
        verifier_ref: verifier.verifier_ref,
        verified: true,
      });
      const hard: HardFactReadView = {
        schema_version: "rsi.hard_fact_view/1",
        fact_id: fact.fact_id,
        fact_key: fk,
        independence_key: independenceKey({
          source_ids: verifier.source_ids,
          verifier_ref: verifier.verifier_ref,
        }),
        requirement_id: requirementId,
        effect: verifier.effect,
        source_ids: sortUtf8Strings(verifier.source_ids),
        source_refs: sortRefs([fact.source_ref, ...verifier.source_refs]),
        verifier_ref: verifier.verifier_ref,
        verified: true,
        recorded_at: fact.observed_at,
      };
      if (propositionId !== undefined) {
        hard.proposition_id = propositionId;
      }
      if (fact.artifact_version !== null) {
        hard.artifact_version = fact.artifact_version;
      }
      results.push(hard);
    }
  }
  return results.sort((a, b) => (a.fact_key < b.fact_key ? -1 : a.fact_key > b.fact_key ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Progress signals and comparisons                                    */
/* ------------------------------------------------------------------ */

function statusForCheckpoint(
  checkpoint: ProgressCheckpointReadView,
  baselineMissing: boolean
): { status: ProgressSignalStatus; capture_reason?: ProgressSignalView["capture_reason"] } {
  const state: TaskProcessState = checkpoint.task_process_state;
  if (state === "cancelled") {
    return { status: "cancelled" };
  }
  if (state === "paused") {
    return { status: "paused" };
  }
  if (state === "blocked") {
    return { status: "blocked" };
  }
  if (state === "waiting") {
    return { status: "pending" };
  }
  if (state === "unknown") {
    return { status: "unknown", capture_reason: "task_state_unknown" };
  }
  if (state === "collection_gap") {
    return { status: "capture_gap", capture_reason: "evidence_coverage_gap" };
  }
  if (checkpoint.evidence_coverage === "gap") {
    return { status: "capture_gap", capture_reason: "evidence_coverage_gap" };
  }
  if (checkpoint.pending_state === "unknown") {
    return { status: "capture_gap", capture_reason: "pending_unknown" };
  }
  if (checkpoint.pending_state === "pending") {
    return { status: "pending" };
  }
  if (baselineMissing) {
    return { status: "capture_gap", capture_reason: "baseline_missing" };
  }
  return { status: "comparable" };
}

function projectProgress(
  checkpoints: readonly ProgressCheckpointReadView[],
  _binding: VersionBinding
): { signals: ProgressSignalView[]; comparisons: ComparisonView[] } {
  const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.checkpoint_id, checkpoint]));
  const signals: ProgressSignalView[] = [];
  const comparisons: ComparisonView[] = [];
  for (const checkpoint of checkpoints) {
    const baseline =
      checkpoint.baseline_checkpoint_id === null
        ? undefined
        : byId.get(checkpoint.baseline_checkpoint_id);
    const previous =
      checkpoint.previous_comparable_checkpoint_id === null
        ? undefined
        : byId.get(checkpoint.previous_comparable_checkpoint_id);
    const baselineMissing = checkpoint.baseline_checkpoint_id !== null && baseline === undefined;
    const status = statusForCheckpoint(checkpoint, baselineMissing);
    const signal: ProgressSignalView = {
      schema_version: "rsi.progress_signal_view/1",
      signal_id: checkpoint.checkpoint_id,
      signal_kind: checkpoint.task_process_state,
      status: status.status,
      source_refs: sortRefs(checkpoint.source_refs),
      from_watermark:
        previous !== undefined
          ? previous.watermark
          : baseline !== undefined
            ? baseline.watermark
            : checkpoint.watermark,
      to_watermark: checkpoint.watermark,
      recorded_at: checkpoint.created_at,
    };
    if (status.capture_reason !== undefined) {
      signal.capture_reason = status.capture_reason;
    }
    if (baseline !== undefined) {
      signal.baseline_checkpoint_id = baseline.checkpoint_id;
    }
    if (previous !== undefined) {
      signal.previous_comparable_checkpoint_id = previous.checkpoint_id;
    }
    signals.push(signal);

    if (baseline !== undefined && status.status === "comparable") {
      const key = comparisonViewKey({
        comparability_key: checkpoint.comparability_key,
        before_watermark: baseline.watermark,
        after_watermark: checkpoint.watermark,
        baseline_evidence_digest: baseline.evidence_digest,
        current_evidence_digest: checkpoint.evidence_digest,
      });
      comparisons.push({
        schema_version: "rsi.comparison_view/1",
        view_key: key,
        comparability_key: checkpoint.comparability_key,
        baseline_evidence_digest: baseline.evidence_digest,
        current_evidence_digest: checkpoint.evidence_digest,
        baseline_source_ids: [`progress:${baseline.checkpoint_id}`],
        current_source_ids: [`progress:${checkpoint.checkpoint_id}`],
        before_watermark: baseline.watermark,
        after_watermark: checkpoint.watermark,
        source_refs: mergeRefs(baseline.source_refs, checkpoint.source_refs),
      });
      signal.comparison_view_key = key;
    }
  }
  signals.sort((a, b) => {
    if (a.to_watermark !== b.to_watermark) {
      return a.to_watermark - b.to_watermark;
    }
    return a.signal_id < b.signal_id ? -1 : a.signal_id > b.signal_id ? 1 : 0;
  });
  comparisons.sort((a, b) => (a.view_key < b.view_key ? -1 : a.view_key > b.view_key ? 1 : 0));
  return { signals, comparisons };
}

/* ------------------------------------------------------------------ */
/* Experience candidates                                               */
/* ------------------------------------------------------------------ */

function candidateId(input: {
  snapshot_id: string;
  experience_id: string;
  version: number;
  content_hash: Hash;
}): string {
  return `candidate:${jcsHash({
    schema_version: "rsi.experience_candidate_id/1",
    snapshot_id: input.snapshot_id,
    experience_id: input.experience_id,
    version: input.version,
    content_hash: input.content_hash,
  }).slice("sha256:".length)}`;
}

function projectExperienceCandidates(
  snapshot: ReviewSnapshotView | undefined
): ExperienceCandidateView[] {
  if (snapshot === undefined) {
    return [];
  }
  const candidate = snapshot.candidate;
  const shortlist = snapshot.shortlist.map((entry) => ({
    experience_id: entry.experience_id,
    version: entry.version,
    content_hash: entry.content_hash,
    relation: entry.relation,
    excerpt: entry.excerpt,
    source_refs: sortRefs(entry.source_refs),
    text_hash: entry.text_hash,
  }));
  const sourceRefs = mergeRefs(candidate.source_refs, candidate.evidence_refs);
  return [
    {
      schema_version: "rsi.experience_candidate_view/1",
      candidate_id: candidateId({
        snapshot_id: snapshot.snapshot_id,
        experience_id: candidate.experience_id,
        version: candidate.version,
        content_hash: candidate.content_hash,
      }),
      experience_id: candidate.experience_id,
      version: candidate.version,
      content_hash: candidate.content_hash,
      type: candidate.type,
      title: candidate.title,
      summary: candidate.summary,
      trigger: candidate.trigger,
      scope: candidate.scope,
      preconditions: [...candidate.preconditions],
      steps: [...candidate.steps],
      expected_effects: sortUtf8Strings(candidate.expected_effects),
      completion_check: candidate.completion_check,
      counterexamples: [...candidate.counterexamples],
      risk: candidate.risk,
      validation_plan_id: candidate.validation_plan_id,
      evidence_refs: sortRefs(candidate.evidence_refs),
      source_refs: sourceRefs,
      excerpt: candidate.excerpt,
      text_hash: candidate.text_hash,
      static_check_status: snapshot.local_checks.static_check_passed ? "passed" : "failed",
      shortlist,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

function deriveCoverage(input: {
  binding: VersionBinding;
  watermark: number;
  requirements: readonly RequirementView[];
  facts: readonly EvidenceFactView[];
  hardFacts: readonly HardFactReadView[];
  feedback: readonly FeedbackView[];
  progress: readonly ProgressSignalView[];
  constraints: readonly UnverifiedConstraintView[];
  sourceSetHash: Hash;
}): { snapshot: CoverageSnapshotView; views: CoverageView[] } {
  const active = input.requirements.filter((requirement) => requirement.status === "active");
  const checked = sortUtf8Strings(active.map((requirement) => requirement.requirement_id));
  const searched = sortUtf8Strings([
    ...input.requirements.map((row) => `requirement:${row.requirement_id}`),
    ...input.feedback.map((row) => `feedback:${row.feedback_id}`),
    ...input.facts.map((row) => `fact:${row.fact_id}`),
    ...input.progress.map((row) => `progress:${row.signal_id}`),
    ...input.constraints.map((row) => `unverified_constraint:${row.constraint_id}`),
  ]);
  const missing: CoverageSnapshotView["missing"] = [];
  for (const requirement of active) {
    const requirementId = requirement.requirement_id;
    const facts = input.facts.filter((fact) => fact.requirement_id === requirementId);
    if (facts.length === 0) {
      missing.push({
        code: "capture_gap",
        requirement_id: requirementId,
        logical_id: `requirement:${requirementId}`,
        source_refs: [requirement.statement_ref],
        affects_question_ids: [],
      });
      continue;
    }
    if (facts.every((fact) => fact.artifact_version === undefined)) {
      missing.push({
        code: "artifact_version_unknown",
        requirement_id: requirementId,
        logical_id: `requirement:${requirementId}`,
        source_refs: [requirement.statement_ref],
        affects_question_ids: [],
      });
    }
    const verifiedSupport = facts.some(
      (fact) =>
        (fact.kind === "test" || fact.kind === "result") &&
        fact.verified &&
        fact.effect === "supports"
    );
    if (!verifiedSupport) {
      missing.push({
        code: "verifier_absent",
        requirement_id: requirementId,
        logical_id: `requirement:${requirementId}`,
        source_refs: [requirement.statement_ref],
        affects_question_ids: [],
      });
    }
    const hard = input.hardFacts.filter((fact) => fact.requirement_id === requirementId);
    const groups = new Map<string, HardFactReadView[]>();
    for (const fact of hard) {
      const key = fact.proposition_id ?? "";
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [fact]);
      } else {
        group.push(fact);
      }
    }
    const conflictFacts: HardFactReadView[] = [];
    for (const group of groups.values()) {
      const supports = group.filter((fact) => fact.effect === "supports");
      const violates = group.filter((fact) => fact.effect === "violates");
      for (const support of supports) {
        for (const violation of violates) {
          if (support.independence_key !== violation.independence_key) {
            conflictFacts.push(support, violation);
          }
        }
      }
    }
    if (conflictFacts.length > 0) {
      const sourceRefs = mergeRefs(...conflictFacts.map((fact) => fact.source_refs));
      missing.push({
        code: "conflicting_sources",
        requirement_id: requirementId,
        logical_id: `requirement:${requirementId}`,
        source_refs: sourceRefs,
        fact_keys: sortUtf8Strings(conflictFacts.map((fact) => fact.fact_key)) as Hash[],
        affects_question_ids: [],
      });
    }
  }
  missing.sort((a, b) => {
    const byRequirement = a.requirement_id < b.requirement_id ? -1 : a.requirement_id > b.requirement_id ? 1 : 0;
    if (byRequirement !== 0) {
      return byRequirement;
    }
    const byCode = a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    if (byCode !== 0) {
      return byCode;
    }
    return JSON.stringify(a.fact_keys ?? []) < JSON.stringify(b.fact_keys ?? []) ? -1 : 1;
  });
  const sourceRefs = mergeRefs(
    active.map((requirement) => requirement.statement_ref),
    ...missing.map((entry) => entry.source_refs ?? []),
    ...input.feedback.map((row) => row.source_refs),
    ...input.progress.map((row) => row.source_refs),
    ...input.constraints.map((row) => row.source_refs)
  );
  const snapshotId = coverageSnapshotId({
    binding: input.binding,
    watermark: input.watermark,
    checked_requirement_ids: checked,
    searched_sources: searched,
    missing: JSON.parse(JSON.stringify(missing)) as JsonValue,
    source_set_hash: input.sourceSetHash,
  });
  const snapshot: CoverageSnapshotView = {
    schema_version: "rsi.coverage_snapshot_view/1",
    snapshot_id: snapshotId,
    binding: input.binding,
    watermark: input.watermark,
    scope: "ledger_scan/1",
    searched_sources: searched,
    checked_requirement_ids: checked,
    counterevidence_complete_for: checked,
    missing,
    complete: true,
    source_refs: sourceRefs,
  };
  const missingCodes = [...new Set(missing.map((entry) => entry.code))];
  const view: CoverageView = {
    schema_version: "rsi.coverage_view/1",
    view_key: coverageViewKey({
      snapshot_id: snapshotId,
      checked_requirement_ids: checked,
      searched_sources: searched,
      missing_codes: missingCodes,
      source_refs: sourceRefs,
    }),
    scope: "ledger_scan/1",
    checked_requirement_ids: checked,
    searched_sources: searched,
    missing_codes: sortUtf8Strings(missingCodes) as CoverageView["missing_codes"],
    source_refs: sourceRefs,
  };
  return { snapshot, views: [view] };
}

/* ------------------------------------------------------------------ */
/* Source resolution                                                   */
/* ------------------------------------------------------------------ */

interface ResolvedSources {
  records: Map<SourceRef, FrozenSourceRecord>;
  sourceSetHash: Hash;
}

function mapResolveError(
  code: string,
  stage: LoadStage,
  details: Record<string, JsonValue>
): EvdIndexLoadError {
  switch (code) {
    case "E_SOURCE_NOT_FOUND":
    case "E_SOURCE_REF_INVALID":
      return loadError("E_INDEX_SOURCE_UNRETRIEVABLE", stage, details);
    case "E_SOURCE_UTF8_INVALID":
      return loadError("E_INDEX_SOURCE_UTF8_INVALID", stage, details);
    case "E_SOURCE_TOO_LARGE":
      return loadError("E_INDEX_SOURCE_TOO_LARGE", stage, details);
    case "E_SOURCE_HASH":
      return loadError("E_INDEX_SOURCE_CONFLICT", stage, details);
    default:
      return loadError("E_INDEX_UPSTREAM_UNAVAILABLE", stage, details);
  }
}

async function resolveSources(
  refs: readonly SourceRef[],
  deps: EvidenceIndexSnapshotLoaderDeps,
  state: DeadlineState
): Promise<EvdIndexLoadResult<ResolvedSources>> {
  if (refs.length > MAX_INDEX_SOURCE_REFS) {
    return fail("E_INDEX_LIMIT_EXCEEDED", "sources_resolve", {
      gate: "MAX_INDEX_SOURCE_REFS",
      limit: MAX_INDEX_SOURCE_REFS,
      observed: refs.length,
    });
  }
  const retrieval = await withinDeadline(deps.sources.checkRetrievable(refs), state);
  if (!retrieval.ok) {
    return retrieval;
  }
  const records = new Map<SourceRef, FrozenSourceRecord>();
  let totalBytes = 0;
  for (const ref of refs) {
    const availability = retrieval.value.get(ref);
    if (availability === undefined || !availability.retrievable) {
      if (availability?.reason === "too_large") {
        return fail("E_INDEX_SOURCE_TOO_LARGE", "sources_resolve", { source_ref: ref });
      }
      return fail("E_INDEX_SOURCE_UNRETRIEVABLE", "sources_resolve", {
        source_ref: ref,
        reason: availability?.reason ?? "missing",
      });
    }
    const resolved = await withinDeadline(deps.sources.resolve(ref, { maxBytes: MAX_SOURCE_BYTES }), state);
    if (!resolved.ok) {
      return err(resolved.error);
    }
    if (!resolved.value.ok) {
      return err(
        mapResolveError(resolved.value.error.code, "sources_resolve", {
          source_ref: ref,
          upstream_code: resolved.value.error.code,
        })
      );
    }
    const value: FrozenResolvedSource = resolved.value.value;
    if (!value.retrievable || value.bytes === null || value.bytes.length === 0) {
      return fail("E_INDEX_SOURCE_UNRETRIEVABLE", "sources_resolve", {
        source_ref: ref,
        reason: "range_mismatch",
      });
    }
    const parsed = parseSourceRef(ref);
    if (!parsed.ok) {
      return fail("E_INDEX_SOURCE_UNRETRIEVABLE", "sources_resolve", {
        source_ref: ref,
        reason: "range_mismatch",
      });
    }
    const expectedLength = parsed.value.end - parsed.value.start;
    if (value.bytes.length !== expectedLength) {
      return fail("E_INDEX_SOURCE_UNRETRIEVABLE", "sources_resolve", {
        source_ref: ref,
        reason: "range_mismatch",
      });
    }
    if (value.bytes.length > MAX_SOURCE_BYTES) {
      return fail("E_INDEX_SOURCE_TOO_LARGE", "sources_resolve", {
        source_ref: ref,
        limit: MAX_SOURCE_BYTES,
        observed: value.bytes.length,
      });
    }
    totalBytes += value.bytes.length;
    if (totalBytes > MAX_TOTAL_FROZEN_BYTES) {
      return fail("E_INDEX_LIMIT_EXCEEDED", "sources_resolve", {
        gate: "MAX_TOTAL_FROZEN_BYTES",
        limit: MAX_TOTAL_FROZEN_BYTES,
        observed: totalBytes,
      });
    }
    const contentHash = sha256BytesHash(value.bytes);
    // DD-EVD-003a-6: the frozen bytes are decoded first. A byte sequence that
    // is not valid UTF-8 is a UTF-8 failure, not a hash conflict, so the
    // decode precedes every hash and version comparison.
    const text = decodeStrict(value.bytes);
    if (text === null) {
      return fail("E_INDEX_SOURCE_UTF8_INVALID", "sources_validate", { source_ref: ref });
    }
    if (value.range_content_hash !== null && value.range_content_hash !== contentHash) {
      return fail("E_INDEX_SOURCE_CONFLICT", "sources_validate", {
        source_ref: ref,
        expected: value.range_content_hash,
        actual: contentHash,
      });
    }
    // DD-EVD-003a-5: the same `source_ref` must resolve to the same
    // `content_version` and the same `content_hash` on every read of the same
    // binding/watermark. The retrievability observation and the resolved
    // bytes are two independent reads of that address; if they disagree the
    // address is inconsistent and the load is refused as a conflict rather
    // than freezing one of the two readings.
    if (
      availability.range_content_hash !== null &&
      availability.range_content_hash !== contentHash
    ) {
      return fail("E_INDEX_SOURCE_CONFLICT", "sources_validate", {
        source_ref: ref,
        expected: availability.range_content_hash,
        actual: contentHash,
      });
    }
    const version = contentVersionFor(ref, value);
    if (!version.ok) {
      return fail("E_INDEX_SOURCE_CONFLICT", "sources_validate", version.details);
    }
    const existing = records.get(ref);
    if (existing !== undefined) {
      if (existing.content_hash !== contentHash || existing.content_version !== version.value) {
        return fail("E_INDEX_SOURCE_CONFLICT", "sources_validate", {
          source_ref: ref,
          expected: existing.content_hash,
          actual: contentHash,
        });
      }
      continue;
    }
    records.set(ref, {
      bytes: value.bytes.slice(),
      text,
      content_hash: contentHash,
      text_hash: contentHash,
      content_version: version.value,
    });
  }
  const unique = [...records.entries()]
    .map(([source_ref, record]) => ({
      source_ref,
      content_hash: record.content_hash,
      content_version: record.content_version,
    }))
    .sort((a, b) => (a.source_ref < b.source_ref ? -1 : a.source_ref > b.source_ref ? 1 : 0));
  const sourceSetHash = jcsHash(unique);
  return ok({ records, sourceSetHash });
}

function contentVersionFor(
  ref: SourceRef,
  value: FrozenResolvedSource
): { ok: true; value: Hash } | { ok: false; details: Record<string, JsonValue> } {
  const parsed = parseSourceRef(ref);
  if (!parsed.ok) {
    return { ok: false, details: { source_ref: ref } };
  }
  if (parsed.value.scheme === "blob") {
    const embedded = parsed.value.locator;
    if (value.contentVersion !== null) {
      if (value.contentVersion !== embedded) {
        return {
          ok: false,
          details: {
            source_ref: ref,
            expected: embedded,
            actual: value.contentVersion,
          },
        };
      }
      return { ok: true, value: value.contentVersion };
    }
    return { ok: true, value: embedded as Hash };
  }
  if (value.contentVersion === null) {
    return { ok: false, details: { source_ref: ref } };
  }
  return { ok: true, value: value.contentVersion };
}

/* ------------------------------------------------------------------ */
/* Loader                                                              */
/* ------------------------------------------------------------------ */

interface LoadState {
  request: EvidenceIndexLoadRequest;
  deadline: DeadlineState;
  retries: number;
  signal: AbortSignal | undefined;
}

interface LedgerView {
  snapshot: LedgerEvidenceSnapshot;
  requirements: RequirementView[];
  ops: RequirementOpView[];
  feedback: FeedbackView[];
  constraints: UnverifiedConstraintView[];
}

interface FactsView {
  facts: EvidenceFactView[];
  hardFacts: HardFactReadView[];
  factRows: StateFactView[];
  verifierRows: VerifierRegistryView[];
}

interface ProgressView {
  rows: ProgressCheckpointReadView[];
  signals: ProgressSignalView[];
  comparisons: ComparisonView[];
}

function checkAbort(state: LoadState): EvdIndexLoadError | null {
  if (state.signal?.aborted === true) {
    return loadError("E_INDEX_ABORTED", "validate", {});
  }
  return null;
}

function validateRequest(q: EvidenceIndexLoadRequest): EvdIndexLoadError | null {
  if (q.schema_version !== "rsi.evidence_index_load_request/1") {
    return loadError("E_INDEX_REQUEST_INVALID", "validate", { field: "schema_version" });
  }
  if (q.watermark !== q.binding.watermark) {
    return loadError("E_INDEX_WATERMARK_INVALID", "validate", {
      watermark: q.watermark,
      expected: q.binding.watermark,
    });
  }
  if (!Number.isSafeInteger(q.progress_from_watermark) || q.progress_from_watermark < 0) {
    return loadError("E_INDEX_REQUEST_INVALID", "validate", { field: "progress_from_watermark" });
  }
  if (q.progress_from_watermark > q.watermark) {
    return loadError("E_INDEX_WINDOW_INVALID", "validate", {
      from_watermark: q.progress_from_watermark,
      to_watermark: q.watermark,
    });
  }
  const hasId = q.review_snapshot_id !== undefined;
  const hasSnapshot = q.review_snapshot !== undefined;
  if (hasId !== hasSnapshot) {
    return loadError("E_INDEX_REQUEST_INVALID", "validate", { field: "review_snapshot" });
  }
  if (hasId && hasSnapshot) {
    const snapshot = q.review_snapshot;
    if (snapshot === undefined) {
      return loadError("E_INDEX_REQUEST_INVALID", "validate", { field: "review_snapshot" });
    }
    if (q.review_snapshot_id !== snapshot.snapshot_id) {
      return loadError("E_INDEX_REVIEW_SNAPSHOT_INVALID", "validate", {
        review_snapshot_id: q.review_snapshot_id ?? "",
      });
    }
    if (!isHash(snapshot.snapshot_hash)) {
      return loadError("E_INDEX_REVIEW_SNAPSHOT_INVALID", "validate", {
        review_snapshot_id: snapshot.snapshot_id,
      });
    }
    if (!nonWatermarkEqual(snapshot.binding, q.binding)) {
      return loadError("E_INDEX_BINDING_INVALID", "validate", { field: "review_snapshot.binding" });
    }
    if (snapshot.watermark > q.watermark) {
      return loadError("E_INDEX_WINDOW_INVALID", "validate", {
        from_watermark: snapshot.watermark,
        to_watermark: q.watermark,
      });
    }
    if (snapshot.candidate.text_hash !== textHash(snapshot.candidate.excerpt)) {
      return loadError("E_INDEX_REVIEW_SNAPSHOT_INVALID", "validate", {
        review_snapshot_id: snapshot.snapshot_id,
      });
    }
    for (const entry of snapshot.shortlist) {
      if (entry.text_hash !== textHash(entry.excerpt)) {
        return loadError("E_INDEX_REVIEW_SNAPSHOT_INVALID", "validate", {
          review_snapshot_id: snapshot.snapshot_id,
        });
      }
    }
  }
  return null;
}

async function readLedger(
  deps: EvidenceIndexSnapshotLoaderDeps,
  state: LoadState
): Promise<EvdIndexLoadResult<LedgerView>> {
  const result = await withinDeadline(
    deps.ledger.readEvidenceLedger({ binding: state.request.binding }),
    state.deadline
  );
  if (!result.ok) {
    return result;
  }
  if (!result.value.ok) {
    const code = result.value.error.code;
    const mapped =
      code === "E_VERSION_BINDING"
        ? "E_INDEX_BINDING_INVALID"
        : code === "E_WATERMARK_AHEAD"
          ? "E_INDEX_WATERMARK_INVALID"
          : "E_INDEX_UPSTREAM_UNAVAILABLE";
    return fail(mapped, "ledger_read", { upstream_code: code });
  }
  const snapshot = result.value.value;
  if (snapshot.schema_version !== "rsi.ledger_evidence_snapshot/1") {
    return fail("E_INDEX_UPSTREAM_UNAVAILABLE", "ledger_read", { upstream_code: "schema" });
  }
  for (const field of bindingFields(snapshot.binding)) {
    if (snapshot.binding[field] !== state.request.binding[field]) {
      return fail("E_INDEX_BINDING_INVALID", "ledger_read", { field });
    }
  }
  try {
    const requirements = snapshot.requirements.map(projectRequirement);
    const ops = snapshot.requirement_ops.map(projectRequirementOp);
    const feedback = snapshot.feedback.map(projectFeedback);
    const constraints = snapshot.constraints.map(projectConstraint);
    for (const constraint of constraints) {
      if (constraint.quote_hash !== textHash(constraint.quote)) {
        return fail("E_INDEX_DERIVATION_FAILED", "freeze", { field: "quote_hash" });
      }
    }
    return ok({ snapshot, requirements, ops, feedback, constraints });
  } catch {
    return fail("E_INDEX_DERIVATION_FAILED", "ledger_read", { field: "ledger_rows" });
  }
}

async function readFacts(
  deps: EvidenceIndexSnapshotLoaderDeps,
  state: LoadState
): Promise<EvdIndexLoadResult<FactsView>> {
  let factRows: StateFactView[];
  try {
    const factsResult = await withinDeadline(
      deps.facts.listFacts({ binding: state.request.binding }),
      state.deadline
    );
    if (!factsResult.ok) {
      return factsResult;
    }
    factRows = [...factsResult.value];
  } catch (error) {
    return fail("E_INDEX_UPSTREAM_UNAVAILABLE", "facts_read", upstreamDetails(error));
  }
  let verifierRows: VerifierRegistryView[];
  try {
    const verifierResult = await withinDeadline(
      deps.verifiers.listVerifiers({ binding: state.request.binding, statuses: ["valid"] }),
      state.deadline
    );
    if (!verifierResult.ok) {
      return verifierResult;
    }
    verifierRows = [...verifierResult.value];
  } catch (error) {
    return fail("E_INDEX_UPSTREAM_UNAVAILABLE", "facts_read", upstreamDetails(error));
  }
  for (const fact of factRows) {
    if (
      fact.binding.task_id !== state.request.binding.task_id ||
      fact.binding.branch_id !== state.request.binding.branch_id ||
      fact.binding.input_epoch > state.request.binding.input_epoch ||
      fact.binding.watermark > state.request.binding.watermark
    ) {
      return fail("E_INDEX_BINDING_INVALID", "facts_read", { field: "fact.binding" });
    }
  }
  const factIds = new Set(factRows.map((fact) => fact.fact_id));
  for (const verifier of verifierRows) {
    if (!factIds.has(verifier.fact_id)) {
      continue;
    }
    if (
      verifier.verification_binding.task_id !== state.request.binding.task_id ||
      verifier.verification_binding.branch_id !== state.request.binding.branch_id ||
      verifier.verification_binding.watermark > state.request.binding.watermark
    ) {
      return fail("E_INDEX_BINDING_INVALID", "facts_read", { field: "verifier.verification_binding" });
    }
  }
  const facts: EvidenceFactView[] = [];
  for (const fact of factRows) {
    if (fact.stale) {
      continue;
    }
    if (!parseJsonCanonical(fact.value).ok) {
      return fail("E_INDEX_DERIVATION_FAILED", "facts_read", { field: "fact.value" });
    }
    facts.push(projectFact(fact, verifierRows, state.request.binding));
  }
  const hardFacts = projectHardFacts(factRows, verifierRows, state.request.binding);
  facts.sort((a, b) => {
    const aRef = a.source_refs[0] ?? "";
    const bRef = b.source_refs[0] ?? "";
    if (aRef !== bRef) {
      return aRef < bRef ? -1 : 1;
    }
    return a.fact_id < b.fact_id ? -1 : a.fact_id > b.fact_id ? 1 : 0;
  });
  return ok({ facts, hardFacts, factRows, verifierRows });
}

function mapHostError(
  code: string,
  error: { upstream_code?: string }
): EvdIndexLoadError {
  switch (code) {
    case "E_PROGRESS_REQUEST":
      return loadError("E_INDEX_REQUEST_INVALID", "progress_read", { host_code: code });
    case "E_PROGRESS_WINDOW":
      return loadError("E_INDEX_WINDOW_INVALID", "progress_read", { host_code: code });
    case "E_PROGRESS_HISTORY_MISSING":
      return loadError("E_INDEX_PROGRESS_UNSUPPORTED", "progress_read", {
        host_code: code,
        required_order: "host_first_checkpoint_before_evd_load",
      });
    case "E_PROGRESS_DATA":
    case "E_PROGRESS_SCOPE_MISMATCH":
      return loadError("E_INDEX_PROGRESS_UNSUPPORTED", "progress_read", { host_code: code });
    case "E_PROGRESS_LIMIT":
      return loadError("E_INDEX_LIMIT_EXCEEDED", "progress_read", {
        gate: "MAX_PROGRESS_CHECKPOINTS",
        limit: 10_000,
        host_code: code,
      });
    case "E_PROGRESS_STORAGE": {
      const details: Record<string, JsonValue> = { host_code: code };
      if (error.upstream_code !== undefined) {
        details["storage_code"] = error.upstream_code;
      }
      return loadError("E_INDEX_UPSTREAM_UNAVAILABLE", "progress_read", details);
    }
    case "E_PROGRESS_DEADLINE":
      return loadError("E_INDEX_DEADLINE_EXCEEDED", "progress_read", { host_code: code });
    case "E_PROGRESS_CANCELLED":
      return loadError("E_INDEX_ABORTED", "progress_read", { host_code: code });
    default:
      return loadError("E_INDEX_UPSTREAM_UNAVAILABLE", "progress_read", { host_code: code });
  }
}

async function readProgress(
  deps: EvidenceIndexSnapshotLoaderDeps,
  state: LoadState
): Promise<EvdIndexLoadResult<ProgressView>> {
  const deadline = remainingMs(state.deadline);
  if (deadline < 1) {
    return fail("E_INDEX_DEADLINE_EXCEEDED", "progress_read", {
      deadline_ms: EVIDENCE_INDEX_LOAD_DEADLINE_MS,
    });
  }
  const controller = new AbortController();
  if (state.signal !== undefined) {
    state.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const result = await withinDeadline(
    deps.progress.listCheckpoints({
      request_id: newId("req"),
      binding: state.request.binding,
      from_watermark: state.request.progress_from_watermark,
      to_watermark: state.request.watermark,
      read_only_history: true,
      deadline_ms: Math.min(Math.max(deadline, 1), 30_000),
      signal: controller.signal,
    }),
    state.deadline
  );
  if (!result.ok) {
    return result;
  }
  if (!result.value.ok) {
    return err(mapHostError(result.value.error.code, result.value.error));
  }
  const rows = [...result.value.value];
  for (const row of rows) {
    if (row.schema_version !== "rsi.progress_checkpoint/1") {
      return fail("E_INDEX_UPSTREAM_UNAVAILABLE", "progress_read", { host_code: "schema" });
    }
    if (!nonWatermarkEqual(row.binding, state.request.binding)) {
      return fail("E_INDEX_WINDOW_INVALID", "progress_read", { host_code: "E_PROGRESS_SCOPE_MISMATCH" });
    }
    if (row.watermark < state.request.progress_from_watermark || row.watermark > state.request.watermark) {
      return fail("E_INDEX_WINDOW_INVALID", "progress_read", { host_code: "E_PROGRESS_WINDOW" });
    }
    if (!isHash(row.evidence_digest)) {
      return fail("E_INDEX_PROGRESS_UNSUPPORTED", "progress_read", { missing_fields: ["evidence_digest"] });
    }
    if (row.source_refs.length === 0) {
      return fail("E_INDEX_PROGRESS_UNSUPPORTED", "progress_read", { missing_fields: ["source_refs"] });
    }
  }
  if (rows.length > 10_000) {
    return fail("E_INDEX_LIMIT_EXCEEDED", "progress_read", {
      gate: "MAX_PROGRESS_CHECKPOINTS",
      limit: 10_000,
      observed: rows.length,
    });
  }
  const { signals, comparisons } = projectProgress(rows, state.request.binding);
  return ok({ rows, signals, comparisons });
}

function rowCount(input: {
  requirements: number;
  ops: number;
  feedback: number;
  constraints: number;
  facts: number;
  progress: number;
  candidates: number;
  taskConditions: number;
  comparisons: number;
  coverageViews: number;
  hardFacts: number;
}): number {
  return (
    input.requirements +
    input.ops +
    input.feedback +
    input.constraints +
    input.facts +
    input.progress +
    input.candidates +
    input.taskConditions +
    input.comparisons +
    input.coverageViews +
    input.hardFacts +
    1
  );
}

function deriveTaskConditions(
  requirements: readonly RequirementView[],
  ops: readonly RequirementOpView[],
  sources: ReadonlyMap<SourceRef, FrozenSourceRecord>
): EvdIndexLoadResult<TaskConditionView[]> {
  const conditions: TaskConditionView[] = [];
  for (const requirement of requirements) {
    if (requirement.status !== "active") {
      continue;
    }
    const creator = ops.find(
      (op) => op.created_requirement_id === requirement.requirement_id && op.op === "add"
    );
    if (creator === undefined || creator.actor_origin !== "human") {
      return fail("E_INDEX_DERIVATION_FAILED", "freeze", {
        field: "task_condition.origin",
        reason: "creator_op_missing_or_not_human",
      });
    }
    const record = sources.get(requirement.statement_ref);
    if (record === undefined) {
      return fail("E_INDEX_DERIVATION_FAILED", "freeze", { field: "task_condition.text" });
    }
    const text = record.text;
    conditions.push({
      schema_version: "rsi.task_condition_view/1",
      logical_id: `task_condition:${requirement.requirement_id}`,
      condition_id: `condition:${requirement.requirement_id}:statement`,
      requirement_ids: [requirement.requirement_id],
      text,
      text_hash: textHash(text),
      source_ids: [`requirement:${requirement.requirement_id}`],
      source_refs: [requirement.statement_ref],
      origin: "human",
    });
  }
  return ok(conditions.sort((a, b) => (a.logical_id < b.logical_id ? -1 : 1)));
}

function collectRefs(input: {
  requirements: readonly RequirementView[];
  ops: readonly RequirementOpView[];
  feedback: readonly FeedbackView[];
  constraints: readonly UnverifiedConstraintView[];
  facts: readonly EvidenceFactView[];
  progress: readonly ProgressCheckpointReadView[];
  experience: readonly ExperienceCandidateView[];
}): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const row of input.requirements) {
    refs.push(row.statement_ref, ...row.source_refs);
  }
  for (const row of input.ops) {
    refs.push(row.source_quote_ref);
  }
  for (const row of input.feedback) {
    refs.push(...row.source_refs);
  }
  for (const row of input.constraints) {
    refs.push(...row.source_refs);
  }
  for (const row of input.facts) {
    refs.push(...row.source_refs);
  }
  for (const row of input.progress) {
    refs.push(...row.source_refs);
  }
  for (const row of input.experience) {
    refs.push(...row.source_refs);
    for (const entry of row.shortlist) {
      refs.push(...entry.source_refs);
    }
  }
  return sortRefs([...new Set(refs)]);
}

async function revalidateLedger(
  deps: EvidenceIndexSnapshotLoaderDeps,
  state: LoadState,
  first: LedgerView
): Promise<EvdIndexLoadError | null> {
  const result = await withinDeadline(
    deps.ledger.readEvidenceLedger({ binding: state.request.binding }),
    state.deadline
  );
  if (!result.ok) {
    return result.error;
  }
  if (!result.value.ok) {
    return loadError("E_INDEX_UPSTREAM_UNAVAILABLE", "revalidate", {
      upstream_code: result.value.error.code,
    });
  }
  if (result.value.value.view_hash !== first.snapshot.view_hash) {
    return loadError("E_INDEX_VERSION_CONFLICT", "revalidate", {
      conflict_type: "view_hash",
      object_id: first.snapshot.view_hash,
    });
  }
  if (result.value.value.constraints_view_hash !== first.snapshot.constraints_view_hash) {
    return loadError("E_INDEX_VERSION_CONFLICT", "revalidate", {
      conflict_type: "view_hash",
      object_id: first.snapshot.constraints_view_hash,
    });
  }
  return null;
}

async function revalidateFacts(
  deps: EvidenceIndexSnapshotLoaderDeps,
  state: LoadState,
  first: FactsView
): Promise<EvdIndexLoadError | null> {
  const factsResult = await withinDeadline(
    deps.facts.listFacts({ binding: state.request.binding }),
    state.deadline
  );
  if (!factsResult.ok) {
    return factsResult.error;
  }
  const verifierResult = await withinDeadline(
    deps.verifiers.listVerifiers({ binding: state.request.binding, statuses: ["valid"] }),
    state.deadline
  );
  if (!verifierResult.ok) {
    return verifierResult.error;
  }
  const previousFacts = new Map(first.factRows.map((fact) => [fact.fact_id, fact.row_version]));
  const currentFacts = new Map(factsResult.value.map((fact) => [fact.fact_id, fact.row_version]));
  if (previousFacts.size !== currentFacts.size) {
    return loadError("E_INDEX_VERSION_CONFLICT", "revalidate", {
      conflict_type: "fact_row_version",
      object_id: "fact_set",
    });
  }
  for (const [factId, rowVersion] of previousFacts) {
    if (currentFacts.get(factId) !== rowVersion) {
      return loadError("E_INDEX_VERSION_CONFLICT", "revalidate", {
        conflict_type: "fact_row_version",
        object_id: factId,
      });
    }
  }
  const previousVerifiers = new Map(
    first.verifierRows.map((row) => [`${row.fact_id}|${row.verifier_ref}`, row.row_version])
  );
  const currentVerifiers = new Map(
    verifierResult.value.map((row) => [`${row.fact_id}|${row.verifier_ref}`, row.row_version])
  );
  if (previousVerifiers.size !== currentVerifiers.size) {
    return loadError("E_INDEX_VERSION_CONFLICT", "revalidate", {
      conflict_type: "verifier_row_version",
      object_id: "verifier_set",
    });
  }
  for (const [key, rowVersion] of previousVerifiers) {
    if (currentVerifiers.get(key) !== rowVersion) {
      return loadError("E_INDEX_VERSION_CONFLICT", "revalidate", {
        conflict_type: "verifier_row_version",
        object_id: key,
      });
    }
  }
  return null;
}

async function loadOnce(
  deps: EvidenceIndexSnapshotLoaderDeps,
  state: LoadState
): Promise<EvdIndexLoadResult<EvidenceIndexSnapshot>> {
  const abort = checkAbort(state);
  if (abort !== null) {
    return err(abort);
  }
  const requestError = validateRequest(state.request);
  if (requestError !== null) {
    return err(requestError);
  }
  const deadline = checkDeadline(state.deadline);
  if (deadline !== null) {
    return err(deadline);
  }

  const ledger = await readLedger(deps, state);
  if (!ledger.ok) {
    return ledger;
  }
  const facts = await readFacts(deps, state);
  if (!facts.ok) {
    return facts;
  }
  const progress = await readProgress(deps, state);
  if (!progress.ok) {
    return progress;
  }
  const experience = projectExperienceCandidates(state.request.review_snapshot);

  const counts = rowCount({
    requirements: ledger.value.requirements.length,
    ops: ledger.value.ops.length,
    feedback: ledger.value.feedback.length,
    constraints: ledger.value.constraints.length,
    facts: facts.value.facts.length,
    progress: progress.value.signals.length,
    candidates: experience.length,
    taskConditions: 0,
    comparisons: progress.value.comparisons.length,
    coverageViews: 1,
    hardFacts: facts.value.hardFacts.length,
  });
  if (counts > MAX_INDEX_ROWS) {
    return fail("E_INDEX_LIMIT_EXCEEDED", "freeze", {
      gate: "MAX_INDEX_ROWS",
      limit: MAX_INDEX_ROWS,
      observed: counts,
    });
  }

  const refs = collectRefs({
    requirements: ledger.value.requirements,
    ops: ledger.value.ops,
    feedback: ledger.value.feedback,
    constraints: ledger.value.constraints,
    facts: facts.value.facts,
    progress: progress.value.rows,
    experience,
  });
  const resolved = await resolveSources(refs, deps, state.deadline);
  if (!resolved.ok) {
    return resolved;
  }

  const revalidateError =
    (await revalidateLedger(deps, state, ledger.value)) ??
    (await revalidateFacts(deps, state, facts.value));
  if (revalidateError !== null) {
    return err(revalidateError);
  }

  const taskConditions = deriveTaskConditions(
    ledger.value.requirements,
    ledger.value.ops,
    resolved.value.records
  );
  if (!taskConditions.ok) {
    return taskConditions;
  }

  const rawData: EvidenceIndexSnapshotData = {
    binding: state.request.binding,
    watermark: state.request.watermark,
    progress_from_watermark: state.request.progress_from_watermark,
    ledger_view_hash: ledger.value.snapshot.view_hash,
    constraints_view_hash: ledger.value.snapshot.constraints_view_hash,
    source_set_hash: resolved.value.sourceSetHash,
    review_snapshot_id: state.request.review_snapshot?.snapshot_id ?? null,
    review_snapshot_hash: state.request.review_snapshot?.snapshot_hash ?? null,
    requirements: ledger.value.requirements,
    requirement_ops: ledger.value.ops,
    feedback: ledger.value.feedback,
    unverified_constraints: ledger.value.constraints,
    facts: facts.value.facts,
    progress_signals: progress.value.signals,
    experience_candidates: experience,
    task_conditions: taskConditions.value,
    comparisons: progress.value.comparisons,
    coverage_views: [],
    hard_facts: facts.value.hardFacts,
    coverage_snapshot: emptyCoverage(state.request.binding, state.request.watermark),
    sources: resolved.value.records,
  };
  const coverage = deriveCoverage({
    binding: state.request.binding,
    watermark: state.request.watermark,
    requirements: rawData.requirements,
    facts: rawData.facts,
    hardFacts: rawData.hard_facts,
    feedback: rawData.feedback,
    progress: rawData.progress_signals,
    constraints: rawData.unverified_constraints,
    sourceSetHash: resolved.value.sourceSetHash,
  });
  const data: EvidenceIndexSnapshotData = {
    ...rawData,
    coverage_snapshot: coverage.snapshot,
    coverage_views: coverage.views,
  };
  const rowsBytes = utf8Length(JSON.stringify(snapshotRowsProjection(data)));
  let sourceBytes = 0;
  for (const record of data.sources.values()) {
    sourceBytes += record.bytes.length;
  }
  if (sourceBytes + rowsBytes > MAX_TOTAL_FROZEN_BYTES) {
    return fail("E_INDEX_LIMIT_EXCEEDED", "freeze", {
      gate: "MAX_TOTAL_FROZEN_BYTES",
      limit: MAX_TOTAL_FROZEN_BYTES,
      observed: sourceBytes + rowsBytes,
    });
  }
  const finalRefs = collectRefs({
    requirements: data.requirements,
    ops: data.requirement_ops,
    feedback: data.feedback,
    constraints: data.unverified_constraints,
    facts: data.facts,
    progress: progress.value.rows,
    experience: data.experience_candidates,
  });
  const allRefs = new Set<SourceRef>([
    ...finalRefs,
    ...coverage.snapshot.source_refs,
    ...data.task_conditions.map((row) => row.source_refs).flat(),
  ]);
  if (allRefs.size > MAX_INDEX_SOURCE_REFS) {
    return fail("E_INDEX_LIMIT_EXCEEDED", "freeze", {
      gate: "MAX_INDEX_SOURCE_REFS",
      limit: MAX_INDEX_SOURCE_REFS,
      observed: allRefs.size,
    });
  }
  const abortAfter = checkAbort(state);
  if (abortAfter !== null) {
    return err(abortAfter);
  }
  return ok(createEvidenceIndexSnapshot(data));
}

function emptyCoverage(binding: VersionBinding, watermark: number): CoverageSnapshotView {
  return {
    schema_version: "rsi.coverage_snapshot_view/1",
    snapshot_id: "coverage:",
    binding,
    watermark,
    scope: "ledger_scan/1",
    searched_sources: [],
    checked_requirement_ids: [],
    counterevidence_complete_for: [],
    missing: [],
    complete: true,
    source_refs: [],
  };
}

export function createEvidenceIndexSnapshotLoader(
  deps: EvidenceIndexSnapshotLoaderDeps
): EvidenceIndexSnapshotLoader {
  return {
    async load(q, opts) {
      const state: LoadState = {
        request: q,
        deadline: {
          deadline: deps.monotonic_now() + EVIDENCE_INDEX_LOAD_DEADLINE_MS,
          now: deps.monotonic_now,
        },
        retries: 0,
        signal: opts?.signal,
      };
      let lastError: EvdIndexLoadError | null = null;
      for (let attempt = 0; attempt <= DEFAULT_CONFLICT_RETRIES; attempt += 1) {
        const result = await loadOnce(deps, state);
        if (result.ok) {
          return result;
        }
        if (result.error.code !== "E_INDEX_VERSION_CONFLICT") {
          return result;
        }
        lastError = result.error;
      }
      return err(lastError ?? loadError("E_INDEX_VERSION_CONFLICT", "revalidate", {}));
    },
  };
}

export { MAX_EXCERPT_BYTES };
