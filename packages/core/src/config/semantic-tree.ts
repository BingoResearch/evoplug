/**
 * Format-independent semantic tree and concrete parsers/serializers used by
 * the apply port (DD-CFG-044, DD-CFG-045, DD-CFG-184).
 *
 * The tree keeps every parsed node, so unknown keys and `mcp_servers` survive
 * a structured patch. Comments are not semantic content and are not retained
 * by the semantic tree; a field whose writer cannot prove round-trip
 * preservation must stay non-active.
 */

import type { JsonValue } from "../json.js";
import type { ConfigResult } from "./types.js";
import type { SemanticTree } from "./hash.js";
import { configError, fail, succeed } from "./errors.js";

export type DocumentFormat = "json" | "jsonc" | "yaml" | "toml";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function treeFromJson(value: JsonValue): SemanticTree {
  if (value === null) {
    return { kind: "scalar", scalar_type: "null", value: null };
  }
  if (Array.isArray(value)) {
    return { kind: "array", items: value.map((item) => treeFromJson(item)) };
  }
  switch (typeof value) {
    case "string":
      return { kind: "scalar", scalar_type: "string", value };
    case "boolean":
      return { kind: "scalar", scalar_type: "boolean", value };
    case "number":
      return { kind: "scalar", scalar_type: "number", value: Object.is(value, -0) ? 0 : value };
    case "object": {
      const entries = Object.keys(value).map((key) => {
        const child = value[key];
        if (child === undefined) {
          throw new TypeError("undefined is not JSON");
        }
        return { key, value: treeFromJson(child) };
      });
      return { kind: "object", entries };
    }
  }
}

export function treeToJson(tree: SemanticTree): JsonValue {
  switch (tree.kind) {
    case "scalar":
      return tree.value;
    case "array":
      return tree.items.map((item) => treeToJson(item));
    case "object": {
      const output: { [key: string]: JsonValue } = {};
      for (const entry of tree.entries) {
        output[entry.key] = treeToJson(entry.value);
      }
      return output;
    }
  }
}

export function treeEquals(left: SemanticTree, right: SemanticTree): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "scalar":
      return right.kind === "scalar" && left.scalar_type === right.scalar_type && Object.is(left.value, right.value);
    case "array":
      return (
        right.kind === "array" &&
        left.items.length === right.items.length &&
        left.items.every((item, index) => {
          const other = right.items[index];
          return other !== undefined && treeEquals(item, other);
        })
      );
    case "object":
      return (
        right.kind === "object" &&
        left.entries.length === right.entries.length &&
        left.entries.every((entry) => {
          const other = right.entries.find((candidate) => candidate.key === entry.key);
          return other !== undefined && treeEquals(entry.value, other.value);
        })
      );
  }
}

/* ------------------------------------------------------------------ */
/* JSON pointer access                                                 */
/* ------------------------------------------------------------------ */

export function pointerSegments(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function pointerText(segments: readonly string[]): string {
  if (segments.length === 0) {
    return "";
  }
  const escaped = segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"));
  return `/${escaped.join("/")}`;
}

export function getNode(tree: SemanticTree, pointer: string): SemanticTree | undefined {
  let current: SemanticTree | undefined = tree;
  for (const segment of pointerSegments(pointer)) {
    if (current === undefined) {
      return undefined;
    }
    if (current.kind === "object") {
      current = current.entries.find((entry) => entry.key === segment)?.value;
      continue;
    }
    if (current.kind === "array") {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0) {
        return undefined;
      }
      current = current.items[index];
      continue;
    }
    return undefined;
  }
  return current;
}

/** Immutable set; missing intermediate objects are created when allowed. */
export function setNode(
  tree: SemanticTree,
  pointer: string,
  value: SemanticTree,
  create: boolean
): ConfigResult<SemanticTree> {
  if (pointer === "") {
    return succeed(value);
  }
  const segments = pointerSegments(pointer);
  const result = setAt(tree, segments, 0, value, create);
  if (result === null) {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { path: pointer, details: [{ key: "reason", value: "path_invalid" }] }));
  }
  return succeed(result);
}

function setAt(
  node: SemanticTree,
  segments: readonly string[],
  index: number,
  value: SemanticTree,
  create: boolean
): SemanticTree | null {
  const segment = segments[index];
  if (segment === undefined) {
    return value;
  }
  const last = index === segments.length - 1;
  if (node.kind === "object") {
    const entries = [...node.entries];
    const position = entries.findIndex((entry) => entry.key === segment);
    if (last) {
      const next = { key: segment, value };
      if (position >= 0) {
        entries[position] = next;
      } else {
        entries.push(next);
      }
      return { kind: "object", entries };
    }
    if (position < 0) {
      if (!create) {
        return null;
      }
      const child = setAt({ kind: "object", entries: [] }, segments, index + 1, value, create);
      if (child === null) {
        return null;
      }
      entries.push({ key: segment, value: child });
      return { kind: "object", entries };
    }
    const existing = entries[position];
    if (existing === undefined) {
      return null;
    }
    const child = setAt(existing.value, segments, index + 1, value, create);
    if (child === null) {
      return null;
    }
    entries[position] = { key: segment, value: child };
    return { kind: "object", entries };
  }
  if (node.kind === "array") {
    const position = Number(segment);
    if (!Number.isSafeInteger(position) || position < 0) {
      return null;
    }
    const items = [...node.items];
    if (last) {
      if (position > items.length) {
        return null;
      }
      items[position] = value;
      return { kind: "array", items };
    }
    const existing = items[position];
    if (existing === undefined) {
      if (!create) {
        return null;
      }
      const child = setAt({ kind: "object", entries: [] }, segments, index + 1, value, create);
      if (child === null) {
        return null;
      }
      items[position] = child;
      return { kind: "array", items };
    }
    const child = setAt(existing, segments, index + 1, value, create);
    if (child === null) {
      return null;
    }
    items[position] = child;
    return { kind: "array", items };
  }
  return null;
}

/** Immutable remove; removing an absent node returns `not_found`. */
export function removeNode(
  tree: SemanticTree,
  pointer: string
): ConfigResult<SemanticTree> {
  if (pointer === "") {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { path: pointer }));
  }
  const result = removeAt(tree, pointerSegments(pointer), 0);
  if (result === null) {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { path: pointer }));
  }
  return succeed(result);
}

function removeAt(node: SemanticTree, segments: readonly string[], index: number): SemanticTree | null {
  const segment = segments[index];
  if (segment === undefined) {
    return null;
  }
  const last = index === segments.length - 1;
  if (node.kind === "object") {
    const position = node.entries.findIndex((entry) => entry.key === segment);
    const entries = [...node.entries];
    if (last) {
      if (position < 0) {
        return null;
      }
      entries.splice(position, 1);
      return { kind: "object", entries };
    }
    const existing = entries[position];
    if (existing === undefined) {
      return null;
    }
    const child = removeAt(existing.value, segments, index + 1);
    if (child === null) {
      return null;
    }
    entries[position] = { key: segment, value: child };
    return { kind: "object", entries };
  }
  if (node.kind === "array") {
    const position = Number(segment);
    if (!Number.isSafeInteger(position) || position < 0) {
      return null;
    }
    const items = [...node.items];
    if (last) {
      if (position >= items.length) {
        return null;
      }
      items.splice(position, 1);
      return { kind: "array", items };
    }
    const existing = items[position];
    if (existing === undefined) {
      return null;
    }
    const child = removeAt(existing, segments, index + 1);
    if (child === null) {
      return null;
    }
    items[position] = child;
    return { kind: "array", items };
  }
  return null;
}

export function scalarNode(value: string | number | boolean | null): SemanticTree {
  if (value === null) {
    return { kind: "scalar", scalar_type: "null", value: null };
  }
  if (typeof value === "string") {
    return { kind: "scalar", scalar_type: "string", value };
  }
  if (typeof value === "boolean") {
    return { kind: "scalar", scalar_type: "boolean", value };
  }
  return { kind: "scalar", scalar_type: "number", value: Object.is(value, -0) ? 0 : value };
}

/* ------------------------------------------------------------------ */
/* Concrete syntax                                                     */
/* ------------------------------------------------------------------ */

export function formatForPath(relativePath: string): DocumentFormat | null {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".jsonc")) {
    return "jsonc";
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "yaml";
  }
  if (lower.endsWith(".toml")) {
    return "toml";
  }
  return null;
}

export interface ParsedDocument {
  tree: SemanticTree;
  parser_id: string;
  parser_version: string;
}

export function parseDocument(bytes: Uint8Array, format: DocumentFormat): ConfigResult<ParsedDocument> {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return fail(configError("E_CFG_PROTECTED_SUBTREE", { details: [{ key: "parser", value: "not_utf8" }] }));
  }
  try {
    switch (format) {
      case "json":
        return succeed({ tree: treeFromJson(parseJson(text)), parser_id: "json_parse_v1", parser_version: "1" });
      case "jsonc":
        return succeed({ tree: treeFromJson(parseJson(stripJsonc(text))), parser_id: "jsonc_parse_v1", parser_version: "1" });
      case "yaml": {
        const value = parseYaml(text);
        return succeed({ tree: value, parser_id: "yaml_parse_v1", parser_version: "1" });
      }
      case "toml": {
        const value = parseToml(text);
        return succeed({ tree: value, parser_id: "toml_parse_v1", parser_version: "1" });
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 64) : "parser_failed";
    return fail(configError("E_CFG_PROTECTED_SUBTREE", { details: [{ key: "parser", value: format }, { key: "reason", value: reason }] }));
  }
}

export function serializeDocument(tree: SemanticTree, format: DocumentFormat): ConfigResult<Uint8Array> {
  try {
    switch (format) {
      case "json":
      case "jsonc":
        return succeed(new TextEncoder().encode(`${JSON.stringify(treeToJson(tree), null, 2)}\n`));
      case "yaml":
        return succeed(new TextEncoder().encode(serializeYaml(tree)));
      case "toml":
        return succeed(new TextEncoder().encode(serializeToml(tree)));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 64) : "serializer_failed";
    return fail(configError("E_CFG_PROTECTED_SUBTREE", { details: [{ key: "serializer", value: format }, { key: "reason", value: reason }] }));
  }
}

function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  return assertJson(value);
}

function assertJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SyntaxError("non_finite_number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => assertJson(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(record)) {
      output[key] = assertJson(record[key]);
    }
    return output;
  }
  throw new SyntaxError("non_json_value");
}

/** Removes `//` and block comments outside strings and trailing commas. */
export function stripJsonc(text: string): string {
  let output = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

/* ------------------------------------------------------------------ */
/* Minimal YAML                                                        */
/* ------------------------------------------------------------------ */

interface YamlLine {
  indent: number;
  text: string;
  line: number;
}

function yamlLines(text: string): YamlLine[] {
  const lines: YamlLine[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? "";
    const withoutComment = stripYamlComment(raw);
    if (withoutComment.trim().length === 0 || withoutComment.trim() === "---") {
      continue;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, text: withoutComment.trim(), line: index + 1 });
  }
  return lines;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      if (index === 0 || /\s/.test(line[index - 1] ?? "")) {
        return line.slice(0, index);
      }
    }
  }
  return line;
}

export function parseYaml(text: string): SemanticTree {
  const lines = yamlLines(text);
  if (lines.length === 0) {
    return { kind: "object", entries: [] };
  }
  const [tree, consumed] = parseYamlBlock(lines, 0, lines[0]?.indent ?? 0);
  if (consumed !== lines.length) {
    throw new SyntaxError("yaml_trailing_content");
  }
  return tree;
}

function parseYamlBlock(lines: readonly YamlLine[], start: number, indent: number): [SemanticTree, number] {
  const first = lines[start];
  if (first === undefined) {
    return [{ kind: "object", entries: [] }, start];
  }
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseYamlSequence(lines, start, indent);
  }
  return parseYamlMapping(lines, start, indent);
}

function parseYamlSequence(lines: readonly YamlLine[], start: number, indent: number): [SemanticTree, number] {
  const items: SemanticTree[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) {
      break;
    }
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    if (rest.length === 0) {
      const [child, next] = parseYamlBlock(lines, index + 1, indent + 2);
      items.push(child);
      index = next;
      continue;
    }
    const separator = findYamlSeparator(rest);
    if (separator >= 0) {
      const key = unquoteYaml(rest.slice(0, separator).trim());
      const valueText = rest.slice(separator + 1).trim();
      const entries: { key: string; value: SemanticTree }[] = [];
      let cursor = index + 1;
      if (valueText.length === 0) {
        const next = lines[cursor];
        if (next !== undefined && next.indent > indent) {
          const [child, consumed] = parseYamlBlock(lines, cursor, next.indent);
          entries.push({ key, value: child });
          cursor = consumed;
        } else {
          entries.push({ key, value: { kind: "scalar", scalar_type: "null", value: null } });
        }
      } else {
        entries.push({ key, value: parseYamlScalar(valueText) });
      }
      const nextLine = lines[cursor];
      if (nextLine !== undefined && nextLine.indent > indent) {
        const [child, consumed] = parseYamlBlock(lines, cursor, nextLine.indent);
        if (child.kind === "object") {
          entries.push(...child.entries);
        }
        cursor = consumed;
      }
      items.push({ kind: "object", entries });
      index = cursor;
      continue;
    }
    items.push(parseYamlScalar(rest));
    index += 1;
  }
  return [{ kind: "array", items }, index];
}

function parseYamlMapping(lines: readonly YamlLine[], start: number, indent: number): [SemanticTree, number] {
  const entries: { key: string; value: SemanticTree }[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent !== indent || line.text.startsWith("- ")) {
      break;
    }
    const separator = findYamlSeparator(line.text);
    if (separator < 0) {
      throw new SyntaxError(`yaml_mapping_expected_line_${String(line.line)}`);
    }
    const key = unquoteYaml(line.text.slice(0, separator).trim());
    const rest = line.text.slice(separator + 1).trim();
    if (rest.length === 0) {
      const next = lines[index + 1];
      if (next !== undefined && next.indent > indent) {
        const [child, consumed] = parseYamlBlock(lines, index + 1, next.indent);
        entries.push({ key, value: child });
        index = consumed;
      } else if (next !== undefined && next.indent === indent && next.text.startsWith("- ")) {
        const [child, consumed] = parseYamlSequence(lines, index + 1, indent);
        entries.push({ key, value: child });
        index = consumed;
      } else {
        entries.push({ key, value: { kind: "scalar", scalar_type: "null", value: null } });
        index += 1;
      }
      continue;
    }
    if (rest === "|" || rest === ">") {
      const block: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const candidate = lines[cursor];
        if (candidate === undefined || candidate.indent <= indent) {
          break;
        }
        block.push(candidate.text);
        cursor += 1;
      }
      entries.push({ key, value: { kind: "scalar", scalar_type: "string", value: block.join(rest === "|" ? "\n" : " ") } });
      index = cursor;
      continue;
    }
    entries.push({ key, value: parseYamlScalar(rest) });
    index += 1;
  }
  return [{ kind: "object", entries }, index];
}

function findYamlSeparator(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
    } else if (char === ":" && !inSingle && !inDouble) {
      const next = text[index + 1];
      if (next === undefined || next === " " || next === "\t") {
        return index;
      }
    }
  }
  return -1;
}

function parseYamlScalar(text: string): SemanticTree {
  const trimmed = text.trim();
  if (trimmed === "null" || trimmed === "~") {
    return { kind: "scalar", scalar_type: "null", value: null };
  }
  if (trimmed === "true" || trimmed === "false") {
    return { kind: "scalar", scalar_type: "boolean", value: trimmed === "true" };
  }
  if (/^[+-]?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (!Number.isFinite(number)) {
      throw new SyntaxError("yaml_non_finite_number");
    }
    return { kind: "scalar", scalar_type: "number", value: number };
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    const items = inner.length === 0 ? [] : splitYamlFlow(inner).map((item) => parseYamlScalar(item));
    return { kind: "array", items };
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    const entries = inner.length === 0
      ? []
      : splitYamlFlow(inner).map((item) => {
          const separator = findYamlSeparator(item);
          if (separator < 0) {
            throw new SyntaxError("yaml_inline_mapping");
          }
          return {
            key: unquoteYaml(item.slice(0, separator).trim()),
            value: parseYamlScalar(item.slice(separator + 1))
          };
        });
    return { kind: "object", entries };
  }
  return { kind: "scalar", scalar_type: "string", value: unquoteYaml(trimmed) };
}

function splitYamlFlow(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const char of text) {
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (char === "[" || char === "{") {
        depth += 1;
      } else if (char === "]" || char === "}") {
        depth -= 1;
      } else if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}

function unquoteYaml(text: string): string {
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "string") {
      throw new SyntaxError("yaml_string");
    }
    return parsed;
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function serializeYaml(tree: SemanticTree): string {
  const lines: string[] = [];
  emitYaml(tree, 0, lines);
  return `${lines.join("\n")}\n`;
}

function emitYaml(tree: SemanticTree, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  switch (tree.kind) {
    case "scalar":
      lines.push(`${pad}${yamlScalarText(tree)}`);
      return;
    case "array":
      if (tree.items.length === 0) {
        lines.push(`${pad}[]`);
        return;
      }
      for (const item of tree.items) {
        if (item.kind === "scalar") {
          lines.push(`${pad}- ${yamlScalarText(item)}`);
        } else {
          lines.push(`${pad}-`);
          emitYaml(item, indent + 2, lines);
        }
      }
      return;
    case "object":
      if (tree.entries.length === 0) {
        lines.push(`${pad}{}`);
        return;
      }
      for (const entry of tree.entries) {
        if (entry.value.kind === "scalar") {
          lines.push(`${pad}${entry.key}: ${yamlScalarText(entry.value)}`);
        } else {
          lines.push(`${pad}${entry.key}:`);
          emitYaml(entry.value, indent + 2, lines);
        }
      }
      return;
  }
}

function yamlScalarText(tree: SemanticTree): string {
  if (tree.kind !== "scalar") {
    return "";
  }
  switch (tree.scalar_type) {
    case "null":
      return "null";
    case "boolean":
      return tree.value === true ? "true" : "false";
    case "number":
      return String(tree.value);
    case "string": {
      const text = String(tree.value);
      return /^[A-Za-z0-9_./:-]+$/.test(text) && !/^(true|false|null|~)$/.test(text)
        ? text
        : JSON.stringify(text);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Minimal TOML                                                        */
/* ------------------------------------------------------------------ */

type TomlTable = { [key: string]: unknown };

export function parseToml(text: string): SemanticTree {
  const root: TomlTable = {};
  let current: TomlTable = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const isArrayTable = line.startsWith("[[");
      const inner = isArrayTable ? line.slice(2, -2) : line.slice(1, -1);
      current = descendToml(root, inner.split(".").map((segment) => segment.trim()), isArrayTable);
      continue;
    }
    const separator = findTomlSeparator(line);
    if (separator < 0) {
      throw new SyntaxError("toml_assignment_expected");
    }
    const keyPath = line.slice(0, separator).trim().split(".").map((key) => key.trim());
    const value = parseTomlValue(line.slice(separator + 1).trim());
    setTomlKey(current, keyPath, value);
  }
  return treeFromJson(assertJson(root));
}

function stripTomlComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"" && !inLiteral) {
      inBasic = !inBasic;
    } else if (char === "'" && !inBasic) {
      inLiteral = !inLiteral;
    } else if (char === "#" && !inBasic && !inLiteral) {
      return line.slice(0, index);
    }
  }
  return line;
}

function findTomlSeparator(line: string): number {
  let inBasic = false;
  let inLiteral = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"" && !inLiteral) {
      inBasic = !inBasic;
    } else if (char === "'" && !inBasic) {
      inLiteral = !inLiteral;
    } else if (char === "=" && !inBasic && !inLiteral) {
      return index;
    }
  }
  return -1;
}

function descendToml(root: TomlTable, path: readonly string[], arrayTable: boolean): TomlTable {
  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index];
    if (key === undefined || key.length === 0) {
      throw new SyntaxError("toml_table_path");
    }
    const last = index === path.length - 1;
    if (last && arrayTable) {
      const existing = current[key];
      const table: TomlTable = {};
      if (existing === undefined) {
        current[key] = [table];
      } else if (Array.isArray(existing)) {
        existing.push(table);
      } else {
        throw new SyntaxError("toml_array_table");
      }
      current = table;
      continue;
    }
    const existing = current[key];
    if (last) {
      if (existing === undefined) {
        const table: TomlTable = {};
        current[key] = table;
        current = table;
        continue;
      }
      if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
        throw new SyntaxError("toml_table_conflict");
      }
      current = existing as TomlTable;
      continue;
    }
    if (existing === undefined) {
      const table: TomlTable = {};
      current[key] = table;
      current = table;
      continue;
    }
    if (Array.isArray(existing)) {
      const item: unknown = existing[existing.length - 1];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new SyntaxError("toml_table_conflict");
      }
      current = item as TomlTable;
      continue;
    }
    if (typeof existing !== "object" || existing === null) {
      throw new SyntaxError("toml_table_conflict");
    }
    current = existing as TomlTable;
  }
  return current;
}

function setTomlKey(target: TomlTable, keyPath: readonly string[], value: unknown): void {
  let current = target;
  for (let index = 0; index < keyPath.length; index += 1) {
    const key = keyPath[index];
    if (key === undefined || key.length === 0) {
      throw new SyntaxError("toml_key_path");
    }
    const last = index === keyPath.length - 1;
    if (last) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        throw new SyntaxError("toml_duplicate_key");
      }
      current[key] = value;
      return;
    }
    const existing = current[key];
    if (existing === undefined) {
      const table: TomlTable = {};
      current[key] = table;
      current = table;
      continue;
    }
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      throw new SyntaxError("toml_key_conflict");
    }
    current = existing as TomlTable;
  }
}

function parseTomlValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }
  if (/^[+-]?(0|[1-9][0-9_]*)(\.[0-9_]+)?([eE][+-]?[0-9_]+)?$/.test(trimmed)) {
    const number = Number(trimmed.replaceAll("_", ""));
    if (!Number.isFinite(number)) {
      throw new SyntaxError("toml_non_finite_number");
    }
    return number;
  }
  if (trimmed.startsWith("\"\"\"") && trimmed.endsWith("\"\"\"")) {
    return trimmed.slice(3, -3);
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "string") {
      throw new SyntaxError("toml_string");
    }
    return parsed;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner.length === 0 ? [] : splitYamlFlow(inner).map((item) => parseTomlValue(item));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    const table: TomlTable = {};
    if (inner.length > 0) {
      for (const part of splitYamlFlow(inner)) {
        const separator = findTomlSeparator(part);
        if (separator < 0) {
          throw new SyntaxError("toml_inline_table");
        }
        setTomlKey(table, [part.slice(0, separator).trim()], parseTomlValue(part.slice(separator + 1)));
      }
    }
    return table;
  }
  throw new SyntaxError("toml_value");
}

function serializeToml(tree: SemanticTree): string {
  if (tree.kind !== "object") {
    throw new SyntaxError("toml_root_must_be_object");
  }
  const lines: string[] = [];
  emitTomlTable(tree, [], lines);
  return `${lines.join("\n")}\n`;
}

function emitTomlTable(tree: SemanticTree, path: readonly string[], lines: string[]): void {
  if (tree.kind !== "object") {
    return;
  }
  const scalars: { key: string; value: SemanticTree }[] = [];
  const nested: { key: string; value: SemanticTree }[] = [];
  for (const entry of tree.entries) {
    if (entry.value.kind === "object") {
      nested.push({ key: entry.key, value: entry.value });
    } else {
      scalars.push({ key: entry.key, value: entry.value });
    }
  }
  if (path.length > 0) {
    lines.push(`[${path.join(".")}]`);
  }
  for (const entry of scalars) {
    lines.push(`${entry.key} = ${tomlValueText(entry.value)}`);
  }
  for (const entry of nested) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    emitTomlTable(entry.value, [...path, entry.key], lines);
  }
}

function tomlValueText(tree: SemanticTree): string {
  switch (tree.kind) {
    case "scalar":
      switch (tree.scalar_type) {
        case "null":
          throw new SyntaxError("toml_null");
        case "boolean":
          return tree.value === true ? "true" : "false";
        case "number":
          return String(tree.value);
        case "string":
          return JSON.stringify(String(tree.value));
      }
    case "array":
      return `[${tree.items.map((item) => tomlValueText(item)).join(", ")}]`;
    case "object":
      return `{ ${tree.entries.map((entry) => `${entry.key} = ${tomlValueText(entry.value)}`).join(", ")} }`;
  }
}
