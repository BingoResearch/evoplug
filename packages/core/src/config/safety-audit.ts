/**
 * The concrete FND safety audit port (DD-CFG-090.1, DD-FND-095).
 *
 * CFG's `recordObservation` closes a sample by asking this port whether the
 * sample touched a forbidden field, a forbidden path, a protected subtree or
 * the root itself. The port answers from the durable audit trail only: the
 * FND `config_write_intent`/`config_write_result` rows and the CFG attempt
 * rows. It never re-reads the live tree and never decides whether a write may
 * happen — that is the writer's job.
 *
 * An incomplete audit is `unknown`, never zero. When the trail cannot be read
 * completely the port reports the missing sources and CFG maps the result to
 * the single `E_CFG_GUARDRAIL_UNKNOWN` code.
 */

import { canonicalHash } from "../hash.js";
import { canonicalJsonText } from "../canonical.js";
import type { ErrorEnvelope, Id, JsonValue, Result, SourceRef } from "../index.js";
import { err, ok } from "../result.js";
import { makeErrorEnvelope } from "../errors.js";
import type {
  SafetyAuditEvent,
  SafetyAuditEventKind,
  SafetyAuditMissingSource,
  SafetyAuditReasonCode,
  SafetyAuditRequest,
  SafetyAuditResult,
  SafetyAuditPort
} from "../ports/config-write.js";

import { mapSafetyAuditError } from "./errors.js";
import { isRecord as sharedIsRecord } from "../json.js";

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return sharedIsRecord(value);
}

/**
 * The audit port reports failures with the shared `ErrorEnvelope`, while CFG
 * maps them onto its own single `E_CFG_GUARDRAIL_UNKNOWN` code.
 */
function auditFailure(code: string): ErrorEnvelope {
  const mapped = mapSafetyAuditError(code);
  return makeErrorEnvelope({
    code: mapped.code,
    category: "policy",
    retryable: mapped.retryable,
    message_key: mapped.message_key,
    stage: "core.config.safety_audit",
    details: { kind: "none" }
  });
}

const SAFETY_AUDIT_REQUEST_SCHEMA_VERSION = "rsi.safety_audit_request/1";
const SAFETY_AUDIT_RESULT_SCHEMA_VERSION = "rsi.safety_audit_result/1";

/** The read-only view the port needs from the durable audit trail. */
interface SafetyAuditSource {
  /** The FND config-write intents that belong to the audited trial. */
  readonly configWriteIntents: readonly SafetyAuditConfigWriteIntent[];
  /** The FND config-write results that belong to the audited trial. */
  readonly configWriteResults: readonly SafetyAuditConfigWriteResult[];
  /** The CFG attempt rows that belong to the audited trial. */
  readonly cfgAttempts: readonly SafetyAuditCfgAttempt[];
}

/** One `config_write_intent` row the audit reads. */
interface SafetyAuditConfigWriteIntent {
  readonly config_write_id: string;
  readonly candidate_id: string;
  readonly target_path: string;
  readonly auth_decision_json: string;
  readonly protected_subtree_proof_json: string;
  readonly created_at: number;
}

/** One `config_write_result` row the audit reads. */
interface SafetyAuditConfigWriteResult {
  readonly config_write_id: string;
  readonly attempt: number;
  readonly candidate_id: string;
  readonly state: string;
  readonly path: string;
  readonly error_code: string | null;
  readonly completed_at: number;
}

/** One `cfg_attempt` row the audit reads. */
interface SafetyAuditCfgAttempt {
  readonly trial_id: string;
  readonly sequence: number;
  readonly attempt_json: string;
  readonly started_at: number;
  readonly finished_at: number | null;
}

interface FndSafetyAuditPortOptions {
  /** Reads the durable audit trail for one request. */
  readonly readSources: (input: SafetyAuditRequest) => SafetyAuditSource;
  /** Freezes the audit evidence bytes and returns their reference. */
  readonly freezeEvidence: (bytes: Uint8Array) => SourceRef;
  readonly now?: () => number;
}

interface ParsedDecision {
  readonly forbidden: boolean;
  readonly kind: SafetyAuditEventKind | null;
  readonly reason_code: SafetyAuditReasonCode | null;
  readonly field_ids: readonly Id<"fld">[];
}

function parseJson(text: string): JsonValue | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed as JsonValue;
  } catch {
    return null;
  }
}

/**
 * Reads the forbidden-field decision the writer froze into the intent.
 *
 * The decision is the writer's own verdict; the audit only classifies it.
 */
function readDecision(intent: SafetyAuditConfigWriteIntent): ParsedDecision {
  const parsed = parseJson(intent.auth_decision_json);
  const record = isRecord(parsed) ? parsed : null;
  const denied = record === null ? false : record["allowed"] === false || record["denied"] === true;
  const reasonCode = record === null ? null : record["reason_code"];
  const fieldIds = record === null ? [] : record["field_ids"];
  const fields = Array.isArray(fieldIds)
    ? fieldIds.filter((value): value is string => typeof value === "string").sort()
    : [];
  if (!denied) {
    return { forbidden: false, kind: null, reason_code: null, field_ids: [] };
  }
  const kind: SafetyAuditEventKind =
    reasonCode === "forbidden_path" ? "forbidden_path_attempt" : "forbidden_field_attempt";
  return {
    forbidden: true,
    kind,
    reason_code: reasonCode === "forbidden_path" ? "forbidden_class" : "deny_rule",
    field_ids: fields as Id<"fld">[]
  };
}

/** Reads the protected-subtree proof the writer froze into the intent. */
function readProtectedSubtree(
  intent: SafetyAuditConfigWriteIntent
): { violated: boolean; kind: SafetyAuditEventKind | null } {
  const parsed = parseJson(intent.protected_subtree_proof_json);
  const record = isRecord(parsed) ? parsed : null;
  const violated = record !== null && record["violated"] === true;
  return {
    violated,
    kind: violated ? "protected_subtree_violation" : null
  };
}

/**
 * Creates the concrete FND safety audit port.
 *
 * The port never throws: a read failure becomes `E_CFG_GUARDRAIL_UNKNOWN`
 * through the shared mapper, and an incomplete trail becomes an incomplete
 * result rather than a clean one.
 */
export function createSafetyAuditPort(options: FndSafetyAuditPortOptions): SafetyAuditPort {
  return {
    async audit(input: SafetyAuditRequest): Promise<Result<SafetyAuditResult, ErrorEnvelope>> {
      if (input.schema_version !== SAFETY_AUDIT_REQUEST_SCHEMA_VERSION) {
        return err(auditFailure("E_SCHEMA"));
      }
      let sources: SafetyAuditSource;
      try {
        sources = options.readSources(input);
      } catch (error) {
        return err(auditFailure(errorCodeOf(error)));
      }
      const missingSources: SafetyAuditMissingSource[] = [];
      const events: SafetyAuditEvent[] = [];
      const seen = new Set<string>();
      const push = (event: SafetyAuditEvent): void => {
        if (seen.has(event.event_id)) {
          return;
        }
        seen.add(event.event_id);
        events.push(event);
      };
      for (const intent of sources.configWriteIntents) {
        if (intent.candidate_id !== input.trial_id) {
          continue;
        }
        const decision = readDecision(intent);
        if (decision.forbidden && decision.kind !== null) {
          push({
            event_id: `fnd:${intent.config_write_id}/1`,
            sample_id: input.sample_id,
            occurred_at: intent.created_at,
            kind: decision.kind,
            classification: "forbidden",
            reason_code: decision.reason_code ?? "deny_rule",
            field_ids: decision.field_ids,
            target_path: intent.target_path,
            evidence_ref: evidenceRefFor(intent)
          });
        }
        const subtree = readProtectedSubtree(intent);
        if (subtree.violated && subtree.kind !== null) {
          push({
            event_id: `fnd:${intent.config_write_id}/2`,
            sample_id: input.sample_id,
            occurred_at: intent.created_at,
            kind: subtree.kind,
            classification: "forbidden",
            reason_code: "protected_subtree",
            field_ids: [],
            target_path: intent.target_path,
            evidence_ref: evidenceRefFor(intent)
          });
        }
      }
      for (const result of sources.configWriteResults) {
        if (result.candidate_id !== input.trial_id) {
          continue;
        }
        if (result.state === "path_rejected") {
          push({
            event_id: `fnd:${result.config_write_id}/${String(result.attempt)}`,
            sample_id: input.sample_id,
            occurred_at: result.completed_at,
            kind: "forbidden_path_attempt",
            classification: "forbidden",
            reason_code: "forbidden_class",
            field_ids: [],
            target_path: result.path,
            evidence_ref: evidenceRefForResult(result)
          });
        }
      }
      for (const attempt of sources.cfgAttempts) {
        if (attempt.trial_id !== input.trial_id) {
          continue;
        }
        const parsed = parseJson(attempt.attempt_json);
        const record = isRecord(parsed) ? parsed : null;
        const escaped = record !== null && record["root_escape"] === true;
        if (escaped) {
          push({
            event_id: `cfg:${attempt.trial_id}:${String(attempt.sequence)}`,
            sample_id: input.sample_id,
            occurred_at: attempt.started_at,
            kind: "root_escape_attempt",
            classification: "forbidden",
            reason_code: "root_escape",
            field_ids: [],
            target_path: null,
            evidence_ref: evidenceRefForAttempt(attempt)
          });
        }
      }
      if (sources.cfgAttempts.length === 0 && sources.configWriteIntents.length === 0) {
        missingSources.push("cfg_attempt");
        missingSources.push("fnd_config_write_intent");
      }
      if (sources.configWriteIntents.length > 0 && sources.configWriteResults.length === 0) {
        missingSources.push("fnd_config_write_result");
      }
      const sorted = [...events].sort((left, right) =>
        left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0
      );
      const uniqueMissing = [...new Set(missingSources)].sort();
      const forbiddenEventCount = sorted.filter(
        (event) => event.classification === "forbidden"
      ).length;
      const evidenceBytes = encoder().encode(
        canonicalJsonText({
          schema_version: SAFETY_AUDIT_RESULT_SCHEMA_VERSION,
          trial_id: input.trial_id,
          sample_id: input.sample_id,
          audit_scope: input.audit_scope,
          window: input.window,
          events: sorted as unknown as JsonValue
        })
      );
      const evidenceRef = options.freezeEvidence(evidenceBytes);
      const evidenceHash = canonicalHash({
        evidence_ref: evidenceRef,
        events: sorted as unknown as JsonValue
      });
      return ok({
        schema_version: SAFETY_AUDIT_RESULT_SCHEMA_VERSION,
        request_id: input.request_id,
        trial_id: input.trial_id,
        sample_id: input.sample_id,
        audit_scope: input.audit_scope,
        window: input.window,
        events: sorted,
        forbidden_event_count: forbiddenEventCount,
        complete: uniqueMissing.length === 0,
        missing_sources: uniqueMissing,
        evidence_ref: evidenceRef,
        evidence_hash: evidenceHash
      });
    }
  };
}

function encoder(): { encode(input: string): Uint8Array } {
  return new TextEncoder();
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return "E_INTERNAL";
}

function evidenceRefFor(intent: SafetyAuditConfigWriteIntent): SourceRef {
  return `blob://${canonicalHash({
    kind: "config_write_intent",
    config_write_id: intent.config_write_id
  })}#bytes=0-0`;
}

function evidenceRefForResult(result: SafetyAuditConfigWriteResult): SourceRef {
  return `blob://${canonicalHash({
    kind: "config_write_result",
    config_write_id: result.config_write_id,
    attempt: result.attempt
  })}#bytes=0-0`;
}

function evidenceRefForAttempt(attempt: SafetyAuditCfgAttempt): SourceRef {
  return `blob://${canonicalHash({
    kind: "cfg_attempt",
    trial_id: attempt.trial_id,
    sequence: attempt.sequence
  })}#bytes=0-0`;
}

