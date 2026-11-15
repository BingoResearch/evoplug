/**
 * OriginProofPort implementation (DD-CAP-009).
 *
 * The only acceptable proof is a per-event confirmation ledger row backed by a
 * passed `confirm_human_event` probe whose observed evidence is retrievable and
 * bound to the exact event key. Installation-time static probes are never
 * accepted for `verifyHuman`.
 */

import type { Clock } from "../../clock.js";
import type { Hash } from "../../hash.js";
import { isHash } from "../../hash.js";
import type { Id } from "../../ids.js";
import { canonicalJsonText } from "../../canonical.js";
import { toJsonValue } from "../../json.js";
import { isSourceRef } from "../../source-ref.js";
import type { NotPromise, Tx } from "../../tx.js";
import type { SourceRef, SourceRefPort } from "../../source-ref.js";
import type {
  CapabilityName,
  HostId,
  HostMode,
  HumanAttestation,
  HumanProofEvidence,
  HumanProofPurpose,
  HumanProofVerdict,
  OriginProofPort
} from "../types.js";
import { CONTROL_PLANE_PURPOSES } from "../keys.js";
import { isRecord, isSafeNonNegativeInt } from "../validation.js";

export interface OriginProofDeps {
  withTx<T>(fn: (tx: Tx) => NotPromise<T>): Promise<T>;
  clock: Clock;
  sourceRefs: Pick<SourceRefPort, "resolve">;
}

const HOST_NATIVE_PROOF = "host_native_confirmation";
const CONTROL_PLANE_PROOF = "control_plane_explicit_confirmation";

interface CapabilityRow {
  capability_id: string;
  binding_key: string;
  binding_json: string;
  name: string;
  status: string;
  evidence_stage: string;
  probe_ref: string | null;
  probe_result: string | null;
  details_json: string;
  verified_at: number | null;
}

interface ProbeRow {
  probe_id: string;
  binding_key: string;
  binding_json: string;
  probe_action: string;
  probe_mode: string;
  result: string;
  assertions_json: string;
  evidence_refs_json: string;
  checked_at: number;
}

interface ConfirmationRow {
  confirmation_id: string;
  binding_key: string;
  event_identity_key: string;
  challenge_nonce: string;
  probe_id: string;
  state: string;
  evidence_ref: string | null;
  confirmed_at: number | null;
}

const CAPABILITY_COLUMNS = `capability_id, binding_key, binding_json, name, status,
  evidence_stage, probe_ref, probe_result, details_json, verified_at`;

const PROBE_COLUMNS = `probe_id, binding_key, binding_json, probe_action, probe_mode,
  result, assertions_json, evidence_refs_json, checked_at`;

const CONFIRMATION_COLUMNS = `confirmation_id, binding_key, event_identity_key,
  challenge_nonce, probe_id, state, evidence_ref, confirmed_at`;

type Row = Record<string, unknown>;

function str(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function num(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readCapabilityById(tx: Tx, capabilityId: string): CapabilityRow | null {
  const rows = tx
    .prepare(`SELECT ${CAPABILITY_COLUMNS} FROM capability_record WHERE capability_id = ? LIMIT 1`)
    .all([capabilityId]);
  const row = rows[0];
  return row === undefined ? null : capabilityRow(row);
}

function readCapabilityByName(
  tx: Tx,
  bindingKey: string,
  name: CapabilityName
): CapabilityRow | null {
  const rows = tx
    .prepare(`SELECT ${CAPABILITY_COLUMNS} FROM capability_record WHERE binding_key = ? AND name = ? LIMIT 1`)
    .all([bindingKey, name]);
  const row = rows[0];
  return row === undefined ? null : capabilityRow(row);
}

function capabilityRow(row: Row): CapabilityRow | null {
  const capabilityId = str(row, "capability_id");
  const bindingKey = str(row, "binding_key");
  const bindingJson = str(row, "binding_json");
  const name = str(row, "name");
  const status = str(row, "status");
  const evidenceStage = str(row, "evidence_stage");
  const detailsJson = str(row, "details_json");
  if (
    capabilityId === null ||
    bindingKey === null ||
    bindingJson === null ||
    name === null ||
    status === null ||
    evidenceStage === null ||
    detailsJson === null
  ) {
    return null;
  }
  return {
    capability_id: capabilityId,
    binding_key: bindingKey,
    binding_json: bindingJson,
    name,
    status,
    evidence_stage: evidenceStage,
    probe_ref: str(row, "probe_ref"),
    probe_result: str(row, "probe_result"),
    details_json: detailsJson,
    verified_at: num(row, "verified_at")
  };
}

function readProbe(tx: Tx, probeId: string): ProbeRow | null {
  const rows = tx.prepare(`SELECT ${PROBE_COLUMNS} FROM host_probe WHERE probe_id = ? LIMIT 1`).all([probeId]);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const probeIdValue = str(row, "probe_id");
  const bindingKey = str(row, "binding_key");
  const bindingJson = str(row, "binding_json");
  const probeAction = str(row, "probe_action");
  const probeMode = str(row, "probe_mode");
  const result = str(row, "result");
  const assertionsJson = str(row, "assertions_json");
  const evidenceRefsJson = str(row, "evidence_refs_json");
  const checkedAt = num(row, "checked_at");
  if (
    probeIdValue === null ||
    bindingKey === null ||
    bindingJson === null ||
    probeAction === null ||
    probeMode === null ||
    result === null ||
    assertionsJson === null ||
    evidenceRefsJson === null ||
    checkedAt === null
  ) {
    return null;
  }
  return {
    probe_id: probeIdValue,
    binding_key: bindingKey,
    binding_json: bindingJson,
    probe_action: probeAction,
    probe_mode: probeMode,
    result,
    assertions_json: assertionsJson,
    evidence_refs_json: evidenceRefsJson,
    checked_at: checkedAt
  };
}

function readConfirmedLedger(
  tx: Tx,
  bindingKey: string,
  eventIdentityKey: string
): ConfirmationRow | null {
  const rows = tx
    .prepare(
      `SELECT ${CONFIRMATION_COLUMNS} FROM host_human_confirmation
       WHERE binding_key = ? AND event_identity_key = ? AND state = 'confirmed'
       ORDER BY confirmed_at DESC LIMIT 1`
    )
    .all([bindingKey, eventIdentityKey]);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const confirmationId = str(row, "confirmation_id");
  const challengeNonce = str(row, "challenge_nonce");
  const probeId = str(row, "probe_id");
  if (confirmationId === null || challengeNonce === null || probeId === null) {
    return null;
  }
  return {
    confirmation_id: confirmationId,
    binding_key: bindingKey,
    event_identity_key: eventIdentityKey,
    challenge_nonce: challengeNonce,
    probe_id: probeId,
    state: "confirmed",
    evidence_ref: str(row, "evidence_ref"),
    confirmed_at: num(row, "confirmed_at")
  };
}

interface Assertion {
  assertion_id: string;
  capability: string;
  expected: string;
  observed_ref: string;
  pass: boolean | "unknown";
}

function parseAssertions(text: string): Assertion[] | null {
  const parsed = parseJsonText(text);
  if (parsed === null || !Array.isArray(parsed)) {
    return null;
  }
  const assertions: Assertion[] = [];
  for (const entry of parsed) {
    if (
      !isRecord(entry) ||
      typeof entry["assertion_id"] !== "string" ||
      typeof entry["capability"] !== "string" ||
      typeof entry["expected"] !== "string" ||
      typeof entry["observed_ref"] !== "string" ||
      (entry["pass"] !== true && entry["pass"] !== false && entry["pass"] !== "unknown")
    ) {
      return null;
    }
    assertions.push({
      assertion_id: entry["assertion_id"],
      capability: entry["capability"],
      expected: entry["expected"],
      observed_ref: entry["observed_ref"],
      pass: entry["pass"]
    });
  }
  return assertions;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseBinding(text: string): Record<string, unknown> | null {
  const parsed = parseJsonText(text);
  if (!isRecord(parsed)) {
    return null;
  }
  if (canonicalJsonText(toJsonValue(parsed)) !== text) {
    return null;
  }
  return parsed;
}

interface Details {
  proof_kinds: string[];
  subject_kinds: string[];
  control_plane_purposes: string[];
  evidence_schema: string;
  max_attestation_age_ms: number;
}

function parseDetails(text: string): Details | null {
  const parsed = parseJsonText(text);
  if (!isRecord(parsed)) {
    return null;
  }
  if (
    !Array.isArray(parsed["proof_kinds"]) ||
    !parsed["proof_kinds"].every((entry) => typeof entry === "string") ||
    !Array.isArray(parsed["subject_kinds"]) ||
    !parsed["subject_kinds"].every((entry) => typeof entry === "string") ||
    !Array.isArray(parsed["control_plane_purposes"]) ||
    !parsed["control_plane_purposes"].every((entry) => typeof entry === "string") ||
    parsed["evidence_schema"] !== "rsi.human_proof_evidence/1" ||
    !isSafeNonNegativeInt(parsed["max_attestation_age_ms"]) ||
    parsed["max_attestation_age_ms"] < 1 ||
    parsed["max_attestation_age_ms"] > 600_000
  ) {
    return null;
  }
  return {
    proof_kinds: parsed["proof_kinds"],
    subject_kinds: parsed["subject_kinds"],
    control_plane_purposes: parsed["control_plane_purposes"],
    evidence_schema: parsed["evidence_schema"],
    max_attestation_age_ms: parsed["max_attestation_age_ms"]
  };
}

/** Parses `rsi.human_proof_evidence/1` with a closed shape. */
export function parseHumanProofEvidence(value: unknown): HumanProofEvidence | null {
  if (!isRecord(value) || value["schema_version"] !== "rsi.human_proof_evidence/1") {
    return null;
  }
  const capabilityId = value["capability_id"];
  const confirmedAt = value["confirmed_at"];
  const nonce = value["nonce"];
  if (typeof capabilityId !== "string" || !capabilityId.startsWith("cap:")) {
    return null;
  }
  if (!isSafeNonNegativeInt(confirmedAt)) {
    return null;
  }
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) {
    return null;
  }
  if (value["proof_kind"] === HOST_NATIVE_PROOF) {
    const subject = value["subject"];
    if (
      !isRecord(subject) ||
      subject["kind"] !== "event_key" ||
      typeof subject["event_key"] !== "string" ||
      !isHash(subject["event_key"]) ||
      typeof subject["native_session_id"] !== "string"
    ) {
      return null;
    }
    if (
      typeof value["host_id"] !== "string" ||
      typeof value["host_version"] !== "string" ||
      typeof value["mode"] !== "string" ||
      typeof value["config_space"] !== "string"
    ) {
      return null;
    }
    return {
      schema_version: "rsi.human_proof_evidence/1",
      capability_id: capabilityId as Id<"cap">,
      proof_kind: HOST_NATIVE_PROOF,
      host_id: value["host_id"] as HostId,
      host_version: value["host_version"],
      mode: value["mode"] as HostMode,
      config_space: value["config_space"],
      subject: {
        kind: "event_key",
        event_key: subject["event_key"] as Hash,
        native_session_id: subject["native_session_id"]
      },
      confirmed_at: confirmedAt,
      nonce
    };
  }
  if (value["proof_kind"] === CONTROL_PLANE_PROOF) {
    const subject = value["subject"];
    if (
      !isRecord(subject) ||
      subject["kind"] !== "control_plane" ||
      typeof subject["purpose"] !== "string" ||
      !(CONTROL_PLANE_PURPOSES as readonly string[]).includes(subject["purpose"]) ||
      typeof subject["subject_hash"] !== "string" ||
      !isHash(subject["subject_hash"])
    ) {
      return null;
    }
    return {
      schema_version: "rsi.human_proof_evidence/1",
      capability_id: capabilityId as Id<"cap">,
      proof_kind: CONTROL_PLANE_PROOF,
      subject: {
        kind: "control_plane",
        purpose: subject["purpose"] as HumanProofPurpose,
        subject_hash: subject["subject_hash"] as Hash
      },
      confirmed_at: confirmedAt,
      nonce
    };
  }
  return null;
}

async function resolveEvidence(
  deps: OriginProofDeps,
  ref: SourceRef
): Promise<
  | { state: "unverified" }
  | { state: "conflict" }
  | { state: "ok"; evidence: HumanProofEvidence; text: string }
> {
  try {
    const resolved = await deps.sourceRefs.resolve(ref, { maxBytes: 1_048_576 });
    if (!resolved.ok || !resolved.value.retrievable || resolved.value.bytes === null) {
      return { state: "unverified" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(resolved.value.bytes);
    } catch {
      return { state: "conflict" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { state: "conflict" };
    }
    if (!isRecord(parsed)) {
      return { state: "conflict" };
    }
    if (canonicalJsonText(toJsonValue(parsed)) !== text) {
      return { state: "conflict" };
    }
    const evidence = parseHumanProofEvidence(parsed);
    if (evidence === null) {
      return { state: "conflict" };
    }
    return { state: "ok", evidence, text };
  } catch {
    return { state: "unverified" };
  }
}

function fresh(confirmedAt: number, maxAge: number, now: number): boolean {
  const age = now - confirmedAt;
  return age >= 0 && age <= maxAge;
}

/**
 * Builds the HOST implementation of FND `OriginProofPort`. All reads happen in
 * one read-only `withTx`; evidence bytes are resolved outside it.
 */
export function createOriginProofPort(deps: OriginProofDeps): OriginProofPort {
  return {
    async verifyHuman(input: {
      attestation: HumanAttestation;
      host_id: string;
      config_space: string;
      native_session_id: string;
      event_key: Hash;
    }): Promise<HumanProofVerdict> {
      if (
        input.attestation.kind !== "host_verified_interactive_user" ||
        typeof input.host_id !== "string" ||
        typeof input.config_space !== "string" ||
        typeof input.native_session_id !== "string" ||
        !isHash(input.event_key)
      ) {
        return "conflict";
      }
      let snapshot: {
        capability: CapabilityRow;
        capability_probe: ProbeRow;
        event_probe: ProbeRow;
        ledger: ConfirmationRow;
        details: Details;
        assertions: Assertion[];
        binding: Record<string, unknown>;
      } | null = null;
      try {
        snapshot = await deps.withTx((tx) => {
          const capability = readCapabilityById(tx, input.attestation.capability_id);
          if (capability === null || capability.name !== "human_interaction_attested") {
            return null;
          }
          if (
            capability.status !== "verified" ||
            capability.evidence_stage !== "roundtrip" ||
            capability.probe_result !== "passed" ||
            capability.probe_ref === null
          ) {
            return null;
          }
          const details = parseDetails(capability.details_json);
          if (details === null) {
            return null;
          }
          if (!details.proof_kinds.includes(HOST_NATIVE_PROOF) || !details.subject_kinds.includes("event_key")) {
            return null;
          }
          const binding = parseBinding(capability.binding_json);
          if (
            binding === null ||
            binding["host_id"] !== input.host_id ||
            binding["config_space"] !== input.config_space ||
            (binding["subject"] !== "host_contract" && binding["subject"] !== "product_adapter")
          ) {
            return null;
          }
          // `capability.probe_ref` names the installation/capability probe that
          // applied the capability status. It is never the per-event
          // `confirm_human_event` probe, so the two bindings are validated
          // separately rather than required to be the same row.
          const capabilityProbe = readProbe(tx, capability.probe_ref);
          if (
            capabilityProbe === null ||
            capabilityProbe.result !== "passed" ||
            capabilityProbe.binding_key !== capability.binding_key ||
            capabilityProbe.binding_json !== capability.binding_json ||
            capabilityProbe.probe_action === "confirm_human_event"
          ) {
            return null;
          }
          const ledger = readConfirmedLedger(tx, capability.binding_key, input.event_key);
          if (ledger === null) {
            return null;
          }
          const eventProbe = readProbe(tx, ledger.probe_id);
          if (
            eventProbe === null ||
            eventProbe.probe_action !== "confirm_human_event" ||
            eventProbe.result !== "passed" ||
            eventProbe.binding_key !== capability.binding_key ||
            eventProbe.binding_json !== capability.binding_json
          ) {
            return null;
          }
          const assertions = parseAssertions(eventProbe.assertions_json);
          if (assertions === null) {
            return null;
          }
          return {
            capability,
            capability_probe: capabilityProbe,
            event_probe: eventProbe,
            ledger,
            details,
            assertions,
            binding
          };
        });
      } catch {
        return "unverified";
      }
      if (snapshot === null) {
        return "unverified";
      }
      const assertion = snapshot.assertions.find(
        (entry) =>
          entry.capability === "human_interaction_attested" &&
          entry.pass === true &&
          entry.expected === input.event_key
      );
      if (assertion === undefined || snapshot.ledger.evidence_ref === null || snapshot.ledger.confirmed_at === null) {
        return "unverified";
      }
      if (assertion.observed_ref !== snapshot.ledger.evidence_ref) {
        return "conflict";
      }
      if (!isSourceRef(assertion.observed_ref)) {
        return "conflict";
      }
      const resolved = await resolveEvidence(deps, assertion.observed_ref);
      if (resolved.state === "unverified") {
        return "unverified";
      }
      if (resolved.state === "conflict") {
        return "conflict";
      }
      const evidence = resolved.evidence;
      if (evidence.proof_kind !== HOST_NATIVE_PROOF) {
        return "conflict";
      }
      if (evidence.capability_id !== input.attestation.capability_id) {
        return "conflict";
      }
      if (
        evidence.host_id !== snapshot.binding["host_id"] ||
        evidence.mode !== snapshot.binding["mode"] ||
        evidence.config_space !== snapshot.binding["config_space"] ||
        evidence.subject.event_key !== input.event_key ||
        evidence.subject.native_session_id !== input.native_session_id ||
        evidence.nonce !== snapshot.ledger.challenge_nonce ||
        evidence.confirmed_at !== snapshot.ledger.confirmed_at ||
        evidence.confirmed_at !== input.attestation.confirmed_at
      ) {
        return "conflict";
      }
      if (!fresh(evidence.confirmed_at, snapshot.details.max_attestation_age_ms, deps.clock.utcNowMs())) {
        return "unverified";
      }
      return "verified";
    },

    async verifyControlPlane(input: {
      attestation: HumanAttestation;
      subject_hash: Hash;
      purpose: HumanProofPurpose;
    }): Promise<HumanProofVerdict> {
      if (
        input.attestation.kind !== "control_plane_explicit_confirmation" ||
        !isHash(input.subject_hash) ||
        !(CONTROL_PLANE_PURPOSES as readonly string[]).includes(input.purpose)
      ) {
        return "conflict";
      }
      let snapshot: {
        capability: CapabilityRow;
        probe: ProbeRow;
        details: Details;
        assertions: Assertion[];
        binding: Record<string, unknown>;
      } | null = null;
      try {
        snapshot = await deps.withTx((tx) => {
          const capability = readCapabilityById(tx, input.attestation.capability_id);
          if (capability === null || capability.name !== "human_interaction_attested") {
            return null;
          }
          if (
            capability.status !== "verified" ||
            capability.evidence_stage !== "roundtrip" ||
            capability.probe_result !== "passed" ||
            capability.probe_ref === null
          ) {
            return null;
          }
          const details = parseDetails(capability.details_json);
          if (details === null || !details.proof_kinds.includes(CONTROL_PLANE_PROOF)) {
            return null;
          }
          if (!details.subject_kinds.includes("subject_hash")) {
            return null;
          }
          if (input.purpose === "adapter_install") {
            if (!details.control_plane_purposes.includes("adapter_install")) {
              return null;
            }
          } else if (!details.control_plane_purposes.includes(input.purpose)) {
            return null;
          }
          const binding = parseBinding(capability.binding_json);
          if (binding === null || binding["subject"] !== "host_contract") {
            return null;
          }
          const probe = readProbe(tx, capability.probe_ref);
          if (probe === null || probe.result !== "passed" || probe.binding_key !== capability.binding_key) {
            return null;
          }
          if (input.purpose === "adapter_install" && probe.probe_action !== "confirm_control_plane") {
            return null;
          }
          const assertions = parseAssertions(probe.assertions_json);
          if (assertions === null) {
            return null;
          }
          return { capability, probe, details, assertions, binding };
        });
      } catch {
        return "unverified";
      }
      if (snapshot === null) {
        return "unverified";
      }
      const expected =
        input.purpose === "adapter_install"
          ? snapshot.assertions.find(
              (entry) =>
                entry.capability === "human_interaction_attested" &&
                entry.pass === true
            )
          : snapshot.assertions.find(
              (entry) => entry.capability === "human_interaction_attested" && entry.pass === true
            );
      if (expected === undefined) {
        return "unverified";
      }
      if (!isSourceRef(expected.observed_ref)) {
        return "conflict";
      }
      const resolved = await resolveEvidence(deps, expected.observed_ref);
      if (resolved.state === "unverified") {
        return "unverified";
      }
      if (resolved.state === "conflict") {
        return "conflict";
      }
      const evidence = resolved.evidence;
      if (evidence.proof_kind !== CONTROL_PLANE_PROOF) {
        return "conflict";
      }
      if (
        evidence.subject.purpose !== input.purpose ||
        evidence.subject.subject_hash !== input.subject_hash ||
        evidence.capability_id !== input.attestation.capability_id ||
        evidence.confirmed_at !== input.attestation.confirmed_at
      ) {
        return "conflict";
      }
      if (!fresh(evidence.confirmed_at, snapshot.details.max_attestation_age_ms, deps.clock.utcNowMs())) {
        return "unverified";
      }
      return "verified";
    }
  };
}
