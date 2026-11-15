// Shared helpers for tools/schema-codegen. Node standard library only.

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const SCHEMA_ROOT = path.join(REPO_ROOT, "schemas");
export const GENERATED_ROOT = path.join(REPO_ROOT, "packages/core/src/generated");

export async function listFiles(root, predicate) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await visit(full);
      } else if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  }
  await visit(root);
  return out;
}

export async function readJson(file) {
  const text = await readFile(file, "utf8");
  return JSON.parse(text);
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text) {
  return sha256Hex(Buffer.from(text, "utf8"));
}

export function contentHash(text) {
  return `sha256:${sha256Text(text)}`;
}

export function kebab(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

export function pascal(value) {
  return value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedJson(value[key]);
    return out;
  }
  return value;
}

export function jsonText(value) {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  await writeFile(file, text, "utf8");
}

export async function removeFile(file) {
  if (existsSync(file)) await rm(file);
}

export function lineCount(text) {
  return text.split("\n").length;
}

export function fail(message) {
  const error = new Error(message);
  error.codegen = true;
  throw error;
}
