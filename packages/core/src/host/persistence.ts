/**
 * HOST persistence contracts (DD-HOST-001, DD-CAP-008).
 *
 * Eight typed StateRow tables: `progress_checkpoint`, `trigger_event`,
 * `pending_entry` and the five trust tables. Logical DTOs never go to
 * `appendStateRows`; only the physical rows below are written, with JSON
 * columns as JCS text.
 */

import { canonicalJsonText } from "../canonical.js";
import { canonicalHash } from "../hash.js";
import type { Hash } from "../hash.js";
import { toJsonValue, type JsonValue } from "../json.js";
import type { SourceRef } from "../source-ref.js";
import type { ErrorEnvelope } from "../errors.js";
import { makeErrorEnvelope } from "../errors.js";
import { err, ok, type Result } from "../result.js";
import type { VersionBinding } from "../version-binding.js";
import { objectDocumentId } from "../generated/state-row-keys.js";
import type {
  AdapterDescriptor,
  CapabilityBinding,
  CapabilityName,
  CapabilityStatus,
  ConfigSpace,
  EvidenceStage,
  HostEventBinding,
  HostId,
  HostMode,
  HostProbeRecord,
  HostProbeResult,
  CapabilityRecord,
  PendingEntry,
  ProgressCheckpoint,
  TriggerEvent,
  TriggerKind,
  TriggerReasonCode
} from "./types.js";
import { capabilityBindingKey, descriptorToJson } from "./keys.js";
import { pendingSourceRefs } from "./trigger/pending.js";

/** Read model for `adapter_registration` (DD-HOST-001). */
export interface AdapterRegistrationView {
  registration_hash: Hash;
  adapter_id: import("../ids.js").Id<"adp">;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  target_id: string;
  adapter_version: string;
  implementation_hash: Hash;
  descriptor_hash: Hash;
  artifact_ref: SourceRef;
  artifact_hash: Hash;
  expected_previous_hash: Hash | null;
  approval_id: import("../ids.js").Id<"iap">;
  approval_hash: Hash;
  approval_subject_hash: Hash;
  approval_consumption_ref: SourceRef | null;
  state: "intent" | "applying" | "applied" | "failed" | "unknown" | "superseded" | "detached";
  written_hash: Hash | null;
  failure_code: string | null;
  created_at: number;
  applied_at: number | null;
  updated_at: number;
  row_version: number;
  descriptor: AdapterDescriptor | null;
}

/** Read model for `adapter_descriptor_snapshot` (DD-HOST-001). */
export interface AdapterDescriptorSnapshotView {
  registration_hash: Hash;
  descriptor_hash: Hash;
  descriptor: AdapterDescriptor;
  created_at: number;
}

/** Read model for `host_human_confirmation` (DD-HOST-001). */
export interface HostHumanConfirmationView {
  confirmation_id: string;
  binding: CapabilityBinding;
  binding_key: Hash;
  host_binding: HostEventBinding;
  event_identity_key: Hash;
  challenge_nonce: string;
  probe_id: import("../ids.js").Id<"prb">;
  state: "pending" | "confirmed" | "failed" | "expired";
  evidence_ref: SourceRef | null;
  created_at: number;
  confirmed_at: number | null;
  updated_at: number;
  row_version: number;
}

/* ------------------------------------------------------------------ */
/* Physical rows                                                       */
/* ------------------------------------------------------------------ */

export interface ProgressCheckpointPhysicalRow {
  checkpoint_id: import("../ids.js").Id<"chk">;
  owner: "host";
  object_type: "progress_checkpoint";
  revision: 1;
  state: "recorded";
  checkpoint_kind: "input_boundary" | "stable_boundary";
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  trigger_event_id: import("../ids.js").Id<"trg">;
  source_event_ref: SourceRef;
  source_refs_json: string;
  content_hash: Hash;
  created_at: number;
}

export interface TriggerEventPhysicalRow {
  trigger_event_id: import("../ids.js").Id<"trg">;
  owner: "host";
  object_type: "trigger_event";
  revision: 1;
  state: "recorded";
  trigger_kind: TriggerKind;
  decision: "enqueue" | "skip" | "defer" | "suppress";
  decision_reason: TriggerReasonCode;
  trigger_dedupe_key: Hash;
  source_event_key: Hash;
  boundary_key: Hash;
  signal_digest: Hash;
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  source_event_ref: SourceRef;
  source_refs_json: string;
  content_hash: Hash;
  decided_at: number;
}

export interface PendingEntryPhysicalRow {
  pending_id: import("../ids.js").Id<"pen">;
  owner: "host";
  object_type: "pending_entry";
  row_version: number;
  record_state: "recorded";
  pending_key: Hash;
  kind: PendingEntry["kind"];
  pending_state: string;
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  trigger_event_id: import("../ids.js").Id<"trg"> | null;
  deadline_at: number | null;
  attempt: number;
  created_at: number;
  updated_at: number;
  session_ref: string | null;
  boundary_event_ref: string | null;
  delivery_target_hash: Hash | null;
  boundary_key: Hash | null;
  review_job_id: import("../ids.js").Id<"job"> | null;
  source_refs_json: string;
  content_hash: Hash;
}

export interface AdapterRegistrationPhysicalRow {
  registration_hash: Hash;
  adapter_id: import("../ids.js").Id<"adp">;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  target_id: string;
  adapter_version: string;
  implementation_hash: Hash;
  descriptor_hash: Hash;
  artifact_ref: SourceRef;
  artifact_hash: Hash;
  expected_previous_hash: Hash | null;
  approval_id: import("../ids.js").Id<"iap">;
  approval_hash: Hash;
  approval_subject_hash: Hash;
  approval_consumption_ref: SourceRef | null;
  state: "intent" | "applying" | "applied" | "failed" | "unknown" | "superseded" | "detached";
  written_hash: Hash | null;
  failure_code: string | null;
  created_at: number;
  applied_at: number | null;
  updated_at: number;
  row_version: number;
}

export interface AdapterDescriptorSnapshotPhysicalRow {
  registration_hash: Hash;
  descriptor_hash: Hash;
  descriptor_json: string;
  created_at: number;
}

export interface HostProbePhysicalRow {
  probe_id: import("../ids.js").Id<"prb">;
  binding_key: Hash;
  binding_json: string;
  subject: CapabilityBinding["subject"];
  target_kind: "host" | "jev_api" | "filesystem";
  probe_contract_version: "host-probe/2";
  probe_mode: "read_only" | "temp_fixture";
  fixture_ref: SourceRef | null;
  probe_action: string;
  assertions_json: string;
  capability_results_json: string;
  result: HostProbeResult;
  blocker_json: string | null;
  expected: string;
  observed: string;
  evidence_refs_json: string;
  duration_ms: number;
  checked_at: number;
  row_version: number;
}

export interface CapabilityRecordPhysicalRow {
  capability_id: import("../ids.js").Id<"cap">;
  binding_key: Hash;
  binding_json: string;
  name: CapabilityName;
  status: CapabilityStatus;
  evidence_stage: EvidenceStage;
  evidence_refs_json: string;
  probe_ref: string | null;
  probe_result: HostProbeResult | null;
  blocker_code: string | null;
  failure_code: string | null;
  checked_at: number;
  verified_at: number | null;
  last_verified_at: number | null;
  details_json: string;
  legacy_json: string | null;
  row_version: number;
}

export interface HostHumanConfirmationPhysicalRow {
  confirmation_id: string;
  binding_key: Hash;
  binding_json: string;
  host_binding_json: string;
  event_identity_key: Hash;
  challenge_nonce: string;
  probe_id: import("../ids.js").Id<"prb">;
  state: "pending" | "confirmed" | "failed" | "expired";
  evidence_ref: SourceRef | null;
  created_at: number;
  confirmed_at: number | null;
  updated_at: number;
  row_version: number;
}

/* ------------------------------------------------------------------ */
/* Object document / head rows and commit outcomes                     */
/* ------------------------------------------------------------------ */

export interface HostObjectDocumentRow {
  document_id: Hash;
  owner: "host";
  object_type: "progress_checkpoint" | "trigger_event" | "pending_entry";
  object_id: string;
  revision: number;
  schema_version: string;
  state: "recorded";
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  content_hash: Hash;
  canonical_json: string;
  created_at: number;
}

export interface HostObjectHeadRow {
  object_id: string;
  owner: "host";
  object_type: "progress_checkpoint" | "trigger_event" | "pending_entry";
  document_id: Hash;
  revision: number;
  state: "recorded";
  content_hash: Hash;
}

export interface HostStateRowInsertion<Row extends object = object> {
  row_schema: string;
  operation: "insert" | "transition";
  row: Row;
  document_id: Hash | null;
}

export interface HostStateRowAppendInput {
  binding: VersionBinding | null;
  rows: readonly HostStateRowInsertion[];
  documents: readonly HostObjectDocumentRow[];
  heads: readonly HostObjectHeadRow[];
}

export interface LiveCommitReceipt {
  batch_hash: Hash;
  first_commit_seq: number;
  last_commit_seq: number;
}

export type LiveCommitState = "committed" | "existing" | "not_written" | "unknown_recovery_required";

export type LiveCommitOutcome<Value> =
  | { ok: true; commit_state: "committed" | "existing"; receipt?: LiveCommitReceipt; value: Value }
  | { ok: false; commit_state: "not_written" | "unknown_recovery_required"; error: ErrorEnvelope };

/** FND `StateRowPort.appendStateRows` structural port. */
export interface HostStateRowAppendPort {
  appendStateRows(input: HostStateRowAppendInput): Promise<LiveCommitOutcome<null>>;
}

/* ------------------------------------------------------------------ */
/* Registrations                                                       */
/* ------------------------------------------------------------------ */

export interface HostStateRowRegistration {
  row_schema: string;
  owner_domain: "host";
  table: string;
  primary_key: readonly string[];
  unique_keys: readonly (readonly string[])[];
  event_types: readonly ["state_row.recorded"];
  allowed_operations: readonly ("insert" | "transition")[];
  binding_source: "row" | "none";
  row_versioned: boolean;
  blob_ref_paths: readonly string[];
  document: null | {
    owner: "host";
    object_type: "progress_checkpoint" | "trigger_event" | "pending_entry";
    object_id_field: string;
    revision_field: string;
  };
  allocation: null;
  schema_artifact: string;
  ts_type: string;
}

export const progressCheckpointRegistration: HostStateRowRegistration = {
  row_schema: "rsi.progress_checkpoint_row/1",
  owner_domain: "host",
  table: "progress_checkpoint",
  primary_key: ["checkpoint_id"],
  unique_keys: [["trigger_event_id", "checkpoint_kind"]],
  event_types: ["state_row.recorded"],
  allowed_operations: ["insert"],
  binding_source: "row",
  row_versioned: false,
  blob_ref_paths: ["/source_event_ref", "/source_refs_json#/[*]"],
  document: {
    owner: "host",
    object_type: "progress_checkpoint",
    object_id_field: "checkpoint_id",
    revision_field: "revision"
  },
  allocation: null,
  schema_artifact: "schemas/domains/host/progress_checkpoint_row.schema.json",
  ts_type: "ProgressCheckpointPhysicalRow"
};

export const hostTriggerEventRegistration: HostStateRowRegistration = {
  row_schema: "rsi.trigger_event_row/1",
  owner_domain: "host",
  table: "trigger_event",
  primary_key: ["trigger_event_id"],
  unique_keys: [],
  event_types: ["state_row.recorded"],
  allowed_operations: ["insert"],
  binding_source: "row",
  row_versioned: false,
  blob_ref_paths: ["/source_event_ref", "/source_refs_json#/[*]"],
  document: {
    owner: "host",
    object_type: "trigger_event",
    object_id_field: "trigger_event_id",
    revision_field: "revision"
  },
  allocation: null,
  schema_artifact: "schemas/domains/host/trigger_event_row.schema.json",
  ts_type: "TriggerEventPhysicalRow"
};

export const hostPendingEntryRegistration: HostStateRowRegistration = {
  row_schema: "rsi.pending_entry_row/1",
  owner_domain: "host",
  table: "pending_entry",
  primary_key: ["pending_id"],
  unique_keys: [["pending_key"]],
  event_types: ["state_row.recorded"],
  allowed_operations: ["insert", "transition"],
  binding_source: "row",
  row_versioned: true,
  blob_ref_paths: ["/source_refs_json#/[*]"],
  document: {
    owner: "host",
    object_type: "pending_entry",
    object_id_field: "pending_id",
    revision_field: "row_version"
  },
  allocation: null,
  schema_artifact: "schemas/domains/host/pending_entry_row.schema.json",
  ts_type: "PendingEntryPhysicalRow"
};

export const hostTrustRegistrations: readonly HostStateRowRegistration[] = [
  {
    row_schema: "rsi.adapter_registration_row/1",
    owner_domain: "host",
    table: "adapter_registration",
    primary_key: ["registration_hash"],
    unique_keys: [],
    event_types: ["state_row.recorded"],
    allowed_operations: ["insert", "transition"],
    binding_source: "none",
    row_versioned: true,
    blob_ref_paths: ["/artifact_ref", "/approval_consumption_ref"],
    document: null,
    allocation: null,
    schema_artifact: "schemas/domains/host/adapter_registration_row.schema.json",
    ts_type: "AdapterRegistrationPhysicalRow"
  },
  {
    row_schema: "rsi.adapter_descriptor_snapshot_row/1",
    owner_domain: "host",
    table: "adapter_descriptor_snapshot",
    primary_key: ["registration_hash"],
    unique_keys: [],
    event_types: ["state_row.recorded"],
    allowed_operations: ["insert"],
    binding_source: "none",
    row_versioned: false,
    blob_ref_paths: [],
    document: null,
    allocation: null,
    schema_artifact: "schemas/domains/host/adapter_descriptor_snapshot_row.schema.json",
    ts_type: "AdapterDescriptorSnapshotPhysicalRow"
  },
  {
    row_schema: "rsi.host_probe_row/1",
    owner_domain: "host",
    table: "host_probe",
    primary_key: ["probe_id"],
    unique_keys: [],
    event_types: ["state_row.recorded"],
    allowed_operations: ["insert", "transition"],
    binding_source: "none",
    row_versioned: true,
    blob_ref_paths: [
      "/fixture_ref",
      "/assertions_json#/[*]/observed_ref",
      "/capability_results_json#/[*]/proposed_details_ref",
      "/capability_results_json#/[*]/evidence_refs/[*]",
      "/blocker_json#/detail_ref",
      "/evidence_refs_json#/[*]"
    ],
    document: null,
    allocation: null,
    schema_artifact: "schemas/domains/host/host_probe_row.schema.json",
    ts_type: "HostProbePhysicalRow"
  },
  {
    row_schema: "rsi.capability_record_row/1",
    owner_domain: "host",
    table: "capability_record",
    primary_key: ["capability_id"],
    unique_keys: [["binding_key", "name"]],
    event_types: ["state_row.recorded"],
    allowed_operations: ["insert", "transition"],
    binding_source: "none",
    row_versioned: true,
    blob_ref_paths: [
      "/evidence_refs_json#/[*]",
      "/details_json#/hard_block_evidence_ref",
      "/details_json#/mapping_ref",
      "/details_json#/stable_predicate_ref",
      "/details_json#/isolation/evidence_refs/[*]"
    ],
    document: null,
    allocation: null,
    schema_artifact: "schemas/domains/host/capability_record_row.schema.json",
    ts_type: "CapabilityRecordPhysicalRow"
  },
  {
    row_schema: "rsi.host_human_confirmation_row/1",
    owner_domain: "host",
    table: "host_human_confirmation",
    primary_key: ["confirmation_id"],
    unique_keys: [["binding_key", "event_identity_key", "challenge_nonce"], ["probe_id"]],
    event_types: ["state_row.recorded"],
    allowed_operations: ["insert", "transition"],
    binding_source: "none",
    row_versioned: true,
    blob_ref_paths: ["/evidence_ref"],
    document: null,
    allocation: null,
    schema_artifact: "schemas/domains/host/host_human_confirmation_row.schema.json",
    ts_type: "HostHumanConfirmationPhysicalRow"
  }
];

export const hostDurableRegistrations: readonly HostStateRowRegistration[] = [
  hostTriggerEventRegistration,
  hostPendingEntryRegistration
];

/** All eight HOST StateRow registrations, in design order. */
export const HOST_STATE_ROW_REGISTRATIONS: readonly HostStateRowRegistration[] = [
  progressCheckpointRegistration,
  ...hostTrustRegistrations,
  ...hostDurableRegistrations
];

/* ------------------------------------------------------------------ */
/* DTO → PhysicalRow mappings                                          */
/* ------------------------------------------------------------------ */

/** `source_refs` closure for a TriggerEvent document (DD-HOST-001). */
export function triggerEventSourceRefs(event: TriggerEvent): string[] {
  const refs: string[] = [event.source_event_ref, event.raw_event_ref, event.policy_snapshot_ref];
  if (event.stable_evidence_ref !== undefined) {
    refs.push(event.stable_evidence_ref);
  }
  for (const signal of event.signals) {
    refs.push(...signal.evidence_refs);
  }
  refs.push(...event.evidence_refs);
  if (event.origin.evidence_ref !== undefined) {
    refs.push(event.origin.evidence_ref);
  }
  for (const work of event.boundary.pending_work_refs) {
    refs.push(work.evidence_ref);
  }
  return Array.from(new Set(refs)).sort();
}

/** `source_refs_json` closure for a progress checkpoint (DD-TRG-011). */
export function progressCheckpointSourceRefs(
  checkpoint: ProgressCheckpoint,
  triggerEvent: Pick<TriggerEvent, "source_event_ref">
): string[] {
  const refs: string[] = [triggerEvent.source_event_ref];
  for (const field of checkpoint.pending_observation.fields) {
    if (field.state === "present" && field.ref !== undefined) {
      refs.push(field.ref);
    }
  }
  return Array.from(new Set(refs)).sort();
}

export function toProgressCheckpointPhysicalRow(
  checkpoint: ProgressCheckpoint,
  triggerEvent: Pick<TriggerEvent, "source_event_ref">
): ProgressCheckpointPhysicalRow {
  return {
    checkpoint_id: checkpoint.checkpoint_id,
    owner: "host",
    object_type: "progress_checkpoint",
    revision: 1,
    state: "recorded",
    checkpoint_kind: checkpoint.checkpoint_kind,
    task_id: checkpoint.task_id,
    branch_id: checkpoint.branch_id,
    input_epoch: checkpoint.input_epoch,
    goal_version: checkpoint.goal_version,
    config_version: checkpoint.config_version,
    watermark: checkpoint.watermark,
    trigger_event_id: checkpoint.trigger_event_id,
    source_event_ref: triggerEvent.source_event_ref,
    source_refs_json: canonicalJsonText(progressCheckpointSourceRefs(checkpoint, triggerEvent)),
    content_hash: canonicalHash(progressCheckpointDocumentJson(checkpoint)),
    created_at: checkpoint.created_at
  };
}

export function progressCheckpointDocumentJson(checkpoint: ProgressCheckpoint): JsonValue {
  return checkpointDocumentJson(checkpoint);
}

function checkpointDocumentJson(value: ProgressCheckpoint): JsonValue {
  const document: { [key: string]: JsonValue } = {
    schema_version: value.schema_version,
    checkpoint_id: value.checkpoint_id,
    task_id: value.task_id,
    branch_id: value.branch_id,
    input_epoch: value.input_epoch,
    goal_version: value.goal_version,
    config_version: value.config_version,
    watermark: value.watermark,
    trigger_event_id: value.trigger_event_id,
    checkpoint_kind: value.checkpoint_kind,
    task_process_state: value.task_process_state,
    comparability_key: value.comparability_key,
    requirement_versions: value.requirement_versions.map<JsonValue>((entry) => ({
      requirement_id: entry.requirement_id,
      version: entry.version,
      state: entry.state
    })),
    evidence_digest: value.evidence_digest,
    artifact_digest: value.artifact_digest,
    verification_digest: value.verification_digest,
    information_digest: value.information_digest,
    new_information: {
      evidence: value.new_information.evidence,
      artifacts: value.new_information.artifacts,
      verification: value.new_information.verification,
      requirement_transitions: value.new_information.requirement_transitions,
      issue_transitions: value.new_information.issue_transitions
    },
    consecutive_no_info: value.consecutive_no_info,
    span_from_baseline_ms: value.span_from_baseline_ms,
    pending_observation: pendingObservationJson(value.pending_observation),
    evidence_coverage: value.evidence_coverage,
    step_effect_shadow: stepEffectShadowJson(value.step_effect_shadow),
    policy_ref: policyRefJson(value.policy_ref),
    created_at: value.created_at
  };
  if (value.baseline_checkpoint_id !== undefined) {
    document["baseline_checkpoint_id"] = value.baseline_checkpoint_id;
  }
  if (value.previous_comparable_checkpoint_id !== undefined) {
    document["previous_comparable_checkpoint_id"] = value.previous_comparable_checkpoint_id;
  }
  return document;
}

function pendingObservationJson(value: ProgressCheckpoint["pending_observation"]): JsonValue {
  return {
    state: value.state,
    fields: value.fields.map<JsonValue>((field) => {
      const json: { [key: string]: JsonValue } = { field: field.field, state: field.state };
      if (field.ref !== undefined) {
        json["ref"] = field.ref;
      }
      return json;
    })
  };
}

function stepEffectShadowJson(value: ProgressCheckpoint["step_effect_shadow"]): JsonValue {
  const json: { [key: string]: JsonValue } = {
    status: value.status,
    evidence_refs: value.evidence_refs
  };
  if (value.skip_reason !== undefined) {
    json["skip_reason"] = value.skip_reason;
  }
  if (value.escalation !== undefined) {
    json["escalation"] = value.escalation;
  }
  if (value.stale !== undefined) {
    json["stale"] = value.stale;
  }
  if (value.stale_reason !== undefined) {
    json["stale_reason"] = value.stale_reason;
  }
  if (value.route_ref !== undefined) {
    json["route_ref"] = value.route_ref;
  }
  if (value.cost !== undefined) {
    const cost: { [key: string]: JsonValue } = {
      status: value.cost.status,
      elapsed_ms: value.cost.elapsed_ms,
      cpu_ms: value.cost.cpu_ms,
      read_bytes: value.cost.read_bytes,
      retrieval_count: value.cost.retrieval_count,
      model_invocations: value.cost.model_invocations,
      verifier_invocations: value.cost.verifier_invocations
    };
    if (value.cost.receipt_ref !== undefined) {
      cost["receipt_ref"] = value.cost.receipt_ref;
    }
    json["cost"] = cost;
  }
  return json;
}

function policyRefJson(value: ProgressCheckpoint["policy_ref"]): JsonValue {
  return {
    policy_id: value.policy_id,
    policy_version: value.policy_version,
    policy_hash: value.policy_hash,
    scope_key: value.scope_key
  };
}

export function triggerEventDocumentJson(event: TriggerEvent): JsonValue {
  const document: { [key: string]: JsonValue } = {
    schema_version: event.schema_version,
    trigger_event_id: event.trigger_event_id,
    trigger_kind: event.trigger_kind,
    source_event_ref: event.source_event_ref,
    raw_event_ref: event.raw_event_ref,
    host_binding: hostEventBindingJson(event.host_binding),
    policy_ref: policyRefJson(event.policy_ref),
    origin: triggerOriginJson(event.origin),
    request_intent: event.request_intent,
    scope: {
      task_id: event.scope.task_id,
      branch_id: event.scope.branch_id,
      input_epoch: event.scope.input_epoch,
      goal_version: event.scope.goal_version,
      config_version: event.scope.config_version
    },
    identity_quality: event.identity_quality,
    signals: event.signals.map<JsonValue>((signal) => ({
      type: signal.type,
      strength: signal.strength,
      detector_version: signal.detector_version,
      evidence_refs: signal.evidence_refs,
      issue_ids: signal.issue_ids,
      requirement_ids: signal.requirement_ids,
      detected_at: signal.detected_at
    })),
    boundary: {
      candidate: event.boundary.candidate,
      stable: event.boundary.stable,
      boundary_kind: event.boundary.boundary_kind,
      stable_event_ids: event.boundary.stable_event_ids,
      source_event_ids: event.boundary.source_event_ids,
      stable_watermark: event.boundary.stable_watermark,
      goal_version: event.boundary.goal_version,
      pending_state: event.boundary.pending_state,
      pending_work_refs: event.boundary.pending_work_refs.map<JsonValue>((work) => ({
        pending_id: work.pending_id,
        kind: work.kind,
        state: work.state,
        evidence_ref: work.evidence_ref
      })),
      unstable_reasons: event.boundary.unstable_reasons
    },
    review_scope_key: event.review_scope_key,
    capability_gate: event.capability_gate.map<JsonValue>((gate) => {
      const json: { [key: string]: JsonValue } = {
        name: gate.name,
        subject: gate.subject,
        required_status: gate.required_status,
        observed_status: gate.observed_status,
        evidence_stage: gate.evidence_stage,
        passed: gate.passed
      };
      if (gate.reason_code !== undefined) {
        json["reason_code"] = gate.reason_code;
      }
      return json;
    }),
    dedupe: {
      source_event_key: event.dedupe.source_event_key,
      boundary_key: event.dedupe.boundary_key,
      signal_digest: event.dedupe.signal_digest,
      trigger_dedupe_key: event.dedupe.trigger_dedupe_key
    },
    decision: event.decision,
    decision_reason: event.decision_reason,
    policy_snapshot_ref: event.policy_snapshot_ref,
    decision_version: 1,
    decided_at: event.decided_at,
    evidence_refs: event.evidence_refs
  };
  if (event.local_input_id !== undefined) {
    document["local_input_id"] = event.local_input_id;
  }
  if (event.stable_evidence_ref !== undefined) {
    document["stable_evidence_ref"] = event.stable_evidence_ref;
  }
  if (event.pending_ref !== undefined) {
    document["pending_ref"] = event.pending_ref;
  }
  if (event.review_job_id !== undefined) {
    document["review_job_id"] = event.review_job_id;
  }
  if (event.enqueue_request_ref !== undefined) {
    document["enqueue_request_ref"] = event.enqueue_request_ref;
  }
  if (event.authorization_ref !== undefined) {
    document["authorization_ref"] = event.authorization_ref;
  }
  if (event.scope.project_id !== undefined) {
    const scope = document["scope"] as { [key: string]: JsonValue };
    scope["project_id"] = event.scope.project_id;
  }
  return document;
}

export function hostEventBindingJson(binding: HostEventBinding): JsonValue {
  const json: { [key: string]: JsonValue } = {
    host_id: binding.host_id,
    host_version: binding.host_version,
    adapter_id: binding.adapter_id,
    adapter_version: binding.adapter_version,
    implementation_hash: binding.implementation_hash,
    mode: binding.mode,
    config_space: binding.config_space,
    host_event: binding.host_event,
    stream_id: binding.stream_id,
    receipt_seq: binding.receipt_seq,
    event_identity_key: binding.event_identity_key,
    received_at: binding.received_at
  };
  if (binding.native_session_id !== undefined) {
    json["native_session_id"] = binding.native_session_id;
  }
  if (binding.native_turn_id !== undefined) {
    json["native_turn_id"] = binding.native_turn_id;
  }
  if (binding.native_message_id !== undefined) {
    json["native_message_id"] = binding.native_message_id;
  }
  if (binding.native_event_id !== undefined) {
    json["native_event_id"] = binding.native_event_id;
  }
  if (binding.source_seq !== undefined) {
    json["source_seq"] = binding.source_seq;
  }
  if (binding.native_occurrence_id !== undefined) {
    json["native_occurrence_id"] = binding.native_occurrence_id;
  }
  if (binding.retry_of !== undefined) {
    json["retry_of"] = binding.retry_of;
  }
  if (binding.occurred_at !== undefined) {
    json["occurred_at"] = binding.occurred_at;
  }
  return json;
}

function triggerOriginJson(origin: TriggerEvent["origin"]): JsonValue {
  const json: { [key: string]: JsonValue } = {
    kind: origin.kind,
    evidence_kind: origin.evidence_kind,
    suppress_automatic: origin.suppress_automatic
  };
  if (origin.evidence_ref !== undefined) {
    json["evidence_ref"] = origin.evidence_ref;
  }
  if (origin.registry_entry_id !== undefined) {
    json["registry_entry_id"] = origin.registry_entry_id;
  }
  if (origin.ancestor_run_id !== undefined) {
    json["ancestor_run_id"] = origin.ancestor_run_id;
  }
  return json;
}

export function toTriggerEventPhysicalRow(event: TriggerEvent): TriggerEventPhysicalRow {
  return {
    trigger_event_id: event.trigger_event_id,
    owner: "host",
    object_type: "trigger_event",
    revision: 1,
    state: "recorded",
    trigger_kind: event.trigger_kind,
    decision: event.decision,
    decision_reason: event.decision_reason,
    trigger_dedupe_key: event.dedupe.trigger_dedupe_key,
    source_event_key: event.dedupe.source_event_key,
    boundary_key: event.dedupe.boundary_key,
    signal_digest: event.dedupe.signal_digest,
    task_id: event.scope.task_id,
    branch_id: event.scope.branch_id,
    input_epoch: event.scope.input_epoch,
    goal_version: event.scope.goal_version,
    config_version: event.scope.config_version,
    watermark: event.boundary.stable_watermark,
    source_event_ref: event.source_event_ref,
    source_refs_json: canonicalJsonText(triggerEventSourceRefs(event)),
    content_hash: canonicalHash(triggerEventDocumentJson(event)),
    decided_at: event.decided_at
  };
}

export function toPendingEntryPhysicalRow(
  entry: PendingEntry,
  watermark: number,
  rowVersion = 1
): PendingEntryPhysicalRow {
  const row: PendingEntryPhysicalRow = {
    pending_id: entry.pending_id,
    owner: "host",
    object_type: "pending_entry",
    row_version: rowVersion,
    record_state: "recorded",
    pending_key: entry.pending_key,
    kind: entry.kind,
    pending_state: entry.state,
    task_id: entry.task_id,
    branch_id: entry.branch_id,
    input_epoch: entry.input_epoch,
    goal_version: entry.goal_version,
    config_version: entry.config_version,
    watermark,
    host_id: entry.host_id,
    mode: entry.mode,
    config_space: entry.config_space,
    trigger_event_id: entry.trigger_event_id ?? null,
    deadline_at: entry.deadline_at ?? null,
    attempt: entry.attempt,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    session_ref: null,
    boundary_event_ref: null,
    delivery_target_hash: null,
    boundary_key: null,
    review_job_id: null,
    source_refs_json: canonicalJsonText(pendingSourceRefs(entry)),
    content_hash: canonicalHash(pendingDocumentJson(entry))
  };
  if (entry.kind === "delivery") {
    row.session_ref = entry.session_ref;
    row.boundary_event_ref = entry.boundary_event_ref;
    row.delivery_target_hash = entry.delivery_target_hash;
  } else if (entry.kind === "review_defer") {
    row.boundary_key = entry.boundary_key;
  } else {
    row.review_job_id = entry.review_job_id;
  }
  return row;
}

export function pendingDocumentJson(entry: PendingEntry): JsonValue {
  const base: { [key: string]: JsonValue } = {
    schema_version: entry.schema_version,
    pending_id: entry.pending_id,
    pending_key: entry.pending_key,
    kind: entry.kind,
    task_id: entry.task_id,
    branch_id: entry.branch_id,
    input_epoch: entry.input_epoch,
    goal_version: entry.goal_version,
    config_version: entry.config_version,
    host_id: entry.host_id,
    mode: entry.mode,
    config_space: entry.config_space,
    policy_ref: policyRefJson(entry.policy_ref),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    attempt: entry.attempt,
    evidence_refs: entry.evidence_refs,
    origin: entry.origin
  };
  if (entry.trigger_event_id !== undefined) {
    base["trigger_event_id"] = entry.trigger_event_id;
  }
  if (entry.deadline_at !== undefined) {
    base["deadline_at"] = entry.deadline_at;
  }
  if (entry.last_error !== undefined) {
    base["last_error"] = {
      code: entry.last_error.code,
      retryable: entry.last_error.retryable,
      detail_ref: entry.last_error.detail_ref
    };
  }
  if (entry.kind === "delivery") {
    base["state"] = entry.state;
    base["delivery_id"] = entry.delivery_id;
    base["session_ref"] = entry.session_ref;
    base["boundary_event_ref"] = entry.boundary_event_ref;
    base["delivery_target_hash"] = entry.delivery_target_hash;
    base["content_ref"] = entry.content_ref;
    base["content_hash"] = entry.content_hash;
    base["nonce"] = entry.nonce;
    base["wait_mode"] = entry.wait_mode;
    base["capability_snapshot_hash"] = entry.capability_snapshot_hash;
    base["submitted_certainty"] = entry.submitted_certainty;
    base["inclusion_level"] = entry.inclusion_level;
    base["no_blind_retry"] = true;
    if (entry.inclusion_evidence_ref !== undefined) {
      base["inclusion_evidence_ref"] = entry.inclusion_evidence_ref;
    }
  } else if (entry.kind === "review_defer") {
    base["state"] = entry.state;
    base["boundary_key"] = entry.boundary_key;
    base["review_scope_key"] = entry.review_scope_key;
    base["stable_event_ids"] = entry.stable_event_ids;
    base["stable_watermark"] = entry.stable_watermark;
    base["pending_work_refs"] = entry.pending_work_refs.map<JsonValue>((work) => ({
      pending_id: work.pending_id,
      kind: work.kind,
      state: work.state,
      evidence_ref: work.evidence_ref
    }));
    base["resume_requires"] = entry.resume_requires;
    if (entry.resume_trigger_event_id !== undefined) {
      base["resume_trigger_event_id"] = entry.resume_trigger_event_id;
    }
  } else {
    base["state"] = entry.state;
    base["review_job_id"] = entry.review_job_id;
    base["snapshot_ref"] = entry.snapshot_ref;
    base["backend_selection_ref"] = entry.backend_selection_ref;
    base["resume_entry"] = entry.resume_entry;
    base["attempts"] = entry.attempts;
    base["max_attempts"] = entry.max_attempts;
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Trust table mappings                                                */
/* ------------------------------------------------------------------ */

export function toCapabilityRecordPhysicalRow(
  dto: CapabilityRecord,
  rowVersion: number
): CapabilityRecordPhysicalRow {
  const row: CapabilityRecordPhysicalRow = {
    capability_id: dto.capability_id,
    binding_key: capabilityBindingKey(dto.binding),
    binding_json: canonicalJsonText(bindingJson(dto.binding)),
    name: dto.name,
    status: dto.status,
    evidence_stage: dto.evidence_stage,
    evidence_refs_json: canonicalJsonText(dto.evidence_refs),
    probe_ref: dto.probe_ref ?? null,
    probe_result: dto.probe_result ?? null,
    blocker_code: dto.blocker_code ?? null,
    failure_code: dto.failure_code ?? null,
    checked_at: dto.checked_at,
    verified_at: dto.verified_at ?? null,
    last_verified_at: dto.last_verified_at ?? null,
    details_json: canonicalJsonText(toJsonValue(dto.details)),
    legacy_json: dto.legacy === undefined ? null : canonicalJsonText(toJsonValue(dto.legacy)),
    row_version: rowVersion
  };
  return row;
}

export function toHostProbePhysicalRow(dto: HostProbeRecord, rowVersion: number): HostProbePhysicalRow {
  const row: HostProbePhysicalRow = {
    probe_id: dto.probe_id,
    binding_key: capabilityBindingKey(dto.binding),
    binding_json: canonicalJsonText(bindingJson(dto.binding)),
    subject: dto.binding.subject,
    target_kind: dto.target_kind,
    probe_contract_version: dto.probe_contract_version,
    probe_mode: dto.probe_mode,
    fixture_ref: dto.fixture_ref ?? null,
    probe_action: dto.probe_action,
    assertions_json: canonicalJsonText(toJsonValue(dto.assertions)),
    capability_results_json: canonicalJsonText(toJsonValue(dto.capability_results)),
    result: dto.result,
    blocker_json: dto.blocker === undefined ? null : canonicalJsonText(toJsonValue(dto.blocker)),
    expected: dto.expected,
    observed: dto.observed,
    evidence_refs_json: canonicalJsonText(dto.evidence_refs),
    duration_ms: dto.duration_ms,
    checked_at: dto.checked_at,
    row_version: rowVersion
  };
  return row;
}

export function capabilityBindingJson(binding: CapabilityBinding): JsonValue {
  return bindingJson(binding);
}

function bindingJson(binding: CapabilityBinding): JsonValue {
  const json: { [key: string]: JsonValue } = {
    host_id: binding.host_id,
    source_pin: {
      host_version: binding.source_pin.host_version,
      host_version_kind: binding.source_pin.host_version_kind,
      source_commit: binding.source_pin.source_commit
    },
    binary_pin: {
      binary_version: binding.binary_pin.binary_version,
      binary_hash: binding.binary_pin.binary_hash
    },
    adapter_version: binding.adapter_version,
    subject: binding.subject,
    mode: binding.mode,
    config_space: binding.config_space,
    root_id: binding.root_id,
    construction_path: binding.construction_path,
    execution_environment: {
      os: binding.execution_environment.os,
      arch: binding.execution_environment.arch,
      isolation: binding.execution_environment.isolation
    },
    mapping: binding.mapping
  };
  if (binding.backend_id !== undefined) {
    json["backend_id"] = binding.backend_id;
  }
  return json;
}

export function toAdapterRegistrationPhysicalRow(
  view: AdapterRegistrationView,
  rowVersion: number
): AdapterRegistrationPhysicalRow {
  return {
    registration_hash: view.registration_hash,
    adapter_id: view.adapter_id,
    host_id: view.host_id,
    mode: view.mode,
    config_space: view.config_space,
    target_id: view.target_id,
    adapter_version: view.adapter_version,
    implementation_hash: view.implementation_hash,
    descriptor_hash: view.descriptor_hash,
    artifact_ref: view.artifact_ref,
    artifact_hash: view.artifact_hash,
    expected_previous_hash: view.expected_previous_hash,
    approval_id: view.approval_id,
    approval_hash: view.approval_hash,
    approval_subject_hash: view.approval_subject_hash,
    approval_consumption_ref: view.approval_consumption_ref,
    state: view.state,
    written_hash: view.written_hash,
    failure_code: view.failure_code,
    created_at: view.created_at,
    applied_at: view.applied_at,
    updated_at: view.updated_at,
    row_version: rowVersion
  };
}

export function toAdapterDescriptorSnapshotPhysicalRow(
  registrationHash: Hash,
  descriptor: AdapterDescriptor,
  createdAt: number
): AdapterDescriptorSnapshotPhysicalRow {
  return {
    registration_hash: registrationHash,
    descriptor_hash: canonicalHash(descriptorToJson(descriptor)),
    descriptor_json: canonicalJsonText(descriptorToJson(descriptor)),
    created_at: createdAt
  };
}

export function toHostHumanConfirmationPhysicalRow(
  view: HostHumanConfirmationView,
  rowVersion: number
): HostHumanConfirmationPhysicalRow {
  return {
    confirmation_id: view.confirmation_id,
    binding_key: capabilityBindingKey(view.binding),
    binding_json: canonicalJsonText(bindingJson(view.binding)),
    host_binding_json: canonicalJsonText(hostEventBindingJson(view.host_binding)),
    event_identity_key: view.event_identity_key,
    challenge_nonce: view.challenge_nonce,
    probe_id: view.probe_id,
    state: view.state,
    evidence_ref: view.evidence_ref,
    created_at: view.created_at,
    confirmed_at: view.confirmed_at,
    updated_at: view.updated_at,
    row_version: rowVersion
  };
}

/* ------------------------------------------------------------------ */
/* Document and head builders                                          */
/* ------------------------------------------------------------------ */

export function buildObjectDocument(input: {
  owner: "host";
  object_type: "progress_checkpoint" | "trigger_event" | "pending_entry";
  object_id: string;
  revision: number;
  schema_version: string;
  document: JsonValue;
  binding: VersionBinding;
  createdAt: number;
}): HostObjectDocumentRow {
  const canonical = canonicalJsonText(input.document);
  return {
    document_id: objectDocumentId({
      owner: input.owner,
      object_type: input.object_type,
      object_id: input.object_id,
      revision: input.revision
    }) as Hash,
    owner: input.owner,
    object_type: input.object_type,
    object_id: input.object_id,
    revision: input.revision,
    schema_version: input.schema_version,
    state: "recorded",
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    input_epoch: input.binding.input_epoch,
    goal_version: input.binding.goal_version,
    config_version: input.binding.config_version,
    watermark: input.binding.watermark,
    content_hash: canonicalHash(input.document),
    canonical_json: canonical,
    created_at: input.createdAt
  };
}

export function buildObjectHead(input: {
  owner: "host";
  object_type: "progress_checkpoint" | "trigger_event" | "pending_entry";
  object_id: string;
  revision: number;
  document: JsonValue;
}): HostObjectHeadRow {
  return {
    object_id: input.object_id,
    owner: input.owner,
    object_type: input.object_type,
    document_id: objectDocumentId({
      owner: input.owner,
      object_type: input.object_type,
      object_id: input.object_id,
      revision: input.revision
    }) as Hash,
    revision: input.revision,
    state: "recorded",
    content_hash: canonicalHash(input.document)
  };
}

/* ------------------------------------------------------------------ */
/* JSON column parsing                                                 */
/* ------------------------------------------------------------------ */

/** Validates a physical JCS text column and returns the parsed JSON value. */
export function parseJcsColumn(text: string, path: string): Result<JsonValue, ErrorEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(jcsColumnError(path, "strict_json"));
  }
  if (!isJson(parsed)) {
    return err(jcsColumnError(path, "json_value"));
  }
  let canonical: string;
  try {
    canonical = canonicalJsonText(parsed);
  } catch {
    return err(jcsColumnError(path, "json_value"));
  }
  if (canonical !== text) {
    return err(jcsColumnError(path, "jcs_canonical"));
  }
  return ok(parsed);
}

function isJson(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJson(entry));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Object.values(value as Record<string, unknown>).every((entry) => isJson(entry));
  }
  return false;
}

function jcsColumnError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STATE_ROW_SCHEMA",
    category: "schema",
    message_key: "error.state_row_schema",
    stage: "host_physical_row_parse",
    details: { kind: "field", path, rule }
  });
}
