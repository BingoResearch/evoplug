/**
 * `BudgetAvailabilityPort` over the active `budget_policy` row
 * (DD-FND-080.1).
 *
 * The online decision only needs to know whether a usable active policy
 * exists. `true` requires exactly one active row whose canonical JSON parses as
 * `rsi.budget_policy/1` and whose stored `content_hash` still matches. Missing
 * rows and malformed rows both report `false`; no policy is synthesized.
 */

import { budgetPolicyContentHash, parseBudgetPolicy } from "@evoplug/budget";
import type { ErrorEnvelope, Result } from "@evoplug/core";
import { ok } from "@evoplug/core";
import type { SqliteConnection, SqlRow } from "@evoplug/storage";

import type { BudgetAvailabilityPort } from "./online-pipeline.js";

const ACTIVE_POLICY_SQL =
  "SELECT policy_version, canonical_json, content_hash FROM budget_policy WHERE active = 1";

interface PolicyRow {
  readonly policy_version: string;
  readonly canonical_json: string;
  readonly content_hash: string;
}

function policyRow(row: SqlRow): PolicyRow | null {
  const policyVersion = row["policy_version"];
  const canonicalJson = row["canonical_json"];
  const contentHash = row["content_hash"];
  if (
    typeof policyVersion !== "string" ||
    typeof canonicalJson !== "string" ||
    typeof contentHash !== "string"
  ) {
    return null;
  }
  return { policy_version: policyVersion, canonical_json: canonicalJson, content_hash: contentHash };
}

/** Reads and verifies the single active budget policy. */
export function activeBudgetPolicyAvailable(
  connection: SqliteConnection
): Result<boolean, ErrorEnvelope> {
  const rows = connection.prepare<SqlRow>(ACTIVE_POLICY_SQL).all();
  if (rows.length !== 1) return ok(false);
  const row = policyRow(rows[0] as SqlRow);
  if (row === null || row.policy_version !== "bpol/1") return ok(false);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(row.canonical_json) as unknown;
  } catch {
    return ok(false);
  }
  const parsed = parseBudgetPolicy(parsedJson);
  if (!parsed.ok) return ok(false);
  if (budgetPolicyContentHash(parsed.value) !== row.content_hash) return ok(false);
  return ok(true);
}

export function createBudgetAvailabilityPort(
  connection: SqliteConnection
): BudgetAvailabilityPort {
  return {
    async available(): Promise<Result<boolean, ErrorEnvelope>> {
      return activeBudgetPolicyAvailable(connection);
    }
  };
}
