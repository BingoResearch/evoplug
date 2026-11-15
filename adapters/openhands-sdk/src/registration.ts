/**
 * Packaged `evolve attach` registration artifact (DD-FND-101, DD-FND-102).
 *
 * OpenHands discovers plugins in `.agents/plugins` and `.openhands/plugins`
 * relative to the active config space. Attach injects the release runtime
 * directory into `.openhands/plugins/evoplug` with the native plugin layout:
 *
 *   .claude-plugin/plugin.json   {"name":"evoplug"}
 *   hooks/hooks.json             {"hooks":{"<Event>":[{"matcher":"*",
 *                                  "hooks":[{"type":"command","command":...,
 *                                  "timeout":30}]}]}}
 *
 * The SDK loads the command through `/bin/sh`, so attach expands the command
 * placeholder with a POSIX-quoted `<node> <entry>` pair. `.agents` keeps a
 * static pointer because only one runtime artifact can be installed per
 * `(host, mode, config_space)`.
 */

import {
  HOST_REGISTRATION_COMMAND_PLACEHOLDER,
  type HostRegistrationArtifact,
  type HostRegistrationArtifactFile
} from "@evoplug/core/host";

import { OPENHANDS_ADAPTER_ID, OPENHANDS_ADAPTER_VERSION, OPENHANDS_HOST_ID } from "./manifest.js";

/** Events from the DD-HOST-204 OpenHands binding table (PascalCase). */
const OPENHANDS_HOOK_EVENTS: readonly string[] = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionStart",
  "SessionEnd"
]);

const COMMAND = HOST_REGISTRATION_COMMAND_PLACEHOLDER;

function registration(target: string): string {
  return JSON.stringify({
    schema_version: "rsi.host_registration/1",
    product: "evoplug",
    host_id: OPENHANDS_HOST_ID,
    adapter_id: OPENHANDS_ADAPTER_ID,
    target
  }) + "\n";
}

function hooksDocument(): string {
  const hooks: Record<string, unknown> = {};
  for (const event of OPENHANDS_HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: "*",
        hooks: [{ type: "command", command: COMMAND, timeout: 30 }]
      }
    ];
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

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

export const OPENHANDS_REGISTRATION_ARTIFACT: HostRegistrationArtifact = Object.freeze({
  schema_version: "rsi.host_registration_artifact/1",
  adapter_id: OPENHANDS_ADAPTER_ID,
  host_id: OPENHANDS_HOST_ID,
  adapter_version: OPENHANDS_ADAPTER_VERSION,
  default_mode: "local_conversation",
  default_config_space: "user_home",
  targets: Object.freeze([
    Object.freeze({
      target_id: "openhands.agents_plugins.user_home",
      path_template: "$HOME/.agents/plugins/rsi-registration.json",
      content: registration("openhands.agents_plugins.user_home"),
      write_mode: "whole_file",
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "openhands.openhands_plugins.user_home",
      path_template: "$HOME/.openhands/plugins/evoplug",
      write_mode: "artifact_dir",
      files: pluginFiles(),
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "openhands.agents_plugins.project",
      path_template: "$PROJECT/.agents/plugins/rsi-registration.json",
      content: registration("openhands.agents_plugins.project"),
      write_mode: "whole_file",
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "openhands.openhands_plugins.project",
      path_template: "$PROJECT/.openhands/plugins/evoplug",
      write_mode: "artifact_dir",
      files: pluginFiles(),
      requires_trust: true,
      trust_state: "ready"
    })
  ])
});
