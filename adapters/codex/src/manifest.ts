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
  { path: "runtime/entry.ts", sha256: "sha256:0e579fd8219e0a580fe81ba1c3d6a6aa88eaa36cfeade38c6a616f56c6528d43" },
  { path: "src/adapter.ts", sha256: "sha256:d5d0dde8bdb6f3788bbd3025f7f6b42a018ed176b7421ddf7f4ab55deab60029" },
  { path: "src/capabilities.ts", sha256: "sha256:889f3c6d07cfc23d034134c43566ff3c4fdad435c956c503c346a4b78d990c96" },
  { path: "src/compaction-spec.ts", sha256: "sha256:341b245353eff6f7d52fd6e428e7ae39c6626ed32947c8fe22776620ba1285ed" },
  { path: "src/contract.ts", sha256: "sha256:9583f1d9ccb91b011c87c7557cae9e08c0f94b8f64d31096d9b63654fc230678" },
  { path: "src/descriptor.ts", sha256: "sha256:eb5a00ebaebd9040973d4a13bb4b3b8d7d5574c9c6d0348a03854c908c8f16bd" },
  { path: "src/events.ts", sha256: "sha256:67c80e633658b3d523f5fe411aa2207e2c51911411d9ca2a78843ba924746839" },
  { path: "src/facts.ts", sha256: "sha256:d60bf669ee53f4531b90eef011f1b95ac41300f8b1b22356808db9aba3de77bd" },
  { path: "src/generation-spec.ts", sha256: "sha256:6956ee7f2e2cbd2b9373881d62d64872847eb27d411b0676e95b7dac7c87684e" },
  { path: "src/index.ts", sha256: "sha256:c5cc604dcc9ba8940790ba13d03652d1901dff48e8d9c7d75498025c8eb259ed" },
  { path: "src/node-types.d.ts", sha256: "sha256:26b38a4d95365c04e233bd2edaa4c5ed5cb4d1a786df44a9f5799ef59277196d" },
  { path: "src/normalize.ts", sha256: "sha256:e9d55e0ddcfa859c37dbccdc4e9684392b2100f92ae7edfa03b4a26f4c80d0e9" },
  { path: "src/payload.ts", sha256: "sha256:67dfa09e3c1257d51001742baed96cd68f5aab59cd953f930cb7f8c3ffb684c2" },
  { path: "src/probe-spec.ts", sha256: "sha256:a3fe8caebb53eea817ef36dc5d0da667e530f2885cf5cf3cc46887a092c6961c" },
  { path: "src/registration.ts", sha256: "sha256:f708cc5952a186529bd627c90dbb2e0036542f498b485d1c0b241f02bac4f4c5" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const CODEX_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: CODEX_ADAPTER_ID,
  adapter_version: CODEX_ADAPTER_VERSION,
  host_id: CODEX_HOST_ID,
  files: CODEX_IMPLEMENTATION_FILES,
  toolchain: CODEX_TOOLCHAIN
});
