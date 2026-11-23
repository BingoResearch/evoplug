import { canonicalJsonText, isJsonObject } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result } from "@evoplug/core";
import type { StateFactDraft, StateFactView } from "../domain/facts.js";
import type { StateFactStateRow } from "../rows.js";
import { ledgerOk, schemaError } from "../errors.js";
import { isHash } from "../raw-hash.js";
import { stateFactContentHash } from "../hashes.js";
import { isNonNegativeSafeInteger, isSafeRelativePath, parseJsonValue } from "../util.js";
import { isSourceRef } from "../source-ref.js";
import { validateVersionBinding } from "../validation.js";
import { STATE_FACT_KINDS } from "../domain/facts.js";

export interface StateFactPlan {
  readonly fact_id: Id<"fact">;
  readonly content_hash: Hash;
  readonly row: StateFactStateRow;
  readonly view: StateFactView;
}

function factValueSchemaVersion(kind: StateFactDraft["kind"]): string {
  return "rsi.fact_value/" + kind + "/1";
}

/**
 * `recordFact` acceptance (DD-FND-074).
 *
 * Only `claim` and `observed` drafts are accepted; `verified` and
 * `contradicted` are derived from verification records and can never be
 * written directly. The `value` text must already be canonical JSON for
 * `rsi.fact_value/<kind>/1`.
 */
export function validateStateFactDraft(
  draft: StateFactDraft,
  factId: Id<"fact">,
): Result<StateFactPlan, ErrorEnvelope> {
  if (draft.schema_version !== "rsi.state_fact_draft/1") {
    return schemaError<StateFactPlan>("schema_version", "rsi.state_fact_draft/1");
  }
  const bindingResult = validateVersionBinding(draft.binding);
  if (!bindingResult.ok) return bindingResult;

  if (!STATE_FACT_KINDS.includes(draft.kind)) {
    return schemaError<StateFactPlan>("kind", "closed_enum");
  }
  if (draft.truth_state !== "claim" && draft.truth_state !== "observed") {
    return schemaError<StateFactPlan>("truth_state", "claim_or_observed");
  }
  if (draft.subject.length === 0) {
    return schemaError<StateFactPlan>("subject", "non_empty");
  }
  if (draft.subject.includes("\u0000")) {
    return schemaError<StateFactPlan>("subject", "no_nul");
  }
  if (!isNonNegativeSafeInteger(draft.observed_at)) {
    return schemaError<StateFactPlan>("observed_at", "non_negative_safe_integer");
  }
  if (!isSourceRef(draft.source_ref)) {
    return schemaError<StateFactPlan>("source_ref", "source_ref_format");
  }
  if (!isSourceRef(draft.producer_ref)) {
    return schemaError<StateFactPlan>("producer_ref", "source_ref_format");
  }

  const parsed = parseJsonValue(draft.value);
  if (parsed === null || !isJsonObject(parsed)) {
    return schemaError<StateFactPlan>("value", "canonical_json_object");
  }
  let canonicalText: string;
  try {
    canonicalText = canonicalJsonText(parsed);
  } catch {
    return schemaError<StateFactPlan>("value", "canonical_json_object");
  }
  if (canonicalText !== draft.value) {
    return schemaError<StateFactPlan>("value", "canonical_json_text");
  }
  if (parsed["schema_version"] !== factValueSchemaVersion(draft.kind)) {
    return schemaError<StateFactPlan>("value.schema_version", factValueSchemaVersion(draft.kind));
  }

  const isArtifactKind = draft.kind === "code" || draft.kind === "interface_contract";
  if (isArtifactKind) {
    if (!isSafeRelativePath(draft.subject)) {
      return schemaError<StateFactPlan>("subject", "safe_relative_path");
    }
    const valuePath = parsed["path"];
    const valueArtifactVersion = parsed["artifact_version"];
    if (typeof valuePath !== "string" || valuePath !== draft.subject) {
      return schemaError<StateFactPlan>("value.path", "equals_subject");
    }
    if (draft.artifact_version === null || draft.artifact_version.length === 0) {
      return schemaError<StateFactPlan>("artifact_version", "required_for_artifact_kind");
    }
    if (typeof valueArtifactVersion !== "string" || valueArtifactVersion !== draft.artifact_version) {
      return schemaError<StateFactPlan>("artifact_version", "equals_value_artifact_version");
    }
  } else if (draft.artifact_version !== null && draft.artifact_version.length === 0) {
    return schemaError<StateFactPlan>("artifact_version", "null_or_non_empty");
  }

  const contentHash = stateFactContentHash(draft);
  if (!isHash(contentHash)) {
    return schemaError<StateFactPlan>("content_hash", "sha256_lower_hex");
  }

  const row: StateFactStateRow = {
    fact_id: factId,
    task_id: draft.binding.task_id,
    branch_id: draft.binding.branch_id,
    input_epoch: draft.binding.input_epoch,
    goal_version: draft.binding.goal_version,
    config_version: draft.binding.config_version,
    watermark: draft.binding.watermark,
    kind: draft.kind,
    subject: draft.subject,
    value: draft.value,
    truth_state: draft.truth_state,
    source_ref: draft.source_ref,
    producer_ref: draft.producer_ref,
    verifier_ref: null,
    artifact_version: draft.artifact_version,
    observed_at: draft.observed_at,
    stale: 0,
    stale_reason: null,
    content_hash: contentHash,
    row_version: 1,
  };

  const view: StateFactView = {
    schema_version: "rsi.state_fact/1",
    fact_id: factId,
    binding: draft.binding,
    kind: draft.kind,
    subject: draft.subject,
    value: draft.value,
    truth_state: draft.truth_state,
    stale: false,
    stale_reason: null,
    source_ref: draft.source_ref,
    producer_ref: draft.producer_ref,
    verifier_ref: null,
    artifact_version: draft.artifact_version,
    observed_at: draft.observed_at,
    verifiers: [],
    row_version: 1,
  };

  return ledgerOk({ fact_id: factId, content_hash: contentHash, row, view });
}
