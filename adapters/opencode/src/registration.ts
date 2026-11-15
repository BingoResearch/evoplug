/**
 * Packaged `evolve attach` registration artifact (DD-FND-101, DD-FND-102).
 *
 * OpenCode 2.1.4 discovers `.js` modules in `$XDG_CONFIG_HOME/opencode/plugin`
 * and `.opencode/plugin`. Attach injects the single-file release artifact
 * `evoplug.js` there and keeps `manifest.json`/`config.json` in
 * `evoplug.runtime/` (DD-HOST-200.1, DD-HOST-204).
 */

import type { HostRegistrationArtifact } from "@evoplug/core/host";

import { OPENCODE_ADAPTER_ID, OPENCODE_ADAPTER_VERSION, OPENCODE_HOST_ID } from "./manifest.js";

export const OPENCODE_REGISTRATION_ARTIFACT: HostRegistrationArtifact = Object.freeze({
  schema_version: "rsi.host_registration_artifact/1",
  adapter_id: OPENCODE_ADAPTER_ID,
  host_id: OPENCODE_HOST_ID,
  adapter_version: OPENCODE_ADAPTER_VERSION,
  default_mode: "server",
  default_config_space: "user",
  targets: Object.freeze([
    Object.freeze({
      target_id: "opencode.plugin.user.directory",
      path_template: "$XDG_CONFIG_HOME/opencode/plugin",
      write_mode: "artifact_dir",
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "opencode.plugin.project.directory",
      path_template: "$PROJECT/.opencode/plugin",
      write_mode: "artifact_dir",
      requires_trust: true,
      trust_state: "ready"
    })
  ])
});
