/**
 * EVD persistence adapter (DD-EVD-024).
 *
 * EVD never issues SQL. This module builds typed row batches, computes canonical
 * content blobs and provides deterministic reducers/verifiers used by recovery.
 * The FND `StateRowPort` remains the only writer.
 */

import {
  canonicalJson,
  canonicalJsonText,
  err,
  hashBytes,
  isHash,
  ok,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type JsonValue,
  type Result,
  type SourceRef,
  type VersionBinding,
} from "@evoplug/core";

import { evdErr, evdError, evdForwardedError, evdRebuildDivergence } from "./errors.js";

const EMPTY_HASH: Hash = `sha256:${"0".repeat(64)}`;
const EMPTY_ID: Id = `svcp:${"0".repeat(26)}` as Id;
import { dependencyUnitHash, dependencyUnitKey, evidencePackEvidenceHash, evidencePackHash, lateResultKeyV2, omissionKey, sortUtf8Strings } from "./hashing.js";
import type { BudgetEstimate, DependencyUnit, EvdAggregateRow, EvdAttemptRow, EvdCompileBatch, EvdContentMeta, EvdDependencyUnitRow, EvdEnvelopeRow, EvdEvidencePackRow, EvdLateResultRow, EvdOmissionRow, EvdRequestBindingRow, EvdServiceProfileRow, EvdServiceStateRow, EvdShardPlanRow, EvdShardRow, EvdBudgetEstimateRow, EvdValidatorBindingRow, EvdStateWritePort, EvidencePack, JudgeAttemptV2, JudgeStateManifest, JevServiceProfile, EvdError, LateJudgeResultV2, LiveCommitOutcome, Omission, SemanticBackendCapability, SemanticValidationBinding, ShardPlan, ShardStatus } from "./types.js";

/* ------------------------------------------------------------------ */
/* FND ports                                                           */
/* ------------------------------------------------------------------ */

export type EvdRowSchema =
  | "rsi.evd_evidence_pack_row/1"
  | "rsi.evd_dependency_unit_row/1"
  | "rsi.evd_state_manifest_row/1"
  | "rsi.evd_shard_plan_row/1"
  | "rsi.evd_shard_row/1"
  | "rsi.evd_omission_row/1"
  | "rsi.evd_budget_estimate_row/1"
  | "rsi.evd_service_profile_row/1"
  | "rsi.evd_service_state_row/1"
  | "rsi.evd_validator_binding_row/1"
  | "rsi.evd_request_binding_row/1"
  | "rsi.evd_attempt_row/1"
  | "rsi.evd_envelope_row/1"
  | "rsi.evd_late_result_row/1"
  | "rsi.evd_aggregate_row/1";

export interface EvdRowWrite {
  readonly row_schema: EvdRowSchema;
  readonly operation: "insert" | "update" | "transition";
  readonly row: JsonValue;
  readonly document_id: Hash | null;
}

export interface EvdAppendRequest {
  readonly binding: VersionBinding | null;
  readonly rows: readonly EvdRowWrite[];
}

/**
 * Immutable storage for the projected `JudgeState/2` documents.
 *
 * A manifest names `state_hash`, but the binding reader has to read the state
 * itself before a request binding exists. The port stores each shard's state
 * under its own immutable object document, keyed by `state_hash`, so the read
 * path resolves and re-hashes exactly the bytes the manifest described.
 */
export interface EvdJudgeStateDocument {
  readonly shard_id: string;
  readonly state: JsonValue;
}

export interface EvdStateDocumentWritePort {
  writeJudgeStates(input: {
    readonly binding: VersionBinding;
    readonly states: readonly EvdJudgeStateDocument[];
  }): Promise<EvdCommitOutcome>;
}

export interface EvdAppendReceipt {
  readonly batch_hash: Hash;
  readonly first_commit_seq: number;
  readonly last_commit_seq: number;
}

export type EvdCommitOutcome =
  | { readonly ok: true; readonly commit_state: "committed"; readonly receipt: EvdAppendReceipt }
  | { readonly ok: true; readonly commit_state: "existing" }
  | {
      readonly ok: false;
      readonly commit_state: "not_written" | "unknown_recovery_required";
      readonly error: ErrorEnvelope;
    };

export interface EvdStateRowPort {
  appendStateRows(input: EvdAppendRequest): Promise<EvdCommitOutcome>;
}

export interface EvdStoredBlob {
  readonly content_hash: Hash;
  readonly content_ref: SourceRef;
  readonly content_bytes: number;
}

export interface EvdBlobWritePort {
  put(bytes: Uint8Array): Promise<Result<EvdStoredBlob, ErrorEnvelope>>;
}

export function toLiveOutcome(outcome: EvdCommitOutcome): LiveCommitOutcome<null> {
  if (outcome.ok) {
    return outcome.commit_state === "committed"
      ? { ok: true, commit_state: "committed", value: null, receipt: outcome.receipt }
      : { ok: true, commit_state: "existing", value: null };
  }
  return {
    ok: false,
    commit_state: outcome.commit_state,
    error: outcome.error,
  };
}

/* ------------------------------------------------------------------ */
/* Canonical content                                                   */
/* ------------------------------------------------------------------ */

export function collectBlobRefs(value: JsonValue, into: Set<SourceRef>): void {
  if (typeof value === "string") {
    if (value.startsWith("blob://")) {
      into.add(value as SourceRef);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectBlobRefs(entry, into);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      collectBlobRefs(value[key] ?? null, into);
    }
  }
}

export function sourceBlobRefsOf(value: JsonValue): SourceRef[] {
  const refs = new Set<SourceRef>();
  collectBlobRefs(value, refs);
  return sortUtf8Strings([...refs]) as SourceRef[];
}

export async function storeContent(
  blobs: EvdBlobWritePort,
  value: JsonValue
): Promise<Result<EvdContentMeta, EvdError>> {
  const bytes = canonicalJson(value);
  if (bytes.length > 33_554_432) {
    return evdErr("E_EVD_OBJECT_TOO_LARGE", {
      object_type: "content",
      observed: bytes.length,
      limit: 33_554_432,
    });
  }
  const stored = await blobs.put(bytes);
  if (!stored.ok) {
    return err(stored.error as EvdError);
  }
  const recomputed = hashBytes(bytes);
  if (stored.value.content_hash !== recomputed) {
    return evdErr("E_CONTENT_HASH_MISMATCH", {
      content_ref: stored.value.content_ref,
      expected: recomputed,
      actual: stored.value.content_hash,
    });
  }
  return ok({
    content_hash: recomputed,
    content_ref: stored.value.content_ref,
    content_bytes: stored.value.content_bytes,
    source_blob_refs: sourceBlobRefsOf(value),
  });
}

function bound(binding: VersionBinding): Pick<
  EvdEvidencePackRow,
  "task_id" | "branch_id" | "input_epoch" | "goal_version" | "config_version" | "watermark"
> {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
  };
}

/* ------------------------------------------------------------------ */
/* Row builders                                                        */
/* ------------------------------------------------------------------ */

export async function buildPackRows(
  blobs: EvdBlobWritePort,
  binding: VersionBinding,
  pack: EvidencePack,
  now: number
): Promise<Result<EvdEvidencePackRow, EvdError>> {
  const content = await storeContent(blobs, JSON.parse(JSON.stringify(pack)) as JsonValue);
  if (!content.ok) {
    return content;
  }
  return ok({
    ...bound(binding),
    row_version: 0,
    created_at: now,
    ...content.value,
    pack_id: pack.pack_id,
    pack_key: pack.pack_key,
    pack_hash: pack.pack_hash,
    evidence_hash: pack.evidence_hash,
    plan_id: pack.plan_id,
    plan_hash: pack.plan_hash,
    issue_id: pack.issue_id,
    issue_key: pack.issue_key,
    pack_state: pack.pack_state === "valid" ? "valid" : "invalidated",
  });
}

export async function buildUnitRows(
  blobs: EvdBlobWritePort,
  binding: VersionBinding,
  units: readonly DependencyUnit[],
  now: number
): Promise<Result<EvdDependencyUnitRow[], EvdError>> {
  const rows: EvdDependencyUnitRow[] = [];
  for (const unit of units) {
    const content = await storeContent(blobs, JSON.parse(JSON.stringify(unit)) as JsonValue);
    if (!content.ok) {
      return content;
    }
    rows.push({
      ...bound(binding),
      row_version: 0,
      created_at: now,
      ...content.value,
      unit_id: unit.unit_id,
      unit_key: unit.unit_key,
      unit_hash: unit.unit_hash,
      plan_id: unit.plan_id,
      plan_hash: unit.plan_hash,
      pack_id: unit.pack_id,
      pack_key: EMPTY_HASH,
      dependency_key: unit.dependency_key,
      inseparable_group_key: unit.inseparable_group_key,
      transport_role: unit.transport_role,
    });
  }
  return ok(rows);
}

export async function buildManifestRows(
  blobs: EvdBlobWritePort,
  binding: VersionBinding,
  manifests: readonly JudgeStateManifest[],
  now: number
): Promise<Result<import("./types.js").EvdStateManifestRow[], EvdError>> {
  const rows: import("./types.js").EvdStateManifestRow[] = [];
  for (const manifest of manifests) {
    const content = await storeContent(blobs, JSON.parse(JSON.stringify(manifest)) as JsonValue);
    if (!content.ok) {
      return content;
    }
    rows.push({
      ...bound(binding),
      row_version: 0,
      created_at: now,
      ...content.value,
      manifest_id: manifest.manifest_id,
      manifest_key: manifest.manifest_key,
      manifest_hash: manifest.manifest_hash,
      shard_id: manifest.shard_id,
      shard_key: manifest.shard_key,
      plan_id: EMPTY_ID,
      plan_hash: manifest.plan_hash,
      pack_key: manifest.pack_key,
      state_hash: manifest.state_hash,
      state_content_hash: manifest.state_content_hash,
    });
  }
  return ok(rows);
}

export async function buildShardPlanRows(
  blobs: EvdBlobWritePort,
  binding: VersionBinding,
  plan: ShardPlan,
  now: number
): Promise<Result<{ plan_row: EvdShardPlanRow; shard_rows: EvdShardRow[] }, EvdError>> {
  const content = await storeContent(blobs, JSON.parse(JSON.stringify(plan)) as JsonValue);
  if (!content.ok) {
    return content;
  }
  const planRow: EvdShardPlanRow = {
    ...bound(binding),
    row_version: 0,
    created_at: now,
    ...content.value,
    shard_plan_id: plan.shard_plan_id,
    shard_plan_key: plan.shard_plan_key,
    shard_plan_hash: plan.shard_plan_hash,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    issue_id: plan.issue_id,
    pack_id: plan.pack_id,
    pack_key: plan.pack_key,
    service_profile_id: plan.service_profile_id,
    service_profile_key: plan.service_profile_key,
    state: plan.state,
  };
  const shardRows: EvdShardRow[] = plan.shards.map((shard, index) => ({
    ...bound(binding),
    row_version: 0,
    created_at: now,
    shard_id: shard.shard_id,
    shard_plan_id: plan.shard_plan_id,
    shard_plan_key: plan.shard_plan_key,
    shard_key: shard.shard_key,
    shard_order: index + 1,
    status: shard.status,
    request_binding_id: shard.request_binding_id,
    attempt_ids: [],
    envelope_keys: [],
    reason_codes: sortUtf8Strings(shard.reason_codes),
    body_json: shard,
  }));
  return ok({ plan_row: planRow, shard_rows: shardRows });
}

export async function buildOmissionRows(
  blobs: EvdBlobWritePort,
  binding: VersionBinding,
  omissions: readonly Omission[],
  now: number
): Promise<Result<EvdOmissionRow[], EvdError>> {
  const rows: EvdOmissionRow[] = [];
  for (const omission of omissions) {
    const content = await storeContent(blobs, JSON.parse(JSON.stringify(omission)) as JsonValue);
    if (!content.ok) {
      return content;
    }
    rows.push({
      ...bound(binding),
      row_version: 0,
      created_at: now,
      ...content.value,
      omission_id: omission.omission_id,
      omission_key: omission.omission_key,
      shard_plan_id: omission.shard_plan_id,
      plan_hash: omission.plan_hash,
      shard_id: omission.shard_id ?? null,
      question_keys: omission.question_keys,
      unit_keys: omission.unit_keys,
      impact: omission.impact,
      reason: omission.reason,
      required_for_issue: omission.required_for_issue,
      recoverable: omission.recoverable,
    });
  }
  return ok(rows);
}

export async function buildEstimateRows(
  blobs: EvdBlobWritePort,
  binding: VersionBinding,
  estimates: ReadonlyArray<BudgetEstimate | import("./types.js").SemanticBudgetEstimate>,
  now: number
): Promise<Result<EvdBudgetEstimateRow[], EvdError>> {
  const rows: EvdBudgetEstimateRow[] = [];
  for (const estimate of estimates) {
    const content = await storeContent(blobs, JSON.parse(JSON.stringify(estimate)) as JsonValue);
    if (!content.ok) {
      return content;
    }
    rows.push({
      ...bound(binding),
      row_version: 0,
      created_at: now,
      ...content.value,
      estimate_id: estimate.estimate_id,
      estimate_key: estimate.estimate_key,
      estimate_hash: estimate.estimate_hash,
      shard_id: estimate.shard_id,
      shard_key: estimate.shard_key,
      shard_plan_id:
        estimate.schema_version === "rsi.budget_estimate/1"
          ? EMPTY_ID
          : estimate.shard_plan_id,
      service_profile_key: estimate.service_profile_key,
      limits_hash: estimate.limits.limits_hash,
      verdict: estimate.verdict,
    });
  }
  return ok(rows);
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

export interface EvdWriterDeps {
  rows: EvdStateRowPort;
  blobs: EvdBlobWritePort;
  now: () => number;
  /** Optional judge-state document store; required when a batch carries states. */
  state_documents?: EvdStateDocumentWritePort;
}

function rowWrite(row_schema: EvdRowSchema, operation: EvdRowWrite["operation"], row: object): EvdRowWrite {
  return {
    row_schema,
    operation,
    row: JSON.parse(JSON.stringify(row)) as JsonValue,
    document_id: null,
  };
}

export function createEvdStateWriter(deps: EvdWriterDeps): EvdStateWritePort {
  return {
    async commitCompile(input: EvdCompileBatch) {
      const now = deps.now();
      // DD-EVD-015: a manifest names the exact shard it projects. A manifest
      // built before binning carries an invented shard identity, so persisting
      // it would leave `evd_state_manifest.shard_id` dangling or, worse, point
      // at an unrelated shard. Refuse the batch instead of letting SQLite
      // report a deferred foreign-key failure at COMMIT.
      const shardById = new Map(input.shards.map((shard) => [shard.shard_id, shard]));
      const manifestShardIds = new Set<string>();
      for (const manifest of input.manifests) {
        const shard = shardById.get(manifest.shard_id);
        const rule =
          shard === undefined
            ? "shard_missing"
            : shard.shard_key !== manifest.shard_key
              ? "shard_key"
              : manifest.pack_key !== input.pack.pack_key
                ? "pack_key"
                : manifest.plan_hash !== input.pack.plan_hash
                  ? "plan_hash"
                  : shard.state_hash !== null && shard.state_hash !== manifest.state_hash
                    ? "state_hash"
                    : manifestShardIds.has(manifest.shard_id)
                      ? "duplicate_shard"
                      : null;
        if (rule !== null) {
          return {
            ok: false,
            commit_state: "not_written",
            error: evdError("E_EVIDENCE_MANIFEST_MISMATCH", {
              display_id: manifest.shard_id,
              logical_id: rule,
            }),
          };
        }
        manifestShardIds.add(manifest.shard_id);
      }
      for (const shard of input.shards) {
        if (
          (shard.status === "planned" || shard.status === "bound") &&
          !manifestShardIds.has(shard.shard_id)
        ) {
          return {
            ok: false,
            commit_state: "not_written",
            error: evdError("E_EVIDENCE_MANIFEST_MISMATCH", {
              display_id: shard.shard_id,
              logical_id: "manifest_missing",
            }),
          };
        }
      }
      if (input.states !== undefined && input.states.length > 0) {
        const documents = deps.state_documents;
        if (documents === undefined) {
          return {
            ok: false,
            commit_state: "not_written",
            error: evdForwardedError("E_VERSION_BINDING", { field: "states" }),
          };
        }
        // Documents are immutable and content-addressed: writing them before
        // the row batch can leave an unreferenced document if this compile is
        // later refused, but can never leave a manifest whose state hash has
        // no readable body.
        const stored = await documents.writeJudgeStates({
          binding: input.binding,
          states: input.states,
        });
        if (!stored.ok) {
          return stored;
        }
      }
      const packRow = await buildPackRows(deps.blobs, input.binding, input.pack, now);
      if (!packRow.ok) {
        return { ok: false, commit_state: "not_written", error: packRow.error };
      }
      const unitRows = await buildUnitRows(deps.blobs, input.binding, input.units, now);
      if (!unitRows.ok) {
        return { ok: false, commit_state: "not_written", error: unitRows.error };
      }
      for (const unit of unitRows.value) {
        unit.pack_id = input.pack.pack_id;
        unit.pack_key = input.pack.pack_key;
      }
      const manifestRows = await buildManifestRows(deps.blobs, input.binding, input.manifests, now);
      if (!manifestRows.ok) {
        return { ok: false, commit_state: "not_written", error: manifestRows.error };
      }
      const planRows = await buildShardPlanRows(deps.blobs, input.binding, input.shard_plan, now);
      if (!planRows.ok) {
        return { ok: false, commit_state: "not_written", error: planRows.error };
      }
      const omissionRows = await buildOmissionRows(deps.blobs, input.binding, input.omissions, now);
      if (!omissionRows.ok) {
        return { ok: false, commit_state: "not_written", error: omissionRows.error };
      }
      const estimateRows = await buildEstimateRows(deps.blobs, input.binding, input.estimates, now);
      if (!estimateRows.ok) {
        return { ok: false, commit_state: "not_written", error: estimateRows.error };
      }
      // `BudgetEstimate/1` has no `shard_plan_id` field; it still belongs to
      // the plan being committed, and the row's FK must not be an empty id.
      for (const estimate of estimateRows.value) {
        estimate.shard_plan_id = input.shard_plan.shard_plan_id;
      }
      const rows: EvdRowWrite[] = [
        rowWrite("rsi.evd_evidence_pack_row/1", "insert", packRow.value),
        ...unitRows.value.map((row) => rowWrite("rsi.evd_dependency_unit_row/1", "insert", row)),
        rowWrite("rsi.evd_shard_plan_row/1", "insert", planRows.value.plan_row),
        ...planRows.value.shard_rows.map((row) => rowWrite("rsi.evd_shard_row/1", "insert", row)),
        // A manifest names a persisted shard; write it after the shard rows so
        // the dependency holds in caller order as well as at deferred commit.
        ...manifestRows.value.map((row) => rowWrite("rsi.evd_state_manifest_row/1", "insert", row)),
        ...omissionRows.value.map((row) => rowWrite("rsi.evd_omission_row/1", "insert", row)),
        ...estimateRows.value.map((row) => rowWrite("rsi.evd_budget_estimate_row/1", "insert", row)),
      ];
      return toLiveOutcome(await deps.rows.appendStateRows({ binding: input.binding, rows }));
    },

    async commitBinding(input) {
      const bindingSchema = input.request_binding.schema_version;
      if (bindingSchema !== "rsi.judge_request_binding/3") {
        // Only the current protocol version is writable. Archived `/1` and `/2`
        // rows are not part of the major-4 read path.
        return {
          ok: false,
          commit_state: "not_written",
          error: evdForwardedError("E_VERSION_BINDING", { binding_schema_version: bindingSchema }),
        };
      }
      // DD-EVD-011/024: the binding row joins its shard plan by the real
      // `shard_plan_key`. A missing or empty key would make the reader join a
      // synthetic plan, so it is refused before anything is staged.
      if (!isHash(input.shard_plan_key) || input.shard_plan_key === EMPTY_HASH) {
        return {
          ok: false,
          commit_state: "not_written",
          error: evdForwardedError("E_VERSION_BINDING", { field: "shard_plan_key" }),
        };
      }
      const requestState = input.request_binding.request.state;
      // `state` is null only for backends that carry no JudgeState (the
      // semantic request type permits it). When a state object is present its
      // hashes are mandatory; a malformed object must not fall back to the
      // zero hash.
      if (
        requestState !== null &&
        (!isHash(requestState.state_hash) || !isHash(requestState.state_content_hash))
      ) {
        return {
          ok: false,
          commit_state: "not_written",
          error: evdForwardedError("E_VERSION_BINDING", { field: "request.state" }),
        };
      }
      const binding = input.request_binding;
      const content = await storeContent(
        deps.blobs,
        JSON.parse(JSON.stringify(binding)) as JsonValue
      );
      if (!content.ok) {
        return { ok: false, commit_state: "not_written", error: content.error };
      }
      const now = deps.now();
      const row: EvdRequestBindingRow = {
        ...bound(input.binding),
        row_version: 0,
        created_at: now,
        ...content.value,
        binding_id: binding.binding_id,
        request_hash: binding.request_hash,
        dispatch_key: binding.dispatch_key,
        plan_id: binding.plan_id,
        plan_hash: binding.plan_hash,
        shard_id: input.shard_id,
        shard_key: binding.shard_key,
        shard_plan_id: binding.shard_plan_id,
        shard_plan_key: input.shard_plan_key,
        service_profile_key: binding.service_profile_key,
        validator_binding_key: input.validator_binding_key,
        state_hash: requestState?.state_hash ?? EMPTY_HASH,
        state_content_hash: requestState?.state_content_hash ?? EMPTY_HASH,
        questions_hash: binding.question_set_hash,
        template_bindings_digest: binding.template_bindings_digest,
        question_bindings_digest: binding.question_bindings_digest,
        proposition_bindings_digest: binding.proposition_bindings_digest,
      };
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: input.binding,
          rows: [
            rowWrite("rsi.evd_request_binding_row/1", "insert", row),
            // DD-EVD-011/024: binding and the shard's `planned → bound`
            // transition commit atomically. The shard was inserted at
            // row_version 0 by `commitCompile`; a replay with the same
            // binding matches the transition patch and returns `existing`.
            rowWrite("rsi.evd_shard_row/1", "transition", {
              shard_id: input.shard_id,
              status: "bound",
              request_binding_id: binding.binding_id,
              expected_row_version: 0,
            }),
          ],
        })
      );
    },

    async prepareAttempt(input) {
      const attempt = input.attempt;
      if (attempt.schema_version !== "rsi.judge_attempt/2") {
        return {
          ok: false,
          commit_state: "not_written",
          error: evdForwardedError("E_VERSION_BINDING", { field: "attempt" }),
        };
      }
      const row: EvdAttemptRow = {
        ...bound(input.binding),
        row_version: 0,
        created_at: attempt.created_at,
        attempt_id: attempt.attempt_id,
        attempt_key: attempt.attempt_key,
        binding_id: attempt.binding_id,
        request_id: attempt.request_id,
        dispatch_key: attempt.dispatch_key,
        attempt_no: attempt.attempt_no,
        state: attempt.state,
        http_status: attempt.http_status,
        error_code: attempt.error_code,
        response_envelope_id: attempt.response_envelope_id,
        late_result_id: attempt.late_result_id,
        body_json: attempt,
      };
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: input.binding,
          rows: [rowWrite("rsi.evd_attempt_row/1", "insert", row)],
        })
      );
    },

    async markSending(input) {
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: input.binding,
          rows: [
            rowWrite("rsi.evd_attempt_row/1", "transition", {
              attempt_id: input.attempt_id,
              state: "sending",
              expected_row_version: input.expected_row_version,
            }),
          ],
        })
      );
    },

    async commitResponse(input) {
      const envelope = input.envelope;
      // DD-EVD-025 rule 7: a new envelope write must be `/3`. A `/2`
      // envelope is read-only and is refused with a structured error.
      if (envelope.schema_version !== "rsi.judge_envelope/3") {
        return {
          ok: false,
          commit_state: "not_written",
          error: evdForwardedError("E_VERSION_BINDING", {
            schema_version: envelope.schema_version
          })
        };
      }
      const content = await storeContent(
        deps.blobs,
        JSON.parse(JSON.stringify(envelope)) as JsonValue
      );
      if (!content.ok) {
        return { ok: false, commit_state: "not_written", error: content.error };
      }
      const row: EvdEnvelopeRow = {
        ...bound(input.binding),
        row_version: 0,
        created_at: envelope.received_at,
        ...content.value,
        envelope_id: envelope.envelope_id,
        envelope_key: envelope.envelope_key,
        binding_id: envelope.binding_id,
        attempt_id: input.attempt_id,
        request_hash: envelope.request_hash,
        dispatch_key: envelope.dispatch_key,
        shard_id: envelope.shard_id,
        shard_key: envelope.shard_key,
        validation_status: envelope.validation.status,
        received_at: envelope.received_at,
      };
      const attemptRow = rowWrite("rsi.evd_attempt_row/1", "transition", {
        attempt_id: input.attempt_id,
        state: input.terminal_state,
        expected_row_version: input.expected_row_version,
        response_envelope_id: envelope.envelope_id,
      });
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: input.binding,
          rows: [rowWrite("rsi.evd_envelope_row/1", "insert", row), attemptRow],
        })
      );
    },

    async commitAttemptTerminal(input) {
      const attempt = input.attempt;
      if (attempt.schema_version !== "rsi.judge_attempt/2") {
        return {
          ok: false,
          commit_state: "not_written",
          error: evdForwardedError("E_VERSION_BINDING", { field: "attempt" }),
        };
      }
      // `accepted` and `degraded` own an envelope row and go through
      // `commitResponse`; every other terminal state is envelope-free.
      if (
        attempt.state !== "transport_error" &&
        attempt.state !== "timeout" &&
        attempt.state !== "outcome_unknown" &&
        attempt.state !== "cancelled"
      ) {
        return {
          ok: false,
          commit_state: "not_written",
          error: evdForwardedError("E_VERSION_BINDING", { field: "attempt.state" }),
        };
      }
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: input.binding,
          rows: [
            rowWrite("rsi.evd_attempt_row/1", "transition", {
              attempt_id: input.attempt_id,
              state: attempt.state,
              expected_row_version: input.expected_row_version,
              http_status: attempt.http_status,
              error_code: attempt.error_code,
              response_envelope_id: attempt.response_envelope_id,
              late_result_id: attempt.late_result_id,
              // Attempts have no physical `finished_at`; the complete object
              // (including terminal timestamps and usage) lives in body_json.
              // Keeping it in step with the denormalized state column also
              // preserves the DD-EVD replay invariant.
              body_json: attempt,
            }),
          ],
        })
      );
    },

    async commitAggregate(input) {
      const aggregate = input.aggregate;
      if (aggregate.schema_version !== "rsi.answer_aggregate/2") {
        return {
          ok: false,
          commit_state: "not_written",
          error: evdError("E_STATE_VERSION_UNSUPPORTED", { schema_version: aggregate.schema_version }),
        };
      }
      const content = await storeContent(deps.blobs, JSON.parse(JSON.stringify(aggregate)) as JsonValue);
      if (!content.ok) {
        return { ok: false, commit_state: "not_written", error: content.error };
      }
      const row: EvdAggregateRow = {
        ...bound(input.binding),
        row_version: 0,
        created_at: aggregate.created_at,
        ...content.value,
        aggregate_id: aggregate.aggregate_id,
        aggregate_key: aggregate.aggregate_key,
        aggregate_hash: aggregate.aggregate_hash,
        plan_hash: aggregate.plan_hash,
        shard_plan_key: aggregate.shard_plan_key,
        final_state: aggregate.final_state,
        final_basis: aggregate.final_basis,
        coverage_complete: aggregate.coverage_complete,
        supersedes_aggregate_id: aggregate.supersedes_aggregate_id ?? null,
      };
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: input.binding,
          rows: [rowWrite("rsi.evd_aggregate_row/1", "insert", row)],
        })
      );
    },

    async commitLate(input) {
      const late = input.late;
      const content = await storeContent(deps.blobs, JSON.parse(JSON.stringify(late)) as JsonValue);
      if (!content.ok) {
        return { ok: false, commit_state: "not_written", error: content.error };
      }
      const row: EvdLateResultRow = {
        ...bound(input.binding),
        row_version: 0,
        created_at: late.received_at,
        ...content.value,
        late_result_id: late.late_result_id,
        late_result_key: late.late_result_key,
        attempt_id: late.attempt_id,
        envelope_key: late.envelope?.envelope_key ?? null,
        disposition: late.disposition,
        received_at: late.received_at,
      };
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: input.binding,
          rows: [rowWrite("rsi.evd_late_result_row/1", "insert", row)],
        })
      );
    },

    async writeServiceProfile(input) {
      const row = profileRowFor(input.profile, input.expected_previous_version, deps.now());
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: null,
          rows: [rowWrite("rsi.evd_service_profile_row/1", "insert", row)],
        })
      );
    },

    async writeSemanticBackendCapability(input) {
      const capability = input.capability;
      const profileBody: SemanticBackendCapability = {
        ...capability,
        schema_version: "rsi.semantic_backend_capability/1",
        capability_hash: capability.capability_hash,
      };
      const row: EvdServiceProfileRow = {
        profile_id: newIdFromCapability(capability.capability_key),
        profile_key: capability.capability_key,
        profile_version: Math.max(1, (input.expected_previous_version ?? 0) + 1),
        acceptance_status: "shadow_only",
        production_use: false,
        body_json: profileBody,
        row_version: 0,
        created_at: deps.now(),
      };
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: null,
          rows: [rowWrite("rsi.evd_service_profile_row/1", "insert", row)],
        })
      );
    },

    async writeValidatorBinding(input) {
      const binding = input.binding;
      const row: EvdValidatorBindingRow = {
        validator_binding_id: binding.validator_binding_id,
        validator_binding_key: binding.validator_binding_key,
        validator_policy_hash: binding.validator_policy_hash,
        service_profile_key: binding.service_profile_key,
        body_json: binding,
        row_version: 0,
        created_at: binding.created_at,
      };
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: null,
          rows: [rowWrite("rsi.evd_validator_binding_row/1", "insert", row)],
        })
      );
    },

    async writeSemanticValidationBinding(input) {
      const binding: SemanticValidationBinding = input.binding;
      const row: EvdValidatorBindingRow = {
        validator_binding_id: binding.validator_binding_id,
        validator_binding_key: binding.validator_binding_key,
        validator_policy_hash: binding.policy_hash,
        service_profile_key: binding.capability_key,
        body_json: binding,
        row_version: 0,
        created_at: binding.created_at,
      };
      return toLiveOutcome(
        await deps.rows.appendStateRows({
          binding: null,
          rows: [rowWrite("rsi.evd_validator_binding_row/1", "insert", row)],
        })
      );
    },
  };
}

function profileRowFor(
  profile: Omit<JevServiceProfile, "profile_id" | "profile_version" | "created_at">,
  expected: number | null,
  now: number
): EvdServiceProfileRow {
  return {
    profile_id: newIdProfile(profile.profile_key),
    profile_key: profile.profile_key,
    profile_version: Math.max(1, (expected ?? 0) + 1),
    acceptance_status: profile.acceptance.status,
    production_use: profile.acceptance.status === "eligible" && profile.production_use,
    body_json: {
      ...profile,
      profile_id: newIdProfile(profile.profile_key),
      profile_version: Math.max(1, (expected ?? 0) + 1),
      created_at: now,
    },
    row_version: 0,
    created_at: now,
  };
}

function newIdProfile(profileKey: Hash): Id {
  const hex = profileKey.slice("sha256:".length, "sha256:".length + 26).toUpperCase();
  return `svcp:${hex}` as Id;
}

function newIdFromCapability(capabilityKey: Hash): Id {
  return newIdProfile(capabilityKey);
}

/* ------------------------------------------------------------------ */
/* Deterministic reducers                                              */
/* ------------------------------------------------------------------ */

export interface EvdReduceContext {
  commit_seq: number;
  getEarlierRow(schema: EvdRowSchema, key: readonly JsonValue[]): JsonValue | null;
  readBlob(ref: SourceRef): Promise<Result<Uint8Array, ErrorEnvelope>>;
}

export interface EvdRowReducer {
  schema: EvdRowSchema;
  immutable: boolean;
  verify(row: JsonValue, ctx: EvdReduceContext): Promise<Result<void, EvdError>>;
  reduce(prev: JsonValue | null, next: JsonValue): Result<JsonValue, EvdError>;
}

function toContentMeta(row: JsonValue): EvdContentMeta {
  return JSON.parse(JSON.stringify(row)) as EvdContentMeta;
}

function toShardRow(row: JsonValue): EvdShardRow {
  return JSON.parse(JSON.stringify(row)) as EvdShardRow;
}

function toAttemptRow(row: JsonValue): EvdAttemptRow {
  return JSON.parse(JSON.stringify(row)) as EvdAttemptRow;
}

function toServiceStateRow(row: JsonValue): EvdServiceStateRow {
  return JSON.parse(JSON.stringify(row)) as EvdServiceStateRow;
}

function verifyContent(
  row: JsonValue,
  ctx: EvdReduceContext
): Promise<Result<void, EvdError>> {
  return verifyContentAsync(toContentMeta(row), ctx);
}

async function verifyContentAsync(
  row: EvdContentMeta,
  ctx: EvdReduceContext
): Promise<Result<void, EvdError>> {
  const blob = await ctx.readBlob(row.content_ref);
  if (!blob.ok) {
    return err(evdRebuildDivergence());
  }
  const hash = hashBytes(blob.value);
  if (hash !== row.content_hash || blob.value.length !== row.content_bytes) {
    return evdErr("E_CONTENT_HASH_MISMATCH", {
      content_ref: row.content_ref,
      expected: row.content_hash,
      actual: hash,
    });
  }
  return ok(undefined);
}

async function readObject(
  row: EvdContentMeta,
  ctx: EvdReduceContext
): Promise<Result<JsonValue, EvdError>> {
  const blob = await ctx.readBlob(row.content_ref);
  if (!blob.ok) {
    return err(evdRebuildDivergence());
  }
  try {
    return ok(JSON.parse(new TextDecoder().decode(blob.value)) as JsonValue);
  } catch {
    return err(evdRebuildDivergence());
  }
}

function asTyped<T>(value: JsonValue): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectHash(actual: string, expected: string): Result<void, EvdError> {
  return actual === expected ? ok(undefined) : err(evdRebuildDivergence());
}

export const EVD_ROW_REDUCERS: Readonly<Record<EvdRowSchema, EvdRowReducer>> = {
  "rsi.evd_evidence_pack_row/1": {
    schema: "rsi.evd_evidence_pack_row/1",
    immutable: true,
    verify: async (row, ctx) => {
      const content = await verifyContent(row, ctx);
      if (!content.ok) {
        return content;
      }
      const meta = toContentMeta(row);
      const object = await readObject(meta, ctx);
      if (!object.ok) {
        return object;
      }
      const pack = asTyped<EvidencePack>(object.value);
      const evidenceHash = evidencePackEvidenceHash({
        plan_hash: pack.plan_hash,
        question_keys: pack.question_keys,
        issue_key: pack.issue_key,
        issue_question: pack.issue.question,
        issue_requirement_ids: pack.issue.requirement_ids,
        issue_type: pack.issue.issue_type,
        requirements: pack.requirements,
        feedback: pack.feedback ?? null,
        facts: pack.facts.map((fact) => ({
          id: fact.id,
          source_id: fact.source_id,
          kind: fact.kind,
          role: fact.role,
          excerpt: fact.excerpt,
          content_hash: fact.content_hash,
          source_refs: fact.source_refs,
          ...(fact.version !== undefined ? { version: fact.version } : {}),
        })),
        coverage: {
          checked_requirement_ids: pack.coverage.checked_requirement_ids,
          searched_sources: pack.coverage.searched_sources,
          omitted_refs: pack.coverage.omitted_refs,
          missing: pack.coverage.missing.map((entry) => ({
            ...(entry.source_refs !== undefined ? { source_refs: entry.source_refs } : {}),
            ...(entry.source_id !== undefined ? { source_id: entry.source_id } : {}),
            reason: entry.reason,
            affects_question_keys: entry.affects_question_ids,
            recoverable: entry.recoverable,
          })),
        },
      });
      const packHash = evidencePackHash({
        plan_hash: pack.plan_hash,
        question_keys: pack.question_keys,
        compiler_version: pack.compiler_version,
        counting_method_version: pack.counting_method_version,
        source_manifest_version: pack.source_manifest_version,
        issue_key: pack.issue_key,
        binding: {
          task_id: pack.task_id as VersionBinding["task_id"],
          branch_id: pack.branch_id as VersionBinding["branch_id"],
          input_epoch: pack.input_epoch,
          goal_version: pack.goal_version,
          config_version: pack.config_version,
          watermark: pack.watermark,
        },
        evidence_hash: evidenceHash,
      });
      return expectHash(
        `${evidenceHash}|${packHash}`,
        `${pack.evidence_hash}|${pack.pack_hash}`
      );
    },
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_dependency_unit_row/1": {
    schema: "rsi.evd_dependency_unit_row/1",
    immutable: true,
    verify: async (row, ctx) => {
      const content = await verifyContent(row, ctx);
      if (!content.ok) {
        return content;
      }
      const object = await readObject(toContentMeta(row), ctx);
      if (!object.ok) {
        return object;
      }
      const unit = asTyped<DependencyUnit>(object.value);
      const key = dependencyUnitKey({
        plan_hash: unit.plan_hash,
        dependency_key: unit.dependency_key,
        inseparable_group_key: unit.inseparable_group_key,
        role: unit.role,
        transport_role: unit.transport_role,
        source_ids: unit.source_ids,
        source_refs: unit.source_refs,
        ...(unit.artifact_version !== undefined ? { artifact_version: unit.artifact_version } : {}),
        omission_impact: unit.omission_impact,
        can_omit: unit.can_omit,
        ...(unit.derived_view_key !== undefined ? { derived_view_key: unit.derived_view_key } : {}),
      });
      const hash = dependencyUnitHash({
        unit_key: key,
        state_evidence: unit.state_evidence,
        estimated_tokens: unit.estimated_tokens,
      });
      return expectHash(`${key}|${hash}`, `${unit.unit_key}|${unit.unit_hash}`);
    },
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_state_manifest_row/1": {
    schema: "rsi.evd_state_manifest_row/1",
    immutable: true,
    verify: async (row, ctx) => verifyContent(row, ctx),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_shard_plan_row/1": {
    schema: "rsi.evd_shard_plan_row/1",
    immutable: true,
    verify: async (row, ctx) => verifyContent(row, ctx),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_shard_row/1": {
    schema: "rsi.evd_shard_row/1",
    immutable: false,
    verify: async () => ok(undefined),
    reduce: (prev, next) => {
      if (prev === null) {
        return ok(next);
      }
      const previous = toShardRow(prev);
      const incoming = toShardRow(next);
      if (previous.shard_id !== incoming.shard_id) {
        return err(evdRebuildDivergence());
      }
      if (!shardTransitionAllowed(previous.status, incoming.status)) {
        return err(evdRebuildDivergence());
      }
      return ok(next);
    },
  },
  "rsi.evd_omission_row/1": {
    schema: "rsi.evd_omission_row/1",
    immutable: true,
    verify: async (row, ctx) => {
      const content = await verifyContent(row, ctx);
      if (!content.ok) {
        return content;
      }
      const object = await readObject(toContentMeta(row), ctx);
      if (!object.ok) {
        return object;
      }
      const omission = asTyped<Omission>(object.value);
      const key = omissionKey({
        plan_hash: omission.plan_hash,
        unit_keys: omission.unit_keys,
        question_keys: omission.question_keys,
        source_ids: omission.source_ids,
        source_refs: omission.source_refs,
        plan_omission_impact: omission.plan_omission_impact,
        can_omit: omission.can_omit,
        required_for_issue: omission.required_for_issue,
        reason: omission.reason,
        impact: omission.impact,
      });
      return expectHash(key, omission.omission_key);
    },
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_budget_estimate_row/1": {
    schema: "rsi.evd_budget_estimate_row/1",
    immutable: true,
    verify: async (row, ctx) => verifyContent(row, ctx),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_service_profile_row/1": {
    schema: "rsi.evd_service_profile_row/1",
    immutable: true,
    verify: async () => ok(undefined),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_service_state_row/1": {
    schema: "rsi.evd_service_state_row/1",
    immutable: false,
    verify: async () => ok(undefined),
    reduce: (prev, next) => {
      if (prev === null) {
        return ok(next);
      }
      const previous = toServiceStateRow(prev);
      const incoming = toServiceStateRow(next);
      if (incoming.current_profile_version <= previous.current_profile_version) {
        return evdErr("E_SERVICE_STATE_INCONSISTENT", {
          profile_key: incoming.profile_key,
          expected_previous_version: previous.current_profile_version,
          current_version: incoming.current_profile_version,
        });
      }
      return ok(next);
    },
  },
  "rsi.evd_validator_binding_row/1": {
    schema: "rsi.evd_validator_binding_row/1",
    immutable: true,
    verify: async () => ok(undefined),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_request_binding_row/1": {
    schema: "rsi.evd_request_binding_row/1",
    immutable: true,
    verify: async (row, ctx) => verifyContent(row, ctx),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_attempt_row/1": {
    schema: "rsi.evd_attempt_row/1",
    immutable: false,
    verify: async () => ok(undefined),
    reduce: (prev, next) => {
      if (prev === null) {
        return ok(next);
      }
      const previous = toAttemptRow(prev);
      const incoming = toAttemptRow(next);
      if (previous.attempt_id !== incoming.attempt_id) {
        return err(evdRebuildDivergence());
      }
      if (!attemptTransitionAllowed(previous.state, incoming.state)) {
        return err(evdRebuildDivergence());
      }
      return ok(next);
    },
  },
  "rsi.evd_envelope_row/1": {
    schema: "rsi.evd_envelope_row/1",
    immutable: true,
    verify: async (row, ctx) => verifyContent(row, ctx),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_late_result_row/1": {
    schema: "rsi.evd_late_result_row/1",
    immutable: true,
    verify: async (row, ctx) => {
      const content = await verifyContent(row, ctx);
      if (!content.ok) {
        return content;
      }
      const object = await readObject(toContentMeta(row), ctx);
      if (!object.ok) {
        return object;
      }
      const late = asTyped<LateJudgeResultV2>(object.value);
      const key = lateResultKeyV2({
        attempt_id: late.attempt_id,
        raw_response_hash: late.raw_response_hash,
        capability_key: late.capability_key,
        envelope_schema_version: late.envelope_schema_version,
        envelope_key: late.envelope?.envelope_key ?? null,
        disposition: late.disposition,
      });
      return expectHash(key, late.late_result_key);
    },
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
  "rsi.evd_aggregate_row/1": {
    schema: "rsi.evd_aggregate_row/1",
    immutable: true,
    verify: async (row, ctx) => verifyContent(row, ctx),
    reduce: (prev, next) => (prev === null ? ok(next) : err(evdRebuildDivergence())),
  },
};

const SHARD_TRANSITIONS: Readonly<Record<ShardStatus, readonly ShardStatus[]>> = {
  planned: ["budget_rejected", "projection_rejected", "bound", "deterministic_skip"],
  budget_rejected: [],
  projection_rejected: [],
  bound: ["sent", "cancelled"],
  sent: ["accepted", "degraded", "unknown"],
  accepted: [],
  degraded: [],
  unknown: [],
  cancelled: [],
  // W3 deterministic short-circuit: insert-only terminal status. It is never
  // reached by a transition; the compile batch inserts it directly.
  deterministic_skip: []
};

export function shardTransitionAllowed(from: ShardStatus, to: ShardStatus): boolean {
  return SHARD_TRANSITIONS[from].includes(to);
}

const ATTEMPT_TRANSITIONS: Readonly<Record<JudgeAttemptV2["state"], readonly JudgeAttemptV2["state"][]>> = {
  prepared: ["sending", "cancelled"],
  sending: ["response_received", "accepted", "degraded", "transport_error", "timeout", "outcome_unknown", "cancelled"],
  response_received: ["accepted", "degraded", "transport_error", "timeout", "outcome_unknown"],
  accepted: [],
  degraded: [],
  transport_error: [],
  timeout: [],
  outcome_unknown: [],
  cancelled: [],
};

export function attemptTransitionAllowed(
  from: JudgeAttemptV2["state"],
  to: JudgeAttemptV2["state"]
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export { canonicalJsonText };
