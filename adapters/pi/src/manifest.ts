/**
 * Pi adapter identity and source/binary pins (DD-HOST-001 manifest row,
 * DD-HOST-010 version table).
 *
 * The adapter id is assigned once per host adapter package and compiled to a
 * constant. The implementation hash follows
 * `sha256(JCS({schema_version:"rsi.adapter_manifest/1",adapter_id,
 * adapter_version,host_id,files:[{path,sha256}],toolchain}))` over UTF-8
 * sorted file entries; `manifest.ts` is excluded because it carries the value.
 * The file hashes are the checked-in source hashes recorded by the release
 * build; regenerating the adapter requires recomputing this constant.
 */

import { canonicalHash, type Hash, type Id, type JsonValue } from "@evoplug/core";

import type { BinaryPin, HostId, SourcePin } from "./contract.js";

/** Assigned adapter id for the Pi adapter package. */
export const PI_ADAPTER_ID: Id<"adp"> = "adp:01K8Z4P0M2QH7V9X3B5C6D7E8F" as Id<"adp">;

/** Adapter package version; must equal `package.json.version`. */
export const PI_ADAPTER_VERSION = "0.0.0";

/** Host id served by this adapter. */
export const PI_HOST_ID: HostId = "pi";

/** Installed Pi version observed by the design (print mode only). */
export const PI_HOST_VERSION = "0.87.1";

/**
 * Documented install path. The location is machine-specific and is resolved
 * at runtime by attach/probe, so no build-machine path is recorded here.
 */
export const PI_INSTALL_PATH: string | null = null;

/** Source baseline from the Pi install/observation table. */
export const PI_SOURCE_COMMIT = "a731ba8b80ac56662b4ca7f09102f94447862d8c";

/** Source baseline version string. */
export const PI_SOURCE_VERSION = "1.3.0";

/** Build toolchain recorded in the adapter manifest. */
export const PI_TOOLCHAIN = "node@24.22.0;typescript@7.0.2";

/**
 * Source and binary pins. The source commit and the installed binary are not
 * cross-provable, so the design records `mapping=unmapped`; no source-derived
 * capability is inherited by the installed version (B-01..B-04).
 */
export const PI_VERSION_FACTS: {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly mapping: "unmapped";
  readonly observed_scope: "print";
} = Object.freeze({
  source_pin: Object.freeze({
    host_version: `source:${PI_SOURCE_COMMIT}`,
    host_version_kind: "source_commit",
    source_commit: PI_SOURCE_COMMIT
  }),
  binary_pin: Object.freeze({
    binary_version: PI_HOST_VERSION,
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
export const PI_IMPLEMENTATION_FILES: readonly AdapterManifestFile[] = Object.freeze([
  { path: "runtime/entry.ts", sha256: "sha256:dafa20abd5e8d151030b30cfd70d500f262de98dca5616c0f8e6a3fa0f36ea3d" },
  { path: "src/adapter.ts", sha256: "sha256:abdb116c9be2b8fdaa5def6ee21b0ce6f379b78342e82e868a90cf90ce28aa56" },
  { path: "src/capabilities.ts", sha256: "sha256:6f72d808fd73b433a059a558e4950a7214c0ce888eebe92c500c660a17bf6a5b" },
  { path: "src/compaction-spec.ts", sha256: "sha256:9b6b769bd0162c7b4847d26804b06a356d789c7a4c8e98505fa9daf6b17a9230" },
  { path: "src/contract.ts", sha256: "sha256:41a3f7c4d71d6627a376e21b7ea2c7ef5487eda853c7d70234531359ebb6d970" },
  { path: "src/descriptor.ts", sha256: "sha256:f06438ac9647c977bf49ebdb896bf6dc813f164abe479ec7c948fe275b890fb1" },
  { path: "src/events.ts", sha256: "sha256:be9f2592b112f8689e00881dbfc5c8bc37cd6fd4b03b34e958193918787cbfa6" },
  { path: "src/facts.ts", sha256: "sha256:04e19d70e864a3b61f94012f86f825a95c7d6442c85545f99cd0aa7c3645152c" },
  { path: "src/generation-spec.ts", sha256: "sha256:49c304104f756454614d34d4242837eaef61cb95e3b4fd4b94a654a8f1825dd6" },
  { path: "src/index.ts", sha256: "sha256:cd2d9fa76dff0e99498eacdb34a73d40384e7000e9fa4b28a6d2ea7f9644cefc" },
  { path: "src/node-types.d.ts", sha256: "sha256:0acd789e1e3dac19b201015783fbaeaa82a5f1da8a99c77fb66ec64653400487" },
  { path: "src/normalize.ts", sha256: "sha256:d578d82294311c7c7ab3bb481f866e36fa2533dd3294d57dabca92f205337b8c" },
  { path: "src/payload.ts", sha256: "sha256:c6699161009f30d9f2a0b9516cf75884aa92ec82737f6fb71977d2a2621f15b7" },
  { path: "src/probe-spec.ts", sha256: "sha256:926f2481eb4250d206dd4f1e0248834275d43fd8cfe1e5a6388483c108164b9e" },
  { path: "src/registration.ts", sha256: "sha256:281ca1a3008f7de7e06273854d93ad221c90bddd29b34ff0920d8b869ef74114" },
  { path: "src/reload-resolution.ts", sha256: "sha256:8ad77d173d79e35054c103e01a958243df40338374f39bfdb87d9292b4d02904" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const PI_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: PI_ADAPTER_ID,
  adapter_version: PI_ADAPTER_VERSION,
  host_id: PI_HOST_ID,
  files: PI_IMPLEMENTATION_FILES,
  toolchain: PI_TOOLCHAIN
});
