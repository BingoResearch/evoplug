// Physical row schema artifacts for the EVD state-row registry.
//
// The evidence registry names one artifact per row under
// `schemas/domains/evidence/state-rows/`. The artifacts are not JSON Schema
// wire contracts; they describe the frozen physical `row_json` of the EVD
// tables. The migration DDL is the single physical source, and the registry
// supplies the row order, artifact path and TS row type name. Generating the
// artifacts from both keeps a renamed column, a changed nullability, an enum
// edit or a missing file visible in `schema:check`.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { fail, jsonText, readJson } from "./utils.mjs";

const DDL_DIR = "migrations/domains/evidence";
const REGISTRY_PATH = "schemas/domains/evidence/state-row-registry.json";
const ARTIFACT_DIR = "schemas/domains/evidence/state-rows";
const ARTIFACT_PREFIX = `${ARTIFACT_DIR}/`;

export async function buildEvidenceStateRowArtifacts({ repoRoot }) {
  const registry = await readJson(path.join(repoRoot, REGISTRY_PATH));
  validateRegistry(registry);
  // Applied migrations are immutable, so a table whose CHECK constraint must
  // change is rebuilt by a later migration. Scan every evidence migration in
  // order and apply its CREATE/DROP/RENAME statements: a rebuilt table gets
  // its final name back after the migration, so the resulting map is the
  // physical shape after all migrations, not just after the baseline.
  const ddlFiles = (await readdir(path.join(repoRoot, DDL_DIR)))
    .filter((name) => name.endsWith(".sql") || name.endsWith(".sql.frozen"))
    .sort();
  if (ddlFiles.length === 0) fail("evidence state rows: no evidence migrations found");
  const tables = new Map();
  for (const name of ddlFiles) {
    const ddl = await readFile(path.join(repoRoot, DDL_DIR, name), "utf8");
    applyEvidenceDdl(tables, ddl, name);
  }
  if (tables.size === 0) fail("evidence state rows: no evd_* CREATE TABLE statements");
  for (const table of tables.keys()) {
    if (!/^evd_[a-z_]+$/.test(table)) {
      fail(`evidence state rows: migration leaves unregistered table name ${table}`);
    }
  }

  const registered = new Set(registry.rows.map((row) => row.table));
  if (tables.size !== registered.size) {
    fail(
      `evidence state rows: DDL has ${tables.size} tables, registry has ${registered.size} rows`,
    );
  }
  for (const table of tables.keys()) {
    if (!registered.has(table)) {
      fail(`evidence state rows: DDL table ${table} is not registered`);
    }
  }

  const outputs = new Map();
  for (const row of registry.rows) {
    const table = tables.get(row.table);
    if (!table) {
      fail(`evidence state rows: registry table ${row.table} is missing from the DDL`);
    }
    const relative = row.schema_artifact;
    if (typeof relative !== "string" || !relative.startsWith(ARTIFACT_PREFIX) || !relative.endsWith(".json")) {
      fail(`evidence state rows: invalid schema_artifact for ${row.row_schema}`);
    }
    if (outputs.has(relative)) {
      fail(`evidence state rows: duplicate schema_artifact ${relative}`);
    }
    outputs.set(relative, jsonText(renderArtifact(row, table)));
  }
  return outputs;
}

export async function checkEvidenceStateRowArtifacts({ repoRoot }) {
  const expected = await buildEvidenceStateRowArtifacts({ repoRoot });
  const problems = [];
  let checked = 0;
  for (const [relative, text] of expected) {
    const absolute = path.join(repoRoot, relative);
    if (!existsSync(absolute)) {
      problems.push(`missing ${relative}`);
      continue;
    }
    const actual = await readFile(absolute, "utf8");
    checked += 1;
    if (actual !== text) {
      problems.push(`drift ${relative}${describeDrift(actual, text)}`);
    }
  }

  const dir = path.join(repoRoot, ARTIFACT_DIR);
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const relative = `${ARTIFACT_DIR}/${entry.name}`;
    if (!expected.has(relative)) {
      problems.push(`orphan ${relative}`);
    }
  }
  return { checked, problems };
}

function describeDrift(actualText, expectedText) {
  let actual;
  let expected;
  try {
    actual = JSON.parse(actualText);
    expected = JSON.parse(expectedText);
  } catch {
    return " (invalid JSON)";
  }
  const details = [];
  for (const key of ["$schema", "$id", "title", "type", "additionalProperties"]) {
    if (JSON.stringify(actual?.[key]) !== JSON.stringify(expected[key])) {
      details.push(`${key} differs`);
    }
  }
  const actualRequired = Array.isArray(actual?.required) ? actual.required : [];
  const expectedRequired = Array.isArray(expected.required) ? expected.required : [];
  const missingRequired = expectedRequired.filter((name) => !actualRequired.includes(name));
  const extraRequired = actualRequired.filter((name) => !expectedRequired.includes(name));
  if (missingRequired.length > 0) details.push(`required missing ${missingRequired.join(",")}`);
  if (extraRequired.length > 0) details.push(`required unexpected ${extraRequired.join(",")}`);
  const actualProperties = actual?.properties ?? {};
  const expectedProperties = expected.properties ?? {};
  for (const name of Object.keys(expectedProperties)) {
    if (!(name in actualProperties)) {
      details.push(`property ${name} missing`);
    } else if (JSON.stringify(actualProperties[name]) !== JSON.stringify(expectedProperties[name])) {
      details.push(`property ${name} differs`);
    }
  }
  for (const name of Object.keys(actualProperties)) {
    if (!(name in expectedProperties)) details.push(`property ${name} unexpected`);
  }
  return details.length === 0 ? " (formatting)" : ` (${details.slice(0, 6).join("; ")})`;
}

function validateRegistry(registry) {  if (registry?.schema_version !== "rsi.state_row_registry/1" || registry?.owner_domain !== "evd") {
    fail("evidence state rows: unexpected registry header");
  }
  if (!Array.isArray(registry.rows) || registry.rows.length === 0) {
    fail("evidence state rows: registry rows must be non-empty");
  }
  const schemas = new Set();
  for (const row of registry.rows) {
    if (typeof row.row_schema !== "string" || schemas.has(row.row_schema)) {
      fail("evidence state rows: duplicate or invalid row_schema");
    }
    schemas.add(row.row_schema);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(row.ts_type ?? "")) {
      fail(`evidence state rows: invalid ts_type for ${row.row_schema}`);
    }
    if (typeof row.table !== "string" || !/^evd_[a-z_]+$/.test(row.table)) {
      fail(`evidence state rows: invalid table for ${row.row_schema}`);
    }
  }
}

function renderArtifact(row, table) {
  const required = table.columns.filter((column) => column.notNull).map((column) => column.name);
  const properties = {};
  for (const column of table.columns) {
    properties[column.name] = renderProperty(column);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:evoplug:schema:${row.row_schema.replace(/^rsi\./, "").replace(/\/[0-9]+$/, "")}:1`,
    title: row.ts_type,
    description: `Physical row of ${row.table} (DD-EVD-024); values are the frozen row_json columns.`,
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function renderProperty(column) {
  const property = { type: column.notNull ? column.jsonType : [column.jsonType, "null"] };
  if (column.enumValues !== null) {
    property.enum = column.enumValues;
  }
  if (column.constValue !== null) {
    property.const = column.constValue;
  }
  if (column.minimum !== null) {
    property.minimum = column.minimum;
  }
  if (column.maximum !== null) {
    property.maximum = column.maximum;
  }
  if (column.pattern !== null) {
    property.pattern = column.pattern;
  }
  if (column.jsonText !== null) {
    property.description = `JCS text; JSON ${column.jsonText}`;
  }
  return property;
}

/**
 * Applies one evidence migration's table DDL in statement order.
 *
 * Table-rebuild migrations create a temporary table, drop the old one and
 * rename the temporary table into place. Parsing only the CREATE statements
 * would either see the old baseline shape or mistake the temporary table for
 * a registered row, so the three statement kinds are replayed here.
 */
function applyEvidenceDdl(tables, sql, migrationName) {
  const statements = [];
  const createPattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(/gi;
  let match;
  while ((match = createPattern.exec(sql)) !== null) {
    const start = match.index + match[0].length;
    const end = matchingParen(sql, start);
    if (end === -1) fail(`evidence state rows: unterminated CREATE TABLE ${match[1]}`);
    statements.push({
      index: match.index,
      kind: "create",
      name: match[1],
      columns: parseColumns(sql.slice(start, end)),
    });
    createPattern.lastIndex = end;
  }
  const dropPattern = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi;
  while ((match = dropPattern.exec(sql)) !== null) {
    statements.push({ index: match.index, kind: "drop", name: match[1] });
  }
  const renamePattern =
    /ALTER\s+TABLE\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+RENAME\s+TO\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi;
  while ((match = renamePattern.exec(sql)) !== null) {
    statements.push({
      index: match.index,
      kind: "rename",
      name: match[1],
      target: match[2],
    });
  }
  statements.sort((left, right) => left.index - right.index);
  for (const statement of statements) {
    if (statement.kind === "create") {
      if (tables.has(statement.name)) {
        fail(
          `evidence state rows: ${migrationName} creates duplicate table ${statement.name}`,
        );
      }
      tables.set(statement.name, {
        name: statement.name,
        columns: statement.columns,
      });
      continue;
    }
    if (!tables.has(statement.name)) {
      fail(
        `evidence state rows: ${migrationName} ${statement.kind}s missing table ${statement.name}`,
      );
    }
    if (statement.kind === "drop") {
      tables.delete(statement.name);
      continue;
    }
    if (tables.has(statement.target)) {
      fail(
        `evidence state rows: ${migrationName} renames ${statement.name} over existing table ${statement.target}`,
      );
    }
    const table = tables.get(statement.name);
    tables.delete(statement.name);
    table.name = statement.target;
    tables.set(statement.target, table);
  }
}

function matchingParen(sql, start) {
  let depth = 1;
  let quote = null;
  for (let index = start; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseColumns(body) {
  const columns = [];
  for (const part of splitTopLevel(body)) {
    const line = part.trim();
    if (line.length === 0) continue;
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(line)) continue;
    const match = /^["`]?([a-z][a-z0-9_]*)["`]?\s+(TEXT|INTEGER|REAL|BLOB|ANY)\b([\s\S]*)$/i.exec(line);
    if (!match) fail(`evidence state rows: unsupported column definition ${line}`);
    const [, name, rawType, rest] = match;
    const notNull = /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest);
    const enumValues = parseEnum(name, rawType, rest, notNull);
    const constValue = parseConst(name, rest);
    const bounds = parseBounds(name, rest);
    columns.push({
      name,
      rawType: rawType.toUpperCase(),
      jsonType: rawType.toUpperCase() === "INTEGER" ? "integer" : "string",
      notNull,
      enumValues,
      constValue,
      minimum: bounds.minimum,
      maximum: bounds.maximum,
      pattern: parsePattern(name, rest),
      jsonText: parseJsonText(name, rest),
    });
  }
  if (columns.length === 0) fail("evidence state rows: DDL table has no columns");
  return columns;
}

function parseEnum(name, rawType, rest, notNull) {
  const match = new RegExp(
    `\\b${escapeRegExp(name)}\\s+IN\\s*\\(([^)]*)\\)`,
    "i",
  ).exec(rest);
  if (!match) return null;
  const values = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => (value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value));
  if (values.length === 0) return null;
  const typed = rawType.toUpperCase() === "INTEGER" ? values.map(Number) : values;
  if (!notNull) typed.push(null);
  return typed;
}

function parseConst(name, rest) {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(\\d+)\\b`, "i").exec(rest);
  return match === null ? null : Number(match[1]);
}

function parseBounds(name, rest) {
  const between = new RegExp(
    `\\b${escapeRegExp(name)}\\s+BETWEEN\\s+(\\d+)\\s+AND\\s+(\\d+)`,
    "i",
  ).exec(rest);
  if (between !== null) {
    return { minimum: Number(between[1]), maximum: Number(between[2]) };
  }
  const minimum = new RegExp(`\\b${escapeRegExp(name)}\\s*>=\\s*(\\d+)`, "i").exec(rest);
  return { minimum: minimum === null ? null : Number(minimum[1]), maximum: null };
}

function parsePattern(name, rest) {
  const hash = new RegExp(
    `length\\(${escapeRegExp(name)}\\)\\s*=\\s*71\\s+AND\\s+substr\\(${escapeRegExp(name)}\\s*,\\s*1\\s*,\\s*7\\)\\s*=\\s*'sha256:'`,
    "i",
  ).test(rest);
  if (hash) return "^sha256:[0-9a-f]{64}$";
  const blob = new RegExp(
    `substr\\(${escapeRegExp(name)}\\s*,\\s*1\\s*,\\s*7\\)\\s*=\\s*'blob://'`,
    "i",
  ).test(rest);
  return blob ? "^blob://" : null;
}

function parseJsonText(name, rest) {
  const match = new RegExp(
    `json_valid\\(${escapeRegExp(name)}\\)\\s+AND\\s+json_type\\(${escapeRegExp(name)}\\)\\s*=\\s*'(array|object)'`,
    "i",
  ).exec(rest);
  return match === null ? null : match[1];
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const char of body) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
