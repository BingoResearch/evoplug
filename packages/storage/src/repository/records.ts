/**
 * Generic record repository (精简设计 §3.3).
 *
 * `evidence_record`, `document_store`, `experience_record` and `cfg_record`
 * share one storage shape: `row_key`, `record_kind`, `body_json`, a parent key
 * and the six version-binding columns. This module is the single implementation
 * of put/get/findByKey/listByParent/CAS for every registered kind. Hot-path or
 * security-critical tables (journal, outbox, write, authorization) keep their
 * hand-written SQL.
 */

import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { storageError } from "../errors.js";
import type { SqlRow, StatementSource } from "../types.js";

/** Store tables the generic repository is allowed to address. */
export type RecordStore =
  | "evidence_record"
  | "evidence_attempt"
  | "document_store"
  | "experience_record"
  | "cfg_record"
  | "event_record"
  | "requirement_record"
  | "state_record"
  | "review_record"
  | "host_record"
  | "write_record"
  | "authorization_record"
  | "policy_record"
  | "budget_record"
  | "delivery_record";

export const RECORD_STORES: readonly RecordStore[] = Object.freeze([
  "evidence_record",
  "evidence_attempt",
  "document_store",
  "experience_record",
  "cfg_record",
  "event_record",
  "requirement_record",
  "state_record",
  "review_record",
  "host_record",
  "write_record",
  "authorization_record",
  "policy_record",
  "budget_record",
  "delivery_record"
]);

export interface RecordBinding {
  readonly task_id?: string | null;
  readonly branch_id?: string | null;
  readonly input_epoch?: number | null;
  readonly goal_version?: string | null;
  readonly config_version?: string | null;
  readonly watermark?: number | null;
}

export interface UniqueRule {
  /** Fields that must be unique together inside the kind. */
  readonly fields: readonly string[];
  /** Apply the rule only when these body fields equal the given values. */
  readonly when?: Readonly<Record<string, unknown>>;
}

export interface RecordDefinition {
  readonly kind: string;
  /** Optional validator; a JSON Schema validator can be passed in P2. */
  readonly validate?: (body: Readonly<Record<string, unknown>>) => boolean;
  /** Append-only kinds reject updates even through the CAS path. */
  readonly immutable?: boolean;
  /** Uniqueness enforced at the write layer (replaces per-table UNIQUE). */
  readonly unique?: readonly UniqueRule[];
}

export interface RecordKey {
  readonly store: RecordStore;
  readonly kind: string;
  readonly key: string;
}

export interface RecordRow {
  readonly kind: string;
  readonly key: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly parent_key: string | null;
  readonly binding: RecordBinding;
  readonly content_hash: string | null;
  readonly created_at: number;
}

export interface PutRecordInput extends RecordKey, RecordBinding {
  readonly body: Readonly<Record<string, unknown>>;
  readonly parent_key?: string | null;
  readonly content_hash?: Hash | null;
  readonly created_at?: number;
}

export interface CasRecordInput extends PutRecordInput {
  /** Value of `body.row_version` the caller read. */
  readonly expected_row_version: number;
}

interface StoredRow extends SqlRow {
  readonly row_key: string;
  readonly record_kind: string;
  readonly body_json: string;
  readonly parent_key: string | null;
  readonly task_id: string | null;
  readonly branch_id: string | null;
  readonly input_epoch: number | null;
  readonly goal_version: string | null;
  readonly config_version: string | null;
  readonly watermark: number | null;
  readonly content_hash: string | null;
  readonly created_at: number;
}

function isRecordStore(value: string): value is RecordStore {
  return (RECORD_STORES as readonly string[]).includes(value);
}

function schemaError(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_SCHEMA",
    stage: "storage.record_repository",
    details: { kind: "field", path, rule },
    message_key: "error.storage.state_row_schema_invalid"
  });
}

function conflictError(): ErrorEnvelope {
  return storageError({
    code: "E_CONFLICT",
    stage: "storage.record_repository",
    details: { kind: "field", path: "row_version", rule: "cas_mismatch" },
    message_key: "error.conflict.generic"
  });
}

function rowKey(kind: string, key: string): string {
  return `${kind}:${key}`;
}

function decode(row: StoredRow): RecordRow {
  return {
    kind: row.record_kind,
    key: row.row_key.slice(row.record_kind.length + 1),
    body: JSON.parse(row.body_json) as Record<string, unknown>,
    parent_key: row.parent_key,
    binding: {
      task_id: row.task_id,
      branch_id: row.branch_id,
      input_epoch: row.input_epoch,
      goal_version: row.goal_version,
      config_version: row.config_version,
      watermark: row.watermark
    },
    content_hash: row.content_hash,
    created_at: row.created_at
  };
}

/** Generic repository bound to one connection and one kind registry. */
export class RecordRepository {
  readonly #source: StatementSource;
  readonly #definitions: Map<string, RecordDefinition>;
  readonly #now: () => number;

  public constructor(
    source: StatementSource,
    definitions: readonly RecordDefinition[],
    now: () => number = () => Date.now()
  ) {
    this.#source = source;
    this.#definitions = new Map(definitions.map((definition) => [definition.kind, definition]));
    this.#now = now;
  }

  public register(definition: RecordDefinition): void {
    this.#definitions.set(definition.kind, definition);
  }

  #definition(kind: string): RecordDefinition {
    const definition = this.#definitions.get(kind);
    if (definition === undefined) {
      throw new Error(`unregistered_record_kind:${kind}`);
    }
    return definition;
  }

  #check(store: string, input: PutRecordInput): ErrorEnvelope | null {
    if (!isRecordStore(store)) {
      return schemaError("store", "unknown_store");
    }
    if (input.kind.length === 0 || input.key.length === 0) {
      return schemaError("key", "empty");
    }
    const definition = this.#definition(input.kind);
    if (definition.validate !== undefined && !definition.validate(input.body)) {
      return schemaError(`body.${input.kind}`, "invalid");
    }
    if (JSON.stringify(input.body) === undefined) {
      return schemaError("body", "not_json");
    }
    return this.#checkUnique(store, input);
  }

  #checkUnique(store: string, input: PutRecordInput): ErrorEnvelope | null {
    for (const rule of this.#definition(input.kind).unique ?? []) {
      if (
        rule.when !== undefined &&
        Object.entries(rule.when).some(([field, value]) => input.body[field] !== value)
      ) {
        continue;
      }
      if (rule.fields.some((field) => input.body[field] === undefined || input.body[field] === null)) {
        continue;
      }
      // `when` decides whether the rule applies to the input, and its fields
      // also constrain which existing rows can conflict. Without the second
      // part a superseded config profile keeps blocking its successor because
      // the old row still carries the same `config_space`.
      const constraintFields = [
        ...rule.fields,
        ...Object.keys(rule.when ?? {}).filter((field) => !rule.fields.includes(field))
      ];
      const where = constraintFields
        .map((field, index) => `json_extract(body_json, '$.${field}') = :u${String(index)}`)
        .join(" AND ");
      const params: Record<string, unknown> = { kind: input.kind, self: rowKey(input.kind, input.key) };
      constraintFields.forEach((field, index) => {
        params[`u${String(index)}`] =
          rule.fields.includes(field) ? input.body[field] : (rule.when ?? {})[field];
      });
      const hit = this.#source
        .prepare<{ hit: number }>(
          `SELECT 1 AS hit FROM ${store}
            WHERE record_kind = :kind AND ${where} AND row_key <> :self LIMIT 1`
        )
        .get(params);
      if (hit !== undefined) {
        return schemaError(`body.${rule.fields.join(",")}`, "unique");
      }
    }
    return null;
  }

  public put(input: PutRecordInput): Result<RecordRow, ErrorEnvelope> {
    const check = this.#check(input.store, input);
    if (check !== null) return { ok: false, status: "rejected", error: check };
    const bodyJson = JSON.stringify(input.body);
    try {
      this.#source
        .prepare(
          `INSERT INTO ${input.store}
             (row_key, record_kind, body_json, parent_key, task_id, branch_id,
              input_epoch, goal_version, config_version, watermark, content_hash, created_at)
           VALUES
             (:row_key, :record_kind, :body_json, :parent_key, :task_id, :branch_id,
              :input_epoch, :goal_version, :config_version, :watermark, :content_hash, :created_at)`
        )
        .run({
          row_key: rowKey(input.kind, input.key),
          record_kind: input.kind,
          body_json: bodyJson,
          parent_key: input.parent_key ?? null,
          task_id: input.task_id ?? null,
          branch_id: input.branch_id ?? null,
          input_epoch: input.input_epoch ?? null,
          goal_version: input.goal_version ?? null,
          config_version: input.config_version ?? null,
          watermark: input.watermark ?? null,
          content_hash: input.content_hash ?? null,
          created_at: input.created_at ?? this.#now()
        });
    } catch {
      return { ok: false, status: "rejected", error: conflictError() };
    }
    const stored = this.get(input);
    if (!stored.ok) return stored;
    if (stored.value === null) {
      return { ok: false, status: "rejected", error: schemaError("row", "missing_after_write") };
    }
    return { ok: true, status: stored.status, value: stored.value };
  }

  public get(key: RecordKey): Result<RecordRow | null, ErrorEnvelope> {
    if (!isRecordStore(key.store)) {
      return { ok: false, status: "rejected", error: schemaError("store", "unknown_store") };
    }
    const row = this.#source
      .prepare<StoredRow>(
        `SELECT row_key, record_kind, body_json, parent_key, task_id, branch_id, input_epoch,
                goal_version, config_version, watermark, content_hash, created_at
           FROM ${key.store}
          WHERE record_kind = :kind AND row_key = :row_key`
      )
      .get({ kind: key.kind, row_key: rowKey(key.kind, key.key) });
    return { ok: true, status: "ok", value: row === undefined ? null : decode(row) };
  }

  /** Alias kept separate so callers can express key-addressed lookup. */
  public findByKey(key: RecordKey): Result<RecordRow | null, ErrorEnvelope> {
    return this.get(key);
  }

  public listByParent(
    store: RecordStore,
    kind: string,
    parent_key: string
  ): Result<readonly RecordRow[], ErrorEnvelope> {
    return this.#list(
      `SELECT row_key, record_kind, body_json, parent_key, task_id, branch_id, input_epoch,
              goal_version, config_version, watermark, content_hash, created_at
         FROM ${store}
        WHERE record_kind = :kind AND parent_key = :parent_key
        ORDER BY created_at, row_key`,
      { kind, parent_key }
    );
  }

  public listByKind(
    store: RecordStore,
    kind: string
  ): Result<readonly RecordRow[], ErrorEnvelope> {
    return this.#list(
      `SELECT row_key, record_kind, body_json, parent_key, task_id, branch_id, input_epoch,
              goal_version, config_version, watermark, content_hash, created_at
         FROM ${store}
        WHERE record_kind = :kind
        ORDER BY created_at, row_key`,
      { kind }
    );
  }

  #list(sql: string, params: Record<string, unknown>): Result<readonly RecordRow[], ErrorEnvelope> {
    const rows = this.#source.prepare<StoredRow>(sql).all(params);
    return { ok: true, status: "ok", value: rows.map(decode) };
  }

  /** Unconditional body replacement for mutable kinds without a CAS column. */
  public updateBody(input: PutRecordInput): Result<RecordRow, ErrorEnvelope> {
    const check = this.#check(input.store, input);
    if (check !== null) return { ok: false, status: "rejected", error: check };
    const result = this.#source
      .prepare(
        `UPDATE ${input.store}
            SET body_json = :body_json,
                parent_key = COALESCE(:parent_key, parent_key),
                task_id = COALESCE(:task_id, task_id),
                branch_id = COALESCE(:branch_id, branch_id),
                input_epoch = COALESCE(:input_epoch, input_epoch),
                goal_version = COALESCE(:goal_version, goal_version),
                config_version = COALESCE(:config_version, config_version),
                watermark = COALESCE(:watermark, watermark),
                content_hash = COALESCE(:content_hash, content_hash)
          WHERE record_kind = :record_kind AND row_key = :row_key`
      )
      .run({
        body_json: JSON.stringify(input.body),
        parent_key: input.parent_key ?? null,
        task_id: input.task_id ?? null,
        branch_id: input.branch_id ?? null,
        input_epoch: input.input_epoch ?? null,
        goal_version: input.goal_version ?? null,
        config_version: input.config_version ?? null,
        watermark: input.watermark ?? null,
        content_hash: input.content_hash ?? null,
        record_kind: input.kind,
        row_key: rowKey(input.kind, input.key)
      });
    if (result.changes === 0) {
      return { ok: false, status: "rejected", error: conflictError() };
    }
    const stored = this.get(input);
    if (!stored.ok) return stored;
    if (stored.value === null) {
      return { ok: false, status: "rejected", error: schemaError("row", "missing_after_write") };
    }
    return { ok: true, status: stored.status, value: stored.value };
  }

  public updateCas(input: CasRecordInput): Result<RecordRow, ErrorEnvelope> {
    const check = this.#check(input.store, input);
    if (check !== null) return { ok: false, status: "rejected", error: check };
    const definition = this.#definition(input.kind);
    if (definition.immutable === true) {
      return { ok: false, status: "rejected", error: conflictError() };
    }
    const currentVersion = input.body["row_version"];
    if (currentVersion !== input.expected_row_version + 1) {
      return { ok: false, status: "rejected", error: conflictError() };
    }
    const result = this.#source
      .prepare(
        `UPDATE ${input.store}
            SET body_json = :body_json,
                parent_key = COALESCE(:parent_key, parent_key),
                task_id = COALESCE(:task_id, task_id),
                branch_id = COALESCE(:branch_id, branch_id),
                input_epoch = COALESCE(:input_epoch, input_epoch),
                goal_version = COALESCE(:goal_version, goal_version),
                config_version = COALESCE(:config_version, config_version),
                watermark = COALESCE(:watermark, watermark),
                content_hash = COALESCE(:content_hash, content_hash)
          WHERE record_kind = :record_kind
            AND row_key = :row_key
            AND json_extract(body_json, '$.row_version') = :expected`
      )
      .run({
        body_json: JSON.stringify(input.body),
        parent_key: input.parent_key ?? null,
        task_id: input.task_id ?? null,
        branch_id: input.branch_id ?? null,
        input_epoch: input.input_epoch ?? null,
        goal_version: input.goal_version ?? null,
        config_version: input.config_version ?? null,
        watermark: input.watermark ?? null,
        content_hash: input.content_hash ?? null,
        record_kind: input.kind,
        row_key: rowKey(input.kind, input.key),
        expected: input.expected_row_version
      });
    if (result.changes === 0) {
      return { ok: false, status: "rejected", error: conflictError() };
    }
    const stored = this.get(input);
    if (!stored.ok) return stored;
    if (stored.value === null) {
      return { ok: false, status: "rejected", error: schemaError("row", "missing_after_write") };
    }
    return { ok: true, status: stored.status, value: stored.value };
  }
}
