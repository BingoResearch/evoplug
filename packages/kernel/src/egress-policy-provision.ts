/**
 * Standing same-source egress policy written by `evolve configure generation`
 * (Appendix D.1).
 *
 * The generation backend is the reviewed host's own CLI, using the provider
 * the host session already uses. No snapshot bytes are sent to a new receiver,
 * so the user's act of configuring generation is the consent for that route.
 * The policy still goes through the normal `EgressPolicy` parser and is stored
 * as the active `egress_policy` record, so `egress.evaluate` and the review
 * eligibility port read the same object.
 *
 * A policy is bound to one host. Evidence produced by another host is a
 * cross-source route and is denied by the review egress port, not silently
 * widened here.
 */

import { canonicalHash, canonicalJsonText, err, makeErrorEnvelope, ok, toJsonValue } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { computeEgressPolicyHash, normalizeEgressHost, parseEgressPolicy } from "@evoplug/egress";
import type { EgressPolicy } from "@evoplug/egress";
import { POLICY_STORE, policyRepository } from "@evoplug/storage";
import type { SqliteConnection } from "@evoplug/storage";

import type { StandingEgressReceiver } from "./review-egress.js";

export interface StandingEgressPolicyInput {
  readonly host_id: string;
  /** Absolute https base URL of the host's configured provider. */
  readonly provider_endpoint: string;
  readonly provider_model?: string | null;
  readonly project_exclusions?: readonly string[];
  readonly max_source_refs?: number;
  readonly max_request_bytes?: number;
}

export interface StandingEgressPolicy {
  readonly policy: EgressPolicy;
  readonly receiver: StandingEgressReceiver;
  readonly canonical_json: string;
  readonly policy_hash: Hash;
}

function policyError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "configure_generation",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function parseProviderEndpoint(
  value: string
): Result<{ host: string; port: number; path_prefix: string; transport: "https" | "loopback" }, ErrorEnvelope> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(policyError("--provider-endpoint", "absolute_https_url"));
  }
  // Appendix N.3: a local receiver cannot leave the machine, so plain http is
  // accepted for loopback addresses and recorded as transport `loopback`.
  // Every other address still requires https.
  const loopback = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    return err(policyError("--provider-endpoint", "https"));
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return err(policyError("--provider-endpoint", "no_userinfo_query_fragment"));
  }
  // The shared host normaliser rejects loopback and private addresses by
  // design; a loopback receiver never reaches the egress evaluator, so keep
  // its literal host for the audit record.
  const host = loopback
    ? ok(url.hostname.toLowerCase())
    : normalizeEgressHost(url.hostname);
  if (!host.ok) return err(host.error);
  const defaultPort = loopback ? 80 : 443;
  const port = url.port === "" ? defaultPort : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return err(policyError("--provider-endpoint", "port"));
  }
  const path = url.pathname === "" ? "/" : url.pathname;
  return ok({
    host: host.value,
    port,
    path_prefix: path,
    transport: loopback ? "loopback" : "https"
  });
}

/**
 * Builds the standing policy for one host CLI.
 *
 * `models` is the concrete configured model when known; otherwise the CLI's
 * own inherited default is represented by the stable `cli-inherited` label
 * (never a wildcard, so the rule still names a single receiver contract).
 */
export function buildStandingHostEgressPolicy(
  input: StandingEgressPolicyInput
): Result<StandingEgressPolicy, ErrorEnvelope> {
  if (input.host_id.length === 0) {
    return err(policyError("--host", "non_empty"));
  }
  const endpoint = parseProviderEndpoint(input.provider_endpoint);
  if (!endpoint.ok) return err(endpoint.error);
  const model = input.provider_model ?? "cli-inherited";
  // Appendix N.3: loopback is part of the policy identity so a local receiver
  // never shares a version with a public one.
  const transport = endpoint.value.transport;
  const fingerprint = canonicalHash(
    toJsonValue({
      schema_version: "rsi.egress_standing_receiver/1",
      host_id: input.host_id,
      provider_transport: transport,
      provider_host: endpoint.value.host,
      provider_port: endpoint.value.port,
      provider_path: endpoint.value.path_prefix,
      provider_model: model
    })
  ).slice("sha256:".length, "sha256:".length + 12);
  const policyValue: EgressPolicy = {
    schema_version: "rsi.egress_policy/1",
    policy_version: `egress/standing/${transport === "loopback" ? "loopback/" : ""}${input.host_id}/${fingerprint}`,
    default_decision: "deny",
    // Loopback traffic does not cross the egress boundary; recording an
    // https endpoint for it would be false and the schema only admits https.
    endpoints:
      transport === "loopback"
        ? []
        : [
            {
              scheme: "https",
              host: endpoint.value.host,
              port: endpoint.value.port,
              path_prefix: endpoint.value.path_prefix,
              models: [model],
              data_classes: ["public", "user_text", "source_code", "tool_output"],
              max_request_bytes: input.max_request_bytes ?? 16_777_216
            }
          ],
    project_exclusions: [...(input.project_exclusions ?? [])],
    max_source_refs: input.max_source_refs ?? 256,
    permission_for_replay: "deny"
  };
  const parsed = parseEgressPolicy(toJsonValue(policyValue));
  if (!parsed.ok) return err(parsed.error);
  const canonical = canonicalJsonText(toJsonValue(parsed.value));
  return ok({
    policy: parsed.value,
    receiver: {
      kind: "host_cli",
      host_id: input.host_id,
      provider_host: endpoint.value.host,
      provider_model: input.provider_model ?? null,
      provider_transport: transport
    },
    canonical_json: canonical,
    policy_hash: computeEgressPolicyHash(parsed.value)
  });
}

/**
 * Activates one standing policy. Older active rows become inactive in the
 * same call so the store keeps exactly one active row per kind.
 */
export function activateStandingEgressPolicy(
  connection: SqliteConnection,
  value: StandingEgressPolicy,
  now: number
): Result<void, ErrorEnvelope> {
  const repository = policyRepository(connection);
  const listed = repository.listByKind(POLICY_STORE, "egress_policy");
  if (!listed.ok) return err(listed.error);
  for (const row of listed.value) {
    const body = row.body as unknown as Record<string, unknown>;
    if (body["active"] !== 1) continue;
    if (body["policy_version"] === value.policy.policy_version) continue;
    const updated = repository.updateBody({
      store: POLICY_STORE,
      kind: "egress_policy",
      key: String(body["policy_version"]),
      content_hash: body["policy_hash"] as Hash | null,
      created_at: typeof body["created_at"] === "number" ? body["created_at"] : now,
      body: { ...body, active: 0 }
    });
    if (!updated.ok) return err(updated.error);
  }
  const body = {
    policy_version: value.policy.policy_version,
    canonical_json: value.canonical_json,
    policy_hash: value.policy_hash,
    receiver: value.receiver,
    active: 1,
    created_at: now
  };
  const existing = repository.get({
    store: POLICY_STORE,
    kind: "egress_policy",
    key: value.policy.policy_version
  });
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) {
    const updated = repository.updateBody({
      store: POLICY_STORE,
      kind: "egress_policy",
      key: value.policy.policy_version,
      content_hash: value.policy_hash,
      created_at: now,
      body
    });
    return updated.ok ? ok(undefined) : err(updated.error);
  }
  const put = repository.put({
    store: POLICY_STORE,
    kind: "egress_policy",
    key: value.policy.policy_version,
    content_hash: value.policy_hash,
    created_at: now,
    body
  });
  return put.ok ? ok(undefined) : err(put.error);
}

/**
 * Resolves and builds the standing policy for `configure generation`.
 *
 * The explicit `--provider-endpoint` wins. Otherwise the host CLI's own
 * `models.json` supplies the provider base URL (Pi and oh-my-pi); a host whose
 * provider cannot be read must pass the flag instead of guessing a receiver.
 */
export function resolveGenerationEgressPolicy(input: {
  readonly host_id: string;
  readonly model: string | null;
  readonly provider_endpoint: string | null;
  readonly project_exclusions: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly read_file: (path: string) => string | null;
}): Result<StandingEgressPolicy, ErrorEnvelope> {
  let endpoint = input.provider_endpoint;
  let model = input.model;
  if (endpoint === null) {
    const inferred = inferProviderEndpoint({
      host_id: input.host_id,
      model: input.model,
      env: input.env,
      readFile: input.read_file
    });
    if (inferred === null) {
      return err(policyError("--provider-endpoint", "provider_endpoint_required"));
    }
    endpoint = inferred.endpoint;
    model = model ?? inferred.model;
  }
  return buildStandingHostEgressPolicy({
    host_id: input.host_id,
    provider_endpoint: endpoint,
    provider_model: model,
    project_exclusions: input.project_exclusions
  });
}

/**
 * Resolves the provider base URL for hosts whose CLI config is readable in
 * the current process. Pi and oh-my-pi store providers in `models.json`;
 * the selected models file is read only to find the base URL, never to copy a
 * credential.
 */
export function inferProviderEndpoint(input: {
  readonly host_id: string;
  readonly model: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (path: string) => string | null;
}): { endpoint: string; model: string | null } | null {
  if (input.host_id !== "pi" && input.host_id !== "oh-my-pi") return null;
  const agentDir =
    input.host_id === "pi"
      ? input.env["PI_CODING_AGENT_DIR"] ?? joinHome(input.env["HOME"], ".pi/agent")
      : input.env["PI_CODING_AGENT_DIR"] ?? joinHome(input.env["HOME"], ".omp/agent");
  if (agentDir === null) return null;
  const text = input.readFile(`${agentDir}/models.json`);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const providers = (parsed as Record<string, unknown>)["providers"];
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return null;
  const candidates: Array<{ baseUrl: string; models: string[] }> = [];
  for (const value of Object.values(providers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const baseUrl = record["baseUrl"];
    if (typeof baseUrl !== "string" || baseUrl.length === 0) continue;
    const models = Array.isArray(record["models"])
      ? record["models"]
          .map((model) =>
            typeof model === "object" && model !== null && typeof (model as Record<string, unknown>)["id"] === "string"
              ? String((model as Record<string, unknown>)["id"])
              : null
          )
          .filter((id): id is string => id !== null)
      : [];
    candidates.push({ baseUrl, models });
  }
  if (candidates.length === 0) return null;
  // Without an explicit model the host CLI falls back to its own default
  // provider; `models.json` preserves the user's provider order, so the first
  // entry is the closest observable stand-in for that default.
  const selected =
    input.model === null
      ? candidates[0]
      : candidates.find((candidate) => candidate.models.includes(input.model as string));
  if (selected === undefined) return null;
  return { endpoint: selected.baseUrl, model: input.model ?? (selected.models[0] ?? null) };
}

function joinHome(home: string | undefined, suffix: string): string | null {
  if (home === undefined || home.length === 0) return null;
  return `${home.replace(/\/+$/u, "")}/${suffix}`;
}
