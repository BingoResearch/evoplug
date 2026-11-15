/**
 * Judgment route audit records (DD-QP-31).
 *
 * A route records the path actually taken. It never stores a conclusion,
 * authorization or second aggregate. Identity is content-addressed:
 * `route_key`, `route_hash`, then `route_id`; no ULID is allocated.
 */

import { compareUtf8, sortUtf8 } from "../canonical.js";
import { systemClock, type Clock } from "../clock.js";
import type { ErrorEnvelope } from "../errors.js";
import type { Result } from "../result.js";
import type { JsonValue } from "../json.js";
import { parseHostInteractionEscalation } from "../host/interaction/index.js";
import { MAX_SOURCE_REFS } from "./constants.js";
import { qpFailure } from "./errors.js";
import { QpDomainError } from "./issue_repository.js";
import {
  evidenceGapsPreimage,
  hashJson,
  routeContentHash,
  routeEvidenceSetHash,
  routeHash,
  routeId,
  routeKey,
  routeGapsHash,
  sorted,
  sortedUnique,
  toJsonValue
} from "./hashes.js";
import type {
  EvidenceGap,
  JudgmentRouteAppendRequest,
  JudgmentRouteAppendResult,
  JudgmentRouteCost,
  JudgmentRouteCostStatus,
  JudgmentRouteDraft,
  JudgmentRouteRecord,
  JudgmentRouteReason,
  JudgmentRouteStage,
  JudgmentRouteStageName,
  MethodRef,
  QuestionPlanRepository
} from "./types.js";
import type { Tx } from "../tx.js";
import type { QpJournalCommitPort, QpLiveCommitOutcome, QpJudgmentRouteEvent } from "./journal_port.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROUTE_ID_PATTERN = /^route:[0-9a-f]{64}$/;
const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const STAGE_ORDER: readonly JudgmentRouteStageName[] = Object.freeze([
  "deterministic",
  "retrieval",
  "semantic",
  "verification"
]);

const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "final_state",
  "final_basis",
  "decision",
  "outcome",
  "grant",
  "authorization",
  "applicable",
  "applicability"
]);

/**
 * The strict closed sets of DD-QP-31b.
 *
 * A field name outside the closed set is `E_SCHEMA` at the schema stage, so
 * an undeclared field can never reach the hash or the object body.
 */
const DRAFT_FIELDS: readonly string[] = Object.freeze([
  "schema_version",
  "route_id",
  "route_key",
  "route_hash",
  "route_status",
  "route_policy_version",
  "route_class",
  "project_id",
  "binding",
  "scope",
  "issue_key",
  "question_key",
  "template_binding",
  "plan_ref",
  "aggregate_ref",
  "semantic_eligibility",
  "evidence_set_hash",
  "stages",
  "gaps",
  "reason_codes",
  "policy_factors",
  "escalation",
  "deadline",
  "deadline_ref",
  "total_cost",
  "budget_receipt_ref",
  "consumer_ref"
]);

const BINDING_FIELDS: readonly string[] = Object.freeze([
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "watermark"
]);

const SCOPE_FIELDS: readonly string[] = Object.freeze(["subject_key", "subject_versions"]);

const STAGE_FIELDS: readonly string[] = Object.freeze([
  "stage",
  "status",
  "method",
  "evidence",
  "result_refs",
  "verification",
  "reason_codes",
  "cost"
]);

const METHOD_FIELDS: readonly string[] = Object.freeze([
  "schema_version",
  "method_id",
  "method_version",
  "rule_version"
]);

const EVIDENCE_FIELDS: readonly string[] = Object.freeze([
  "source_ref",
  "content_hash",
  "role",
  "scope"
]);

const EVIDENCE_SCOPE_FIELDS: readonly string[] = Object.freeze([
  "subject_keys",
  "subject_versions",
  "coverage"
]);

const RESULT_REF_FIELDS: readonly string[] = Object.freeze(["kind", "result_id", "result_hash"]);

const VERIFICATION_FIELDS: readonly string[] = Object.freeze([
  "fact_id",
  "fact_content_hash",
  "verifier_ref",
  "producer_ref",
  "independent",
  "verification_plan_id",
  "verification_plan_hash",
  "covered_subject_keys",
  "covered_versions"
]);

const COST_FIELDS: readonly string[] = Object.freeze([
  "elapsed_ms",
  "cpu_ms",
  "read_bytes",
  "retrieval_count",
  "model_invocations",
  "input_tokens",
  "output_tokens",
  "verifier_invocations",
  "amount",
  "currency",
  "cost_status",
  "receipt_ref"
]);

const DEADLINE_FIELDS: readonly string[] = Object.freeze([
  "total_ms",
  "deterministic_ms",
  "retrieval_ms",
  "semantic_ms",
  "verification_ms"
]);

const PLAN_REF_FIELDS: readonly string[] = Object.freeze(["plan_id", "plan_hash"]);
const AGGREGATE_REF_FIELDS: readonly string[] = Object.freeze(["aggregate_id", "aggregate_hash"]);
const TEMPLATE_BINDING_FIELDS: readonly string[] = Object.freeze([
  "template_id",
  "template_version",
  "template_hash"
]);
const SEMANTIC_ELIGIBILITY_FIELDS: readonly string[] = Object.freeze([
  "backend_key",
  "capability_hash",
  "semantic_scope_key"
]);
const ESCALATION_FIELDS: readonly string[] = Object.freeze(["kind", "reason_code"]);
const GAP_FIELDS: readonly string[] = Object.freeze([
  "code",
  "requirement_ids",
  "source_refs",
  "affects_question_keys"
]);
const CONSUMER_REF_FIELDS: readonly string[] = Object.freeze(["kind", "ref_id"]);

/**
 * Reports the field names of `value` that the closed set does not list.
 *
 * The scan is by key name only; an enum value may legitimately be one of the
 * forbidden words.
 */
function undeclaredFields(value: unknown, allowed: readonly string[]): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

const RESIDUAL_REASONS: readonly JudgmentRouteReason[] = Object.freeze([
  "retrieval_gap",
  "retrieval_truncated",
  "budget_exhausted",
  "deadline_exceeded",
  "rate_limited",
  "cancelled",
  "owner_unavailable"
]);

const ALLOWED_REASONS: Readonly<Record<JudgmentRouteStageName, readonly JudgmentRouteReason[]>> = Object.freeze({
  deterministic: [
    "deterministic_decisive",
    "deterministic_inconclusive",
    "scope_mismatch",
    "version_stale",
    "counterevidence",
    "conflict",
    "budget_exhausted",
    "deadline_exceeded",
    "cancelled",
    "skipped_by_order",
    "owner_unavailable"
  ],
  retrieval: [
    "retrieval_required",
    "retrieval_gap",
    "retrieval_truncated",
    "scope_mismatch",
    "version_stale",
    "counterevidence",
    "budget_exhausted",
    "deadline_exceeded",
    "rate_limited",
    "cancelled",
    "skipped_by_order",
    "owner_unavailable"
  ],
  semantic: [
    "semantic_not_needed",
    "semantic_disabled",
    "semantic_unavailable",
    "semantic_shadow",
    "semantic_unknown",
    "scope_mismatch",
    "version_stale",
    "counterevidence",
    "conflict",
    "budget_exhausted",
    "deadline_exceeded",
    "rate_limited",
    "cancelled",
    "late_discarded",
    "skipped_by_order",
    "owner_unavailable"
  ],
  verification: [
    "verification_existing_fact",
    "verification_absent",
    "verification_failed",
    "verification_not_independent",
    "scope_mismatch",
    "version_stale",
    "counterevidence",
    "conflict",
    "budget_exhausted",
    "deadline_exceeded",
    "cancelled",
    "skipped_by_order",
    "owner_unavailable"
  ]
});

function schemaError(stage: string, detail?: string): QpDomainError {
  return new QpDomainError(qpFailure("E_SCHEMA", stage, detail === undefined ? {} : { detail }));
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenKey(entry));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      return true;
    }
    if (containsForbiddenKey(entry)) {
      return true;
    }
  }
  return false;
}

function isHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

function validateMethod(method: MethodRef, stage: JudgmentRouteStageName): void {
  if (
    method.schema_version !== "rsi.method_ref/1" ||
    method.method_id.length < 1 ||
    method.method_id.length > 128 ||
    method.method_version.length < 1 ||
    method.method_version.length > 128 ||
    method.rule_version.length < 1 ||
    method.rule_version.length > 128
  ) {
    throw schemaError("judgment_route_method", stage);
  }
}

function validateStageShape(stage: JudgmentRouteStage, index: number): void {
  if (stage.stage !== STAGE_ORDER[index]) {
    throw schemaError("judgment_route_shape", "stage_order");
  }
  if (stage.status === "performed" && stage.method === null) {
    throw schemaError("judgment_route_schema", "performed_method");
  }
  if ((stage.status === "skipped" || stage.status === "unavailable") && stage.method !== null) {
    throw schemaError("judgment_route_schema", "skipped_method");
  }
  if (stage.method !== null) {
    validateMethod(stage.method, stage.stage);
  }
  if (stage.evidence.length > 64) {
    throw schemaError("judgment_route_shape", "evidence_limit");
  }
  for (const entry of stage.evidence) {
    if (!isHash(entry.content_hash) || entry.content_hash.length !== 71) {
      throw schemaError("judgment_route_shape", "evidence_hash");
    }
    if (entry.scope.subject_keys.length > 64 || entry.scope.subject_versions.length > 64) {
      throw schemaError("judgment_route_shape", "evidence_scope");
    }
  }
  if (stage.result_refs.length > 8) {
    throw schemaError("judgment_route_shape", "result_refs_limit");
  }
  for (const ref of stage.result_refs) {
    if (!isHash(ref.result_hash)) {
      throw schemaError("judgment_route_shape", "result_hash");
    }
  }
  if (stage.reason_codes.length > 32) {
    throw schemaError("judgment_route_shape", "reason_limit");
  }
  for (const reason of stage.reason_codes) {
    // DD-QP-31b binds the reason codes to the per-stage closed set; a code
    // outside the set is a closed-set failure, so it belongs to the schema
    // stage and never to the policy stage.
    if (!ALLOWED_REASONS[stage.stage].includes(reason)) {
      throw schemaError("judgment_route_schema", "reason_stage");
    }
  }
  if (stage.status !== "performed" && stage.reason_codes.length === 0) {
    throw schemaError("judgment_route_schema", "stage_reason_required");
  }
  validateCost(stage);
  validateSemanticStage(stage);
  validateVerificationStage(stage);
}

/**
 * True when a performed stage knows every measurement of its row.
 *
 * DD-QP-31e: `cost_status="known"` requires every measurement of the row to
 * be known. A row that is missing one measurement is `partial` and a row that
 * knows nothing is `unknown`, so a `known` row with a null measurement would
 * claim more than was measured. The counters are always known; the optional
 * measures (`cpu_ms`, the token counts, `amount`) are unknown when null, and
 * the money measure is unknown unless it carries its currency.
 */
function costMetricsKnown(cost: JudgmentRouteCost): boolean {
  // A measure that the stage did not exercise is not an unknown cost: a
  // deterministic stage made no model call, so it has no token measure.
  if (cost.model_invocations > 0 && (cost.input_tokens === null || cost.output_tokens === null)) {
    return false;
  }
  // The money measure is unknown unless it carries its currency.
  if (cost.amount !== null && cost.currency === null) {
    return false;
  }
  // The CPU measure is unknown unless it is known.
  return cost.cpu_ms !== null;
}

function validateCost(stage: JudgmentRouteStage): void {
  const cost = stage.cost;
  for (const value of [cost.elapsed_ms, cost.read_bytes, cost.retrieval_count, cost.model_invocations, cost.verifier_invocations]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw schemaError("judgment_route_shape", "cost_counter");
    }
  }
  for (const value of [cost.cpu_ms, cost.input_tokens, cost.output_tokens]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw schemaError("judgment_route_shape", "cost_optional");
    }
  }
  if (cost.amount !== null && !AMOUNT_PATTERN.test(cost.amount)) {
    throw schemaError("judgment_route_shape", "cost_amount");
  }
  if (cost.currency !== null && !CURRENCY_PATTERN.test(cost.currency)) {
    throw schemaError("judgment_route_shape", "cost_currency");
  }
  if (cost.amount === null && cost.currency !== null) {
    throw schemaError("judgment_route_shape", "cost_currency_without_amount");
  }
  if (stage.status === "performed" && cost.cost_status === "not_applicable") {
    throw schemaError("judgment_route_shape", "performed_not_applicable");
  }
  if (stage.status !== "performed" && cost.cost_status === "known") {
    throw schemaError("judgment_route_shape", "skipped_known_cost");
  }
  if (stage.status === "performed" && cost.cost_status === "known" && !costMetricsKnown(cost)) {
    // A known row with an unknown metric would claim more than was measured.
    throw schemaError("judgment_route_shape", "known_cost_with_unknown_metric");
  }
  if (
    stage.status !== "performed" &&
    (cost.cost_status !== "not_applicable" ||
      cost.elapsed_ms !== 0 ||
      cost.read_bytes !== 0 ||
      cost.retrieval_count !== 0 ||
      cost.model_invocations !== 0 ||
      cost.verifier_invocations !== 0 ||
      cost.cpu_ms !== null ||
      cost.input_tokens !== null ||
      cost.output_tokens !== null ||
      cost.amount !== null ||
      cost.currency !== null)
  ) {
    // A stage that never ran has no cost: the counters are zero and every
    // amount, token and CPU measurement stays null.
    throw schemaError("judgment_route_shape", "skipped_cost_not_applicable");
  }
}

function validateSemanticStage(stage: JudgmentRouteStage): void {
  if (stage.stage !== "semantic") {
    return;
  }
  if (stage.status === "performed") {
    if (stage.result_refs.length !== 1) {
      throw schemaError("judgment_route_schema", "semantic_result_refs");
    }
  } else if (stage.result_refs.length !== 0) {
    throw schemaError("judgment_route_schema", "semantic_inactive_refs");
  }
}

function validateVerificationStage(stage: JudgmentRouteStage): void {
  if (stage.stage !== "verification") {
    return;
  }
  if (stage.status === "performed" && stage.verification === null) {
    throw schemaError("judgment_route_schema", "verification_required");
  }
  if (stage.status !== "performed" && stage.verification !== null) {
    throw schemaError("judgment_route_schema", "verification_forbidden");
  }
  if (stage.verification !== null) {
    if (!isHash(stage.verification.fact_content_hash) || !isHash(stage.verification.verification_plan_hash)) {
      throw schemaError("judgment_route_shape", "verification_hash");
    }
    if (stage.verification.covered_subject_keys.length > 64 || stage.verification.covered_versions.length > 64) {
      throw schemaError("judgment_route_shape", "verification_scope");
    }
  }
}

function stageReasons(stages: readonly JudgmentRouteStage[]): JudgmentRouteReason[] {
  return sortedUnique(stages.flatMap((stage) => stage.reason_codes));
}

function validateStageNecessity(draft: JudgmentRouteDraft): void {
  const deterministic = draft.stages[0];
  const retrieval = draft.stages[1];
  const semantic = draft.stages[2];
  if (deterministic === undefined || retrieval === undefined || semantic === undefined) {
    throw schemaError("judgment_route_shape", "stages");
  }
  const decisive = deterministic.reason_codes.includes("deterministic_decisive");
  const retrievalResidual = retrieval.reason_codes.some((reason) => RESIDUAL_REASONS.includes(reason));
  const retrievalDecisive =
    retrieval.status === "performed" && !retrievalResidual;
  if (decisive || retrievalDecisive) {
    if (
      semantic.status !== "skipped" ||
      semantic.reason_codes.length !== 1 ||
      semantic.reason_codes[0] !== "semantic_not_needed" ||
      semantic.result_refs.length !== 0 ||
      draft.semantic_eligibility !== null ||
      semantic.cost.model_invocations !== 0
    ) {
      throw schemaError("judgment_route_policy", "semantic_should_be_skipped");
    }
    return;
  }
  if (semantic.status === "performed") {
    if (!deterministic.reason_codes.includes("deterministic_inconclusive") || !retrievalResidual) {
      throw schemaError("judgment_route_policy", "semantic_without_residual_ambiguity");
    }
    if (draft.semantic_eligibility === null) {
      throw schemaError("judgment_route_schema", "semantic_eligibility_required");
    }
  }
}

function validateRouteStatus(draft: JudgmentRouteDraft): void {
  const semantic = draft.stages[2];
  const verification = draft.stages[3];
  switch (draft.route_status) {
    case "planned":
      if (draft.plan_ref === null || draft.aggregate_ref !== null) {
        throw schemaError("judgment_route_schema", "planned_refs");
      }
      if (
        semantic !== undefined &&
        !semantic.reason_codes.includes("skipped_by_order")
      ) {
        throw schemaError("judgment_route_schema", "planned_semantic");
      }
      if (
        verification !== undefined &&
        !verification.reason_codes.includes("skipped_by_order") &&
        verification.status !== "skipped"
      ) {
        throw schemaError("judgment_route_schema", "planned_verification");
      }
      break;
    case "no_op":
      if (draft.aggregate_ref !== null || draft.consumer_ref.kind !== "none") {
        throw schemaError("judgment_route_schema", "no_op_refs");
      }
      break;
    case "executed":
      if (draft.stages.some((stage) => stage.reason_codes.includes("skipped_by_order"))) {
        throw schemaError("judgment_route_schema", "executed_pending_stage");
      }
      break;
  }
  if (draft.escalation !== null) {
    if (draft.route_status !== "planned" || draft.plan_ref === null || draft.aggregate_ref !== null) {
      throw schemaError("judgment_route_schema", "escalation_status");
    }
    const pairValid =
      (draft.escalation.kind === "clarification" &&
        draft.escalation.reason_code === "execution_blocking_clarification") ||
      (draft.escalation.kind === "authorization" &&
        draft.escalation.reason_code === "authorization_required");
    if (!pairValid) {
      throw schemaError("judgment_route_schema", "escalation_pair");
    }
  }
}

/**
 * Validates `total_cost` against the four stage costs (DD-QP-31e).
 *
 * The counters are the sum of the four stages; the optional measurements are
 * null when any performed stage leaves them unknown and the sum otherwise.
 * The total status is derived strictly from the performed stages.
 */
function validateTotalCost(draft: JudgmentRouteDraft): void {
  const total = draft.total_cost;
  const performed = draft.stages.filter((stage) => stage.status === "performed");
  const counters: readonly (keyof JudgmentRouteCost)[] = [
    "elapsed_ms",
    "read_bytes",
    "retrieval_count",
    "model_invocations",
    "verifier_invocations"
  ];
  for (const key of counters) {
    const sum = draft.stages.reduce((acc, stage) => acc + Number(stage.cost[key] ?? 0), 0);
    if (Number(total[key]) !== sum) {
      throw schemaError("judgment_route_shape", "total_cost_counter");
    }
  }
  const optional: readonly (keyof JudgmentRouteCost)[] = ["cpu_ms", "input_tokens", "output_tokens"];
  for (const key of optional) {
    const values = performed.map((stage) => stage.cost[key]);
    // With no performed stage the metric is unknown, not a zero sum: a route
    // whose stages never ran cannot claim a known CPU or token count.
    const allKnown =
      performed.length > 0 && values.every((value) => value !== null && value !== undefined);
    if (!allKnown) {
      if (total[key] !== null) {
        throw schemaError("judgment_route_shape", "total_cost_optional");
      }
      continue;
    }
    const sum = values.reduce<number>((acc, value) => acc + Number(value), 0);
    if (total[key] !== sum) {
      throw schemaError("judgment_route_shape", "total_cost_optional");
    }
  }
  // `amount` is a decimal string, so the sum is an exact decimal sum.
  const amounts = performed.map((stage) => stage.cost.amount);
  if (performed.length === 0 || amounts.some((value) => value === null || value === undefined)) {
    // `amount` is null when no performed stage reported one.
    if (total.amount !== null && total.amount !== undefined) {
      throw schemaError("judgment_route_shape", "total_cost_optional");
    }
  } else {
    const sum = amounts.reduce<string>((acc, value) => addDecimalStrings(acc, String(value)), "0");
    if (total.amount !== sum) {
      throw schemaError("judgment_route_shape", "total_cost_optional");
    }
  }
  // The currency is unique across the stages and only exists when an amount
  // exists; a cross-currency total is refused rather than summed.
  const currencies = [
    ...new Set(
      performed
        .map((stage) => stage.cost.currency)
        .filter((value): value is string => value !== null && value !== undefined)
    )
  ];
  if (currencies.length > 1) {
    throw schemaError("judgment_route_shape", "total_cost_currency");
  }
  if (currencies.length === 1 && total.currency !== currencies[0]) {
    throw schemaError("judgment_route_shape", "total_cost_currency");
  }
  if (currencies.length === 0 && total.currency !== null) {
    throw schemaError("judgment_route_shape", "total_cost_currency");
  }
  if (total.amount !== null && total.currency === null) {
    throw schemaError("judgment_route_shape", "total_cost_currency_without_amount");
  }
  const expectedStatus = deriveTotalCostStatus(performed);
  if (total.cost_status !== expectedStatus) {
    throw schemaError("judgment_route_shape", "total_cost_status");
  }
}

/**
 * Derives the total cost status from the performed stages (DD-QP-31e).
 *
 * No performed stage is `not_applicable`; all performed stages `known` give
 * `known`; all performed stages `unknown` give `unknown`; anything else is
 * `partial`.
 */
function deriveTotalCostStatus(performed: readonly JudgmentRouteStage[]): JudgmentRouteCostStatus {
  if (performed.length === 0) {
    return "not_applicable";
  }
  const statuses = performed.map((stage) => stage.cost.cost_status);
  if (statuses.every((status) => status === "known")) {
    return "known";
  }
  if (statuses.every((status) => status === "unknown")) {
    return "unknown";
  }
  return "partial";
}

/**
 * Adds two non-negative decimal strings exactly.
 *
 * The amount is a decimal string in the published schema, so the total is the
 * exact decimal sum and never a float approximation.
 */
function addDecimalStrings(left: string, right: string): string {
  const [leftInt, leftFrac = ""] = left.split(".");
  const [rightInt, rightFrac = ""] = right.split(".");
  const width = Math.max(leftFrac.length, rightFrac.length);
  const scale = 10n ** BigInt(width);
  const leftUnits = BigInt(leftInt ?? "0") * scale + BigInt(leftFrac.padEnd(width, "0") || "0");
  const rightUnits = BigInt(rightInt ?? "0") * scale + BigInt(rightFrac.padEnd(width, "0") || "0");
  const total = leftUnits + rightUnits;
  const asString = total.toString().padStart(width + 1, "0");
  const intPart = asString.slice(0, asString.length - width);
  const fracPart = width === 0 ? "" : asString.slice(asString.length - width);
  const trimmed = fracPart.replace(/0+$/u, "");
  return trimmed === "" ? intPart : `${intPart}.${trimmed}`;
}

function validatePolicyFactors(draft: JudgmentRouteDraft): void {
  if (draft.policy_factors.length > 2) {
    throw schemaError("judgment_route_shape", "policy_factors");
  }
  if (draft.route_class !== "experience_match" && draft.policy_factors.length > 0) {
    throw schemaError("judgment_route_policy", "policy_factors_class");
  }
}

/**
 * Validates the strict closed set of one draft (DD-QP-31b).
 *
 * Every level of the record is a closed set: an undeclared field name is a
 * schema failure at the schema stage, before any shape or hash check runs.
 */
function validateDraftClosedSet(draft: JudgmentRouteDraft): void {
  if (containsForbiddenKey(draft)) {
    throw schemaError("judgment_route_schema", "forbidden_key");
  }
  const draftFields = undeclaredFields(draft, DRAFT_FIELDS);
  if (draftFields.length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (undeclaredFields(draft.binding, BINDING_FIELDS).length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (undeclaredFields(draft.scope, SCOPE_FIELDS).length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (draft.plan_ref !== null && undeclaredFields(draft.plan_ref, PLAN_REF_FIELDS).length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (
    draft.aggregate_ref !== null &&
    undeclaredFields(draft.aggregate_ref, AGGREGATE_REF_FIELDS).length > 0
  ) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (
    draft.template_binding !== null &&
    undeclaredFields(draft.template_binding, TEMPLATE_BINDING_FIELDS).length > 0
  ) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (
    draft.semantic_eligibility !== null &&
    undeclaredFields(draft.semantic_eligibility, SEMANTIC_ELIGIBILITY_FIELDS).length > 0
  ) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (draft.escalation !== null && undeclaredFields(draft.escalation, ESCALATION_FIELDS).length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (undeclaredFields(draft.deadline, DEADLINE_FIELDS).length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (undeclaredFields(draft.total_cost, COST_FIELDS).length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  if (undeclaredFields(draft.consumer_ref, CONSUMER_REF_FIELDS).length > 0) {
    throw schemaError("judgment_route_schema", "undeclared_field");
  }
  for (const gap of draft.gaps) {
    if (undeclaredFields(gap, GAP_FIELDS).length > 0) {
      throw schemaError("judgment_route_schema", "undeclared_field");
    }
  }
  for (const stage of draft.stages) {
    if (undeclaredFields(stage, STAGE_FIELDS).length > 0) {
      throw schemaError("judgment_route_schema", "undeclared_field");
    }
    if (stage.method !== null && undeclaredFields(stage.method, METHOD_FIELDS).length > 0) {
      throw schemaError("judgment_route_schema", "undeclared_field");
    }
    for (const entry of stage.evidence) {
      if (undeclaredFields(entry, EVIDENCE_FIELDS).length > 0) {
        throw schemaError("judgment_route_schema", "undeclared_field");
      }
      if (undeclaredFields(entry.scope, EVIDENCE_SCOPE_FIELDS).length > 0) {
        throw schemaError("judgment_route_schema", "undeclared_field");
      }
    }
    for (const ref of stage.result_refs) {
      if (undeclaredFields(ref, RESULT_REF_FIELDS).length > 0) {
        throw schemaError("judgment_route_schema", "undeclared_field");
      }
    }
    if (stage.verification !== null) {
      if (undeclaredFields(stage.verification, VERIFICATION_FIELDS).length > 0) {
        throw schemaError("judgment_route_schema", "undeclared_field");
      }
    }
    if (undeclaredFields(stage.cost, COST_FIELDS).length > 0) {
      throw schemaError("judgment_route_schema", "undeclared_field");
    }
  }
}

/** Validates a route draft in the fixed first-error order (DD-QP-31e). */
export function validateJudgmentRouteDraft(draft: JudgmentRouteDraft): void {
  validateDraftClosedSet(draft);
  if (draft.stages.length !== 4) {
    throw schemaError("judgment_route_shape", "stage_count");
  }
  draft.stages.forEach((stage, index) => {
    validateStageShape(stage, index);
  });
  if (draft.gaps.length > 64) {
    throw schemaError("judgment_route_shape", "gaps_limit");
  }
  if (draft.reason_codes.length > 32) {
    throw schemaError("judgment_route_shape", "reason_limit");
  }
  const union = stageReasons(draft.stages);
  if (union.length !== sortedUnique(draft.reason_codes).length || union.some((reason) => !draft.reason_codes.includes(reason))) {
    // DD-QP-31b: the route-level reason codes are exactly the sorted unique
    // union of the four stage reason sets. A mismatch is a closed-set
    // failure of the route body, so it belongs to the schema stage.
    throw schemaError("judgment_route_schema", "route_reason_union");
  }
  if (draft.scope.subject_versions.length > 64) {
    throw schemaError("judgment_route_shape", "scope_versions");
  }
  if (!isHash(draft.evidence_set_hash)) {
    throw schemaError("judgment_route_shape", "evidence_set_hash");
  }
  if (!isHash(draft.route_key) || !isHash(draft.route_hash)) {
    throw schemaError("judgment_route_shape", "route_identity");
  }
  if (!ROUTE_ID_PATTERN.test(draft.route_id)) {
    // DD-QP-31d: `route_id` is `route:` plus 64 lowercase hex characters. A
    // ULID-shaped or otherwise malformed identifier is an identity failure at
    // the id stage, not a shape failure.
    throw schemaError("judgment_route_id", "route_id");
  }
  validateRouteStatus(draft);
  validatePolicyFactors(draft);
  validateTotalCost(draft);
  validateStageNecessity(draft);
  const recomputedKey = routeKeyFromDraft(draft);
  if (recomputedKey !== draft.route_key) {
    throw schemaError("judgment_route_key", "route_key");
  }
  const recomputedHash = routeHashFromDraft(draft);
  if (recomputedHash !== draft.route_hash) {
    throw schemaError("judgment_route_hash", "route_hash");
  }
  const recomputedId = routeId(draft.route_key, draft.route_hash);
  if (recomputedId !== draft.route_id) {
    throw schemaError("judgment_route_id", "route_id");
  }
  const encoded = JSON.stringify(toJsonValue(draft));
  if (encoded.length > 64 * 1024) {
    throw schemaError("judgment_route_shape", "route_size");
  }
}

function asRecordForHashes(draft: JudgmentRouteDraft): JudgmentRouteRecord {
  return { ...draft, recorded_at: 0, content_hash: "sha256:" + "0".repeat(64) };
}

function routeKeyFromDraft(draft: JudgmentRouteDraft): string {
  return routeKey(asRecordForHashes(draft));
}

function routeHashFromDraft(draft: JudgmentRouteDraft): string {
  return routeHash(asRecordForHashes(draft));
}

/** Computes all route identity fields from the draft body. */
export function computeJudgmentRouteIdentity(draft: JudgmentRouteDraft): {
  evidence_set_hash: string;
  route_key: string;
  route_hash: string;
  route_id: string;
} {
  const provisional: JudgmentRouteRecord = asRecordForHashes(draft);
  const evidence_set_hash = routeEvidenceSetHash(provisional);
  const withEvidence: JudgmentRouteRecord = { ...provisional, evidence_set_hash };
  const route_key = routeKey(withEvidence);
  const withKey: JudgmentRouteRecord = { ...withEvidence, route_key };
  const route_hash = routeHash(withKey);
  const route_id = routeId(route_key, route_hash);
  return { evidence_set_hash, route_key, route_hash, route_id };
}

/** Freezes audit fields onto a validated draft. */
export function buildJudgmentRouteRecord(draft: JudgmentRouteDraft, recorded_at: number): JudgmentRouteRecord {
  validateJudgmentRouteDraft(draft);
  const content_hash = routeContentHash(draft);
  return { ...draft, recorded_at, content_hash };
}

/** gap hash helper kept public for audit tooling. */
export function judgmentRouteGapsHash(gaps: readonly EvidenceGap[]): string {
  return hashJson({
    schema_version: "rsi.judgment_route_gaps/1",
    gaps: evidenceGapsPreimage(gaps)
  });
}

/* ------------------------------------------------------------------------- */
/* Append and read                                                           */
/* ------------------------------------------------------------------------- */

interface EscalationSourceShape {
  kind: "clarification" | "authorization";
  reason_code: "execution_blocking_clarification" | "authorization_required";
  action: string;
  required: boolean;
  binding: {
    task_id: string;
    branch_id: string;
    input_epoch: number;
    goal_version: string;
    config_version: string;
    watermark: number;
  };
}

/**
 * Parses the HOST escalation source through the published HOST parser.
 *
 * DD-QP-31e step 1 and DD-TRG-012 §12.4: `appendJudgmentRoute` calls
 * `parseHostInteractionEscalation` exactly once per request that carries a
 * source. A HOST `E_SCHEMA` maps to the QP schema stage and a HOST
 * `E_VERSION_BINDING` maps to the QP binding stage; the HOST error envelope
 * never leaks and no new details key is added.
 */
function parseEscalationSource(value: JsonValue | null): EscalationSourceShape | null {
  if (value === null) {
    return null;
  }
  const parsed = parseHostInteractionEscalation(value);
  if (!parsed.ok) {
    if (parsed.error.code === "E_VERSION_BINDING") {
      throw new QpDomainError(qpFailure("E_VERSION_BINDING", "judgment_route_binding"));
    }
    throw schemaError("judgment_route_schema", "escalation_source");
  }
  const source = parsed.value;
  // DD-TRG-012 §12.4 step 1: a clarification in `state="absent"` is inside
  // the published closed set, but this version has no producer for it. QP
  // rejects it instead of committing a route the HOST prompt gate would
  // refuse later.
  if (source.kind === "clarification" && source.missing[0]?.state !== "ambiguous") {
    throw schemaError("judgment_route_schema", "escalation_source");
  }
  return {
    kind: source.kind,
    reason_code: source.reason_code,
    action: source.action,
    required: true,
    binding: {
      task_id: source.binding.task_id,
      branch_id: source.binding.branch_id,
      input_epoch: source.binding.input_epoch,
      goal_version: source.binding.goal_version,
      config_version: source.binding.config_version,
      watermark: source.binding.watermark
    }
  };
}

/**
 * The gate-side point read of the route document and head (DD-QP-31d).
 *
 * The route has no typed table, so the pair `object_document` /
 * `object_head` is the whole current state. Inside the writer gate the pair
 * must be either absent on both sides or present on both sides with the same
 * bytes; a missing side or a different body is an integrity failure.
 */
function assertRouteObjectsAbsent(tx: unknown, route_id: string, content_hash: string): void {
  const handle = tx as Partial<Tx> | null | undefined;
  if (handle === null || handle === undefined || typeof handle.prepare !== "function") {
    return;
  }
  const document = handle
    .prepare<{ content_hash: string }>(
      "SELECT content_hash FROM object_document WHERE object_id = :object_id AND object_type = 'judgment_route'"
    )
    .get({ object_id: route_id });
  const head = handle
    .prepare<{ content_hash: string }>(
      "SELECT content_hash FROM object_head WHERE object_id = :object_id AND object_type = 'judgment_route'"
    )
    .get({ object_id: route_id });
  if (document === undefined && head === undefined) {
    return;
  }
  if (document === undefined || head === undefined) {
    throw new QpDomainError(qpFailure("E_PERSISTENCE_INTEGRITY", "judgment_route"));
  }
  if (document.content_hash !== content_hash || head.content_hash !== content_hash) {
    throw new QpDomainError(qpFailure("E_PERSISTENCE_INTEGRITY", "judgment_route"));
  }
}

export interface JudgmentRouteStoreOptions {
  clock?: Clock;
  plans?: QuestionPlanRepository;
  commit?: QpJournalCommitPort;
}

export interface JudgmentRouteStore {
  appendJudgmentRoute(req: JudgmentRouteAppendRequest): Promise<Result<JudgmentRouteAppendResult, ErrorEnvelope>>;
  getJudgmentRoute(route_id: string): JudgmentRouteRecord | null;
  getJudgmentRouteByKeyHash(route_key: string, route_hash: string): JudgmentRouteRecord | null;
}

/** Creates the route store; without a commit port the index is in memory. */
export function createJudgmentRouteStore(options: JudgmentRouteStoreOptions = {}): JudgmentRouteStore {
  const clock = options.clock ?? systemClock;
  const plans = options.plans;
  const commitPort = options.commit;
  const records = new Map<string, JudgmentRouteRecord>();
  const byKeyHash = new Map<string, string>();
  /**
   * The records the writer gate has applied but the outer commit has not
   * confirmed yet.
   *
   * DD-QP-31d: only `committed` acknowledges the append, and `not_written`
   * and `unknown_recovery_required` leave no visible route. The index is
   * therefore published only after the port confirms the commit.
   */
  const pending = new Map<string, JudgmentRouteRecord>();

  async function appendJudgmentRoute(
    req: JudgmentRouteAppendRequest
  ): Promise<Result<JudgmentRouteAppendResult, ErrorEnvelope>> {
    try {
      const source = parseEscalationSource(req.escalation_source);
      if (source === null) {
        if (req.draft.escalation !== null || req.current_action !== null) {
          throw schemaError("judgment_route_schema", "escalation_without_source");
        }
      } else {
        if (req.current_action !== "review.explicit") {
          throw schemaError("judgment_route_schema", "current_action");
        }
        if (
          req.draft.escalation === null ||
          req.draft.escalation.kind !== source.kind ||
          req.draft.escalation.reason_code !== source.reason_code
        ) {
          throw schemaError("judgment_route_schema", "escalation_pair");
        }
        if (req.draft.route_status !== "planned" || req.draft.plan_ref === null || req.draft.aggregate_ref !== null) {
          throw schemaError("judgment_route_schema", "escalation_route");
        }
        if (
          source.binding.task_id !== req.draft.binding.task_id ||
          source.binding.branch_id !== req.draft.binding.branch_id ||
          source.binding.input_epoch !== req.draft.binding.input_epoch ||
          source.binding.goal_version !== req.draft.binding.goal_version ||
          source.binding.config_version !== req.draft.binding.config_version ||
          source.binding.watermark !== req.draft.binding.watermark
        ) {
          throw new QpDomainError(qpFailure("E_VERSION_BINDING", "judgment_route_binding"));
        }
        if (plans !== undefined) {
          const plan = plans.getPlan(req.draft.plan_ref.plan_id);
          const state = plans.getPlanState(req.draft.plan_ref.plan_id);
          if (
            plan === null ||
            state === null ||
            plan.plan_id !== req.draft.plan_ref.plan_id ||
            plan.plan_hash !== req.draft.plan_ref.plan_hash ||
            state.plan_hash !== req.draft.plan_ref.plan_hash ||
            state.state !== "active"
          ) {
            throw schemaError("judgment_route_schema", "plan_ref");
          }
        }
      }
      // DD-QP-31d: `recorded_at` and `content_hash` are envelope fields the
      // QP repository writes itself. A caller that carries either one is
      // refused at the schema stage.
      if (Object.prototype.hasOwnProperty.call(req.draft, "recorded_at")) {
        throw schemaError("judgment_route_schema", "caller_recorded_at");
      }
      if (Object.prototype.hasOwnProperty.call(req.draft, "content_hash")) {
        throw schemaError("judgment_route_schema", "caller_content_hash");
      }
      validateJudgmentRouteDraft(req.draft);
      const recorded_at = clock.utcNowMs();
      const record = buildJudgmentRouteRecord(req.draft, recorded_at);
      const existing = records.get(record.route_id);
      if (existing !== undefined) {
        if (existing.content_hash !== record.content_hash) {
          throw new QpDomainError(qpFailure("E_PERSISTENCE_INTEGRITY", "judgment_route"));
        }
        return { ok: true, status: "ok", value: routeAppendResult(existing, source, req.escalation_source) };
      }
      if (commitPort !== undefined) {
        const payload = { route: record };
        const event: QpJudgmentRouteEvent = {
          schema_version: "rsi.qp_judgment_route_event/1",
          event_type: "judgment_route_recorded",
          entity_type: "judgment_route",
          entity_id: record.route_id,
          payload_hash: hashJson(toJsonValue(payload)),
          payload
        };
        const outcome: QpLiveCommitOutcome = commitPort.commitQpJournal({
          event,
          apply: (stage) => {
            const stored = records.get(record.route_id) ?? pending.get(record.route_id);
            if (stored !== undefined) {
              if (stored.content_hash !== record.content_hash) {
                throw new QpDomainError(qpFailure("E_PERSISTENCE_INTEGRITY", "judgment_route"));
              }
              return { kind: "existing", value: toJsonValue(stored) };
            }
            // DD-QP-31d step 2: the gate reads the document and the head by
            // their keys before the frame is written. A side that is missing
            // or carries different bytes is an integrity failure, never a
            // silent overwrite.
            assertRouteObjectsAbsent(stage.tx, record.route_id, record.content_hash);
            pending.set(record.route_id, record);
            return { kind: "commit" };
          }
        });
        if (outcome.commit_state === "not_written") {
          // Nothing became visible: the applied record is discarded and the
          // caller may only retry through the full admission again.
          pending.delete(record.route_id);
          return { ok: false, status: "rejected", error: outcome.error };
        }
        if (outcome.commit_state === "unknown_recovery_required") {
          // The frame may be durable, but the append is not acknowledged and
          // no route is visible until FND replays the frozen frame.
          pending.delete(record.route_id);
          return {
            ok: false,
            status: "unknown",
            error: qpFailure("E_PERSISTENCE_INTEGRITY", "judgment_route", { reason: "unknown_recovery_required" })
          };
        }
        if (outcome.commit_state === "existing") {
          pending.delete(record.route_id);
        }
        // `committed`: the record becomes visible.
        records.set(record.route_id, record);
        byKeyHash.set(`${record.route_key}\u0000${record.route_hash}`, record.route_id);
        pending.delete(record.route_id);
      } else {
        records.set(record.route_id, record);
        byKeyHash.set(`${record.route_key}\u0000${record.route_hash}`, record.route_id);
      }
      const stored = records.get(record.route_id);
      if (stored === undefined) {
        return {
          ok: false,
          status: "rejected",
          error: qpFailure("E_PERSISTENCE_INTEGRITY", "judgment_route")
        };
      }
      return { ok: true, status: "ok", value: routeAppendResult(stored, source, req.escalation_source) };
    } catch (error) {
      if (error instanceof QpDomainError) {
        return { ok: false, status: "rejected", error: error.envelope };
      }
      throw error;
    }
  }

  function routeAppendResult(
    record: JudgmentRouteRecord,
    source: EscalationSourceShape | null,
    originalSource: JsonValue | null
  ): JudgmentRouteAppendResult {
    const escalation = record.escalation;
    if (escalation === null || source === null || originalSource === null) {
      return { record, interaction_handoff: null };
    }
    return {
      record,
      interaction_handoff: {
        route_ref: {
          schema_version: "rsi.host_interaction_route_ref/1",
          route_id: record.route_id,
          route_hash: record.route_hash,
          route_status: record.route_status,
          binding: record.binding,
          escalation
        },
        escalation_source: originalSource
      }
    };
  }

  return {
    appendJudgmentRoute,
    getJudgmentRoute(route_id: string): JudgmentRouteRecord | null {
      return records.get(route_id) ?? null;
    },
    getJudgmentRouteByKeyHash(route_key: string, route_hash: string): JudgmentRouteRecord | null {
      const id = byKeyHash.get(`${route_key}\u0000${route_hash}`) ?? routeId(route_key, route_hash);
      return records.get(id) ?? null;
    }
  };
}

/** Convenience wrapper for a one-off append against a fresh in-memory store. */
export async function appendJudgmentRoute(
  req: JudgmentRouteAppendRequest
): Promise<Result<JudgmentRouteAppendResult, ErrorEnvelope>> {
  return createJudgmentRouteStore().appendJudgmentRoute(req);
}

/** Builds a planned route draft for an experience review plan (DD-QP-31f). */
export function buildExperiencePlannedRoute(input: {
  plan: { plan_id: string; plan_hash: string; issue_key: string; binding: JudgmentRouteRecord["binding"] };
  question_key: string;
  template_binding: { template_id: string; template_version: string; template_hash: string };
  project_id: string | null;
  subject_key: string;
  subject_versions: string[];
}): JudgmentRouteDraft {
  const zeroCost = {
    elapsed_ms: 0,
    cpu_ms: null,
    read_bytes: 0,
    retrieval_count: 0,
    model_invocations: 0,
    input_tokens: null,
    output_tokens: null,
    verifier_invocations: 0,
    amount: null,
    currency: null,
    cost_status: "not_applicable" as const,
    receipt_ref: null
  };
  const stages: JudgmentRouteStage[] = [
    {
      stage: "deterministic",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      reason_codes: ["skipped_by_order"],
      cost: zeroCost
    },
    {
      stage: "retrieval",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      reason_codes: ["skipped_by_order"],
      cost: zeroCost
    },
    {
      stage: "semantic",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      reason_codes: ["skipped_by_order"],
      cost: zeroCost
    },
    {
      stage: "verification",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      reason_codes: ["skipped_by_order"],
      cost: zeroCost
    }
  ];
  const draftBase: Omit<JudgmentRouteDraft, "route_id" | "route_key" | "route_hash" | "evidence_set_hash"> = {
    schema_version: "rsi.judgment_route/1",
    route_status: "planned",
    route_policy_version: "qp.route/1",
    route_class: "experience_match",
    project_id: input.project_id,
    binding: input.plan.binding,
    scope: {
      subject_key: input.subject_key,
      subject_versions: sortedUnique(input.subject_versions)
    },
    issue_key: input.plan.issue_key,
    question_key: input.question_key,
    template_binding: input.template_binding,
    plan_ref: { plan_id: input.plan.plan_id, plan_hash: input.plan.plan_hash },
    aggregate_ref: null,
    semantic_eligibility: null,
    stages,
    gaps: [],
    reason_codes: sortedUnique(stages.flatMap((stage) => stage.reason_codes)),
    policy_factors: [],
    escalation: null,
    deadline: { total_ms: 1, deterministic_ms: 1, retrieval_ms: 1, semantic_ms: 1, verification_ms: 1 },
    deadline_ref: null,
    total_cost: zeroCost,
    budget_receipt_ref: null,
    consumer_ref: { kind: "none", ref_id: null }
  };
  const placeholder: JudgmentRouteDraft = {
    ...draftBase,
    route_id: "route:" + "0".repeat(64),
    route_key: "sha256:" + "0".repeat(64),
    route_hash: "sha256:" + "0".repeat(64),
    evidence_set_hash: "sha256:" + "0".repeat(64)
  };
  const identity = computeJudgmentRouteIdentity(placeholder);
  return {
    ...draftBase,
    route_id: identity.route_id,
    route_key: identity.route_key,
    route_hash: identity.route_hash,
    evidence_set_hash: identity.evidence_set_hash
  };
}

/**
 * Builds a `no_op` route draft for an experience review (DD-QP-31f).
 *
 * DD-QP-26: a `not_required` / `duplicate_issue` / `not_planable_state`
 * result still carries a complete four-stage route with
 * `route_status=no_op`; the semantic stage reads
 * `skipped/semantic_not_needed`. `route=null` never expresses a no-op.
 */
export function buildExperienceNoOpRoute(input: {
  binding: JudgmentRouteRecord["binding"];
  issue_key: string | null;
  subject_key: string;
  subject_versions: string[];
  /** The stage reasons of the no-op path; the semantic stage is fixed. */
  stage_reasons?: Partial<Record<JudgmentRouteStageName, readonly JudgmentRouteReason[]>>;
}): JudgmentRouteDraft {
  const zeroCost = {
    elapsed_ms: 0,
    cpu_ms: null,
    read_bytes: 0,
    retrieval_count: 0,
    model_invocations: 0,
    input_tokens: null,
    output_tokens: null,
    verifier_invocations: 0,
    amount: null,
    currency: null,
    cost_status: "not_applicable" as const,
    receipt_ref: null
  };
  const reason = (stage: JudgmentRouteStageName, fallback: JudgmentRouteReason): JudgmentRouteReason[] => {
    const declared = input.stage_reasons?.[stage];
    return declared === undefined || declared.length === 0 ? [fallback] : [...declared];
  };
  const stages: JudgmentRouteStage[] = [
    {
      stage: "deterministic",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      reason_codes: reason("deterministic", "skipped_by_order"),
      cost: zeroCost
    },
    {
      stage: "retrieval",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      reason_codes: reason("retrieval", "skipped_by_order"),
      cost: zeroCost
    },
    {
      stage: "semantic",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      // DD-QP-31f: the semantic stage of a no-op route is
      // `skipped/semantic_not_needed`.
      reason_codes: reason("semantic", "semantic_not_needed"),
      cost: zeroCost
    },
    {
      stage: "verification",
      status: "skipped",
      method: null,
      evidence: [],
      result_refs: [],
      verification: null,
      reason_codes: reason("verification", "skipped_by_order"),
      cost: zeroCost
    }
  ];
  const draftBase: Omit<JudgmentRouteDraft, "route_id" | "route_key" | "route_hash" | "evidence_set_hash"> = {
    schema_version: "rsi.judgment_route/1",
    route_status: "no_op",
    route_policy_version: "qp.route/1",
    route_class: "experience_match",
    project_id: null,
    binding: input.binding,
    scope: {
      subject_key: input.subject_key,
      subject_versions: sortedUnique(input.subject_versions)
    },
    issue_key: input.issue_key,
    question_key: null,
    template_binding: null,
    plan_ref: null,
    aggregate_ref: null,
    semantic_eligibility: null,
    stages,
    gaps: [],
    reason_codes: sortedUnique(stages.flatMap((stage) => stage.reason_codes)),
    policy_factors: [],
    escalation: null,
    deadline: { total_ms: 1, deterministic_ms: 1, retrieval_ms: 1, semantic_ms: 1, verification_ms: 1 },
    deadline_ref: null,
    total_cost: zeroCost,
    budget_receipt_ref: null,
    consumer_ref: { kind: "none", ref_id: null }
  };
  const placeholder: JudgmentRouteDraft = {
    ...draftBase,
    route_id: "route:" + "0".repeat(64),
    route_key: "sha256:" + "0".repeat(64),
    route_hash: "sha256:" + "0".repeat(64),
    evidence_set_hash: "sha256:" + "0".repeat(64)
  };
  const identity = computeJudgmentRouteIdentity(placeholder);
  return {
    ...draftBase,
    route_id: identity.route_id,
    route_key: identity.route_key,
    route_hash: identity.route_hash,
    evidence_set_hash: identity.evidence_set_hash
  };
}

/** Sorts route records for deterministic audit listing. */
export function sortJudgmentRoutes(records: readonly JudgmentRouteRecord[]): JudgmentRouteRecord[] {
  return sortUtf8(records, (record) => record.route_id);
}

/** Compares two route identities. */
export function compareRouteIdentity(left: JudgmentRouteRecord, right: JudgmentRouteRecord): number {
  return compareUtf8(left.route_id, right.route_id);
}

