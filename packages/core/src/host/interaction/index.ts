/**
 * Typed blocking interaction for `review.explicit` (DD-TRG-012).
 *
 * Only two questions are answered here: is a required `config_space` missing or
 * ambiguous, and did the existing FND authorization gate deny the action?
 * Unknown evidence, semantic shadow results and backend failures never create
 * an escalation.
 */



import type { Clock } from "../../clock.js";
import type { ErrorEnvelope, ErrorCategory, ErrorSideEffect } from "../../errors.js";
import type { Hash } from "../../hash.js";
import { newId, type Id } from "../../ids.js";
import { isHash } from "../../hash.js";
import type { SourceRef } from "../../source-ref.js";
import type { Result } from "../../result.js";
import { err, ok } from "../../result.js";
import type { VersionBinding } from "../../version-binding.js";
import { equalVersionBinding } from "../../version-binding.js";
import { interactionActionRef, interactionPromptId } from "../keys.js";
import type { ConfigSpace, HostId, HostMode } from "../types.js";
import { isConfigSpaceToken, isRecord, isSafePositiveInt, isUtf8SortedUnique, sortedUnique } from "../validation.js";

type HostInteractionActionKind = "review.explicit";

export interface HostActionContext {
  schema_version: "rsi.host_action_context/1";
  action: HostInteractionActionKind;
  request_id: string;
  binding: VersionBinding;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace | null;
  authorization_ref: Id<"grant"> | null;
  required: true;
  deadline_ms: number;
}

interface HostClarificationMissing {
  field: "config_space";
  state: "absent" | "ambiguous";
  candidates: ConfigSpace[];
}

interface HostAuthorizationDenial {
  code: "E_AUTH_DENIED";
  stage: "authorize";
  retryable: false;
  object_type: string;
  denied_dimension:
    | "object"
    | "project"
    | "config_space"
    | "path"
    | "block"
    | "action"
    | "mode"
    | "expiry"
    | "scope_empty";
  grant_id?: Id<"grant">;
}

interface HostClarificationEscalation {
  schema_version: "rsi.host_interaction_escalation/1";
  source: "host.necessity_gate";
  kind: "clarification";
  reason_code: "execution_blocking_clarification";
  action: HostInteractionActionKind;
  action_ref: Hash;
  request_id: string;
  binding: VersionBinding;
  host_id: HostId;
  mode: HostMode;
  config_space: null;
  authorization_ref: null;
  required: true;
  missing: [HostClarificationMissing];
}

interface HostAuthorizationEscalation {
  schema_version: "rsi.host_interaction_escalation/1";
  source: "fnd.authorization_gate";
  kind: "authorization";
  reason_code: "authorization_required";
  action: HostInteractionActionKind;
  action_ref: Hash;
  request_id: string;
  binding: VersionBinding;
  host_id: HostId;
  mode: HostMode;
  config_space: ConfigSpace;
  authorization_ref: Id<"grant"> | null;
  required: true;
  denial: HostAuthorizationDenial;
}

export type HostInteractionEscalation = HostClarificationEscalation | HostAuthorizationEscalation;

export interface HostInteractionRouteRef {
  schema_version: "rsi.host_interaction_route_ref/1";
  route_id: string;
  route_hash: Hash;
  route_status: "planned" | "no_op" | "executed";
  binding: VersionBinding;
  escalation: {
    kind: "clarification" | "authorization";
    reason_code: "execution_blocking_clarification" | "authorization_required";
  };
}

interface HostInteractionPromptRequest {
  schema_version: "rsi.host_interaction_prompt/1";
  prompt_id: string;
  escalation: HostInteractionEscalation;
  route_id: string;
  route_hash: Hash;
  deadline_ms: number;
}

interface HostInteractionPromptReceipt {
  schema_version: "rsi.host_interaction_prompt_receipt/1";
  prompt_id: string;
  state: "submitted" | "not_submitted" | "unsupported" | "unknown";
  native_ref: SourceRef | null;
  completed_at: number;
}

interface HostInteractionPromptInput {
  escalation: HostInteractionEscalation;
  route: HostInteractionRouteRef;
  deadline_ms: number;
}

interface HostInteractionPromptPort {
  prompt(
    req: HostInteractionPromptRequest,
    signal: AbortSignal
  ): Promise<HostInteractionResult<HostInteractionPromptReceipt>>;
}

type HostInteractionStage =
  | "host_interaction_schema"
  | "host_interaction_binding"
  | "host_interaction_sources"
  | "host_interaction_prompt";

type HostInteractionError = Omit<ErrorEnvelope, "code" | "stage"> & {
  code:
    | "E_SCHEMA"
    | "E_VERSION_BINDING"
    | "E_EVIDENCE_UNKNOWN"
    | "E_CAPABILITY"
    | "E_UNSUPPORTED"
    | "E_CONFLICT"
    | "E_DEADLINE_EXCEEDED"
    | "E_CANCELLED"
    | "E_IO"
    | "E_HOST_REJECTED"
    | "E_AUTH_UNAVAILABLE"
    | "E_INTERNAL";
  stage: HostInteractionStage;
  upstream_code?: string;
  observed_at: number;
};

type HostInteractionResult<T> = Result<T, HostInteractionError>;

interface HostInteractionGateDeps {
  clock: Clock;
  activeConfigSpaces(q: {
    host_id: HostId;
    mode: HostMode;
  }): Promise<HostInteractionResult<readonly ConfigSpace[]>>;
}

interface HostInteractionPromptDeps extends HostInteractionGateDeps {
  promptPort: HostInteractionPromptPort;
}

const DENIED_DIMENSIONS: readonly HostAuthorizationDenial["denied_dimension"][] = [
  "object",
  "project",
  "config_space",
  "path",
  "block",
  "action",
  "mode",
  "expiry",
  "scope_empty"
];

const ROUTE_ID_PATTERN = /^route:[0-9a-f]{64}$/;
const PROMPT_ID_PATTERN = /^prompt:[0-9a-f]{64}$/;

function interactionError(input: {
  code: HostInteractionError["code"];
  stage: HostInteractionStage;
  category: ErrorCategory;
  retryable?: boolean;
  side_effect?: ErrorSideEffect;
  details?: ErrorEnvelope["details"];
  upstream_code?: string;
  observed_at: number;
  detail_ref?: SourceRef;
}): HostInteractionError {
  const error: HostInteractionError = {
    schema_version: "rsi.error/1",
    code: input.code,
    category: input.category,
    retryable: input.retryable ?? false,
    side_effect: input.side_effect ?? "none",
    message_key: `error.${input.code.toLowerCase()}`,
    details: input.details ?? { kind: "none" },
    stage: input.stage,
    trace_id: newId("ipc"),
    observed_at: input.observed_at
  };
  if (input.upstream_code !== undefined) {
    error.upstream_code = input.upstream_code;
  }
  if (input.detail_ref !== undefined) {
    error.detail_ref = input.detail_ref;
  }
  return error;
}

function schemaFailure(stage: HostInteractionStage, path: string, rule: string, now: number): HostInteractionError {
  return interactionError({
    code: "E_SCHEMA",
    stage,
    category: "schema",
    details: { kind: "field", path, rule },
    observed_at: now
  });
}

const ACTION_CONTEXT_FIELDS: readonly string[] = [
  "schema_version",
  "action",
  "request_id",
  "binding",
  "host_id",
  "mode",
  "config_space",
  "authorization_ref",
  "required",
  "deadline_ms"
];

function validateActionContext(ctx: unknown, now: number): HostInteractionError | null {
  if (!isRecord(ctx)) {
    return schemaFailure("host_interaction_schema", "$", "object", now);
  }
  for (const key of Object.keys(ctx)) {
    if (!ACTION_CONTEXT_FIELDS.includes(key)) {
      return schemaFailure("host_interaction_schema", key, "known_field", now);
    }
  }
  for (const key of ACTION_CONTEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(ctx, key)) {
      return schemaFailure("host_interaction_schema", key, "required", now);
    }
  }
  if (ctx["schema_version"] !== "rsi.host_action_context/1") {
    return schemaFailure("host_interaction_schema", "schema_version", "rsi.host_action_context/1", now);
  }
  if (ctx["action"] !== "review.explicit") {
    return schemaFailure("host_interaction_schema", "action", "review.explicit", now);
  }
  if (ctx["required"] !== true) {
    return schemaFailure("host_interaction_schema", "required", "true", now);
  }
  const requestId = ctx["request_id"];
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    return schemaFailure("host_interaction_schema", "request_id", "1..128", now);
  }
  const binding = ctx["binding"];
  if (!isRecord(binding)) {
    return schemaFailure("host_interaction_schema", "binding", "version_binding", now);
  }
  for (const field of ["task_id", "branch_id", "input_epoch", "goal_version", "config_version", "watermark"]) {
    if (!Object.prototype.hasOwnProperty.call(binding, field)) {
      return schemaFailure("host_interaction_schema", `binding.${field}`, "required", now);
    }
  }
  if (typeof ctx["host_id"] !== "string" || typeof ctx["mode"] !== "string") {
    return schemaFailure("host_interaction_schema", "host_id", "closed_set", now);
  }
  const configSpace = ctx["config_space"];
  if (configSpace !== null && (typeof configSpace !== "string" || !isConfigSpaceToken(configSpace))) {
    return schemaFailure("host_interaction_schema", "config_space", "config_space_or_null", now);
  }
  const authorizationRef = ctx["authorization_ref"];
  if (authorizationRef !== null && (typeof authorizationRef !== "string" || !authorizationRef.startsWith("grant:"))) {
    return schemaFailure("host_interaction_schema", "authorization_ref", "grant_or_null", now);
  }
  if (!isSafePositiveInt(ctx["deadline_ms"]) || ctx["deadline_ms"] > 600_000) {
    return schemaFailure("host_interaction_schema", "deadline_ms", "1..600000", now);
  }
  return null;
}

function checkCancellation(
  clock: Clock,
  deadlineRemaining: number,
  signal: AbortSignal,
  stage: HostInteractionStage
): HostInteractionError | null {
  if (signal.aborted) {
    return interactionError({
      code: "E_CANCELLED",
      stage,
      category: "deadline",
      observed_at: clock.utcNowMs()
    });
  }
  if (clock.monotonicRemainingMs(clock.monotonicNowMs() + deadlineRemaining) <= 0) {
    return interactionError({
      code: "E_DEADLINE_EXCEEDED",
      stage,
      category: "deadline",
      retryable: true,
      observed_at: clock.utcNowMs()
    });
  }
  return null;
}

function isSortedUniqueCandidates(candidates: readonly string[]): boolean {
  return candidates.every((candidate) => isConfigSpaceToken(candidate)) && isUtf8SortedUnique(candidates);
}

function clarify(
  ctx: HostActionContext,
  candidates: readonly ConfigSpace[]
): HostClarificationEscalation {
  const sorted = sortedUnique(candidates);
  return {
    schema_version: "rsi.host_interaction_escalation/1",
    source: "host.necessity_gate",
    kind: "clarification",
    reason_code: "execution_blocking_clarification",
    action: ctx.action,
    action_ref: interactionActionRef({
      action: ctx.action,
      request_id: ctx.request_id,
      binding: ctx.binding,
      host_id: ctx.host_id,
      mode: ctx.mode,
      config_space: null,
      authorization_ref: null
    }),
    request_id: ctx.request_id,
    binding: ctx.binding,
    host_id: ctx.host_id,
    mode: ctx.mode,
    config_space: null,
    authorization_ref: null,
    required: true,
    missing: [{ field: "config_space", state: "ambiguous", candidates: sorted }]
  };
}

/**
 * Missing-scope producer. Returns `Ok(null)` for 0 or 1 active candidates and
 * only escalates when the current scope is ambiguous (>= 2 candidates).
 */
export async function evaluateHostNecessity(
  ctx: HostActionContext,
  deps: HostInteractionGateDeps,
  signal: AbortSignal
): Promise<HostInteractionResult<HostClarificationEscalation | null>> {
  const now = deps.clock.utcNowMs();
  const invalid = validateActionContext(ctx, now);
  if (invalid !== null) {
    return err(invalid);
  }
  const cancelled = checkCancellation(deps.clock, ctx.deadline_ms, signal, "host_interaction_sources");
  if (cancelled !== null) {
    return err(cancelled);
  }
  let active: readonly ConfigSpace[];
  try {
    const read = await deps.activeConfigSpaces({ host_id: ctx.host_id, mode: ctx.mode });
    if (!read.ok) {
      return err(interactionError({
        code: "E_EVIDENCE_UNKNOWN",
        stage: "host_interaction_sources",
        category: "source",
        upstream_code: read.error.code,
        observed_at: now
      }));
    }
    active = read.value;
  } catch {
    return err(interactionError({
      code: "E_EVIDENCE_UNKNOWN",
      stage: "host_interaction_sources",
      category: "source",
      observed_at: now
    }));
  }
  if (!isSortedUniqueCandidates(active)) {
    return err(interactionError({
      code: "E_EVIDENCE_UNKNOWN",
      stage: "host_interaction_sources",
      category: "source",
      observed_at: now
    }));
  }
  if (ctx.config_space !== null) {
    if (active.includes(ctx.config_space)) {
      return ok(null);
    }
    return err(interactionError({
      code: "E_VERSION_BINDING",
      stage: "host_interaction_binding",
      category: "version",
      observed_at: now
    }));
  }
  if (active.length < 2) {
    return ok(null);
  }
  const escalation = clarify(ctx, active);
  if (
    escalation.missing.length !== 1 ||
    escalation.missing[0]?.state !== "ambiguous" ||
    escalation.authorization_ref !== null ||
    escalation.config_space !== null
  ) {
    return err(schemaFailure("host_interaction_schema", "missing", "ambiguous_shape", now));
  }
  return ok(escalation);
}

/** FND authorization denial producer. Non-`E_AUTH_DENIED` returns `Ok(null)`. */
export function toHostAuthorizationEscalation(
  ctx: HostActionContext,
  error: ErrorEnvelope
): HostInteractionResult<HostAuthorizationEscalation | null> {
  const now = Date.now();
  const invalid = validateActionContext(ctx, now);
  if (invalid !== null) {
    return err(invalid);
  }
  if (ctx.config_space === null) {
    return err(schemaFailure("host_interaction_schema", "config_space", "required", now));
  }
  if (error.code !== "E_AUTH_DENIED") {
    return ok(null);
  }
  if (
    error.schema_version !== "rsi.error/1" ||
    error.category !== "authorization" ||
    error.stage !== "authorize" ||
    error.retryable !== false ||
    error.side_effect !== "none" ||
    error.details.kind !== "authorization" ||
    typeof error.details.object_type !== "string" ||
    error.details.object_type.length === 0 ||
    !DENIED_DIMENSIONS.includes(error.details.denied_dimension)
  ) {
    return err(schemaFailure("host_interaction_schema", "denial", "authorization_envelope", now));
  }
  const grantId = error.details.grant_id;
  if (ctx.authorization_ref !== null && grantId !== undefined && ctx.authorization_ref !== grantId) {
    return err(schemaFailure("host_interaction_schema", "denial.grant_id", "matches_authorization_ref", now));
  }
  const denial: HostAuthorizationDenial = {
    code: "E_AUTH_DENIED",
    stage: "authorize",
    retryable: false,
    object_type: error.details.object_type,
    denied_dimension: error.details.denied_dimension
  };
  if (grantId !== undefined) {
    denial.grant_id = grantId;
  }
  return ok({
    schema_version: "rsi.host_interaction_escalation/1",
    source: "fnd.authorization_gate",
    kind: "authorization",
    reason_code: "authorization_required",
    action: ctx.action,
    action_ref: interactionActionRef({
      action: ctx.action,
      request_id: ctx.request_id,
      binding: ctx.binding,
      host_id: ctx.host_id,
      mode: ctx.mode,
      config_space: ctx.config_space,
      authorization_ref: ctx.authorization_ref
    }),
    request_id: ctx.request_id,
    binding: ctx.binding,
    host_id: ctx.host_id,
    mode: ctx.mode,
    config_space: ctx.config_space,
    authorization_ref: ctx.authorization_ref,
    required: true,
    denial
  });
}

function parseFailure(
  code: "E_SCHEMA" | "E_VERSION_BINDING",
  stage: HostInteractionStage,
  path: string,
  rule: string
): HostInteractionError {
  return interactionError({
    code,
    stage,
    category: code === "E_SCHEMA" ? "schema" : "version",
    details: { kind: "field", path, rule },
    observed_at: Date.now()
  });
}

function isVersionBindingShape(value: unknown): value is VersionBinding {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["task_id"] === "string" &&
    typeof value["branch_id"] === "string" &&
    typeof value["input_epoch"] === "number" &&
    typeof value["goal_version"] === "string" &&
    typeof value["config_version"] === "string" &&
    typeof value["watermark"] === "number"
  );
}

function escalationActionRef(escalation: HostInteractionEscalation): Hash {
  return interactionActionRef({
    action: escalation.action,
    request_id: escalation.request_id,
    binding: escalation.binding,
    host_id: escalation.host_id,
    mode: escalation.mode,
    config_space: escalation.config_space,
    authorization_ref: escalation.authorization_ref
  });
}

/**
 * Strict parser used by QP. Returns the same frozen content on success and one
 * of exactly two failures on rejection.
 */
/**
 * The closed field set of each escalation variant.
 *
 * DD-TRG-012 publishes the source as a closed set: a member outside the
 * variant's own fields is not the published source and is rejected with
 * `E_SCHEMA`, so a caller cannot smuggle extra state into the route.
 */
const CLARIFICATION_ESCALATION_FIELDS: readonly string[] = Object.freeze([
  "schema_version",
  "source",
  "kind",
  "reason_code",
  "action",
  "action_ref",
  "request_id",
  "binding",
  "host_id",
  "mode",
  "config_space",
  "authorization_ref",
  "required",
  "missing"
]);

const AUTHORIZATION_ESCALATION_FIELDS: readonly string[] = Object.freeze([
  "schema_version",
  "source",
  "kind",
  "reason_code",
  "action",
  "action_ref",
  "request_id",
  "binding",
  "host_id",
  "mode",
  "config_space",
  "authorization_ref",
  "required",
  "denial"
]);

export function parseHostInteractionEscalation(source: unknown): HostInteractionResult<HostInteractionEscalation> {
  if (!isRecord(source)) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "$", "object"));
  }
  if (source["schema_version"] !== "rsi.host_interaction_escalation/1") {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "schema_version", "rsi.host_interaction_escalation/1"));
  }
  const closedFields =
    source["kind"] === "authorization" ? AUTHORIZATION_ESCALATION_FIELDS : CLARIFICATION_ESCALATION_FIELDS;
  for (const key of Object.keys(source)) {
    if (!closedFields.includes(key)) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", key, "closed_set"));
    }
  }
  const kind = source["kind"];
  const expectedSource = kind === "clarification" ? "host.necessity_gate" : kind === "authorization" ? "fnd.authorization_gate" : null;
  if (expectedSource === null || source["source"] !== expectedSource) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "source_kind_pair", "paired"));
  }
  const reason = source["reason_code"];
  if (
    (kind === "clarification" && reason !== "execution_blocking_clarification") ||
    (kind === "authorization" && reason !== "authorization_required")
  ) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "reason_code", "paired"));
  }
  if (source["required"] !== true || source["action"] !== "review.explicit") {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "required", "true"));
  }
  const requestId = source["request_id"];
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "request_id", "1..128"));
  }
  if (!isVersionBindingShape(source["binding"])) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "binding", "version_binding"));
  }
  if (typeof source["host_id"] !== "string" || typeof source["mode"] !== "string") {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "host_id", "closed_set"));
  }
  if (typeof source["action_ref"] !== "string" || !isHash(source["action_ref"])) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "action_ref", "sha256_hash"));
  }
  if (kind === "clarification") {
    if (source["config_space"] !== null || source["authorization_ref"] !== null) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", "config_space", "null"));
    }
    const missing = source["missing"];
    if (!Array.isArray(missing) || missing.length !== 1) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", "missing", "exactly_one"));
    }
    const entry = missing[0];
    if (
      !isRecord(entry) ||
      entry["field"] !== "config_space" ||
      (entry["state"] !== "absent" && entry["state"] !== "ambiguous")
    ) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", "missing", "clarification_missing"));
    }
    const candidates = entry["candidates"];
    if (!Array.isArray(candidates) || !candidates.every((candidate) => typeof candidate === "string")) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", "candidates", "config_space[]"));
    }
    if (!isSortedUniqueCandidates(candidates)) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", "candidates", "sorted_unique"));
    }
    if (entry["state"] === "ambiguous" && candidates.length < 2) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", "candidates", "ambiguous_min_two"));
    }
    if (entry["state"] === "absent" && candidates.length !== 0) {
      return err(parseFailure("E_SCHEMA", "host_interaction_schema", "candidates", "absent_empty"));
    }
    const escalation: HostClarificationEscalation = {
      schema_version: "rsi.host_interaction_escalation/1",
      source: "host.necessity_gate",
      kind: "clarification",
      reason_code: "execution_blocking_clarification",
      action: "review.explicit",
      action_ref: source["action_ref"] as Hash,
      request_id: requestId,
      binding: source["binding"] as VersionBinding,
      host_id: source["host_id"] as HostId,
      mode: source["mode"] as HostMode,
      config_space: null,
      authorization_ref: null,
      required: true,
      missing: [
        {
          field: "config_space",
          state: entry["state"],
          candidates: candidates as ConfigSpace[]
        }
      ]
    };
    if (escalationActionRef(escalation) !== escalation.action_ref) {
      return err(parseFailure("E_VERSION_BINDING", "host_interaction_binding", "action_ref", "recomputed"));
    }
    return ok(escalation);
  }
  // authorization
  if (typeof source["config_space"] !== "string" || !isConfigSpaceToken(source["config_space"])) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "config_space", "config_space_token"));
  }
  const authorizationRef = source["authorization_ref"];
  if (authorizationRef !== null && (typeof authorizationRef !== "string" || !authorizationRef.startsWith("grant:"))) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "authorization_ref", "grant_or_null"));
  }
  const denial = source["denial"];
  if (
    !isRecord(denial) ||
    denial["code"] !== "E_AUTH_DENIED" ||
    denial["stage"] !== "authorize" ||
    denial["retryable"] !== false ||
    typeof denial["object_type"] !== "string" ||
    denial["object_type"].length === 0 ||
    typeof denial["denied_dimension"] !== "string" ||
    !DENIED_DIMENSIONS.includes(denial["denied_dimension"] as HostAuthorizationDenial["denied_dimension"])
  ) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "denial", "authorization_denial"));
  }
  if (denial["grant_id"] !== undefined && (typeof denial["grant_id"] !== "string" || !denial["grant_id"].startsWith("grant:"))) {
    return err(parseFailure("E_SCHEMA", "host_interaction_schema", "denial.grant_id", "grant_id"));
  }
  const denialRecord: HostAuthorizationDenial = {
    code: "E_AUTH_DENIED",
    stage: "authorize",
    retryable: false,
    object_type: denial["object_type"] as string,
    denied_dimension: denial["denied_dimension"] as HostAuthorizationDenial["denied_dimension"]
  };
  if (typeof denial["grant_id"] === "string") {
    denialRecord.grant_id = denial["grant_id"] as Id<"grant">;
  }
  const escalation: HostAuthorizationEscalation = {
    schema_version: "rsi.host_interaction_escalation/1",
    source: "fnd.authorization_gate",
    kind: "authorization",
    reason_code: "authorization_required",
    action: "review.explicit",
    action_ref: source["action_ref"] as Hash,
    request_id: requestId,
    binding: source["binding"] as VersionBinding,
    host_id: source["host_id"] as HostId,
    mode: source["mode"] as HostMode,
    config_space: source["config_space"] as ConfigSpace,
    authorization_ref: authorizationRef as Id<"grant"> | null,
    required: true,
    denial: denialRecord
  };
  if (escalationActionRef(escalation) !== escalation.action_ref) {
    return err(parseFailure("E_VERSION_BINDING", "host_interaction_binding", "action_ref", "recomputed"));
  }
  return ok(escalation);
}

function routeRefIssue(route: unknown): string | null {
  if (!isRecord(route)) {
    return "$";
  }
  for (const key of Object.keys(route)) {
    if (!["schema_version", "route_id", "route_hash", "route_status", "binding", "escalation"].includes(key)) {
      return key;
    }
  }
  if (route["schema_version"] !== "rsi.host_interaction_route_ref/1") {
    return "schema_version";
  }
  if (typeof route["route_id"] !== "string" || !ROUTE_ID_PATTERN.test(route["route_id"])) {
    return "route_id";
  }
  if (typeof route["route_hash"] !== "string" || !isHash(route["route_hash"])) {
    return "route_hash";
  }
  if (route["route_status"] !== "planned") {
    return "route_status";
  }
  if (!isVersionBindingShape(route["binding"])) {
    return "binding";
  }
  const escalation = route["escalation"];
  if (
    !isRecord(escalation) ||
    (escalation["kind"] !== "clarification" && escalation["kind"] !== "authorization") ||
    (escalation["reason_code"] !== "execution_blocking_clarification" &&
      escalation["reason_code"] !== "authorization_required")
  ) {
    return "escalation";
  }
  return null;
}

let lastPrompt: HostInteractionPromptReceipt | null = null;

/**
 * Prompt gate. Submission only proves that the native entry accepted the
 * prompt; it never proves a user read, authorized or confirmed anything.
 */
export async function promptHostInteraction(
  input: HostInteractionPromptInput,
  deps: HostInteractionPromptDeps,
  signal: AbortSignal
): Promise<HostInteractionResult<HostInteractionPromptReceipt>> {
  const now = deps.clock.utcNowMs();
  const routeIssue = routeRefIssue(input.route);
  if (
    routeIssue !== null ||
    !isSafePositiveInt(input.deadline_ms) ||
    input.deadline_ms > 600_000
  ) {
    return err(schemaFailure("host_interaction_schema", routeIssue ?? "deadline_ms", "route_ref_and_deadline", now));
  }
  const parsed = parseHostInteractionEscalation(input.escalation);
  if (!parsed.ok) {
    return err(parsed.error);
  }
  const source = parsed.value;
  if (
    source.kind === "clarification" &&
    (source.missing[0]?.state !== "ambiguous" || source.missing[0].candidates.length < 2)
  ) {
    return err(schemaFailure("host_interaction_schema", "missing", "ambiguous_min_two", now));
  }
  if (!equalVersionBinding(source.binding, input.route.binding)) {
    return err(interactionError({
      code: "E_VERSION_BINDING",
      stage: "host_interaction_binding",
      category: "version",
      observed_at: now
    }));
  }
  if (
    input.route.escalation.kind !== source.kind ||
    input.route.escalation.reason_code !== source.reason_code
  ) {
    return err(schemaFailure("host_interaction_schema", "escalation", "route_pair", now));
  }
  let active: readonly ConfigSpace[];
  try {
    const read = await deps.activeConfigSpaces({ host_id: source.host_id, mode: source.mode });
    if (!read.ok) {
      return err(interactionError({
        code: "E_EVIDENCE_UNKNOWN",
        stage: "host_interaction_sources",
        category: "source",
        upstream_code: read.error.code,
        observed_at: now
      }));
    }
    active = read.value;
  } catch {
    return err(interactionError({
      code: "E_EVIDENCE_UNKNOWN",
      stage: "host_interaction_sources",
      category: "source",
      observed_at: now
    }));
  }
  if (source.kind === "clarification") {
    const candidates = source.missing[0]?.candidates ?? [];
    if (candidates.length !== active.length || candidates.some((candidate, index) => candidate !== active[index])) {
      return err(interactionError({
        code: "E_VERSION_BINDING",
        stage: "host_interaction_binding",
        category: "version",
        observed_at: now
      }));
    }
  } else if (!active.includes(source.config_space)) {
    return err(interactionError({
      code: "E_VERSION_BINDING",
      stage: "host_interaction_binding",
      category: "version",
      observed_at: now
    }));
  }
  const cancelled = checkCancellation(deps.clock, input.deadline_ms, signal, "host_interaction_sources");
  if (cancelled !== null) {
    return err(cancelled);
  }
  const promptId = interactionPromptId({
    route_id: input.route.route_id,
    route_hash: input.route.route_hash,
    action_ref: source.action_ref,
    kind: source.kind,
    reason_code: source.reason_code
  });
  if (!PROMPT_ID_PATTERN.test(promptId)) {
    return err(schemaFailure("host_interaction_schema", "prompt_id", "prompt_id", now));
  }
  if (lastPrompt !== null && lastPrompt.prompt_id === promptId) {
    return ok(lastPrompt);
  }
  const request: HostInteractionPromptRequest = {
    schema_version: "rsi.host_interaction_prompt/1",
    prompt_id: promptId,
    escalation: source,
    route_id: input.route.route_id,
    route_hash: input.route.route_hash,
    deadline_ms: input.deadline_ms
  };
  let receipt: HostInteractionPromptReceipt;
  try {
    const prompted = await deps.promptPort.prompt(request, signal);
    if (!prompted.ok) {
      return err(prompted.error);
    }
    receipt = prompted.value;
  } catch {
    return err(interactionError({
      code: "E_HOST_REJECTED",
      stage: "host_interaction_prompt",
      category: "external",
      side_effect: "unknown",
      observed_at: deps.clock.utcNowMs()
    }));
  }
  if (
    receipt.schema_version !== "rsi.host_interaction_prompt_receipt/1" ||
    receipt.prompt_id !== promptId ||
    (receipt.state !== "submitted" &&
      receipt.state !== "not_submitted" &&
      receipt.state !== "unsupported" &&
      receipt.state !== "unknown") ||
    !Number.isSafeInteger(receipt.completed_at) ||
    receipt.completed_at < 0 ||
    (receipt.native_ref !== null && typeof receipt.native_ref !== "string")
  ) {
    return err(schemaFailure("host_interaction_prompt", "receipt", "prompt_receipt", now));
  }
  lastPrompt = receipt;
  return ok(receipt);
}

/** Test-only reset for the in-process prompt de-duplication. */
export function resetHostInteractionPromptMemo(): void {
  lastPrompt = null;
}
