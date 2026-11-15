/**
 * Six-field version binding, goal/config version helpers and the MethodRef
 * provenance record (DD-FND-007, DD-FND-031, DD-FND-031.1, DD-FND-031.2).
 *
 * `goal_version` and `config_version` are opaque strings: they are validated
 * for shape and compared byte-for-byte, never parsed, sorted or converted to
 * numbers. Consistency with the branch's current goal is proved by equality
 * against `branch.current_goal_version`, not by splitting the string.
 */

import { isId, type Id } from "./ids.js";
import { canonicalHash, type Hash } from "./hash.js";
import { isWellFormedUnicode, type JsonValue } from "./json.js";
import { makeErrorEnvelope, type ErrorEnvelope } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { Tx } from "./tx.js";

export type GoalVersion = string;

export type ConfigVersion = string;

export interface VersionBinding {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  /** 1..Number.MAX_SAFE_INTEGER; the branch-local logical input sequence. */
  readonly input_epoch: number;
  readonly goal_version: GoalVersion;
  readonly config_version: ConfigVersion;
  /** 0..Number.MAX_SAFE_INTEGER; the evoplug `receipt_seq` watermark. */
  readonly watermark: number;
}

/** Schema version used in the canonical `versionBindingKey` preimage. */
export const VERSION_BINDING_SCHEMA_VERSION: "rsi.version_binding/1" = "rsi.version_binding/1";

/** Schema version of the MethodRef record. */
export const METHOD_REF_SCHEMA_VERSION: "rsi.method_ref/1" = "rsi.method_ref/1";

/** Maximum UTF-8 byte length of each MethodRef string. */
export const METHOD_REF_MAX_STRING_BYTES = 128;

const GOAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CONFIG_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const VERSION_BINDING_FIELDS: readonly string[] = [
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "watermark"
];

/** Raised by throwing helpers when a version string or binding is malformed. */
export class VersionBindingFormatError extends Error {
  readonly code: "E_VERSION_BINDING" | "E_SCHEMA";
  readonly path: string;
  readonly rule: string;

  constructor(code: "E_VERSION_BINDING" | "E_SCHEMA", path: string, rule: string) {
    super(`${code}: ${path} violates ${rule}`);
    this.name = "VersionBindingFormatError";
    this.code = code;
    this.path = path;
    this.rule = rule;
  }
}

/** `goal_version` shape only: 1..256 characters from the frozen alphabet. */
export function isValidGoalVersion(value: string): boolean {
  return typeof value === "string" && GOAL_VERSION_PATTERN.test(value);
}

/** `config_version` shape only; the producer convention is not re-parsed here. */
export function isValidConfigVersion(value: string): boolean {
  return typeof value === "string" && CONFIG_VERSION_PATTERN.test(value);
}

/**
 * Produces the canonical goal version for a branch revision:
 * `gv:<branchId>:<revision>`, with `revision` starting at 1.
 *
 * @throws {VersionBindingFormatError} when the branch id or revision is invalid.
 */
export function makeGoalVersion(branchId: Id<"br">, revision: number): GoalVersion {
  if (!isId(branchId, "br")) {
    throw new VersionBindingFormatError("E_VERSION_BINDING", "branch_id", "br_id");
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new VersionBindingFormatError("E_VERSION_BINDING", "revision", "positive_safe_integer");
  }
  return `gv:${branchId}:${String(revision)}`;
}

/**
 * Canonical binding key: `sha256(JCS({schema_version, ...binding}))`.
 * The key is for caching and comparison only; it never replaces the fields.
 */
export function versionBindingKey(binding: VersionBinding): Hash {
  const preimage: JsonValue = {
    schema_version: VERSION_BINDING_SCHEMA_VERSION,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
  return canonicalHash(preimage);
}

/** Byte-for-byte equality across all six fields; no field is defaulted. */
export function equalVersionBinding(a: VersionBinding, b: VersionBinding): boolean {
  return (
    a.task_id === b.task_id &&
    a.branch_id === b.branch_id &&
    a.input_epoch === b.input_epoch &&
    a.goal_version === b.goal_version &&
    a.config_version === b.config_version &&
    a.watermark === b.watermark
  );
}

export function isVersionBinding(value: unknown): value is VersionBinding {
  return parseVersionBinding(value).ok;
}

/**
 * Structural plus semantic validation of a binding. Structure (object shape,
 * field types, unknown keys) fails with `E_SCHEMA`; range, prefix and version
 * shape failures fail with `E_VERSION_BINDING` (DD-FND-031).
 */
export function parseVersionBinding(value: unknown): Result<VersionBinding, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(schemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!VERSION_BINDING_FIELDS.includes(key)) {
      return err(schemaError(key, "known_field"));
    }
  }
  for (const field of VERSION_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(schemaError(field, "required"));
    }
  }
  const taskId = record["task_id"];
  const branchId = record["branch_id"];
  const inputEpoch = record["input_epoch"];
  const goalVersion = record["goal_version"];
  const configVersion = record["config_version"];
  const watermark = record["watermark"];
  if (typeof taskId !== "string" || typeof branchId !== "string") {
    return err(schemaError("task_id", "string"));
  }
  if (typeof goalVersion !== "string" || typeof configVersion !== "string") {
    return err(schemaError("goal_version", "string"));
  }
  if (typeof inputEpoch !== "number" || typeof watermark !== "number") {
    return err(schemaError("input_epoch", "number"));
  }
  if (!isId(taskId, "task")) {
    return err(versionError("task_id", "task_id"));
  }
  if (!isId(branchId, "br")) {
    return err(versionError("branch_id", "br_id"));
  }
  if (!Number.isSafeInteger(inputEpoch) || inputEpoch < 1) {
    return err(versionError("input_epoch", "positive_safe_integer"));
  }
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    return err(versionError("watermark", "non_negative_safe_integer"));
  }
  if (!isValidGoalVersion(goalVersion)) {
    return err(versionError("goal_version", "goal_version_format"));
  }
  if (!isValidConfigVersion(configVersion)) {
    return err(versionError("config_version", "config_version_format"));
  }
  return ok({
    task_id: taskId,
    branch_id: branchId,
    input_epoch: inputEpoch,
    goal_version: goalVersion,
    config_version: configVersion,
    watermark
  });
}

/** Public method reference owned by FND (DD-FND-031.2). */
export interface MethodRef {
  schema_version: "rsi.method_ref/1";
  method_id: string;
  method_version: string;
  rule_version: string;
}

const METHOD_REF_FIELDS: readonly string[] = ["schema_version", "method_id", "method_version", "rule_version"];

/**
 * Parses a MethodRef. All three strings are required, 1..128 UTF-8 bytes, with
 * no NUL or control characters; comparisons are byte-exact with no trimming or
 * normalization. Any violation fails with `E_SCHEMA`.
 */
export function parseMethodRef(value: unknown): Result<MethodRef, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(schemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!METHOD_REF_FIELDS.includes(key)) {
      return err(schemaError(key, "known_field"));
    }
  }
  for (const field of METHOD_REF_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(schemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== METHOD_REF_SCHEMA_VERSION) {
    return err(schemaError("schema_version", "rsi.method_ref/1"));
  }
  const methodId = record["method_id"];
  const methodVersion = record["method_version"];
  const ruleVersion = record["rule_version"];
  for (const [field, candidate] of [
    ["method_id", methodId],
    ["method_version", methodVersion],
    ["rule_version", ruleVersion]
  ] as const) {
    const failure = validateMethodRefString(field, candidate);
    if (failure !== null) {
      return err(failure);
    }
  }
  return ok({
    schema_version: METHOD_REF_SCHEMA_VERSION,
    method_id: methodId as string,
    method_version: methodVersion as string,
    rule_version: ruleVersion as string
  });
}

/** `methodRefKey(ref) = sha256(JCS(ref))`; not an `Id` and never a primary key. */
export function methodRefKey(ref: MethodRef): Hash {
  const preimage: JsonValue = {
    schema_version: ref.schema_version,
    method_id: ref.method_id,
    method_version: ref.method_version,
    rule_version: ref.rule_version
  };
  return canonicalHash(preimage);
}

/** Current goal view returned by `GoalVersionReadPort` (DD-FND-031.1). */
export interface CurrentGoalView {
  schema_version: "rsi.current_goal_view/1";
  task_id: Id<"task">;
  branch_id: Id<"br">;
  goal_version: GoalVersion;
  goal_revision: number;
  goal_snapshot_id: string | null;
  observed_watermark: number;
}

export interface GoalVersionReadPort {
  getCurrentGoal(input: { task_id: Id<"task">; branch_id: Id<"br"> }): Promise<Result<CurrentGoalView, ErrorEnvelope>>;
  getCurrentGoalInTransaction(
    tx: Tx,
    input: { task_id: Id<"task">; branch_id: Id<"br"> }
  ): Result<CurrentGoalView, ErrorEnvelope>;
}

/** Active config version view returned by `ConfigVersionReadPort`. */
export interface ConfigVersionView {
  schema_version: "rsi.config_version_view/1";
  config_space: string;
  config_version: ConfigVersion;
  content_hash: Hash;
}

export interface ConfigVersionReadPort {
  getCurrentConfigVersion(input: { config_space: string }): Promise<Result<ConfigVersionView, ErrorEnvelope>>;
  getCurrentConfigVersionInTransaction(
    tx: Tx,
    input: { config_space: string }
  ): Result<ConfigVersionView, ErrorEnvelope>;
}

function validateMethodRefString(field: string, candidate: unknown): ErrorEnvelope | null {
  if (typeof candidate !== "string") {
    return schemaError(field, "string");
  }
  if (!isWellFormedUnicode(candidate)) {
    return schemaError(field, "well_formed_unicode");
  }
  if (candidate.length === 0) {
    return schemaError(field, "non_empty");
  }
  if (new TextEncoder().encode(candidate).length > METHOD_REF_MAX_STRING_BYTES) {
    return schemaError(field, "max_128_utf8_bytes");
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const codeUnit = candidate.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit === 0x7f) {
      return schemaError(field, "no_control_characters");
    }
  }
  return null;
}

function schemaError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "schema_validate",
    details: { kind: "field", path, rule }
  });
}

function versionError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_VERSION_BINDING",
    category: "version",
    message_key: "error.version_binding",
    stage: "binding",
    details: { kind: "version", expected: rule, actual: path }
  });
}
