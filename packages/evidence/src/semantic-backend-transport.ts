/**
 * Concrete Jev transport boundary.
 *
 * The domain receives only a persisted opaque credential reference. Resolution
 * is an injected process-local capability and the resolved header is passed
 * directly to the HTTP executor; it is never returned, logged, hashed, or
 * stored in a durable object.
 */

import { adapterContractHash } from "./hashing.js";
import type {
  JevServiceProfile,
  JevTypedAdapterRequest,
  SemanticBackendPort,
  SemanticBackendRequest,
  SemanticBackendTransportOutcome,
  TypedJudgeQuestion
} from "./types.js";

export interface CredentialReferenceResolver {
  resolve(reference: string): Promise<{ authorization_header: string } | null>;
}

export interface SemanticHttpExecutor {
  request(input: {
    url: string;
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    signal: AbortSignal;
  }): Promise<{ status: number; body: Uint8Array }>;
}

interface SemanticBackendTransportOptions {
  readonly profile: JevServiceProfile;
  readonly credentials: CredentialReferenceResolver;
  readonly http: SemanticHttpExecutor;
  readonly now?: () => number;
  /** Maximum response bytes accepted before the transport reports failure. */
  readonly max_response_bytes?: number;
  /** Explicitly authorized hosts; an empty list permits localhost only. */
  readonly allowed_hosts?: readonly string[];
}

function nowOf(options: SemanticBackendTransportOptions): number {
  return options.now?.() ?? Date.now();
}

function endpoint(profile: JevServiceProfile, allowedHosts: readonly string[]): string | null {
  let base: URL;
  try {
    base = new URL(profile.base_url);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  // A base URL carrying userinfo would place the secret in the URL handed to
  // the executor/log layers, so such a profile is never authorized.
  if (base.username !== "" || base.password !== "") return null;
  const host = base.hostname.toLowerCase();
  const allowed = allowedHosts.length > 0 ? allowedHosts.map((value) => value.toLowerCase()) : ["127.0.0.1", "localhost", "::1"];
  if (!allowed.includes(host)) return null;
  if (!profile.route.startsWith("/") || profile.route.startsWith("//")) return null;
  // Backslashes are authority delimiters for special schemes in the WHATWG
  // parser (`/\host/path` resolves to `//host/path`); control characters are
  // stripped before resolution. Neither may reach the route.
  const hasControlCharacter = [...profile.route].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (profile.route.includes("\\") || hasControlCharacter) return null;
  try {
    const resolved = new URL(profile.route, base);
    // Authorize the final URL, not just the base: the resolved origin and
    // credentials must match the origin that passed the allowlist.
    if (resolved.origin !== base.origin) return null;
    if (resolved.username !== "" || resolved.password !== "") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function asJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseBody(bytes: Uint8Array, maxBytes: number): unknown | null {
  if (bytes.byteLength > maxBytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isVersionBinding(value: unknown): boolean {
  const binding = asRecord(value);
  return (
    binding !== null &&
    typeof binding["task_id"] === "string" &&
    typeof binding["branch_id"] === "string" &&
    typeof binding["input_epoch"] === "number" &&
    Number.isSafeInteger(binding["input_epoch"]) &&
    binding["input_epoch"] >= 1 &&
    typeof binding["goal_version"] === "string" &&
    typeof binding["config_version"] === "string" &&
    typeof binding["watermark"] === "number" &&
    Number.isSafeInteger(binding["watermark"]) &&
    binding["watermark"] >= 0
  );
}

function isJudgeState(value: unknown): boolean {
  const state = asRecord(value);
  if (state === null) return false;
  if (state["schema_version"] !== "rsi.judge_state/2") return false;
  const profile = state["profile"];
  if (profile !== "progress_issue" && profile !== "experience_review") return false;
  if (!isVersionBinding(state["binding"])) return false;
  if (asRecord(state["question_scope"]) === null) return false;
  const coverage = asRecord(state["coverage"]);
  if (coverage === null || !Array.isArray(coverage["missing"]) || !Array.isArray(coverage["omitted"])) {
    return false;
  }
  if (!Array.isArray(state["requirements"]) || !Array.isArray(state["evidence"])) return false;
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isTypedJudgeQuestion(value: unknown): value is TypedJudgeQuestion {
  const question = asRecord(value);
  if (question === null || typeof question["instructions"] !== "string") return false;
  const type = question["type"];
  if (type === "noul") {
    const criteria = question["criteria"];
    if (criteria === undefined) return true;
    const record = asRecord(criteria);
    return (
      record !== null &&
      typeof record["true"] === "string" &&
      typeof record["false"] === "string"
    );
  }
  if (type === "choice") {
    const criteria = asRecord(question["criteria"]);
    if (criteria === null) return false;
    return Object.values(criteria).every((entry) => typeof entry === "string");
  }
  if (type === "score") {
    return isStringArray(question["criteria"]);
  }
  return false;
}

function isTypedQuestions(value: unknown): value is Record<string, TypedJudgeQuestion> {
  const questions = asRecord(value);
  if (questions === null) return false;
  const keys = Object.keys(questions);
  if (keys.length === 0) return false;
  return keys.every((key) => key.length > 0 && isTypedJudgeQuestion(questions[key]));
}

/**
 * Validates the frozen `JevTypedAdapterRequest/1` before any credential or
 * network work. The direct provider wire body is derived only from this
 * object; the surrounding internal request never reaches the provider.
 */
function validTypedAdapterRequest(
  request: SemanticBackendRequest,
  profile: JevServiceProfile
): JevTypedAdapterRequest | null {
  const adapter = asRecord(request.adapter_request);
  if (adapter === null) return null;
  if (adapter["schema_version"] !== "rsi.jev_typed_adapter_request/1") return null;
  const backend = asRecord(request.backend);
  if (backend === null || backend["backend_kind"] !== "jev_typed") return null;
  const contractHash = adapterContractHash(backend["backend_kind"]);
  if (contractHash === null || adapter["adapter_contract_hash"] !== contractHash) return null;
  if (adapter["model"] !== profile.requested_model) return null;
  if (!isJudgeState(adapter["state"])) return null;
  if (!isTypedQuestions(adapter["questions"])) return null;
  return adapter as unknown as JevTypedAdapterRequest;
}

function providerBody(adapter: JevTypedAdapterRequest): {
  model: string;
  state: JevTypedAdapterRequest["state"];
  questions: Record<string, TypedJudgeQuestion>;
} {
  return {
    model: adapter.model,
    state: adapter.state,
    questions: adapter.questions
  };
}

/**
 * OpenRouter exposes Anthropic Messages rather than the frozen Jev wire. The
 * translation is deliberately explicit and versioned in this module: the
 * internal adapter request remains unchanged, while the provider sees a
 * bounded Messages request and the gateway receives the frozen judge wire.
 */
const OPENROUTER_JEV_ADAPTER_VERSION =
  "openrouter.anthropic-messages-to-jev/1" as const;

function openRouterPrompt(adapter: JevTypedAdapterRequest): string {
  return [
    `evoplug adapter ${OPENROUTER_JEV_ADAPTER_VERSION}`,
    "Return exactly one JSON object and no Markdown.",
    "The object must contain `answers`, keyed exactly like the supplied questions.",
    'For noul use {"type":"noul","noul": number in [0,1]}.',
    'For choice use {"type":"choice","choice": option,"confidence": number,"probabilities": object with every option key and probabilities summing to 1}.',
    'For score use {"type":"score","score": number,"confidence": number,"probabilities": object with every level key and probabilities summing to 1,"legend": string array}.',
    "Do not add keys inside answers beyond the requested answer fields.",
    "INPUT_JSON_START",
    JSON.stringify({ state: adapter.state, questions: adapter.questions }),
    "INPUT_JSON_END"
  ].join("\n");
}

function openRouterRequestBody(adapter: JevTypedAdapterRequest, maxTokens: number): unknown {
  return {
    model: adapter.model,
    max_tokens: maxTokens,
    system: "You are a bounded semantic judge. Follow the output contract exactly.",
    messages: [{ role: "user", content: openRouterPrompt(adapter) }]
  };
}

function textFromAnthropicResponse(value: unknown): string | null {
  const response = asRecord(value);
  if (response === null || !Array.isArray(response["content"])) return null;
  const chunks: string[] = [];
  for (const entry of response["content"]) {
    const block = asRecord(entry);
    if (block?.["type"] === "text" && typeof block["text"] === "string") {
      chunks.push(block["text"]);
    }
  }
  return chunks.length === 0 ? null : chunks.join("\n");
}

function parseModelJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\\s*([\\s\\S]*?)\\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return asRecord(JSON.parse(candidate) as unknown);
  } catch {
    return null;
  }
}

function openRouterWire(value: unknown): Record<string, unknown> | null {
  const response = asRecord(value);
  if (response === null || typeof response["model"] !== "string") return null;
  const text = textFromAnthropicResponse(value);
  if (text === null) return null;
  const modelOutput = parseModelJson(text);
  const answers = modelOutput?.["answers"];
  if (asRecord(answers) === null) return null;
  const usageRecord = asRecord(response["usage"]);
  const usage: Record<string, unknown> = {};
  if (usageRecord !== null) {
    if (typeof usageRecord["input_tokens"] === "number") usage["input_tokens"] = usageRecord["input_tokens"];
    if (typeof usageRecord["output_tokens"] === "number") usage["output_tokens"] = usageRecord["output_tokens"];
    // OpenRouter's cost unit is provider-specific here; do not infer micros.
    usage["cost_status"] = "unknown";
  }
  return {
    model: response["model"],
    returned_model: response["model"],
    answers,
    usage
  };
}

/** Creates a SemanticBackendPort with bounded, local-authorized HTTP dispatch. */
export function createSemanticBackendTransport(
  options: SemanticBackendTransportOptions
): SemanticBackendPort {
  const maxResponseBytes = options.max_response_bytes ?? 4 * 1024 * 1024;
  const allowedHosts = options.allowed_hosts ?? [];
  const url = endpoint(options.profile, allowedHosts);

  return {
    async invoke(input: { request: SemanticBackendRequest; signal: AbortSignal }): Promise<SemanticBackendTransportOutcome> {
      const receivedAt = (): number => nowOf(options);
      if (url === null) {
        return { status: "transport_error", error_code: "E_ENDPOINT_UNAUTHORIZED", retryable: false, received_at: receivedAt() };
      }
      if (input.signal.aborted) return { status: "cancelled", received_at: receivedAt() };
      if (options.profile.acceptance.status !== "eligible" || !options.profile.production_use) {
        return { status: "transport_error", error_code: "E_SERVICE_PROFILE_BLOCKED", retryable: false, received_at: receivedAt() };
      }
      const adapter = validTypedAdapterRequest(input.request, options.profile);
      if (adapter === null) {
        return { status: "transport_error", error_code: "E_SEMANTIC_CONTRACT_UNSUPPORTED", retryable: false, received_at: receivedAt() };
      }
      let body: Uint8Array;
      try {
        const providerRequest =
          options.profile.provider === "openrouter"
            ? openRouterRequestBody(
                adapter,
                Math.max(1, Math.min(options.profile.limits.question_max_tokens ?? 2048, 4096))
              )
            : providerBody(adapter);
        body = asJsonBytes(providerRequest);
      } catch {
        return { status: "transport_error", error_code: "E_SEMANTIC_CONTRACT_UNSUPPORTED", retryable: false, received_at: receivedAt() };
      }
      let authorization: { authorization_header: string } | null;
      try {
        authorization = await options.credentials.resolve(options.profile.credential_ref);
      } catch {
        authorization = null;
      }
      if (input.signal.aborted) return { status: "cancelled", received_at: receivedAt() };
      if (authorization === null || authorization.authorization_header.length === 0) {
        return { status: "transport_error", error_code: "E_CREDENTIAL_REF_UNAVAILABLE", retryable: false, received_at: receivedAt() };
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), Math.max(1, input.request.deadline_ms));
      try {
        const response = await options.http.request({
          url,
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: authorization.authorization_header
          },
          body,
          signal: controller.signal
        });
        if (input.signal.aborted) return { status: "cancelled", received_at: receivedAt() };
        const parsed = parseBody(response.body, maxResponseBytes);
        if (parsed === null) {
          return { status: "transport_error", error_code: "E_RESPONSE_LIMIT_OR_JSON", retryable: false, received_at: receivedAt() };
        }
        if (options.profile.provider === "openrouter" && response.status >= 200 && response.status < 300) {
          const wire = openRouterWire(parsed);
          if (wire === null) {
            return {
              status: "transport_error",
              error_code: "E_PROVIDER_RESPONSE_SCHEMA",
              retryable: false,
              received_at: receivedAt()
            };
          }
          return { status: "response", http_status: response.status, received_at: receivedAt(), raw_body: wire };
        }
        return { status: "response", http_status: response.status, received_at: receivedAt(), raw_body: parsed };
      } catch (error: unknown) {
        if (input.signal.aborted) return { status: "cancelled", received_at: receivedAt() };
        if (controller.signal.aborted) return { status: "timeout", received_at: receivedAt() };
        const code = error instanceof Error && error.name.length > 0 ? error.name : "E_TRANSPORT";
        return { status: "transport_error", error_code: code, retryable: true, received_at: receivedAt() };
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abort);
      }
    }
  };
}
