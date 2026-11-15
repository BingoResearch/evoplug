/**
 * Runtime probe construction and self-report classification (W1/D6).
 *
 * A runtime probe is a read-only request whose prompt carries a nonce that the
 * host is asked to echo verbatim. The nonce is the kernel-issued `probe_id`:
 * it is random, unique per call and already persisted in
 * `host_runtime_call.object_ref`, so echoing it proves that this exact request
 * reached the host process. The echo alone cannot prove that the marker entered
 * the provider request body; that step needs an independently retrievable
 * request body or delivery receipt.
 *
 * Nothing in this module decides a capability status. It only builds the
 * request the adapter must deliver and classifies the raw runtime response into
 * an evidence-stage candidate. The kernel re-reads every referenced body and
 * applies `applyProbeToCapability`; a runtime's own claim is capped at `loaded`
 * before that happens (DD-HOST-206).
 */

import {
  err,
  formatSourceRef,
  isId,
  makeErrorEnvelope,
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
  type CapabilityBinding,
  type CapabilityName,
  type ConfigSpace,
  type HostEventBinding,
  type HostId,
  type HostMode,
  type RuntimeProbeRequest
} from "@evoplug/core/host";

export const RUNTIME_PROBE_PAYLOAD_SCHEMA = "rsi.runtime_probe_observation/1" as const;

/** The registration/session facts an adapter already knows at probe time. */
export interface ProbeRegistrationView {
  readonly host_id: HostId;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly host_version: string;
  readonly binary_hash: Hash | null;
}

/** The capability-specific binding and boundary the kernel resolved. */
export interface ProbeCapabilityView {
  readonly name: CapabilityName;
  readonly binding: CapabilityBinding;
  readonly host_binding: HostEventBinding;
  /** Upper bound the runtime must honour; the kernel clamps it again. */
  readonly deadline_ms: number;
}

export interface BuiltProbeRequest {
  readonly request: RuntimeProbeRequest;
  /** Random echo token. Equal to `request.probe_id` by construction. */
  readonly nonce: string;
  /** Prompt fragment the adapter injects into a read-only turn. */
  readonly instruction: string;
  /** Exact string the assistant must echo. */
  readonly marker: string;
}

/** Marker grammar: `[[evoplug-probe:<nonce>]]`. */
export function probeMarker(nonce: string): string {
  return `[[evoplug-probe:${nonce}]]`;
}

/**
 * Instruction text. Adapters may wrap it in host-native context, but the
 * marker line must survive verbatim so the echo is attributable.
 */
export function buildProbeInstruction(nonce: string): string {
  return [
    "Read-only capability probe. Do not call tools, do not modify files.",
    `Reply with exactly this line and nothing else: ${probeMarker(nonce)}`
  ].join("\n");
}

/**
 * Builds one runtime probe request.
 *
 * `nonce` doubles as the probe id. The kernel allocates it before inserting the
 * call row, so a replayed request cannot reuse another call's nonce and an
 * echo can be matched to exactly one persisted call.
 */
export function buildProbeRequest(
  registration: ProbeRegistrationView,
  capability: ProbeCapabilityView,
  nonce: string
): Result<BuiltProbeRequest, ErrorEnvelope> {
  if (!isId(nonce, "prb")) {
    return err(probeBuildError("nonce", "prb_id"));
  }
  if (registration.host_id !== capability.binding.host_id) {
    return err(probeBuildError("registration.host_id", "binding_host_mismatch"));
  }
  if (registration.adapter_version !== capability.binding.adapter_version) {
    return err(probeBuildError("registration.adapter_version", "binding_adapter_mismatch"));
  }
  if (registration.mode !== capability.binding.mode) {
    return err(probeBuildError("registration.mode", "binding_mode_mismatch"));
  }
  if (registration.config_space !== capability.binding.config_space) {
    return err(probeBuildError("registration.config_space", "binding_config_space_mismatch"));
  }
  if (
    capability.host_binding.host_id !== registration.host_id ||
    capability.host_binding.mode !== registration.mode ||
    capability.host_binding.config_space !== registration.config_space
  ) {
    return err(probeBuildError("capability.host_binding", "host_binding_scope_mismatch"));
  }
  if (!Number.isSafeInteger(capability.deadline_ms) || capability.deadline_ms < 1) {
    return err(probeBuildError("capability.deadline_ms", "positive_safe_integer"));
  }
  const request: RuntimeProbeRequest = {
    probe_id: nonce,
    probe_contract_version: "host-probe/2",
    binding: capability.binding,
    host_binding: capability.host_binding,
    probe_action: "read_only",
    capabilities: [capability.name],
    probe_mode: "read_only",
    deadline_ms: Math.min(capability.deadline_ms, 600_000)
  };
  return ok({
    request,
    nonce,
    instruction: buildProbeInstruction(nonce),
    marker: probeMarker(nonce)
  });
}

/** Raw host-side response fields a runtime adapter can observe. */
export interface ProbeRuntimeResponse {
  /** Assistant output text, when the runtime can read the final message. */
  readonly output_text?: string | null;
  /**
   * A SourceRef to the provider request body the host actually sent. The
   * kernel re-reads it; a self-declared string is not trusted by itself.
   */
  readonly provider_body_ref?: SourceRef | null;
  /** A SourceRef to a delivery receipt recorded by the host. */
  readonly receipt_ref?: SourceRef | null;
  /** Optional inline provider body (tests and print-mode runtimes). */
  readonly provider_body_text?: string | null;
  /** Optional inline receipt text (tests and print-mode runtimes). */
  readonly receipt_text?: string | null;
}

export type ProbeEchoLocation = "none" | "assistant_output" | "provider_body" | "receipt";

/**
 * Self-report classification.
 *
 * `candidate_stage` is what the runtime believes it observed. It is never a
 * capability status: `status` stays `unknown` here and the kernel decides
 * whether the referenced evidence is independently retrievable.
 */
export interface ProbeClassification {
  readonly echo: ProbeEchoLocation;
  readonly candidate_stage: "none" | "loaded" | "roundtrip";
  readonly status: "unknown";
  /** True until the kernel has re-read an independent body or receipt. */
  readonly independent_evidence_required: boolean;
  readonly reason:
    | "echo_missing"
    | "echo_in_assistant_output"
    | "echo_in_provider_body"
    | "echo_in_receipt";
}

function includesMarker(text: string | null | undefined, nonce: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return text.includes(probeMarker(nonce)) || text.includes(nonce);
}

/**
 * Classifies one runtime response against the request nonce.
 *
 * - nothing echoes the nonce -> `none`
 * - the assistant output echoes it -> `loaded`
 * - a provider body or receipt echoes it -> `roundtrip` candidate
 *
 * A provider-body/receipt reference without an echo in the available text still
 * yields a `roundtrip` candidate, because the referenced bytes may contain the
 * nonce. The kernel resolves and checks those bytes; if they are missing or do
 * not contain the nonce, the capability stays at `loaded` (or lower).
 */
export function classifyProbeResult(
  response: ProbeRuntimeResponse,
  nonce: string
): ProbeClassification {
  if (includesMarker(response.receipt_text, nonce)) {
    return {
      echo: "receipt",
      candidate_stage: "roundtrip",
      status: "unknown",
      independent_evidence_required: true,
      reason: "echo_in_receipt"
    };
  }
  if (includesMarker(response.provider_body_text, nonce)) {
    return {
      echo: "provider_body",
      candidate_stage: "roundtrip",
      status: "unknown",
      independent_evidence_required: true,
      reason: "echo_in_provider_body"
    };
  }
  if (response.receipt_ref !== null && response.receipt_ref !== undefined) {
    return {
      echo: "receipt",
      candidate_stage: "roundtrip",
      status: "unknown",
      independent_evidence_required: true,
      reason: "echo_in_receipt"
    };
  }
  if (response.provider_body_ref !== null && response.provider_body_ref !== undefined) {
    return {
      echo: "provider_body",
      candidate_stage: "roundtrip",
      status: "unknown",
      independent_evidence_required: true,
      reason: "echo_in_provider_body"
    };
  }
  if (includesMarker(response.output_text, nonce)) {
    return {
      echo: "assistant_output",
      candidate_stage: "loaded",
      status: "unknown",
      independent_evidence_required: false,
      reason: "echo_in_assistant_output"
    };
  }
  return {
    echo: "none",
    candidate_stage: "none",
    status: "unknown",
    independent_evidence_required: false,
    reason: "echo_missing"
  };
}

export interface ProbeCapabilityVerdict {
  readonly name: CapabilityName;
  /** `true` only when the runtime actually observed the behaviour. */
  readonly pass: boolean | "unknown";
  readonly failure_code?: string;
  readonly evidence_refs?: readonly string[];
}

export interface ProbeObservationBlocker {
  readonly kind:
    | "credentials_unavailable"
    | "region_blocked"
    | "provider_unavailable"
    | "host_not_installed"
    | "version_unmapped"
    | "permission_denied"
    | "fixture_unavailable"
    | "deadline_exceeded"
    | "operator_aborted"
    | "unknown_environment";
  readonly code: string;
  readonly detail_ref: SourceRef;
  readonly retry_allowed: boolean;
}

export interface ProbeObservationPayloadInput {
  readonly nonce: string;
  readonly classification: ProbeClassification;
  readonly capabilities: readonly ProbeCapabilityVerdict[];
  readonly provider_body_ref?: SourceRef | null;
  readonly receipt_ref?: SourceRef | null;
  readonly blocker?: ProbeObservationBlocker;
  readonly observed_at?: number;
}

/**
 * The exact JSON an adapter puts in `HostProbeObservation.observed`.
 *
 * The kernel validates the shape through `isJsonValue` and then re-classifies;
 * this payload is a carrier, not an authority.
 */
export interface RuntimeProbeObservationPayload {
  readonly schema_version: typeof RUNTIME_PROBE_PAYLOAD_SCHEMA;
  readonly nonce: string;
  readonly echo: ProbeEchoLocation;
  readonly candidate_stage: ProbeClassification["candidate_stage"];
  readonly self_reported: true;
  readonly capabilities: readonly {
    readonly name: CapabilityName;
    readonly pass: boolean | "unknown";
    readonly failure_code?: string;
    readonly evidence_refs: readonly string[];
  }[];
  readonly provider_body_ref?: string;
  readonly receipt_ref?: string;
  readonly blocker?: {
    readonly kind: ProbeObservationBlocker["kind"];
    readonly code: string;
    readonly detail_ref: string;
    readonly retry_allowed: boolean;
  };
  readonly observed_at?: number;
}

export function buildProbeObservationPayload(
  input: ProbeObservationPayloadInput
): RuntimeProbeObservationPayload {
  return {
    schema_version: RUNTIME_PROBE_PAYLOAD_SCHEMA,
    nonce: input.nonce,
    echo: input.classification.echo,
    candidate_stage: input.classification.candidate_stage,
    self_reported: true,
    capabilities: input.capabilities.map((verdict) => ({
      name: verdict.name,
      pass: verdict.pass,
      ...(verdict.failure_code === undefined ? {} : { failure_code: verdict.failure_code }),
      evidence_refs: [...(verdict.evidence_refs ?? [])]
    })),
    ...(input.provider_body_ref === null || input.provider_body_ref === undefined
      ? {}
      : { provider_body_ref: input.provider_body_ref }),
    ...(input.receipt_ref === null || input.receipt_ref === undefined
      ? {}
      : { receipt_ref: input.receipt_ref }),
    ...(input.blocker === undefined
      ? {}
      : {
          blocker: {
            kind: input.blocker.kind,
            code: input.blocker.code,
            detail_ref: input.blocker.detail_ref,
            retry_allowed: input.blocker.retry_allowed
          }
        }),
    ...(input.observed_at === undefined ? {} : { observed_at: input.observed_at })
  };
}

/** Recreates the observation envelope an adapter reports for one probe call. */
export function buildProbeObservation(input: {
  readonly probe_id: Id<"prb">;
  readonly binding: CapabilityBinding;
  readonly checked_at: number;
  readonly payload: RuntimeProbeObservationPayload;
  readonly evidence_refs: readonly SourceRef[];
  readonly claimed_evidence_stage?: "none" | "static" | "loaded" | "roundtrip";
  readonly claimed_status?: "unknown" | "verified" | "unsupported" | "failed";
}): {
  readonly probe_id: Id<"prb">;
  readonly probe_action: "read_only";
  readonly binding_key: Hash;
  readonly observed: JsonValue;
  readonly claimed_evidence_stage?: "none" | "static" | "loaded" | "roundtrip";
  readonly claimed_status?: "unknown" | "verified" | "unsupported" | "failed";
  readonly checked_at: number;
  readonly evidence_refs: SourceRef[];
} {
  const bindingKey = capabilityBindingKey(input.binding);
  return {
    probe_id: input.probe_id,
    probe_action: "read_only",
    binding_key: bindingKey,
    observed: input.payload as unknown as JsonValue,
    ...(input.claimed_evidence_stage === undefined
      ? {}
      : { claimed_evidence_stage: input.claimed_evidence_stage }),
    ...(input.claimed_status === undefined ? {} : { claimed_status: input.claimed_status }),
    checked_at: input.checked_at,
    evidence_refs: [...input.evidence_refs]
  };
}

/** A real `blob://` reference for a payload the runtime wrote itself. */
export function probePayloadRef(input: {
  readonly hash: Hash;
  readonly byte_length: number;
}): Result<SourceRef, ErrorEnvelope> {
  return formatSourceRef({
    scheme: "blob",
    locator: input.hash,
    start: 0,
    end: input.byte_length
  });
}

function probeBuildError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "host_probe_build",
    details: { kind: "field", path, rule },
    retryable: false,
    side_effect: "none"
  });
}

/* ------------------------------------------------------------------ */
/* Adapter-declared probe binding facts                                */
/* ------------------------------------------------------------------ */

export interface AdapterProbeObservationSpec {
  /** Wire shape the controlled capture endpoint must answer. */
  readonly protocol: "openai_chat" | "openai_responses" | "anthropic_messages";
  readonly launch: {
    /** Host binary or launcher the kernel executes itself. */
    readonly command: string;
    /** `{prompt}` carries the probe instruction; `{nonce}` the probe id. */
    readonly args: readonly string[];
    /** Values may use `{capture_base_url}`, `{prompt}`, `{nonce}`, `{setup_dir}`. */
    readonly env?: Readonly<Record<string, string>>;
    /** Files written into a kernel-owned temp dir before launch. */
    readonly setup_files?: readonly {
      readonly path: string;
      readonly content: string;
      readonly mode?: number;
    }[];
    /**
     * Setup-dir-relative path where the kernel mounts the installed runtime
     * artifact after independently re-hashing it against the applied
     * registration. Without this mount a child cannot prove it loaded the same
     * artifact version, so the observation stays a `native_cli_contract`.
     */
    readonly artifact_mount?: string;
    /**
     * Directory-discovery shim the host loads (for example `index.js`). Attach
     * generates this file, so it is listed in the installed artifact manifest.
     * The mount verifies it is one of the re-hashed files instead of adding an
     * unlisted module. Omit for hosts that load the artifact filename directly.
     */
    readonly discovery_entry?: string;
    readonly timeout_ms?: number;
  };
  /**
   * Declares that a kernel-run of `launch` is also a load readback for the
   * artifact mounted at `launch.artifact_mount`. The kernel still verifies the
   * installed bytes, mounts them itself and requires the fresh host process to
   * authenticate a runtime session before yielding `managed_object_load`
   * evidence; this flag only states which load boundaries that readback covers.
   * A fresh process can only observe `new_session`/`restart`, never an in-place
   * `reload` or `next_request`.
   */
  readonly load_check?: {
    readonly boundaries: readonly ("new_session" | "restart")[];
  };
}

/**
 * The facts an adapter can truthfully declare about how its runtime is
 * constructed on this host. Host-specific values (`host_version`, `binary_hash`)
 * and session-scoped values are supplied by the kernel factory call, never by
 * the adapter file.
 */
export interface AdapterProbeSpec {
  readonly adapter_id: string;
  /** Registered DD-HOST-110 construction token, for example `cli`. */
  readonly construction_path: string;
  readonly isolation: "local" | "container" | "remote";
  readonly mapping: "exact" | "partial" | "unmapped";
  readonly backend_id?: string;
  /**
   * How the kernel can execute this host against a controlled provider capture.
   * Absent means the kernel has no native observation for this adapter and the
   * capability stays below `roundtrip` (the collector returns no evidence).
   */
  readonly observation?: AdapterProbeObservationSpec;
}

/** Identity helper that keeps adapter spec files literal and typed. */
export function defineAdapterProbeSpec(spec: AdapterProbeSpec): AdapterProbeSpec {
  return spec;
}
