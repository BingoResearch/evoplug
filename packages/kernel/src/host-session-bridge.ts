/**
 * Interactive-session confirmation bridge (closure design §5.2, §5.3).
 *
 * The kernel cannot render host UI. Two flows therefore travel as runtime
 * probes, delivered on the first interactive poll that carries a committed
 * event boundary:
 *
 * 1. `confirm_human_setup` — one native yes/no dialog establishes the
 *    `human_interaction_attested` capability. Until the user confirms, the
 *    capability row stays `unknown` and no experience can be adopted.
 * 2. `confirm_candidate` — each pending review candidate is shown with its
 *    object type, target path, change summary, basis and verification plan.
 *    Adopt / reject / later are recorded; adopt runs the same
 *    `performAdoption` sequence as the terminal command (grant -> write.apply
 *    -> readback -> approve roots).
 *
 * Print/json sessions have no dialog. The producer never arms a prompt unless
 * the session mode is `interactive`; a runtime that reports `unsupported` also
 * leaves the state untouched, so nothing is silently accepted.
 */

import {
  canonicalHash,
  canonicalJsonText,
  err,
  makeErrorEnvelope,
  newId,
  ok,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type JsonValue,
  type Result,
  type SourceRef
} from "@evoplug/core";
import {
  capabilityBindingKey,
  MCP_CONFIRM_POLL_EVENT,
  parseRuntimeConfirmationObservation,
  toCapabilityRecordPhysicalRow,
  toHostProbePhysicalRow,
  validateCapabilityBinding,
  validateCapabilityRecord,
  validateHostProbeRecord,
  inspectHostNativeConfirmationMechanism,
  type CapabilityBinding,
  type HostProbeRecord
} from "@evoplug/core/host";
import type { BlobStore, SqlRow, SqliteConnection } from "@evoplug/storage";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  candidateRoot,
  candidateSourceNativeSession,
  ensureConfirmationRow,
  pendingCandidates,
  performAdoption,
  readCandidateFile,
  readCandidatePatch,
  recordAsk,
  recordRejected,
  recordWithdrawnIncomplete,
  type CandidateRow,
  type ConfirmationSummary
} from "./candidate-adoption.js";
import type {
  HostRuntimeCallCompletion,
  HostRuntimeCallResolverPort,
  HostRuntimeProbeLifecyclePort,
  HostRuntimeSessionRow
} from "./host-runtime.js";
import { insertRuntimeCall } from "./runtime-delivery-bridge.js";
import {
  advanceReviewWatermark,
  latestHookNativeSession,
  latestSessionNativeSince
} from "./session-review-state.js";
import { redactCredentialMaterial } from "@evoplug/review";
import { chooseCapabilityBinding, listCapabilityRecords } from "./capability-pipeline-port.js";

const CAPABILITY_NAME = "human_interaction_attested" as const;
const SETUP_ACTION = "confirm_human_setup" as const;
const CANDIDATE_ACTION = "confirm_candidate" as const;
const PROBE_CONTRACT_VERSION = "host-probe/2" as const;
const DEADLINE_MS = 5 * 60_000;
const MAX_ATTESTATION_AGE_MS = 600_000;
const POLICY_VERSION = "policy:evoplug/1";

const DETAILS = Object.freeze({
  proof_kinds: ["host_native_confirmation", "control_plane_explicit_confirmation"],
  subject_kinds: ["event_key", "subject_hash"],
  control_plane_purposes: ["grant_issue", "grant_revoke", "adapter_install"],
  evidence_schema: "rsi.human_proof_evidence/1",
  max_attestation_age_ms: MAX_ATTESTATION_AGE_MS
});

export interface HostSessionBridgeDeps {
  readonly connection: SqliteConnection;
  readonly home: string;
  readonly blob_store: Pick<BlobStore, "putSync" | "read">;
  readonly now: () => number;
  /** Appendix Q.6.4: `candidate.pending_ttl_ms`, default 14 days. */
  readonly pending_ttl_ms?: number;
  /**
   * Resolved lazily because `write.apply` is composed after this bridge in the
   * bootstrap order. Returning `null` fails the adoption closed.
   */
  readonly write_apply: (
    request: JsonValue,
    signal: AbortSignal
  ) => Promise<Result<JsonValue, ErrorEnvelope>>;
  readonly delegate_call_resolver?: HostRuntimeCallResolverPort | undefined;
  readonly delegate_lifecycle?: HostRuntimeProbeLifecyclePort | undefined;
  readonly on_diagnostic?: ((message: string, error?: ErrorEnvelope) => void) | undefined;
}

export interface HostSessionBridge {
  readonly call_resolver: HostRuntimeCallResolverPort;
  readonly lifecycle: HostRuntimeProbeLifecyclePort;
  stop(): void;
  drain(): Promise<void>;
}

interface StoredSetupRequest {
  readonly kind: "human_setup";
  readonly capability_id: string;
  readonly challenge_nonce: string;
  readonly native_session_id: string;
  readonly host_version: string;
}

interface StoredCandidateRequest {
  readonly kind: "candidate_adoption";
  readonly confirmation_id: string;
  readonly candidate_id: string;
  readonly subject_hash: string;
  readonly challenge_nonce: string;
  readonly native_session_id: string;
  readonly title: string;
  readonly change_summary: string;
  readonly object_type: string;
  readonly target_path: string;
  readonly basis_evidence_refs: readonly string[];
  readonly verification_plan: string;
  readonly display?: {
    readonly name: string;
    readonly description: string;
    readonly change: string;
    readonly basis: readonly string[];
    readonly content: string;
    readonly preview_path: string;
    readonly show_command: string;
  };
  /** True when the asking session is the session that produced the candidate. */
  readonly source_session?: boolean;
  readonly options: {
    readonly adopt: string;
    readonly reject: string;
    readonly incomplete?: string;
  };
}

/** Task that produced the candidate, for the review watermark. */
function candidateTaskId(connection: SqliteConnection, proposalId: string): string | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT rj.task_id AS task_id
         FROM proposals p
         JOIN review_jobs rj ON rj.job_id = p.job_id
        WHERE p.proposal_id = :id
        LIMIT 1`
    )
    .get({ id: proposalId });
  return row === undefined || typeof row["task_id"] !== "string" ? null : row["task_id"];
}

function parseStored(text: string): StoredSetupRequest | StoredCandidateRequest | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as StoredSetupRequest | StoredCandidateRequest;
  } catch {
    return null;
  }
}

function isSetupRequest(value: StoredSetupRequest | StoredCandidateRequest): value is StoredSetupRequest {
  return (value as StoredSetupRequest).kind === "human_setup";
}

/**
 * Appendix K.2: a confirmation may name the channel that produced it. When it
 * does, the mechanism must be known and — for the stdio MCP channel — the
 * answer must be bound to the authenticated runtime session and to the
 * elicitation request id. Anything else is a broken answer, not a decision.
 */
interface ConfirmationChannel {
  readonly mechanism: string;
  readonly server: string | null;
  readonly session_id: string | null;
  readonly request_id: number | null;
}

function readConfirmationChannel(
  value: JsonValue,
  session: HostRuntimeSessionRow
): ConfirmationChannel | null | "invalid" {
  const verdict = inspectHostNativeConfirmationMechanism(value);
  if (verdict.state === "invalid") return "invalid";
  if (verdict.state === "absent") return null;
  const binding = verdict.binding;
  if (binding.mechanism === "mcp_elicitation") {
    if (
      session.native_session_id === null ||
      binding.session_id !== session.native_session_id ||
      binding.request_id === null
    ) {
      return "invalid";
    }
  }
  return {
    mechanism: binding.mechanism,
    server: binding.server,
    session_id: binding.session_id,
    request_id: binding.request_id
  };
}

function channelEvidenceFields(
  channel: ConfirmationChannel | null
): { readonly mechanism?: string; readonly channel?: JsonValue } {
  if (channel === null) return {};
  return {
    mechanism: channel.mechanism,
    channel: {
      server: channel.server,
      session_id: channel.session_id,
      request_id: channel.request_id
    } as unknown as JsonValue
  };
}

/**
 * Binding for the capability row.
 *
 * Appendix E: `human_interaction_attested` is a host capability and lives on
 * the same `product_adapter` binding as the adapter's other capability rows
 * (`input_capture`, `stable_boundary`, ...). Reusing the persisted binding is
 * exact: the binding carries the adapter version, host version, root, mode and
 * config space already probed for this session, so a second scope spelling can
 * never be invented here. More than one distinct adapter binding, or none at
 * all, fails closed and the setup prompt stays unarmed.
 */
function adapterBindingFor(
  connection: SqliteConnection,
  session: HostRuntimeSessionRow
): CapabilityBinding | null {
  const accept = (parsed: unknown): CapabilityBinding | null => {
    const validated = validateCapabilityBinding(parsed);
    if (!validated.ok) return null;
    const binding = validated.value;
    if (
      binding.subject !== "product_adapter" ||
      binding.host_id !== session.host_id ||
      binding.mode !== session.mode ||
      binding.config_space !== session.config_space ||
      binding.adapter_version !== session.adapter_version ||
      binding.source_pin.host_version !== session.host_version ||
      binding.backend_id !== undefined
    ) {
      return null;
    }
    return binding;
  };
  // The confirmation capability itself is the strongest pointer: if any
  // binding already carries `human_interaction_attested`, keep answering on
  // that binding instead of creating a second capability row on whichever
  // adapter binding happens to be newest.
  const humanByKey = new Map<string, CapabilityBinding>();
  const humanRows = connection
    .prepare<SqlRow>(
      `SELECT binding_key, binding_json FROM capability_record
        WHERE name = :name
        ORDER BY binding_key`
    )
    .all({ name: CAPABILITY_NAME });
  for (const row of humanRows) {
    if (typeof row["binding_json"] !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row["binding_json"]);
    } catch {
      continue;
    }
    const binding = accept(parsed);
    if (binding !== null) humanByKey.set(capabilityBindingKey(binding), binding);
  }
  if (humanByKey.size > 0) {
    if (humanByKey.size === 1) return [...humanByKey.values()][0] ?? null;
    const listed = listCapabilityRecords(connection);
    if (listed.ok) {
      const chosen = chooseCapabilityBinding(
        listed.value.filter((record) => humanByKey.has(record.binding_key))
      );
      if (chosen.ok && chosen.value !== null) return humanByKey.get(chosen.value) ?? null;
    }
    return null;
  }
  const byKey = new Map<string, CapabilityBinding>();
  const rows = connection
    .prepare<SqlRow>(
      `SELECT binding_key, binding_json FROM capability_record
        WHERE name <> :name
        ORDER BY binding_key`
    )
    .all({ name: CAPABILITY_NAME });
  for (const row of rows) {
    if (typeof row["binding_json"] !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row["binding_json"]);
    } catch {
      continue;
    }
    const binding = accept(parsed);
    if (binding !== null) byKey.set(capabilityBindingKey(binding), binding);
  }
  if (byKey.size === 1) return [...byKey.values()][0] ?? null;
  if (byKey.size > 1) {
    // A re-attach can leave an older product_adapter binding in the same
    // scope. Use the same deterministic selection as the online pipeline
    // (verified rows, then record count, then recency); do not synthesize yet
    // another binding just because two exist. An exact tie falls back to the
    // binding this bridge itself would synthesize, so the confirmation
    // capability lands on the adapter's own binding rather than a new one.
    const listed = listCapabilityRecords(connection);
    if (listed.ok) {
      const chosen = chooseCapabilityBinding(
        listed.value.filter((record) => byKey.has(record.binding_key))
      );
      if (chosen.ok && chosen.value !== null) return byKey.get(chosen.value) ?? null;
    }
    const synthesized = synthesizeAdapterBinding(session);
    if (synthesized !== null) {
      return byKey.get(capabilityBindingKey(synthesized)) ?? null;
    }
    return null;
  }
  // The first interactive session can start before any product_adapter
  // capability row exists (for example when the probe pipeline only wrote the
  // host_probe row). Fall back to the exact same binding recorded by that
  // probe, so the confirmation capability lands on the adapter binding the
  // other capabilities will later use instead of failing closed forever.
  const probes = connection
    .prepare<SqlRow>(
      `SELECT binding_json FROM host_probe
        WHERE binding_json LIKE '%"subject":"product_adapter"%'
        ORDER BY checked_at`
    )
    .all();
  for (const row of probes) {
    if (typeof row["binding_json"] !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row["binding_json"]);
    } catch {
      continue;
    }
    const binding = accept(parsed);
    if (binding !== null) byKey.set(capabilityBindingKey(binding), binding);
  }
  if (byKey.size !== 1) return null;
  return [...byKey.values()][0] ?? null;
}

/**
 * The first interactive session may arrive before the host has written any
 * `product_adapter` capability or probe row. The adapter coordinates are
 * already known from the authenticated runtime session, so the same binding
 * the probe pipeline will produce can be assembled deterministically. Later
 * probes recompute the same key; this is not a second binding scope.
 */
function synthesizeAdapterBinding(session: HostRuntimeSessionRow): CapabilityBinding | null {
  const candidate = {
    host_id: session.host_id,
    source_pin: {
      host_version: session.host_version,
      host_version_kind: "release",
      source_commit: null
    },
    binary_pin: { binary_hash: null, binary_version: null },
    adapter_version: session.adapter_version,
    subject: "product_adapter",
    mode: session.mode,
    config_space: session.config_space,
    root_id: session.host_id,
    construction_path: "cli",
    execution_environment: {
      arch: process.arch,
      isolation: "local",
      os: process.platform
    },
    mapping: "exact"
  };
  const validated = validateCapabilityBinding(candidate);
  return validated.ok ? validated.value : null;
}

function resolveAdapterBinding(
  connection: SqliteConnection,
  session: HostRuntimeSessionRow
): CapabilityBinding | null {
  return adapterBindingFor(connection, session) ?? synthesizeAdapterBinding(session);
}

export function createHostSessionBridge(deps: HostSessionBridgeDeps): HostSessionBridge {
  const pending = new Set<Promise<void>>();
  let stopped = false;

  function diagnostic(message: string, error?: ErrorEnvelope): void {
    deps.on_diagnostic?.(message, error);
  }

  interface CapabilityState {
    readonly capability_id: string;
    readonly binding_key: Hash;
    readonly status: string;
    readonly probe_ref: string | null;
  }

  function readCapability(bindingKey: Hash): CapabilityState | null {
    const rows = deps.connection
      .prepare<SqlRow>(
        `SELECT capability_id, binding_key, status, probe_ref
           FROM capability_record WHERE name = :name AND binding_key = :binding_key`
      )
      .all({ name: CAPABILITY_NAME, binding_key: bindingKey });
    for (const row of rows) {
      const id = row["capability_id"];
      const key = row["binding_key"];
      const status = row["status"];
      if (typeof id !== "string" || typeof key !== "string" || typeof status !== "string") continue;
      return {
        capability_id: id,
        binding_key: key as Hash,
        status,
        probe_ref: typeof row["probe_ref"] === "string" ? row["probe_ref"] : null
      };
    }
    return null;
  }

  function ensureCapability(session: HostRuntimeSessionRow): CapabilityState | null {
    const binding = resolveAdapterBinding(deps.connection, session);
    if (binding === null) {
      diagnostic("human_setup.adapter_binding_unavailable");
      return null;
    }
    const bindingKey = capabilityBindingKey(binding);
    const existing = readCapability(bindingKey);
    if (existing !== null) return existing;
    const capabilityId = `cap:${canonicalHash({ binding_key: bindingKey, name: CAPABILITY_NAME, created_at: deps.now() }).slice("sha256:".length, "sha256:".length + 26)}` as Id<"cap">;
    const record = {
      schema_version: "rsi.capability/2",
      capability_id: capabilityId,
      binding,
      binding_key: bindingKey,
      name: CAPABILITY_NAME,
      status: "unknown",
      evidence_stage: "none",
      evidence_refs: [],
      checked_at: deps.now(),
      details: DETAILS
    };
    const validated = validateCapabilityRecord(record);
    if (!validated.ok) {
      diagnostic("human_setup.capability_invalid", validated.error);
      return null;
    }
    const row = toCapabilityRecordPhysicalRow(validated.value, 1);
    deps.connection
      .prepare(
        `INSERT INTO capability_record (
           capability_id, binding_key, binding_json, name, status, evidence_stage,
           evidence_refs_json, probe_ref, probe_result, blocker_code, failure_code,
           checked_at, verified_at, last_verified_at, details_json, legacy_json, row_version
         ) VALUES (
           :capability_id, :binding_key, :binding_json, :name, :status, :evidence_stage,
           :evidence_refs_json, :probe_ref, :probe_result, NULL, NULL,
           :checked_at, NULL, NULL, :details_json, NULL, :row_version
         )`
      )
      .run({
        capability_id: row.capability_id,
        binding_key: row.binding_key,
        binding_json: row.binding_json,
        name: row.name,
        status: row.status,
        evidence_stage: row.evidence_stage,
        evidence_refs_json: row.evidence_refs_json,
        probe_ref: row.probe_ref ?? null,
        probe_result: row.probe_result ?? null,
        checked_at: row.checked_at,
        details_json: row.details_json,
        row_version: row.row_version
      });
    return {
      capability_id: capabilityId,
      binding_key: bindingKey,
      status: "unknown",
      probe_ref: null
    };
  }

  function insertProbe(input: {
    readonly session: HostRuntimeSessionRow;
    readonly capabilityId: string;
    readonly binding: CapabilityBinding;
    readonly action: typeof SETUP_ACTION | typeof CANDIDATE_ACTION;
    readonly stored: StoredSetupRequest | StoredCandidateRequest;
    readonly expected: string;
  }): Id<"prb"> | null {
    // `prb` ids are validated by the runtime result schema (`isId(prb)`),
    // which requires the canonical ULID form. A hash slice is not one, and the
    // resulting E_SCHEMA made every confirmation result unrecordable.
    const probeId = newId("prb", deps.now()) as Id<"prb">;
    const record: HostProbeRecord = {
      schema_version: "rsi.host_probe/2",
      probe_id: probeId,
      probe_contract_version: PROBE_CONTRACT_VERSION,
      target_kind: "host",
      binding: input.binding,
      binding_key: capabilityBindingKey(input.binding),
      probe_mode: "read_only",
      probe_action: input.action,
      assertions: [],
      capability_results: [],
      result: "unknown",
      expected: input.expected,
      observed: canonicalJsonText(input.stored as unknown as JsonValue),
      evidence_refs: [],
      duration_ms: 0,
      checked_at: deps.now()
    };
    const validated = validateHostProbeRecord(record);
    if (!validated.ok) {
      diagnostic("host_session_bridge.probe_invalid", validated.error);
      return null;
    }
    const row = toHostProbePhysicalRow(validated.value, 1);
    deps.connection
      .prepare(
        `INSERT OR REPLACE INTO host_probe (
           probe_id, binding_key, binding_json, subject, target_kind, probe_contract_version,
           probe_mode, fixture_ref, probe_action, assertions_json, capability_results_json,
           result, blocker_json, expected, observed, evidence_refs_json, duration_ms,
           checked_at, row_version
         ) VALUES (
           :probe_id, :binding_key, :binding_json, :subject, :target_kind, :probe_contract_version,
           :probe_mode, NULL, :probe_action, :assertions_json, :capability_results_json,
           :result, NULL, :expected, :observed, :evidence_refs_json, :duration_ms,
           :checked_at, :row_version
         )`
      )
      .run({
        probe_id: row.probe_id,
        binding_key: row.binding_key,
        binding_json: row.binding_json,
        subject: row.subject,
        target_kind: row.target_kind,
        probe_contract_version: row.probe_contract_version,
        probe_mode: row.probe_mode,
        probe_action: row.probe_action,
        assertions_json: row.assertions_json,
        capability_results_json: row.capability_results_json,
        result: row.result,
        expected: row.expected,
        observed: row.observed,
        evidence_refs_json: row.evidence_refs_json,
        duration_ms: row.duration_ms,
        checked_at: row.checked_at,
        row_version: row.row_version
      });
    return probeId;
  }

  function hasLiveCall(session: HostRuntimeSessionRow, action: string): boolean {
    // A call issued to an earlier runtime session cannot be delivered to this
    // one. Pi keeps one native session id across processes, so scoping only by
    // `native_session_id` let a stale `issued` call block every later session
    // until its 5-minute deadline (design §5.3: a pending candidate must be
    // asked again in the next interactive session). Pending calls stay
    // claimable by any session of the same host; issued calls only count for
    // the session they were issued to.
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT 1 AS present
           FROM host_runtime_call c JOIN host_probe p ON p.probe_id = c.object_ref
          WHERE c.registration_hash = :registration_hash
            AND (
              (c.state = 'pending' AND c.native_session_id = :native_session_id)
              OR (c.state = 'issued' AND c.issued_session_id = :session_id)
            )
            AND c.deadline_at > :now
            AND p.probe_action = :action
          LIMIT 1`
      )
      .get({
        registration_hash: session.registration_hash,
        native_session_id: session.native_session_id,
        session_id: session.session_id,
        now: deps.now(),
        action
      });
    return row !== undefined;
  }

  function arm(input: {
    readonly session: HostRuntimeSessionRow;
    readonly event_identity_key: Hash;
    readonly hook_event: string;
    readonly capabilityId: string;
    readonly binding: CapabilityBinding;
    readonly action: typeof SETUP_ACTION | typeof CANDIDATE_ACTION;
    readonly stored: StoredSetupRequest | StoredCandidateRequest;
    readonly expected: string;
  }): boolean {
    const probeId = insertProbe(input);
    if (probeId === null) return false;
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(`evoplug kernel: arm_probe id=${probeId} at=${String(deps.now())}\n`);
    }
    return insertRuntimeCall(
      deps.connection,
      {
        call_id: probeId,
        kind: "probe",
        object_ref: probeId,
        registration_hash: input.session.registration_hash,
        artifact_hash: input.session.artifact_hash,
        host_id: input.session.host_id,
        mode: input.session.mode,
        config_space: input.session.config_space,
        native_session_id: input.session.native_session_id,
        hook_event: input.hook_event,
        boundary_event_key: input.event_identity_key,
        goal_version: null,
        config_version: null,
        input_epoch: null,
        deadline_at: deps.now() + DEADLINE_MS
      },
      deps.now()
    );
  }

  const BOUNDARY_HOOK_EVENTS = new Set([
    "Stop",
    "StopFailure",
    "SessionEnd",
    "SessionStart",
    "agent_end",
    "agent_settled",
    "session_stop",
    "session_shutdown"
  ]);

  /**
   * Appendix L.4: a confirmation dialog is only opened while the host is idle
   * or at session start. The runtime stream stores the raw hook payload for
   * every accepted upload; the latest committed event's `hook_event_name`
   * therefore says whether the host is inside a turn (input/tool events) or at
   * a boundary. The MCP channel's own session id is not a host session, so its
   * idle state is judged on the host stream for the same host/config space;
   * concurrent TUIs are handled conservatively (any open turn closes dialogs).
   */
  function sessionTurnIdle(session: HostRuntimeSessionRow): boolean {
    const native = session.native_session_id;
    if (native === null) return true;
    const channelSession = native.startsWith("mcp-confirm:");
    const nativeFilter = channelSession ? "" : "AND s.external_session_id = :native";
    const params: Record<string, string> = {
      host_id: session.host_id,
      config_space: session.config_space
    };
    if (!channelSession) params["native"] = native;
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT e.event_type AS event_type, u.payload_hash AS payload_hash,
                e.occurred_at AS occurred_at
           FROM event_log e
           JOIN host_runtime_upload u ON u.receipt_ref = e.event_id
           JOIN session s ON s.session_id = e.session_id
          WHERE s.host_id = :host_id AND s.config_space = :config_space
            ${nativeFilter}
            AND u.payload_hash IS NOT NULL
          ORDER BY e.commit_seq DESC
          LIMIT 1`
      )
      .get(params);
    if (row === undefined) {
      // Session start is an idle point (appendix L.4). The channel polls
      // every few seconds, so this lands well before the interactive startup
      // window ends; the PTY driver answers it with the terminal idle.
      return true;
    }
    // Debounce: the host can go idle for a moment between a boundary and the
    // person's next prompt. Asking in that gap puts a form under the next
    // keystrokes, so require the stream to have been quiet for a few seconds.
    const occurredAt = row["occurred_at"];
    if (typeof occurredAt === "number" && deps.now() - occurredAt < 3_000) {
      return false;
    }
    const payloadHash = row["payload_hash"];
    if (typeof payloadHash === "string" && payloadHash.startsWith("sha256:")) {
      const bytes = deps.blob_store.read(payloadHash as Hash);
      if (bytes.ok) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(bytes.value)) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const hookEvent = (parsed as Record<string, unknown>)["hook_event_name"];
            if (typeof hookEvent === "string") return BOUNDARY_HOOK_EVENTS.has(hookEvent);
          }
        } catch {
          // An undecodable payload falls back to the event type below.
        }
      }
    }
    const eventType = row["event_type"];
    return eventType === "host.boundary";
  }

  /** Appendix L.4: an already adopted subject is never asked again. */
  function subjectAdopted(subjectHash: string): boolean {
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT 1 AS present FROM candidate_confirmation
          WHERE subject_hash = :subject_hash AND state = 'adopted' LIMIT 1`
      )
      .get({ subject_hash: subjectHash });
    return row !== undefined;
  }

  function maybeArmSetup(input: {
    readonly session: HostRuntimeSessionRow;
    readonly event_identity_key: Hash;
    readonly hook_event: string;
  }): boolean {
    const debug = process.env["EVOPLUG_DEBUG_IPC"] === "1";
    const fail = (reason: string): false => {
      if (debug) {
        process.stderr.write(
          `evoplug kernel: setup_arm_skip reason=${reason} native=${String(input.session.native_session_id)} mode=${input.session.mode}\n`
        );
      }
      return false;
    };
    if (input.session.mode !== "interactive") return fail("mode");
    if (input.session.native_session_id === null) return fail("native_session");
    if (input.session.native_session_id.startsWith("prb:")) return fail("probe_session");
    const capability = ensureCapability(input.session);
    if (capability === null) return fail("capability_unavailable");
    if (capability.status === "verified") return fail("verified");
    if (hasLiveCall(input.session, SETUP_ACTION)) return fail("live_call");
    const binding = resolveAdapterBinding(deps.connection, input.session);
    if (binding === null) return fail("adapter_binding");
    const nativeSessionId = input.session.native_session_id;
    if (nativeSessionId === null) return fail("native_session");
    const nonce = `setup:${canonicalHash({ session: input.session.session_id, at: deps.now() }).slice("sha256:".length, "sha256:".length + 32)}`;
    const armed = arm({
      session: input.session,
      event_identity_key: input.event_identity_key,
      hook_event: input.hook_event,
      capabilityId: capability.capability_id,
      binding,
      action: SETUP_ACTION,
      stored: {
        kind: "human_setup",
        capability_id: capability.capability_id,
        challenge_nonce: nonce,
        native_session_id: nativeSessionId,
        host_version: input.session.host_version
      },
      expected: nonce
    });
    if (debug) {
      process.stderr.write(
        `evoplug kernel: setup_arm ${armed ? "armed" : "failed"} native=${nativeSessionId} boundary=${String(input.event_identity_key)} hook=${String(input.hook_event)}\n`
      );
    }
    return armed;
  }

  function readBlobText(ref: string): string | null {
    const match = /^blob:\/\/(?:sha256:)?([0-9a-f]{64})#bytes=(\d+)-(\d+)$/u.exec(ref);
    if (match === null) return null;
    const [, locator, start, end] = match;
    const bytes = deps.blob_store.read(`sha256:${locator}` as Hash);
    if (!bytes.ok) return null;
    const from = Number(start);
    const to = Number(end);
    if (from < 0 || to > bytes.value.byteLength || to < from) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.value.subarray(from, to));
  }

  /** Original user words behind a correction observation, if it carries them. */
  function correctionQuote(ref: string): string | null {
    const text = readBlobText(ref);
    if (text === null) return null;
    let quote: string | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        // Only a correction observation carries the user's own words; plain
        // evidence refs in the same list are not corrections.
        if (record["user_correction"] === true && typeof record["user_content_ref"] === "string") {
          quote = readBlobText(record["user_content_ref"] as string);
        }
      }
    } catch {
      quote = null;
    }
    if (quote === null) return null;
    const clean = redactCredentialMaterial(quote).replace(/\s+/gu, " ").trim();
    if (clean.length === 0) return null;
    return clean.length <= 120 ? clean : `${clean.slice(0, 119)}…`;
  }

  function skillNameOf(candidate: CandidateRow): string {
    const parts = candidate.target_path.split("/").filter((part) => part.length > 0);
    const marker = parts.indexOf("SKILL.md");
    if (marker > 0) return parts[marker - 1] as string;
    return parts.length === 0 ? candidate.candidate_id : (parts[parts.length - 1] as string);
  }

  function buildCandidateDisplay(
    candidate: CandidateRow,
    summary: ConfirmationSummary
  ): NonNullable<StoredCandidateRequest["display"]> {
    const name = candidate.skill_title ?? skillNameOf(candidate);
    const description = (candidate.skill_description ?? "").trim().slice(0, 400);
    const basis: string[] = [];
    for (const ref of summary.basis_evidence_refs) {
      if (basis.length >= 3) break;
      const quote = correctionQuote(ref);
      if (quote !== null && !basis.includes(quote)) basis.push(quote);
    }
    const full = candidate.change_kind === "create"
      ? readCandidateFile(deps.blob_store, deps.connection, candidate.proposal_id)
      : readCandidatePatch(deps.blob_store, candidate.diff_ref);
    let body = full ?? "";
    // A create candidate's stored file is a diff envelope; show the added
    // text rather than the envelope JSON.
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const text = (parsed as Record<string, unknown>)["diff_text"];
        if (typeof text === "string") body = text;
      }
    } catch {
      // Plain body text.
    }
    const lines = body.split("\n");
    const preview = lines.length > 30
      ? `${lines.slice(0, 30).join("\n")}\n…（共 ${String(lines.length)} 行，完整内容见预览文件）`
      : body;
    const previewDir = join(deps.home, "previews");
    let previewPath = "";
    try {
      mkdirSync(previewDir, { recursive: true });
      previewPath = join(previewDir, `${candidate.candidate_id.replace(/[^A-Za-z0-9._-]/gu, "_")}.md`);
      const header = [
        `# ${name}`,
        "",
        description.length === 0 ? "" : description,
        "",
        basis.length === 0 ? "" : `依据：\n${basis.map((quote) => `- ${quote}`).join("\n")}`,
        "",
        candidate.change_kind === "update" ? "## 变更" : "## 正文",
        "",
        ""
      ].join("\n");
      writeFileSync(previewPath, `${header}${body}\n`, { mode: 0o600 });
    } catch {
      previewPath = "";
    }
    return {
      name,
      description,
      change: candidate.change_kind === "create"
        ? `新建 skill「${name}」`
        : `更新已有 skill「${name}」`,
      basis,
      content: preview,
      preview_path: previewPath,
      show_command: `evolve skills show ${candidate.candidate_id}`
    };
  }

  function candidateRequest(
    candidate: CandidateRow,
    summary: ConfirmationSummary,
    nonce: string,
    nativeSessionId: string,
    sourceSession: boolean
  ): StoredCandidateRequest {
    return {
      kind: "candidate_adoption",
      confirmation_id: `cfm:${canonicalHash({ candidate_id: candidate.candidate_id, subject_hash: summary.subject_hash }).slice("sha256:".length, "sha256:".length + 24)}`,
      candidate_id: candidate.candidate_id,
      subject_hash: summary.subject_hash,
      challenge_nonce: nonce,
      native_session_id: nativeSessionId,
      title: "EvoPlug 经验采用确认",
      change_summary: summary.change_summary,
      object_type: summary.object_type,
      target_path: summary.target_path,
      basis_evidence_refs: summary.basis_evidence_refs,
      verification_plan: summary.verification_plan,
      display: buildCandidateDisplay(candidate, summary),
      source_session: sourceSession,
      options: sourceSession
        ? { adopt: "采用", incomplete: "还没做完", reject: "内容不对" }
        : { adopt: "采用", reject: "拒绝" }
    };
  }

  function maybeArmCandidate(input: {
    readonly session: HostRuntimeSessionRow;
    readonly event_identity_key: Hash;
    readonly hook_event: string;
  }): boolean {
    const debug = process.env["EVOPLUG_DEBUG_IPC"] === "1";
    if (debug) {
      process.stderr.write(
        `evoplug kernel: candidate_arm_enter native=${String(input.session.native_session_id)} mode=${input.session.mode}\n`
      );
    }
    const skip = (reason: string): false => {
      if (debug) {
        process.stderr.write(`evoplug kernel: candidate_arm_skip reason=${reason}\n`);
      }
      return false;
    };
    if (input.session.mode !== "interactive") return skip("mode");
    if (input.session.native_session_id === null) return skip("native_session");
    // A kernel probe process registers a synthetic `prb:` session with the
    // interactive artifact. It has no UI; consuming the first confirmation
    // slot there would leave the real interactive session unconfirmed.
    if (input.session.native_session_id.startsWith("prb:")) return skip("probe_session");
    const binding = resolveAdapterBinding(deps.connection, input.session);
    if (binding === null) return skip("adapter_binding");
    const capability = readCapability(capabilityBindingKey(binding));
    if (capability === null || capability.status !== "verified") return skip("not_verified");
    const nativeSessionId = input.session.native_session_id;
    if (nativeSessionId === null) return skip("native_session");
    if (hasLiveCall(input.session, CANDIDATE_ACTION)) return skip("live_call");
    const candidates = pendingCandidates(deps.connection, {
      host_id: input.session.host_id,
      limit: 8,
      ...(deps.pending_ttl_ms === undefined ? {} : { pending_ttl_ms: deps.pending_ttl_ms })
    });
    if (debug) {
      process.stderr.write(`evoplug kernel: candidate_arm_candidates count=${String(candidates.length)}\n`);
    }
    for (const candidate of candidates) {
      if (candidate.mode !== input.session.mode) continue;
      if (candidate.config_space !== input.session.config_space) continue;
      const root = candidateRoot(deps.connection, candidate);
      if (!root.ok) {
        if (debug) process.stderr.write(`evoplug kernel: candidate_arm_skip reason=root\n`);
        continue;
      }
      const confirmation = ensureConfirmationRow(deps.connection, candidate, root.value, deps.now());
      if (!confirmation.ok) {
        if (debug) process.stderr.write(`evoplug kernel: candidate_arm_skip reason=confirmation\n`);
        continue;
      }
      if (confirmation.value.state !== "pending") continue;
      if (subjectAdopted(confirmation.value.subject_hash)) continue;
      // Q.6: each candidate is offered automatically once. A later, close or
      // cancel leaves it pending but not re-asked; `evolve skills ask <id>`
      // clears this counter and schedules exactly one more prompt.
      if (confirmation.value.ask_count >= 1) continue;
      // Do not consume an ask here: a session_start or post-turn context may be
      // unable to draw, and the runtime then leaves the call pending. Count the
      // ask only when the host actually returns a decision (handleCandidate).
      // Q.4: choose the confirmation options from the host session this
      // process is currently serving. Resident runtimes bind their first
      // native id forever (a later upload must not overwrite the authenticated
      // binding), so read the session registry instead. The MCP channel asks
      // on behalf of the newest hook-reported native session.
      const channel = input.session.instance_key !== null &&
        input.session.instance_key.startsWith("mcp-confirm:");
      const askingNative = channel
        ? latestHookNativeSession(
            deps.connection,
            input.session.registration_hash,
            input.session.host_id,
            input.session.config_space
          )
        : latestSessionNativeSince(
            deps.connection,
            input.session.host_id,
            input.session.config_space,
            input.session.started_at
          );
      if (askingNative === null) {
        // Unknown current session: never guess. The candidate stays pending
        // and is asked at the next poll after the first authenticated input.
        return skip("native_session_unverified");
      }
      const sourceNative = candidateSourceNativeSession(deps.connection, candidate.proposal_id);
      const sourceSession = sourceNative !== null && sourceNative === askingNative;
      const nonce = `candidate:${canonicalHash({ candidate: candidate.candidate_id, subject: confirmation.value.subject_hash, at: deps.now() }).slice("sha256:".length, "sha256:".length + 32)}`;
      const armed = arm({
        session: input.session,
        event_identity_key: input.event_identity_key,
        hook_event: input.hook_event,
        capabilityId: capability.capability_id,
        binding,
        action: CANDIDATE_ACTION,
        stored: candidateRequest(candidate, confirmation.value.summary, nonce, askingNative, sourceSession),
        expected: confirmation.value.subject_hash
      });
      if (armed) {
        if (debug) process.stderr.write(`evoplug kernel: candidate_arm armed\n`);
        return true;
      }
      if (debug) process.stderr.write(`evoplug kernel: candidate_arm failed\n`);
    }
    return false;
  }

  function readProbeRow(probeId: string): { action: string; observed: string; binding_json: string } | null {
    const row = deps.connection
      .prepare<SqlRow>(
        "SELECT probe_action, observed, binding_json FROM host_probe WHERE probe_id = :probe_id LIMIT 1"
      )
      .get({ probe_id: probeId });
    if (row === undefined) return null;
    const action = row["probe_action"];
    const observed = row["observed"];
    const bindingJson = row["binding_json"];
    if (typeof action !== "string" || typeof observed !== "string" || typeof bindingJson !== "string") {
      return null;
    }
    return { action, observed, binding_json: bindingJson };
  }

  function finishProbe(
    probeId: string,
    result: "passed" | "failed" | "unknown",
    evidence: { readonly ref: SourceRef; readonly text: string } | null
  ): void {
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug kernel: finish_probe id=${probeId} result=${result} at=${String(deps.now())}\n`
      );
    }
    const probe = readProbeRow(probeId);
    if (probe === null) return;
    const now = deps.now();
    const action = probe.action;
    const capability = probe.action === SETUP_ACTION ? CAPABILITY_NAME : CAPABILITY_NAME;
    const assertion = evidence === null
      ? []
      : [
          {
            assertion_id: `${capability}:${action}`,
            capability,
            expected: action,
            observed_ref: evidence.ref,
            pass: result === "passed"
          }
        ];
    deps.connection
      .prepare(
        `UPDATE host_probe SET
           assertions_json = :assertions_json,
           result = :result,
           observed = :observed,
           evidence_refs_json = :evidence_refs_json,
           duration_ms = :duration_ms,
           checked_at = :checked_at,
           row_version = row_version + 1
         WHERE probe_id = :probe_id`
      )
      .run({
        probe_id: probeId,
        assertions_json: JSON.stringify(assertion),
        result,
        observed: evidence === null ? probe.observed : evidence.text,
        evidence_refs_json: JSON.stringify(evidence === null ? [] : [evidence.ref]),
        duration_ms: 0,
        checked_at: now
      });
  }

  function markCapabilityVerified(probeId: string, evidenceRef: SourceRef): void {
    const probe = readProbeRow(probeId);
    if (probe === null) return;
    const now = deps.now();
    deps.connection
      .prepare(
        `UPDATE capability_record SET
           status = 'verified',
           evidence_stage = 'roundtrip',
           evidence_refs_json = :refs,
           probe_ref = :probe_ref,
           probe_result = 'passed',
           verified_at = :now,
           last_verified_at = :now,
           row_version = row_version + 1
         WHERE binding_key = :binding_key AND name = :name`
      )
      .run({
        refs: JSON.stringify([evidenceRef]),
        probe_ref: probeId,
        now,
        binding_key: (() => {
          try {
            const parsed = JSON.parse(probe.binding_json) as unknown;
            return capabilityBindingKey(parsed as CapabilityBinding);
          } catch {
            return "";
          }
        })(),
        name: CAPABILITY_NAME
      });
  }

  function storeEvidence(value: Record<string, unknown>): { ref: SourceRef; text: string } | null {
    const text = canonicalJsonText(value as unknown as JsonValue);
    const bytes = new TextEncoder().encode(text);
    const stored = deps.blob_store.putSync(bytes);
    if (!stored.ok) return null;
    // `SourceRefPort` resolves a blob through the SQLite descriptor, not the
    // filesystem alone. Without this row every proof read was "unverified"
    // even though the bytes existed.
    try {
      deps.connection
        .prepare(
          `INSERT INTO blob (
             blob_hash, byte_length, relative_path, state, verified_at,
             created_at, deleted_at, deletion_reason
           ) VALUES (
             :blob_hash, :byte_length, :relative_path, 'present', :now,
             :now, NULL, NULL
           )
           ON CONFLICT(blob_hash) DO UPDATE SET
             byte_length = excluded.byte_length,
             relative_path = excluded.relative_path,
             state = 'present',
             verified_at = excluded.verified_at,
             deleted_at = NULL,
             deletion_reason = NULL`
        )
        .run({
          blob_hash: stored.value.hash,
          byte_length: stored.value.byte_length,
          relative_path: `sha256/${stored.value.hash.replace(/^sha256:/u, "")}`,
          now: deps.now()
        });
    } catch {
      return null;
    }
    return {
      ref: `blob://${stored.value.hash}#bytes=0-${String(stored.value.byte_length)}` as SourceRef,
      text
    };
  }

  async function handleSetup(input: HostRuntimeCallCompletion, probeId: string, stored: StoredSetupRequest): Promise<void> {
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      const state =
        input.result.kind === "probe" || input.result.kind === "check_load"
          ? input.result.state
          : "error";
      process.stderr.write(
        `evoplug kernel: handle_setup id=${probeId} kind=${input.result.kind} state=${state} at=${String(deps.now())}\n`
      );
    }
    if (input.result.kind !== "probe" || input.result.state !== "observed") {
      finishProbe(probeId, "unknown", null);
      return;
    }
    const observed = parseRuntimeConfirmationObservation(input.result.observation.observed);
    if (
      observed === null ||
      observed.action !== "human_setup" ||
      observed.nonce !== stored.challenge_nonce ||
      observed.native_session_id !== stored.native_session_id
    ) {
      finishProbe(probeId, "failed", null);
      diagnostic("human_setup.observation_mismatch");
      return;
    }
    if (observed.decision !== "confirmed") {
      finishProbe(probeId, observed.decision === "not_confirmed" ? "failed" : "unknown", null);
      return;
    }
    const channel = readConfirmationChannel(input.result.observation.observed, input.session);
    if (channel === "invalid") {
      finishProbe(probeId, "failed", null);
      diagnostic("human_setup.channel_invalid");
      return;
    }
    if (observed.decided_at === null || observed.decided_at < (input.row.issued_at ?? 0) || observed.decided_at > deps.now()) {
      finishProbe(probeId, "failed", null);
      return;
    }
    const evidence = storeEvidence({
      schema_version: "rsi.human_setup_evidence/1",
      capability_id: stored.capability_id,
      proof_kind: "host_native_confirmation",
      host_id: input.session.host_id,
      host_version: stored.host_version,
      mode: input.session.mode,
      config_space: input.session.config_space,
      native_session_id: stored.native_session_id,
      nonce: stored.challenge_nonce,
      confirmed_at: observed.decided_at,
      ...channelEvidenceFields(channel)
    });
    if (evidence === null) {
      finishProbe(probeId, "failed", null);
      return;
    }
    finishProbe(probeId, "passed", evidence);
    markCapabilityVerified(probeId, evidence.ref);
  }

  async function handleCandidate(
    input: HostRuntimeCallCompletion,
    probeId: string,
    stored: StoredCandidateRequest
  ): Promise<void> {
    const debug = process.env["EVOPLUG_DEBUG_IPC"] === "1";
    const fail = (reason: string): void => {
      if (debug) {
        process.stderr.write(`evoplug kernel: candidate_fail id=${probeId} reason=${reason}\n`);
      }
      finishProbe(probeId, "failed", null);
    };
    if (input.result.kind !== "probe" || input.result.state !== "observed") {
      finishProbe(probeId, "unknown", null);
      return;
    }
    const observed = parseRuntimeConfirmationObservation(input.result.observation.observed);
    if (
      observed === null ||
      observed.action !== "candidate_adoption" ||
      observed.nonce !== stored.challenge_nonce ||
      observed.native_session_id !== stored.native_session_id ||
      observed.candidate_id !== stored.candidate_id ||
      observed.subject_hash !== stored.subject_hash
    ) {
      fail("observation_mismatch");
      diagnostic("candidate_confirmation.observation_mismatch");
      return;
    }
    if (observed.decision === "unsupported" || observed.decision === "unknown") {
      // A host with no dialog surface reports `unsupported`: the candidate was
      // never shown, so it must not spend its single automatic ask. A real
      // dismissal or close reports `unknown` and does.
      if (observed.decision === "unknown") {
        recordAsk(deps.connection, stored.candidate_id, deps.now());
      }
      finishProbe(probeId, "unknown", null);
      return;
    }
    recordAsk(deps.connection, stored.candidate_id, deps.now());
    const channel = readConfirmationChannel(input.result.observation.observed, input.session);
    if (channel === "invalid") {
      fail("channel_invalid");
      diagnostic("candidate_confirmation.channel_invalid");
      return;
    }
    if (observed.decided_at === null || observed.decided_at < (input.row.issued_at ?? 0) || observed.decided_at > deps.now()) {
      fail(`decided_at_${String(observed.decided_at)}_issued_${String(input.row.issued_at ?? 0)}_now_${String(deps.now())}`);
      return;
    }
    // Appendix L.4: adoption is idempotent by subject hash. A duplicate answer
    // for a subject that is already adopted is a success, never a new write
    // and never a reason to ask again.
    if (subjectAdopted(stored.subject_hash)) {
      finishProbe(probeId, "passed", null);
      return;
    }
    // The host returned a real decision, so the prompt was presented and
    // answered; only now does it count against the three-ask cap.
    const taskId = candidateTaskId(deps.connection, stored.candidate_id);
    if (observed.decision === "incomplete") {
      // Q.6: only the source session (the same native session id, including a
      // resume) can say the task was not finished. Withdraw without negative
      // evidence and leave the review watermark unadvanced.
      if (stored.source_session !== true) {
        finishProbe(probeId, "unknown", null);
        return;
      }
      recordWithdrawnIncomplete(deps.connection, stored.candidate_id, deps.now());
      finishProbe(probeId, "passed", null);
      return;
    }
    if (observed.decision === "reject") {
      const reasonRaw = typeof observed.reason === "string" ? observed.reason.trim() : "";
      const reason = reasonRaw.length === 0
        ? null
        : redactCredentialMaterial(reasonRaw).slice(0, 500);
      recordRejected(
        deps.connection,
        stored.candidate_id,
        "host_native_confirmation",
        deps.now(),
        reason
      );
      if (taskId !== null) advanceReviewWatermark(deps.connection, taskId);
      finishProbe(probeId, "passed", null);
      return;
    }
    // adopt
    const adapterBinding = resolveAdapterBinding(deps.connection, input.session);
    const capability =
      adapterBinding === null ? null : readCapability(capabilityBindingKey(adapterBinding));
    if (capability === null) {
      fail("capability");
      return;
    }
    // Appendix K.2: an adoption is a host-native confirmation, so the recorded
    // proof names that kind and the channel that produced it. The subject is
    // the candidate's subject hash, because that is what the person saw.
    const evidence = storeEvidence({
      schema_version: "rsi.human_proof_evidence/1",
      capability_id: capability.capability_id,
      proof_kind: "host_native_confirmation",
      subject: {
        kind: "control_plane",
        purpose: "grant_issue",
        subject_hash: stored.subject_hash
      },
      host_id: input.session.host_id,
      host_version: input.session.host_version,
      mode: input.session.mode,
      config_space: input.session.config_space,
      native_session_id: stored.native_session_id,
      nonce: stored.challenge_nonce,
      confirmed_at: observed.decided_at,
      ...channelEvidenceFields(channel)
    });
    if (evidence === null) {
      fail("evidence");
      return;
    }
    const adopted = await performAdoption({
      connection: deps.connection,
      home: deps.home,
      blob_store: deps.blob_store,
      candidate_id: stored.candidate_id,
      proof: {
        kind: "host_native_confirmation",
        capability_id: capability.capability_id,
        evidence_ref: evidence.ref,
        confirmed_at: observed.decided_at,
        ...(channel === null
          ? {}
          : { mechanism: channel.mechanism, channel: {
              server: channel.server,
              session_id: channel.session_id,
              request_id: channel.request_id
            } })
      },
      verify_proof: async (attestation, subjectHash) => {
        if (subjectHash !== stored.subject_hash) return "conflict";
        const match = /^blob:\/\/(sha256:[0-9a-f]{64})#/u.exec(String(attestation.evidence_ref));
        if (match === null) return "conflict";
        const resolved = deps.blob_store.read(match[1] as Hash);
        if (!resolved.ok) return "unverified";
        const text = new TextDecoder().decode(resolved.value);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          return "conflict";
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "conflict";
        const record = parsed as Record<string, unknown>;
        if (
          record["proof_kind"] !== "host_native_confirmation" ||
          record["nonce"] !== stored.challenge_nonce ||
          record["confirmed_at"] !== attestation.confirmed_at ||
          record["capability_id"] !== capability.capability_id ||
          (record["subject"] as Record<string, unknown> | undefined)?.["subject_hash"] !== stored.subject_hash
        ) {
          return "conflict";
        }
        // A named channel must be known and complete; when this answer came
        // from the MCP channel, the MCP server session and the elicitation
        // request id must be the ones the kernel accepted from the runtime.
        if (inspectHostNativeConfirmationMechanism(record).state === "invalid") {
          return "conflict";
        }
        if (
          channel !== null &&
          channel.mechanism === "mcp_elicitation" &&
          (record["mechanism"] !== channel.mechanism ||
            (record["channel"] as Record<string, unknown> | undefined)?.["session_id"] !== channel.session_id ||
            (record["channel"] as Record<string, unknown> | undefined)?.["request_id"] !== channel.request_id)
        ) {
          return "conflict";
        }
        return deps.now() - attestation.confirmed_at <= MAX_ATTESTATION_AGE_MS ? "verified" : "unverified";
      },
      write_apply: deps.write_apply,
      policy_version: POLICY_VERSION,
      now: deps.now
    });
    if (!adopted.ok) {
      if (debug) {
        process.stderr.write(
          `evoplug kernel: candidate_adopt_failed id=${probeId} code=${adopted.error.code} details=${JSON.stringify(adopted.error.details)} at=${String(deps.now())}\n`
        );
      }
      const details = adopted.error.details as { kind?: string; rule?: string } | undefined;
      if (details?.kind === "field" && details.rule === "already_adopted") {
        if (taskId !== null) advanceReviewWatermark(deps.connection, taskId);
        finishProbe(probeId, "passed", evidence);
        return;
      }
      finishProbe(probeId, "failed", evidence);
      diagnostic("candidate_confirmation.adopt_failed", adopted.error);
      return;
    }
    if (taskId !== null) advanceReviewWatermark(deps.connection, taskId);
    finishProbe(probeId, "passed", evidence);
  }

  function onCallCompleted(input: HostRuntimeCallCompletion): void {
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug kernel: call_completed id=${input.row.call_id} kind=${input.result.kind} state=${input.row.state} at=${String(deps.now())}\n`
      );
    }
    if (input.result.kind !== "probe") {
      return;
    }
    const probe = readProbeRow(input.row.object_ref);
    if (probe === null) return;
    if (probe.action !== SETUP_ACTION && probe.action !== CANDIDATE_ACTION) return;
    const stored = parseStored(probe.observed);
    if (stored === null) return;
    const work = isSetupRequest(stored)
      ? handleSetup(input, input.row.object_ref, stored)
      : handleCandidate(input, input.row.object_ref, stored);
    const tracked = work
      .catch((error: unknown) => {
        diagnostic("host_session_bridge.handle_failed", error instanceof Error ? undefined : undefined);
      })
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  }

  const call_resolver: HostRuntimeCallResolverPort = {
    async resolve({ row, session, now, delivery_max_chars }): Promise<Result<import("@evoplug/core/host").RuntimeCall | null, ErrorEnvelope>> {
      const probe = readProbeRow(row.object_ref);
      if (probe === null || (probe.action !== SETUP_ACTION && probe.action !== CANDIDATE_ACTION)) {
        if (deps.delegate_call_resolver === undefined) return ok(null);
        return deps.delegate_call_resolver.resolve({ row, session, now, delivery_max_chars });
      }
      if (stopped) return ok(null);
      if (row.deadline_at <= now) return ok(null);
      if (row.native_session_id === null || session.native_session_id !== row.native_session_id) {
        return err(makeErrorEnvelope({
          code: "E_CONFLICT",
          category: "conflict",
          message_key: "error.conflict",
          stage: "host_session_bridge",
          retryable: false,
          side_effect: "none",
          details: { kind: "field", path: "native_session_id", rule: "session_mismatch" }
        }));
      }
      const stored = parseStored(probe.observed);
      if (stored === null) return ok(null);
      let binding: CapabilityBinding;
      try {
        binding = JSON.parse(probe.binding_json) as CapabilityBinding;
      } catch {
        return ok(null);
      }
      const deadlineMs = Math.max(1, Math.min(row.deadline_at - now, DEADLINE_MS));
      if (isSetupRequest(stored)) {
        const adapterBinding = resolveAdapterBinding(deps.connection, session);
        const capability =
          adapterBinding === null ? null : readCapability(capabilityBindingKey(adapterBinding));
        if (capability === null) return ok(null);
        return ok({
          kind: "probe",
          call_id: row.call_id,
          deadline_ms: deadlineMs,
          request: {
            probe_id: row.object_ref as Id<"prb">,
            probe_contract_version: "host-probe/2",
            binding,
            host_binding: {
              host_id: session.host_id,
              host_version: session.host_version,
              adapter_id: session.adapter_id,
              adapter_version: session.adapter_version,
              implementation_hash: session.implementation_hash,
              mode: session.mode,
              config_space: session.config_space,
              host_event: row.hook_event ?? "input",
              native_session_id: session.native_session_id ?? "",
              stream_id: canonicalHash({
                host_id: session.host_id,
                config_space: session.config_space,
                mode: session.mode,
                native_session_id: session.native_session_id
              } as unknown as JsonValue),
              receipt_seq: 1,
              event_identity_key: row.boundary_event_key ?? ("" as Hash),
              received_at: now
            },
            probe_action: SETUP_ACTION,
            capabilities: [],
            probe_mode: "read_only",
            deadline_ms: deadlineMs,
            human_setup: {
              capability_id: capability.capability_id as Id<"cap">,
              challenge_nonce: stored.challenge_nonce,
              native_session_id: stored.native_session_id,
              host_version: stored.host_version,
              title: "EvoPlug 需要一次真人确认",
              message:
                "EvoPlug 需要你确认后才会写入经验。是否启用确认通道？选择“是”后，evoplug 会在采用经验前再次征求你的确认。"
            }
          }
        });
      }
      return ok({
        kind: "probe",
        call_id: row.call_id,
        deadline_ms: deadlineMs,
        request: {
          probe_id: row.object_ref as Id<"prb">,
          probe_contract_version: "host-probe/2",
          binding,
          host_binding: {
            host_id: session.host_id,
            host_version: session.host_version,
            adapter_id: session.adapter_id,
            adapter_version: session.adapter_version,
            implementation_hash: session.implementation_hash,
            mode: session.mode,
            config_space: session.config_space,
            host_event: row.hook_event ?? "input",
            native_session_id: session.native_session_id ?? "",
            stream_id: canonicalHash({
              host_id: session.host_id,
              config_space: session.config_space,
              mode: session.mode,
              native_session_id: session.native_session_id
            } as unknown as JsonValue),
            receipt_seq: 1,
            event_identity_key: row.boundary_event_key ?? ("" as Hash),
            received_at: now
          },
          probe_action: CANDIDATE_ACTION,
          capabilities: [],
          probe_mode: "read_only",
          deadline_ms: deadlineMs,
          candidate_confirmation: {
            confirmation_id: stored.confirmation_id,
            candidate_id: stored.candidate_id,
            subject_hash: stored.subject_hash as Hash,
            challenge_nonce: stored.challenge_nonce,
            native_session_id: stored.native_session_id,
            object_type: stored.object_type as "skill" | "memory" | "instructions",
            target_path: stored.target_path,
            change_summary: stored.change_summary,
            basis_evidence_refs: stored.basis_evidence_refs,
            verification_plan: stored.verification_plan,
            ...(stored.display === undefined ? {} : { display: stored.display }),
            title: stored.title,
            options: stored.options
          }
        }
      });
    }
  };

  // Appendix Q.4: a confirmation is only asked at the start of an interactive
  // host process (a new `started_at`), never in the middle of a session. The
  // setup attestation and the first candidate are two stages of that start.
  const setupAttempted = new Map<string, number>();
  const candidateAttempted = new Map<string, number>();

  const lifecycle: HostRuntimeProbeLifecyclePort = {
    onSessionReady(input) {
      deps.delegate_lifecycle?.onSessionReady?.(input);
    },    onSessionPoll(input) {
      if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
        process.stderr.write(
          `evoplug kernel: poll_intent native=${String(input.session.native_session_id)} boundary=${String(input.event_identity_key)} hook=${String(input.hook_event)}\n`
        );
      }
      if (
        !stopped &&
        input.session.mode === "interactive" &&
        input.session.native_session_id !== null &&
        input.event_identity_key !== null &&
        input.hook_event !== null
      ) {
        const fromConfirmChannel = input.hook_event === MCP_CONFIRM_POLL_EVENT;
        // A one-shot hook process has no dialog surface (appendix L.4); its
        // polls never arm a confirmation. Only the MCP channel asks, and only
        // while the host is idle or at session start.
        if (input.session.ephemeral && !fromConfirmChannel) {
          deps.delegate_lifecycle?.onSessionPoll?.(input);
          return;
        }
        if (fromConfirmChannel && !sessionTurnIdle(input.session)) {
          if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
            process.stderr.write(
              `evoplug kernel: confirm_arm_skip reason=turn_busy native=${String(input.session.native_session_id)}\n`
            );
          }
          deps.delegate_lifecycle?.onSessionPoll?.(input);
          return;
        }
        const intent = {
          session: input.session,
          event_identity_key: input.event_identity_key,
          hook_event: input.hook_event
        };
        const startedAt = input.session.started_at;
        try {
          if (setupAttempted.get(input.session.session_id) !== startedAt) {
            const armedSetup = maybeArmSetup(intent);
            setupAttempted.set(input.session.session_id, startedAt);
            if (armedSetup) {
              // The setup answer verifies the capability; the candidate waits
              // for the next session start rather than popping mid-session
              // after the setup dialog closes (Q.4).
              candidateAttempted.set(input.session.session_id, startedAt);
              deps.delegate_lifecycle?.onSessionPoll?.(input);
              return;
            }
          }
          if (candidateAttempted.get(input.session.session_id) !== startedAt) {
            candidateAttempted.set(input.session.session_id, startedAt);
            maybeArmCandidate(intent);
          }
        } catch (error) {
          if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
            process.stderr.write(
              `evoplug kernel: arm_failed error=${error instanceof Error ? error.message : String(error)}\n`
            );
          }
          diagnostic("host_session_bridge.arm_failed", error instanceof Error ? undefined : undefined);
        }
      }
      deps.delegate_lifecycle?.onSessionPoll?.(input);
    },
    onPollObserved(input) {
      deps.delegate_lifecycle?.onPollObserved?.(input);
    },
    onCallCompleted(input) {
      // Q.4.2: several pending candidates at one session start are asked in
      // creation order. Clear the per-process marker only after a real
      // candidate dialog, never after an unrelated delivery/probe, so a
      // candidate produced mid-session still waits for the next session.
      const completedProbe = typeof input.row.object_ref === "string"
        ? readProbeRow(input.row.object_ref)
        : null;
      if (completedProbe?.action === CANDIDATE_ACTION) {
        candidateAttempted.delete(input.session.session_id);
      } else if (completedProbe?.action === SETUP_ACTION) {
        // A session-start context without a dialog reports `unsupported`; the
        // setup prompt must be retried at the next poll where the host can
        // actually draw it, otherwise the capability can never be verified.
        setupAttempted.delete(input.session.session_id);
      }
      onCallCompleted(input);
      return deps.delegate_lifecycle?.onCallCompleted?.(input);
    }
  };

  return {
    call_resolver,
    lifecycle,
    stop() {
      stopped = true;
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    }
  };
}
