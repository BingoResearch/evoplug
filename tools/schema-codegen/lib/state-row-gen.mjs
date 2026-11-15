// Generates state-row-types.ts, state-row-keys.ts and
// state-row-registry.generated.json from schemas/ledger/state-row-registry.json
// (DD-FND-059.1). Rows are complete physical after-images; the registry is the
// single source for StateRowTypeMap, StateRowKeyMap and the ledger CHECK list.

import { fail, sha256Text, sortedJson } from "./utils.mjs";

// DD-FND-059.1.1 publishes the REV row schemas without the `_row` infix
// (`rsi.review_snapshot/1`, `rsi.review_job/2`, `rsi.review_attempt/1`); the
// `_row` infix is the FND convention, not a naming rule.
const SCHEMA_KEY = /^rsi\.[a-z0-9_]+(_row)?\/[0-9]+$/;

export function generateStateRowModules(registry) {
  if (registry.schema_version !== "rsi.state_row_registry/1") {
    fail("state-row-registry: schema_version must be rsi.state_row_registry/1");
  }
  if (!Array.isArray(registry.rows) || registry.rows.length === 0) {
    fail("state-row-registry: rows must be non-empty");
  }
  const seen = new Set();
  const types = [];
  for (const row of registry.rows) {
    validateRow(row);
    if (seen.has(row.row_schema)) fail(`state-row-registry: duplicate ${row.row_schema}`);
    seen.add(row.row_schema);
    types.push(renderRowType(row));
  }
  const typesModule = renderTypesModule(registry, types);
  const keysModule = renderKeysModule(registry);
  const generatedRegistry = {
    schema_version: registry.schema_version,
    source_hash: `sha256:${sha256Text(JSON.stringify(sortedJson(registry)))}`,
    rows: registry.rows.map((row) => ({
      row_schema: row.row_schema,
      owner_domain: row.owner_domain,
      table: row.table,
      primary_key: row.primary_key,
      unique_keys: row.unique_keys ?? [],
      event_types: row.event_types,
      allowed_operations: row.allowed_operations,
      binding_source: row.binding_source,
      row_versioned: row.row_versioned,
      blob_ref_paths: row.blob_ref_paths ?? [],
      payload_blob_paths: row.payload_blob_paths ?? [],
      derived_reducer: row.derived_reducer ?? null,
      document: row.document ?? null,
      allocation: row.allocation ?? null,
      schema_artifact: row.schema_artifact,
      ts_type: row.ts_type,
      // The physical column set of the row. The journal-only reducer checks
      // the frozen `row_json` against it, so an injected column or a missing
      // one is rejected before the row becomes visible.
      columns: (row.columns ?? []).map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable ?? false,
        json_text: column.json_text ?? false
      })),
    })),
    ledger_event_log_check: {
      event_types: [...new Set(registry.rows.flatMap((row) => row.event_types))].sort(),
      entity_types: [...new Set(registry.rows.map((row) => entityTypeFor(row.event_types)))].sort(),
      state_row_schemas: registry.rows.map((row) => row.row_schema).sort(),
    },
  };
  return { typesModule, keysModule, generatedRegistry };
}

function validateRow(row) {
  for (const field of [
    "row_schema",
    "owner_domain",
    "table",
    "primary_key",
    "event_types",
    "allowed_operations",
    "binding_source",
    "row_versioned",
    "schema_artifact",
    "ts_type",
  ]) {
    if (row[field] === undefined) fail(`state-row-registry: ${row.row_schema ?? "?"} misses ${field}`);
  }
  if (!SCHEMA_KEY.test(row.row_schema)) fail(`state-row-registry: invalid row_schema ${row.row_schema}`);
  if (!["fnd", "evd", "rev", "host", "cfg", "qp"].includes(row.owner_domain)) {
    fail(`state-row-registry: ${row.row_schema} owner_domain invalid`);
  }
  if (!Array.isArray(row.primary_key) || row.primary_key.length === 0) {
    fail(`state-row-registry: ${row.row_schema} primary_key empty`);
  }
  if (!Array.isArray(row.columns) || row.columns.length === 0) {
    fail(`state-row-registry: ${row.row_schema} columns empty`);
  }
  const names = new Set();
  for (const column of row.columns) {
    if (typeof column.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(column.name)) {
      fail(`state-row-registry: ${row.row_schema} invalid column ${JSON.stringify(column)}`);
    }
    if (names.has(column.name)) fail(`state-row-registry: ${row.row_schema} duplicate column ${column.name}`);
    names.add(column.name);
  }
  for (const key of row.primary_key) {
    if (!names.has(key)) fail(`state-row-registry: ${row.row_schema} PK ${key} not a column`);
  }
  for (const unique of row.unique_keys ?? []) {
    for (const key of unique) {
      if (!names.has(key)) fail(`state-row-registry: ${row.row_schema} unique ${key} not a column`);
    }
  }
}

function entityTypeFor(eventTypes) {
  if (eventTypes.includes("state_row.recorded")) return "state_row";
  if (eventTypes.some((event) => event.startsWith("install."))) return "adapter_install_approval";
  if (eventTypes.some((event) => event.startsWith("root."))) return "root_registration";
  return eventTypes[0].split(".")[0];
}

function renderRowType(row) {
  const fields = row.columns.map((column) => {
    const type = columnType(column);
    const nullable = column.nullable === true ? " | null" : "";
    const optional = column.optional === true ? "?" : "";
    return `  readonly ${column.name}${optional}: ${type}${nullable};`;
  });
  return `export interface ${row.ts_type} {\n${fields.join("\n")}\n}`;
}

function columnType(column) {
  if (Array.isArray(column.enum)) {
    if (column.enum.length === 0) fail(`state-row-registry: empty enum for ${column.name}`);
    return column.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(column.const)) fail(`state-row-registry: const must be scalar for ${column.name}`);
  if (column.const !== undefined) return JSON.stringify(column.const);
  switch (column.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return "string";
    case "array":
      return `readonly (${column.items === "number" ? "number" : "string"})[]`;
    case "union":
      if (!Array.isArray(column.types)) fail(`state-row-registry: union needs types for ${column.name}`);
      return column.types.map((type) => columnType({ type })).join(" | ");
    default:
      fail(`state-row-registry: unknown column type ${String(column.type)} for ${column.name}`);
  }
}

function renderTypesModule(registry, typeDeclarations) {
  const mapEntries = registry.rows
    .map((row) => `  readonly ${JSON.stringify(row.row_schema)}: ${row.ts_type};`)
    .join("\n");
  return [
    "// DO NOT EDIT. Generated by tools/schema-codegen/cli.mjs.",
    "// Source: schemas/ledger/state-row-registry.json",
    "",
    "/* eslint-disable */",
    "",
    typeDeclarations.join("\n\n"),
    "",
    "export interface StateRowTypeMap {",
    mapEntries,
    "}",
    "",
    "export type StateRowSchema = keyof StateRowTypeMap;",
    "",
  ].join("\n");
}

function renderKeysModule(registry) {
  // The key map names the concrete row types, so the module has to import
  // them; `isolatedDeclarations` needs the names to be resolvable when the
  // declaration file is emitted.
  const rowTypeImports = [...new Set(registry.rows.map((row) => row.ts_type))]
    .sort()
    .map((tsType) => `  ${tsType},`);
  const keyEntries = registry.rows
    .map((row) => {
      const picks = row.primary_key.map((key) => JSON.stringify(key)).join(" | ");
      return `  readonly ${JSON.stringify(row.row_schema)}: Pick<${row.ts_type}, ${picks}>;`;
    })
    .join("\n");
  const columnEntries = registry.rows
    .map((row) => {
      const columns = (row.columns ?? []).map(
        (column) =>
          `    { name: ${JSON.stringify(column.name)}, type: ${JSON.stringify(column.type)}, nullable: ${column.nullable ?? false}, json_text: ${column.json_text ?? false} },`
      );
      return [
        `  ${JSON.stringify(row.row_schema)}: [`,
        ...columns,
        "  ],",
      ].join("\n");
    })
    .join("\n");
  const registrations = registry.rows
    .map((row) =>
      [
        "  {",
        `    row_schema: ${JSON.stringify(row.row_schema)},`,
        `    owner_domain: ${JSON.stringify(row.owner_domain)},`,
        `    table: ${JSON.stringify(row.table)},`,
        `    primary_key: ${JSON.stringify(row.primary_key)},`,
        `    unique_keys: ${JSON.stringify(row.unique_keys ?? [])},`,
        `    event_types: ${JSON.stringify(row.event_types)},`,
        `    allowed_operations: ${JSON.stringify(row.allowed_operations)},`,
        `    binding_source: ${JSON.stringify(row.binding_source)},`,
        `    row_versioned: ${String(row.row_versioned)},`,
        `    blob_ref_paths: ${JSON.stringify(row.blob_ref_paths ?? [])},`,
        `    payload_blob_paths: ${JSON.stringify(row.payload_blob_paths ?? [])},`,
        `    derived_reducer: ${row.derived_reducer ? JSON.stringify(row.derived_reducer) : "null"},`,
        `    document: ${JSON.stringify(row.document ?? null)},`,
        `    allocation: ${JSON.stringify(row.allocation ?? null)},`,
        `    schema_artifact: ${JSON.stringify(row.schema_artifact)},`,
        `    ts_type: ${JSON.stringify(row.ts_type)},`,
        "  },",
      ].join("\n"),
    )
    .join("\n");
  return [
    "// DO NOT EDIT. Generated by tools/schema-codegen/cli.mjs.",
    "// Source: schemas/ledger/state-row-registry.json",
    "// The key hash preimage only contains strings, safe integers and null.",
    "// This file implements the flat-subset JCS encoding locally so generated",
    "// code does not depend on hand-written core modules.",
    "",
    "/* eslint-disable */",
    "// @ts-nocheck -- generated maps index generic rows by registry keys.",
    'import { createHash } from "node:crypto";',
    `import type {`,
    ...rowTypeImports,
    `} from "./state-row-types.js";`,
    'import type { StateRowTypeMap, StateRowSchema } from "./state-row-types.js";',
    "",
    "export type StateRowOperation = \"insert\" | \"update\" | \"transition\";",
    "",
    "export interface StateRowDocumentRegistration {",
    "  readonly owner: \"evd\" | \"rev\" | \"host\" | \"cfg\" | \"qp\";",
    "  readonly object_type: string;",
    "  readonly object_id_field: string;",
    "  readonly revision_field: string;",
    "}",
    "",
    "export interface StateRowAllocationRegistration {",
    "  readonly field: string;",
    "  readonly scope_fields: readonly string[];",
    '  readonly rule: "max_plus_one";',
    "}",
    "",
    "export interface StateRowRegistration<S extends StateRowSchema = StateRowSchema> {",
    "  readonly row_schema: S;",
    '  readonly owner_domain: "fnd" | "evd" | "rev" | "host" | "cfg" | "qp";',
    "  readonly table: string;",
    "  readonly primary_key: readonly (keyof StateRowTypeMap[S] & string)[];",
    "  readonly unique_keys: readonly (readonly (keyof StateRowTypeMap[S] & string)[])[];",
    '  readonly event_types: readonly ("state_row.recorded" | string)[];',
    "  readonly allowed_operations: readonly StateRowOperation[];",
    '  readonly binding_source: "row" | "batch" | "none";',
    "  readonly row_versioned: boolean;",
    "  readonly blob_ref_paths: readonly string[];",
    "  readonly payload_blob_paths: readonly string[];",
    "  readonly derived_reducer: string | null;",
    "  readonly document: StateRowDocumentRegistration | null;",
    "  readonly allocation: StateRowAllocationRegistration | null;",
    "  readonly schema_artifact: string;",
    "  readonly ts_type: string;",
    "}",
    "",
    "export interface StateRowKeyMap {",
    keyEntries,
    "}",
    "",
    "export interface StateRowColumn {",
    "  readonly name: string;",
    "  readonly type: \"string\" | \"number\" | \"boolean\" | \"object\" | \"array\" | \"null\";",
    "  readonly nullable: boolean;",
    "  readonly json_text: boolean;",
    "}",
    "",
    "export const STATE_ROW_COLUMNS: Readonly<Record<string, readonly StateRowColumn[]>> = {",
    columnEntries,
    "};",
    "",
    "export const STATE_ROW_REGISTRATIONS: readonly StateRowRegistration[] = [",
    registrations,
    "];",
    "",
    "const REGISTRATIONS_BY_SCHEMA: ReadonlyMap<string, StateRowRegistration> = new Map(",
    "  STATE_ROW_REGISTRATIONS.map((row) => [row.row_schema, row]),",
    ");",
    "",
    "function flatCanonicalJson(value: unknown): string {",
    "  if (value === null) return \"null\";",
    "  if (typeof value === \"string\") return JSON.stringify(value);",
    "  if (typeof value === \"number\") {",
    "    if (!Number.isFinite(value)) throw new RangeError(\"E_SCHEMA: non-finite number in state row key\");",
    "    return JSON.stringify(value);",
    "  }",
    "  if (typeof value === \"boolean\") return value ? \"true\" : \"false\";",
    "  if (Array.isArray(value)) return `[${value.map(flatCanonicalJson).join(\",\")}]`;",
    "  if (typeof value === \"object\") {",
    "    const record = value as { readonly [key: string]: unknown };",
    "    const keys = Object.keys(record).sort();",
    "    return `{${keys.map((key) => `${JSON.stringify(key)}:${flatCanonicalJson(record[key])}`).join(\",\")}}`;",
    "  }",
    "  throw new RangeError(\"E_SCHEMA: unsupported value in state row key\");",
    "}",
    "",
    "function canonicalHash(value: unknown): string {",
    "  return \"sha256:\" + createHash(\"sha256\").update(Buffer.from(flatCanonicalJson(value), \"utf8\")).digest(\"hex\");",
    "}",
    "",
    "export function stateRowKey<S extends StateRowSchema>(",
    "  row_schema: S,",
    "  row: StateRowTypeMap[S],",
    "): string {",
    "  const registration = REGISTRATIONS_BY_SCHEMA.get(row_schema);",
    "  if (registration === undefined) throw new RangeError(\"E_STATE_ROW_SCHEMA: unregistered row schema \" + row_schema);",
    "  const key: Record<string, unknown> = {};",
    "  for (const column of registration.primary_key) {",
    "    key[column] = recordValue(row as Record<string, unknown>, column);",
    "  }",
    "  return canonicalHash({ schema_version: \"rsi.state_row_key/1\", row_schema, key });",
    "}",
    "",
    "function recordValue(record: Record<string, unknown>, key: string): unknown {",
    "  if (!(key in record)) throw new RangeError(\"E_STATE_ROW_SCHEMA: missing key column \" + key);",
    "  const value = record[key];",
    "  if (value === undefined) throw new RangeError(\"E_STATE_ROW_SCHEMA: undefined key column \" + key);",
    "  return value;",
    "}",
    "",
    "export function objectDocumentId(q: {",
    "  readonly owner: string;",
    "  readonly object_type: string;",
    "  readonly object_id: string;",
    "  readonly revision: number;",
    "}): string {",
    "  return canonicalHash({",
    '    schema_version: "rsi.object_document_key/1",',
    "    owner: q.owner,",
    "    object_type: q.object_type,",
    "    object_id: q.object_id,",
    "    revision: q.revision,",
    "  });",
    "}",
    "",
  ].join("\n");
}
