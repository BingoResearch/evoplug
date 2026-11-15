/**
 * Packaged `evolve attach` registration artifact (DD-FND-101, DD-FND-102).
 *
 * Codex discovers command hooks in `$CODEX_HOME/hooks.json` and the project
 * `.codex/hooks.json`. The parser accepts only `description` and `hooks` at the
 * top level, so both files are shared JSON merged in place:
 *
 *   {"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command",
 *     "command":"<node> <entry>","timeout_sec":30}]}]}}
 *
 * No registration marker is written to `hooks.json`: an extra `schema_version`
 * key makes Codex reject the whole file. The managed layer keeps its marker
 * block in `managed_hooks.json`, which is not the user hooks file.
 */

import {
  HOST_REGISTRATION_COMMAND_PLACEHOLDER,
  type HostRegistrationArtifact,
  type HostRegistrationArtifactEntry
} from "@evoplug/core/host";

import { CODEX_ADAPTER_ID, CODEX_ADAPTER_VERSION, CODEX_HOST_ID } from "./manifest.js";

/** Events from the DD-HOST-204 Codex binding table. */
const CODEX_HOOK_EVENTS: readonly string[] = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "PreCompact",
  "PostCompact"
]);

const COMMAND = HOST_REGISTRATION_COMMAND_PLACEHOLDER;

function registration(target: string): string {
  return JSON.stringify({
    schema_version: "rsi.host_registration/1",
    product: "evoplug",
    host_id: CODEX_HOST_ID,
    adapter_id: CODEX_ADAPTER_ID,
    target
  }) + "\n";
}

function hookEntries(): readonly HostRegistrationArtifactEntry[] {
  return CODEX_HOOK_EVENTS.map((event) => ({
    pointer: `/hooks/${event}`,
    value: {
      hooks: [{ type: "command", command: COMMAND, timeout_sec: 30 }]
    }
  }));
}

export const CODEX_REGISTRATION_ARTIFACT: HostRegistrationArtifact = Object.freeze({
  schema_version: "rsi.host_registration_artifact/1",
  adapter_id: CODEX_ADAPTER_ID,
  host_id: CODEX_HOST_ID,
  adapter_version: CODEX_ADAPTER_VERSION,
  default_mode: "exec",
  default_config_space: "user",
  targets: Object.freeze([
    Object.freeze({
      target_id: "codex.runtime.user",
      path_template: "$CODEX_HOME/hooks/evoplug",
      write_mode: "artifact_dir",
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "codex.runtime.project_trusted",
      path_template: "$PROJECT/.codex/hooks/evoplug",
      write_mode: "artifact_dir",
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "codex.runtime.project_untrusted",
      path_template: "$PROJECT/.codex/hooks/evoplug",
      write_mode: "artifact_dir",
      requires_trust: true,
      trust_state: "pending"
    }),
    Object.freeze({
      target_id: "codex.hooks.user",
      path_template: "$CODEX_HOME/hooks.json",
      write_mode: "json_merge",
      selector: "$CODEX_HOME/hooks/evoplug",
      entries: hookEntries(),
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "codex.hooks.project_trusted",
      path_template: "$PROJECT/.codex/hooks.json",
      write_mode: "json_merge",
      selector: "$PROJECT/.codex/hooks/evoplug",
      entries: hookEntries(),
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "codex.hooks.project_untrusted",
      path_template: "$PROJECT/.codex/hooks.json",
      write_mode: "json_merge",
      selector: "$PROJECT/.codex/hooks/evoplug",
      entries: hookEntries(),
      requires_trust: true,
      trust_state: "pending"
    }),
    Object.freeze({
      target_id: "codex.hooks.managed",
      path_template: "$CODEX_HOME/managed_hooks.json",
      content: registration("codex.hooks.managed"),
      write_mode: "managed_block",
      requires_trust: false,
      trust_state: "ready"
    })
  ])
});
