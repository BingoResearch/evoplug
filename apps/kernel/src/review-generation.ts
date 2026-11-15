/**
 * Native review generation selected by an explicit persisted HOST binding.
 *
 * W9: this module no longer knows which host it is serving. Adapters declare a
 * structure-only generation spec (binary, argv, transport, protocol, timeout,
 * cancel signal) and the composition root supplies the approved registry. The
 * only host-shaped operation left is resolving the declared binary on PATH,
 * which is driven by the spec's own fields.
 *
 * The legacy default registry carries the single OpenCode entry that already
 * had S evidence, so existing public behaviour is unchanged until the
 * bootstrap supplies the full seven-host registry.
 */

import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { canonicalHash, hashBytes, toJsonValue, type Hash } from "@evoplug/core";
import {
  adapterErr,
  adapterOk,
  capabilityBindingKey,
  validateCapabilityBinding,
  validateCapabilityRecord,
  type CapabilityBinding,
  type GenerationBackendRef,
  type AdapterBackendSelection,
  type GenerationCapabilityBinding,
  type HostAdapterResult,
  type HostGenerationAdapterPort
} from "@evoplug/core/host";
import {
  createOpenCodeCliBackend,
  createOpenCodeCliGenerationAdapter,
  OPENCODE_GENERATION_SPEC
} from "@evoplug/adapter-opencode";
import type { EvoplugConfig, GenerationBlobPorts } from "@evoplug/kernel";
import {
  createCliGenerationAdapter,
  createCliGenerationBackend,
  createGenerationSpecRegistry,
  createReviewGenerationPromptBuilder,
  type CliGenerationSpec,
  type ReviewGenerationPromptBuilder
} from "@evoplug/kernel";
import type { SqliteConnection } from "@evoplug/storage";

export { createReviewGenerationPromptBuilder, type ReviewGenerationPromptBuilder } from "@evoplug/kernel";

/**
 * Structural subset of `CliGenerationSpec` that the composition needs. It is
 * declared here so this app module does not depend on a kernel subpath before
 * the public export lands; adapter declarations satisfy it structurally.
 */
export interface NativeGenerationSpec {
  readonly backend_id: string;
  readonly host_id: string;
  readonly backend_version: string;
  readonly binary_name: string;
  readonly executable_env?: string;
  readonly argv_template: readonly string[];
  readonly prompt_transport: CliGenerationSpec["prompt_transport"];
  /**
   * Declared output shape. These fields stay structural so callers can read
   * extraction provenance without casting the declaration to a wider type.
   */
  readonly output_protocol: CliGenerationSpec["output_protocol"];
  readonly result_field?: NonNullable<CliGenerationSpec["result_field"]>;
  readonly output_extract?: NonNullable<CliGenerationSpec["output_extract"]>;
  readonly output_normalization?: NonNullable<CliGenerationSpec["output_normalization"]>;
  readonly timeout_ms: number;
  readonly cancel_signal: CliGenerationSpec["cancel_signal"];
  readonly availability: "available" | "blocked" | "unsupported";
  readonly blocker_code?: string;
  readonly glue_script?: string;
  /** Adapter-owned read-only metadata declaration for ServiceProfile production. */
  readonly metadata_probe?: CliGenerationSpec["metadata_probe"];
  /** Adapter-owned marker for the legacy #44 explicit selection. */
  readonly legacy_default_backend?: boolean;
}

/** One approved backend: its declaration plus the kernel-owned factories. */
export interface NativeGenerationBackendEntry {
  readonly spec: NativeGenerationSpec;
  create_backend(input: {
    readonly spec: NativeGenerationSpec;
    readonly executable: string;
    readonly backend_version: string;
    readonly approval_ref: string;
  }): GenerationBackendRef;
  create_adapter(input: {
    readonly spec: NativeGenerationSpec;
    readonly executable: string;
    readonly glue_root?: string;
    readonly prompt_builder?: ReviewGenerationPromptBuilder;
    readonly ports: GenerationBlobPorts;
  }): HostGenerationAdapterPort;
}

/** Approved backends; the composition root decides which host entries exist. */
export interface NativeGenerationBackendRegistry {
  resolve(backend_id: string): NativeGenerationBackendEntry | null;
  /**
   * Optional enumeration for declaration-driven selection (ServiceProfile).
   * A registry that cannot enumerate stays usable for generation but cannot
   * select a host automatically.
   */
  list?(): readonly NativeGenerationBackendEntry[];
}

export interface NativeReviewGenerationOptions {
  readonly binding_key: Hash;
  readonly executable?: string;
  /**
   * Registry supplied by bootstrap. When omitted the legacy OpenCode entry is
   * used so the existing public wiring keeps working during the migration.
   */
  readonly backends?: NativeGenerationBackendRegistry;
  /** Directory that contains adapter glue scripts (OpenHands Python). */
  readonly glue_root?: string;
  /**
   * Review-owned prompt composer. Defaults to the protocol-aware builder so a
   * real CLI host receives the rsi.generator_protocol/1 output contract.
   */
  readonly prompt_builder?: ReviewGenerationPromptBuilder;
}

export interface NativeReviewGeneration {
  readonly generation_adapter_factory: (ports: GenerationBlobPorts) => HostGenerationAdapterPort;
  readonly host_contract: () => CapabilityBinding | null;
  readonly credential_ref: string;
}

/**
 * Builds the approved-registry port from adapter-declared specs. The
 * composition root supplies the declarations it approves; this helper adds no
 * host knowledge, so a new host never requires a kernel or app branch.
 */
export function createDeclaredGenerationRegistry(
  specs: readonly CliGenerationSpec[],
  options: {
    readonly glue_root?: string;
    readonly prompt_builder?: ReviewGenerationPromptBuilder;
  } = {}
): NativeGenerationBackendRegistry {
  const registry = createGenerationSpecRegistry(specs);
  const promptBuilder = options.prompt_builder ?? createReviewGenerationPromptBuilder();
  const entries = specs.map((input) => {
    const spec = registry.resolve(input.backend_id)!;
    return {
      spec,
      create_backend: ({ executable, backend_version, approval_ref }: { readonly executable: string; readonly backend_version: string; readonly approval_ref: string }) =>
        createCliGenerationBackend(spec, {
          executable,
          backend_version,
          approval_ref
        }),
      create_adapter: ({ executable, ports, glue_root, prompt_builder }: { readonly executable: string; readonly ports: GenerationBlobPorts; readonly glue_root?: string; readonly prompt_builder?: ReviewGenerationPromptBuilder }) =>
        createCliGenerationAdapter({
          spec,
          executable,
          ports,
          prompt_builder: prompt_builder ?? promptBuilder,
          ...(glue_root === undefined && options.glue_root === undefined ? {} : { glue_root: glue_root ?? options.glue_root })
        })
    } satisfies NativeGenerationBackendEntry;
  });
  const byId = new Map(entries.map((entry) => [entry.spec.backend_id, entry]));
  return {
    list(): readonly NativeGenerationBackendEntry[] {
      return entries;
    },
    resolve(backend_id: string): NativeGenerationBackendEntry | null {
      return byId.get(backend_id) ?? null;
    }
  };
}

const GENERATION_ACTIONS = ["create", "auth", "cancel", "recover", "output"] as const;

/**
 * Transitional default registry.
 *
 * `generation.cli_backend` stays off by default, so the legacy #44 explicit
 * OpenCode selection keeps using the original `createOpenCodeCliGenerationAdapter`
 * path. The entry is built from the adapter-declared `OPENCODE_GENERATION_SPEC`;
 * the adapter owns the declaration and the `legacy_default_backend` marker,
 * while this composition root only reads data.
 */
const LEGACY_OPENCODE_SPEC: NativeGenerationSpec = OPENCODE_GENERATION_SPEC;

/** The pre-W9 OpenCode wiring, expressed as declared data instead of a branch. */
const OPENCODE_BACKENDS: NativeGenerationBackendRegistry = {
  list() {
    const entry = this.resolve(LEGACY_OPENCODE_SPEC.backend_id);
    return entry === null ? [] : [entry];
  },
  resolve(backend_id) {
    if (!LEGACY_OPENCODE_SPEC.legacy_default_backend) return null;
    if (backend_id !== LEGACY_OPENCODE_SPEC.backend_id) return null;
    return {
      spec: LEGACY_OPENCODE_SPEC,
      create_backend: ({ executable, backend_version, approval_ref }) =>
        createOpenCodeCliBackend({
          executable,
          backend_version,
          approval_ref
        }),
      create_adapter: ({ executable, ports }) =>
        createOpenCodeCliGenerationAdapter({
          ...ports,
          executable
        })
    };
  }
};

function executableAt(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the declared entry without host-specific knowledge:
 * explicit selection, then the spec's interpreter environment, then PATH.
 */
export function resolveGenerationExecutable(
  spec: NativeGenerationSpec,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv
): string | null {
  if (explicit !== undefined) {
    return executableAt(explicit) ? explicit : null;
  }
  if (spec.executable_env !== undefined) {
    const configured = env[spec.executable_env];
    if (configured !== undefined && configured.length > 0) {
      return executableAt(configured) ? configured : null;
    }
  }
  const entries = (env["PATH"] ?? "").split(delimiter).filter(isAbsolute);
  for (const directory of entries) {
    const candidate = join(directory, spec.binary_name);
    if (executableAt(candidate)) return candidate;
  }
  return null;
}

function executableMatches(executable: string | null, binding: CapabilityBinding | null): boolean {
  if (executable === null || binding?.binary_pin.binary_hash == null) return false;
  try {
    return hashBytes(readFileSync(executable)) === binding.binary_pin.binary_hash;
  } catch {
    return false;
  }
}

/** No CLI probing, provider lookup or generation is performed during composition. */
export function createNativeReviewGeneration(input: {
  readonly connection: SqliteConnection;
  readonly config: EvoplugConfig;
  readonly selection: NativeReviewGenerationOptions;
}): NativeReviewGeneration | undefined {
  const approved = input.config.review_backend;
  if (!approved.enabled) return undefined;
  const registry = input.selection.backends ?? OPENCODE_BACKENDS;
  const entry = registry.resolve(approved.backend_id);
  if (entry === null) return undefined;
  const spec = entry.spec;
  const { connection, selection } = input;
  const promptBuilder = selection.prompt_builder ?? createReviewGenerationPromptBuilder();

  const hostContract = (): CapabilityBinding | null => {
    const row = connection.prepare(
      "SELECT binding_json FROM capability_record WHERE binding_key = :key AND name = 'generation.service_profile'"
    ).get({ key: selection.binding_key });
    if (row === undefined) return null;
    try {
      const parsed = validateCapabilityBinding(JSON.parse(String(row["binding_json"])));
      if (!parsed.ok) return null;
      const binding = parsed.value;
      return capabilityBindingKey(binding) === selection.binding_key &&
        binding.subject === "host_contract" && binding.adapter_version === "diagnostic" &&
        binding.mapping === "exact" && binding.host_id === spec.host_id &&
        binding.backend_id === approved.backend_id && binding.config_space === input.config.config_space
        ? binding : null;
    } catch {
      return null;
    }
  };

  return {
    host_contract: hostContract,
    credential_ref: approved.secret_ref ?? `${spec.backend_id}:cli-inherited`,
    generation_adapter_factory(ports) {
      const executable = resolveGenerationExecutable(spec, selection.executable, process.env);
      const adapter = entry.create_adapter({
        spec,
        executable: executable ?? selection.executable ?? spec.binary_name,
        ...(selection.glue_root === undefined ? {} : { glue_root: selection.glue_root }),
        prompt_builder: promptBuilder,
        ports
      });
      const nativeCreate = adapter.create.bind(adapter);
      adapter.create = async (request, signal) => {
        const binding = hostContract();
        if (!executableMatches(executable, binding) || request.backend.backend_version !== binding?.source_pin.host_version) {
          return adapterErr({ code: "E_CONFLICT", retryable: false, detail_ref: request.snapshot_ref, observed_at: Date.now() });
        }
        const current = selectBoundBackend();
        if (!current.ok) return current;
        if (current.value.state !== "available" ||
            current.value.backend?.capability_snapshot_hash !== request.backend.capability_snapshot_hash) {
          return adapterErr({ code: "E_CONFLICT", retryable: false, detail_ref: request.snapshot_ref, observed_at: Date.now() });
        }
        return nativeCreate(request, signal);
      };
      const nativeSelect = adapter.selectBackend.bind(adapter);
      adapter.selectBackend = async (request, signal) => {
        const selected = await nativeSelect(request, signal);
        if (!selected.ok || selected.value.state !== "available") return selected;
        return selectBoundBackend();
      };
      const selectBoundBackend = (): HostAdapterResult<AdapterBackendSelection> => {
        if (spec.availability !== "available") {
          return adapterOk({
            state: "blocked_no_backend",
            reason: "capability_unsupported",
            missing: GENERATION_ACTIONS.map((action) => ({
              name: `generation.${action}` as GenerationCapabilityBinding["name"],
              capability_id: `cap:${spec.backend_id}.${action}` as GenerationCapabilityBinding["capability_id"],
              status: "unknown",
              evidence_stage: "static",
              evidence_refs: []
            })),
            evidence_refs: []
          });
        }
        const binding = hostContract();
        if (binding === null || !executableMatches(executable, binding)) {
          return adapterOk({ state: "blocked_no_backend", reason: "capability_unknown", missing: [], evidence_refs: [] });
        }
        const base = entry.create_backend({
          spec,
          executable: executable!,
          backend_version: binding.source_pin.host_version,
          approval_ref: `review_backend:${approved.backend_id}`
        });
        const capabilities = { ...base.capabilities };
        for (const action of GENERATION_ACTIONS) {
          const row = connection.prepare(
            "SELECT * FROM capability_record WHERE binding_key = :key AND name = :name"
          ).get({ key: selection.binding_key, name: `generation.${action}` });
          if (row === undefined) continue;
          try {
            const record = validateCapabilityRecord({
              schema_version: "rsi.capability/2",
              ...row,
              binding: JSON.parse(String(row["binding_json"])),
              evidence_refs: JSON.parse(String(row["evidence_refs_json"])),
              details: JSON.parse(String(row["details_json"]))
            });
            if (!record.ok || record.value.binding_key !== selection.binding_key) continue;
            const value = record.value;
            if (value.status === "verified" && value.probe_result !== "passed") continue;
            capabilities[action] = {
              name: `generation.${action}`,
              capability_id: value.capability_id,
              status: value.status,
              evidence_stage: value.evidence_stage,
              evidence_refs: value.evidence_refs,
              ...(value.probe_result === undefined ? {} : { probe_result: value.probe_result })
            } satisfies GenerationCapabilityBinding;
          } catch {
            // Malformed evidence keeps this capability unknown.
          }
        }
        const missing = [capabilities.create, capabilities.auth, capabilities.output]
          .filter((capability) => capability.status !== "verified");
        if (missing.length > 0) {
          return adapterOk({
            state: "blocked_no_backend",
            reason: missing.some((capability) => capability.status === "failed") ? "capability_failed" : "capability_unknown",
            missing,
            evidence_refs: []
          });
        }
        const backend: GenerationBackendRef = {
          ...base,
          capabilities,
          capability_snapshot_hash: canonicalHash(toJsonValue({
            binding_key: selection.binding_key,
            executable: base.entry_ref,
            capabilities
          }))
        };
        return adapterOk({ state: "available", backend, evidence_refs: [] });
      };
      return adapter;
    }
  };
}
