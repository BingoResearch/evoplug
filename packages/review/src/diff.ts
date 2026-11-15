/**
 * Diff application used by static check S3b (DD-REV-050, DD-REV-060).
 *
 * Unified diffs are applied strictly: every context and deletion line must
 * match the declared base bytes exactly. JSON merge patch follows RFC 7386.
 * `managed_block_patch` is applied as a unified diff over the extracted block;
 * the design does not define a second patch grammar.
 */

import type { JsonValue } from "@evoplug/core";

export type DiffResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export type DiffApplyError = "format" | "apply_failed" | "hunk_range";

interface HunkLine {
  kind: " " | "-" | "+";
  text: string;
  noNewline: boolean;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

function parseHunkHeader(line: string): Hunk | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) {
    return null;
  }
  const oldStart = Number.parseInt(match[1] ?? "0", 10);
  const oldCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newStart = Number.parseInt(match[3] ?? "0", 10);
  const newCount = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
  return { oldStart, oldCount, newStart, newCount, lines: [] };
}

function parseUnifiedDiff(patch: string): DiffResult<Hunk[], DiffApplyError> {
  const rawLines = patch.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      if (hunk === null) {
        return err("format");
      }
      hunks.push(hunk);
      current = hunk;
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line === "\\ No newline at end of file") {
      const previous = current.lines[current.lines.length - 1];
      if (previous !== undefined) {
        previous.noNewline = true;
      }
      continue;
    }
    if (line.length === 0) {
      return err("format");
    }
    const marker = line[0];
    if (marker !== " " && marker !== "-" && marker !== "+") {
      return err("format");
    }
    current.lines.push({ kind: marker, text: line.slice(1), noNewline: false });
  }
  if (hunks.length === 0) {
    return err("format");
  }
  return ok(hunks);
}

/**
 * Applies a unified diff. The base is split on LF; `noNewline` markers are
 * respected for the final line.
 */
export function applyUnifiedDiff(base: string, patch: string): DiffResult<string, DiffApplyError> {
  const parsed = parseUnifiedDiff(patch);
  if (!parsed.ok) {
    return err(parsed.error);
  }
  const baseHasNewline = base.endsWith("\n") || base.length === 0;
  const baseLines = base.length === 0 ? [] : base.replace(/\n$/, "").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let finalNewline = baseHasNewline;

  for (const hunk of parsed.value) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < cursor || hunkStart > baseLines.length) {
      return err("hunk_range");
    }
    while (cursor < hunkStart) {
      output.push(baseLines[cursor] ?? "");
      cursor += 1;
    }
    let oldSeen = 0;
    for (const line of hunk.lines) {
      if (line.kind === " " || line.kind === "-") {
        if (baseLines[cursor] !== line.text) {
          return err("apply_failed");
        }
        cursor += 1;
        oldSeen += 1;
      }
      if (line.kind === " " || line.kind === "+") {
        output.push(line.text);
      }
      if (line.noNewline) {
        finalNewline = false;
      }
    }
    if (hunk.oldCount !== oldSeen) {
      return err("hunk_range");
    }
  }
  while (cursor < baseLines.length) {
    output.push(baseLines[cursor] ?? "");
    cursor += 1;
  }
  const text = output.join("\n");
  return ok(finalNewline && text.length > 0 ? `${text}\n` : text);
}

/** RFC 7386 JSON merge patch. */
export function applyJsonMergePatch(target: JsonValue, patch: JsonValue): JsonValue {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return patch;
  }
  const base: { [key: string]: JsonValue } =
    typeof target === "object" && target !== null && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
    } else {
      base[key] = applyJsonMergePatch(base[key] ?? null, value);
    }
  }
  return base;
}

/** `managed_block_patch` uses the same unified-diff grammar over block text. */
export function applyManagedBlockPatch(baseBlock: string, patch: string): DiffResult<string, DiffApplyError> {
  return applyUnifiedDiff(baseBlock, patch);
}

export function applyDiff(
  format: "unified_diff" | "managed_block_patch" | "json_merge_patch",
  base: string,
  patch: string
): DiffResult<string, DiffApplyError> {
  switch (format) {
    case "unified_diff":
    case "managed_block_patch":
      return applyUnifiedDiff(base, patch);
    case "json_merge_patch": {
      try {
        const target: JsonValue = JSON.parse(base);
        const body: JsonValue = JSON.parse(patch);
        return ok(JSON.stringify(applyJsonMergePatch(target, body)));
      } catch {
        return err("format");
      }
    }
  }
}
