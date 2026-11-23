/**
 * W10 default reload resolver registry.
 *
 * Reload channels are host-specific, so each packaged adapter owns its own
 * factory. This module is the single place the app maps an adapter declaration
 * to that factory; bootstrap and the persisted composition never branch on a
 * host id themselves.
 *
 * Only hosts with a real, in-process reload effect are registered. OpenCode
 * intentionally has no entry: its real behaviour re-reads the config file per
 * request and exposes no distinct reload event, so claiming one would fabricate
 * effect evidence. A host without a registered factory simply gets no reload
 * declaration and can never be promoted to `active` from this path.
 *
 * Every path is explicit: the native executable and workspace come from the
 * caller, and the config file is `<approved_root>/<declared relative_path>`.
 * Nothing scans the user's home or falls back to `process.cwd`.
 */

import type { HostId } from "@evoplug/core";
import type { ConfigResult, EpochMs } from "@evoplug/core/config";
import { configError, fail } from "@evoplug/core/config";
import {
  createPiSdkReloadResolver,
  type PiSdkReloadResolver
} from "@evoplug/adapter-pi";

import type {
  CompactionSpecDeclaration,
  ConfigReloadResolver
} from "./config-composition.js";

/** Explicit host-level inputs that no database row can supply. */
export interface PersistedReloadHostSource {
  /** Native executable of the selected, approved host binding. */
  readonly native_executable: string;
  /** Explicit workspace passed to the host SDK; never discovered. */
  readonly workspace: string;
}

/** A real reload channel with the adapter-declared kind beside it. */
export interface DefaultReloadResolver {
  readonly kind: "sdk_reload" | "new_process_parse" | "config_watch";
  readonly resolve: ConfigReloadResolver;
}

interface DefaultReloadResolverInput {
  readonly host_id: HostId;
  readonly spec: CompactionSpecDeclaration;
  readonly layer: CompactionSpecDeclaration["layers"][number];
  /** Live approved directory registered for this root. */
  readonly approved_root: string;
  readonly source: PersistedReloadHostSource;
  readonly now: () => EpochMs;
}

interface ReloadFactory {
  readonly kind: DefaultReloadResolver["kind"];
  readonly create: (
    input: DefaultReloadResolverInput & { readonly config_path: string }
  ) => ConfigResult<ConfigReloadResolver>;
}

function piFactory(
  input: DefaultReloadResolverInput & { readonly config_path: string }
): ConfigResult<PiSdkReloadResolver> {
  return createPiSdkReloadResolver({
    native_executable: input.source.native_executable,
    workspace: input.source.workspace,
    agent_dir: input.approved_root,
    config_path: input.config_path,
    layer_id: input.layer.layer_id,
    now: input.now
  });
}

/**
 * Registered adapter reload factories. Adding a host here is the only change
 * needed to give that adapter a default reload path.
 */
const RELOAD_FACTORIES: Partial<Record<HostId, ReloadFactory>> = {
  pi: { kind: "sdk_reload", create: piFactory }
};

/**
 * Builds the default resolver for one persisted host/layer.
 *
 * Returns `null` when the adapter has no real reload channel or the adapter
 * itself declares none. A host whose adapter claims a kind different from the
 * registered factory is rejected rather than silently dropped.
 */
export function createDefaultReloadResolver(
  input: DefaultReloadResolverInput
): ConfigResult<DefaultReloadResolver | null> {
  const factory = RELOAD_FACTORIES[input.host_id];
  if (factory === undefined) {
    return { ok: true, value: null };
  }
  if (input.spec.reload_kind === "unsupported") {
    return { ok: true, value: null };
  }
  if (input.spec.reload_kind !== factory.kind) {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        details: [{ key: "dimension", value: "reload_kind" }]
      })
    );
  }
  const configPath = resolveLayerPath(input.approved_root, input.layer.relative_path);
  if (configPath === null) {
    return fail(
      configError("E_CFG_AUTHORIZATION_SCOPE", {
        details: [{ key: "dimension", value: "approved_root" }]
      })
    );
  }
  const resolver = factory.create({ ...input, config_path: configPath });
  if (!resolver.ok) return resolver;
  return { ok: true, value: { kind: factory.kind, resolve: resolver.value } };
}

function resolveLayerPath(root: string, relativePath: string): string | null {
  if (root.length === 0 || relativePath.length === 0) return null;
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    return null;
  }
  return joinPath(root, relativePath);
}

function joinPath(root: string, relativePath: string): string {
  if (root.endsWith("/")) return `${root}${relativePath}`;
  return `${root}/${relativePath}`;
}
