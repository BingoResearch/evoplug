/**
 * W9 ServiceProfile production composition.
 *
 * This is the only place that turns committed runtime-probe facts into a
 * ServiceProfile production. It owns no host branches: the backend is selected
 * from the approved generation registry by the declared `host_id`, and the
 * metadata command is the adapter's `rsi.cli_metadata_probe/1` declaration.
 *
 * The factory builds the single W1 runtime-probe producer, wraps its lifecycle
 * so a completed read-only probe triggers one profile action, and exposes the
 * same collector and shutdown drain to the composition root. It never creates a
 * second probe runtime and never issues a synthetic probe request: the exact
 * issued request is reconstructed by W1's own `call_resolver.resolve()` from
 * the committed call row at `issued_at`.
 */

import { canonicalHash, ok } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Result,
  SourceRefPort,
  StateRowPort
} from "@evoplug/core";
import {
  capabilityBindingKey,
  serviceProfileBinding,
  type CapabilityBinding,
  type RuntimeCall
} from "@evoplug/core/host";
import type { BlobStore, SqliteConnection } from "@evoplug/storage";
import {
  createHostStateRowAppendAdapter,
  createKernelProbeEvidenceCollector,
  createPersistedHostServiceProfileAction,
  createRuntimeProbeProducer,
  type CapabilityBindingDeclarationPort,
  type HostRuntimeCallCompletion,
  type HostRuntimeProbeLifecyclePort,
  type KernelProbeEvidence,
  type KernelProbeEvidencePort,
  type KernelProbeEvidenceRequest,
  type KernelProbeObservationSource,
  type PersistedHostServiceProfileAction,
  type ProbeFeatureOptions,
  type ResolvedFeatures,
  type RuntimeProbeProducer,
  type ServiceProfileObservationCollector,
  type ServiceProfilePolicy
} from "@evoplug/kernel";

import type {
  NativeGenerationBackendEntry,
  NativeGenerationBackendRegistry
} from "./review-generation.js";
import { resolveGenerationExecutable } from "./review-generation.js";

const PROFILE_REQUEST_PREFIX = "svcprof:";
const DEFAULT_PROFILE_DEADLINE_MS = 30_000;
const RUNTIME_DELIVERY_MAX_CHARS = 8_000;
const MAX_DIAGNOSTICS = 128;
const MAX_CACHED_ACTIONS = 32;
const MAX_TRACKED_CALLS = 512;

/* ------------------------------------------------------------------ */
/* Public contracts                                                    */
/* ------------------------------------------------------------------ */

export interface ServiceProfileProbeRegistry {
  /** Adapter binding declaration used by W1's probe producer. */
  readonly binding?: CapabilityBindingDeclarationPort;
  /** Kernel-executed observation source; absent means loaded/unknown only. */
  readonly observation?: KernelProbeObservationSource;
  /** Forwarded to W1. `enabled` is forced on only when runtime_probe is on. */
  readonly options?: Omit<Partial<ProbeFeatureOptions>, "enabled">;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}

export interface ServiceProfileCompositionRegistry {
  /** Approved generation declarations; must enumerate for host selection. */
  readonly generation: NativeGenerationBackendRegistry;
  /** W1 probe declarations and observation source. */
  readonly probe?: ServiceProfileProbeRegistry;
  /**
   * Optional explicit executable selection. Returning null blocks by name.
   * Default: the spec's executable_env, then PATH + binary_name.
   */
  readonly executable_for?: (
    entry: NativeGenerationBackendEntry,
    host_id: string
  ) => string | null;
  /** Optional approved model for commands that list several models. */
  readonly model_for?: (
    entry: NativeGenerationBackendEntry,
    host_id: string
  ) => string | undefined;
  /** Environment used by the default executable resolver. */
  readonly env?: NodeJS.ProcessEnv;
  /** Budget for one metadata read; the producer rejects >600 s. */
  readonly deadline_ms?: number;
  /** Optional token-only policy for limits the host does not report. */
  readonly policy?: ServiceProfilePolicy;
}

/**
 * Composition inputs. The composition root supplies the already-open
 * connection, the CAS, the one journal writer port, the source-ref resolver,
 * the approved generation/probe registry, resolved flags and the clock. It
 * never supplies a binding, executable, metadata spec or model: those are
 * selected from declarations and committed rows.
 */
export interface ServiceProfileCompositionDeps {
  readonly connection: SqliteConnection;
  readonly blobs: Pick<BlobStore, "read" | "putSync" | "relativePath">;
  /** Single FND journal writer port; profile rows use `binding: null`. */
  readonly state_rows: Pick<StateRowPort, "appendStateRows">;
  readonly refs: Pick<SourceRefPort, "resolve">;
  readonly registry: ServiceProfileCompositionRegistry;
  readonly features: Pick<ResolvedFeatures, "runtime_probe" | "cli_generation">;
  readonly now?: () => number;
}

export interface ServiceProfileCompositionDiagnostic {
  readonly at: number;
  readonly stage: string;
  readonly code: string;
  readonly path: string;
  readonly rule: string;
  readonly host_id?: string;
  readonly backend_id?: string;
  readonly call_id?: string;
}

export interface ServiceProfileBackendReadiness {
  readonly backend_id: string;
  readonly host_id: string;
  readonly availability: "available" | "blocked" | "unsupported";
  readonly metadata: "declared" | "missing";
  readonly executable: "resolved" | "missing";
}

export interface ServiceProfileComposition {
  /**
   * The one W1 runtime-probe producer. Null when `runtime_probe` is off.
   * Use its `call_resolver` on the host-runtime service.
   */
  readonly runtime_probe: RuntimeProbeProducer | null;
  /**
   * Lifecycle to pass to host-runtime. It delegates to W1 and additionally
   * starts one profile action after a completed read-only probe.
   */
  readonly lifecycle: HostRuntimeProbeLifecyclePort | undefined;
  /** The W1 collector instance used by both probe and profile production. */
  readonly collector: KernelProbeEvidencePort | null;
  /** Runtime diagnostics from selection, W1 and profile actions (bounded). */
  diagnostics(): readonly ServiceProfileCompositionDiagnostic[];
  /** Per-declared-backend readiness; no host CLI is executed. */
  ready(): readonly ServiceProfileBackendReadiness[];
  /** Awaits in-flight profile actions and W1's own tracked work. */
  drain(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createServiceProfileComposition(
  deps: ServiceProfileCompositionDeps
): ServiceProfileComposition {
  const now = deps.now ?? (() => Date.now());
  const diagnostics: ServiceProfileCompositionDiagnostic[] = [];
  const tasks = new Set<Promise<void>>();
  const retainedIssued = new Map<string, RetainedIssuedProbe>();
  const actions = new Map<string, PersistedHostServiceProfileAction>();
  const actionChains = new Map<string, Promise<void>>();
  const seenCalls = new Set<string>();

  function push(
    stage: string,
    code: string,
    path: string,
    rule: string,
    context: { host_id?: string; backend_id?: string; call_id?: string } = {}
  ): void {
    const diagnostic: ServiceProfileCompositionDiagnostic = {
      at: now(),
      stage,
      code,
      path,
      rule,
      ...(context.host_id === undefined ? {} : { host_id: context.host_id }),
      ...(context.backend_id === undefined ? {} : { backend_id: context.backend_id }),
      ...(context.call_id === undefined ? {} : { call_id: context.call_id })
    };
    diagnostics.push(diagnostic);
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
  }

  function record(
    stage: string,
    error: ErrorEnvelope,
    context: { host_id?: string; backend_id?: string; call_id?: string } = {}
  ): void {
    const details = error.details;
    push(
      stage,
      error.code,
      details?.kind === "field" ? details.path : stage,
      details?.kind === "field" ? details.rule : error.code,
      context
    );
    deps.registry.probe?.on_diagnostic?.(stage, error);
  }

  if (deps.features.runtime_probe !== true) {
    return {
      runtime_probe: null,
      lifecycle: undefined,
      collector: null,
      diagnostics: () => [...diagnostics],
      ready: () => readiness(deps.registry),
      drain: async () => {}
    };
  }

  const collector = createKernelProbeEvidenceCollector({
    blobs: deps.blobs,
    ...(deps.registry.probe?.observation === undefined
      ? {}
      : { source: deps.registry.probe.observation }),
    now
  });
  const runtimeProbe = createRuntimeProbeProducer({
    connection: deps.connection,
    blobs: deps.blobs,
    source_refs: deps.refs,
    state_rows: createHostStateRowAppendAdapter(deps.state_rows),
    ...(deps.registry.probe?.binding === undefined
      ? {}
      : { binding: deps.registry.probe.binding }),
    evidence: collector,
    options: { ...(deps.registry.probe?.options ?? {}), enabled: true },
    now,
    on_diagnostic: (message, error) => {
      if (error === undefined) {
        push(message, "E_PROBE_DIAGNOSTIC", message, "diagnostic");
      } else {
        record(message, error);
      }
    }
  });

  // Selection itself reports an enumerable-registry requirement by name, so a
  // registry that cannot list still produces one bounded diagnostic per call.
  const profileEnabled = deps.features.cli_generation === true;

  const profileCollector: ServiceProfileObservationCollector = {
    async verify(input) {
      const call = input.probe_call;
      if (call === undefined) return ok(false);
      const retained = retainedIssued.get(call.call_id);
      if (retained === undefined) return ok(false);
      if (retained.profile_binding_key !== input.binding_key) return ok(false);
      if (call.binding_key !== input.binding_key) return ok(false);
      let collected: Result<KernelProbeEvidence | null, ErrorEnvelope>;
      try {
        // W1 only accepts the exact issued (base/product) association, so the
        // retained request is what it is called with; the profile binding key
        // stays on the action and is checked above.
        collected = await collector.collect(retained.base_request);
      } catch {
        return ok(false);
      }
      if (!collected.ok) return collected;
      const evidence = collected.value;
      if (evidence === null) return ok(false);
      if (
        evidence.kind !== "probe" ||
        evidence.call_id !== retained.base_request.call_id ||
        evidence.binding_key !== retained.base_request.binding_key
      ) {
        return ok(false);
      }
      return ok(true);
    }
  };

  function track(task: Promise<void>): void {
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  }

  function rememberCall(callId: string): void {
    seenCalls.add(callId);
    if (seenCalls.size <= MAX_TRACKED_CALLS) return;
    const oldest = seenCalls.values().next().value;
    if (oldest !== undefined) seenCalls.delete(oldest);
  }

  const lifecycle: HostRuntimeProbeLifecyclePort = {
    onSessionReady(input) {
      return runtimeProbe.lifecycle.onSessionReady?.(input);
    },
    onSessionPoll(input) {
      return runtimeProbe.lifecycle.onSessionPoll?.(input);
    },
    onPollObserved(input) {
      return runtimeProbe.lifecycle.onPollObserved?.(input);
    },
    async onCallCompleted(input) {
      // W1 applies its probe first, so the profile collector can read the
      // same committed observation after this resolves.
      await runtimeProbe.lifecycle.onCallCompleted?.(input);
      if (!profileEnabled) return;
      if (input.row.kind !== "probe" || input.result.kind !== "probe") return;
      if (seenCalls.has(input.row.call_id)) return;
      rememberCall(input.row.call_id);
      track(
        produceProfile(input).catch(() => {
          push("service_profile.production", "E_SERVICE_PROFILE_BLOCKED", "action", "unexpected_failure", {
            host_id: input.session.host_id,
            call_id: input.row.call_id
          });
        })
      );
    }
  };

  async function produceProfile(input: HostRuntimeCallCompletion): Promise<void> {
    const row = input.row;
    const session = input.session;
    if (row.issued_at === null) {
      push("service_profile.issue", "E_SERVICE_PROFILE_BLOCKED", "row.issued_at", "required", {
        host_id: session.host_id,
        call_id: row.call_id
      });
      return;
    }
    let resolved: Result<RuntimeCall | null, ErrorEnvelope>;
    try {
      resolved = await runtimeProbe.call_resolver.resolve({
        row,
        session,
        now: row.issued_at,
        delivery_max_chars: RUNTIME_DELIVERY_MAX_CHARS
      });
    } catch {
      push("service_profile.issue", "E_SERVICE_PROFILE_BLOCKED", "call_resolver", "threw", {
        host_id: session.host_id,
        call_id: row.call_id
      });
      return;
    }
    if (!resolved.ok) {
      record("service_profile.issue", resolved.error, {
        host_id: session.host_id,
        call_id: row.call_id
      });
      return;
    }
    const call = resolved.value;
    if (call === null || call.kind !== "probe") {
      push("service_profile.issue", "E_SERVICE_PROFILE_BLOCKED", "issued_call", "probe_required", {
        host_id: session.host_id,
        call_id: row.call_id
      });
      return;
    }
    // ServiceProfile production consumes a completed read-only probe only.
    if (call.request.probe_mode !== "read_only") {
      push("service_profile.issue", "E_SERVICE_PROFILE_BLOCKED", "issued_call.probe_mode", "read_only", {
        host_id: session.host_id,
        call_id: row.call_id
      });
      return;
    }
    if (call.request.probe_id !== row.object_ref) {
      push("service_profile.issue", "E_SERVICE_PROFILE_BLOCKED", "issued_call.probe_id", "row_mismatch", {
        host_id: session.host_id,
        call_id: row.call_id
      });
      return;
    }
    const baseBinding = call.request.binding;

    const selected = selectBackend(deps.registry, session.host_id, baseBinding);
    if (!selected.ok) {
      push("service_profile.selection", "E_SERVICE_PROFILE_BLOCKED", selected.path, selected.rule, {
        host_id: session.host_id,
        ...(selected.backend_id === undefined ? {} : { backend_id: selected.backend_id }),
        call_id: row.call_id
      });
      return;
    }
    const entry = selected.entry;
    const executable =
      deps.registry.executable_for?.(entry, session.host_id) ??
      resolveGenerationExecutable(entry.spec, undefined, deps.registry.env ?? process.env);
    if (executable === null || executable.length === 0) {
      push("service_profile.executable", "E_SERVICE_PROFILE_BLOCKED", "executable", "not_resolved", {
        host_id: session.host_id,
        backend_id: entry.spec.backend_id,
        call_id: row.call_id
      });
      return;
    }
    const metadata = entry.spec.metadata_probe;
    if (metadata === undefined) {
      push("service_profile.metadata", "E_SERVICE_PROFILE_BLOCKED", "metadata_probe", "declaration_missing", {
        host_id: session.host_id,
        backend_id: entry.spec.backend_id,
        call_id: row.call_id
      });
      return;
    }
    const modelId = deps.registry.model_for?.(entry, session.host_id);
    const binding = serviceProfileBinding({
      base: baseBinding,
      backend_id: entry.spec.backend_id
    });
    const profileBindingKey = capabilityBindingKey(binding);

    const baseRequest: KernelProbeEvidenceRequest = {
      kind: "probe",
      call_id: row.call_id,
      nonce: call.request.probe_id,
      session_id: session.session_id,
      registration_hash: row.registration_hash,
      artifact_hash: row.artifact_hash,
      binding_key: capabilityBindingKey(baseBinding),
      capabilities: [...call.request.capabilities],
      issued_at: row.issued_at,
      deadline_at: row.deadline_at,
      now: row.issued_at
    };
    const profileCall: KernelProbeEvidenceRequest = {
      ...baseRequest,
      binding_key: profileBindingKey
    };

    const actionKey = actionCacheKey({
      entry,
      executable,
      modelId,
      profileBindingKey
    });
    const action = actionFor(actionKey, {
      entry,
      executable,
      metadata,
      modelId,
      binding,
      profileBindingKey
    });
    await serialize(actionKey, async () => {
      retainedIssued.set(row.call_id, {
        base_request: baseRequest,
        profile_binding_key: profileBindingKey
      });
      try {
        const produced = await action.run({
          request_id: profileRequestId(row.call_id, profileBindingKey),
          deadline_ms: deps.registry.deadline_ms ?? DEFAULT_PROFILE_DEADLINE_MS,
          probe_call: profileCall
        });
        if (!produced.ok) {
          record("service_profile.production", produced.error, {
            host_id: session.host_id,
            backend_id: entry.spec.backend_id,
            call_id: row.call_id
          });
        }
      } finally {
        retainedIssued.delete(row.call_id);
      }
    });
  }

  /**
   * One profile action per binding/executable/model must not race on the same
   * capability row. Different bindings stay independent.
   */
  async function serialize(key: string, task: () => Promise<void>): Promise<void> {
    const previous = actionChains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    actionChains.set(key, current);
    try {
      await current;
    } finally {
      if (actionChains.get(key) === current) actionChains.delete(key);
    }
  }

  function actionFor(
    key: string,
    input: {
      entry: NativeGenerationBackendEntry;
      executable: string;
      metadata: NonNullable<NativeGenerationBackendEntry["spec"]["metadata_probe"]>;
      modelId: string | undefined;
      binding: CapabilityBinding;
      profileBindingKey: Hash;
    }
  ): PersistedHostServiceProfileAction {
    const cached = actions.get(key);
    if (cached !== undefined) return cached;
    const action = createPersistedHostServiceProfileAction({
      connection: deps.connection,
      blobs: deps.blobs,
      source_refs: deps.refs,
      state_rows: deps.state_rows,
      collector: profileCollector,
      config: {
        binding: input.binding,
        backend_id: input.entry.spec.backend_id,
        executable: input.executable,
        metadata: input.metadata,
        ...(input.modelId === undefined ? {} : { model_id: input.modelId }),
        ...(deps.registry.env === undefined ? {} : { env: deps.registry.env }),
        ...(deps.registry.policy === undefined ? {} : { policy: deps.registry.policy })
      },
      now
    });
    actions.set(key, action);
    if (actions.size > MAX_CACHED_ACTIONS) {
      const oldest = actions.keys().next().value;
      if (oldest !== undefined) actions.delete(oldest);
    }
    return action;
  }

  return {
    runtime_probe: runtimeProbe,
    lifecycle,
    collector,
    diagnostics: () => [...diagnostics],
    ready: () => readiness(deps.registry),
    async drain() {
      await Promise.allSettled([...tasks]);
      await runtimeProbe.drain();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Selection helpers                                                   */
/* ------------------------------------------------------------------ */

interface RetainedIssuedProbe {
  readonly base_request: KernelProbeEvidenceRequest;
  readonly profile_binding_key: Hash;
}

type BackendSelection =
  | { readonly ok: true; readonly entry: NativeGenerationBackendEntry }
  | {
      readonly ok: false;
      readonly path: string;
      readonly rule: string;
      readonly backend_id?: string;
    };

function selectBackend(
  registry: ServiceProfileCompositionRegistry,
  hostId: string,
  base: CapabilityBinding
): BackendSelection {
  const list = registry.generation.list?.();
  if (list === undefined) {
    return { ok: false, path: "registry.list", rule: "not_enumerable" };
  }
  const byBackend = (entry: NativeGenerationBackendEntry): boolean =>
    base.backend_id === undefined || entry.spec.backend_id === base.backend_id;
  const hostEntries = list.filter(
    (entry) => entry.spec.host_id === hostId && byBackend(entry)
  );
  if (hostEntries.length === 0) {
    return { ok: false, path: "backend_id", rule: "not_selected" };
  }
  const available = hostEntries.filter((entry) => entry.spec.availability === "available");
  if (available.length === 0) {
    return {
      ok: false,
      path: "availability",
      rule: "blocked",
      backend_id: hostEntries[0]!.spec.backend_id
    };
  }
  const declared = available.filter((entry) => entry.spec.metadata_probe !== undefined);
  if (declared.length === 0) {
    return {
      ok: false,
      path: "metadata_probe",
      rule: "declaration_missing",
      backend_id: available[0]!.spec.backend_id
    };
  }
  if (declared.length > 1) {
    return {
      ok: false,
      path: "backend_id",
      rule: "ambiguous",
      backend_id: declared[0]!.spec.backend_id
    };
  }
  return { ok: true, entry: declared[0]! };
}

function readiness(
  registry: ServiceProfileCompositionRegistry
): readonly ServiceProfileBackendReadiness[] {
  const list = registry.generation.list?.() ?? [];
  return list.map((entry) => {
    const executable =
      registry.executable_for?.(entry, entry.spec.host_id) ??
      resolveGenerationExecutable(entry.spec, undefined, registry.env ?? process.env);
    return {
      backend_id: entry.spec.backend_id,
      host_id: entry.spec.host_id,
      availability: entry.spec.availability,
      metadata: entry.spec.metadata_probe === undefined ? "missing" : "declared",
      executable: executable === null || executable.length === 0 ? "missing" : "resolved"
    };
  });
}

function actionCacheKey(input: {
  entry: NativeGenerationBackendEntry;
  executable: string;
  modelId: string | undefined;
  profileBindingKey: Hash;
}): string {
  return [
    input.entry.spec.backend_id,
    input.profileBindingKey,
    input.executable,
    input.modelId ?? ""
  ].join("\u0000");
}

function profileRequestId(callId: string, bindingKey: Hash): string {
  // Stable for one completed call, bounded well below the producer's 128
  // character request-id limit.
  return `${PROFILE_REQUEST_PREFIX}${canonicalHash({ call_id: callId, binding_key: bindingKey })}`;
}
