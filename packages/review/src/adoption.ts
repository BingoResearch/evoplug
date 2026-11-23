/**
 * T7 adoption admission and AdoptionBinding construction (DD-REV-110,
 * DD-REV-140, DD-REV-130).
 *
 * The only admission source is the FND synchronous `WriteAdoptionView` read
 * inside the same transaction. REV never infers success from file existence
 * and never builds a second grant or write ledger.
 */

import type { ErrorEnvelope, Result, SourceRef } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { proposalAdoptionMismatch, revError, versionBindingError } from "./errors.js";
import { adoptionBindingHash } from "./experience.js";
import type { WriteAdoptionView } from "./host-contracts.js";
import type { AdoptionBinding, Proposal } from "./types.js";

interface AdoptionCheckInput {
  proposal: Proposal;
  view: WriteAdoptionView;
  grant_id: string;
  snapshot_binding: import("@evoplug/core").VersionBinding;
}

/** Field-by-field T7 check; the first mismatch is the only error returned. */
export function validateAdoptionView(input: AdoptionCheckInput): Result<WriteAdoptionView, ErrorEnvelope> {
  const { proposal, view } = input;
  if (view.grant.grant_id !== input.grant_id || view.intent.grant_id !== input.grant_id) {
    return err(
      revError({
        code: "E_AUTH_DENIED",
        stage: "adoption",
        details: { kind: "authorization", object_type: proposal.target.object_type, denied_dimension: "object" }
      })
    );
  }
  if (view.result.state !== "verified" || !view.result.readback_verified) {
    return err(
      revError({
        code: "E_WRITE_STATE",
        stage: "adoption",
        details: { kind: "field", path: "result.state", rule: view.result.state }
      })
    );
  }
  if (view.intent.candidate_id !== proposal.proposal_id) {
    return err(
      revError({
        code: "E_PROPOSAL_ADOPTION_MISMATCH",
        stage: "adoption",
        details: { kind: "field", path: "intent.candidate_id", rule: proposal.proposal_id }
      })
    );
  }
  if (view.intent.candidate_hash !== proposal.candidate_hash) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.expected_file_hash !== proposal.expected_file_hash) {
    return err(proposalAdoptionMismatch(proposal.expected_file_hash ?? proposal.candidate_file_hash, view.intent.expected_file_hash ?? view.intent.candidate_hash));
  }
  if (view.intent.expected_block_hash !== proposal.expected_block_hash) {
    return err(
      proposalAdoptionMismatch(
        proposal.expected_block_hash ?? proposal.candidate_file_hash,
        view.intent.expected_block_hash ?? view.intent.candidate_hash
      )
    );
  }
  if (view.intent.write_mode !== proposal.target.write_mode) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.target_path !== proposal.target.path_or_block) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.approved_root !== proposal.target.approved_root) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.object_type !== proposal.target.object_type) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.action !== proposal.change_kind) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.config_space_id !== proposal.target.config_space) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.target_ownership !== proposal.target.ownership) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.intent.block_selector !== proposal.target.block_selector) {
    return err(proposalAdoptionMismatch(proposal.candidate_hash, view.intent.candidate_hash));
  }
  if (view.result.path !== view.intent.target_path) {
    return err(proposalAdoptionMismatch(proposal.candidate_file_hash, view.result.new_file_hash));
  }
  if (view.result.new_file_hash !== proposal.candidate_file_hash) {
    return err(proposalAdoptionMismatch(proposal.candidate_file_hash, view.result.new_file_hash));
  }
  if (
    proposal.target.write_mode === "managed_block" &&
    view.result.new_block_hash !== proposal.candidate_block_hash
  ) {
    return err(
      proposalAdoptionMismatch(
        proposal.candidate_block_hash ?? proposal.candidate_file_hash,
        view.result.new_block_hash ?? view.result.new_file_hash
      )
    );
  }
  const expected = input.snapshot_binding;
  const actual = view.intent.binding;
  if (
    actual.task_id !== expected.task_id ||
    actual.branch_id !== expected.branch_id ||
    actual.input_epoch !== expected.input_epoch ||
    actual.goal_version !== expected.goal_version ||
    actual.config_version !== expected.config_version ||
    actual.watermark !== expected.watermark
  ) {
    return err(versionBindingError("binding", "proposal_snapshot"));
  }
  if (
    !view.grant.actions.includes(proposal.change_kind) ||
    view.grant.object_type !== proposal.target.object_type ||
    (view.grant.candidate_id !== undefined && view.grant.candidate_id !== proposal.proposal_id) ||
    (view.grant.candidate_hash !== undefined && view.grant.candidate_hash !== proposal.candidate_hash)
  ) {
    return err(
      revError({
        code: "E_AUTH_DENIED",
        stage: "adoption",
        details: { kind: "authorization", object_type: proposal.target.object_type, denied_dimension: "action" }
      })
    );
  }
  const scopeDenied = grantScopeDenied(input.proposal, view);
  if (scopeDenied !== null) {
    return err(
      revError({
        code: "E_AUTH_DENIED",
        stage: "adoption",
        details: {
          kind: "authorization",
          object_type: proposal.target.object_type,
          denied_dimension: scopeDenied
        }
      })
    );
  }
  return ok(view);
}

/**
 * Matches a POSIX glob (`*` per segment, `**` across segments) without pulling
 * the auth package in. FND grant scopes carry absolute `path_globs`, while a
 * proposal stores the target relative to `approved_root`, so the comparison is
 * always against the absolute path.
 */
function matchGlobSegments(
  pattern: readonly string[],
  segments: readonly string[],
  patternIndex: number,
  segmentIndex: number
): boolean {
  if (patternIndex === pattern.length) return segmentIndex === segments.length;
  const token = pattern[patternIndex];
  if (token === "**") {
    for (let next = segmentIndex; next <= segments.length; next += 1) {
      if (matchGlobSegments(pattern, segments, patternIndex + 1, next)) return true;
    }
    return false;
  }
  if (segmentIndex === segments.length) return false;
  const value = segments[segmentIndex] ?? "";
  if (token === "*") {
    return value.length > 0 && matchGlobSegments(pattern, segments, patternIndex + 1, segmentIndex + 1);
  }
  return token === value && matchGlobSegments(pattern, segments, patternIndex + 1, segmentIndex + 1);
}

function globCoversPath(glob: string, target: string): boolean {
  if (!glob.startsWith("/") || !target.startsWith("/")) return false;
  return matchGlobSegments(glob.slice(1).split("/"), target.slice(1).split("/"), 0, 0);
}

function scopeCoversPath(paths: readonly string[], target: string, approvedRoot: string): boolean {
  const root = approvedRoot.endsWith("/") ? approvedRoot.slice(0, -1) : approvedRoot;
  const absolute = target.startsWith("/") ? target : `${root}/${target.replace(/^\/+/, "")}`;
  return paths.some(
    (scopePath) =>
      globCoversPath(scopePath, absolute) ||
      absolute === scopePath ||
      absolute.startsWith(scopePath.endsWith("/") ? scopePath : `${scopePath}/`)
  );
}

/** DD-REV-110 grant scope: every present axis must authorize this write. */
function grantScopeDenied(
  proposal: Proposal,
  view: WriteAdoptionView
): "object" | "path" | "config_space" | "expiry" | null {
  const scope = view.grant.scope;
  if (scope.host_ids !== undefined) {
    if (scope.host_ids.length === 0 || !scope.host_ids.includes(proposal.target.host_id)) {
      return "object";
    }
  }
  if (scope.paths !== undefined) {
    if (
      scope.paths.length === 0 ||
      !scopeCoversPath(
        scope.paths,
        proposal.target.path_or_block,
        proposal.target.approved_root
      )
    ) {
      return "path";
    }
  }
  if (scope.config_spaces !== undefined) {
    if (
      scope.config_spaces.length === 0 ||
      !scope.config_spaces.includes(proposal.target.config_space)
    ) {
      return "config_space";
    }
  }
  if (scope.block_ids !== undefined) {
    const selector = proposal.target.block_selector;
    if (selector === null || scope.block_ids.length === 0 || !scope.block_ids.includes(selector)) {
      return "object";
    }
  }
  if (scope.object_ids !== undefined && scope.object_ids.length > 0) {
    /* An empty `object_ids` is the FND "every object of this type" scope. */
    if (!scope.object_ids.includes(proposal.proposal_id)) {
      return "object";
    }
  }
  return null;
}

interface BuildAdoptionBindingInput {
  proposal: Proposal;
  view: WriteAdoptionView;
  write_result_ref: SourceRef;
  now: number;
}

export function buildAdoptionBinding(input: BuildAdoptionBindingInput): AdoptionBinding {
  const binding: Omit<AdoptionBinding, "adopted_at" | "binding_hash"> = {
    schema_version: "rsi.experience_adoption_binding/1",
    write_id: input.view.intent.write_id,
    write_attempt: input.view.result.attempt,
    write_result_ref: input.write_result_ref,
    grant_id: input.view.grant.grant_id,
    grant_hash: input.view.grant.grant_hash,
    proposal_id: input.view.intent.candidate_id,
    proposal_hash: input.proposal.proposal_hash,
    candidate_hash: input.proposal.candidate_hash,
    target: {
      host_id: input.proposal.target.host_id,
      config_space: input.proposal.target.config_space,
      mode: input.proposal.target.mode,
      object_type: input.proposal.target.object_type,
      path_or_block: input.proposal.target.path_or_block,
      block_id: input.proposal.target.block_id ?? null,
      ownership: input.proposal.target.ownership,
      write_mode: input.proposal.target.write_mode,
      approved_root: input.proposal.target.approved_root,
      target_binding_ref: input.proposal.target.target_binding_ref
    },
    version_binding: input.view.intent.binding
  };
  return {
    ...binding,
    adopted_at: input.now,
    binding_hash: adoptionBindingHash(binding)
  };
}

