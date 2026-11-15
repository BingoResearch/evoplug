/**
 * Persisted-row reader for `JudgeRequestBinding/3` construction
 * (DD-EVD-015, DD-EVD-016A, DD-EVD-019, DD-EVD-026).
 *
 * `buildRequest` never accepts caller-supplied temporary plan/shard/pack/
 * manifest/state/profile/validator objects. Every object it hands to
 * `buildJudgeRequest` is loaded here from the persisted rows named by
 * `BindingInput`, re-derived from the row content and cross-checked against
 * the other rows. A missing, stale or inconsistent row is a typed error; the
 * reader never fabricates a default object.
 *
 * The read port is an FND-side adapter: it resolves the blob behind each
 * `content_ref` and returns the decoded object next to its row. This module
 * only recomputes the canonical content hash and the domain identities.
 */

import {
  canonicalJson,
  canonicalJsonText,
  equalVersionBinding,
  err,
  hashBytes,
  ok,
  parseVersionBinding,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type JsonValue,
  type Result,
  type SourceRef,
  type VersionBinding,
} from "@evoplug/core";

import { asEvdError, evdErr, evdError, evdForwarded, evdForwardedError } from "./errors.js";
import {
  dependencyUnitHash,
  dependencyUnitKey,
  evidencePackEvidenceHash,
  evidencePackHash,
  evidencePackKey,
  jevLimitsHash,
  manifestHash,
  manifestKey,
  semanticBackendKey,
  semanticCapabilityHash,
  semanticCapabilityKey,
  semanticContractHash,
  semanticLimitsHash,
  semanticPolicyHash,
  semanticScopeKey,
  semanticValidatorBindingKey,
  shardKey,
  shardPlanHash,
  shardPlanKey,
  sortUtf8Strings,
  stateContentHash,
  stateHashOf,
  textHash,
  utf8Length,
} from "./hashing.js";
import { buildTemplateBindings, type BuildRequestContext } from "./judge-binding.js";
import type {
  BindingInput,
  DependencyUnit,
  EvidencePack,
  EvdEvidencePackRow,
  EvdServiceProfileRow,
  EvdShardPlanRow,
  EvdShardRow,
  EvdStateManifestRow,
  EvdValidatorBindingRow,
  JevServiceProfile,
  JudgeState,
  JudgeStateManifest,
  PlannedQuestion,
  QuestionPlan,
  SemanticBackendCapability,
  SemanticScope,
  SemanticValidationBinding,
  Shard,
  ShardPlan,
  TemplateBinding,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Read port                                                           */
/* ------------------------------------------------------------------ */

export interface PersistedPackRow {
  readonly row: EvdEvidencePackRow;
  readonly pack: EvidencePack;
}

export interface PersistedShardPlanRow {
  readonly row: EvdShardPlanRow;
  readonly plan: ShardPlan;
}

export interface PersistedShardRow {
  readonly row: EvdShardRow;
  readonly shard: Shard;
}

export interface PersistedManifestRow {
  readonly row: EvdStateManifestRow;
  readonly manifest: JudgeStateManifest;
}

/**
 * FND-side read port for the `/3` binding path. Each method resolves the
 * referenced blob and returns the decoded object next to its typed row, or
 * `null` when the row does not exist. Storage failures stay `Err`; the reader
 * never substitutes an empty object or a partial row.
 */
export interface EvidenceBindingReadPort {
  readShardPlan(q: {
    binding: VersionBinding;
    shard_plan_id: Id;
  }): Promise<Result<PersistedShardPlanRow | null, ErrorEnvelope>>;
  readShard(q: {
    binding: VersionBinding;
    shard_plan_id: Id;
    shard_id: Id;
  }): Promise<Result<PersistedShardRow | null, ErrorEnvelope>>;
  readPack(q: {
    binding: VersionBinding;
    pack_id: Id;
    pack_key: Hash;
  }): Promise<Result<PersistedPackRow | null, ErrorEnvelope>>;
  readManifest(q: {
    binding: VersionBinding;
    shard_id: Id;
    shard_key: Hash;
    pack_key: Hash;
    plan_hash: Hash;
  }): Promise<Result<PersistedManifestRow | null, ErrorEnvelope>>;
  /**
   * Resolves the QP `rsi.judge_state/2` object whose content hashes the
   * persisted manifest recorded. The query carries the expected hashes so the
   * port can reject a wrong blob before returning it.
   */
  readJudgeState(q: {
    binding: VersionBinding;
    shard_id: Id;
    shard_key: Hash;
    state_hash: Hash;
    state_content_hash: Hash;
  }): Promise<Result<JudgeState | null, ErrorEnvelope>>;
  /**
   * Reads an `evd_service_profile` row. `profile_key` selects the latest
   * `profile_version` for that key (capability rows and Jev profiles share the
   * table); `profile_id` selects one exact row.
   */
  readServiceProfile(q: {
    profile_id?: Id;
    profile_key?: Hash;
  }): Promise<Result<EvdServiceProfileRow | null, ErrorEnvelope>>;
  readValidatorBinding(q: {
    validator_binding_id?: Id;
    validator_binding_key?: Hash;
  }): Promise<Result<EvdValidatorBindingRow | null, ErrorEnvelope>>;
  readUnits?(q: {
    binding: VersionBinding;
    pack_id: Id;
    pack_key: Hash;
    unit_keys: readonly string[];
  }): Promise<Result<readonly DependencyUnit[], ErrorEnvelope>>;
  /** Optional provenance check for capability/profile `source_refs`. */
  verifySourceRefs?(refs: readonly SourceRef[]): Promise<Result<boolean, ErrorEnvelope>>;
}

export interface BindingReaderDeps {
  rows: EvidenceBindingReadPort;
}

export interface LoadedBindingContext {
  readonly context: BuildRequestContext;
  /** Jev `profile_key` for `jev_typed`, else `capability_key`. */
  readonly service_profile_key: Hash;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function jsonValueOf(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  const a = sortUtf8Strings(left);
  const b = sortUtf8Strings(right);
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function bindingMatchesRuntime(
  persisted: VersionBinding,
  runtime: VersionBinding
): boolean {
  return (
    persisted.task_id === runtime.task_id &&
    persisted.branch_id === runtime.branch_id &&
    persisted.input_epoch === runtime.input_epoch &&
    persisted.goal_version === runtime.goal_version &&
    persisted.config_version === runtime.config_version
  );
}

function planNotDispatchable<T>(reason: string, shardPlanKey: string): Result<T, EvdErrorLike> {
  return evdErr<T>("E_EVIDENCE_PLAN_NOT_DISPATCHABLE", {
    shard_plan_key: shardPlanKey,
    reason,
  });
}

function versionFailure<T>(field: string): Result<T, EvdErrorLike> {
  return evdForwarded<T>("E_VERSION_BINDING", { field });
}

function manifestMismatch(displayId: string, logicalId: string): EvdErrorLike {
  return evdError("E_EVIDENCE_MANIFEST_MISMATCH", {
    display_id: displayId,
    logical_id: logicalId,
  });
}

function contentMismatch(
  row: { content_ref: SourceRef },
  expected: string,
  actual: string
): EvdErrorLike {
  return evdError("E_CONTENT_HASH_MISMATCH", {
    content_ref: row.content_ref,
    expected,
    actual,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonText(jsonValueOf(left)) === canonicalJsonText(jsonValueOf(right));
  } catch {
    return false;
  }
}

type EvdErrorLike = import("./types.js").EvdError;

/** Recomputes the canonical content hash of a decoded row object. */
function verifyContentMeta(
  row: { content_hash: Hash; content_bytes: number; content_ref: SourceRef },
  value: unknown
): EvdErrorLike | null {
  let bytes: Uint8Array;
  try {
    bytes = canonicalJson(jsonValueOf(value));
  } catch {
    return contentMismatch(row, row.content_hash, "invalid_json");
  }
  const recomputed = hashBytes(bytes);
  if (recomputed !== row.content_hash || bytes.length !== row.content_bytes) {
    return contentMismatch(row, recomputed, row.content_hash);
  }
  return null;
}

function hasOwn(value: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

const VOLATILE_STATE_FIELDS: readonly string[] = [
  "retrievable",
  "deadline_ms",
  "pack_hash",
  "request_hash",
];

function containsLocalUri(text: string): boolean {
  return text.includes("blob://") || text.includes("journal://");
}

function optionKeysFor(question: PlannedQuestion): string[] {
  if (question.question_type !== "choice") {
    return [];
  }
  if (question.options.length > 0) {
    return question.options.map((option) => option.option_key);
  }
  return question.criteria.levels ?? [];
}

function questionsForShard(plan: QuestionPlan, shard: Shard): PlannedQuestion[] {
  return plan.questions.filter(
    (question) =>
      shard.question_keys.includes(question.question_key) ||
      shard.question_ids.includes(question.question_id)
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: plan / shard / pack / manifest / state / QuestionBinding    */
/* ------------------------------------------------------------------ */

function validateQuestions(questions: readonly PlannedQuestion[]): EvdErrorLike | null {
  if (questions.length === 0) {
    return evdForwardedError("E_TEMPLATE_BINDING_MISSING");
  }
  const seen = new Set<string>();
  for (const question of questions) {
    if (question.question_type === "box") {
      return evdError("E_UNSUPPORTED_QUESTION_TYPE", {
        question_key: question.question_key,
        type: "box",
      });
    }
    if (question.template_id === "" || question.template_version === "") {
      return evdForwardedError("E_TEMPLATE_BINDING_MISSING");
    }
    if (seen.has(question.question_key)) {
      return evdForwardedError("E_TEMPLATE_BINDING_MISSING");
    }
    seen.add(question.question_key);
    if (question.question_type === "choice") {
      const options = optionKeysFor(question);
      if (options.length < 2 || options.length > 255) {
        return evdError("E_OPTION_COUNT", {
          question_key: question.question_key,
          observed: options.length,
          min: 2,
          max: 255,
        });
      }
      if (!options.includes("unknown")) {
        return evdError("E_UNKNOWN_OPTION", {
          question_key: question.question_key,
          option: "unknown",
        });
      }
      for (const option of options) {
        if (!hasOwn(question.option_effects, option)) {
          return evdError("E_PLAN_AGGREGATION_BINDING", {
            question_key: question.question_key,
            field: "option_effects",
          });
        }
      }
    }
    if (question.question_type === "score") {
      const levels = question.criteria.levels ?? [];
      if (levels.length < 2 || levels.length > 10) {
        return evdError("E_OPTION_COUNT", {
          question_key: question.question_key,
          observed: levels.length,
          min: 2,
          max: 10,
        });
      }
    }
    if (question.independence.answer_independent !== true) {
      return evdError("E_PLAN_AGGREGATION_BINDING", {
        question_key: question.question_key,
        field: "independence.answer_independent",
      });
    }
  }
  return null;
}

function validateTemplateBindings(
  plan: QuestionPlan,
  questions: readonly PlannedQuestion[],
  requested: readonly TemplateBinding[]
): EvdErrorLike | null {
  const expected = buildTemplateBindings(plan, questions);
  if (expected.length !== questions.length || expected.length !== requested.length) {
    return evdForwardedError("E_TEMPLATE_BINDING_MISSING");
  }
  const requestedKeys = new Set(requested.map((binding) => binding.question_key));
  if (requestedKeys.size !== requested.length) {
    return evdForwardedError("E_TEMPLATE_BINDING_MISSING");
  }
  for (const binding of requested) {
    const planned = expected.find((entry) => entry.question_key === binding.question_key);
    if (
      planned === undefined ||
      planned.template_id !== binding.template_id ||
      planned.template_version !== binding.template_version ||
      planned.template_hash !== binding.template_hash
    ) {
      return evdForwardedError("E_TEMPLATE_BINDING_MISSING");
    }
  }
  return null;
}

function validatePackIdentity(
  plan: QuestionPlan,
  input: BindingInput,
  pack: EvidencePack
): EvdErrorLike | null {
  if (pack.pack_id !== input.pack_id || pack.pack_key !== input.pack_key) {
    return evdForwardedError("E_VERSION_BINDING", { field: "pack_key" });
  }
  if (pack.plan_id !== plan.plan_id || pack.plan_hash !== plan.plan_hash) {
    return evdForwardedError("E_VERSION_BINDING", { field: "pack.plan_hash" });
  }
  if (pack.issue_id !== plan.issue_id || pack.issue_key !== plan.issue_key) {
    return evdForwardedError("E_VERSION_BINDING", { field: "pack.issue_id" });
  }
  if (
    pack.task_id !== input.version_binding.task_id ||
    pack.branch_id !== input.version_binding.branch_id ||
    pack.input_epoch !== input.version_binding.input_epoch ||
    pack.goal_version !== input.version_binding.goal_version ||
    pack.config_version !== input.version_binding.config_version
  ) {
    return evdForwardedError("E_VERSION_BINDING", { field: "pack.binding" });
  }
  const questionKeys = plan.questions.map((question) => question.question_key);
  if (!sameStringSets(pack.question_keys, questionKeys)) {
    return evdForwardedError("E_VERSION_BINDING", { field: "pack.question_keys" });
  }
  return null;
}

function recomputePackHashes(
  plan: QuestionPlan,
  pack: EvidencePack
): { evidence_hash: Hash; pack_hash: Hash; pack_key: Hash } {
  const keyById = new Map(plan.questions.map((question) => [question.question_id, question.question_key]));
  const planQuestionKeys = plan.questions.map((question) => question.question_key);
  const packBinding: VersionBinding = {
    task_id: pack.task_id as VersionBinding["task_id"],
    branch_id: pack.branch_id as VersionBinding["branch_id"],
    input_epoch: pack.input_epoch,
    goal_version: pack.goal_version,
    config_version: pack.config_version,
    watermark: pack.watermark,
  };
  const evidenceHash = evidencePackEvidenceHash({
    plan_hash: pack.plan_hash,
    question_keys: planQuestionKeys,
    issue_key: pack.issue_key,
    issue_question: pack.issue.question,
    issue_requirement_ids: pack.issue.requirement_ids,
    issue_type: pack.issue.issue_type,
    requirements: pack.requirements,
    // The compiler covers feedback through the requirement rows and hashes
    // `feedback` as null; recomputation mirrors that persisted preimage.
    feedback: null,
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
        affects_question_keys: entry.affects_question_ids
          .map((questionId) => keyById.get(questionId))
          .filter((key): key is string => key !== undefined),
        recoverable: entry.recoverable,
      })),
    },
  });
  const packHash = evidencePackHash({
    plan_hash: pack.plan_hash,
    question_keys: planQuestionKeys,
    compiler_version: pack.compiler_version,
    counting_method_version: pack.counting_method_version,
    source_manifest_version: pack.source_manifest_version,
    issue_key: pack.issue_key,
    binding: packBinding,
    evidence_hash: evidenceHash,
  });
  const packKey = evidencePackKey({
    pack_hash: packHash,
    plan_hash: pack.plan_hash,
    question_keys: planQuestionKeys,
    source_manifest_version: pack.source_manifest_version,
    compiler_version: pack.compiler_version,
    counting_method_version: pack.counting_method_version,
  });
  return { evidence_hash: evidenceHash, pack_hash: packHash, pack_key: packKey };
}

function validateManifestIdentity(
  plan: QuestionPlan,
  shard: Shard,
  pack: EvidencePack,
  manifest: JudgeStateManifest
): EvdErrorLike | null {
  if (manifest.shard_id !== shard.shard_id || manifest.shard_key !== shard.shard_key) {
    return manifestMismatch("", "");
  }
  if (manifest.pack_key !== pack.pack_key || manifest.plan_hash !== plan.plan_hash) {
    return manifestMismatch("", "");
  }
  if (shard.state_hash === null || manifest.state_hash !== shard.state_hash) {
    return manifestMismatch("", "");
  }
  const expectedKey = manifestKey({
    state_hash: manifest.state_hash,
    state_content_hash: manifest.state_content_hash,
    shard_key: manifest.shard_key,
    pack_key: manifest.pack_key,
    plan_hash: manifest.plan_hash,
    entries: manifest.entries,
  });
  const expectedHash = manifestHash({
    manifest_key: expectedKey,
    state_hash: manifest.state_hash,
    state_content_hash: manifest.state_content_hash,
    shard_key: manifest.shard_key,
    pack_key: manifest.pack_key,
    plan_hash: manifest.plan_hash,
    entries: manifest.entries,
    wire_removed_fields: manifest.wire_removed_fields,
  });
  if (manifest.manifest_key !== expectedKey || manifest.manifest_hash !== expectedHash) {
    return manifestMismatch("", "");
  }
  const removed = new Set(manifest.wire_removed_fields);
  if (!removed.has("source_refs") || !removed.has("retrievable")) {
    return manifestMismatch("", "");
  }
  const entries = [...manifest.entries].sort((a, b) => a.display_ordinal - b.display_ordinal);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      return manifestMismatch("", "");
    }
    if (
      entry.display_ordinal !== index + 1 ||
      entry.display_id !== `E${String(entry.display_ordinal)}` ||
      entry.source_refs.length === 0 ||
      entry.source_ids.length === 0
    ) {
      return manifestMismatch(entry.display_id, entry.logical_id);
    }
  }
  return null;
}

function validateState(
  input: BindingInput,
  plan: QuestionPlan,
  manifest: JudgeStateManifest,
  state: JudgeState
): EvdErrorLike | null {
  const schemaVersion: string = state.schema_version;
  if (schemaVersion === "rsi.judge_state/1") {
    return evdError("E_JUDGE_STATE_V1_READ_ONLY", { schema_version: schemaVersion });
  }
  if (schemaVersion !== "rsi.judge_state/2") {
    return evdError("E_STATE_VERSION_UNSUPPORTED", { schema_version: schemaVersion });
  }
  if (!equalVersionBinding(state.binding, input.version_binding)) {
    return evdForwardedError("E_VERSION_BINDING", { field: "state.binding" });
  }
  if (state.profile !== plan.state_profile) {
    return manifestMismatch("", "");
  }
  if (state.question_scope.issue_type !== plan.issue_type) {
    return evdForwardedError("E_VERSION_BINDING", { field: "state.question_scope.issue_type" });
  }
  if (state.question_scope.whole_task_verdict_requested !== false) {
    return evdError("E_STATE_WHOLE_TASK_SCOPE", {
      question_key: "",
      scope: "whole_task_verdict_requested",
    });
  }
  for (const field of VOLATILE_STATE_FIELDS) {
    if (hasOwn(state, field)) {
      return evdError("E_STATE_VOLATILE_FIELD", { field });
    }
  }
  for (const entry of state.evidence) {
    for (const field of VOLATILE_STATE_FIELDS) {
      if (hasOwn(entry, field)) {
        return evdError("E_STATE_VOLATILE_FIELD", { field: `evidence.${field}` });
      }
    }
    if (containsLocalUri(entry.excerpt)) {
      return evdError("E_STATE_LOCAL_URI", { field: `evidence[${entry.display_id}].excerpt` });
    }
  }
  for (const requirement of state.requirements) {
    if (containsLocalUri(requirement.quote)) {
      return evdError("E_STATE_LOCAL_URI", {
        field: `requirements[${requirement.requirement_id}].quote`,
      });
    }
  }
  const stateJson = jsonValueOf(state);
  const stateHash = stateHashOf(stateJson);
  const contentHash = stateContentHash(stateJson);
  if (stateHash !== manifest.state_hash || contentHash !== manifest.state_content_hash) {
    return manifestMismatch("", "");
  }
  const wire = new Map<string, JudgeState["evidence"][number]>();
  for (const entry of state.evidence) {
    if (wire.has(entry.display_id)) {
      return manifestMismatch(entry.display_id, entry.logical_id);
    }
    wire.set(entry.display_id, entry);
  }
  if (wire.size !== manifest.entries.length) {
    return manifestMismatch("", "");
  }
  for (const entry of manifest.entries) {
    const projected = wire.get(entry.display_id);
    if (projected === undefined) {
      return manifestMismatch(entry.display_id, entry.logical_id);
    }
    if (
      projected.logical_id !== entry.logical_id ||
      projected.role !== entry.role ||
      projected.artifact_version !== entry.artifact_version ||
      !sameStringSets(projected.requirement_ids, entry.requirement_ids) ||
      textHash(projected.excerpt) !== entry.text_hash ||
      utf8Length(projected.excerpt) !== entry.excerpt_bytes
    ) {
      return manifestMismatch(entry.display_id, entry.logical_id);
    }
  }
  return null;
}

function validateUnits(
  plan: QuestionPlan,
  pack: EvidencePack,
  shard: Shard,
  manifest: JudgeStateManifest,
  units: readonly DependencyUnit[]
): EvdErrorLike | null {
  const expectedKeys = new Set(shard.unit_keys);
  if (units.length !== expectedKeys.size) {
    return manifestMismatch("", "");
  }
  const seen = new Set<string>();
  for (const unit of units) {
    if (!expectedKeys.has(unit.unit_key) || seen.has(unit.unit_key)) {
      return manifestMismatch("", "");
    }
    seen.add(unit.unit_key);
    if (
      unit.plan_id !== plan.plan_id ||
      unit.plan_hash !== plan.plan_hash ||
      unit.pack_id !== pack.pack_id
    ) {
      return evdForwardedError("E_VERSION_BINDING", { field: "unit" });
    }
    const expectedKey = dependencyUnitKey({
      plan_hash: unit.plan_hash,
      dependency_key: unit.dependency_key,
      inseparable_group_key: unit.inseparable_group_key,
      role: unit.role,
      transport_role: unit.transport_role,
      source_ids: unit.source_ids,
      source_refs: unit.source_refs,
      omission_impact: unit.omission_impact,
      can_omit: unit.can_omit,
      ...(unit.derived_view_key !== undefined ? { derived_view_key: unit.derived_view_key } : {}),
    });
    const expectedHash = dependencyUnitHash({
      unit_key: expectedKey,
      state_evidence: unit.state_evidence,
      estimated_tokens: unit.estimated_tokens,
    });
    if (expectedKey !== unit.unit_key || expectedHash !== unit.unit_hash) {
      return manifestMismatch("", "");
    }
  }
  const byContentHash = new Map<string, DependencyUnit["state_evidence"][number]>();
  for (const unit of units) {
    for (const entry of unit.state_evidence) {
      byContentHash.set(entry.content_hash, entry);
    }
  }
  for (const entry of manifest.entries) {
    const evidence = byContentHash.get(entry.content_hash);
    if (evidence === undefined) {
      return manifestMismatch(entry.display_id, entry.logical_id);
    }
    if (
      textHash(evidence.excerpt) !== entry.text_hash ||
      utf8Length(evidence.excerpt) !== entry.excerpt_bytes ||
      !sameStringSets(evidence.source_ids, entry.source_ids)
    ) {
      return manifestMismatch(entry.display_id, entry.logical_id);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Step 2/3: capability, validator binding, service profile            */
/* ------------------------------------------------------------------ */

function isSortedUniqueUtf8(values: readonly string[]): boolean {
  if (values.length === 0) {
    return false;
  }
  const sorted = sortUtf8Strings(values);
  if (sorted.length !== values.length) {
    return false;
  }
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      return false;
    }
    if (index > 0 && values[index - 1] === values[index]) {
      return false;
    }
  }
  return true;
}

function validateScopeShape(scope: SemanticScope): EvdErrorLike | null {
  if (scope.schema_version !== "rsi.semantic_scope/1") {
    return evdForwardedError("E_VERSION_BINDING", { field: "scope.schema_version" });
  }
  const groups: Array<readonly string[]> = [
    scope.question_classes,
    scope.issue_types,
    scope.state_profiles,
    scope.evidence_kinds,
  ];
  for (const group of groups) {
    if (!isSortedUniqueUtf8(group)) {
      return evdForwardedError("E_VERSION_BINDING", { field: "scope" });
    }
  }
  if (scope.issue_types.length > 64) {
    return evdForwardedError("E_VERSION_BINDING", { field: "scope.issue_types" });
  }
  for (const issueType of scope.issue_types) {
    if (issueType === "" || utf8Length(issueType) > 128) {
      return evdForwardedError("E_VERSION_BINDING", { field: "scope.issue_types" });
    }
  }
  return null;
}

function validateCapabilityLimits(
  capability: SemanticBackendCapability
): EvdErrorLike | null {
  const limits = capability.limits;
  const fail = (): EvdErrorLike =>
    evdError("E_SEMANTIC_BACKEND_UNKNOWN", {
      backend_key: capability.backend_key,
      reason: "limits_incomplete",
    });
  if (limits.schema_version !== "rsi.semantic_backend_limits/1") {
    return fail();
  }
  if (
    !Number.isSafeInteger(limits.max_questions) ||
    limits.max_questions < 1 ||
    limits.max_questions > 256 ||
    !Number.isSafeInteger(limits.max_evidence_items) ||
    limits.max_evidence_items < 0 ||
    limits.max_evidence_items > 4096 ||
    !Number.isSafeInteger(limits.max_state_bytes) ||
    limits.max_state_bytes < 0 ||
    limits.max_state_bytes > 33_554_432 ||
    !Number.isSafeInteger(limits.max_request_bytes) ||
    limits.max_request_bytes < 1 ||
    limits.max_request_bytes > 33_554_432 ||
    !Number.isSafeInteger(limits.max_response_bytes) ||
    limits.max_response_bytes < 1 ||
    limits.max_response_bytes > 33_554_432
  ) {
    return fail();
  }
  if (!limits.state_supported && limits.max_state_bytes !== 0) {
    return fail();
  }
  return null;
}

function validateCapability(
  input: BindingInput,
  capability: SemanticBackendCapability
): EvdErrorLike | null {
  const schemaVersion: string = capability.schema_version;
  if (schemaVersion !== "rsi.semantic_backend_capability/1") {
    return evdError("E_SEMANTIC_BACKEND_UNKNOWN", {
      backend_key: input.backend.backend_key,
      reason: "capability_schema",
    });
  }
  if (input.backend.schema_version !== "rsi.semantic_backend_ref/1") {
    return evdForwardedError("E_VERSION_BINDING", { field: "backend.schema_version" });
  }
  if (capability.backend_kind !== input.backend.backend_kind) {
    return evdForwardedError("E_VERSION_BINDING", { field: "backend.backend_kind" });
  }
  if (
    capability.method.schema_version !== "rsi.method_ref/1" ||
    capability.method.method_id !== input.backend.method.method_id ||
    capability.method.method_version !== input.backend.method.method_version ||
    capability.method.rule_version !== input.backend.method.rule_version
  ) {
    return evdForwardedError("E_VERSION_BINDING", { field: "backend.method" });
  }
  const scopeShapeError = validateScopeShape(capability.scope);
  if (scopeShapeError !== null) {
    return scopeShapeError;
  }
  const scopeKey = semanticScopeKey(capability.scope);
  if (scopeKey !== input.backend.scope_key) {
    return evdForwardedError("E_VERSION_BINDING", { field: "scope_key" });
  }
  const backendKey = semanticBackendKey({
    backend_kind: capability.backend_kind,
    implementation_id: capability.implementation_id,
    implementation_version: capability.implementation_version,
    method: capability.method,
    scope_key: scopeKey,
  });
  if (backendKey !== capability.backend_key || backendKey !== input.backend.backend_key) {
    return evdForwardedError("E_VERSION_BINDING", { field: "backend_key" });
  }
  const limitsHash = semanticLimitsHash(capability.limits);
  if (limitsHash !== capability.limits.limits_hash) {
    return evdForwardedError("E_VERSION_BINDING", { field: "limits_hash" });
  }
  const capabilityKey = semanticCapabilityKey(capability);
  if (
    capabilityKey !== capability.capability_key ||
    capabilityKey !== input.backend.capability_key
  ) {
    return evdForwardedError("E_VERSION_BINDING", { field: "capability_key" });
  }
  const capabilityHash = semanticCapabilityHash(capability);
  if (
    capabilityHash !== capability.capability_hash ||
    capabilityHash !== input.backend.capability_hash
  ) {
    return evdForwardedError("E_VERSION_BINDING", { field: "capability_hash" });
  }
  return null;
}

function validateValidatorBinding(
  input: BindingInput,
  capability: SemanticBackendCapability,
  binding: SemanticValidationBinding
): EvdErrorLike | null {
  const schemaVersion: string = binding.schema_version;
  if (schemaVersion !== "rsi.semantic_validation_binding/1") {
    return evdError("E_VALIDATOR_POLICY_MISMATCH", {
      expected: "rsi.semantic_validation_binding/1",
      actual: schemaVersion,
    });
  }
  if (binding.validator_binding_id !== input.validator_binding_id) {
    return evdForwardedError("E_VERSION_BINDING", { field: "validator_binding_id" });
  }
  if (
    binding.backend_key !== capability.backend_key ||
    binding.capability_key !== capability.capability_key ||
    binding.capability_hash !== capability.capability_hash
  ) {
    return evdForwardedError("E_VERSION_BINDING", { field: "validator_binding.capability" });
  }
  const policyHash = semanticPolicyHash();
  const contractHash = semanticContractHash();
  if (binding.policy_hash !== policyHash || binding.contract_hash !== contractHash) {
    return evdError("E_VALIDATOR_POLICY_MISMATCH", {
      expected: `${policyHash}|${contractHash}`,
      actual: `${binding.policy_hash}|${binding.contract_hash}`,
    });
  }
  const key = semanticValidatorBindingKey({
    backend_key: capability.backend_key,
    capability_key: capability.capability_key,
    capability_hash: capability.capability_hash,
    policy_hash: policyHash,
    contract_hash: contractHash,
  });
  if (binding.validator_binding_key !== key) {
    return evdError("E_VALIDATOR_POLICY_MISMATCH", {
      expected: key,
      actual: binding.validator_binding_key,
    });
  }
  return null;
}

function validateJevProfile(
  input: BindingInput,
  shardPlan: ShardPlan,
  profile: JevServiceProfile
): EvdErrorLike | null {
  const schemaVersion: string = profile.schema_version;
  if (schemaVersion !== "rsi.jev_service_profile/1") {
    return evdError("E_SERVICE_PROFILE_MISMATCH", {
      field: "schema_version",
      expected: "rsi.jev_service_profile/1",
      actual: schemaVersion,
    });
  }
  if (profile.profile_key !== shardPlan.service_profile_key) {
    return evdError("E_SERVICE_PROFILE_MISMATCH", {
      field: "profile_key",
      expected: shardPlan.service_profile_key,
      actual: profile.profile_key,
    });
  }
  if (input.service_profile_id === null || profile.profile_id !== input.service_profile_id) {
    return evdError("E_SERVICE_PROFILE_MISMATCH", {
      field: "profile_id",
      expected: input.service_profile_id ?? "",
      actual: profile.profile_id,
    });
  }
  const limitsHash = jevLimitsHash(profile.limits);
  if (limitsHash !== profile.limits.limits_hash) {
    return evdError("E_SERVICE_PROFILE_MISMATCH", {
      field: "limits_hash",
      expected: limitsHash,
      actual: profile.limits.limits_hash,
    });
  }
  if (profile.requested_model === "" || profile.expected_returned_model === "") {
    return evdError("E_SERVICE_PROFILE_MISMATCH", {
      field: "model",
      expected: "non_empty",
      actual: "",
    });
  }
  if (profile.acceptance.status === "blocked") {
    return evdError("E_SERVICE_PROFILE_BLOCKED", {
      profile_key: profile.profile_key,
      profile_version: profile.profile_version,
    });
  }
  if (
    profile.limits.request_max_tokens === null ||
    profile.limits.question_max_tokens === null ||
    profile.limits.source === "unknown"
  ) {
    return evdError("E_SERVICE_PROFILE_BLOCKED", {
      profile_key: profile.profile_key,
      profile_version: profile.profile_version,
    });
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Reader                                                              */
/* ------------------------------------------------------------------ */

export async function loadJudgeRequestContext(
  deps: BindingReaderDeps,
  input: BindingInput,
  plan: QuestionPlan
): Promise<Result<LoadedBindingContext, EvdErrorLike>> {
  const rows = deps.rows;

  const parsedBinding = parseVersionBinding(input.version_binding);
  if (!parsedBinding.ok) {
    return versionFailure("version_binding");
  }

  /* ---- shard plan ---- */
  const shardPlanRead = await rows.readShardPlan({
    binding: input.version_binding,
    shard_plan_id: input.shard_plan_id,
  });
  if (!shardPlanRead.ok) {
    return err(asEvdError(shardPlanRead.error));
  }
  const shardPlanRecord = shardPlanRead.value;
  if (shardPlanRecord === null) {
    return planNotDispatchable("shard_plan_missing", "");
  }
  const shardPlan = shardPlanRecord.plan;
  const shardPlanContentError = verifyContentMeta(shardPlanRecord.row, shardPlan);
  if (shardPlanContentError !== null) {
    return err(shardPlanContentError);
  }
  if (
    shardPlan.shard_plan_id !== input.shard_plan_id ||
    shardPlanRecord.row.shard_plan_id !== input.shard_plan_id ||
    shardPlanRecord.row.shard_plan_key !== shardPlan.shard_plan_key ||
    shardPlanRecord.row.shard_plan_hash !== shardPlan.shard_plan_hash ||
    shardPlanRecord.row.plan_id !== shardPlan.plan_id ||
    shardPlanRecord.row.plan_hash !== shardPlan.plan_hash ||
    shardPlanRecord.row.pack_id !== shardPlan.pack_id ||
    shardPlanRecord.row.pack_key !== shardPlan.pack_key ||
    shardPlanRecord.row.issue_id !== shardPlan.issue_id
  ) {
    return versionFailure("shard_plan_id");
  }
  if (shardPlan.plan_id !== input.plan_id || shardPlan.plan_hash !== input.plan_hash) {
    return versionFailure("shard_plan.plan_hash");
  }
  if (shardPlan.pack_id !== input.pack_id || shardPlan.pack_key !== input.pack_key) {
    return versionFailure("shard_plan.pack_key");
  }
  if (shardPlan.issue_id !== plan.issue_id) {
    return versionFailure("shard_plan.issue_id");
  }
  if (!bindingMatchesRuntime(shardPlan.binding, input.version_binding)) {
    return versionFailure("shard_plan.binding");
  }
  if (shardPlan.dispatch_policy !== "per_shard/1") {
    return planNotDispatchable("dispatch_policy", shardPlan.shard_plan_key);
  }
  if (
    shardPlan.state === "rejected" ||
    shardPlan.state === "dispatched" ||
    shardPlan.state === "completed"
  ) {
    return planNotDispatchable(`plan_state_${shardPlan.state}`, shardPlan.shard_plan_key);
  }
  if (!sameStringSets(shardPlan.shard_order, shardPlan.shards.map((shard) => shard.shard_id))) {
    return versionFailure("shard_order");
  }

  /* ---- shard ---- */
  const shardRead = await rows.readShard({
    binding: input.version_binding,
    shard_plan_id: input.shard_plan_id,
    shard_id: input.shard_id,
  });
  if (!shardRead.ok) {
    return err(asEvdError(shardRead.error));
  }
  const shardRecord = shardRead.value;
  if (shardRecord === null) {
    return planNotDispatchable("shard_missing", shardPlan.shard_plan_key);
  }
  const shard = shardRecord.shard;
  if (
    shard.shard_id !== input.shard_id ||
    shardRecord.row.shard_id !== input.shard_id ||
    shardRecord.row.shard_plan_id !== input.shard_plan_id ||
    shardRecord.row.shard_plan_key !== shardPlan.shard_plan_key ||
    shardRecord.row.shard_key !== shard.shard_key ||
    shardRecord.row.status !== shard.status
  ) {
    return versionFailure("shard");
  }
  const plannedShard = shardPlan.shards.find((entry) => entry.shard_id === shard.shard_id);
  if (plannedShard === undefined || !sameJson(plannedShard, shard)) {
    return versionFailure("shard");
  }
  if (shard.status !== "planned" && shard.status !== "bound") {
    return planNotDispatchable(`shard_status_${shard.status}`, shardPlan.shard_plan_key);
  }
  if (!sameStringSets(input.question_ids, shard.question_ids)) {
    return versionFailure("question_ids");
  }
  if (input.request_binding_id !== undefined) {
    if (shard.request_binding_id !== input.request_binding_id) {
      return versionFailure("request_binding_id");
    }
  }
  if (shard.state_hash === null) {
    return err(manifestMismatch("", ""));
  }

  const shardQuestions = questionsForShard(plan, shard);
  if (
    shardQuestions.length !== shard.question_keys.length ||
    !sameStringSets(shardQuestions.map((question) => question.question_key), shard.question_keys) ||
    !sameStringSets(shardQuestions.map((question) => question.question_id), shard.question_ids)
  ) {
    return err(evdForwardedError("E_TEMPLATE_BINDING_MISSING"));
  }
  const questionError = validateQuestions(shardQuestions);
  if (questionError !== null) {
    return err(questionError);
  }
  const templateError = validateTemplateBindings(plan, shardQuestions, input.template_bindings);
  if (templateError !== null) {
    return err(templateError);
  }

  /* ---- pack ---- */
  const packRead = await rows.readPack({
    binding: input.version_binding,
    pack_id: input.pack_id,
    pack_key: input.pack_key,
  });
  if (!packRead.ok) {
    return err(asEvdError(packRead.error));
  }
  const packRecord = packRead.value;
  if (packRecord === null) {
    return evdErr("E_EVIDENCE_PACK_STALE", {
      pack_hash: input.pack_key,
      binding: input.version_binding,
    });
  }
  const pack = packRecord.pack;
  const packSchema: string = pack.schema_version;
  if (packSchema === "rsi.evidence_pack/1") {
    return evdErr("E_EVIDENCE_PACK_V1_READ_ONLY", { schema_version: packSchema });
  }
  if (packSchema !== "rsi.evidence_pack/2") {
    return evdErr("E_EVIDENCE_PACK_STALE", {
      pack_hash: input.pack_key,
      binding: input.version_binding,
    });
  }
  if (pack.pack_state !== "valid" || packRecord.row.pack_state !== "valid") {
    return evdErr("E_EVIDENCE_PACK_STALE", {
      pack_hash: pack.pack_hash,
      binding: input.version_binding,
    });
  }
  const packContentError = verifyContentMeta(packRecord.row, pack);
  if (packContentError !== null) {
    return err(packContentError);
  }
  const packIdentityError = validatePackIdentity(plan, input, pack);
  if (packIdentityError !== null) {
    return err(packIdentityError);
  }
  if (
    packRecord.row.pack_id !== pack.pack_id ||
    packRecord.row.pack_key !== pack.pack_key ||
    packRecord.row.pack_hash !== pack.pack_hash ||
    packRecord.row.evidence_hash !== pack.evidence_hash ||
    packRecord.row.plan_id !== pack.plan_id ||
    packRecord.row.plan_hash !== pack.plan_hash ||
    packRecord.row.issue_id !== pack.issue_id ||
    packRecord.row.issue_key !== pack.issue_key
  ) {
    return versionFailure("pack_row");
  }
  const recomputed = recomputePackHashes(plan, pack);
  if (input.version_binding.watermark < pack.watermark) {
    return evdErr("E_EVIDENCE_PACK_STALE", {
      pack_hash: pack.pack_hash,
      binding: input.version_binding,
    });
  }
  if (recomputed.evidence_hash !== pack.evidence_hash) {
    return err(
      contentMismatch(packRecord.row, recomputed.evidence_hash, pack.evidence_hash)
    );
  }
  if (recomputed.pack_hash !== pack.pack_hash) {
    return err(contentMismatch(packRecord.row, recomputed.pack_hash, pack.pack_hash));
  }
  if (recomputed.pack_key !== pack.pack_key) {
    return err(contentMismatch(packRecord.row, recomputed.pack_key, pack.pack_key));
  }
  if (pack.budget.output_reserve > plan.aggregate_output_reserve_tokens) {
    return evdErr("E_BUDGET_RESERVE_INCONSISTENT", {
      aggregate_output_reserve_tokens: plan.aggregate_output_reserve_tokens,
    });
  }

  /* ---- manifest ---- */
  const manifestRead = await rows.readManifest({
    binding: input.version_binding,
    shard_id: shard.shard_id,
    shard_key: shard.shard_key,
    pack_key: pack.pack_key,
    plan_hash: plan.plan_hash,
  });
  if (!manifestRead.ok) {
    return err(asEvdError(manifestRead.error));
  }
  const manifestRecord = manifestRead.value;
  if (manifestRecord === null) {
    return err(manifestMismatch("", ""));
  }
  const manifest = manifestRecord.manifest;
  const manifestContentError = verifyContentMeta(manifestRecord.row, manifest);
  if (manifestContentError !== null) {
    return err(manifestContentError);
  }
  if (
    manifest.manifest_id !== manifestRecord.row.manifest_id ||
    manifest.manifest_key !== manifestRecord.row.manifest_key ||
    manifest.manifest_hash !== manifestRecord.row.manifest_hash
  ) {
    return err(manifestMismatch("", ""));
  }
  const manifestIdentityError = validateManifestIdentity(plan, shard, pack, manifest);
  if (manifestIdentityError !== null) {
    return err(manifestIdentityError);
  }
  for (const omission of shardPlan.omissions) {
    if (omission.impact === "none") {
      continue;
    }
    const affected = omission.question_keys.filter((key) => shard.question_keys.includes(key));
    if (affected.length > 0) {
      return evdErr("E_PROJECTION_OMISSION_BLOCKING", {
        question_key: affected[0] ?? "",
        omission_keys: [omission.omission_key],
      });
    }
  }
  const presentSourceIds = new Set(manifest.entries.flatMap((entry) => entry.source_ids));
  for (const question of shardQuestions) {
    if (!question.required_for_issue) {
      continue;
    }
    const missingSource = question.required_source_ids.find(
      (sourceId) => !presentSourceIds.has(sourceId)
    );
    if (missingSource !== undefined) {
      return evdErr("E_PROJECTION_SOURCE_MISSING", {
        question_key: question.question_key,
        source_id: missingSource,
      });
    }
  }

  /* ---- judge state ---- */
  const stateRead = await rows.readJudgeState({
    binding: input.version_binding,
    shard_id: shard.shard_id,
    shard_key: shard.shard_key,
    state_hash: manifest.state_hash,
    state_content_hash: manifest.state_content_hash,
  });
  if (!stateRead.ok) {
    return err(asEvdError(stateRead.error));
  }
  const state = stateRead.value;
  if (state === null) {
    return err(manifestMismatch("", ""));
  }
  const stateError = validateState(input, plan, manifest, state);
  if (stateError !== null) {
    return err(stateError);
  }

  /* ---- capability ---- */
  const capabilityRead = await rows.readServiceProfile({
    profile_key: input.backend.capability_key,
  });
  if (!capabilityRead.ok) {
    return err(asEvdError(capabilityRead.error));
  }
  const capabilityRow = capabilityRead.value;
  if (capabilityRow === null) {
    return evdErr("E_SEMANTIC_BACKEND_UNKNOWN", {
      backend_key: input.backend.backend_key,
      reason: "capability_missing",
    });
  }
  if (capabilityRow.profile_key !== input.backend.capability_key) {
    return evdErr("E_SEMANTIC_BACKEND_UNKNOWN", {
      backend_key: input.backend.backend_key,
      reason: "capability_missing",
    });
  }
  if (capabilityRow.body_json.schema_version !== "rsi.semantic_backend_capability/1") {
    return evdErr("E_SEMANTIC_BACKEND_UNKNOWN", {
      backend_key: input.backend.backend_key,
      reason: "capability_schema",
    });
  }
  const capability = capabilityRow.body_json;
  const capabilityError = validateCapability(input, capability);
  if (capabilityError !== null) {
    return err(capabilityError);
  }

  /* ---- validator binding ---- */
  const validatorRead = await rows.readValidatorBinding({
    validator_binding_id: input.validator_binding_id,
  });
  if (!validatorRead.ok) {
    return err(asEvdError(validatorRead.error));
  }
  const validatorRow = validatorRead.value;
  if (validatorRow === null) {
    return evdErr("E_VALIDATOR_BINDING_MISSING", { validator_binding_key: "" });
  }
  if (
    validatorRow.body_json.schema_version !== "rsi.semantic_validation_binding/1"
  ) {
    return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
      expected: "rsi.semantic_validation_binding/1",
      actual: validatorRow.body_json.schema_version,
    });
  }
  const validatorBinding = validatorRow.body_json;
  const validatorError = validateValidatorBinding(input, capability, validatorBinding);
  if (validatorError !== null) {
    return err(validatorError);
  }
  if (
    validatorRow.validator_binding_id !== validatorBinding.validator_binding_id ||
    validatorRow.validator_binding_key !== validatorBinding.validator_binding_key ||
    validatorRow.validator_policy_hash !== validatorBinding.policy_hash ||
    validatorRow.service_profile_key !== capability.capability_key
  ) {
    return evdErr("E_VALIDATOR_POLICY_MISMATCH", {
      expected: validatorBinding.validator_binding_key,
      actual: validatorRow.validator_binding_key,
    });
  }

  /* ---- service profile ---- */
  let serviceProfile: { requested_model: string } | undefined;
  let serviceProfileKey = capability.capability_key;
  let limitsHash = capability.limits.limits_hash;
  let jevProfile: JevServiceProfile | undefined;
  if (capability.backend_kind === "jev_typed") {
    const profileRead = await rows.readServiceProfile({
      profile_key: shardPlan.service_profile_key,
    });
    if (!profileRead.ok) {
      return err(asEvdError(profileRead.error));
    }
    const profileRow = profileRead.value;
    if (profileRow === null || profileRow.body_json.schema_version !== "rsi.jev_service_profile/1") {
      return evdErr("E_SERVICE_PROFILE_UNKNOWN", {
        profile_key: shardPlan.service_profile_key,
      });
    }
    const profile = profileRow.body_json;
    const profileError = validateJevProfile(input, shardPlan, profile);
    if (profileError !== null) {
      return err(profileError);
    }
    if (
      profileRow.profile_id !== profile.profile_id ||
      profileRow.profile_key !== profile.profile_key ||
      profileRow.acceptance_status !== profile.acceptance.status
    ) {
      return evdErr("E_SERVICE_PROFILE_MISMATCH", {
        field: "row",
        expected: profile.profile_id,
        actual: profileRow.profile_id,
      });
    }
    jevProfile = profile;
    serviceProfile = { requested_model: profile.requested_model };
    serviceProfileKey = profile.profile_key;
    limitsHash = profile.limits.limits_hash;
  } else {
    if (input.service_profile_id !== null) {
      return evdErr("E_SERVICE_PROFILE_MISMATCH", {
        field: "service_profile_id",
        expected: "",
        actual: input.service_profile_id,
      });
    }
    if (shardPlan.service_profile_key !== capability.capability_key) {
      return versionFailure("service_profile_key");
    }
  }

  /* ---- optional source retrievability ---- */
  if (rows.verifySourceRefs !== undefined) {
    const refs: SourceRef[] = [...capability.source_refs];
    if (jevProfile !== undefined) {
      refs.push(...jevProfile.h_evidence_refs, ...jevProfile.limits.source_refs);
    }
    if (refs.length > 0) {
      const retrievable = await rows.verifySourceRefs(refs);
      if (!retrievable.ok || !retrievable.value) {
        return versionFailure("capability.source_refs");
      }
    }
  }

  /* ---- backend capability completeness (step 3) ---- */
  const capabilityLimitsError = validateCapabilityLimits(capability);
  if (capabilityLimitsError !== null) {
    return err(capabilityLimitsError);
  }

  /* ---- shard plan / shard identity recomputation ---- */
  const shardKeys = sortUtf8Strings(shardPlan.shards.map((entry) => entry.shard_key));
  const omissionKeys = sortUtf8Strings(shardPlan.omissions.map((entry) => entry.omission_key));
  const expectedShardPlanKey = shardPlanKey({
    plan_hash: shardPlan.plan_hash,
    pack_key: shardPlan.pack_key,
    service_profile_key: shardPlan.service_profile_key,
    limits_hash: limitsHash,
    shard_keys: shardKeys,
    shard_plan_policy_version: shardPlan.shard_policy_version,
    compiler_version: shardPlan.compiler_version,
    counting_method_version: shardPlan.counting_method_version,
  });
  if (expectedShardPlanKey !== shardPlan.shard_plan_key) {
    return versionFailure("shard_plan_key");
  }
  const expectedShardPlanHash = shardPlanHash({
    shard_plan_key: expectedShardPlanKey,
    plan_hash: shardPlan.plan_hash,
    pack_key: shardPlan.pack_key,
    shard_plan_policy_version: shardPlan.shard_policy_version,
    compiler_version: shardPlan.compiler_version,
    counting_method_version: shardPlan.counting_method_version,
    shard_keys: shardKeys,
    omission_keys: omissionKeys,
  });
  if (expectedShardPlanHash !== shardPlan.shard_plan_hash) {
    return versionFailure("shard_plan_hash");
  }
  const shardOmissionKeys: string[] = [];
  for (const omissionId of shard.omission_ids) {
    const omission = shardPlan.omissions.find((entry) => entry.omission_id === omissionId);
    if (omission === undefined) {
      return versionFailure("shard.omission_ids");
    }
    shardOmissionKeys.push(omission.omission_key);
  }
  const expectedShardKey = shardKey({
    plan_hash: shardPlan.plan_hash,
    pack_key: shardPlan.pack_key,
    required_question_keys: shardQuestions
      .filter((question) => question.required_for_issue)
      .map((question) => question.question_key),
    optional_question_keys: shardQuestions
      .filter((question) => !question.required_for_issue)
      .map((question) => question.question_key),
    unit_keys: shard.unit_keys,
    service_profile_key: shardPlan.service_profile_key,
    limits_hash: limitsHash,
    omission_keys: shardOmissionKeys,
    counting_method_version: shardPlan.counting_method_version,
    compiler_version: shardPlan.compiler_version,
  });
  if (expectedShardKey !== shard.shard_key) {
    return versionFailure("shard_key");
  }

  /* ---- units ---- */
  let units: readonly DependencyUnit[] = [];
  const unitKeys = sortUtf8Strings(shard.unit_keys);
  if (unitKeys.length > 0) {
    if (rows.readUnits === undefined) {
      return planNotDispatchable("units_read_port_missing", shardPlan.shard_plan_key);
    }
    const unitsRead = await rows.readUnits({
      binding: input.version_binding,
      pack_id: pack.pack_id,
      pack_key: pack.pack_key,
      unit_keys: unitKeys,
    });
    if (!unitsRead.ok) {
      return err(asEvdError(unitsRead.error));
    }
    units = unitsRead.value;
    const unitsError = validateUnits(plan, pack, shard, manifest, units);
    if (unitsError !== null) {
      return err(unitsError);
    }
  } else if (manifest.entries.length > 0) {
    return err(manifestMismatch("", ""));
  }

  const context: BuildRequestContext = {
    input,
    plan,
    shard,
    pack,
    manifest,
    state,
    capability,
    validator_binding: validatorBinding,
    units,
    ...(serviceProfile !== undefined ? { service_profile: serviceProfile } : {}),
  };
  return ok({ context, service_profile_key: serviceProfileKey });
}
