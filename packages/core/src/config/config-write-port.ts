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







interface ConfigPatchApplyPortOptions extends ApplyOptions {
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

