/**
 * Automatic human-attestation issue after a committed host runtime upload.
 *
 * This is the public entry that needs no extra IPC method: `host.runtime.upload`
 * already authenticated `session_id`/`session_nonce` and committed the event
 * through `event.ingest`. The host-runtime service calls the optional
 * `human_attestation_upload` hook with the refreshed server-side session row,
 * the exact upload request and the returned receipt. The composition wires that
 * hook to `onUploadCommitted`.
 *
 * The trigger derives every trust-bearing coordinate from rows the runtime
 * cannot author:
 * - the session row comes from the kernel's authenticated session, not the
 *   upload payload;
 * - the upload row must name that session and the returned event;
 * - the event row must be the returned event key, an `input.received` event
 *   with an origin that a native confirmation can still settle;
 * - the host binding uses the session's native id, not the upload payload's
 *   self-reported `native_ids.session_id`.
 *
 * It never writes a capability or a confirmation row itself: the issuer either
 * returns `unverified` (the normal case while no host has a verified
 * `human_interaction_attested` capability) or queues a native confirmation
 * bound to the exact ready session.
 */

import {
  canonicalHash,
  isId,
  newId,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type JsonValue,
  type Result
} from "@evoplug/core";
import {
  validateCapabilityBinding,
  type CapabilityBinding,
  type HostEventBinding,
  type HostRuntimeUploadRequest,
  type HostRuntimeUploadResult
} from "@evoplug/core/host";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import type {
  HumanAttestationIssue,
  IssueHumanAttestationInput
} from "./host-human-attestation.js";
import type { HostRuntimeSessionRow } from "./host-runtime.js";

const CAPABILITY_NAME = "human_interaction_attested" as const;
const DEFAULT_DEADLINE_MS = 30_000;
const MAX_REQUEST_ID_LENGTH = 128;

/** Server-derived coordinates for one uploaded event. */
export interface UploadHumanCandidate {
  readonly runtime_session_id: Id<"rts">;
  readonly event_identity_key: Hash;
  readonly native_session_id: string;
  readonly host_binding: HostEventBinding;
  readonly binding: CapabilityBinding;
  readonly capability_id: Id<"cap">;
}

/** Exact post-commit input; all three fields are kernel-owned. */
export interface UploadHumanCommitInput {
  readonly session: HostRuntimeSessionRow;
  readonly request: HostRuntimeUploadRequest;
  readonly result: HostRuntimeUploadResult;
}

export interface UploadCommittedHumanAttestationDeps {
  readonly connection: SqliteConnection;
  /**
   * `RuntimeHumanAttestation.issue`. The trigger always supplies the
   * server-derived session id and native session id.
   */
  readonly issue: (
    input: Omit<IssueHumanAttestationInput, "confirm">
  ) => Promise<Result<HumanAttestationIssue, ErrorEnvelope>>;
  readonly now: () => number;
  readonly deadline_ms?: number;
  readonly request_id?: () => string;
  readonly on_candidate?: (candidate: UploadHumanCandidate) => void;
  readonly on_issued?: (
    candidate: UploadHumanCandidate,
    result: Result<HumanAttestationIssue, ErrorEnvelope>
  ) => void;
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}

export interface UploadCommittedHumanAttestation {
  /**
   * Call from the `human_attestation_upload` hook. Never throws and never
   * changes the upload result; the issue runs in the background and is drained
   * by `drain()` during shutdown.
   */
  onUploadCommitted(input: UploadHumanCommitInput): void;
  /**
   * Stops accepting new upload-triggered issues. Already-started issues are
   * cancelled by `RuntimeHumanAttestation.stop()`, which resolves their native
   * confirmation waits cooperatively; `drain()` then only waits for the
   * resulting issue settlement. Idempotent and safe after IPC close.
   */
  stop(): HumanUploadStopReport;
  drain(): Promise<void>;
}

export interface HumanUploadStopReport {
  readonly already_stopped: boolean;
}

interface UploadEventRow {
  readonly event_key: Hash;
  readonly event_type: string;
  readonly origin: string;
  readonly origin_basis: string;
  readonly host_id: string;
  readonly config_space: string;
  readonly received_at: number;
  readonly source_seq: number | null;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function registrationApplied(connection: SqliteConnection, registrationHash: Hash): boolean {
  const row = connection
    .prepare<SqlRow>(
      `SELECT state FROM adapter_registration WHERE registration_hash = :registration_hash LIMIT 1`
    )
    .get({ registration_hash: registrationHash });
  return row !== undefined && row["state"] === "applied";
}

function readEvent(connection: SqliteConnection, eventId: string): UploadEventRow | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT event_key, event_type, origin, origin_basis, host_id, config_space,
              received_at, source_seq
         FROM event_log
        WHERE event_id = :event_id
        LIMIT 1`
    )
    .get({ event_id: eventId });
  if (row === undefined) return null;
  const eventKey = asString(row, "event_key");
  const eventType = asString(row, "event_type");
  const origin = asString(row, "origin");
  const originBasis = asString(row, "origin_basis");
  const hostId = asString(row, "host_id");
  const configSpace = asString(row, "config_space");
  const receivedAt = row["received_at"];
  const sourceSeq = row["source_seq"];
  if (
    eventKey === null ||
    eventType === null ||
    origin === null ||
    originBasis === null ||
    hostId === null ||
    configSpace === null ||
    !isSafeNonNegativeInt(receivedAt) ||
    !(sourceSeq === null || isSafeNonNegativeInt(sourceSeq))
  ) {
    return null;
  }
  return {
    event_key: eventKey as Hash,
    event_type: eventType,
    origin,
    origin_basis: originBasis,
    host_id: hostId,
    config_space: configSpace,
    received_at: receivedAt,
    source_seq: sourceSeq
  };
}

function readCapabilityBinding(
  connection: SqliteConnection,
  session: HostRuntimeSessionRow
): { readonly capability_id: Id<"cap">; readonly binding: CapabilityBinding } | null {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT capability_id, binding_json FROM capability_record
        WHERE name = :name
        ORDER BY checked_at DESC, capability_id DESC`
    )
    .all({ name: CAPABILITY_NAME });
  for (const row of rows) {
    const capabilityId = asString(row, "capability_id");
    const bindingJson = asString(row, "binding_json");
    if (capabilityId === null || !isId(capabilityId, "cap") || bindingJson === null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bindingJson);
    } catch {
      continue;
    }
    const validated = validateCapabilityBinding(parsed);
    if (!validated.ok) continue;
    const binding = validated.value;
    if (
      binding.host_id !== session.host_id ||
      binding.mode !== session.mode ||
      binding.config_space !== session.config_space ||
      binding.adapter_version !== session.adapter_version ||
      binding.source_pin.host_version !== session.host_version ||
      (binding.subject !== "host_contract" && binding.subject !== "product_adapter")
    ) {
      continue;
    }
    return { capability_id: capabilityId, binding };
  }
  return null;
}

function isCandidateOrigin(origin: string, originBasis: string): boolean {
  if (origin === "unknown") {
    return originBasis === "unavailable" || originBasis === "inferred_from_agent";
  }
  return origin === "user" && originBasis === "host_typed_field";
}

function buildHostBinding(
  session: HostRuntimeSessionRow,
  request: HostRuntimeUploadRequest,
  event: UploadEventRow
): HostEventBinding | null {
  const nativeSessionId = session.native_session_id;
  if (nativeSessionId === null || nativeSessionId.length === 0) return null;
  const payloadNative = request.upload.native_ids.session_id;
  if (payloadNative !== undefined && payloadNative !== nativeSessionId) {
    return null;
  }
  const streamId = canonicalHash({
    host_id: session.host_id,
    config_space: session.config_space,
    mode: session.mode,
    native_session_id: nativeSessionId
  } as unknown as JsonValue);
  return {
    host_id: session.host_id,
    host_version: session.host_version,
    adapter_id: session.adapter_id,
    adapter_version: session.adapter_version,
    implementation_hash: session.implementation_hash,
    mode: session.mode,
    config_space: session.config_space,
    host_event: request.upload.host_event,
    native_session_id: nativeSessionId,
    ...(request.upload.native_ids.turn_id === undefined
      ? {}
      : { native_turn_id: request.upload.native_ids.turn_id }),
    ...(request.upload.native_ids.message_id === undefined
      ? {}
      : { native_message_id: request.upload.native_ids.message_id }),
    ...(request.upload.native_ids.event_id === undefined
      ? {}
      : { native_event_id: request.upload.native_ids.event_id }),
    stream_id: streamId,
    ...(event.source_seq === null ? {} : { source_seq: event.source_seq }),
    receipt_seq: event.source_seq === null ? 1 : Math.max(1, event.source_seq),
    event_identity_key: event.event_key,
    received_at: event.received_at
  };
}

export function createUploadCommittedHumanAttestation(
  deps: UploadCommittedHumanAttestationDeps
): UploadCommittedHumanAttestation {
  const now = deps.now;
  const pending = new Set<Promise<void>>();
  let stopped = false;

  function diagnostic(message: string, error?: ErrorEnvelope): void {
    deps.on_diagnostic?.(message, error);
  }

  function resolveCandidate(input: UploadHumanCommitInput): UploadHumanCandidate | null {
    const { session, request, result } = input;
    if (result.state !== "ingested" || result.receipt === null) return null;
    const receipt = result.receipt;
    if (receipt.duplicate) return null;
    if (
      session.state !== "ready" ||
      session.lease_expires_at <= now() ||
      session.native_session_id === null ||
      session.native_session_id.length === 0 ||
      !registrationApplied(deps.connection, session.registration_hash)
    ) {
      return null;
    }
    const upload = request.upload;
    if (
      upload.adapter_id !== session.adapter_id ||
      upload.host_id !== session.host_id ||
      upload.mode !== session.mode ||
      upload.config_space !== session.config_space ||
      (upload.native_ids.session_id !== undefined &&
        upload.native_ids.session_id !== session.native_session_id)
    ) {
      return null;
    }
    const uploadRow = deps.connection
      .prepare<SqlRow>(
        `SELECT 1 AS present FROM host_runtime_upload
          WHERE registration_hash = :registration_hash
            AND raw_event_id = :raw_event_id
            AND receipt_ref = :receipt_ref
            AND session_id = :session_id
          LIMIT 1`
      )
      .get({
        registration_hash: session.registration_hash,
        raw_event_id: upload.raw_event_id,
        receipt_ref: receipt.event_id,
        session_id: session.session_id
      });
    if (uploadRow === undefined) return null;
    const event = readEvent(deps.connection, receipt.event_id);
    // `event_log.payload_hash` hashes the normalized draft payload, while
    // `host_runtime_upload.payload_hash` hashes the raw upload bytes. The two
    // are not comparable. The kernel writes `receipt_ref` from the receipt it
    // returned for this authenticated upload, so that column is the authoritative
    // raw-upload-to-event link.
    if (
      event === null ||
      event.event_key !== receipt.event_key ||
      event.event_type !== "input.received" ||
      event.host_id !== session.host_id ||
      event.config_space !== session.config_space ||
      !isCandidateOrigin(event.origin, event.origin_basis)
    ) {
      return null;
    }
    const capability = readCapabilityBinding(deps.connection, session);
    if (capability === null) return null;
    const hostBinding = buildHostBinding(session, request, event);
    if (hostBinding === null) return null;
    return {
      runtime_session_id: session.session_id,
      event_identity_key: event.event_key,
      native_session_id: session.native_session_id,
      host_binding: hostBinding,
      binding: capability.binding,
      capability_id: capability.capability_id
    };
  }

  function onUploadCommitted(input: UploadHumanCommitInput): void {
    if (stopped) return;
    let candidate: UploadHumanCandidate | null = null;
    try {
      candidate = resolveCandidate(input);
    } catch (error) {
      diagnostic("human_attestation.upload_candidate_failed", error as ErrorEnvelope);
      return;
    }
    if (candidate === null) return;
    deps.on_candidate?.(candidate);
    const selected = candidate;
    const requestId = deps.request_id?.() ?? newId("ipc");
    if (
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      requestId.length > MAX_REQUEST_ID_LENGTH
    ) {
      diagnostic("human_attestation.upload_request_id_invalid");
      return;
    }
    const work = Promise.resolve()
      .then(() => {
        // `stop()` may land after the candidate was selected but before this
        // microtask ran. Starting an issue after shutdown would create new
        // confirmation work that nothing is waiting to drain.
        if (stopped) {
          diagnostic("human_attestation.upload_issue_skipped_stopped");
          return undefined;
        }
        return deps.issue({
          request_id: requestId,
          runtime_session_id: selected.runtime_session_id,
          binding: selected.binding,
          host_binding: selected.host_binding,
          event_identity_key: selected.event_identity_key,
          native_session_id: selected.native_session_id,
          deadline_ms: deps.deadline_ms ?? DEFAULT_DEADLINE_MS,
          capability_id: selected.capability_id
        });
      })
      .then((issued) => {
        if (issued !== undefined) deps.on_issued?.(selected, issued);
      })
      .catch((error: unknown) => {
        diagnostic("human_attestation.upload_issue_failed", error as ErrorEnvelope);
      })
      .finally(() => {
        pending.delete(work);
      });
    pending.add(work);
  }

  function stop(): HumanUploadStopReport {
    if (stopped) return { already_stopped: true };
    stopped = true;
    return { already_stopped: false };
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  return { onUploadCommitted, stop, drain };
}
