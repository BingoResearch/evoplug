/**
 * OpenCode adapter identity and source/binary pins (DD-HOST-001 manifest row,
 * DD-HOST-050 version table).
 *
 * The adapter id is assigned once per host adapter package and compiled to a
 * constant. The implementation hash follows
 * `sha256(JCS({schema_version:"rsi.adapter_manifest/1",adapter_id,
 * adapter_version,host_id,files:[{path,sha256}],toolchain}))` over UTF-8
 * sorted file entries; `manifest.ts` is excluded because it carries the value.
 *
 * DD-HOST-050 keeps two version facts apart: source core/server 2.1.0 at
 * commit `19b12707…` and the installed 2.1.4 binary. They are never merged
 * into one pin and `mapping=unmapped`, so no capability is inherited across
 * the boundary (DD-HOST-003, DD-HOST-100).
 */

import { canonicalHash, type Hash, type Id, type JsonValue } from "@evoplug/core";

import type { BinaryPin, HostId, SourcePin } from "./contract.js";

/** Assigned adapter id for the OpenCode adapter package. */
export const OPENCODE_ADAPTER_ID: Id<"adp"> = "adp:01K8Z4P0M2QH7V9X3B5C6D7E8G" as Id<"adp">;

/** Adapter package version; must equal `package.json.version`. */
export const OPENCODE_ADAPTER_VERSION = "0.0.0";

/** Host id served by this adapter. */
export const OPENCODE_HOST_ID: HostId = "opencode";

/** Installed OpenCode version observed by the design. */
export const OPENCODE_HOST_VERSION = "2.1.4";

/** Declared host-version compatibility range (closed-loop design §8, G8). */
export const OPENCODE_SUPPORTED_RANGE = ">=2.1.4 <3.0.0";

/** Host versions this repository has actually exercised. */
export const OPENCODE_TESTED_VERSIONS: readonly string[] = Object.freeze(['2.1.4']);


/**
 * Documented install path. The location is machine-specific and is resolved
 * at runtime by attach/probe, so no build-machine path is recorded here.
 */
export const OPENCODE_INSTALL_PATH: string | null = null;

/** Source baseline version (core/server). */
export const OPENCODE_SOURCE_VERSION = "2.1.0";

/** Source baseline commit from the OpenCode install/observation table. */
export const OPENCODE_SOURCE_COMMIT = "19b12707cf8dda9b419566eab8d05f6ce03a41e3";

/**
 * Host version recorded on event drafts.
 *
 * The events are produced by the installed 2.1.4 plugin runtime (the server
 * plugin sees `chat.message`, tool and compaction hooks; the TUI companion is
 * a second process). The 2.1.0 source baseline remains a separate pin for the
 * V2 Effect surface, but a draft that claims 2.1.0 while it was observed by
 * the 2.1.4 binary makes the review snapshot's host binding disagree with the
 * installed host contract, so generation selection fails with E_CONFLICT.
 */
export const OPENCODE_EVENT_HOST_VERSION: string = OPENCODE_HOST_VERSION;

/** Build toolchain recorded in the adapter manifest. */
export const OPENCODE_TOOLCHAIN = "node@24.22.0;typescript@7.0.2";

/**
 * Source and binary pins. The source commit and the installed binary are not
 * cross-provable, so the design records `mapping=unmapped`; no source-derived
 * capability is inherited by the installed version (DD-HOST-100).
 */
export const OPENCODE_VERSION_FACTS: {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly mapping: "unmapped";
  readonly observed_scope: "source_2.1.0_static";
} = Object.freeze({
  source_pin: Object.freeze({
    host_version: OPENCODE_SOURCE_VERSION,
    host_version_kind: "source_commit",
    source_commit: OPENCODE_SOURCE_COMMIT
  }),
  binary_pin: Object.freeze({
    binary_version: OPENCODE_HOST_VERSION,
    binary_hash: null
  }),
  mapping: "unmapped",
  observed_scope: "source_2.1.0_static"
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
export const OPENCODE_IMPLEMENTATION_FILES: readonly AdapterManifestFile[] = Object.freeze([
  { path: "runtime/entry.ts", sha256: "sha256:aebd683d2ec92f1d4748d232863c08723cd4da63dcebe4e41a5afec25720c82d" },
  { path: "src/adapter.ts", sha256: "sha256:c2d4a771153f0906c4fde015098660f2c8dfa23cb37ce16af7cb84201106261e" },
  { path: "src/capabilities.ts", sha256: "sha256:92bfb99a7f7542baf8e45ad3c91b2aa1e45a7d3ff30c189c7e584d3aae1f10ef" },
  { path: "src/compaction-spec.ts", sha256: "sha256:07c5f22a41261f84ca36263c8080ecd88f2dc17ebd8ad79e1e111c8629a821eb" },
  { path: "src/contract.ts", sha256: "sha256:46b6a1e7cf3b514a61cd793e601960abaf90ed9e8cda81110ca4f0c5898531e6" },
  { path: "src/descriptor.ts", sha256: "sha256:4c0b706298582b5c18538b3cd871615490126e45033170573bd8c1d383e6d203" },
  { path: "src/events.ts", sha256: "sha256:2b4e38558e5b9a3f3d5b56286df2e86a43a87621b9c6fbca580ee0b80feffa87" },
  { path: "src/facts.ts", sha256: "sha256:342038b5c8dbe4ed699a3a70e87b3b7331d789db025030973a86fccc87666e56" },
  { path: "src/generation-output.ts", sha256: "sha256:d2f3ae6c7c3207a311275ee01c8c6aae17aa00ffdbd1b7497fffceeed6e16789" },
  { path: "src/generation-spec.ts", sha256: "sha256:e34c1046b07aeb47a403fc61ccb23843cd177e187abbedf237cea8bb73f02899" },
  { path: "src/generation.ts", sha256: "sha256:523626e93113917db5fc056bfa72494a5aa819de964c4eccf8d185ba0467bffe" },
  { path: "src/index.ts", sha256: "sha256:799c6cf753cac0f3ba9ff6c4f6e8cef338700994f6984ecf13e97fe0e0e8a46f" },
  { path: "src/node-types.d.ts", sha256: "sha256:d3a7fa60efde60e249fe3ce73ae514b655d2f14b79cef65b6716e1af2266eb4e" },
  { path: "src/normalize.ts", sha256: "sha256:f08a73e2d9660939f2620dea4d0e4a47290640bbc7a1f6853c7a09eb00ce1c0a" },
  { path: "src/payload.ts", sha256: "sha256:78038369119c241c09be383e286b85e435c44fa5961956de991658792bd32c2d" },
  { path: "src/probe-spec.ts", sha256: "sha256:f9019e080c753cb5743a683185d7c782876d92e3f485ef66d53cf08a2961cab0" },
  { path: "src/registration.ts", sha256: "sha256:dc04ca236e6fdbfe64b9ac774e19beb1854cc15a8e58de8ad454d9c48aceb80d" },
  { path: "src/tui-bridge.ts", sha256: "sha256:2994c2ea315e74da08377367bbc477d4e5f8bba3ce62650228c534b896f71190" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const OPENCODE_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: OPENCODE_ADAPTER_ID,
  adapter_version: OPENCODE_ADAPTER_VERSION,
  host_id: OPENCODE_HOST_ID,
  files: OPENCODE_IMPLEMENTATION_FILES,
  toolchain: OPENCODE_TOOLCHAIN
});
