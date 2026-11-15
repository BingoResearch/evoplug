/**
 * Packaged `evolve attach` registration artifact (DD-FND-101, DD-FND-102).
 *
 * Pi extensions live under `<agentDir>/extensions/evoplug`; user scope is
 * `$PI_CODING_AGENT_DIR` (default `$HOME/.pi/agent`) and project scope is
 * `<cwd>/.pi`. Attach injects the release runtime artifact selected with
 * `--artifact-dir`; `index.js` is the shim Pi needs to discover a directory
 * extension (DD-HOST-200.1, DD-HOST-204).
 */

import type { HostRegistrationArtifact } from "@evoplug/core/host";

import { PI_ADAPTER_ID, PI_ADAPTER_VERSION, PI_HOST_ID } from "./manifest.js";

export const PI_REGISTRATION_ARTIFACT: HostRegistrationArtifact = Object.freeze({
  schema_version: "rsi.host_registration_artifact/1",
  adapter_id: PI_ADAPTER_ID,
  host_id: PI_HOST_ID,
  adapter_version: PI_ADAPTER_VERSION,
  default_mode: "print",
  default_config_space: "user",
  targets: Object.freeze([
    Object.freeze({
      target_id: "pi.extensions.user",
      path_template: "$PI_CODING_AGENT_DIR/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "pi.extensions.project",
      path_template: "$PROJECT/.pi/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "pi.extensions.project_untrusted",
      path_template: "$PROJECT/.pi/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: true,
      trust_state: "pending"
    })
  ])
});
