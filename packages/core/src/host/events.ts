/**
 * Event admission and normalization finalization (DD-TRG-004, DD-TRG-010).
 *
 * Phase A runs before any blob is written; phase B runs after the payload is
 * frozen and the adapter's pure `normalizeEvent` returned. Each failure path
 * appends exactly one `HostEventRejection` and never fabricates an EventDraft.
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { JsonValue } from "../json.js";
import { compareUtf8 } from "../canonical.js";
import { makeErrorEnvelope, type ErrorEnvelope } from "../errors.js";
import { err, ok, type Result } from "../result.js";
import type { SourceRef } from "../source-ref.js";
import { isHostId } from "../generated/host-vocabulary.js";
import type {
  ContentUpload as EventDraftContentUpload,
  EventDraft,
  EventPayload,
  HumanAttestation as EventDraftHumanAttestation,
  NativeAttribution,
  Origin,
  OriginBasis,
  TriggerLineage
} from "../generated/types/event-draft.js";
import { eventIdentityKey } from "./keys.js";
import type {
  ActiveAdapterRegistration,
  AdapterEventContract,
  AuthenticatedAdapterPeer,
  HostEventBinding,
  HostEventBindingDraft,
  HostEventRejection,
  NativeMessageKind,
  NormalizedHostEvent,
  NormalizedHostEventDraft,
  NormalizedHostEventPayload,
  RawHostEventUpload,
  StableEventScope,
  TriggerKind
} from "./types.js";
import type { HostEventRejectionReason } from "./errors.js";

type IdentityQuality = "strong" | "weak" | "missing";

/** Identity strength from the presence of a session and a native event id. */
export function deriveIdentityQuality(input: {
  native_session_id: string | undefined;
  native_event_id: string | undefined;
  payload_retrievable: boolean;
}): IdentityQuality {
  if (!input.payload_retrievable || input.native_session_id === undefined || input.native_session_id.length === 0) {
    return "missing";
  }
  if (input.native_event_id !== undefined && input.native_event_id.length > 0) {
    return "strong";
  }
  return "weak";
}

/** Sorts fatal-first, then field and code by UTF-8; removes duplicate pairs. */
export function sortRejections(
  rejections: NormalizedHostEventDraft["rejections"]
): NormalizedHostEventDraft["rejections"] {
  const seen = new Set<string>();
  const unique: NormalizedHostEventDraft["rejections"] = [];
  for (const rejection of rejections) {
    const key = `${rejection.field}\u0000${rejection.code}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(rejection);
  }
  unique.sort((left, right) => {
    if (left.fatal !== right.fatal) {
      return left.fatal ? -1 : 1;
    }
    const fieldOrder = compareUtf8(left.field, right.field);
    if (fieldOrder !== 0) {
      return fieldOrder;
    }
    return compareUtf8(left.code, right.code);
  });
  return unique;
}

const BOUNDARY_KINDS: readonly TriggerKind[] = ["task_boundary_candidate", "task_stable", "session_end"];

/** Checks `kind_candidates` against the payload kind (DD-TRG-004 step 1). */
function kindCandidatesValid(
  payload: NormalizedHostEventPayload,
  candidates: readonly TriggerKind[]
): boolean {
  const unique = new Set(candidates);
  if (unique.size !== candidates.length) {
    return false;
  }
  switch (payload.kind) {
    case "input.received":
      return candidates.length === 1 && candidates[0] === "new_input";
    case "tool.call":
    case "tool.result":
      return candidates.length === 1 && candidates[0] === "tool_fact";
    case "host.boundary":
      return candidates.every((kind) => BOUNDARY_KINDS.includes(kind));
    case "compaction.observed":
      return candidates.length === 1 && candidates[0] === "compaction";
    case "input.retry":
    case "agent.message":
    case "subagent.started":
    case "subagent.ended":
    case "delivery.receipt":
    case "feedback.observed":
    case "host.unclassified":
      return candidates.length === 0;
  }
}

/** True when the contract family is input-only. */
export function isInputContract(contract: AdapterEventContract): boolean {
  return contract.canonical_kinds.includes("new_input");
}

interface FinalizeInput {
  draft: NormalizedHostEventDraft;
  normalized_id: Id<"nev">;
  raw_event_ref: import("../source-ref.js").SourceRef;
  payload_hash: Hash;
  normalized_at: number;
  source_seq: number | null;
  receipt_seq: number;
  event_scope?: StableEventScope;
  payload_retrievable: boolean;
}

const DRAFT_KEYS = [
  "schema_version",
  "host_binding",
  "native_kind",
  "kind_candidates",
  "correlation",
  "origin_hint",
  "input_source_label",
  "is_auto_turn",
  "payload",
  "attribution",
  "required_capabilities",
  "rejections"
] as const;

const HOST_BINDING_DRAFT_KEYS = [
  "host_id",
  "host_version",
  "adapter_id",
  "adapter_version",
  "implementation_hash",
  "mode",
  "config_space",
  "host_event",
  "native_session_id",
  "native_turn_id",
  "native_message_id",
  "native_event_id",
  "stream_id",
  "source_seq_hint",
  "native_occurrence_id",
  "retry_of",
  "occurred_at",
  "received_at"
] as const;

const CORRELATION_KEYS = ["parent_call_id", "correlation_id", "task_hint", "branch_hint"] as const;
const ATTRIBUTION_KEYS = ["sender", "typed_user_message", "typed_field_names"] as const;
const REJECTION_KEYS = ["code", "field", "detail_ref", "fatal"] as const;

const PAYLOAD_KEYS: Readonly<Record<NormalizedHostEventPayload["kind"], readonly string[]>> = {
  "input.received": ["kind", "text_ref", "directive_strength", "parent_native_id"],
  "input.retry": ["kind", "retry_of_native_event_id", "reason_code"],
  "agent.message": ["kind", "text_ref", "phase"],
  "tool.call": ["kind", "tool_call_id", "parent_tool_call_id", "tool_name", "arguments_ref"],
  "tool.result": ["kind", "tool_call_id", "status", "text_ref"],
  "host.boundary": [
    "kind",
    "boundary",
    "host_stable_event",
    "retry_pending",
    "async_work",
    "queue_empty",
    "background_refs",
    "exit_budget_ms"
  ],
  "compaction.observed": ["kind", "compaction_kind", "checkpoint_ref", "omitted_range"],
  "subagent.started": ["kind", "native_agent_id", "relation", "parent_native_event_id"],
  "subagent.ended": ["kind", "native_agent_id", "status", "summary_ref"],
  "delivery.receipt": ["kind", "delivery_id", "axis", "evidence_kind", "evidence_ref", "observed_at"],
  "feedback.observed": ["kind", "feedback_kind", "text_ref", "target_issue_id"],
  "host.unclassified": ["kind", "native_type", "content_ref", "reason_code"]
};

/** True when `value` only carries keys from `allowed`. */
function isClosedObject(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const allowedSet = new Set<string>(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

/**
 * Closed-schema check for a normalized draft (DD-TRG-010). An extra property
 * rejects the whole event; it is never silently dropped.
 */
function draftSchemaClosed(draft: NormalizedHostEventDraft): boolean {
  if (!isClosedObject(draft, DRAFT_KEYS)) {
    return false;
  }
  if (!isClosedObject(draft.host_binding, HOST_BINDING_DRAFT_KEYS)) {
    return false;
  }
  if (!isClosedObject(draft.correlation, CORRELATION_KEYS)) {
    return false;
  }
  if (!isClosedObject(draft.attribution, ATTRIBUTION_KEYS)) {
    return false;
  }
  const payloadKind = draft.payload.kind;
  const payloadKeys = PAYLOAD_KEYS[payloadKind];
  if (payloadKeys === undefined || !isClosedObject(draft.payload, payloadKeys)) {
    return false;
  }
  return draft.rejections.every((rejection) => isClosedObject(rejection, REJECTION_KEYS));
}

/**
 * Finalizes a normalized draft. Fatal rejections return the first fatal reason;
 * the caller writes one `HostEventRejection` and stops.
 */
export function finalizeNormalizedHostEvent(
  input: FinalizeInput
): { ok: true; event: NormalizedHostEvent } | { ok: false; reason: HostEventRejectionReason } {
  const draft = input.draft;
  if (draft.schema_version !== "rsi.normalized_host_event/1") {
    return { ok: false, reason: "E_ENUM_UNKNOWN" };
  }
  if (!draftSchemaClosed(draft)) {
    return { ok: false, reason: "E_ENUM_UNKNOWN" };
  }
  if (!kindCandidatesValid(draft.payload, draft.kind_candidates)) {
    return { ok: false, reason: "E_ENUM_UNKNOWN" };
  }
  const rejections = sortRejections(draft.rejections);
  const fatal = rejections.find((rejection) => rejection.fatal);
  if (fatal !== undefined) {
    return { ok: false, reason: fatal.code };
  }
  const binding = finalizeHostEventBinding(
    draft.host_binding,
    input.source_seq,
    draft.native_kind,
    input.receipt_seq
  );
  if (binding === null) {
    return { ok: false, reason: "E_IDENTITY_MISSING" };
  }
  const event: NormalizedHostEvent = {
    schema_version: draft.schema_version,
    host_binding: binding,
    native_kind: draft.native_kind,
    kind_candidates: draft.kind_candidates,
    correlation: draft.correlation,
    origin_hint: draft.origin_hint,
    is_auto_turn: draft.is_auto_turn,
    payload: draft.payload,
    attribution: draft.attribution,
    required_capabilities: draft.required_capabilities,
    rejections,
    normalized_id: input.normalized_id,
    raw_event_ref: input.raw_event_ref,
    payload_hash: input.payload_hash,
    identity_quality: deriveIdentityQuality({
      native_session_id: draft.host_binding.native_session_id,
      native_event_id: draft.host_binding.native_event_id,
      payload_retrievable: input.payload_retrievable
    }),
    normalized_at: input.normalized_at
  };
  if (input.event_scope !== undefined) {
    event.event_scope = input.event_scope;
  }
  if (draft.input_source_label !== undefined) {
    event.input_source_label = draft.input_source_label;
  }
  return { ok: true, event };
}

/**
 * Produces the final binding. `receipt_seq` is never known at normalize time;
 * the caller supplies it after `event.ingest` returns.
 */
export function finalizeHostEventBinding(
  draft: HostEventBindingDraft,
  source_seq: number | null,
  native_kind: NativeMessageKind,
  receipt_seq: number
): HostEventBinding | null {
  if (typeof draft.host_id !== "string" || typeof draft.mode !== "string") {
    return null;
  }
  if (typeof draft.stream_id !== "string") {
    return null;
  }
  if (draft.native_session_id === undefined || draft.native_session_id.length === 0) {
    return null;
  }
  const identityKey = eventIdentityKey({
    host_id: draft.host_id,
    config_space: draft.config_space,
    mode: draft.mode,
    native_session_id: draft.native_session_id ?? "",
    native_kind,
    host_event: draft.host_event,
    native_message_id: draft.native_message_id ?? null,
    native_event_id: draft.native_event_id ?? null,
    source_seq,
    occurred_at: draft.occurred_at ?? draft.received_at
  });
  const binding: HostEventBinding = {
    host_id: draft.host_id,
    host_version: draft.host_version,
    adapter_id: draft.adapter_id,
    adapter_version: draft.adapter_version,
    implementation_hash: draft.implementation_hash,
    mode: draft.mode,
    config_space: draft.config_space,
    host_event: draft.host_event,
    stream_id: draft.stream_id,
    receipt_seq,
    event_identity_key: identityKey,
    received_at: draft.received_at
  };
  if (draft.native_session_id !== undefined) {
    binding.native_session_id = draft.native_session_id;
  }
  if (draft.native_turn_id !== undefined) {
    binding.native_turn_id = draft.native_turn_id;
  }
  if (draft.native_message_id !== undefined) {
    binding.native_message_id = draft.native_message_id;
  }
  if (draft.native_event_id !== undefined) {
    binding.native_event_id = draft.native_event_id;
  }
  if (source_seq !== null) {
    binding.source_seq = source_seq;
  }
  if (draft.native_occurrence_id !== undefined) {
    binding.native_occurrence_id = draft.native_occurrence_id;
  }
  if (draft.retry_of !== undefined) {
    binding.retry_of = draft.retry_of;
  }
  if (draft.occurred_at !== undefined) {
    binding.occurred_at = draft.occurred_at;
  }
  return binding;
}

type SourceSeqSelection =
  | { ok: true; source_seq: number | null; used_hint: boolean }
  | { ok: false; reason: "E_EVENT_IDENTITY_MISMATCH" };

/**
 * `source_seq` priority: a native message id suppresses any hint; otherwise a
 * safe non-negative hint wins; otherwise the caller allocates an occurrence.
 */
export function selectSourceSeq(input: {
  native_message_id?: string;
  source_seq_hint?: number;
  occurrence_seq?: number;
}): SourceSeqSelection {
  if (input.native_message_id !== undefined && input.native_message_id.length > 0) {
    return { ok: true, source_seq: null, used_hint: false };
  }
  if (input.source_seq_hint !== undefined) {
    if (
      typeof input.source_seq_hint !== "number" ||
      !Number.isSafeInteger(input.source_seq_hint) ||
      input.source_seq_hint < 0
    ) {
      return { ok: false, reason: "E_EVENT_IDENTITY_MISMATCH" };
    }
    return { ok: true, source_seq: input.source_seq_hint, used_hint: true };
  }
  if (input.occurrence_seq !== undefined) {
    return { ok: true, source_seq: input.occurrence_seq, used_hint: false };
  }
  return { ok: true, source_seq: null, used_hint: false };
}

/** Builds the single rejection record for a failed admission. */
export function buildHostEventRejection(input: {
  rejection_id: string;
  phase: "A" | "B";
  raw_event_ref: import("../source-ref.js").SourceRef | null;
  host_binding: HostEventBindingDraft | null;
  reason: HostEventRejectionReason;
  field: string;
  detail_ref: import("../source-ref.js").SourceRef | null;
  created_at: number;
}): HostEventRejection {
  if (input.phase === "A" && (input.raw_event_ref !== null || input.host_binding !== null || input.detail_ref !== null)) {
    throw new RangeError("phase A rejection must not carry raw/binding/detail refs");
  }
  if (input.phase === "B" && (input.raw_event_ref === null || input.host_binding === null || input.detail_ref === null)) {
    throw new RangeError("phase B rejection requires raw/binding/detail refs");
  }
  return {
    schema_version: "rsi.host_event_rejection/1",
    rejection_id: input.rejection_id,
    phase: input.phase,
    raw_event_ref: input.raw_event_ref,
    host_binding: input.host_binding,
    reason: input.reason,
    field: input.field,
    detail_ref: input.detail_ref,
    created_at: input.created_at
  };
}

interface PhaseAInput {
  peer: AuthenticatedAdapterPeer;
  registration: ActiveAdapterRegistration | null;
  snapshot_descriptor_hash: Hash | null;
  upload: RawHostEventUpload;
  scope_claim?: StableEventScope;
}

/**
 * Phase A admission, steps 1–5. Returns the first failure only; no blob or CAS
 * is written on this path.
 */
export function admitPhaseA(input: PhaseAInput):
  | { ok: true; contract: AdapterEventContract; input_family: boolean }
  | { ok: false; reason: HostEventRejectionReason; field: string } {
  const registration = input.registration;
  if (
    registration === null ||
    registration.registration_hash !== input.peer.registration_hash ||
    registration.adapter_id !== input.peer.adapter_id ||
    registration.host_id !== input.peer.host_id ||
    registration.mode !== input.peer.mode ||
    registration.config_space !== input.peer.config_space ||
    registration.adapter_version !== input.peer.adapter_version ||
    registration.implementation_hash !== input.peer.implementation_hash ||
    registration.descriptor_hash !== input.peer.descriptor_hash ||
    input.snapshot_descriptor_hash === null ||
    input.snapshot_descriptor_hash !== registration.descriptor_hash
  ) {
    return { ok: false, reason: "E_EVENT_ADAPTER_UNBOUND", field: "peer" };
  }
  const upload = input.upload;
  if (
    upload.adapter_id !== input.peer.adapter_id ||
    upload.host_id !== input.peer.host_id ||
    upload.mode !== input.peer.mode ||
    upload.config_space !== input.peer.config_space
  ) {
    return { ok: false, reason: "E_EVENT_ADAPTER_UNBOUND", field: "upload" };
  }
  if (!registration.config_spaces.includes(upload.config_space)) {
    return { ok: false, reason: "E_EVENT_CONFIG_SPACE_UNBOUND", field: "config_space" };
  }
  const matches = registration.event_contracts.filter((contract) => contract.host_event === upload.host_event);
  if (matches.length !== 1) {
    return { ok: false, reason: "E_EVENT_CONTRACT_VIOLATION", field: "host_event" };
  }
  const contract = matches[0];
  if (contract === undefined) {
    return { ok: false, reason: "E_EVENT_CONTRACT_VIOLATION", field: "host_event" };
  }
  const inputFamily = isInputContract(contract);
  if (inputFamily) {
    if (input.scope_claim !== undefined) {
      return { ok: false, reason: "E_EVENT_SCOPE_FORBIDDEN", field: "scope_claim" };
    }
  } else if (input.scope_claim === undefined) {
    return { ok: false, reason: "E_EVENT_SCOPE_UNBOUND", field: "scope_claim" };
  }
  return { ok: true, contract, input_family: inputFamily };
}

/** Phase B step 6: native kind and candidates must match the contract. */
export function draftMatchesContract(
  draft: NormalizedHostEventDraft,
  contract: AdapterEventContract
): boolean {
  if (draft.native_kind !== contract.native_kind) {
    return false;
  }
  if (draft.kind_candidates.length !== contract.canonical_kinds.length) {
    return false;
  }
  return draft.kind_candidates.every((kind, index) => kind === contract.canonical_kinds[index]);
}

/** Phase B step 7: adapter binding must match the raw event field by field. */
export function draftBindingMatchesRaw(
  draft: NormalizedHostEventDraft,
  raw: {
    host_id: string;
    mode: string;
    config_space: string;
    host_event: string;
    received_at: number;
    native_ids: {
      session_id?: string;
      turn_id?: string;
      message_id?: string;
      event_id?: string;
    };
  }
): boolean {
  const binding = draft.host_binding;
  return (
    binding.host_id === raw.host_id &&
    binding.mode === raw.mode &&
    binding.config_space === raw.config_space &&
    binding.host_event === raw.host_event &&
    binding.received_at === raw.received_at &&
    binding.native_session_id === raw.native_ids.session_id &&
    binding.native_turn_id === raw.native_ids.turn_id &&
    binding.native_message_id === raw.native_ids.message_id &&
    binding.native_event_id === raw.native_ids.event_id
  );
}

/**
 * `host.boundary` pending-work claim: `true` when any component says pending,
 * `false` only when all resolved components are idle, and `unknown` when any
 * component is an `UnknownFact`.
 */
export function boundaryPendingClaim(payload: Extract<NormalizedHostEventPayload, { kind: "host.boundary" }>):
  | boolean
  | "unknown" {
  const components = [payload.retry_pending, payload.async_work, payload.queue_empty];
  for (const component of components) {
    if (typeof component !== "boolean") {
      return "unknown";
    }
  }
  const retryPending = payload.retry_pending === true;
  const asyncWork = payload.async_work === true;
  const queueEmpty = payload.queue_empty === true;
  return retryPending || asyncWork || !queueEmpty;
}

/** Maps a boundary payload to `host.unclassified` when any fact is unknown. */
export function boundaryIsMappable(payload: Extract<NormalizedHostEventPayload, { kind: "host.boundary" }>): boolean {
  return boundaryPendingClaim(payload) !== "unknown";
}

/**
 * Stable promotion needs the canonical boundary payload. A boundary whose facts
 * are unknown is recorded as `host.unclassified` by `mapPayload`; keeping that
 * observation must never turn it into a stable boundary later in the trigger
 * chain.
 */
export function stableBoundaryEligible(payload: EventPayload): boolean {
  return payload.kind === "host.boundary" && !payload.pending_work_claimed;
}

/* ------------------------------------------------------------------ */
/* NormalizedHostEvent -> EventDraft mapping (DD-TRG-004)              */
/* ------------------------------------------------------------------ */

interface EventDraftResolvers {
  /** Retrieves a `text_ref`/`content_ref` as strict UTF-8 `ContentUpload`. */
  resolveContent(ref: SourceRef): Promise<Result<EventDraftContentUpload, ErrorEnvelope>>;
  /** Retrieves `tool.call.arguments_ref` as a parsed JSON value. */
  resolveJsonArguments(ref: SourceRef): Promise<Result<JsonValue, ErrorEnvelope>>;
  /** Resolves `input.retry.retry_of_native_event_id` to the original event key. */
  resolveRetryEventKey?(input: {
    native_session_id: string;
    retry_of_native_event_id: string;
  }): Promise<Result<Hash, ErrorEnvelope>>;
  /** Resolves an FND `parent_event_id` for `subagent.started`. */
  resolveParentEventId?(input: {
    native_session_id: string;
    parent_native_event_id: string;
  }): Promise<Result<string | null, ErrorEnvelope>>;
}

interface EventDraftOriginInput {
  origin: Origin;
  origin_basis: OriginBasis;
  human_attestation?: EventDraftHumanAttestation;
  trigger_lineage: TriggerLineage;
}

interface EventDraftMappingInput {
  event: NormalizedHostEvent;
  origin: EventDraftOriginInput;
  resolvers: EventDraftResolvers;
}

function mapError(code: `E_${string}`, path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: code === "E_EVIDENCE_UNKNOWN" ? "source" : code === "E_IO" ? "storage" : "schema",
    message_key: `error.${code.toLowerCase()}`,
    stage: "host_event_draft_map",
    details: { kind: "field", path, rule }
  });
}

function isUnknownValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "unknown" &&
    typeof (value as { reason_code?: unknown }).reason_code === "string"
  );
}

async function mapPayload(
  event: NormalizedHostEvent,
  resolvers: EventDraftResolvers
): Promise<Result<EventPayload, ErrorEnvelope>> {
  const payload = event.payload;
  const session = event.host_binding.native_session_id ?? "";
  switch (payload.kind) {
    case "input.received": {
      const content = await resolvers.resolveContent(payload.text_ref);
      if (!content.ok) return content;
      return ok({
        kind: "input.received",
        content: content.value,
        directive_strength: payload.directive_strength,
        ...(payload.parent_native_id !== undefined ? { parent_native_id: payload.parent_native_id } : {})
      });
    }
    case "input.retry": {
      if (resolvers.resolveRetryEventKey === undefined) {
        return err(mapError("E_EVIDENCE_UNKNOWN", "retry_of_native_event_id", "resolver_unavailable"));
      }
      const key = await resolvers.resolveRetryEventKey({
        native_session_id: session,
        retry_of_native_event_id: payload.retry_of_native_event_id
      });
      if (!key.ok) return key;
      return ok({
        kind: "input.retry",
        retry_of_event_key: key.value,
        reason_code: payload.reason_code
      });
    }
    case "agent.message": {
      const content = await resolvers.resolveContent(payload.text_ref);
      if (!content.ok) return content;
      return ok({ kind: "agent.message", content: content.value, phase: payload.phase });
    }
    case "tool.call": {
      const args = await resolvers.resolveJsonArguments(payload.arguments_ref);
      if (!args.ok) return args;
      return ok({
        kind: "tool.call",
        tool_call_id: payload.tool_call_id,
        tool_name: payload.tool_name,
        arguments_json: args.value,
        ...(payload.parent_tool_call_id !== undefined ? { parent_tool_call_id: payload.parent_tool_call_id } : {})
      });
    }
    case "tool.result": {
      const content = await resolvers.resolveContent(payload.text_ref);
      if (!content.ok) return content;
      return ok({
        kind: "tool.result",
        tool_call_id: payload.tool_call_id,
        status: payload.status,
        content: content.value
      });
    }
    case "host.boundary": {
      if (
        isUnknownValue(payload.retry_pending) ||
        isUnknownValue(payload.async_work) ||
        isUnknownValue(payload.queue_empty)
      ) {
        const content = await resolvers.resolveContent(event.raw_event_ref);
        if (!content.ok) return content;
        return ok({
          kind: "host.unclassified",
          native_type: "host_event",
          content: content.value,
          reason_code: "no_mapping"
        });
      }
      const pending =
        payload.retry_pending === true ||
        payload.async_work === true ||
        payload.queue_empty === false;
      return ok({
        kind: "host.boundary",
        boundary: payload.boundary,
        pending_work_claimed: pending
      });
    }
    case "compaction.observed": {
      return ok({
        kind: "compaction.observed",
        compaction_kind: payload.compaction_kind,
        ...(payload.checkpoint_ref !== undefined ? { checkpoint_ref: payload.checkpoint_ref } : {}),
        ...(payload.omitted_range !== undefined ? { omitted_range: payload.omitted_range } : {})
      });
    }
    case "subagent.started": {
      let parentEventId: string | null = null;
      if (payload.parent_native_event_id !== undefined && resolvers.resolveParentEventId !== undefined) {
        const resolved = await resolvers.resolveParentEventId({
          native_session_id: session,
          parent_native_event_id: payload.parent_native_event_id
        });
        if (!resolved.ok) return resolved;
        parentEventId = resolved.value;
      }
      return ok({
        kind: "subagent.started",
        native_agent_id: payload.native_agent_id,
        relation: payload.relation,
        ...(parentEventId !== null ? { parent_event_id: parentEventId } : {})
      });
    }
    case "subagent.ended": {
      return ok({
        kind: "subagent.ended",
        native_agent_id: payload.native_agent_id,
        status: payload.status,
        ...(payload.summary_ref !== undefined ? { summary_ref: payload.summary_ref } : {})
      });
    }
    case "delivery.receipt": {
      return ok({
        kind: "delivery.receipt",
        delivery_id: payload.delivery_id,
        axis: payload.axis,
        evidence_kind: payload.evidence_kind,
        observed_at: payload.observed_at,
        ...(payload.evidence_ref !== undefined ? { evidence_ref: payload.evidence_ref } : {})
      });
    }
    case "feedback.observed": {
      const content = await resolvers.resolveContent(payload.text_ref);
      if (!content.ok) return content;
      return ok({
        kind: "feedback.observed",
        feedback_kind: payload.feedback_kind,
        content: content.value,
        ...(payload.target_issue_id !== undefined ? { target_issue_id: payload.target_issue_id } : {})
      });
    }
    case "host.unclassified": {
      const content = await resolvers.resolveContent(payload.content_ref);
      if (!content.ok) return content;
      return ok({
        kind: "host.unclassified",
        native_type: payload.native_type,
        content: content.value,
        reason_code: payload.reason_code
      });
    }
  }
}

/**
 * Adapters report the FND closed `NativeMessageKind`; the HOST payload union is
 * used as a fallback so a raw normalized value still maps deterministically.
 */
function eventDraftNativeKind(value: string): EventDraft["native_kind"] {
  if (
    value === "message" ||
    value === "turn" ||
    value === "event" ||
    value === "prompt" ||
    value === "other"
  ) {
    return value;
  }
  switch (value) {
    case "input.received":
    case "input.retry":
      return "prompt";
    case "agent.message":
      return "message";
    case "tool.call":
    case "tool.result":
    case "compaction.observed":
    case "subagent.started":
    case "subagent.ended":
    case "delivery.receipt":
    case "feedback.observed":
    case "host.unclassified":
      return "event";
    default:
      return "other";
  }
}

function eventDraftScope(
  scope: StableEventScope
): Result<NonNullable<EventDraft["scope_claim"]>, ErrorEnvelope> {
  const hostId = scope.host_id;
  if (!isHostId(hostId)) {
    return err(mapError("E_SCHEMA", "scope_claim.host_id", "host_id"));
  }
  return ok({
    schema_version: "rsi.stable_event_scope/1",
    host_id: hostId,
    config_space: scope.config_space,
    native_session_id: scope.native_session_id,
    task_id: scope.task_id,
    branch_id: scope.branch_id,
    input_epoch: scope.input_epoch,
    goal_version: scope.goal_version,
    config_version: scope.config_version,
    watermark: scope.watermark,
    scope_hash: scope.scope_hash
  });
}

/**
 * Builds the FND `EventDraft` from a finalized `NormalizedHostEvent`. Content
 * and cross-event references are resolved through the injected resolver; a
 * failure returns the resolver error and no partial draft.
 */
export async function normalizeToEventDraft(
  input: EventDraftMappingInput
): Promise<Result<EventDraft, ErrorEnvelope>> {
  const { event, origin, resolvers } = input;
  const binding = event.host_binding;
  const sessionId = binding.native_session_id;
  if (sessionId === undefined || sessionId.length === 0) {
    return err(mapError("E_SCHEMA", "native_session_id", "required"));
  }
  if (origin.origin !== "human" && origin.human_attestation !== undefined) {
    return err(mapError("E_SCHEMA", "human_attestation", "only_for_human"));
  }
  if (origin.origin === "human" && origin.human_attestation === undefined) {
    return err(mapError("E_SCHEMA", "human_attestation", "required_for_human"));
  }
  const payload = await mapPayload(event, resolvers);
  if (!payload.ok) {
    return payload;
  }
  let scopeClaim: NonNullable<EventDraft["scope_claim"]> | undefined;
  if (event.event_scope !== undefined) {
    const mappedScope = eventDraftScope(event.event_scope);
    if (!mappedScope.ok) {
      return mappedScope;
    }
    scopeClaim = mappedScope.value;
  }
  const highlightsAgentOrigin =
    origin.origin === "agent" ||
    origin.origin === "evaluator" ||
    origin.origin === "system" ||
    origin.origin === "host";
  const typedFieldNames = Array.from(new Set(event.attribution.typed_field_names)).sort(compareUtf8);
  const attribution: NativeAttribution = {
    sender: event.attribution.sender,
    typed_user_message: highlightsAgentOrigin ? false : event.attribution.typed_user_message,
    typed_field_names: typedFieldNames
  };
  const draft: EventDraft = {
    schema_version: "rsi.event_draft/1",
    host_id: binding.host_id,
    config_space: binding.config_space,
    mode: binding.mode,
    native_session_id: sessionId,
    host_event: binding.host_event,
    native_kind: eventDraftNativeKind(event.native_kind),
    occurred_at: binding.occurred_at ?? binding.received_at,
    event_identity_key: binding.event_identity_key,
    origin: origin.origin,
    origin_basis: origin.origin_basis,
    trigger_lineage: origin.trigger_lineage,
    attribution,
    payload: payload.value
  };
  const withOptionals: EventDraft = {
    ...draft,
    ...(binding.native_message_id !== undefined ? { native_message_id: binding.native_message_id } : {}),
    ...(binding.native_event_id !== undefined ? { native_event_id: binding.native_event_id } : {}),
    ...(binding.source_seq !== undefined ? { source_seq: binding.source_seq } : {}),
    ...(scopeClaim !== undefined ? { scope_claim: scopeClaim } : {}),
    ...(origin.human_attestation !== undefined ? { human_attestation: origin.human_attestation } : {})
  };
  return ok(withOptionals);
}
