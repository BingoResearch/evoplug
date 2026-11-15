/**
 * GeneratorBackend input contract and strict JSONL output parser
 * (DD-REV-040, -041, -042).
 *
 * Limits are checked on raw bytes before decoding. Every failure returns the
 * single code of the first gate that fires.
 */

import {
  canonicalJson,
  compareUtf8,
  hashBytes,
  toJsonValue
} from "@evoplug/core";
import type { Hash, JsonValue, Result, SourceRef } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ErrorEnvelope } from "@evoplug/core";

import {
  credentialLeak,
  egressNotApproved,
  inputPath,
  inputTooLarge,
  outputLineTooLarge,
  outputParseError,
  outputReadMismatch,
  outputTooLarge,
  outputTooManyLines,
  revError,
  schemaError
} from "./errors.js";
import { parseStrictJson } from "./json-strict.js";
import {
  REVIEW_DIFF_MAX_BYTES,
  REVIEW_EXPERIENCE_BODY_MAX_BYTES
} from "./snapshot.js";
import type { ReviewSnapshot } from "./types.js";

export const GENERATOR_PROTOCOL_VERSION = "rsi.generator_protocol/1" as const;
export const GENERATOR_OUTPUT_SCHEMA_VERSION = "rsi.generator_output/1" as const;
export const GENERATOR_MANIFEST_MAX_BYTES = 524_288 as const;
export const GENERATOR_EVIDENCE_MAX_BYTES = 16_777_216 as const;
export const GENERATOR_DIAGNOSTIC_MAX_BYTES = 65_536 as const;

export interface GeneratorInputEvidence {
  evidence_id: string;
  kind: "requirement" | "issue" | "correction" | "verification" | "artifact" | "outcome";
  source_ref: SourceRef;
  content_hash: Hash;
  path: string;
  bytes: number;
}

export interface GeneratorInputExperience {
  experience_ref: SourceRef;
  experience_id: string;
  version: number;
  content_hash: Hash;
  path: string;
}

export interface GeneratorInput {
  schema_version: "rsi.generator_input/1";
  job_id: string;
  attempt_id: string;
  snapshot_id: string;
  snapshot_hash: Hash;
  protocol_version: "rsi.generator_protocol/1";
  instructions_version: string;
  output_schema_version: "rsi.generator_output/1";
  budget: {
    input_tokens_estimated: number;
    output_tokens_reserved: number;
    max_wall_ms: number;
    deadline_at: number;
    max_proposals: number;
    output_policy_hash: Hash;
  };
  evidence: GeneratorInputEvidence[];
  existing_experiences: GeneratorInputExperience[];
  target_policy: {
    allowed_object_types: Array<"skill" | "memory" | "instructions">;
    allowed_target_refs: string[];
    protected_fields: string[];
  };
  data_policy_ref: string;
}

export interface GeneratorInputManifestCheck {
  manifest_bytes: number;
  evidence_bytes: number;
  manifest_hash: Hash;
}

export interface GeneratorInputCheckInput {
  input: GeneratorInput;
  snapshot: ReviewSnapshot;
  approved_evidence_refs: readonly SourceRef[];
  approved_experience_refs: readonly SourceRef[];
  evidence_bytes: ReadonlyMap<SourceRef, number>;
  manifest_bytes: number;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidInputPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\u0000")) {
    return false;
  }
  const segments = path.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return false;
  }
  return path.startsWith("input/evidence/") || path.startsWith("input/experiences/");
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|cookie)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/
];

export function containsCredentialMaterial(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** First physical line containing credential material; 1-based. */
function credentialLine(text: string): number {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (containsCredentialMaterial(lines[index] ?? "")) {
      return index + 1;
    }
  }
  return 1;
}

export interface GeneratorBodyPart {
  path: string;
  source_ref: SourceRef;
  bytes: number;
  content: Uint8Array;
}

export interface GeneratorBody {
  schema_version: "rsi.generator_body/1";
  manifest_hash: Hash;
  manifest_bytes: number;
  parts: GeneratorBodyPart[];
  total_bytes: number;
}

export interface MaterializeGeneratorBodyInput {
  input: GeneratorInput;
  approved_evidence_refs: readonly SourceRef[];
  approved_experience_refs: readonly SourceRef[];
  readSource(ref: SourceRef): Result<Uint8Array, ErrorEnvelope>;
  max_bytes?: number;
}

/**
 * Materializes the generator body (manifest + approved source bytes) before
 * any backend `create`. Only refs approved for egress are read; the manifest
 * is hashed over its JCS bytes and the body is bounded by the same 16 MiB
 * evidence limit as the manifest check.
 */
export function materializeGeneratorBody(
  input: MaterializeGeneratorBodyInput
): Result<GeneratorBody, ErrorEnvelope> {
  const approvedEvidence = new Set(input.approved_evidence_refs);
  const approvedExperience = new Set(input.approved_experience_refs);
  const maxBytes = input.max_bytes ?? GENERATOR_EVIDENCE_MAX_BYTES;
  const parts: GeneratorBodyPart[] = [];
  let totalBytes = 0;
  const ordered = sortGeneratorEvidence(input.input.evidence);
  for (const entry of ordered) {
    if (!approvedEvidence.has(entry.source_ref) || !isValidInputPath(entry.path)) {
      return err(egressNotApproved({ policyVersion: "egress/default", refs: [entry.source_ref] }));
    }
    const bytes = input.readSource(entry.source_ref);
    if (!bytes.ok) {
      return err(bytes.error);
    }
    totalBytes += bytes.value.byteLength;
    if (totalBytes > maxBytes) {
      return err(inputTooLarge(entry.source_ref));
    }
    parts.push({
      path: entry.path,
      source_ref: entry.source_ref,
      bytes: bytes.value.byteLength,
      content: bytes.value
    });
  }
  for (const entry of input.input.existing_experiences) {
    if (!approvedExperience.has(entry.experience_ref) || !isValidInputPath(entry.path)) {
      return err(egressNotApproved({ policyVersion: "egress/default", refs: [entry.experience_ref] }));
    }
    const bytes = input.readSource(entry.experience_ref);
    if (!bytes.ok) {
      return err(bytes.error);
    }
    totalBytes += bytes.value.byteLength;
    if (totalBytes > maxBytes) {
      return err(inputTooLarge(entry.experience_ref));
    }
    parts.push({
      path: entry.path,
      source_ref: entry.experience_ref,
      bytes: bytes.value.byteLength,
      content: bytes.value
    });
  }
  return ok({
    schema_version: "rsi.generator_body/1",
    manifest_hash: generatorInputManifestHash(input.input),
    manifest_bytes: generatorInputManifestBytes(input.input),
    parts,
    total_bytes: totalBytes
  });
}

export function generatorInputManifestBytes(input: GeneratorInput): number {
  return canonicalJson(toJsonValue({ ...input })).byteLength;
}

export function generatorInputManifestHash(input: GeneratorInput): Hash {
  return hashBytes(canonicalJson(toJsonValue({ ...input })));
}

/** DD-REV-040 input constraints, in declaration order. */
export function validateGeneratorInput(input: GeneratorInputCheckInput): Result<GeneratorInputManifestCheck, ErrorEnvelope> {
  if (input.manifest_bytes > GENERATOR_MANIFEST_MAX_BYTES) {
    return err(inputTooLarge(`manifest#bytes=0-${input.manifest_bytes}`));
  }
  const approvedEvidence = new Set(input.approved_evidence_refs);
  const approvedExperience = new Set(input.approved_experience_refs);

  let evidenceBytes = 0;
  for (const entry of input.input.evidence) {
    if (!isValidInputPath(entry.path) || !entry.path.startsWith("input/evidence/")) {
      return err(inputPath(entry.path, "evidence_path"));
    }
    if (!approvedEvidence.has(entry.source_ref)) {
      return err(egressNotApproved({ policyVersion: "egress/default", refs: [entry.source_ref] }));
    }
    const bytes = input.evidence_bytes.get(entry.source_ref) ?? entry.bytes;
    evidenceBytes += bytes;
    if (evidenceBytes > GENERATOR_EVIDENCE_MAX_BYTES) {
      return err(inputTooLarge(entry.source_ref));
    }
  }
  if (evidenceBytes > GENERATOR_EVIDENCE_MAX_BYTES) {
    return err(inputTooLarge(`evidence#bytes=0-${evidenceBytes}`));
  }

  const candidateOrder = input.snapshot.experience_candidates
    .filter((candidate) => approvedExperience.has(candidate.source_ref))
    .map((candidate) => candidate.source_ref);
  const projected = input.input.existing_experiences.map((entry) => entry.experience_ref);
  if (projected.length !== candidateOrder.length) {
    return err(schemaError("input.existing_experiences", "candidate_projection"));
  }
  for (let index = 0; index < projected.length; index += 1) {
    if (projected[index] !== candidateOrder[index]) {
      return err(schemaError("input.existing_experiences", "candidate_order"));
    }
    const candidate = input.snapshot.experience_candidates.find(
      (item) => item.source_ref === projected[index]
    );
    const entry = input.input.existing_experiences[index];
    if (candidate === undefined || entry === undefined) {
      return err(schemaError("input.existing_experiences", "candidate_projection"));
    }
    if (
      entry.experience_id !== candidate.experience_id ||
      entry.version !== candidate.version ||
      entry.content_hash !== candidate.content_hash
    ) {
      return err(schemaError("input.existing_experiences", "frozen_candidate"));
    }
    if (!isValidInputPath(entry.path) || !entry.path.startsWith("input/experiences/")) {
      return err(inputPath(entry.path, "experience_path"));
    }
  }

  const serialized = JSON.stringify(toJsonValue({ ...input.input }));
  if (containsCredentialMaterial(serialized)) {
    // Never echo the matched text; only the redacted manifest line.
    return err(credentialLeak("manifest", credentialLine(serialized)));
  }

  return ok({
    manifest_bytes: input.manifest_bytes,
    evidence_bytes: evidenceBytes,
    manifest_hash: generatorInputManifestHash(input.input)
  });
}

/* ------------------------------------------------------------------ */
/* Output parser                                                       */
/* ------------------------------------------------------------------ */

export type GeneratorTerminalEvent =
  | {
      type: "completed";
      proposal_count: number;
      usage?: { input_tokens?: number; output_tokens?: number; cost_micros?: number };
    }
  | { type: "failed"; error_code: string; message: string }
  | { type: "cancelled"; reason?: string };

export interface GeneratorStartedEvent {
  type: "started";
  attempt_id: string;
  protocol_version: "rsi.generator_protocol/1";
  model_id: string;
}

export interface GeneratorProposalEvent {
  type: "proposal";
  ordinal: number;
  proposal: JsonValue;
}

export interface GeneratorProgressEvent {
  type: "progress";
  completed_steps: number;
  total_steps: number;
}

export type GeneratorEvent =
  | GeneratorStartedEvent
  | GeneratorProposalEvent
  | GeneratorProgressEvent
  | GeneratorTerminalEvent;

export interface ParsedGeneratorOutput {
  bytes: number;
  hash: Hash;
  lines: number;
  started: GeneratorStartedEvent;
  proposals: GeneratorProposalEvent[];
  progress_count: number;
  terminal: GeneratorTerminalEvent;
  events: GeneratorEvent[];
}

export interface GeneratorOutputPolicyLimits {
  max_proposals: number;
  max_progress_events: number;
  max_output_bytes: number;
  max_output_line_bytes: number;
  max_output_lines: number;
}

export type Utf8Result<T> = { ok: true; value: T } | { ok: false; error: "bad_utf8" };

export function decodeUtf8Strict(bytes: Uint8Array): Utf8Result<string> {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, error: "bad_utf8" };
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    return { ok: true, value: decoder.decode(bytes) };
  } catch {
    return { ok: false, error: "bad_utf8" };
  }
}

interface RawLine {
  text: string;
  bytes: number;
}

function splitPhysicalLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function asObject(value: JsonValue): { [key: string]: JsonValue } | null {
  return isRecord(value) ? value : null;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function proposalOrdinal(proposal: JsonValue): number | null {
  const object = asObject(proposal);
  if (object === null) {
    return null;
  }
  return asNumber(object["ordinal"]);
}

function proposalDiffBytes(proposal: JsonValue): number | null {
  const object = asObject(proposal);
  if (object === null) {
    return null;
  }
  const diff = asString(object["diff_text"]);
  return diff === null ? null : utf8Length(diff);
}

function proposalExperienceBytes(proposal: JsonValue): number | null {
  const object = asObject(proposal);
  if (object === null) {
    return null;
  }
  const experience = object["experience"];
  if (experience === undefined) {
    return null;
  }
  try {
    return canonicalJson(toJsonValue(experience)).byteLength;
  } catch {
    return null;
  }
}

function detectTerminal(event: { [key: string]: JsonValue }): GeneratorTerminalEvent | null {
  const type = asString(event["type"]);
  switch (type) {
    case "completed": {
      const count = asNumber(event["proposal_count"]);
      if (count === null) {
        return null;
      }
      const usageValue = event["usage"];
      if (usageValue === undefined) {
        return { type: "completed", proposal_count: count };
      }
      const usageObject = asObject(usageValue);
      if (usageObject === null) {
        return { type: "completed", proposal_count: count };
      }
      const usage: { input_tokens?: number; output_tokens?: number; cost_micros?: number } = {};
      const input = asNumber(usageObject["input_tokens"]);
      const output = asNumber(usageObject["output_tokens"]);
      const cost = asNumber(usageObject["cost_micros"]);
      if (input !== null) usage.input_tokens = input;
      if (output !== null) usage.output_tokens = output;
      if (cost !== null) usage.cost_micros = cost;
      return { type: "completed", proposal_count: count, usage };
    }
    case "failed": {
      const code = asString(event["error_code"]);
      const message = asString(event["message"]);
      if (code === null || message === null) {
        return null;
      }
      return { type: "failed", error_code: code, message };
    }
    case "cancelled": {
      const reason = asString(event["reason"]);
      return reason === null ? { type: "cancelled" } : { type: "cancelled", reason };
    }
    default:
      return null;
  }
}

function isTerminalType(type: string | null): boolean {
  return type === "completed" || type === "failed" || type === "cancelled";
}

/**
 * Strict parser. The order is fixed: raw limits, UTF-8, per-line JSON,
 * started, event inventory, per-candidate sizes, ordinals, terminal,
 * count, failed/cancelled.
 */
export function parseGeneratorOutput(
  bytes: Uint8Array,
  policy: GeneratorOutputPolicyLimits,
  attemptId: string
): Result<ParsedGeneratorOutput, ErrorEnvelope> {
  if (bytes.byteLength > policy.max_output_bytes) {
    return err(outputTooLarge(`output#bytes=0-${bytes.byteLength}`));
  }

  let lineCount = 0;
  let lineStart = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) {
      const length = index - lineStart;
      if (length > policy.max_output_line_bytes) {
        return err(outputLineTooLarge(`output#line=${lineCount + 1}`));
      }
      lineCount += 1;
      lineStart = index + 1;
    }
  }
  if (lineStart < bytes.byteLength) {
    const length = bytes.byteLength - lineStart;
    if (length > policy.max_output_line_bytes) {
      return err(outputLineTooLarge(`output#line=${lineCount + 1}`));
    }
    lineCount += 1;
  }
  if (lineCount > policy.max_output_lines) {
    return err(outputTooManyLines(`output#lines=${lineCount}`));
  }

  const decoded = decodeUtf8Strict(bytes);
  if (!decoded.ok) {
    return err(outputParseError("E_REVIEW_OUTPUT_BAD_UTF8", "output", "utf8"));
  }
  const text = decoded.value;
  const physical = splitPhysicalLines(text);
  const rawLines: RawLine[] = physical.map((line) => ({ text: line, bytes: utf8Length(line) }));

  const parsed: JsonValue[] = [];
  for (const line of rawLines) {
    if (line.text.length === 0) {
      return err(outputParseError("E_REVIEW_OUTPUT_BAD_JSON", "output", "empty_line"));
    }
    const json = parseStrictJson(line.text);
    if (!json.ok) {
      return err(outputParseError("E_REVIEW_OUTPUT_BAD_JSON", "output", json.error.kind));
    }
    parsed.push(json.value);
  }

  if (parsed.length === 0) {
    return err(outputParseError("E_REVIEW_OUTPUT_START", "output[0]", "started"));
  }

  const first = asObject(parsed[0] ?? null);
  if (first === null || asString(first["type"]) !== "started") {
    return err(outputParseError("E_REVIEW_OUTPUT_START", "output[0]", "started"));
  }
  if (asString(first["attempt_id"]) !== attemptId) {
    return err(outputParseError("E_REVIEW_OUTPUT_START", "output[0].attempt_id", "attempt_id"));
  }
  if (asString(first["protocol_version"]) !== GENERATOR_PROTOCOL_VERSION) {
    return err(outputParseError("E_REVIEW_OUTPUT_START", "output[0].protocol_version", "protocol_version"));
  }
  const modelId = asString(first["model_id"]);
  if (modelId === null) {
    return err(outputParseError("E_REVIEW_OUTPUT_START", "output[0].model_id", "string"));
  }
  const started: GeneratorStartedEvent = {
    type: "started",
    attempt_id: attemptId,
    protocol_version: GENERATOR_PROTOCOL_VERSION,
    model_id: modelId
  };

  const events: GeneratorEvent[] = [started];
  const proposals: GeneratorProposalEvent[] = [];
  let progressCount = 0;
  let terminalCount = 0;
  const terminalIndexes: number[] = [];
  let terminal: GeneratorTerminalEvent | null = null;

  for (let index = 1; index < parsed.length; index += 1) {
    const object = asObject(parsed[index] ?? null);
    if (object === null) {
      return err(outputParseError("E_REVIEW_OUTPUT_BAD_JSON", `output[${index}]`, "object"));
    }
    const type = asString(object["type"]);
    if (isTerminalType(type)) {
      terminalCount += 1;
      terminalIndexes.push(index);
      const detected = detectTerminal(object);
      if (detected === null) {
        return err(outputParseError("E_REVIEW_OUTPUT_BAD_JSON", `output[${index}]`, "terminal_shape"));
      }
      if (terminal === null) {
        terminal = detected;
      }
      continue;
    }
    switch (type) {
      case "proposal": {
        const ordinal = proposalOrdinal(object["proposal"] ?? null);
        const proposal = object["proposal"];
        if (ordinal === null || proposal === undefined) {
          return err(outputParseError("E_REVIEW_OUTPUT_BAD_JSON", `output[${index}].proposal`, "ordinal"));
        }
        proposals.push({ type: "proposal", ordinal, proposal });
        if (proposals.length > policy.max_proposals) {
          return err(
            outputParseError("E_REVIEW_OUTPUT_TOO_MANY_PROPOSALS", "output", "max_proposals")
          );
        }
        break;
      }
      case "progress": {
        const completed = asNumber(object["completed_steps"]);
        const total = asNumber(object["total_steps"]);
        if (completed === null || total === null) {
          return err(outputParseError("E_REVIEW_OUTPUT_BAD_JSON", `output[${index}]`, "progress_shape"));
        }
        progressCount += 1;
        if (progressCount > policy.max_progress_events) {
          return err(
            outputParseError("E_REVIEW_OUTPUT_TOO_MANY_PROGRESS", "output", "max_progress_events")
          );
        }
        events.push({ type: "progress", completed_steps: completed, total_steps: total });
        break;
      }
      case null:
        return err(outputParseError("E_REVIEW_OUTPUT_UNKNOWN_EVENT", `output[${index}]`, "type"));
      default:
        return err(outputParseError("E_REVIEW_OUTPUT_UNKNOWN_EVENT", `output[${index}]`, type));
    }
  }

  for (const event of proposals) {
    const diffBytes = proposalDiffBytes(event.proposal);
    if (diffBytes !== null && diffBytes > REVIEW_DIFF_MAX_BYTES) {
      return err(revError({ code: "E_PROPOSAL_DIFF_TOO_LARGE", details: { kind: "source", source_ref: "proposal.diff_text", reason: "too_large" } }));
    }
    const experienceBytes = proposalExperienceBytes(event.proposal);
    if (experienceBytes !== null && experienceBytes > REVIEW_EXPERIENCE_BODY_MAX_BYTES) {
      return err(revError({ code: "E_EXPERIENCE_TOO_LARGE", details: { kind: "source", source_ref: "proposal.experience", reason: "too_large" } }));
    }
  }

  for (let index = 0; index < proposals.length; index += 1) {
    const entry = proposals[index];
    if (entry === undefined) {
      continue;
    }
    if (entry.ordinal !== index + 1) {
      const duplicate = proposals.slice(0, index).some((item) => item.ordinal === entry.ordinal);
      return err(
        outputParseError(
          duplicate ? "E_REVIEW_OUTPUT_DUPLICATE_ORDINAL" : "E_REVIEW_OUTPUT_ORDINAL_GAP",
          `output.proposal[${index}].ordinal`,
          String(entry.ordinal)
        )
      );
    }
  }

  if (!text.endsWith("\n")) {
    return err(outputParseError("E_REVIEW_OUTPUT_TRUNCATED", "output", "final_lf"));
  }
  if (terminalCount === 0 || terminal === null) {
    return err(outputParseError("E_REVIEW_OUTPUT_TRUNCATED", "output", "terminal"));
  }
  if (terminalCount > 1) {
    return err(outputParseError("E_REVIEW_OUTPUT_MULTIPLE_TERMINAL", "output", "terminal"));
  }
  const terminalIndex = terminalIndexes[0];
  if (terminalIndex === undefined || terminalIndex !== parsed.length - 1) {
    return err(outputParseError("E_REVIEW_OUTPUT_AFTER_TERMINAL", "output", "terminal_last"));
  }
  if (terminal.type === "completed" && terminal.proposal_count !== proposals.length) {
    return err(
      outputParseError("E_REVIEW_OUTPUT_COUNT_MISMATCH", "output.completed.proposal_count", String(terminal.proposal_count))
    );
  }

  events.push(...proposals);
  events.push(terminal);

  return ok({
    bytes: bytes.byteLength,
    hash: hashBytes(bytes),
    lines: lineCount,
    started,
    proposals,
    progress_count: progressCount,
    terminal,
    events
  });
}

/** `readOutput` and direct file reads must agree on the hash. */
export function verifyOutputRead(
  fileHash: Hash,
  readOutputHash: Hash
): Result<Hash, ErrorEnvelope> {
  if (fileHash !== readOutputHash) {
    return err(outputReadMismatch(fileHash, readOutputHash));
  }
  return ok(fileHash);
}

/** stdout/stderr are diagnostics only, capped at 64 KiB each. */
export function truncateDiagnostic(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength <= GENERATOR_DIAGNOSTIC_MAX_BYTES
    ? bytes
    : bytes.slice(0, GENERATOR_DIAGNOSTIC_MAX_BYTES);
}

/** Sorts evidence entries by path so the manifest is deterministic. */
export function sortGeneratorEvidence(
  evidence: readonly GeneratorInputEvidence[]
): GeneratorInputEvidence[] {
  return [...evidence].sort((left, right) => compareUtf8(left.path, right.path));
}
