/**
 * Runtime delivery bridge (DD-HOST-203).
 *
 * The outbox worker owns delivery state, but a HOST that is driven through the
 * resident runtime only accepts work over `host.runtime.poll`. This module is
 * the missing producer/consumer pair between those two worlds:
 *
 * - `delivery_port` implements `OutboxDeliveryPort`. It resolves the pending
 *   delivery binding that the trigger admission wrote, inserts one
 *   `host_runtime_call{kind:"deliver"}` row (call id = delivery id, so the
 *   unique `(kind, object_ref)` index enforces at-most-once), waits for the
 *   runtime result and maps it back to `HostAdapterResult`.
 * - `call_resolver` implements `HostRuntimeCallResolverPort`. It reads the
 *   persisted pending entry, the bound trigger event binding and the delivery
 *   content, and returns the `RuntimeCall` the runtime may claim.
 * - `observe_result` must wrap `host.runtime.result`. The runtime result bodies
 *   are deliberately not persisted (`result_ref = NULL`), so the bridge
 *   captures the accepted body in-process and applies the DD-HOST-203
 *   self-attestation cap before the outbox projects it.
 *
 * Fail-closed rules: every missing binding (no pending row, no applied runtime
 * session, no trigger host binding, unreadable content) returns a concrete
 * adapter error instead of constructing a request from guesses. A call that
 * was issued but produced no observable result becomes `E_EVIDENCE_UNKNOWN`
 * and is never retried automatically.
 */

import type {
  ErrorEnvelope,
  Hash,
  Id,
  Result,
  SourceRef
} from "@evoplug/core";
import { isHash, makeErrorEnvelope } from "@evoplug/core";
import type {
  HostAdapterError,
  HostAdapterResult,
  DeliveryPending,
  HostDeliveryResult,
  HostEventBinding,
  HostRuntimeResultRequest,
  RuntimeCall,
  RuntimeCallResult
} from "@evoplug/core/host";
import { makeHostAdapterError, validatePendingEntry } from "@evoplug/core/host";
import type { BlobStore, SqlRow, SqliteConnection } from "@evoplug/storage";

import type { HostRuntimeCallResolverPort } from "./host-runtime.js";
import type { OutboxDeliveryPort, OutboxDeliveryDispatchRequest } from "./outbox-worker.js";

interface RuntimeDeliveryBridgeDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: Pick<BlobStore, "read">;
  readonly now?: () => number;
  /** Defaults to the host runtime delivery cap (4000 characters). */
  readonly delivery_max_chars?: number;
  /** Wait loop granularity; defaults to 25 ms. */
  readonly poll_interval_ms?: number;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}

/** One `host_runtime_call` row to insert, independent of its kind. */
interface RuntimeCallInsert {
  readonly call_id: string;
  readonly kind: "deliver" | "check_load" | "probe";
  readonly object_ref: string;
  readonly registration_hash: Hash;
  readonly artifact_hash: Hash;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly native_session_id: string | null;
  readonly hook_event: string | null;
  readonly boundary_event_key: Hash | null;
  readonly goal_version: string | null;
  readonly config_version: string | null;
  readonly input_epoch: number | null;
  readonly deadline_at: number;
}

/**
 * Inserts one pending call. `(kind, object_ref)` is unique, so a producer can
 * retry freely: the conflict clause makes the insert idempotent instead of
 * overwriting an already-issued call. Returns `true` only when a row was
 * actually inserted.
 */
export function insertRuntimeCall(
  connection: SqliteConnection,
  input: RuntimeCallInsert,
  now: number
): boolean {
  const outcome = connection
    .prepare(
      `INSERT INTO host_runtime_call (
         call_id, kind, registration_hash, artifact_hash, host_id, mode, config_space,
         native_session_id, hook_event, boundary_event_key, goal_version, config_version,
         input_epoch, object_ref, deadline_at, state, issued_session_id, issued_at,
         result_hash, result_ref, created_at, updated_at
       ) SELECT
         :call_id, :kind, :registration_hash, :artifact_hash, :host_id, :mode, :config_space,
         :native_session_id, :hook_event, :boundary_event_key, :goal_version, :config_version,
         :input_epoch, :object_ref, :deadline_at, 'pending', NULL, NULL,
         NULL, NULL, :now, :now
       WHERE NOT EXISTS (
         SELECT 1 FROM host_runtime_call WHERE kind = :kind AND object_ref = :object_ref
       )`
    )
    .run({
      call_id: input.call_id,
      kind: input.kind,
      registration_hash: input.registration_hash,
      artifact_hash: input.artifact_hash,
      host_id: input.host_id,
      mode: input.mode,
      config_space: input.config_space,
      native_session_id: input.native_session_id,
      hook_event: input.hook_event,
      boundary_event_key: input.boundary_event_key,
      goal_version: input.goal_version,
      config_version: input.config_version,
      input_epoch: input.input_epoch,
      object_ref: input.object_ref,
      deadline_at: input.deadline_at,
      now
    });
  return outcome.changes === 1;
}

/**
 * Reads the trigger event bound to one event identity key and returns its
 * validated `host_binding`. Probe/check-load producers use this instead of
 * inventing a boundary: a probe call stays unarmed until the runtime polls with
 * a real receipt key, and the request is built from that trigger's binding.
 */
export function readTriggerHostBinding(
  connection: SqliteConnection,
  eventIdentityKey: Hash
): HostEventBinding | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT d.canonical_json
         FROM trigger_event t
         JOIN object_head h
           ON h.object_id = t.trigger_event_id
          AND h.owner = 'host'
          AND h.object_type = 'trigger_event'
         JOIN object_document d ON d.document_id = h.document_id
        WHERE t.boundary_key = :event_identity_key
        ORDER BY t.decided_at DESC, t.trigger_event_id DESC
        LIMIT 1`
    )
    .get({ event_identity_key: eventIdentityKey });
  if (row === undefined) {
    return null;
  }
  const document = parseJsonObject(String(row["canonical_json"]));
  if (document === null) {
    return null;
  }
  const binding = document["host_binding"];
  if (!isHostEventBinding(binding)) {
    return null;
  }
  if (binding.event_identity_key !== eventIdentityKey) {
    return null;
  }
  return binding;
}

/**
 * Routes a claimed call to the resolver that owns its kind. The delivery
 * bridge answers `deliver`; the W1 probe producer answers `probe` and
 * `check_load`. A missing branch returns `null`, which the runtime records as
 * `expired` instead of guessing a request.
 */
export function createRuntimeCallResolverRouter(input: {
  readonly delivery?: HostRuntimeCallResolverPort;
  readonly probe?: HostRuntimeCallResolverPort;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}): HostRuntimeCallResolverPort {
  return {
    async resolve(request) {
      if (request.row.kind === "deliver") {
        if (input.delivery === undefined) {
          return { ok: true, status: "ok", value: null };
        }
        return input.delivery.resolve(request);
      }
      if (input.probe === undefined) {
        input.on_diagnostic?.("runtime_call_resolver.probe_unavailable");
        return { ok: true, status: "ok", value: null };
      }
      return input.probe.resolve(request);
    }
  };
}

export interface RuntimeDeliveryBridge {
  readonly call_resolver: HostRuntimeCallResolverPort;
  readonly delivery_port: OutboxDeliveryPort;
  /** Records an accepted `host.runtime.result` body for the waiting outbox. */
  observe_result(request: HostRuntimeResultRequest): void;
  /**
   * Drops captured bodies and stops accepting new deliveries. `close` is
   * idempotent. In-flight waits are woken immediately: the bridge withdraws a
   * call that was never claimed (`pending` -> `expired`, reported as
   * `E_CANCELLED`) and reports a claimed call as `E_EVIDENCE_UNKNOWN` because
   * the HOST may already have applied it. Neither outcome is replayed
   * automatically.
   */
  close(): void;
}

const RESULT_RETENTION_MS = 5 * 60_000;

interface PendingBinding {
  readonly pending: DeliveryPending;
  readonly binding: HostEventBinding;
  readonly session: RuntimeSessionRow;
}

interface RuntimeSessionRow extends SqlRow {
  readonly session_id: string;
  readonly session_nonce: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly registration_hash: string;
  readonly artifact_hash: string;
  readonly native_session_id: string | null;
  readonly state: string;
  readonly lease_expires_at: number;
}

interface CallRow extends SqlRow {
  readonly call_id: string;
  readonly kind: string;
  readonly state: string;
  readonly deadline_at: number;
}

interface CapturedResult {
  readonly at: number;
  readonly result: RuntimeCallResult;
}

type DeliveryOutcome =
  | { readonly kind: "result"; readonly value: HostDeliveryResult }
  | { readonly kind: "error"; readonly error: HostAdapterError };

function bridgeError(
  code: "E_CAPABILITY" | "E_SCHEMA" | "E_EVIDENCE_UNKNOWN" | "E_CONFLICT",
  stage: string,
  retryable: boolean
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: code === "E_EVIDENCE_UNKNOWN" ? "source" : code === "E_CONFLICT" ? "conflict" : "schema",
    message_key: `error.${code.toLowerCase()}`,
    stage,
    retryable,
    details: { kind: "none" }
  });
}

function adapterFailure(
  code: HostAdapterError["code"],
  retryable: boolean,
  detailRef: SourceRef,
  now: number
): HostAdapterError {
  return makeHostAdapterError({ code, retryable, detail_ref: detailRef, observed_at: now });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isHostEventBinding(value: unknown): value is HostEventBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["host_id"] === "string" &&
    record["host_id"] !== "" &&
    typeof record["host_version"] === "string" &&
    typeof record["adapter_id"] === "string" &&
    typeof record["adapter_version"] === "string" &&
    typeof record["implementation_hash"] === "string" &&
    isHash(record["implementation_hash"]) &&
    typeof record["mode"] === "string" &&
    typeof record["config_space"] === "string" &&
    typeof record["host_event"] === "string" &&
    record["host_event"] !== "" &&
    typeof record["stream_id"] === "string" &&
    isHash(record["stream_id"]) &&
    typeof record["receipt_seq"] === "number" &&
    typeof record["event_identity_key"] === "string" &&
    isHash(record["event_identity_key"]) &&
    (record["native_session_id"] === undefined || typeof record["native_session_id"] === "string") &&
    typeof record["received_at"] === "number"
  );
}

/**
 * DD-HOST-203 self-attestation cap: a resident runtime can claim at most
 * `provider_payload` inclusion. Anything above it (transport body or a
 * host-confirmed claim) is downgraded and marked degraded. The runtime service
 * applies its own weaker cap at persistence time; the bridge applies the full
 * contract before the outbox sees the result.
 */
function capDeliveryResult(result: HostDeliveryResult): HostDeliveryResult {
  let degraded = result.degraded;
  let level = result.inclusion.level;
  if (level !== "unknown" && level !== "context_projection" && level !== "provider_payload") {
    level = "provider_payload";
    degraded = true;
  }
  return { ...result, inclusion: { ...result.inclusion, level }, degraded };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function createRuntimeDeliveryBridge(deps: RuntimeDeliveryBridgeDeps): RuntimeDeliveryBridge {
  const now = deps.now ?? ((): number => Date.now());
  const pollInterval = Math.max(1, deps.poll_interval_ms ?? 25);
  const captured = new Map<string, CapturedResult>();
  const closeCancellation = new AbortController();
  let closed = false;

  function diagnostic(message: string, error?: ErrorEnvelope): void {
    deps.on_diagnostic?.(message, error);
  }

  function readSessionRow(row: SqlRow): RuntimeSessionRow {
    return {
      ...row,
      session_id: String(row["session_id"]),
      session_nonce: String(row["session_nonce"]),
      host_id: String(row["host_id"]),
      mode: String(row["mode"]),
      config_space: String(row["config_space"]),
      registration_hash: String(row["registration_hash"]),
      artifact_hash: String(row["artifact_hash"]),
      native_session_id:
        row["native_session_id"] === null ? null : String(row["native_session_id"]),
      state: String(row["state"]),
      lease_expires_at: Number(row["lease_expires_at"])
    };
  }

  function registrationApplied(registrationHash: string): boolean {
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT state FROM adapter_registration WHERE registration_hash = :registration_hash`
      )
      .get({ registration_hash: registrationHash });
    return row !== undefined && String(row["state"]) === "applied";
  }

  /**
   * Picks a runtime session that can actually claim the call. Precedence:
   * explicit runtime session id, explicit native session id, the trigger's
   * native session, then a resident session (native_session_id IS NULL) for
   * the same binding.
   */
  function pickSession(input: {
    readonly host_id: string;
    readonly mode: string;
    readonly config_space: string;
    readonly session_ref: string;
    readonly native_session_id: string;
  }): RuntimeSessionRow | null {
    const rows = deps.connection
      .prepare<SqlRow>(
        `SELECT * FROM host_runtime_session
          WHERE state = 'ready' AND lease_expires_at > :now
            AND host_id = :host_id AND mode = :mode AND config_space = :config_space
          ORDER BY last_seen_at DESC`
      )
      .all({
        now: now(),
        host_id: input.host_id,
        mode: input.mode,
        config_space: input.config_space
      })
      .map(readSessionRow)
      .filter(
        (row) =>
          registrationApplied(row.registration_hash) &&
          (row.native_session_id === null || row.native_session_id === input.native_session_id)
      );
    const byId = rows.find((row) => row.session_id === input.session_ref);
    if (byId !== undefined) return byId;
    const byNativeRef = rows.find((row) => row.native_session_id === input.session_ref);
    if (byNativeRef !== undefined) return byNativeRef;
    const byTriggerNative = rows.find((row) => row.native_session_id === input.native_session_id);
    if (byTriggerNative !== undefined) return byTriggerNative;
    return rows.find((row) => row.native_session_id === null) ?? null;
  }

  function loadBinding(deliveryId: string): Result<PendingBinding, ErrorEnvelope> {
    const pendingRow = deps.connection
      .prepare<SqlRow>(
        `SELECT d.canonical_json
           FROM pending_entry p
           JOIN object_head h
             ON h.object_id = p.pending_id
            AND h.owner = 'host'
            AND h.object_type = 'pending_entry'
           JOIN object_document d ON d.document_id = h.document_id
          WHERE p.kind = 'delivery'
            AND p.pending_state = 'pending'
            AND json_extract(d.canonical_json, '$.delivery_id') = :delivery_id
          ORDER BY p.updated_at DESC
          LIMIT 1`
      )
      .get({ delivery_id: deliveryId });
    if (pendingRow === undefined) {
      return {
        ok: false,
        status: "rejected",
        error: bridgeError("E_CAPABILITY", "runtime_delivery.pending", true)
      };
    }
    const document = parseJsonObject(String(pendingRow["canonical_json"]));
    if (document === null) {
      return {
        ok: false,
        status: "rejected",
        error: bridgeError("E_SCHEMA", "runtime_delivery.pending_document", false)
      };
    }
    const validated = validatePendingEntry(document);
    if (!validated.ok || validated.value.kind !== "delivery") {
      return {
        ok: false,
        status: "rejected",
        error: bridgeError("E_SCHEMA", "runtime_delivery.pending_shape", false)
      };
    }
    const pending = validated.value;
    if (pending.delivery_id !== deliveryId) {
      return {
        ok: false,
        status: "rejected",
        error: bridgeError("E_CONFLICT", "runtime_delivery.pending_binding", false)
      };
    }
    if (pending.trigger_event_id === undefined) {
      // The call boundary and hook event are read from the bound trigger.
      // Without it there is no honest way to pick a boundary the runtime will
      // poll, so this fails closed instead of inventing one.
      return {
        ok: false,
        status: "rejected",
        error: bridgeError("E_CAPABILITY", "runtime_delivery.trigger_binding", true)
      };
    }
    const triggerRow = deps.connection
      .prepare<SqlRow>(
        `SELECT d.canonical_json
           FROM trigger_event t
           JOIN object_head h
             ON h.object_id = t.trigger_event_id
            AND h.owner = 'host'
            AND h.object_type = 'trigger_event'
           JOIN object_document d ON d.document_id = h.document_id
          WHERE t.trigger_event_id = :trigger_event_id`
      )
      .get({ trigger_event_id: pending.trigger_event_id });
    const triggerDocument =
      triggerRow === undefined ? null : parseJsonObject(String(triggerRow["canonical_json"]));
    const binding = triggerDocument === null ? null : triggerDocument["host_binding"];
    if (!isHostEventBinding(binding)) {
      return {
        ok: false,
        status: "rejected",
        error: bridgeError("E_CAPABILITY", "runtime_delivery.host_binding", true)
      };
    }
    if (
      binding.native_session_id === undefined ||
      binding.native_session_id === "" ||
      binding.host_id !== pending.host_id ||
      binding.mode !== pending.mode ||
      binding.config_space !== pending.config_space
    ) {
      return {
        ok: false,
        status: "rejected",
        error: bridgeError("E_CONFLICT", "runtime_delivery.host_binding_binding", false)
      };
    }
    const session = pickSession({
      host_id: pending.host_id,
      mode: pending.mode,
      config_space: pending.config_space,
      session_ref: pending.session_ref,
      native_session_id: binding.native_session_id
    });
    if (session === null) {
      return {
        ok: false,
        status: "degraded",
        error: bridgeError("E_CAPABILITY", "runtime_delivery.session", true)
      };
    }
    return {
      ok: true,
      status: "ok",
      value: { pending, binding, session }
    };
  }

  function readDelivery(deliveryId: string): SqlRow | null {
    return (
      deps.connection
        .prepare<SqlRow>(
          `SELECT delivery_id, task_id, branch_id, input_epoch, goal_version,
                  config_version, content_ref, content_hash, state, expires_at
             FROM delivery WHERE delivery_id = :delivery_id`
        )
        .get({ delivery_id: deliveryId }) ?? null
    );
  }

  function idempotencyKeyFor(deliveryId: string): string {
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT o.effect_key
           FROM outbox o
          WHERE o.effect_kind = 'delivery.dispatch'
            AND o.effect_key LIKE 'delivery.dispatch:' || :delivery_id || ':%'
          ORDER BY o.created_at DESC
          LIMIT 1`
      )
      .get({ delivery_id: deliveryId });
    if (row !== undefined) {
      return String(row["effect_key"]);
    }
    return `delivery.dispatch:${deliveryId}:1`;
  }

  function readCall(callId: string): CallRow | null {
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT call_id, kind, state, deadline_at FROM host_runtime_call WHERE call_id = :call_id`
      )
      .get({ call_id: callId });
    if (row === undefined) {
      return null;
    }
    return {
      ...row,
      call_id: String(row["call_id"]),
      kind: String(row["kind"]),
      state: String(row["state"]),
      deadline_at: Number(row["deadline_at"])
    };
  }

  /**
   * Resolves a cancellation against the durable claim state instead of assuming
   * the runtime never received the call. A `pending` row is withdrawn
   * atomically (`pending` -> `expired`, the same safe-to-rearm state the
   * deadline path uses) and reported as `E_CANCELLED`. Once the runtime has
   * claimed the row (`issued`/`completed`/`uncertain`), the external effect may
   * already exist, so the only honest answer is `E_EVIDENCE_UNKNOWN`; the
   * outbox projects that as uncertain and never replays it automatically.
   */
  function cancellationError(callId: string, detailRef: SourceRef): HostAdapterError {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const withdrawn = deps.connection
        .prepare(
          `UPDATE host_runtime_call SET state = 'expired', updated_at = :now
            WHERE call_id = :call_id AND state = 'pending'`
        )
        .run({ call_id: callId, now: now() });
      if (withdrawn.changes === 1) {
        return adapterFailure("E_CANCELLED", false, detailRef, now());
      }
    }
    const row = readCall(callId);
    if (row === null || row.state === "pending" || row.state === "expired") {
      return adapterFailure("E_CANCELLED", false, detailRef, now());
    }
    return adapterFailure("E_EVIDENCE_UNKNOWN", false, detailRef, now());
  }

  /**
   * Inserts the pending call. An `expired` row was never issued, so a later
   * outbox attempt may safely re-arm it. `completed`/`uncertain`/`issued` are
   * never re-armed: at-most-once wins over retry.
   */
  function ensureCall(input: {
    readonly request: OutboxDeliveryDispatchRequest;
    readonly pending: DeliveryPending;
    readonly binding: HostEventBinding;
    readonly session: RuntimeSessionRow;
    readonly deadline: number;
  }): Result<"created" | "rearmed" | "existing", ErrorEnvelope> {
    const existing = readCall(input.request.delivery_id);
    if (existing !== null) {
      if (existing.state === "expired") {
        deps.connection
          .prepare(
            `UPDATE host_runtime_call SET
               registration_hash = :registration_hash,
               artifact_hash = :artifact_hash,
               host_id = :host_id, mode = :mode, config_space = :config_space,
               native_session_id = :native_session_id,
               hook_event = :hook_event, boundary_event_key = :boundary_event_key,
               goal_version = :goal_version, config_version = :config_version,
               input_epoch = :input_epoch,
               deadline_at = :deadline_at, state = 'pending',
               issued_session_id = NULL, issued_at = NULL,
               result_hash = NULL, result_ref = NULL, updated_at = :now
             WHERE call_id = :call_id AND state = 'expired'`
          )
          .run({
            registration_hash: input.session.registration_hash,
            artifact_hash: input.session.artifact_hash,
            host_id: input.pending.host_id,
            mode: input.pending.mode,
            config_space: input.pending.config_space,
            native_session_id: input.binding.native_session_id,
            hook_event: input.binding.host_event,
            boundary_event_key: input.binding.event_identity_key,
            goal_version: input.pending.goal_version,
            config_version: input.pending.config_version,
            input_epoch: input.pending.input_epoch,
            deadline_at: input.deadline,
            now: now(),
            call_id: input.request.delivery_id
          });
        return { ok: true, status: "ok", value: "rearmed" };
      }
      return { ok: true, status: "ok", value: "existing" };
    }
    deps.connection
      .prepare(
        `INSERT INTO host_runtime_call (
           call_id, kind, registration_hash, artifact_hash, host_id, mode, config_space,
           native_session_id, hook_event, boundary_event_key, goal_version, config_version,
           input_epoch, object_ref, deadline_at, state, issued_session_id, issued_at,
           result_hash, result_ref, created_at, updated_at
         ) SELECT
           :call_id, 'deliver', :registration_hash, :artifact_hash, :host_id, :mode, :config_space,
           :native_session_id, :hook_event, :boundary_event_key, :goal_version, :config_version,
           :input_epoch, :object_ref, :deadline_at, 'pending', NULL, NULL,
           NULL, NULL, :now, :now
         WHERE NOT EXISTS (
           SELECT 1 FROM host_runtime_call WHERE kind = 'deliver' AND object_ref = :object_ref
         )`
      )
      .run({
        call_id: input.request.delivery_id,
        registration_hash: input.session.registration_hash,
        artifact_hash: input.session.artifact_hash,
        host_id: input.pending.host_id,
        mode: input.pending.mode,
        config_space: input.pending.config_space,
        native_session_id: input.binding.native_session_id,
        hook_event: input.binding.host_event,
        boundary_event_key: input.binding.event_identity_key,
        goal_version: input.pending.goal_version,
        config_version: input.pending.config_version,
        input_epoch: input.pending.input_epoch,
        object_ref: input.request.delivery_id,
        deadline_at: input.deadline,
        now: now()
      });
    return { ok: true, status: "ok", value: "created" };
  }

  function mapCaptured(callId: string, detailRef: SourceRef): DeliveryOutcome | null {
    const entry = captured.get(callId);
    if (entry === undefined) {
      return null;
    }
    captured.delete(callId);
    const result = entry.result;
    if (result.kind === "error") {
      return { kind: "error", error: result.error };
    }
    if (result.kind !== "deliver") {
      return {
        kind: "error",
        error: adapterFailure("E_EVIDENCE_UNKNOWN", false, detailRef, now())
      };
    }
    if (result.state === "completed") {
      return { kind: "result", value: capDeliveryResult(result.result) };
    }
    if (result.state === "blocked") {
      return { kind: "error", error: result.error };
    }
    return null;
  }

  async function waitForOutcome(
    callId: string,
    deadline: number,
    detailRef: SourceRef,
    signal: AbortSignal | undefined
  ): Promise<DeliveryOutcome> {
    for (;;) {
      // A result already captured before the abort is a completed observation;
      // honor it rather than turning it into a cancellation.
      const mapped = mapCaptured(callId, detailRef);
      if (mapped !== null) {
        return mapped;
      }
      if (signal?.aborted === true) {
        return { kind: "error", error: cancellationError(callId, detailRef) };
      }
      const row = readCall(callId);
      if (row === null) {
        return {
          kind: "error",
          error: adapterFailure("E_INTERNAL", false, detailRef, now())
        };
      }
      if (row.state === "expired") {
        return {
          kind: "error",
          error: adapterFailure("E_DEADLINE_EXCEEDED", false, detailRef, now())
        };
      }
      if (row.state === "uncertain") {
        // The call was issued but no body reached the kernel. There is no
        // automatic retry: the outbox must reconcile the delivery explicitly.
        return {
          kind: "error",
          error: adapterFailure("E_EVIDENCE_UNKNOWN", false, detailRef, now())
        };
      }
      if (row.state === "completed") {
        return {
          kind: "error",
          error: adapterFailure("E_EVIDENCE_UNKNOWN", false, detailRef, now())
        };
      }
      const current = now();
      if (current >= deadline) {
        return {
          kind: "error",
          error: adapterFailure("E_DEADLINE_EXCEEDED", false, detailRef, current)
        };
      }
      const capturedEntry = captured.get(callId);
      if (capturedEntry !== undefined) {
        continue;
      }
      await sleep(Math.min(pollInterval, Math.max(1, deadline - current)), signal);
    }
  }

  const deliveryPort: OutboxDeliveryPort = {
    async deliver(
      request: OutboxDeliveryDispatchRequest,
      signal: AbortSignal
    ): Promise<HostAdapterResult<HostDeliveryResult>> {
      // Shutdown gate: after close, no delivery may insert a runtime call that
      // nobody will observe. `cancellationError` only withdraws a stale
      // `pending` row; it never inserts. The code is part of the closed
      // HostAdapterError vocabulary, so the outbox sees a normal adapter result.
      if (closed) {
        return {
          ok: false,
          status: "rejected",
          error: adapterFailure("E_CANCELLED", false, request.content_ref, now())
        };
      }
      if (signal.aborted) {
        return {
          ok: false,
          status: "rejected",
          error: cancellationError(request.delivery_id, request.content_ref)
        };
      }
      const binding = loadBinding(request.delivery_id);
      if (!binding.ok) {
        diagnostic("runtime_delivery.binding_unavailable", binding.error);
        return {
          ok: false,
          status: binding.status,
          error: adapterFailure(
            binding.error.code === "E_CONFLICT" || binding.error.code === "E_SCHEMA"
              ? "E_SCHEMA"
              : "E_CAPABILITY",
            binding.error.retryable,
            request.content_ref,
            now()
          )
        };
      }
      const delivery = readDelivery(request.delivery_id);
      if (delivery === null) {
        return {
          ok: false,
          status: "rejected",
          error: adapterFailure("E_CONFLICT", false, request.content_ref, now())
        };
      }
      const deliveryState = String(delivery["state"]);
      if (deliveryState === "expired") {
        return {
          ok: false,
          status: "rejected",
          error: adapterFailure("E_CAPABILITY", false, request.content_ref, now())
        };
      }
      if (String(delivery["content_hash"]) !== binding.value.pending.content_hash) {
        return {
          ok: false,
          status: "rejected",
          error: adapterFailure("E_CONFLICT", false, request.content_ref, now())
        };
      }
      const deadline = Math.max(
        1,
        Math.min(
          now() + request.deadline_ms,
          request.expires_at,
          binding.value.session.lease_expires_at
        )
      );
      if (deadline <= now()) {
        return {
          ok: false,
          status: "rejected",
          error: adapterFailure("E_DEADLINE_EXCEEDED", false, request.content_ref, now())
        };
      }
      // Check again right before the insert: a stop/close that landed while the
      // binding was being read must not create a call nobody will observe.
      if (closed) {
        return {
          ok: false,
          status: "rejected",
          error: adapterFailure("E_CANCELLED", false, request.content_ref, now())
        };
      }
      if (signal.aborted) {
        return {
          ok: false,
          status: "rejected",
          error: cancellationError(request.delivery_id, request.content_ref)
        };
      }
      const ensured = ensureCall({
        request,
        pending: binding.value.pending,
        binding: binding.value.binding,
        session: binding.value.session,
        deadline
      });
      if (!ensured.ok) {
        return {
          ok: false,
          status: ensured.status,
          error: adapterFailure("E_INTERNAL", false, request.content_ref, now())
        };
      }
      const cancel = new AbortController();
      const forwardCancellation = (): void => {
        cancel.abort();
      };
      if (signal.aborted || closeCancellation.signal.aborted) {
        cancel.abort();
      }
      signal.addEventListener("abort", forwardCancellation, { once: true });
      closeCancellation.signal.addEventListener("abort", forwardCancellation, { once: true });
      let outcome: DeliveryOutcome;
      try {
        outcome = await waitForOutcome(
          request.delivery_id,
          deadline,
          request.content_ref,
          cancel.signal
        );
      } finally {
        signal.removeEventListener("abort", forwardCancellation);
        closeCancellation.signal.removeEventListener("abort", forwardCancellation);
      }
      if (outcome.kind === "error") {
        return { ok: false, status: "rejected", error: outcome.error };
      }
      return { ok: true, status: "ok", value: outcome.value };
    }
  };

  const callResolver: HostRuntimeCallResolverPort = {
    async resolve(input): Promise<Result<RuntimeCall | null, ErrorEnvelope>> {
      if (input.row.kind !== "deliver") {
        return { ok: true, status: "ok", value: null };
      }
      const callId = input.row.call_id;
      const binding = loadBinding(input.row.object_ref);
      if (!binding.ok) {
        diagnostic("runtime_delivery.resolve_binding", binding.error);
        return { ok: false, status: binding.status, error: binding.error };
      }
      if (input.session.session_id !== binding.value.session.session_id) {
        return { ok: false, status: "rejected", error: bridgeError("E_CONFLICT", "runtime_delivery.session", false) };
      }
      if (input.row.deadline_at <= input.now) {
        return { ok: true, status: "ok", value: null };
      }
      const pending = binding.value.pending;
      const delivery = readDelivery(pending.delivery_id);
      if (delivery === null || String(delivery["state"]) !== "pending") {
        return { ok: false, status: "rejected", error: bridgeError("E_EVIDENCE_UNKNOWN", "runtime_delivery.delivery_state", false) };
      }
      if (String(delivery["content_hash"]) !== pending.content_hash) {
        return { ok: false, status: "rejected", error: bridgeError("E_CONFLICT", "runtime_delivery.content_hash", false) };
      }
      const bytes = deps.blob_store.read(pending.content_hash as Hash);
      if (!bytes.ok) {
        return { ok: false, status: "degraded", error: bridgeError("E_EVIDENCE_UNKNOWN", "runtime_delivery.content_read", false) };
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.value);
      } catch {
        return { ok: false, status: "rejected", error: bridgeError("E_SCHEMA", "runtime_delivery.content_utf8", false) };
      }
      return {
        ok: true,
        status: "ok",
        value: {
          kind: "deliver",
          call_id: callId,
          deadline_ms: Math.max(0, input.row.deadline_at - input.now),
          request: {
            delivery_id: pending.delivery_id,
            ...(pending.trigger_event_id === undefined
              ? {}
              : { trigger_event_id: pending.trigger_event_id as Id<"trg"> }),
            host_binding: binding.value.binding,
            boundary_event_ref: pending.boundary_event_ref as SourceRef,
            input_epoch: pending.input_epoch,
            goal_version: pending.goal_version,
            content_ref: pending.content_ref as SourceRef,
            content_hash: pending.content_hash as Hash,
            nonce: pending.nonce,
            max_chars: input.delivery_max_chars,
            wait_mode: pending.wait_mode,
            idempotency_key: idempotencyKeyFor(pending.delivery_id),
            deadline_ms: Math.max(0, input.row.deadline_at - input.now)
          },
          content: {
            media_type: "text/plain;charset=utf-8",
            text,
            content_hash: pending.content_hash as Hash,
            byte_length: bytes.value.byteLength
          }
        }
      };
    }
  };

  return {
    call_resolver: callResolver,
    delivery_port: deliveryPort,
    observe_result(request: HostRuntimeResultRequest): void {
      // A result that arrives after shutdown belongs to a call the kernel is no
      // longer waiting on; capturing it would repopulate the cleared map.
      if (closed) {
        return;
      }
      // Only a `completed` call carries a trustworthy body. A `not_injected`
      // result re-arms the call to `pending`, and a body that arrived after the
      // deadline was recorded as `uncertain`; capturing either would turn a
      // verified-unknown submission into an apparent success.
      const row = readCall(request.call_id);
      if (row === null || row.state !== "completed") {
        return;
      }
      if (captured.size > 0) {
        const cutoff = now() - RESULT_RETENTION_MS;
        for (const [callId, entry] of captured) {
          if (entry.at < cutoff) {
            captured.delete(callId);
          }
        }
      }
      captured.set(request.call_id, { at: now(), result: request.result });
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      captured.clear();
      closeCancellation.abort();
    }
  };
}
