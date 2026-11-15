/**
 * `EvidenceIndexPort` and its frozen synchronous guard error (DD-EVD-003).
 *
 * This module performs no I/O. The only allowed implementation is
 * `EvidenceIndexSnapshot`; QP imports these declarations and the evidence view
 * DTOs, never an async port directly.
 */

import type { JsonValue, SourceRef, VersionBinding } from "@evoplug/core";

import {
  EvidenceIndexPortError,
  type EvidenceIndexPort,
  type EvidenceIndexPortErrorCode,
  type EvidenceIndexPortErrorShape,
} from "./types.js";

export {
  EvidenceIndexPortError,
  type EvidenceIndexPort,
  type EvidenceIndexPortErrorCode,
  type EvidenceIndexPortErrorShape,
};

export function evidenceIndexPortError(
  code: EvidenceIndexPortErrorCode,
  message_key: string,
  details: Readonly<Record<string, JsonValue>>
): EvidenceIndexPortError {
  return new EvidenceIndexPortError({ schema_version: "rsi.evidence_index_port_error/1", code, message_key, details });
}

export function assertBindingScope(
  actual: VersionBinding,
  requested: VersionBinding,
  watermark?: number,
  actualWatermark?: number
): void {
  const fields: Array<keyof VersionBinding> = [
    "task_id",
    "branch_id",
    "input_epoch",
    "goal_version",
    "config_version",
    "watermark",
  ];
  for (const field of fields) {
    if (actual[field] !== requested[field]) {
      throw evidenceIndexPortError("E_INDEX_SCOPE_MISMATCH", "error.index.scope_mismatch", {
        field,
        expected: String(actual[field]),
        actual: String(requested[field]),
      });
    }
  }
  if (watermark !== undefined && actualWatermark !== undefined && watermark !== actualWatermark) {
    throw evidenceIndexPortError("E_INDEX_SCOPE_MISMATCH", "error.index.scope_mismatch", {
      field: "watermark",
      expected: actualWatermark,
      actual: watermark,
    });
  }
}

export function assertSourceRefString(ref: SourceRef): SourceRef {
  return ref;
}
