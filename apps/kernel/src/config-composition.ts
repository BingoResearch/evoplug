/**
 * W10 product composition.
 *
 * The app layer is the only place that sees every adapter declaration and the
 * FND/auth packages. This module turns one adapter compaction declaration plus
 * the live root registration ids into the three real ports the kernel CFG
 * services consume:
 *
 * - `ConfigSpaceCatalogPort` (declaration + live root ids + computed hashes);
 * - `ConfigWritePort` / `ConfigWriteReadPort` (auth, bound to one SQLite
 *   connection and one journal);
 * - `ConfigReloadProbePort` (adapter resolver, never a host branch).
 *
 * No status is promoted here. Registries come from `buildHostFieldRegistry`
 * unchanged, so every field keeps its declared `source_only` /
 * `h_unverified` / `unsupported` status until real promotion evidence is
 * evaluated.
 */

import type {
  ConfigPatchApplyInput,
  ConfigPatchApplyResult,
  ConfigWritePort,
  ConfigWriteReadPort,
  Hash,
  RootResolver,
  SourceRef
} from "@evoplug/core";
import type {
  ConfigLayerTarget,
  ConfigReloadDeclaration,
  ConfigReloadProbePort,
  ConfigReloadResolved,
  ConfigResult,
  ConfigSpaceCatalogEntry,
  ConfigSpaceCatalogPort,
  ConfigSpaceSelector,
  ConfigTrialService,
  CompactionFieldPath,
  ConfigSpaceService,
  ConfigSpaceSnapshot,
  FieldRegistrySnapshot,
  HostBinding,
  ObservationWindowSpec,
  SourceLayerSpec
} from "@evoplug/core/config";
import {
  applyConfigPatch,
  buildHostFieldRegistry,
  computeConfigSpaceId,
  computeSourceLayerSetHash,
  configError,
  fail,
  succeed
} from "@evoplug/core/config";
import type { CapacityEvidencePort } from "@evoplug/core/host";
import type {
  ConfigProtectedSubtree,
  SafetyAuditPort
} from "@evoplug/core";
import type { BlobStore, JournalCommitter, SqliteConnection } from "@evoplug/storage";
import {
  createCompactionPromotionService,
  createConfigHandlers,
  createConfigReloadProbe,
  createConfigSpaceService,
  createConfigTrialService,
  createKernelConfigWritePort,
  createKernelConfigWriteReadPort,
  type CompactionPromotionService,
  type ConfigIpcHandlers
} from "@evoplug/kernel";

/* ------------------------------------------------------------------ */
/* Adapter declaration shape (shared by the seven compaction modules)  */
/* ------------------------------------------------------------------ */

export interface CompactionSpecDeclaration {
  readonly schema_version: "rsi.compaction_spec/1";
  readonly host_id: string;
  readonly config_space: string;
  readonly layers: readonly ConfigLayerTarget[];
  readonly field_paths: readonly CompactionFieldPath[];
  readonly reload_kind: "sdk_reload" | "new_process_parse" | "config_watch" | "unsupported";
}

export type ConfigReloadResolver = (input: {
  readonly field_ids: readonly import("@evoplug/core").Id<"fld">[];
  readonly deadline_ms: number;
  readonly signal?: AbortSignal;
}) => Promise<ConfigResult<ConfigReloadResolved>>;

interface ConfigCompactionHost {
  readonly spec: CompactionSpecDeclaration;
  /** Live HOST capability snapshot projection (hashes are not derived here). */
  readonly host: HostBinding;
  /**
   * Logical layer id (adapter declaration id or registry layer id) to the
   * live FND `root_registration.root_id`. Both spellings are accepted so a
   * declaration that predates the registry layer ids still binds.
   */
  readonly layer_root_ids: Readonly<Record<string, string>>;
  /** Exact registry snapshot; omitted builds the versioned host registry. */
  readonly registry?: FieldRegistrySnapshot;
  /** Source layer for selectors and readbacks; defaults to the user layer. */
  readonly source_layer_id?: string;
  /** Host trust evidence for a project layer, when the selector uses one. */
  readonly trust_evidence_ref?: SourceRef | null;
  /** Real reload path supplied by the host glue; absent stays unsupported. */
  readonly reload?: {
    readonly kind: "sdk_reload" | "new_process_parse" | "config_watch";
    readonly resolve: ConfigReloadResolver;
  };
}

/* ------------------------------------------------------------------ */
/* Options and result                                                  */
/* ------------------------------------------------------------------ */

interface ConfigCompositionOptions {
  readonly enabled: boolean;
  readonly connection: SqliteConnection;
  readonly rootResolver: RootResolver;
  readonly journal: JournalCommitter;
  readonly blobStore: BlobStore;
  readonly now: () => number;
  readonly host: ConfigCompactionHost;
  readonly autoTuneFields?: readonly string[];
  readonly observationWindow?: ObservationWindowSpec;
  readonly defaultDeadlineMs?: number;
  readonly capacityEvidencePort?: CapacityEvidencePort | null;
  readonly safetyAudit?: SafetyAuditPort | null;
  readonly protectedSubtrees?: readonly ConfigProtectedSubtree[];
}

interface ConfigCatalogView {
  readonly config_space_id: Hash;
  readonly config_space: string;
  readonly host: HostBinding;
  readonly selector: ConfigSpaceSelector;
  readonly entry: ConfigSpaceCatalogEntry;
}

export interface ConfigComposition {
  readonly enabled: boolean;
  readonly registry: FieldRegistrySnapshot;
  readonly catalog: ConfigSpaceCatalogPort;
  readonly catalogs: readonly ConfigCatalogView[];
  readonly space: ConfigSpaceService;
  readonly trial: ConfigTrialService | null;
  readonly promotion: CompactionPromotionService;
  readonly reload: ConfigReloadProbePort;
  readonly reload_declarations: readonly ConfigReloadDeclaration[];
  readonly write: ConfigWritePort;
  readonly write_read: ConfigWriteReadPort;
  /** Ten IPC handlers ready for the central method-table splice. */
  readonly handlers: ConfigIpcHandlers;
}

/* ------------------------------------------------------------------ */
/* Catalog construction                                                */
/* ------------------------------------------------------------------ */

function uniqueRegistryLayers(registry: FieldRegistrySnapshot): readonly SourceLayerSpec[] {
  const byId = new Map<string, SourceLayerSpec>();
  for (const spec of registry.field_specs) {
    for (const layer of spec.source_layers) {
      if (!byId.has(layer.layer_id)) {
        byId.set(layer.layer_id, layer);
      }
    }
  }
  return [...byId.values()].sort((left, right) => left.precedence_rank - right.precedence_rank);
}

function fileLayers(layers: readonly SourceLayerSpec[]): readonly (SourceLayerSpec & {
  path: Extract<SourceLayerSpec["path"], { kind: "file" }>;
})[] {
  return layers.filter(
    (layer): layer is SourceLayerSpec & { path: Extract<SourceLayerSpec["path"], { kind: "file" }> } =>
      layer.path.kind === "file"
  );
}

/**
 * Adapter declarations name layers for humans (`user`, `project`); the field
 * registry owns the canonical ids (`pi_user_settings`, ...). Match by root
 * kind and path first; when a host spells the same location differently
 * (home-relative vs config-dir-relative), accept it only when exactly one
 * registry layer has that root kind.
 */
function matchRegistryLayer(
  declaration: ConfigLayerTarget,
  layers: readonly SourceLayerSpec[]
): SourceLayerSpec | null {
  const filePath = (layer: SourceLayerSpec): Extract<SourceLayerSpec["path"], { kind: "file" }> | null =>
    layer.path.kind === "file" ? layer.path : null;
  const exact = layers.find((layer) => {
    const path = filePath(layer);
    return (
      path !== null &&
      path.root === declaration.root_kind &&
      path.relative_path === declaration.relative_path &&
      path.format === declaration.format
    );
  });
  if (exact !== undefined) {
    return exact;
  }
  const candidates = layers.filter((layer) => filePath(layer)?.root === declaration.root_kind);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

function rootIdFor(
  host: ConfigCompactionHost,
  registryLayerId: string,
  declaredLayerId: string
): string | null {
  return host.layer_root_ids[registryLayerId] ?? host.layer_root_ids[declaredLayerId] ?? null;
}

function selectSourceLayer(
  registry: FieldRegistrySnapshot,
  layers: readonly SourceLayerSpec[],
  explicit: string | undefined
): ConfigResult<string> {
  if (explicit !== undefined) {
    return succeed(explicit);
  }
  const files = fileLayers(layers);
  const user = files.find((layer) => layer.writable && layer.path.root === "user");
  if (user !== undefined) {
    return succeed(user.layer_id);
  }
  const writable = files.filter((layer) => layer.writable && layer.path.root !== "managed");
  const highest = writable[writable.length - 1];
  if (highest !== undefined) {
    return succeed(highest.layer_id);
  }
  const first = registry.field_specs[0];
  const fallback = first?.precedence[first.precedence.length - 1];
  if (fallback !== undefined) {
    return succeed(fallback);
  }
  return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { details: [{ key: "source_layer", value: "missing" }] }));
}

interface BuiltCatalog {
  readonly view: ConfigCatalogView;
  readonly declaration: ConfigReloadDeclaration | null;
}

function buildCatalog(host: ConfigCompactionHost, registry: FieldRegistrySnapshot): ConfigResult<BuiltCatalog> {
  const spec = host.spec;
  if (
    spec.host_id !== registry.host_id ||
    spec.config_space !== registry.config_space ||
    host.host.host_id !== registry.host_id ||
    host.host.config_space !== registry.config_space
  ) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "host" }] }));
  }

  const registryLayers = uniqueRegistryLayers(registry);
  const fileRegistryLayers = fileLayers(registryLayers);
  const layerMap = new Map<string, { registry: SourceLayerSpec; root_id: string }>();
  const rewritten: ConfigLayerTarget[] = [];
  for (const layer of spec.layers) {
    const matched = matchRegistryLayer(layer, fileRegistryLayers);
    if (matched === null) {
      return fail(
        configError("E_CFG_CAPABILITY_UNVERIFIED", {
          details: [
            { key: "dimension", value: "layer" },
            { key: "layer_id", value: layer.layer_id }
          ]
        })
      );
    }
    const rootId = rootIdFor(host, matched.layer_id, layer.layer_id);
    if (rootId === null) {
      return fail(configError("E_CFG_ROOT_UNRESOLVED", { details: [{ key: "layer_id", value: matched.layer_id }] }));
    }
    layerMap.set(layer.layer_id, { registry: matched, root_id: rootId });
    rewritten.push({
      layer_id: matched.layer_id,
      root_kind: layer.root_kind,
      root_id: rootId,
      relative_path: layer.relative_path,
      format: layer.format
    });
  }

  const fieldPaths: CompactionFieldPath[] = [];
  for (const path of spec.field_paths) {
    const mapped = layerMap.get(path.layer_id);
    if (mapped === undefined) {
      return fail(
        configError("E_CFG_FIELD_UNKNOWN", {
          details: [
            { key: "field_key", value: path.field_key },
            { key: "layer_id", value: path.layer_id }
          ]
        })
      );
    }
    fieldPaths.push({ field_key: path.field_key, layer_id: mapped.registry.layer_id, pointer: path.pointer });
  }

  const sourceLayerResult = selectSourceLayer(registry, fileRegistryLayers, host.source_layer_id);
  if (!sourceLayerResult.ok) {
    return sourceLayerResult;
  }
  const sourceLayerId = sourceLayerResult.value;
  const sourceLayer = rewritten.find((layer) => layer.layer_id === sourceLayerId);
  if (sourceLayer === undefined) {
    return fail(configError("E_CFG_CAPABILITY_UNVERIFIED", { details: [{ key: "dimension", value: "source_layer" }] }));
  }
  if (host.host.root_id !== sourceLayer.root_id) {
    return fail(
      configError("E_CFG_AUTHORIZATION_SCOPE", {
        details: [{ key: "dimension", value: "source_root" }]
      })
    );
  }

  const layerSetHash = computeSourceLayerSetHash({
    host_id: registry.host_id,
    source_pin: registry.source_pin,
    binary_pin: registry.binary_pin,
    adapter_version: registry.adapter_version,
    config_space: registry.config_space,
    mode: registry.mode,
    construction_path: registry.construction_path,
    layers: fileRegistryLayers
  });
  const configSpaceId = computeConfigSpaceId({
    host_id: host.host.host_id,
    source_pin: host.host.source_pin,
    binary_pin: host.host.binary_pin,
    adapter_version: host.host.adapter_version,
    mode: host.host.mode,
    construction_path: host.host.construction_path,
    config_space: host.host.config_space,
    source_layer_set_hash: layerSetHash,
    root_id: host.host.root_id,
    execution_environment: host.host.execution_environment
  });

  const entry: ConfigSpaceCatalogEntry = {
    config_space: spec.config_space,
    host: host.host,
    root_id: sourceLayer.root_id,
    source_layer_id: sourceLayerId,
    source_layer_set_hash: layerSetHash,
    capability_binding_key: host.host.capability_binding_key,
    capability_snapshot_hash: host.host.capability_snapshot_hash,
    trust_evidence_ref: host.trust_evidence_ref ?? null,
    layers: rewritten,
    field_paths: fieldPaths
  };
  const selector: ConfigSpaceSelector = {
    config_space_id: configSpaceId,
    config_space: entry.config_space,
    source_layer_id: entry.source_layer_id,
    source_layer_set_hash: entry.source_layer_set_hash,
    root_id: entry.root_id,
    trust_evidence_ref: entry.trust_evidence_ref,
    capability_binding_key: entry.capability_binding_key,
    capability_snapshot_hash: entry.capability_snapshot_hash
  };

  let declaration: ConfigReloadDeclaration | null = null;
  if (host.reload !== undefined && spec.reload_kind !== "unsupported") {
    if (host.reload.kind !== spec.reload_kind) {
      return fail(
        configError("E_CFG_CAPABILITY_UNVERIFIED", {
          details: [{ key: "dimension", value: "reload_kind" }]
        })
      );
    }
    declaration = {
      config_space_id: configSpaceId,
      config_space: spec.config_space,
      kind: host.reload.kind,
      resolve: host.reload.resolve
    };
  }

  return succeed({
    view: {
      config_space_id: configSpaceId,
      config_space: spec.config_space,
      host: host.host,
      selector,
      entry
    },
    declaration
  });
}

/* ------------------------------------------------------------------ */
/* Real FND ports                                                      */
/* ------------------------------------------------------------------ */

function makeApplyPort(): import("@evoplug/core").ConfigPatchApplyPort {
  return {
    async apply(input: ConfigPatchApplyInput): Promise<ConfigPatchApplyResult> {
      const path = input.patch.expected_fields[0]?.path ?? input.patch.candidate_values[0]?.path;
      return applyConfigPatch(
        input,
        path === undefined ? { root: "user" } : { root: path.root, format: path.format }
      );
    }
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createConfigComposition(
  options: ConfigCompositionOptions
): ConfigResult<ConfigComposition> {
  let registry: FieldRegistrySnapshot;
  if (options.host.registry !== undefined) {
    registry = options.host.registry;
  } else {
    const builtRegistry = buildHostFieldRegistry(options.host.host.host_id, options.now());
    if (!builtRegistry.ok) {
      return builtRegistry;
    }
    registry = builtRegistry.value;
  }
  const built = buildCatalog(options.host, registry);
  if (!built.ok) {
    return built;
  }

  const entries = new Map<string, ConfigSpaceCatalogEntry>([[built.value.view.config_space_id, built.value.view.entry]]);
  const catalog: ConfigSpaceCatalogPort = {
    get(configSpaceId) {
      const entry = entries.get(configSpaceId);
      if (entry === undefined) {
        return fail(configError("E_CFG_FIELD_UNKNOWN", { details: [{ key: "config_space_id", value: configSpaceId }] }));
      }
      return succeed(entry);
    }
  };

  const applyPort = makeApplyPort();
  const write = createKernelConfigWritePort({
    connection: options.connection,
    blob_store: options.blobStore,
    now: options.now,
    journal: options.journal,
    root_resolver: options.rootResolver,
    apply_port: applyPort
  });
  const writeRead = createKernelConfigWriteReadPort(options.connection);

  const declarations = built.value.declaration === null ? [] : [built.value.declaration];
  const reload = createConfigReloadProbe({ declarations, now: options.now });

  const space = createConfigSpaceService({
    rootResolver: options.rootResolver,
    registry,
    catalog,
    blobStore: options.blobStore,
    now: options.now,
    ...(options.defaultDeadlineMs === undefined ? {} : { defaultDeadlineMs: options.defaultDeadlineMs })
  });

  const trial =
    options.enabled
      ? createConfigTrialService({
          enabled: true,
          connection: options.connection,
          registry,
          rootResolver: options.rootResolver,
          catalog,
          configWrite: write,
          configWriteRead: writeRead,
          journal: options.journal,
          reloadProbe: reload,
          now: options.now,
          autoTuneFields: options.autoTuneFields ?? [],
          ...(options.observationWindow === undefined ? {} : { observationWindow: options.observationWindow }),
          ...(options.defaultDeadlineMs === undefined ? {} : { defaultDeadlineMs: options.defaultDeadlineMs }),
          ...(options.capacityEvidencePort === undefined ? {} : { capacityEvidencePort: options.capacityEvidencePort }),
          ...(options.safetyAudit === undefined ? {} : { safetyAudit: options.safetyAudit }),
          ...(options.protectedSubtrees === undefined ? {} : { protectedSubtrees: options.protectedSubtrees }),
          space,
          blobStore: options.blobStore
        })
      : null;

  const promotion = createCompactionPromotionService({
    connection: options.connection,
    space,
    reloadProbe: reload,
    now: options.now,
    registry
  });

  const handlers = createConfigHandlers({
    enabled: options.enabled,
    space,
    ...(trial === null ? {} : { trial }),
    promotion,
    now: options.now
  });

  return succeed({
    enabled: options.enabled,
    registry,
    catalog,
    catalogs: [built.value.view],
    space,
    trial,
    promotion,
    reload,
    reload_declarations: declarations,
    write,
    write_read: writeRead,
    handlers
  });
}

/** Selector for the host whose root ids were bound at composition time. */
export function selectorForConfigSpace(composition: ConfigComposition): ConfigSpaceSelector {
  const first = composition.catalogs[0];
  if (first === undefined) {
    throw new Error("config composition has no catalog entry");
  }
  return first.selector;
}

/** Convenience for composition roots that need the readback path only. */
export async function captureConfigSpace(
  composition: ConfigComposition
): Promise<ConfigResult<ConfigSpaceSnapshot>> {
  return composition.space.capture(selectorForConfigSpace(composition));
}
