/**
 * Default local EVD composition (DD-EVD-013/015/016A/019/024/025/026).
 *
 * The bootstrap installs this module after the default QP stage so an admitted
 * event continues through the real evidence path instead of stopping at
 * `downstream_unavailable`:
 *
 *   persisted service profile + semantic validator + budget scope
 *     -> real EVD writer / reader / `/3` binding reader
 *     -> `runOnlineDownstream` (compile, binding, Jev, aggregation,
 *        judgment, decision record, delivery)
 *
 * Every configured value is read from persisted rows. There is no frozen
 * rule that picks between two capability profile keys, two Jev profiles, or
 * two validator rows, so this module refuses with a field-level envelope
 * instead of selecting one. The same rule applies to the judge budget scope:
 * all fields are copied from the active `bpol/1` judge scope; this module
 * never supplies a default.
 *
 * The only field translation is `deadline_ms <- scope.wall_ms`: `RunBudget`
 * has one wall-clock field and the `bpol/1` judge scope calls the same
 * allowance `wall_ms`. No other budget field is derived.
 *
 * `DecisionDraft.inputs` has no defined snapshot preimage yet, and
 * `DeliveryPipelinePort.prepare` has no defined projection rule. Their reads
 * return `E_EVIDENCE_UNKNOWN` with the exact missing field; they never mint a
 * hash or a delivery plan.
 */

import {
  err,
  makeErrorEnvelope,
  ok,
  systemClock,
  type Clock,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type Result,
  type Tx
} from "@evoplug/core";
import {
  readBudgetScopeInTransaction,
  type BudgetScopePolicyView
} from "@evoplug/budget";
import {
  createAnswerAggregator,
  createSemanticBackendTransport,
  jevLimitsHash,
  jevProfileKey,
  semanticBackendKey,
  semanticCapabilityHash,
  semanticCapabilityKey,
  semanticContractHash,
  semanticLimitsHash,
  semanticPolicyHash,
  semanticScopeKey,
  semanticValidatorBindingKey,
  type AnswerAggregator,
  type CredentialReferenceResolver,
  type EvdServiceProfileRow,
  type EvidenceIssueReadPort,
  type EvidencePlanReadPort,
  type JevServiceProfile,
  type PlanReadPort,
  type RunBudget,
  type SemanticBackendCapability,
  type SemanticBackendRef,
  type SemanticBackendPort,
  type SemanticBackendTransportOutcome,
  type SemanticHttpExecutor,
  type SemanticValidationBinding
} from "@evoplug/evidence";
import type {
  IssueReadRepository,
  QuestionPlanRepository
} from "@evoplug/core/evidence";
import type { BlobStore, JournalWriter, SqliteConnection } from "@evoplug/storage";
import type { SourceRefPort } from "@evoplug/core";
import {
  computeDeliveryExpiresAt,
  type DeliveryTtlPolicy
} from "@evoplug/delivery";

import type { DefaultDeliveryCreateEnqueuePort } from "./default-decision-delivery.js";
import { createDefaultQuestionEvidencePorts } from "./default-question-evidence.js";
import { createDefaultEvidenceReader } from "./default-evidence-reader.js";
import type { DefaultEvidenceReader } from "./default-evidence-reader.js";
import { createDefaultEvidenceWriter } from "./default-evidence-writer.js";
import type { DefaultEvidenceWriterBundle } from "./default-evidence-writer.js";
import { createEvidenceBindingReadPort } from "./evidence-binding-reader.js";
import type { EvidenceBindingReadPort } from "./evidence-binding-reader.js";
import { runOnlineDownstream } from "./online-pipeline.js";
import { prepareDecisionInputs, prepareDeliveryProjection } from "./online-preparation.js";
import type {
  CommittedHostEvent,
  DecisionInputsPipelinePort,
  DecisionRecordPort,
  DeliveryPipelinePort,
  DispatchPipelineOptions,
  SupplementPipelineOptions,
  EvdPipelineDeps,
  OnlineDownstreamDeps,
  OnlineIssue,
  OnlinePipelineOutcome,
  OnlinePipelineStage,
  OnlinePlanState,
  OnlineQuestionPlan,
  QpPipelineDeps
} from "./online-pipeline.js";

/* ------------------------------------------------------------------ */
/* Public shape                                                        */
/* ------------------------------------------------------------------ */

export interface DefaultEvidenceCompositionDeps {
  /** The single-writer FND connection shared with QP and the other writers. */
  readonly connection: SqliteConnection;
  /**
   * The independent read-only connection for the EVD reader. Production
   * composition always supplies it (DD-FND-024); the reader opens its own
   * `BEGIN DEFERRED` so it never nests inside a writer transaction.
   */
  readonly read_connection: SqliteConnection;
  readonly blob_store: BlobStore;
  /** The shared journal writer; no second journal is opened here. */
  readonly journal: JournalWriter;
  readonly journal_relative_path: string;
  /** FND source resolver used by the `/3` binding reader for provenance. */
  readonly source_refs?: Pick<SourceRefPort, "resolve">;
  /** Concrete Jev transport; absent keeps dispatch blocked. */
  readonly jev_transport?: SemanticBackendPort;
  readonly dispatch?: DispatchPipelineOptions;
  readonly evidence_supplement?: SupplementPipelineOptions;
  readonly now: () => number;
  /** Explicit delivery TTL; omitted keeps delivery preparation fail-closed. */
  readonly delivery_expiry_ms?: number;
  /**
   * W5 policy form. Preferred over `delivery_expiry_ms` when both are set;
   * `next_input_epoch_at` is optional and never invented here.
   */
  readonly delivery_ttl?: DeliveryTtlPolicy;
  /**
   * Resolves the next input epoch's wall-clock time. Called once per
   * `prepare`; `null`/`undefined` means unknown and the TTL window alone is
   * used. A value not ahead of `now` is rejected, not clamped.
   */
  readonly delivery_next_input_epoch_at?: () => number | null | undefined;
  /**
   * Monotonic clock for EVD/Jev deadlines. Defaults to `systemClock`; callers
   * that inject a fake `now` must inject the matching clock.
   */
  readonly clock?: Clock;
}

/** QP stage content the tail consumes. */
export interface DefaultEvidenceQpStage {
  readonly issues: readonly OnlineIssue[];
  readonly plans: readonly OnlineQuestionPlan[];
  /**
   * QP-persisted lifecycle for every planned id. The stage must not invent
   * `active`; a missing entry is resolved through `plan_lifecycle`.
   */
  readonly plan_states: ReadonlyMap<string, OnlinePlanState>;
  readonly stages: readonly OnlinePipelineStage[];
  readonly diagnostics: readonly string[];
}

export interface DefaultEvidenceDownstreamInput {
  readonly event: CommittedHostEvent;
  /** Admission outcome, carried unchanged except for the appended QP stages. */
  readonly admitted: OnlinePipelineOutcome;
  readonly qp: DefaultEvidenceQpStage;
  readonly qp_deps: QpPipelineDeps;
  readonly plans_repository: QuestionPlanRepository;
  readonly issues_repository: IssueReadRepository;
  /** The real `decision.record` port extracted from the IPC handler. */
  readonly decision: DecisionRecordPort;
  /** The real `delivery.create` / outbox enqueue port. */
  readonly delivery: DefaultDeliveryCreateEnqueuePort;
  /**
   * Monotonic clock paired with the caller's `now`. Overrides the composition
   * default; production callers pass the same instance everywhere.
   */
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export interface DefaultEvidenceComposition {
  readonly writer: DefaultEvidenceWriterBundle;
  readonly reader: DefaultEvidenceReader;
  readonly binding: EvidenceBindingReadPort;
  /**
   * Resolves the persisted profile/validator/budget, installs the real local
   * EVD ports and runs the post-QP tail.
   */
  runDownstream(
    input: DefaultEvidenceDownstreamInput
  ): Promise<Result<OnlinePipelineOutcome, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Typed field failures                                                */
/* ------------------------------------------------------------------ */

const PROFILE_STAGE = "evidence_profile";
const BUDGET_STAGE = "evidence_budget";
const DECISION_STAGE = "evidence_decision";
const DELIVERY_STAGE = "evidence_delivery";

/** A persisted fact is absent or not selectable without a frozen rule. */
export function evidenceUnknown(path: string, rule: string, stage: string = PROFILE_STAGE): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_EVIDENCE_UNKNOWN",
    category: "source",
    message_key: "error.evidence.unknown",
    stage,
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function versionError(path: string, expected: string, actual: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_VERSION_BINDING",
    category: "version",
    message_key: "error.version.binding",
    stage: PROFILE_STAGE,
    retryable: false,
    side_effect: "none",
    details: { kind: "version", expected, actual }
  });
}

function stateRowError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STATE_ROW_SCHEMA",
    category: "schema",
    message_key: "error.state_row.schema",
    stage: PROFILE_STAGE,
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/**
 * A persisted body that cannot even be hashed is a row-schema failure, not an
 * exception that escapes the online runner. Hashing throws on non-JSON input,
 * so every recomputation is guarded here.
 */
function checkedBody<T>(
  path: string,
  read: () => Result<T, ErrorEnvelope>
): Result<T, ErrorEnvelope> {
  try {
    return read();
  } catch {
    return err(stateRowError(path, "body_json_not_hashable"));
  }
}

function profileBlocked(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SERVICE_PROFILE_BLOCKED",
    category: "policy",
    message_key: "error.policy.blocked",
    stage: PROFILE_STAGE,
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/* ------------------------------------------------------------------ */
/* Persisted profile, validator and limits                             */
/* ------------------------------------------------------------------ */

export interface ResolvedEvidenceBinding {
  readonly backend: SemanticBackendRef;
  readonly service_profile: JevServiceProfile | SemanticBackendCapability;
  readonly service_profile_key: Hash;
  readonly validator_binding_id: Id;
  readonly validator_binding_key: Hash;
  readonly limits: RunBudget;
  readonly budget_view: BudgetScopePolicyView;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Every distinct profile key currently persisted, ascending. */
function persistedProfileKeys(connection: SqliteConnection): readonly string[] {
  const rows = connection
    .prepare<{ profile_key: string }>(
      "SELECT DISTINCT profile_key FROM evd_service_profile ORDER BY profile_key ASC"
    )
    .all();
  return rows.map((row) => row.profile_key);
}

/**
 * Reads the latest row for one profile key. The reader validates the physical
 * row and parses `body_json`; a malformed row is a typed error, never skipped,
 * because skipping a persisted profile would silently change selection. The
 * returned row keeps the acceptance/production columns of the same version as
 * its body, so selection never mixes two versions.
 */
async function readLatestProfile(
  binding: EvidenceBindingReadPort,
  profileKey: string
): Promise<Result<EvdServiceProfileRow, ErrorEnvelope>> {
  const read = await binding.readServiceProfile({ profile_key: profileKey as Hash });
  if (!read.ok) return read;
  if (read.value === null) {
    return err(stateRowError(`evd.service_profile[${profileKey}]`, "row_missing_after_key_scan"));
  }
  return ok(read.value);
}

function validateCapability(
  rowKey: Hash,
  capability: SemanticBackendCapability
): Result<{ backend: SemanticBackendRef; capability: SemanticBackendCapability }, ErrorEnvelope> {
  if (capability.schema_version !== "rsi.semantic_backend_capability/1") {
    return err(stateRowError("evd.service_profile.body_json.schema_version", "semantic_backend_capability/1"));
  }
  if (rowKey !== capability.capability_key) {
    return err(
      versionError("evd.service_profile.profile_key", capability.capability_key, rowKey)
    );
  }
  const scopeKey = semanticScopeKey(capability.scope);
  const backendKey = semanticBackendKey({
    backend_kind: capability.backend_kind,
    implementation_id: capability.implementation_id,
    implementation_version: capability.implementation_version,
    method: capability.method,
    scope_key: scopeKey
  });
  if (backendKey !== capability.backend_key) {
    return err(
      versionError("evd.service_profile.body_json.backend_key", backendKey, capability.backend_key)
    );
  }
  if (semanticLimitsHash(capability.limits) !== capability.limits.limits_hash) {
    return err(
      versionError(
        "evd.service_profile.body_json.limits.limits_hash",
        semanticLimitsHash(capability.limits),
        capability.limits.limits_hash
      )
    );
  }
  const capabilityKey = semanticCapabilityKey(capability);
  if (capabilityKey !== capability.capability_key) {
    return err(
      versionError("evd.service_profile.body_json.capability_key", capabilityKey, capability.capability_key)
    );
  }
  const capabilityHash = semanticCapabilityHash(capability);
  if (capabilityHash !== capability.capability_hash) {
    return err(
      versionError(
        "evd.service_profile.body_json.capability_hash",
        capabilityHash,
        capability.capability_hash
      )
    );
  }
  return ok({
    backend: {
      schema_version: "rsi.semantic_backend_ref/1",
      backend_key: capability.backend_key,
      backend_kind: capability.backend_kind,
      method: capability.method,
      scope_key: scopeKey,
      capability_key: capability.capability_key,
      capability_hash: capability.capability_hash
    },
    capability
  });
}

function validateJevProfile(
  rowKey: Hash,
  rowAcceptance: "eligible" | "shadow_only" | "blocked",
  rowProductionUse: boolean,
  profile: JevServiceProfile
): Result<JevServiceProfile, ErrorEnvelope> {
  if (profile.schema_version !== "rsi.jev_service_profile/1") {
    return err(stateRowError("evd.service_profile.body_json.schema_version", "jev_service_profile/1"));
  }
  if (profile.profile_key !== rowKey) {
    return err(versionError("evd.service_profile.profile_key", profile.profile_key, rowKey));
  }
  const limitsHash = jevLimitsHash(profile.limits);
  if (limitsHash !== profile.limits.limits_hash) {
    return err(
      versionError(
        "evd.service_profile.body_json.limits.limits_hash",
        limitsHash,
        profile.limits.limits_hash
      )
    );
  }
  const profileKey = jevProfileKey({
    provider: profile.provider,
    base_url: profile.base_url,
    route: profile.route,
    endpoint_contract_version: profile.endpoint_contract_version,
    requested_model: profile.requested_model,
    expected_returned_model: profile.expected_returned_model,
    model_kind: profile.model_kind,
    response_schema_version: profile.response_schema_version,
    limits_hash: limitsHash,
    long_context: profile.long_context,
    official_precision_policy: profile.official_precision_policy,
    precision_contract: profile.precision_contract
  });
  if (profileKey !== profile.profile_key) {
    return err(versionError("evd.service_profile.body_json.profile_key", profileKey, profile.profile_key));
  }
  if (rowAcceptance !== profile.acceptance.status) {
    return err(
      versionError(
        "evd.service_profile.acceptance_status",
        profile.acceptance.status,
        rowAcceptance
      )
    );
  }
  if (profile.acceptance.status === "blocked") {
    return err(profileBlocked("evd.service_profile.jev.acceptance.status", "blocked"));
  }
  if (!profile.production_use || !rowProductionUse) {
    return err(profileBlocked("evd.service_profile.jev.production_use", "false"));
  }
  if (
    profile.limits.request_max_tokens === null ||
    profile.limits.question_max_tokens === null ||
    profile.limits.source === "unknown"
  ) {
    return err(profileBlocked("evd.service_profile.jev.limits", "limits_unknown"));
  }
  return ok(profile);
}

function runBudgetOf(view: BudgetScopePolicyView): RunBudget {
  const scope = view.scope;
  return {
    request_max_tokens: scope.request_max_tokens,
    question_max_tokens: scope.question_max_tokens,
    request_margin_tokens: scope.request_margin_tokens,
    question_margin_tokens: scope.question_margin_tokens,
    max_attempts: scope.max_attempts,
    // `RunBudget` has no `wall_ms`; the judge scope's wall allowance is the
    // only persisted deadline fact. No reserve/min-work defaulting is done.
    deadline_ms: scope.wall_ms,
    max_cost_micros: scope.max_cost_micros
  };
}

function asTx(connection: SqliteConnection): Tx {
  return {
    prepare: ((sql: string) => connection.prepare(sql)) as unknown as Tx["prepare"],
    exec: (sql: string) => connection.exec(sql)
  };
}

/** Reads the active `bpol/1` judge scope; absence is not mapped to defaults. */
export function readDefaultJudgeBudget(
  connection: SqliteConnection
): Result<{ view: BudgetScopePolicyView; limits: RunBudget }, ErrorEnvelope> {
  const read = readBudgetScopeInTransaction(asTx(connection), {
    budget_policy_ref: "budget://default",
    purpose: "judge"
  });
  if (!read.ok) {
    return err({ ...read.error, stage: BUDGET_STAGE });
  }
  return ok({ view: read.value, limits: runBudgetOf(read.value) });
}

/**
 * Resolves the single persisted backend profile and its validator row.
 *
 * The capability row is authoritative for the backend reference. A Jev typed
 * backend additionally needs its model/wire profile; `local_classifier` and
 * `other` use the capability body itself as `EvdPipelineDeps.service_profile`.
 */
export async function resolveDefaultEvidenceBinding(
  connection: SqliteConnection,
  binding: EvidenceBindingReadPort
): Promise<Result<ResolvedEvidenceBinding, ErrorEnvelope>> {
  const keys = persistedProfileKeys(connection);
  if (keys.length === 0) {
    return err(evidenceUnknown("evd.service_profile", "no_persisted_row"));
  }

  const capabilities: Array<{ key: Hash; value: SemanticBackendCapability }> = [];
  const jevProfiles: Array<{
    key: Hash;
    acceptance: "eligible" | "shadow_only" | "blocked";
    production_use: boolean;
    value: JevServiceProfile;
  }> = [];

  for (const key of keys) {
    const latest = await readLatestProfile(binding, key);
    if (!latest.ok) return latest;
    const row = latest.value;
    if (row.body_json.schema_version === "rsi.semantic_backend_capability/1") {
      capabilities.push({ key: key as Hash, value: row.body_json });
    } else if (row.body_json.schema_version === "rsi.jev_service_profile/1") {
      jevProfiles.push({
        key: key as Hash,
        acceptance: row.acceptance_status,
        production_use: row.production_use,
        value: row.body_json
      });
    } else {
      return err(
        stateRowError(`evd.service_profile[${key}].body_json.schema_version`, "known_profile_schema")
      );
    }
  }

  if (capabilities.length === 0) {
    return err(evidenceUnknown("evd.service_profile.capability", "capability_row_missing"));
  }
  if (capabilities.length > 1) {
    return err(
      evidenceUnknown(
        "evd.service_profile.profile_key",
        `ambiguous_capability_profile_keys:${sortedUnique(capabilities.map((entry) => entry.key)).join(",")}`
      )
    );
  }
  const capabilityEntry = capabilities[0];
  if (capabilityEntry === undefined) {
    return err(evidenceUnknown("evd.service_profile.capability", "capability_row_missing"));
  }
  const checked = checkedBody(
    `evd.service_profile[${capabilityEntry.key}].body_json`,
    () => validateCapability(capabilityEntry.key, capabilityEntry.value)
  );
  if (!checked.ok) return checked;
  const capability = checked.value.capability;

  let serviceProfile: JevServiceProfile | SemanticBackendCapability = capability;
  let serviceProfileKey: Hash = capability.capability_key;
  if (capability.backend_kind === "jev_typed") {
    if (jevProfiles.length === 0) {
      return err(evidenceUnknown("evd.service_profile.jev", "jev_profile_row_missing"));
    }
    if (jevProfiles.length > 1) {
      return err(
        evidenceUnknown(
          "evd.service_profile.jev.profile_key",
          `ambiguous_jev_profile_keys:${sortedUnique(jevProfiles.map((entry) => entry.key)).join(",")}`
        )
      );
    }
    const entry = jevProfiles[0];
    if (entry === undefined) {
      return err(evidenceUnknown("evd.service_profile.jev", "jev_profile_row_missing"));
    }
    const profile = checkedBody(
      `evd.service_profile[${entry.key}].body_json`,
      () => validateJevProfile(entry.key, entry.acceptance, entry.production_use, entry.value)
    );
    if (!profile.ok) return profile;
    serviceProfile = profile.value;
    serviceProfileKey = profile.value.profile_key;
  }

  const policyHash = semanticPolicyHash();
  const contractHash = semanticContractHash();
  const validatorBindingKey = semanticValidatorBindingKey({
    backend_key: capability.backend_key,
    capability_key: capability.capability_key,
    capability_hash: capability.capability_hash,
    policy_hash: policyHash,
    contract_hash: contractHash
  });
  const validatorRead = await binding.readValidatorBinding({
    validator_binding_key: validatorBindingKey
  });
  if (!validatorRead.ok) return validatorRead;
  const validatorRow = validatorRead.value;
  if (validatorRow === null) {
    return err(
      makeErrorEnvelope({
        code: "E_VALIDATOR_BINDING_MISSING",
        category: "not_found",
        message_key: "error.not_found",
        stage: PROFILE_STAGE,
        retryable: false,
        side_effect: "none",
        details: {
          kind: "field",
          path: "evd.validator_binding.validator_binding_key",
          rule: validatorBindingKey
        }
      })
    );
  }
  const validator = validatorRow.body_json;
  if (validator.schema_version !== "rsi.semantic_validation_binding/1") {
    return err(
      stateRowError(
        "evd.validator_binding.body_json.schema_version",
        "rsi.semantic_validation_binding/1"
      )
    );
  }
  const validatorChecks: Array<[string, string, string]> = [
    ["evd.validator_binding.validator_binding_key", validatorBindingKey, validatorRow.validator_binding_key],
    ["evd.validator_binding.validator_policy_hash", policyHash, validatorRow.validator_policy_hash],
    ["evd.validator_binding.service_profile_key", capability.capability_key, validatorRow.service_profile_key],
    ["evd.validator_binding.body_json.validator_binding_id", validatorRow.validator_binding_id, validator.validator_binding_id],
    ["evd.validator_binding.body_json.validator_binding_key", validatorBindingKey, validator.validator_binding_key],
    ["evd.validator_binding.body_json.backend_key", capability.backend_key, validator.backend_key],
    ["evd.validator_binding.body_json.capability_key", capability.capability_key, validator.capability_key],
    ["evd.validator_binding.body_json.capability_hash", capability.capability_hash, validator.capability_hash],
    ["evd.validator_binding.body_json.policy_hash", policyHash, validator.policy_hash],
    ["evd.validator_binding.body_json.contract_hash", contractHash, validator.contract_hash]
  ];
  for (const [path, expected, actual] of validatorChecks) {
    if (expected !== actual) {
      return err(versionError(path, expected, actual));
    }
  }

  const budget = readDefaultJudgeBudget(connection);
  if (!budget.ok) return budget;

  return ok({
    backend: checked.value.backend,
    service_profile: serviceProfile,
    service_profile_key: serviceProfileKey,
    validator_binding_id: validatorRow.validator_binding_id,
    validator_binding_key: validatorBindingKey,
    limits: budget.value.limits,
    budget_view: budget.value.view
  });
}

/* ------------------------------------------------------------------ */
/* Explicit Jev transport composition                                  */
/* ------------------------------------------------------------------ */

/**
 * Host-owned transport primitives. Every field must be injected explicitly;
 * the bootstrap never reads environment variables, keychains, cc-switch or a
 * provider default. A partial object remains a typed blocked state.
 */
export interface JevTransportInjection {
  readonly credentials?: CredentialReferenceResolver;
  readonly http?: SemanticHttpExecutor;
  readonly allowed_hosts?: readonly string[];
}

export type JevTransportCompositionBlockedReason =
  | "credential_resolver_unavailable"
  | "http_executor_unavailable"
  | "endpoint_authorization_unavailable"
  | "profile_binding_unresolved"
  | "backend_not_jev_typed";

export type JevTransportCompositionResult =
  | {
      readonly status: "composed";
      readonly transport: SemanticBackendPort;
      readonly resolved: ResolvedEvidenceBinding;
    }
  | {
      readonly status: "blocked";
      readonly reason: JevTransportCompositionBlockedReason;
      readonly detail: string;
      readonly error: ErrorEnvelope | null;
    };

function hasCredentialResolver(
  value: JevTransportInjection["credentials"]
): value is CredentialReferenceResolver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { resolve?: unknown }).resolve === "function"
  );
}

function hasHttpExecutor(
  value: JevTransportInjection["http"]
): value is SemanticHttpExecutor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { request?: unknown }).request === "function"
  );
}

function hasAllowedHosts(value: JevTransportInjection["allowed_hosts"]): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((host) => typeof host === "string" && host.length > 0)
  );
}

/**
 * Exact dispatch identity of one resolved binding.
 *
 * The online path resolves profile/capability/validator per event while a
 * composed transport is built once. Comparing these existing canonical keys
 * and frozen profile fields before every dispatch prevents the transport from
 * sending a request to the startup route or credential reference after the
 * persisted selection changed.
 */
interface JevDispatchIdentity {
  readonly profile_key: string;
  readonly profile_id: string;
  readonly profile_version: number;
  readonly provider: string;
  readonly base_url: string;
  readonly route: string;
  readonly requested_model: string;
  readonly expected_returned_model: string;
  readonly credential_ref: string;
  readonly acceptance: string;
  readonly production_use: boolean;
  readonly backend_key: string;
  readonly backend_kind: string;
  readonly method_schema_version: string;
  readonly method_id: string;
  readonly method_version: string;
  readonly rule_version: string;
  readonly scope_key: string;
  readonly capability_key: string;
  readonly capability_hash: string;
  readonly validator_binding_id: string;
  readonly validator_binding_key: string;
  readonly budget_policy_ref: string;
  readonly budget_policy_version: string;
  readonly budget_content_hash: string;
}

function dispatchIdentity(resolved: ResolvedEvidenceBinding): JevDispatchIdentity | null {
  const profile = resolved.service_profile;
  if (profile.schema_version !== "rsi.jev_service_profile/1") return null;
  return {
    profile_key: resolved.service_profile_key,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    provider: profile.provider,
    base_url: profile.base_url,
    route: profile.route,
    requested_model: profile.requested_model,
    expected_returned_model: profile.expected_returned_model,
    credential_ref: profile.credential_ref,
    acceptance: profile.acceptance.status,
    production_use: profile.production_use,
    backend_key: resolved.backend.backend_key,
    backend_kind: resolved.backend.backend_kind,
    method_schema_version: resolved.backend.method.schema_version,
    method_id: resolved.backend.method.method_id,
    method_version: resolved.backend.method.method_version,
    rule_version: resolved.backend.method.rule_version,
    scope_key: resolved.backend.scope_key,
    capability_key: resolved.backend.capability_key,
    capability_hash: resolved.backend.capability_hash,
    validator_binding_id: resolved.validator_binding_id,
    validator_binding_key: resolved.validator_binding_key,
    budget_policy_ref: resolved.budget_view.budget_policy_ref,
    budget_policy_version: resolved.budget_view.budget_policy_version,
    budget_content_hash: resolved.budget_view.content_hash
  };
}

function sameDispatchIdentity(
  expected: JevDispatchIdentity,
  observed: JevDispatchIdentity
): boolean {
  return (Object.keys(expected) as Array<keyof JevDispatchIdentity>).every(
    (key) => expected[key] === observed[key]
  );
}

function bindingDriftOutcome(): SemanticBackendTransportOutcome {
  return {
    status: "transport_error",
    error_code: "E_SEMANTIC_BINDING_CHANGED",
    retryable: false,
    received_at: Date.now()
  };
}

/**
 * Wraps the concrete transport so every dispatch re-resolves the persisted
 * binding and compares it with the startup selection. A missing, ambiguous or
 * changed profile/capability/validator rejects before credentials or HTTP;
 * there is no hot reload.
 */
function guardComposedTransport(input: {
  readonly connection: SqliteConnection;
  readonly binding: EvidenceBindingReadPort;
  readonly transport: SemanticBackendPort;
  readonly expected: JevDispatchIdentity;
}): SemanticBackendPort {
  return {
    async invoke(invocation) {
      if (invocation.signal.aborted) {
        return { status: "cancelled", received_at: Date.now() };
      }
      let current: Result<ResolvedEvidenceBinding, ErrorEnvelope>;
      try {
        current = await resolveDefaultEvidenceBinding(input.connection, input.binding);
      } catch {
        return bindingDriftOutcome();
      }
      if (invocation.signal.aborted) {
        return { status: "cancelled", received_at: Date.now() };
      }
      if (!current.ok) return bindingDriftOutcome();
      const observed = dispatchIdentity(current.value);
      if (observed === null || !sameDispatchIdentity(input.expected, observed)) {
        return bindingDriftOutcome();
      }
      return input.transport.invoke(invocation);
    }
  };
}

/**
 * Applies the same persisted binding fence to a caller-owned transport. Direct
 * injection supplies the execution primitive, while the kernel still owns the
 * identity selected from capability/profile/validator/budget rows.
 */
export async function guardInjectedJevTransport(input: {
  readonly connection: SqliteConnection;
  readonly binding: EvidenceBindingReadPort;
  readonly transport: SemanticBackendPort;
}): Promise<
  | { readonly status: "guarded"; readonly transport: SemanticBackendPort; readonly resolved: ResolvedEvidenceBinding }
  | { readonly status: "blocked"; readonly error: ErrorEnvelope }
> {
  const resolved = await resolveDefaultEvidenceBinding(input.connection, input.binding);
  if (!resolved.ok) {
    return { status: "blocked", error: resolved.error };
  }
  const expected = dispatchIdentity(resolved.value);
  if (expected === null) {
    return {
      status: "blocked",
      error: makeErrorEnvelope({
        code: "E_CAPABILITY",
        category: "internal",
        retryable: false,
        side_effect: "none",
        message_key: "error.evidence.profile_binding_not_jev_typed",
        stage: "evidence_profile",
        details: { kind: "none" }
      })
    };
  }
  return {
    status: "guarded",
    transport: guardComposedTransport({
      connection: input.connection,
      binding: input.binding,
      transport: input.transport,
      expected
    }),
    resolved: resolved.value
  };
}

/**
 * Composes the concrete Jev transport from the single persisted binding.
 *
 * Selection (capability, Jev profile, validator, judge budget) is delegated to
 * `resolveDefaultEvidenceBinding`, so missing or ambiguous persisted rows keep
 * their existing typed envelopes. This helper only accepts explicitly injected
 * credential/HTTP/endpoint-authorization primitives and never provisions them.
 */
export async function composeDefaultJevTransport(input: {
  readonly connection: SqliteConnection;
  readonly binding: EvidenceBindingReadPort;
  readonly injection: JevTransportInjection;
}): Promise<JevTransportCompositionResult> {
  const { injection } = input;
  if (!hasCredentialResolver(injection.credentials)) {
    return {
      status: "blocked",
      reason: "credential_resolver_unavailable",
      detail: "No host-injected credential resolver was supplied; Jev dispatch stays blocked.",
      error: null
    };
  }
  if (!hasHttpExecutor(injection.http)) {
    return {
      status: "blocked",
      reason: "http_executor_unavailable",
      detail: "No host-controlled HTTP executor was supplied; Jev dispatch stays blocked.",
      error: null
    };
  }
  if (!hasAllowedHosts(injection.allowed_hosts)) {
    return {
      status: "blocked",
      reason: "endpoint_authorization_unavailable",
      detail: "No explicit non-empty allowed_hosts authorization was supplied; Jev dispatch stays blocked.",
      error: null
    };
  }

  const resolved = await resolveDefaultEvidenceBinding(input.connection, input.binding);
  if (!resolved.ok) {
    return {
      status: "blocked",
      reason: "profile_binding_unresolved",
      detail: `The persisted Jev binding could not be resolved (${resolved.error.code}).`,
      error: resolved.error
    };
  }
  const binding = resolved.value;
  if (
    binding.backend.backend_kind !== "jev_typed" ||
    binding.service_profile.schema_version !== "rsi.jev_service_profile/1"
  ) {
    return {
      status: "blocked",
      reason: "backend_not_jev_typed",
      detail: "The resolved backend is not a Jev typed backend; no Jev transport was composed.",
      error: null
    };
  }

  const expected = dispatchIdentity(binding);
  if (expected === null) {
    return {
      status: "blocked",
      reason: "backend_not_jev_typed",
      detail: "The resolved service profile is not a Jev profile; no Jev transport was composed.",
      error: null
    };
  }
  const transport = createSemanticBackendTransport({
    profile: binding.service_profile,
    credentials: injection.credentials,
    http: injection.http,
    allowed_hosts: injection.allowed_hosts
  });
  return {
    status: "composed",
    transport: guardComposedTransport({
      connection: input.connection,
      binding: input.binding,
      transport,
      expected
    }),
    resolved: binding
  };
}

/* ------------------------------------------------------------------ */
/* Decision input and delivery preparation gates                       */
/* ------------------------------------------------------------------ */

/** Builds the versioned, binding-scoped DecisionInputs preimages. */
export function createDefaultDecisionInputsPort(): DecisionInputsPipelinePort {
  return {
    async read(input) {
      const prepared = prepareDecisionInputs(input);
      return prepared.ok
        ? prepared
        : err({ ...prepared.error, stage: DECISION_STAGE });
    }
  };
}

/**
 * Wraps delivery create/enqueue and performs the durable content freeze before
 * row creation. A TTL is an explicit composition input; without one this
 * boundary remains blocked rather than inventing expiry semantics. The legacy
 * `expiry_ms` option is the wall-clock-only form of the same policy.
 */
export function createDefaultDeliveryPort(
  delivery: DefaultDeliveryCreateEnqueuePort,
  options?: {
    readonly blob_store?: BlobStore;
    readonly now?: () => number;
    readonly expiry_ms?: number;
    readonly ttl?: DeliveryTtlPolicy;
    readonly next_input_epoch_at?: number | null | (() => number | null | undefined);
  }
): DeliveryPipelinePort {
  return {
    async prepare(input) {
      const policy = resolveDeliveryTtlPolicy(options);
      if (options?.blob_store === undefined || options.now === undefined || policy === undefined) {
        return err(evidenceUnknown("DeliveryPipelinePort.prepare", "preparation_rules_undefined", DELIVERY_STAGE));
      }
      const now = options.now();
      let suppliedNext: number | null | undefined;
      try {
        suppliedNext =
          typeof options.next_input_epoch_at === "function"
            ? options.next_input_epoch_at()
            : options.next_input_epoch_at;
      } catch {
        return err(
          evidenceUnknown(
            "DeliveryPipelinePort.prepare.next_input_epoch_at",
            "provider_failed",
            DELIVERY_STAGE
          )
        );
      }
      const nextInputEpochAt =
        suppliedNext === undefined ? policy.next_input_epoch_at : (suppliedNext ?? undefined);
      const expires = computeDeliveryExpiresAt(now, {
        ttl_ms: policy.ttl_ms,
        ...(nextInputEpochAt === undefined ? {} : { next_input_epoch_at: nextInputEpochAt })
      });
      if (!expires.ok) return err({ ...expires.error, stage: DELIVERY_STAGE });
      const prepared = prepareDeliveryProjection({
        event: input.event,
        issue: input.issue,
        aggregate: input.aggregate,
        pack: input.pack,
        now,
        expires_at: expires.value
      });
      if (!prepared.ok) return err({ ...prepared.error, stage: DELIVERY_STAGE });
      const preparedDeliveryId = prepared.value.content.delivery_id;
      if (preparedDeliveryId === undefined) {
        return err(evidenceUnknown("DeliveryPipelinePort.prepare.delivery_id", "missing", DELIVERY_STAGE));
      }
      const stored = await options.blob_store.put(prepared.value.content_bytes);
      if (!stored.ok) return err(stored.error);
      const verified = options.blob_store.verify(prepared.value.plan.content_hash);
      if (!verified.ok || !verified.value.present || !verified.value.hash_matches) {
        return err(evidenceUnknown("DeliveryPipelinePort.prepare.content_ref", "blob_verification_failed", DELIVERY_STAGE));
      }
      return ok({
        plan: prepared.value.plan,
        content: {
          retrievable: true,
          hash_matches: true,
          delivery_id: preparedDeliveryId,
          content_bytes: prepared.value.content_bytes
        },
        outbox: prepared.value.outbox
      });
    },
    create: (input) => delivery.create(input),
    enqueue: (outbox) => delivery.enqueue(outbox)
  };
}

/** Explicit policy precedence: `ttl` > legacy `expiry_ms`; neither is blocked. */
function resolveDeliveryTtlPolicy(options?: {
  readonly expiry_ms?: number;
  readonly ttl?: DeliveryTtlPolicy;
}): DeliveryTtlPolicy | undefined {
  if (options?.ttl !== undefined) {
    return options.ttl;
  }
  if (options?.expiry_ms !== undefined) {
    return { ttl_ms: options.expiry_ms };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

function downstreamDeps(input: {
  readonly resolved: ResolvedEvidenceBinding;
  readonly now: () => number;
  readonly clock: Clock;
  readonly qp: QpPipelineDeps;
  readonly plans: EvidencePlanReadPort;
  readonly planStates: PlanReadPort;
  readonly issues: EvidenceIssueReadPort;
  readonly binding: EvidenceBindingReadPort;
  readonly writer: EvdPipelineDeps["writer"];
  readonly reader: DefaultEvidenceReader;
  readonly aggregator: AnswerAggregator;
  readonly jev_transport: SemanticBackendPort | undefined;
  readonly decision: DecisionRecordPort;
  readonly delivery: DeliveryPipelinePort;
  readonly dispatch?: DispatchPipelineOptions;
  readonly evidence_supplement?: SupplementPipelineOptions;
}): OnlineDownstreamDeps {
  return {
    now: input.now,
    clock: input.clock,
    qp: input.qp,
    evd: {
      plans: input.plans,
      plan_lifecycle: input.planStates,
      issues: input.issues,
      binding: input.binding,
      writer: input.writer,
      backend: input.resolved.backend,
      service_profile: input.resolved.service_profile,
      service_profile_key: input.resolved.service_profile_key,
      validator_binding_id: input.resolved.validator_binding_id,
      validator_binding_key: input.resolved.validator_binding_key,
      limits: input.resolved.limits
    },
    // The persisted Jev binding and validator are resolved above. `late` is
    // the durable attempt reader; without an explicitly composed or injected
    // transport the tail fails closed at `jev_dispatch` with `E_CAPABILITY`.
    jev: {
      ...(input.jev_transport === undefined ? {} : { backend: input.jev_transport }),
      late: input.reader,
      next_attempt_no: (bindingId) => input.reader.next_attempt_no(bindingId),
      budget: input.resolved.limits
    },
    aggregator: input.aggregator,
    ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
    ...(input.evidence_supplement === undefined ? {} : { evidence_supplement: input.evidence_supplement }),
    decision: input.decision,
    decision_inputs: createDefaultDecisionInputsPort(),
    delivery: input.delivery,
    on_diagnostic: () => undefined
  };
}

export function createDefaultEvidenceComposition(
  deps: DefaultEvidenceCompositionDeps
): DefaultEvidenceComposition {
  const defaultClock = deps.clock ?? systemClock;
  const writer = createDefaultEvidenceWriter({
    connection: deps.connection,
    writer: deps.journal,
    relative_path: deps.journal_relative_path,
    blob_store: deps.blob_store,
    now: deps.now
  });
  const reader = createDefaultEvidenceReader({
    connection: deps.connection,
    read_connection: deps.read_connection,
    blobs: deps.blob_store,
    writer: writer.writer
  });
  const binding = createEvidenceBindingReadPort({
    connection: deps.connection,
    blobs: deps.blob_store,
    ...(deps.source_refs === undefined ? {} : { sources: deps.source_refs })
  });

  return {
    writer,
    reader,
    binding,
    async runDownstream(input) {
      const resolved = await resolveDefaultEvidenceBinding(deps.connection, binding);
      if (!resolved.ok) return resolved;

      const evidencePorts = createDefaultQuestionEvidencePorts({
        plans: input.plans_repository,
        issues: input.issues_repository
      });
      const aggregator = createAnswerAggregator({
        plans: evidencePorts.plan_states,
        state: reader,
        envelopes: reader,
        now: deps.now
      });

      const admitted: OnlinePipelineOutcome = {
        ...input.admitted,
        stages: [...input.admitted.stages, ...input.qp.stages],
        issues: input.qp.issues,
        plans: input.qp.plans,
        diagnostics: [...input.admitted.diagnostics, ...input.qp.diagnostics]
      };
      const downstream = downstreamDeps({
        resolved: resolved.value,
        now: deps.now,
        clock: input.clock ?? defaultClock,
        qp: input.qp_deps,
        plans: evidencePorts.plans,
        planStates: evidencePorts.plan_states,
        issues: evidencePorts.issues,
        binding,
        writer: writer.writer,
        reader,
        aggregator,
        jev_transport: deps.jev_transport,
        ...(deps.dispatch === undefined ? {} : { dispatch: deps.dispatch }),
        ...(deps.evidence_supplement === undefined ? {} : { evidence_supplement: deps.evidence_supplement }),
        decision: input.decision,
        delivery: createDefaultDeliveryPort(input.delivery, {
          blob_store: deps.blob_store,
          now: deps.now,
          ...(deps.delivery_ttl === undefined ? {} : { ttl: deps.delivery_ttl }),
          ...(deps.delivery_expiry_ms === undefined ? {} : { expiry_ms: deps.delivery_expiry_ms }),
          ...(deps.delivery_next_input_epoch_at === undefined
            ? {}
            : { next_input_epoch_at: deps.delivery_next_input_epoch_at })
        })
      });
      return runOnlineDownstream(
        downstream,
        input.event,
        {
          admitted,
          qp: {
            issues: input.qp.issues,
            plans: input.qp.plans,
            plan_states: input.qp.plan_states
          }
        },
        input.signal === undefined ? {} : { signal: input.signal }
      );
    }
  };
}
