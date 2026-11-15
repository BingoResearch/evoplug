/**
 * W10 packaged model-selection declarations.
 *
 * Ordinary `evolve serve` has no `--model` flag. Instead of asking the caller
 * to hand-fill a `ModelRef`, this module reads the model the host itself has
 * selected in its persisted config, using the same layer declaration the
 * compaction catalog already uses.
 *
 * Only hosts with an observed selection key are declared. A host whose model
 * is chosen by an API/extension with no readable persisted key stays blocked
 * (`E_CFG_MODEL_UNBOUND`); it is never filled from `provider_scope`.
 */

import type { ConfigResult, ModelRef } from "@evoplug/core/config";
import { configError, fail } from "@evoplug/core/config";
import {
  readHostModelSelection,
  type HostModelSelectionSpec,
  type RootRegistry
} from "@evoplug/kernel";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import type { CompactionSpecDeclaration } from "./config-composition.js";
import { PACKAGED_COMPACTION_SPECS } from "./config-persisted-composition.js";

export interface PackagedModelSelection {
  readonly spec: HostModelSelectionSpec;
  /** Layer that carries the selection; defaults to the tunable user layer. */
  readonly layer_id: string;
}

/**
 * Evidence for each entry:
 * - Pi `settings.json`: `defaultProvider` / `defaultModel`.
 * - Codex `config.toml`: `model_provider` / `model`.
 * - Step Code `config.toml`: `defaultProvider` / `defaultModel`.
 * - OpenCode `opencode.json`: top-level `model` as `provider/model`.
 * - Claude Code `settings.json`: top-level `model`; provider is Anthropic.
 *
 * oh-my-pi's `modelRoles` role name is not established here, and OpenHands has
 * no settings file for its condenser/model, so both stay undeclared.
 */
export const PACKAGED_MODEL_SELECTIONS: Readonly<Record<string, PackagedModelSelection>> =
  Object.freeze({
    pi: Object.freeze({
      layer_id: "user",
      spec: Object.freeze({
        provider_pointer: "/defaultProvider",
        model_pointer: "/defaultModel"
      })
    }),
    codex: Object.freeze({
      layer_id: "user",
      spec: Object.freeze({ provider_pointer: "/model_provider", model_pointer: "/model" })
    }),
    "step-code": Object.freeze({
      layer_id: "user",
      spec: Object.freeze({
        provider_pointer: "/defaultProvider",
        model_pointer: "/defaultModel"
      })
    }),
    opencode: Object.freeze({
      layer_id: "user",
      spec: Object.freeze({ model_pointer: "/model", combined: true })
    }),
    "claude-code": Object.freeze({
      layer_id: "user",
      spec: Object.freeze({ model_pointer: "/model", static_provider: "anthropic" })
    })
  });

function unbound(
  reason: string,
  extra: readonly [string, string | number][] = []
): ConfigResult<never> {
  return fail(
    configError("E_CFG_MODEL_UNBOUND", {
      details: [
        { key: "dimension", value: "native_model" },
        { key: "reason", value: reason },
        ...extra.map(([key, value]) => ({ key, value }))
      ]
    })
  );
}

function declarationFor(hostId: string): CompactionSpecDeclaration | null {
  return PACKAGED_COMPACTION_SPECS.find((spec) => spec.host_id === hostId) ?? null;
}

export interface ReadConfiguredHostModelInput {
  readonly host_id: string;
  /** Live approved root path for the selected layer. */
  readonly root_path: string;
  /** Defaults to the declared selection layer (`user`). */
  readonly layer_id?: string;
}

/** Reads exactly one host's persisted selection, read-only. */
export function readConfiguredHostModel(
  input: ReadConfiguredHostModelInput
): ConfigResult<ModelRef> {
  const selection = PACKAGED_MODEL_SELECTIONS[input.host_id];
  if (selection === undefined) {
    return unbound("host_selection_undeclared", [["host_id", input.host_id]]);
  }
  const declaration = declarationFor(input.host_id);
  if (declaration === null) {
    return unbound("host_declaration_missing", [["host_id", input.host_id]]);
  }
  const wanted = input.layer_id ?? selection.layer_id;
  const layer = declaration.layers.find((candidate) => candidate.layer_id === wanted);
  if (layer === undefined) {
    return unbound("selection_layer_missing", [
      ["host_id", input.host_id],
      ["layer_id", wanted]
    ]);
  }
  return readHostModelSelection({
    host_id: input.host_id,
    root_path: input.root_path,
    layer,
    spec: selection.spec
  });
}

export interface ResolveConfiguredHostModelInput {
  /**
   * Host-observed boot roots. The key is the registered root id; the value
   * carries the host identity and live path so a Pi file is never read under
   * another host's selection spec.
   */
  readonly roots: ReadonlyMap<string, { readonly host_id: string; readonly root_path: string }>;
  /** Narrows the host when several approved roots exist. */
  readonly host_id?: string;
  readonly layer_id?: string;
}

/**
 * Finds the single host root whose native selection is readable.
 *
 * This is the ordinary-serve path: no caller-supplied model. One host must
 * resolve unambiguously; multiple readable roots fail closed so two host
 * identities are never merged.
 */
export function resolveConfiguredHostModel(
  input: ResolveConfiguredHostModelInput
): ConfigResult<ModelRef> {
  const found: { host_id: string; model: ModelRef }[] = [];
  for (const root of input.roots.values()) {
    if (input.host_id !== undefined && root.host_id !== input.host_id) continue;
    if (PACKAGED_MODEL_SELECTIONS[root.host_id] === undefined) continue;
    const read = readConfiguredHostModel({
      host_id: root.host_id,
      root_path: root.root_path,
      ...(input.layer_id === undefined ? {} : { layer_id: input.layer_id })
    });
    if (read.ok) {
      found.push({ host_id: root.host_id, model: read.value });
    }
  }
  return exactlyOneModel(found, input.roots.size, input.host_id ?? "any");
}

interface ModelRootRow extends SqlRow {
  readonly root_id: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
}

export interface ResolvePersistedHostModelInput {
  /** The single kernel writer connection (read-only query here). */
  readonly connection: SqliteConnection;
  /** The approved boot registry used by the rest of the kernel. */
  readonly rootRegistry: RootRegistry;
  /** Narrows the host/space/root when several adapters are approved. */
  readonly selected?: {
    readonly host_id?: string;
    readonly config_space?: string;
    readonly root_id?: string;
  };
  readonly layer_id?: string;
}

/**
 * Ordinary-serve model resolution from persisted facts.
 *
 * `root_registration` supplies the host/config-space triple, the approved
 * `RootRegistry` proves the live root path in this process, and the adapter's
 * packaged selection spec reads the model the host itself stored. The same
 * candidate rules as the compaction composition are used, so a host is never
 * read with another host's pointer layout.
 */
export function resolvePersistedHostModel(
  input: ResolvePersistedHostModelInput
): ConfigResult<ModelRef> {
  const selected = input.selected ?? {};
  const rows = input.connection
    .prepare<ModelRootRow>(
      `SELECT root_id, host_id, mode, config_space
         FROM root_registration
        ORDER BY registered_at DESC, root_id ASC`
    )
    .all();
  const bootFailed = new Set(input.rootRegistry.boot_failures.map((failure) => failure.root_id));
  const found: { host_id: string; model: ModelRef }[] = [];
  for (const row of rows) {
    if (selected.root_id !== undefined && row.root_id !== selected.root_id) continue;
    if (selected.host_id !== undefined && row.host_id !== selected.host_id) continue;
    if (selected.config_space !== undefined && row.config_space !== selected.config_space) continue;
    if (PACKAGED_MODEL_SELECTIONS[row.host_id] === undefined) continue;
    const declaration = declarationFor(row.host_id);
    if (declaration === null || declaration.config_space !== row.config_space) continue;
    if (bootFailed.has(row.root_id)) continue;
    const looked = input.rootRegistry.lookup(row.root_id);
    if (!looked.ok) continue;
    const entry = looked.value;
    const rootPath = entry.approved_root;
    if (rootPath === null) continue;
    if (
      entry.host_id !== row.host_id ||
      entry.mode !== row.mode ||
      entry.config_space !== row.config_space
    ) {
      continue;
    }
    const read = readConfiguredHostModel({
      host_id: row.host_id,
      root_path: rootPath,
      ...(input.layer_id === undefined ? {} : { layer_id: input.layer_id })
    });
    if (read.ok) {
      found.push({ host_id: row.host_id, model: read.value });
    }
  }
  return exactlyOneModel(found, rows.length, selected.host_id ?? "any");
}

function exactlyOneModel(
  found: readonly { readonly host_id: string; readonly model: ModelRef }[],
  candidateCount: number,
  hostId: string
): ConfigResult<ModelRef> {
  if (found.length === 1) {
    return { ok: true, value: found[0]!.model };
  }
  if (found.length > 1) {
    const hostsFound = [...new Set(found.map((entry) => entry.host_id))];
    return unbound("selection_ambiguous", [["hosts", hostsFound.join(",")]]);
  }
  return unbound("selection_unavailable", [
    ["roots", candidateCount],
    ["host_id", hostId]
  ]);
}
