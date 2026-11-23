/**
 * Policy records (精简设计 §3.1): `config_profile`, `budget_policy` and
 * `egress_policy` live as kinds in the shared `policy_record` store. Kind
 * registration owns required fields, enums and uniqueness; the write layer
 * enforces them, so no view or INSTEAD OF trigger is needed.
 */

import type { Hash } from "@evoplug/core";
import type { RecordDefinition, RecordRow } from "./records.js";
import { RecordRepository } from "./records.js";
import type { StatementSource } from "../types.js";

export const POLICY_STORE = "policy_record" as const;

const CONFIG_PROFILE_STATUS = ["active", "superseded"] as const;

function isRecordBody(body: Readonly<Record<string, unknown>>): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function hasString(body: Readonly<Record<string, unknown>>, field: string): boolean {
  return typeof body[field] === "string" && (body[field] as string).length > 0;
}

function hasHash(body: Readonly<Record<string, unknown>>, field: string): boolean {
  return hasString(body, field) && (body[field] as string).startsWith("sha256:");
}

function validateConfigProfile(body: Readonly<Record<string, unknown>>): boolean {
  return (
    hasString(body, "config_version") &&
    hasString(body, "config_space") &&
    hasString(body, "canonical_json") &&
    hasHash(body, "content_hash") &&
    (CONFIG_PROFILE_STATUS as readonly unknown[]).includes(body["status"]) &&
    typeof body["created_at"] === "number"
  );
}

function validateBudgetPolicy(body: Readonly<Record<string, unknown>>): boolean {
  return (
    hasString(body, "policy_version") &&
    hasString(body, "canonical_json") &&
    hasHash(body, "content_hash") &&
    (body["active"] === 0 || body["active"] === 1) &&
    typeof body["created_at"] === "number"
  );
}

function validateEgressPolicy(body: Readonly<Record<string, unknown>>): boolean {
  return (
    hasString(body, "policy_version") &&
    hasString(body, "canonical_json") &&
    hasHash(body, "policy_hash") &&
    (body["active"] === 0 || body["active"] === 1) &&
    typeof body["created_at"] === "number"
  );
}

/** Kind registry for the policy domain. */
export const POLICY_RECORD_DEFINITIONS: readonly RecordDefinition[] = Object.freeze([
  {
    kind: "config_profile",
    validate: (body) => isRecordBody(body) && validateConfigProfile(body),
    unique: [{ fields: ["config_space"], when: { status: "active" } }]
  },
  {
    kind: "budget_policy",
    validate: (body) => isRecordBody(body) && validateBudgetPolicy(body),
    unique: [{ fields: ["active"], when: { active: 1 } }]
  },
  {
    kind: "egress_policy",
    validate: (body) => isRecordBody(body) && validateEgressPolicy(body),
    unique: [{ fields: ["active"], when: { active: 1 } }]
  }
]);

export function policyRepository(source: StatementSource): RecordRepository {
  return new RecordRepository(source, POLICY_RECORD_DEFINITIONS);
}

export interface ConfigProfileRecord {
  readonly config_version: string;
  readonly config_space: string;
  readonly canonical_json: string;
  readonly content_hash: Hash;
  readonly status: "active" | "superseded";
  readonly created_at: number;
}

export interface BudgetPolicyRecord {
  readonly policy_version: string;
  readonly canonical_json: string;
  readonly content_hash: Hash;
  readonly active: number;
  readonly created_at: number;
}

export interface EgressPolicyRecord {
  readonly policy_version: string;
  readonly canonical_json: string;
  readonly policy_hash: Hash;
  readonly active: number;
  readonly created_at: number;
}

function bodyOf<T>(row: RecordRow): T {
  return row.body as unknown as T;
}

/** Active config profiles, optionally constrained to one config space. */
export function listActiveConfigProfiles(
  source: StatementSource,
  configSpace?: string,
  repository: RecordRepository = policyRepository(source)
): readonly ConfigProfileRecord[] {
  const rows = repository.listByKind(POLICY_STORE, "config_profile");
  if (!rows.ok) return [];
  return rows.value
    .map((row) => bodyOf<ConfigProfileRecord>(row))
    .filter((row) => row.status === "active")
    .filter((row) => configSpace === undefined || row.config_space === configSpace)
    .sort((left, right) => right.created_at - left.created_at);
}

/** Latest active config profile, optionally constrained to one config space. */
export function readActiveConfigProfile(
  source: StatementSource,
  configSpace?: string,
  repository: RecordRepository = policyRepository(source)
): ConfigProfileRecord | null {
  return listActiveConfigProfiles(source, configSpace, repository)[0] ?? null;
}

export function readActiveBudgetPolicy(
  source: StatementSource,
  repository: RecordRepository = policyRepository(source)
): BudgetPolicyRecord | null {
  const rows = repository.listByKind(POLICY_STORE, "budget_policy");
  if (!rows.ok) return null;
  const active = rows.value
    .map((row) => bodyOf<BudgetPolicyRecord>(row))
    .filter((row) => row.active === 1);
  return active.length === 1 ? active[0] ?? null : null;
}

export function readActiveEgressPolicy(
  source: StatementSource,
  repository: RecordRepository = policyRepository(source)
): EgressPolicyRecord | null {
  const rows = repository.listByKind(POLICY_STORE, "egress_policy");
  if (!rows.ok) return null;
  const active = rows.value
    .map((row) => bodyOf<EgressPolicyRecord>(row))
    .filter((row) => row.active === 1);
  return active.length === 1 ? active[0] ?? null : null;
}

export interface ActivateConfigProfileInput {
  readonly config_space: string;
  readonly config_version: string;
  readonly canonical_json: string;
  readonly content_hash: Hash;
  readonly created_at: number;
}

/**
 * Activates one config profile: older active rows in the same space become
 * `superseded`, and the version row is inserted once. Runs inside the caller's
 * transaction so the supersede/insert pair stays atomic.
 */
export function activateConfigProfile(
  source: StatementSource,
  input: ActivateConfigProfileInput,
  repository: RecordRepository = policyRepository(source)
): void {
  const rows = repository.listByKind(POLICY_STORE, "config_profile");
  if (rows.ok) {
    for (const row of rows.value) {
      const body = bodyOf<ConfigProfileRecord>(row);
      if (
        body.status !== "active" ||
        body.config_space !== input.config_space ||
        body.config_version === input.config_version
      ) {
        continue;
      }
      repository.updateBody({
        store: POLICY_STORE,
        kind: "config_profile",
        key: body.config_version,
        body: { ...body, status: "superseded" }
      });
    }
  }
  const existing = repository.get({
    store: POLICY_STORE,
    kind: "config_profile",
    key: input.config_version
  });
  if (existing.ok && existing.value !== null) {
    // Re-activating a version that was superseded earlier must restore it.
    // Returning early here used to leave the space with no active profile when
    // the same config was written twice (for example a re-attach), and every
    // event for that space then failed with `E_VERSION_BINDING`.
    const body = bodyOf<ConfigProfileRecord>(existing.value);
    if (body.status !== "active") {
      repository.updateBody({
        store: POLICY_STORE,
        kind: "config_profile",
        key: input.config_version,
        body: {
          ...body,
          canonical_json: input.canonical_json,
          content_hash: input.content_hash,
          status: "active"
        }
      });
    }
    return;
  }
  repository.put({
    store: POLICY_STORE,
    kind: "config_profile",
    key: input.config_version,
    body: {
      config_version: input.config_version,
      config_space: input.config_space,
      canonical_json: input.canonical_json,
      content_hash: input.content_hash,
      status: "active",
      created_at: input.created_at
    },
    created_at: input.created_at
  });
}
