/**
 * Candidate confirmation and adoption (design §5.3, §7).
 *
 * A review candidate never becomes a managed write without a human decision.
 * This module owns the small durable state machine around that decision
 * (`candidate_confirmation`), builds the confirmation summary, and performs the
 * exact `grant -> write.apply -> readback -> approve roots` sequence once the
 * decision is positive. The decision itself arrives either from a host-native
 * dialog (control-plane proof) or from the test-mode backdoor (5.4).
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { canonicalHash, canonicalJsonText, hashBytes, newId, type ErrorEnvelope, type Hash, type Id, type JsonValue, type Result } from "@evoplug/core";
import { err, makeErrorEnvelope, ok, toJsonValue } from "@evoplug/core";
import {
  createGrant,
  parseManagedBlocks,
  validateGrantIssueRequest,
  type GrantIssueRequest
} from "@evoplug/auth";
import { applyDiff, withSkillFrontmatter } from "@evoplug/review";
import type { HostMode } from "@evoplug/core/host";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";
import type { BlobStore } from "@evoplug/storage";

import {
  approveManagedRoots,
  isTargetInsideRoot,
  readManagedRoot,
  resolveManagedRootPath,
  type ManagedObjectKind,
  type ManagedRootRow
} from "./managed-roots.js";

export interface CandidateRow {
  readonly candidate_id: string;
  readonly proposal_id: string;
  readonly proposal_state: "checked" | "unverified" | "proposed" | "stale" | "withdrawn" | "adopted";
  readonly change_kind: "create" | "update" | "disable" | "rollback";
  readonly candidate_hash: Hash;
  readonly candidate_file_hash: Hash;
  readonly object_type: ManagedObjectKind;
  readonly target_path: string;
  readonly block_selector: string | null;
  readonly write_mode: "whole_file" | "managed_block";
  readonly expected_file_hash: Hash | null;
  readonly expected_block_hash: Hash | null;
  readonly diff_format: "unified_diff" | "managed_block_patch" | "json_merge_patch";
  readonly diff_ref: string;
  readonly target_json: Record<string, unknown>;
  readonly job_id: string;
  readonly host_id: string;
  readonly config_space: string;
  readonly mode: string;
  /** Frontmatter description from the accepted generator candidate. */
  readonly skill_description: string | null;
  /** Human title from the accepted generator experience, when present. */
  readonly skill_title: string | null;
}

function rowString(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readCandidate(connection: SqliteConnection, id: string): CandidateRow | null {
  const byCandidate = connection
    .prepare<SqlRow>("SELECT proposal_id FROM proposal_candidates WHERE candidate_key = :id LIMIT 1")
    .get({ id });
  const proposalId = typeof byCandidate?.["proposal_id"] === "string"
    ? byCandidate["proposal_id"]
    : id;
  const row = connection
    .prepare<SqlRow>(
      `SELECT proposal_id, job_id, state, change_kind, candidate_hash, candidate_file_hash,
              expected_file_hash, expected_block_hash, target_json, diff_json
         FROM proposals WHERE proposal_id = :id`
    )
    .get({ id: proposalId });
  if (row === undefined) return null;
  const target = parseJsonObject(rowString(row, "target_json"));
  const diff = parseJsonObject(rowString(row, "diff_json"));
  if (target === null || diff === null) return null;
  const job = connection
    .prepare<SqlRow>("SELECT stable_watermark, scope_json FROM review_jobs WHERE job_id = :job_id")
    .get({ job_id: rowString(row, "job_id") });
  if (job === undefined) return null;
  const scope = parseJsonObject(rowString(job, "scope_json")) ?? {};
  const objectType = target["object_type"];
  if (objectType !== "skill" && objectType !== "memory" && objectType !== "instructions") {
    return null;
  }
  const changeKind = rowString(row, "change_kind");
  let skillDescription: string | null = null;
  let skillTitle: string | null = null;
  try {
    const candidateRow = connection
      .prepare<SqlRow>(
        "SELECT generator_json FROM proposal_candidates WHERE proposal_id = :id LIMIT 1"
      )
      .get({ id: proposalId });
    if (candidateRow !== undefined && typeof candidateRow["generator_json"] === "string") {
      const generator = JSON.parse(candidateRow["generator_json"]) as unknown;
      const experience =
        typeof generator === "object" && generator !== null && !Array.isArray(generator)
          ? (generator as Record<string, unknown>)["experience"]
          : null;
      const trigger =
        typeof experience === "object" && experience !== null && !Array.isArray(experience)
          ? (experience as Record<string, unknown>)["trigger"]
          : null;
      const description =
        typeof trigger === "object" && trigger !== null && !Array.isArray(trigger)
          ? (trigger as Record<string, unknown>)["description"]
          : null;
      if (typeof description === "string" && description.trim().length > 0) {
        skillDescription = description;
      }
      const title =
        typeof experience === "object" && experience !== null && !Array.isArray(experience)
          ? (experience as Record<string, unknown>)["title"]
          : null;
      if (typeof title === "string" && title.trim().length > 0) {
        skillTitle = title;
      }
    }
  } catch {
    skillDescription = null;
  }
  return {
    candidate_id: rowString(row, "proposal_id"),
    proposal_id: rowString(row, "proposal_id"),
    proposal_state: rowString(row, "state") as CandidateRow["proposal_state"],
    change_kind: changeKind as CandidateRow["change_kind"],
    candidate_hash: rowString(row, "candidate_hash") as Hash,
    candidate_file_hash: rowString(row, "candidate_file_hash") as Hash,
    object_type: objectType,
    target_path: typeof target["path_or_block"] === "string" ? target["path_or_block"] : "",
    block_selector: typeof target["block_selector"] === "string" ? target["block_selector"] : null,
    write_mode: target["write_mode"] === "managed_block" ? "managed_block" : "whole_file",
    expected_file_hash: typeof row["expected_file_hash"] === "string" ? (row["expected_file_hash"] as Hash) : null,
    expected_block_hash: typeof row["expected_block_hash"] === "string" ? (row["expected_block_hash"] as Hash) : null,
    diff_format: (diff["format"] ?? "unified_diff") as CandidateRow["diff_format"],
    diff_ref: typeof diff["ref"] === "string" ? diff["ref"] : "",
    target_json: target,
    job_id: rowString(row, "job_id"),
    host_id: typeof target["host_id"] === "string" ? target["host_id"] : "",
    config_space: typeof target["config_space"] === "string" ? target["config_space"] : String(scope["config_space"] ?? "default"),
    mode: typeof target["mode"] === "string" ? target["mode"] : "interactive",
    skill_description: skillDescription,
    skill_title: skillTitle
  };
}

/** Root used for a candidate's object type. */
export function candidateRoot(
  connection: SqliteConnection,
  candidate: CandidateRow
): Result<ManagedRootRow, ErrorEnvelope> {
  const row = connection
    .prepare<SqlRow>(
      `SELECT root_id, state FROM managed_root
        WHERE host_id = :host_id AND config_space = :config_space AND kind = :kind
        ORDER BY CASE state WHEN 'approved' THEN 0 WHEN 'pending_approval' THEN 1 ELSE 2 END,
                 root_id ASC
        LIMIT 1`
    )
    .get({
      host_id: candidate.host_id,
      config_space: candidate.config_space,
      kind: candidate.object_type
    });
  if (row === undefined) return err(rootError("kind", "not_registered"));
  const read = readManagedRoot(connection, String(row["root_id"]));
  if (!read.ok) return read;
  if (read.value === null) return err(rootError("root_id", "not_registered"));
  return ok(read.value);
}

export function candidateSubjectHash(
  candidate: CandidateRow,
  root: ManagedRootRow,
  action: string
): Hash {
  return canonicalHash({
    schema_version: "rsi.candidate_confirmation_subject/1",
    candidate_id: candidate.candidate_id,
    candidate_hash: candidate.candidate_hash,
    target_path: candidate.target_path,
    root_id: root.root_id,
    action
  });
}

/** Why a still-pending candidate can no longer be presented or adopted. */
export type CandidateStaleness =
  | { readonly stale: false }
  | {
      readonly stale: true;
      readonly reason: "superseded" | "target_changed" | "target_missing" | "block_missing";
    };

/**
 * Appendix L.4: before a candidate is presented (and again before adoption)
 * it must still describe the current target. A candidate is superseded by a
 * newer candidate for the same path and block selector, and stale when the
 * file or the managed block no longer matches the bytes it was generated
 * against. Failures to read the root or the file stay `stale: false`: the
 * adoption path must fail closed with its own diagnostic, not silently drop
 * a candidate because of a transient read error.
 */
export function candidateStaleness(
  connection: SqliteConnection,
  candidate: CandidateRow
): CandidateStaleness {
  const current = connection
    .prepare<SqlRow>(
      "SELECT created_at FROM proposals WHERE proposal_id = :id"
    )
    .get({ id: candidate.candidate_id });
  const createdAt = typeof current?.["created_at"] === "number" ? current["created_at"] : null;
  if (createdAt !== null) {
    const newer = connection
      .prepare<SqlRow>(
        `SELECT 1 AS present FROM proposals
          WHERE proposal_id <> :id
            AND state IN ('checked','proposed','adopted')
            AND COALESCE(json_extract(target_json, '$.object_type'), '') = :object_type
            AND COALESCE(json_extract(target_json, '$.path_or_block'), '') = :path
            AND COALESCE(json_extract(target_json, '$.block_id'),
                         json_extract(target_json, '$.block_selector'), '') = :block
            AND (created_at > :created_at OR (created_at = :created_at AND proposal_id > :id))
          LIMIT 1`
      )
      .get({
        id: candidate.candidate_id,
        object_type: candidate.object_type,
        path: candidate.target_path,
        block: candidate.block_selector ?? "",
        created_at: createdAt
      });
    if (newer !== undefined) return { stale: true, reason: "superseded" };
  }
  const rootResult = candidateRoot(connection, candidate);
  if (!rootResult.ok) return { stale: false };
  let rootPath: string;
  try {
    rootPath = resolveManagedRootPath(rootResult.value);
  } catch {
    return { stale: false };
  }
  const targetPath = writePathOf(candidate);
  if (targetPath.length === 0 || isAbsolute(targetPath)) return { stale: false };
  const absolute = join(rootPath, targetPath);
  let bytes: Uint8Array | null = null;
  try {
    bytes = new Uint8Array(readFileSync(absolute));
  } catch {
    bytes = null;
  }
  if (bytes === null) {
    // A create expects the target to be absent; its continuing absence is the
    // state the candidate was generated against.
    return candidate.change_kind === "create" ? { stale: false } : { stale: true, reason: "target_missing" };
  }
  if (candidate.write_mode === "managed_block") {
    const selector = candidate.block_selector;
    const parsed = parseManagedBlocks(bytes);
    if (selector === null || !parsed.ok) return { stale: false };
    const block = parsed.value.blocks.find((span) => span.selector === selector) ?? null;
    if (block === null) {
      // Appending a new block to an existing file is a valid create.
      return candidate.change_kind === "create" ? { stale: false } : { stale: true, reason: "block_missing" };
    }
    if (candidate.change_kind === "create") {
      // The block the candidate wanted to attach already exists.
      return { stale: true, reason: "target_changed" };
    }
    if (candidate.expected_block_hash !== null && block.block_hash !== candidate.expected_block_hash) {
      return { stale: true, reason: "target_changed" };
    }
  }
  if (candidate.change_kind === "create" && candidate.write_mode === "whole_file") {
    return { stale: true, reason: "target_changed" };
  }
  if (candidate.expected_file_hash !== null && hashBytes(bytes) !== candidate.expected_file_hash) {
    return { stale: true, reason: "target_changed" };
  }
  return { stale: false };
}

/** Marks a pending proposal stale so it leaves the confirmation queue. */
export function markCandidateStale(
  connection: SqliteConnection,
  candidateId: string,
  reason: string,
  now: number
): void {
  connection
    .prepare(
      `UPDATE proposals
          SET state = 'stale', stale_reason = :reason, updated_at = :now
        WHERE proposal_id = :id AND state IN ('checked','proposed')`
    )
    .run({ id: candidateId, reason, now });
}

export interface ConfirmationSummary {
  readonly schema_version: "rsi.candidate_confirmation/1";
  readonly candidate_id: string;
  readonly subject_hash: Hash;
  readonly object_type: ManagedObjectKind;
  readonly target_path: string;
  readonly target_root: string;
  readonly change_summary: string;
  readonly basis_evidence_refs: readonly string[];
  readonly verification_plan: string;
}

export function buildConfirmationSummary(
  connection: SqliteConnection,
  candidate: CandidateRow,
  root: ManagedRootRow
): ConfirmationSummary {
  const evidence = connection
    .prepare<SqlRow>("SELECT evidence_refs_json FROM proposals WHERE proposal_id = :id")
    .get({ id: candidate.proposal_id });
  let refs: string[] = [];
  if (evidence !== undefined && typeof evidence["evidence_refs_json"] === "string") {
    try {
      const parsed = JSON.parse(evidence["evidence_refs_json"]) as unknown;
      if (Array.isArray(parsed)) refs = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      refs = [];
    }
  }
  const diff = connection
    .prepare<SqlRow>("SELECT diff_json FROM proposals WHERE proposal_id = :id")
    .get({ id: candidate.proposal_id });
  let summary = `${candidate.change_kind} ${candidate.object_type} at ${candidate.target_path}`;
  if (diff !== undefined && typeof diff["diff_json"] === "string") {
    const parsed = parseJsonObject(diff["diff_json"]);
    if (parsed !== null && typeof parsed["format"] === "string") {
      summary = `${candidate.change_kind} ${candidate.object_type} (${String(parsed["format"])}) at ${candidate.target_path}`;
    }
  }
  return {
    schema_version: "rsi.candidate_confirmation/1",
    candidate_id: candidate.candidate_id,
    subject_hash: candidateSubjectHash(candidate, root, candidate.change_kind),
    object_type: candidate.object_type,
    target_path: candidate.target_path,
    target_root: root.state === "approved" ? "approved" : root.state,
    change_summary: summary,
    basis_evidence_refs: refs,
    verification_plan: "after write: read back the exact bytes, verify the file hash, and load on the next host session"
  };
}

export interface ConfirmationRow {
  readonly candidate_id: string;
  readonly proposal_id: string;
  readonly candidate_hash: Hash;
  readonly subject_hash: Hash;
  readonly object_type: ManagedObjectKind;
  readonly target_path: string;
  readonly summary: ConfirmationSummary;
  readonly ask_count: number;
  readonly state:
    | "pending"
    | "adopted"
    | "rejected"
    | "deferred"
    | "withdrawn_incomplete"
    | "expired";
  /** Redacted text from the "内容不对" answer; null otherwise. */
  readonly rejection_reason: string | null;
  readonly proof_kind: "host_native_confirmation" | "test_backdoor_confirmation" | null;
}

export function ensureConfirmationRow(
  connection: SqliteConnection,
  candidate: CandidateRow,
  root: ManagedRootRow,
  now: number
): Result<ConfirmationRow, ErrorEnvelope> {
  const summary = buildConfirmationSummary(connection, candidate, root);
  const existing = connection
    .prepare<SqlRow>("SELECT * FROM candidate_confirmation WHERE candidate_id = :id")
    .get({ id: candidate.candidate_id });
  if (existing === undefined) {
    connection
      .prepare(
        `INSERT INTO candidate_confirmation (
           candidate_id, proposal_id, candidate_hash, subject_hash, object_type, target_path,
           summary_json, ask_count, state, proof_kind, last_asked_at, created_at, updated_at
         ) VALUES (
           :candidate_id, :proposal_id, :candidate_hash, :subject_hash, :object_type, :target_path,
           :summary_json, 0, 'pending', NULL, NULL, :created_at, :updated_at
         )`
      )
      .run({
        candidate_id: candidate.candidate_id,
        proposal_id: candidate.proposal_id,
        candidate_hash: candidate.candidate_hash,
        subject_hash: summary.subject_hash,
        object_type: candidate.object_type,
        target_path: candidate.target_path,
        summary_json: canonicalJsonText(toJsonValue(summary)),
        created_at: now,
        updated_at: now
      });
  } else if (rowString(existing, "subject_hash") !== summary.subject_hash) {
    // The candidate changed; a fresh confirmation is required.
    connection
      .prepare(
        `UPDATE candidate_confirmation
            SET subject_hash = :subject_hash, summary_json = :summary_json, ask_count = 0,
                state = 'pending', proof_kind = NULL, last_asked_at = NULL, updated_at = :now
          WHERE candidate_id = :id`
      )
      .run({
        id: candidate.candidate_id,
        subject_hash: summary.subject_hash,
        summary_json: canonicalJsonText(toJsonValue(summary)),
        now
      });
  }
  return readConfirmationRow(connection, candidate.candidate_id);
}

export function readConfirmationRow(
  connection: SqliteConnection,
  candidateId: string
): Result<ConfirmationRow, ErrorEnvelope> {
  const row = connection
    .prepare<SqlRow>("SELECT * FROM candidate_confirmation WHERE candidate_id = :id")
    .get({ id: candidateId });
  if (row === undefined) return err(rootError("candidate_id", "not_found"));
  const summary = parseJsonObject(rowString(row, "summary_json"));
  if (summary === null) return err(rootError("summary_json", "invalid"));
  const state = rowString(row, "state");
  if (
    state !== "pending" &&
    state !== "adopted" &&
    state !== "rejected" &&
    state !== "deferred" &&
    state !== "withdrawn_incomplete" &&
    state !== "expired"
  ) {
    return err(rootError("state", "invalid"));
  }
  const proof = row["proof_kind"];
  return ok({
    candidate_id: rowString(row, "candidate_id"),
    proposal_id: rowString(row, "proposal_id"),
    candidate_hash: rowString(row, "candidate_hash") as Hash,
    subject_hash: rowString(row, "subject_hash") as Hash,
    object_type: rowString(row, "object_type") as ManagedObjectKind,
    target_path: rowString(row, "target_path"),
    summary: summary as unknown as ConfirmationSummary,
    ask_count: Number(row["ask_count"]),
    state,
    rejection_reason: typeof row["rejection_reason"] === "string" ? row["rejection_reason"] : null,
    proof_kind: proof === "host_native_confirmation" || proof === "test_backdoor_confirmation"
      ? proof
      : null
  });
}

/** Increments the ask counter; returns false when the three-ask cap is spent. */
export function recordAsk(
  connection: SqliteConnection,
  candidateId: string,
  now: number
): boolean {
  const result = connection
    .prepare(
      `UPDATE candidate_confirmation
          SET ask_count = ask_count + 1, last_asked_at = :now, updated_at = :now
        WHERE candidate_id = :id AND state IN ('pending','deferred') AND ask_count < 3`
    )
    .run({ id: candidateId, now });
  return result.changes === 1;
}

/**
 * Appendix Q.6: the task was not finished. The candidate is withdrawn without
 * counting as negative evidence, and the review watermark does not advance.
 */
export function recordWithdrawnIncomplete(
  connection: SqliteConnection,
  candidateId: string,
  now: number
): void {
  connection
    .prepare(
      `UPDATE candidate_confirmation
          SET state = 'withdrawn_incomplete', updated_at = :now
        WHERE candidate_id = :id`
    )
    .run({ id: candidateId, now });
  connection
    .prepare(
      `UPDATE proposals SET state = 'withdrawn', updated_at = :now
        WHERE proposal_id = (SELECT proposal_id FROM candidate_confirmation WHERE candidate_id = :id)
          AND state IN ('checked','proposed')`
    )
    .run({ id: candidateId, now });
}

export function recordRejected(
  connection: SqliteConnection,
  candidateId: string,
  proofKind: ConfirmationRow["proof_kind"],
  now: number,
  reason: string | null = null
): void {
  connection
    .prepare(
      `UPDATE candidate_confirmation
          SET state = 'rejected', proof_kind = :proof, rejection_reason = :reason, updated_at = :now
        WHERE candidate_id = :id`
    )
    .run({ id: candidateId, proof: proofKind, reason, now });
  connection
    .prepare(
      `UPDATE proposals SET state = 'withdrawn', updated_at = :now
        WHERE proposal_id = (SELECT proposal_id FROM candidate_confirmation WHERE candidate_id = :id)
          AND state IN ('checked','proposed')`
    )
    .run({ id: candidateId, now });
}

function rootError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_ROOT_UNAVAILABLE",
    category: "policy",
    message_key: "error.root.unavailable",
    stage: "candidate_adoption",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function adoptionError(code: ErrorEnvelope["code"], path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: code === "E_CONFLICT" ? "conflict" : "policy",
    message_key: `error.${code.toLowerCase()}`,
    stage: "candidate_adoption",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

export interface HumanDecisionProof {
  /**
   * Adoption is authorized by a host-native confirmation (design §5, K.2).
   * `control_plane_explicit_confirmation` stays reserved for the control-plane
   * purposes the design names explicitly; `test_backdoor_confirmation` exists
   * only in a test-mode home.
   */
  readonly kind:
    | "host_native_confirmation"
    | "host_verified_interactive_user"
    | "control_plane_explicit_confirmation"
    | "test_backdoor_confirmation";
  readonly capability_id: string;
  readonly evidence_ref: string;
  readonly confirmed_at: number;
  /** Channel that produced the answer (K.2); recorded for auditing. */
  readonly mechanism?: string;
  readonly channel?: {
    readonly server: string | null;
    readonly session_id: string | null;
    readonly request_id: number | null;
  };
}

/**
 * Maps a decision-proof kind onto the grant attestation vocabulary. The grant
 * schema has no `host_native_confirmation` kind; its native-user kind is the
 * one that proves a person answered in the host, and the evidence blob keeps
 * the channel detail (`proof_kind`, mechanism, request id).
 */
export function toHumanAttestationKind(
  kind: HumanDecisionProof["kind"]
): "host_verified_interactive_user" | "control_plane_explicit_confirmation" | "test_backdoor_confirmation" {
  return kind === "host_native_confirmation" ? "host_verified_interactive_user" : kind;
}

export interface AdoptCandidateInput {
  readonly connection: SqliteConnection;
  readonly blob_store: Pick<BlobStore, "putSync" | "read">;
  readonly home: string;
  readonly candidate_id: string;
  readonly proof: HumanDecisionProof;
  readonly write_apply: (request: JsonValue, signal: AbortSignal) => Promise<Result<JsonValue, ErrorEnvelope>>;
  readonly now: () => number;
}

export interface AdoptionResult {
  readonly status: "adopted";
  readonly candidate_id: string;
  readonly subject_hash: Hash;
  readonly target_path: string;
  readonly root_id: string;
  readonly write: JsonValue;
  readonly attestation: "host_native" | "test_backdoor";
  readonly approved_root_ids: readonly string[];
}

/**
 * The file a managed write lands in. A block candidate's `path_or_block` is
 * `<file>#<selector>` (K.1); the selector is carried separately, so the write
 * must address `<file>`, not a literal file containing `#`.
 */
export function writePathOf(candidate: CandidateRow): string {
  if (candidate.write_mode !== "managed_block") return candidate.target_path;
  const separator = candidate.target_path.indexOf("#");
  return separator > 0 ? candidate.target_path.slice(0, separator) : candidate.target_path;
}

function assertContent(candidate: CandidateRow, root: ManagedRootRow): Result<{
  absolute_path: string;
  bytes: Uint8Array;
}, ErrorEnvelope> {
  const targetPath = writePathOf(candidate);
  if (targetPath.length === 0 || isAbsolute(targetPath)) {
    return err(adoptionError("E_AUTH_DENIED", "target_path", "relative"));
  }
  if (root.target_prefix.length > 0 && !targetPath.startsWith(root.target_prefix)) {
    return err(adoptionError("E_AUTH_DENIED", "target_path", "outside_managed_subdirectory"));
  }
  let rootPath: string;
  try {
    rootPath = resolveManagedRootPath(root);
  } catch {
    return err(rootError("root_id", "unresolvable"));
  }
  const absolute = join(rootPath, targetPath);
  const rel = relative(rootPath, absolute);
  // Appendix H.1: the only accepted target is inside the registered root.
  if (rel.startsWith("..") || isAbsolute(rel) || !isTargetInsideRoot(rootPath, absolute)) {
    return err(adoptionError("E_AUTH_DENIED", "target_path", "target_outside_root"));
  }
  let base = "";
  let fileExists = true;
  try {
    base = readFileSync(absolute, "utf8");
  } catch {
    fileExists = false;
    if (candidate.change_kind !== "create") {
      return err(adoptionError("E_CONFLICT", "target_path", "base_missing"));
    }
  }
  // Appendix M.3: only a whole_file create requires an absent target; a
  // managed_block create attaches its block to the existing file.
  if (candidate.change_kind === "create" && candidate.write_mode === "whole_file" && fileExists) {
    return err(adoptionError("E_CONFLICT", "target_path", "target_exists"));
  }
  if (candidate.expected_file_hash !== null && hashBytes(new TextEncoder().encode(base)) !== candidate.expected_file_hash) {
    return err(adoptionError("E_CONFLICT", "expected_file_hash", "base_changed"));
  }
  return ok({ absolute_path: absolute, bytes: new TextEncoder().encode(base) });
}

/**
 * Applies the proposal patch to the current base. The review store keeps the
 * patch text in the `diff_json.ref` blob; the caller reads it and passes it as
 * `patch`.
 */
export function materializeCandidate(input: {
  readonly candidate: CandidateRow;
  readonly root: ManagedRootRow;
  readonly patch: string;
}): Result<{ absolute_path: string; content: Uint8Array; content_hash: Hash }, ErrorEnvelope> {
  const base = assertContent(input.candidate, input.root);
  if (!base.ok) return base;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  if (input.candidate.write_mode === "managed_block") {
    // Static check applies a managed-block patch to the *block content* and
    // rebuilds the file. Adoption mirrors that: write-apply receives the new
    // block content, never the whole file, so user text outside the markers
    // is untouched.
    const selector = input.candidate.block_selector;
    if (selector === null) {
      return err(adoptionError("E_CONFLICT", "block_selector", "missing"));
    }
    const parsed = parseManagedBlocks(base.value.bytes);
    if (!parsed.ok) return err(parsed.error);
    const block = parsed.value.blocks.find((span) => span.selector === selector) ?? null;
    const blockBase = block === null
      ? ""
      : decoder.decode(base.value.bytes.subarray(block.content_start, block.end_start));
    let appliedText: string;
    if (input.candidate.change_kind === "disable") {
      appliedText = "";
    } else {
      const applied = applyDiff(input.candidate.diff_format, blockBase, input.patch);
      if (!applied.ok) {
        return err(adoptionError("E_CONFLICT", "diff", String(applied.error)));
      }
      appliedText = applied.value;
    }
    const content = encoder.encode(appliedText);
    const contentHash = hashBytes(content);
    if (contentHash !== input.candidate.candidate_hash) {
      return err(adoptionError("E_CONFLICT", "candidate_hash", "materialized_mismatch"));
    }
    return ok({ absolute_path: base.value.absolute_path, content, content_hash: contentHash });
  }
  let text: string;
  if (input.candidate.change_kind === "disable") {
    text = "";
  } else {
    const applied = applyDiff(
      input.candidate.diff_format,
      decoder.decode(base.value.bytes),
      input.patch
    );
    if (!applied.ok) {
      return err(adoptionError("E_CONFLICT", "diff", String(applied.error)));
    }
    text = applied.value;
  }
  if (input.candidate.object_type === "skill" && input.candidate.write_mode === "whole_file") {
    text = withSkillFrontmatter(text, {
      path_or_block: input.candidate.target_path,
      description: input.candidate.skill_description
    });
  }
  const content = encoder.encode(text);
  const contentHash = hashBytes(content);
  if (contentHash !== input.candidate.candidate_file_hash) {
    return err(adoptionError("E_CONFLICT", "candidate_file_hash", "materialized_mismatch"));
  }
  return ok({ absolute_path: base.value.absolute_path, content, content_hash: contentHash });
}

export async function issueAdoptionGrant(input: {
  readonly connection: SqliteConnection;
  readonly candidate: CandidateRow;
  readonly root: ManagedRootRow;
  readonly absolute_path: string;
  readonly proof: HumanDecisionProof;
  readonly policy_version: string;
  readonly now: number;
}): Promise<Result<Id<"grant">, ErrorEnvelope>> {
  // Appendix M.1: the grant names the project the task was bound to. A task
  // without a project uses the reserved `user` scope; an instructions write
  // can never reach here unbound because static check and write-apply reject
  // it, but fail closed instead of minting a user-scope grant.
  const taskRow = input.connection
    .prepare<SqlRow>(
      `SELECT t.project_id AS project_id
         FROM review_jobs j JOIN task t ON t.task_id = j.task_id
        WHERE j.job_id = :job_id`
    )
    .get({ job_id: input.candidate.job_id });
  const taskProject = taskRow?.["project_id"];
  const projectId = typeof taskProject === "string" && taskProject.length > 0
    ? taskProject
    : null;
  if (input.candidate.object_type === "instructions" && projectId === null) {
    return err(adoptionError("E_WRITE_SCOPE_UNRESOLVED", "project_id", "task_project_missing"));
  }
  const request: GrantIssueRequest = {
    schema_version: "rsi.grant_issue/1",
    issued_by: "human",
    human_attestation: {
      // The grant schema's native-user kind is the only allowed native
      // attestation; the evidence blob it references carries
      // `proof_kind=host_native_confirmation` plus the channel binding, so the
      // recorded proof still names how the person confirmed.
      kind: toHumanAttestationKind(input.proof.kind) as never,
      capability_id: input.proof.capability_id,
      evidence_ref: input.proof.evidence_ref as never,
      confirmed_at: input.proof.confirmed_at
    },
    object_type: input.candidate.object_type,
    scope: {
      project_ids: [projectId ?? "user"],
      config_spaces: [input.candidate.config_space],
      path_globs: [input.absolute_path],
      object_ids: []
    },
    actions: [input.candidate.change_kind === "create" ? "create" : input.candidate.change_kind === "disable" ? "disable" : "update"],
    mode: "once",
    candidate_id: input.candidate.candidate_id as Id<"prop">,
    candidate_hash: input.candidate.candidate_hash,
    policy_version: input.policy_version,
    expires_at: input.now + 10 * 60_000
  };
  const validated = validateGrantIssueRequest(request);
  if (!validated.ok) return validated;
  const created = createGrant({
    request,
    grant_id: newId("grant", input.now),
    issued_at: input.now
  });
  if (!created.ok) return created;
  const grant = created.value.grant;
  input.connection
    .prepare(
      `INSERT INTO authorization_grant (
         grant_id, issued_by, human_attestation_json, subject, object_type, scope_json,
         actions_json, mode, candidate_id, candidate_hash, policy_version, issued_at,
         expires_at, revoked_at, grant_hash
       ) VALUES (
         :grant_id, :issued_by, :human_attestation_json, :subject, :object_type, :scope_json,
         :actions_json, :mode, :candidate_id, :candidate_hash, :policy_version, :issued_at,
         :expires_at, NULL, :grant_hash
       )`
    )
    .run({
      grant_id: grant.grant_id,
      issued_by: grant.issued_by,
      human_attestation_json: canonicalJsonText(toJsonValue(grant.human_attestation)),
      subject: grant.subject,
      object_type: grant.object_type,
      scope_json: canonicalJsonText(toJsonValue(grant.scope)),
      actions_json: canonicalJsonText(toJsonValue(grant.actions)),
      mode: grant.mode,
      candidate_id: grant.candidate_id,
      candidate_hash: grant.candidate_hash,
      policy_version: grant.policy_version,
      issued_at: grant.issued_at,
      expires_at: grant.expires_at,
      grant_hash: grant.grant_hash
    });
  return ok(grant.grant_id);
}

export function buildWriteRequest(input: {
  readonly candidate: CandidateRow;
  readonly connection: SqliteConnection;
  readonly grant_id: Id<"grant">;
  readonly root: ManagedRootRow;
  readonly content: Uint8Array;
  readonly content_hash: Hash;
}): Result<JsonValue, ErrorEnvelope> {
  const job = input.connection
    .prepare<SqlRow>(
      "SELECT task_id, branch_id, input_epoch, goal_version, config_version, stable_watermark FROM review_jobs WHERE job_id = :job_id"
    )
    .get({ job_id: input.candidate.job_id });
  if (job === undefined) return err(adoptionError("E_CONFLICT", "job_id", "not_found"));
  const contentText = new TextDecoder().decode(input.content);
  // A new managed block in an existing user file is a `create` proposal with
  // no old hash, but write-apply requires the file hash for every managed
  // block. Pin the base the adoption actually read: no byte can change between
  // this read and the write.
  let baseFileHash: string | null = null;
  if (input.candidate.write_mode === "managed_block" && input.candidate.expected_file_hash === null) {
    try {
      baseFileHash = hashBytes(readFileSync(join(resolveManagedRootPath(input.root), writePathOf(input.candidate))));
    } catch {
      baseFileHash = hashBytes(new Uint8Array(0));
    }
  }
  return ok(toJsonValue({
    schema_version: "rsi.write_apply/1",
    deadline_ms: 30_000,
    grant_id: input.grant_id,
    action: input.candidate.change_kind === "rollback" ? "rollback" : input.candidate.change_kind,
    object_type: input.candidate.object_type,
    candidate_id: input.candidate.candidate_id,
    candidate_hash: input.candidate.candidate_hash,
    binding: {
      task_id: String(job["task_id"]),
      branch_id: String(job["branch_id"]),
      input_epoch: Number(job["input_epoch"]),
      goal_version: String(job["goal_version"]),
      config_version: String(job["config_version"]),
      watermark: Number(job["stable_watermark"])
    },
    scope_ref: { kind: "task", task_id: String(job["task_id"]) },
    root_id: input.root.root_id,
    target_path: writePathOf(input.candidate),
    write_mode: input.candidate.write_mode,
    block_action: input.candidate.write_mode === "managed_block"
      ? input.candidate.change_kind === "create"
        ? "attach"
        : input.candidate.change_kind === "disable" || input.candidate.change_kind === "rollback"
          ? "detach"
          : "update"
      : null,
    block_selector: input.candidate.block_selector,
    expected_file_hash: input.candidate.expected_file_hash ?? baseFileHash,
    expected_block_hash: input.candidate.expected_block_hash,
    new_content: {
      media_type: "text/plain;charset=utf-8",
      encoding: "utf8",
      data: contentText,
      byte_length: input.content.byteLength
    },
    new_content_hash: input.content_hash,
    rollback_of_write_id: null,
    target_snapshot_id: null,
    target_snapshot_hash: null,
    unattended_policy: "auto_allowed"
  }));
}

export function markAdopted(
  connection: SqliteConnection,
  confirmation: ConfirmationRow,
  proofKind: ConfirmationRow["proof_kind"],
  writeId: string,
  now: number
): void {
  connection
    .prepare(
      `UPDATE candidate_confirmation
          SET state = 'adopted', proof_kind = :proof, updated_at = :now
        WHERE candidate_id = :id AND subject_hash = :subject_hash`
    )
    .run({ id: confirmation.candidate_id, proof: proofKind, subject_hash: confirmation.subject_hash, now });
  connection
    .prepare(
      "UPDATE proposals SET state = 'adopted', adoption_ref = :ref, updated_at = :now WHERE proposal_id = :id AND state IN ('checked','proposed')"
    )
    .run({ id: confirmation.proposal_id, ref: writeId, now });
}

export function pendingCandidates(
  connection: SqliteConnection,
  filter: {
    readonly host_id?: string;
    readonly limit?: number;
    readonly now?: number;
    /** Appendix Q.6.4: `candidate.pending_ttl_ms`, default 14 days. */
    readonly pending_ttl_ms?: number;
  } = {}
): readonly CandidateRow[] {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT p.proposal_id, p.created_at AS created_at
         FROM proposals p
         LEFT JOIN candidate_confirmation c ON c.proposal_id = p.proposal_id
        WHERE p.state IN ('checked','proposed')
          AND COALESCE(c.state, 'pending') = 'pending'
          AND COALESCE(c.ask_count, 0) = 0
        ORDER BY COALESCE(c.updated_at, p.created_at) ASC, p.proposal_id ASC
        LIMIT :limit`
    )
    .all({ limit: filter.limit ?? 16 });
  const out: CandidateRow[] = [];
  const now = filter.now ?? Date.now();
  const ttl = filter.pending_ttl_ms ?? 14 * 24 * 60 * 60 * 1_000;
  for (const row of rows) {
    const candidate = readCandidate(connection, String(row["proposal_id"]));
    if (candidate === null) continue;
    if (filter.host_id !== undefined && candidate.host_id !== filter.host_id) continue;
    const createdAt = typeof row["created_at"] === "number" ? row["created_at"] : null;
    if (createdAt !== null && now - createdAt > ttl) {
      connection
        .prepare(
          "UPDATE candidate_confirmation SET state = 'expired', updated_at = :now WHERE proposal_id = :id AND state = 'pending'"
        )
        .run({ id: candidate.proposal_id, now });
      continue;
    }
    // Appendix L.4: a superseded candidate or one whose target no longer
    // matches never reaches the form; it would otherwise starve the queue
    // behind a decision the kernel is going to refuse.
    const staleness = candidateStaleness(connection, candidate);
    if (staleness.stale) {
      markCandidateStale(connection, candidate.candidate_id, staleness.reason, now);
      continue;
    }
    out.push(candidate);
  }
  return out;
}

export interface PendingCandidateInfo {
  readonly candidate_id: string;
  readonly name: string;
  readonly description: string;
  readonly created_at: number;
  readonly state: "pending" | "deferred";
}

/** Q.6.3: `evolve skills pending`, manual decisions included. */
export function listPendingCandidateInfos(
  connection: SqliteConnection,
  now: number,
  pending_ttl_ms: number
): readonly PendingCandidateInfo[] {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT p.proposal_id AS proposal_id, p.created_at AS created_at,
              COALESCE(c.state, 'pending') AS state
         FROM proposals p
         LEFT JOIN candidate_confirmation c ON c.proposal_id = p.proposal_id
        WHERE p.state IN ('checked','proposed')
          AND COALESCE(c.state, 'pending') IN ('pending','deferred')
        ORDER BY p.created_at ASC, p.proposal_id ASC`
    )
    .all({});
  const out: PendingCandidateInfo[] = [];
  for (const row of rows) {
    const id = row["proposal_id"];
    const createdAt = row["created_at"];
    if (typeof id !== "string" || typeof createdAt !== "number") continue;
    if (now - createdAt > pending_ttl_ms) {
      connection
        .prepare(
          "UPDATE candidate_confirmation SET state = 'expired', updated_at = :now WHERE proposal_id = :id AND state IN ('pending','deferred')"
        )
        .run({ id, now });
      continue;
    }
    const candidate = readCandidate(connection, id);
    if (candidate === null) continue;
    const state = row["state"] === "deferred" ? "deferred" : "pending";
    out.push({
      candidate_id: candidate.candidate_id,
      name: candidateSkillName(candidate),
      description: candidate.skill_description ?? "",
      created_at: createdAt,
      state
    });
  }
  return out;
}

/** Q.6.3: `evolve skills ask <id>` schedules one prompt at the next session. */
export function requeueCandidate(
  connection: SqliteConnection,
  candidateId: string,
  now: number
): boolean {
  const result = connection
    .prepare(
      `UPDATE candidate_confirmation
          SET state = 'pending', ask_count = 0, updated_at = :now
        WHERE candidate_id = :id AND state IN ('pending','deferred')`
    )
    .run({ id: candidateId, now });
  return result.changes === 1;
}

export function approveHostRoots(
  connection: SqliteConnection,
  hostId: string,
  now: number
): string[] {
  const rootIds = connection
    .prepare<SqlRow>("SELECT root_id FROM managed_root WHERE host_id = :host_id AND state = 'pending_approval'")
    .all({ host_id: hostId })
    .map((row) => String(row["root_id"]));
  approveManagedRoots(connection, rootIds, now);
  return rootIds;
}

export function modeOf(candidate: CandidateRow): HostMode {
  return candidate.mode as HostMode;
}

/**
 * Native session id that produced the candidate. Resume keeps this id, so the
 * same id means the user is back in the source session and gets the
 * "还没做完 / 内容不对" answers; any other session only sees adopt/reject.
 */
export function candidateSourceNativeSession(
  connection: SqliteConnection,
  proposalId: string
): string | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT s.external_session_id AS native
         FROM proposals p
         JOIN review_jobs rj ON rj.job_id = p.job_id
         JOIN session s ON s.current_branch_id IN (
           SELECT b.branch_id FROM branch b WHERE b.task_id = rj.task_id
         )
        WHERE p.proposal_id = :id AND s.external_session_id IS NOT NULL
        ORDER BY s.last_seen_at DESC
        LIMIT 1`
    )
    .get({ id: proposalId });
  return row === undefined || typeof row["native"] !== "string" ? null : row["native"];
}

/** Display name: generator title, else the skill directory name. */
export function candidateSkillName(candidate: CandidateRow): string {
  if (candidate.skill_title !== null && candidate.skill_title.trim().length > 0) {
    return candidate.skill_title.trim();
  }
  const parts = candidate.target_path.split("/").filter((part) => part.length > 0);
  const marker = parts.indexOf("SKILL.md");
  if (marker > 0) return parts[marker - 1] as string;
  return parts.length === 0 ? candidate.candidate_id : (parts[parts.length - 1] as string);
}

/** Full candidate content: the new body for create, the patch for update. */
export function candidateFullText(
  blob_store: Pick<BlobStore, "read">,
  connection: SqliteConnection,
  candidate: CandidateRow
): string | null {
  return candidate.change_kind === "create"
    ? readCandidateFile(blob_store, connection, candidate.proposal_id)
    : readCandidatePatch(blob_store, candidate.diff_ref);
}

/** Reads the whole candidate file (the SKILL.md body) from its blob. */
export function readCandidateFile(
  blob_store: Pick<BlobStore, "read">,
  connection: SqliteConnection,
  proposalId: string
): string | null {
  const row = connection
    .prepare<SqlRow>("SELECT candidate_ref FROM proposal_candidates WHERE proposal_id = :id ORDER BY ordinal LIMIT 1")
    .get({ id: proposalId });
  const ref = row === undefined || typeof row["candidate_ref"] !== "string" ? null : row["candidate_ref"];
  if (ref === null) return null;
  const match = /^blob:\/\/(?:sha256:)?([0-9a-f]{64})#bytes=(\d+)-(\d+)$/u.exec(ref);
  if (match === null) return null;
  const [, locator, start, end] = match;
  const bytes = blob_store.read(`sha256:${locator}` as Hash);
  if (!bytes.ok) return null;
  const from = Number(start);
  const to = Number(end);
  if (from < 0 || to > bytes.value.byteLength || to < from) return null;
  return new TextDecoder().decode(bytes.value.subarray(from, to));
}

/** Reads the proposal patch text from its blob reference. */
export function readCandidatePatch(
  blob_store: Pick<BlobStore, "read">,
  diff_ref: string
): string | null {
  const match = /^blob:\/\/(?:sha256:)?([0-9a-f]{64})#bytes=(\d+)-(\d+)$/u.exec(diff_ref);
  if (match === null) return null;
  const [, locator, start, end] = match;
  const bytes = blob_store.read(`sha256:${locator}` as Hash);
  if (!bytes.ok) return null;
  const from = Number(start);
  const to = Number(end);
  if (from < 0 || to > bytes.value.byteLength || to < from) return null;
  return new TextDecoder().decode(bytes.value.subarray(from, to));
}

/**
 * Reads the accepted candidate JSON from its content-addressed blob and
 * returns the experience trigger description. The list row stores only the
 * generator envelope, so the description needed for skill frontmatter lives
 * in `candidate_ref`.
 */
export function readCandidateSkillDescription(
  connection: SqliteConnection,
  blobStore: Pick<BlobStore, "read">,
  candidateId: string
): string | null {
  try {
    const row = connection
      .prepare<SqlRow>(
        "SELECT candidate_ref FROM proposal_candidates WHERE proposal_id = :id OR candidate_key = :id LIMIT 1"
      )
      .get({ id: candidateId });
    const ref = row === undefined ? null : row["candidate_ref"];
    if (typeof ref !== "string") return null;
    const match = /^blob:\/\/(?:sha256:)?([0-9a-f]{64})#/u.exec(ref);
    if (match === null) return null;
    const bytes = blobStore.read(`sha256:${match[1]}` as Hash);
    if (!bytes.ok) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes.value)) as unknown;
    const experience =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["experience"]
        : null;
    const trigger =
      typeof experience === "object" && experience !== null && !Array.isArray(experience)
        ? (experience as Record<string, unknown>)["trigger"]
        : null;
    const description =
      typeof trigger === "object" && trigger !== null && !Array.isArray(trigger)
        ? (trigger as Record<string, unknown>)["description"]
        : null;
    return typeof description === "string" && description.trim().length > 0
      ? description
      : null;
  } catch {
    return null;
  }
}

/**
 * Complete positive decision: verify the proof, issue the one-shot grant,
 * materialize the candidate, run `write.apply`, read the file back, and approve
 * the host roots that the same decision authorised.
 */
export async function performAdoption(input: {
  readonly connection: SqliteConnection;
  readonly home: string;
  readonly blob_store: Pick<BlobStore, "putSync" | "read">;
  readonly candidate_id: string;
  readonly proof: HumanDecisionProof;
  readonly verify_proof: (
    attestation: HumanDecisionProof,
    subject_hash: Hash
  ) => Promise<"verified" | "unverified" | "conflict">;
  readonly write_apply: (request: JsonValue, signal: AbortSignal) => Promise<Result<JsonValue, ErrorEnvelope>>;
  readonly policy_version: string;
  readonly now: () => number;
}): Promise<Result<AdoptionResult, ErrorEnvelope>> {
  const candidate = readCandidate(input.connection, input.candidate_id);
  if (candidate === null) return err(adoptionError("E_CONFLICT", "candidate_id", "not_found"));
  const describedCandidate: CandidateRow =
    candidate.object_type === "skill" && candidate.skill_description === null
      ? {
          ...candidate,
          skill_description: readCandidateSkillDescription(
            input.connection,
            input.blob_store,
            candidate.proposal_id
          )
        }
      : candidate;
  // The handoff transition moves a checked proposal to `proposed`; both are
  // adoptable states. Adopting a proposed proposal is the normal closed-loop
  // path, not an illegal transition.
  if (candidate.proposal_state !== "checked" && candidate.proposal_state !== "proposed") {
    return err(adoptionError("E_CONFLICT", "proposal_state", candidate.proposal_state));
  }
  const rootResult = candidateRoot(input.connection, candidate);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value;
  if (root.state !== "approved" && root.state !== "pending_approval") {
    return err(rootError("root_id", "not_approved"));
  }
  const confirmation = ensureConfirmationRow(input.connection, candidate, root, input.now());
  if (!confirmation.ok) return confirmation;
  const row = confirmation.value;
  if (row.state === "adopted") {
    return err(adoptionError("E_CONFLICT", "candidate_id", "already_adopted"));
  }
  if (row.state === "rejected") {
    return err(adoptionError("E_AUTH_DENIED", "candidate_id", "rejected"));
  }
  const verdict = await input.verify_proof(input.proof, row.subject_hash);
  if (verdict !== "verified") {
    return err(adoptionError("E_AUTH_DENIED", "human_attestation", verdict));
  }
  // Appendix L.4: the person answered the prompt, but the bytes they were
  // shown may have moved (or a newer candidate for the same block replaced
  // this one) while the form was open. Re-check by subject before issuing a
  // grant; a stale candidate becomes terminal instead of failing every time
  // it is presented again.
  const staleness = candidateStaleness(input.connection, candidate);
  if (staleness.stale) {
    markCandidateStale(input.connection, candidate.candidate_id, staleness.reason, input.now());
    return err(adoptionError("E_CONFLICT", "candidate_id", `stale_${staleness.reason}`));
  }
  const patch = readCandidatePatch(input.blob_store, candidate.diff_ref);
  if (patch === null) return err(adoptionError("E_CONFLICT", "diff_ref", "unreadable"));
  const materialized = materializeCandidate({ candidate: describedCandidate, root, patch });
  if (!materialized.ok) return materialized;
  const grant = await issueAdoptionGrant({
    connection: input.connection,
    candidate,
    root,
    absolute_path: materialized.value.absolute_path,
    proof: input.proof,
    policy_version: input.policy_version,
    now: input.now()
  });
  if (!grant.ok) return grant;
  const approvedRoots = approveHostRoots(input.connection, candidate.host_id, input.now());
  if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
    process.stderr.write(
      `evoplug kernel: adoption_write root=${root.root_id} state=${root.state} approved=${String(approvedRoots.length)}\n`
    );
  }
  // A created skill lives under a new `evoplug/<name>/` directory. `write.apply`
  // correctly refuses an absent parent; the managed candidate creates exactly
  // that parent inside the approved root before the write.
  try {
    mkdirSync(dirname(materialized.value.absolute_path), { recursive: true, mode: 0o700 });
  } catch {
    return err(adoptionError("E_CONFLICT", "target_path", "mkdir_failed"));
  }
  const request = buildWriteRequest({
    candidate,
    connection: input.connection,
    grant_id: grant.value,
    root,
    content: materialized.value.content,
    content_hash: materialized.value.content_hash
  });
  if (!request.ok) return request;
  const written = await input.write_apply(request.value, new AbortController().signal);
  if (!written.ok) return written;
  const writeId = typeof written.value === "object" && written.value !== null && !Array.isArray(written.value)
    ? String((written.value as Record<string, JsonValue>)["write_id"] ?? "")
    : "";
  markAdopted(
    input.connection,
    row,
    input.proof.kind === "test_backdoor_confirmation" ? "test_backdoor_confirmation" : "host_native_confirmation",
    writeId,
    input.now()
  );
  return ok({
    status: "adopted",
    candidate_id: row.candidate_id,
    subject_hash: row.subject_hash,
    target_path: materialized.value.absolute_path,
    root_id: root.root_id,
    write: written.value,
    attestation: input.proof.kind === "test_backdoor_confirmation" ? "test_backdoor" : "host_native",
    approved_root_ids: approvedRoots
  });
}
