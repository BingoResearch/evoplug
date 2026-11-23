/**
 * Packaged `evolve attach` registration artifact (DD-FND-101, DD-FND-102).
 *
 * Step Code extensions live in `<agentDir>/extensions/evoplug` and the
 * project `.stepcode` root. Attach injects the release runtime artifact and
 * writes the `index.js` discovery shim (DD-HOST-200.1, DD-HOST-204). The SDK
 * stdio hook remains a separate process-level target.
 */

import type { HostRegistrationArtifact } from "@evoplug/core/host";

import { STEP_ADAPTER_ID, STEP_ADAPTER_VERSION, STEP_HOST_ID } from "./manifest.js";

function stdioHook(): string {
  return JSON.stringify({
    schema_version: "rsi.host_registration/1",
    product: "evoplug",
    host_id: STEP_HOST_ID,
    adapter_id: STEP_ADAPTER_ID,
    target: "stepcode.stdio.hook"
  }) + "\n";
}

export const STEP_REGISTRATION_ARTIFACT: HostRegistrationArtifact = Object.freeze({
  schema_version: "rsi.host_registration_artifact/1",
  adapter_id: STEP_ADAPTER_ID,
  host_id: STEP_HOST_ID,
  adapter_version: STEP_ADAPTER_VERSION,
  default_mode: "print",
  default_config_space: "user",
  targets: Object.freeze([
    Object.freeze({
      target_id: "stepcode.extensions.user",
      path_template: "$STEP_CODING_AGENT_DIR/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "stepcode.extensions.project",
      path_template: "$PROJECT/.stepcode/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "stepcode.extensions.project_untrusted",
      path_template: "$PROJECT/.stepcode/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: true,
      trust_state: "pending"
    }),
    Object.freeze({
      target_id: "stepcode.stdio.hook",
      path_template: "$PROJECT/.stepcode/stdio/rsi-hook.json",
      content: stdioHook(),
      write_mode: "whole_file",
      requires_trust: true,
      trust_state: "ready"
    })
  ])
});
