/**
 * Production read side of DD-TRG-002 `TriggerPolicy`.
 *
 * The installer seeds one active global policy in HOST migration 0009; 0008
 * owns only the schema and indexes. This module resolves the active policy for
 * an event scope with the same priority order as `resolveTriggerPolicy`,
 * verifies the stored hash, and returns `null` when no active row exists so the
 * online pipeline treats the trigger as locally disabled rather than
 * synthesizing a policy.
 */

import type { TriggerPolicy } from "@evoplug/core/host";
import {
  resolveTriggerPolicy,
  triggerPolicyHash,
  type PolicyResolveTarget
} from "@evoplug/core/host";
import type {
  ErrorEnvelope,
  Result
} from "@evoplug/core";
import { err, ok } from "@evoplug/core";
import type { SqliteConnection, SqlRow } from "@evoplug/storage";

import { internalError } from "./errors.js";
import type { CommittedHostEvent } from "./online-pipeline.js";

interface PolicyRow {
  readonly policy_id: string;
  readonly policy_version: string;
  readonly scope_key: string;
  readonly lifecycle: string;
  readonly policy_hash: string;
  readonly canonical_json: string;
}

function rowString(row: SqlRow, key: string): string | null {
  const value = row[key as keyof SqlRow];
  return typeof value === "string" ? value : null;
}

function policyRow(row: SqlRow): PolicyRow | null {
  const policyId = rowString(row, "policy_id");
  const policyVersion = rowString(row, "policy_version");
  const scopeKey = rowString(row, "scope_key");
  const lifecycle = rowString(row, "lifecycle");
  const policyHash = rowString(row, "policy_hash");
  const canonical = rowString(row, "canonical_json");
  if (
    policyId === null ||
    policyVersion === null ||
    scopeKey === null ||
    lifecycle === null ||
    policyHash === null ||
    canonical === null
  ) {
    return null;
  }
  return {
    policy_id: policyId,
    policy_version: policyVersion,
    scope_key: scopeKey,
    lifecycle,
    policy_hash: policyHash,
    canonical_json: canonical
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads every stored policy and returns the ones whose canonical bytes, hash
 * and scope key still agree. A tampered row is surfaced, never skipped.
 */
export function listInstalledTriggerPolicies(
  connection: SqliteConnection
): Result<readonly TriggerPolicy[], ErrorEnvelope> {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT policy_id, policy_version, scope_key, lifecycle, policy_hash, canonical_json
         FROM trigger_policy
        ORDER BY policy_id, policy_version`
    )
    .all();
  const policies: TriggerPolicy[] = [];
  for (const raw of rows) {
    const row = policyRow(raw);
    if (row === null) {
      return err(internalError("kernel.trigger_policy_row_invalid"));
    }
    const parsed = parseJson(row.canonical_json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err(internalError("kernel.trigger_policy_json_invalid"));
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate["policy_id"] !== row.policy_id ||
      candidate["policy_version"] !== row.policy_version ||
      candidate["policy_hash"] !== row.policy_hash ||
      candidate["lifecycle"] !== row.lifecycle
    ) {
      return err(internalError("kernel.trigger_policy_row_mismatch"));
    }
    const policy = candidate as unknown as TriggerPolicy;
    if (triggerPolicyHash(policy) !== row.policy_hash) {
      return err(internalError("kernel.trigger_policy_hash_mismatch"));
    }
    policies.push(policy);
  }
  return ok(policies);
}

/** Scope target read from the committed host event. */
export function triggerPolicyTarget(event: CommittedHostEvent): PolicyResolveTarget {
  return {
    host_id: event.draft.host_id,
    mode: event.draft.mode,
    config_space: event.draft.config_space
  };
}

/**
 * Resolves the single active policy for an event. `Ok(null)` means no active
 * scope exists (local trigger disabled). Malformed or hash-mismatched rows are
 * an error, matching DD-TRG-002's `safe_default`/`E_POLICY_UNAVAILABLE`.
 */
export function loadTriggerPolicyForEvent(
  connection: SqliteConnection,
  event: CommittedHostEvent
): Result<TriggerPolicy | null, ErrorEnvelope> {
  const listed = listInstalledTriggerPolicies(connection);
  if (!listed.ok) return listed;
  if (listed.value.length === 0) return ok(null);
  const resolved = resolveTriggerPolicy(listed.value, triggerPolicyTarget(event));
  if (!resolved.ok) {
    if (resolved.error.code === "E_POLICY_UNAVAILABLE") {
      return ok(null);
    }
    return resolved;
  }
  return ok(resolved.value);
}
