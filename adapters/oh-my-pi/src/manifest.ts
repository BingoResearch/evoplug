/**
 * Oh My Pi adapter identity and source/binary pins (DD-HOST-001 manifest row,
 * DD-HOST-020 version table).
 *
 * The adapter id is assigned once per host adapter package and compiled to a
 * constant. The implementation hash follows
 * `sha256(JCS({schema_version:"rsi.adapter_manifest/1",adapter_id,
 * adapter_version,host_id,files:[{path,sha256}],toolchain}))` over UTF-8
 * sorted file entries; `manifest.ts` is excluded because it carries the value.
 * The file hashes are the checked-in source hashes recorded by the release
 * build; regenerating the adapter requires recomputing this constant.
 *
 * DD-HOST-020 records the isolated install as OMP 18.12.3 on Bun 1.4.3 and
 * `mapping=exact`, limited to that version and install path. The design text
 * does not print the install path, so this module does not invent one.
 */

import { canonicalHash, type Hash, type Id, type JsonValue } from "@evoplug/core";

import type { BinaryPin, HostId, SourcePin } from "./contract.js";

/** Assigned adapter id for the Oh My Pi adapter package. */
export const OMP_ADAPTER_ID: Id<"adp"> = "adp:01K8Z4P0M2QH7V9X3B5C6D7E90" as Id<"adp">;

/** Adapter package version; must equal `package.json.version`. */
export const OMP_ADAPTER_VERSION = "0.0.0";

/** Host id served by this adapter. */
export const OMP_HOST_ID: HostId = "oh-my-pi";

/** Installed and source version observed by the design. */
export const OMP_HOST_VERSION = "18.12.3";

/** Declared host-version compatibility range (closed-loop design §8, G8). */
export const OMP_SUPPORTED_RANGE = ">=18.12.3 <19.0.0";

/** Host versions this repository has actually exercised. */
export const OMP_TESTED_VERSIONS: readonly string[] = Object.freeze(['18.12.3']);


/** Source baseline from the OMP install/observation table. */
export const OMP_SOURCE_COMMIT = "2220e58146ebe31508e7a216242840d373e082d0";

/** Source baseline version string. */
export const OMP_SOURCE_VERSION = "18.12.3";

/** Host runtime recorded by the design (not the adapter build toolchain). */
export const OMP_HOST_RUNTIME = "bun@1.4.3";

/** Build toolchain recorded in the adapter manifest. */
export const OMP_TOOLCHAIN = "node@24.22.0;typescript@7.0.2";

/**
 * Source and binary pins. DD-HOST-020 records the source and the isolated
 * install at the same version, so the mapping is `exact` for that version and
 * install path only; no other version inherits these facts.
 */
export const OMP_VERSION_FACTS: {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly mapping: "exact";
  readonly observed_scope: "one_shot_print";
  readonly host_runtime: string;
} = Object.freeze({
  source_pin: Object.freeze({
    host_version: OMP_SOURCE_VERSION,
    host_version_kind: "release",
    source_commit: OMP_SOURCE_COMMIT
  }),
  binary_pin: Object.freeze({
    binary_version: OMP_HOST_VERSION,
    binary_hash: null
  }),
  mapping: "exact",
  observed_scope: "one_shot_print",
  host_runtime: OMP_HOST_RUNTIME
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
export const OMP_IMPLEMENTATION_FILES: readonly AdapterManifestFile[] = Object.freeze([
  { path: "runtime/entry.ts", sha256: "sha256:9800c23b48fb40860b4c22336f025a94194daa0f9d983d0b3255075a2b5f4e25" },
  { path: "src/adapter.ts", sha256: "sha256:42f050565221253032bc904e6e934df0decf4b839774b4abf5b4572c122366d2" },
  { path: "src/capabilities.ts", sha256: "sha256:6ec15c1fce2cf070c168a9b30a28db00ff9f8bcad4e40a1aae53af7b3d60954d" },
  { path: "src/compaction-spec.ts", sha256: "sha256:534d9999caca3ba7887173c3ca2d8324b6c40b0e5a2e363968f9272231d23a48" },
  { path: "src/contract.ts", sha256: "sha256:46b6a1e7cf3b514a61cd793e601960abaf90ed9e8cda81110ca4f0c5898531e6" },
  { path: "src/descriptor.ts", sha256: "sha256:573a84992db86503b0aeb01423dc4162f47505d8bed8a690ae306d4844ad850c" },
  { path: "src/events.ts", sha256: "sha256:6af132b4a1e1149f380286032e85d75f75610b19741bfbe3d17612e91d798c27" },
  { path: "src/facts.ts", sha256: "sha256:eba6e4f3eb94f363b59fd0ac8a6dfcf15d84c3adb414aa375a7650d7ac626a11" },
  { path: "src/generation-spec.ts", sha256: "sha256:8fe5af2cebe3968e4f84cee07572db75b3a9ce374d45be1896742b2584b2a7ee" },
  { path: "src/index.ts", sha256: "sha256:a0add0e664a0577d782cc96d4926c8d1f2bf04db3a302c22007c85f6d2564ca2" },
  { path: "src/node-types.d.ts", sha256: "sha256:430e1a652d653f3fd2898cb51e4309fdc698082cdd9b02ff56b61dbf3e1e88aa" },
  { path: "src/normalize.ts", sha256: "sha256:71f20719cbdc3429dd8d9fa318a81e46dab865540f5e6cc6844c7356d2041525" },
  { path: "src/payload.ts", sha256: "sha256:c98a74100ffff6b02317af6d824edb159c88618a761369ddffe6e14be03f4cd6" },
  { path: "src/probe-spec.ts", sha256: "sha256:e3d1cbd727f4686674966376198d1ad86a4a49026fc6815507fc685a26ef744c" },
  { path: "src/registration.ts", sha256: "sha256:dba21ad2a6c9a7cf34f205bee8707cb66937d15e58075a08d495a5db9573ec87" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const OMP_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: OMP_ADAPTER_ID,
  adapter_version: OMP_ADAPTER_VERSION,
  host_id: OMP_HOST_ID,
  files: OMP_IMPLEMENTATION_FILES,
  toolchain: OMP_TOOLCHAIN
});
