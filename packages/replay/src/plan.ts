/**
 * `ReplayPlan` parsing and creation (DD-FND-094).
 *
 * `replay.create` only persists a `planned` plan. The server computes
 * `plan_hash`; the client never supplies it. Duplicate
 * `(validation_plan_id, plan_hash)` is an idempotent `created=false` at the
 * service layer; this module produces the frozen row value.
 */

import {
  err,
  isWellFormedUnicode,
  newId,
  ok,
  parseSourceRef,
  parseVersionBinding,
  sortUtf8,
} from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result, SourceRef } from "@evoplug/core";

import { replaySchemaError } from "./errors.js";
import { computeReplayPlanHash } from "./hash.js";
import {
  REPLAY_MAX_COMMAND_BYTES,
  REPLAY_PLAN_SCHEMA_VERSION,
  REPLAY_SIDE_EFFECT_KINDS,
  isReplayClass,
  type ReplayClassificationEvidence,
  type ReplayEnvironment,
  type ReplayIsolation,
  type ReplayPlan,
  type ReplayPlanDraft,
  type ReplaySideEffectKind,
} from "./types.js";

const PLAN_FIELDS: readonly string[] = [
  "schema_version",
  "validation_plan_id",
  "replay_class",
  "command",
  "cwd",
  "allowed_network",
  "network_target",
  "classification_evidence",
  "environment",
  "isolation",
  "side_effect_kinds",
  "side_effect_refs",
  "version_binding",
];

const ISOLATION_FIELDS: readonly string[] = [
  "mechanism",
  "verified",
  "evidence_ref",
  "network_namespace",
  "writable_roots",
];

const SANDBOX_MECHANISMS: readonly string[] = ["container", "vm", "os_sandbox"];

/** Parses and validates a `ReplayPlanDraft` from the IPC boundary. */
export function parseReplayPlanDraft(value: unknown): Result<ReplayPlanDraft, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(replaySchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PLAN_FIELDS.includes(key)) {
      return err(replaySchemaError(key, "known_field"));
    }
  }
  for (const field of PLAN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(replaySchemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== REPLAY_PLAN_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_PLAN_SCHEMA_VERSION));
  }
  const validationPlanId = parseUtf8Text(
    record["validation_plan_id"],
    "validation_plan_id",
    128,
    true,
  );
  if (!validationPlanId.ok) {
    return validationPlanId;
  }
  const replayClass = record["replay_class"];
  if (typeof replayClass !== "string" || !isReplayClass(replayClass)) {
    return err(replaySchemaError("replay_class", "replay_class"));
  }
  const command = parseUtf8Text(record["command"], "command", REPLAY_MAX_COMMAND_BYTES, false);
  if (!command.ok) {
    return command;
  }
  if (command.value.includes("\u0000")) {
    return err(replaySchemaError("command", "no_nul"));
  }
  const cwd = parseAbsolutePath(record["cwd"], "cwd");
  if (!cwd.ok) {
    return cwd;
  }
  const allowedNetwork = record["allowed_network"];
  if (typeof allowedNetwork !== "boolean") {
    return err(replaySchemaError("allowed_network", "boolean"));
  }
  const networkTarget = parseNetworkTargetField(record["network_target"], allowedNetwork);
  if (!networkTarget.ok) {
    return networkTarget;
  }
  const evidence = record["classification_evidence"];
  if (!isClassificationEvidence(evidence)) {
    return err(replaySchemaError("classification_evidence", "classification_evidence"));
  }
  const environment = record["environment"];
  if (!isEnvironment(environment)) {
    return err(replaySchemaError("environment", "replay_environment"));
  }
  const isolation = parseReplayIsolation(record["isolation"]);
  if (!isolation.ok) {
    return isolation;
  }
  const sideEffectKinds = parseReplaySideEffectKinds(record["side_effect_kinds"]);
  if (!sideEffectKinds.ok) {
    return sideEffectKinds;
  }
  const sideEffectRefs = parseSideEffectRefs(record["side_effect_refs"]);
  if (!sideEffectRefs.ok) {
    return sideEffectRefs;
  }
  const binding = parseVersionBinding(record["version_binding"]);
  if (!binding.ok) {
    return binding;
  }
  const draft: ReplayPlanDraft = {
    schema_version: REPLAY_PLAN_SCHEMA_VERSION,
    validation_plan_id: validationPlanId.value,
    replay_class: replayClass,
    command: command.value,
    cwd: cwd.value,
    allowed_network: allowedNetwork,
    network_target: networkTarget.value,
    classification_evidence: evidence,
    environment,
    isolation: isolation.value,
    side_effect_kinds: sideEffectKinds.value,
    side_effect_refs: sideEffectRefs.value,
    version_binding: binding.value,
  };
  return validateReplayPlanDraft(draft);
}

/**
 * Enforces the class/evidence matrix:
 * - `read_only` never allows network and needs tool or observed evidence;
 * - `sandboxed_temp` needs a verified container/VM/OS sandbox in a `sandbox`
 *   environment; a temp copy or cwd change is not a sandbox;
 * - `live_external` has no automatic path and needs a single-use approval.
 */
export function validateReplayPlanDraft(
  draft: ReplayPlanDraft,
): Result<ReplayPlanDraft, ErrorEnvelope> {
  if (draft.replay_class === "read_only") {
    if (draft.allowed_network) {
      return err(replaySchemaError("allowed_network", "read_only_no_network"));
    }
    if (draft.classification_evidence === "none") {
      return err(replaySchemaError("classification_evidence", "read_only_needs_evidence"));
    }
  }
  if (draft.replay_class === "sandboxed_temp") {
    if (draft.environment !== "sandbox") {
      return err(replaySchemaError("environment", "sandboxed_temp_requires_sandbox"));
    }
    if (!draft.isolation.verified) {
      return err(replaySchemaError("isolation.verified", "sandboxed_temp_requires_verified"));
    }
    if (!SANDBOX_MECHANISMS.includes(draft.isolation.mechanism)) {
      return err(replaySchemaError("isolation.mechanism", "container_vm_or_os_sandbox"));
    }
  }
  if (draft.isolation.verified) {
    if (draft.isolation.mechanism === "none") {
      return err(replaySchemaError("isolation.mechanism", "verified_needs_mechanism"));
    }
    if (draft.isolation.evidence_ref === null) {
      return err(replaySchemaError("isolation.evidence_ref", "verified_needs_evidence"));
    }
  }
  return ok(draft);
}

/** Creates the frozen `planned` plan row with a server-computed hash. */
export function createReplayPlan(
  draft: ReplayPlanDraft,
  replayPlanId: Id<"rpl"> = newId("rpl"),
): Result<ReplayPlan, ErrorEnvelope> {
  const validated = validateReplayPlanDraft(draft);
  if (!validated.ok) {
    return validated;
  }
  const normalized = normalizeDraft(validated.value);
  const plan: ReplayPlan = {
    ...normalized,
    replay_plan_id: replayPlanId,
    state: "planned",
    plan_hash: computeReplayPlanHash(normalized),
    row_version: 1,
  };
  return ok(plan);
}

/** Recomputes the plan hash from the stored row. */
export function recomputeReplayPlanHash(plan: ReplayPlan): Hash {
  return computeReplayPlanHash(plan);
}

/** Returns true when the stored hash still matches the plan fields. */
export function replayPlanHashMatches(plan: ReplayPlan): boolean {
  return plan.plan_hash === recomputeReplayPlanHash(plan);
}

function normalizeDraft(draft: ReplayPlanDraft): ReplayPlanDraft {
  return {
    ...draft,
    side_effect_kinds: sortUtf8(draft.side_effect_kinds, (kind) => kind),
    side_effect_refs: sortUtf8(draft.side_effect_refs, (ref) => ref),
  };
}

/** Parses a `ReplayIsolation` object. */
export function parseReplayIsolation(value: unknown): Result<ReplayIsolation, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(replaySchemaError("isolation", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ISOLATION_FIELDS.includes(key)) {
      return err(replaySchemaError(`isolation.${key}`, "known_field"));
    }
  }
  for (const field of ISOLATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(replaySchemaError(`isolation.${field}`, "required"));
    }
  }
  const mechanism = record["mechanism"];
  if (
    mechanism !== "none" &&
    mechanism !== "container" &&
    mechanism !== "vm" &&
    mechanism !== "os_sandbox"
  ) {
    return err(replaySchemaError("isolation.mechanism", "isolation_mechanism"));
  }
  const verified = record["verified"];
  if (typeof verified !== "boolean") {
    return err(replaySchemaError("isolation.verified", "boolean"));
  }
  const evidenceRef = record["evidence_ref"];
  let parsedEvidence: SourceRef | null;
  if (evidenceRef === null) {
    parsedEvidence = null;
  } else if (typeof evidenceRef === "string") {
    const parsed = parseSourceRef(evidenceRef);
    if (!parsed.ok) {
      return parsed;
    }
    parsedEvidence = parsed.value.source_ref;
  } else {
    return err(replaySchemaError("isolation.evidence_ref", "source_ref_or_null"));
  }
  const networkNamespace = record["network_namespace"];
  if (typeof networkNamespace !== "boolean") {
    return err(replaySchemaError("isolation.network_namespace", "boolean"));
  }
  const writableRoots = parseWritableRoots(record["writable_roots"]);
  if (!writableRoots.ok) {
    return writableRoots;
  }
  return ok({
    mechanism,
    verified,
    evidence_ref: parsedEvidence,
    network_namespace: networkNamespace,
    writable_roots: writableRoots.value,
  });
}

function parseWritableRoots(value: unknown): Result<string[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(replaySchemaError("isolation.writable_roots", "array"));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseAbsolutePath(value[index], `isolation.writable_roots[${String(index)}]`);
    if (!parsed.ok) {
      return parsed;
    }
    if (seen.has(parsed.value)) {
      return err(replaySchemaError("isolation.writable_roots", "unique"));
    }
    seen.add(parsed.value);
    out.push(parsed.value);
  }
  return ok(out);
}

/** Parses the side-effect kind set (closed union, unique). */
export function parseReplaySideEffectKinds(
  value: unknown,
): Result<ReplaySideEffectKind[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(replaySchemaError("side_effect_kinds", "array"));
  }
  const seen = new Set<ReplaySideEffectKind>();
  const out: ReplaySideEffectKind[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || !REPLAY_SIDE_EFFECT_KINDS.some((kind) => kind === item)) {
      return err(replaySchemaError(`side_effect_kinds[${String(index)}]`, "side_effect_kind"));
    }
    const kind = item as ReplaySideEffectKind;
    if (seen.has(kind)) {
      return err(replaySchemaError(`side_effect_kinds[${String(index)}]`, "unique"));
    }
    seen.add(kind);
    out.push(kind);
  }
  return ok(out);
}

function parseSideEffectRefs(value: unknown): Result<SourceRef[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(replaySchemaError("side_effect_refs", "array"));
  }
  const seen = new Set<SourceRef>();
  const out: SourceRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      return err(replaySchemaError(`side_effect_refs[${String(index)}]`, "string"));
    }
    const parsed = parseSourceRef(item);
    if (!parsed.ok) {
      return parsed;
    }
    if (seen.has(parsed.value.source_ref)) {
      return err(replaySchemaError(`side_effect_refs[${String(index)}]`, "unique"));
    }
    seen.add(parsed.value.source_ref);
    out.push(parsed.value.source_ref);
  }
  return ok(out);
}

function parseNetworkTargetField(
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
    return parsed;
  }
  return ok(`${parsed.value.host}:${String(parsed.value.port)}`);
}

/**
 * Parses an exact replay `host:port` target. Unlike an egress endpoint this
 * carries no public-address restriction: reachability is decided later by
 * `EgressPolicy` for every hop.
 */
export function parseReplayNetworkTarget(
  value: string,
): Result<{ host: string; port: number }, ErrorEnvelope> {
  if (typeof value !== "string" || value.length === 0) {
    return err(replaySchemaError("network_target", "host_port"));
  }
  if (/\s/.test(value) || value.includes("\u0000")) {
    return err(replaySchemaError("network_target", "no_whitespace_or_nul"));
  }
  if (value.includes("/") || value.includes("@") || value.includes("#") || value.includes("?")) {
    return err(replaySchemaError("network_target", "host_port_only"));
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    return err(replaySchemaError("network_target", "host_port"));
  }
  const rawHost = value.slice(0, separator);
  const portText = value.slice(separator + 1);
  if (!/^[1-9][0-9]{0,4}$/.test(portText)) {
    return err(replaySchemaError("network_target.port", "1_65535"));
  }
  const port = Number(portText);
  if (port > 65_535) {
    return err(replaySchemaError("network_target.port", "1_65535"));
  }
  let host: string;
  if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
    const inner = rawHost.slice(1, -1);
    if (inner.length === 0 || !/^[0-9a-fA-F:.]+$/.test(inner)) {
      return err(replaySchemaError("network_target.host", "ipv6_literal"));
    }
    host = `[${inner.toLowerCase()}]`;
  } else {
    if (!/^[A-Za-z0-9.-]+$/.test(rawHost) || rawHost.startsWith("-") || rawHost.endsWith("-")) {
      return err(replaySchemaError("network_target.host", "dns_name"));
    }
    host = rawHost.toLowerCase();
  }
  return ok({ host, port });
}

function parseAbsolutePath(value: unknown, path: string): Result<string, ErrorEnvelope> {
  if (typeof value !== "string" || value.length === 0) {
    return err(replaySchemaError(path, "non_empty_string"));
  }
  if (!value.startsWith("/")) {
    return err(replaySchemaError(path, "absolute_posix"));
  }
  if (value.includes("\u0000")) {
    return err(replaySchemaError(path, "no_nul"));
  }
  if (value.includes("//")) {
    return err(replaySchemaError(path, "no_double_slash"));
  }
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") {
      return err(replaySchemaError(path, "no_dot_segments"));
    }
  }
  return ok(value);
}

function parseUtf8Text(
  value: unknown,
  path: string,
  maxBytes: number,
  rejectControl: boolean,
): Result<string, ErrorEnvelope> {
  if (typeof value !== "string" || value.length === 0) {
    return err(replaySchemaError(path, "non_empty_string"));
  }
  if (!isWellFormedUnicode(value)) {
    return err(replaySchemaError(path, "well_formed_unicode"));
  }
  if (new TextEncoder().encode(value).length > maxBytes) {
    return err(replaySchemaError(path, `max_${String(maxBytes)}_bytes`));
  }
  if (rejectControl) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x20 || code === 0x7f) {
        return err(replaySchemaError(path, "no_control_characters"));
      }
    }
  }
  return ok(value);
}

function isClassificationEvidence(value: unknown): value is ReplayClassificationEvidence {
  return value === "tool_metadata" || value === "observed_effects" || value === "none";
}

function isEnvironment(value: unknown): value is ReplayEnvironment {
  return value === "host" || value === "temp_copy" || value === "sandbox";
}

/** Returns true when the isolation evidence proves a real sandbox. */
export function isVerifiedSandbox(isolation: ReplayIsolation): boolean {
  return (
    isolation.verified &&
    (isolation.mechanism === "container" ||
      isolation.mechanism === "vm" ||
      isolation.mechanism === "os_sandbox")
  );
}

/**
 * Closed plan transition set (DD-FND-097.5):
 * planned→running, unverified→running, running→passed|failed|unverified,
 * planned→unverified, planned|unverified→rejected.
 */
export function isValidReplayPlanTransition(
  from: ReplayPlan["state"],
  to: ReplayPlan["state"],
): boolean {
  switch (from) {
    case "planned":
      return to === "running" || to === "unverified" || to === "rejected";
    case "unverified":
      return to === "running" || to === "rejected";
    case "running":
      return to === "passed" || to === "failed" || to === "unverified";
    case "passed":
    case "failed":
    case "rejected":
      return false;
    default:
      return false;
  }
}

/** Applies one plan transition; terminal plans never move again. */
export function transitionReplayPlan(
  plan: ReplayPlan,
  to: ReplayPlan["state"],
): Result<ReplayPlan, ErrorEnvelope> {
  if (!isValidReplayPlanTransition(plan.state, to)) {
    return err(replaySchemaError("state", "plan_transition"));
  }
  return ok({ ...plan, state: to, row_version: plan.row_version + 1 });
}
