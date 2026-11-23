/**
 * Codex `AdapterDescriptor` (DD-HOST-001, DD-HOST-040, DD-HOST-110).
 *
 * The descriptor is built once from the Codex install/observation table,
 * frozen, and returned by `describe()`. Host core validates it again and
 * freezes the JCS snapshot before registration; this module therefore also
 * exposes the exact hash formulas so the adapter can verify its own request
 * inputs without creating a second schema.
 *
 * DD-HOST-040: `mapping=unmapped`; the installed 0.160.1 build cannot inherit
 * source-derived capability from commit `e18a20d6…`. Modes and config spaces
 * are the design's closed lists, not capability claims.
 */

import { descriptorToJson, computeDescriptorHash, validateAdapterDescriptor as validateSharedAdapterDescriptor } from "@evoplug/adapter-kit";

import { canonicalJsonText, hashUtf8, type Hash, type SourceRef } from "@evoplug/core";

import { CODEX_DECLARED_CAPABILITIES } from "./capabilities.js";
import type { AdapterDescriptor, ConfigSpace, HostMode, RegistrationTarget } from "./contract.js";
import { CODEX_EVENT_CONTRACTS, isCodexObservationEvent } from "./events.js";
import { CODEX_ADAPTER_ID, CODEX_ADAPTER_VERSION, CODEX_HOST_ID, CODEX_IMPLEMENTATION_HASH } from "./manifest.js";

/**
 * Modes Codex exposes to the adapter (DD-HOST-040): `interactive`, `exec`,
 * `app-server`, and `sdk` (SDK spawns the CLI). UTF-8 sorted.
 */
export const CODEX_SUPPORTED_MODES: readonly HostMode[] = Object.freeze([
  "app-server",
  "exec",
  "interactive",
  "sdk"
]);

/**
 * Config spaces Codex exposes: `$CODEX_HOME` (`user`), the trusted and
 * untrusted project layers, and the managed policy layer. Layer precedence is
 * low to high; a project layer is ineffective while the project is untrusted.
 */
export const CODEX_CONFIG_SPACES: readonly ConfigSpace[] = Object.freeze([
  "managed",
  "project_trusted",
  "project_untrusted",
  "user"
]);

/**
 * Registration targets from the Codex section, in design order.
 *
 * Hooks are discovered in `hooks.json` or config TOML at every layer; only
 * enabled and trusted/bypass handlers execute. `refresh_hooks` reloads hooks,
 * while session-static model and instruction state needs a new session, so
 * every target declares `load_boundary="reload"` for the hook artifact.
 * The untrusted project layer is declared but cannot take effect, so its
 * boundary stays `unknown`.
 */
export const CODEX_REGISTRATION_TARGETS: readonly RegistrationTarget[] = Object.freeze([
  Object.freeze({
    target_id: "codex.runtime.user",
    config_space: "user",
    scope: "user",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  /**
   * Profile-layered stdio MCP confirmation server (closure design §5.1,
   * appendix K.2). Codex has no managed-block form for `config.toml`, so the
   * channel lives in an evoplug-owned profile file and is loaded with
   * `codex -p evoplug-confirm`.
   */
  Object.freeze({
    target_id: "codex.mcp.confirm_profile",
    config_space: "user",
    scope: "user",
    kind: "extension",
    load_boundary: "new_session",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.runtime.project_trusted",
    config_space: "project_trusted",
    scope: "project",
    kind: "extension",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.runtime.project_untrusted",
    config_space: "project_untrusted",
    scope: "project",
    kind: "extension",
    load_boundary: "unknown",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.user",
    config_space: "user",
    scope: "user",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.project_trusted",
    config_space: "project_trusted",
    scope: "project",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.project_untrusted",
    config_space: "project_untrusted",
    scope: "project",
    kind: "hook_config",
    load_boundary: "unknown",
    marker_id: null
  }),
  Object.freeze({
    target_id: "codex.hooks.managed",
    config_space: "managed",
    scope: "managed",
    kind: "hook_config",
    load_boundary: "reload",
    marker_id: "codex/hooks"
  })
] satisfies readonly RegistrationTarget[]);

/** Frozen descriptor returned by `describe()`. */
export const CODEX_ADAPTER_DESCRIPTOR: AdapterDescriptor = Object.freeze({
  schema_version: "rsi.adapter_descriptor/1",
  adapter_id: CODEX_ADAPTER_ID,
  host_id: CODEX_HOST_ID,
  adapter_version: CODEX_ADAPTER_VERSION,
  implementation_hash: CODEX_IMPLEMENTATION_HASH,
  supported_modes: CODEX_SUPPORTED_MODES,
  config_spaces: CODEX_CONFIG_SPACES,
  registration_targets: CODEX_REGISTRATION_TARGETS,
  event_contracts: CODEX_EVENT_CONTRACTS,
  declared_capabilities: CODEX_DECLARED_CAPABILITIES
});

/** Returns the frozen descriptor. */
export function describeCodexAdapter(): AdapterDescriptor {
  return CODEX_ADAPTER_DESCRIPTOR;
}

/**
 * Construction path for a mode (DD-HOST-110 exact table, no aliases):
 * `interactive`/`exec` → `cli`; `app-server` → `app_server`; `sdk` → `sdk`.
 */
export function codexConstructionPathForMode(mode: HostMode): string | null {
  switch (mode) {
    case "interactive":
    case "exec":
      return "cli";
    case "app-server":
      return "app_server";
    case "sdk":
      return "sdk";
    default:
      return null;
  }
}

/** True when the mode is declared by this adapter. */
export function isCodexMode(mode: HostMode): boolean {
  return CODEX_SUPPORTED_MODES.includes(mode);
}

/** True when the config space is declared by this adapter. */
export function isCodexConfigSpace(config_space: ConfigSpace): boolean {
  return CODEX_CONFIG_SPACES.includes(config_space);
}

/** Looks up a declared registration target by id. */
export function codexRegistrationTarget(target_id: string): RegistrationTarget | null {
  return CODEX_REGISTRATION_TARGETS.find((target) => target.target_id === target_id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Exact JCS projections and hashes                                    */
/* ------------------------------------------------------------------ */

export {
  computeDescriptorHash,
  computeRegistrationHash,
  descriptorToJson,
  type RegistrationHashFields
} from "@evoplug/adapter-kit";

const DESCRIPTOR_REF_TEXT = canonicalJsonText(descriptorToJson(CODEX_ADAPTER_DESCRIPTOR));

/**
 * Content address of the frozen descriptor JSON.
 *
 * Every `HostAdapterError.detail_ref` this adapter returns points here when a
 * call has no more specific evidence reference. Host core already persists the
 * same descriptor as an `adapter_descriptor_snapshot`, so the reference stays
 * retrievable rather than pointing at invented evidence.
 */
export const CODEX_DESCRIPTOR_REF: SourceRef = `blob://${hashUtf8(DESCRIPTOR_REF_TEXT)}#bytes=0-${String(
  new TextEncoder().encode(DESCRIPTOR_REF_TEXT).byteLength
)}` as SourceRef;

/* ------------------------------------------------------------------ */
/* Descriptor validation (DD-HOST-001 producer table)                  */
/* ------------------------------------------------------------------ */

/** Validates a descriptor against the DD-HOST-001 producer table. */
export function validateAdapterDescriptor(descriptor: AdapterDescriptor): readonly string[] {
  return validateSharedAdapterDescriptor(descriptor, isCodexObservationEvent);
}

/** Frozen descriptor hash reused by registration-hash verification. */
export const CODEX_DESCRIPTOR_HASH: Hash = computeDescriptorHash(CODEX_ADAPTER_DESCRIPTOR);
