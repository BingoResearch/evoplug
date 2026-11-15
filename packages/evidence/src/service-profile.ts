/**
 * Jev service profile, semantic capability and validator bindings
 * (DD-EVD-017, DD-EVD-016A, DD-EVD-019).
 *
 * Profiles are content-addressed by `profile_key`; acceptance and observation
 * never enter the key. `profile_version` is allocated by the FND single writer
 * with `max_plus_one`, so this module only builds the row body.
 */

import { newId, type JsonValue, type SourceRef } from "@evoplug/core";

import {
  jevLimitsHash,
  jevProfileKey,
  jevServiceStateKey,
  jevValidatorBindingKey,
  jevValidatorPolicyHash,
  semanticBackendKey,
  semanticCapabilityHash,
  semanticCapabilityKey,
  semanticContractHash,
  semanticLimitsHash,
  semanticPolicyHash,
  semanticScopeKey,
  semanticValidatorBindingKey,
  sortUtf8Strings,
} from "./hashing.js";
import type {
  BudgetLimitsView,
  JevServiceProfile,
  JevServiceState,
  SemanticBackendCapability,
  SemanticBackendLimits,
  SemanticScope,
  SemanticValidationBinding,
  ValidatorBinding,
} from "./types.js";

export type JevServiceProfileBody = Omit<
  JevServiceProfile,
  "profile_id" | "profile_version" | "created_at"
>;

export interface JevServiceProfileInput {
  provider: "typesafe" | "openrouter";
  base_url: string;
  route: string;
  requested_model: string;
  expected_returned_model: string;
  model_kind: "fixed" | "alias";
  observed_snapshot_id?: string;
  limits: {
    request_max_tokens: number | null;
    question_max_tokens: number | null;
    source: "official_docs" | "provider_metadata" | "unknown";
    source_refs: SourceRef[];
  };
  long_context: { supported: "yes" | "no" | "unknown"; source_refs: SourceRef[] };
  official_precision_policy: "none" | "documented";
  observed_wire_precision: JevServiceProfile["observed_wire_precision"];
  precision_contract: "none_published" | "documented";
  observed_failures: JevServiceProfile["observed_failures"];
  credential_ref: string;
  h_evidence_refs: SourceRef[];
}

export function buildJevServiceProfile(input: JevServiceProfileInput): JevServiceProfileBody {
  const limitsHash = jevLimitsHash(input.limits);
  const longContext = {
    supported: input.long_context.supported,
    enabled: false as const,
    source_refs: sortUtf8Strings(input.long_context.source_refs) as SourceRef[],
  };
  const limits: BudgetLimitsView = {
    request_max_tokens: input.limits.request_max_tokens,
    question_max_tokens: input.limits.question_max_tokens,
    source: input.limits.source,
    source_refs: sortUtf8Strings(input.limits.source_refs) as SourceRef[],
    limits_hash: limitsHash,
  };
  const profileKey = jevProfileKey({
    provider: input.provider,
    base_url: input.base_url,
    route: input.route,
    endpoint_contract_version: "rsi.jev.wire/1",
    requested_model: input.requested_model,
    expected_returned_model: input.expected_returned_model,
    model_kind: input.model_kind,
    response_schema_version: "rsi.judge_wire/1",
    limits_hash: limitsHash,
    long_context: longContext,
    official_precision_policy: input.official_precision_policy,
    precision_contract: input.precision_contract,
  });
  const acceptance = evaluateJevAcceptance({
    limits,
    model_kind: input.model_kind,
    observed_failures: input.observed_failures,
    transport_verified: input.h_evidence_refs.length > 0,
  });
  const body: JevServiceProfileBody = {
    schema_version: "rsi.jev_service_profile/1",
    profile_key: profileKey,
    provider: input.provider,
    base_url: input.base_url,
    route: input.route,
    endpoint_contract_version: "rsi.jev.wire/1",
    requested_model: input.requested_model,
    expected_returned_model: input.expected_returned_model,
    model_kind: input.model_kind,
    response_schema_version: "rsi.judge_wire/1",
    limits,
    long_context: longContext,
    official_precision_policy: input.official_precision_policy,
    observed_wire_precision: input.observed_wire_precision,
    precision_contract: input.precision_contract,
    observed_failures: input.observed_failures,
    production_use: acceptance.status === "eligible",
    credential_ref: input.credential_ref,
    acceptance,
    h_evidence_refs: sortUtf8Strings(input.h_evidence_refs) as SourceRef[],
  };
  if (input.observed_snapshot_id !== undefined) {
    body.observed_snapshot_id = input.observed_snapshot_id;
  }
  return body;
}

export function evaluateJevAcceptance(input: {
  limits: BudgetLimitsView;
  model_kind: "fixed" | "alias";
  observed_failures: JevServiceProfile["observed_failures"];
  transport_verified: boolean;
}): JevServiceProfile["acceptance"] {
  const reasons: string[] = [];
  if (
    input.limits.request_max_tokens === null ||
    input.limits.question_max_tokens === null ||
    input.limits.source === "unknown"
  ) {
    reasons.push("limits_unknown");
  }
  if (input.observed_failures.length > 0) {
    reasons.push("observed_precision_failure");
  }
  if (!input.transport_verified) {
    reasons.push("endpoint_unverified");
  }
  if (input.model_kind === "alias") {
    return { status: "shadow_only", reasons: sortUtf8Strings([...reasons, "alias_model"]) };
  }
  if (reasons.length > 0) {
    return { status: "blocked", reasons: sortUtf8Strings(reasons) };
  }
  return { status: "eligible", reasons: [] };
}

export function buildJevServiceState(input: {
  profile: JevServiceProfile;
  rowVersion: number;
  updatedAt: number;
}): JevServiceState {
  return {
    schema_version: "rsi.jev_service_state/1",
    service_state_key: jevServiceStateKey(input.profile.profile_key),
    profile_key: input.profile.profile_key,
    current_profile_version: input.profile.profile_version,
    current_profile_id: input.profile.profile_id,
    acceptance_status: input.profile.acceptance.status,
    reason_codes: sortUtf8Strings(input.profile.acceptance.reasons),
    updated_at: input.updatedAt,
    row_version: input.rowVersion,
  };
}

export function assertServiceStateConsistent(
  state: JevServiceState,
  currentProfileVersion: number
): boolean {
  return state.current_profile_version === currentProfileVersion;
}

export function buildJevValidatorBinding(input: {
  profile: JevServiceProfile;
  now: number;
}): ValidatorBinding {
  const policyHash = jevValidatorPolicyHash();
  const key = jevValidatorBindingKey({
    validator_policy_hash: policyHash,
    service_profile_key: input.profile.profile_key,
  });
  return {
    schema_version: "rsi.judge.validator_binding/1",
    validator_binding_id: newId("svcp", input.now),
    validator_binding_key: key,
    validator_policy_version: "rsi.judge.validator/1",
    validator_policy_hash: policyHash,
    service_profile_id: input.profile.profile_id,
    service_profile_key: input.profile.profile_key,
    response_schema_version: "rsi.judge_wire/1",
    tolerance_policy: "local_fixed",
    probability_sum_tolerance: 1e-6,
    confidence_tolerance: 1e-6,
    partial_batch: "reject_all",
    created_at: input.now,
  };
}

export interface SemanticCapabilityInput {
  backend_kind: "jev_typed" | "local_classifier" | "other";
  implementation_id: string;
  implementation_version: string;
  method: SemanticBackendCapability["method"];
  scope: SemanticScope;
  transport_status: "verified" | "unknown" | "unsupported" | "failed";
  semantic_competence: SemanticBackendCapability["semantic_competence"];
  limits: Omit<SemanticBackendLimits, "schema_version" | "limits_hash">;
  source_refs: SourceRef[];
}

export function buildSemanticBackendCapability(
  input: SemanticCapabilityInput
): SemanticBackendCapability {
  const limits: SemanticBackendLimits = {
    schema_version: "rsi.semantic_backend_limits/1",
    ...input.limits,
    limits_hash: semanticLimitsHash(input.limits),
  };
  const scopeKey = semanticScopeKey(input.scope);
  const backendKey = semanticBackendKey({
    backend_kind: input.backend_kind,
    implementation_id: input.implementation_id,
    implementation_version: input.implementation_version,
    method: input.method,
    scope_key: scopeKey,
  });
  const base: SemanticBackendCapability = {
    schema_version: "rsi.semantic_backend_capability/1",
    backend_key: backendKey,
    capability_key: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    capability_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    backend_kind: input.backend_kind,
    implementation_id: input.implementation_id,
    implementation_version: input.implementation_version,
    method: input.method,
    scope: {
      schema_version: "rsi.semantic_scope/1",
      question_classes: sortUtf8Strings(input.scope.question_classes) as SemanticScope["question_classes"],
      issue_types: sortUtf8Strings(input.scope.issue_types),
      state_profiles: sortUtf8Strings(input.scope.state_profiles) as SemanticScope["state_profiles"],
      evidence_kinds: sortUtf8Strings(input.scope.evidence_kinds) as SemanticScope["evidence_kinds"],
    },
    output_contracts: ["categorical_option/1"],
    transport_status: input.transport_status,
    semantic_competence: [...input.semantic_competence].sort((a, b) =>
      a.question_class < b.question_class ? -1 : 1
    ),
    limits,
    source_refs: sortUtf8Strings(input.source_refs) as SourceRef[],
  };
  const capabilityKey = semanticCapabilityKey(base);
  const withKey: SemanticBackendCapability = { ...base, capability_key: capabilityKey };
  const capabilityHash = semanticCapabilityHash(withKey);
  return { ...withKey, capability_hash: capabilityHash };
}

export function buildSemanticValidationBinding(input: {
  capability: SemanticBackendCapability;
  now: number;
}): SemanticValidationBinding {
  const policyHash = semanticPolicyHash();
  const contractHash = semanticContractHash();
  const key = semanticValidatorBindingKey({
    backend_key: input.capability.backend_key,
    capability_key: input.capability.capability_key,
    capability_hash: input.capability.capability_hash,
    policy_hash: policyHash,
    contract_hash: contractHash,
  });
  return {
    schema_version: "rsi.semantic_validation_binding/1",
    validator_binding_id: newId("svcp", input.now),
    validator_binding_key: key,
    backend_key: input.capability.backend_key,
    capability_key: input.capability.capability_key,
    capability_hash: input.capability.capability_hash,
    output_contract: "categorical_option/1",
    policy_version: "rsi.semantic.validator/1",
    policy_hash: policyHash,
    contract_hash: contractHash,
    created_at: input.now,
  };
}

export interface ServiceProfileReadResult {
  profile: JevServiceProfile;
  profile_version: number;
}

/**
 * Resolves the current profile by `max(profile_version)`, then enforces the
 * pre-dispatch gate: missing, blocked or mismatched profile never dispatches.
 */
export function resolveDispatchProfile(input: {
  rows: readonly JevServiceProfile[];
  expected: { provider: string; route: string; requested_model: string };
}): { ok: true; profile: JevServiceProfile } | { ok: false; code: string; details: Record<string, JsonValue> } {
  if (input.rows.length === 0) {
    return { ok: false, code: "E_SERVICE_PROFILE_UNKNOWN", details: { profile_key: "" } };
  }
  const latest = [...input.rows].sort((a, b) => b.profile_version - a.profile_version)[0];
  if (latest === undefined) {
    return { ok: false, code: "E_SERVICE_PROFILE_UNKNOWN", details: { profile_key: "" } };
  }
  if (latest.provider !== input.expected.provider) {
    return {
      ok: false,
      code: "E_SERVICE_PROFILE_MISMATCH",
      details: {
        field: "provider",
        expected: input.expected.provider,
        actual: latest.provider,
      },
    };
  }
  if (latest.route !== input.expected.route) {
    return {
      ok: false,
      code: "E_SERVICE_PROFILE_MISMATCH",
      details: {
        field: "route",
        expected: input.expected.route,
        actual: latest.route,
      },
    };
  }
  if (
    latest.requested_model !== input.expected.requested_model &&
    latest.expected_returned_model !== input.expected.requested_model
  ) {
    return {
      ok: false,
      code: "E_SERVICE_PROFILE_MISMATCH",
      details: {
        field: "model",
        expected: input.expected.requested_model,
        actual: latest.requested_model,
      },
    };
  }
  if (latest.acceptance.status === "blocked" || !latest.production_use) {
    return {
      ok: false,
      code: "E_SERVICE_PROFILE_BLOCKED",
      details: {
        profile_key: latest.profile_key,
        profile_version: latest.profile_version,
      },
    };
  }
  return { ok: true, profile: latest };
}


export { semanticScopeKey, jevServiceStateKey };
