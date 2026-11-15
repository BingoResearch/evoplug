/**
 * CFG's `ConfigPatchApplyPort` implementation (DD-CFG-053, DD-CFG-054).
 *
 * The port is injected into FND by the kernel composition root. It is a pure
 * byte/syntax-tree transform: no file, network, clock, grant or second lock.
 * The physical root is bound per port instance because `ConfigWritePatch`
 * carries only a relative `target_path`.
 */

import type { ConfigPatchApplyPort, ConfigPatchApplyResult } from "../ports/config-write.js";
import type { ConfigPatchApplyInput } from "../ports/config-write.js";
import { applyConfigPatch, type ApplyOptions } from "./patch.js";
import type { DocumentFormat } from "./semantic-tree.js";
import { formatForPath, parseDocument, serializeDocument } from "./semantic-tree.js";
import { treeEquals } from "./semantic-tree.js";
import type { ConfigResult } from "./types.js";
import type { SemanticTree } from "./hash.js";
import { configError, fail, succeed } from "./errors.js";

export interface ConfigPatchApplyPortOptions extends ApplyOptions {
  /** Optional decoder registry id reported for diagnostics. */
  decoder_id?: string;
}

/** Builds the apply port bound to one physical file root. */
export function createConfigPatchApplyPort(options: ConfigPatchApplyPortOptions): ConfigPatchApplyPort {
  const bound: ApplyOptions = options.format === undefined
    ? { root: options.root }
    : { root: options.root, format: options.format };
  return {
    apply(input: ConfigPatchApplyInput): Promise<ConfigPatchApplyResult> {
      return applyConfigPatch(input, bound);
    }
  };
}

/** Parses bytes for a relative path, used by config-space capture. */
export function parseConfigDocument(
  relativePath: string,
  bytes: Uint8Array
): ConfigResult<{ tree: SemanticTree; format: DocumentFormat; parser_id: string; parser_version: string }> {
  const format = formatForPath(relativePath);
  if (format === null) {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { path: relativePath }));
  }
  const parsed = parseDocument(bytes, format);
  if (!parsed.ok) {
    return fail(parsed.error);
  }
  return succeed({
    tree: parsed.value.tree,
    format,
    parser_id: parsed.value.parser_id,
    parser_version: parsed.value.parser_version
  });
}

/** Round-trips a document to prove unknown-node preservation (DD-CFG-045). */
export function documentRoundTrips(relativePath: string, bytes: Uint8Array): boolean {
  const format = formatForPath(relativePath);
  if (format === null) {
    return false;
  }
  const parsed = parseDocument(bytes, format);
  if (!parsed.ok) {
    return false;
  }
  const serialized = serializeDocument(parsed.value.tree, format);
  if (!serialized.ok) {
    return false;
  }
  const reparsed = parseDocument(serialized.value, format);
  if (!reparsed.ok) {
    return false;
  }
  return treeEquals(parsed.value.tree, reparsed.value.tree);
}
