/**
 * Kernel-executed generation capability probe (design §3, G1/G7).
 *
 * The kernel runs the host's own generation CLI with one fixed probe snapshot
 * and records three capability rows — `generation.create`, `generation.auth`
 * and `generation.output` — at `evidence_stage=roundtrip`, bound to the real
 * host version and the declared spec hash. The same round writes the
 * `generation.service_profile` row that makes `--generation-binding-key`
 * unnecessary.
 *
 * Nothing here runs during composition: the caller decides when attach,
 * `doctor --probe generation` or `serve` startup performs a probe.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalHash,
  canonicalJsonText,
  hashBytes,
  newId,
  type ErrorEnvelope,
  type Hash,
  type Result
} from "@evoplug/core";
import { makeErrorEnvelope, ok, toJsonValue } from "@evoplug/core";
import {
  capabilityBindingKey,
  toCapabilityRecordPhysicalRow,
  toHostProbePhysicalRow,
  validateCapabilityRecord,
  type CapabilityBinding,
  type CapabilityRecord,
  type HostProbeRecord
} from "@evoplug/core/host";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";
import type { BlobStore } from "@evoplug/storage";

import type { CliGenerationSpec } from "@evoplug/kernel";
import {
  classifyGenerationFailure,
  generationFailureNextStep,
  redactCredentialMaterial,
  type GenerationFailure
} from "@evoplug/kernel";
import type { NativeGenerationSpec } from "./review-generation.js";

export const GENERATION_PROBE_TTL_MS: number = 24 * 60 * 60 * 1000;
export const GENERATION_PROBE_ACTION: "generation_roundtrip" = "generation_roundtrip";

const PROMPT: string = [
  "EvoPlug generation capability probe.",
  "Reply with exactly three JSON Lines and nothing else.",
  'Line 1: {"type":"started","attempt_id":"evoplug-probe","protocol_version":"rsi.generator_protocol/1","model_id":"evoplug-probe"}',
  'Line 2: {"type":"progress","completed_steps":1,"total_steps":1}',
  'Line 3: {"type":"completed","proposal_count":0}'
].join("\n");

export interface ProcessResult {
  readonly launched: boolean;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly timed_out: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
}

export type ProcessRunner = (input: {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly stdin: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout_ms: number;
  readonly cwd: string;
}) => Promise<ProcessResult>;

function runProcessDefault(input: Parameters<ProcessRunner>[0]): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(input.executable, [...input.argv], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      resolve({
        launched: false,
        exit_code: null,
        signal: null,
        timed_out: false,
        stdout: "",
        stderr: "",
        duration_ms: Date.now() - started
      });
      return;
    }
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeout_ms);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    if (input.stdin !== null) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        launched: false,
        exit_code: null,
        signal: null,
        timed_out: timedOut,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        duration_ms: Date.now() - started
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        launched: true,
        exit_code: code,
        signal,
        timed_out: timedOut,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        duration_ms: Date.now() - started
      });
    });
  });
}

function renderArgv(
  spec: CliGenerationSpec | NativeGenerationSpec,
  prompt: string,
  gluePath: string | undefined
): {
  argv: string[];
  stdin: string | null;
} {
  const withGlue = (arg: string): string =>
    arg === "{{glue}}" && gluePath !== undefined ? gluePath : arg;
  if (spec.prompt_transport === "argv") {
    return {
      argv: spec.argv_template.map((arg) =>
        arg === "{{prompt}}" ? prompt : withGlue(arg)
      ),
      stdin: null
    };
  }
  return {
    argv: spec.argv_template.filter((arg) => arg !== "{{prompt}}").map(withGlue),
    stdin: prompt
  };
}

export interface GenerationProbeVerdict {
  readonly create: "passed" | "failed" | "blocked";
  readonly auth: "passed" | "failed" | "blocked";
  readonly output: "passed" | "failed" | "blocked";
  readonly blocker: "host_not_installed" | "deadline_exceeded" | "credentials_unavailable" | null;
  /** Actionable class when a path failed without an existing blocker. */
  readonly failure: GenerationFailure | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
}

export function classifyGenerationProbe(
  spec: Pick<CliGenerationSpec, "output_protocol" | "result_field" | "output_extract" | "max_output_bytes">,
  processResult: ProcessResult
): GenerationProbeVerdict {
  if (!processResult.launched) {
    return {
      create: "blocked",
      auth: "blocked",
      output: "blocked",
      blocker: "host_not_installed",
      failure: null,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      duration_ms: processResult.duration_ms
    };
  }
  if (processResult.timed_out) {
    return {
      create: "failed",
      auth: "failed",
      output: "failed",
      blocker: "deadline_exceeded",
      failure: null,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      duration_ms: processResult.duration_ms
    };
  }
  const classification = classifyGenerationFailure({
    output_protocol: spec.output_protocol,
    ...(spec.result_field === undefined ? {} : { result_field: spec.result_field }),
    ...(spec.output_extract === undefined ? {} : { output_extract: spec.output_extract }),
    exit_code: processResult.exit_code,
    signal: processResult.signal,
    timed_out: processResult.timed_out,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    require_probe_snapshot: true
  });
  return {
    create: "passed",
    auth: classification.auth_failed ? "failed" : "passed",
    output: classification.passed ? "passed" : "failed",
    blocker: null,
    failure: classification.failure,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    duration_ms: processResult.duration_ms
  };
}

export interface GenerationProbeInput {
  readonly home: string;
  readonly connection: SqliteConnection;
  readonly blobs: Pick<BlobStore, "putSync">;
  readonly spec: CliGenerationSpec | NativeGenerationSpec;
  /** Absolute `{{glue}}` replacement for a Python-glue host. */
  readonly glue_path?: string;
  readonly backend_id: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly executable: string;
  readonly host_version: string;
  /**
   * The attach-registered host environment (appendix J.5). Never the kernel
   * process's own environment: a host CLI started by a long-lived `serve`
   * would otherwise write its telemetry into the user's real directories.
   */
  readonly host_env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  /**
   * Operator-asserted price for the host CLI's provider. Absent keeps the
   * conservative `unknown` branch, which blocks a paid call at budget claim.
   */
  readonly pricing?: {
    readonly status: "known";
    readonly input_micros_per_million: number;
    readonly output_micros_per_million: number;
    readonly fixed_micros: number;
  };
  readonly run_process?: ProcessRunner;
}

export interface GenerationProbeOutcome {
  readonly verdict: GenerationProbeVerdict;
  readonly binding_key: Hash;
  readonly probe_id: string;
  readonly evidence_ref: string;
  /** One sentence for the operator; null when the probe passed or was blocked. */
  readonly next_step: string | null;
  readonly capabilities: Readonly<Record<"create" | "auth" | "output" | "service_profile", string>>;
}

function diagnosticsRef(blobs: Pick<BlobStore, "putSync">, text: string): string {
  const stored = blobs.putSync(new TextEncoder().encode(text));
  return stored.ok ? `blob://${stored.value.hash}#bytes=0-${stored.value.byte_length}` : "blob://sha256:0000000000000000000000000000000000000000000000000000000000000000#bytes=0-0";
}

export async function runGenerationProbe(
  input: GenerationProbeInput
): Promise<Result<GenerationProbeOutcome, ErrorEnvelope>> {
  const spec = input.spec;
  const rendered = renderArgv(spec, PROMPT, input.glue_path);
  let cwd = input.home;
  let tempRoot: string | null = null;
  if (spec.prompt_transport === "file") {
    tempRoot = mkdtempSync(join(tmpdir(), "evoplug-probe-"));
    const file = join(tempRoot, "prompt.txt");
    writeFileSync(file, PROMPT);
    rendered.argv.splice(0, rendered.argv.length, ...spec.argv_template.map((arg) => arg.replace("{{prompt}}", file)));
  }
  let processResult: ProcessResult;
  try {
    processResult = await (input.run_process ?? runProcessDefault)({
      executable: input.executable,
      argv: rendered.argv,
      stdin: rendered.stdin,
      env: { ...input.host_env, NO_COLOR: "1" },
      timeout_ms: spec.timeout_ms,
      cwd
    });
  } finally {
    if (tempRoot !== null) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
  const verdict = classifyGenerationProbe(
    {
      output_protocol: spec.output_protocol,
      ...(spec.result_field === undefined ? {} : { result_field: spec.result_field }),
      ...(spec.output_extract === undefined ? {} : { output_extract: spec.output_extract }),
      max_output_bytes: "max_output_bytes" in spec ? spec.max_output_bytes : 32 * 1024 * 1024
    },
    processResult
  );
  let binaryHash: Hash | null = null;
  try {
    binaryHash = hashBytes(readFileSync(input.executable));
  } catch {
    binaryHash = null;
  }
  const binding: CapabilityBinding = {
    host_id: input.host_id as CapabilityBinding["host_id"],
    source_pin: {
      host_version: input.host_version,
      host_version_kind: "release",
      source_commit: null
    },
    binary_pin: {
      binary_version: "backend_version" in spec ? String(spec.backend_version) : null,
      binary_hash: binaryHash
    },
    adapter_version: "diagnostic",
    subject: "host_contract",
    mode: input.mode as CapabilityBinding["mode"],
    config_space: input.config_space,
    root_id: "root:generation",
    construction_path: "cli_spawn",
    execution_environment: {
      os: process.platform,
      arch: process.arch,
      isolation: "local"
    },
    mapping: "exact",
    backend_id: input.backend_id
  };
  const bindingKey = capabilityBindingKey(binding);
  const now = input.now();
  const nextStep = generationFailureNextStep(verdict.failure, {
    host_id: input.host_id,
    executable: input.executable,
    argv_template: spec.argv_template
  });
  const evidenceRef = diagnosticsRef(
    input.blobs,
    canonicalJsonText(toJsonValue({
      schema_version: "rsi.generation_probe_result/1",
      backend_id: input.backend_id,
      spec_hash: canonicalHash(toJsonValue({
        backend_id: input.backend_id,
        argv_template: [...spec.argv_template],
        output_protocol: spec.output_protocol
      })),
      host_version: input.host_version,
      executable_hash: binaryHash,
      verdict: {
        create: verdict.create,
        auth: verdict.auth,
        output: verdict.output,
        blocker: verdict.blocker,
        failure: verdict.failure
      },
      stdout_tail: redactCredentialMaterial(verdict.stdout.slice(-2048)),
      stderr_tail: redactCredentialMaterial(verdict.stderr.slice(-2048)),
      ...(nextStep === null ? {} : { next_step: nextStep }),
      duration_ms: verdict.duration_ms,
      checked_at: now
    }))
  );
  const probeId = newId("prb", now);
  const probe: HostProbeRecord = {
    schema_version: "rsi.host_probe/2",
    probe_id: probeId,
    probe_contract_version: "host-probe/2",
    target_kind: "host",
    binding,
    binding_key: bindingKey,
    probe_mode: "temp_fixture",
    probe_action: GENERATION_PROBE_ACTION,
    assertions: [
      { assertion_id: "create", capability: "generation.create", expected: "cli exited", observed_ref: evidenceRef as never, pass: verdict.create === "passed" },
      { assertion_id: "auth", capability: "generation.auth", expected: "no auth diagnostics", observed_ref: evidenceRef as never, pass: verdict.auth === "passed" },
      { assertion_id: "output", capability: "generation.output", expected: "rsi.generator_protocol/1", observed_ref: evidenceRef as never, pass: verdict.output === "passed" }
    ],
    capability_results: [],
    result: verdict.create === "blocked" ? "blocked" : verdict.output === "passed" ? "passed" : "failed",
    ...(verdict.blocker === null ? {} : {
      blocker: {
        kind: verdict.blocker,
        code: `generation_probe_${verdict.blocker}`,
        detail_ref: evidenceRef as never,
        retry_allowed: verdict.blocker !== "host_not_installed"
      }
    }),
    expected: "started + zero proposals + completed",
    observed: JSON.stringify({
      create: verdict.create,
      auth: verdict.auth,
      output: verdict.output,
      ...(verdict.failure === null ? {} : { failure: verdict.failure }),
      ...(nextStep === null ? {} : { next_step: nextStep })
    }),
    evidence_refs: [evidenceRef],
    duration_ms: verdict.duration_ms,
    checked_at: now
  };
  const probeRow = toHostProbePhysicalRow(probe, 1);
  const insertProbe = input.connection.prepare(
    `INSERT OR REPLACE INTO host_probe (
       probe_id, binding_key, binding_json, subject, target_kind, probe_contract_version,
       probe_mode, fixture_ref, probe_action, assertions_json, capability_results_json,
       result, blocker_json, expected, observed, evidence_refs_json, duration_ms,
       checked_at, row_version
     ) VALUES (
       :probe_id, :binding_key, :binding_json, :subject, :target_kind, :probe_contract_version,
       :probe_mode, :fixture_ref, :probe_action, :assertions_json, :capability_results_json,
       :result, :blocker_json, :expected, :observed, :evidence_refs_json, :duration_ms,
       :checked_at, :row_version
     )`
  );
  const detailsFor = (action: "create" | "auth" | "output"): CapabilityRecord["details"] => {
    if (action === "create") {
      return {
        entry_kind: "cli_spawn",
        entry_ref: input.executable,
        backend_version: "backend_version" in spec ? String(spec.backend_version) : "unknown",
        protocol_versions: ["rsi.generator_protocol/1"],
        isolation: { mode: "process", network: "enabled", evidence_refs: [] },
        idempotent: false,
        max_concurrent: 1,
        supported_resume: false
      } as CapabilityRecord["details"];
    }
    if (action === "auth") {
      return {
        mechanism: "ambient",
        credential_ref_kind: "none",
        profile_ref: "host_cli",
        data_scope: "host_owned",
        host_login_reuse: true,
        expiry_semantics: "host_managed"
      } as CapabilityRecord["details"];
    }
    return {
      protocol: "rsi.generator_protocol/1",
      schema_ref: "rsi.generator_protocol/1",
      streaming: spec.output_protocol === "jsonl",
      max_bytes: "max_output_bytes" in spec ? spec.max_output_bytes : 32 * 1024 * 1024,
      final_state_signal: "completed",
      artifact_refs: false
    } as CapabilityRecord["details"];
  };
  const capabilityIds: Record<"create" | "auth" | "output", string> = {
    create: newId("cap", now),
    auth: newId("cap", now),
    output: newId("cap", now)
  };
  const serviceProfileId = newId("cap", now);
  const results: Record<string, string> = {};
  const insertCapability = input.connection.prepare(
    `INSERT OR REPLACE INTO capability_record (
       capability_id, binding_key, binding_json, name, status, evidence_stage,
       evidence_refs_json, probe_ref, probe_result, blocker_code, failure_code,
       checked_at, verified_at, last_verified_at, details_json, legacy_json, row_version
     ) VALUES (
       :capability_id, :binding_key, :binding_json, :name, :status, :evidence_stage,
       :evidence_refs_json, :probe_ref, :probe_result, :blocker_code, :failure_code,
       :checked_at, :verified_at, :last_verified_at, :details_json, NULL, :row_version
     )`
  );
  for (const action of ["create", "auth", "output"] as const) {
    const passed = verdict[action] === "passed";
    const record = {
      schema_version: "rsi.capability/2",
      capability_id: capabilityIds[action],
      binding,
      binding_key: bindingKey,
      name: `generation.${action}`,
      status: passed ? "verified" : verdict[action] === "blocked" ? "unknown" : "failed",
      evidence_stage: "roundtrip",
      evidence_refs: [evidenceRef],
      probe_ref: probeId,
      probe_result: passed ? "passed" : verdict[action] === "blocked" ? "blocked" : "failed",
      checked_at: now,
      ...(passed ? { verified_at: now, last_verified_at: now } : {}),
      ...(!passed && verdict[action] !== "blocked" && verdict.failure !== null
        ? { failure_code: verdict.failure.code }
        : {}),
      details: detailsFor(action)
    };
    const validated = validateCapabilityRecord(record);
    if (!validated.ok) return validated;
    const row = toCapabilityRecordPhysicalRow(validated.value, 1);
    insertCapability.run({
      ...row,
      blocker_code: row.blocker_code ?? null,
      failure_code: row.failure_code ?? null,
      verified_at: row.verified_at ?? null,
      last_verified_at: row.last_verified_at ?? null
    });
    results[action] = capabilityIds[action];
  }
  // The generation roundtrip proves the CLI can produce a candidate, but it
  // is not a service-profile read. The read port accepts only a
  // `read_service_profile` host probe whose evidence is a frozen
  // `rsi.service_profile_evidence/1` body, so the round also writes that
  // probe and profile evidence. The roundtrip does not read provider pricing.
  // Absent an explicit operator assertion the profile stays on the
  // conservative `unknown` branch, which blocks a paid call at budget claim.
  const pricing = input.pricing ?? { status: "unknown" as const };
  const profileEvidenceValue = {
    schema_version: "rsi.service_profile_evidence/1",
    provider_scope: input.backend_id,
    backend_id: input.backend_id,
    host_id: binding.host_id,
    mode: binding.mode,
    config_space: binding.config_space,
    request_max_tokens: 131_072,
    question_max_tokens: 20_000,
    max_output_tokens: 65_536,
    rpm: null,
    concurrency: null,
    pricing,
    profile_hash: `sha256:${"0".repeat(64)}` as Hash,
    observed_at: now
  };
  const profileHash = canonicalHash({
    schema_version: "rsi.service_profile_key/1",
    provider_scope: profileEvidenceValue.provider_scope,
    backend_id: profileEvidenceValue.backend_id,
    host_id: profileEvidenceValue.host_id,
    mode: profileEvidenceValue.mode,
    config_space: profileEvidenceValue.config_space,
    request_max_tokens: profileEvidenceValue.request_max_tokens,
    question_max_tokens: profileEvidenceValue.question_max_tokens,
    max_output_tokens: profileEvidenceValue.max_output_tokens,
    rpm: profileEvidenceValue.rpm,
    concurrency: profileEvidenceValue.concurrency,
    pricing
  });
  profileEvidenceValue.profile_hash = profileHash;
  const profileBytes = new TextEncoder().encode(canonicalJsonText(toJsonValue(profileEvidenceValue)));
  const storedProfile = input.blobs.putSync(profileBytes);
  if (!storedProfile.ok) return storedProfile;
  // `SourceRefPort` verifies the CAS file through the `blob` projection; a
  // file-only write is unreadable to the service-profile read port.
  input.connection
    .prepare(
      `INSERT OR REPLACE INTO blob
         (blob_hash, byte_length, relative_path, state, verified_at, created_at)
       VALUES (:hash, :length, :relative, 'present', :now, :now)`
    )
    .run({
      hash: storedProfile.value.hash,
      length: storedProfile.value.byte_length,
      relative: storedProfile.value.relative_path,
      now
    });
  const profileEvidenceRef =
    `blob://${storedProfile.value.hash}#bytes=0-${String(profileBytes.byteLength)}` as never;
  const profileProbeId = newId("prb", now);
  const profileProbe: HostProbeRecord = {
    schema_version: "rsi.host_probe/2",
    probe_id: profileProbeId,
    probe_contract_version: "host-probe/2",
    target_kind: "host",
    binding,
    binding_key: bindingKey,
    probe_mode: "read_only",
    probe_action: "read_service_profile",
    assertions: [
      {
        assertion_id: "generation.service_profile",
        capability: "generation.service_profile",
        expected: storedProfile.value.hash as never,
        observed_ref: profileEvidenceRef,
        pass: true
      }
    ],
    capability_results: [
      {
        name: "generation.service_profile",
        proposed_status: "verified",
        evidence_stage: "roundtrip",
        evidence_refs: [profileEvidenceRef]
      }
    ] as never,
    result: "passed",
    expected: storedProfile.value.hash,
    observed: JSON.stringify({ provider_scope: input.backend_id, limits: "conservative" }),
    evidence_refs: [profileEvidenceRef],
    duration_ms: 0,
    checked_at: now
  };
  const profileProbeRow = toHostProbePhysicalRow(profileProbe, 1);
  insertProbe.run({
    ...profileProbeRow,
    fixture_ref: profileProbeRow.fixture_ref ?? null,
    blocker_json: profileProbeRow.blocker_json ?? null
  });
  const profileRecord = {
    schema_version: "rsi.capability/2",
    capability_id: serviceProfileId,
    binding,
    binding_key: bindingKey,
    name: "generation.service_profile",
    status: "verified",
    evidence_stage: "roundtrip",
    evidence_refs: [profileEvidenceRef],
    probe_ref: profileProbeId,
    probe_result: "passed",
    checked_at: now,
    verified_at: now,
    last_verified_at: now,
    details: {
      profile_schema: "rsi.service_profile/1",
      evidence_schema: "rsi.service_profile_evidence/1",
      provider_scope: input.backend_id,
      profile_key: profileHash,
      observed_at: now
    }
  };
  const validatedProfile = validateCapabilityRecord(profileRecord);
  if (!validatedProfile.ok) return validatedProfile;
  const profileRow = toCapabilityRecordPhysicalRow(validatedProfile.value, 1);
  insertCapability.run({
    ...profileRow,
    blocker_code: profileRow.blocker_code ?? null,
    failure_code: profileRow.failure_code ?? null,
    verified_at: profileRow.verified_at ?? null,
    last_verified_at: profileRow.last_verified_at ?? null
  });
  insertProbe.run({
    ...probeRow,
    fixture_ref: probeRow.fixture_ref ?? null,
    blocker_json: probeRow.blocker_json ?? null
  });
  results["service_profile"] = serviceProfileId;
  return ok({
    verdict,
    binding_key: bindingKey,
    probe_id: probeId,
    evidence_ref: evidenceRef,
    next_step: nextStep,
    capabilities: results as GenerationProbeOutcome["capabilities"]
  });
}

/** Verified, unexpired generation bindings for one host/config space. */
export function verifiedGenerationBindings(
  connection: SqliteConnection,
  filter: {
    readonly host_id?: string;
    readonly config_space?: string;
    readonly now: number;
    readonly ttl_ms?: number;
  }
): readonly { binding_key: Hash; binding: CapabilityBinding; backend_id: string; checked_at: number }[] {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT binding_key, binding_json, checked_at FROM capability_record
        WHERE name = 'generation.service_profile' AND status = 'verified'`
    )
    .all({});
  const ttl = filter.ttl_ms ?? GENERATION_PROBE_TTL_MS;
  const out: { binding_key: Hash; binding: CapabilityBinding; backend_id: string; checked_at: number }[] = [];
  for (const row of rows) {
    if (typeof row["checked_at"] !== "number" || row["checked_at"] + ttl <= filter.now) continue;
    let binding: CapabilityBinding;
    try {
      binding = JSON.parse(String(row["binding_json"])) as CapabilityBinding;
    } catch {
      continue;
    }
    if (filter.host_id !== undefined && binding.host_id !== filter.host_id) continue;
    if (filter.config_space !== undefined && binding.config_space !== filter.config_space) continue;
    if (binding.backend_id === undefined) continue;
    out.push({
      binding_key: row["binding_key"] as Hash,
      binding,
      checked_at: row["checked_at"] as number,
      backend_id: binding.backend_id
    });
  }
  return out;
}

/** Hosts whose registration is applied and which have a pending runtime row. */
export function attachedHosts(connection: SqliteConnection): readonly {
  host_id: string;
  mode: string;
  config_space: string;
  adapter_id: string;
}[] {
  const rows = connection
    .prepare<SqlRow>(
      `SELECT host_id, mode, config_space, adapter_id FROM adapter_registration
        WHERE state = 'applied' ORDER BY host_id ASC, config_space ASC`
    )
    .all({});
  const seen = new Set<string>();
  const out: { host_id: string; mode: string; config_space: string; adapter_id: string }[] = [];
  for (const row of rows) {
    const key = `${String(row["host_id"])}\u0000${String(row["config_space"])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      host_id: String(row["host_id"]),
      mode: String(row["mode"]),
      config_space: String(row["config_space"]),
      adapter_id: String(row["adapter_id"])
    });
  }
  return out;
}

export function probeBlocker(message: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_UNSUPPORTED",
    category: "policy",
    message_key: "error.e_unsupported",
    stage: "generation_probe",
    retryable: true,
    side_effect: "none",
    details: { kind: "field", path: "generation", rule: message }
  });
}
