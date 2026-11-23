/**
 * Host-owned feedback intent classifier (W6).
 *
 * This is a product-side adapter, not an evidence/Jev request. Its logical
 * contract is an independent four-class protocol and it never asks a model to
 * generate prose:
 *
 *   request  rsi.feedback_intent_request/1
 *            { schema_version, event_id, candidate_kinds, input }
 *   response rsi.feedback_intent_response/1
 *            { schema_version, kind, confidence, target_issue_id? }
 *
 * `kind` is one of the candidate `HostFeedbackKind`s or `null` ("not feedback");
 * any other field — including a generated body — is rejected. No EVD pack,
 * manifest, plan, judge binding or Jev envelope is fabricated.
 *
 * Wire selection is driven by the persisted backend profile, never guessed:
 *
 *   provider "typesafe"                    -> feedback_json
 *   provider "openrouter", route .../messages
 *                                          -> openrouter_messages (Anthropic wire)
 *   provider "openrouter", route .../chat/completions
 *                                          -> openai_chat_completions
 *
 * The two OpenRouter wires wrap the same logical JSON in the provider's real
 * request/response envelope; the independent protocol is never posted
 * directly to a chat endpoint. The typed reply is read from
 * `response.content` (Messages) or `choices[0].message.content` (chat) and
 * validated with the same closed schema.
 *
 * Nothing here discovers endpoints, credentials or models implicitly. The
 * factory returns a typed `blocked` result unless every primitive is supplied
 * explicitly, and it never performs a network call at construction time.
 */

import {
  isId,
  makeErrorEnvelope,
  ok,
  err,
  type ErrorCode,
  type ErrorEnvelope,
  type Result
} from "@evoplug/core";
import {
  FEEDBACK_KINDS,
  createEvidenceBindingReadPort,
  resolveDefaultEvidenceBinding,
  type EvidenceBindingReadPort,
  type FeedbackIntentModelPort,
  type FeedbackIntentModelReply,
  type FeedbackIntentModelRequest,
  type JevTransportInjection,
  type ResolvedEvidenceBinding
} from "@evoplug/kernel";
import type { BlobStore, SqliteConnection } from "@evoplug/storage";

export const FEEDBACK_INTENT_REQUEST_SCHEMA = "rsi.feedback_intent_request/1";
export const FEEDBACK_INTENT_RESPONSE_SCHEMA = "rsi.feedback_intent_response/1";

/**
 * The four kinds the kernel's model port accepts. Derived from the port type
 * so this module cannot drift from `FeedbackIntentModelPort`.
 */
type HostFeedbackKind = FeedbackIntentModelRequest["candidate_kinds"][number];

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 512;
const MAX_MODEL_LENGTH = 200;
const MAX_CREDENTIAL_REF_LENGTH = 512;

type HostFeedbackWire =
  | "feedback_json"
  | "openrouter_messages"
  | "openai_chat_completions";

/**
 * The persisted Jev backend fields this adapter reads. The names match the
 * frozen profile schema exactly; the adapter adds no endpoint/model fields of
 * its own.
 */
export interface HostFeedbackBackend {
  readonly provider: "typesafe" | "openrouter";
  readonly base_url: string;
  readonly route: string;
  readonly requested_model: string;
  readonly credential_ref: string;
}

/**
 * Extracts the classifier backend from the persisted Jev service profile that
 * `composeDefaultJevTransport` resolved. Capability/legacy rows carry no
 * endpoint or model and return `null` instead of being guessed.
 */
export function feedbackBackendFromPersistedProfile(
  value: unknown
): HostFeedbackBackend | null {
  const profile = recordOf(value);
  if (profile === null) return null;
  if (profile["schema_version"] !== "rsi.jev_service_profile/1") return null;
  const provider = profile["provider"];
  const baseUrl = profile["base_url"];
  const route = profile["route"];
  const requestedModel = profile["requested_model"];
  const credentialRef = profile["credential_ref"];
  if (
    (provider !== "typesafe" && provider !== "openrouter") ||
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    typeof route !== "string" ||
    route.length === 0 ||
    typeof requestedModel !== "string" ||
    requestedModel.length === 0 ||
    typeof credentialRef !== "string" ||
    credentialRef.length === 0
  ) {
    return null;
  }
  return {
    provider,
    base_url: baseUrl,
    route,
    requested_model: requestedModel,
    credential_ref: credentialRef
  };
}

interface HostFeedbackIntentModelOptions {
  readonly backend: HostFeedbackBackend;
  /** Optional assertion; when omitted it is derived from provider + route. */
  readonly wire?: HostFeedbackWire;
  /** Reuse the same host primitives that build the Jev transport. */
  readonly transport: JevTransportInjection;
  readonly timeout_ms?: number;
  readonly max_input_bytes?: number;
  readonly max_response_bytes?: number;
  /** Provider wire cap; only used by the two OpenRouter envelopes. */
  readonly max_output_tokens?: number;
}

type HostFeedbackIntentModelBlockedReason =
  | "credential_resolver_unavailable"
  | "http_executor_unavailable"
  | "endpoint_authorization_unavailable"
  | "endpoint_invalid"
  | "backend_invalid"
  | "wire_incompatible"
  | "limits_invalid"
  | "profile_binding_unresolved"
  | "backend_not_jev_typed"
  | "evd_route_not_feedback";

export type HostFeedbackIntentModelResult =
  | { readonly status: "ready"; readonly model: FeedbackIntentModelPort }
  | {
      readonly status: "blocked";
      readonly reason: HostFeedbackIntentModelBlockedReason;
      readonly detail: string;
      /** Present when the block came from a typed persisted-binding read. */
      readonly error?: ErrorEnvelope;
    };

interface HostFeedbackIntentProtocolRequest {
  readonly schema_version: typeof FEEDBACK_INTENT_REQUEST_SCHEMA;
  readonly event_id: string;
  readonly candidate_kinds: readonly HostFeedbackKind[];
  readonly input: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function fieldError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema.invalid",
    stage: "feedback_classify",
    details: { kind: "field", path, rule }
  });
}

function externalError(
  code: ErrorCode,
  category: "authorization" | "external" | "deadline",
  rule: string,
  retryable: boolean
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category,
    message_key: `error.feedback_intent.${rule}`,
    stage: "feedback_classify",
    retryable,
    details: { kind: "field", path: "response", rule }
  });
}

function credentialError(): ErrorEnvelope {
  return externalError("E_REVIEW_BACKEND_AUTH", "authorization", "credential_unavailable", false);
}

function transportError(retryable: boolean): ErrorEnvelope {
  return externalError("E_REVIEW_BACKEND_UNAVAILABLE", "external", "http_unavailable", retryable);
}

function timeoutError(): ErrorEnvelope {
  return externalError("E_REVIEW_BACKEND_TIMEOUT", "deadline", "timeout", true);
}

function wireFor(backend: HostFeedbackBackend): HostFeedbackWire | null {
  if (backend.provider === "typesafe") return "feedback_json";
  if (backend.route.endsWith("/messages")) return "openrouter_messages";
  if (backend.route.endsWith("/chat/completions")) return "openai_chat_completions";
  return null;
}

function endpointOf(backend: HostFeedbackBackend, allowedHosts: readonly string[]): string | null {
  let base: URL;
  try {
    base = new URL(backend.base_url);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  if (base.username !== "" || base.password !== "") return null;
  const host = base.hostname.toLowerCase();
  const allowed = allowedHosts.map((value) => value.toLowerCase());
  if (!allowed.includes(host)) return null;
  if (!backend.route.startsWith("/") || backend.route.startsWith("//")) return null;
  if (backend.route.includes("\\") || hasControlCharacter(backend.route)) return null;
  try {
    const resolved = new URL(backend.route, base);
    if (resolved.origin !== base.origin) return null;
    if (resolved.username !== "" || resolved.password !== "") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function positiveLimit(value: number | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function candidateKinds(value: unknown): readonly HostFeedbackKind[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > FEEDBACK_KINDS.length) {
    return null;
  }
  const kinds: HostFeedbackKind[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(FEEDBACK_KINDS as readonly string[]).includes(entry)) {
      return null;
    }
    if (kinds.includes(entry as HostFeedbackKind)) return null;
    kinds.push(entry as HostFeedbackKind);
  }
  return kinds;
}

/**
 * Strict closed validator for the typed reply. It returns a typed reply or a
 * schema envelope; it never returns the raw body and never echoes it.
 */
export function validateFeedbackIntentResponse(
  body: unknown,
  candidates: readonly HostFeedbackKind[]
): Result<FeedbackIntentModelReply | null, ErrorEnvelope> {
  const record = recordOf(body);
  if (record === null) return err(fieldError("response", "object"));
  if (!hasOnlyKeys(record, ["schema_version", "kind", "confidence", "target_issue_id"])) {
    return err(fieldError("response", "unknown_field"));
  }
  if (record["schema_version"] !== FEEDBACK_INTENT_RESPONSE_SCHEMA) {
    return err(fieldError("response.schema_version", FEEDBACK_INTENT_RESPONSE_SCHEMA));
  }
  const kind = record["kind"];
  if (kind !== null && (typeof kind !== "string" || !candidates.includes(kind as HostFeedbackKind))) {
    return err(fieldError("response.kind", "candidate_kind_required"));
  }
  const confidence = record["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return err(fieldError("response.confidence", "unit_interval"));
  }
  const target = record["target_issue_id"];
  if (
    target !== undefined &&
    target !== null &&
    (typeof target !== "string" || !isId(target, "issue"))
  ) {
    return err(fieldError("response.target_issue_id", "issue_id_or_null"));
  }
  if (kind === null && target !== undefined && target !== null) {
    return err(fieldError("response.target_issue_id", "target_without_kind"));
  }
  if (kind === null) {
    return ok(null);
  }
  return ok({
    kind: kind as HostFeedbackKind,
    confidence,
    ...(target === undefined ? {} : { target_issue_id: target })
  });
}

/** The logical protocol body, shared by every wire. */
export function buildFeedbackIntentProtocolRequest(
  request: FeedbackIntentModelRequest
): HostFeedbackIntentProtocolRequest {
  return {
    schema_version: FEEDBACK_INTENT_REQUEST_SCHEMA,
    event_id: request.event_id,
    candidate_kinds: [...request.candidate_kinds],
    input: request.content
  };
}

const SYSTEM_INSTRUCTION = [
  "You classify one user message into a single feedback intent.",
  "Return exactly one JSON object and no Markdown or prose.",
  `The object is {"schema_version":"${FEEDBACK_INTENT_RESPONSE_SCHEMA}","kind":<one candidate kind or null>,"confidence":<number in 0..1>,"target_issue_id":<issue id or null>}.`,
  "Do not add any other keys, do not rewrite the message, and do not emit commentary."
].join("\n");

function providerUserContent(protocol: HostFeedbackIntentProtocolRequest): string {
  return [
    "CLASSIFY_JSON_START",
    JSON.stringify(protocol),
    "CLASSIFY_JSON_END"
  ].join("\n");
}

function providerRequestBody(
  wire: HostFeedbackWire,
  backend: HostFeedbackBackend,
  protocol: HostFeedbackIntentProtocolRequest,
  maxOutputTokens: number
): unknown {
  if (wire === "feedback_json") return protocol;
  if (wire === "openrouter_messages") {
    return {
      model: backend.requested_model,
      max_tokens: maxOutputTokens,
      system: SYSTEM_INSTRUCTION,
      messages: [{ role: "user", content: providerUserContent(protocol) }]
    };
  }
  return {
    model: backend.requested_model,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: providerUserContent(protocol) }
    ],
    response_format: { type: "json_object" }
  };
}

function parseTypedJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function textFromMessagesBody(value: unknown): string | null {
  const response = recordOf(value);
  if (response === null || !Array.isArray(response["content"])) return null;
  const chunks: string[] = [];
  for (const entry of response["content"]) {
    const block = recordOf(entry);
    if (block?.["type"] === "text" && typeof block["text"] === "string") {
      chunks.push(block["text"]);
    }
  }
  return chunks.length === 0 ? null : chunks.join("\n");
}

function textFromChatBody(value: unknown): string | null {
  const response = recordOf(value);
  if (response === null || !Array.isArray(response["choices"]) || response["choices"].length === 0) {
    return null;
  }
  const choice = recordOf(response["choices"][0]);
  if (choice === null) return null;
  if (choice["finish_reason"] === "length") return null;
  const message = recordOf(choice["message"]);
  return typeof message?.["content"] === "string" ? message["content"] : null;
}

function typedReplyBody(
  wire: HostFeedbackWire,
  parsed: unknown
): { ok: true; value: unknown } | { ok: false; error: ErrorEnvelope } {
  if (wire === "feedback_json") return { ok: true, value: parsed };
  const text = wire === "openrouter_messages" ? textFromMessagesBody(parsed) : textFromChatBody(parsed);
  if (text === null) {
    return { ok: false, error: fieldError("response.content", "typed_json_missing") };
  }
  const typed = parseTypedJson(text);
  if (typed === null) return { ok: false, error: fieldError("response.content", "json") };
  return { ok: true, value: typed };
}

function staticBlockedReason(
  options: HostFeedbackIntentModelOptions
): { reason: HostFeedbackIntentModelBlockedReason; detail: string } | null {
  if (
    typeof options.transport.credentials !== "object" ||
    options.transport.credentials === null ||
    typeof options.transport.credentials.resolve !== "function"
  ) {
    return {
      reason: "credential_resolver_unavailable",
      detail: "No host-injected credential resolver was supplied; feedback classification stays blocked."
    };
  }
  if (
    typeof options.transport.http !== "object" ||
    options.transport.http === null ||
    typeof options.transport.http.request !== "function"
  ) {
    return {
      reason: "http_executor_unavailable",
      detail: "No host-controlled HTTP executor was supplied; feedback classification stays blocked."
    };
  }
  const hosts = options.transport.allowed_hosts;
  if (
    !Array.isArray(hosts) ||
    hosts.length === 0 ||
    hosts.some((host) => typeof host !== "string" || host.length === 0)
  ) {
    return {
      reason: "endpoint_authorization_unavailable",
      detail: "No explicit non-empty allowed_hosts authorization was supplied; feedback classification stays blocked."
    };
  }
  const backend = options.backend;
  if (
    (backend.provider !== "typesafe" && backend.provider !== "openrouter") ||
    typeof backend.base_url !== "string" ||
    typeof backend.route !== "string" ||
    typeof backend.requested_model !== "string" ||
    backend.requested_model.length === 0 ||
    backend.requested_model.length > MAX_MODEL_LENGTH ||
    hasControlCharacter(backend.requested_model) ||
    typeof backend.credential_ref !== "string" ||
    backend.credential_ref.length === 0 ||
    backend.credential_ref.length > MAX_CREDENTIAL_REF_LENGTH ||
    hasControlCharacter(backend.credential_ref)
  ) {
    return { reason: "backend_invalid", detail: "The persisted feedback backend profile is incomplete." };
  }
  if (endpointOf(backend, hosts) === null) {
    return {
      reason: "endpoint_invalid",
      detail: "The feedback endpoint is not an authorized http(s) origin/route."
    };
  }
  const derived = wireFor(backend);
  if (derived === null || (options.wire !== undefined && options.wire !== derived)) {
    return {
      reason: "wire_incompatible",
      detail: "The configured wire does not match the persisted provider/route."
    };
  }
  if (backend.provider === "openrouter" && derived === "feedback_json") {
    return {
      reason: "wire_incompatible",
      detail: "OpenRouter requires a provider wire; the independent protocol is never posted directly."
    };
  }
  if (
    positiveLimit(options.timeout_ms, DEFAULT_TIMEOUT_MS) === null ||
    positiveLimit(options.max_input_bytes, DEFAULT_MAX_INPUT_BYTES) === null ||
    positiveLimit(options.max_response_bytes, DEFAULT_MAX_RESPONSE_BYTES) === null ||
    positiveLimit(options.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS) === null
  ) {
    return { reason: "limits_invalid", detail: "Feedback classifier limits must be positive integers." };
  }
  return null;
}

/** Instantiates the host-owned classifier; no call is made at construction. */
export function createHostFeedbackIntentModel(
  options: HostFeedbackIntentModelOptions
): HostFeedbackIntentModelResult {
  const blocked = staticBlockedReason(options);
  if (blocked !== null) return { status: "blocked", ...blocked };

  const backend = options.backend;
  const wire = options.wire ?? wireFor(backend)!;
  const url = endpointOf(backend, options.transport.allowed_hosts ?? []);
  if (url === null) {
    return {
      status: "blocked",
      reason: "endpoint_invalid",
      detail: "The feedback endpoint is not an authorized http(s) origin/route."
    };
  }
  const credentials = options.transport.credentials!;
  const http = options.transport.http!;
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxInputBytes = options.max_input_bytes ?? DEFAULT_MAX_INPUT_BYTES;
  const maxResponseBytes = options.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxOutputTokens = options.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const encoder = new TextEncoder();

  const model: FeedbackIntentModelPort = {
    async classify(request) {
      if (typeof request.event_id !== "string" || !isId(request.event_id, "ev")) {
        return err(fieldError("event_id", "ev_id"));
      }
      const candidates = candidateKinds(request.candidate_kinds);
      if (candidates === null) {
        return err(fieldError("candidate_kinds", "feedback_kinds"));
      }
      if (typeof request.content !== "string") {
        return err(fieldError("input", "string"));
      }
      if (request.content.length === 0) {
        // Nothing to classify; the intake records no feedback.
        return ok(null);
      }
      const protocol = buildFeedbackIntentProtocolRequest({
        ...request,
        candidate_kinds: candidates
      });
      if (encoder.encode(JSON.stringify(protocol)).byteLength > maxInputBytes) {
        return err(fieldError("input", "too_large"));
      }
      const body = encoder.encode(
        JSON.stringify(providerRequestBody(wire, backend, protocol, maxOutputTokens))
      );
      if (body.byteLength > maxInputBytes) {
        return err(fieldError("input", "too_large"));
      }

      let authorization: { authorization_header: string } | null;
      try {
        authorization = await credentials.resolve(backend.credential_ref);
      } catch {
        return err(credentialError());
      }
      if (
        authorization === null ||
        typeof authorization.authorization_header !== "string" ||
        authorization.authorization_header.length === 0 ||
        hasControlCharacter(authorization.authorization_header)
      ) {
        return err(credentialError());
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      let response: { status: number; body: Uint8Array };
      try {
        response = await http.request({
          url,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: authorization.authorization_header
          },
          body,
          signal: controller.signal
        });
      } catch {
        return err(timedOut ? timeoutError() : transportError(true));
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) return err(timeoutError());
      if (
        !Number.isSafeInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        return err(transportError(response.status >= 500));
      }
      const responseBody = response.body;
      if (!(responseBody instanceof Uint8Array)) {
        return err(transportError(false));
      }
      if (responseBody.byteLength > maxResponseBytes) {
        return err(fieldError("response", "too_large"));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBody));
      } catch {
        return err(fieldError("response", "json"));
      }
      const typed = typedReplyBody(wire, parsed);
      if (!typed.ok) return err(typed.error);
      return validateFeedbackIntentResponse(typed.value, candidates);
    }
  };

  return { status: "ready", model };
}

/* ------------------------------------------------------------------ */
/* Persisted composition                                               */
/* ------------------------------------------------------------------ */

interface PersistedFeedbackIntentModelOptions {
  /** The kernel's single-writer SQLite connection. */
  readonly connection: SqliteConnection;
  /** Blob store used by the EVD `/3` binding reader. */
  readonly blobs: BlobStore;
  /** Host-owned primitives reused from `JevTransportInjection`. */
  readonly transport: JevTransportInjection;
  readonly timeout_ms?: number;
  readonly max_input_bytes?: number;
  readonly max_response_bytes?: number;
  readonly max_output_tokens?: number;
}

const EVD_DECISION_ROUTE = "/api/alpha/decisions";

/**
 * The persisted Jev typed route points at the EVD decision endpoint, whose
 * body is a judge state envelope. It can never serve the feedback protocol.
 */
function isEvdDecisionRoute(route: string): boolean {
  const trimmed = route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;
  return trimmed === EVD_DECISION_ROUTE || trimmed.startsWith(`${EVD_DECISION_ROUTE}/`);
}

interface PersistedFeedbackBinding {
  readonly profile_key: string;
  readonly backend: HostFeedbackBackend;
}

type PersistedBindingRead =
  | { readonly status: "ok"; readonly binding: PersistedFeedbackBinding }
  | {
      readonly status: "unresolved";
      readonly reason: HostFeedbackIntentModelBlockedReason;
      readonly detail: string;
      readonly error: ErrorEnvelope;
    };

function capabilityError(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CAPABILITY",
    category: "policy",
    message_key: "error.feedback_intent.jev_typed_required",
    stage: "feedback_classify",
    retryable: false,
    side_effect: "none",
    details: {
      kind: "field",
      path: "evd.service_profile",
      rule: "jev_typed_required"
    }
  });
}

function evdRouteError(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CAPABILITY",
    category: "policy",
    message_key: "error.feedback_intent.evd_route_not_feedback",
    stage: "feedback_classify",
    retryable: false,
    side_effect: "none",
    details: {
      kind: "field",
      path: "evd.service_profile.route",
      rule: "evd_route_not_feedback"
    }
  });
}

function driftError(
  expected: PersistedFeedbackBinding,
  actual: PersistedFeedbackBinding
): ErrorEnvelope {
  if (expected.profile_key !== actual.profile_key) {
    return makeErrorEnvelope({
      code: "E_VERSION_BINDING",
      category: "version",
      message_key: "error.version.binding",
      stage: "feedback_classify",
      retryable: false,
      side_effect: "none",
      details: {
        kind: "version",
        expected: expected.profile_key,
        actual: actual.profile_key
      }
    });
  }
  return makeErrorEnvelope({
    code: "E_VERSION_BINDING",
    category: "version",
    message_key: "error.version.binding",
    stage: "feedback_classify",
    retryable: false,
    side_effect: "none",
    details: {
      kind: "field",
      path: "evd.service_profile.body_json",
      rule: "binding_drift"
    }
  });
}

function sameBackend(left: HostFeedbackBackend, right: HostFeedbackBackend): boolean {
  return (
    left.provider === right.provider &&
    left.base_url === right.base_url &&
    left.route === right.route &&
    left.requested_model === right.requested_model &&
    left.credential_ref === right.credential_ref
  );
}

/**
 * Re-reads the single persisted Jev binding through the real `/3` reader. The
 * classifier never caches an endpoint across a persisted selection change.
 */
async function readPersistedFeedbackBinding(
  connection: SqliteConnection,
  binding: EvidenceBindingReadPort
): Promise<PersistedBindingRead> {
  const resolved: Result<ResolvedEvidenceBinding, ErrorEnvelope> =
    await resolveDefaultEvidenceBinding(connection, binding);
  if (!resolved.ok) {
    return {
      status: "unresolved",
      reason: "profile_binding_unresolved",
      detail: "No single usable persisted Jev binding is available.",
      error: { ...resolved.error, stage: "feedback_classify" }
    };
  }
  const value = resolved.value;
  const backend = feedbackBackendFromPersistedProfile(value.service_profile);
  if (value.service_profile.schema_version !== "rsi.jev_service_profile/1" || backend === null) {
    return {
      status: "unresolved",
      reason: "backend_not_jev_typed",
      detail: "The persisted backend is not a complete Jev typed service profile.",
      error: capabilityError()
    };
  }
  if (isEvdDecisionRoute(backend.route)) {
    return {
      status: "unresolved",
      reason: "evd_route_not_feedback",
      detail: "The persisted route is the EVD decision endpoint, not a feedback classifier.",
      error: evdRouteError()
    };
  }
  return {
    status: "ok",
    binding: { profile_key: value.service_profile_key, backend }
  };
}

/**
 * Composition factory for the production W6 classifier.
 *
 * It resolves the same unique persisted Jev profile the bootstrap already
 * composes `composeDefaultJevTransport` from, clock-free and without any
 * implicit credential/model discovery. The returned model re-reads the
 * binding before every `classify`; a missing, ambiguous or changed selection
 * returns the typed error with zero credential resolution and zero HTTP.
 *
 * A `typesafe` profile is accepted only when its route is a dedicated
 * feedback endpoint; the EVD `/api/alpha/decisions` route is rejected because
 * its wire is a judge state envelope, not this protocol.
 */
export async function createPersistedFeedbackIntentModel(
  options: PersistedFeedbackIntentModelOptions
): Promise<HostFeedbackIntentModelResult> {
  const bindingPort = createEvidenceBindingReadPort({
    connection: options.connection,
    blobs: options.blobs
  });
  const initial = await readPersistedFeedbackBinding(options.connection, bindingPort);
  if (initial.status === "unresolved") {
    return {
      status: "blocked",
      reason: initial.reason,
      detail: initial.detail,
      error: initial.error
    };
  }

  const base = createHostFeedbackIntentModel({
    backend: initial.binding.backend,
    transport: options.transport,
    ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
    ...(options.max_input_bytes === undefined ? {} : { max_input_bytes: options.max_input_bytes }),
    ...(options.max_response_bytes === undefined
      ? {}
      : { max_response_bytes: options.max_response_bytes }),
    ...(options.max_output_tokens === undefined
      ? {}
      : { max_output_tokens: options.max_output_tokens })
  });
  if (base.status === "blocked") return base;

  const model: FeedbackIntentModelPort = {
    async classify(request) {
      const current = await readPersistedFeedbackBinding(options.connection, bindingPort);
      if (current.status === "unresolved") return err(current.error);
      if (
        current.binding.profile_key !== initial.binding.profile_key ||
        !sameBackend(current.binding.backend, initial.binding.backend)
      ) {
        return err(driftError(initial.binding, current.binding));
      }
      return base.model.classify(request);
    }
  };

  return { status: "ready", model };
}
