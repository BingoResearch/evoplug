/**
 * Generic CLI generation backend (W9, DD-HOST-002).
 *
 * The kernel owns the child-process boundary and the output protocol. Every
 * host difference is a *declaration* in an adapter's `generation-spec.ts`:
 * binary, argv template, prompt transport, output protocol, timeouts, cancel
 * signal and output cap. This module never branches on `host_id` and never
 * appends model, provider or reasoning parameters of its own; whatever the
 * host CLI is configured with stays authoritative.
 *
 * Specs are plain data. They are declared and exported by adapter packages
 * without importing `@evoplug/kernel`, so the dependency direction stays
 * adapter -> core -> (kernel consumes the data structurally).
 *
 * Capability levels are never promoted here. A declared spec produces
 * `unknown`/`static` capabilities; only persisted probe rows can raise them.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  canonicalHash,
  hashBytes,
  isSourceRef,
  parseSourceRef,
  systemClock,
  toJsonValue,
  type Clock,
  type Hash,
  type Id,
  type Result,
  type SourceRef
} from "@evoplug/core";
import type {
  AdapterBackendSelection,
  HostAdapterError,
  GenerationAuthRequest,
  GenerationAuthResult,
  GenerationBackendRef,
  GenerationBackendSelectRequest,
  GenerationCancelRequest,
  GenerationCancelResult,
  GenerationCapabilityBinding,
  GenerationCreateRequest,
  GenerationCreateResult,
  GenerationOutputRequest,
  GenerationOutputResult,
  GenerationRecoverRequest,
  GenerationRecoverResult,
  HostAdapterResult
} from "@evoplug/core/host";
import { adapterErr, adapterOk } from "@evoplug/core/host";
import {
  GENERATOR_OUTPUT_SCHEMA_VERSION,
  GENERATOR_PROTOCOL_VERSION,
  RESERVED_EXPERIENCE_FIELDS
} from "@evoplug/review";

import type { GenerationBlobPorts } from "../review-worker-loop.js";

const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_SESSIONS = 256;
const PROMPT_PLACEHOLDER = "{{prompt}}";
const PROMPT_FILE_PLACEHOLDER = "{{prompt_file}}";
const GLUE_PLACEHOLDER = "{{glue}}";

/** Prompt composer supplied by the review composition, never by a host branch. */
export type ReviewGenerationPromptBuilder = (
  snapshot_text: string,
  request: GenerationCreateRequest
) => string;

/**
 * Attempt id compared by `parseGeneratorOutput`. The review write path builds
 * the generation run id as `<attempt_id>:run`; strip that documented suffix so
 * the started event matches the attempt row.
 */
function cliGenerationAttemptId(request: GenerationCreateRequest): string {
  const runId = request.generation_run_id;
  return runId.endsWith(":run") ? runId.slice(0, -4) : runId;
}

/**
 * Default prompt for real CLI hosts.
 *
 * The generic adapter defaults to the snapshot-only prompt so it stays host-
 * and product-neutral. Review generation supplies this protocol-aware builder
 * instead: it embeds the frozen snapshot and states the real
 * `rsi.generator_protocol/1` line envelope, closed event set, proposal schema
 * and reserved fields. Without it a real host receives no output contract and
 * cannot produce a parseable candidate.
 */
export function createReviewGenerationPromptBuilder(): ReviewGenerationPromptBuilder {
  return (snapshotText, request) => {
    const attemptId = cliGenerationAttemptId(request);
    return [
      "You are running an evoplug review generation.",
      "Use the following frozen review snapshot as the complete review context.",
      `Return only ${GENERATOR_PROTOCOL_VERSION} JSON Lines (schema ${GENERATOR_OUTPUT_SCHEMA_VERSION}): one JSON object per physical line, UTF-8, a final LF, no blank lines, no markdown fences and no commentary.`,
      `Line 1 must be a started event: {"type":"started"} with attempt_id exactly ${JSON.stringify(attemptId)}, protocol_version exactly ${JSON.stringify(GENERATOR_PROTOCOL_VERSION)}, and model_id set to the real model identifier you are running as.`,
      'Each candidate is one line: {"type":"proposal","proposal":{...}}. proposal.ordinal starts at 1 and is contiguous; ordinal is not nested inside proposal.',
      'proposal.schema_version is "rsi.proposal_candidate/1". Required fields: change_kind, object_type, target, diff_format, diff_text, experience, validation_plan, evidence_refs. Optional: expected_old_file_hash, expected_old_block_hash, refines_experience_ref.',
      "target requires target_ref, host_id, path_or_block, requested_write_mode; project_id and block_id are optional.",
      `Do not emit ${RESERVED_EXPERIENCE_FIELDS.join(", ")} anywhere inside experience; REV assigns them.`,
      'The final line is exactly one terminal: {"type":"completed","proposal_count":<number>} with the number of proposal lines, or {"type":"failed","error_code":"...","message":"..."}, or {"type":"cancelled","reason":"..."}.',
      "Do not claim verification or delivery.",
      "<evoplug-review-snapshot>",
      snapshotText,
      "</evoplug-review-snapshot>"
    ].join("\n");
  };
}

/** How the prompt reaches the host CLI. */
export type CliPromptTransport = "stdin" | "argv" | "file";

/** How stdout is decoded into a candidate value. */
export type CliOutputProtocol = "jsonl" | "json_result" | "text";

/** Scalar compared by one `jsonl` event selector. */
export type CliOutputScalar = string | number | boolean;

/** One declarative predicate over a parsed `jsonl` event. */
export interface CliOutputSelector {
  /** Dot path; `*` maps arrays and object values. */
  readonly path: string;
  readonly equals: CliOutputScalar;
}

/**
 * Declarative extraction of candidate text from a host `jsonl` envelope.
 *
 * Hosts emit their own event stream and wrap assistant text in different
 * shapes. The adapter states the shape once; the kernel evaluates the paths
 * generically. No host id ever enters this module.
 */
export interface CliOutputExtraction {
  readonly schema_version: "rsi.cli_output_extract/1";
  /** Every selector must match for the event to contribute text. */
  readonly select?: readonly CliOutputSelector[];
  /** Paths inside a selected event whose string values are candidate text. */
  readonly text_paths: readonly string[];
  /** How multiple selected events combine. Defaults to `last`. */
  readonly combine?: "first" | "last" | "concat";
}

/**
 * Typed output normalization applied before the payload is stored.
 *
 * The review protocol requires a final LF. A host that omits it is a declared
 * transport difference, not a reason for the review parser to tolerate
 * truncated output.
 */
export interface CliOutputNormalization {
  readonly schema_version: "rsi.cli_output_normalization/1";
  readonly final_newline?: "preserve" | "ensure";
}

/** Signal sent first on cancel; SIGKILL follows after the grace window. */
export type CliCancelSignal = "SIGTERM" | "SIGINT";

/**
 * `available` means the declaration is usable. `blocked` means the entry is
 * not verified on this platform (e.g. Codex region block); `unsupported` means
 * the host has no non-interactive generation entry at all.
 */
export type CliBackendAvailability = "available" | "blocked" | "unsupported";

/**
 * Declarative, read-only CLI metadata probe used to build a ServiceProfile.
 * The adapter declares which native command speaks and how to read its fields;
 * the kernel only executes and maps. No limit is inferred from a model name,
 * context window or generation result.
 */
export type CliMetadataOutputProtocol = "models_table" | "model_lines" | "json" | "text";

export interface CliMetadataProbeSpec {
  readonly schema_version: "rsi.cli_metadata_probe/1";
  /** `{{model}}` is replaced from the caller's configured model id. */
  readonly argv_template: readonly string[];
  readonly output_protocol: CliMetadataOutputProtocol;
  /** `json` only: optional outer result field to unwrap. */
  readonly result_field?: string;
  /** Table columns or JSON paths per profile field. */
  readonly fields?: {
    readonly provider_scope?: readonly string[];
    readonly model_id?: readonly string[];
    readonly request_max_tokens?: readonly string[];
    readonly question_max_tokens?: readonly string[];
    readonly max_output_tokens?: readonly string[];
    readonly rpm?: readonly string[];
    readonly concurrency?: readonly string[];
  };
  /** Field names whose values use `1M` / `131.1K` size suffixes. */
  readonly size_fields?: readonly string[];
  /** Adapter-declared constants, never numeric limits. */
  readonly static_fields?: {
    readonly provider_scope?: string;
    readonly model_id?: string;
  };
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly cancel_signal: CliCancelSignal;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Named failure taxonomy. These are diagnostic codes, not FND error codes;
 * they are surfaced through `failure()` and never replace the adapter result
 * axis.
 */
export type CliGenerationFailureCode =
  | "cli_spawn_failed"
  | "cli_timeout"
  | "cli_aborted"
  | "cli_deadline_exceeded"
  | "cli_nonzero_exit"
  | "cli_output_overflow"
  | "cli_output_too_large"
  | "cli_output_empty"
  | "cli_output_parse_error"
  | "cli_output_missing_result";

/** One adapter-declared, host-specific generation entry. */
export interface CliGenerationSpec {
  readonly schema_version: "rsi.cli_generation_spec/1";
  readonly backend_id: string;
  readonly host_id: string;
  /** Declared backend version; the persisted `host_contract` pin wins. */
  readonly backend_version: string;
  readonly binary_name: string;
  /** Optional environment variable that must override binary discovery. */
  readonly executable_env?: string;
  /** `{{prompt}}` / `{{prompt_file}}` / `{{glue}}` placeholders only. */
  readonly argv_template: readonly string[];
  readonly prompt_transport: CliPromptTransport;
  readonly output_protocol: CliOutputProtocol;
  /** Extracts the candidate text from a `json_result` object. */
  readonly result_field?: string;
  /** Declarative text extraction from a `jsonl` host event stream. */
  readonly output_extract?: CliOutputExtraction;
  /** Declarative normalization applied to the extracted candidate text. */
  readonly output_normalization?: CliOutputNormalization;
  readonly timeout_ms: number;
  readonly cancel_signal: CliCancelSignal;
  /** Absolute cap for buffered stdout; overflow terminates the child. */
  readonly max_output_bytes: number;
  readonly availability: CliBackendAvailability;
  /**
   * What the adapter actually verified when this spec was written. The kernel
   * never upgrades a capability from this field; it only documents provenance.
   */
  readonly verification: "native_verified" | "entry_observed" | "unverified" | "blocked";
  readonly blocker_code?: string;
  readonly protocol_versions: readonly string[];
  readonly network: "disabled" | "restricted" | "enabled";
  /** Relative path of the Python glue, for `sdk_python` style entries. */
  readonly glue_script?: string;
  /**
   * Marks the entry the old #44 explicit OpenCode selection resolves to when
   * `generation.cli_backend` is off. This is adapter metadata, not a kernel
   * host branch: the generic factory builds the default registry from it.
   */
  readonly legacy_default_backend?: boolean;
  /**
   * Read-only native metadata declaration for ServiceProfile production.
   * Declared by the adapter; interpreted by the kernel generic reader.
   */
  readonly metadata_probe?: CliMetadataProbeSpec;
}

/** Structural rejection from `validateCliGenerationSpec`. */
export interface CliGenerationSpecError {
  readonly code: "invalid_cli_generation_spec";
  readonly path: string;
  readonly rule: string;
}

/** Validation does not use `ErrorEnvelope`: a bad declaration is a build-time bug. */
export type CliGenerationSpecValidation =
  | { readonly ok: true; readonly status: "ok"; readonly value: CliGenerationSpec }
  | { readonly ok: false; readonly status: "rejected"; readonly error: CliGenerationSpecError };

/** Lookup surface consumed by the composition root and review generation. */
export interface CliGenerationSpecRegistry {
  readonly specs: readonly CliGenerationSpec[];
  /**
   * Spec the legacy #44 explicit selection resolves to when the new
   * `generation.cli_backend` flag is off. `null` means no legacy entry.
   */
  readonly legacy_default: CliGenerationSpec | null;
  resolve(backend_id: string): CliGenerationSpec | null;
}

/** Parsed native output. `empty` is a read-time state, not a failure. */
export type CliOutputParse =
  | { readonly status: "empty" }
  | { readonly status: "complete"; readonly value: unknown }
  | {
      readonly status: "invalid";
      readonly code: Extract<CliGenerationFailureCode, "cli_output_parse_error" | "cli_output_missing_result">;
      readonly detail: string;
    };

/** Runtime diagnosis for one handle. */
export type CliOutputKind = "extracted" | "raw_stdout";

export interface CliOutputSummary {
  readonly raw_stdout: { readonly sha256: Hash; readonly byte_length: number };
  readonly extracted_answer: { readonly sha256: Hash; readonly byte_length: number } | null;
  readonly stderr: { readonly sha256: Hash; readonly byte_length: number };
}

export interface CliProviderDiagnostic {
  /** Stable category, e.g. `provider_auth_403` or `provider_model_unavailable`. */
  readonly category: string;
  readonly http_status: number | null;
  readonly source: "stdout" | "stderr";
}

export interface CliGenerationFailure {
  readonly code: CliGenerationFailureCode;
  readonly detail: string;
  readonly exit_code: number | null;
  readonly exit_signal: NodeJS.Signals | null;
  /** Whether the stored output is the extracted candidate or the raw host stream. */
  readonly output_kind: CliOutputKind | null;
  /** Structured provider-side diagnosis. Never contains provider response bodies. */
  readonly provider_error: CliProviderDiagnostic | null;
  /** Classification of stderr text; raw stderr is never exposed. */
  readonly stderr_class: readonly string[];
  readonly output: CliOutputSummary;
}

export interface CliGenerationAdapterOptions {
  readonly spec: CliGenerationSpec;
  readonly executable: string;
  readonly ports: GenerationBlobPorts;
  /** Directory that holds a `glue_script`; required only for that entry. */
  readonly glue_root?: string;
  /**
   * Optional protocol-aware prompt composition. The default embeds the frozen
   * snapshot only; a planner that requires `rsi.generator_protocol/1` output
   * supplies its own builder here. Host selection stays in the declaration.
   */
  readonly prompt_builder?: (snapshot_text: string, request: GenerationCreateRequest) => string;
  readonly clock?: Clock;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: (
    executable: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcessWithoutNullStreams;
  readonly max_snapshot_bytes?: number;
  readonly max_buffered_bytes?: number;
  readonly kill_grace_ms?: number;
  /** Retained session records; terminal sessions are evicted first. Default 256. */
  readonly max_sessions?: number;
}

interface CliSession {
  readonly handle_ref: string;
  readonly process: ChildProcessWithoutNullStreams;
  readonly idempotency_key: string;
  readonly started_at: number;
  readonly output: number[];
  /** Extracted candidate bytes, present only when the declared extraction succeeded. */
  extracted: number[] | null;
  /** Bounded diagnostic stderr; never used as a candidate. */
  readonly stderr: number[];
  output_kind: CliOutputKind | null;
  poll: number;
  closed: boolean;
  exit_code: number | null;
  exit_signal: NodeJS.Signals | null;
  spawn_error: Error | null;
  cancel_requested: boolean;
  timed_out: boolean;
  overflow: boolean;
  deadline_timer: ReturnType<typeof setTimeout> | null;
  kill_timer: ReturnType<typeof setTimeout> | null;
  abort_cleanup: (() => void) | null;
  failure_code: CliGenerationFailureCode | null;
  failure_detail: string | null;
  prompt_dir: string | null;
}

const GENERATION_ACTIONS = ["create", "auth", "cancel", "recover", "output"] as const;

/* ------------------------------------------------------------------ */
/* Spec validation and registry                                        */
/* ------------------------------------------------------------------ */

function specError(path: string, rule: string): CliGenerationSpecError {
  return { code: "invalid_cli_generation_spec", path, rule };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isString(entry) && entry.length > 0);
}

/** Validates one adapter-declared read-only metadata probe. */
export function validateCliMetadataProbeSpec(
  value: unknown
): { readonly ok: true; readonly value: CliMetadataProbeSpec } | { readonly ok: false; readonly error: CliGenerationSpecError } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: specError("metadata_probe", "object") };
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record["schema_version"] !== "rsi.cli_metadata_probe/1") {
    return { ok: false, error: specError("metadata_probe.schema_version", "rsi.cli_metadata_probe/1") };
  }
  const allowedKeys = new Set([
    "schema_version",
    "argv_template",
    "output_protocol",
    "result_field",
    "fields",
    "size_fields",
    "static_fields",
    "timeout_ms",
    "max_output_bytes",
    "cancel_signal",
    "env"
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: specError(`metadata_probe.${key}`, "closed_keys") };
    }
  }
  if (!isStringArray(record["argv_template"])) {
    return { ok: false, error: specError("metadata_probe.argv_template", "non_empty_string_array") };
  }
  const protocol = record["output_protocol"];
  if (protocol !== "models_table" && protocol !== "model_lines" && protocol !== "json" && protocol !== "text") {
    return { ok: false, error: specError("metadata_probe.output_protocol", "enum") };
  }
  const resultField = record["result_field"];
  if (resultField !== undefined && (!isString(resultField) || resultField.length === 0)) {
    return { ok: false, error: specError("metadata_probe.result_field", "non_empty_string") };
  }
  if (resultField !== undefined && protocol !== "json") {
    return { ok: false, error: specError("metadata_probe.result_field", "requires_json") };
  }
  const fields = record["fields"];
  const fieldRecord = typeof fields === "object" && fields !== null && !Array.isArray(fields)
    ? fields as Readonly<Record<string, unknown>>
    : undefined;
  const allowedFields = new Set([
    "provider_scope",
    "model_id",
    "request_max_tokens",
    "question_max_tokens",
    "max_output_tokens",
    "rpm",
    "concurrency"
  ]);
  if (fields !== undefined && fieldRecord === undefined) {
    return { ok: false, error: specError("metadata_probe.fields", "object") };
  }
  if (fieldRecord !== undefined) {
    for (const key of Object.keys(fieldRecord)) {
      if (!allowedFields.has(key)) {
        return { ok: false, error: specError(`metadata_probe.fields.${key}`, "closed_keys") };
      }
      if (!isStringArray(fieldRecord[key])) {
        return { ok: false, error: specError(`metadata_probe.fields.${key}`, "non_empty_string_array") };
      }
    }
  }
  const sizeFields = record["size_fields"];
  if (sizeFields !== undefined && (!Array.isArray(sizeFields) || sizeFields.some((entry) => !isString(entry)))) {
    return { ok: false, error: specError("metadata_probe.size_fields", "string_array") };
  }
  const staticFields = record["static_fields"];
  const staticRecord = typeof staticFields === "object" && staticFields !== null && !Array.isArray(staticFields)
    ? staticFields as Readonly<Record<string, unknown>>
    : undefined;
  if (staticFields !== undefined && staticRecord === undefined) {
    return { ok: false, error: specError("metadata_probe.static_fields", "object") };
  }
  if (staticRecord !== undefined) {
    for (const key of Object.keys(staticRecord)) {
      if (key !== "provider_scope" && key !== "model_id") {
        return { ok: false, error: specError(`metadata_probe.static_fields.${key}`, "closed_keys") };
      }
      if (!isString(staticRecord[key]) || (staticRecord[key] as string).length === 0) {
        return { ok: false, error: specError(`metadata_probe.static_fields.${key}`, "non_empty_string") };
      }
    }
  }
  for (const field of ["timeout_ms", "max_output_bytes"]) {
    const number = record[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      return { ok: false, error: specError(`metadata_probe.${field}`, "positive_safe_integer") };
    }
  }
  if (record["cancel_signal"] !== "SIGTERM" && record["cancel_signal"] !== "SIGINT") {
    return { ok: false, error: specError("metadata_probe.cancel_signal", "enum") };
  }
  const env = record["env"];
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      return { ok: false, error: specError("metadata_probe.env", "object") };
    }
    for (const [key, entry] of Object.entries(env)) {
      if (!isString(entry) || key.length === 0) {
        return { ok: false, error: specError(`metadata_probe.env.${key}`, "string_map") };
      }
    }
  }
  return {
    ok: true,
    value: {
      schema_version: "rsi.cli_metadata_probe/1",
      argv_template: Object.freeze([...(record["argv_template"] as string[])]),
      output_protocol: protocol,
      ...(resultField === undefined ? {} : { result_field: resultField as string }),
      ...(fieldRecord === undefined ? {} : {
        fields: Object.freeze(Object.fromEntries(
          Object.entries(fieldRecord).map(([key, entry]) => [key, Object.freeze([...(entry as string[])])])
        ))
      }),
      ...(sizeFields === undefined ? {} : { size_fields: Object.freeze([...(sizeFields as string[])]) }),
      ...(staticRecord === undefined ? {} : {
        static_fields: {
          ...(staticRecord["provider_scope"] === undefined ? {} : { provider_scope: staticRecord["provider_scope"] as string }),
          ...(staticRecord["model_id"] === undefined ? {} : { model_id: staticRecord["model_id"] as string })
        }
      }),
      timeout_ms: record["timeout_ms"] as number,
      max_output_bytes: record["max_output_bytes"] as number,
      cancel_signal: record["cancel_signal"],
      ...(env === undefined ? {} : { env: Object.freeze({ ...(env as Record<string, string>) }) })
    }
  };
}

function isPathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("\\");
}

function isOutputPath(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.split(".").every(isPathSegment);
}

/** Validates one declarative `jsonl` extraction declaration. */
export function validateCliOutputExtraction(
  value: unknown
): { readonly ok: true; readonly value: CliOutputExtraction } | { readonly ok: false; readonly error: CliGenerationSpecError } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: specError("output_extract", "object") };
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record["schema_version"] !== "rsi.cli_output_extract/1") {
    return { ok: false, error: specError("output_extract.schema_version", "rsi.cli_output_extract/1") };
  }
  const allowedKeys = new Set(["schema_version", "select", "text_paths", "combine"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: specError(`output_extract.${key}`, "closed_keys") };
    }
  }
  const selectRaw = record["select"];
  const selectors: CliOutputSelector[] = [];
  if (selectRaw !== undefined) {
    if (!Array.isArray(selectRaw) || selectRaw.length === 0) {
      return { ok: false, error: specError("output_extract.select", "non_empty_array") };
    }
    for (const [index, entry] of selectRaw.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return { ok: false, error: specError(`output_extract.select[${index}]`, "object") };
      }
      const item = entry as Readonly<Record<string, unknown>>;
      if (Object.keys(item).some((key) => key !== "path" && key !== "equals")) {
        return { ok: false, error: specError(`output_extract.select[${index}]`, "closed_keys") };
      }
      if (!isOutputPath(item["path"])) {
        return { ok: false, error: specError(`output_extract.select[${index}].path`, "dot_path") };
      }
      const equals = item["equals"];
      if (typeof equals !== "string" && typeof equals !== "number" && typeof equals !== "boolean") {
        return { ok: false, error: specError(`output_extract.select[${index}].equals`, "scalar") };
      }
      selectors.push(Object.freeze({ path: item["path"], equals }));
    }
  }
  const textPaths = record["text_paths"];
  if (!Array.isArray(textPaths) || textPaths.length === 0 || !textPaths.every(isOutputPath)) {
    return { ok: false, error: specError("output_extract.text_paths", "non_empty_dot_path_array") };
  }
  const combine = record["combine"];
  if (combine !== undefined && combine !== "first" && combine !== "last" && combine !== "concat") {
    return { ok: false, error: specError("output_extract.combine", "enum") };
  }
  return {
    ok: true,
    value: {
      schema_version: "rsi.cli_output_extract/1",
      ...(selectors.length === 0 ? {} : { select: Object.freeze(selectors) }),
      text_paths: Object.freeze([...textPaths]),
      ...(combine === undefined ? {} : { combine })
    }
  };
}

/** Validates one typed output normalization declaration. */
export function validateCliOutputNormalization(
  value: unknown
): { readonly ok: true; readonly value: CliOutputNormalization } | { readonly ok: false; readonly error: CliGenerationSpecError } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: specError("output_normalization", "object") };
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record["schema_version"] !== "rsi.cli_output_normalization/1") {
    return { ok: false, error: specError("output_normalization.schema_version", "rsi.cli_output_normalization/1") };
  }
  for (const key of Object.keys(record)) {
    if (key !== "schema_version" && key !== "final_newline") {
      return { ok: false, error: specError(`output_normalization.${key}`, "closed_keys") };
    }
  }
  const finalNewline = record["final_newline"];
  if (finalNewline !== undefined && finalNewline !== "preserve" && finalNewline !== "ensure") {
    return { ok: false, error: specError("output_normalization.final_newline", "enum") };
  }
  return {
    ok: true,
    value: {
      schema_version: "rsi.cli_output_normalization/1",
      ...(finalNewline === undefined ? {} : { final_newline: finalNewline })
    }
  };
}

/**
 * Validates one structurally declared spec. Adapter packages export plain
 * data, so this is the only place that turns it into a trusted value.
 */
export function validateCliGenerationSpec(
  value: unknown
): CliGenerationSpecValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, status: "rejected", error: specError("$", "object") };
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record["schema_version"] !== "rsi.cli_generation_spec/1") {
    return { ok: false, status: "rejected", error: specError("schema_version", "rsi.cli_generation_spec/1") };
  }
  for (const field of ["backend_id", "host_id", "backend_version", "binary_name"]) {
    if (!isString(record[field]) || record[field].length === 0) {
      return { ok: false, status: "rejected", error: specError(field, "non_empty_string") };
    }
  }
  const executableEnv = record["executable_env"];
  if (executableEnv !== undefined && (!isString(executableEnv) || executableEnv.length === 0)) {
    return { ok: false, status: "rejected", error: specError("executable_env", "non_empty_string") };
  }
  const argv = record["argv_template"];
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((entry) => !isString(entry) || entry.length === 0)) {
    return { ok: false, status: "rejected", error: specError("argv_template", "non_empty_string_array") };
  }
  const transport = record["prompt_transport"];
  if (transport !== "stdin" && transport !== "argv" && transport !== "file") {
    return { ok: false, status: "rejected", error: specError("prompt_transport", "enum") };
  }
  const hasPrompt = argv.some((entry) => entry.includes(PROMPT_PLACEHOLDER));
  const hasPromptFile = argv.some((entry) => entry.includes(PROMPT_FILE_PLACEHOLDER));
  if (transport === "argv" && !hasPrompt) {
    return { ok: false, status: "rejected", error: specError("argv_template", "prompt_placeholder_required") };
  }
  if (transport === "file" && !hasPromptFile) {
    return { ok: false, status: "rejected", error: specError("argv_template", "prompt_file_placeholder_required") };
  }
  if (transport === "stdin" && (hasPrompt || hasPromptFile)) {
    return { ok: false, status: "rejected", error: specError("argv_template", "stdin_forbids_prompt_placeholder") };
  }
  const protocol = record["output_protocol"];
  if (protocol !== "jsonl" && protocol !== "json_result" && protocol !== "text") {
    return { ok: false, status: "rejected", error: specError("output_protocol", "enum") };
  }
  const resultField = record["result_field"];
  if (resultField !== undefined && (!isString(resultField) || resultField.length === 0)) {
    return { ok: false, status: "rejected", error: specError("result_field", "non_empty_string") };
  }
  if (resultField !== undefined && protocol !== "json_result") {
    return { ok: false, status: "rejected", error: specError("result_field", "requires_json_result") };
  }
  const outputExtractRaw = record["output_extract"];
  let outputExtract: CliOutputExtraction | undefined;
  if (outputExtractRaw !== undefined) {
    if (protocol !== "jsonl") {
      return { ok: false, status: "rejected", error: specError("output_extract", "requires_jsonl") };
    }
    const validatedExtract = validateCliOutputExtraction(outputExtractRaw);
    if (!validatedExtract.ok) {
      return { ok: false, status: "rejected", error: validatedExtract.error };
    }
    outputExtract = validatedExtract.value;
  }
  const outputNormalizationRaw = record["output_normalization"];
  let outputNormalization: CliOutputNormalization | undefined;
  if (outputNormalizationRaw !== undefined) {
    const validatedNormalization = validateCliOutputNormalization(outputNormalizationRaw);
    if (!validatedNormalization.ok) {
      return { ok: false, status: "rejected", error: validatedNormalization.error };
    }
    outputNormalization = validatedNormalization.value;
  }
  for (const field of ["timeout_ms", "max_output_bytes"]) {
    const number = record[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      return { ok: false, status: "rejected", error: specError(field, "positive_safe_integer") };
    }
  }
  if (record["cancel_signal"] !== "SIGTERM" && record["cancel_signal"] !== "SIGINT") {
    return { ok: false, status: "rejected", error: specError("cancel_signal", "enum") };
  }
  const availability = record["availability"];
  if (availability !== "available" && availability !== "blocked" && availability !== "unsupported") {
    return { ok: false, status: "rejected", error: specError("availability", "enum") };
  }
  const verification = record["verification"];
  if (
    verification !== "native_verified" &&
    verification !== "entry_observed" &&
    verification !== "unverified" &&
    verification !== "blocked"
  ) {
    return { ok: false, status: "rejected", error: specError("verification", "enum") };
  }
  if (availability !== "available" && record["blocker_code"] === undefined) {
    return { ok: false, status: "rejected", error: specError("blocker_code", "required_when_unavailable") };
  }
  const blockerCode = record["blocker_code"];
  if (blockerCode !== undefined && (!isString(blockerCode) || blockerCode.length === 0)) {
    return { ok: false, status: "rejected", error: specError("blocker_code", "non_empty_string") };
  }
  const protocolVersions = record["protocol_versions"];
  if (
    !Array.isArray(protocolVersions) ||
    protocolVersions.length === 0 ||
    protocolVersions.some((entry) => !isString(entry) || entry.length === 0)
  ) {
    return { ok: false, status: "rejected", error: specError("protocol_versions", "non_empty_string_array") };
  }
  if (record["network"] !== "disabled" && record["network"] !== "restricted" && record["network"] !== "enabled") {
    return { ok: false, status: "rejected", error: specError("network", "enum") };
  }
  const glueScript = record["glue_script"];
  if (glueScript !== undefined) {
    if (!isString(glueScript) || glueScript.length === 0 || isAbsolute(glueScript) || glueScript.includes("..")) {
      return { ok: false, status: "rejected", error: specError("glue_script", "relative_path") };
    }
    if (!argv.some((entry) => entry.includes(GLUE_PLACEHOLDER))) {
      return { ok: false, status: "rejected", error: specError("argv_template", "glue_placeholder_required") };
    }
  }
  const legacyDefault = record["legacy_default_backend"];
  if (legacyDefault !== undefined && typeof legacyDefault !== "boolean") {
    return { ok: false, status: "rejected", error: specError("legacy_default_backend", "boolean") };
  }
  const metadataProbeRaw = record["metadata_probe"];
  let metadataProbe: CliMetadataProbeSpec | undefined;
  if (metadataProbeRaw !== undefined) {
    const validatedMetadata = validateCliMetadataProbeSpec(metadataProbeRaw);
    if (!validatedMetadata.ok) {
      return { ok: false, status: "rejected", error: validatedMetadata.error };
    }
    metadataProbe = validatedMetadata.value;
  }
  return {
    ok: true,
    status: "ok",
    value: {
      schema_version: "rsi.cli_generation_spec/1",
      backend_id: record["backend_id"] as string,
      host_id: record["host_id"] as string,
      backend_version: record["backend_version"] as string,
      binary_name: record["binary_name"] as string,
      ...(executableEnv === undefined ? {} : { executable_env: executableEnv as string }),
      argv_template: Object.freeze([...(argv as string[])]),
      prompt_transport: transport,
      output_protocol: protocol,
      ...(resultField === undefined ? {} : { result_field: resultField as string }),
      ...(outputExtract === undefined ? {} : { output_extract: outputExtract }),
      ...(outputNormalization === undefined ? {} : { output_normalization: outputNormalization }),
      timeout_ms: record["timeout_ms"] as number,
      cancel_signal: record["cancel_signal"],
      max_output_bytes: record["max_output_bytes"] as number,
      availability,
      verification,
      ...(blockerCode === undefined ? {} : { blocker_code: blockerCode as string }),
      protocol_versions: Object.freeze([...(protocolVersions as string[])]),
      network: record["network"],
      ...(glueScript === undefined ? {} : { glue_script: glueScript as string }),
      ...(legacyDefault === undefined ? {} : { legacy_default_backend: legacyDefault }),
      ...(metadataProbe === undefined ? {} : { metadata_probe: metadataProbe })
    }
  };
}

/**
 * Indexes adapter-declared specs by backend id. Duplicate ids and invalid
 * declarations are programmer errors at composition time, so this throws
 * instead of silently dropping a host.
 */
export function createGenerationSpecRegistry(
  entries: readonly CliGenerationSpec[]
): CliGenerationSpecRegistry {
  const byId = new Map<string, CliGenerationSpec>();
  let legacyDefault: CliGenerationSpec | null = null;
  for (const entry of entries) {
    const validated = validateCliGenerationSpec(entry);
    if (!validated.ok) {
      throw new Error(
        `invalid generation spec for ${String((entry as { backend_id?: unknown }).backend_id)}: ${validated.error.path}/${validated.error.rule}`
      );
    }
    if (byId.has(validated.value.backend_id)) {
      throw new Error(`duplicate generation spec backend_id: ${validated.value.backend_id}`);
    }
    if (validated.value.legacy_default_backend === true) {
      if (legacyDefault !== null) {
        throw new Error("duplicate legacy_default_backend generation spec");
      }
      legacyDefault = validated.value;
    }
    byId.set(validated.value.backend_id, validated.value);
  }
  return {
    specs: Object.freeze([...byId.values()]),
    legacy_default: legacyDefault,
    resolve: (backend_id: string) => byId.get(backend_id) ?? null
  };
}

/* ------------------------------------------------------------------ */
/* Backend descriptor                                                  */
/* ------------------------------------------------------------------ */

function capability(
  spec: CliGenerationSpec,
  action: (typeof GENERATION_ACTIONS)[number]
): GenerationCapabilityBinding {
  return {
    name: `generation.${action}`,
    capability_id: `cap:${spec.backend_id}.${action}` as Id<"cap">,
    status: "unknown",
    evidence_stage: "static",
    evidence_refs: []
  };
}

/**
 * Builds the descriptor for an installed CLI entry. Capabilities stay
 * `unknown`/`static`; the review composition overlays verified rows.
 */
export function createCliGenerationBackend(
  spec: CliGenerationSpec,
  input: {
    readonly executable: string;
    readonly backend_version?: string;
    readonly approval_ref?: string;
  }
): GenerationBackendRef {
  const capabilities = {
    create: capability(spec, "create"),
    auth: capability(spec, "auth"),
    cancel: capability(spec, "cancel"),
    recover: capability(spec, "recover"),
    output: capability(spec, "output")
  };
  const backend: GenerationBackendRef = {
    schema_version: "rsi.generation_backend_ref/1",
    backend_id: spec.backend_id,
    backend_kind: spec.glue_script === undefined ? "cli" : "sdk",
    entry_kind: "cli_spawn",
    entry_ref: input.executable,
    backend_version: input.backend_version ?? spec.backend_version,
    protocol_versions: ["cli_spawn/1", ...spec.protocol_versions],
    isolation: {
      mode: "process",
      network: spec.network,
      evidence_refs: []
    },
    capabilities,
    capability_snapshot_hash: canonicalHash(
      toJsonValue({
        schema_version: "rsi.cli_generation_capability_snapshot/1",
        backend_id: spec.backend_id,
        executable: input.executable,
        protocol_versions: ["cli_spawn/1", ...spec.protocol_versions],
        capabilities
      })
    ),
    approval_ref: input.approval_ref ?? "operator-configured"
  };
  return backend;
}

/* ------------------------------------------------------------------ */
/* Prompt and argv                                                     */
/* ------------------------------------------------------------------ */

/** The frozen snapshot is the whole review context; no live state is added. */
export function buildCliGenerationPrompt(snapshotText: string): string {
  return [
    "You are running an evoplug review generation.",
    "Use the following frozen review snapshot as the complete review context.",
    "Return the candidate output only; do not claim verification or delivery.",
    "<evoplug-review-snapshot>",
    snapshotText,
    "</evoplug-review-snapshot>"
  ].join("\n");
}

function substitute(argv: readonly string[], replacements: Readonly<Record<string, string>>): string[] {
  return argv.map((entry) => {
    let next = entry;
    for (const [token, replacement] of Object.entries(replacements)) {
      next = next.split(token).join(replacement);
    }
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Native output parser                                                */
/* ------------------------------------------------------------------ */

/** Resolves one dot path; `*` maps arrays and object values. */
function pathValues(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const item of current) {
      if (segment === "*") {
        if (Array.isArray(item)) next.push(...item);
        else if (typeof item === "object" && item !== null) {
          next.push(...Object.values(item as Readonly<Record<string, unknown>>));
        }
        continue;
      }
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const found = (item as Readonly<Record<string, unknown>>)[segment];
      if (found !== undefined) next.push(found);
    }
    current = next;
  }
  return current;
}

/** Applies the declared extraction to one complete `jsonl` stdout buffer. */
function extractJsonlText(
  chunk: string,
  extract: CliOutputExtraction
): { readonly text: string } | { readonly error: string } {
  const selected: string[] = [];
  const selectors = extract.select ?? [];
  for (const line of chunk.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return { error: "jsonl_line_not_json" };
    }
    const matched = selectors.every((selector) =>
      pathValues(event, selector.path).some((value) => value === selector.equals)
    );
    if (!matched) continue;
    const parts: string[] = [];
    for (const path of extract.text_paths) {
      for (const value of pathValues(event, path)) {
        if (typeof value === "string") parts.push(value);
      }
    }
    const text = parts.join("");
    if (text.length > 0) selected.push(text);
  }
  if (selected.length === 0) return { error: "output_extract_no_match" };
  const combine = extract.combine ?? "last";
  if (combine === "first") return { text: selected[0] as string };
  if (combine === "concat") return { text: selected.join("") };
  return { text: selected[selected.length - 1] as string };
}

/** Parses one complete stdout buffer for the declared protocol. */
export function parseCliOutput(
  protocol: CliOutputProtocol,
  chunk: string,
  result_field?: string,
  output_extract?: CliOutputExtraction
): CliOutputParse {
  if (chunk.trim().length === 0) return { status: "empty" };
  if (protocol === "text") return { status: "complete", value: chunk };
  if (protocol === "jsonl") {
    if (output_extract !== undefined) {
      const extracted = extractJsonlText(chunk, output_extract);
      if ("error" in extracted) {
        return { status: "invalid", code: "cli_output_missing_result", detail: extracted.error };
      }
      return { status: "complete", value: extracted.text };
    }
    let last: unknown;
    for (const line of chunk.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        last = JSON.parse(line) as unknown;
      } catch {
        return { status: "invalid", code: "cli_output_parse_error", detail: "jsonl_line_not_json" };
      }
    }
    if (last === undefined) return { status: "empty" };
    return { status: "complete", value: last };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunk) as unknown;
  } catch {
    return { status: "invalid", code: "cli_output_parse_error", detail: "json_result_not_json" };
  }
  if (result_field === undefined) return { status: "complete", value: parsed };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", code: "cli_output_missing_result", detail: "result_object_required" };
  }
  const field = (parsed as Readonly<Record<string, unknown>>)[result_field];
  if (field === undefined) {
    return { status: "invalid", code: "cli_output_missing_result", detail: result_field };
  }
  return { status: "complete", value: field };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

const MAX_STDERR_BYTES = 64 * 1024;

function summarizeBuffer(bytes: readonly number[]): { readonly sha256: Hash; readonly byte_length: number } {
  const array = Uint8Array.from(bytes);
  return { sha256: hashBytes(array), byte_length: array.byteLength };
}

function summarizeSession(session: CliSession): CliOutputSummary {
  return {
    raw_stdout: summarizeBuffer(session.output),
    extracted_answer: session.extracted === null ? null : summarizeBuffer(session.extracted),
    stderr: summarizeBuffer(session.stderr)
  };
}

/** Classifies stderr without exposing its text. */
function classifyStderr(text: string): readonly string[] {
  const classes: string[] = [];
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?)?key|invalid[_ -]?token|authentication|credential)\b/i.test(text)) classes.push("auth");
  if (/\b(?:429|quota|rate[_ -]?limit|free usage limit|insufficient[_ -]?balance)\b/i.test(text)) classes.push("quota");
  if (/\b(?:model.{0,40}(?:not found|unavailable|unsupported)|no such model)\b/i.test(text)) classes.push("model");
  if (/\b(?:MissingSessionID|missing[_ -]?session)\b/i.test(text)) classes.push("session");
  if (/\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|fetch failed|network)\b/i.test(text)) classes.push("network");
  if (/\b(?:unknown option|unrecognized|usage:|invalid argument)\b/i.test(text)) classes.push("args");
  if (/\b(?:500|501|502|503|504|internal[_ -]?server|overloaded)\b/i.test(text)) classes.push("server");
  return classes;
}

/**
 * Extracts the host's own error object from a parsed JSON event stream.
 *
 * Only structured error events are considered, so prompt text echoed into
 * `session` or `agent_end` events cannot be mistaken for a provider error.
 */
function eventErrorText(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Readonly<Record<string, unknown>>;
    if (record["type"] === "error") {
      const error = record["error"];
      const text = typeof error === "string" ? error : JSON.stringify(error ?? record);
      return text.slice(0, 8_192);
    }
    if (record["type"] === "message_end") {
      const message = record["message"];
      if (message !== null && typeof message === "object" && !Array.isArray(message)) {
        const assistant = message as Readonly<Record<string, unknown>>;
        if (assistant["role"] === "assistant" && assistant["stopReason"] === "error") {
          const errorMessage = typeof assistant["errorMessage"] === "string" ? assistant["errorMessage"] : "";
          const error = assistant["error"];
          const text = errorMessage.length > 0 ? errorMessage : JSON.stringify(error ?? assistant);
          return text.slice(0, 8_192);
        }
      }
    }
  }
  return null;
}

function diagnoseProviderError(stdout: string, stderr: string): CliProviderDiagnostic | null {
  const stdoutError = eventErrorText(stdout);
  const structured = stdoutError === null ? stderr : stdoutError;
  const statusMatch = /"status"\s*:\s*(401|403|429|500|501|502|503|504)/.exec(structured)
    ?? /\b(?:HTTP|status)[^0-9]{0,8}(401|403|429|500|501|502|503|504)\b/i.exec(stderr);
  const status = statusMatch === null ? null : Number(statusMatch[1]);
  const combined = `${structured}\n${stderr}`;
  const source: "stdout" | "stderr" = stdoutError === null ? "stderr" : "stdout";
  if (/provider\.auth|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?)?key|invalid[_ -]?token|authentication|credential/i.test(combined)) {
    return { category: status === null ? "provider_auth" : `provider_auth_${String(status)}`, http_status: status, source };
  }
  if (/MissingSessionID|missing[_ -]?session/i.test(combined)) {
    return { category: "provider_session_missing", http_status: status, source };
  }
  if (/model.{0,40}(?:not found|unavailable|unsupported)|no such model/i.test(combined)) {
    return { category: "provider_model_unavailable", http_status: status, source };
  }
  if (/quota|rate[_ -]?limit|free usage limit|insufficient[_ -]?balance/i.test(combined)) {
    return { category: "provider_quota", http_status: status, source };
  }
  if (status !== null && status >= 500) {
    return { category: `provider_server_${String(status)}`, http_status: status, source };
  }
  return null;
}


function outputRef(bytes: Uint8Array): SourceRef {
  return `blob://${hashBytes(bytes)}#bytes=0-${bytes.byteLength}` as SourceRef;
}

function remainingMs(clock: Clock, deadline: number): number {
  if (!Number.isSafeInteger(deadline)) return 0;
  return Math.max(0, deadline - clock.utcNowMs());
}

function parseCursor(value: string | undefined): number | null {
  if (value === undefined) return 0;
  const match = /^(\d+):\d+$/.exec(value);
  if (match === null) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : null;
}

export class CliGenerationAdapter {
  private readonly spec: CliGenerationSpec;
  private readonly executable: string;
  private readonly ports: GenerationBlobPorts;
  private readonly glueRoot: string | undefined;
  private readonly promptBuilder: NonNullable<CliGenerationAdapterOptions["prompt_builder"]>;
  private readonly clock: Clock;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly spawnProcess: NonNullable<CliGenerationAdapterOptions["spawn"]>;
  private readonly maxSnapshotBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly killGraceMs: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, CliSession>();
  private readonly idempotency = new Map<string, string>();
  private readonly backend: GenerationBackendRef;

  constructor(options: CliGenerationAdapterOptions) {
    this.spec = options.spec;
    this.executable = options.executable;
    this.ports = options.ports;
    this.glueRoot = options.glue_root;
    this.promptBuilder = options.prompt_builder ?? ((snapshotText) => buildCliGenerationPrompt(snapshotText));
    this.clock = options.clock ?? systemClock;
    this.env = options.env;
    this.spawnProcess =
      options.spawn ??
      ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams);
    this.maxSnapshotBytes = options.max_snapshot_bytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.maxBufferedBytes = Math.min(
      options.max_buffered_bytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      options.spec.max_output_bytes
    );
    this.killGraceMs = options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS;
    this.maxSessions = Math.max(1, options.max_sessions ?? DEFAULT_MAX_SESSIONS);
    this.backend = createCliGenerationBackend(options.spec, { executable: options.executable });
  }

  /** Named diagnosis for a failed run; `null` while healthy or unknown. */
  failure(handle_ref: string): CliGenerationFailure | null {
    const session = this.sessions.get(handle_ref);
    if (session === undefined || session.failure_code === null) return null;
    const stdoutText = new TextDecoder().decode(Uint8Array.from(session.output));
    const stderrText = new TextDecoder().decode(Uint8Array.from(session.stderr));
    return {
      code: session.failure_code,
      detail: session.failure_detail ?? session.failure_code,
      exit_code: session.exit_code,
      exit_signal: session.exit_signal,
      output_kind: session.output_kind,
      provider_error: diagnoseProviderError(stdoutText, stderrText),
      stderr_class: classifyStderr(stderrText),
      output: summarizeSession(session)
    };
  }

  /** Hash-only output summary, available for successful and failed handles. */
  outputSummary(handle_ref: string): CliOutputSummary | null {
    const session = this.sessions.get(handle_ref);
    return session === undefined ? null : summarizeSession(session);
  }

  /**
   * Bounded session retention. Terminal (closed) sessions are evicted first;
   * if every retained session is still open the oldest is stopped. Eviction
   * clears the accumulated stdout array and the idempotency alias.
   */
  private evictSessions(): void {
    if (this.sessions.size < this.maxSessions) return;
    let target: string | undefined;
    for (const [handle, session] of this.sessions) {
      if (session.closed) {
        target = handle;
        break;
      }
    }
    if (target === undefined) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) return;
      target = oldest.value;
    }
    this.dropSession(target);
  }

  private dropSession(handle: string): void {
    const session = this.sessions.get(handle);
    if (session === undefined) return;
    session.output.length = 0;
    if (!session.closed) {
      try {
        session.process.kill(this.spec.cancel_signal);
      } catch {
        // Best-effort cleanup; the close handler still marks the session.
      }
    }
    this.sessions.delete(handle);
    if (this.idempotency.get(session.idempotency_key) === handle) {
      this.idempotency.delete(session.idempotency_key);
    }
  }

  async selectBackend(
    req: GenerationBackendSelectRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<AdapterBackendSelection>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", descriptorRef(this.spec)));
    if (req.host_binding.host_id !== this.spec.host_id) {
      return adapterOk({ state: "blocked_no_backend", reason: "no_approved_backend", missing: [], evidence_refs: [] });
    }
    if (!req.approved_backend_ids.includes(this.spec.backend_id)) {
      return adapterOk({ state: "blocked_no_backend", reason: "no_approved_backend", missing: [], evidence_refs: [] });
    }
    if (this.spec.availability !== "available") {
      return adapterOk({
        state: "blocked_no_backend",
        reason: "capability_unsupported",
        missing: GENERATION_ACTIONS.map((action) => capability(this.spec, action)),
        evidence_refs: []
      });
    }
    return adapterOk({
      state: "available",
      backend: this.backend,
      evidence_refs: this.backend.isolation.evidence_refs
    });
  }

  async create(
    req: GenerationCreateRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationCreateResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", req.snapshot_ref));
    if (remainingMs(this.clock, req.deadline_ms) < 1) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", req.snapshot_ref, true));
    }
    if (req.backend.entry_kind !== "cli_spawn" || req.backend.backend_id !== this.spec.backend_id) {
      return adapterErr(this.error("E_CONFLICT", req.snapshot_ref));
    }
    if (!isAbsolute(req.workspace_ref)) return adapterErr(this.error("E_SCHEMA", req.snapshot_ref));
    if (this.spec.availability !== "available") {
      return adapterErr(this.error("E_UNSUPPORTED", req.snapshot_ref));
    }

    const previous = this.idempotency.get(req.idempotency_key);
    if (previous !== undefined) {
      const existing = this.sessions.get(previous);
      if (existing !== undefined) {
        return adapterOk({
          state: "created",
          handle_ref: existing.handle_ref,
          host_session_ref: existing.handle_ref,
          started_at: existing.started_at,
          isolation_evidence_refs: [...this.backend.isolation.evidence_refs]
        });
      }
    }

    const snapshot = await this.ports.readSource(req.snapshot_ref, { maxBytes: this.maxSnapshotBytes });
    if (!snapshot.ok) return adapterErr(this.error("E_EVIDENCE_UNKNOWN", req.snapshot_ref));
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", req.snapshot_ref));
    let snapshotText: string;
    try {
      snapshotText = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.value);
      JSON.parse(snapshotText);
    } catch {
      return adapterErr(this.error("E_SCHEMA", req.snapshot_ref));
    }

    const prompt = this.promptBuilder(snapshotText, req);
    let promptDir: string | null = null;
    let promptFile: string | null = null;
    if (this.spec.prompt_transport === "file") {
      try {
        promptDir = mkdtempSync(join(tmpdir(), "evoplug-cli-prompt-"));
        promptFile = join(promptDir, "prompt.txt");
        writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
      } catch {
        cleanupPromptDir(promptDir);
        return adapterErr(this.error("E_IO", req.snapshot_ref, true));
      }
    }
    const glue =
      this.spec.glue_script === undefined
        ? undefined
        : this.glueRoot === undefined
          ? null
          : join(this.glueRoot, this.spec.glue_script);
    if (glue === null) {
      cleanupPromptDir(promptDir);
      return adapterErr(this.error("E_CAPABILITY", req.snapshot_ref));
    }
    const replacements: Record<string, string> = {};
    if (this.spec.prompt_transport === "argv") replacements[PROMPT_PLACEHOLDER] = prompt;
    if (this.spec.prompt_transport === "file" && promptFile !== null) {
      replacements[PROMPT_FILE_PLACEHOLDER] = promptFile;
    }
    if (glue !== undefined) replacements[GLUE_PLACEHOLDER] = glue;
    const args = substitute(this.spec.argv_template, replacements);
    const environment = this.env === undefined ? undefined : { ...process.env, ...this.env };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.executable, args, {
        cwd: req.workspace_ref,
        env: environment,
        stdio: [this.spec.prompt_transport === "stdin" ? "pipe" : "ignore", "pipe", "pipe"]
      });
    } catch {
      cleanupPromptDir(promptDir);
      return adapterErr(this.error("E_IO", req.snapshot_ref, true));
    }

    const handle_ref = `cli-run:${randomUUID()}`;
    const session: CliSession = {
      handle_ref,
      process: child,
      idempotency_key: req.idempotency_key,
      output: [],
      extracted: null,
      stderr: [],
      output_kind: null,
      started_at: this.clock.utcNowMs(),
      poll: 0,
      closed: false,
      exit_code: null,
      exit_signal: null,
      spawn_error: null,
      cancel_requested: false,
      timed_out: false,
      overflow: false,
      deadline_timer: null,
      kill_timer: null,
      abort_cleanup: null,
      failure_code: null,
      failure_detail: null,
      prompt_dir: promptDir
    };

    if (this.spec.prompt_transport === "stdin" && child.stdin !== null) {
      child.stdin.on("error", () => {
        // A host that exits immediately closes the pipe; the exit code wins.
      });
      child.stdin.end(prompt, "utf8");
    }

    const append = (chunk: Buffer): void => {
      const remaining = this.maxBufferedBytes - session.output.length;
      if (remaining <= 0) {
        session.overflow = true;
        if (session.failure_code === null) {
          session.failure_code = "cli_output_overflow";
          session.failure_detail = `stdout exceeded ${String(this.maxBufferedBytes)} bytes`;
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // close remains authoritative.
        }
        return;
      }
      const bytes = new Uint8Array(chunk.subarray(0, remaining));
      for (const byte of bytes) session.output.push(byte);
      if (bytes.byteLength < chunk.byteLength) {
        session.overflow = true;
        if (session.failure_code === null) {
          session.failure_code = "cli_output_overflow";
          session.failure_detail = `stdout exceeded ${String(this.maxBufferedBytes)} bytes`;
        }
      }
    };
    const drain = (chunk: Buffer): void => {
      // stderr is diagnostic only and never becomes a candidate. Keep a
      // bounded copy so failures can be classified without persisting text.
      const remaining = MAX_STDERR_BYTES - session.stderr.length;
      if (remaining <= 0) return;
      for (const byte of chunk.subarray(0, remaining)) session.stderr.push(byte);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", drain);
    child.once("error", (error) => {
      session.spawn_error = error instanceof Error ? error : new Error(String(error));
      if (session.failure_code === null) {
        session.failure_code = "cli_spawn_failed";
        session.failure_detail = session.spawn_error.message;
      }
    });
    child.once("close", (code, signalName) => {
      session.closed = true;
      session.exit_code = code;
      session.exit_signal = signalName;
      if (session.deadline_timer !== null) clearTimeout(session.deadline_timer);
      if (session.kill_timer !== null) clearTimeout(session.kill_timer);
      session.abort_cleanup?.();
      session.abort_cleanup = null;
      cleanupPromptDir(session.prompt_dir);
      session.prompt_dir = null;
      if (session.failure_code === null) {
        if (session.timed_out) {
          session.failure_code = "cli_timeout";
          session.failure_detail = `exceeded ${String(this.spec.timeout_ms)} ms`;
        } else if (session.cancel_requested) {
          session.failure_code = "cli_aborted";
          session.failure_detail = "cancelled before completion";
        } else if (code !== 0 || signalName !== null) {
          session.failure_code = "cli_nonzero_exit";
          session.failure_detail = `exit=${String(code)} signal=${String(signalName)}`;
        }
      }
    });

    const terminate = (code: CliGenerationFailureCode, detail: string): void => {
      if (session.closed) return;
      if (code === "cli_timeout") session.timed_out = true;
      session.cancel_requested = true;
      if (session.failure_code === null) {
        session.failure_code = code;
        session.failure_detail = detail;
      }
      try {
        child.kill(this.spec.cancel_signal);
      } catch {
        // close remains authoritative.
      }
      session.kill_timer = setTimeout(() => {
        if (!session.closed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // close remains authoritative.
          }
        }
      }, this.killGraceMs);
    };
    const timeoutMs = Math.min(remainingMs(this.clock, req.deadline_ms), this.spec.timeout_ms);
    session.deadline_timer = setTimeout(
      () => terminate("cli_timeout", `exceeded ${String(timeoutMs)} ms`),
      Math.max(1, timeoutMs)
    );
    const onAbort = (): void => terminate("cli_aborted", "abort signal received");
    signal.addEventListener("abort", onAbort, { once: true });
    session.abort_cleanup = () => signal.removeEventListener("abort", onAbort);
    this.evictSessions();
    this.sessions.set(handle_ref, session);
    this.idempotency.set(req.idempotency_key, handle_ref);

    return adapterOk({
      state: "created",
      handle_ref,
      host_session_ref: handle_ref,
      started_at: session.started_at,
      isolation_evidence_refs: [...this.backend.isolation.evidence_refs]
    });
  }

  async authenticate(
    req: GenerationAuthRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationAuthResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", descriptorRef(this.spec)));
    const session = this.sessions.get(req.handle_ref);
    if (session === undefined) return adapterErr(this.error("E_CONFLICT", descriptorRef(this.spec)));
    if (remainingMs(this.clock, req.deadline_ms) < 1) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", descriptorRef(this.spec), true));
    }
    if (session.spawn_error !== null) {
      return adapterOk({
        state: "unavailable",
        mechanism: "cli_process_error",
        profile_ref: this.spec.backend_id,
        evidence_refs: []
      });
    }
    // Authentication belongs to the host CLI. Inheriting its environment is
    // the only observation the kernel may make; no credential is read here.
    return adapterOk({
      state: "available",
      mechanism: "cli_inherited_auth",
      profile_ref: `${this.spec.backend_id}:inherited`,
      evidence_refs: []
    });
  }

  async readOutput(
    req: GenerationOutputRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationOutputResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", descriptorRef(this.spec)));
    const session = this.sessions.get(req.handle_ref);
    if (session === undefined) return adapterErr(this.error("E_CONFLICT", descriptorRef(this.spec)));
    if (remainingMs(this.clock, req.deadline_ms) < 1) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", descriptorRef(this.spec), true));
    }
    if (!Number.isSafeInteger(req.max_bytes) || req.max_bytes <= 0) {
      return adapterErr(this.error("E_SCHEMA", descriptorRef(this.spec)));
    }
    const offset = parseCursor(req.cursor);
    if (offset === null || offset > session.output.length) {
      return adapterErr(this.error("E_SCHEMA", descriptorRef(this.spec)));
    }
    if (!session.closed && session.output.length <= offset) {
      await waitForProgress(session, offset, remainingMs(this.clock, req.deadline_ms), signal);
      if (signal.aborted) return adapterErr(this.error("E_CANCELLED", descriptorRef(this.spec)));
    }
    const bytes = Uint8Array.from(session.output);
    if (bytes.byteLength === 0) {
      if (!session.closed) {
        session.poll += 1;
        return adapterOk({
          state: "chunk",
          output_ref: descriptorRef(this.spec),
          schema_valid: "unknown",
          next_cursor: `0:${String(session.poll)}`
        });
      }
      if (session.failure_code === null) {
        session.failure_code = "cli_output_empty";
        session.failure_detail = "process produced no stdout";
      }
      return adapterOk({ state: "failed", output_ref: descriptorRef(this.spec), schema_valid: false });
    }
    if (bytes.byteLength > req.max_bytes || session.overflow) {
      session.output_kind = "raw_stdout";
      const stored = await this.ports.writeOutput(bytes);
      if (!stored.ok) return adapterErr(this.error("E_IO", descriptorRef(this.spec), true));
      if (session.failure_code === null) {
        session.failure_code = session.overflow ? "cli_output_overflow" : "cli_output_too_large";
        session.failure_detail = `stdout ${String(bytes.byteLength)} bytes > read cap ${String(req.max_bytes)}`;
      }
      return adapterOk({ state: "failed", output_ref: stored.value, schema_valid: false });
    }

    let text: string | null = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = null;
    }
    const parsed =
      text === null
        ? ({ status: "invalid", code: "cli_output_parse_error", detail: "stdout_not_utf8" } as const)
        : parseCliOutput(this.spec.output_protocol, text, this.spec.result_field, this.spec.output_extract);

    // A partial line while the process is still running is not a failure. The
    // buffer is re-parsed on the next poll and only a closed process with an
    // invalid/empty complete buffer is terminal.
    if (parsed.status === "invalid" || parsed.status === "empty") {
      if (!session.closed) {
        session.poll += 1;
        return adapterOk({
          state: "chunk",
          output_ref: descriptorRef(this.spec),
          schema_valid: false,
          next_cursor: `${String(bytes.byteLength)}:${String(session.poll)}`
        });
      }
      const stored = await this.ports.writeOutput(bytes);
      if (!stored.ok) return adapterErr(this.error("E_IO", descriptorRef(this.spec), true));
      session.output_kind = "raw_stdout";
      if (session.failure_code === null) {
        session.failure_code =
          parsed.status === "empty"
            ? "cli_output_empty"
            : parsed.code;
        session.failure_detail =
          parsed.status === "empty" ? "process produced no output" : parsed.detail;
      }
      return adapterOk({ state: "failed", output_ref: stored.value, schema_valid: false });
    }

    // json_result hosts and declared jsonl extractors wrap the model text in
    // an outer envelope. The output ref must contain the unwrapped payload,
    // because that is what the review static-check parser consumes as
    // rsi.generator_protocol/1 JSONL.
    const extractedProtocol =
      this.spec.output_protocol === "json_result" ||
      (this.spec.output_protocol === "jsonl" && this.spec.output_extract !== undefined);
    let protocolText: string | null = null;
    if (extractedProtocol && typeof parsed.value === "string") {
      protocolText = parsed.value;
      if (
        this.spec.output_normalization?.final_newline === "ensure" &&
        !protocolText.endsWith("\n")
      ) {
        protocolText += "\n";
      }
    }
    const outputBytes = extractedProtocol
      ? (protocolText === null ? null : new TextEncoder().encode(protocolText))
      : bytes;
    if (outputBytes === null) {
      session.output_kind = "raw_stdout";
      const stored = await this.ports.writeOutput(bytes);
      if (!stored.ok) return adapterErr(this.error("E_IO", descriptorRef(this.spec), true));
      if (session.failure_code === null) {
        session.failure_code = "cli_output_parse_error";
        session.failure_detail = "result_not_text";
      }
      return adapterOk({ state: "failed", output_ref: stored.value, schema_valid: false });
    }
    const outputText = new TextDecoder("utf-8", { fatal: true }).decode(outputBytes);
    const schemaValid = extractedProtocol
      ? parseCliOutput("jsonl", outputText).status === "complete"
      : parsed.status === "complete";
    const stored = await this.ports.writeOutput(outputBytes);
    if (!stored.ok) return adapterErr(this.error("E_IO", descriptorRef(this.spec), true));
    if (!isSourceRef(stored.value)) return adapterErr(this.error("E_SCHEMA", descriptorRef(this.spec)));
    const parsedRef = parseSourceRef(stored.value);
    if (!parsedRef.ok || parsedRef.value.scheme !== "blob" || parsedRef.value.locator !== hashBytes(outputBytes)) {
      return adapterErr(this.error("E_CONFLICT", stored.value));
    }
    session.output_kind = "extracted";
    session.extracted = Array.from(outputBytes);
    if (!schemaValid && session.closed && session.failure_code === null) {
      session.failure_code = "cli_output_parse_error";
      session.failure_detail = "result_not_generator_protocol";
    }
    if (!session.closed) {
      session.poll += 1;
      return adapterOk({
        state: "chunk",
        output_ref: stored.value,
        schema_valid: schemaValid,
        next_cursor: `${String(bytes.byteLength)}:${String(session.poll)}`
      });
    }
    const exitOk =
      session.exit_code === 0 && session.exit_signal === null && !session.cancel_requested && !session.timed_out;
    return adapterOk({
      state: exitOk && schemaValid ? "complete" : "failed",
      output_ref: stored.value,
      schema_valid: schemaValid
    });
  }

  async cancel(
    req: GenerationCancelRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationCancelResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", descriptorRef(this.spec)));
    const session = this.sessions.get(req.handle_ref);
    if (session === undefined) return adapterOk({ state: "unsupported", evidence_refs: [] });
    if (remainingMs(this.clock, req.deadline_ms) < 1) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", descriptorRef(this.spec), true));
    }
    if (session.closed) return adapterOk({ state: "not_running", evidence_refs: [] });
    session.cancel_requested = true;
    if (session.failure_code === null) {
      session.failure_code = "cli_aborted";
      session.failure_detail = `cancel requested: ${req.reason}`;
    }
    try {
      if (!session.process.kill(this.spec.cancel_signal)) {
        return adapterOk({ state: "unknown", evidence_refs: [] });
      }
    } catch {
      return adapterOk({ state: "unknown", evidence_refs: [] });
    }
    session.kill_timer = setTimeout(() => {
      if (!session.closed) {
        try {
          session.process.kill("SIGKILL");
        } catch {
          // close remains authoritative.
        }
      }
    }, this.killGraceMs);
    return adapterOk({ state: "cancelled", evidence_refs: [] });
  }

  async recover(
    _req: GenerationRecoverRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationRecoverResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", descriptorRef(this.spec)));
    return adapterOk({ state: "not_recoverable", evidence_refs: [] });
  }

  private error(
    code: "E_DEADLINE_EXCEEDED" | "E_CAPABILITY" | "E_UNSUPPORTED" | "E_CONFLICT" | "E_SCHEMA" | "E_IO" | "E_CANCELLED" | "E_EVIDENCE_UNKNOWN",
    detail_ref: SourceRef,
    retryable = false
  ): HostAdapterError {
    return makeAdapterError(code, detail_ref, this.clock.utcNowMs(), retryable);
  }
}

/** The synthetic ref used before any stdout byte exists. */
function descriptorRef(spec: CliGenerationSpec): SourceRef {
  return `blob://sha256:${"0".repeat(64)}#bytes=0-0` as SourceRef;
}

function makeAdapterError(
  code: "E_DEADLINE_EXCEEDED" | "E_CAPABILITY" | "E_UNSUPPORTED" | "E_CONFLICT" | "E_SCHEMA" | "E_IO" | "E_CANCELLED" | "E_EVIDENCE_UNKNOWN",
  detail_ref: SourceRef,
  observed_at: number,
  retryable: boolean
): HostAdapterError {
  return { code, retryable, detail_ref, observed_at };
}

function cleanupPromptDir(directory: string | null): void {
  if (directory === null) return;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Prompt files are single-use; a failed cleanup is not a run failure.
  }
}

async function waitForProgress(
  session: CliSession,
  offset: number,
  remaining: number,
  signal: AbortSignal
): Promise<void> {
  if (session.closed || session.output.length > offset || remaining <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(done, Math.max(1, remaining));
    const finish = (): void => {
      session.process.stdout.off("data", onData);
      session.process.stderr.off("data", onData);
      session.process.off("close", onClose);
      session.process.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    function done(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
      resolve();
    }
    function onData(): void {
      if (session.output.length > offset) done();
    }
    function onClose(): void {
      done();
    }
    function onError(): void {
      done();
    }
    function onAbort(): void {
      done();
    }
    session.process.stdout.on("data", onData);
    session.process.stderr.on("data", onData);
    session.process.once("close", onClose);
    session.process.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Creates the generic adapter for one declared spec. */
export function createCliGenerationAdapter(options: CliGenerationAdapterOptions): CliGenerationAdapter {
  return new CliGenerationAdapter(options);
}

/** Resolves the entry path for a declared spec without host-specific logic. */
export function resolveCliExecutable(input: {
  readonly spec: CliGenerationSpec;
  readonly explicit?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly is_executable: (path: string) => boolean;
  readonly path_entries: readonly string[];
}): string | null {
  if (input.explicit !== undefined) {
    return input.explicit.length > 0 && isAbsolute(input.explicit) && input.is_executable(input.explicit)
      ? input.explicit
      : null;
  }
  if (input.spec.executable_env !== undefined) {
    const configured = (input.env ?? process.env)[input.spec.executable_env];
    if (configured !== undefined && configured.length > 0) {
      return isAbsolute(configured) && input.is_executable(configured) ? configured : null;
    }
  }
  for (const directory of input.path_entries) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, input.spec.binary_name);
    if (input.is_executable(candidate)) return candidate;
  }
  return null;
}

/** Hash helper shared by composition drift checks. */
export function cliExecutableHash(bytes: Uint8Array): Hash {
  return hashBytes(bytes);
}
