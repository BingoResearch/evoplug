/**
 * Replay classification (DD-FND-094).
 *
 * `read_only` requires tool metadata or observed effects proving the absence
 * of writes, network, process spawn and external state. `sandboxed_temp`
 * requires a verified container/VM/OS sandbox; a temp copy, cwd change or
 * environment variable is never a sandbox. `live_external` is always
 * observe-only until a single-use approval is issued. Unknown evidence is
 * never downgraded to `read_only`; the caller treats `unknown` conservatively
 * as `live_external`.
 */

import { err, isWellFormedUnicode, ok, parseSourceRef } from "@evoplug/core";
import type { ErrorEnvelope, Result, SourceRef } from "@evoplug/core";

import { replaySchemaError } from "./errors.js";
import {
  isVerifiedSandbox,
  parseReplayIsolation,
  parseReplayNetworkTarget,
  parseReplaySideEffectKinds,
} from "./plan.js";
import {
  REPLAY_CLASSIFY_SCHEMA_VERSION,
  REPLAY_MAX_COMMAND_BYTES,
  isReplayClass,
  type ReplayClassification,
  type ReplayClassificationEvidence,
  type ReplayClassifyRequest,
  type ReplayEnvironment,
  type ReplayPlan,
  type ReplaySideEffectKind,
} from "./types.js";

const CLASSIFY_FIELDS: readonly string[] = [
  "schema_version",
  "validation_plan_id",
  "command",
  "cwd",
  "requested_class",
  "allowed_network",
  "network_target",
  "environment",
  "isolation",
  "tool_metadata_ref",
  "observed_effects",
];

/** Parses a `ReplayClassifyRequest`; this method never persists anything. */
export function parseReplayClassifyRequest(
  value: unknown,
): Result<ReplayClassifyRequest, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(replaySchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CLASSIFY_FIELDS.includes(key)) {
      return err(replaySchemaError(key, "known_field"));
    }
  }
  for (const field of CLASSIFY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(replaySchemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== REPLAY_CLASSIFY_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_CLASSIFY_SCHEMA_VERSION));
  }
  const validationPlanId = record["validation_plan_id"];
  if (typeof validationPlanId !== "string" || validationPlanId.length === 0) {
    return err(replaySchemaError("validation_plan_id", "non_empty_string"));
  }
  const command = record["command"];
  if (typeof command !== "string" || command.length === 0) {
    return err(replaySchemaError("command", "non_empty_string"));
  }
  if (!isWellFormedUnicode(command)) {
    return err(replaySchemaError("command", "well_formed_unicode"));
  }
  if (new TextEncoder().encode(command).length > REPLAY_MAX_COMMAND_BYTES) {
    return err(replaySchemaError("command", `max_${String(REPLAY_MAX_COMMAND_BYTES)}_bytes`));
  }
  if (command.includes("\u0000")) {
    return err(replaySchemaError("command", "no_nul"));
  }
  const cwd = record["cwd"];
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.includes("\u0000")) {
    return err(replaySchemaError("cwd", "absolute_posix"));
  }
  const requestedClass = record["requested_class"];
  if (typeof requestedClass !== "string" || !isReplayClass(requestedClass)) {
    return err(replaySchemaError("requested_class", "replay_class"));
  }
  const allowedNetwork = record["allowed_network"];
  if (typeof allowedNetwork !== "boolean") {
    return err(replaySchemaError("allowed_network", "boolean"));
  }
  const networkTarget = parseTarget(record["network_target"], allowedNetwork);
  if (!networkTarget.ok) {
    return networkTarget;
  }
  const environment = record["environment"];
  if (!isEnvironment(environment)) {
    return err(replaySchemaError("environment", "replay_environment"));
  }
  const isolation = parseReplayIsolation(record["isolation"]);
  if (!isolation.ok) {
    return isolation;
  }
  const metadataRef = parseOptionalSourceRef(record["tool_metadata_ref"]);
  if (!metadataRef.ok) {
    return metadataRef;
  }
  const observed = parseReplaySideEffectKinds(record["observed_effects"]);
  if (!observed.ok) {
    return observed;
  }
  return ok({
    schema_version: REPLAY_CLASSIFY_SCHEMA_VERSION,
    validation_plan_id: validationPlanId,
    command,
    cwd,
    requested_class: requestedClass,
    allowed_network: allowedNetwork,
    network_target: networkTarget.value,
    environment,
    isolation: isolation.value,
    tool_metadata_ref: metadataRef.value,
    observed_effects: observed.value,
  });
}

/** Classifies a replay plan request without any side effect. */
export function classifyReplay(
  input: ReplayClassifyRequest,
): Result<ReplayClassification, ErrorEnvelope> {
  if (input.schema_version !== REPLAY_CLASSIFY_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_CLASSIFY_SCHEMA_VERSION));
  }
  const observed = uniqueKinds(input.observed_effects);
  const hasMetadata = input.tool_metadata_ref !== null;
  const hasObserved = observed.length > 0;
  const evidence = evidenceOf(hasMetadata, hasObserved);
  const dynamicCommand = isDynamicCommand(input.command);

  if (input.requested_class === "read_only") {
    if (input.allowed_network || observed.length > 0) {
      // Any network path or observed effect makes this a live external action.
      if (evidence === null) {
        return unknown(dynamicCommand ? "command_dynamic" : "effects_unobserved");
      }
      return ok({
        state: "known",
        requested_class: "live_external",
        allowed_network: input.allowed_network,
        network_target: input.allowed_network ? input.network_target : null,
        classification_evidence: evidence,
        side_effect_kinds: observed,
      });
    }
    if (!hasMetadata && !hasObserved) {
      return unknown(dynamicCommand ? "command_dynamic" : "tool_metadata_missing");
    }
    return ok({
      state: "known",
      requested_class: "read_only",
      allowed_network: false,
      network_target: null,
      classification_evidence: evidence ?? "tool_metadata",
      side_effect_kinds: [],
    });
  }

  if (input.requested_class === "sandboxed_temp") {
    if (!isVerifiedSandbox(input.isolation)) {
      return unknown("isolation_unverified");
    }
    if (!hasMetadata && !hasObserved) {
      return unknown(dynamicCommand ? "command_dynamic" : "tool_metadata_missing");
    }
    return ok({
      state: "known",
      requested_class: "sandboxed_temp",
      allowed_network: input.allowed_network,
      network_target: input.allowed_network ? input.network_target : null,
      classification_evidence: evidence ?? "tool_metadata",
      side_effect_kinds: observed,
    });
  }

  if (!hasMetadata && !hasObserved) {
    return unknown(dynamicCommand ? "command_dynamic" : "effects_unobserved");
  }
  return ok({
    state: "known",
    requested_class: "live_external",
    allowed_network: input.allowed_network,
    network_target: input.allowed_network ? input.network_target : null,
    classification_evidence: evidence ?? "tool_metadata",
    side_effect_kinds: observed,
  });
}

/**
 * Converts a classification into the plan fields it constrains. Unknown
 * classifications are rejected: the caller must obtain evidence or request
 * an explicit single-use approval for a `live_external` plan.
 */
export function classificationToPlanFields(
  classification: ReplayClassification,
): Result<{
  replay_class: "read_only" | "sandboxed_temp" | "live_external";
  allowed_network: boolean;
  network_target: string | null;
  classification_evidence: ReplayClassificationEvidence;
  side_effect_kinds: ReplayPlan["side_effect_kinds"];
}, ErrorEnvelope> {
  if (classification.state === "unknown") {
    return err(replaySchemaError("classification", classification.reason_code));
  }
  return ok({
    replay_class: classification.requested_class,
    allowed_network: classification.allowed_network,
    network_target: classification.network_target,
    classification_evidence: classification.classification_evidence,
    side_effect_kinds: classification.side_effect_kinds,
  });
}

/** Shell substitution, backticks and globbing make static classification impossible. */
export function isDynamicCommand(command: string): boolean {
  return (
    command.includes("$(") ||
    command.includes("${") ||
    command.includes("`") ||
    /(^|[^\\])[*?]/.test(command)
  );
}

function evidenceOf(
  hasMetadata: boolean,
  hasObserved: boolean,
): "tool_metadata" | "observed_effects" | null {
  if (hasMetadata) {
    return "tool_metadata";
  }
  if (hasObserved) {
    return "observed_effects";
  }
  return null;
}

function uniqueKinds(kinds: readonly ReplaySideEffectKind[]): ReplaySideEffectKind[] {
  const seen = new Set<ReplaySideEffectKind>();
  const out: ReplaySideEffectKind[] = [];
  for (const kind of kinds) {
    if (!seen.has(kind)) {
      seen.add(kind);
      out.push(kind);
    }
  }
  return out;
}

function unknown(
  reason:
    | "tool_metadata_missing"
    | "effects_unobserved"
    | "isolation_unverified"
    | "command_dynamic",
): Result<ReplayClassification, ErrorEnvelope> {
  return ok({ state: "unknown", reason_code: reason });
}

function parseOptionalSourceRef(value: unknown): Result<SourceRef | null, ErrorEnvelope> {
  if (value === null) {
    return ok(null);
  }
  if (typeof value !== "string") {
    return err(replaySchemaError("tool_metadata_ref", "source_ref_or_null"));
  }
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    return parsed;
  }
  return ok(parsed.value.source_ref);
}

function parseTarget(
  value: unknown,
  allowedNetwork: boolean,
): Result<string | null, ErrorEnvelope> {
  if (!allowedNetwork) {
    if (value !== null) {
      return err(replaySchemaError("network_target", "null_when_network_disallowed"));
    }
    return ok(null);
  }
  if (typeof value !== "string") {
    return err(replaySchemaError("network_target", "host_port_required"));
  }
  const parsed = parseReplayNetworkTarget(value);
  if (!parsed.ok) {
    return err(replaySchemaError("network_target", "host_port"));
  }
  return ok(`${parsed.value.host}:${String(parsed.value.port)}`);
}

function isEnvironment(value: unknown): value is ReplayEnvironment {
  return value === "host" || value === "temp_copy" || value === "sandbox";
}
