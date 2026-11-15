/** oh-my-pi compaction declaration (W10). Token and percent thresholds are paired. */
import type { CompactionFieldPath, ConfigLayerTarget } from "@evoplug/core/config";

export interface CompactionSpecDeclaration {
  readonly schema_version: "rsi.compaction_spec/1";
  readonly host_id: string;
  readonly config_space: string;
  readonly layers: readonly ConfigLayerTarget[];
  readonly field_paths: readonly CompactionFieldPath[];
  readonly reload_kind: "sdk_reload" | "new_process_parse" | "config_watch" | "unsupported";
}

const USER_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "user", root_kind: "user", root_id: "omp.user.config_dir", relative_path: "config.yml", format: "yaml"
});
const PROJECT_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "project", root_kind: "project", root_id: "omp.project.root", relative_path: ".omp/config.yml", format: "yaml"
});

export const OMP_COMPACTION_SPEC: CompactionSpecDeclaration = Object.freeze({
  schema_version: "rsi.compaction_spec/1" as const,
  host_id: "oh-my-pi",
  config_space: "omp_settings",
  layers: Object.freeze([USER_LAYER, PROJECT_LAYER]),
  field_paths: Object.freeze([
    { field_key: "compaction.enabled", layer_id: "user", pointer: "/compaction/enabled" },
    { field_key: "compaction.reserveTokens", layer_id: "user", pointer: "/compaction/reserveTokens" },
    { field_key: "compaction.keepRecentTokens", layer_id: "user", pointer: "/compaction/keepRecentTokens" },
    { field_key: "compaction.thresholdTokens", layer_id: "user", pointer: "/compaction/thresholdTokens" },
    { field_key: "compaction.thresholdPercent", layer_id: "user", pointer: "/compaction/thresholdPercent" }
  ]),
  reload_kind: "config_watch" as const
});
