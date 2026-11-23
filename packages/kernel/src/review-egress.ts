/**
 * Review snapshot egress ports (Appendix D, DD-FND-093.1).
 *
 * The review snapshot hands session evidence to the generation backend, which
 * is a data exit. This module is the single kernel composition of the
 * `@evoplug/egress` two-phase preparation/read ports:
 *
 *   - `prepareApprovedSources` runs before the enqueue transaction, reads the
 *     active standing policy, resolves and classifies every evidence blob and
 *     freezes the facts;
 *   - `getApprovedSourcesInTransaction` re-reads the policy inside the caller's
 *     transaction and computes the eligible subsets without touching blobs.
 *
 * A standing policy is only valid for the host that produced the evidence.
 * Evidence from another host is a cross-source route; this build does not
 * implement cross-source approvals and denies it with
 * `E_AUTH_DENIED / cross_source_egress_not_supported`.
 *
 * Classification is derived from blob bytes plus SQLite provenance only.
 * Project-excluded and credential-shaped sources never enter the approved
 * subsets; they are recorded in the omission list for audit.
 */

import {
  buildEgressApprovedSourcesPrepared,
  computeEgressApprovedSourcesView,
  computeEgressPolicyHash,
  parseEgressPolicy
} from "@evoplug/egress";
import type {
  DataClass,
  EgressApprovedSourcesInput as FndEgressInput,
  EgressApprovedSourcesPrepared as FndEgressPrepared,
  EgressApprovedSourcesView as FndEgressView,
  EgressPolicy,
  EgressSourceFact
} from "@evoplug/egress";
import { canonicalHash, err, makeErrorEnvelope, ok } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Result, SourceRef, Tx } from "@evoplug/core";
import type { BlobStore, SqlRow, SqliteConnection, StatementSource } from "@evoplug/storage";

import { containsCredentialMaterial } from "@evoplug/review";
import type {
  EgressApprovedSourcesInput as RevEgressInput,
  EgressApprovedSourcesPrepared as RevEgressPrepared,
  EgressApprovedSourcesView as RevEgressView,
  EgressAudit as ReviewEgressAudit,
  EgressAuditOmission,
  EgressSourceCategory as ReviewEgressSource
} from "@evoplug/review";

/** Receiver recorded by `evolve configure generation`. */
export interface StandingEgressReceiver {
  readonly kind: "host_cli";
  readonly host_id: string;
  readonly provider_host: string;
  readonly provider_model: string | null;
  /** Appendix N.3: record whether the provider endpoint is a local loopback. */
  readonly provider_transport?: "https" | "loopback";
}

export interface ActiveReviewEgressPolicy {
  readonly policy: EgressPolicy;
  readonly receiver: StandingEgressReceiver | null;
}

const POLICY_REF = "egress://default";

function rejected(
  code: `E_${string}`,
  category: "authorization" | "policy" | "source" | "schema",
  stage: string,
  details: Record<string, unknown>,
  messageKey = "error.review_egress_not_approved"
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category,
    message_key: messageKey,
    stage,
    retryable: false,
    side_effect: "none",
    details: details as never
  });
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseReceiver(body: string): StandingEgressReceiver | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const receiver = (value as Record<string, unknown>)["receiver"];
  if (typeof receiver !== "object" || receiver === null || Array.isArray(receiver)) return null;
  const record = receiver as Record<string, unknown>;
  if (record["kind"] !== "host_cli") return null;
  const hostId = record["host_id"];
  const providerHost = record["provider_host"];
  const providerModel = record["provider_model"];
  if (typeof hostId !== "string" || hostId.length === 0) return null;
  if (typeof providerHost !== "string" || providerHost.length === 0) return null;
  if (providerModel !== null && typeof providerModel !== "string") return null;
  const providerTransport = record["provider_transport"];
  if (
    providerTransport !== undefined &&
    providerTransport !== "https" &&
    providerTransport !== "loopback"
  ) {
    return null;
  }
  return {
    kind: "host_cli",
    host_id: hostId,
    provider_host: providerHost,
    provider_model: providerModel as string | null,
    ...(providerTransport === undefined ? {} : { provider_transport: providerTransport })
  };
}

/** Reads the single active egress policy, outside or inside a transaction. */
function queryRows(source: unknown, sql: string): SqlRow[] {
  // `StatementSource` (connection/repository) exposes `prepare().all()`; the
  // review transaction is a `LiveReadTx` that exposes `all(sql)` directly and
  // forbids anything but SELECT/WITH. Support both without changing the
  // statement.
  const candidate = source as {
    all?: <Row>(sql: string) => readonly Row[];
    prepare?: <Row>(sql: string) => { all: () => readonly Row[] };
  };
  if (typeof candidate.all === "function") {
    return [...candidate.all<SqlRow>(sql)];
  }
  if (typeof candidate.prepare === "function") {
    return [...candidate.prepare<SqlRow>(sql).all()];
  }
  throw new TypeError("egress_policy_query_source");
}

export function readActiveReviewEgressPolicy(
  source: StatementSource | unknown
): Result<ActiveReviewEgressPolicy | null, ErrorEnvelope> {
  let rows: SqlRow[];
  try {
    rows = queryRows(
      source,
      `SELECT body_json FROM policy_record
        WHERE record_kind = 'egress_policy'
          AND json_extract(body_json, '$.active') = 1`
    );
  } catch {
    return err(
      rejected("E_STORAGE_UNAVAILABLE", "source", "egress_policy", { kind: "field", path: "policy_record", rule: "read_failed" })
    );
  }
  if (rows.length === 0) return ok(null);
  if (rows.length > 1) {
    return err(
      rejected("E_EGRESS_POLICY_STALE", "authorization", "egress_policy", {
        kind: "egress",
        policy_version: "multiple_active",
        denied_dimension: "approval",
        refs: []
      }, "error.egress_policy_stale")
    );
  }
  const body = typeof rows[0]?.["body_json"] === "string" ? String(rows[0]?.["body_json"]) : null;
  if (body === null) {
    return err(
      rejected("E_EGRESS_POLICY_STALE", "authorization", "egress_policy", {
        kind: "egress",
        policy_version: "corrupt",
        denied_dimension: "approval",
        refs: []
      }, "error.egress_policy_stale")
    );
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = null;
  }
  const canonicalJson =
    typeof parsedBody === "object" && parsedBody !== null
      ? (parsedBody as Record<string, unknown>)["canonical_json"]
      : null;
  if (typeof canonicalJson !== "string") {
    return err(
      rejected("E_EGRESS_POLICY_STALE", "authorization", "egress_policy", {
        kind: "egress",
        policy_version: "corrupt",
        denied_dimension: "approval",
        refs: []
      }, "error.egress_policy_stale")
    );
  }
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(canonicalJson);
  } catch {
    policyValue = null;
  }
  const parsed = parseEgressPolicy(policyValue);
  if (!parsed.ok) return err(parsed.error);
  return ok({ policy: parsed.value, receiver: parseReceiver(body) });
}

/* ------------------------------------------------------------------ */
/* Ref resolution and provenance                                        */
/* ------------------------------------------------------------------ */

interface ResolvedRef {
  readonly ref: SourceRef;
  readonly bytes: Uint8Array | null;
  readonly retrievable: boolean;
  readonly event: SqlRow | null;
  readonly source: ReviewEgressSource;
  readonly data_class: DataClass | null;
  readonly credential: boolean;
  readonly host_id: string | null;
  readonly project_id: string | null;
  readonly digest: Hash;
}

function parseRef(ref: SourceRef): { scheme: string; locator: string; start: number; end: number } | null {
  const match = /^(journal|blob):\/\/([^#]+)#bytes=(\d+)-(\d+)$/u.exec(ref);
  if (match === null) return null;
  return {
    scheme: match[1] as string,
    locator: match[2] as string,
    start: Number(match[3]),
    end: Number(match[4])
  };
}

function eventForRef(connection: SqliteConnection, ref: SourceRef, parsed: { scheme: string; locator: string }): SqlRow | null {
  if (parsed.scheme === "journal") {
    return (
      connection
        .prepare<SqlRow>("SELECT * FROM event_log WHERE event_id = :event_id")
        .get({ event_id: parsed.locator }) ?? null
    );
  }
  if (parsed.scheme === "blob") {
    const owners = connection
      .prepare<SqlRow>(
        `SELECT owner_id FROM blob_ref
          WHERE source_ref = :ref AND owner_type = 'event'
          ORDER BY owner_id`
      )
      .all({ ref });
    const ids = new Set(owners.map((row) => String(row["owner_id"])));
    if (ids.size !== 1) return null;
    const id = [...ids][0];
    if (id === undefined) return null;
    return (
      connection
        .prepare<SqlRow>("SELECT * FROM event_log WHERE event_id = :event_id")
        .get({ event_id: id }) ?? null
    );
  }
  return null;
}

function readRefBytes(
  connection: SqliteConnection,
  blobStore: Pick<BlobStore, "read">,
  parsed: { scheme: string; locator: string; start: number; end: number }
): Uint8Array | null {
  let full: Uint8Array;
  if (parsed.scheme === "blob") {
    const read = blobStore.read(parsed.locator as Hash);
    if (!read.ok) return null;
    full = read.value;
  } else if (parsed.scheme === "journal") {
    const row = connection
      .prepare<SqlRow>("SELECT content_ref FROM event_log WHERE event_id = :event_id")
      .get({ event_id: parsed.locator });
    const contentRef = row === undefined ? null : row["content_ref"];
    if (typeof contentRef !== "string") return null;
    const nested = parseRef(contentRef as SourceRef);
    if (nested === null || nested.scheme !== "blob") return null;
    const read = blobStore.read(nested.locator as Hash);
    if (!read.ok) return null;
    full = read.value;
  } else {
    return null;
  }
  if (parsed.end > full.byteLength || parsed.start > parsed.end) return null;
  return full.subarray(parsed.start, parsed.end);
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/u,
  /\bapi[_-]?key["']?\s*[:=]\s*["'][^"']{12,}["']/iu
];

/**
 * Union of the local catalogue and the shared generator catalogue in
 * `@evoplug/review`. The local list predates the shared one and keeps the
 * historically covered shapes (long `sk-` keys, `Bearer`, `xox`, quoted
 * `api_key`) even if the shared list changes.
 */
function looksLikeCredential(text: string): boolean {
  return (
    containsCredentialMaterial(text) ||
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function categoryOf(event: SqlRow | null): ReviewEgressSource {
  if (event === null) return "agent_output";
  const eventType = typeof event["event_type"] === "string" ? event["event_type"] : "";
  if (eventType === "tool.result" || eventType === "tool.call") return "tool_result";
  if (event["origin"] === "user") return "user_input";
  return "agent_output";
}

function classOf(source: ReviewEgressSource): DataClass | null {
  switch (source) {
    case "user_input":
      return "user_text";
    case "tool_result":
      return "tool_output";
    case "agent_output":
      return "public";
    case "file_content":
      return "source_code";
    default:
      return null;
  }
}

function projectOf(connection: SqliteConnection, event: SqlRow | null): string | null {
  if (event === null) return null;
  const taskId = event["task_id"];
  if (typeof taskId !== "string") return null;
  const task = connection
    .prepare<SqlRow>("SELECT project_id FROM task WHERE task_id = :task_id")
    .get({ task_id: taskId });
  const projectId = task === undefined ? null : task["project_id"];
  return typeof projectId === "string" ? projectId : null;
}

function blobOwners(connection: SqliteConnection, ref: SourceRef): Array<{ owner_type: string; owner_id: string }> {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT owner_type, owner_id FROM blob_ref WHERE source_ref = :ref
        ORDER BY owner_type, owner_id`
    )
    .all({ ref });
  return rows.map((row) => ({
    owner_type: String(row["owner_type"]),
    owner_id: String(row["owner_id"])
  }));
}

function resolveRef(
  connection: SqliteConnection,
  blobStore: Pick<BlobStore, "read">,
  ref: SourceRef
): ResolvedRef {
  const parsed = parseRef(ref);
  if (parsed === null) {
    return {
      ref,
      bytes: null,
      retrievable: false,
      event: null,
      source: "agent_output",
      data_class: null,
      credential: false,
      host_id: null,
      project_id: null,
      digest: canonicalHash({ schema_version: "rsi.egress_provenance/1", ref })
    };
  }
  const event = eventForRef(connection, ref, parsed);
  const bytes = readRefBytes(connection, blobStore, parsed);
  const text = bytes === null ? null : decodeUtf8(bytes);
  const source = categoryOf(event);
  const credential = text !== null && looksLikeCredential(text);
  const dataClass: DataClass | null = credential
    ? "secret"
    : text === null
      ? null
      : classOf(source);
  const eventId = event === null ? null : strOrNull(event["event_id"]);
  const contentRef = event === null ? null : strOrNull(event["content_ref"]);
  const contentHash = event === null ? null : strOrNull(event["content_hash"]);
  const origin = event === null ? null : strOrNull(event["origin"]);
  const originBasis = event === null ? null : strOrNull(event["origin_basis"]);
  const humanAttestation = event === null ? null : strOrNull(event["human_attestation_json"]);
  const digest = canonicalHash({
    schema_version: "rsi.egress_provenance/1",
    source_kind: "evidence",
    ref,
    event_id: eventId,
    origin,
    origin_basis: originBasis,
    human_attestation_hash:
      humanAttestation !== null && humanAttestation.length > 0
        ? canonicalHash({ attestation: humanAttestation })
        : null,
    content_ref: contentRef,
    content_hash: contentHash,
    blob_owners: blobOwners(connection, ref)
  });
  return {
    ref,
    bytes,
    retrievable: bytes !== null,
    event,
    source,
    data_class: dataClass,
    credential,
    host_id: event !== null && typeof event["host_id"] === "string" ? event["host_id"] : null,
    project_id: projectOf(connection, event),
    digest
  };
}

/* ------------------------------------------------------------------ */
/* Ports                                                                */
/* ------------------------------------------------------------------ */

interface AuditEntry {
  readonly ref: SourceRef;
  readonly source: ReviewEgressSource;
  readonly data_class: DataClass | null;
  readonly project_excluded: boolean;
  readonly credential: boolean;
}

/** Per-prepared audit facts; the prepared object is the key. */
const PREPARED_AUDIT = new WeakMap<object, readonly AuditEntry[]>();
const PREPARED_RECEIVER = new WeakMap<object, StandingEgressReceiver | null>();

export interface ReviewEgressPortsOptions {
  readonly connection: SqliteConnection;
  readonly blob_store: Pick<BlobStore, "read">;
}

/** REV-facing port shapes; the FND brand never crosses this module. */
export interface ReviewEgressPreparationPort {
  prepareApprovedSources(
    input: RevEgressInput
  ): Promise<Result<RevEgressPrepared, ErrorEnvelope>>;
}

export interface ReviewEgressReadPort {
  getApprovedSourcesInTransaction(
    tx: Tx,
    input: RevEgressInput,
    prepared: RevEgressPrepared
  ): Result<RevEgressView, ErrorEnvelope>;
}

export interface ReviewEgressPorts {
  readonly preparation: ReviewEgressPreparationPort;
  readonly read: ReviewEgressReadPort;
  /** Outside-transaction preview used by the local (non-IPC) enqueue path. */
  preview(
    input: RevEgressInput,
    prepared: RevEgressPrepared
  ): Result<RevEgressView, ErrorEnvelope>;
}

function isProjectExcluded(policy: EgressPolicy, projectId: string | null): boolean {
  return projectId !== null && policy.project_exclusions.includes(projectId);
}

function crossSourceError(): ErrorEnvelope {
  return rejected(
    "E_AUTH_DENIED",
    "authorization",
    "egress_prepare",
    {
      kind: "authorization",
      object_type: "egress",
      denied_dimension: "scope_empty",
      reason: "cross_source_egress_not_supported"
    },
    "error.auth.denied"
  );
}

function noPolicyError(): ErrorEnvelope {
  return rejected(
    "E_REVIEW_EGRESS_NOT_APPROVED",
    "authorization",
    "egress_prepare",
    { kind: "egress", policy_version: "none", denied_dimension: "approval", refs: [] }
  );
}

export function createReviewEgressPorts(options: ReviewEgressPortsOptions): ReviewEgressPorts {
  const { connection, blob_store } = options;

  const preparation: ReviewEgressPreparationPort = {
    async prepareApprovedSources(input: RevEgressInput): Promise<Result<RevEgressPrepared, ErrorEnvelope>> {
      const fndInput: FndEgressInput = {
        schema_version: "rsi.egress_approved_sources_in/1",
        policy_ref: POLICY_REF,
        evidence_refs: [...input.evidence_refs],
        experience_refs: [...input.experience_refs]
      };
      const active = readActiveReviewEgressPolicy(connection);
      if (!active.ok) return active;
      if (active.value === null) return err(noPolicyError());
      const { policy, receiver } = active.value;
      const resolved = fndInput.evidence_refs.map((ref) => resolveRef(connection, blob_store, ref));

      // Same-source route only: the receiver recorded by `configure
      // generation` must be the host that produced every evidence event.
      if (receiver !== null) {
        for (const item of resolved) {
          if (item.host_id !== null && item.host_id !== receiver.host_id) {
            return err(crossSourceError());
          }
        }
      }

      const facts: EgressSourceFact[] = [
        ...resolved.map((item) => ({
          source_kind: "evidence" as const,
          ref: item.ref,
          retrievable: item.retrievable,
          content_version: item.retrievable ? canonicalHash({ ref: item.ref, digest: item.digest }) : null,
          range_content_hash: item.retrievable ? item.digest : null,
          data_class: item.retrievable ? item.data_class : null,
          provenance_digest: item.digest
        })),
        ...fndInput.experience_refs.map((ref) => ({
          source_kind: "experience" as const,
          ref,
          retrievable: false,
          content_version: null,
          range_content_hash: null,
          data_class: null,
          provenance_digest: canonicalHash({ schema_version: "rsi.egress_provenance/1", ref })
        }))
      ];
      const built = buildEgressApprovedSourcesPrepared({
        input: fndInput,
        policy_version: policy.policy_version,
        policy_hash: computeEgressPolicyHash(policy),
        facts
      });
      if (!built.ok) return built;
      PREPARED_AUDIT.set(
        built.value,
        resolved.map((item) => ({
          ref: item.ref,
          source: item.source,
          data_class: item.data_class,
          project_excluded: isProjectExcluded(policy, item.project_id),
          credential: item.credential
        }))
      );
      PREPARED_RECEIVER.set(built.value, receiver);
      return ok(built.value as unknown as RevEgressPrepared);
    }
  };

  const auditFor = (
    prepared: RevEgressPrepared,
    fndView: FndEgressView,
    receiver: StandingEgressReceiver | null
  ): ReviewEgressAudit => {
    const facts = PREPARED_AUDIT.get(prepared as unknown as object) ?? [];
    const byRef = new Map(facts.map((fact) => [fact.ref, fact]));
    const approved = new Set<SourceRef>([
      ...fndView.approved_evidence_refs,
      ...fndView.approved_experience_refs
    ]);
    const omitted: EgressAuditOmission[] = [...fndView.rejected_sources].map((entry) => {
      const fact = byRef.get(entry.ref);
      const reason =
        fact?.credential === true
          ? "credential_text"
          : fact?.project_excluded === true
            ? "project_excluded"
            : entry.reason === "source_unretrievable"
              ? "source_unretrievable"
              : entry.reason === "unclassified"
                ? "unclassified"
                : entry.reason === "secret_forbidden"
                  ? "secret_forbidden"
                  : "data_class_not_allowed";
      return {
        ref: entry.ref,
        source: fact?.source ?? "agent_output",
        data_class: entry.data_class,
        reason
      } as const;
    });
    // Project exclusion removes an otherwise eligible source from the
    // approved subset and records it in the omission list.
    const excluded = facts.filter((fact) => fact.project_excluded && approved.has(fact.ref));
    for (const fact of excluded) {
      omitted.push({
        ref: fact.ref,
        source: fact.source,
        data_class: fact.data_class,
        reason: "project_excluded"
      });
    }
    const evidence = [...approved]
      .filter((ref) => !excluded.some((fact) => fact.ref === ref))
      .sort()
      .map((ref) => {
        const fact = byRef.get(ref);
        return {
          ref,
          source: fact?.source ?? "agent_output",
          data_class: fact?.data_class ?? null
        };
      });
    return {
      policy_version: fndView.egress_policy_version,
      receiver: receiver ?? {
        kind: "host_cli",
        host_id: "unknown",
        provider_host: "unknown",
        provider_model: null
      },
      evidence_count: evidence.length,
      evidence,
      omitted
    };
  };

  const buildView = (
    policy: EgressPolicy,
    input: RevEgressInput,
    prepared: RevEgressPrepared,
    receiver: StandingEgressReceiver | null
  ): Result<RevEgressView, ErrorEnvelope> => {
    const fndInput: FndEgressInput = {
      schema_version: "rsi.egress_approved_sources_in/1",
      policy_ref: POLICY_REF,
      evidence_refs: [...input.evidence_refs],
      experience_refs: [...input.experience_refs]
    };
    const computed = computeEgressApprovedSourcesView(
      policy,
      fndInput,
      prepared as unknown as FndEgressPrepared
    );
    if (!computed.ok) return err(computed.error);
    const audit = auditFor(prepared, computed.value, receiver);
    const omittedRefs = new Set(audit.omitted.map((entry) => entry.ref));
    const approvedEvidence = computed.value.approved_evidence_refs.filter((ref) => !omittedRefs.has(ref));
    const approvedExperience = computed.value.approved_experience_refs.filter((ref) => !omittedRefs.has(ref));
    const rejectedSources: RevEgressView["rejected_sources"] = computed.value.rejected_sources.map((entry) => {
      const reason =
        entry.reason === "source_unretrievable"
          ? "source_missing"
          : entry.reason === "unclassified"
            ? "classifier_unknown"
            : "not_approved";
      return { ref: entry.ref, reason } as const;
    });
    for (const entry of audit.omitted) {
      if (!rejectedSources.some((item) => item.ref === entry.ref)) {
        rejectedSources.push({ ref: entry.ref, reason: "not_approved" });
      }
    }
    return ok({
      schema_version: "rsi.egress_approved_sources_view/1",
      egress_policy_ref: POLICY_REF,
      egress_policy_version: computed.value.egress_policy_version,
      approved_evidence_refs: approvedEvidence,
      approved_experience_refs: approvedExperience,
      rejected_sources: rejectedSources,
      audit
    });
  };

  const read: ReviewEgressReadPort = {
    getApprovedSourcesInTransaction(
      tx: Tx,
      input: RevEgressInput,
      prepared: RevEgressPrepared
    ): Result<RevEgressView, ErrorEnvelope> {
      try {
        const active = readActiveReviewEgressPolicy(tx as unknown as StatementSource);
        if (!active.ok) return active;
        if (active.value === null) return err(noPolicyError());
        const receiver = PREPARED_RECEIVER.get(prepared as unknown as object) ?? active.value.receiver;
        return buildView(active.value.policy, input, prepared, receiver);
      } catch (error) {
        if (process.env["EVOPLUG_DEBUG_EGRESS"] === "1") {
          process.stderr.write(`${JSON.stringify({
            message: "debug.egress_read_threw",
            error: error instanceof Error ? `${error.name}:${error.message}` : String(error),
            stack: error instanceof Error ? error.stack : null
          })}\n`);
        }
        throw error;
      }
    }
  };

  return {
    preparation,
    read,
    preview(input, prepared) {
      const active = readActiveReviewEgressPolicy(connection);
      if (!active.ok) return active;
      if (active.value === null) return err(noPolicyError());
      const receiver = PREPARED_RECEIVER.get(prepared as unknown as object) ?? active.value.receiver;
      return buildView(active.value.policy, input, prepared, receiver);
    }
  };
}
