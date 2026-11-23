/**
 * `config.json` parsing, validation and version derivation (DD-FND-100).
 *
 * `config_version = "cfgv:" + sha256(JCS(config without product_home))`
 * (`Hash` already carries the `sha256:` prefix). It is an opaque version
 * binding value: no random id and no time input. `config_hash` covers the
 * complete canonical config and is what `config_profile.content_hash` stores.
 */

import { isAbsolute, } from "node:path";
import { type ErrorEnvelope, type Hash, type HostId, type JsonObject, type JsonValue, type Result } from "@evoplug/core";
import { canonicalHash, canonicalJsonText, compareUtf8 } from "@evoplug/core";
import { DEFAULT_DELIVERY_TTL_MS } from "@evoplug/delivery";
import { fieldError } from "./errors.js";
import {
  DEFAULT_DISPATCH_MODE,
  isConfiguredFeatureFlag,
  resolveDispatchMode,
  resolveFeatures,
  type ConfiguredFeatureFlag,
  type DispatchMode,
  type ResolvedFeatures
} from "./features.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is UnknownRecord {
  return sharedIsRecord(value);
}

export { DEFAULT_DELIVERY_TTL_MS };

const CONFIG_SCHEMA_VERSION: "rsi.config/1" = "rsi.config/1";
const CONFIG_VERSION_PREFIX = "cfgv:";
const BUDGET_POLICY_VERSION: "bpol/1" = "bpol/1";
/** Written by `init` while no EgressPolicy exists; replaced by `configure`. */
const UNCONFIGURED_EGRESS_POLICY_VERSION = "egress/none";

const HOST_IDS: readonly HostId[] = [
  "pi",
  "oh-my-pi",
  "step-code",
  "codex",
  "opencode",
  "openhands-sdk",
  "claude-code"
];

type RemoteInferenceConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly endpoint: string;
      readonly model: string;
      readonly secret_ref: string;
      readonly egress_policy_version: string;
    };

export interface ReviewBackendPricing {
  readonly status: "known";
  readonly input_micros_per_million: number;
  readonly output_micros_per_million: number;
  readonly fixed_micros: number;
}

type ReviewBackendConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly backend_id: string;
      readonly secret_ref: string | null;
      /** Optional generation model id; the host CLI keeps its own default. */
      readonly model?: string;
      /**
       * Pricing the operator explicitly asserts for the host CLI's provider.
       * Absent means unknown, and an unknown paid call is blocked at claim.
       */
      readonly pricing?: ReviewBackendPricing;
    };

interface AdapterConfigEntry {
  readonly host_id: HostId;
  readonly config_space: string;
  readonly enabled: boolean;
}

interface JournalConfig {
  readonly max_file_bytes: number;
  readonly blob_retention_days: number;
}

interface ProjectRoot {
  readonly project_id: string;
  readonly root: string;
}

interface ProjectsConfig {
  readonly excluded_project_ids: readonly string[];
  readonly roots: readonly ProjectRoot[];
}

/**
 * Optional W11 product-config blocks.
 *
 * Absence is meaningful: an old home without these keys keeps byte-identical
 * canonical JSON and therefore the same `config_version`. Defaults are applied
 * only by `resolveFeatureConfig`, never by parsing, so a parse never mutates a
 * home.
 */
interface DeliveryConfig {
  /** Wall-clock delivery TTL in milliseconds. */
  readonly ttl_ms: number;
}

interface DispatchConfig {
  /** Explicit opt-in to act on deterministic decisions. */
  readonly short_circuit?: boolean;
  /** Mode refinement for flag-on, `short_circuit` absent. */
  readonly mode?: DispatchMode;
}

interface SupplementConfig {
  readonly max_rounds: number;
}

interface WorkspaceConfig {
  readonly read_max_bytes: number;
}

interface ProbeConfig {
  /** Gate `probe` runtime calls on attach; only effective with `runtime_probe`. */
  readonly on_attach: boolean;
}

interface CandidateConfig {
  /** Appendix Q.6.4: pending confirmation lifetime; default 14 days. */
  readonly pending_ttl_ms: number;
}

interface AutoTuneConfig {
  readonly auto_tune_fields: readonly string[];
}

export interface EvoplugConfig {
  readonly schema_version: "rsi.config/1";
  readonly config_space: string;
  readonly product_home: string;
  readonly budget_policy_version: "bpol/1";
  readonly egress_policy_version: string;
  readonly remote_inference: RemoteInferenceConfig;
  readonly review_backend: ReviewBackendConfig;
  readonly adapters: readonly AdapterConfigEntry[];
  readonly journal: JournalConfig;
  readonly projects: ProjectsConfig;
  /** Explicitly enabled feature flags. Absent means "bootstrap defaults". */
  readonly features?: readonly ConfiguredFeatureFlag[];
  readonly delivery?: DeliveryConfig;
  readonly dispatch?: DispatchConfig;
  readonly supplement?: SupplementConfig;
  readonly workspace?: WorkspaceConfig;
  readonly probe?: ProbeConfig;
  readonly config?: AutoTuneConfig;
  readonly candidate?: CandidateConfig;
}

const TOP_LEVEL_KEYS: readonly string[] = [
  "schema_version",
  "config_space",
  "product_home",
  "budget_policy_version",
  "egress_policy_version",
  "remote_inference",
  "review_backend",
  "adapters",
  "journal",
  "projects",
  "features",
  "delivery",
  "dispatch",
  "supplement",
  "workspace",
  "probe",
  "config",
  "candidate"
];

const MAX_FILE_BYTES_CEILING = 4_294_967_296;
const SECRET_KEY_PATTERN = /(^|_)(secret|token|cookie|password|passwd|api_?key|private_?key|credential)(_|$)/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
];
const CONFIG_SPACE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type UnknownRecord = { readonly [key: string]: unknown };

function isControlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function isSafeIntegerBetween(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function checkExactKeys(record: UnknownRecord, allowed: readonly string[], path: string): ErrorEnvelope | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return fieldError(`${path}.${key}`, "unknown_key");
    }
  }
  return null;
}

function readString(record: UnknownRecord, key: string, path: string): Result<string, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "string") {
    return { ok: false, status: "rejected", error: fieldError(`${path}.${key}`, "must_be_string") };
  }
  if (!isControlFree(value)) {
    return { ok: false, status: "rejected", error: fieldError(`${path}.${key}`, "control_character") };
  }
  return { ok: true, status: "ok", value };
}

function readBoolean(record: UnknownRecord, key: string, path: string): Result<boolean, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "boolean") {
    return { ok: false, status: "rejected", error: fieldError(`${path}.${key}`, "must_be_boolean") };
  }
  return { ok: true, status: "ok", value };
}

function readInteger(
  record: UnknownRecord,
  key: string,
  path: string,
  min: number,
  max: number
): Result<number, ErrorEnvelope> {
  const value = record[key];
  if (typeof value !== "number" || !isSafeIntegerBetween(value, min, max)) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError(`${path}.${key}`, `integer_${String(min)}_${String(max)}`)
    };
  }
  return { ok: true, status: "ok", value };
}

function readStringArray(record: UnknownRecord, key: string, path: string): Result<readonly string[], ErrorEnvelope> {
  const value = record[key];
  if (!Array.isArray(value)) {
    return { ok: false, status: "rejected", error: fieldError(`${path}.${key}`, "must_be_array") };
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== "string" || !isControlFree(item)) {
      return {
        ok: false,
        status: "rejected",
        error: fieldError(`${path}.${key}[${String(index)}]`, "must_be_string")
      };
    }
    out.push(item);
  }
  return { ok: true, status: "ok", value: out };
}

/**
 * Rejects plaintext credentials anywhere in the config tree. `*_ref` keys are
 * pointers into an external keychain, never the secret itself.
 */
export function findPlaintextSecret(value: unknown, path = "$"): string | null {
  if (typeof value === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        return path;
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPlaintextSecret(value[index], `${path}[${String(index)}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key) && !key.endsWith("_ref")) {
        return `${path}.${key}`;
      }
      const found = findPlaintextSecret(item, `${path}.${key}`);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function validateRemoteInference(value: unknown): Result<RemoteInferenceConfig, ErrorEnvelope> {
  const path = "remote_inference";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const enabled = readBoolean(value, "enabled", path);
  if (!enabled.ok) {
    return enabled;
  }
  if (!enabled.value) {
    const unknownKey = checkExactKeys(value, ["enabled"], path);
    if (unknownKey !== null) {
      return { ok: false, status: "rejected", error: unknownKey };
    }
    return { ok: true, status: "ok", value: { enabled: false } };
  }
  const unknownKey = checkExactKeys(value, ["enabled", "endpoint", "model", "secret_ref", "egress_policy_version"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const endpoint = readString(value, "endpoint", path);
  if (!endpoint.ok) return endpoint;
  const model = readString(value, "model", path);
  if (!model.ok) return model;
  const secretRef = readString(value, "secret_ref", path);
  if (!secretRef.ok) return secretRef;
  const policyVersion = readString(value, "egress_policy_version", path);
  if (!policyVersion.ok) return policyVersion;
  if (endpoint.value.length === 0 || model.value.length === 0 || secretRef.value.length === 0) {
    return { ok: false, status: "rejected", error: fieldError(path, "non_empty") };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      enabled: true,
      endpoint: endpoint.value,
      model: model.value,
      secret_ref: secretRef.value,
      egress_policy_version: policyVersion.value
    }
  };
}

function validateReviewBackend(value: unknown): Result<ReviewBackendConfig, ErrorEnvelope> {
  const path = "review_backend";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const enabled = readBoolean(value, "enabled", path);
  if (!enabled.ok) {
    return enabled;
  }
  if (!enabled.value) {
    const unknownKey = checkExactKeys(value, ["enabled"], path);
    if (unknownKey !== null) {
      return { ok: false, status: "rejected", error: unknownKey };
    }
    return { ok: true, status: "ok", value: { enabled: false } };
  }
  const unknownKey = checkExactKeys(value, ["enabled", "backend_id", "secret_ref", "model", "pricing"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const backendId = readString(value, "backend_id", path);
  if (!backendId.ok) return backendId;
  if (backendId.value.length === 0) {
    return { ok: false, status: "rejected", error: fieldError(`${path}.backend_id`, "non_empty") };
  }
  const secretRef = value["secret_ref"];
  if (secretRef !== null && (typeof secretRef !== "string" || !isControlFree(secretRef))) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError(`${path}.secret_ref`, "must_be_string_or_null")
    };
  }
  const model = value["model"];
  if (model !== undefined && (typeof model !== "string" || model.length === 0 || !isControlFree(model))) {
    return {
      ok: false,
      status: "rejected",
      error: fieldError(`${path}.model`, "non_empty_string")
    };
  }
  let pricing: ReviewBackendPricing | undefined;
  if (value["pricing"] !== undefined) {
    if (!isRecord(value["pricing"])) {
      return { ok: false, status: "rejected", error: fieldError(`${path}.pricing`, "must_be_object") };
    }
    const pricingValue = value["pricing"];
    const unknownPricingKey = checkExactKeys(
      pricingValue,
      ["status", "input_micros_per_million", "output_micros_per_million", "fixed_micros"],
      `${path}.pricing`
    );
    if (unknownPricingKey !== null) {
      return { ok: false, status: "rejected", error: unknownPricingKey };
    }
    if (pricingValue["status"] !== "known") {
      return { ok: false, status: "rejected", error: fieldError(`${path}.pricing.status`, "known") };
    }
    const input = pricingValue["input_micros_per_million"];
    const output = pricingValue["output_micros_per_million"];
    const fixed = pricingValue["fixed_micros"];
    if (
      !Number.isSafeInteger(input) || Number(input) < 0 ||
      !Number.isSafeInteger(output) || Number(output) < 0 ||
      !Number.isSafeInteger(fixed) || Number(fixed) < 0
    ) {
      return {
        ok: false,
        status: "rejected",
        error: fieldError(`${path}.pricing`, "non_negative_safe_integer")
      };
    }
    pricing = {
      status: "known",
      input_micros_per_million: Number(input),
      output_micros_per_million: Number(output),
      fixed_micros: Number(fixed)
    };
  }
  return {
    ok: true,
    status: "ok",
    value: {
      enabled: true,
      backend_id: backendId.value,
      secret_ref: secretRef,
      ...(model === undefined ? {} : { model }),
      ...(pricing === undefined ? {} : { pricing })
    }
  };
}

function validateAdapters(value: unknown): Result<readonly AdapterConfigEntry[], ErrorEnvelope> {
  const path = "adapters";
  if (!Array.isArray(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_array") };
  }
  const out: AdapterConfigEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const entryPath = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      return { ok: false, status: "rejected", error: fieldError(entryPath, "must_be_object") };
    }
    const unknownKey = checkExactKeys(entry, ["host_id", "config_space", "enabled"], entryPath);
    if (unknownKey !== null) {
      return { ok: false, status: "rejected", error: unknownKey };
    }
    const hostId = readString(entry, "host_id", entryPath);
    if (!hostId.ok) return hostId;
    if (!HOST_IDS.includes(hostId.value as HostId)) {
      return { ok: false, status: "rejected", error: fieldError(`${entryPath}.host_id`, "unknown_enum") };
    }
    const configSpace = readString(entry, "config_space", entryPath);
    if (!configSpace.ok) return configSpace;
    if (!CONFIG_SPACE_PATTERN.test(configSpace.value)) {
      return { ok: false, status: "rejected", error: fieldError(`${entryPath}.config_space`, "pattern") };
    }
    const enabled = readBoolean(entry, "enabled", entryPath);
    if (!enabled.ok) return enabled;
    if (seen.has(hostId.value)) {
      return { ok: false, status: "rejected", error: fieldError(`${entryPath}.host_id`, "duplicate_host") };
    }
    seen.add(hostId.value);
    out.push({ host_id: hostId.value as HostId, config_space: configSpace.value, enabled: enabled.value });
  }
  return { ok: true, status: "ok", value: out };
}

function validateJournal(value: unknown): Result<JournalConfig, ErrorEnvelope> {
  const path = "journal";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["max_file_bytes", "blob_retention_days"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const maxFileBytes = readInteger(value, "max_file_bytes", path, 1, MAX_FILE_BYTES_CEILING);
  if (!maxFileBytes.ok) return maxFileBytes;
  const retentionDays = readInteger(value, "blob_retention_days", path, 0, 36_500);
  if (!retentionDays.ok) return retentionDays;
  return {
    ok: true,
    status: "ok",
    value: { max_file_bytes: maxFileBytes.value, blob_retention_days: retentionDays.value }
  };
}

function validateProjectRoots(value: unknown): Result<readonly ProjectRoot[], ErrorEnvelope> {
  const path = "projects.roots";
  if (!Array.isArray(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_array") };
  }
  const out: ProjectRoot[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const entryPath = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      return { ok: false, status: "rejected", error: fieldError(entryPath, "must_be_object") };
    }
    const unknownKey = checkExactKeys(entry, ["project_id", "root"], entryPath);
    if (unknownKey !== null) {
      return { ok: false, status: "rejected", error: unknownKey };
    }
    const projectId = readString(entry, "project_id", entryPath);
    if (!projectId.ok) return projectId;
    if (!PROJECT_ID_PATTERN.test(projectId.value)) {
      return { ok: false, status: "rejected", error: fieldError(`${entryPath}.project_id`, "pattern") };
    }
    const root = readString(entry, "root", entryPath);
    if (!root.ok) return root;
    if (!isAbsolute(root.value)) {
      return { ok: false, status: "rejected", error: fieldError(`${entryPath}.root`, "must_be_absolute") };
    }
    if (root.value.split(/[\\/]/).includes("..")) {
      return { ok: false, status: "rejected", error: fieldError(`${entryPath}.root`, "dotdot_segment") };
    }
    if (seen.has(projectId.value)) {
      return { ok: false, status: "rejected", error: fieldError(`${entryPath}.project_id`, "duplicate_project") };
    }
    seen.add(projectId.value);
    out.push({ project_id: projectId.value, root: root.value });
  }
  return { ok: true, status: "ok", value: out };
}

function validateProjects(value: unknown): Result<ProjectsConfig, ErrorEnvelope> {
  const path = "projects";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["excluded_project_ids", "roots"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const excluded = readStringArray(value, "excluded_project_ids", path);
  if (!excluded.ok) return excluded;
  const roots = validateProjectRoots(value["roots"]);
  if (!roots.ok) return roots;
  const excludedSorted = [...excluded.value].sort(compareUtf8);
  for (let index = 1; index < excludedSorted.length; index += 1) {
    if (excludedSorted[index - 1] === excludedSorted[index]) {
      return {
        ok: false,
        status: "rejected",
        error: fieldError(`${path}.excluded_project_ids`, "duplicate")
      };
    }
  }
  return {
    ok: true,
    status: "ok",
    value: { excluded_project_ids: excluded.value, roots: roots.value }
  };
}

/**
 * Validates the optional `features` block.
 *
 * Order is preserved so the canonical body is exactly what the operator wrote.
 * Duplicates and unknown names are rejected. Retired pre-W11 names are kept in
 * the parsed list (so an untouched home keeps its canonical bytes and
 * `config_version`) but resolution ignores them.
 */
function validateFeatures(value: unknown): Result<readonly ConfiguredFeatureFlag[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return { ok: false, status: "rejected", error: fieldError("features", "must_be_array") };
  }
  const out: ConfiguredFeatureFlag[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    const path = `features[${String(index)}]`;
    if (typeof item !== "string") {
      return { ok: false, status: "rejected", error: fieldError(path, "must_be_string") };
    }
    if (!isConfiguredFeatureFlag(item)) {
      return { ok: false, status: "rejected", error: fieldError(path, "unknown_enum") };
    }
    if (seen.has(item)) {
      return { ok: false, status: "rejected", error: fieldError(path, "duplicate") };
    }
    seen.add(item);
    out.push(item);
  }
  return { ok: true, status: "ok", value: out };
}

function validateDelivery(value: unknown): Result<DeliveryConfig, ErrorEnvelope> {
  const path = "delivery";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["ttl_ms"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const ttlMs = readInteger(value, "ttl_ms", path, 1, Number.MAX_SAFE_INTEGER);
  if (!ttlMs.ok) return ttlMs;
  return { ok: true, status: "ok", value: { ttl_ms: ttlMs.value } };
}

function validateDispatch(value: unknown): Result<DispatchConfig, ErrorEnvelope> {
  const path = "dispatch";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["short_circuit", "mode"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const out: { short_circuit?: boolean; mode?: DispatchMode } = {};
  if (value["short_circuit"] !== undefined) {
    const shortCircuit = readBoolean(value, "short_circuit", path);
    if (!shortCircuit.ok) return shortCircuit;
    out.short_circuit = shortCircuit.value;
  }
  if (value["mode"] !== undefined) {
    const mode = value["mode"];
    if (mode !== "off" && mode !== "shadow" && mode !== "enforce") {
      return { ok: false, status: "rejected", error: fieldError(`${path}.mode`, "unknown_enum") };
    }
    out.mode = mode;
  }
  return { ok: true, status: "ok", value: out };
}

function validateSupplement(value: unknown): Result<SupplementConfig, ErrorEnvelope> {
  const path = "supplement";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["max_rounds"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const maxRounds = readInteger(value, "max_rounds", path, 0, 100);
  if (!maxRounds.ok) return maxRounds;
  return { ok: true, status: "ok", value: { max_rounds: maxRounds.value } };
}

function validateWorkspace(value: unknown): Result<WorkspaceConfig, ErrorEnvelope> {
  const path = "workspace";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["read_max_bytes"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const maxBytes = readInteger(value, "read_max_bytes", path, 1, 67_108_864);
  if (!maxBytes.ok) return maxBytes;
  return { ok: true, status: "ok", value: { read_max_bytes: maxBytes.value } };
}

function validateProbe(value: unknown): Result<ProbeConfig, ErrorEnvelope> {
  const path = "probe";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["on_attach"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const onAttach = readBoolean(value, "on_attach", path);
  if (!onAttach.ok) return onAttach;
  return { ok: true, status: "ok", value: { on_attach: onAttach.value } };
}

function validateCandidate(value: unknown): Result<CandidateConfig, ErrorEnvelope> {
  const path = "candidate";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["pending_ttl_ms"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const ttl = readInteger(value, "pending_ttl_ms", path, 3_600_000, 90 * 24 * 60 * 60 * 1_000);
  if (!ttl.ok) return ttl;
  return { ok: true, status: "ok", value: { pending_ttl_ms: ttl.value } };
}

function validateAutoTune(value: unknown): Result<AutoTuneConfig, ErrorEnvelope> {
  const path = "config";
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError(path, "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, ["auto_tune_fields"], path);
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const fields = readStringArray(value, "auto_tune_fields", path);
  if (!fields.ok) return fields;
  const seen = new Set<string>();
  for (const field of fields.value) {
    if (field.length === 0) {
      return { ok: false, status: "rejected", error: fieldError(`${path}.auto_tune_fields`, "non_empty") };
    }
    if (seen.has(field)) {
      return { ok: false, status: "rejected", error: fieldError(`${path}.auto_tune_fields`, "duplicate") };
    }
    seen.add(field);
  }
  return { ok: true, status: "ok", value: { auto_tune_fields: fields.value } };
}

/**
 * Validates an unknown JSON value against `EvoplugConfig` (DD-FND-100).
 *
 * Unknown fields, unknown enums, relative or `..` project roots and plaintext
 * secrets are rejected outright; nothing is ignored "per implementation".
 */
export function validateEvoplugConfig(value: unknown): Result<EvoplugConfig, ErrorEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, status: "rejected", error: fieldError("$", "must_be_object") };
  }
  const unknownKey = checkExactKeys(value, TOP_LEVEL_KEYS, "$");
  if (unknownKey !== null) {
    return { ok: false, status: "rejected", error: unknownKey };
  }
  const secretPath = findPlaintextSecret(value);
  if (secretPath !== null) {
    return { ok: false, status: "rejected", error: fieldError(secretPath, "plaintext_secret") };
  }

  const schemaVersion = readString(value, "schema_version", "$");
  if (!schemaVersion.ok) return schemaVersion;
  if (schemaVersion.value !== CONFIG_SCHEMA_VERSION) {
    return { ok: false, status: "rejected", error: fieldError("$.schema_version", "unsupported_version") };
  }
  const configSpace = readString(value, "config_space", "$");
  if (!configSpace.ok) return configSpace;
  if (!CONFIG_SPACE_PATTERN.test(configSpace.value)) {
    return { ok: false, status: "rejected", error: fieldError("$.config_space", "pattern") };
  }
  const productHome = readString(value, "product_home", "$");
  if (!productHome.ok) return productHome;
  if (!isAbsolute(productHome.value)) {
    return { ok: false, status: "rejected", error: fieldError("$.product_home", "must_be_absolute") };
  }
  const budgetPolicyVersion = readString(value, "budget_policy_version", "$");
  if (!budgetPolicyVersion.ok) return budgetPolicyVersion;
  if (budgetPolicyVersion.value !== BUDGET_POLICY_VERSION) {
    return { ok: false, status: "rejected", error: fieldError("$.budget_policy_version", "unsupported_version") };
  }
  const egressPolicyVersion = readString(value, "egress_policy_version", "$");
  if (!egressPolicyVersion.ok) return egressPolicyVersion;
  if (egressPolicyVersion.value.length === 0) {
    return { ok: false, status: "rejected", error: fieldError("$.egress_policy_version", "non_empty") };
  }
  const remoteInference = validateRemoteInference(value["remote_inference"]);
  if (!remoteInference.ok) return remoteInference;
  const reviewBackend = validateReviewBackend(value["review_backend"]);
  if (!reviewBackend.ok) return reviewBackend;
  const adapters = validateAdapters(value["adapters"]);
  if (!adapters.ok) return adapters;
  const journal = validateJournal(value["journal"]);
  if (!journal.ok) return journal;
  const projects = validateProjects(value["projects"]);
  if (!projects.ok) return projects;

  // Optional W11 blocks are validated only when present. A missing block is
  // not filled in: doing so would change an old home's canonical bytes.
  let features: readonly ConfiguredFeatureFlag[] | undefined;
  if (value["features"] !== undefined) {
    const parsed = validateFeatures(value["features"]);
    if (!parsed.ok) return parsed;
    features = parsed.value;
  }
  let delivery: DeliveryConfig | undefined;
  if (value["delivery"] !== undefined) {
    const parsed = validateDelivery(value["delivery"]);
    if (!parsed.ok) return parsed;
    delivery = parsed.value;
  }
  let dispatch: DispatchConfig | undefined;
  if (value["dispatch"] !== undefined) {
    const parsed = validateDispatch(value["dispatch"]);
    if (!parsed.ok) return parsed;
    dispatch = parsed.value;
  }
  let supplement: SupplementConfig | undefined;
  if (value["supplement"] !== undefined) {
    const parsed = validateSupplement(value["supplement"]);
    if (!parsed.ok) return parsed;
    supplement = parsed.value;
  }
  let workspace: WorkspaceConfig | undefined;
  if (value["workspace"] !== undefined) {
    const parsed = validateWorkspace(value["workspace"]);
    if (!parsed.ok) return parsed;
    workspace = parsed.value;
  }
  let probe: ProbeConfig | undefined;
  if (value["probe"] !== undefined) {
    const parsed = validateProbe(value["probe"]);
    if (!parsed.ok) return parsed;
    probe = parsed.value;
  }
  let candidate: CandidateConfig | undefined;
  if (value["candidate"] !== undefined) {
    const parsed = validateCandidate(value["candidate"]);
    if (!parsed.ok) return parsed;
    candidate = parsed.value;
  }
  let autoTune: AutoTuneConfig | undefined;
  if (value["config"] !== undefined) {
    const parsed = validateAutoTune(value["config"]);
    if (!parsed.ok) return parsed;
    autoTune = parsed.value;
  }

  return {
    ok: true,
    status: "ok",
    value: {
      schema_version: CONFIG_SCHEMA_VERSION,
      config_space: configSpace.value,
      product_home: productHome.value,
      budget_policy_version: BUDGET_POLICY_VERSION,
      egress_policy_version: egressPolicyVersion.value,
      remote_inference: remoteInference.value,
      review_backend: reviewBackend.value,
      adapters: adapters.value,
      journal: journal.value,
      projects: projects.value,
      ...(features === undefined ? {} : { features }),
      ...(delivery === undefined ? {} : { delivery }),
      ...(dispatch === undefined ? {} : { dispatch }),
      ...(supplement === undefined ? {} : { supplement }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(probe === undefined ? {} : { probe }),
      ...(autoTune === undefined ? {} : { config: autoTune }),
      ...(candidate === undefined ? {} : { candidate })
    }
  };
}

/** Parses `config.json` text; JSON syntax errors map to `E_SCHEMA`. */
export function parseConfigText(text: string): Result<EvoplugConfig, ErrorEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: "rejected", error: fieldError("$", "invalid_json") };
  }
  return validateEvoplugConfig(parsed);
}

function remoteInferenceJson(value: RemoteInferenceConfig): JsonValue {
  if (!value.enabled) {
    return { enabled: false };
  }
  return {
    enabled: true,
    endpoint: value.endpoint,
    model: value.model,
    secret_ref: value.secret_ref,
    egress_policy_version: value.egress_policy_version
  };
}

function reviewBackendJson(value: ReviewBackendConfig): JsonValue {
  if (!value.enabled) {
    return { enabled: false };
  }
  return {
    enabled: true,
    backend_id: value.backend_id,
    secret_ref: value.secret_ref,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.pricing === undefined
      ? {}
      : {
          pricing: {
            status: value.pricing.status,
            input_micros_per_million: value.pricing.input_micros_per_million,
            output_micros_per_million: value.pricing.output_micros_per_million,
            fixed_micros: value.pricing.fixed_micros
          }
        })
  };
}

/**
 * Canonical body of `config_version`: everything except `product_home`.
 * Budget and egress policy versions are ordinary fields here, so they are
 * covered exactly once.
 */
export function configVersionBody(config: EvoplugConfig): JsonObject {
  return {
    schema_version: config.schema_version,
    config_space: config.config_space,
    budget_policy_version: config.budget_policy_version,
    egress_policy_version: config.egress_policy_version,
    remote_inference: remoteInferenceJson(config.remote_inference),
    review_backend: reviewBackendJson(config.review_backend),
    adapters: config.adapters.map((entry): JsonValue => ({
      host_id: entry.host_id,
      config_space: entry.config_space,
      enabled: entry.enabled
    })),
    journal: {
      max_file_bytes: config.journal.max_file_bytes,
      blob_retention_days: config.journal.blob_retention_days
    },
    projects: {
      excluded_project_ids: [...config.projects.excluded_project_ids],
      roots: config.projects.roots.map((entry): JsonValue => ({
        project_id: entry.project_id,
        root: entry.root
      }))
    },
    // Optional blocks enter the canonical body only when the home explicitly
    // contains them. This is what keeps pre-W11 homes byte-identical.
    ...(config.features === undefined ? {} : { features: [...config.features] }),
    ...(config.delivery === undefined ? {} : { delivery: { ttl_ms: config.delivery.ttl_ms } }),
    ...(config.dispatch === undefined
      ? {}
      : {
          dispatch: {
            ...(config.dispatch.short_circuit === undefined
              ? {}
              : { short_circuit: config.dispatch.short_circuit }),
            ...(config.dispatch.mode === undefined ? {} : { mode: config.dispatch.mode })
          }
        }),
    ...(config.supplement === undefined ? {} : { supplement: { max_rounds: config.supplement.max_rounds } }),
    ...(config.workspace === undefined ? {} : { workspace: { read_max_bytes: config.workspace.read_max_bytes } }),
    ...(config.probe === undefined ? {} : { probe: { on_attach: config.probe.on_attach } }),
    ...(config.config === undefined
      ? {}
      : { config: { auto_tune_fields: [...config.config.auto_tune_fields] } }),
    ...(config.candidate === undefined
      ? {}
      : { candidate: { pending_ttl_ms: config.candidate.pending_ttl_ms } })
  };
}

/** Complete canonical body, `product_home` included. */
function configContentBody(config: EvoplugConfig): JsonObject {
  return {
    ...configVersionBody(config),
    product_home: config.product_home
  };
}

/** `cfgv:sha256:<64 lowercase hex>`. Stable for equal canonical config. */
export function computeConfigVersion(config: EvoplugConfig): string {
  return `${CONFIG_VERSION_PREFIX}${canonicalHash(configVersionBody(config))}`;
}

/** `sha256(JCS(config))`, the value stored as `config_profile.content_hash`. */
export function computeConfigContentHash(config: EvoplugConfig): Hash {
  return canonicalHash(configContentBody(config));
}

/** The bytes written to `config.json`; `canonical_json` must equal them. */
export function canonicalConfigJson(config: EvoplugConfig): string {
  return canonicalJsonText(configContentBody(config));
}

export function isConfigVersion(value: string): boolean {
  return /^cfgv:sha256:[0-9a-f]{64}$/.test(value);
}

interface DefaultConfigInput {
  readonly config_space: string;
  readonly product_home: string;
  readonly egress_policy_version?: string;
}

/**
 * Initial config: local archive on, remote inference off, review backend off,
 * no attached adapters, no projects (DD-FND-100).
 *
 * `delivery.ttl_ms` is written explicitly because a fresh home may enable the
 * W11 `delivery_ttl` flag; the flag still decides whether the TTL is used.
 * Old homes never gain this block during parsing.
 */
export function createDefaultConfig(input: DefaultConfigInput): EvoplugConfig {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    config_space: input.config_space,
    product_home: input.product_home,
    budget_policy_version: BUDGET_POLICY_VERSION,
    egress_policy_version: input.egress_policy_version ?? UNCONFIGURED_EGRESS_POLICY_VERSION,
    remote_inference: { enabled: false },
    review_backend: { enabled: false },
    adapters: [],
    journal: { max_file_bytes: 268_435_456, blob_retention_days: 30 },
    projects: { excluded_project_ids: [], roots: [] },
    delivery: { ttl_ms: DEFAULT_DELIVERY_TTL_MS }
  };
}

/* ------------------------------------------------------------------ */
/* Resolved W11 feature configuration                                   */
/* ------------------------------------------------------------------ */

interface ResolvedDeliveryConfig {
  readonly ttl_ms: number;
  /** Whether the home explicitly contains `delivery`. */
  readonly configured: boolean;
}

interface ResolvedDispatchConfig {
  readonly short_circuit: boolean;
  readonly mode: DispatchMode;
  /** Whether the home explicitly contains `dispatch`. */
  readonly configured: boolean;
  /** Flag-gated effective mode (`off` when the flag is not enabled). */
  readonly effective_mode: DispatchMode;
}

interface ResolvedFeatureConfig {
  readonly features: ResolvedFeatures;
  readonly delivery: ResolvedDeliveryConfig;
  readonly dispatch: ResolvedDispatchConfig;
  readonly supplement: { readonly max_rounds: number };
  readonly workspace: { readonly read_max_bytes: number };
  readonly probe: { readonly on_attach: boolean };
  readonly config: { readonly auto_tune_fields: readonly string[] };
}

const DEFAULT_SUPPLEMENT_MAX_ROUNDS = 3;
const DEFAULT_WORKSPACE_READ_MAX_BYTES = 1_048_576;
const DEFAULT_PROBE_ON_ATTACH = true;

/**
 * Applies W11 defaults without mutating the parsed config.
 *
 * Feature flags come only from `config.features`; bootstrap-level defaults are
 * applied by the bootstrap itself before resolving. `probe.on_attach=true` is
 * inert unless `runtime_probe` is enabled too.
 */
export function resolveFeatureConfig(config: EvoplugConfig): ResolvedFeatureConfig {
  const features = resolveFeatures(config.features ?? []);
  const shortCircuit = config.dispatch?.short_circuit ?? false;
  const mode = config.dispatch?.mode ?? DEFAULT_DISPATCH_MODE;
  return {
    features,
    delivery: {
      ttl_ms: config.delivery?.ttl_ms ?? DEFAULT_DELIVERY_TTL_MS,
      configured: config.delivery !== undefined
    },
    dispatch: {
      short_circuit: shortCircuit,
      mode,
      configured: config.dispatch !== undefined,
      effective_mode: resolveDispatchMode(features, config.dispatch)
    },
    supplement: { max_rounds: config.supplement?.max_rounds ?? DEFAULT_SUPPLEMENT_MAX_ROUNDS },
    workspace: { read_max_bytes: config.workspace?.read_max_bytes ?? DEFAULT_WORKSPACE_READ_MAX_BYTES },
    probe: { on_attach: config.probe?.on_attach ?? DEFAULT_PROBE_ON_ATTACH },
    config: { auto_tune_fields: config.config?.auto_tune_fields ?? [] }
  };
}
