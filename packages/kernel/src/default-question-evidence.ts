/** QP-owned repository reads adapted to the EVD compiler and aggregator. */
import { err, makeErrorEnvelope, ok } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, VersionBinding } from "@evoplug/core";
import { planHash } from "@evoplug/core/evidence";
import type { IssueReadRepository, PlanReadResult, QuestionPlanRepository } from "@evoplug/core/evidence";
import { evdError, evdForwardedError } from "@evoplug/evidence";
import type {
  AggregatePlanView,
  EvidenceIssueReadPort,
  EvidencePlanReadPort,
  PlanReadPort,
  PlannedQuestion,
  QuestionPlan
} from "@evoplug/evidence";

function fieldError(code: "E_PLAN_NOT_FOUND" | "E_SCHEMA" | "E_STATE_ROW_SCHEMA", field: string): ErrorEnvelope {
  if (code === "E_PLAN_NOT_FOUND") {
    return evdForwardedError(code, { kind: "field", path: field, rule: code });
  }
  return makeErrorEnvelope({
    code,
    category: "schema",
    message_key: "error.schema.invalid",
    stage: "qp_evidence_read",
    details: { kind: "field", path: field, rule: code }
  });
}

function versionError(code: "E_VERSION_BINDING" | "E_PLAN_HASH_MISMATCH", expected: string, actual: string): ErrorEnvelope {
  return evdForwardedError(code, { kind: "version", expected, actual });
}

function lifecycleError(result: Extract<PlanReadResult, { status: "rejected" }>, expectedHash: string): ErrorEnvelope {
  if (result.code === "E_PLAN_HASH_MISMATCH" || result.code === "E_VERSION_BINDING") {
    return versionError(result.code, expectedHash, "repository_read_rejected");
  }
  if (result.code === "E_PLAN_AGGREGATION_BINDING") {
    return evdError(result.code, {
      question_key: result.details.question_key ?? "",
      field: result.details.field ?? "plan_state"
    });
  }
  return fieldError(result.code, "plan_state");
}

function sameBinding(left: VersionBinding, right: VersionBinding): boolean {
  return left.task_id === right.task_id && left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch && left.goal_version === right.goal_version &&
    left.config_version === right.config_version && left.watermark === right.watermark;
}

function planForEvidence(plan: import("@evoplug/core/evidence").QuestionPlan): QuestionPlan {
  // Core QP stores ordered option keys and criteria; EVD consumes those same
  // options as typed records. Never pass the incompatible arrays through a cast.
  const questions: PlannedQuestion[] = plan.questions.map((question) => ({
    ...question,
    template_hash: question.template_hash as Hash,
    criteria: { ...question.criteria },
    options: question.options.map((key) => ({
      option_key: key,
      description: question.criteria[key]!,
      mapping: { ...question.answer_to_issue_map[key]! }
    }))
  }));
  const { supersedes_plan_id, ...body } = plan;
  return {
    ...body,
    plan_id: plan.plan_id as Id,
    plan_hash: plan.plan_hash as Hash,
    issue_id: plan.issue_id as Id,
    sources: plan.sources.map((source) => ({
      ...source,
      content_hash: source.content_hash as Hash,
      fact_value_hash: source.fact_value_hash as Hash | null
    })),
    dependencies: plan.dependencies.map((dependency) => ({
      ...dependency,
      content_hash: dependency.content_hash as Hash
    })),
    questions,
    ...(plan.supersedes_plan_id === undefined ? {} : { supersedes_plan_id: plan.supersedes_plan_id as Id })
  };
}

export interface DefaultQuestionEvidenceDeps {
  readonly plans: QuestionPlanRepository;
  readonly issues: IssueReadRepository;
}

export interface DefaultQuestionEvidencePorts {
  readonly plans: EvidencePlanReadPort;
  readonly issues: EvidenceIssueReadPort;
  readonly plan_states: PlanReadPort;
}

export function createDefaultQuestionEvidencePorts(deps: DefaultQuestionEvidenceDeps): DefaultQuestionEvidencePorts {
  const plans: EvidencePlanReadPort = {
    async readPlan(query) {
      // The repository's aggregate read uses the committed source when one is
      // present, and refuses a missing lifecycle even if a cache still exists.
      const lifecycle = deps.plans.readPlanForAggregate({
        plan_id: query.plan_id,
        expected_plan_hash: query.plan_hash,
        binding: query.binding
      });
      if (lifecycle.status === "rejected") {
        return err(lifecycleError(lifecycle, query.plan_hash));
      }
      const plan = deps.plans.getPlan(query.plan_id);
      if (plan === null || plan.plan_id !== query.plan_id) {
        return err(fieldError("E_PLAN_NOT_FOUND", "plan_id"));
      }
      if (plan.plan_hash !== query.plan_hash || planHash(plan) !== query.plan_hash) {
        return err(versionError("E_PLAN_HASH_MISMATCH", query.plan_hash, plan.plan_hash));
      }
      if (!sameBinding(plan.binding, query.binding)) {
        return err(versionError("E_VERSION_BINDING", JSON.stringify(query.binding), JSON.stringify(plan.binding)));
      }
      for (const question of plan.questions) {
        const keys = new Set(question.options);
        if (keys.size !== question.options.length || question.options.some((key) =>
          typeof question.criteria[key] !== "string" || question.answer_to_issue_map[key] === undefined
        )) {
          return err(fieldError("E_STATE_ROW_SCHEMA", "questions.options"));
        }
      }
      return ok(planForEvidence(plan));
    }
  };
  return {
    plans,
    issues: {
      async getIssue(query) {
        const issue = deps.issues.getIssue(query.issue_id);
        if (issue === null || issue.issue_id !== query.issue_id) {
          return err(fieldError("E_SCHEMA", "issue_id"));
        }
        // An issue can span evidence watermarks, but never a different scope or
        // a request earlier than the issue's own committed binding.
        if (!sameBinding({ ...issue.binding, watermark: query.binding.watermark }, query.binding) ||
          issue.binding.watermark > query.binding.watermark) {
          return err(versionError("E_VERSION_BINDING", JSON.stringify(query.binding), JSON.stringify(issue.binding)));
        }
        if (typeof issue.question_text !== "string" || issue.question_text.length === 0) {
          return err(fieldError("E_SCHEMA", "issue.question_text"));
        }
        return ok({
          issue_id: issue.issue_id as Id,
          issue_key: issue.issue_key,
          question: issue.question_text,
          requirement_ids: [...issue.requirement_ids],
          issue_type: issue.type
        });
      }
    },
    plan_states: {
      async readPlanForAggregate(query) {
        const read = await plans.readPlan({
          plan_id: query.plan_id,
          plan_hash: query.expected_plan_hash,
          binding: query.binding
        });
        if (!read.ok) return { ok: false, code: read.error.code, error: read.error };
        const lifecycle = deps.plans.readPlanForAggregate(query);
        if (lifecycle.status === "rejected") {
          const error = lifecycleError(lifecycle, query.expected_plan_hash);
          return { ok: false, code: error.code, error };
        }
        const plan = read.value;
        const view: AggregatePlanView = {
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash,
          issue_id: plan.issue_id,
          issue_key: plan.issue_key,
          binding: plan.binding,
          plan_state: lifecycle.view.plan_state,
          state_profile: plan.state_profile,
          aggregate_output_reserve_tokens: plan.aggregate_output_reserve_tokens,
          questions: plan.questions.map((question) => ({ ...question }))
        };
        return { ok: true, value: view };
      }
    }
  };
}
