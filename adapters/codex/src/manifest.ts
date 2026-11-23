/**
 * Codex adapter identity and source/binary pins (DD-HOST-001 manifest row,
 * DD-HOST-040 version table).
 *
 * The adapter id is assigned once per host adapter package and compiled to a
 * constant. The implementation hash follows
 * `sha256(JCS({schema_version:"rsi.adapter_manifest/1",adapter_id,
 * adapter_version,host_id,files:[{path,sha256}],toolchain}))` over UTF-8
 * sorted file entries; `manifest.ts` is excluded because it carries the value.
 * The file hashes are the checked-in source hashes recorded by the release
 * build; regenerating the adapter requires recomputing this constant.
 *
 * DD-HOST-040 records source commit `e18a20d6…` (manifest 0.0.0) and installed
 * 0.160.1 separately with `mapping=unmapped`; the installed build cannot
 * inherit source-derived capability.
 */

import { canonicalHash, type Hash, type Id, type JsonValue } from "@evoplug/core";

import type { BinaryPin, HostId, SourcePin } from "./contract.js";

/** Assigned adapter id for the Codex adapter package. */
export const CODEX_ADAPTER_ID: Id<"adp"> = "adp:01K8Z5A2B3C4D5E6F7G8H9J0K1" as Id<"adp">;

/** Adapter package version; must equal `package.json.version`. */
export const CODEX_ADAPTER_VERSION = "0.0.0";

/** Host id served by this adapter. */
export const CODEX_HOST_ID: HostId = "codex";

/** Installed Codex version observed by the design. */
export const CODEX_HOST_VERSION = "0.160.1";

/** Declared host-version compatibility range (closed-loop design §8, G8). */
export const CODEX_SUPPORTED_RANGE = ">=0.160.1 <0.170.0";

/** Host versions this repository has actually exercised. */
export const CODEX_TESTED_VERSIONS: readonly string[] = Object.freeze(['0.160.1']);


/**
 * Documented install path. The location is machine-specific and is resolved
 * at runtime by attach/probe, so no build-machine path is recorded here.
 */
export const CODEX_INSTALL_PATH: string | null = null;

/** Source baseline commit from the Codex install/observation table. */
export const CODEX_SOURCE_COMMIT = "e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914";

/** Source baseline version string; the manifest records 0.0.0. */
export const CODEX_SOURCE_VERSION = "0.0.0";

/** Build toolchain recorded in the adapter manifest. */
export const CODEX_TOOLCHAIN = "node@24.22.0;typescript@7.0.2";

/**
 * Source and binary pins. The source commit and the installed binary are not
 * cross-provable, so DD-HOST-040 records `mapping=unmapped`; no source-derived
 * capability is inherited by the installed version (DD-HOST-003).
 */
export const CODEX_VERSION_FACTS: {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly mapping: "unmapped";
  readonly observed_probe_result: "blocked";
} = Object.freeze({
  source_pin: Object.freeze({
    host_version: `source:${CODEX_SOURCE_COMMIT}`,
    host_version_kind: "source_commit",
    source_commit: CODEX_SOURCE_COMMIT
  }),
  binary_pin: Object.freeze({
    binary_version: CODEX_HOST_VERSION,
    binary_hash: null
  }),
  mapping: "unmapped",
  observed_probe_result: "blocked"
});

/** One file entry of `rsi.adapter_manifest/1`. */
export interface AdapterManifestFile {
  readonly path: string;
  readonly sha256: Hash;
}

/** Input of the implementation-hash formula. */
export interface AdapterManifestInput {
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly host_id: HostId;
  readonly files: readonly AdapterManifestFile[];
  readonly toolchain: string;
}

/** `sha256(JCS({schema_version:"rsi.adapter_manifest/1",...}))`. */
export function computeImplementationHash(input: AdapterManifestInput): Hash {
  const files: JsonValue = input.files.map((file) => ({ path: file.path, sha256: file.sha256 }));
  return canonicalHash({
    schema_version: "rsi.adapter_manifest/1",
    adapter_id: input.adapter_id,
    adapter_version: input.adapter_version,
    host_id: input.host_id,
    files,
    toolchain: input.toolchain
  });
}

/**
 * Checked-in implementation files with their source SHA-256. Paths are UTF-8
 * sorted and relative to the adapter package root.
 */
export const CODEX_IMPLEMENTATION_FILES: readonly AdapterManifestFile[] = Object.freeze([
  { path: "runtime/confirm.ts", sha256: "sha256:aaff81f52e841189dbc340cfab1476f67abb75ddb90d7f681900cbe4f9be21ce" },
  { path: "runtime/entry.ts", sha256: "sha256:b03e6ab1fbd1eb0f4ab0f1c16f5403392053ef72d3d0cbbc823f508f9d26c75f" },
  { path: "src/adapter.ts", sha256: "sha256:d5d0dde8bdb6f3788bbd3025f7f6b42a018ed176b7421ddf7f4ab55deab60029" },
  { path: "src/capabilities.ts", sha256: "sha256:b2f2d429e4a9416749c7ad16f58ae28ed9c53eb4196e60fdf4cb4e9dbdb6aee7" },
  { path: "src/compaction-spec.ts", sha256: "sha256:341b245353eff6f7d52fd6e428e7ae39c6626ed32947c8fe22776620ba1285ed" },
  { path: "src/contract.ts", sha256: "sha256:46b6a1e7cf3b514a61cd793e601960abaf90ed9e8cda81110ca4f0c5898531e6" },
  { path: "src/descriptor.ts", sha256: "sha256:824bd5b6c55db874434919c4f404f32fa81934a054b7119051f2ef81702df8b5" },
  { path: "src/events.ts", sha256: "sha256:67c80e633658b3d523f5fe411aa2207e2c51911411d9ca2a78843ba924746839" },
  { path: "src/facts.ts", sha256: "sha256:d60bf669ee53f4531b90eef011f1b95ac41300f8b1b22356808db9aba3de77bd" },
  { path: "src/generation-spec.ts", sha256: "sha256:f49c81ae7981cec4cc39b2fc11f48d1a2056780fdd711f1e356a1baf87a7f080" },
  { path: "src/hook-identity.ts", sha256: "sha256:e9cb7034074155ea06116f44222568f9c8383e922a78202bc6810d57915ee2ba" },
  { path: "src/index.ts", sha256: "sha256:c5cc604dcc9ba8940790ba13d03652d1901dff48e8d9c7d75498025c8eb259ed" },
  { path: "src/node-types.d.ts", sha256: "sha256:26b38a4d95365c04e233bd2edaa4c5ed5cb4d1a786df44a9f5799ef59277196d" },
  { path: "src/normalize.ts", sha256: "sha256:1e53f84ac3e943ffedf26f775e3cdde048c27b188ce1326a4924f7f992da7e32" },
  { path: "src/payload.ts", sha256: "sha256:e72fc9bbd4aea8aeba4727171d78cfe1f363a1766955bbf43804b81a2c412eef" },
  { path: "src/probe-spec.ts", sha256: "sha256:a3fe8caebb53eea817ef36dc5d0da667e530f2885cf5cf3cc46887a092c6961c" },
  { path: "src/registration.ts", sha256: "sha256:da75a5789a443016f1dfdfc922a8f095912ef9c693247ad4bbc9af6ff4127fbb" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const CODEX_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: CODEX_ADAPTER_ID,
  adapter_version: CODEX_ADAPTER_VERSION,
  host_id: CODEX_HOST_ID,
  files: CODEX_IMPLEMENTATION_FILES,
  toolchain: CODEX_TOOLCHAIN
});
