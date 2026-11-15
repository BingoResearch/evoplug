/**
 * OpenHands SDK compaction declaration (W10).
 *
 * The condenser is passed to `Agent` construction (or server settings); there
 * is no public settings file with compaction keys. Declaring none is the
 * honest shape: no trial may target an OpenHands compaction field, and the
 * reload channel is `unsupported`.
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

export const OPENHANDS_COMPACTION_SPEC: CompactionSpecDeclaration = Object.freeze({
  schema_version: "rsi.compaction_spec/1" as const,
  host_id: "openhands-sdk",
  config_space: "openhands_settings",
  layers: Object.freeze([]),
  field_paths: Object.freeze([]),
  reload_kind: "unsupported" as const
});
