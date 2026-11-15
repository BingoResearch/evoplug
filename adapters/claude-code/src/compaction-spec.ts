/**
 * Claude Code compaction declaration (W10).
 *
 * `autoCompactWindow` is the only exposed numeric threshold. It is a token
 * window, so it maps to the canonical `compaction.thresholdTokens` class.
 * Whether a direct settings edit is hot-applied is officially unspecified;
 * only SDK reload evidence may promote it to `active`.
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

const USER_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "user", root_kind: "user", root_id: "claude.user.config_dir", relative_path: "settings.json", format: "json"
});
const PROJECT_LAYER: ConfigLayerTarget = Object.freeze({
  layer_id: "project", root_kind: "project", root_id: "claude.project.root", relative_path: ".claude/settings.json", format: "json"
});

export const CLAUDE_COMPACTION_SPEC: CompactionSpecDeclaration = Object.freeze({
  schema_version: "rsi.compaction_spec/1" as const,
  host_id: "claude-code",
  config_space: "claude_settings",
  layers: Object.freeze([USER_LAYER, PROJECT_LAYER]),
  field_paths: Object.freeze([
    { field_key: "compaction.thresholdTokens", layer_id: "user", pointer: "/autoCompactWindow" },
    { field_key: "compaction.auto", layer_id: "user", pointer: "/autoCompactEnabled" }
  ]),
  reload_kind: "sdk_reload" as const
});
