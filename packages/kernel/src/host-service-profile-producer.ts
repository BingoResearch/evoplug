/**
 * Host ServiceProfile producer (DD-HOST-002, DD-CAP-004).
 *
 * The read port (`createHostServiceProfileReadPort`) deliberately trusts no
 * producer: it re-derives `profile_hash`, re-hashes the evidence blob, requires
 * a passed `read_service_profile` probe and exact evidence references. This
 * module is the write side that satisfies those constraints:
 *
 *   1. read only host metadata through a native read path (never a generation
 *      result, never a model call);
 *   2. require a producer-independent roundtrip claim plus evidence references
 *      that the kernel can actually retrieve;
 *   3. fill only the limits the host did not report from an explicit policy;
 *      unreported rpm/concurrency stay `null`, unreported pricing stays
 *      `unknown`, and missing required token limits block instead of guessing;
 *   4. persist canonical evidence in the content-addressed store and prove it
 *      is retrievable *before* any capability is promoted;
 *   5. write one `host_probe` row and one `capability_record` row that share
 *      the exact same binding; `verified` is written only with
 *      `evidence_stage=roundtrip` and `probe_result=passed`.
 *
 * Journal note: both rows are registered with `binding_source: "none"`
 * (DD-CAP-008), so the audit binding lives in each row's `binding_json` while
 * the journal batch itself must be global (`binding: null`). The rows still
 * carry the identical `binding_key`; the single journal writer stays the only
 * committer.
 */

import { spawn } from "node:child_process";

import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  SourceRefPort,
  StateRowPort
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  formatSourceRef,
  hashBytes,
  isHash,
  isSourceRef,
  makeErrorEnvelope,
  newId,
  ok,
  toJsonValue
} from "@evoplug/core";
import type {
  CapabilityBinding,
  CapabilityRecord,
  HostProbeRecord,
  HostProbeResult,
  HostServiceProfileProbePort,
  HostServiceProfileProbeResult,
  ServiceProfileEvidence
} from "@evoplug/core/host";
import {
  capabilityBindingKey,
  serviceProfileEvidenceHash,
  serviceProfileKey,
  toCapabilityRecordPhysicalRow,
  toHostProbePhysicalRow,
  validateCapabilityBinding,
  validateCapabilityRecord,
  validateServiceProfileEvidence
} from "@evoplug/core/host";
import type { BlobStore, SqliteConnection } from "@evoplug/storage";
import type {
  CliMetadataProbeSpec
} from "./generation/cli-backend.js";
import type {
  KernelProbeEvidence,
  KernelProbeEvidencePort,
  KernelProbeEvidenceRequest
} from "./probe-producer.js";

const PROFILE_CAPABILITY = "generation.service_profile" as const;
const PROFILE_PROBE_ACTION = "read_service_profile";
const PROBE_CONTRACT_VERSION = "host-probe/2";
const MAX_DEADLINE_MS = 600_000;
const MAX_REQUEST_ID_LENGTH = 128;
/** Same ceiling the read port uses when resolving the evidence blob. */
const MAX_EVIDENCE_BYTES = 4_194_304;

/* ------------------------------------------------------------------ */
/* Native readback (the only host-provided input)                      */
/* ------------------------------------------------------------------ */

/**
 * What the host itself reports about its generation service profile. Every
 * limit is nullable because "not reported" is a real answer and must never be
 * filled with a guess. `claimed_evidence_stage` is only a claim: the producer
 * independently re-checks it.
 */
export interface ServiceProfileNativeReadback {
  readonly provider_scope: string | null;
  readonly request_max_tokens: number | null;
  readonly question_max_tokens: number | null;
  readonly max_output_tokens: number | null;
  readonly rpm: number | null;
  readonly concurrency: number | null;
  readonly pricing: ServiceProfileEvidence["pricing"] | null;
  /** Evidence references produced by the read-only host call. */
  readonly evidence_refs: readonly string[];
  /** Producer must verify this; a non-roundtrip claim is written as `loaded`. */
  readonly claimed_evidence_stage: "none" | "static" | "loaded" | "roundtrip";
  /** Optional model identity for the audit text; never a credential. */
  readonly model_id?: string;
}

/**
 * Host-side native read port. Implementations read host metadata only; they
 * must not run inference or generation and must not return credentials.
 */
export interface ServiceProfileNativeSource {
  read(input: {
    readonly request_id: string;
    readonly binding: CapabilityBinding;
    readonly backend_id: string;
    readonly deadline_ms: number;
    readonly signal?: AbortSignal;
    /** Present only inside an issued probe action; gates the roundtrip claim. */
    readonly probe_call?: KernelProbeEvidenceRequest;
  }): Promise<Result<ServiceProfileNativeReadback, ErrorEnvelope>>;
}

/**
 * Read-only native metadata reader. Composition supplies the real host command
 * (existing authorization, no model request, no credential read); W9 owns the
 * strict DTO check so a malformed or inferred document never reaches the
 * producer.
 */
export interface ServiceProfileMetadataReader {
  (input: {
    readonly request_id: string;
    readonly binding: CapabilityBinding;
    readonly backend_id: string;
    readonly deadline_ms: number;
    readonly signal?: AbortSignal;
  }): Promise<Result<JsonValue, ErrorEnvelope>>;
}

const NATIVE_READBACK_SCHEMA = "rsi.service_profile_native_readback/1" as const;

const READBACK_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "provider_scope",
  "request_max_tokens",
  "question_max_tokens",
  "max_output_tokens",
  "rpm",
  "concurrency",
  "pricing",
  "evidence_refs",
  "claimed_evidence_stage",
  "model_id"
]);

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullablePositiveInt(value: JsonValue | undefined): number | null | undefined {
  if (value === null) return null;
  return isPositiveSafeInt(value) ? value : undefined;
}

function parsePricing(value: JsonValue | undefined): ServiceProfileEvidence["pricing"] | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (value["status"] === "unknown") return { status: "unknown" };
  if (value["status"] !== "known") return undefined;
  const input = value["input_micros_per_million"];
  const output = value["output_micros_per_million"];
  const fixed = value["fixed_micros"];
  if (
    !Number.isSafeInteger(input) || (input as number) < 0 ||
    !Number.isSafeInteger(output) || (output as number) < 0 ||
    !Number.isSafeInteger(fixed) || (fixed as number) < 0
  ) {
    return undefined;
  }
  return {
    status: "known",
    input_micros_per_million: input as number,
    output_micros_per_million: output as number,
    fixed_micros: fixed as number
  };
}

/**
 * Strictly parses the native readback DTO. Missing limits must be `null`, not
 * omitted; the policy, not this parser, may fill required token limits.
 */
export function parseServiceProfileNativeReadback(
  value: JsonValue
): Result<ServiceProfileNativeReadback, ErrorEnvelope> {
  if (!isRecord(value) || value["schema_version"] !== NATIVE_READBACK_SCHEMA) {
    return err(blocked("readback", NATIVE_READBACK_SCHEMA));
  }
  for (const key of Object.keys(value)) {
    if (!READBACK_KEYS.has(key)) return err(blocked(`readback.${key}`, "closed_keys"));
  }
  const providerScope = value["provider_scope"];
  if (providerScope !== null && (typeof providerScope !== "string" || providerScope.length === 0)) {
    return err(blocked("readback.provider_scope", "string_or_null"));
  }
  const requestMax = readNullablePositiveInt(value["request_max_tokens"]);
  const questionMax = readNullablePositiveInt(value["question_max_tokens"]);
  const outputMax = readNullablePositiveInt(value["max_output_tokens"]);
  const rpm = readNullablePositiveInt(value["rpm"]);
  const concurrency = readNullablePositiveInt(value["concurrency"]);
  const pricing = parsePricing(value["pricing"]);
  if (
    requestMax === undefined || questionMax === undefined || outputMax === undefined ||
    rpm === undefined || concurrency === undefined || pricing === undefined
  ) {
    return err(blocked("readback.limits", "positive_int_or_null"));
  }
  const stage = value["claimed_evidence_stage"];
  if (stage !== "none" && stage !== "static" && stage !== "loaded" && stage !== "roundtrip") {
    return err(blocked("readback.claimed_evidence_stage", "evidence_stage"));
  }
  const refs = value["evidence_refs"];
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) {
    return err(blocked("readback.evidence_refs", "string_array"));
  }
  const modelId = value["model_id"];
  if (modelId !== undefined && typeof modelId !== "string") {
    return err(blocked("readback.model_id", "string"));
  }
  return ok({
    provider_scope: providerScope,
    request_max_tokens: requestMax,
    question_max_tokens: questionMax,
    max_output_tokens: outputMax,
    rpm,
    concurrency,
    pricing,
    evidence_refs: refs as string[],
    claimed_evidence_stage: stage,
    ...(modelId === undefined ? {} : { model_id: modelId })
  });
}

/** Wraps a real read-only host metadata reader behind the producer port. */
export function createServiceProfileMetadataSource(
  read: ServiceProfileMetadataReader
): ServiceProfileNativeSource {
  return {
    async read(input) {
      let value: Result<JsonValue, ErrorEnvelope>;
      try {
        value = await read(input);
      } catch {
        return err(blocked("readback", "reader_threw"));
      }
      if (!value.ok) return value;
      return parseServiceProfileNativeReadback(value.value);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Declarative CLI metadata reader                                     */
/* ------------------------------------------------------------------ */

export interface CliMetadataSourceDeps {
  readonly executable: string;
  readonly spec: CliMetadataProbeSpec;
  readonly connection: SqliteConnection;
  readonly blobs: Pick<BlobStore, "putSync" | "relativePath">;
  /** Selects one row/line; required when the command returns several. */
  readonly model_id?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly now?: () => number;
}

const METADATA_PLACEHOLDER = "{{model}}";

function runMetadataCommand(input: {
  executable: string;
  args: readonly string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  timeout_ms: number;
  max_output_bytes: number;
  cancel_signal: "SIGTERM" | "SIGINT";
  signal: AbortSignal | undefined;
}): Promise<Result<Uint8Array, ErrorEnvelope>> {
  return new Promise((resolve) => {
    let settled = false;
    let overflow = false;
    const chunks: Buffer[] = [];
    let length = 0;
    const finish = (value: Result<Uint8Array, ErrorEnvelope>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const child = spawn(input.executable, [...input.args], {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env }),
      stdio: ["ignore", "pipe", "ignore"]
    });
    const onAbort = (): void => {
      try {
        child.kill(input.cancel_signal);
      } catch {
        // close/error remains authoritative
      }
    };
    const timer = setTimeout(() => {
      onAbort();
      finish(err(blocked("metadata.timeout", "timeout")));
    }, Math.max(1, input.timeout_ms));
    if (input.signal !== undefined) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const remaining = input.max_output_bytes - length;
      if (remaining <= 0) {
        overflow = true;
        onAbort();
        return;
      }
      const bytes = chunk.subarray(0, remaining);
      chunks.push(bytes);
      length += bytes.byteLength;
      if (bytes.byteLength < chunk.byteLength) {
        overflow = true;
        onAbort();
      }
    });
    child.on("error", () => {
      finish(err(blocked("metadata.spawn", "spawn_failed")));
    });
    child.on("close", (code, signal) => {
      if (overflow) {
        finish(err(blocked("metadata.output", "output_overflow")));
        return;
      }
      if (input.signal?.aborted === true) {
        finish(err(blocked("metadata.signal", "aborted")));
        return;
      }
      if (code !== 0) {
        finish(err(blocked("metadata.exit_code", `${String(code)}/${String(signal)}`)));
        return;
      }
      finish(ok(new Uint8Array(Buffer.concat(chunks))));
    });
  });
}

function parseSize(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMB])?$/i.exec(value.trim());
  if (match === null) return null;
  const unit = (match[2] ?? "").toUpperCase();
  const factor = unit === "K" ? 1024 : unit === "M" ? 1024 * 1024 : unit === "B" ? 1024 * 1024 * 1024 : 1;
  const parsed = Math.round(Number(match[1]) * factor);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readJsonPath(value: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, JsonValue>>)[segment];
  }
  return current;
}

function nullableText(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableLimit(value: JsonValue | undefined, sized: boolean): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    if (sized) return parseSize(value);
    if (/^[0-9]+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
  }
  return null;
}

interface MetadataSelection {
  readonly provider_scope: string | null;
  readonly model_id: string | null;
  readonly request_max_tokens: number | null;
  readonly question_max_tokens: number | null;
  readonly max_output_tokens: number | null;
  readonly rpm: number | null;
  readonly concurrency: number | null;
}

function parseMetadataOutput(
  spec: CliMetadataProbeSpec,
  text: string,
  configuredModel: string | undefined
): Result<MetadataSelection, ErrorEnvelope> {
  const fields = spec.fields ?? {};
  const sized = new Set(spec.size_fields ?? []);
  const staticProvider = spec.static_fields?.provider_scope ?? null;
  const staticModel = spec.static_fields?.model_id ?? null;

  if (spec.output_protocol === "model_lines") {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const selected = configuredModel === undefined
      ? (lines.length === 1 ? lines[0] : undefined)
      : lines.find((line) => line === configuredModel || line.endsWith(`/${configuredModel}`) || line.split("/").slice(1).join("/") === configuredModel);
    if (selected === undefined) {
      return err(blocked("metadata.model", configuredModel === undefined ? "select_required" : "not_found"));
    }
    const slash = selected.indexOf("/");
    return ok({
      provider_scope: slash > 0 ? selected.slice(0, slash) : staticProvider,
      model_id: selected,
      request_max_tokens: null,
      question_max_tokens: null,
      max_output_tokens: null,
      rpm: null,
      concurrency: null
    });
  }

  if (spec.output_protocol === "text") {
    return ok({
      provider_scope: staticProvider,
      model_id: staticModel,
      request_max_tokens: null,
      question_max_tokens: null,
      max_output_tokens: null,
      rpm: null,
      concurrency: null
    });
  }

  if (spec.output_protocol === "models_table") {
    const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    const header = lines[0];
    if (header === undefined) return err(blocked("metadata.output", "empty"));
    const columns = header.trim().split(/\s{2,}/).map((column) => column.trim().toLowerCase());
    const rows = lines.slice(1).map((line) => {
      const cells = line.trim().split(/\s{2,}/);
      const row: Record<string, string> = {};
      for (let index = 0; index < columns.length; index += 1) {
        row[columns[index]!] = cells[index] ?? "";
      }
      return row;
    });
    const modelColumn = fields.model_id?.[0]?.toLowerCase() ?? "model";
    const providerColumn = fields.provider_scope?.[0]?.toLowerCase() ?? "provider";
    const selected = configuredModel === undefined
      ? (rows.length === 1 ? rows[0] : undefined)
      : rows.find((row) => {
          const model = row[modelColumn] ?? "";
          const provider = row[providerColumn] ?? "";
          return model === configuredModel || `${provider}/${model}` === configuredModel || configuredModel.endsWith(`/${model}`);
        });
    if (selected === undefined) {
      return err(blocked("metadata.model", configuredModel === undefined ? "select_required" : "not_found"));
    }
    const readField = (path: readonly string[] | undefined): JsonValue | undefined => {
      const column = path?.[0]?.toLowerCase();
      return column === undefined ? undefined : selected[column];
    };
    return ok({
      provider_scope: nullableText(readField(fields.provider_scope)) ?? staticProvider,
      model_id: nullableText(readField(fields.model_id)) ?? staticModel,
      request_max_tokens: nullableLimit(readField(fields.request_max_tokens), sized.has(fields.request_max_tokens?.[0] ?? "")),
      question_max_tokens: nullableLimit(readField(fields.question_max_tokens), sized.has(fields.question_max_tokens?.[0] ?? "")),
      max_output_tokens: nullableLimit(readField(fields.max_output_tokens), sized.has(fields.max_output_tokens?.[0] ?? "")),
      rpm: nullableLimit(readField(fields.rpm), false),
      concurrency: nullableLimit(readField(fields.concurrency), false)
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return err(blocked("metadata.output", "not_json"));
  }
  let root: JsonValue;
  try {
    root = toJsonValue(parsed);
  } catch {
    return err(blocked("metadata.output", "not_json_value"));
  }
  if (spec.result_field !== undefined) {
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      return err(blocked("metadata.result_field", "object_required"));
    }
    const inner = (root as Readonly<Record<string, JsonValue>>)[spec.result_field];
    if (inner === undefined) return err(blocked("metadata.result_field", "missing"));
    root = inner;
  }
  const readField = (path: readonly string[] | undefined): JsonValue | undefined =>
    path === undefined ? undefined : readJsonPath(root, path);
  return ok({
    provider_scope: nullableText(readField(fields.provider_scope)) ?? staticProvider,
    model_id: nullableText(readField(fields.model_id)) ?? staticModel,
    request_max_tokens: nullableLimit(readField(fields.request_max_tokens), sized.has(fields.request_max_tokens?.at(-1) ?? "")),
    question_max_tokens: nullableLimit(readField(fields.question_max_tokens), sized.has(fields.question_max_tokens?.at(-1) ?? "")),
    max_output_tokens: nullableLimit(readField(fields.max_output_tokens), sized.has(fields.max_output_tokens?.at(-1) ?? "")),
    rpm: nullableLimit(readField(fields.rpm), false),
    concurrency: nullableLimit(readField(fields.concurrency), false)
  });
}

/**
 * Executes one adapter-declared read-only metadata command and persists its raw
 * bytes as retrievable evidence. Numeric limits come only from parsed native
 * fields; a missing field stays null and the producer blocks by name.
 */
export function createCliMetadataSource(deps: CliMetadataSourceDeps): ServiceProfileNativeSource {
  const now = deps.now ?? (() => Date.now());
  return {
    async read(input) {
      const args = deps.spec.argv_template.map((entry) =>
        entry === METADATA_PLACEHOLDER ? deps.model_id ?? "" : entry
      );
      if (deps.spec.argv_template.some((entry) => entry.includes(METADATA_PLACEHOLDER)) && deps.model_id === undefined) {
        return err(blocked("metadata.model", "required"));
      }
      const timeout = Math.min(deps.spec.timeout_ms, Math.max(1, input.deadline_ms));
      const environment = {
        ...process.env,
        ...(deps.spec.env ?? {}),
        ...(deps.env ?? {})
      };
      const run = await runMetadataCommand({
        executable: deps.executable,
        args,
        cwd: deps.cwd,
        env: environment,
        timeout_ms: timeout,
        max_output_bytes: deps.spec.max_output_bytes,
        cancel_signal: deps.spec.cancel_signal,
        signal: input.signal
      });
      if (!run.ok) return run;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(run.value);
      } catch {
        return err(blocked("metadata.output", "not_utf8"));
      }
      const selection = parseMetadataOutput(deps.spec, text, deps.model_id);
      if (!selection.ok) return selection;

      const stored = deps.blobs.putSync(run.value);
      if (!stored.ok) return err(storageFailure("metadata_blob_put"));
      const evidenceRefResult = formatSourceRef({
        scheme: "blob",
        locator: stored.value.hash,
        start: 0,
        end: run.value.byteLength
      });
      if (!evidenceRefResult.ok) return err(blocked("metadata.evidence_ref", "blob_source_ref"));
      try {
        insertBlobRows({
          connection: deps.connection,
          blob_store: deps.blobs,
          hash: stored.value.hash,
          byteLength: run.value.byteLength,
          sourceRef: evidenceRefResult.value,
          ownerType: "evidence",
          ownerId: input.request_id,
          now: now()
        });
      } catch {
        return err(storageFailure("metadata_blob_row_insert"));
      }
      return ok({
        provider_scope: selection.value.provider_scope,
        request_max_tokens: selection.value.request_max_tokens,
        question_max_tokens: selection.value.question_max_tokens,
        max_output_tokens: selection.value.max_output_tokens,
        rpm: selection.value.rpm,
        concurrency: selection.value.concurrency,
        pricing: { status: "unknown" },
        evidence_refs: [evidenceRefResult.value],
        claimed_evidence_stage: input.probe_call === undefined ? "loaded" : "roundtrip",
        ...(selection.value.model_id === null ? {} : { model_id: selection.value.model_id })
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Compact persisted production action                                 */
/* ------------------------------------------------------------------ */

export interface PersistedHostServiceProfileConfig {
  /** Exact frozen host_contract binding, normally from serviceProfileBinding(). */
  readonly binding: CapabilityBinding;
  readonly backend_id: string;
  readonly executable: string;
  readonly metadata: CliMetadataProbeSpec;
  readonly model_id?: string;
  readonly cwd?: string;
  readonly policy?: ServiceProfilePolicy;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PersistedHostServiceProfileActionDeps {
  readonly connection: SqliteConnection;
  readonly blobs: Pick<BlobStore, "putSync" | "relativePath">;
  readonly source_refs: Pick<SourceRefPort, "resolve">;
  readonly state_rows: Pick<StateRowPort, "appendStateRows">;
  /** W1 kernel-owned collector; required for verified, omitted -> loaded. */
  readonly probe_collector?: KernelProbeEvidencePort;
  /**
   * Advanced composition collector. Takes precedence over `probe_collector`;
   * use only when the exact W1 issued request differs from the profile binding
   * key and must be supplied by a retained issued-call map.
   */
  readonly collector?: ServiceProfileObservationCollector;
  readonly config: PersistedHostServiceProfileConfig;
  readonly now?: () => number;
  readonly allocate_probe_id?: () => Id<"prb">;
  readonly allocate_capability_id?: () => Id<"cap">;
}

export interface PersistedHostServiceProfileRunInput {
  readonly request_id: string;
  readonly deadline_ms: number;
  readonly probe_call: KernelProbeEvidenceRequest;
  readonly signal?: AbortSignal;
}

/** Compact production entry: real native source, W1 collector and trigger. */
export interface PersistedHostServiceProfileAction {
  readonly probe_port: HostServiceProfileProbePort;
  run(input: PersistedHostServiceProfileRunInput): Promise<Result<ServiceProfileProduction, ErrorEnvelope>>;
}

/**
 * Builds the complete ServiceProfile production action from six public inputs
 * plus a declaration config. The caller never assembles reachback ports,
 * collector adapters or trigger shapes.
 */
export function createPersistedHostServiceProfileAction(
  deps: PersistedHostServiceProfileActionDeps
): PersistedHostServiceProfileAction {
  const source = createCliMetadataSource({
    executable: deps.config.executable,
    spec: deps.config.metadata,
    connection: deps.connection,
    blobs: deps.blobs,
    ...(deps.config.model_id === undefined ? {} : { model_id: deps.config.model_id }),
    ...(deps.config.env === undefined ? {} : { env: deps.config.env }),
    ...(deps.config.cwd === undefined ? {} : { cwd: deps.config.cwd }),
    ...(deps.now === undefined ? {} : { now: deps.now })
  });
  const runtime = createHostServiceProfileProductionRuntime({
    connection: deps.connection,
    blob_store: deps.blobs,
    source_refs: deps.source_refs,
    state_rows: deps.state_rows,
    source,
    ...(deps.collector !== undefined
      ? { collector: deps.collector }
      : deps.probe_collector === undefined
        ? {}
        : { collector: createKernelProbeEvidenceServiceProfileCollector(deps.probe_collector) }),
    ...(deps.config.policy === undefined ? {} : { policy: deps.config.policy }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.allocate_probe_id === undefined ? {} : { allocate_probe_id: deps.allocate_probe_id }),
    ...(deps.allocate_capability_id === undefined ? {} : { allocate_capability_id: deps.allocate_capability_id })
  });
  return {
    probe_port: runtime.probe_port,
    run(input) {
      if (input.probe_call.binding_key !== capabilityBindingKey(deps.config.binding)) {
        return Promise.resolve(err(blocked("probe_call.binding_key", "binding_key")));
      }
      return runtime.produce({
        request_id: input.request_id,
        binding: deps.config.binding,
        backend_id: deps.config.backend_id,
        deadline_ms: input.deadline_ms,
        probe_call: input.probe_call,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Explicit policy                                                     */
/* ------------------------------------------------------------------ */

/**
 * Kernel-owned provenance check for the observation the native read returned.
 *
 * `SourceRefPort.resolve` only proves bytes exist in the CAS; it cannot prove
 * that the kernel collected them instead of a runtime uploading a fabricated
 * provider body. Promotion therefore requires a collector that can attest the
 * observation belongs to this request and binding. Without a collector the
 * result is written as `loaded`.
 */
export interface ServiceProfileObservationCollector {
  verify(input: {
    readonly request_id: string;
    readonly binding_key: Hash;
    readonly backend_id: string;
    readonly evidence_refs: readonly SourceRef[];
    /** Issued probe call facts; without them W1 cannot attest the session. */
    readonly probe_call?: KernelProbeEvidenceRequest;
  }): Promise<Result<boolean, ErrorEnvelope>>;
}

/**
 * Limits the operator explicitly declares when the host cannot report them.
 * The policy may complete missing token limits only. Provider scope, rpm,
 * concurrency and pricing are never policy facts: a declared value can never
 * masquerade as native provenance.
 */
export interface ServiceProfilePolicy {
  readonly request_max_tokens?: number;
  readonly question_max_tokens?: number;
  readonly max_output_tokens?: number;
}

/* ------------------------------------------------------------------ */
/* Producer                                                            */
/* ------------------------------------------------------------------ */

export interface HostServiceProfileProducerDeps {
  readonly connection: SqliteConnection;
  /** Content-addressed store; evidence bytes are written before promotion. */
  readonly blob_store: Pick<BlobStore, "putSync" | "relativePath">;
  /** Retrievability gate; the same port the read side uses. */
  readonly source_refs: Pick<SourceRefPort, "resolve">;
  /** Single journal writer port. Batches are global (`binding: null`). */
  readonly state_rows: Pick<StateRowPort, "appendStateRows">;
  readonly source: ServiceProfileNativeSource;
  /**
   * Kernel-owned observation provenance. Production must supply W1's
   * collector; omitting it keeps the result at `loaded`.
   */
  readonly collector?: ServiceProfileObservationCollector;
  /** Explicit policy for limits the host does not report. */
  readonly policy?: ServiceProfilePolicy;
  readonly now?: () => number;
  readonly allocate_probe_id?: () => Id<"prb">;
  readonly allocate_capability_id?: () => Id<"cap">;
}

export interface ProduceServiceProfileInput {
  readonly request_id: string;
  /** Exact `host_contract` coordinates, already frozen by the composition. */
  readonly binding: CapabilityBinding;
  readonly backend_id: string;
  readonly deadline_ms: number;
  /** The issued W1 probe call. Required for collector attestation/roundtrip. */
  readonly probe_call?: KernelProbeEvidenceRequest;
  readonly signal?: AbortSignal;
}

/** Outcome of one production attempt. */
export interface ServiceProfileProduction {
  /** `verified` only when roundtrip evidence was independently confirmed. */
  readonly status: "verified" | "loaded";
  readonly binding_key: Hash;
  readonly profile_key: Hash;
  readonly evidence_hash: Hash;
  readonly evidence_ref: SourceRef;
  readonly evidence: ServiceProfileEvidence;
  readonly probe_id: Id<"prb">;
  readonly capability_id: Id<"cap">;
  readonly wrote_rows: boolean;
}

export interface HostServiceProfileProducer {
  produce(input: ProduceServiceProfileInput): Promise<Result<ServiceProfileProduction, ErrorEnvelope>>;
}

/**
 * The complete production entrypoint: one callable producer plus the exact
 * `HostServiceProfileProbePort` a host/runtime caller consumes. Composition
 * supplies W1's read-only native source and kernel collector; with no
 * collector every production stays `loaded` and unreadable by the read port.
 */
export interface HostServiceProfileProductionRuntime {
  readonly producer: HostServiceProfileProducer;
  readonly probe_port: HostServiceProfileProbePort;
  produce(input: ProduceServiceProfileInput): Promise<Result<ServiceProfileProduction, ErrorEnvelope>>;
}

export function createHostServiceProfileProductionRuntime(
  deps: HostServiceProfileProducerDeps
): HostServiceProfileProductionRuntime {
  const producer = createHostServiceProfileProducer(deps);
  return {
    producer,
    probe_port: createHostServiceProfileProbePort(producer),
    produce: (input) => producer.produce(input)
  };
}

/**
 * Adapts W1's kernel-owned evidence port to the producer's provenance port.
 *
 * W1's `collect()` already enforces kind/call/nonce/session/registration/
 * binding/artifact association and persists the collector-owned evidence refs.
 * This adapter must not re-derive or substitute any of those facts: without the
 * exact issued `probe_call` it reports `false`, which keeps the result at
 * `loaded`. The returned `call_session_id` is W1's value; it is never guessed
 * from `request_id`, `backend_id` or the readback.
 */
export function createKernelProbeEvidenceServiceProfileCollector(
  port: KernelProbeEvidencePort
): ServiceProfileObservationCollector {
  return {
    async verify(input) {
      const call = input.probe_call;
      if (call === undefined || call.kind !== "probe") return ok(false);
      if (call.binding_key !== input.binding_key) return ok(false);
      let collected: Result<KernelProbeEvidence | null, ErrorEnvelope>;
      try {
        collected = await port.collect(call);
      } catch {
        return ok(false);
      }
      if (!collected.ok) return collected;
      const evidence = collected.value;
      if (evidence === null) return ok(false);
      // W1 returns the bound association; a mismatch is not attestation.
      if (evidence.binding_key !== input.binding_key) return ok(false);
      return ok(true);
    }
  };
}

/** The explicit runtime/host probe action that may call production. */
export interface HostServiceProfileProbeAction {
  readonly probe_port: HostServiceProfileProbePort;
  /**
   * Call once after the read-only probe action completed. Never call at boot
   * or from a generation result.
   */
  run(input: ProduceServiceProfileInput & { readonly probe_call: KernelProbeEvidenceRequest }): Promise<Result<ServiceProfileProduction, ErrorEnvelope>>;
}

export function createHostServiceProfileProbeAction(
  deps: HostServiceProfileProducerDeps
): HostServiceProfileProbeAction {
  const runtime = createHostServiceProfileProductionRuntime(deps);
  return {
    probe_port: runtime.probe_port,
    run(input) {
      if (input.probe_call.binding_key !== capabilityBindingKey(input.binding)) {
        return Promise.resolve(err(blocked("probe_call.binding_key", "binding_key")));
      }
      return runtime.produce(input);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function blocked(path: string, rule: string, detailRef?: SourceRef): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SERVICE_PROFILE_BLOCKED",
    category: "authorization",
    message_key: "error.service_profile.blocked",
    stage: "service_profile_probe",
    details: { kind: "field", path, rule },
    ...(detailRef === undefined ? {} : { detail_ref: detailRef })
  });
}

function storageFailure(operation: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_IO",
    category: "storage",
    message_key: "error.io.failed",
    stage: "service_profile_probe",
    details: { kind: "field", path: operation, rule: "storage" }
  });
}

function deadlineFailure(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_DEADLINE_EXCEEDED",
    category: "deadline",
    message_key: "error.deadline_exceeded",
    stage: "service_profile_probe",
    details: { kind: "none" }
  });
}

function cancelledFailure(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CANCELLED",
    category: "deadline",
    message_key: "error.cancelled",
    stage: "service_profile_probe",
    details: { kind: "none" }
  });
}

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

interface ValidRequest {
  readonly binding: CapabilityBinding;
  readonly bindingKey: Hash;
  readonly backendId: string;
  readonly deadlineAt: number;
  readonly probeCall?: KernelProbeEvidenceRequest;
}

function validateRequest(
  input: ProduceServiceProfileInput,
  now: () => number
): Result<ValidRequest, ErrorEnvelope> {
  if (
    typeof input.request_id !== "string" ||
    input.request_id.length === 0 ||
    input.request_id.length > MAX_REQUEST_ID_LENGTH
  ) {
    return err(blocked("request_id", "1..128"));
  }
  if (
    !Number.isSafeInteger(input.deadline_ms) ||
    input.deadline_ms < 1 ||
    input.deadline_ms > MAX_DEADLINE_MS
  ) {
    return err(blocked("deadline_ms", "1..600000"));
  }
  if (typeof input.backend_id !== "string" || input.backend_id.length === 0) {
    return err(blocked("backend_id", "non_empty_string"));
  }
  const parsed = validateCapabilityBinding(input.binding);
  if (!parsed.ok) {
    return err(blocked("binding", "capability_binding"));
  }
  const binding = parsed.value;
  if (
    binding.subject !== "host_contract" ||
    binding.adapter_version !== "diagnostic" ||
    binding.backend_id !== input.backend_id
  ) {
    return err(blocked("binding", "host_contract_diagnostic_backend"));
  }
  const bindingKey = capabilityBindingKey(binding);
  const probeCall = input.probe_call;
  if (probeCall !== undefined) {
    if (probeCall.kind !== "probe") {
      return err(blocked("probe_call.kind", "probe"));
    }
    if (probeCall.binding_key !== bindingKey) {
      return err(blocked("probe_call.binding_key", "binding_key"));
    }
  }
  return ok({
    binding,
    bindingKey,
    backendId: input.backend_id,
    deadlineAt: now() + input.deadline_ms,
    ...(probeCall === undefined ? {} : { probeCall })
  });
}

/* ------------------------------------------------------------------ */
/* Limit resolution                                                    */
/* ------------------------------------------------------------------ */

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function pickPositive(
  reported: number | null,
  policy: number | undefined
): number | null {
  if (isPositiveSafeInt(reported)) return reported;
  if (isPositiveSafeInt(policy)) return policy;
  return null;
}

function resolveEvidence(input: {
  readback: ServiceProfileNativeReadback;
  policy: ServiceProfilePolicy | undefined;
  binding: CapabilityBinding;
  backendId: string;
  observedAt: number;
}): Result<ServiceProfileEvidence, ErrorEnvelope> {
  const { readback, policy, binding, backendId } = input;
  const providerScope = typeof readback.provider_scope === "string" && readback.provider_scope.length > 0
    ? readback.provider_scope
    : null;
  if (providerScope === null) {
    return err(blocked("provider_scope", "native_required"));
  }
  const requestMax = pickPositive(readback.request_max_tokens, policy?.request_max_tokens);
  const questionMax = pickPositive(readback.question_max_tokens, policy?.question_max_tokens);
  const outputMax = pickPositive(readback.max_output_tokens, policy?.max_output_tokens);
  if (requestMax === null) return err(blocked("request_max_tokens", "native_or_policy"));
  if (questionMax === null) return err(blocked("question_max_tokens", "native_or_policy"));
  if (outputMax === null) return err(blocked("max_output_tokens", "native_or_policy"));

  // rpm/concurrency/pricing are native-only facts. A policy declaration is not
  // provenance, so it can never make these look verified.
  const rpm = isPositiveSafeInt(readback.rpm) ? readback.rpm : null;
  const concurrency = isPositiveSafeInt(readback.concurrency) ? readback.concurrency : null;
  const pricing = readback.pricing ?? { status: "unknown" as const };

  const draft = {
    schema_version: "rsi.service_profile_evidence/1" as const,
    provider_scope: providerScope,
    backend_id: backendId,
    host_id: binding.host_id,
    mode: binding.mode,
    config_space: binding.config_space,
    request_max_tokens: requestMax,
    question_max_tokens: questionMax,
    max_output_tokens: outputMax,
    rpm,
    concurrency,
    pricing,
    profile_hash: canonicalHash({ pending: true }),
    observed_at: input.observedAt
  };
  const profileHash = serviceProfileKey({
    provider_scope: draft.provider_scope,
    backend_id: draft.backend_id,
    host_id: draft.host_id,
    mode: draft.mode,
    config_space: draft.config_space,
    request_max_tokens: draft.request_max_tokens,
    question_max_tokens: draft.question_max_tokens,
    max_output_tokens: draft.max_output_tokens,
    rpm: draft.rpm,
    concurrency: draft.concurrency,
    pricing: draft.pricing
  });
  const candidate = { ...draft, profile_hash: profileHash };
  const validated = validateServiceProfileEvidence(candidate);
  if (!validated.ok) return validated;
  return ok(validated.value);
}

/* ------------------------------------------------------------------ */
/* Roundtrip verification                                              */
/* ------------------------------------------------------------------ */

interface RoundtripCheck {
  readonly verified: boolean;
  readonly refs: readonly SourceRef[];
}

/**
 * A roundtrip claim counts only when the declared evidence references are
 * real source references and every one of them resolves with bytes. A single
 * unresolvable reference downgrades the result to `loaded`.
 */
async function checkRoundtrip(input: {
  readback: ServiceProfileNativeReadback;
  resolve: Pick<SourceRefPort, "resolve">;
  collector: ServiceProfileObservationCollector | undefined;
  request_id: string;
  binding_key: Hash;
  backend_id: string;
  probe_call?: KernelProbeEvidenceRequest;
}): Promise<RoundtripCheck> {
  const { readback, resolve, collector } = input;
  if (readback.claimed_evidence_stage !== "roundtrip" || readback.evidence_refs.length === 0) {
    return { verified: false, refs: [] };
  }
  const refs: SourceRef[] = [];
  for (const ref of readback.evidence_refs) {
    if (!isSourceRef(ref)) return { verified: false, refs: [] };
    refs.push(ref);
  }
  for (const ref of refs) {
    try {
      const resolved = await resolve.resolve(ref, { maxBytes: MAX_EVIDENCE_BYTES });
      if (!resolved.ok || !resolved.value.retrievable || resolved.value.bytes === null) {
        return { verified: false, refs };
      }
    } catch {
      // A throwing source port is not evidence; fail closed without escaping
      // the producer's Result contract.
      return { verified: false, refs };
    }
  }
  // CAS retrievability is necessary but not sufficient: only the kernel-owned
  // collector can attest that the bytes came from the host, not from an
  // arbitrary runtime upload.
  if (collector === undefined) {
    return { verified: false, refs };
  }
  let attested: boolean;
  try {
    const checked = await collector.verify({
      request_id: input.request_id,
      binding_key: input.binding_key,
      backend_id: input.backend_id,
      evidence_refs: refs,
      ...(input.probe_call === undefined ? {} : { probe_call: input.probe_call })
    });
    attested = checked.ok && checked.value === true;
  } catch {
    attested = false;
  }
  return { verified: attested, refs };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function insertBlobRows(input: {
  connection: SqliteConnection;
  blob_store: Pick<BlobStore, "relativePath">;
  hash: Hash;
  byteLength: number;
  sourceRef: SourceRef;
  ownerType: string;
  ownerId: string;
  now: number;
}): void {
  input.connection.prepare(
    `INSERT INTO blob (
       blob_hash, byte_length, relative_path, state, verified_at, created_at,
       deleted_at, deletion_reason
     ) VALUES (
       :blob_hash, :byte_length, :relative_path, 'present', :now, :now, NULL, NULL
     )
     ON CONFLICT(blob_hash) DO NOTHING`
  ).run({
    blob_hash: input.hash,
    byte_length: input.byteLength,
    relative_path: input.blob_store.relativePath(input.hash),
    now: input.now
  });
  input.connection.prepare(
    `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
     VALUES (:blob_hash, :owner_type, :owner_id, :source_ref, :created_at)
     ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
  ).run({
    blob_hash: input.hash,
    owner_type: input.ownerType,
    owner_id: input.ownerId,
    source_ref: input.sourceRef,
    created_at: input.now
  });
}

interface ExistingCapability {
  readonly capability_id: Id<"cap">;
  readonly row_version: number;
}

function readExistingCapability(
  connection: SqliteConnection,
  bindingKey: Hash
): ExistingCapability | null {
  const row = connection.prepare<{ capability_id: string; row_version: number }>(
    `SELECT capability_id, row_version
       FROM capability_record
      WHERE binding_key = :binding_key AND name = :name`
  ).get({ binding_key: bindingKey, name: PROFILE_CAPABILITY });
  if (row === undefined) return null;
  if (typeof row.capability_id !== "string" || !row.capability_id.startsWith("cap:")) {
    return null;
  }
  if (!Number.isSafeInteger(row.row_version) || row.row_version < 1) return null;
  return {
    capability_id: row.capability_id as Id<"cap">,
    row_version: row.row_version
  };
}

function observedText(input: {
  readback: ServiceProfileNativeReadback;
  roundtripRefs: readonly SourceRef[];
  verified: boolean;
  evidenceHash: Hash;
}): string {
  return canonicalJsonText(toJsonValue({
    schema_version: "rsi.service_profile_observation/1",
    probe_action: PROFILE_PROBE_ACTION,
    claimed_evidence_stage: input.readback.claimed_evidence_stage,
    verified_roundtrip: input.verified,
    roundtrip_refs: input.roundtripRefs,
    evidence_hash: input.evidenceHash,
    model_id: input.readback.model_id ?? null,
    reported: {
      provider_scope: input.readback.provider_scope,
      request_max_tokens: input.readback.request_max_tokens,
      question_max_tokens: input.readback.question_max_tokens,
      max_output_tokens: input.readback.max_output_tokens,
      rpm: input.readback.rpm,
      concurrency: input.readback.concurrency,
      pricing: input.readback.pricing
    }
  }));
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

function internalProbeError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "host_probe_validate",
    details: { kind: "field", path, rule }
  });
}

/**
 * HOST-internal probe validation for `generation.service_profile`.
 *
 * The adapter-facing `validateHostProbeRecord` refuses the HOST-reserved
 * capability (adapters must never declare or probe it). This producer is the
 * HOST-owned read path named by DD-CAP-004/DD-HOST-002, so it applies the
 * reserved shape itself: exact binding, recomputed binding key, one passed
 * assertion whose expected hash and observed ref match the persisted evidence,
 * and one matching capability result. Nothing an adapter sends reaches it.
 */
function validateInternalProfileProbe(
  probe: HostProbeRecord,
  expected: { readonly evidence_hash: Hash; readonly evidence_ref: SourceRef }
): Result<HostProbeRecord, ErrorEnvelope> {
  if (probe.schema_version !== "rsi.host_probe/2") {
    return err(internalProbeError("schema_version", "rsi.host_probe/2"));
  }
  if (probe.probe_contract_version !== PROBE_CONTRACT_VERSION) {
    return err(internalProbeError("probe_contract_version", PROBE_CONTRACT_VERSION));
  }
  if (!probe.probe_id.startsWith("prb:")) {
    return err(internalProbeError("probe_id", "prb_id"));
  }
  if (probe.target_kind !== "host") {
    return err(internalProbeError("target_kind", "host"));
  }
  const binding = validateCapabilityBinding(probe.binding, {
    capabilityName: PROFILE_CAPABILITY
  });
  if (!binding.ok) return binding;
  if (binding.value.subject !== "host_contract") {
    return err(internalProbeError("binding.subject", "host_contract"));
  }
  const bindingKey = capabilityBindingKey(binding.value);
  if (bindingKey !== probe.binding_key) {
    return err(internalProbeError("binding_key", "binding_key_mismatch"));
  }
  if (probe.probe_mode !== "read_only") {
    return err(internalProbeError("probe_mode", "read_only"));
  }
  if (probe.probe_action !== PROFILE_PROBE_ACTION) {
    return err(internalProbeError("probe_action", PROFILE_PROBE_ACTION));
  }
  const assertion = probe.assertions[0];
  if (probe.assertions.length !== 1 || assertion === undefined) {
    return err(internalProbeError("assertions", "exactly_one"));
  }
  if (assertion.capability !== PROFILE_CAPABILITY) {
    return err(internalProbeError("assertions.capability", PROFILE_CAPABILITY));
  }
  if (!isHash(assertion.expected) || assertion.expected !== expected.evidence_hash) {
    return err(internalProbeError("assertions.expected", "evidence_hash"));
  }
  if (!isSourceRef(assertion.observed_ref) || assertion.observed_ref !== expected.evidence_ref) {
    return err(internalProbeError("assertions.observed_ref", "evidence_ref"));
  }
  if (assertion.pass !== true && assertion.pass !== "unknown") {
    return err(internalProbeError("assertions.pass", "true_or_unknown"));
  }
  const result = probe.capability_results[0];
  if (probe.capability_results.length !== 1 || result === undefined) {
    return err(internalProbeError("capability_results", "exactly_one"));
  }
  if (result.name !== PROFILE_CAPABILITY) {
    return err(internalProbeError("capability_results.name", PROFILE_CAPABILITY));
  }
  if (result.proposed_status !== "verified" && result.proposed_status !== "unknown") {
    return err(internalProbeError("capability_results.proposed_status", "verified_or_unknown"));
  }
  if (result.evidence_stage !== "roundtrip" && result.evidence_stage !== "loaded") {
    return err(internalProbeError("capability_results.evidence_stage", "roundtrip_or_loaded"));
  }
  if (result.evidence_refs.length !== 1 || result.evidence_refs[0] !== expected.evidence_ref) {
    return err(internalProbeError("capability_results.evidence_refs", "evidence_ref"));
  }
  if (probe.result === "passed") {
    if (assertion.pass !== true || result.proposed_status !== "verified") {
      return err(internalProbeError("result", "passed_requires_verified"));
    }
  } else if (probe.result === "unknown") {
    if (assertion.pass !== "unknown" || result.proposed_status !== "unknown") {
      return err(internalProbeError("result", "unknown_requires_unknown"));
    }
  } else {
    return err(internalProbeError("result", "passed_or_unknown"));
  }
  if (!probe.evidence_refs.includes(expected.evidence_ref)) {
    return err(internalProbeError("evidence_refs", "evidence_ref"));
  }
  if (!Number.isSafeInteger(probe.duration_ms) || probe.duration_ms < 0) {
    return err(internalProbeError("duration_ms", "non_negative_safe_integer"));
  }
  if (!Number.isSafeInteger(probe.checked_at) || probe.checked_at < 0) {
    return err(internalProbeError("checked_at", "non_negative_safe_integer"));
  }
  return ok(probe);
}

export function createHostServiceProfileProducer(
  deps: HostServiceProfileProducerDeps
): HostServiceProfileProducer {
  const now = deps.now ?? (() => Date.now());
  const allocateProbeId = deps.allocate_probe_id ?? (() => newId("prb", now()));
  const allocateCapabilityId =
    deps.allocate_capability_id ?? (() => newId("cap", now()));

  async function produce(
    input: ProduceServiceProfileInput
  ): Promise<Result<ServiceProfileProduction, ErrorEnvelope>> {
    const startedAt = now();
    if (aborted(input.signal)) {
      return err(cancelledFailure());
    }
    const request = validateRequest(input, now);
    if (!request.ok) return request;
    if (now() > request.value.deadlineAt) {
      return err(deadlineFailure());
    }

    let readback: ServiceProfileNativeReadback;
    try {
      const read = await deps.source.read({
        request_id: input.request_id,
        binding: request.value.binding,
        backend_id: request.value.backendId,
        deadline_ms: Math.max(1, request.value.deadlineAt - now()),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(request.value.probeCall === undefined ? {} : { probe_call: request.value.probeCall })
      });
      if (!read.ok) return read;
      readback = read.value;
    } catch {
      return err(storageFailure("native_read"));
    }
    if (aborted(input.signal)) {
      return err(cancelledFailure());
    }
    if (now() > request.value.deadlineAt) {
      return err(deadlineFailure());
    }

    const observedAt = now();
    const evidence = resolveEvidence({
      readback,
      policy: deps.policy,
      binding: request.value.binding,
      backendId: request.value.backendId,
      observedAt
    });
    if (!evidence.ok) return evidence;

    const roundtrip = await checkRoundtrip({
      readback,
      resolve: deps.source_refs,
      collector: deps.collector,
      request_id: input.request_id,
      binding_key: request.value.bindingKey,
      backend_id: request.value.backendId,
      ...(request.value.probeCall === undefined ? {} : { probe_call: request.value.probeCall })
    });
    const verified = roundtrip.verified;
    const evidenceHash = serviceProfileEvidenceHash(evidence.value);
    const bytes = new TextEncoder().encode(canonicalJsonText(toJsonValue(evidence.value)));

    // CAS first, then prove retrievability before writing any capability row.
    const stored = deps.blob_store.putSync(bytes);
    if (!stored.ok) {
      return err(storageFailure("blob_put"));
    }
    const evidenceRefResult = formatSourceRef({
      scheme: "blob",
      locator: stored.value.hash,
      start: 0,
      end: bytes.byteLength
    });
    if (!evidenceRefResult.ok) {
      return err(blocked("evidence_ref", "blob_source_ref"));
    }
    const evidenceRef = evidenceRefResult.value;

    const probeId = allocateProbeId();
    const existing = readExistingCapability(deps.connection, request.value.bindingKey);
    const capabilityId = existing?.capability_id ?? allocateCapabilityId();

    try {
      insertBlobRows({
        connection: deps.connection,
        blob_store: deps.blob_store,
        hash: stored.value.hash,
        byteLength: bytes.byteLength,
        sourceRef: evidenceRef,
        ownerType: "evidence",
        ownerId: probeId,
        now: observedAt
      });
    } catch {
      return err(storageFailure("blob_row_insert"));
    }

    let readable: Awaited<ReturnType<SourceRefPort["resolve"]>>;
    try {
      readable = await deps.source_refs.resolve(evidenceRef, { maxBytes: MAX_EVIDENCE_BYTES });
    } catch {
      return err(storageFailure("evidence_readback"));
    }
    if (
      !readable.ok ||
      !readable.value.retrievable ||
      readable.value.bytes === null ||
      (readable.value.range_content_hash !== null &&
        readable.value.range_content_hash !== evidenceHash) ||
      (readable.value.contentVersion !== null &&
        readable.value.contentVersion !== evidenceHash)
    ) {
      return err(blocked("evidence_ref", "not_retrievable", evidenceRef));
    }
    if (aborted(input.signal)) {
      return err(cancelledFailure());
    }
    if (now() > request.value.deadlineAt) {
      return err(deadlineFailure());
    }

    const probeResult: HostProbeResult = verified ? "passed" : "unknown";
    const probe: HostProbeRecord = {
      schema_version: "rsi.host_probe/2",
      probe_id: probeId,
      probe_contract_version: PROBE_CONTRACT_VERSION,
      target_kind: "host",
      binding: request.value.binding,
      binding_key: request.value.bindingKey,
      probe_mode: "read_only",
      probe_action: PROFILE_PROBE_ACTION,
      assertions: [
        {
          assertion_id: `${PROFILE_CAPABILITY}:${PROFILE_PROBE_ACTION}`,
          capability: PROFILE_CAPABILITY,
          expected: evidenceHash,
          observed_ref: evidenceRef,
          pass: verified ? true : "unknown"
        }
      ],
      capability_results: [
        {
          name: PROFILE_CAPABILITY,
          proposed_status: verified ? "verified" : "unknown",
          evidence_stage: verified ? "roundtrip" : "loaded",
          evidence_refs: [evidenceRef]
        }
      ],
      result: probeResult,
      expected:
        "The host reports its generation service limits and the kernel retrieves the evidence it references.",
      observed: observedText({
        readback,
        roundtripRefs: roundtrip.refs,
        verified,
        evidenceHash
      }),
      evidence_refs: [...new Set([evidenceRef, ...roundtrip.refs])].sort(),
      duration_ms: Math.max(0, observedAt - startedAt),
      checked_at: observedAt
    };
    const validatedProbe = validateInternalProfileProbe(probe, {
      evidence_hash: evidenceHash,
      evidence_ref: evidenceRef
    });
    if (!validatedProbe.ok) return validatedProbe;

    const capability: CapabilityRecord = {
      schema_version: "rsi.capability/2",
      capability_id: capabilityId,
      binding: request.value.binding,
      binding_key: request.value.bindingKey,
      name: PROFILE_CAPABILITY,
      status: verified ? "verified" : "unknown",
      evidence_stage: verified ? "roundtrip" : "loaded",
      evidence_refs: [evidenceRef],
      probe_ref: probeId,
      probe_result: probeResult,
      checked_at: observedAt,
      ...(verified ? { verified_at: observedAt, last_verified_at: observedAt } : {}),
      details: {
        profile_schema: "rsi.service_profile/1",
        evidence_schema: "rsi.service_profile_evidence/1",
        provider_scope: evidence.value.provider_scope,
        profile_key: evidence.value.profile_hash,
        observed_at: observedAt
      }
    } as CapabilityRecord;
    const validatedCapability = validateCapabilityRecord(capability);
    if (!validatedCapability.ok) return validatedCapability;

    const outcome = await deps.state_rows.appendStateRows({
      // Both rows are `binding_source: "none"`; the audit binding is in each
      // `binding_json` and the journal batch stays global.
      binding: null,
      rows: [
        {
          row_schema: "rsi.host_probe_row/1",
          operation: "insert",
          row: toHostProbePhysicalRow(validatedProbe.value, 1),
          document_id: null
        },
        {
          row_schema: "rsi.capability_record_row/1",
          operation: existing === null ? "insert" : "transition",
          row: toCapabilityRecordPhysicalRow(
            validatedCapability.value,
            existing === null ? 1 : existing.row_version + 1
          ),
          document_id: null
        }
      ],
      documents: [],
      heads: []
    });
    if (!outcome.ok) {
      return err({
        ...outcome.error,
        side_effect: outcome.commit_state === "not_written" ? "none" : "unknown"
      });
    }

    return ok({
      status: verified ? "verified" : "loaded",
      binding_key: request.value.bindingKey,
      profile_key: evidence.value.profile_hash,
      evidence_hash: evidenceHash,
      evidence_ref: evidenceRef,
      evidence: evidence.value,
      probe_id: probeId,
      capability_id: capabilityId,
      wrote_rows: true
    });
  }

  return { produce };
}

/* ------------------------------------------------------------------ */
/* The read port's producer-facing view                                */
/* ------------------------------------------------------------------ */

/**
 * Adapts a producer to the `HostServiceProfileProbePort` shape used by the
 * read-side gateway. Only the frozen evidence coordinates are returned; a
 * `loaded` production is still reported as a probe coordinate, and the read
 * port refuses to expose it because no verified capability row exists.
 */
export function createHostServiceProfileProbePort(
  producer: HostServiceProfileProducer
): HostServiceProfileProbePort {
  return {
    async read(input) {
      const produced = await producer.produce(input);
      if (!produced.ok) return produced;
      const result: HostServiceProfileProbeResult = {
        schema_version: "rsi.service_profile_probe_result/1",
        binding_key: produced.value.binding_key,
        evidence_ref: produced.value.evidence_ref,
        evidence_hash: produced.value.evidence_hash,
        provider_scope: produced.value.evidence.provider_scope,
        observed_at: produced.value.evidence.observed_at
      };
      return ok(result);
    }
  };
}

/** Hash helper kept local so callers can assert CAS identity without re-reading. */
export function serviceProfileEvidenceBytesHash(evidence: ServiceProfileEvidence): Hash {
  return hashBytes(new TextEncoder().encode(canonicalJsonText(toJsonValue(evidence))));
}
