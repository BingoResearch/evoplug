/** Step Code compaction declaration (W10). TOML file also carries MCP; writes are patched, never whole-file replaced. */
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
  layer_id: "user", root_kind: "user", root_id: "step.user.config_dir", relative_path: "config.toml", format: "toml"
});
const PROJECT_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "project", root_kind: "project", root_id: "step.project.root", relative_path: ".step/config.toml", format: "toml"
});

export const STEP_COMPACTION_SPEC: CompactionSpecDeclaration = Object.freeze({
  schema_version: "rsi.compaction_spec/1" as const,
  host_id: "step-code",
  config_space: "step_config",
  layers: Object.freeze([USER_LAYER, PROJECT_LAYER]),
  field_paths: Object.freeze([
    { field_key: "compaction.enabled", layer_id: "user", pointer: "/compaction/enabled" },
    { field_key: "compaction.reserveTokens", layer_id: "user", pointer: "/compaction/reserveTokens" },
    { field_key: "compaction.keepRecentTokens", layer_id: "user", pointer: "/compaction/keepRecentTokens" }
  ]),
  reload_kind: "unsupported" as const
});
