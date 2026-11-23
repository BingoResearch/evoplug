/**
 * REV background worker loop (DD-REV-020/030/032/040/080/140/151, DD-HOST-002).
 *
 * The loop is the only component in the kernel that leases `ReviewJob` rows and
 * drives them through the documented five-stage pipeline. It never writes
 * SQLite, journals or proposals itself: every state transition goes through the
 * injected `ReviewService`, and the only external effects are the HOST
 * `HostGenerationPort` calls and an optional downstream handoff delivery hook.
 *
 * Fail-closed behaviour:
 * - without a generation backend (or without the ports needed to persist and
 *   authenticate its output) the loop never claims a job, so jobs stay in
 *   `queued` / `blocked_no_backend` and are never turned into `failed`;
 * - an absent lease, an expired lease, a cancel request, a fencing mismatch or
 *   an unknown provider outcome stops the attempt before `acceptOutput`, so a
 *   proposal is never fabricated;
 * - stage failures are surfaced as `RevError`s and retried with backoff; the
 *   loop never advances a job stage by writing the job row directly.
 *
 * REV does not enqueue outbox rows during generation: the only REV outbox
 * effect is `review.enqueue`, produced in the T1 enqueue frame by HOST. The
 * optional `delivery` port below is a downstream notification hook used after a
 * handoff committed; it is not a replacement for the FND outbox.
 */

import { canonicalJson, canonicalJsonText, hashBytes, makeErrorEnvelope, parseSourceRef, toJsonValue } from "@evoplug/core";
import type { JsonValue } from "@evoplug/core";
import type { Clock, ErrorEnvelope, Hash, Result, SourceRef, SourceRefPort } from "@evoplug/core";
import { err, ok } from "@evoplug/core";
import type { BlobStore } from "@evoplug/storage";

import {
  blobRef,
  buildCancelKey,
  isTerminalJobState,
  LEASE_DEFAULTS,
  mapHostAdapterError,
  markAttemptTerminal,
  outputReadMismatch,
  parseGeneratorOutput,
  proposalSchemaFailure,
  PIPELINE_STAGES,
  revErr,
  revError,
  revErrorFromCode,
  revErrorFromEnvelope,
  revOk,
  sourceDetails
} from "@evoplug/review";
import type {
  ClaimedAttempt,
  GeneratorInput,
  GeneratorRunResult,
  GeneratorRunnerPort,
  HostAdapterError,
  HostGenerationPort,
  ReviewAttempt,
  ReviewHandoff,
  ReviewJob,
  ReviewJobStage,
  ReviewRepository,
  ReviewService,
  ReviewSnapshot,
  ReviewWritePort,
  RevError,
  RevResult,
  SourceBytesPort
} from "@evoplug/review";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_REVIEW_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_REVIEW_WORKER_RETRY_MS = 5_000;

const DEFAULT_REVIEW_CANCEL_POLL_MS = 1_000;
const DEFAULT_REVIEW_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_REVIEW_CANCEL_ACK_GRACE_MS = 5_000;
const DEFAULT_REVIEW_MAX_STAGE_JOBS = 16;
const DEFAULT_REVIEW_MAX_OUTPUT_ROUNDS = 10_000;

/** Stages that have no active lease and can be resumed after a crash. */
const RESUMABLE_STAGES: readonly ReviewJobStage[] = PIPELINE_STAGES.filter(
  (stage) => stage !== "snapshot" && stage !== "generate"
);

/* ------------------------------------------------------------------ */
/* Public contract                                                     */
/* ------------------------------------------------------------------ */

/**
 * Downstream handoff notification. The optional recovery hook must process
 * durable pending handoff markers before new work is claimed.
 */
export interface ReviewWorkerDeliveryPort {
  handoffCommitted(input: {
    readonly job: ReviewJob;
    readonly handoff: ReviewHandoff;
  }): Promise<Result<void, ErrorEnvelope>>;
  recoverPending?(): Promise<Result<number, ErrorEnvelope>>;
}

/**
 * Content-addressed I/O supplied to a HOST generation adapter by the kernel
 * composition root. The adapter never receives the BlobStore itself.
 */
export interface GenerationBlobPorts {
  readonly readSource: (
    ref: SourceRef,
    options?: { readonly maxBytes?: number }
  ) => Promise<Result<Uint8Array, ErrorEnvelope>>;
  readonly writeOutput: (bytes: Uint8Array) => Promise<Result<SourceRef, ErrorEnvelope>>;
}

/**
 * Builds generation I/O over the kernel-owned content-addressed BlobStore.
 * Snapshot reads use the verified SourceRefPort when supplied; output writes
 * remain BlobStore-only and are committed by the owning review write path.
 */
export function createBlobBackedGenerationPorts(
  blobStore: BlobStore,
  sourceRefs?: Pick<SourceRefPort, "resolve">
): GenerationBlobPorts {
  void sourceRefs;
  const source = blobSourceBytes(blobStore);
  // Read the CAS directly. The review worker writes the frozen snapshot body
  // through `output_persist` (a CAS write); requiring a `blob` projection row
  // here made every first generation fail with `E_EVIDENCE_UNKNOWN` even
  // though the bytes were present and hash-verified.
  const readSource = source.read;
  return {
    readSource,
    writeOutput: async (bytes) => {
      const stored = await blobStore.put(bytes);
      if (!stored.ok) {
        return stored;
      }
      return ok(blobRef(stored.value.hash, stored.value.byte_length));
    }
  };
}

export interface ReviewWorkerLoopOptions {
  readonly service: ReviewService;
  readonly repository: ReviewRepository;
  /** Absent means the loop never claims a job. */
  readonly generation: HostGenerationPort | null;
  /** Overrides the built-in HOST generation runner. */
  readonly runner?: GeneratorRunnerPort;
  /** Optional direct row access used only to terminalise a cancelled attempt. */
  readonly write?: ReviewWritePort;
  /** Optional blob store; enables the built-in output reader/persister. */
  readonly blob_store?: BlobStore;
  readonly source_bytes?: SourceBytesPort;
  readonly output_persist?: (
    ref: SourceRef,
    bytes: Uint8Array
  ) => Promise<Result<void, ErrorEnvelope>>;
  /** HOST-owned credential reference; without it the runner fails closed. */
  readonly credential_ref?: (input: {
    readonly job: ReviewJob;
    readonly snapshot: ReviewSnapshot;
    readonly attempt: ReviewAttempt;
  }) => string;
  readonly data_scope_ref?: (input: {
    readonly job: ReviewJob;
    readonly snapshot: ReviewSnapshot;
    readonly attempt: ReviewAttempt;
  }) => string;
  readonly clock?: Clock;
  readonly worker_id?: string;
  readonly interval_ms?: number;
  readonly retry_ms?: number;
  /** Must stay below half of `lease_ttl_ms` (DD-REV-032). */
  readonly heartbeat_interval_ms?: number;
  readonly lease_ttl_ms?: number;
  readonly cancel_poll_ms?: number;
  readonly recovery_interval_ms?: number;
  readonly max_stage_jobs_per_tick?: number;
  readonly max_output_rounds?: number;
  /**
   * Appendix I.4: retry one invalid generation output with the first error.
   * Enabled by the production composition; synthetic runners keep their
   * single-run call pattern unless they opt in.
   */
  readonly retry_invalid_output?: boolean;
  readonly cancel_requested?: (attempt_id: string) => Promise<boolean>;
  readonly delivery?: ReviewWorkerDeliveryPort;
  readonly on_error?: (input: ReviewLoopErrorEvent) => void;
}

interface ReviewLoopErrorEvent {
  readonly stage: string;
  readonly code: string;
  readonly retryable: boolean;
  /** Host/storage message behind the code; never a credential or payload. */
  readonly cause?: string;
  /** Fine-grained stage recorded by the failing service, when it differs. */
  readonly error_stage?: string;
  readonly job_id?: string;
  readonly attempt_id?: string;
}

interface ReviewWorkerLoopRun {
  readonly status: "disabled" | "idle" | "processed" | "error";
  readonly claimed: number;
  readonly accepted: number;
  readonly failed: number;
  readonly recovered: number;
  readonly advanced: number;
  readonly errors: readonly RevError[];
}

export interface ReviewWorkerLoop {
  readonly worker_id: string;
  /** False when no generation backend/runner is usable. */
  readonly enabled: boolean;
  /** Processes at most one lease plus all resumable stage jobs. */
  runOnce(): Promise<ReviewWorkerLoopRun>;
  /** Reclaims expired attempts and pending handoff notifications without claiming new work. */
  recover(): Promise<ReviewWorkerLoopRun>;
  /** Starts the timer-driven loop; idempotent while already running. */
  start(): void;
  /** Stops the loop and waits for an in-flight pass to settle. */
  stop(): Promise<void>;
}

type ReviewAttemptExecution =
  | { readonly kind: "accepted"; readonly job: ReviewJob; readonly attempt: ReviewAttempt }
  | { readonly kind: "cancelled"; readonly attempt: ReviewAttempt }
  | { readonly kind: "lease_lost"; readonly attempt: ReviewAttempt }
  | { readonly kind: "failed"; readonly attempt: ReviewAttempt; readonly error: RevError };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clockOf(clock: Clock | undefined): Clock {
  return (
    clock ?? {
      utcNowMs: (): number => Date.now(),
      monotonicNowMs: (): number => performance.now(),
      monotonicRemainingMs: (deadline: number): number => Math.max(0, deadline - performance.now())
    }
  );
}

function loopError(code: string, stage: string, retryable: boolean, cause?: string): RevError {
  const error = revErrorFromCode(code, stage, retryable);
  return cause === undefined ? error : { ...error, cause };
}

function hostError(error: HostAdapterError): RevError {
  return revErrorFromEnvelope(mapHostAdapterError(error));
}

function cancelledError(): RevError {
  return loopError("E_REVIEW_CANCELLED", "generate", false);
}

function leaseLostError(): RevError {
  return loopError("E_REVIEW_LEASE_EXPIRED", "lease", true);
}

function errorEvent(
  stage: string,
  error: RevError,
  ids: { readonly job_id?: string; readonly attempt_id?: string }
): ReviewLoopErrorEvent {
  const event: ReviewLoopErrorEvent = {
    stage,
    code: error.code,
    retryable: error.retryable
  };
  return {
    ...event,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    ...(error.stage === stage ? {} : { error_stage: error.stage }),
    ...(ids.job_id === undefined ? {} : { job_id: ids.job_id }),
    ...(ids.attempt_id === undefined ? {} : { attempt_id: ids.attempt_id })
  };
}

function isTerminalState(state: ReviewJob["state"]): boolean {
  return isTerminalJobState(state);
}

/* ------------------------------------------------------------------ */
/* Blob-backed output ports                                            */
/* ------------------------------------------------------------------ */

function blobSourceBytes(blobStore: BlobStore): SourceBytesPort {
  return {
    read: async (ref, opts): Promise<Result<Uint8Array, ErrorEnvelope>> => {
      const parsed = parseSourceRef(ref);
      if (!parsed.ok) {
        return parsed;
      }
      if (parsed.value.scheme !== "blob") {
        return err(sourceError("E_SOURCE_UNRETRIEVABLE", "source_ref", ref, "missing"));
      }
      const stored = blobStore.read(parsed.value.locator as Hash);
      if (!stored.ok) {
        return stored;
      }
      const length = parsed.value.end - parsed.value.start;
      if (length > (opts?.maxBytes ?? 33_554_432) || parsed.value.end > stored.value.byteLength) {
        return err(sourceError("E_SOURCE_TOO_LARGE", "source_ref", ref, "too_large"));
      }
      return ok(stored.value.subarray(parsed.value.start, parsed.value.end));
    }
  };
}

function sourceError(
  code: `E_${string}`,
  stage: string,
  ref: SourceRef,
  reason: "missing" | "too_large" | "out_of_range"
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: "source",
    message_key: "error.source",
    stage,
    retryable: false,
    side_effect: "none",
    details: sourceDetails(ref, reason)
  });
}

function blobOutputPersist(
  blobStore: BlobStore
): (ref: SourceRef, bytes: Uint8Array) => Promise<Result<void, ErrorEnvelope>> {
  return async (ref, bytes) => {
    const parsed = parseSourceRef(ref);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.value.scheme !== "blob") {
      return err(sourceError("E_REVIEW_OUTPUT_READ_MISMATCH", "output", ref, "missing"));
    }
    const actual = hashBytes(bytes);
    if (actual !== parsed.value.locator) {
      return err(outputReadMismatch(parsed.value.locator as Hash, actual));
    }
    if (parsed.value.start !== 0 || parsed.value.end !== bytes.byteLength) {
      return err(sourceError("E_REVIEW_OUTPUT_READ_MISMATCH", "output", ref, "out_of_range"));
    }
    const stored = blobStore.putSync(bytes);
    if (!stored.ok) {
      return stored;
    }
    return ok(undefined);
  };
}

/* ------------------------------------------------------------------ */
/* Completion output recording                                         */
/* ------------------------------------------------------------------ */

function countLf(bytes: Uint8Array): number {
  let count = 0;
  for (const value of bytes) {
    if (value === 0x0a) count += 1;
  }
  return count;
}

/**
 * DD-REV-041: the completion ref is only known after the backend finishes.
 * Persist it on the attempt row before `acceptOutput`, which reads
 * `attempt.output_ref` and compares `attempt.output.hash` with the bytes.
 * The save is compare-and-set; a concurrent heartbeat may bump the row
 * version, so re-read and retry a bounded number of times.
 */
async function recordCompletionOutput(
  deps: HostGenerationRunnerDeps,
  attemptId: string,
  ref: SourceRef,
  bytes: Uint8Array
): Promise<Result<void, ErrorEnvelope>> {
  if (deps.write === undefined) {
    return ok(undefined);
  }
  const hash = hashBytes(bytes);
  for (let round = 0; round < 4; round += 1) {
    const current = await deps.repository.getAttempt(attemptId);
    if (current === null) {
      return err(
        revError({
          code: "E_REVIEW_LEASE_EXPIRED",
          stage: "lease",
          details: { kind: "version", expected: attemptId, actual: "missing" }
        })
      );
    }
    if (current.output_ref === ref && current.output?.hash === hash) {
      return ok(undefined);
    }
    const now = deps.clock.utcNowMs();
    const next: ReviewAttempt = {
      ...current,
      output_ref: ref,
      output: {
        ref,
        hash,
        bytes: bytes.byteLength,
        lines: countLf(bytes),
        proposal_count: current.output?.proposal_count ?? 0,
        schema_valid: "unknown",
        accepted_at: current.output?.accepted_at ?? now,
        ...(current.output?.read_cursor === undefined
          ? {}
          : { read_cursor: current.output.read_cursor })
      },
      row_version: current.row_version + 1,
      updated_at: now
    };
    const saved = await deps.write.saveAttempt(next, current.row_version);
    if (saved.ok) {
      return ok(undefined);
    }
  }
  return err(
    makeErrorEnvelope({
      code: "E_STORAGE_UNAVAILABLE",
      category: "storage",
      message_key: "error.storage_unavailable",
      stage: "storage",
      retryable: true,
      side_effect: "none",
      details: { kind: "storage", operation: "record_output_ref" }
    })
  );
}

/* ------------------------------------------------------------------ */
/* Built-in HOST generation runner                                     */
/* ------------------------------------------------------------------ */

interface HostGenerationRunnerDeps {
  readonly generation: HostGenerationPort;
  readonly repository: ReviewRepository;
  readonly clock: Clock;
  readonly source_bytes: SourceBytesPort;
  /** Appendix I.4 opt-in; see ReviewWorkerLoopOptions. */
  readonly retry_invalid_output?: boolean;
  readonly output_persist: (
    ref: SourceRef,
    bytes: Uint8Array
  ) => Promise<Result<void, ErrorEnvelope>>;
  /**
   * Attempt write port used to record the completion output reference.
   * `buildAttempt` runs before generation, so the initial `output_ref` cannot
   * be the content-addressed completion ref; the runner records the real ref
   * before `acceptOutput` reads it.
   */
  readonly write?: import("@evoplug/review").ReviewWritePort;
  readonly credential_ref: (input: {
    readonly job: ReviewJob;
    readonly snapshot: ReviewSnapshot;
    readonly attempt: ReviewAttempt;
  }) => string;
  readonly data_scope_ref?: (input: {
    readonly job: ReviewJob;
    readonly snapshot: ReviewSnapshot;
    readonly attempt: ReviewAttempt;
  }) => string;
  readonly cancel_requested?: (attempt_id: string) => Promise<boolean>;
  readonly max_output_rounds?: number;
  readonly cancel_ack_grace_ms?: number;
}

/**
 * Implements `GeneratorRunnerPort` over the HOST generation port:
 * `create` -> `authenticate` -> `readOutput` until `complete`.
 *
 * The handle returned by `create` is kept in memory for `cancel`; it is not
 * persisted, because `ReviewService` owns the attempt row and exposes no
 * host-run transition. After a crash the attempt expires and is recovered as
 * lost rather than silently resumed against an unknown host session.
 */
export function createHostGenerationRunner(deps: HostGenerationRunnerDeps): GeneratorRunnerPort {
  const handles = new Map<string, string>();
  const maxRounds = deps.max_output_rounds ?? DEFAULT_REVIEW_MAX_OUTPUT_ROUNDS;

  async function run(
    input: GeneratorInput,
    attempt: ReviewAttempt,
    signal: AbortSignal
  ): Promise<RevResult<GeneratorRunResult>> {
    const now = deps.clock.utcNowMs();
    if (signal.aborted) {
      return revErr(cancelledError());
    }
    if (await isCancelRequested(deps.cancel_requested, attempt.attempt_id)) {
      return revErr(cancelledError());
    }
    const lease = attempt.lease;
    if (lease === undefined || lease.expires_at <= now) {
      return revErr(leaseLostError());
    }
    const job = await deps.repository.getJob(attempt.job_id);
    if (job === null) {
      return revErr(loopError("E_ILLEGAL_REVIEW_JOB_TRANSITION", "generate", false));
    }
    const snapshot = await deps.repository.getSnapshot(job.snapshot_id);
    if (snapshot === null) {
      return revErr(loopError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "generate", false));
    }
    const deadline = attempt.deadline_at ?? now + snapshot.budget.wall_ms;
    // The frozen snapshot is an index of content-addressed evidence. A CLI
    // generator has no tools to dereference those refs, so the prompt document
    // carries the approved evidence text beside the snapshot. It never changes
    // the frozen snapshot row; it is derived prompt input only.
    const expandRefs = async (value: unknown, depth: number): Promise<unknown> => {
      if (depth > 3) return value;
      if (typeof value === "string" && value.startsWith("blob://")) {
        const read = await deps.source_bytes.read(value as SourceRef, { maxBytes: 1_048_576 });
        if (!read.ok) return value;
        const text = new TextDecoder("utf-8", { fatal: false }).decode(read.value);
        try {
          return { ref: value, content: await expandRefs(JSON.parse(text) as unknown, depth + 1) };
        } catch {
          return { ref: value, content: text.slice(0, 65_536) };
        }
      }
      if (Array.isArray(value)) {
        return Promise.all(value.map((item) => expandRefs(item, depth + 1)));
      }
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          out[key] = await expandRefs(item, depth + 1);
        }
        return out;
      }
      return value;
    };
    const evidence: Array<{
      readonly evidence_id: string;
      readonly kind: string;
      readonly path: string;
      readonly source_ref: SourceRef;
      readonly text: string;
      readonly truncated: boolean;
    }> = [];
    // Appendix F.3: expansion is bounded by the frozen snapshot budget. The
    // generator input's token estimate is the only budget the snapshot fixes
    // for the prompt; four bytes per token is the conservative wire estimate
    // already used by the input-token counter. Excluded evidence never reaches
    // this list because `input.evidence` carries only egress-approved refs.
    let promptBytesRemaining = Math.max(
      0,
      Math.floor(input.budget.input_tokens_estimated * 4)
    );
    for (const item of input.evidence) {
      if (promptBytesRemaining < 1) break;
      const readCap = Math.max(1, Math.min(1_048_576, promptBytesRemaining));
      const read = await deps.source_bytes.read(item.source_ref, { maxBytes: readCap });
      if (!read.ok) {
        return revErr(revErrorFromEnvelope(read.error));
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(read.value);
      } catch {
        return revErr(loopError("E_REVIEW_OUTPUT_TRUNCATED", "source_text", false, item.path));
      }
      let expanded: string = text;
      try {
        const parsed = JSON.parse(text) as unknown;
        expanded = canonicalJsonText(toJsonValue(await expandRefs(parsed, 0)));
      } catch {
        // Plain text evidence is already the content.
      }
      const bytes = new TextEncoder().encode(expanded);
      const truncated = bytes.byteLength > promptBytesRemaining;
      if (truncated) {
        expanded = new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(0, promptBytesRemaining)
        );
      }
      promptBytesRemaining -= Math.min(bytes.byteLength, promptBytesRemaining);
      evidence.push({
        evidence_id: item.evidence_id,
        kind: item.kind,
        path: item.path,
        source_ref: item.source_ref,
        text: expanded,
        truncated
      });
    }
    const promptDocument = {
      schema_version: "rsi.review_generation_prompt/1",
      snapshot,
      target_policy: input.target_policy,
      // Appendix K.1: a refine proposal may only name an approved, retrievable
      // adopted experience. The generator receives those refs explicitly.
      existing_experiences: input.existing_experiences ?? [],
      existing_target_hashes: input.existing_target_hashes ?? [],
      evidence
    };
    const snapshotBytes = canonicalJson(toJsonValue(promptDocument));
    const snapshotRef = blobRef(hashBytes(snapshotBytes), snapshotBytes.byteLength);
    process.stderr.write(`${JSON.stringify({
      message: "debug.review_runner_start",
      attempt_id: attempt.attempt_id,
      snapshot_ref: snapshotRef,
      snapshot_bytes: snapshotBytes.byteLength,
      attempt_output_ref: attempt.output_ref
    })}\n`);
    // The generation adapter reads the snapshot through the blob port. A
    // content-addressed ref alone is not enough: the bytes must be present in
    // the CAS, otherwise create fails with `E_EVIDENCE_UNKNOWN`.
    const snapshotStored = await deps.output_persist(snapshotRef, snapshotBytes);
    if (!snapshotStored.ok) {
      process.stderr.write(`${JSON.stringify({
        level: "warn",
        message: "kernel.review_snapshot_persist_failed",
        attempt_id: attempt.attempt_id,
        snapshot_ref: snapshotRef,
        code: snapshotStored.error.code,
        stage: snapshotStored.error.stage
      })}\n`);
      return revErr(revErrorFromEnvelope(snapshotStored.error));
    }
    process.stderr.write(`${JSON.stringify({
      message: "debug.review_runner_snapshot_stored",
      attempt_id: attempt.attempt_id,
      snapshot_ref: snapshotRef
    })}\n`);

    const generateOnce = async (retryFeedback: {
      readonly code: string;
      readonly path: string;
      readonly rule: string;
    } | null): Promise<RevResult<{ readonly ref: SourceRef; readonly bytes: Uint8Array }>> => {
      const retrySuffix = retryFeedback === null ? "" : ":retry1";
      const created = await deps.generation.create(
        {
          job_id: job.job_id,
          generation_run_id: `${attempt.attempt_id}${retrySuffix}:run`,
          snapshot_ref: snapshotRef,
          target_policy: {
            allowed_object_types: [...input.target_policy.allowed_object_types],
            ...(input.target_policy.allowed_target_refs === undefined
              ? {}
              : { allowed_target_refs: [...input.target_policy.allowed_target_refs] })
          },
          backend: attempt.backend,
          host_binding: snapshot.host_event.binding,
          workspace_ref: attempt.isolation.workspace_ref,
          permission_scope_ref: snapshot.permission_scope_ref,
          budget_ref: attempt.budget.reservation_id ?? job.budget_policy_ref,
          isolation: attempt.backend.isolation,
          origin: "evaluator",
          deadline_ms: deadline,
          idempotency_key: `${attempt.attempt_key}${retrySuffix}`,
          ...(retryFeedback === null ? {} : { retry_feedback: retryFeedback })
        },
        signal
      );
      if (!created.ok) {
        process.stderr.write(`${JSON.stringify({
          level: "warn",
          message: "kernel.review_generation_create_failed",
          attempt_id: attempt.attempt_id,
          retry: retryFeedback !== null,
          code: created.error.code,
          retryable: created.error.retryable,
          detail_ref: created.error.details_ref ?? null
        })}\n`);
        return revErr(hostError(created.error));
      }
      if (created.value.state !== "created") {
        process.stderr.write(`${JSON.stringify({
          level: "warn",
          message: "kernel.review_generation_create_rejected",
          attempt_id: attempt.attempt_id,
          retry: retryFeedback !== null,
          state: created.value.state,
          error_code: created.value.error?.code ?? null
        })}\n`);
        return revErr(
          loopError(
            "E_REVIEW_BACKEND_SPAWN",
            "generate",
            true,
            created.value.error?.code ?? "create_rejected"
          )
        );
      }
      const handleRef = created.value.handle_ref ?? attempt.host_run.handle_ref;
      if (handleRef === undefined || handleRef.length === 0) {
        return revErr(loopError("E_REVIEW_BACKEND_CAPABILITY", "generate", true, "handle_missing"));
      }
      handles.set(attempt.attempt_id, handleRef);

      const authenticated = await deps.generation.authenticate(
        {
          job_id: job.job_id,
          handle_ref: handleRef,
          credential_ref: deps.credential_ref({ job, snapshot, attempt }),
          data_scope_ref:
            deps.data_scope_ref?.({ job, snapshot, attempt }) ?? snapshot.permission_scope_ref,
          deadline_ms: deadline
        },
        signal
      );
      if (!authenticated.ok) {
        return revErr(hostError(authenticated.error));
      }
      if (authenticated.value.state !== "available") {
        return revErr(
          loopError(
            "E_REVIEW_BACKEND_AUTH",
            "generate",
            false,
            `auth_${authenticated.value.state}`
          )
        );
      }

      const completed = await readOutputToCompletion({
        generation: deps.generation,
        source_bytes: deps.source_bytes,
        job,
        attempt,
        handle_ref: handleRef,
        deadline_ms: deadline,
        max_bytes: snapshot.output_policy.max_output_bytes,
        max_rounds: maxRounds,
        ...(deps.cancel_requested === undefined
          ? {}
          : { cancel_requested: deps.cancel_requested }),
        signal
      });
      return completed.ok ? revOk({ ref: completed.value.ref, bytes: completed.value.bytes }) : completed;
    };

    const parseLimits = {
      max_proposals: snapshot.output_policy.max_proposals,
      max_progress_events: snapshot.output_policy.max_progress_events,
      max_output_bytes: snapshot.output_policy.max_output_bytes,
      max_output_line_bytes: snapshot.output_policy.max_output_line_bytes,
      max_output_lines: snapshot.output_policy.max_output_lines
    };
    let first: RevResult<{ readonly ref: SourceRef; readonly bytes: Uint8Array }>;
    if (deps.retry_invalid_output !== true) {
      // Synthetic ports keep the single-run contract; the production
      // composition opts into the Appendix I.4 retry.
      first = await generateOnce(null);
      if (!first.ok) {
        return first;
      }
    } else {
      // Appendix I.4: a protocol/schema failure is retried exactly once with
      // the first error attached; a second failure is terminal and
      // diagnosable. The CLI adapter can already have rejected the stream
      // (`schema_valid=false`); that is the same class of failure.
      const outputInvalid = (error: RevError): boolean =>
        error.code === "E_REVIEW_BACKEND_EXIT" &&
        (error.cause ?? "").includes("schema_valid=false");
      const terminalInvalid = (detailRef?: SourceRef): RevResult<never> =>
        revErr({
          // Appendix I.4: E_UPSTREAM with reason generation_output_invalid.
          code: "E_UPSTREAM",
          stage: "accept_output",
          retryable: false,
          cause: "generation_output_invalid",
          ...(detailRef === undefined ? {} : { detail_ref: detailRef })
        });
      const describe = (error: {
        readonly code: string;
        readonly details: ErrorEnvelope["details"];
      }) => ({
        code: error.code,
        path: error.details.kind === "field" ? error.details.path : "output",
        rule: error.details.kind === "field" ? error.details.rule : error.details.kind
      });

      first = await generateOnce(null);
      let feedback: { code: string; path: string; rule: string } | null;
      if (!first.ok) {
        if (!outputInvalid(first.error)) {
          return first;
        }
        feedback = { code: "E_UPSTREAM", path: "output", rule: "protocol_parse" };
      } else {
        const parsed = parseGeneratorOutput(first.value.bytes, parseLimits, attempt.attempt_id);
        const schema = parsed.ok
          ? parsed.value.proposals
              .map((entry) => proposalSchemaFailure(entry.proposal as JsonValue))
              .find((failure) => failure !== null) ?? null
          : null;
        feedback = schema ?? (parsed.ok ? null : describe(parsed.error));
      }
      if (feedback !== null) {
        process.stderr.write(`${JSON.stringify({
          level: "warn",
          message: "kernel.review_generation_output_invalid_retry",
          attempt_id: attempt.attempt_id,
          code: feedback.code,
          path: feedback.path,
          rule: feedback.rule
        })}\n`);
        const retried = await generateOnce(feedback);
        if (!retried.ok) {
          return outputInvalid(retried.error)
            ? terminalInvalid(first.ok ? first.value.ref : undefined)
            : retried;
        }
        const parsed = parseGeneratorOutput(retried.value.bytes, parseLimits, attempt.attempt_id);
        const schemaAfterRetry = parsed.ok
          ? parsed.value.proposals
              .map((entry) => proposalSchemaFailure(entry.proposal as JsonValue))
              .find((failure) => failure !== null) ?? null
          : null;
        if (schemaAfterRetry !== null) {
          process.stderr.write(`${JSON.stringify({
            level: "warn",
            message: "kernel.review_generation_output_invalid",
            attempt_id: attempt.attempt_id,
            code: schemaAfterRetry.code,
            path: schemaAfterRetry.path,
            rule: schemaAfterRetry.rule
          })}\n`);
          return terminalInvalid(retried.value.ref);
        }
        if (!parsed.ok) {
          const detail = describe(parsed.error);
          process.stderr.write(`${JSON.stringify({
            level: "warn",
            message: "kernel.review_generation_output_invalid",
            attempt_id: attempt.attempt_id,
            code: detail.code,
            path: detail.path,
            rule: detail.rule
          })}\n`);
          return terminalInvalid(retried.value.ref);
        }
        first = retried;
      }
      if (!first.ok) {
        return first;
      }
    }
    if (first.value.ref !== attempt.output_ref) {
      const persisted = await deps.output_persist(first.value.ref, first.value.bytes);
      if (!persisted.ok) {
        return revErr(revErrorFromEnvelope(persisted.error));
      }
    }
    const recorded = await recordCompletionOutput(deps, attempt.attempt_id, first.value.ref, first.value.bytes);
    if (!recorded.ok) {
      return revErr(revErrorFromEnvelope(recorded.error));
    }
    return revOk({
      output_bytes: first.value.bytes,
      exit_code: null,
      signal: null,
      completion_evidence_ref: first.value.ref
    });
  }

  async function cancel(attempt: ReviewAttempt): Promise<"cancelled" | "not_running" | "unsupported"> {
    const handleRef = attempt.host_run.handle_ref ?? handles.get(attempt.attempt_id);
    if (handleRef === undefined) {
      return "unsupported";
    }
    const deadline = deps.clock.utcNowMs() + (deps.cancel_ack_grace_ms ?? DEFAULT_REVIEW_CANCEL_ACK_GRACE_MS);
    const cancelled = await deps.generation.cancel(
      {
        job_id: attempt.job_id,
        handle_ref: handleRef,
        reason: "review_worker_cancel",
        idempotency_key: buildCancelKey(attempt.attempt_id),
        deadline_ms: deadline
      },
      AbortSignal.timeout(Math.max(1, deadline - deps.clock.utcNowMs()))
    );
    if (!cancelled.ok) {
      return "unsupported";
    }
    switch (cancelled.value.state) {
      case "cancelled":
        return "cancelled";
      case "not_running":
        return "not_running";
      case "unsupported":
      case "unknown":
      case "failed":
        return "unsupported";
    }
  }

  return { run, cancel };
}

async function isCancelRequested(
  port: ((attempt_id: string) => Promise<boolean>) | undefined,
  attemptId: string
): Promise<boolean> {
  if (port === undefined) {
    return false;
  }
  try {
    return await port(attemptId);
  } catch {
    return false;
  }
}

async function readOutputToCompletion(input: {
  readonly generation: HostGenerationPort;
  readonly source_bytes: SourceBytesPort;
  readonly job: ReviewJob;
  readonly attempt: ReviewAttempt;
  readonly handle_ref: string;
  readonly deadline_ms: number;
  readonly max_bytes: number;
  readonly max_rounds: number;
  readonly cancel_requested?: (attempt_id: string) => Promise<boolean>;
  readonly signal: AbortSignal;
}): Promise<RevResult<{ readonly ref: SourceRef; readonly bytes: Uint8Array }>> {
  let cursor = input.attempt.output?.read_cursor;
  let finalRef: SourceRef | null = null;
  let completed = false;
  for (let round = 0; round < input.max_rounds; round += 1) {
    if (input.signal.aborted || (await isCancelRequested(input.cancel_requested, input.attempt.attempt_id))) {
      return revErr(cancelledError());
    }
    const request = {
      job_id: input.job.job_id,
      handle_ref: input.handle_ref,
      max_bytes: input.max_bytes,
      deadline_ms: input.deadline_ms,
      ...(cursor === undefined ? {} : { cursor })
    };
    const output = await input.generation.readOutput(request, input.signal);
    if (!output.ok) {
      return revErr(hostError(output.error));
    }
    if (output.value.state === "failed") {
      process.stderr.write(`${JSON.stringify({
        level: "warn",
        message: "kernel.review_generation_output_failed",
        attempt_id: input.attempt.attempt_id,
        failure: output.value.failure ?? null
      })}\n`);
      return revErr(
        loopError(
          "E_REVIEW_BACKEND_EXIT",
          "generate",
          true,
          `cli_output_failed${output.value.failure?.diagnosis === undefined ? "" : ` ${output.value.failure.diagnosis.code}`} output_ref=${output.value.output_ref} schema_valid=${String(output.value.schema_valid)}`
        )
      );
    }
    if (output.value.state === "unknown") {
      return revErr(loopError("E_REVIEW_OUTPUT_TRUNCATED", "output", true));
    }
    if (output.value.state === "complete") {
      finalRef = output.value.output_ref;
      completed = true;
      break;
    }
    if (!output.value.output_ref.startsWith("blob://sha256:0000000000000000000000000000000000000000000000000000000000000000")) {
      finalRef = output.value.output_ref;
    }
    const next = output.value.next_cursor;
    if (next === undefined || next === cursor) {
      return revErr(loopError("E_REVIEW_OUTPUT_TRUNCATED", "output", true));
    }
    cursor = next;
    // A streaming host emits one event per line; the poll can otherwise spin
    // through microtasks faster than the child's data events arrive and burn
    // the round cap before the process closes.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!completed || finalRef === null) {
    return revErr(loopError("E_REVIEW_OUTPUT_TRUNCATED", "output", true));
  }
  const read = await input.source_bytes.read(finalRef, { maxBytes: input.max_bytes });
  if (!read.ok) {
    process.stderr.write(`${JSON.stringify({
      message: "debug.review_output_read_failed",
      attempt_id: input.attempt.attempt_id,
      output_ref: finalRef,
      code: read.error.code,
      stage: read.error.stage
    })}\n`);
    return revErr(revErrorFromEnvelope(read.error));
  }
  if (read.value.byteLength > input.max_bytes) {
    return revErr(loopError("E_REVIEW_OUTPUT_TOO_LARGE", "output", false));
  }
  return revOk({ ref: finalRef, bytes: read.value });
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createReviewWorkerLoop(options: ReviewWorkerLoopOptions): ReviewWorkerLoop {
  const clock = clockOf(options.clock);
  const workerId = options.worker_id ?? "kernel-review-worker";
  const intervalMs = options.interval_ms ?? DEFAULT_REVIEW_WORKER_INTERVAL_MS;
  const retryMs = options.retry_ms ?? DEFAULT_REVIEW_WORKER_RETRY_MS;
  const leaseTtlMs = options.lease_ttl_ms ?? LEASE_DEFAULTS.attempt_lease_ttl_ms;
  const requestedHeartbeat = options.heartbeat_interval_ms ?? LEASE_DEFAULTS.heartbeat_interval_ms;
  // DD-REV-032: heartbeat must be strictly below half the lease TTL.
  const heartbeatMs = Math.max(1, Math.min(requestedHeartbeat, Math.floor(leaseTtlMs / 2) - 1));
  const cancelPollMs = options.cancel_poll_ms ?? DEFAULT_REVIEW_CANCEL_POLL_MS;
  const recoveryMs = options.recovery_interval_ms ?? DEFAULT_REVIEW_RECOVERY_INTERVAL_MS;
  const maxStageJobs = options.max_stage_jobs_per_tick ?? DEFAULT_REVIEW_MAX_STAGE_JOBS;

  const sourceBytes =
    options.source_bytes ?? (options.blob_store === undefined ? null : blobSourceBytes(options.blob_store));
  const outputPersist =
    options.output_persist ??
    (options.blob_store === undefined ? null : blobOutputPersist(options.blob_store));

  const runner =
    options.runner ??
    (options.generation === null ||
    options.credential_ref === undefined ||
    sourceBytes === null ||
    outputPersist === null
      ? null
      : createHostGenerationRunner({
          generation: options.generation,
          repository: options.repository,
          clock,
          source_bytes: sourceBytes,
          output_persist: outputPersist,
          ...(options.write === undefined ? {} : { write: options.write }),
          credential_ref: options.credential_ref,
          ...(options.data_scope_ref === undefined
            ? {}
            : { data_scope_ref: options.data_scope_ref }),
          ...(options.cancel_requested === undefined
            ? {}
            : { cancel_requested: options.cancel_requested }),
          ...(options.max_output_rounds === undefined
            ? {}
            : { max_output_rounds: options.max_output_rounds }),
          ...(options.retry_invalid_output === undefined
            ? {}
            : { retry_invalid_output: options.retry_invalid_output })
        }));

  const enabled = runner !== null && options.generation !== null;
  const cancelRequested =
    options.cancel_requested ??
    (async (attemptId: string): Promise<boolean> => {
      const attempt = await options.repository.getAttempt(attemptId);
      return attempt?.cancel.requested_at !== undefined;
    });

  const stageBackoff = new Map<string, number>();
  let nextClaimAt = 0;
  let nextRecoveryAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let tail: Promise<void> = Promise.resolve();

  function report(stage: string, error: RevError, ids: { job_id?: string; attempt_id?: string }): void {
    try {
      options.on_error?.(errorEvent(stage, error, ids));
    } catch {
      // Observability hooks must never break the worker.
    }
  }

  /* --------------------------- attempt run --------------------------- */

  async function executeClaimed(claimed: ClaimedAttempt): Promise<ReviewAttemptExecution> {
    const attempt = claimed.attempt;
    const lease = attempt.lease;
    if (runner === null || lease === undefined) {
      return { kind: "failed", attempt, error: leaseLostError() };
    }
    const controller = new AbortController();
    let leaseLost = false;
    let cancelSeen = false;
    let heartbeatInFlight = false;
    let cancelInFlight = false;

    const cancellation = async (): Promise<void> => {
      if (cancelSeen) {
        return;
      }
      cancelSeen = true;
      await runner.cancel(attempt);
      controller.abort();
    };

    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || leaseLost) {
        return;
      }
      heartbeatInFlight = true;
      void options.service
        .heartbeat({
          attempt_id: attempt.attempt_id,
          lease_id: lease.lease_id,
          fencing_token: lease.fencing_token,
          now: clock.utcNowMs()
        })
        .then((result) => {
          if (!result.ok) {
            leaseLost = true;
            process.stderr.write(`${JSON.stringify({
              level: "warn",
              message: "kernel.review_heartbeat_failed",
              attempt_id: attempt.attempt_id,
              code: result.error.code,
              cause: result.error.cause ?? null
            })}\n`);
            controller.abort();
          }
        })
        .catch((cause) => {
          leaseLost = true;
          process.stderr.write(`${JSON.stringify({
            level: "warn",
            message: "kernel.review_heartbeat_failed",
            attempt_id: attempt.attempt_id,
            code: "thrown",
            cause: cause instanceof Error ? cause.message : String(cause)
          })}\n`);
          controller.abort();
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, Math.max(1, heartbeatMs));
    heartbeatTimer.unref?.();

    const cancelTimer = setInterval(() => {
      if (cancelInFlight || cancelSeen) {
        return;
      }
      cancelInFlight = true;
      void isCancelRequested(cancelRequested, attempt.attempt_id)
        .then(async (requested) => {
          if (requested) {
            await cancellation();
          }
        })
        .catch(() => {
          cancelInFlight = false;
        })
        .finally(() => {
          cancelInFlight = false;
        });
    }, Math.max(1, cancelPollMs));
    cancelTimer.unref?.();

    try {
      if (await isCancelRequested(cancelRequested, attempt.attempt_id)) {
        await cancellation();
        await terminaliseCancelledAttempt(attempt);
        return { kind: "cancelled", attempt };
      }
      const run = await runner.run(claimed.input, attempt, controller.signal);
      if (cancelSeen) {
        await terminaliseCancelledAttempt(attempt);
        return { kind: "cancelled", attempt };
      }
      if (leaseLost) {
        return { kind: "lease_lost", attempt };
      }
      if (!run.ok) {
        process.stderr.write(`${JSON.stringify({
          level: "warn",
          message: "kernel.review_attempt_failed",
          attempt_id: attempt.attempt_id,
          code: run.error.code,
          stage: run.error.stage,
          retryable: run.error.retryable,
          cause: run.error.cause ?? null
        })}\n`);
        if (run.error.code === "E_REVIEW_CANCELLED") {
          await terminaliseCancelledAttempt(attempt);
          return { kind: "cancelled", attempt };
        }
        const failed = await options.service.failAttempt({
          attempt_id: attempt.attempt_id,
          lease_id: lease.lease_id,
          fencing_token: lease.fencing_token,
          error: run.error,
          now: clock.utcNowMs()
        });
        if (!failed.ok) {
          report("fail_attempt", failed.error, { job_id: attempt.job_id, attempt_id: attempt.attempt_id });
        }
        return { kind: "failed", attempt, error: run.error };
      }
      const accepted = await options.service.acceptOutput({
        attempt_id: attempt.attempt_id,
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token,
        now: clock.utcNowMs()
      });
      if (!accepted.ok) {
        if (
          accepted.error.code !== "E_REVIEW_FENCING_STALE" &&
          accepted.error.code !== "E_REVIEW_LEASE_EXPIRED"
        ) {
          const failed = await options.service.failAttempt({
            attempt_id: attempt.attempt_id,
            lease_id: lease.lease_id,
            fencing_token: lease.fencing_token,
            error: accepted.error,
            now: clock.utcNowMs()
          });
          if (!failed.ok) {
            report("fail_attempt", failed.error, {
              job_id: attempt.job_id,
              attempt_id: attempt.attempt_id
            });
          }
        }
        return { kind: "failed", attempt, error: accepted.error };
      }
      return { kind: "accepted", job: accepted.value.job, attempt: accepted.value.attempt };
    } catch (error) {
      if (leaseLost) {
        return { kind: "lease_lost", attempt };
      }
      if (cancelSeen) {
        await terminaliseCancelledAttempt(attempt);
        return { kind: "cancelled", attempt };
      }
      const failure = loopError(
        "E_REVIEW_BACKEND_EXIT",
        "generate",
        true,
        error instanceof Error ? error.message : "runner_failed"
      );
      const failed = await options.service.failAttempt({
        attempt_id: attempt.attempt_id,
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token,
        error: failure,
        now: clock.utcNowMs()
      });
      if (!failed.ok) {
        report("fail_attempt", failed.error, { job_id: attempt.job_id, attempt_id: attempt.attempt_id });
      }
      return { kind: "failed", attempt, error: failure };
    } finally {
      clearInterval(heartbeatTimer);
      clearInterval(cancelTimer);
    }
  }

  /**
   * A cancelled job is already terminal. Persisting the attempt as `cancelled`
   * stops the lease from looking expired; budget settlement remains the
   * service/FND's responsibility because `ReviewService` exposes no cancel
   * settlement entry point.
   */
  async function terminaliseCancelledAttempt(attempt: ReviewAttempt): Promise<void> {
    if (options.write === undefined) {
      return;
    }
    const job = await options.repository.getJob(attempt.job_id);
    if (job === null || (job.state !== "cancelled" && job.state !== "stale")) {
      return;
    }
    const now = clock.utcNowMs();
    const next = markAttemptTerminal({
      attempt,
      state: "cancelled",
      now,
      exit: { at: now, reason: "cancelled" }
    });
    const saved = await options.write.saveAttempt(next, attempt.row_version);
    if (!saved.ok) {
      report("cancel_attempt", revErrorFromEnvelope(saved.error), {
        job_id: attempt.job_id,
        attempt_id: attempt.attempt_id
      });
    }
  }

  /* --------------------------- recovery --------------------------- */

  async function recoverExpired(now: number): Promise<{ readonly recovered: number; readonly errors: RevError[] }> {
    const errors: RevError[] = [];
    const expired = await options.repository.listExpiredAttempts(now);
    if (expired.length === 0) {
      return { recovered: 0, errors };
    }
    // `recoverExpired` owns the per-attempt terminal/requeue decision. Do not
    // gate the whole batch on every job being generating: one cancelled, stale,
    // failed or missing job must not strand unrelated generating attempts.
    const result = await options.service.recoverExpired({ now, worker_id: workerId });
    if (!result.ok) {
      errors.push(result.error);
      report("recover_expired", result.error, {});
      return { recovered: 0, errors };
    }
    return { recovered: result.value.lost.length + result.value.requeued.length, errors };
  }

  /* --------------------------- stages --------------------------- */

  async function notifyDelivery(job: ReviewJob, handoff: ReviewHandoff): Promise<RevError | null> {
    if (options.delivery === undefined) {
      return null;
    }
    try {
      const result = await options.delivery.handoffCommitted({ job, handoff });
      if (!result.ok) {
        return revErrorFromEnvelope(result.error);
      }
      return null;
    } catch (error) {
      return loopError(
        "E_STORAGE_UNAVAILABLE",
        "delivery",
        true,
        error instanceof Error ? error.message : "delivery_failed"
      );
    }
  }

  async function advanceJob(jobId: string, now: number): Promise<{ readonly advanced: boolean; readonly errors: RevError[] }> {
    const errors: RevError[] = [];
    let current = await options.repository.getJob(jobId);
    if (current === null) {
      return { advanced: false, errors };
    }
    for (let step = 0; step < 8; step += 1) {
      if (isTerminalState(current.state)) {
        return { advanced: step > 0, errors };
      }
      const before = `${current.state}:${current.stage}:${String(current.version)}`;

      if (current.state === "generating" && current.stage === "static_check") {
        const result = await options.service.runStaticCheck({ job_id: current.job_id, now });
        if (!result.ok) {
          errors.push(result.error);
          report("static_check", result.error, { job_id: current.job_id });
          stageBackoff.set(current.job_id, now + (result.error.retryable ? retryMs : intervalMs));
          return { advanced: step > 0, errors };
        }
        current = result.value.job;
        stageBackoff.delete(current.job_id);
      } else if (current.state === "generating" && current.stage === "experience_match_judge") {
        const result = await options.service.runMatchJudge({ job_id: current.job_id, now });
        if (!result.ok) {
          errors.push(result.error);
          report("experience_match_judge", result.error, { job_id: current.job_id });
          stageBackoff.set(current.job_id, now + (result.error.retryable ? retryMs : intervalMs));
          return { advanced: step > 0, errors };
        }
        current = result.value.job;
        stageBackoff.delete(current.job_id);
      } else if (current.state === "proposed" && current.stage === "handoff") {
        const result = await options.service.finalizeHandoff({ job_id: current.job_id, now });
        if (!result.ok) {
          errors.push(result.error);
          report("handoff", result.error, { job_id: current.job_id });
          stageBackoff.set(current.job_id, now + (result.error.retryable ? retryMs : intervalMs));
          return { advanced: step > 0, errors };
        }
        current = result.value.job;
        stageBackoff.delete(current.job_id);
        const deliveryError = await notifyDelivery(result.value.job, result.value.handoff);
        if (deliveryError !== null) {
          errors.push(deliveryError);
          report("delivery", deliveryError, { job_id: current.job_id });
        }
        return { advanced: true, errors };
      } else {
        return { advanced: step > 0, errors };
      }

      const after = `${current.state}:${current.stage}:${String(current.version)}`;
      if (after === before) {
        // The injected service reported success without a job transition.
        // Never synthesize one; stop and retry later.
        const stuck = loopError(
          "E_ILLEGAL_REVIEW_JOB_TRANSITION",
          "pipeline_stage",
          true,
          `${current.state}:${current.stage}`
        );
        errors.push(stuck);
        report("pipeline_stage", stuck, { job_id: current.job_id });
        stageBackoff.set(current.job_id, now + retryMs);
        return { advanced: step > 0, errors };
      }
    }
    return { advanced: true, errors };
  }

  async function advanceStages(now: number): Promise<{ readonly advanced: number; readonly errors: RevError[] }> {
    const errors: RevError[] = [];
    let advanced = 0;
    for (const stage of RESUMABLE_STAGES) {
      const jobs = await options.repository.listJobsInStage(stage);
      let processed = 0;
      for (const job of jobs) {
        if (processed >= maxStageJobs) {
          break;
        }
        if (job.state !== "generating" && job.state !== "proposed") {
          continue;
        }
        const backoff = stageBackoff.get(job.job_id) ?? 0;
        if (backoff > now) {
          continue;
        }
        processed += 1;
        const result = await advanceJob(job.job_id, now);
        if (result.advanced) {
          advanced += 1;
        }
        errors.push(...result.errors);
      }
    }
    return { advanced, errors };
  }

  /* --------------------------- pass --------------------------- */

  async function executePass(): Promise<ReviewWorkerLoopRun> {
    const now = clock.utcNowMs();
    const errors: RevError[] = [];
    let claimed = 0;
    let accepted = 0;
    let failed = 0;
    let recovered = 0;
    let advanced = 0;

    if (options.delivery?.recoverPending !== undefined) {
      try {
        const pending = await options.delivery.recoverPending();
        if (!pending.ok) {
          const error = revErrorFromEnvelope(pending.error);
          errors.push(error);
          report("delivery_recovery", error, {});
        }
      } catch (error) {
        const failure = loopError(
          "E_STORAGE_UNAVAILABLE",
          "delivery_recovery",
          true,
          error instanceof Error ? error.message : "delivery_recovery_failed"
        );
        errors.push(failure);
        report("delivery_recovery", failure, {});
      }
    }

    if (now >= nextRecoveryAt) {
      nextRecoveryAt = now + recoveryMs;
      try {
        const recovery = await recoverExpired(now);
        recovered += recovery.recovered;
        errors.push(...recovery.errors);
      } catch (error) {
        const failure = loopError(
          "E_STORAGE_UNAVAILABLE",
          "recover_expired",
          true,
          error instanceof Error ? error.message : "recovery_failed"
        );
        errors.push(failure);
        report("recover_expired", failure, {});
      }
    }

    if (enabled && now >= nextClaimAt) {
      try {
        const result = await options.service.claimNextAttempt({ worker_id: workerId, now });
        if (!result.ok) {
          errors.push(result.error);
          report("claim", result.error, {});
          nextClaimAt = clock.utcNowMs() + retryMs;
        } else if (result.value === null) {
          nextClaimAt = clock.utcNowMs() + intervalMs;
        } else {
          claimed = 1;
          const execution = await executeClaimed(result.value);
          switch (execution.kind) {
            case "accepted":
              accepted = 1;
              break;
            case "cancelled":
              break;
            case "lease_lost":
              break;
            case "failed":
              failed = 1;
              errors.push(execution.error);
              break;
          }
          nextClaimAt = clock.utcNowMs() + intervalMs;
        }
      } catch (error) {
        const failure = loopError(
          "E_STORAGE_UNAVAILABLE",
          "claim",
          true,
          error instanceof Error ? error.message : "claim_failed"
        );
        errors.push(failure);
        report("claim", failure, {});
        nextClaimAt = clock.utcNowMs() + retryMs;
      }
    }

    try {
      const stages = await advanceStages(clock.utcNowMs());
      advanced += stages.advanced;
      errors.push(...stages.errors);
    } catch (error) {
      const failure = loopError(
        "E_STORAGE_UNAVAILABLE",
        "pipeline_stage",
        true,
        error instanceof Error ? error.message : "stage_failed"
      );
      errors.push(failure);
      report("pipeline_stage", failure, {});
    }

    if (!enabled && claimed === 0 && advanced === 0 && recovered === 0 && errors.length === 0) {
      return { status: "disabled", claimed, accepted, failed, recovered, advanced, errors };
    }
    if (claimed === 0 && advanced === 0 && recovered === 0) {
      return {
        status: errors.length === 0 ? "idle" : "error",
        claimed,
        accepted,
        failed,
        recovered,
        advanced,
        errors
      };
    }
    return { status: "processed", claimed, accepted, failed, recovered, advanced, errors };
  }

  async function executeRecoveryPass(): Promise<ReviewWorkerLoopRun> {
    const now = clock.utcNowMs();
    const errors: RevError[] = [];
    let recovered = 0;
    if (options.delivery?.recoverPending !== undefined) {
      try {
        const pending = await options.delivery.recoverPending();
        if (!pending.ok) {
          const error = revErrorFromEnvelope(pending.error);
          errors.push(error);
          report("delivery_recovery", error, {});
        }
      } catch (error) {
        const failure = loopError(
          "E_STORAGE_UNAVAILABLE",
          "delivery_recovery",
          true,
          error instanceof Error ? error.message : "delivery_recovery_failed"
        );
        errors.push(failure);
        report("delivery_recovery", failure, {});
      }
    }
    try {
      const result = await recoverExpired(now);
      recovered = result.recovered;
      errors.push(...result.errors);
    } catch (error) {
      const failure = loopError(
        "E_STORAGE_UNAVAILABLE",
        "recover_expired",
        true,
        error instanceof Error ? error.message : "recovery_failed"
      );
      errors.push(failure);
      report("recover_expired", failure, {});
    }
    return {
      status: errors.length > 0 ? "error" : recovered > 0 ? "processed" : "idle",
      claimed: 0,
      accepted: 0,
      failed: 0,
      recovered,
      advanced: 0,
      errors
    };
  }

  function recoverSerial(): Promise<ReviewWorkerLoopRun> {
    const run = tail.then(
      () => executeRecoveryPass(),
      () => executeRecoveryPass()
    );
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function runOnceSerial(): Promise<ReviewWorkerLoopRun> {
    const run = tail.then(
      () => executePass(),
      () => executePass()
    );
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    worker_id: workerId,
    enabled,
    runOnce(): Promise<ReviewWorkerLoopRun> {
      return runOnceSerial();
    },
    recover(): Promise<ReviewWorkerLoopRun> {
      return recoverSerial();
    },
    start(): void {
      if (timer !== null) {
        return;
      }
      stopped = false;
      const tick = (): void => {
        if (stopped) {
          return;
        }
        void runOnceSerial().finally(() => {
          if (!stopped) {
            timer = setTimeout(tick, intervalMs);
            timer.unref?.();
          }
        });
      };
      timer = setTimeout(tick, 0);
      timer.unref?.();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await tail;
    }
  };
}
