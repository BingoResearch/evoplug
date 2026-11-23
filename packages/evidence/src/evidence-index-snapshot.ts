/**
 * Frozen `EvidenceIndexSnapshot` implementation (DD-EVD-003a-5).
 *
 * The snapshot owns a private byte map and exposes only synchronous,
 * side-effect-free filtering. All DTOs are recursively frozen; the byte map is
 * never exposed and every `readExcerpt` call returns a fresh copy.
 */

import type { Hash, JsonValue, SourceRef, VersionBinding } from "@evoplug/core";
import { compareUtf8 } from "@evoplug/core";

import { assertBindingScope, evidenceIndexPortError } from "./evidence-index-port.js";
import { MAX_EXCERPT_BYTES, type ComparisonView, type CoverageSnapshotView, type CoverageView, type EvidenceFactView, type EvidenceIndexPort, type EvidenceIndexSnapshot, type ExcerptReadResult, type ExcerptWindow, type ExperienceCandidateView, type FeedbackView, type HardFactReadView, type ProgressSignalView, type RequirementOpView, type RequirementView, type TaskConditionView, type UnverifiedConstraintView } from "./types.js";
import { jcsHash, sortUtf8Strings, textHash } from "./hashing.js";

export interface FrozenSourceRecord {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly content_hash: Hash;
  readonly text_hash: Hash;
  readonly content_version: Hash;
}

export interface EvidenceIndexSnapshotData {
  binding: VersionBinding;
  watermark: number;
  progress_from_watermark: number;
  ledger_view_hash: Hash;
  constraints_view_hash: Hash;
  source_set_hash: Hash;
  review_snapshot_id: string | null;
  review_snapshot_hash: Hash | null;
  requirements: RequirementView[];
  requirement_ops: RequirementOpView[];
  feedback: FeedbackView[];
  unverified_constraints: UnverifiedConstraintView[];
  facts: EvidenceFactView[];
  progress_signals: ProgressSignalView[];
  experience_candidates: ExperienceCandidateView[];
  task_conditions: TaskConditionView[];
  comparisons: ComparisonView[];
  coverage_views: CoverageView[];
  hard_facts: HardFactReadView[];
  coverage_snapshot: CoverageSnapshotView;
  sources: ReadonlyMap<SourceRef, FrozenSourceRecord>;
}

const SNAPSHOT_BRAND = new WeakSet<object>();

export function isEvidenceIndexSnapshot(value: unknown): value is EvidenceIndexSnapshot {
  return typeof value === "object" && value !== null && SNAPSHOT_BRAND.has(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  return compareUtf8(a, b);
}

/* ------------------------------------------------------------------ */
/* Snapshot row projections (DD-EVD-003a-5)                            */
/* ------------------------------------------------------------------ */

function rowToJson(row: object): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(row)) as Record<string, JsonValue>;
}

function omitKeys(row: object, keys: readonly string[]): Record<string, JsonValue> {
  const source = rowToJson(row);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(source)) {
    if (!keys.includes(key)) {
      result[key] = source[key] ?? null;
    }
  }
  return result;
}

function registryRow(row: object): JsonValue {
  return rowToJson(row);
}

function requirementProjection(rows: readonly RequirementView[]): JsonValue[] {
  return [...rows]
    .sort((a, b) => {
      const byId = compareUtf8(a.requirement_id, b.requirement_id);
      return byId !== 0 ? byId : a.revision - b.revision;
    })
    .map((row) => registryRow(row));
}

function requirementOpProjection(rows: readonly RequirementOpView[]): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["op_id"]))
    .sort((a, b) => {
      const byTarget = compareNullable(
        (a["target_requirement_id"] as string | null) ?? null,
        (b["target_requirement_id"] as string | null) ?? null
      );
      if (byTarget !== 0) {
        return byTarget;
      }
      const byEpoch = Number(a["effective_input_epoch"]) - Number(b["effective_input_epoch"]);
      if (byEpoch !== 0) {
        return byEpoch;
      }
      const byEvent = Number(a["valid_from_event"]) - Number(b["valid_from_event"]);
      if (byEvent !== 0) {
        return byEvent;
      }
      const byGoal = compareUtf8(String(a["goal_version_before"]), String(b["goal_version_before"]));
      if (byGoal !== 0) {
        return byGoal;
      }
      const byOp = compareUtf8(String(a["op"]), String(b["op"]));
      if (byOp !== 0) {
        return byOp;
      }
      const byHash = compareUtf8(String(a["content_hash"]), String(b["content_hash"]));
      if (byHash !== 0) {
        return byHash;
      }
      return compareUtf8(JSON.stringify(a), JSON.stringify(b));
    });
}

function feedbackProjection(rows: readonly FeedbackView[]): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["feedback_id"]))
    .sort((a, b) => {
      const byTarget = compareNullable(
        (a["target_issue_id"] as string | null) ?? null,
        (b["target_issue_id"] as string | null) ?? null
      );
      if (byTarget !== 0) {
        return byTarget;
      }
      const byOrigin = compareUtf8(String(a["origin"]), String(b["origin"]));
      if (byOrigin !== 0) {
        return byOrigin;
      }
      const byKind = compareUtf8(String(a["signal_kind"]), String(b["signal_kind"]));
      if (byKind !== 0) {
        return byKind;
      }
      const byGoal = compareUtf8(String(a["goal_version"]), String(b["goal_version"]));
      if (byGoal !== 0) {
        return byGoal;
      }
      const byEpoch = Number(a["input_epoch"]) - Number(b["input_epoch"]);
      if (byEpoch !== 0) {
        return byEpoch;
      }
      const byWater = Number(a["recorded_at_watermark"]) - Number(b["recorded_at_watermark"]);
      if (byWater !== 0) {
        return byWater;
      }
      const byRefs = compareUtf8(
        JSON.stringify(sortUtf8Strings((a["source_refs"] as SourceRef[]) ?? [])),
        JSON.stringify(sortUtf8Strings((b["source_refs"] as SourceRef[]) ?? []))
      );
      if (byRefs !== 0) {
        return byRefs;
      }
      return compareUtf8(JSON.stringify(a), JSON.stringify(b));
    });
}

function unverifiedConstraintProjection(rows: readonly UnverifiedConstraintView[]): JsonValue[] {
  return [...rows]
    .sort((a, b) => {
      const byTime = a.created_at - b.created_at;
      return byTime !== 0 ? byTime : compareUtf8(a.constraint_id, b.constraint_id);
    })
    .map((row) => registryRow(row));
}

function factProjection(rows: readonly EvidenceFactView[]): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["fact_id"]))
    .sort((a, b) => {
      const byReq = compareNullable(a["requirement_id"] as string | null, b["requirement_id"] as string | null);
      if (byReq !== 0) {
        return byReq;
      }
      const byProp = compareNullable(
        a["proposition_id"] as string | null,
        b["proposition_id"] as string | null
      );
      if (byProp !== 0) {
        return byProp;
      }
      const byKind = compareUtf8(String(a["kind"]), String(b["kind"]));
      if (byKind !== 0) {
        return byKind;
      }
      const byStatus = compareUtf8(String(a["status"]), String(b["status"]));
      if (byStatus !== 0) {
        return byStatus;
      }
      const byEffect = compareUtf8(String(a["effect"]), String(b["effect"]));
      if (byEffect !== 0) {
        return byEffect;
      }
      const byArtifact = compareNullable(
        (a["artifact_version"] as string | null) ?? null,
        (b["artifact_version"] as string | null) ?? null
      );
      if (byArtifact !== 0) {
        return byArtifact;
      }
      const byWater =
        Number(a["recorded_at_watermark"]) - Number(b["recorded_at_watermark"]);
      if (byWater !== 0) {
        return byWater;
      }
      const byRefs = compareUtf8(
        JSON.stringify(sortUtf8Strings((a["source_refs"] as SourceRef[]) ?? [])),
        JSON.stringify(sortUtf8Strings((b["source_refs"] as SourceRef[]) ?? []))
      );
      if (byRefs !== 0) {
        return byRefs;
      }
      return compareUtf8(JSON.stringify(a), JSON.stringify(b));
    });
}

function progressSignalProjection(rows: readonly ProgressSignalView[]): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["signal_id", "baseline_checkpoint_id", "previous_comparable_checkpoint_id"]))
    .sort((a, b) => {
      const byFrom = Number(a["from_watermark"]) - Number(b["from_watermark"]);
      if (byFrom !== 0) {
        return byFrom;
      }
      const byTo = Number(a["to_watermark"]) - Number(b["to_watermark"]);
      if (byTo !== 0) {
        return byTo;
      }
      const byKind = compareUtf8(String(a["signal_kind"]), String(b["signal_kind"]));
      if (byKind !== 0) {
        return byKind;
      }
      const byStatus = compareUtf8(String(a["status"]), String(b["status"]));
      if (byStatus !== 0) {
        return byStatus;
      }
      const byRefs = compareUtf8(
        JSON.stringify(sortUtf8Strings((a["source_refs"] as SourceRef[]) ?? [])),
        JSON.stringify(sortUtf8Strings((b["source_refs"] as SourceRef[]) ?? []))
      );
      if (byRefs !== 0) {
        return byRefs;
      }
      return compareUtf8(JSON.stringify(a), JSON.stringify(b));
    });
}

function experienceCandidateProjection(
  rows: readonly ExperienceCandidateView[]
): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["candidate_id"]))
    .sort((a, b) => {
      const byExperience = compareUtf8(String(a["experience_id"]), String(b["experience_id"]));
      if (byExperience !== 0) {
        return byExperience;
      }
      const byVersion = Number(a["version"]) - Number(b["version"]);
      if (byVersion !== 0) {
        return byVersion;
      }
      const byHash = compareUtf8(String(a["content_hash"]), String(b["content_hash"]));
      if (byHash !== 0) {
        return byHash;
      }
      const byType = compareUtf8(String(a["type"]), String(b["type"]));
      if (byType !== 0) {
        return byType;
      }
      const byTitle = compareUtf8(String(a["title"]), String(b["title"]));
      if (byTitle !== 0) {
        return byTitle;
      }
      return compareUtf8(JSON.stringify(a), JSON.stringify(b));
    });
}

function taskConditionProjection(rows: readonly TaskConditionView[]): JsonValue[] {
  return [...rows]
    .sort((a, b) => compareUtf8(a.logical_id, b.logical_id))
    .map((row) => registryRow(row));
}

function comparisonProjection(rows: readonly ComparisonView[]): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["baseline_source_ids", "current_source_ids"]))
    .sort((a, b) => compareUtf8(String(a["view_key"]), String(b["view_key"])));
}

function coverageViewProjection(rows: readonly CoverageView[]): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["view_key", "searched_sources"]))
    .sort((a, b) => compareUtf8(JSON.stringify(a), JSON.stringify(b)));
}

function hardFactProjection(rows: readonly HardFactReadView[]): JsonValue[] {
  return [...rows]
    .map((row) => omitKeys(row, ["fact_id"]))
    .sort((a, b) => compareUtf8(String(a["fact_key"]), String(b["fact_key"])));
}

function coverageSnapshotProjection(view: CoverageSnapshotView): JsonValue {
  return omitKeys(view, ["snapshot_id", "searched_sources"]);
}

export function snapshotRowsProjection(data: EvidenceIndexSnapshotData): JsonValue {
  return {
    requirements: requirementProjection(data.requirements),
    requirement_ops: requirementOpProjection(data.requirement_ops),
    feedback: feedbackProjection(data.feedback),
    unverified_constraints: unverifiedConstraintProjection(data.unverified_constraints),
    facts: factProjection(data.facts),
    progress_signals: progressSignalProjection(data.progress_signals),
    experience_candidates: experienceCandidateProjection(data.experience_candidates),
    task_conditions: taskConditionProjection(data.task_conditions),
    comparisons: comparisonProjection(data.comparisons),
    coverage_views: coverageViewProjection(data.coverage_views),
    hard_facts: hardFactProjection(data.hard_facts),
    coverage_snapshot: coverageSnapshotProjection(data.coverage_snapshot),
  };
}

export function computeSnapshotHash(data: EvidenceIndexSnapshotData): Hash {
  return jcsHash({
    schema_version: "rsi.evidence_index_snapshot/1",
    binding: data.binding,
    watermark: data.watermark,
    progress_from_watermark: data.progress_from_watermark,
    ledger_view_hash: data.ledger_view_hash,
    constraints_view_hash: data.constraints_view_hash,
    review_snapshot_id: data.review_snapshot_id,
    review_snapshot_hash: data.review_snapshot_hash,
    source_set_hash: data.source_set_hash,
    rows: snapshotRowsProjection(data),
  });
}

/* ------------------------------------------------------------------ */
/* Excerpt windows                                                     */
/* ------------------------------------------------------------------ */

function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isSafePositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function byteBoundaries(text: string): Map<number, number> {
  const encoder = new TextEncoder();
  const boundaries = new Map<number, number>();
  boundaries.set(0, 0);
  let byte = 0;
  let charIndex = 0;
  for (const char of text) {
    byte += encoder.encode(char).length;
    charIndex += char.length;
    boundaries.set(charIndex, byte);
  }
  return boundaries;
}

function byteForChar(boundaries: ReadonlyMap<number, number>, charIndex: number): number {
  return boundaries.get(charIndex) ?? boundaries.get(0) ?? 0;
}

function charIndexForByte(boundaries: ReadonlyMap<number, number>, byteOffset: number): number {
  let result = 0;
  for (const [charIndex, byte] of boundaries) {
    if (byte >= byteOffset) {
      return charIndex;
    }
    result = charIndex;
  }
  return result;
}

function sentenceRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    let boundary = false;
    if (char === "\n") {
      boundary = true;
    } else if (char === "." || char === "!" || char === "?") {
      const next = text.charAt(index + 1);
      boundary = next === "" || /\s/.test(next);
    }
    if (boundary) {
      ranges.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < text.length) {
    ranges.push({ start, end: text.length });
  }
  if (ranges.length === 0) {
    ranges.push({ start: 0, end: text.length });
  }
  return ranges;
}

function lineRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === "\n") {
      ranges.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  ranges.push({ start, end: text.length });
  return ranges;
}

function selectByteRange(
  record: FrozenSourceRecord,
  window: ExcerptWindow
): { start: number; end: number } | { code: "E_SOURCE_REF_INVALID" | "E_SOURCE_OUT_OF_RANGE" } {
  const byteLength = record.bytes.length;
  if (window.kind === "exact") {
    return { start: 0, end: byteLength };
  }
  if (window.kind === "sentence") {
    if (!isSafePositiveInt(window.max_sentences)) {
      return { code: "E_SOURCE_REF_INVALID" };
    }
    const boundaries = byteBoundaries(record.text);
    const ranges = sentenceRanges(record.text);
    const selected = ranges.slice(0, window.max_sentences);
    const last = selected[selected.length - 1];
    const first = selected[0];
    if (last === undefined || first === undefined) {
      return { start: 0, end: byteLength };
    }
    return {
      start: byteForChar(boundaries, first.start),
      end: byteForChar(boundaries, last.end),
    };
  }
  if (window.kind === "line") {
    if (!isSafePositiveInt(window.max_lines)) {
      return { code: "E_SOURCE_REF_INVALID" };
    }
    const boundaries = byteBoundaries(record.text);
    const ranges = lineRanges(record.text);
    const selected = ranges.slice(0, window.max_lines);
    const last = selected[selected.length - 1];
    const first = selected[0];
    if (last === undefined || first === undefined) {
      return { start: 0, end: byteLength };
    }
    return {
      start: byteForChar(boundaries, first.start),
      end: byteForChar(boundaries, last.end),
    };
  }
  if (!Number.isSafeInteger(window.utf8_offset) || window.utf8_offset < 0) {
    return { code: "E_SOURCE_REF_INVALID" };
  }
  if (!isSafePositiveInt(window.max_sentences)) {
    return { code: "E_SOURCE_REF_INVALID" };
  }
  if (window.utf8_offset > byteLength) {
    return { code: "E_SOURCE_OUT_OF_RANGE" };
  }
  const boundaries = byteBoundaries(record.text);
  const charIndex = charIndexForByte(boundaries, window.utf8_offset);
  const ranges = sentenceRanges(record.text);
  const containing = ranges.findIndex(
    (range) => charIndex >= range.start && charIndex < range.end
  );
  const startIndex = containing < 0 ? ranges.length - 1 : containing;
  const selected = ranges.slice(startIndex, startIndex + window.max_sentences);
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (first === undefined || last === undefined) {
    return { start: 0, end: byteLength };
  }
  return {
    start: byteForChar(boundaries, first.start),
    end: byteForChar(boundaries, last.end),
  };
}

/* ------------------------------------------------------------------ */
/* Snapshot construction                                               */
/* ------------------------------------------------------------------ */

export function createEvidenceIndexSnapshot(
  data: EvidenceIndexSnapshotData
): EvidenceIndexSnapshot {
  for (const rows of [
    data.requirements,
    data.requirement_ops,
    data.feedback,
    data.unverified_constraints,
    data.facts,
    data.progress_signals,
    data.experience_candidates,
    data.task_conditions,
    data.comparisons,
    data.coverage_views,
    data.hard_facts,
  ]) {
    deepFreeze(rows);
  }
  deepFreeze(data.coverage_snapshot);
  const snapshotHash = computeSnapshotHash(data);

  const readExcerpt = (
    ref: SourceRef,
    window: ExcerptWindow,
    maxBytes: number
  ): ExcerptReadResult => {
    const record = data.sources.get(ref);
    if (record === undefined) {
      return { ok: false, code: "E_SOURCE_NOT_FOUND", source_ref: ref };
    }
    if (!isSafePositiveInt(maxBytes) || maxBytes > MAX_EXCERPT_BYTES) {
      return { ok: false, code: "E_SOURCE_TOO_LARGE", source_ref: ref };
    }
    const range = selectByteRange(record, window);
    if ("code" in range) {
      return { ok: false, code: range.code, source_ref: ref };
    }
    const length = range.end - range.start;
    if (length <= 0 || length > maxBytes || length > MAX_EXCERPT_BYTES) {
      return { ok: false, code: "E_SOURCE_TOO_LARGE", source_ref: ref };
    }
    const bytes = record.bytes.slice(range.start, range.end);
    const decoded = decodeStrict(bytes);
    if (decoded === null) {
      return { ok: false, code: "E_SOURCE_UTF8_INVALID", source_ref: ref };
    }
    return { ok: true, bytes, text_hash: textHash(decoded), source_ref: ref };
  };

  const impl: EvidenceIndexPort = {
    listRequirements: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.requirements.filter((row) => {
        if (q.requirement_ids !== undefined && !q.requirement_ids.includes(row.requirement_id)) {
          return false;
        }
        if (q.statuses !== undefined && !q.statuses.includes(row.status)) {
          return false;
        }
        return true;
      });
    },
    listRequirementOps: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.requirement_ops.filter((row) => {
        if (q.statuses !== undefined && !q.statuses.includes(row.status)) {
          return false;
        }
        if (
          q.requirement_ids !== undefined &&
          row.target_requirement_id !== null &&
          !q.requirement_ids.includes(row.target_requirement_id) &&
          (row.created_requirement_id === null || !q.requirement_ids.includes(row.created_requirement_id))
        ) {
          return false;
        }
        return true;
      });
    },
    listFeedback: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.feedback.filter(
        (row) => q.target_issue_id === undefined || row.target_issue_id === q.target_issue_id
      );
    },
    listFacts: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.facts.filter((row) => {
        if (q.requirement_ids !== undefined) {
          if (row.requirement_id === undefined || !q.requirement_ids.includes(row.requirement_id)) {
            return false;
          }
        }
        if (q.fact_ids !== undefined && !q.fact_ids.includes(row.fact_id)) {
          return false;
        }
        if (q.kinds !== undefined && !q.kinds.includes(row.kind)) {
          return false;
        }
        if (q.statuses !== undefined && !q.statuses.includes(row.status)) {
          return false;
        }
        if (q.artifact_version !== undefined && row.artifact_version !== q.artifact_version) {
          return false;
        }
        return true;
      });
    },
    listProgressSignals: (q) => {
      assertBindingScope(data.binding, q.binding, undefined, data.watermark);
      if (
        q.to_watermark !== data.watermark ||
        q.from_watermark !== data.progress_from_watermark
      ) {
        throw evidenceIndexPortError("E_INDEX_WINDOW_INVALID", "error.index.window_invalid", {
          from_watermark: q.from_watermark,
          to_watermark: q.to_watermark,
        });
      }
      return data.progress_signals.filter(
        (row) => q.checkpoint_ids === undefined || q.checkpoint_ids.includes(row.signal_id)
      );
    },
    listExperienceCandidates: (q) => {
      assertBindingScope(data.binding, q.binding);
      if (data.review_snapshot_id === null || q.review_snapshot_id !== data.review_snapshot_id) {
        throw evidenceIndexPortError(
          "E_INDEX_REVIEW_SNAPSHOT_MISSING",
          "error.index.review_snapshot_missing",
          { review_snapshot_id: q.review_snapshot_id }
        );
      }
      return data.experience_candidates.filter(
        (row) => q.experience_ids === undefined || q.experience_ids.includes(row.experience_id)
      );
    },
    getCoverageSnapshot: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      if (
        q.snapshot_id !== undefined &&
        q.snapshot_id !== data.coverage_snapshot.snapshot_id
      ) {
        throw evidenceIndexPortError(
          "E_INDEX_SNAPSHOT_ID_MISMATCH",
          "error.index.snapshot_id_mismatch",
          { expected: data.coverage_snapshot.snapshot_id, actual: q.snapshot_id }
        );
      }
      return data.coverage_snapshot;
    },
    listTaskConditions: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.task_conditions.filter(
        (row) =>
          q.requirement_ids === undefined ||
          row.requirement_ids.some((id) => q.requirement_ids?.includes(id) === true)
      );
    },
    listUnverifiedConstraints: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.unverified_constraints.filter(
        (row) => q.statuses === undefined || q.statuses.includes(row.status)
      );
    },
    listComparisons: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.comparisons.filter(
        (row) => q.view_keys === undefined || q.view_keys.includes(row.view_key)
      );
    },
    listCoverageViews: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.coverage_views.filter(
        (row) => q.view_keys === undefined || q.view_keys.includes(row.view_key)
      );
    },
    listHardFacts: (q) => {
      assertBindingScope(data.binding, q.binding, q.watermark, data.watermark);
      return data.hard_facts.filter((row) => {
        if (q.requirement_ids !== undefined && !q.requirement_ids.includes(row.requirement_id)) {
          return false;
        }
        if (
          q.proposition_ids !== undefined &&
          (row.proposition_id === undefined || !q.proposition_ids.includes(row.proposition_id))
        ) {
          return false;
        }
        if (q.artifact_version !== undefined && row.artifact_version !== q.artifact_version) {
          return false;
        }
        return true;
      });
    },
    checkRetrievable: (refs) =>
      refs.map((ref) => {
        const record = data.sources.get(ref);
        if (record === undefined) {
          return { source_ref: ref, retrievable: false };
        }
        return { source_ref: ref, retrievable: true, content_hash: record.content_hash };
      }),
    readExcerpt,
  };

  const snapshot: EvidenceIndexSnapshot = {
    ...impl,
    schema_version: "rsi.evidence_index_snapshot/1",
    binding: data.binding,
    watermark: data.watermark,
    progress_from_watermark: data.progress_from_watermark,
    ledger_view_hash: data.ledger_view_hash,
    constraints_view_hash: data.constraints_view_hash,
    source_set_hash: data.source_set_hash,
    review_snapshot_id: data.review_snapshot_id,
    review_snapshot_hash: data.review_snapshot_hash,
    snapshot_hash: snapshotHash,
    row_counts: {
      requirements: data.requirements.length,
      requirement_ops: data.requirement_ops.length,
      feedback: data.feedback.length,
      unverified_constraints: data.unverified_constraints.length,
      facts: data.facts.length,
      progress_signals: data.progress_signals.length,
      experience_candidates: data.experience_candidates.length,
      task_conditions: data.task_conditions.length,
      comparisons: data.comparisons.length,
      coverage_views: data.coverage_views.length,
      hard_facts: data.hard_facts.length,
    },
  };

  deepFreeze(snapshot);
  SNAPSHOT_BRAND.add(snapshot);
  return snapshot;
}

