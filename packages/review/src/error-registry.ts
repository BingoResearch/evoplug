/**
 * REV error registry fragment (DD-REV-153).
 *
 * The machine fragment is `schemas/errors/fragments/rev.json`; that path is
 * owned by FND, so the same 83 rows are published here for the package and
 * for the integration merge. 82 canonical rows generate `ErrorCode`; the one
 * frozen alias row never appears at runtime.
 */

import type { ErrorCategory } from "@evoplug/core";

type RevDetailsKind =
  | "authorization"
  | "budget"
  | "conflict"
  | "egress"
  | "external"
  | "field"
  | "idempotency"
  | "ipc"
  | "none"
  | "source"
  | "version";

interface RevErrorRegistryRow {
  readonly owner: "rev";
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable_default: boolean;
  readonly side_effect_allowed: boolean;
  readonly details_kind: RevDetailsKind;
  readonly stage: string;
  readonly replacement: string | null;
  readonly since: "2026-10-21" | "2026-10-26";
  readonly deprecated: boolean;
  readonly aliases: readonly string[];
  readonly source: "DD-REV-153" | "W8";
  readonly details_schema: string;
}

const REV_DETAILS_SCHEMA_PREFIX = "urn:evoplug:schema:error-details:" as const;
const REV_DETAILS_SCHEMA_SUFFIX = ":1" as const;

function row(
  code: string,
  category: ErrorCategory,
  retryable_default: boolean,
  side_effect_allowed: boolean,
  details_kind: RevDetailsKind,
  stage: string,
  replacement: string | null,
  deprecated: boolean,
  aliases: readonly string[]
): RevErrorRegistryRow {
  return {
    owner: "rev",
    code,
    category,
    retryable_default,
    side_effect_allowed,
    details_kind,
    stage,
    replacement,
    since: "2026-10-21",
    deprecated,
    aliases,
    source: "DD-REV-153",
    details_schema: `${REV_DETAILS_SCHEMA_PREFIX}${details_kind}${REV_DETAILS_SCHEMA_SUFFIX}`
  };
}

/** All 84 fragment rows: 83 canonical plus the frozen alias row. */
export const REV_ERROR_REGISTRY_ROWS: readonly RevErrorRegistryRow[] = [
  row("E_REVIEW_BACKEND_AUTH", "authorization", false, false, "authorization", "backend_auth", null, false, []),
  row("E_REVIEW_BACKEND_CAPABILITY", "version", true, false, "version", "backend_select", null, false, []),
  row("E_REVIEW_BACKEND_EXIT", "external", true, true, "external", "backend_run", null, false, []),
  row("E_REVIEW_BACKEND_SPAWN", "external", true, true, "external", "backend_spawn", null, false, []),
  row("E_REVIEW_BACKEND_TIMEOUT", "deadline", true, true, "external", "backend_run", null, false, []),
  row("E_REVIEW_BACKEND_UNAVAILABLE", "external", true, false, "external", "backend_select", null, false, []),
  row("E_REVIEW_BOUNDARY_PENDING", "conflict", false, false, "field", "trigger_validate", null, false, []),
  row("E_REVIEW_BUDGET_EXHAUSTED", "budget", false, true, "budget", "budget_claim", null, false, []),
  row("E_REVIEW_BUDGET_INVALID", "budget", false, false, "budget", "snapshot_validate", null, false, []),
  row("E_REVIEW_BUDGET_LEDGER_MISMATCH", "budget", false, true, "budget", "budget_reconcile", null, false, []),
  row("E_REVIEW_CANCELLED", "conflict", false, true, "none", "cancel", null, false, []),
  row("E_REVIEW_CONCURRENT_UPDATE", "conflict", true, false, "conflict", "state_write", null, false, []),
  row("E_REVIEW_CREDENTIAL_LEAK", "authorization", false, false, "field", "input_validate", null, false, []),
  row("E_REVIEW_EGRESS_NOT_APPROVED", "authorization", true, false, "egress", "snapshot_validate", null, false, []),
  row("E_REVIEW_EXIT_TIMEOUT", "deadline", true, true, "external", "backend_run", null, false, []),
  row("E_REVIEW_FENCING_STALE", "conflict", false, true, "version", "accept_output", null, false, []),
  row("E_REVIEW_GOAL_UNAVAILABLE", "ipc", true, false, "ipc", "snapshot_validate", null, false, []),
  row("E_REVIEW_ILLEGAL_ATTEMPT_TRANSITION", "usage", false, false, "field", "attempt_transition", null, false, []),
  row("E_REVIEW_INPUT_PATH", "authorization", false, false, "field", "input_validate", null, false, []),
  row("E_REVIEW_INPUT_TOO_LARGE", "source", false, false, "source", "input_validate", null, false, []),
  row("E_REVIEW_LEASE_EXPIRED", "deadline", true, true, "version", "lease", null, false, []),
  row("E_REVIEW_NO_VERIFIER", "policy", false, false, "none", "begin_trial", null, false, []),
  row("E_REVIEW_ORPHAN_UNKNOWN", "conflict", false, true, "field", "recovery", null, false, []),
  row("E_REVIEW_OUTPUT_AFTER_TERMINAL", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_BAD_JSON", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_BAD_UTF8", "source", false, true, "source", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_COUNT_MISMATCH", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_DUPLICATE_ORDINAL", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_LINE_TOO_LARGE", "source", false, true, "source", "output_read", null, false, []),
  row("E_REVIEW_OUTPUT_MULTIPLE_TERMINAL", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_ORDINAL_GAP", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_POLICY_INVALID", "policy", false, false, "field", "snapshot_validate", null, false, []),
  row("E_REVIEW_OUTPUT_READ_MISMATCH", "conflict", false, true, "conflict", "output_read", null, false, []),
  row("E_REVIEW_OUTPUT_START", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_TOO_LARGE", "source", false, true, "source", "output_read", null, false, []),
  row("E_REVIEW_OUTPUT_TOO_MANY_LINES", "source", false, true, "source", "output_read", null, false, []),
  row("E_REVIEW_OUTPUT_TOO_MANY_PROGRESS", "capacity", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_TOO_MANY_PROPOSALS", "capacity", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_TRUNCATED", "source", true, true, "source", "output_parse", null, false, []),
  row("E_REVIEW_OUTPUT_UNKNOWN_EVENT", "schema", false, true, "field", "output_parse", null, false, []),
  row("E_REVIEW_PROVIDER_COST_OVERAGE", "budget", false, true, "budget", "budget_reconcile", null, false, []),
  row("E_REVIEW_QUOTA_POLICY_UNAVAILABLE", "version", true, false, "version", "snapshot_validate", null, false, []),
  row("E_REVIEW_ROLLBACK_CONFLICT", "conflict", false, false, "conflict", "rollback", null, false, []),
  row("E_REVIEW_SNAPSHOT_COLLISION", "conflict", false, false, "conflict", "snapshot_validate", null, false, []),
  row("E_REVIEW_SNAPSHOT_INVALID", "schema", false, false, "field", "snapshot_validate", null, false, []),
  row("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "source", false, false, "source", "snapshot_validate", null, false, []),
  row("E_REVIEW_SNAPSHOT_STALE", "version", false, false, "version", "snapshot_validate", null, false, []),
  row("E_REVIEW_SUPERSEDE_INVALID", "usage", false, false, "field", "job_supersede", null, false, []),
  row("E_REVIEW_TRIGGER_INVALID", "schema", false, false, "field", "trigger_validate", null, false, []),
  row("E_REVIEW_WINDOW_LIMIT", "capacity", false, false, "field", "extend_window", null, false, []),
  {
    owner: "rev",
    code: "E_ROLLBACK_TARGET_UNRESOLVED",
    category: "not_found",
    retryable_default: false,
    side_effect_allowed: false,
    details_kind: "none",
    stage: "rollback_resolution",
    replacement: null,
    since: "2026-10-26",
    deprecated: false,
    aliases: [],
    source: "W8",
    details_schema: "urn:evoplug:schema:error-details:none:1"
  },
  row("E_ILLEGAL_REVIEW_JOB_TRANSITION", "usage", false, false, "field", "job_transition", null, false, ["E_ILLEGAL_REVIEW_TRANSITION"]),
  row("E_ILLEGAL_REVIEW_TRANSITION", "usage", false, false, "field", "migration", "E_ILLEGAL_REVIEW_JOB_TRANSITION", true, []),
  row("E_PROPOSAL_ADOPTION_MISMATCH", "conflict", false, false, "conflict", "adoption", null, false, []),
  row("E_PROPOSAL_BINDING", "version", false, false, "version", "proposal_ingest", null, false, []),
  row("E_PROPOSAL_DIFF_APPLY", "conflict", false, false, "field", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_DIFF_MISMATCH", "conflict", false, false, "conflict", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_DIFF_TOO_LARGE", "source", false, false, "source", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_DUPLICATE_ORDINAL", "schema", false, false, "field", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_EVIDENCE_NOT_ALLOWED", "authorization", false, false, "egress", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_GENERATOR_MISMATCH", "version", false, false, "version", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_ILLEGAL_TRANSITION", "usage", false, false, "field", "adoption", null, false, []),
  row("E_PROPOSAL_NO_CHANGE", "usage", false, false, "field", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_OLD_HASH_MISMATCH", "conflict", false, false, "conflict", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_OLD_HASH_MISSING", "schema", false, false, "field", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_PROTECTED_FIELD", "policy", false, false, "field", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_SCHEMA", "schema", false, false, "field", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_SCOPE", "policy", false, false, "field", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_STALE_TARGET", "conflict", false, false, "conflict", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_TARGET", "authorization", false, false, "authorization", "proposal_static_check", null, false, []),
  row("E_PROPOSAL_UNTRUSTED_FIELD", "schema", false, false, "field", "proposal_static_check", null, false, []),
  row("E_HANDOFF_CONFLICT", "conflict", false, true, "conflict", "handoff_finalize", null, false, []),
  row("E_HANDOFF_INCOMPLETE", "schema", false, true, "field", "handoff_finalize", null, false, []),
  row("E_HANDOFF_NOT_READY", "conflict", true, false, "field", "handoff_read", null, false, []),
  row("E_HANDOFF_PAYLOAD_INVALID", "schema", false, false, "field", "handoff_read", null, false, []),
  row("E_HANDOFF_PROPOSAL_MISMATCH", "conflict", false, false, "field", "handoff_read", null, false, []),
  row("E_EXPERIENCE_EVENT_CONFLICT", "conflict", false, true, "conflict", "lifecycle", null, false, []),
  row("E_EXPERIENCE_HOST_FACTS_UNAVAILABLE", "ipc", true, false, "ipc", "lifecycle_evaluate", null, false, []),
  row("E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION", "usage", false, false, "field", "lifecycle", null, false, []),
  row("E_EXPERIENCE_PLAN_SOURCE_CHANGED", "source", false, false, "source", "static_check", null, false, []),
  row("E_EXPERIENCE_SCHEMA", "schema", false, false, "field", "static_check", null, false, []),
  row("E_EXPERIENCE_TOO_LARGE", "source", false, false, "source", "static_check", null, false, []),
  row("E_EXPERIENCE_USAGE_KEY_COLLISION", "conflict", false, true, "idempotency", "usage_record", null, false, []),
  row("E_EXPERIENCE_VERIFIER_BINDING", "version", false, false, "version", "static_check", null, false, []),];

/** Canonical codes only; the alias row is excluded. */
export const REV_CANONICAL_ERROR_CODES: readonly string[] = REV_ERROR_REGISTRY_ROWS
  .filter((entry) => !entry.deprecated)
  .map((entry) => entry.code);

export type RevOwnedErrorCode =
  | "E_REVIEW_BACKEND_AUTH"
  | "E_REVIEW_BACKEND_CAPABILITY"
  | "E_REVIEW_BACKEND_EXIT"
  | "E_REVIEW_BACKEND_SPAWN"
  | "E_REVIEW_BACKEND_TIMEOUT"
  | "E_REVIEW_BACKEND_UNAVAILABLE"
  | "E_REVIEW_BOUNDARY_PENDING"
  | "E_REVIEW_BUDGET_EXHAUSTED"
  | "E_REVIEW_BUDGET_INVALID"
  | "E_REVIEW_BUDGET_LEDGER_MISMATCH"
  | "E_REVIEW_CANCELLED"
  | "E_REVIEW_CONCURRENT_UPDATE"
  | "E_REVIEW_CREDENTIAL_LEAK"
  | "E_REVIEW_EGRESS_NOT_APPROVED"
  | "E_REVIEW_EXIT_TIMEOUT"
  | "E_REVIEW_FENCING_STALE"
  | "E_REVIEW_GOAL_UNAVAILABLE"
  | "E_REVIEW_ILLEGAL_ATTEMPT_TRANSITION"
  | "E_REVIEW_INPUT_PATH"
  | "E_REVIEW_INPUT_TOO_LARGE"
  | "E_REVIEW_LEASE_EXPIRED"
  | "E_REVIEW_NO_VERIFIER"
  | "E_REVIEW_ORPHAN_UNKNOWN"
  | "E_REVIEW_OUTPUT_AFTER_TERMINAL"
  | "E_REVIEW_OUTPUT_BAD_JSON"
  | "E_REVIEW_OUTPUT_BAD_UTF8"
  | "E_REVIEW_OUTPUT_COUNT_MISMATCH"
  | "E_REVIEW_OUTPUT_DUPLICATE_ORDINAL"
  | "E_REVIEW_OUTPUT_LINE_TOO_LARGE"
  | "E_REVIEW_OUTPUT_MULTIPLE_TERMINAL"
  | "E_REVIEW_OUTPUT_ORDINAL_GAP"
  | "E_REVIEW_OUTPUT_POLICY_INVALID"
  | "E_REVIEW_OUTPUT_READ_MISMATCH"
  | "E_REVIEW_OUTPUT_START"
  | "E_REVIEW_OUTPUT_TOO_LARGE"
  | "E_REVIEW_OUTPUT_TOO_MANY_LINES"
  | "E_REVIEW_OUTPUT_TOO_MANY_PROGRESS"
  | "E_REVIEW_OUTPUT_TOO_MANY_PROPOSALS"
  | "E_REVIEW_OUTPUT_TRUNCATED"
  | "E_REVIEW_OUTPUT_UNKNOWN_EVENT"
  | "E_REVIEW_PROVIDER_COST_OVERAGE"
  | "E_REVIEW_QUOTA_POLICY_UNAVAILABLE"
  | "E_REVIEW_ROLLBACK_CONFLICT"
  | "E_REVIEW_SNAPSHOT_COLLISION"
  | "E_REVIEW_SNAPSHOT_INVALID"
  | "E_REVIEW_SNAPSHOT_SOURCE_MISSING"
  | "E_REVIEW_SNAPSHOT_STALE"
  | "E_REVIEW_SUPERSEDE_INVALID"
  | "E_REVIEW_TRIGGER_INVALID"
  | "E_REVIEW_WINDOW_LIMIT"
  | "E_ROLLBACK_TARGET_UNRESOLVED"
  | "E_ILLEGAL_REVIEW_JOB_TRANSITION"
  | "E_PROPOSAL_ADOPTION_MISMATCH"
  | "E_PROPOSAL_BINDING"
  | "E_PROPOSAL_DIFF_APPLY"
  | "E_PROPOSAL_DIFF_MISMATCH"
  | "E_PROPOSAL_DIFF_TOO_LARGE"
  | "E_PROPOSAL_DUPLICATE_ORDINAL"
  | "E_PROPOSAL_EVIDENCE_NOT_ALLOWED"
  | "E_PROPOSAL_GENERATOR_MISMATCH"
  | "E_PROPOSAL_ILLEGAL_TRANSITION"
  | "E_PROPOSAL_NO_CHANGE"
  | "E_PROPOSAL_OLD_HASH_MISMATCH"
  | "E_PROPOSAL_OLD_HASH_MISSING"
  | "E_PROPOSAL_PROTECTED_FIELD"
  | "E_PROPOSAL_SCHEMA"
  | "E_PROPOSAL_SCOPE"
  | "E_PROPOSAL_STALE_TARGET"
  | "E_PROPOSAL_TARGET"
  | "E_PROPOSAL_UNTRUSTED_FIELD"
  | "E_HANDOFF_CONFLICT"
  | "E_HANDOFF_INCOMPLETE"
  | "E_HANDOFF_NOT_READY"
  | "E_HANDOFF_PAYLOAD_INVALID"
  | "E_HANDOFF_PROPOSAL_MISMATCH"
  | "E_EXPERIENCE_EVENT_CONFLICT"
  | "E_EXPERIENCE_HOST_FACTS_UNAVAILABLE"
  | "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION"
  | "E_EXPERIENCE_PLAN_SOURCE_CHANGED"
  | "E_EXPERIENCE_SCHEMA"
  | "E_EXPERIENCE_TOO_LARGE"
  | "E_EXPERIENCE_USAGE_KEY_COLLISION"
  | "E_EXPERIENCE_VERIFIER_BINDING";

/** Frozen alias mapping; runtime never emits the alias. */
const REV_ERROR_ALIASES: Readonly<Record<string, string>> = {
  E_ILLEGAL_REVIEW_TRANSITION: "E_ILLEGAL_REVIEW_JOB_TRANSITION"
};

const ROW_BY_CODE: ReadonlyMap<string, RevErrorRegistryRow> = new Map(
  REV_ERROR_REGISTRY_ROWS.map((entry) => [entry.code, entry])
);

export function revErrorRow(code: string): RevErrorRegistryRow {
  const entry = ROW_BY_CODE.get(code);
  if (entry === undefined) {
    throw new RangeError(`unknown REV error code ${code}`);
  }
  return entry;
}

export function isRevRegistryCode(code: string): boolean {
  return ROW_BY_CODE.has(code);
}

/** Resolves a possibly-aliased code to its canonical form. */
export function canonicalRevCode(code: string): string {
  return REV_ERROR_ALIASES[code] ?? code;
}

/* ------------------------------------------------------------------ */
/* FND registry merge (DD-FND-103)                                     */
/* ------------------------------------------------------------------ */

type ErrorRegistryOwner = "fnd" | "qp" | "cfg" | "evd" | "rev" | "host";

interface ErrorRegistryEntry {
  readonly code: string;
  readonly owner: ErrorRegistryOwner;
  readonly category: ErrorCategory;
  readonly retryable_default: boolean;
  readonly side_effect_allowed: boolean;
  readonly replacement: string | null;
  readonly since: string;
  readonly deprecated: boolean;
  readonly details_kind: RevDetailsKind;
  readonly details_schema: string;
  readonly stage: string;
  readonly aliases: readonly string[];
  readonly source: string;
}

interface ErrorRegistry {
  readonly schema_version: "rsi.error_registry/1";
  readonly entries: readonly ErrorRegistryEntry[];
}

const REGISTRY_ENTRY_KEYS: readonly string[] = [
  "code",
  "owner",
  "category",
  "retryable_default",
  "side_effect_allowed",
  "replacement",
  "since",
  "deprecated",
  "details_kind",
  "details_schema",
  "stage",
  "aliases",
  "source"
];

const REGISTRY_SOURCE_PREFIX: Readonly<Record<ErrorRegistryOwner, readonly string[]>> = {
  fnd: ["DD-FND-"],
  qp: ["DD-QP-"],
  cfg: ["DD-CFG-"],
  evd: ["DD-EVD-"],
  rev: ["DD-REV-"],
  host: ["DD-HOST-", "DD-TRG-"]
};

function isRegistryOwner(value: string): value is ErrorRegistryOwner {
  switch (value) {
    case "fnd":
    case "qp":
    case "cfg":
    case "evd":
    case "rev":
    case "host":
      return true;
    default:
      return false;
  }
}

function isRegistryCategory(value: string): value is ErrorCategory {
  switch (value) {
    case "usage":
    case "schema":
    case "version":
    case "not_found":
    case "policy":
    case "authorization":
    case "budget":
    case "deadline":
    case "source":
    case "conflict":
    case "storage":
    case "ipc":
    case "capacity":
    case "external":
      return true;
    default:
      return false;
  }
}

function isRegistryDetailsKind(value: string): value is RevDetailsKind {
  switch (value) {
    case "authorization":
    case "budget":
    case "conflict":
    case "egress":
    case "external":
    case "field":
    case "idempotency":
    case "ipc":
    case "none":
    case "source":
    case "version":
      return true;
    default:
      return false;
  }
}

function registryIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registryEntry(value: unknown, origin: string): ErrorRegistryEntry {
  if (!registryIsRecord(value)) {
    throw new RangeError(`${origin}: registry entry must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== REGISTRY_ENTRY_KEYS.length || keys.some((key) => !REGISTRY_ENTRY_KEYS.includes(key))) {
    throw new RangeError(`${origin}: registry entry must have exactly 13 fields`);
  }
  const code = value["code"];
  const owner = value["owner"];
  const category = value["category"];
  const retryableDefault = value["retryable_default"];
  const sideEffectAllowed = value["side_effect_allowed"];
  const replacement = value["replacement"];
  const since = value["since"];
  const deprecated = value["deprecated"];
  const detailsKind = value["details_kind"];
  const detailsSchema = value["details_schema"];
  const stage = value["stage"];
  const aliases = value["aliases"];
  const source = value["source"];
  if (typeof code !== "string" || !/^E_[A-Z0-9_]+$/.test(code)) {
    throw new RangeError(`${origin}: invalid error code`);
  }
  if (typeof owner !== "string" || !isRegistryOwner(owner)) {
    throw new RangeError(`${origin}: ${code} has invalid owner`);
  }
  if (typeof category !== "string" || !isRegistryCategory(category)) {
    throw new RangeError(`${origin}: ${code} has invalid category`);
  }
  if (typeof retryableDefault !== "boolean" || typeof sideEffectAllowed !== "boolean") {
    throw new RangeError(`${origin}: ${code} retryable/side-effect must be boolean`);
  }
  if (replacement !== null && (typeof replacement !== "string" || !/^E_[A-Z0-9_]+$/.test(replacement))) {
    throw new RangeError(`${origin}: ${code} has invalid replacement`);
  }
  if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new RangeError(`${origin}: ${code} has invalid since`);
  }
  if (typeof deprecated !== "boolean") {
    throw new RangeError(`${origin}: ${code} deprecated must be boolean`);
  }
  if (typeof detailsKind !== "string" || !isRegistryDetailsKind(detailsKind)) {
    throw new RangeError(`${origin}: ${code} has invalid details_kind`);
  }
  if (detailsSchema !== `${REV_DETAILS_SCHEMA_PREFIX}${detailsKind}${REV_DETAILS_SCHEMA_SUFFIX}`) {
    throw new RangeError(`${origin}: ${code} details_schema does not match details_kind`);
  }
  if (typeof stage !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(stage)) {
    throw new RangeError(`${origin}: ${code} has invalid stage`);
  }
  if (deprecated && replacement === null) {
    throw new RangeError(`${origin}: ${code} alias row requires replacement`);
  }
  if (!deprecated && replacement !== null) {
    throw new RangeError(`${origin}: ${code} canonical row cannot carry replacement`);
  }
  if (!Array.isArray(aliases)) {
    throw new RangeError(`${origin}: ${code} aliases must be a string array`);
  }
  const aliasCodes: string[] = [];
  for (const alias of aliases) {
    if (typeof alias !== "string") {
      throw new RangeError(`${origin}: ${code} aliases must be a string array`);
    }
    aliasCodes.push(alias);
  }
  if (typeof source !== "string" || !REGISTRY_SOURCE_PREFIX[owner].some((prefix) => source.startsWith(prefix))) {
    throw new RangeError(`${origin}: ${code} source does not match owner`);
  }
  return {
    code,
    owner,
    category,
    retryable_default: retryableDefault,
    side_effect_allowed: sideEffectAllowed,
    replacement,
    since,
    deprecated,
    details_kind: detailsKind,
    details_schema: detailsSchema,
    stage,
    aliases: aliasCodes,
    source
  };
}

function fragmentEntries(fragment: unknown, index: number): readonly unknown[] {
  const origin = `fragment[${String(index)}]`;
  if (Array.isArray(fragment)) {
    return fragment;
  }
  if (registryIsRecord(fragment)) {
    const rows = fragment["rows"];
    if (Array.isArray(rows)) {
      return rows;
    }
    const codes = fragment["codes"];
    if (Array.isArray(codes)) {
      return codes;
    }
  }
  throw new RangeError(`${origin}: expected rows[] or codes[]`);
}

/**
 * Merges domain fragments into `rsi.error_registry/1` (DD-FND-103). Alias and
 * canonical rows must be reverse-linked, codes globally unique and every
 * `details_schema` derived from its `details_kind`. Invalid input fails the
 * build; no field is defaulted or dropped.
 */
export function buildErrorRegistry(
  fragments: readonly unknown[],
  baseline?: ErrorRegistry
): ErrorRegistry {
  const entries: ErrorRegistryEntry[] = [];
  if (baseline !== undefined) {
    for (const entry of baseline.entries) {
      entries.push(registryEntry(entry, "baseline"));
    }
  }
  fragments.forEach((fragment, index) => {
    for (const raw of fragmentEntries(fragment, index)) {
      entries.push(registryEntry(raw, `fragment[${String(index)}]`));
    }
  });
  const byCode = new Map<string, ErrorRegistryEntry>();
  for (const entry of entries) {
    if (byCode.has(entry.code)) {
      throw new RangeError(`duplicate error code ${entry.code}`);
    }
    byCode.set(entry.code, entry);
  }
  for (const entry of entries) {
    if (entry.deprecated) {
      const canonical = byCode.get(entry.replacement ?? "");
      if (canonical === undefined || canonical.deprecated) {
        throw new RangeError(`${entry.code} replacement is not canonical`);
      }
      if (canonical.owner !== entry.owner || canonical.category !== entry.category) {
        throw new RangeError(`${entry.code} alias owner/category differs from ${canonical.code}`);
      }
      if (!canonical.aliases.includes(entry.code)) {
        throw new RangeError(`${canonical.code} must declare alias ${entry.code}`);
      }
      if (entry.aliases.length !== 0) {
        throw new RangeError(`${entry.code} alias row cannot declare reverse aliases`);
      }
      continue;
    }
    for (const alias of entry.aliases) {
      const aliasRow = byCode.get(alias);
      if (aliasRow === undefined || !aliasRow.deprecated || aliasRow.replacement !== entry.code) {
        throw new RangeError(`${entry.code} alias ${alias} is not reverse-linked`);
      }
    }
  }
  return { schema_version: "rsi.error_registry/1", entries };
}

/** Alias used by callers that treat the merge as `registry = fragments + baseline`. */
export function mergeErrorRegistry(
  fragments: readonly unknown[],
  baseline?: ErrorRegistry
): ErrorRegistry {
  return buildErrorRegistry(fragments, baseline);
}
