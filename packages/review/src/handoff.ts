/**
 * ReviewHandoff construction, hash projection and the QP close read port
 * (DD-REV-071).
 *
 * The handoff hash excludes instance identifiers through one fixed projection.
 * The close port reads only persisted rows and never accepts caller-supplied
 * outcome, decision or hash.
 */

import { canonicalHash, compareUtf8, toJsonValue } from "@evoplug/core";
import type { ErrorEnvelope, Hash, JsonValue, Result, SourceRef, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import {
  handoffConflict,
  handoffIncomplete,
  handoffNotReady,
  handoffPayloadInvalid,
  handoffProposalMismatch,
  schemaError
} from "./errors.js";
import { autoAdoptEligible, handoffDecision, judgeBindingFromProposal } from "./match-judge.js";
import type {
  MatchJudgeStatus,
  Proposal,
  ProposalMatchJudge,
  ReviewHandoff,
  ReviewHandoffClosePayload,
  ReviewHandoffCloseView,
  ReviewHandoffProposal,
  ReviewHandoffStageResult,
  ReviewJob,
  ReviewJobResult,
  ReviewJobState,
  ReviewSnapshot
} from "./types.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

export const HANDOFF_STAGES: readonly ReviewHandoffStageResult["stage"][] = [
  "snapshot",
  "generate",
  "static_check",
  "experience_match_judge",
  "handoff"
];

/* ------------------------------------------------------------------ */
/* Hash projection                                                     */
/* ------------------------------------------------------------------ */

interface HandoffBody {
  job_id: string;
  snapshot_id: string;
  snapshot_hash: Hash;
  policy_version: string;
  stage_results: ReviewHandoffStageResult[];
  proposals: ReviewHandoffProposal[];
  job_result: ReviewJobResult;
}

export function handoffBody(handoff: ReviewHandoff): HandoffBody {
  return {
    job_id: handoff.job_id,
    snapshot_id: handoff.snapshot_id,
    snapshot_hash: handoff.snapshot_hash,
    policy_version: handoff.policy_version,
    stage_results: handoff.stage_results.map((stage) => ({ ...stage })),
    proposals: handoff.proposals.map((proposal) => copyHandoffProposal(proposal)),
    job_result: handoff.job_result
  };
}

function copyHandoffProposal(proposal: ReviewHandoffProposal): ReviewHandoffProposal {
  const copy: ReviewHandoffProposal = {
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    question_key: proposal.question_key,
    route_id: proposal.route_id,
    route_hash: proposal.route_hash,
    route_class: proposal.route_class,
    candidate_hash: proposal.candidate_hash,
    candidate_file_hash: proposal.candidate_file_hash,
    candidate_block_hash: proposal.candidate_block_hash,
    experience_id: proposal.experience_id,
    experience_version: proposal.experience_version,
    experience_content_hash: proposal.experience_content_hash,
    validation_plan_hash: proposal.validation_plan_hash,
    decision: proposal.decision,
    auto_adopt_eligible: proposal.auto_adopt_eligible,
    risk: proposal.risk,
    scope_level: proposal.scope_level,
    no_verifier: proposal.no_verifier,
    verifier: { ...proposal.verifier }
  };
  if (proposal.reason_code !== undefined) copy.reason_code = proposal.reason_code;
  if (proposal.egress_decision_ref !== undefined) copy.egress_decision_ref = proposal.egress_decision_ref;
  if (proposal.judge !== undefined) copy.judge = { ...proposal.judge };
  return copy;
}

/** Removes instance IDs and `route_id`; keys are deleted, never nulled. */
export function handoffHashProjection(body: HandoffBody): JsonValue {
  const proposals: JsonValue[] = body.proposals.map((proposal) => {
    const projected: { [key: string]: JsonValue } = {
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      question_key: proposal.question_key,
      route_hash: proposal.route_hash,
      route_class: proposal.route_class,
      candidate_hash: proposal.candidate_hash,
      candidate_file_hash: proposal.candidate_file_hash,
      candidate_block_hash: proposal.candidate_block_hash,
      experience_id: proposal.experience_id,
      experience_version: proposal.experience_version,
      experience_content_hash: proposal.experience_content_hash,
      validation_plan_hash: proposal.validation_plan_hash,
      decision: proposal.decision,
      reason_code: proposal.reason_code ?? null,
      auto_adopt_eligible: proposal.auto_adopt_eligible,
      risk: proposal.risk,
      scope_level: proposal.scope_level,
      no_verifier: proposal.no_verifier,
      verifier: toJsonValue({
        kind: proposal.verifier.kind,
        independence: proposal.verifier.independence,
        binding_ref: proposal.verifier.binding_ref ?? null
      }),
      egress_decision_ref: proposal.egress_decision_ref ?? null
    };
    if (proposal.judge === undefined) {
      projected["judge"] = null;
    } else {
      const judge = proposal.judge;
      const judgeProjection: { [key: string]: JsonValue } = {
        plan_hash: judge.plan_hash,
        template_id: judge.template_id,
        template_version: judge.template_version,
        template_hash: judge.template_hash,
        validator_version: judge.validator_version ?? null,
        validator_binding_key: judge.validator_binding_key ?? null,
        question_bindings_digest: judge.question_bindings_digest ?? null,
        envelope_key: judge.envelope_key ?? null,
        request_hash: judge.request_hash ?? null,
        dispatch_key: judge.dispatch_key ?? null,
        match_outcome: judge.match_outcome ?? null,
        egress_decision_ref: judge.egress_decision_ref ?? null
      };
      projected["judge"] = toJsonValue(judgeProjection);
    }
    for (const [key, value] of Object.entries(projected)) {
      if (value === undefined) {
        delete projected[key];
      }
    }
    return toJsonValue(projected);
  });
  return toJsonValue({
    job_id: body.job_id,
    snapshot_id: body.snapshot_id,
    snapshot_hash: body.snapshot_hash,
    policy_version: body.policy_version,
    stage_results: body.stage_results,
    proposals,
    job_result: body.job_result
  });
}

export function handoffHash(body: HandoffBody): Hash {
  return canonicalHash(handoffHashProjection(body));
}

/* ------------------------------------------------------------------ */
/* Payload schema gate                                                 */
/* ------------------------------------------------------------------ */

const HASH_TEXT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROUTE_ID_PATTERN = /^route:[0-9a-f]{64}$/;

const HANDOFF_KEYS: readonly string[] = [
  "schema_version",
  "handoff_id",
  "job_id",
  "snapshot_id",
  "snapshot_hash",
  "policy_version",
  "stage_results",
  "proposals",
  "job_result",
  "handoff_hash",
  "created_at"
];

const HANDOFF_PROPOSAL_KEYS: readonly string[] = [
  "proposal_id",
  "proposal_hash",
  "question_key",
  "route_id",
  "route_hash",
  "route_class",
  "candidate_hash",
  "candidate_file_hash",
  "candidate_block_hash",
  "experience_id",
  "experience_version",
  "experience_content_hash",
  "validation_plan_hash",
  "decision",
  "reason_code",
  "auto_adopt_eligible",
  "risk",
  "scope_level",
  "no_verifier",
  "verifier",
  "egress_decision_ref",
  "judge"
];

const HANDOFF_JUDGE_KEYS: readonly string[] = [
  "issue_id",
  "plan_id",
  "plan_hash",
  "service_profile_id",
  "validator_binding_id",
  "validator_binding_key",
  "question_bindings_digest",
  "binding_id",
  "template_id",
  "template_version",
  "template_hash",
  "invocation_id",
  "attempt_id",
  "envelope_id",
  "envelope_key",
  "request_hash",
  "dispatch_key",
  "validator_version",
  "match_outcome",
  "egress_decision_ref"
];

const RISK_VALUES: readonly string[] = ["low", "medium", "high"];
const SCOPE_LEVELS: readonly string[] = ["project", "user", "host", "global"];
const VERIFIER_KINDS: readonly string[] = [
  "test_pass",
  "artifact_check",
  "state_predicate",
  "human_acceptance",
  "external_verification",
  "none"
];
const VERIFIER_INDEPENDENCE: readonly string[] = [
  "independent",
  "same_task_replay",
  "user_confirmation",
  "none"
];
const MATCH_OUTCOMES: readonly string[] = ["applicable", "conflict", "unknown", "not_applicable"];
const JOB_RESULTS: readonly string[] = ["proposed", "no_candidate", "all_rejected", "all_stale"];
const STAGE_STATUSES: readonly string[] = ["ok", "degraded", "failed", "skipped"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHashText(value: unknown): value is string {
  return typeof value === "string" && HASH_TEXT_PATTERN.test(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function optionalHash(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isHashText(record[key]);
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isNonEmptyString(record[key]);
}

function optionalSourceRef(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isNonEmptyString(record[key]);
}

function validVerifier(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["kind", "independence", "binding_ref"])) {
    return false;
  }
  const kind = value["kind"];
  const independence = value["independence"];
  return (
    typeof kind === "string" &&
    VERIFIER_KINDS.includes(kind) &&
    typeof independence === "string" &&
    VERIFIER_INDEPENDENCE.includes(independence) &&
    optionalSourceRef(value, "binding_ref")
  );
}

function validJudge(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, HANDOFF_JUDGE_KEYS)) {
    return false;
  }
  if (
    !isNonEmptyString(value["issue_id"]) ||
    !isNonEmptyString(value["plan_id"]) ||
    !isHashText(value["plan_hash"]) ||
    !isNonEmptyString(value["service_profile_id"]) ||
    !isNonEmptyString(value["validator_binding_id"]) ||
    value["template_id"] !== "qt.experience_match" ||
    value["template_version"] !== "1.0.0" ||
    !isHashText(value["template_hash"])
  ) {
    return false;
  }
  for (const key of [
    "validator_binding_key",
    "question_bindings_digest",
    "envelope_key",
    "request_hash",
    "dispatch_key"
  ]) {
    if (!optionalHash(value, key)) {
      return false;
    }
  }
  for (const key of [
    "binding_id",
    "invocation_id",
    "attempt_id",
    "envelope_id",
    "validator_version"
  ]) {
    if (!optionalString(value, key)) {
      return false;
    }
  }
  if (!optionalSourceRef(value, "egress_decision_ref")) {
    return false;
  }
  const outcome = value["match_outcome"];
  return outcome === undefined || (typeof outcome === "string" && MATCH_OUTCOMES.includes(outcome));
}

function validHandoffProposal(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, HANDOFF_PROPOSAL_KEYS)) {
    return false;
  }
  if (
    !isNonEmptyString(value["proposal_id"]) ||
    !isHashText(value["proposal_hash"]) ||
    !isHashText(value["candidate_hash"]) ||
    !isHashText(value["candidate_file_hash"]) ||
    !isHashText(value["experience_content_hash"]) ||
    !isHashText(value["validation_plan_hash"]) ||
    !isNonEmptyString(value["experience_id"]) ||
    typeof value["experience_version"] !== "number" ||
    !Number.isSafeInteger(value["experience_version"]) ||
    (value["decision"] !== "proceed" && value["decision"] !== "unverified") ||
    typeof value["auto_adopt_eligible"] !== "boolean" ||
    typeof value["no_verifier"] !== "boolean"
  ) {
    return false;
  }
  const risk = value["risk"];
  if (typeof risk !== "string" || !RISK_VALUES.includes(risk)) {
    return false;
  }
  const scopeLevel = value["scope_level"];
  if (typeof scopeLevel !== "string" || !SCOPE_LEVELS.includes(scopeLevel)) {
    return false;
  }
  if (value["candidate_block_hash"] !== null && !isHashText(value["candidate_block_hash"])) {
    return false;
  }
  if (value["question_key"] !== null && !isNonEmptyString(value["question_key"])) {
    return false;
  }
  if (!optionalString(value, "reason_code") || !optionalSourceRef(value, "egress_decision_ref")) {
    return false;
  }
  if (!validVerifier(value["verifier"])) {
    return false;
  }
  if (value["judge"] !== undefined && !validJudge(value["judge"])) {
    return false;
  }
  const routeId = value["route_id"];
  const routeHash = value["route_hash"];
  const routeClass = value["route_class"];
  const routeNull = routeId === null && routeHash === null && routeClass === null;
  if (routeNull) {
    return true;
  }
  // A non-empty route triple must carry the only legal route class and a
  // well-formed instance route reference (QP route shape).
  return (
    typeof routeId === "string" &&
    ROUTE_ID_PATTERN.test(routeId) &&
    isHashText(routeHash) &&
    routeClass === "experience_match"
  );
}

function validStageResults(value: unknown): value is ReviewHandoffStageResult[] {
  if (!Array.isArray(value) || value.length !== HANDOFF_STAGES.length) {
    return false;
  }
  return HANDOFF_STAGES.every((stage, index) => {
    const entry: unknown = value[index];
    if (!isRecord(entry) || entry["stage"] !== stage) {
      return false;
    }
    if (!hasOnlyKeys(entry, ["stage", "status", "reason_code", "detail_ref"])) {
      return false;
    }
    const status = entry["status"];
    return (
      typeof status === "string" &&
      STAGE_STATUSES.includes(status) &&
      optionalString(entry, "reason_code") &&
      optionalSourceRef(entry, "detail_ref")
    );
  });
}

/**
 * Strict payload schema gate (DD-REV-071). Returns `false` when the persisted
 * handoff body is not the closed `rsi.review_handoff/2` shape, when a route
 * triple is incomplete or carries an illegal `route_class`, or when
 * `handoff_hash` does not match the stable projection. It never mutates or
 * repairs the payload.
 */
export function validateHandoffPayload(value: unknown): boolean {
  return isReviewHandoff(value) && handoffHash(handoffBody(value)) === value.handoff_hash;
}

function isReviewHandoff(value: unknown): value is ReviewHandoff {
  if (!isRecord(value) || !hasOnlyKeys(value, HANDOFF_KEYS)) {
    return false;
  }
  if (
    value["schema_version"] !== "rsi.review_handoff/2" ||
    !isNonEmptyString(value["handoff_id"]) ||
    !isNonEmptyString(value["job_id"]) ||
    !isNonEmptyString(value["snapshot_id"]) ||
    !isHashText(value["snapshot_hash"]) ||
    !isNonEmptyString(value["policy_version"]) ||
    !isHashText(value["handoff_hash"]) ||
    typeof value["created_at"] !== "number" ||
    !Number.isSafeInteger(value["created_at"])
  ) {
    return false;
  }
  const jobResult = value["job_result"];
  if (typeof jobResult !== "string" || !JOB_RESULTS.includes(jobResult)) {
    return false;
  }
  if (!validStageResults(value["stage_results"])) {
    return false;
  }
  const proposals = value["proposals"];
  if (!Array.isArray(proposals)) {
    return false;
  }
  const ids: string[] = [];
  for (const entry of proposals) {
    if (!validHandoffProposal(entry)) {
      return false;
    }
    if (!isRecord(entry) || !isNonEmptyString(entry["proposal_id"])) {
      return false;
    }
    ids.push(entry["proposal_id"]);
  }
  const sorted = [...ids].sort(compareUtf8);
  return ids.every((id, index) => id === sorted[index]);
}

/** Alias kept for callers that name the gate after the schema artifact. */
export function validateHandoffSchema(value: unknown): boolean {
  return validateHandoffPayload(value);
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

interface BuildHandoffInput {
  handoff_id: string;
  job: ReviewJob;
  snapshot: ReviewSnapshot;
  proposals: Proposal[];
  stage_results: ReviewHandoffStageResult[];
  job_result: ReviewJobResult;
  auto_adopt: ReadonlyMap<string, boolean>;
  grant_valid: ReadonlyMap<string, boolean>;
  created_at: number;
}

export function buildHandoff(input: BuildHandoffInput): Result<ReviewHandoff, ErrorEnvelope> {
  if (input.stage_results.length !== HANDOFF_STAGES.length) {
    return err(handoffIncomplete("stage_results", "five_stages"));
  }
  for (let index = 0; index < HANDOFF_STAGES.length; index += 1) {
    const stage = input.stage_results[index];
    if (stage === undefined || stage.stage !== HANDOFF_STAGES[index]) {
      return err(handoffIncomplete("stage_results", "fixed_order"));
    }
  }
  const proposals = [...input.proposals]
    .filter((proposal) => proposal.state !== "stale")
    .sort((left, right) => compareUtf8(left.proposal_id, right.proposal_id));
  const handoffProposals: ReviewHandoffProposal[] = proposals.map((proposal) => {
    const decision = handoffDecision(proposal.match_judge.status);
    const judge = judgeBindingFromProposal(proposal);
    const eligible = autoAdoptEligible({
      proposal,
      decision,
      grant_valid: input.grant_valid.get(proposal.proposal_id) ?? false
    });
    return {
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      question_key: proposal.question_key,
      route_id: proposal.match_judge.route_id,
      route_hash: proposal.match_judge.route_hash,
      route_class: proposal.match_judge.route_class,
      candidate_hash: proposal.candidate_hash,
      candidate_file_hash: proposal.candidate_file_hash,
      candidate_block_hash: proposal.candidate_block_hash,
      experience_id: proposal.experience.experience_id,
      experience_version: proposal.experience.version,
      experience_content_hash: proposal.experience.content_hash,
      validation_plan_hash: proposal.experience.validation_plan_hash,
      decision,
      auto_adopt_eligible: eligible,
      risk: proposal.experience.risk,
      scope_level: proposal.experience.scope.level,
      no_verifier: proposal.experience.no_verifier,
      verifier: { ...proposal.experience.verifier },
      ...(proposal.match_judge.status === "degraded" && judge === undefined
        ? { reason_code: "degraded" }
        : {}),
      ...(proposal.egress_decision_ref === undefined
        ? {}
        : { egress_decision_ref: proposal.egress_decision_ref }),
      ...(judge === undefined ? {} : { judge })
    };
  });
  const body: HandoffBody = {
    job_id: input.job.job_id,
    snapshot_id: input.snapshot.snapshot_id,
    snapshot_hash: input.snapshot.snapshot_hash,
    policy_version: input.snapshot.policy_version,
    stage_results: input.stage_results.map((stage) => ({ ...stage })),
    proposals: handoffProposals,
    job_result: input.job_result
  };
  return ok({
    schema_version: "rsi.review_handoff/2",
    handoff_id: input.handoff_id,
    job_id: body.job_id,
    snapshot_id: body.snapshot_id,
    snapshot_hash: body.snapshot_hash,
    policy_version: body.policy_version,
    stage_results: body.stage_results,
    proposals: body.proposals,
    job_result: body.job_result,
    handoff_hash: handoffHash(body),
    created_at: input.created_at
  });
}

export function stageResultForJudge(status: MatchJudgeStatus): ReviewHandoffStageResult["status"] {
  switch (status) {
    case "not_required":
      return "skipped";
    case "reused":
      return "skipped";
    case "degraded":
      return "degraded";
    case "accepted":
      return "ok";
    case "rejected":
    case "unknown":
      return "failed";
    case "pending":
      return "failed";
  }
}

export function stageResults(input: {
  snapshot: ReviewHandoffStageResult["status"];
  generate: ReviewHandoffStageResult["status"];
  static_check: ReviewHandoffStageResult["status"];
  judge: MatchJudgeStatus;
  handoff: ReviewHandoffStageResult["status"];
  reasons?: Partial<Record<ReviewHandoffStageResult["stage"], string>>;
}): ReviewHandoffStageResult[] {
  const reasons = input.reasons ?? {};
  return HANDOFF_STAGES.map((stage) => {
    const status =
      stage === "snapshot"
        ? input.snapshot
        : stage === "generate"
          ? input.generate
          : stage === "static_check"
            ? input.static_check
            : stage === "experience_match_judge"
              ? stageResultForJudge(input.judge)
              : input.handoff;
    const result: ReviewHandoffStageResult = { stage, status };
    const reason = reasons[stage];
    if (reason !== undefined) {
      result.reason_code = reason;
    }
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Handoff validation                                                  */
/* ------------------------------------------------------------------ */

export function validateHandoff(
  handoff: ReviewHandoff,
  proposals: ReadonlyMap<string, Proposal>
): Result<ReviewHandoff, ErrorEnvelope> {
  if (handoff.schema_version !== "rsi.review_handoff/2") {
    return err(handoffPayloadInvalid("schema_version", "const"));
  }
  if (handoff.stage_results.length !== HANDOFF_STAGES.length) {
    return err(handoffIncomplete("stage_results", "five_stages"));
  }
  for (let index = 0; index < HANDOFF_STAGES.length; index += 1) {
    if (handoff.stage_results[index]?.stage !== HANDOFF_STAGES[index]) {
      return err(handoffIncomplete("stage_results", "fixed_order"));
    }
  }
  const ids = handoff.proposals.map((proposal) => proposal.proposal_id);
  const sorted = [...ids].sort(compareUtf8);
  if (ids.length !== sorted.length || ids.some((id, index) => id !== sorted[index])) {
    return err(handoffIncomplete("proposals", "proposal_id_utf8_order"));
  }
  for (const entry of handoff.proposals) {
    const proposal = proposals.get(entry.proposal_id);
    if (proposal === undefined) {
      return err(handoffProposalMismatch("proposals", "proposal_missing"));
    }
    if (proposal.proposal_hash !== entry.proposal_hash) {
      return err(handoffProposalMismatch("proposals", "proposal_hash"));
    }
    if (proposal.match_judge.status === "pending") {
      return err(handoffNotReady("proposals", "judge_pending"));
    }
    if (entry.decision !== handoffDecision(proposal.match_judge.status)) {
      return err(handoffIncomplete("proposals.decision", "status_mapping"));
    }
    const notRequired = proposal.match_judge.status === "not_required";
    const reused = proposal.match_judge.status === "reused";
    if (notRequired && entry.question_key !== null) {
      return err(handoffIncomplete("proposals.question_key", "not_required_null"));
    }
    if (notRequired && (entry.route_id === null || entry.route_hash === null || entry.route_class === null)) {
      return err(handoffIncomplete("proposals.route", "not_required_route"));
    }
    if (reused) {
      if (entry.question_key !== null) {
        return err(handoffIncomplete("proposals.question_key", "reused_null"));
      }
      if (entry.route_id === null || entry.route_hash === null || entry.route_class === null) {
        return err(handoffIncomplete("proposals.route", "reused_route"));
      }
      if (entry.judge !== undefined) {
        return err(handoffIncomplete("proposals.judge", "reused_no_judge"));
      }
    }
    if (proposal.match_judge.status === "degraded" && entry.judge !== undefined) {
      if (
        entry.route_id === null ||
        entry.route_hash === null ||
        entry.route_class === null ||
        entry.judge.issue_id.length === 0 ||
        entry.judge.plan_id.length === 0 ||
        entry.question_key === null
      ) {
        return err(handoffIncomplete("proposals.judge", "degraded_binding"));
      }
    }
  }
  const expected = handoffHash(handoffBody(handoff));
  if (expected !== handoff.handoff_hash) {
    return err(handoffConflict(handoff.handoff_hash, expected));
  }
  return ok(handoff);
}

/* ------------------------------------------------------------------ */
/* Close read port                                                     */
/* ------------------------------------------------------------------ */

export interface HandoffCloseRepository {
  loadHandoff(handoffId: string): {
    handoff: ReviewHandoff;
    body_blob: SourceRef;
  } | null;
  loadJob(jobId: string): {
    state: ReviewJobState;
    snapshot_id: string;
    terminal_at: number | null;
  } | null;
  loadSnapshot(snapshotId: string): {
    snapshot_hash: Hash;
    version_binding: VersionBinding;
    issues: Array<{ issue_id: string }>;
  } | null;
  loadProposal(proposalId: string): Proposal | null;
  loadStaleProposalIssueIds(jobId: string): string[];
}

export interface ReviewHandoffReadPort {
  getHandoffCloseView(input: {
    handoff_id: string;
    issue_id: string;
  }): Promise<Result<ReviewHandoffCloseView, ErrorEnvelope>>;
}

const CLOSE_INPUT_KEYS = ["handoff_id", "issue_id"] as const;

function validateCloseInput(input: unknown): Result<{ handoff_id: string; issue_id: string }, ErrorEnvelope> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(schemaError("$", "object"));
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CLOSE_INPUT_KEYS.includes(key as (typeof CLOSE_INPUT_KEYS)[number])) {
      return err(schemaError(key, "known_field"));
    }
  }
  const handoffId = record["handoff_id"];
  const issueId = record["issue_id"];
  if (typeof handoffId !== "string" || handoffId.length === 0) {
    return err(schemaError("handoff_id", "non_empty_string"));
  }
  if (typeof issueId !== "string" || issueId.length === 0) {
    return err(schemaError("issue_id", "non_empty_string"));
  }
  return ok({ handoff_id: handoffId, issue_id: issueId });
}

function pendingCloseView(handoffId: string, issueId: string): ReviewHandoffCloseView {
  return {
    handoff_id: handoffId,
    issue_id: issueId,
    job_state: "pending",
    job_result: null,
    binding: null,
    snapshot_id: null,
    snapshot_hash: null,
    proposal_id: null,
    proposal_hash: null,
    plan_id: null,
    plan_hash: null,
    question_key: null,
    decision: null,
    review_match_outcome: null,
    source_refs: [],
    recorded_at_watermark: null,
    close_payload: null,
    close_payload_hash: null
  };
}

function buildClosePayload(input: {
  handoff: ReviewHandoff;
  proposal: Proposal;
  questionKey: string;
  matchOutcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  decision: "proceed" | "unverified";
}): ReviewHandoffClosePayload | null {
  const judge = input.proposal.match_judge;
  if (judge.plan_id === undefined || judge.plan_hash === undefined) {
    return null;
  }
  return {
    handoff_id: input.handoff.handoff_id,
    handoff_hash: input.handoff.handoff_hash,
    proposal_id: input.proposal.proposal_id,
    proposal_hash: input.proposal.proposal_hash,
    plan_id: judge.plan_id,
    plan_hash: judge.plan_hash,
    question_key: input.questionKey,
    decision: input.decision,
    review_match_outcome: input.matchOutcome,
    snapshot_id: input.handoff.snapshot_id,
    snapshot_hash: input.handoff.snapshot_hash
  };
}

export function closePayloadHash(payload: ReviewHandoffClosePayload): Hash {
  return canonicalHash(toJsonValue(payload));
}

function routeFieldsPresent(judge: ProposalMatchJudge): boolean {
  return judge.route_id !== null && judge.route_hash !== null && judge.route_class !== null;
}

function judgePathReady(
  judge: ProposalMatchJudge,
  entry: ReviewHandoffProposal,
  decision: "proceed" | "unverified"
): Result<true, ErrorEnvelope> {
  if (judge.status === "accepted" || judge.status === "rejected" || judge.status === "unknown") {
    if (decision !== "unverified") {
      return err(handoffNotReady("decision", "must_be_unverified"));
    }
    if (
      !routeFieldsPresent(judge) ||
      judge.issue_id === undefined ||
      entry.question_key === null ||
      judge.plan_id === undefined ||
      judge.plan_hash === undefined
    ) {
      return err(handoffNotReady("judge", "binding_missing"));
    }
    if (entry.judge === undefined) {
      return err(handoffNotReady("judge", "object_missing"));
    }
  }
  if (judge.status === "degraded" && entry.judge !== undefined) {
    if (decision !== "unverified") {
      return err(handoffNotReady("decision", "must_be_unverified"));
    }
    if (
      !routeFieldsPresent(judge) ||
      judge.issue_id === undefined ||
      entry.question_key === null ||
      judge.plan_id === undefined ||
      judge.plan_hash === undefined
    ) {
      return err(handoffNotReady("judge", "binding_missing"));
    }
  }
  return ok(true);
}

export function createReviewHandoffReadPort(repo: HandoffCloseRepository): ReviewHandoffReadPort {
  return {
    async getHandoffCloseView(input: {
      handoff_id: string;
      issue_id: string;
    }): Promise<Result<ReviewHandoffCloseView, ErrorEnvelope>> {
      const shape = validateCloseInput(input);
      if (!shape.ok) {
        return err(shape.error);
      }
      const { handoff_id: handoffId, issue_id: issueId } = shape.value;
      const loaded = repo.loadHandoff(handoffId);
      if (loaded === null) {
        return ok(pendingCloseView(handoffId, issueId));
      }
      const job = repo.loadJob(loaded.handoff.job_id);
      if (job === null) {
        return err(handoffPayloadInvalid("job_id", "missing"));
      }
      const snapshot = repo.loadSnapshot(loaded.handoff.snapshot_id);
      if (snapshot === null) {
        return err(handoffPayloadInvalid("snapshot_id", "missing"));
      }
      if (job.state !== "done") {
        return ok({
          handoff_id: handoffId,
          issue_id: issueId,
          job_state: "pending",
          job_result: null,
          binding: snapshot.version_binding,
          snapshot_id: loaded.handoff.snapshot_id,
          snapshot_hash: loaded.handoff.snapshot_hash,
          proposal_id: null,
          proposal_hash: null,
          plan_id: null,
          plan_hash: null,
          question_key: null,
          decision: null,
          review_match_outcome: null,
          source_refs: [loaded.body_blob],
          recorded_at_watermark: snapshot.version_binding.watermark,
          close_payload: null,
          close_payload_hash: null
        });
      }
      if (snapshot.snapshot_hash !== loaded.handoff.snapshot_hash) {
        return err(handoffPayloadInvalid("snapshot_hash", "mismatch"));
      }
      const recomputed = handoffHash(handoffBody(loaded.handoff));
      if (recomputed !== loaded.handoff.handoff_hash) {
        return err(handoffPayloadInvalid("handoff_hash", "recomputed"));
      }

      const doneBase: ReviewHandoffCloseView = {
        handoff_id: handoffId,
        issue_id: issueId,
        job_state: "done",
        job_result: loaded.handoff.job_result,
        binding: snapshot.version_binding,
        snapshot_id: loaded.handoff.snapshot_id,
        snapshot_hash: loaded.handoff.snapshot_hash,
        proposal_id: null,
        proposal_hash: null,
        plan_id: null,
        plan_hash: null,
        question_key: null,
        decision: null,
        review_match_outcome: null,
        source_refs: [],
        recorded_at_watermark: snapshot.version_binding.watermark,
        close_payload: null,
        close_payload_hash: null
      };

      if (loaded.handoff.job_result === "no_candidate") {
        return ok(doneBase);
      }
      if (loaded.handoff.job_result === "all_rejected" || loaded.handoff.job_result === "all_stale") {
        const inSnapshot = snapshot.issues.some((issue) => issue.issue_id === issueId);
        const staleOwned = repo.loadStaleProposalIssueIds(loaded.handoff.job_id).includes(issueId);
        if (!inSnapshot && !staleOwned) {
          return err(handoffProposalMismatch("issue_id", "no_owner"));
        }
        return ok(doneBase);
      }

      const matching = loaded.handoff.proposals.filter(
        (proposal) => proposal.judge !== undefined && proposal.judge.issue_id === issueId
      );
      if (matching.length !== 1) {
        return err(handoffProposalMismatch("issue_id", "unique_judge"));
      }
      const entry = matching[0];
      if (entry === undefined) {
        return err(handoffProposalMismatch("issue_id", "unique_judge"));
      }
      const proposal = repo.loadProposal(entry.proposal_id);
      if (proposal === null) {
        return err(handoffProposalMismatch("proposal_id", "missing"));
      }
      if (proposal.job_id !== loaded.handoff.job_id) {
        return err(handoffProposalMismatch("proposal_id", "job"));
      }
      if (proposal.proposal_hash !== entry.proposal_hash) {
        return err(handoffProposalMismatch("proposal_hash", "mismatch"));
      }
      if (proposal.state !== "proposed") {
        return err(handoffProposalMismatch("proposal.state", proposal.state));
      }
      if (proposal.match_judge.status === "pending") {
        return err(handoffNotReady("match_judge.status", "pending"));
      }
      const ready = judgePathReady(proposal.match_judge, entry, entry.decision);
      if (!ready.ok) {
        return err(ready.error);
      }
      const questionKey = entry.question_key;
      if (questionKey === null) {
        return err(handoffNotReady("question_key", "null"));
      }
      const payload = buildClosePayload({
        handoff: loaded.handoff,
        proposal,
        questionKey,
        matchOutcome: entry.judge?.match_outcome ?? null,
        decision: entry.decision
      });
      if (payload === null) {
        return err(handoffNotReady("close_payload", "plan_missing"));
      }
      const sources = [...new Set([loaded.body_blob, ...proposal.evidence_refs])].sort(compareUtf8);
      if (sources.length < 1 || sources.length > 64) {
        return err(handoffPayloadInvalid("source_refs", "range_1_64"));
      }
      return ok({
        ...doneBase,
        proposal_id: proposal.proposal_id,
        proposal_hash: proposal.proposal_hash,
        plan_id: payload.plan_id,
        plan_hash: payload.plan_hash,
        question_key: questionKey,
        decision: entry.decision,
        review_match_outcome: entry.judge?.match_outcome ?? null,
        source_refs: sources,
        close_payload: payload,
        close_payload_hash: closePayloadHash(payload)
      });
    }
  };
}

