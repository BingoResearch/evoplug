/**
 * `cli.execute` — CLI commands executed by the running kernel (G2).
 *
 * The CLI routes state-changing and read-only commands here when `serve` is
 * running, so the single writer is the server instead of a second process
 * competing for `kernel.lock`. The kernel owns the connection, the shared
 * journal and the review services; no local lock is acquired.
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  makeErrorEnvelope,
  newId,
  ok,
  systemClock,
  toJsonValue,
  type ErrorEnvelope,
  type Hash,
  type JsonValue,
  type Result
} from "@evoplug/core";
import {
  canonicalConfigJson,
  computeConfigContentHash,
  computeConfigVersion,
  createDefaultEvidenceWriter,
  approveHostRoots,
  candidateRoot,
  createManagedRootResolver,
  ensureConfirmationRow,
  markAdopted,
  performAdoption,
  toHumanAttestationKind,
  readCandidate,
  candidateSkillName,
  candidateFullText,
  listPendingCandidateInfos,
  requeueCandidate,
  resolveManagedRootPath,
  createSourceRefPort,
  fieldError,
  findPlaintextSecret,
  homeLayout,
  internalError,
  isTestModeHomeSync,
  kernelError,
  parseConfigText,
  provisionJevBinding,
  readConfigFile,
  readInitCompleteMarker,
  writeFileAtomicDurable,
  resolveGenerationEgressPolicy,
  activateStandingEgressPolicy,
  type AuthorizationGrant,
  type EvoplugConfig,
  type GrantIssueRequest,
  type GrantRevokeRequest,
  type InitCompleteMarker,
  type KernelReviewServices
} from "@evoplug/kernel";
import {
  BlobStore,
  JournalWriter,
  activateConfigProfile as activateConfigProfileRecord,
  createTransactionRunner,
  readSchemaMeta,
  type SqliteConnection,
  type SqlRow
} from "@evoplug/storage";
import { attachDefaults } from "./host-registry.js";
import { buildJevInputWithProbe, parseLimitsOptions, validateCredentialEnv } from "./configure-input.js";
import { readHostVersion } from "./host-version.js";
import {
  clearHostEnvironment,
  loadHostEnvironment,
  persistHostEnvironment,
  withCredentialEnv,
  type HostEnvironment
} from "./host-environment.js";
import {
  attachHost,
  detachHost,
  registerManagedRoots,
  revokeHostRuntimeSessions,
  detachManagedBlock,
  revokeManagedRootsForHost,
  type HostAttachResolution,
  type HostAttachTargetPlan
} from "@evoplug/kernel";
import { validateAdapterDescriptor } from "@evoplug/core/host";

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


import { createJournalCommitter } from "@evoplug/storage";
import { createOriginProofPort } from "@evoplug/core/host";
import {
  createGrant,
  grantIssueSubjectHash,
  grantRevokeSubjectHash,
  revokeGrant,
  toGrantPublicView,
  validateGrantIssueRequest
} from "@evoplug/kernel";
import { createWriteApplyHandler } from "@evoplug/kernel";
import { createPackagedGenerationRegistry } from "./host-registry.js";
import { resolveGenerationExecutable } from "./review-generation.js";
import { attachedHosts, runGenerationProbe } from "./generation-probe.js";

export interface CliExecuteParams {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | true>>;
}

export interface CliExecuteJournal {
  readonly writer: JournalWriter;
  readonly relative_path: string;
  readonly owned: boolean;
}

export interface CliExecuteDeps {
  readonly connection: SqliteConnection;
  readonly home: string;
  readonly config: EvoplugConfig;
  readonly blobStore: BlobStore;
  readonly reviewServices: KernelReviewServices;
  readonly now: () => number;
  /** Opens a journal writer when the kernel has no shared feature journal. */
  readonly open_journal: () => CliExecuteJournal | null;
  /** Release artifact directory used by attach. */
  readonly artifact_dir: string | null;
  readonly product_version: string;
  readonly schema_major: number;
}

function option(params: CliExecuteParams, name: string): string | null {
  const value = params.options[name];
  return typeof value === "string" ? value : null;
}

function flag(params: CliExecuteParams, name: string): boolean {
  return params.options[name] === true;
}

function missing(name: string): ErrorEnvelope {
  return fieldError(`--${name}`, "missing_required");
}

function unsupported(message: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_UNSUPPORTED",
    category: "policy",
    message_key: "error.e_unsupported",
    stage: "cli.execute",
    details: { kind: "field", path: "command", rule: message }
  });
}

function json<T>(value: T): JsonValue {
  return toJsonValue(value);
}

/* ------------------------------------------------------------------ */
/* Config write (no lock: the server is the writer)                    */
/* ------------------------------------------------------------------ */

function applyConfigProfile(
  connection: SqliteConnection,
  config: EvoplugConfig,
  configVersion: string,
  configHash: Hash,
  now: number
): void {
  const runner = createTransactionRunner(connection);
  runner.withTxSync((tx) => {
    activateConfigProfileRecord(tx, {
      config_space: config.config_space,
      config_version: configVersion,
      canonical_json: canonicalConfigJson(config),
      content_hash: configHash,
      created_at: now
    });
    return undefined;
  });
}

function markerWithConfig(
  marker: InitCompleteMarker,
  configVersion: string,
  configHash: Hash,
  schemaMinor: number
): InitCompleteMarker {
  return {
    root: marker.root,
    product_version: marker.product_version,
    schema_major: marker.schema_major,
    config_version: configVersion,
    db_hash_marker: canonicalHash({
      schema_major: marker.schema_major,
      schema_minor: schemaMinor,
      config_version: configVersion,
      config_hash: configHash
    }),
    created_at: marker.created_at
  };
}

async function commitConfig(
  deps: CliExecuteDeps,
  current: EvoplugConfig,
  next: EvoplugConfig,
  marker: InitCompleteMarker
): Promise<Result<JsonValue, ErrorEnvelope>> {
  const layout = homeLayout(deps.home);
  const nextVersion = computeConfigVersion(next);
  const nextHash = computeConfigContentHash(next);
  const previousText = await readFile(layout.config_path, "utf8").catch((): null => null);
  const previousMarkerText = await readFile(layout.init_complete_path, "utf8").catch((): null => null);
  if (
    nextVersion === marker.config_version &&
    previousText !== null &&
    canonicalConfigJson(next) === previousText
  ) {
    return ok(json({ status: "no_op", config_version: nextVersion, config_hash: nextHash, via: "ipc" }));
  }
  const written = await writeFileAtomicDurable(layout.config_path, canonicalConfigJson(next));
  if (!written.ok) {
    return err(written.error, written.status);
  }
  let schemaMinor = 0;
  try {
    applyConfigProfile(deps.connection, next, nextVersion, nextHash, Date.now());
    schemaMinor = Number(readSchemaMeta(deps.connection).get("schema_minor") ?? 0);
  } catch {
    if (previousText !== null) {
      await writeFileAtomicDurable(layout.config_path, previousText);
    }
    applyConfigProfile(deps.connection, current, marker.config_version, computeConfigContentHash(current), Date.now());
    return err(internalError("kernel.cli_execute_configure_db_failed"), "degraded");
  }
  const nextMarker = markerWithConfig(marker, nextVersion, nextHash, schemaMinor);
  const markerWritten = await writeFileAtomicDurable(
    layout.init_complete_path,
    `${JSON.stringify(nextMarker)}\n`
  );
  if (!markerWritten.ok) {
    if (previousText !== null) {
      await writeFileAtomicDurable(layout.config_path, previousText);
    }
    if (previousMarkerText !== null) {
      await writeFileAtomicDurable(layout.init_complete_path, previousMarkerText);
    }
    return err(markerWritten.error, markerWritten.status);
  }
  return ok(json({ status: "created", config_version: nextVersion, config_hash: nextHash, via: "ipc" }));
}

async function loadConfigContext(
  deps: CliExecuteDeps
): Promise<Result<{ current: EvoplugConfig; marker: InitCompleteMarker }, ErrorEnvelope>> {
  const marker = await readInitCompleteMarker(deps.home);
  if (!marker.ok) {
    return err(marker.error, marker.status);
  }
  if (marker.value === null) {
    return err(kernelError("E_HOME_INCOMPATIBLE"), "rejected");
  }
  const current = await readConfigFile(deps.home);
  if (!current.ok) {
    return err(current.error, current.status);
  }
  return ok({ current: current.value, marker: marker.value });
}

/* ------------------------------------------------------------------ */
/* Jev provisioning (shared journal, no second writer)                 */
/* ------------------------------------------------------------------ */

async function provisionJev(
  deps: CliExecuteDeps,
  parsed: unknown,
  label: string,
  extra: { readonly evidence_bytes?: Uint8Array | null; readonly warnings?: readonly string[] } = {}
): Promise<Result<JsonValue, ErrorEnvelope>> {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)["profile"] !== "object" ||
    typeof (parsed as Record<string, unknown>)["capability"] !== "object"
  ) {
    return err(fieldError(label, "jev_provision_schema"));
  }
  const record = parsed as Record<string, unknown>;
  const profile = record["profile"] as Record<string, unknown>;
  const credentialRef = profile["credential_ref"];
  if (typeof credentialRef !== "string" || credentialRef.length === 0) {
    return err(fieldError("profile.credential_ref", "missing"));
  }
  const plaintext = findPlaintextSecret(parsed);
  if (plaintext !== null) {
    return err(fieldError(plaintext.replace(/^\$\./u, ""), "plaintext_secret"));
  }
  const journal = deps.open_journal();
  if (journal === null) {
    return err(internalError("kernel.cli_execute_journal_unavailable"), "degraded");
  }
  try {
    if (extra.evidence_bytes !== null && extra.evidence_bytes !== undefined) {
      const stored = deps.blobStore.putSync(extra.evidence_bytes);
      if (!stored.ok) return stored;
      deps.connection
        .prepare(
          `INSERT INTO blob (
             blob_hash, byte_length, relative_path, state, verified_at, created_at,
             deleted_at, deletion_reason
           ) VALUES (
             :blob_hash, :byte_length, :relative_path, 'present', :now, :now, NULL, NULL
           )
           ON CONFLICT(blob_hash) DO UPDATE SET
             state = 'present',
             verified_at = excluded.verified_at,
             deleted_at = NULL,
             deletion_reason = NULL`
        )
        .run({
          blob_hash: stored.value.hash,
          byte_length: stored.value.byte_length,
          relative_path: stored.value.relative_path,
          now: deps.now()
        });
    }
    const writer = createDefaultEvidenceWriter({
      connection: deps.connection,
      writer: journal.writer,
      relative_path: journal.relative_path,
      blob_store: deps.blobStore,
      now: deps.now
    });
    const provisioning = await provisionJevBinding(writer.writer, {
      profile: profile as never,
      capability: record["capability"] as never,
      now: deps.now(),
      expected_profile_version: null,
      expected_capability_version: null,
      connection: deps.connection
    });
    if (!provisioning.ok) {
      return err(provisioning.error, provisioning.status);
    }
    return ok(json({
      status: provisioning.commit_state === "existing" ? "existing" : "created",
      profile_key: provisioning.value.profile.profile_key,
      capability_key: provisioning.value.capability.capability_key,
      validator_binding_key: provisioning.value.validator.validator_binding_key,
      acceptance: provisioning.value.profile.acceptance.status,
      ...(provisioning.value.profile.acceptance.reasons.length === 0
        ? {}
        : { acceptance_reasons: provisioning.value.profile.acceptance.reasons }),
      ...(extra.warnings === undefined || extra.warnings.length === 0
        ? {}
        : { warnings: [...extra.warnings] }),
      via: "ipc"
    }));
  } finally {
    if (journal.owned) {
      journal.writer.close();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Host attach / detach                                                */
/* ------------------------------------------------------------------ */

async function attachOrDetach(
  _deps: CliExecuteDeps,
  params: CliExecuteParams,
  command: "attach" | "detach"
): Promise<Result<JsonValue, ErrorEnvelope>> {
  const host = params.positionals[0];
  if (host === undefined || host.length === 0) {
    return err(missing("host"));
  }
  // Appendix H.1: attach and detach both resolve host directory paths from the
  // caller's host environment. The long-lived server cannot see that
  // environment, so both stay local CLI operations instead of silently using
  // paths from the server process.
  return err(unsupported(`${command}_requires_local_host_env`));
}

/* ------------------------------------------------------------------ */
/* Appendix I.1: local attach/detach registered by the running serve  */
/* ------------------------------------------------------------------ */

export interface HostAttachExecuteParams {
  readonly command: "attach" | "detach";
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly target_id?: string;
  readonly resolution: JsonValue;
  readonly host_version: string | null;
  readonly supported_range: string | null;
  readonly version_supported: boolean;
  readonly roots: ReadonlyArray<{
    readonly kind: "skill" | "memory" | "instructions";
    readonly absolute_path: string;
  }>;
  /**
   * Appendix M.1: the attach caller's project root. The instructions root's
   * project id is derived from this path, never from the server process cwd.
   */
  readonly project_root?: string;
  /**
   * The attach caller's environment, already reduced to path/locale keys
   * (appendix J.5). Required for attach; detach may omit it.
   */
  readonly host_env?: HostEnvironment;
}

/**
 * Applies a caller-resolved attach/detach inside the server, which owns the
 * writer lock. The caller resolved every path from its own host environment;
 * the server only records and writes those exact absolute paths.
 */
export async function executeHostAttach(
  deps: CliExecuteDeps,
  params: HostAttachExecuteParams
): Promise<Result<JsonValue, ErrorEnvelope>> {
  try {
    return await executeHostAttachUnsafe(deps, params);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      level: "error",
      message: "kernel.host_attach_execute_threw",
      command: params.command,
      host_id: params.host_id,
      cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : null
    })}\n`);
    return err(internalError("kernel.host_attach_execute"));
  }
}

async function executeHostAttachUnsafe(
  deps: CliExecuteDeps,
  params: HostAttachExecuteParams
): Promise<Result<JsonValue, ErrorEnvelope>> {
  const resolutionRaw: JsonValue = params.resolution;
  if (!isRecord(resolutionRaw)) {
    return err(fieldError("resolution", "object_required"));
  }
  const validated = validateAdapterDescriptor(resolutionRaw["descriptor"]);
  if (!validated.ok) return err(validated.error);
  const descriptor = validated.value;
  if (descriptor.host_id !== params.host_id) {
    return err(fieldError("host_id", "descriptor_host_mismatch"));
  }
  if (!descriptor.supported_modes.includes(params.mode as never)) {
    return err(fieldError("mode", "descriptor_mode"));
  }
  if (!descriptor.config_spaces.includes(params.config_space)) {
    return err(fieldError("config_space", "descriptor_config_space"));
  }
  const targets = resolutionRaw["targets"];
  if (!Array.isArray(targets) || targets.length === 0) {
    return err(fieldError("resolution.targets", "non_empty_array"));
  }
  const declaredTargets = new Set(descriptor.registration_targets.map((target) => target.target_id));
  for (const target of targets) {
    if (!isRecord(target) || !isRecord(target["target"])) {
      return err(fieldError("resolution.targets", "target_plan_object"));
    }
    const targetId = (target["target"] as Record<string, JsonValue>)["target_id"];
    if (typeof targetId !== "string" || !declaredTargets.has(targetId)) {
      return err(fieldError("resolution.targets.target_id", "target_not_declared"));
    }
  }
  const resolution = {
    descriptor,
    targets: targets as unknown as readonly HostAttachTargetPlan[]
  } satisfies HostAttachResolution;
  const registrationRequest = {
    host_id: params.host_id,
    mode: params.mode,
    config_space: params.config_space,
    ...(params.target_id === undefined ? {} : { target_id: params.target_id })
  } as never;
  const result = await (params.command === "attach" ? attachHost : detachHost)({
    connection: deps.connection,
    blobs: deps.blobStore,
    registry: {
      resolve: () => ok(resolution)
    },
    ...(params.command === "detach"
      ? {
          sessions: {
            revokeBindingSessions: (registrationHash: Hash) => {
              try {
                return ok(
                  revokeHostRuntimeSessions({
                    connection: deps.connection,
                    now: deps.now(),
                    registration_hash: registrationHash
                  })
                );
              } catch {
                return err(internalError("kernel.host_detach_session_revoke"));
              }
            }
          }
        }
      : {}),
    now: deps.now,
    home_root: deps.home,
    product_version: deps.product_version,
    schema_major: deps.schema_major,
    host_version: params.host_version,
    ...(params.supported_range === null ? {} : { supported_range: params.supported_range }),
    version_supported: params.version_supported
  })(registrationRequest);
  if (!result.ok) return err(result.error);
  if (params.command === "attach") {
    // Appendix Q.1: the server registers the same subset the caller resolved;
    // memory and instructions require `features: ["managed_blocks"]`.
    const currentConfig = await readConfigFile(deps.home);
    const managedBlocks = currentConfig.ok &&
      currentConfig.value.features?.includes("managed_blocks") === true;
    const registered = registerManagedRoots({
      connection: deps.connection,
      host_id: params.host_id as never,
      mode: params.mode as never,
      config_space: params.config_space,
      adapter_id: descriptor.adapter_id,
      host_env: params.host_env ?? {},
      ...(params.project_root === undefined ? {} : { project_root: params.project_root }),
      resolved_roots: params.roots.map((root) => ({
        kind: root.kind,
        absolute_path: root.absolute_path
      })),
      managed_blocks: managedBlocks,
      now: deps.now()
    });
    if (!registered.ok) return err(registered.error);
    // Appendix J.5: the caller's host environment is registered by the writer.
    // If it is missing, the probe is blocked instead of silently borrowing the
    // server process environment.
    const hostEnv = params.host_env === undefined
      ? null
      : persistHostEnvironment({
          home: deps.home,
          host_id: params.host_id,
          env: params.host_env,
          now: deps.now()
        });
    const probe = params.version_supported && hostEnv !== null
      ? await probeGenerationForHost(deps, {
          host_id: params.host_id,
          mode: params.mode,
          config_space: params.config_space,
          host_env: hostEnv
        })
      : params.version_supported
        ? toJsonValue({ status: "blocked", reason: "host_env_unregistered" })
        : null;
    return ok(toJsonValue({
      ...(result.value as unknown as Record<string, JsonValue>),
      managed_roots: registered.value.map((root) => ({
        root_id: root.root_id,
        kind: root.kind,
        state: root.state
      })),
      ...(probe === null ? {} : { generation_probe: probe }),
      via: "ipc"
    }));
  }
  const revoked = revokeManagedRootsForHost(deps.connection, params.host_id, deps.now());
  clearHostEnvironment(deps.home, params.host_id);
  return ok(toJsonValue({
    ...(result.value as unknown as Record<string, JsonValue>),
    managed_roots: { revoked },
    via: "ipc"
  }));
}

/* ------------------------------------------------------------------ */
/* Doctor (read-only, executed by the server)                          */
/* ------------------------------------------------------------------ */

async function doctor(deps: CliExecuteDeps, params?: CliExecuteParams): Promise<Result<JsonValue, ErrorEnvelope>> {
  if (params !== undefined && option(params, "probe") === "generation") {
    const hosts = attachedHosts(deps.connection);
    const results: JsonValue[] = [];
    for (const host of hosts) {
      const hostEnv = loadHostEnvironment(deps.home, host.host_id);
      results.push(toJsonValue({
        host_id: host.host_id,
        config_space: host.config_space,
        probe: hostEnv === null
          ? { status: "blocked", reason: "host_env_unregistered" }
          : await probeGenerationForHost(deps, { ...host, host_env: hostEnv })
      }));
    }
    return ok(toJsonValue({
      schema_version: "rsi.cli_doctor/1",
      home: deps.home,
      status: "ok",
      probe: "generation",
      hosts: results,
      via: "ipc"
    }));
  }
  const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
  const config = await readConfigFile(deps.home);
  checks.push({ name: "config.json", status: config.ok ? "ok" : "fail", detail: config.ok ? "parsed" : config.error.code });
  checks.push({ name: "kernel", status: "ok", detail: "status.get: ready (via ipc)" });
  checks.push({ name: "journal", status: "ok", detail: "owned by serve" });
  return ok(json({
    schema_version: "rsi.cli_doctor/1",
    home: deps.home,
    status: checks.some((check) => check.status === "fail") ? "fail" : "ok",
    checks,
    via: "ipc"
  }));
}

/* ------------------------------------------------------------------ */
/* Review and skills                                                   */
/* ------------------------------------------------------------------ */

/** Maps a REV service error to the wire envelope; REV types stay package-local. */
function reviewError(error: { readonly code: string; readonly stage?: string; readonly retryable?: boolean; readonly cause?: string }): ErrorEnvelope {
  const category = error.code.includes("AUTH")
    ? "authorization"
    : error.code.includes("CONFLICT")
      ? "conflict"
      : error.code.startsWith("E_STORAGE")
        ? "storage"
        : error.code.startsWith("E_DEADLINE")
          ? "deadline"
          : "policy";
  return makeErrorEnvelope({
    code: error.code as ErrorEnvelope["code"],
    category,
    message_key: `error.${error.code.toLowerCase()}`,
    stage: error.stage ?? "cli.execute",
    retryable: error.retryable ?? false,
    side_effect: "none",
    details: error.cause === undefined ? { kind: "none" } : { kind: "field", path: "review", rule: error.cause }
  });
}

async function reviewOrSkills(
  deps: CliExecuteDeps,
  params: CliExecuteParams
): Promise<Result<JsonValue, ErrorEnvelope>> {
  const services = deps.reviewServices;
  switch (params.command) {
    case "review": {
      const result = await services.enqueueReview({ task: params.positionals[0] ?? null });
      if (!result.ok) return err(reviewError(result.error));
      return ok(json({ ...result.value, via: "ipc" }));
    }
    case "skills.diff": {
      const id = params.positionals[0];
      if (id === undefined) return err(missing("id"));
      const result = await services.skillDiff({ id });
      if (!result.ok) return err(reviewError(result.error));
      return ok(json({ ...result.value, via: "ipc" }));
    }
    case "skills.revoke": {
      const id = params.positionals[0];
      if (id === undefined) return err(missing("id"));
      const result = await services.skillRevoke({ id, actor: "user" });
      if (!result.ok) return err(reviewError(result.error));
      return ok(json({ ...result.value, via: "ipc" }));
    }
    case "skills.resolve": {
      const id = params.positionals[0];
      if (id === undefined) return err(missing("id"));
      const result = await services.skillResolve({ id });
      if (!result.ok) return err(reviewError(result.error));
      return ok(json({ ...result.value, via: "ipc" }));
    }
    default:
      return err(unsupported(`unknown_command:${params.command}`));
  }
}


/** `env:NAME` names the variable a host CLI reads; the value is never stored. */
function dependencyCredentialEnv(secret_ref: string | null | undefined): string | undefined {
  return typeof secret_ref === "string" && secret_ref.startsWith("env:")
    ? secret_ref.slice("env:".length)
    : undefined;
}

async function probeGenerationForHost(deps: CliExecuteDeps, host: {
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly host_env: Readonly<Record<string, string>>;
}): Promise<JsonValue | null> {
  const registry = createPackagedGenerationRegistry();
  const entry = registry.list?.().find((candidate) => candidate.spec.host_id === host.host_id) ?? null;
  if (entry === null) return null;
  const credentialEnv = deps.config.review_backend.enabled
    ? dependencyCredentialEnv(deps.config.review_backend.secret_ref)
    : undefined;
  const probeEnv = withCredentialEnv(host.host_env, credentialEnv, process.env);
  const executable = resolveGenerationExecutable(entry.spec, undefined, probeEnv);
  if (executable === null) {
    return toJsonValue({ status: "blocked", reason: "generation_executable_not_found", backend_id: entry.spec.backend_id });
  }
  const detected = readHostVersion(host.host_id as never, probeEnv);
  if (detected.host_version === null) {
    return toJsonValue({ status: "blocked", reason: "host_version_unavailable", backend_id: entry.spec.backend_id });
  }
  const probed = await runGenerationProbe({
    home: deps.home,
    connection: deps.connection,
    blobs: deps.blobStore,
    spec: entry.spec,
    ...(entry.glue_path === undefined ? {} : { glue_path: entry.glue_path }),
    backend_id: entry.spec.backend_id,
    host_id: host.host_id,
    mode: host.mode,
    config_space: host.config_space,
    executable,
    host_version: detected.host_version,
    host_env: probeEnv,
    ...(deps.config.review_backend.enabled && deps.config.review_backend.pricing !== undefined
      ? { pricing: deps.config.review_backend.pricing }
      : {}),
    now: deps.now
  });
  if (!probed.ok) {
    return toJsonValue({ status: "failed", reason: probed.error.code, backend_id: entry.spec.backend_id });
  }
  return toJsonValue({
    status: probed.value.verdict.output === "passed" ? "verified" : "failed",
    backend_id: entry.spec.backend_id,
    binding_key: probed.value.binding_key,
    create: probed.value.verdict.create,
    auth: probed.value.verdict.auth,
    output: probed.value.verdict.output,
    blocker: probed.value.verdict.blocker,
    failure: probed.value.verdict.failure,
    ...(probed.value.next_step === null ? {} : { next_step: probed.value.next_step })
  });
}

/* ------------------------------------------------------------------ */
/* Candidate confirmation, adoption and grants (server writer)        */
/* ------------------------------------------------------------------ */

function proofFor(deps: CliExecuteDeps): ReturnType<typeof createOriginProofPort> {
  return createOriginProofPort({
    withTx: createTransactionRunner(deps.connection).withTx,
    clock: systemClock,
    sourceRefs: createSourceRefPort({ connection: deps.connection, blob_store: deps.blobStore }),
    test_mode: isTestModeHomeSync(deps.home)
  });
}

function writeHandler(deps: CliExecuteDeps): Result<ReturnType<typeof createWriteApplyHandler>, ErrorEnvelope> {
  const journal = deps.open_journal();
  if (journal === null) return err(internalError("kernel.cli_execute_journal_unavailable"), "degraded");
  const committer = createJournalCommitter({
    writer: journal.writer,
    connection: deps.connection,
    relative_path: journal.relative_path,
    now: deps.now
  });
  return ok(createWriteApplyHandler({
    connection: deps.connection,
    blob_store: deps.blobStore,
    now: deps.now,
    home: deps.home,
    root_resolver: createManagedRootResolver(deps.connection),
    journal: committer
  }));
}

function handlerContext(params: unknown): Parameters<ReturnType<typeof createWriteApplyHandler>>[0] {
  return {
    request_id: newId("ipc", Date.now()),
    method: "write.apply",
    params: params as never,
    client_id: "adp:cli-execute" as never,
    client_kind: "cli",
    connection_id: "cli.execute",
    remaining_ms: 30_000,
    signal: new AbortController().signal
  };
}

async function adoptCandidate(
  deps: CliExecuteDeps,
  params: CliExecuteParams,
  fromBackdoor: boolean
): Promise<Result<JsonValue, ErrorEnvelope>> {
  const candidateId = params.positionals[0];
  if (candidateId === undefined) return err(missing("id"));
  if (fromBackdoor && !isTestModeHomeSync(deps.home)) {
    return err(makeErrorEnvelope({
      code: "E_AUTH_DENIED",
      category: "authorization",
      message_key: "error.auth_denied",
      stage: "test_backdoor",
      retryable: false,
      side_effect: "none",
      details: { kind: "field", path: "--test-mode", rule: "not_a_test_mode_home" }
    }), "rejected");
  }
  const handler = writeHandler(deps);
  if (!handler.ok) return handler;
  const proofPort = proofFor(deps);
  if (fromBackdoor) {
    const candidate = readCandidate(deps.connection, candidateId);
    if (candidate === null) return err(internalError("kernel.candidate_not_found"));
    const root = candidateRoot(deps.connection, candidate);
    if (!root.ok) return root;
    const confirmation = ensureConfirmationRow(deps.connection, candidate, root.value, deps.now());
    if (!confirmation.ok) return confirmation;
    const confirmedAt = deps.now();
    const capabilityId = newId("cap");
    const stored = await deps.blobStore.putSync(new TextEncoder().encode(canonicalJsonText({
      schema_version: "rsi.human_proof_evidence/1",
      capability_id: capabilityId,
      proof_kind: "test_backdoor_confirmation",
      subject: {
        kind: "control_plane",
        purpose: "grant_issue",
        subject_hash: confirmation.value.subject_hash
      },
      confirmed_at: confirmedAt,
      nonce: newId("ipc", confirmedAt)
    } as unknown as JsonValue)));
    if (!stored.ok) return err(stored.error, stored.status);
    try {
      deps.connection
        .prepare(
          `INSERT INTO blob (
             blob_hash, byte_length, relative_path, state, verified_at,
             created_at, deleted_at, deletion_reason
           ) VALUES (
             :blob_hash, :byte_length, :relative_path, 'present', :now,
             :now, NULL, NULL
           )
           ON CONFLICT(blob_hash) DO UPDATE SET
             byte_length = excluded.byte_length,
             relative_path = excluded.relative_path,
             state = 'present',
             verified_at = excluded.verified_at,
             deleted_at = NULL,
             deletion_reason = NULL`
        )
        .run({
          blob_hash: stored.value.hash,
          byte_length: stored.value.byte_length,
          relative_path: `sha256/${stored.value.hash.replace(/^sha256:/u, "")}`,
          now: deps.now()
        });
    } catch {
      return err(internalError("kernel.test_confirm_blob_projection_failed"), "rejected");
    }
    const adopted = await performAdoption({
      connection: deps.connection,
      home: deps.home,
      blob_store: deps.blobStore,
      candidate_id: candidateId,
      proof: {
        kind: "test_backdoor_confirmation",
        capability_id: capabilityId,
        evidence_ref: `blob://${stored.value.hash}#bytes=0-${stored.value.byte_length}` as never,
        confirmed_at: confirmedAt
      },
      verify_proof: (attestation, subjectHash) =>
        proofPort.verifyControlPlane({
          attestation: {
            schema_version: "rsi.human_attestation/1",
            kind: toHumanAttestationKind(attestation.kind),
            capability_id: attestation.capability_id as never,
            evidence_ref: attestation.evidence_ref as never,
            confirmed_at: attestation.confirmed_at
          },
          subject_hash: subjectHash,
          purpose: "grant_issue"
        }),
      write_apply: (request, _signal) => handler.value(handlerContext(request) as never).then((result) => result.ok ? ok(toJsonValue(result.value)) : result),
      policy_version: "policy:evoplug/1",
      now: deps.now
    });
    if (!adopted.ok) return err(adopted.error, adopted.status);
    return ok(toJsonValue({ ...adopted.value, via: "ipc" }));
  }
  // Explicit `skills adopt --request FILE`: the caller supplies a complete
  // write.apply request whose grant was already issued.
  const requestPath = option(params, "request");
  if (requestPath === null) return err(missing("request"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(requestPath, "utf8"));
  } catch {
    return err(fieldError(requestPath, "invalid_json"));
  }
  const written = await handler.value(handlerContext(parsed) as never);
  if (!written.ok) return written;
  const candidate = readCandidate(deps.connection, candidateId);
  if (candidate !== null) {
    const root = candidateRoot(deps.connection, candidate);
    if (root.ok) {
      const confirmation = ensureConfirmationRow(deps.connection, candidate, root.value, deps.now());
      if (confirmation.ok) {
        const record = written.value as unknown as Record<string, JsonValue>;
        markAdopted(deps.connection, confirmation.value, "host_native_confirmation", String(record["write_id"] ?? ""), deps.now());
        approveHostRoots(deps.connection, candidate.host_id, deps.now());
      }
    }
  }
  return ok(toJsonValue({ ...written.value, via: "ipc" }));
}

async function grantIssueLocal(deps: CliExecuteDeps, params: CliExecuteParams): Promise<Result<JsonValue, ErrorEnvelope>> {
  const requestPath = option(params, "request");
  const attestationPath = option(params, "attestation");
  if (requestPath === null) return err(missing("request"));
  if (attestationPath === null) return err(missing("attestation"));
  let requestJson: unknown;
  let attestationJson: unknown;
  try {
    requestJson = JSON.parse(await readFile(requestPath, "utf8"));
    attestationJson = JSON.parse(await readFile(attestationPath, "utf8"));
  } catch {
    return err(fieldError(requestPath, "invalid_json"));
  }
  if (typeof requestJson !== "object" || requestJson === null || Array.isArray(requestJson)) {
    return err(fieldError(requestPath, "grant_issue_shape"));
  }
  const request = { ...(requestJson as Record<string, unknown>), human_attestation: attestationJson } as unknown as GrantIssueRequest;
  const validated = validateGrantIssueRequest(request);
  if (!validated.ok) return validated;
  const verdict = await proofFor(deps).verifyControlPlane({
    attestation: request.human_attestation as never,
    subject_hash: grantIssueSubjectHash(request),
    purpose: "grant_issue"
  });
  if (verdict !== "verified") return err(makeErrorEnvelope({
    code: "E_AUTH_DENIED",
    category: "authorization",
    message_key: "error.auth_denied",
    stage: "grant_issue",
    retryable: false,
    side_effect: "none",
    details: { kind: "none" }
  }));
  const created = createGrant({ request, grant_id: newId("grant", deps.now()), issued_at: deps.now() });
  if (!created.ok) return created;
  const grant = created.value.grant;
  deps.connection.prepare(
    `INSERT INTO authorization_grant (
       grant_id, issued_by, human_attestation_json, subject, object_type, scope_json,
       actions_json, mode, candidate_id, candidate_hash, policy_version, issued_at,
       expires_at, revoked_at, grant_hash
     ) VALUES (
       :grant_id, :issued_by, :human_attestation_json, :subject, :object_type, :scope_json,
       :actions_json, :mode, :candidate_id, :candidate_hash, :policy_version, :issued_at,
       :expires_at, NULL, :grant_hash
     )`
  ).run({
    grant_id: grant.grant_id,
    issued_by: grant.issued_by,
    human_attestation_json: canonicalJsonText(toJsonValue(grant.human_attestation)),
    subject: grant.subject,
    object_type: grant.object_type,
    scope_json: canonicalJsonText(toJsonValue(grant.scope)),
    actions_json: canonicalJsonText(toJsonValue(grant.actions)),
    mode: grant.mode,
    candidate_id: grant.candidate_id,
    candidate_hash: grant.candidate_hash,
    policy_version: grant.policy_version,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
    grant_hash: grant.grant_hash
  });
  return ok(toJsonValue({ grant: toGrantPublicView(grant), via: "ipc" }));
}

async function grantRevokeLocal(deps: CliExecuteDeps, params: CliExecuteParams): Promise<Result<JsonValue, ErrorEnvelope>> {
  const grantId = params.positionals[0];
  if (grantId === undefined) return err(missing("grant_id"));
  const expectedHash = option(params, "expected-hash");
  const reason = option(params, "reason");
  const attestationPath = option(params, "attestation");
  if (expectedHash === null) return err(missing("expected-hash"));
  if (reason === null) return err(missing("reason"));
  if (attestationPath === null) return err(missing("attestation"));
  let attestation: unknown;
  try {
    attestation = JSON.parse(await readFile(attestationPath, "utf8"));
  } catch {
    return err(fieldError(attestationPath, "invalid_json"));
  }
  const request = {
    schema_version: "rsi.grant_revoke/1",
    grant_id: grantId,
    expected_grant_hash: expectedHash,
    human_attestation: attestation,
    reason
  } as unknown as GrantRevokeRequest;
  const verdict = await proofFor(deps).verifyControlPlane({
    attestation: request.human_attestation as never,
    subject_hash: grantRevokeSubjectHash(request),
    purpose: "grant_revoke"
  });
  if (verdict !== "verified") return err(makeErrorEnvelope({
    code: "E_AUTH_DENIED",
    category: "authorization",
    message_key: "error.auth_denied",
    stage: "grant_revoke",
    retryable: false,
    side_effect: "none",
    details: { kind: "none" }
  }));
  const row = deps.connection
    .prepare<SqlRow>("SELECT * FROM authorization_grant WHERE grant_id = :grant_id")
    .get({ grant_id: grantId });
  if (row === undefined) return err(internalError("kernel.grant_not_found"));
  const grant = grantFromSqlRow(row);
  if (grant === null) return err(internalError("kernel.grant_row_corrupt"));
  const revoked = revokeGrant({ grant, request, revoked_at: deps.now() });
  if (!revoked.ok) return revoked;
  deps.connection
    .prepare("UPDATE authorization_grant SET revoked_at = :revoked_at WHERE grant_id = :grant_id")
    .run({ revoked_at: revoked.value.revoked_at, grant_id: revoked.value.grant_id });
  return ok(toJsonValue({ grant: toGrantPublicView(revoked.value), via: "ipc" }));
}

function grantFromSqlRow(row: SqlRow): AuthorizationGrant | null {
  try {
    return {
      schema_version: "rsi.authorization_grant/1",
      grant_id: String(row["grant_id"]) as never,
      issued_by: row["issued_by"] as never,
      human_attestation: JSON.parse(String(row["human_attestation_json"])) as never,
      subject: String(row["subject"]) as never,
      object_type: row["object_type"] as never,
      scope: JSON.parse(String(row["scope_json"])) as never,
      actions: JSON.parse(String(row["actions_json"])) as never,
      mode: row["mode"] as never,
      candidate_id: row["candidate_id"] === null ? null : (String(row["candidate_id"]) as never),
      candidate_hash: row["candidate_hash"] === null ? null : (String(row["candidate_hash"]) as never),
      policy_version: String(row["policy_version"]),
      issued_at: Number(row["issued_at"]),
      expires_at: row["expires_at"] === null ? null : Number(row["expires_at"]),
      revoked_at: row["revoked_at"] === null ? null : Number(row["revoked_at"]),
      grant_hash: String(row["grant_hash"]) as never
    };
  } catch {
    return null;
  }
}

async function grantListLocal(deps: CliExecuteDeps, params: CliExecuteParams): Promise<Result<JsonValue, ErrorEnvelope>> {
  const objectType = option(params, "object-type");
  const state = option(params, "state");
  const limit = option(params, "limit");
  const rows = deps.connection
    .prepare<SqlRow>("SELECT * FROM authorization_grant ORDER BY issued_at DESC LIMIT :limit")
    .all({ limit: limit === null ? 100 : Number(limit) });
  const grants = rows
    .map((row) => {
      const parsed = grantFromSqlRow(row);
      return parsed === null ? null : toGrantPublicView(parsed);
    })
    .filter((grant): grant is NonNullable<typeof grant> => grant !== null)
    .filter((grant) => objectType === null || grant.object_type === objectType)
    .filter((grant) => {
      if (state === null) return true;
      if (state === "revoked") return grant.revoked_at !== null;
      if (state === "expired") return grant.expires_at !== null && grant.expires_at <= deps.now();
      return true;
    });
  return ok(toJsonValue({ grants, via: "ipc" }));
}

async function skillsDisableLocal(deps: CliExecuteDeps, params: CliExecuteParams): Promise<Result<JsonValue, ErrorEnvelope>> {
  const id = params.positionals[0];
  if (id === undefined) return err(missing("id"));
  const candidate = readCandidate(deps.connection, id);
  if (candidate === null) return err(internalError("kernel.candidate_not_found"));
  const root = candidateRoot(deps.connection, candidate);
  if (!root.ok) return root;
  let rootPath: string;
  try {
    rootPath = resolveManagedRootPath(root.value);
  } catch {
    return err(internalError("kernel.root_unavailable"));
  }
  const target = join(rootPath, candidate.target_path);
  let movedTo: string | null = null;
  if (candidate.write_mode === "managed_block") {
    // Appendix K.1: detach only the managed block; user text stays verbatim.
    try {
      const detached = detachManagedBlock(readFileSync(target), candidate.block_selector ?? "evoplug");
      if (!detached.ok) return err(detached.error, detached.status);
      const written = await writeFileAtomicDurable(target, new TextDecoder().decode(detached.value));
      if (!written.ok) return err(written.error, written.status);
    } catch (error) {
      return err(internalError("kernel.disable_block_failed"), "rejected");
    }
  } else {
    try {
      const { mkdir, rename } = await import("node:fs/promises");
      const disabledDir = join(rootPath, ".evoplug-disabled");
      await mkdir(disabledDir, { recursive: true });
      const destination = join(disabledDir, `${candidate.proposal_id.replace(/[^A-Za-z0-9._-]/gu, "_")}.disabled`);
      await rename(target, destination);
      movedTo = destination;
    } catch {
      // Already absent is still "not loadable".
    }
  }
  deps.connection
    .prepare("UPDATE proposals SET state = 'withdrawn', updated_at = :now WHERE proposal_id = :id AND state = 'adopted'")
    .run({ id: candidate.proposal_id, now: deps.now() });
  deps.connection
    .prepare("UPDATE candidate_confirmation SET state = 'rejected', updated_at = :now WHERE candidate_id = :id")
    .run({ id: candidate.candidate_id, now: deps.now() });
  return ok(toJsonValue({ status: "disabled", id: candidate.candidate_id, moved_to: movedTo, via: "ipc" }));
}

function skillsPending(deps: CliExecuteDeps): Result<JsonValue, ErrorEnvelope> {
  const ttl = deps.config.candidate?.pending_ttl_ms ?? 14 * 24 * 60 * 60 * 1_000;
  const rows = listPendingCandidateInfos(deps.connection, deps.now(), ttl);
  return ok(toJsonValue({
    status: "ok",
    count: rows.length,
    candidates: rows.map((row) => ({
      id: row.candidate_id,
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      state: row.state
    }))
  }));
}

function skillsShow(deps: CliExecuteDeps, params: CliExecuteParams): Result<JsonValue, ErrorEnvelope> {
  const id = params.positionals[0];
  if (id === undefined || id.length === 0) return err(fieldError("id", "required"));
  const candidate = readCandidate(deps.connection, id);
  if (candidate === null) return err(fieldError("id", "not_found"));
  const content = candidateFullText(deps.blobStore, deps.connection, candidate);
  return ok(toJsonValue({
    status: "ok",
    id: candidate.candidate_id,
    name: candidateSkillName(candidate),
    description: candidate.skill_description ?? "",
    change_kind: candidate.change_kind,
    target_path: candidate.target_path,
    content
  }));
}

function skillsAsk(deps: CliExecuteDeps, params: CliExecuteParams): Result<JsonValue, ErrorEnvelope> {
  const id = params.positionals[0];
  if (id === undefined || id.length === 0) return err(fieldError("id", "required"));
  if (!requeueCandidate(deps.connection, id, deps.now())) {
    return err(fieldError("id", "not_pending"));
  }
  return ok(toJsonValue({ status: "ok", id, scheduled: "next_session_start" }));
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

export async function executeCliCommand(
  deps: CliExecuteDeps,
  params: CliExecuteParams
): Promise<Result<JsonValue, ErrorEnvelope>> {
  try {
    switch (params.command) {
      case "review":
      case "skills.diff":
      case "skills.revoke":
      case "skills.resolve":
        return await reviewOrSkills(deps, params);
      case "skills.pending":
        return skillsPending(deps);
      case "skills.show":
        return skillsShow(deps, params);
      case "skills.ask":
        return skillsAsk(deps, params);
      case "skills.adopt":
        return await adoptCandidate(deps, params, false);
      case "skills.disable":
        return await skillsDisableLocal(deps, params);
      case "test.confirm":
        return await adoptCandidate(deps, params, true);
      case "grant.issue":
        return await grantIssueLocal(deps, params);
      case "grant.revoke":
        return await grantRevokeLocal(deps, params);
      case "grant.list":
        return await grantListLocal(deps, params);
      case "doctor":
        return await doctor(deps, params);
      case "configure.show": {
        const current = await readConfigFile(deps.home);
        if (!current.ok) return err(current.error, current.status);
        return ok(toJsonValue({ ...current.value, via: "ipc" }));
      }
      case "configure.generation": {
        const host = option(params, "host");
        if (host === null) return err(missing("host"));
        if (attachDefaults(host) === null) return err(fieldError("--host", "unknown_host"));
        const credentialEnv = validateCredentialEnv(option(params, "credential-env"));
        if (!credentialEnv.ok) return err(credentialEnv.error);
        const context = await loadConfigContext(deps);
        if (!context.ok) return context;
        const model = option(params, "model");
        const policy = resolveGenerationEgressPolicy({
          host_id: host,
          model,
          provider_endpoint: option(params, "provider-endpoint"),
          project_exclusions: context.value.current.projects.excluded_project_ids,
          env: process.env,
          read_file: (path) => {
            try {
              return readFileSync(path, "utf8");
            } catch {
              return null;
            }
          }
        });
        if (!policy.ok) return err(policy.error, policy.status);
        const next = parseConfigText(canonicalConfigJson({
          ...context.value.current,
          egress_policy_version: policy.value.policy.policy_version,
          review_backend: {
            enabled: true,
            backend_id: host,
            secret_ref: `env:${credentialEnv.value}`,
            ...(model === null ? {} : { model })
          }
        }));
        if (!next.ok) return err(next.error, next.status);
        const committed = await commitConfig(deps, context.value.current, next.value, context.value.marker);
        if (!committed.ok) return committed;
        const activated = activateStandingEgressPolicy(deps.connection, policy.value, deps.now());
        if (!activated.ok) return activated;
        return ok(json({
          ...(committed.value as Record<string, unknown>),
          // Appendix I.5: an omitted --model means the host CLI runs with the
          // model the current host session already uses. The generation backend
          // passes no model argv, so the host really applies that default.
          generation_model: model ?? "host_default",
          generation_model_source: model === null ? "host_session_default" : "explicit",
          egress_policy: {
            policy_version: policy.value.policy.policy_version,
            receiver: policy.value.receiver,
            data_classes: policy.value.policy.endpoints[0]?.data_classes ?? []
          },
          notice:
            "复盘时会把本宿主会话的证据交给本宿主 CLI 生成候选；接收方限定为本宿主 CLI 与其已配置的 provider，证据中的项目排除项与凭据形态文本不会进入快照。跨源路由（其他宿主或其他 provider）不在本版支持范围内。"
        }));
      }
      case "configure.jev": {
        const credentialEnv = validateCredentialEnv(option(params, "credential-env"));
        if (!credentialEnv.ok) return err(credentialEnv.error);
        const limits = parseLimitsOptions(
          option(params, "request-max-tokens"),
          option(params, "question-max-tokens")
        );
        if (!limits.ok) return err(limits.error);
        const credential = process.env[credentialEnv.value];
        const input = await buildJevInputWithProbe({
          endpoint: option(params, "endpoint"),
          model: option(params, "model"),
          credentialEnv: credentialEnv.value,
          limits: limits.value,
          skip_probe: flag(params, "skip-probe"),
          ...(credential === undefined ? {} : { credential })
        });
        if (!input.ok) return err(input.error);
        return provisionJev(
          deps,
          { profile: input.value.profile, capability: input.value.capability },
          "configure jev",
          {
            evidence_bytes: input.value.evidence_bytes,
            warnings: input.value.warnings
          }
        );
      }
      case "configure": {
        const jevInput = option(params, "jev-input");
        if (jevInput !== null) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(jevInput, "utf8"));
          } catch {
            return err(fieldError(jevInput, "invalid_json"));
          }
          return provisionJev(deps, parsed, jevInput);
        }
        const inputPath = option(params, "input");
        const credential = option(params, "credential-stdin");
        if (inputPath === null && credential === null) return err(missing("input"));
        const context = await loadConfigContext(deps);
        if (!context.ok) return context;
        let next = context.value.current;
        if (inputPath !== null) {
          try {
            const parsed = parseConfigText(await readFile(inputPath, "utf8"));
            if (!parsed.ok) return err(parsed.error, parsed.status);
            next = parsed.value;
          } catch {
            return err(fieldError(inputPath, "file_not_found"));
          }
        }
        if (credential !== null) {
          next = {
            ...next,
            review_backend: next.review_backend.enabled
              ? { ...next.review_backend, secret_ref: credential }
              : next.review_backend
          };
        }
        if (next.product_home !== deps.home) {
          return err(fieldError("$.product_home", "must_equal_home"));
        }
        return commitConfig(deps, context.value.current, next, context.value.marker);
      }
      case "attach":
        return attachOrDetach(deps, params, "attach");
      case "detach":
        return attachOrDetach(deps, params, "detach");
      default:
        return err(unsupported(`unknown_command:${params.command}`));
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown_error";
    return err(internalError(`kernel.cli_execute_unhandled:${name}`), "rejected");
  }
}
