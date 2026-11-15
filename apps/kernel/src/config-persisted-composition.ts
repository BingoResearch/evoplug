/**
 * W10 persisted composition.
 *
 * The bootstrap only knows the SQLite connection, the root registry/resolver,
 * the journal, the blob store and the seven packaged adapters. This factory
 * derives the CFG host binding from real persisted facts instead of asking a
 * caller to restate them:
 *
 * - `root_registration` supplies the live root ids and the registered
 *   host/mode/config-space triple;
 * - an approved `RootRegistry` entry proves the root is live in this process;
 * - `capability_record` supplies the verified `product_adapter` binding, its
 *   binding key and the canonical capability snapshot hash;
 * - the packaged adapter compaction declaration supplies the tunable field
 *   paths and the reload channel claim.
 *
 * No status is invented here. The field registry keeps the declared
 * `source_only` / `h_unverified` / `unsupported` status verbatim. A declaration
 * whose `reload_kind` is `unsupported` (or whose real resolver was not
 * supplied) produces no reload declaration, so promotion can never reach
 * `active` from this composition alone.
 *
 * Ambiguity is blocked with a named CFG error; the factory never picks one of
 * several roots, bindings or layers by heuristics.
 */

import type { Hash, HostId, SourceRef } from "@evoplug/core";
import type { CapabilityRecord } from "@evoplug/core/host";
import {
  capabilityBindingKey,
  computeCapabilitySnapshotHash
} from "@evoplug/core/host";
import type {
  ConfigResult,
  EpochMs,
  FieldRegistrySnapshot,
  HostBinding,
  ModelRef
} from "@evoplug/core/config";
import {
  buildHostFieldRegistry,
  configError,
  fail,
  succeed
} from "@evoplug/core/config";
import {
  listCapabilityRecords,
  type RootRegistry,
  type RootRegistryEntry
} from "@evoplug/kernel";
import type { ConfigProtectedSubtree, SafetyAuditPort } from "@evoplug/core";
import type { CapacityEvidencePort } from "@evoplug/core/host";
import type {
  BlobStore,
  JournalCommitter,
  SqliteConnection,
  SqlRow
} from "@evoplug/storage";

import {
  CLAUDE_COMPACTION_SPEC
} from "@evoplug/adapter-claude-code";
import { CODEX_COMPACTION_SPEC } from "@evoplug/adapter-codex";
import { OMP_COMPACTION_SPEC } from "@evoplug/adapter-oh-my-pi";
import { OPENCODE_COMPACTION_SPEC } from "@evoplug/adapter-opencode";
import { OPENHANDS_COMPACTION_SPEC } from "@evoplug/adapter-openhands-sdk";
import { PI_COMPACTION_SPEC } from "@evoplug/adapter-pi";
import { STEP_COMPACTION_SPEC } from "@evoplug/adapter-step-code";

import {
  createConfigComposition,
  type CompactionSpecDeclaration,
  type ConfigComposition,
  type ConfigReloadResolver
} from "./config-composition.js";
import {
  createDefaultReloadResolver,
  type PersistedReloadHostSource
} from "./config-reload-factories.js";

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

/** Every packaged compaction declaration, in stable host order. */
export const PACKAGED_COMPACTION_SPECS: readonly CompactionSpecDeclaration[] = Object.freeze([
  PI_COMPACTION_SPEC,
  OMP_COMPACTION_SPEC,
  STEP_COMPACTION_SPEC,
  CODEX_COMPACTION_SPEC,
  OPENCODE_COMPACTION_SPEC,
  OPENHANDS_COMPACTION_SPEC,
  CLAUDE_COMPACTION_SPEC
]);

/**
 * Optional explicit selection. Every field narrows the candidate set; none
 * supplies data that the database could provide. When the remaining set is not
 * a single root/binding/layer the factory fails closed.
 */
export interface PersistedConfigSelection {
  readonly host_id?: HostId;
  readonly config_space?: string;
  readonly root_id?: string;
  readonly capability_binding_key?: Hash;
  /** Declared layer id (for example `user`); must carry the tunable paths. */
  readonly layer_id?: string;
}

/** Real host reload path. The declaration kind must equal the adapter claim. */
export interface PersistedReloadResolver {
  readonly kind: "sdk_reload" | "new_process_parse" | "config_watch";
  readonly resolve: ConfigReloadResolver;
}

export interface PersistedConfigCompositionOptions {
  /** Explicit opt-in; a missing or false value keeps every trial path off. */
  readonly enabled: boolean;
  readonly connection: SqliteConnection;
  readonly rootRegistry: RootRegistry;
  readonly rootResolver: import("@evoplug/core").RootResolver;
  readonly journal: JournalCommitter;
  readonly blobStore: BlobStore;
  readonly now: () => EpochMs;
  /**
   * The model currently selected by the host, read back by the host glue.
   * It is the only caller-supplied fact: the database persists no live model
   * readback, so inventing one would fabricate a host binding.
   */
  readonly model: ModelRef;
  readonly autoTuneFields?: readonly string[];
  readonly observationWindow?: import("@evoplug/core/config").ObservationWindowSpec;
  readonly defaultDeadlineMs?: number;
  readonly capacityEvidencePort?: CapacityEvidencePort | null;
  readonly safetyAudit?: SafetyAuditPort | null;
  readonly protectedSubtrees?: readonly ConfigProtectedSubtree[];
  /** Restrict selection when several approved roots/adapters are live. */
  readonly selected?: PersistedConfigSelection;
  /** Defaults to all seven packaged specs. */
  readonly specs?: readonly CompactionSpecDeclaration[];
  /** Per-host real reload path; absent hosts keep their declaration claim. */
  readonly reloads?: Partial<Record<HostId, PersistedReloadResolver>>;
  /**
   * Explicit host inputs for the default adapter reload factories. An entry in
   * `reloads` always wins over this map. Hosts without a registered factory
   * (for example OpenCode) stay without a reload declaration.
   */
  readonly reload_sources?: Partial<Record<HostId, PersistedReloadHostSource>>;
  /** Trust evidence for a non-user (project) layer. */
  readonly trust_evidence_ref?: SourceRef | null;
  /** Test/embedded seam; defaults to the versioned host registry. */
  readonly registry?: FieldRegistrySnapshot;
}

/* ------------------------------------------------------------------ */
/* Persisted root read                                                 */
/* ------------------------------------------------------------------ */

interface RootRow extends SqlRow {
  readonly root_id: string;
  readonly registration_hash: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly adapter_id: string;
  readonly native_root_ref: string;
  readonly identity_kind: string;
  readonly device_id: string;
  readonly file_id: string;
  readonly registered_at: number;
  readonly row_version: number;
}

interface RootCandidate {
  readonly row: RootRow;
  readonly entry: RootRegistryEntry;
  readonly spec: CompactionSpecDeclaration;
}

function readRootRows(connection: SqliteConnection): readonly RootRow[] {
  return connection
    .prepare<RootRow>(
      `SELECT root_id, registration_hash, host_id, mode, config_space, adapter_id,
              native_root_ref, identity_kind, device_id, file_id, registered_at, row_version
         FROM root_registration
        ORDER BY registered_at DESC, root_id ASC`
    )
    .all();
}

function conflict(
  code: "E_CFG_ROOT_AMBIGUOUS" | "E_CFG_CAPABILITY_UNVERIFIED" | "E_CFG_ROOT_UNRESOLVED" | "E_CFG_ROOT_UNAVAILABLE" | "E_CFG_MODEL_UNBOUND" | "E_CFG_HOST_VERSION_UNBOUND",
  entries: readonly [string, string | number | boolean][]
): ConfigResult<never> {
  return fail(
    configError(code, {
      details: entries.map(([key, value]) => ({ key, value }))
    })
  );
}

function hostConfigSpaceKey(hostId: string, configSpace: string): string {
  return `${hostId}:${configSpace}`;
}

const CFG_CONSTRUCTION_PATHS: readonly HostBinding["construction_path"][] = Object.freeze([
  "cli",
  "sdk",
  "rpc",
  "app_server",
  "acp",
  "sdk_stdio",
  "server",
  "server_settings",
  "direct_agent",
  "preset_agent",
  "subagent_factory"
]);

function cfgConstructionPath(value: string): HostBinding["construction_path"] | null {
  return CFG_CONSTRUCTION_PATHS.find((path) => path === value) ?? null;
}

function specFor(
  specs: readonly CompactionSpecDeclaration[],
  hostId: string
): CompactionSpecDeclaration | null {
  return specs.find((spec) => spec.host_id === hostId) ?? null;
}

function selectCandidates(
  rows: readonly RootRow[],
  registry: RootRegistry,
  specs: readonly CompactionSpecDeclaration[],
  selected: PersistedConfigSelection
): ConfigResult<readonly RootCandidate[]> {
  const bootFailed = new Set(registry.boot_failures.map((failure) => failure.root_id));
  const candidates: RootCandidate[] = [];
  for (const row of rows) {
    if (selected.root_id !== undefined && row.root_id !== selected.root_id) continue;
    if (selected.host_id !== undefined && row.host_id !== selected.host_id) continue;
    if (selected.config_space !== undefined && row.config_space !== selected.config_space) continue;
    const spec = specFor(specs, row.host_id);
    if (spec === null || spec.config_space !== row.config_space) continue;
    const looked = registry.lookup(row.root_id);
    if (!looked.ok) continue;
    const entry = looked.value;
    if (entry.approved_root === null) continue;
    if (bootFailed.has(row.root_id)) continue;
    if (
      entry.host_id !== row.host_id ||
      entry.mode !== row.mode ||
      entry.config_space !== row.config_space
    ) {
      continue;
    }
    candidates.push({ row, entry, spec });
  }
  if (candidates.length > 0) {
    return succeed(candidates);
  }
  if (selected.root_id !== undefined) {
    const row = rows.find((candidate) => candidate.root_id === selected.root_id);
    if (row !== undefined && bootFailed.has(row.root_id)) {
      return conflict("E_CFG_ROOT_UNAVAILABLE", [["root_id", selected.root_id]]);
    }
    return conflict("E_CFG_ROOT_UNRESOLVED", [["root_id", selected.root_id]]);
  }
  return conflict("E_CFG_ROOT_UNRESOLVED", [["dimension", "approved_root"]]);
}

function selectRoot(candidates: readonly RootCandidate[]): ConfigResult<RootCandidate> {
  const spaces = new Set(candidates.map((candidate) => hostConfigSpaceKey(candidate.row.host_id, candidate.row.config_space)));
  if (spaces.size > 1) {
    return conflict("E_CFG_ROOT_AMBIGUOUS", [
      ["dimension", "host_config_space"],
      ["candidates", spaces.size]
    ]);
  }
  if (candidates.length > 1) {
    const roots = new Set(candidates.map((candidate) => candidate.row.root_id));
    return conflict("E_CFG_ROOT_AMBIGUOUS", [
      ["dimension", "root_id"],
      ["candidates", roots.size]
    ]);
  }
  const only = candidates[0];
  if (only === undefined) {
    return conflict("E_CFG_ROOT_UNRESOLVED", [["dimension", "root_id"]]);
  }
  return succeed(only);
}

/* ------------------------------------------------------------------ */
/* Layer selection                                                     */
/* ------------------------------------------------------------------ */

function chooseLayer(
  spec: CompactionSpecDeclaration,
  selected: PersistedConfigSelection
): ConfigResult<CompactionSpecDeclaration> {
  const tunableLayers = new Set(spec.field_paths.map((path) => path.layer_id));
  const declared = spec.layers.filter((layer) => tunableLayers.has(layer.layer_id));
  if (declared.length === 0) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "field_paths"]]);
  }
  if (selected.layer_id !== undefined) {
    const chosen = declared.find((layer) => layer.layer_id === selected.layer_id);
    if (chosen === undefined) {
      return conflict("E_CFG_CAPABILITY_UNVERIFIED", [
        ["dimension", "layer_id"],
        ["layer_id", selected.layer_id]
      ]);
    }
    return succeed({ ...spec, layers: [chosen] });
  }
  if (declared.length > 1) {
    return conflict("E_CFG_ROOT_AMBIGUOUS", [
      ["dimension", "layer_id"],
      ["candidates", declared.length]
    ]);
  }
  return succeed({ ...spec, layers: [declared[0] as (typeof declared)[number]] });
}

function registryLayerIdFor(
  registry: FieldRegistrySnapshot,
  layer: CompactionSpecDeclaration["layers"][number]
): string | null {
  for (const spec of registry.field_specs) {
    for (const source of spec.source_layers) {
      if (
        source.path.kind === "file" &&
        source.path.root === layer.root_kind &&
        source.path.relative_path === layer.relative_path &&
        source.path.format === layer.format
      ) {
        return source.layer_id;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Capability binding selection                                        */
/* ------------------------------------------------------------------ */

interface SelectedCapability {
  readonly record: CapabilityRecord;
  readonly snapshot_hash: Hash;
}

function selectCapability(
  connection: SqliteConnection,
  candidate: RootCandidate,
  selected: PersistedConfigSelection
): ConfigResult<SelectedCapability> {
  const listed = listCapabilityRecords(connection);
  if (!listed.ok) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "capability_record"]]);
  }
  const product = listed.value.filter((record) => record.binding.subject === "product_adapter");
  if (product.length === 0) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "capability_snapshot"]]);
  }
  const matching = product.filter((record) => {
    const binding = record.binding;
    if (binding.host_id !== candidate.row.host_id) return false;
    if (binding.config_space !== candidate.row.config_space) return false;
    if (binding.mode !== candidate.row.mode) return false;
    if (binding.root_id !== candidate.row.root_id) return false;
    if (
      selected.capability_binding_key !== undefined &&
      record.binding_key !== selected.capability_binding_key
    ) {
      return false;
    }
    return true;
  });
  const keys = new Set(matching.map((record) => record.binding_key));
  if (keys.size === 0) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [
      ["dimension", "capability_binding_key"],
      ["root_id", candidate.row.root_id]
    ]);
  }
  if (keys.size > 1) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [
      ["dimension", "capability_binding_key"],
      ["value", "ambiguous"],
      ["candidates", keys.size]
    ]);
  }
  const record = matching[0];
  if (record === undefined) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "capability_binding_key"]]);
  }
  if (capabilityBindingKey(record.binding) !== record.binding_key) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "capability_binding_key"], ["value", "hash_mismatch"]]);
  }
  return succeed({
    record,
    snapshot_hash: computeCapabilitySnapshotHash(product)
  });
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

/**
 * Builds the same `ConfigComposition` as `createConfigComposition`, but from
 * persisted root/capability facts and the packaged adapter declarations.
 *
 * The default `config_autotune=false` path still builds capture/read/write and
 * promotion ports; only trial execution is off.
 */
export function createPersistedConfigComposition(
  options: PersistedConfigCompositionOptions
): ConfigResult<ConfigComposition> {
  const specs = options.specs ?? PACKAGED_COMPACTION_SPECS;
  const selected = options.selected ?? {};

  const roots = selectCandidates(readRootRows(options.connection), options.rootRegistry, specs, selected);
  if (!roots.ok) return roots;
  const root = selectRoot(roots.value);
  if (!root.ok) return root;
  const candidate = root.value;

  const layered = chooseLayer(candidate.spec, selected);
  if (!layered.ok) return layered;
  const spec = layered.value;
  const layer = spec.layers[0];
  if (layer === undefined) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "layer"]]);
  }
  if (layer.root_kind !== "user" && options.trust_evidence_ref == null) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "trust_evidence"]]);
  }

  const registry =
    options.registry ??
    ((): FieldRegistrySnapshot | null => {
      const built = buildHostFieldRegistry(candidate.row.host_id as HostId, options.now());
      return built.ok ? built.value : null;
    })();
  if (registry === null) {
    return conflict("E_CFG_HOST_VERSION_UNBOUND", [["dimension", "registry"]]);
  }
  if (
    registry.host_id !== candidate.row.host_id ||
    registry.config_space !== candidate.row.config_space
  ) {
    return conflict("E_CFG_HOST_VERSION_UNBOUND", [["dimension", "config_space"]]);
  }
  const registryLayerId = registryLayerIdFor(registry, layer);
  if (registryLayerId === null) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "layer"], ["layer_id", layer.layer_id]]);
  }

  const capability = selectCapability(options.connection, candidate, selected);
  if (!capability.ok) return capability;
  const binding = capability.value.record.binding;
  if (
    binding.host_id !== registry.host_id ||
    binding.config_space !== registry.config_space ||
    binding.root_id !== candidate.row.root_id
  ) {
    return conflict("E_CFG_HOST_VERSION_UNBOUND", [["dimension", "capability_binding"]]);
  }
  if (options.model.provider.length === 0 || options.model.model_id.length === 0) {
    return conflict("E_CFG_MODEL_UNBOUND", [["dimension", "model"]]);
  }
  const constructionPath = cfgConstructionPath(binding.construction_path);
  if (constructionPath === null) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [
      ["dimension", "construction_path"],
      ["value", binding.construction_path]
    ]);
  }

  const host: HostBinding = {
    host_id: binding.host_id,
    source_pin: binding.source_pin,
    binary_pin: binding.binary_pin,
    adapter_version: binding.adapter_version,
    subject: "product_adapter",
    mode: binding.mode,
    config_space: binding.config_space,
    root_id: binding.root_id,
    execution_environment: binding.execution_environment,
    mapping: binding.mapping,
    capability_binding_key: capability.value.record.binding_key,
    capability_snapshot_hash: capability.value.snapshot_hash,
    model: options.model,
    construction_path: constructionPath
  };

  const layerRootIds: Record<string, string> = {
    [layer.layer_id]: candidate.row.root_id,
    [registryLayerId]: candidate.row.root_id
  };
  let reload = options.reloads?.[binding.host_id];
  if (reload === undefined) {
    const source = options.reload_sources?.[binding.host_id];
    const approvedRoot = candidate.entry.approved_root;
    if (source !== undefined && approvedRoot !== null) {
      const built = createDefaultReloadResolver({
        host_id: binding.host_id,
        spec,
        layer,
        approved_root: approvedRoot,
        source,
        now: options.now
      });
      if (!built.ok) return built;
      if (built.value !== null) reload = built.value;
    }
  }
  const reloadHost =
    reload === undefined || spec.reload_kind === "unsupported"
      ? undefined
      : reload.kind === spec.reload_kind
        ? { kind: reload.kind, resolve: reload.resolve }
        : undefined;
  if (reload !== undefined && spec.reload_kind !== "unsupported" && reload.kind !== spec.reload_kind) {
    return conflict("E_CFG_CAPABILITY_UNVERIFIED", [["dimension", "reload_kind"]]);
  }

  return createConfigComposition({
    enabled: options.enabled,
    connection: options.connection,
    rootResolver: options.rootResolver,
    journal: options.journal,
    blobStore: options.blobStore,
    now: options.now,
    host: {
      spec,
      host,
      layer_root_ids: layerRootIds,
      registry,
      source_layer_id: registryLayerId,
      ...(options.trust_evidence_ref === undefined
        ? {}
        : { trust_evidence_ref: options.trust_evidence_ref }),
      ...(reloadHost === undefined ? {} : { reload: reloadHost })
    },
    ...(options.autoTuneFields === undefined ? {} : { autoTuneFields: options.autoTuneFields }),
    ...(options.observationWindow === undefined
      ? {}
      : { observationWindow: options.observationWindow }),
    ...(options.defaultDeadlineMs === undefined
      ? {}
      : { defaultDeadlineMs: options.defaultDeadlineMs }),
    ...(options.capacityEvidencePort === undefined
      ? {}
      : { capacityEvidencePort: options.capacityEvidencePort }),
    ...(options.safetyAudit === undefined ? {} : { safetyAudit: options.safetyAudit }),
    ...(options.protectedSubtrees === undefined
      ? {}
      : { protectedSubtrees: options.protectedSubtrees })
  });
}
