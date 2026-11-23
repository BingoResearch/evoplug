/**
 * Judge gateway (DD-EVD-021, DD-EVD-020A).
 *
 * The gateway freezes the semantic request, maps transport outcomes onto the
 * attempt state machine, validates categorical output after a 2xx response and
 * builds `JudgeEnvelope/3`. It never retries on its own, never switches
 * backends and never writes delivery, issue or task outcomes.
 */

import { err, newId, ok, systemClock, type Clock, type ErrorEnvelope, type Id, type Result, type SourceRef, type VersionBinding } from "@evoplug/core";

import { evdError, evdForwarded, evdOk } from "./errors.js";
import {
  adapterContractHash,
  envelopeHashV3,
  envelopeKeyV3,
  jcsHash,
  jevValidatorBindingKey,
  jevValidatorPolicyHash,
  semanticContractHash,
  semanticPolicyHash,
  sortUtf8Strings,
} from "./hashing.js";
import {
  semanticOutputInvalidError,
  validateCategoricalOutput,
  validateTypedWire,
  type CategoricalValidationFailure,
  type TypedValidationResult,
} from "./jev-validator.js";
import type {
  AttemptUsageObservation,
  EvdError,
  JevAdapterEvidence,
  JudgeAttemptResult,
  JudgeAttemptV2,
  JudgeEnvelopeV3,
  JudgeGateway,
  JudgeRequestBindingV3,
  JevServiceProfile,
  LateJudgeResultV2,
  LateResultReceipt,
  LateResultSubmissionV2,
  LiveCommitOutcome,
  RunBudget,
  SemanticBackendPort,
  SemanticOutcome,
  SemanticUsageObservation,
} from "./types.js";

export interface GatewayLateStore {
  readAttempt(attempt_id: string): Promise<Result<JudgeAttemptV2 | null, ErrorEnvelope>>;
  readLateResults(attempt_id: string): Promise<Result<LateJudgeResultV2[], ErrorEnvelope>>;
  commitLate(input: { late: LateJudgeResultV2 }): Promise<import("./types.js").LiveCommitOutcome<null>>;
}

/**
 * Durable attempt persistence used by a production dispatch.
 *
 * DD-EVD-025: `prepare` must commit the `prepared` row before `markSending`,
 * and `markSending` must commit `sending` before the backend is invoked. The
 * gateway calls these hooks synchronously with its own state transitions; a
 * missing hook keeps the pure in-memory gateway used by unit tests.
 */
export interface GatewayAttemptPersistence {
  prepare(input: {
    binding: VersionBinding;
    attempt: JudgeAttemptV2;
  }): Promise<LiveCommitOutcome<null>>;
  markSending(input: {
    binding: VersionBinding;
    attempt_id: Id;
    expected_row_version: number;
  }): Promise<LiveCommitOutcome<null>>;
  commitResponse(input: {
    binding: VersionBinding;
    attempt_id: Id;
    expected_row_version: number;
    envelope: JudgeEnvelopeV3;
    terminal_state: "accepted" | "degraded";
  }): Promise<LiveCommitOutcome<null>>;
  commitTerminal(input: {
    binding: VersionBinding;
    attempt_id: Id;
    expected_row_version: number;
    attempt: JudgeAttemptV2;
  }): Promise<LiveCommitOutcome<null>>;
}

export interface JudgeGatewayDeps {
  backend: SemanticBackendPort;
  late: GatewayLateStore;
  /** Wall-clock source for persisted `*_at` fields only. */
  now: () => number;
  /**
   * Clock for attempt deadlines and elapsed measurement. Deadlines live on
   * this clock's monotonic timeline, so wall-clock jumps cannot move a
   * budget. Defaults to the shared production `systemClock`; callers that
   * inject a fake `now` should inject the matching fake clock here.
   */
  clock?: Clock;
  next_attempt_no: (binding_id: string) => number;
  /**
   * Durable attempt hooks. When absent the gateway stays the pure,
   * side-effect-free dispatcher used by the in-memory tests.
   */
  attempts?: GatewayAttemptPersistence;
  /**
   * Jev service profile the dispatch is bound to. DD-EVD-016A/021: the
   * `/3` request binding keeps the semantic validator key, while the Jev
   * `ValidatorBinding/1` key derived from this profile is referenced only by
   * `adapter_evidence.validator_binding_key` and
   * `adapter_evidence.jev_validation.validator_binding_key`.
   */
  jev_profile?: JevServiceProfile;
}

function emptyUsage(_now: number): SemanticUsageObservation {
  return {
    elapsed_ms: 0,
    cpu_ms: null,
    read_bytes: 0,
    retrieval_count: 0,
    model_invocations: 0,
    verifier_invocations: 0,
    input_tokens: null,
    output_tokens: null,
    cost_micros: null,
    cost_status: "unknown",
    usage_source: "none",
    receipt_ref: null,
  };
}

function attemptUsage(usage: SemanticUsageObservation): AttemptUsageObservation {
  return {
    elapsed_ms: usage.elapsed_ms,
    cpu_ms: usage.cpu_ms,
    read_bytes: usage.read_bytes,
    retrieval_count: usage.retrieval_count,
    model_invocations: usage.model_invocations,
    verifier_invocations: usage.verifier_invocations,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_micros: usage.cost_micros,
    cost_status: usage.cost_status,
    usage_source: usage.usage_source,
    receipt_key: null,
  };
}

function usageFromWire(wire: unknown, elapsedMs: number): SemanticUsageObservation {
  const usage = emptyUsage(0);
  usage.elapsed_ms = elapsedMs;
  usage.usage_source = "backend_reported";
  if (typeof wire === "object" && wire !== null && !Array.isArray(wire)) {
    const record = wire as Record<string, unknown>;
    const raw = record["usage"];
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const u = raw as Record<string, unknown>;
      const numberOrNull = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      usage.input_tokens = numberOrNull(u["input_tokens"]);
      usage.output_tokens = numberOrNull(u["output_tokens"]);
      usage.model_invocations = 1;
      const cost = numberOrNull(u["cost_micros"]);
      const status = u["cost_status"];
      if (status === "known" && cost !== null) {
        usage.cost_micros = cost;
        usage.cost_status = "known";
      } else if (status === "not_applicable") {
        usage.cost_status = "not_applicable";
      } else {
        usage.cost_status = "unknown";
      }
      return usage;
    }
  }
  usage.model_invocations = 1;
  return usage;
}

interface AdapterEvidenceHashInput {
  evidence: JevAdapterEvidence | null;
}

function adapterEvidenceProjection(input: AdapterEvidenceHashInput): unknown {
  const jev = input.evidence;
  return {
    schema_version: "rsi.adapter_evidence_hash/1",
    kind: jev?.kind ?? null,
    service_profile_key: jev?.service_profile_key ?? null,
    provider: jev?.provider ?? null,
    route: jev?.route ?? null,
    requested_model: jev?.requested_model ?? null,
    returned_model: jev?.returned_model ?? null,
    model_match: jev?.model_match ?? null,
    validator_version: jev?.validator_version ?? null,
    validator_binding_key: jev?.validator_binding_key ?? null,
    wire: jev === null ? null : { response_hash: jev.wire.response_hash, extra_keys_utf8: sortUtf8Strings(jev.wire.extra_keys) },
    typed_answers: jev?.typed_answers ?? null,
    applied_answers: jev?.applied_answers ?? null,
    typed_mapped_from: jev?.typed_mapped_from ?? null,
    jev_validation:
      jev === null
        ? null
        : {
            status: jev.jev_validation.status,
            policy_version: jev.jev_validation.policy_version,
            validator_binding_key: jev.jev_validation.validator_binding_key,
            errors_utf8: sortUtf8Strings(jev.jev_validation.errors),
            skipped_by_dependency_utf8: sortUtf8Strings(jev.jev_validation.skipped_by_dependency),
            primary_error: jev.jev_validation.primary_error,
            calibration_status: jev.jev_validation.calibration_status,
          },
    implementation_id: null,
    implementation_version: null,
    raw_output_hash: null,
    deterministic: null,
    process_isolated: null,
  };
}

function optionEffectsOf(binding: JudgeRequestBindingV3): Record<string, Record<string, "supports" | "contradicts" | "unknown">> {
  const result: Record<string, Record<string, "supports" | "contradicts" | "unknown">> = {};
  for (const question of binding.question_bindings) {
    result[question.question_key] = question.option_effects;
  }
  return result;
}

function manifestRefsOf(binding: JudgeRequestBindingV3): SourceRef[] {
  const refs = new Set<SourceRef>();
  for (const entry of binding.request.evidence) {
    refs.add(entry.source_ref);
  }
  return sortUtf8Strings([...refs]) as SourceRef[];
}

function buildEnvelope(input: {
  binding: JudgeRequestBindingV3;
  attempt: JudgeAttemptV2;
  outcomes: Record<string, SemanticOutcome>;
  validationStatus: "accepted" | "degraded";
  errors: string[];
  skipped: string[];
  primary: string | null;
  perQuestion: Record<string, { status: "accepted" | "degraded" | "missing"; errors: string[] }>;
  adapterEvidence: JevAdapterEvidence | null;
  usage: SemanticUsageObservation;
  receivedAt: number;
}): JudgeEnvelopeV3 {
  const backend = input.binding.backend;
  const policyHash = semanticPolicyHash();
  const contractHash = semanticContractHash();
  const adapterEvidenceHash =
    input.adapterEvidence === null
      ? null
      : jcsHash(adapterEvidenceProjection({ evidence: input.adapterEvidence }));
  const envelopeHash = envelopeHashV3({
    request_hash: input.binding.request_hash,
    dispatch_key: input.binding.dispatch_key,
    shard_key: input.binding.shard_key,
    plan_hash: input.binding.plan_hash,
    pack_hash: input.binding.pack_hash,
    request_schema_version: "rsi.semantic_backend_request/1",
    backend,
    question_set_hash: input.binding.question_set_hash,
    question_bindings_digest: input.binding.question_bindings_digest,
    template_bindings: input.binding.template_bindings,
    semantic_outcomes: input.outcomes,
    validation: {
      status: input.validationStatus,
      policy_version: "rsi.semantic.validator/1",
      policy_hash: policyHash,
      validator_binding_key: input.binding.validator_binding_key,
      output_contract: "categorical_option/1",
      contract_hash: contractHash,
      errors: input.errors,
      skipped_by_dependency: input.skipped,
      primary_error: input.primary,
      per_question: input.perQuestion,
      calibration_status:
        input.validationStatus === "accepted" ? "eligible" : "invalidated",
    },
    adapter_evidence_hash: adapterEvidenceHash,
  });
  const envelopeKey = envelopeKeyV3({
    request_hash: input.binding.request_hash,
    dispatch_key: input.binding.dispatch_key,
    envelope_hash: envelopeHash,
    validator_binding_key: input.binding.validator_binding_key,
    capability_key: backend.capability_key,
  });
  return {
    schema_version: "rsi.judge_envelope/3",
    envelope_id: newId("env"),
    envelope_key: envelopeKey,
    binding_id: input.binding.binding_id,
    request_id: input.binding.request_id,
    request_hash: input.binding.request_hash,
    dispatch_key: input.binding.dispatch_key,
    shard_id: input.binding.shard_id,
    shard_key: input.binding.shard_key,
    shard_plan_id: input.binding.shard_plan_id,
    plan_id: input.binding.plan_id,
    plan_hash: input.binding.plan_hash,
    pack_id: input.binding.pack_id,
    pack_hash: input.binding.pack_hash,
    binding: input.binding.binding,
    backend,
    request_schema_version: "rsi.semantic_backend_request/1",
    question_set_hash: input.binding.question_set_hash,
    question_bindings_digest: input.binding.question_bindings_digest,
    template_bindings: input.binding.template_bindings,
    semantic_outcomes: input.outcomes,
    validation: {
      status: input.validationStatus,
      policy_version: "rsi.semantic.validator/1",
      policy_hash: policyHash,
      validator_binding_key: input.binding.validator_binding_key,
      output_contract: "categorical_option/1",
      contract_hash: contractHash,
      errors: sortUtf8Strings(input.errors),
      skipped_by_dependency: sortUtf8Strings(input.skipped),
      primary_error: input.primary,
      per_question: input.perQuestion,
      calibration_status:
        input.validationStatus === "accepted" ? "eligible" : "invalidated",
    },
    adapter_evidence: input.adapterEvidence,
    usage: input.usage,
    received_at: input.receivedAt,
    envelope_hash: envelopeHash,
  };
}

function allQuestionKeys(binding: JudgeRequestBindingV3): string[] {
  return sortUtf8Strings(binding.request.questions.map((question) => question.question_key));
}

/**
 * Maps a failed pre-send write to a dispatch result.
 *
 * `not_written` means the provider was never called and the previous durable
 * state still holds, so the caller may reject. `unknown_recovery_required`
 * means the row may already have moved; the result stays `unknown` so no
 * caller treats the attempt as safe to resend.
 */
function persistenceFailure(
  outcome: LiveCommitOutcome<null>,
  attempt: JudgeAttemptV2
): JudgeAttemptResult {
  if (outcome.ok) {
    return { status: "rejected", attempt, error: evdError("E_OUTCOME_UNKNOWN", {}) };
  }
  if (outcome.commit_state === "unknown_recovery_required") {
    attempt.state = "outcome_unknown";
    return { status: "unknown", attempt, error: evdError("E_OUTCOME_UNKNOWN", {}) };
  }
  return { status: "rejected", attempt, error: outcome.error as EvdError };
}

/** A terminal write failed after the request crossed the send point. */
function terminalCommitFailed(attempt: JudgeAttemptV2): JudgeAttemptResult {
  attempt.state = "outcome_unknown";
  return { status: "unknown", attempt, error: evdError("E_OUTCOME_UNKNOWN", {}) };
}

/**
 * Persists the terminal outcome after the backend call.
 *
 * The row is already `sending` (row_version 1), so every terminal transition
 * expects version 1. Accepted/degraded own an envelope row; transport errors,
 * timeouts, unknown outcomes and backend cancellations are envelope-free.
 */
async function persistAttemptResult(
  deps: JudgeGatewayDeps,
  binding: JudgeRequestBindingV3,
  attempt: JudgeAttemptV2,
  result: JudgeAttemptResult
): Promise<JudgeAttemptResult> {
  const persistence = deps.attempts;
  if (persistence === undefined) {
    return result;
  }
  if (result.status === "accepted" || result.status === "degraded") {
    const committed = await persistence.commitResponse({
      binding: binding.binding,
      attempt_id: attempt.attempt_id,
      expected_row_version: 1,
      envelope: result.envelope,
      terminal_state: result.status,
    });
    return committed.ok ? result : terminalCommitFailed(attempt);
  }
  if (result.status === "unknown" || result.status === "cancelled") {
    const committed = await persistence.commitTerminal({
      binding: binding.binding,
      attempt_id: attempt.attempt_id,
      expected_row_version: 1,
      attempt,
    });
    return committed.ok ? result : terminalCommitFailed(attempt);
  }
  return result;
}

export function createJudgeGateway(deps: JudgeGatewayDeps): JudgeGateway {
  return {
    async dispatch(
      binding: JudgeRequestBindingV3,
      budget: RunBudget,
      signal: AbortSignal
    ): Promise<JudgeAttemptResult> {
      if (signal.aborted) {
        if (deps.attempts === undefined) {
          const attempt = makeAttempt(binding, "cancelled", deps, "E_OUTCOME_UNKNOWN");
          return { status: "cancelled", attempt, error: evdError("E_OUTCOME_UNKNOWN", {}) };
        }
        // Pre-send cancellation still gets a durable `prepared` row before
        // the lifecycle moves to `cancelled` (DD-EVD-021).
        const attempt = makeAttempt(binding, "prepared", deps, "E_OUTCOME_UNKNOWN");
        const prepared = await deps.attempts.prepare({
          binding: binding.binding,
          attempt,
        });
        if (!prepared.ok) {
          return persistenceFailure(prepared, attempt);
        }
        attempt.state = "cancelled";
        attempt.finished_at = deps.now();
        const committed = await deps.attempts.commitTerminal({
          binding: binding.binding,
          attempt_id: attempt.attempt_id,
          expected_row_version: 0,
          attempt,
        });
        if (!committed.ok) {
          return persistenceFailure(committed, attempt);
        }
        return { status: "cancelled", attempt, error: evdError("E_OUTCOME_UNKNOWN", {}) };
      }
      if (budget.execution_mode === "disabled") {
        return {
          status: "rejected",
          attempt: null,
          error: evdError("E_BUDGET_RESERVE_INCONSISTENT", { aggregate_output_reserve_tokens: 0 }),
        };
      }
      const attempt =
        deps.attempts === undefined
          ? makeAttempt(binding, "sending", deps, null)
          : makeAttempt(binding, "prepared", deps, null);
      if (deps.attempts !== undefined) {
        const prepared = await deps.attempts.prepare({
          binding: binding.binding,
          attempt,
        });
        if (!prepared.ok) {
          return persistenceFailure(prepared, attempt);
        }
        attempt.state = "sending";
        attempt.started_at = deps.now();
        const sending = await deps.attempts.markSending({
          binding: binding.binding,
          attempt_id: attempt.attempt_id,
          expected_row_version: 0,
        });
        if (!sending.ok) {
          attempt.state = "prepared";
          attempt.started_at = null;
          return persistenceFailure(sending, attempt);
        }
      }
      // Latency is measured on the monotonic timeline. The wall clock only
      // stamps `started_at`/`finished_at`, so an NTP jump during the call
      // cannot change the reported elapsed time or a budget decision.
      const clock = deps.clock ?? systemClock;
      const monotonicStartedAt = clock.monotonicNowMs();
      const outcome = await deps.backend.invoke({ request: binding.request, signal });
      const monotonicFinishedAt = clock.monotonicNowMs();
      const finishedAt = deps.now();
      const elapsed = Math.max(0, Math.floor(monotonicFinishedAt - monotonicStartedAt));
      if (outcome.status === "response") {
        const httpStatus = outcome.http_status;
        if (httpStatus === 429 || httpStatus >= 500) {
          attempt.http_status = httpStatus;
          attempt.finished_at = finishedAt;
          attempt.state = "outcome_unknown";
          attempt.retryable = true;
          attempt.error_code = httpStatus === 429 ? "E_RATE_LIMITED" : "E_HTTP_5XX";
          return persistAttemptResult(deps, binding, attempt, {
            status: "unknown",
            attempt,
            error: evdError(httpStatus === 429 ? "E_RATE_LIMITED" : "E_HTTP_5XX", {
              upstream_unknown: {
                request_dispatched: true,
                attempt_status: "unknown",
                retryable: true,
                upstream_code: attempt.error_code,
              },
            } as never),
          });
        }
        if (httpStatus >= 400) {
          attempt.http_status = httpStatus;
          attempt.finished_at = finishedAt;
          attempt.state = "outcome_unknown";
          attempt.retryable = false;
          attempt.error_code = "E_HTTP_4XX";
          return persistAttemptResult(deps, binding, attempt, {
            status: "unknown",
            attempt,
            error: evdError("E_HTTP_4XX", {}),
          });
        }
        // The accepted-response branch records the transport observation before
        // normalising the wire, so `adapter_evidence.http.status_code` is the
        // status the provider actually returned rather than an assumption.
        attempt.http_status = outcome.http_status;
        const accepted = this.acceptResponse(binding, attempt, outcome.raw_body);
        attempt.finished_at = finishedAt;
        attempt.usage = attemptUsage(usageFromWire(outcome.raw_body, elapsed));
        if (!accepted.ok) {
          attempt.state = "degraded";
          const envelope = degradedEnvelope(binding, attempt, accepted.error, outcome.raw_body, finishedAt);
          attempt.response_envelope_id = envelope.envelope_id;
          attempt.response_envelope_schema_version = "rsi.judge_envelope/3";
          return persistAttemptResult(deps, binding, attempt, {
            status: "degraded",
            attempt,
            envelope,
          });
        }
        attempt.state = accepted.value.validation.status === "accepted" ? "accepted" : "degraded";
        attempt.response_envelope_id = accepted.value.envelope_id;
        attempt.response_envelope_schema_version = "rsi.judge_envelope/3";
        return persistAttemptResult(deps, binding, attempt, {
          status: accepted.value.validation.status === "accepted" ? "accepted" : "degraded",
          attempt,
          envelope: accepted.value,
        });
      }
      attempt.finished_at = finishedAt;
      if (outcome.status === "transport_error") {
        attempt.state = "transport_error";
        attempt.error_code = outcome.error_code;
        attempt.retryable = outcome.retryable;
        return persistAttemptResult(deps, binding, attempt, {
          status: "unknown",
          attempt,
          error: evdError("E_SERVICE_UNAVAILABLE", {}),
        });
      }
      if (outcome.status === "timeout") {
        attempt.state = "timeout";
        attempt.retryable = false;
        return persistAttemptResult(deps, binding, attempt, {
          status: "unknown",
          attempt,
          error: evdError("E_OUTCOME_UNKNOWN", {}),
        });
      }
      if (outcome.status === "cancelled") {
        attempt.state = "cancelled";
        return persistAttemptResult(deps, binding, attempt, {
          status: "cancelled",
          attempt,
          error: evdError("E_OUTCOME_UNKNOWN", {}),
        });
      }
      attempt.state = "outcome_unknown";
      attempt.retryable = false;
      return persistAttemptResult(deps, binding, attempt, {
        status: "unknown",
        attempt,
        error: evdError("E_OUTCOME_UNKNOWN", {}),
      });
    },

    acceptResponse(binding, attempt, wire): Result<JudgeEnvelopeV3, import("./types.js").EvdError> {
      const adapter = binding.request.adapter_request;
      const wireRecord =
        typeof wire === "object" && wire !== null && !Array.isArray(wire)
          ? (wire as Record<string, unknown>)
          : null;
      const typedAnswers = wireRecord === null ? null : wireRecord["answers"];
      if (
        adapter !== null &&
        typedAnswers !== null &&
        typeof typedAnswers === "object" &&
        !Array.isArray(typedAnswers)
      ) {
        const returnedModel = observedReturnedModel(wire);
        const modelKind = effectiveModelKind(returnedModel, deps);
        const typed = validateTypedWire({
          wire,
          questions: adapter.questions,
          requested_model: adapter.model,
          returned_model: returnedModel ?? "",
          model_kind: modelKind,
        });
        const usage = usageFromWire(wire, 0);
        const adapterEvidence = buildTypedEvidence(
          binding,
          wire,
          usage,
          deps.now(),
          deps,
          typed,
          attempt.http_status
        );
        const perQuestion: Record<string, { status: "accepted" | "degraded" | "missing"; errors: string[] }> = {};
        for (const key of Object.keys(typed.per_answer).sort()) {
          const entry = typed.per_answer[key];
          perQuestion[key] = { status: entry?.status ?? "missing", errors: entry?.errors ?? [] };
        }
        const envelope = buildEnvelope({
          binding,
          attempt,
          outcomes: {},
          validationStatus: typed.status,
          errors: typed.errors,
          skipped: typed.skipped_by_dependency,
          primary: typed.primary_error,
          perQuestion,
          adapterEvidence,
          usage,
          receivedAt: deps.now(),
        });
        return ok(envelope);
      }
      const validation = validateCategoricalOutput({
        wire,
        questions: binding.request.questions,
        optionEffects: optionEffectsOf(binding),
        manifestRefs: manifestRefsOf(binding),
      });
      const usage = usageFromWire(wire, 0);
      if (!validation.ok) {
        const failure: CategoricalValidationFailure = validation;
        const error = semanticOutputInvalidError(binding.backend.backend_key, failure);
        const perQuestion: Record<string, { status: "accepted" | "degraded" | "missing"; errors: string[] }> = {};
        for (const key of allQuestionKeys(binding)) {
          perQuestion[key] = { status: "degraded", errors: [error.code] };
        }
        return err(error);
      }
      const perQuestion: Record<string, { status: "accepted" | "degraded" | "missing"; errors: string[] }> = {};
      for (const key of allQuestionKeys(binding)) {
        perQuestion[key] = { status: "accepted", errors: [] };
      }
      const adapterEvidence = buildTypedEvidence(binding, wire, usage, deps.now(), deps);
      const envelope = buildEnvelope({
        binding,
        attempt,
        outcomes: validation.outcomes,
        validationStatus: "accepted",
        errors: [],
        skipped: [],
        primary: null,
        perQuestion,
        adapterEvidence,
        usage,
        receivedAt: deps.now(),
      });
      return ok(envelope);
    },

    async recordLateResult(
      input: LateResultSubmissionV2
    ): Promise<Result<LateResultReceipt, import("./types.js").EvdError>> {
      if (input.schema_version !== "rsi.late_result_submission/2") {
        return evdForwarded("E_VERSION_BINDING", { field: "schema_version" });
      }
      const attemptResult = await deps.late.readAttempt(input.attempt_id);
      if (!attemptResult.ok) {
        return evdForwarded("E_VERSION_BINDING", { field: "attempt_id" });
      }
      const attempt = attemptResult.value;
      if (attempt === null || attempt.schema_version !== "rsi.judge_attempt/2") {
        return evdForwarded("E_VERSION_BINDING", { field: "attempt_id" });
      }
      if (attempt.binding_id !== input.binding_id) {
        return evdForwarded("E_VERSION_BINDING", { field: "binding_id" });
      }
      if (attempt.capability_key !== input.capability_key) {
        return evdForwarded("E_VERSION_BINDING", { field: "capability_key" });
      }
      const envelopeKey = input.envelope?.envelope_key ?? null;
      const lateResults = await deps.late.readLateResults(input.attempt_id);
      if (!lateResults.ok) {
        return evdForwarded("E_VERSION_BINDING", { field: "late_results" });
      }
      const existing = lateResults.value.find(
        (row) =>
          row.raw_response_hash === input.raw_response_hash &&
          (row.envelope?.envelope_key ?? null) === envelopeKey
      );
      if (existing !== undefined) {
        return evdOk({
          disposition: "idempotent_noop",
          late_result_id: existing.late_result_id,
          wrote: false,
        });
      }
      const baseline = lateResults.value.find((row) => row.disposition === "appended_history");
      const disposition = baseline === undefined ? "appended_history" : "conflict_rejected";
      const lateResultKey = jcsHash({
        schema_version: "rsi.late_judge_result_key/2",
        attempt_id: input.attempt_id,
        raw_response_hash: input.raw_response_hash,
        capability_key: input.capability_key,
        envelope_schema_version: input.envelope_schema_version,
        envelope_key: envelopeKey,
        disposition,
      });
      const late: LateJudgeResultV2 = {
        schema_version: "rsi.late_judge_result/2",
        late_result_id: newId("env"),
        late_result_key: lateResultKey,
        attempt_id: input.attempt_id,
        binding_id: input.binding_id,
        request_hash: input.request_hash,
        capability_key: input.capability_key,
        envelope_schema_version: input.envelope_schema_version,
        envelope: input.envelope,
        raw_response_hash: input.raw_response_hash,
        received_at: input.received_at,
        disposition,
      };
      const committed = await deps.late.commitLate({ late });
      if (!committed.ok) {
        return err(committed.error as import("./types.js").EvdError);
      }
      return evdOk({ disposition, late_result_id: late.late_result_id, wrote: true });
    },
  };
}

function makeAttempt(
  binding: JudgeRequestBindingV3,
  state: JudgeAttemptV2["state"],
  deps: JudgeGatewayDeps,
  errorCode: string | null
): JudgeAttemptV2 {
  const attemptNo = deps.next_attempt_no(binding.binding_id);
  const attemptKey = jcsHash({
    schema_version: "rsi.judge_attempt/2",
    binding_id: binding.binding_id,
    attempt_no: attemptNo,
  });
  return {
    schema_version: "rsi.judge_attempt/2",
    attempt_id: newId("rat"),
    attempt_key: attemptKey,
    binding_id: binding.binding_id,
    request_id: binding.request_id,
    dispatch_key: binding.dispatch_key,
    attempt_no: attemptNo,
    backend_kind: binding.backend.backend_kind,
    capability_key: binding.backend.capability_key,
    capability_hash: binding.backend.capability_hash,
    method: binding.backend.method,
    scope_key: binding.backend.scope_key,
    request_schema_version: "rsi.semantic_backend_request/1",
    validator_binding_key: binding.validator_binding_key,
    state,
    started_at: state === "sending" ? deps.now() : null,
    finished_at: null,
    // DD-EVD-021/034: the attempt budget is an absolute reading on the same
    // monotonic timeline as the clock. `deps.now()` is wall time and must
    // never feed it. Flooring is conservative: it can shorten but never
    // extend the budget.
    deadline_at_monotonic_ms: Math.floor(
      (deps.clock ?? systemClock).monotonicNowMs() + binding.request.deadline_ms
    ),
    http_status: null,
    error_code: errorCode,
    retryable: false,
    response_envelope_id: null,
    response_envelope_schema_version: null,
    late_result_id: null,
    late_result_schema_version: null,
    usage: attemptUsage(emptyUsage(0)),
    created_at: deps.now(),
  };
}

function degradedEnvelope(
  binding: JudgeRequestBindingV3,
  attempt: JudgeAttemptV2,
  error: import("./types.js").EvdError,
  wire: unknown,
  receivedAt: number
): JudgeEnvelopeV3 {
  const perQuestion: Record<string, { status: "accepted" | "degraded" | "missing"; errors: string[] }> = {};
  for (const key of allQuestionKeys(binding)) {
    perQuestion[key] = { status: "degraded", errors: [error.code] };
  }
  return buildEnvelope({
    binding,
    attempt,
    outcomes: {},
    validationStatus: "degraded",
    errors: [error.code],
    skipped: [],
    primary: error.code,
    perQuestion,
    adapterEvidence: null,
    usage: usageFromWire(wire, 0),
    receivedAt,
  });
}

/**
 * Reads the model identifier from an accepted Jev response.
 *
 * The official `/v1/systemone` response names the actual model `model`.
 * `returned_model` is the compatibility alias used by frozen internal
 * `rsi.judge_wire/1` fixtures; when both are present it wins because it is the
 * field that explicitly claims to be the returned model. A missing identifier
 * yields `null` instead of an implicit "the requested model was returned"
 * assumption.
 */
function observedReturnedModel(wire: unknown): string | null {
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) {
    return null;
  }
  const record = wire as Record<string, unknown>;
  for (const key of ["returned_model", "model"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * `alias` permits a different concrete model, but only when the response
 * actually names one. An absent model is an unverifiable response, so it is
 * validated as a fixed model and degrades instead of being reported exact.
 */
function effectiveModelKind(
  returnedModel: string | null,
  deps: JudgeGatewayDeps
): "fixed" | "alias" {
  if (returnedModel === null) {
    return "fixed";
  }
  return deps.jev_profile?.model_kind ?? "fixed";
}

function modelMatchOf(
  requestedModel: string,
  returnedModel: string | null,
  modelKind: "fixed" | "alias"
): JevAdapterEvidence["model_match"] {
  if (returnedModel === null) {
    return "mismatch";
  }
  if (returnedModel === requestedModel) {
    return "exact";
  }
  return modelKind === "alias" ? "alias" : "mismatch";
}

function wireByteLength(wire: unknown): number {
  // `validateTypedWire` hashes exactly this JSON serialization. The backend
  // port does not expose the raw network bytes, so `response_bytes` is this
  // serialized size, not an HTTP Content-Length.
  return new TextEncoder().encode(JSON.stringify(wire ?? null)).byteLength;
}

function buildTypedEvidence(
  binding: JudgeRequestBindingV3,
  wire: unknown,
  usage: SemanticUsageObservation,
  receivedAt: number,
  deps: JudgeGatewayDeps,
  prevalidated?: TypedValidationResult,
  httpStatus: number | null = null
): JevAdapterEvidence | null {
  const adapter = binding.request.adapter_request;
  if (adapter === null) {
    return null;
  }
  const observedModel = observedReturnedModel(wire);
  const modelKind = effectiveModelKind(observedModel, deps);
  const typed =
    prevalidated ??
    validateTypedWire({
      wire,
      questions: adapter.questions,
      requested_model: adapter.model,
      returned_model: observedModel ?? "",
      model_kind: modelKind,
    });
  // Jev `ValidatorBinding/1` is profile-derived; the `/3` binding only carries
  // the semantic validator key, so the profile is the sole source of this key.
  const jevValidatorKey =
    deps.jev_profile === undefined
      ? binding.validator_binding_key
      : jevValidatorBindingKey({
          validator_policy_hash: jevValidatorPolicyHash(),
          service_profile_key: deps.jev_profile.profile_key,
        });
  return {
    kind: "jev_typed",
    schema_version: "rsi.jev_adapter_evidence/1",
    service_profile_key: binding.service_profile_key,
    // Without a profile the transport identity is not observed. These values
    // are the legacy defaults for profile-less in-memory dispatch tests; a
    // production dispatch supplies `jev_profile`.
    provider: deps.jev_profile?.provider ?? "typesafe",
    route: deps.jev_profile?.route ?? "",
    requested_model: adapter.model,
    returned_model: observedModel ?? "",
    model_match: modelMatchOf(adapter.model, observedModel, modelKind),
    validator_version: "rsi.judge.validator/1",
    validator_binding_key: jevValidatorKey,
    http: {
      // A direct `acceptResponse` caller that bypasses dispatch has no
      // transport observation; 200 is the only response path that reaches
      // this branch in dispatch, which always records `attempt.http_status`.
      status_code: httpStatus ?? 200,
      started_at: receivedAt - usage.elapsed_ms,
      received_at: receivedAt,
      latency_ms: usage.elapsed_ms,
      response_bytes: wireByteLength(wire),
    },
    wire: { response_hash: typed.response_hash, extra_keys: typed.extra_keys },
    typed_answers: typed.answers,
    applied_answers: typed.applied_answers,
    typed_mapped_from: Object.fromEntries(
      Object.entries(typed.wire === null ? {} : adapter.questions).map(([key, question]) => [
        key,
        question.type,
      ])
    ),
    jev_validation: {
      status: typed.status,
      policy_version: "rsi.judge.validator/1",
      validator_binding_key: jevValidatorKey,
      errors: typed.errors,
      skipped_by_dependency: typed.skipped_by_dependency,
      primary_error: typed.primary_error,
      calibration_status: typed.calibration_status,
    },
  };
}

export { adapterContractHash };

export interface JudgeServiceInput {
  invocation_id: string;
  binding: JudgeRequestBindingV3;
  budget: RunBudget;
  signal: AbortSignal;
}

export interface JudgeService {
  judge(input: JudgeServiceInput): Promise<JudgeAttemptResult>;
  cancel(invocation_id: string): boolean;
}

/**
 * DD-EVD-021 invocation wrapper: one `invocation_id` maps to exactly one
 * gateway dispatch. A repeated invocation returns the first result verbatim
 * and never issues a second backend request.
 */
export function createJudgeService(deps: {
  gateway: JudgeGateway;
  now?: () => number;
}): JudgeService {
  const results = new Map<string, JudgeAttemptResult>();
  return {
    async judge(input) {
      const existing = results.get(input.invocation_id);
      if (existing !== undefined) {
        return existing;
      }
      const result = await deps.gateway.dispatch(input.binding, input.budget, input.signal);
      results.set(input.invocation_id, result);
      return result;
    },
    cancel(invocation_id) {
      return results.delete(invocation_id);
    },
  };
}
