/**
 * Generation backend selection, service profile freezing and generation gates
 * (DD-HOST-002).
 *
 * `service_profile` is a HOST-only prerequisite produced by a host-contract
 * read-only probe. It never replaces `generation.create/auth/output` product
 * roundtrips and never opens automatic review, delivery or configuration.
 */

import type { ErrorEnvelope } from "../errors.js";
import { makeErrorEnvelope } from "../errors.js";
import { canonicalJsonText } from "../canonical.js";
import { hashBytes, isHash, type Hash } from "../hash.js";
import { toJsonValue, isRecord } from "../json.js";
import { err, ok, type Result } from "../result.js";
import { isSourceRef, type SourceRef } from "../source-ref.js";
import type { AdapterBackendSelection, CapabilityBinding, GenerationBackendRef, GenerationBackendSelectRequest, GenerationCancelRequest, GenerationCapabilityBinding, GenerationBackendSelection, GenerationAuthRequest, GenerationCreateRequest, GenerationOutputRequest, GenerationRecoverRequest, HostEventBinding, HostServiceProfileReadPort, ServiceProfile, ServiceProfileEvidence, ServiceProfileLimits } from "./types.js";
import { serviceProfileKey } from "./keys.js";
import { isSafeNonNegativeInt, isSafePositiveInt } from "./validation.js";

function generationError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CONFLICT",
    category: "conflict",
    message_key: "error.conflict",
    stage: "service_profile_validate",
    details: { kind: "field", path, rule }
  });
}

/** Validates the closed service-profile evidence schema and numeric gates. */
export function validateServiceProfileEvidence(
  value: unknown
): Result<ServiceProfileEvidence, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(generationError("$", "object"));
  }
  if (value["schema_version"] !== "rsi.service_profile_evidence/1") {
    return err(generationError("schema_version", "rsi.service_profile_evidence/1"));
  }
  for (const field of ["provider_scope", "backend_id", "host_id", "mode", "config_space"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      return err(generationError(field, "non_empty_string"));
    }
  }
  const requestMax = value["request_max_tokens"];
  const questionMax = value["question_max_tokens"];
  const outputMax = value["max_output_tokens"];
  if (!isSafePositiveInt(requestMax) || !isSafePositiveInt(questionMax) || !isSafePositiveInt(outputMax)) {
    return err(generationError("request_max_tokens", "positive_safe_integer"));
  }
  if (questionMax > requestMax || outputMax > requestMax) {
    return err(generationError("max_output_tokens", "at_most_request_max"));
  }
  const rpm = value["rpm"];
  const concurrency = value["concurrency"];
  if (rpm !== null && !isSafePositiveInt(rpm)) {
    return err(generationError("rpm", "positive_safe_integer_or_null"));
  }
  if (concurrency !== null && !isSafePositiveInt(concurrency)) {
    return err(generationError("concurrency", "positive_safe_integer_or_null"));
  }
  const pricing = value["pricing"];
  if (!isRecord(pricing) || (pricing["status"] !== "known" && pricing["status"] !== "unknown")) {
    return err(generationError("pricing", "pricing_branch"));
  }
  let parsedPricing: ServiceProfileEvidence["pricing"];
  if (pricing["status"] === "unknown") {
    parsedPricing = { status: "unknown" };
  } else {
    const input = pricing["input_micros_per_million"];
    const output = pricing["output_micros_per_million"];
    const fixed = pricing["fixed_micros"];
    if (!isSafeNonNegativeInt(input) || !isSafeNonNegativeInt(output) || !isSafeNonNegativeInt(fixed)) {
      return err(generationError("pricing", "non_negative_safe_integer"));
    }
    parsedPricing = {
      status: "known",
      input_micros_per_million: input,
      output_micros_per_million: output,
      fixed_micros: fixed
    };
  }
  const profileHash = value["profile_hash"];
  if (typeof profileHash !== "string" || !isHash(profileHash)) {
    return err(generationError("profile_hash", "sha256_hash"));
  }
  if (!isSafeNonNegativeInt(value["observed_at"])) {
    return err(generationError("observed_at", "non_negative_safe_integer"));
  }
  const evidence: ServiceProfileEvidence = {
    schema_version: "rsi.service_profile_evidence/1",
    provider_scope: value["provider_scope"] as string,
    backend_id: value["backend_id"] as string,
    host_id: value["host_id"] as ServiceProfileEvidence["host_id"],
    mode: value["mode"] as ServiceProfileEvidence["mode"],
    config_space: value["config_space"] as string,
    request_max_tokens: requestMax,
    question_max_tokens: questionMax,
    max_output_tokens: outputMax,
    rpm,
    concurrency,
    pricing: parsedPricing,
    profile_hash: profileHash as Hash,
    observed_at: value["observed_at"] as number
  };
  const expectedKey = serviceProfileKey({
    provider_scope: evidence.provider_scope,
    backend_id: evidence.backend_id,
    host_id: evidence.host_id,
    mode: evidence.mode,
    config_space: evidence.config_space,
    request_max_tokens: evidence.request_max_tokens,
    question_max_tokens: evidence.question_max_tokens,
    max_output_tokens: evidence.max_output_tokens,
    rpm: evidence.rpm,
    concurrency: evidence.concurrency,
    pricing: evidence.pricing
  });
  if (expectedKey !== profileHash) {
    return err(generationError("profile_hash", "service_profile_key_mismatch"));
  }
  return ok(evidence);
}

/** Builds the immutable `ServiceProfile` from validated evidence. */
export function freezeServiceProfile(
  evidence: ServiceProfileEvidence,
  evidenceRef: SourceRef
): ServiceProfile {
  const limits: ServiceProfileLimits = {
    source: "verified_profile",
    profile_hash: evidence.profile_hash,
    request_max_tokens: evidence.request_max_tokens,
    question_max_tokens: evidence.question_max_tokens,
    max_output_tokens: evidence.max_output_tokens,
    rpm: evidence.rpm,
    concurrency: evidence.concurrency,
    pricing: evidence.pricing
  };
  return {
    schema_version: "rsi.service_profile/1",
    service_profile_id: evidence.profile_hash,
    service_profile_key: evidence.profile_hash,
    provider_scope: evidence.provider_scope,
    limits,
    evidence_ref: evidenceRef
  };
}

/** `evidence_hash = sha256(JCS(ServiceProfileEvidence))`. */
export function serviceProfileEvidenceHash(evidence: ServiceProfileEvidence): Hash {
  return hashBytes(new TextEncoder().encode(canonicalJsonText(toJsonValue(evidence))));
}

/** Exact `host_contract` binding used for the read-only profile probe. */
export function serviceProfileBinding(input: {
  base: CapabilityBinding;
  backend_id: string;
}): CapabilityBinding {
  return {
    host_id: input.base.host_id,
    source_pin: input.base.source_pin,
    binary_pin: input.base.binary_pin,
    adapter_version: "diagnostic",
    subject: "host_contract",
    mode: input.base.mode,
    config_space: input.base.config_space,
    root_id: input.base.root_id,
    construction_path: input.base.construction_path,
    execution_environment: input.base.execution_environment,
    mapping: input.base.mapping,
    backend_id: input.backend_id
  };
}

const START_ACTIONS: readonly GenerationCapabilityBinding["name"][] = [
  "generation.create",
  "generation.auth",
  "generation.output"
];

interface GenerationGateResult {
  start_allowed: boolean;
  cancellable: boolean;
  recoverable: boolean;
  missing: GenerationCapabilityBinding[];
  profile_required: boolean;
}

/**
 * Generation start requires verified `create/auth/output`; cancel and recover
 * only flag the job and never block a start.
 */
export function evaluateGenerationGate(input: {
  capabilities: readonly GenerationCapabilityBinding[];
  service_profile_present: boolean;
}): GenerationGateResult {
  const byName = new Map<GenerationCapabilityBinding["name"], GenerationCapabilityBinding>();
  for (const capability of input.capabilities) {
    byName.set(capability.name, capability);
  }
  const missing: GenerationCapabilityBinding[] = [];
  let allPresent = true;
  for (const name of START_ACTIONS) {
    const capability = byName.get(name);
    if (capability === undefined) {
      allPresent = false;
      continue;
    }
    if (capability.status !== "verified") {
      missing.push(capability);
    }
  }
  const cancellable = byName.get("generation.cancel")?.status === "verified";
  const recoverable = byName.get("generation.recover")?.status === "verified";
  return {
    start_allowed: allPresent && missing.length === 0 && input.service_profile_present,
    cancellable,
    recoverable,
    missing,
    profile_required: !input.service_profile_present
  };
}

/** Validates a `GenerationBackendRef` before selection or persistence. */
export function validateGenerationBackendRef(
  value: unknown
): Result<GenerationBackendRef, ErrorEnvelope> {
  if (!isRecord(value)) {
    return err(generationError("$", "object"));
  }
  if (value["schema_version"] !== "rsi.generation_backend_ref/1") {
    return err(generationError("schema_version", "rsi.generation_backend_ref/1"));
  }
  if (typeof value["backend_id"] !== "string" || value["backend_id"].length === 0) {
    return err(generationError("backend_id", "non_empty_string"));
  }
  if (
    value["backend_kind"] !== "host_native_subagent" &&
    value["backend_kind"] !== "sdk" &&
    value["backend_kind"] !== "cli" &&
    value["backend_kind"] !== "service"
  ) {
    return err(generationError("backend_kind", "backend_kind"));
  }
  if (
    value["entry_kind"] !== "host_subagent" &&
    value["entry_kind"] !== "sdk_import" &&
    value["entry_kind"] !== "cli_spawn" &&
    value["entry_kind"] !== "http_service"
  ) {
    return err(generationError("entry_kind", "entry_kind"));
  }
  if (typeof value["entry_ref"] !== "string" || value["entry_ref"].length === 0) {
    return err(generationError("entry_ref", "non_empty_string"));
  }
  if (typeof value["backend_version"] !== "string" || value["backend_version"].length === 0) {
    return err(generationError("backend_version", "non_empty_string"));
  }
  if (!Array.isArray(value["protocol_versions"]) || !value["protocol_versions"].every((entry) => typeof entry === "string")) {
    return err(generationError("protocol_versions", "string[]"));
  }
  const isolation = value["isolation"];
  if (
    !isRecord(isolation) ||
    (isolation["mode"] !== "process" &&
      isolation["mode"] !== "container" &&
      isolation["mode"] !== "sandbox" &&
      isolation["mode"] !== "none" &&
      isolation["mode"] !== "unknown") ||
    (isolation["network"] !== "disabled" &&
      isolation["network"] !== "restricted" &&
      isolation["network"] !== "enabled" &&
      isolation["network"] !== "unknown") ||
    !Array.isArray(isolation["evidence_refs"]) ||
    !isolation["evidence_refs"].every((entry) => typeof entry === "string")
  ) {
    return err(generationError("isolation", "isolation"));
  }
  const capabilities = value["capabilities"];
  if (!isRecord(capabilities)) {
    return err(generationError("capabilities", "object"));
  }
  for (const key of ["create", "auth", "cancel", "recover", "output"]) {
    if (!isRecord(capabilities[key])) {
      return err(generationError(`capabilities.${key}`, "generation_capability_binding"));
    }
  }
  if (typeof value["capability_snapshot_hash"] !== "string" || !isHash(value["capability_snapshot_hash"])) {
    return err(generationError("capability_snapshot_hash", "sha256_hash"));
  }
  if (typeof value["approval_ref"] !== "string" || value["approval_ref"].length === 0) {
    return err(generationError("approval_ref", "non_empty_string"));
  }
  const parsedCreate = parseGenerationCapability(capabilities["create"], "generation.create");
  const parsedAuth = parseGenerationCapability(capabilities["auth"], "generation.auth");
  const parsedCancel = parseGenerationCapability(capabilities["cancel"], "generation.cancel");
  const parsedRecover = parseGenerationCapability(capabilities["recover"], "generation.recover");
  const parsedOutput = parseGenerationCapability(capabilities["output"], "generation.output");
  if (
    parsedCreate === null ||
    parsedAuth === null ||
    parsedCancel === null ||
    parsedRecover === null ||
    parsedOutput === null
  ) {
    return err(generationError("capabilities", "generation_capability_binding"));
  }
  const backend: GenerationBackendRef = {
    schema_version: "rsi.generation_backend_ref/1",
    backend_id: value["backend_id"] as string,
    backend_kind: value["backend_kind"] as GenerationBackendRef["backend_kind"],
    entry_kind: value["entry_kind"] as GenerationBackendRef["entry_kind"],
    entry_ref: value["entry_ref"] as string,
    backend_version: value["backend_version"] as string,
    protocol_versions: value["protocol_versions"] as string[],
    isolation: {
      mode: isolation["mode"] as GenerationBackendRef["isolation"]["mode"],
      network: isolation["network"] as GenerationBackendRef["isolation"]["network"],
      evidence_refs: isolation["evidence_refs"] as string[]
    },
    capabilities: {
      create: parsedCreate,
      auth: parsedAuth,
      cancel: parsedCancel,
      recover: parsedRecover,
      output: parsedOutput
    },
    capability_snapshot_hash: value["capability_snapshot_hash"] as Hash,
    approval_ref: value["approval_ref"] as string
  };
  if (isSafeNonNegativeInt(value["verified_at"])) {
    backend.verified_at = value["verified_at"];
  }
  return ok(backend);
}

function parseGenerationCapability(
  raw: unknown,
  name: GenerationCapabilityBinding["name"]
): GenerationCapabilityBinding | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw["capability_id"] !== "string" || typeof raw["status"] !== "string") {
    return null;
  }
  if (!Array.isArray(raw["evidence_refs"]) || !raw["evidence_refs"].every((entry) => typeof entry === "string")) {
    return null;
  }
  const capability: GenerationCapabilityBinding = {
    name,
    capability_id: raw["capability_id"] as import("../ids.js").Id<"cap">,
    status: raw["status"] as GenerationCapabilityBinding["status"],
    evidence_stage: raw["evidence_stage"] as GenerationCapabilityBinding["evidence_stage"],
    evidence_refs: raw["evidence_refs"]
  };
  if (raw["probe_result"] === "passed" || raw["probe_result"] === "failed" || raw["probe_result"] === "blocked" || raw["probe_result"] === "unknown") {
    capability.probe_result = raw["probe_result"];
  }
  return capability;
}

/**
 * HOST wrapper for `selectBackend`: adapter `available` still requires a frozen
 * service profile. A missing or invalid profile yields `blocked_no_backend`.
 */
export async function completeGenerationBackendSelection(input: {
  selection: AdapterBackendSelection;
  binding: CapabilityBinding;
  request_id: string;
  deadline_ms: number;
  profiles: HostServiceProfileReadPort;
  signal: AbortSignal;
}): Promise<Result<GenerationBackendSelection, ErrorEnvelope>> {
  if (input.selection.state === "blocked_no_backend") {
    return ok({
      state: "blocked_no_backend",
      reason: input.selection.reason ?? "no_approved_backend",
      missing: input.selection.missing ?? [],
      evidence_refs: input.selection.evidence_refs ?? []
    });
  }
  const backend = input.selection.backend;
  if (backend === undefined) {
    return ok({
      state: "blocked_no_backend",
      reason: "no_approved_backend",
      missing: [],
      evidence_refs: []
    });
  }
  const binding = serviceProfileBinding({ base: input.binding, backend_id: backend.backend_id });
  const selected = await input.profiles.select({
    request_id: input.request_id,
    binding,
    backend_id: backend.backend_id,
    deadline_ms: input.deadline_ms,
    signal: input.signal
  });
  if (!selected.ok) {
    return ok({
      state: "blocked_no_backend",
      reason: "capability_unknown",
      missing: [],
      evidence_refs: []
    });
  }
  if (selected.value === null) {
    return ok({
      state: "blocked_no_backend",
      reason: "capability_unknown",
      missing: [],
      evidence_refs: []
    });
  }
  return ok({ state: "available", backend, service_profile: selected.value });
}

/* ------------------------------------------------------------------ */
/* Generation method request schemas (DD-HOST-002)                     */
/* ------------------------------------------------------------------ */

type GenerationRequestMethod =
  | "select"
  | "create"
  | "auth"
  | "cancel"
  | "recover"
  | "read_output";

type ValidatedGenerationRequest =
  | GenerationBackendSelectRequest
  | GenerationCreateRequest
  | GenerationAuthRequest
  | GenerationCancelRequest
  | GenerationRecoverRequest
  | GenerationOutputRequest;

function requestError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "generation_request_validate",
    details: { kind: "field", path, rule }
  });
}

function isRequestRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDeadline(value: unknown): value is number {
  return isSafePositiveInt(value) && value <= 600_000;
}

function isHostEventBindingShape(value: unknown): value is HostEventBinding {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["host_id"] === "string" &&
    typeof value["host_version"] === "string" &&
    typeof value["adapter_id"] === "string" &&
    typeof value["adapter_version"] === "string" &&
    typeof value["implementation_hash"] === "string" &&
    typeof value["mode"] === "string" &&
    typeof value["config_space"] === "string" &&
    typeof value["host_event"] === "string" &&
    typeof value["stream_id"] === "string" &&
    typeof value["event_identity_key"] === "string" &&
    isSafeNonNegativeInt(value["receipt_seq"]) &&
    isSafeNonNegativeInt(value["received_at"])
  );
}

function parseIsolation(value: unknown): GenerationBackendRef["isolation"] | null {
  if (
    !isRecord(value) ||
    (value["mode"] !== "process" &&
      value["mode"] !== "container" &&
      value["mode"] !== "sandbox" &&
      value["mode"] !== "none" &&
      value["mode"] !== "unknown") ||
    (value["network"] !== "disabled" &&
      value["network"] !== "restricted" &&
      value["network"] !== "enabled" &&
      value["network"] !== "unknown") ||
    !isStringArray(value["evidence_refs"])
  ) {
    return null;
  }
  return {
    mode: value["mode"],
    network: value["network"],
    evidence_refs: value["evidence_refs"]
  };
}

const AUTH_PLAINTEXT_KEYS: readonly string[] = [
  "credential",
  "password",
  "api_key",
  "token",
  "secret",
  "plaintext"
];

/**
 * Validates one of the six generation method requests. Authentication accepts
 * only a credential reference: a plaintext credential field is a schema error
 * before any adapter call.
 */
export function validateGenerationRequest(
  method: GenerationRequestMethod,
  value: unknown
): Result<ValidatedGenerationRequest, ErrorEnvelope> {
  if (!isRequestRecord(value)) {
    return err(requestError("$", "object"));
  }
  if (!isNonEmptyString(value["job_id"])) {
    return err(requestError("job_id", "non_empty_string"));
  }
  if (!isDeadline(value["deadline_ms"])) {
    return err(requestError("deadline_ms", "1..600000"));
  }
  switch (method) {
    case "select": {
      if (typeof value["review_scope_key"] !== "string" || !isHash(value["review_scope_key"])) {
        return err(requestError("review_scope_key", "sha256_hash"));
      }
      if (!isHostEventBindingShape(value["host_binding"])) {
        return err(requestError("host_binding", "host_event_binding"));
      }
      if (!isStringArray(value["approved_backend_ids"])) {
        return err(requestError("approved_backend_ids", "string[]"));
      }
      if (
        value["required_isolation"] !== "process" &&
        value["required_isolation"] !== "container" &&
        value["required_isolation"] !== "sandbox" &&
        value["required_isolation"] !== "none"
      ) {
        return err(requestError("required_isolation", "isolation"));
      }
      if (
        value["required_network"] !== "disabled" &&
        value["required_network"] !== "restricted" &&
        value["required_network"] !== "enabled"
      ) {
        return err(requestError("required_network", "network"));
      }
      if (!isNonEmptyString(value["budget_policy_ref"])) {
        return err(requestError("budget_policy_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(value["capability_policy_ref"])) {
        return err(requestError("capability_policy_ref", "non_empty_string"));
      }
      return ok({
        job_id: value["job_id"],
        review_scope_key: value["review_scope_key"] as Hash,
        host_binding: value["host_binding"],
        approved_backend_ids: value["approved_backend_ids"],
        required_isolation: value["required_isolation"],
        required_network: value["required_network"],
        budget_policy_ref: value["budget_policy_ref"],
        capability_policy_ref: value["capability_policy_ref"],
        deadline_ms: value["deadline_ms"]
      });
    }
    case "create": {
      const generationRunId = value["generation_run_id"];
      const snapshotRef = value["snapshot_ref"];
      if (!isNonEmptyString(generationRunId)) {
        return err(requestError("generation_run_id", "non_empty_string"));
      }
      if (typeof snapshotRef !== "string" || !isSourceRef(snapshotRef)) {
        return err(requestError("snapshot_ref", "source_ref"));
      }
      const backend = validateGenerationBackendRef(value["backend"]);
      if (!backend.ok) {
        return backend;
      }
      if (!isHostEventBindingShape(value["host_binding"])) {
        return err(requestError("host_binding", "host_event_binding"));
      }
      const workspaceRef = value["workspace_ref"];
      const permissionScopeRef = value["permission_scope_ref"];
      const budgetRef = value["budget_ref"];
      const idempotencyKey = value["idempotency_key"];
      if (!isNonEmptyString(workspaceRef)) {
        return err(requestError("workspace_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(permissionScopeRef)) {
        return err(requestError("permission_scope_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(budgetRef)) {
        return err(requestError("budget_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(idempotencyKey)) {
        return err(requestError("idempotency_key", "non_empty_string"));
      }
      const isolation = parseIsolation(value["isolation"]);
      if (isolation === null) {
        return err(requestError("isolation", "isolation"));
      }
      if (value["origin"] !== "evaluator") {
        return err(requestError("origin", "evaluator"));
      }
      const targetPolicyRaw = value["target_policy"];
      let targetPolicy: GenerationCreateRequest["target_policy"];
      if (targetPolicyRaw !== undefined) {
        if (!isRecord(targetPolicyRaw)) {
          return err(requestError("target_policy", "object"));
        }
        const allowedTypes = targetPolicyRaw["allowed_object_types"];
        if (
          !Array.isArray(allowedTypes) ||
          allowedTypes.length === 0 ||
          allowedTypes.some(
            (entry) => entry !== "skill" && entry !== "memory" && entry !== "instructions"
          )
        ) {
          return err(requestError("target_policy.allowed_object_types", "object_types"));
        }
        const allowedRefs = targetPolicyRaw["allowed_target_refs"];
        if (
          allowedRefs !== undefined &&
          (!Array.isArray(allowedRefs) || allowedRefs.some((entry) => !isNonEmptyString(entry)))
        ) {
          return err(requestError("target_policy.allowed_target_refs", "string_array"));
        }
        targetPolicy = {
          allowed_object_types: allowedTypes as Array<"skill" | "memory" | "instructions">,
          ...(allowedRefs === undefined ? {} : { allowed_target_refs: allowedRefs as string[] })
        };
      }
      const retryRaw = value["retry_feedback"];
      let retryFeedback: GenerationCreateRequest["retry_feedback"];
      if (retryRaw !== undefined) {
        if (
          !isRecord(retryRaw) ||
          !isNonEmptyString(retryRaw["code"]) ||
          !isNonEmptyString(retryRaw["path"]) ||
          !isNonEmptyString(retryRaw["rule"])
        ) {
          return err(requestError("retry_feedback", "code_path_rule"));
        }
        retryFeedback = {
          code: retryRaw["code"],
          path: retryRaw["path"],
          rule: retryRaw["rule"]
        };
      }
      return ok({
        job_id: value["job_id"],
        generation_run_id: generationRunId,
        snapshot_ref: snapshotRef,
        ...(targetPolicy === undefined ? {} : { target_policy: targetPolicy }),
        backend: backend.value,
        host_binding: value["host_binding"],
        workspace_ref: workspaceRef,
        permission_scope_ref: permissionScopeRef,
        budget_ref: budgetRef,
        isolation,
        origin: "evaluator",
        deadline_ms: value["deadline_ms"],
        idempotency_key: idempotencyKey,
        ...(retryFeedback === undefined ? {} : { retry_feedback: retryFeedback })
      });
    }
    case "auth": {
      for (const key of Object.keys(value)) {
        if (AUTH_PLAINTEXT_KEYS.includes(key)) {
          return err(requestError(key, "credential_ref_only"));
        }
      }
      const handleRef = value["handle_ref"];
      const credentialRef = value["credential_ref"];
      const dataScopeRef = value["data_scope_ref"];
      if (!isNonEmptyString(handleRef)) {
        return err(requestError("handle_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(credentialRef)) {
        return err(requestError("credential_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(dataScopeRef)) {
        return err(requestError("data_scope_ref", "non_empty_string"));
      }
      return ok({
        job_id: value["job_id"],
        handle_ref: handleRef,
        credential_ref: credentialRef,
        data_scope_ref: dataScopeRef,
        deadline_ms: value["deadline_ms"]
      });
    }
    case "cancel": {
      const handleRef = value["handle_ref"];
      const reason = value["reason"];
      const idempotencyKey = value["idempotency_key"];
      if (!isNonEmptyString(handleRef)) {
        return err(requestError("handle_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(reason)) {
        return err(requestError("reason", "non_empty_string"));
      }
      if (!isNonEmptyString(idempotencyKey)) {
        return err(requestError("idempotency_key", "non_empty_string"));
      }
      return ok({
        job_id: value["job_id"],
        handle_ref: handleRef,
        reason,
        idempotency_key: idempotencyKey,
        deadline_ms: value["deadline_ms"]
      });
    }
    case "recover": {
      const handleRef = value["handle_ref"];
      const snapshotRef = value["snapshot_ref"];
      const resumeKind = value["resume_kind"];
      if (!isNonEmptyString(handleRef)) {
        return err(requestError("handle_ref", "non_empty_string"));
      }
      if (!isNonEmptyString(snapshotRef)) {
        return err(requestError("snapshot_ref", "non_empty_string"));
      }
      if (!isSourceRef(snapshotRef)) {
        return err(requestError("snapshot_ref", "source_ref"));
      }
      if (!isNonEmptyString(resumeKind)) {
        return err(requestError("resume_kind", "non_empty_string"));
      }
      return ok({
        job_id: value["job_id"],
        handle_ref: handleRef,
        snapshot_ref: snapshotRef,
        resume_kind: resumeKind,
        deadline_ms: value["deadline_ms"]
      });
    }
    case "read_output": {
      if (!isNonEmptyString(value["handle_ref"])) {
        return err(requestError("handle_ref", "non_empty_string"));
      }
      if (value["cursor"] !== undefined && typeof value["cursor"] !== "string") {
        return err(requestError("cursor", "string"));
      }
      if (!isSafePositiveInt(value["max_bytes"])) {
        return err(requestError("max_bytes", "positive_safe_integer"));
      }
      const request: GenerationOutputRequest = {
        job_id: value["job_id"],
        handle_ref: value["handle_ref"],
        max_bytes: value["max_bytes"],
        deadline_ms: value["deadline_ms"]
      };
      if (typeof value["cursor"] === "string") {
        request.cursor = value["cursor"];
      }
      return ok(request);
    }
  }
}
