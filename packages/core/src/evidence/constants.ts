/**
 * QP local constants (DD-QP-03).
 *
 * These are product choices, not Jev service limits. Every value here is
 * frozen by the design and must not be adapted at runtime.
 */

/** Issue detector rule version. */
export const QP_ISSUE_DETECTOR_VERSION = "qp.issue_detector/1" as const;

/** Maximum questions in one plan. */
export const MAX_QUESTIONS_PER_PLAN = 32 as const;

/** Maximum required sources attached to one question. */
export const MAX_REQUIRED_SOURCES_PER_QUESTION = 64 as const;

/** Maximum distinct sources in one plan. */
export const MAX_PLAN_SOURCES = 256 as const;

/** Maximum bytes of one archived excerpt; larger is rejected, never cut. */
export const MAX_EXCERPT_BYTES = 4096 as const;

/** Maximum candidates in one discovery run. */
export const MAX_ISSUES_PER_DISCOVERY = 64 as const;

/** Minimum choice options. */
export const MIN_CHOICE_OPTIONS = 2 as const;

/** Maximum choice options. */
export const MAX_CHOICE_OPTIONS = 255 as const;

/** Allowed output reserve range. */
export const MIN_OUTPUT_RESERVE_TOKENS = 16 as const;

/** Allowed output reserve range. */
export const MAX_OUTPUT_RESERVE_TOKENS = 2048 as const;

/** Maximum source refs in one issue field. */
export const MAX_SOURCE_REFS = 64 as const;

