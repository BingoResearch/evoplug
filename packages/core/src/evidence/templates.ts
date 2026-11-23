/**
 * Built-in question templates and the read-only registry (DD-QP-11 … DD-QP-17).
 *
 * The registry ships with the product version. Templates are exact-versioned;
 * hashes are computed with `sha256(JCS(template_body))`, never hand-written.
 */

import { sortUtf8 } from "../canonical.js";
import type {
  ChoiceOption,
  ChoiceOptionMapping,
  IssueType,
  JudgeStateViewName,
  QuestionTemplate,
  QuestionTemplateRegistry,
  RequiredSourceSpec
} from "./types.js";
import {
  MAX_CHOICE_OPTIONS,
  MAX_OUTPUT_RESERVE_TOKENS,
  MIN_CHOICE_OPTIONS,
  MIN_OUTPUT_RESERVE_TOKENS
} from "./constants.js";
import { registryHash, sortedUnique, templateHash } from "./hashes.js";
import { QpDomainError } from "./issue_repository.js";
import { qpFailure } from "./errors.js";

const ALL_VIEWS: readonly JudgeStateViewName[] = Object.freeze([
  "binding",
  "question_scope",
  "requirements",
  "latest_input",
  "evidence",
  "comparison",
  "coverage",
  "task_conditions",
  "experience_candidates"
]);

const SHARED_VIEWS: readonly JudgeStateViewName[] = Object.freeze(["binding", "question_scope", "coverage"]);

const PLACEHOLDERS = ["{requirement_ids}", "{artifact_paths}", "{experience_id}", "{issue_type}"] as const;

function mapping(input: {
  axis: ChoiceOptionMapping["semantic_axis"];
  value: ChoiceOptionMapping["semantic_value"];
  effect: "supports" | "contradicts" | "unknown";
  issue_effect: ChoiceOptionMapping["issue_effect"];
  requires_local_authorization?: boolean;
}): ChoiceOptionMapping {
  return {
    semantic_axis: input.axis,
    semantic_value: input.value,
    option_effect: input.effect,
    issue_effect: input.issue_effect,
    requires_local_authorization: input.requires_local_authorization ?? false,
    can_close_issue: false,
    can_satisfy_task: false
  };
}

function option(key: string, criteria: string, value: ChoiceOptionMapping): ChoiceOption {
  return { key, criteria, mapping: value };
}

function source(input: RequiredSourceSpec): RequiredSourceSpec {
  const result: RequiredSourceSpec = {
    role: input.role,
    selector: input.selector,
    presence: input.presence,
    min_count: input.min_count,
    max_count: input.max_count,
    view: input.view,
    selection: input.selection,
    omission_impact: input.omission_impact
  };
  if (input.required_if !== undefined) {
    result.required_if = input.required_if;
  }
  return result;
}

function withHash(
  body: Omit<QuestionTemplate, "template_hash" | "status" | "supersedes">
): QuestionTemplate {
  return { ...body, template_hash: templateHash(body), status: "active" };
}

function intentRelation(): QuestionTemplate {
  return withHash({
    schema_version: "rsi.question_template/1",
    template_id: "qt.intent_relation",
    template_version: "1.0.0",
    question_type: "choice",
    issue_types: ["goal_change"],
    cardinality: "per_issue",
    required_views: [...SHARED_VIEWS, "requirements", "latest_input"],
    required_sources: [
      source({
        role: "latest_input_quote",
        selector: "latest_input",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "latest_input",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "active_requirement_quote",
        selector: "active_requirement",
        presence: "required",
        min_count: 1,
        max_count: 16,
        view: "requirements",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "proposed_relation",
        selector: "active_requirement",
        presence: "optional",
        min_count: 0,
        max_count: 1,
        view: "requirements",
        selection: "first_k",
        omission_impact: "none"
      })
    ],
    options: [
      option(
        "restatement",
        "新输入与列出的活动要求表达同一约束与范围，未增加、删除或改变任何验收条件",
        mapping({ axis: "intent_relation", value: "neutral", effect: "unknown", issue_effect: "candidate_relation_only" })
      ),
      option(
        "clarification",
        "新输入补充或明确了至少一项列出要求的 scope 或 acceptance，但未以不同内容替代任何列出要求",
        mapping({ axis: "intent_relation", value: "neutral", effect: "unknown", issue_effect: "candidate_relation_only" })
      ),
      option(
        "supersession",
        "新输入以不同内容替代至少一项列出要求，并明确排除或收窄其原适用范围；本题只识别关系，不授予目标变更权限",
        mapping({ axis: "intent_relation", value: "neutral", effect: "unknown", issue_effect: "candidate_relation_only" })
      ),
      option(
        "unknown",
        "原文指代、适用范围或候选覆盖关系不足以区分为 restatement、clarification 或 supersession",
        mapping({ axis: "intent_relation", value: "unknown", effect: "unknown", issue_effect: "needs_evidence" })
      )
    ],
    instructions_template:
      "只分类已展示的新输入与活动要求关系，不生成缺失原意，不执行替代或撤回。要求：{requirement_ids}。issue 类型：{issue_type}。",
    question_text_template: "新输入与要求 {requirement_ids} 的关系是什么？",
    proposition_family: "intent_relation",
    output_reserve_tokens: 128
  });
}

function behaviorRelation(): QuestionTemplate {
  return withHash({
    schema_version: "rsi.question_template/1",
    template_id: "qt.behavior_relation",
    template_version: "1.0.0",
    question_type: "choice",
    issue_types: ["constraint_violation", "wrong_target"],
    cardinality: "per_requirement",
    required_views: [...SHARED_VIEWS, "requirements", "evidence"],
    required_sources: [
      source({
        role: "active_requirement_quote",
        selector: "active_requirement",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "requirements",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "current_artifact_fact",
        selector: "artifact_fact",
        presence: "required",
        min_count: 1,
        max_count: 8,
        view: "evidence",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "interface_contract",
        selector: "interface_contract",
        presence: "optional",
        min_count: 0,
        max_count: 4,
        required_if: "issue.contract_required",
        view: "evidence",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "test_verifier_result",
        selector: "verifier_result",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "evidence",
        selection: "first_k",
        omission_impact: "none"
      }),
      source({
        role: "counterevidence_search",
        selector: "counterevidence_search",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "coverage",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "counterevidence",
        selector: "counterevidence",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "evidence",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "feedback_context",
        selector: "feedback",
        presence: "optional",
        min_count: 0,
        max_count: 1,
        view: "evidence",
        selection: "first_k",
        omission_impact: "none"
      })
    ],
    options: [
      option(
        "consistent",
        "列出的行为或产物满足所列要求的明确 scope、排除项与验收条件，且未发现影响该结论的反证",
        mapping({
          axis: "requirement_compliance",
          value: "positive",
          effect: "supports",
          issue_effect: "judged_consistent"
        })
      ),
      option(
        "inconsistent",
        "列出的行为或产物违反所列要求中的至少一项明确约束，或修改了排除范围内的对象",
        mapping({
          axis: "requirement_compliance",
          value: "negative",
          effect: "contradicts",
          issue_effect: "judged_inconsistent"
        })
      ),
      option(
        "unknown",
        "缺少必要依赖、当前产物版本不一致、反证检索不完整或语义不足以判断",
        mapping({ axis: "requirement_compliance", value: "unknown", effect: "unknown", issue_effect: "needs_evidence" })
      )
    ],
    instructions_template:
      "只判断列出的行为或产物是否满足要求 {requirement_ids} 与产物路径 {artifact_paths}，不推断未展示的行为。issue 类型：{issue_type}。",
    question_text_template: "当前产物是否满足要求 {requirement_ids}？",
    proposition_family: "requirement_compliance",
    output_reserve_tokens: 128
  });
}

function stepEffect(): QuestionTemplate {
  return withHash({
    schema_version: "rsi.question_template/1",
    template_id: "qt.step_effect",
    template_version: "1.0.0",
    question_type: "choice",
    issue_types: ["stall_or_regression_candidate"],
    cardinality: "per_issue",
    required_views: [...SHARED_VIEWS, "requirements", "evidence", "comparison"],
    required_sources: [
      source({
        role: "baseline_checkpoint",
        selector: "baseline_checkpoint",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "comparison",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "current_checkpoint",
        selector: "current_checkpoint",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "comparison",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "before_artifact_fact",
        selector: "artifact_fact",
        presence: "required",
        min_count: 1,
        max_count: 8,
        view: "evidence",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "after_artifact_fact",
        selector: "artifact_fact",
        presence: "required",
        min_count: 1,
        max_count: 8,
        view: "evidence",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "verification_change",
        selector: "verifier_result",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "evidence",
        selection: "first_k",
        omission_impact: "none"
      }),
      source({
        role: "pending_work",
        selector: "pending_work",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "comparison",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "excluded_hypothesis",
        selector: "baseline_checkpoint",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "comparison",
        selection: "first_k",
        omission_impact: "none"
      }),
      source({
        role: "active_requirement_quote",
        selector: "active_requirement",
        presence: "required",
        min_count: 1,
        max_count: 8,
        view: "requirements",
        selection: "all",
        omission_impact: "answer_changing"
      })
    ],
    options: [
      option(
        "advances",
        "比较区间内的变更缩小了所列要求的已知验收差距，并有独立产物或验证增量",
        mapping({ axis: "progress_effect", value: "positive", effect: "unknown", issue_effect: "shadow_only" })
      ),
      option(
        "information_gain",
        "没有形成可验证修复，但排除了与当前问题相关的假设或取得影响后续判断的新证据",
        mapping({ axis: "progress_effect", value: "neutral", effect: "unknown", issue_effect: "shadow_only" })
      ),
      option(
        "repeats_without_gain",
        "与 baseline 相比，输入、产物、验证和已知信息均无实质变化",
        mapping({ axis: "progress_effect", value: "neutral", effect: "unknown", issue_effect: "shadow_only" })
      ),
      option(
        "regresses",
        "变更破坏此前已满足的适用行为，或扩大当前目标下已展示的差距",
        mapping({ axis: "progress_effect", value: "negative", effect: "unknown", issue_effect: "shadow_only" })
      ),
      option(
        "unknown",
        "缺少可比 baseline、当前产物或必要验证，无法判断局部推进或回归",
        mapping({ axis: "progress_effect", value: "unknown", effect: "unknown", issue_effect: "needs_evidence" })
      )
    ],
    instructions_template:
      "只比较给出的 baseline 与当前 checkpoint，不设置时间或工具次数阈值。要求：{requirement_ids}。",
    question_text_template: "比较区间内是否取得可验证进展？",
    proposition_family: "progress_effect",
    output_reserve_tokens: 128
  });
}

function acceptanceRelation(): QuestionTemplate {
  return withHash({
    schema_version: "rsi.question_template/1",
    template_id: "qt.acceptance_relation",
    template_version: "1.0.0",
    question_type: "choice",
    issue_types: ["missing_requirement"],
    cardinality: "per_acceptance_item",
    required_views: [...SHARED_VIEWS, "requirements", "evidence"],
    required_sources: [
      source({
        role: "acceptance_criterion",
        selector: "acceptance_criterion",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "requirements",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "current_artifact_fact",
        selector: "artifact_fact",
        presence: "required",
        min_count: 1,
        max_count: 8,
        view: "evidence",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "current_verifier_result",
        selector: "verifier_result",
        presence: "optional",
        min_count: 0,
        max_count: 4,
        view: "evidence",
        selection: "first_k",
        omission_impact: "none"
      }),
      source({
        role: "counterevidence_search",
        selector: "counterevidence_search",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "coverage",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "counterevidence",
        selector: "counterevidence",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "evidence",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "human_acceptance",
        selector: "feedback",
        presence: "optional",
        min_count: 0,
        max_count: 1,
        view: "evidence",
        selection: "first_k",
        omission_impact: "none"
      })
    ],
    options: [
      option(
        "satisfied",
        "列出的当前产物在给出的验收条件全部范围内满足要求，且有与当前产物版本一致的独立验证或可核对产物证据",
        mapping({
          axis: "requirement_compliance",
          value: "positive",
          effect: "supports",
          issue_effect: "judged_satisfied"
        })
      ),
      option(
        "not_satisfied",
        "列出的当前产物至少违反一项给出的验收条件，或有当前版本的反证",
        mapping({
          axis: "requirement_compliance",
          value: "negative",
          effect: "contradicts",
          issue_effect: "judged_not_satisfied"
        })
      ),
      option(
        "unknown",
        "验收条件、产物版本、验证口径或必要依赖不足以判断",
        mapping({ axis: "requirement_compliance", value: "unknown", effect: "unknown", issue_effect: "needs_evidence" })
      )
    ],
    instructions_template:
      "只判断要求 {requirement_ids} 的验收条件在产物路径 {artifact_paths} 上是否满足，不替代全任务验收覆盖门。",
    question_text_template: "要求 {requirement_ids} 的验收条件是否已满足？",
    proposition_family: "acceptance_compliance",
    output_reserve_tokens: 128
  });
}

function experienceMatch(): QuestionTemplate {
  return withHash({
    schema_version: "rsi.question_template/1",
    template_id: "qt.experience_match",
    template_version: "1.0.0",
    question_type: "choice",
    issue_types: ["experience_applicability"],
    cardinality: "per_experience_candidate",
    required_views: [...SHARED_VIEWS, "requirements", "evidence", "task_conditions", "experience_candidates"],
    required_sources: [
      source({
        role: "task_condition",
        selector: "task_condition",
        presence: "required",
        min_count: 1,
        max_count: 16,
        view: "task_conditions",
        selection: "all",
        omission_impact: "answer_changing"
      }),
      source({
        role: "experience_candidate",
        selector: "experience_candidate",
        presence: "required",
        min_count: 1,
        max_count: 1,
        view: "experience_candidates",
        selection: "first_k",
        omission_impact: "answer_changing"
      }),
      source({
        role: "experience_evidence",
        selector: "experience_evidence",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "experience_candidates",
        selection: "all",
        omission_impact: "none"
      }),
      source({
        role: "conflict_context",
        selector: "counterevidence",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "evidence",
        selection: "all",
        omission_impact: "none"
      }),
      source({
        role: "active_requirement_quote",
        selector: "active_requirement",
        presence: "optional",
        min_count: 0,
        max_count: 8,
        view: "requirements",
        selection: "all",
        omission_impact: "none"
      })
    ],
    options: [
      option(
        "applicable",
        "候选经验的触发条件、前提与适用范围全部被当前任务条件满足，且没有与当前要求或已核实结果冲突的反例",
        mapping({
          axis: "experience_applicability",
          value: "positive",
          effect: "supports",
          issue_effect: "shadow_only"
        })
      ),
      option(
        "conflict",
        "当前任务条件明确违反候选经验的适用前提，或候选步骤与当前活动要求或约束冲突",
        mapping({
          axis: "experience_applicability",
          value: "negative",
          effect: "contradicts",
          issue_effect: "shadow_only"
        })
      ),
      option(
        "unknown",
        "任务条件、候选内容、已核实使用结果或本地 scope/授权状态不足以判断",
        mapping({
          axis: "experience_applicability",
          value: "unknown",
          effect: "unknown",
          issue_effect: "needs_evidence"
        })
      )
    ],
    instructions_template:
      "只判断候选经验 {experience_id} 的适用性，不生成经验正文、不批准写入、不改变 lifecycle。要求：{requirement_ids}。",
    question_text_template: "候选经验 {experience_id} 是否适用于当前任务条件？",
    proposition_family: "experience_applicability",
    output_reserve_tokens: 128
  });
}

/** The five built-in templates in registry order. */
export function builtinTemplates(): QuestionTemplate[] {
  return [intentRelation(), behaviorRelation(), stepEffect(), acceptanceRelation(), experienceMatch()];
}

/** Template id → template for exact version `1.0.0`. */
export function builtinTemplateMap(): Map<string, QuestionTemplate> {
  return new Map(builtinTemplates().map((template) => [template.template_id, template]));
}

/** Template bodies published alongside each registry snapshot. */
const REGISTRY_BODIES = new WeakMap<object, readonly QuestionTemplate[]>();
const REGISTRY_BODIES_BY_HASH = new Map<string, readonly QuestionTemplate[]>();

function rememberRegistryBodies(registry: QuestionTemplateRegistry, templates: readonly QuestionTemplate[]): void {
  const frozen = Object.freeze([...templates]);
  REGISTRY_BODIES.set(registry, frozen);
  REGISTRY_BODIES_BY_HASH.set(registry.registry_hash, frozen);
}

/** Bodies loaded with this registry snapshot, or `null` when unknown. */
export function registryTemplateBodies(registry: QuestionTemplateRegistry): readonly QuestionTemplate[] | null {
  return REGISTRY_BODIES.get(registry) ?? REGISTRY_BODIES_BY_HASH.get(registry.registry_hash) ?? null;
}

function versionParts(version: string): [number, number, number] {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

/**
 * Resolves the primary template for an issue type from the registry snapshot.
 * The registry pins exact versions; the body must be the one published with
 * that snapshot and its hash must match the summary.
 */
export function requireTemplateFromRegistry(input: {
  registry: QuestionTemplateRegistry;
  issue_type: IssueType;
}): QuestionTemplate {
  const templateId = primaryTemplateId(input.issue_type);
  if (templateId === null) {
    throw new QpDomainError(
      qpFailure("E_TEMPLATE_NOT_FOUND", "plan", {
        issue_type: input.issue_type,
        reason: "no_template_for_issue_type"
      })
    );
  }
  const summaries = input.registry.templates.filter((entry) => entry.template_id === templateId);
  if (summaries.length === 0) {
    throw new QpDomainError(qpFailure("E_TEMPLATE_NOT_FOUND", "plan", { template_id: templateId }));
  }
  const active = summaries.filter((entry) => entry.status === "active");
  if (active.length === 0) {
    throw new QpDomainError(qpFailure("E_TEMPLATE_DEPRECATED", "plan", { template_id: templateId }));
  }
  active.sort((left, right) => compareVersions(right.template_version, left.template_version));
  const summary = active[0];
  if (summary === undefined) {
    throw new QpDomainError(qpFailure("E_TEMPLATE_NOT_FOUND", "plan", { template_id: templateId }));
  }
  const bodies = registryTemplateBodies(input.registry);
  const candidates = bodies ?? builtinTemplates();
  const template = findTemplate(candidates, templateId, summary.template_version);
  if (template === null) {
    throw new QpDomainError(
      qpFailure("E_TEMPLATE_NOT_FOUND", "plan", {
        template_id: templateId,
        template_version: summary.template_version
      })
    );
  }
  if (template.template_hash !== summary.template_hash) {
    throw new QpDomainError(
      qpFailure("E_TEMPLATE_HASH_MISMATCH", "plan", {
        template_id: templateId,
        template_version: summary.template_version
      })
    );
  }
  if (template.status === "deprecated") {
    throw new QpDomainError(qpFailure("E_TEMPLATE_DEPRECATED", "plan", { template_id: templateId }));
  }
  if (!template.issue_types.includes(input.issue_type)) {
    throw new QpDomainError(qpFailure("E_TEMPLATE_ISSUE_TYPE_MISMATCH", "plan", { template_id: templateId }));
  }
  return template;
}

/** Builds the registry snapshot with computed hashes (DD-QP-12). */
export function buildTemplateRegistry(input: {
  registry_version: string;
  templates?: readonly QuestionTemplate[];
}): QuestionTemplateRegistry {
  const templates = input.templates ?? builtinTemplates();
  const summaries = sortUtf8(templates, (template) => `${template.template_id}@${template.template_version}`).map(
    (template) => ({
      template_id: template.template_id,
      template_version: template.template_version,
      template_hash: template.template_hash,
      status: template.status
    })
  );
  const withoutHash = {
    schema_version: "rsi.question_template_registry/1" as const,
    registry_version: input.registry_version,
    templates: summaries
  };
  const registry: QuestionTemplateRegistry = {
    ...withoutHash,
    registry_hash: registryHash(withoutHash)
  };
  validateRegistry(registry, templates);
  rememberRegistryBodies(registry, templates);
  return registry;
}

/** Issue type → primary template id (DD-QP-12); `null` means no template. */
export function primaryTemplateId(issueType: IssueType): string | null {
  switch (issueType) {
    case "constraint_violation":
    case "wrong_target":
      return "qt.behavior_relation";
    case "missing_requirement":
      return "qt.acceptance_relation";
    case "missing_verification":
    case "insufficient_evidence":
      return null;
    case "goal_change":
      return "qt.intent_relation";
    case "stall_or_regression_candidate":
      return "qt.step_effect";
    case "experience_applicability":
      return "qt.experience_match";
  }
}

/** Looks up a template body by exact id and version. */
export function findTemplate(
  templates: readonly QuestionTemplate[],
  template_id: string,
  template_version: string
): QuestionTemplate | null {
  for (const template of templates) {
    if (template.template_id === template_id && template.template_version === template_version) {
      return template;
    }
  }
  return null;
}

const TEMPLATE_PLACEHOLDER_PATTERN = /\{[a-z_]+\}/gu;

function placeholders(value: string): string[] {
  return value.match(TEMPLATE_PLACEHOLDER_PATTERN) ?? [];
}

function validatePlaceholders(value: string, field: string): void {
  for (const placeholder of placeholders(value)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(placeholder)) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field, placeholder }));
    }
  }
}

function validateTemplate(template: QuestionTemplate): void {
  if (template.question_type !== "choice") {
    throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "question_type" }));
  }
  if (template.options.length < MIN_CHOICE_OPTIONS || template.options.length > MAX_CHOICE_OPTIONS) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "options" }));
  }
  const keys = template.options.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length || !keys.includes("unknown")) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "options.keys" }));
  }
  for (const entry of template.options) {
    if (entry.criteria.trim().length === 0) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "options.criteria" }));
    }
  }
  const viewSet = new Set(template.required_views);
  for (const view of template.required_views) {
    if (!ALL_VIEWS.includes(view)) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "required_views" }));
    }
  }
  for (const spec of template.required_sources) {
    if (!viewSet.has(spec.view)) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "required_sources.view" }));
    }
    if (spec.presence === "required" && spec.min_count < 1) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "required_sources.min_count" }));
    }
    if (spec.presence === "optional" && spec.min_count !== 0) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "required_sources.min_count" }));
    }
    if (spec.min_count > spec.max_count) {
      throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "required_sources.max_count" }));
    }
  }
  if (
    template.output_reserve_tokens < MIN_OUTPUT_RESERVE_TOKENS ||
    template.output_reserve_tokens > MAX_OUTPUT_RESERVE_TOKENS
  ) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "output_reserve_tokens" }));
  }
  validatePlaceholders(template.instructions_template, "instructions_template");
  validatePlaceholders(template.question_text_template, "question_text_template");
  if (template.question_text_template.length === 0 || template.instructions_template.length === 0) {
    throw new QpDomainError(qpFailure("E_SCHEMA", "template_load", { field: "template_text" }));
  }
}

/** Validates a full registry; any violated rule rejects the whole load. */
export function validateRegistry(
  registry: QuestionTemplateRegistry,
  templates: readonly QuestionTemplate[]
): void {
  const activeIds = new Set(templates.filter((template) => template.status === "active").map((template) => template.template_id));
  for (const required of [
    "qt.intent_relation",
    "qt.behavior_relation",
    "qt.step_effect",
    "qt.acceptance_relation",
    "qt.experience_match"
  ]) {
    if (!activeIds.has(required)) {
      throw new QpDomainError(qpFailure("E_TEMPLATE_NOT_FOUND", "template_load", { template_id: required }));
    }
  }
  const seen = new Map<string, string>();
  for (const template of templates) {
    validateTemplate(template);
    const computed = templateHash(template);
    if (computed !== template.template_hash) {
      throw new QpDomainError(
        qpFailure("E_TEMPLATE_HASH_MISMATCH", "template_load", { template_id: template.template_id })
      );
    }
    const summary = registry.templates.find(
      (entry) =>
        entry.template_id === template.template_id && entry.template_version === template.template_version
    );
    if (summary === undefined || summary.template_hash !== template.template_hash) {
      throw new QpDomainError(
        qpFailure("E_TEMPLATE_HASH_MISMATCH", "template_load", { template_id: template.template_id })
      );
    }
    const identity = `${template.template_id}@${template.template_version}`;
    const prior = seen.get(identity);
    if (prior !== undefined && prior !== template.template_hash) {
      throw new QpDomainError(qpFailure("E_TEMPLATE_HASH_MISMATCH", "template_load", { template_id: template.template_id }));
    }
    seen.set(identity, template.template_hash);
  }
  if (registryHash(registry) !== registry.registry_hash) {
    throw new QpDomainError(qpFailure("E_TEMPLATE_HASH_MISMATCH", "template_load", { field: "registry_hash" }));
  }
}

/** Exact-version template lookup with the planner failure codes. */
export function requireTemplate(input: {
  registry: QuestionTemplateRegistry;
  templates: readonly QuestionTemplate[];
  issue_type: IssueType;
}): QuestionTemplate {
  const templateId = primaryTemplateId(input.issue_type);
  if (templateId === null) {
    throw new QpDomainError(
      qpFailure("E_TEMPLATE_NOT_FOUND", "plan", { issue_type: input.issue_type, reason: "no_template_for_issue_type" })
    );
  }
  const template = findTemplate(input.templates, templateId, "1.0.0");
  if (template === null) {
    throw new QpDomainError(qpFailure("E_TEMPLATE_NOT_FOUND", "plan", { template_id: templateId }));
  }
  if (!template.issue_types.includes(input.issue_type)) {
    throw new QpDomainError(
      qpFailure("E_TEMPLATE_ISSUE_TYPE_MISMATCH", "plan", { template_id: templateId })
    );
  }
  if (template.status === "deprecated") {
    throw new QpDomainError(qpFailure("E_TEMPLATE_DEPRECATED", "plan", { template_id: templateId }));
  }
  return template;
}

/** Renders a fixed template with controlled placeholders only (DD-QP-10). */
export function renderTemplate(
  text: string,
  values: {
    requirement_ids?: readonly string[];
    artifact_paths?: readonly string[];
    experience_id?: string | null;
    issue_type?: string;
  }
): string {
  const replacements: Record<string, string> = {
    "{requirement_ids}": sortedUnique(values.requirement_ids ?? []).join(", "),
    "{artifact_paths}": sortedUnique(values.artifact_paths ?? []).join(", "),
    "{experience_id}": values.experience_id ?? "",
    "{issue_type}": values.issue_type ?? ""
  };
  return text.replace(/\{[a-z_]+\}/gu, (match) => replacements[match] ?? match);
}

