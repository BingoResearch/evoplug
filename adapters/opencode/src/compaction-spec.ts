/** OpenCode compaction declaration (W10). Watcher reload, then verify the next request. */
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
  layer_id: "user", root_kind: "user", root_id: "opencode.user.config_dir", relative_path: "opencode.json", format: "json"
});
const PROJECT_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "project", root_kind: "project", root_id: "opencode.project.root", relative_path: "opencode.json", format: "json"
});

export const OPENCODE_COMPACTION_SPEC: CompactionSpecDeclaration = Object.freeze({
  schema_version: "rsi.compaction_spec/1" as const,
  host_id: "opencode",
  config_space: "opencode_config",
  layers: Object.freeze([USER_LAYER, PROJECT_LAYER]),
  field_paths: Object.freeze([
    { field_key: "compaction.auto", layer_id: "user", pointer: "/compaction/auto" },
    { field_key: "compaction.keep.tokens", layer_id: "user", pointer: "/compaction/keep/tokens" },
    { field_key: "compaction.buffer", layer_id: "user", pointer: "/compaction/buffer" }
  ]),
  reload_kind: "config_watch" as const
});
