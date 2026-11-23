/**
 * Kernel domain service composition (DD-FND-021, DD-FND-042).
 *
 * `createKernelServices` turns the open single-writer SQLite connection, the
 * validated config, the clock and the blob store into the typed
 * `KernelServicePorts` map consumed by `composeKernelHandlers`.
 *
 * Domain rules are never re-implemented here. Validation, row construction,
 * state transitions, hashes and closed unions come from the owning package;
 * this module only:
 *   - reads and writes the physical rows through the single writer connection,
 *   - orders the journal frame before the SQLite projection (DD-FND-070),
 *   - maps `Result` values onto the IPC envelope.
 *
 * Methods that need a host capability the kernel does not own (the HOST
 * `OriginProofPort`, the adapter install readiness port and the replay process
 * executor) return a typed `E_INTERNAL` with a stable incident id and are
 * listed in `UNAVAILABLE_DOMAIN_METHODS`. They never fabricate success.
 */

import { realpathSync, } from "node:fs";
import { join } from "node:path";
import { type ErrorEnvelope, type EventDraft, type FailureStatus, type Hash, type HostId, type Id, type IngestReceipt, type JsonValue, type Result, type SourceRef, type SourceRefPort, type StateRowPort, type StateRowReadKey, type StateRowSchema, type StateRowSnapshot, type StateRowWrite, type Tx, type VersionBinding } from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  isHostId,
  isId,
  newId,
  parseSourceRef
} from "@evoplug/core";
import type { IpcHandler, IpcMethod, IpcResult } from "@evoplug/ipc";
import {
  BlobStore,
  JournalWriter,
  createFndStateRowPort,
  createJournalCommitter,
  listJournalStates,
  readActiveBudgetPolicy,
  readActiveEgressPolicy,
  type JournalAppendResult,
  type JournalCommitter,
  type SqlRow,
  type SqliteConnection,
  type Tx as StorageTx
} from "@evoplug/storage";
import type { EvoplugConfig } from "./config.js";
import { computeConfigVersion } from "./config.js";
import { fieldError, internalError } from "./errors.js";
import { homeLayout, type HomeLayout } from "./home.js";
import { createEventIngestHandler } from "./event-ingest.js";
import { createOutcomeIntake, type OutcomeIntake } from "./outcome-producer.js";
import {
  createFeedbackIntentClassifier,
  createFeedbackIntake,
  type FeedbackIntakePort,
  type FeedbackIntentClassifier,
  type FeedbackIntentModelPort,
  type FeedbackOutcome,
  type FeedbackRecoverySummary
} from "./feedback-producer.js";
import {
  createFeedbackRecoveryWorker,
  type FeedbackRecoveryWorkerLimits,
  type FeedbackRecoveryWorkerPort
} from "./feedback-recovery-worker.js";

/**
 * W6 public surface. `index.ts` re-exports this module wholesale, so the
 * classifier factory and its types are reachable from `@evoplug/kernel`
 * without touching the shared index.
 */
export {
  createFeedbackIntentClassifier,
  createFeedbackIntake,
  FEEDBACK_KINDS,
  noFeedbackIntent,
  type FeedbackIntakeDeps,
  type FeedbackIntakePort,
  type FeedbackIntent,
  type FeedbackIntentClassifier,
  type FeedbackIntentClassifierOptions,
  type FeedbackIntentInput,
  type FeedbackIntentModelPort,
  type FeedbackIntentModelReply,
  type FeedbackIntentModelRequest,
  type FeedbackOutcome,
  type FeedbackRecordedOutcome,
  type FeedbackRecoveryBatchOptions,
  type FeedbackRecoveryStats,
  type FeedbackRecoverySummary,
  type FeedbackRecoveryStopReason,
  type FeedbackSkipReason,
  type FeedbackSkippedOutcome
} from "./feedback-producer.js";
export {
  createFeedbackRecoveryWorker,
  DEFAULT_FEEDBACK_RECOVERY_WORKER_LIMITS,
  type FeedbackRecoveryLastRun,
  type FeedbackRecoveryWorkerLimits,
  type FeedbackRecoveryWorkerPort,
  type FeedbackRecoveryWorkerStatus
} from "./feedback-recovery-worker.js";
import { hostInstallationAllows } from "./host-installations.js";
import {
  createHostRuntimeServices,
  type HostRuntimeAdapterResolverPort,
  type HostRuntimeCallResolverPort,
  type HostRuntimeLimits,
  type HostRuntimeProbeLifecyclePort,
  type HostRuntimeUploadCommit,
  type HostRuntimeUploadDiagnostic
} from "./host-runtime.js";
import { createSessionScopeReadPort } from "./session-scope.js";
import {
  createIdentityForkHandler,
  createIdentityResumeHandler
} from "./identity-lifecycle.js";
import {
  createInstallService,
  type InstallReadinessPort
} from "./install-service.js";
import { createReplayExecuteHandler } from "./replay-executor.js";
import { createSourceRefPort } from "./source-ref-port.js";
import { createInstallReadinessPort } from "./install-readiness.js";
import {
  createRootRegistry,
  createRootResolver,
  type RootRegistry
} from "./root-registry.js";
import {
  createWriteApplyHandler,
  type WriteApplyRootResolverPort
} from "./write-apply.js";
import {
  createDefaultDecisionDeliveryService,
  deliveryFromRow,
  deliveryRow,
  insertDeliveryHistory,
  type DefaultDeliveryCreateEnqueuePort
} from "./default-decision-delivery.js";
import type { CommittedHostEvent, DecisionRecordPort } from "./online-pipeline.js";
import type { KernelDomainMethod, KernelServicePorts } from "./ports.js";

import {
  IdentityService,
  LedgerReadService,
  validateVersionBinding,
  type ForkIdempotencyRecord,
  type LedgerBranchView,
  type LedgerCorrectionStateRow,
  type LedgerEventLogPort,
  type LedgerIdentityReadPort,
  type LedgerPorts,
  type LedgerProjectionReadPort,
  type LedgerRequirementReadQuery,
  type LedgerReservationReadPort,
  type LedgerReservationView,
  type LedgerSessionView,
  type NativeSessionMapping,
  type OriginProofPort,
  type RequirementHeadStateRow,
  type RequirementOpStateRow,
  type RequirementSourceStateRow,
  type RequirementStateRow,
  type FactVerificationStateRow,
  type FeedbackStateRow,
  type StateFactStateRow,
  type SuccessEvidenceStateRow,
  type TaskOutcomeStateRow,
  type UnverifiedConstraintStateRow,
  type GoalSnapshotStateRow
} from "@evoplug/ledger";
import {
  budgetError,
  budgetPolicyContentHash,
  consumeToken,
  createReservation,
  findScopePolicy,
  makeClaimCharge,
  makeOverageCharge,
  makeUsageCharge,
  parseBudgetPolicy,
  planClaim,
  planReservation,
  planSettlement,
  readReservationInTransaction,
  validateProviderUsage,
  type BudgetClaimRequest,
  type BudgetReservation,
  type BudgetReserveRequest,
  type BudgetSettleRequest,
  type BudgetScopePolicy,
  type ProviderUsage,
  type TokenBucketState
} from "@evoplug/budget";
import {
  authDenied,
  createGrant,
  grantIssueSubjectHash,
  grantListState,
  grantRevokeSubjectHash,
  revokeGrant,
  toGrantPublicView,
  validateGrantIssueRequest,
  type AuthorizationGrant,
  type GrantScope,
  type GrantView
} from "@evoplug/auth";
import { computeEgressApprovalHash, createEgressApproval, createEgressGateway, evaluateEgress, egressPolicyStaleError, parseEgressApprovalRequest, parseEgressPolicy, freezeEgressRequest, parseEgressRequestInput, toEgressApprovalView, type EgressApproval, type EgressRequestInput, type EgressSourceStatus, type EgressTransport } from "@evoplug/egress";
import {
  applyDeliveryUpdate,
  deriveDeliveryHistory,
  parseDeliveryUpdateRequest
} from "@evoplug/delivery";
import {
  authorizeReplay,
  classifyReplay,
  computeReplayApproveSubjectHash,
  computeReplayReconcileSubjectHash,
  computeReplayRejectSubjectHash,
  computeReplayRevokeSubjectHash,
  createReplayApproval,
  createReplayPlan,
  expireReplayApproval,
  parseReplayApproveRequest,
  parseReplayAuthorizeRequest,
  parseReplayClassifyRequest,
  parseReplayPlanDraft,
  parseReplayReconcileRequest,
  parseReplayRejectRequest,
  parseReplayRevokeRequest,
  reconcileReplayExecution,
  rejectReplayPlan,
  replayApprovalNotFoundError,
  replayAttestationUnverifiedError,
  revokeReplayApproval,
  toReplayApprovalView,
  type ReplayApproval,
  type ReplayExecution,
  type ReplayPlan
} from "@evoplug/replay";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Public factory contract                                            */
/* ------------------------------------------------------------------ */

/**
 * W6 wiring. Off unless the composition root explicitly enables it; the
 * adapter only reports `new_input`, so classification is injected here.
 */
interface FeedbackIntakeOptions {
  readonly enabled: boolean;
  /**
   * Dedicated HOST verifier for feedback/confirmation events. Defaults to the
   * shared `KernelServiceOptions.proof`; supplying it here lets the product
   * enable W6 without also advertising the control-plane proof-gated methods.
   */
  readonly origin_proof?: OriginProofPort;
  /**
   * Model seam for classification. When supplied without `classifier`, the
   * kernel builds the public classifier with its own source port, so the
   * composition root never needs the internal blob/source wiring.
   */
  readonly intent_model?: FeedbackIntentModelPort;
  /** Explicit classifier override; wins over `intent_model`. */
  readonly classifier?: FeedbackIntentClassifier;
  /** Replay committed-but-unrecorded feedback on startup (default true). */
  readonly recover_on_start?: boolean;
  /**
   * Appendix P: bounds for the post-endpoint background replay. Supplying
   * `recover_on_start=false` and starting the worker after the server is the
   * app composition's way to keep classification off the startup barrier.
   */
  readonly recovery_limits?: Partial<FeedbackRecoveryWorkerLimits>;
  /** Diagnostic sink for recorded/skipped intake outcomes. */
  readonly on_outcome?: (outcome: FeedbackOutcome) => void;
  /** Diagnostic sink for hard intake failures. */
  readonly on_failure?: (error: ErrorEnvelope) => void;
  /** Diagnostic sink for TaskOutcome evaluation failures. */
  readonly on_outcome_error?: (error: ErrorEnvelope) => void;
  /** Diagnostic sink for every evaluated boundary candidate. */
  readonly on_outcome_evaluated?: (info: {
    readonly event_type: string;
    readonly boundary: boolean;
    readonly pending_tool: boolean;
  }) => void;
}

type PostCommitHookName = "feedback_intake" | "outcome_intake" | "delivery_expiry";

interface PostCommitFailure {
  readonly hook: PostCommitHookName;
  readonly error: unknown;
}

/**
 * Drain/error view of the post-ACK fanout. The ACK is already durable when a
 * hook runs, so a hook failure is recorded here and never surfaces as an
 * ingest rejection. Shutdown drains all pending hooks.
 */
interface PostCommitPort {
  drain(): Promise<void>;
  failures(): readonly PostCommitFailure[];
  /** Debug view: hook names of the work a drain is currently waiting for. */
  pendingHooks(): readonly string[];
}

interface NamedPostCommitHook {
  readonly name: PostCommitHookName;
  readonly run: (event: CommittedHostEvent) => void | Promise<void>;
}

function createPostCommitFanout(hooks: readonly NamedPostCommitHook[]): PostCommitPort & {
  readonly dispatch: (event: CommittedHostEvent) => Promise<void>;
} {
  const pending = new Map<Promise<void>, readonly string[]>();
  const failures: PostCommitFailure[] = [];
  function remember(hook: PostCommitHookName, error: unknown): void {
    failures.push({ hook, error });
    if (failures.length > 64) failures.shift();
  }
  async function runAll(event: CommittedHostEvent): Promise<void> {
    await Promise.all(
      hooks.map(async (hook) => {
        try {
          await hook.run(event);
        } catch (error) {
          remember(hook.name, error);
        }
      })
    );
  }
  return {
    dispatch(event: CommittedHostEvent): Promise<void> {
      const task = runAll(event);
      pending.set(task, hooks.map((hook) => hook.name));
      const done = (): void => {
        pending.delete(task);
      };
      void task.then(done, done);
      return task;
    },
    async drain(): Promise<void> {
      while (pending.size > 0) {
        await Promise.all([...pending.keys()]);
      }
    },
    failures(): readonly PostCommitFailure[] {
      return [...failures];
    },
    pendingHooks(): readonly string[] {
      return [...new Set([...pending.values()].flat())];
    }
  };
}

/**
 * A journal already opened by the app composition root.
 *
 * The services only append through this borrowed writer. `runtime.dispose()`
 * never closes it: the opener owns the descriptor.
 */
interface KernelServiceJournal {
  readonly writer: JournalWriter;
  readonly relative_path: string;
}

export interface KernelServiceOptions {
  readonly connection: SqliteConnection;
  readonly config: EvoplugConfig;
  readonly now: () => number;
  readonly home: string;
  readonly blob_store: BlobStore;
  /**
   * Borrow the app's shared journal instead of opening a second writer. Omit
   * to let this composition own (and dispose) its own writer.
   */
  readonly journal?: KernelServiceJournal;
  /** W6 feedback intake; absent or `enabled=false` keeps the path inert. */
  readonly feedback_intake?: FeedbackIntakeOptions;
  /**
   * W5 input-epoch expiry hook. Runs after the ACK, in parallel with the W6
   * intake; a rejected promise is recorded by the runtime post-commit port and
   * never changes the ACK.
   */
  readonly delivery_expiry_post_commit?: (event: CommittedHostEvent) => void | Promise<void>;
  /** Supplied by HOST; absent means every human-gated method stays inert. */
  readonly proof?: OriginProofPort;
  /** Supplied by HOST for managed writes; absent fails closed before effects. */
  readonly write_root_resolver?: WriteApplyRootResolverPort;
  /** HOST install readiness/evidence ports; absent fails closed before writes. */
  readonly install_readiness?: InstallReadinessPort;
  readonly install_source_refs?: Pick<SourceRefPort, "resolve">;
  /** HOST boot mapping of registered root_id -> live approved directory. */
  readonly approved_roots?: ReadonlyMap<string, string>;
  /** Shared HOST activation registry used by managed writes and REV. */
  readonly root_registry?: RootRegistry;
  readonly layout?: HomeLayout;
  /** Sole outbound transport; absent means egress.gateway fails closed. */
  readonly egress_transport?: EgressTransport;
  /** Response cap enforced by the gateway; defaults to 1 MiB. */
  readonly egress_max_response_bytes?: number;
  /**
   * Adapter library lookup for `host.runtime.upload`. Supplied by the app
   * composition root because `@evoplug/kernel` cannot import adapter packages.
   */
  readonly host_runtime_adapters?: HostRuntimeAdapterResolverPort;
  /** Delivery/probe request loader for `host.runtime.poll` (bridge-owned). */
  readonly host_runtime_call_resolver?: HostRuntimeCallResolverPort;
  /** Probe lifecycle owned by the probe producer; absent stays inert. */
  readonly host_runtime_probe_lifecycle?: HostRuntimeProbeLifecyclePort;
  /**
   * Existing upload post-commit hook for automatic human-attestation issue.
   * Runs after an authenticated upload commits; never changes the ACK.
   */
  readonly host_runtime_upload_committed?: (input: HostRuntimeUploadCommit) => void;
  /** Observes refused uploads with a retrievable rejection blob reference. */
  readonly host_runtime_upload_diagnostic?: (input: HostRuntimeUploadDiagnostic) => void;
  readonly host_runtime_limits?: Partial<HostRuntimeLimits>;
}

/**
 * Methods registered with a stable `kernel.*` incident because the kernel does
 * not own a required host capability. They answer `E_INTERNAL`, never success.
 */
export const UNAVAILABLE_DOMAIN_METHODS: Readonly<
  Partial<Record<KernelDomainMethod, string>>
> = {
};

const PROOF_GATED: readonly KernelDomainMethod[] = [
  "grant.issue",
  "grant.revoke",
  "egress.approve",
  "replay.approve",
  "replay.revoke",
  "replay.reject",
  "replay.reconcile"
];

/** Methods that are wired but inert until HOST supplies `OriginProofPort`. */
export function proofGatedMethods(proof: OriginProofPort | undefined): readonly KernelDomainMethod[] {
  return proof === undefined ? PROOF_GATED : [];
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function fail(error: ErrorEnvelope, status: FailureStatus = "rejected"): {
  readonly ok: false;
  readonly status: FailureStatus;
  readonly error: ErrorEnvelope;
} {
  return { ok: false, status, error };
}

function ok<T>(value: T): { readonly ok: true; readonly status: "ok"; readonly value: T } {
  return { ok: true, status: "ok", value };
}

function isHashValue(value: unknown): value is Hash {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function asString(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function asNumber(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function asNullableString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asNullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : value === null || value === undefined ? null : Number(value);
}

function bindingJson(binding: VersionBinding): JsonValue {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

function asSqlParams(value: Record<string, JsonValue>): Readonly<Record<string, string | number | null>> {
  return value as unknown as Readonly<Record<string, string | number | null>>;
}

function parseJson(text: string | null): JsonValue | null {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

function unavailable<M extends KernelDomainMethod>(incident: string): IpcHandler<M> {
  return async (): Promise<Result<IpcResult[M], ErrorEnvelope>> =>
    fail(internalError(incident));
}

function requireRecord(value: unknown, path = "$"): Result<Record<string, unknown>, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(fieldError(path, "must_be_object"));
  }
  return ok(value);
}

/* ------------------------------------------------------------------ */
/* Journal + ledger event projection                                  */
/* ------------------------------------------------------------------ */

interface LedgerEventInput {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation: "insert" | "update" | "transition";
  readonly binding: VersionBinding | null;
  readonly row_schema: string;
  readonly row: Record<string, JsonValue>;
  readonly before: Record<string, JsonValue> | null;
  /**
   * Frozen delivery history, built with the event id that the committer
   * allocates. Only delivery transitions carry it; journal-only rebuild then
   * restores `delivery_history` without re-running the transition.
   */
  readonly history?: (eventId: Id<"ev">) => JsonValue;
  readonly apply?: (tx: Tx, afterHash: Hash, eventId: Id<"ev">) => void;
}

interface LedgerCommitter {
  commit(input: LedgerEventInput): Promise<Result<void, ErrorEnvelope>>;
  /**
   * Writes several ledger events as consecutive journal frames, then projects
   * all of them in one short SQLite transaction. DD-FND-096.2 step 3 uses this
   * for `replay.reject`: every approval revocation frame precedes the plan
   * transition frame.
   */
  commitBatch(inputs: readonly LedgerEventInput[]): Promise<Result<void, ErrorEnvelope>>;
}

interface JournalResources {
  readonly writer: JournalWriter;
  readonly relativePath: string;
  readonly committer: JournalCommitter;
  /** True only when this composition opened the writer and must close it. */
  readonly owned: boolean;
}

/**
 * The shared commit sequence of one journal era.
 *
 * `commit_seq` is global over the era (DD-FND-059), so the writer that
 * appends to the file must allocate from the persisted counter, not from a
 * private one.
 */
function readSharedCommitSeq(connection: SqliteConnection, journalId: string): number {
  const row = connection
    .prepare<{ last_commit_seq: number }>(
      "SELECT last_commit_seq FROM journal_state WHERE journal_id = :journal_id"
    )
    .get({ journal_id: journalId });
  return row === undefined ? 0 : Number(row.last_commit_seq);
}

function openJournalResources(options: KernelServiceOptions): JournalResources | null {
  if (options.journal !== undefined) {
    const borrowed = options.journal;
    return {
      writer: borrowed.writer,
      relativePath: borrowed.relative_path,
      committer: createJournalCommitter({
        writer: borrowed.writer,
        connection: options.connection,
        relative_path: borrowed.relative_path,
        now: options.now
      }),
      owned: false
    };
  }
  const layout = options.layout ?? homeLayout(options.home);
  const states = listJournalStates(options.connection);
  const latest = states[states.length - 1];
  const journalId = latest?.journal_id ?? "journal-000001";
  const relativePath = latest?.relative_path ?? "journal-000001.rsij";
  const writer = JournalWriter.open({
    file_path: join(layout.journal_dir, relativePath),
    journal_id: journalId,
    last_commit_seq: latest?.last_commit_seq ?? 0,
    // Fail closed if the file carries a durable frame the persisted tail did
    // not project, or if recovery left the era read-only.
    trusted_prefix_end: latest?.trusted_prefix_end ?? 0,
    read_only: latest?.read_only === 1,
    tail_state: latest?.tail_state ?? "clean",
    shared_commit_seq: () => readSharedCommitSeq(options.connection, journalId)
  });
  if (!writer.ok) {
    return null;
  }
  return {
    writer: writer.value,
    relativePath,
    committer: createJournalCommitter({
      writer: writer.value,
      connection: options.connection,
      relative_path: relativePath,
      now: options.now
    }),
    owned: true
  };
}



function createLedgerCommitter(
  options: KernelServiceOptions,
  resources: JournalResources
): LedgerCommitter {
  const journalId = resources.writer.journalId;
  const committer = resources.committer;

  const buildEvent = (input: LedgerEventInput): {
    readonly event: JsonValue;
    readonly afterHash: Hash;
    readonly beforeHash: Hash | null;
  } => {
    const rowJson = canonicalJsonText(input.row);
    const afterHash = canonicalHash({ row_schema: input.row_schema, row_json: rowJson });
    const beforeHash =
      input.before === null
        ? null
        : canonicalHash({
            row_schema: input.row_schema,
            row_json: canonicalJsonText(input.before)
          });
    const eventId = newId("ev", options.now());
    const history = input.history?.(eventId);
    const eventKey = canonicalHash({
      event_type: input.event_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      operation: input.operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      binding: input.binding === null ? null : bindingJson(input.binding)
    });
    const event: JsonValue = {
      schema_version: "rsi.ledger_event/1",
      event_id: eventId,
      event_key: eventKey,
      event_type: input.event_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      operation: input.operation,
      binding: input.binding === null ? null : bindingJson(input.binding),
      before_hash: beforeHash,
      after_hash: afterHash,
      row_schema: input.row_schema,
      row_json: rowJson,
      ...(history === undefined ? {} : { history }),
      payload_hash: afterHash,
      recorded_at: options.now()
    };
    return { event, afterHash, beforeHash };
  };

  return {
    commit: async (input: LedgerEventInput): Promise<Result<void, ErrorEnvelope>> => {
      const { event, afterHash, beforeHash } = buildEvent(input);
      const outcome = await committer.commit(
        {
          schema_version: "rsi.journal_event/1",
          event,
          event_hash: canonicalHash(event),
          blob_hashes: []
        },
        (tx, receipt) => {
          insertLedgerEventLog(tx, {
            event,
            input,
            journalId,
            commitSeq: receipt.first_commit_seq,
            afterHash,
            beforeHash
          });
          input.apply?.(tx as unknown as Tx, afterHash, eventIdOf(event));
          return null;
        }
      );
      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.commit_state === "unknown_recovery_required" ? "unknown" : "rejected",
          error: outcome.error
        };
      }
      return ok(undefined);
    },
    commitBatch: async (
      inputs: readonly LedgerEventInput[]
    ): Promise<Result<void, ErrorEnvelope>> => {
      if (inputs.length === 0) {
        return ok(undefined);
      }
      const built = inputs.map((input) => ({
        input,
        ...buildEvent(input)
      }));
      const frames = built.map((entry) => ({
        payload: {
          schema_version: "rsi.journal_event/1" as const,
          event: entry.event,
          event_hash: canonicalHash(entry.event),
          blob_hashes: []
        },
        project: (tx: Tx, receipt: JournalAppendResult): void => {
          insertLedgerEventLog(tx, {
            event: entry.event,
            input: entry.input,
            journalId,
            commitSeq: receipt.first_commit_seq,
            afterHash: entry.afterHash,
            beforeHash: entry.beforeHash
          });
          entry.input.apply?.(tx as unknown as Tx, entry.afterHash, eventIdOf(entry.event));
        }
      }));
      const outcome = await committer.commitFrames(frames);
      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.commit_state === "unknown_recovery_required" ? "unknown" : "rejected",
          error: outcome.error
        };
      }
      return ok(undefined);
    }
  };
}

function eventIdOf(event: JsonValue): Id<"ev"> {
  const object = event as Record<string, JsonValue>;
  return String(object["event_id"]) as Id<"ev">;
}
function insertLedgerEventLog(
  tx: StorageTx,
  input: {
    readonly event: JsonValue;
    readonly input: LedgerEventInput;
    readonly journalId: string;
    readonly commitSeq: number;
    readonly afterHash: Hash;
    readonly beforeHash: Hash | null;
  }
): void {
  const eventObject = input.event as Record<string, JsonValue>;
  const binding = input.input.binding;
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, :binding_mode, :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`
  ).run(asSqlParams({
    event_id: String(eventObject["event_id"]),
    event_key: String(eventObject["event_key"]),
    commit_seq: input.commitSeq,
    journal_id: input.journalId,
    event_type: input.input.event_type,
    entity_type: input.input.entity_type,
    entity_id: input.input.entity_id,
    operation: input.input.operation,
    binding_mode: binding === null ? "global" : "bound",
    task_id: binding?.task_id ?? null,
    branch_id: binding?.branch_id ?? null,
    input_epoch: binding?.input_epoch ?? null,
    goal_version: binding?.goal_version ?? null,
    config_version: binding?.config_version ?? null,
    watermark: binding?.watermark ?? null,
    before_hash: input.beforeHash,
    after_hash: input.afterHash,
    row_schema: input.input.row_schema,
    row_json: String(eventObject["row_json"]),
    payload_hash: String(eventObject["payload_hash"]),
    recorded_at: Number(eventObject["recorded_at"] ?? 0)
  }));
}

/* ------------------------------------------------------------------ */
/* Ledger read ports                                                  */
/* ------------------------------------------------------------------ */

function allRows<T>(connection: SqliteConnection, sql: string, params?: Readonly<Record<string, string | number | null>>): T[] {
  return connection.prepare<SqlRow>(sql).all(params) as unknown as T[];
}

function oneRow<T>(connection: SqliteConnection, sql: string, params?: Readonly<Record<string, string | number | null>>): T | null {
  const row = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : (row as unknown as T);
}

function createIdentityPort(options: KernelServiceOptions): LedgerIdentityReadPort {
  const { connection } = options;
  const configVersion = computeConfigVersion(options.config);
  return {
    getSession: async (sessionId) => {
      const row = oneRow<Row>(
        connection,
        "SELECT session_id, host_id, config_space, external_session_id, current_branch_id, resume_generation FROM session WHERE session_id = :session_id",
        { session_id: sessionId }
      );
      if (row === null) return ok(null);
      return ok(sessionView(row));
    },
    findSession: async (q) => {
      const row = oneRow<Row>(
        connection,
        "SELECT session_id, host_id, config_space, external_session_id, current_branch_id, resume_generation FROM session WHERE host_id = :host_id AND config_space = :config_space AND external_session_id = :native_session_id",
        { host_id: q.host_id, config_space: q.config_space, native_session_id: q.native_session_id }
      );
      if (row === null) return ok(null);
      return ok(sessionView(row));
    },
    listNativeMappings: async (q) => {
      const rows = allRows<Row>(
        connection,
        `SELECT m.session_id, i.task_id, i.branch_id, i.input_id, i.input_epoch,
                b.current_goal_version, COALESCE(e.watermark, 0) AS watermark
           FROM native_id_map m
           JOIN session s ON s.session_id = m.session_id
           JOIN input i ON i.input_id = m.input_id
           JOIN branch b ON b.branch_id = i.branch_id
           LEFT JOIN event_log e ON e.event_id = m.source_event_id
          WHERE m.host_id = :host_id
            AND m.config_space = :config_space
            AND s.external_session_id = :native_session_id
          ORDER BY m.session_id ASC, m.native_message_id ASC`,
        { host_id: q.host_id, config_space: q.config_space, native_session_id: q.native_session_id }
      );
      const mappings: NativeSessionMapping[] = rows.map((row) => ({
        session_id: asString(row, "session_id") as Id<"sess">,
        task_id: asString(row, "task_id") as Id<"task">,
        branch_id: asString(row, "branch_id") as Id<"br">,
        watermark: asNumber(row, "watermark"),
        input_id: asNullableString(row, "input_id") as Id<"input"> | null,
        input_epoch: asNumber(row, "input_epoch"),
        goal_version: asString(row, "current_goal_version")
      }));
      return ok(mappings);
    },
    getBranch: async (branchId) => {
      const row = oneRow<Row>(connection, "SELECT * FROM branch WHERE branch_id = :branch_id", {
        branch_id: branchId
      });
      if (row === null) return ok(null);
      const epoch = oneRow<{ epoch: number | null }>(
        connection,
        "SELECT MAX(input_epoch) AS epoch FROM input WHERE branch_id = :branch_id",
        { branch_id: branchId }
      );
      const branch: LedgerBranchView = {
        branch_id: asString(row, "branch_id") as Id<"br">,
        task_id: asString(row, "task_id") as Id<"task">,
        parent_branch_id: asNullableString(row, "parent_branch_id") as Id<"br"> | null,
        forked_from_watermark: asNullableNumber(row, "forked_from_watermark"),
        inherited_goal_snapshot_id: asNullableString(row, "inherited_goal_snapshot_id") as Id<"gsnap"> | null,
        current_goal_version: asString(row, "current_goal_version"),
        current_goal_revision: asNumber(row, "current_goal_revision"),
        current_goal_snapshot_id: asNullableString(row, "current_goal_snapshot_id") as Id<"gsnap"> | null,
        current_input_epoch: epoch?.epoch === null || epoch === undefined ? 1 : asNumber(epoch as Row, "epoch"),
        current_config_version: configVersion,
        created_at: asNumber(row, "created_at"),
        updated_at: asNumber(row, "updated_at")
      };
      return ok(branch);
    },
    getReceiptSeq: async () => {
      const row = oneRow<{ value: string }>(
        connection,
        "SELECT value FROM schema_meta WHERE key = 'receipt_seq'"
      );
      const parsed = row === null ? 0 : Number(row.value);
      return ok(Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0);
    },
    findForkIdempotency: async (_q): Promise<Result<ForkIdempotencyRecord | null, ErrorEnvelope>> =>
      ok(null)
  };
}

function sessionView(row: Row): LedgerSessionView {
  return {
    session_id: asString(row, "session_id") as Id<"sess">,
    host_id: asString(row, "host_id") as HostId,
    config_space: asString(row, "config_space"),
    native_session_id: asNullableString(row, "external_session_id"),
    current_branch_id: asNullableString(row, "current_branch_id") as Id<"br"> | null,
    resume_generation: asNumber(row, "resume_generation")
  };
}

function createProjectionPort(options: KernelServiceOptions): LedgerProjectionReadPort {
  const { connection } = options;
  const query = (
    sql: string,
    q: LedgerRequirementReadQuery,
    includeWatermark = true
  ): Row[] =>
    allRows<Row>(connection, sql, {
      task_id: q.task_id,
      branch_id: q.branch_id,
      ...(includeWatermark ? { watermark: q.watermark } : {})
    });
  return {
    listRequirementRows: async (q) =>
      ok(
        query(
          `SELECT * FROM requirement
            WHERE task_id = :task_id AND branch_id = :branch_id
              AND valid_from_event <= :watermark
              AND (valid_to_event IS NULL OR valid_to_event > :watermark)
            ORDER BY requirement_id ASC, revision ASC`,
          q
        ) as unknown as RequirementStateRow[]
      ),
    listRequirementOpRows: async (q) =>
      ok(
        query(
          `SELECT * FROM requirement_op
            WHERE task_id = :task_id AND branch_id = :branch_id
              AND valid_from_event <= :watermark
              AND (valid_to_event IS NULL OR valid_to_event > :watermark)
            ORDER BY valid_from_event ASC, op_id ASC`,
          q
        ) as unknown as RequirementOpStateRow[]
      ),
    listRequirementSources: async (q) =>
      ok(
        query(
          `SELECT rs.* FROM requirement_source rs
             JOIN requirement r ON r.requirement_id = rs.requirement_id AND r.revision = rs.requirement_revision
            WHERE r.task_id = :task_id AND r.branch_id = :branch_id
              AND r.valid_from_event <= :watermark
              AND (r.valid_to_event IS NULL OR r.valid_to_event > :watermark)`,
          q
        ) as unknown as RequirementSourceStateRow[]
      ),
    listRequirementHeads: async (q) =>
      ok(
        query(
          `SELECT h.* FROM requirement_head h
             JOIN requirement r ON r.requirement_id = h.requirement_id AND r.revision = h.revision
            WHERE r.task_id = :task_id AND r.branch_id = :branch_id
              AND r.valid_from_event <= :watermark
              AND (r.valid_to_event IS NULL OR r.valid_to_event > :watermark)`,
          q
        ) as unknown as RequirementHeadStateRow[]
      ),
    listGoalSnapshots: async (q) =>
      ok(
        allRows<GoalSnapshotStateRow>(
          connection,
          `SELECT * FROM goal_snapshot
            WHERE task_id = :task_id AND source_branch_id = :branch_id
              AND local_goal_version = :goal_version AND watermark <= :watermark
            ORDER BY watermark ASC, local_goal_revision ASC, created_at ASC, snapshot_id ASC`,
          {
            task_id: q.task_id,
            branch_id: q.branch_id,
            goal_version: q.goal_version,
            watermark: q.watermark_max
          }
        )
      ),
    listFeedbackRows: async (q) =>
      ok(query("SELECT * FROM feedback WHERE task_id = :task_id AND branch_id = :branch_id", q, false) as unknown as FeedbackStateRow[]),
    listConstraintRows: async (q) =>
      ok(
        query(
          "SELECT * FROM unverified_constraint WHERE task_id = :task_id AND branch_id = :branch_id",
          q,
          false
        ) as unknown as UnverifiedConstraintStateRow[]
      ),
    listCorrectionRows: async (q) =>
      ok(
        query(
          `SELECT * FROM ledger_correction
            WHERE task_id = :task_id AND branch_id = :branch_id AND valid_from_event <= :watermark`,
          q
        ) as unknown as LedgerCorrectionStateRow[]
      ),
    listFactRows: async (q) =>
      ok(
        query(
          "SELECT * FROM state_fact WHERE task_id = :task_id AND branch_id = :branch_id AND watermark <= :watermark",
          q
        ) as unknown as StateFactStateRow[]
      ),
    listFactVerificationRows: async (q) =>
      ok(
        query(
          "SELECT * FROM fact_verification WHERE watermark <= :watermark AND fact_id IN (SELECT fact_id FROM state_fact WHERE task_id = :task_id AND branch_id = :branch_id)",
          q
        ) as unknown as FactVerificationStateRow[]
      ),
    listSuccessEvidenceRows: async (q) =>
      ok(
        query(
          `SELECT * FROM success_evidence
            WHERE task_id = :task_id AND branch_id = :branch_id AND recorded_at_watermark <= :watermark`,
          q
        ) as unknown as SuccessEvidenceStateRow[]
      ),
    listTaskOutcomeRows: async (q) =>
      ok(
        query(
          `SELECT * FROM task_outcome
            WHERE task_id = :task_id AND branch_id = :branch_id
              AND CAST(json_extract(version_binding_json, '$.watermark') AS INTEGER) <= :watermark`,
          q
        ) as unknown as TaskOutcomeStateRow[]
      )
  };
}

function createEventLogPort(options: KernelServiceOptions): LedgerEventLogPort {
  const { connection } = options;
  return {
    getEvent: async (eventId) => {
      // The event row does not carry the directive strength or the native
      // session id; both are join facts (`input.directive_strength`,
      // `session.external_session_id`). A feedback event has no `input_id`,
      // so its strength stays null and the ledger copies `ambiguous`.
      const row = oneRow<Row>(
        connection,
        `SELECT e.*,
                i.directive_strength AS joined_directive_strength,
                s.external_session_id AS joined_native_session_id
           FROM event_log e
           LEFT JOIN input i ON i.input_id = e.input_id
           LEFT JOIN session s ON s.session_id = e.session_id
          WHERE e.event_id = :event_id`,
        { event_id: eventId }
      );
      if (row === null) return ok(null);
      const attestation = parseJson(asNullableString(row, "human_attestation_json"));
      return ok({
        event_id: asString(row, "event_id") as Id<"ev">,
        event_key: asString(row, "event_key") as Hash,
        event_type: asString(row, "event_type"),
        host_id: asString(row, "host_id") as HostId,
        config_space: asString(row, "config_space"),
        session_id: asString(row, "session_id") as Id<"sess">,
        task_id: asString(row, "task_id") as Id<"task">,
        branch_id: asString(row, "branch_id") as Id<"br">,
        input_id: asNullableString(row, "input_id") as Id<"input"> | null,
        input_epoch: asNullableNumber(row, "input_epoch"),
        goal_version: asString(row, "goal_version"),
        config_version: asString(row, "config_version"),
        watermark: asNumber(row, "watermark"),
        origin: asString(row, "origin") as "human" | "user" | "agent" | "evaluator" | "system" | "host" | "unknown",
        human_attestation:
          attestation !== null && isRecord(attestation)
            ? (attestation as unknown as import("@evoplug/ledger").HumanAttestation)
            : null,
        native_session_id: asNullableString(row, "joined_native_session_id"),
        directive_strength: asNullableString(row, "joined_directive_strength") as
          | "explicit"
          | "ambiguous"
          | null,
        trigger_lineage: {
          axis: asString(row, "trigger_axis") as "external" | "internal_evaluator" | "internal_review" | "unknown",
          root_event_id: asNullableString(row, "trigger_root_event_id") as Id<"ev"> | null,
          depth: asNumber(row, "trigger_depth")
        },
        correlation_id: asString(row, "correlation_id") as Id<"corr">
      });
    }
  };
}

function createReservationPort(options: KernelServiceOptions): LedgerReservationReadPort {
  const { connection } = options;
  return {
    getReservation: async (id) => {
      const row = oneRow<Row>(connection, "SELECT * FROM budget_reservation WHERE reservation_id = :id", {
        id
      });
      if (row === null) return ok(null);
      const purpose = asString(row, "purpose");
      const mapped: LedgerReservationView["purpose"] =
        purpose === "verifier" ? "verifier" : purpose.startsWith("review") ? "review" : purpose === "egress_other" ? "delivery" : "other";
      return ok({
        reservation_id: asString(row, "reservation_id") as Id<"resv">,
        binding: {
          task_id: asString(row, "task_id") as Id<"task">,
          branch_id: asString(row, "branch_id") as Id<"br">,
          input_epoch: asNumber(row, "input_epoch"),
          goal_version: asString(row, "goal_version"),
          config_version: asString(row, "config_version"),
          watermark: asNumber(row, "watermark")
        },
        purpose: mapped,
        status: asString(row, "state") as LedgerReservationView["status"]
      });
    }
  };
}

function createLedgerPorts(
  options: KernelServiceOptions,
  proof: OriginProofPort | undefined,
  journal: JournalResources | null,
  sourceRefs: SourceRefPort
): LedgerPorts {
  const { connection } = options;
  // The FND state-row port is the single typed write face: registry
  // admission, journal frame, SQLite projection and snapshot reads. Without
  // a journal writer there is no legal way to project a ledger row, so the
  // port stays a typed failure instead of degrading to direct SQL.
  const fndRows: StateRowPort | null =
    journal === null
      ? null
      : createFndStateRowPort({
          connection,
          writer: journal.writer,
          relative_path: journal.relativePath,
          blob_store: options.blob_store,
          now: options.now
        });

  return {
    store: {
      appendStateRows: async (input) => {
        if (fndRows === null) {
          return {
            ok: false,
            commit_state: "not_written",
            error: internalError("kernel.state_row_port_unavailable")
          };
        }
        const outcome = await fndRows.appendStateRows({
          binding: input.binding,
          rows: input.rows as unknown as readonly StateRowWrite[],
          documents: [],
          heads: []
        });
        if (!outcome.ok) {
          return {
            ok: false,
            commit_state: outcome.commit_state,
            error: outcome.error
          };
        }
        if (outcome.commit_state === "committed") {
          return {
            ok: true,
            commit_state: "committed",
            receipt: {
              batch_hash: outcome.receipt.batch_hash,
              first_commit_seq: outcome.receipt.first_commit_seq,
              last_commit_seq: outcome.receipt.last_commit_seq
            }
          };
        }
        return { ok: true, commit_state: "existing" };
      }
    },
    stateRows: {
      readStateRows: async (q) => {
        if (fndRows === null) {
          return fail(internalError("kernel.state_row_read_unavailable"));
        }
        const snapshots = await fndRows.readStateRowsSnapshot({
          binding: q.binding,
          keys: q.keys.map((key) => ({
            row_schema: key.row_schema as StateRowSchema,
            key: key.key
          })) as unknown as readonly StateRowReadKey[]
        });
        if (!snapshots.ok) return snapshots;
        return ok(
          snapshots.value.map((snapshot: StateRowSnapshot) => ({
            row_schema: snapshot.row_schema as unknown as import("@evoplug/ledger").LedgerStateRowSchema,
            row: snapshot.row as unknown as JsonValue,
            commit_seq: snapshot.commit_seq
          }))
        );
      }
    },
    blobs: {
      putText: async (text) => {
        const bytes = new TextEncoder().encode(text);
        if (bytes.byteLength === 0) {
          return fail(fieldError("text", "non_empty"));
        }
        const stored = await options.blob_store.put(bytes);
        if (!stored.ok) return stored;
        const sourceRef = `blob://${stored.value.hash}#bytes=0-${String(bytes.byteLength)}`;
        // The metadata rows make the frozen text resolvable through the FND
        // source port before the state-row batch that references it.
        try {
          connection
            .prepare(
              `INSERT INTO blob (
                 blob_hash, byte_length, relative_path, state, verified_at, created_at,
                 deleted_at, deletion_reason
               ) VALUES (
                 :blob_hash, :byte_length, :relative_path, 'present', :now, :now, NULL, NULL
               )
               ON CONFLICT(blob_hash) DO UPDATE SET
                 state = 'present',
                 verified_at = excluded.verified_at,
                 deleted_at = NULL,
                 deletion_reason = NULL`
            )
            .run({
              blob_hash: stored.value.hash,
              byte_length: stored.value.byte_length,
              relative_path: stored.value.relative_path,
              now: options.now()
            });
          connection
            .prepare(
              `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
               VALUES (:blob_hash, 'requirement', :owner_id, :source_ref, :now)
               ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
            )
            .run({
              blob_hash: stored.value.hash,
              owner_id: stored.value.hash,
              source_ref: sourceRef,
              now: options.now()
            });
        } catch {
          return fail(internalError("kernel.blob_metadata_write_failed"));
        }
        return ok({
          source_ref: sourceRef as SourceRef,
          content_hash: stored.value.hash,
          byte_length: bytes.byteLength
        });
      }
    },
    events: createEventLogPort(options),
    identity: createIdentityPort(options),
    projection: createProjectionPort(options),
    verificationCommit: {
      commitVerification: async () =>
        ({
          ok: false,
          commit_state: "not_written",
          error: internalError("kernel.verification_commit_unavailable")
        })
    },
    reservations: createReservationPort(options),
    sources: sourceRefs,
    proof:
      proof ?? {
        verifyHuman: async () => "unverified",
        verifyControlPlane: async () => "unverified"
      },
    clock: { now: options.now }
  };
}

/* ------------------------------------------------------------------ */
/* Domain row mapping                                                 */
/* ------------------------------------------------------------------ */

function grantFromRow(row: Row): AuthorizationGrant | null {
  const scope = parseJson(asNullableString(row, "scope_json"));
  const actions = parseJson(asNullableString(row, "actions_json"));
  const attestation = parseJson(asNullableString(row, "human_attestation_json"));
  if (scope === null || actions === null || attestation === null || !Array.isArray(actions) || !isRecord(scope)) {
    return null;
  }
  return {
    schema_version: "rsi.authorization_grant/1",
    grant_id: asString(row, "grant_id") as Id<"grant">,
    issued_by: asString(row, "issued_by") as AuthorizationGrant["issued_by"],
    human_attestation: attestation as unknown as AuthorizationGrant["human_attestation"],
    subject: "rsi",
    object_type: asString(row, "object_type") as AuthorizationGrant["object_type"],
    scope: scope as unknown as GrantScope,
    actions: actions as AuthorizationGrant["actions"],
    mode: asString(row, "mode") as AuthorizationGrant["mode"],
    candidate_id: asNullableString(row, "candidate_id") as AuthorizationGrant["candidate_id"],
    candidate_hash: asNullableString(row, "candidate_hash") as Hash | null,
    policy_version: asString(row, "policy_version"),
    issued_at: asNumber(row, "issued_at"),
    expires_at: asNullableNumber(row, "expires_at"),
    revoked_at: asNullableNumber(row, "revoked_at"),
    grant_hash: asString(row, "grant_hash") as Hash
  };
}

function grantRow(grant: AuthorizationGrant): Record<string, JsonValue> {
  return {
    grant_id: grant.grant_id,
    issued_by: grant.issued_by,
    human_attestation_json: canonicalJsonText(grant.human_attestation as unknown as JsonValue),
    subject: grant.subject,
    object_type: grant.object_type,
    scope_json: canonicalJsonText(grant.scope as unknown as JsonValue),
    actions_json: canonicalJsonText(grant.actions as unknown as JsonValue),
    mode: grant.mode,
    candidate_id: grant.candidate_id,
    candidate_hash: grant.candidate_hash,
    policy_version: grant.policy_version,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
    revoked_at: grant.revoked_at,
    grant_hash: grant.grant_hash
  };
}

function budgetReservationRow(reservation: BudgetReservation, scope: BudgetScopePolicy, profileHash: Hash): Record<string, JsonValue> {
  const binding = reservation.binding;
  return {
    reservation_id: reservation.reservation_id,
    reservation_key: reservation.reservation_key,
    policy_version: reservation.policy_version,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    purpose: reservation.purpose,
    scope_key: "",
    service_profile_id: "",
    service_profile_hash: profileHash,
    state: reservation.state,
    attempt_allowance: reservation.attempts_remaining,
    input_token_allowance: reservation.input_tokens_remaining,
    output_token_allowance: reservation.output_tokens_remaining,
    cost_allowance_micros: reservation.cost_micros_remaining,
    cost_status: reservation.cost_status,
    wall_allowance_ms: scope.wall_ms,
    non_refundable: 1,
    created_at: reservation.created_at,
    expires_at: reservation.expires_at,
    settled_at: reservation.state === "settled" ? reservation.created_at : null
  };
}

function replayPlanFromRow(row: Row): ReplayPlan | null {
  const isolation = parseJson(asNullableString(row, "isolation_json"));
  const binding = parseJson(asNullableString(row, "version_binding_json"));
  const kinds = parseJson(asNullableString(row, "side_effect_kinds_json"));
  const refs = parseJson(asNullableString(row, "side_effect_refs_json"));
  if (!isRecord(isolation) || !isRecord(binding) || !Array.isArray(kinds) || !Array.isArray(refs)) {
    return null;
  }
  return {
    schema_version: "rsi.replay_plan/2",
    replay_plan_id: asString(row, "replay_plan_id") as Id<"rpl">,
    validation_plan_id: asString(row, "validation_plan_id"),
    replay_class: asString(row, "replay_class") as ReplayPlan["replay_class"],
    command: asString(row, "command"),
    cwd: asString(row, "cwd"),
    allowed_network: asNumber(row, "allowed_network") === 1,
    network_target: asNullableString(row, "network_target"),
    classification_evidence: asString(row, "classification_evidence") as ReplayPlan["classification_evidence"],
    environment: asString(row, "environment") as ReplayPlan["environment"],
    isolation: isolation as unknown as ReplayPlan["isolation"],
    side_effect_kinds: kinds as ReplayPlan["side_effect_kinds"],
    side_effect_refs: refs as ReplayPlan["side_effect_refs"],
    version_binding: binding as unknown as VersionBinding,
    state: asString(row, "state") as ReplayPlan["state"],
    plan_hash: asString(row, "plan_hash") as Hash,
    row_version: asNumber(row, "row_version")
  };
}

function replayPlanRow(plan: ReplayPlan, createdAt: number): Record<string, JsonValue> {
  return {
    replay_plan_id: plan.replay_plan_id,
    validation_plan_id: plan.validation_plan_id,
    replay_class: plan.replay_class,
    command: plan.command,
    cwd: plan.cwd,
    allowed_network: plan.allowed_network ? 1 : 0,
    network_target: plan.network_target,
    classification_evidence: plan.classification_evidence,
    environment: plan.environment,
    isolation_json: canonicalJsonText(plan.isolation as unknown as JsonValue),
    version_binding_json: canonicalJsonText(bindingJson(plan.version_binding)),
    side_effect_kinds_json: canonicalJsonText(plan.side_effect_kinds as unknown as JsonValue),
    side_effect_refs_json: canonicalJsonText(plan.side_effect_refs as unknown as JsonValue),
    state: plan.state,
    plan_hash: plan.plan_hash,
    created_at: createdAt,
    row_version: plan.row_version
  };
}

function replayApprovalFromRow(row: Row): ReplayApproval | null {
  const attestation = parseJson(asNullableString(row, "human_attestation_json"));
  const binding = parseJson(asNullableString(row, "version_binding_json"));
  if (!isRecord(attestation) || !isRecord(binding)) {
    return null;
  }
  return {
    approval_id: asString(row, "approval_id") as Id<"rpa">,
    replay_plan_id: asString(row, "replay_plan_id") as Id<"rpl">,
    plan_hash: asString(row, "plan_hash") as Hash,
    approved_by: "human",
    human_attestation: attestation as unknown as ReplayApproval["human_attestation"],
    attestation_subject_hash: asString(row, "attestation_subject_hash") as Hash,
    approval_hash: asString(row, "approval_hash") as Hash,
    command: asString(row, "command"),
    cwd: asString(row, "cwd"),
    version_binding: binding as unknown as VersionBinding,
    allowed_network: asNumber(row, "allowed_network") === 1,
    network_target: asNullableString(row, "network_target"),
    ttl_ms: asNumber(row, "ttl_ms"),
    state: asString(row, "state") as ReplayApproval["state"],
    created_at: asNumber(row, "created_at"),
    expires_at: asNumber(row, "expires_at"),
    consumed_at: asNullableNumber(row, "consumed_at"),
    consumed_execution_id: asNullableString(row, "consumed_execution_id") as Id<"rex"> | null,
    revoked_at: asNullableNumber(row, "revoked_at"),
    revoke_reason: asNullableString(row, "revoke_reason") as ReplayApproval["revoke_reason"],
    row_version: asNumber(row, "row_version")
  };
}

function replayApprovalRow(approval: ReplayApproval): Record<string, JsonValue> {
  return {
    approval_id: approval.approval_id,
    replay_plan_id: approval.replay_plan_id,
    plan_hash: approval.plan_hash,
    approved_by: approval.approved_by,
    human_attestation_json: canonicalJsonText(approval.human_attestation as unknown as JsonValue),
    attestation_subject_hash: approval.attestation_subject_hash,
    approval_hash: approval.approval_hash,
    command: approval.command,
    cwd: approval.cwd,
    version_binding_json: canonicalJsonText(bindingJson(approval.version_binding)),
    allowed_network: approval.allowed_network ? 1 : 0,
    network_target: approval.network_target,
    ttl_ms: approval.ttl_ms,
    state: approval.state,
    created_at: approval.created_at,
    expires_at: approval.expires_at,
    consumed_at: approval.consumed_at,
    consumed_execution_id: approval.consumed_execution_id,
    revoked_at: approval.revoked_at,
    revoke_reason: approval.revoke_reason,
    row_version: approval.row_version
  };
}

function replayExecutionFromRow(row: Row): ReplayExecution {
  return {
    schema_version: "rsi.replay_execution/1",
    execution_id: asString(row, "execution_id") as Id<"rex">,
    replay_plan_id: asString(row, "replay_plan_id") as Id<"rpl">,
    approval_id: asNullableString(row, "approval_id") as Id<"rpa"> | null,
    state: asString(row, "state") as ReplayExecution["state"],
    fencing_token: asString(row, "fencing_token"),
    reconcile_required: asNumber(row, "reconcile_required") === 1,
    reconciled_at: asNullableNumber(row, "reconciled_at"),
    reconcile_evidence_ref: asNullableString(row, "reconcile_evidence_ref") as SourceRef | null,
    started_at: asNullableNumber(row, "started_at"),
    ended_at: asNullableNumber(row, "ended_at"),
    exit_code: asNullableNumber(row, "exit_code"),
    stdout_ref: asNullableString(row, "stdout_ref") as SourceRef | null,
    stderr_ref: asNullableString(row, "stderr_ref") as SourceRef | null,
    result_hash: asNullableString(row, "result_hash") as Hash | null,
    error_code: asNullableString(row, "error_code"),
    row_version: asNumber(row, "row_version"),
    created_at: asNumber(row, "created_at")
  };
}

function replayExecutionRow(execution: ReplayExecution): Record<string, JsonValue> {
  return {
    execution_id: execution.execution_id,
    replay_plan_id: execution.replay_plan_id,
    approval_id: execution.approval_id,
    state: execution.state,
    fencing_token: execution.fencing_token,
    reconcile_required: execution.reconcile_required ? 1 : 0,
    reconciled_at: execution.reconciled_at,
    reconcile_evidence_ref: execution.reconcile_evidence_ref,
    started_at: execution.started_at,
    ended_at: execution.ended_at,
    exit_code: execution.exit_code,
    stdout_ref: execution.stdout_ref,
    stderr_ref: execution.stderr_ref,
    result_hash: execution.result_hash,
    error_code: execution.error_code,
    row_version: execution.row_version,
    created_at: execution.created_at
  };
}

function egressApprovalRow(approval: EgressApproval): Record<string, JsonValue> {
  return {
    approval_id: approval.approval_id,
    policy_version: approval.policy_version,
    approved_by: approval.approved_by,
    human_attestation_json: canonicalJsonText(approval.human_attestation as unknown as JsonValue),
    attestation_subject_hash: approval.attestation_subject_hash,
    request_hash: approval.request_hash,
    approval_hash: approval.approval_hash,
    purpose: approval.purpose,
    version_binding_json: canonicalJsonText(bindingJson(approval.version_binding)),
    host: approval.endpoint.host,
    scheme: approval.endpoint.scheme,
    port: approval.endpoint.port,
    path: approval.endpoint.path,
    model: approval.model,
    project_id: approval.project_id,
    sources_json: canonicalJsonText(approval.sources as unknown as JsonValue),
    body_sha256: approval.body_sha256,
    byte_length: approval.byte_length,
    replay_plan_id: approval.replay_plan_id,
    state: approval.state,
    ttl_ms: approval.ttl_ms,
    created_at: approval.created_at,
    expires_at: approval.expires_at,
    consumed_at: approval.consumed_at,
    consumed_request_hash: approval.consumed_request_hash,
    revoked_at: approval.revoked_at,
    revoke_reason: approval.revoke_reason,
    row_version: approval.row_version
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Real ports already constructed for the production IPC handlers, exposed so
 * the default online tail reuses the same instances instead of a second
 * implementation. The extra key is ignored by `composeKernelHandlers`, which
 * reads only the documented method names.
 */
interface KernelServiceRuntimePorts {
  readonly decision: DecisionRecordPort;
  readonly delivery: DefaultDeliveryCreateEnqueuePort;
  /** W6 intake; `null` when the composition root left it disabled. */
  readonly feedback_intake: FeedbackIntakePort | null;
  /** TaskOutcome intake; shares the W6 enable switch. */
  readonly outcome_intake: OutcomeIntake | null;
  /** W5+W6 post-ACK fanout; `null` when neither hook is configured. */
  readonly post_commit: PostCommitPort | null;
  /**
   * Startup recovery barrier. Resolves after the whole durable replay scan has
   * been processed and never before its queue share is drained; `null` when no
   * intake exists or startup recovery was disabled.
   */
  readonly feedback_recovery: Promise<FeedbackRecoverySummary> | null;
  /**
   * Appendix P background replay. It is created whenever intake exists and is
   * started by the app composition after the IPC endpoint is published.
   * `feedback_recovery` remains only for composition roots that still want the
   * legacy startup barrier.
   */
  readonly feedback_recovery_worker: FeedbackRecoveryWorkerPort | null;
  /**
   * Drains feedback and post-commit work, then closes the journal writer only
   * when this composition opened it. Borrowed writers are left to their owner.
   * Idempotent: repeated calls share the same promise.
   */
  dispose(): Promise<void>;
}

export type KernelServices = KernelServicePorts & {
  readonly runtime: KernelServiceRuntimePorts;
};

export function createKernelServices(options: KernelServiceOptions): KernelServices {
  const { connection, config, now } = options;

  // Startup recovery: an expired lease is `unsettled`, not silently released.
  // The row keeps occupying the provider scope until the operator settles it.
  try {
    connection
      .prepare(
        "UPDATE budget_reservation SET state = 'unsettled' WHERE state = 'claimed' AND expires_at <= :now"
      )
      .run({ now: now() });
  } catch {
    // a fresh home without the budget tables is not a startup failure
  }

  // RPM/burst buckets are per provider scope and live in the coordinating
  // process; they start full for this process and never persist.
  const tokenBuckets = new Map<string, TokenBucketState>();
  const providerScopeByReservation = new Map<string, string>();
  // The single writer serializes claims so the inflight/global caps and the
  // token bucket observe each other's committed state.
  let claimChain: Promise<unknown> = Promise.resolve();
  function serializeClaim<Value>(run: () => Promise<Value>): Promise<Value> {
    const next = claimChain.then(run, run);
    claimChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  const journalResources = openJournalResources(options);
  const ledgerCommitter =
    journalResources === null ? null : createLedgerCommitter(options, journalResources);
  const sourceRefs: SourceRefPort =
    options.install_source_refs === undefined
      ? createSourceRefPort({ connection, blob_store: options.blob_store })
      : {
          resolve: options.install_source_refs.resolve,
          // A HOST-supplied resolver is read-only; the availability map is
          // never used as a write path.
          checkRetrievable: async () => new Map()
        };
  const ledgerPorts = createLedgerPorts(options, options.proof, journalResources, sourceRefs);
  // A dedicated W6 verifier scopes the proof to feedback/confirmation only;
  // the rest of the ledger keeps the shared option, which may be absent.
  const feedbackLedgerPorts =
    options.feedback_intake?.origin_proof === undefined
      ? ledgerPorts
      : { ...ledgerPorts, proof: options.feedback_intake.origin_proof };
  const feedbackClassifier: FeedbackIntentClassifier | undefined =
    options.feedback_intake?.classifier ??
    (options.feedback_intake?.intent_model === undefined
      ? undefined
      : createFeedbackIntentClassifier({
          model: options.feedback_intake.intent_model,
          sources: sourceRefs
        }));
  const feedbackIntake: FeedbackIntakePort | null =
    options.feedback_intake?.enabled === true && journalResources !== null
      ? createFeedbackIntake({
          connection,
          ledger: feedbackLedgerPorts,
          sources: sourceRefs,
          now,
          ...(feedbackClassifier === undefined ? {} : { classifier: feedbackClassifier }),
          ...(options.feedback_intake?.on_outcome === undefined
            ? {}
            : { on_outcome: options.feedback_intake.on_outcome }),
          ...(options.feedback_intake?.on_failure === undefined
            ? {}
            : { on_failure: options.feedback_intake.on_failure })
        })
      : null;
  const outcomeIntake =
    options.feedback_intake?.enabled === true && journalResources !== null
      ? createOutcomeIntake({
          connection,
          ledger: ledgerPorts,
          now,
          ...(options.feedback_intake?.on_outcome_error === undefined
            ? {}
            : { on_error: options.feedback_intake.on_outcome_error }),
          ...(options.feedback_intake?.on_outcome_evaluated === undefined
            ? {}
            : { on_evaluated: options.feedback_intake.on_outcome_evaluated })
        })
      : null;
  const feedbackRecovery: Promise<FeedbackRecoverySummary> | null =
    feedbackIntake !== null && options.feedback_intake?.recover_on_start !== false
      ? // Durable intent lives in `event_log`; replay is idempotent. The
        // promise is exposed as the startup barrier and consumes its own
        // rejection so an app that has not wired the barrier yet cannot crash
        // on an unhandled rejection.
        feedbackIntake.recover()
      : null;
  if (feedbackRecovery !== null) void feedbackRecovery.catch(() => undefined);
  const feedbackRecoveryWorker: FeedbackRecoveryWorkerPort | null =
    feedbackIntake === null
      ? null
      : createFeedbackRecoveryWorker({
          intake: feedbackIntake,
          ...(options.feedback_intake?.recovery_limits === undefined
            ? {}
            : { limits: options.feedback_intake.recovery_limits }),
          now
        });
  // Both hooks consume the same ACKed event. They run independently: one
  // failing or being disabled never suppresses the other.
  const postCommitHooks: NamedPostCommitHook[] = [];
  if (feedbackIntake !== null) {
    postCommitHooks.push({
      name: "feedback_intake",
      run: (event) => feedbackIntake.onCommitted(event)
    });
  }
  if (outcomeIntake !== null) {
    postCommitHooks.push({
      name: "outcome_intake",
      run: (event) => outcomeIntake.onCommitted(event)
    });
  }
  if (options.delivery_expiry_post_commit !== undefined) {
    postCommitHooks.push({
      name: "delivery_expiry",
      run: options.delivery_expiry_post_commit
    });
  }
  const postCommit =
    postCommitHooks.length === 0 ? null : createPostCommitFanout(postCommitHooks);
  const identityService = new IdentityService(ledgerPorts);
  const ledgerReadService = new LedgerReadService(ledgerPorts);
  const proof = options.proof;
  const rootRegistry = options.root_registry ?? createRootRegistry({
    connection,
    ...(journalResources === null ? {} : { journal: journalResources.committer }),
    home: options.home,
    ...(options.layout === undefined ? {} : { layout: options.layout }),
    now,
    ...(options.approved_roots === undefined ? {} : { approved_roots: options.approved_roots })
  });
  const rootResolver = createRootResolver({ registry: rootRegistry, now });
  const installReadiness =
    options.install_readiness ??
    createInstallReadinessPort({ connection, source_refs: sourceRefs });
  const identityForkHandler = createIdentityForkHandler({
    connection,
    now,
    identity: identityService,
    ...(journalResources === null ? {} : { journal: journalResources.committer }),
    home: options.home,
    ...(options.layout === undefined ? {} : { layout: options.layout })
  });
  const identityResumeHandler = createIdentityResumeHandler({
    connection,
    now,
    identity: identityService,
    ...(journalResources === null ? {} : { journal: journalResources.committer }),
    home: options.home,
    ...(options.layout === undefined ? {} : { layout: options.layout })
  });
  const installService = createInstallService({
    connection,
    blob_store: options.blob_store,
    now,
    readiness: installReadiness,
    ...(proof === undefined ? {} : { proof }),
    source_refs: sourceRefs,
    ...(journalResources === null
      ? {}
      : {
          journal: {
            writer: journalResources.writer,
            relative_path: journalResources.relativePath
          }
        })
  });
  const replayExecuteHandler =
    journalResources === null
      ? null
      : createReplayExecuteHandler({
          connection,
          journal: journalResources.writer,
          journal_relative_path: journalResources.relativePath,
          blob_store: options.blob_store,
          now
        });

  function humanProofUnavailable(method: IpcMethod): ErrorEnvelope {
    return internalError(`kernel.origin_proof_unavailable:${method}`);
  }

  function proofVerdictError(method: IpcMethod): ErrorEnvelope {
    return authDenied({ object_type: "grant", reason: "proof", stage: method });
  }

  async function commit(
    input: LedgerEventInput
  ): Promise<Result<void, ErrorEnvelope>> {
    if (ledgerCommitter === null) {
      return fail(internalError("kernel.journal_writer_unavailable"));
    }
    return ledgerCommitter.commit(input);
  }

  async function commitBatch(
    inputs: readonly LedgerEventInput[]
  ): Promise<Result<void, ErrorEnvelope>> {
    if (ledgerCommitter === null) {
      return fail(internalError("kernel.journal_writer_unavailable"));
    }
    return ledgerCommitter.commitBatch(inputs);
  }

  const decisionDelivery = createDefaultDecisionDeliveryService({
    connection,
    blob_store: options.blob_store,
    now,
    commit
  });

  const services: KernelServicePorts = {
    /* -------------------------------------------------------------- */
    /* Event ingestion — needs the FND event writer, not present.      */
    /* -------------------------------------------------------------- */
    "event.ingest": createEventIngestHandler({
      connection,
      blob_store: options.blob_store,
      config,
      now,
      identity: identityService,
      ...(options.proof === undefined ? {} : { proof: options.proof }),
      ...(journalResources === null
        ? {}
        : {
            journal: journalResources.writer,
            journal_relative_path: journalResources.relativePath
          }),
      home: options.home,
      ...(options.layout === undefined ? {} : { layout: options.layout }),
      // The ACK is already durable when this runs; the hooks consume the
      // committed event and never block or fail ingest.
      ...(postCommit === null ? {} : { post_commit: (event) => postCommit.dispatch(event) })
    }),

    /* -------------------------------------------------------------- */
    /* Identity                                                        */
    /* -------------------------------------------------------------- */
    "identity.resolve": async (context) => {
      const params = await Promise.resolve(context.params);
      const record = requireRecord(params, "params");
      if (!record.ok) return record;
      const hostId = record.value["host_id"];
      const configSpace = record.value["config_space"];
      const nativeSessionId = record.value["native_session_id"];
      if (typeof hostId !== "string" || !isHostId(hostId)) {
        return fail(fieldError("host_id", "host_id"));
      }
      if (typeof configSpace !== "string" || configSpace.length === 0) {
        return fail(fieldError("config_space", "non_empty_string"));
      }
      if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) {
        return fail(fieldError("native_session_id", "non_empty_string"));
      }
      const resolution = await identityService.resolve({
        host_id: hostId,
        config_space: configSpace,
        native_session_id: nativeSessionId
      });
      return resolution;
    },
    "identity.fork": identityForkHandler,
    "identity.resume": identityResumeHandler,

    /* -------------------------------------------------------------- */
    /* Ledger read                                                     */
    /* -------------------------------------------------------------- */
    "ledger.read": async (context) => {
      const record = requireRecord(context.params, "params");
      if (!record.ok) return record;
      const bindingValue = record.value["binding"];
      if (!isRecord(bindingValue)) {
        return fail(fieldError("binding", "must_be_object"));
      }
      const binding: VersionBinding = {
        task_id: String(bindingValue["task_id"] ?? "") as Id<"task">,
        branch_id: String(bindingValue["branch_id"] ?? "") as Id<"br">,
        input_epoch: Number(bindingValue["input_epoch"] ?? 0),
        goal_version: String(bindingValue["goal_version"] ?? ""),
        config_version: String(bindingValue["config_version"] ?? ""),
        watermark: Number(bindingValue["watermark"] ?? 0)
      };
      const bindingCheck = validateVersionBinding(binding);
      if (!bindingCheck.ok) return bindingCheck;
      const include = record.value["include"];
      if (!Array.isArray(include) || include.length === 0) {
        return fail(fieldError("include", "must_be_non_empty_array"));
      }
      const allowed = new Set(["requirements", "facts", "feedback", "corrections", "outcome", "constraints"]);
      for (let index = 0; index < include.length; index += 1) {
        const axis = include[index];
        if (typeof axis !== "string" || !allowed.has(axis)) {
          return fail(fieldError(`include[${String(index)}]`, "unknown_axis"));
        }
      }
      const view = await ledgerReadService.readLedger({ binding });
      if (!view.ok) return view;
      const selected = new Set(include);
      return ok({
        ...view.value,
        requirements: selected.has("requirements") ? view.value.requirements : [],
        facts: selected.has("facts") ? view.value.facts : [],
        feedback: selected.has("feedback") ? view.value.feedback : [],
        corrections: selected.has("corrections") ? view.value.corrections : [],
        constraints: selected.has("constraints") ? view.value.constraints : [],
        outcome: selected.has("outcome") ? view.value.outcome : null
      });
    },

    /* -------------------------------------------------------------- */
    /* Grants                                                          */
    /* -------------------------------------------------------------- */
    "grant.issue": async (context) => {
      const requestResult = requireRecord(context.params, "params");
      if (!requestResult.ok) return requestResult;
      const raw = requestResult.value;
      if (
        raw["schema_version"] !== "rsi.grant_issue/1" ||
        typeof raw["issued_by"] !== "string" ||
        typeof raw["object_type"] !== "string" ||
        !Array.isArray(raw["actions"]) ||
        !isRecord(raw["scope"]) ||
        !isRecord(raw["human_attestation"]) ||
        typeof raw["policy_version"] !== "string" ||
        !Object.prototype.hasOwnProperty.call(raw, "expires_at") ||
        !Object.prototype.hasOwnProperty.call(raw, "candidate_id") ||
        !Object.prototype.hasOwnProperty.call(raw, "candidate_hash")
      ) {
        return fail(fieldError("$", "grant_issue_shape"));
      }
      const request = raw as unknown as import("@evoplug/auth").GrantIssueRequest;
      const validated = validateGrantIssueRequest(request);
      if (!validated.ok) return validated;
      if (proof === undefined) {
        return fail(humanProofUnavailable("grant.issue"));
      }
      const subjectHash = grantIssueSubjectHash(request);
      const verdict = await proof.verifyControlPlane({
        attestation: request.human_attestation as unknown as import("@evoplug/ledger").HumanAttestation,
        subject_hash: subjectHash,
        purpose: "grant_issue"
      });
      if (verdict !== "verified") {
        return fail(proofVerdictError("grant.issue"));
      }
      const issuedAt = now();
      const created = createGrant({
        request,
        grant_id: newId("grant", issuedAt),
        issued_at: issuedAt
      });
      if (!created.ok) return created;
      const grant = created.value.grant;
      const row = grantRow(grant);
      const journaled = await commit({
        event_type: "grant.issued",
        entity_type: "authorization_grant",
        entity_id: grant.grant_id,
        operation: "insert",
        binding: null,
        row_schema: "rsi.authorization_grant/1",
        row,
        before: null,
        apply: (tx) => {
          tx.prepare(
            `INSERT INTO authorization_grant (
               grant_id, issued_by, human_attestation_json, subject, object_type, scope_json,
               actions_json, mode, candidate_id, candidate_hash, policy_version, issued_at,
               expires_at, revoked_at, grant_hash
             ) VALUES (
               :grant_id, :issued_by, :human_attestation_json, :subject, :object_type, :scope_json,
               :actions_json, :mode, :candidate_id, :candidate_hash, :policy_version, :issued_at,
               :expires_at, :revoked_at, :grant_hash
             )`
          ).run(asSqlParams(row));
        }
      });
      if (!journaled.ok) return journaled;
      const view: GrantView = {
        grant: toGrantPublicView(grant),
        consumed_write_id: null,
        consumed_config_write_id: null
      };
      return ok(view);
    },
    "grant.revoke": async (context) => {
      const requestResult = requireRecord(context.params, "params");
      if (!requestResult.ok) return requestResult;
      const raw = requestResult.value;
      if (
        raw["schema_version"] !== "rsi.grant_revoke/1" ||
        typeof raw["grant_id"] !== "string" ||
        !isId(raw["grant_id"], "grant") ||
        typeof raw["expected_grant_hash"] !== "string" ||
        !isHashValue(raw["expected_grant_hash"]) ||
        !isRecord(raw["human_attestation"]) ||
        (raw["reason"] !== "human_revoked" && raw["reason"] !== "policy_replaced")
      ) {
        return fail(fieldError("$", "grant_revoke_shape"));
      }
      const request = raw as unknown as import("@evoplug/auth").GrantRevokeRequest;
      if (proof === undefined) {
        return fail(humanProofUnavailable("grant.revoke"));
      }
      const subjectHash = grantRevokeSubjectHash(request);
      const verdict = await proof.verifyControlPlane({
        attestation: request.human_attestation as unknown as import("@evoplug/ledger").HumanAttestation,
        subject_hash: subjectHash,
        purpose: "grant_revoke"
      });
      if (verdict !== "verified") {
        return fail(proofVerdictError("grant.revoke"));
      }
      const row = oneRow<Row>(connection, "SELECT * FROM authorization_grant WHERE grant_id = :grant_id", {
        grant_id: request.grant_id
      });
      if (row === null) {
        return fail(authDenied({ object_type: "grant", reason: "revoked", grant_id: request.grant_id, stage: "grant_revoke" }));
      }
      const existing = grantFromRow(row);
      if (existing === null) {
        return fail(internalError("kernel.grant_row_corrupt"));
      }
      const revokedAt = now();
      const revoked = revokeGrant({ grant: existing, request, revoked_at: revokedAt });
      if (!revoked.ok) return revoked;
      const before = grantRow(existing);
      const after = grantRow(revoked.value);
      const journaled = await commit({
        event_type: "grant.revoked",
        entity_type: "authorization_grant",
        entity_id: revoked.value.grant_id,
        operation: "transition",
        binding: null,
        row_schema: "rsi.authorization_grant/1",
        row: after,
        before,
        apply: (tx) => {
          tx.prepare(
            "UPDATE authorization_grant SET revoked_at = :revoked_at WHERE grant_id = :grant_id AND grant_hash = :grant_hash"
          ).run({
            revoked_at: revoked.value.revoked_at,
            grant_id: revoked.value.grant_id,
            grant_hash: revoked.value.grant_hash
          });
        }
      });
      if (!journaled.ok) return journaled;
      return ok({
        grant: toGrantPublicView(revoked.value),
        consumed_write_id: null,
        consumed_config_write_id: null
      });
    },
    "grant.list": async (context) => {
      const record = requireRecord(context.params, "params");
      if (!record.ok) return record;
      const objectType = record.value["object_type"];
      if (objectType !== undefined) {
        if (
          objectType !== "skill" &&
          objectType !== "memory" &&
          objectType !== "instructions" &&
          objectType !== "config"
        ) {
          return fail(fieldError("object_type", "grant_object_type"));
        }
      }
      const stateFilter = record.value["state"];
      if (stateFilter !== undefined) {
        if (
          stateFilter !== "active" &&
          stateFilter !== "revoked" &&
          stateFilter !== "expired" &&
          stateFilter !== "consumed"
        ) {
          return fail(fieldError("state", "grant_list_state"));
        }
      }
      const rawLimit = record.value["limit"];
      let limit = 100;
      if (rawLimit !== undefined) {
        if (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000) {
          return fail(fieldError("limit", "integer_1_1000"));
        }
        limit = rawLimit;
      }
      const rows = allRows<Row>(
        connection,
        `SELECT g.*, c.managed_write_id, c.config_write_id
           FROM authorization_grant g
           LEFT JOIN grant_consumption c ON c.grant_id = g.grant_id
          ORDER BY g.issued_at DESC, g.grant_id DESC`
      );
      const grants: GrantView[] = [];
      const at = now();
      for (const row of rows) {
        const grant = grantFromRow(row);
        if (grant === null) {
          return fail(internalError("kernel.grant_row_corrupt"));
        }
        const view: GrantView = {
          grant: toGrantPublicView(grant),
          consumed_write_id: asNullableString(row, "managed_write_id") as Id<"wi"> | null,
          consumed_config_write_id: asNullableString(row, "config_write_id") as Id<"cwi"> | null
        };
        if (objectType !== undefined && view.grant.object_type !== objectType) {
          continue;
        }
        if (stateFilter !== undefined && grantListState(view, at) !== stateFilter) {
          continue;
        }
        grants.push(view);
        if (grants.length >= limit) break;
      }
      return ok({ grants });
    },

    /* -------------------------------------------------------------- */
    /* Budget                                                          */
    /* -------------------------------------------------------------- */
    "budget.reserve": async (context) => {
      if (!isRecord(context.params)) {
        return fail(fieldError("$", "must_be_object"));
      }
      const request = context.params as unknown as BudgetReserveRequest;
      if (
        request.schema_version !== "rsi.budget_reserve/1" ||
        typeof request.reservation_key !== "string" ||
        request.reservation_key.length === 0 ||
        typeof request.scope_key !== "string" ||
        request.scope_key.length === 0 ||
        typeof request.service_profile_id !== "string" ||
        typeof request.provider_scope !== "string" ||
        !isRecord(request.binding) ||
        !isRecord(request.limits)
      ) {
        return fail(fieldError("$", "budget_reserve_shape"));
      }
      const bindingCheck = validateVersionBinding(request.binding);
      if (!bindingCheck.ok) return bindingCheck;
      const policy = loadBudgetPolicy(connection);
      if (!policy.ok) return policy;
      const scope = findScopePolicy(policy.value, request.purpose);
      if (scope === null) {
        return fail(budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_scope_read", details: { kind: "none" } }));
      }
      const planned = planReservation({
        scope,
        limits: request.limits,
        input_tokens_requested: request.input_tokens_requested,
        output_tokens_requested: request.output_tokens_requested,
        reservation_ttl_ms: policy.value.reservation_ttl_ms,
        now: now()
      });
      if (!planned.ok) return planned;
      const existing = oneRow<Row>(
        connection,
        "SELECT * FROM budget_reservation WHERE scope_key = :scope_key AND reservation_key = :reservation_key",
        { scope_key: request.scope_key, reservation_key: request.reservation_key }
      );
      if (existing !== null) {
        const decoded = readReservationInTransaction(asTx(connection), existing["reservation_id"] as Id<"resv">);
        if (!decoded.ok) return decoded;
        return ok(decoded.value);
      }
      const unsettled = oneRow<Row>(
        connection,
        "SELECT 1 AS present FROM budget_reservation WHERE scope_key = :scope_key AND state = 'unsettled' LIMIT 1",
        { scope_key: request.scope_key }
      );
      if (unsettled !== null && request.limits.source === "verified_profile") {
        return fail(
          budgetError({
            code: "E_BUDGET_EXCEEDED",
            stage: "budget_reserve",
            details: {
              kind: "budget",
              scope_key: request.scope_key,
              policy_version: "bpol/1",
              budget_kind: "cost",
              remaining: null
            }
          })
        );
      }
      const reservation = createReservation({
        reservation_id: newId("resv", now()),
        request,
        plan: planned.value,
        now: now()
      });
      providerScopeByReservation.set(reservation.reservation_id, request.provider_scope);
      const profileHash =
        request.limits.source === "verified_profile"
          ? request.limits.profile_hash
          : canonicalHash({ source: "unknown", reason_code: request.limits.reason_code });
      const row = budgetReservationRow(reservation, scope, profileHash);
      row["scope_key"] = request.scope_key;
      row["service_profile_id"] = request.service_profile_id;
      const journaled = await commit({
        event_type: "budget.reserved",
        entity_type: "budget_reservation",
        entity_id: reservation.reservation_id,
        operation: "insert",
        binding: reservation.binding,
        row_schema: "rsi.budget_reservation/1",
        row,
        before: null,
        apply: (tx) => {
          tx.prepare(
            `INSERT INTO budget_reservation (
               reservation_id, reservation_key, policy_version, task_id, branch_id, input_epoch,
               goal_version, config_version, watermark, purpose, scope_key, service_profile_id,
               service_profile_hash, state, attempt_allowance, input_token_allowance,
               output_token_allowance, cost_allowance_micros, cost_status, wall_allowance_ms,
               non_refundable, created_at, expires_at, settled_at
             ) VALUES (
               :reservation_id, :reservation_key, :policy_version, :task_id, :branch_id, :input_epoch,
               :goal_version, :config_version, :watermark, :purpose, :scope_key, :service_profile_id,
               :service_profile_hash, :state, :attempt_allowance, :input_token_allowance,
               :output_token_allowance, :cost_allowance_micros, :cost_status, :wall_allowance_ms,
               :non_refundable, :created_at, :expires_at, :settled_at
             )`
          ).run(asSqlParams(row));
        }
      });
      if (!journaled.ok) return journaled;
      return ok(reservation);
    },
    "budget.claim": async (context) => serializeClaim(async () => {
      if (!isRecord(context.params)) {
        return fail(fieldError("$", "must_be_object"));
      }
      const request = context.params as unknown as BudgetClaimRequest;
      if (
        typeof request.reservation_id !== "string" ||
        !isId(request.reservation_id, "resv") ||
        typeof request.attempt_ref !== "string" ||
        request.attempt_ref.length === 0 ||
        typeof request.counting_method_version !== "string" ||
        request.counting_method_version.length === 0 ||
        typeof request.deadline_ms !== "number" ||
        !Number.isSafeInteger(request.deadline_ms)
      ) {
        return fail(fieldError("$", "budget_claim_shape"));
      }
      const reservationRow = oneRow<Row>(
        connection,
        "SELECT * FROM budget_reservation WHERE reservation_id = :reservation_id",
        { reservation_id: request.reservation_id }
      );
      if (reservationRow === null) {
        return fail(internalError("kernel.budget_reservation_not_found"));
      }
      const reservationResult = readReservationInTransaction(asTx(connection), request.reservation_id);
      if (!reservationResult.ok) return reservationResult;
      const policy = loadBudgetPolicy(connection);
      if (!policy.ok) return policy;
      const scope = findScopePolicy(policy.value, reservationResult.value.purpose);
      if (scope === null) {
        return fail(budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_scope_read", details: { kind: "none" } }));
      }
      const scopeKey = asString(reservationRow, "scope_key");
      const inflight = oneRow<{ count: number }>(
        connection,
        "SELECT COUNT(*) AS count FROM budget_reservation WHERE scope_key = :scope_key AND state = 'claimed' AND expires_at > :now",
        { scope_key: scopeKey, now: now() }
      );
      const globalInflight = oneRow<{ count: number }>(
        connection,
        "SELECT COUNT(*) AS count FROM budget_reservation WHERE state = 'claimed' AND expires_at > :now",
        { now: now() }
      );
      const cooldown = oneRow<Row>(
        connection,
        "SELECT cooldown_until FROM rate_limit_state WHERE scope_key = :scope_key",
        { scope_key: scopeKey }
      );
      const decision = planClaim({
        reservation: reservationResult.value,
        request,
        scope,
        environment: {
          inflight: inflight?.count ?? 0,
          per_scope_limit: policy.value.concurrency.per_scope_inflight,
          global_inflight: globalInflight?.count ?? 0,
          global_limit: policy.value.concurrency.global_inflight,
          cooldown_until: cooldown === null ? null : asNullableNumber(cooldown, "cooldown_until"),
          now: now()
        },
        attempt_charge_id: newId("chg", now())
      });
      if (!decision.ok) return decision;
      if (decision.value.result.state === "blocked") {
        return ok(decision.value.result);
      }
      const providerScope = providerScopeByReservation.get(request.reservation_id) ?? scopeKey;
      const bucketConfig = {
        rpm: policy.value.concurrency.rpm,
        burst: policy.value.concurrency.burst
      };
      let bucket = tokenBuckets.get(providerScope);
      if (bucket === undefined) {
        bucket = { tokens: bucketConfig.burst, last_refill_ms: now() };
      }
      const consumed = consumeToken(bucket, bucketConfig, now());
      tokenBuckets.set(providerScope, consumed.state);
      if (!consumed.allowed) {
        return ok({
          state: "blocked" as const,
          reason_code: "rate_limited" as const,
          retry_after_ms: consumed.retry_after_ms
        });
      }
      const claimed = decision.value.reservation;
      const before = reservationRow as Record<string, JsonValue>;
      const after = planReservationRowUpdate(claimed, reservationRow);
      const charge = makeClaimCharge({
        charge_id: decision.value.result.attempt_charge_id,
        charge_key: `claim:${claimed.reservation_id}:${request.attempt_ref}`,
        reservation_id: claimed.reservation_id,
        charged_at: now()
      });
      const journaled = await commit({
        event_type: "budget.claimed",
        entity_type: "budget_reservation",
        entity_id: claimed.reservation_id,
        operation: "transition",
        binding: claimed.binding,
        row_schema: "rsi.budget_reservation/1",
        row: after,
        before,
        apply: (tx) => {
          updateReservationRow(tx, claimed);
          insertAllowanceCharge(tx, charge);
        }
      });
      if (!journaled.ok) return journaled;
      return ok(decision.value.result);
    }),
    "budget.settle": async (context) => {
      if (!isRecord(context.params)) {
        return fail(fieldError("$", "must_be_object"));
      }
      const request = context.params as unknown as BudgetSettleRequest;
      if (
        typeof request.reservation_id !== "string" ||
        !isId(request.reservation_id, "resv") ||
        (request.outcome !== "succeeded" &&
          request.outcome !== "failed" &&
          request.outcome !== "cancelled" &&
          request.outcome !== "not_sent" &&
          request.outcome !== "unknown") ||
        (request.provider_usage !== null && !isRecord(request.provider_usage))
      ) {
        return fail(fieldError("$", "budget_settle_shape"));
      }
      const reservationRow = oneRow<Row>(
        connection,
        "SELECT * FROM budget_reservation WHERE reservation_id = :reservation_id",
        { reservation_id: request.reservation_id }
      );
      if (reservationRow === null) {
        return fail(internalError("kernel.budget_reservation_not_found"));
      }
      const reservationResult = readReservationInTransaction(asTx(connection), request.reservation_id);
      if (!reservationResult.ok) return reservationResult;
      const policy = loadBudgetPolicy(connection);
      if (!policy.ok) return policy;
      const scope = findScopePolicy(policy.value, reservationResult.value.purpose);
      if (scope === null) {
        return fail(budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_scope_read", details: { kind: "none" } }));
      }
      if (request.provider_usage !== null) {
        const usageCheck = validateProviderUsage(request.provider_usage);
        if (!usageCheck.ok) return usageCheck;
      }
      const planned = planSettlement({
        reservation: reservationResult.value,
        request,
        scope
      });
      if (!planned.ok) return planned;
      const settlement = planned.value.settlement;
      const next = planned.value.reservation;
      const before = reservationRow as Record<string, JsonValue>;
      const after = planReservationRowUpdate(next, reservationRow);
      const journaled = await commit({
        event_type:
          settlement.state === "settled"
            ? "budget.settled"
            : settlement.state === "released"
              ? "budget.released"
              : "budget.unsettled",
        entity_type: "budget_reservation",
        entity_id: next.reservation_id,
        operation: "transition",
        binding: next.binding,
        row_schema: "rsi.budget_reservation/1",
        row: after,
        before,
        apply: (tx) => {
          updateReservationRow(tx, next);
          if (request.provider_usage !== null) {
            insertProviderUsage(tx, next.reservation_id, request.provider_usage);
          }
          if (settlement.input_token_charges !== null) {
            insertAllowanceCharge(
              tx,
              makeUsageCharge({
                charge_id: newId("chg", now()),
                charge_key: `usage:input:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: "input_token",
                amount: settlement.input_token_charges,
                charged_at: now()
              })
            );
          }
          if (settlement.output_token_charges !== null) {
            insertAllowanceCharge(
              tx,
              makeUsageCharge({
                charge_id: newId("chg", now()),
                charge_key: `usage:output:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: "output_token",
                amount: settlement.output_token_charges,
                charged_at: now()
              })
            );
          }
          if (settlement.cost_charges_micros !== null) {
            insertAllowanceCharge(
              tx,
              makeUsageCharge({
                charge_id: newId("chg", now()),
                charge_key: `usage:cost:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: "cost_micros",
                amount: settlement.cost_charges_micros,
                charged_at: now()
              })
            );
          }
          if (planned.value.overage_charge !== null) {
            insertAllowanceCharge(
              tx,
              makeOverageCharge({
                charge_id: newId("chg", now()),
                charge_key: `overage:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: planned.value.overage_charge.kind,
                amount: planned.value.overage_charge.amount,
                charged_at: now()
              })
            );
          }
        }
      });
      if (!journaled.ok) return journaled;
      return ok(settlement);
    },

    /* -------------------------------------------------------------- */
    /* Decision record                                                 */
    /* -------------------------------------------------------------- */
    "decision.record": decisionDelivery.handlers["decision.record"],
    "delivery.create": decisionDelivery.handlers["delivery.create"],
    "delivery.update": async (context) => {
      const parsed = parseDeliveryUpdateRequest(context.params);
      if (!parsed.ok) return parsed;
      const request = parsed.value;
      const row = oneRow<Row>(connection, "SELECT * FROM delivery WHERE delivery_id = :delivery_id", {
        delivery_id: request.delivery_id
      });
      if (row === null) {
        return fail(internalError("kernel.delivery_not_found"));
      }
      const record = deliveryFromRow(row);
      if (record === null) {
        return fail(internalError("kernel.delivery_row_corrupt"));
      }
      let evidenceRetrievable = false;
      if (request.update.axis !== "transport") {
        const ref = parseSourceRef(request.update.evidence_ref);
        if (ref.ok) {
          const verified = options.blob_store.verify(ref.value.locator as Hash);
          evidenceRetrievable = verified.ok && verified.value.present && verified.value.hash_matches;
        }
      }
      const applied = applyDeliveryUpdate(record, request, {
        now_ms: now(),
        evidence_retrievable: evidenceRetrievable,
        human_attestation_verified: false
      });
      if (!applied.ok) return applied;
      const outcome = applied.value;
      if (!outcome.changed) {
        return ok({ delivery: outcome.record });
      }
      const before = row as Record<string, JsonValue>;
      const after = deliveryRow(outcome.record);
      const noteCode = outcome.note_code;
      const historyAt = now();
      const history = noteCode === null
        ? undefined
        : (eventId: Id<"ev">): JsonValue => {
            const entry = deriveDeliveryHistory(
              outcome.record,
              eventId,
              noteCode,
              historyAt,
              outcome.evidence_ref
            );
            return {
              at: entry.at,
              state: entry.state,
              inclusion_evidence: entry.inclusion_evidence,
              adoption: entry.adoption,
              evidence_ref: entry.evidence_ref,
              terminal_reason: entry.terminal_reason,
              note_code: entry.note_code
            };
          };
      const journaled = await commit({
        event_type: "delivery.recorded",
        entity_type: "delivery",
        entity_id: outcome.record.delivery_id,
        operation: "transition",
        binding: {
          task_id: outcome.record.task_id,
          branch_id: outcome.record.branch_id,
          input_epoch: outcome.record.input_epoch,
          goal_version: outcome.record.goal_version,
          config_version: outcome.record.config_version,
          watermark: 0
        },
        row_schema: "rsi.delivery_row/1",
        row: after,
        before,
        ...(history === undefined ? {} : { history }),
        apply: (tx, _afterHash, eventId) => {
          tx.prepare(
            `UPDATE delivery SET
               state = :state, inclusion_evidence = :inclusion_evidence,
               transport_body_verified = :transport_body_verified, submission_ref = :submission_ref,
               inclusion_ref = :inclusion_ref, adoption = :adoption, adoption_ref = :adoption_ref,
               terminal_reason = :terminal_reason, row_version = :row_version, updated_at = :updated_at
             WHERE delivery_id = :delivery_id`
          ).run(asSqlParams(after));
          if (noteCode !== null) {
            insertDeliveryHistory(
              tx,
              outcome.record,
              eventId,
              noteCode,
              historyAt,
              outcome.evidence_ref
            );
          }
        }
      });
      if (!journaled.ok) return journaled;
      return ok({ delivery: outcome.record });
    },

    /* -------------------------------------------------------------- */
    /* Managed writes — the executor and root registry are not owned.   */
    /* -------------------------------------------------------------- */
    "write.apply": createWriteApplyHandler({
      connection,
      blob_store: options.blob_store,
      now,
      home: options.home,
      ...(options.layout === undefined ? {} : { layout: options.layout }),
      ...(options.write_root_resolver === undefined
        ? { root_resolver: rootResolver }
        : { root_resolver: options.write_root_resolver })
    }),

    /* -------------------------------------------------------------- */
    /* Egress                                                          */
    /* -------------------------------------------------------------- */
    "egress.evaluate": async (context) => {
      const parsed = parseEgressRequestInput(context.params);
      if (!parsed.ok) return parsed;
      const policyRow = readActiveEgressPolicy(connection);
      if (policyRow === null) {
        return fail(egressPolicyStaleError(config.egress_policy_version));
      }
      const policyJson = parseJson(policyRow.canonical_json);
      if (policyJson === null) {
        return fail(internalError("kernel.egress_policy_corrupt"));
      }
      const policyResult = parseEgressPolicy(policyJson);
      if (!policyResult.ok) return policyResult;
      const policy = policyResult.value;
      const frozen = freezeEgressRequest(parsed.value, policy.policy_version);
      if (!frozen.ok) return frozen;
      const status = new Map<SourceRef, EgressSourceStatus>();
      for (const source of frozen.value.sources) {
        status.set(source.ref, sourceStatus(connection, options.blob_store, source.ref, parsed.value.binding));
      }
      const approval = activeEgressApproval(connection, frozen.value.request_hash, now());
      const evaluated = evaluateEgress(policy, parsed.value, {
        now_ms: now(),
        source_status: status,
        active_approval: approval
      });
      if (!evaluated.ok) return evaluated;
      return ok(evaluated.value);
    },
    "egress.approve": async (context) => {
      const parsed = parseEgressApprovalRequest(context.params);
      if (!parsed.ok) return parsed;
      if (proof === undefined) {
        return fail(humanProofUnavailable("egress.approve"));
      }
      const policyRow = readActiveEgressPolicy(connection);
      if (policyRow === null) {
        return fail(egressPolicyStaleError(parsed.value.request.policy_version));
      }
      const policyJson = parseJson(policyRow.canonical_json);
      if (policyJson === null) {
        return fail(internalError("kernel.egress_policy_corrupt"));
      }
      const policyResult = parseEgressPolicy(policyJson);
      if (!policyResult.ok) return policyResult;
      if (policyResult.value.policy_version !== parsed.value.request.policy_version) {
        return fail(egressPolicyStaleError(policyResult.value.policy_version));
      }
      const created = createEgressApproval({
        approval_id: newId("egr", now()),
        request: parsed.value.request,
        policy_version: policyResult.value.policy_version,
        ttl_ms: parsed.value.ttl_ms,
        now_ms: now(),
        human_attestation: parsed.value.human_attestation
      });
      if (!created.ok) return created;
      const attestationSubjectHash = created.value.attestation_subject_hash;
      const verdict = await proof.verifyControlPlane({
        attestation: parsed.value.human_attestation as unknown as import("@evoplug/ledger").HumanAttestation,
        subject_hash: attestationSubjectHash,
        purpose: "egress_approve"
      });
      if (verdict !== "verified") {
        return fail(authDenied({ object_type: "grant", reason: "proof", stage: "egress_approve" }));
      }
      const approval = created.value;
      if (computeEgressApprovalHash(approval) !== approval.approval_hash) {
        return fail(internalError("kernel.egress_approval_hash_mismatch"));
      }
      const row = egressApprovalRow(approval);
      const journaled = await commit({
        event_type: "egress.approval_recorded",
        entity_type: "egress_approval",
        entity_id: approval.approval_id,
        operation: "insert",
        binding: approval.version_binding,
        row_schema: "rsi.egress_approval_row/1",
        row,
        before: null,
        apply: (tx) => {
          tx.prepare(
            `INSERT INTO egress_approval (
               approval_id, policy_version, approved_by, human_attestation_json,
               attestation_subject_hash, request_hash, approval_hash, purpose,
               version_binding_json, host, scheme, port, path, model, project_id,
               sources_json, body_sha256, byte_length, replay_plan_id, state, ttl_ms,
               created_at, expires_at, consumed_at, consumed_request_hash, revoked_at,
               revoke_reason, row_version
             ) VALUES (
               :approval_id, :policy_version, :approved_by, :human_attestation_json,
               :attestation_subject_hash, :request_hash, :approval_hash, :purpose,
               :version_binding_json, :host, :scheme, :port, :path, :model, :project_id,
               :sources_json, :body_sha256, :byte_length, :replay_plan_id, :state, :ttl_ms,
               :created_at, :expires_at, :consumed_at, :consumed_request_hash, :revoked_at,
               :revoke_reason, :row_version
             )`
          ).run(asSqlParams(row));
        }
      });
      if (!journaled.ok) return journaled;
      return ok(toEgressApprovalView(approval));
    },

    /* -------------------------------------------------------------- */
    /* Install — requires the HOST readiness port.                     */
    /* -------------------------------------------------------------- */
    "install.approve": installService.handlers["install.approve"],
    "install.revoke": installService.handlers["install.revoke"],
    "install.approval.get": installService.handlers["install.approval.get"],
    "install.approval.consume": installService.handlers["install.approval.consume"],

    /* -------------------------------------------------------------- */
    /* Replay                                                          */
    /* -------------------------------------------------------------- */
    "replay.classify": async (context) => {
      const parsed = parseReplayClassifyRequest(context.params);
      if (!parsed.ok) return parsed;
      return classifyReplay(parsed.value);
    },
    "replay.create": async (context) => {
      const record = requireRecord(context.params, "params");
      if (!record.ok) return record;
      const draft = parseReplayPlanDraft(record.value["plan"]);
      if (!draft.ok) return draft;
      // Persist the resolved working directory so execution can require an
      // exact, symlink-free match on every host (macOS /var -> /private/var).
      let resolvedCwd: string;
      try {
        resolvedCwd = realpathSync(draft.value.cwd);
      } catch {
        return fail(fieldError("cwd", "resolvable_directory"));
      }
      const created = createReplayPlan({ ...draft.value, cwd: resolvedCwd }, newId("rpl", now()));
      if (!created.ok) return created;
      const plan = created.value;
      const existingRow = oneRow<Row>(
        connection,
        "SELECT * FROM replay_plan WHERE validation_plan_id = :validation_plan_id AND plan_hash = :plan_hash",
        { validation_plan_id: plan.validation_plan_id, plan_hash: plan.plan_hash }
      );
      if (existingRow !== null) {
        const existing = replayPlanFromRow(existingRow);
        if (existing === null) return fail(internalError("kernel.replay_plan_row_corrupt"));
        return ok({ plan: existing, created: false });
      }
      const row = replayPlanRow(plan, now());
      const journaled = await commit({
        event_type: "replay.plan_recorded",
        entity_type: "replay_plan",
        entity_id: plan.replay_plan_id,
        operation: "insert",
        binding: plan.version_binding,
        row_schema: "rsi.replay_plan_row/1",
        row,
        before: null,
        apply: (tx) => {
          tx.prepare(
            `INSERT INTO replay_plan (
               replay_plan_id, validation_plan_id, replay_class, command, cwd, allowed_network,
               network_target, classification_evidence, environment, isolation_json,
               version_binding_json, side_effect_kinds_json, side_effect_refs_json, state,
               plan_hash, created_at, row_version
             ) VALUES (
               :replay_plan_id, :validation_plan_id, :replay_class, :command, :cwd, :allowed_network,
               :network_target, :classification_evidence, :environment, :isolation_json,
               :version_binding_json, :side_effect_kinds_json, :side_effect_refs_json, :state,
               :plan_hash, :created_at, :row_version
             )`
          ).run(asSqlParams(row));
        }
      });
      if (!journaled.ok) return journaled;
      return ok({ plan, created: true });
    },
    "replay.authorize": async (context) => {
      const parsed = parseReplayAuthorizeRequest(context.params);
      if (!parsed.ok) return parsed;
      const planRow = oneRow<Row>(
        connection,
        "SELECT * FROM replay_plan WHERE replay_plan_id = :replay_plan_id",
        { replay_plan_id: parsed.value.replay_plan_id }
      );
      if (planRow === null) {
        return fail(internalError("kernel.replay_plan_not_found"));
      }
      const plan = replayPlanFromRow(planRow);
      if (plan === null) return fail(internalError("kernel.replay_plan_row_corrupt"));
      let approval: ReplayApproval | null = null;
      if (parsed.value.approval_id !== null) {
        const approvalRow = oneRow<Row>(
          connection,
          "SELECT * FROM replay_approval WHERE approval_id = :approval_id",
          { approval_id: parsed.value.approval_id }
        );
        if (approvalRow === null) {
          return fail(replayApprovalNotFoundError(plan.replay_plan_id));
        }
        approval = replayApprovalFromRow(approvalRow);
        if (approval === null) return fail(internalError("kernel.replay_approval_row_corrupt"));
      }
      return authorizeReplay({ plan, approval, now_ms: now() });
    },
    "replay.approve": async (context) => {
      const parsed = parseReplayApproveRequest(context.params);
      if (!parsed.ok) return parsed;
      if (proof === undefined) {
        return fail(humanProofUnavailable("replay.approve"));
      }
      const planRow = oneRow<Row>(
        connection,
        "SELECT * FROM replay_plan WHERE replay_plan_id = :replay_plan_id",
        { replay_plan_id: parsed.value.replay_plan_id }
      );
      if (planRow === null) return fail(internalError("kernel.replay_plan_not_found"));
      const plan = replayPlanFromRow(planRow);
      if (plan === null) return fail(internalError("kernel.replay_plan_row_corrupt"));
      const activeExecution = oneRow<Row>(
        connection,
        "SELECT 1 AS present FROM replay_execution WHERE replay_plan_id = :replay_plan_id AND state IN ('authorized','running') LIMIT 1",
        { replay_plan_id: plan.replay_plan_id }
      );
      const unknownExecution = oneRow<Row>(
        connection,
        "SELECT 1 AS present FROM replay_execution WHERE replay_plan_id = :replay_plan_id AND state = 'unknown' AND reconcile_required = 1 LIMIT 1",
        { replay_plan_id: plan.replay_plan_id }
      );
      const subjectHash = computeReplayApproveSubjectHash({
        replay_plan_id: plan.replay_plan_id,
        plan_hash: parsed.value.expected_plan_hash,
        ttl_ms: parsed.value.ttl_ms,
        reason: parsed.value.reason
      });
      const verdict = await proof.verifyControlPlane({
        attestation: parsed.value.human_attestation as unknown as import("@evoplug/ledger").HumanAttestation,
        subject_hash: subjectHash,
        purpose: "replay_approve"
      });
      if (verdict !== "verified") {
        return fail(replayAttestationUnverifiedError(plan.replay_plan_id));
      }
      const created = createReplayApproval({
        approval_id: newId("rpa", now()),
        plan,
        expected_plan_hash: parsed.value.expected_plan_hash,
        ttl_ms: parsed.value.ttl_ms,
        reason: parsed.value.reason,
        now_ms: now(),
        human_attestation: parsed.value.human_attestation,
        has_active_execution: activeExecution !== null,
        has_unreconciled_unknown: unknownExecution !== null
      });
      if (!created.ok) return created;
      const approval = created.value;
      const row = replayApprovalRow(approval);
      const journaled = await commit({
        event_type: "replay.approval_recorded",
        entity_type: "replay_approval",
        entity_id: approval.approval_id,
        operation: "insert",
        binding: approval.version_binding,
        row_schema: "rsi.replay_approval_row/1",
        row,
        before: null,
        apply: (tx) => {
          tx.prepare(
            `INSERT INTO replay_approval (
               approval_id, replay_plan_id, plan_hash, approved_by, human_attestation_json,
               attestation_subject_hash, approval_hash, command, cwd, version_binding_json,
               allowed_network, network_target, ttl_ms, state, created_at, expires_at,
               consumed_at, consumed_execution_id, revoked_at, revoke_reason, row_version
             ) VALUES (
               :approval_id, :replay_plan_id, :plan_hash, :approved_by, :human_attestation_json,
               :attestation_subject_hash, :approval_hash, :command, :cwd, :version_binding_json,
               :allowed_network, :network_target, :ttl_ms, :state, :created_at, :expires_at,
               :consumed_at, :consumed_execution_id, :revoked_at, :revoke_reason, :row_version
             )`
          ).run(asSqlParams(row));
        }
      });
      if (!journaled.ok) return journaled;
      return ok(toReplayApprovalView(approval));
    },
    "replay.revoke": async (context) => {
      const parsed = parseReplayRevokeRequest(context.params);
      if (!parsed.ok) return parsed;
      if (proof === undefined) {
        return fail(humanProofUnavailable("replay.revoke"));
      }
      const approvalRow = oneRow<Row>(
        connection,
        "SELECT * FROM replay_approval WHERE approval_id = :approval_id",
        { approval_id: parsed.value.approval_id }
      );
      if (approvalRow === null) return fail(internalError("kernel.replay_approval_not_found"));
      const approval = replayApprovalFromRow(approvalRow);
      if (approval === null) return fail(internalError("kernel.replay_approval_row_corrupt"));
      const subjectHash = computeReplayRevokeSubjectHash({
        approval_id: parsed.value.approval_id,
        expected_approval_hash: parsed.value.expected_approval_hash,
        reason: parsed.value.reason
      });
      const verdict = await proof.verifyControlPlane({
        attestation: parsed.value.human_attestation as unknown as import("@evoplug/ledger").HumanAttestation,
        subject_hash: subjectHash,
        purpose: "replay_revoke"
      });
      if (verdict !== "verified") {
        return fail(replayAttestationUnverifiedError(approval.replay_plan_id));
      }
      const revoked = revokeReplayApproval(approval, parsed.value.expected_approval_hash, now(), parsed.value.reason);
      if (!revoked.ok) {
        // DD-FND-096.2 step 2: an `active` row whose TTL elapsed must first be
        // persisted as `expired` (journal then SQLite) before the error
        // returns, so recovery never sees a stale `active` row.
        if (revoked.error.code === "E_REPLAY_APPROVAL_EXPIRED") {
          const expired = expireReplayApproval(approval, now());
          if (expired.state === "expired") {
            const expiredRow = replayApprovalRow(expired);
            const expiredJournaled = await commit({
              event_type: "replay.approval_transition",
              entity_type: "replay_approval",
              entity_id: expired.approval_id,
              operation: "transition",
              binding: expired.version_binding,
              row_schema: "rsi.replay_approval_row/1",
              row: expiredRow,
              before: approvalRow as Record<string, JsonValue>,
              apply: (tx) => {
                updateReplayApproval(tx, expired);
              }
            });
            if (!expiredJournaled.ok) return expiredJournaled;
          }
        }
        return revoked;
      }
      const before = approvalRow as Record<string, JsonValue>;
      const after = replayApprovalRow(revoked.value);
      const journaled = await commit({
        event_type: "replay.approval_transition",
        entity_type: "replay_approval",
        entity_id: revoked.value.approval_id,
        operation: "transition",
        binding: revoked.value.version_binding,
        row_schema: "rsi.replay_approval_row/1",
        row: after,
        before,
        apply: (tx) => {
          updateReplayApproval(tx, revoked.value);
        }
      });
      if (!journaled.ok) return journaled;
      return ok(toReplayApprovalView(revoked.value));
    },
    "replay.reject": async (context) => {
      const parsed = parseReplayRejectRequest(context.params);
      if (!parsed.ok) return parsed;
      if (proof === undefined) {
        return fail(humanProofUnavailable("replay.reject"));
      }
      const planRow = oneRow<Row>(
        connection,
        "SELECT * FROM replay_plan WHERE replay_plan_id = :replay_plan_id",
        { replay_plan_id: parsed.value.replay_plan_id }
      );
      if (planRow === null) return fail(internalError("kernel.replay_plan_not_found"));
      const plan = replayPlanFromRow(planRow);
      if (plan === null) return fail(internalError("kernel.replay_plan_row_corrupt"));
      const approvalRows = allRows<Row>(
        connection,
        "SELECT * FROM replay_approval WHERE replay_plan_id = :replay_plan_id",
        { replay_plan_id: plan.replay_plan_id }
      );
      const approvals: ReplayApproval[] = [];
      for (const row of approvalRows) {
        const approval = replayApprovalFromRow(row);
        if (approval === null) return fail(internalError("kernel.replay_approval_row_corrupt"));
        approvals.push(approval);
      }
      const activeExecution = oneRow<Row>(
        connection,
        "SELECT 1 AS present FROM replay_execution WHERE replay_plan_id = :replay_plan_id AND state IN ('authorized','running') LIMIT 1",
        { replay_plan_id: plan.replay_plan_id }
      );
      const unknownExecution = oneRow<Row>(
        connection,
        "SELECT 1 AS present FROM replay_execution WHERE replay_plan_id = :replay_plan_id AND state = 'unknown' AND reconcile_required = 1 LIMIT 1",
        { replay_plan_id: plan.replay_plan_id }
      );
      const subjectHash = computeReplayRejectSubjectHash({
        replay_plan_id: plan.replay_plan_id,
        plan_hash: parsed.value.expected_plan_hash,
        reason: parsed.value.reason
      });
      const verdict = await proof.verifyControlPlane({
        attestation: parsed.value.human_attestation as unknown as import("@evoplug/ledger").HumanAttestation,
        subject_hash: subjectHash,
        purpose: "replay_reject"
      });
      if (verdict !== "verified") {
        return fail(replayAttestationUnverifiedError(plan.replay_plan_id));
      }
      const rejected = rejectReplayPlan(
        plan,
        approvals,
        parsed.value.expected_plan_hash,
        now(),
        activeExecution !== null,
        unknownExecution !== null
      );
      if (!rejected.ok) return rejected;
      const before = planRow as Record<string, JsonValue>;
      const after = replayPlanRow(rejected.value.plan, asNumber(planRow, "created_at"));
      // DD-FND-096.2 step 3: every approval revocation frame precedes the
      // plan transition frame, and all of them land in one short SQLite
      // transaction. A partial journal prefix is completed by recovery.
      const revokedApprovals = rejected.value.approvals;
      const approvalRowsById = new Map<string, Record<string, JsonValue>>();
      for (const row of approvalRows) {
        approvalRowsById.set(String(row["approval_id"]), row as Record<string, JsonValue>);
      }
      const journaled = await commitBatch([
        ...revokedApprovals.map((approval) => ({
          event_type: "replay.approval_transition",
          entity_type: "replay_approval",
          entity_id: approval.approval_id,
          operation: "transition" as const,
          binding: approval.version_binding,
          row_schema: "rsi.replay_approval_row/1",
          row: replayApprovalRow(approval),
          before: approvalRowsById.get(approval.approval_id) ?? null,
          apply: (tx: Tx) => {
            updateReplayApproval(tx, approval);
          }
        })),
        {
          event_type: "replay.plan_transition",
          entity_type: "replay_plan",
          entity_id: rejected.value.plan.replay_plan_id,
          operation: "transition" as const,
          binding: rejected.value.plan.version_binding,
          row_schema: "rsi.replay_plan_row/1",
          row: after,
          before,
          apply: (tx: Tx) => {
            tx.prepare(
              `UPDATE replay_plan SET state = 'rejected', row_version = :row_version
                WHERE replay_plan_id = :replay_plan_id AND row_version = :before_row_version`,
            ).run({
              replay_plan_id: rejected.value.plan.replay_plan_id,
              row_version: rejected.value.plan.row_version,
              before_row_version: plan.row_version
            });
          }
        }
      ]);
      if (!journaled.ok) return journaled;
      return ok({
        plan: rejected.value.plan,
        revoked_approval_ids: revokedApprovals.map((approval) => approval.approval_id)
      });
    },
    "replay.execute":
      replayExecuteHandler ?? unavailable<"replay.execute">("kernel.replay_executor_unavailable"),
    "replay.reconcile": async (context) => {
      const parsed = parseReplayReconcileRequest(context.params);
      if (!parsed.ok) return parsed;
      if (proof === undefined) {
        return fail(humanProofUnavailable("replay.reconcile"));
      }
      const executionRow = oneRow<Row>(
        connection,
        "SELECT * FROM replay_execution WHERE execution_id = :execution_id",
        { execution_id: parsed.value.execution_id }
      );
      if (executionRow === null) return fail(internalError("kernel.replay_execution_not_found"));
      const execution = replayExecutionFromRow(executionRow);
      const planRow = oneRow<Row>(
        connection,
        "SELECT * FROM replay_plan WHERE replay_plan_id = :replay_plan_id",
        { replay_plan_id: execution.replay_plan_id }
      );
      const executionPlan = planRow === null ? null : replayPlanFromRow(planRow);
      const subjectHash = computeReplayReconcileSubjectHash({
        execution_id: parsed.value.execution_id,
        fencing_token: parsed.value.fencing_token,
        evidence_ref: parsed.value.evidence_ref,
        reason: parsed.value.reason
      });
      const verdict = await proof.verifyControlPlane({
        attestation: parsed.value.human_attestation as unknown as import("@evoplug/ledger").HumanAttestation,
        subject_hash: subjectHash,
        purpose: "replay_reconcile"
      });
      if (verdict !== "verified") {
        return fail(replayAttestationUnverifiedError(execution.replay_plan_id));
      }
      const evidenceRef = parseSourceRef(parsed.value.evidence_ref);
      if (!evidenceRef.ok) return evidenceRef;
      const verified = options.blob_store.verify(evidenceRef.value.locator as Hash);
      const reconciled = reconcileReplayExecution({
        execution,
        fencing_token: parsed.value.fencing_token,
        evidence_ref: parsed.value.evidence_ref,
        reason: parsed.value.reason,
        now_ms: now(),
        evidence_retrievable: verified.ok && verified.value.present && verified.value.hash_matches,
        expected_row_version: execution.row_version
      });
      if (!reconciled.ok) return reconciled;
      const before = executionRow as Record<string, JsonValue>;
      const after = replayExecutionRow(reconciled.value);
      const journaled = await commit({
        event_type: "replay.execution_transition",
        entity_type: "replay_execution",
        entity_id: reconciled.value.execution_id,
        operation: "transition",
        binding: executionPlan?.version_binding ?? null,
        row_schema: "rsi.replay_execution_row/1",
        row: after,
        before,
        apply: (tx) => {
          tx.prepare(
            `UPDATE replay_execution SET
               reconcile_required = :reconcile_required, reconciled_at = :reconciled_at,
               reconcile_evidence_ref = :reconcile_evidence_ref, row_version = :row_version
             WHERE execution_id = :execution_id`
          ).run(asSqlParams(after));
        }
      });
      if (!journaled.ok) return journaled;
      return ok(reconciled.value);
    },
    "replay.result": async (context) => {
      const record = requireRecord(context.params, "params");
      if (!record.ok) return record;
      const executionId = record.value["execution_id"];
      if (typeof executionId !== "string" || !isId(executionId, "rex")) {
        return fail(fieldError("execution_id", "rex_id"));
      }
      const row = oneRow<Row>(
        connection,
        "SELECT * FROM replay_execution WHERE execution_id = :execution_id",
        { execution_id: executionId }
      );
      if (row === null) return fail(internalError("kernel.replay_execution_not_found"));
      return ok(replayExecutionFromRow(row));
    }
  };

  // The gateway is the only outbound entry point. Without an injected
  // transport it fails closed instead of falling back to a direct socket.
  (services as unknown as Record<string, unknown>)["egress.gateway"] = async (
    context: { readonly params: unknown }
  ) => {
    const params = context.params;
    if (!isRecord(params) || !isRecord(params["request"])) {
      return fail(fieldError("request", "must_be_object"));
    }
    if (options.egress_transport === undefined) {
      return fail(internalError("kernel.egress_transport_unavailable"));
    }
    const policyRow = readActiveEgressPolicy(connection);
    if (policyRow === null) {
      return fail(egressPolicyStaleError(config.egress_policy_version));
    }
    const policyJson = parseJson(policyRow.canonical_json);
    if (policyJson === null) {
      return fail(internalError("kernel.egress_policy_corrupt"));
    }
    const policy = parseEgressPolicy(policyJson);
    if (!policy.ok) return policy;
    const gateway = createEgressGateway({
      policy: policy.value,
      transport: options.egress_transport,
      now_ms: now,
      max_response_bytes: options.egress_max_response_bytes ?? 1_048_576
    });
    return gateway.send({
      request: params["request"] as unknown as EgressRequestInput,
      ...(params["source_status"] instanceof Map
        ? {
            source_status: params["source_status"] as ReadonlyMap<
              SourceRef,
              EgressSourceStatus
            >
          }
        : {}),
      ...(typeof params["require_single_approval"] === "boolean"
        ? { require_single_approval: params["require_single_approval"] }
        : {})
    });
  };

  // `delivery.receipt` is an event payload (`rsi.event_draft/1` with
  // `payload.kind="delivery.receipt"`), so the receipt path shares the single
  // event-ingest writer gate instead of opening a second ledger.
  (services as unknown as Record<string, unknown>)["delivery.receipt"] =
    services["event.ingest"];

  // `host.runtime.upload` re-enters the same (already wrapped) `event.ingest`
  // handler the IPC dispatcher uses. The indirection reads the property at
  // call time so a post-composition online-pipeline wrapper is honoured.
  const hostRuntimeClientId = newId("adp");
  const hostRuntimeIngest = async (
    draft: EventDraft
  ): Promise<Result<IngestReceipt, ErrorEnvelope>> => {
    const handler = services["event.ingest"];
    if (handler === undefined) {
      return fail(internalError("kernel.host_runtime_ingest_unavailable"));
    }
    return handler({
      request_id: newId("ipc"),
      method: "event.ingest",
      params: { draft },
      client_id: hostRuntimeClientId,
      connection_id: "kernel:host_runtime",
      client_kind: "worker",
      remaining_ms: 600_000,
      signal: new AbortController().signal
    });
  };
  const hostRuntime = createHostRuntimeServices({
    connection,
    blob_store: options.blob_store,
    source_refs: sourceRefs,
    session_scope: createSessionScopeReadPort({ connection, now }),
    adapters: options.host_runtime_adapters ?? { resolve: (): null => null },
    installation_config_allowed: (registration_hash, config_hash) =>
      hostInstallationAllows(options.home, registration_hash, config_hash),
    ingest: hostRuntimeIngest,
    ...(options.host_runtime_call_resolver === undefined
      ? {}
      : { call_resolver: options.host_runtime_call_resolver }),
    ...(options.host_runtime_probe_lifecycle === undefined
      ? {}
      : { lifecycle: options.host_runtime_probe_lifecycle }),
    ...(options.host_runtime_upload_committed === undefined
      ? {}
      : { human_attestation_upload: options.host_runtime_upload_committed }),
    ...(options.host_runtime_upload_diagnostic === undefined
      ? {}
      : { upload_diagnostic: options.host_runtime_upload_diagnostic }),
    now,
    ...(options.host_runtime_limits === undefined ? {} : { limits: options.host_runtime_limits })
  });
  Object.assign(services, hostRuntime);

  let disposed: Promise<void> | null = null;
  function dispose(): Promise<void> {
    disposed ??= (async () => {
      // Appendix P: stop scheduling new batches before draining the ones that
      // already run, so dispose observes a fixed amount of work.
      await feedbackRecoveryWorker?.stop();
      // Wait for post-commit work first: its feedback hook feeds the same
      // intake queue, and the recovery scan (when enabled) is already a queue
      // unit, so the intake drain below observes it as well.
      await postCommit?.drain();
      await feedbackIntake?.drain();
      if (journalResources?.owned === true) journalResources.writer.close();
    })();
    return disposed;
  }

  const runtime: KernelServiceRuntimePorts = {
    decision: decisionDelivery.decision,
    delivery: decisionDelivery.delivery,
    feedback_intake: feedbackIntake,
    outcome_intake: outcomeIntake,
    post_commit: postCommit,
    feedback_recovery: feedbackRecovery,
    feedback_recovery_worker: feedbackRecoveryWorker,
    dispose
  };
  return Object.assign(services, { runtime }) as KernelServices;
}

/* ------------------------------------------------------------------ */
/* Budget helpers                                                     */
/* ------------------------------------------------------------------ */

function loadBudgetPolicy(connection: SqliteConnection): Result<import("@evoplug/budget").BudgetPolicy, ErrorEnvelope> {
  const row = readActiveBudgetPolicy(connection);
  if (row === null) {
    return fail(budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_policy_read", details: { kind: "none" } }));
  }
  const json = parseJson(row.canonical_json);
  if (json === null) {
    return fail(budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_policy_read", details: { kind: "none" } }));
  }
  const parsed = parseBudgetPolicy(json);
  if (!parsed.ok) return parsed;
  if (budgetPolicyContentHash(parsed.value) !== row.content_hash) {
    return fail(budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_policy_read", details: { kind: "none" } }));
  }
  return parsed;
}

function asTx(connection: SqliteConnection): Tx {
  return {
    prepare: ((sql: string) => connection.prepare(sql)) as unknown as Tx["prepare"],
    exec: (sql: string) => connection.exec(sql)
  };
}

function planReservationRowUpdate(reservation: BudgetReservation, before: Row): Record<string, JsonValue> {
  const row = { ...(before as Record<string, JsonValue>) };
  row["state"] = reservation.state;
  row["attempt_allowance"] = reservation.attempts_remaining;
  row["input_token_allowance"] = reservation.input_tokens_remaining;
  row["output_token_allowance"] = reservation.output_tokens_remaining;
  row["cost_allowance_micros"] = reservation.cost_micros_remaining;
  row["cost_status"] = reservation.cost_status;
  return row;
}

function updateReservationRow(tx: Tx, reservation: BudgetReservation): void {
  tx.prepare(
    `UPDATE budget_reservation SET
       state = :state, attempt_allowance = :attempt_allowance,
       input_token_allowance = :input_token_allowance,
       output_token_allowance = :output_token_allowance,
       cost_allowance_micros = :cost_allowance_micros, cost_status = :cost_status
     WHERE reservation_id = :reservation_id`
  ).run({
    state: reservation.state,
    attempt_allowance: reservation.attempts_remaining,
    input_token_allowance: reservation.input_tokens_remaining,
    output_token_allowance: reservation.output_tokens_remaining,
    cost_allowance_micros: reservation.cost_micros_remaining,
    cost_status: reservation.cost_status,
    reservation_id: reservation.reservation_id
  });
}

function insertAllowanceCharge(tx: Tx, charge: import("@evoplug/budget").AllowanceCharge): void {
  tx.prepare(
    `INSERT INTO allowance_charge (
       charge_id, charge_key, reservation_id, kind, amount, non_refundable, reason, charged_at
     ) VALUES (
       :charge_id, :charge_key, :reservation_id, :kind, :amount, :non_refundable, :reason, :charged_at
     )`
  ).run({
    charge_id: charge.charge_id,
    charge_key: charge.charge_key,
    reservation_id: charge.reservation_id,
    kind: charge.kind,
    amount: charge.amount,
    non_refundable: charge.non_refundable ? 1 : 0,
    reason: charge.reason,
    charged_at: charge.charged_at
  });
}

function insertProviderUsage(tx: Tx, reservationId: Id<"resv">, usage: ProviderUsage): void {
  tx.prepare(
    `INSERT INTO provider_usage (
       usage_id, reservation_id, usage_key, attempt_ref, provider_request_id,
       input_tokens, output_tokens, cost_micros, cost_status, source, receipt_ref, recorded_at
     ) VALUES (
       :usage_id, :reservation_id, :usage_key, :attempt_ref, :provider_request_id,
       :input_tokens, :output_tokens, :cost_micros, :cost_status, :source, :receipt_ref, :recorded_at
     )`
  ).run({
    usage_id: newId("puse", usage.recorded_at),
    reservation_id: reservationId,
    usage_key: usage.usage_key,
    attempt_ref: usage.attempt_ref,
    provider_request_id: usage.provider_request_id,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_micros: usage.cost_micros,
    cost_status: usage.cost_status,
    source: usage.source,
    receipt_ref: usage.receipt_ref,
    recorded_at: usage.recorded_at
  });
}

/* ------------------------------------------------------------------ */
/* Egress helpers                                                     */
/* ------------------------------------------------------------------ */

function sourceStatus(
  connection: SqliteConnection,
  blobStore: BlobStore,
  ref: SourceRef,
  binding: VersionBinding
): EgressSourceStatus {
  const parsed = parseSourceRef(ref);
  if (!parsed.ok) {
    return { retrievable: false, task_id: binding.task_id, branch_id: binding.branch_id };
  }
  const hash = parsed.value.locator as Hash;
  const verified = blobStore.verify(hash);
  const retrievable = verified.ok && verified.value.present && verified.value.hash_matches;
  const owner = oneRow<Row>(
    connection,
    `SELECT e.task_id, e.branch_id
       FROM blob_ref br
       JOIN event_log e ON br.owner_type = 'event' AND e.event_id = br.owner_id
      WHERE br.blob_hash = :blob_hash
      LIMIT 1`,
    { blob_hash: hash }
  );
  return {
    retrievable,
    task_id: (owner === null ? "" : asString(owner, "task_id")) as Id<"task">,
    branch_id: (owner === null ? "" : asString(owner, "branch_id")) as Id<"br">
  };
}

function activeEgressApproval(
  connection: SqliteConnection,
  requestHash: Hash,
  at: number
): EgressApproval | null {
  const row = oneRow<Row>(
    connection,
    `SELECT * FROM egress_approval
      WHERE request_hash = :request_hash AND state = 'active' AND expires_at > :at
      ORDER BY created_at DESC LIMIT 1`,
    { request_hash: requestHash, at }
  );
  if (row === null) return null;
  const attestation = parseJson(asNullableString(row, "human_attestation_json"));
  const binding = parseJson(asNullableString(row, "version_binding_json"));
  const sources = parseJson(asNullableString(row, "sources_json"));
  if (!isRecord(attestation) || !isRecord(binding) || !Array.isArray(sources)) {
    return null;
  }
  return {
    approval_id: asString(row, "approval_id") as Id<"egr">,
    policy_version: asString(row, "policy_version"),
    approved_by: "human",
    human_attestation: attestation as unknown as EgressApproval["human_attestation"],
    attestation_subject_hash: asString(row, "attestation_subject_hash") as Hash,
    request_hash: asString(row, "request_hash") as Hash,
    approval_hash: asString(row, "approval_hash") as Hash,
    purpose: asString(row, "purpose") as EgressApproval["purpose"],
    version_binding: binding as unknown as VersionBinding,
    endpoint: {
      scheme: "https",
      host: asString(row, "host"),
      port: asNumber(row, "port"),
      path: asString(row, "path")
    },
    model: asString(row, "model"),
    project_id: asString(row, "project_id"),
    sources: sources as unknown as EgressApproval["sources"],
    body_sha256: asString(row, "body_sha256") as Hash,
    byte_length: asNumber(row, "byte_length"),
    replay_plan_id: asNullableString(row, "replay_plan_id") as Id<"rpl"> | null,
    ttl_ms: asNumber(row, "ttl_ms"),
    state: asString(row, "state") as EgressApproval["state"],
    created_at: asNumber(row, "created_at"),
    expires_at: asNumber(row, "expires_at"),
    consumed_at: asNullableNumber(row, "consumed_at"),
    consumed_request_hash: asNullableString(row, "consumed_request_hash") as Hash | null,
    revoked_at: asNullableNumber(row, "revoked_at"),
    revoke_reason: asNullableString(row, "revoke_reason") as EgressApproval["revoke_reason"],
    row_version: asNumber(row, "row_version")
  };
}

/* ------------------------------------------------------------------ */
/* Replay helpers                                                     */
/* ------------------------------------------------------------------ */

function updateReplayApproval(tx: Tx, approval: ReplayApproval): void {
  tx.prepare(
    `UPDATE replay_approval SET
       state = :state, consumed_at = :consumed_at,
       consumed_execution_id = :consumed_execution_id, revoked_at = :revoked_at,
       revoke_reason = :revoke_reason, row_version = :row_version
     WHERE approval_id = :approval_id`
  ).run({
    state: approval.state,
    consumed_at: approval.consumed_at,
    consumed_execution_id: approval.consumed_execution_id,
    revoked_at: approval.revoked_at,
    revoke_reason: approval.revoke_reason,
    row_version: approval.row_version,
    approval_id: approval.approval_id
  });
}
