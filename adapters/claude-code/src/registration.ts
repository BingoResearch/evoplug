/**
 * Packaged `evolve attach` registration artifact (DD-FND-101, DD-FND-102).
 *
 * Claude Code loads command hooks from settings files (user/project/local) and
 * from a plugin directory (`hooks/hooks.json` plus `.claude-plugin/plugin.json`).
 * Both forms use the same host-native shape:
 *
 *   {"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command",
 *     "command":"<node> <entry>","timeout":30}]}]}}
 *
 * The dynamic command is carried as `HOST_REGISTRATION_COMMAND_PLACEHOLDER`
 * and expanded by attach once the artifact root is known. Settings files are
 * shared with the user and are merged in place; unrelated keys and entries are
 * never replaced. The managed settings file stays a marker block: JSON cannot
 * carry the managed-block markers and Claude's managed schema is not a place
 * for a runtime command.
 *
 * Load rules (must be verified against the host, not inferred from file
 * existence): the settings json_merge targets are picked up by the normal
 * settings loader (reload or a new session). An arbitrary directory below
 * `<config>/plugins` is not a marketplace-installed plugin, so the plugin
 * target is loaded for one session with `claude --plugin-dir <root>`; a
 * production install goes through a marketplace. The environment probe uses
 * `--plugin-dir` and also checks the settings merge independently.
 */

import {
  HOST_REGISTRATION_COMMAND_PLACEHOLDER,
  type HostRegistrationArtifact,
  type HostRegistrationArtifactEntry,
  type HostRegistrationArtifactFile
} from "@evoplug/core/host";

import { CLAUDE_ADAPTER_ID, CLAUDE_ADAPTER_VERSION, CLAUDE_HOST_ID } from "./manifest.js";

/** Events from the DD-HOST-204 Claude binding table. */
const CLAUDE_HOOK_EVENTS: readonly string[] = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "Stop",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "SessionStart"
]);

const COMMAND = HOST_REGISTRATION_COMMAND_PLACEHOLDER;

function registration(target: string): string {
  return JSON.stringify({
    schema_version: "rsi.host_registration/1",
    product: "evoplug",
    host_id: CLAUDE_HOST_ID,
    adapter_id: CLAUDE_ADAPTER_ID,
    target
  }) + "\n";
}

function hookValue(): HostRegistrationArtifactEntry["value"] {
  return {
    matcher: "",
    hooks: [{ type: "command", command: COMMAND, timeout: 30 }]
  };
}

function hookEntries(): readonly HostRegistrationArtifactEntry[] {
  return CLAUDE_HOOK_EVENTS.map((event) => ({
    pointer: `/hooks/${event}`,
    value: hookValue()
  }));
}

function hooksDocument(): string {
  const hooks: Record<string, unknown> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [hookValue()];
  }
  return `${JSON.stringify({ description: "Evoplug runtime hooks", hooks }, null, 2)}\n`;
}

/**
 * Native plugin layout. `plugin.json` requires only a name; `hooks/hooks.json`
 * is the same host-native hooks object as a settings file, wrapped with an
 * optional description (verified on Claude Code 2.1.309; the design pin is 2.1.304 and newer compatible builds are reported explicitly).
 */
function pluginFiles(): readonly HostRegistrationArtifactFile[] {
  return Object.freeze([
    Object.freeze({
      relative_path: ".claude-plugin/plugin.json",
      content: `${JSON.stringify({ name: "evoplug" }, null, 2)}\n`,
      mode: 420 as const
    }),
    Object.freeze({
      relative_path: "hooks/hooks.json",
      content: hooksDocument(),
      mode: 420 as const
    })
  ]);
}

export const CLAUDE_REGISTRATION_ARTIFACT: HostRegistrationArtifact = Object.freeze({
  schema_version: "rsi.host_registration_artifact/1",
  adapter_id: CLAUDE_ADAPTER_ID,
  host_id: CLAUDE_HOST_ID,
  adapter_version: CLAUDE_ADAPTER_VERSION,
  default_mode: "print",
  default_config_space: "user",
  targets: Object.freeze([
    Object.freeze({
      target_id: "claude.hooks.user",
      path_template: "$CLAUDE_CONFIG_DIR/settings.json",
      write_mode: "json_merge",
      selector: "$CLAUDE_CONFIG_DIR/plugins/evoplug",
      entries: hookEntries(),
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "claude.hooks.project",
      path_template: "$PROJECT/.claude/settings.json",
      write_mode: "json_merge",
      selector: "$PROJECT/.claude/plugins/evoplug",
      entries: hookEntries(),
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "claude.hooks.local",
      path_template: "$PROJECT/.claude/settings.local.json",
      write_mode: "json_merge",
      selector: "$PROJECT/.claude/plugins/evoplug",
      entries: hookEntries(),
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "claude.hooks.managed",
      path_template: "$HOME/.claude/managed-settings.json",
      content: registration("claude.hooks.managed"),
      write_mode: "managed_block",
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "claude.plugin.user",
      path_template: "$CLAUDE_CONFIG_DIR/plugins/evoplug",
      write_mode: "artifact_dir",
      files: pluginFiles(),
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "claude.plugin.local_marketplace",
      path_template: "$PROJECT/.claude/plugins/evoplug",
      write_mode: "artifact_dir",
      files: pluginFiles(),
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "claude.sdk_package",
      path_template: "$HOME/.claude/sdk/rsi-registration.json",
      content: registration("claude.sdk_package"),
      write_mode: "whole_file",
      requires_trust: false,
      trust_state: "ready"
    })
  ])
});
