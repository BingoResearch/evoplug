/**
 * REV typed and derived row registrations (DD-REV-150.1, DD-FND-050).
 *
 * REV owns thirteen physical tables. Eleven of them are typed state rows: they
 * travel through the shared `state_row.recorded` event with their complete
 * physical row as `row_json`. The remaining two — `review_handoffs` and
 * `experience_projections` — are derived: they are materialised from the
 * frozen body of a journal event inside the same transaction and never carry
 * a `row_json` or an `after_hash` of their own.
 *
 * The registration list is the FND side of the contract: FND verifies the
 * table set, the key columns and the derived registrations at startup; the
 * column definitions stay in `migrations/domains/review/0001_review.sql`.
 */

import type { Hash, Id, JsonValue, SourceRef } from "@evoplug/core";

/** One REV typed state row registration. */
export interface RevStateRowRegistration {
  readonly row_schema: string;
  readonly table: string;
  readonly primary_key: readonly string[];
  readonly unique_keys: readonly (readonly string[])[];
  readonly allowed_operations: readonly ("insert" | "update" | "transition")[];
  readonly binding_source: "row" | "batch" | "none";
  readonly row_versioned: boolean;
  readonly derived_reducer: string | null;
}

/** One REV derived table registration. */
export interface RevDerivedTableRegistration {
  readonly table: string;
  readonly row_schema: string;
  readonly primary_key: readonly string[];
  /** The named reducer that materialises the row inside the commit. */
  readonly derived_reducer: string;
}

/** The eleven REV typed state rows. */
export const REV_STATE_ROW_REGISTRATIONS: readonly RevStateRowRegistration[] = [
  {
    row_schema: "rsi.review_snapshot/1",
    table: "review_snapshots",
    primary_key: ["snapshot_id"],
    unique_keys: [],
    allowed_operations: ["insert"],
    binding_source: "batch",
    row_versioned: false,
    derived_reducer: null
  },
  {
    row_schema: "rsi.review_enqueue_request_row/1",
    table: "review_enqueue_requests",
    primary_key: ["request_id"],
    unique_keys: [],
    allowed_operations: ["insert"],
    binding_source: "batch",
    row_versioned: false,
    derived_reducer: null
  },
  {
    row_schema: "rsi.review_job/2",
    table: "review_jobs",
    primary_key: ["job_id"],
    unique_keys: [],
    allowed_operations: ["insert", "update", "transition"],
    binding_source: "batch",
    row_versioned: true,
    derived_reducer: null
  },
  {
    row_schema: "rsi.review_attempt/1",
    table: "review_attempts",
    primary_key: ["attempt_id"],
    unique_keys: [],
    allowed_operations: ["insert", "update", "transition"],
    binding_source: "batch",
    row_versioned: true,
    derived_reducer: null
  },
  {
    row_schema: "rsi.review_output_acceptance_row/1",
    table: "review_output_acceptances",
    primary_key: ["attempt_id"],
    unique_keys: [],
    allowed_operations: ["insert"],
    binding_source: "batch",
    row_versioned: true,
    derived_reducer: null
  },
  {
    row_schema: "rsi.proposal_candidate_row/1",
    table: "proposal_candidates",
    primary_key: ["candidate_key"],
    unique_keys: [],
    allowed_operations: ["insert", "update", "transition"],
    binding_source: "batch",
    row_versioned: true,
    derived_reducer: null
  },
  {
    row_schema: "rsi.proposal_row/2",
    table: "proposals",
    primary_key: ["proposal_id"],
    unique_keys: [],
    allowed_operations: ["insert", "update", "transition"],
    binding_source: "batch",
    row_versioned: true,
    derived_reducer: null
  },
  {
    row_schema: "rsi.experience_row/1",
    table: "experiences",
    primary_key: ["experience_id", "version"],
    unique_keys: [],
    allowed_operations: ["insert", "transition"],
    binding_source: "batch",
    row_versioned: true,
    derived_reducer: null
  },
  {
    row_schema: "rsi.validation_plan_row/1",
    table: "validation_plans",
    primary_key: ["validation_plan_id"],
    unique_keys: [],
    allowed_operations: ["insert"],
    binding_source: "batch",
    row_versioned: false,
    derived_reducer: null
  },
  {
    row_schema: "rsi.usage_verification_row/1",
    table: "usage_verification_records",
    primary_key: ["usage_id"],
    unique_keys: [],
    allowed_operations: ["insert"],
    binding_source: "batch",
    row_versioned: false,
    derived_reducer: null
  },
  {
    row_schema: "rsi.experience_lifecycle_event_row/1",
    table: "experience_lifecycle_events",
    primary_key: ["event_id"],
    unique_keys: [],
    allowed_operations: ["insert"],
    binding_source: "batch",
    row_versioned: true,
    derived_reducer: null
  }
];

/**
 * Alias kept for the FND owner registry, which names the registration list
 * after the domain rather than after the schema family.
 */
export const REVIEW_STATE_ROW_REGISTRATIONS: readonly RevStateRowRegistration[] =
  REV_STATE_ROW_REGISTRATIONS;

/**
 * The two REV derived tables.
 *
 * Neither is a typed state row: they carry no `row_json` and no `after_hash`,
 * and they never appear as a journal member of their own. They are
 * materialised from the frozen body of the event that caused them.
 */
export const REV_DERIVED_TABLE_REGISTRATIONS: readonly RevDerivedTableRegistration[] = [
  {
    table: "review_handoffs",
    row_schema: "rsi.review_handoff/2",
    primary_key: ["handoff_id"],
    derived_reducer: "rev.review_handoff/1"
  },
  {
    table: "experience_projections",
    row_schema: "rsi.experience_projection/2",
    primary_key: ["projection_id"],
    derived_reducer: "rev.experience_projection/1"
  }
];

/** The row schemas the derived tables use; they are not typed state rows. */
export const REV_DERIVED_ROW_SCHEMAS: readonly string[] = [
  ...REV_DERIVED_TABLE_REGISTRATIONS.map((registration) => registration.row_schema)
];

/**
 * Rebuilds the REV typed and derived rows from the frozen frames.
 *
 * The typed rows are copied verbatim from the frame's `row_json`; the derived
 * rows are rebuilt from the body their event froze. Nothing is recomputed: a
 * rebuild never re-runs the matcher, the judge, the adoption logic or the
 * handoff pipeline.
 */
export interface RevRebuildInput {
  readonly rows: readonly RevRebuildRow[];
}

export interface RevRebuildRow {
  readonly table: string;
  readonly operation: "insert" | "update" | "transition";
  readonly row: Record<string, JsonValue>;
}

export interface RevRebuildReport {
  readonly typed_rows: number;
  readonly derived_rows: number;
}

/** The REV typed tables, in registration order. */
const REV_TYPED_TABLES: ReadonlySet<string> = new Set(
  REV_STATE_ROW_REGISTRATIONS.map((registration) => registration.table)
);

/** The REV derived tables, in registration order. */
const REV_DERIVED_TABLES_SET: ReadonlySet<string> = new Set(
  REV_DERIVED_TABLE_REGISTRATIONS.map((registration) => registration.table)
);

/**
 * True when the table is one of the eleven REV typed state rows.
 */
export function isRevTypedTable(table: string): boolean {
  return REV_TYPED_TABLES.has(table);
}

/**
 * True when the table is one of the two REV derived tables.
 */
export function isRevDerivedTable(table: string): boolean {
  return REV_DERIVED_TABLES_SET.has(table);
}

/**
 * Counts the rows a rebuild would write, split by typed and derived.
 *
 * The rebuild itself is performed by the shared FND state-row projection; this
 * helper exists so the caller can report what was restored without
 * re-deriving the classification.
 */
export function summarizeRevRebuild(input: RevRebuildInput): RevRebuildReport {
  let typedRows = 0;
  let derivedRows = 0;
  for (const row of input.rows) {
    if (isRevTypedTable(row.table)) {
      typedRows += 1;
      continue;
    }
    if (isRevDerivedTable(row.table)) {
      derivedRows += 1;
    }
  }
  return { typed_rows: typedRows, derived_rows: derivedRows };
}

/**
 * Rebuilds the REV handoff row from its frozen body.
 *
 * The handoff body is the canonical JSON the writer froze before the frame;
 * the row is a projection of it, never a re-run of the handoff pipeline.
 */
export function rebuildHandoff(input: {
  readonly handoff_id: string;
  readonly body: Record<string, JsonValue>;
  readonly body_ref: SourceRef;
  readonly created_at: number;
}): Record<string, JsonValue> {
  return {
    handoff_id: input.handoff_id,
    schema_version: "rsi.review_handoff/2",
    job_id: input.body["job_id"] ?? null,
    snapshot_id: input.body["snapshot_id"] ?? null,
    snapshot_hash: (input.body["snapshot_hash"] ?? null) as Hash | null,
    policy_version: input.body["policy_version"] ?? null,
    stage_results_json: JSON.stringify(input.body["stage_results"] ?? []),
    proposals_json: JSON.stringify(input.body["proposals"] ?? []),
    job_result: (input.body["job_result"] ?? null) as JsonValue,
    handoff_hash: (input.body["handoff_hash"] ?? null) as Hash | null,
    body_blob: input.body_ref,
    created_at: input.created_at
  };
}

/**
 * Rebuilds the experience projection row from the frozen lifecycle event.
 *
 * The projection is materialised from `projection_after`; the rebuild copies
 * it and never replays the lifecycle transition.
 */
export function rebuildExperienceProjection(input: {
  readonly projection: Record<string, JsonValue>;
}): Record<string, JsonValue> {
  return { ...input.projection };
}

/** The `Id` alias used by the REV rebuild rows. */
export type RevEntityId = Id<"job">;
