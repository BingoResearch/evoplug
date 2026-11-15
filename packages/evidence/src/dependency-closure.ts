/**
 * Deterministic dependency closure expansion (DD-EVD-008, DD-EVD-012).
 *
 * Expansion only follows source ids, inseparable groups and derived view keys
 * already declared by QP. The algorithm is order-insensitive: queue and output
 * are sorted, cycles terminate through the visited set.
 */

import { newId, type Hash, type Result, type SourceRef } from "@evoplug/core";

import { evdErr, evdOk } from "./errors.js";
import { closureHash, omissionKey, sortUtf8Strings } from "./hashing.js";
import type {
  ClosureInput,
  ClosureResult,
  DependencyUnit,
  Omission,
  EvdError,
  OmissionReason,
} from "./types.js";

function omissionImpactFor(unit: DependencyUnit, requiredForIssue: boolean): {
  impact: Omission["impact"];
  plan_omission_impact: "answer_changing" | "none";
} {
  if (unit.transport_role === "counter") {
    return { impact: "blocking", plan_omission_impact: unit.omission_impact };
  }
  if (unit.omission_impact === "answer_changing") {
    return {
      impact: requiredForIssue ? "blocking" : "may_change_answer",
      plan_omission_impact: "answer_changing",
    };
  }
  if (!unit.can_omit) {
    return { impact: "blocking", plan_omission_impact: "none" };
  }
  return { impact: "none", plan_omission_impact: "none" };
}

export function expandDependencyClosure(
  input: ClosureInput
): Result<ClosureResult, EvdError> {
  if (input.schema_version !== "rsi.closure_input/1") {
    return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", { missing_question_keys: [] });
  }
  const required = new Set(input.required_question_keys);
  const optional = new Set(input.optional_question_keys);
  const units = [...input.units].sort((a, b) => (a.unit_key < b.unit_key ? -1 : 1));

  // Inseparable integrity: one dependency must map to one group identity.
  const dependencyGroups = new Map<string, string>();
  for (const unit of units) {
    const group = dependencyGroups.get(unit.dependency_key);
    if (group !== undefined && group !== unit.inseparable_group_key) {
      return evdErr("E_EVIDENCE_INSEPARABLE_SPLIT", {
        inseparable_group_key: unit.inseparable_group_key,
      });
    }
    dependencyGroups.set(unit.dependency_key, unit.inseparable_group_key);
  }

  // A call/result pair group is only complete with both halves; a lone unit
  // under the same pair identity is a split, never an implicit merge.
  const pairMembers = new Map<string, Set<string>>();
  for (const unit of units) {
    if (!unit.inseparable_group_key.startsWith("pair:")) {
      continue;
    }
    const bucket = pairMembers.get(unit.inseparable_group_key) ?? new Set<string>();
    bucket.add(unit.unit_key);
    pairMembers.set(unit.inseparable_group_key, bucket);
  }
  for (const [groupKey, members] of pairMembers) {
    if (members.size < 2) {
      return evdErr("E_EVIDENCE_INSEPARABLE_SPLIT", {
        inseparable_group_key: groupKey,
      });
    }
  }

  const sourceIndex = new Map<string, DependencyUnit[]>();
  const viewIndex = new Map<string, DependencyUnit[]>();
  for (const unit of units) {
    for (const sourceId of unit.source_ids) {
      const bucket = sourceIndex.get(sourceId);
      if (bucket === undefined) {
        sourceIndex.set(sourceId, [unit]);
      } else {
        bucket.push(unit);
      }
    }
    if (unit.derived_view_key !== undefined) {
      const bucket = viewIndex.get(unit.derived_view_key);
      if (bucket === undefined) {
        viewIndex.set(unit.derived_view_key, [unit]);
      } else {
        bucket.push(unit);
      }
    }
  }

  const queue: DependencyUnit[] = units.filter(
    (unit) =>
      unit.omission_impact === "answer_changing" &&
      unit.question_ids.some((questionId) => required.has(questionId) || optional.has(questionId))
  );
  queue.sort((a, b) => (a.dependency_key < b.dependency_key ? -1 : 1));
  const visited = new Set<string>();
  const closure: DependencyUnit[] = [];

  const enqueue = (unit: DependencyUnit): void => {
    if (unit.omission_impact !== "answer_changing") {
      return;
    }
    if (visited.has(unit.dependency_key)) {
      return;
    }
    if (!queue.includes(unit)) {
      queue.push(unit);
      queue.sort((a, b) => (a.dependency_key < b.dependency_key ? -1 : 1));
    }
  };

  while (queue.length > 0) {
    const unit = queue.shift();
    if (unit === undefined) {
      break;
    }
    if (visited.has(unit.dependency_key)) {
      continue;
    }
    visited.add(unit.dependency_key);
    closure.push(unit);
    for (const sibling of units) {
      if (
        sibling.inseparable_group_key === unit.inseparable_group_key &&
        !visited.has(sibling.dependency_key)
      ) {
        enqueue(sibling);
      }
    }
    for (const sourceId of unit.source_ids) {
      for (const candidate of sourceIndex.get(sourceId) ?? []) {
        enqueue(candidate);
      }
    }
    if (unit.derived_view_key !== undefined) {
      for (const candidate of viewIndex.get(unit.derived_view_key) ?? []) {
        enqueue(candidate);
      }
    }
  }

  const closureKeys = new Set(closure.map((unit) => unit.dependency_key));
  const missingQuestionKeys: string[] = [];
  for (const questionKey of input.required_question_keys) {
    const covered = closure.some(
      (unit) =>
        unit.omission_impact === "answer_changing" && unit.question_ids.includes(questionKey)
    );
    if (!covered) {
      missingQuestionKeys.push(questionKey);
    }
  }
  if (missingQuestionKeys.length > 0) {
    return evdErr("E_EVIDENCE_CLOSURE_INCOMPLETE", {
      missing_question_keys: sortUtf8Strings(missingQuestionKeys),
    });
  }

  closure.sort((a, b) => {
    const byGroup = a.inseparable_group_key < b.inseparable_group_key ? -1 : a.inseparable_group_key > b.inseparable_group_key ? 1 : 0;
    if (byGroup !== 0) {
      return byGroup;
    }
    if (a.selection_rank !== b.selection_rank) {
      return a.selection_rank - b.selection_rank;
    }
    const aRef = a.source_refs[0] ?? "";
    const bRef = b.source_refs[0] ?? "";
    if (aRef !== bRef) {
      return aRef < bRef ? -1 : 1;
    }
    const aSource = a.source_ids[0] ?? "";
    const bSource = b.source_ids[0] ?? "";
    return aSource < bSource ? -1 : aSource > bSource ? 1 : 0;
  });

  const omissions: Omission[] = [];
  for (const unit of units) {
    if (closureKeys.has(unit.dependency_key)) {
      continue;
    }
    const requiredForIssue = unit.question_ids.some((questionKey) => required.has(questionKey));
    const mapping = omissionImpactFor(unit, requiredForIssue);
    if (unit.omission_impact === "answer_changing" && unit.can_omit) {
      return evdErr("E_EVIDENCE_OMISSION_BINDING", {
        question_keys: sortUtf8Strings(unit.question_ids),
        impact: mapping.impact,
      });
    }
    if (unit.omission_impact === "none" && !unit.can_omit) {
      return evdErr("E_EVIDENCE_OMISSION_BINDING", {
        question_keys: sortUtf8Strings(unit.question_ids),
        impact: mapping.impact,
      });
    }
    if (mapping.impact === "none" && !unit.can_omit) {
      return evdErr("E_EVIDENCE_OMISSION_BINDING", {
        question_keys: sortUtf8Strings(unit.question_ids),
        impact: mapping.impact,
      });
    }
    const reason: OmissionReason = unit.omission_impact === "none" ? "not_required" : "budget_context";
    const key = omissionKey({
      plan_hash: unit.plan_hash,
      unit_keys: [unit.unit_key],
      question_keys: unit.question_ids,
      source_ids: unit.source_ids,
      source_refs: unit.source_refs,
      plan_omission_impact: mapping.plan_omission_impact,
      can_omit: unit.can_omit,
      required_for_issue: requiredForIssue,
      reason,
      impact: mapping.impact,
    });
    omissions.push({
      schema_version: "rsi.evidence_omission/1",
      omission_id: newId("omis"),
      omission_key: key,
      shard_plan_id: newId("splan"),
      plan_hash: unit.plan_hash,
      question_ids: sortUtf8Strings(unit.question_ids),
      question_keys: sortUtf8Strings(unit.question_ids),
      unit_keys: [unit.unit_key] as Hash[],
      source_ids: sortUtf8Strings(unit.source_ids),
      source_refs: sortUtf8Strings(unit.source_refs) as SourceRef[],
      plan_omission_impact: mapping.plan_omission_impact,
      can_omit: unit.can_omit,
      required_for_issue: requiredForIssue,
      reason,
      impact: mapping.impact,
      recoverable: true,
      recorded_by: "evd-closure/1",
      created_at: 0,
    });
  }
  omissions.sort((a, b) => (a.omission_key < b.omission_key ? -1 : 1));

  const perQuestion = [...required, ...optional]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((questionKey) => {
      const questionUnits = closure.filter((unit) => unit.question_ids.includes(questionKey));
      return {
        question_key: questionKey,
        unit_keys: sortUtf8Strings(questionUnits.map((unit) => unit.unit_key)),
        omission_keys: sortUtf8Strings(
          omissions.filter((omission) => omission.question_keys.includes(questionKey)).map((omission) => omission.omission_key)
        ),
      };
    });

  return evdOk({
    schema_version: "rsi.closure_result/1",
    units: closure,
    omissions,
    per_question: perQuestion,
    closure_hash: closureHash({ units: closure, omissions, per_question: perQuestion }),
  });
}
