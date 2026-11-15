/** Codex compaction declaration (W10). Compaction is session-static; a new process is the honest reload channel. */
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
  layer_id: "user", root_kind: "user", root_id: "codex.user.home", relative_path: "config.toml", format: "toml"
});
const PROJECT_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "project", root_kind: "project", root_id: "codex.project.root", relative_path: ".codex/config.toml", format: "toml"
});

export const CODEX_COMPACTION_SPEC: CompactionSpecDeclaration = Object.freeze({
  schema_version: "rsi.compaction_spec/1" as const,
  host_id: "codex",
  config_space: "codex_config",
  layers: Object.freeze([USER_LAYER, PROJECT_LAYER]),
  field_paths: Object.freeze([
    { field_key: "compaction.thresholdTokens", layer_id: "user", pointer: "/model_auto_compact_token_limit" },
    { field_key: "compaction.thresholdPercent", layer_id: "user", pointer: "/model_post_turn_compact_threshold_percent" }
  ]),
  reload_kind: "unsupported" as const
});
