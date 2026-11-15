/**
 * Adapter-local twin of the kernel's `rsi.cli_output_extract/1` and
 * `rsi.cli_output_normalization/1` contract.
 *
 * The legacy OpenCode `cli_spawn` adapter and the packaged generic adapter both
 * consume `opencode run --format json`, whose assistant text is wrapped in a
 * `{type:"text", part:{type:"text", text}}` event. Adapters may not import
 * `@evoplug/kernel`, so this module carries the same declarative extraction
 * algorithm and the single OpenCode declaration used by both paths.
 */

export type OpenCodeOutputScalar = string | number | boolean;

export interface OpenCodeOutputSelector {
  readonly path: string;
  readonly equals: OpenCodeOutputScalar;
}

export interface OpenCodeOutputExtraction {
  readonly schema_version: "rsi.cli_output_extract/1";
  readonly select?: readonly OpenCodeOutputSelector[];
  readonly text_paths: readonly string[];
  readonly combine?: "first" | "last" | "concat";
}

export interface OpenCodeOutputNormalization {
  readonly schema_version: "rsi.cli_output_normalization/1";
  readonly final_newline?: "preserve" | "ensure";
}

/** Single source for both the packaged spec and the legacy adapter. */
export const OPENCODE_OUTPUT_EXTRACT: OpenCodeOutputExtraction = Object.freeze({
  schema_version: "rsi.cli_output_extract/1" as const,
  select: Object.freeze([
    Object.freeze({ path: "type", equals: "text" as const }),
    Object.freeze({ path: "part.type", equals: "text" as const })
  ]),
  text_paths: Object.freeze(["part.text"]),
  combine: "last" as const
});

export const OPENCODE_OUTPUT_NORMALIZATION: OpenCodeOutputNormalization = Object.freeze({
  schema_version: "rsi.cli_output_normalization/1" as const,
  final_newline: "ensure" as const
});

export type OutputExtractionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "jsonl_line_not_json" | "output_extract_no_match" };

/** Resolves one dot path; `*` maps arrays and object values. */
function pathValues(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const item of current) {
      if (segment === "*") {
        if (Array.isArray(item)) next.push(...item);
        else if (typeof item === "object" && item !== null) {
          next.push(...Object.values(item as Readonly<Record<string, unknown>>));
        }
        continue;
      }
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const found = (item as Readonly<Record<string, unknown>>)[segment];
      if (found !== undefined) next.push(found);
    }
    current = next;
  }
  return current;
}

/** Applies the declared extraction to one complete `jsonl` stdout buffer. */
export function extractJsonlText(
  chunk: string,
  extract: OpenCodeOutputExtraction
): OutputExtractionResult {
  const selected: string[] = [];
  const selectors = extract.select ?? [];
  for (const line of chunk.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return { ok: false, reason: "jsonl_line_not_json" };
    }
    const matched = selectors.every((selector) =>
      pathValues(event, selector.path).some((value) => value === selector.equals)
    );
    if (!matched) continue;
    const parts: string[] = [];
    for (const path of extract.text_paths) {
      for (const value of pathValues(event, path)) {
        if (typeof value === "string") parts.push(value);
      }
    }
    const text = parts.join("");
    if (text.length > 0) selected.push(text);
  }
  if (selected.length === 0) return { ok: false, reason: "output_extract_no_match" };
  const combine = extract.combine ?? "last";
  if (combine === "first") return { ok: true, text: selected[0] as string };
  if (combine === "concat") return { ok: true, text: selected.join("") };
  return { ok: true, text: selected[selected.length - 1] as string };
}

/** Applies the declared final-newline policy. */
export function normalizeFinalNewline(
  text: string,
  normalization: OpenCodeOutputNormalization | undefined
): string {
  if (normalization?.final_newline === "ensure" && !text.endsWith("\n")) return `${text}\n`;
  return text;
}
