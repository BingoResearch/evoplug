import { compareUtf8 } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, SourceRef } from "@evoplug/core";
import type { LedgerRequirementOpRow, LedgerRequirementRow, RequirementScope, AcceptanceCriterion } from "../domain/requirements.js";
import type {
  GoalSnapshotStateRow,
  RequirementOpStateRow,
  RequirementSourceStateRow,
  RequirementStateRow,
} from "../rows.js";
import { asofUnavailable, ledgerOk } from "../errors.js";
import { uniqueSortedStrings } from "../util.js";
import { parseJsonValue } from "../util.js";
import { isHash } from "../raw-hash.js";
import { isSourceRef } from "../source-ref.js";

export interface RequirementAsOfScope {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly goal_version: string;
  readonly watermark: number;
}

export interface RequirementAsOfInput {
  readonly binding: RequirementAsOfScope;
  readonly requirements: readonly RequirementStateRow[];
  readonly requirement_ops: readonly RequirementOpStateRow[];
  readonly requirement_sources: readonly RequirementSourceStateRow[];
  readonly goal_snapshots: readonly GoalSnapshotStateRow[];
  /** Source-event watermark keyed by event ID; a missing key is an error. */
  readonly event_watermarks: ReadonlyMap<string, number>;
}

export interface RequirementAsOfProjection {
  readonly requirements: LedgerRequirementRow[];
  readonly requirement_ops: LedgerRequirementOpRow[];
  readonly active_requirement_ids: Id<"req">[];
}

export function isRevisionValidAt(row: {
  readonly valid_from_event: number;
  readonly valid_to_event: number | null;
}, watermark: number): boolean {
  return (
    row.valid_from_event <= watermark &&
    (row.valid_to_event === null || row.valid_to_event > watermark)
  );
}

export function parseRequirementScopeText(text: string): RequirementScope | null {
  const parsed = parseJsonValue(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const paths = parsed["paths"];
  const hosts = parsed["hosts"];
  const modes = parsed["modes"];
  const projectIds = parsed["project_ids"];
  if (!Array.isArray(paths) || !Array.isArray(hosts) || !Array.isArray(modes) || !Array.isArray(projectIds)) {
    return null;
  }
  if (!paths.every((item): item is string => typeof item === "string")) return null;
  if (!hosts.every((item): item is string => typeof item === "string")) return null;
  if (!projectIds.every((item): item is string => typeof item === "string")) return null;
  const parsedModes: Array<"online" | "review" | "trial" | "global"> = [];
  for (const mode of modes) {
    if (mode === "online" || mode === "review" || mode === "trial" || mode === "global") {
      parsedModes.push(mode);
    } else {
      return null;
    }
  }
  return { paths, hosts, modes: parsedModes, project_ids: projectIds };
}

export function parseAcceptanceText(text: string): AcceptanceCriterion[] | null {
  const parsed = parseJsonValue(text);
  if (!Array.isArray(parsed)) return null;
  const out: AcceptanceCriterion[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const kind = item["kind"];
    if (kind === "human_acceptance" && typeof item["source_ref"] === "string") {
      const sourceRef = item["source_ref"];
      if (!isSourceRef(sourceRef)) return null;
      out.push({ kind, source_ref: sourceRef });
    } else if (
      kind === "test_pass" &&
      typeof item["command"] === "string" &&
      typeof item["cwd"] === "string"
    ) {
      out.push({ kind, command: item["command"], cwd: item["cwd"] });
    } else if (kind === "artifact_check" && typeof item["path"] === "string") {
      const expected = item["expected_hash"];
      if (expected === undefined) {
        out.push({ kind, path: item["path"] });
      } else if (typeof expected === "string" && isHash(expected)) {
        out.push({ kind, path: item["path"], expected_hash: expected });
      } else {
        return null;
      }
    } else if (
      kind === "external_verification" &&
      typeof item["verifier"] === "string" &&
      typeof item["evidence_ref"] === "string"
    ) {
      const evidenceRef = item["evidence_ref"];
      if (!isSourceRef(evidenceRef)) return null;
      out.push({
        kind,
        verifier: item["verifier"],
        evidence_ref: evidenceRef,
      });
    } else {
      return null;
    }
  }
  return out;
}

interface OpStatusAsof {
  readonly status: "active" | "proposed" | "rejected";
  readonly goal_version: string;
  readonly source_event_id: Id<"ev">;
}

function asofOpStatus(op: RequirementOpStateRow): OpStatusAsof | null {
  switch (op.status) {
    case "applied":
      return { status: "active", goal_version: op.goal_version_after, source_event_id: op.source_event_id };
    case "proposed":
      return { status: "proposed", goal_version: op.goal_version_after, source_event_id: op.source_event_id };
    case "rejected":
      return { status: "rejected", goal_version: op.goal_version_after, source_event_id: op.source_event_id };
    case "conflict":
      return null;
  }
}

/**
 * As-of requirement projection at `binding.watermark` (DD-FND-074).
 *
 * Every ambiguity is a hard `E_LEDGER_ASOF_UNAVAILABLE`; nothing is guessed
 * from the stored `requirement.status`, from later rows or from wall clock.
 */
export function projectRequirementsAsOf(
  input: RequirementAsOfInput,
): Result<RequirementAsOfProjection, ErrorEnvelope> {
  const watermark = input.binding.watermark;
  const opsById = new Map<string, RequirementOpStateRow>();
  for (const op of input.requirement_ops) {
    opsById.set(op.op_id, op);
  }

  const sourcesByRevision = new Map<string, SourceRef[]>();
  for (const source of input.requirement_sources) {
    if (!isSourceRef(source.source_ref)) return asofUnavailable();
    const key = source.requirement_id + "\u0000" + String(source.requirement_revision);
    const existing = sourcesByRevision.get(key);
    if (existing === undefined) {
      sourcesByRevision.set(key, [source.source_ref]);
    } else {
      existing.push(source.source_ref);
    }
  }

  const validRows = input.requirements.filter((row) => isRevisionValidAt(row, watermark));
  const byRequirement = new Map<string, RequirementStateRow[]>();
  for (const row of validRows) {
    const bucket = byRequirement.get(row.requirement_id);
    if (bucket === undefined) {
      byRequirement.set(row.requirement_id, [row]);
    } else {
      bucket.push(row);
    }
  }

  const requirements: LedgerRequirementRow[] = [];
  for (const rows of byRequirement.values()) {
    if (rows.length !== 1) {
      return asofUnavailable();
    }
    const row = rows[0];
    if (row === undefined) return asofUnavailable();

    const creatingOp = opsById.get(row.created_by_op_id);
    if (creatingOp === undefined) return asofUnavailable();
    const opStatus = asofOpStatus(creatingOp);
    if (opStatus === null) return asofUnavailable();

    if (
      (row.status === "superseded" || row.status === "retracted" || row.status === "rejected") &&
      row.valid_to_event === null
    ) {
      return asofUnavailable();
    }
    if ((row.status === "active" || row.status === "proposed") && row.valid_to_event !== null) {
      return asofUnavailable();
    }
    if (opStatus.status === "rejected" && row.status !== "rejected") {
      return asofUnavailable();
    }

    const recordedAtWatermark = input.event_watermarks.get(creatingOp.source_event_id);
    if (recordedAtWatermark === undefined) return asofUnavailable();

    const scope = parseRequirementScopeText(row.scope_json);
    if (scope === null) return asofUnavailable();
    const acceptance = parseAcceptanceText(row.acceptance_json);
    if (acceptance === null) return asofUnavailable();

    const key = row.requirement_id + "\u0000" + String(row.revision);
    const refs = uniqueSortedStrings([
      row.statement_ref,
      ...(sourcesByRevision.get(key) ?? []),
    ]);
    if (!isSourceRef(row.statement_ref)) return asofUnavailable();

    requirements.push({
      requirement_id: row.requirement_id,
      revision: row.revision,
      statement_ref: row.statement_ref,
      statement_text_hash: row.statement_text_hash,
      scope,
      acceptance,
      status: opStatus.status,
      created_by_op_id: row.created_by_op_id,
      valid_from_event: row.valid_from_event,
      valid_to_event: row.valid_to_event,
      effective_input_epoch: row.effective_input_epoch,
      content_hash: row.content_hash,
      recorded_at: row.recorded_at,
      recorded_at_watermark: recordedAtWatermark,
      goal_version: opStatus.goal_version,
      source_refs: refs,
    });
  }

  requirements.sort((a, b) => {
    const byId = compareUtf8(a.requirement_id, b.requirement_id);
    if (byId !== 0) return byId;
    return a.revision - b.revision;
  });

  const ops: LedgerRequirementOpRow[] = [];
  for (const op of input.requirement_ops) {
    if (op.task_id !== input.binding.task_id || op.branch_id !== input.binding.branch_id) {
      return asofUnavailable();
    }
    if (!isRevisionValidAt(op, watermark)) continue;
    const recordedAtWatermark = input.event_watermarks.get(op.source_event_id);
    if (recordedAtWatermark === undefined) return asofUnavailable();
    if (!isSourceRef(op.source_quote_ref)) return asofUnavailable();
    ops.push({
      op_id: op.op_id,
      status: op.status,
      op: op.op,
      actor_origin: op.actor_origin,
      directive_strength: op.directive_strength,
      target_requirement_id: op.target_requirement_id,
      created_requirement_id: op.created_requirement_id,
      effective_input_epoch: op.effective_input_epoch,
      goal_version_before: op.goal_version_before,
      goal_version_after: op.goal_version_after,
      valid_from_event: op.valid_from_event,
      valid_to_event: op.valid_to_event,
      recorded_at: op.recorded_at,
      recorded_at_watermark: recordedAtWatermark,
      source_quote_ref: op.source_quote_ref,
      content_hash: op.content_hash,
    });
  }
  ops.sort((a, b) => {
    const byEvent = a.valid_from_event - b.valid_from_event;
    if (byEvent !== 0) return byEvent;
    return compareUtf8(a.op_id, b.op_id);
  });

  const snapshot = latestGoalSnapshot(input.goal_snapshots, input.binding);
  if (snapshot === null) return asofUnavailable();
  const activeIdsRaw = parseStringArray(snapshot.active_requirement_ids_json);
  if (activeIdsRaw === null) return asofUnavailable();
  const activeRequirementIds = uniqueSortedStrings(activeIdsRaw) as Id<"req">[];

  const activeFromRows = requirements
    .filter((row) => row.status === "active")
    .map((row) => row.requirement_id);
  const expected = uniqueSortedStrings(activeFromRows);
  if (expected.length !== activeRequirementIds.length) return asofUnavailable();
  if (!expected.every((value, index) => value === activeRequirementIds[index])) {
    return asofUnavailable();
  }

  return ledgerOk({
    requirements,
    requirement_ops: ops,
    active_requirement_ids: activeRequirementIds,
  });
}

function parseStringArray(text: string): string[] | null {
  const parsed = parseJsonValue(text);
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function latestGoalSnapshot(
  snapshots: readonly GoalSnapshotStateRow[],
  binding: RequirementAsOfScope,
): GoalSnapshotStateRow | null {
  const candidates = snapshots.filter(
    (snapshot) =>
      snapshot.task_id === binding.task_id &&
      snapshot.source_branch_id === binding.branch_id &&
      snapshot.local_goal_version === binding.goal_version &&
      snapshot.watermark <= binding.watermark,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.watermark !== b.watermark) return b.watermark - a.watermark;
    if (a.local_goal_revision !== b.local_goal_revision) {
      return b.local_goal_revision - a.local_goal_revision;
    }
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return compareUtf8(b.snapshot_id, a.snapshot_id);
  });
  const latest = candidates[0];
  return latest ?? null;
}
