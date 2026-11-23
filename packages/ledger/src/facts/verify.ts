import { canonicalHash, parseMethodRef } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type {
  FactVerificationRecordedPayloadV2,
  VerifyFactRequest,
} from "../domain/facts.js";
import type { FactVerificationStateRow, StateFactStateRow } from "../rows.js";
import { ledgerFailure, ledgerOk, schemaError, versionBindingError, watermarkAheadError } from "../errors.js";
import { factVerificationContentHashV2 } from "../hashes.js";
import { isHash } from "../raw-hash.js";
import { isSourceRef } from "../source-ref.js";
import { isSortedUniqueStrings, utf8ByteLength } from "../util.js";
import { validateVersionBinding, sameTaskBranch } from "../validation.js";
import { VERIFIER_KINDS } from "../domain/facts.js";

export const MAX_SOURCE_IDS = 128;
export const MAX_SOURCE_ID_BYTES = 128;
export const MAX_RESERVATION_IDS = 8;

function sourceIdInvalid<T>(path: string): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_LEDGER_SOURCE_ID_INVALID",
    category: "schema",
    details: { kind: "field", path, rule: "1_to_128_sorted_unique_utf8_le_128_bytes" },
    stage: "rebuild",
  });
}

function verifierInvalid<T>(ref: SourceRef): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_LEDGER_VERIFIER_INVALID",
    category: "source",
    details: { kind: "source", source_ref: ref, reason: "hash_mismatch" },
    stage: "rebuild",
  });
}

/**
 * `source_ids` must be 1..128 non-empty, unique, UTF-8-ascending strings of at
 * most 128 UTF-8 bytes each. No de-duplication, sorting or truncation is done
 * on the caller's behalf.
 */
export function validateSourceIds(
  sourceIds: readonly string[],
): Result<readonly string[], ErrorEnvelope> {
  if (sourceIds.length < 1 || sourceIds.length > MAX_SOURCE_IDS) {
    return sourceIdInvalid("source_ids");
  }
  for (const id of sourceIds) {
    if (id.length === 0) return sourceIdInvalid("source_ids[]");
    if (id.includes("\u0000")) return sourceIdInvalid("source_ids[]");
    if (utf8ByteLength(id) > MAX_SOURCE_ID_BYTES) return sourceIdInvalid("source_ids[]");
  }
  if (!isSortedUniqueStrings(sourceIds)) {
    return sourceIdInvalid("source_ids");
  }
  return ledgerOk(sourceIds);
}

/** Reservation IDs: UTF-8 sorted, unique and at most 8 entries. */
export function validateReservationIds(
  ids: readonly Id<"resv">[],
): Result<readonly Id<"resv">[], ErrorEnvelope> {
  if (ids.length > MAX_RESERVATION_IDS) {
    return schemaError<readonly Id<"resv">[]>("reservation_ids", "at_most_8");
  }
  if (!isSortedUniqueStrings(ids)) {
    return schemaError<readonly Id<"resv">[]>("reservation_ids", "sorted_unique_utf8");
  }
  return ledgerOk(ids);
}

export interface VerifyFactContext {
  readonly fact: StateFactStateRow;
  /** Current branch binding: five fields plus `schema_meta.receipt_seq`. */
  readonly current_binding: VersionBinding;
  readonly current_receipt_seq: number;
  /** `session.current_branch_id`, or `null` when the session is missing. */
  readonly session_branch_id: Id<"br"> | null;
}

/**
 * Structural validation of a verification request (DD-FND-074). Reservation
 * existence/purpose and trigger-event lineage are checked by the service.
 */
export function validateVerifyFactRequest(
  request: VerifyFactRequest,
  context: VerifyFactContext,
): Result<VerifyFactRequest, ErrorEnvelope> {
  if (request.schema_version !== "rsi.verify_fact/1") {
    return schemaError<VerifyFactRequest>("schema_version", "rsi.verify_fact/1");
  }
  const bindingResult = validateVersionBinding(request.binding);
  if (!bindingResult.ok) return bindingResult;

  if (!Number.isSafeInteger(request.expected_row_version) || request.expected_row_version < 1) {
    return schemaError<VerifyFactRequest>("expected_row_version", "positive_safe_integer");
  }
  if (context.session_branch_id === null || context.session_branch_id !== request.binding.branch_id) {
    return ledgerFailure<VerifyFactRequest>(
      {
        code: "E_SUCCESS_EVIDENCE_BINDING",
        category: "version",
        details: { kind: "none" },
        stage: "success_evidence_write",
      },
      "rejected",
    );
  }
  if (!sameTaskBranch(request.binding, context.current_binding)) {
    return versionBindingError();
  }
  if (
    request.binding.input_epoch !== context.current_binding.input_epoch ||
    request.binding.goal_version !== context.current_binding.goal_version ||
    request.binding.config_version !== context.current_binding.config_version
  ) {
    return versionBindingError();
  }
  if (request.binding.watermark > context.current_receipt_seq) {
    return watermarkAheadError();
  }
  if (!sameTaskBranch(request.binding, {
    task_id: context.fact.task_id,
    branch_id: context.fact.branch_id,
    input_epoch: context.fact.input_epoch,
    goal_version: context.fact.goal_version,
    config_version: context.fact.config_version,
    watermark: context.fact.watermark,
  })) {
    return versionBindingError();
  }
  if (request.binding.watermark < context.fact.watermark) {
    return versionBindingError();
  }

  if (!isSourceRef(request.verifier_ref)) {
    return verifierInvalid(request.verifier_ref);
  }
  if (!isSourceRef(context.fact.producer_ref)) {
    return verifierInvalid(request.verifier_ref);
  }
  if (request.verifier_ref === context.fact.producer_ref) {
    return verifierInvalid(request.verifier_ref);
  }
  if (request.verifier_id.length === 0 || request.verifier_id.includes("\u0000")) {
    return schemaError<VerifyFactRequest>("verifier_id", "non_empty_no_nul");
  }
  if (!VERIFIER_KINDS.includes(request.verifier_kind)) {
    return schemaError<VerifyFactRequest>("verifier_kind", "closed_enum");
  }
  if (
    request.effect !== "supports" &&
    request.effect !== "violates" &&
    request.effect !== "unknown"
  ) {
    return schemaError<VerifyFactRequest>("effect", "closed_enum");
  }
  if (
    request.result !== "verified" &&
    request.result !== "contradicted" &&
    request.result !== "unknown"
  ) {
    return schemaError<VerifyFactRequest>("result", "closed_enum");
  }

  const methodResult = parseMethodRef(request.method_ref);
  if (!methodResult.ok) return methodResult;

  const sourceIdsResult = validateSourceIds(request.source_ids);
  if (!sourceIdsResult.ok) return sourceIdsResult;

  if (request.source_refs.length === 0) {
    return schemaError<VerifyFactRequest>("source_refs", "non_empty");
  }
  for (const ref of request.source_refs) {
    if (!isSourceRef(ref)) return schemaError<VerifyFactRequest>("source_refs[]", "source_ref_format");
  }
  if (!isSortedUniqueStrings(request.source_refs)) {
    return schemaError<VerifyFactRequest>("source_refs", "sorted_unique_utf8");
  }
  if (!isSortedUniqueStrings(request.requirement_ids)) {
    return schemaError<VerifyFactRequest>("requirement_ids", "sorted_unique_utf8");
  }
  if (!isSortedUniqueStrings(request.proposition_ids)) {
    return schemaError<VerifyFactRequest>("proposition_ids", "sorted_unique_utf8");
  }

  const reservationResult = validateReservationIds(request.reservation_ids);
  if (!reservationResult.ok) return reservationResult;

  if (request.artifact_version !== context.fact.artifact_version) {
    return ledgerFailure<VerifyFactRequest>(
      {
        code: "E_VERSION_BINDING",
        category: "version",
        details: {
          kind: "version",
          expected: context.fact.artifact_version ?? "null",
          actual: request.artifact_version ?? "null",
        },
        stage: "binding",
      },
    );
  }

  return ledgerOk(request);
}

export interface VerificationPayloadContext {
  readonly verification_binding: VersionBinding;
  readonly producer_ref: SourceRef;
  readonly status: "valid" | "invalidated" | "unknown";
  readonly verified_at: number;
}

/** Builds the frozen `/2` payload and its content hash. */
export function buildVerificationPayload(
  request: VerifyFactRequest,
  context: VerificationPayloadContext,
): FactVerificationRecordedPayloadV2 {
  const base: Omit<FactVerificationRecordedPayloadV2, "content_hash"> = {
    schema_version: "rsi.fact_verification.recorded/2",
    fact_id: request.fact_id,
    verification_binding: context.verification_binding,
    verifier_ref: request.verifier_ref,
    verifier_id: request.verifier_id,
    verifier_kind: request.verifier_kind,
    method_ref: request.method_ref,
    reservation_ids: request.reservation_ids,
    independent: computeIndependent(request.verifier_ref, context.producer_ref),
    requirement_ids: request.requirement_ids,
    proposition_ids: request.proposition_ids,
    effect: request.effect,
    artifact_version: request.artifact_version,
    source_ids: request.source_ids,
    source_refs: request.source_refs,
    result: request.result,
    status: context.status,
    verified_at: context.verified_at,
  };
  const contentHash = factVerificationContentHashV2(base);
  return { ...base, content_hash: contentHash };
}

/**
 * `independent` is exactly `verifier_ref !== fact.producer_ref`, compared as
 * exact `SourceRef` strings. It proves evidence identity only, never semantic
 * or institutional independence.
 */
export function computeIndependent(
  verifierRef: SourceRef,
  producerRef: SourceRef,
): boolean {
  return verifierRef !== producerRef;
}

/** Identity preimage from DD-FND-070 for `fact_verification.recorded`. */
export function factVerificationEventKey(input: {
  readonly fact_id: Id<"fact">;
  readonly verifier_ref: SourceRef;
  readonly content_hash: Hash;
}): Hash {
  return canonicalHash({
    schema_version: "rsi.fact_verification_identity/1",
    fact_id: input.fact_id,
    verifier_ref: input.verifier_ref,
    content_hash: input.content_hash,
  });
}

export interface ExistingVerification {
  readonly row: FactVerificationStateRow;
  readonly payload_schema_version: "rsi.fact_verification.recorded/1" | "rsi.fact_verification.recorded/2";
  readonly stored_content_hash: Hash;
}

export interface VerificationIdempotencyDecision {
  readonly kind: "new" | "existing" | "conflict";
  readonly existing_event_id: Id<"ev"> | null;
}

/**
 * Idempotency by `(fact_id, verifier_ref)`:
 * - same content hash returns the existing result, no new event;
 * - different content is `E_IDEMPOTENCY_CONFLICT`;
 * - an existing legacy `/1` row is always a conflict for a new `/2` request,
 *   even when `reservation_ids` is empty or `method_ref` matches.
 */
export function decideVerificationIdempotency(input: {
  readonly existing: ExistingVerification | null;
  readonly incoming_content_hash: Hash;
  readonly incoming_is_legacy: boolean;
}): VerificationIdempotencyDecision {
  if (input.existing === null) return { kind: "new", existing_event_id: null };
  if (input.incoming_is_legacy) {
    if (input.existing.payload_schema_version === "rsi.fact_verification.recorded/1") {
      return input.existing.stored_content_hash === input.incoming_content_hash
        ? { kind: "existing", existing_event_id: input.existing.row.event_id }
        : { kind: "conflict", existing_event_id: input.existing.row.event_id };
    }
    return { kind: "conflict", existing_event_id: input.existing.row.event_id };
  }
  if (input.existing.payload_schema_version === "rsi.fact_verification.recorded/1") {
    return { kind: "conflict", existing_event_id: input.existing.row.event_id };
  }
  return input.existing.stored_content_hash === input.incoming_content_hash
    ? { kind: "existing", existing_event_id: input.existing.row.event_id }
    : { kind: "conflict", existing_event_id: input.existing.row.event_id };
}


/** Constructs the physical verification row from a frozen payload. */
export function buildFactVerificationRow(input: {
  readonly payload: FactVerificationRecordedPayloadV2;
  readonly event_id: Id<"ev">;
  readonly method_ref_json: string;
  readonly reservation_ids_json: string;
  readonly requirement_ids_json: string;
  readonly proposition_ids_json: string;
  readonly source_ids_json: string;
  readonly source_refs_json: string;
  readonly row_version: number;
}): FactVerificationStateRow {
  const payload = input.payload;
  return {
    fact_id: payload.fact_id,
    event_id: input.event_id,
    verifier_ref: payload.verifier_ref,
    verifier_id: payload.verifier_id,
    verifier_kind: payload.verifier_kind,
    method_ref_json: input.method_ref_json,
    reservation_ids_json: input.reservation_ids_json,
    independent: payload.independent ? 1 : 0,
    input_epoch: payload.verification_binding.input_epoch,
    goal_version: payload.verification_binding.goal_version,
    config_version: payload.verification_binding.config_version,
    watermark: payload.verification_binding.watermark,
    requirement_ids_json: input.requirement_ids_json,
    proposition_ids_json: input.proposition_ids_json,
    effect: payload.effect,
    artifact_version: payload.artifact_version,
    source_ids_json: input.source_ids_json,
    source_refs_json: input.source_refs_json,
    result: payload.result,
    status: payload.status,
    content_hash: payload.content_hash,
    verified_at: payload.verified_at,
    row_version: input.row_version,
  };
}

/** True when a stored verification row keeps a valid `/2` shape. */
export function isCurrentVerificationRow(row: FactVerificationStateRow): boolean {
  return row.method_ref_json !== null && isHash(row.content_hash);
}
