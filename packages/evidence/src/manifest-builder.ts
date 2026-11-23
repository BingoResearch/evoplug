/**
 * JudgeStateManifest construction (DD-EVD-015).
 *
 * A manifest is a shard-local projection: `shard_id` is the persisted random
 * shard identity and `shard_key` is the shard's content key. The compiler
 * cannot know that identity (binning depends on the service profile and the
 * run limits), so it only produces per-question projections; the shard
 * planner rebuilds the manifest from the real shard after binning.
 */

import { newId, type Hash, type Id, type JsonValue, type SourceRef } from "@evoplug/core";
import {
  projectJudgeState,
  type EvidenceIndexSnapshot,
  type JudgeState as CoreJudgeState,
  type PlanLifecycleState,
  type QuestionPlan as CoreQuestionPlan,
} from "@evoplug/core/evidence";

import {
  jcsHash,
  manifestHash,
  manifestKey,
  sortUtf8Strings,
  stateContentHash,
  stateHashOf,
  textHash,
  utf8Length,
} from "./hashing.js";
import type {
  DependencyUnit,
  JudgeStateManifest,
  JudgeStateManifestEntry,
  PlannedQuestion,
  QuestionPlan,
  Shard,
} from "./types.js";

const ROLE_RANK: Readonly<Record<string, number>> = {
  requirement: 0,
  feedback: 1,
  artifact: 2,
  verifier: 3,
  counter: 4,
  history: 5,
  context: 6,
};

const WIRE_REMOVED_FIELDS = ["source_refs", "retrievable"];

function roleRank(transportRole: string): number {
  return ROLE_RANK[transportRole] ?? 6;
}

interface ManifestEntryDraft {
  entry: JudgeStateManifestEntry;
  transportRole: string;
}

function stateContentHashOf(
  scope: { question_key: string } | { question_keys: readonly string[] },
  entries: readonly JudgeStateManifestEntry[]
): Hash {
  return jcsHash({
    schema_version: "rsi.judge_state_manifest_state_content/1",
    ...("question_key" in scope
      ? { question_key: scope.question_key }
      : { question_keys_utf8: sortUtf8Strings(scope.question_keys) }),
    entries: entries.map((entry) => ({
      logical_id: entry.logical_id,
      source_ids_utf8: sortUtf8Strings(entry.source_ids),
      role: entry.role,
      text_hash: entry.text_hash,
      content_hash: entry.content_hash,
      excerpt_bytes: entry.excerpt_bytes,
      requirement_ids_utf8: sortUtf8Strings(entry.requirement_ids),
      artifact_version: entry.artifact_version ?? null,
    })),
  });
}

function finaliseManifest(input: {
  scope: { question_key: string } | { question_keys: readonly string[] };
  drafts: readonly ManifestEntryDraft[];
  shardId: Id;
  shardKey: Hash;
  packKey: Hash;
  planHash: Hash;
  now: number;
}): JudgeStateManifest {
  const sorted = [...input.drafts].sort((a, b) => {
    const byRole = roleRank(a.transportRole) - roleRank(b.transportRole);
    if (byRole !== 0) {
      return byRole;
    }
    const aRef = a.entry.source_refs[0] ?? "";
    const bRef = b.entry.source_refs[0] ?? "";
    if (aRef !== bRef) {
      return aRef < bRef ? -1 : 1;
    }
    const aSource = a.entry.source_ids[0] ?? "";
    const bSource = b.entry.source_ids[0] ?? "";
    if (aSource !== bSource) {
      return aSource < bSource ? -1 : 1;
    }
    return a.entry.logical_id < b.entry.logical_id ? -1 : 1;
  });
  const entries = sorted.map((draft, index) => ({
    ...draft.entry,
    display_ordinal: index + 1,
    display_id: `E${String(index + 1)}`,
  }));
  const stateContentHash = stateContentHashOf(input.scope, entries);
  const stateHash = jcsHash({
    schema_version: "rsi.judge_state_manifest_state/1",
    shard_key: input.shardKey,
    state_content_hash: stateContentHash,
  });
  const manifestKeyValue = manifestKey({
    state_hash: stateHash,
    state_content_hash: stateContentHash,
    shard_key: input.shardKey,
    pack_key: input.packKey,
    plan_hash: input.planHash,
    entries,
  });
  const manifestHashValue = manifestHash({
    manifest_key: manifestKeyValue,
    state_hash: stateHash,
    state_content_hash: stateContentHash,
    shard_key: input.shardKey,
    pack_key: input.packKey,
    plan_hash: input.planHash,
    entries,
    wire_removed_fields: WIRE_REMOVED_FIELDS,
  });
  return {
    schema_version: "rsi.judge_state_manifest/1",
    manifest_id: newId("snap"),
    manifest_key: manifestKeyValue,
    state_hash: stateHash,
    state_content_hash: stateContentHash,
    shard_id: input.shardId,
    shard_key: input.shardKey,
    pack_key: input.packKey,
    plan_hash: input.planHash,
    entries,
    wire_removed_fields: [...WIRE_REMOVED_FIELDS],
    created_at: input.now,
    manifest_hash: manifestHashValue,
  };
}

/**
 * Manifest over an actually projected `JudgeState/2`.
 *
 * `state_hash` and `state_content_hash` are the EVD binding hashes of the
 * exact wire state, not a digest of the manifest entries. `entries` is the
 * state's evidence surface joined back to the units that supplied the local
 * `source_ids`/`source_refs`, so a reader can verify both the wire view and
 * the full local provenance.
 */
function finaliseManifestFromState(input: {
  state: CoreJudgeState;
  entries: readonly JudgeStateManifestEntry[];
  shardId: Id;
  shardKey: Hash;
  packKey: Hash;
  planHash: Hash;
  now: number;
}): JudgeStateManifest {
  const stateJson = JSON.parse(JSON.stringify(input.state)) as JsonValue;
  const stateHash = stateHashOf(stateJson);
  const stateContentHashValue = stateContentHash(stateJson);
  const entries = [...input.entries].sort(
    (left, right) => left.display_ordinal - right.display_ordinal
  );
  const manifestKeyValue = manifestKey({
    state_hash: stateHash,
    state_content_hash: stateContentHashValue,
    shard_key: input.shardKey,
    pack_key: input.packKey,
    plan_hash: input.planHash,
    entries,
  });
  const manifestHashValue = manifestHash({
    manifest_key: manifestKeyValue,
    state_hash: stateHash,
    state_content_hash: stateContentHashValue,
    shard_key: input.shardKey,
    pack_key: input.packKey,
    plan_hash: input.planHash,
    entries,
    wire_removed_fields: WIRE_REMOVED_FIELDS,
  });
  return {
    schema_version: "rsi.judge_state_manifest/1",
    manifest_id: newId("snap"),
    manifest_key: manifestKeyValue,
    state_hash: stateHash,
    state_content_hash: stateContentHashValue,
    shard_id: input.shardId,
    shard_key: input.shardKey,
    pack_key: input.packKey,
    plan_hash: input.planHash,
    entries,
    wire_removed_fields: [...WIRE_REMOVED_FIELDS],
    created_at: input.now,
    manifest_hash: manifestHashValue,
  };
}

/**
 * Join the projected wire evidence back to the units.
 *
 * `state_evidence` is the only place that keeps the full `source_ids` and
 * `source_refs`; the wire state intentionally drops both. Matching is by
 * `logical_id` first and by the exact excerpt text hash second, so a derived
 * view that the projector renames still finds its provenance.
 */
function entriesFromState(
  state: CoreJudgeState,
  units: readonly DependencyUnit[]
): JudgeStateManifestEntry[] | null {
  const candidates = units.flatMap((unit) =>
    unit.state_evidence.map((evidence) => ({ unit, evidence }))
  );
  const entries: JudgeStateManifestEntry[] = [];
  const projected = state.evidence.map((entry) => ({
    logical_id: entry.logical_id,
    excerpt: entry.excerpt,
    role: entry.role,
    display_id: entry.display_id,
    requirement_ids: entry.requirement_ids,
    artifact_version: entry.artifact_version,
  }));
  const seen = new Set<string>();
  for (const [index, entry] of projected.entries()) {
    const projected = entry;
    if (seen.has(projected.logical_id)) continue;
    seen.add(projected.logical_id);
    const excerptHash = textHash(projected.excerpt);
    const byLogicalId = candidates.filter(
      (candidate) => candidate.evidence.logical_id === projected.logical_id
    );
    // A derived view can reuse `<view>:<ordinal>` across dependencies. Prefer
    // the candidate whose frozen text is the projected excerpt; only fall back
    // to the whole logical-id group when no candidate matches byte-for-byte.
    const sameText = byLogicalId.filter(
      (candidate) => candidate.evidence.text_hash === excerptHash
    );
    const chosen =
      sameText.length > 0
        ? sameText
        : byLogicalId.length > 0
          ? byLogicalId
          : candidates.filter((candidate) => candidate.evidence.text_hash === excerptHash);
    const sourceRefs = sortUtf8Strings(
      chosen.flatMap((candidate) => candidate.evidence.source_refs)
    ) as SourceRef[];
    if (sourceRefs.length === 0) {
      return null;
    }
    const sourceIds = sortUtf8Strings(
      chosen.flatMap((candidate) => candidate.evidence.source_ids)
    );
    const local = chosen[0]?.evidence;
    entries.push({
      display_ordinal: index + 1,
      display_id: projected.display_id,
      logical_id: projected.logical_id,
      source_ids: sourceIds.length > 0 ? sourceIds : [projected.logical_id],
      source_refs: sourceRefs,
      role: projected.role,
      text_hash: local?.text_hash ?? textHash(projected.excerpt),
      content_hash: local?.content_hash ?? textHash(projected.excerpt),
      excerpt_bytes: utf8Length(projected.excerpt),
      requirement_ids: sortUtf8Strings(projected.requirement_ids),
      ...(projected.artifact_version !== undefined
        ? { artifact_version: projected.artifact_version }
        : {}),
    });
  }
  return entries;
}

/**
 *
 * `shard_id` and `shard_key` here are not a persisted shard association; the
 * planner replaces them with the real shard identity before `commitCompile`.
 */
export function buildQuestionManifest(
  plan: QuestionPlan,
  question: PlannedQuestion,
  units: readonly DependencyUnit[],
  packKey: Hash,
  now: number
): JudgeStateManifest {
  const relevant = units.filter(
    (unit) =>
      unit.question_ids.includes(question.question_id) ||
      unit.question_ids.includes(question.question_key)
  );
  const byLogicalId = new Map<string, ManifestEntryDraft>();
  for (const unit of relevant) {
    for (const evidence of unit.state_evidence) {
      const artifactVersion = evidence.artifact_version ?? unit.artifact_version;
      const existing = byLogicalId.get(evidence.logical_id);
      if (existing !== undefined) {
        existing.entry.source_ids = sortUtf8Strings([
          ...existing.entry.source_ids,
          ...evidence.source_ids,
        ]);
        existing.entry.source_refs = sortUtf8Strings([
          ...existing.entry.source_refs,
          ...evidence.source_refs,
        ]) as JudgeStateManifestEntry["source_refs"];
        continue;
      }
      byLogicalId.set(evidence.logical_id, {
        transportRole: unit.transport_role,
        entry: {
          display_ordinal: 0,
          display_id: "",
          logical_id: evidence.logical_id,
          source_ids: sortUtf8Strings(evidence.source_ids),
          source_refs: sortUtf8Strings(evidence.source_refs) as JudgeStateManifestEntry["source_refs"],
          role: unit.role,
          text_hash: evidence.text_hash,
          content_hash: evidence.content_hash,
          excerpt_bytes: utf8Length(evidence.excerpt),
          requirement_ids: sortUtf8Strings(question.requirement_ids),
          ...(artifactVersion !== undefined ? { artifact_version: artifactVersion } : {}),
        },
      });
    }
  }
  return finaliseManifest({
    scope: { question_key: question.question_key },
    drafts: [...byLogicalId.values()],
    shardId: newId("shard"),
    shardKey: jcsHash({
      schema_version: "rsi.judge_state_manifest_shard_key/1",
      plan_hash: plan.plan_hash,
      pack_key: packKey,
      question_key: question.question_key,
      unit_keys_utf8: sortUtf8Strings(relevant.map((unit) => unit.unit_key)),
    }),
    packKey,
    planHash: plan.plan_hash,
    now,
  });
}

/**
 * Build manifests for every non-rejected shard from its actual QP
 * `JudgeState/2` projection.
 *
 * A fixture whose sources cannot be projected yields no manifest rather than
 * a manifest over an invented state: `state_hash` must always describe the
 * exact wire state `buildRequest` will hash. Shards whose projection succeeds
 * carry the projected state hash on the shard row.
 */
export function buildShardManifests(input: {
  plan: QuestionPlan;
  shards: readonly Shard[];
  units: readonly DependencyUnit[];
  packKey: Hash;
  packHash: Hash;
  snapshot: EvidenceIndexSnapshot;
  planState: PlanLifecycleState | null;
  now: number;
}, reasons?: Map<string, string>, states?: Map<string, CoreJudgeState>): JudgeStateManifest[] {
  const unitByKey = new Map<string, DependencyUnit>(input.units.map((unit) => [unit.unit_key, unit]));
  const plan = input.plan as unknown as CoreQuestionPlan;
  // Direct `planShardsForPlan` fixtures may carry a partial plan row (no QP
  // projection inputs). A manifest needs the full typed state, and inventing
  // an empty one would make `state_hash` describe bytes `buildRequest` will
  // never see, so such a fixture yields no manifests.
  if (!Array.isArray(plan.questions) || !Array.isArray(plan.sources)) {
    for (const shard of input.shards) reasons?.set(shard.shard_id, "plan_incomplete");
    return [];
  }
  const manifests: JudgeStateManifest[] = [];
  for (const shard of input.shards) {
    if (shard.status === "budget_rejected" || shard.status === "projection_rejected") {
      continue;
    }
    const projected = projectJudgeState({
      plan,
      snapshot: input.snapshot,
      shard: {
        shard_id: shard.shard_id,
        question_keys: [...shard.question_keys, ...shard.optional_question_keys],
        pack_hash: input.packHash,
      },
      plan_state: input.planState === null ? null : { state: input.planState },
    });
    if (projected.status !== "ok") {
      const first = projected.errors[0];
      reasons?.set(
        shard.shard_id,
        `projection:${first?.code ?? "unknown"}:${(first?.logical_ids ?? []).join("|")}`
      );
      continue;
    }
    const units = shard.unit_keys
      .map((unitKey) => unitByKey.get(unitKey))
      .filter((unit): unit is DependencyUnit => unit !== undefined);
    const entries = entriesFromState(projected.state, units);
    if (entries === null) {
      reasons?.set(shard.shard_id, "projection_entries");
      continue;
    }
    manifests.push(
      finaliseManifestFromState({
        state: projected.state,
        entries,
        shardId: shard.shard_id,
        shardKey: shard.shard_key,
        packKey: input.packKey,
        planHash: input.plan.plan_hash,
        now: input.now,
      })
    );
    // The binding reader resolves `state_hash` from an immutable document, so
    // the exact projected state must survive compile. `finaliseManifestFromState`
    // hashes the JSON round-trip; store the same bytes the hash describes.
    states?.set(
      shard.shard_id,
      JSON.parse(JSON.stringify(projected.state)) as CoreJudgeState
    );
  }
  return manifests.sort((a, b) =>
    a.shard_key < b.shard_key ? -1 : a.shard_key > b.shard_key ? 1 : a.manifest_key < b.manifest_key ? -1 : 1
  );
}
