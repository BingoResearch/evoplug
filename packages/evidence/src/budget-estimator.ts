/**
 * Budget estimation (DD-EVD-013, DD-EVD-014).
 *
 * Token estimates are deterministic for the same canonical state and counting
 * method. Metrics are registered by the shard planner, which owns the frozen
 * unit excerpts; a shard without registered metrics fails closed with
 * `E_EVIDENCE_LIMITS_UNKNOWN` instead of guessing a state size.
 */

import { newId, type Hash, type JsonValue, type Result } from "@evoplug/core";

import { evdErr, evdOk } from "./errors.js";
import {
  budgetEstimateHash,
  budgetEstimateKey,
  jevLimitsHash,
  jcsHash,
  semanticBudgetEstimateKey,
  sortUtf8Strings,
  utf8Length,
} from "./hashing.js";
import { type BudgetEstimate, type BudgetInput, type BudgetLimitsView, type JevServiceProfile, type SemanticBackendCapability, type SemanticBackendLimits, type SemanticBudgetEstimate, type SemanticBudgetInput, type Shard, type EvdError } from "./types.js";

export interface ShardBudgetMetrics {
  /** Canonical serialized state text actually sent for this shard. */
  state_text: string;
  /** Canonical typed question text per `question_key`. */
  question_text: Record<string, string>;
  /** QP `output_reserve_tokens` per `question_key`. */
  output_reserve: Record<string, number>;
  /** `required_for_issue` per `question_key`. */
  required_for_issue: Record<string, boolean>;
}

const METRICS = new WeakMap<Shard, ShardBudgetMetrics>();

export function registerShardBudgetMetrics(shard: Shard, metrics: ShardBudgetMetrics): void {
  METRICS.set(shard, metrics);
}

export function shardBudgetMetrics(shard: Shard): ShardBudgetMetrics | undefined {
  return METRICS.get(shard);
}

function limitsOfProfile(
  profile: JevServiceProfile | SemanticBackendCapability
): BudgetLimitsView | null {
  if (profile.schema_version === "rsi.jev_service_profile/1") {
    return profile.limits;
  }
  return null;
}

function profileKeyOf(profile: JevServiceProfile | SemanticBackendCapability): Hash {
  return profile.schema_version === "rsi.jev_service_profile/1"
    ? profile.profile_key
    : profile.capability_key;
}

function sortedKeys(record: Record<string, unknown>): string[] {
  return sortUtf8Strings(Object.keys(record));
}

export function estimateBudgetForShard(
  input: BudgetInput,
  shard: Shard,
  metrics: ShardBudgetMetrics,
  now: number
): Result<BudgetEstimate, EvdError> {
  const limits = limitsOfProfile(input.service_profile);
  if (limits === null) {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "service_profile" });
  }
  const questionKeysForCalibration = sortUtf8Strings(shard.question_keys);
  const calibration = input.usage_calibration;
  if (
    calibration !== undefined &&
    limits.request_max_tokens !== null &&
    calibration.observed_input_tokens > limits.request_max_tokens
  ) {
    return evdErr("E_USAGE_ESTIMATE_UNDERFLOW", {
      question_key: questionKeysForCalibration[0] ?? "",
      estimate: calibration.estimated_input_tokens,
      observed: calibration.observed_input_tokens,
    });
  }
  const reserveTokens = metrics.output_reserve;
  const requiredKeys = Object.keys(reserveTokens).sort((a, b) => (a < b ? -1 : 1));
  const questionKeys = sortedKeys(metrics.question_text);
  if (JSON.stringify(requiredKeys) !== JSON.stringify(questionKeys)) {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "question_tokens" });
  }
  const perQuestion: Record<string, number> = {};
  const framePerQuestion: Record<string, number> = {};
  const perQuestionOutput: Record<string, number> = {};
  const perQuestionMargin: Record<string, number> = {};
  for (const key of questionKeys) {
    perQuestion[key] = utf8Length(metrics.question_text[key] ?? "");
    framePerQuestion[key] = utf8Length(key);
    perQuestionOutput[key] = reserveTokens[key] ?? 0;
    perQuestionMargin[key] = input.limits.question_margin_tokens;
  }
  const stateTokens = utf8Length(metrics.state_text);
  const frameRequest = utf8Length(JSON.stringify(questionKeys));
  const requestOutput = Object.values(perQuestionOutput).reduce((sum, value) => sum + value, 0);
  const requestMargin = input.limits.request_margin_tokens;

  const limitsUnknown =
    limits.source === "unknown" ||
    limits.request_max_tokens === null ||
    limits.question_max_tokens === null;
  const requestTotal =
    frameRequest + stateTokens + Object.values(perQuestion).reduce((sum, value) => sum + value, 0) + requestOutput + requestMargin;
  const checks: BudgetEstimate["checks"] = {
    request_total: requestTotal,
    request_ok: limits.request_max_tokens !== null && requestTotal <= limits.request_max_tokens,
    per_question: questionKeys.map((key) => {
      const total =
        (framePerQuestion[key] ?? 0) +
        stateTokens +
        (perQuestion[key] ?? 0) +
        (perQuestionOutput[key] ?? 0) +
        (perQuestionMargin[key] ?? 0);
      return {
        question_key: key,
        total,
        ok: limits.question_max_tokens !== null && total <= limits.question_max_tokens,
      };
    }),
  };
  const failingQuestion = checks.per_question.find((entry) => !entry.ok);
  let verdict: BudgetEstimate["verdict"];
  let limitingQuestionKey: string | undefined;
  if (limitsUnknown) {
    verdict = "limits_unknown";
    limitingQuestionKey = requiredKeys[0];
  } else if (failingQuestion !== undefined) {
    verdict = "exceeds_question";
    limitingQuestionKey = failingQuestion.question_key;
  } else if (!checks.request_ok) {
    verdict = "exceeds_request";
    limitingQuestionKey = requiredKeys[0];
  } else {
    verdict = "fits";
  }
  const headroom =
    limits.request_max_tokens === null ? undefined : limits.request_max_tokens - requestTotal;

  const estimateKey = budgetEstimateKey({
    shard_key: shard.shard_key,
    service_profile_key: profileKeyOf(input.service_profile),
    limits_hash: limits.limits_hash,
    counting_method_version: input.counting_method_version,
    frame_req: frameRequest,
    state_tokens: stateTokens,
    question_tokens: perQuestion,
    reserves: {
      per_question_output: perQuestionOutput,
      per_question_margin: perQuestionMargin,
    },
    checks: checks.per_question,
    verdict,
    limiting_question_key: limitingQuestionKey ?? null,
  });
  const draft: Omit<BudgetEstimate, "estimate_hash"> = {
    schema_version: "rsi.budget_estimate/1",
    estimate_id: newId("best", now),
    estimate_key: estimateKey,
    shard_id: shard.shard_id,
    shard_key: shard.shard_key,
    plan_id: input.plan_id,
    service_profile_id:
      input.service_profile.schema_version === "rsi.jev_service_profile/1"
        ? input.service_profile.profile_id
        : newId("svcp", now),
    service_profile_key: profileKeyOf(input.service_profile),
    counting_method_version: input.counting_method_version,
    estimator: {
      name: "utf8-bytes",
      version: "1",
      tokenizer_source: "local_estimate",
      notes_version: "evd-budget/1",
    },
    limits: {
      request_max_tokens: limits.request_max_tokens,
      question_max_tokens: limits.question_max_tokens,
      source: limits.source,
      source_refs: sortUtf8Strings(limits.source_refs) as BudgetEstimate["limits"]["source_refs"],
      limits_hash: limits.limits_hash,
    },
    frame_tokens: { request: frameRequest, per_question: framePerQuestion },
    state_tokens: stateTokens,
    question_tokens: perQuestion,
    reserves: {
      request_output: requestOutput,
      per_question_output: perQuestionOutput,
      request_margin: requestMargin,
      per_question_margin: perQuestionMargin,
    },
    checks,
    verdict,
    created_at: now,
  };
  if (limitingQuestionKey !== undefined) {
    draft.limiting_question_key = limitingQuestionKey;
  }
  if (headroom !== undefined) {
    draft.headroom_tokens = headroom;
  }
  const estimate: BudgetEstimate = { ...draft, estimate_hash: budgetEstimateHash(draft) };
  if (
    input.usage_calibration !== undefined &&
    input.usage_calibration.estimated_input_tokens > 0
  ) {
    // Observation only: it never enters `estimate_key`/`estimate_hash` and is
    // never written back into a historical estimate.
    estimate.usage_calibration = {
      observed_input_tokens: input.usage_calibration.observed_input_tokens,
      estimated_input_tokens: input.usage_calibration.estimated_input_tokens,
      ratio:
        input.usage_calibration.observed_input_tokens /
        input.usage_calibration.estimated_input_tokens,
      observed_at: now,
    };
  }
  return evdOk(estimate);
}

export function estimateBudget(input: BudgetInput, now: number = Date.now()): Result<BudgetEstimate, EvdError> {
  if (input.schema_version !== "rsi.budget_input/1") {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "schema_version" });
  }
  const sorted = [...input.shards].sort((a, b) => (a.shard_key < b.shard_key ? -1 : 1));
  const first = sorted[0];
  if (first === undefined) {
    return evdErr("E_BUDGET_RESERVE_INCONSISTENT", { aggregate_output_reserve_tokens: 0 });
  }
  if (sorted.length > 1) {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "shards" });
  }
  const metrics = METRICS.get(first);
  if (metrics === undefined) {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "state_tokens" });
  }
  return estimateBudgetForShard(input, first, metrics, now);
}

function semanticChecks(
  counts: SemanticBudgetEstimate["counts"],
  limits: SemanticBackendLimits
): SemanticBudgetEstimate["checks"] {
  // DD-EVD-013: "`checks` 每项按 `field` UTF-8 排序". The closed five-field
  // set is emitted in UTF-8 field order, and `limiting_field` is the first
  // failing entry of that sorted array.
  const fields: Array<SemanticBudgetEstimate["checks"][number]["field"]> = [
    "evidence_items",
    "questions",
    "request_bytes",
    "response_bytes",
    "state_bytes",
  ];
  const limitFor: Record<(typeof fields)[number], number> = {
    questions: limits.max_questions,
    evidence_items: limits.max_evidence_items,
    state_bytes: limits.max_state_bytes,
    request_bytes: limits.max_request_bytes,
    response_bytes: limits.max_response_bytes,
  };
  return fields.map((field) => {
    const observed = counts[field];
    const limit = limitFor[field];
    return { field, observed, limit, ok: observed <= limit };
  });
}

export function estimateSemanticBudget(
  input: SemanticBudgetInput,
  now: number = Date.now()
): Result<SemanticBudgetEstimate, EvdError> {
  const { capability, request, shard } = input;
  const requestBytes = utf8Length(JSON.stringify(request));
  const responseEstimate = utf8Length(
    JSON.stringify(request.questions.map((question) => question.question_key))
  );
  const counts: SemanticBudgetEstimate["counts"] = {
    questions: request.questions.length,
    evidence_items: request.evidence.length,
    state_bytes: request.state?.content_bytes ?? 0,
    request_bytes: requestBytes,
    response_bytes: responseEstimate,
  };
  const checks = semanticChecks(counts, capability.limits);
  const firstFailure = checks.find((entry) => !entry.ok);
  const verdict: SemanticBudgetEstimate["verdict"] =
    firstFailure === undefined ? "fits" : "exceeds_request";
  const limiting = firstFailure?.field ?? null;
  const estimateKey = semanticBudgetEstimateKey({
    shard_key: shard.shard_key,
    capability_key: capability.capability_key,
    capability_hash: capability.capability_hash,
    limits_hash: capability.limits.limits_hash,
    counts: JSON.parse(JSON.stringify(counts)) as JsonValue,
    checks: JSON.parse(JSON.stringify(checks)) as JsonValue,
    verdict,
    limiting_field: limiting,
  });
  const draft: Omit<SemanticBudgetEstimate, "estimate_hash"> = {
    schema_version: "rsi.semantic_budget_estimate/1",
    estimate_id: newId("best", now),
    estimate_key: estimateKey,
    shard_id: shard.shard_id,
    shard_key: shard.shard_key,
    shard_plan_id: newId("splan", now),
    capability_key: capability.capability_key,
    capability_hash: capability.capability_hash,
    service_profile_key: capability.capability_key,
    estimator: { name: "utf8-bytes", version: "1" },
    limits: capability.limits,
    counts,
    checks,
    verdict,
    limiting_field: limiting,
    created_at: now,
  };
  const estimate: SemanticBudgetEstimate = {
    ...draft,
    estimate_hash: semanticBudgetEstimateHashOf(draft),
  };
  return evdOk(estimate);
}

function semanticBudgetEstimateHashOf(estimate: Omit<SemanticBudgetEstimate, "estimate_hash">): Hash {
  return jcsHash({
    schema_version: "rsi.semantic_budget_estimate/1",
    estimate_key: estimate.estimate_key,
    service_profile_key: estimate.service_profile_key,
    estimator: estimate.estimator,
    limits: estimate.limits,
    counts: JSON.parse(JSON.stringify(estimate.counts)) as JsonValue,
    checks: JSON.parse(JSON.stringify(estimate.checks)) as JsonValue,
    verdict: estimate.verdict,
    limiting_field: estimate.limiting_field,
  });
}

export { jevLimitsHash };
