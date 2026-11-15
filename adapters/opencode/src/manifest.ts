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
 * The DD-HOST-050 event surface is the 2.1.0 V2 Effect chain; 2.1.4 loaded
 * no diagnostic plugin and therefore emits none of these hooks. Events are
 * bound to the source baseline, not to the installed binary.
 */
export const OPENCODE_EVENT_HOST_VERSION: string = OPENCODE_SOURCE_VERSION;

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
  { path: "runtime/entry.ts", sha256: "sha256:6cfc1dc1590b681bb0a797091cef9089d05ea770e629f346ea06ede0755cb765" },
  { path: "src/adapter.ts", sha256: "sha256:c2d4a771153f0906c4fde015098660f2c8dfa23cb37ce16af7cb84201106261e" },
  { path: "src/capabilities.ts", sha256: "sha256:f504af4b9a804c897c7ba5949ae9607b9e38bbd0874fdf3a82ebdf100b903986" },
  { path: "src/compaction-spec.ts", sha256: "sha256:07c5f22a41261f84ca36263c8080ecd88f2dc17ebd8ad79e1e111c8629a821eb" },
  { path: "src/contract.ts", sha256: "sha256:d40116ebd3f3bde417e398adb27c2e2391de06500b0763654b79f19be07ac858" },
  { path: "src/descriptor.ts", sha256: "sha256:67489c9c43bf8a9f26817e60f0f64c98762fc056c42b8958047a65cfe2528474" },
  { path: "src/events.ts", sha256: "sha256:26eed96e77ba4b4ecc1ed38718d0e00c4ad1358567ea06d83d0d57bf0edcd92c" },
  { path: "src/facts.ts", sha256: "sha256:342038b5c8dbe4ed699a3a70e87b3b7331d789db025030973a86fccc87666e56" },
  { path: "src/generation-output.ts", sha256: "sha256:1b5f4c6adffa91f807814317d325bb12b9dd4739c89b51fa50f4f6562061664d" },
  { path: "src/generation-spec.ts", sha256: "sha256:3ddb31aae33517b519c930c4cbd8df38df7c9704e94c56f80c526b130dffecb6" },
  { path: "src/generation.ts", sha256: "sha256:90a8f0a478dfa48e5ab2d259256e2cc8100e8fec66610d4157f8140304ee3a7d" },
  { path: "src/index.ts", sha256: "sha256:1b0387fb36d5009060030c840e8d9a4f3d6f813b4d7c9c99cd81e1ad73079c21" },
  { path: "src/node-types.d.ts", sha256: "sha256:d3a7fa60efde60e249fe3ce73ae514b655d2f14b79cef65b6716e1af2266eb4e" },
  { path: "src/normalize.ts", sha256: "sha256:9ddb92f5062882679fa4f6d7943f313b4a8879f6d87332268a476d7111f5ac32" },
  { path: "src/payload.ts", sha256: "sha256:90dcd3c617cf68fb3537b8178d793a90d4ba7b2175f2216f33473241e80af19f" },
  { path: "src/probe-spec.ts", sha256: "sha256:f9019e080c753cb5743a683185d7c782876d92e3f485ef66d53cf08a2961cab0" },
  { path: "src/registration.ts", sha256: "sha256:dc04ca236e6fdbfe64b9ac774e19beb1854cc15a8e58de8ad454d9c48aceb80d" }
]);

/** Frozen implementation hash of the checked-in adapter sources. */
export const OPENCODE_IMPLEMENTATION_HASH: Hash = computeImplementationHash({
  adapter_id: OPENCODE_ADAPTER_ID,
  adapter_version: OPENCODE_ADAPTER_VERSION,
  host_id: OPENCODE_HOST_ID,
  files: OPENCODE_IMPLEMENTATION_FILES,
  toolchain: OPENCODE_TOOLCHAIN
});
