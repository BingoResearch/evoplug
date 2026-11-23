/**
 * Pi `HostAdapter` implementation (DD-HOST-001, DD-HOST-010, DD-HOST-100).
 *
 * The adapter is deliberately thin: it validates its own frozen inputs, reports
 * facts and evidence, and never decides budget, authorization, signals or jobs.
 * Where the Pi contract does not provide evidence, the result is an explicit
 * `unknown`, never a fabricated success:
 *
 * - `probe` cannot run a live host roundtrip inside the adapter process, so it
 *   returns `result="unknown"` with `proposed_status="unknown"` and only raises
 *   `evidence_stage` to `static` for capabilities the adapter statically handles;
 * - `inspectPending` returns `state="unknown"` because Pi has no native async
 *   work field and `agent_settled` does not prove external completion;
 * - `deliver` returns `submitted="unknown"` unless a host-side delivery bridge
 *   is injected, which matches `submitted_not_verified` and is never retried;
 * - `checkLoad` returns `state="unknown"` because the adapter cannot read the
 *   host session's extension graph.
 */



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

import { HOST_RESERVED_CAPABILITY, isCapabilityName } from "./capabilities.js";
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
  PI_ADAPTER_DESCRIPTOR,
  PI_DESCRIPTOR_HASH,
  PI_DESCRIPTOR_REF,
  computeRegistrationHash,
  isPiConfigSpace,
  isPiMode,
  piRegistrationTarget
} from "./descriptor.js";
import { hasStaticAdapterEvidence } from "./capabilities.js";
import { normalizePiEvent } from "./normalize.js";
import { PI_ADAPTER_ID, PI_ADAPTER_VERSION, PI_HOST_ID, PI_IMPLEMENTATION_HASH } from "./manifest.js";

/* ------------------------------------------------------------------ */
/* Host-side bridges injected by the composition root                  */
/* ------------------------------------------------------------------ */

export interface PiRegistrationApplyInput {
  readonly request: RegistrationRequest;
  readonly target: RegistrationTarget;
  readonly signal: AbortSignal;
}

export interface PiRegistrationApplyResult {
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
export interface PiRegistrationWriterPort {
  apply(input: PiRegistrationApplyInput): Promise<AdapterResult<PiRegistrationApplyResult>>;
}

export interface PiDeliverySubmitInput {
  readonly request: HostDeliveryRequest;
  readonly signal: AbortSignal;
}

export interface PiDeliverySubmitResult {
  readonly submitted: "true" | "false" | "unknown";
  readonly host_ack_ref?: SourceRef;
  readonly inclusion: InclusionLevel;
}

/**
 * Bridges delivery to the Pi hook return (`before_agent_start`/`context`).
 * Without it, delivery is reported as unverified instead of pretending the
 * text reached the provider request.
 */
export interface PiDeliveryBridgePort {
  submit(input: PiDeliverySubmitInput): Promise<AdapterResult<PiDeliverySubmitResult>>;
}

export interface PiHostAdapterOptions {
  readonly clock?: Clock;
  readonly registrationWriter?: PiRegistrationWriterPort;
  readonly deliveryBridge?: PiDeliveryBridgePort;
}

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

interface DeadlineState {
  readonly monotonicDeadline: number;
  readonly startedUtc: number;
}

const MAX_REQUEST_ID_LENGTH = 128;

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

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class PiHostAdapter implements HostAdapter {
  private readonly clock: Clock;
  private readonly registrationWriter: PiRegistrationWriterPort | null;
  private readonly deliveryBridge: PiDeliveryBridgePort | null;

  constructor(options: PiHostAdapterOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.registrationWriter = options.registrationWriter ?? null;
    this.deliveryBridge = options.deliveryBridge ?? null;
  }

  describe(): AdapterDescriptor {
    return PI_ADAPTER_DESCRIPTOR;
  }

  normalizeEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
    return normalizePiEvent(input);
  }

  async register(
    req: RegistrationRequest,
    signal: AbortSignal
  ): Promise<AdapterResult<RegistrationResult>> {
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
    if (req.host_id !== PI_HOST_ID || req.adapter_id !== PI_ADAPTER_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (!isPiMode(req.mode)) {
      return adapterErr(this.error("E_UNSUPPORTED", detail));
    }

    const conflicts: RegistrationConflict[] = [];
    const target = piRegistrationTarget(req.target_id);
    if (req.adapter_version !== PI_ADAPTER_VERSION || req.implementation_hash !== PI_IMPLEMENTATION_HASH) {
      conflicts.push({ code: "E_ADAPTER_MISMATCH", detail_ref: detail });
    }
    if (!isPiConfigSpace(req.config_space)) {
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
        descriptor_hash: PI_DESCRIPTOR_HASH,
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

    const targetSpace = target?.config_space ?? req.config_space;
    const requiresTrust = target?.scope === "project";
    const trustState: RegistrationResult["trust_state"] =
      targetSpace === "project_untrusted" ? "unknown" : "ready";
    const common: RegistrationResult = {
      request_id: req.request_id,
      registration_hash: req.registration_hash,
      status: "planned",
      load_boundary: target?.load_boundary ?? "unknown",
      requires_trust: requiresTrust,
      trust_state: trustState,
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
    const detail = req.fixture_ref ?? PI_DESCRIPTOR_REF;
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
    if (req.binding.host_id !== PI_HOST_ID || req.host_binding.host_id !== PI_HOST_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (
      req.host_binding.adapter_id !== PI_ADAPTER_ID ||
      req.host_binding.adapter_version !== PI_ADAPTER_VERSION ||
      req.host_binding.implementation_hash !== PI_IMPLEMENTATION_HASH ||
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
    if (req.host_binding.host_id !== PI_HOST_ID || req.host_binding.adapter_id !== PI_ADAPTER_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    // Pi has no native async-work field; agent_settled only proves the host loop
    // settled. Both pending state and background work stay unknown.
    return adapterOk({
      request_id: req.request_id,
      state: "unknown",
      signals: Object.freeze([
        { field: "pending_state", state: "unknown" },
        { field: "background_work", state: "unknown" }
      ]),
      fields_observed: Object.freeze([]),
      fields_unknown: Object.freeze(["background_work", "pending_state"]),
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
    if (req.host_binding.host_id !== PI_HOST_ID || req.host_binding.adapter_id !== PI_ADAPTER_ID) {
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
    return adapterOk({
      delivery_id: req.delivery_id,
      submitted: submitted.value.submitted,
      ...(submitted.value.host_ack_ref === undefined ? {} : { host_ack_ref: submitted.value.host_ack_ref }),
      inclusion: { level: submitted.value.inclusion },
      degraded: submitted.value.submitted !== "true",
      completed_at: this.clock.utcNowMs()
    });
  }

  async checkLoad(req: LoadCheckRequest, signal: AbortSignal): Promise<AdapterResult<LoadCheckResult>> {
    const detail = PI_DESCRIPTOR_REF;
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
    // The deadline lives on the *injected* clock's monotonic timeline, so
    // the deadline and the check that follows it share one origin. Using the
    // real `performance.now()` here compared it against a different timeline
    // and reported every call as expired under a `FakeClock`.
    const state: DeadlineState = {
      monotonicDeadline: this.clock.monotonicNowMs() + deadlineMs,
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

/** Creates the Pi adapter with optional host-side bridges. */
export function createPiHostAdapter(options: PiHostAdapterOptions = {}): PiHostAdapter {
  return new PiHostAdapter(options);
}

/** HostEventBindingDraft shape check shared by probe/deliver callers. */
export function isPiHostEventBinding(binding: HostEventBindingDraft): boolean {
  return binding.host_id === PI_HOST_ID && binding.adapter_id === PI_ADAPTER_ID;
}

/** Capability names accepted by `probe` (closed set minus the HOST-reserved name). */
export function isProbeableCapability(name: CapabilityName): boolean {
  return isCapabilityName(name) && name !== HOST_RESERVED_CAPABILITY;
}
