/**
 * Default online trigger admission (DD-TRG-003/004/005/006/007/009).
 *
 * The bootstrap composes this runner by default so a committed HOST event is
 * evaluated by the real trigger policy, capability, budget, pending and review
 * admission seams instead of being left inert until every downstream bundle is
 * injected. An admitted event continues into the real QP factory: the evidence
 * index is loaded for the same committed binding and issue discovery/plan run
 * with the real template registry.
 *
 * EVD, Jev, aggregation, decision record and delivery keep their explicit
 * dependency bundles in `createOnlinePipeline`. The bootstrap installs the
 * real local EVD composition (`default-evidence-composition.ts`); this module
 * never fabricates a service profile, a semantic backend or a verified signal.
 *
 * Fail-closed rules:
 *   - the normalization context is handed over explicitly by the ingest
 *     wrapper; it is never re-read from a deleted cache entry;
 *   - every fact read is either backed by a committed row or reported as a
 *     field-level `E_EVIDENCE_UNKNOWN`;
 *   - facts whose rule is not fixed by the DD stay unknown as soon as rows
 *     exist that could change the answer. The absence of such rows is a real
 *     observation and yields the defined negative value;
 *   - a plan whose persisted lifecycle is absent is resolved through the QP
 *     repository, never defaulted to `active`.
 */

import type {
  Clock,
  ErrorEnvelope,
  EventDraft,
  Hash,
  HostEventBinding,
  Id,
  Result,
  SourceRef,
  VersionBinding
} from "@evoplug/core";
import {
  canonicalJson,
  err,
  makeErrorEnvelope,
  newId,
  ok,
  parseSourceRef,
  toJsonValue
} from "@evoplug/core";
import type {
  CapabilityGateResult,
  PendingChange,
  ReviewEnqueueRequest,
  ReviewSchedulerPort,
  StableBoundaryEvidence,
  StateRowLiveCommitPort,
  TriggerDecision,
  TriggerEvent,
  TriggerOrigin,
  TriggerPolicy
} from "@evoplug/core/host";
import {
  admitTrigger,
  assessStableBoundary,
  buildCapabilityGate,
  capabilityGatePassed,
  decideAutomatic,
  detectRepeatedCorrection,
  detectReproducibleError,
  detectStableRecovery,
  filterAutoSignals,
  policyRefOf,
  stableBoundaryEligible,
  triggerPolicyHash,
  type CorrectionObservation,
  type FailureObservation,
  type RecoveryObservation,
  type VerifiedSignal
} from "@evoplug/core/host";
import {
  computeBoundaryKey,
  computeStableBoundaryDedupeKey,
  computeStableBoundarySegmentKey,
  computeReviewScopeKey,
  computeSignalDigest,
  computeTriggerDedupeKey
} from "@evoplug/review";
import type { BlobStore, JournalWriter, SqlRow, SqliteConnection } from "@evoplug/storage";
import type { ResolvedSource, SourceRefPort } from "@evoplug/core";
import { isKernelProbeNativeSession } from "./probe-session.js";

import type {
  IssueReadRepository,
  QuestionPlanRepository
} from "@evoplug/core/evidence";
import type { CapabilityPipelinePort, CommittedHostEvent, DecisionRecordPort, HostAdapterFacts, HostTriggerFacts, OnlineIssue, OnlinePipelineOutcome, OnlinePipelineStage, OnlinePlanState, OnlineQuestionPlan, QpPipelineDeps } from "./online-pipeline.js";
import type { DefaultDeliveryCreateEnqueuePort } from "./default-decision-delivery.js";
import type { DefaultEvidenceComposition } from "./default-evidence-composition.js";
import { createBudgetAvailabilityPort } from "./budget-availability-port.js";
import { createCapabilityPipelinePort } from "./capability-pipeline-port.js";
import { createDefaultQuestionPlanner } from "./default-question-planner.js";
import { loadTriggerPolicyForEvent } from "./trigger-policy-store.js";
import {
  effectiveReviewWatermark,
  maybeAdvanceSettledReview,
  markReviewPending,
  markSessionFlushed,
  readSessionReviewStateByTask,
  recordStableBoundary
} from "./session-review-state.js";

/** Facts the runtime normalizer observed in this process for one event. */
export interface NormalizedTriggerContext {
  readonly event_identity_key: string;
  readonly trigger_kind_candidates: readonly string[];
  readonly host_id: string;
  readonly host_version: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly implementation_hash: string;
  readonly stream_id: string;
  readonly source_seq?: number;
  readonly native_occurrence_id?: string;
  readonly retry_of?: string;
  readonly occurred_at?: number;
  readonly raw_event_ref: string;
  readonly identity_quality: "strong" | "weak" | "missing";
  readonly observed_at: number;
}

interface DefaultQpComposeInput {
  /** The committed binding that admission just used. */
  readonly binding: VersionBinding;
  /** The review job admitted for this event, when admission produced one. */
  readonly review_job_id: Id<"job"> | null;
  readonly signal?: AbortSignal;
}

/**
 * Builds the real QP dependency bundle plus the repositories the EVD adapters
 * need.
 *
 * The default bootstrap closes over the QP factory; the runner never invents a
 * planner, registry or progress window. A rejected load is returned unchanged
 * so `E_INDEX_PROGRESS_UNSUPPORTED` reaches the diagnostic with its precise
 * code. The repositories share the factory's single commit gate, so the plan
 * rows read by EVD are the rows QP just committed.
 */
type DefaultQpComposer = (
  input: DefaultQpComposeInput
) => Promise<Result<DefaultQpBundle, ErrorEnvelope>>;

interface DefaultQpBundle {
  readonly qp: QpPipelineDeps;
  readonly plans: QuestionPlanRepository;
  readonly issues: IssueReadRepository;
}

/** Runtime inputs the default QP composition reads from the kernel. */
interface DefaultQpRuntimeDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: Pick<BlobStore, "read" | "stat">;
  readonly source_refs?: SourceRefPort;
  readonly journal: JournalWriter;
  readonly journal_relative_path: string;
  readonly now: () => number;
}

/**
 * Builds the QP composer over the real factory.
 *
 * The composer is called lazily with the admitted binding. It forwards that
 * binding unchanged, so a load rejection belongs to the same committed scope
 * the review job was admitted for.
 */
export function createDefaultQpComposer(deps: DefaultQpRuntimeDeps): DefaultQpComposer {
  return async (input) => {
    const created = await createDefaultQuestionPlanner(
      {
        connection: deps.connection,
        blob_store: deps.blob_store,
        ...(deps.source_refs === undefined ? {} : { source_refs: deps.source_refs }),
        journal: deps.journal,
        journal_relative_path: deps.journal_relative_path,
        now: deps.now
      },
      { binding: input.binding },
      input.signal === undefined ? {} : { signal: input.signal }
    );
    if (!created.ok) return created;
    return ok({
      qp: created.value.qp,
      plans: created.value.plans,
      issues: created.value.issues
    });
  };
}

export interface DefaultOnlineCompositionDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: Pick<BlobStore, "read" | "stat" | "putSync">;
  readonly source_refs: SourceRefPort;
  readonly review: ReviewSchedulerPort;
  readonly commit: StateRowLiveCommitPort;
  readonly now: () => number;
  /**
   * Monotonic clock paired with `now`. Passed to the downstream EVD tail so
   * every `deadline_at_monotonic_ms` stays on one timeline; production passes
   * the same clock instance to the evidence composition root.
   */
  readonly clock?: Clock;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
  /**
   * Real QP composition. When absent, an admitted event's outcome stops after
   * the admission stages instead of claiming QP ran.
   */
  readonly qp?: DefaultQpComposer;
  /**
   * Real local EVD composition. When absent, a produced plan keeps the
   * explicit `downstream_unavailable` result instead of claiming the tail ran.
   */
  readonly downstream?: Pick<DefaultEvidenceComposition, "runDownstream">;
  /** The real `decision.record` port (same instance as the IPC handler). */
  readonly decision?: DecisionRecordPort;
  /** The real delivery create/enqueue ports (same instance as the IPC handler). */
  readonly delivery?: DefaultDeliveryCreateEnqueuePort;
  /** HOST progress producer; runs after admission and before QP reads. */
  readonly progress?: import("./online-pipeline.js").ProgressPipelinePort;
  /**
   * W2 stable-boundary producer. Absent leaves the boundary path off (the
   * default). When wired, a committed stable boundary records its baseline
   * checkpoint before admission decides, including on a skip or defer.
   */
  readonly progress_boundary?: import("./progress-producer.js").ProgressBoundaryPort;
  /**
   * Evaluates a fresh TaskOutcome at the session-end binding when the host
   * resumed with a newer input epoch but produced no new boundary outcome.
   * A no-op when the stored outcome already matches the binding.
   */
  readonly evaluate_outcome?: (
    binding: VersionBinding,
    boundary_event_id: Id<"ev">
  ) => Promise<Result<unknown, ErrorEnvelope>>;
}

export interface DefaultOnlineRunner {
  run(
    event: CommittedHostEvent,
    context: NormalizedTriggerContext | null,
    options?: { readonly signal?: AbortSignal }
  ): Promise<Result<OnlinePipelineOutcome, ErrorEnvelope>>;
  /**
   * Appendix Q.2: admit the one review for an ended session at its last stable
   * boundary. Lease expiry calls this after the runtime session is failed; a
   * session-end hook whose boundary is unstable calls it directly.
   */
  flushSessionEnd?(
    task_id: string,
    reason: "session_end" | "lease_expired"
  ): Promise<Result<OnlinePipelineOutcome, ErrorEnvelope>>;
}

const TRIGGER_KINDS: ReadonlySet<string> = new Set([
  "new_input",
  "tool_fact",
  "compaction",
  "task_boundary_candidate",
  "task_stable",
  "session_end",
  "user_review_request",
  "experience_trigger",
  "config_signal"
]);

const BOUNDARY_KINDS: ReadonlySet<string> = new Set([
  "task_boundary_candidate",
  "task_stable",
  "session_end"
]);

// DD-TRG-007: the active-state set is closed by the pending-entry CHECK
// constraints. Match the full trigger binding, not just task/branch/epoch, so
// a pending entry from another host, mode or config space cannot defer a
// trigger that has no pending work in its own scope.
const ACTIVE_PENDING_SQL = `
  SELECT pending_id, kind, pending_state, source_refs_json
    FROM pending_entry
   WHERE record_state = 'recorded'
     AND task_id = :task_id
     AND branch_id = :branch_id
     AND input_epoch = :input_epoch
     AND goal_version = :goal_version
     AND config_version = :config_version
     AND host_id = :host_id
     AND mode = :mode
     AND config_space = :config_space
     AND ((kind = 'delivery' AND pending_state IN ('pending','submitted_not_verified'))
       OR (kind = 'review_defer' AND pending_state = 'waiting')
       OR (kind = 'generation_resume' AND pending_state IN ('queued','resuming','blocked_no_backend')))
   ORDER BY created_at ASC, pending_id ASC`;

// DD-TRG-006/TC-HOST-032: an open review job blocks every further auto job for
// the same task, including a new boundary on another branch or input epoch.
// The live set is the explicit non-terminal union from the review_jobs CHECK.
const ACTIVE_JOB_SQL = `
  SELECT job_id FROM review_jobs
   WHERE task_id = :task_id
     AND state IN ('queued','blocked_no_backend','generating','proposed')
   LIMIT 1`;

function factsUnknown(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_EVIDENCE_UNKNOWN",
    category: "source",
    message_key: "error.evidence.unknown",
    stage: "trigger_facts",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function stringValue(row: SqlRow, key: string): string | null {
  const value = row[key as keyof SqlRow];
  return typeof value === "string" ? value : null;
}

function numberValue(row: SqlRow, key: string): number | null {
  const value = row[key as keyof SqlRow];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function bindingOf(event: CommittedHostEvent): VersionBinding {
  return event.binding;
}

function isRetrievable(source: ResolvedSource | undefined): boolean {
  return source !== undefined && source.retrievable;
}

function sourceRefFor(hash: Hash, length: number): SourceRef {
  return `blob://${hash}#bytes=0-${length}` as SourceRef;
}

function normalizeRef(value: string | null): SourceRef | null {
  if (value === null) return null;
  const parsed = parseSourceRef(value);
  return parsed.ok ? parsed.value.source_ref : null;
}

function adapterFacts(context: NormalizedTriggerContext): HostAdapterFacts {
  return {
    host_id: context.host_id as HostAdapterFacts["host_id"],
    host_version: context.host_version,
    adapter_id: context.adapter_id as Id<"adp">,
    adapter_version: context.adapter_version,
    implementation_hash: context.implementation_hash as Hash,
    stream_id: context.stream_id as Hash,
    event_identity_key: context.event_identity_key as Hash,
    ...(context.source_seq === undefined ? {} : { source_seq: context.source_seq }),
    ...(context.native_occurrence_id === undefined
      ? {}
      : { native_occurrence_id: context.native_occurrence_id }),
    ...(context.retry_of === undefined ? {} : { retry_of: context.retry_of }),
    ...(context.occurred_at === undefined ? {} : { occurred_at: context.occurred_at })
  };
}

/** DD-TRG-005 origin projection from the committed EventDraft. */
export function triggerOrigin(draft: EventDraft): TriggerOrigin {
  if (draft.trigger_lineage.axis === "internal_evaluator") {
    return {
      kind: "evaluator",
      evidence_kind: "session_registry",
      suppress_automatic: true
    };
  }
  if (draft.origin === "human" && draft.human_attestation !== undefined) {
    return {
      kind: "human",
      evidence_kind: "host_field",
      evidence_ref: draft.human_attestation.evidence_ref,
      suppress_automatic: false
    };
  }
  if (draft.origin === "host") {
    return {
      kind: "host_auto",
      evidence_kind: "host_field",
      suppress_automatic: false
    };
  }
  if (draft.origin === "evaluator") {
    return {
      kind: "evaluator",
      evidence_kind: "host_field",
      suppress_automatic: true
    };
  }
  if (draft.origin === "user" && draft.origin_basis === "host_typed_field") {
    // Appendix C.3: a host field that distinguishes a typed interactive input
    // is human provenance. It permits online Jev judgement; it never
    // authorises a managed write (that still needs host confirmation).
    return {
      kind: "human",
      evidence_kind: "host_field",
      suppress_automatic: false
    };
  }
  if (draft.origin === "user" && draft.origin_basis === "host_tui_session") {
    // Appendix L.2: judging the host process as an interactive TUI is weaker
    // than a typed field. It may count towards `repeated_correction`
    // (appendix C.2) but never authorises a write.
    return {
      kind: "human",
      evidence_kind: "input_source_label",
      suppress_automatic: false
    };
  }
  if (draft.origin === "user") {
    return {
      kind: "unknown",
      evidence_kind: "input_source_label",
      suppress_automatic: true
    };
  }
  return {
    kind: "unknown",
    evidence_kind: draft.origin_basis === "unavailable" ? "none" : "host_field",
    suppress_automatic: true
  };
}

function selectedTriggerKind(context: NormalizedTriggerContext): Result<string, ErrorEnvelope> {
  const candidates = context.trigger_kind_candidates;
  if (candidates.length !== 1) {
    return err(factsUnknown("HostTriggerFacts.trigger_kind", "candidate_selection_undefined"));
  }
  const kind = candidates[0];
  if (kind === undefined || !TRIGGER_KINDS.has(kind)) {
    return err(factsUnknown("HostTriggerFacts.trigger_kind", "candidate_invalid"));
  }
  return ok(kind);
}

function isBoundaryCandidate(context: NormalizedTriggerContext): boolean {
  return context.trigger_kind_candidates.some((kind) => BOUNDARY_KINDS.has(kind));
}

interface PendingRead {
  readonly state: StableBoundaryEvidence["pending_state"];
  readonly refs: readonly StableBoundaryEvidence["pending_work_refs"][number][];
  readonly unstable: readonly string[];
}

async function readPending(
  deps: DefaultOnlineCompositionDeps,
  binding: VersionBinding,
  event: CommittedHostEvent
): Promise<Result<PendingRead, ErrorEnvelope>> {
  const rows = deps.connection
    .prepare<SqlRow>(ACTIVE_PENDING_SQL)
    .all({
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version,
      host_id: event.draft.host_id,
      mode: event.draft.mode,
      config_space: event.draft.config_space
    });
  const refs: StableBoundaryEvidence["pending_work_refs"][number][] = [];
  for (const row of rows) {
    const pendingId = stringValue(row, "pending_id");
    const kind = stringValue(row, "kind");
    const state = stringValue(row, "pending_state");
    const refsJson = stringValue(row, "source_refs_json");
    if (pendingId === null || kind === null || state === null || refsJson === null) {
      return err(factsUnknown("HostTriggerFacts.boundary.pending_work_refs", "pending_row_invalid"));
    }
    const parsed = parseJson(refsJson);
    if (!Array.isArray(parsed)) {
      return err(factsUnknown("HostTriggerFacts.boundary.pending_work_refs", "pending_refs_invalid"));
    }
    const candidates: SourceRef[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") {
        return err(factsUnknown("HostTriggerFacts.boundary.pending_work_refs", "pending_ref_invalid"));
      }
      const normalized = normalizeRef(value);
      if (normalized === null) {
        return err(factsUnknown("HostTriggerFacts.boundary.pending_work_refs", "pending_ref_invalid"));
      }
      candidates.push(normalized);
    }
    const checked = await deps.source_refs.checkRetrievable(candidates);
    const evidence = candidates.find((ref) => isRetrievable(checked.get(ref)));
    if (evidence === undefined) {
      return err(factsUnknown("HostTriggerFacts.boundary.pending_work_refs", "pending_evidence_unretrievable"));
    }
    refs.push({
      pending_id: pendingId as Id<"pen">,
      kind: kind as StableBoundaryEvidence["pending_work_refs"][number]["kind"],
      state,
      evidence_ref: evidence
    });
  }
  if (refs.length > 0) {
    return ok({ state: "pending", refs, unstable: [] });
  }

  const outcome = deps.connection
    .prepare<SqlRow>(
      `SELECT pending_work_json, reason_code FROM task_outcome_current
        WHERE task_id = :task_id AND branch_id = :branch_id
        ORDER BY revision DESC LIMIT 1`
    )
    .get({ task_id: binding.task_id, branch_id: binding.branch_id });
  if (outcome === undefined) {
    // The pending registry has no active row for this scope. That is the
    // authoritative absence; task_outcome is not a second pending ledger.
    return ok({ state: "none", refs: [], unstable: [] });
  }
  const pendingText = stringValue(outcome, "pending_work_json");
  const reason = stringValue(outcome, "reason_code");
  if (pendingText === null || reason === null) {
    return err(factsUnknown("HostTriggerFacts.boundary.pending_state", "outcome_row_invalid"));
  }
  const pending = parseJson(pendingText);
  if (!Array.isArray(pending)) {
    return err(factsUnknown("HostTriggerFacts.boundary.pending_state", "outcome_pending_unreadable"));
  }
  if (pending.length > 0 || reason === "pending_work") {
    return err(factsUnknown("HostTriggerFacts.boundary.pending_work_refs", "outcome_pending_refs_missing"));
  }
  return ok({
    state: "none",
    refs: [],
    unstable: reason === "boundary_unstable" ? ["outcome_boundary_unstable"] : []
  });
}

/**
 * DD-TRG-004/006: the committed event's own content is the boundary evidence.
 * `source_event_ref` is the journal event range when the event has content and
 * the normalizer's raw blob ref otherwise; both are resolved before use.
 */
async function readEventSourceRef(
  deps: DefaultOnlineCompositionDeps,
  event: CommittedHostEvent,
  rawEventRef: SourceRef
): Promise<Result<SourceRef, ErrorEnvelope>> {
  const row = deps.connection
    .prepare<SqlRow>(
      "SELECT content_ref, content_bytes FROM event_log WHERE event_id = :event_id"
    )
    .get({ event_id: event.receipt.event_id });
  if (row === undefined) {
    return err(factsUnknown("HostTriggerFacts.source_event_ref", "event_log_missing"));
  }
  const contentRefText = stringValue(row, "content_ref");
  const contentBytes = numberValue(row, "content_bytes");
  if (contentRefText === null) {
    return ok(rawEventRef);
  }
  if (contentBytes === null) {
    return err(factsUnknown("HostTriggerFacts.source_event_ref", "content_bytes_missing"));
  }
  const sourceRef = `journal://${event.receipt.event_id}#bytes=0-${contentBytes}` as SourceRef;
  const contentRef = normalizeRef(contentRefText);
  if (contentRef === null) {
    return err(factsUnknown("HostTriggerFacts.source_event_ref", "content_ref_invalid"));
  }
  const checked = await deps.source_refs.checkRetrievable([contentRef, sourceRef]);
  if (!isRetrievable(checked.get(contentRef))) {
    return err(factsUnknown("HostTriggerFacts.source_event_ref", "content_ref_unretrievable"));
  }
  if (!isRetrievable(checked.get(sourceRef))) {
    return err(factsUnknown("HostTriggerFacts.source_event_ref", "unretrievable"));
  }
  return ok(sourceRef);
}

interface CorrectionObservationEnvelope {
  readonly schema_version: "rsi.correction_observation/1";
  readonly message_id: string;
  readonly issue_id: string;
  readonly requirement_ids: readonly string[];
  readonly user_correction: boolean;
  readonly independent: boolean;
  readonly verified_closed: boolean;
  /** Source origin of the correction; absent means an older `human` record. */
  readonly origin?: string;
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function correctionEnvelope(value: unknown): CorrectionObservationEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["schema_version"] !== "rsi.correction_observation/1" ||
    typeof record["message_id"] !== "string" ||
    typeof record["issue_id"] !== "string" ||
    !stringArray(record["requirement_ids"]) ||
    typeof record["user_correction"] !== "boolean" ||
    typeof record["independent"] !== "boolean" ||
    typeof record["verified_closed"] !== "boolean" ||
    (record["origin"] !== undefined && typeof record["origin"] !== "string")
  ) {
    return null;
  }
  return record as unknown as CorrectionObservationEnvelope;
}

async function readJsonSource(
  deps: DefaultOnlineCompositionDeps,
  value: string
): Promise<Record<string, unknown> | null> {
  const normalized = normalizeRef(value);
  if (normalized === null) return null;
  const resolved = await deps.source_refs.resolve(normalized);
  if (!resolved.ok || !resolved.value.retrievable || resolved.value.bytes === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(resolved.value.bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function verifiedFactRows(
  connection: SqliteConnection,
  binding: VersionBinding,
  after_watermark: number
): readonly SqlRow[] {
  return connection
    .prepare<SqlRow>(
      `SELECT sf.*, fv.event_id AS verification_event_id, fv.verifier_ref AS verification_verifier_ref,
              fv.verifier_id AS verification_verifier_id, fv.independent AS verification_independent,
              fv.effect AS verification_effect, fv.result AS verification_result,
              fv.status AS verification_status, fv.verified_at AS verification_verified_at
         FROM fact_verification fv
         JOIN state_fact sf ON sf.fact_id = fv.fact_id
        WHERE sf.task_id = :task_id AND sf.branch_id = :branch_id
          AND sf.input_epoch = :input_epoch AND sf.goal_version = :goal_version
          AND sf.config_version = :config_version AND sf.watermark <= :watermark
          AND sf.watermark > :after_watermark
          AND sf.stale = 0 AND fv.input_epoch = :input_epoch
          AND fv.goal_version = :goal_version AND fv.config_version = :config_version
          AND fv.watermark <= :watermark AND fv.status = 'valid'
        ORDER BY fv.verified_at, fv.event_id`
    )
    .all({
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version,
      watermark: binding.watermark,
      after_watermark
    });
}

export async function readDetectedSignals(
  deps: DefaultOnlineCompositionDeps,
  binding: VersionBinding,
  policy: TriggerPolicy,
  after_watermark = 0
): Promise<Result<readonly VerifiedSignal[], ErrorEnvelope>> {
  // Corrections accumulate across the successive user turns of one branch.
  // Scoping them to the boundary's single `input_epoch` would make two
  // corrections in two turns impossible to observe together.
  const clock = typeof deps.now === "function" ? deps.now : Date.now;
  const correctionSince = clock() - policy.review.signal_policy.repeated_correction.window_ms;
  // Appendix Q.2: only signals after the previous review snapshot watermark
  // can trigger the next session-end review. The feedback row's event carries
  // the branch watermark; `recorded_at` alone cannot express that cutoff.
  const corrections = deps.connection
    .prepare<SqlRow>(
      `SELECT f.feedback_id AS feedback_id, f.target_issue_id AS target_issue_id,
              f.quote_ref AS quote_ref, f.recorded_at AS recorded_at
         FROM feedback f
         JOIN event_log el ON el.event_id = f.source_event_id
        WHERE f.task_id = :task_id AND f.branch_id = :branch_id
          AND f.kind = 'correction' AND f.status = 'recorded'
          AND f.recorded_at >= :since
          AND el.watermark > :after_watermark
        ORDER BY f.recorded_at, f.feedback_id`
    )
    .all({
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      since: correctionSince,
      after_watermark
    });
  const correctionObservations: Array<CorrectionObservation & { origin?: string }> = [];
  for (const row of corrections) {
    const feedbackId = stringValue(row, "feedback_id");
    // A first-review correction has no issue target; group it under one
    // branch-local synthetic issue so two typed corrections still form the
    // `repeated_correction` signal.
    const targetIssueId = stringValue(row, "target_issue_id") ?? "issue:unbound";
    const quoteRef = stringValue(row, "quote_ref");
    const recordedAt = numberValue(row, "recorded_at");
    if (feedbackId === null || quoteRef === null || recordedAt === null) {
      return err(factsUnknown("HostTriggerFacts.signals", "correction_observation_binding_invalid"));
    }
    const envelope = correctionEnvelope(await readJsonSource(deps, quoteRef));
    if (
      envelope === null ||
      envelope.message_id !== feedbackId ||
      envelope.issue_id !== targetIssueId ||
      !envelope.user_correction
    ) {
      return err(factsUnknown("HostTriggerFacts.signals", "correction_observation_untyped"));
    }
    correctionObservations.push({
      ...envelope,
      origin: envelope.origin ?? "human",
      evidence_ref: quoteRef,
      observed_at: recordedAt
    });
  }

  const rows = verifiedFactRows(deps.connection, binding, after_watermark);
  const evidenceRefs = rows.map((row) => stringValue(row, "source_ref")).filter(
    (value): value is string => value !== null
  );
  if (evidenceRefs.length !== rows.length) {
    return err(factsUnknown("HostTriggerFacts.signals", "verification_source_ref_missing"));
  }
  if (evidenceRefs.length > 0) {
    const checked = await deps.source_refs.checkRetrievable(evidenceRefs.map((ref) => ref as SourceRef));
    if (evidenceRefs.some((ref) => !isRetrievable(checked.get(ref as SourceRef)))) {
      return err(factsUnknown("HostTriggerFacts.signals", "verification_source_ref_unretrievable"));
    }
  }
  const failures: FailureObservation[] = [];
  const recovery: RecoveryObservation[] = [];
  for (const row of rows) {
    const runId = stringValue(row, "verification_event_id");
    const verifier = stringValue(row, "verification_verifier_ref");
    const verifierId = stringValue(row, "verification_verifier_id");
    const failureCode = stringValue(row, "value");
    const subjectLineage = stringValue(row, "subject");
    const subjectHash = stringValue(row, "content_hash");
    const evidenceRef = stringValue(row, "source_ref");
    const observedAt = numberValue(row, "verification_verified_at");
    const independent = numberValue(row, "verification_independent");
    const result = stringValue(row, "verification_result");
    const effect = stringValue(row, "verification_effect");
    if (
      runId === null || verifier === null || verifierId === null || failureCode === null ||
      failureCode.length === 0 || subjectLineage === null || subjectHash === null ||
      evidenceRef === null || observedAt === null || independent === null ||
      (independent !== 0 && independent !== 1) || result === null || effect === null
    ) {
      return err(factsUnknown("HostTriggerFacts.signals", "verification_observation_invalid"));
    }
    const failed = result === "contradicted" || effect === "violates";
    if (failed) {
      failures.push({
        run_id: runId,
        verifier: verifierId || verifier,
        failure_code: failureCode,
        subject_hash: subjectHash,
        subject_lineage: subjectLineage,
        evidence_ref: evidenceRef,
        observed_at: observedAt,
        independent: independent === 1
      });
    }
    if (result === "contradicted" || result === "verified" || effect === "violates" || effect === "supports") {
      recovery.push({
        run_id: runId,
        verifier,
        outcome: failed ? "failed" : "passed",
        subject_hash: subjectHash,
        evidence_ref: evidenceRef,
        observed_at: observedAt
      });
    }
  }
  const originOf = new Map(correctionObservations.map((observation) => [observation.evidence_ref, observation.origin] as const));
  if (process.env["EVOPLUG_DEBUG_SIGNALS"] === "1") {
    process.stderr.write(`${JSON.stringify({
      message: "debug.signals",
      feedback_rows: corrections.length,
      observations: correctionObservations.length,
      origins: [...originOf.values()],
      detected_after: "pending"
    })}\n`);
  }
  const detected = [
    detectRepeatedCorrection(correctionObservations, policy.review.signal_policy.repeated_correction),
    detectReproducibleError(failures, policy.review.signal_policy.reproducible_error),
    detectStableRecovery(recovery, policy.review.signal_policy.stable_recovery)
  ].filter((signal): signal is VerifiedSignal => signal !== null)
    // Design §6.1: unknown-origin corrections count towards the signal, but a
    // repeated_correction made only of them is not enough to trigger a review.
    .filter((signal) =>
      signal.type !== "repeated_correction" ||
      signal.evidence_refs.some((ref) => {
        const origin = originOf.get(ref as string);
        return origin === "human" || origin === "user" || origin === "host_verified";
      })
    );
  // Appendix L.5: no bypass. The earlier empty result came from the detector,
  // not from this predicate: a first-review correction has no issue target and
  // no requirement ids, so the shared-requirement anchor never matched. The
  // detector now anchors on the synthetic `issue:unbound` id (core
  // `detectRepeatedCorrection` bootstrap) and the rows carry that same id.
  const filtered = filterAutoSignals(detected, policy.review.auto.min_signals);
  if (process.env["EVOPLUG_DEBUG_SIGNALS"] === "1") {
    process.stderr.write(`${JSON.stringify({
      message: "debug.signals.filtered",
      detected: detected.map((signal) => signal.type),
      strengths: detected.map((signal) => signal.strength),
      min_signals: [...policy.review.auto.min_signals],
      filtered: filtered.map((signal) => signal.type),
      corrections: correctionObservations.map((observation) => ({
        issue_id: observation.issue_id,
        requirements: observation.requirement_ids.length,
        origin: observation.origin
      }))
    })}\n`);
  }
  return ok(filtered);
}

/**
 * DD-TRG-006/TC-HOST-032 active-job read. An open job for the task blocks a
 * new auto job even when the new event is on a different branch or input
 * epoch; terminal states (`stale`, `done`, `failed`, `cancelled`) never do.
 */
export function defaultOnlineJobLive(
  connection: SqliteConnection,
  task_id: string
): boolean {
  const row = connection
    .prepare<SqlRow>(ACTIVE_JOB_SQL)
    .get({ task_id });
  return row !== undefined;
}

/**
 * Automatic-review quota counts every auto job admitted in the half-open
 * window [now - 24h, now), regardless of terminal state. A terminal job is
 * still a consumed admission; excluding it would let retries bypass the
 * policy. The schema makes created_at an integer, so malformed timestamps
 * cannot be silently interpreted here.
 */
function countAutoJobsInWindow(
  connection: SqliteConnection,
  taskId: string,
  now: number
): number {
  const row = connection
    .prepare<SqlRow>(
      `SELECT COUNT(*) AS count
         FROM review_jobs
        WHERE task_id = :task_id
          AND review_kind = 'auto'
          AND created_at >= :window_start
          AND created_at < :window_end`
    )
    .get({ task_id: taskId, window_start: now - 86_400_000, window_end: now });
  const value = row === undefined ? null : numberValue(row, "count");
  return value === null || !Number.isSafeInteger(value) || value < 0 ? -1 : value;
}

/**
 * Appendix J.4 dedupe identity for one input segment. Two stable boundaries in
 * the same (task, branch, input epoch, goal, config) segment share this key
 * regardless of which host hook reported them or which receipt watermark that
 * event carries, so exactly one review job is enqueued.
 */
export function stableBoundarySegmentKey(scope: {
  readonly task_id: string;
  readonly branch_id: string;
  readonly input_epoch: number;
  readonly goal_version: string;
  readonly config_version: string;
}): Hash {
  return computeStableBoundarySegmentKey(scope as never);
}

/**
 * Boundary kinds a host reports without async/queue facts. Pi, Claude Code and
 * Codex commit these as `host.unclassified`; the runtime stream's pending-tool
 * pairing is the only proof the design requires (appendix C.1). OpenCode has
 * no boundary hook at all and synthesizes `session.turn.completed` when the
 * next typed prompt arrives (appendix O.2); the same proof applies.
 */
const UNKNOWN_FACTS_BOUNDARY_EVENTS: readonly string[] = Object.freeze([
  "agent_settled",
  "session_shutdown",
  "agent_end",
  "session_stop",
  // Claude Code and Codex emit camel-case names for the same boundary.
  "Stop",
  "SessionEnd"
]);

export interface BoundaryPromotion {
  /** The event may be promoted to `task_stable` / `session_end`. */
  readonly stable_kind: boolean;
  /** Boundary facts exist and are trusted (no async/queue report needed). */
  readonly canonical_boundary: boolean;
  /** The kernel, not an adapter capability row, proved this boundary. */
  readonly kernel_proved: boolean;
}

/**
 * Pure promotion rule for one committed boundary candidate. Exported so the
 * OpenCode synthesized-turn case is testable without a whole kernel home.
 */
export function boundaryPromotion(input: {
  readonly host_id: string;
  readonly host_event: string;
  readonly payload: Parameters<typeof stableBoundaryEligible>[0];
  readonly trigger_kind: string;
  readonly pending_state: "none" | "pending" | "unknown";
}): BoundaryPromotion {
  const synthesizedTurnBoundary =
    input.host_id === "opencode" && input.host_event === "session.turn.completed";
  // `host.boundary` with unknown retry/async/queue facts is committed as
  // `host.unclassified` (core event mapping). For the hosts in the list above
  // that shape is still canonical; OpenCode's synthesized turn boundary is the
  // same case and must not lose its canonical status in that mapping.
  const unknownFactsBoundary =
    input.payload.kind === "host.unclassified" &&
    (UNKNOWN_FACTS_BOUNDARY_EVENTS.includes(input.host_event) || synthesizedTurnBoundary);
  const canonical =
    stableBoundaryEligible(input.payload) || unknownFactsBoundary;
  return {
    stable_kind:
      input.trigger_kind === "task_stable" ||
      input.trigger_kind === "session_end" ||
      (input.trigger_kind === "task_boundary_candidate" &&
        canonical &&
        (unknownFactsBoundary || synthesizedTurnBoundary) &&
        input.pending_state === "none"),
    canonical_boundary: canonical,
    kernel_proved: unknownFactsBoundary || synthesizedTurnBoundary
  };
}

async function readFacts(
  deps: DefaultOnlineCompositionDeps,
  event: CommittedHostEvent,
  context: NormalizedTriggerContext,
  policy: TriggerPolicy,
  policySnapshotRef: SourceRef,
  triggerKind: string
): Promise<Result<HostTriggerFacts, ErrorEnvelope>> {
  const binding = bindingOf(event);
  if (context.host_id !== event.draft.host_id) {
    return err(factsUnknown("HostTriggerFacts.adapter.host_id", "normalization_context_binding_mismatch"));
  }
  const rawEventRef = normalizeRef(context.raw_event_ref);
  if (rawEventRef === null) {
    return err(factsUnknown("HostTriggerFacts.raw_event_ref", "invalid_source_ref"));
  }
  const rawCheck = await deps.source_refs.checkRetrievable([rawEventRef]);
  if (!isRetrievable(rawCheck.get(rawEventRef))) {
    return err(factsUnknown("HostTriggerFacts.raw_event_ref", "unretrievable"));
  }

  const pending = await readPending(deps, binding, event);
  if (!pending.ok) return pending;

  const sourceResult = await readEventSourceRef(deps, event, rawEventRef);
  if (!sourceResult.ok) return sourceResult;
  const sourceRef = sourceResult.value;

  const detectedSignals = await readDetectedSignals(
    deps,
    binding,
    policy,
    effectiveReviewWatermark(deps.connection, binding.task_id)
  );
  if (!detectedSignals.ok) return detectedSignals;
  const signals: HostTriggerFacts["signals"] = [...detectedSignals.value];

  // DD-TRG-004/006: a committed `task_stable` (or `session_end`) event is the
  // boundary; `stable_watermark` is its receipt watermark and the boundary
  // goal version is the committed draft's binding. A plain candidate is
  // persisted but never promoted to stable here.
  // Pi cannot report async-work/queue facts, so its boundary payloads are
  // committed as `host.unclassified`. The runtime stream itself proves whether
  // a tool result is outstanding, and the design only requires "no pending
  // tool" for a boundary. Treat those host hooks as canonical after the
  // pending check below, instead of making the whole loop unreachable.
  const promotion = boundaryPromotion({
    host_id: event.draft.host_id,
    host_event: event.draft.host_event,
    payload: event.draft.payload,
    trigger_kind: triggerKind,
    pending_state: pending.value.state
  });
  const stableKind = promotion.stable_kind;
  const hostClaimedPending =
    event.draft.payload.kind === "host.boundary" &&
    event.draft.payload.pending_work_claimed;
  if (hostClaimedPending && pending.value.refs.length === 0) {
    // A host claim without an active pending row has no retrievable preimage;
    // do not mint a pending state from the flag alone.
    return err(
      factsUnknown(
        "HostTriggerFacts.boundary.pending_work_refs",
        "host_pending_claim_without_refs"
      )
    );
  }
  const pendingState = hostClaimedPending ? "pending" : pending.value.state;
  const boundary = assessStableBoundary({
    candidate: true,
    boundary_kind: triggerKind === "session_end" ? "exit" : "host_stable_event",
    stable_event_ids: stableKind ? [event.receipt.event_id] : [],
    source_event_ids: stableKind ? [event.receipt.event_id] : [],
    stable_watermark: event.receipt.watermark,
    goal_version: binding.goal_version,
    pending_state: pendingState,
    pending_work_refs: [...pending.value.refs],
    watermark_gap: false,
    goal_changed: false
  });
  const unstable = [...boundary.unstable_reasons, ...pending.value.unstable];
  if (!stableKind) unstable.push("boundary_not_stable");
  if (!promotion.canonical_boundary) unstable.push("boundary_facts_unknown");
  if (hostClaimedPending) unstable.push("host_pending_work_claimed");
  const withUnstable: StableBoundaryEvidence = {
    ...boundary,
    stable:
      boundary.stable &&
      stableKind &&
      promotion.canonical_boundary &&
      !hostClaimedPending &&
      pending.value.unstable.length === 0,
    unstable_reasons: sortedUnique(unstable)
  };
  const stableEvidenceRef = withUnstable.stable ? sourceRef : undefined;

  const signalDigest = computeSignalDigest(signals);
  // Appendix J.4 applies to stable boundaries only. A candidate that did not
  // settle keeps its own boundary identity so it cannot mask a later stable
  // boundary in the same input segment.
  // Appendix J.4: the boundary keeps its exact identity for the snapshot, but
  // the durable trigger identity is the input segment when the boundary is
  // stable, so all host hooks in that segment share one review job.
  const boundaryKey = computeBoundaryKey({
    scope: {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version
    },
    boundary_kind: withUnstable.candidate ? withUnstable.boundary_kind : "none",
    stable_watermark: withUnstable.stable_watermark,
    stable_event_ids: withUnstable.stable_event_ids
  });
  const triggerDedupeKey = withUnstable.stable
    ? computeStableBoundaryDedupeKey({
        task_id: binding.task_id,
        branch_id: binding.branch_id,
        input_epoch: binding.input_epoch,
        goal_version: binding.goal_version,
        config_version: binding.config_version
      } as never)
    : computeTriggerDedupeKey({
        boundary_key: boundaryKey,
        signal_digest: signalDigest,
        review_kind: "auto"
      });
  const reviewScopeKey = computeReviewScopeKey({
    scope: {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version
    },
    stable_watermark: withUnstable.stable_watermark,
    stable_event_ids: withUnstable.stable_event_ids,
    pending_state: withUnstable.pending_state,
    pending_work_refs: withUnstable.pending_work_refs,
    review_kind: "auto"
  });

  // Trigger identity is durable. A terminal job consumes that identity forever;
  // an active job is reported through the live-job gate; an orphaned or
  // otherwise ambiguous row stays unknown instead of being retried blindly.
  let replayDuplicate = false;
  let priorJobLive = false;
  const prior = deps.connection
    .prepare<SqlRow>(
      `SELECT te.decision, rj.state AS review_job_state
         FROM trigger_event te
         LEFT JOIN review_jobs rj ON rj.trigger_dedupe_key = te.trigger_dedupe_key
        WHERE te.trigger_dedupe_key = :key
        LIMIT 1`
    )
    .get({ key: triggerDedupeKey });
  if (prior !== undefined) {
    const decision = stringValue(prior, "decision");
    const jobState = stringValue(prior, "review_job_state");
    const terminal = new Set(["stale", "done", "failed", "cancelled"]);
    const active = new Set(["queued", "blocked_no_backend", "generating", "proposed"]);
    if (jobState !== null && terminal.has(jobState)) {
      replayDuplicate = true;
    } else if (jobState !== null && active.has(jobState)) {
      priorJobLive = true;
    } else if (jobState === null && (decision === "skip" || decision === "suppress" || decision === "defer")) {
      replayDuplicate = true;
    } else {
      return err(factsUnknown("HostTriggerFacts.replay_duplicate", "prior_trigger_state_ambiguous"));
    }
  }

  const autoQuotaCount = countAutoJobsInWindow(deps.connection, binding.task_id, deps.now());
  if (autoQuotaCount < 0) {
    return err(factsUnknown("HostTriggerFacts.auto_quota_exhausted", "quota_count_invalid"));
  }
  const autoQuotaExhausted =
    autoQuotaCount >= policy.review.auto.max_auto_jobs_per_task_24h;

  const evidenceRefs = sortedUnique([
    rawEventRef,
    sourceRef,
    ...(stableEvidenceRef === undefined ? [] : [stableEvidenceRef]),
    ...pending.value.refs.map((ref) => ref.evidence_ref),
    policySnapshotRef
  ]);

  const origin = triggerOrigin(event.draft);
  return ok({
    adapter: adapterFacts(context),
    trigger_kind: triggerKind as HostTriggerFacts["trigger_kind"],
    origin,
    request_intent: "automatic",
    stage: false,
    signals,
    boundary: withUnstable,
    scope: {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version
    },
    identity_quality: context.identity_quality,
    source_event_ref: sourceRef,
    raw_event_ref: rawEventRef,
    ...(stableEvidenceRef === undefined ? {} : { stable_evidence_ref: stableEvidenceRef }),
    review_scope_key: reviewScopeKey,
    dedupe: {
      source_event_key: context.event_identity_key as Hash,
      boundary_key: boundaryKey,
      signal_digest: signalDigest,
      trigger_dedupe_key: triggerDedupeKey
    },
    authorization_ref: null,
    ...(event.draft.origin === "human" && event.draft.human_attestation !== undefined
      ? {
          human_attestation: {
            schema_version: "rsi.human_attestation/1" as const,
            kind: event.draft.human_attestation.kind,
            capability_id: event.draft.human_attestation.capability_id as Id<"cap">,
            evidence_ref: event.draft.human_attestation.evidence_ref as SourceRef,
            confirmed_at: event.draft.human_attestation.confirmed_at
          }
        }
      : {}),
    policy_snapshot_ref: policySnapshotRef,
    evidence_refs: evidenceRefs,
    job_live: priorJobLive || defaultOnlineJobLive(deps.connection, binding.task_id),
    replay_duplicate: replayDuplicate,
    auto_quota_exhausted: autoQuotaExhausted
  });
}

function hostBinding(
  facts: HostTriggerFacts,
  event: CommittedHostEvent,
  now: number
): HostEventBinding {
  const draft = event.draft;
  return {
    host_id: facts.adapter.host_id,
    host_version: facts.adapter.host_version,
    adapter_id: facts.adapter.adapter_id,
    adapter_version: facts.adapter.adapter_version,
    implementation_hash: facts.adapter.implementation_hash,
    mode: draft.mode,
    config_space: draft.config_space,
    host_event: draft.host_event,
    ...(draft.native_session_id === undefined ? {} : { native_session_id: draft.native_session_id }),
    ...(draft.native_message_id === undefined ? {} : { native_message_id: draft.native_message_id }),
    ...(draft.native_event_id === undefined ? {} : { native_event_id: draft.native_event_id }),
    stream_id: facts.adapter.stream_id,
    ...(facts.adapter.source_seq === undefined ? {} : { source_seq: facts.adapter.source_seq }),
    receipt_seq: event.receipt.watermark,
    ...(facts.adapter.native_occurrence_id === undefined
      ? {}
      : { native_occurrence_id: facts.adapter.native_occurrence_id }),
    ...(facts.adapter.retry_of === undefined ? {} : { retry_of: facts.adapter.retry_of }),
    event_identity_key: facts.adapter.event_identity_key,
    ...(facts.adapter.occurred_at === undefined ? {} : { occurred_at: facts.adapter.occurred_at }),
    received_at: now
  };
}

function buildTrigger(input: {
  readonly facts: HostTriggerFacts;
  readonly event: CommittedHostEvent;
  readonly policy: TriggerPolicy;
  readonly decision: TriggerDecision;
  readonly capability_gate: readonly CapabilityGateResult[];
  readonly now: number;
}): TriggerEvent {
  const { facts } = input;
  return {
    schema_version: "rsi.trigger_event/1",
    trigger_event_id: newId("trg", input.now),
    trigger_kind: facts.trigger_kind,
    source_event_ref: facts.source_event_ref,
    raw_event_ref: facts.raw_event_ref,
    ...(input.event.receipt.input_id === undefined
      ? {}
      : { local_input_id: input.event.receipt.input_id as Id<"input"> }),
    host_binding: hostBinding(facts, input.event, input.now),
    policy_ref: policyRefOf(input.policy),
    origin: facts.origin,
    request_intent: facts.request_intent,
    scope: facts.scope,
    identity_quality: facts.identity_quality,
    signals: [...facts.signals],
    boundary: facts.boundary,
    ...(facts.stable_evidence_ref === undefined ? {} : { stable_evidence_ref: facts.stable_evidence_ref }),
    review_scope_key: facts.review_scope_key,
    capability_gate: [...input.capability_gate],
    dedupe: facts.dedupe,
    decision: input.decision.decision,
    decision_reason: input.decision.reason,
    policy_snapshot_ref: facts.policy_snapshot_ref,
    decision_version: 1,
    decided_at: input.now,
    evidence_refs: [...facts.evidence_refs]
  };
}

function buildRequest(input: {
  readonly facts: HostTriggerFacts;
  readonly trigger: TriggerEvent;
  readonly policy: TriggerPolicy;
  readonly capability_snapshot_hash: Hash;
  readonly now: number;
}): Result<ReviewEnqueueRequest, ErrorEnvelope> {
  const { facts, trigger, policy } = input;
  if (!facts.boundary.stable || facts.boundary.pending_state !== "none") {
    return err(
      makeErrorEnvelope({
        code: "E_SCHEMA",
        category: "schema",
        message_key: "error.schema.invalid",
        stage: "trigger_admission",
        details: { kind: "field", path: "boundary.stable", rule: "required_for_auto" }
      })
    );
  }
  const stableEvidence = trigger.stable_evidence_ref ?? facts.source_event_ref;
  return ok({
    schema_version: "rsi.review_enqueue/1",
    request_id: newId("jreq", input.now),
    trigger_event_id: trigger.trigger_event_id,
    trigger_kind: trigger.trigger_kind,
    review_scope_key: trigger.review_scope_key,
    boundary_key: trigger.dedupe.boundary_key,
    signal_digest: trigger.dedupe.signal_digest,
    trigger_dedupe_key: trigger.dedupe.trigger_dedupe_key,
    stable_event_ids: [...trigger.boundary.stable_event_ids],
    stable_watermark: trigger.boundary.stable_watermark,
    goal_version: trigger.boundary.goal_version,
    scope: trigger.scope,
    pending_state: "none",
    pending_work_refs: [],
    stable: true,
    stable_evidence_ref: stableEvidence,
    policy_ref: trigger.policy_ref,
    origin: trigger.origin,
    capability_snapshot_hash: input.capability_snapshot_hash,
    budget_policy_ref: policy.budget.budget_policy_ref,
    created_at: input.now,
    review_kind: "auto",
    authorization_ref: null,
    snapshot_request: { mode: "stable", completeness: "complete", missing_evidence_refs: [] }
  });
}

function outcome(input: {
  readonly status: OnlinePipelineOutcome["status"];
  readonly decision: TriggerDecision;
  readonly trigger_event_id: Id<"trg"> | null;
  readonly review_job_id: Id<"job"> | null;
}): OnlinePipelineOutcome {
  return {
    status: input.status,
    stages: ["trigger_policy", "trigger_admission"],
    decision: input.decision,
    trigger_event_id: input.trigger_event_id,
    review_job_id: input.review_job_id,
    issues: [],
    plans: [],
    packs: [],
    shard_plans: [],
    bindings: [],
    envelopes: [],
    aggregates: [],
    decision_ids: [],
    delivery_ids: [],
    outbox_effect_keys: [],
    diagnostics: []
  };
}

function noOp(reason: TriggerDecision["reason"], decision: TriggerDecision["decision"] = "skip"): OnlinePipelineOutcome {
  return outcome({
    status: decision === "defer" ? "deferred" : "no_op",
    decision: { decision, reason, staged: false },
    trigger_event_id: null,
    review_job_id: null
  });
}

/**
 * W2: records the baseline checkpoint for a real stable boundary whose
 * automatic decision is not `enqueue`.
 *
 * The trigger is built from the same frozen facts and carries the real
 * non-enqueue decision, so the persisted TriggerEvent and the checkpoint hash
 * describe this boundary exactly. No signal, capability or progress counter is
 * invented. When the producer is not wired the call is a no-op.
 */
async function recordProgressBoundary(
  deps: DefaultOnlineCompositionDeps,
  input: {
    readonly event: CommittedHostEvent;
    readonly facts: HostTriggerFacts;
    readonly policy: TriggerPolicy;
    readonly decision: TriggerDecision;
    readonly capability_gate: readonly CapabilityGateResult[];
    readonly now: number;
  }
): Promise<Result<readonly string[], ErrorEnvelope>> {
  const port = deps.progress_boundary;
  if (port === undefined) return ok([]);
  const trigger = buildTrigger({
    facts: input.facts,
    event: input.event,
    policy: input.policy,
    decision: input.decision,
    capability_gate: input.capability_gate,
    now: input.now
  });
  const result = await port.ensure({
    event: input.event,
    facts: input.facts,
    policy: input.policy,
    decision: input.decision,
    trigger
  });
  if (!result.ok) return result;
  const value = result.value;
  if (!value.applicable) {
    return ok([`progress_boundary_not_applicable:${value.reason}`]);
  }
  if (value.reused) {
    return ok([`progress_boundary_reused:${value.checkpoint_id}`]);
  }
  return ok([
    value.baseline_established
      ? `progress_baseline_established:${value.checkpoint_id}`
      : `progress_boundary_recorded:${value.checkpoint_id}`
  ]);
}

type CapabilityGateReadResult = Result<readonly CapabilityGateResult[], ErrorEnvelope>;

function capabilityGate(
  capability: CapabilityPipelinePort,
  facts: HostTriggerFacts
): CapabilityGateReadResult {
  // Automatic admission is the only default path. Explicit review keeps its
  // own REV path and grant handling.
  if (facts.request_intent !== "automatic") {
    return ok([]);
  }
  const observed = capability.lookup("stable_boundary");
  return ok(
    buildCapabilityGate(["stable_boundary"], () =>
      observed === null
        ? { status: "unknown", evidence_stage: "none" }
        : { status: observed.status, evidence_stage: observed.evidence_stage }
    )
  );
}

const QP_DETECTOR_FALLBACK = "qp.issue_detector/1";
const QP_PLANNER_FALLBACK = "qp.planner/1";

function qpRejected(stage: "issue_discovery" | "issue_plan", incident: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal.unexpected",
    stage,
    details: { kind: "internal", incident_id: incident }
  });
}

interface DefaultQpStageResult {
  readonly issues: readonly OnlineIssue[];
  readonly plans: readonly OnlineQuestionPlan[];
  /**
   * Lifecycle returned by the planner beside each plan. A missing entry is not
   * filled with `active`; the downstream evidence port consults the QP
   * repository instead.
   */
  readonly plan_states: ReadonlyMap<string, OnlinePlanState>;
  readonly stages: readonly OnlinePipelineStage[];
  readonly diagnostics: readonly string[];
}

/**
 * Runs QP issue discovery and planning over the committed binding.
 *
 * This mirrors the pipeline's QP stage semantics: discovery first, then one
 * plan per discovered issue with the same registry and binding. A rejected
 * discovery or plan is wrapped as `E_INTERNAL` with the planner's code kept in
 * `incident_id`; it is never converted into an empty result. This differs from
 * a QP factory load error, whose envelope passes through unchanged.
 *
 * Exported so the wiring can be asserted against a real planner bundle without
 * fabricating an admitted review job.
 */
export function runDefaultQpStage(
  qp: QpPipelineDeps,
  event: CommittedHostEvent
): Result<DefaultQpStageResult, ErrorEnvelope> {
  const progressFrom = qp.progress_from_watermark ?? 0;
  const discovery = qp.planner.discover({
    binding: event.binding,
    watermark: event.binding.watermark,
    progress_from_watermark: progressFrom,
    policy_version: qp.detector_version ?? QP_DETECTOR_FALLBACK
  });
  if (discovery.status === "rejected") {
    const code = discovery.errors[0]?.code ?? "E_INTERNAL";
    return err(qpRejected("issue_discovery", `online_pipeline.issue_discovery:${code}`));
  }
  if (discovery.issues.length === 0) {
    return ok({
      issues: [],
      plans: [],
      plan_states: new Map<string, OnlinePlanState>(),
      stages: ["issue_discovery"],
      diagnostics: ["qp.no_op:no_issue"]
    });
  }

  const issues: OnlineIssue[] = [];
  const plans: OnlineQuestionPlan[] = [];
  const planStates = new Map<string, OnlinePlanState>();
  let lastReason = "no_issue";
  for (const issue of discovery.issues) {
    const planned = qp.planner.plan({
      binding: event.binding,
      issue,
      registry: qp.registry,
      policy_version: qp.planner_version ?? QP_PLANNER_FALLBACK
    });
    if (planned.status === "planned") {
      issues.push(issue);
      plans.push(planned.plan);
      // Only the planner's own persisted lifecycle may enter the map. A
      // missing value is resolved through `plan_lifecycle` downstream.
      if (planned.plan_state !== undefined) {
        planStates.set(planned.plan.plan_id, planned.plan_state);
      }
      continue;
    }
    lastReason = planned.reason;
    if (planned.status === "rejected") {
      return err(
        qpRejected(
          "issue_plan",
          `online_pipeline.issue_plan:${planned.reason}:${planned.issue_id}`
        )
      );
    }
  }

  if (plans.length === 0) {
    return ok({
      issues,
      plans,
      plan_states: planStates,
      stages: ["issue_discovery"],
      diagnostics: [`qp.no_op:${lastReason}`]
    });
  }
  return ok({
    issues,
    plans,
    plan_states: planStates,
    stages: ["issue_discovery", "issue_plan"],
    diagnostics: []
  });
}

interface DefaultAdmittedOutcomeInput {
  /** The outcome produced by trigger policy plus review admission. */
  readonly admitted: OnlinePipelineOutcome;
  /** QP stage result; absent when no QP composer was supplied. */
  readonly qp?: DefaultQpStageResult;
}

/**
 * Settles the outcome when no composed downstream tail ran.
 *
 * The runner calls the real EVD tail when the bootstrap installed it. Without
 * that composition a produced plan ends as `deferred` with
 * `downstream_unavailable`, and a runner without a QP composer ends as
 * `deferred` with `qp_unavailable`. Only QP's own no-issue result keeps
 * `no_op`; neither path claims the whole online chain completed.
 */
export function finalizeDefaultAdmittedOutcome(
  input: DefaultAdmittedOutcomeInput
): OnlinePipelineOutcome {
  if (input.qp === undefined) {
    return {
      ...input.admitted,
      status: "deferred",
      diagnostics: ["qp_unavailable"]
    };
  }
  const stages = [...input.admitted.stages, ...input.qp.stages];
  if (input.qp.plans.length === 0) {
    return {
      ...input.admitted,
      status: "no_op",
      stages,
      issues: input.qp.issues,
      diagnostics: [...input.qp.diagnostics]
    };
  }
  return {
    ...input.admitted,
    status: "deferred",
    stages,
    issues: input.qp.issues,
    plans: input.qp.plans,
    diagnostics: [...input.qp.diagnostics, "downstream_unavailable"]
  };
}

export function createDefaultOnlineRunner(
  deps: DefaultOnlineCompositionDeps
): DefaultOnlineRunner {
  const now = deps.now;
  const budget = createBudgetAvailabilityPort(deps.connection);
  // The QP planner deduplicates a plan across boundaries (same plan hash).
  // Compiling it again would insert the same pack/shard keys and the EVD
  // writer would refuse the batch; the first compile already covers it.
  const completedPlanHashes = new Set<string>();

  /**
   * Appendix Q.2: one review at the last stable boundary of an ended session.
   * The boundary facts were written by the online runner when the turn
   * settled; this function only re-evaluates the signals after the previous
   * review watermark and admits once. A session without a stable boundary (or
   * without new signals) ends without a review.
   */
  const flushSessionEndInternal = async (
    task_id: string,
    reason: "session_end" | "lease_expired"
  ): Promise<Result<OnlinePipelineOutcome, ErrorEnvelope>> => {
    const state = readSessionReviewStateByTask(deps.connection, task_id);
    const flushedNoOp = (why: string): Result<OnlinePipelineOutcome, ErrorEnvelope> => {
      if (state !== null) {
        markSessionFlushed(deps.connection, state.session_id, reason, null, now());
      }
      const skipped = noOp("no_verified_signal");
      return ok({ ...skipped, diagnostics: [...skipped.diagnostics, `session_end_flush:${why}`] });
    };
    if (state === null) return flushedNoOp("no_stable_boundary");
    let policy: TriggerPolicy;
    let storedTrigger: TriggerEvent;
    let binding: VersionBinding;
    let facts: HostTriggerFacts;
    try {
      policy = JSON.parse(state.policy_json) as TriggerPolicy;
      storedTrigger = JSON.parse(state.trigger_json) as TriggerEvent;
      binding = JSON.parse(state.binding_json) as VersionBinding;
      facts = JSON.parse(state.facts_json) as HostTriggerFacts;
    } catch {
      return flushedNoOp("state_unreadable");
    }
    if (!policy.review.auto.enabled || triggerPolicyHash(policy) !== policy.policy_hash) {
      return flushedNoOp("policy_auto_disabled");
    }
    // A resume advances input_epoch without emitting a new host Stop. The
    // stored outcome revision is then stale and the snapshot source plan
    // rejects the review. Re-evaluate at the boundary binding before reading
    // signals; the callback is a no-op when the outcome already matches.
    const boundaryEventId = facts.boundary.stable_event_ids[0];
    if (deps.evaluate_outcome !== undefined && boundaryEventId !== undefined) {
      const evaluated = await deps.evaluate_outcome(
        binding,
        boundaryEventId as Id<"ev">
      );
      if (!evaluated.ok) return evaluated;
    }
    maybeAdvanceSettledReview(deps.connection, task_id);
    const lastReview = effectiveReviewWatermark(deps.connection, task_id);
    const detected = await readDetectedSignals(deps, binding, policy, lastReview);
    if (!detected.ok) return detected;
    const relevant = filterAutoSignals(detected.value, policy.review.auto.min_signals);
    if (relevant.length === 0) return flushedNoOp("no_new_signal");
    if (defaultOnlineJobLive(deps.connection, task_id)) return flushedNoOp("job_live");
    const quota = countAutoJobsInWindow(deps.connection, task_id, now());
    if (quota < 0) return err(factsUnknown("HostTriggerFacts.auto_quota_exhausted", "quota_count_invalid"));
    if (quota >= policy.review.auto.max_auto_jobs_per_task_24h) {
      return flushedNoOp("auto_quota_exhausted");
    }
    const budgetAvailable = await budget.available();
    if (budgetAvailable.ok && !budgetAvailable.value) return flushedNoOp("budget_unavailable");
    const capability = createCapabilityPipelinePort(deps.connection, {
      host_id: storedTrigger.host_binding.host_id,
      mode: storedTrigger.host_binding.mode,
      config_space: storedTrigger.host_binding.config_space
    });
    if (!capability.ok) return capability;
    const snapshotHash = capability.value.snapshotHash();
    if (!snapshotHash.ok) return snapshotHash;
    // Keep the boundary's own kind: REV recomputes the boundary and scope
    // keys from it, so rewriting the kind would invalidate the stored keys.
    const boundary: StableBoundaryEvidence = {
      ...facts.boundary,
      stable: true,
      pending_state: "none",
      pending_work_refs: [],
      unstable_reasons: []
    };
    const sessionFacts: HostTriggerFacts = {
      ...facts,
      trigger_kind: "session_end",
      signals: [...relevant],
      boundary
    };
    const trigger: TriggerEvent = {
      ...storedTrigger,
      trigger_kind: "session_end",
      signals: [...relevant],
      boundary,
      policy_ref: policyRefOf(policy),
      decision: "enqueue",
      decision_reason: "auto_enqueued",
      decided_at: now()
    };
    const request = buildRequest({
      facts: sessionFacts,
      trigger,
      policy,
      capability_snapshot_hash: snapshotHash.value,
      now: now()
    });
    if (!request.ok) return request;
    const admitted = await admitTrigger(
      { trigger, req: request.value, binding, pending: [] },
      { review: deps.review, commit: deps.commit }
    );
    if (!admitted.ok) return admitted;
    const jobId = admitted.value.review?.review_job_id ?? null;
    markReviewPending(deps.connection, task_id, jobId, state.stable_watermark);
    markSessionFlushed(deps.connection, state.session_id, reason, jobId, now());
    return ok(outcome({
      status: "completed",
      decision: { decision: "enqueue", reason: "auto_enqueued", staged: false },
      trigger_event_id: admitted.value.trigger_event_id,
      review_job_id: jobId
    }));
  };


  return {
    async run(event, context, options) {
      if (event.receipt.duplicate) {
        return ok(noOp("replay_duplicate"));
      }
      // Appendix H.3: a kernel probe session is evaluator work. Its events
      // never enter review signals or enqueue a review.
      if (isKernelProbeNativeSession(deps.connection, event.draft.native_session_id)) {
        return ok(noOp("internal_origin", "suppress"));
      }

      const policy = loadTriggerPolicyForEvent(deps.connection, event);
      if (!policy.ok) return policy;
      if (policy.value === null) {
        return ok(noOp("policy_auto_disabled"));
      }
      if (!policy.value.review.auto.enabled) {
        return ok(noOp("policy_auto_disabled"));
      }
      if (triggerPolicyHash(policy.value) !== policy.value.policy_hash) {
        return ok(noOp("policy_auto_disabled"));
      }

      if (context === null) {
        return err(
          factsUnknown(
            "HostTriggerFacts.adapter",
            "normalization_context_missing"
          )
        );
      }
      if (context.event_identity_key !== event.draft.event_identity_key) {
        return err(factsUnknown("HostTriggerFacts.adapter.event_identity_key", "context_mismatch"));
      }

      const origin = triggerOrigin(event.draft);
      if (origin.kind === "evaluator" || origin.kind === "evaluator_descendant") {
        return ok(noOp("internal_origin", "suppress"));
      }
      if (origin.kind === "unknown") {
        return ok(noOp("origin_unknown"));
      }
      if (!isBoundaryCandidate(context)) {
        return ok(noOp("not_boundary_candidate"));
      }

      const kind = selectedTriggerKind(context);
      if (!kind.ok) return kind;

      const policyBytes = canonicalJson(toJsonValue(policy.value));
      const storedPolicy = deps.blob_store.putSync(policyBytes);
      if (!storedPolicy.ok) return storedPolicy;
      const policySnapshotRef = sourceRefFor(
        storedPolicy.value.hash as Hash,
        policyBytes.byteLength
      );

      const factsResult = await readFacts(
        deps,
        event,
        context,
        policy.value,
        policySnapshotRef,
        kind.value
      );
      if (!factsResult.ok) return factsResult;
      let facts = factsResult.value;
      // Closure design appendix C.1: the kernel proves a stable boundary for
      // `agent_end`/`agent_settled`/`session_shutdown` when the runtime stream
      // has no outstanding tool call. REV only accepts `task_stable`,
      // `user_review_request`, `experience_trigger` and `session_end`, so the
      // adapter's provisional `task_boundary_candidate` is promoted once the
      // boundary is proved stable; otherwise every first review would fail as
      // `review_trigger_kind`.
      if (facts.boundary.stable && facts.trigger_kind === "task_boundary_candidate") {
        facts = {
          ...facts,
          trigger_kind:
            event.draft.host_event === "session_shutdown" || event.draft.host_event === "session_stop"
              ? "session_end"
              : "task_stable"
        };
      }

      const capability = createCapabilityPipelinePort(deps.connection, {
        host_id: event.draft.host_id,
        mode: event.draft.mode,
        config_space: event.draft.config_space
      });
      if (!capability.ok) return capability;
      const gateResult = capabilityGate(capability.value, facts);
      if (!gateResult.ok) return gateResult;
      const snapshotHash = capability.value.snapshotHash();
      if (!snapshotHash.ok) return snapshotHash;

      let budgetAvailable = false;
      const available = await budget.available();
      if (available.ok) budgetAvailable = available.value;

      // A boundary the kernel itself proved from the committed event (Pi's
      // unknown-facts hooks, OpenCode's synthesized turn boundary) is verified
      // for this decision. The adapter's static capability row cannot.
      const kernelProvedBoundary =
        facts.boundary.stable &&
        boundaryPromotion({
          host_id: event.draft.host_id,
          host_event: event.draft.host_event,
          payload: event.draft.payload,
          trigger_kind: facts.trigger_kind,
          pending_state: facts.boundary.pending_state
        }).kernel_proved;

      const decision = decideAutomatic({
        origin: facts.origin,
        boundary: facts.boundary,
        signals: facts.signals,
        // Closure design §6.3: automatic review is authorised by the attached
        // host and the committed stable boundary itself. A runtime-only
        // self-report can never promote `stable_boundary`, so that capability
        // row must not veto a boundary the kernel just proved stable.
        stableBoundaryStatus:
          kernelProvedBoundary
          ? "verified"
          : (gateResult.value.find((entry) => entry.name === "stable_boundary")?.observed_status ??
            "unknown"),
        liveJob: facts.job_live,
        replayDuplicate: facts.replay_duplicate,
        autoQuotaExhausted: facts.auto_quota_exhausted,
        budgetAvailable: (kernelProvedBoundary || capabilityGatePassed(gateResult.value)) && budgetAvailable,
        policy: policy.value
      });

      // Appendix Q.2 (2026-11-20 revision): review happens only at session
      // end. A stable boundary records its facts and watermark; the admission
      // decision is deferred, never dropped, so the session-end flush sees
      // exactly the last completed turn.
      const sessionEndTrigger = facts.trigger_kind === "session_end";
      let effectiveDecision = decision;
      if (decision.decision === "enqueue" && !sessionEndTrigger) {
        effectiveDecision = { decision: "skip", reason: "session_end_only", staged: false };
      }
      if (facts.boundary.stable) {
        const storedTrigger = buildTrigger({
          facts,
          event,
          policy: policy.value,
          decision: effectiveDecision,
          capability_gate: gateResult.value,
          now: now()
        });
        const recorded = recordStableBoundary(deps.connection, {
          session_id: event.receipt.session_id,
          task_id: event.binding.task_id,
          branch_id: event.binding.branch_id,
          native_session_id: event.draft.native_session_id ?? null,
          host_id: event.draft.host_id,
          config_space: event.draft.config_space,
          input_epoch: event.binding.input_epoch,
          goal_version: event.binding.goal_version,
          config_version: event.binding.config_version,
          stable_watermark: facts.boundary.stable_watermark,
          now: now(),
          facts,
          trigger: storedTrigger,
          binding: event.binding,
          policy: policy.value
        });
        if (!recorded.ok) return recorded;
      }
      // A session-end hook can arrive mid-turn (no stable boundary). In that
      // case the review uses the stored last stable boundary, so the
      // unfinished turn stays out of the snapshot.
      if (sessionEndTrigger && !facts.boundary.stable && effectiveDecision.decision !== "defer") {
        return flushSessionEndInternal(event.binding.task_id, "session_end");
      }

      // W2: a committed stable boundary records its baseline before admission
      // relies on it. That is the only path that runs on a fresh home, where
      // automatic admission still returns its named skip. It is wired only
      // when the caller installs the boundary producer and never loosens the
      // admission table.
      let boundaryDiagnostics: readonly string[] = [];
      if (
        effectiveDecision.decision !== "enqueue" &&
        deps.progress_boundary !== undefined &&
        policy.value.progress.enabled
      ) {
        const boundary = await recordProgressBoundary(deps, {
          event,
          facts,
          policy: policy.value,
          decision: effectiveDecision,
          capability_gate: gateResult.value,
          now: now()
        });
        if (!boundary.ok) return boundary;
        boundaryDiagnostics = boundary.value;
      }
      if (effectiveDecision !== decision) {
        boundaryDiagnostics = [...boundaryDiagnostics, "review_deferred_to_session_end"];
      }
      const decisionView = effectiveDecision;

      if (decisionView.decision === "defer") {
        // No ReviewDeferPending is minted here: DD-TRG-007 fixes the entry
        // shape, but the default composition has no HOST pending writer. The
        // decision is reported and the existing pending state stays untouched.
        deps.on_diagnostic?.("default_online.defer_pending_not_written");
        const deferred = outcome({
          status: "deferred",
          decision: decisionView,
          trigger_event_id: null,
          review_job_id: null
        });
        return ok({ ...deferred, diagnostics: [...deferred.diagnostics, ...boundaryDiagnostics] });
      }
      if (decisionView.decision !== "enqueue") {
        // A live review job must not starve the evidence tail (QP issue
        // discovery, EVD compile, Jev judgement). The review producer and this
        // runner consume the same boundary; when the producer already owns the
        // review job, the evidence stages still run without enqueueing a
        // second job.
        const evidenceOnly =
          decisionView.decision === "skip" &&
          (decisionView.reason === "job_live" || decisionView.reason === "replay_duplicate");
        if (!evidenceOnly) {
          const skipped = outcome({
            status: "no_op",
            decision: decisionView,
            trigger_event_id: null,
            review_job_id: null
          });
          return ok({ ...skipped, diagnostics: [...skipped.diagnostics, ...boundaryDiagnostics] });
        }
      }

      // The facts carried no pending changes, so admission writes only the
      // frozen TriggerEvent and the REV request/job. A refused pending change
      // must not be manufactured here.
      const pending: readonly PendingChange[] = [];
      const trigger = buildTrigger({
        facts,
        event,
        policy: policy.value,
        decision: decisionView,
        capability_gate: gateResult.value,
        now: now()
      });
      let admittedOutcome: OnlinePipelineOutcome;
      if (decisionView.decision !== "enqueue") {
        admittedOutcome = outcome({
          status: "completed",
          decision: decisionView,
          trigger_event_id: trigger.trigger_event_id,
          review_job_id: null
        });
      } else {
        const request = buildRequest({
          facts,
          trigger,
          policy: policy.value,
          capability_snapshot_hash: snapshotHash.value,
          now: now()
        });
        if (!request.ok) return request;

        const admitted = await admitTrigger(
          {
            trigger,
            req: request.value,
            binding: event.binding,
            pending
          },
          { review: deps.review, commit: deps.commit }
        );
        if (!admitted.ok) return admitted;
        if (sessionEndTrigger) {
          const jobId = admitted.value.review?.review_job_id ?? null;
          markReviewPending(
            deps.connection,
            event.binding.task_id,
            jobId,
            facts.boundary.stable_watermark
          );
          markSessionFlushed(
            deps.connection,
            event.receipt.session_id,
            "session_end",
            jobId,
            now()
          );
        }

        admittedOutcome = outcome({
          // Final status is settled after the composed stages; this value only
          // carries the admitted trigger and review job into that decision.
          status: "completed",
          decision: decisionView,
          trigger_event_id: admitted.value.trigger_event_id,
          review_job_id: admitted.value.review?.review_job_id ?? null
        });
      }

      // Progress is a post-admission side effect. It must complete before QP
      // loads the evidence index, and an uncertain write keeps the committed
      // side-effect marker instead of turning admission into a rejection.
      // The evidence-only path (a live review job) has no admitted trigger to
      // validate a second checkpoint against; the W2 boundary producer already
      // recorded this boundary's checkpoint before the decision.
      if (
        decisionView.decision === "enqueue" &&
        deps.progress !== undefined &&
        policy.value.progress.enabled
      ) {
        const progress = await deps.progress.ensure({ event, trigger, decision: decisionView });
        if (!progress.ok) {
          return err({ ...progress.error, side_effect: "committed" });
        }
      }

      if (deps.qp === undefined) {
        return ok(finalizeDefaultAdmittedOutcome({ admitted: admittedOutcome }));
      }

      const composeInput: DefaultQpComposeInput = {
        binding: event.binding,
        review_job_id: admittedOutcome.review_job_id,
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      };
      const bundle = await deps.qp(composeInput);
      if (!bundle.ok) {
        // The real factory returns the evidence-index load envelope unchanged,
        // so a missing HOST checkpoint stays `E_INDEX_PROGRESS_UNSUPPORTED`.
        return bundle;
      }
      const qpStage = runDefaultQpStage(bundle.value.qp, event);
      if (!qpStage.ok) return qpStage;

      const freshPlans = qpStage.value.plans.filter(
        (plan) => !completedPlanHashes.has(plan.plan_hash)
      );
      const effectiveQp =
        freshPlans.length === qpStage.value.plans.length
          ? qpStage.value
          : {
              ...qpStage.value,
              plans: freshPlans,
              issues: qpStage.value.issues.filter((issue) =>
                freshPlans.some((plan) => plan.issue_id === issue.issue_id)
              ),
              diagnostics: [
                ...qpStage.value.diagnostics,
                `qp.reused_plans:${String(qpStage.value.plans.length - freshPlans.length)}`
              ]
            };

      // A QP no-issue result has no downstream work. A produced plan continues
      // through the real local EVD composition when the bootstrap installed
      // it; otherwise the explicit `downstream_unavailable` result stands.
      if (
        effectiveQp.plans.length === 0 ||
        deps.downstream === undefined ||
        deps.decision === undefined ||
        deps.delivery === undefined
      ) {
        return ok(finalizeDefaultAdmittedOutcome({ admitted: admittedOutcome, qp: effectiveQp }));
      }

      const downstream = await deps.downstream.runDownstream({
        event,
        admitted: admittedOutcome,
        qp: effectiveQp,
        qp_deps: bundle.value.qp,
        plans_repository: bundle.value.plans,
        issues_repository: bundle.value.issues,
        decision: deps.decision,
        delivery: deps.delivery,
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      });
      if (downstream.ok) {
        for (const plan of effectiveQp.plans) completedPlanHashes.add(plan.plan_hash);
      }
      return downstream;
    },
    flushSessionEnd(task_id, reason) {
      return flushSessionEndInternal(task_id, reason);
    }
  };
}
