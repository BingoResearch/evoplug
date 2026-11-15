/**
 * CFG physical rows, logical→physical projection and row event hashes
 * (DD-CFG-159, DD-CFG-190, DD-CFG-192).
 *
 * `row_json` is the canonical JSON text of the complete physical row: every
 * DDL column, explicit `null`s, and `*_json` columns as JCS strings. The
 * physical row is never the logical DTO.
 */

import { canonicalJsonText } from "../canonical.js";
import { isHash, type Hash } from "../hash.js";
import { toJsonValue, type JsonValue } from "../json.js";
import type { Id } from "../ids.js";
import type { VersionBinding } from "../version-binding.js";
import type {
  CapacityEvidence,
  ConfigSpaceRef,
  ConfigTrial,
  FieldRegistrySnapshot,
  FieldSpec,
  ObservationRecord,
  TrialAttempt,
  TrialPlan
} from "./types.js";
import { configError } from "./errors.js";
import { computeRowAfterHash } from "./hash.js";

export const FIELD_SPEC_ROW_SCHEMA = "rsi.field_spec_row/1" as const;
export const REGISTRY_SNAPSHOT_ROW_SCHEMA = "rsi.registry_snapshot_row/1" as const;
export const CAPACITY_EVIDENCE_ROW_SCHEMA = "rsi.capacity_evidence_row/1" as const;
export const TRIAL_PLAN_ROW_SCHEMA = "rsi.trial_plan_row/2" as const;
export const CONFIG_TRIAL_ROW_SCHEMA = "rsi.config_trial_row/1" as const;
export const TRIAL_ATTEMPT_ROW_SCHEMA = "rsi.trial_attempt_row/1" as const;
export const CONFIG_OBSERVATION_ROW_SCHEMA = "rsi.config_observation_row/1" as const;
export const FIELD_CLAIM_ROW_SCHEMA = "rsi.field_claim_row/1" as const;

export type ConfigRowSchema =
  | typeof FIELD_SPEC_ROW_SCHEMA
  | typeof REGISTRY_SNAPSHOT_ROW_SCHEMA
  | typeof CAPACITY_EVIDENCE_ROW_SCHEMA
  | typeof TRIAL_PLAN_ROW_SCHEMA
  | typeof CONFIG_TRIAL_ROW_SCHEMA
  | typeof TRIAL_ATTEMPT_ROW_SCHEMA
  | typeof CONFIG_OBSERVATION_ROW_SCHEMA
  | typeof FIELD_CLAIM_ROW_SCHEMA;

export interface FieldSpecRow {
  snapshot_hash: Hash;
  field_id: Id<"fld">;
  schema_version: "rsi.field_spec/1";
  spec_hash: Hash;
  spec_json: string;
}

export interface RegistrySnapshotRow {
  snapshot_hash: Hash;
  schema_version: "rsi.field_registry_snapshot/1";
  registry_version: string;
  snapshot_json: string;
  created_at: number;
}

export interface CapacityEvidenceRow {
  evidence_hash: Hash;
  config_space_id: Hash;
  schema_version: "rsi.capacity_evidence/1";
  evidence_json: string;
  created_at: number;
}

export interface TrialPlanRow {
  plan_id: Id<"trial">;
  schema_version: "rsi.trial_plan/2";
  plan_hash: Hash;
  task_id: Id<"task">;
  branch_id: Id<"br">;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  plan_json: string;
  created_at: number;
}

export interface ConfigTrialRow {
  trial_id: Id<"ctr">;
  plan_id: Id<"trial">;
  config_space_id: Hash;
  phase: ConfigTrial["phase"];
  evidence_level: ConfigTrial["evidence_level"];
  outcome: ConfigTrial["outcome"];
  revision: number;
  task_id: Id<"task">;
  branch_id: Id<"br">;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  trial_json: string;
  created_at: number;
  updated_at: number;
}

export interface TrialAttemptRow {
  trial_id: Id<"ctr">;
  sequence: number;
  idempotency_key: string;
  request_hash: Hash;
  phase_before: TrialAttempt["phase_before"];
  phase_after: TrialAttempt["phase_after"];
  task_id: Id<"task">;
  branch_id: Id<"br">;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  attempt_json: string;
  started_at: number;
  finished_at: number | null;
}

export interface ConfigObservationRow {
  trial_id: Id<"ctr">;
  sample_id: string;
  observed_at: number;
  record_hash: Hash;
  schema_version: "rsi.config_observation/1";
  task_id: Id<"task">;
  branch_id: Id<"br">;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  observation_json: string;
}

export interface FieldClaimRow {
  config_space_id: Hash;
  field_id: Id<"fld">;
  trial_id: Id<"ctr">;
  schema_version: "rsi.field_claim_row/1";
  state: "held" | "released";
  claimed_at: number;
  released_at: number | null;
  task_id: Id<"task">;
  branch_id: Id<"br">;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
}

export type CfgPhysicalRow =
  | FieldSpecRow
  | RegistrySnapshotRow
  | CapacityEvidenceRow
  | TrialPlanRow
  | ConfigTrialRow
  | TrialAttemptRow
  | ConfigObservationRow
  | FieldClaimRow;

/* ------------------------------------------------------------------ */
/* Canonical JSON text                                                */
/* ------------------------------------------------------------------ */

export function jcsText(value: unknown): string {
  return canonicalJsonText(toJsonValue(value));
}

/** Column counts fixed by DD-CFG-189 (5/5/5/11/16/15/12/13). */
export const CFG_TABLE_COLUMN_COUNTS: Readonly<Record<string, number>> = {
  cfg_registry_snapshot: 5,
  cfg_field_spec: 5,
  cfg_capacity_evidence: 5,
  cfg_plan: 11,
  cfg_trial: 16,
  cfg_attempt: 15,
  cfg_observation: 12,
  cfg_field_claim: 13
};

/** Blob-bearing paths per row schema, copied verbatim from DD-CFG-159. */
export const BLOB_REF_PATHS: Readonly<Record<ConfigRowSchema, readonly string[]>> = {
  [FIELD_SPEC_ROW_SCHEMA]: [
    "/spec_json#/provenance[*]",
    "/spec_json#/value_schema/unverified/provenance",
    "/spec_json#/default_spec/fixed/provenance",
    "/spec_json#/default_spec/unknown/provenance"
  ],
  [REGISTRY_SNAPSHOT_ROW_SCHEMA]: [
    "/snapshot_json#/field_specs[*]/provenance[*]",
    "/snapshot_json#/field_specs[*]/value_schema/unverified/provenance",
    "/snapshot_json#/field_specs[*]/default_spec/fixed/provenance",
    "/snapshot_json#/field_specs[*]/default_spec/unknown/provenance"
  ],
  [CAPACITY_EVIDENCE_ROW_SCHEMA]: ["/evidence_json#/evidence_ref"],
  [TRIAL_PLAN_ROW_SCHEMA]: [
    "/plan_json#/capacity_evidence/evidence_ref",
    "/plan_json#/config_space_selector/trust_evidence_ref",
    "/plan_json#/baseline_capture/readback_refs[*]"
  ],
  [CONFIG_TRIAL_ROW_SCHEMA]: [
    "/trial_json#/close_audit_ref",
    "/trial_json#/current_config/readback_ref",
    "/trial_json#/rollback/readback_ref",
    "/trial_json#/recovery/attestation/attestation_ref",
    "/trial_json#/recovery/attestation/conflict_evidence_ref"
  ],
  [TRIAL_ATTEMPT_ROW_SCHEMA]: [
    "/attempt_json#/result/values[*]/evidence_ref",
    "/attempt_json#/result/probe/evidence_ref",
    "/attempt_json#/result/guardrails[*]/evidence_ref"
  ],
  [CONFIG_OBSERVATION_ROW_SCHEMA]: [
    "/observation_json#/evidence_ref",
    "/observation_json#/probe/evidence_ref",
    "/observation_json#/guardrails[*]/evidence_ref"
  ],
  [FIELD_CLAIM_ROW_SCHEMA]: []
};

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

export function fieldSpecRow(snapshotHash: Hash, spec: FieldSpec): FieldSpecRow {
  return {
    snapshot_hash: snapshotHash,
    field_id: spec.field_id,
    schema_version: "rsi.field_spec/1",
    spec_hash: spec.spec_hash,
    spec_json: jcsText(spec)
  };
}

export function registrySnapshotRow(snapshot: FieldRegistrySnapshot): RegistrySnapshotRow {
  return {
    snapshot_hash: snapshot.snapshot_hash,
    schema_version: "rsi.field_registry_snapshot/1",
    registry_version: snapshot.registry_version,
    snapshot_json: jcsText(snapshot),
    created_at: snapshot.created_at
  };
}

export function capacityEvidenceRow(evidence: CapacityEvidence, createdAt: number): CapacityEvidenceRow {
  return {
    evidence_hash: evidence.evidence_hash,
    config_space_id: evidence.config_space_id,
    schema_version: "rsi.capacity_evidence/1",
    evidence_json: jcsText(evidence),
    created_at: createdAt
  };
}

export function trialPlanRow(plan: TrialPlan): TrialPlanRow {
  return {
    plan_id: plan.plan_id,
    schema_version: "rsi.trial_plan/2",
    plan_hash: plan.plan_hash,
    task_id: plan.task_binding.task_id,
    branch_id: plan.task_binding.branch_id,
    input_epoch: plan.task_binding.input_epoch,
    goal_version: plan.task_binding.goal_version,
    config_version: plan.task_binding.config_version,
    watermark: plan.task_binding.watermark,
    plan_json: jcsText(plan),
    created_at: plan.created_at
  };
}

export function configTrialRow(trial: ConfigTrial, binding: VersionBinding): ConfigTrialRow {
  return {
    trial_id: trial.trial_id,
    plan_id: trial.plan_id,
    config_space_id: trial.config_space.config_space_id,
    phase: trial.phase,
    evidence_level: trial.evidence_level,
    outcome: trial.outcome,
    revision: trial.revision,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    trial_json: jcsText(trial),
    created_at: trial.created_at,
    updated_at: trial.updated_at
  };
}

export function trialAttemptRow(attempt: TrialAttempt, binding: VersionBinding): TrialAttemptRow {
  return {
    trial_id: attempt.trial_id,
    sequence: attempt.sequence,
    idempotency_key: attempt.idempotency_key,
    request_hash: attempt.request_hash,
    phase_before: attempt.phase_before,
    phase_after: attempt.phase_after,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    attempt_json: jcsText(attempt),
    started_at: attempt.started_at,
    finished_at: attempt.finished_at
  };
}

export function configObservationRow(record: ObservationRecord, binding: VersionBinding): ConfigObservationRow {
  return {
    trial_id: record.trial_id,
    sample_id: record.sample_id,
    observed_at: record.observed_at,
    record_hash: record.record_hash,
    schema_version: "rsi.config_observation/1",
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    observation_json: jcsText(record)
  };
}

export function fieldClaimRow(input: {
  config_space_id: Hash;
  field_id: Id<"fld">;
  trial_id: Id<"ctr">;
  claimed_at: number;
  released_at: number | null;
  binding: VersionBinding;
}): FieldClaimRow {
  return {
    config_space_id: input.config_space_id,
    field_id: input.field_id,
    trial_id: input.trial_id,
    schema_version: "rsi.field_claim_row/1",
    state: input.released_at === null ? "held" : "released",
    claimed_at: input.claimed_at,
    released_at: input.released_at,
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    input_epoch: input.binding.input_epoch,
    goal_version: input.binding.goal_version,
    config_version: input.binding.config_version,
    watermark: input.binding.watermark
  };
}

/** `row_json` for the wire: canonical text of the complete physical row. */
export function rowJson(row: CfgPhysicalRow): string {
  return jcsText(row);
}

export function afterHashFor(rowSchema: ConfigRowSchema, row: CfgPhysicalRow): Hash {
  return computeRowAfterHash(rowSchema, rowJson(row));
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type RowValidationCode = "E_STATE_ROW_SCHEMA" | "E_LEDGER_EVENT_INVALID" | "E_REBUILD_DIVERGENCE";

export type RowValidation =
  | { ok: true; row: CfgPhysicalRow }
  | { ok: false; code: RowValidationCode; detail: string };

function readObject(value: unknown): { [key: string]: JsonValue } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = toJsonValue(entry);
  }
  return record;
}

function parseJsonColumn(text: JsonValue | undefined): { [key: string]: JsonValue } | null {
  if (typeof text !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return readObject(parsed);
  } catch {
    return null;
  }
}

function check(
  row: Record<string, JsonValue>,
  jsonColumn: string,
  pairs: readonly (readonly [column: string, path: string])[]
): boolean {
  const body = parseJsonColumn(row[jsonColumn]);
  if (body === null) {
    return false;
  }
  for (const [column, path] of pairs) {
    const segments = path.split(".").filter((segment) => segment.length > 0);
    let current: JsonValue | undefined = body;
    for (const segment of segments) {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    const expected = row[column];
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected)) {
      return false;
    }
  }
  return true;
}

const BINDING_COLUMNS: readonly string[] = [
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "watermark"
];

/** Verifies a physical row's key/JSON agreement (DD-CFG-159, DD-CFG-190). */
export function validatePhysicalRow(rowSchema: ConfigRowSchema, row: CfgPhysicalRow): RowValidation {
  const record = readObject(row);
  if (record === null) {
    return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "row_not_object" };
  }
  switch (rowSchema) {
    case FIELD_SPEC_ROW_SCHEMA: {
      const spec = parseJsonColumn(record["spec_json"]);
      if (spec === null || !check(record, "spec_json", [["field_id", "field_id"], ["spec_hash", "spec_hash"]])) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "field_spec_json" };
      }
      if (spec["schema_version"] !== "rsi.field_spec/1") {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "field_spec_schema_version" };
      }
      break;
    }
    case REGISTRY_SNAPSHOT_ROW_SCHEMA: {
      const snapshot = parseJsonColumn(record["snapshot_json"]);
      if (snapshot === null || snapshot["snapshot_hash"] !== record["snapshot_hash"]) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "registry_snapshot_json" };
      }
      break;
    }
    case CAPACITY_EVIDENCE_ROW_SCHEMA: {
      const evidence = parseJsonColumn(record["evidence_json"]);
      if (
        evidence === null ||
        !check(record, "evidence_json", [
          ["evidence_hash", "evidence_hash"],
          ["config_space_id", "config_space_id"]
        ])
      ) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "capacity_evidence_json" };
      }
      break;
    }
    case TRIAL_PLAN_ROW_SCHEMA: {
      if (
        !check(record, "plan_json", [
          ["plan_id", "plan_id"],
          ["plan_hash", "plan_hash"],
          ["task_id", "task_binding.task_id"],
          ["branch_id", "task_binding.branch_id"],
          ["input_epoch", "task_binding.input_epoch"],
          ["goal_version", "task_binding.goal_version"],
          ["config_version", "task_binding.config_version"],
          ["watermark", "task_binding.watermark"]
        ])
      ) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "trial_plan_json" };
      }
      break;
    }
    case CONFIG_TRIAL_ROW_SCHEMA: {
      if (
        !check(record, "trial_json", [
          ["trial_id", "trial_id"],
          ["plan_id", "plan_id"],
          ["config_space_id", "config_space.config_space_id"],
          ["revision", "revision"]
        ])
      ) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "config_trial_json" };
      }
      if (typeof record["revision"] !== "number" || record["revision"] < 1) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "revision" };
      }
      break;
    }
    case TRIAL_ATTEMPT_ROW_SCHEMA: {
      if (
        !check(record, "attempt_json", [
          ["trial_id", "trial_id"],
          ["sequence", "sequence"],
          ["idempotency_key", "idempotency_key"],
          ["request_hash", "request_hash"],
          ["phase_before", "phase_before"],
          ["phase_after", "phase_after"]
        ])
      ) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "trial_attempt_json" };
      }
      break;
    }
    case CONFIG_OBSERVATION_ROW_SCHEMA: {
      if (
        !check(record, "observation_json", [
          ["trial_id", "trial_id"],
          ["sample_id", "sample_id"],
          ["observed_at", "observed_at"],
          ["record_hash", "record_hash"]
        ])
      ) {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "config_observation_json" };
      }
      break;
    }
    case FIELD_CLAIM_ROW_SCHEMA: {
      if (record["schema_version"] !== "rsi.field_claim_row/1") {
        return { ok: false, code: "E_STATE_ROW_SCHEMA", detail: "field_claim_schema_version" };
      }
      break;
    }
  }
  return { ok: true, row };
}

/** Re-encodes `row_json` and requires byte equality (DD-CFG-192). */
export function validateRowJsonCanonical(rowJsonText: string): RowValidationCode | null {
  try {
    const parsed: unknown = JSON.parse(rowJsonText);
    const reencoded = jcsText(parsed);
    return reencoded === rowJsonText ? null : "E_LEDGER_EVENT_INVALID";
  } catch {
    return "E_LEDGER_EVENT_INVALID";
  }
}

/** Binding columns must be present and equal on `binding="row"` tables. */
export function hasCompleteBinding(row: CfgPhysicalRow): boolean {
  const record = readObject(row);
  if (record === null) {
    return false;
  }
  return BINDING_COLUMNS.every((column) => record[column] !== undefined && record[column] !== null);
}

/** Helper for `startTrial`: requires the plan to exist and the capacity row to be committed. */
export function planCapacityEvidenceHash(plan: TrialPlan): Hash | null {
  return plan.capacity_evidence === null ? null : plan.capacity_evidence.evidence_hash;
}

/** Config-space identity check used by row binding tests. */
export function configSpaceMatches(ref: ConfigSpaceRef, configSpaceId: Hash): boolean {
  return ref.config_space_id === configSpaceId && isHash(ref.semantic_hash);
}
