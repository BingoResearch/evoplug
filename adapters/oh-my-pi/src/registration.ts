/**
 * Packaged `evolve attach` registration artifact (DD-FND-101, DD-FND-102).
 *
 * Oh My Pi discovers extensions in `<agentDir>/extensions` and the project
 * `.omp`/Pi-compatible roots. Attach injects the release runtime artifact;
 * `index.js` is the directory-discovery shim (DD-HOST-200.1, DD-HOST-204).
 */

import type { HostRegistrationArtifact } from "@evoplug/core/host";

import { OMP_ADAPTER_ID, OMP_ADAPTER_VERSION, OMP_HOST_ID } from "./manifest.js";

export const OMP_REGISTRATION_ARTIFACT: HostRegistrationArtifact = Object.freeze({
  schema_version: "rsi.host_registration_artifact/1",
  adapter_id: OMP_ADAPTER_ID,
  host_id: OMP_HOST_ID,
  adapter_version: OMP_ADAPTER_VERSION,
  default_mode: "print",
  default_config_space: "user",
  targets: Object.freeze([
    Object.freeze({
      target_id: "omp.extensions.user",
      path_template: "$OMP_PROFILE/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: false,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "omp.extensions.project",
      path_template: "$PROJECT/.omp/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: true,
      trust_state: "ready"
    }),
    Object.freeze({
      target_id: "omp.extensions.pi_compat",
      path_template: "$PROJECT/.pi/extensions/evoplug",
      write_mode: "artifact_dir",
      discovery_entry: "index.js",
      requires_trust: true,
      trust_state: "ready"
    })
  ])
});
