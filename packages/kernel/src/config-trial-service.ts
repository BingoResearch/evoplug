/**
 * W10 executable CFG services (D7).
 *
 * `createConfigSpaceService` captures and reads the adapter-declared config
 * files through injected root resolution. `createConfigTrialService` drives
 * the existing CFG trial ABI over real SQLite rows, the real `ConfigWritePort`
 * lock/commit/readback path and the live journal committer.
 *
 * The tunable surface is closed: every runtime write passes the eight
 * compaction classes and `model`/thinking controls are hard-denied before the
 * allowlist. Nothing here flips a `FieldSpec.status`; promotion evidence is
 * produced by `collectCompactionPromotionEvidence` and reviewed separately.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigProtectedSubtree, ConfigWriteLock, ConfigWriteLockRequest, ConfigWritePatch, ConfigWritePort, ConfigWriteReadPort, ConfigWriteResult, ErrorEnvelope, Hash, Id, JsonValue, ResolvedRoot, RootResolver, SafetyAuditPort, SourceRef, VersionBinding } from "@evoplug/core";
import type { CapacityEvidencePort } from "@evoplug/core/host";
import { canonicalHash, canonicalJsonText, compareUtf8, isEvidenceStage, isHostProbeResult, newId } from "@evoplug/core";
import type { AssignmentValue, AttemptKind, CloseTrial, ConfigReloadProbePort, ConfigResult, ConfigSpaceCatalogEntry, ConfigSpaceCatalogPort, ConfigSpaceSelector, ConfigSpaceService, ConfigSpaceSnapshot, ConfigTrial, ConfigTrialService, CreateTrialPlan, EffectiveProbe, EpochMs, ExecuteAttempt, FieldAssignment, FieldReadback, FieldRegistrySnapshot, FieldSpec, ObservationRecord, ObservationWindowSpec, RecordObservation, ReconcileEntry, ReconcileReport, RequestRollback, StartTrial, TrialAttempt, TrialFieldChange, TrialPlan } from "@evoplug/core/config";
import { CONFIG_OBSERVATION_ROW_SCHEMA, CONFIG_TRIAL_ROW_SCHEMA, TRIAL_ATTEMPT_ROW_SCHEMA, TRIAL_PLAN_ROW_SCHEMA, assignmentValueKey, assertTrialNotTerminal, buildFileState, buildObservationRecord, buildWritePatches, canTransition, checkAttemptKind, checkCloseReason, checkConfigGrant, checkFieldTunable, closeAbandonedTransition, configError, configObservationRow, configSpaceSemanticHash, configTrialRow, createPlan as createPlanSeam, fail, fieldClaimRow, fieldSetMatches, getNode, isStaleBaseline, jcsText, levelAfterProbe, mapConfigWriteError, mapRollbackWriteResult, mapWriteResult, nextAttemptSequence, observationReplayDecision, openObservationWindow, parseDocument, probeProvesEffective, reconcileEntryFor, recordObservation as recordObservationSeam, requestRollbackTransition, requiredGrantActions, requireOpenWindow, requiresCapacityEvidence, scopeHashFor, selectWritableLayer, shouldReleaseClaims, startTrial as startTrialSeam, startTrialReplayDecision, succeed, trialAttemptRow, trialPlanRow, validateAttemptAuditInput, validateDeadline, validateOutcomeCombination, verifyPatchHash, type PromotionCapabilityEvidence, type PromotionEvidence, type SemanticTree } from "@evoplug/core/config";
import type { BlobStore, JournalCommitter, JournalFrameBatchEntry, JournalFramePayload, SqlRow, SqliteConnection, SqlValue, Tx } from "@evoplug/storage";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function disabledError<T>(): ConfigResult<T> {
  return fail(
    configError("E_CFG_FIELD_NOT_EXECUTABLE", {
      details: [{ key: "reason", value: "config_autotune_disabled" }]
    })
  );
}

function configFailure<T>(error: ReturnType<typeof configError>): ConfigResult<T> {
  return fail(error);
}

function sqlValue(value: unknown): SqlValue {
  if (value === undefined) {
    return null;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return canonicalJsonText(value as JsonValue);
}

function rowParams(row: object): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sqlValue(value);
  }
  return out;
}

function trialUpdateParams(
  row: ReturnType<typeof configTrialRow>,
  previousRevision: number
): Record<string, SqlValue> {
  return {
    phase: row.phase,
    evidence_level: row.evidence_level,
    outcome: row.outcome,
    revision: row.revision,
    trial_json: row.trial_json,
    updated_at: row.updated_at,
    trial_id: row.trial_id,
    previous_revision: previousRevision
  };
}

function parseJson<T>(text: unknown): T {
  return JSON.parse(String(text)) as T;
}

function evidenceRefFor(hash: Hash, length: number): SourceRef {
  return `blob://${hash}#bytes=0-${length}`;
}

function bindingJson(binding: VersionBinding | null): JsonValue {
  if (binding === null) {
    return null;
  }
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

/* ------------------------------------------------------------------ */
/* Journal frames                                                      */
/* ------------------------------------------------------------------ */

interface LedgerFrame {
  readonly payload: JournalFramePayload;
  readonly afterHash: Hash;
}

function buildLedgerFrame(input: {
  rowSchema: string;
  rowJson: string;
  beforeRowJson: string | null;
  entityId: string;
  operation: "insert" | "update" | "transition";
  binding: VersionBinding | null;
  now: number;
}): LedgerFrame {
  const afterHash = canonicalHash({ row_schema: input.rowSchema, row_json: input.rowJson });
  const beforeHash =
    input.beforeRowJson === null
      ? null
      : canonicalHash({ row_schema: input.rowSchema, row_json: input.beforeRowJson });
  const eventKey = canonicalHash({
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: input.entityId,
    operation: input.operation,
    before_hash: beforeHash,
    after_hash: afterHash,
    binding: bindingJson(input.binding)
  });
  const event: JsonValue = {
    schema_version: "rsi.ledger_event/1",
    event_id: newId("ev", input.now),
    event_key: eventKey,
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: input.entityId,
    operation: input.operation,
    binding: bindingJson(input.binding),
    before_hash: beforeHash,
    after_hash: afterHash,
    row_schema: input.rowSchema,
    row_json: input.rowJson,
    payload_hash: afterHash,
    recorded_at: input.now
  };
  return {
    payload: {
      schema_version: "rsi.journal_event/1",
      event,
      event_hash: canonicalHash(event),
      blob_hashes: []
    },
    afterHash
  };
}

function commitOutcomeError(
  outcome: { ok: boolean; commit_state?: string; error?: ErrorEnvelope }
): ReturnType<typeof configError> | null {
  if (outcome.ok) {
    return null;
  }
  if (outcome.commit_state === "unknown_recovery_required") {
    return configError("E_CFG_WRITE_UNCERTAIN", {
      details: [{ key: "commit_state", value: "unknown_recovery_required" }]
    });
  }
  return configError("E_CFG_WRITE_FAILED", {
    details: [{ key: "commit_state", value: outcome.commit_state ?? "not_written" }]
  });
}

/* ------------------------------------------------------------------ */
/* ConfigSpaceService                                                  */
/* ------------------------------------------------------------------ */

interface ConfigSpaceServiceDeps {
  readonly rootResolver: RootResolver;
  readonly registry: FieldRegistrySnapshot;
  readonly catalog: ConfigSpaceCatalogPort;
  readonly blobStore: BlobStore;
  readonly now: () => EpochMs;
  readonly defaultDeadlineMs?: number;
}

interface LoadedLayer {
  readonly layer: ConfigSpaceCatalogEntry["layers"][number];
  readonly root: ResolvedRoot;
  readonly bytes: Uint8Array | null;
  readonly tree: SemanticTree | null;
}

function fieldPointer(entry: ConfigSpaceCatalogEntry, fieldKey: string, layerId: string): string | null {
  return (
    entry.field_paths.find((path) => path.field_key === fieldKey && path.layer_id === layerId)?.pointer ?? null
  );
}

function entrySpecs(registry: FieldRegistrySnapshot, entry: ConfigSpaceCatalogEntry): readonly FieldSpec[] {
  return registry.field_specs.filter(
    (spec) => spec.host_id === entry.host.host_id && spec.config_space === entry.config_space
  );
}

function safeJoin(root: string, relativePath: string): string | null {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("..") ||
    relativePath.includes("\u0000")
  ) {
    return null;
  }
  return join(root, relativePath);
}

function filePathFor(layer: ConfigSpaceCatalogEntry["layers"][number]): {
  kind: "file";
  format: "json" | "jsonc" | "yaml" | "toml";
  root: "user" | "project" | "managed" | "session";
  relative_path: string;
  pointer: string;
  create: boolean;
} {
  return {
    kind: "file",
    format: layer.format,
    root: layer.root_kind,
    relative_path: layer.relative_path,
    pointer: "",
    create: true
  };
}

export function createConfigSpaceService(deps: ConfigSpaceServiceDeps): ConfigSpaceService {
  const deadlineMs = deps.defaultDeadlineMs ?? 30_000;

  async function loadLayers(
    entry: ConfigSpaceCatalogEntry
  ): Promise<ConfigResult<readonly LoadedLayer[]>> {
    const roots = new Map<string, ResolvedRoot>();
    for (const rootId of new Set(entry.layers.map((layer) => layer.root_id))) {
      const resolved = await deps.rootResolver.resolve({
        root_id: rootId,
        request_id: newId("ipc", Date.now()),
        deadline_ms: deadlineMs
      });
      if (!resolved.ok) {
        return configFailure(configError("E_CFG_ROOT_UNRESOLVED", { details: [{ key: "root_id", value: rootId }] }));
      }
      roots.set(rootId, resolved.value);
    }
    const layers: LoadedLayer[] = [];
    for (const layer of entry.layers) {
      const root = roots.get(layer.root_id);
      if (root === undefined) {
        return configFailure(configError("E_CFG_ROOT_UNRESOLVED", { details: [{ key: "root_id", value: layer.root_id }] }));
      }
      const path = safeJoin(root.approved_root, layer.relative_path);
      if (path === null) {
        return configFailure(
          configError("E_CFG_FIELD_NOT_EXECUTABLE", { details: [{ key: "path", value: "not_relative" }] })
        );
      }
      let bytes: Uint8Array | null;
      try {
        bytes = new Uint8Array(await readFile(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          bytes = null;
        } else {
          return configFailure(
            configError("E_CFG_ROOT_UNAVAILABLE", { details: [{ key: "path", value: layer.relative_path }] })
          );
        }
      }
      if (bytes === null) {
        layers.push({ layer, root, bytes: null, tree: null as LoadedLayer["tree"] });
        continue;
      }
      const parsed = parseDocument(bytes, layer.format);
      if (!parsed.ok) {
        return configFailure(
          configError("E_CFG_FIELD_TYPE", { details: [{ key: "parse", value: layer.relative_path }] })
        );
      }
      layers.push({ layer, root, bytes, tree: parsed.value.tree });
    }
    return succeed(layers);
  }

  async function captureEntry(
    selector: ConfigSpaceSelector,
    entry: ConfigSpaceCatalogEntry
  ): Promise<ConfigResult<{ snapshot: ConfigSpaceSnapshot; layers: readonly LoadedLayer[] }>> {
    if (
      entry.config_space !== selector.config_space ||
      entry.root_id !== selector.root_id ||
      entry.source_layer_id !== selector.source_layer_id ||
      entry.source_layer_set_hash !== selector.source_layer_set_hash ||
      entry.capability_binding_key !== selector.capability_binding_key ||
      entry.capability_snapshot_hash !== selector.capability_snapshot_hash
    ) {
      return configFailure(
        configError("E_CFG_AUTHORIZATION_SCOPE", {
          details: [{ key: "dimension", value: "config_space_selector" }]
        })
      );
    }
    const loaded = await loadLayers(entry);
    if (!loaded.ok) {
      return loaded;
    }
    const layers = loaded.value;
    const byLayer = new Map(layers.map((layer) => [layer.layer.layer_id, layer]));
    const files = layers.map((layer) =>
      buildFileState({
        path: filePathFor(layer.layer),
        bytes: layer.bytes,
        tree: layer.tree,
        parser_id: "evoplug.semantic_tree",
        parser_version: "1"
      })
    );
    const values: FieldAssignment[] = [];
    for (const spec of entrySpecs(deps.registry, entry)) {
      const ordered = [...spec.source_layers].sort((left, right) => left.precedence_rank - right.precedence_rank);
      let assignment: FieldAssignment | null = null;
      for (const sourceLayer of ordered) {
        const layer = byLayer.get(sourceLayer.layer_id);
        if (layer === undefined) {
          continue;
        }
        const pointer = fieldPointer(entry, spec.field_key, sourceLayer.layer_id);
        if (pointer === null) {
          continue;
        }
        const node = layer.tree === null ? undefined : getNode(layer.tree, pointer);
        assignment = {
          field_id: spec.field_id,
          path: { ...filePathFor(layer.layer), pointer },
          value:
            node !== undefined && node.kind === "scalar"
              ? { presence: "present", value: node.value }
              : { presence: "absent" }
        };
        if (node !== undefined && node.kind === "scalar") {
          break;
        }
      }
      if (assignment !== null) {
        values.push(assignment);
      }
    }
    const primary = layers.find((layer) => layer.layer.layer_id === selector.source_layer_id);
    if (primary === undefined) {
      return configFailure(
        configError("E_CFG_FIELD_UNKNOWN", { details: [{ key: "layer_id", value: selector.source_layer_id }] })
      );
    }
    const semanticHash = configSpaceSemanticHash(selector, values, files);
    const configVersion = `cfgv:${semanticHash}`;
    const snapshot: ConfigSpaceSnapshot = {
      schema_version: "rsi.config_space_snapshot/1",
      config_space: {
        config_space_id: selector.config_space_id,
        host: entry.host,
        root_id: selector.root_id,
        root_identity_pin: primary.root.root_identity_pin,
        source_layer_set_hash: selector.source_layer_set_hash,
        config_version: configVersion,
        semantic_hash: semanticHash
      },
      values,
      files,
      config_version: configVersion,
      semantic_hash: semanticHash,
      captured_at: deps.now()
    };
    return succeed({ snapshot, layers });
  }

  return {
    async capture(selector: ConfigSpaceSelector): Promise<ConfigResult<ConfigSpaceSnapshot>> {
      const entry = await deps.catalog.get(selector.config_space_id);
      if (!entry.ok) {
        return entry;
      }
      const captured = await captureEntry(selector, entry.value);
      return captured.ok ? succeed(captured.value.snapshot) : captured;
    },

    async readFields(input: {
      config_space_id: Hash;
      field_ids: readonly Id<"fld">[];
      layer_id: string;
    }): Promise<ConfigResult<readonly FieldReadback[]>> {
      const entryResult = await deps.catalog.get(input.config_space_id);
      if (!entryResult.ok) {
        return entryResult;
      }
      const entry = entryResult.value;
      const selector: ConfigSpaceSelector = {
        config_space_id: input.config_space_id,
        config_space: entry.config_space,
        source_layer_id: input.layer_id,
        source_layer_set_hash: entry.source_layer_set_hash,
        root_id: entry.root_id,
        trust_evidence_ref: entry.trust_evidence_ref,
        capability_binding_key: entry.capability_binding_key,
        capability_snapshot_hash: entry.capability_snapshot_hash
      };
      const captured = await captureEntry(selector, entry);
      if (!captured.ok) {
        return captured;
      }
      const byId = new Map(captured.value.snapshot.values.map((assignment) => [assignment.field_id, assignment]));
      const specs = new Map(entrySpecs(deps.registry, entry).map((spec) => [spec.field_id, spec]));
      const layers = new Map(captured.value.layers.map((layer) => [layer.layer.layer_id, layer]));
      const layer = layers.get(input.layer_id);
      if (layer === undefined) {
        return configFailure(
          configError("E_CFG_FIELD_UNKNOWN", { details: [{ key: "layer_id", value: input.layer_id }] })
        );
      }
      let evidenceRef: SourceRef;
      if (layer.bytes === null) {
        const stored = await deps.blobStore.put(new Uint8Array());
        if (!stored.ok) {
          return configFailure(
            configError("E_CFG_ROOT_UNAVAILABLE", { details: [{ key: "blob", value: "put_failed" }] })
          );
        }
        evidenceRef = evidenceRefFor(stored.value.hash, stored.value.byte_length);
      } else {
        const stored = await deps.blobStore.put(layer.bytes);
        if (!stored.ok) {
          return configFailure(
            configError("E_CFG_ROOT_UNAVAILABLE", { details: [{ key: "blob", value: "put_failed" }] })
          );
        }
        evidenceRef = evidenceRefFor(stored.value.hash, stored.value.byte_length);
      }
      const readbacks: FieldReadback[] = [];
      for (const fieldId of input.field_ids) {
        const spec = specs.get(fieldId);
        if (spec === undefined) {
          return configFailure(configError("E_CFG_FIELD_UNKNOWN", { field_id: fieldId }));
        }
        const pointer = fieldPointer(entry, spec.field_key, input.layer_id);
        if (pointer === null) {
          return configFailure(configError("E_CFG_FIELD_UNKNOWN", { field_id: fieldId }));
        }
        const assignment = byId.get(fieldId);
        readbacks.push({
          field_id: fieldId,
          layer_id: input.layer_id,
          path: { ...filePathFor(layer.layer), pointer },
          observed: assignment?.value ?? { presence: "absent" },
          config_version: captured.value.snapshot.config_version,
          method: spec.readback.method,
          evidence_ref: evidenceRef,
          observed_at: deps.now()
        });
      }
      return succeed(readbacks);
    }
  };
}

/* ------------------------------------------------------------------ */
/* ConfigTrialService                                                  */
/* ------------------------------------------------------------------ */

interface ConfigTrialServiceDeps {
  /** The `config_autotune` flag. Every method fails when this is false. */
  readonly enabled: boolean;
  readonly connection: SqliteConnection;
  readonly registry: FieldRegistrySnapshot;
  readonly rootResolver: RootResolver;
  readonly catalog: ConfigSpaceCatalogPort;
  readonly configWrite: ConfigWritePort;
  readonly configWriteRead?: ConfigWriteReadPort;
  readonly journal: JournalCommitter;
  readonly reloadProbe: ConfigReloadProbePort;
  readonly now: () => EpochMs;
  /** Defaults to `config.auto_tune_fields`, which is `[]` when unset. */
  readonly autoTuneFields?: readonly string[];
  readonly observationWindow?: ObservationWindowSpec;
  readonly capacityEvidencePort?: CapacityEvidencePort | null;
  readonly safetyAudit?: SafetyAuditPort | null;
  readonly protectedSubtrees?: readonly ConfigProtectedSubtree[];
  readonly defaultDeadlineMs?: number;
  /** Reuse an externally built space service; otherwise one is built here. */
  readonly space?: ConfigSpaceService;
  readonly blobStore?: BlobStore;
}

const DEFAULT_WINDOW: ObservationWindowSpec = {
  profile_id: "W1",
  min_matched_samples: 3,
  max_elapsed_ms: 3_600_000,
  match_predicate_id: "compaction_trigger"
};

const TRIAL_INSERT = `INSERT INTO cfg_trial (
  trial_id, plan_id, config_space_id, phase, evidence_level, outcome, revision,
  task_id, branch_id, input_epoch, goal_version, config_version, watermark,
  trial_json, created_at, updated_at
) VALUES (
  :trial_id, :plan_id, :config_space_id, :phase, :evidence_level, :outcome, :revision,
  :task_id, :branch_id, :input_epoch, :goal_version, :config_version, :watermark,
  :trial_json, :created_at, :updated_at
)`;

const TRIAL_UPDATE = `UPDATE cfg_trial SET
  phase = :phase,
  evidence_level = :evidence_level,
  outcome = :outcome,
  revision = :revision,
  trial_json = :trial_json,
  updated_at = :updated_at
WHERE trial_id = :trial_id AND revision = :previous_revision`;

const ATTEMPT_INSERT = `INSERT INTO cfg_attempt (
  trial_id, sequence, idempotency_key, request_hash, phase_before, phase_after,
  task_id, branch_id, input_epoch, goal_version, config_version, watermark,
  attempt_json, started_at, finished_at
) VALUES (
  :trial_id, :sequence, :idempotency_key, :request_hash, :phase_before, :phase_after,
  :task_id, :branch_id, :input_epoch, :goal_version, :config_version, :watermark,
  :attempt_json, :started_at, :finished_at
)`;

const OBSERVATION_INSERT = `INSERT INTO cfg_observation (
  trial_id, sample_id, observed_at, record_hash, schema_version,
  task_id, branch_id, input_epoch, goal_version, config_version, watermark,
  observation_json
) VALUES (
  :trial_id, :sample_id, :observed_at, :record_hash, :schema_version,
  :task_id, :branch_id, :input_epoch, :goal_version, :config_version, :watermark,
  :observation_json
)`;

const PLAN_INSERT = `INSERT INTO cfg_plan (
  plan_id, schema_version, plan_hash, task_id, branch_id, input_epoch,
  goal_version, config_version, watermark, plan_json, created_at
) VALUES (
  :plan_id, :schema_version, :plan_hash, :task_id, :branch_id, :input_epoch,
  :goal_version, :config_version, :watermark, :plan_json, :created_at
)`;

const CLAIM_INSERT = `INSERT INTO cfg_field_claim (
  config_space_id, field_id, trial_id, schema_version, state, claimed_at, released_at,
  task_id, branch_id, input_epoch, goal_version, config_version, watermark
) VALUES (
  :config_space_id, :field_id, :trial_id, :schema_version, :state, :claimed_at, :released_at,
  :task_id, :branch_id, :input_epoch, :goal_version, :config_version, :watermark
)`;

interface TrialRowShape extends SqlRow {
  trial_json: string;
}

interface PlanRowShape extends SqlRow {
  plan_json: string;
}

interface AttemptRowShape extends SqlRow {
  attempt_json: string;
}

interface CapabilityEvidenceRow extends SqlRow {
  readonly binding_json: string | null;
  readonly probe_result: string | null;
  readonly evidence_stage: string | null;
}

interface GrantRowShape extends SqlRow {
  grant_id: string;
  object_type: string;
  scope_json: string;
  actions_json: string;
  mode: string;
  candidate_id: string | null;
  candidate_hash: string | null;
  expires_at: number | null;
  revoked_at: number | null;
}

interface GrantScopeJson {
  config_spaces?: readonly string[];
  object_ids?: readonly string[];
  config_scope?: {
    field_ids?: readonly string[];
    source_layer_ids?: readonly string[];
    model_scope_keys?: readonly string[];
  };
}

function attemptStateFor(result: ConfigWriteResult): "committed" | "failed" | "uncertain" {
  if (result.state === "verified") {
    return "committed";
  }
  if (result.state === "uncertain" || result.state === "recovery_required") {
    return "uncertain";
  }
  return "failed";
}

function errorCode(code: string | null): ReturnType<typeof configError> | null {
  if (code === null) {
    return null;
  }
  return configError(code as Parameters<typeof configError>[0]);
}

function updateTrial(
  trial: ConfigTrial,
  changes: Partial<Pick<ConfigTrial, "phase" | "evidence_level" | "outcome" | "current_config" | "rollback" | "last_error" | "observation" | "close_audit_ref">>,
  now: EpochMs
): ConfigTrial {
  return {
    ...trial,
    ...changes,
    revision: trial.revision + 1,
    updated_at: now
  };
}

function assignmentFromWrite(value: { field_id: Id<"fld">; path: FieldAssignment["path"]; value: AssignmentValue }): FieldAssignment {
  return { field_id: value.field_id, path: value.path, value: value.value };
}

export function createConfigTrialService(deps: ConfigTrialServiceDeps): ConfigTrialService {
  const enabled = deps.enabled;
  const allowlist = deps.autoTuneFields ?? [];
  const window = deps.observationWindow ?? DEFAULT_WINDOW;
  const deadline = deps.defaultDeadlineMs ?? 30_000;
  const space =
    deps.space ??
    (deps.blobStore === undefined
      ? null
      : createConfigSpaceService({
          rootResolver: deps.rootResolver,
          registry: deps.registry,
          catalog: deps.catalog,
          blobStore: deps.blobStore,
          now: deps.now,
          defaultDeadlineMs: deadline
        }));

  function requireSpace(): ConfigResult<ConfigSpaceService> {
    return space === null
      ? configFailure(
          configError("E_CFG_ROOT_UNRESOLVED", { details: [{ key: "reason", value: "space_service_missing" }] })
        )
      : succeed(space);
  }

  function loadPlanRow(planId: Id<"trial">): PlanRowShape | null {
    return deps.connection.prepare<PlanRowShape>("SELECT plan_json FROM cfg_plan WHERE plan_id = ?").get([planId]) ?? null;
  }

  function loadTrialRow(trialId: Id<"ctr">): TrialRowShape | null {
    return (
      deps.connection.prepare<TrialRowShape>("SELECT trial_json FROM cfg_trial WHERE trial_id = ?").get([trialId]) ??
      null
    );
  }

  function loadPlan(planId: Id<"trial">): ConfigResult<TrialPlan> {
    const row = loadPlanRow(planId);
    if (row === null) {
      return configFailure(configError("E_CFG_PLAN_NOT_FOUND", { details: [{ key: "plan_id", value: planId }] }));
    }
    return succeed(parseJson<TrialPlan>(row.plan_json));
  }

  function loadTrial(trialId: Id<"ctr">): ConfigResult<ConfigTrial> {
    const row = loadTrialRow(trialId);
    if (row === null) {
      return configFailure(configError("E_CFG_TRIAL_NOT_FOUND", { details: [{ key: "trial_id", value: String(trialId) }] }));
    }
    return succeed(parseJson<ConfigTrial>(row.trial_json));
  }

  function loadAttempts(trialId: Id<"ctr">): readonly TrialAttempt[] {
    const rows = deps.connection
      .prepare<AttemptRowShape>("SELECT attempt_json FROM cfg_attempt WHERE trial_id = ? ORDER BY sequence ASC")
      .all([trialId]);
    return rows.map((row) => parseJson<TrialAttempt>(row.attempt_json));
  }

  function loadAttemptByKey(key: string): TrialAttempt | null {
    const row = deps.connection
      .prepare<AttemptRowShape>("SELECT attempt_json FROM cfg_attempt WHERE idempotency_key = ?")
      .get([key]);
    return row === undefined ? null : parseJson<TrialAttempt>(row.attempt_json);
  }

  function loadWriteResult(configWriteId: Id<"cwi">): ConfigWriteResult | null {
    const row = deps.connection
      .prepare<SqlRow>("SELECT * FROM config_write_result WHERE config_write_id = ? ORDER BY attempt DESC LIMIT 1")
      .get([configWriteId]);
    if (row === undefined) {
      return null;
    }
    return {
      schema_version: "rsi.config_write_result/1",
      config_write_id: String(row["config_write_id"]) as Id<"cwi">,
      candidate_id: String(row["candidate_id"]) as Id<"ctr">,
      candidate_hash: String(row["candidate_hash"]) as Hash,
      attempt: Number(row["attempt"]),
      state: String(row["state"]) as ConfigWriteResult["state"],
      path: String(row["path"]),
      candidate_content_hash: row["candidate_content_hash"] === null ? null : (String(row["candidate_content_hash"]) as Hash),
      new_file_hash: row["new_file_hash"] === null ? null : (String(row["new_file_hash"]) as Hash),
      new_semantic_hash: row["new_semantic_hash"] === null ? null : (String(row["new_semantic_hash"]) as Hash),
      snapshot_id: row["snapshot_id"] === null ? null : (String(row["snapshot_id"]) as Id<"wsnap">),
      readback_verified: Number(row["readback_verified"]) === 1,
      protected_subtrees_verified: Number(row["protected_subtrees_verified"]) === 1,
      atomicity: String(row["atomicity"]) as ConfigWriteResult["atomicity"],
      exclusion: String(row["exclusion"]) as ConfigWriteResult["exclusion"],
      error_code: row["error_code"] === null ? null : String(row["error_code"]),
      completed_at: Number(row["completed_at"])
    };
  }

  function loadGrant(grantId: Id<"grant"> | null): GrantRowShape | null {
    if (grantId === null) {
      return null;
    }
    return (
      deps.connection
        .prepare<GrantRowShape>(
          `SELECT grant_id, object_type, scope_json, actions_json, mode, candidate_id,
                  candidate_hash, expires_at, revoked_at
           FROM authorization_grant WHERE grant_id = ? AND revoked_at IS NULL`
        )
        .get([grantId]) ?? null
    );
  }

  function grantScope(row: GrantRowShape): GrantScopeJson {
    try {
      return JSON.parse(row.scope_json) as GrantScopeJson;
    } catch {
      return {};
    }
  }

  function activeTrialExists(configSpaceId: Hash, excluding: Id<"ctr">): boolean {
    const row = deps.connection
      .prepare<SqlRow>(
        `SELECT trial_id FROM cfg_trial
         WHERE config_space_id = ? AND phase NOT IN ('closed','aborted') AND trial_id <> ?
         LIMIT 1`
      )
      .get([configSpaceId, excluding]);
    return row !== undefined;
  }

  function heldClaimExists(configSpaceId: Hash, fieldIds: readonly Id<"fld">[]): boolean {
    for (const fieldId of fieldIds) {
      const row = deps.connection
        .prepare<SqlRow>(
          `SELECT trial_id FROM cfg_field_claim
           WHERE config_space_id = ? AND field_id = ? AND state = 'held' LIMIT 1`
        )
        .get([configSpaceId, fieldId]);
      if (row !== undefined) {
        return true;
      }
    }
    return false;
  }

  function releaseClaims(tx: Tx, trial: ConfigTrial, now: EpochMs): void {
    tx.prepare(
      `UPDATE cfg_field_claim SET state = 'released', released_at = ?
       WHERE trial_id = ? AND state = 'held'`
    ).run([now, trial.trial_id]);
  }

  async function commitPlan(plan: TrialPlan): Promise<ConfigResult<void>> {
    const row = trialPlanRow(plan);
    const rowJson = jcsText(row);
    const frame = buildLedgerFrame({
      rowSchema: TRIAL_PLAN_ROW_SCHEMA,
      rowJson,
      beforeRowJson: null,
      entityId: plan.plan_id,
      operation: "insert",
      binding: plan.task_binding,
      now: deps.now()
    });
    const outcome = await deps.journal.commit(frame.payload, (tx) => {
      tx.prepare(PLAN_INSERT).run(rowParams(row));
      return null;
    });
    const error = commitOutcomeError(outcome);
    return error === null ? succeed(undefined) : configFailure(error);
  }

  async function commitTrial(trial: ConfigTrial, binding: VersionBinding): Promise<ConfigResult<void>> {
    const existing = loadTrialRow(trial.trial_id);
    const row = configTrialRow(trial, binding);
    const rowJson = jcsText(row);
    const frame = buildLedgerFrame({
      rowSchema: CONFIG_TRIAL_ROW_SCHEMA,
      rowJson,
      beforeRowJson: existing === null ? null : existing.trial_json,
      entityId: trial.trial_id,
      operation: existing === null ? "insert" : "transition",
      binding,
      now: deps.now()
    });
    const outcome = await deps.journal.commit(frame.payload, (tx) => {
      if (existing === null) {
        tx.prepare(TRIAL_INSERT).run(rowParams(row));
      } else {
        const changed = tx.prepare(TRIAL_UPDATE).run(trialUpdateParams(row, trial.revision - 1));
        if (changed.changes !== 1) {
          throw new Error("cfg_trial_revision_conflict");
        }
      }
      if (shouldReleaseClaims(trial)) {
        releaseClaims(tx, trial, deps.now());
      }
      return null;
    });
    const error = commitOutcomeError(outcome);
    return error === null ? succeed(undefined) : configFailure(error);
  }

  async function commitAttemptAndTrial(
    attempt: TrialAttempt,
    trial: ConfigTrial,
    binding: VersionBinding
  ): Promise<ConfigResult<void>> {
    const existing = loadTrialRow(trial.trial_id);
    if (existing === null) {
      return configFailure(configError("E_CFG_TRIAL_NOT_FOUND", { details: [{ key: "trial_id", value: attempt.trial_id }] }));
    }
    const attemptRow = trialAttemptRow(attempt, binding);
    const attemptFrame = buildLedgerFrame({
      rowSchema: TRIAL_ATTEMPT_ROW_SCHEMA,
      rowJson: jcsText(attemptRow),
      beforeRowJson: null,
      entityId: `${attempt.trial_id}:${String(attempt.sequence)}`,
      operation: "insert",
      binding,
      now: deps.now()
    });
    const trialRow = configTrialRow(trial, binding);
    const trialFrame = buildLedgerFrame({
      rowSchema: CONFIG_TRIAL_ROW_SCHEMA,
      rowJson: jcsText(trialRow),
      beforeRowJson: existing.trial_json,
      entityId: trial.trial_id,
      operation: "transition",
      binding,
      now: deps.now()
    });
    const frames: readonly JournalFrameBatchEntry[] = [
      {
        payload: attemptFrame.payload,
        project: (tx) => {
          tx.prepare(ATTEMPT_INSERT).run(rowParams(attemptRow));
        }
      },
      {
        payload: trialFrame.payload,
        project: (tx) => {
          const params = { ...rowParams(trialRow), previous_revision: trial.revision - 1 };
          const changed = tx.prepare(TRIAL_UPDATE).run(params);
          if (changed.changes !== 1) {
            throw new Error("cfg_trial_revision_conflict");
          }
          if (shouldReleaseClaims(trial)) {
            releaseClaims(tx, trial, deps.now());
          }
        }
      }
    ];
    const outcome = await deps.journal.commitFrames(frames);
    const error = commitOutcomeError(outcome);
    return error === null ? succeed(undefined) : configFailure(error);
  }

  async function commitObservation(
    record: ObservationRecord,
    trial: ConfigTrial,
    binding: VersionBinding
  ): Promise<ConfigResult<void>> {
    const existing = loadTrialRow(trial.trial_id);
    if (existing === null) {
      return configFailure(configError("E_CFG_TRIAL_NOT_FOUND", { details: [{ key: "trial_id", value: trial.trial_id }] }));
    }
    const observationRow = configObservationRow(record, binding);
    const observationFrame = buildLedgerFrame({
      rowSchema: CONFIG_OBSERVATION_ROW_SCHEMA,
      rowJson: jcsText(observationRow),
      beforeRowJson: null,
      entityId: `${record.trial_id}:${record.sample_id}`,
      operation: "insert",
      binding,
      now: deps.now()
    });
    const trialRow = configTrialRow(trial, binding);
    const trialFrame = buildLedgerFrame({
      rowSchema: CONFIG_TRIAL_ROW_SCHEMA,
      rowJson: jcsText(trialRow),
      beforeRowJson: existing.trial_json,
      entityId: trial.trial_id,
      operation: "transition",
      binding,
      now: deps.now()
    });
    const frames: readonly JournalFrameBatchEntry[] = [
      {
        payload: observationFrame.payload,
        project: (tx) => {
          tx.prepare(OBSERVATION_INSERT).run(rowParams(observationRow));
        }
      },
      {
        payload: trialFrame.payload,
        project: (tx) => {
          const params = { ...rowParams(trialRow), previous_revision: trial.revision - 1 };
          const changed = tx.prepare(TRIAL_UPDATE).run(params);
          if (changed.changes !== 1) {
            throw new Error("cfg_trial_revision_conflict");
          }
          if (shouldReleaseClaims(trial)) {
            releaseClaims(tx, trial, deps.now());
          }
        }
      }
    ];
    const outcome = await deps.journal.commitFrames(frames);
    const error = commitOutcomeError(outcome);
    return error === null ? succeed(undefined) : configFailure(error);
  }

  function fieldIdsOfPlan(plan: TrialPlan): readonly Id<"fld">[] {
    return plan.factor.changes.map((change) => change.field_id);
  }

  function candidateOf(plan: TrialPlan, fieldId: Id<"fld">): AssignmentValue {
    return plan.factor.changes.find((change) => change.field_id === fieldId)?.candidate ?? { presence: "absent" };
  }

  function baselineOf(plan: TrialPlan, fieldId: Id<"fld">): AssignmentValue {
    return plan.factor.changes.find((change) => change.field_id === fieldId)?.baseline ?? { presence: "absent" };
  }

  function classifyFields(plan: TrialPlan, readbacks: readonly FieldReadback[]): {
    all_applied: boolean;
    all_baseline: boolean;
  } {
    let allApplied = readbacks.length > 0;
    let allBaseline = readbacks.length > 0;
    for (const readback of readbacks) {
      if (assignmentValueKey(readback.observed) !== assignmentValueKey(candidateOf(plan, readback.field_id))) {
        allApplied = false;
      }
      if (assignmentValueKey(readback.observed) !== assignmentValueKey(baselineOf(plan, readback.field_id))) {
        allBaseline = false;
      }
    }
    return { all_applied: allApplied, all_baseline: allBaseline };
  }

  function makeAttempt(input: {
    trial: ConfigTrial;
    kind: AttemptKind;
    idempotencyKey: string;
    requestHash: Hash;
    phaseAfter: ConfigTrial["phase"];
    startedAt: EpochMs;
    finishedAt: EpochMs;
    result: TrialAttempt["result"];
    error: TrialAttempt["error"];
    auditInput: TrialAttempt["audit_input"];
  }): TrialAttempt {
    return {
      schema_version: "rsi.trial_attempt/1",
      trial_id: input.trial.trial_id,
      sequence: nextAttemptSequence(loadAttempts(input.trial.trial_id)),
      kind: input.kind,
      phase_before: input.trial.phase,
      phase_after: input.phaseAfter,
      idempotency_key: input.idempotencyKey,
      request_hash: input.requestHash,
      audit_input: input.auditInput,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      result: input.result,
      error: input.error
    };
  }

  async function resolveRoot(rootId: string, deadlineMs: number): Promise<ConfigResult<ResolvedRoot>> {
    const resolved = await deps.rootResolver.resolve({
      root_id: rootId,
      request_id: newId("ipc", Date.now()),
      deadline_ms: deadlineMs
    });
    if (!resolved.ok) {
      return configFailure(configError("E_CFG_ROOT_UNRESOLVED", { details: [{ key: "root_id", value: rootId }] }));
    }
    return succeed(resolved.value);
  }

  async function readback(
    configSpaceId: Hash,
    fieldIds: readonly Id<"fld">[],
    layerId: string
  ): Promise<ConfigResult<readonly FieldReadback[]>> {
    const service = requireSpace();
    if (!service.ok) {
      return service;
    }
    return service.value.readFields({ config_space_id: configSpaceId, field_ids: fieldIds, layer_id: layerId });
  }

  async function capture(selector: ConfigSpaceSelector): Promise<ConfigResult<ConfigSpaceSnapshot>> {
    const service = requireSpace();
    if (!service.ok) {
      return service;
    }
    return service.value.capture(selector);
  }

  function lockFromPlan(
    plan: TrialPlan,
    trial: ConfigTrial,
    action: "update" | "rollback",
    approvedRoot: string,
    expectedVersion: string
  ): ConfigResult<ConfigWriteLockRequest> {
    const patch = action === "update" ? plan.patch_preview.write : plan.patch_preview.rollback;
    if (patch === null) {
      return configFailure(
        configError("E_CFG_FIELD_NOT_EXECUTABLE", { details: [{ key: "patch", value: `${action}_missing` }] })
      );
    }
    const grantId = action === "update" ? trial.authorization.update_grant_id : trial.authorization.rollback_grant_id;
    if (grantId === null) {
      return configFailure(configError("E_CFG_AUTHORIZATION_MISSING", { details: [{ key: "action", value: action }] }));
    }
    return succeed({
      schema_version: "rsi.config_write/1",
      deadline_ms: deadline,
      grant_id: grantId as Id<"grant">,
      action,
      object_type: "config",
      candidate_id: trial.trial_id,
      candidate_hash: patch.patch_hash,
      binding: { ...plan.task_binding, config_version: expectedVersion },
      config_space_id: trial.config_space.config_space_id,
      field_registry_snapshot_hash: plan.registry_pin.snapshot_hash,
      layer_id: patch.layer_id,
      model_scope_key: patch.model_scope_key,
      root_id: trial.config_space.root_id,
      approved_root: approvedRoot,
      target_path: patch.target_path,
      expected_config_version: expectedVersion,
      reason: action === "update" ? "trial_write" : "trial_rollback"
    });
  }

  async function performWrite(input: {
    plan: TrialPlan;
    trial: ConfigTrial;
    patch: ConfigWritePatch;
    action: "update" | "rollback";
    attempt: ExecuteAttempt;
    expectedVersion: string;
  }): Promise<ConfigResult<ConfigWriteResult>> {
    const root = await resolveRoot(input.trial.config_space.root_id, input.attempt.deadline_ms);
    if (!root.ok) {
      return root;
    }
    if (
      root.value.root_identity_pin.device_id !== input.plan.baseline_capture.root_identity_pin.device_id ||
      root.value.root_identity_pin.file_id !== input.plan.baseline_capture.root_identity_pin.file_id
    ) {
      return configFailure(
        configError("E_CFG_ROOT_IDENTITY_MISMATCH", {
          details: [{ key: "root_id", value: input.trial.config_space.root_id }]
        })
      );
    }
    const lockRequest = lockFromPlan(
      input.plan,
      input.trial,
      input.action,
      root.value.approved_root,
      input.expectedVersion
    );
    if (!lockRequest.ok) {
      return lockRequest;
    }
    const locked = await deps.configWrite.lock(lockRequest.value, input.attempt.signal);
    if (!locked.ok) {
      return configFailure(mapConfigWriteError(locked.error));
    }
    const lock: ConfigWriteLock = locked.value;
    if (lock.base_config_version !== input.expectedVersion) {
      await deps.configWrite.abort(
        {
          schema_version: "rsi.config_write/1",
          deadline_ms: input.attempt.deadline_ms,
          lock_handle: lock.lock_handle,
          fencing_token: lock.fencing_token
        },
        input.attempt.signal
      );
      return configFailure(configError("E_CFG_STALE_BASELINE", { details: [{ key: "reason", value: "concurrent_write" }] }));
    }
    const committed = await deps.configWrite.commit(
      {
        schema_version: "rsi.config_write/1",
        deadline_ms: input.attempt.deadline_ms,
        lock_handle: lock.lock_handle,
        fencing_token: lock.fencing_token,
        base_file_hash: lock.base_file_hash,
        patch: input.patch,
        idempotency_key: input.attempt.idempotency_key
      },
      input.attempt.signal
    );
    if (!committed.ok) {
      await deps.configWrite.abort(
        {
          schema_version: "rsi.config_write/1",
          deadline_ms: input.attempt.deadline_ms,
          lock_handle: lock.lock_handle,
          fencing_token: lock.fencing_token
        },
        input.attempt.signal
      );
      return configFailure(
        configError("E_CFG_WRITE_UNCERTAIN", {
          details: [{ key: "upstream_code", value: committed.error.code }]
        })
      );
    }
    return succeed(committed.value);
  }

  return {
    async createPlan(input: CreateTrialPlan): Promise<ConfigResult<TrialPlan>> {
      if (!enabled) {
        return disabledError();
      }
      if (input.factor_input.field_ids.length === 0) {
        return configFailure(configError("E_CFG_FIELD_UNKNOWN", { details: [{ key: "fields", value: "empty" }] }));
      }
      if (requiresCapacityEvidence(input.factor_input.normalization) && deps.capacityEvidencePort === undefined) {
        return configFailure(configError("E_CFG_CAPACITY_UNVERIFIED"));
      }
      const catalogued = deps.catalog.get(input.config_space_selector.config_space_id);
      if (!catalogued.ok) {
        return catalogued;
      }
      const layerId = input.rollback_plan.source_layer_id;
      const layer = catalogued.value.layers.find((candidate) => candidate.layer_id === layerId);
      if (layer === undefined) {
        return configFailure(
          configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "layer_id", value: layerId }] })
        );
      }
      const captured = await capture(input.config_space_selector);
      if (!captured.ok) {
        return captured;
      }
      const fieldPaths = new Map<string, FieldAssignment["path"]>();
      const changes: TrialFieldChange[] = [];
      for (const fieldId of input.factor_input.field_ids) {
        const spec = deps.registry.field_specs.find((candidate) => candidate.field_id === fieldId);
        if (spec === undefined) {
          return configFailure(configError("E_CFG_FIELD_UNKNOWN", { field_id: fieldId }));
        }
        const allowed = checkFieldTunable(spec, allowlist, { require_active: false });
        if (!allowed.ok) {
          return allowed;
        }
        const selected = selectWritableLayer(spec, layerId, input.config_space_selector.trust_evidence_ref !== null);
        if (!selected.ok) {
          return selected;
        }
        const candidate = input.factor_input.candidate.find((assignment) => assignment.field_id === fieldId);
        if (candidate === undefined) {
          return configFailure(configError("E_CFG_FIELD_UNKNOWN", { field_id: fieldId }));
        }
        // The layer path names the file only; the JSON pointer is declared per
        // field by the adapter's compaction spec. Copying the layer pointer
        // would write the empty root pointer and the patch ABI rejects it.
        const pointer = fieldPointer(catalogued.value, spec.field_key, layerId);
        if (pointer === null) {
          return configFailure(
            configError("E_CFG_FIELD_NOT_EXECUTABLE", {
              field_id: fieldId,
              details: [{ key: "missing_field_path", value: spec.field_key }]
            })
          );
        }
        fieldPaths.set(fieldId, { ...selected.value.path, pointer, create: false });
        changes.push({
          field_id: fieldId as Id<"fld">,
          field_key: spec.field_key,
          baseline: captured.value.values.find((assignment) => assignment.field_id === fieldId)?.value ?? {
            presence: "absent"
          },
          candidate: candidate.value
        });
      }
      const patches = buildWritePatches({
        config_space_id: input.config_space_selector.config_space_id,
        field_registry_snapshot_hash: deps.registry.snapshot_hash,
        layer_id: layerId,
        model_scope_key: deps.registry.model_scope_key,
        target_path: { ...filePathFor(layer), create: false },
        // Patch ABI requires ascending unique field ids. The factor's input
        // order is caller-chosen, so normalize here instead of rejecting a
        // valid factor whose fields were not already sorted.
        changes: [...changes].sort((left, right) => compareUtf8(left.field_id, right.field_id)),
        field_paths: fieldPaths,
        protected_subtrees: deps.protectedSubtrees ?? []
      });
      if (!patches.ok) {
        return patches;
      }
      const fieldIds = input.factor_input.field_ids.map((fieldId) => fieldId as Id<"fld">);
      const refs = await readback(input.config_space_selector.config_space_id, fieldIds, layerId);
      if (!refs.ok) {
        return refs;
      }
      const created = await createPlanSeam(input, {
        registry: deps.registry,
        baseline: captured.value,
        capacity_evidence: deps.capacityEvidencePort ?? null,
        plan_id: newId("trial", deps.now()),
        created_at: deps.now(),
        readback_refs: refs.value.map((entry) => entry.evidence_ref),
        deadline_ms: deadline,
        patch_preview: patches.value
      });
      if (!created.ok) {
        return created;
      }
      const stored = await commitPlan(created.value);
      return stored.ok ? created : stored;
    },

    async startTrial(input: StartTrial): Promise<ConfigResult<ConfigTrial>> {
      if (!enabled) {
        return disabledError();
      }
      const plan = loadPlan(input.plan_id);
      if (!plan.ok) {
        return plan;
      }
      const existing = loadTrial(input.trial_id);
      const required = requiredGrantActions(input.execution_kind);
      const updateGrant = loadGrant(input.grant_ids.update as Id<"grant"> | null);
      const rollbackGrant = loadGrant(input.grant_ids.rollback as Id<"grant"> | null);
      const updatePatchHash = plan.value.patch_preview.write?.patch_hash ?? null;
      const rollbackPatchHash = plan.value.patch_preview.rollback?.patch_hash ?? null;
      const fieldIds = fieldIdsOfPlan(plan.value);
      const capabilityTrial = plan.value.capacity_evidence !== null;
      const grants: Partial<Record<"update" | "rollback", GrantRowShape>> = {};
      for (const action of required) {
        const grant = action === "update" ? updateGrant : rollbackGrant;
        const patchHash = action === "update" ? updatePatchHash : rollbackPatchHash;
        const checked = checkConfigGrant({
          grant:
            grant === null
              ? null
              : {
                  grant_id: grant.grant_id as Id<"grant">,
                  object_type: grant.object_type,
                  object_id:
                    grantScope(grant).config_spaces?.[0] ??
                    grantScope(grant).object_ids?.[0] ??
                    "",
                  actions: parseJson<readonly string[]>(grant.actions_json),
                  mode: grant.mode as "once" | "standing",
                  candidate_id: grant.candidate_id,
                  candidate_hash: grant.candidate_hash as Hash | null,
                  expires_at: grant.expires_at,
                  revoked_at: grant.revoked_at,
                  scope: {
                    config_scope: grantScope(grant).config_scope
                      ? {
                          field_ids: (grantScope(grant).config_scope?.field_ids ?? []) as readonly Id<"fld">[],
                          source_layer_ids: grantScope(grant).config_scope?.source_layer_ids ?? [],
                          model_scope_keys: (grantScope(grant).config_scope?.model_scope_keys ?? []) as readonly string[]
                        }
                      : undefined
                  }
                },
          action,
          now: deps.now(),
          config_space_id: input.config_space_id,
          candidate_id: input.trial_id,
          expected_patch_hash: patchHash,
          field_ids: fieldIds,
          source_layer_id: plan.value.config_space_selector.source_layer_id,
          model_scope_key: deps.registry.model_scope_key,
          capacity_trial: capabilityTrial,
          require_capacity: false
        });
        if (!checked.ok) {
          return checked;
        }
        grants[action] = grant as GrantRowShape;
      }
      const updateScope = updateGrant === null ? null : grantScope(updateGrant).config_scope ?? null;
      const rollbackScope = rollbackGrant === null ? null : grantScope(rollbackGrant).config_scope ?? null;
      const authorization = {
        candidate_id: input.trial_id,
        update_grant_id: input.grant_ids.update as Id<"grant"> | null,
        rollback_grant_id: input.grant_ids.rollback as Id<"grant"> | null,
        update_patch_hash: updatePatchHash,
        rollback_patch_hash: rollbackPatchHash,
        scope_hash: scopeHashFor({
          plan_id: plan.value.plan_id,
          plan_hash: plan.value.plan_hash,
          trial_id: input.trial_id,
          candidate_id: input.trial_id,
          selector: plan.value.config_space_selector,
          requirement: {
            field_ids: fieldIds,
            source_layer_ids: [plan.value.config_space_selector.source_layer_id],
            model_scope_key: deps.registry.model_scope_key,
            config_space_id: input.config_space_id
          },
          update:
            input.grant_ids.update === null || updatePatchHash === null
              ? null
              : { grant_id: input.grant_ids.update as Id<"grant">, action: "update", patch_hash: updatePatchHash },
          update_scope:
            updateScope === null
              ? null
              : {
                  field_ids: (updateScope.field_ids ?? []) as readonly Id<"fld">[],
                  source_layer_ids: updateScope.source_layer_ids ?? [],
                  model_scope_keys: (updateScope.model_scope_keys ?? []) as readonly [string, ...string[]]
                },
          rollback:
            input.grant_ids.rollback === null || rollbackPatchHash === null
              ? null
              : { grant_id: input.grant_ids.rollback as Id<"grant">, action: "rollback", patch_hash: rollbackPatchHash },
          rollback_scope:
            rollbackScope === null
              ? null
              : {
                  field_ids: (rollbackScope.field_ids ?? []) as readonly Id<"fld">[],
                  source_layer_ids: rollbackScope.source_layer_ids ?? [],
                  model_scope_keys: (rollbackScope.model_scope_keys ?? []) as readonly [string, ...string[]]
                }
        }),
        checked_at: deps.now()
      };
      const frozen = {
        plan_id: plan.value.plan_id,
        config_space_id: input.config_space_id,
        execution_kind: input.execution_kind,
        predecessor_trial_id: input.predecessor_trial_id,
        evidence_basis:
          input.execution_kind === "observe_only"
            ? ("inherited_candidate" as const)
            : input.execution_kind === "rollback_only"
              ? ("rollback_only" as const)
              : ("own_write" as const),
        authorization,
        capability_snapshot_hash: plan.value.host.capability_snapshot_hash,
        binding: plan.value.task_binding
      };
      const replay = startTrialReplayDecision(
        existing.ok ? { trial: existing.value, binding: plan.value.task_binding } : null,
        frozen
      );
      if (replay === "existing") {
        return existing;
      }
      if (replay === "conflict") {
        return configFailure(
          configError("E_CFG_IDEMPOTENCY_CONFLICT", { details: [{ key: "trial_id", value: input.trial_id }] })
        );
      }
      const current = await capture(plan.value.config_space_selector);
      if (!current.ok) {
        return current;
      }
      const started = startTrialSeam(input, {
        plan: plan.value,
        config_space: current.value.config_space,
        authorization,
        active_trial_exists: activeTrialExists(input.config_space_id, input.trial_id),
        held_claim_exists: heldClaimExists(input.config_space_id, fieldIds),
        created_at: deps.now(),
        baseline_confirmed: true,
        current_config_version: current.value.config_version,
        current_semantic_hash: current.value.semantic_hash
      });
      if (!started.ok) {
        return started;
      }
      const row = configTrialRow(started.value, plan.value.task_binding);
      const frame = buildLedgerFrame({
        rowSchema: CONFIG_TRIAL_ROW_SCHEMA,
        rowJson: jcsText(row),
        beforeRowJson: null,
        entityId: started.value.trial_id,
        operation: "insert",
        binding: plan.value.task_binding,
        now: deps.now()
      });
      const outcome = await deps.journal.commit(frame.payload, (tx) => {
        tx.prepare(TRIAL_INSERT).run(rowParams(row));
        for (const fieldId of fieldIds) {
          const claim = fieldClaimRow({
            config_space_id: input.config_space_id,
            field_id: fieldId,
            trial_id: started.value.trial_id,
            claimed_at: deps.now(),
            released_at: null,
            binding: plan.value.task_binding
          });
          tx.prepare(CLAIM_INSERT).run(rowParams(claim));
        }
        return null;
      });
      const error = commitOutcomeError(outcome);
      return error === null ? succeed(started.value) : configFailure(error);
    },

    async executeAttempt(input: ExecuteAttempt): Promise<ConfigResult<TrialAttempt>> {
      if (!enabled) {
        return disabledError();
      }
      const deadlineCheck = validateDeadline(input.deadline_ms);
      if (!deadlineCheck.ok) {
        return deadlineCheck;
      }
      const trial = loadTrial(input.trial_id as Id<"ctr">);
      if (!trial.ok) {
        return trial;
      }
      if (input.expected_revision !== trial.value.revision) {
        return configFailure(
          configError("E_CFG_STALE_BASELINE", {
            details: [
              { key: "expected_revision", value: input.expected_revision },
              { key: "revision", value: trial.value.revision }
            ]
          })
        );
      }
      const notTerminal = assertTrialNotTerminal(trial.value);
      if (!notTerminal.ok) {
        return notTerminal;
      }
      const allowed = checkAttemptKind(input.kind, trial.value.execution_kind, trial.value.phase);
      if (!allowed.ok) {
        return allowed;
      }
      const plan = loadPlan(trial.value.plan_id);
      if (!plan.ok) {
        return plan;
      }
      if (input.kind === "observation" || input.kind === "reconcile") {
        return configFailure(
          configError("E_CFG_ILLEGAL_TRANSITION", { details: [{ key: "kind", value: input.kind }] })
        );
      }
      const patch =
        input.kind === "write" || input.kind === "readback" || input.kind === "apply_probe"
          ? plan.value.patch_preview.write
          : plan.value.patch_preview.rollback;
      if (patch === null) {
        return configFailure(
          configError("E_CFG_FIELD_NOT_EXECUTABLE", { details: [{ key: "patch", value: `${input.kind}_missing` }] })
        );
      }
      const patchCheck = verifyPatchHash(patch);
      if (!patchCheck.ok) {
        return patchCheck;
      }
      if (input.kind === "rollback_write" && trial.value.execution_kind !== "rollback_only") {
        const rollbackTarget = resolveConfigRollbackTarget({
          trial: trial.value,
          plan: plan.value,
          attempts: loadAttempts(trial.value.trial_id),
          loadWriteResult
        });
        if (!rollbackTarget.ok) {
          return rollbackTarget;
        }
      }
      const requestHash = canonicalHash({
        trial_id: input.trial_id,
        kind: input.kind,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
        patch_hash: patch.patch_hash
      });
      const existingAttempt = loadAttemptByKey(input.idempotency_key);
      if (existingAttempt !== null) {
        if (existingAttempt.request_hash !== requestHash) {
          return configFailure(
            configError("E_CFG_IDEMPOTENCY_CONFLICT", { details: [{ key: "idempotency_key", value: input.idempotency_key }] })
          );
        }
        return succeed(existingAttempt);
      }
      const now = deps.now();
      const startedAt = now;
      const fieldIds = patch.candidate_values.map((value) => value.field_id);

      if (input.kind === "write" || input.kind === "rollback_write") {
        const expectedValues = patch.expected_fields.map((value) => assignmentFromWrite(value));
        const pre = await readback(trial.value.config_space.config_space_id, fieldIds, patch.layer_id);
        if (!pre.ok) {
          return pre;
        }
        if (!fieldSetMatches(pre.value, expectedValues)) {
          return configFailure(
            configError("E_CFG_STALE_BASELINE", { details: [{ key: "reason", value: "live_binding_changed" }] })
          );
        }
        const current = await capture(plan.value.config_space_selector);
        if (!current.ok) {
          return current;
        }
        if (
          isStaleBaseline(
            current.value,
            plan.value.baseline_capture.config_version,
            plan.value.baseline_capture.semantic_hash
          ) &&
          input.kind === "write"
        ) {
          return configFailure(configError("E_CFG_STALE_BASELINE"));
        }
        const expectedVersion =
          input.kind === "write"
            ? plan.value.baseline_capture.config_version
            : trial.value.current_config.config_version ?? plan.value.baseline_capture.config_version;
        const written = await performWrite({
          plan: plan.value,
          trial: trial.value,
          patch,
          action: input.kind === "write" ? "update" : "rollback",
          attempt: input,
          expectedVersion
        });
        if (!written.ok) {
          const auditInput = {
            schema_version: "rsi.cfg_write_attempt_audit/1" as const,
            config_space_id: trial.value.config_space.config_space_id,
            field_registry_snapshot_hash: plan.value.registry_pin.snapshot_hash,
            root_id: trial.value.config_space.root_id,
            target_path: patch.target_path,
            attempted_field_ids: fieldIds,
            patch_hash: patch.patch_hash,
            config_write_id: null
          };
          const auditCheck = validateAttemptAuditInput(input.kind, auditInput);
          if (!auditCheck.ok) {
            return auditCheck;
          }
          const failedAttempt = makeAttempt({
            trial: trial.value,
            kind: input.kind,
            idempotencyKey: input.idempotency_key,
            requestHash,
            phaseAfter: trial.value.phase === "authorized" ? "authorized" : "recovery_required",
            startedAt,
            finishedAt: deps.now(),
            result: null,
            error: written.error,
            auditInput
          });
          const failedTrial = updateTrial(
            trial.value,
            { phase: failedAttempt.phase_after, last_error: written.error },
            deps.now()
          );
          await commitAttemptAndTrial(failedAttempt, failedTrial, plan.value.task_binding);
          return written;
        }
        const result = written.value;
        const after = await readback(trial.value.config_space.config_space_id, fieldIds, patch.layer_id);
        if (!after.ok) {
          return after;
        }
        const classified = classifyFields(plan.value, after.value);
        const evidence =
          result.state === "verified" && classified.all_applied
            ? ("candidate_or_partial" as const)
            : classified.all_baseline
              ? ("baseline_no_write" as const)
              : ("unreadable_or_third_value" as const);
        const mapping = input.kind === "rollback_write"
          ? mapRollbackWriteResult(result.state, evidence)
          : mapWriteResult(result.state, evidence);
        const nextPhase = mapping.phase;
        let evidenceLevel = trial.value.evidence_level;
        if (input.kind === "write" && result.state === "verified" && classified.all_applied) {
          evidenceLevel = evidenceLevel === "none" ? "written_unverified" : evidenceLevel;
        }
        const candidateValues = patch.candidate_values.map((value) => assignmentFromWrite(value));
        const baselineValues = patch.expected_fields.map((value) => assignmentFromWrite(value));
        // The rollback patch is the inverse of the write patch: its
        // `candidate_values` are the baseline assignments to restore. The
        // forward `candidate_confirmed` projection must not be reused for it.
        const restoredValues = candidateValues;
        const forwardConfirmedValues = input.kind === "write" ? candidateValues : baselineValues;
        const forwardBaselineValues = baselineValues;
        const nextTrial = updateTrial(
          trial.value,
          {
            phase: nextPhase,
            evidence_level: evidenceLevel,
            outcome: mapping.outcome,
            last_error: errorCode(mapping.last_error_code),
            rollback: {
              ...trial.value.rollback,
              state: mapping.rollback_state,
              target_values: input.kind === "write" ? baselineValues : trial.value.rollback.target_values,
              ...(input.kind === "rollback_write" && result.state === "verified" && classified.all_baseline
                ? { readback_ref: after.value[0]?.evidence_ref ?? null }
                : {})
            },
            current_config:
              input.kind === "write" && classified.all_applied
                ? {
                    state: "candidate_confirmed",
                    values: forwardConfirmedValues,
                    observed_at: after.value[0]?.observed_at ?? deps.now(),
                    readback_ref: after.value[0]?.evidence_ref ?? null,
                    config_version: after.value[0]?.config_version ?? current.value.config_version
                  }
                : classified.all_baseline
                  ? {
                      state: "baseline_confirmed",
                      values: input.kind === "rollback_write" ? restoredValues : forwardBaselineValues,
                      observed_at: after.value[0]?.observed_at ?? deps.now(),
                      readback_ref: after.value[0]?.evidence_ref ?? null,
                      config_version: after.value[0]?.config_version ?? current.value.config_version
                    }
                  : trial.value.current_config
          },
          deps.now()
        );
        const auditInput = {
          schema_version: "rsi.cfg_write_attempt_audit/1" as const,
          config_space_id: trial.value.config_space.config_space_id,
          field_registry_snapshot_hash: plan.value.registry_pin.snapshot_hash,
          root_id: trial.value.config_space.root_id,
          target_path: patch.target_path,
          attempted_field_ids: fieldIds,
          patch_hash: patch.patch_hash,
          config_write_id: result.config_write_id
        };
        const attempt = makeAttempt({
          trial: trial.value,
          kind: input.kind,
          idempotencyKey: input.idempotency_key,
          requestHash,
          phaseAfter: nextTrial.phase,
          startedAt,
          finishedAt: deps.now(),
          result: {
            kind: "write",
            write_result_ref: result.config_write_id,
            state: attemptStateFor(result),
            file_hash_after: result.new_file_hash,
            changed_field_ids: fieldIds
          },
          error: errorCode(mapping.last_error_code),
          auditInput
        });
        const stored = await commitAttemptAndTrial(attempt, nextTrial, plan.value.task_binding);
        return stored.ok ? succeed(attempt) : stored;
      }

      if (input.kind === "readback") {
        const observed = await readback(trial.value.config_space.config_space_id, fieldIds, patch.layer_id);
        if (!observed.ok) {
          return observed;
        }
        const classified = classifyFields(plan.value, observed.value);
        const nextPhase = classified.all_applied
          ? "awaiting_apply"
          : classified.all_baseline
            ? trial.value.phase
            : "recovery_required";
        const nextTrial = updateTrial(
          trial.value,
          {
            phase: nextPhase,
            last_error:
              nextPhase === "recovery_required"
                ? configError("E_CFG_FIELD_CONFLICT")
                : nextPhase === "awaiting_apply"
                  ? null
                  : configError("E_CFG_APPLY_UNCONFIRMED"),
            current_config: classified.all_applied
              ? {
                  state: "candidate_confirmed",
                  values: patch.candidate_values.map((value) => assignmentFromWrite(value)),
                  observed_at: observed.value[0]?.observed_at ?? deps.now(),
                  readback_ref: observed.value[0]?.evidence_ref ?? null,
                  config_version: observed.value[0]?.config_version ?? null
                }
              : trial.value.current_config
          },
          deps.now()
        );
        const attempt = makeAttempt({
          trial: trial.value,
          kind: "readback",
          idempotencyKey: input.idempotency_key,
          requestHash,
          phaseAfter: nextTrial.phase,
          startedAt,
          finishedAt: deps.now(),
          result: { kind: "readback", values: observed.value },
          error: nextTrial.last_error,
          auditInput: null
        });
        const stored = await commitAttemptAndTrial(attempt, nextTrial, plan.value.task_binding);
        return stored.ok ? succeed(attempt) : stored;
      }

      if (input.kind === "apply_probe") {
        const probed = await deps.reloadProbe.probe({
          trial_id: trial.value.trial_id,
          config_space_id: trial.value.config_space.config_space_id,
          field_ids: fieldIds,
          layer_id: patch.layer_id,
          deadline_ms: input.deadline_ms,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        if (!probed.ok) {
          const attempt = makeAttempt({
            trial: trial.value,
            kind: "apply_probe",
            idempotencyKey: input.idempotency_key,
            requestHash,
            phaseAfter: trial.value.phase,
            startedAt,
            finishedAt: deps.now(),
            result: null,
            error: probed.error,
            auditInput: null
          });
          const nextTrial = updateTrial(trial.value, { last_error: probed.error }, deps.now());
          await commitAttemptAndTrial(attempt, nextTrial, plan.value.task_binding);
          return probed;
        }
        const probe = probed.value.probe;
        const resolvedMatches = fieldIds.every((fieldId) => {
          const resolved = probe.resolved.find((assignment) => assignment.field_id === fieldId);
          return resolved !== undefined && assignmentValueKey(resolved.value) === assignmentValueKey(candidateOf(plan.value, fieldId));
        });
        const effective = probeProvesEffective(probe) && resolvedMatches;
        let nextTrial = updateTrial(
          trial.value,
          {
            phase: effective ? "observing" : "awaiting_apply",
            evidence_level: levelAfterProbe(trial.value.evidence_level, effective ? probe : null),
            last_error: effective ? null : configError("E_CFG_APPLY_UNCONFIRMED"),
            current_config: effective
              ? {
                  state: "candidate_confirmed",
                  values: patch.candidate_values.map((value) => assignmentFromWrite(value)),
                  observed_at: probe.observed_at,
                  readback_ref: probe.evidence_ref,
                  config_version: trial.value.current_config.config_version
                }
              : trial.value.current_config
          },
          deps.now()
        );
        if (effective) {
          const opened = openObservationWindow(nextTrial, plan.value.observation_window.profile_id);
          if (!opened.ok) {
            return opened;
          }
          nextTrial = opened.value;
        }
        const attempt = makeAttempt({
          trial: trial.value,
          kind: "apply_probe",
          idempotencyKey: input.idempotency_key,
          requestHash,
          phaseAfter: nextTrial.phase,
          startedAt,
          finishedAt: deps.now(),
          result: { kind: "probe", probe },
          error: nextTrial.last_error,
          auditInput: null
        });
        const stored = await commitAttemptAndTrial(attempt, nextTrial, plan.value.task_binding);
        return stored.ok ? succeed(attempt) : stored;
      }

      // rollback_readback
      const target = plan.value.patch_preview.rollback;
      if (target === null) {
        return configFailure(configError("E_CFG_ROLLBACK_UNCERTAIN"));
      }
      const targetIds = target.candidate_values.map((value) => value.field_id);
      const observed = await readback(trial.value.config_space.config_space_id, targetIds, target.layer_id);
      if (!observed.ok) {
        return observed;
      }
      const restored = fieldSetMatches(observed.value, target.candidate_values.map((value) => assignmentFromWrite(value)));
      const nextTrial = updateTrial(
        trial.value,
        {
          phase: restored ? "closed" : "recovery_required",
          outcome: restored ? "rolled_back" : trial.value.outcome,
          last_error: restored ? null : configError("E_CFG_ROLLBACK_CONFLICT"),
          rollback: restored
            ? { ...trial.value.rollback, state: "baseline_confirmed", readback_ref: observed.value[0]?.evidence_ref ?? null }
            : { ...trial.value.rollback, state: "conflict" },
          current_config: restored
            ? {
                state: "baseline_confirmed",
                values: target.candidate_values.map((value) => assignmentFromWrite(value)),
                observed_at: observed.value[0]?.observed_at ?? deps.now(),
                readback_ref: observed.value[0]?.evidence_ref ?? null,
                config_version: observed.value[0]?.config_version ?? null
              }
            : trial.value.current_config
        },
        deps.now()
      );
      const outcome = validateOutcomeCombination({
        phase: nextTrial.phase,
        evidence_level: nextTrial.evidence_level,
        outcome: nextTrial.outcome,
        rollback: nextTrial.rollback,
        has_write_attempt: loadAttempts(nextTrial.trial_id).some((attempt) => attempt.kind === "write")
      });
      if (!outcome.ok) {
        return outcome;
      }
      const attempt = makeAttempt({
        trial: trial.value,
        kind: "rollback_readback",
        idempotencyKey: input.idempotency_key,
        requestHash,
        phaseAfter: nextTrial.phase,
        startedAt,
        finishedAt: deps.now(),
        result: { kind: "readback", values: observed.value },
        error: nextTrial.last_error,
        auditInput: null
      });
      const stored = await commitAttemptAndTrial(attempt, nextTrial, plan.value.task_binding);
      return stored.ok ? succeed(attempt) : stored;
    },

    async recordObservation(input: RecordObservation): Promise<ConfigResult<ConfigTrial>> {
      if (!enabled) {
        return disabledError();
      }
      const trial = loadTrial(input.trial_id as Id<"ctr">);
      if (!trial.ok) {
        return trial;
      }
      const windowCheck = requireOpenWindow(trial.value);
      if (!windowCheck.ok) {
        return windowCheck;
      }
      const plan = loadPlan(trial.value.plan_id);
      if (!plan.ok) {
        return plan;
      }
      const existingRow = deps.connection
        .prepare<SqlRow>("SELECT observation_json FROM cfg_observation WHERE trial_id = ? AND sample_id = ?")
        .get([input.trial_id, input.sample_id]);
      const existing =
        existingRow === undefined ? null : parseJson<ObservationRecord>(existingRow["observation_json"]);
      const body = canonicalJsonText({
        trial_id: input.trial_id,
        sample_id: input.sample_id,
        observed_at: input.observed_at,
        trigger: input.trigger,
        telemetry: input.telemetry,
        probe: input.probe,
        guardrails: input.guardrails
      } as unknown as JsonValue);
      if (existing !== null && observationReplayDecision(existing, { ...input, trial_id: input.trial_id as Id<"ctr"> }) === "conflict") {
        return configFailure(
          configError("E_CFG_IDEMPOTENCY_CONFLICT", { details: [{ key: "sample_id", value: input.sample_id }] })
        );
      }
      const stored = await deps.blobStore?.put(new TextEncoder().encode(body));
      const evidenceRef =
        stored !== undefined && stored.ok
          ? evidenceRefFor(stored.value.hash, stored.value.byte_length)
          : (`blob://${canonicalHash({ observation: input.sample_id })}#bytes=0-${String(body.length)}` as SourceRef);
      const attempts = loadAttempts(trial.value.trial_id);
      const auditRequest = {
        request_id: newId("ipc", deps.now()),
        config_space_id: trial.value.config_space.config_space_id,
        field_registry_snapshot_hash: plan.value.registry_pin.snapshot_hash,
        root_id: trial.value.config_space.root_id,
        root_identity_pin: trial.value.config_space.root_identity_pin,
        protected_subtrees: deps.protectedSubtrees ?? [],
        attempt_refs: attempts.map((attempt) => ({ trial_id: attempt.trial_id, sequence: attempt.sequence })),
        deadline_ms: deadline
      };
      const recorded = await recordObservationSeam(input, {
        trial: trial.value,
        existing_observation: existing,
        evidence_ref: evidenceRef,
        observation_window: window,
        safety_audit: deps.safetyAudit ?? null,
        audit_request: auditRequest
      });
      if (!recorded.ok) {
        return recorded;
      }
      if (recorded.value === trial.value) {
        return recorded;
      }
      const record = buildObservationRecord({
        trial_id: trial.value.trial_id,
        sample_id: input.sample_id,
        observed_at: input.observed_at,
        trigger: input.trigger,
        telemetry: input.telemetry,
        probe: input.probe,
        guardrails: input.guardrails,
        evidence_ref: evidenceRef
      });
      const persisted = await commitObservation(record, recorded.value, plan.value.task_binding);
      return persisted.ok ? recorded : persisted;
    },

    async requestRollback(input: RequestRollback): Promise<ConfigResult<ConfigTrial>> {
      if (!enabled) {
        return disabledError();
      }
      const trial = loadTrial(input.trial_id as Id<"ctr">);
      if (!trial.ok) {
        return trial;
      }
      const plan = loadPlan(trial.value.plan_id);
      if (!plan.ok) {
        return plan;
      }
      const current = await capture(plan.value.config_space_selector);
      const transitioned = requestRollbackTransition(
        trial.value,
        input.reason,
        input.attestation,
        deps.now(),
        input.expected_revision,
        current.ok ? { config_version: current.value.config_version, semantic_hash: current.value.semantic_hash } : undefined
      );
      if (!transitioned.ok) {
        return transitioned;
      }
      const persisted = await commitTrial(transitioned.value, plan.value.task_binding);
      return persisted.ok ? transitioned : persisted;
    },

    async closeTrial(input: CloseTrial): Promise<ConfigResult<ConfigTrial>> {
      if (!enabled) {
        return disabledError();
      }
      const trial = loadTrial(input.trial_id as Id<"ctr">);
      if (!trial.ok) {
        return trial;
      }
      if (input.expected_revision !== trial.value.revision) {
        return configFailure(configError("E_CFG_STALE_BASELINE"));
      }
      const reasonCheck = checkCloseReason(trial.value.phase, input.reason);
      if (!reasonCheck.ok) {
        return reasonCheck;
      }
      let next: ConfigResult<ConfigTrial>;
      if (trial.value.phase === "recovery_required" && input.reason === "abandoned") {
        next = closeAbandonedTransition(trial.value, input.attestation, deps.now());
      } else if (input.reason === "failed") {
        next = succeed(
          updateTrial(
            trial.value,
            { phase: "closed", outcome: "failed", last_error: trial.value.last_error ?? configError("E_CFG_WRITE_FAILED") },
            deps.now()
          )
        );
      } else if (trial.value.rollback.state === "baseline_confirmed") {
        next = succeed(updateTrial(trial.value, { phase: "closed", outcome: "rolled_back" }, deps.now()));
      } else {
        const outcome =
          trial.value.evidence_level === "causal"
            ? "effect_supported"
            : trial.value.evidence_level === "effective" || trial.value.evidence_level === "applied"
              ? "inconclusive"
              : "not_exercised";
        next = succeed(updateTrial(trial.value, { phase: "closed", outcome }, deps.now()));
      }
      if (!next.ok) {
        return next;
      }
      const combination = validateOutcomeCombination({
        phase: next.value.phase,
        evidence_level: next.value.evidence_level,
        outcome: next.value.outcome,
        rollback: next.value.rollback,
        has_write_attempt: loadAttempts(next.value.trial_id).some((attempt) => attempt.kind === "write")
      });
      if (!combination.ok) {
        return combination;
      }
      const plan = loadPlan(trial.value.plan_id);
      if (!plan.ok) {
        return plan;
      }
      const persisted = await commitTrial(next.value, plan.value.task_binding);
      return persisted.ok ? next : persisted;
    },

    async reconcile(now: EpochMs): Promise<ConfigResult<ReconcileReport>> {
      if (!enabled) {
        return disabledError();
      }
      const rows = deps.connection
        .prepare<TrialRowShape>(
          "SELECT trial_json FROM cfg_trial WHERE phase NOT IN ('closed','aborted') ORDER BY updated_at ASC"
        )
        .all();
      const entries: ReconcileEntry[] = [];
      for (const row of rows) {
        const trial = parseJson<ConfigTrial>(row.trial_json);
        if (trial.phase === "recovery_required") {
          // Quarantine is operator-owned. Reconcile reports the live reason
          // and writes nothing: no phase change, no new attempt, no claim
          // release. `requestRollback` and `closeTrial(abandoned)` are the
          // only exits.
          const attempts = loadAttempts(trial.trial_id);
          const lastWrite = [...attempts]
            .reverse()
            .find((attempt) => attempt.kind === "write" || attempt.kind === "rollback_write");
          entries.push({
            trial_id: trial.trial_id,
            attempt:
              lastWrite === undefined
                ? null
                : { trial_id: trial.trial_id, sequence: lastWrite.sequence },
            action: "recovery_required",
            phase_after: "recovery_required",
            error_code: trial.last_error?.code ?? "E_CFG_RECOVERY_REQUIRED"
          });
          continue;
        }
        const plan = loadPlan(trial.plan_id);
        if (!plan.ok) {
          continue;
        }
        const patch =
          trial.execution_kind === "rollback_only"
            ? plan.value.patch_preview.rollback
            : plan.value.patch_preview.write;
        if (patch === null) {
          continue;
        }
        const fieldIds = patch.candidate_values.map((value) => value.field_id);
        const observed = await readback(trial.config_space.config_space_id, fieldIds, patch.layer_id);
        let fieldState: "baseline" | "candidate" | "third_value" | "unreadable" = "unreadable";
        if (observed.ok) {
          const classified = classifyFields(plan.value, observed.value);
          fieldState = classified.all_applied
            ? "candidate"
            : classified.all_baseline
              ? "baseline"
              : "third_value";
        }
        const attempts = loadAttempts(trial.trial_id);
        const lastWrite = [...attempts].reverse().find((attempt) => attempt.kind === "write" || attempt.kind === "rollback_write");
        const writeKind: "write" | "rollback_write" | "unknown" =
          lastWrite === undefined ? "unknown" : lastWrite.kind === "rollback_write" ? "rollback_write" : "write";
        let entry = reconcileEntryFor({
          trial_id: trial.trial_id,
          attempt: lastWrite === undefined ? null : { trial_id: trial.trial_id, sequence: lastWrite.sequence },
          phase: trial.phase,
          write_kind: writeKind,
          field_state: fieldState,
          rollback_requested: trial.rollback.state === "pending",
          ...(trial.last_error === null ? {} : { error_code: trial.last_error.code })
        });
        // A rollback that was requested but has not reached the file yet must
        // not be reconciled back into candidate observation merely because the
        // forward write attempt is the newest one.
        if (trial.phase === "rolling_back" && fieldState === "candidate" && entry.phase_after !== "rolling_back") {
          entry = {
            trial_id: entry.trial_id,
            attempt: entry.attempt,
            action: "rollback_pending",
            phase_after: "rolling_back",
            error_code: null
          };
        }
        // The readback may describe a state the trial cannot reach from here.
        // Never persist an illegal transition: report the observation and stay
        // on the current phase, leaving claims untouched.
        if (entry.phase_after !== trial.phase && !canTransition(trial.phase, entry.phase_after)) {
          entries.push({
            ...entry,
            action: "no_action",
            phase_after: trial.phase
          });
          continue;
        }
        entries.push(entry);
        if (entry.phase_after !== trial.phase) {
          const rollbackClosed =
            writeKind === "rollback_write" &&
            entry.action === "recovered_readback" &&
            entry.phase_after === "closed" &&
            observed.ok;
          const rollbackPatch = plan.value.patch_preview.rollback;
          const nextTrial = updateTrial(
            trial,
            {
              phase: entry.phase_after,
              last_error: rollbackClosed ? null : entry.error_code === null ? trial.last_error : configError(entry.error_code),
              outcome: rollbackClosed
                ? "rolled_back"
                : entry.phase_after === "closed" && entry.action === "marked_failed"
                  ? "failed"
                  : trial.outcome,
              ...(rollbackClosed && rollbackPatch !== null
                ? {
                    rollback: {
                      ...trial.rollback,
                      state: "baseline_confirmed" as const,
                      readback_ref: observed.value[0]?.evidence_ref ?? null
                    },
                    current_config: {
                      state: "baseline_confirmed" as const,
                      values: rollbackPatch.candidate_values.map((value) => assignmentFromWrite(value)),
                      observed_at: observed.value[0]?.observed_at ?? now,
                      readback_ref: observed.value[0]?.evidence_ref ?? null,
                      config_version: observed.value[0]?.config_version ?? null
                    }
                  }
                : {})
            },
            now
          );
          const outcome = validateOutcomeCombination({
            phase: nextTrial.phase,
            evidence_level: nextTrial.evidence_level,
            outcome: nextTrial.outcome,
            rollback: nextTrial.rollback,
            has_write_attempt: attempts.some((attempt) => attempt.kind === "write")
          });
          if (!outcome.ok) {
            continue;
          }
          const attempt: TrialAttempt = {
            schema_version: "rsi.trial_attempt/1",
            trial_id: trial.trial_id,
            sequence: nextAttemptSequence(attempts),
            kind: "reconcile",
            phase_before: trial.phase,
            phase_after: entry.phase_after,
            idempotency_key: `reconcile:${trial.trial_id}:${String(now)}:${String(attempts.length + 1)}`,
            request_hash: canonicalHash({ reconcile: trial.trial_id, now, action: entry.action }),
            audit_input: null,
            started_at: now,
            finished_at: now,
            result: {
              kind: "reconcile",
              reconciled_attempt: entry.attempt,
              action: entry.action
            },
            error: entry.error_code === null ? null : configError(entry.error_code)
          };
          await commitAttemptAndTrial(attempt, nextTrial, plan.value.task_binding);
        }
      }
      return succeed({
        checked_at: now,
        scanned_trials: rows.length,
        entries,
        unresolved_trial_ids: entries
          .filter((entry) => entry.action === "recovery_required" || entry.phase_after === "recovery_required")
          .map((entry) => entry.trial_id as Id)
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Promotion evidence collection (W10)                                 */
/* ------------------------------------------------------------------ */

interface CompactionPromotionDeps {
  readonly connection: SqliteConnection;
  readonly space: ConfigSpaceService;
  readonly reloadProbe: ConfigReloadProbePort;
  readonly now: () => EpochMs;
}

/**
 * Reads the persisted `product_adapter` capability row for the trial's
 * binding. The newest row wins so an older `passed` record cannot outlive a
 * newer probe that downgraded it. Missing rows or a missing table are
 * "no evidence", never a synthetic pass.
 */
function readCompactionCapabilityEvidence(
  connection: SqliteConnection,
  bindingKey: Hash
): { readonly probe_result: PromotionCapabilityEvidence["probe_result"]; readonly evidence_stage: PromotionCapabilityEvidence["evidence_stage"] } | null {
  let rows: readonly CapabilityEvidenceRow[];
  try {
    rows = connection
      .prepare<CapabilityEvidenceRow>(
        `SELECT binding_json, probe_result, evidence_stage
           FROM capability_record
          WHERE binding_key = ?
          ORDER BY checked_at DESC, capability_id ASC`
      )
      .all([bindingKey]);
  } catch {
    return null;
  }
  for (const row of rows) {
    let subject: unknown;
    try {
      subject = (JSON.parse(String(row.binding_json)) as { subject?: unknown }).subject;
    } catch {
      continue;
    }
    if (subject !== "product_adapter") {
      continue;
    }
    return {
      probe_result:
        row.probe_result !== null && isHostProbeResult(row.probe_result)
          ? row.probe_result
          : "unknown",
      evidence_stage:
        row.evidence_stage !== null && isEvidenceStage(row.evidence_stage)
          ? row.evidence_stage
          : "none"
    };
  }
  return null;
}

/**
 * Builds promotion evidence from a real, already persisted trial:
 *
 * 1. the trial must project `candidate_confirmed` for this field;
 * 2. a committed `write` attempt and its `config_write_result` must exist;
 * 3. a fresh `readFields` readback must still equal the candidate;
 * 4. the persisted `product_adapter` capability record must exist, and its
 *    `probe_result`/`evidence_stage` are passed through unchanged;
 * 5. for `h_unverified`, a real reload probe must resolve the candidate.
 *
 * The write evidence is the same content-addressed readback range: the write
 * result proves the commit, and the ref proves the bytes that committed.
 * This function never mutates `FieldSpec.status`; the caller evaluates
 * `evaluateCompactionPromotion` and persists the returned spec.
 */
export async function collectCompactionPromotionEvidence(
  input: {
    readonly trial_id: Id<"ctr">;
    readonly field_id: Id<"fld">;
    readonly spec: FieldSpec;
    readonly deadline_ms?: number;
  },
  deps: CompactionPromotionDeps
): Promise<ConfigResult<PromotionEvidence>> {
  const trialRow = deps.connection
    .prepare<TrialRowShape>("SELECT trial_json FROM cfg_trial WHERE trial_id = ?")
    .get([input.trial_id]);
  if (trialRow === undefined) {
    return fail(configError("E_CFG_TRIAL_NOT_FOUND", { details: [{ key: "trial_id", value: input.trial_id }] }));
  }
  const trial = parseJson<ConfigTrial>(trialRow.trial_json);
  const planRow = deps.connection
    .prepare<PlanRowShape>("SELECT plan_json FROM cfg_plan WHERE plan_id = ?")
    .get([trial.plan_id]);
  if (planRow === undefined) {
    return fail(configError("E_CFG_PLAN_NOT_FOUND", { details: [{ key: "plan_id", value: trial.plan_id }] }));
  }
  const plan = parseJson<TrialPlan>(planRow.plan_json);
  const change = plan.factor.changes.find((candidate) => candidate.field_id === input.field_id);
  if (change === undefined) {
    return fail(
      configError("E_CFG_AUTHORIZATION_SCOPE", {
        field_id: input.field_id,
        details: [{ key: "trial_id", value: input.trial_id }]
      })
    );
  }
  const projected = trial.current_config.values.find((assignment) => assignment.field_id === input.field_id);
  if (
    trial.current_config.state !== "candidate_confirmed" ||
    projected === undefined ||
    assignmentValueKey(projected.value) !== assignmentValueKey(change.candidate)
  ) {
    return fail(
      configError("E_CFG_APPLY_UNCONFIRMED", {
        field_id: input.field_id,
        details: [{ key: "trial_projection", value: trial.current_config.state }]
      })
    );
  }
  const attempts = deps.connection
    .prepare<AttemptRowShape>("SELECT attempt_json FROM cfg_attempt WHERE trial_id = ? ORDER BY sequence ASC")
    .all([input.trial_id])
    .map((row) => parseJson<TrialAttempt>(row.attempt_json));
  const writeAttempt = [...attempts]
    .reverse()
    .find((attempt) => attempt.kind === "write" && attempt.result?.kind === "write" && attempt.result.state === "committed");
  if (writeAttempt === undefined) {
    return fail(
      configError("E_CFG_WRITE_FAILED", {
        field_id: input.field_id,
        details: [{ key: "reason", value: "committed_write_attempt_missing" }]
      })
    );
  }
  const layerId = plan.patch_preview.write?.layer_id ?? plan.rollback_plan.source_layer_id;
  const readbackResult = await deps.space.readFields({
    config_space_id: trial.config_space.config_space_id,
    field_ids: [input.field_id],
    layer_id: layerId
  });
  if (!readbackResult.ok) {
    return readbackResult;
  }
  const readback = readbackResult.value.find((entry) => entry.field_id === input.field_id);
  if (readback === undefined) {
    return fail(configError("E_CFG_APPLY_UNCONFIRMED", { field_id: input.field_id }));
  }
  if (assignmentValueKey(readback.observed) !== assignmentValueKey(change.candidate)) {
    return fail(
      configError("E_CFG_APPLY_UNCONFIRMED", {
        field_id: input.field_id,
        details: [{ key: "readback", value: "candidate_mismatch" }]
      })
    );
  }
  // Capability evidence must come from the persisted record. Synthesising
  // passed/roundtrip here would let the evaluator promote a field whose
  // capability the database still reports as unknown or none.
  const capability = readCompactionCapabilityEvidence(
    deps.connection,
    plan.host.capability_binding_key
  );
  if (capability === null) {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        field_id: input.field_id,
        details: [
          { key: "reason", value: "capability_record_missing" },
          { key: "binding_key", value: plan.host.capability_binding_key }
        ]
      })
    );
  }
  let reload: EffectiveProbe | null = null;
  if (input.spec.status === "h_unverified") {
    const probed = await deps.reloadProbe.probe({
      trial_id: input.trial_id,
      config_space_id: trial.config_space.config_space_id,
      field_ids: [input.field_id],
      layer_id: layerId,
      deadline_ms: input.deadline_ms ?? 30_000
    });
    if (!probed.ok) {
      return probed;
    }
    reload = probed.value.probe;
  }
  const evidence: PromotionEvidence = {
    host_id: input.spec.host_id,
    field_id: input.field_id,
    candidate: change.candidate,
    write_evidence: readback.evidence_ref,
    readback,
    reload,
    capability
  };
  return succeed(evidence);
}

/**
 * Promotion service bound to one host registry. The caller supplies only a
 * trial and field; the field spec (and therefore its status) comes from the
 * frozen registry, so an IPC client cannot forge `active`.
 */
export interface CompactionPromotionService {
  collect(input: {
    readonly trial_id: Id<"ctr">;
    readonly field_id: Id<"fld">;
    readonly deadline_ms?: number;
  }): Promise<ConfigResult<PromotionEvidence>>;
}

interface CompactionPromotionServiceDeps extends CompactionPromotionDeps {
  readonly registry: FieldRegistrySnapshot;
}

export function createCompactionPromotionService(
  deps: CompactionPromotionServiceDeps
): CompactionPromotionService {
  return {
    async collect(input): Promise<ConfigResult<PromotionEvidence>> {
      const spec = deps.registry.field_specs.find((entry) => entry.field_id === input.field_id);
      if (spec === undefined) {
        return fail(configError("E_CFG_FIELD_UNKNOWN", { field_id: input.field_id }));
      }
      const promotionInput = {
        trial_id: input.trial_id,
        field_id: input.field_id,
        spec,
        ...(input.deadline_ms === undefined ? {} : { deadline_ms: input.deadline_ms })
      };
      return collectCompactionPromotionEvidence(promotionInput, deps);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Rollback target resolution                                          */
/* ------------------------------------------------------------------ */

interface ConfigRollbackTarget {
  readonly patch: ConfigWritePatch;
  readonly write_attempt: TrialAttempt | null;
  readonly write_result: ConfigWriteResult | null;
  readonly snapshot_id: Id<"wsnap"> | null;
}

/**
 * Resolves `trial -> attempt -> ConfigWriteResult -> snapshot` and verifies
 * the frozen rollback patch hash. A missing or inconsistent link is
 * `E_CFG_ROLLBACK_UNCERTAIN`: no rollback write is attempted.
 */
function resolveConfigRollbackTarget(input: {
  readonly trial: ConfigTrial;
  readonly plan: TrialPlan;
  readonly attempts: readonly TrialAttempt[];
  readonly loadWriteResult: (id: Id<"cwi">) => ConfigWriteResult | null;
}): ConfigResult<ConfigRollbackTarget> {
  const patch = input.plan.patch_preview.rollback;
  if (patch === null) {
    return fail(configError("E_CFG_ROLLBACK_UNCERTAIN", { details: [{ key: "reason", value: "patch_missing" }] }));
  }
  const verified = verifyPatchHash(patch);
  if (!verified.ok) {
    return verified;
  }
  if (
    input.trial.authorization.rollback_patch_hash === null ||
    input.trial.authorization.rollback_patch_hash !== patch.patch_hash
  ) {
    return fail(
      configError("E_CFG_ROLLBACK_UNCERTAIN", { details: [{ key: "reason", value: "patch_hash_mismatch" }] })
    );
  }
  if (input.trial.execution_kind === "rollback_only") {
    return succeed({ patch, write_attempt: null, write_result: null, snapshot_id: null });
  }
  const writes = input.attempts.filter(
    (attempt) => attempt.kind === "write" && attempt.result?.kind === "write"
  );
  const last = writes[writes.length - 1];
  if (last === undefined || last.result?.kind !== "write") {
    return fail(
      configError("E_CFG_ROLLBACK_UNCERTAIN", { details: [{ key: "reason", value: "write_attempt_missing" }] })
    );
  }
  if (last.result.state !== "committed") {
    return fail(
      configError("E_CFG_ROLLBACK_UNCERTAIN", {
        details: [{ key: "reason", value: "write_not_committed" }, { key: "state", value: last.result.state }]
      })
    );
  }
  const result = input.loadWriteResult(last.result.write_result_ref as Id<"cwi">);
  if (result === null || result.snapshot_id === null) {
    return fail(
      configError("E_CFG_ROLLBACK_UNCERTAIN", { details: [{ key: "reason", value: "snapshot_missing" }] })
    );
  }
  return succeed({
    patch,
    write_attempt: last,
    write_result: result,
    snapshot_id: result.snapshot_id
  });
}
