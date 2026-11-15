/**
 * `EgressPolicyPreparationPort` / `EgressPolicyReadPort` two-phase
 * eligibility (DD-FND-093.1).
 *
 * Prepared facts are frozen outside the caller's transaction and sealed with a
 * module-private brand; the synchronous read port validates the seal, the
 * input hash, fact coverage/order and the policy version before computing the
 * eligible subsets. This port never authorises a send: `egress.evaluate`,
 * `EgressApproval` and OriginProof remain mandatory.
 */

import {
  canonicalHash,
  compareUtf8,
  err,
  ok,
  parseSourceRef,
} from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  JsonValue,
  Result,
  SourceRef,
  Tx,
} from "@evoplug/core";

import { egressInternalError, egressPolicyStaleError, egressSchemaError, egressStaleVersionError } from "./errors.js";
import { eligibleEgressDataClasses, computeEgressPolicyHash } from "./policy.js";
import {
  EGRESS_CLASSIFIER_VERSION,
} from "./classifier.js";
import type { DataClass, EgressPolicy } from "./types.js";

export const EGRESS_POLICY_REF: "egress://default" = "egress://default";

export const EGRESS_APPROVED_SOURCES_INPUT_SCHEMA_VERSION: "rsi.egress_approved_sources_in/1" =
  "rsi.egress_approved_sources_in/1";

export const EGRESS_APPROVED_SOURCES_VIEW_SCHEMA_VERSION: "rsi.egress_approved_sources_view/1" =
  "rsi.egress_approved_sources_view/1";

export const EGRESS_APPROVED_SOURCES_PREPARED_SCHEMA_VERSION:
  "rsi.egress_approved_sources_prepared/1" = "rsi.egress_approved_sources_prepared/1";

export interface EgressApprovedSourcesInput {
  schema_version: "rsi.egress_approved_sources_in/1";
  policy_ref: "egress://default";
  /** Strict UTF-8 ascending, unique. */
  evidence_refs: SourceRef[];
  /** Strict UTF-8 ascending, unique, disjoint from `evidence_refs`. */
  experience_refs: SourceRef[];
}

export type EgressSourceRejectionReason =
  | "source_unretrievable"
  | "unclassified"
  | "secret_forbidden"
  | "data_class_not_allowed";

export interface EgressSourceRejection {
  source_kind: "evidence" | "experience";
  ref: SourceRef;
  /** `null` when unretrievable or unclassified. */
  data_class: DataClass | null;
  reason: EgressSourceRejectionReason;
}

export interface EgressApprovedSourcesView {
  schema_version: "rsi.egress_approved_sources_view/1";
  egress_policy_ref: "egress://default";
  egress_policy_version: string;
  classifier_version: "egress_classifier/1";
  /** Exact subsequence of `evidence_refs`. */
  approved_evidence_refs: SourceRef[];
  /** Exact subsequence of `experience_refs`. */
  approved_experience_refs: SourceRef[];
  /** Remaining items from both arrays, evidence first, each group UTF-8 sorted. */
  rejected_sources: EgressSourceRejection[];
}

declare const egressPreparedBrand: unique symbol;

export interface EgressSourceFact {
  source_kind: "evidence" | "experience";
  ref: SourceRef;
  retrievable: boolean;
  /** Full blob hash; `null` when unretrievable. */
  content_version: Hash | null;
  /** Hash of the exact classified range; `null` when unretrievable. */
  range_content_hash: Hash | null;
  /** `null` when unretrievable or the classifier returned unknown. */
  data_class: DataClass | null;
  /** Canonical hash of the SQLite provenance tuple; never `null`. */
  provenance_digest: Hash;
}

export interface EgressApprovedSourcesPrepared {
  readonly [egressPreparedBrand]: true;
  schema_version: "rsi.egress_approved_sources_prepared/1";
  /** `sha256(JCS(EgressApprovedSourcesInput))`. */
  input_hash: Hash;
  policy_ref: "egress://default";
  egress_policy_version: string;
  egress_policy_hash: Hash;
  classifier_version: "egress_classifier/1";
  /** Evidence facts first, then experience facts; exactly one per input ref. */
  facts: readonly EgressSourceFact[];
}

/** Unbranded field set accepted by the seal factory. */
export interface EgressApprovedSourcesPreparedFields {
  readonly schema_version: "rsi.egress_approved_sources_prepared/1";
  readonly input_hash: Hash;
  readonly policy_ref: "egress://default";
  readonly egress_policy_version: string;
  readonly egress_policy_hash: Hash;
  readonly classifier_version: "egress_classifier/1";
  readonly facts: readonly EgressSourceFact[];
}

export interface EgressPolicyPreparationPort {
  prepareApprovedSources(
    input: EgressApprovedSourcesInput,
  ): Promise<Result<EgressApprovedSourcesPrepared, ErrorEnvelope>>;
}

export interface EgressPolicyReadPort {
  /**
   * Synchronous, transaction-bound eligibility check. It reads only SQLite
   * metadata; it never reads blobs, awaits, spawns workers or opens a second
   * connection.
   */
  getApprovedSourcesInTransaction(
    tx: Tx,
    input: EgressApprovedSourcesInput,
    prepared: EgressApprovedSourcesPrepared,
  ): Result<EgressApprovedSourcesView, ErrorEnvelope>;
}

const SEALED_PREPARED = new WeakSet<object>();

/**
 * Seals prepared facts. Only this module can brand an object; a structurally
 * identical copy produced elsewhere is rejected by the read port.
 */
export function sealEgressApprovedSources(
  fields: EgressApprovedSourcesPreparedFields,
): EgressApprovedSourcesPrepared {
  const facts = fields.facts.map((fact) =>
    Object.freeze({
      source_kind: fact.source_kind,
      ref: fact.ref,
      retrievable: fact.retrievable,
      content_version: fact.content_version,
      range_content_hash: fact.range_content_hash,
      data_class: fact.data_class,
      provenance_digest: fact.provenance_digest,
    }),
  );
  const prepared: EgressApprovedSourcesPrepared = Object.freeze({
    schema_version: EGRESS_APPROVED_SOURCES_PREPARED_SCHEMA_VERSION,
    input_hash: fields.input_hash,
    policy_ref: EGRESS_POLICY_REF,
    egress_policy_version: fields.egress_policy_version,
    egress_policy_hash: fields.egress_policy_hash,
    classifier_version: fields.classifier_version,
    facts: Object.freeze(facts),
  } as EgressApprovedSourcesPrepared);
  SEALED_PREPARED.add(prepared);
  return prepared;
}

/** Runtime seal check used by the read port and its tests. */
export function isSealedEgressApprovedSources(
  value: unknown,
): value is EgressApprovedSourcesPrepared {
  return typeof value === "object" && value !== null && SEALED_PREPARED.has(value);
}

/** `input_hash = sha256(JCS(input))` over the exact four-field object. */
export function computeEgressApprovedSourcesInputHash(
  input: EgressApprovedSourcesInput,
): Hash {
  const preimage: JsonValue = {
    schema_version: input.schema_version,
    policy_ref: input.policy_ref,
    evidence_refs: [...input.evidence_refs],
    experience_refs: [...input.experience_refs],
  };
  return canonicalHash(preimage);
}

/**
 * Builds and seals the prepared object after the two transaction reads
 * agree. Facts must cover the input exactly: evidence first, then experience,
 * one per ref, with the retrievable/hash pairing enforced here as well as in
 * the read port.
 */
export function buildEgressApprovedSourcesPrepared(input: {
  readonly input: EgressApprovedSourcesInput;
  readonly policy_version: string;
  readonly policy_hash: Hash;
  readonly facts: readonly EgressSourceFact[];
}): Result<EgressApprovedSourcesPrepared, ErrorEnvelope> {
  const parsedInput = parseEgressApprovedSourcesInput(input.input);
  if (!parsedInput.ok) {
    return parsedInput;
  }
  const sourceInput = parsedInput.value;
  const expected = [...sourceInput.evidence_refs, ...sourceInput.experience_refs];
  if (input.facts.length !== expected.length) {
    return err(egressInternalError("egress_prepared_fact_count"));
  }
  for (let index = 0; index < expected.length; index += 1) {
    const fact = input.facts[index];
    const ref = expected[index];
    if (fact === undefined || ref === undefined || fact.ref !== ref) {
      return err(egressInternalError("egress_prepared_fact_order"));
    }
    const expectedKind = index < sourceInput.evidence_refs.length ? "evidence" : "experience";
    if (fact.source_kind !== expectedKind) {
      return err(egressInternalError("egress_prepared_fact_kind"));
    }
    if (fact.retrievable) {
      if (fact.content_version === null || fact.range_content_hash === null) {
        return err(egressInternalError("egress_prepared_retrievable_null_hash"));
      }
    } else if (fact.content_version !== null || fact.range_content_hash !== null) {
      return err(egressInternalError("egress_prepared_unretrievable_hash"));
    }
  }
  if (input.policy_version.length === 0) {
    return err(egressSchemaError("policy_version", "non_empty_string"));
  }
  return ok(
    sealEgressApprovedSources({
      schema_version: EGRESS_APPROVED_SOURCES_PREPARED_SCHEMA_VERSION,
      input_hash: computeEgressApprovedSourcesInputHash(sourceInput),
      policy_ref: EGRESS_POLICY_REF,
      egress_policy_version: input.policy_version,
      egress_policy_hash: input.policy_hash,
      classifier_version: EGRESS_CLASSIFIER_VERSION,
      facts: input.facts,
    }),
  );
}

/**
 * Schema gate: exactly four fields, strict UTF-8 ascending unique arrays and
 * disjoint evidence/experience sets. Runs before any database read.
 */
export function parseEgressApprovedSourcesInput(
  value: unknown,
): Result<EgressApprovedSourcesInput, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  const fields = new Set<string>([
    "schema_version",
    "policy_ref",
    "evidence_refs",
    "experience_refs",
  ]);
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) {
      return err(egressSchemaError(key, "known_field"));
    }
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(egressSchemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== EGRESS_APPROVED_SOURCES_INPUT_SCHEMA_VERSION) {
    return err(
      egressSchemaError(
        "schema_version",
        EGRESS_APPROVED_SOURCES_INPUT_SCHEMA_VERSION,
      ),
    );
  }
  if (record["policy_ref"] !== EGRESS_POLICY_REF) {
    return err(egressSchemaError("policy_ref", EGRESS_POLICY_REF));
  }
  const evidence = parseSortedRefs(record["evidence_refs"], "evidence_refs");
  if (!evidence.ok) {
    return evidence;
  }
  const experience = parseSortedRefs(record["experience_refs"], "experience_refs");
  if (!experience.ok) {
    return experience;
  }
  const evidenceSet = new Set(evidence.value);
  for (const ref of experience.value) {
    if (evidenceSet.has(ref)) {
      return err(egressSchemaError("experience_refs", "disjoint_from_evidence_refs"));
    }
  }
  return ok({
    schema_version: EGRESS_APPROVED_SOURCES_INPUT_SCHEMA_VERSION,
    policy_ref: EGRESS_POLICY_REF,
    evidence_refs: evidence.value,
    experience_refs: experience.value,
  });
}

/**
 * Computes the eligible subsets and per-source rejections.
 *
 * The input `policy` is the active row read inside the caller's transaction;
 * `prepared` is the frozen result of the preparation phase.
 */
export function computeEgressApprovedSourcesView(
  policy: EgressPolicy,
  input: EgressApprovedSourcesInput,
  prepared: EgressApprovedSourcesPrepared,
): Result<EgressApprovedSourcesView, ErrorEnvelope> {
  if (!isSealedEgressApprovedSources(prepared)) {
    return err(egressInternalError("egress_prepared_unsealed"));
  }
  if (prepared.schema_version !== EGRESS_APPROVED_SOURCES_PREPARED_SCHEMA_VERSION) {
    return err(egressInternalError("egress_prepared_schema"));
  }
  if (prepared.policy_ref !== EGRESS_POLICY_REF) {
    return err(egressInternalError("egress_prepared_policy_ref"));
  }
  if (prepared.classifier_version !== EGRESS_CLASSIFIER_VERSION) {
    return err(
      egressStaleVersionError(EGRESS_CLASSIFIER_VERSION, prepared.classifier_version),
    );
  }
  if (prepared.input_hash !== computeEgressApprovedSourcesInputHash(input)) {
    return err(egressSchemaError("input_hash", "matches_prepared"));
  }
  const expectedRefs = [...input.evidence_refs, ...input.experience_refs];
  if (prepared.facts.length !== expectedRefs.length) {
    return err(egressInternalError("egress_prepared_fact_count"));
  }
  for (let index = 0; index < expectedRefs.length; index += 1) {
    const fact = prepared.facts[index];
    const ref = expectedRefs[index];
    if (fact === undefined || ref === undefined || fact.ref !== ref) {
      return err(egressInternalError("egress_prepared_fact_order"));
    }
    const expectedKind = index < input.evidence_refs.length ? "evidence" : "experience";
    if (fact.source_kind !== expectedKind) {
      return err(egressInternalError("egress_prepared_fact_kind"));
    }
    if (fact.retrievable) {
      if (fact.content_version === null || fact.range_content_hash === null) {
        return err(egressInternalError("egress_prepared_retrievable_null_hash"));
      }
    } else if (fact.content_version !== null || fact.range_content_hash !== null) {
      return err(egressInternalError("egress_prepared_unretrievable_hash"));
    }
  }
  if (policy.schema_version !== "rsi.egress_policy/1") {
    return err(egressSchemaError("policy.schema_version", "rsi.egress_policy/1"));
  }
  if (prepared.egress_policy_version !== policy.policy_version) {
    return err(egressPolicyStaleError(prepared.egress_policy_version));
  }
  if (prepared.egress_policy_hash !== computeEgressPolicyHash(policy)) {
    return err(egressPolicyStaleError(prepared.egress_policy_version));
  }

  const eligible = eligibleEgressDataClasses(policy);
  const approvedEvidence: SourceRef[] = [];
  const approvedExperience: SourceRef[] = [];
  const rejectedEvidence: EgressSourceRejection[] = [];
  const rejectedExperience: EgressSourceRejection[] = [];

  for (let index = 0; index < prepared.facts.length; index += 1) {
    const fact = prepared.facts[index];
    if (fact === undefined) {
      continue;
    }
    const rejection = classifyFact(fact, eligible);
    if (rejection === null) {
      if (fact.source_kind === "evidence") {
        approvedEvidence.push(fact.ref);
      } else {
        approvedExperience.push(fact.ref);
      }
      continue;
    }
    const entry: EgressSourceRejection = {
      source_kind: fact.source_kind,
      ref: fact.ref,
      data_class: fact.data_class,
      reason: rejection,
    };
    if (fact.source_kind === "evidence") {
      rejectedEvidence.push(entry);
    } else {
      rejectedExperience.push(entry);
    }
  }
  rejectedEvidence.sort((left, right) => compareUtf8(left.ref, right.ref));
  rejectedExperience.sort((left, right) => compareUtf8(left.ref, right.ref));

  const view: EgressApprovedSourcesView = {
    schema_version: EGRESS_APPROVED_SOURCES_VIEW_SCHEMA_VERSION,
    egress_policy_ref: EGRESS_POLICY_REF,
    egress_policy_version: policy.policy_version,
    classifier_version: EGRESS_CLASSIFIER_VERSION,
    approved_evidence_refs: approvedEvidence,
    approved_experience_refs: approvedExperience,
    rejected_sources: [...rejectedEvidence, ...rejectedExperience],
  };
  return ok(view);
}

function classifyFact(
  fact: EgressSourceFact,
  eligible: ReadonlySet<DataClass>,
): EgressSourceRejectionReason | null {
  if (!fact.retrievable) {
    return "source_unretrievable";
  }
  if (fact.data_class === null) {
    return "unclassified";
  }
  if (fact.data_class === "secret") {
    return "secret_forbidden";
  }
  if (!eligible.has(fact.data_class)) {
    return "data_class_not_allowed";
  }
  return null;
}

function parseSortedRefs(
  value: unknown,
  path: string,
): Result<SourceRef[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(egressSchemaError(path, "array"));
  }
  const out: SourceRef[] = [];
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      return err(egressSchemaError(`${path}[${String(index)}]`, "string"));
    }
    const parsed = parseSourceRef(item);
    if (!parsed.ok) {
      return parsed;
    }
    if (previous !== null) {
      const order = compareUtf8(previous, parsed.value.source_ref);
      if (order > 0) {
        return err(egressSchemaError(path, "strict_utf8_ascending"));
      }
      if (order === 0) {
        return err(egressSchemaError(path, "unique"));
      }
    }
    previous = parsed.value.source_ref;
    out.push(parsed.value.source_ref);
  }
  return ok(out);
}
