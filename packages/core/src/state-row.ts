/**
 * FND StateRow commit ABI (DD-FND-059.1.6 and DD-FND-059.1.6.1).
 *
 * This module is the single normative source of the commit ABI. The
 * TypeScript block of DD-FND-059.1.6 ("生产与读取端口") and DD-FND-059.1.6.1
 * ("带 live 门的同步提交端口") is reproduced here verbatim in shape: the
 * interface surface is fixed at `appendStateRows`, `getStateRow`,
 * `listStateRows`, `readStateRowsSnapshot` and `StateRowSnapshot`.
 *
 * Consumers must not drop a method, redeclare a same-named type elsewhere or
 * substitute an excerpt from another document. The registration that decides
 * what may be written stays in `schemas/ledger/state-row-registry.json`; the
 * generated `StateRowSchema` / `StateRowTypeMap` / `StateRowKeyMap` come from
 * that registry.
 */

import type { ErrorEnvelope } from "./errors.js";
import type { Hash } from "./hash.js";
import type { Id } from "./ids.js";
import type { Result } from "./result.js";
import type { NotPromise, SqlParams, SqlRow } from "./tx.js";
import type { VersionBinding } from "./version-binding.js";

import type {
  ObjectDocumentRow,
  ObjectHeadRow,
  StateRowSchema,
  StateRowTypeMap
} from "./generated/state-row-types.js";
import type { StateRowKeyMap, StateRowOperation } from "./generated/state-row-keys.js";

export type {
  ObjectDocumentRow,
  ObjectHeadRow,
  StateRowKeyMap,
  StateRowOperation,
  StateRowSchema,
  StateRowTypeMap
};

/**
 * The runtime registry and key helpers generated from
 * `schemas/ledger/state-row-registry.json`. They are re-exported here so the
 * storage layer reads the same registration the types were generated from.
 */
export {
  STATE_ROW_COLUMNS,
  STATE_ROW_REGISTRATIONS,
  objectDocumentId,
  stateRowKey
} from "./generated/state-row-keys.js";
export type { StateRowColumn, StateRowRegistration } from "./generated/state-row-keys.js";

/* ------------------------------------------------------------------ */
/* DD-FND-059.1.6 生产与读取端口                                        */
/* ------------------------------------------------------------------ */

export interface StateRowWrite<S extends StateRowSchema = StateRowSchema> {
  row_schema: S;
  operation: StateRowOperation;
  row: StateRowTypeMap[S];
  document_id: Hash | null;
}

export interface AppendStateRowsRequest {
  /** 全 none 全局批为 null；含 row/batch 行必须非 null */
  binding: VersionBinding | null;
  rows: readonly StateRowWrite[];
  documents: readonly ObjectDocumentRow[];
  heads: readonly ObjectHeadRow[];
}

export interface AppendStateRowsResult {
  batch_hash: Hash;
  first_commit_seq: number;
  last_commit_seq: number;
  event_ids: readonly Id<"ev">[];
}

export interface StateRowReadKey<S extends StateRowSchema = StateRowSchema> {
  row_schema: S;
  key: StateRowKeyMap[S];
}

export interface StateRowPort {
  /** 仅 FND 进程内调用；不接受 IPC 传入的 row_schema/row_json，不接收 SQLite 事务参数 */
  appendStateRows(input: AppendStateRowsRequest): Promise<LiveCommitOutcome<null>>;
  getStateRow<S extends StateRowSchema>(q: {
    row_schema: S; key: StateRowKeyMap[S]; binding: VersionBinding | null;
  }): Promise<Result<StateRowTypeMap[S] | null, ErrorEnvelope>>;
  listStateRows(q: {
    row_schemas: readonly StateRowSchema[];
    binding: VersionBinding | null;
    after_commit_seq?: number;
    limit: number;                         // 1..1000
  }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>>;
  readStateRowsSnapshot(q: {
    binding: VersionBinding | null;
    keys: readonly StateRowReadKey[];      // 精确键集，无 limit/after_commit_seq/分页
  }): Promise<Result<readonly StateRowSnapshot[], ErrorEnvelope>>;
}

export interface StateRowSnapshot {
  row_schema: StateRowSchema;
  row: StateRowTypeMap[StateRowSchema];
  commit_seq: number;
  after_hash: Hash;
}

/* ------------------------------------------------------------------ */
/* DD-FND-059.1.6.1 带 live 门的同步提交端口                            */
/* ------------------------------------------------------------------ */

export interface FrozenBlob {
  /** sha256:<64 lowercase hex>，必须等于 sha256(bytes) */
  hash: Hash;
  /** 冻结字节；FND 在帧写前写入 content-addressed blob */
  bytes: Uint8Array;
}

export interface LiveReadTx {
  get<Row extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Row | null;
  all<Row extends SqlRow = SqlRow>(sql: string, params?: SqlParams): readonly Row[];
}

export interface DeliveryDispatchEffect {
  schema_version: "rsi.delivery_dispatch_effect/1";
  delivery_id: Id<"del">;
  submission_attempt: number;              // 1..16 的安全整数
}

export interface ReviewEnqueueEffect {
  schema_version: "rsi.review_enqueue_effect/1";
  job_id: Id<"job">;
  request_id: string;                      // 1..128 UTF-8
  trigger_event_id: Id<"trg">;
  trigger_dedupe_key: Hash;
  binding: VersionBinding;                 // 嵌套完整六字段，不拆成未声明的散列键
  created_at: number;                      // 安全非负整数
}

export interface MaintenanceGcEffect {
  schema_version: "rsi.maintenance_gc_effect/1";
  mode: "dry_run" | "apply";
  retention_days: number | null;           // null 表示运行默认保留期
}

export interface DeliveryExpireEffect {
  schema_version: "rsi.delivery_expire_effect/1";
  delivery_id: Id<"del">;
  expires_at: number;                      // 安全非负整数
}

export interface OutboxEffectPayloadMap {
  "delivery.dispatch": DeliveryDispatchEffect;
  "review.enqueue": ReviewEnqueueEffect;
  "maintenance.gc": MaintenanceGcEffect;
  "delivery.expire": DeliveryExpireEffect;
}

export type OutboxEffectKind = keyof OutboxEffectPayloadMap;

export type OutboxEnqueueInput = {
  readonly [K in OutboxEffectKind]: {
    readonly effect_kind: K;
    readonly effect_key: string;           // 1..256 UTF-8；固定公式见下方正文
    readonly payload: OutboxEffectPayloadMap[K];
    readonly priority: number;             // 0..9
    readonly max_attempts: number;         // 1..16
  };
}[OutboxEffectKind];

export interface StageDocumentKey {
  owner: "evd" | "rev" | "host" | "cfg" | "qp";
  object_type: string;
  object_id: string;
  revision: number;                        // 正整数
}

export interface LiveCommitStage {
  readonly tx: LiveReadTx;                 // 同一连接、同一 BEGIN IMMEDIATE 内的只读句柄
  resolveStateRow<S extends StateRowSchema>(q: {
    row_schema: S;
    key: StateRowKeyMap[S];
  }): Result<StateRowTypeMap[S] | null, ErrorEnvelope>;
  resolveDocument(q: StageDocumentKey): Result<ObjectDocumentRow | null, ErrorEnvelope>;
  resolveHead(q: { object_id: string }): Result<ObjectHeadRow | null, ErrorEnvelope>;
  stageRows(rows: readonly StateRowWrite[]): Result<void, ErrorEnvelope>;
  stageDocuments(rows: readonly ObjectDocumentRow[]): Result<void, ErrorEnvelope>;
  stageHeads(rows: readonly ObjectHeadRow[]): Result<void, ErrorEnvelope>;
  stageOutbox(input: OutboxEnqueueInput): Result<void, ErrorEnvelope>;
  stageBlob(blob: FrozenBlob): Result<void, ErrorEnvelope>;
}

export interface LiveCommitRequest<Value = null> {
  binding: VersionBinding | null;
  stage(stage: LiveCommitStage): NotPromise<Result<LiveCommitDecision<Value>, ErrorEnvelope>>;
}

export type LiveCommitDecision<Value = null> =
  | { kind: "commit"; value: Value | null }
  | { kind: "existing"; value: Value | null };

export type LiveCommitOutcome<Value = null> =
  | { ok: true; commit_state: "committed"; receipt: AppendStateRowsResult; value: Value | null }
  | { ok: true; commit_state: "existing"; value: Value | null }
  | { ok: false; commit_state: "not_written"; error: ErrorEnvelope }
  | { ok: false; commit_state: "unknown_recovery_required"; error: ErrorEnvelope };

export interface StateRowLiveCommitPort {
  commitLiveGated<Value = null>(input: LiveCommitRequest<Value>): Promise<LiveCommitOutcome<Value>>;
}
