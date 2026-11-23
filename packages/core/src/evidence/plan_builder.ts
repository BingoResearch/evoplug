/**
 * Deterministic plan construction (DD-QP-18 … DD-QP-21).
 *
 * The builder reads only the frozen snapshot. It resolves template roles into
 * `PlanSource` records, computes question and dependency identities, and
 * returns a fully materialized `QuestionPlan`. Any required role that cannot
 * be resolved is an error, never an empty fallback.
 */

import { hashUtf8, type Hash } from "../hash.js";
import type { SourceRef } from "../source-ref.js";
import type { VersionBinding } from "../version-binding.js";
import { newId } from "../ids.js";
import { compareUtf8, sortUtf8 } from "../canonical.js";
import {
  MAX_EXCERPT_BYTES,
  MAX_PLAN_SOURCES,
  MAX_QUESTIONS_PER_PLAN,
  MAX_REQUIRED_SOURCES_PER_QUESTION,
  MAX_SOURCE_REFS
} from "./constants.js";
import { QpDomainError } from "./issue_repository.js";
import { qpFailure } from "./errors.js";
import {
  dependencyContentHash,
  dependencyKey,
  hashJson,
  planHash,
  planIdempotencyKey,
  propositionId,
  questionKey,
  sorted,
  sortedUnique,
  sortedUniqueRefs,
  sourceContentHash,
  sourceSelection
} from "./hashes.js";
import { renderTemplate } from "./templates.js";
import type { EvidenceDependency, EvidenceFactKind, EvidenceGap, Issue, JudgeStateViewName, PlanSource, PlanSourceKind, PlannedQuestion, QuestionPlan, QuestionTemplate, QuestionTemplateRegistry, RequiredSourceSpec, SourceRole, SourceSelector, TransportRole } from "./types.js";
import type {
  ComparisonView,
  CoverageSnapshotView,
  EvidenceFactView,
  EvidenceIndexSnapshot,
  FeedbackView,
  RequirementView,
  TaskConditionView,
  UnverifiedConstraintView
} from "./ports.js";
import {
  factArtifactVersion,
  factHasVerifier,
  factRequirementIds,
  factSubject
} from "./ports.js";

/** Planning failure carrying the full set of unresolved required roles. */
export class QpPlanBuildError extends QpDomainError {
  readonly gaps: EvidenceGap[];

  constructor(gaps: EvidenceGap[]) {
    super(qpFailure("E_REQUIRED_SOURCE_MISSING", "plan", { role: gaps[0]?.code ?? null }));
    this.gaps = gaps;
  }
}

const TRANSPORT_RANK: Readonly<Record<TransportRole, number>> = Object.freeze({
  requirement: 0,
  feedback: 1,
  artifact: 2,
  verifier: 3,
  counter: 4,
  history: 5,
  context: 6
});

const SHARED_VIEWS: readonly JudgeStateViewName[] = Object.freeze(["binding", "question_scope", "coverage"]);

const ARTIFACT_FACT_KINDS: readonly EvidenceFactKind[] = Object.freeze([
  "code",
  "diff",
  "result",
  "test",
  "call"
]);

const FACT_KINDS: readonly EvidenceFactKind[] = Object.freeze([
  "code",
  "interface_contract",
  "call",
  "result",
  "diff",
  "test",
  "message"
]);

/** Kinds whose view must carry a stable `subject` (DD-QP-19 table). */
const SUBJECT_REQUIRED_FACT_KINDS: readonly EvidenceFactKind[] = Object.freeze([
  "code",
  "interface_contract",
  "call",
  "diff"
]);

const UNVERIFIED_STATUSES = Object.freeze([
  "unverified_constraint",
  "confirmed",
  "rejected"
] as const);

function viewSchemaFailure(field: string): QpDomainError {
  return new QpDomainError(qpFailure("E_SCHEMA", "plan", { field }));
}

/**
 * Rejects a fact view that a real EVD loader would never produce. The planner
 * normally reads a frozen EVD snapshot, but tests and future adapters inject it
 * directly, so the plan schema gate is repeated here. Unknown abstract kinds
 * (`fact`) and malformed views reject the whole plan (DD-QP-19 step 3).
 */
function assertFactView(fact: EvidenceFactView): void {
  if (!FACT_KINDS.includes(fact.kind)) {
    throw viewSchemaFailure("kind");
  }
  if (typeof fact.value !== "string") {
    throw viewSchemaFailure("value");
  }
  if (
    SUBJECT_REQUIRED_FACT_KINDS.includes(fact.kind) &&
    (typeof fact.subject !== "string" || fact.subject.length === 0)
  ) {
    throw viewSchemaFailure("subject");
  }
}

function sameConstraintBinding(
  versionBinding: VersionBinding | undefined,
  planBinding: VersionBinding
): boolean {
  if (versionBinding === undefined || versionBinding === null) {
    return false;
  }
  return (
    versionBinding.task_id === planBinding.task_id &&
    versionBinding.branch_id === planBinding.branch_id &&
    versionBinding.input_epoch === planBinding.input_epoch &&
    versionBinding.goal_version === planBinding.goal_version &&
    versionBinding.config_version === planBinding.config_version
  );
}

interface FactValueBase {
  schema_version: string;
}

interface CallFactValue extends FactValueBase {
  schema_version: "rsi.fact_value/call/1";
  tool: string;
  call_status: "ok" | "error" | "pending";
  pair_key: string;
}

interface ResultFactValue extends FactValueBase {
  schema_version: "rsi.fact_value/result/1";
  exit_code: number | null;
  truncated: boolean;
  pair_key: string;
}

interface DiffFactValue extends FactValueBase {
  schema_version: "rsi.fact_value/diff/1";
  before_version: string;
  after_version: string;
}

interface TestFactValue extends FactValueBase {
  schema_version: "rsi.fact_value/test/1";
  command: string;
  tested_snapshot: string;
  exit_code: number | null;
  assertions: Array<{ name: string; result: "pass" | "fail" | "unknown"; requirement_id: string }>;
  not_covered: string[];
}

interface MessageFactValue extends FactValueBase {
  schema_version: "rsi.fact_value/message/1";
  message_status: "claim" | "observed" | "verified" | "contradicted" | "unknown";
  origin: string;
}

interface CodeFactValue extends FactValueBase {
  schema_version: "rsi.fact_value/code/1";
  path: string;
  artifact_version: string;
}

interface ContractFactValue extends FactValueBase {
  schema_version: "rsi.fact_value/interface_contract/1";
  path: string;
  artifact_version: string;
}

type ParsedFactValue =
  | CallFactValue
  | ResultFactValue
  | DiffFactValue
  | TestFactValue
  | MessageFactValue
  | CodeFactValue
  | ContractFactValue;

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

/** Parses `fact_value` by kind (DD-QP-19). */
export function parseFactValue(kind: EvidenceFactKind, text: string): ParsedFactValue {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "plan", { fact_kind: kind, reason: "json" }));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "plan", { fact_kind: kind, reason: "shape" }));
  }
  const record = raw as Record<string, unknown>;
  const version = record["schema_version"];
  switch (kind) {
    case "call":
      if (
        version !== "rsi.fact_value/call/1" ||
        typeof record["tool"] !== "string" ||
        (record["call_status"] !== "ok" && record["call_status"] !== "error" && record["call_status"] !== "pending") ||
        typeof record["pair_key"] !== "string"
      ) {
        throw invalidFact(kind);
      }
      return {
        schema_version: "rsi.fact_value/call/1",
        tool: record["tool"],
        call_status: record["call_status"],
        pair_key: record["pair_key"]
      };
    case "result":
      if (
        version !== "rsi.fact_value/result/1" ||
        !isNumberOrNull(record["exit_code"]) ||
        typeof record["truncated"] !== "boolean" ||
        typeof record["pair_key"] !== "string"
      ) {
        throw invalidFact(kind);
      }
      return {
        schema_version: "rsi.fact_value/result/1",
        exit_code: record["exit_code"],
        truncated: record["truncated"],
        pair_key: record["pair_key"]
      };
    case "diff":
      if (
        version !== "rsi.fact_value/diff/1" ||
        typeof record["before_version"] !== "string" ||
        typeof record["after_version"] !== "string"
      ) {
        throw invalidFact(kind);
      }
      return {
        schema_version: "rsi.fact_value/diff/1",
        before_version: record["before_version"],
        after_version: record["after_version"]
      };
    case "test": {
      if (
        version !== "rsi.fact_value/test/1" ||
        typeof record["command"] !== "string" ||
        typeof record["tested_snapshot"] !== "string" ||
        !isNumberOrNull(record["exit_code"]) ||
        !Array.isArray(record["assertions"]) ||
        !Array.isArray(record["not_covered"])
      ) {
        throw invalidFact(kind);
      }
      const assertions: TestFactValue["assertions"] = [];
      for (const entry of record["assertions"]) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as Record<string, unknown>)["name"] !== "string" ||
          typeof (entry as Record<string, unknown>)["requirement_id"] !== "string" ||
          !isAssertionResult((entry as Record<string, unknown>)["result"])
        ) {
          throw invalidFact(kind);
        }
        assertions.push({
          name: (entry as Record<string, unknown>)["name"] as string,
          result: (entry as Record<string, unknown>)["result"] as "pass" | "fail" | "unknown",
          requirement_id: (entry as Record<string, unknown>)["requirement_id"] as string
        });
      }
      if (!record["not_covered"].every((entry) => typeof entry === "string")) {
        throw invalidFact(kind);
      }
      return {
        schema_version: "rsi.fact_value/test/1",
        command: record["command"],
        tested_snapshot: record["tested_snapshot"],
        exit_code: record["exit_code"],
        assertions: assertions.sort((left, right) => {
          const byName = compareUtf8(left.name, right.name);
          return byName !== 0 ? byName : compareUtf8(left.requirement_id, right.requirement_id);
        }),
        not_covered: sorted(record["not_covered"] as string[])
      };
    }
    case "message":
      if (version !== "rsi.fact_value/message/1" || typeof record["message_status"] !== "string" || typeof record["origin"] !== "string") {
        throw invalidFact(kind);
      }
      return {
        schema_version: "rsi.fact_value/message/1",
        message_status: record["message_status"] as MessageFactValue["message_status"],
        origin: record["origin"]
      };
    case "code":
      if (
        version !== "rsi.fact_value/code/1" ||
        typeof record["path"] !== "string" ||
        typeof record["artifact_version"] !== "string"
      ) {
        throw invalidFact(kind);
      }
      return {
        schema_version: "rsi.fact_value/code/1",
        path: record["path"],
        artifact_version: record["artifact_version"]
      };
    case "interface_contract":
      if (
        version !== "rsi.fact_value/interface_contract/1" ||
        typeof record["path"] !== "string" ||
        typeof record["artifact_version"] !== "string"
      ) {
        throw invalidFact(kind);
      }
      return {
        schema_version: "rsi.fact_value/interface_contract/1",
        path: record["path"],
        artifact_version: record["artifact_version"]
      };
  }
}

function isAssertionResult(value: unknown): value is "pass" | "fail" | "unknown" {
  return value === "pass" || value === "fail" || value === "unknown";
}

function invalidFact(kind: string): QpDomainError {
  return new QpDomainError(qpFailure("E_FACT_VALUE_INVALID", "plan", { fact_kind: kind }));
}

/** Maps an EVD excerpt failure onto the QP code table (DD-QP-10). */
export function mapExcerptFailure(code: string): QpDomainError {
  switch (code) {
    case "E_SOURCE_REF_INVALID":
    case "E_SOURCE_NOT_FOUND":
      return new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "excerpt"));
    case "E_SOURCE_OUT_OF_RANGE":
      return new QpDomainError(qpFailure("E_BYTE_RANGE_INVALID", "excerpt"));
    case "E_SOURCE_UTF8_INVALID":
      return new QpDomainError(qpFailure("E_SOURCE_UTF8_INVALID", "excerpt"));
    case "E_SOURCE_TOO_LARGE":
      return new QpDomainError(qpFailure("E_EXCERPT_EXCEEDS_LIMIT", "excerpt"));
    default:
      return new QpDomainError(qpFailure("E_SOURCE_UNRETRIEVABLE", "excerpt"));
  }
}

/** Reads one exact source ref from the snapshot, rejecting empty results. */
export function readExactBytes(snapshot: EvidenceIndexSnapshot, ref: SourceRef): Uint8Array {
  const result = snapshot.readExcerpt(ref, { kind: "exact" }, MAX_EXCERPT_BYTES);
  if (!result.ok) {
    throw mapExcerptFailure(result.code);
  }
  return result.bytes;
}

/** Content hash over an ordered ref set using the framed concatenation rule. */
export function hashSourceRefs(snapshot: EvidenceIndexSnapshot, refs: readonly SourceRef[]): Hash {
  const unique = sortedUniqueRefs(refs);
  const segments = unique.map((ref) => ({ source_ref: ref, bytes: readExactBytes(snapshot, ref) }));
  return sourceContentHash(segments);
}

function factVersionMatches(issue: Issue, fact: EvidenceFactView): boolean {
  const version = factArtifactVersion(fact);
  if (issue.artifact_versions.length === 0) {
    return true;
  }
  if (version === null) {
    return false;
  }
  const path = factSubject(fact);
  for (const entry of issue.artifact_versions) {
    if (path !== null && entry.path === path && entry.version === version) {
      return true;
    }
  }
  return issue.artifact_versions.some((entry) => entry.version === version);
}

interface Candidate {
  source: PlanSource;
  spec: RequiredSourceSpec;
  pair_key: string | null;
}

interface PlanBuildContext {
  issue: Issue;
  binding: VersionBinding;
  registry: QuestionTemplateRegistry;
  template: QuestionTemplate;
  snapshot: EvidenceIndexSnapshot;
  state_profile: "progress_issue" | "experience_review";
  planned_at: number;
  supersedes_plan_id?: string;
}

function sourceRole(spec: RequiredSourceSpec, kind: PlanSourceKind): SourceRole {
  if (spec.selector === "counterevidence") {
    return "counter";
  }
  if (spec.selector === "interface_contract") {
    return "definition";
  }
  if (spec.selector === "active_requirement" || spec.selector === "acceptance_criterion") {
    return "support";
  }
  if (kind === "message" || kind === "feedback" || kind === "coverage" || kind === "comparison") {
    return "context";
  }
  return "support";
}

function requirementSource(snapshot: EvidenceIndexSnapshot, requirement: RequirementView, spec: RequiredSourceSpec): PlanSource {
  const refs = sortedUniqueRefs([requirement.statement_ref, ...requirement.source_refs]).slice(0, MAX_SOURCE_REFS);
  return {
    source_id: `requirement:${requirement.requirement_id}`,
    kind: "requirement",
    source_refs: refs,
    content_hash: hashSourceRefs(snapshot, refs),
    version: null,
    subject: null,
    fact_kind: null,
    fact_value_hash: null,
    role: sourceRole(spec, "requirement"),
    retrievable: true,
    requirement_ids: [requirement.requirement_id]
  };
}

function factSource(snapshot: EvidenceIndexSnapshot, fact: EvidenceFactView, spec: RequiredSourceSpec): Candidate {
  const parsed = parseFactValue(fact.kind, fact.value);
  const refs = sortedUniqueRefs(fact.source_refs).slice(0, MAX_SOURCE_REFS);
  const kind: PlanSourceKind = fact.kind;
  const pairKey =
    parsed.schema_version === "rsi.fact_value/call/1" || parsed.schema_version === "rsi.fact_value/result/1"
      ? parsed.pair_key
      : null;
  return {
    source: {
      source_id: fact.kind === "interface_contract" ? `interface_contract:${contractId(fact)}` : `fact:${fact.fact_id}`,
      kind,
      source_refs: refs,
      content_hash: hashSourceRefs(snapshot, refs),
      version: factArtifactVersion(fact),
      subject: factSubject(fact),
      fact_kind: fact.kind,
      fact_value_hash: hashUtf8(fact.value),
      role: sourceRole(spec, kind),
      retrievable: true,
      requirement_ids: sortedUnique(factRequirementIds(fact))
    },
    spec,
    pair_key: pairKey
  };
}

function contractId(fact: EvidenceFactView): string {
  const subject = factSubject(fact) ?? "";
  return hashJson({
    schema_version: "rsi.contract_id/1",
    path: subject,
    artifact_version: factArtifactVersion(fact)
  }).slice("sha256:".length);
}

function coverageSource(snapshot: EvidenceIndexSnapshot, coverage: CoverageSnapshotView, spec: RequiredSourceSpec): PlanSource {
  const refs = sortedUniqueRefs(coverage.source_refs).slice(0, MAX_SOURCE_REFS);
  return {
    source_id: `view:coverage:${coverage.view_key}`,
    kind: "coverage",
    source_refs: refs,
    content_hash: hashSourceRefs(snapshot, refs),
    version: null,
    subject: null,
    fact_kind: null,
    fact_value_hash: null,
    role: sourceRole(spec, "coverage"),
    retrievable: true,
    requirement_ids: sortedUnique(coverage.checked_requirement_ids)
  };
}

function feedbackSource(snapshot: EvidenceIndexSnapshot, feedback: FeedbackView, spec: RequiredSourceSpec): PlanSource {
  const refs = sortedUniqueRefs(feedback.source_refs).slice(0, MAX_SOURCE_REFS);
  return {
    source_id: `feedback:${feedback.feedback_id}`,
    kind: "feedback",
    source_refs: refs,
    content_hash: hashSourceRefs(snapshot, refs),
    version: null,
    subject: null,
    fact_kind: null,
    fact_value_hash: null,
    role: sourceRole(spec, "feedback"),
    retrievable: true,
    requirement_ids: []
  };
}

function comparisonSource(snapshot: EvidenceIndexSnapshot, comparison: ComparisonView, spec: RequiredSourceSpec): PlanSource {
  const refs = sortedUniqueRefs([...comparison.before_source_refs, ...comparison.after_source_refs]).slice(
    0,
    MAX_SOURCE_REFS
  );
  return {
    source_id: `view:comparison:${comparison.view_key}`,
    kind: "comparison",
    source_refs: refs,
    content_hash: hashSourceRefs(snapshot, refs),
    version: null,
    subject: null,
    fact_kind: null,
    fact_value_hash: null,
    role: sourceRole(spec, "comparison"),
    retrievable: true,
    requirement_ids: []
  };
}

function taskConditionSource(
  snapshot: EvidenceIndexSnapshot,
  condition: TaskConditionView,
  spec: RequiredSourceSpec
): PlanSource {
  const refs = sortedUniqueRefs(condition.source_refs).slice(0, MAX_SOURCE_REFS);
  return {
    source_id: condition.logical_id,
    kind: "task_condition",
    source_refs: refs,
    content_hash: hashSourceRefs(snapshot, refs),
    version: null,
    subject: null,
    fact_kind: null,
    fact_value_hash: null,
    role: sourceRole(spec, "task_condition"),
    retrievable: true,
    requirement_ids: []
  };
}

function unverifiedSource(
  snapshot: EvidenceIndexSnapshot,
  constraint: UnverifiedConstraintView,
  _spec: RequiredSourceSpec
): PlanSource {
  const refs = sortedUniqueRefs(constraint.source_refs).slice(0, MAX_SOURCE_REFS);
  return {
    source_id: constraint.logical_id,
    kind: "unverified_constraint",
    source_refs: refs,
    content_hash: hashSourceRefs(snapshot, refs),
    version: null,
    subject: null,
    fact_kind: null,
    fact_value_hash: null,
    role: "context",
    retrievable: true,
    requirement_ids: []
  };
}

function experienceSource(snapshot: EvidenceIndexSnapshot, issue: Issue, spec: RequiredSourceSpec): PlanSource | null {
  const ref = issue.experience_ref;
  if (ref === undefined) {
    return null;
  }
  const candidate = snapshot
    .listExperienceCandidates({
      binding: issue.binding,
      review_snapshot_id: snapshot.review_snapshot_id ?? ""
    })
    .find((entry) => entry.candidate.experience_id === ref.experience_id && entry.candidate.version === ref.experience_version);
  const refs = sortedUniqueRefs(candidate?.source_refs ?? issue.source_refs).slice(0, MAX_SOURCE_REFS);
  return {
    source_id: `experience:${ref.experience_id}@${String(ref.experience_version)}`,
    kind: "experience",
    source_refs: refs,
    content_hash: hashSourceRefs(snapshot, refs),
    version: String(ref.experience_version),
    subject: null,
    fact_kind: null,
    fact_value_hash: null,
    role: sourceRole(spec, "experience"),
    retrievable: true,
    requirement_ids: []
  };
}

interface ResolvedCandidates {
  candidates: Candidate[];
  coverage: CoverageSnapshotView;
}

function resolveSpec(
  context: PlanBuildContext,
  spec: RequiredSourceSpec,
  requirementIds: readonly string[],
  acceptance?: QuestionSeed["acceptance"]
): ResolvedCandidates {
  const { snapshot, issue } = context;
  const coverage = snapshot.getCoverageSnapshot({ binding: issue.binding, watermark: context.binding.watermark });
  const requirements = snapshot.listRequirements({ binding: issue.binding, watermark: context.binding.watermark });
  const requirementById = new Map(requirements.map((requirement) => [requirement.requirement_id, requirement]));
  const facts = snapshot.listFacts({ binding: issue.binding, watermark: context.binding.watermark });
  const candidates: Candidate[] = [];
  const selector: SourceSelector = spec.selector;
  switch (selector) {
    case "active_requirement":
    case "acceptance_criterion": {
      for (const requirementId of sortedUnique(requirementIds)) {
        const requirement = requirementById.get(requirementId);
        if (requirement === undefined) {
          continue;
        }
        if (selector === "acceptance_criterion" && acceptance !== undefined) {
          const refs = sortedUniqueRefs(
            acceptance.source_ref === null
              ? [requirement.statement_ref, ...requirement.source_refs]
              : [acceptance.source_ref]
          ).slice(0, MAX_SOURCE_REFS);
          const distinct = acceptance.count > 1;
          candidates.push({
            source: {
              source_id: distinct
                ? `requirement:${requirementId}#a${String(acceptance.index)}`
                : `requirement:${requirementId}`,
              kind: "requirement",
              source_refs: refs,
              content_hash: hashSourceRefs(snapshot, refs),
              version: null,
              subject: null,
              fact_kind: null,
              fact_value_hash: null,
              role: sourceRole(spec, "requirement"),
              retrievable: true,
              requirement_ids: [requirementId]
            },
            spec,
            pair_key: null
          });
          continue;
        }
        candidates.push({ source: requirementSource(snapshot, requirement, spec), spec, pair_key: null });
      }
      break;
    }
    case "latest_input": {
      const ops = snapshot.listRequirementOps({
        binding: issue.binding,
        watermark: context.binding.watermark,
        statuses: ["applied", "proposed", "conflict"]
      });
      for (const op of sortUtf8(ops, (entry) => entry.op_id)) {
        if (op.status !== "applied" && op.status !== "proposed") {
          continue;
        }
        const requirementId = op.created_requirement_id ?? op.target_requirement_id;
        if (requirementId === null || !requirementIds.includes(requirementId)) {
          continue;
        }
        const requirement = requirementById.get(requirementId);
        if (requirement === undefined) {
          continue;
        }
        // The latest input is projected from the requirement op's quote by the
        // judge-state builder; it is not a second requirement source. Keeping
        // the same logical source id and refs as `active_requirement` lets the
        // dependency dedupe merge them (a suffixed id cannot be resolved back
        // to a requirement view and failed projection with
        // E_PROJECTION_SOURCE_MISSING).
        const refs = sortedUniqueRefs([
          requirement.statement_ref,
          ...requirement.source_refs
        ]).slice(0, MAX_SOURCE_REFS);
        candidates.push({
          source: {
            source_id: `requirement:${requirementId}`,
            kind: "requirement",
            source_refs: refs,
            content_hash: hashSourceRefs(snapshot, refs),
            version: null,
            subject: null,
            fact_kind: null,
            fact_value_hash: null,
            role: sourceRole(spec, "requirement"),
            retrievable: true,
            requirement_ids: [requirementId]
          },
          spec,
          pair_key: null
        });
      }
      if (candidates.length === 0) {
        for (const requirementId of sortedUnique(requirementIds)) {
          const requirement = requirementById.get(requirementId);
          if (requirement !== undefined) {
            candidates.push({ source: requirementSource(snapshot, requirement, spec), spec, pair_key: null });
          }
        }
      }
      break;
    }
    case "artifact_fact": {
      for (const fact of sortUtf8(facts, (entry) => entry.fact_id)) {
        if (fact.stale || !ARTIFACT_FACT_KINDS.includes(fact.kind)) {
          continue;
        }
        if (!factVersionMatches(issue, fact)) {
          continue;
        }
        candidates.push(factSource(snapshot, fact, spec));
      }
      break;
    }
    case "interface_contract": {
      for (const fact of sortUtf8(facts, (entry) => entry.fact_id)) {
        if (fact.stale || fact.kind !== "interface_contract") {
          continue;
        }
        const subject = factSubject(fact);
        if (subject !== null && issue.contract_paths.length > 0 && !issue.contract_paths.includes(subject)) {
          throw new QpDomainError(
            qpFailure("E_CONTRACT_PATH_MISMATCH", "plan", { path: subject })
          );
        }
        candidates.push(factSource(snapshot, fact, spec));
      }
      break;
    }
    case "verifier_result": {
      for (const fact of sortUtf8(facts, (entry) => entry.fact_id)) {
        if (fact.stale || fact.kind !== "test" || !factHasVerifier(fact)) {
          continue;
        }
        if (!factVersionMatches(issue, fact)) {
          continue;
        }
        candidates.push(factSource(snapshot, fact, spec));
      }
      break;
    }
    case "counterevidence": {
      for (const fact of sortUtf8(facts, (entry) => entry.fact_id)) {
        if (fact.stale) {
          continue;
        }
        if (fact.status !== "contradicted" && fact.kind === "message") {
          continue;
        }
        if (requirementIds.length > 0 && !factRequirementIds(fact).some((id) => requirementIds.includes(id))) {
          continue;
        }
        if (fact.status !== "contradicted" && fact.kind !== "test") {
          continue;
        }
        candidates.push(factSource(snapshot, fact, spec));
      }
      break;
    }
    case "counterevidence_search": {
      // The search record is mandatory even when nothing was found, but the
      // record itself must carry the searched range. An empty record is a
      // missing required source, never a fabricated empty search.
      if (coverage.source_refs.length > 0) {
        candidates.push({ source: coverageSource(snapshot, coverage, spec), spec, pair_key: null });
      }
      break;
    }
    case "baseline_checkpoint":
    case "current_checkpoint":
    case "pending_work": {
      const comparisons = snapshot.listComparisons({
        binding: issue.binding,
        watermark: context.binding.watermark
      });
      if (comparisons.length > 0) {
        const comparison = comparisons[0];
        if (comparison !== undefined) {
          candidates.push({ source: comparisonSource(snapshot, comparison, spec), spec, pair_key: null });
        }
      }
      break;
    }
    case "feedback": {
      const feedback = snapshot.listFeedback({ binding: issue.binding, watermark: context.binding.watermark });
      for (const entry of sortUtf8(feedback, (item) => item.feedback_id)) {
        if (entry.recorded_at_watermark > context.binding.watermark) {
          continue;
        }
        if (
          requirementIds.length > 0 &&
          entry.target_issue_id === null &&
          feedback.length > 1
        ) {
          continue;
        }
        candidates.push({ source: feedbackSource(snapshot, entry, spec), spec, pair_key: null });
      }
      break;
    }
    case "experience_candidate":
    case "experience_evidence": {
      const source = experienceSource(snapshot, issue, spec);
      if (source !== null) {
        candidates.push({ source, spec, pair_key: null });
      }
      break;
    }
    case "task_condition": {
      const conditions = snapshot.listTaskConditions({
        binding: issue.binding,
        watermark: context.binding.watermark
      });
      for (const condition of sortUtf8(conditions, (entry) => entry.logical_id)) {
        candidates.push({ source: taskConditionSource(snapshot, condition, spec), spec, pair_key: null });
      }
      break;
    }
    case "unverified_constraint": {
      // Unknown-origin constraints are context only: a template that routes
      // them into a requirement or verification slot is rejected before any
      // candidate is read.
      if (spec.view === "requirements" || /verifier|verification/iu.test(spec.role)) {
        throw new QpDomainError(
          qpFailure("E_CONFIRMATION_KIND_NOT_ALLOWED", "plan", { role: spec.role })
        );
      }
      const constraints = snapshot.listUnverifiedConstraints({
        binding: issue.binding,
        watermark: context.binding.watermark
      });
      for (const constraint of sortUtf8(constraints, (entry) => entry.logical_id)) {
        if (constraint.authorization !== false) {
          throw new QpDomainError(qpFailure("E_SCHEMA", "plan", { field: "authorization" }));
        }
        if (!UNVERIFIED_STATUSES.includes(constraint.status)) {
          throw new QpDomainError(qpFailure("E_SCHEMA", "plan", { field: "status" }));
        }
        // Out-of-scope rows are filtered, never coerced into the plan.
        if (!sameConstraintBinding(constraint.version_binding, context.binding)) {
          continue;
        }
        if (constraint.recorded_at_watermark > context.binding.watermark) {
          continue;
        }
        if (constraint.logical_id !== `unverified_constraint:${constraint.constraint_id}`) {
          continue;
        }
        candidates.push({ source: unverifiedSource(snapshot, constraint, spec), spec, pair_key: null });
      }
      break;
    }
  }
  return { candidates, coverage };
}

function transportRoleFor(spec: RequiredSourceSpec, source: PlanSource): TransportRole {
  if (spec.selector === "counterevidence") {
    return "counter";
  }
  if (source.kind === "requirement") {
    return "requirement";
  }
  if (source.kind === "feedback" || source.kind === "message") {
    return "feedback";
  }
  if (source.kind === "test" || source.fact_kind === "test") {
    return "verifier";
  }
  if (
    (source.kind === "fact" ||
      source.kind === "code" ||
      source.kind === "interface_contract" ||
      source.kind === "diff" ||
      source.kind === "call" ||
      source.kind === "result") &&
    source.requirement_ids.length > 0
  ) {
    return "artifact";
  }
  if (source.kind === "comparison") {
    return "history";
  }
  return "context";
}

function relationFor(spec: RequiredSourceSpec, source: PlanSource): EvidenceDependency["relation"] {
  if (spec.selector === "counterevidence") {
    return "counter";
  }
  if (source.kind === "interface_contract") {
    return "defines";
  }
  if (source.kind === "comparison" || source.kind === "coverage") {
    return "derived";
  }
  if (source.kind === "feedback" || source.kind === "message" || source.kind === "task_condition") {
    return "context";
  }
  return "supports";
}

function questionIdFor(context: PlanBuildContext, slot: string): string {
  const templatePrefix =
    context.template.template_id === "qt.intent_relation"
      ? "intent"
      : context.template.template_id === "qt.behavior_relation"
        ? "behavior"
        : context.template.template_id === "qt.step_effect"
          ? "step"
          : context.template.template_id === "qt.acceptance_relation"
            ? "acceptance"
            : "experience";
  const ulid = context.issue.issue_id.startsWith("issue:") ? context.issue.issue_id.slice("issue:".length) : context.issue.issue_id;
  return slot === "" ? `q.${templatePrefix}.${ulid}` : `q.${templatePrefix}.${ulid}.${slot}`;
}

interface QuestionSeed {
  slot: string;
  requirement_ids: string[];
  /** Acceptance item for `per_acceptance_item` templates. */
  acceptance?: {
    criterion: string;
    source_ref: SourceRef | null;
    index: number;
    count: number;
  };
}

function acceptanceItemsOf(
  requirement: RequirementView
): Array<{ criterion: string; source_ref: SourceRef | null }> {
  const acceptance: unknown = requirement.acceptance;
  if (Array.isArray(acceptance)) {
    return acceptance.map((entry) => {
      const item = entry as { text?: unknown; criterion?: unknown; source_ref?: unknown };
      const criterion =
        typeof item.text === "string"
          ? item.text
          : typeof item.criterion === "string"
            ? item.criterion
            : requirement.requirement_id;
      const sourceRef = typeof item.source_ref === "string" ? (item.source_ref as SourceRef) : null;
      return { criterion, source_ref: sourceRef };
    });
  }
  const single = acceptance as { criterion?: unknown; acceptance_ref_id?: unknown };
  return [
    {
      criterion: typeof single.criterion === "string" ? single.criterion : requirement.requirement_id,
      source_ref: typeof single.acceptance_ref_id === "string" ? (single.acceptance_ref_id as SourceRef) : null
    }
  ];
}

function seedsFor(context: PlanBuildContext): QuestionSeed[] {
  const requirements = sortedUnique(context.issue.requirement_ids);
  switch (context.template.cardinality) {
    case "per_issue":
      return [{ slot: "", requirement_ids: requirements }];
    case "per_requirement": {
      if (requirements.length === 0) {
        throw new QpDomainError(qpFailure("E_REQUIRED_SOURCE_MISSING", "plan", { role: "active_requirement" }));
      }
      return requirements.map((requirementId, index) => ({
        slot: String(index).padStart(2, "0"),
        requirement_ids: [requirementId]
      }));
    }
    case "per_acceptance_item": {
      if (requirements.length === 0) {
        throw new QpDomainError(qpFailure("E_REQUIRED_SOURCE_MISSING", "plan", { role: "acceptance_criterion" }));
      }
      const byId = new Map(
        context.snapshot
          .listRequirements({ binding: context.issue.binding, watermark: context.binding.watermark })
          .map((requirement) => [requirement.requirement_id, requirement])
      );
      const seeds: Array<{
        requirement_id: string;
        index: number;
        item: { criterion: string; source_ref: SourceRef | null; index: number; count: number };
      }> = [];
      for (const requirementId of requirements) {
        const requirement = byId.get(requirementId);
        const items =
          requirement === undefined
            ? [{ criterion: requirementId, source_ref: null }]
            : acceptanceItemsOf(requirement);
        items.forEach((item, index) => {
          seeds.push({
            requirement_id: requirementId,
            index,
            item: { ...item, index, count: items.length }
          });
        });
      }
      seeds.sort((left, right) => {
        const byRequirement = compareUtf8(left.requirement_id, right.requirement_id);
        return byRequirement !== 0 ? byRequirement : left.index - right.index;
      });
      return seeds.map((entry, index) => ({
        slot: String(index).padStart(2, "0"),
        requirement_ids: [entry.requirement_id],
        acceptance: entry.item
      }));
    }
    case "per_experience_candidate":
      return [{ slot: "", requirement_ids: requirements }];
  }
}

function dedupeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.source.source_id);
    if (existing === undefined) {
      byId.set(candidate.source.source_id, candidate);
      continue;
    }
    if (
      existing.source.content_hash !== candidate.source.content_hash ||
      existing.source.fact_value_hash !== candidate.source.fact_value_hash
    ) {
      throw new QpDomainError(
        qpFailure("E_SOURCE_CONFLICT", "plan", { source_id: candidate.source.source_id })
      );
    }
  }
  return [...byId.values()];
}

function capCandidates(candidates: Candidate[], spec: RequiredSourceSpec): Candidate[] {
  const ordered = sortUtf8(candidates, (candidate) => candidate.source.source_id);
  if (ordered.length <= spec.max_count) {
    return ordered;
  }
  if (spec.omission_impact === "answer_changing" || spec.selection === "all") {
    throw new QpDomainError(qpFailure("E_SOURCE_COUNT_EXCEEDED", "plan", { role: spec.role }));
  }
  return ordered.slice(0, spec.max_count);
}

function selectorRank(selector: SourceSelector): number {
  switch (selector) {
    case "active_requirement":
    case "acceptance_criterion":
    case "latest_input":
      return TRANSPORT_RANK.requirement;
    case "feedback":
      return TRANSPORT_RANK.feedback;
    case "artifact_fact":
    case "interface_contract":
      return TRANSPORT_RANK.artifact;
    case "verifier_result":
      return TRANSPORT_RANK.verifier;
    case "counterevidence":
      return TRANSPORT_RANK.counter;
    case "baseline_checkpoint":
    case "current_checkpoint":
    case "pending_work":
    case "experience_candidate":
    case "experience_evidence":
    case "task_condition":
    case "unverified_constraint":
      return TRANSPORT_RANK.context;
    case "counterevidence_search":
      return TRANSPORT_RANK.counter;
  }
}

function specSortKey(spec: RequiredSourceSpec): string {
  return `${String(selectorRank(spec.selector)).padStart(2, "0")}:${spec.role}`;
}

function optionEffects(template: QuestionTemplate): Record<string, "supports" | "contradicts" | "unknown"> {
  const effects: Record<string, "supports" | "contradicts" | "unknown"> = {};
  for (const entry of template.options) {
    effects[entry.key] = entry.mapping.option_effect;
  }
  return effects;
}

function criteriaOf(template: QuestionTemplate): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const entry of template.options) {
    criteria[entry.key] = entry.criteria;
  }
  return criteria;
}

function answerMapOf(template: QuestionTemplate): PlannedQuestion["answer_to_issue_map"] {
  const map: PlannedQuestion["answer_to_issue_map"] = {};
  for (const entry of template.options) {
    map[entry.key] = entry.mapping;
  }
  return map;
}

function buildQuestion(
  context: PlanBuildContext,
  seed: QuestionSeed,
  sourcesById: Map<string, PlanSource>
): { question: PlannedQuestion; dependencies: EvidenceDependency[] } {
  const template = context.template;
  const specs = [...template.required_sources].sort((left, right) => compareUtf8(specSortKey(left), specSortKey(right)));
  const selected: Candidate[] = [];
  const missingGaps: EvidenceGap[] = [];
  for (const spec of specs) {
    const conditionTrue =
      spec.required_if === undefined
        ? false
        : spec.required_if === "issue.contract_required"
          ? context.issue.contract_required
          : spec.required_if === "issue.has_completion_claim"
            ? hasCompletionClaim(context)
            : hasBaseline(context);
    const enforced = spec.presence === "required" || conditionTrue;
    const effectiveMin = conditionTrue ? Math.max(spec.min_count, 1) : spec.min_count;
    const { candidates } = resolveSpec(context, spec, seed.requirement_ids, seed.acceptance);
    const filtered = dedupeCandidates(candidates);
    if (filtered.length < effectiveMin && enforced) {
      // The planning result reports one gap per unresolved role; the role
      // itself is the stable code used by the caller's missing-source report.
      missingGaps.push({
        code: spec.role as EvidenceGap["code"],
        requirement_ids: sortedUnique(seed.requirement_ids),
        source_refs: [],
        affects_question_keys: []
      });
      continue;
    }
    for (const candidate of capCandidates(filtered, spec)) {
      selected.push(candidate);
      const existing = sourcesById.get(candidate.source.source_id);
      if (existing === undefined) {
        sourcesById.set(candidate.source.source_id, candidate.source);
      } else if (existing.content_hash !== candidate.source.content_hash) {
        throw new QpDomainError(qpFailure("E_SOURCE_CONFLICT", "plan", { source_id: candidate.source.source_id }));
      }
    }
  }
  if (missingGaps.length > 0) {
    throw new QpPlanBuildError(missingGaps);
  }
  const deduped = dedupeCandidates(selected);
  const requiredSourceIds = sortedUnique(deduped.map((candidate) => candidate.source.source_id));
  if (requiredSourceIds.length > MAX_REQUIRED_SOURCES_PER_QUESTION) {
    throw new QpDomainError(qpFailure("E_SOURCE_COUNT_EXCEEDED", "plan", { question_scope: "required_sources" }));
  }
  const selection = sourceSelection(requiredSourceIds, sourcesById);
  const propId = propositionId({
    proposition_family: template.proposition_family,
    issue_key: context.issue.issue_key,
    subject_key: context.issue.subject_key,
    requirement_ids: seed.requirement_ids,
    slot: seed.slot,
    experience_id: context.issue.experience_ref?.experience_id ?? null
  });
  const qKey = questionKey({
    issue_key: context.issue.issue_key,
    proposition_id: `propo:${propId}`,
    slot: seed.slot,
    template_id: template.template_id,
    template_version: template.template_version,
    template_hash: template.template_hash,
    requirement_ids: seed.requirement_ids,
    selection
  });
  const instructions = renderTemplate(template.instructions_template, {
    requirement_ids: seed.requirement_ids,
    artifact_paths: context.issue.artifact_paths,
    experience_id: context.issue.experience_ref?.experience_id ?? null,
    issue_type: context.issue.type
  });
  const question: PlannedQuestion = {
    schema_version: "rsi.judge_question/1",
    question_id: questionIdFor(context, seed.slot),
    question_key: qKey,
    slot: seed.slot,
    issue_id: context.issue.issue_id,
    issue_type: context.issue.type,
    question_type: "choice",
    template_id: template.template_id,
    template_version: template.template_version,
    template_hash: template.template_hash,
    instructions,
    criteria: criteriaOf(template),
    options: template.options.map((entry) => entry.key),
    required_views: sortedUnique(template.required_views),
    required_source_ids: requiredSourceIds,
    requirement_ids: sortedUnique(seed.requirement_ids),
    proposition_id: `propo:${propId}`,
    option_effects: optionEffects(template),
    answer_to_issue_map: answerMapOf(template),
    required_for_issue: true,
    independence: {
      answer_independent: true,
      state_profile: context.state_profile,
      shareable: template.required_views.every((view) => SHARED_VIEWS.includes(view))
    },
    output_reserve_tokens: template.output_reserve_tokens,
    wire_question: {
      type: "choice",
      // The wire body names the exact template version so an upgraded
      // template cannot reuse the previous request bytes.
      instructions: `${instructions}\n[template ${template.template_id}@${template.template_version}]`,
      criteria: criteriaOf(template)
    }
  };
  const dependencies = buildDependencies(question, deduped);
  return { question, dependencies };
}

function hasCompletionClaim(context: PlanBuildContext): boolean {
  const signals = context.snapshot.listProgressSignals({
    binding: context.issue.binding,
    from_watermark: context.snapshot.progress_from_watermark,
    to_watermark: context.binding.watermark
  });
  return signals.some((signal) => signal.status === "comparable" && signal.to_watermark === context.binding.watermark);
}

function hasBaseline(context: PlanBuildContext): boolean {
  return context.snapshot.listComparisons({
    binding: context.issue.binding,
    watermark: context.binding.watermark
  }).length > 0;
}

function buildDependencies(question: PlannedQuestion, candidates: readonly Candidate[]): EvidenceDependency[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key =
      candidate.pair_key === null
        ? `src:${candidate.source.source_id}`
        : `pair:${candidate.pair_key}`;
    const entries = groups.get(key);
    if (entries === undefined) {
      groups.set(key, [candidate]);
    } else {
      entries.push(candidate);
    }
  }
  const dependencies: EvidenceDependency[] = [];
  for (const entries of groups.values()) {
    const first = entries[0];
    if (first === undefined) {
      continue;
    }
    const sourceIds = sortedUnique(entries.map((entry) => entry.source.source_id));
    const sourceRefs = sortedUniqueRefs(entries.flatMap((entry) => entry.source.source_refs));
    const sourceById = new Map<string, PlanSource>(
      entries.map((entry) => [entry.source.source_id, entry.source])
    );
    const transportRole = transportRoleFor(first.spec, first.source);
    const relation = relationFor(first.spec, first.source);
    const key = dependencyKey({
      question_keys: [question.question_key],
      source_ids: sourceIds,
      transport_role: transportRole,
      relation
    });
    dependencies.push({
      dependency_key: key,
      question_keys: [question.question_key],
      role: first.spec.role,
      transport_role: transportRole,
      selection_rank: 0,
      source_ids: sourceIds,
      source_refs: sourceRefs,
      // DD-QP-19: JCS over content hashes in sorted `source_ids` order.
      content_hash: dependencyContentHash(
        sourceIds.map((sourceId) => (sourceById.get(sourceId) as PlanSource).content_hash)
      ),
      inseparable_group_key: key,
      relation,
      omission_impact: first.spec.omission_impact,
      can_omit: first.spec.omission_impact === "none",
      derived_view_key:
        first.source.kind === "comparison" || first.source.kind === "coverage" ? first.source.source_id : null
    });
  }
  return dependencies;
}

/** Builds a complete plan. The caller persists it through `putPlan`. */
export function buildQuestionPlan(context: PlanBuildContext): QuestionPlan {
  // Validate the whole fact view set before any selector runs: a malformed or
  // unknown kind rejects the entire plan instead of being skipped as unused.
  for (const fact of context.snapshot.listFacts({
    binding: context.issue.binding,
    watermark: context.binding.watermark
  })) {
    assertFactView(fact);
  }
  const seeds = seedsFor(context);
  if (seeds.length > MAX_QUESTIONS_PER_PLAN) {
    throw new QpDomainError(qpFailure("E_SOURCE_COUNT_EXCEEDED", "plan", { questions: seeds.length }));
  }
  const sourcesById = new Map<string, PlanSource>();
  const questions: PlannedQuestion[] = [];
  const dependencies: EvidenceDependency[] = [];
  for (const seed of seeds) {
    const built = buildQuestion(context, seed, sourcesById);
    questions.push(built.question);
    dependencies.push(...built.dependencies);
  }
  const sources = sortUtf8([...sourcesById.values()], (source) => source.source_id);
  if (sources.length > MAX_PLAN_SOURCES) {
    throw new QpDomainError(qpFailure("E_SOURCE_COUNT_EXCEEDED", "plan", { sources: sources.length }));
  }
  const orderedDependencies = sortUtf8(dependencies, (dependency) => {
    const primaryRef = dependency.source_refs[0] ?? "";
    return `${String(TRANSPORT_RANK[dependency.transport_role]).padStart(2, "0")}:${primaryRef}:${dependency.dependency_key}`;
  }).map((dependency, index) => ({ ...dependency, selection_rank: index }));
  const requiredSourceIds = sortedUnique(questions.flatMap((question) => question.required_source_ids));
  const requiredViews = sortedUnique(questions.flatMap((question) => question.required_views));
  const reserve = questions.reduce((total, question) => total + question.output_reserve_tokens, 0);
  const plan_id = newId("plan");
  const base: QuestionPlan = {
    schema_version: "rsi.question_plan/1",
    plan_id,
    plan_hash: "sha256:".padEnd(71, "0"),
    planner_version: "qp.planner/1",
    issue_id: context.issue.issue_id,
    issue_key: context.issue.issue_key,
    issue_type: context.issue.type,
    issue_version: context.issue.issue_version,
    binding: context.binding,
    state_profile: context.state_profile,
    registry_version: context.registry.registry_version,
    registry_hash: context.registry.registry_hash,
    artifact_paths: sortedUnique(context.issue.artifact_paths),
    sources,
    questions: [...questions].sort((left, right) => {
      const bySlot = compareUtf8(left.slot, right.slot);
      return bySlot !== 0 ? bySlot : compareUtf8(left.question_key, right.question_key);
    }),
    dependencies: orderedDependencies,
    required_source_ids: requiredSourceIds,
    required_views: requiredViews,
    aggregate_output_reserve_tokens: reserve,
    planned_at: context.planned_at
  };
  if (context.supersedes_plan_id !== undefined) {
    base.supersedes_plan_id = context.supersedes_plan_id;
  }
  const plan: QuestionPlan = { ...base, plan_hash: planHash(base) };
  assertPlanClosure(plan);
  return plan;
}

/** Verifies the required-source closure before a plan is persisted. */
export function assertPlanClosure(plan: QuestionPlan): void {
  const dependencySources = new Set<string>();
  for (const dependency of plan.dependencies) {
    for (const sourceId of dependency.source_ids) {
      dependencySources.add(sourceId);
    }
  }
  for (const question of plan.questions) {
    for (const sourceId of question.required_source_ids) {
      if (!dependencySources.has(sourceId)) {
        throw new QpDomainError(
          qpFailure("E_PLAN_CLOSURE_INCOMPLETE", "plan", { question_key: question.question_key, source_id: sourceId })
        );
      }
    }
  }
}

/** Initial `PlanStateDraft` for `putPlan` (DD-QP-20). */
export function initialPlanStateDraft(plan: QuestionPlan): {
  schema_version: "rsi.question_plan_state/1";
  plan_id: string;
  state_seq: 1;
  state: "active";
  reason_code: null;
  plan_hash: string;
  task_id: string;
  branch_id: string;
} {
  return {
    schema_version: "rsi.question_plan_state/1",
    plan_id: plan.plan_id,
    state_seq: 1,
    state: "active",
    reason_code: null,
    plan_hash: plan.plan_hash,
    task_id: plan.binding.task_id,
    branch_id: plan.binding.branch_id
  };
}

/** Planning idempotency key for `putPlan` (DD-QP-27a). */
export function buildPlanIdempotencyKey(plan: QuestionPlan): string {
  return planIdempotencyKey(plan.issue_key, plan.plan_hash);
}

/** Recomputes the plan content identity. */
export function recomputePlanHash(plan: QuestionPlan): Hash {
  return planHash(plan);
}
