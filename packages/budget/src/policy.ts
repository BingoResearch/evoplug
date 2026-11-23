/**
 * BudgetPolicy `bpol/1` (DD-FND-080, DD-FND-080.1).
 *
 * The policy is a frozen configuration row, not a live object: `bpol/1` values
 * are constants, `content_hash` is `sha256(JCS(BudgetPolicy))` over the complete
 * root object, and the read port refuses anything that is not the single active
 * `bpol/1` row addressed by `budget://default`.
 */

import { canonicalHash, isHash } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  Tx,
} from "@evoplug/core";
import { readActiveBudgetPolicy } from "@evoplug/storage";
import { err, ok } from "@evoplug/core";

import { budgetPolicyUnavailable, reserveInconsistent, schemaError } from "./errors.js";

export type BudgetPurpose = "judge" | "review_generate" | "review_match" | "verifier" | "egress_other";

export interface BudgetScopePolicy {
  purpose: BudgetPurpose;
  /** 1..10, accumulated across the whole reservation. */
  max_attempts: number;
  max_input_tokens: number;
  max_output_tokens: number;
  request_max_tokens: number;
  question_max_tokens: number;
  request_margin_tokens: number;
  question_margin_tokens: number;
  /** `null` only permits calls whose provider proves `cost = 0`. */
  max_cost_micros: number | null;
  wall_ms: number;
  reserve_ms: number;
  min_work_ms: number;
  attempt_charge_at: "claim";
  attempt_refundable: false;
}

interface BudgetConcurrencyPolicy {
  global_inflight: number;
  per_scope_inflight: number;
  rpm: number;
  burst: number;
  cooldown_base_ms: number;
  cooldown_max_ms: number;
  unknown_limit_inflight: 1;
  unknown_limit_rpm: 6;
}

export interface BudgetPolicy {
  schema_version: "rsi.budget_policy/1";
  policy_version: "bpol/1";
  scopes: BudgetScopePolicy[];
  concurrency: BudgetConcurrencyPolicy;
  unknown_cost: "block_paid";
  unknown_provider_limit: "local_guard";
  reservation_ttl_ms: number;
}

const BUDGET_POLICY_SCHEMA_VERSION: "rsi.budget_policy/1" = "rsi.budget_policy/1";

const BUDGET_SCOPE_POLICY_VIEW_SCHEMA_VERSION: "rsi.budget_scope_policy_view/1" =
  "rsi.budget_scope_policy_view/1";

const BPOL1_POLICY_VERSION: "bpol/1" = "bpol/1";

/** The only legal `budget_policy_ref` in v1. */
const BUDGET_POLICY_DEFAULT_REF = "budget://default";

/** Default reservation TTL, 120 s. */
const BPOL1_RESERVATION_TTL_MS = 120_000;

/** Every purpose in table order. */
export const BUDGET_PURPOSES: readonly BudgetPurpose[] = [
  "judge",
  "review_generate",
  "review_match",
  "verifier",
  "egress_other"
];

/**
 * The fixed `bpol/1` scope table (DD-FND-080). `judge` limits are strategy
 * ceilings; admission still requires the HOST service profile limits.
 */
export const BPOL1_SCOPES: readonly BudgetScopePolicy[] = [
  {
    purpose: "judge",
    max_attempts: 2,
    max_input_tokens: 32_768,
    max_output_tokens: 2_048,
    request_max_tokens: 64_000,
    question_max_tokens: 32_000,
    request_margin_tokens: 2_048,
    question_margin_tokens: 512,
    max_cost_micros: 100_000,
    wall_ms: 5_000,
    reserve_ms: 150,
    min_work_ms: 100,
    attempt_charge_at: "claim",
    attempt_refundable: false
  },
  {
    purpose: "review_generate",
    max_attempts: 3,
    max_input_tokens: 65_536,
    max_output_tokens: 65_536,
    request_max_tokens: 131_072,
    question_max_tokens: 32_768,
    request_margin_tokens: 2_048,
    question_margin_tokens: 512,
    max_cost_micros: 500_000,
    wall_ms: 600_000,
    reserve_ms: 1_500,
    min_work_ms: 1_000,
    attempt_charge_at: "claim",
    attempt_refundable: false
  },
  {
    purpose: "review_match",
    max_attempts: 3,
    max_input_tokens: 32_768,
    max_output_tokens: 4_096,
    request_max_tokens: 32_768,
    question_max_tokens: 16_384,
    request_margin_tokens: 1_024,
    question_margin_tokens: 256,
    max_cost_micros: 100_000,
    wall_ms: 30_000,
    reserve_ms: 300,
    min_work_ms: 200,
    attempt_charge_at: "claim",
    attempt_refundable: false
  },
  {
    purpose: "verifier",
    max_attempts: 2,
    max_input_tokens: 65_536,
    max_output_tokens: 4_096,
    request_max_tokens: 65_536,
    question_max_tokens: 32_768,
    request_margin_tokens: 2_048,
    question_margin_tokens: 512,
    max_cost_micros: 200_000,
    wall_ms: 120_000,
    reserve_ms: 1_000,
    min_work_ms: 500,
    attempt_charge_at: "claim",
    attempt_refundable: false
  },
  {
    purpose: "egress_other",
    max_attempts: 1,
    max_input_tokens: 65_536,
    max_output_tokens: 8_192,
    request_max_tokens: 65_536,
    question_max_tokens: 32_768,
    request_margin_tokens: 2_048,
    question_margin_tokens: 512,
    max_cost_micros: 200_000,
    wall_ms: 120_000,
    reserve_ms: 500,
    min_work_ms: 300,
    attempt_charge_at: "claim",
    attempt_refundable: false
  }
];

/** The fixed `bpol/1` concurrency block. */
export const BPOL1_CONCURRENCY: BudgetConcurrencyPolicy = {
  global_inflight: 2,
  per_scope_inflight: 1,
  rpm: 30,
  burst: 3,
  cooldown_base_ms: 5_000,
  cooldown_max_ms: 300_000,
  unknown_limit_inflight: 1,
  unknown_limit_rpm: 6
};

/** Builds a fresh, mutable copy of the canonical `bpol/1` policy. */
export function createBpol1Policy(): BudgetPolicy {
  return {
    schema_version: BUDGET_POLICY_SCHEMA_VERSION,
    policy_version: BPOL1_POLICY_VERSION,
    scopes: BPOL1_SCOPES.map((scope) => ({ ...scope })),
    concurrency: { ...BPOL1_CONCURRENCY },
    unknown_cost: "block_paid",
    unknown_provider_limit: "local_guard",
    reservation_ttl_ms: BPOL1_RESERVATION_TTL_MS
  };
}

/** `sha256(JCS(policy))` over the complete root object. */
export function budgetPolicyContentHash(policy: BudgetPolicy): Hash {
  return canonicalHash(budgetPolicyToJson(policy));
}

/**
 * Serializes a policy to the JCS preimage. Field order is irrelevant to JCS;
 * every root field is included and `created_at`/`active` never are.
 */
export function budgetPolicyToJson(policy: BudgetPolicy): JsonValue {
  return {
    schema_version: policy.schema_version,
    policy_version: policy.policy_version,
    scopes: policy.scopes.map((scope) => ({
      purpose: scope.purpose,
      max_attempts: scope.max_attempts,
      max_input_tokens: scope.max_input_tokens,
      max_output_tokens: scope.max_output_tokens,
      request_max_tokens: scope.request_max_tokens,
      question_max_tokens: scope.question_max_tokens,
      request_margin_tokens: scope.request_margin_tokens,
      question_margin_tokens: scope.question_margin_tokens,
      max_cost_micros: scope.max_cost_micros,
      wall_ms: scope.wall_ms,
      reserve_ms: scope.reserve_ms,
      min_work_ms: scope.min_work_ms,
      attempt_charge_at: scope.attempt_charge_at,
      attempt_refundable: scope.attempt_refundable
    })),
    concurrency: {
      global_inflight: policy.concurrency.global_inflight,
      per_scope_inflight: policy.concurrency.per_scope_inflight,
      rpm: policy.concurrency.rpm,
      burst: policy.concurrency.burst,
      cooldown_base_ms: policy.concurrency.cooldown_base_ms,
      cooldown_max_ms: policy.concurrency.cooldown_max_ms,
      unknown_limit_inflight: policy.concurrency.unknown_limit_inflight,
      unknown_limit_rpm: policy.concurrency.unknown_limit_rpm
    },
    unknown_cost: policy.unknown_cost,
    unknown_provider_limit: policy.unknown_provider_limit,
    reservation_ttl_ms: policy.reservation_ttl_ms
  };
}

/** Returns the policy for `purpose`; `null` when the scope is absent. */
export function findScopePolicy(
  policy: BudgetPolicy,
  purpose: BudgetPurpose
): BudgetScopePolicy | null {
  const matches = policy.scopes.filter((scope) => scope.purpose === purpose);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** True when `purpose` is one of the five registered purposes. */
export function isBudgetPurpose(value: string): value is BudgetPurpose {
  return (BUDGET_PURPOSES as readonly string[]).includes(value);
}

/**
 * Structural and range validation of a stored policy.
 *
 * The read port collapses every failure to `E_BUDGET_POLICY_UNAVAILABLE`;
 * this parser reports the precise field so operators can diagnose the row.
 */
export function parseBudgetPolicy(value: unknown): Result<BudgetPolicy, ErrorEnvelope> {
  if (!isPlainObject(value)) {
    return err(schemaError("$", "object", "budget_policy_parse"));
  }
  if (value["schema_version"] !== BUDGET_POLICY_SCHEMA_VERSION) {
    return err(schemaError("schema_version", BUDGET_POLICY_SCHEMA_VERSION, "budget_policy_parse"));
  }
  const knownPolicyKeys = new Set([
    "schema_version",
    "policy_version",
    "scopes",
    "concurrency",
    "unknown_cost",
    "unknown_provider_limit",
    "reservation_ttl_ms"
  ]);
  for (const key of Object.keys(value)) {
    if (!knownPolicyKeys.has(key)) {
      return err(schemaError(key, "known_field", "budget_policy_parse"));
    }
  }
  if (value["policy_version"] !== BPOL1_POLICY_VERSION) {
    return err(schemaError("policy_version", BPOL1_POLICY_VERSION, "budget_policy_parse"));
  }
  if (value["unknown_cost"] !== "block_paid") {
    return err(schemaError("unknown_cost", "block_paid", "budget_policy_parse"));
  }
  if (value["unknown_provider_limit"] !== "local_guard") {
    return err(schemaError("unknown_provider_limit", "local_guard", "budget_policy_parse"));
  }
  const ttl = value["reservation_ttl_ms"];
  if (!isSafeNonNegativeInteger(ttl) || ttl === 0) {
    return err(schemaError("reservation_ttl_ms", "positive_safe_integer", "budget_policy_parse"));
  }
  const scopesValue = value["scopes"];
  if (!Array.isArray(scopesValue)) {
    return err(schemaError("scopes", "array", "budget_policy_parse"));
  }
  const scopes: BudgetScopePolicy[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of scopesValue.entries()) {
    const parsed = parseScopePolicy(entry, `scopes[${String(index)}]`);
    if (!parsed.ok) {
      return parsed;
    }
    if (seen.has(parsed.value.purpose)) {
      return err(schemaError(`scopes[${String(index)}].purpose`, "unique", "budget_policy_parse"));
    }
    seen.add(parsed.value.purpose);
    scopes.push(parsed.value);
  }
  for (const purpose of BUDGET_PURPOSES) {
    if (!seen.has(purpose)) {
      return err(schemaError("scopes", `contains_${purpose}`, "budget_policy_parse"));
    }
  }
  const concurrency = parseConcurrency(value["concurrency"]);
  if (!concurrency.ok) {
    return concurrency;
  }
  return ok({
    schema_version: BUDGET_POLICY_SCHEMA_VERSION,
    policy_version: BPOL1_POLICY_VERSION,
    scopes,
    concurrency: concurrency.value,
    unknown_cost: "block_paid",
    unknown_provider_limit: "local_guard",
    reservation_ttl_ms: ttl
  });
}

export interface BudgetScopePolicyView {
  schema_version: "rsi.budget_scope_policy_view/1";
  budget_policy_ref: string;
  budget_policy_version: "bpol/1";
  content_hash: Hash;
  scope: BudgetScopePolicy;
}

export interface BudgetPolicyReadPort {
  getScopeInTransaction(
    tx: Tx,
    input: { budget_policy_ref: string; purpose: BudgetPurpose }
  ): Result<BudgetScopePolicyView, ErrorEnvelope>;
}

/**
 * Reads the single active `bpol/1` row inside the caller's transaction
 * (DD-FND-080.1).
 *
 * The ref is not a SQL value: it must equal `budget://default` before the row
 * is read. Zero or multiple active rows, a different `policy_version`, an
 * unparseable `canonical_json`, a `content_hash` mismatch, or a purpose that
 * does not match exactly one scope all collapse to
 * `E_BUDGET_POLICY_UNAVAILABLE`.
 */
export function readBudgetScopeInTransaction(
  tx: Tx,
  input: { budget_policy_ref: string; purpose: BudgetPurpose }
): Result<BudgetScopePolicyView, ErrorEnvelope> {
  if (input.budget_policy_ref !== BUDGET_POLICY_DEFAULT_REF) {
    return err(budgetPolicyUnavailable("budget_policy_ref", "budget_default_ref"));
  }
  if (!isBudgetPurpose(input.purpose)) {
    return err(budgetPolicyUnavailable("purpose", "registered_purpose"));
  }
  const active = readActiveBudgetPolicy(tx);
  if (active === null) {
    return err(budgetPolicyUnavailable("active", "exactly_one_active_row"));
  }
  const policyVersion = active.policy_version;
  const canonicalJson = active.canonical_json;
  const contentHash = active.content_hash;
  if (policyVersion !== BPOL1_POLICY_VERSION) {
    return err(budgetPolicyUnavailable("policy_version", BPOL1_POLICY_VERSION));
  }
  if (typeof canonicalJson !== "string") {
    return err(budgetPolicyUnavailable("canonical_json", "text"));
  }
  if (typeof contentHash !== "string" || !isHash(contentHash)) {
    return err(budgetPolicyUnavailable("content_hash", "hash"));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(canonicalJson);
  } catch {
    return err(budgetPolicyUnavailable("canonical_json", "json"));
  }
  const policy = parseBudgetPolicy(decoded);
  if (!policy.ok) {
    return err(budgetPolicyUnavailable("canonical_json", "rsi.budget_policy/1"));
  }
  if (budgetPolicyContentHash(policy.value) !== contentHash) {
    return err(budgetPolicyUnavailable("content_hash", "sha256_jcs_policy"));
  }
  const scope = findScopePolicy(policy.value, input.purpose);
  if (scope === null) {
    return err(budgetPolicyUnavailable("scopes.purpose", "exactly_one_match"));
  }
  return ok({
    schema_version: BUDGET_SCOPE_POLICY_VIEW_SCHEMA_VERSION,
    budget_policy_ref: BUDGET_POLICY_DEFAULT_REF,
    budget_policy_version: BPOL1_POLICY_VERSION,
    content_hash: contentHash,
    scope: { ...scope, purpose: input.purpose }
  });
}

/**
 * Token composition gate (DD-FND-080): requested input, reserved output and
 * their sum must each fit the scope, and the sum is checked against
 * `request_max_tokens` (or `question_max_tokens` for question calls).
 * `max_input_tokens` is a policy ceiling, never the provider context window.
 */
export function checkTokenComposition(
  scope: BudgetScopePolicy,
  input: { input_tokens_requested: number; output_tokens_reserved: number; question: boolean }
): Result<{ input_tokens: number; output_tokens: number }, ErrorEnvelope> {
  const { input_tokens_requested, output_tokens_reserved } = input;
  if (!isSafeNonNegativeInteger(input_tokens_requested)) {
    return err(reserveInconsistent("input_tokens_requested", "non_negative_safe_integer"));
  }
  if (!isSafeNonNegativeInteger(output_tokens_reserved)) {
    return err(reserveInconsistent("output_tokens_reserved", "non_negative_safe_integer"));
  }
  if (input_tokens_requested > scope.max_input_tokens) {
    return err(reserveInconsistent("input_tokens_requested", "max_input_tokens"));
  }
  if (output_tokens_reserved > scope.max_output_tokens) {
    return err(reserveInconsistent("output_tokens_reserved", "max_output_tokens"));
  }
  const requestCeiling = input.question ? scope.question_max_tokens : scope.request_max_tokens;
  if (input_tokens_requested + output_tokens_reserved > requestCeiling) {
    return err(
      reserveInconsistent(
        input.question ? "question_max_tokens" : "request_max_tokens",
        "input_plus_output"
      )
    );
  }
  return ok({ input_tokens: input_tokens_requested, output_tokens: output_tokens_reserved });
}

function parseScopePolicy(value: unknown, path: string): Result<BudgetScopePolicy, ErrorEnvelope> {
  if (!isPlainObject(value)) {
    return err(schemaError(path, "object", "budget_policy_parse"));
  }
  const purpose = value["purpose"];
  if (typeof purpose !== "string" || !isBudgetPurpose(purpose)) {
    return err(schemaError(`${path}.purpose`, "registered_purpose", "budget_policy_parse"));
  }
  const integerFields = [
    "max_attempts",
    "max_input_tokens",
    "max_output_tokens",
    "request_max_tokens",
    "question_max_tokens",
    "request_margin_tokens",
    "question_margin_tokens",
    "wall_ms",
    "reserve_ms",
    "min_work_ms"
  ] as const;
  const numbers: Record<(typeof integerFields)[number], number> = {
    max_attempts: 0,
    max_input_tokens: 0,
    max_output_tokens: 0,
    request_max_tokens: 0,
    question_max_tokens: 0,
    request_margin_tokens: 0,
    question_margin_tokens: 0,
    wall_ms: 0,
    reserve_ms: 0,
    min_work_ms: 0
  };
  for (const field of integerFields) {
    const candidate = value[field];
    if (!isSafeNonNegativeInteger(candidate)) {
      return err(
        schemaError(`${path}.${field}`, "non_negative_safe_integer", "budget_policy_parse")
      );
    }
    numbers[field] = candidate;
  }
  if (numbers.max_attempts < 1 || numbers.max_attempts > 10) {
    return err(schemaError(`${path}.max_attempts`, "1..10", "budget_policy_parse"));
  }
  const maxCostRaw = value["max_cost_micros"];
  let maxCost: number | null;
  if (maxCostRaw === null) {
    maxCost = null;
  } else if (isSafeNonNegativeInteger(maxCostRaw)) {
    maxCost = maxCostRaw;
  } else {
    return err(
      schemaError(`${path}.max_cost_micros`, "null_or_non_negative_safe_integer", "budget_policy_parse")
    );
  }
  if (value["attempt_charge_at"] !== "claim") {
    return err(schemaError(`${path}.attempt_charge_at`, "claim", "budget_policy_parse"));
  }
  if (value["attempt_refundable"] !== false) {
    return err(schemaError(`${path}.attempt_refundable`, "false", "budget_policy_parse"));
  }
  return ok({
    purpose,
    max_attempts: numbers.max_attempts,
    max_input_tokens: numbers.max_input_tokens,
    max_output_tokens: numbers.max_output_tokens,
    request_max_tokens: numbers.request_max_tokens,
    question_max_tokens: numbers.question_max_tokens,
    request_margin_tokens: numbers.request_margin_tokens,
    question_margin_tokens: numbers.question_margin_tokens,
    max_cost_micros: maxCost,
    wall_ms: numbers.wall_ms,
    reserve_ms: numbers.reserve_ms,
    min_work_ms: numbers.min_work_ms,
    attempt_charge_at: "claim",
    attempt_refundable: false
  });
}

function parseConcurrency(value: unknown): Result<BudgetConcurrencyPolicy, ErrorEnvelope> {
  if (!isPlainObject(value)) {
    return err(schemaError("concurrency", "object", "budget_policy_parse"));
  }
  const fields = [
    "global_inflight",
    "per_scope_inflight",
    "rpm",
    "burst",
    "cooldown_base_ms",
    "cooldown_max_ms"
  ] as const;
  const numbers: Record<(typeof fields)[number], number> = {
    global_inflight: 0,
    per_scope_inflight: 0,
    rpm: 0,
    burst: 0,
    cooldown_base_ms: 0,
    cooldown_max_ms: 0
  };
  for (const field of fields) {
    const candidate = value[field];
    if (!isSafeNonNegativeInteger(candidate)) {
      return err(
        schemaError(`concurrency.${field}`, "non_negative_safe_integer", "budget_policy_parse")
      );
    }
    numbers[field] = candidate;
  }
  if (value["unknown_limit_inflight"] !== 1) {
    return err(schemaError("concurrency.unknown_limit_inflight", "1", "budget_policy_parse"));
  }
  if (value["unknown_limit_rpm"] !== 6) {
    return err(schemaError("concurrency.unknown_limit_rpm", "6", "budget_policy_parse"));
  }
  return ok({
    global_inflight: numbers.global_inflight,
    per_scope_inflight: numbers.per_scope_inflight,
    rpm: numbers.rpm,
    burst: numbers.burst,
    cooldown_base_ms: numbers.cooldown_base_ms,
    cooldown_max_ms: numbers.cooldown_max_ms,
    unknown_limit_inflight: 1,
    unknown_limit_rpm: 6
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

