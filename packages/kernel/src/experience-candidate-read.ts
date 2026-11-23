/**
 * Read-only Experience candidate retrieval (D11, DD-REV-090.1).
 *
 * The page is a pure function of `experiences` plus an `EXISTS` semi-join on
 * `experience_projections`: one row per current Experience version, never a
 * projection join fan-out. Scope, modes and expiry are read from the entity
 * columns only; upstream conditions (`environment_fingerprints`,
 * `tool_version_ranges`, `model_families`) are deliberately *not* evaluated
 * here, they belong to generation and the existing Experience rules.
 *
 * Nothing is written, no transaction is taken from the caller, no body is
 * read. An empty page is a legal answer; a storage failure keeps its named
 * error; an internally inconsistent row set is `E_INTERNAL`, never an empty
 * page.
 */

import type { ErrorEnvelope, Hash, Result, SourceRef } from "@evoplug/core";
import { err, isHash as sharedIsHash, makeErrorEnvelope, ok } from "@evoplug/core";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";
import type {
  ExperienceCandidatePage,
  ExperienceCandidateQuery,
  ExperienceCandidateReadPort,
  ExperienceRisk,
  ExperienceScope,
  ExperienceType,
  ReviewExperienceCandidate
} from "@evoplug/review";
import {
  REVIEW_EXPERIENCE_CANDIDATE_LIMIT,
  compareExperienceCandidates,
  experienceCandidateQueryHash,
  scopeRank
} from "@evoplug/review";

import { kernelError } from "./errors.js";

function storageUnavailable(operation: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STORAGE_UNAVAILABLE",
    category: "storage",
    message_key: "error.storage_unavailable",
    stage: "storage",
    retryable: true,
    side_effect: "none",
    details: { kind: "storage", operation }
  });
}

const CANDIDATE_SQL = `
SELECT e.experience_id          AS experience_id,
       e.version                AS version,
       e.type                   AS type,
       e.title                  AS title,
       e.summary                AS summary,
       e.risk                   AS risk,
       e.content_hash           AS content_hash,
       e.validation_plan_id     AS validation_plan_id,
       e.validation_plan_hash   AS validation_plan_hash,
       e.body_ref               AS body_ref,
       e.created_at             AS created_at,
       e.scope_json             AS scope_json,
       e.expiry_policy_json     AS expiry_policy_json,
       CASE json_extract(e.scope_json, '$.level')
         WHEN 'project' THEN 4
         WHEN 'host'    THEN 3
         WHEN 'user'    THEN 2
         WHEN 'global'  THEN 1
       END                      AS scope_rank
  FROM experiences e
 WHERE (
   /* The cache marker is written only by the T7 adoption frame. A rollback
    * restores an older version whose marker stays non-null by design, so the
    * projection facts decide: a projection restored by rollback is current
    * when its superseding version has no active projection for this same
    * host/config-space/mode. Every other non-null marker stays filtered. */
   e.superseded_by_version IS NULL
   OR (
     EXISTS (
       SELECT 1
         FROM experience_projections pr
        WHERE pr.experience_id = e.experience_id
          AND pr.experience_version = e.version
          AND pr.host_id = :host_id
          AND pr.config_space = :config_space
          AND pr.mode = :mode
          AND pr.lifecycle IN ('checked', 'trial', 'retained')
          AND pr.restored_from_projection_id IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
         FROM experience_projections ps
        WHERE ps.experience_id = e.experience_id
          AND ps.experience_version = e.superseded_by_version
          AND ps.host_id = :host_id
          AND ps.config_space = :config_space
          AND ps.mode = :mode
          AND ps.lifecycle IN ('checked', 'trial', 'retained'))
   )
 )
   AND EXISTS (
     SELECT 1
       FROM experience_projections p
      WHERE p.experience_id = e.experience_id
        AND p.experience_version = e.version
        AND p.host_id = :host_id
        AND p.config_space = :config_space
        AND p.mode = :mode
        AND p.lifecycle IN ('checked', 'trial', 'retained'))
   AND (json_extract(e.scope_json, '$.level') IN ('user', 'global')
        OR (json_extract(e.scope_json, '$.level') = 'project'
            AND :project_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM json_each(e.scope_json, '$.project_ids') j
                         WHERE j.value = :project_id))
        OR (json_extract(e.scope_json, '$.level') = 'host'
            AND EXISTS (SELECT 1 FROM json_each(e.scope_json, '$.host_ids') j
                         WHERE j.value = :host_id)))
   AND (json_array_length(e.scope_json, '$.modes') = 0
        OR EXISTS (SELECT 1 FROM json_each(e.scope_json, '$.modes') j
                    WHERE j.value = :mode))
   AND (json_extract(e.expiry_policy_json, '$.max_age_ms') IS NULL
        OR :now <= e.created_at + json_extract(e.expiry_policy_json, '$.max_age_ms'))
 ORDER BY scope_rank DESC, e.created_at DESC, e.experience_id ASC, e.version DESC
 LIMIT 33`;

const EXPERIENCE_TYPES: ReadonlySet<string> = new Set<ExperienceType>([
  "recovery_procedure",
  "tool_workflow",
  "project_constraint",
  "user_preference",
  "validation_check"
]);
const EXPERIENCE_RISKS: ReadonlySet<string> = new Set<ExperienceRisk>(["low", "medium", "high"]);
const SCOPE_LEVELS: ReadonlySet<string> = new Set<ExperienceScope["level"]>([
  "project",
  "user",
  "host",
  "global"
]);

function isHash(value: unknown): value is Hash {
  return typeof value === "string" && sharedIsHash(value);
}

function isSourceRef(value: unknown): value is SourceRef {
  return typeof value === "string" && (value.startsWith("blob://") || value.startsWith("journal://"));
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

interface ParsedScope {
  readonly scope: ExperienceScope;
  readonly rank: 1 | 2 | 3 | 4;
}

function parseScope(raw: unknown): ParsedScope | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const level = object["level"];
  if (typeof level !== "string" || !SCOPE_LEVELS.has(level)) return null;
  const projectIds = stringArray(object["project_ids"] ?? []);
  const hostIds = stringArray(object["host_ids"] ?? []);
  const modes = stringArray(object["modes"] ?? []);
  const fingerprints = stringArray(object["environment_fingerprints"] ?? []);
  const families = stringArray(object["model_families"] ?? []);
  const rangesRaw = object["tool_version_ranges"] ?? [];
  if (
    projectIds === null ||
    hostIds === null ||
    modes === null ||
    fingerprints === null ||
    families === null ||
    !Array.isArray(rangesRaw)
  ) {
    return null;
  }
  const ranges: Array<{ tool: string; range: string }> = [];
  for (const item of rangesRaw) {
    if (item === null || typeof item !== "object") return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry["tool"] !== "string" || typeof entry["range"] !== "string") return null;
    ranges.push({ tool: entry["tool"], range: entry["range"] });
  }
  return {
    scope: {
      level: level as ExperienceScope["level"],
      project_ids: projectIds,
      host_ids: hostIds as ExperienceScope["host_ids"],
      modes,
      environment_fingerprints: fingerprints,
      tool_version_ranges: ranges,
      model_families: families
    },
    rank: scopeRank(level as ExperienceScope["level"])
  };
}

function parseMaxAgeMs(raw: unknown): number | null | "invalid" {
  if (typeof raw !== "string") return "invalid";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const maxAge = (value as Record<string, unknown>)["max_age_ms"];
  if (maxAge === undefined || maxAge === null) return null;
  if (typeof maxAge !== "number" || !Number.isSafeInteger(maxAge) || maxAge < 0) return "invalid";
  return maxAge;
}

function candidateFromRow(row: SqlRow): ReviewExperienceCandidate | null {
  const experienceId = row["experience_id"];
  const version = row["version"];
  const type = row["type"];
  const risk = row["risk"];
  const contentHash = row["content_hash"];
  const planId = row["validation_plan_id"];
  const planHash = row["validation_plan_hash"];
  const bodyRef = row["body_ref"];
  const createdAt = row["created_at"];
  const parsedScope = parseScope(row["scope_json"]);
  const maxAge = parseMaxAgeMs(row["expiry_policy_json"]);
  if (
    typeof experienceId !== "string" ||
    experienceId.length === 0 ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof type !== "string" ||
    !EXPERIENCE_TYPES.has(type) ||
    typeof risk !== "string" ||
    !EXPERIENCE_RISKS.has(risk) ||
    !isHash(contentHash) ||
    typeof planId !== "string" ||
    planId.length === 0 ||
    !isHash(planHash) ||
    !isSourceRef(bodyRef) ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    parsedScope === null ||
    maxAge === "invalid"
  ) {
    return null;
  }
  if (parsedScope.rank !== row["scope_rank"]) return null;
  const title = row["title"];
  const summary = row["summary"];
  return {
    schema_version: "rsi.review_experience_candidate/1",
    experience_id: experienceId,
    version,
    content_hash: contentHash,
    validation_plan_id: planId,
    validation_plan_hash: planHash,
    type: type as ExperienceType,
    risk: risk as ExperienceRisk,
    scope: parsedScope.scope,
    scope_rank: parsedScope.rank,
    source_ref: bodyRef,
    created_at: createdAt,
    expires_at: maxAge === null ? null : createdAt + maxAge,
    ...(typeof title === "string" && title.length > 0 ? { name: title } : {}),
    ...(typeof summary === "string" && summary.length > 0 ? { description: summary } : {})
  };
}

function invalidPage(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal.unexpected",
    stage: "experience_candidates",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/**
 * Builds the read port. When `enabled` is false the port keeps the historical
 * behaviour byte-for-byte: an empty page with the correct `query_hash` and no
 * database access at all.
 */
export function createSqliteExperienceCandidatePort(input: {
  connection: SqliteConnection;
  enabled: boolean;
}): ExperienceCandidateReadPort {
  return {
    async listCandidates(
      query: ExperienceCandidateQuery
    ): Promise<Result<ExperienceCandidatePage, ErrorEnvelope>> {
      const queryHash = experienceCandidateQueryHash(query);
      if (!input.enabled) {
        return ok({
          schema_version: "rsi.experience_candidate_page/1",
          query_hash: queryHash,
          candidates: [],
          truncated: false
        });
      }

      let rows: SqlRow[];
      try {
        rows = input.connection
          .prepare<SqlRow>(CANDIDATE_SQL)
          .all({
            host_id: query.host_binding.host_id,
            config_space: query.host_binding.config_space,
            mode: query.host_binding.mode,
            project_id: query.project_id,
            now: query.now
          });
      } catch (error) {
        return err(
          storageUnavailable(
            `experience_candidates:${error instanceof Error ? error.name : "unknown"}`
          )
        );
      }

      const candidates: ReviewExperienceCandidate[] = [];
      for (const row of rows) {
        const candidate = candidateFromRow(row);
        if (candidate === null) {
          return err(invalidPage("experience", "candidate_row_invalid"));
        }
        candidates.push(candidate);
      }

      /* The SQL already orders; re-check so a regression cannot silently ship
       * an unordered or duplicated page. */
      for (let index = 1; index < candidates.length; index += 1) {
        const previous = candidates[index - 1] as ReviewExperienceCandidate;
        const current = candidates[index] as ReviewExperienceCandidate;
        if (previous.experience_id === current.experience_id) {
          return err(invalidPage("experience_id", "duplicate_experience_id"));
        }
        if (compareExperienceCandidates(previous, current) > 0) {
          return err(invalidPage("candidates", "order_mismatch"));
        }
      }

      const truncated = candidates.length > REVIEW_EXPERIENCE_CANDIDATE_LIMIT;
      const page = candidates.slice(0, REVIEW_EXPERIENCE_CANDIDATE_LIMIT);
      return ok({
        schema_version: "rsi.experience_candidate_page/1",
        query_hash: queryHash,
        candidates: page,
        truncated
      });
    }
  };
}

/**
 * Startup/recovery invariant: every projection row was created by exactly the
 * lifecycle event that names the same `projection_id` with `sequence=1` and
 * `to_lifecycle='checked'`. Adoption creates the first projection; rollback
 * creates a restore projection, whose first event has `reason='rollback'`.
 * Matching only `(experience_id, version)` would let a second projection on
 * another host reuse the first host's event and hide a ghost projection, so the
 * association is exact. Without it the check fails closed with
 * `E_REBUILD_DIVERGENCE`.
 *
 * Returns the first offending projection deterministically (`projection_id`
 * order); `ok(undefined)` means the whole table satisfies the invariant.
 */
export function assertExperienceProjectionCreationEvents(
  connection: SqliteConnection
): Result<void, ErrorEnvelope> {
  let row: SqlRow | undefined;
  try {
    row = connection
      .prepare<SqlRow>(
        `SELECT p.projection_id AS projection_id,
                p.experience_id AS experience_id,
                p.experience_version AS experience_version
           FROM experience_projections p
          WHERE NOT EXISTS (
            SELECT 1
              FROM experience_lifecycle_events e
             WHERE e.projection_id = p.projection_id
               AND e.experience_id = p.experience_id
               AND e.experience_version = p.experience_version
               AND e.sequence = 1
               AND e.reason IN ('adopted', 'rollback')
               AND e.to_lifecycle = 'checked')
          ORDER BY p.projection_id ASC
          LIMIT 1`
      )
      .get();
  } catch (error) {
    return err(
      storageUnavailable(
        `experience_projection_invariant:${error instanceof Error ? error.name : "unknown"}`
      )
    );
  }
  if (row === undefined) return ok(undefined);
  const projectionId = typeof row["projection_id"] === "string" ? row["projection_id"] : "unknown";
  const experienceId = typeof row["experience_id"] === "string" ? row["experience_id"] : "unknown";
  const version = typeof row["experience_version"] === "number" ? row["experience_version"] : -1;
  return err(
    kernelError("E_REBUILD_DIVERGENCE", {
      details: {
        kind: "field",
        path: "experience_projections.projection_id",
        rule: `missing_adopted_creation_event:${projectionId}:${experienceId}@${version}`
      }
    })
  );
}
