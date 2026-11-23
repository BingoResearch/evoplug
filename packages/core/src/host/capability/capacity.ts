/**
 * CapacityEvidencePort (DD-CAP-010).
 *
 * `get` is read-only: it reads the exact `capacity_window` capability, the
 * probe it points at, and the probe assertion's evidence blob. It never runs
 * the host, calls a model, writes capability rows or fabricates a default
 * window.
 */



import type { Clock } from "../../clock.js";
import type { ErrorEnvelope } from "../../errors.js";
import { makeErrorEnvelope } from "../../errors.js";
import { canonicalHash, hashBytes, isHash, type Hash } from "../../hash.js";
import { toJsonValue, isRecord } from "../../json.js";
import { err, ok, type Result } from "../../result.js";
import type { SourceRef, SourceRefPort } from "../../source-ref.js";
import type { NotPromise, Tx } from "../../tx.js";
import type { CapabilityRecord, HostProbeRecord } from "../types.js";
import { capabilityBindingKey } from "../keys.js";
import { isSafeNonNegativeInt, isSafePositiveInt, utf8ByteLength } from "../validation.js";

export type CapacitySourceKind = "host_capability_readback" | "model_catalog";

/** Structural projection of CFG's `ModelRef`; HOST does not own it. */
interface CapacityModelRef {
  provider: string;
  model_id: string;
  variant: string | null;
  resolution_source: "host_readback" | "explicit";
}

export interface CapacityEvidencePayload {
  schema_version: "rsi.capacity_evidence_payload/1";
  config_space_id: Hash;
  capability_binding_key: Hash;
  model: CapacityModelRef;
  model_scope_key: string;
  scope: "window_tokens";
  window_tokens: number;
  unit: "tokens";
  source_kind: CapacitySourceKind;
  observed_at: number;
}

export interface CapacityEvidence {
  schema_version: "rsi.capacity_evidence/1";
  config_space_id: Hash;
  capability_binding_key: Hash;
  model: CapacityModelRef;
  model_scope_key: string;
  scope: "window_tokens";
  window_tokens: number;
  unit: "tokens";
  source_kind: CapacitySourceKind;
  evidence_ref: SourceRef;
  evidence_hash: Hash;
  observed_at: number;
}

interface CapacityEvidenceRequest {
  request_id: string;
  config_space_id: Hash;
  capability_binding_key: Hash;
  model: CapacityModelRef;
  model_scope_key: string;
  deadline_ms: number;
  /**
   * The absolute deadline on the clock's monotonic timeline. When present it
   * is the authority for the timeout; `deadline_ms` is the remaining budget
   * the caller declared.
   */
  deadline_at_monotonic_ms?: number;
  signal?: AbortSignal;
}

type CapacityEvidenceErrorCode =
  | "E_CAPACITY_NOT_FOUND"
  | "E_CAPACITY_UNAVAILABLE"
  | "E_CAPACITY_HASH_MISMATCH"
  | "E_CAPACITY_BINDING_MISMATCH"
  | "E_DEADLINE_EXCEEDED"
  | "E_CANCELLED";

export interface CapacityEvidencePort {
  get(input: CapacityEvidenceRequest): Promise<Result<CapacityEvidence, ErrorEnvelope>>;
}

interface CapacityEvidenceDeps {
  withTx<T>(fn: (tx: Tx) => NotPromise<T>): Promise<T>;
  clock: Clock;
  sourceRefs: Pick<SourceRefPort, "resolve">;
  readCapability(
    tx: Tx,
    bindingKey: Hash,
    name: "capacity_window"
  ): Result<CapabilityRecord | null, ErrorEnvelope>;
  readProbe(tx: Tx, probeId: string): Result<HostProbeRecord | null, ErrorEnvelope>;
}

const CAPACITY_ERROR_DETAILS = "field";

function capacityError(
  code: CapacityEvidenceErrorCode,
  stage: string,
  retryable: boolean,
  path = "request",
  rule: string = code
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category:
      code === "E_DEADLINE_EXCEEDED" || code === "E_CANCELLED"
        ? "deadline"
        : code === "E_CAPACITY_HASH_MISMATCH" || code === "E_CAPACITY_BINDING_MISMATCH"
          ? "conflict"
          : code === "E_CAPACITY_NOT_FOUND"
            ? "not_found"
            : "source",
    message_key: `error.${code.toLowerCase()}`,
    stage,
    details: { kind: CAPACITY_ERROR_DETAILS, path, rule },
    retryable
  });
}

function isModelRef(value: unknown): value is CapacityModelRef {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["provider"] === "string" &&
    value["provider"].length > 0 &&
    typeof value["model_id"] === "string" &&
    value["model_id"].length > 0 &&
    (value["variant"] === null || typeof value["variant"] === "string") &&
    (value["resolution_source"] === "host_readback" || value["resolution_source"] === "explicit")
  );
}

function checkAbort(
  clock: Clock,
  deadlineRemaining: number,
  signal: AbortSignal | undefined,
  deadlineAtMonotonicMs: number | undefined
): CapacityEvidenceErrorCode | null {
  if (signal?.aborted === true) {
    return "E_CANCELLED";
  }
  const absolute = deadlineAtMonotonicMs ?? clock.monotonicNowMs() + deadlineRemaining;
  if (clock.monotonicRemainingMs(absolute) <= 0) {
    return "E_DEADLINE_EXCEEDED";
  }
  return null;
}

/** Fixed validation order and unique error mapping (DD-CAP-010). */
export function createCapacityEvidencePort(deps: CapacityEvidenceDeps): CapacityEvidencePort {
  return {
    async get(input: CapacityEvidenceRequest): Promise<Result<CapacityEvidence, ErrorEnvelope>> {
      // 1. request shape
      if (
        !isRecord(input) ||
        typeof input.request_id !== "string" ||
        input.request_id.length === 0 ||
        input.request_id.length > 128 ||
        typeof input.config_space_id !== "string" ||
        !isHash(input.config_space_id) ||
        typeof input.capability_binding_key !== "string" ||
        !isHash(input.capability_binding_key) ||
        !isModelRef(input.model) ||
        typeof input.model_scope_key !== "string" ||
        input.model_scope_key.length === 0 ||
        utf8ByteLength(input.model_scope_key) > 256 ||
        !isSafePositiveInt(input.deadline_ms) ||
        input.deadline_ms > 600_000
      ) {
        return err(capacityError("E_CAPACITY_BINDING_MISMATCH", "capacity_request", false));
      }
      // 2. deadline and cancellation
      const abort = checkAbort(
        deps.clock,
        input.deadline_ms,
        input.signal,
        input.deadline_at_monotonic_ms
      );
      if (abort !== null) {
        return err(capacityError(abort, abort === "E_CANCELLED" ? "capacity_cancel" : "capacity_deadline", true));
      }
      // 3. capability and probe
      let capability: CapabilityRecord | null = null;
      let probe: HostProbeRecord | null = null;
      try {
        const read = await deps.withTx((tx) => {
          const capabilityResult = deps.readCapability(tx, input.capability_binding_key, "capacity_window");
          if (!capabilityResult.ok) {
            return capabilityResult;
          }
          if (capabilityResult.value === null) {
            return ok(null);
          }
          const capabilityValue = capabilityResult.value;
          if (capabilityValue.probe_ref === undefined) {
            return ok({ capability: capabilityValue, probe: null });
          }
          const probeResult = deps.readProbe(tx, capabilityValue.probe_ref);
          if (!probeResult.ok) {
            return probeResult;
          }
          return ok({ capability: capabilityValue, probe: probeResult.value });
        });
        if (!read.ok) {
          return err(capacityError("E_CAPACITY_UNAVAILABLE", "capacity_read", false));
        }
        if (read.value === null) {
          return err(capacityError("E_CAPACITY_NOT_FOUND", "capacity_read", false));
        }
        capability = read.value.capability;
        probe = read.value.probe;
      } catch {
        return err(capacityError("E_CAPACITY_UNAVAILABLE", "capacity_read", false));
      }
      if (
        capability === null ||
        capability.status !== "verified" ||
        capability.evidence_stage !== "roundtrip" ||
        probe === null ||
        probe.result !== "passed" ||
        capabilityBindingKey(capability.binding) !== input.capability_binding_key ||
        capability.probe_ref !== probe.probe_id
      ) {
        return err(capacityError("E_CAPACITY_UNAVAILABLE", "capacity_read", false));
      }
      const assertion = probe.assertions.find(
        (entry) => entry.capability === "capacity_window" && entry.pass === true
      );
      if (assertion === undefined) {
        return err(capacityError("E_CAPACITY_UNAVAILABLE", "capacity_evidence", false));
      }
      // 4. resolve the evidence blob outside the transaction
      let payload: CapacityEvidencePayload;
      try {
        const resolved = await deps.sourceRefs.resolve(assertion.observed_ref, { maxBytes: 1_048_576 });
        if (!resolved.ok || !resolved.value.retrievable || resolved.value.bytes === null) {
          return err(capacityError("E_CAPACITY_UNAVAILABLE", "capacity_evidence", false));
        }
        const bytes = resolved.value.bytes;
        if (hashBytes(bytes) !== assertion.expected) {
          return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false));
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false));
        }
        if (!isRecord(parsed) || !isHash(assertion.expected)) {
          return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false));
        }
        const canonical = canonicalHash(toJsonValue(parsed));
        if (canonical !== assertion.expected) {
          return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false));
        }
        const payloadResult = validateCapacityPayload(parsed);
        if (!payloadResult.ok) {
          return payloadResult;
        }
        payload = payloadResult.value;
      } catch {
        return err(capacityError("E_CAPACITY_UNAVAILABLE", "capacity_evidence", false));
      }
      // 5. binding equality and details membership
      const details: unknown = capability.details;
      if (!isRecord(details) || !Array.isArray(details["model_scope_keys"])) {
        return err(capacityError("E_CAPACITY_UNAVAILABLE", "capacity_binding", false));
      }
      const modelScopeKeys = details["model_scope_keys"];
      if (!modelScopeKeys.includes(input.model_scope_key)) {
        return err(capacityError("E_CAPACITY_BINDING_MISMATCH", "capacity_binding", false));
      }
      if (
        payload.config_space_id !== input.config_space_id ||
        payload.capability_binding_key !== input.capability_binding_key ||
        payload.model.provider !== input.model.provider ||
        payload.model.model_id !== input.model.model_id ||
        payload.model.variant !== input.model.variant ||
        payload.model.resolution_source !== input.model.resolution_source ||
        payload.model_scope_key !== input.model_scope_key
      ) {
        return err(capacityError("E_CAPACITY_BINDING_MISMATCH", "capacity_binding", false));
      }
      if (payload.observed_at !== probe.checked_at) {
        return err(capacityError("E_CAPACITY_BINDING_MISMATCH", "capacity_binding", false));
      }
      // 6. only host_capability_readback has a producer today
      if (payload.source_kind === "model_catalog") {
        return err(capacityError("E_CAPACITY_NOT_FOUND", "capacity_source", false));
      }
      // 7. return the frozen projection
      return ok({
        schema_version: "rsi.capacity_evidence/1",
        config_space_id: payload.config_space_id,
        capability_binding_key: payload.capability_binding_key,
        model: payload.model,
        model_scope_key: payload.model_scope_key,
        scope: "window_tokens",
        window_tokens: payload.window_tokens,
        unit: "tokens",
        source_kind: payload.source_kind,
        evidence_ref: assertion.observed_ref,
        evidence_hash: assertion.expected as Hash,
        observed_at: payload.observed_at
      });
    }
  };
}

function validateCapacityPayload(
  value: Record<string, unknown>
): Result<CapacityEvidencePayload, ErrorEnvelope> {
  if (value["schema_version"] !== "rsi.capacity_evidence_payload/1") {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "schema_version", "rsi.capacity_evidence_payload/1"));
  }
  if (!isModelRef(value["model"])) {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "model", "model_ref"));
  }
  if (typeof value["config_space_id"] !== "string" || !isHash(value["config_space_id"])) {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "config_space_id", "sha256_hash"));
  }
  if (typeof value["capability_binding_key"] !== "string" || !isHash(value["capability_binding_key"])) {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "capability_binding_key", "sha256_hash"));
  }
  if (value["scope"] !== "window_tokens" || value["unit"] !== "tokens") {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "scope", "window_tokens"));
  }
  const windowTokens = value["window_tokens"];
  if (!isSafePositiveInt(windowTokens)) {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "window_tokens", "positive_safe_integer"));
  }
  if (value["source_kind"] !== "host_capability_readback" && value["source_kind"] !== "model_catalog") {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "source_kind", "capacity_source_kind"));
  }
  const observedAt = value["observed_at"];
  if (!isSafeNonNegativeInt(observedAt)) {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "observed_at", "non_negative_safe_integer"));
  }
  if (typeof value["model_scope_key"] !== "string" || value["model_scope_key"].length === 0) {
    return err(capacityError("E_CAPACITY_HASH_MISMATCH", "capacity_evidence", false, "model_scope_key", "non_empty_string"));
  }
  return ok({
    schema_version: "rsi.capacity_evidence_payload/1",
    config_space_id: value["config_space_id"] as Hash,
    capability_binding_key: value["capability_binding_key"] as Hash,
    model: value["model"],
    model_scope_key: value["model_scope_key"],
    scope: "window_tokens",
    window_tokens: windowTokens,
    unit: "tokens",
    source_kind: value["source_kind"],
    observed_at: observedAt
  });
}
