/**
 * `AuthorizationGrant` issue, revoke, hashing and scope validation
 * (DD-FND-090).
 *
 * `grant_hash` covers the authorization content only. Two independent subject
 * hashes bind a human proof to either an issue or a revoke request; the server
 * recomputes them from the request fields and never accepts a client hash.
 */
import type { ErrorEnvelope, Hash, HumanAttestation, Id, JsonValue, Result } from "@evoplug/core";
import type { CandidateId, GrantAction, GrantMode, GrantObjectType, WriteDecision } from "@evoplug/core";
export type { CandidateId, GrantAction, GrantMode, GrantObjectType, WriteDecision };
export type GrantIssuer = "human" | "preconfigured_policy";
export type GrantSubject = "rsi";
export declare const AUTHORIZATION_GRANT_SCHEMA_VERSION: "rsi.authorization_grant/1";
export declare const GRANT_ISSUE_SCHEMA_VERSION: "rsi.grant_issue/1";
export declare const GRANT_REVOKE_SCHEMA_VERSION: "rsi.grant_revoke/1";
export declare const GRANT_ISSUE_SUBJECT_SCHEMA_VERSION: "rsi.grant_issue_subject/1";
export declare const GRANT_REVOKE_SUBJECT_SCHEMA_VERSION: "rsi.grant_revoke_subject/1";
/** Reserved `project_ids` value matching a task with `project_id = null`. */
export declare const USER_PROJECT_SCOPE = "user";
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
export interface CreatedGrant {
    grant: AuthorizationGrant;
    subject_hash: Hash;
}
/** `grant_hash = sha256(JCS(<whitelist>))`; identity and time fields excluded. */
export declare function grantHash(grant: Omit<AuthorizationGrant, "grant_hash">): Hash;
/** The exact JCS preimage of `grant_hash` (DD-FND-090 whitelist). */
export declare function grantHashPreimage(grant: Omit<AuthorizationGrant, "grant_hash">): JsonValue;
/** True when the stored `grant_hash` matches a recomputation. */
export declare function verifyGrantHash(grant: AuthorizationGrant): boolean;
/** The issue subject bound by a human proof; every field is required. */
export declare function grantIssueSubject(request: GrantIssueRequest): JsonValue;
/** `attestation_subject_hash` for `purpose="grant_issue"`. */
export declare function grantIssueSubjectHash(request: GrantIssueRequest): Hash;
/** The revoke subject; `grant_id` is bound separately from `grant_hash`. */
export declare function grantRevokeSubject(request: GrantRevokeRequest): JsonValue;
/** `attestation_subject_hash` for `purpose="grant_revoke"`. */
export declare function grantRevokeSubjectHash(request: GrantRevokeRequest): Hash;
export interface ScopeValidationOptions {
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
export declare function validateGrantScope(scope: GrantScope, objectType: GrantObjectType, options?: ScopeValidationOptions): Result<GrantScope, ErrorEnvelope>;
/** Validates a candidate id against its object type. */
export declare function validateCandidateForObject(objectType: GrantObjectType, candidateId: CandidateId | null): Result<CandidateId | null, ErrorEnvelope>;
/**
 * Validates an issue request up to, but not including, the human proof.
 *
 * The server must run this before computing the subject hash so an invalid
 * request never reaches `verifyControlPlane`.
 */
export declare function validateGrantIssueRequest(request: GrantIssueRequest): Result<GrantIssueRequest, ErrorEnvelope>;
/**
 * Builds the grant after the server has verified the human proof.
 *
 * `grant_id` and `issued_at` are assigned before this call; `expires_at` must
 * be `null` or a safe integer greater than `issued_at`.
 */
export declare function createGrant(input: {
    request: GrantIssueRequest;
    grant_id: Id<"grant">;
    issued_at: number;
}): Result<CreatedGrant, ErrorEnvelope>;
/**
 * Applies a revoke after the human proof has been verified.
 *
 * The `expected_grant_hash` CAS runs before the write; a mismatch leaves the
 * grant untouched. Revoking a revoked grant is refused with the same
 * `E_AUTH_DENIED` shape as a failed CAS.
 */
export declare function revokeGrant(input: {
    grant: AuthorizationGrant;
    request: GrantRevokeRequest;
    revoked_at: number;
}): Result<AuthorizationGrant, ErrorEnvelope>;
/** Strips the human attestation; only public fields cross the boundary. */
export declare function toGrantPublicView(grant: AuthorizationGrant): GrantPublicView;
export type GrantListState = "active" | "revoked" | "expired" | "consumed";
/**
 * `grant.list` state. `expired` uses the same predicate as write authorization:
 * only a non-null `expires_at <= now` expires.
 */
export declare function grantListState(view: GrantView, now: number): GrantListState;
/** True when `values` is strictly ascending by UTF-8 and duplicate-free. */
export declare function isSortedUnique(values: readonly string[]): boolean;
