/**
 * EvidencePack compiler (DD-EVD-006, DD-EVD-007, DD-EVD-008).
 *
 * Compilation is read-only with respect to the ledger: the frozen snapshot is
 * the only index source, excerpts are re-read through `readExcerpt`, and the
 * produced pack/unit identities are content-derived.
 */

import {
  err,
  hashBytes,
  newId,
  ok,
  parseVersionBinding,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type JsonValue,
  type Result,
  type SourceRef,
  type VersionBinding,
} from "@evoplug/core";

import { evdErr, evdForwarded, evdOk, evdError } from "./errors.js";
import { loadJudgeRequestContext, type EvidenceBindingReadPort } from "./binding-reader.js";
import { buildJudgeRequest } from "./judge-binding.js";
import { expandDependencyClosure } from "./dependency-closure.js";
import { planShardsForPlan } from "./shard-planner.js";
import { buildQuestionManifest } from "./manifest-builder.js";
import { estimateBudget, estimateSemanticBudget } from "./budget-estimator.js";
import {
  dependencyUnitKey,
  dependencyUnitHash,
  evidencePackEvidenceHash,
  evidencePackHash,
  evidencePackKey,
  jcsHash,
  sortUtf8Strings,
  textHash,
  utf8Length,
} from "./hashing.js";
import {
  MAX_EXCERPT_BYTES,
  SOURCE_MANIFEST_VERSION,
  type CompiledPack,
  type CoverageMissingEntry,
  type DependencyUnit,
  type DependencyUnitStateEvidence,
  type EvidenceDependency,
  type EvidencePack,
  type EvidencePackFact,
  type EvidencePackRequirement,
  type EvidenceCompiler,
  type EvdError,
  type IssueView,
  type JudgeRequestBindingV3,
  type JudgeStateManifest,
  type PackCompileInput,
  type PlanReadPort,
  type PlanSource,
  type PlannedQuestion,
  type QuestionPlan,
  type RunBudget,
  type SemanticBackendCapability,
} from "./types.js";

export interface EvidencePlanReadPort {
  readPlan(q: {
    plan_id: Id;
    plan_hash: Hash;
    binding: VersionBinding;
  }): Promise<Result<QuestionPlan, ErrorEnvelope>>;
}

export interface EvidenceIssueReadPort {
  getIssue(q: { issue_id: Id; binding: VersionBinding }): Promise<Result<IssueView, ErrorEnvelope>>;
}

export interface PackCompilerDeps {
  plans: EvidencePlanReadPort;
  /**
   * QP-owned lifecycle read port (`PlanReadPort.readPlanForAggregate`).
   * Production composition must supply it: the persisted plan never carries
   * `plan_state`. The compiler never fills that field into the plan.
   */
  plan_states?: PlanReadPort;
  issues: EvidenceIssueReadPort;
  /** UTC wall clock for recorded timestamps only. */
  now: () => number;
  /** Monotonic clock used for request deadline arithmetic. */
  monotonic_now: () => number;
  /**
   * Persisted-row read port for the DD-EVD-016A `/3` binding path. Optional so
   * existing compile/closure/shard callers keep compiling; `buildRequest`
   * fails closed when it is absent.
   */
  binding?: EvidenceBindingReadPort;
}

export type {
  EvidenceBindingReadPort,
  PersistedManifestRow,
  PersistedPackRow,
  PersistedShardPlanRow,
  PersistedShardRow,
} from "./binding-reader.js";

function mapPlanError(error: ErrorEnvelope, plan?: QuestionPlan): EvdError {
  if (error.code === "E_PLAN_CLOSURE_INCOMPLETE") {
    const keys = plan?.questions.map((question) => question.question_key) ?? [];
    return evdError("E_EVIDENCE_CLOSURE_INCOMPLETE", { missing_question_keys: keys });
  }
  return error as EvdError;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requirementIdsForQuestion(
  question: PlannedQuestion | undefined,
  dependency: EvidenceDependency
): string[] {
  if (question !== undefined) {
    return sortUtf8Strings(question.requirement_ids);
  }
  return [];
}

/**
 * A unit identifies the questions it serves by QP's stable cross-domain
 * `question_key`. That is the identity dependency closure, sharding and
 * omission all compare against; the local `question_id` is only a wire/manifest
 * join and remains in the pack's `question_ids`.
 */
function localQuestionKeys(
  dependency: EvidenceDependency,
  byKey: ReadonlyMap<string, PlannedQuestion>
): string[] | null {
  const keys: string[] = [];
  for (const key of dependency.question_keys) {
    if (!byKey.has(key)) {
      return null;
    }
    keys.push(key);
  }
  return sortUtf8Strings(keys);
}

type RefRead =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "invalid" }
  | { kind: "out_of_range" }
  | { kind: "unretrievable" };

/**
 * One read per `source_ref` per compile. The declared-source pre-pass and the
 * dependency loop share the cache so a frozen source is resolved exactly once.
 */
function readRefBytes(
  snapshot: PackCompileInput["snapshot"],
  ref: SourceRef,
  cache: Map<SourceRef, Uint8Array | null>
): RefRead {
  const cached = cache.get(ref);
  if (cached !== undefined) {
    return cached === null ? { kind: "unretrievable" } : { kind: "ok", bytes: cached };
  }
  const parsed = parseRefSyntax(ref);
  if (parsed === null) {
    return { kind: "invalid" };
  }
  const excerpt = snapshot.readExcerpt(ref, { kind: "exact" }, MAX_EXCERPT_BYTES);
  if (!excerpt.ok) {
    cache.set(ref, null);
    return { kind: "unretrievable" };
  }
  // `readExcerpt` already returns the bytes for this ref's byte range (the
  // production snapshot freezes a range-limited record per ref). Slicing
  // again would drop the prefix of every ref whose `start` is non-zero.
  if (excerpt.bytes.length !== parsed.end - parsed.start) {
    return { kind: "out_of_range" };
  }
  const bytes = excerpt.bytes;
  cache.set(ref, bytes);
  return { kind: "ok", bytes };
}

/** DD-QP-19 framed hash over sorted refs: `uint32be(len) || bytes`. */
function framedContentHash(
  segments: ReadonlyArray<{ source_ref: string; bytes: Uint8Array }>
): Hash {
  const ordered = [...segments].sort((left, right) =>
    left.source_ref < right.source_ref ? -1 : left.source_ref > right.source_ref ? 1 : 0
  );
  let total = 0;
  for (const segment of ordered) {
    total += 4 + segment.bytes.length;
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const segment of ordered) {
    const length = segment.bytes.length;
    buffer[offset] = (length >>> 24) & 0xff;
    buffer[offset + 1] = (length >>> 16) & 0xff;
    buffer[offset + 2] = (length >>> 8) & 0xff;
    buffer[offset + 3] = length & 0xff;
    offset += 4;
    buffer.set(segment.bytes, offset);
    offset += length;
  }
  return hashBytes(buffer);
}

/**
 * Reads the QP lifecycle. The persisted plan has no `plan_state`; the
 * independent `PlanReadPort` is authoritative. `null` means no state source
 * is wired, which callers turn into their local fail-closed code.
 */
async function readPlanLifecycle(
  deps: PackCompilerDeps,
  q: { plan_id: Id; plan_hash: Hash; binding: VersionBinding },
  plan: QuestionPlan
): Promise<Result<QuestionPlan["plan_state"] | null, EvdError>> {
  if (deps.plan_states !== undefined) {
    const result = await deps.plan_states.readPlanForAggregate({
      plan_id: q.plan_id,
      expected_plan_hash: q.plan_hash,
      binding: q.binding,
    });
    if (!result.ok) {
      return err(result.error as EvdError);
    }
    return ok(result.value.plan_state);
  }
  return ok(plan.plan_state ?? null);
}

export interface PackCompileResult {
  compiled: CompiledPack;
}

const SOURCE_REF_SYNTAX =
  /^(journal|blob):\/\/([^#]+)#bytes=(0|[1-9][0-9]{0,15})-(0|[1-9][0-9]{0,15})$/;
const BLOB_LOCATOR = /^sha256:[0-9a-f]{64}$/;

interface ParsedRef {
  scheme: "journal" | "blob";
  locator: string;
  start: number;
  end: number;
}

/**
 * DD-EVD-006 step 1: ref syntax and the half-open range shape are validated
 * before any content read. Journal locators stay opaque to EVD (the kernel
 * owns their id grammar); blob locators must be a full sha256 hash.
 */
function parseRefSyntax(ref: string): ParsedRef | null {
  const match = SOURCE_REF_SYNTAX.exec(ref);
  if (match === null) {
    return null;
  }
  const scheme = match[1] as "journal" | "blob";
  const locator = match[2] ?? "";
  const start = Number(match[3]);
  const end = Number(match[4]);
  if (locator.length === 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return null;
  }
  if (start >= end) {
    return null;
  }
  if (scheme === "blob" && !BLOB_LOCATOR.test(locator)) {
    return null;
  }
  return { scheme, locator, start, end };
}

export async function compileEvidencePack(
  deps: PackCompilerDeps,
  input: PackCompileInput
): Promise<Result<CompiledPack, EvdError>> {
  if (input.schema_version !== "rsi.pack_compile_input/1") {
    return evdErr("E_EVIDENCE_PACK_V1_READ_ONLY", { schema_version: String(input.schema_version) });
  }
  if (
    input.snapshot.binding.task_id !== input.binding.task_id ||
    input.snapshot.binding.branch_id !== input.binding.branch_id ||
    input.snapshot.binding.input_epoch !== input.binding.input_epoch ||
    input.snapshot.binding.goal_version !== input.binding.goal_version ||
    input.snapshot.binding.config_version !== input.binding.config_version ||
    input.snapshot.binding.watermark !== input.binding.watermark
  ) {
    return evdForwarded("E_VERSION_BINDING", { field: "snapshot.binding" });
  }
  const planResult = await deps.plans.readPlan({
    plan_id: input.plan_id,
    plan_hash: input.plan_hash,
    binding: input.binding,
  });
  if (!planResult.ok) {
    return err(mapPlanError(planResult.error));
  }
  const plan = planResult.value;
  if (plan.plan_hash !== input.plan_hash) {
    return evdForwarded("E_VERSION_BINDING", { field: "plan_hash" });
  }
  const lifecycle = await readPlanLifecycle(
    deps,
    { plan_id: input.plan_id, plan_hash: input.plan_hash, binding: input.binding },
    plan
  );
  if (!lifecycle.ok) {
    return err(lifecycle.error);
  }
  if (lifecycle.value !== "active") {
    return evdErr("E_EVIDENCE_PACK_STALE", {
      pack_hash: input.plan_hash,
      binding: input.binding,
    });
  }
  // DD-QP-19: every dependency source must be frozen in `plan.sources`.
  // An absent or empty list is not a licence to skip verification; missing
  // ids fail closed below exactly like a changed source.
  //
  // DD 8397: `source_id` is the logical source identity. A repeated id is the
  // same logical source: a second declaration with equal frozen content is
  // redundant and keeps the first provenance, while different frozen content
  // is a conflict. Distinct refs inside one source are ordinary provenance,
  // not a conflict.
  const declaredSources = new Map<string, PlanSource>();
  for (const source of plan.sources ?? []) {
    const prior = declaredSources.get(source.source_id);
    if (prior === undefined) {
      declaredSources.set(source.source_id, {
        ...source,
        source_refs: sortUtf8Strings(source.source_refs) as SourceRef[],
      });
      continue;
    }
    if (prior.content_hash !== source.content_hash) {
      return evdForwarded("E_SOURCE_CONFLICT", {
        source_id: source.source_id,
        expected: prior.content_hash,
        actual: source.content_hash,
      });
    }
  }
  const refCache = new Map<SourceRef, Uint8Array | null>();
  {
    // DD-QP-19 frames all refs of one PlanSource; a single-ref source is not
    // the byte hash of that ref. Verify the frozen value over the whole set
    // before any unit is built, so a changed source never yields a partial
    // pack. Unretrievable refs stay in the missing path below.
    for (const source of declaredSources.values()) {
      const segments: Array<{ source_ref: string; bytes: Uint8Array }> = [];
      let readable = true;
      for (const ref of sortUtf8Strings(source.source_refs)) {
        const read = readRefBytes(input.snapshot, ref as SourceRef, refCache);
        if (read.kind !== "ok") {
          readable = false;
          break;
        }
        segments.push({ source_ref: ref, bytes: read.bytes });
      }
      if (!readable) {
        continue;
      }
      const actual = framedContentHash(segments);
      if (source.content_hash !== actual) {
        return evdForwarded("E_SOURCE_CHANGED", {
          source_id: source.source_id,
          expected: source.content_hash,
          actual,
        });
      }
    }
    for (const dependency of plan.dependencies) {
      for (const sourceId of dependency.source_ids) {
        if (!declaredSources.has(sourceId)) {
          return evdForwarded("E_SOURCE_CHANGED", { source_id: sourceId });
        }
      }
      // DD-QP-19: dependency hash is JCS over content hashes in sorted
      // `source_ids` order. Missing sources already failed above instead of
      // being skipped.
      const expected = jcsHash(
        sortUtf8Strings(dependency.source_ids).map(
          (sourceId) => (declaredSources.get(sourceId) as PlanSource).content_hash
        )
      );
      if (dependency.content_hash !== expected) {
        return evdForwarded("E_SOURCE_CHANGED", {
          source_id: dependency.source_ids[0] ?? dependency.dependency_key,
          expected,
          actual: dependency.content_hash,
        });
      }
    }
  }
  const issueResult = await deps.issues.getIssue({
    issue_id: input.issue_id,
    binding: input.binding,
  });
  if (!issueResult.ok) {
    return err(issueResult.error as EvdError);
  }
  const issue = issueResult.value;
  if (issue.issue_key !== input.issue_key) {
    return evdForwarded("E_VERSION_BINDING", { field: "issue_key" });
  }
  const byQuestionKey = new Map(plan.questions.map((question) => [question.question_key, question]));

  for (const question of plan.questions) {
    if (typeof question.required_for_issue !== "boolean") {
      return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", {
        missing_question_keys: [question.question_key],
      });
    }
  }
  for (const question of plan.questions) {
    if (!question.required_for_issue) {
      continue;
    }
    const declared = new Set<string>();
    for (const dependency of plan.dependencies) {
      if (dependency.question_keys.includes(question.question_key)) {
        for (const sourceId of dependency.source_ids) {
          declared.add(sourceId);
        }
      }
    }
    const missing = question.required_source_ids.filter((sourceId) => !declared.has(sourceId));
    if (missing.length > 0) {
      return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", {
        missing_question_keys: [question.question_key],
      });
    }
  }
  const totalReserve = plan.questions.reduce(
    (sum, question) => sum + question.output_reserve_tokens,
    0
  );
  if (totalReserve > plan.aggregate_output_reserve_tokens) {
    return evdErr("E_BUDGET_RESERVE_INCONSISTENT", {
      aggregate_output_reserve_tokens: plan.aggregate_output_reserve_tokens,
    });
  }

  const requirements: EvidencePackRequirement[] = [];
  const facts: EvidencePackFact[] = [];
  const missing: CoverageMissingEntry[] = [];
  const omittedRefs = new Set<SourceRef>();
  const factByKey = new Map<string, EvidencePackFact>();
  let feedbackEntry: EvidencePack["feedback"] | undefined;
  const sourceContent = new Map<string, Hash>();
  const requirementById = new Map(
    input.snapshot
      .listRequirements({
        binding: input.binding,
        watermark: input.binding.watermark,
      })
      .map((requirement) => [requirement.requirement_id, requirement])
  );
  const units: DependencyUnit[] = [];
  let inputTokens = 0;

  const unretrievableQuestions: string[] = [];

  for (const dependency of [...plan.dependencies].sort((a, b) =>
    a.dependency_key < b.dependency_key ? -1 : a.dependency_key > b.dependency_key ? 1 : 0
  )) {
    const stateEvidence: DependencyUnitStateEvidence[] = [];
    const questionKeys = sortUtf8Strings(dependency.question_keys);
    const localIds = localQuestionKeys(dependency, byQuestionKey);
    if (localIds === null) {
      return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", {
        missing_question_keys: questionKeys,
      });
    }
    const dependencyRefs = sortUtf8Strings([...new Set<string>(dependency.source_refs)]) as SourceRef[];
    const memberSources = sortUtf8Strings([...new Set<string>(dependency.source_ids)]).map(
      (sourceId) => declaredSources.get(sourceId) as PlanSource
    );

    // DD 8156/8397: a source is the frozen unit, not one ref. Every ref a
    // dependency lists must be declared by one of its `source_ids`, and it
    // must list every ref of each member source. Otherwise the pack would
    // either import undeclared bytes or silently drop part of a logical
    // source; neither is an excerpt the compiler may invent.
    const ownerByRef = new Map<string, string>();
    for (const source of memberSources) {
      for (const ref of source.source_refs) {
        if (!ownerByRef.has(ref)) {
          ownerByRef.set(ref, source.source_id);
        }
      }
    }
    const unownedRef = dependencyRefs.find((ref) => !ownerByRef.has(ref));
    if (unownedRef !== undefined) {
      return evdForwarded("E_SOURCE_CHANGED", {
        source_id: memberSources[0]?.source_id ?? dependency.dependency_key,
        source_ref: unownedRef,
      });
    }
    const missingMemberRef = [...ownerByRef.keys()].find(
      (ref) => !dependencyRefs.includes(ref as SourceRef)
    );
    if (missingMemberRef !== undefined) {
      return evdErr("E_EVIDENCE_INSEPARABLE_SPLIT", {
        inseparable_group_key: dependency.inseparable_group_key,
      });
    }

    // DD-EVD-006 step 1: syntax and range shape fail the whole pack before
    // any content is read or any closure/missing record is produced.
    for (const ref of dependencyRefs) {
      if (parseRefSyntax(ref) === null) {
        return evdForwarded("E_SOURCE_REF_INVALID", { source_ref: ref });
      }
    }

    const refContent = new Map<SourceRef, { hash: Hash; text: string }>();

    for (const ref of dependencyRefs) {
      const read = readRefBytes(input.snapshot, ref, refCache);
      const sourceId = ownerByRef.get(ref) ?? dependency.dependency_key;
      if (read.kind === "invalid") {
        return evdForwarded("E_SOURCE_REF_INVALID", { source_ref: ref });
      }
      if (read.kind === "out_of_range") {
        return evdForwarded("E_SOURCE_OUT_OF_RANGE", { source_ref: ref });
      }
      if (read.kind === "unretrievable") {
        omittedRefs.add(ref);
        missing.push({
          source_refs: [ref],
          source_id: sourceId,
          reason: "unretrievable",
          affects_question_ids: localIds,
          recoverable: false,
        });
        if (
          dependency.omission_impact === "answer_changing" ||
          dependency.transport_role === "counter"
        ) {
          for (const questionKey of questionKeys) {
            const question = byQuestionKey.get(questionKey);
            if (question?.required_for_issue === true) {
              unretrievableQuestions.push(questionKey);
            }
          }
        }
        continue;
      }
      let excerptText: string;
      try {
        excerptText = decode(read.bytes);
      } catch {
        return evdForwarded("E_SOURCE_UTF8_INVALID", { source_ref: ref });
      }
      refContent.set(ref, { hash: hashBytes(read.bytes), text: excerptText });
    }

    // QP projection (DD 8113/8151): a requirement source quotes its exact
    // `statement_ref`; every other source quotes its first sorted ref. The
    // canonical excerpt is one ref's bytes, never a concatenation of refs.
    // Full `source_refs` provenance stays on the unit, pack and manifest.
    for (const [index, source] of memberSources.entries()) {
      let canonicalRef: SourceRef | undefined;
      if (source.kind === "requirement") {
        for (const requirementId of source.requirement_ids) {
          const requirement = requirementById.get(requirementId);
          if (
            requirement !== undefined &&
            source.source_refs.includes(requirement.statement_ref)
          ) {
            canonicalRef = requirement.statement_ref;
            break;
          }
        }
      }
      canonicalRef ??= source.source_refs[0];
      if (canonicalRef === undefined) {
        continue;
      }
      const content = refContent.get(canonicalRef);
      if (content === undefined) {
        continue;
      }
      const previous = sourceContent.get(source.source_id);
      if (previous !== undefined && previous !== content.hash) {
        return evdForwarded("E_SOURCE_CONFLICT", {
          source_id: source.source_id,
          expected: previous,
          actual: content.hash,
        });
      }
      sourceContent.set(source.source_id, content.hash);
      const logicalId =
        dependency.derived_view_key !== null
          ? `${dependency.derived_view_key}:${index}`
          : source.source_id;
      stateEvidence.push({
        logical_id: logicalId,
        source_ids: [source.source_id],
        source_refs: sortUtf8Strings(source.source_refs) as SourceRef[],
        content_hash: content.hash,
        text_hash: textHash(content.text),
        excerpt_hash: textHash(content.text),
        ...(dependency.artifact_version !== undefined
          ? { artifact_version: dependency.artifact_version }
          : {}),
        excerpt: content.text,
      });
      inputTokens += utf8Length(content.text);
    }

    for (const evidence of stateEvidence) {
      const sourceId = evidence.source_ids[0] as string;
      if (dependency.transport_role === "requirement") {
        requirements.push({
          id: sourceId,
          quote: evidence.excerpt,
          source_refs: evidence.source_refs,
          source_id: sourceId,
        });
      } else if (dependency.transport_role === "feedback") {
        requirements.push({
          id: sourceId,
          quote: evidence.excerpt,
          source_refs: evidence.source_refs,
          source_id: sourceId,
        });
        if (feedbackEntry === undefined) {
          feedbackEntry = {
            quote: evidence.excerpt,
            source_refs: evidence.source_refs,
            source_id: sourceId,
          };
        }
      } else {
        const role: EvidencePackFact["role"] =
          dependency.relation === "counter"
            ? "counter"
            : dependency.relation === "context"
              ? "context"
              : "support";
        const kind: EvidencePackFact["kind"] = "message";
        const factKeyId = `${sourceId}|${evidence.content_hash}`;
        const existing = factByKey.get(factKeyId);
        if (existing !== undefined) {
          existing.source_refs = sortUtf8Strings([
            ...existing.source_refs,
            ...evidence.source_refs,
          ]) as SourceRef[];
        } else {
          factByKey.set(factKeyId, {
            id: sourceId,
            source_id: sourceId,
            kind,
            role,
            excerpt: evidence.excerpt,
            content_hash: evidence.content_hash,
            source_refs: sortUtf8Strings(evidence.source_refs) as SourceRef[],
            retrievable: true,
          });
        }
      }
    }

    const unitKey = dependencyUnitKey({
      plan_hash: plan.plan_hash,
      dependency_key: dependency.dependency_key,
      inseparable_group_key: dependency.inseparable_group_key,
      role: dependency.role,
      transport_role: dependency.transport_role,
      source_ids: dependency.source_ids,
      source_refs: dependency.source_refs,
      omission_impact: dependency.omission_impact,
      can_omit: dependency.can_omit,
      ...(dependency.artifact_version !== undefined
        ? { artifact_version: dependency.artifact_version }
        : {}),
      ...(dependency.derived_view_key !== null
        ? { derived_view_key: dependency.derived_view_key }
        : {}),
    });
    const estimated = stateEvidence.reduce((sum, entry) => sum + utf8Length(entry.excerpt), 0);
    const unit: DependencyUnit = {
      schema_version: "rsi.dependency_unit/1",
      unit_id: newId("unit"),
      unit_key: unitKey,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      pack_id: newId("pack"),
      dependency_key: dependency.dependency_key,
      inseparable_group_key: dependency.inseparable_group_key,
      question_ids: localIds,
      role: dependency.role,
      transport_role: dependency.transport_role,
      relation: dependency.relation,
      source_ids: sortUtf8Strings(dependency.source_ids),
      source_refs: sortUtf8Strings(dependency.source_refs) as SourceRef[],
      ...(dependency.artifact_version !== undefined
        ? { artifact_version: dependency.artifact_version }
        : {}),
      selection_rank: dependency.selection_rank,
      omission_impact: dependency.omission_impact,
      can_omit: dependency.can_omit,
      state_evidence: stateEvidence,
      estimated_tokens: estimated,
      unit_hash: dependencyUnitHash({
        unit_key: unitKey,
        state_evidence: stateEvidence,
        estimated_tokens: estimated,
      }),
    };
    if (dependency.derived_view_key !== null) {
      unit.derived_view_key = dependency.derived_view_key;
    }
    units.push(unit);
  }

  if (unretrievableQuestions.length > 0) {
    return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", {
      missing_question_keys: sortUtf8Strings(unretrievableQuestions),
    });
  }

  facts.push(...factByKey.values());
  facts.sort((a, b) => {
    const aRefs = JSON.stringify(sortUtf8Strings(a.source_refs));
    const bRefs = JSON.stringify(sortUtf8Strings(b.source_refs));
    if (aRefs !== bRefs) {
      return aRefs < bRefs ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  requirements.sort((a, b) => {
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    const aRefs = JSON.stringify(sortUtf8Strings(a.source_refs));
    const bRefs = JSON.stringify(sortUtf8Strings(b.source_refs));
    return aRefs < bRefs ? -1 : aRefs > bRefs ? 1 : 0;
  });

  const checkedRequirementIds = sortUtf8Strings(
    input.snapshot
      .listRequirements({
        binding: input.binding,
        watermark: input.binding.watermark,
        statuses: ["active"],
      })
      .map((requirement) => requirement.requirement_id)
  );
  const searchedSources = sortUtf8Strings([
    ...requirements.map((row) => `requirement:${row.id}`),
    ...facts.map((row) => `fact:${row.id}`),
  ]);
  const coverage = {
    checked_requirement_ids: checkedRequirementIds,
    searched_sources: searchedSources,
    omitted_refs: sortUtf8Strings([...omittedRefs]),
    missing,
  };
  const evidenceHash = evidencePackEvidenceHash({
    plan_hash: plan.plan_hash,
    question_keys: plan.questions.map((question) => question.question_key),
    issue_key: input.issue_key,
    issue_question: issue.question,
    issue_requirement_ids: issue.requirement_ids,
    issue_type: issue.issue_type,
    requirements,
    feedback: null,
    facts: facts.map((fact) => ({
      id: fact.id,
      source_id: fact.source_id,
      kind: fact.kind,
      role: fact.role,
      excerpt: fact.excerpt,
      content_hash: fact.content_hash,
      source_refs: fact.source_refs,
      ...(fact.version !== undefined ? { version: fact.version } : {}),
    })),
    coverage: {
      checked_requirement_ids: coverage.checked_requirement_ids,
      searched_sources: coverage.searched_sources,
      omitted_refs: coverage.omitted_refs,
      missing: missing.map((entry) => ({
        ...(entry.source_refs !== undefined ? { source_refs: entry.source_refs } : {}),
        ...(entry.source_id !== undefined ? { source_id: entry.source_id } : {}),
        reason: entry.reason,
        affects_question_keys: sortUtf8Strings(entry.affects_question_ids),
        recoverable: entry.recoverable,
      })),
    },
  });
  const packHash = evidencePackHash({
    plan_hash: plan.plan_hash,
    question_keys: plan.questions.map((question) => question.question_key),
    compiler_version: input.compiler_version,
    counting_method_version: input.counting_method_version,
    source_manifest_version: SOURCE_MANIFEST_VERSION,
    issue_key: input.issue_key,
    binding: input.binding,
    evidence_hash: evidenceHash,
  });
  const packKey = evidencePackKey({
    pack_hash: packHash,
    plan_hash: plan.plan_hash,
    question_keys: plan.questions.map((question) => question.question_key),
    source_manifest_version: SOURCE_MANIFEST_VERSION,
    compiler_version: input.compiler_version,
    counting_method_version: input.counting_method_version,
  });
  const now = deps.now();
  const pack: EvidencePack = {
    schema_version: "rsi.evidence_pack/2",
    pack_id: newId("pack"),
    pack_key: packKey,
    compiler_version: input.compiler_version,
    counting_method_version: input.counting_method_version,
    source_manifest_version: SOURCE_MANIFEST_VERSION,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    issue_id: issue.issue_id,
    issue_key: issue.issue_key,
    issue: {
      question: issue.question,
      requirement_ids: sortUtf8Strings(issue.requirement_ids),
      issue_type: issue.issue_type,
    },
    question_ids: sortUtf8Strings(plan.questions.map((question) => question.question_id)),
    question_keys: sortUtf8Strings(plan.questions.map((question) => question.question_key)),
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    input_epoch: input.binding.input_epoch,
    goal_version: input.binding.goal_version,
    config_version: input.binding.config_version,
    watermark: input.binding.watermark,
    requirements,
    ...(feedbackEntry !== undefined ? { feedback: feedbackEntry } : {}),
    facts,
    coverage,
    budget: {
      input_tokens: inputTokens,
      output_reserve: totalReserve,
      deadline_ms: input.limits.deadline_ms,
    },
    evidence_hash: evidenceHash,
    pack_hash: packHash,
    pack_state: "valid",
    created_at: now,
  };
  for (const unit of units) {
    unit.pack_id = pack.pack_id;
  }
  units.sort((a, b) => (a.unit_key < b.unit_key ? -1 : 1));
  const manifests = plan.questions
    .map((question) => buildQuestionManifest(plan, question, units, pack.pack_key, now))
    .sort((a, b) => (a.shard_key < b.shard_key ? -1 : a.shard_key > b.shard_key ? 1 : 0));
  return ok({
    schema_version: "rsi.compiled_pack/1",
    pack,
    units,
    manifests,
  });
}

function planBindingMatches(persisted: VersionBinding, runtime: VersionBinding): boolean {
  return (
    persisted.task_id === runtime.task_id &&
    persisted.branch_id === runtime.branch_id &&
    persisted.input_epoch === runtime.input_epoch &&
    persisted.goal_version === runtime.goal_version &&
    persisted.config_version === runtime.config_version
  );
}

function validatePlanClosure(plan: QuestionPlan): EvdError | null {
  for (const question of plan.questions) {
    if (typeof question.required_for_issue !== "boolean") {
      return evdError("E_EVIDENCE_CLOSURE_INCOMPLETE", {
        missing_question_keys: [question.question_key],
      });
    }
  }
  for (const question of plan.questions) {
    if (!question.required_for_issue) {
      continue;
    }
    const declared = new Set<string>();
    for (const dependency of plan.dependencies) {
      if (dependency.question_keys.includes(question.question_key)) {
        for (const sourceId of dependency.source_ids) {
          declared.add(sourceId);
        }
      }
    }
    if (question.required_source_ids.some((sourceId) => !declared.has(sourceId))) {
      return evdError("E_EVIDENCE_CLOSURE_INCOMPLETE", {
        missing_question_keys: [question.question_key],
      });
    }
  }
  const totalReserve = plan.questions.reduce(
    (sum, question) => sum + question.output_reserve_tokens,
    0
  );
  if (totalReserve > plan.aggregate_output_reserve_tokens) {
    return evdError("E_BUDGET_RESERVE_INCONSISTENT", {
      aggregate_output_reserve_tokens: plan.aggregate_output_reserve_tokens,
    });
  }
  return null;
}

function validateRunBudgetShape(budget: RunBudget): EvdError | null {
  for (const field of ["request_max_tokens", "question_max_tokens"] as const) {
    const value = budget[field];
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
      return evdError("E_EVIDENCE_LIMITS_UNKNOWN", { field });
    }
  }
  for (const field of ["request_margin_tokens", "question_margin_tokens"] as const) {
    const value = budget[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      return evdError("E_EVIDENCE_LIMITS_UNKNOWN", { field });
    }
  }
  if (!Number.isSafeInteger(budget.max_attempts) || budget.max_attempts < 1) {
    return evdError("E_EVIDENCE_LIMITS_UNKNOWN", { field: "max_attempts" });
  }
  if (
    !Number.isSafeInteger(budget.deadline_ms) ||
    budget.deadline_ms < 1 ||
    budget.deadline_ms > 86_400_000
  ) {
    return evdError("E_EVIDENCE_LIMITS_UNKNOWN", { field: "deadline_ms" });
  }
  if (budget.remaining_ms !== undefined && !Number.isSafeInteger(budget.remaining_ms)) {
    return evdError("E_EVIDENCE_LIMITS_UNKNOWN", { field: "remaining_ms" });
  }
  return null;
}

function enforceCapabilityLimits(
  capability: SemanticBackendCapability,
  binding: JudgeRequestBindingV3
): EvdError | null {
  const limits = capability.limits;
  const questionCount = binding.request.questions.length;
  if (questionCount > limits.max_questions) {
    return evdError("E_EVIDENCE_EXCEEDS_BUDGET", {
      limiting_question_key: "",
      observed: questionCount,
      limit: limits.max_questions,
    });
  }
  const evidenceCount = binding.request.evidence.length;
  if (evidenceCount > limits.max_evidence_items) {
    return evdError("E_EVIDENCE_EXCEEDS_BUDGET", {
      limiting_question_key: "",
      observed: evidenceCount,
      limit: limits.max_evidence_items,
    });
  }
  const stateBytes = binding.request.state?.content_bytes ?? 0;
  if (stateBytes > limits.max_state_bytes) {
    return evdError("E_EVIDENCE_EXCEEDS_BUDGET", {
      limiting_question_key: "",
      observed: stateBytes,
      limit: limits.max_state_bytes,
    });
  }
  const requestBytes = utf8Length(JSON.stringify(binding.request));
  if (requestBytes > limits.max_request_bytes) {
    return evdError("E_EVIDENCE_EXCEEDS_BUDGET", {
      limiting_question_key: "",
      observed: requestBytes,
      limit: limits.max_request_bytes,
    });
  }
  const contracts: readonly string[] = capability.output_contracts;
  if (contracts.length !== 1 || contracts[0] !== "categorical_option/1") {
    return evdError("E_SEMANTIC_CONTRACT_UNSUPPORTED", {
      backend_key: capability.backend_key,
      contract: "categorical_option/1",
      field: "output_contracts",
    });
  }
  return null;
}

/**
 * Remaining budget for a request, measured only on the monotonic timeline.
 *
 * `deadline` is an absolute monotonic reading. Flooring keeps the persisted
 * `remaining_ms` an integer (the schema requires one) and can only shorten the
 * budget: it never extends the deadline. Wall time is deliberately absent.
 */
export function remainingMonotonicMs(deadline: number, monotonicNow: number): number {
  return Math.floor(deadline - monotonicNow);
}

export function createEvidenceCompiler(deps: PackCompilerDeps): EvidenceCompiler {
  return {
    async compilePack(input) {
      return compileEvidencePack(deps, input);
    },
    expandClosure(input) {
      return expandDependencyClosure(input);
    },
    async planShards(input) {
      const planResult = await deps.plans.readPlan({
        plan_id: input.plan_id,
        plan_hash: input.plan_hash,
        binding: input.binding,
      });
      if (!planResult.ok) {
        return err(mapPlanError(planResult.error));
      }
      const plan = planResult.value;
      const lifecycle = await readPlanLifecycle(
        deps,
        {
          plan_id: input.plan_id,
          plan_hash: input.plan_hash,
          binding: input.binding,
        },
        plan
      );
      if (!lifecycle.ok) {
        return err(lifecycle.error);
      }
      return planShardsForPlan(input, plan, deps.now(), lifecycle.value);
    },
    estimateBudget(input) {
      return estimateBudget(input, deps.now());
    },
    estimateSemanticBudget(input) {
      return estimateSemanticBudget(input, deps.now());
    },
    async buildRequest(input) {
      const rows = deps.binding;
      if (rows === undefined) {
        return evdErr("E_EVIDENCE_PLAN_NOT_DISPATCHABLE", {
          shard_plan_key: "",
          reason: "read_port_missing",
        });
      }
      const parsedBinding = parseVersionBinding(input.version_binding);
      if (!parsedBinding.ok) {
        return evdForwarded("E_VERSION_BINDING", { field: "version_binding" });
      }
      const budgetError = validateRunBudgetShape(input.budget);
      if (budgetError !== null) {
        return err(budgetError);
      }
      if (!Number.isSafeInteger(input.deadline_at_monotonic_ms)) {
        return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "deadline_ms" });
      }
      const remaining = remainingMonotonicMs(
        input.deadline_at_monotonic_ms,
        deps.monotonic_now()
      );
      if (!Number.isSafeInteger(remaining)) {
        return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "deadline_ms" });
      }
      const declaredRemaining = input.budget.remaining_ms ?? remaining;
      // An expired or non-positive remaining budget is rejected by
      // `buildJudgeRequest` at the documented limits stage, after the
      // backend/scope/contract checks, so it is not short-circuited here.
      const effectiveRemaining = Math.min(declaredRemaining, remaining);
      const effectiveInput = {
        ...input,
        budget: { ...input.budget, remaining_ms: effectiveRemaining },
      };

      const planResult = await deps.plans.readPlan({
        plan_id: input.plan_id,
        plan_hash: input.plan_hash,
        binding: input.version_binding,
      });
      if (!planResult.ok) {
        return err(mapPlanError(planResult.error));
      }
      const plan = planResult.value;
      if (plan.plan_id !== input.plan_id) {
        return evdForwarded("E_VERSION_BINDING", { field: "plan_id" });
      }
      if (plan.plan_hash !== input.plan_hash) {
        return evdForwarded("E_VERSION_BINDING", { field: "plan_hash" });
      }
      if (!planBindingMatches(plan.binding, input.version_binding)) {
        return evdForwarded("E_VERSION_BINDING", { field: "plan.binding" });
      }
      const lifecycle = await readPlanLifecycle(
        deps,
        {
          plan_id: input.plan_id,
          plan_hash: input.plan_hash,
          binding: input.version_binding,
        },
        plan
      );
      if (!lifecycle.ok) {
        return err(lifecycle.error);
      }
      if (lifecycle.value === "rejected") {
        return evdErr("E_EVIDENCE_PLAN_NOT_DISPATCHABLE", {
          shard_plan_key: "",
          reason: "plan_state_rejected",
        });
      }
      if (lifecycle.value !== "active") {
        return evdForwarded("E_PLAN_STALE", { field: "plan_state" });
      }
      const closureError = validatePlanClosure(plan);
      if (closureError !== null) {
        return err(closureError);
      }

      const loaded = await loadJudgeRequestContext({ rows }, effectiveInput, plan);
      if (!loaded.ok) {
        return err(loaded.error);
      }
      const built = buildJudgeRequest(loaded.value.context);
      if (!built.ok) {
        return err(built.error);
      }
      const limitError = enforceCapabilityLimits(loaded.value.context.capability, built.value);
      if (limitError !== null) {
        return err(limitError);
      }
      const validatorContract = loaded.value.context.validator_binding.output_contract;
      if (validatorContract !== "categorical_option/1") {
        return evdErr("E_SEMANTIC_CONTRACT_UNSUPPORTED", {
          backend_key: loaded.value.context.capability.backend_key,
          contract: "categorical_option/1",
          field: "validator_binding.output_contract",
        });
      }
      const binding: JudgeRequestBindingV3 = {
        ...built.value,
        service_profile_key: loaded.value.service_profile_key,
      };
      return ok(binding);
    },
  };
}

export { evdOk };
