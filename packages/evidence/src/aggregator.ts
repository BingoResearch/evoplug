/**
 * AnswerAggregate reduction (DD-EVD-022, DD-EVD-022A, DD-EVD-023).
 *
 * The reducer is pure: it never calls a backend, never averages scores,
 * confidence or probabilities and never upgrades a semantic shadow to a hard
 * fact. Hard-fact conflicts and clean hard violations dominate coverage gaps;
 * coverage gaps dominate semantic conflicts and unknowns.
 */

import {
  err,
  makeErrorEnvelope,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type Result,
  type SourceRef,
} from "@evoplug/core";

import { evdErr, evdOk } from "./errors.js";

const EMPTY_HASH = `sha256:${"0".repeat(64)}` as const;
import { aggregateHashV1, aggregateHashV2, aggregateKeyV1, aggregateKeyV2, conflictKey, factKey, hardFactViewHash, jcsHash, questionBindingsDigest, semanticContractHash, semanticPolicyHash, semanticValidatorBindingKey, sortUtf8Strings } from "./hashing.js";
import { isEvidenceIndexSnapshot } from "./evidence-index-snapshot.js";
import type { AggregateInput, AggregateInputV2, AggregateMissing, AggregateMissingV2, AggregateShardExpectation, AggregateShardSelection, AggregateShardSelectionV2, AggregateStale, AggregateStaleV2, AggregateCoverage, AggregateConflict, AcceptedAggregateReadPort, AcceptedAggregateReadRequest, AcceptedAggregateReaderDeps, AnswerAggregate, AnswerAggregateV2, AnswerAggregator, AnswerAggregatorDeps, EvdAggregateInputs, EvdError, HardFactUse, JudgeEnvelopeV3, Omission, OptionalObservation, PropositionAggregate, QuestionBinding, RequirementAggregate, SemanticOutcome } from "./types.js";

export interface ReductionEnvelope {
  shard_key: Hash;
  envelope_key: Hash;
  request_hash: Hash;
  dispatch_key: Hash;
  envelope_id: Id;
  received_at: number;
  validation_status: "accepted" | "degraded";
  model_match: "exact" | "alias" | "mismatch" | null;
  capability_key?: Hash;
  capability_hash?: Hash;
  /**
   * `VersionBinding` under which the envelope was produced. DD-EVD-022A/023
   * requires the reducer to tell an outdated binding (`version_mismatch`)
   * apart from the same binding with a different request hash
   * (`request_mismatch`); the persisted `/3` envelope carries this field.
   */
  binding?: import("./types.js").VersionBinding;
  outcomes: Record<string, SemanticOutcome>;
  degraded: boolean;
  backend?: import("./types.js").SemanticBackendRef;
}

export interface HardFactReductionInput {
  fact_key: Hash;
  independence_key: Hash;
  requirement_id: string;
  proposition_id?: string;
  effect: "supports" | "violates";
  artifact_version?: string;
  source_ids: string[];
  source_refs: SourceRef[];
}

export interface ReduceInputV2 {
  input: AggregateInputV2;
  envelopes: ReductionEnvelope[];
  omissions: Omission[];
  hard_facts: HardFactReductionInput[];
  /**
   * The aggregate this one supersedes.
   *
   * DD-EVD-025: "新答案/新硬事实到达后产生新 aggregate，`supersedes_aggregate_id`
   * 指向旧聚合；旧聚合保留，不原地修改." The reducer is pure, so the caller
   * that knows the persisted aggregate history passes the superseded id in.
   */
  supersedes_aggregate_id?: Id;
}

export interface ReduceInputV1 {
  input: AggregateInput;
  envelopes: ReductionEnvelope[];
  omissions: Omission[];
  hard_facts: HardFactReductionInput[];
}

type ReduceInput = ReduceInputV1 | ReduceInputV2;

function isReduceInputV2(input: ReduceInput): input is ReduceInputV2 {
  return input.input.aggregation_policy_version === "rsi.aggregate/2";
}

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Content-addressed local identifier for the pure reducer.
 *
 * The reducer must not consume a clock or entropy (DD-EVD-024), so the local
 * row IDs are derived from the stable semantic key rather than a random ULID.
 * Two reductions of the same input therefore produce byte-identical rows.
 */
function contentId<P extends "agg" | "svcp">(prefix: P, key: Hash): Id<P> {
  const hex = key.startsWith("sha256:") ? key.slice("sha256:".length) : key;
  let bits = BigInt(`0x${hex.length > 0 ? hex : "0"}`);
  bits &= (1n << 130n) - 1n;
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_ALPHABET[Number(bits & 31n)] + encoded;
    bits >>= 5n;
  }
  return `${prefix}:${encoded}` as Id<P>;
}

function questionBindingsByKey(bindings: readonly QuestionBinding[]): Map<string, QuestionBinding> {
  return new Map(bindings.map((binding) => [binding.question_key, binding]));
}

function requiredQuestionKeys(bindings: readonly QuestionBinding[]): string[] {
  return sortUtf8Strings(
    bindings.filter((binding) => binding.required_for_issue).map((binding) => binding.question_key)
  );
}

/**
 * A question is "cleanly decided by hard facts" when every one of its
 * requirements has exactly one side of verified evidence for the same
 * proposition. Two-sided evidence is a conflict, not a decision, and a
 * missing requirement cannot borrow another requirement's fact.
 *
 * This mirrors the dispatch layer's rule (W3) without importing it into the
 * pure reducer; the reducer still owns the final word on coverage.
 */
function cleanHardDecision(
  question: QuestionBinding,
  facts: readonly HardFactReductionInput[]
): boolean {
  if (question.proposition_id.trim().length === 0) {
    return false;
  }
  const requirements = sortUtf8Strings([
    ...new Set(question.requirement_ids.filter((value) => value.trim().length > 0))
  ]);
  if (requirements.length === 0) {
    return false;
  }
  // The question asks about one proposition. If that proposition is supported
  // under one requirement and violated under another, the question is
  // conflicted even though each requirement is one-sided on its own.
  const propositionFacts = facts.filter(
    (fact) =>
      fact.proposition_id === question.proposition_id &&
      requirements.includes(fact.requirement_id)
  );
  if (
    propositionFacts.some((fact) => fact.effect === "supports") &&
    propositionFacts.some((fact) => fact.effect === "violates")
  ) {
    return false;
  }
  for (const requirementId of requirements) {
    const scoped = facts.filter(
      (fact) =>
        fact.requirement_id === requirementId &&
        fact.proposition_id === question.proposition_id
    );
    const supports = scoped.filter((fact) => fact.effect === "supports");
    const violates = scoped.filter((fact) => fact.effect === "violates");
    if (supports.length === 0 && violates.length === 0) {
      return false;
    }
    if (supports.length > 0 && violates.length > 0) {
      return false;
    }
  }
  return true;
}

/**
 * Honours a caller's deterministic decision only when the frozen hard facts
 * prove it. Unproven keys are dropped, so the existing missing/coverage gate
 * is never weakened by a bad claim.
 */
function validatedDecidedQuestionKeys(input: ReduceInput): string[] {
  const requested = isReduceInputV2(input) ? input.input.decided_question_keys ?? [] : [];
  if (requested.length === 0) {
    return [];
  }
  const bindings = questionBindingsByKey(input.input.question_bindings);
  const accepted = new Set<string>();
  for (const key of requested) {
    const binding = bindings.get(key);
    if (binding === undefined || !binding.required_for_issue) {
      continue;
    }
    if (cleanHardDecision(binding, input.hard_facts)) {
      accepted.add(key);
    }
  }
  return sortUtf8Strings([...accepted]);
}

function cleanViolation(
  facts: readonly HardFactReductionInput[],
  requirementId: string,
  propositionId: string | undefined
): boolean {
  const relevant = facts.filter(
    (fact) =>
      fact.requirement_id === requirementId &&
      fact.proposition_id === propositionId &&
      fact.effect === "violates"
  );
  if (relevant.length === 0) {
    return false;
  }
  const supports = facts.filter(
    (fact) =>
      fact.requirement_id === requirementId &&
      fact.proposition_id === propositionId &&
      fact.effect === "supports"
  );
  for (const violation of relevant) {
    const conflicting = supports.some(
      (support) => support.independence_key !== violation.independence_key
    );
    if (!conflicting) {
      return true;
    }
  }
  return false;
}

function hardConflict(
  facts: readonly HardFactReductionInput[]
): boolean {
  const supports = facts.filter((fact) => fact.effect === "supports");
  const violates = facts.filter((fact) => fact.effect === "violates");
  for (const support of supports) {
    for (const violation of violates) {
      if (
        support.requirement_id === violation.requirement_id &&
        support.proposition_id === violation.proposition_id &&
        support.independence_key !== violation.independence_key
      ) {
        return true;
      }
    }
  }
  return false;
}

function sameSourceConflict(facts: readonly HardFactReductionInput[]): boolean {
  const supports = facts.filter((fact) => fact.effect === "supports");
  const violates = facts.filter((fact) => fact.effect === "violates");
  for (const support of supports) {
    for (const violation of violates) {
      if (
        support.requirement_id === violation.requirement_id &&
        support.proposition_id === violation.proposition_id &&
        support.independence_key === violation.independence_key
      ) {
        return true;
      }
    }
  }
  return false;
}

interface SelectionResult {
  selections: AggregateShardSelectionV2[];
  stale: AggregateStaleV2[];
  selectedEnvelopes: ReductionEnvelope[];
  selectedEnvelopeKeys: Hash[];
}

/**
 * DD-EVD-023 input filter: an envelope is only reusable when the binding it
 * was produced under still matches the current task/branch/input_epoch/goal/
 * config. A mismatching binding is `version_mismatch`; only an envelope on the
 * current binding can be `request_mismatch`.
 */
function staleReasonForEnvelope(
  envelope: ReductionEnvelope,
  current: import("./types.js").VersionBinding,
  expectation: AggregateShardExpectation
): AggregateStaleV2["reason"] | null {
  const produced = envelope.binding;
  if (produced !== undefined) {
    if (
      produced.task_id !== current.task_id ||
      produced.branch_id !== current.branch_id ||
      produced.input_epoch !== current.input_epoch ||
      produced.goal_version !== current.goal_version ||
      produced.config_version !== current.config_version
    ) {
      return "version_mismatch";
    }
    if (produced.watermark > current.watermark) {
      return "future_watermark";
    }
  }
  if (
    expectation.expected_request_hash !== null &&
    envelope.request_hash !== expectation.expected_request_hash
  ) {
    return "request_mismatch";
  }
  if (
    expectation.expected_dispatch_key !== null &&
    envelope.dispatch_key !== expectation.expected_dispatch_key
  ) {
    return "dispatch_mismatch";
  }
  return null;
}

function selectEnvelopes(input: ReduceInput): SelectionResult {
  const backend = isReduceInputV2(input) ? input.input.backend : null;
  const selections: AggregateShardSelectionV2[] = [];
  const stale: AggregateStaleV2[] = [];
  const selectedEnvelopes: ReductionEnvelope[] = [];
  const selectedEnvelopeKeys: Hash[] = [];
  const byShard = new Map<Hash, ReductionEnvelope[]>();
  for (const envelope of input.envelopes) {
    const bucket = byShard.get(envelope.shard_key);
    if (bucket === undefined) {
      byShard.set(envelope.shard_key, [envelope]);
    } else {
      bucket.push(envelope);
    }
  }
  for (const expectation of input.input.shard_expectations) {
    const candidates = (byShard.get(expectation.shard_key) ?? []).sort((a, b) => {
      if (a.received_at !== b.received_at) {
        return a.received_at - b.received_at;
      }
      return a.envelope_id < b.envelope_id ? -1 : 1;
    });
    const first = candidates[0];
    // DD-EVD-022A: a shard whose only envelope is a legacy `/2` envelope is
    // discarded. The legacy envelope never fills the current answer; the
    // shard's questions enter `stale_discarded` with reason
    // `legacy_envelope` and count as missing.
    const legacyShard =
      first === undefined &&
      (isReduceInputV2(input)
        ? input.input.legacy_envelope_shard_keys ?? []
        : []
      ).includes(expectation.shard_key);
    if (first === undefined && legacyShard) {
      for (const questionKey of expectation.question_keys) {
        stale.push({
          question_key: questionKey,
          shard_key: expectation.shard_key,
          rejected_binding: input.input.version_binding,
          current_binding: input.input.version_binding,
          reason: "legacy_envelope",
        });
      }
      selections.push({
        shard_id: expectation.shard_id,
        shard_key: expectation.shard_key,
        request_hash: expectation.expected_request_hash ?? EMPTY_HASH,
        dispatch_key: expectation.expected_dispatch_key ?? EMPTY_HASH,
        envelope_id: null,
        envelope_key: null,
        attempt_id: null,
        validation_status: "stale",
        model_match: null,
        selected: false,
        reason_codes: ["legacy_envelope"],
        envelope_schema_version: null,
        capability_key: null,
        capability_hash: null,
      });
      continue;
    }
    if (first === undefined) {
      selections.push({
        shard_id: expectation.shard_id,
        shard_key: expectation.shard_key,
        request_hash: expectation.expected_request_hash ?? EMPTY_HASH,
        dispatch_key: expectation.expected_dispatch_key ?? EMPTY_HASH,
        envelope_id: null,
        envelope_key: null,
        attempt_id: null,
        validation_status: "missing",
        model_match: null,
        selected: false,
        reason_codes: ["missing_envelope"],
        envelope_schema_version: null,
        capability_key: null,
        capability_hash: null,
      });
      continue;
    }
    const staleReason = staleReasonForEnvelope(first, input.input.version_binding, expectation);
    if (staleReason !== null) {
      const rejectedBinding = first.binding ?? input.input.version_binding;
      for (const questionKey of expectation.question_keys) {
        stale.push({
          question_key: questionKey,
          shard_key: expectation.shard_key,
          rejected_binding: rejectedBinding,
          current_binding: input.input.version_binding,
          reason: staleReason,
        });
      }
      selections.push({
        shard_id: expectation.shard_id,
        shard_key: expectation.shard_key,
        request_hash: expectation.expected_request_hash ?? first.request_hash,
        dispatch_key: expectation.expected_dispatch_key ?? first.dispatch_key,
        envelope_id: first.envelope_id,
        envelope_key: first.envelope_key,
        attempt_id: null,
        validation_status: "stale",
        model_match: first.model_match,
        selected: false,
        reason_codes: [staleReason],
        envelope_schema_version: "rsi.judge_envelope/3",
        capability_key: first.capability_key ?? null,
        capability_hash: first.capability_hash ?? null,
      });
      continue;
    }
    if (
      backend !== null &&
      ((first.capability_key !== undefined && first.capability_key !== backend.capability_key) ||
        (first.capability_hash !== undefined && first.capability_hash !== backend.capability_hash))
    ) {
      for (const questionKey of expectation.question_keys) {
        stale.push({
          question_key: questionKey,
          shard_key: expectation.shard_key,
          rejected_binding: input.input.version_binding,
          current_binding: input.input.version_binding,
          reason: "capability_mismatch",
        });
      }
      continue;
    }
    selections.push({
      shard_id: expectation.shard_id,
      shard_key: expectation.shard_key,
      request_hash: first.request_hash,
      dispatch_key: first.dispatch_key,
      envelope_id: first.envelope_id,
      envelope_key: first.envelope_key,
      attempt_id: null,
      validation_status: first.validation_status,
      model_match: first.model_match,
      selected: !first.degraded,
      reason_codes: first.degraded ? ["degraded"] : [],
      envelope_schema_version: "rsi.judge_envelope/3",
      capability_key: first.capability_key ?? backend?.capability_key ?? null,
      capability_hash: first.capability_hash ?? backend?.capability_hash ?? null,
    });
    if (!first.degraded) {
      selectedEnvelopes.push(first);
      selectedEnvelopeKeys.push(first.envelope_key);
    }
  }
  return { selections, stale, selectedEnvelopes, selectedEnvelopeKeys };
}

function buildCoverage(
  input: ReduceInput,
  required: readonly string[],
  selections: readonly AggregateShardSelectionV2[],
  stale: readonly AggregateStaleV2[],
  decidedQuestionKeys: readonly string[] = []
): AggregateCoverage {
  const accepted = new Set<string>();
  const decided = new Set(decidedQuestionKeys);
  const degraded = new Set<string>();
  const missing = new Set<string>();
  const staleSet = new Set<string>();
  const budget = new Set<string>();
  const projection = new Set<string>();
  const byShard = new Map(selections.map((selection) => [selection.shard_key, selection]));
  for (const expectation of input.input.shard_expectations) {
    const selection = byShard.get(expectation.shard_key);
    for (const questionKey of expectation.question_keys) {
      // A question the deterministic layer settled from verified hard facts
      // needs no envelope. Without this guard every short-circuited shard
      // would report its questions as missing and the hard decision would
      // never reach `decideFinal`.
      if (decided.has(questionKey)) {
        accepted.add(questionKey);
        continue;
      }
      if (expectation.binding_status === "budget_rejected") {
        budget.add(questionKey);
        missing.add(questionKey);
        continue;
      }
      if (expectation.binding_status === "projection_rejected") {
        projection.add(questionKey);
        missing.add(questionKey);
        continue;
      }
      if (selection === undefined || selection.validation_status === "missing") {
        // DD-EVD-022A: a legacy `/2` envelope's questions enter `missing` as
        // well as `stale_discarded`; the old envelope never fills them.
        const legacyEntry = stale.find(
          (entry) => entry.question_key === questionKey && entry.reason === "legacy_envelope"
        );
        if (legacyEntry !== undefined) {
          staleSet.add(questionKey);
          missing.add(questionKey);
        } else if (stale.some((entry) => entry.question_key === questionKey)) {
          staleSet.add(questionKey);
        } else {
          missing.add(questionKey);
        }
        continue;
      }
      if (selection.validation_status === "stale") {
        staleSet.add(questionKey);
        // DD-EVD-022A: a legacy `/2` envelope's questions also enter
        // `missing`; the old envelope never fills the current answer.
        if (
          stale.some(
            (entry) => entry.question_key === questionKey && entry.reason === "legacy_envelope"
          )
        ) {
          missing.add(questionKey);
        }
        continue;
      }
      if (selection.validation_status === "degraded") {
        degraded.add(questionKey);
        continue;
      }
      accepted.add(questionKey);
    }
  }
  for (const questionKey of required) {
    if (!accepted.has(questionKey) && !degraded.has(questionKey) && !missing.has(questionKey)) {
      if (staleSet.has(questionKey)) {
        continue;
      }
      missing.add(questionKey);
    }
  }
  const complete = required.every((key) => accepted.has(key)) && missing.size === 0 && degraded.size === 0 && staleSet.size === 0;
  return {
    required_question_keys: sortUtf8Strings(required),
    accepted_question_keys: sortUtf8Strings([...accepted]),
    degraded_question_keys: sortUtf8Strings([...degraded]),
    missing_question_keys: sortUtf8Strings([...missing]),
    stale_question_keys: sortUtf8Strings([...staleSet]),
    budget_rejected_question_keys: sortUtf8Strings([...budget]),
    projection_rejected_question_keys: sortUtf8Strings([...projection]),
    complete,
  };
}

/**
 * The `E_SEMANTIC_*` shard reasons and the `AggregateMissingV2.kind` they
 * map onto (DD-EVD-022A, DD-EVD-021).
 */
const SEMANTIC_MISSING_KINDS: Readonly<Record<string, AggregateMissingV2["kind"]>> = {
  E_SEMANTIC_BACKEND_UNKNOWN: "backend_unknown",
  E_SEMANTIC_SCOPE_UNSUPPORTED: "scope_unsupported",
  E_SEMANTIC_CONTRACT_UNSUPPORTED: "contract_unsupported",
  E_SEMANTIC_OUTPUT_INVALID: "output_invalid",
};

/**
 * `output_invalid` is recoverable (the backend answered but the output was
 * invalid); the three pre-send failures are not, because they need a
 * different backend, a different scope or a different contract.
 */
const SEMANTIC_MISSING_RECOVERABLE: Readonly<
  Partial<Record<AggregateMissingV2["kind"], boolean>>
> = {
  backend_unknown: false,
  scope_unsupported: false,
  contract_unsupported: false,
  output_invalid: true,
};

function buildMissing(inputs: {
  input: ReduceInput;
  coverage: AggregateCoverage;
  stale: readonly AggregateStaleV2[];
  omissions: readonly Omission[];
  /** The `/1` aggregate keeps the closed `/1` kind set. */
  semanticKinds?: boolean;
}): AggregateMissingV2[] {
  const bindings = questionBindingsByKey(inputs.input.input.question_bindings);
  const missing: AggregateMissingV2[] = [];
  const push = (
    questionKey: string,
    kind: AggregateMissingV2["kind"],
    recoverable: boolean
  ): void => {
    const binding = bindings.get(questionKey);
    const omissionKeys = inputs.omissions
      .filter((omission) => omission.question_keys.includes(questionKey))
      .map((omission) => omission.omission_key);
    const sourceRefs = inputs.omissions
      .filter((omission) => omission.question_keys.includes(questionKey))
      .flatMap((omission) => omission.source_refs);
    missing.push({
      question_key: questionKey,
      shard_key: null,
      kind,
      required_for_issue: binding?.required_for_issue ?? true,
      recoverable,
      omission_keys: sortUtf8Strings(omissionKeys) as Hash[],
      source_refs: sortUtf8Strings(sourceRefs) as SourceRef[],
    });
  };
  const recoverableFor = (questionKey: string, fallback: boolean): boolean => {
    const related = inputs.omissions.filter((omission) =>
      omission.question_keys.includes(questionKey)
    );
    return related.some((omission) => omission.recoverable === false) ? false : fallback;
  };
  // DD-EVD-022A: an `E_SEMANTIC_*` shard reason maps onto the matching
  // `AggregateMissingV2.kind`. `output_invalid` is recoverable; the three
  // pre-send failures are not, because they need a different backend, a
  // different scope or a different contract.
  const semanticKindFor = (questionKey: string): AggregateMissingV2["kind"] | null => {
    if (inputs.semanticKinds !== true) {
      return null;
    }
    const expectation = inputs.input.input.shard_expectations.find((entry) =>
      entry.question_keys.includes(questionKey)
    );
    for (const code of expectation?.reason_codes ?? []) {
      const kind = SEMANTIC_MISSING_KINDS[code];
      if (kind !== undefined) {
        return kind;
      }
    }
    return null;
  };
  for (const key of inputs.coverage.budget_rejected_question_keys) {
    // A budget rejection is a planning outcome; re-planning with a larger
    // budget can recover it, so it never makes a gap irrecoverable.
    push(key, "budget_rejected", true);
  }
  for (const key of inputs.coverage.projection_rejected_question_keys) {
    push(key, "projection_rejected", recoverableFor(key, false));
  }
  for (const key of inputs.coverage.degraded_question_keys) {
    push(key, "degraded", recoverableFor(key, true));
  }
  for (const key of inputs.coverage.missing_question_keys) {
    // Budget/projection rejections already carry their specific kind; do not
    // also record them as a generic missing shard.
    if (
      inputs.coverage.budget_rejected_question_keys.includes(key) ||
      inputs.coverage.projection_rejected_question_keys.includes(key)
    ) {
      continue;
    }
    const semanticKind = semanticKindFor(key);
    if (semanticKind !== null) {
      push(
        key,
        semanticKind,
        recoverableFor(key, SEMANTIC_MISSING_RECOVERABLE[semanticKind] ?? false)
      );
      continue;
    }
    push(key, "missing_shard", recoverableFor(key, true));
  }
  for (const entry of inputs.stale) {
    push(entry.question_key, "stale", recoverableFor(entry.question_key, true));
  }
  return missing.sort((a, b) => {
    if (a.question_key !== b.question_key) {
      return a.question_key < b.question_key ? -1 : 1;
    }
    return a.kind < b.kind ? -1 : 1;
  });
}

function buildPropositions(
  input: ReduceInput,
  coverage: AggregateCoverage,
  selectedEnvelopes: readonly ReductionEnvelope[]
): PropositionAggregate[] {
  const bindings = questionBindingsByKey(input.input.question_bindings);
  const groups = new Map<string, { requirementIds: string[]; questionKeys: string[] }>();
  for (const binding of input.input.question_bindings) {
    for (const requirementId of binding.requirement_ids) {
      const key = `${binding.proposition_id}|${requirementId}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          requirementIds: [requirementId],
          questionKeys: [binding.question_key],
        });
      } else {
        if (!group.questionKeys.includes(binding.question_key)) {
          group.questionKeys.push(binding.question_key);
        }
      }
    }
  }
  const semanticByKey = new Map<string, SemanticOutcome>();
  // DD-EVD-023: "绑定或版本不符的答案整题淘汰，记 `stale_discarded`；其文本
  // 即使与当前答案相同也不复用." Only the selected envelopes contribute
  // semantic outcomes; a discarded envelope never fills a proposition.
  for (const envelope of selectedEnvelopes) {
    for (const [questionKey, outcome] of Object.entries(envelope.outcomes)) {
      if (!semanticByKey.has(questionKey)) {
        semanticByKey.set(questionKey, outcome);
      }
    }
  }
  const results: PropositionAggregate[] = [];
  for (const [key, group] of groups) {
    const [propositionId] = key.split("|");
    if (propositionId === undefined) {
      continue;
    }
    const semantic = {
      supports: [] as string[],
      contradicts: [] as string[],
      unknown: [] as string[],
      not_applicable: [] as string[],
    };
    const evidenceRefs = new Set<SourceRef>();
    for (const questionKey of group.questionKeys) {
      const outcome = semanticByKey.get(questionKey);
      if (outcome === undefined) {
        continue;
      }
      switch (outcome.effect) {
        case "supports":
          semantic.supports.push(questionKey);
          break;
        case "contradicts":
          semantic.contradicts.push(questionKey);
          break;
        case "not_applicable":
          semantic.not_applicable.push(questionKey);
          break;
        default:
          semantic.unknown.push(questionKey);
      }
      for (const ref of [...outcome.evidence_refs, ...outcome.counterevidence_refs]) {
        evidenceRefs.add(ref);
      }
    }
    const hard = input.hard_facts.filter(
      (fact) =>
        fact.proposition_id === propositionId &&
        group.requirementIds.includes(fact.requirement_id)
    );
    const hardSupports = sortUtf8Strings(hard.filter((f) => f.effect === "supports").map((f) => f.fact_key)) as Hash[];
    const hardViolates = sortUtf8Strings(hard.filter((f) => f.effect === "violates").map((f) => f.fact_key)) as Hash[];
    const required = group.questionKeys.some((questionKey) => bindings.get(questionKey)?.required_for_issue === true);
    const missing = group.questionKeys.some((questionKey) =>
      coverage.missing_question_keys.includes(questionKey) ||
      coverage.stale_question_keys.includes(questionKey) ||
      coverage.degraded_question_keys.includes(questionKey) ||
      coverage.budget_rejected_question_keys.includes(questionKey) ||
      coverage.projection_rejected_question_keys.includes(questionKey)
    );
    const hasConflict = hardConflict(hard);
    let result: PropositionAggregate["result"];
    let resolvedBy: PropositionAggregate["resolved_by"] = "none";
    if (hasConflict || sameSourceConflict(hard)) {
      result = "conflict";
    } else if (cleanViolation(hard, group.requirementIds[0] ?? "", propositionId)) {
      result = "contradicted_hard";
    } else if (semantic.supports.length > 0 && semantic.contradicts.length > 0) {
      result = "conflict";
    } else if (missing && required) {
      result = "missing";
    } else if (hardSupports.length > 0) {
      // A verified hard support outranks a semantic contradiction: the hard
      // fact is the stronger basis for the proposition.
      result = "supported_hard";
      resolvedBy = "hard_support";
    } else if (semantic.supports.length > 0) {
      result = "supported_semantic";
    } else if (semantic.contradicts.length > 0) {
      result = "contradicted_semantic";
    } else if (semantic.unknown.length > 0 || semantic.not_applicable.length > 0) {
      result = "unknown";
    } else {
      result = "missing";
    }
    results.push({
      proposition_id: propositionId,
      requirement_ids: sortUtf8Strings(group.requirementIds),
      question_keys: sortUtf8Strings(group.questionKeys),
      semantic_effects: {
        supports: sortUtf8Strings(semantic.supports),
        contradicts: sortUtf8Strings(semantic.contradicts),
        unknown: sortUtf8Strings(semantic.unknown),
        not_applicable: sortUtf8Strings(semantic.not_applicable),
      },
      hard_effects: { supports: hardSupports, violates: hardViolates },
      result,
      resolved_by: resolvedBy,
      evidence_refs: sortUtf8Strings([...evidenceRefs]) as SourceRef[],
    });
  }
  return results.sort((a, b) => {
    if (a.proposition_id !== b.proposition_id) {
      return a.proposition_id < b.proposition_id ? -1 : 1;
    }
    return a.requirement_ids.join(",") < b.requirement_ids.join(",") ? -1 : 1;
  });
}

function buildRequirements(
  propositions: readonly PropositionAggregate[],
  hardFacts: readonly HardFactReductionInput[]
): RequirementAggregate[] {
  const ids = new Set<string>([
    ...propositions.flatMap((proposition) => proposition.requirement_ids),
    ...hardFacts.map((fact) => fact.requirement_id),
  ]);
  const results: RequirementAggregate[] = [];
  for (const requirementId of sortUtf8Strings([...ids])) {
    const related = propositions.filter((proposition) =>
      proposition.requirement_ids.includes(requirementId)
    );
    const hard = hardFacts.filter((fact) => fact.requirement_id === requirementId);
    const hardSupports = sortUtf8Strings(
      hard.filter((fact) => fact.effect === "supports").map((fact) => fact.fact_key)
    ) as Hash[];
    const hardViolates = sortUtf8Strings(
      hard.filter((fact) => fact.effect === "violates").map((fact) => fact.fact_key)
    ) as Hash[];
    const sameSource = new Set<Hash>();
    for (const support of hard.filter((fact) => fact.effect === "supports")) {
      for (const violation of hard.filter((fact) => fact.effect === "violates")) {
        if (support.independence_key === violation.independence_key) {
          sameSource.add(support.independence_key);
        }
      }
    }
    const hasConflict = hardConflict(hard) || sameSource.size > 0;
    let finalState: RequirementAggregate["final_state"];
    let basis: RequirementAggregate["basis"];
    const reasonCodes: string[] = [];
    if (hasConflict) {
      finalState = "abstain";
      basis = "hard_fact";
      reasonCodes.push("hard_fact_conflict");
    } else if (cleanViolation(hard, requirementId, undefined)) {
      finalState = "inconsistent";
      basis = "hard_fact";
    } else if (related.some((proposition) => proposition.result === "missing")) {
      finalState = "needs_evidence";
      basis = null;
    } else if (related.some((proposition) => proposition.result === "conflict")) {
      finalState = "abstain";
      basis = "semantic_shadow";
      reasonCodes.push("semantic_conflict");
    } else if (related.some((proposition) => proposition.result === "unknown")) {
      finalState = "unknown";
      basis = "semantic_shadow";
      reasonCodes.push("semantic_unknown");
    } else if (related.some((proposition) => proposition.result === "contradicted_semantic" || proposition.result === "contradicted_hard")) {
      finalState = "inconsistent";
      basis = related.every((proposition) => proposition.result === "contradicted_hard")
        ? "hard_fact"
        : "semantic_shadow";
    } else if (related.length > 0 && related.every((proposition) => proposition.result === "supported_hard")) {
      finalState = "consistent";
      basis = "hard_fact";
    } else if (related.length > 0 && related.every((proposition) => proposition.result === "supported_semantic" || proposition.result === "supported_hard")) {
      finalState = "consistent";
      basis = related.some((proposition) => proposition.result === "supported_hard")
        ? "mixed"
        : "semantic_shadow";
    } else if (hardSupports.length > 0 && hardViolates.length === 0) {
      finalState = "consistent";
      basis = "hard_fact";
    } else {
      finalState = "unknown";
      basis = null;
    }
    results.push({
      requirement_id: requirementId,
      proposition_ids: sortUtf8Strings(related.map((proposition) => proposition.proposition_id)),
      hard_effects: {
        supports: hardSupports,
        violates: hardViolates,
        same_source_conflicts: sortUtf8Strings([...sameSource]) as Hash[],
      },
      final_state: finalState,
      basis,
      reason_codes: sortUtf8Strings(reasonCodes),
    });
  }
  return results;
}

function buildConflicts(
  propositions: readonly PropositionAggregate[],
  hardFacts: readonly HardFactReductionInput[],
  envelopes: readonly ReductionEnvelope[]
): AggregateConflict[] {
  const conflicts: AggregateConflict[] = [];
  for (const proposition of propositions) {
    if (proposition.semantic_effects.supports.length === 0 || proposition.semantic_effects.contradicts.length === 0) {
      continue;
    }
    const sides: AggregateConflict["sides"] = [];
    for (const envelope of envelopes) {
      for (const questionKey of proposition.question_keys) {
        const outcome = envelope.outcomes[questionKey];
        if (outcome === undefined) {
          continue;
        }
        if (outcome.effect === "supports" || outcome.effect === "contradicts") {
          if (!sides.some((side) => side.question_key === questionKey && side.envelope_key === envelope.envelope_key)) {
            sides.push({
              question_key: questionKey,
              envelope_key: envelope.envelope_key,
              effect: outcome.effect,
            });
          }
        }
      }
    }
    const hard = hardFacts.filter(
      (fact) => fact.proposition_id === proposition.proposition_id
    );
    let resolution: AggregateConflict["resolution"] = "unresolved";
    if (hard.some((fact) => fact.effect === "supports")) {
      resolution = "resolved_hard_support";
    } else if (hard.some((fact) => fact.effect === "violates")) {
      resolution = "resolved_hard_violation";
    }
    conflicts.push({
      conflict_key: conflictKey({
        proposition_id: proposition.proposition_id,
        requirement_ids: proposition.requirement_ids,
        sides: sides.map((side) => ({
          question_key: side.question_key,
          envelope_key: side.envelope_key,
          effect: side.effect,
        })),
      }),
      proposition_id: proposition.proposition_id,
      requirement_ids: proposition.requirement_ids,
      sides: sides.sort((a, b) => (a.question_key < b.question_key ? -1 : 1)),
      resolution,
      reason_codes: resolution === "unresolved" ? ["semantic_conflict"] : [],
    });
  }
  return conflicts.sort((a, b) => (a.conflict_key < b.conflict_key ? -1 : 1));
}

interface FinalDecision {
  final_state: AnswerAggregateV2["final_state"];
  final_basis: AnswerAggregateV2["final_basis"];
  local_action: AnswerAggregateV2["local_action"];
  human_review_candidate: boolean;
  human_review_reasons: AnswerAggregateV2["human_review_reasons"];
  reason_codes: string[];
  coverage_complete: boolean;
}

function decideFinal(input: {
  required: readonly string[];
  propositions: readonly PropositionAggregate[];
  requirements: readonly RequirementAggregate[];
  conflicts: readonly AggregateConflict[];
  missing: readonly AggregateMissingV2[];
  coverage: AggregateCoverage;
  hardFacts: readonly HardFactReductionInput[];
  questionBindings: readonly QuestionBinding[];
}): FinalDecision {
  const requiredSet = new Set(input.required);
  const requiredPropositions = input.propositions.filter((proposition) =>
    proposition.question_keys.some((questionKey) => requiredSet.has(questionKey))
  );
  const hardConflictNow = input.requirements.some(
    (requirement) =>
      requirement.hard_effects.same_source_conflicts.length > 0 ||
      (requirement.hard_effects.supports.length > 0 && requirement.hard_effects.violates.length > 0)
  );
  // The question names one proposition. Contradictory hard sides split across
  // its requirements are the same conflict as a two-sided single requirement:
  // R1 supports and R2 violates cannot produce a decided violation.
  const propositionConflictNow = input.questionBindings.some((binding) => {
    if (!requiredSet.has(binding.question_key)) {
      return false;
    }
    const scoped = input.hardFacts.filter(
      (fact) =>
        fact.proposition_id === binding.proposition_id &&
        binding.requirement_ids.includes(fact.requirement_id)
    );
    return (
      scoped.some((fact) => fact.effect === "supports") &&
      scoped.some((fact) => fact.effect === "violates")
    );
  });
  const cleanViolationNow = input.requirements.some(
    (requirement) =>
      requirement.final_state === "inconsistent" && requirement.basis === "hard_fact"
  );
  const requiredMissing = input.missing.filter((entry) => entry.required_for_issue);
  const hasMissing = requiredMissing.length > 0 || !input.coverage.complete;
  const allRecoverable = requiredMissing.every((entry) => entry.recoverable);
  if (hardConflictNow || propositionConflictNow) {
    return {
      final_state: "abstain",
      final_basis: "hard_fact",
      local_action: "record_only",
      human_review_candidate: true,
      human_review_reasons: ["hard_fact_conflict"],
      reason_codes: ["hard_fact_conflict"],
      coverage_complete: input.coverage.complete,
    };
  }
  if (cleanViolationNow) {
    return {
      final_state: "inconsistent",
      final_basis: "hard_fact",
      local_action: "notify_hard_fact",
      human_review_candidate: false,
      human_review_reasons: [],
      reason_codes: ["hard_violation"],
      coverage_complete: input.coverage.complete,
    };
  }
  if (hasMissing) {
    if (allRecoverable) {
      return {
        final_state: "needs_evidence",
        final_basis: null,
        local_action: "request_evidence",
        human_review_candidate: false,
        human_review_reasons: [],
        reason_codes: ["evidence_missing"],
        coverage_complete: input.coverage.complete,
      };
    }
    return {
      final_state: "unknown",
      final_basis: null,
      local_action: "record_only",
      human_review_candidate: true,
      human_review_reasons: ["irrecoverable_evidence"],
      reason_codes: ["evidence_irrecoverable"],
      coverage_complete: input.coverage.complete,
    };
  }
  const unresolvedSemantic = input.conflicts.some((conflict) => conflict.resolution === "unresolved");
  if (unresolvedSemantic) {
    return {
      final_state: "abstain",
      final_basis: "semantic_shadow",
      local_action: "record_only",
      human_review_candidate: true,
      human_review_reasons: ["semantic_conflict"],
      reason_codes: ["semantic_conflict"],
      coverage_complete: input.coverage.complete,
    };
  }
  if (requiredPropositions.some((proposition) => proposition.result === "unknown")) {
    return {
      final_state: "unknown",
      final_basis: "semantic_shadow",
      local_action: "record_only",
      human_review_candidate: true,
      human_review_reasons: ["semantic_unknown"],
      reason_codes: ["semantic_unknown"],
      coverage_complete: input.coverage.complete,
    };
  }
  if (requiredPropositions.some((proposition) => proposition.result === "contradicted_semantic")) {
    return {
      final_state: "inconsistent",
      final_basis: "semantic_shadow",
      local_action: "record_only",
      human_review_candidate: false,
      human_review_reasons: [],
      reason_codes: ["semantic_contradiction"],
      coverage_complete: input.coverage.complete,
    };
  }
  if (requiredPropositions.some((proposition) => proposition.result === "conflict")) {
    return {
      final_state: "abstain",
      final_basis: "semantic_shadow",
      local_action: "record_only",
      human_review_candidate: true,
      human_review_reasons: ["semantic_conflict"],
      reason_codes: ["semantic_conflict"],
      coverage_complete: input.coverage.complete,
    };
  }
  const allSupported =
    requiredPropositions.length > 0 &&
    requiredPropositions.every(
      (proposition) =>
        proposition.result === "supported_hard" || proposition.result === "supported_semantic"
    );
  if (allSupported) {
    const anyHard = requiredPropositions.some(
      (proposition) => proposition.result === "supported_hard"
    );
    const allHard = requiredPropositions.every(
      (proposition) => proposition.result === "supported_hard"
    );
    return {
      final_state: "consistent",
      final_basis: allHard ? "hard_fact" : anyHard ? "mixed" : "semantic_shadow",
      local_action: "record_only",
      human_review_candidate: false,
      human_review_reasons: [],
      reason_codes: [],
      coverage_complete: input.coverage.complete,
    };
  }
  return {
    final_state: "unknown",
    final_basis: "semantic_shadow",
    local_action: "record_only",
    human_review_candidate: true,
    human_review_reasons: ["semantic_unknown"],
    reason_codes: ["semantic_unknown"],
    coverage_complete: input.coverage.complete,
  };
}

function hardFactUses(facts: readonly HardFactReductionInput[]): HardFactUse[] {
  const seen = new Set<string>();
  const uses: HardFactUse[] = [];
  for (const fact of facts) {
    const dedupe = `${fact.independence_key}|${fact.requirement_id}|${fact.proposition_id ?? ""}`;
    if (seen.has(dedupe)) {
      continue;
    }
    seen.add(dedupe);
    const use: HardFactUse = {
      fact_key: fact.fact_key,
      independence_key: fact.independence_key,
      requirement_id: fact.requirement_id,
      effect: fact.effect,
      verified: true,
      source_ids: sortUtf8Strings(fact.source_ids),
      source_refs: sortUtf8Strings(fact.source_refs) as SourceRef[],
    };
    if (fact.proposition_id !== undefined) {
      use.proposition_id = fact.proposition_id;
    }
    if (fact.artifact_version !== undefined) {
      use.artifact_version = fact.artifact_version;
    }
    uses.push(use);
  }
  return uses.sort((a, b) => (a.fact_key < b.fact_key ? -1 : 1));
}

function optionalObservations(input: ReduceInput): OptionalObservation[] {
  const bindings = questionBindingsByKey(input.input.question_bindings);
  const observations: OptionalObservation[] = [];
  for (const envelope of input.envelopes) {
    for (const [questionKey, outcome] of Object.entries(envelope.outcomes)) {
      const binding = bindings.get(questionKey);
      if (binding === undefined || binding.required_for_issue) {
        continue;
      }
      const mapping =
        outcome.option_key === null ? undefined : binding.answer_to_issue_map[outcome.option_key];
      observations.push({
        question_key: questionKey,
        envelope_key: envelope.envelope_key,
        effect:
          outcome.effect === "shadow_only"
            ? "unknown"
            : outcome.effect,
        issue_effect: mapping?.issue_effect ?? null,
        affects_final_state: false,
        local_action_authorized: false,
      });
    }
  }
  return observations.sort((a, b) => {
    if (a.question_key !== b.question_key) {
      return a.question_key < b.question_key ? -1 : 1;
    }
    return a.envelope_key < b.envelope_key ? -1 : 1;
  });
}

function reduceAggregateV2(input: ReduceInputV2): Result<AnswerAggregateV2, EvdError> {
  const required = requiredQuestionKeys(input.input.question_bindings);
  if (required.length === 0 || input.input.question_bindings.every((binding) => binding.proposition_id === "")) {
    return evdErr("E_AGGREGATE_NO_PROPOSITIONS", { question_keys: required });
  }
  if (input.input.plan_state !== "active") {
    return evdErr("E_PLAN_AGGREGATION_BINDING", { question_key: "", field: "plan_state" });
  }
  const selection = selectEnvelopes(input);
  const decidedQuestionKeys = validatedDecidedQuestionKeys(input);
  const coverage = buildCoverage(
    input,
    required,
    selection.selections,
    selection.stale,
    decidedQuestionKeys
  );
  const missing = buildMissing({
    input,
    coverage,
    stale: selection.stale,
    omissions: input.omissions,
    semanticKinds: true,
  });
  const propositions = buildPropositions(input, coverage, selection.selectedEnvelopes);
  const requirements = buildRequirements(propositions, input.hard_facts);
  const conflicts = buildConflicts(propositions, input.hard_facts, selection.selectedEnvelopes);
  const decision = decideFinal({
    required,
    propositions,
    requirements,
    conflicts,
    missing,
    coverage,
    hardFacts: input.hard_facts,
    questionBindings: input.input.question_bindings
  });
  const optional = optionalObservations(input);
  const hardFacts = hardFactUses(input.hard_facts);
  const evidenceRefs = sortUtf8Strings([
    ...propositions.flatMap((proposition) => proposition.evidence_refs),
    ...missing.flatMap((entry) => entry.source_refs),
  ]) as SourceRef[];
  const omissionKeys = sortUtf8Strings(input.omissions.map((omission) => omission.omission_key)) as Hash[];
  // The deterministic decision is part of the aggregate body (accepted
  // coverage, propositions). It must therefore be part of the identity: the
  // same request with and without `decided_question_keys` cannot share one
  // `aggregate_id`. An empty decision keeps the historic canonical key.
  const decidedKeysDigest: Hash | undefined =
    decidedQuestionKeys.length === 0
      ? undefined
      : jcsHash({
          schema_version: "rsi.aggregate_decided_keys/1",
          decided_question_keys_utf8: sortUtf8Strings(decidedQuestionKeys)
        });
  const decidedKeyField =
    decidedKeysDigest === undefined
      ? {}
      : { decided_question_keys_digest: decidedKeysDigest };
  const aggregateKey = aggregateKeyV2({
    plan_hash: input.input.plan_hash,
    shard_plan_key: input.input.shard_plan_key,
    pack_hash: input.input.pack_hash,
    backend: input.input.backend,
    scope_key: input.input.backend.scope_key,
    selected_envelope_keys: selection.selectedEnvelopeKeys,
    hard_fact_keys: input.input.hard_fact_keys,
    omission_keys: omissionKeys,
    question_bindings_digest: input.input.question_bindings_digest,
    hard_fact_snapshot_hash: input.input.hard_fact_snapshot.snapshot_hash,
    hard_fact_view_hash: input.input.hard_fact_snapshot.hard_fact_view_hash,
    validator_binding_key: input.input.validator_binding_key,
    ...decidedKeyField
  });
  // DD-EVD-025: a new answer or a new hard fact produces a new aggregate
  // that points at the aggregate it supersedes; the old aggregate stays
  // immutable. The superseded identity is the aggregate of the same plan,
  // shard plan and envelopes before the current hard facts entered the key.
  const supersededAggregateKey =
    input.input.hard_fact_keys.length === 0
      ? null
      : aggregateKeyV2({
          plan_hash: input.input.plan_hash,
          shard_plan_key: input.input.shard_plan_key,
          pack_hash: input.input.pack_hash,
          backend: input.input.backend,
          scope_key: input.input.backend.scope_key,
          selected_envelope_keys: selection.selectedEnvelopeKeys,
          hard_fact_keys: [],
          omission_keys: omissionKeys,
          question_bindings_digest: input.input.question_bindings_digest,
          hard_fact_snapshot_hash: input.input.hard_fact_snapshot.snapshot_hash,
          hard_fact_view_hash: input.input.hard_fact_snapshot.hard_fact_view_hash,
          validator_binding_key: input.input.validator_binding_key,
          ...decidedKeyField
        });
  const supersededAggregateId =
    input.supersedes_aggregate_id ??
    (supersededAggregateKey !== null && supersededAggregateKey !== aggregateKey
      ? contentId("agg", supersededAggregateKey)
      : undefined);
  const aggregate: AnswerAggregateV2 = {
    schema_version: "rsi.answer_aggregate/2",
    aggregate_id: contentId("agg", aggregateKey),
    aggregate_key: aggregateKey,
    issue_id: input.input.issue_id,
    plan_id: input.input.plan_id,
    plan_hash: input.input.plan_hash,
    shard_plan_id: input.input.shard_plan_id,
    shard_plan_key: input.input.shard_plan_key,
    binding: input.input.version_binding,
    aggregation_policy_version: "rsi.aggregate/2",
    review_policy_version: "rsi.aggregate.review/1",
    validator_policy_version: "rsi.semantic.validator/1",
    validator_binding_id: contentId("svcp", input.input.validator_binding_key),
    validator_binding_key: input.input.validator_binding_key,
    backend: input.input.backend,
    ...(supersededAggregateId === undefined
      ? {}
      : { supersedes_aggregate_id: supersededAggregateId }),
    selected_shards: selection.selections,
    coverage,
    propositions,
    requirements,
    conflicts,
    missing,
    stale_discarded: selection.stale,
    hard_facts: hardFacts,
    optional_observations: optional,
    final_state: decision.final_state,
    final_basis: decision.final_basis,
    reason_codes: decision.reason_codes,
    coverage_complete: decision.coverage_complete,
    task_success: false,
    delivery_allowed: false,
    local_action: decision.local_action,
    human_review_candidate: decision.human_review_candidate,
    human_review_reasons: sortUtf8Strings(decision.human_review_reasons) as AnswerAggregateV2["human_review_reasons"],
    evidence_refs: evidenceRefs,
    input_keys: {
      pack_hash: input.input.pack_hash,
      shard_plan_key: input.input.shard_plan_key,
      capability_key: input.input.backend.capability_key,
      capability_hash: input.input.backend.capability_hash,
      selected_envelope_keys: sortUtf8Strings(selection.selectedEnvelopeKeys) as Hash[],
      hard_fact_keys: sortUtf8Strings(input.input.hard_fact_keys) as Hash[],
      omission_keys: omissionKeys,
      question_bindings_digest: input.input.question_bindings_digest,
      hard_fact_snapshot_hash: input.input.hard_fact_snapshot.snapshot_hash,
      hard_fact_view_hash: input.input.hard_fact_snapshot.hard_fact_view_hash,
    },
    created_at: input.input.created_at,
    aggregate_hash: EMPTY_HASH,
  };
  aggregate.aggregate_hash = aggregateHashV2(aggregate);
  return evdOk(aggregate);
}

/**
 * Archived `/1` reducer path (DD-EVD-022A test seam).
 *
 * Historical `/1` aggregate inputs keep the `/1` shape: no semantic backend
 * binding, the Jev validator policy, and no human-review candidate fields.
 * The reduction rules themselves are shared with `/2`; only the persisted
 * projection, key and hash version differ.
 */
function reduceAggregateV1(input: ReduceInputV1): Result<AnswerAggregate, EvdError> {
  const required = requiredQuestionKeys(input.input.question_bindings);
  if (required.length === 0 || input.input.question_bindings.every((binding) => binding.proposition_id === "")) {
    return evdErr("E_AGGREGATE_NO_PROPOSITIONS", { question_keys: required });
  }
  if (input.input.plan_state !== "active") {
    return evdErr("E_PLAN_AGGREGATION_BINDING", { question_key: "", field: "plan_state" });
  }
  const selection = selectEnvelopes(input);
  const coverage = buildCoverage(input, required, selection.selections, selection.stale);
  const missing = buildMissing({
    input,
    coverage,
    stale: selection.stale,
    omissions: input.omissions,
  });
  const propositions = buildPropositions(input, coverage, selection.selectedEnvelopes);
  const requirements = buildRequirements(propositions, input.hard_facts);
  const conflicts = buildConflicts(propositions, input.hard_facts, selection.selectedEnvelopes);
  const decision = decideFinal({
    required,
    propositions,
    requirements,
    conflicts,
    missing,
    coverage,
    hardFacts: input.hard_facts,
    questionBindings: input.input.question_bindings
  });
  const optional = optionalObservations(input);
  const hardFacts = hardFactUses(input.hard_facts);
  const evidenceRefs = sortUtf8Strings([
    ...propositions.flatMap((proposition) => proposition.evidence_refs),
    ...missing.flatMap((entry) => entry.source_refs),
  ]) as SourceRef[];
  const omissionKeys = sortUtf8Strings(input.omissions.map((omission) => omission.omission_key)) as Hash[];
  const aggregateKey = aggregateKeyV1({
    plan_hash: input.input.plan_hash,
    shard_plan_key: input.input.shard_plan_key,
    pack_hash: input.input.pack_hash,
    selected_envelope_keys: selection.selectedEnvelopeKeys,
    hard_fact_keys: input.input.hard_fact_keys,
    omission_keys: omissionKeys,
    question_bindings_digest: input.input.question_bindings_digest,
    hard_fact_snapshot_hash: input.input.hard_fact_snapshot.snapshot_hash,
    hard_fact_view_hash: input.input.hard_fact_snapshot.hard_fact_view_hash,
    aggregation_policy_version: input.input.aggregation_policy_version,
    validator_binding_key: input.input.validator_binding_key,
  });
  const aggregate: AnswerAggregate = {
    schema_version: "rsi.answer_aggregate/1",
    aggregate_id: contentId("agg", aggregateKey),
    aggregate_key: aggregateKey,
    issue_id: input.input.issue_id,
    plan_id: input.input.plan_id,
    plan_hash: input.input.plan_hash,
    shard_plan_id: input.input.shard_plan_id,
    shard_plan_key: input.input.shard_plan_key,
    binding: input.input.version_binding,
    aggregation_policy_version: "rsi.aggregate/1",
    validator_policy_version: "rsi.judge.validator/1",
    validator_binding_id: contentId("svcp", input.input.validator_binding_key),
    validator_binding_key: input.input.validator_binding_key,
    selected_shards: toSelectionV1(selection.selections),
    coverage,
    propositions,
    requirements,
    conflicts,
    missing: missing as AggregateMissing[],
    stale_discarded: toStaleV1(selection.stale),
    hard_facts: hardFacts,
    optional_observations: optional,
    final_state: decision.final_state,
    final_basis: decision.final_basis,
    reason_codes: decision.reason_codes,
    coverage_complete: decision.coverage_complete,
    task_success: false,
    delivery_allowed: false,
    local_action: decision.local_action,
    evidence_refs: evidenceRefs,
    input_keys: {
      pack_hash: input.input.pack_hash,
      shard_plan_key: input.input.shard_plan_key,
      selected_envelope_keys: sortUtf8Strings(selection.selectedEnvelopeKeys) as Hash[],
      hard_fact_keys: sortUtf8Strings(input.input.hard_fact_keys) as Hash[],
      omission_keys: omissionKeys,
      question_bindings_digest: input.input.question_bindings_digest,
      hard_fact_snapshot_hash: input.input.hard_fact_snapshot.snapshot_hash,
      hard_fact_view_hash: input.input.hard_fact_snapshot.hard_fact_view_hash,
    },
    created_at: input.input.created_at,
    aggregate_hash: EMPTY_HASH,
  };
  aggregate.aggregate_hash = aggregateHashV1(aggregate);
  return evdOk(aggregate);
}

function toSelectionV1(entries: readonly AggregateShardSelectionV2[]): AggregateShardSelection[] {
  return entries.map((entry) => ({
    shard_id: entry.shard_id,
    shard_key: entry.shard_key,
    request_hash: entry.request_hash,
    dispatch_key: entry.dispatch_key,
    envelope_id: entry.envelope_id,
    envelope_key: entry.envelope_key,
    attempt_id: entry.attempt_id,
    validation_status: entry.validation_status,
    model_match: entry.model_match,
    selected: entry.selected,
    reason_codes: [...entry.reason_codes],
  }));
}

function toStaleV1(entries: readonly AggregateStaleV2[]): AggregateStale[] {
  return entries.map((entry): AggregateStale => {
    switch (entry.reason) {
      case "capability_mismatch":
      case "contract_mismatch":
      case "legacy_envelope":
        return { ...entry, reason: "version_mismatch" };
      default:
        return { ...entry, reason: entry.reason };
    }
  });
}

export function reduceAggregate(input: ReduceInputV2): Result<AnswerAggregateV2, EvdError>;
export function reduceAggregate(input: ReduceInputV1): Result<AnswerAggregate, EvdError>;
export function reduceAggregate(
  input: ReduceInput
): Result<AnswerAggregateV2 | AnswerAggregate, EvdError> {
  return isReduceInputV2(input) ? reduceAggregateV2(input) : reduceAggregateV1(input);
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export interface EnvelopeObjectReadPort {
  readEnvelope(envelope_id: string): Promise<Result<JudgeEnvelopeV3 | null, ErrorEnvelope>>;
}

export interface ExtendedAnswerAggregatorDeps extends AnswerAggregatorDeps {
  envelopes: EnvelopeObjectReadPort;
}

function envelopeToReduction(envelope: JudgeEnvelopeV3): ReductionEnvelope {
  return {
    shard_key: envelope.shard_key,
    envelope_key: envelope.envelope_key,
    request_hash: envelope.request_hash,
    dispatch_key: envelope.dispatch_key,
    envelope_id: envelope.envelope_id,
    received_at: envelope.received_at,
    validation_status: envelope.validation.status,
    model_match: envelope.adapter_evidence?.kind === "jev_typed" ? envelope.adapter_evidence.model_match : null,
    capability_key: envelope.backend.capability_key,
    capability_hash: envelope.backend.capability_hash,
    binding: envelope.binding,
    outcomes: envelope.semantic_outcomes,
    degraded: envelope.validation.status === "degraded",
    backend: envelope.backend,
  };
}

function toQuestionBinding(question: import("./types.js").AggregatePlanView["questions"][number]): QuestionBinding {
  return {
    question_id: null,
    question_key: question.question_key,
    template_id: question.template_id,
    template_version: question.template_version,
    template_hash: question.template_hash,
    proposition_id: question.proposition_id,
    requirement_ids: sortUtf8Strings(question.requirement_ids),
    required_for_issue: question.required_for_issue,
    option_order:
      question.options.length > 0
        ? question.options.map((option) => option.option_key)
        : (question.criteria.levels ?? []),
    option_effects: question.option_effects,
    answer_to_issue_map: question.answer_to_issue_map,
    independence: question.independence,
  };
}

/**
 * A plan-read rejection forwarded with its owner-canonical code.
 *
 * DD-EVD-022A: `PlanReadResult.rejected` maps one-to-one — the QP-owned code
 * is forwarded unchanged, the original code is kept in `details.upstream_code`
 * and the stage is `plan_read`. The QP-owned detail branch (`field` for
 * `E_PLAN_NOT_FOUND`/`E_PLAN_STALE`, `version` for `E_PLAN_HASH_MISMATCH`/
 * `E_VERSION_BINDING`) is preserved.
 */
function forwardedPlanError(
  code: "E_PLAN_NOT_FOUND" | "E_PLAN_HASH_MISMATCH" | "E_PLAN_STALE" | "E_VERSION_BINDING",
  upstream: ErrorEnvelope | undefined
): EvdError {
  const upstreamDetails = (upstream?.details ?? {}) as Record<string, unknown>;
  const upstreamCode =
    typeof upstreamDetails["upstream_code"] === "string"
      ? upstreamDetails["upstream_code"]
      : code;
  const field = typeof upstreamDetails["field"] === "string" ? upstreamDetails["field"] : undefined;
  const details =
    code === "E_PLAN_NOT_FOUND" || code === "E_PLAN_STALE"
      ? {
          kind: "field" as const,
          path: field ?? "plan",
          rule: upstreamCode,
        }
      : {
          kind: "version" as const,
          expected: field ?? "plan",
          actual: upstreamCode,
        };
  return makeErrorEnvelope({
    code,
    category: FORWARDED_PLAN_CATEGORY[code],
    retryable: false,
    side_effect: "none",
    message_key: `error.forwarded.${code.toLowerCase()}`,
    stage: "plan_read",
    details,
  }) as EvdError;
}

const FORWARDED_PLAN_CATEGORY: Record<
  "E_PLAN_NOT_FOUND" | "E_PLAN_HASH_MISMATCH" | "E_PLAN_STALE" | "E_VERSION_BINDING",
  EvdError["category"]
> = {
  E_PLAN_NOT_FOUND: "not_found",
  E_PLAN_HASH_MISMATCH: "conflict",
  E_PLAN_STALE: "version",
  E_VERSION_BINDING: "version",
};

export function createAnswerAggregator(deps: ExtendedAnswerAggregatorDeps): AnswerAggregator {
  return {
    async aggregate(request) {
      if (!isEvidenceIndexSnapshot(request.frozen_snapshot)) {
        return evdErr("E_AGGREGATE_BINDING_INCOMPLETE", { reason: "snapshot_not_frozen" });
      }
      const snapshot = request.frozen_snapshot;
      if (snapshot.binding.watermark !== request.current_binding.watermark) {
        return evdErr("E_AGGREGATE_SNAPSHOT_MISMATCH", {
          field: "watermark",
          expected: request.current_binding.watermark,
          actual: snapshot.binding.watermark,
        });
      }
      for (const field of ["task_id", "branch_id", "input_epoch", "goal_version", "config_version"] as const) {
        if (snapshot.binding[field] !== request.current_binding[field]) {
          return evdErr("E_AGGREGATE_SNAPSHOT_MISMATCH", {
            field,
            expected: String(request.current_binding[field]),
            actual: String(snapshot.binding[field]),
          });
        }
      }
      const planResult = await deps.plans.readPlanForAggregate({
        plan_id: request.plan_id,
        expected_plan_hash: request.plan_hash,
        binding: request.current_binding,
      });
      if (!planResult.ok) {
        if (planResult.code === "E_PLAN_CLOSURE_INCOMPLETE") {
          // The read port returns the questions sorted by `question_key`
          // (DD-QP-29), so the closure lists the affected keys in that same
          // order rather than in the plan's storage order.
          return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", {
            missing_question_keys: sortUtf8Strings(
              planResult.plan?.questions.map((q) => q.question_key) ?? []
            ),
          });
        }
        // DD-QP `readPlanForAggregate` has a closed error set of
        // `E_PLAN_NOT_FOUND` / `E_PLAN_HASH_MISMATCH` / `E_VERSION_BINDING`.
        // Those are owner-canonical and are forwarded unchanged with
        // `stage="plan_read"` and the original code in `details.upstream_code`;
        // EVD rewrites them into a generic code only for errors outside that
        // set.
        if (
          planResult.code === "E_PLAN_NOT_FOUND" ||
          planResult.code === "E_PLAN_HASH_MISMATCH" ||
          planResult.code === "E_VERSION_BINDING"
        ) {
          return err(forwardedPlanError(planResult.code, planResult.error));
        }
        return evdErr("E_PLAN_AGGREGATION_BINDING", {
          question_key: "",
          field: planResult.code,
        });
      }
      const plan = planResult.value;
      if (plan.plan_state !== "active") {
        // DD-QP: `plan_state` non-active is mapped by EVD to `E_PLAN_STALE`;
        // QP does not return that code from this port.
        return err(forwardedPlanError("E_PLAN_STALE", undefined));
      }
      // DD-QP `readPlanForAggregate` returns an `AggregatePlanView` that carries
      // no `question_id`: the aggregate joins on `question_key`. A random
      // `question_id` on a view never enters the bindings digest or any
      // content key, so it is read but not used (DD-EVD-023, TC-EVD-028). The
      // `E_PLAN_AGGREGATION_BINDING` triggers are the missing or mismatched
      // proposition/requirement/option fields, not the local id.
      const inputsResult = await deps.state.readEvdAggregateSnapshot({
        binding: request.current_binding,
        shard_plan_key: request.shard_plan_key,
      });
      if (!inputsResult.ok) {
        return evdErr("E_AGGREGATE_BINDING_INCOMPLETE", {
          reason: inputsResult.error.code,
          shard_plan_key: request.shard_plan_key,
          shard_key: "",
        });
      }
      const rows = inputsResult.value;
      if (rows.pack === null || rows.pack === undefined) {
        return evdErr("E_AGGREGATE_BINDING_INCOMPLETE", {
          reason: "E_AGGREGATE_PACK_MISSING",
          shard_plan_key: request.shard_plan_key,
          shard_key: ""
        });
      }
      // DD-EVD-022A: `pack.pack_key` must equal `shard_plan.pack_key`; the
      // two are independent identities otherwise (`aggregate_key` uses
      // `pack_hash`, the shard keys use `pack_key`). A shard plan that
      // carries no `pack_key` cannot contradict the pack row, so the check
      // only fires when both sides are present.
      if (
        typeof rows.shard_plan.pack_key === "string" &&
        rows.pack.pack_key !== rows.shard_plan.pack_key
      ) {
        return evdErr("E_AGGREGATE_BINDING_INCOMPLETE", {
          reason: "E_AGGREGATE_PACK_KEY_MISMATCH",
          shard_plan_key: request.shard_plan_key,
          shard_key: ""
        });
      }
      // The validator identity is never defaulted. A shard that was settled
      // by hard facts may carry no request binding at all, so the explicit
      // `validator_binding_key` from the caller is the only valid source in
      // that case. With request bindings, the persisted key is authoritative
      // and an explicit key must agree with it.
      const persistedValidator = persistedValidatorKey(rows);
      if (persistedValidator.conflict) {
        return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
          expected: "single_validator_binding",
          actual: persistedValidator.keys.join(",")
        });
      }
      const explicitValidator = request.validator_binding_key;
      if (
        explicitValidator !== undefined &&
        persistedValidator.key !== null &&
        explicitValidator !== persistedValidator.key
      ) {
        return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
          expected: persistedValidator.key,
          actual: explicitValidator
        });
      }
      const validatorKey = explicitValidator ?? persistedValidator.key;
      if (validatorKey === null) {
        return evdErr("E_VALIDATOR_BINDING_MISSING", { validator_binding_key: "" });
      }
      const validatorRow = await deps.state.readValidatorBinding({
        validator_binding_key: validatorKey,
      });
      if (!validatorRow.ok) {
        return evdErr("E_AGGREGATE_BINDING_INCOMPLETE", {
          reason: validatorRow.error.code,
          shard_plan_key: request.shard_plan_key,
          shard_key: "",
        });
      }
      if (validatorRow.value === null) {
        return evdErr("E_VALIDATOR_BINDING_MISSING", {
          validator_binding_key: validatorKey
        });
      }
      if (validatorRow.value.body_json.schema_version !== "rsi.semantic_validation_binding/1") {
        return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
          expected: "rsi.semantic_validation_binding/1",
          actual: validatorRow.value.body_json.schema_version,
        });
      }
      const semanticBinding = validatorRow.value.body_json;
      // DD-EVD-022A: the `SemanticValidationBinding/1` row is read-only. Its
      // `policy_hash`/`contract_hash` are the frozen local policy values and
      // its `validator_binding_key` is derived from the capability identity
      // and those two hashes, so a row whose fields do not reproduce its key
      // is a tampered row and is refused as a policy mismatch. A row that
      // carries no policy field at all cannot contradict them.
      const recomputedPolicyHash = semanticPolicyHash();
      const recomputedContractHash = semanticContractHash();
      if (
        (typeof semanticBinding.policy_hash === "string" &&
          semanticBinding.policy_hash !== recomputedPolicyHash) ||
        (typeof semanticBinding.contract_hash === "string" &&
          semanticBinding.contract_hash !== recomputedContractHash)
      ) {
        return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
          expected: recomputedPolicyHash,
          actual: semanticBinding.policy_hash,
        });
      }
      const hasCapabilityIdentity =
        typeof semanticBinding.backend_key === "string" &&
        typeof semanticBinding.capability_key === "string" &&
        typeof semanticBinding.capability_hash === "string";
      if (hasCapabilityIdentity) {
        const recomputedBindingKey = semanticValidatorBindingKey({
          backend_key: semanticBinding.backend_key,
          capability_key: semanticBinding.capability_key,
          capability_hash: semanticBinding.capability_hash,
          policy_hash: semanticBinding.policy_hash,
          contract_hash: semanticBinding.contract_hash,
        });
        if (
          typeof semanticBinding.validator_binding_key === "string" &&
          semanticBinding.validator_binding_key !== recomputedBindingKey
        ) {
          return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
            expected: recomputedBindingKey,
            actual: semanticBinding.validator_binding_key,
          });
        }
      }
      const hardFacts = snapshot.listHardFacts({
        binding: request.current_binding,
        watermark: request.current_binding.watermark,
      });
      const computedViewHash = hardFactViewHash(hardFacts);
      for (const fact of hardFacts) {
        const recomputed = factKey({
          requirement_id: fact.requirement_id,
          ...(fact.proposition_id !== undefined ? { proposition_id: fact.proposition_id } : {}),
          effect: fact.effect,
          ...(fact.artifact_version !== undefined ? { artifact_version: fact.artifact_version } : {}),
          source_ids: fact.source_ids,
          source_refs: fact.source_refs,
          verifier_ref: fact.verifier_ref,
          verified: true,
        });
        if (recomputed !== fact.fact_key) {
          return evdErr("E_HARD_FACT_KEY_MISMATCH", {
            fact_id: fact.fact_id,
            expected: recomputed,
            actual: fact.fact_key,
          });
        }
      }
      const envelopes: ReductionEnvelope[] = [];
      const legacy: Id[] = [];
      const legacyShardKeys: Hash[] = [];
      for (const row of rows.envelopes) {
        const read = await deps.envelopes.readEnvelope(row.envelope_id);
        if (!read.ok || read.value === null) {
          continue;
        }
        if (read.value.schema_version !== "rsi.judge_envelope/3") {
          legacy.push(row.envelope_id);
          if (!legacyShardKeys.includes(row.shard_key)) {
            legacyShardKeys.push(row.shard_key);
          }
          continue;
        }
        envelopes.push(envelopeToReduction(read.value));
      }
      const expectations: AggregateShardExpectation[] = rows.shards.map((shard) => ({
        shard_id: shard.shard_id,
        shard_key: shard.shard_key,
        question_keys: shard.body_json.question_keys,
        required_for_issue: shard.body_json.question_keys.length > 0,
        expected_request_hash:
          rows.request_bindings.find((binding) => binding.binding_id === shard.request_binding_id)
            ?.request_hash ?? null,
        expected_dispatch_key:
          rows.request_bindings.find((binding) => binding.binding_id === shard.request_binding_id)
            ?.dispatch_key ?? null,
        binding_status: shard.status,
        reason_codes: shard.reason_codes ?? [],
      }));
      const reductions: HardFactReductionInput[] = hardFacts.map((fact) => ({
        fact_key: fact.fact_key,
        independence_key: fact.independence_key,
        requirement_id: fact.requirement_id,
        ...(fact.proposition_id !== undefined ? { proposition_id: fact.proposition_id } : {}),
        effect: fact.effect,
        ...(fact.artifact_version !== undefined ? { artifact_version: fact.artifact_version } : {}),
        source_ids: fact.source_ids,
        source_refs: fact.source_refs,
      }));
      // DD-EVD-022A: the `SemanticValidationBinding/1` row is checked against
      // the batch backend by `capability_key`/`capability_hash` equality. The
      // physical `service_profile_key=capability_key` is not compared with a
      // Jev profile key.
      const batchBackend = selectBackend(envelopes);
      // The physical `service_profile_key` of the row is the capability key
      // (DD-EVD-016A); it must equal the body's own capability key.
      const physicalCapabilityKey = validatorRow.value.service_profile_key;
      if (
        typeof physicalCapabilityKey === "string" &&
        typeof semanticBinding.capability_key === "string" &&
        physicalCapabilityKey !== semanticBinding.capability_key
      ) {
        return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
          expected: physicalCapabilityKey,
          actual: semanticBinding.capability_key,
        });
      }
      const bindingCapabilityKey = rows.request_bindings[0]?.service_profile_key;
      if (
        bindingCapabilityKey !== undefined &&
        typeof semanticBinding.capability_key === "string" &&
        bindingCapabilityKey !== semanticBinding.capability_key
      ) {
        return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
          expected: bindingCapabilityKey,
          actual: semanticBinding.capability_key,
        });
      }
      if (
        envelopes.length > 0 &&
        typeof semanticBinding.capability_key === "string" &&
        typeof semanticBinding.capability_hash === "string" &&
        (semanticBinding.capability_key !== batchBackend.capability_key ||
          semanticBinding.capability_hash !== batchBackend.capability_hash)
      ) {
        return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
          expected: batchBackend.capability_hash,
          actual: semanticBinding.capability_hash,
        });
      }
      const questionBindings = plan.questions.map(toQuestionBinding);
      // The persisted digest is per shard; when every shard was short-
      // circuited there is no persisted digest at all. The explicit digest
      // wins only when it agrees with what was persisted; otherwise the
      // canonical digest of the plan's question set is the fallback. This is
      // a digest, not a validator: no default validator is synthesised.
      const persistedDigest = rows.request_bindings[0]?.question_bindings_digest ?? null;
      const explicitDigest = request.question_bindings_digest;
      if (
        explicitDigest !== undefined &&
        persistedDigest !== null &&
        explicitDigest !== persistedDigest
      ) {
        return evdErr("E_AGGREGATE_BINDING_INCOMPLETE", {
          reason: "E_AGGREGATE_QUESTION_DIGEST_MISMATCH",
          shard_plan_key: request.shard_plan_key,
          shard_key: ""
        });
      }
      const questionDigest =
        explicitDigest ?? persistedDigest ?? questionBindingsDigest(questionBindings);
      const aggregateInput: AggregateInputV2 = {
        issue_id: request.issue_id,
        issue_key: plan.issue_key,
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        plan_state: plan.plan_state,
        state_profile: plan.state_profile,
        shard_plan_id: rows.shard_plan.shard_plan_id,
        shard_plan_key: rows.shard_plan.shard_plan_key,
        pack_id: rows.pack.pack_id,
        pack_key: rows.pack.pack_key,
        pack_hash: rows.pack.pack_hash,
        version_binding: request.current_binding,
        question_bindings: questionBindings,
        question_bindings_digest: questionDigest,
        validator_binding_key: semanticBinding.validator_binding_key,
        ...(request.decided_question_keys !== undefined
          ? { decided_question_keys: [...request.decided_question_keys] }
          : {}),
        shard_expectations: expectations,
        envelope_ids: envelopes.map((envelope) => envelope.envelope_id),
        omission_ids: rows.omissions.map((row) => row.omission_id),
        legacy_envelope_ids: legacy,
        legacy_envelope_shard_keys: sortUtf8Strings(legacyShardKeys) as Hash[],
        hard_fact_snapshot: {
          snapshot_hash: snapshot.snapshot_hash,
          binding: snapshot.binding,
          watermark: snapshot.watermark,
          scope: "ledger_scan/1",
          hard_fact_view_hash: computedViewHash,
        },
        hard_fact_keys: sortUtf8Strings(hardFacts.map((fact) => fact.fact_key)) as Hash[],
        aggregation_policy_version: "rsi.aggregate/2",
        review_policy_version: "rsi.aggregate.review/1",
        backend: batchBackend,
        validator_policy_version: "rsi.semantic.validator/1",
        created_at: deps.now(),
      };
      const reduced = reduceAggregate({
        input: aggregateInput,
        envelopes,
        hard_facts: reductions,
        omissions: rows.omissions.map((row) => omissionFromRow(row)),
      });
      return reduced;
    },
  };
}

interface PersistedValidatorKey {
  /**
   * The single validator key shared by every request binding. `null` means
   * there is no request binding at all (a fully deterministically settled
   * shard plan); it is never the empty hash.
   */
  readonly key: Hash | null;
  /** True when request bindings disagree about the validator identity. */
  readonly conflict: boolean;
  readonly keys: readonly Hash[];
}

function persistedValidatorKey(rows: EvdAggregateInputs): PersistedValidatorKey {
  const keys = [
    ...new Set(rows.request_bindings.map((binding) => binding.validator_binding_key))
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (keys.length === 0) {
    return { key: null, conflict: false, keys };
  }
  if (keys.length > 1) {
    return { key: null, conflict: true, keys };
  }
  return { key: keys[0] ?? null, conflict: false, keys };
}

function selectBackend(envelopes: readonly ReductionEnvelope[]): AggregateInputV2["backend"] {
  const first = envelopes[0]?.backend;
  if (first !== undefined) {
    return first;
  }
  return {
    schema_version: "rsi.semantic_backend_ref/1",
    backend_key: "" as Hash,
    backend_kind: "other",
    method: { schema_version: "rsi.method_ref/1", method_id: "", method_version: "", rule_version: "" },
    scope_key: "" as Hash,
    capability_key: "" as Hash,
    capability_hash: "" as Hash,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function omissionFromRow(row: import("./types.js").EvdOmissionRow): Omission {
  return {
    schema_version: "rsi.evidence_omission/1",
    omission_id: row.omission_id,
    omission_key: row.omission_key,
    shard_plan_id: row.shard_plan_id,
    plan_hash: row.plan_hash,
    ...(row.shard_id !== null ? { shard_id: row.shard_id } : {}),
    question_ids: [],
    question_keys: row.question_keys,
    unit_keys: row.unit_keys,
    source_ids: [],
    source_refs: [],
    plan_omission_impact: row.impact === "none" ? "none" : "answer_changing",
    can_omit: row.reason === "not_required",
    required_for_issue: row.required_for_issue,
    reason: row.reason,
    impact: row.impact,
    recoverable: row.recoverable,
    recorded_by: "evd-store/1",
    created_at: row.created_at,
  };
}

export function createAcceptedAggregateReader(
  deps: AcceptedAggregateReaderDeps
): AcceptedAggregateReadPort {
  return {
    async readAccepted(input: AcceptedAggregateReadRequest) {
      const result = await deps.aggregates.readEvdAcceptedAggregate({
        aggregate_id: input.aggregate_id,
        task_id: input.binding.task_id,
        branch_id: input.binding.branch_id,
        input_epoch: input.binding.input_epoch,
        goal_version: input.binding.goal_version,
        config_version: input.binding.config_version,
      });
      if (!result.ok) {
        return evdErr("E_AGGREGATE_NOT_FOUND", {
          aggregate_id: input.aggregate_id,
          scope_field: "storage",
        });
      }
      if (result.value === null) {
        return evdErr("E_AGGREGATE_NOT_FOUND", {
          aggregate_id: input.aggregate_id,
          scope_field: "binding",
        });
      }
      const row = result.value.row;
      if (row.aggregate_hash !== input.expected_aggregate_hash) {
        return evdErr("E_AGGREGATE_HASH_MISMATCH", {
          field: "aggregate_hash",
          expected: input.expected_aggregate_hash,
          actual: row.aggregate_hash,
        });
      }
      let parsed: AnswerAggregate | AnswerAggregateV2;
      try {
        parsed = JSON.parse(new TextDecoder().decode(result.value.content_bytes)) as
          | AnswerAggregate
          | AnswerAggregateV2;
      } catch {
        return evdErr("E_CONTENT_HASH_MISMATCH", {
          content_ref: `blob://${row.content_hash}#bytes=0-${String(row.content_bytes)}`,
          expected: row.content_hash,
          actual: "",
        });
      }
      if (
        parsed.issue_id !== input.issue_id ||
        parsed.plan_id !== input.plan_id ||
        parsed.plan_hash !== input.plan_hash ||
        parsed.aggregate_id !== input.aggregate_id
      ) {
        return evdErr("E_AGGREGATE_HASH_MISMATCH", {
          field: "identity",
          expected: input.plan_hash,
          actual: parsed.plan_hash,
        });
      }
      if (parsed.final_state !== "consistent" && parsed.final_state !== "inconsistent") {
        return evdErr("E_AGGREGATE_NOT_ACCEPTED", {
          aggregate_id: input.aggregate_id,
          final_state: parsed.final_state,
        });
      }
      const recomputed =
        parsed.schema_version === "rsi.answer_aggregate/2"
          ? aggregateHashV2(parsed)
          : aggregateHashV1(parsed);
      if (recomputed !== parsed.aggregate_hash) {
        return evdErr("E_AGGREGATE_HASH_MISMATCH", {
          field: "aggregate_hash",
          expected: recomputed,
          actual: parsed.aggregate_hash,
        });
      }
      deepFreeze(parsed);
      return evdOk(parsed);
    },
  };
}
