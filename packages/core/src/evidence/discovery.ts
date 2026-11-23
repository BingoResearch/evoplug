/**
 * Deterministic issue discovery (DD-QP-08).
 *
 * Detectors run in a fixed order over the frozen snapshot. No detector calls
 * Jev, a model or a host; no detector creates requirements, grants, deliveries
 * or goal changes. Output is deduplicated by `issue_key` and sorted by
 * `(type_rank, issue_key)`.
 */

import { compareUtf8, sortUtf8 } from "../canonical.js";
import type { VersionBinding } from "../version-binding.js";
import type { SourceRef } from "../source-ref.js";
import { MAX_ISSUES_PER_DISCOVERY, QP_ISSUE_DETECTOR_VERSION } from "./constants.js";
import type {
  EvidenceGap,
  Issue,
  IssueDiscoveryInput,
  IssueDiscoveryResult,
  IssueTrigger,
  IssueType
} from "./types.js";
import type { CoverageSnapshotView, EvidenceFactView, EvidenceIndexSnapshot, RequirementView } from "./ports.js";
import { factArtifactVersion, factRequirementIds, factSubject } from "./ports.js";
import { createProposedIssue, issueTypeRank } from "./issue_lifecycle.js";
import {
  acceptanceSubjectKey,
  evidenceGapsPreimage,
  issueKey,
  sortedUnique,
  sortedUniqueRefs
} from "./hashes.js";

interface DiscoveryDeps {
  snapshot: EvidenceIndexSnapshot;
  clock: { utcNowMs(): number };
  allocateIssueId(): string;
}

interface Candidate {
  issue: Issue;
  order: number;
}

function primaryRef(requirement: RequirementView): SourceRef {
  return requirement.statement_ref;
}

function factRefs(fact: EvidenceFactView): SourceRef[] {
  return sortedUniqueRefs(fact.source_refs);
}

function requirementCoupling(facts: readonly EvidenceFactView[], requirementId: string): EvidenceFactView[] {
  return facts.filter((fact) => factRequirementIds(fact).includes(requirementId));
}

function hasBoundary(
  snapshot: EvidenceIndexSnapshot,
  binding: VersionBinding,
  input: IssueDiscoveryInput
): boolean {
  const signals = snapshot.listProgressSignals({
    binding,
    from_watermark: input.progress_from_watermark,
    to_watermark: input.watermark
  });
  if (signals.some((signal) => signal.status === "comparable" && signal.to_watermark === input.watermark)) {
    return true;
  }
  const facts = snapshot.listFacts({ binding, watermark: input.watermark });
  return facts.some((fact) => fact.kind === "message" && fact.status === "claim");
}

function supportingFact(facts: readonly EvidenceFactView[], requirementId: string): EvidenceFactView | null {
  for (const fact of facts) {
    if (!fact.stale && factRequirementIds(fact).includes(requirementId) && (fact.status === "verified" || fact.status === "contradicted")) {
      return fact;
    }
  }
  return null;
}

function missingFor(coverage: CoverageSnapshotView, requirementId: string, code: string): CoverageSnapshotView["missing"][number] | null {
  return coverage.missing.find((entry) => entry.requirement_id === requirementId && entry.code === code) ?? null;
}

function factValueOf(fact: EvidenceFactView): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fact.value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function failingAssertion(fact: EvidenceFactView, requirementId: string): boolean {
  if (fact.kind !== "test") {
    return false;
  }
  const value = factValueOf(fact);
  if (value === null || !Array.isArray(value["assertions"])) {
    return false;
  }
  return value["assertions"].some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const record = entry as Record<string, unknown>;
    return record["requirement_id"] === requirementId && record["result"] === "fail";
  });
}

function pathInExcludedScope(requirement: RequirementView, path: string): boolean {
  const excluded = requirement.scope.excluded_paths ?? [];
  const objects = requirement.scope.objects ?? [];
  return excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) || objects.includes(path);
}

function makeCandidate(input: {
  deps: DiscoveryDeps;
  binding: VersionBinding;
  type: IssueType;
  subject_key: string;
  detector_id: string;
  trigger_kind: IssueTrigger["kind"];
  source_event_ids: readonly string[];
  source_refs: readonly SourceRef[];
  requirement_ids: readonly string[];
  artifact_paths?: readonly string[];
  artifact_versions?: readonly { path: string; version: string }[];
  contract_required?: boolean;
  contract_paths?: readonly string[];
  evidence_gap?: readonly EvidenceGap[];
  experience_ref?: Issue["experience_ref"];
  order: number;
}): Candidate {
  const key = issueKey({
    type: input.type,
    binding: input.binding,
    requirement_ids: input.requirement_ids,
    subject_key: input.subject_key
  });
  const issue = createProposedIssue({
    issue_id: input.deps.allocateIssueId(),
    issue_key: key,
    binding: input.binding,
    type: input.type,
    subject_key: input.subject_key,
    question_text: null,
    requirement_ids: input.requirement_ids,
    artifact_paths: input.artifact_paths ?? [],
    artifact_versions: input.artifact_versions ?? [],
    contract_required: input.contract_required ?? false,
    contract_paths: input.contract_paths ?? [],
    trigger: {
      kind: input.trigger_kind,
      event_ids: sortedUnique(input.source_event_ids),
      detector_id: input.detector_id,
      detector_version: QP_ISSUE_DETECTOR_VERSION
    },
    source_event_ids: input.source_event_ids,
    source_refs: input.source_refs,
    evidence_gap: input.evidence_gap ?? [],
    created_at: input.deps.clock.utcNowMs()
  });
  if (input.experience_ref !== undefined) {
    issue.experience_ref = input.experience_ref;
  }
  return { issue, order: input.order };
}

function gapsFor(
  code: EvidenceGap["code"],
  requirementId: string,
  refs: readonly SourceRef[]
): EvidenceGap {
  return {
    code,
    requirement_ids: [requirementId],
    source_refs: sortedUniqueRefs(refs),
    affects_question_keys: []
  };
}

/** Runs D1 … D8 and returns proposed issues in deterministic order. */
export function discoverIssues(input: IssueDiscoveryInput, deps: DiscoveryDeps): IssueDiscoveryResult {
  const snapshot = deps.snapshot;
  if (
    input.binding.task_id !== snapshot.binding.task_id ||
    input.binding.branch_id !== snapshot.binding.branch_id ||
    input.binding.input_epoch !== snapshot.binding.input_epoch ||
    input.binding.goal_version !== snapshot.binding.goal_version ||
    input.binding.config_version !== snapshot.binding.config_version ||
    input.binding.watermark !== snapshot.binding.watermark
  ) {
    return { status: "rejected", issues: [], proposed_count: 0, errors: ["E_INDEX_SCOPE_MISMATCH"] };
  }
  if (input.watermark !== snapshot.watermark) {
    return { status: "rejected", issues: [], proposed_count: 0, errors: ["E_INDEX_SCOPE_MISMATCH"] };
  }
  if (
    input.progress_from_watermark < 0 ||
    input.progress_from_watermark > input.watermark ||
    input.progress_from_watermark !== snapshot.progress_from_watermark
  ) {
    return { status: "rejected", issues: [], proposed_count: 0, errors: ["E_INDEX_WINDOW_INVALID"] };
  }
  const reviewInput = input.review_snapshot_id ?? null;
  if (reviewInput !== snapshot.review_snapshot_id) {
    return { status: "rejected", issues: [], proposed_count: 0, errors: ["E_INDEX_REVIEW_SNAPSHOT_MISSING"] };
  }

  const binding = input.binding;
  const requirements = sortUtf8(
    snapshot
      .listRequirements({ binding, watermark: input.watermark })
      .filter((requirement) => requirement.status === "active"),
    (requirement) => requirement.requirement_id
  );
  const ops = sortUtf8(
    snapshot.listRequirementOps({
      binding,
      watermark: input.watermark,
      statuses: ["applied", "proposed", "conflict"]
    }),
    (op) => op.op_id
  );
  void snapshot.listFeedback({ binding, watermark: input.watermark });
  const facts = sortUtf8(
    snapshot
      .listFacts({ binding, watermark: input.watermark })
      .filter((fact) => !fact.stale),
    (fact) => fact.fact_id
  );
  const coverage = snapshot.getCoverageSnapshot({ binding, watermark: input.watermark });
  const boundary = hasBoundary(snapshot, binding, input);
  const candidates: Candidate[] = [];
  let order = 0;

  // D1 constraint_violation: a verified failing assertion for an active requirement.
  for (const requirement of requirements) {
    for (const fact of requirementCoupling(facts, requirement.requirement_id)) {
      if (fact.status !== "verified" || !failingAssertion(fact, requirement.requirement_id)) {
        continue;
      }
      const subject = factSubject(fact);
      const artifactVersion = factArtifactVersion(fact);
      const refs = sortedUniqueRefs([...factRefs(fact), primaryRef(requirement)]);
      candidates.push(
        makeCandidate({
          deps,
          binding,
          type: "constraint_violation",
          subject_key: `constraint:${requirement.requirement_id}:${subject ?? "test"}`.slice(0, 512),
          detector_id: "constraint_violation/1",
          trigger_kind: "deterministic_check",
          source_event_ids: [fact.fact_id],
          source_refs: refs,
          requirement_ids: [requirement.requirement_id],
          artifact_paths: subject === null ? [] : [subject],
          artifact_versions:
            subject === null || artifactVersion === null ? [] : [{ path: subject, version: artifactVersion }],
          order: order++
        })
      );
    }
  }

  // D2 missing_requirement: completion/boundary and a capture gap with no supporting fact.
  if (boundary) {
    for (const requirement of requirements) {
      const missing = missingFor(coverage, requirement.requirement_id, "capture_gap");
      if (missing === null || supportingFact(facts, requirement.requirement_id) !== null) {
        continue;
      }
      const acceptance: unknown = requirement.acceptance;
      const acceptanceSpec = Array.isArray(acceptance)
        ? {
            kind: "test" as const,
            criterion:
              typeof (acceptance[0] as { text?: unknown } | undefined)?.text === "string"
                ? ((acceptance[0] as { text: string }).text)
                : requirement.requirement_id
          }
        : (acceptance as { kind: "human_acceptance" | "test" | "artifact" | "constraint"; criterion: string });
      const acceptanceKey = acceptanceSubjectKey({
        kind: acceptanceSpec.kind ?? "test",
        criterion: acceptanceSpec.criterion ?? requirement.requirement_id
      }).slice("sha256:".length);
      const refs = sortedUniqueRefs([primaryRef(requirement), ...missing.source_refs]);
      candidates.push(
        makeCandidate({
          deps,
          binding,
          type: "missing_requirement",
          subject_key: `missing:${requirement.requirement_id}:${acceptanceKey}`.slice(0, 512),
          detector_id: "missing_requirement/1",
          trigger_kind: "completion_claim",
          source_event_ids: [requirement.requirement_id],
          source_refs: refs,
          requirement_ids: [requirement.requirement_id],
          evidence_gap: [gapsFor("capture_gap", requirement.requirement_id, refs)],
          order: order++
        })
      );
    }
  }

  // D3 wrong_target: a verified diff touching an excluded path/object.
  for (const requirement of requirements) {
    for (const fact of requirementCoupling(facts, requirement.requirement_id)) {
      const subject = factSubject(fact);
      if (fact.kind !== "diff" || fact.status !== "verified" || subject === null) {
        continue;
      }
      if (!pathInExcludedScope(requirement, subject)) {
        continue;
      }
      const artifactVersion = factArtifactVersion(fact);
      const refs = sortedUniqueRefs([...factRefs(fact), primaryRef(requirement)]);
      candidates.push(
        makeCandidate({
          deps,
          binding,
          type: "wrong_target",
          subject_key: `target:${requirement.requirement_id}:${subject}`.slice(0, 512),
          detector_id: "wrong_target/1",
          trigger_kind: "deterministic_check",
          source_event_ids: [fact.fact_id],
          source_refs: refs,
          requirement_ids: [requirement.requirement_id],
          artifact_paths: [subject],
          artifact_versions: artifactVersion === null ? [] : [{ path: subject, version: artifactVersion }],
          order: order++
        })
      );
    }
  }

  // D4 missing_verification: boundary plus verifier/artifact-version gap.
  if (boundary) {
    for (const requirement of requirements) {
      const missing =
        missingFor(coverage, requirement.requirement_id, "verifier_absent") ??
        missingFor(coverage, requirement.requirement_id, "artifact_version_unknown");
      if (missing === null) {
        continue;
      }
      const artifactPath = requirement.scope.paths?.[0] ?? "";
      const refs = sortedUniqueRefs([primaryRef(requirement), ...missing.source_refs]);
      candidates.push(
        makeCandidate({
          deps,
          binding,
          type: "missing_verification",
          subject_key: `verification:${requirement.requirement_id}:${artifactPath}`.slice(0, 512),
          detector_id: "missing_verification/1",
          trigger_kind: "completion_claim",
          source_event_ids: [requirement.requirement_id],
          source_refs: refs,
          requirement_ids: [requirement.requirement_id],
          artifact_paths: artifactPath === "" ? [] : [artifactPath],
          evidence_gap: [gapsFor(missing.code, requirement.requirement_id, refs)],
          order: order++
        })
      );
    }
  }

  // D5 goal_change: proposed or ambiguous requirement operation.
  for (const op of ops) {
    if (op.op === "confirm") {
      continue;
    }
    if (op.status !== "proposed" && op.directive_strength !== "ambiguous") {
      continue;
    }
    const requirementId = op.target_requirement_id ?? op.created_requirement_id;
    // The op view's frozen contract carries only `source_quote_ref`; older
    // loaders also projected a `source_refs` array. Read it defensively so a
    // view without that field cannot abort issue discovery with a TypeError.
    const opRefs: readonly SourceRef[] = Array.isArray(
      (op as { source_refs?: unknown }).source_refs
    )
      ? ((op as { source_refs: SourceRef[] }).source_refs)
      : [];
    const refs = sortedUniqueRefs(
      op.source_quote_ref == null ? opRefs : [op.source_quote_ref, ...opRefs]
    );
    candidates.push(
      makeCandidate({
        deps,
        binding,
        type: "goal_change",
        subject_key: `goal:${op.content_hash}`.slice(0, 512),
        detector_id: "goal_change/1",
        trigger_kind: "stable_boundary",
        source_event_ids: [op.op_id],
        source_refs: refs,
        requirement_ids: requirementId === null ? [] : [requirementId],
        order: order++
      })
    );
  }

  // D6 insufficient_evidence: conflicting sources.
  for (const missing of sortUtf8(coverage.missing, (entry) => `${entry.code}:${entry.requirement_id ?? ""}`)) {
    if (missing.code !== "conflicting_sources") {
      continue;
    }
    const requirementId = missing.requirement_id ?? "";
    const refs = missing.source_refs.length > 0 ? missing.source_refs : coverage.source_refs;
    if (refs.length === 0) {
      continue;
    }
    candidates.push(
      makeCandidate({
        deps,
        binding,
        type: "insufficient_evidence",
        subject_key: `evidence:conflicting_sources:${requirementId}`.slice(0, 512),
        detector_id: "insufficient_evidence/1",
        trigger_kind: "stable_boundary",
        source_event_ids: [requirementId === "" ? coverage.view_key : requirementId],
        source_refs: refs,
        requirement_ids: requirementId === "" ? [] : [requirementId],
        evidence_gap: [
          {
            code: "conflicting_sources",
            requirement_ids: requirementId === "" ? [] : [requirementId],
            source_refs: sortedUniqueRefs(refs),
            affects_question_keys: []
          }
        ],
        order: order++
      })
    );
  }

  // D7 stall_or_regression: two comparable checkpoints and a stalled/regressing latest.
  const signals = sortUtf8(
    snapshot.listProgressSignals({
      binding,
      from_watermark: input.progress_from_watermark,
      to_watermark: input.watermark
    }),
    (signal) => `${String(signal.to_watermark).padStart(16, "0")}:${signal.signal_id}`
  );
  const comparable = signals.filter((signal) => signal.status === "comparable");
  const latestSignal = comparable[comparable.length - 1];
  if (
    comparable.length >= 2 &&
    latestSignal !== undefined &&
    (latestSignal.kind === "stalled_candidate" || latestSignal.kind === "regressing")
  ) {
    const comparisons = snapshot.listComparisons({
      binding,
      watermark: input.watermark
    });
    const viewKey = comparisons[0]?.view_key ?? latestSignal.comparability_key;
    const refs = sortedUniqueRefs(comparable.flatMap((signal) => signal.source_refs));
    if (refs.length > 0) {
      candidates.push(
      makeCandidate({
        deps,
        binding,
        type: "stall_or_regression_candidate",
        subject_key: `progress:${viewKey}`.slice(0, 512),
        detector_id: "stall/1",
        trigger_kind: "progress_signal",
        source_event_ids: comparable.map((signal) => signal.signal_id),
        source_refs: refs,
        requirement_ids: [],
        order: order++
      })
      );
    }
  }

  // D8 experience_applicability is review-domain only. Online discovery has no
  // proposal identity and therefore creates no candidate (DD-QP-08 constraint 5).

  const merged = mergeCandidates(candidates);
  if (merged.length === 0) {
    return { status: "no_op", issues: [], proposed_count: 0, no_op_reason: "no_issue", errors: [] };
  }
  const sorted = merged.sort((left, right) => {
    const byType = issueTypeRank(left.issue.type) - issueTypeRank(right.issue.type);
    return byType !== 0 ? byType : compareUtf8(left.issue.issue_key, right.issue.issue_key);
  });
  const truncated = sorted.length > MAX_ISSUES_PER_DISCOVERY;
  const issues = sorted.slice(0, MAX_ISSUES_PER_DISCOVERY).map((candidate) => candidate.issue);
  return {
    status: truncated ? "truncated" : "ok",
    issues,
    proposed_count: issues.length,
    errors: truncated ? ["E_ISSUE_LIMIT"] : []
  };
}

function mergeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.issue.issue_key);
    if (existing === undefined) {
      byKey.set(candidate.issue.issue_key, candidate);
      continue;
    }
    const issue = existing.issue;
    issue.requirement_ids = sortedUnique([...issue.requirement_ids, ...candidate.issue.requirement_ids]);
    issue.source_event_ids = sortedUnique([...issue.source_event_ids, ...candidate.issue.source_event_ids]);
    issue.source_refs = sortedUniqueRefs([...issue.source_refs, ...candidate.issue.source_refs]);
    const gaps = [...issue.evidence_gap, ...candidate.issue.evidence_gap];
    const gapByKey = new Map<string, EvidenceGap>();
    for (const gap of gaps) {
      const key = JSON.stringify(evidenceGapsPreimage([gap]));
      if (!gapByKey.has(key)) {
        gapByKey.set(key, gap);
      }
    }
    issue.evidence_gap = [...gapByKey.values()];
  }
  return [...byKey.values()];
}

