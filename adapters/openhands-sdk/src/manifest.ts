/**
 * OpenHands SDK adapter identity and source/binary pins (DD-HOST-001 manifest
 * row, DD-HOST-060 version table).
 *
 * The adapter id is assigned once per host adapter package and compiled to a
 * constant. The implementation hash follows
 * `sha256(JCS({schema_version:"rsi.adapter_manifest/1",adapter_id,
 * adapter_version,host_id,files:[{path,sha256}],toolchain}))` over UTF-8
 * sorted file entries; `manifest.ts` is excluded because it carries the value.
 * The file hashes are the checked-in source hashes recorded by the release
 * build; regenerating the adapter requires recomputing this constant.
 *
 * DD-HOST-060 records source and install as SDK 1.56.0 at commit
 * `0996c339…` with `mapping=partial`: only `agent/base.py`,
 * `hooks/conversation_hooks.py` and `event/llm_convertible/message.py` were
 * byte-identical between source and install. No other file inherits that
 * mapping and the design prints no install path, so this module does not invent
 * one.
 */

import { canonicalHash, type Hash, type Id, type JsonValue } from "@evoplug/core";

import type { BinaryPin, HostId, SourcePin } from "./contract.js";

/** Assigned adapter id for the OpenHands SDK adapter package. */
export const OPENHANDS_ADAPTER_ID: Id<"adp"> = "adp:01K8Z4P0M2QH7V9X3B5C6D7E91" as Id<"adp">;

/** Adapter package version; must equal `package.json.version`. */
export const OPENHANDS_ADAPTER_VERSION = "0.0.0";

/** Host id served by this adapter. */
export const OPENHANDS_HOST_ID: HostId = "openhands-sdk";

/** Installed and source version observed by the design. */
export const OPENHANDS_HOST_VERSION = "1.56.0";

/** Declared host-version compatibility range (closed-loop design §8, G8). */
export const OPENHANDS_SUPPORTED_RANGE = ">=1.56.0 <2.0.0";

/** Host versions this repository has actually exercised. */
export const OPENHANDS_TESTED_VERSIONS: readonly string[] = Object.freeze(['1.56.0']);


/** Source baseline commit from the OpenHands install/observation table. */
export const OPENHANDS_SOURCE_COMMIT = "0996c33916c2a977ea9fe38deee660ff0e1389f2";

/** Source baseline version string. */
export const OPENHANDS_SOURCE_VERSION = "1.56.0";

/** Files whose installed bytes equal the source bytes (DD-HOST-060). */
export const OPENHANDS_MAPPED_FILES: readonly string[] = Object.freeze([
  "agent/base.py",
  "event/llm_convertible/message.py",
  "hooks/conversation_hooks.py"
]);

/** Build toolchain recorded in the adapter manifest. */
export const OPENHANDS_TOOLCHAIN = "node@24.22.0;typescript@7.0.2";

/**
 * Source and binary pins. Source and install are the same SDK version, but
 * only three files were verified byte-identical, so the mapping is `partial`
 * and never `exact`.
 */
export const OPENHANDS_VERSION_FACTS: {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly mapping: "partial";
  readonly observed_scope: "local_conversation_diagnostic";
  readonly mapped_files: readonly string[];
} = Object.freeze({
  source_pin: Object.freeze({
    host_version: OPENHANDS_SOURCE_VERSION,
    host_version_kind: "release",
    source_commit: OPENHANDS_SOURCE_COMMIT
  }),
  binary_pin: Object.freeze({
    binary_version: OPENHANDS_HOST_VERSION,
    binary_hash: null
  }),
  mapping: "partial",
  observed_scope: "local_conversation_diagnostic",
  mapped_files: OPENHANDS_MAPPED_FILES
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
export const OPENHANDS_IMPLEMENTATION_FILES: readonly AdapterManifestFile[] = Object.freeze([
  { path: "runtime/entry.ts", sha256: "sha256:b020ff551bd0d3a3797742340a0cb84ffe4e713a6d6745755874db404d50b41c" },
  { path: "runtime/generation_local_conversation.py", sha256: "sha256:de768daa0d269ec9f7640c3befa1df6f64c4319a11f6e5a8fc88650e78cd81ab" },
  { path: "src/adapter.ts", sha256: "sha256:74d6e679d8ba22f22ff26c3beb0cd00bff75feb5460dc19aa493c21bf3648023" },
  { path: "src/capabilities.ts", sha256: "sha256:3ca93f41cdf5b2d919f1be3a5380a81b2a50cd48d57613da51cac96328393f3e" },
  { path: "src/compaction-spec.ts", sha256: "sha256:9f9ed59b50488b162aa86be0e8e45b9e1b9786cf19c99abdddd0b91dfe5df477" },
  { path: "src/contract.ts", sha256: "sha256:46b6a1e7cf3b514a61cd793e601960abaf90ed9e8cda81110ca4f0c5898531e6" },
  { path: "src/descriptor.ts", sha256: "sha256:b4a6fd6b4f51e0225e032526f844f77017592836d86b40d0cf86d6098707d966" },
  { path: "src/events.ts", sha256: "sha256:e9b7175c23d047b5ea4a23ab25043060b7fbff342a5cafc8da126b185f109d8e" },
  { path: "src/facts.ts", sha256: "sha256:50d3a8d661b8d482581d6ff013a0401a5baa5423be195406ec3e74355421e611" },
  { path: "src/generation-spec.ts", sha256: "sha256:28f150f8bda2b7ce6daf905454f49a3c945582d5e85cf285f5376e84e1e98eec" },
  { path: "src/index.ts", sha256: "sha256:de69c183d0315fb7a5f9b9896c53ce9ac812133635faf62f5d7f5020f6db5e5f" },
  { path: "src/node-types.d.ts", sha256: "sha256:a9f160291e4b2cbac451924d14db9c25170ee564f4d71a3360dceadbcdcae6d7" },
  { path: "src/normalize.ts", sha256: "sha256:7ad3c06a23eab69e3a08e87a9b72f95e9744e9da4b32c2614a5a0e4ec4ac1bcd" },
  { path: "src/payload.ts", sha256: "sha256:b9ef9fee86f4aff7724909bc1dde81a4fdc72efae1df02dbba505a57aaa5ca7b" },
  { path: "src/probe-spec.ts", sha256: "sha256:e3bfd3da94208c2636a6b432d513d0e44c81ec99b1ae2fcf474e1870150ac0f3" },
  { path: "src/registration.ts", sha256: "sha256:7f969eef2231d276535a775db69d3fb944e46461bdcc16ba7757947e552b49ba" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const OPENHANDS_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: OPENHANDS_ADAPTER_ID,
  adapter_version: OPENHANDS_ADAPTER_VERSION,
  host_id: OPENHANDS_HOST_ID,
  files: OPENHANDS_IMPLEMENTATION_FILES,
  toolchain: OPENHANDS_TOOLCHAIN
});
