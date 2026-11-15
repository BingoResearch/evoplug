/**
 * Field value, default and config-path validation (DD-CFG-020 … DD-CFG-026,
 * DD-CFG-033, DD-CFG-048).
 */

import type {
  AssignmentValue,
  ConfigPath,
  ConfigResult,
  ConfigScalar,
  ConfigUnit,
  ConfigValueSchema,
  ConstructionPath,
  DefaultSpec,
  FieldSpec
} from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import { configScalarKey } from "./hash.js";

/* ------------------------------------------------------------------ */
/* Config path validation                                              */
/* ------------------------------------------------------------------ */

const ROOT_TOKENS: ReadonlySet<string> = new Set(["user", "project", "managed", "session"]);
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._@+-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Validates a relative POSIX path used by a file `ConfigPath` (DD-CFG-183). */
export function isValidRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.length > 1024) {
    return false;
  }
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(relativePath) || relativePath.startsWith("//")) {
    return false;
  }
  if (relativePath.includes("\\") || relativePath.includes("\u0000")) {
    return false;
  }
  if (relativePath.startsWith("~") || relativePath.includes("$")) {
    return false;
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return false;
    }
    if (!PATH_SEGMENT_PATTERN.test(segment)) {
      return false;
    }
  }
  return true;
}

/** JSON pointer shape: empty or `/`-prefixed tokens with `~0`/`~1` escapes. */
export function isValidJsonPointer(pointer: string): boolean {
  if (pointer === "") {
    return true;
  }
  if (!pointer.startsWith("/")) {
    return false;
  }
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(raw)) {
      return false;
    }
  }
  return true;
}

export function isValidConfigPath(path: ConfigPath): boolean {
  switch (path.kind) {
    case "file":
      return (
        ROOT_TOKENS.has(path.root) &&
        isValidRelativePath(path.relative_path) &&
        isValidJsonPointer(path.pointer)
      );
    case "settings_api":
      return (
        path.api_id === "openhands_server_settings" &&
        path.merge === "deep_merge" &&
        path.readback === "api_get" &&
        path.key_path.every((segment) => segment.length > 0)
      );
    case "setter":
      return path.setter_id.length > 0 && (path.scope === "session" || path.scope === "agent");
    case "env":
      return ENV_NAME_PATTERN.test(path.name);
  }
}

/** Canonical text of a config path; never contains an absolute path. */
export function configPathKey(path: ConfigPath): string {
  switch (path.kind) {
    case "file":
      return `file:${path.root}/${path.relative_path}#${path.pointer}`;
    case "settings_api":
      return `settings_api:${path.api_id}#/${path.key_path.join("/")}`;
    case "setter":
      return `setter:${path.scope}:${path.setter_id}`;
    case "env":
      return `env:${path.name}`;
  }
}

/* ------------------------------------------------------------------ */
/* Assignment values                                                   */
/* ------------------------------------------------------------------ */

export function presentValue(value: ConfigScalar): AssignmentValue {
  return { presence: "present", value };
}

export function absentValue(): AssignmentValue {
  return { presence: "absent" };
}

export function assignmentValueKey(value: AssignmentValue): string {
  return value.presence === "absent" ? "\u0000absent" : `\u0000${configScalarKey(value.value)}`;
}

export function assignmentValuesEqual(left: AssignmentValue, right: AssignmentValue): boolean {
  if (left.presence !== right.presence) {
    return false;
  }
  if (left.presence === "absent" || right.presence === "absent") {
    return true;
  }
  return Object.is(left.value, right.value);
}

/* ------------------------------------------------------------------ */
/* Schema validation                                                   */
/* ------------------------------------------------------------------ */

function schemaUnitMismatch(spec: FieldSpec): boolean {
  const schema = spec.value_schema;
  switch (schema.kind) {
    case "boolean":
      return spec.unit !== "none";
    case "enum":
      return spec.unit !== "none" && spec.unit !== "effort_level" && spec.unit !== "model_ref";
    case "integer":
    case "number":
    case "integer_or_enum":
      return spec.unit !== schema.unit;
    case "string":
      return spec.unit !== schema.unit;
    case "unverified":
      return false;
  }
}

/**
 * Registry-level schema consistency (DD-CFG-021, DD-CFG-023).
 *
 * `unverified` schemas may never back an `active` field, and the field unit
 * must equal the value schema unit.
 */
/** Construction paths that can bind an OpenHands Server settings API path. */
const SETTINGS_API_CONSTRUCTION_PATHS: ReadonlySet<ConstructionPath> = new Set([
  "server_settings",
  "direct_agent",
  "preset_agent",
  "subagent_factory"
]);

export function validateSpecSchema(spec: FieldSpec): ConfigResult<void> {
  if (schemaUnitMismatch(spec)) {
    return fail(configError("E_CFG_FIELD_UNIT", { field_id: spec.field_id }));
  }
  if (spec.value_schema.kind === "unverified" && spec.status === "active") {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id }));
  }
  const valueSchema = spec.value_schema;
  if (
    (valueSchema.kind === "enum" || valueSchema.kind === "integer_or_enum") &&
    valueSchema.availability === "host_catalog" &&
    spec.status === "active"
  ) {
    // A catalog enum without pinned catalog evidence cannot be executable
    // (DD-CFG-022).
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id }));
  }
  for (const layer of spec.source_layers) {
    if (!isValidConfigPath(layer.path)) {
      // Path shape is a type error; capability evidence is a separate axis
      // (DD-CFG-026, DD-CFG-030).
      return fail(configError("E_CFG_FIELD_TYPE", { field_id: spec.field_id }));
    }
    if (
      layer.path.kind === "settings_api" &&
      !SETTINGS_API_CONSTRUCTION_PATHS.has(spec.construction_path)
    ) {
      // `settings_api` must be checked together with the construction path
      // that owns the Server settings surface (DD-CFG-026).
      return fail(configError("E_CFG_FIELD_TYPE", { field_id: spec.field_id }));
    }
  }
  return succeed(undefined);
}

function inRange(value: number, min: number, max: number | null): boolean {
  if (!Number.isFinite(value) || value < min) {
    return false;
  }
  if (max !== null && value > max) {
    return false;
  }
  return true;
}

function matchesEnum(schemaValues: readonly ConfigScalar[], value: ConfigScalar): boolean {
  const key = configScalarKey(value);
  return schemaValues.some((candidate) => configScalarKey(candidate) === key);
}

function scalarTypeError(fieldId: string, expected: string): ConfigResult<never> {
  return fail(
    configError("E_CFG_FIELD_TYPE", {
      field_id: fieldId,
      details: [{ key: "expected", value: expected }]
    })
  );
}

function rangeError(fieldId: string, unit: ConfigUnit, min: number, max: number | null): ConfigResult<never> {
  return fail(
    configError("E_CFG_FIELD_RANGE", {
      field_id: fieldId,
      details: [
        { key: "unit", value: unit },
        { key: "min", value: min },
        { key: "max", value: max }
      ]
    })
  );
}

function expectedScalarLabel(schema: ConfigValueSchema): string {
  switch (schema.kind) {
    case "boolean":
      return "boolean";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "enum":
      return "enum";
    case "integer_or_enum":
      return "integer_or_enum";
    case "string":
      return "string";
    case "unverified":
      return schema.documented_shape;
  }
}

/**
 * Validates a present scalar against the field's `ConfigValueSchema`
 * (DD-CFG-021 … DD-CFG-023). `absent` is always a legal assignment value;
 * absence semantics are decided by coupling and default rules.
 */
export function validatePresentValue(spec: FieldSpec, value: ConfigScalar): ConfigResult<void> {
  const schema = spec.value_schema;
  // DD-CFG-020: only `ConfigScalar` values are admissible. Arrays, objects,
  // `undefined`, `NaN` and `Infinity` never reach a discriminator branch.
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    return scalarTypeError(spec.field_id, expectedScalarLabel(schema));
  }
  switch (schema.kind) {
    case "boolean":
      if (typeof value !== "boolean") {
        return scalarTypeError(spec.field_id, "boolean");
      }
      return succeed(undefined);
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return scalarTypeError(spec.field_id, "integer");
      }
      if (!inRange(value, schema.min, schema.max)) {
        return rangeError(spec.field_id, schema.unit, schema.min, schema.max);
      }
      return succeed(undefined);
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return scalarTypeError(spec.field_id, "number");
      }
      const belowMin = schema.exclusive_min ? value <= schema.min : value < schema.min;
      const aboveMax =
        schema.max === null ? false : schema.exclusive_max ? value >= schema.max : value > schema.max;
      if (belowMin || aboveMax) {
        return rangeError(spec.field_id, schema.unit, schema.min, schema.max);
      }
      return succeed(undefined);
    }
    case "enum":
      if (value === null && !matchesEnum(schema.values, null)) {
        return scalarTypeError(spec.field_id, "enum");
      }
      if (!matchesEnum(schema.values, value)) {
        return fail(
          configError("E_CFG_FIELD_RANGE", {
            field_id: spec.field_id,
            details: [{ key: "unit", value: spec.unit }]
          })
        );
      }
      return succeed(undefined);
    case "integer_or_enum":
      if (matchesEnum(schema.values, value)) {
        return succeed(undefined);
      }
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return scalarTypeError(spec.field_id, "integer_or_enum");
      }
      if (!inRange(value, schema.min, schema.max)) {
        return rangeError(spec.field_id, schema.unit, schema.min, schema.max);
      }
      return succeed(undefined);
    case "string": {
      if (typeof value !== "string") {
        return scalarTypeError(spec.field_id, "string");
      }
      if (value.length > schema.max_length) {
        return fail(
          configError("E_CFG_FIELD_RANGE", {
            field_id: spec.field_id,
            details: [{ key: "max_length", value: schema.max_length }]
          })
        );
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern, "u");
      } catch {
        return fail(configError("E_CFG_REGISTRY_AMBIGUOUS", { field_id: spec.field_id }));
      }
      if (!pattern.test(value)) {
        return fail(configError("E_CFG_FIELD_TYPE", { field_id: spec.field_id }));
      }
      return succeed(undefined);
    }
    case "unverified":
      switch (schema.documented_shape) {
        case "boolean":
          return typeof value === "boolean" ? succeed(undefined) : scalarTypeError(spec.field_id, "boolean");
        case "integer":
          return typeof value === "number" && Number.isSafeInteger(value)
            ? succeed(undefined)
            : scalarTypeError(spec.field_id, "integer");
        case "number":
          return typeof value === "number" && Number.isFinite(value)
            ? succeed(undefined)
            : scalarTypeError(spec.field_id, "number");
        case "string":
          return typeof value === "string" ? succeed(undefined) : scalarTypeError(spec.field_id, "string");
        case "enum":
          if (schema.known_values === null || matchesEnum(schema.known_values, value)) {
            return succeed(undefined);
          }
          return fail(configError("E_CFG_NORMALIZATION_UNVERIFIED", { field_id: spec.field_id }));
      }
  }
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolves the baseline `AssignmentValue` implied by `default_spec`.
 * `unknown` never invents a value (DD-CFG-025).
 */
export function resolveDefault(
  spec: FieldSpec,
  constructionPath: ConstructionPath
): ConfigResult<AssignmentValue> {
  const defaultSpec: DefaultSpec = spec.default_spec;
  switch (defaultSpec.kind) {
    case "fixed": {
      const check = validatePresentValue(spec, defaultSpec.value);
      if (!check.ok) {
        return fail(check.error);
      }
      return succeed({ presence: "present", value: defaultSpec.value });
    }
    case "absent":
      if (defaultSpec.effective_rule_id.length === 0) {
        return fail(configError("E_CFG_DEFAULT_UNKNOWN", { field_id: spec.field_id }));
      }
      return succeed({ presence: "absent" });
    case "path_dependent": {
      const match = defaultSpec.cases.find((entry) => entry.path === constructionPath);
      if (match === undefined) {
        return fail(configError("E_CFG_DEFAULT_UNKNOWN", { field_id: spec.field_id }));
      }
      return succeed(match.value);
    }
    case "unknown":
      return fail(configError("E_CFG_DEFAULT_UNKNOWN", { field_id: spec.field_id }));
  }
}

/* ------------------------------------------------------------------ */
/* Field comparison helpers                                            */
/* ------------------------------------------------------------------ */

export type SpecIndex = ReadonlyMap<string, FieldSpec>;

export function indexSpecsById(specs: readonly FieldSpec[]): SpecIndex {
  const index = new Map<string, FieldSpec>();
  for (const spec of specs) {
    index.set(spec.field_id, spec);
  }
  return index;
}

export function indexSpecsByKey(specs: readonly FieldSpec[]): ReadonlyMap<string, readonly FieldSpec[]> {
  const index = new Map<string, FieldSpec[]>();
  for (const spec of specs) {
    const list = index.get(spec.field_key);
    if (list === undefined) {
      index.set(spec.field_key, [spec]);
    } else {
      list.push(spec);
    }
  }
  return index;
}

/** True when the assignment equals `value` for CAS comparison. */
export function readbackMatches(observed: AssignmentValue, expected: AssignmentValue): boolean {
  return assignmentValuesEqual(observed, expected);
}
