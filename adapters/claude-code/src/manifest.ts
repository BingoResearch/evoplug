/**
 * Claude Code adapter identity and source/binary pins (DD-HOST-001 manifest
 * row, DD-HOST-070 version table).
 *
 * The adapter id is assigned once per host adapter package and compiled to a
 * constant. The implementation hash follows
 * `sha256(JCS({schema_version:"rsi.adapter_manifest/1",adapter_id,
 * adapter_version,host_id,files:[{path,sha256}],toolchain}))` over UTF-8
 * sorted file entries; `manifest.ts` is excluded because it carries the value.
 * The file hashes are the checked-in source hashes recorded by the release
 * build; regenerating the adapter requires recomputing this constant.
 *
 * DD-HOST-070 records installed 2.1.304 with a documentation/SDK-types source
 * baseline and no fixed commit. `mapping=unmapped`, so no source-derived
 * capability is inherited by the installed version (DD-HOST-003). The closed
 * `HostVersionKind` set has no "docs" member, so the baseline is recorded as a
 * release-shaped pin with `source_commit=null`.
 */

import { canonicalHash, type Hash, type Id, type JsonValue } from "@evoplug/core";

import type { BinaryPin, HostId, SourcePin } from "./contract.js";

/** Assigned adapter id for the Claude Code adapter package. */
export const CLAUDE_ADAPTER_ID: Id<"adp"> = "adp:01K8Z5A2B3C4D5E6F7G8H9J0K2" as Id<"adp">;

/** Adapter package version; must equal `package.json.version`. */
export const CLAUDE_ADAPTER_VERSION = "0.0.0";

/** Host id served by this adapter. */
export const CLAUDE_HOST_ID: HostId = "claude-code";

/** Installed Claude Code version observed by the design. */
export const CLAUDE_HOST_VERSION = "2.1.326";

/** Declared host-version compatibility range (closed-loop design §8, G8). */
export const CLAUDE_SUPPORTED_RANGE = ">=2.1.304 <2.2.0";

/** Host versions this repository has actually exercised. */
export const CLAUDE_TESTED_VERSIONS: readonly string[] = Object.freeze(['2.1.326']);


/**
 * Documented install path. The location is machine-specific and is resolved
 * at runtime by attach/probe, so no build-machine path is recorded here.
 */
export const CLAUDE_INSTALL_PATH: string | null = null;

/** Source baseline label; the design records official docs and SDK types only. */
export const CLAUDE_SOURCE_BASELINE = "official-docs+sdk-types";

/** Build toolchain recorded in the adapter manifest. */
export const CLAUDE_TOOLCHAIN = "node@24.22.0;typescript@7.0.2";

/**
 * Source and binary pins. The source baseline has no commit and the installed
 * build is not cross-provable with it, so DD-HOST-070 records
 * `mapping=unmapped`; no source-derived capability is inherited.
 */
export const CLAUDE_VERSION_FACTS: {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly mapping: "unmapped";
} = Object.freeze({
  source_pin: Object.freeze({
    host_version: `${CLAUDE_SOURCE_BASELINE}@${CLAUDE_HOST_VERSION}`,
    host_version_kind: "release",
    source_commit: null
  }),
  binary_pin: Object.freeze({
    binary_version: CLAUDE_HOST_VERSION,
    binary_hash: null
  }),
  mapping: "unmapped"
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
export const CLAUDE_IMPLEMENTATION_FILES: readonly AdapterManifestFile[] = Object.freeze([
  { path: "runtime/confirm.ts", sha256: "sha256:a779b01d284079d5336143ee19d28a939c7d635890a6d50b1c389339de8f842b" },
  { path: "runtime/entry.ts", sha256: "sha256:34dd3b5b854dcad9383ebed1843286ea6fc1964cddf6997d82ab25e98b4d4fa8" },
  { path: "src/adapter.ts", sha256: "sha256:aa2f4f5bcf95523c5dac72792537351e5b6dac5a717025fc33895c7a35765df1" },
  { path: "src/capabilities.ts", sha256: "sha256:970fcd9e2fe55224e022c4c1fbeb83cd4c25ce022889b0ea48cb7b3563d94447" },
  { path: "src/compaction-spec.ts", sha256: "sha256:47000eedcaf431852253f0ba6f3cd5e6255497d269245de313a4fcf88731057a" },
  { path: "src/contract.ts", sha256: "sha256:46b6a1e7cf3b514a61cd793e601960abaf90ed9e8cda81110ca4f0c5898531e6" },
  { path: "src/descriptor.ts", sha256: "sha256:d871fd7a9f836fd396b4c140836bf693022a53270ed6356ed8fddbf6134cd564" },
  { path: "src/events.ts", sha256: "sha256:83eba57bf6b0f341682f4a527729759608936a784858482ec9afa99e745c1877" },
  { path: "src/facts.ts", sha256: "sha256:759aa1213a8f9ac311731bdde97a68d4e94b99660742956af9f8445d3be53c04" },
  { path: "src/generation-spec.ts", sha256: "sha256:f2fe6d7369188080d389b737b86baf255868b686b8b2a711fd7908e09a593538" },
  { path: "src/hook-identity.ts", sha256: "sha256:e9cb7034074155ea06116f44222568f9c8383e922a78202bc6810d57915ee2ba" },
  { path: "src/index.ts", sha256: "sha256:1d67c995387e3b4c767a8929dfe5e69e8ed64e7091ae664b4453abf9be6014d5" },
  { path: "src/node-types.d.ts", sha256: "sha256:f29ad01467238f4b0918f1d9480a4015134737b951f2de372bd825354b6d160a" },
  { path: "src/normalize.ts", sha256: "sha256:c2de9453724d8d8b4fd70cb52d74e10a61a075dbb78ba4941e79b57d6787392c" },
  { path: "src/payload.ts", sha256: "sha256:3274606c234ccbeaba20515203b9d124f18a955928b320c3bbea8bf59977673b" },
  { path: "src/probe-spec.ts", sha256: "sha256:bc8ac1423695dcc0d39e875b84979e90f9caf95c92579c1a56cd66fcbda13a20" },
  { path: "src/registration.ts", sha256: "sha256:6566e0bed68c1ccc54f7d68d45f230b8fa75b5984ba5e2a7a8bda9014df95d93" }
]);

/** Implementation hash of the checked-in adapter sources. */
export const CLAUDE_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: CLAUDE_ADAPTER_ID,
  adapter_version: CLAUDE_ADAPTER_VERSION,
  host_id: CLAUDE_HOST_ID,
  files: CLAUDE_IMPLEMENTATION_FILES,
  toolchain: CLAUDE_TOOLCHAIN
});
