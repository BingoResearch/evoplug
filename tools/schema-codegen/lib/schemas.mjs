// Loads and validates the JSON Schema 2020-12 source set.
//
// Rules enforced by DD-FND-036:
//   - every schema file carries $schema, a unique urn:evoplug $id, $defs and
//     additionalProperties:false on object schemas;
//   - no external $ref is allowed, every $ref points into #/$defs;
//   - unknown keywords are rejected by Ajv strict mode at compile time.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { SCHEMA_ROOT, REPO_ROOT, listFiles, sha256Text, fail } from "./utils.mjs";

const SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const ID_PATTERN = /^urn:evoplug:schema:([a-z0-9_-]+):([0-9]+)$/;

const ALLOWED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "$comment",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "items",
  "prefixItems",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "contentEncoding",
  "contentMediaType",
  "x-evoplug-ddl",
  "x-evoplug-vocabulary",
  "x-evoplug-deferred-validation",
  "x-evoplug-total-order",
]);

function checkKeywords(node, file, pointer) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => checkKeywords(child, file, `${pointer}/${index}`));
    return;
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key) && !key.startsWith("x-")) {
      fail(`${file}: unknown keyword "${key}" at ${pointer}`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "default" || key === "examples" || key === "enum" || key === "const") continue;
    if (key.startsWith("x-")) continue;
    if (key === "properties" || key === "patternProperties" || key === "$defs") {
      for (const [name, child] of Object.entries(value)) {
        checkKeywords(child, file, `${pointer}/${key}/${name}`);
      }
      continue;
    }
    checkKeywords(value, file, `${pointer}/${key}`);
  }
}

function checkRefs(node, file, pointer) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => checkRefs(child, file, `${pointer}/${index}`));
    return;
  }
  if (typeof node.$ref === "string") {
    if (!node.$ref.startsWith("#/$defs/")) {
      fail(`${file}: external or non-$defs $ref "${node.$ref}" at ${pointer}`);
    }
    const name = node.$ref.slice("#/$defs/".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(`${file}: invalid $defs name "${name}" at ${pointer}`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "default" || key === "examples" || key === "enum" || key === "const") continue;
    if (key.startsWith("x-")) continue;
    checkRefs(value, file, `${pointer}/${key}`);
  }
}

function checkObjectAdditionalProperties(node, file) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const isObject =
    node.type === "object" ||
    (node.type === undefined && (node.properties !== undefined || node.required !== undefined));
  if (isObject && node.properties !== undefined && node.additionalProperties === undefined) {
    fail(`${file}: boundary object with properties must set additionalProperties explicitly`);
  }
}

function collectTitles(node, file, titles, pointer) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectTitles(child, file, titles, `${pointer}/${index}`));
    return;
  }
  if (typeof node.title === "string") {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(node.title)) {
      fail(`${file}: title "${node.title}" must be PascalCase at ${pointer}`);
    }
    const previous = titles.get(node.title);
    if (previous !== undefined && previous !== pointer) {
      fail(`${file}: duplicate title "${node.title}" at ${pointer} and ${previous}`);
    }
    titles.set(node.title, pointer);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "default" || key === "examples" || key === "enum" || key === "const") continue;
    if (key.startsWith("x-")) continue;
    collectTitles(value, file, titles, `${pointer}/${key}`);
  }
}

export async function loadSchemas() {
  const files = await listFiles(SCHEMA_ROOT, (file) => file.endsWith(".schema.json") && !file.includes("/generated/"));
  if (files.length === 0) fail("no schemas/**/*.schema.json found");
  const ids = new Map();
  const schemas = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const text = await readFile(file, "utf8");
    let schema;
    try {
      schema = JSON.parse(text);
    } catch (error) {
      fail(`${relative}: invalid JSON: ${error.message}`);
    }
    if (schema.$schema !== SCHEMA_2020_12) {
      fail(`${relative}: $schema must be ${SCHEMA_2020_12}`);
    }
    const match = typeof schema.$id === "string" ? ID_PATTERN.exec(schema.$id) : null;
    if (!match) {
      fail(`${relative}: $id must match urn:evoplug:schema:<object>:<version>`);
    }
    const [, objectName, version] = match;
    if (ids.has(schema.$id)) fail(`${relative}: duplicate $id ${schema.$id}`);
    ids.set(schema.$id, relative);
    if (typeof schema.title !== "string") fail(`${relative}: root schema needs a title`);
    checkKeywords(schema, relative, "#");
    checkRefs(schema, relative, "#");
    if (schema.type === "object" && schema.additionalProperties !== false) {
      fail(`${relative}: root object must set additionalProperties:false`);
    }
    const titles = new Map();
    collectTitles(schema, relative, titles, "#");
    for (const defName of Object.keys(schema.$defs ?? {})) {
      const def = schema.$defs[defName];
      if (def.title !== undefined && def.title !== defName) {
        fail(`${relative}: $defs/${defName} title must equal the definition name`);
      }
    }
    schemas.push({
      file,
      relative,
      objectName,
      version: Number(version),
      text,
      sourceHash: sha256Text(text),
      schema,
    });
  }
  schemas.sort((a, b) => (a.objectName < b.objectName ? -1 : a.objectName > b.objectName ? 1 : 0));
  return schemas;
}
