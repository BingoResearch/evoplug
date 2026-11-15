/**
 * Kernel process bootstrap (DD-FND-024, DD-FND-040, DD-FND-100).
 *
 * Fixed startup order: read the initialized home, acquire the single-writer
 * lock, open SQLite and admit the bundled version, run migrations, scan and
 * replay the journal, compose the IPC handlers, then bind the UDS. Only after
 * every step succeeds is the status axis `ready`.
 */

import { join } from "node:path";

import {
  BlobStore,
  SCHEMA_MAJOR,
  JournalWriter,
  createFndLiveCommitPort,
  createFndStateRowPort,
  createJournalCommitter,
  createSqliteDriver,
  createTransactionRunner,
  listJournalStates,
  openConfiguredConnection
} from "@evoplug/storage";
import type { JournalCommitter, SqliteConnection } from "@evoplug/storage";
import type { Clock, ErrorEnvelope, HostEventBinding } from "@evoplug/core";
import { makeErrorEnvelope, newId, systemClock } from "@evoplug/core";
import {
  createOriginProofPort,
  deriveIdentityQuality,
  finalizeHostEventBinding,
  selectSourceSeq
} from "@evoplug/core/host";
import type {
  NormalizedHostEventDraft,
  ReviewSchedulerPort,
  StateRowLiveCommitPort
} from "@evoplug/core/host";
import { IpcServer, IpcServerStartError } from "@evoplug/ipc";
import type {
  FeatureFlag,
  GenerationBlobPorts,
  HostRuntimeAdapter,
  HostRuntimeAdapterResolverPort,
  IdempotencyJournalPort,
  KernelComposition,
  KernelServicePorts,
  KernelServices,
  MigrationsLocation,
  OnlinePipeline,
  OnlinePipelineDeps,
  OutboxDeliveryPort,
  OutboxWorker,
  RuntimeDeliveryBridge,
  RuntimeProbeProducer,
  KernelProbeObservationSource,
  SemanticBackendPort
} from "@evoplug/kernel";
import type {
  JevTransportCompositionBlockedReason,
  JevTransportInjection
} from "@evoplug/kernel";
import type { IpcHandler } from "@evoplug/ipc";
import {
  acquireWriterLock,
  committedEvent,
  composeKernelHandlers,
  createKernelReviewServices,
  createPersistedReviewJudgeComposition,
  createKernelServices,
  createDefaultOnlineRunner,
  createDefaultProgressPipeline,
  createProgressBoundaryProducer,
  assertExperienceProjectionCreationEvents,
  createHostStateRowAppendAdapter,
  createDefaultQpComposer,
  createDefaultEvidenceComposition,
  createFndDispatchAuditAppend,
  createProductionEvidenceSupplement,
  createDeliveryEpochInvalidator,
  createDeliveryTransitionWriter,
  createInputEpochExpiryHook,
  createEvidenceBindingReadPort,
  composeDefaultJevTransport,
  guardInjectedJevTransport,
  createOnlinePipeline,
  createOutboxWorker,
  createPostCommitHook,
  createReviewWorkerLoop,
  createDurableReviewWorkerDeliveryPort,
  createBlobBackedGenerationPorts,
  createRootRegistry,
  createRootResolver,
  createRuntimeDeliveryBridge,
  createRuntimeCallResolverRouter,
  createRuntimeHumanAttestation,
  createUploadCommittedHumanAttestation,
  type RuntimeHumanAttestation,
  type UploadCommittedHumanAttestation,
  createNativeCaptureObservationSource,
  createWriteApplyRollbackExecutor,
  createSourceRefPort,
  proofGatedMethods,
  UNAVAILABLE_DOMAIN_METHODS,
  createSqliteGcPort,
  createSqliteIdempotencyStore,
  createSqliteStatusPort,
  createJournalIdempotencyJournal,
  discoverMigrationsLocation,
  homeLayout,
  internalError,
  kernelError,
  openKernelDatabase,
  readConfigFile,
  resolveFeatureConfig,
  resolveDispatchMode,
  resolveFeatures,
  resolveJudgeDispatch,
  createConfigHandlers,
  recoverKernelJournals,
  sweepHostRuntime,
  verifyHomeCompatibility,
  type DefaultOnlineRunner,
  type EvoplugConfig,
  type KernelDatabase,
  type KernelReviewServices,
  type NormalizedTriggerContext,
  type ReviewWorkerLoop,
  type ReviewWorkerLoopOptions,
  type ReviewServiceOptions,
  type RuntimeFacts,
  type WriterLock
} from "@evoplug/kernel";
import { createHostRuntimeAdapterResolver, createPackagedGenerationRegistry, createPackagedProbeObservationRegistry, createProbeBindingDeclarationPort } from "./host-registry.js";
import { createNativeReviewGeneration, type NativeReviewGenerationOptions } from "./review-generation.js";
import { createPersistedFeedbackIntentModel } from "./feedback-intent-model.js";
import { createServiceProfileComposition, type ServiceProfileComposition } from "./service-profile-composition.js";
import { createPersistedConfigComposition, type PersistedConfigCompositionOptions } from "./config-persisted-composition.js";
import type { ConfigComposition } from "./config-composition.js";
import { resolvePersistedHostModel } from "./config-model-selection.js";
import { configError, type ConfigError } from "@evoplug/core/config";

export type KernelFailureExitCode = 3 | 4 | 5;

export interface KernelStartupFailure {
  readonly ok: false;
  readonly exit_code: KernelFailureExitCode;
  readonly error: ErrorEnvelope;
}

export type OnlinePipelineBootstrapStatus =
  | {
      readonly status: "composed";
      readonly source: "pipeline" | "dependencies" | "default";
      readonly detail?: string;
    }
  | {
      readonly status: "not_composed";
      readonly reason:
        | "host_trigger_facts_unavailable"
        | "event_ingest_unavailable"
        | "commit_port_unavailable";
      readonly detail: string;
      /**
       * Default-ingest diagnostics for the normalization context that online
       * admission cannot consume. Absent when event.ingest is missing.
       */
      readonly observation?: HostTriggerObservation;
    };

export type ReviewGenerationBootstrapStatus =
  | { readonly status: "enabled" }
  | {
      readonly status: "disabled";
      readonly reason:
        | "host_generation_port_unavailable"
        | "credential_ref_unavailable"
        | "generation_runner_unavailable";
      readonly detail: string;
    };

export type JevTransportBootstrapStatus =
  | {
      readonly status: "injected";
      readonly profile_key?: string;
      readonly detail: string;
    }
  | {
      readonly status: "composed";
      readonly profile_key: string;
      readonly detail: string;
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | JevTransportCompositionBlockedReason
        | "no_transport_injected"
        | "conflicting_transport_sources"
        | "custom_services";
      readonly detail: string;
      readonly error: ErrorEnvelope | null;
    };

export interface RunningKernel {
  readonly ok: true;
  readonly server: IpcServer;
  readonly composition: KernelComposition;
  readonly config: EvoplugConfig;
  readonly sqlite_version: string;
  /** Domain methods that answer `E_INTERNAL` because no service is wired. */
  readonly missing_methods: readonly string[];
  /** Wired methods that answer `E_INTERNAL` until a HOST capability is supplied. */
  readonly unavailable_methods: readonly string[];
  /** Delivery worker; always present on the default composition. */
  readonly outbox_worker: OutboxWorker | null;
  /** REV background loop; inert while no generation backend is configured. */
  readonly review_worker: ReviewWorkerLoop;
  /**
   * Why the REV worker can or cannot claim generation jobs. The default
   * composition has no `HostGenerationPort`, so this records the concrete
   * blocker instead of leaving the worker silently inert.
   */
  readonly review_generation: ReviewGenerationBootstrapStatus;
  /** HOST runtime delivery bridge; absent only for injected custom services. */
  readonly runtime_delivery_bridge: RuntimeDeliveryBridge | null;
  /** Probe producer; absent while the feature or default service map is disabled. */
  readonly runtime_probe: RuntimeProbeProducer | null;
  readonly service_profile: ServiceProfileComposition | null;
  readonly human_attestation: RuntimeHumanAttestation | null;
  readonly human_upload: UploadCommittedHumanAttestation | null;
  readonly config_autotune:
    | { readonly status: "disabled" }
    | { readonly status: "ready"; readonly composition: ConfigComposition }
    | { readonly status: "blocked"; readonly error: ConfigError };
  /**
   * Whether the online RSI pipeline is attached to `event.ingest`.
   *
   * The default composition reports the concrete missing HOST surface instead
   * of silently leaving online admission inert.
   */
  readonly online_pipeline: OnlinePipelineBootstrapStatus;
  /**
   * How the concrete Jev transport was obtained. `injected` means the caller
   * supplied a complete transport; `composed` means the bootstrap built one
   * from explicit host primitives plus the single persisted binding; `blocked`
   * leaves Jev dispatch fail-closed with the concrete missing input.
   */
  readonly jev_transport: JevTransportBootstrapStatus;
  shutdown(): Promise<void>;
}

export type KernelStart = RunningKernel | KernelStartupFailure;

export const DEFAULT_FEATURE_FLAGS: readonly FeatureFlag[] = [
  "egress",
  "managed_write",
  "config_write",
  "replay"
];

export interface KernelBootstrapOptions {
  readonly home: string;
  readonly product_version: string;
  readonly supported_schema_major?: number;
  readonly services?: KernelServicePorts;
  readonly feature_flags?: readonly FeatureFlag[];
  readonly migrations?: MigrationsLocation;
  readonly idempotency_journal?: IdempotencyJournalPort;
  /** HOST-observed boot mapping; persisted identities alone cannot resolve roots. */
  readonly approved_roots?: ReadonlyMap<string, string>;
  /**
   * HOST delivery override. The default composition starts the outbox worker
   * with the runtime delivery bridge. Supplying `delivery` replaces only the
   * adapter while keeping the same worker; supplying the object without a
   * delivery keeps the bridge port.
   */
  readonly outbox_worker?: {
    readonly delivery?: OutboxDeliveryPort;
    readonly journal?: JournalCommitter;
    /** Enqueues expiry through the same journal when supplying a custom journal. */
    readonly delivery_expiry_sweep_enqueue?: import("@evoplug/kernel").DeliveryExpirySweepEnqueuePort;
    readonly owner?: string;
    readonly interval_ms?: number;
    readonly lease_ms?: number;
  };
  /**
   * REV background worker. The loop always starts after the server is ready;
   * without a generation backend (or its credential/output ports) it stays
   * inert and review jobs remain queued/blocked.
   */
  readonly review_worker?: KernelReviewWorkerBootstrapOptions;
  /** Public native generation selection; never discovers an unselected binding. */
  readonly native_review_generation?: NativeReviewGenerationOptions;
  /** Kernel-executed observations; runtime-supplied uploads cannot implement this trust boundary. */
  readonly runtime_probe_observations?: KernelProbeObservationSource;
  /** Host-observed model and reload ports; persisted policy controls the feature and tunable fields. */
  readonly config_autotune?: Pick<PersistedConfigCompositionOptions,
    "selected" | "reloads" | "reload_sources" | "capacityEvidencePort" | "safetyAudit" | "protectedSubtrees"
  > & Partial<Pick<PersistedConfigCompositionOptions, "model">>;
  /**
   * Online RSI pipeline. A dependency bundle is composed here; a pre-built
   * pipeline is also accepted. When present, `event.ingest` starts it after a
   * successful commit without awaiting it, so the ACK is never blocked.
   */
  readonly online_pipeline?: OnlinePipelineDeps | OnlinePipeline;
  /**
   * Explicit Jev transport supplied by an authorized host composition. The
   * bootstrap never discovers credentials or remote endpoints implicitly.
   */
  readonly jev_transport?: SemanticBackendPort;
  /**
   * Host-owned primitives for composing a Jev transport from the persisted
   * binding. Nothing is discovered implicitly: a missing credential resolver,
   * HTTP executor or explicit endpoint authorization keeps dispatch blocked,
   * and missing/ambiguous profile rows keep their typed resolution error.
   */
  readonly jev_transport_composition?: JevTransportInjection;
  /** Reports a post-commit pipeline failure; it never changes the ACK. */
  readonly online_pipeline_on_error?: (error: ErrorEnvelope) => void;
  /**
   * Wall-clock source for persisted `*_at` fields. Pair it with `clock` when
   * injecting a fake; deadlines are measured only on the monotonic timeline.
   */
  readonly now?: () => number;
  /**
   * Monotonic clock for EVD/Jev deadlines. Defaults to the shared production
   * `systemClock`; a caller that replaces `now` must pass the matching clock
   * so `deadline_at_monotonic_ms` stays on one timeline.
   */
  readonly clock?: Clock;
}

export interface KernelReviewWorkerBootstrapOptions {
  readonly generation?: NonNullable<KernelReviewServices["generation"]>;
  /** Native adapter wrapped with the persisted, verified service-profile reader. */
  readonly generation_adapter?: ReviewServiceOptions["generation_adapter"];
  /**
   * Builds a native adapter with kernel-owned content-addressed I/O. The
   * factory is called during composition; it never runs a generation job.
   */
  readonly generation_adapter_factory?: (
    ports: GenerationBlobPorts
  ) => NonNullable<ReviewServiceOptions["generation_adapter"]>;
  /** Frozen HOST contract used to select the matching profile. */
  readonly host_contract?: ReviewServiceOptions["host_contract"];
  /** Frozen HOST observation for explicit review, never derived from config. */
  readonly host_binding?: HostEventBinding;
  readonly planner?: NonNullable<ReviewServiceOptions["planner"]>;
  readonly judge?: NonNullable<ReviewServiceOptions["judge"]>;
  readonly judge_prepare?: NonNullable<ReviewServiceOptions["judge_prepare"]>;
  readonly judge_dispatch?: NonNullable<ReviewServiceOptions["judge_dispatch"]>;
  /** Explicit experimental policy; recorded separately from a Jev verdict. */
  readonly forced_pass_experiment?: NonNullable<ReviewServiceOptions["forced_pass_experiment"]>;
  readonly worker_id?: string;
  readonly interval_ms?: number;
  readonly retry_ms?: number;
  readonly heartbeat_interval_ms?: number;
  readonly cancel_poll_ms?: number;
  readonly recovery_interval_ms?: number;
  readonly max_stage_jobs_per_tick?: number;
  readonly max_output_rounds?: number;
  /** HOST secret reference used by `generation.authenticate`. */
  readonly credential_ref?: string;
  readonly data_scope_ref?: string;
  readonly delivery?: ReviewWorkerLoopOptions["delivery"];
}

function failure(exitCode: KernelFailureExitCode, error: ErrorEnvelope): KernelStartupFailure {
  return { ok: false, exit_code: exitCode, error };
}

function migrationsFor(moduleUrl: URL): MigrationsLocation | null {
  return discoverMigrationsLocation(moduleUrl);
}

function isOnlinePipeline(
  value: OnlinePipelineDeps | OnlinePipeline
): value is OnlinePipeline {
  return "run" in value && typeof value.run === "function";
}

/** Opens the FND journal writer shared with the service graph (DD-FND-059). */
function openOnlineJournal(
  connection: KernelDatabase["connection"],
  journalDir: string
): { readonly writer: JournalWriter; readonly relative_path: string } | null {
  const states = listJournalStates(connection);
  const latest = states[states.length - 1];
  const journalId = latest?.journal_id ?? "journal-000001";
  const relativePath = latest?.relative_path ?? "journal-000001.rsij";
  const sharedSeq = (): number => {
    const row = connection
      .prepare<{ last_commit_seq: number }>(
        "SELECT last_commit_seq FROM journal_state WHERE journal_id = :journal_id"
      )
      .get({ journal_id: journalId });
    return row === undefined ? 0 : Number(row.last_commit_seq);
  };
  // Recovery has already run before this opener. Passing the persisted
  // prefix, read-only flag and tail state keeps the writer from appending
  // behind an unprojected frame if that ever changes (DD-FND-059).
  const writer = JournalWriter.open({
    file_path: join(journalDir, relativePath),
    journal_id: journalId,
    last_commit_seq: latest?.last_commit_seq ?? 0,
    trusted_prefix_end: latest?.trusted_prefix_end ?? 0,
    ...(latest === undefined
      ? {}
      : { read_only: latest.read_only === 1, tail_state: latest.tail_state }),
    shared_commit_seq: sharedSeq
  });
  return writer.ok ? { writer: writer.value, relative_path: relativePath } : null;
}

/**
 * Wraps `event.ingest` so a committed, non-duplicate event starts the pipeline
 * after the ACK. The returned handler still resolves with the original receipt.
 */
function withOnlinePipeline(
  handler: IpcHandler<"event.ingest">,
  pipeline: OnlinePipeline,
  on_error?: (error: ErrorEnvelope) => void
): IpcHandler<"event.ingest"> {
  const start = createPostCommitHook(pipeline, on_error);
  return async (context) => {
    const result = await handler(context);
    if (result.ok && !result.value.duplicate) {
      start(committedEvent(result.value, context.params.draft));
    }
    return result;
  };
}

/**
 * `HostTriggerFacts` inputs that the default composition cannot obtain today.
 *
 * The normalization context (adapter identity, stream_id, raw_event_ref,
 * kind_candidates, identity_quality) exists in memory at normalize time, but
 * neither `CommittedHostEvent` nor any persisted row carries it. The remaining
 * items have no production observer or dependency factory at all. Listing them
 * keeps the default-ingest diagnostic precise instead of reporting a generic
 * "not composed".
 */
export const UNAVAILABLE_HOST_TRIGGER_INPUTS = [
  "persisted adapter identity / stream_id / raw_event_ref",
  "verified signal observations",
  "stable boundary evidence",
  "pending work refs",
  "job_live observer",
  "auto_quota_exhausted observer",
  "replay_duplicate observer",
  "qp/evd/jev/aggregator/decision/decision_inputs ports"
] as const;

export interface HostNormalizationObservation extends NormalizedTriggerContext {}

export type HostTriggerAdmissionOutcome =
  | "not_trigger_candidate"
  | "online_pipeline_unavailable"
  | "normalization_context_missing"
  | "online_no_op"
  | "online_deferred"
  | "online_completed"
  | "online_failed";

export interface HostTriggerAdmissionDiagnostic {
  readonly at: number;
  readonly event_identity_key: string;
  readonly trigger_kind_candidates: readonly string[];
  readonly observed_context: {
    readonly adapter_id: string;
    readonly stream_id: string;
    readonly raw_event_ref: string;
    readonly identity_quality: "strong" | "weak" | "missing";
    readonly observed_at: number;
  } | null;
  readonly outcome: HostTriggerAdmissionOutcome;
  /** Present only when the event could not be admitted online. */
  readonly error: ErrorEnvelope | null;
}

export interface HostTriggerObservationSnapshot {
  readonly normalized_events: number;
  readonly trigger_candidate_events: number;
  readonly context_missing_events: number;
  /** Number of normalization contexts evicted before their event was committed. */
  readonly evicted_observations: number;
  /** Normalized-but-not-yet-committed contexts; consumed by the ingest ACK. */
  readonly pending_observations: number;
  readonly last: HostTriggerAdmissionDiagnostic | null;
  readonly unavailable_fact_inputs: readonly string[];
}

/**
 * Default-ingest observation of the normalization context.
 *
 * The wrapped resolver records only what the adapter actually reported. The
 * wrapped `event.ingest` consumes the record after the ACK and reports, per
 * committed trigger candidate, which required facts are unavailable. It never
 * synthesizes a trigger kind, a signal, a boundary or pending work; it also
 * never changes the ingest result.
 */
export interface HostTriggerObservation {
  wrapResolver(resolver: HostRuntimeAdapterResolverPort): HostRuntimeAdapterResolverPort;
  wrapIngest(handler: IpcHandler<"event.ingest">): IpcHandler<"event.ingest">;
  /**
   * Hands the observation captured at normalize time to a post-commit consumer
   * in the same process. The context is removed from the pending map exactly
   * once and passed as a value; it is never re-read from a deleted cache entry.
   *
   * The consumer may return a promise. Queued and running consumers are
   * tracked and `drain()` waits for them, so storage is not closed under
   * already-ACKed work.
   */
  wrapIngestWithHandoff(
    handler: IpcHandler<"event.ingest">,
    on_event: (
      event: ReturnType<typeof committedEvent>,
      context: NormalizedTriggerContext | null
    ) => void | Promise<void>
  ): IpcHandler<"event.ingest">;
  /** Waits for queued and running post-commit consumers. */
  drain(): Promise<void>;
  recordOutcome(input: {
    readonly event_identity_key: string;
    readonly trigger_kind_candidates: readonly string[];
    readonly observed_context: HostNormalizationObservation | null;
    readonly outcome: HostTriggerAdmissionOutcome;
    readonly error: ErrorEnvelope | null;
  }): void;
  snapshot(): HostTriggerObservationSnapshot;
}

const TRIGGER_PAYLOAD_KINDS: ReadonlySet<string> = new Set([
  "input.received",
  "tool.call",
  "tool.result",
  "host.boundary",
  "compaction.observed"
]);

export function createHostTriggerObservation(options: {
  readonly now: () => number;
  readonly max_pending?: number;
}): HostTriggerObservation {
  const pending = new Map<string, HostNormalizationObservation>();
  const maxPending = Math.max(1, options.max_pending ?? 32);
  let normalizedEvents = 0;
  let triggerCandidateEvents = 0;
  let contextMissingEvents = 0;
  let evictedObservations = 0;
  let last: HostTriggerAdmissionDiagnostic | null = null;
  /**
   * Post-commit consumers scheduled but not finished, plus wrapped ingest
   * handlers still on the ACK path. `drain()` waits on both so shutdown never
   * closes the journal or database under already-ACKed work.
   */
  const postCommitWork = new Set<Promise<void>>();
  let activeIngestHandlers = 0;

  function schedulePostCommit(run: () => void | Promise<void>, onError: () => void): void {
    let settle: () => void = () => undefined;
    const work = new Promise<void>((resolve) => {
      settle = resolve;
    });
    postCommitWork.add(work);
    const finish = (): void => {
      postCommitWork.delete(work);
      settle();
    };
    // Dispatch on the next event-loop turn: synchronous SQL/blob work in the
    // consumer must not run before the IPC ACK is flushed.
    setImmediate(() => {
      void Promise.resolve()
        .then(run)
        .catch(() => {
          onError();
        })
        .then(finish, finish);
    });
  }

  function missingFactsError(): ErrorEnvelope {
    return makeErrorEnvelope({
      code: "E_EVIDENCE_UNKNOWN",
      category: "source",
      message_key: "error.evidence.unknown",
      stage: "trigger_facts_observe",
      retryable: false,
      side_effect: "none",
      details: {
        kind: "field",
        path: "HostTriggerFacts",
        rule: `missing:${UNAVAILABLE_HOST_TRIGGER_INPUTS.join(",")}`
      }
    });
  }

  function observedContext(
    observation: HostNormalizationObservation
  ): NonNullable<HostTriggerAdmissionDiagnostic["observed_context"]> {
    return {
      adapter_id: observation.adapter_id,
      stream_id: observation.stream_id,
      raw_event_ref: observation.raw_event_ref,
      identity_quality: observation.identity_quality,
      observed_at: observation.observed_at
    };
  }

  function remember(observation: HostNormalizationObservation): void {
    pending.delete(observation.event_identity_key);
    pending.set(observation.event_identity_key, observation);
    while (pending.size > maxPending) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      pending.delete(oldest);
      evictedObservations += 1;
    }
  }

  function observeNormalization(
    input: { readonly raw: { readonly payload_ref: string } },
    draft: NormalizedHostEventDraft
  ): HostNormalizationObservation | null {
    const selected = selectSourceSeq({
      ...(draft.host_binding.native_message_id === undefined
        ? {}
        : { native_message_id: draft.host_binding.native_message_id }),
      ...(draft.host_binding.source_seq_hint === undefined
        ? {}
        : { source_seq_hint: draft.host_binding.source_seq_hint })
    });
    if (!selected.ok) {
      return null;
    }
    const binding = finalizeHostEventBinding(
      draft.host_binding,
      selected.source_seq,
      draft.native_kind,
      0
    );
    if (binding === null) {
      return null;
    }
    return {
      event_identity_key: binding.event_identity_key,
      trigger_kind_candidates: Array.from(draft.kind_candidates),
      host_id: binding.host_id,
      host_version: binding.host_version,
      adapter_id: binding.adapter_id,
      adapter_version: binding.adapter_version,
      implementation_hash: binding.implementation_hash,
      stream_id: binding.stream_id,
      ...(binding.source_seq === undefined ? {} : { source_seq: binding.source_seq }),
      ...(binding.native_occurrence_id === undefined
        ? {}
        : { native_occurrence_id: binding.native_occurrence_id }),
      ...(binding.retry_of === undefined ? {} : { retry_of: binding.retry_of }),
      ...(binding.occurred_at === undefined ? {} : { occurred_at: binding.occurred_at }),
      raw_event_ref: input.raw.payload_ref,
      identity_quality: deriveIdentityQuality({
        native_session_id: binding.native_session_id,
        native_event_id: binding.native_event_id,
        payload_retrievable: true
      }),
      observed_at: options.now()
    };
  }

  function wrapAdapter(adapter: HostRuntimeAdapter): HostRuntimeAdapter {
    return {
      normalizeEvent(input) {
        const result = adapter.normalizeEvent(input);
        if (!result.ok) {
          return result;
        }
        const observation = observeNormalization(input, result.value);
        if (observation !== null) {
          normalizedEvents += 1;
          remember(observation);
        }
        return result;
      }
    };
  }

  function recordOutcome(input: {
    readonly event_identity_key: string;
    readonly trigger_kind_candidates: readonly string[];
    readonly observed_context: HostNormalizationObservation | null;
    readonly outcome: HostTriggerAdmissionOutcome;
    readonly error: ErrorEnvelope | null;
  }): void {
    last = {
      at: options.now(),
      event_identity_key: input.event_identity_key,
      trigger_kind_candidates: input.trigger_kind_candidates,
      observed_context:
        input.observed_context === null ? null : observedContext(input.observed_context),
      outcome: input.outcome,
      error: input.error
    };
  }

  return {
    wrapResolver(resolver) {
      return {
        resolve(input) {
          const adapter = resolver.resolve(input);
          return adapter === null ? null : wrapAdapter(adapter);
        }
      };
    },
    wrapIngest(handler) {
      return async (context) => {
        const result = await handler(context);
        if (!result.ok) {
          return result;
        }
        const key = context.params.draft.event_identity_key;
        const observation = pending.get(key) ?? null;
        pending.delete(key);
        if (result.value.duplicate) {
          return result;
        }
        if (observation === null) {
          if (TRIGGER_PAYLOAD_KINDS.has(context.params.draft.payload.kind)) {
            contextMissingEvents += 1;
            recordOutcome({
              event_identity_key: key,
              trigger_kind_candidates: [],
              observed_context: null,
              outcome: "normalization_context_missing",
              error: missingFactsError()
            });
          }
          return result;
        }
        if (observation.trigger_kind_candidates.length === 0) {
          return result;
        }
        triggerCandidateEvents += 1;
        recordOutcome({
          event_identity_key: key,
          trigger_kind_candidates: observation.trigger_kind_candidates,
          observed_context: observation,
          outcome: "online_pipeline_unavailable",
          error: missingFactsError()
        });
        return result;
      };
    },
    wrapIngestWithHandoff(handler, onEvent) {
      return async (context) => {
        activeIngestHandlers += 1;
        try {
          const result = await handler(context);
          if (!result.ok) {
            return result;
          }
          const key = context.params.draft.event_identity_key;
          const observation = pending.get(key) ?? null;
          pending.delete(key);
          if (result.value.duplicate) {
            return result;
          }
          const event = committedEvent(result.value, context.params.draft);
          if (observation === null) {
            if (!TRIGGER_PAYLOAD_KINDS.has(context.params.draft.payload.kind)) {
              return result;
            }
            contextMissingEvents += 1;
            recordOutcome({
              event_identity_key: key,
              trigger_kind_candidates: [],
              observed_context: null,
              outcome: "normalization_context_missing",
              error: missingFactsError()
            });
            schedulePostCommit(
              () => onEvent(event, null),
              () =>
                recordOutcome({
                  event_identity_key: key,
                  trigger_kind_candidates: [],
                  observed_context: null,
                  outcome: "online_failed",
                  error: missingFactsError()
                })
            );
            return result;
          }
          if (observation.trigger_kind_candidates.length === 0) {
            return result;
          }
          triggerCandidateEvents += 1;
          schedulePostCommit(
            () => onEvent(event, observation),
            () =>
              recordOutcome({
                event_identity_key: key,
                trigger_kind_candidates: observation.trigger_kind_candidates,
                observed_context: observation,
                outcome: "online_failed",
                error: missingFactsError()
              })
          );
          return result;
        } finally {
          activeIngestHandlers -= 1;
        }
      };
    },
    async drain() {
      while (activeIngestHandlers > 0 || postCommitWork.size > 0) {
        await Promise.all([...postCommitWork]);
        if (activeIngestHandlers > 0 && postCommitWork.size === 0) {
          // An ACK path is still between commit and scheduling its consumer.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    },
    recordOutcome,
    snapshot() {
      return {
        normalized_events: normalizedEvents,
        trigger_candidate_events: triggerCandidateEvents,
        context_missing_events: contextMissingEvents,
        evicted_observations: evictedObservations,
        pending_observations: pending.size,
        last,
        unavailable_fact_inputs: UNAVAILABLE_HOST_TRIGGER_INPUTS
      };
    }
  };
}

/** Runs the full startup sequence; a failure leaves nothing bound or locked. */
export async function bootstrapKernel(options: KernelBootstrapOptions): Promise<KernelStart> {
  const now = options.now ?? ((): number => Date.now());
  const clock = options.clock ?? systemClock;
  const layout = homeLayout(options.home);
  try {
    resolveJudgeDispatch(options.review_worker ?? {});
  } catch {
    return failure(3, internalError("kernel.review_judge_configuration_invalid"));
  }

  const config = await readConfigFile(options.home);
  if (!config.ok) {
    return failure(3, config.error);
  }

  const compatibility = await verifyHomeCompatibility({
    home: options.home,
    config: config.value,
    supported_schema_major: options.supported_schema_major ?? SCHEMA_MAJOR
  });
  if (!compatibility.ok) {
    return failure(3, compatibility.error);
  }

  const lock = await acquireWriterLock({ home: options.home, boot_id: newId("ipc"), now });
  if (!lock.ok) {
    return failure(lock.status === "conflict" ? 4 : 3, lock.error);
  }
  const writerLock: WriterLock = lock.value;

  const migrations = options.migrations ?? migrationsFor(new URL("../..", import.meta.url));
  if (migrations === null) {
    await writerLock.release();
    return failure(3, internalError("kernel.migrations_not_found"));
  }

  let database: Awaited<ReturnType<typeof openKernelDatabase>>;
  try {
    database = await openKernelDatabase({
      home: options.home,
      migrations,
      app_version: options.product_version,
      now
    });
  } catch {
    await writerLock.release();
    return failure(5, internalError("kernel.database_open_failed"));
  }
  if (!database.ok) {
    await writerLock.release();
    return failure(3, database.error);
  }
  const db: KernelDatabase = database.value;
  let ready = false;
  let closeIpc = async (): Promise<void> => {};
  let stopWorkers = async (): Promise<void> => {};
  let drainRuntime = async (): Promise<void> => {};
  let stopProducers = async (): Promise<void> => {};
  let closeReview = (): void => {};
  let closeIdempotency = (): void => {};
  let closeRead = (): void => {};
  let closeJournal = (): void => {};
  const safely = async (action: () => void | Promise<void>): Promise<void> => {
    try { await action(); } catch {
      try { options.online_pipeline_on_error?.(internalError("kernel.cleanup_failed")); } catch {}
    }
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    await safely(stopProducers);
    await safely(closeIpc);
    await safely(stopWorkers);
    await safely(drainRuntime);
    await safely(closeReview);
    await safely(closeIdempotency);
    await safely(closeRead);
    await safely(closeJournal);
    await safely(() => db.connection.close());
    await safely(() => writerLock.release());
  })();

  try {
  const blobStore = BlobStore.open(layout.blobs_dir);
  const recovery = await recoverKernelJournals({
    connection: db.connection,
    blob_store: blobStore,
    journal_dir: layout.journal_dir,
    now: now()
  });
  if (!recovery.ok) {
    return failure(5, recovery.error);
  }
  if (recovery.value.degraded_read_only) {
    return failure(5, kernelError("E_REBUILD_DIVERGENCE", { details: { kind: "none" } }));
  }

  // DD-HOST-200.4: startup lease sweep. It only expires runtime rows; it never
  // replays a delivery or resurrects a closed session.
  sweepHostRuntime({ connection: db.connection, now: now() });

  let server: IpcServer | null = null;
  let recoveryState: "closed" | "scanning" | "replaying" | "reconciling_outbox" | "complete" | "failed" = "scanning";
  const featureFlags = options.feature_flags ?? config.value.features ?? DEFAULT_FEATURE_FLAGS;
  const features = resolveFeatures(featureFlags);
  const featureConfig = resolveFeatureConfig(config.value);
  const gcPort = createSqliteGcPort({ connection: db.connection, blob_store: blobStore, now });
  const environment = {
    describe: {
      facts: (): RuntimeFacts => ({
        product_version: options.product_version,
        schema_major: db.schema.schema_major,
        schema_minor: db.schema.schema_minor,
        node_version: process.versions.node,
        sqlite_version: db.sqlite_version,
        sqlite_safe: true,
        read_only: false,
        feature_flags: featureFlags
      })
    },
    status: createSqliteStatusPort({
      connection: db.connection,
      config: config.value,
      now,
      runtime: {
        status: (): "starting" | "ready" | "degraded_read_only" =>
          server === null ? "starting" : recoveryState === "failed" ? "degraded_read_only" : "ready",
        recovery_state: (): typeof recoveryState => recoveryState
      }
    }),
    gc: {
      run: async (params: Parameters<typeof gcPort.run>[0]) => {
        if (params.mode === "apply") {
          sweepHostRuntime({ connection: db.connection, now: now() });
        }
        return gcPort.run(params);
      }
    },
    ipc: {
      activeConnections: (): number => (server === null ? 0 : server.stats.active_connections),
      modeVerified: (): boolean => true
    }
  };

  const needsFeatureJournal = options.services === undefined && (
    features.runtime_probe || features.delivery_ttl || features.evidence_supplement || features.config_autotune || features.feedback_ledger
  );
  const sharedJournal = needsFeatureJournal ? openOnlineJournal(db.connection, layout.journal_dir) : null;
  if (needsFeatureJournal && sharedJournal === null) {
    return failure(5, internalError("kernel.feature_journal_unavailable"));
  }
  let onlineJournal: JournalWriter | null = sharedJournal?.writer ?? null;
  closeJournal = (): void => { onlineJournal?.close(); };
  const deliveryJournal = !features.delivery_ttl || sharedJournal === null
    ? undefined
    : options.outbox_worker?.journal ?? createJournalCommitter({
        writer: sharedJournal.writer,
        connection: db.connection,
        relative_path: sharedJournal.relative_path,
        now
      });
  const deliveryExpiryHook = deliveryJournal === undefined ? undefined : createInputEpochExpiryHook(
    createDeliveryEpochInvalidator({
      connection: db.connection,
      transition: createDeliveryTransitionWriter({ connection: db.connection, journal: deliveryJournal, now }),
      now
    })
  );
  const deliveryEpochTasks = new Set<Promise<void>>();
  const expireCommittedInput = deliveryExpiryHook === undefined ? undefined : (event: Parameters<typeof deliveryExpiryHook>[0]): Promise<void> => {
    const task = deliveryExpiryHook(event).then((result) => {
      if (result !== null && !result.ok) options.online_pipeline_on_error?.(result.error);
    });
    deliveryEpochTasks.add(task);
    void task.then(() => deliveryEpochTasks.delete(task), () => deliveryEpochTasks.delete(task));
    return task;
  };

  // DD-HOST-203 delivery bridge. It is the only producer of
  // `host_runtime_call{kind:"deliver"}` rows and the only consumer of the
  // runtime result bodies (which the runtime service intentionally does not
  // persist). It is skipped for injected custom service maps because those
  // services own their own resolver; the outbox then requires an explicit port.
  const runtimeBridge =
    options.services === undefined
      ? createRuntimeDeliveryBridge({
          connection: db.connection,
          blob_store: blobStore,
          now
        })
      : null;

  drainRuntime = async (): Promise<void> => { runtimeBridge?.close(); };
  const rootRegistry = createRootRegistry({
    connection: db.connection,
    home: options.home,
    layout,
    now,
    ...(options.approved_roots === undefined ? {} : { approved_roots: options.approved_roots })
  });
  const reviewRootResolver = createRootResolver({ registry: rootRegistry, now });
  const reviewSourceRefs = createSourceRefPort({
    connection: db.connection,
    blob_store: blobStore
  });
  const originProof = options.services === undefined && features.feedback_ledger
    ? createOriginProofPort({
        withTx: createTransactionRunner(db.connection).withTx,
        clock,
        sourceRefs: reviewSourceRefs
      })
    : undefined;
  const featureStateRows = sharedJournal === null ? null : createFndStateRowPort({
    connection: db.connection,
    writer: sharedJournal.writer,
    relative_path: sharedJournal.relative_path,
    blob_store: blobStore,
    now
  });
  const serviceProfile = options.services !== undefined || featureStateRows === null
    ? null
    : createServiceProfileComposition({
        connection: db.connection,
        blobs: blobStore,
        refs: reviewSourceRefs,
        state_rows: featureStateRows,
        registry: {
          generation: options.native_review_generation?.backends ?? createPackagedGenerationRegistry(),
          probe: {
            binding: createProbeBindingDeclarationPort(db.connection),
            observation: options.runtime_probe_observations ?? createNativeCaptureObservationSource({
              connection: db.connection,
              blobs: blobStore,
              specs: createPackagedProbeObservationRegistry(),
              session_roundtrip: true,
              now
            }),
            options: { on_attach: featureConfig.probe.on_attach },
            on_diagnostic: (_message, error) => {
              if (error !== undefined) options.online_pipeline_on_error?.(error);
            }
          }
        },
        features,
        now
      });
  const runtimeProbe = serviceProfile?.runtime_probe ?? null;
  stopProducers = async (): Promise<void> => {
    await safely(() => {
      const stopped = runtimeProbe?.stop({ reason: "kernel_shutdown" });
      if (stopped !== undefined && !stopped.ok) options.online_pipeline_on_error?.(stopped.error);
    });
  };
  const stopProbe = stopProducers;
  const humanAttestation = options.services !== undefined || !features.feedback_ledger || featureStateRows === null
    ? null
    : createRuntimeHumanAttestation({
        connection: db.connection,
        state_rows: createHostStateRowAppendAdapter(featureStateRows),
        source_refs: reviewSourceRefs,
        now,
        ...(runtimeProbe === null ? {} : { delegate_call_resolver: runtimeProbe.call_resolver }),
        ...(serviceProfile?.lifecycle === undefined ? {} : { delegate_lifecycle: serviceProfile.lifecycle }),
        on_diagnostic: (_message, error) => {
          if (error !== undefined) options.online_pipeline_on_error?.(error);
        }
      });
  stopProducers = async (): Promise<void> => {
    await safely(() => { humanAttestation?.stop(); });
    await stopProbe();
  };
  const stopAttestationAndProbe = stopProducers;
  const humanUpload = humanAttestation === null ? null : createUploadCommittedHumanAttestation({
    connection: db.connection,
    issue: (input) => humanAttestation.issue(input),
    now,
    on_diagnostic: (_message, error) => {
      if (error !== undefined) options.online_pipeline_on_error?.(error);
    }
  });
  stopProducers = async (): Promise<void> => {
    await safely(() => { humanUpload?.stop(); });
    await stopAttestationAndProbe();
  };
  drainRuntime = async (): Promise<void> => {
    await safely(async () => { await humanUpload?.drain(); });
    await safely(async () => { await humanAttestation?.drain(); });
    await safely(async () => { await serviceProfile?.drain(); });
    runtimeBridge?.close();
  };
  const probeResolver = humanAttestation?.call_resolver ?? runtimeProbe?.call_resolver;
  const probeLifecycle = humanAttestation?.lifecycle ?? serviceProfile?.lifecycle;
  const runtimeCallResolver = runtimeBridge === null && probeResolver === undefined
    ? undefined
    : createRuntimeCallResolverRouter({
        ...(runtimeBridge === null ? {} : { delivery: runtimeBridge.call_resolver }),
        ...(probeResolver === undefined ? {} : { probe: probeResolver })
      });

  const nativeReview = options.native_review_generation === undefined
    ? undefined
    : createNativeReviewGeneration({
        connection: db.connection,
        config: config.value,
        selection: {
          ...options.native_review_generation,
          ...(features.cli_generation ? {
            backends: options.native_review_generation.backends ?? createPackagedGenerationRegistry()
          } : {})
        }
      });
  const reviewOptions: KernelReviewWorkerBootstrapOptions = {
    ...nativeReview,
    ...options.review_worker
  };
  const generationAdapter =
    reviewOptions.generation_adapter ??
    (reviewOptions.generation_adapter_factory === undefined
      ? undefined
      : reviewOptions.generation_adapter_factory(
          createBlobBackedGenerationPorts(blobStore, reviewSourceRefs)
        ));
  const hostTriggerObservation = createHostTriggerObservation({ now });
  const feedbackModel = options.services === undefined && features.feedback_ledger &&
    options.jev_transport === undefined && options.jev_transport_composition !== undefined
    ? await createPersistedFeedbackIntentModel({
        connection: db.connection,
        blobs: blobStore,
        transport: options.jev_transport_composition
      })
    : undefined;

  const defaultServices: KernelServices | null =
    options.services === undefined
      ? createKernelServices({
          connection: db.connection,
          config: config.value,
          now,
          home: options.home,
          blob_store: blobStore,
          layout,
          ...(sharedJournal === null ? {} : { journal: sharedJournal }),
          host_runtime_adapters: hostTriggerObservation.wrapResolver(
            createHostRuntimeAdapterResolver()
          ),
          root_registry: rootRegistry,
          ...(originProof === undefined ? {} : { proof: originProof }),
          ...(features.feedback_ledger ? {
            feedback_intake: {
              enabled: true,
              ...(feedbackModel?.status === "ready" ? { intent_model: feedbackModel.model } : {})
            }
          } : {}),
          ...(expireCommittedInput === undefined ? {} : { delivery_expiry_post_commit: expireCommittedInput }),
          ...(probeLifecycle === undefined ? {} : { host_runtime_probe_lifecycle: probeLifecycle }),
          ...(humanUpload === null ? {} : { host_runtime_upload_committed: humanUpload.onUploadCommitted }),
          ...(runtimeCallResolver === undefined
            ? {}
            : { host_runtime_call_resolver: runtimeCallResolver })
        })
      : null;
  let services: KernelServicePorts = options.services ?? defaultServices ?? {};
  const drainProducers = async (): Promise<void> => {
    await safely(() => hostTriggerObservation.drain());
    await safely(async () => { await defaultServices?.runtime.dispose(); });
    await safely(async () => { await humanUpload?.drain(); });
    await safely(async () => { await humanAttestation?.drain(); });
    await safely(async () => { await serviceProfile?.drain(); });
    await Promise.allSettled([...deliveryEpochTasks]);
    runtimeBridge?.close();
  };
  drainRuntime = drainProducers;
  try {
    await defaultServices?.runtime.feedback_recovery;
  } catch {
    return failure(5, internalError("kernel.feedback_recovery_failed"));
  }

  if (runtimeBridge !== null) {
    const runtimeResult = services["host.runtime.result"];
    if (runtimeResult !== undefined) {
      // The result handler persists only a hash; keep the accepted body so the
      // waiting outbox dispatch can project the delivery axes. The wrapper only
      // observes results the handler accepted (including idempotent replays).
      (services as unknown as Record<string, IpcHandler<"host.runtime.result">>)[
        "host.runtime.result"
      ] = async (context) => {
        const result = await runtimeResult(context);
        if (result.ok) {
          runtimeBridge.observe_result(context.params);
        }
        return result;
      };
    }
  }

  const rollbackExecutor = services["write.apply"] === undefined
    ? undefined
    : createWriteApplyRollbackExecutor({
        connection: db.connection,
        handler: services["write.apply"],
        rootResolver: reviewRootResolver,
        now
      });
  const defaultJudgeDispatch = resolveJudgeDispatch(reviewOptions);
  let composedJudgeDispatch: ReturnType<typeof resolveJudgeDispatch> | undefined;
  const autoComposeJudge = reviewOptions.planner === undefined &&
    reviewOptions.judge === undefined && reviewOptions.judge_prepare === undefined &&
    reviewOptions.judge_dispatch === undefined && reviewOptions.forced_pass_experiment === undefined;
  const reviewServices = createKernelReviewServices({
    connection: db.connection,
    config: config.value,
    home: options.home,
    blob_store: blobStore,
    now,
    layout,
    root_resolver: reviewRootResolver,
    experience_candidates_enabled: features.experience_retrieval,
    rollback_target_resolution_enabled: features.rollback_resolution,
    ...(sharedJournal === null ? {} : { journal: sharedJournal }),
    ...(rollbackExecutor === undefined ? {} : { rollback_executor: rollbackExecutor }),
    ...(reviewOptions.host_binding === undefined ? {} : { host_binding: reviewOptions.host_binding }),
    ...(reviewOptions.generation === undefined ? {} : { generation: reviewOptions.generation }),
    ...(generationAdapter === undefined ? {} : { generation_adapter: generationAdapter }),
    ...(reviewOptions.host_contract === undefined ? {} : { host_contract: reviewOptions.host_contract }),
    ...(reviewOptions.planner === undefined ? {} : { planner: reviewOptions.planner }),
    ...(reviewOptions.judge === undefined ? {} : { judge: reviewOptions.judge }),
    ...(reviewOptions.judge_prepare === undefined ? {} : { judge_prepare: reviewOptions.judge_prepare }),
    ...(autoComposeJudge ? {
      judge_dispatch: {
        dispatch: (input) => (composedJudgeDispatch ?? defaultJudgeDispatch).dispatch(input)
      }
    } : reviewOptions.judge_dispatch === undefined ? {} : { judge_dispatch: reviewOptions.judge_dispatch }),
    ...(reviewOptions.forced_pass_experiment === undefined ? {} : {
      forced_pass_experiment: reviewOptions.forced_pass_experiment
    }),
    ...(reviewOptions.worker_id === undefined ? {} : { worker_id: reviewOptions.worker_id })
  });
  closeReview = (): void => { reviewServices.dispose(); };
  const rollbackRecovery = await reviewServices.reconcileExperienceRollbacks({ now: now() });
  recoveryState = !rollbackRecovery.ok || rollbackRecovery.value.recovery_required > 0
    ? "failed"
    : "complete";
  if (recoveryState === "failed") {
    return failure(
      5,
      rollbackRecovery.ok
        ? internalError("kernel.rollback_recovery_required")
        : internalError("kernel.rollback_recovery_failed")
    );
  }

  if (features.experience_retrieval) {
    const projectionInvariant = assertExperienceProjectionCreationEvents(db.connection);
    if (!projectionInvariant.ok) {
      return failure(5, projectionInvariant.error);
    }
  }

  /**
   * The independent read-only connection the EVD reader must use (DD-FND-024,
   * DD-EVD-024). It is opened before the composition is built and stays open
   * until `shutdown()` has drained every post-commit consumer.
   */
  let onlineReadConnection: SqliteConnection | null = null;
  closeRead = (): void => { onlineReadConnection?.close(); };
  let onlineStatus: OnlinePipelineBootstrapStatus = {
    status: "not_composed",
    reason: "host_trigger_facts_unavailable",
    detail:
      "The default online composition is only installed for the built-in service map. " +
      "Custom services own their event.ingest and online admission; no external pipeline was injected."
  };
  let jevStatus: JevTransportBootstrapStatus =
    options.jev_transport === undefined
      ? {
          status: "blocked",
          reason: "no_transport_injected",
          detail:
            "No Jev transport was injected and no host primitives were supplied for composition; " +
            "Jev dispatch stays fail-closed.",
          error: null
        }
      : {
          status: "injected",
          detail: "The caller supplied a complete Jev transport; the bootstrap performs no discovery."
        };

  if (options.online_pipeline !== undefined) {
    const injected = options.online_pipeline;
    const pipeline = isOnlinePipeline(injected) ? injected : createOnlinePipeline(injected);
    const ingest = services["event.ingest"];
    if (ingest === undefined) {
      onlineStatus = {
        status: "not_composed",
        reason: "event_ingest_unavailable",
        detail: "event.ingest is not present in the service map, so the online pipeline cannot run."
      };
    } else {
      // Mutate in place: `host.runtime.upload` reads `services["event.ingest"]`
      // at call time so it re-enters this same wrapped handler.
      (services as unknown as Record<string, IpcHandler<"event.ingest">>)["event.ingest"] =
        withOnlinePipeline(ingest, pipeline, options.online_pipeline_on_error);
      onlineStatus = {
        status: "composed",
        source: isOnlinePipeline(injected) ? "pipeline" : "dependencies"
      };
    }
  } else if (options.services === undefined) {
    const ingest = services["event.ingest"];
    const journal = sharedJournal ?? openOnlineJournal(db.connection, layout.journal_dir);
    if (journal !== null) onlineJournal = journal.writer;
    if (ingest === undefined) {
      onlineStatus = {
        status: "not_composed",
        reason: "event_ingest_unavailable",
        detail: "event.ingest is not present in the default service map, so online admission cannot run.",
        observation: hostTriggerObservation
      };
    } else if (journal === null) {
      onlineStatus = {
        status: "not_composed",
        reason: "commit_port_unavailable",
        detail:
          "The default trigger admission needs the FND live-commit journal writer, and the shared " +
          "journal could not be opened. Trigger and review admission stay fail-closed.",
        observation: hostTriggerObservation
      };
    } else {
      onlineJournal = journal.writer;
      const readOnly = openConfiguredConnection(createSqliteDriver(), layout.db_path, {
        readOnly: true
      });
      if (!readOnly.ok) {
        return failure(3, readOnly.error);
      }
      onlineReadConnection = readOnly.value.connection;
      const sourceRefs = createSourceRefPort({
        connection: db.connection,
        blob_store: blobStore
      });
      // Jev dispatch accepts either one complete caller transport or host
      // primitives plus the single persisted binding. Supplying both is
      // ambiguous and therefore blocked instead of silently preferring one.
      let jevTransport: SemanticBackendPort | undefined = options.jev_transport;
      if (
        options.jev_transport !== undefined &&
        options.jev_transport_composition !== undefined
      ) {
        jevTransport = undefined;
        jevStatus = {
          status: "blocked",
          reason: "conflicting_transport_sources",
          detail:
            "Both a complete Jev transport and transport composition primitives were supplied; " +
            "the bootstrap does not choose between them, so Jev dispatch stays fail-closed.",
          error: null
        };
      } else if (options.jev_transport !== undefined) {
        const guarded = await guardInjectedJevTransport({
          connection: db.connection,
          binding: createEvidenceBindingReadPort({
            connection: db.connection,
            blobs: blobStore
          }),
          transport: options.jev_transport
        });
        if (guarded.status === "guarded") {
          jevTransport = guarded.transport;
          jevStatus = {
            status: "injected",
            profile_key: guarded.resolved.service_profile_key,
            detail:
              "The caller supplied the Jev execution primitive; dispatch is fenced by the " +
              "persisted capability/profile/validator/budget identity."
          };
        } else {
          jevTransport = undefined;
          jevStatus = {
            status: "blocked",
            reason: "profile_binding_unresolved",
            detail:
              "The caller-supplied Jev transport has no resolved persisted binding, so " +
              "dispatch stays fail-closed.",
            error: guarded.error
          };
        }
      } else if (options.jev_transport_composition !== undefined) {
        const composed = await composeDefaultJevTransport({
          connection: db.connection,
          binding: createEvidenceBindingReadPort({
            connection: db.connection,
            blobs: blobStore
          }),
          injection: options.jev_transport_composition
        });
        if (composed.status === "composed") {
          jevTransport = composed.transport;
          jevStatus = {
            status: "composed",
            profile_key: composed.resolved.service_profile_key,
            detail:
              "The Jev transport was composed from host-injected credential, HTTP and endpoint " +
              "authorization primitives over the single resolved service profile."
          };
        } else {
          jevTransport = undefined;
          jevStatus = {
            status: "blocked",
            reason: composed.reason,
            detail: composed.detail,
            error: composed.error
          };
        }
      }
      const fndCommit = createFndLiveCommitPort({
        connection: db.connection,
        writer: journal.writer,
        relative_path: journal.relative_path,
        blob_store: blobStore,
        now
      });
      // Progress uses the same durable writer resources through the explicit
      // admission-free append ABI; trigger admission keeps its live-gated port.
      const fndRows = createFndStateRowPort({
        connection: db.connection,
        writer: journal.writer,
        relative_path: journal.relative_path,
        blob_store: blobStore,
        now
      });
      const progressDeps = {
        connection: db.connection,
        source_refs: sourceRefs,
        state_rows: createHostStateRowAppendAdapter(fndRows),
        now,
        clock
      };
      const progress = createDefaultProgressPipeline(progressDeps);
      const progressBoundary = features.fresh_home_admission
        ? createProgressBoundaryProducer({
            ...progressDeps,
            commit: fndCommit as unknown as import("@evoplug/core").StateRowLiveCommitPort
          })
        : undefined;
      if (progressBoundary?.reconcile !== undefined) {
        const reconciled = await progressBoundary.reconcile();
        const unresolved = reconciled.ok && reconciled.value.unresolved.length > 0;
        if (!reconciled.ok || unresolved) {
          recoveryState = "failed";
          return failure(5, reconciled.ok
            ? internalError("kernel.progress_recovery_required")
            : reconciled.error);
        }
      }
      // QP is built per admitted binding from the same committed scope and
      // journal. The progress producer above commits the first checkpoint
      // before the factory performs its real evidence-index load.
      const composeQp = createDefaultQpComposer({
        connection: db.connection,
        blob_store: blobStore,
        source_refs: sourceRefs,
        journal: journal.writer,
        journal_relative_path: journal.relative_path,
        now
      });
      // The shared journal and writer connection feed the real EVD writer and
      // `/3` binding reader. The reader gets its own read-only connection so a
      // read never nests a BEGIN inside the writer's transaction. Profile,
      // validator and budget rows are resolved per event; nothing is seeded.
      const dispatchMode = resolveDispatchMode(features, config.value.dispatch);
      const supplement = features.evidence_supplement
        ? createProductionEvidenceSupplement({
            connection: db.connection,
            read_connection: readOnly.value.connection,
            blob_store: blobStore,
            source_refs: sourceRefs,
            journal: journal.writer,
            journal_relative_path: journal.relative_path,
            commit: fndCommit,
            registry: rootRegistry,
            now,
            enabled: true,
            budget: { max_rounds: featureConfig.supplement.max_rounds },
            workspace_max_read_bytes: featureConfig.workspace.read_max_bytes
          })
        : undefined;
      const evidence = createDefaultEvidenceComposition({
        connection: db.connection,
        read_connection: readOnly.value.connection,
        blob_store: blobStore,
        journal: journal.writer,
        journal_relative_path: journal.relative_path,
        source_refs: sourceRefs,
        ...(jevTransport === undefined ? {} : { jev_transport: jevTransport }),
        ...(features.delivery_ttl ? { delivery_ttl: { ttl_ms: featureConfig.delivery.ttl_ms } } : {}),
        ...(dispatchMode === "off" ? {} : {
          dispatch: {
            mode: dispatchMode,
            journal_append: createFndDispatchAuditAppend({
              live_commit: fndCommit,
              now
            })
          }
        }),
        ...(supplement === undefined ? {} : {
          evidence_supplement: {
            port: supplement.port,
            enabled: true,
            budget: { max_rounds: featureConfig.supplement.max_rounds },
            rebuild: supplement.rebuild
          }
        }),
        now,
        clock
      });
      if (autoComposeJudge && jevTransport !== undefined) {
        const composed = createPersistedReviewJudgeComposition({
          connection: db.connection,
          read_connection: readOnly.value.connection,
          blob_store: blobStore,
          journal: journal.writer,
          journal_relative_path: journal.relative_path,
          source_refs: sourceRefs,
          jev_transport: jevTransport,
          evidence_composition: evidence,
          now,
          clock
        });
        composedJudgeDispatch = resolveJudgeDispatch(composed.review_options);
      }
      // The decision/delivery instances are the ones already serving the
      // production IPC handlers, including their ledger journal stage.
      const runtimePorts = defaultServices?.runtime;
      const runner = createDefaultOnlineRunner({
        connection: db.connection,
        blob_store: blobStore,
        source_refs: sourceRefs,
        // REV and FND publish structural mirrors of these ports (DD-FND-059.1,
        // DD-TRG-003); the runtime objects are the real scheduler and the FND
        // live-commit port, so only the nominal brands need erasing here.
        review: reviewServices.scheduler as unknown as ReviewSchedulerPort,
        commit: fndCommit as unknown as StateRowLiveCommitPort,
        qp: composeQp,
        ...(runtimePorts === undefined
          ? {}
          : {
              decision: runtimePorts.decision,
              delivery: runtimePorts.delivery
            }),
        downstream: evidence,
        progress,
        ...(progressBoundary === undefined ? {} : { progress_boundary: progressBoundary }),
        now,
        clock
      });
      (services as unknown as Record<string, IpcHandler<"event.ingest">>)["event.ingest"] =
        hostTriggerObservation.wrapIngestWithHandoff(ingest, (event, context) => {
          const key = event.draft.event_identity_key;
          const candidates = context?.trigger_kind_candidates ?? [];
          // Return the promise so the observation's shutdown drain can wait
          // for this admitted event before the journal and database close.
          return runner.run(event, context).then(
            (result) => {
              if (!result.ok) {
                hostTriggerObservation.recordOutcome({
                  event_identity_key: key,
                  trigger_kind_candidates: candidates,
                  observed_context: context,
                  outcome: "online_failed",
                  error: result.error
                });
                options.online_pipeline_on_error?.(result.error);
                return;
              }
              hostTriggerObservation.recordOutcome({
                event_identity_key: key,
                trigger_kind_candidates: candidates,
                observed_context: context,
                outcome:
                  result.value.status === "completed"
                    ? "online_completed"
                    : result.value.status === "deferred"
                      ? "online_deferred"
                      : "online_no_op",
                error: null
              });
            },
            () => {
              const error = internalError("kernel.online_pipeline_rejected");
              hostTriggerObservation.recordOutcome({
                event_identity_key: key,
                trigger_kind_candidates: candidates,
                observed_context: context,
                outcome: "online_failed",
                error
              });
            }
          );
        });
      onlineStatus = {
        status: "composed",
        source: "default",
        detail:
          "Default trigger/review admission reads the normalization context handed over at ingest, " +
          "the active trigger policy, persisted capabilities and budget, active pending entries, " +
          "live review jobs and the committed boundary event. After admission, the HOST progress " +
          "producer appends a canonical checkpoint through the FND state-row ABI before the real " +
          "QP factory loads the evidence index for the same binding and runs issue discovery/plan " +
          "with its template registry. A produced plan continues through the real local EVD " +
          "writer, independent read-only reader, `/3` binding reader and aggregator using the " +
          "persisted service profile, semantic validator and active judge budget; missing or " +
          "ambiguous rows are field-level errors. Jev dispatch uses only an explicitly supplied " +
          "semantic transport or a transport composed from explicitly injected host primitives, " +
          "and remains fail-closed when its profile, authorization or binding " +
          "is unavailable; decision inputs/delivery " +
          "preparation report their undefined preimage/rules instead of fabricating them."
      };
    }
  }

  if (options.services === undefined &&
      !(onlineStatus.status === "composed" && onlineStatus.source === "default")) {
    const ingest = services["event.ingest"];
    if (ingest !== undefined) {
      (services as unknown as Record<string, IpcHandler<"event.ingest">>)["event.ingest"] =
        hostTriggerObservation.wrapIngest(ingest);
    }
  }

  // Custom service maps and injected pipelines own their downstream wiring;
  // the default evidence composition is not installed, so a Jev transport
  // supplied here would never be consumed. Report that instead of claiming it.
  if (
    (options.services !== undefined || options.online_pipeline !== undefined) &&
    (options.jev_transport !== undefined || options.jev_transport_composition !== undefined)
  ) {
    jevStatus = {
      status: "blocked",
      reason: "custom_services",
      detail:
        "A custom service map or injected online pipeline owns downstream wiring, so the " +
        "default Jev transport composition is not installed.",
      error: null
    };
  }

  let configAutotune: RunningKernel["config_autotune"] = { status: "disabled" };
  if (options.services === undefined) {
    if (features.config_autotune) {
      const model = options.config_autotune?.model === undefined
        ? resolvePersistedHostModel({
            connection: db.connection,
            rootRegistry,
            ...(options.config_autotune?.selected === undefined ? {} : { selected: options.config_autotune.selected })
          })
        : { ok: true as const, value: options.config_autotune.model };
      if (!model.ok || sharedJournal === null) {
        configAutotune = { status: "blocked", error: model.ok
          ? configError("E_CFG_MODEL_UNBOUND")
          : model.error };
      } else {
        const configured = createPersistedConfigComposition({
          ...options.config_autotune,
          model: model.value,
          enabled: true,
          connection: db.connection,
          rootRegistry,
          rootResolver: reviewRootResolver,
          journal: createJournalCommitter({
            writer: sharedJournal.writer,
            connection: db.connection,
            relative_path: sharedJournal.relative_path,
            now
          }),
          blobStore,
          now,
          autoTuneFields: featureConfig.config.auto_tune_fields
        });
        configAutotune = configured.ok
          ? { status: "ready", composition: configured.value }
          : { status: "blocked", error: configured.error };
      }
    }
    if (configAutotune.status === "ready") {
      const reconciled = await configAutotune.composition.trial?.reconcile(now());
      if (reconciled !== undefined && (!reconciled.ok || reconciled.value.unresolved_trial_ids.length > 0)) {
        recoveryState = "failed";
        return failure(5, internalError("kernel.config_recovery_required"));
      }
      Object.assign(services, configAutotune.composition.handlers);
    } else {
      Object.assign(services, createConfigHandlers({
        enabled: features.config_autotune,
        now,
        ...(configAutotune.status === "blocked" ? { blocked_error: configAutotune.error } : {})
      }));
    }
  }
  const composition = composeKernelHandlers({
    services,
    environment
  });

  const unavailableMethods =
    options.services === undefined
      ? [...Object.keys(UNAVAILABLE_DOMAIN_METHODS), ...proofGatedMethods(originProof)].filter(
          (method, index, all) => all.indexOf(method) === index
        )
      : [];

  const localIdempotencyJournal = options.idempotency_journal === undefined
    ? createJournalIdempotencyJournal({
        connection: db.connection,
        home: options.home,
        layout,
        now,
        ...(onlineJournal === null ? {} : { writer: onlineJournal })
      })
    : null;
  closeIdempotency = (): void => { localIdempotencyJournal?.dispose(); };
  const idempotencyJournal = options.idempotency_journal ?? localIdempotencyJournal;
  if (idempotencyJournal === null) {
    return failure(5, internalError("kernel.idempotency_journal_unavailable"));
  }
  const idempotency = createSqliteIdempotencyStore({
    connection: db.connection,
    journal: idempotencyJournal
  });

  const outboxOptions = options.outbox_worker ?? {};
  const outboxDelivery =
    outboxOptions.delivery ??
    (runtimeBridge === null ? undefined : runtimeBridge.delivery_port);
  const outboxJournal = outboxOptions.journal ?? deliveryJournal;
  const deliveryExpiryEnabled = features.delivery_ttl && deliveryJournal !== undefined;
  // The sweep stages `outbox.enqueued` in the same journal as the transition
  // writer. Build it from the shared writer only; a caller-supplied journal
  // never shares that writer, so it must stage expiry itself.
  const deliveryExpirySweepEnqueue = outboxOptions.delivery_expiry_sweep_enqueue ?? (
    deliveryExpiryEnabled && outboxOptions.journal === undefined && sharedJournal !== null
      ? createFndLiveCommitPort({
          connection: db.connection,
          writer: sharedJournal.writer,
          relative_path: sharedJournal.relative_path,
          blob_store: blobStore,
          now
        })
      : undefined
  );
  const outboxWorker =
    outboxDelivery === undefined && !deliveryExpiryEnabled
      ? null
      : createOutboxWorker({
          connection: db.connection,
          now,
          ...(outboxDelivery === undefined ? {} : { delivery: outboxDelivery }),
          delivery_expiry_sweep: deliveryExpiryEnabled,
          ...(deliveryExpirySweepEnqueue === undefined
            ? {}
            : { delivery_expiry_sweep_enqueue: deliveryExpirySweepEnqueue }),
          ...(outboxJournal === undefined
            ? {}
            : { journal: outboxJournal }),
          ...(outboxOptions.owner === undefined
            ? {}
            : { owner: outboxOptions.owner }),
          ...(outboxOptions.interval_ms === undefined
            ? {}
            : { interval_ms: outboxOptions.interval_ms }),
          ...(outboxOptions.lease_ms === undefined
            ? {}
            : { lease_ms: outboxOptions.lease_ms })
        });
  stopWorkers = async (): Promise<void> => {
    await safely(async () => { await outboxWorker?.stop(); });
  };
  const credentialRef =
    reviewOptions.credential_ref ??
    (config.value.review_backend.enabled
      ? (config.value.review_backend.secret_ref ?? undefined)
      : undefined);
  const dataScopeRef = reviewOptions.data_scope_ref;
  const reviewDelivery = reviewOptions.delivery === undefined
    ? undefined
    : createDurableReviewWorkerDeliveryPort({
        connection: db.connection,
        repository: reviewServices.repository,
        downstream: reviewOptions.delivery,
        now
      });
  const reviewWorker = createReviewWorkerLoop({
    service: reviewServices.review,
    repository: reviewServices.repository,
    write: reviewServices.write,
    generation: reviewServices.generation,
    blob_store: blobStore,
    clock: {
      utcNowMs: now,
      monotonicNowMs: now,
      monotonicRemainingMs: (deadline: number): number => Math.max(0, deadline - now())
    },
    ...(reviewOptions.worker_id === undefined ? {} : { worker_id: reviewOptions.worker_id }),
    ...(reviewOptions.interval_ms === undefined ? {} : { interval_ms: reviewOptions.interval_ms }),
    ...(reviewOptions.retry_ms === undefined ? {} : { retry_ms: reviewOptions.retry_ms }),
    ...(reviewOptions.heartbeat_interval_ms === undefined
      ? {}
      : { heartbeat_interval_ms: reviewOptions.heartbeat_interval_ms }),
    ...(reviewOptions.cancel_poll_ms === undefined
      ? {}
      : { cancel_poll_ms: reviewOptions.cancel_poll_ms }),
    ...(reviewOptions.recovery_interval_ms === undefined
      ? {}
      : { recovery_interval_ms: reviewOptions.recovery_interval_ms }),
    ...(reviewOptions.max_stage_jobs_per_tick === undefined
      ? {}
      : { max_stage_jobs_per_tick: reviewOptions.max_stage_jobs_per_tick }),
    ...(reviewOptions.max_output_rounds === undefined
      ? {}
      : { max_output_rounds: reviewOptions.max_output_rounds }),
    ...(credentialRef === undefined ? {} : { credential_ref: () => credentialRef }),
    ...(dataScopeRef === undefined ? {} : { data_scope_ref: () => dataScopeRef }),
    ...(reviewDelivery === undefined ? {} : { delivery: reviewDelivery })
  });

  stopWorkers = async (): Promise<void> => {
    await safely(() => reviewWorker.stop());
    await safely(async () => { await outboxWorker?.stop(); });
  };

  // Recovery is a readiness gate. Reclaiming expired leases after binding the
  // UDS would let callers observe `ready` while an old external effect still
  // has an unresolved fence. Both recovery-only passes never claim new work.
  const reviewRecovery = await reviewWorker.recover();
  if (reviewRecovery.errors.length > 0) {
    return failure(5, internalError("kernel.review_recovery_failed"));
  }
  if (outboxWorker !== null) {
    try {
      await outboxWorker.recover();
    } catch {
      return failure(5, internalError("kernel.outbox_recovery_failed"));
    }
  }

  let created: IpcServer;
  try {
    created = await IpcServer.start({
      evoplug_home: options.home,
      handlers: composition.handlers,
      idempotency,
      now_epoch: now
    });
    server = created;
    closeIpc = () => created.close();
  } catch (error) {
    if (error instanceof IpcServerStartError) {
      const bindConflict = error.reason.startsWith("bind:");
      return failure(bindConflict ? 4 : 3, kernelError("E_CONFLICT", {
        details: { kind: "field", path: "runtime/kernel.sock", rule: error.reason }
      }));
    }
    return failure(3, internalError("kernel.ipc_start_failed"));
  }

  const runningServer = created;
  if (outboxWorker !== null) {
    outboxWorker.start();
  }
  reviewWorker.start();

  let reviewGeneration: ReviewGenerationBootstrapStatus;
  if (reviewServices.generation === null) {
    reviewGeneration = {
      status: "disabled",
      reason: "host_generation_port_unavailable",
      detail:
        "No HostGenerationPort is installed. Select a supported approved review backend with " +
        "--generation-binding-key, or inject a native generation adapter. " +
        (features.cli_generation
          ? "The declared backend must have a matching persisted binding, verified capabilities and ServiceProfile. "
          : "Enable cli_generation to select other packaged backend declarations. ") +
        "The REV worker cannot claim generation jobs without these inputs."
    };
  } else if (credentialRef === undefined) {
    reviewGeneration = {
      status: "disabled",
      reason: "credential_ref_unavailable",
      detail:
        "A HostGenerationPort is installed but no credential reference is configured " +
        "(review_backend.secret_ref or review_worker.credential_ref)."
    };
  } else if (!reviewWorker.enabled) {
    reviewGeneration = {
      status: "disabled",
      reason: "generation_runner_unavailable",
      detail:
        "The generation port and credential reference exist but the built-in runner is " +
        "not usable because the blob store or output persistence port is missing."
    };
  } else {
    reviewGeneration = { status: "enabled" };
  }

  ready = true;
  return {
    ok: true,
    server: runningServer,
    composition,
    config: config.value,
    sqlite_version: db.sqlite_version,
    missing_methods: composition.missing_methods,
    unavailable_methods: unavailableMethods,
    outbox_worker: outboxWorker,
    review_worker: reviewWorker,
    review_generation: reviewGeneration,
    runtime_delivery_bridge: runtimeBridge,
    runtime_probe: runtimeProbe,
    service_profile: serviceProfile,
    human_attestation: humanAttestation,
    human_upload: humanUpload,
    config_autotune: configAutotune,
    online_pipeline: onlineStatus,
    jev_transport: jevStatus,
    shutdown: cleanup
  };
  } catch {
    return failure(5, internalError("kernel.startup_composition_failed"));
  } finally {
    if (!ready) await cleanup();
  }
}
