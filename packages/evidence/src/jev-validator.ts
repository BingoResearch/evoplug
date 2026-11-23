/**
 * Jev typed-answer validation and `/3` categorical output validation
 * (DD-EVD-019, DD-EVD-020, DD-EVD-020A).
 *
 * Typed validation runs J0…J11 in order; the first actual failure is the
 * `primary_error`, later stages that cannot be computed are recorded as
 * skipped. Any failure applies `reject_all`: `applied_answers` is empty while
 * normalized `answers` stay for audit.
 */

import { hashBytes, type Hash, type JsonValue, type SourceRef } from "@evoplug/core";

import { evdError } from "./errors.js";
import { sortUtf8Strings, textHash } from "./hashing.js";
import type {
  ChoiceAnswer,
  JudgeAnswer,
  NoulAnswer,
  ScoreAnswer,
  SemanticOutcome,
  SemanticQuestionRequest,
  TypedJudgeQuestion,
  EvdError,
} from "./types.js";
import { isJsonObject as sharedIsJsonObject } from "@evoplug/core";

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return sharedIsJsonObject(value);
}

export const PROBABILITY_SUM_TOLERANCE = 1e-6;
export const CONFIDENCE_TOLERANCE = 1e-6;
export const CHOICE_OPTIONS_MIN = 2;
export const CHOICE_OPTIONS_MAX = 255;
export const SCORE_LEVELS_MIN = 2;
export const SCORE_LEVELS_MAX = 10;

export interface TypedValidationResult {
  answers: Record<string, JudgeAnswer>;
  applied_answers: Record<string, JudgeAnswer>;
  semantic_outcomes: Record<
    string,
    {
      effect: "supports" | "contradicts" | "unknown" | "not_applicable" | "shadow_only";
      mapped_from: "choice" | "noul" | "score";
      hard_effect: null;
    }
  >;
  status: "accepted" | "degraded";
  errors: string[];
  skipped_by_dependency: string[];
  primary_error: string | null;
  per_answer: Record<string, { status: "accepted" | "degraded"; errors: string[] }>;
  calibration_status: "not_applicable" | "eligible" | "invalidated";
  extra_keys: string[];
  wire: unknown;
  response_hash: Hash;
}

interface MutableValidation {
  errors: string[];
  skipped: string[];
  perAnswer: Record<string, { status: "accepted" | "degraded"; errors: string[] }>;
}

function recordError(
  state: MutableValidation,
  questionKey: string,
  code: string,
  skipStages: readonly string[]
): void {
  state.errors.push(code);
  state.skipped.push(...skipStages);
  const entry = state.perAnswer[questionKey] ?? { status: "accepted", errors: [] };
  entry.status = "degraded";
  entry.errors.push(code);
  state.perAnswer[questionKey] = entry;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function probabilityRecord(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const result: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    const numeric = finiteNumber(record[key]);
    if (numeric === null) {
      return null;
    }
    result[key] = numeric;
  }
  return result;
}

function choiceConfidence(probabilities: Record<string, number>): {
  max: number;
  n: number;
  recomputed: number;
} {
  const values = Object.values(probabilities);
  const max = values.reduce((best, value) => (value > best ? value : best), 0);
  const n = values.length;
  const recomputed = n <= 1 ? 1 : (max - 1 / n) / (1 - 1 / n);
  return { max, n, recomputed };
}

export function validateTypedWire(input: {
  wire: unknown;
  questions: Record<string, TypedJudgeQuestion>;
  requested_model: string;
  returned_model: string;
  model_kind: "fixed" | "alias";
}): TypedValidationResult {
  const questionKeys = sortUtf8Strings(Object.keys(input.questions));
  const state: MutableValidation = { errors: [], skipped: [], perAnswer: {} };
  for (const key of questionKeys) {
    state.perAnswer[key] = { status: "accepted", errors: [] };
  }
  const wireRecord = asRecord(input.wire);
  const answersRecord = wireRecord === null ? null : asRecord(wireRecord["answers"]);
  const rawBytes = new TextEncoder().encode(JSON.stringify(input.wire ?? null));
  const responseHash = hashBytes(rawBytes);
  if (wireRecord === null) {
    state.errors.push("E_SCHEMA");
    return {
      answers: {},
      applied_answers: {},
      semantic_outcomes: {},
      status: "degraded",
      errors: state.errors,
      skipped_by_dependency: [],
      primary_error: "E_SCHEMA",
      per_answer: state.perAnswer,
      calibration_status: "invalidated",
      extra_keys: [],
      wire: input.wire,
      response_hash: responseHash,
    };
  }
  const knownTopLevel = new Set(["answers", "model", "returned_model", "usage"]);
  const extraKeys = sortUtf8Strings(
    Object.keys(wireRecord).filter((key) => !knownTopLevel.has(key))
  );
  const answers: Record<string, JudgeAnswer> = {};
  const applied: Record<string, JudgeAnswer> = {};
  const outcomes: TypedValidationResult["semantic_outcomes"] = {};

  // J0: answers object with exact key set.
  if (answersRecord === null) {
    state.errors.push("E_SCHEMA");
    return {
      answers,
      applied_answers: applied,
      semantic_outcomes: outcomes,
      status: "degraded",
      errors: state.errors,
      skipped_by_dependency: [],
      primary_error: "E_SCHEMA",
      per_answer: state.perAnswer,
      calibration_status: "invalidated",
      extra_keys: extraKeys,
      wire: input.wire,
      response_hash: responseHash,
    };
  }
  const actualKeys = sortUtf8Strings(Object.keys(answersRecord));
  if (questionKeys.length === 0) {
    // DD-EVD-018: "问题集合不得为空". An empty question set has no per-question
    // binding, so there is nothing the answer set could match: J0 refuses the
    // batch instead of accepting a vacuous key-set comparison. The request
    // builder rejects the same input earlier with `E_TEMPLATE_BINDING_MISSING`.
    state.errors.push("E_ANSWER_SET");
    return {
      answers,
      applied_answers: applied,
      semantic_outcomes: outcomes,
      status: "degraded",
      errors: state.errors,
      skipped_by_dependency: ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11"],
      primary_error: "E_ANSWER_SET",
      per_answer: state.perAnswer,
      calibration_status: "invalidated",
      extra_keys: extraKeys,
      wire: input.wire,
      response_hash: responseHash,
    };
  }
  if (JSON.stringify(actualKeys) !== JSON.stringify(questionKeys)) {
    state.errors.push("E_ANSWER_SET");
    return {
      answers,
      applied_answers: applied,
      semantic_outcomes: outcomes,
      status: "degraded",
      errors: state.errors,
      skipped_by_dependency: ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11"],
      primary_error: "E_ANSWER_SET",
      per_answer: state.perAnswer,
      calibration_status: "invalidated",
      extra_keys: extraKeys,
      wire: input.wire,
      response_hash: responseHash,
    };
  }

  for (const questionKey of questionKeys) {
    const request = input.questions[questionKey];
    const raw = asRecord(answersRecord[questionKey]);
    const answerExtra =
      raw === null
        ? []
        : Object.keys(raw).filter(
            (key) =>
              !["type", "noul", "choice", "confidence", "probabilities", "score", "legend"].includes(key)
          );
    if (answerExtra.length > 0) {
      extraKeys.push(...answerExtra.map((key) => `${questionKey}.${key}`));
    }
    if (request === undefined || raw === null) {
      recordError(state, questionKey, "E_SCHEMA", ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11"]);
      continue;
    }
    // J1
    if (raw["type"] !== request.type) {
      recordError(state, questionKey, "E_TYPE", ["J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11"]);
      continue;
    }
    // J2 + J3/J9 structure
    if (request.type === "noul") {
      // `p_yes` is not a wire alias: only the `noul` key is accepted.
      if (!Object.prototype.hasOwnProperty.call(raw, "noul")) {
        recordError(state, questionKey, "E_SCHEMA", ["J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11"]);
        continue;
      }
      const pYes = finiteNumber(raw["noul"]);
      if (pYes === null) {
        recordError(state, questionKey, "E_NON_FINITE", ["J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11"]);
        continue;
      }
      if (pYes < 0 || pYes > 1) {
        recordError(state, questionKey, "E_PROBABILITY_RANGE", ["J6", "J7", "J8", "J9", "J10", "J11"]);
        continue;
      }
      const answer: NoulAnswer = {
        type: "noul",
        p_yes: pYes,
        confidence: null,
        s: null,
        s_source: "none",
      };
      answers[questionKey] = answer;
      applied[questionKey] = answer;
      outcomes[questionKey] = { effect: "unknown", mapped_from: "noul", hard_effect: null };
      continue;
    }
    if (request.type === "choice") {
      const choiceRaw = raw["choice"];
      const reported = finiteNumber(raw["confidence"]);
      const probabilities = probabilityRecord(raw["probabilities"]);
      if (typeof choiceRaw !== "string" || reported === null || probabilities === null) {
        recordError(state, questionKey, "E_SCHEMA", ["J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11"]);
        continue;
      }
      const criteria = Object.keys(request.criteria);
      const probKeys = sortUtf8Strings(Object.keys(probabilities));
      if (JSON.stringify(probKeys) !== JSON.stringify(sortUtf8Strings(criteria))) {
        recordError(state, questionKey, "E_PROBABILITY_KEYS", ["J5", "J6", "J7", "J8", "J9", "J10", "J11"]);
        continue;
      }
      let rangeOk = true;
      for (const value of Object.values(probabilities)) {
        if (value < 0 || value > 1) {
          rangeOk = false;
          break;
        }
      }
      if (!rangeOk) {
        recordError(state, questionKey, "E_PROBABILITY_RANGE", ["J6", "J7", "J8", "J9", "J10", "J11"]);
        continue;
      }
      const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
      if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
        recordError(state, questionKey, "E_PROBABILITY_SUM", ["J7", "J8", "J9", "J10", "J11"]);
        continue;
      }
      if (!criteria.includes(choiceRaw)) {
        recordError(state, questionKey, "E_CHOICE_OUT_OF_SET", ["J8", "J9", "J10", "J11"]);
        continue;
      }
      if (!criteria.includes("unknown")) {
        recordError(state, questionKey, "E_UNKNOWN_OPTION", ["J9", "J10", "J11"]);
        continue;
      }
      if (criteria.length < CHOICE_OPTIONS_MIN || criteria.length > CHOICE_OPTIONS_MAX) {
        recordError(state, questionKey, "E_OPTION_COUNT", ["J9", "J10", "J11"]);
        continue;
      }
      const { recomputed } = choiceConfidence(probabilities);
      const answer: ChoiceAnswer = {
        type: "choice",
        choice: choiceRaw,
        probabilities,
        confidence_reported: reported,
        confidence_recomputed: recomputed,
        confidence_delta: reported - recomputed,
      };
      // The normalized answer stays available for audit even when the
      // confidence gate rejects it; only `applied_answers` is cleared.
      answers[questionKey] = answer;
      if (Math.abs(reported - recomputed) > CONFIDENCE_TOLERANCE) {
        recordError(state, questionKey, "E_CONFIDENCE_MISMATCH", ["J11"]);
        continue;
      }
      applied[questionKey] = answer;
      outcomes[questionKey] = {
        effect: choiceRaw === "unknown" ? "unknown" : "unknown",
        mapped_from: "choice",
        hard_effect: null,
      };
      continue;
    }
    // score
    const score = finiteNumber(raw["score"]);
    const reported = finiteNumber(raw["confidence"]);
    const probabilities = probabilityRecord(raw["probabilities"]);
    const legend = Array.isArray(raw["legend"])
      ? raw["legend"].filter((entry): entry is string => typeof entry === "string")
      : null;
    if (score === null || reported === null || probabilities === null || legend === null) {
      recordError(state, questionKey, "E_SCHEMA", ["J4", "J5", "J6", "J9", "J10", "J11"]);
      continue;
    }
    const levels = request.criteria;
    if (
      legend.length !== levels.length ||
      JSON.stringify(sortUtf8Strings(Object.keys(probabilities))) !==
        JSON.stringify(sortUtf8Strings(legend)) ||
      levels.length < SCORE_LEVELS_MIN ||
      levels.length > SCORE_LEVELS_MAX
    ) {
      recordError(state, questionKey, "E_SCORE_LEVELS", ["J10", "J11"]);
      continue;
    }
    const answer: ScoreAnswer = {
      type: "score",
      score,
      legend,
      probabilities,
      confidence_reported: reported,
      confidence_recomputed: null,
      confidence_delta: null,
      score_use: "shadow_only",
    };
    answers[questionKey] = answer;
    applied[questionKey] = answer;
    outcomes[questionKey] = { effect: "shadow_only", mapped_from: "score", hard_effect: null };
  }

  // J11 model match (request-level).
  let primary = state.errors[0] ?? null;
  let calibration: TypedValidationResult["calibration_status"];
  if (input.returned_model !== input.requested_model) {
    if (input.model_kind === "fixed") {
      state.errors.push("E_MODEL_MISMATCH");
      primary = primary ?? "E_MODEL_MISMATCH";
    }
    calibration = "invalidated";
  } else {
    calibration = state.errors.length > 0 ? "invalidated" : "not_applicable";
  }
  const status = state.errors.length === 0 ? "accepted" : "degraded";
  return {
    answers,
    applied_answers: status === "accepted" ? applied : {},
    semantic_outcomes: status === "accepted" ? outcomes : {},
    status,
    errors: state.errors,
    skipped_by_dependency: sortUtf8Strings(state.skipped),
    primary_error: primary,
    per_answer: state.perAnswer,
    calibration_status: calibration,
    extra_keys: sortUtf8Strings(extraKeys),
    wire: input.wire,
    response_hash: responseHash,
  };
}

/* ------------------------------------------------------------------ */
/* `/3` categorical output                                             */
/* ------------------------------------------------------------------ */

export type CategoricalReason =
  | "schema_invalid"
  | "answer_set"
  | "duplicate_question"
  | "option_out_of_set"
  | "evidence_ref_outside_manifest"
  | "option_effect_missing"
  | "counterevidence_missing"
  | "non_categorical_field"
  | "usage_invalid";

export interface CategoricalValidationFailure {
  ok: false;
  reason: CategoricalReason;
  offending_question_key: string | null;
  field: string;
  usage: unknown;
  response_hash: Hash;
}

export interface CategoricalValidationSuccess {
  ok: true;
  outcomes: Record<string, SemanticOutcome>;
  usage: unknown;
  response_hash: Hash;
}

export type CategoricalValidation = CategoricalValidationSuccess | CategoricalValidationFailure;

const FORBIDDEN_ANSWER_FIELDS = new Set([
  "probability",
  "probabilities",
  "confidence",
  "free_text",
  "hard_effect",
  "option_effect",
  "grant",
]);

function manifestAllows(ref: SourceRef, allowed: ReadonlySet<string>): boolean {
  return allowed.has(ref);
}

function emptyOutcome(optionKey: string | null, effect: SemanticOutcome["effect"], evidence: SourceRef[], counter: SourceRef[]): SemanticOutcome {
  return {
    effect,
    mapped_from: "categorical_option",
    option_key: optionKey,
    evidence_refs: sortUtf8Strings(evidence) as SourceRef[],
    counterevidence_refs: sortUtf8Strings(counter) as SourceRef[],
    hard_effect: null,
  };
}

export function validateCategoricalOutput(input: {
  wire: unknown;
  questions: readonly SemanticQuestionRequest[];
  optionEffects: Record<string, Record<string, "supports" | "contradicts" | "unknown">>;
  manifestRefs: readonly SourceRef[];
}): CategoricalValidation {
  const responseHash = hashBytes(new TextEncoder().encode(JSON.stringify(input.wire ?? null)));
  const fail = (
    reason: CategoricalReason,
    questionKey: string | null,
    field: string,
    usage: unknown = null
  ): CategoricalValidationFailure => ({
    ok: false,
    reason,
    offending_question_key: questionKey,
    field,
    usage,
    response_hash: responseHash,
  });
  const wire = asRecord(input.wire);
  if (wire === null) {
    return fail("schema_invalid", null, "body");
  }
  const unknownTop = Object.keys(wire).filter(
    (key) => !["answers", "usage", "returned_model"].includes(key)
  );
  if (unknownTop.length > 0) {
    return fail("schema_invalid", null, unknownTop[0] ?? "body");
  }
  const rawAnswers = wire["answers"];
  if (!Array.isArray(rawAnswers)) {
    return fail("schema_invalid", null, "answers");
  }
  const byKey = new Map<string, Record<string, unknown>>();
  for (const raw of rawAnswers) {
    const answer = asRecord(raw);
    if (answer === null) {
      return fail("schema_invalid", null, "answers[]");
    }
    for (const key of Object.keys(answer)) {
      if (FORBIDDEN_ANSWER_FIELDS.has(key)) {
        return fail("non_categorical_field", null, key);
      }
      if (!["question_key", "option_key", "evidence_refs", "counterevidence_refs"].includes(key)) {
        return fail("non_categorical_field", null, key);
      }
    }
    const questionKey = answer["question_key"];
    if (typeof questionKey !== "string") {
      return fail("schema_invalid", null, "answers[].question_key");
    }
    if (byKey.has(questionKey)) {
      return fail("duplicate_question", questionKey, "question_key");
    }
    byKey.set(questionKey, answer);
  }
  const expectedKeys = sortUtf8Strings(input.questions.map((question) => question.question_key));
  const actualKeys = sortUtf8Strings([...byKey.keys()]);
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    return fail("answer_set", null, "question_key");
  }
  const allowedRefs = new Set<string>(input.manifestRefs);
  const outcomes: Record<string, SemanticOutcome> = {};
  for (const question of input.questions) {
    const answer = byKey.get(question.question_key);
    if (answer === undefined) {
      return fail("answer_set", question.question_key, "question_key");
    }
    const optionKey = answer["option_key"];
    if (optionKey !== null) {
      if (typeof optionKey !== "string") {
        return fail("schema_invalid", question.question_key, "option_key");
      }
      if (!question.options.some((option) => option.option_key === optionKey)) {
        return fail("option_out_of_set", question.question_key, "option_key");
      }
    }
    const evidence = answer["evidence_refs"];
    const counter = answer["counterevidence_refs"];
    const evidenceRefs: SourceRef[] = [];
    if (evidence !== undefined) {
      if (!Array.isArray(evidence)) {
        return fail("schema_invalid", question.question_key, "evidence_refs");
      }
      for (const ref of evidence) {
        if (typeof ref !== "string") {
          return fail("schema_invalid", question.question_key, "evidence_refs");
        }
        if (!manifestAllows(ref as SourceRef, allowedRefs)) {
          return fail("evidence_ref_outside_manifest", question.question_key, "evidence_refs");
        }
        evidenceRefs.push(ref as SourceRef);
      }
    }
    const counterRefs: SourceRef[] = [];
    if (counter !== undefined) {
      if (!Array.isArray(counter)) {
        return fail("schema_invalid", question.question_key, "counterevidence_refs");
      }
      for (const ref of counter) {
        if (typeof ref !== "string") {
          return fail("schema_invalid", question.question_key, "counterevidence_refs");
        }
        if (!manifestAllows(ref as SourceRef, allowedRefs)) {
          return fail("evidence_ref_outside_manifest", question.question_key, "counterevidence_refs");
        }
        counterRefs.push(ref as SourceRef);
      }
    }
    const effects = input.optionEffects[question.question_key] ?? {};
    let effect: SemanticOutcome["effect"] = "unknown";
    if (optionKey === null) {
      effect = "unknown";
    } else {
      const mapped = effects[optionKey];
      if (mapped === undefined) {
        return fail("option_effect_missing", question.question_key, "option_key");
      }
      effect = mapped;
    }
    if (effect === "supports" && evidenceRefs.length === 0) {
      return fail("counterevidence_missing", question.question_key, "evidence_refs");
    }
    if (effect === "contradicts" && (evidenceRefs.length === 0 || counterRefs.length === 0)) {
      return fail("counterevidence_missing", question.question_key, "counterevidence_refs");
    }
    outcomes[question.question_key] = emptyOutcome(
      optionKey === null ? null : optionKey,
      effect,
      evidenceRefs,
      counterRefs
    );
  }
  const usage = wire["usage"];
  if (usage !== undefined) {
    const usageRecord = asRecord(usage);
    if (usageRecord === null) {
      return fail("usage_invalid", null, "usage");
    }
    const numericFields = [
      "elapsed_ms",
      "read_bytes",
      "retrieval_count",
      "model_invocations",
      "verifier_invocations",
    ] as const;
    for (const field of numericFields) {
      const value = usageRecord[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        return fail("usage_invalid", null, field);
      }
    }
    const costMicros = usageRecord["cost_micros"];
    const costStatus = usageRecord["cost_status"];
    if (
      costStatus !== undefined &&
      costStatus !== "known" &&
      costStatus !== "unknown" &&
      costStatus !== "not_applicable"
    ) {
      return fail("usage_invalid", null, "cost_status");
    }
    if (costStatus === "known" && (typeof costMicros !== "number" || !Number.isFinite(costMicros))) {
      return fail("usage_invalid", null, "cost_micros");
    }
    if (costStatus === "unknown" && costMicros !== null && costMicros !== undefined) {
      return fail("usage_invalid", null, "cost_micros");
    }
  }
  return { ok: true, outcomes, usage: usage ?? null, response_hash: responseHash };
}

export function semanticOutputInvalidError(
  backendKey: Hash,
  failure: CategoricalValidationFailure
): EvdError {
  return evdError("E_SEMANTIC_OUTPUT_INVALID", {
    backend_key: backendKey,
    offending_question_key: failure.offending_question_key,
    field: failure.field,
    reason: failure.reason,
  });
}

export function normalizedAnswerTextHash(answer: JudgeAnswer): Hash {
  return textHash(JSON.stringify(answer));
}

