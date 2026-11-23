/**
 * Five-stage review pipeline ordering and failure mapping (DD-REV-080).
 */

import type { ReviewJobStage } from "./types.js";

export const PIPELINE_STAGES: readonly ReviewJobStage[] = [
  "snapshot",
  "generate",
  "static_check",
  "experience_match_judge",
  "handoff"
];

