/**
 * OpenHands SDK `HostAdapter` implementation (DD-HOST-001, DD-HOST-060,
 * DD-HOST-100).
 *
 * The adapter is deliberately thin: it validates its own frozen inputs, reports
 * facts and evidence, and never decides budget, authorization, signals or jobs.
 * Where the OpenHands contract does not provide evidence, the result is an
 * explicit `unknown`, never a fabricated success:
 *
 * - `probe` cannot run a live host roundtrip inside the adapter process, so it
 *   returns `result="unknown"` with `proposed_status="unknown"` and only raises
 *   `evidence_stage` to `static` for capabilities the adapter statically
 *   handles. DD-HOST-060 records `input_capture` as verified/roundtrip for
 *   `host_contract`; that is host evidence, not a `product_adapter` claim.
 * - `inspectPending` returns `state="unknown"`. `Stop` fires only on
 *   `FINISHED`; pause, cancel and close do not fire it, `TaskManager` blocks
 *   synchronously and there is no subagent hook.
 * - `deliver` caps inclusion at `context_projection`: `additionalContext`
 *   enters `extended_content` and `to_llm_message`, and 1.56.0 has no final
 *   request-body hook. The diagnostic run's final answer failed, so context
 *   projection is not recorded as a successful delivery.
 * - `checkLoad` returns `state="unknown"` because plugin load happens on the
 *   first run/send of a new conversation and the adapter cannot read the host
 *   conversation's plugin graph.
 */

import { performance } from "node:perf_hooks";

import {
  canonicalHash,
  isHash,
  isId,
  isSourceRef,
  parseSourceRef,
  systemClock,
  type Clock,
  type Hash,
  type JsonValue,
  type SourceRef
} from "@evoplug/core";

import { HOST_RESERVED_CAPABILITY, hasStaticAdapterEvidence, isCapabilityName } from "./capabilities.js";
import type {
  AdapterDescriptor,
  AdapterResult,
  CapabilityBinding,
  CapabilityName,
  HostAdapter,
  HostAdapterError,
  HostAdapterErrorCode,
  HostDeliveryRequest,
  HostDeliveryResult,
  HostEventBindingDraft,
  HostProbeRecord,
  HostProbeRequest,
  InclusionLevel,
  LoadBoundary,
  LoadCheckRequest,
  LoadCheckResult,
  NormalizeHostEventInput,
  NormalizedHostEventDraft,
  PendingInspectRequest,
  PendingInspectResult,
  ProbeCapabilityResult,
  RegistrationConflict,
  RegistrationRequest,
  RegistrationResult,
  RegistrationTarget
} from "./contract.js";
import { adapterErr, adapterOk } from "./contract.js";
import {
  OPENHANDS_ADAPTER_DESCRIPTOR,
  OPENHANDS_DESCRIPTOR_HASH,
  OPENHANDS_DESCRIPTOR_REF,
  computeRegistrationHash,
  isOpenhandsConfigSpace,
  isOpenhandsConstructionPath,
  isOpenhandsMode,
  openhandsRegistrationTarget
} from "./descriptor.js";
import { normalizeOpenhandsEvent } from "./normalize.js";
import { OPENHANDS_ADAPTER_ID, OPENHANDS_ADAPTER_VERSION, OPENHANDS_HOST_ID, OPENHANDS_IMPLEMENTATION_HASH } from "./manifest.js";

/* ------------------------------------------------------------------ */
/* Host-side bridges injected by the composition root                  */
/* ------------------------------------------------------------------ */

export interface OpenhandsRegistrationApplyInput {
  readonly request: RegistrationRequest;
  readonly target: RegistrationTarget;
  readonly signal: AbortSignal;
}

export interface OpenhandsRegistrationApplyResult {
  readonly status: "applied" | "no_change";
  readonly written_hash: Hash;
  readonly diff_ref?: SourceRef;
}

/**
 * Writes the registration artifact into the host installation. The adapter
 * never resolves `artifact_ref` itself (`SourceRefPort` is not an adapter
 * dependency); the composition root supplies this port when a writable host
 * bridge exists.
 */
export interface OpenhandsRegistrationWriterPort {
  apply(input: OpenhandsRegistrationApplyInput): Promise<AdapterResult<OpenhandsRegistrationApplyResult>>;
}

export interface OpenhandsDeliverySubmitInput {
  readonly request: HostDeliveryRequest;
  readonly signal: AbortSignal;
}

export interface OpenhandsDeliverySubmitResult {
  readonly submitted: "true" | "false" | "unknown";
  readonly host_ack_ref?: SourceRef;
  readonly inclusion: InclusionLevel;
  /**
   * DD-HOST-100: a hook must not return `blocked` and `additionalContext`
   * together. When the host is observed to combine them, the capability detail
   * is `degraded` and no successful delivery may be recorded.
   */
  readonly block_with_context?: "supported" | "degraded" | "unknown";
}

/**
 * Bridges delivery to the OpenHands hook return (`UserPromptSubmit`
 * `additionalContext`). Without it, delivery is reported as unverified instead
 * of pretending the text reached the provider request.
 */
export interface OpenhandsDeliveryBridgePort {
  submit(input: OpenhandsDeliverySubmitInput): Promise<AdapterResult<OpenhandsDeliverySubmitResult>>;
}

export interface OpenhandsHostAdapterOptions {
  readonly clock?: Clock;
  readonly registrationWriter?: OpenhandsRegistrationWriterPort;
  readonly deliveryBridge?: OpenhandsDeliveryBridgePort;
}

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

interface DeadlineState {
  readonly monotonicDeadline: number;
  readonly startedUtc: number;
}

const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Highest inclusion level OpenHands can support from its hooks. `additionalContext`
 * is a context projection; there is no final body hook, so `provider_payload`
 * and `transport_body` claims are downgraded.
 */
const MAX_INCLUSION_LEVEL: InclusionLevel = "context_projection";

function isRequestId(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_REQUEST_ID_LENGTH;
}

function isDeadline(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isEmptyString(value: string): boolean {
  return value.trim().length === 0;
}

function bindingToJson(binding: CapabilityBinding): JsonValue {
  return {
    host_id: binding.host_id,
    source_pin: {
      host_version: binding.source_pin.host_version,
      host_version_kind: binding.source_pin.host_version_kind,
      source_commit: binding.source_pin.source_commit
    },
    binary_pin: {
      binary_version: binding.binary_pin.binary_version,
      binary_hash: binding.binary_pin.binary_hash
    },
    adapter_version: binding.adapter_version,
    subject: binding.subject,
    mode: binding.mode,
    config_space: binding.config_space,
    root_id: binding.root_id,
    construction_path: binding.construction_path,
    execution_environment: {
      os: binding.execution_environment.os,
      arch: binding.execution_environment.arch,
      isolation: binding.execution_environment.isolation
    },
    mapping: binding.mapping,
    ...(binding.backend_id === undefined ? {} : { backend_id: binding.backend_id })
  };
}

/** `binding_key = sha256(JCS(binding))`. */
export function computeCapabilityBindingKey(binding: CapabilityBinding): Hash {
  return canonicalHash(bindingToJson(binding));
}

const LOAD_BOUNDARY_VALUES: readonly LoadBoundary[] = Object.freeze([
  "next_request",
  "reload",
  "new_session",
  "restart",
  "unknown"
]);

/**
 * Inclusion levels the adapter is willing to report. Anything above
 * `context_projection` is capped because OpenHands exposes no final body.
 */
function capInclusion(level: InclusionLevel): { level: InclusionLevel; capped: boolean } {
  switch (level) {
    case "none":
    case "constructive":
    case "context_projection":
    case "unknown":
      return { level, capped: false };
    case "provider_payload":
    case "transport_body":
      return { level: MAX_INCLUSION_LEVEL, capped: true };
    default:
      return { level: "unknown", capped: true };
  }
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class OpenhandsHostAdapter implements HostAdapter {
  private readonly clock: Clock;
  private readonly registrationWriter: OpenhandsRegistrationWriterPort | null;
  private readonly deliveryBridge: OpenhandsDeliveryBridgePort | null;

  constructor(options: OpenhandsHostAdapterOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.registrationWriter = options.registrationWriter ?? null;
    this.deliveryBridge = options.deliveryBridge ?? null;
  }

  describe(): AdapterDescriptor {
    return OPENHANDS_ADAPTER_DESCRIPTOR;
  }

  normalizeEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
    return normalizeOpenhandsEvent(input);
  }

  async register(req: RegistrationRequest, signal: AbortSignal): Promise<AdapterResult<RegistrationResult>> {
    const begun = this.begin(req.deadline_ms, signal, req.artifact_ref);
    if (!begun.ok) {
      return begun;
    }
    const deadline = begun.value;
    const detail = req.artifact_ref;
    if (req.schema_version !== "rsi.registration_request/1") {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!isRequestId(req.request_id)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (req.host_id !== OPENHANDS_HOST_ID || req.adapter_id !== OPENHANDS_ADAPTER_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (!isOpenhandsMode(req.mode)) {
      return adapterErr(this.error("E_UNSUPPORTED", detail));
    }

    const conflicts: RegistrationConflict[] = [];
    const target = openhandsRegistrationTarget(req.target_id);
    if (req.adapter_version !== OPENHANDS_ADAPTER_VERSION || req.implementation_hash !== OPENHANDS_IMPLEMENTATION_HASH) {
      conflicts.push({ code: "E_ADAPTER_MISMATCH", detail_ref: detail });
    }
    if (!isOpenhandsConfigSpace(req.config_space)) {
      conflicts.push({ code: "E_CONFIG_SPACE_NOT_DECLARED", detail_ref: detail });
    }
    if (target === null) {
      conflicts.push({ code: "E_TARGET_NOT_DECLARED", detail_ref: detail });
    } else if (target.config_space !== req.config_space) {
      conflicts.push({ code: "E_CONFIG_SPACE_NOT_DECLARED", detail_ref: detail });
    }
    if (!isHash(req.artifact_hash)) {
      conflicts.push({ code: "E_ARTIFACT_MISMATCH", detail_ref: detail });
    }
    if (!isHash(req.registration_hash)) {
      conflicts.push({ code: "E_ADAPTER_MISMATCH", detail_ref: detail });
    } else {
      const recomputed = computeRegistrationHash({
        host_id: req.host_id,
        mode: req.mode,
        config_space: req.config_space,
        adapter_id: req.adapter_id,
        adapter_version: req.adapter_version,
        implementation_hash: req.implementation_hash,
        descriptor_hash: OPENHANDS_DESCRIPTOR_HASH,
        target_id: req.target_id,
        artifact_hash: req.artifact_hash,
        expected_previous_hash: req.expected_previous_hash
      });
      if (recomputed !== req.registration_hash) {
        conflicts.push({ code: "E_ADAPTER_MISMATCH", detail_ref: detail });
      }
    }
    if (!req.dry_run) {
      if (req.approval === null) {
        conflicts.push({ code: "E_APPROVAL_NOT_FOUND", detail_ref: detail });
      } else {
        if (!isId(req.approval.approval_id, "iap")) {
          conflicts.push({ code: "E_APPROVAL_NOT_FOUND", detail_ref: detail });
        }
        if (!isHash(req.approval.approval_hash)) {
          conflicts.push({ code: "E_APPROVAL_HASH", detail_ref: detail });
        }
      }
    }

    // DD-HOST-060 records no project trust gate for OpenHands. Isolation is
    // provided by `isolated_home` and the persistence directory, not by a host
    // trust decision, so registration itself does not require trust.
    const common: RegistrationResult = {
      request_id: req.request_id,
      registration_hash: req.registration_hash,
      status: "planned",
      load_boundary: target?.load_boundary ?? "unknown",
      requires_trust: false,
      trust_state: target === null ? "unknown" : "ready",
      conflicts: Object.freeze([...conflicts]),
      approval_ref: req.approval?.approval_id ?? null,
      approval_consumption_ref: null,
      evidence_refs: Object.freeze([]),
      completed_at: this.clock.utcNowMs()
    };

    if (conflicts.length > 0) {
      return adapterOk({ ...common, status: "conflict" });
    }
    if (req.dry_run) {
      return adapterOk(common);
    }
    if (target === null) {
      return adapterErr(this.error("E_INTERNAL", detail));
    }
    if (this.registrationWriter === null) {
      // No writable host bridge: the adapter cannot claim an apply.
      return adapterOk({ ...common, status: "unknown" });
    }
    const applied = await this.registrationWriter.apply({ request: req, target, signal });
    if (!applied.ok) {
      return applied;
    }
    const expired = this.finish(deadline, signal, detail);
    if (expired !== null) {
      return adapterErr(expired);
    }
    return adapterOk({
      ...common,
      status: applied.value.status,
      written_hash: applied.value.written_hash,
      ...(applied.value.diff_ref === undefined ? {} : { diff_ref: applied.value.diff_ref })
    });
  }

  async probe(req: HostProbeRequest, signal: AbortSignal): Promise<AdapterResult<HostProbeRecord>> {
    const detail = req.fixture_ref ?? OPENHANDS_DESCRIPTOR_REF;
    const begun = this.begin(req.deadline_ms, signal, detail);
    if (!begun.ok) {
      return begun;
    }
    const deadline = begun.value;
    if (req.probe_contract_version !== "host-probe/2") {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!isId(req.probe_id, "prb")) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (req.binding.host_id !== OPENHANDS_HOST_ID || req.host_binding.host_id !== OPENHANDS_HOST_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (!isOpenhandsMode(req.binding.mode) || !isOpenhandsConfigSpace(req.binding.config_space)) {
      return adapterErr(this.error("E_UNSUPPORTED", detail));
    }
    if (req.binding.adapter_version !== OPENHANDS_ADAPTER_VERSION) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    // DD-HOST-110: OpenHands requires one of the four construction paths and
    // the mode never implies it. A binding without an explicit path cannot
    // produce a probe record.
    if (!isOpenhandsConstructionPath(req.binding.construction_path)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (
      req.host_binding.adapter_id !== OPENHANDS_ADAPTER_ID ||
      req.host_binding.adapter_version !== OPENHANDS_ADAPTER_VERSION ||
      req.host_binding.implementation_hash !== OPENHANDS_IMPLEMENTATION_HASH ||
      req.host_binding.mode !== req.binding.mode ||
      req.host_binding.config_space !== req.binding.config_space
    ) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (req.capabilities.length === 0) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (new Set(req.capabilities).size !== req.capabilities.length) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    for (const capability of req.capabilities) {
      if (!isCapabilityName(capability)) {
        return adapterErr(this.error("E_SCHEMA", detail));
      }
      if (capability === HOST_RESERVED_CAPABILITY) {
        return adapterErr(this.error("E_SCHEMA", detail));
      }
    }
    if (req.probe_mode !== "read_only" && req.probe_mode !== "temp_fixture") {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (req.probe_mode === "temp_fixture" && req.fixture_ref === undefined) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }

    const capabilityResults: readonly ProbeCapabilityResult[] = req.capabilities.map((name) => ({
      name,
      proposed_status: "unknown",
      evidence_stage: hasStaticAdapterEvidence(name) ? "static" : "none",
      evidence_refs: Object.freeze([])
    }));
    const record: HostProbeRecord = {
      schema_version: "rsi.host_probe/2",
      probe_id: req.probe_id,
      probe_contract_version: "host-probe/2",
      target_kind: "host",
      binding: req.binding,
      binding_key: computeCapabilityBindingKey(req.binding),
      probe_mode: req.probe_mode,
      ...(req.fixture_ref === undefined ? {} : { fixture_ref: req.fixture_ref }),
      probe_action: "adapter_probe",
      assertions: Object.freeze([]),
      capability_results: Object.freeze([...capabilityResults]),
      result: "unknown",
      expected: "adapter_roundtrip_evidence",
      observed: "no_host_roundtrip_executed_in_adapter_process",
      evidence_refs: Object.freeze([]),
      duration_ms: Math.max(0, this.clock.utcNowMs() - deadline.startedUtc),
      checked_at: this.clock.utcNowMs()
    };
    const expired = this.finish(deadline, signal, detail);
    if (expired !== null) {
      return adapterErr(expired);
    }
    return adapterOk(record);
  }

  async inspectPending(
    req: PendingInspectRequest,
    signal?: AbortSignal
  ): Promise<AdapterResult<PendingInspectResult>> {
    const detail = req.boundary_event_ref;
    const begun = this.begin(req.deadline_ms, signal, detail);
    if (!begun.ok) {
      return begun;
    }
    if (!isRequestId(req.request_id)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!isSourceRef(req.boundary_event_ref)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (req.host_binding.host_id !== OPENHANDS_HOST_ID || req.host_binding.adapter_id !== OPENHANDS_ADAPTER_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    // DD-HOST-060: `Stop` fires only for `FINISHED`; pause, cancel and close do
    // not fire it. `TaskManager` blocks synchronously and there is no subagent
    // hook. A missing `Stop` therefore never proves that no pending work exists.
    return adapterOk({
      request_id: req.request_id,
      state: "unknown",
      signals: Object.freeze([
        { field: "background_work", state: "unknown" },
        { field: "conversation_state", state: "unknown" },
        { field: "stop_only_finished", state: "unknown" },
        { field: "subagent_hook", state: "unknown" },
        { field: "task_manager_sync", state: "unknown" }
      ]),
      fields_observed: Object.freeze([]),
      fields_unknown: Object.freeze([
        "background_work",
        "conversation_state",
        "pending_state",
        "stop_only_finished",
        "subagent_hook",
        "task_manager_sync"
      ]),
      evidence_refs: Object.freeze([])
    });
  }

  async deliver(req: HostDeliveryRequest, signal: AbortSignal): Promise<AdapterResult<HostDeliveryResult>> {
    const detail = req.content_ref;
    const begun = this.begin(req.deadline_ms, signal, detail);
    if (!begun.ok) {
      return begun;
    }
    const deadline = begun.value;
    if (isEmptyString(req.delivery_id) || isEmptyString(req.idempotency_key) || isEmptyString(req.nonce)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (isEmptyString(req.goal_version)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!Number.isSafeInteger(req.input_epoch) || req.input_epoch < 0) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!Number.isSafeInteger(req.max_chars) || req.max_chars <= 0) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (req.wait_mode !== "bounded" && req.wait_mode !== "strict") {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!isHash(req.content_hash) || !isSourceRef(req.content_ref)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    const parsed = parseSourceRef(req.content_ref);
    if (!parsed.ok || parsed.value.scheme !== "blob" || parsed.value.locator !== req.content_hash) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (req.host_binding.host_id !== OPENHANDS_HOST_ID || req.host_binding.adapter_id !== OPENHANDS_ADAPTER_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }

    if (this.deliveryBridge === null) {
      // The hook return happens in the host process on a later turn; without a
      // bridge the adapter cannot claim submission or inclusion.
      return adapterOk({
        delivery_id: req.delivery_id,
        submitted: "unknown",
        inclusion: { level: "unknown" },
        degraded: true,
        completed_at: this.clock.utcNowMs()
      });
    }
    const submitted = await this.deliveryBridge.submit({ request: req, signal });
    if (!submitted.ok) {
      return submitted;
    }
    const expired = this.finish(deadline, signal, detail);
    if (expired !== null) {
      return adapterErr(expired);
    }
    // A claimed `submitted=true` without a host acknowledgement is downgraded.
    // DD-HOST-100 additionally forbids recording a successful delivery when
    // `blocked` and `additionalContext` are combined.
    const blockWithContext = submitted.value.block_with_context ?? "unknown";
    const combined = blockWithContext === "degraded";
    const acknowledged = submitted.value.host_ack_ref !== undefined;
    const claimed = submitted.value.submitted;
    const effective: "true" | "false" | "unknown" =
      combined || (claimed === "true" && !acknowledged) ? "unknown" : claimed;
    const capped = capInclusion(submitted.value.inclusion);
    const degraded = combined || capped.capped || effective !== "true";
    return adapterOk({
      delivery_id: req.delivery_id,
      submitted: effective,
      ...(submitted.value.host_ack_ref === undefined ? {} : { host_ack_ref: submitted.value.host_ack_ref }),
      inclusion: { level: capped.level },
      degraded,
      completed_at: this.clock.utcNowMs()
    });
  }

  async checkLoad(req: LoadCheckRequest, signal: AbortSignal): Promise<AdapterResult<LoadCheckResult>> {
    const detail = OPENHANDS_DESCRIPTOR_REF;
    const begun = this.begin(req.deadline_ms, signal, detail);
    if (!begun.ok) {
      return begun;
    }
    if (!isRequestId(req.request_id)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (isEmptyString(req.object_ref) || isEmptyString(req.target_session_ref)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!isHash(req.expected_hash)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!LOAD_BOUNDARY_VALUES.includes(req.load_boundary)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    // Plugins are loaded lazily on the first run/send of a new conversation and
    // the adapter cannot read the host conversation's plugin graph.
    return adapterOk({
      request_id: req.request_id,
      state: "unknown",
      evidence_refs: Object.freeze([])
    });
  }

  /* -------------------------------------------------------------- */
  /* Deadline and error plumbing                                     */
  /* -------------------------------------------------------------- */

  private begin(
    deadlineMs: number,
    signal: AbortSignal | undefined,
    detailRef: SourceRef
  ): AdapterResult<DeadlineState> {
    if (signal !== undefined && signal.aborted) {
      return adapterErr(this.error("E_CANCELLED", detailRef));
    }
    if (!isDeadline(deadlineMs)) {
      return adapterErr(this.error("E_SCHEMA", detailRef));
    }
    const state: DeadlineState = {
      monotonicDeadline: performance.now() + deadlineMs,
      startedUtc: this.clock.utcNowMs()
    };
    if (this.clock.monotonicRemainingMs(state.monotonicDeadline) <= 0) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", detailRef, true));
    }
    return adapterOk(state);
  }

  private finish(
    deadline: DeadlineState,
    signal: AbortSignal | undefined,
    detailRef: SourceRef
  ): HostAdapterError | null {
    if (signal !== undefined && signal.aborted) {
      return this.error("E_CANCELLED", detailRef);
    }
    if (this.clock.monotonicRemainingMs(deadline.monotonicDeadline) <= 0) {
      return this.error("E_DEADLINE_EXCEEDED", detailRef, true);
    }
    return null;
  }

  private error(code: HostAdapterErrorCode, detailRef: SourceRef, retryable = false): HostAdapterError {
    return {
      code,
      retryable,
      detail_ref: detailRef,
      observed_at: this.clock.utcNowMs()
    };
  }
}

/** Creates the OpenHands adapter with optional host-side bridges. */
export function createOpenhandsHostAdapter(options: OpenhandsHostAdapterOptions = {}): OpenhandsHostAdapter {
  return new OpenhandsHostAdapter(options);
}

/** HostEventBindingDraft shape check shared by probe/deliver callers. */
export function isOpenhandsHostEventBinding(binding: HostEventBindingDraft): boolean {
  return binding.host_id === OPENHANDS_HOST_ID && binding.adapter_id === OPENHANDS_ADAPTER_ID;
}

/** Capability names accepted by `probe` (closed set minus the HOST-reserved name). */
export function isProbeableCapability(name: CapabilityName): boolean {
  return isCapabilityName(name) && name !== HOST_RESERVED_CAPABILITY;
}
