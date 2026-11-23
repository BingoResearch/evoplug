/**
 * Runtime-side handler for `probe` and `check_load` calls (W1).
 *
 * The runtime process is the only component that can see the host it runs in,
 * so it answers the two non-delivery call kinds here instead of leaving them
 * unanswered:
 *
 * - `check_load` re-reads the installed artifact manifest, recomputes
 *   `sha256(JCS(manifest))`, and reports whether the host-visible artifact
 *   matches the expected hash. The readback is published through the frozen
 *   upload channel, so the kernel gets a real CAS reference.
 * - `probe` reports what the host actually exposed in the current hook
 *   payload. Provider bodies and receipts are reported only when the adapter
 *   supplies host-produced bytes; the kernel never trusts a runtime-created
 *   reference for a `roundtrip`, so these values never upgrade a capability on
 *   their own.
 *
 * `deliver` stays with each entry's own injection path.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { type Hash, type JsonValue, type SourceRef } from "@evoplug/core";
import {
  type RuntimeCall,
  type RuntimeCallResult,
  type RuntimeProbeRequest,
  capabilityBindingKey
} from "@evoplug/core/host";
import { toJsonValue } from "@evoplug/ipc";

import {
  computeArtifactHash,
  validateHostRuntimeArtifactManifest,
  type HostRuntimeArtifactManifest
} from "./artifact.js";
import type { HostRuntime } from "./runtime.js";
import { probeMarker } from "./probe.js";

/** What the adapter can honestly say about the host during this turn. */
interface RuntimeHostObservation {
  readonly session_id: string | null;
  readonly message_id: string | null;
  readonly tool_call_id: string | null;
  readonly compaction: boolean;
  /** Host-produced text the adapter could read back (never synthesized). */
  readonly output_text?: string;
  /** Provider request bytes, only when the adapter truly captured them. */
  readonly provider_body?: string;
  /** Host delivery receipt bytes, only when the adapter truly captured them. */
  readonly receipt?: string;
}

interface RuntimeCallHandlerOptions {
  /** Artifact root the runtime verified at load time. */
  readonly artifact_root: string;
  /**
   * Registered input-family host event used solely as the frozen upload
   * carrier for evidence bytes. The payload has no prompt field, so the kernel
   * rejects it and records the CAS reference.
   */
  readonly carrier_event: string;
  readonly observed_at?: number;
  readonly host_observation?: () =>
    | RuntimeHostObservation
    | null
    | Promise<RuntimeHostObservation | null>;
}

export interface RuntimeCallHandled {
  readonly handled: boolean;
  readonly kind: "probe" | "check_load" | null;
  readonly evidence_ref: SourceRef | null;
}

const MANIFEST_NAME = "manifest.json";

async function locateManifest(root: string): Promise<string | null> {
  const direct = join(root, MANIFEST_NAME);
  try {
    await readFile(direct);
    return direct;
  } catch {
    // Single-file artifacts keep the manifest under `<name>.runtime/`.
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  entries.sort();
  for (const entry of entries) {
    if (!entry.endsWith(".runtime")) {
      continue;
    }
    const candidate = join(root, entry, MANIFEST_NAME);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

async function readManifestHash(
  root: string
): Promise<{ readonly hash: Hash; readonly bytes: Uint8Array } | null> {
  const path = await locateManifest(root);
  if (path === null) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const issues = validateHostRuntimeArtifactManifest(parsed);
    if (issues.length > 0) {
      return null;
    }
    return { hash: computeArtifactHash(parsed as HostRuntimeArtifactManifest), bytes };
  } catch {
    return null;
  }
}

/**
 * Publishes evidence bytes through the frozen upload method and returns the
 * kernel's CAS reference. A rejected upload is the intended outcome: the
 * kernel stores the bytes and returns a real `blob://` reference for the
 * rejection, which is what makes the evidence independently retrievable.
 */
async function publishEvidence(
  runtime: HostRuntime,
  carrierEvent: string,
  payload: Record<string, JsonValue>,
  observedAt: number
): Promise<SourceRef | null> {
  const json = toJsonValue({
    schema_version: "rsi.runtime_call_evidence/1",
    source: "runtime.call",
    ...payload
  });
  if (!json.ok) {
    return null;
  }
  try {
    const outcome = await runtime.submitHostEvent(carrierEvent, {}, json.value, observedAt);
    const rejection = outcome.rejection;
    return rejection !== null && rejection.phase === "B" ? rejection.detail_ref : null;
  } catch {
    return null;
  }
}

function verdictsFromObservation(
  observation: RuntimeHostObservation | null
): Record<string, boolean | "unknown"> {
  if (observation === null) {
    return {
      input_capture: "unknown",
      stable_boundary: "unknown",
      compaction_event: "unknown",
      association: "unknown"
    };
  }
  const session = observation.session_id !== null;
  return {
    input_capture: session,
    stable_boundary: session,
    compaction_event: observation.compaction,
    association: session && (observation.message_id !== null || observation.tool_call_id !== null)
  };
}

function textHasMarker(text: string | undefined, marker: string): boolean {
  return text !== undefined && text.includes(marker);
}

async function handleProbe(
  runtime: HostRuntime,
  call: Extract<RuntimeCall, { kind: "probe" }>,
  options: RuntimeCallHandlerOptions,
  observedAt: number
): Promise<RuntimeCallHandled> {
  const request: RuntimeProbeRequest = call.request;
  const marker = probeMarker(request.probe_id);
  let observation: RuntimeHostObservation | null = null;
  if (options.host_observation !== undefined) {
    try {
      observation = await options.host_observation();
    } catch {
      observation = null;
    }
  }
  const echo: "none" | "assistant_output" | "provider_body" | "receipt" =
    textHasMarker(observation?.provider_body, marker)
      ? "provider_body"
      : textHasMarker(observation?.receipt, marker)
        ? "receipt"
        : textHasMarker(observation?.output_text, marker)
          ? "assistant_output"
          : "none";
  const verdicts = verdictsFromObservation(observation);
  const evidenceRef = await publishEvidence(
    runtime,
    options.carrier_event,
    {
      call_id: call.call_id,
      call_kind: "probe",
      probe_id: request.probe_id,
      nonce: request.probe_id,
      echo
    },
    observedAt
  );
  const evidenceRefs = evidenceRef === null ? [] : [evidenceRef];
  // Host evidence the adapter chose to expose is recorded verbatim, but the
  // kernel only accepts provider/receipt proof from its own collector. A
  // runtime-created ref therefore cannot raise the capability.
  const providerBodyRef =
    textHasMarker(observation?.provider_body, marker) && evidenceRef !== null
      ? evidenceRef
      : undefined;
  const receiptRef =
    textHasMarker(observation?.receipt, marker) && evidenceRef !== null
      ? evidenceRef
      : undefined;
  const observed = toJsonValue({
    schema_version: "rsi.runtime_probe_observation/1",
    nonce: request.probe_id,
    echo,
    self_reported: true,
    capabilities: request.capabilities.map((name) => ({
      name,
      pass: verdicts[name] ?? "unknown",
      evidence_refs: []
    })),
    ...(providerBodyRef === undefined ? {} : { provider_body_ref: providerBodyRef }),
    ...(receiptRef === undefined ? {} : { receipt_ref: receiptRef })
  });
  if (!observed.ok) {
    return { handled: false, kind: null, evidence_ref: null };
  }
  const result: RuntimeCallResult = {
    kind: "probe",
    state: "observed",
    observation: {
      probe_id: request.probe_id,
      probe_action: request.probe_action ?? "read_only",
      binding_key: capabilityBindingKey(request.binding),
      observed: observed.value,
      // A runtime observation never claims more than `loaded`; the kernel caps
      // this again on receipt.
      ...(evidenceRefs.length > 0 ? { claimed_evidence_stage: "loaded" as const } : {}),
      claimed_status: "unknown",
      checked_at: observedAt,
      evidence_refs: evidenceRefs
    }
  };
  const reported = await runtime.reportResult(call.call_id, result);
  const handled = reported.ok && reported.recorded;
  return { handled, kind: handled ? "probe" : null, evidence_ref: evidenceRef };
}

async function handleCheckLoad(
  runtime: HostRuntime,
  call: Extract<RuntimeCall, { kind: "check_load" }>,
  options: RuntimeCallHandlerOptions,
  observedAt: number
): Promise<RuntimeCallHandled> {
  const request = call.request;
  const computed = await readManifestHash(options.artifact_root);
  const evidenceRef = await publishEvidence(
    runtime,
    options.carrier_event,
    {
      call_id: call.call_id,
      call_kind: "check_load",
      request_id: request.request_id,
      expected_hash: request.expected_hash,
      observed_hash: computed?.hash ?? null,
      manifest_bytes: computed === null ? null : computed.bytes.byteLength
    },
    observedAt
  );
  const state: "loaded" | "not_loaded" | "conflict" | "unknown" =
    computed === null
      ? "not_loaded"
      : computed.hash === request.expected_hash
        ? "loaded"
        : "conflict";
  const evidenceRefs = evidenceRef === null ? [] : [evidenceRef];
  const result: RuntimeCallResult = {
    kind: "check_load",
    state: "completed",
    result: {
      request_id: request.request_id,
      state,
      ...(computed === null ? {} : { observed_hash: computed.hash }),
      evidence_refs: evidenceRefs,
      ...(evidenceRef === null ? {} : { readback_ref: evidenceRef })
    }
  };
  const reported = await runtime.reportResult(call.call_id, result);
  const handled = reported.ok && reported.recorded;
  return { handled, kind: handled ? "check_load" : null, evidence_ref: evidenceRef };
}

/**
 * Answers one non-delivery runtime call. Returns `handled:false` for `deliver`
 * so each entry keeps its own delivery path.
 */
export async function handleRuntimeCall(
  runtime: HostRuntime,
  call: RuntimeCall,
  options: RuntimeCallHandlerOptions
): Promise<RuntimeCallHandled> {
  if (call.kind === "deliver") {
    return { handled: false, kind: null, evidence_ref: null };
  }
  const observedAt = options.observed_at ?? Date.now();
  if (call.kind === "probe") {
    return handleProbe(runtime, call, options, observedAt);
  }
  return handleCheckLoad(runtime, call, options, observedAt);
}

