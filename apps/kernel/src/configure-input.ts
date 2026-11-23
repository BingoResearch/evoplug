/**
 * Shared user-facing configure input builders (G9) and the Jev provider metadata
 * probe (closure design §9.1 / G9).
 *
 * Both the local kernel bridge and the running kernel's IPC bridge accept the
 * same small flags (`--endpoint`, `--model`, `--credential-env`,
 * `--request-max-tokens`, `--question-max-tokens`, `--skip-probe`) and must
 * produce identical profile/capability structures.
 *
 * The probe exists because a profile whose `limits.source` is `unknown` is
 * blocked by the evidence layer, and a profile with no `h_evidence_refs` is
 * `endpoint_unverified`. Fetching the provider's own model metadata gives both
 * a real limits source and a retrievable evidence blob, without asking the user
 * to assemble internal JSON.
 */

import { canonicalJsonText, err, hashBytes, ok, type ErrorEnvelope, type Hash, type JsonValue, type Result, type SourceRef } from "@evoplug/core";
import { fieldError } from "@evoplug/kernel";
import type { JevProvisioningInput } from "@evoplug/kernel";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROBE_TIMEOUT_MS = 10_000;

/** Validates a credential environment variable name; the value is never read. */
export function validateCredentialEnv(value: string | null): Result<string, ErrorEnvelope> {
  if (value === null || value.length === 0) {
    return err(fieldError("--credential-env", "missing_required"));
  }
  if (!ENV_NAME_PATTERN.test(value)) {
    return err(fieldError("--credential-env", "environment_variable_name"));
  }
  return ok(value);
}

export interface JevLimitsInput {
  readonly request_max_tokens: number | null;
  readonly question_max_tokens: number | null;
}

/** Parses the two explicit limit flags; both must be positive integers. */
export function parseLimitsOptions(
  requestMax: string | null,
  questionMax: string | null
): Result<JevLimitsInput, ErrorEnvelope> {
  const parse = (value: string | null, flag: string): number | null | ErrorEnvelope => {
    if (value === null) return null;
    if (!/^[1-9][0-9]*$/u.test(value)) return fieldError(flag, "positive_int");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > 16_777_216) {
      return fieldError(flag, "positive_int");
    }
    return parsed;
  };
  const request = parse(requestMax, "--request-max-tokens");
  if (request !== null && typeof request === "object") return err(request);
  const question = parse(questionMax, "--question-max-tokens");
  if (question !== null && typeof question === "object") return err(question);
  if (request !== null && question !== null && question > request) {
    return err(fieldError("--question-max-tokens", "not_above_request_max_tokens"));
  }
  return ok({ request_max_tokens: request, question_max_tokens: question });
}

export interface ProviderMetadataEvidence {
  readonly bytes: Uint8Array;
  readonly ref: SourceRef;
  readonly request_max_tokens: number | null;
  readonly question_max_tokens: number | null;
  readonly long_context: "yes" | "no" | "unknown";
  readonly model_found: boolean;
}

export interface ProviderProbeInput {
  readonly base_url: string;
  readonly route: string;
  readonly model: string;
  /** Optional bearer value read from the registered env var, never logged. */
  readonly credential?: string | undefined;
  readonly now?: number;
  readonly fetch?: typeof fetch;
}

function metadataRoute(baseUrl: string): string {
  return baseUrl.includes("openrouter") ? "/api/v1/models" : "/models";
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function modelRecord(payload: unknown, model: string): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record["data"])
    ? record["data"]
    : Array.isArray(record["models"])
      ? record["models"]
      : null;
  if (list === null) return null;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (row["id"] === model || row["name"] === model) return row;
  }
  return null;
}

/**
 * Fetches the provider's model metadata and turns it into retrievable evidence
 * plus conservative token limits. Nothing is invented: a model that is absent
 * from the response leaves the limits null and the caller decides whether that
 * is acceptable.
 */
export async function probeProviderMetadata(
  input: ProviderProbeInput
): Promise<Result<ProviderMetadataEvidence, ErrorEnvelope>> {
  const doFetch = input.fetch ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.credential !== undefined && input.credential.length > 0) {
    headers["authorization"] = `Bearer ${input.credential}`;
  }
  let response: Response;
  try {
    response = await doFetch(`${input.base_url}${metadataRoute(input.base_url)}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
  } catch (error) {
    return err(fieldError("--endpoint", `metadata_unreachable:${error instanceof Error ? error.name : "error"}`));
  }
  if (!response.ok) {
    return err(fieldError("--endpoint", `metadata_http_${String(response.status)}`));
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return err(fieldError("--endpoint", "metadata_json"));
  }
  const row = modelRecord(payload, input.model);
  const contextLength = row === null ? null : positiveInt(row["context_length"]);
  const topProvider =
    row !== null && typeof row["top_provider"] === "object" && row["top_provider"] !== null
      ? (row["top_provider"] as Record<string, unknown>)
      : null;
  const maxCompletion =
    topProvider === null ? null : positiveInt(topProvider["max_completion_tokens"]);
  const requestMax = maxCompletion !== null
    ? Math.min(maxCompletion, 8_192)
    : contextLength !== null
      ? Math.min(contextLength, 4_096)
      : null;
  const questionMax = requestMax === null ? null : Math.min(requestMax, 2_048);
  const longContext =
    contextLength === null ? "unknown" : contextLength >= 131_072 ? "yes" : "no";
  // The evidence body is deterministic for an unchanged provider response so a
  // repeated `configure jev` is idempotent: a volatile timestamp would change
  // the profile key and collide with the already persisted capability row.
  const evidence = {
    schema_version: "rsi.jev_provider_metadata/1",
    base_url: input.base_url,
    metadata_route: metadataRoute(input.base_url),
    requested_model: input.model,
    observed: {
      model_found: row !== null,
      context_length: contextLength,
      max_completion_tokens: maxCompletion,
      status: response.status
    }
  };
  const bytes = new TextEncoder().encode(canonicalJsonText(evidence as unknown as JsonValue));
  const hash = hashBytes(bytes);
  return ok({
    bytes,
    ref: `blob://${hash}#bytes=0-${String(bytes.byteLength)}` as SourceRef,
    request_max_tokens: requestMax,
    question_max_tokens: questionMax,
    long_context: longContext,
    model_found: row !== null
  });
}

/**
 * Builds a Jev profile/capability pair from the user surface. Facts the user
 * did not supply stay `unknown`; the command never claims a verified transport
 * or a calibrated competence.
 */
export function buildJevInput(
  endpoint: string | null,
  model: string | null,
  credentialEnv: string,
  limits: JevLimitsInput = { request_max_tokens: null, question_max_tokens: null },
  evidence?: ProviderMetadataEvidence
): Result<
  {
    readonly profile: JevProvisioningInput["profile"];
    readonly capability: JevProvisioningInput["capability"];
  },
  ErrorEnvelope
> {
  if (endpoint === null || endpoint.length === 0) {
    return err(fieldError("--endpoint", "missing_required"));
  }
  if (model === null || model.length === 0) {
    return err(fieldError("--model", "missing_required"));
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return err(fieldError("--endpoint", "absolute_url"));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return err(fieldError("--endpoint", "http_or_https"));
  }
  const provider = url.hostname.includes("openrouter") ? "openrouter" : "typesafe";
  const route = url.pathname === "" || url.pathname === "/" ? "/api/v1/messages" : url.pathname;
  const evidenceRefs = evidence === undefined ? [] : [evidence.ref];
  const profile: JevProvisioningInput["profile"] = {
    provider,
    base_url: url.origin,
    route,
    requested_model: model,
    expected_returned_model: model,
    model_kind: "fixed",
    limits: {
      request_max_tokens: limits.request_max_tokens,
      question_max_tokens: limits.question_max_tokens,
      source: evidence === undefined ? "unknown" : "provider_metadata",
      source_refs: evidenceRefs
    },
    long_context: {
      supported: evidence?.long_context ?? "unknown",
      source_refs: evidenceRefs
    },
    official_precision_policy: "none",
    observed_wire_precision: null,
    precision_contract: "none_published",
    observed_failures: [],
    credential_ref: `env:${credentialEnv}`,
    h_evidence_refs: evidenceRefs
  };
  const capability: JevProvisioningInput["capability"] = {
    backend_kind: "jev_typed",
    implementation_id: `${provider}:${model}`,
    implementation_version: "configure/1",
    method: {
      schema_version: "rsi.method_ref/1",
      method_id: "method:jev",
      method_version: "1",
      rule_version: "1"
    },
    scope: {
      schema_version: "rsi.semantic_scope/1",
      // The kernel's five question templates map to these five classes and
      // every issue type can produce one of them. A narrower default made
      // `goal_change` (and any issue other than missing_requirement) fail
      // `E_SEMANTIC_SCOPE_UNSUPPORTED`, so the Jev path could never dispatch.
      // Arrays stay sorted-unique UTF-8 (`validateScopeShape`).
      question_classes: [
        "acceptance_relation",
        "behavior_relation",
        "experience_match",
        "intent_relation",
        "step_effect"
      ],
      issue_types: [
        "constraint_violation",
        "experience_applicability",
        "goal_change",
        "insufficient_evidence",
        "missing_requirement",
        "missing_verification",
        "stall_or_regression_candidate",
        "wrong_target"
      ],
      state_profiles: ["experience_review", "progress_issue"],
      evidence_kinds: ["source_excerpt"]
    },
    transport_status: evidence === undefined ? "unknown" : "verified",
    // `shadow_only` keeps every answer on the semantic-shadow path; it never
    // upgrades a hard fact, acceptance or authorization. Without an entry per
    // declared class, `missingCompetence` refuses dispatch for that class.
    semantic_competence: [
      "acceptance_relation",
      "behavior_relation",
      "experience_match",
      "intent_relation",
      "step_effect"
    ].map((question_class) => ({
      question_class: question_class as
        | "acceptance_relation"
        | "behavior_relation"
        | "experience_match"
        | "intent_relation"
        | "step_effect",
      status: "shadow_only" as const,
      calibration_ref: null
    })),
    limits: {
      state_supported: true,
      max_questions: 8,
      max_evidence_items: 32,
      max_state_bytes: 64000,
      max_request_bytes: 512000,
      max_response_bytes: 256000
    },
    source_refs: evidenceRefs
  };
  return ok({ profile, capability });
}

/**
 * The full user-facing construction: probe unless skipped, merge explicit
 * limits over probed ones, and refuse to provision a profile the evidence layer
 * can only block when the reason would be invisible to the user.
 */
export async function buildJevInputWithProbe(input: {
  readonly endpoint: string | null;
  readonly model: string | null;
  readonly credentialEnv: string;
  readonly limits: JevLimitsInput;
  readonly skip_probe: boolean;
  readonly credential?: string | undefined;
  readonly now?: number;
  readonly fetch?: typeof fetch;
}): Promise<
  Result<
    {
      readonly profile: JevProvisioningInput["profile"];
      readonly capability: JevProvisioningInput["capability"];
      readonly evidence_bytes: Uint8Array | null;
      readonly warnings: readonly string[];
    },
    ErrorEnvelope
  >
> {
  const base = buildJevInput(input.endpoint, input.model, input.credentialEnv, input.limits);
  if (!base.ok) return base;
  if (input.skip_probe) {
    const limitsComplete =
      input.limits.request_max_tokens !== null && input.limits.question_max_tokens !== null;
    return ok({
      ...base.value,
      evidence_bytes: null,
      warnings: limitsComplete
        ? ["acceptance_blocked:endpoint_unverified"]
        : ["acceptance_blocked:limits_unknown", "acceptance_blocked:endpoint_unverified"]
    });
  }
  const probed = await probeProviderMetadata({
    base_url: base.value.profile.base_url,
    route: base.value.profile.route,
    model: base.value.profile.requested_model,
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch })
  });
  if (!probed.ok) return probed;
  const merged = {
    request_max_tokens: input.limits.request_max_tokens ?? probed.value.request_max_tokens,
    question_max_tokens: input.limits.question_max_tokens ?? probed.value.question_max_tokens
  };
  if (merged.request_max_tokens === null || merged.question_max_tokens === null) {
    return err(fieldError("--request-max-tokens", "required_when_metadata_omits_model"));
  }
  const built = buildJevInput(
    input.endpoint,
    input.model,
    input.credentialEnv,
    merged,
    probed.value
  );
  if (!built.ok) return built;
  return ok({
    ...built.value,
    evidence_bytes: probed.value.bytes,
    warnings: probed.value.model_found ? [] : ["metadata:model_not_listed"]
  });
}

/** SHA-256 of the evidence bytes, exposed for callers that log the ref only. */
export function evidenceHash(bytes: Uint8Array): Hash {
  return hashBytes(bytes);
}
