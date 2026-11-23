import { canonicalJsonText, compareUtf8, newId } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type {
  AcceptanceCriterion,
  RecordRequirementOpsRequest,
  RecordRequirementOpsResult,
  RequirementOpDraft,
  RequirementScope,
  UnverifiedConstraintDraft,
} from "../domain/requirements.js";
import type {
  GoalSnapshotStateRow,
  RequirementHeadStateRow,
  RequirementOpStateRow,
  RequirementStateRow,
} from "../rows.js";
import type { LedgerPorts, LedgerStateRowWrite } from "../ports.js";
import { ledgerFailure, ledgerNoOp, ledgerOk, schemaError, sourceHashError } from "../errors.js";
import { isHash, sha256Bytes, sha256Utf8 } from "../raw-hash.js";
import { isSourceRef } from "../source-ref.js";
import { isNonNegativeSafeInteger, isSortedUniqueStrings, uniqueSortedStrings } from "../util.js";
import {
  buildRequirementOpRecord,
  determineRequirementOpStatus,
  planRequirementGoalTransition,
  validateRequirementOpDraft,
} from "../requirements/ops.js";
import {
  parseAcceptanceText,
  parseRequirementScopeText,
} from "../requirements/asof.js";
import { goalSnapshotHash, requirementContentHash } from "../hashes.js";
import { acceptanceListJson, requirementScopeJson, versionBindingJson } from "../json.js";
import { commitStateRows, stateRowWrite } from "./commit.js";
import { validateVersionBinding } from "../validation.js";

interface CurrentRequirementState {
  readonly head: RequirementHeadStateRow;
  readonly revision: number;
  readonly row: RequirementStateRow;
}

function opSourceError<T>(eventId: Id<"ev">): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_REQUIREMENT_SOURCE",
    category: "source",
    details: {
      kind: "source",
      source_ref: "journal://" + eventId + "#bytes=0-1",
      reason: "missing",
    },
    stage: "ledger_write",
  });
}

function originUnverified<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_EVENT_ORIGIN_UNVERIFIED",
    category: "authorization",
    details: { kind: "none" },
    stage: "event_origin",
  });
}

function requirementSourceRole(
  op: RequirementOpDraft["op"],
): "original" | "clarification" | "confirmation" | null {
  switch (op) {
    case "add":
    case "supersede":
      return "original";
    case "clarify":
      return "clarification";
    case "confirm":
      return "confirmation";
    case "retract":
      return null;
  }
}

function sortedIds<T extends string>(values: readonly T[]): T[] {
  return uniqueSortedStrings(values);
}

/**
 * Requirement write service. One extraction result becomes one atomic
 * `rsi.state_row_batch/1`: op row, requirement revision, source, head, goal
 * snapshot and any unverified constraints.
 *
 * Only `human` + `explicit` + a verified attestation can produce an `applied`
 * op; every other origin (including `user`) produces `proposed`.
 */
export class RequirementService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  /** Single-op compatibility entry; it delegates to `recordRequirementOps`. */
  async applyRequirementOp(
    binding: VersionBinding,
    draft: RequirementOpDraft,
    extractorStatus: "proposed" | "conflict" | "rejected" | null = null,
  ): Promise<Result<RecordRequirementOpsResult, ErrorEnvelope>> {
    const result = await this.recordRequirementOps({
      binding,
      source_event_id: draft.source_event_id,
      results: [{ draft, extractor_status: extractorStatus, conflict_requirement_ids: [] }],
      constraints: [],
    });
    if (!result.ok) return result;
    const cannotApply =
      extractorStatus !== null ||
      draft.actor_origin !== "human" ||
      draft.directive_strength !== "explicit";
    return cannotApply ? ledgerNoOp(result.value) : result;
  }

  async recordRequirementOps(
    request: RecordRequirementOpsRequest,
  ): Promise<Result<RecordRequirementOpsResult, ErrorEnvelope>> {
    const bindingResult = validateVersionBinding(request.binding);
    if (!bindingResult.ok) return bindingResult;

    const event = await this.#ports.events.getEvent(request.source_event_id);
    if (!event.ok) return event;
    if (event.value === null) return opSourceError(request.source_event_id);
    const sourceEvent = event.value;
    if (
      sourceEvent.task_id !== request.binding.task_id ||
      sourceEvent.branch_id !== request.binding.branch_id
    ) {
      return opSourceError(request.source_event_id);
    }
    if (sourceEvent.watermark !== request.binding.watermark) {
      return ledgerFailure<RecordRequirementOpsResult>({
        code: "E_VERSION_BINDING",
        category: "version",
        details: {
          kind: "version",
          expected: String(sourceEvent.watermark),
          actual: String(request.binding.watermark),
        },
        stage: "binding",
      });
    }

    const branch = await this.#ports.identity.getBranch(request.binding.branch_id);
    if (!branch.ok) return branch;
    if (branch.value === null) {
      return ledgerFailure<RecordRequirementOpsResult>({
        code: "E_VERSION_BINDING",
        category: "version",
        details: {
          kind: "version",
          expected: "existing_branch",
          actual: request.binding.branch_id,
        },
        stage: "binding",
      });
    }
    if (branch.value.current_goal_version !== request.binding.goal_version) {
      return ledgerFailure<RecordRequirementOpsResult>({
        code: "E_VERSION_BINDING",
        category: "version",
        details: {
          kind: "version",
          expected: branch.value.current_goal_version,
          actual: request.binding.goal_version,
        },
        stage: "binding",
      });
    }

    const query = {
      task_id: request.binding.task_id,
      branch_id: request.binding.branch_id,
      watermark: request.binding.watermark,
    };
    const [requirementRows, headRows, snapshotRows] = await Promise.all([
      this.#ports.projection.listRequirementRows(query),
      this.#ports.projection.listRequirementHeads(query),
      this.#ports.projection.listGoalSnapshots({
        task_id: request.binding.task_id,
        branch_id: request.binding.branch_id,
        goal_version: branch.value.current_goal_version,
        watermark_max: request.binding.watermark,
      }),
    ]);
    if (!requirementRows.ok) return requirementRows;
    if (!headRows.ok) return headRows;
    if (!snapshotRows.ok) return snapshotRows;

    const heads = new Map<string, RequirementHeadStateRow>();
    for (const head of headRows.value) heads.set(head.requirement_id, head);

    const revisions = new Map<string, RequirementStateRow[]>();
    for (const row of requirementRows.value) {
      const bucket = revisions.get(row.requirement_id);
      if (bucket === undefined) revisions.set(row.requirement_id, [row]);
      else bucket.push(row);
    }
    const current = new Map<string, CurrentRequirementState>();
    for (const [requirementId, rows] of revisions) {
      const head = heads.get(requirementId);
      if (head === undefined) continue;
      const row = rows.find((candidate) => candidate.revision === head.revision);
      if (row === undefined) continue;
      current.set(requirementId, { head, revision: head.revision, row });
    }

    const sameScopeIds = new Set<string>(revisions.keys());
    const sourceOrigin = sourceEvent.origin;
    const sourceStrength = sourceEvent.directive_strength ?? "ambiguous";

    let humanAttested = false;
    if (sourceOrigin === "human") {
      if (sourceEvent.human_attestation === null) return opSourceError(request.source_event_id);
      if (sourceEvent.native_session_id === null) return opSourceError(request.source_event_id);
      const verdict = await this.#ports.proof.verifyHuman({
        attestation: sourceEvent.human_attestation,
        host_id: sourceEvent.host_id,
        config_space: sourceEvent.config_space,
        native_session_id: sourceEvent.native_session_id,
        event_key: sourceEvent.event_key,
      });
      humanAttested = verdict === "verified";
    }

    const writes: LedgerStateRowWrite[] = [];
    const opIds: Id<"reqop">[] = [];
    const affectedRequirementIds: Id<"req">[] = [];
    let activeIds = this.#previousActiveIds(snapshotRows.value);
    let goalRevision = branch.value.current_goal_revision;
    let currentGoalVersion = branch.value.current_goal_version;
    const recordedAt = this.#ports.clock.now();
    const watermark = sourceEvent.watermark;

    for (const result of request.results) {
      const draft = result.draft;
      const validated = validateRequirementOpDraft(draft, {
        task_id: request.binding.task_id,
        branch_id: request.binding.branch_id,
        source_origin: sourceOrigin,
        source_directive_strength: sourceStrength,
        same_scope_requirement_ids: sameScopeIds,
      });
      if (!validated.ok) return validated;

      const status = determineRequirementOpStatus({
        extractor_status: result.extractor_status,
        actor_origin: draft.actor_origin,
        directive_strength: draft.directive_strength,
        human_attested: humanAttested,
      });
      if (status === "applied" && !humanAttested) {
        return originUnverified();
      }

      const target =
        draft.target_requirement_id === null
          ? null
          : current.get(draft.target_requirement_id) ?? null;

      let statementRef: SourceRef | null = null;
      let statementTextHash: Hash = sha256Utf8(draft.statement_text);
      if (draft.op === "add" || draft.op === "clarify" || draft.op === "supersede") {
        const stored = await this.#ports.blobs.putText(draft.statement_text);
        if (!stored.ok) return stored;
        statementRef = stored.value.source_ref;
        statementTextHash = stored.value.content_hash;
        // Re-read the frozen statement through the source port: the row must
        // point at retrievable bytes whose hash equals `source_text_hash`.
        const resolved = await this.#ports.sources.resolve(statementRef);
        if (!resolved.ok) return resolved;
        const bytes = resolved.value.bytes;
        if (
          !resolved.value.retrievable ||
          bytes === null ||
          bytes.byteLength !== resolved.value.length ||
          sha256Bytes(bytes) !== statementTextHash
        ) {
          return sourceHashError<RecordRequirementOpsResult>(statementRef);
        }
      }

      const newScope = draft.scope;
      const newAcceptance = draft.acceptance;
      const newScopeJson = canonicalJsonText(requirementScopeJson(draft.scope));
      const newAcceptanceJson = canonicalJsonText(acceptanceListJson(draft.acceptance));
      // The DDL fixes retract/confirm op rows to the canonical empty scope
      // (`scope_json = '{}'`, `acceptance_json = '[]'`); an empty
      // `RequirementScope` object is not the same JSON and would fail the
      // CHECK. Content-bearing ops keep the four-array form.
      const opCarriesContent =
        draft.op === "add" || draft.op === "clarify" || draft.op === "supersede";
      const opScopeJson = opCarriesContent ? newScopeJson : "{}";
      const opAcceptanceJson = opCarriesContent ? newAcceptanceJson : "[]";
      const contentChanged =
        target !== null &&
        (target.row.statement_text_hash !== statementTextHash ||
          target.row.scope_json !== newScopeJson ||
          target.row.acceptance_json !== newAcceptanceJson);

      const transition = planRequirementGoalTransition({
        op: draft.op,
        status,
        binding: {
          ...request.binding,
          goal_version: currentGoalVersion,
        },
        current_goal_revision: goalRevision,
        target_requirement_revision: target === null ? null : target.revision,
        target_requirement_status: target === null ? null : target.row.status,
        content_changed: contentChanged,
      });

      const opId = newId("reqop");
      opIds.push(opId);

      const createsNew = draft.op === "add" || draft.op === "supersede";
      let requirementId: Id<"req"> | null = null;
      if (createsNew) {
        requirementId = newId("req");
      } else if (draft.target_requirement_id !== null) {
        requirementId = draft.target_requirement_id;
      }

      const createdRequirementId =
        createsNew && status !== "conflict" && status !== "rejected"
          ? requirementId
          : null;
      const record = buildRequirementOpRecord({
        draft,
        op_id: opId,
        status,
        statement_ref: statementRef,
        created_requirement_id: createdRequirementId,
        effective_input_epoch: request.binding.input_epoch,
        goal_version_before: transition.goal_version_before,
        goal_version_after: transition.goal_version_after,
        recorded_at: recordedAt,
      });

      const opRow: RequirementOpStateRow = {
        op_id: record.op_id,
        task_id: record.task_id,
        branch_id: record.branch_id,
        source_event_id: record.source_event_id,
        actor_origin: record.actor_origin,
        directive_strength: record.directive_strength,
        op: record.op,
        target_requirement_id: record.target_requirement_id,
        created_requirement_id: record.created_requirement_id,
        superseded_requirement_ids_json: canonicalJsonText(record.superseded_requirement_ids),
        statement_ref: record.statement_ref,
        scope_json: opScopeJson,
        acceptance_json: opAcceptanceJson,
        source_quote_ref: record.source_quote_ref,
        source_text_hash: record.source_text_hash,
        status: record.status,
        recorded_at: record.recorded_at,
        valid_from_event: watermark,
        valid_to_event: null,
        effective_input_epoch: record.effective_input_epoch,
        goal_version_before: record.goal_version_before,
        goal_version_after: record.goal_version_after,
        content_hash: record.content_hash,
      };
      writes.push(stateRowWrite("rsi.requirement_op_row/1", "insert", { ...opRow }));

      const writesRevision =
        draft.op === "add" ||
        (draft.op === "supersede" && status === "applied") ||
        (draft.op === "retract" && status === "applied") ||
        (draft.op === "clarify" && status === "applied" && contentChanged) ||
        (draft.op === "confirm" && transition.activates_requirement);

      const appendsSourceToCurrentRevision =
        status === "applied" &&
        ((draft.op === "clarify" && !contentChanged) ||
          (draft.op === "confirm" && !transition.activates_requirement));

      if (
        requirementId !== null &&
        status !== "conflict" &&
        status !== "rejected" &&
        writesRevision
      ) {
        const revisionResult = this.#buildRequirementRevision({
          draft,
          status,
          target,
          requirementId,
          opId,
          statementRef,
          statementTextHash,
          newScope,
          newAcceptance,
          newScopeJson,
          newAcceptanceJson,
          watermark,
          recordedAt,
          effectiveInputEpoch: request.binding.input_epoch,
          taskId: request.binding.task_id,
          branchId: request.binding.branch_id,
          activates: transition.activates_requirement,
        });
        if (!revisionResult.ok) return revisionResult;
        const requirementRow = revisionResult.value;
        if (requirementRow === null) {
          return schemaError<RecordRequirementOpsResult>("requirement_revision", "buildable");
        }

        writes.push(stateRowWrite("rsi.requirement_row/1", "insert", { ...requirementRow }));
        affectedRequirementIds.push(requirementRow.requirement_id);

        const role = requirementSourceRole(draft.op);
        if (role !== null) {
          writes.push(
            stateRowWrite("rsi.requirement_source_row/1", "insert", {
              requirement_id: requirementRow.requirement_id,
              requirement_revision: requirementRow.revision,
              source_event_id: draft.source_event_id,
              source_ref: requirementRow.statement_ref,
              quote_hash: draft.source_text_hash,
              role,
            }),
          );
        }

        const previousHead = heads.get(requirementRow.requirement_id);
        const headRow: RequirementHeadStateRow = {
          requirement_id: requirementRow.requirement_id,
          revision: requirementRow.revision,
          status: requirementRow.status,
          current_goal_version: transition.goal_version_after,
          updated_at: recordedAt,
          row_version: previousHead === undefined ? 1 : previousHead.row_version + 1,
        };
        writes.push(
          stateRowWrite(
            "rsi.requirement_head_row/1",
            previousHead === undefined ? "insert" : "transition",
            { ...headRow },
          ),
        );

        activeIds = this.#applyActiveSet(
          activeIds,
          draft.op,
          requirementRow.requirement_id,
          requirementRow.status,
          draft.superseded_requirement_ids,
          transition.activates_requirement,
        );
        sameScopeIds.add(requirementRow.requirement_id);
      } else if (target !== null && appendsSourceToCurrentRevision) {
        // Source-only clarification or confirmation of an active requirement:
        // append the source row to the current revision without creating a new
        // revision or changing the goal version.
        const role = requirementSourceRole(draft.op);
        if (role !== null) {
          writes.push(
            stateRowWrite("rsi.requirement_source_row/1", "insert", {
              requirement_id: target.row.requirement_id,
              requirement_revision: target.row.revision,
              source_event_id: draft.source_event_id,
              source_ref: target.row.statement_ref,
              quote_hash: draft.source_text_hash,
              role,
            }),
          );
        }
      }

      if (transition.goal_version_after !== transition.goal_version_before) {
        writes.push(
          stateRowWrite("rsi.goal_snapshot_row/1", "insert", {
            ...this.#buildGoalSnapshot({
              taskId: request.binding.task_id,
              branchId: request.binding.branch_id,
              sourceGoalVersion: transition.goal_version_before,
              localGoalVersion: transition.goal_version_after,
              localGoalRevision: transition.next_goal_revision,
              watermark,
              activeIds,
              createdAt: recordedAt,
            }),
          }),
        );
        goalRevision = transition.next_goal_revision;
        currentGoalVersion = transition.goal_version_after;
      }
    }

    for (const constraint of request.constraints) {
      const constraintWrite = this.#buildConstraint({
        constraint,
        binding: request.binding,
        sourceEventId: request.source_event_id,
        sourceEventWatermark: watermark,
        recordedAt,
      });
      if (!constraintWrite.ok) return constraintWrite;
      writes.push(constraintWrite.value);
    }

    if (writes.length === 0) {
      return ledgerOk({ op_ids: opIds, requirement_ids: [] });
    }

    const commit = await commitStateRows(this.#ports, request.binding, writes);
    if (!commit.ok) return commit;
    return ledgerOk({
      op_ids: opIds,
      requirement_ids: sortedIds(affectedRequirementIds),
    });
  }

  #previousActiveIds(snapshots: readonly GoalSnapshotStateRow[]): Id<"req">[] {
    if (snapshots.length === 0) return [];
    const sorted = [...snapshots].sort((a, b) => {
      if (a.watermark !== b.watermark) return b.watermark - a.watermark;
      if (a.local_goal_revision !== b.local_goal_revision) {
        return b.local_goal_revision - a.local_goal_revision;
      }
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return compareUtf8(b.snapshot_id, a.snapshot_id);
    });
    const latest = sorted[0];
    if (latest === undefined) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(latest.active_requirement_ids_json);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return sortedIds(parsed.filter((item): item is string => typeof item === "string")) as Id<"req">[];
  }

  #applyActiveSet(
    active: readonly Id<"req">[],
    op: RequirementOpDraft["op"],
    requirementId: Id<"req">,
    status: RequirementStateRow["status"],
    superseded: readonly Id<"req">[],
    activates: boolean,
  ): Id<"req">[] {
    const set = new Set<string>(active);
    switch (op) {
      case "add": {
        if (status === "active") set.add(requirementId);
        break;
      }
      case "supersede": {
        if (status === "active") {
          for (const id of superseded) set.delete(id);
          set.add(requirementId);
        }
        break;
      }
      case "clarify": {
        if (status === "active") set.add(requirementId);
        break;
      }
      case "retract": {
        if (status === "retracted") {
          set.delete(requirementId);
          for (const id of superseded) set.delete(id);
        }
        break;
      }
      case "confirm": {
        if (activates) set.add(requirementId);
        break;
      }
    }
    return sortedIds([...set]) as Id<"req">[];
  }

  #buildRequirementRevision(input: {
    readonly draft: RequirementOpDraft;
    readonly status: "applied" | "proposed" | "conflict" | "rejected";
    readonly target: CurrentRequirementState | null;
    readonly requirementId: Id<"req">;
    readonly opId: Id<"reqop">;
    readonly statementRef: SourceRef | null;
    readonly statementTextHash: Hash;
    readonly newScope: RequirementScope;
    readonly newAcceptance: readonly AcceptanceCriterion[];
    readonly newScopeJson: string;
    readonly newAcceptanceJson: string;
    readonly watermark: number;
    readonly recordedAt: number;
    readonly effectiveInputEpoch: number;
    readonly taskId: Id<"task">;
    readonly branchId: Id<"br">;
    readonly activates: boolean;
  }): Result<RequirementStateRow | null, ErrorEnvelope> {
    const isNewRequirement = input.draft.op === "add" || input.draft.op === "supersede";
    const targetRow = input.target?.row ?? null;

    let revision = 1;
    let statementRef: SourceRef;
    let statementTextHash: Hash;
    let scope: RequirementScope;
    let acceptance: readonly AcceptanceCriterion[];
    let scopeJson: string;
    let acceptanceJson: string;
    let status: RequirementStateRow["status"];
    let validTo: number | null = null;

    if (isNewRequirement) {
      if (input.statementRef === null) return ledgerOk(null);
      revision = 1;
      statementRef = input.statementRef;
      statementTextHash = input.statementTextHash;
      scope = input.newScope;
      acceptance = input.newAcceptance;
      scopeJson = input.newScopeJson;
      acceptanceJson = input.newAcceptanceJson;
      status = input.status === "applied" ? "active" : "proposed";
    } else {
      if (targetRow === null) return ledgerOk(null);
      revision = targetRow.revision + 1;
      statementRef = input.statementRef ?? targetRow.statement_ref;
      statementTextHash =
        input.statementRef === null ? targetRow.statement_text_hash : input.statementTextHash;

      if (input.draft.op === "retract" || input.draft.op === "confirm") {
        const parsedScope = parseRequirementScopeText(targetRow.scope_json);
        const parsedAcceptance = parseAcceptanceText(targetRow.acceptance_json);
        if (parsedScope === null || parsedAcceptance === null) return ledgerOk(null);
        scope = parsedScope;
        acceptance = parsedAcceptance;
        scopeJson = targetRow.scope_json;
        acceptanceJson = targetRow.acceptance_json;
      } else {
        scope = input.newScope;
        acceptance = input.newAcceptance;
        scopeJson = input.newScopeJson;
        acceptanceJson = input.newAcceptanceJson;
      }

      if (input.draft.op === "retract") {
        status = "retracted";
        validTo = input.watermark;
      } else if (input.draft.op === "confirm") {
        status = input.activates ? "active" : targetRow.status;
      } else {
        // clarify preserves the target's activation state; a proposed
        // requirement only becomes active through an explicit human confirm.
        status = targetRow.status === "active" ? "active" : "proposed";
      }
    }

    const contentHash = requirementContentHash({
      task_id: input.taskId,
      branch_id: input.branchId,
      requirement_id: input.requirementId,
      revision,
      statement_ref: statementRef,
      statement_text_hash: statementTextHash,
      scope,
      acceptance,
      status,
      created_by_op_id: input.opId,
      valid_from_event: input.watermark,
      effective_input_epoch: input.effectiveInputEpoch,
      superseded_by_requirement_id: null,
    });

    return ledgerOk({
      requirement_id: input.requirementId,
      revision,
      task_id: input.taskId,
      branch_id: input.branchId,
      statement_ref: statementRef,
      statement_text_hash: statementTextHash,
      scope_json: scopeJson,
      acceptance_json: acceptanceJson,
      status,
      created_by_op_id: input.opId,
      superseded_by_requirement_id: null,
      valid_from_event: input.watermark,
      valid_to_event: validTo,
      effective_input_epoch: input.effectiveInputEpoch,
      content_hash: contentHash,
      recorded_at: input.recordedAt,
    });
  }

  #buildGoalSnapshot(input: {
    readonly taskId: Id<"task">;
    readonly branchId: Id<"br">;
    readonly sourceGoalVersion: string;
    readonly localGoalVersion: string;
    readonly localGoalRevision: number;
    readonly watermark: number;
    readonly activeIds: readonly Id<"req">[];
    readonly createdAt: number;
  }): GoalSnapshotStateRow {
    const snapshotHash = goalSnapshotHash({
      task_id: input.taskId,
      source_branch_id: input.branchId,
      source_goal_version: input.sourceGoalVersion,
      local_goal_version: input.localGoalVersion,
      local_goal_revision: input.localGoalRevision,
      watermark: input.watermark,
      active_requirement_ids: input.activeIds,
    });
    return {
      snapshot_id: newId("gsnap"),
      task_id: input.taskId,
      source_branch_id: input.branchId,
      source_goal_version: input.sourceGoalVersion,
      local_goal_version: input.localGoalVersion,
      local_goal_revision: input.localGoalRevision,
      watermark: input.watermark,
      active_requirement_ids_json: canonicalJsonText([...input.activeIds]),
      snapshot_hash: snapshotHash,
      created_at: input.createdAt,
    };
  }

  #buildConstraint(input: {
    readonly constraint: UnverifiedConstraintDraft;
    readonly binding: VersionBinding;
    readonly sourceEventId: Id<"ev">;
    readonly sourceEventWatermark: number;
    readonly recordedAt: number;
  }): Result<LedgerStateRowWrite, ErrorEnvelope> {
    const constraint = input.constraint;
    if (!isSourceRef(constraint.source_ref)) {
      return schemaError<LedgerStateRowWrite>("constraint.source_ref", "source_ref_format");
    }
    if (!isHash(constraint.quote_hash)) {
      return schemaError<LedgerStateRowWrite>("constraint.quote_hash", "sha256_lower_hex");
    }
    if (!isSortedUniqueStrings(constraint.conflict_with_requirement_ids)) {
      return schemaError<LedgerStateRowWrite>(
        "constraint.conflict_with_requirement_ids",
        "sorted_unique_utf8",
      );
    }
    if (!isNonNegativeSafeInteger(input.sourceEventWatermark)) {
      return schemaError<LedgerStateRowWrite>("recorded_at_watermark", "non_negative_safe_integer");
    }
    const usableFor = uniqueSortedStrings(constraint.usable_for);
    return ledgerOk(
      stateRowWrite("rsi.unverified_constraint_row/1", "insert", {
        constraint_id: newId("uc"),
        task_id: input.binding.task_id,
        branch_id: input.binding.branch_id,
        binding_json: canonicalJsonText(versionBindingJson(input.binding)),
        source_event_id: input.sourceEventId,
        source_ref: constraint.source_ref,
        quote: constraint.quote,
        quote_hash: constraint.quote_hash,
        scope_hint_json:
          constraint.scope_hint === null
            ? null
            : canonicalJsonText(requirementScopeJson(constraint.scope_hint)),
        status: "unverified_constraint",
        authorization: 0,
        usable_for_json: canonicalJsonText(usableFor),
        conflict_with_requirement_ids_json: canonicalJsonText(
          constraint.conflict_with_requirement_ids,
        ),
        confirmed_by_event_id: null,
        recorded_at_watermark: input.sourceEventWatermark,
        created_at: input.recordedAt,
        row_version: 1,
      }),
    );
  }
}
