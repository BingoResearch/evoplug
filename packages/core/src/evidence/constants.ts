/**
 * QP local constants (DD-QP-03).
 *
 * These are product choices, not Jev service limits. Every value here is
 * frozen by the design and must not be adapted at runtime.
 */

/** QuestionPlanner algorithm version. */
export const QP_PLANNER_VERSION = "qp.planner/1" as const;

/** Issue detector rule version. */
export const QP_ISSUE_DETECTOR_VERSION = "qp.issue_detector/1" as const;

/** Archived-excerpt extractor version. */
export const QP_EXCERPT_VERSION = "qp.excerpt/1" as const;

/** Judgment route policy version (DD-QP-31a). */
export const QP_ROUTE_VERSION = "qp.route/1" as const;

/** Maximum questions in one plan. */
export const MAX_QUESTIONS_PER_PLAN = 32 as const;

/** Maximum required sources attached to one question. */
export const MAX_REQUIRED_SOURCES_PER_QUESTION = 64 as const;

/** Maximum distinct sources in one plan. */
export const MAX_PLAN_SOURCES = 256 as const;

/** Maximum bytes of one archived excerpt; larger is rejected, never cut. */
export const MAX_EXCERPT_BYTES = 4096 as const;

/** Maximum requirement ids on one issue. */
export const MAX_REQUIREMENT_IDS_PER_ISSUE = 64 as const;

/** Maximum artifact paths on one issue. */
export const MAX_ARTIFACT_PATHS_PER_ISSUE = 64 as const;

/** Maximum candidates in one discovery run. */
export const MAX_ISSUES_PER_DISCOVERY = 64 as const;

/** Minimum choice options. */
export const MIN_CHOICE_OPTIONS = 2 as const;

/** Maximum choice options. */
export const MAX_CHOICE_OPTIONS = 255 as const;

/** Default per-question output reserve. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 128 as const;

/** Allowed output reserve range. */
export const MIN_OUTPUT_RESERVE_TOKENS = 16 as const;

/** Allowed output reserve range. */
export const MAX_OUTPUT_RESERVE_TOKENS = 2048 as const;

/** Maximum source refs in one issue field. */
export const MAX_SOURCE_REFS = 64 as const;

/** Maximum `issue.subject_key` UTF-8 byte length. */
export const MAX_SUBJECT_KEY_BYTES = 512 as const;

/** Deterministic detector ids in execution order (DD-QP-08). */
export const DETECTOR_IDS = [
  "constraint_violation/1",
  "missing_requirement/1",
  "wrong_target/1",
  "missing_verification/1",
  "goal_change/1",
  "insufficient_evidence/1",
  "stall/1",
  "experience/1"
] as const;

export type DetectorId = (typeof DETECTOR_IDS)[number];
