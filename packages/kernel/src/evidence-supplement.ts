/**
 * W4 targeted evidence supplementation (add_task.md W4, D2).
 *
 * The supplementer is the only kernel-side loop that tries to repair a
 * `needs_evidence` aggregate without dispatching another semantic request.
 * It is closed by default and degrades to "no change" when disabled, when no
 * approved workspace root exists, or when a dependency is missing.
 *
 * Hard invariants:
 *
 *   - the original `VersionBinding` and requirement version are never
 *     changed; no requirement row is written here;
 *   - only verified, non-stale hard facts whose six binding fields equal the
 *     input binding may reach the deterministic decision port. Workspace and
 *     attachment bytes are *observations*: they are hashed into the audit
 *     record, never promoted to `verified`, and never passed to
 *     `decideDispatch` as facts;
 *   - every round ends by calling the same W3 `decideDispatch` rule as the
 *     first round; this module does not implement a second rule;
 *   - a question is resolved only when every required question is
 *     `decided` by hard facts at the same binding/watermark. When a decided
 *     fact is outside the original aggregate's hard-fact snapshot,
 *     `requires_repack=true`: the online path must rebuild pack/aggregate and
 *     may not apply the old aggregate;
 *   - rounds, elapsed time, bytes, estimated tokens and read count are
 *     independently bounded (default 3 rounds). Exhaustion returns
 *     `needs_evidence` with `budget_cap=true`, never an invented answer;
 *   - the result is appended through the journal-backed supplement writer;
 *     if that append fails, the run fails and no in-memory "success" is
 *     reported.
 */

import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  SourceRefPort,
  StateRowLiveCommitPort,
  VersionBinding
} from "@evoplug/core";
import {
  canonicalJsonText,
  equalVersionBinding,
  err,
  hashBytes,
  isHash,
  isVersionBinding,
  makeErrorEnvelope,
  ok,
  parseSourceRef
} from "@evoplug/core";
import { decideDispatch } from "@evoplug/core/host";
import type {
  AnswerAggregateV2,
  EvidenceIndexSnapshot,
  EvidencePack
} from "@evoplug/evidence";
import {
  createAnswerAggregator,
  createEvidenceCompiler
} from "@evoplug/evidence";
import type {
  BlobStore,
  JournalWriter,
  SqliteConnection,
  SqlRow
} from "@evoplug/storage";
import { performance } from "node:perf_hooks";

import {
  resolveDefaultEvidenceBinding,
  type ResolvedEvidenceBinding
} from "./default-evidence-composition.js";
import { createDefaultEvidenceReader } from "./default-evidence-reader.js";
import { createDefaultEvidenceWriter } from "./default-evidence-writer.js";
import { createDefaultQuestionEvidencePorts } from "./default-question-evidence.js";
import type { DefaultQuestionPlannerBundle } from "./default-question-planner.js";
import { createDefaultQuestionPlanner } from "./default-question-planner.js";
import { createEvidenceBindingReadPort } from "./evidence-binding-reader.js";
import type {
  EvidenceSupplementDraft,
  EvidenceSupplementPrunedRecord,
  EvidenceSupplementReadRecord,
  EvidenceSupplementRow,
  EvidenceSupplementRound,
  EvidenceSupplementWriter,
  EvidenceSupplementWriterPort,
  SupplementReadStatus
} from "./evidence-supplement-writer.js";
import { createEvidenceSupplementWriter } from "./evidence-supplement-writer.js";
import type { RootRegistry } from "./root-registry.js";
import {
  WORKSPACE_READ_MAX_BYTES,
  createWorkspaceReadPort,
  createWorkspaceRootsFromRegistry,
  type WorkspaceReadPort,
  type WorkspaceReadRoot
} from "./workspace-read-port.js";

/** Default round cap fixed by the taskbook. */
const SUPPLEMENT_MAX_ROUNDS = 3;

/** Default budget for one task's supplementation. */
const SUPPLEMENT_DEFAULT_MAX_BYTES = 4_194_304;
const SUPPLEMENT_DEFAULT_MAX_TOKENS = 131_072;
const SUPPLEMENT_DEFAULT_MAX_ELAPSED_MS = 5_000;
const SUPPLEMENT_DEFAULT_MAX_READS = 64;

const MAX_ATTACHMENT_REFS = 32;
const MAX_EXACT_PATHS = 16;
const MAX_SEARCH_ROOTS = 4;
const MAX_KEYWORD_CANDIDATES = 32;
const MAX_PRUNED_PER_ROUND = 32;

/* ------------------------------------------------------------------ */
/* Decision port (W3 shape)                                            */
/* ------------------------------------------------------------------ */

/**
 * The W3 `DispatchQuestion` shape: the fields a hard fact needs to decide a
 * required proposition. It is structurally compatible with
 * `AggregatePlanView.questions`.
 */
export interface SupplementQuestion {
  readonly question_key: string;
  readonly proposition_id: string;
  readonly requirement_ids: readonly string[];
  readonly required_for_issue: boolean;
}

/**
 * The W3 `DispatchHardFact` shape: `HardFactReadView` plus the six binding
 * fields that the decision gate compares.
 */
export interface SupplementFact {
  readonly fact_key: Hash;
  readonly independence_key: Hash;
  readonly requirement_id: string;
  readonly proposition_id?: string;
  readonly effect: "supports" | "violates";
  readonly verified: boolean;
  readonly task_id: string;
  readonly branch_id: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly stale?: boolean;
  readonly source_refs?: readonly SourceRef[];
}

export type SupplementDispatchDecision =
  | {
      readonly kind: "decided";
      readonly basis: "hard_fact";
      readonly fact_keys: readonly Hash[];
    }
  | {
      readonly kind: "gap";
      readonly basis: "evidence_missing";
      readonly gap_codes: readonly string[];
    }
  | { readonly kind: "semantic_required"; readonly reason: string };

/**
 * Injected W3 rule. Production receives `decideDispatch` itself; the
 * supplementer never forks or approximates the rule.
 */
export interface SupplementDecidePort {
  decide(
    question: SupplementQuestion,
    facts: readonly SupplementFact[]
  ): SupplementDispatchDecision;
}

export interface SupplementQuestionDecision {
  readonly question_key: string;
  readonly kind: "decided" | "gap" | "semantic_required";
  readonly basis: string | null;
  readonly gap_codes: readonly string[];
  readonly reason: string | null;
  readonly fact_keys: readonly Hash[];
}

/* ------------------------------------------------------------------ */
/* Read-only observation ports                                         */
/* ------------------------------------------------------------------ */

/** Current verified hard facts for exactly one binding. */
interface SupplementFactReadPort {
  read(input: {
    readonly binding: VersionBinding;
  }): Promise<Result<readonly SupplementFact[], ErrorEnvelope>>;
}

/** One retrievable HOST attachment, already content-addressed. */
export interface SupplementAttachment {
  readonly source_ref: SourceRef;
  readonly text: string | null;
  readonly content_hash: Hash;
  readonly byte_length: number;
  readonly binary: boolean;
}

/**
 * Retrievable HOST attachment source. This is the only read surface when no
 * approved workspace root exists; it never scans directories.
 */
export interface SupplementAttachmentSource {
  read(input: {
    readonly source_refs: readonly SourceRef[];
    readonly max_bytes: number;
  }): Promise<Result<readonly SupplementAttachment[], ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Planning views                                                      */
/* ------------------------------------------------------------------ */

interface SupplementIssueView {
  readonly issue_id: string;
  readonly issue_key: string;
  readonly issue_type: string;
  readonly question_text: string | null;
  readonly requirement_ids: readonly string[];
}

interface SupplementPlanQuestionView {
  readonly question_key: string;
  readonly proposition_id?: string;
  readonly requirement_ids: readonly string[];
  readonly required_for_issue: boolean;
}

interface SupplementPlanView {
  readonly plan_id: string;
  readonly plan_hash: Hash;
  readonly questions: readonly SupplementPlanQuestionView[];
  readonly artifact_paths?: readonly string[];
}

interface SupplementPackRequirementView {
  readonly id: string;
  readonly quote: string;
  readonly source_refs: readonly SourceRef[];
  readonly source_id: string;
}

interface SupplementPackFactView {
  readonly id: string;
  readonly source_id: string;
  readonly kind: string;
  readonly excerpt: string;
  readonly source_refs: readonly SourceRef[];
  readonly content_hash: Hash;
  readonly retrievable: boolean;
}

export interface SupplementPackView {
  readonly pack_id: string;
  readonly pack_key: Hash;
  readonly pack_hash: Hash;
  readonly issue_id: string;
  readonly issue: {
    readonly question: string;
    readonly requirement_ids: readonly string[];
    readonly issue_type: string;
  };
  readonly requirements: readonly SupplementPackRequirementView[];
  readonly facts: readonly SupplementPackFactView[];
}

interface SupplementMissingView {
  readonly question_key: string;
  readonly kind: string;
  readonly source_refs: readonly SourceRef[];
  readonly recoverable: boolean;
}

interface SupplementAggregateView {
  readonly aggregate_id: string;
  readonly aggregate_hash: Hash;
  readonly missing: readonly SupplementMissingView[];
  /** Original hard-fact snapshot keys, used to detect out-of-snapshot facts. */
  readonly hard_facts?: readonly { readonly fact_key: Hash }[];
}

export interface SupplementGapView {
  readonly code: string;
  readonly requirement_ids: readonly string[];
  readonly source_refs: readonly SourceRef[];
  readonly affects_question_keys: readonly string[];
}

export interface SupplementBudgetInput {
  readonly max_rounds?: number;
  readonly max_bytes?: number;
  readonly max_tokens?: number;
  readonly max_elapsed_ms?: number;
  readonly max_reads?: number;
}

export interface EvidenceSupplementInput {
  readonly binding: VersionBinding;
  readonly issue: SupplementIssueView;
  readonly plan: SupplementPlanView;
  readonly pack: SupplementPackView;
  readonly aggregate: SupplementAggregateView;
  readonly gaps: readonly SupplementGapView[];
  /** Initial verified facts from the current snapshot. */
  readonly facts?: readonly SupplementFact[];
  /** Per-call override; the service-level flag is the default. */
  readonly enabled?: boolean | undefined;
  readonly budget?: SupplementBudgetInput | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type EvidenceSupplementHookOutcome =
  | {
      readonly status: "resolved";
      readonly decision: {
        readonly kind: "decided";
        readonly basis: "hard_fact";
        readonly fact_keys: readonly Hash[];
      };
      readonly record_id: string;
      readonly requires_repack: boolean;
    }
  | {
      readonly status: "insufficient";
      readonly gaps: readonly {
        readonly code: string;
        readonly affects_question_keys: readonly string[];
      }[];
      readonly budget_cap: boolean;
      readonly record_id: string;
    }
  | { readonly status: "disabled" };

/** The hook the online `needs_evidence` branch may inject. */
interface EvidenceSupplementHookOutcomeWithRecord {
  readonly outcome: EvidenceSupplementHookOutcome;
  readonly supplement: EvidenceSupplementRow | null;
}

export interface EvidenceSupplementHookPort {
  supplement(
    input: EvidenceSupplementInput
  ): Promise<Result<EvidenceSupplementHookOutcomeWithRecord, ErrorEnvelope>>;
}

interface EvidenceSupplementerDeps {
  readonly decide: SupplementDecidePort;
  readonly writer: EvidenceSupplementWriterPort;
  readonly facts?: SupplementFactReadPort;
  readonly workspace?: Pick<WorkspaceReadPort, "list" | "read" | "stat">;
  readonly attachments?: SupplementAttachmentSource;
  /** Default false. The whole loop is off until the flag is turned on. */
  readonly enabled?: boolean | undefined;
  readonly budget?: SupplementBudgetInput | undefined;
  /** Root-relative directories the keyword round may list, max 4. */
  readonly search_roots?: readonly string[];
  /** Extra keywords for the recall round. */
  readonly search_terms?: readonly string[];
  readonly now?: () => number;
  readonly monotonic?: () => number;
}

interface EvidenceSupplementer extends EvidenceSupplementHookPort {}

/* ------------------------------------------------------------------ */
/* Frozen-snapshot rebuild port                                        */
/* ------------------------------------------------------------------ */

/**
 * Inputs and outputs of the rebuild pipeline.
 *
 * `requires_repack=true` means the deciding hard fact was absent from the
 * original aggregate's frozen `hard_facts` snapshot. Applying it to that
 * aggregate would smuggle a new fact into an old freeze, so the online path
 * must load a fresh `EvidenceIndexSnapshot` at the same six-field binding,
 * compile a new pack/shard plan and aggregate again. The old pack, shard plan
 * and aggregate stay immutable; the rebuild writes new rows through the
 * caller-supplied primitives.
 */
interface SupplementRebuildSnapshot {
  readonly snapshot: EvidenceIndexSnapshot;
}

interface SupplementRebuildSnapshotInput {
  readonly binding: VersionBinding;
  readonly issue_id: string;
  readonly plan_id: string;
  readonly plan_hash: Hash;
  readonly signal?: AbortSignal | undefined;
}

interface SupplementRebuildPackInput extends SupplementRebuildSnapshotInput {
  readonly snapshot: EvidenceIndexSnapshot;
}

interface SupplementRebuildPackResult {
  readonly pack: EvidencePack;
  readonly shard_plan_id: string;
  readonly shard_plan_key: Hash;
}

interface SupplementRebuildAggregateInput extends SupplementRebuildPackInput {
  readonly pack: EvidencePack;
  readonly shard_plan_id: string;
  readonly shard_plan_key: Hash;
  /** Questions W3 settled from verified hard facts at this binding. */
  readonly decided_question_keys: readonly string[];
}

/** The three real stages the rebuild owns; each is supplied by integration. */
export interface SupplementRebuildPrimitives {
  /** Reloads the evidence index for the same binding; never a new version. */
  reload_snapshot(
    input: SupplementRebuildSnapshotInput
  ): Promise<Result<SupplementRebuildSnapshot, ErrorEnvelope>>;
  /** Compiles and journals a new pack/closure/shard plan for the same plan. */
  rebuild_pack(
    input: SupplementRebuildPackInput
  ): Promise<Result<SupplementRebuildPackResult, ErrorEnvelope>>;
  /** Aggregates against the fresh freeze; returns the new immutable aggregate. */
  reaggregate(
    input: SupplementRebuildAggregateInput
  ): Promise<Result<AnswerAggregateV2, ErrorEnvelope>>;
}

export interface SupplementRebuildInput {
  readonly binding: VersionBinding;
  readonly issue_id: string;
  readonly plan_id: string;
  readonly plan_hash: Hash;
  readonly original_pack: SupplementPackView;
  readonly original_aggregate: SupplementAggregateView;
  /** Keys reported by the W4 decision; audited, never treated as answers. */
  readonly fact_keys: readonly Hash[];
  /** Required question keys that the supplement settled. */
  readonly decided_question_keys: readonly string[];
  readonly signal?: AbortSignal | undefined;
}

export interface SupplementRebuildResult {
  /** `resolved` has the same meaning as the online judgment basis. */
  readonly status: "resolved" | "unresolved";
  readonly snapshot_hash: Hash;
  readonly pack_id: string;
  readonly pack_key: Hash;
  readonly pack_hash: Hash;
  readonly shard_plan_id: string;
  readonly shard_plan_key: Hash;
  readonly aggregate_id: string;
  readonly aggregate_hash: Hash;
  readonly aggregate: AnswerAggregateV2;
  readonly reason_codes: readonly string[];
}

export interface SupplementRebuildPort {
  rebuild(
    input: SupplementRebuildInput
  ): Promise<Result<SupplementRebuildResult, ErrorEnvelope>>;
}

function rebuildFailure(
  code: "E_SCHEMA" | "E_CONFLICT" | "E_SUPPLEMENT_UNAVAILABLE",
  rule: string
): ErrorEnvelope {
  const schema = code === "E_SCHEMA";
  return makeErrorEnvelope({
    code,
    category: schema ? "schema" : code === "E_CONFLICT" ? "conflict" : "internal",
    message_key:
      code === "E_SCHEMA"
        ? "error.schema"
        : code === "E_CONFLICT"
          ? "error.conflict"
          : "error.supplement.unavailable",
    stage: "evidence_supplement_rebuild",
    details: schema ? { kind: "field", path: "rebuild", rule } : { kind: "none" },
    retryable: false,
    side_effect: "none"
  });
}

function rebuildJudged(aggregate: AnswerAggregateV2): boolean {
  return (
    (aggregate.final_state === "consistent" || aggregate.final_state === "inconsistent") &&
    (aggregate.final_basis === "hard_fact" ||
      (aggregate.final_state === "consistent" && aggregate.final_basis === "mixed")) &&
    aggregate.coverage.complete &&
    aggregate.coverage.missing_question_keys.length === 0
  );
}

/**
 * Builds the callable frozen-snapshot rebuild port.
 *
 * The port invalidates nothing and mutates no existing row: reload, compile
 * and aggregate are the integration's real stages, and the returned aggregate
 * is a new object bound to the new pack/shard plan. A binding, plan or
 * pack/shard mismatch fails closed instead of returning a "rebuilt" result.
 */
export function createSupplementRebuildPort(
  primitives: SupplementRebuildPrimitives
): SupplementRebuildPort {
  async function rebuild(
    input: SupplementRebuildInput
  ): Promise<Result<SupplementRebuildResult, ErrorEnvelope>> {
    if (!isVersionBinding(input.binding)) {
      return err(rebuildFailure("E_SCHEMA", "binding_six_fields"));
    }
    if (
      input.issue_id.length === 0 ||
      input.plan_id.length === 0 ||
      !isHash(input.plan_hash)
    ) {
      return err(rebuildFailure("E_SCHEMA", "issue_plan_identity"));
    }
    if (
      input.original_pack.issue_id !== input.issue_id ||
      !isHash(input.original_pack.pack_key) ||
      !isHash(input.original_pack.pack_hash) ||
      !isHash(input.original_aggregate.aggregate_hash)
    ) {
      return err(rebuildFailure("E_SCHEMA", "original_pack_aggregate"));
    }
    for (const key of input.fact_keys) {
      if (!isHash(key)) {
        return err(rebuildFailure("E_SCHEMA", "fact_key_sha256"));
      }
    }
    const stageInput: SupplementRebuildSnapshotInput = {
      binding: input.binding,
      issue_id: input.issue_id,
      plan_id: input.plan_id,
      plan_hash: input.plan_hash,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    };

    const loaded = await primitives.reload_snapshot(stageInput);
    if (!loaded.ok) {
      return loaded;
    }
    const snapshot = loaded.value.snapshot;
    if (
      snapshot.schema_version !== "rsi.evidence_index_snapshot/1" ||
      !isHash(snapshot.snapshot_hash)
    ) {
      return err(rebuildFailure("E_SCHEMA", "snapshot_shape"));
    }
    if (!equalVersionBinding(snapshot.binding, input.binding)) {
      return err(rebuildFailure("E_CONFLICT", "snapshot_binding_changed"));
    }

    const packInput: SupplementRebuildPackInput = { ...stageInput, snapshot };
    const rebuiltPack = await primitives.rebuild_pack(packInput);
    if (!rebuiltPack.ok) {
      return rebuiltPack;
    }
    const pack = rebuiltPack.value.pack;
    if (
      typeof pack.pack_id !== "string" ||
      !isHash(pack.pack_key) ||
      !isHash(pack.pack_hash) ||
      !isHash(rebuiltPack.value.shard_plan_key)
    ) {
      return err(rebuildFailure("E_SCHEMA", "pack_shape"));
    }

    const aggregateInput: SupplementRebuildAggregateInput = {
      ...packInput,
      pack,
      shard_plan_id: rebuiltPack.value.shard_plan_id,
      shard_plan_key: rebuiltPack.value.shard_plan_key,
      decided_question_keys: input.decided_question_keys
    };
    const aggregated = await primitives.reaggregate(aggregateInput);
    if (!aggregated.ok) {
      return aggregated;
    }
    const aggregate = aggregated.value;
    if (
      aggregate.schema_version !== "rsi.answer_aggregate/2" ||
      !isHash(aggregate.aggregate_hash) ||
      aggregate.plan_id !== input.plan_id ||
      aggregate.plan_hash !== input.plan_hash ||
      aggregate.shard_plan_key !== rebuiltPack.value.shard_plan_key
    ) {
      return err(rebuildFailure("E_CONFLICT", "aggregate_identity_changed"));
    }
    if (!equalVersionBinding(aggregate.binding, input.binding)) {
      return err(rebuildFailure("E_CONFLICT", "aggregate_binding_changed"));
    }

    // A rebuild must actually observe a new freeze and produce a new
    // aggregate. Returning the original identities would silently relabel the
    // old answer as supplement-resolved without any new evidence.
    const unchanged =
      pack.pack_key === input.original_pack.pack_key &&
      aggregate.aggregate_hash === input.original_aggregate.aggregate_hash;
    if (unchanged) {
      return ok({
        status: "unresolved",
        snapshot_hash: snapshot.snapshot_hash,
        pack_id: pack.pack_id,
        pack_key: pack.pack_key,
        pack_hash: pack.pack_hash,
        shard_plan_id: rebuiltPack.value.shard_plan_id,
        shard_plan_key: rebuiltPack.value.shard_plan_key,
        aggregate_id: aggregate.aggregate_id,
        aggregate_hash: aggregate.aggregate_hash,
        aggregate,
        reason_codes: [...new Set([...aggregate.reason_codes, "no_new_evidence"])]
      });
    }

    return ok({
      status: rebuildJudged(aggregate) ? "resolved" : "unresolved",
      snapshot_hash: snapshot.snapshot_hash,
      pack_id: pack.pack_id,
      pack_key: pack.pack_key,
      pack_hash: pack.pack_hash,
      shard_plan_id: rebuiltPack.value.shard_plan_id,
      shard_plan_key: rebuiltPack.value.shard_plan_key,
      aggregate_id: aggregate.aggregate_id,
      aggregate_hash: aggregate.aggregate_hash,
      aggregate,
      reason_codes: [...aggregate.reason_codes]
    });
  }

  return { rebuild };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

const SUPPLEMENT_FAILURE_META: Readonly<
  Record<
    "E_SUPPLEMENT_UNAVAILABLE" | "E_SUPPLEMENT_BUDGET_EXHAUSTED" | "E_SCHEMA",
    { readonly category: "internal" | "budget" | "schema"; readonly message_key: string }
  >
> = {
  E_SUPPLEMENT_UNAVAILABLE: {
    category: "internal",
    message_key: "error.supplement.unavailable"
  },
  E_SUPPLEMENT_BUDGET_EXHAUSTED: {
    category: "budget",
    message_key: "error.supplement.budget_exhausted"
  },
  E_SCHEMA: { category: "schema", message_key: "error.schema" }
};

function supplementFailure(
  code: "E_SUPPLEMENT_UNAVAILABLE" | "E_SUPPLEMENT_BUDGET_EXHAUSTED" | "E_SCHEMA",
  rule: string,
  category?: "internal" | "budget" | "schema"
): Result<never, ErrorEnvelope> {
  const meta = SUPPLEMENT_FAILURE_META[code];
  const resolvedCategory = category ?? meta.category;
  return err(
    makeErrorEnvelope({
      code,
      category: resolvedCategory,
      message_key: meta.message_key,
      stage: "evidence_supplement",
      details:
        resolvedCategory === "budget"
          ? {
              kind: "budget",
              scope_key: "supplement",
              policy_version: "rsi.supplement/1",
              budget_kind: "token",
              remaining: null
            }
          : { kind: "field", path: "supplement", rule },
      retryable: false,
      side_effect: "none"
    })
  );
}

/* ------------------------------------------------------------------ */
/* Budget and fact gate                                                */
/* ------------------------------------------------------------------ */

interface NormalizedBudget {
  readonly max_rounds: number;
  readonly max_bytes: number;
  readonly max_tokens: number;
  readonly max_elapsed_ms: number;
  readonly max_reads: number;
}

function positiveInt(value: number | undefined, fallback: number, cap: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return fallback;
  }
  return Math.min(value, cap);
}

function normalizeBudget(input: SupplementBudgetInput | undefined): NormalizedBudget {
  return {
    max_rounds: positiveInt(input?.max_rounds, SUPPLEMENT_MAX_ROUNDS, SUPPLEMENT_MAX_ROUNDS),
    max_bytes: positiveInt(input?.max_bytes, SUPPLEMENT_DEFAULT_MAX_BYTES, WORKSPACE_READ_MAX_BYTES * 4),
    max_tokens: positiveInt(input?.max_tokens, SUPPLEMENT_DEFAULT_MAX_TOKENS, SUPPLEMENT_DEFAULT_MAX_TOKENS * 4),
    max_elapsed_ms: positiveInt(
      input?.max_elapsed_ms,
      SUPPLEMENT_DEFAULT_MAX_ELAPSED_MS,
      SUPPLEMENT_DEFAULT_MAX_ELAPSED_MS * 4
    ),
    max_reads: positiveInt(input?.max_reads, SUPPLEMENT_DEFAULT_MAX_READS, SUPPLEMENT_DEFAULT_MAX_READS * 4)
  };
}

function bindingOf(fact: SupplementFact): VersionBinding {
  return {
    task_id: fact.task_id as VersionBinding["task_id"],
    branch_id: fact.branch_id as VersionBinding["branch_id"],
    input_epoch: fact.input_epoch,
    goal_version: fact.goal_version,
    config_version: fact.config_version,
    watermark: fact.watermark
  };
}

/**
 * The only fact filter used by the decision gate. A fact survives only when
 * it is verified, not stale, well-formed and bound to the exact input
 * binding. This is what keeps observed workspace bytes out of `decided`.
 */
export function eligibleSupplementFacts(
  binding: VersionBinding,
  facts: readonly SupplementFact[]
): readonly SupplementFact[] {
  const seen = new Set<Hash>();
  const eligible: SupplementFact[] = [];
  for (const fact of facts) {
    if (fact.verified !== true || fact.stale === true) {
      continue;
    }
    if (fact.effect !== "supports" && fact.effect !== "violates") {
      continue;
    }
    if (!isHash(fact.fact_key) || !isHash(fact.independence_key)) {
      continue;
    }
    if (typeof fact.requirement_id !== "string" || fact.requirement_id.length === 0) {
      continue;
    }
    let factBinding: VersionBinding;
    try {
      factBinding = bindingOf(fact);
    } catch {
      continue;
    }
    if (!isVersionBinding(factBinding) || !equalVersionBinding(factBinding, binding)) {
      continue;
    }
    if (seen.has(fact.fact_key)) {
      continue;
    }
    seen.add(fact.fact_key);
    eligible.push(fact);
  }
  return eligible;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function tokenize(text: string): readonly string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((token) => token.length >= 3 && token.length <= 64);
  return [...new Set(tokens)].slice(0, 32);
}

function safeRelativePath(value: string): string | null {
  if (value.includes("\u0000") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return null;
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.length === 0) {
    return "";
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    return null;
  }
  return normalized;
}

function dirnameOf(pathRel: string): string {
  const index = pathRel.lastIndexOf("/");
  return index <= 0 ? "" : pathRel.slice(0, index);
}

function uniqueSourceRefs(refs: readonly SourceRef[]): readonly SourceRef[] {
  return [...new Set(refs)].slice(0, MAX_ATTACHMENT_REFS);
}

function mergeFacts(
  current: readonly SupplementFact[],
  incoming: readonly SupplementFact[],
  binding: VersionBinding
): readonly SupplementFact[] {
  const merged = new Map<Hash, SupplementFact>();
  for (const fact of current) {
    merged.set(fact.fact_key, fact);
  }
  for (const fact of incoming) {
    merged.set(fact.fact_key, fact);
  }
  return eligibleSupplementFacts(binding, [...merged.values()]);
}

function sourceRefsOf(input: EvidenceSupplementInput): readonly SourceRef[] {
  const refs: SourceRef[] = [];
  for (const gap of input.gaps) {
    refs.push(...gap.source_refs);
  }
  for (const requirement of input.pack.requirements) {
    refs.push(...requirement.source_refs);
  }
  for (const fact of input.pack.facts) {
    refs.push(...fact.source_refs);
  }
  return uniqueSourceRefs(refs);
}

function exactPathCandidates(input: EvidenceSupplementInput): readonly string[] {
  const paths: string[] = [];
  const declared = input.plan.artifact_paths ?? [];
  for (const path of declared) {
    const safe = safeRelativePath(path);
    if (safe !== null && safe !== "") {
      paths.push(safe);
    }
  }
  return [...new Set(paths)].slice(0, MAX_EXACT_PATHS);
}

function keywordTerms(input: EvidenceSupplementInput, extra: readonly string[]): readonly string[] {
  const terms = new Set<string>(extra.map((term) => term.toLowerCase()));
  if (input.issue.question_text !== null) {
    for (const token of tokenize(input.issue.question_text)) {
      terms.add(token);
    }
  }
  for (const requirement of input.pack.requirements) {
    for (const token of tokenize(requirement.quote)) {
      terms.add(token);
    }
  }
  for (const gap of input.gaps) {
    for (const token of tokenize(gap.code)) {
      terms.add(token);
    }
  }
  return [...terms].slice(0, MAX_KEYWORD_CANDIDATES);
}

function searchRootsFor(
  _input: EvidenceSupplementInput,
  exactPaths: readonly string[],
  configured: readonly string[] | undefined
): readonly string[] {
  const roots: string[] = [];
  for (const root of configured ?? []) {
    const safe = safeRelativePath(root);
    if (safe !== null) {
      roots.push(safe === "." ? "" : safe);
    }
  }
  for (const path of exactPaths) {
    roots.push(dirnameOf(path));
  }
  return [...new Set(roots)].slice(0, MAX_SEARCH_ROOTS);
}

function statusForError(code: string): { readonly status: SupplementReadStatus; readonly reason: string } {
  switch (code) {
    case "E_WORKSPACE_READ_DENIED":
      return { status: "denied", reason: "denied" };
    case "E_WORKSPACE_READ_TOO_LARGE":
      return { status: "too_large", reason: "too_large" };
    case "E_WORKSPACE_READ_UNSUPPORTED":
      return { status: "unsupported", reason: "unsupported" };
    case "E_WORKSPACE_CHANGED":
      return { status: "changed", reason: "changed" };
    case "E_SOURCE_NOT_FOUND":
      return { status: "not_found", reason: "not_found" };
    case "E_DEADLINE_EXCEEDED":
    case "E_CANCELLED":
      return { status: "unsupported", reason: "deadline" };
    default:
      return { status: "denied", reason: "read_error" };
  }
}

function decisionsFor(
  decide: SupplementDecidePort,
  questions: readonly SupplementQuestion[],
  facts: readonly SupplementFact[]
): {
  readonly decisions: readonly SupplementQuestionDecision[];
  readonly allDecided: boolean;
  readonly factKeys: readonly Hash[];
} {
  const decisions: SupplementQuestionDecision[] = [];
  const factKeys = new Set<Hash>();
  let allDecided = true;
  for (const question of questions) {
    let decision: SupplementDispatchDecision;
    try {
      decision = decide.decide(question, facts);
    } catch {
      decision = { kind: "semantic_required", reason: "dispatch_threw" };
    }
    if (decision.kind === "decided") {
      if (decision.basis !== "hard_fact" || decision.fact_keys.length === 0) {
        allDecided = false;
        decisions.push({
          question_key: question.question_key,
          kind: "semantic_required",
          basis: null,
          gap_codes: [],
          reason: "decided_without_hard_fact",
          fact_keys: []
        });
        continue;
      }
      for (const key of decision.fact_keys) {
        factKeys.add(key);
      }
      decisions.push({
        question_key: question.question_key,
        kind: "decided",
        basis: "hard_fact",
        gap_codes: [],
        reason: null,
        fact_keys: [...decision.fact_keys]
      });
      continue;
    }
    allDecided = false;
    if (decision.kind === "gap") {
      decisions.push({
        question_key: question.question_key,
        kind: "gap",
        basis: "evidence_missing",
        gap_codes: [...decision.gap_codes],
        reason: null,
        fact_keys: []
      });
      continue;
    }
    decisions.push({
      question_key: question.question_key,
      kind: "semantic_required",
      basis: null,
      gap_codes: [],
      reason: decision.reason,
      fact_keys: []
    });
  }
  return { decisions, allDecided: allDecided && questions.length > 0, factKeys: [...factKeys] };
}

/* ------------------------------------------------------------------ */
/* SourceRef attachment adapter                                        */
/* ------------------------------------------------------------------ */

/** Adapts the FND `SourceRefPort` into the attachment-only read surface. */
export function createSourceRefAttachmentSource(
  port: Pick<SourceRefPort, "resolve">
): SupplementAttachmentSource {
  return {
    async read(input: {
      readonly source_refs: readonly SourceRef[];
      readonly max_bytes: number;
    }): Promise<Result<readonly SupplementAttachment[], ErrorEnvelope>> {
      const attachments: SupplementAttachment[] = [];
      for (const ref of uniqueSourceRefs(input.source_refs)) {
        const resolved = await port.resolve(ref, { maxBytes: input.max_bytes });
        if (!resolved.ok) {
          continue;
        }
        if (!resolved.value.retrievable || resolved.value.bytes === null) {
          continue;
        }
        const bytes = resolved.value.bytes;
        let binary = false;
        for (let index = 0; index < bytes.byteLength; index += 1) {
          if (bytes[index] === 0) {
            binary = true;
            break;
          }
        }
        let text: string | null = null;
        if (!binary) {
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            binary = true;
          }
        }
        attachments.push({
          source_ref: ref,
          text,
          content_hash: hashBytes(bytes),
          byte_length: bytes.byteLength,
          binary
        });
      }
      return ok(attachments);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Supplementer                                                        */
/* ------------------------------------------------------------------ */

interface RunState {
  readonly reads: EvidenceSupplementReadRecord[];
  readonly pruned: EvidenceSupplementPrunedRecord[];
  readonly seenPaths: Set<string>;
  readonly seenContent: Set<Hash>;
  totalBytes: number;
  totalTokens: number;
  totalReads: number;
  budgetCap: boolean;
  stopReason: string;
}

function budgetExhausted(state: RunState, budget: NormalizedBudget, elapsed: number): string | null {
  if (state.totalReads >= budget.max_reads) {
    return "read_count";
  }
  if (state.totalBytes >= budget.max_bytes) {
    return "bytes";
  }
  if (state.totalTokens >= budget.max_tokens) {
    return "tokens";
  }
  if (elapsed >= budget.max_elapsed_ms) {
    return "elapsed_ms";
  }
  return null;
}

function accountBytes(state: RunState, bytes: number): void {
  state.totalBytes += bytes;
  state.totalTokens += Math.ceil(bytes / 4);
  state.totalReads += 1;
}

function recordPruned(
  state: RunState,
  entry: { readonly path_rel: string | null; readonly source_ref: string | null; readonly reason: string }
): void {
  if (state.pruned.length < MAX_PRUNED_PER_ROUND * SUPPLEMENT_MAX_ROUNDS) {
    state.pruned.push(entry);
  }
}

function recordAttachment(
  state: RunState,
  attachment: SupplementAttachment
): void {
  state.reads.push({
    action: "attachment",
    root_id: null,
    path_rel: null,
    source_ref: attachment.source_ref,
    status: attachment.binary ? "binary" : "ok",
    reason_code: attachment.binary ? "binary" : null,
    content_hash: attachment.content_hash,
    byte_length: attachment.byte_length,
    range_start: null,
    range_end: null,
    binary: attachment.binary ? 1 : 0
  });
}

async function readWorkspacePath(
  workspace: Pick<WorkspaceReadPort, "read">,
  pathRel: string,
  state: RunState,
  budget: NormalizedBudget,
  elapsed: () => number
): Promise<boolean> {
  if (budgetExhausted(state, budget, elapsed()) !== null) {
    state.budgetCap = true;
    state.stopReason = budgetExhausted(state, budget, elapsed()) ?? "budget";
    return false;
  }
  const key = pathRel;
  if (state.seenPaths.has(key)) {
    recordPruned(state, { path_rel: pathRel, source_ref: null, reason: "duplicate" });
    return true;
  }
  state.seenPaths.add(key);
  const read = await workspace.read({ path: pathRel, max_bytes: WORKSPACE_READ_MAX_BYTES });
  if (!read.ok) {
    const mapped = statusForError(read.error.code);
    state.reads.push({
      action: "read",
      root_id: null,
      path_rel: pathRel,
      source_ref: null,
      status: mapped.status,
      reason_code: mapped.reason,
      content_hash: null,
      byte_length: 0,
      range_start: null,
      range_end: null,
      binary: 0
    });
    recordPruned(state, { path_rel: pathRel, source_ref: null, reason: mapped.reason });
    return mapped.reason !== "deadline";
  }
  const result = read.value;
  accountBytes(state, result.bytes.byteLength);
  if (state.seenContent.has(result.content_hash)) {
    recordPruned(state, { path_rel: result.path_rel, source_ref: null, reason: "duplicate_content" });
    return true;
  }
  state.seenContent.add(result.content_hash);
  state.reads.push({
    action: "read",
    root_id: result.root_id,
    path_rel: result.path_rel,
    source_ref: null,
    status: result.binary ? "binary" : "ok",
    reason_code: result.binary ? "binary" : null,
    content_hash: result.content_hash,
    byte_length: result.byte_length,
    range_start: result.range.start,
    range_end: result.range.end,
    binary: result.binary ? 1 : 0
  });
  if (result.binary) {
    recordPruned(state, { path_rel: result.path_rel, source_ref: null, reason: "binary" });
  }
  return true;
}

async function listWorkspaceDir(
  workspace: Pick<WorkspaceReadPort, "list">,
  dir: string,
  state: RunState,
  budget: NormalizedBudget,
  elapsed: () => number
): Promise<readonly { readonly name: string; readonly path_rel: string; readonly kind: string }[]> {
  const exhausted = budgetExhausted(state, budget, elapsed());
  if (exhausted !== null) {
    state.budgetCap = true;
    state.stopReason = exhausted;
    return [];
  }
  state.totalReads += 1;
  const listed = await workspace.list({ path_prefix: dir, limit: 200 });
  if (!listed.ok) {
    const mapped = statusForError(listed.error.code);
    state.reads.push({
      action: "list",
      root_id: null,
      path_rel: dir,
      source_ref: null,
      status: mapped.status,
      reason_code: mapped.reason,
      content_hash: null,
      byte_length: 0,
      range_start: null,
      range_end: null,
      binary: 0
    });
    return [];
  }
  state.reads.push({
    action: "list",
    root_id: listed.value.root_id,
    path_rel: listed.value.path_rel,
    source_ref: null,
    status: "ok",
    reason_code: null,
    content_hash: null,
    byte_length: 0,
    range_start: null,
    range_end: null,
    binary: 0
  });
  for (const pruned of listed.value.pruned) {
    recordPruned(state, { path_rel: pruned.path_rel, source_ref: null, reason: pruned.reason });
  }
  return listed.value.entries.map((entry) => ({
    name: entry.name,
    path_rel: entry.path_rel,
    kind: entry.kind
  }));
}

/** Builds the W4 supplementer. */
export function createEvidenceSupplementer(deps: EvidenceSupplementerDeps): EvidenceSupplementer {
  const monotonic = deps.monotonic ?? ((): number => performance.now());

  async function supplement(
    input: EvidenceSupplementInput
  ): Promise<Result<EvidenceSupplementHookOutcomeWithRecord, ErrorEnvelope>> {
    const enabled = input.enabled ?? deps.enabled ?? false;
    if (!enabled) {
      return ok({ outcome: { status: "disabled" }, supplement: null });
    }
    if (!isVersionBinding(input.binding)) {
      return supplementFailure("E_SCHEMA", "binding", "schema");
    }
    if (typeof deps.decide?.decide !== "function") {
      return supplementFailure("E_SUPPLEMENT_UNAVAILABLE", "decide", "internal");
    }
    if (deps.writer === undefined) {
      return supplementFailure("E_SUPPLEMENT_UNAVAILABLE", "writer", "internal");
    }

    const budget = normalizeBudget(input.budget ?? deps.budget);
    const started = monotonic();
    const elapsed = (): number => monotonic() - started;
    const state: RunState = {
      reads: [],
      pruned: [],
      seenPaths: new Set(),
      seenContent: new Set(),
      totalBytes: 0,
      totalTokens: 0,
      totalReads: 0,
      budgetCap: false,
      stopReason: "round_limit"
    };

    let facts = eligibleSupplementFacts(input.binding, input.facts ?? []);
    if (deps.facts !== undefined) {
      const loaded = await deps.facts.read({ binding: input.binding });
      if (!loaded.ok) {
        return err(loaded.error, loaded.status);
      }
      facts = mergeFacts(facts, loaded.value, input.binding);
    }

    const requiredQuestions = input.plan.questions.filter((question) => question.required_for_issue);
    const relevant = requiredQuestions.length > 0 ? requiredQuestions : input.plan.questions;
    const unboundRequired = relevant.some(
      (question) => typeof question.proposition_id !== "string" || question.proposition_id.length === 0
    );
    const questions: SupplementQuestion[] = relevant
      .filter(
        (question) => typeof question.proposition_id === "string" && question.proposition_id.length > 0
      )
      .map((question) => ({
        question_key: question.question_key,
        proposition_id: question.proposition_id as string,
        requirement_ids: [...question.requirement_ids],
        required_for_issue: question.required_for_issue
      }));

    const exactPaths = exactPathCandidates(input);
    const terms = keywordTerms(input, deps.search_terms ?? []);
    const searchRoots = searchRootsFor(input, exactPaths, deps.search_roots);
    const originalFactKeys = new Set((input.aggregate.hard_facts ?? []).map((fact) => fact.fact_key));

    const rounds: EvidenceSupplementRound[] = [];
    let final: {
      readonly decisions: readonly SupplementQuestionDecision[];
      readonly allDecided: boolean;
      readonly factKeys: readonly Hash[];
    } = { decisions: [], allDecided: false, factKeys: [] };

    for (let round = 1; round <= budget.max_rounds; round += 1) {
      const exhausted = budgetExhausted(state, budget, elapsed());
      if (exhausted !== null) {
        state.budgetCap = true;
        state.stopReason = exhausted;
        break;
      }
      const roundReadStart = state.reads.length;
      const roundPrunedStart = state.pruned.length;
      const strategies: string[] = [];

      // 1. Exact association: declared artifact paths first.
      if (exactPaths.length > 0) {
        strategies.push("exact_path");
        if (deps.workspace === undefined) {
          recordPruned(state, {
            path_rel: null,
            source_ref: null,
            reason: "workspace_unavailable"
          });
        } else {
          for (const path of exactPaths) {
            const okToContinue = await readWorkspacePath(
              deps.workspace,
              path,
              state,
              budget,
              elapsed
            );
            if (!okToContinue) {
              break;
            }
          }
        }
      }

      // 2. Attachments: retrievable HOST evidence, the only surface when no
      //    approved root exists.
      const refs = sourceRefsOf(input);
      if (refs.length > 0 && deps.attachments !== undefined) {
        strategies.push("attachment");
        const remainingBytes = Math.max(1, budget.max_bytes - state.totalBytes);
        const attachments = await deps.attachments.read({
          source_refs: refs,
          max_bytes: Math.min(remainingBytes, WORKSPACE_READ_MAX_BYTES)
        });
        if (!attachments.ok) {
          return err(attachments.error, attachments.status);
        }
        for (const attachment of attachments.value) {
          accountBytes(state, attachment.byte_length);
          const duplicate = state.seenContent.has(attachment.content_hash);
          state.seenContent.add(attachment.content_hash);
          if (duplicate) {
            recordPruned(state, {
              path_rel: null,
              source_ref: attachment.source_ref,
              reason: "duplicate_content"
            });
            continue;
          }
          recordAttachment(state, attachment);
        }
      } else if (refs.length > 0) {
        strategies.push("attachment");
        recordPruned(state, {
          path_rel: null,
          source_ref: null,
          reason: "attachments_unavailable"
        });
      }

      // 3. Keyword recall: list only declared/derived directories, never walk
      //    the tree and never scan an arbitrary path.
      if (deps.workspace !== undefined && searchRoots.length > 0) {
        strategies.push("keyword");
        const candidates: string[] = [];
        for (const root of searchRoots) {
          const entries = await listWorkspaceDir(deps.workspace, root, state, budget, elapsed);
          for (const entry of entries) {
            if (entry.kind !== "file") {
              continue;
            }
            const lower = entry.name.toLowerCase();
            if (terms.some((term) => lower.includes(term))) {
              candidates.push(entry.path_rel);
            }
          }
          if (state.budgetCap) {
            break;
          }
        }
        for (const path of candidates.slice(0, MAX_KEYWORD_CANDIDATES)) {
          if (state.budgetCap) {
            break;
          }
          const okToContinue = await readWorkspacePath(
            deps.workspace,
            path,
            state,
            budget,
            elapsed
          );
          if (!okToContinue) {
            break;
          }
        }
      }

      // Facts may have moved while the round ran. Re-read only under the same
      // binding; observations never enter this list.
      if (deps.facts !== undefined) {
        const refreshed = await deps.facts.read({ binding: input.binding });
        if (!refreshed.ok) {
          return err(refreshed.error, refreshed.status);
        }
        facts = mergeFacts(facts, refreshed.value, input.binding);
      }

      final = decisionsFor(deps.decide, questions, facts);
      rounds.push({
        round,
        strategies,
        reads: state.reads.slice(roundReadStart),
        pruned: state.pruned.slice(roundPrunedStart),
        decisions: final.decisions,
        fact_keys: final.factKeys
      });

      if (final.allDecided && !unboundRequired) {
        break;
      }
      const postRound = budgetExhausted(state, budget, elapsed());
      if (postRound !== null) {
        state.budgetCap = true;
        state.stopReason = postRound;
        break;
      }
    }

    const resolved = final.allDecided && !unboundRequired;
    const remainingGaps: SupplementGapView[] = [];
    for (const gap of input.gaps) {
      const affected = gap.affects_question_keys.filter((key) => {
        const decision = final.decisions.find((entry) => entry.question_key === key);
        return decision === undefined || decision.kind !== "decided";
      });
      if (affected.length > 0 || gap.affects_question_keys.length === 0) {
        remainingGaps.push({ ...gap, affects_question_keys: affected });
      }
    }
    const gapCodes = resolved
      ? []
      : remainingGaps.length > 0
        ? remainingGaps.map((gap) => gap.code)
        : input.gaps.map((gap) => gap.code);

    const decision: SupplementDispatchDecision | null = resolved
      ? { kind: "decided", basis: "hard_fact", fact_keys: [...final.factKeys] }
      : gapCodes.length > 0
        ? { kind: "gap", basis: "evidence_missing", gap_codes: gapCodes }
        : { kind: "semantic_required", reason: "supplement_inconclusive" };

    const requiresRepack = resolved
      ? final.factKeys.some((key) => !originalFactKeys.has(key))
      : false;

    const draft: EvidenceSupplementDraft = {
      issue_id: input.issue.issue_id,
      plan_id: input.plan.plan_id,
      plan_hash: input.plan.plan_hash,
      pack_id: input.pack.pack_id,
      pack_key: input.pack.pack_key,
      pack_hash: input.pack.pack_hash,
      aggregate_id: input.aggregate.aggregate_id,
      aggregate_hash: input.aggregate.aggregate_hash,
      gap_codes: gapCodes,
      outcome: resolved ? "resolved" : "insufficient",
      budget_cap: state.budgetCap,
      stop_reason: resolved ? "decided" : state.stopReason,
      decision,
      rounds,
      read_manifest: state.reads,
      pruned: state.pruned,
      requires_repack: requiresRepack
    };

    const appended = await deps.writer.append({ binding: input.binding, draft });
    if (!appended.ok) {
      return appended;
    }
    const supplement = appended.value.row;
    if (resolved && decision !== null && decision.kind === "decided") {
      return ok({
        outcome: {
          status: "resolved",
          decision: {
            kind: "decided",
            basis: "hard_fact",
            fact_keys: [...decision.fact_keys]
          },
          record_id: appended.value.supplement_id,
          requires_repack: requiresRepack
        },
        supplement
      });
    }
    const gaps = remainingGaps.length > 0
      ? remainingGaps.map((gap) => ({
          code: gap.code,
          affects_question_keys: gap.affects_question_keys
        }))
      : gapCodes.map((code) => ({ code, affects_question_keys: [] }));
    return ok({
      outcome: {
        status: "insufficient",
        gaps,
        budget_cap: state.budgetCap,
        record_id: appended.value.supplement_id
      },
      supplement
    });
  }

  return { supplement };
}

/* ------------------------------------------------------------------ */
/* Production factory                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resources the kernel already holds when it composes the online pipeline.
 * Every field is an existing production object; the factory opens no journal,
 * no arbitrary directory and no second SQLite connection.
 */
interface ProductionEvidenceSupplementDeps {
  readonly connection: SqliteConnection;
  /** The EVD read-only connection; omitted falls back to `connection`. */
  readonly read_connection?: SqliteConnection;
  readonly blob_store: BlobStore;
  readonly source_refs: SourceRefPort;
  readonly journal: JournalWriter;
  readonly journal_relative_path: string;
  /** FND live commit port used by the supplement audit rows. */
  readonly commit: Pick<StateRowLiveCommitPort, "commitLiveGated">;
  /** FND root registry; only its live in-memory approvals are used. */
  readonly registry: Pick<RootRegistry, "lookup">;
  /** Explicit roots for tests; production uses `connection` + `registry`. */
  readonly roots?: () => readonly WorkspaceReadRoot[];
  readonly now: () => number;
  readonly monotonic?: () => number;
  readonly enabled?: boolean;
  readonly budget?: SupplementBudgetInput;
  readonly workspace_max_read_bytes?: number;
  readonly search_roots?: readonly string[];
  readonly search_terms?: readonly string[];
  /** Persisted service profile is resolved per rebuild from EVD rows. */
  readonly compiler_version?: string;
  readonly counting_method_version?: string;
}

export interface ProductionEvidenceSupplement {
  readonly workspace: WorkspaceReadPort;
  readonly writer: EvidenceSupplementWriter;
  readonly decide: SupplementDecidePort;
  readonly port: EvidenceSupplementer;
  readonly rebuild: SupplementRebuildPort;
}

const PRODUCTION_COMPILER_VERSION = "evd-compiler/1";
const PRODUCTION_COUNTING_METHOD_VERSION = "utf8-bytes/1";

function rebuildKey(input: {
  readonly binding: VersionBinding;
  readonly plan_id: string;
  readonly plan_hash: Hash;
}): string {
  return [
    input.binding.task_id,
    input.binding.branch_id,
    String(input.binding.input_epoch),
    input.binding.goal_version,
    input.binding.config_version,
    String(input.binding.watermark),
    input.plan_id,
    input.plan_hash
  ].join("|");
}

/**
 * The durable compile an unchanged pack key can be served from.
 *
 * Pack identity deliberately excludes fact effects (a corrected verification
 * changes the aggregate input, not the pack bytes), while the pack row's
 * content hash covers the random `pack_id`. Recompiling therefore produces the
 * same `pack_key` with a different row content hash. Reuse is allowed only
 * after the durable row's blob is independently read back and hash-verified,
 * and its canonical JSON equals the fresh compile byte for byte once the
 * volatile `pack_id` is removed.
 */
interface DurablePackReuse {
  readonly pack: EvidencePack;
  readonly shard_plan_id: string;
  readonly shard_plan_key: Hash;
  readonly has_request_bindings: boolean;
}

function canonicalPackBody(pack: EvidencePack): string | null {
  try {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pack as unknown as Record<string, unknown>)) {
      if (key !== "pack_id") {
        body[key] = value;
      }
    }
    return canonicalJsonText(body as JsonValue);
  } catch {
    return null;
  }
}

/**
 * Reads the durable compile that owns `freshPack.pack_key`, if any.
 *
 * Returns `ok(null)` when no row exists (a genuinely new pack), the reused
 * compile when the durable bytes prove identical, and `E_CONFLICT` when a row
 * exists but cannot be proven to hold the same bytes. A corrupt or divergent
 * durable row is never silently replaced or relabeled.
 */
function readDurablePackReuse(
  connection: SqliteConnection,
  blobStore: BlobStore,
  freshPack: EvidencePack
): Result<DurablePackReuse | null, ErrorEnvelope> {
  const reject = (rule: string): ErrorEnvelope => rebuildFailure("E_CONFLICT", rule);
  const row = connection
    .prepare<SqlRow>("SELECT * FROM evd_evidence_pack WHERE pack_key = :pack_key")
    .get({ pack_key: freshPack.pack_key });
  if (row === undefined) {
    return ok(null);
  }
  if (row["pack_state"] !== "valid") {
    return err(reject("durable_pack_not_valid"));
  }
  const packId = row["pack_id"];
  const packHash = row["pack_hash"];
  const contentHash = row["content_hash"];
  const contentRef = row["content_ref"];
  const contentBytes = row["content_bytes"];
  if (
    typeof packId !== "string" ||
    typeof packHash !== "string" ||
    typeof contentHash !== "string" ||
    typeof contentRef !== "string" ||
    typeof contentBytes !== "number" ||
    !Number.isSafeInteger(contentBytes) ||
    contentBytes < 0 ||
    !isHash(packHash) ||
    !isHash(contentHash)
  ) {
    return err(reject("durable_pack_row_malformed"));
  }
  if (packHash !== freshPack.pack_hash) {
    return err(reject("durable_pack_hash_mismatch"));
  }

  const parsedRef = parseSourceRef(contentRef);
  if (!parsedRef.ok) {
    return err(reject("durable_pack_ref_invalid"));
  }
  if (
    parsedRef.value.scheme !== "blob" ||
    parsedRef.value.start !== 0 ||
    parsedRef.value.end !== contentBytes ||
    typeof parsedRef.value.locator !== "string" ||
    !isHash(parsedRef.value.locator)
  ) {
    return err(reject("durable_pack_ref_invalid"));
  }
  const blob = blobStore.read(parsedRef.value.locator);
  if (!blob.ok) {
    return err(reject("durable_pack_blob_unreadable"));
  }
  const bytes = blob.value;
  if (bytes.byteLength !== contentBytes || hashBytes(bytes) !== contentHash) {
    return err(reject("durable_pack_blob_hash_mismatch"));
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return err(reject("durable_pack_blob_utf8"));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return err(reject("durable_pack_blob_json"));
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return err(reject("durable_pack_blob_json_object"));
  }
  let canonical: string | null = null;
  try {
    canonical = canonicalJsonText(decoded as JsonValue);
  } catch {
    canonical = null;
  }
  if (canonical === null || canonical !== text) {
    return err(reject("durable_pack_blob_not_canonical"));
  }

  const durable = decoded as unknown as EvidencePack;
  if (
    durable.pack_id !== packId ||
    durable.pack_key !== freshPack.pack_key ||
    durable.pack_hash !== freshPack.pack_hash
  ) {
    return err(reject("durable_pack_identity_mismatch"));
  }
  const durableBody = canonicalPackBody(durable);
  const freshBody = canonicalPackBody(freshPack);
  if (durableBody === null || freshBody === null || durableBody !== freshBody) {
    return err(reject("durable_pack_content_mismatch"));
  }

  const planRow = connection
    .prepare<SqlRow>(
      `SELECT shard_plan_id, shard_plan_key, pack_id, pack_key
         FROM evd_shard_plan
        WHERE pack_id = :pack_id
        ORDER BY created_at DESC, shard_plan_id DESC
        LIMIT 1`
    )
    .get({ pack_id: packId });
  if (planRow === undefined) {
    return err(reject("durable_shard_plan_missing"));
  }
  const shardPlanId = planRow["shard_plan_id"];
  const shardPlanKey = planRow["shard_plan_key"];
  if (
    typeof shardPlanId !== "string" ||
    typeof shardPlanKey !== "string" ||
    !isHash(shardPlanKey) ||
    planRow["pack_id"] !== packId ||
    planRow["pack_key"] !== freshPack.pack_key
  ) {
    return err(reject("durable_shard_plan_mismatch"));
  }
  const shardRows = connection
    .prepare<SqlRow>(
      "SELECT request_binding_id FROM evd_shard WHERE shard_plan_id = :shard_plan_id"
    )
    .all({ shard_plan_id: shardPlanId });
  const hasRequestBindings = shardRows.some(
    (shard) =>
      shard["request_binding_id"] !== null && shard["request_binding_id"] !== undefined
  );
  return ok({
    pack: durable,
    shard_plan_id: shardPlanId,
    shard_plan_key: shardPlanKey,
    has_request_bindings: hasRequestBindings
  });
}

/**
 * Builds the complete W4 production surface.
 *
 * Workspace reads come from the live FND root registry, supplement rows go
 * through the shared FND live commit port, and the rebuild primitives reuse
 * the real QP planner load, EVD compiler, evidence writer/reader and answer
 * aggregator. Nothing here re-implements a decision or an aggregation rule.
 */
export function createProductionEvidenceSupplement(
  deps: ProductionEvidenceSupplementDeps
): ProductionEvidenceSupplement {
  const roots =
    deps.roots ??
    createWorkspaceRootsFromRegistry({
      connection: deps.connection,
      registry: deps.registry
    });
  const workspace = createWorkspaceReadPort({
    roots,
    now: deps.now,
    ...(deps.monotonic === undefined ? {} : { monotonic: deps.monotonic }),
    ...(deps.workspace_max_read_bytes === undefined
      ? {}
      : { max_read_bytes: deps.workspace_max_read_bytes })
  });
  const writer = createEvidenceSupplementWriter({ commit: deps.commit, now: deps.now });
  const decide: SupplementDecidePort = {
    decide(question, facts) {
      const decision = decideDispatch(question, facts);
      switch (decision.kind) {
        case "decided":
          return {
            kind: "decided",
            basis: "hard_fact",
            fact_keys: [...decision.fact_keys]
          };
        case "gap":
          return {
            kind: "gap",
            basis: "evidence_missing",
            gap_codes: [...decision.gap_codes]
          };
        case "semantic_required":
          return { kind: "semantic_required", reason: decision.reason };
      }
    }
  };
  const port = createEvidenceSupplementer({
    decide,
    writer,
    workspace,
    attachments: createSourceRefAttachmentSource(deps.source_refs),
    ...(deps.enabled === undefined ? {} : { enabled: deps.enabled }),
    ...(deps.budget === undefined ? {} : { budget: deps.budget }),
    ...(deps.search_roots === undefined ? {} : { search_roots: deps.search_roots }),
    ...(deps.search_terms === undefined ? {} : { search_terms: deps.search_terms }),
    now: deps.now,
    ...(deps.monotonic === undefined ? {} : { monotonic: deps.monotonic })
  });

  const evdWriter = createDefaultEvidenceWriter({
    connection: deps.connection,
    writer: deps.journal,
    relative_path: deps.journal_relative_path,
    blob_store: deps.blob_store,
    now: deps.now
  });
  const reader = createDefaultEvidenceReader({
    connection: deps.connection,
    ...(deps.read_connection === undefined ? {} : { read_connection: deps.read_connection }),
    blobs: deps.blob_store,
    writer: evdWriter.writer
  });
  const bindingReader = createEvidenceBindingReadPort({
    connection: deps.connection,
    blobs: deps.blob_store,
    sources: deps.source_refs
  });
  const monotonic = deps.monotonic ?? ((): number => performance.now());
  const compilerVersion = deps.compiler_version ?? PRODUCTION_COMPILER_VERSION;
  const countingMethodVersion =
    deps.counting_method_version ?? PRODUCTION_COUNTING_METHOD_VERSION;

  const bundles = new Map<string, DefaultQuestionPlannerBundle>();
  const contexts = new Map<
    string,
    {
      readonly ports: ReturnType<typeof createDefaultQuestionEvidencePorts>;
      readonly snapshot: EvidenceIndexSnapshot;
      readonly pack: EvidencePack;
      readonly shard_plan_id: string;
      readonly shard_plan_key: Hash;
      readonly validator_binding_key: Hash;
      readonly has_request_bindings: boolean;
    }
  >();

  async function resolveBinding(): Promise<Result<ResolvedEvidenceBinding, ErrorEnvelope>> {
    const resolved = await resolveDefaultEvidenceBinding(deps.connection, bindingReader);
    if (!resolved.ok) {
      return resolved;
    }
    const profile = resolved.value.service_profile;
    if (profile.schema_version !== "rsi.jev_service_profile/1") {
      return resolved;
    }
    // The resolver returns the persisted body. `planShards` also needs the
    // row identity (`profile_id`), so attach it from the same validated row
    // instead of letting the shard planner mint a fresh id.
    const row = await bindingReader.readServiceProfile({
      profile_key: resolved.value.service_profile_key
    });
    if (!row.ok) {
      return row;
    }
    if (row.value === null) {
      return err(rebuildFailure("E_SUPPLEMENT_UNAVAILABLE", "service_profile_row_missing"));
    }
    return ok({
      ...resolved.value,
      service_profile: {
        ...profile,
        profile_id: row.value.profile_id,
        profile_version: row.value.profile_version,
        created_at: row.value.created_at
      }
    });
  }

  async function loadBundle(
    input: SupplementRebuildSnapshotInput
  ): Promise<Result<DefaultQuestionPlannerBundle, ErrorEnvelope>> {
    return createDefaultQuestionPlanner(
      {
        connection: deps.connection,
        blob_store: deps.blob_store,
        source_refs: deps.source_refs,
        journal: deps.journal,
        journal_relative_path: deps.journal_relative_path,
        now: deps.now
      },
      { binding: input.binding },
      input.signal === undefined ? {} : { signal: input.signal }
    );
  }

  const rebuild = createSupplementRebuildPort({
    async reload_snapshot(input) {
      const loaded = await loadBundle(input);
      if (!loaded.ok) {
        return loaded;
      }
      const snapshot = loaded.value.qp.planner.deps.evidence;
      if (!equalVersionBinding(snapshot.binding, input.binding)) {
        return err(rebuildFailure("E_CONFLICT", "snapshot_binding_changed"));
      }
      bundles.set(rebuildKey(input), loaded.value);
      return ok({ snapshot });
    },
    async rebuild_pack(input) {
      const key = rebuildKey(input);
      const cached = bundles.get(key);
      bundles.delete(key);
      const loaded = cached === undefined ? await loadBundle(input) : ok(cached);
      if (!loaded.ok) {
        return loaded;
      }
      const bundle = loaded.value;
      if (!equalVersionBinding(bundle.binding, input.binding)) {
        return err(rebuildFailure("E_CONFLICT", "planner_binding_changed"));
      }
      const plan = bundle.plans.getPlan(input.plan_id);
      if (plan === null) {
        return err(rebuildFailure("E_SUPPLEMENT_UNAVAILABLE", "plan_not_found"));
      }
      if (
        plan.plan_hash !== input.plan_hash ||
        plan.issue_id !== input.issue_id ||
        !equalVersionBinding(plan.binding, input.binding)
      ) {
        return err(rebuildFailure("E_CONFLICT", "plan_identity_changed"));
      }
      const resolvedBinding = await resolveBinding();
      if (!resolvedBinding.ok) {
        return resolvedBinding;
      }
      const ports = createDefaultQuestionEvidencePorts({
        plans: bundle.plans,
        issues: bundle.issues
      });
      const compiler = createEvidenceCompiler({
        plans: ports.plans,
        plan_states: ports.plan_states,
        issues: ports.issues,
        now: deps.now,
        monotonic_now: monotonic
      });
      const compiled = await compiler.compilePack({
        schema_version: "rsi.pack_compile_input/1",
        plan_id: plan.plan_id as Id,
        plan_hash: plan.plan_hash as Hash,
        issue_id: plan.issue_id as Id,
        issue_key: plan.issue_key,
        binding: input.binding,
        snapshot: input.snapshot,
        service_profile_key: resolvedBinding.value.service_profile_key,
        limits: resolvedBinding.value.limits,
        compiler_version: compilerVersion,
        counting_method_version: countingMethodVersion
      });
      if (!compiled.ok) {
        return compiled;
      }
      // Pack identity does not carry stripped fact effects, so a corrected
      // verification recompiles to the same `pack_key` with a new random
      // `pack_id`. Reuse the durable compile only when its blob is
      // independently verified to be the same bytes; otherwise the rebuild
      // fails closed instead of colliding on the pack row or relabeling
      // different content.
      const reused = readDurablePackReuse(
        deps.connection,
        deps.blob_store,
        compiled.value.pack
      );
      if (!reused.ok) {
        return reused;
      }
      if (reused.value !== null) {
        contexts.set(key, {
          ports,
          snapshot: input.snapshot,
          pack: reused.value.pack,
          shard_plan_id: reused.value.shard_plan_id,
          shard_plan_key: reused.value.shard_plan_key,
          validator_binding_key: resolvedBinding.value.validator_binding_key,
          has_request_bindings: reused.value.has_request_bindings
        });
        return ok({
          pack: reused.value.pack,
          shard_plan_id: reused.value.shard_plan_id,
          shard_plan_key: reused.value.shard_plan_key
        });
      }
      const required = plan.questions
        .filter((question) => question.required_for_issue)
        .map((question) => question.question_key);
      const optional = plan.questions
        .filter((question) => !question.required_for_issue)
        .map((question) => question.question_key);
      const closure = compiler.expandClosure({
        schema_version: "rsi.closure_input/1",
        plan_id: plan.plan_id as Id,
        plan_hash: plan.plan_hash as Hash,
        pack_key: compiled.value.pack.pack_key,
        required_question_keys: required,
        optional_question_keys: optional,
        units: compiled.value.units,
        limits: resolvedBinding.value.limits
      });
      if (!closure.ok) {
        return closure;
      }
      const shards = await compiler.planShards({
        schema_version: "rsi.shard_plan_input/1",
        plan_id: plan.plan_id as Id,
        plan_hash: plan.plan_hash as Hash,
        issue_id: plan.issue_id as Id,
        issue_key: plan.issue_key,
        pack: compiled.value.pack,
        pack_key: compiled.value.pack.pack_key,
        closure: closure.value,
        snapshot: input.snapshot,
        service_profile: resolvedBinding.value.service_profile,
        limits: resolvedBinding.value.limits,
        binding: input.binding,
        shard_policy_version: "per_shard/1"
      });
      if (!shards.ok) {
        return shards;
      }
      const written = await evdWriter.writer.commitCompile({
        binding: input.binding,
        pack: compiled.value.pack,
        units: compiled.value.units,
        manifests: shards.value.manifests,
        shard_plan: shards.value.plan,
        shards: shards.value.shards,
        omissions: shards.value.omissions,
        estimates: shards.value.estimates
      });
      if (!written.ok) {
        return err(written.error);
      }
      contexts.set(key, {
        ports,
        snapshot: input.snapshot,
        pack: compiled.value.pack,
        shard_plan_id: shards.value.plan.shard_plan_id,
        shard_plan_key: shards.value.plan.shard_plan_key,
        validator_binding_key: resolvedBinding.value.validator_binding_key,
        has_request_bindings: shards.value.shards.some(
          (shard) => shard.request_binding_id !== null
        )
      });
      return ok({
        pack: compiled.value.pack,
        shard_plan_id: shards.value.plan.shard_plan_id,
        shard_plan_key: shards.value.plan.shard_plan_key
      });
    },
    async reaggregate(input) {
      const key = rebuildKey(input);
      const context = contexts.get(key);
      contexts.delete(key);
      if (context === undefined) {
        return err(rebuildFailure("E_SUPPLEMENT_UNAVAILABLE", "rebuild_context_missing"));
      }
      const aggregator = createAnswerAggregator({
        plans: context.ports.plan_states,
        state: reader,
        envelopes: reader,
        now: deps.now
      });
      const aggregated = await aggregator.aggregate({
        issue_id: input.issue_id as Id,
        plan_id: input.plan_id as Id,
        plan_hash: input.plan_hash,
        shard_plan_id: context.shard_plan_id as Id,
        shard_plan_key: context.shard_plan_key,
        current_binding: input.binding,
        frozen_snapshot: context.snapshot,
        aggregation_policy_version: "rsi.aggregate/2",
        review_policy_version: "rsi.aggregate.review/1",
        ...(context.has_request_bindings
          ? {}
          : { validator_binding_key: context.validator_binding_key }),
        decided_question_keys: input.decided_question_keys
      });
      if (!aggregated.ok) {
        return aggregated;
      }
      // DD-EVD-025 points a successor at the aggregate it supersedes. The
      // reducer derives that identity from the same input minus hard facts;
      // the online pipeline never commits that hypothetical aggregate (it has
      // one aggregate row per plan), so the pointer can dangle and trip the
      // deferred FK on commit. Keep the pointer only when the row exists.
      const supersedes = aggregated.value.supersedes_aggregate_id;
      if (supersedes === undefined) {
        return aggregated;
      }
      const superseded = deps.connection
        .prepare<SqlRow>("SELECT 1 AS present FROM evd_aggregate WHERE aggregate_id = ?")
        .get([supersedes]);
      if (superseded !== undefined) {
        return aggregated;
      }
      const { supersedes_aggregate_id: _dropped, ...rest } = aggregated.value;
      return ok(rest);
    }
  });

  return { workspace, writer, decide, port, rebuild };
}
