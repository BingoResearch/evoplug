/**
 * `JudgeRequestBinding/3` construction (DD-EVD-016A, DD-EVD-018).
 *
 * `buildJudgeRequest` is a pure builder over already persisted QP plan, pack,
 * shard, manifest, frozen state, capability and semantic validator binding.
 * The first-error order is fixed: binding/version, backend unknown, scope,
 * contract, then limits/budget.
 */

import {
  err,
  newId,
  type Hash,
  type Id,
  type JsonValue,
  type Result,
  type SourceRef,
} from "@evoplug/core";

import { evdErr, evdForwarded, evdOk } from "./errors.js";
import {
  adapterContractHash,
  dispatchKeyV3,
  jcsHash,
  semanticEvidenceSetHash,
  semanticQuestionSetHash,
  propositionBindingsDigest,
  questionBindingsDigest,
  requestHashV3,
  semanticScopeKey,
  sortUtf8Strings,
  stateContentHash,
  stateHashOf,
  templateBindingsDigest,
  textHash,
  utf8Length,
} from "./hashing.js";
import type {
  BindingInput,
  ChoiceQuestion,
  DependencyUnit,
  EvidencePack,
  JevTypedAdapterRequest,
  JudgeRequestBindingV3,
  JudgeState,
  JudgeStateManifest,
  MethodRef,
  NoulPropositionBinding,
  NoulQuestion,
  PlannedQuestion,
  QuestionBinding,
  QuestionPlan,
  ScoreQuestion,
  SemanticBackendCapability,
  SemanticBackendRef,
  SemanticBackendRequest,
  SemanticQuestionRequest,
  SemanticScope,
  SemanticValidationBinding,
  Shard,
  TemplateBinding,
  TypedJudgeQuestion,
} from "./types.js";

export interface SemanticQuestionOptions {
  /** Pre-registered noul equivalence mappings keyed by `question_key|proposition_id`. */
  noul_mappings?: ReadonlyMap<
    string,
    { inconsistent_equivalent: boolean; mapping_version: string }
  >;
}

export interface BuildRequestContext {
  input: BindingInput;
  plan: QuestionPlan;
  shard: Shard;
  pack: EvidencePack;
  manifest: JudgeStateManifest;
  state: JudgeState;
  capability: SemanticBackendCapability;
  validator_binding: SemanticValidationBinding;
  service_profile?: { requested_model: string };
  budget_ref?: SourceRef;
  units?: readonly DependencyUnit[];
  state_ref?: SourceRef;
  options?: SemanticQuestionOptions;
}

const QUESTION_CLASSES = new Set<string>([
  "intent_relation",
  "behavior_relation",
  "step_effect",
  "acceptance_relation",
  "experience_match",
]);

/**
 * `question_class` is derived from the template id (DD-QP-22):
 * `qt.intent_relation` -> `intent_relation`, `qt.behavior_relation` ->
 * `behavior_relation`, `qt.step_effect` -> `step_effect`,
 * `qt.acceptance_relation` -> `acceptance_relation`, `qt.experience_match` ->
 * `experience_match`. The registry allows exactly these five. The
 * `experience_review` profile is always `experience_match`.
 *
 * Deriving the class from the wire question type would map every `choice`
 * question to `acceptance_relation` and would break the scope gate and the
 * semantic competence gate, because both are keyed by the template's relation
 * class.
 */
function questionClassFor(
  question: PlannedQuestion,
  profile: string
): SemanticQuestionRequest["question_class"] {
  if (profile === "experience_review") {
    return "experience_match";
  }
  const derived = question.template_id.replace(/^qt\./, "");
  if (QUESTION_CLASSES.has(derived)) {
    return derived as SemanticQuestionRequest["question_class"];
  }
  /*
   * A template id outside the registered five only occurs in a plan that QP
   * never produces: QP's own registry gate rejects it with
   * `E_TEMPLATE_NOT_FOUND` before the plan is written. The wire question type
   * keeps the scope and competence gates meaningful for such a plan instead
   * of rejecting the batch over a template id EVD never validated.
   */
  switch (question.question_type) {
    case "noul":
      return "behavior_relation";
    case "choice":
      return "acceptance_relation";
    case "score":
      return "step_effect";
    default:
      return "intent_relation";
  }
}

function typedQuestionFor(question: PlannedQuestion): TypedJudgeQuestion {
  if (question.question_type === "noul") {
    const noul: NoulQuestion = { type: "noul", instructions: question.instructions };
    const trueText = question.criteria.true;
    const falseText = question.criteria.false;
    if (trueText !== undefined && falseText !== undefined) {
      noul.criteria = { true: trueText, false: falseText };
    }
    return noul;
  }
  if (question.question_type === "choice") {
    const criteria: Record<string, string> = {};
    for (const option of question.options) {
      criteria[option.option_key] = option.description;
    }
    const choice: ChoiceQuestion = { type: "choice", instructions: question.instructions, criteria };
    return choice;
  }
  const levels = question.criteria.levels ?? [];
  const score: ScoreQuestion = { type: "score", instructions: question.instructions, criteria: levels };
  return score;
}

function optionOrderFor(question: PlannedQuestion): string[] {
  if (question.question_type !== "choice") {
    return [];
  }
  if (question.options.length > 0) {
    return question.options.map((option) => option.option_key);
  }
  return question.criteria.levels ?? [];
}

function validateQuestions(questions: readonly PlannedQuestion[]): Result<true, import("./types.js").EvdError> {
  if (questions.length === 0) {
    return evdForwarded("E_TEMPLATE_BINDING_MISSING", {});
  }
  const keys = new Set<string>();
  for (const question of questions) {
    if (question.question_type === "box") {
      return evdErr("E_UNSUPPORTED_QUESTION_TYPE", {
        question_key: question.question_key,
        type: "box",
      });
    }
    if (question.template_id === "" || question.template_version === "") {
      return evdForwarded("E_TEMPLATE_BINDING_MISSING", {});
    }
    if (keys.has(question.question_key)) {
      return evdForwarded("E_TEMPLATE_BINDING_MISSING", {});
    }
    keys.add(question.question_key);
    if (question.question_type === "choice") {
      const options = optionOrderFor(question);
      if (options.length < 2 || options.length > 255) {
        return evdErr("E_OPTION_COUNT", {
          question_key: question.question_key,
          observed: options.length,
          min: 2,
          max: 255,
        });
      }
      if (!options.includes("unknown")) {
        return evdErr("E_UNKNOWN_OPTION", { question_key: question.question_key, option: "unknown" });
      }
      for (const option of options) {
        if (!(option in question.option_effects)) {
          return evdErr("E_PLAN_AGGREGATION_BINDING", {
            question_key: question.question_key,
            field: "option_effects",
          });
        }
      }
    }
    if (question.independence.answer_independent !== true) {
      return evdErr("E_PLAN_AGGREGATION_BINDING", {
        question_key: question.question_key,
        field: "independence.answer_independent",
      });
    }
  }
  return evdOk(true);
}

export function questionBindingFor(question: PlannedQuestion): QuestionBinding {
  return {
    question_id: question.question_id,
    question_key: question.question_key,
    template_id: question.template_id,
    template_version: question.template_version,
    template_hash: question.template_hash,
    proposition_id: question.proposition_id,
    requirement_ids: sortUtf8Strings(question.requirement_ids),
    required_for_issue: question.required_for_issue,
    option_order: optionOrderFor(question),
    option_effects: question.option_effects,
    answer_to_issue_map: question.answer_to_issue_map,
    independence: question.independence,
  };
}

export function buildTemplateBindings(
  plan: QuestionPlan,
  questions: readonly PlannedQuestion[]
): TemplateBinding[] {
  const byKey = new Map(plan.questions.map((question) => [question.question_key, question]));
  const bindings: TemplateBinding[] = [];
  for (const question of questions) {
    const planned = byKey.get(question.question_key);
    if (planned === undefined) {
      continue;
    }
    bindings.push({
      question_key: planned.question_key,
      template_id: planned.template_id,
      template_version: planned.template_version,
      template_hash: planned.template_hash,
    });
  }
  return sortByQuestionKey(bindings);
}

function sortByQuestionKey(bindings: TemplateBinding[]): TemplateBinding[] {
  return bindings.sort((a, b) => (a.question_key < b.question_key ? -1 : 1));
}

function buildNoulBindings(
  questions: readonly PlannedQuestion[],
  options: SemanticQuestionOptions | undefined
): NoulPropositionBinding[] {
  const bindings: NoulPropositionBinding[] = [];
  for (const question of questions) {
    if (question.question_type !== "noul") {
      continue;
    }
    const mappingKey = `${question.question_key}|${question.proposition_id}`;
    const mapping = options?.noul_mappings?.get(mappingKey);
    const inconsistent = mapping?.inconsistent_equivalent ?? false;
    bindings.push({
      schema_version: "rsi.noul_proposition_binding/1",
      binding_id: newId("bind"),
      question_key: question.question_key,
      proposition_id: question.proposition_id,
      requirement_ids: sortUtf8Strings(question.requirement_ids),
      p_yes_means: "proposition_true",
      inconsistent_equivalent: inconsistent,
      equivalence_source: inconsistent ? "pre_registered_mapping" : "none",
      mapping_version: mapping?.mapping_version ?? "none/1",
    });
  }
  return bindings.sort((a, b) => (a.question_key < b.question_key ? -1 : 1));
}

function semanticQuestion(
  question: PlannedQuestion,
  questionClass: SemanticQuestionRequest["question_class"],
  manifest: JudgeStateManifest
): SemanticQuestionRequest {
  const required = new Set(question.required_source_ids);
  const matched = manifest.entries.filter((entry) =>
    entry.source_ids.some((sourceId) => required.has(sourceId))
  );
  const evidenceRefs =
    matched.length > 0
      ? sortUtf8Strings(matched.flatMap((entry) => entry.source_refs))
      : sortUtf8Strings(manifest.entries.flatMap((entry) => entry.source_refs));
  return {
    question_key: question.question_key,
    question_class: questionClass,
    instructions: question.instructions,
    options:
      question.question_type === "choice"
        ? question.options.map((option) => ({
            option_key: option.option_key,
            description: option.description,
          }))
        : question.question_type === "score"
          ? (question.criteria.levels ?? []).map((level, index) => ({
              option_key: String(index),
              description: level,
            }))
          : [
              { option_key: "true", description: "proposition is true" },
              { option_key: "false", description: "proposition is false" },
              { option_key: "unknown", description: "unknown" },
            ],
    required_for_issue: question.required_for_issue,
    proposition_id: question.proposition_id,
    requirement_ids: sortUtf8Strings(question.requirement_ids),
    evidence_refs: evidenceRefs as SourceRef[],
    template: {
      template_id: question.template_id,
      template_version: question.template_version,
      template_hash: question.template_hash,
    },
  };
}

function scopeCovers(
  scope: SemanticScope,
  questionClasses: readonly string[],
  issueType: string,
  stateProfile: string
): { field: string; observed: string; supported: string[] } | null {
  for (const questionClass of questionClasses) {
    if (!scope.question_classes.includes(questionClass as SemanticScope["question_classes"][number])) {
      return {
        field: "question_classes",
        observed: questionClass,
        supported: scope.question_classes,
      };
    }
  }
  if (!scope.issue_types.includes(issueType)) {
    return { field: "issue_types", observed: issueType, supported: scope.issue_types };
  }
  if (!scope.state_profiles.includes(stateProfile as SemanticScope["state_profiles"][number])) {
    return { field: "state_profiles", observed: stateProfile, supported: scope.state_profiles };
  }
  if (!scope.evidence_kinds.includes("source_excerpt")) {
    return {
      field: "evidence_kinds",
      observed: "source_excerpt",
      supported: scope.evidence_kinds,
    };
  }
  return null;
}

function missingCompetence(
  capability: SemanticBackendCapability,
  questionClasses: readonly string[]
): string | null {
  for (const questionClass of questionClasses) {
    const entry = capability.semantic_competence.find(
      (competence) => competence.question_class === questionClass
    );
    if (entry === undefined || entry.status === "unknown") {
      return questionClass;
    }
  }
  return null;
}

function evidenceEntries(
  manifest: JudgeStateManifest,
  units: readonly DependencyUnit[]
): SemanticBackendRequest["evidence"] {
  const byHash = new Map<string, { excerpt: string; sourceIds: string[] }>();
  for (const unit of units) {
    for (const entry of unit.state_evidence) {
      byHash.set(entry.content_hash, { excerpt: entry.excerpt, sourceIds: entry.source_ids });
    }
  }
  const evidence: SemanticBackendRequest["evidence"] = [];
  for (const entry of manifest.entries) {
    const found = byHash.get(entry.content_hash);
    if (found === undefined) {
      continue;
    }
    const sourceRef = entry.source_refs[0];
    if (sourceRef === undefined) {
      continue;
    }
    evidence.push({
      source_id: entry.source_ids[0] ?? found.sourceIds[0] ?? entry.logical_id,
      source_ref: sourceRef,
      excerpt: found.excerpt,
      content_hash: entry.content_hash,
      roles: sortUtf8Strings([entry.role]),
    });
  }
  return evidence.sort((a, b) => {
    if (a.source_id !== b.source_id) {
      return a.source_id < b.source_id ? -1 : 1;
    }
    return a.source_ref < b.source_ref ? -1 : 1;
  });
}

/**
 * The semantic-stage deadline: `min(FND RunBudget.remaining_ms, the caller's
 * declared semantic stage)`.
 *
 * DD-EVD-013 rule 10: "任一来源缺失、非正数或越界，按 `E_EVIDENCE_LIMITS_UNKNOWN`
 * 拒绝，不自行补默认值." The two sources are the FND-owned remaining budget
 * (`RunBudget.remaining_ms`) and the caller's frozen semantic-stage
 * declaration (`RunBudget.deadline_ms`).
 *
 * A budget that carries no remaining budget at all has only the stage
 * declaration, and that value is used as it stands; a budget that carries a
 * remaining budget must carry a usable one.
 */
function semanticStageDeadline(
  budget: BindingInput["budget"]
): { ok: true; value: number } | { ok: false } {
  const stage = budget.deadline_ms;
  if (!isUsableDeadline(stage)) {
    return { ok: false };
  }
  if (!("remaining_ms" in budget)) {
    return { ok: true, value: stage };
  }
  const remaining = budget.remaining_ms;
  if (!isUsableDeadline(remaining)) {
    return { ok: false };
  }
  return { ok: true, value: Math.min(remaining, stage) };
}

function isUsableDeadline(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 86_400_000
  );
}

export function buildJudgeRequest(
  context: BuildRequestContext
): Result<JudgeRequestBindingV3, import("./types.js").EvdError> {
  const { input, plan, shard, pack, manifest, state, capability, validator_binding } = context;
  if (plan.plan_id !== input.plan_id || plan.plan_hash !== input.plan_hash) {
    return evdForwarded("E_VERSION_BINDING", { field: "plan_id" });
  }
  if (plan.plan_state !== undefined && plan.plan_state !== "active") {
    return evdForwarded("E_PLAN_STALE", { field: "plan_state" });
  }
  if (
    capability.backend_key !== input.backend.backend_key ||
    capability.capability_key !== input.backend.capability_key ||
    capability.capability_hash !== input.backend.capability_hash ||
    capability.method.method_id !== input.backend.method.method_id ||
    capability.method.method_version !== input.backend.method.method_version ||
    capability.method.rule_version !== input.backend.method.rule_version
  ) {
    return evdForwarded("E_VERSION_BINDING", { field: "backend" });
  }
  if (validator_binding.validator_binding_id !== input.validator_binding_id) {
    return evdForwarded("E_VERSION_BINDING", { field: "validator_binding_id" });
  }
  if (validator_binding.capability_key !== capability.capability_key) {
    return evdForwarded("E_VERSION_BINDING", { field: "validator_binding_key" });
  }

  const shardQuestions = plan.questions.filter(
    (question) =>
      shard.question_keys.includes(question.question_key) ||
      shard.question_ids.includes(question.question_id)
  );
  const questionCheck = validateQuestions(shardQuestions);
  if (!questionCheck.ok) {
    return err(questionCheck.error);
  }
  const templateBindings = buildTemplateBindings(plan, shardQuestions);
  if (templateBindings.length !== shardQuestions.length) {
    return evdForwarded("E_TEMPLATE_BINDING_MISSING", {});
  }
  const requestedKeys = new Set(
    input.template_bindings.map((binding) => binding.question_key)
  );
  if (
    requestedKeys.size !== templateBindings.length ||
    templateBindings.some((binding) => !requestedKeys.has(binding.question_key))
  ) {
    return evdForwarded("E_TEMPLATE_BINDING_MISSING", {});
  }
  for (const binding of input.template_bindings) {
    const planned = templateBindings.find((entry) => entry.question_key === binding.question_key);
    if (
      planned === undefined ||
      planned.template_id !== binding.template_id ||
      planned.template_version !== binding.template_version ||
      planned.template_hash !== binding.template_hash
    ) {
      return evdForwarded("E_TEMPLATE_BINDING_MISSING", {});
    }
  }

  const stateJson = JSON.parse(JSON.stringify(state)) as JsonValue;
  const stateHash = stateHashOf(stateJson);
  const stateContent = stateContentHash(stateJson);
  const questionBindings = shardQuestions.map(questionBindingFor);
  const questionDigest = questionBindingsDigest(questionBindings);
  const noulBindings = buildNoulBindings(shardQuestions, context.options);
  const propositionDigest = propositionBindingsDigest(noulBindings);
  const digest = templateBindingsDigest(templateBindings);

  // Backend unknown: capability must be registered, verified and complete.
  if (
    capability.transport_status !== "verified" ||
    capability.limits.max_questions < 1 ||
    capability.limits.max_request_bytes < 1
  ) {
    return evdErr("E_SEMANTIC_BACKEND_UNKNOWN", {
      backend_key: capability.backend_key,
      reason: capability.transport_status !== "verified" ? "transport_unverified" : "limits_incomplete",
    });
  }
  const questionClasses: SemanticQuestionRequest["question_class"][] = [];
  const questionClassByKey = new Map<string, SemanticQuestionRequest["question_class"]>();
  for (const question of shardQuestions) {
    const questionClass = questionClassFor(question, plan.state_profile);
    questionClasses.push(questionClass);
    questionClassByKey.set(question.question_key, questionClass);
  }
  const scopeMiss = scopeCovers(capability.scope, questionClasses, plan.issue_type, plan.state_profile);
  if (scopeMiss !== null) {
    return evdErr("E_SEMANTIC_SCOPE_UNSUPPORTED", {
      backend_key: capability.backend_key,
      dimension: scopeMiss.field,
      observed: scopeMiss.observed,
      supported: scopeMiss.supported,
    });
  }
  const uncovered = missingCompetence(capability, questionClasses);
  if (uncovered !== null) {
    return evdErr("E_SEMANTIC_SCOPE_UNSUPPORTED", {
      backend_key: capability.backend_key,
      dimension: "semantic_competence",
      observed: uncovered,
      supported: capability.semantic_competence.map((entry) => entry.question_class),
    });
  }
  if (!capability.output_contracts.includes("categorical_option/1")) {
    return evdErr("E_SEMANTIC_CONTRACT_UNSUPPORTED", {
      backend_key: capability.backend_key,
      contract: "categorical_option/1",
      field: "output_contracts",
    });
  }
  if (validator_binding.policy_version !== "rsi.semantic.validator/1") {
    return evdErr("E_SEMANTIC_CONTRACT_UNSUPPORTED", {
      backend_key: capability.backend_key,
      contract: validator_binding.policy_version,
      field: "policy_version",
    });
  }

  if (input.budget.request_max_tokens === null || input.budget.question_max_tokens === null) {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "budget" });
  }
  // DD-EVD-013 rule 10: `deadline_ms = min(FND RunBudget.remaining_ms, the
  // caller's declared semantic stage)`. Each source is validated on its own:
  // a missing, non-positive or out-of-range value is `E_EVIDENCE_LIMITS_UNKNOWN`
  // and no default is invented for the absent source.
  const semanticDeadline = semanticStageDeadline(input.budget);
  if (!semanticDeadline.ok) {
    return evdErr("E_EVIDENCE_LIMITS_UNKNOWN", { field: "deadline_ms" });
  }

  const semanticQuestions = shardQuestions.map((question) =>
    semanticQuestion(
      question,
      questionClassByKey.get(question.question_key) ?? "intent_relation",
      manifest
    )
  );
  semanticQuestions.sort((a, b) => (a.question_key < b.question_key ? -1 : 1));
  const evidence = evidenceEntries(manifest, context.units ?? []);
  const questionSetHash = semanticQuestionSetHash(semanticQuestions);
  const evidenceSetHash = evidenceSetHashOf(evidence);

  let adapterRequest: JevTypedAdapterRequest | null = null;
  let contractHash: Hash | null = null;
  if (capability.backend_kind === "jev_typed") {
    const model = context.service_profile?.requested_model;
    if (model === undefined) {
      return evdErr("E_SEMANTIC_BACKEND_UNKNOWN", {
        backend_key: capability.backend_key,
        reason: "service_profile_missing",
      });
    }
    contractHash = adapterContractHash("jev_typed");
    if (contractHash === null) {
      return evdErr("E_SEMANTIC_CONTRACT_UNSUPPORTED", {
        backend_key: capability.backend_key,
        contract: "jev_typed",
        field: "adapter_contract",
      });
    }
    const typedQuestions: Record<string, TypedJudgeQuestion> = {};
    for (const question of shardQuestions) {
      typedQuestions[question.question_key] = typedQuestionFor(question);
    }
    adapterRequest = {
      schema_version: "rsi.jev_typed_adapter_request/1",
      model,
      state,
      questions: typedQuestions,
      adapter_contract_hash: contractHash,
    };
  }

  const scopeKey = semanticScopeKey(capability.scope);
  const requestHash = requestHashV3({
    backend: input.backend,
    scope_key: scopeKey,
    pack_hash: pack.pack_hash,
    manifest_hash: manifest.manifest_hash,
    state_content_hash: stateContent,
    question_set_hash: questionSetHash,
    evidence_set_hash: evidenceSetHash,
    adapter_request_hash: adapterRequest?.adapter_contract_hash ?? null,
  });
  const dispatchKey = dispatchKeyV3({
    request_hash: requestHash,
    backend: input.backend,
    scope_key: scopeKey,
    validator_binding_key: validator_binding.validator_binding_key,
    question_set_hash: questionSetHash,
    question_bindings_digest: questionDigest,
    adapter_request_hash: adapterRequest?.adapter_contract_hash ?? null,
  });
  const stateBytes = utf8Length(JSON.stringify(stateJson));
  const stateRef: SourceRef =
    context.state_ref ??
    (`blob://${stateContent}#bytes=0-${String(stateBytes)}` as SourceRef);

  const request: SemanticBackendRequest = {
    schema_version: "rsi.semantic_backend_request/1",
    request_id: newId("jreq"),
    binding_id: newId("bind"),
    backend: input.backend,
    method: capability.method,
    scope: capability.scope,
    pack: { pack_id: pack.pack_id, pack_key: pack.pack_key, pack_hash: pack.pack_hash },
    manifest: {
      manifest_id: manifest.manifest_id,
      manifest_key: manifest.manifest_key,
      manifest_hash: manifest.manifest_hash,
    },
    state: {
      schema_version: "rsi.judge_state/2",
      state_ref: stateRef,
      state_hash: stateHash,
      state_content_hash: stateContent,
      content_bytes: stateBytes,
    },
    evidence,
    questions: semanticQuestions,
    question_set_hash: questionSetHash,
    evidence_set_hash: evidenceSetHash,
    deadline_ms: semanticDeadline.value,
    budget_ref: context.budget_ref ?? (`blob://${stateContent}#bytes=0-${String(stateBytes)}` as SourceRef),
    authorization_ref: null,
    adapter_request: adapterRequest,
    created_at: input.created_at,
  };

  return evdOk({
    schema_version: "rsi.judge_request_binding/3",
    binding_id: request.binding_id,
    request_id: request.request_id,
    shard_id: shard.shard_id,
    shard_key: shard.shard_key,
    shard_plan_id: input.shard_plan_id,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    issue_id: plan.issue_id,
    pack_id: pack.pack_id,
    pack_hash: pack.pack_hash,
    binding: input.version_binding,
    backend: input.backend,
    request_schema_version: "rsi.semantic_backend_request/1",
    service_profile_id: input.service_profile_id,
    service_profile_key: capability.capability_key,
    validator_binding_id: validator_binding.validator_binding_id,
    validator_binding_key: validator_binding.validator_binding_key,
    template_bindings: templateBindings,
    template_bindings_digest: digest,
    question_bindings: questionBindings,
    question_bindings_digest: questionDigest,
    proposition_bindings_digest: propositionDigest,
    request,
    question_set_hash: questionSetHash,
    evidence_set_hash: evidenceSetHash,
    adapter_contract_hash: contractHash,
    request_hash: requestHash,
    dispatch_key: dispatchKey,
    created_at: input.created_at,
  });
}

function inputStateRef(contentHash: Hash): SourceRef {
  return `blob://${contentHash}#bytes=0-0` as SourceRef;
}

function evidenceSetHashOf(evidence: readonly SemanticBackendRequest["evidence"][number][]): Hash {
  return semanticEvidenceSetHash(
    evidence.map((entry) => ({
      source_id: entry.source_id,
      source_ref: entry.source_ref,
      content_hash: entry.content_hash,
      roles: entry.roles,
    }))
  );
}

function backendRefOf(capability: SemanticBackendCapability, scopeKey: Hash): SemanticBackendRef {
  return {
    schema_version: "rsi.semantic_backend_ref/1",
    backend_key: capability.backend_key,
    backend_kind: capability.backend_kind,
    method: capability.method,
    scope_key: scopeKey,
    capability_key: capability.capability_key,
    capability_hash: capability.capability_hash,
  };
}

export { backendRefOf };
