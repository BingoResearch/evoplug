/**
 * Pi compaction declaration (W10).
 *
 * Only the field keys in the taskbook compaction allowlist are declared.
 * `modelOverrides` is deliberately absent: it changes the selected model's
 * compaction behaviour and is hard-denied by the kernel.
 *
 * The declaration carries no root id or hash. Those come from live
 * registration and are bound by the glue that builds `ConfigSpaceCatalogEntry`.
 * `reload_kind="sdk_reload"` is a claim to verify against the real SDK; until
 * that H evidence exists the field stays `h_unverified`, never `active`.
 *
 * Field paths below are the real measured user-layer keys, confirmed by writing
 * the isolated file and reading `SettingsManager.getGlobalSettings()` back:
 * `/compaction/enabled`, `/compaction/reserveTokens`,
 * `/compaction/keepRecentTokens`. The project layer is not mapped because it was
 * not measured. The host version `mapping` stays `unmapped` (B-04): the source
 * commit and the installed binary are not cross-provable, so no exact mapping
 * or `active` status is declared from these paths alone.
 */

import type { CompactionFieldPath, ConfigLayerTarget } from "@evoplug/core/config";

export interface CompactionSpecDeclaration {
  readonly schema_version: "rsi.compaction_spec/1";
  readonly host_id: string;
  readonly config_space: string;
  readonly layers: readonly ConfigLayerTarget[];
  readonly field_paths: readonly CompactionFieldPath[];
  readonly reload_kind: "sdk_reload" | "new_process_parse" | "config_watch" | "unsupported";
}

const PI_USER_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "user",
  root_kind: "user",
  root_id: "pi.user.agent_dir",
  relative_path: "settings.json",
  format: "json"
});

const PI_PROJECT_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "project",
  root_kind: "project",
  root_id: "pi.project.root",
  relative_path: ".pi/settings.json",
  format: "json"
});

export const PI_COMPACTION_SPEC: CompactionSpecDeclaration = Object.freeze({
  schema_version: "rsi.compaction_spec/1" as const,
  host_id: "pi",
  config_space: "pi_settings",
  layers: Object.freeze([PI_USER_LAYER, PI_PROJECT_LAYER]),
  field_paths: Object.freeze([
    { field_key: "compaction.enabled", layer_id: "user", pointer: "/compaction/enabled" },
    { field_key: "compaction.reserveTokens", layer_id: "user", pointer: "/compaction/reserveTokens" },
    { field_key: "compaction.keepRecentTokens", layer_id: "user", pointer: "/compaction/keepRecentTokens" }
  ]),
  reload_kind: "sdk_reload" as const
});
