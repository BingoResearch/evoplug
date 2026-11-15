/**
 * Packaged host registration artifact (DD-FND-101, DD-FND-102).
 *
 * Each adapter package ships one artifact describing how its declared
 * `RegistrationTarget`s map to concrete host paths and managed content. The
 * kernel never guesses a host path: an artifact entry that is absent is a
 * typed error, not an empty registration.
 *
 * Path templates support only the closed DD-HOST-205 variables `$HOME`,
 * `$PROJECT`, `$XDG_CONFIG_HOME`, `$CODEX_HOME`, `$PI_CODING_AGENT_DIR`,
 * `$STEP_CODING_AGENT_DIR`, `$OMP_PROFILE`, `$CLAUDE_CONFIG_DIR` and
 * `$OH_PERSISTENCE_DIR`; anything else is rejected by the compose-root
 * resolver.
 */

import type { HostId } from "../generated/host-vocabulary.js";
import type { JsonValue } from "../json.js";
import type { ConfigSpace, HostMode } from "./types.js";

export const HOST_REGISTRATION_ARTIFACT_SCHEMA = "rsi.host_registration_artifact/1" as const;

/**
 * Command placeholder expanded by `evolve attach`.
 *
 * Registration artifacts cannot know the installed Node executable or the
 * artifact root until attach resolves the config-space path. Native hook
 * payloads therefore carry this token in every dynamic `command` string; the
 * compose-root registry replaces it with a POSIX-shell-quoted
 * `<node> <artifact-root>/<entry>` command. It is not a host field and never
 * reaches a host file.
 */
export const HOST_REGISTRATION_COMMAND_PLACEHOLDER = "{{evoplug_command}}" as const;

/** One file of an `artifact_dir` target. Modes are `0600` (384) or `0644` (420). */
export interface HostRegistrationArtifactFile {
  /** Relative path below the artifact root; no absolute path, `..` or NUL. */
  readonly relative_path: string;
  readonly content: string;
  readonly mode: 384 | 420;
}

/**
 * One entry inserted into a shared host JSON file by `json_merge`.
 *
 * `pointer` is an RFC 6901 pointer to the array that owns the entry and
 * `value` is the host-native entry object. The entry is product-owned when one
 * of its `command` strings contains the artifact root selector.
 */
export interface HostRegistrationArtifactEntry {
  readonly pointer: string;
  readonly value: JsonValue;
}

export interface HostRegistrationTargetArtifact {
  /** Must match a `registration_targets[].target_id` of the same descriptor. */
  readonly target_id: string;
  /**
   * Absolute path or a path starting with a supported variable. For
   * `artifact_dir` this is the primary host path (the artifact root).
   */
  readonly path_template: string;
  /** Block body (managed_block) or the complete file (whole_file). */
  readonly content?: string;
  readonly write_mode: "managed_block" | "whole_file" | "artifact_dir" | "json_merge";
  /** Artifact root; required for `artifact_dir`, defaults to `path_template`. */
  readonly root_path?: string;
  /**
   * Runtime artifact members. Static artifacts leave this empty: attach
   * injects the files of the release artifact selected by `--artifact-dir`.
   */
  readonly files?: readonly HostRegistrationArtifactFile[];
  /**
   * Relative path of a host-discovery shim generated for `artifact_dir`.
   *
   * Some hosts only load an extension directory when it contains a known
   * entry file (`index.js`). The shim re-exports the release artifact entry and
   * is written next to it, before `manifest.json` and `config.json`.
   */
  readonly discovery_entry?: string;
  /** Artifact root realpath used to own `json_merge` command entries. */
  readonly selector?: string;
  /** Entries added by `json_merge`. */
  readonly entries?: readonly HostRegistrationArtifactEntry[];
  readonly requires_trust: boolean;
  readonly trust_state: "ready" | "pending" | "unknown";
}

export interface HostRegistrationArtifact {
  readonly schema_version: typeof HOST_REGISTRATION_ARTIFACT_SCHEMA;
  readonly adapter_id: string;
  readonly host_id: HostId;
  readonly adapter_version: string;
  /** Mode used by `evolve attach <host>` when the CLI has no `--mode`. */
  readonly default_mode: HostMode;
  /** Config space used when the CLI has no `--config-space`. */
  readonly default_config_space: ConfigSpace;
  readonly targets: readonly HostRegistrationTargetArtifact[];
}
