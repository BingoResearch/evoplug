/**
 * OpenCode `HostAdapter` implementation (DD-HOST-001, DD-HOST-050,
 * DD-HOST-100).
 *
 * The adapter is deliberately thin: it validates its own frozen inputs, reports
 * facts and evidence, and never decides budget, authorization, signals or jobs.
 * Where the OpenCode contract does not provide evidence, the result is an
 * explicit `unknown`, never a fabricated success:
 *
 * - `probe` cannot run a live host roundtrip inside the adapter process, so it
 *   returns `result="unknown"` with `proposed_status="unknown"`. The 2.1.0
 *   source surface only justifies `evidence_stage="static"`; the 2.1.4
 *   install loaded no diagnostic plugin and stays `none` (DD-HOST-050).
 * - `inspectPending` returns `state="unknown"` unless a server-side inbox
 *   reader is injected. `session.idle` is ephemeral and never clears pending.
 * - `deliver` returns `submitted="unknown"` unless a host-side delivery bridge
 *   is injected. The V2 hook view is a construction layer, not the final
 *   transport body, so it can never claim `transport_body`.
 * - `checkLoad` returns `state="unknown"` because the adapter cannot read the
 *   host session's plugin graph; the birth list requires a new instance and
 *   only `PluginSupervisor` generation can hot-swap.
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
  OPENCODE_ADAPTER_DESCRIPTOR,
  OPENCODE_DESCRIPTOR_HASH,
  OPENCODE_DESCRIPTOR_REF,
  computeRegistrationHash,
  isOpenCodeConfigSpace,
  isOpenCodeMode,
  openCodeRegistrationTarget
} from "./descriptor.js";
import { normalizeOpenCodeEvent } from "./normalize.js";
import {
  OPENCODE_ADAPTER_ID,
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_HOST_ID,
  OPENCODE_IMPLEMENTATION_HASH,
  OPENCODE_SOURCE_COMMIT,
  OPENCODE_SOURCE_VERSION
} from "./manifest.js";

/* ------------------------------------------------------------------ */
/* Host-side bridges injected by the composition root                  */
/* ------------------------------------------------------------------ */

export interface OpenCodeRegistrationApplyInput {
  readonly request: RegistrationRequest;
  readonly target: RegistrationTarget;
  readonly signal: AbortSignal;
}

export interface OpenCodeRegistrationApplyResult {
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
export interface OpenCodeRegistrationWriterPort {
  apply(input: OpenCodeRegistrationApplyInput): Promise<AdapterResult<OpenCodeRegistrationApplyResult>>;
}

export interface OpenCodeDeliverySubmitInput {
  readonly request: HostDeliveryRequest;
  readonly signal: AbortSignal;
}

export interface OpenCodeDeliverySubmitResult {
  readonly submitted: "true" | "false" | "unknown";
  readonly host_ack_ref?: SourceRef;
  readonly inclusion: InclusionLevel;
  /**
   * Evidence for the claimed inclusion level. `transport_body` requires this
   * reference; without it the adapter degrades the claim to
   * `provider_payload` because the V2 hook view is a construction layer.
   */
  readonly inclusion_evidence_ref?: SourceRef;
}

/**
 * Bridges delivery to the OpenCode V2 hook return (`session.prompt` before
 * admission, `session.context` per request, `session.http.request`). Without
 * it, delivery is reported as unverified instead of pretending the text
 * reached the provider request. The hook view is a construction layer, so an
 * implementation must not report `transport_body` without a transport capture.
 */
export interface OpenCodeDeliveryBridgePort {
  submit(input: OpenCodeDeliverySubmitInput): Promise<AdapterResult<OpenCodeDeliverySubmitResult>>;
}

export interface OpenCodePendingInspectInput {
  readonly request: PendingInspectRequest;
  readonly signal: AbortSignal | undefined;
}

/**
 * Reads the server-mode durable execution inbox (enqueued/delivered/
 * cancelled). DD-HOST-050 allows the inbox as a pending observation but the
 * adapter process cannot read it directly; without this port pending stays
 * unknown. `session.idle` is never accepted as a `none` signal.
 */
export interface OpenCodePendingReaderPort {
  read(input: OpenCodePendingInspectInput): Promise<AdapterResult<PendingInspectResult>>;
}

export interface OpenCodeHostAdapterOptions {
  readonly clock?: Clock;
  readonly registrationWriter?: OpenCodeRegistrationWriterPort;
  readonly deliveryBridge?: OpenCodeDeliveryBridgePort;
  readonly pendingReader?: OpenCodePendingReaderPort;
}

/** The two accepted plugin config keys (DD-HOST-050). */
export const OPENCODE_PLUGIN_CONFIG_KEYS: readonly string[] = Object.freeze(["plugin", "plugins"]);

/**
 * Normalizes the two accepted plugin config keys (DD-HOST-050).
 *
 * Both `plugin` and `plugins` are accepted; the legacy `plugin` entries are
 * concatenated first, then `plugins`. DD-HOST-050 specifies concatenation and
 * nothing more, so order is preserved and duplicate entries are not removed
 * here: de-duplication belongs to the host-side loader.
 */
export function normalizeOpenCodePluginList(
  legacyPlugin: readonly string[] | null | undefined,
  plugins: readonly string[] | null | undefined
): readonly string[] {
  return Object.freeze([...(legacyPlugin ?? []), ...(plugins ?? [])]);
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

/**
 * Evidence stage the adapter can justify for a probe result.
 *
 * DD-HOST-050 records the 2.1.0 source surface as static and the 2.1.4
 * install as none (it loaded no diagnostic plugin). The two pins are never
 * merged, so a binding that does not name the 2.1.0 source stays `none`.
 */
function probeEvidenceStage(
  binding: CapabilityBinding,
  name: CapabilityName
): ProbeCapabilityResult["evidence_stage"] {
  if (!hasStaticAdapterEvidence(name)) {
    return "none";
  }
  const namesSourceBaseline =
    binding.source_pin.source_commit === OPENCODE_SOURCE_COMMIT ||
    (binding.source_pin.host_version_kind === "source_commit" &&
      binding.source_pin.host_version === OPENCODE_SOURCE_VERSION);
  if (namesSourceBaseline) {
    return "static";
  }
  // The 2.1.4 install loaded no diagnostic plugin; any other pin is also
  // outside the verified source baseline.
  return "none";
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

export class OpenCodeHostAdapter implements HostAdapter {
  private readonly clock: Clock;
  private readonly registrationWriter: OpenCodeRegistrationWriterPort | null;
  private readonly deliveryBridge: OpenCodeDeliveryBridgePort | null;
  private readonly pendingReader: OpenCodePendingReaderPort | null;

  constructor(options: OpenCodeHostAdapterOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.registrationWriter = options.registrationWriter ?? null;
    this.deliveryBridge = options.deliveryBridge ?? null;
    this.pendingReader = options.pendingReader ?? null;
  }

  describe(): AdapterDescriptor {
    return OPENCODE_ADAPTER_DESCRIPTOR;
  }

  normalizeEvent(input: NormalizeHostEventInput): AdapterResult<NormalizedHostEventDraft> {
    return normalizeOpenCodeEvent(input);
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
    if (req.host_id !== OPENCODE_HOST_ID || req.adapter_id !== OPENCODE_ADAPTER_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (!isOpenCodeMode(req.mode)) {
      return adapterErr(this.error("E_UNSUPPORTED", detail));
    }

    const conflicts: RegistrationConflict[] = [];
    const target = openCodeRegistrationTarget(req.target_id);
    if (req.adapter_version !== OPENCODE_ADAPTER_VERSION || req.implementation_hash !== OPENCODE_IMPLEMENTATION_HASH) {
      conflicts.push({ code: "E_ADAPTER_MISMATCH", detail_ref: detail });
    }
    if (!isOpenCodeConfigSpace(req.config_space)) {
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
        descriptor_hash: OPENCODE_DESCRIPTOR_HASH,
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

    // DD-HOST-050 records no project trust gate for OpenCode; the three config
    // spaces are user/project/managed and registration itself does not require
    // a host trust decision.
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
    const detail = req.fixture_ref ?? OPENCODE_DESCRIPTOR_REF;
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
    if (req.binding.host_id !== OPENCODE_HOST_ID || req.host_binding.host_id !== OPENCODE_HOST_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (req.binding.adapter_version !== OPENCODE_ADAPTER_VERSION) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    if (
      req.host_binding.adapter_id !== OPENCODE_ADAPTER_ID ||
      req.host_binding.adapter_version !== OPENCODE_ADAPTER_VERSION ||
      req.host_binding.implementation_hash !== OPENCODE_IMPLEMENTATION_HASH ||
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
      evidence_stage: probeEvidenceStage(req.binding, name),
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
    const deadline = begun.value;
    if (!isRequestId(req.request_id)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (!isSourceRef(req.boundary_event_ref)) {
      return adapterErr(this.error("E_SCHEMA", detail));
    }
    if (req.host_binding.host_id !== OPENCODE_HOST_ID || req.host_binding.adapter_id !== OPENCODE_ADAPTER_ID) {
      return adapterErr(this.error("E_CONFLICT", detail));
    }
    // DD-HOST-050: server mode exposes durable execution and an inbox
    // (enqueued/delivered/cancelled); TUI visibility is unknown. `session.idle`
    // is ephemeral and is never accepted as a `none` signal, so an empty idle
    // observation cannot clear pending work.
    if (this.pendingReader !== null && req.host_binding.mode === "server") {
      const observed = await this.pendingReader.read({ request: req, signal });
      if (!observed.ok) {
        return observed;
      }
      if (observed.value.request_id !== req.request_id) {
        return adapterErr(this.error("E_CONFLICT", detail));
      }
      const expired = this.finish(deadline, signal, detail);
      if (expired !== null) {
        return adapterErr(expired);
      }
      return observed;
    }
    const serverMode = req.host_binding.mode === "server";
    return adapterOk({
      request_id: req.request_id,
      state: "unknown",
      signals: Object.freeze([
        { field: serverMode ? "execution_inbox" : "tui_connection", state: "unknown" },
        { field: "background_work", state: "unknown" },
        { field: "session_idle", state: "unknown" }
      ]),
      fields_observed: Object.freeze([]),
      fields_unknown: Object.freeze(
        serverMode
          ? ["background_work", "execution_inbox", "pending_state", "session_idle"]
          : ["background_work", "pending_state", "session_idle", "tui_connection"]
      ),
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
    if (req.host_binding.host_id !== OPENCODE_HOST_ID || req.host_binding.adapter_id !== OPENCODE_ADAPTER_ID) {
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
    // DD-HOST-050: the V2 `session.prompt`/`session.context`/`session.http`
    // view is a construction layer, not the final transport body. A claimed
    // `transport_body` without an independent evidence reference is therefore
    // degraded to `provider_payload`; a claim without a host acknowledgement
    // is reported as `unknown`.
    const claimed = submitted.value.submitted;
    const acknowledged = submitted.value.host_ack_ref !== undefined;
    const effective: "true" | "false" | "unknown" = claimed === "true" && !acknowledged ? "unknown" : claimed;
    const evidenceRef = submitted.value.inclusion_evidence_ref;
    const claimedLevel = submitted.value.inclusion;
    const effectiveLevel: InclusionLevel =
      evidenceRef === undefined && claimedLevel === "transport_body" ? "provider_payload" : claimedLevel;
    const inclusion =
      evidenceRef === undefined
        ? { level: effectiveLevel }
        : { level: effectiveLevel, evidence_ref: evidenceRef };
    return adapterOk({
      delivery_id: req.delivery_id,
      submitted: effective,
      ...(submitted.value.host_ack_ref === undefined ? {} : { host_ack_ref: submitted.value.host_ack_ref }),
      inclusion,
      degraded: effective !== "true" || effectiveLevel !== claimedLevel,
      completed_at: this.clock.utcNowMs()
    });
  }

  async checkLoad(req: LoadCheckRequest, signal: AbortSignal): Promise<AdapterResult<LoadCheckResult>> {
    const detail = OPENCODE_DESCRIPTOR_REF;
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
    // DD-HOST-050: the birth list is immutable after instance creation and
    // only `PluginSupervisor` generation can hot-swap; the adapter cannot read
    // the host session's plugin graph, so load state stays unknown.
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

/** Creates the OpenCode adapter with optional host-side bridges. */
export function createOpenCodeHostAdapter(options: OpenCodeHostAdapterOptions = {}): OpenCodeHostAdapter {
  return new OpenCodeHostAdapter(options);
}

/** HostEventBindingDraft shape check shared by probe/deliver callers. */
export function isOpenCodeHostEventBinding(binding: HostEventBindingDraft): boolean {
  return binding.host_id === OPENCODE_HOST_ID && binding.adapter_id === OPENCODE_ADAPTER_ID;
}

/** Capability names accepted by `probe` (closed set minus the HOST-reserved name). */
export function isProbeableCapability(name: CapabilityName): boolean {
  return isCapabilityName(name) && name !== HOST_RESERVED_CAPABILITY;
}
