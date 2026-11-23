/**
 * Pi SDK reload evidence for the CFG compaction trial (W10).
 *
 * The adapter owns the host-specific reload channel: it asks the installed Pi
 * SDK to reload its settings and reads the resolved global settings back. The
 * factory takes every path from the caller. It never scans the user's home,
 * never falls back to `process.cwd`, and never writes a config file.
 *
 * The caller must pass a native executable from the selected approved host
 * binding plus the approved root directory and the declared layer file. The
 * bundled SDK module is derived from that executable, not discovered.
 *
 * The returned type is structural so adapters do not depend on kernel types.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Id, SourceRef } from "@evoplug/core";
import type {
  ConfigReloadResolved,
  ConfigResult,
  FieldAssignment
} from "@evoplug/core/config";
import {
  buildHostFieldRegistry,
  configError,
  fail,
  succeed
} from "@evoplug/core/config";

import { PI_COMPACTION_SPEC } from "./compaction-spec.js";
import { PI_HOST_ID } from "./manifest.js";

/** The subset of the Pi `SettingsManager` used by the reload probe. */
export interface PiSettingsManagerLike {
  getGlobalSettings(): Record<string, unknown>;
  reload(): Promise<void>;
}

/** The subset of the Pi settings module used by the reload probe. */
export interface PiSettingsModuleLike {
  readonly SettingsManager: {
    create(cwd: string, agentDir?: string): PiSettingsManagerLike;
  };
}

/**
 * Structural reload resolver accepted by the kernel probe. Kept local so the
 * adapter package imports no kernel or app module.
 */
export type PiSdkReloadResolver = (input: {
  readonly field_ids: readonly Id<"fld">[];
  readonly deadline_ms: number;
  readonly signal?: AbortSignal;
}) => Promise<ConfigResult<ConfigReloadResolved>>;

export interface PiSdkReloadResolverOptions {
  /**
   * Explicit native Pi executable from the selected, approved host binding.
   * The bundled `core/settings-manager.js` is resolved relative to it.
   */
  readonly native_executable: string;
  /** Explicit workspace used to initialize the SDK; never defaulted. */
  readonly workspace: string;
  /** Approved root directory that registered this host binding. */
  readonly agent_dir: string;
  /** Declared layer file inside `agent_dir`, for example `settings.json`. */
  readonly config_path: string;
  /** Adapter layer id whose compaction pointers are read back. */
  readonly layer_id: string;
  /** Clock seam; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Test/embedding seam. Production callers omit it so the module is loaded
   * from the explicit native executable.
   */
  readonly settings_module?: PiSettingsModuleLike;
}

interface Layer {
  readonly layer_id: string;
  readonly root_kind: "user" | "project" | "managed" | "session";
  readonly relative_path: string;
  readonly format: "json" | "jsonc" | "yaml" | "toml";
}

const MODULE_RELATIVE_PATH = join("..", "core", "settings-manager.js");
const requireFromHere = createRequire(import.meta.url);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function blobRef(bytes: Uint8Array): SourceRef {
  const length = bytes.byteLength === 0 ? 1 : bytes.byteLength;
  return `blob://sha256:${sha256Hex(bytes)}#bytes=0-${length}` as SourceRef;
}

function pointerParts(pointer: string): readonly string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readPointer(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const part of pointerParts(pointer)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function scalarKey(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "boolean") return `b:${String(value)}`;
  if (typeof value === "number") return `n:${String(value)}`;
  if (typeof value === "string") return `s:${value}`;
  return `other:${typeof value}`;
}

function assignmentValue(value: unknown): FieldAssignment["value"] {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return { presence: "present", value };
  }
  return { presence: "absent" };
}

function layerFor(layerId: string): Layer | null {
  const layer = PI_COMPACTION_SPEC.layers.find((candidate) => candidate.layer_id === layerId);
  if (layer === undefined) return null;
  return {
    layer_id: layer.layer_id,
    root_kind: layer.root_kind,
    relative_path: layer.relative_path,
    format: layer.format
  };
}

function absoluteFile(path: string): string | null {
  if (!isAbsolute(path) || !existsSync(path)) return null;
  try {
    if (!statSync(path).isFile()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function absoluteDirectory(path: string): string | null {
  if (!isAbsolute(path) || !existsSync(path)) return null;
  try {
    if (!statSync(path).isDirectory()) return null;
    return resolve(path);
  } catch {
    return null;
  }
}

function loadSettingsModule(
  executable: string,
  injected: PiSettingsModuleLike | undefined
): PiSettingsModuleLike | null {
  if (injected !== undefined) return injected;
  const modulePath = resolve(dirname(executable), MODULE_RELATIVE_PATH);
  if (!existsSync(modulePath)) return null;
  try {
    const loaded: unknown = requireFromHere(modulePath);
    return loaded as PiSettingsModuleLike;
  } catch {
    return null;
  }
}

/**
 * Builds the real Pi SDK reload resolver.
 *
 * The SDK manager is created once, before a trial can write, so its cached
 * baseline is the pre-trial resolved state. `reload()` then must re-read the
 * declared file. `baseline_explainable` is true only when every requested
 * field still equals that pre-trial baseline, which correctly withholds
 * effect evidence when the reload changed nothing.
 */
export function createPiSdkReloadResolver(
  options: PiSdkReloadResolverOptions
): ConfigResult<PiSdkReloadResolver> {
  const layer = layerFor(options.layer_id);
  if (layer === null) {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        details: [{ key: "dimension", value: "reload_layer" }]
      })
    );
  }
  const executable = absoluteFile(options.native_executable);
  if (executable === null) {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        details: [{ key: "dimension", value: "native_executable" }]
      })
    );
  }
  const workspace = absoluteDirectory(options.workspace);
  if (workspace === null) {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        details: [{ key: "dimension", value: "workspace" }]
      })
    );
  }
  const agentDir = absoluteDirectory(options.agent_dir);
  if (agentDir === null) {
    return fail(
      configError("E_CFG_AUTHORIZATION_SCOPE", {
        details: [{ key: "dimension", value: "approved_root" }]
      })
    );
  }
  if (!isAbsolute(options.config_path) || resolve(options.config_path) !== resolve(agentDir, layer.relative_path)) {
    return fail(
      configError("E_CFG_AUTHORIZATION_SCOPE", {
        details: [{ key: "dimension", value: "config_path" }]
      })
    );
  }
  const configPath = resolve(options.config_path);

  const module = loadSettingsModule(executable, options.settings_module);
  if (module === null || typeof module.SettingsManager.create !== "function") {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        details: [{ key: "dimension", value: "reload_module" }]
      })
    );
  }
  let manager: PiSettingsManagerLike;
  let baseline: Record<string, unknown>;
  try {
    manager = module.SettingsManager.create(workspace, agentDir);
    baseline = structuredClone(manager.getGlobalSettings());
  } catch {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        details: [{ key: "dimension", value: "reload_module" }]
      })
    );
  }

  const now = options.now ?? (() => Date.now());
  const registry = buildHostFieldRegistry(PI_HOST_ID, now());
  if (!registry.ok) {
    return registry;
  }
  const fieldPaths = PI_COMPACTION_SPEC.field_paths.filter((path) => path.layer_id === layer.layer_id);

  const resolver: PiSdkReloadResolver = async (input) => {
    if (input.signal?.aborted === true) {
      return fail(
        configError("E_CFG_APPLY_UNCONFIRMED", {
          details: [{ key: "stage", value: "reload_aborted" }]
        })
      );
    }
    try {
      await manager.reload();
    } catch {
      return fail(
        configError("E_CFG_APPLY_UNCONFIRMED", {
          details: [{ key: "stage", value: "reload_failed" }]
        })
      );
    }
    let settings: Record<string, unknown>;
    let bytes: Uint8Array;
    try {
      settings = manager.getGlobalSettings();
      bytes = new Uint8Array(readFileSync(configPath));
    } catch {
      return fail(
        configError("E_CFG_APPLY_UNCONFIRMED", {
          details: [{ key: "stage", value: "reload_read_failed" }]
        })
      );
    }

    const assignments: FieldAssignment[] = [];
    let baselineExplainable = true;
    for (const fieldId of input.field_ids) {
      const spec = registry.value.field_specs.find((candidate) => candidate.field_id === fieldId);
      if (spec === undefined) {
        return fail(configError("E_CFG_FIELD_UNKNOWN", { field_id: fieldId }));
      }
      const declared = fieldPaths.find((path) => path.field_key === spec.field_key);
      if (declared === undefined) {
        return fail(
          configError("E_CFG_FIELD_NOT_EXECUTABLE", {
            field_id: fieldId,
            details: [{ key: "reload_mapping", value: "missing" }]
          })
        );
      }
      const resolvedValue = readPointer(settings, declared.pointer);
      if (scalarKey(readPointer(baseline, declared.pointer)) !== scalarKey(resolvedValue)) {
        baselineExplainable = false;
      }
      assignments.push({
        field_id: fieldId,
        path: {
          kind: "file",
          format: layer.format,
          root: layer.root_kind,
          relative_path: layer.relative_path,
          pointer: declared.pointer,
          create: false
        },
        value: assignmentValue(resolvedValue)
      });
    }
    return succeed({
      assignments,
      evidence_ref: blobRef(bytes),
      baseline_explainable: baselineExplainable,
      repeat_count: 1,
      observed_at: now()
    });
  };
  return succeed(resolver);
}
