// --check-ddl compares the enum inventory of JSON Schemas with the CHECK
// constraints of the SQLite migrations. JSON Schema is the wire boundary and
// DDL is the physical constraint; neither is generated from the other
// (DD-FND-036). Schemas opt in with x-evoplug-ddl:
//   { "table": "budget_reservation", "enums": { "state": ["reserved", ...] } }

import path from "node:path";
import { listFiles, readJson, fail } from "./utils.mjs";

export async function checkDdl({ repoRoot, schemas }) {
  const migrationFiles = await listFiles(
    path.join(repoRoot, "migrations"),
    (file) => file.endsWith(".sql"),
  );
  const problems = [];
  if (migrationFiles.length === 0) {
    return {
      checked: 0,
      problems,
      note: "no migrations/**/*.sql present yet; DDL enum comparison skipped",
    };
  }
  const ddl = await readAllSql(migrationFiles);
  let checked = 0;
  for (const entry of schemas) {
    const metadata = entry.schema["x-evoplug-ddl"];
    if (!metadata) continue;
    if (typeof metadata.table !== "string") {
      problems.push(`${entry.relative}: x-evoplug-ddl.table must be a string`);
      continue;
    }
    const table = findCreateTable(ddl.text, metadata.table);
    if (table === null) {
      problems.push(`${entry.relative}: table ${metadata.table} not found in migrations`);
      continue;
    }
    for (const [column, expected] of Object.entries(metadata.enums ?? {})) {
      if (!table.columns.includes(column)) {
        problems.push(`${entry.relative}: column ${metadata.table}.${column} missing from DDL`);
        continue;
      }
      const actual = table.enums.get(column);
      if (actual === undefined) {
        problems.push(`${entry.relative}: DDL column ${metadata.table}.${column} has no CHECK enum`);
        continue;
      }
      const expectedSorted = [...new Set(expected)].sort();
      const actualSorted = [...new Set(actual)].sort();
      if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
        problems.push(
          `${entry.relative}: enum mismatch for ${metadata.table}.${column}; schema=[${expectedSorted.join(",")}] ddl=[${actualSorted.join(",")}]`,
        );
      }
      checked += 1;
    }
  }
  return { checked, problems, note: null };
}

async function readAllSql(files) {
  const { readFile } = await import("node:fs/promises");
  const parts = [];
  for (const file of files.sort()) parts.push(await readFile(file, "utf8"));
  return { text: parts.join("\n") };
}

function findCreateTable(sql, tableName) {
  const pattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${escapeRegExp(tableName)}["\`]?\\s*\\(`, "i");
  const match = pattern.exec(sql);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  let index = start;
  let quote = null;
  while (index < sql.length && depth > 0) {
    const char = sql[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
    index += 1;
  }
  const body = sql.slice(start, index - 1);
  const columns = [];
  for (const rawLine of splitTopLevel(body)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(line)) continue;
    const column = /^["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+/.exec(line);
    if (column) columns.push(column[1]);
  }
  const enums = new Map();
  for (const line of splitTopLevel(body)) {
    const check = /([A-Za-z_][A-Za-z0-9_]*)\s+(?:IS\s+NULL\s+OR\s+)?IN\s*\(([^)]*)\)/gi;
    let match;
    while ((match = check.exec(line)) !== null) {
      const values = parseInListValues(match[2]);
      if (values.length > 0 && !enums.has(match[1])) enums.set(match[1], values);
    }
  }
  return { columns, enums };
}

/**
 * Parses the literal list of a SQLite `IN (...)` CHECK clause.
 *
 * Boolean flags are declared as `IN (0,1)` while enum columns use quoted
 * strings; both are real enum constraints, so both are compared against the
 * schema's `x-evoplug-ddl.enums` inventory.
 */
function parseInListValues(raw) {
  const values = [];
  for (const token of raw.split(",")) {
    const value = token.trim();
    if (/^'([^']|'')*'$/.test(value)) {
      values.push(value.slice(1, -1).replace(/''/g, "'"));
      continue;
    }
    if (/^-?\d+$/.test(value)) {
      values.push(Number(value));
    }
  }
  return values;
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
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
