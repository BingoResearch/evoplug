/**
 * Proposal ingestion, P0a–S9 static checks and trusted normalization
 * (DD-REV-050, DD-REV-051, DD-REV-060).
 *
 * The candidate is untrusted. Every field that identifies an Experience,
 * Version, ValidationPlan or risk is produced by REV from the snapshot,
 * target resolution and VerifierRegistry. The first failing step wins and is
 * the only failure recorded.
 */

import {
  canonicalJson,
  canonicalHash,
  compareUtf8,
  hashBytes,
  isHash,
  isSourceRef,
  sortUtf8,
  toJsonValue
} from "@evoplug/core";
import type { Hash, Id, JsonValue, Result, SourceRef } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ErrorEnvelope } from "@evoplug/core";
import type { HostId, HostMode } from "./host-contracts.js";

import { applyDiff } from "./diff.js";
import {
  experienceBodyBytes,
  experienceContentHash,
  type RefineSource,
  resolveLineage,
  TYPE_REQUIREMENTS,
  validatePlanSourceRefs,
  validateValidationPlan,
  buildValidationPlan,
  planHasNoVerifier
} from "./experience.js";
import { candidateKeyFrom, proposalFailureToEnvelope } from "./storage.js";
import type { CandidateKeyInput } from "./types.js";
import type { VerifierRegistryEntry } from "./judge-contracts.js";
import type {
  CandidateFailureStep,
  Experience,
  ExperienceCandidate,
  ExperienceExpiryPolicy,
  ExperienceRisk,
  ExperienceScope,
  ExperienceType,
  Proposal,
  ProposalCandidate,
  ProposalTarget,
  ProposalFailureCode,
  ProposalGenerator,
  ProposalMatchJudge,
  ReviewSnapshot,
  ValidationPlan,
  ValidationPlanCandidate
} from "./types.js";
import {
  REVIEW_DIFF_MAX_BYTES,
  REVIEW_EXPERIENCE_BODY_MAX_BYTES
} from "./snapshot.js";

export const STATIC_CHECK_ORDER: readonly CandidateFailureStep[] = [
  "P0a",
  "P0b",
  "S0a",
  "S0b",
  "S0c",
  "S1a",
  "S1b",
  "S2a",
  "S2b",
  "S3a",
  "S3b",
  "S3c",
  "S4",
  "S5",
  "S6",
  "S7a",
  "S7b",
  "S8",
  "S9"
];

export interface ResolvedTarget {
  target_ref: string;
  host_id: HostId;
  project_id?: string;
  object_type: ProposalTarget["object_type"];
  config_space: string;
  mode: HostMode;
  path_or_block: string;
  block_id?: string;
  ownership: ProposalTarget["ownership"];
  write_mode: ProposalTarget["write_mode"];
  block_selector: string | null;
  approved_root: string;
  target_binding_ref: SourceRef;
  exists: boolean;
}

export interface CandidateHashes {
  candidate_file_bytes: Uint8Array;
  candidate_file_hash: Hash;
  candidate_block_hash: Hash | null;
  candidate_hash: Hash;
  base_bytes: Uint8Array;
  block_base: string | null;
  applies_to_hash: Hash;
}

export interface TargetCurrentHashes {
  file_hash: Hash;
  block_hash: Hash | null;
}

export interface AllocationInput {
  candidate: ProposalCandidate;
  target: ResolvedTarget;
  lineage: "create" | "refine" | "restore";
  experience_id: string | null;
  existing_versions: readonly number[];
}

export interface AllocationResult {
  experience_id: string;
  version: number;
  validation_plan_id: string;
  proposal_id: string;
}

export interface NormalizationResult {
  scope: ExperienceScope;
  risk: ExperienceRisk;
  risk_policy_ref: SourceRef;
  scope_source_ref: SourceRef;
  template_hash: Hash;
  generator: ProposalGenerator;
}

export interface StaticCheckContext {
  snapshot: ReviewSnapshot;
  /** Resolves the target through FND; `E_PROPOSAL_TARGET` on failure. */
  resolveTarget(target: ProposalCandidate["target"]): Result<ResolvedTarget, ErrorEnvelope>;
  /** Reads the base snapshot the candidate declares; `create` uses empty bytes. */
  readBase(target: ResolvedTarget): Result<Uint8Array, ErrorEnvelope>;
  /** Reads the current target bytes; `create` uses empty bytes. */
  readCurrentFile(target: ResolvedTarget): Result<Uint8Array, ErrorEnvelope>;
  currentTargetHashes(target: ResolvedTarget): Result<TargetCurrentHashes, ErrorEnvelope>;
  extractBlock(file: Uint8Array, selector: string): Result<string, ErrorEnvelope>;
  rebuildFile(file: Uint8Array, selector: string, block: string): Result<Uint8Array, ErrorEnvelope>;
  readSource(ref: SourceRef): Result<Uint8Array, ErrorEnvelope>;
  /** Freezes bytes and returns their immutable `SourceRef`. */
  materializeBlob(bytes: Uint8Array): Result<SourceRef, ErrorEnvelope>;
  resolveVerifier(ref: SourceRef): Result<VerifierRegistryEntry, ErrorEnvelope>;
  refinable(ref: SourceRef): RefineSource | null;
  allocate(input: AllocationInput): Result<AllocationResult, ErrorEnvelope>;
  normalize(input: {
    candidate: ProposalCandidate;
    target: ResolvedTarget;
    lineage: "create" | "refine" | "restore";
    refines: RefineSource | null;
    verifier: VerifierRegistryEntry | null;
  }): Result<NormalizationResult, ErrorEnvelope>;
  checkScope(input: {
    candidate: ProposalCandidate;
    target: ResolvedTarget;
    normalizedScope: ExperienceScope;
    diffAdditions: string[];
  }): Result<void, ErrorEnvelope>;
  approvedEvidenceRefs: ReadonlySet<SourceRef>;
  snapshotEvidenceRefs: ReadonlySet<SourceRef>;
  approvedExperienceRefs: ReadonlySet<SourceRef>;
  retrievable(ref: SourceRef): boolean;
  allowedObjectTypes: ReadonlySet<ProposalTarget["object_type"]>;
  allowedTargetRefs: ReadonlySet<string>;
  protectedFields: ReadonlySet<string>;
  now: number;
}

export interface CandidateFailure {
  code: ProposalFailureCode;
  step: CandidateFailureStep;
  path: string;
  rule: string;
}

export type CandidateCheckResult =
  | {
      status: "accepted";
      proposal: Proposal;
      experience: Experience;
      validation_plan: ValidationPlan;
      checked_at: number;
      candidate_key: Hash;
      candidate_ref: SourceRef;
      candidate_json_hash: Hash;
      accepted_bundle_ref: SourceRef;
    }
  | {
      status: "rejected" | "stale";
      failure: CandidateFailure;
      checked_at: number;
    };

interface CheckFailure<T> {
  ok: false;
  failure: CandidateFailure;
}

function failure<T>(
  code: ProposalFailureCode,
  step: CandidateFailureStep,
  path: string,
  rule: string
): CheckFailure<T> {
  return { ok: false, failure: { code, step, path, rule } };
}

function succeed<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/* ------------------------------------------------------------------ */
/* S0: untrusted field scan and schema                                */
/* ------------------------------------------------------------------ */

export const RESERVED_EXPERIENCE_FIELDS: readonly string[] = [
  "experience_id",
  "version",
  "lineage",
  "risk",
  "scope",
  "content_hash",
  "validation_plan_id",
  "validation_plan_hash"
];

export const RESERVED_VERIFIER_FIELDS: readonly string[] = ["kind", "independence", "binding_ref"];

const PROPOSAL_KEYS: readonly string[] = [
  "schema_version",
  // The generator protocol carries the candidate ordinal inside the proposal
  // object; it is an envelope coordinate, not part of the ProposalCandidate
  // body, so it is accepted here and not copied into the parsed candidate.
  "ordinal",
  "change_kind",
  "object_type",
  "target",
  "expected_old_file_hash",
  "expected_old_block_hash",
  "diff_format",
  "diff_text",
  "candidate_hash",
  "experience",
  "validation_plan",
  "evidence_refs",
  "refines_experience_ref"
];

const TARGET_KEYS: readonly string[] = [
  "target_ref",
  "host_id",
  "project_id",
  "path_or_block",
  "block_id",
  "requested_write_mode"
];

const EXPERIENCE_CANDIDATE_KEYS: readonly string[] = [
  "schema_version",
  "type",
  "title",
  "summary",
  "trigger",
  "preconditions",
  "steps",
  "expected_effects",
  "completion_check",
  "failure_branches",
  "counterexamples",
  "expiry_policy",
  "evidence_refs"
];

const PLAN_CANDIDATE_KEYS: readonly string[] = [
  "schema_version",
  "expected_behavior",
  "required_loading_evidence",
  "verifier",
  "observation_window",
  "retention_rule",
  "stop_conditions",
  "replay"
];

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** S0a: reserved keys may not appear anywhere in the candidate. */
export function findReservedField(value: JsonValue): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findReservedField(item);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_EXPERIENCE_FIELDS.includes(key)) {
      return key;
    }
    if (key === "verifier" && isRecord(item)) {
      for (const verifierKey of Object.keys(item)) {
        if (RESERVED_VERIFIER_FIELDS.includes(verifierKey)) {
          return `verifier.${verifierKey}`;
        }
      }
    }
    const found = findReservedField(item);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

interface ParseFailure {
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA";
  path: string;
  rule: string;
}

function parseFailure(
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA",
  path: string,
  rule: string
): ParseFailure {
  return { code, path, rule };
}

function checkKnownKeys(
  object: { [key: string]: JsonValue },
  allowed: readonly string[],
  path: string,
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA"
): ParseFailure | null {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      return parseFailure(code, `${path}.${key}`, "known_field");
    }
  }
  return null;
}

function requireString(
  object: { [key: string]: JsonValue },
  key: string,
  path: string,
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA",
  minLength = 1,
  maxLength = Number.MAX_SAFE_INTEGER
): ParseFailure | string {
  const value = object[key];
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    return parseFailure(code, `${path}.${key}`, `string_${minLength}_${maxLength}`);
  }
  return value;
}

function requireArray(
  object: { [key: string]: JsonValue },
  key: string,
  path: string,
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA"
): ParseFailure | JsonValue[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    return parseFailure(code, `${path}.${key}`, "array");
  }
  return value;
}

function requireObject(
  object: { [key: string]: JsonValue },
  key: string,
  path: string,
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA"
): ParseFailure | { [key: string]: JsonValue } {
  const value = object[key];
  if (!isRecord(value)) {
    return parseFailure(code, `${path}.${key}`, "object");
  }
  return value;
}

function isParseFailure(value: ParseFailure | unknown): value is ParseFailure {
  return typeof value === "object" && value !== null && "code" in value && "path" in value;
}

function requireEnum<T extends string>(
  object: { [key: string]: JsonValue },
  key: string,
  allowed: readonly T[],
  path: string,
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA"
): ParseFailure | T {
  const value = object[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return parseFailure(code, `${path}.${key}`, allowed.join("|"));
  }
  return value as T;
}

function stringArray(value: JsonValue[], path: string, code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA"): ParseFailure | string[] {
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return parseFailure(code, path, "string_array");
    }
    result.push(item);
  }
  return result;
}

function sourceRefArray(
  value: JsonValue[],
  path: string,
  code: "E_PROPOSAL_SCHEMA" | "E_EXPERIENCE_SCHEMA"
): ParseFailure | SourceRef[] {
  const result: SourceRef[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isSourceRef(item)) {
      return parseFailure(code, path, "source_ref");
    }
    result.push(item);
  }
  return result;
}

const EXPERIENCE_TYPES: readonly ExperienceType[] = [
  "recovery_procedure",
  "tool_workflow",
  "project_constraint",
  "user_preference",
  "validation_check"
];

const LOADING_STAGES = ["written", "discovered", "included", "observed"] as const;
const VERIFIER_KINDS = [
  "test_pass",
  "artifact_check",
  "state_predicate",
  "human_acceptance",
  "external_verification",
  "none"
] as const;
const INDEPENDENCE = ["independent", "same_task_replay", "user_confirmation", "none"] as const;
const RETENTION_KINDS = [
  "deterministic_check",
  "preference_confirmation",
  "constraint_recheck",
  "workflow_evidence"
] as const;
const STOP_CONDITIONS = [
  "confirmed_regression",
  "user_revocation",
  "expiry",
  "conflict",
  "host_incompatible",
  "budget_exceeded"
] as const;
const REPLAY_REQUIREMENTS = ["none", "optional", "required"] as const;
const REPLAY_CLASSES = ["read_only", "sandboxed_temp"] as const;
const LIVE_EXTERNAL = ["observe_only", "explicit_approval"] as const;
const SIGNAL_KINDS = [
  "user_correction",
  "repeated_failure",
  "recovery_success",
  "task_boundary",
  "manual"
] as const;
const CHECK_KINDS = [
  "path_exists",
  "tool_available",
  "version_in_range",
  "evidence_ref",
  "human_confirm"
] as const;
const COMPLETION_KINDS = [
  "test_pass",
  "artifact_check",
  "state_predicate",
  "human_acceptance",
  "external_verification",
  "none"
] as const;

function parseExperienceCandidate(value: JsonValue): ParseFailure | ExperienceCandidate {
  if (!isRecord(value)) {
    return parseFailure("E_EXPERIENCE_SCHEMA", "experience", "object");
  }
  const known = checkKnownKeys(value, EXPERIENCE_CANDIDATE_KEYS, "experience", "E_EXPERIENCE_SCHEMA");
  if (known !== null) return known;
  if (value["schema_version"] !== "rsi.experience/1") {
    return parseFailure("E_EXPERIENCE_SCHEMA", "experience.schema_version", "const");
  }
  const type = requireEnum(value, "type", EXPERIENCE_TYPES, "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(type)) return type;
  const title = requireString(value, "title", "experience", "E_EXPERIENCE_SCHEMA", 1, 200);
  if (isParseFailure(title)) return title;
  const summary = requireString(value, "summary", "experience", "E_EXPERIENCE_SCHEMA", 1, 2048);
  if (isParseFailure(summary)) return summary;

  const triggerValue = requireObject(value, "trigger", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(triggerValue)) return triggerValue;
  const description = requireString(triggerValue, "description", "experience.trigger", "E_EXPERIENCE_SCHEMA", 1, 1024);
  if (isParseFailure(description)) return description;
  const signalValues = requireArray(triggerValue, "signal_kinds", "experience.trigger", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(signalValues)) return signalValues;
  const signalKinds: Array<(typeof SIGNAL_KINDS)[number]> = [];
  for (const item of signalValues) {
    if (typeof item !== "string" || !SIGNAL_KINDS.includes(item as (typeof SIGNAL_KINDS)[number])) {
      return parseFailure("E_EXPERIENCE_SCHEMA", "experience.trigger.signal_kinds", "enum");
    }
    signalKinds.push(item as (typeof SIGNAL_KINDS)[number]);
  }
  const taskFamilies = requireArray(triggerValue, "task_family_ids", "experience.trigger", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(taskFamilies)) return taskFamilies;
  const taskFamilyIds = stringArray(taskFamilies, "experience.trigger.task_family_ids", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(taskFamilyIds)) return taskFamilyIds;
  const toolNames = requireArray(triggerValue, "tool_names", "experience.trigger", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(toolNames)) return toolNames;
  const toolNameValues = stringArray(toolNames, "experience.trigger.tool_names", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(toolNameValues)) return toolNameValues;
  const pathPatterns = requireArray(triggerValue, "path_patterns", "experience.trigger", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(pathPatterns)) return pathPatterns;
  const pathPatternValues = stringArray(pathPatterns, "experience.trigger.path_patterns", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(pathPatternValues)) return pathPatternValues;
  if (pathPatternValues.length > 16) {
    return parseFailure("E_EXPERIENCE_SCHEMA", "experience.trigger.path_patterns", "max_16");
  }
  const negative = requireArray(triggerValue, "negative_triggers", "experience.trigger", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(negative)) return negative;
  const negativeValues = stringArray(negative, "experience.trigger.negative_triggers", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(negativeValues)) return negativeValues;
  if (negativeValues.length > 16) {
    return parseFailure("E_EXPERIENCE_SCHEMA", "experience.trigger.negative_triggers", "max_16");
  }

  const preconditionsValue = requireArray(value, "preconditions", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(preconditionsValue)) return preconditionsValue;
  const preconditions: ExperienceCandidate["preconditions"] = [];
  for (let index = 0; index < preconditionsValue.length; index += 1) {
    const item = preconditionsValue[index];
    if (!isRecord(item)) {
      return parseFailure("E_EXPERIENCE_SCHEMA", `experience.preconditions[${index}]`, "object");
    }
    const preconditionId = requireString(item, "precondition_id", `experience.preconditions[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(preconditionId)) return preconditionId;
    const statement = requireString(item, "statement", `experience.preconditions[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(statement)) return statement;
    const checkKind = requireEnum(item, "check_kind", CHECK_KINDS, `experience.preconditions[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(checkKind)) return checkKind;
    const refValue = item["check_params_ref"];
    let checkParamsRef: SourceRef | undefined;
    if (refValue !== undefined) {
      if (typeof refValue !== "string" || !isSourceRef(refValue)) {
        return parseFailure("E_EXPERIENCE_SCHEMA", `experience.preconditions[${index}].check_params_ref`, "source_ref");
      }
      checkParamsRef = refValue;
    }
    const precondition: ExperienceCandidate["preconditions"][number] = {
      precondition_id: preconditionId,
      statement,
      check_kind: checkKind
    };
    if (checkParamsRef !== undefined) {
      precondition.check_params_ref = checkParamsRef;
    }
    preconditions.push(precondition);
  }

  const stepsValue = requireArray(value, "steps", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(stepsValue)) return stepsValue;
  const steps: ExperienceCandidate["steps"] = [];
  for (let index = 0; index < stepsValue.length; index += 1) {
    const item = stepsValue[index];
    if (!isRecord(item)) {
      return parseFailure("E_EXPERIENCE_SCHEMA", `experience.steps[${index}]`, "object");
    }
    const stepId = requireString(item, "step_id", `experience.steps[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(stepId)) return stepId;
    const action = requireString(item, "action", `experience.steps[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(action)) return action;
    const inputsValue = requireArray(item, "inputs", `experience.steps[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(inputsValue)) return inputsValue;
    const inputs = stringArray(inputsValue, `experience.steps[${index}].inputs`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(inputs)) return inputs;
    const observation = requireString(item, "expected_observation", `experience.steps[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(observation)) return observation;
    const branchValue = item["failure_branch"];
    let failureBranch: string | undefined;
    if (branchValue !== undefined) {
      if (typeof branchValue !== "string") {
        return parseFailure("E_EXPERIENCE_SCHEMA", `experience.steps[${index}].failure_branch`, "string");
      }
      failureBranch = branchValue;
    }
    const step: ExperienceCandidate["steps"][number] = {
      step_id: stepId,
      action,
      inputs,
      expected_observation: observation
    };
    if (failureBranch !== undefined) {
      step.failure_branch = failureBranch;
    }
    steps.push(step);
  }

  const effectsValue = requireArray(value, "expected_effects", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(effectsValue)) return effectsValue;
  const expectedEffects = stringArray(effectsValue, "experience.expected_effects", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(expectedEffects)) return expectedEffects;

  const completionValue = requireObject(value, "completion_check", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(completionValue)) return completionValue;
  const completionKind = requireEnum(completionValue, "kind", COMPLETION_KINDS, "experience.completion_check", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(completionKind)) return completionKind;
  const completionDescription = requireString(completionValue, "description", "experience.completion_check", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(completionDescription)) return completionDescription;

  const branchesValue = requireArray(value, "failure_branches", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(branchesValue)) return branchesValue;
  const failureBranches: ExperienceCandidate["failure_branches"] = [];
  for (let index = 0; index < branchesValue.length; index += 1) {
    const item = branchesValue[index];
    if (!isRecord(item)) {
      return parseFailure("E_EXPERIENCE_SCHEMA", `experience.failure_branches[${index}]`, "object");
    }
    const condition = requireString(item, "condition", `experience.failure_branches[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(condition)) return condition;
    const recovery = requireString(item, "recovery", `experience.failure_branches[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(recovery)) return recovery;
    const stopIfValue = item["stop_if"];
    const branch: ExperienceCandidate["failure_branches"][number] = { condition, recovery };
    if (stopIfValue !== undefined) {
      if (typeof stopIfValue !== "string") {
        return parseFailure("E_EXPERIENCE_SCHEMA", `experience.failure_branches[${index}].stop_if`, "string");
      }
      branch.stop_if = stopIfValue;
    }
    failureBranches.push(branch);
  }

  const counterValue = requireArray(value, "counterexamples", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(counterValue)) return counterValue;
  const counterexamples: ExperienceCandidate["counterexamples"] = [];
  for (let index = 0; index < counterValue.length; index += 1) {
    const item = counterValue[index];
    if (!isRecord(item)) {
      return parseFailure("E_EXPERIENCE_SCHEMA", `experience.counterexamples[${index}]`, "object");
    }
    const id = requireString(item, "counterexample_id", `experience.counterexamples[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(id)) return id;
    const condition = requireString(item, "condition", `experience.counterexamples[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(condition)) return condition;
    const failure = requireString(item, "observed_failure", `experience.counterexamples[${index}]`, "E_EXPERIENCE_SCHEMA");
    if (isParseFailure(failure)) return failure;
    const ref = item["source_ref"];
    if (typeof ref !== "string" || !isSourceRef(ref)) {
      return parseFailure("E_EXPERIENCE_SCHEMA", `experience.counterexamples[${index}].source_ref`, "source_ref");
    }
    counterexamples.push({ counterexample_id: id, condition, observed_failure: failure, source_ref: ref });
  }

  const expiryValue = requireObject(value, "expiry_policy", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(expiryValue)) return expiryValue;
  const maxAge = expiryValue["max_age_ms"];
  let maxAgeMs: number | undefined;
  if (maxAge !== undefined) {
    if (typeof maxAge !== "number" || !Number.isSafeInteger(maxAge) || maxAge < 1) {
      return parseFailure("E_EXPERIENCE_SCHEMA", "experience.expiry_policy.max_age_ms", "positive_safe_integer");
    }
    maxAgeMs = maxAge;
  }
  const invalidateHost = expiryValue["invalidate_on_host_version_change"];
  const invalidateTool = expiryValue["invalidate_on_tool_version_change"];
  const invalidateModel = expiryValue["invalidate_on_model_family_change"];
  if (typeof invalidateHost !== "boolean" || typeof invalidateTool !== "boolean" || typeof invalidateModel !== "boolean") {
    return parseFailure("E_EXPERIENCE_SCHEMA", "experience.expiry_policy", "boolean_fields");
  }
  const expiryPolicy: ExperienceExpiryPolicy = {
    invalidate_on_host_version_change: invalidateHost,
    invalidate_on_tool_version_change: invalidateTool,
    invalidate_on_model_family_change: invalidateModel
  };
  if (maxAgeMs !== undefined) {
    expiryPolicy.max_age_ms = maxAgeMs;
  }

  const evidenceValues = requireArray(value, "evidence_refs", "experience", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(evidenceValues)) return evidenceValues;
  const evidenceRefs = sourceRefArray(evidenceValues, "experience.evidence_refs", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(evidenceRefs)) return evidenceRefs;

  return {
    schema_version: "rsi.experience/1",
    type,
    title,
    summary,
    trigger: {
      description,
      signal_kinds: signalKinds,
      task_family_ids: taskFamilyIds,
      tool_names: toolNameValues,
      path_patterns: pathPatternValues,
      negative_triggers: negativeValues
    },
    preconditions,
    steps,
    expected_effects: expectedEffects,
    completion_check: { kind: completionKind, description: completionDescription },
    failure_branches: failureBranches,
    counterexamples,
    expiry_policy: expiryPolicy,
    evidence_refs: evidenceRefs
  };
}

function parsePlanCandidate(value: JsonValue): ParseFailure | ValidationPlanCandidate {
  if (!isRecord(value)) {
    return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan", "object");
  }
  const known = checkKnownKeys(value, PLAN_CANDIDATE_KEYS, "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (known !== null) return known;
  if (value["schema_version"] !== "rsi.validation_plan_candidate/1") {
    return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.schema_version", "const");
  }
  const expectedBehavior = requireString(value, "expected_behavior", "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(expectedBehavior)) return expectedBehavior;
  const loadingValue = requireArray(value, "required_loading_evidence", "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(loadingValue)) return loadingValue;
  const loading: Array<(typeof LOADING_STAGES)[number]> = [];
  for (const item of loadingValue) {
    if (typeof item !== "string" || !LOADING_STAGES.includes(item as (typeof LOADING_STAGES)[number])) {
      return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.required_loading_evidence", "enum");
    }
    loading.push(item as (typeof LOADING_STAGES)[number]);
  }
  const verifierValue = requireObject(value, "verifier", "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(verifierValue)) return verifierValue;
  const description = requireString(verifierValue, "description", "validation_plan.verifier", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(description)) return description;
  const refValue = verifierValue["verifier_ref"];
  let verifierRef: SourceRef | undefined;
  if (refValue !== undefined) {
    if (typeof refValue !== "string" || !isSourceRef(refValue)) {
      return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.verifier.verifier_ref", "source_ref");
    }
    verifierRef = refValue;
  }
  const windowValue = requireObject(value, "observation_window", "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(windowValue)) return windowValue;
  const windowMs = windowValue["window_ms"];
  const minUses = windowValue["min_triggered_uses"];
  const maxUses = windowValue["max_triggered_uses"];
  const extensions = windowValue["max_extensions"];
  if (
    typeof windowMs !== "number" || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 2_592_000_000 ||
    typeof minUses !== "number" || !Number.isSafeInteger(minUses) || minUses < 1 || minUses > 100 ||
    typeof maxUses !== "number" || !Number.isSafeInteger(maxUses) || maxUses < minUses ||
    typeof extensions !== "number" || !Number.isSafeInteger(extensions) || extensions < 0 || extensions > 3
  ) {
    return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.observation_window", "ranges");
  }
  const retentionValue = requireObject(value, "retention_rule", "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(retentionValue)) return retentionValue;
  const ruleId = requireString(retentionValue, "rule_id", "validation_plan.retention_rule", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(ruleId)) return ruleId;
  const ruleKind = requireEnum(retentionValue, "kind", RETENTION_KINDS, "validation_plan.retention_rule", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(ruleKind)) return ruleKind;
  const minPasses = retentionValue["min_independent_passes"];
  if (typeof minPasses !== "number" || !Number.isSafeInteger(minPasses) || minPasses < 1 || minPasses > 20) {
    return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.retention_rule.min_independent_passes", "1_20");
  }
  const verifierKinds = requireArray(retentionValue, "required_verifier_kinds", "validation_plan.retention_rule", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(verifierKinds)) return verifierKinds;
  const requiredKinds = stringArray(verifierKinds, "validation_plan.retention_rule.required_verifier_kinds", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(requiredKinds)) return requiredKinds;
  const maxAge = retentionValue["max_age_ms"];
  if (typeof maxAge !== "number" || !Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 31_536_000_000) {
    return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.retention_rule.max_age_ms", "1_31536000000");
  }
  const stopValue = requireArray(value, "stop_conditions", "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(stopValue)) return stopValue;
  const stopConditions: Array<(typeof STOP_CONDITIONS)[number]> = [];
  for (const item of stopValue) {
    if (typeof item !== "string" || !STOP_CONDITIONS.includes(item as (typeof STOP_CONDITIONS)[number])) {
      return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.stop_conditions", "enum");
    }
    stopConditions.push(item as (typeof STOP_CONDITIONS)[number]);
  }
  const replayValue = requireObject(value, "replay", "validation_plan", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(replayValue)) return replayValue;
  const requirement = requireEnum(replayValue, "requirement", REPLAY_REQUIREMENTS, "validation_plan.replay", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(requirement)) return requirement;
  const classesValue = requireArray(replayValue, "allowed_classes", "validation_plan.replay", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(classesValue)) return classesValue;
  const classes: Array<(typeof REPLAY_CLASSES)[number]> = [];
  for (const item of classesValue) {
    if (typeof item !== "string" || !REPLAY_CLASSES.includes(item as (typeof REPLAY_CLASSES)[number])) {
      return parseFailure("E_EXPERIENCE_SCHEMA", "validation_plan.replay.allowed_classes", "enum");
    }
    classes.push(item as (typeof REPLAY_CLASSES)[number]);
  }
  const livePolicy = requireEnum(replayValue, "live_external_policy", LIVE_EXTERNAL, "validation_plan.replay", "E_EXPERIENCE_SCHEMA");
  if (isParseFailure(livePolicy)) return livePolicy;

  const verifier: ValidationPlanCandidate["verifier"] = { description };
  if (verifierRef !== undefined) {
    verifier.verifier_ref = verifierRef;
  }
  return {
    schema_version: "rsi.validation_plan_candidate/1",
    expected_behavior: expectedBehavior,
    required_loading_evidence: loading,
    verifier,
    observation_window: {
      window_ms: windowMs,
      min_triggered_uses: minUses,
      max_triggered_uses: maxUses,
      max_extensions: extensions
    },
    retention_rule: {
      rule_id: ruleId,
      kind: ruleKind,
      min_independent_passes: minPasses,
      required_verifier_kinds: requiredKinds,
      max_age_ms: maxAge
    },
    stop_conditions: stopConditions,
    replay: {
      requirement,
      allowed_classes: classes,
      live_external_policy: livePolicy
    }
  };
}

const CHANGE_KINDS = ["create", "update", "disable", "rollback"] as const;
const OBJECT_TYPES = ["skill", "memory", "instructions"] as const;
const WRITE_MODES = ["whole_file", "managed_block"] as const;
const DIFF_FORMATS = ["unified_diff", "managed_block_patch", "json_merge_patch"] as const;

export function parseProposalCandidate(value: JsonValue): ParseFailure | ProposalCandidate {
  if (!isRecord(value)) {
    return parseFailure("E_PROPOSAL_SCHEMA", "candidate", "object");
  }
  const known = checkKnownKeys(value, PROPOSAL_KEYS, "candidate", "E_PROPOSAL_SCHEMA");
  if (known !== null) return known;
  if (value["schema_version"] !== "rsi.proposal_candidate/1") {
    return parseFailure("E_PROPOSAL_SCHEMA", "candidate.schema_version", "const");
  }
  const changeKind = requireEnum(value, "change_kind", CHANGE_KINDS, "candidate", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(changeKind)) return changeKind;
  const objectType = requireEnum(value, "object_type", OBJECT_TYPES, "candidate", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(objectType)) return objectType;
  const targetValue = requireObject(value, "target", "candidate", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(targetValue)) return targetValue;
  const targetKnown = checkKnownKeys(targetValue, TARGET_KEYS, "candidate.target", "E_PROPOSAL_SCHEMA");
  if (targetKnown !== null) return targetKnown;
  const targetRef = requireString(targetValue, "target_ref", "candidate.target", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(targetRef)) return targetRef;
  const hostId = requireString(targetValue, "host_id", "candidate.target", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(hostId)) return hostId;
  const projectValue = targetValue["project_id"];
  let projectId: string | undefined;
  if (projectValue !== undefined) {
    if (typeof projectValue !== "string" || projectValue.length === 0) {
      return parseFailure("E_PROPOSAL_SCHEMA", "candidate.target.project_id", "string");
    }
    projectId = projectValue;
  }
  const pathOrBlock = requireString(targetValue, "path_or_block", "candidate.target", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(pathOrBlock)) return pathOrBlock;
  const blockValue = targetValue["block_id"];
  let blockId: string | undefined;
  if (blockValue !== undefined) {
    if (typeof blockValue !== "string" || blockValue.length === 0) {
      return parseFailure("E_PROPOSAL_SCHEMA", "candidate.target.block_id", "string");
    }
    blockId = blockValue;
  }
  const requestedMode = requireEnum(targetValue, "requested_write_mode", WRITE_MODES, "candidate.target", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(requestedMode)) return requestedMode;
  const diffFormat = requireEnum(value, "diff_format", DIFF_FORMATS, "candidate", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(diffFormat)) return diffFormat;
  const diffText = requireString(value, "diff_text", "candidate", "E_PROPOSAL_SCHEMA", 0);
  if (isParseFailure(diffText)) return diffText;

  const reportedHash = value["candidate_hash"];
  let candidateHash: Hash | undefined;
  if (reportedHash !== undefined) {
    if (typeof reportedHash !== "string" || !isHash(reportedHash)) {
      return parseFailure("E_PROPOSAL_SCHEMA", "candidate.candidate_hash", "hash");
    }
    candidateHash = reportedHash;
  }

  const oldFile = value["expected_old_file_hash"];
  const oldBlock = value["expected_old_block_hash"];
  let expectedOldFile: Hash | undefined;
  let expectedOldBlock: Hash | undefined;
  if (oldFile !== undefined) {
    if (typeof oldFile !== "string" || !isHash(oldFile)) {
      return parseFailure("E_PROPOSAL_SCHEMA", "candidate.expected_old_file_hash", "hash");
    }
    expectedOldFile = oldFile;
  }
  if (oldBlock !== undefined) {
    if (typeof oldBlock !== "string" || !isHash(oldBlock)) {
      return parseFailure("E_PROPOSAL_SCHEMA", "candidate.expected_old_block_hash", "hash");
    }
    expectedOldBlock = oldBlock;
  }

  const experience = parseExperienceCandidate(value["experience"] ?? null);
  if (isParseFailure(experience)) return experience;
  const plan = parsePlanCandidate(value["validation_plan"] ?? null);
  if (isParseFailure(plan)) return plan;

  const evidenceValue = requireArray(value, "evidence_refs", "candidate", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(evidenceValue)) return evidenceValue;
  const evidenceRefs = sourceRefArray(evidenceValue, "candidate.evidence_refs", "E_PROPOSAL_SCHEMA");
  if (isParseFailure(evidenceRefs)) return evidenceRefs;
  const refinesValue = value["refines_experience_ref"];
  let refines: SourceRef | undefined;
  if (refinesValue !== undefined) {
    if (typeof refinesValue !== "string" || !isSourceRef(refinesValue)) {
      return parseFailure("E_PROPOSAL_SCHEMA", "candidate.refines_experience_ref", "source_ref");
    }
    refines = refinesValue;
  }

  const target: ProposalCandidate["target"] = {
    target_ref: targetRef,
    host_id: hostId as HostId,
    path_or_block: pathOrBlock,
    requested_write_mode: requestedMode
  };
  if (projectId !== undefined) target.project_id = projectId;
  if (blockId !== undefined) target.block_id = blockId;
  const candidate: ProposalCandidate = {
    schema_version: "rsi.proposal_candidate/1",
    change_kind: changeKind,
    object_type: objectType,
    target,
    diff_format: diffFormat,
    diff_text: diffText,
    experience,
    validation_plan: plan,
    evidence_refs: evidenceRefs
  };
  if (expectedOldFile !== undefined) candidate.expected_old_file_hash = expectedOldFile;
  if (expectedOldBlock !== undefined) candidate.expected_old_block_hash = expectedOldBlock;
  if (reportedHash !== undefined) candidate.candidate_hash = reportedHash;
  if (refines !== undefined) candidate.refines_experience_ref = refines;
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function baseString(bytes: Uint8Array): string {
  return decodeBytes(bytes);
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface ParsedCandidateInput {
  candidate: ProposalCandidate;
  ordinal: number;
}

/** Type required matrix, evaluated at S0c before any trusted normalization. */
function candidateMatchesTypeMatrix(candidate: ProposalCandidate): string | null {
  const requirement = TYPE_REQUIREMENTS[candidate.experience.type];
  if (candidate.experience.preconditions.length < requirement.min_preconditions) {
    return `preconditions_min_${requirement.min_preconditions}`;
  }
  if (candidate.experience.steps.length < requirement.min_steps) {
    return `steps_min_${requirement.min_steps}`;
  }
  if (requirement.completion_check && candidate.experience.completion_check.kind === "none") {
    return "completion_check_required";
  }
  if (candidate.experience.counterexamples.length < requirement.min_counterexamples) {
    return `counterexamples_min_${requirement.min_counterexamples}`;
  }
  if (
    requirement.max_counterexamples !== null &&
    candidate.experience.counterexamples.length > requirement.max_counterexamples
  ) {
    return `counterexamples_max_${requirement.max_counterexamples}`;
  }
  return null;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function validateTargetPath(path: string): string | null {
  if (path.length === 0) return "non_empty";
  if (path.startsWith("/") || path.startsWith("\\")) return "not_absolute";
  if (path.split("/").includes("..")) return "no_parent_segment";
  if (path.includes("\u0000")) return "no_nul";
  return null;
}

function oldHashPresence(candidate: ProposalCandidate, target: ResolvedTarget): string | null {
  if (candidate.change_kind === "create") {
    if (candidate.expected_old_file_hash !== undefined) return "expected_old_file_hash";
    if (candidate.expected_old_block_hash !== undefined) return "expected_old_block_hash";
    return null;
  }
  if (candidate.expected_old_file_hash === undefined) return "expected_old_file_hash";
  if (target.write_mode === "managed_block" && candidate.expected_old_block_hash === undefined) {
    return "expected_old_block_hash";
  }
  return null;
}

function diffFormatMatches(candidate: ProposalCandidate, target: ResolvedTarget): boolean {
  if (target.write_mode === "managed_block") {
    return candidate.diff_format === "managed_block_patch";
  }
  return candidate.diff_format === "unified_diff" || candidate.diff_format === "json_merge_patch";
}

function additionsOf(patch: string): string[] {
  const result: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push(line.slice(1));
    }
  }
  return result;
}

function findProtectedField(additions: readonly string[], protectedFields: ReadonlySet<string>): string | null {
  const defaults: readonly string[] = [
    "policy_version",
    "write_permission",
    "authorization",
    "sandbox",
    "shared_budget",
    "judgment_threshold",
    "calibration",
    "acceptance_rule",
    "verification_standard"
  ];
  const tokens = new Set<string>([...defaults, ...protectedFields]);
  for (const line of additions) {
    for (const token of tokens) {
      if (line.toLowerCase().includes(token.toLowerCase())) {
        return token;
      }
    }
  }
  return null;
}

/**
 * Runs P0a–S9. The candidate body is untrusted; `candidate_json` is scanned
 * before schema parsing so a reserved field always reports S0a.
 */
export function runStaticCheck(input: {
  candidate_json: JsonValue;
  ordinal: number;
  job_id: Id<"job">;
  attempt_id: Id<"rat">;
  candidate_key: Hash;
  context: StaticCheckContext;
}): CandidateCheckResult {
  const { context } = input;
  const checkedAt = context.now;

  // P0a - diff bytes after decoding; the raw field is checked before schema.
  const rawRecord = isRecord(input.candidate_json) ? input.candidate_json : null;
  const rawDiff = rawRecord === null ? undefined : rawRecord["diff_text"];
  if (typeof rawDiff === "string" && utf8Length(rawDiff) > REVIEW_DIFF_MAX_BYTES) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_DIFF_TOO_LARGE", step: "P0a", path: "diff_text", rule: "max_1MiB" },
      checked_at: checkedAt
    };
  }
  // P0b - Experience candidate body.
  const rawExperience = rawRecord === null ? undefined : rawRecord["experience"];
  if (rawExperience !== undefined) {
    let bytes = 0;
    try {
      bytes = canonicalJson(toJsonValue(rawExperience)).byteLength;
    } catch {
      bytes = 0;
    }
    if (bytes > REVIEW_EXPERIENCE_BODY_MAX_BYTES) {
      return {
        status: "rejected",
        failure: { code: "E_EXPERIENCE_TOO_LARGE", step: "P0b", path: "experience", rule: "max_64KiB" },
        checked_at: checkedAt
      };
    }
  }

  // S0a - reserved fields are rejected before schema parsing.
  const reserved = findReservedField(input.candidate_json);
  if (reserved !== null) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_UNTRUSTED_FIELD", step: "S0a", path: reserved, rule: "reserved" },
      checked_at: checkedAt
    };
  }
  // S0a - a candidate may never write a protected field, even before its
  // schema is trusted.
  if (typeof rawDiff === "string") {
    const protectedHit = findProtectedField(additionsOf(rawDiff), context.protectedFields);
    if (protectedHit !== null) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_PROTECTED_FIELD", step: "S0a", path: "diff_text", rule: protectedHit },
        checked_at: checkedAt
      };
    }
  }

  // S0b/S0c - structural parse (nested failures carry E_EXPERIENCE_SCHEMA).
  const parsed = parseProposalCandidate(input.candidate_json);
  if (isParseFailure(parsed)) {
    const step: CandidateFailureStep = parsed.code === "E_PROPOSAL_SCHEMA" ? "S0b" : "S0c";
    const code: ProposalFailureCode = parsed.code;
    return {
      status: "rejected",
      failure: { code, step, path: parsed.path, rule: parsed.rule },
      checked_at: checkedAt
    };
  }
  const candidate = parsed;
  const typeMatrixFailure = candidateMatchesTypeMatrix(candidate);
  if (typeMatrixFailure !== null) {
    return {
      status: "rejected",
      failure: { code: "E_EXPERIENCE_SCHEMA", step: "S0c", path: "experience", rule: typeMatrixFailure },
      checked_at: checkedAt
    };
  }

  // S1a - target parse and path escape.
  const resolved = context.resolveTarget(candidate.target);
  if (!resolved.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_TARGET", step: "S1a", path: "target", rule: resolved.error.code },
      checked_at: checkedAt
    };
  }
  const target = resolved.value;
  const pathCheck = validateTargetPath(target.path_or_block);
  if (pathCheck !== null) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_TARGET", step: "S1a", path: "target.path_or_block", rule: pathCheck },
      checked_at: checkedAt
    };
  }

  // S1b - target consistency.
  if (candidate.target.requested_write_mode !== target.write_mode) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_TARGET", step: "S1b", path: "target.requested_write_mode", rule: "resolved_write_mode" },
      checked_at: checkedAt
    };
  }
  if (!context.allowedObjectTypes.has(candidate.object_type)) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_TARGET", step: "S1b", path: "object_type", rule: "policy_allowed" },
      checked_at: checkedAt
    };
  }
  if (context.allowedTargetRefs.size > 0 && !context.allowedTargetRefs.has(candidate.target.target_ref)) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_TARGET", step: "S1b", path: "target.target_ref", rule: "policy_allowed" },
      checked_at: checkedAt
    };
  }

  // S2a - old hash presence.
  const missing = oldHashPresence(candidate, target);
  if (missing !== null) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_OLD_HASH_MISSING", step: "S2a", path: missing, rule: "required_for_mode" },
      checked_at: checkedAt
    };
  }

  // S2b - old base hashes.
  const currentFile = candidate.change_kind === "create"
    ? ok(new Uint8Array(0))
    : context.readBase(target);
  if (!currentFile.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_OLD_HASH_MISSING", step: "S2b", path: "base_ref", rule: currentFile.error.code },
      checked_at: checkedAt
    };
  }
  const baseBytes = currentFile.value;
  if (candidate.change_kind !== "create" && candidate.expected_old_file_hash !== undefined) {
    if (hashBytes(baseBytes) !== candidate.expected_old_file_hash) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_OLD_HASH_MISMATCH", step: "S2b", path: "expected_old_file_hash", rule: "sha256_base" },
        checked_at: checkedAt
      };
    }
  }
  let blockBase: string | null = null;
  if (target.write_mode === "managed_block") {
    if (target.block_selector === null) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_OLD_HASH_MISSING", step: "S2a", path: "target.block_selector", rule: "required" },
        checked_at: checkedAt
      };
    }
    const block = context.extractBlock(baseBytes, target.block_selector);
    if (!block.ok) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_OLD_HASH_MISMATCH", step: "S2b", path: "target.block_selector", rule: block.error.code },
        checked_at: checkedAt
      };
    }
    blockBase = block.value;
    if (candidate.change_kind !== "create" && candidate.expected_old_block_hash !== undefined) {
      if (hashBytes(encode(blockBase)) !== candidate.expected_old_block_hash) {
        return {
          status: "rejected",
          failure: { code: "E_PROPOSAL_OLD_HASH_MISMATCH", step: "S2b", path: "expected_old_block_hash", rule: "sha256_block_base" },
          checked_at: checkedAt
        };
      }
    }
  }

  // S3a - diff binding and format.
  const diffBytes = encode(candidate.diff_text);
  const diffRefResult = context.materializeBlob(diffBytes);
  if (!diffRefResult.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_DIFF_MISMATCH", step: "S3a", path: "diff_text", rule: diffRefResult.error.code },
      checked_at: checkedAt
    };
  }
  const diffRef = diffRefResult.value;
  const diffRead = context.readSource(diffRef);
  if (!diffRead.ok || hashBytes(diffRead.value) !== hashBytes(diffBytes)) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_DIFF_MISMATCH", step: "S3a", path: "diff_text", rule: "sha256_diff_ref" },
      checked_at: checkedAt
    };
  }
  if (!diffFormatMatches(candidate, target)) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_DIFF_MISMATCH", step: "S3a", path: "diff_format", rule: "write_mode" },
      checked_at: checkedAt
    };
  }

  // S3b - apply the diff.
  const applied = applyDiff(
    candidate.diff_format,
    target.write_mode === "managed_block" ? blockBase ?? "" : new TextDecoder().decode(baseBytes),
    candidate.diff_text
  );
  if (!applied.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_DIFF_APPLY", step: "S3b", path: "diff_text", rule: applied.error },
      checked_at: checkedAt
    };
  }

  // S3c - candidate hashes from the rebuilt bytes.
  let candidateFileBytes: Uint8Array;
  let candidateBlockHash: Hash | null = null;
  let candidateHash: Hash;
  if (target.write_mode === "managed_block") {
    if (target.block_selector === null) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_DIFF_APPLY", step: "S3c", path: "target.block_selector", rule: "missing" },
        checked_at: checkedAt
      };
    }
    const rebuilt = context.rebuildFile(baseBytes, target.block_selector, applied.value);
    if (!rebuilt.ok) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_DIFF_APPLY", step: "S3c", path: "target.block_selector", rule: rebuilt.error.code },
        checked_at: checkedAt
      };
    }
    candidateFileBytes = rebuilt.value;
    candidateBlockHash = hashBytes(encode(applied.value));
    candidateHash = candidateBlockHash;
  } else {
    candidateFileBytes = encode(applied.value);
    candidateHash = hashBytes(candidateFileBytes);
  }
  const candidateFileHash = hashBytes(candidateFileBytes);
  if (candidate.candidate_hash !== undefined && candidate.candidate_hash !== candidateHash) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_DIFF_MISMATCH", step: "S3c", path: "candidate_hash", rule: "recomputed" },
      checked_at: checkedAt
    };
  }

  // S4 - evidence closure.
  for (const ref of candidate.evidence_refs) {
    if (!context.snapshotEvidenceRefs.has(ref) || !context.approvedEvidenceRefs.has(ref)) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_EVIDENCE_NOT_ALLOWED", step: "S4", path: "evidence_refs", rule: ref },
        checked_at: checkedAt
      };
    }
    if (!context.retrievable(ref)) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_EVIDENCE_NOT_ALLOWED", step: "S4", path: "evidence_refs", rule: "not_retrievable" },
        checked_at: checkedAt
      };
    }
  }
  let refines: RefineSource | null = null;
  if (candidate.refines_experience_ref !== undefined) {
    if (!context.approvedExperienceRefs.has(candidate.refines_experience_ref)) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_EVIDENCE_NOT_ALLOWED", step: "S4", path: "refines_experience_ref", rule: "not_approved" },
        checked_at: checkedAt
      };
    }
    refines = context.refinable(candidate.refines_experience_ref);
    if (refines === null) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_EVIDENCE_NOT_ALLOWED", step: "S4", path: "refines_experience_ref", rule: "not_retrievable" },
        checked_at: checkedAt
      };
    }
  }

  // Normalization (between S4 and S5).
  const lineageDecision = resolveLineage(
    candidate.experience,
    candidate.validation_plan,
    refines,
    {
      job_id: input.job_id,
      proposal_id: "prop:pending",
      snapshot_id: context.snapshot.snapshot_id
    }
  );
  const allocation = context.allocate({
    candidate,
    target,
    lineage: lineageDecision.kind,
    experience_id: refines === null ? null : refines.experience.experience_id,
    existing_versions: refines === null ? [] : [refines.experience.version]
  });
  if (!allocation.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_SCHEMA", step: "S5", path: "allocation", rule: allocation.error.code },
      checked_at: checkedAt
    };
  }

  let verifierFailure: string | null = null;
  let verifier: VerifierRegistryEntry | null = null;
  if (candidate.validation_plan.verifier.verifier_ref !== undefined) {
    const resolvedVerifier = context.resolveVerifier(candidate.validation_plan.verifier.verifier_ref);
    if (resolvedVerifier.ok) {
      verifier = resolvedVerifier.value;
    } else {
      verifierFailure = resolvedVerifier.error.code;
    }
  }
  const normalized = context.normalize({
    candidate,
    target,
    lineage: lineageDecision.kind,
    refines,
    verifier
  });
  if (!normalized.ok) {
    return {
      status: "rejected",
      failure: { code: "E_EXPERIENCE_VERIFIER_BINDING", step: "S7b", path: "normalization", rule: normalized.error.code },
      checked_at: checkedAt
    };
  }

  let plan: ValidationPlan;
  if (lineageDecision.kind === "restore" && refines !== null) {
    plan = refines.validation_plan;
  } else {
    plan = buildValidationPlan({
      candidate: candidate.validation_plan,
      validation_plan_id: allocation.value.validation_plan_id,
      experience_id: allocation.value.experience_id,
      experience_version: allocation.value.version,
      source_requirement_refs: context.snapshot.requirements.map((requirement) => ({
        requirement_id: requirement.requirement_id,
        version: requirement.version,
        source_ref: requirement.quote_ref
      })),
      verifier: verifier === null
        ? {
            kind: "none",
            description: candidate.validation_plan.verifier.description,
            independence: "none"
          }
        : {
            kind: verifier.kind,
            verifier_ref: candidate.validation_plan.verifier.verifier_ref ?? verifier.binding_ref,
            binding_ref: verifier.binding_ref,
            description: candidate.validation_plan.verifier.description,
            independence: verifier.independence
          },
      now: context.now
    });
  }
  const planCheck = validateValidationPlan(plan);
  if (!planCheck.ok) {
    return {
      status: "rejected",
      failure: { code: "E_EXPERIENCE_SCHEMA", step: "S7b", path: "validation_plan", rule: planCheck.error.code },
      checked_at: checkedAt
    };
  }

  const experienceDraft: Experience = {
    schema_version: "rsi.experience/1",
    experience_id: allocation.value.experience_id,
    version: allocation.value.version,
    lineage: {
      kind: lineageDecision.kind,
      source_job_id: input.job_id,
      source_proposal_id: allocation.value.proposal_id,
      source_snapshot_id: context.snapshot.snapshot_id,
      ...(lineageDecision.predecessor_version === undefined
        ? {}
        : { predecessor_version: lineageDecision.predecessor_version }),
      ...(lineageDecision.restored_from_version === undefined
        ? {}
        : { restored_from_version: lineageDecision.restored_from_version })
    },
    type: candidate.experience.type,
    title: candidate.experience.title,
    summary: candidate.experience.summary,
    trigger: candidate.experience.trigger,
    scope: normalized.value.scope,
    preconditions: candidate.experience.preconditions,
    steps: candidate.experience.steps,
    expected_effects: candidate.experience.expected_effects,
    completion_check: candidate.experience.completion_check,
    failure_branches: candidate.experience.failure_branches,
    counterexamples: candidate.experience.counterexamples,
    validation_plan_id: plan.validation_plan_id,
    validation_plan_hash: plan.plan_hash,
    body_ref: "blob://sha256:0000000000000000000000000000000000000000000000000000000000000000#bytes=0-0",
    risk: normalized.value.risk,
    expiry_policy: candidate.experience.expiry_policy,
    evidence_refs: [...candidate.evidence_refs].sort(compareUtf8),
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    created_at: context.now
  };
  experienceDraft.content_hash = experienceContentHash(experienceDraft);
  const bodyBytes = experienceBodyBytes(experienceDraft);
  const bodyRefResult = context.materializeBlob(bodyBytes);
  if (!bodyRefResult.ok) {
    return {
      status: "rejected",
      failure: { code: "E_EXPERIENCE_SCHEMA", step: "S7a", path: "experience.body_ref", rule: bodyRefResult.error.code },
      checked_at: checkedAt
    };
  }
  experienceDraft.body_ref = bodyRefResult.value;

  // S5 - scope.
  const additions = additionsOf(candidate.diff_text);
  const scopeCheck = context.checkScope({
    candidate,
    target,
    normalizedScope: normalized.value.scope,
    diffAdditions: additions
  });
  if (!scopeCheck.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_SCOPE", step: "S5", path: "scope", rule: scopeCheck.error.code },
      checked_at: checkedAt
    };
  }

  // S7a - plan source closure.
  const planSourceCheck = validatePlanSourceRefs(plan, context.snapshot);
  if (!planSourceCheck.ok) {
    return {
      status: "rejected",
      failure: { code: "E_EXPERIENCE_PLAN_SOURCE_CHANGED", step: "S7a", path: "validation_plan.source_requirement_refs", rule: planSourceCheck.error.code },
      checked_at: checkedAt
    };
  }

  // S7b - verifier binding.
  if (verifierFailure !== null) {
    return {
      status: "rejected",
      failure: { code: "E_EXPERIENCE_VERIFIER_BINDING", step: "S7b", path: "validation_plan.verifier.verifier_ref", rule: verifierFailure },
      checked_at: checkedAt
    };
  }
  if (verifier !== null && verifier.kind === "none" && verifier.independence !== "none") {
    return {
      status: "rejected",
      failure: { code: "E_EXPERIENCE_VERIFIER_BINDING", step: "S7b", path: "validation_plan.verifier", rule: "kind_independence" },
      checked_at: checkedAt
    };
  }

  // S6 - no-op / duplicate content.
  const current = context.currentTargetHashes(target);
  if (!current.ok) {
    return {
      status: "stale",
      failure: { code: "E_PROPOSAL_STALE_TARGET", step: "S9", path: "target", rule: current.error.code },
      checked_at: checkedAt
    };
  }
  if (candidateFileHash === current.value.file_hash) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_NO_CHANGE", step: "S6", path: "candidate_file_hash", rule: "same_as_current" },
      checked_at: checkedAt
    };
  }
  if (candidate.change_kind === "create" && target.exists) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_NO_CHANGE", step: "S6", path: "target", rule: "create_target_exists" },
      checked_at: checkedAt
    };
  }
  if (
    lineageDecision.kind === "refine" &&
    refines !== null &&
    experienceDraft.content_hash === refines.experience.content_hash
  ) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_NO_CHANGE", step: "S6", path: "experience.content_hash", rule: "restore_required" },
      checked_at: checkedAt
    };
  }

  // S9 - current target.
  if (candidate.change_kind !== "create") {
    if (candidate.expected_old_file_hash !== undefined && current.value.file_hash !== candidate.expected_old_file_hash) {
      return {
        status: "stale",
        failure: { code: "E_PROPOSAL_STALE_TARGET", step: "S9", path: "expected_old_file_hash", rule: "current_file_hash" },
        checked_at: checkedAt
      };
    }
    if (target.write_mode === "managed_block" && candidate.expected_old_block_hash !== undefined && current.value.block_hash !== candidate.expected_old_block_hash) {
      return {
        status: "stale",
        failure: { code: "E_PROPOSAL_STALE_TARGET", step: "S9", path: "expected_old_block_hash", rule: "current_block_hash" },
        checked_at: checkedAt
      };
    }
  } else if (target.exists) {
    return {
      status: "stale",
      failure: { code: "E_PROPOSAL_STALE_TARGET", step: "S9", path: "target", rule: "create_target_exists" },
      checked_at: checkedAt
    };
  }

  // Trusted objects.
  const candidateBytes = canonicalJson(toJsonValue(candidate));
  const candidateJsonHash = hashBytes(candidateBytes);
  const candidateRefResult = context.materializeBlob(candidateBytes);
  if (!candidateRefResult.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_SCHEMA", step: "S0b", path: "candidate_ref", rule: candidateRefResult.error.code },
      checked_at: checkedAt
    };
  }
  const candidateRef = candidateRefResult.value;

  let baseRef: SourceRef | undefined;
  if (candidate.change_kind !== "create") {
    const baseBlob = context.materializeBlob(baseBytes);
    if (!baseBlob.ok) {
      return {
        status: "rejected",
        failure: { code: "E_PROPOSAL_OLD_HASH_MISSING", step: "S2b", path: "base_ref", rule: baseBlob.error.code },
        checked_at: checkedAt
      };
    }
    baseRef = baseBlob.value;
  }

  const proposal: Proposal = {
    schema_version: "rsi.proposal/2",
    proposal_id: allocation.value.proposal_id,
    proposal_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    job_id: input.job_id,
    attempt_id: input.attempt_id,
    ordinal: input.ordinal,
    question_key: null,
    state: "checked",
    change_kind: candidate.change_kind,
    target: {
      target_ref: target.target_ref,
      object_type: target.object_type,
      host_id: target.host_id,
      config_space: target.config_space,
      mode: target.mode,
      path_or_block: target.path_or_block,
      ownership: target.ownership,
      write_mode: target.write_mode,
      block_selector: target.block_selector,
      approved_root: target.approved_root,
      target_binding_ref: target.target_binding_ref,
      ...(target.project_id === undefined ? {} : { project_id: target.project_id }),
      ...(target.block_id === undefined ? {} : { block_id: target.block_id })
    },
    expected_file_hash: candidate.expected_old_file_hash ?? null,
    expected_block_hash: candidate.expected_old_block_hash ?? null,
    create_policy: candidate.change_kind === "create" ? "must_not_exist" : null,
    candidate_hash: candidateHash,
    candidate_file_hash: candidateFileHash,
    candidate_block_hash: candidateBlockHash,
    diff: {
      format: candidate.diff_format,
      ref: diffRef,
      hash: hashBytes(diffBytes),
      applies_to_hash: target.write_mode === "managed_block"
        ? candidate.expected_old_block_hash ?? hashBytes(encode(blockBase ?? ""))
        : candidate.expected_old_file_hash ?? hashBytes(baseBytes)
    },
    experience: {
      experience_id: experienceDraft.experience_id,
      version: experienceDraft.version,
      content_hash: experienceDraft.content_hash,
      body_ref: experienceDraft.body_ref,
      validation_plan_id: plan.validation_plan_id,
      validation_plan_hash: plan.plan_hash,
      risk: experienceDraft.risk,
      scope: experienceDraft.scope,
      verifier: verifier === null
        ? { kind: "none", independence: "none" }
        : {
            kind: verifier.kind,
            independence: verifier.independence,
            ...(candidate.validation_plan.verifier.verifier_ref === undefined
              ? {}
              : { binding_ref: candidate.validation_plan.verifier.verifier_ref })
          },
      no_verifier: planHasNoVerifier(plan)
    },
    normalization: {
      candidate_ref: candidateRef,
      allocation: lineageDecision.kind === "create"
        ? "created"
        : lineageDecision.kind === "restore"
          ? "restored"
          : "refined",
      risk_policy_ref: normalized.value.risk_policy_ref,
      scope_source_ref: normalized.value.scope_source_ref,
      normalized_at: context.now,
      ...(lineageDecision.kind !== "create" && refines !== null
        ? {
            refines_experience_id: refines.experience.experience_id,
            refines_version: refines.experience.version
          }
        : {})
    },
    experience_type: candidate.experience.type,
    evidence_refs: [...candidate.evidence_refs].sort(compareUtf8),
    generator: normalized.value.generator,
    static_check: { status: "passed", errors: [], checked_at: context.now },
    match_judge: {
      status: "pending",
      route_id: null,
      route_hash: null,
      route_class: null,
      template_id: "qt.experience_match",
      template_version: "1.0.0",
      template_hash: normalized.value.template_hash
    },
    created_at: context.now,
    updated_at: context.now,
    version: 1
  };
  if (baseRef !== undefined) {
    proposal.base_ref = baseRef;
  }
  proposal.proposal_hash = proposalHash(proposal);

  const bundleValue = toJsonValue({
    schema_version: "rsi.proposal_acceptance_bundle/1",
    candidate_key: input.candidate_key,
    proposal,
    experience: experienceDraft,
    validation_plan: plan
  });
  const bundleBytes = canonicalJson(bundleValue);
  const bundleRefResult = context.materializeBlob(bundleBytes);
  if (!bundleRefResult.ok) {
    return {
      status: "rejected",
      failure: { code: "E_PROPOSAL_SCHEMA", step: "S0b", path: "accepted_bundle_ref", rule: bundleRefResult.error.code },
      checked_at: checkedAt
    };
  }

  return {
    status: "accepted",
    proposal,
    experience: experienceDraft,
    validation_plan: plan,
    checked_at: checkedAt,
    candidate_key: input.candidate_key,
    candidate_ref: candidateRef,
    candidate_json_hash: candidateJsonHash,
    accepted_bundle_ref: bundleRefResult.value
  };
}

export function proposalHashInput(proposal: Proposal): JsonValue {
  return toJsonValue({
    schema_version: "rsi.proposal/2",
    change_kind: proposal.change_kind,
    target: {
      target_ref: proposal.target.target_ref,
      object_type: proposal.target.object_type,
      host_id: proposal.target.host_id,
      project_id: proposal.target.project_id ?? null,
      config_space: proposal.target.config_space,
      mode: proposal.target.mode,
      path_or_block: proposal.target.path_or_block,
      block_id: proposal.target.block_id ?? null,
      ownership: proposal.target.ownership,
      write_mode: proposal.target.write_mode,
      block_selector: proposal.target.block_selector ?? null,
      approved_root: proposal.target.approved_root,
      target_binding_ref: proposal.target.target_binding_ref
    },
    expected_file_hash: proposal.expected_file_hash ?? null,
    expected_block_hash: proposal.expected_block_hash ?? null,
    base_ref: proposal.base_ref ?? null,
    create_policy: proposal.create_policy ?? null,
    candidate_hash: proposal.candidate_hash,
    candidate_file_hash: proposal.candidate_file_hash,
    candidate_block_hash: proposal.candidate_block_hash ?? null,
    diff: {
      format: proposal.diff.format,
      ref: proposal.diff.ref,
      hash: proposal.diff.hash,
      applies_to_hash: proposal.diff.applies_to_hash
    },
    experience: {
      experience_id: proposal.experience.experience_id,
      version: proposal.experience.version,
      content_hash: proposal.experience.content_hash,
      validation_plan_hash: proposal.experience.validation_plan_hash,
      risk: proposal.experience.risk,
      scope: proposal.experience.scope,
      verifier: {
        kind: proposal.experience.verifier.kind,
        independence: proposal.experience.verifier.independence,
        binding_ref: proposal.experience.verifier.binding_ref ?? null
      },
      no_verifier: proposal.experience.no_verifier
    },
    normalization: {
      candidate_ref: proposal.normalization.candidate_ref,
      allocation: proposal.normalization.allocation,
      refines_experience_id: proposal.normalization.refines_experience_id ?? null,
      refines_version: proposal.normalization.refines_version ?? null,
      risk_policy_ref: proposal.normalization.risk_policy_ref,
      scope_source_ref: proposal.normalization.scope_source_ref
    },
    experience_type: proposal.experience_type,
    evidence_refs: sortUtf8(proposal.evidence_refs, (ref) => ref),
    egress_decision_ref: proposal.egress_decision_ref ?? null,
    generator: {
      backend_id: proposal.generator.backend_id,
      model_id: proposal.generator.model_id,
      protocol_version: proposal.generator.protocol_version,
      generator_version: proposal.generator.generator_version
    }
  });
}

export function proposalHash(proposal: Proposal): Hash {
  return canonicalHash(proposalHashInput(proposal));
}

export function verifyProposalHash(proposal: Proposal): boolean {
  return proposalHash(proposal) === proposal.proposal_hash;
}

export function proposalToCandidateKeyInput(
  proposal: Proposal,
  outputHash: Hash,
  candidateJsonHash: Hash
): CandidateKeyInput {
  return {
    job_id: proposal.job_id as Id<"job">,
    attempt_id: proposal.attempt_id as Id<"rat">,
    ordinal: proposal.ordinal,
    output_hash: outputHash,
    candidate_json_hash: candidateJsonHash
  };
}

export function proposalHashForCandidate(
  proposal: Proposal,
  outputHash: Hash,
  candidateJsonHash: Hash
): Hash {
  return candidateKeyFrom(proposalToCandidateKeyInput(proposal, outputHash, candidateJsonHash));
}

export function failureEnvelope(failure: CandidateFailure): ErrorEnvelope {
  return proposalFailureToEnvelope(failure.code, failure.path, failure.rule);
}
