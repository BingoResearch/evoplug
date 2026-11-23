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
import { readActiveBudgetPolicy } from "@evoplug/storage";
import type { SqliteConnection } from "@evoplug/storage";

import type { BudgetAvailabilityPort } from "./online-pipeline.js";

/** Reads and verifies the single active budget policy. */
export function activeBudgetPolicyAvailable(
  connection: SqliteConnection
): Result<boolean, ErrorEnvelope> {
  const row = readActiveBudgetPolicy(connection);
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
