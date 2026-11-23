/**
 * Default QP production composition (DD-QP-26a).
 *
 * Builds one {@link QuestionPlanner} from real SQLite, journal and blob
 * state: the evidence-index loader reads the ledger, facts, verifiers and
 * committed HOST progress checkpoints, the QP repositories persist through
 * the FND writer gate, and the source ports freeze real blob bytes.
 *
 * The planner holds one frozen evidence snapshot. A new watermark needs a new
 * planner; callers must not reuse a bundle across bindings.
 */

import { performance } from "node:perf_hooks";

import {
  canonicalHash,
  err,
  isHash,
  isSourceRef,
  makeErrorEnvelope,
  objectDocumentId,
  ok
} from "@evoplug/core";
import type {
  Clock,
  ErrorEnvelope,
  JsonValue,
  Result,
  SourceRef,
  SourceRefPort,
  VersionBinding
} from "@evoplug/core";
import { parseJcsColumn } from "@evoplug/core/host";
import {
  buildTemplateRegistry,
  createIssueRepository,
  createPlanRepository,
  createQuestionPlanner
} from "@evoplug/core/evidence";
import type { ConfirmationEvidence, EvidenceGap, EvidenceIndexLoadRequest, FrozenSourceExpectationPort, Issue, IssueWriteRepository, QuestionPlan, QuestionPlanRepository, QuestionPlanner, QuestionTemplateRegistry, QpJournalCommitPort as CoreQpJournalCommitPort, QpJournalDecision as CoreQpJournalDecision, QpJournalEvent as CoreQpJournalEvent, QpLiveCommitOutcome as CoreQpLiveCommitOutcome, QpLiveStage as CoreQpLiveStage, QpReadSource, SourceCheckPort } from "@evoplug/core/evidence";
import {
  buildStateFactView,
  LedgerReadService,
  parseJsonArrayStrings,
  parseSourceRefArray
} from "@evoplug/ledger";
import type {
  LedgerEventLogPort,
  LedgerIdentityReadPort,
  LedgerPorts,
  LedgerProjectionReadPort,
  LedgerSourceEvent,
  StateFactStateRow,
  FactVerificationStateRow,
  StateFactView as LedgerStateFactView,
  VerifierRegistryView as LedgerVerifierView
} from "@evoplug/ledger";
import {
  createAcceptedAggregateReader,
  createEvidenceIndexSnapshotLoader,
  MAX_PROGRESS_CHECKPOINTS,
  MAX_PROGRESS_WATERMARK_SPAN
} from "@evoplug/evidence";
import type {
  EvidenceIndexSnapshot as LoadedEvidenceIndexSnapshot,
  EvidenceIndexSnapshotLoader as LoadedEvidenceIndexSnapshotLoader,
  EvidenceIndexSnapshotLoaderDeps,
  FactReadPort as EvidenceFactReadPort,
  ProgressCheckpointReadError,
  ProgressCheckpointReadPort,
  ProgressCheckpointReadView,
  ReviewSnapshotView,
  StateFactView as EvidenceStateFactView,
  VerifierRegistryPort as EvidenceVerifierRegistryPort,
  VerifierRegistryView as EvidenceVerifierView
} from "@evoplug/evidence";
import {
  createTransactionRunner,
  expectedCommitRecords,
  insertCommitRecord,
  isErrorEnvelope,
  receiptRelativePath,
  recordFrameDurability,
  storageDetails,
  storageError
} from "@evoplug/storage";
import type {
  BlobStore,
  JournalAppendResult,
  JournalFramePayload,
  JournalWriter,
  SqliteConnection,
  Tx
} from "@evoplug/storage";

import { replayQpJournalFrame } from "./qp-recovery.js";
import { createDefaultEvidenceReader } from "./default-evidence-reader.js";
import { createSourceRefPort } from "./source-ref-port.js";
import type {
  OnlineCloseEvidenceDraft,
  OnlineIssue,
  OnlinePlanState,
  OnlineQuestionPlan,
  OnlineQuestionTemplateRegistry,
  QpDiscoveryInput,
  QpDiscoveryResult,
  QpPipelineDeps,
  QpPlannerPort,
  QpPlanningResult,
  QpTransitionResult
} from "./online-pipeline.js";

const DEFAULT_QP_DETECTOR_VERSION = "qp.issue_detector/1";
const DEFAULT_QP_PLANNER_VERSION = "qp.planner/1";
const DEFAULT_QP_REGISTRY_VERSION = "qp.registry/1";

type Row = Readonly<Record<string, unknown>>;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function integer(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function upstreamCode(error: ErrorEnvelope): string {
  return error.code;
}

function internalFailure(code: string, stage: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: code as ErrorEnvelope["code"],
    category: "internal",
    message_key: `error.${code.toLowerCase()}`,
    stage,
    details: { kind: "none" }
  });
}

/* ------------------------------------------------------------------ */
/* Evidence ledger read port                                          */
/* ------------------------------------------------------------------ */

/**
 * `EvidenceLedgerReadPort` over the committed SQLite projections.
 *
 * `LedgerReadService` needs the read side only; the remaining `LedgerPorts`
 * members belong to the FND write path and are never reached from this port.
 * Supplying them as opaque fail-closed stubs keeps accidental write access
 * out of a read-only composition.
 */
function createLedgerReadPort(
  connection: SqliteConnection
): EvidenceIndexSnapshotLoaderDeps["ledger"] {
  const query = (
    sql: string,
    q: { task_id: string; branch_id: string; watermark: number },
    includeWatermark = true
  ): Row[] =>
    connection
      .prepare<Row>(sql)
      .all({
        task_id: q.task_id,
        branch_id: q.branch_id,
        ...(includeWatermark ? { watermark: q.watermark } : {})
      });

  const projection: LedgerProjectionReadPort = {
    listRequirementRows: async (q) =>
      ok(
        query(
          `SELECT * FROM requirement
            WHERE task_id = :task_id AND branch_id = :branch_id
              AND valid_from_event <= :watermark
              AND (valid_to_event IS NULL OR valid_to_event > :watermark)
            ORDER BY requirement_id ASC, revision ASC`,
          q
        ) as never
      ),
    listRequirementOpRows: async (q) =>
      ok(
        query(
          `SELECT * FROM requirement_op
            WHERE task_id = :task_id AND branch_id = :branch_id
              AND valid_from_event <= :watermark
              AND (valid_to_event IS NULL OR valid_to_event > :watermark)
            ORDER BY valid_from_event ASC, op_id ASC`,
          q
        ) as never
      ),
    listRequirementSources: async (q) =>
      ok(
        query(
          `SELECT rs.* FROM requirement_source rs
             JOIN requirement r ON r.requirement_id = rs.requirement_id
              AND r.revision = rs.requirement_revision
            WHERE r.task_id = :task_id AND r.branch_id = :branch_id
              AND r.valid_from_event <= :watermark
              AND (r.valid_to_event IS NULL OR r.valid_to_event > :watermark)`,
          q
        ) as never
      ),
    listRequirementHeads: async (q) =>
      ok(
        query(
          `SELECT h.* FROM requirement_head h
             JOIN requirement r ON r.requirement_id = h.requirement_id
              AND r.revision = h.revision
            WHERE r.task_id = :task_id AND r.branch_id = :branch_id
              AND r.valid_from_event <= :watermark
              AND (r.valid_to_event IS NULL OR r.valid_to_event > :watermark)`,
          q
        ) as never
      ),
    listGoalSnapshots: async (q) =>
      ok(
        connection
          .prepare<Row>(
            `SELECT * FROM goal_snapshot
              WHERE task_id = :task_id AND source_branch_id = :branch_id
                AND local_goal_version = :goal_version AND watermark <= :watermark
              ORDER BY watermark ASC, local_goal_revision ASC, created_at ASC, snapshot_id ASC`
          )
          .all({
            task_id: q.task_id,
            branch_id: q.branch_id,
            goal_version: q.goal_version,
            watermark: q.watermark_max
          }) as never
      ),
    listFeedbackRows: async (q) =>
      ok(
        query(
          "SELECT * FROM feedback WHERE task_id = :task_id AND branch_id = :branch_id",
          q,
          false
        ) as never
      ),
    listConstraintRows: async (q) =>
      ok(
        query(
          "SELECT * FROM unverified_constraint WHERE task_id = :task_id AND branch_id = :branch_id",
          q,
          false
        ) as never
      ),
    listCorrectionRows: async (q) =>
      ok(
        query(
          `SELECT * FROM ledger_correction
            WHERE task_id = :task_id AND branch_id = :branch_id AND valid_from_event <= :watermark`,
          q
        ) as never
      ),
    listFactRows: async (q) =>
      ok(
        query(
          "SELECT * FROM state_fact WHERE task_id = :task_id AND branch_id = :branch_id AND watermark <= :watermark",
          q
        ) as never
      ),
    listFactVerificationRows: async (q) =>
      ok(
        query(
          `SELECT * FROM fact_verification
            WHERE watermark <= :watermark
              AND fact_id IN (SELECT fact_id FROM state_fact WHERE task_id = :task_id AND branch_id = :branch_id)`,
          q
        ) as never
      ),
    listSuccessEvidenceRows: async (q) =>
      ok(
        query(
          `SELECT * FROM success_evidence
            WHERE task_id = :task_id AND branch_id = :branch_id AND recorded_at_watermark <= :watermark`,
          q
        ) as never
      ),
    listTaskOutcomeRows: async (q) =>
      ok(
        query(
          `SELECT * FROM task_outcome
            WHERE task_id = :task_id AND branch_id = :branch_id
              AND CAST(json_extract(version_binding_json, '$.watermark') AS INTEGER) <= :watermark`,
          q
        ) as never
      )
  };

  const events: LedgerEventLogPort = {
    async getEvent(eventId) {
      const row = connection
        .prepare<Row>("SELECT * FROM event_log WHERE event_id = :event_id")
        .get({ event_id: eventId });
      if (row === undefined) return ok(null);
      const event: LedgerSourceEvent = {
        event_id: text(row, "event_id") as LedgerSourceEvent["event_id"],
        event_key: text(row, "event_key") as LedgerSourceEvent["event_key"],
        event_type: text(row, "event_type"),
        host_id: text(row, "host_id") as LedgerSourceEvent["host_id"],
        config_space: text(row, "config_space"),
        session_id: text(row, "session_id") as LedgerSourceEvent["session_id"],
        task_id: text(row, "task_id") as LedgerSourceEvent["task_id"],
        branch_id: text(row, "branch_id") as LedgerSourceEvent["branch_id"],
        input_id: nullableText(row, "input_id") as LedgerSourceEvent["input_id"],
        input_epoch: row["input_epoch"] === null ? null : integer(row, "input_epoch"),
        goal_version: text(row, "goal_version"),
        config_version: text(row, "config_version"),
        watermark: integer(row, "watermark"),
        origin: text(row, "origin") as LedgerSourceEvent["origin"],
        human_attestation: null,
        native_session_id: null,
        directive_strength: null,
        trigger_lineage: {
          axis: text(row, "trigger_axis") as LedgerSourceEvent["trigger_lineage"]["axis"],
          root_event_id: nullableText(row, "trigger_root_event_id") as LedgerSourceEvent["trigger_lineage"]["root_event_id"],
          depth: integer(row, "trigger_depth")
        },
        correlation_id: text(row, "correlation_id") as LedgerSourceEvent["correlation_id"]
      };
      return ok(event);
    }
  };

  const identity: LedgerIdentityReadPort = {
    getSession: async () => ok(null),
    findSession: async () => ok(null),
    listNativeMappings: async () => ok([]),
    getBranch: async () => ok(null),
    async getReceiptSeq() {
      const row = connection
        .prepare<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'receipt_seq'")
        .get();
      const parsed = row === undefined ? 0 : Number(row.value);
      return ok(Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0);
    },
    findForkIdempotency: async () => ok(null)
  };

  // Only `identity`, `projection` and `events` are reachable through
  // `readEvidenceLedger`. The cast avoids pretending the write ports exist.
  const ports = { identity, projection, events } as unknown as LedgerPorts;
  const service = new LedgerReadService(ports);
  return {
    readEvidenceLedger: (q: { binding: VersionBinding }) =>
      service.readEvidenceLedger(q)
  } as EvidenceIndexSnapshotLoaderDeps["ledger"];
}

/* ------------------------------------------------------------------ */
/* Facts and verifier registry read ports                             */
/* ------------------------------------------------------------------ */

function parseJsonOrNull(text: string): JsonValue | null {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

function verifierView(
  row: FactVerificationStateRow,
  binding: VersionBinding
): LedgerVerifierView | null {
  const reservationIds = parseJsonArrayStrings(row.reservation_ids_json);
  const requirementIds = parseJsonArrayStrings(row.requirement_ids_json);
  const propositionIds = parseJsonArrayStrings(row.proposition_ids_json);
  const sourceIds = parseJsonArrayStrings(row.source_ids_json);
  const sourceRefs = parseSourceRefArray(row.source_refs_json);
  if (
    reservationIds === null ||
    requirementIds === null ||
    propositionIds === null ||
    sourceIds === null ||
    sourceRefs === null
  ) {
    return null;
  }
  return {
    schema_version: "rsi.fact_verification/1",
    fact_id: row.fact_id,
    event_id: row.event_id,
    verifier_ref: row.verifier_ref,
    verifier_id: row.verifier_id,
    verifier_kind: row.verifier_kind,
    method_ref: row.method_ref_json === null ? null : parseJsonOrNull(row.method_ref_json),
    reservation_ids: [...reservationIds],
    independent: row.independent === 1,
    verification_binding: {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: row.input_epoch,
      goal_version: row.goal_version,
      config_version: row.config_version,
      watermark: row.watermark
    },
    requirement_ids: [...requirementIds],
    proposition_ids: [...propositionIds],
    effect: row.effect,
    artifact_version: row.artifact_version,
    source_ids: sourceIds,
    source_refs: sourceRefs,
    result: row.result,
    status: row.status,
    verified_at: row.verified_at,
    row_version: row.row_version
  } as unknown as LedgerVerifierView;
}

function visibleVerificationRows(
  connection: SqliteConnection,
  binding: VersionBinding
): FactVerificationStateRow[] {
  return connection
    .prepare<Row>(
      `SELECT fv.* FROM fact_verification fv
        JOIN state_fact f ON f.fact_id = fv.fact_id
       WHERE f.task_id = :task_id AND f.branch_id = :branch_id
         AND fv.watermark <= :watermark
       ORDER BY fv.fact_id ASC, fv.verifier_ref ASC`
    )
    .all({
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      watermark: binding.watermark
    }) as unknown as FactVerificationStateRow[];
}

function createFactReadPort(connection: SqliteConnection): EvidenceFactReadPort {
  return {
    async listFacts({ binding }) {
      const factRows = connection
        .prepare<Row>(
          `SELECT * FROM state_fact
            WHERE task_id = :task_id AND branch_id = :branch_id AND watermark <= :watermark
            ORDER BY fact_id ASC`
        )
        .all({
          task_id: binding.task_id,
          branch_id: binding.branch_id,
          watermark: binding.watermark
        }) as unknown as StateFactStateRow[];
      const byFact = new Map<string, LedgerVerifierView[]>();
      for (const raw of visibleVerificationRows(connection, binding)) {
        const view = verifierView(raw, binding);
        if (view === null) continue;
        const list = byFact.get(view.fact_id) ?? [];
        list.push(view);
        byFact.set(view.fact_id, list);
      }
      const facts: LedgerStateFactView[] = [];
      for (const row of factRows) {
        const view = buildStateFactView(row, byFact.get(row.fact_id) ?? []);
        if (view !== null) facts.push(view);
      }
      return facts as unknown as readonly EvidenceStateFactView[];
    }
  };
}

function createVerifierReadPort(connection: SqliteConnection): EvidenceVerifierRegistryPort {
  return {
    async listVerifiers({ binding }) {
      const views: LedgerVerifierView[] = [];
      for (const raw of visibleVerificationRows(connection, binding)) {
        if (raw.status !== "valid") continue;
        const view = verifierView(raw, binding);
        if (view !== null) views.push(view);
      }
      return views as unknown as readonly EvidenceVerifierView[];
    }
  };
}

/* ------------------------------------------------------------------ */
/* Progress checkpoint read port                                      */
/* ------------------------------------------------------------------ */

function progressError(code: ProgressCheckpointReadError["code"]): ProgressCheckpointReadError {
  return { code };
}

function documentString(document: Record<string, unknown>, key: string): string | null {
  const value = document[key];
  return typeof value === "string" ? value : null;
}

function documentInteger(document: Record<string, unknown>, key: string): number | null {
  const value = document[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function uniqueSortedText(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Present `pending_observation.fields[].ref` values, in document order. */
function presentPendingRefs(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  const refs: string[] = [];
  for (const field of fields) {
    if (typeof field !== "object" || field === null || Array.isArray(field)) continue;
    const entry = field as Record<string, unknown>;
    if (entry["state"] === "present" && typeof entry["ref"] === "string") {
      refs.push(entry["ref"]);
    }
  }
  return refs;
}

function rejection(code: ProgressCheckpointReadError["code"]): {
  ok: false;
  status: "rejected";
  error: ProgressCheckpointReadError;
} {
  return { ok: false, status: "rejected", error: progressError(code) };
}

/**
 * Reads HOST progress checkpoints with the DD-TRG-011 document contract.
 *
 * The typed row and the `object_document`/`object_head` body are compared
 * against each other, never against the request: the request scope only
 * filters the SQL window. The frozen document hash, its binding fields and
 * the `source_refs_json` preimage (trigger source event plus present pending
 * observation refs) must all agree, or the load fails closed.
 */
const PROGRESS_ROW_SELECT = `
  SELECT pc.checkpoint_id AS typed_checkpoint_id,
         pc.owner AS typed_owner, pc.object_type AS typed_object_type,
         pc.revision AS typed_revision, pc.state AS typed_state,
         pc.checkpoint_kind AS typed_checkpoint_kind,
         pc.task_id AS typed_task_id, pc.branch_id AS typed_branch_id,
         pc.input_epoch AS typed_input_epoch,
         pc.goal_version AS typed_goal_version,
         pc.config_version AS typed_config_version,
         pc.watermark AS typed_watermark,
         pc.trigger_event_id AS typed_trigger_event_id,
         pc.source_event_ref AS typed_source_event_ref,
         pc.source_refs_json AS typed_source_refs_json,
         pc.content_hash AS typed_content_hash,
         pc.created_at AS typed_created_at,
         d.document_id AS document_id,
         d.owner AS document_owner,
         d.object_type AS document_object_type,
         d.revision AS document_revision,
         d.schema_version AS document_schema_version,
         d.state AS document_state,
         d.content_hash AS document_content_hash,
         d.canonical_json AS document_canonical_json,
         h.document_id AS head_document_id,
         h.revision AS head_revision,
         h.state AS head_state,
         h.content_hash AS head_content_hash
    FROM progress_checkpoint pc
    LEFT JOIN object_document d
      ON d.object_id = pc.checkpoint_id AND d.revision = pc.revision
     AND d.owner = 'host' AND d.object_type = 'progress_checkpoint'
    LEFT JOIN object_head h
      ON h.object_id = pc.checkpoint_id
     AND h.owner = 'host' AND h.object_type = 'progress_checkpoint'
`;

const PROGRESS_TASK_STATES: ReadonlySet<string> = new Set([
  "advancing",
  "information_gain",
  "stalled_candidate",
  "regressing",
  "baseline",
  "waiting",
  "blocked",
  "paused",
  "cancelled",
  "collection_gap",
  "unknown"
]);

interface ProgressSegmentContext {
  readonly comparability_key: string;
  readonly task_process_state: unknown;
  readonly consecutive_no_info: number;
  readonly span_from_baseline_ms: number;
  readonly has_baseline_ptr: boolean;
  readonly has_previous_ptr: boolean;
}

type ParsedProgressRow =
  | { readonly ok: true; readonly view: ProgressCheckpointReadView; readonly segment: ProgressSegmentContext }
  | { readonly ok: false; readonly code: ProgressCheckpointReadError["code"] };

function parseProgressRow(
  row: Row,
  binding: VersionBinding,
  position: { readonly kind: "window"; readonly from_watermark: number; readonly to_watermark: number } | { readonly kind: "predecessor"; readonly before_watermark: number }
): ParsedProgressRow {
  const checkpointId = text(row, "typed_checkpoint_id");
  const contentHash = text(row, "typed_content_hash");
  if (
    text(row, "typed_owner") !== "host" ||
    text(row, "typed_object_type") !== "progress_checkpoint" ||
    integer(row, "typed_revision") !== 1 ||
    text(row, "typed_state") !== "recorded"
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const documentId = text(row, "document_id");
  if (
    documentId.length === 0 ||
    documentId !==
      objectDocumentId({
        owner: "host",
        object_type: "progress_checkpoint",
        object_id: checkpointId,
        revision: 1
      }) ||
    text(row, "document_owner") !== "host" ||
    text(row, "document_object_type") !== "progress_checkpoint" ||
    integer(row, "document_revision") !== 1 ||
    text(row, "document_schema_version") !== "rsi.progress_checkpoint/1" ||
    text(row, "document_state") !== "recorded" ||
    text(row, "document_content_hash") !== contentHash
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (
    text(row, "head_document_id") !== documentId ||
    integer(row, "head_revision") !== 1 ||
    text(row, "head_state") !== "recorded" ||
    text(row, "head_content_hash") !== contentHash
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const canonical = text(row, "document_canonical_json");
  const parsed = canonical.length === 0 ? null : parseJcsColumn(canonical, "canonical_json");
  if (parsed === null || !parsed.ok) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const document = record(parsed.value);
  if (document === null || canonicalHash(parsed.value) !== contentHash) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (
    document["schema_version"] !== "rsi.progress_checkpoint/1" ||
    document["checkpoint_id"] !== checkpointId
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  // The typed row is the authority; the document body may neither disagree
  // with it nor substitute the request binding.
  const typedWatermark = integer(row, "typed_watermark");
  if (
    documentString(document, "task_id") !== text(row, "typed_task_id") ||
    documentString(document, "branch_id") !== text(row, "typed_branch_id") ||
    documentInteger(document, "input_epoch") !== integer(row, "typed_input_epoch") ||
    documentString(document, "goal_version") !== text(row, "typed_goal_version") ||
    documentString(document, "config_version") !== text(row, "typed_config_version") ||
    documentInteger(document, "watermark") !== typedWatermark
  ) {
    return { ok: false, code: "E_PROGRESS_SCOPE_MISMATCH" };
  }
  if (
    text(row, "typed_task_id") !== binding.task_id ||
    text(row, "typed_branch_id") !== binding.branch_id ||
    integer(row, "typed_input_epoch") !== binding.input_epoch ||
    text(row, "typed_goal_version") !== binding.goal_version ||
    text(row, "typed_config_version") !== binding.config_version
  ) {
    return { ok: false, code: "E_PROGRESS_SCOPE_MISMATCH" };
  }
  if (position.kind === "window") {
    if (typedWatermark < position.from_watermark) {
      return { ok: false, code: "E_PROGRESS_SCOPE_MISMATCH" };
    }
    if (typedWatermark > position.to_watermark) {
      return { ok: false, code: "E_PROGRESS_WINDOW" };
    }
  } else if (!(typedWatermark < position.before_watermark)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const checkpointKind = text(row, "typed_checkpoint_kind");
  if (
    (checkpointKind !== "input_boundary" && checkpointKind !== "stable_boundary") ||
    document["checkpoint_kind"] !== checkpointKind
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  if (
    documentInteger(document, "created_at") !== integer(row, "typed_created_at") ||
    documentString(document, "trigger_event_id") !== text(row, "typed_trigger_event_id")
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const taskProcessState = document["task_process_state"];
  const comparabilityKey = document["comparability_key"];
  const evidenceDigest = document["evidence_digest"];
  const coverage = document["evidence_coverage"];
  const pending = record(document["pending_observation"]);
  const pendingState = pending?.["state"];
  if (
    typeof taskProcessState !== "string" ||
    !PROGRESS_TASK_STATES.has(taskProcessState) ||
    typeof comparabilityKey !== "string" ||
    !isHash(comparabilityKey) ||
    typeof evidenceDigest !== "string" ||
    !isHash(evidenceDigest) ||
    (coverage !== "complete" && coverage !== "partial" && coverage !== "gap") ||
    (pendingState !== "none" && pendingState !== "pending" && pendingState !== "unknown")
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const consecutive = documentInteger(document, "consecutive_no_info");
  const span = documentInteger(document, "span_from_baseline_ms");
  if (consecutive === null || consecutive < 0 || span === null || span < 0) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const sourceEventRef = text(row, "typed_source_event_ref");
  const refs = parseJcsColumn(text(row, "typed_source_refs_json"), "source_refs_json");
  if (!refs.ok || !Array.isArray(refs.value) || !isSourceRef(sourceEventRef)) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const storedRefs: SourceRef[] = [];
  for (const entry of refs.value) {
    if (typeof entry !== "string" || !isSourceRef(entry)) {
      return { ok: false, code: "E_PROGRESS_DATA" };
    }
    storedRefs.push(entry);
  }
  // DD-TRG-011 preimage: trigger source event plus every present
  // pending-observation ref, unique and UTF-8 sorted.
  const expectedRefs = uniqueSortedText([
    sourceEventRef,
    ...presentPendingRefs(pending?.["fields"])
  ]);
  if (
    storedRefs.length === 0 ||
    storedRefs.length !== expectedRefs.length ||
    storedRefs.some((ref, index) => ref !== expectedRefs[index])
  ) {
    return { ok: false, code: "E_PROGRESS_DATA" };
  }
  const baselineId = document["baseline_checkpoint_id"];
  const previousId = document["previous_comparable_checkpoint_id"];
  const view: ProgressCheckpointReadView = {
    schema_version: "rsi.progress_checkpoint/1",
    checkpoint_id: checkpointId as ProgressCheckpointReadView["checkpoint_id"],
    binding: {
      task_id: text(row, "typed_task_id") as VersionBinding["task_id"],
      branch_id: text(row, "typed_branch_id") as VersionBinding["branch_id"],
      input_epoch: integer(row, "typed_input_epoch"),
      goal_version: text(row, "typed_goal_version"),
      config_version: text(row, "typed_config_version"),
      watermark: typedWatermark
    },
    watermark: typedWatermark,
    task_process_state: taskProcessState as ProgressCheckpointReadView["task_process_state"],
    comparability_key: comparabilityKey as ProgressCheckpointReadView["comparability_key"],
    evidence_digest: evidenceDigest as ProgressCheckpointReadView["evidence_digest"],
    evidence_coverage: coverage,
    pending_state: pendingState,
    baseline_checkpoint_id:
      typeof baselineId === "string"
        ? (baselineId as ProgressCheckpointReadView["baseline_checkpoint_id"] & string)
        : null,
    previous_comparable_checkpoint_id:
      typeof previousId === "string"
        ? (previousId as ProgressCheckpointReadView["previous_comparable_checkpoint_id"] & string)
        : null,
    source_refs: storedRefs,
    created_at: integer(row, "typed_created_at")
  };
  return {
    ok: true,
    view,
    segment: {
      comparability_key: comparabilityKey,
      task_process_state: taskProcessState,
      consecutive_no_info: consecutive,
      span_from_baseline_ms: span,
      has_baseline_ptr: baselineId !== undefined,
      has_previous_ptr: previousId !== undefined
    }
  };
}

function baselineSegmentShapeValid(segment: ProgressSegmentContext): boolean {
  return (
    segment.consecutive_no_info === 0 &&
    segment.span_from_baseline_ms === 0 &&
    !segment.has_baseline_ptr &&
    !segment.has_previous_ptr
  );
}

/**
 * Reads HOST progress checkpoints with the DD-TRG-011 document contract.
 *
 * The typed row and the `object_document`/`object_head` body are compared
 * against each other, never against the request: the request scope only
 * filters the SQL window. The frozen document hash, its binding fields and
 * the `source_refs_json` preimage (trigger source event plus present pending
 * observation refs) must all agree, and the predecessor plus the in-window
 * sequence must form valid comparison segments (first window row baseline
 * without a predecessor, baseline exactly at each comparability boundary,
 * zero counters and no pointers on every baseline).
 */
function createProgressReadPort(
  connection: SqliteConnection,
  monotonicNow: () => number = () => performance.now()
): ProgressCheckpointReadPort {
  return {
    async listCheckpoints(q) {
      if (
        !Number.isSafeInteger(q.from_watermark) ||
        !Number.isSafeInteger(q.to_watermark) ||
        q.from_watermark < 0 ||
        q.from_watermark > q.to_watermark ||
        q.to_watermark > q.binding.watermark ||
        q.to_watermark - q.from_watermark > MAX_PROGRESS_WATERMARK_SPAN
      ) {
        return rejection("E_PROGRESS_WINDOW");
      }
      if (typeof q.deadline_ms !== "number" || !Number.isFinite(q.deadline_ms) || q.deadline_ms <= 0) {
        return rejection("E_PROGRESS_REQUEST");
      }
      const deadline = monotonicNow() + q.deadline_ms;
      const checkDeadline = (): ProgressCheckpointReadError["code"] | null => {
        if (q.signal?.aborted === true) return "E_PROGRESS_CANCELLED";
        if (monotonicNow() >= deadline) return "E_PROGRESS_DEADLINE";
        return null;
      };
      const beforeSql = checkDeadline();
      if (beforeSql !== null) return rejection(beforeSql);
      try {
        const scope = {
          task_id: q.binding.task_id,
          branch_id: q.binding.branch_id,
          input_epoch: q.binding.input_epoch,
          goal_version: q.binding.goal_version,
          config_version: q.binding.config_version
        };
        const history = connection
          .prepare<{ one: number }>(
            `SELECT 1 AS one FROM progress_checkpoint
              WHERE task_id = :task_id AND branch_id = :branch_id
                AND input_epoch = :input_epoch AND goal_version = :goal_version
                AND config_version = :config_version AND watermark <= :watermark
              LIMIT 1`
          )
          .get({ ...scope, watermark: q.binding.watermark });
        const afterHistory = checkDeadline();
        if (afterHistory !== null) return rejection(afterHistory);
        if (history === undefined) {
          return rejection("E_PROGRESS_HISTORY_MISSING");
        }
        const rows = connection
          .prepare<Row>(
            `${PROGRESS_ROW_SELECT}
              WHERE pc.task_id = :task_id AND pc.branch_id = :branch_id
                AND pc.input_epoch = :input_epoch AND pc.goal_version = :goal_version
                AND pc.config_version = :config_version
                AND pc.watermark BETWEEN :from_watermark AND :to_watermark
              ORDER BY pc.watermark ASC, pc.checkpoint_id COLLATE BINARY ASC
              LIMIT ${MAX_PROGRESS_CHECKPOINTS + 1}`
          )
          .all({
            ...scope,
            from_watermark: q.from_watermark,
            to_watermark: q.to_watermark
          });
        const afterWindow = checkDeadline();
        if (afterWindow !== null) return rejection(afterWindow);
        if (rows.length > MAX_PROGRESS_CHECKPOINTS) {
          return rejection("E_PROGRESS_LIMIT");
        }
        if (rows.length === 0) {
          return { ok: true, status: "ok", value: [] };
        }
        const first = rows[0];
        if (first === undefined) {
          return rejection("E_PROGRESS_DATA");
        }
        const firstWatermark = integer(first, "typed_watermark");
        const firstId = text(first, "typed_checkpoint_id");
        if (firstId.length === 0) {
          return rejection("E_PROGRESS_DATA");
        }
        const predecessorRows = connection
          .prepare<Row>(
            `${PROGRESS_ROW_SELECT}
              WHERE pc.task_id = :task_id AND pc.branch_id = :branch_id
                AND pc.input_epoch = :input_epoch AND pc.goal_version = :goal_version
                AND pc.config_version = :config_version
                AND (pc.watermark < :watermark
                     OR (pc.watermark = :watermark AND pc.checkpoint_id < :checkpoint_id))
              ORDER BY pc.watermark DESC, pc.checkpoint_id COLLATE BINARY DESC
              LIMIT 1`
          )
          .all({
            ...scope,
            watermark: firstWatermark,
            checkpoint_id: firstId
          });
        const afterPredecessor = checkDeadline();
        if (afterPredecessor !== null) return rejection(afterPredecessor);
        const predecessor = predecessorRows[0];
        let predecessorSegment: ProgressSegmentContext | null = null;
        if (predecessor !== undefined) {
          const parsedPredecessor = parseProgressRow(predecessor, q.binding, {
            kind: "predecessor",
            before_watermark: firstWatermark
          });
          if (!parsedPredecessor.ok) {
            return rejection(parsedPredecessor.code);
          }
          predecessorSegment = parsedPredecessor.segment;
        }
        const views: ProgressCheckpointReadView[] = [];
        const segments: ProgressSegmentContext[] = [];
        for (const row of rows) {
          const parsedRow = parseProgressRow(row, q.binding, {
            kind: "window",
            from_watermark: q.from_watermark,
            to_watermark: q.to_watermark
          });
          if (!parsedRow.ok) {
            return rejection(parsedRow.code);
          }
          views.push(parsedRow.view);
          segments.push(parsedRow.segment);
        }
        const firstWindowSegment = segments[0];
        if (firstWindowSegment === undefined) {
          return rejection("E_PROGRESS_DATA");
        }
        if (predecessorSegment === null) {
          if (
            firstWindowSegment.task_process_state !== "baseline" ||
            !baselineSegmentShapeValid(firstWindowSegment)
          ) {
            return rejection("E_PROGRESS_DATA");
          }
        } else {
          segments.unshift(predecessorSegment);
        }
        for (let index = 1; index < segments.length; index += 1) {
          const previous = segments[index - 1];
          const current = segments[index];
          if (previous === undefined || current === undefined) {
            return rejection("E_PROGRESS_DATA");
          }
          const shouldBeBaseline = previous.comparability_key !== current.comparability_key;
          const isBaseline = current.task_process_state === "baseline";
          if (shouldBeBaseline !== isBaseline) {
            return rejection("E_PROGRESS_DATA");
          }
          if (isBaseline && !baselineSegmentShapeValid(current)) {
            return rejection("E_PROGRESS_DATA");
          }
        }
        const afterParse = checkDeadline();
        if (afterParse !== null) return rejection(afterParse);
        return { ok: true, status: "ok", value: views };
      } catch {
        return rejection("E_PROGRESS_STORAGE");
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Source expectation and observed check ports                        */
/* ------------------------------------------------------------------ */

function createSourcePorts(sourceRefs: SourceRefPort): {
  expectations: FrozenSourceExpectationPort;
  sources: SourceCheckPort;
} {
  async function resolve(
    ref: SourceRef
  ): Promise<
    | { ok: true; content_hash: string; retrievable: boolean }
    | { ok: false; upstream_code: string }
  > {
    const resolved = await sourceRefs.resolve(ref);
    if (!resolved.ok) return { ok: false, upstream_code: upstreamCode(resolved.error) };
    if (!resolved.value.retrievable || resolved.value.range_content_hash === null) {
      return { ok: false, upstream_code: "source_unretrievable" };
    }
    return {
      ok: true,
      content_hash: resolved.value.range_content_hash,
      retrievable: resolved.value.retrievable
    };
  }

  return {
    expectations: {
      async resolveExpected({ refs }) {
        const expectations: Array<{ source_ref: SourceRef; content_hash: string }> = [];
        for (const ref of refs) {
          const resolved = await resolve(ref);
          if (!resolved.ok) {
            return {
              status: "rejected",
              code: "E_SOURCE_UNRETRIEVABLE",
              details: { stage: "expected_source_hashes", upstream_code: resolved.upstream_code, source_ref: ref }
            };
          }
          expectations.push({ source_ref: ref, content_hash: resolved.content_hash });
        }
        return { status: "ok", expectations };
      }
    },
    sources: {
      async check({ refs }) {
        const results: Array<{ source_ref: SourceRef; retrievable: boolean; content_hash: string | null }> =
          [];
        for (const ref of refs) {
          const resolved = await resolve(ref);
          if (!resolved.ok) {
            return {
              status: "rejected",
              code: "E_SOURCE_UNRETRIEVABLE",
              details: { stage: "source_check", upstream_code: resolved.upstream_code, source_ref: ref }
            };
          }
          results.push({
            source_ref: ref,
            retrievable: resolved.retrievable,
            content_hash: resolved.content_hash
          });
        }
        return { status: "ok", results };
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Synchronous QP commit port                                          */
/* ------------------------------------------------------------------ */

/**
 * The core QP repositories take the synchronous `QpJournalCommitPort`
 * (`commitQpJournal`, no promise); the kernel's own async port in
 * `qp-journal-port.ts` is for callers that already live on the async writer
 * gate. This port runs the same ordering inside one `BEGIN IMMEDIATE`:
 *
 *   1. `apply` performs the transition-id dedupe and the issue version CAS
 *      before any journal byte exists;
 *   2. the accepted event is projected through the shared QP reducer, which
 *      writes the five typed tables plus the object documents and heads;
 *   3. one frame is appended and fsynced, then the commit record and the
 *      journal tail row are written in the same transaction.
 *
 * A rejection therefore leaves zero frame bytes, zero commit_seq and zero
 * projection. A failure after the append is `unknown_recovery_required`; the
 * frozen frame is recovered by replay, never by re-running `apply`.
 */
class QpCommitAbort {
  readonly outcome: "not_written" | "unknown_recovery_required";
  readonly error: ErrorEnvelope | null;

  constructor(outcome: "not_written" | "unknown_recovery_required", error: ErrorEnvelope | null) {
    this.outcome = outcome;
    this.error = error;
  }
}

function applyFailure(error: unknown): ErrorEnvelope {
  if (isErrorEnvelope(error)) return error;
  if (typeof error === "object" && error !== null) {
    const envelope = (error as { readonly envelope?: unknown }).envelope;
    if (isErrorEnvelope(envelope)) return envelope;
  }
  return internalFailure("E_STORAGE_IO", "qp_commit_apply");
}

function journalFramePayload(event: CoreQpJournalEvent): JournalFramePayload {
  const json = event as unknown as JsonValue;
  return {
    schema_version: "rsi.journal_event/1",
    event: json,
    event_hash: canonicalHash(json),
    blob_hashes: []
  };
}

function createSyncQpCommitPort(options: {
  connection: SqliteConnection;
  journal: JournalWriter;
  journal_relative_path: string;
  now: () => number;
}): CoreQpJournalCommitPort {
  const runner = createTransactionRunner(options.connection);
  const writer = options.journal;

  const resyncWriter = (): void => {
    const row = options.connection
      .prepare<{
        last_commit_seq: number;
        trusted_prefix_end: number;
        relative_path: string;
      }>(
        "SELECT last_commit_seq, trusted_prefix_end, relative_path FROM journal_state WHERE journal_id = :journal_id"
      )
      .get({ journal_id: writer.journalId });
    if (row === undefined) {
      writer.resyncFromDisk(writer.lastCommitSeq);
      return;
    }
    if (typeof writer.resyncFromDisk === "function") {
      writer.resyncFromDisk(
        Number(row.last_commit_seq),
        row.relative_path,
        Number(row.trusted_prefix_end)
      );
    }
  };

  return {
    commitQpJournal(request): CoreQpLiveCommitOutcome {
      resyncWriter();
      let appended: JournalAppendResult | null = null;
      try {
        return runner.withTxSync<CoreQpLiveCommitOutcome>((tx) => {
          let decision: CoreQpJournalDecision;
          try {
            decision = request.apply({ tx } as unknown as CoreQpLiveStage);
          } catch (error) {
            throw new QpCommitAbort("not_written", applyFailure(error));
          }
          if (decision.kind === "existing") {
            return { commit_state: "existing", value: decision.value };
          }

          const payload = journalFramePayload(request.event);
          const replayed = replayQpJournalFrame(tx as unknown as Tx, {
            commit_seq: 0,
            journal_seq: 0,
            payload
          });
          if (!replayed.ok) {
            throw new QpCommitAbort("not_written", replayed.error);
          }

          const append = writer.append(payload);
          if (!append.ok) {
            throw new QpCommitAbort(
              writer.needsRecovery ? "unknown_recovery_required" : "not_written",
              append.error
            );
          }
          appended = append.value;
          const receipt = append.value;
          const relativePath = receiptRelativePath(
            options.journal_relative_path,
            receipt.file_path
          );
          if (relativePath === null) {
            throw new QpCommitAbort(
              "unknown_recovery_required",
              storageError({
                code: "E_STORAGE_CORRUPT",
                stage: "storage.qp",
                details: storageDetails("receipt.file_path", "not_a_journal_segment"),
                side_effect: "unknown"
              })
            );
          }
          try {
            recordFrameDurability(tx, {
              journal_id: receipt.journal_id,
              relative_path: relativePath,
              first_commit_seq: receipt.first_commit_seq,
              member_count: receipt.member_count,
              trusted_prefix_end: receipt.file_offset + receipt.frame_bytes,
              updated_at: options.now()
            });
            const records = expectedCommitRecords({
              journal_id: receipt.journal_id,
              commit_seq: receipt.first_commit_seq,
              payload,
              committed_at: options.now(),
              indexed_at: null
            });
            if (!records.ok) {
              throw new QpCommitAbort("unknown_recovery_required", records.error);
            }
            for (const record of records.value) {
              insertCommitRecord(tx, record);
            }
          } catch (error) {
            if (error instanceof QpCommitAbort) throw error;
            throw new QpCommitAbort("unknown_recovery_required", applyFailure(error));
          }
          return { commit_state: "committed", value: null };
        });
      } catch (error) {
        if (error instanceof QpCommitAbort) {
          if (error.outcome === "unknown_recovery_required") {
            // The frame is durable but unprojected. Fence every writer on the
            // era so none reuses its sequence before recovery.
            if (appended !== null) {
              writer.markRecoveryRequired();
            }
            return { commit_state: "unknown_recovery_required" };
          }
          return {
            commit_state: "not_written",
            error: error.error ?? internalFailure("E_STORAGE_IO", "qp_commit")
          };
        }
        // A transaction begin/commit failure: the frame is already durable
        // when `appended` is set, so the caller must recover by replay.
        if (appended !== null) {
          writer.markRecoveryRequired();
          return { commit_state: "unknown_recovery_required" };
        }
        return { commit_state: "not_written", error: applyFailure(error) };
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* QP pipeline adapter                                                */
/* ------------------------------------------------------------------ */

function onlineIssue(issue: Issue): OnlineIssue {
  return {
    issue_id: issue.issue_id,
    issue_key: issue.issue_key,
    issue_type: issue.type,
    issue_version: issue.issue_version,
    state: issue.state,
    requirement_ids: [...issue.requirement_ids],
    question_text: issue.question_text
  };
}

function onlinePlan(plan: QuestionPlan): OnlineQuestionPlan {
  return {
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    issue_id: plan.issue_id,
    issue_key: plan.issue_key,
    binding: plan.binding,
    questions: plan.questions.map((question) => ({
      question_key: question.question_key,
      template_id: question.template_id,
      template_version: question.template_version,
      template_hash: question.template_hash,
      required_for_issue: question.required_for_issue
    }))
  };
}

const EVIDENCE_GAP_CODES: ReadonlySet<string> = new Set<EvidenceGap["code"]>([
  "source_unretrievable",
  "interface_contract_missing",
  "artifact_version_unknown",
  "verifier_absent",
  "counterevidence_not_searched",
  "capture_gap",
  "template_role_unresolved",
  "authorization_not_local",
  "conflicting_sources"
]);

function coreGaps(
  gaps: ReadonlyArray<{
    code: string;
    requirement_ids: readonly string[];
    source_refs: readonly SourceRef[];
    affects_question_keys: readonly string[];
  }>
): EvidenceGap[] | null {
  const mapped: EvidenceGap[] = [];
  for (const gap of gaps) {
    if (!EVIDENCE_GAP_CODES.has(gap.code)) return null;
    mapped.push({
      code: gap.code as EvidenceGap["code"],
      requirement_ids: [...gap.requirement_ids],
      source_refs: [...gap.source_refs],
      affects_question_keys: [...gap.affects_question_keys]
    });
  }
  return mapped;
}

function transitionResult(
  _transitionId: string,
  result: Awaited<ReturnType<QuestionPlanner["recordJudgment"]>>
): QpTransitionResult {
  const mapped: QpTransitionResult = {
    status: result.status,
    errors: result.errors.map((code) => ({ code }))
  };
  return result.issue === undefined
    ? mapped
    : { ...mapped, issue: onlineIssue(result.issue) };
}

function questionTemplateRegistry(
  registry: OnlineQuestionTemplateRegistry
): QuestionTemplateRegistry | null {
  if (registry.schema_version !== "rsi.question_template_registry/1") return null;
  return {
    schema_version: "rsi.question_template_registry/1",
    registry_version: registry.registry_version,
    registry_hash: registry.registry_hash,
    templates: registry.templates.map((template) => ({ ...template }))
  };
}

/**
 * Projects the concrete planner onto the kernel's structural QP port.
 *
 * The port passes `OnlineIssue` values; every command hydrates the full issue
 * from the repository so plan/transition validation sees the persisted object.
 */
/**
 * Goal-change issues are opened by a human input: the correction that proposed
 * the requirement. Appendix C.3 treats a host-typed user field as human
 * provenance for online judgement (never for writes), so `origin=user` with
 * `origin_basis=host_typed_field` is confirmed as `human_input`. Every other
 * origin stays unknown and the issue remains proposed.
 */
function goalChangeConfirmation(
  connection: SqliteConnection,
  requirementIds: readonly string[]
): ConfirmationEvidence | null {
  for (const requirementId of requirementIds) {
    const op = connection
      .prepare<Row>(
        `SELECT op_id, source_event_id, source_quote_ref, directive_strength
           FROM requirement_op
          WHERE created_requirement_id = :requirement_id AND op = 'add'
          ORDER BY recorded_at ASC, op_id ASC LIMIT 1`
      )
      .get({ requirement_id: requirementId });
    if (op === undefined) continue;
    const eventId = text(op, "source_event_id");
    const quoteRef = text(op, "source_quote_ref");
    if (eventId.length === 0 || quoteRef.length === 0) continue;
    const event = connection
      .prepare<Row>(
        `SELECT e.origin, e.origin_basis, i.directive_strength
           FROM event_log e
           LEFT JOIN input i ON i.input_id = e.input_id
          WHERE e.event_id = :event_id LIMIT 1`
      )
      .get({ event_id: eventId });
    if (event === undefined) continue;
    const origin = text(event, "origin");
    const basis = text(event, "origin_basis");
    const human = origin === "human" || (origin === "user" && basis === "host_typed_field");
    if (!human) continue;
    const strength = text(event, "directive_strength") === "explicit" ? "explicit" : "ambiguous";
    return {
      kind: "human_input",
      event_id: eventId,
      origin: "human",
      directive_strength: strength,
      source_refs: [quoteRef as SourceRef],
      requirement_op_id: text(op, "op_id")
    };
  }
  return null;
}

function createQpPlannerPort(planner: QuestionPlanner, connection: SqliteConnection): QpPlannerPort {
  return {
    deps: { evidence: planner.deps.evidence as unknown as LoadedEvidenceIndexSnapshot },
    discover(input: QpDiscoveryInput): QpDiscoveryResult {
      const result = planner.discover({ ...input });
      return {
        status: result.status,
        issues: result.issues.map(onlineIssue),
        errors: result.errors.map((code) => ({ code }))
      };
    },
    plan(input): QpPlanningResult {
      let issue = planner.deps.issues.getIssue(input.issue.issue_id);
      if (issue === null) {
        return { status: "rejected", reason: "E_SCHEMA", issue_id: input.issue.issue_id };
      }
      // Discovery persists issues as `proposed`; the planner only plans an
      // open issue. A goal-change candidate is opened by the human correction
      // that proposed its requirement (appendix C.3 origin mapping).
      if (issue.state === "proposed" && issue.type === "goal_change") {
        const confirmation = goalChangeConfirmation(connection, issue.requirement_ids);
        if (confirmation !== null) {
          const confirmed = planner.confirm({
            transition_id: `confirm:${issue.issue_id}`,
            issue_id: issue.issue_id,
            expected_version: issue.issue_version,
            confirmation
          });
          if (confirmed.status === "ok" && confirmed.issue !== undefined) {
            issue = confirmed.issue;
          }
        }
      }
      const registry = questionTemplateRegistry(input.registry);
      if (registry === null) {
        return { status: "rejected", reason: "E_SCHEMA", issue_id: input.issue.issue_id };
      }
      const result = planner.plan({
        binding: input.binding,
        issue,
        registry,
        policy_version: input.policy_version
      });
      if (result.status === "planned") {
        return {
          status: "planned",
          plan: onlinePlan(result.plan),
          // The core returns the whole `rsi.question_plan_state/1` row; the
          // pipeline map stores only its lifecycle string. Casting the object
          // made the pack compiler compare an object against "active" and
          // report every plan as `E_EVIDENCE_PACK_STALE`.
          plan_state: result.plan_state.state as unknown as OnlinePlanState
        };
      }
      if (result.status === "no_op") {
        return result.issue_id === undefined
          ? { status: "no_op", reason: result.reason }
          : { status: "no_op", reason: result.reason, issue_id: result.issue_id };
      }
      if (result.status === "deferred") {
        return result.retry_after_watermark === undefined
          ? { status: "deferred", reason: result.reason, issue_id: result.issue_id }
          : {
              status: "deferred",
              reason: result.reason,
              issue_id: result.issue_id,
              retry_after_watermark: result.retry_after_watermark
            } as QpPlanningResult;
      }
      return { status: "rejected", reason: result.reason, issue_id: result.issue_id };
    },
    async recordJudgment(command) {
      return transitionResult(
        command.transition_id,
        await planner.recordJudgment({
          transition_id: command.transition_id,
          issue_id: command.issue_id,
          expected_version: command.expected_version,
          source: { ...command.source }
        })
      );
    },
    requireEvidence(command) {
      const gaps = coreGaps(command.gaps);
      if (gaps === null) {
        return { status: "rejected", errors: [{ code: "E_SCHEMA" }] };
      }
      return transitionResult(
        command.transition_id,
        planner.requireEvidence({
          transition_id: command.transition_id,
          issue_id: command.issue_id,
          expected_version: command.expected_version,
          gaps,
          reason: command.reason
        })
      );
    },
    abstain(command) {
      const gaps = coreGaps(command.gaps);
      if (gaps === null) {
        return { status: "rejected", errors: [{ code: "E_SCHEMA" }] };
      }
      return transitionResult(
        command.transition_id,
        planner.abstain({
          transition_id: command.transition_id,
          issue_id: command.issue_id,
          expected_version: command.expected_version,
          reason: command.reason,
          gaps
        })
      );
    },
    async close(command) {
      const draft: OnlineCloseEvidenceDraft = command.close_evidence;
      return transitionResult(
        command.transition_id,
        await planner.close({
          transition_id: command.transition_id,
          issue_id: command.issue_id,
          expected_version: command.expected_version,
          mode: "judgment",
          close_evidence: {
            kind: draft.kind,
            evidence_id: draft.evidence_id,
            source_refs: [...draft.source_refs],
            goal_version: draft.goal_version,
            requirement_ids: [...draft.requirement_ids],
            artifact_version: draft.artifact_version,
            verifier_ref: draft.verifier_ref
          }
        })
      );
    }
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                            */
/* ------------------------------------------------------------------ */

interface DefaultQuestionPlannerDeps {
  /** Open FND SQLite connection (migrations already applied). */
  readonly connection: SqliteConnection;
  /** Content-addressed blob store whose `read` recomputes the full hash. */
  readonly blob_store: Pick<BlobStore, "read" | "stat">;
  /** FND `SourceRefPort`; when omitted, built over `connection`/`blob_store`. */
  readonly source_refs?: SourceRefPort;
  /** Open journal writer used by the single QP write gate. */
  readonly journal: JournalWriter;
  /** Journal path exactly as recorded in commit frames. */
  readonly journal_relative_path: string;
  readonly now?: () => number;
  /** Defaults to `qp.registry/1`. */
  readonly registry_version?: string;
  readonly detector_version?: string;
  readonly planner_version?: string;
}

export interface DefaultQuestionPlannerRequest {
  /** The admitted committed binding; `binding.watermark` is the load watermark. */
  readonly binding: VersionBinding;
  /**
   * Lower bound of the progress window. `0` means "from genesis"; the HOST
   * checkpoint history must still contain a row in this scope or the load is
   * rejected with `E_INDEX_PROGRESS_UNSUPPORTED`.
   */
  readonly progress_from_watermark?: number;
  /** Must match the admission snapshot; omitted means no review snapshot. */
  readonly review_snapshot_id?: string | null;
  /**
   * The full review snapshot the loader needs together with
   * `review_snapshot_id`. The loader rejects an id without a snapshot, so the
   * factory refuses that pair before it reads any state.
   */
  readonly review_snapshot?: ReviewSnapshotView;
  /** Contract-checked alias; must equal `binding.watermark` when present. */
  readonly watermark?: number;
}

export interface DefaultQuestionPlannerBundle {
  readonly planner: QuestionPlanner;
  /** Structural port consumed by `OnlinePipelineDeps.qp`. */
  readonly qp: QpPipelineDeps;
  /** The real QP issue repository sharing the factory's single commit gate. */
  readonly issues: IssueWriteRepository;
  /** The real QP plan repository sharing the factory's single commit gate. */
  readonly plans: QuestionPlanRepository;
  readonly registry: QuestionTemplateRegistry;
  readonly online_registry: OnlineQuestionTemplateRegistry;
  readonly load_request: EvidenceIndexLoadRequest;
  readonly binding: VersionBinding;
  readonly detector_version: string;
  readonly planner_version: string;
}

interface DefaultQuestionPlannerOptions {
  readonly signal?: AbortSignal;
}

function clockOf(now: () => number): Clock {
  return {
    utcNowMs: now,
    monotonicNowMs: () => performance.now(),
    monotonicRemainingMs: (deadline: number) =>
      Math.max(0, deadline - performance.now())
  };
}

function contractEnvelope(code: string, stage: "load" | "contract"): ErrorEnvelope {
  return makeErrorEnvelope({
    code: code as ErrorEnvelope["code"],
    category: stage === "load" ? "source" : "schema",
    message_key: `error.${code.toLowerCase()}`,
    stage: stage === "load" ? "evidence_index_load" : "evidence_index_contract",
    details: { kind: "none" }
  });
}

/**
 * The planner's `AcceptedAggregateReadPort` over the committed EVD rows.
 *
 * `DefaultEvidenceReader` is the production read side: the request scope is
 * checked against the persisted row before any blob read, the exact canonical
 * bytes are hash-verified, and `createAcceptedAggregateReader` then re-checks
 * the aggregate identity and the recomputed aggregate hash. That keeps
 * `recordJudgment` on the same accepted-aggregate contract the rest of the
 * EVD tail uses; a missing, out-of-scope or non-accepted row stays a typed
 * rejection instead of a fabricated judgment basis.
 *
 * The composite reader also carries the gateway's `commitLate` write half,
 * which is not part of `AcceptedAggregateReadPort` and is unreachable from
 * this read-only planner composition. It fails closed rather than opening a
 * second persistence path from QP.
 */
function createAcceptedAggregatePort(
  connection: SqliteConnection,
  blobs: Pick<BlobStore, "read">
): ReturnType<typeof createAcceptedAggregateReader> {
  return createAcceptedAggregateReader({
    aggregates: createDefaultEvidenceReader({
      connection,
      blobs,
      writer: {
        async commitLate() {
          return {
            ok: false,
            commit_state: "not_written",
            error: internalFailure(
              "E_CAPABILITY",
              "qp_planner_aggregate_reader_commit_late"
            )
          };
        }
      }
    })
  });
}

/**
 * Builds a planner over one committed binding.
 *
 * The factory performs a real evidence-index load. A missing HOST
 * `progress_checkpoint` is surfaced as `E_INDEX_PROGRESS_UNSUPPORTED`; no
 * empty checkpoint or empty snapshot is fabricated.
 */
export async function createDefaultQuestionPlanner(
  deps: DefaultQuestionPlannerDeps,
  request: DefaultQuestionPlannerRequest,
  options: DefaultQuestionPlannerOptions = {}
): Promise<Result<DefaultQuestionPlannerBundle, ErrorEnvelope>> {
  const now = deps.now ?? ((): number => Date.now());
  const clock = clockOf(now);
  const binding = request.binding;
  if (request.watermark !== undefined && request.watermark !== binding.watermark) {
    return err(contractEnvelope("E_INDEX_WINDOW_INVALID", "contract"));
  }
  const sourceRefs = deps.source_refs ?? createSourceRefPort({
    connection: deps.connection,
    blob_store: deps.blob_store
  });
  const sourcePorts = createSourcePorts(sourceRefs);
  const progressFrom = request.progress_from_watermark ?? 0;
  const reviewId = request.review_snapshot_id ?? null;
  if ((reviewId === null) !== (request.review_snapshot === undefined)) {
    return err(contractEnvelope("E_INDEX_REQUEST_INVALID", "contract"));
  }
  const loadRequest = {
    schema_version: "rsi.evidence_index_load_request/1",
    binding,
    watermark: binding.watermark,
    progress_from_watermark: progressFrom,
    ...(reviewId === null
      ? {}
      : { review_snapshot_id: reviewId, review_snapshot: request.review_snapshot })
  } as unknown as EvidenceIndexLoadRequest;

  const loaderDeps: EvidenceIndexSnapshotLoaderDeps = {
    ledger: createLedgerReadPort(deps.connection),
    facts: createFactReadPort(deps.connection),
    verifiers: createVerifierReadPort(deps.connection),
    sources: {
      async resolve(ref, opts) {
        const resolved = await sourceRefs.resolve(ref, opts);
        return resolved.ok ? ok(resolved.value) : resolved;
      },
      async checkRetrievable(refs) {
        return sourceRefs.checkRetrievable(refs);
      }
    },
    progress: createProgressReadPort(deps.connection),
    monotonic_now: () => performance.now()
  };
  const loader = createEvidenceIndexSnapshotLoader(
    loaderDeps
  ) as unknown as LoadedEvidenceIndexSnapshotLoader;

  const commit: CoreQpJournalCommitPort = createSyncQpCommitPort({
    connection: deps.connection,
    journal: deps.journal,
    journal_relative_path: deps.journal_relative_path,
    now
  });
  const source = deps.connection as unknown as QpReadSource;
  const issues: IssueWriteRepository = createIssueRepository({ clock, commit, source });
  const plans: QuestionPlanRepository = createPlanRepository({ clock, commit, source });

  const registryVersion = deps.registry_version ?? DEFAULT_QP_REGISTRY_VERSION;
  const registry = buildTemplateRegistry({ registry_version: registryVersion });
  const onlineRegistry: OnlineQuestionTemplateRegistry = {
    schema_version: registry.schema_version,
    registry_version: registry.registry_version,
    registry_hash: registry.registry_hash,
    templates: registry.templates.map((template) => ({ ...template }))
  };

  const created = await createQuestionPlanner({
    loader: loader as unknown as Parameters<typeof createQuestionPlanner>[0]["loader"],
    load_request: loadRequest,
    issues,
    plans,
    sourceExpectations: sourcePorts.expectations,
    sources: sourcePorts.sources,
    aggregates: createAcceptedAggregatePort(deps.connection, deps.blob_store),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (created.status === "rejected") {
    return err(
      created.stage === "load"
        ? created.error
        : contractEnvelope(created.code, "contract")
    );
  }

  const planner = created.planner;
  const detectorVersion = deps.detector_version ?? DEFAULT_QP_DETECTOR_VERSION;
  const plannerVersion = deps.planner_version ?? DEFAULT_QP_PLANNER_VERSION;
  const qp: QpPipelineDeps = {
    planner: createQpPlannerPort(planner, deps.connection),
    registry: onlineRegistry,
    detector_version: detectorVersion,
    planner_version: plannerVersion,
    progress_from_watermark: progressFrom
  };

  return ok({
    planner,
    qp,
    issues,
    plans,
    registry,
    online_registry: onlineRegistry,
    load_request: loadRequest,
    binding,
    detector_version: detectorVersion,
    planner_version: plannerVersion
  });
}

