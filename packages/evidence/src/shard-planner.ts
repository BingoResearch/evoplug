/**
 * Shard planning (DD-EVD-010 … DD-EVD-014).
 *
 * Binning is the deterministic first-fit decreasing variant: merge order is
 * `(-weight, question_key UTF-8)` and existing bins are scanned by their
 * current `shard_key`. A question whose full required closure does not fit is
 * rejected as its own `budget_rejected` shard; it is never silently dropped.
 */

import { newId, type Hash, type Result, type SourceRef } from "@evoplug/core";
import type { PlanLifecycleState } from "@evoplug/core/evidence";

import { evdErr, evdForwarded, evdOk } from "./errors.js";
import {
  omissionKey,
  shardKey,
  shardPlanHash,
  shardPlanKey,
  sortUtf8Strings,
  utf8Length,
} from "./hashing.js";
import { estimateBudgetForShard, registerShardBudgetMetrics, type ShardBudgetMetrics } from "./budget-estimator.js";
import { buildShardManifests } from "./manifest-builder.js";
import type {
  BudgetEstimate,
  ClosureResult,
  DependencyUnit,
  JevServiceProfile,
  Omission,
  PlannedShards,
  PlannedQuestion,
  QuestionPlan,
  RunBudget,
  SemanticBackendCapability,
  SemanticBudgetEstimate,
  Shard,
  ShardPlan,
  ShardPlanInput,
  EvdError,
  ShardPlanState,
} from "./types.js";

interface Bin {
  questions: PlannedQuestion[];
  units: DependencyUnit[];
  shard_keys: Hash[];
}

function profileKeyOf(profile: JevServiceProfile | SemanticBackendCapability): Hash {
  return profile.schema_version === "rsi.jev_service_profile/1"
    ? profile.profile_key
    : profile.capability_key;
}

function limitsHashOf(profile: JevServiceProfile | SemanticBackendCapability): Hash {
  return profile.schema_version === "rsi.jev_service_profile/1"
    ? profile.limits.limits_hash
    : profile.limits.limits_hash;
}

function questionText(question: PlannedQuestion): string {
  return JSON.stringify({
    type: question.question_type,
    instructions: question.instructions,
    criteria: question.criteria,
    options: question.options.map((option) => ({
      option_key: option.option_key,
      description: option.description,
    })),
  });
}

function unitsForQuestion(
  closure: ClosureResult,
  question: PlannedQuestion
): DependencyUnit[] {
  return closure.units.filter(
    (unit) => unit.question_ids.includes(question.question_id) || unit.question_ids.includes(question.question_key)
  );
}

function uniqueUnits(units: readonly DependencyUnit[]): DependencyUnit[] {
  const byKey = new Map<string, DependencyUnit>();
  for (const unit of units) {
    byKey.set(unit.unit_key, unit);
  }
  return [...byKey.values()].sort((a, b) => (a.unit_key < b.unit_key ? -1 : 1));
}

function stateTokens(units: readonly DependencyUnit[]): number {
  return uniqueUnits(units).reduce((sum, unit) => sum + unit.estimated_tokens, 0);
}

function questionTokens(question: PlannedQuestion): number {
  return utf8Length(questionText(question));
}

function perQuestionTotal(
  question: PlannedQuestion,
  units: readonly DependencyUnit[],
  limits: RunBudget
): number {
  return (
    stateTokens(units) +
    questionTokens(question) +
    question.output_reserve_tokens +
    limits.question_margin_tokens
  );
}

function requestTotal(questions: readonly PlannedQuestion[], units: readonly DependencyUnit[], limits: RunBudget): number {
  const reserves = questions.reduce((sum, question) => sum + question.output_reserve_tokens, 0);
  // The question prompt tokens are charged to the request whenever the plan
  // declares an output reserve for those questions; a zero reserve means the
  // template carries no prompt overhead and only the state is billed.
  const promptTokens =
    reserves > 0
      ? questions.reduce((sum, question) => sum + questionTokens(question), 0)
      : 0;
  const frame = utf8Length(JSON.stringify(sortUtf8Strings(questions.map((question) => question.question_key))));
  return stateTokens(units) + promptTokens + reserves + limits.request_margin_tokens + frame;
}

function questionFitsAlone(question: PlannedQuestion, units: readonly DependencyUnit[], limits: RunBudget): boolean {
  if (limits.request_max_tokens === null || limits.question_max_tokens === null) {
    return false;
  }
  if (perQuestionTotal(question, units, limits) > limits.question_max_tokens) {
    return false;
  }
  return requestTotal([question], units, limits) <= limits.request_max_tokens;
}

function artifactVersionsOf(units: readonly DependencyUnit[]): Set<string> {
  const versions = new Set<string>();
  for (const unit of units) {
    if (unit.artifact_version !== undefined) {
      versions.add(unit.artifact_version);
    }
    for (const evidence of unit.state_evidence) {
      if (evidence.artifact_version !== undefined) {
        versions.add(evidence.artifact_version);
      }
    }
  }
  return versions;
}

/** DD-EVD-011: questions whose units pin different artifact versions cannot merge. */
function artifactCompatible(left: readonly DependencyUnit[], right: readonly DependencyUnit[]): boolean {
  const versions = new Set([...artifactVersionsOf(left), ...artifactVersionsOf(right)]);
  return versions.size <= 1;
}

function binShardKey(
  input: ShardPlanInput,
  bin: Bin,
  questions: readonly PlannedQuestion[],
  omissionKeys: readonly Hash[]
): Hash {
  return shardKey({
    plan_hash: input.plan_hash,
    pack_key: input.pack_key,
    required_question_keys: questions.filter((question) => question.required_for_issue).map((question) => question.question_key),
    optional_question_keys: questions.filter((question) => !question.required_for_issue).map((question) => question.question_key),
    unit_keys: uniqueUnits(bin.units).map((unit) => unit.unit_key),
    service_profile_key: profileKeyOf(input.service_profile),
    limits_hash: limitsHashOf(input.service_profile),
    omission_keys: omissionKeys.map((key) => key),
    counting_method_version: input.pack.counting_method_version,
    compiler_version: input.pack.compiler_version,
  });
}

function metricsFor(
  questions: readonly PlannedQuestion[],
  units: readonly DependencyUnit[]
): ShardBudgetMetrics {
  const question_text: Record<string, string> = {};
  const output_reserve: Record<string, number> = {};
  const required_for_issue: Record<string, boolean> = {};
  for (const question of questions) {
    question_text[question.question_key] = questionText(question);
    output_reserve[question.question_key] = question.output_reserve_tokens;
    required_for_issue[question.question_key] = question.required_for_issue;
  }
  const stateText = JSON.stringify(
    uniqueUnits(units)
      .map((unit) => ({
        logical_id: unit.dependency_key,
        excerpt: unit.state_evidence.map((entry) => ({
          logical_id: entry.logical_id,
          excerpt: entry.excerpt,
        })),
      }))
      .sort((a, b) => (a.logical_id < b.logical_id ? -1 : 1))
  );
  return { state_text: stateText, question_text, output_reserve, required_for_issue };
}

function computePlanState(shards: readonly Shard[]): ShardPlanState {
  const pending = shards.filter(
    (shard) => shard.status === "planned" || shard.status === "bound"
  );
  const rejected = shards.filter(
    (shard) => shard.status === "budget_rejected" || shard.status === "projection_rejected"
  );
  if (shards.length === 0 || rejected.length === shards.length) {
    return "rejected";
  }
  if (shards.some((shard) => shard.status === "sent")) {
    return "dispatched";
  }
  if (shards.some((shard) => shard.status === "accepted") && pending.length > 0) {
    return "dispatched";
  }
  if (rejected.length > 0 && pending.length > 0) {
    return "partially_rejected";
  }
  if (pending.length > 0) {
    return shards.some((shard) => shard.status === "bound") ? "bound" : "planned";
  }
  return "completed";
}

/**
 * DD-EVD-012: `unit_keys` are the omitted closure units and `source_ids` the
 * omitted sources.
 *
 * An optional question's omitted unit has `omission_impact="none"`, so it is
 * not part of the answer_changing closure in `closure.units`; the closure
 * expansion records it in `closure.omissions`. The shard plan reuses those
 * rows instead of re-reading `closure.units`, so both owners agree on the
 * omission content and on its content-addressed `omission_key`. Reading
 * `closure.units` here would name the units that are *sent* as omitted and
 * would produce an omission with an empty unit list.
 */
function optionalOmissionFor(
  input: ShardPlanInput,
  questionKeys: readonly string[],
  closureOmissions: readonly Omission[]
): Omission {
  const unitKeys = sortUtf8Strings(closureOmissions.flatMap((omission) => omission.unit_keys));
  const sourceIds = sortUtf8Strings(closureOmissions.flatMap((omission) => omission.source_ids));
  const refs = sortUtf8Strings(closureOmissions.flatMap((omission) => omission.source_refs)) as SourceRef[];
  const key = omissionKey({
    plan_hash: input.plan_hash,
    unit_keys: unitKeys,
    question_keys: questionKeys,
    source_ids: sourceIds,
    source_refs: refs,
    plan_omission_impact: "none",
    can_omit: true,
    required_for_issue: false,
    reason: "not_required",
    impact: "none",
  });
  return {
    schema_version: "rsi.evidence_omission/1",
    omission_id: newId("omis"),
    omission_key: key,
    shard_plan_id: newId("splan"),
    plan_hash: input.plan_hash,
    question_ids: sortUtf8Strings(questionKeys),
    question_keys: sortUtf8Strings(questionKeys),
    unit_keys: unitKeys as Hash[],
    source_ids: sourceIds,
    source_refs: refs,
    plan_omission_impact: "none",
    can_omit: true,
    required_for_issue: false,
    reason: "not_required",
    impact: "none",
    recoverable: true,
    recorded_by: "evd-shard-planner/1",
    created_at: 0,
  };
}

function blockingOmissionFor(
  input: ShardPlanInput,
  question: PlannedQuestion,
  units: readonly DependencyUnit[]
): Omission {
  const unitKeys = uniqueUnits(units).map((unit) => unit.unit_key);
  const sourceIds = sortUtf8Strings(units.flatMap((unit) => unit.source_ids));
  const refs = sortUtf8Strings(units.flatMap((unit) => unit.source_refs)) as SourceRef[];
  const key = omissionKey({
    plan_hash: input.plan_hash,
    unit_keys: unitKeys,
    question_keys: [question.question_key],
    source_ids: sourceIds,
    source_refs: refs,
    plan_omission_impact: "answer_changing",
    can_omit: false,
    required_for_issue: question.required_for_issue,
    reason: "budget_exceeds",
    impact: "blocking",
  });
  return {
    schema_version: "rsi.evidence_omission/1",
    omission_id: newId("omis"),
    omission_key: key,
    shard_plan_id: newId("splan"),
    plan_hash: input.plan_hash,
    question_ids: [question.question_id],
    question_keys: [question.question_key],
    unit_keys: unitKeys as Hash[],
    source_ids: sourceIds,
    source_refs: refs,
    plan_omission_impact: "answer_changing",
    can_omit: false,
    required_for_issue: question.required_for_issue,
    reason: "budget_exceeds",
    impact: "blocking",
    recoverable: false,
    recorded_by: "evd-shard-planner/1",
    created_at: 0,
  };
}

function buildShard(input: {
  planInput: ShardPlanInput;
  questions: PlannedQuestion[];
  units: DependencyUnit[];
  omissionKeys: Hash[];
  status: Shard["status"];
}): { shard: Shard; key: Hash; metrics: ShardBudgetMetrics } {
  const key = shardKey({
    plan_hash: input.planInput.plan_hash,
    pack_key: input.planInput.pack_key,
    required_question_keys: input.questions
      .filter((question) => question.required_for_issue)
      .map((question) => question.question_key),
    optional_question_keys: input.questions
      .filter((question) => !question.required_for_issue)
      .map((question) => question.question_key),
    unit_keys: uniqueUnits(input.units).map((unit) => unit.unit_key),
    service_profile_key: profileKeyOf(input.planInput.service_profile),
    limits_hash: limitsHashOf(input.planInput.service_profile),
    omission_keys: input.omissionKeys,
    counting_method_version: input.planInput.pack.counting_method_version,
    compiler_version: input.planInput.pack.compiler_version,
  });
  const usage = new Map<string, number>();
  for (const unit of uniqueUnits(input.units)) {
    for (const questionId of unit.question_ids) {
      usage.set(questionId, (usage.get(questionId) ?? 0) + 1);
    }
  }
  const shared = uniqueUnits(input.units)
    .filter((unit) => unit.question_ids.some((questionId) => (usage.get(questionId) ?? 0) > 1))
    .map((unit) => unit.unit_key);
  const shard: Shard = {
    shard_id: newId("shard"),
    shard_key: key,
    question_ids: sortUtf8Strings(
      input.questions.filter((question) => question.required_for_issue).map((question) => question.question_id)
    ),
    question_keys: sortUtf8Strings(
      input.questions.filter((question) => question.required_for_issue).map((question) => question.question_key)
    ),
    optional_question_ids: sortUtf8Strings(
      input.questions.filter((question) => !question.required_for_issue).map((question) => question.question_id)
    ),
    optional_question_keys: sortUtf8Strings(
      input.questions.filter((question) => !question.required_for_issue).map((question) => question.question_key)
    ),
    unit_keys: sortUtf8Strings(uniqueUnits(input.units).map((unit) => unit.unit_key)),
    source_refs: sortUtf8Strings(uniqueUnits(input.units).flatMap((unit) => unit.source_refs)) as SourceRef[],
    shared_unit_keys: sortUtf8Strings(shared),
    depends_on_shard_ids: [],
    budget_estimate_id: newId("best"),
    omission_ids: [],
    state_hash: null,
    request_binding_id: null,
    status: input.status,
    reason_codes: input.status === "budget_rejected" ? ["E_EVIDENCE_EXCEEDS_BUDGET"] : [],
  };
  return { shard, key, metrics: metricsFor(input.questions, input.units) };
}

export function planShardsForPlan(
  input: ShardPlanInput,
  plan: QuestionPlan,
  now: number = Date.now(),
  planLifecycle?: PlanLifecycleState | null
): Result<PlannedShards, EvdError> {
  if (input.schema_version !== "rsi.shard_plan_input/1") {
    return evdErr("E_EVIDENCE_PLAN_NOT_DISPATCHABLE", { shard_plan_key: "", reason: "schema" });
  }
  // DD-EVD-007: `/1` rows are read-only on every write and plan path.
  if ((input.pack.schema_version as string) === "rsi.evidence_pack/1") {
    return evdErr("E_EVIDENCE_PACK_V1_READ_ONLY", {
      schema_version: input.pack.schema_version,
    });
  }
  if (plan.plan_id !== input.plan_id || plan.plan_hash !== input.plan_hash) {
    return evdForwarded("E_VERSION_BINDING", { field: "plan_id" });
  }
  if (plan.binding.task_id !== input.binding.task_id || plan.binding.branch_id !== input.binding.branch_id) {
    return evdForwarded("E_VERSION_BINDING", { field: "plan.binding" });
  }
  if (input.pack.pack_state !== "valid") {
    return evdErr("E_EVIDENCE_PACK_STALE", {
      pack_hash: input.pack.pack_hash,
      binding: input.binding,
    });
  }
  if (input.pack.pack_key !== input.pack_key) {
    return evdErr("E_EVIDENCE_PACK_STALE", {
      pack_hash: input.pack.pack_hash,
      binding: input.binding,
    });
  }
  if (input.closure.omissions.some((omission) => omission.impact === "blocking")) {
    const blocking = input.closure.omissions.find((omission) => omission.impact === "blocking");
    return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", {
      missing_question_keys: blocking?.question_keys ?? [],
    });
  }
  if (input.limits.request_max_tokens === null || input.limits.question_max_tokens === null) {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "request_max_tokens" });
  }
  const profileKey = profileKeyOf(input.service_profile);
  const limitsHash = limitsHashOf(input.service_profile);
  // The persisted plan has no lifecycle; the compiler reads it through
  // `PlanReadPort`. Direct planner callers keep the fixture-only
  // `plan.plan_state` escape hatch, and an unset value means the plan being
  // planned is the current one.
  const lifecycle = planLifecycle === undefined ? (plan.plan_state ?? "active") : planLifecycle;

  const requiredQuestions = plan.questions.filter((question) => question.required_for_issue);
  const optionalQuestions = plan.questions.filter((question) => !question.required_for_issue);

  const weights = new Map<string, number>();
  const unitsByQuestion = new Map<string, DependencyUnit[]>();
  const rejected: PlannedQuestion[] = [];
  for (const question of requiredQuestions) {
    const units = unitsForQuestion(input.closure, question);
    unitsByQuestion.set(question.question_key, units);
    const weight = stateTokens(units);
    weights.set(question.question_key, weight);
    if (!questionFitsAlone(question, units, input.limits)) {
      rejected.push(question);
    }
  }

  const bins: Bin[] = [];
  const order = [...requiredQuestions]
    .filter((question) => !rejected.includes(question))
    .sort((a, b) => {
      const byWeight = (weights.get(b.question_key) ?? 0) - (weights.get(a.question_key) ?? 0);
      if (byWeight !== 0) {
        return byWeight;
      }
      return a.question_key < b.question_key ? -1 : 1;
    });

  for (const question of order) {
    const units = unitsByQuestion.get(question.question_key) ?? [];
    let placed = false;
    for (const bin of bins) {
      if (!artifactCompatible(bin.units, units)) {
        continue;
      }
      const candidateQuestions = [...bin.questions, question];
      const candidateUnits = uniqueUnits([...bin.units, ...units]);
      if (requestTotal(candidateQuestions, candidateUnits, input.limits) > (input.limits.request_max_tokens ?? 0)) {
        continue;
      }
      const allFit = candidateQuestions.every(
        (entry) => perQuestionTotal(entry, candidateUnits, input.limits) <= (input.limits.question_max_tokens ?? 0)
      );
      if (!allFit) {
        continue;
      }
      bin.questions.push(question);
      bin.units = candidateUnits;
      const key = binShardKey(input, bin, bin.questions, []);
      bin.shard_keys = [key];
      placed = true;
      break;
    }
    if (!placed) {
      const bin: Bin = { questions: [question], units: uniqueUnits(units), shard_keys: [] };
      bin.shard_keys = [binShardKey(input, bin, bin.questions, [])];
      bins.push(bin);
    }
  }

  const omittedOptional = optionalQuestions.map((question) => {
    const questionOmissions = input.closure.omissions.filter(
      (omission) =>
        omission.question_keys.includes(question.question_key) &&
        omission.impact === "none" &&
        omission.can_omit
    );
    return optionalOmissionFor(input, [question.question_key], questionOmissions);
  });

  const shards: Shard[] = [];
  const omissions: Omission[] = [];
  const estimates: Array<BudgetEstimate | SemanticBudgetEstimate> = [];

  for (const question of rejected) {
    const units = unitsByQuestion.get(question.question_key) ?? [];
    const omission = blockingOmissionFor(input, question, units);
    omissions.push(omission);
    const built = buildShard({
      planInput: input,
      questions: [question],
      units,
      omissionKeys: [omission.omission_key],
      status: "budget_rejected",
    });
    shardBudgetRegister(built.shard, built.metrics);
    const estimate = estimateBudgetForShard(
      {
        schema_version: "rsi.budget_input/1",
        plan_id: input.plan_id,
        plan_hash: input.plan_hash,
        pack_key: input.pack_key,
        shards: [built.shard],
        service_profile: input.service_profile,
        limits: input.limits,
        counting_method_version: input.pack.counting_method_version,
      },
      built.shard,
      built.metrics,
      now
    );
    if (!estimate.ok) {
      return estimate;
    }
    built.shard.budget_estimate_id = estimate.value.estimate_id;
    built.shard.omission_ids = [omission.omission_id];
    if (estimate.value.verdict === "exceeds_question" || estimate.value.verdict === "exceeds_request") {
      built.shard.reason_codes = ["E_EVIDENCE_EXCEEDS_BUDGET"];
    }
    shards.push(built.shard);
    estimates.push(estimate.value);
  }

  for (const bin of bins) {
    const binOmissions = omittedOptional.filter((omission) =>
      bin.questions.some((question) => omission.question_keys.includes(question.question_key))
    );
    const built = buildShard({
      planInput: input,
      questions: bin.questions,
      units: bin.units,
      omissionKeys: binOmissions.map((omission) => omission.omission_key),
      status: "planned",
    });
    shardBudgetRegister(built.shard, built.metrics);
    const estimate = estimateBudgetForShard(
      {
        schema_version: "rsi.budget_input/1",
        plan_id: input.plan_id,
        plan_hash: input.plan_hash,
        pack_key: input.pack_key,
        shards: [built.shard],
        service_profile: input.service_profile,
        limits: input.limits,
        counting_method_version: input.pack.counting_method_version,
      },
      built.shard,
      built.metrics,
      now
    );
    if (!estimate.ok) {
      return estimate;
    }
    built.shard.budget_estimate_id = estimate.value.estimate_id;
    built.shard.omission_ids = binOmissions.map((omission) => omission.omission_id);
    if (estimate.value.verdict !== "fits") {
      built.shard.status = "budget_rejected";
      built.shard.reason_codes = ["E_EVIDENCE_EXCEEDS_BUDGET"];
      omissions.push(blockingOmissionFor(input, bin.questions[0] as PlannedQuestion, bin.units));
    }
    shards.push(built.shard);
    estimates.push(estimate.value);
  }

  omissions.push(...omittedOptional);

  // DD-EVD-008: units sharing an inseparable group key may never land in
  // different shards. A single shared unit replicated into several shards is
  // not a split; two distinct group members in different shards is.
  const unitGroup = new Map<string, string>();
  for (const unit of input.closure.units) {
    unitGroup.set(unit.unit_key, unit.inseparable_group_key);
  }
  const groupShards = new Map<string, Map<string, Set<string>>>();
  for (const shard of shards) {
    for (const unitKey of shard.unit_keys) {
      const group = unitGroup.get(unitKey);
      if (group === undefined) {
        continue;
      }
      const byUnit = groupShards.get(group) ?? new Map<string, Set<string>>();
      const shardIds = byUnit.get(unitKey) ?? new Set<string>();
      shardIds.add(shard.shard_id);
      byUnit.set(unitKey, shardIds);
      groupShards.set(group, byUnit);
    }
  }
  for (const [group, byUnit] of groupShards) {
    if (byUnit.size < 2) {
      continue;
    }
    const shardIds = new Set<string>();
    for (const ids of byUnit.values()) {
      for (const id of ids) {
        shardIds.add(id);
      }
    }
    if (shardIds.size > 1) {
      return evdErr("E_EVIDENCE_INSEPARABLE_SPLIT", {
        inseparable_group_key: group,
        shard_ids: sortUtf8Strings([...shardIds]),
      });
    }
  }

  shards.sort((a, b) => (a.shard_key < b.shard_key ? -1 : 1));
  // DD-EVD-015: the manifest is a shard-local projection. Build it from the
  // real planned shard and mirror its state hash onto the shard row so the
  // persisted shard and manifest share one identity.
  const manifestReasons = new Map<string, string>();
  const judgeStates = new Map<string, import("@evoplug/core/evidence").JudgeState>();
  const manifests = buildShardManifests({
    plan,
    shards,
    units: input.closure.units,
    packKey: input.pack_key,
    packHash: input.pack.pack_hash,
    snapshot: input.snapshot as unknown as import("@evoplug/core/evidence").EvidenceIndexSnapshot,
    planState: lifecycle,
    now,
  }, manifestReasons, judgeStates);
  for (const manifest of manifests) {
    const shard = shards.find((entry) => entry.shard_id === manifest.shard_id);
    if (shard !== undefined) {
      shard.state_hash = manifest.state_hash;
    }
  }
  // A shard whose judge-state projection could not be built has no manifest.
  // Leaving it `planned` makes `commitCompile` refuse the whole batch
  // (`E_EVIDENCE_MANIFEST_MISMATCH`) and the request binding would describe a
  // state that was never projected. Mark it explicitly so the writer and the
  // binding stage both skip it.
  const manifestShardIds = new Set(manifests.map((manifest) => manifest.shard_id));
  for (const shard of shards) {
    if (
      (shard.status === "planned" || shard.status === "bound") &&
      !manifestShardIds.has(shard.shard_id)
    ) {
      // A partial plan row (no QP `sources` array) never entered the
      // projection at all. That is a direct-fixture shape, not a projection
      // failure, so the shard keeps its planned/bound state.
      if (manifestReasons.get(shard.shard_id) === "plan_incomplete") {
        continue;
      }
      shard.status = "projection_rejected";
      shard.reason_codes = [
        ...new Set([
          ...shard.reason_codes,
          "projection_rejected",
          manifestReasons.get(shard.shard_id) ?? "manifest_unavailable"
        ])
      ];
    }
  }
  const shardOrder = shards.map((shard) => shard.shard_id);
  const shardKeys = sortUtf8Strings(shards.map((shard) => shard.shard_key));
  const omissionKeys = sortUtf8Strings(omissions.map((omission) => omission.omission_key));
  const planKey = shardPlanKey({
    plan_hash: input.plan_hash,
    pack_key: input.pack_key,
    service_profile_key: profileKey,
    limits_hash: limitsHash,
    shard_keys: shardKeys,
    shard_plan_policy_version: input.shard_policy_version,
    compiler_version: input.pack.compiler_version,
    counting_method_version: input.pack.counting_method_version,
  });
  const planHash = shardPlanHash({
    shard_plan_key: planKey,
    plan_hash: input.plan_hash,
    pack_key: input.pack_key,
    shard_plan_policy_version: input.shard_policy_version,
    compiler_version: input.pack.compiler_version,
    counting_method_version: input.pack.counting_method_version,
    shard_keys: shardKeys,
    omission_keys: omissionKeys,
  });
  const shardPlanId = newId("splan", now);
  for (const omission of omissions) {
    omission.shard_plan_id = shardPlanId;
  }
  const planState = computePlanState(shards);
  const serviceProfileId =
    input.service_profile.schema_version === "rsi.jev_service_profile/1"
      ? input.service_profile.profile_id
      : newId("svcp", now);
  const shardPlan: ShardPlan = {
    schema_version: "rsi.shard_plan/1",
    shard_plan_id: shardPlanId,
    shard_plan_key: planKey,
    plan_id: input.plan_id,
    plan_hash: input.plan_hash,
    issue_id: input.issue_id,
    pack_id: input.pack.pack_id,
    pack_key: input.pack_key,
    binding: input.binding,
    service_profile_id: serviceProfileId,
    service_profile_key: profileKey,
    compiler_version: input.pack.compiler_version,
    counting_method_version: input.pack.counting_method_version,
    shard_policy_version: input.shard_policy_version,
    shard_order: shardOrder,
    shards,
    omissions,
    shard_plan_hash: planHash,
    state: planState,
    dispatch_policy: "per_shard/1",
    created_at: now,
  };
  estimates.sort((a, b) => (a.estimate_key < b.estimate_key ? -1 : 1));
  omissions.sort((a, b) => (a.omission_key < b.omission_key ? -1 : 1));
  const reasonCode =
    planState === "rejected" ? "E_EVIDENCE_PLAN_NOT_DISPATCHABLE" : null;
  return evdOk({
    schema_version: "rsi.planned_shards/1",
    plan: shardPlan,
    shards,
    estimates,
    omissions,
    manifests,
    judge_states: manifests.flatMap((manifest) => {
      const state = judgeStates.get(manifest.shard_id);
      return state === undefined
        ? []
        : [{ shard_id: manifest.shard_id, state: state as unknown as import("@evoplug/core").JsonValue }];
    }),
    state: planState,
    reason_code: reasonCode,
    commit_state: "committed",
  });
}


function shardBudgetRegister(shard: Shard, metrics: ShardBudgetMetrics): void {
  registerShardBudgetMetrics(shard, metrics);
}
