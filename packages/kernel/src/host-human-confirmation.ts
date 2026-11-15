/**
 * Kernel-side bridge between the human attestation issuer and a real host
 * runtime (DD-CAP-009).
 *
 * The issuer runs in the kernel process, which has no native host UI. Its
 * `HumanConfirmationPort` therefore queues a `probe` runtime call with
 * `probe_action="confirm_human_event"`; the host runtime renders the native
 * dialog and uploads `rsi.human_proof_evidence/1` through the frozen CAS
 * carrier. This module:
 *
 *   1. inserts the pending call (armed to the next real runtime poll),
 *   2. builds the immutable request from persisted probe/ledger rows,
 *   3. waits for the kernel-validated completion and returns only that result,
 *   4. expires the call when the issuer's deadline passes.
 *
 * It never writes a capability or a human confirmation row itself. A timeout,
 * missing UI, or malformed result is reported as `unknown` so the issuer closes
 * the ledger without a verified verdict. Shutdown follows the same path:
 * `stop()` resolves active waits as `unknown`, terminalizes pending calls as
 * `expired` and delivered calls as `uncertain`, and `drain()` waits only for
 * those settlements.
 */

import {
  err,
  hashBytes,
  isId,
  makeErrorEnvelope,
  ok,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type Result,
  type SourceRef
} from "@evoplug/core";
import {
  capabilityBindingKey,
  makeHostAdapterError,
  parseRuntimeHumanConfirmationObserved,
  validateCapabilityBinding,
  type CapabilityBinding,
  type HostAdapterResult,
  type HostEventBinding,
  type HostHumanConfirmationRequest,
  type HostHumanConfirmationResult,
  type RuntimeCall
} from "@evoplug/core/host";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import {
  createHumanAttestationIssuer,
  type HumanAttestationIssue,
  type HumanAttestationIssuer,
  type HumanAttestationIssuerDeps,
  type HumanConfirmationPort,
  type IssueHumanAttestationInput
} from "./host-human-attestation.js";
import type {
  HostRuntimeCallCompletion,
  HostRuntimeCallResolverPort,
  HostRuntimeProbeLifecyclePort,
  HostRuntimeSessionRow
} from "./host-runtime.js";
import { insertRuntimeCall } from "./runtime-delivery-bridge.js";

export interface HumanConfirmationRuntimeBridgeDeps {
  readonly connection: SqliteConnection;
  readonly now: () => number;
  /** Existing probe producer resolver; confirmation rows are handled here. */
  readonly delegate_call_resolver?: HostRuntimeCallResolverPort;
  /** Existing probe producer lifecycle; its hooks are forwarded unchanged. */
  readonly delegate_lifecycle?: HostRuntimeProbeLifecyclePort;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}

export interface HumanConfirmationRuntimeBridge {
  /** Pass this port to `createHumanAttestationIssuer().issue({ confirm })`. */
  readonly port: HumanConfirmationPort;
  /**
   * Binds the confirmation call to the exact ready session that issued the
   * attestation. `port` resolves by native session coordinates for callers
   * that do not carry a runtime session id.
   */
  portForSession(session_id: Id<"rts">): HumanConfirmationPort;
  readonly call_resolver: HostRuntimeCallResolverPort;
  readonly lifecycle: HostRuntimeProbeLifecyclePort;
  /**
   * Stops new confirmation work and cooperatively cancels active waits.
   *
   * Called before `drain()` during shutdown, either before IPC closes or after
   * IPC is closed but before the database is released. It never renders or
   * invents a native confirmation: active callers observe `unknown`, pending
   * calls become `expired`, delivered calls become `uncertain`, and any ledger
   * the issuer already opened closes as unverified. It does not redeliver
   * calls whose result is unknown.
   */
  stop(): HumanConfirmationStopReport;
  /** Resolves after every outstanding confirmation wait has settled. */
  drain(): Promise<void>;
}

export interface HumanConfirmationStopReport {
  readonly already_stopped: boolean;
  /** Confirmation calls whose waiting caller observed a cooperative cancel. */
  readonly cancelled_waits: number;
  /** Never-delivered pending calls transitioned to the terminal `expired` state. */
  readonly expired_calls: number;
  /**
   * Delivered calls transitioned to `uncertain`: the native UI may have seen
   * them, so they fail closed and are never re-issued.
   */
  readonly uncertain_calls: number;
}

const MAX_CONFIRMATION_DEADLINE_MS = 600_000;

interface SessionCoordinates {
  readonly session_id: Id<"rts">;
  readonly registration_hash: Hash;
  readonly artifact_hash: Hash;
  readonly host_version: string;
  readonly native_session_id: string;
}

interface ConfirmationRow {
  readonly confirmation_id: string;
  readonly binding_json: string;
  readonly host_binding_json: string;
  readonly event_identity_key: Hash;
  readonly challenge_nonce: string;
  readonly state: string;
}

function confirmationAdapterError(now: number): HostAdapterResult<never> {
  const bytes = new TextEncoder().encode("human_confirmation_runtime_unavailable");
  const detailRef =
    `blob://${hashBytes(bytes)}#bytes=0-${String(bytes.byteLength)}` as SourceRef;
  return {
    ok: false,
    status: "rejected",
    error: makeHostAdapterError({
      code: "E_AUTH_UNAVAILABLE",
      retryable: false,
      detail_ref: detailRef,
      observed_at: now
    })
  };
}

function conflictError(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CONFLICT",
    category: "conflict",
    message_key: "error.conflict",
    stage: "human_confirmation_queue",
    retryable: false,
    side_effect: "none",
    details: { kind: "none" }
  });
}

/** Keeps `drain` observable until every caller's confirmation wait settles. */
type PendingWait = Promise<void>;

function findReadySession(
  connection: SqliteConnection,
  input: HostHumanConfirmationRequest,
  now: number
): SessionCoordinates | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT session_id, registration_hash, artifact_hash, host_version, native_session_id
         FROM host_runtime_session
        WHERE state = 'ready'
          AND lease_expires_at > :now
          AND host_id = :host_id
          AND mode = :mode
          AND config_space = :config_space
          AND native_session_id = :native_session_id
        ORDER BY last_seen_at DESC, session_id DESC
        LIMIT 1`
    )
    .get({
      now,
      host_id: input.binding.host_id,
      mode: input.binding.mode,
      config_space: input.binding.config_space,
      native_session_id: input.native_session_id
    });
  if (row === undefined) return null;
  const sessionId = row["session_id"];
  const registration = row["registration_hash"];
  const artifact = row["artifact_hash"];
  const hostVersion = row["host_version"];
  const nativeSession = row["native_session_id"];
  if (
    typeof sessionId !== "string" ||
    !isId(sessionId, "rts") ||
    typeof registration !== "string" ||
    typeof artifact !== "string" ||
    typeof hostVersion !== "string" ||
    nativeSession !== input.native_session_id
  ) {
    return null;
  }
  return {
    session_id: sessionId,
    registration_hash: registration as Hash,
    artifact_hash: artifact as Hash,
    host_version: hostVersion,
    native_session_id: nativeSession
  };
}

/** Exact session binding for automatic confirmation after an upload commit. */
function findReadySessionById(
  connection: SqliteConnection,
  sessionId: Id<"rts">,
  now: number
): SessionCoordinates | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT session_id, registration_hash, artifact_hash, host_version, native_session_id
         FROM host_runtime_session
        WHERE session_id = :session_id
          AND state = 'ready'
          AND lease_expires_at > :now
        LIMIT 1`
    )
    .get({ session_id: sessionId, now });
  if (row === undefined) return null;
  const session = row["session_id"];
  const registration = row["registration_hash"];
  const artifact = row["artifact_hash"];
  const hostVersion = row["host_version"];
  const nativeSession = row["native_session_id"];
  if (
    session !== sessionId ||
    typeof registration !== "string" ||
    typeof artifact !== "string" ||
    typeof hostVersion !== "string" ||
    typeof nativeSession !== "string"
  ) {
    return null;
  }
  return {
    session_id: sessionId,
    registration_hash: registration as Hash,
    artifact_hash: artifact as Hash,
    host_version: hostVersion,
    native_session_id: nativeSession
  };
}

function readConfirmationByProbe(
  connection: SqliteConnection,
  probeId: string
): ConfirmationRow | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT confirmation_id, binding_json, host_binding_json, event_identity_key,
              challenge_nonce, state
         FROM host_human_confirmation
        WHERE probe_id = :probe_id
        LIMIT 1`
    )
    .get({ probe_id: probeId });
  if (row === undefined) return null;
  const confirmationId = row["confirmation_id"];
  const bindingJson = row["binding_json"];
  const hostBindingJson = row["host_binding_json"];
  const eventKey = row["event_identity_key"];
  const nonce = row["challenge_nonce"];
  const state = row["state"];
  if (
    typeof confirmationId !== "string" ||
    typeof bindingJson !== "string" ||
    typeof hostBindingJson !== "string" ||
    typeof eventKey !== "string" ||
    typeof nonce !== "string" ||
    typeof state !== "string"
  ) {
    return null;
  }
  return {
    confirmation_id: confirmationId,
    binding_json: bindingJson,
    host_binding_json: hostBindingJson,
    event_identity_key: eventKey as Hash,
    challenge_nonce: nonce,
    state
  };
}

function readProbeAction(
  connection: SqliteConnection,
  probeId: string
): string | null {
  const row = connection
    .prepare<SqlRow>("SELECT probe_action FROM host_probe WHERE probe_id = :probe_id LIMIT 1")
    .get({ probe_id: probeId });
  const action = row?.["probe_action"];
  return typeof action === "string" ? action : null;
}

function readCapabilityId(
  connection: SqliteConnection,
  bindingKey: Hash
): Id<"cap"> | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT capability_id FROM capability_record
        WHERE binding_key = :binding_key AND name = 'human_interaction_attested'
        LIMIT 1`
    )
    .get({ binding_key: bindingKey });
  const capabilityId = row?.["capability_id"];
  return typeof capabilityId === "string" && isId(capabilityId, "cap")
    ? capabilityId
    : null;
}

function parseBinding(text: string): CapabilityBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = validateCapabilityBinding(parsed, {
    capabilityName: "human_interaction_attested"
  });
  return result.ok ? result.value : null;
}

function parseHostBinding(text: string): HostEventBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["event_identity_key"] !== "string" ||
    typeof record["host_event"] !== "string" ||
    typeof record["host_id"] !== "string" ||
    typeof record["mode"] !== "string" ||
    typeof record["config_space"] !== "string" ||
    typeof record["native_session_id"] !== "string"
  ) {
    return null;
  }
  return record as unknown as HostEventBinding;
}

/**
 * Builds the bridge. Wire `port` into the issuer and wire the returned
 * `call_resolver`/`lifecycle` into `createHostRuntimeServices` (or pass a
 * delegate and let this object forward to it).
 */
export function createHumanConfirmationRuntimeBridge(
  deps: HumanConfirmationRuntimeBridgeDeps
): HumanConfirmationRuntimeBridge {
  const waiters = new Map<string, (result: HostHumanConfirmationResult) => void>();
  const requests = new Map<string, RuntimeCall>();
  const pendingWaits = new Set<PendingWait>();
  let stopped = false;

  function diagnostic(message: string, error?: ErrorEnvelope): void {
    deps.on_diagnostic?.(message, error);
  }

  /** Cooperative cancel: no native answer exists, and none is fabricated. */
  function cooperativeCancel(): HostAdapterResult<HostHumanConfirmationResult> {
    return { ok: true, status: "ok", value: { state: "unknown" } };
  }

  /**
   * Terminalizes one confirmation call without inventing a native answer:
   * pending calls never left the kernel (`expired`); issued calls may have
   * reached the host (`uncertain`, fail-closed, never re-issued).
   */
  function terminateCall(callId: string): {
    readonly expired: number;
    readonly uncertain: number;
  } {
    const now = deps.now();
    const expired = deps.connection
      .prepare(
        `UPDATE host_runtime_call SET state = 'expired', updated_at = :now
          WHERE call_id = :call_id AND state = 'pending'`
      )
      .run({ now, call_id: callId });
    const uncertain = deps.connection
      .prepare(
        `UPDATE host_runtime_call SET state = 'uncertain', updated_at = :now
          WHERE call_id = :call_id AND state = 'issued'`
      )
      .run({ now, call_id: callId });
    return { expired: expired.changes, uncertain: uncertain.changes };
  }

  function armPendingConfirmations(input: {
    readonly session: HostRuntimeSessionRow;
    readonly event_identity_key: Hash | null;
    readonly hook_event: string | null;
    readonly now: number;
  }): void {
    if (
      stopped ||
      input.event_identity_key === null ||
      input.hook_event === null ||
      input.session.native_session_id === null
    ) {
      return;
    }
    const rows = deps.connection
      .prepare<SqlRow>(
        `SELECT c.call_id
           FROM host_runtime_call c
           JOIN host_probe p ON p.probe_id = c.object_ref
          WHERE c.registration_hash = :registration_hash
            AND c.native_session_id = :native_session_id
            AND c.kind = 'probe'
            AND c.state = 'pending'
            AND c.boundary_event_key IS NULL
            AND c.deadline_at > :now
            AND p.probe_action = 'confirm_human_event'`
      )
      .all({
        registration_hash: input.session.registration_hash,
        native_session_id: input.session.native_session_id,
        now: input.now
      });
    for (const row of rows) {
      const callId = row["call_id"];
      if (typeof callId !== "string") continue;
      deps.connection
        .prepare(
          `UPDATE host_runtime_call SET
             boundary_event_key = :boundary_event_key,
             hook_event = :hook_event,
             updated_at = :now
           WHERE call_id = :call_id AND state = 'pending' AND boundary_event_key IS NULL`
        )
        .run({
          boundary_event_key: input.event_identity_key,
          hook_event: input.hook_event,
          now: input.now,
          call_id: callId
        });
    }
  }

  async function confirmOnSession(
    session: SessionCoordinates,
    input: HostHumanConfirmationRequest,
    now: number
  ): Promise<HostAdapterResult<HostHumanConfirmationResult>> {
    if (input.native_session_id !== session.native_session_id) {
      return confirmationAdapterError(now);
    }
    const callId = input.probe_id;
    let resolvePending: (value: HostHumanConfirmationResult) => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Promise<HostHumanConfirmationResult>((resolve) => {
      resolvePending = resolve;
      timer = setTimeout(() => {
        waiters.delete(callId);
        requests.delete(callId);
        terminateCall(callId);
        resolve({ state: "unknown" });
      }, Math.max(1, Math.min(input.deadline_ms, MAX_CONFIRMATION_DEADLINE_MS)));
      waiters.set(callId, (value) => {
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      });
    });
    const tracked = pending
      .then(() => undefined)
      .finally(() => pendingWaits.delete(tracked));
    pendingWaits.add(tracked);
    const inserted = insertRuntimeCall(
      deps.connection,
      {
        call_id: callId,
        kind: "probe",
        object_ref: callId,
        registration_hash: session.registration_hash,
        artifact_hash: session.artifact_hash,
        host_id: input.binding.host_id,
        mode: input.binding.mode,
        config_space: input.binding.config_space,
        native_session_id: session.native_session_id,
        hook_event: null,
        boundary_event_key: null,
        goal_version: null,
        config_version: null,
        input_epoch: null,
        deadline_at: now + Math.max(1, input.deadline_ms)
      },
      now
    );
    if (!inserted) {
      waiters.delete(callId);
      requests.delete(callId);
      if (timer !== null) clearTimeout(timer);
      // A duplicate call id cannot be answered by this waiter.
      resolvePending({ state: "unknown" });
      return { ok: true, status: "ok", value: { state: "unknown" } };
    }
    return { ok: true, status: "ok", value: await pending };
  }

  const port: HumanConfirmationPort = {
    async confirm(
      input: HostHumanConfirmationRequest
    ): Promise<HostAdapterResult<HostHumanConfirmationResult>> {
      const now = deps.now();
      if (stopped) return cooperativeCancel();
      const session = findReadySession(deps.connection, input, now);
      if (session === null) {
        return confirmationAdapterError(now);
      }
      return confirmOnSession(session, input, now);
    }
  };

  function portForSession(sessionId: Id<"rts">): HumanConfirmationPort {
    return {
      async confirm(
        input: HostHumanConfirmationRequest
      ): Promise<HostAdapterResult<HostHumanConfirmationResult>> {
        const now = deps.now();
        if (stopped) return cooperativeCancel();
        const session = findReadySessionById(deps.connection, sessionId, now);
        if (session === null) {
          return confirmationAdapterError(now);
        }
        return confirmOnSession(session, input, now);
      }
    };
  }

  const call_resolver: HostRuntimeCallResolverPort = {
    async resolve({
      row,
      session,
      now,
      delivery_max_chars
    }): Promise<Result<RuntimeCall | null, ErrorEnvelope>> {
      const action = readProbeAction(deps.connection, row.object_ref);
      if (action !== "confirm_human_event") {
        if (deps.delegate_call_resolver === undefined) return ok(null);
        return deps.delegate_call_resolver.resolve({
          row,
          session,
          now,
          delivery_max_chars
        });
      }
      // Shutdown must not render a new native confirmation. Returning null
      // makes the runtime close the issued call as `expired` without the call
      // ever reaching the host.
      if (stopped) return ok(null);
      if (row.boundary_event_key === null || row.deadline_at <= now) {
        return ok(null);
      }
      // The confirmation belongs to the native session that issued it. Another
      // authenticated native session of the same runtime must not render it.
      if (
        row.native_session_id === null ||
        session.native_session_id === null ||
        row.native_session_id !== session.native_session_id
      ) {
        return err(conflictError());
      }
      const ledger = readConfirmationByProbe(deps.connection, row.object_ref);
      if (ledger === null || ledger.state !== "pending") {
        return err(conflictError());
      }
      const binding = parseBinding(ledger.binding_json);
      const hostBinding = parseHostBinding(ledger.host_binding_json);
      if (binding === null || hostBinding === null) return err(conflictError());
      if (
        binding.host_id !== session.host_id ||
        binding.mode !== session.mode ||
        binding.config_space !== session.config_space ||
        hostBinding.event_identity_key !== ledger.event_identity_key ||
        hostBinding.host_id !== session.host_id ||
        hostBinding.mode !== session.mode ||
        hostBinding.config_space !== session.config_space
      ) {
        return err(conflictError());
      }
      const capabilityId = readCapabilityId(
        deps.connection,
        capabilityBindingKey(binding)
      );
      if (capabilityId === null) return err(conflictError());
      const remaining = Math.max(1, row.deadline_at - now);
      const deadlineMs = Math.max(
        1,
        Math.min(remaining, MAX_CONFIRMATION_DEADLINE_MS)
      );
      const request = {
        probe_id: row.object_ref as Id<"prb">,
        probe_contract_version: "host-probe/2" as const,
        binding,
        host_binding: hostBinding,
        probe_action: "confirm_human_event" as const,
        capabilities: [],
        probe_mode: "read_only" as const,
        deadline_ms: deadlineMs,
        human_confirmation: {
          capability_id: capabilityId,
          confirmation_id: ledger.confirmation_id,
          challenge_nonce: ledger.challenge_nonce,
          event_identity_key: ledger.event_identity_key,
          native_session_id: hostBinding.native_session_id ?? "",
          host_version: session.host_version
        }
      };
      const call: RuntimeCall = {
        kind: "probe",
        call_id: row.call_id,
        deadline_ms: deadlineMs,
        request
      };
      requests.set(row.call_id, call);
      return ok(call);
    }
  };

  function complete(input: HostRuntimeCallCompletion): void {
    const waiter = waiters.get(input.row.call_id);
    if (waiter === undefined) return;
    waiters.delete(input.row.call_id);
    const request = requests.get(input.row.call_id);
    requests.delete(input.row.call_id);
    if (
      input.result.kind !== "probe" ||
      input.result.state !== "observed" ||
      request === undefined ||
      request.kind !== "probe"
    ) {
      waiter({ state: "unknown" });
      return;
    }
    const observed = parseRuntimeHumanConfirmationObserved(
      input.result.observation.observed
    );
    const expected = request.request.human_confirmation;
    if (
      observed === null ||
      expected === undefined ||
      observed.nonce !== expected.challenge_nonce ||
      observed.event_identity_key !== expected.event_identity_key ||
      observed.native_session_id !== expected.native_session_id
    ) {
      diagnostic("human_confirmation.observation_mismatch");
      waiter({ state: "unknown" });
      return;
    }
    if (observed.state !== "confirmed") {
      waiter({ state: observed.state });
      return;
    }
    if (
      observed.evidence_ref === null ||
      observed.confirmed_at === null ||
      input.result.observation.evidence_refs.length !== 1 ||
      input.result.observation.evidence_refs[0] !== observed.evidence_ref
    ) {
      diagnostic("human_confirmation.evidence_mismatch");
      waiter({ state: "unknown" });
      return;
    }
    waiter({
      state: "confirmed",
      evidence_ref: observed.evidence_ref,
      confirmed_at: observed.confirmed_at
    });
  }

  const lifecycle: HostRuntimeProbeLifecyclePort = {
    onSessionReady(input) {
      deps.delegate_lifecycle?.onSessionReady?.(input);
    },
    onSessionPoll(input) {
      armPendingConfirmations(input);
      deps.delegate_lifecycle?.onSessionPoll?.(input);
    },
    onPollObserved(input) {
      deps.delegate_lifecycle?.onPollObserved?.(input);
    },
    onCallCompleted(input) {
      complete(input);
      return deps.delegate_lifecycle?.onCallCompleted?.(input);
    }
  };

  function stop(): HumanConfirmationStopReport {
    if (stopped) {
      return {
        already_stopped: true,
        cancelled_waits: 0,
        expired_calls: 0,
        uncertain_calls: 0
      };
    }
    stopped = true;
    let cancelledWaits = 0;
    let expiredCalls = 0;
    let uncertainCalls = 0;
    for (const [callId, waiter] of [...waiters]) {
      waiters.delete(callId);
      requests.delete(callId);
      const terminal = terminateCall(callId);
      expiredCalls += terminal.expired;
      uncertainCalls += terminal.uncertain;
      // The caller of `confirm` observes an unknown state. The issuer closes
      // any pending ledger as unverified; no evidence or confirmation is made
      // up.
      waiter({ state: "unknown" });
      cancelledWaits += 1;
    }
    return {
      already_stopped: false,
      cancelled_waits: cancelledWaits,
      expired_calls: expiredCalls,
      uncertain_calls: uncertainCalls
    };
  }

  async function drain(): Promise<void> {
    // Every active wait is bounded by the caller's deadline. Wait for those
    // callers to observe their terminal result before the runtime shuts down.
    while (pendingWaits.size > 0) {
      await Promise.allSettled([...pendingWaits]);
    }
  }

  return { port, portForSession, call_resolver, lifecycle, stop, drain };
}

/* ------------------------------------------------------------------ */
/* Composition helper                                                  */
/* ------------------------------------------------------------------ */

export interface RuntimeHumanAttestationDeps extends HumanAttestationIssuerDeps {
  readonly delegate_call_resolver?: HostRuntimeCallResolverPort;
  readonly delegate_lifecycle?: HostRuntimeProbeLifecyclePort;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}

export interface RuntimeHumanAttestation {
  readonly issuer: HumanAttestationIssuer;
  readonly port: HumanConfirmationPort;
  readonly call_resolver: HostRuntimeCallResolverPort;
  readonly lifecycle: HostRuntimeProbeLifecyclePort;
  /** Issues an attestation through the queued host runtime confirmation. */
  issue(
    input: Omit<IssueHumanAttestationInput, "confirm">
  ): ReturnType<HumanAttestationIssuer["issue"]>;
  /**
   * Stops future issues and cooperatively cancels active native confirmation
   * waits. Safe to call before or after the IPC server closes, and idempotent.
   * `drain()` after `stop()` only waits for work that already settled.
   */
  stop(): HumanConfirmationStopReport;
  drain(): Promise<void>;
}

/**
 * One-call composition root for the real product path. The caller supplies the
 * same `connection`/`state_rows`/`source_refs` used by the host-runtime
 * services and wires `call_resolver`/`lifecycle` beside the probe producer.
 */
export function createRuntimeHumanAttestation(
  deps: RuntimeHumanAttestationDeps
): RuntimeHumanAttestation {
  const bridge = createHumanConfirmationRuntimeBridge({
    connection: deps.connection,
    now: deps.now ?? ((): number => Date.now()),
    ...(deps.delegate_call_resolver === undefined
      ? {}
      : { delegate_call_resolver: deps.delegate_call_resolver }),
    ...(deps.delegate_lifecycle === undefined
      ? {}
      : { delegate_lifecycle: deps.delegate_lifecycle }),
    ...(deps.on_diagnostic === undefined
      ? {}
      : { on_diagnostic: deps.on_diagnostic })
  });
  const issuer = createHumanAttestationIssuer(deps);
  let stopped = false;

  function stoppedIssue(
    input: Omit<IssueHumanAttestationInput, "confirm">
  ): HumanAttestationIssue {
    let bindingKey: Hash | null = null;
    try {
      bindingKey = capabilityBindingKey(input.binding);
    } catch {
      bindingKey = null;
    }
    return {
      request_id: input.request_id,
      event_identity_key: input.event_identity_key,
      status: "unverified",
      confirmation_id: null,
      probe_id: null,
      binding_key: bindingKey,
      challenge_nonce: null,
      evidence_ref: null,
      evidence_hash: null,
      confirmed_at: null,
      wrote_rows: false,
      terminal: false,
      // No native answer exists because shutdown stopped the wait. This is the
      // same unverified outcome the issuer records when a confirmation is not
      // observed; no capability or ledger row is written here.
      reason: "adapter_not_confirmed"
    };
  }

  return {
    issuer,
    port: bridge.port,
    call_resolver: bridge.call_resolver,
    lifecycle: bridge.lifecycle,
    issue: (input) => {
      if (stopped) return Promise.resolve(ok(stoppedIssue(input)));
      return issuer.issue({
        ...input,
        confirm: bridge.portForSession(input.runtime_session_id)
      });
    },
    stop: () => {
      stopped = true;
      return bridge.stop();
    },
    drain: bridge.drain
  };
}
