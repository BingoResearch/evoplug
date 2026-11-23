/**
 * `egress_classifier/1`: frozen local classification rules (DD-FND-093.1).
 *
 * Classification is derived only from the exact-range bytes plus the
 * `rsi.egress_provenance/1` tuple. Caller labels, filenames and model-declared
 * classes are never consulted. Insufficient, conflicting or multi-owner
 * provenance yields `null` (unknown) rather than a fallback to `public`.
 * Secret detection runs before any positive classification.
 */

export const EGRESS_CLASSIFIER_VERSION: "egress_classifier/1" = "egress_classifier/1";

