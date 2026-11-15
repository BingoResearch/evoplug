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
  { path: "runtime/entry.ts", sha256: "sha256:79d3562b0a03958cc5862822bf9d0c474c40d79df145f7479892e01059ce16ea" },
  { path: "src/adapter.ts", sha256: "sha256:42f050565221253032bc904e6e934df0decf4b839774b4abf5b4572c122366d2" },
  { path: "src/capabilities.ts", sha256: "sha256:90bff833d7fcc0c647ade7b894d9b5f163928fc5538064ed7468ca15cadb7d9b" },
  { path: "src/compaction-spec.ts", sha256: "sha256:534d9999caca3ba7887173c3ca2d8324b6c40b0e5a2e363968f9272231d23a48" },
  { path: "src/contract.ts", sha256: "sha256:1eba1b81d151a0fd5d1e62d8f34f48421ce3b5e414b7992c8f31851b9cf29c9b" },
  { path: "src/descriptor.ts", sha256: "sha256:bf719296682d54539e4b7335b300c523b0d90c7ac38e483889b82539a9f327b7" },
  { path: "src/events.ts", sha256: "sha256:76320f29b76a49c57d2b87b2a6b783cf1a893e7ab53a6ff4c8262331da304c9c" },
  { path: "src/facts.ts", sha256: "sha256:eba6e4f3eb94f363b59fd0ac8a6dfcf15d84c3adb414aa375a7650d7ac626a11" },
  { path: "src/generation-spec.ts", sha256: "sha256:e69e1e2b71bcf3cd517c107e370b632874c0948fb19e7b8e83032501238cd61f" },
  { path: "src/index.ts", sha256: "sha256:a0add0e664a0577d782cc96d4926c8d1f2bf04db3a302c22007c85f6d2564ca2" },
  { path: "src/node-types.d.ts", sha256: "sha256:430e1a652d653f3fd2898cb51e4309fdc698082cdd9b02ff56b61dbf3e1e88aa" },
  { path: "src/normalize.ts", sha256: "sha256:243657a391395f28c35d0bfcc69c5201fcd55ee8fd4861349cd10cfdc9ff554a" },
  { path: "src/payload.ts", sha256: "sha256:ca765716bbdc417302023abf330a1cfefb5ef08f5575ee16e7a759d54c3f49ee" },
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
