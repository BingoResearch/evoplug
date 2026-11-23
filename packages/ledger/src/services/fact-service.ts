import { canonicalJsonText, newId } from "@evoplug/core";
import type {
  ContentKey,
  ErrorEnvelope,
  Id,
  IdPrefix,
  MethodRef,
  Result,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";
import type {
  StateFactDraft,
  StateFactView,
  VerifyFactRequest,
  VerifierRegistryView,
} from "../domain/facts.js";
import type { FactVerificationStateRow, StateFactStateRow } from "../rows.js";
import type { LedgerPorts, VerificationCommitInput } from "../ports.js";
import { ledgerFailure, ledgerOk, schemaError } from "../errors.js";
import { stateFactRowJson, factVerificationRowJson } from "../rows.js";
import { validateStateFactDraft } from "../facts/record.js";
import {
  buildFactVerificationRow,
  buildVerificationPayload,
  decideVerificationIdempotency,
  validateVerifyFactRequest,
} from "../facts/verify.js";
import { recomputeTruthStateFromResults } from "../facts/aggregate.js";
import { validateVersionBinding } from "../validation.js";
import { commitStateRows, mapCommitOutcome, stateRowWrite } from "./commit.js";
import { isSourceRef } from "../source-ref.js";

function triggerLineageError<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_EVENT_TRIGGER_LINEAGE",
    category: "schema",
    details: { kind: "none" },
    stage: "event_trigger_lineage",
  });
}

function reservationPolicyError<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_BUDGET_POLICY_UNAVAILABLE",
    category: "version",
    details: { kind: "none" },
    stage: "budget_scope_read",
  });
}

/**
 * Fact write service: `recordFact` and `verifyFact` (DD-FND-074).
 *
 * `recordFact` writes one `state_fact` row. `verifyFact` freezes a `/2`
 * payload, appends one verification row and updates only the derived
 * `truth_state`, `verifier_ref` and `row_version` columns of the fact; the
 * creating binding F, `stale`, `stale_reason`, `artifact_version` and
 * `content_hash` are preserved byte-for-byte.
 */
export class FactService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  async recordFact(draft: StateFactDraft): Promise<Result<StateFactView, ErrorEnvelope>> {
    const factId = newId("fact");
    const plan = validateStateFactDraft(draft, factId);
    if (!plan.ok) return plan;

    const commit = await commitStateRows(this.#ports, draft.binding, [
      stateRowWrite("rsi.state_fact_row/1", "insert", stateFactRowJson(plan.value.row)),
    ]);
    if (!commit.ok) return commit;
    return ledgerOk(plan.value.view);
  }

  async verifyFact(
    request: VerifyFactRequest,
  ): Promise<Result<VerifierRegistryView, ErrorEnvelope>> {
    const bindingResult = validateVersionBinding(request.binding);
    if (!bindingResult.ok) return bindingResult;

    const query = {
      task_id: request.binding.task_id,
      branch_id: request.binding.branch_id,
      watermark: request.binding.watermark,
    };
    const [factRows, verificationRows, session, branch, receipt] = await Promise.all([
      this.#ports.projection.listFactRows(query),
      this.#ports.projection.listFactVerificationRows(query),
      this.#ports.identity.getSession(request.session_id),
      this.#ports.identity.getBranch(request.binding.branch_id),
      this.#ports.identity.getReceiptSeq(),
    ]);
    if (!factRows.ok) return factRows;
    if (!verificationRows.ok) return verificationRows;
    if (!session.ok) return session;
    if (!branch.ok) return branch;
    if (!receipt.ok) return receipt;

    const fact = factRows.value.find((row) => row.fact_id === request.fact_id);
    if (fact === undefined) {
      return ledgerFailure<VerifierRegistryView>({
        code: "E_VERSION_BINDING",
        category: "version",
        details: { kind: "version", expected: "existing_fact", actual: request.fact_id },
        stage: "binding",
      });
    }
    if (branch.value === null) {
      return ledgerFailure<VerifierRegistryView>({
        code: "E_VERSION_BINDING",
        category: "version",
        details: {
          kind: "version",
          expected: "existing_branch",
          actual: request.binding.branch_id,
        },
        stage: "binding",
      });
    }
    if (session.value !== null && session.value.session_id !== request.session_id) {
      return ledgerFailure<VerifierRegistryView>({
        code: "E_SUCCESS_EVIDENCE_BINDING",
        category: "version",
        details: { kind: "none" },
        stage: "success_evidence_write",
      });
    }

    const currentBinding: VersionBinding = {
      task_id: branch.value.task_id,
      branch_id: branch.value.branch_id,
      input_epoch: branch.value.current_input_epoch,
      goal_version: branch.value.current_goal_version,
      config_version: branch.value.current_config_version,
      watermark: receipt.value,
    };

    const validated = validateVerifyFactRequest(request, {
      fact,
      current_binding: currentBinding,
      current_receipt_seq: receipt.value,
      session_branch_id: session.value?.current_branch_id ?? null,
    });
    if (!validated.ok) return validated;

    const trigger = await this.#ports.events.getEvent(request.trigger_event_id);
    if (!trigger.ok) return trigger;
    if (trigger.value === null) return triggerLineageError();
    if (
      trigger.value.task_id !== request.binding.task_id ||
      trigger.value.branch_id !== request.binding.branch_id
    ) {
      return triggerLineageError();
    }

    const reservations = await this.#checkReservations(request);
    if (!reservations.ok) return reservations;

    const existingRows = verificationRows.value.filter(
      (row) => row.fact_id === request.fact_id && row.verifier_ref === request.verifier_ref,
    );
    const existing = existingRows[0] ?? null;

    const payload = buildVerificationPayload(request, {
      verification_binding: currentBinding,
      producer_ref: fact.producer_ref,
      status: "valid",
      verified_at: this.#ports.clock.now(),
    });

    const decision = decideVerificationIdempotency({
      existing:
        existing === null
          ? null
          : {
              row: existing,
              payload_schema_version:
                existing.method_ref_json === null
                  ? "rsi.fact_verification.recorded/1"
                  : "rsi.fact_verification.recorded/2",
              stored_content_hash: existing.content_hash,
            },
      incoming_content_hash: payload.content_hash,
      incoming_is_legacy: false,
    });

    if (decision.kind === "conflict") {
      return ledgerFailure<VerifierRegistryView>(
        {
          code: "E_IDEMPOTENCY_CONFLICT",
          category: "conflict",
          details: {
            kind: "idempotency",
            key: request.fact_id + "\u0000" + request.verifier_ref,
            existing_hash: existing === null ? payload.content_hash : existing.content_hash,
            incoming_hash: payload.content_hash,
          },
          stage: "persist",
        },
        "conflict",
      );
    }
    if (decision.kind === "existing") {
      if (existing === null) {
        return schemaError<VerifierRegistryView>("verification", "existing_row_missing");
      }
      return ledgerOk(this.#verifierView(existing, payload.verification_binding));
    }
    if (fact.row_version !== request.expected_row_version) {
      return ledgerFailure<VerifierRegistryView>(
        {
          code: "E_STALE_VERSION",
          category: "conflict",
          details: {
            kind: "version",
            expected: String(request.expected_row_version),
            actual: String(fact.row_version),
          },
          stage: "persist",
        },
        "conflict",
      );
    }

    const eventId = newId("ev");
    const verificationRow = buildFactVerificationRow({
      payload,
      event_id: eventId,
      method_ref_json: canonicalJsonText({
        schema_version: payload.method_ref.schema_version,
        method_id: payload.method_ref.method_id,
        method_version: payload.method_ref.method_version,
        rule_version: payload.method_ref.rule_version,
      }),
      reservation_ids_json: canonicalJsonText([...payload.reservation_ids]),
      requirement_ids_json: canonicalJsonText([...payload.requirement_ids]),
      proposition_ids_json: canonicalJsonText([...payload.proposition_ids]),
      source_ids_json: canonicalJsonText([...payload.source_ids]),
      source_refs_json: canonicalJsonText([...payload.source_refs]),
      row_version: 1,
    });

    const derivedTruth = recomputeTruthStateFromResults([
      ...existingRows.map((row) => ({ status: row.status, result: row.result })),
      { status: "valid", result: request.result },
    ]);

    const stateFactAfter: StateFactStateRow = {
      ...fact,
      truth_state: derivedTruth,
      verifier_ref:
        derivedTruth === "contradicted" || derivedTruth === "verified"
          ? request.verifier_ref
          : fact.verifier_ref,
      row_version: fact.row_version + 1,
    };

    const commitInput: VerificationCommitInput = {
      binding: currentBinding,
      payload,
      state_fact_after: stateFactRowJson(stateFactAfter),
      fact_verification_row: factVerificationRowJson(verificationRow),
      fact_id: request.fact_id,
      verifier_ref: request.verifier_ref,
      event_id: eventId,
      trigger_event_id: request.trigger_event_id,
    };
    const outcome = await this.#ports.verificationCommit.commitVerification(commitInput);
    const mapped = mapCommitOutcome(outcome);
    if (!mapped.ok) return mapped;

    return ledgerOk(this.#verifierView(verificationRow, currentBinding));
  }

  async #checkReservations(request: VerifyFactRequest): Promise<Result<void, ErrorEnvelope>> {
    for (const reservationId of request.reservation_ids) {
      const reservation = await this.#ports.reservations.getReservation(reservationId);
      if (!reservation.ok) return reservation;
      if (reservation.value === null) {
        return ledgerFailure<void>({
          code: "E_VERSION_BINDING",
          category: "version",
          details: {
            kind: "version",
            expected: "existing_reservation",
            actual: reservationId,
          },
          stage: "binding",
        });
      }
      const view = reservation.value;
      if (
        view.binding.task_id !== request.binding.task_id ||
        view.binding.branch_id !== request.binding.branch_id ||
        view.binding.input_epoch !== request.binding.input_epoch ||
        view.binding.goal_version !== request.binding.goal_version ||
        view.binding.config_version !== request.binding.config_version ||
        view.binding.watermark !== request.binding.watermark
      ) {
        return ledgerFailure<void>({
          code: "E_VERSION_BINDING",
          category: "version",
          details: { kind: "version", expected: "reservation_binding", actual: reservationId },
          stage: "binding",
        });
      }
      if (view.purpose !== "verifier") return reservationPolicyError<void>();
      if (
        view.status !== "claimed" &&
        view.status !== "settled" &&
        view.status !== "unsettled"
      ) {
        return reservationPolicyError<void>();
      }
    }
    return ledgerOk<void>(undefined);
  }

  #verifierView(
    row: FactVerificationStateRow,
    binding: VersionBinding,
  ): VerifierRegistryView {
    return {
      schema_version: "rsi.fact_verification/1",
      fact_id: row.fact_id,
      event_id: row.event_id,
      verifier_ref: row.verifier_ref,
      verifier_id: row.verifier_id,
      verifier_kind: row.verifier_kind,
      method_ref: row.method_ref_json === null ? null : parseMethodRefJson(row.method_ref_json),
      reservation_ids: parseIds<"resv">(row.reservation_ids_json),
      independent: row.independent === 1,
      verification_binding: binding,
      requirement_ids: parseIds<"req">(row.requirement_ids_json),
      proposition_ids: parseContentKeys(row.proposition_ids_json),
      effect: row.effect,
      artifact_version: row.artifact_version,
      source_ids: parseStrings(row.source_ids_json),
      source_refs: parseSourceRefs(row.source_refs_json),
      result: row.result,
      status: row.status,
      verified_at: row.verified_at,
      row_version: row.row_version,
    };
  }
}

function parseStrings(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function parseIds<P extends IdPrefix>(text: string): Id<P>[] {
  return parseStrings(text) as Id<P>[];
}

function parseContentKeys(text: string): ContentKey<"propo">[] {
  return parseStrings(text) as ContentKey<"propo">[];
}

function parseSourceRefs(text: string): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const value of parseStrings(text)) {
    if (isSourceRef(value)) refs.push(value);
  }
  return refs;
}

function parseMethodRefJson(text: string): MethodRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    record["schema_version"] !== "rsi.method_ref/1" ||
    typeof record["method_id"] !== "string" ||
    typeof record["method_version"] !== "string" ||
    typeof record["rule_version"] !== "string"
  ) {
    return null;
  }
  return {
    schema_version: "rsi.method_ref/1",
    method_id: record["method_id"],
    method_version: record["method_version"],
    rule_version: record["rule_version"],
  };
}
