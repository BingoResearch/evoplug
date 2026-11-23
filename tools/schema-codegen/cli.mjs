#!/usr/bin/env node
// evoplug schema code generator.
//
//   node tools/schema-codegen/cli.mjs --write
//   node tools/schema-codegen/cli.mjs --check
//   node tools/schema-codegen/cli.mjs --check-ddl
//
// The tool is deliberately bootstrap-safe: it imports only Node's standard
// library and the installed Ajv 8.20.0, never workspace dist output or the
// generated tree it produces.

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  GENERATED_ROOT,
  SCHEMA_ROOT,
  REPO_ROOT,
  readJson,
  writeText,
  removeFile,
  jsonText,
  fail,
} from "./lib/utils.mjs";
import { loadSchemas } from "./lib/schemas.mjs";
import { generateTypesModule } from "./lib/types-gen.mjs";
import { generateValidatorModule } from "./lib/validators-gen.mjs";
import { generateIdsModule, normalizedRegistry } from "./lib/ids-gen.mjs";
import { generateHostVocabularyModule } from "./lib/host-vocab-gen.mjs";
import { generateStateRowModules } from "./lib/state-row-gen.mjs";
import { buildEvidenceStateRowArtifacts } from "./lib/evidence-state-rows-gen.mjs";
import { checkDdl } from "./lib/ddl-check.mjs";

const USAGE = `usage: node tools/schema-codegen/cli.mjs <--write|--check|--check-ddl>

  --write       regenerate packages/core/src/generated and schemas/generated
  --check       compare generated output with the working tree (no writes)
  --check-ddl   compare schema enum inventories with migrations/**/*.sql
`;

async function main(argv) {
  const modes = argv.filter((arg) => ["--write", "--check", "--check-ddl"].includes(arg));
  if (modes.length !== 1 || argv.length !== modes.length) {
    process.stderr.write(USAGE);
    return 2;
  }
  const mode = modes[0];
  const schemas = await loadSchemas();
  await validateAuxiliarySources(schemas);

  if (mode === "--check-ddl") {
    const report = await checkDdl({ repoRoot: REPO_ROOT, schemas });
    if (report.note) process.stdout.write(`${report.note}\n`);
    if (report.problems.length > 0) {
      for (const problem of report.problems) process.stderr.write(`schema:check:ddl: ${problem}\n`);
      return 1;
    }
    process.stdout.write(`schema:check:ddl: ${report.checked} enum(s) verified\n`);
    return 0;
  }

  const outputs = await buildOutputs(schemas);

  if (mode === "--write") {
    const changed = [];
    for (const [relative, text] of outputs.text) {
      const absolute = path.join(REPO_ROOT, relative);
      let current = null;
      try {
        current = await readFile(absolute, "utf8");
      } catch {
        current = null;
      }
      if (current !== text) {
        await writeText(absolute, text);
        changed.push(relative);
      }
    }
    const removed = await removeStale(outputs);
    const summary = [
      `schema:generate: ${outputs.text.size} file(s), ${changed.length} written, ${removed.length} removed`,
      ...changed.map((file) => `  wrote ${file}`),
      ...removed.map((file) => `  removed ${file}`),
    ];
    process.stdout.write(`${summary.join("\n")}\n`);
    return 0;
  }

  const problems = [];
  for (const [relative, text] of outputs.text) {
    const absolute = path.join(REPO_ROOT, relative);
    let current = null;
    try {
      current = await readFile(absolute, "utf8");
    } catch {
      problems.push(`missing ${relative}`);
      continue;
    }
    if (current !== text) problems.push(`drift ${relative}`);
  }
  for (const absolute of await listStale(outputs)) {
    problems.push(`stale ${path.relative(REPO_ROOT, absolute).split(path.sep).join("/")}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`schema:check: ${problem}\n`);
    if (problems.some((problem) => problem.startsWith("missing "))) {
      process.stderr.write("schema:check: generated output is missing; run `pnpm bootstrap`\n");
    } else {
      process.stderr.write("schema:check: generated output is stale; run `pnpm bootstrap` after intentional schema changes\n");
    }
    return 1;
  }
  process.stdout.write(`schema:check: ${outputs.text.size} file(s) up to date\n`);
  return 0;
}

async function buildOutputs(schemas) {
  const text = new Map();
  const typeModules = [];
  const validatorModules = [];
  for (const entry of schemas) {
    const objectFile = entry.objectName.replace(/_/g, "-");
    const types = generateTypesModule(entry);
    const validatorName = `validate${toPascal(entry.objectName)}`;
    const validators = generateValidatorModule(entry, validatorName);
    text.set(`packages/core/src/generated/types/${objectFile}.ts`, types);
    text.set(`packages/core/src/generated/validators/${objectFile}.ts`, validators);
    typeModules.push([objectFile, entry.schema.title]);
    validatorModules.push([objectFile, validatorName]);
  }

  text.set(
    "packages/core/src/generated/types/index.ts",
    generatedHeader("generated/types/index.ts") +
      typeModules
        .map(([file]) => `export * as ${namespaceFor(file)} from "./${file}.js";`)
        .join("\n") +
      "\n",
  );
  text.set(
    "packages/core/src/generated/validators/index.ts",
    generatedHeader("generated/validators/index.ts") +
      validatorModules.map(([file]) => `export * from "./${file}.js";`).join("\n") +
      "\n",
  );

  const registryPath = path.join(SCHEMA_ROOT, "common/id-prefix-registry.json");
  const registry = await readJson(registryPath);
  text.set("packages/core/src/generated/ids.ts", generateIdsModule(registry));
  text.set(
    "schemas/generated/id-prefix-registry.json",
    jsonText(normalizedRegistry(registry)),
  );

  const hostEntry = await findHostVocabularyEntry(schemas);
  text.set(
    "packages/core/src/generated/host-vocabulary.ts",
    generateHostVocabularyModule(hostEntry),
  );

  const stateRowPath = path.join(SCHEMA_ROOT, "ledger/state-row-registry.json");
  if (existsSync(stateRowPath)) {
    const stateRows = await readJson(stateRowPath);
    for (const row of stateRows.rows ?? []) {
      if (typeof row.schema_artifact === "string" && !existsSync(path.join(REPO_ROOT, row.schema_artifact))) {
        fail(`state-row-registry: missing schema artifact ${row.schema_artifact}`);
      }
    }
    const generated = generateStateRowModules(stateRows);
    text.set("packages/core/src/generated/state-row-types.ts", generated.typesModule);
    text.set("packages/core/src/generated/state-row-keys.ts", generated.keysModule);
    text.set(
      "packages/core/src/generated/state-row-registry.generated.json",
      jsonText(generated.generatedRegistry),
    );
  }

  text.set(
    "packages/core/src/generated/index.ts",
    [
      generatedHeader("generated/index.ts"),
      'export * from "./types/index.js";',
      'export * from "./validators/index.js";',
      'export * from "./ids.js";',
      'export * from "./host-vocabulary.js";',
      'export * from "./state-row-types.js";',
      'export * from "./state-row-keys.js";',
      "",
    ].join("\n"),
  );

  // Evidence physical-row artifacts are generated from the frozen migration
  // DDL and the evidence registry. They are not wire schemas, so they are not
  // part of loadSchemas(); they are still checked into the tree and compared
  // by --check like every other generated file.
  const evidenceArtifacts = await buildEvidenceStateRowArtifacts({ repoRoot: REPO_ROOT });
  for (const [relative, contents] of evidenceArtifacts) {
    if (text.has(relative)) fail(`${relative}: duplicate generated output`);
    text.set(relative, contents);
  }

  for (const [relative, contents] of text) {
    if (!contents.endsWith("\n")) fail(`${relative}: generated file must end with a newline`);
  }
  return { text, schemas };
}

async function validateAuxiliarySources(schemas) {
  const methodsPath = path.join(SCHEMA_ROOT, "ipc/methods.json");
  if (existsSync(methodsPath)) {
    const registry = await readJson(methodsPath);
    if (registry.schema_version !== "rsi.ipc_methods/1") {
      fail("schemas/ipc/methods.json: schema_version must be rsi.ipc_methods/1");
    }
    const registered = new Set((registry.methods ?? []).map((entry) => entry.method));
    const request = schemas.find((entry) => entry.objectName === "ipc_request");
    const closed = request?.schema.$defs?.IpcMethod?.enum;
    if (!Array.isArray(closed)) fail("schemas/ipc/request.schema.json: $defs/IpcMethod.enum missing");
    const declared = new Set(closed);
    for (const method of declared) {
      if (!registered.has(method)) fail(`schemas/ipc/methods.json: missing method ${method}`);
    }
    for (const method of registered) {
      if (!declared.has(method)) fail(`schemas/ipc/request.schema.json: unregistered method ${method}`);
    }
  }
}

async function findHostVocabularyEntry(schemas) {
  const preferred = schemas.find(
    (entry) =>
      entry.relative === "schemas/host/host-primitives.schema.json" ||
      entry.relative === "schemas/host/primitive.schema.json" ||
      entry.relative === "schemas/common/host-vocabulary.schema.json",
  );
  if (preferred) return preferred;
  const fallback = schemas.find((entry) => entry.schema["x-evoplug-vocabulary"] !== undefined);
  if (!fallback) {
    fail(
      "host vocabulary source missing: expected schemas/host/host-primitives.schema.json, " +
        "schemas/host/primitive.schema.json or schemas/common/host-vocabulary.schema.json",
    );
  }
  return fallback;
}

async function listStale(outputs) {
  const stale = [];
  for (const dir of ["types", "validators"]) {
    const absolute = path.join(GENERATED_ROOT, dir);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const relative = `packages/core/src/generated/${dir}/${entry.name}`;
      if (!outputs.text.has(relative)) stale.push(path.join(REPO_ROOT, relative));
    }
  }
  const artifactDir = path.join(SCHEMA_ROOT, "domains/evidence/state-rows");
  let artifacts;
  try {
    artifacts = await readdir(artifactDir, { withFileTypes: true });
  } catch {
    artifacts = [];
  }
  for (const entry of artifacts.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const relative = `schemas/domains/evidence/state-rows/${entry.name}`;
    if (!outputs.text.has(relative)) stale.push(path.join(REPO_ROOT, relative));
  }
  return stale;
}

async function removeStale(outputs) {
  const removed = [];
  for (const absolute of await listStale(outputs)) {
    await removeFile(absolute);
    removed.push(path.relative(REPO_ROOT, absolute).split(path.sep).join("/"));
  }
  return removed;
}

function generatedHeader(relative) {
  return [
    "// DO NOT EDIT. Generated by tools/schema-codegen/cli.mjs.",
    `// Output: ${relative}`,
    "",
    "/* eslint-disable */",
    "",
  ].join("\n");
}

function namespaceFor(file) {
  return file.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function toPascal(value) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error && error.codegen) {
      process.stderr.write(`schema-codegen: ${error.message}\n`);
    } else {
      process.stderr.write(`schema-codegen: unexpected failure\n${error?.stack ?? String(error)}\n`);
    }
    process.exitCode = 1;
  });
