/**
 * `AuthorizationGrant` issue, revoke, hashing and scope validation
 * (DD-FND-090).
 *
 * `grant_hash` covers the authorization content only. Two independent subject
 * hashes bind a human proof to either an issue or a revoke request; the server
 * recomputes them from the request fields and never accepts a client hash.
 */

import { canonicalHash, compareUtf8, isHash, isId } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  HumanAttestation,
  Id,
  JsonValue,
  Result,
} from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type {
  CandidateId,
  GrantAction,
  GrantMode,
  GrantObjectType,
  WriteDecision,
} from "@evoplug/core";

import { authDenied, fieldError } from "./errors.js";
import { validatePathGlob } from "./path-glob.js";

export type { CandidateId, GrantAction, GrantMode, GrantObjectType, WriteDecision };

type GrantIssuer = "human" | "preconfigured_policy";
export type GrantSubject = "rsi";

const AUTHORIZATION_GRANT_SCHEMA_VERSION: "rsi.authorization_grant/1" =
  "rsi.authorization_grant/1";

const GRANT_ISSUE_SCHEMA_VERSION: "rsi.grant_issue/1" = "rsi.grant_issue/1";

const GRANT_REVOKE_SCHEMA_VERSION: "rsi.grant_revoke/1" = "rsi.grant_revoke/1";

const GRANT_ISSUE_SUBJECT_SCHEMA_VERSION: "rsi.grant_issue_subject/1" =
  "rsi.grant_issue_subject/1";

const GRANT_REVOKE_SUBJECT_SCHEMA_VERSION: "rsi.grant_revoke_subject/1" =
  "rsi.grant_revoke_subject/1";

/** Reserved `project_ids` value matching a task with `project_id = null`. */
export const USER_PROJECT_SCOPE = "user";

export interface ConfigGrantScope {
  /** Non-empty, ascending UTF-8, unique; covers every patched field. */
  field_ids: Id<"fld">[];
  /** Non-empty, ascending UTF-8; contains `patch.layer_id`. */
  source_layer_ids: string[];
  /** Non-empty, ascending UTF-8; contains `patch.model_scope_key`. */
  model_scope_keys: string[];
}

export interface GrantScope {
  project_ids: string[];
  config_spaces: string[];
  path_globs: string[];
  /** Empty means every object of `object_type`, still bounded by the other axes. */
  object_ids: string[];
  /** Required for new config grants; absent on v1 imported config grants. */
  config_scope?: ConfigGrantScope;
}

export interface AuthorizationGrant {
  schema_version: "rsi.authorization_grant/1";
  grant_id: Id<"grant">;
  issued_by: GrantIssuer;
  human_attestation: HumanAttestation;
  subject: "rsi";
  object_type: GrantObjectType;
  scope: GrantScope;
  actions: GrantAction[];
  mode: GrantMode;
  candidate_id: CandidateId | null;
  candidate_hash: Hash | null;
  policy_version: string;
  issued_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  grant_hash: Hash;
}

export interface GrantIssueRequest {
  schema_version: "rsi.grant_issue/1";
  /** IPC only accepts `human`; `preconfigured_policy` is written by config init. */
  issued_by: "human";
  human_attestation: HumanAttestation;
  object_type: GrantObjectType;
  scope: GrantScope;
  actions: GrantAction[];
  mode: GrantMode;
  candidate_id: CandidateId | null;
  candidate_hash: Hash | null;
  policy_version: string;
  expires_at: number | null;
}

export interface GrantRevokeRequest {
  schema_version: "rsi.grant_revoke/1";
  grant_id: Id<"grant">;
  expected_grant_hash: Hash;
  human_attestation: HumanAttestation;
  reason: "human_revoked" | "policy_replaced";
}

export interface GrantPublicView {
  grant_id: Id<"grant">;
  issued_by: GrantIssuer;
  subject: "rsi";
  object_type: GrantObjectType;
  scope: GrantScope;
  actions: GrantAction[];
  mode: GrantMode;
  candidate_id: CandidateId | null;
  candidate_hash: Hash | null;
  policy_version: string;
  issued_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  grant_hash: Hash;
}

export interface GrantView {
  grant: GrantPublicView;
  consumed_write_id: Id<"wi"> | null;
  consumed_config_write_id: Id<"cwi"> | null;
}

interface CreatedGrant {
  grant: AuthorizationGrant;
  subject_hash: Hash;
}

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

/** `grant_hash = sha256(JCS(<whitelist>))`; identity and time fields excluded. */
export function grantHash(grant: Omit<AuthorizationGrant, "grant_hash">): Hash {
  return canonicalHash(grantHashPreimage(grant));
}

/** The exact JCS preimage of `grant_hash` (DD-FND-090 whitelist). */
function grantHashPreimage(grant: Omit<AuthorizationGrant, "grant_hash">): JsonValue {
  const preimage: Record<string, JsonValue> = {
    schema_version: grant.schema_version,
    issued_by: grant.issued_by,
    human_attestation: attestationJson(grant.human_attestation),
    subject: grant.subject,
    object_type: grant.object_type,
    scope: scopeJson(grant.scope),
    actions: [...grant.actions],
    mode: grant.mode,
    candidate_id: grant.candidate_id,
    candidate_hash: grant.candidate_hash,
    policy_version: grant.policy_version
  };
  return preimage;
}

/** True when the stored `grant_hash` matches a recomputation. */
export function verifyGrantHash(grant: AuthorizationGrant): boolean {
  return grantHash(grant) === grant.grant_hash;
}

/** The issue subject bound by a human proof; every field is required. */
function grantIssueSubject(request: GrantIssueRequest): JsonValue {
  return {
    schema_version: GRANT_ISSUE_SUBJECT_SCHEMA_VERSION,
    purpose: "grant_issue",
    issued_by: "human",
    object_type: request.object_type,
    scope: scopeJson(request.scope),
    actions: [...request.actions],
    mode: request.mode,
    candidate_id: request.candidate_id,
    candidate_hash: request.candidate_hash,
    policy_version: request.policy_version,
    expires_at: request.expires_at
  };
}

/** `attestation_subject_hash` for `purpose="grant_issue"`. */
export function grantIssueSubjectHash(request: GrantIssueRequest): Hash {
  return canonicalHash(grantIssueSubject(request));
}

/** The revoke subject; `grant_id` is bound separately from `grant_hash`. */
export function grantRevokeSubject(request: GrantRevokeRequest): JsonValue {
  return {
    schema_version: GRANT_REVOKE_SUBJECT_SCHEMA_VERSION,
    purpose: "grant_revoke",
    grant_id: request.grant_id,
    expected_grant_hash: request.expected_grant_hash,
    reason: request.reason
  };
}

/** `attestation_subject_hash` for `purpose="grant_revoke"`. */
export function grantRevokeSubjectHash(request: GrantRevokeRequest): Hash {
  return canonicalHash(grantRevokeSubject(request));
}

/* ------------------------------------------------------------------ */
/* Scope validation                                                    */
/* ------------------------------------------------------------------ */

interface ScopeValidationOptions {
  /** `config_space_id` a config grant must be bound to, when known. */
  config_space_id?: Hash;
}

/**
 * Validates a grant scope.
 *
 * Ordering is strict: every axis must already be ascending and unique. Empty
 * axes are legal to store but authorize nothing at decision time; config
 * grants additionally require a complete `config_scope` and exactly one
 * `config_spaces` entry.
 */
function isWildcardScopeValue(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

export function validateGrantScope(
  scope: GrantScope,
  objectType: GrantObjectType,
  options: ScopeValidationOptions = {}
): Result<GrantScope, ErrorEnvelope> {
  const axes: readonly [string, readonly string[]][] = [
    ["scope.project_ids", scope.project_ids],
    ["scope.config_spaces", scope.config_spaces],
    ["scope.path_globs", scope.path_globs]
  ];
  for (const [path, values] of axes) {
    if (!isSortedUnique(values)) {
      return err(fieldError("E_GRANT_SCOPE", path, "sorted_utf8_unique"));
    }
  }
  for (const projectId of scope.project_ids) {
    if (!isValidProjectId(projectId)) {
      return err(fieldError("E_GRANT_SCOPE", "scope.project_ids", "project_id_or_user"));
    }
  }
  for (const configSpace of scope.config_spaces) {
    if (configSpace.length === 0 || configSpace.includes("\u0000")) {
      return err(fieldError("E_GRANT_SCOPE", "scope.config_spaces", "non_empty_text"));
    }
    if (isWildcardScopeValue(configSpace)) {
      return err(fieldError("E_GRANT_SCOPE", "scope.config_spaces", "no_wildcards"));
    }
  }
  for (const glob of scope.path_globs) {
    const validated = validatePathGlob(glob);
    if (!validated.ok) {
      return validated;
    }
  }
  for (const objectId of scope.object_ids) {
    if (objectType === "config") {
      if (!isHash(objectId)) {
        return err(
          fieldError("E_GRANT_OBJECT_ID", "scope.object_ids", "config_space_sha256")
        );
      }
    } else if (!isId(objectId, "prop")) {
      return err(fieldError("E_GRANT_OBJECT_ID", "scope.object_ids", "prop_id"));
    }
  }
  if (objectType === "config") {
    if (scope.config_spaces.length !== 1) {
      return err(
        fieldError("E_AUTH_CONFIG_SCOPE", "scope.config_spaces", "exactly_one_config_space")
      );
    }
    if (options.config_space_id !== undefined && scope.config_spaces[0] !== options.config_space_id) {
      return err(fieldError("E_AUTH_CONFIG_SCOPE", "scope.config_spaces", "equals_config_space_id"));
    }
    if (scope.config_scope === undefined) {
      return err(fieldError("E_AUTH_CONFIG_SCOPE", "scope.config_scope", "required_for_config"));
    }
    const configScope = scope.config_scope;
    if (!isSortedUnique(configScope.field_ids)) {
      return err(
        fieldError("E_GRANT_SCOPE", "scope.config_scope.field_ids", "non_empty_sorted_unique")
      );
    }
    if (!isSortedUnique(configScope.source_layer_ids)) {
      return err(
        fieldError("E_GRANT_SCOPE", "scope.config_scope.source_layer_ids", "non_empty_sorted_unique")
      );
    }
    if (!isSortedUnique(configScope.model_scope_keys)) {
      return err(
        fieldError("E_GRANT_SCOPE", "scope.config_scope.model_scope_keys", "non_empty_sorted_unique")
      );
    }
    if (configScope.field_ids.length === 0) {
      return err(
        fieldError("E_GRANT_SCOPE", "scope.config_scope.field_ids", "non_empty_sorted_unique")
      );
    }
    if (configScope.source_layer_ids.length === 0) {
      return err(
        fieldError("E_GRANT_SCOPE", "scope.config_scope.source_layer_ids", "non_empty_sorted_unique")
      );
    }
    if (configScope.model_scope_keys.length === 0) {
      return err(
        fieldError("E_GRANT_SCOPE", "scope.config_scope.model_scope_keys", "non_empty_sorted_unique")
      );
    }
  } else if (scope.config_scope !== undefined) {
    return err(fieldError("E_GRANT_SCOPE", "scope.config_scope", "config_object_only"));
  }
  return ok(scope);
}

/** Validates a candidate id against its object type. */
export function validateCandidateForObject(
  objectType: GrantObjectType,
  candidateId: CandidateId | null
): Result<CandidateId | null, ErrorEnvelope> {
  if (candidateId === null) {
    if (objectType === "config") {
      return err(fieldError("E_WRITE_CANDIDATE_ID", "candidate_id", "required_for_config"));
    }
    return ok(null);
  }
  if (objectType === "config") {
    if (!isId(candidateId, "ctr")) {
      return err(fieldError("E_WRITE_CANDIDATE_ID", "candidate_id", "ctr_id"));
    }
    return ok(candidateId);
  }
  if (!isId(candidateId, "prop")) {
    return err(fieldError("E_WRITE_CANDIDATE_ID", "candidate_id", "prop_id"));
  }
  return ok(candidateId);
}

/* ------------------------------------------------------------------ */
/* Issue and revoke                                                    */
/* ------------------------------------------------------------------ */

/**
 * Validates an issue request up to, but not including, the human proof.
 *
 * The server must run this before computing the subject hash so an invalid
 * request never reaches `verifyControlPlane`.
 */
export function validateGrantIssueRequest(
  request: GrantIssueRequest
): Result<GrantIssueRequest, ErrorEnvelope> {
  if (request.schema_version !== GRANT_ISSUE_SCHEMA_VERSION) {
    return err(fieldError("E_SCHEMA", "schema_version", GRANT_ISSUE_SCHEMA_VERSION));
  }
  if (request.issued_by !== "human") {
    return err(authDenied({ object_type: "grant", reason: "attestation", stage: "grant_issue" }));
  }
  if (!isGrantObjectTypeValue(request.object_type)) {
    return err(fieldError("E_SCHEMA", "object_type", "grant_object_type"));
  }
  if (request.mode !== "once" && request.mode !== "standing") {
    return err(fieldError("E_SCHEMA", "mode", "once_or_standing"));
  }
  if (request.actions.length === 0) {
    return err(fieldError("E_GRANT_SCOPE", "actions", "non_empty"));
  }
  for (const action of request.actions) {
    if (!isGrantActionValue(action)) {
      return err(fieldError("E_SCHEMA", "actions", "grant_action"));
    }
  }
  if (request.policy_version.length === 0) {
    return err(fieldError("E_SCHEMA", "policy_version", "non_empty"));
  }
  if (request.expires_at !== null) {
    if (!Number.isSafeInteger(request.expires_at) || request.expires_at < 0) {
      return err(fieldError("E_SCHEMA", "expires_at", "null_or_safe_integer"));
    }
  }
  if (request.mode === "once" && (request.candidate_id === null || request.candidate_hash === null)) {
    return err(fieldError("E_GRANT_SCOPE", "candidate_id", "once_requires_candidate"));
  }
  const candidate = validateCandidateForObject(request.object_type, request.candidate_id);
  if (!candidate.ok) {
    return candidate;
  }
  if (request.candidate_hash !== null && !isHash(request.candidate_hash)) {
    return err(fieldError("E_WRITE_CANDIDATE_HASH", "candidate_hash", "sha256"));
  }
  if (request.candidate_id !== null && request.candidate_hash === null) {
    return err(fieldError("E_WRITE_CANDIDATE_HASH", "candidate_hash", "required_with_candidate"));
  }
  const scope = validateGrantScope(request.scope, request.object_type);
  if (!scope.ok) {
    return scope;
  }
  return ok(request);
}

/**
 * Builds the grant after the server has verified the human proof.
 *
 * `grant_id` and `issued_at` are assigned before this call; `expires_at` must
 * be `null` or a safe integer greater than `issued_at`.
 */
export function createGrant(input: {
  request: GrantIssueRequest;
  grant_id: Id<"grant">;
  issued_at: number;
}): Result<CreatedGrant, ErrorEnvelope> {
  const validated = validateGrantIssueRequest(input.request);
  if (!validated.ok) {
    return validated;
  }
  if (!isId(input.grant_id, "grant")) {
    return err(fieldError("E_SCHEMA", "grant_id", "grant_id"));
  }
  if (!Number.isSafeInteger(input.issued_at) || input.issued_at < 0) {
    return err(fieldError("E_SCHEMA", "issued_at", "epoch_ms"));
  }
  if (input.request.expires_at !== null && input.request.expires_at <= input.issued_at) {
    return err(authDenied({
      object_type: "grant",
      reason: "expired",
      stage: "grant_issue"
    }));
  }
  const content: Omit<AuthorizationGrant, "grant_hash"> = {
    schema_version: AUTHORIZATION_GRANT_SCHEMA_VERSION,
    grant_id: input.grant_id,
    issued_by: input.request.issued_by,
    human_attestation: input.request.human_attestation,
    subject: "rsi",
    object_type: input.request.object_type,
    scope: input.request.scope,
    actions: [...input.request.actions],
    mode: input.request.mode,
    candidate_id: input.request.candidate_id,
    candidate_hash: input.request.candidate_hash,
    policy_version: input.request.policy_version,
    issued_at: input.issued_at,
    expires_at: input.request.expires_at,
    revoked_at: null
  };
  const grant: AuthorizationGrant = { ...content, grant_hash: grantHash(content) };
  return ok({ grant, subject_hash: grantIssueSubjectHash(input.request) });
}

/**
 * Applies a revoke after the human proof has been verified.
 *
 * The `expected_grant_hash` CAS runs before the write; a mismatch leaves the
 * grant untouched. Revoking a revoked grant is refused with the same
 * `E_AUTH_DENIED` shape as a failed CAS.
 */
export function revokeGrant(input: {
  grant: AuthorizationGrant;
  request: GrantRevokeRequest;
  revoked_at: number;
}): Result<AuthorizationGrant, ErrorEnvelope> {
  const { grant, request } = input;
  if (request.schema_version !== GRANT_REVOKE_SCHEMA_VERSION) {
    return err(fieldError("E_SCHEMA", "schema_version", GRANT_REVOKE_SCHEMA_VERSION));
  }
  if (request.grant_id !== grant.grant_id) {
    return err(fieldError("E_SCHEMA", "grant_id", "matches_grant"));
  }
  if (!isHash(request.expected_grant_hash)) {
    return err(fieldError("E_SCHEMA", "expected_grant_hash", "sha256"));
  }
  if (request.reason !== "human_revoked" && request.reason !== "policy_replaced") {
    return err(fieldError("E_SCHEMA", "reason", "revoke_reason"));
  }
  if (grant.revoked_at !== null) {
    return err(authDenied({
      object_type: "grant",
      reason: "revoked",
      grant_id: grant.grant_id,
      stage: "grant_revoke"
    }));
  }
  if (request.expected_grant_hash !== grant.grant_hash) {
    return err(authDenied({
      object_type: "grant",
      reason: "revoked",
      grant_id: grant.grant_id,
      stage: "grant_revoke"
    }));
  }
  if (!Number.isSafeInteger(input.revoked_at) || input.revoked_at < 0) {
    return err(fieldError("E_SCHEMA", "revoked_at", "epoch_ms"));
  }
  return ok({ ...grant, revoked_at: input.revoked_at });
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

/** Strips the human attestation; only public fields cross the boundary. */
export function toGrantPublicView(grant: AuthorizationGrant): GrantPublicView {
  return {
    grant_id: grant.grant_id,
    issued_by: grant.issued_by,
    subject: grant.subject,
    object_type: grant.object_type,
    scope: grant.scope,
    actions: [...grant.actions],
    mode: grant.mode,
    candidate_id: grant.candidate_id,
    candidate_hash: grant.candidate_hash,
    policy_version: grant.policy_version,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
    revoked_at: grant.revoked_at,
    grant_hash: grant.grant_hash
  };
}

export type GrantListState = "active" | "revoked" | "expired" | "consumed";

/**
 * `grant.list` state. `expired` uses the same predicate as write authorization:
 * only a non-null `expires_at <= now` expires.
 */
export function grantListState(
  view: GrantView,
  now: number
): GrantListState {
  if (view.grant.revoked_at !== null) {
    return "revoked";
  }
  if (view.grant.expires_at !== null && view.grant.expires_at <= now) {
    return "expired";
  }
  if (view.consumed_write_id !== null || view.consumed_config_write_id !== null) {
    return "consumed";
  }
  return "active";
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** True when `values` is strictly ascending by UTF-8 and duplicate-free. */
function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (current === undefined) {
      return false;
    }
    if (index === 0) {
      continue;
    }
    const previous = values[index - 1];
    if (previous === undefined || compareUtf8(previous, current) >= 0) {
      return false;
    }
  }
  return true;
}

function scopeJson(scope: GrantScope): JsonValue {
  const json: Record<string, JsonValue> = {
    project_ids: [...scope.project_ids],
    config_spaces: [...scope.config_spaces],
    path_globs: [...scope.path_globs],
    object_ids: [...scope.object_ids]
  };
  if (scope.config_scope !== undefined) {
    json["config_scope"] = {
      field_ids: [...scope.config_scope.field_ids],
      source_layer_ids: [...scope.config_scope.source_layer_ids],
      model_scope_keys: [...scope.config_scope.model_scope_keys]
    };
  }
  return json;
}

function attestationJson(attestation: HumanAttestation): JsonValue {
  return {
    kind: attestation.kind,
    capability_id: attestation.capability_id,
    evidence_ref: attestation.evidence_ref,
    confirmed_at: attestation.confirmed_at
  };
}

function isValidProjectId(value: string): boolean {
  if (value.length === 0 || value === "*") {
    return false;
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\u0000")) {
    return false;
  }
  return true;
}

function isGrantObjectTypeValue(value: string): value is GrantObjectType {
  return (
    value === "skill" || value === "memory" || value === "instructions" || value === "config"
  );
}

function isGrantActionValue(value: string): value is GrantAction {
  return value === "create" || value === "update" || value === "disable" || value === "rollback";
}
