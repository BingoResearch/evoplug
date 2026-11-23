/**
 * Compose-root `HostAdapterRegistryPort` for `evolve attach` / `detach`
 * (DD-FND-101, DD-FND-102, DD-FND-021).
 *
 * `@evoplug/kernel` may not import adapter packages, so the app-kernel wiring
 * imports the seven adapters here and supplies the kernel-hosted port. Each
 * adapter ships a `registration` artifact: the only source of target paths,
 * content, write mode and trust state. A host or target without an artifact
 * returns a typed error; it never degrades to a global `E_UNSUPPORTED`.
 */

import { lstatSync, readFileSync, } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDeclaredGenerationRegistry, type NativeGenerationBackendRegistry } from "./review-generation.js";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import { type CapabilityName, type ErrorEnvelope, type Hash, type Id, type JsonValue } from "@evoplug/core";
import { err, hashBytes, isHash, makeErrorEnvelope, ok } from "@evoplug/core";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";
import { computeDescriptorHash, validateAdapterDescriptor } from "@evoplug/core/host";
import { createProbeObservationSpecRegistry, declarationFromAdapterProbeSpec } from "@evoplug/kernel";
import type { AdapterProbeSpecLike, CapabilityBindingDeclarationPort } from "@evoplug/kernel";
import { HOST_REGISTRATION_COMMAND_PLACEHOLDER } from "@evoplug/core/host";
import type {
  AdapterDescriptor,
  AdapterEventContract,
  ConfigSpace,
  HostId,
  HostMode,
  HostRegistrationArtifact,
  HostRegistrationTargetArtifact,
  NativeMessageKind,
  RegistrationTarget,
  TriggerKind
} from "@evoplug/core/host";
import type {
  HostAdapterRegistryPort,
  HostAttachRequest,
  HostAttachResolution,
  HostAttachTargetPlan,
  HostRuntimeAdapter,
  HostRuntimeAdapterResolverPort
} from "@evoplug/kernel";

import {
  CLAUDE_ADAPTER_DESCRIPTOR,
  CLAUDE_REGISTRATION_ARTIFACT,
  CLAUDE_CODE_GENERATION_SPEC,
  claudeCodeProbeSpec,
  createClaudeHostAdapter
} from "@evoplug/adapter-claude-code";
import {
  CODEX_ADAPTER_DESCRIPTOR,
  CODEX_REGISTRATION_ARTIFACT,
  CODEX_GENERATION_SPEC,
  codexProbeSpec,
  createCodexHostAdapter
} from "@evoplug/adapter-codex";
import {
  OMP_ADAPTER_DESCRIPTOR,
  OMP_REGISTRATION_ARTIFACT,
  OMP_GENERATION_SPEC,
  ohMyPiProbeSpec,
  createOmpHostAdapter
} from "@evoplug/adapter-oh-my-pi";
import {
  OPENCODE_ADAPTER_DESCRIPTOR,
  OPENCODE_REGISTRATION_ARTIFACT,
  OPENCODE_GENERATION_SPEC,
  openCodeProbeSpec,
  createOpenCodeHostAdapter
} from "@evoplug/adapter-opencode";
import {
  OPENHANDS_ADAPTER_DESCRIPTOR,
  OPENHANDS_REGISTRATION_ARTIFACT,
  OPENHANDS_GENERATION_SPEC,
  openHandsSdkProbeSpec,
  createOpenhandsHostAdapter
} from "@evoplug/adapter-openhands-sdk";
import {
  PI_ADAPTER_DESCRIPTOR,
  PI_REGISTRATION_ARTIFACT,
  PI_GENERATION_SPEC,
  piProbeSpec,
  createPiHostAdapter
} from "@evoplug/adapter-pi";
import {
  STEP_ADAPTER_DESCRIPTOR,
  STEP_REGISTRATION_ARTIFACT,
  STEP_GENERATION_SPEC,
  stepCodeProbeSpec,
  createStepCodeHostAdapter
} from "@evoplug/adapter-step-code";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/** Compose the packaged adapter declarations without inferring host behavior. */
export function createPackagedGenerationRegistry(): NativeGenerationBackendRegistry {
  return createDeclaredGenerationRegistry([
    CLAUDE_CODE_GENERATION_SPEC,
    CODEX_GENERATION_SPEC,
    OMP_GENERATION_SPEC,
    OPENCODE_GENERATION_SPEC,
    OPENHANDS_GENERATION_SPEC,
    PI_GENERATION_SPEC,
    STEP_GENERATION_SPEC
  ], {
    glue_root: fileURLToPath(new URL("../", import.meta.resolve("@evoplug/adapter-openhands-sdk")))
  });
}

interface HostAttachDefaults {
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
}

interface HostRegistryEntry {
  readonly descriptor: AdapterDescriptor;
  readonly artifact: HostRegistrationArtifact;
}

interface PackagedRegistrationTarget {
  readonly target_id: string;
  readonly config_space: ConfigSpace;
  readonly scope: "user" | "project" | "managed";
  readonly kind: RegistrationTarget["kind"];
  readonly load_boundary: RegistrationTarget["load_boundary"];
  readonly marker_id: string | null;
}

interface PackagedEventContract {
  readonly host_event: string;
  readonly native_kind: NativeMessageKind;
  readonly canonical_kinds: readonly TriggerKind[];
  readonly required_capabilities: readonly CapabilityName[];
}

interface PackagedDescriptor {
  readonly schema_version: "rsi.adapter_descriptor/1";
  readonly adapter_id: Id<"adp">;
  readonly host_id: HostId;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly supported_modes: readonly HostMode[];
  readonly config_spaces: readonly ConfigSpace[];
  readonly registration_targets: readonly PackagedRegistrationTarget[];
  readonly event_contracts: readonly PackagedEventContract[];
  readonly declared_capabilities: readonly CapabilityName[];
}

/**
 * Copies an adapter-owned (read-only) descriptor into HOST's mutable
 * descriptor shape. Values are copied, never re-derived, so the descriptor
 * hash computed from the artifact still matches.
 */
function toCoreDescriptor(packaged: PackagedDescriptor): AdapterDescriptor {
  const targets: RegistrationTarget[] = packaged.registration_targets.map((target) => ({
    target_id: target.target_id,
    config_space: target.config_space,
    scope: target.scope,
    kind: target.kind,
    load_boundary: target.load_boundary,
    marker_id: target.marker_id
  }));
  const contracts: AdapterEventContract[] = packaged.event_contracts.map((contract) => ({
    host_event: contract.host_event,
    native_kind: contract.native_kind,
    canonical_kinds: [...contract.canonical_kinds],
    required_capabilities: [...contract.required_capabilities]
  }));
  return {
    schema_version: packaged.schema_version,
    adapter_id: packaged.adapter_id,
    host_id: packaged.host_id,
    adapter_version: packaged.adapter_version,
    implementation_hash: packaged.implementation_hash,
    supported_modes: [...packaged.supported_modes],
    config_spaces: [...packaged.config_spaces],
    registration_targets: targets,
    event_contracts: contracts,
    declared_capabilities: [...packaged.declared_capabilities]
  };
}

const HOST_ENTRIES: readonly HostRegistryEntry[] = Object.freeze([
  {
    descriptor: toCoreDescriptor(CLAUDE_ADAPTER_DESCRIPTOR),
    artifact: CLAUDE_REGISTRATION_ARTIFACT
  },
  { descriptor: toCoreDescriptor(CODEX_ADAPTER_DESCRIPTOR), artifact: CODEX_REGISTRATION_ARTIFACT },
  { descriptor: toCoreDescriptor(OMP_ADAPTER_DESCRIPTOR), artifact: OMP_REGISTRATION_ARTIFACT },
  {
    descriptor: toCoreDescriptor(OPENCODE_ADAPTER_DESCRIPTOR),
    artifact: OPENCODE_REGISTRATION_ARTIFACT
  },
  {
    descriptor: toCoreDescriptor(OPENHANDS_ADAPTER_DESCRIPTOR),
    artifact: OPENHANDS_REGISTRATION_ARTIFACT
  },
  { descriptor: toCoreDescriptor(PI_ADAPTER_DESCRIPTOR), artifact: PI_REGISTRATION_ARTIFACT },
  { descriptor: toCoreDescriptor(STEP_ADAPTER_DESCRIPTOR), artifact: STEP_REGISTRATION_ARTIFACT }
]);

const BY_HOST = new Map<HostId, HostRegistryEntry>(
  HOST_ENTRIES.map((entry) => [entry.descriptor.host_id, entry])
);

const PROBE_SPECS: ReadonlyMap<string, AdapterProbeSpecLike & {
  readonly observation?: import("@evoplug/kernel").ProbeObservationSpecLike;
}> = new Map([
  [CLAUDE_ADAPTER_DESCRIPTOR.adapter_id, claudeCodeProbeSpec],
  [CODEX_ADAPTER_DESCRIPTOR.adapter_id, codexProbeSpec],
  [OMP_ADAPTER_DESCRIPTOR.adapter_id, ohMyPiProbeSpec],
  [OPENCODE_ADAPTER_DESCRIPTOR.adapter_id, openCodeProbeSpec],
  [OPENHANDS_ADAPTER_DESCRIPTOR.adapter_id, openHandsSdkProbeSpec],
  [PI_ADAPTER_DESCRIPTOR.adapter_id, piProbeSpec],
  [STEP_ADAPTER_DESCRIPTOR.adapter_id, stepCodeProbeSpec]
]);

/** Bind native observations to the packaged descriptor's adapter identity. */
export function createPackagedProbeObservationRegistry(): import("@evoplug/kernel").ProbeObservationSpecRegistry {
  return createProbeObservationSpecRegistry(
    [...PROBE_SPECS].map(([adapter_id, spec]) => ({
      adapter_id,
      ...(spec.observation === undefined ? {} : { observation: spec.observation })
    }))
  );
}

/**
 * Binds adapter declarations to the exact persisted activation root.
 *
 * The declaration inputs are never trusted as caller facts. The registered
 * adapter, descriptor snapshot and artifact must all agree with the applied
 * `adapter_registration` row before a binding is produced.
 *
 * Root binding:
 * - zero `root_registration` rows: the artifact root declared by the packaged
 *   probe spec (`spec.adapter_id`) is used. A capability probe must not depend
 *   on the FND admission chain, which needs readiness evidence from the very
 *   capability it would gate;
 * - exactly one row: the persisted root stays authoritative;
 * - more than one row: fail closed instead of choosing.
 *
 * Reading a root never grants file-write authority; the FND root registry,
 * approval and write gates are untouched.
 */
export function createProbeBindingDeclarationPort(
  connection: SqliteConnection
): CapabilityBindingDeclarationPort {
  return {
    declare(input) {
      const spec = PROBE_SPECS.get(input.registration.adapter_id);
      const entry = BY_HOST.get(input.registration.host_id);
      if (spec === undefined || entry === undefined ||
          entry.descriptor.adapter_id !== input.registration.adapter_id ||
          entry.descriptor.adapter_version !== input.registration.adapter_version) {
        return err(registryError("E_ADAPTER_MISMATCH", "probe.adapter", "exact_adapter_identity"));
      }

      const registration = connection.prepare<PersistedRegistrationRow>(
        `SELECT state, adapter_id, adapter_version, host_id, mode, config_space,
                descriptor_hash, artifact_hash, written_hash
           FROM adapter_registration
          WHERE registration_hash = ?`
      ).get([input.registration.registration_hash]);
      if (registration === undefined || registration.state !== "applied") {
        return err(declarationDrift("registration", "persisted_applied_registration_required"));
      }
      if (
        registration.adapter_id !== input.registration.adapter_id ||
        registration.adapter_version !== input.registration.adapter_version ||
        registration.host_id !== input.registration.host_id ||
        registration.mode !== input.registration.mode ||
        registration.config_space !== input.registration.config_space ||
        registration.artifact_hash !== input.registration.artifact_hash
      ) {
        return err(declarationDrift("registration", "persisted_registration_identity_drift"));
      }
      if (
        registration.written_hash !== null &&
        registration.written_hash !== registration.artifact_hash
      ) {
        return err(declarationDrift("registration.artifact_hash", "written_artifact_drift"));
      }

      const snapshot = connection.prepare<PersistedSnapshotRow>(
        `SELECT descriptor_hash, descriptor_json
           FROM adapter_descriptor_snapshot
          WHERE registration_hash = ?`
      ).get([input.registration.registration_hash]);
      if (snapshot === undefined) {
        return err(declarationSchema("adapter_descriptor_snapshot", "missing"));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(snapshot.descriptor_json);
      } catch {
        return err(declarationSchema("adapter_descriptor_snapshot", "invalid_json"));
      }
      const descriptor = validateAdapterDescriptor(parsed);
      if (!descriptor.ok) {
        return err(declarationSchema("adapter_descriptor_snapshot", "descriptor_invalid"));
      }
      if (
        descriptor.value.adapter_id !== input.registration.adapter_id ||
        descriptor.value.adapter_version !== input.registration.adapter_version ||
        descriptor.value.host_id !== input.registration.host_id
      ) {
        return err(declarationDrift("adapter_descriptor_snapshot", "descriptor_identity_drift"));
      }
      const descriptorHash = computeDescriptorHash(descriptor.value);
      if (
        descriptorHash !== snapshot.descriptor_hash ||
        descriptorHash !== registration.descriptor_hash
      ) {
        return err(declarationDrift("adapter_descriptor_snapshot", "descriptor_hash_drift"));
      }

      const roots = connection.prepare<PersistedRootRow>(
        `SELECT root_id, host_id, mode, config_space, adapter_id
           FROM root_registration
          WHERE registration_hash = ?
          ORDER BY root_id
          LIMIT 2`
      ).all([input.registration.registration_hash]);
      if (roots.length > 1) {
        return err(makeErrorEnvelope({
          code: "E_PROBE_UNSUPPORTED",
          category: "policy",
          message_key: "error.probe.unsupported",
          stage: "probe_binding_declaration",
          details: { kind: "field", path: "registration.root_id", rule: "unique_registered_root_required" }
        }));
      }
      const root = roots[0];
      if (root !== undefined) {
        if (
          root.host_id !== input.registration.host_id ||
          root.mode !== input.registration.mode ||
          root.config_space !== input.registration.config_space ||
          root.adapter_id !== input.registration.adapter_id
        ) {
          return err(declarationDrift("registration.root_id", "registered_root_identity_drift"));
        }
      }

      const declared = declarationFromAdapterProbeSpec(spec, {
        host_version: input.host_version,
        binary_hash: input.binary_hash,
        adapter_version: input.registration.adapter_version,
        native_session_id: input.native_session_id,
        os: process.platform,
        arch: process.arch
      });
      return ok(root === undefined ? declared : { ...declared, root_id: root.root_id });
    }
  };
}

interface PersistedRegistrationRow extends SqlRow {
  readonly state: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly descriptor_hash: string;
  readonly artifact_hash: string;
  readonly written_hash: string | null;
}

interface PersistedSnapshotRow extends SqlRow {
  readonly descriptor_hash: string;
  readonly descriptor_json: string;
}

interface PersistedRootRow extends SqlRow {
  readonly root_id: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly adapter_id: string;
}

/** A caller/DB identity disagreement; never a guessed binding. */
function declarationDrift(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_ADAPTER_MISMATCH",
    category: "conflict",
    message_key: "error.e_adapter_mismatch",
    stage: "probe_binding_declaration",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/** A malformed or missing persisted snapshot; fail closed as a schema error. */
function declarationSchema(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "probe_binding_declaration",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function registryError(code: `E_${string}`, path: string, rule: string): ErrorEnvelope {
  const category =
    code === "E_ADAPTER_MISMATCH" || code === "E_CONFLICT"
      ? "conflict"
      : code === "E_AUTH_UNAVAILABLE" || code === "E_ARTIFACT_MISMATCH"
        ? code === "E_ARTIFACT_MISMATCH"
          ? "source"
          : "authorization"
        : code === "E_TARGET_NOT_DECLARED" || code === "E_CONFIG_SPACE_NOT_DECLARED"
          ? "policy"
          : "schema";
  return makeErrorEnvelope({
    code,
    category,
    message_key: `error.${code.toLowerCase()}`,
    stage: "host_attach_registry",
    details: { kind: "field", path, rule }
  });
}

/* ------------------------------------------------------------------ */
/* Release artifact source                                             */
/* ------------------------------------------------------------------ */

interface HostAdapterRegistryOptions {
  /**
   * Directory of a release-built host runtime artifact (DD-HOST-200.2).
   *
   * Both builder layouts are accepted:
   *   - directory form: `manifest.json` + `entry.mjs` at the directory root
   *   - single-file form: `evoplug.js` at the root plus
   *     `evoplug.runtime/manifest.json`
   *
   * The manifest is the source of truth for `host_id`, adapter identity,
   * implementation hash and per-file hashes. Attach re-hashes every file
   * before writing it and regenerates its own runtime manifest/config.
   */
  readonly artifact_dir?: string;
  /**
   * Detach-only fallback: when no `artifact_dir` is supplied, read the release
   * manifest from an installed `json_merge` selector root. Detach runs after
   * attach and usually has no build directory, but the installed artifact root
   * carries the same identity-checked `manifest.json`, which is the only input
   * needed to reconstruct the managed entry values. Attach must not enable this
   * because a stale installed artifact must never supply files for a new
   * attach.
   */
  readonly resolve_installed_artifact?: boolean;
  /**
   * Attach caller's environment snapshot. Host directory templates expand
   * from this, never from the long-lived kernel process. Appendix H.1.
   */
  readonly host_env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: read the source without the regular-file/symlink checks. */
  readonly verify_present?: boolean;
}

interface ReleaseArtifactFile {
  readonly relative_path: string;
  readonly content: string;
  readonly mode: 384 | 420;
}

interface ReleaseArtifact {
  readonly host_id: HostId;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly entry: string;
  readonly files: readonly ReleaseArtifactFile[];
}

const MANIFEST_CANDIDATES: readonly string[] = Object.freeze([
  "manifest.json",
  join("evoplug.runtime", "manifest.json")
]);

const ARTIFACT_SCHEMA = "rsi.host_runtime_artifact/1";

/** NUL is illegal in POSIX paths; built without a literal so the source stays text. */
const NUL = String.fromCharCode(0);

function readArtifactManifest(dir: string): { readonly path: string; readonly bytes: Uint8Array } | ErrorEnvelope {
  if (!isAbsolute(dir) || dir.includes(NUL)) {
    return registryError("E_SCHEMA", "artifact_dir", "absolute");
  }
  for (const candidate of MANIFEST_CANDIDATES) {
    const path = join(dir, candidate);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return registryError("E_ARTIFACT_MISMATCH", "manifest", "regular_file");
    }
    try {
      return { path, bytes: new Uint8Array(readFileSync(path)) };
    } catch {
      return registryError("E_ARTIFACT_MISMATCH", "manifest", "read_failed");
    }
  }
  return registryError("E_ARTIFACT_MISMATCH", "manifest", "missing");
}

function safeRelativeArtifactPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.includes("\\") || path.includes(NUL)) {
    return false;
  }
  if (isAbsolute(path) || path.normalize("NFC") !== path) {
    return false;
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

/**
 * Loads and verifies a release artifact directory.
 *
 * Every listed file is read from the artifact root, re-hashed and decoded as
 * UTF-8. Nothing is inferred from the builder's own `config.json`; attach
 * generates the runtime config for the target registration.
 */
function loadReleaseArtifact(
  dir: string,
  descriptor: AdapterDescriptor,
  verifyPresent: boolean
): ReleaseArtifact | ErrorEnvelope {
  const manifestRead = readArtifactManifest(dir);
  if ("code" in manifestRead) {
    return manifestRead;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestRead.bytes));
  } catch {
    return registryError("E_ARTIFACT_MISMATCH", "manifest", "json");
  }
  if (!isRecord(parsed) || parsed["schema_version"] !== ARTIFACT_SCHEMA) {
    return registryError("E_ARTIFACT_MISMATCH", "manifest.schema_version", ARTIFACT_SCHEMA);
  }
  if (
    parsed["host_id"] !== descriptor.host_id ||
    parsed["adapter_id"] !== descriptor.adapter_id ||
    parsed["adapter_version"] !== descriptor.adapter_version
  ) {
    return registryError("E_ADAPTER_MISMATCH", "manifest", "descriptor_identity");
  }
  const implementationHash = parsed["implementation_hash"];
  if (typeof implementationHash !== "string" || !isHash(implementationHash)) {
    return registryError("E_ARTIFACT_MISMATCH", "manifest.implementation_hash", "hash");
  }
  if (implementationHash !== descriptor.implementation_hash) {
    return registryError("E_ARTIFACT_MISMATCH", "manifest.implementation_hash", "adapter_implementation");
  }
  const entry = parsed["entry"];
  if (typeof entry !== "string" || !safeRelativeArtifactPath(entry)) {
    return registryError("E_ARTIFACT_MISMATCH", "manifest.entry", "relative_path");
  }
  const rawFiles = parsed["files"];
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return registryError("E_ARTIFACT_MISMATCH", "manifest.files", "non_empty");
  }
  const root = resolve(dir);
  const files: ReleaseArtifactFile[] = [];
  const seen = new Set<string>();
  for (const raw of rawFiles) {
    if (!isRecord(raw)) {
      return registryError("E_ARTIFACT_MISMATCH", "manifest.files", "object");
    }
    const relative = raw["path"];
    const expectedHash = raw["sha256"];
    const mode = raw["mode"];
    if (typeof relative !== "string" || !safeRelativeArtifactPath(relative)) {
      return registryError("E_ARTIFACT_MISMATCH", "manifest.files.path", "relative_path");
    }
    if (typeof expectedHash !== "string" || !isHash(expectedHash)) {
      return registryError("E_ARTIFACT_MISMATCH", "manifest.files.sha256", "hash");
    }
    if (mode !== 384 && mode !== 420) {
      return registryError("E_ARTIFACT_MISMATCH", "manifest.files.mode", "0600_or_0644");
    }
    const key = relative.toLowerCase();
    if (seen.has(key)) {
      return registryError("E_ARTIFACT_MISMATCH", "manifest.files.path", "duplicate_path");
    }
    seen.add(key);
    const path = join(root, relative);
    if (verifyPresent) {
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        return registryError("E_ARTIFACT_MISMATCH", relative, "missing");
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return registryError("E_ARTIFACT_MISMATCH", relative, "regular_file");
      }
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      return registryError("E_ARTIFACT_MISMATCH", relative, "read_failed");
    }
    if (hashBytes(bytes) !== expectedHash) {
      return registryError("E_ARTIFACT_MISMATCH", relative, "sha256");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return registryError("E_ARTIFACT_MISMATCH", relative, "utf8");
    }
    files.push({ relative_path: relative, content, mode });
  }
  if (!seen.has(entry.toLowerCase())) {
    return registryError("E_ARTIFACT_MISMATCH", "manifest.entry", "listed_file");
  }
  return {
    host_id: descriptor.host_id,
    adapter_id: descriptor.adapter_id,
    adapter_version: descriptor.adapter_version,
    implementation_hash: descriptor.implementation_hash,
    entry,
    files
  };
}

const DISCOVERY_SHIM_MODES: Readonly<Record<HostId, string | null>> = Object.freeze({
  pi: "index.js",
  "oh-my-pi": "index.js",
  "step-code": "index.js",
  codex: null,
  opencode: null,
  "openhands-sdk": null,
  "claude-code": null
});

/**
 * Quotes one argument for a POSIX shell (`/bin/sh -c`). Paths may contain
 * spaces or quotes; JSON encoding is not shell escaping.
 */
function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** `<node> <artifact-root>/<entry>`, both arguments shell-quoted. */
function nativeHookCommand(root: string, entry: string): string {
  return `${posixShellQuote(process.execPath)} ${posixShellQuote(join(root, entry))}`;
}

function expandCommandStrings(value: JsonValue, command: string): JsonValue {
  if (typeof value === "string") {
    return value.replaceAll(HOST_REGISTRATION_COMMAND_PLACEHOLDER, command);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandCommandStrings(item, command));
  }
  if (typeof value === "object" && value !== null) {
    const expanded: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      expanded[key] = expandCommandStrings(child, command);
    }
    return expanded;
  }
  return value;
}

function hasCommandPlaceholder(value: JsonValue): boolean {
  if (typeof value === "string") {
    return value.includes(HOST_REGISTRATION_COMMAND_PLACEHOLDER);
  }
  if (Array.isArray(value)) {
    return value.some(hasCommandPlaceholder);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasCommandPlaceholder);
  }
  return false;
}

/**
 * Expands a placeholder inside a generated file. JSON files are parsed and
 * re-serialized so the shell command is escaped as a JSON string, not spliced
 * into bytes that were encoded before the command existed.
 */
function expandFileContent(content: string, command: string): string {
  if (!content.includes(HOST_REGISTRATION_COMMAND_PLACEHOLDER)) {
    return content;
  }
  try {
    const parsed = JSON.parse(content) as JsonValue;
    return `${JSON.stringify(expandCommandStrings(parsed, command), null, 2)}\n`;
  } catch {
    return content.replaceAll(HOST_REGISTRATION_COMMAND_PLACEHOLDER, command);
  }
}

function artifactFilesFor(
  target: HostRegistrationTargetArtifact,
  artifact: ReleaseArtifact,
  rootPath: string
): readonly ReleaseArtifactFile[] {
  const files = [...artifact.files];
  const command = nativeHookCommand(rootPath, artifact.entry);
  for (const file of target.files ?? []) {
    files.push({
      relative_path: file.relative_path,
      content: expandFileContent(file.content, command),
      mode: file.mode
    });
  }
  const shim = target.discovery_entry ?? DISCOVERY_SHIM_MODES[artifact.host_id];
  if (shim !== null && safeRelativeArtifactPath(shim)) {
    if (!files.some((file) => file.relative_path === shim)) {
      files.push({
        relative_path: shim,
        content: `export { default } from "./${basename(artifact.entry)}";\n`,
        mode: 420
      });
    }
  }
  return files;
}

/** Default mode/config space used by `evolve attach <host>` without flags. */
export function attachDefaults(host_id: string): HostAttachDefaults | null {
  const entry = BY_HOST.get(host_id as HostId);
  if (entry === undefined) {
    return null;
  }
  return {
    host_id: entry.descriptor.host_id,
    mode: entry.artifact.default_mode,
    config_space: entry.artifact.default_config_space
  };
}

function expandTemplate(
  template: string,
  hostEnv: Readonly<Record<string, string | undefined>>
): string | null {
  const home = hostEnv["HOME"];
  const project = process.cwd();
  const envPath = (name: string, fallback: string): string => {
    const value = hostEnv[name];
    return value !== undefined && value.length > 0 ? value : fallback;
  };
  if (home === undefined || home.length === 0) {
    return null;
  }
  const xdgConfig = envPath("XDG_CONFIG_HOME", join(home, ".config"));
  const codexHome = envPath("CODEX_HOME", join(home, ".codex"));
  // oh-my-pi takes its agent directory from `PI_CODING_AGENT_DIR`; a named
  // `OMP_PROFILE` resolves under `<home>/.omp/profiles/<name>/agent`. The
  // adapter's `$OMP_PROFILE` placeholder expands to that directory, not to the
  // raw profile name (which is not a path).
  const ompAgentDir = (() => {
    const agent = hostEnv["PI_CODING_AGENT_DIR"];
    if (agent !== undefined && agent.length > 0) return agent;
    const profile = hostEnv["OMP_PROFILE"];
    if (profile !== undefined && profile.length > 0) {
      return join(home, ".omp", "profiles", profile, "agent");
    }
    return join(home, ".omp", "agent");
  })();
  const variables: ReadonlyArray<readonly [string, string]> = [
    ["$PI_CODING_AGENT_DIR", envPath("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"))],
    ["$STEP_CODING_AGENT_DIR", envPath("STEP_CODING_AGENT_DIR", join(home, ".stepcode", "agent"))],
    ["$OMP_PROFILE", ompAgentDir],
    ["$CLAUDE_CONFIG_DIR", envPath("CLAUDE_CONFIG_DIR", join(home, ".claude"))],
    ["$OH_PERSISTENCE_DIR", envPath("OH_PERSISTENCE_DIR", join(home, ".openhands"))],
    ["$XDG_CONFIG_HOME", xdgConfig],
    ["$CODEX_HOME", codexHome],
    ["$PROJECT", project],
    ["$HOME", home]
  ];
  let expanded = "";
  let index = 0;
  while (index < template.length) {
    const dollar = template.indexOf("$", index);
    if (dollar === -1) {
      expanded += template.slice(index);
      break;
    }
    expanded += template.slice(index, dollar);
    const rest = template.slice(dollar);
    const variable = variables.find(([name]) => rest.startsWith(name));
    if (variable === undefined) {
      return null;
    }
    // Substituted values are opaque. A literal `$` in HOME or in an env value
    // is a valid file name and must not be mistaken for an unresolved token.
    expanded += variable[1];
    index = dollar + variable[0].length;
  }
  if (expanded.includes(NUL) || !isAbsolute(expanded)) {
    return null;
  }
  return expanded;
}

/**
 * Expands a packaged registration path template with the closed DD-HOST-205
 * variable set. `null` means the template names an unknown variable or does
 * not resolve to an absolute path.
 */
export function expandHostPathTemplate(
  template: string,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  return expandTemplate(template, hostEnv);
}

function declaredTargets(
  descriptor: AdapterDescriptor,
  config_space: ConfigSpace
): readonly RegistrationTarget[] {
  return descriptor.registration_targets.filter((target) => target.config_space === config_space);
}

function targetIdOf(target: RegistrationTarget): string {
  return target.target_id;
}

function validatePlanFile(file: ReleaseArtifactFile, path: string): ErrorEnvelope | null {
  if (!safeRelativeArtifactPath(file.relative_path)) {
    return registryError("E_SCHEMA", path, "relative_path");
  }
  if (file.relative_path === "manifest.json" || file.relative_path === "config.json") {
    return registryError("E_SCHEMA", path, "reserved_artifact_file");
  }
  if (file.mode !== 384 && file.mode !== 420) {
    return registryError("E_SCHEMA", path, "0600_or_0644");
  }
  return null;
}

function validatePlanFiles(files: readonly ReleaseArtifactFile[]): ErrorEnvelope | null {
  if (files.length === 0) {
    return registryError("E_ARTIFACT_MISMATCH", "files", "non_empty");
  }
  const seen = new Set<string>();
  for (const file of files) {
    const invalid = validatePlanFile(file, "files.relative_path");
    if (invalid !== null) {
      return invalid;
    }
    const key = file.relative_path.toLowerCase();
    if (seen.has(key)) {
      return registryError("E_CONFLICT", "files.relative_path", "duplicate_path");
    }
    seen.add(key);
  }
  return null;
}

function buildPlan(
  target: RegistrationTarget,
  artifactTarget: HostRegistrationTargetArtifact,
  releaseArtifact: ReleaseArtifact | null,
  hostEnv: Readonly<Record<string, string | undefined>>
): HostAttachTargetPlan | ErrorEnvelope {
  const path = expandTemplate(artifactTarget.path_template, hostEnv);
  if (path === null) {
    return registryError("E_SCHEMA", "path_template", artifactTarget.target_id);
  }
  const hasMarker = target.marker_id !== null;
  if (hasMarker && artifactTarget.write_mode !== "managed_block") {
    return registryError("E_SCHEMA", "write_mode", "managed_block_required");
  }
  if (!hasMarker && artifactTarget.write_mode === "managed_block") {
    return registryError("E_SCHEMA", "write_mode", "managed_block_marker_missing");
  }
  if (artifactTarget.write_mode === "whole_file" && artifactTarget.content === undefined) {
    return registryError("E_SCHEMA", "content", "whole_file_content_required");
  }
  if (artifactTarget.write_mode === "managed_block" && artifactTarget.content === undefined) {
    return registryError("E_SCHEMA", "content", "managed_block_content_required");
  }
  if (artifactTarget.write_mode === "artifact_dir") {
    if (
      target.kind !== "extension" &&
      target.kind !== "plugin" &&
      target.kind !== "sdk_package"
    ) {
      return registryError("E_SCHEMA", "write_mode", "artifact_dir_kind");
    }
    const rootPath = expandTemplate(artifactTarget.root_path ?? artifactTarget.path_template, hostEnv);
    if (rootPath === null) {
      return registryError("E_SCHEMA", "root_path", artifactTarget.target_id);
    }
    let files: readonly ReleaseArtifactFile[];
    let singleFile = false;
    if (releaseArtifact !== null) {
      files = artifactFilesFor(artifactTarget, releaseArtifact, rootPath);
      singleFile =
        releaseArtifact.files.length === 1 &&
        releaseArtifact.files[0]?.relative_path === releaseArtifact.entry;
    } else if (artifactTarget.files !== undefined && artifactTarget.files.length > 0) {
      // Static packaged files remain valid for fixtures and legacy artifacts.
      files = artifactTarget.files.map((file) => ({
        relative_path: file.relative_path,
        content: file.content,
        mode: file.mode
      }));
      if (files.some((file) => file.content.includes(HOST_REGISTRATION_COMMAND_PLACEHOLDER))) {
        return registryError("E_ARTIFACT_MISMATCH", "artifact_dir", "artifact_source_required");
      }
    } else {
      return registryError("E_ARTIFACT_MISMATCH", "artifact_dir", "artifact_source_required");
    }
    const invalidFiles = validatePlanFiles(files);
    if (invalidFiles !== null) {
      return invalidFiles;
    }
    let metaDir: string | undefined;
    if (singleFile && releaseArtifact !== null) {
      const stem = basename(releaseArtifact.entry, extname(releaseArtifact.entry));
      metaDir = join(rootPath, `${stem}.runtime`);
    }
    return {
      target,
      path: rootPath,
      write_mode: artifactTarget.write_mode,
      root_path: rootPath,
      ...(metaDir === undefined ? {} : { runtime_meta_dir: metaDir }),
      files: files.map((file) => ({
        relative_path: file.relative_path,
        content: file.content,
        mode: file.mode
      })),
      requires_trust: artifactTarget.requires_trust,
      trust_state: artifactTarget.trust_state
    };
  }
  if (artifactTarget.write_mode === "json_merge") {
    if (target.kind !== "hook_config") {
      return registryError("E_SCHEMA", "write_mode", "json_merge_kind");
    }
    if (artifactTarget.selector === undefined) {
      return registryError("E_SCHEMA", "selector", "json_merge_selector_required");
    }
    const selector = expandTemplate(artifactTarget.selector, hostEnv);
    if (selector === null) {
      return registryError("E_SCHEMA", "selector", artifactTarget.target_id);
    }
    if (artifactTarget.entries === undefined || artifactTarget.entries.length === 0) {
      return registryError("E_SCHEMA", "entries", "json_merge_entries_required");
    }
    const needsCommand = artifactTarget.entries.some((entry) =>
      hasCommandPlaceholder(entry.value)
    );
    let command: string | null = null;
    if (needsCommand) {
      if (releaseArtifact === null) {
        return registryError("E_ARTIFACT_MISMATCH", "entries", "artifact_source_required");
      }
      command = nativeHookCommand(selector, releaseArtifact.entry);
    }
    return {
      target,
      path,
      write_mode: artifactTarget.write_mode,
      selector,
      entries: artifactTarget.entries.map((entry) => ({
        pointer: entry.pointer,
        value: command === null ? entry.value : expandCommandStrings(entry.value, command)
      })),
      requires_trust: artifactTarget.requires_trust,
      trust_state: artifactTarget.trust_state
    };
  }
  return {
    target,
    path,
    content: artifactTarget.content ?? "",
    write_mode: artifactTarget.write_mode,
    requires_trust: artifactTarget.requires_trust,
    trust_state: artifactTarget.trust_state
  };
}

function validateEntry(entry: HostRegistryEntry): ErrorEnvelope | null {
  const { descriptor, artifact } = entry;
  if (artifact.schema_version !== "rsi.host_registration_artifact/1") {
    return registryError("E_SCHEMA", "artifact.schema_version", descriptor.host_id);
  }
  if (
    artifact.host_id !== descriptor.host_id ||
    artifact.adapter_id !== descriptor.adapter_id ||
    artifact.adapter_version !== descriptor.adapter_version
  ) {
    return registryError("E_ADAPTER_MISMATCH", "artifact", "descriptor_identity");
  }
  if (!descriptor.supported_modes.includes(artifact.default_mode)) {
    return registryError("E_ADAPTER_MISMATCH", "artifact.default_mode", "descriptor_mode");
  }
  if (!descriptor.config_spaces.includes(artifact.default_config_space)) {
    return registryError(
      "E_CONFIG_SPACE_NOT_DECLARED",
      "artifact.default_config_space",
      "descriptor_config_space"
    );
  }
  const declaredIds = new Set(descriptor.registration_targets.map(targetIdOf));
  for (const target of artifact.targets) {
    if (!declaredIds.has(target.target_id)) {
      return registryError("E_TARGET_NOT_DECLARED", "artifact.targets", target.target_id);
    }
  }
  return null;
}

/**
 * Detach fallback (DD-FND-102 rule 6): reconstruct the release entry from an
 * installed `json_merge` selector root. `loadReleaseArtifact` verifies the
 * manifest's host/adapter identity and file hashes against the packaged
 * descriptor, so a foreign or tampered install is rejected rather than used.
 */
function loadInstalledRelease(
  descriptor: AdapterDescriptor,
  targets: readonly HostRegistrationTargetArtifact[],
  verifyPresent: boolean,
  hostEnv: Readonly<Record<string, string | undefined>>
): ReleaseArtifact | null {
  const staticPaths = new Set<string>();
  for (const target of targets) {
    for (const file of target.files ?? []) {
      staticPaths.add(file.relative_path);
    }
  }
  const shim = DISCOVERY_SHIM_MODES[descriptor.host_id];
  if (shim !== null) {
    staticPaths.add(shim);
  }
  const selectors = new Set<string>();
  for (const target of targets) {
    if (target.write_mode !== "json_merge" || target.selector === undefined) {
      continue;
    }
    const selector = expandTemplate(target.selector, hostEnv);
    if (selector !== null) {
      selectors.add(selector);
    }
  }
  // Appendix L.3: one hook carrier per host. Once the settings hook target is
  // filtered out, the plugin directory is the only remaining anchor for the
  // installed runtime manifest.
  for (const target of targets) {
    if (target.write_mode !== "artifact_dir") continue;
    const root = expandTemplate(target.root_path ?? target.path_template, hostEnv);
    if (root !== null) {
      selectors.add(root);
    }
  }
  for (const selector of selectors) {
    const loaded = loadReleaseArtifact(selector, descriptor, verifyPresent);
    if ("code" in loaded) {
      continue;
    }
    // The attach-generated runtime manifest lists static host files alongside
    // the release files, and its `entry` is the byte-order-first member. The
    // managed hook command was built from the release entry, so recover it
    // from the non-static members using the builder's two layouts.
    const releasePaths = loaded.files
      .map((file) => file.relative_path)
      .filter((path) => !staticPaths.has(path))
      .sort();
    const entry =
      releasePaths.find((path) => /^entry\.[A-Za-z0-9]+$/u.test(path)) ??
      releasePaths.find((path) => path === "evoplug.js") ??
      (releasePaths.length === 1 ? releasePaths[0] : undefined);
    if (entry !== undefined) {
      return {
        ...loaded,
        entry,
        // Static host files are regenerated by the plan; keeping them here
        // would duplicate paths in `artifactFilesFor`.
        files: loaded.files.filter((file) => !staticPaths.has(file.relative_path))
      };
    }
  }
  return null;
}

/**
 * Resolves a host attach request from the packaged artifacts. `null` means the
 * host is not served by this build; every other failure is a typed envelope
 * naming the host, config space or target that is missing.
 */
export function createHostAdapterRegistry(
  options: HostAdapterRegistryOptions = {}
): HostAdapterRegistryPort {
  const releaseCache = new Map<string, ReleaseArtifact | ErrorEnvelope>();
  const hostEnv = options.host_env ?? process.env;
  const loadRelease = (descriptor: AdapterDescriptor): ReleaseArtifact | ErrorEnvelope | null => {
    const dir = options.artifact_dir;
    if (dir === undefined) {
      return null;
    }
    const key = `${descriptor.adapter_id}${NUL}${dir}`;
    const cached = releaseCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const loaded = loadReleaseArtifact(dir, descriptor, options.verify_present ?? true);
    releaseCache.set(key, loaded);
    return loaded;
  };
  return {
    resolve(request: HostAttachRequest) {
      const entry = BY_HOST.get(request.host_id);
      if (entry === undefined) {
        return { ok: true, status: "ok", value: null };
      }
      const invalid = validateEntry(entry);
      if (invalid !== null) {
        return { ok: false, status: "rejected", error: invalid };
      }
      const { descriptor, artifact } = entry;
      if (!descriptor.supported_modes.includes(request.mode)) {
        return {
          ok: false,
          status: "rejected",
          error: registryError("E_ADAPTER_MISMATCH", "mode", "descriptor_mode")
        };
      }
      if (!descriptor.config_spaces.includes(request.config_space)) {
        return {
          ok: false,
          status: "rejected",
          error: registryError(
            "E_CONFIG_SPACE_NOT_DECLARED",
            "config_space",
            "descriptor_config_space"
          )
        };
      }
      const declared = declaredTargets(descriptor, request.config_space);
      const byId = new Map(declared.map((target) => [target.target_id, target]));
      const artifactTargets = artifact.targets.filter((target) => {
        const declaredTarget = byId.get(target.target_id);
        return declaredTarget !== undefined;
      });
      let selected = artifactTargets;
      if (request.target_id !== undefined) {
        if (!byId.has(request.target_id)) {
          return {
            ok: false,
            status: "rejected",
            error: registryError("E_TARGET_NOT_DECLARED", "target_id", request.target_id)
          };
        }
        selected = artifactTargets.filter((target) => target.target_id === request.target_id);
      }
      if (selected.length === 0) {
        return {
          ok: false,
          status: "rejected",
          error: registryError(
            "E_TARGET_NOT_DECLARED",
            "registration_artifact",
            `${request.host_id}/${request.mode}/${request.config_space}`
          )
        };
      }
      // Appendix L.3: one hook carrier per host. When a plugin-form target is
      // selected, the plugin's own `hooks/hooks.json` supplies every hook and
      // the settings `json_merge` targets must not be written. A settings hook
      // that still points at the plugin root means the host has both carriers;
      // registering twice duplicates every event upload, so fail with the
      // repair hint instead of silently keeping the duplicate.
      if (request.target_id === undefined) {
        const pluginTargets = selected.filter(
          (target) =>
            byId.get(target.target_id)?.kind === "plugin" &&
            target.write_mode === "artifact_dir"
        );
        if (pluginTargets.length > 0) {
          const pluginRoots = pluginTargets
            .map((target) => expandTemplate(target.root_path ?? target.path_template, hostEnv))
            .filter((path): path is string => path !== null);
          const settingsHookTargets = selected.filter(
            (target) =>
              byId.get(target.target_id)?.kind === "hook_config" &&
              target.write_mode === "json_merge"
          );
          for (const target of settingsHookTargets) {
            const path = expandTemplate(target.path_template, hostEnv);
            if (path === null) continue;
            let text: string;
            try {
              text = readFileSync(path, "utf8");
            } catch {
              continue;
            }
            if (pluginRoots.some((root) => text.includes(root))) {
              return {
                ok: false,
                status: "rejected",
                error: registryError(
                  "E_CONFLICT",
                  "hook_carrier",
                  "settings_and_plugin_remove_settings_hooks"
                )
              };
            }
          }
          selected = selected.filter((target) => !settingsHookTargets.includes(target));
        }
      }
      const artifactTargetsSelected = selected.filter(
        (target) => target.write_mode === "artifact_dir"
      );
      // A host may declare more than one directory target for the same config
      // space (OpenCode 2.2+ accepts both `plugin` and `plugins`). Each target
      // is planned independently; duplicates are rejected by `validatePlanFiles`.
      let releaseArtifact: ReleaseArtifact | null = null;
      const needsRelease =
        artifactTargetsSelected.length > 0 ||
        selected.some(
          (target) =>
            target.write_mode === "json_merge" &&
            (target.entries ?? []).some((entry) => hasCommandPlaceholder(entry.value))
        );
      if (needsRelease) {
        const loaded = loadRelease(descriptor);
        if (loaded !== null && "code" in loaded) {
          return { ok: false, status: "rejected", error: loaded };
        }
        releaseArtifact = loaded;
        if (releaseArtifact === null && options.resolve_installed_artifact === true) {
          releaseArtifact = loadInstalledRelease(
            descriptor,
            selected,
            options.verify_present ?? true,
            hostEnv
          );
        }
      }
      const plans: HostAttachTargetPlan[] = [];
      for (const artifactTarget of selected) {
        const declaredTarget = byId.get(artifactTarget.target_id);
        if (declaredTarget === undefined) {
          return {
            ok: false,
            status: "rejected",
            error: registryError("E_TARGET_NOT_DECLARED", "target_id", artifactTarget.target_id)
          };
        }
        const plan = buildPlan(declaredTarget, artifactTarget, releaseArtifact, hostEnv);
        if ("code" in plan) {
          return { ok: false, status: "rejected", error: plan };
        }
        plans.push(plan);
      }
      const resolution: HostAttachResolution = { descriptor, targets: plans };
      return { ok: true, status: "ok", value: resolution };
    }
  };
}

/**
 * `host.runtime.upload` adapter lookup (DD-HOST-201).
 *
 * The kernel package cannot import adapter libraries, so the app composition
 * root builds the in-process instances here. `normalizeEvent` is a pure
 * function, so a single stateless instance per adapter is enough.
 */
export function createHostRuntimeAdapterResolver(): HostRuntimeAdapterResolverPort {
  // Adapter packages intentionally declare their own structurally-equivalent
  // contract types; the composition root is the single place that narrows
  // them to the kernel ingress surface.
  const adapters = new Map<Id<"adp">, HostRuntimeAdapter>([
    [CLAUDE_ADAPTER_DESCRIPTOR.adapter_id, createClaudeHostAdapter() as unknown as HostRuntimeAdapter],
    [CODEX_ADAPTER_DESCRIPTOR.adapter_id, createCodexHostAdapter() as unknown as HostRuntimeAdapter],
    [OMP_ADAPTER_DESCRIPTOR.adapter_id, createOmpHostAdapter() as unknown as HostRuntimeAdapter],
    [OPENCODE_ADAPTER_DESCRIPTOR.adapter_id, createOpenCodeHostAdapter() as unknown as HostRuntimeAdapter],
    [OPENHANDS_ADAPTER_DESCRIPTOR.adapter_id, createOpenhandsHostAdapter() as unknown as HostRuntimeAdapter],
    [PI_ADAPTER_DESCRIPTOR.adapter_id, createPiHostAdapter() as unknown as HostRuntimeAdapter],
    [STEP_ADAPTER_DESCRIPTOR.adapter_id, createStepCodeHostAdapter() as unknown as HostRuntimeAdapter]
  ]);
  return {
    resolve(input: { readonly registration_hash: Hash; readonly adapter_id: Id<"adp"> }): HostRuntimeAdapter | null {
      return adapters.get(input.adapter_id) ?? null;
    }
  };
}
