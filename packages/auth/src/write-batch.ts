/**
 * Multi-file managed write batch (DD-FND-091).
 *
 * The design is explicit that there is no cross-file atomicity: "跨文件没有
 * 原子性。多个对象必须分别发 WriteIntent，任一部分失败可产生整体 `partial`
 * 结果，调用方不得报告全部成功" (DD-FND-091, conflict and rollback rules).
 *
 * `applyWriteBatch` therefore:
 *
 *   - issues one `WriteIntent` per file through the single-file write port;
 *   - never rolls a successful file back because a sibling failed;
 *   - reports `partial` when at least one file succeeded and at least one
 *     failed, `removed`/`verified` only when every file succeeded, and
 *     `failed` when no file succeeded;
 *   - never claims cross-file atomicity: `atomicity` stays
 *     `single_file_atomic` per file and the batch view states that the files
 *     were written independently.
 */

import type { ErrorEnvelope, Id, Result } from "@evoplug/core";
import { newId } from "@evoplug/core";

import type { WriteApplyRequest, WriteResult } from "./write-intent.js";

/** The single-file write entry point a batch drives. */
type SingleWriteApply = (
  request: WriteApplyRequest
) => Promise<Result<WriteResult, ErrorEnvelope>>;

interface WriteBatchRequest {
  readonly schema_version: "rsi.write_batch/1";
  /** One entry per file; each entry carries its own `WriteIntent` identity. */
  readonly writes: readonly WriteApplyRequest[];
}

type WriteBatchStatus = "verified" | "partial" | "failed";

interface WriteBatchItem {
  readonly index: number;
  readonly target_path: string;
  readonly write_id: Id<"wi"> | null;
  readonly state: WriteResult["state"] | "failed";
  readonly error: ErrorEnvelope | null;
}

interface WriteBatchView {
  readonly schema_version: "rsi.write_batch_view/1";
  readonly status: WriteBatchStatus;
  readonly items: readonly WriteBatchItem[];
  readonly verified_count: number;
  readonly failed_count: number;
  /** Cross-file atomicity is never promised; each file is its own intent. */
  readonly atomicity: "none";
}

/**
 * Applies several managed writes as independent single-file writes.
 *
 * The batch never reports an overall success when any file failed, and never
 * undoes a file that already landed: the caller decides how to reconcile the
 * reported `partial` state.
 */
export async function applyWriteBatch(
  apply: SingleWriteApply,
  request: WriteBatchRequest
): Promise<Result<WriteBatchView, ErrorEnvelope>> {
  if (request.schema_version !== "rsi.write_batch/1") {
    return {
      ok: false,
      status: "rejected",
      error: {
        schema_version: "rsi.error/1",
        code: "E_SCHEMA",
        category: "schema",
        retryable: false,
        side_effect: "none",
        message_key: "error.schema",
        stage: "write_batch",
        details: { kind: "field", path: "schema_version", rule: "rsi.write_batch/1" },
        trace_id: newId("ipc")
      }
    };
  }
  const items: WriteBatchItem[] = [];
  for (let index = 0; index < request.writes.length; index += 1) {
    const write = request.writes[index];
    if (write === undefined) {
      continue;
    }
    const outcome = await apply(write);
    if (outcome.ok) {
      items.push({
        index,
        target_path: outcome.value.path,
        write_id: outcome.value.write_id,
        state: outcome.value.state,
        error: null
      });
      continue;
    }
    items.push({
      index,
      target_path: write.target_path,
      write_id: null,
      state: "failed",
      error: outcome.error
    });
  }
  const verifiedCount = items.filter((item) => item.state === "verified").length;
  const failedCount = items.filter((item) => item.state === "failed").length;
  const status: WriteBatchStatus =
    failedCount === 0 ? "verified" : verifiedCount === 0 ? "failed" : "partial";
  return {
    ok: true,
    status: "ok",
    value: {
      schema_version: "rsi.write_batch_view/1",
      status,
      items,
      verified_count: verifiedCount,
      failed_count: failedCount,
      atomicity: "none"
    }
  };
}
