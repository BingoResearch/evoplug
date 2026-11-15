/**
 * Step Code adapter identity and source/binary pins (DD-HOST-001 manifest row,
 * DD-HOST-030 version table).
 *
 * The adapter id is assigned once per host adapter package and compiled to a
 * constant. The implementation hash follows
 * `sha256(JCS({schema_version:"rsi.adapter_manifest/1",adapter_id,
 * adapter_version,host_id,files:[{path,sha256}],toolchain}))` over UTF-8
 * sorted file entries; `manifest.ts` is excluded because it carries the value.
 * The file hashes are the checked-in source hashes recorded by the release
 * build; regenerating the adapter requires recomputing this constant.
 *
 * DD-HOST-030 records the installed official binary 0.1.5 with an archive
 * SHA-256 but no binary-to-source-commit proof, so `mapping=unmapped`. The
 * archive digest is not a binary digest: `binary_pin.binary_hash` stays `null`
 * and the archive digest is exported separately.
 */

import { canonicalHash, type Hash, type Id, type JsonValue } from "@evoplug/core";

import type { BinaryPin, HostId, SourcePin } from "./contract.js";

/** Assigned adapter id for the Step Code adapter package. */
export const STEP_ADAPTER_ID: Id<"adp"> = "adp:01K8Z4P0M2QH7V9X3B5C6D7E9A" as Id<"adp">;

/** Adapter package version; must equal `package.json.version`. */
export const STEP_ADAPTER_VERSION = "0.0.0";

/** Host id served by this adapter. */
export const STEP_HOST_ID: HostId = "step-code";

/** Installed official Step Code binary version observed by the design. */
export const STEP_HOST_VERSION = "0.1.5";

/**
 * Documented install path. DD-HOST-030 records the version and the archive
 * digest but not an install path, so no path is invented here.
 */
export const STEP_INSTALL_PATH: string | null = null;

/** Source baseline version from the Step Code install/observation table. */
export const STEP_SOURCE_VERSION = "0.84.4";

/** Source baseline commit from the Step Code install/observation table. */
export const STEP_SOURCE_COMMIT = "e08c6dd21310e75b296597d22910094fc786ccd6";

/**
 * Release archive SHA-256 recorded by DD-HOST-030. This is the archive digest,
 * not a binary digest, and it is therefore not used as `binary_hash`.
 */
export const STEP_ARCHIVE_SHA256: Hash =
  "sha256:27192ed3f1e70e5f631d975db7a614bf5759ae88931dd7292331d0b2081dec87";

/** Build toolchain recorded in the adapter manifest. */
export const STEP_TOOLCHAIN = "node@24.22.0;typescript@7.0.2";

/**
 * Source and binary pins. The source commit and the installed binary are not
 * cross-provable, so the design records `mapping=unmapped`; no source-derived
 * capability is inherited by the installed version (DD-HOST-003).
 */
export const STEP_VERSION_FACTS: {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly mapping: "unmapped";
  readonly observed_scope: "print";
} = Object.freeze({
  source_pin: Object.freeze({
    host_version: `source:${STEP_SOURCE_COMMIT}`,
    host_version_kind: "source_commit",
    source_commit: STEP_SOURCE_COMMIT
  }),
  binary_pin: Object.freeze({
    binary_version: STEP_HOST_VERSION,
    binary_hash: null
  }),
  mapping: "unmapped",
  observed_scope: "print"
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
export const STEP_IMPLEMENTATION_FILES: readonly AdapterManifestFile[] = Object.freeze([
  { path: "runtime/entry.ts", sha256: "sha256:a1a44da6f33e61958b5dd28a1426393cba698abc210553b85bfd3ca3a6612e8a" },
  { path: "src/adapter.ts", sha256: "sha256:fe56f6f0da2bb8e19ded20e5692887d5cd61095366b425857a9780d6e4b16bd6" },
  { path: "src/capabilities.ts", sha256: "sha256:0a1fa02823e7488efda21becbca25e29e17ba4d735e0151f8b61aaf9e2376bd4" },
  { path: "src/compaction-spec.ts", sha256: "sha256:2decfde42b8a91887f9dbe6ea696d8ff850f41f432f076f2ec1c86d9057441d7" },
  { path: "src/contract.ts", sha256: "sha256:e71982d3dddff6e5503cef56337dfed4959d07033f0f3a42f5bf6837bef340ca" },
  { path: "src/descriptor.ts", sha256: "sha256:afe0d9e0444667468531a8b5c90df9713bdcf8004cfd5f20ca69c139989cd778" },
  { path: "src/events.ts", sha256: "sha256:3e2f2b47ab99d0a1e79176c3e9f33467ca662a4ea7ae376930f55916ca1f8935" },
  { path: "src/facts.ts", sha256: "sha256:6e4c6fd850d99ee7402810392ce045e07cd0f49325a3feebbfaa004b7c4b5f0a" },
  { path: "src/generation-spec.ts", sha256: "sha256:4296651ab643f16a88a260c8b5f931b7b97c6622e868544d5da6086699359324" },
  { path: "src/index.ts", sha256: "sha256:755e45db117c12d329afe0c7f778d107d525577ce8f2946ab14c68e079d66165" },
  { path: "src/node-types.d.ts", sha256: "sha256:d727842c89bbaca4ae2f90f13a6e122e4ed215748896e69af69803b960110a34" },
  { path: "src/normalize.ts", sha256: "sha256:6ab10c6f91ba50370515287c4337a98029fb43e19849b720ea4a4c6514fac47d" },
  { path: "src/payload.ts", sha256: "sha256:4513f71ef938fee05ff7d09334dc25a32e06589dd11c6cc4bd819d0e1aa6c65a" },
  { path: "src/probe-spec.ts", sha256: "sha256:3a5ead833047bf10945a6d0dac46ef5bb09fb0f79e73f1c792f28eda920296fe" },
  { path: "src/registration.ts", sha256: "sha256:0e4e965b44f5ec17845d9255f739c81fb8f3be73c034bd5e7e8ef12fd8086feb" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const STEP_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: STEP_ADAPTER_ID,
  adapter_version: STEP_ADAPTER_VERSION,
  host_id: STEP_HOST_ID,
  files: STEP_IMPLEMENTATION_FILES,
  toolchain: STEP_TOOLCHAIN
});
