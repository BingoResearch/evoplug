/**
 * Kernel-executed native observation source (W1/D6).
 *
 * The runtime can author every byte it uploads, so a runtime upload that
 * contains a probe nonce proves only self-report. This module runs the kernel's
 * own native path:
 *
 * 1. the kernel starts a loopback capture endpoint that speaks the provider
 *    wire protocol declared by the adapter;
 * 2. the kernel launches the host binary itself (arguments, environment and
 *    provider setup files come from the adapter probe spec, so no host branch
 *    exists in the kernel);
 * 3. the kernel records the exact provider request body it served and the
 *    resolved executable's hash;
 * 4. the kernel records the result as a `native_cli_contract` audit fact.
 *
 * The contract alone never carries capability evidence. With the explicit
 * `session_roundtrip` option the source additionally upgrades `input_capture`
 * only when the kernel can verify, from its own reads, that:
 * - the installed artifact bytes match the applied registration's
 *   `artifact_hash` (manifest plus every member re-hashed from disk), and the
 *   adapter-declared discovery entry is one of those verified members;
 * - the same artifact was mounted into the child setup dir;
 * - the child pid equals the pid of a session authenticated by the kernel;
 * - a `host_runtime_upload` row linked to that session (column written from
 *   the authenticated id/nonce, not from payload fields) contains the nonce;
 * - the kernel capture endpoint served a provider request with the nonce.
 * Runtime uploads without that link, runtime self-reported hashes, and
 * mismatched sessions/artifacts stay audit facts only.
 *
 * The same launch path answers `check_load` when the adapter declares
 * `load_check` boundaries. The kernel verifies the installed artifact, mounts
 * those exact bytes into a fresh setup dir, and accepts `managed_object_load`
 * only when the host it spawned authenticates a session (directly or as an
 * observed hook descendant) with an authenticated upload inside the call
 * window. The runtime's `LoadCheckResult.observed_hash` is never the proof.
 */

import { execFileSync, spawn, type ChildProcess, } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";

import { canonicalHash, err, formatSourceRef, hashBytes, makeErrorEnvelope, ok, toJsonValue, type ErrorEnvelope, type Hash, type Id, type JsonValue, type Result } from "@evoplug/core";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import type {
  KernelProbeEvidenceRequest,
  KernelProbeObservation,
  KernelProbeObservationSource
} from "./probe-producer.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return sharedIsRecord(value);
}

/** Structural twin of `AdapterProbeObservationSpec` (kernel must not import the runtime package). */
export interface ProbeObservationSpecLike {
  readonly protocol: "openai_chat" | "openai_responses" | "anthropic_messages";
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly setup_files?: readonly {
      readonly path: string;
      readonly content: string;
      readonly mode?: number;
    }[];
    /**
     * Mount the installed runtime artifact (verified kernel-side against the
     * registration's `artifact_hash`) under this setup-dir-relative path before
     * launch. This is how a child actually loads the same artifact version; a
     * declaration without it can only produce a `native_cli_contract`.
     */
    readonly artifact_mount?: string;
    /**
     * Directory-discovery shim the host loads (for example `index.js`). Attach
     * generates this file, so it is listed in the installed artifact manifest.
     * The mount verifies it is one of the re-hashed files instead of adding an
     * unlisted module. Omit for hosts that load the artifact filename directly.
     */
    readonly discovery_entry?: string;
    readonly timeout_ms?: number;
  };
  /**
   * Declares that a kernel-run of `launch` is a valid load readback for the
   * mounted artifact. The source only uses it when the call's boundary is one
   * the declaration covers, the installed tree re-hashes to the registration,
   * and a fresh host process authenticates a runtime session it started.
   */
  readonly load_check?: {
    readonly boundaries: readonly ("new_session" | "restart")[];
  };
}

/** Resolves the declaration for one adapter id; no host branching. */
export interface ProbeObservationSpecRegistry {
  specForAdapter(adapter_id: string): ProbeObservationSpecLike | null;
}

/** Minimal adapter contribution: its id and optional observation declaration. */
interface ProbeObservationSpecEntry {
  readonly adapter_id: string;
  readonly observation?: ProbeObservationSpecLike;
}

/**
 * Registry factory for bootstrap. Adapters without an `observation` field are
 * intentionally absent, so the kernel source yields no record for them instead
 * of guessing a CLI contract.
 */
export function createProbeObservationSpecRegistry(
  entries: Iterable<ProbeObservationSpecEntry>
): ProbeObservationSpecRegistry {
  const byAdapter = new Map<string, ProbeObservationSpecLike>();
  for (const entry of entries) {
    if (entry.observation !== undefined && entry.adapter_id.length > 0) {
      byAdapter.set(entry.adapter_id, entry.observation);
    }
  }
  return {
    specForAdapter(adapterId) {
      return byAdapter.get(adapterId) ?? null;
    }
  };
}

/**
 * Audit sink for kernel-launched CLI contracts. These records are deliberately
 * separate from capability evidence: a freshly launched CLI is a different
 * process from the runtime session that owns the probe call.
 */
interface KernelProbeContractSink {
  record(record: JsonValue): void | Promise<void>;
}

interface NativeCaptureSourceDeps {
  readonly connection: SqliteConnection;
  readonly blobs: {
    read(hash: Hash): Result<Uint8Array, ErrorEnvelope>;
    /** When present, contract audits are persisted and carry a CAS ref. */
    putSync?(bytes: Uint8Array): Result<
      { readonly hash: Hash; readonly byte_length: number },
      ErrorEnvelope
    >;
  };
  readonly specs: ProbeObservationSpecRegistry;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Receives `native_cli_contract` audit records; never capability evidence. */
  readonly contracts?: KernelProbeContractSink;
  /** Test seam for process creation; the capture and evidence path is not injectable. */
  readonly spawn_process?: typeof spawn;
  /**
   * Kernel-observed process table as `(pid, ppid)` pairs. Used to accept a
   * session whose runtime runs in a hook subprocess of the child the kernel
   * launched. Defaults to `ps -axo pid=,ppid=`; a platform that cannot provide
   * the table keeps the strict same-pid rule.
   */
  readonly process_snapshot?: () => readonly ProcessSnapshotEntry[];
  /** Poll interval for the process table while the child runs. */
  readonly process_snapshot_interval_ms?: number;
  /**
   * Opt-in: allow a kernel-launched child session, verified as the same
   * registration + artifact with an authenticated upload link, to yield
   * roundtrip evidence for `input_capture`. Defaults to false; without the
   * central `host_runtime_upload.session_id` column the source records the
   * contract only and returns no observation.
   */
  readonly session_roundtrip?: boolean;
}

const SOURCE_ID = "kernel.native_capture";
const CAPTURE_ID = "kernel.provider_capture";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1_048_576;
const CAPTURE_SCHEMA = "rsi.kernel_provider_capture/1";
const UPLOAD_SCHEMA = "rsi.kernel_capture_upload_match/1";
const LOAD_SCHEMA = "rsi.kernel_load_readback/1";
const DEFAULT_PROCESS_SNAPSHOT_MS = 200;
const MAX_ANCESTRY_DEPTH = 16;

interface ProcessSnapshotEntry {
  readonly pid: number;
  readonly ppid: number;
}

/** Relation the kernel observed between a session pid and the child it spawned. */
type ProcessRelation = "same_process" | "descendant";

interface ProcessRelations {
  relate(pid: number, ancestor_pid: number): ProcessRelation | null;
}

/** Reads the whole process table; an unsupported platform returns no edges. */
function readProcessTable(): readonly ProcessSnapshotEntry[] {
  const ps = ["/bin/ps", "/usr/bin/ps"].find((path) => existsSync(path));
  if (ps === undefined) {
    return [];
  }
  try {
    const text = execFileSync(ps, ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const entries: ProcessSnapshotEntry[] = [];
    for (const line of text.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (match === null) {
        continue;
      }
      entries.push({ pid: Number(match[1]), ppid: Number(match[2]) });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Collects parent edges while the child runs. A hook host runs the runtime in a
 * short-lived subprocess, so a single lookup after exit would miss it; the
 * tracker keeps every edge it observed and only claims a relation the kernel
 * actually read from the OS process table.
 */
function trackProcesses(input: {
  readonly snapshot: () => readonly ProcessSnapshotEntry[];
  readonly interval_ms: number;
}): { readonly relations: ProcessRelations; stop(): void } {
  const parents = new Map<number, number>();
  const poll = (): void => {
    let entries: readonly ProcessSnapshotEntry[];
    try {
      entries = input.snapshot();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        Number.isSafeInteger(entry.pid) &&
        entry.pid > 0 &&
        Number.isSafeInteger(entry.ppid) &&
        entry.ppid >= 0 &&
        !parents.has(entry.pid)
      ) {
        parents.set(entry.pid, entry.ppid);
      }
    }
  };
  poll();
  const timer = setInterval(poll, Math.max(20, input.interval_ms));
  timer.unref();
  return {
    relations: {
      relate(pid, ancestorPid) {
        if (pid === ancestorPid) {
          return "same_process";
        }
        let current = pid;
        for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
          const parent = parents.get(current);
          if (parent === undefined || parent <= 0) {
            return null;
          }
          if (parent === ancestorPid) {
            return "descendant";
          }
          current = parent;
        }
        return null;
      }
    },
    stop() {
      clearInterval(timer);
      poll();
    }
  };
}

interface CapturedRequest {
  readonly received_at: number;
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

interface AcceptedUploadMatch {
  readonly upload_ref: string;
  readonly payload_hash: Hash;
  readonly created_at: number;
}

function sourceError(stage: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_PROBE_OBSERVATION",
    category: "source",
    message_key: "error.probe.observation",
    stage,
    retryable: true,
    side_effect: "none",
    details: { kind: "none" }
  });
}

function probeMarker(nonce: string): string {
  return `[[evoplug-probe:${nonce}]]`;
}

function probeInstruction(nonce: string): string {
  return [
    `Evoplug capability probe ${probeMarker(nonce)}.`,
    "Read-only: reply with the marker and do not call tools."
  ].join("\n");
}

function substitute(
  value: string,
  variables: Readonly<Record<string, string>>
): string {
  let result = value;
  for (const [name, replacement] of Object.entries(variables)) {
    result = result.split(`{${name}}`).join(replacement);
  }
  return result;
}

function captureText(nonce: string): string {
  return `probe ok ${probeMarker(nonce)}`;
}

function sse(res: ServerResponse, payload: JsonValue): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Answers the three wire shapes hosts use. The answer text carries the nonce so
 * the runtime may echo it, but kernel verification never depends on the echo:
 * it depends on the captured request body.
 */
function answer(
  protocol: ProbeObservationSpecLike["protocol"],
  nonce: string,
  body: Record<string, JsonValue> | null,
  res: ServerResponse
): void {
  const text = captureText(nonce);
  const stream = body?.["stream"] === true;
  if (protocol === "openai_chat") {
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-evoplug-probe",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "evoplug-probe",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, {
      id: "chatcmpl-evoplug-probe",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "evoplug-probe",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
    });
    sse(res, {
      id: "chatcmpl-evoplug-probe",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "evoplug-probe",
      choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }]
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  if (protocol === "openai_responses") {
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, { type: "response.created", response: { id: "resp_evoplug_probe", model: "evoplug-probe" } });
      sse(res, { type: "response.output_text.delta", item_id: "msg_evoplug_probe", delta: text });
      sse(res, {
        type: "response.completed",
        response: {
          id: "resp_evoplug_probe",
          model: "evoplug-probe",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_evoplug_probe",
              role: "assistant",
              content: [{ type: "output_text", text }]
            }
          ]
        }
      });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_evoplug_probe",
        object: "response",
        model: "evoplug-probe",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_evoplug_probe",
            role: "assistant",
            content: [{ type: "output_text", text }]
          }
        ]
      })
    );
    return;
  }
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, {
      type: "message_start",
      message: {
        id: "msg_evoplug_probe",
        type: "message",
        role: "assistant",
        model: "evoplug-probe",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 }
      }
    });
    sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    sse(res, { type: "content_block_stop", index: 0 });
    sse(res, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    sse(res, { type: "message_stop" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_evoplug_probe",
      type: "message",
      role: "assistant",
      model: "evoplug-probe",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
  );
}

function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) {
        reject(new Error("capture body too large"));
        return;
      }
      body += chunk.toString("utf8");
    });
    stream.on("end", () => resolve(body));
    stream.on("error", reject);
  });
}

async function startCapture(
  protocol: ProbeObservationSpecLike["protocol"],
  nonce: string,
  captured: CapturedRequest[],
  now: () => number
): Promise<{ readonly server: Server; readonly base_url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      let body = "";
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400).end();
        return;
      }
      captured.push({
        received_at: now(),
        method: req.method ?? "POST",
        url: req.url ?? "/",
        body
      });
      let parsed: Record<string, JsonValue> | null = null;
      try {
        const value = JSON.parse(body) as unknown;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          parsed = value as Record<string, JsonValue>;
        }
      } catch {
        parsed = null;
      }
      answer(protocol, nonce, parsed, res);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("capture endpoint has no port");
  }
  return { server, base_url: `http://127.0.0.1:${String(address.port)}` };
}

function safeSetupPath(root: string, relative: string): string | null {
  if (relative.length === 0 || isAbsolute(relative)) {
    return null;
  }
  const target = normalize(join(root, relative));
  if (!target.startsWith(`${root}/`)) {
    return null;
  }
  return target;
}

interface RegistrationFacts {
  readonly registration_hash: Hash;
  readonly adapter_id: string;
  readonly host_id: string;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly artifact_hash: Hash;
  readonly written_hash: Hash | null;
}

function readRegistrationFacts(
  connection: SqliteConnection,
  registrationHash: Hash
): RegistrationFacts | null {
  const row = connection
    .prepare<SqlRow>(
      `SELECT registration_hash, adapter_id, host_id, adapter_version,
              implementation_hash, artifact_hash, written_hash
         FROM adapter_registration
        WHERE registration_hash = :registration_hash AND state = 'applied'`
    )
    .get({ registration_hash: registrationHash });
  if (row === undefined) {
    return null;
  }
  const artifactHash = row["artifact_hash"];
  const adapterId = row["adapter_id"];
  const hostId = row["host_id"];
  const adapterVersion = row["adapter_version"];
  const implementationHash = row["implementation_hash"];
  if (
    typeof artifactHash !== "string" ||
    typeof adapterId !== "string" ||
    typeof hostId !== "string" ||
    typeof adapterVersion !== "string" ||
    typeof implementationHash !== "string"
  ) {
    return null;
  }
  return {
    registration_hash: registrationHash,
    adapter_id: adapterId,
    host_id: hostId,
    adapter_version: adapterVersion,
    implementation_hash: implementationHash as Hash,
    artifact_hash: artifactHash as Hash,
    written_hash: typeof row["written_hash"] === "string" ? (row["written_hash"] as Hash) : null
  };
}

interface VerifiedArtifact {
  readonly root: string;
  readonly manifest_hash: Hash;
  readonly entry: string;
  readonly files: readonly { readonly path: string; readonly sha256: Hash; readonly mode: number }[];
}

/**
 * Kernel-side artifact verification. It reads the installed files and
 * recomputes `sha256(JCS(manifest))` plus every member hash; no value comes
 * from the runtime's ready/upload report. Returns null when the installed tree
 * does not match the applied registration's artifact hash.
 */
function findVerifiedArtifact(
  connection: SqliteConnection,
  registration: RegistrationFacts
): VerifiedArtifact | null {
  let rows: readonly SqlRow[];
  try {
    rows = connection
      .prepare<SqlRow>(
        `SELECT path FROM install_path
          WHERE state = 'present' AND kind = 'file'
          ORDER BY path`
      )
      .all({});
  } catch {
    return null;
  }
  for (const row of rows) {
    const manifestPath = row["path"];
    if (typeof manifestPath !== "string" || !manifestPath.endsWith("/manifest.json")) {
      continue;
    }
    // Artifacts are either rooted at `<root>/manifest.json` or use the
    // single-file layout `<root>/<name>.runtime/manifest.json`; in both cases
    // manifest file paths stay relative to `<root>`.
    const manifestParent = dirname(manifestPath);
    const root = manifestParent.endsWith(".runtime")
      ? dirname(manifestParent)
      : manifestParent;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    let manifestHash: Hash;
    try {
      manifestHash = canonicalHash(parsed);
    } catch {
      continue;
    }
    if (manifestHash !== registration.artifact_hash) {
      continue;
    }
    if (
      parsed["adapter_id"] !== registration.adapter_id ||
      parsed["host_id"] !== registration.host_id ||
      parsed["adapter_version"] !== registration.adapter_version ||
      parsed["implementation_hash"] !== registration.implementation_hash ||
      typeof parsed["entry"] !== "string"
    ) {
      continue;
    }
    const files = parsed["files"];
    if (!Array.isArray(files) || files.length === 0) {
      continue;
    }
    const verified: { path: string; sha256: Hash; mode: number }[] = [];
    let valid = true;
    for (const entry of files) {
      if (!isRecord(entry)) {
        valid = false;
        break;
      }
      const relative = entry["path"];
      const sha256 = entry["sha256"];
      const mode = entry["mode"];
      if (typeof relative !== "string" || typeof sha256 !== "string" || typeof mode !== "number") {
        valid = false;
        break;
      }
      const target = safeSetupPath(root, relative);
      if (target === null) {
        valid = false;
        break;
      }
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(target);
      } catch {
        valid = false;
        break;
      }
      if (hashBytes(bytes) !== sha256) {
        valid = false;
        break;
      }
      verified.push({ path: relative, sha256: sha256 as Hash, mode });
    }
    if (!valid) {
      continue;
    }
    if (!verified.some((file) => file.path === parsed["entry"])) {
      continue;
    }
    return {
      root,
      manifest_hash: manifestHash,
      entry: parsed["entry"] as string,
      files: verified
    };
  }
  return null;
}

function copyFileInto(target: string, bytes: Uint8Array, mode: number | undefined): boolean {
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, mode === undefined ? undefined : { mode });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the verified artifact bytes into the child setup dir. Metadata
 * (`manifest.json`, `config.json`, `<name>.runtime/*.json`) is copied so the
 * runtime entry can recompute the same artifact hash and read its IPC config.
 */
function mountArtifact(
  artifact: VerifiedArtifact,
  setupDir: string,
  mount: string,
  discoveryEntry: string | undefined
): boolean {
  const mountRoot = safeSetupPath(setupDir, mount);
  if (mountRoot === null) {
    return false;
  }
  try {
    mkdirSync(mountRoot, { recursive: true });
  } catch {
    return false;
  }
  for (const file of artifact.files) {
    const target = safeSetupPath(setupDir, `${mount}/${file.path}`);
    if (target === null) {
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(artifact.root, file.path));
    } catch {
      return false;
    }
    if (!copyFileInto(target, bytes, file.mode)) {
      return false;
    }
  }
  if (
    discoveryEntry !== undefined &&
    !artifact.files.some((file) => file.path === discoveryEntry)
  ) {
    // Attach generates the shim and the installed manifest lists it. A mount
    // that would need an unlisted file cannot pass the runtime's own load
    // verification, so fail closed instead of adding bytes outside the
    // verified artifact.
    return false;
  }
  const metadata = ["manifest.json", "config.json"];
  try {
    for (const entry of readdirSync(artifact.root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith(".runtime")) {
        metadata.push(`${entry.name}/manifest.json`, `${entry.name}/config.json`);
      }
    }
  } catch {
    return false;
  }
  for (const relative of metadata) {
    const source = join(artifact.root, relative);
    if (!existsSync(source)) {
      continue;
    }
    let bytes: Uint8Array;
    try {
      if (!statSync(source).isFile()) {
        continue;
      }
      bytes = readFileSync(source);
    } catch {
      return false;
    }
    const target = safeSetupPath(setupDir, `${mount}/${relative}`);
    if (target === null || !copyFileInto(target, bytes, 0o600)) {
      return false;
    }
  }
  return true;
}

function writeSetup(
  dir: string,
  files: ProbeObservationSpecLike["launch"]["setup_files"],
  variables: Readonly<Record<string, string>>
): boolean {
  for (const file of files ?? []) {
    const target = safeSetupPath(dir, file.path);
    if (target === null) {
      return false;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, substitute(file.content, variables), {
        encoding: "utf8",
        ...(file.mode === undefined ? {} : { mode: file.mode })
      });
    } catch {
      return false;
    }
  }
  return true;
}

function resolveExecutable(command: string): string | null {
  if (command.length === 0) {
    return null;
  }
  const candidates = command.includes("/")
    ? [command]
    : (process.env["PATH"] ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // try the next PATH entry
    }
  }
  return null;
}

function hashFile(path: string): Hash | null {
  try {
    return hashBytes(readFileSync(path));
  } catch {
    return null;
  }
}

function runProcess(
  spawnProcess: typeof spawn,
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeout_ms: number;
  }
): Promise<{ readonly exit_code: number | null; readonly timed_out: boolean; readonly pid: number | null }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      resolve({ exit_code: null, timed_out: false, pid: null });
      return;
    }
    const pid = typeof child.pid === "number" ? child.pid : null;
    let settled = false;
    const finish = (exit_code: number | null, timed_out: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit_code, timed_out, pid });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, true);
    }, options.timeout_ms);
    child.once("close", (code) => finish(code, false));
    child.once("error", () => finish(null, false));
  });
}

/**
 * Production factory. It executes the adapter-declared CLI against a
 * kernel-owned capture endpoint and records a `native_cli_contract`.
 *
 * Trusted roundtrip (opt-in via `session_roundtrip`) additionally requires all
 * of the following, all observed by the kernel:
 * - the installed runtime artifact is read from disk and its manifest/files
 *   are re-hashed to the applied registration's `artifact_hash`;
 * - the artifact is mounted into the child setup dir and the launched child's
 *   pid matches, or is an observed ancestor of, the session pid recorded by the
 *   kernel-authenticated runtime;
 * - `host_runtime_upload.session_id` links a nonce-bearing upload to that
 *   session, and the session's registration/artifact match the call;
 * - the kernel capture endpoint received a provider request containing the
 *   same nonce.
 * Runtime uploads without a session link, a different pid/artifact, or a
 * runtime-supplied hash can never yield an observation. `check_load` uses the
 * same launch and link rules with an adapter-declared boundary and no nonce.
 */
export function createNativeCaptureObservationSource(
  deps: NativeCaptureSourceDeps
): KernelProbeObservationSource {
  const now = deps.now ?? Date.now;
  const spawnProcess = deps.spawn_process ?? spawn;
  const processSnapshot = deps.process_snapshot ?? readProcessTable;
  const processSnapshotInterval =
    deps.process_snapshot_interval_ms ?? DEFAULT_PROCESS_SNAPSHOT_MS;

  function uploadHasSessionColumn(): boolean {
    try {
      const columns = deps.connection
        .prepare<SqlRow>("PRAGMA table_info(host_runtime_upload)")
        .all({});
      return columns.some((row) => row["name"] === "session_id");
    } catch {
      return false;
    }
  }

  function findAcceptedUpload(input: KernelProbeEvidenceRequest): AcceptedUploadMatch | null {
    const rows = deps.connection
      .prepare<SqlRow>(
        `SELECT u.payload_hash, u.created_at, b.byte_length
           FROM host_runtime_upload u
           JOIN blob b ON b.blob_hash = u.payload_hash AND b.state = 'present'
          WHERE u.registration_hash = :registration_hash
            AND u.created_at >= :issued_at
            AND u.created_at <= :now
          ORDER BY u.created_at DESC`
      )
      .all({
        registration_hash: input.registration_hash,
        issued_at: input.issued_at,
        now: input.now
      });
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for (const row of rows) {
      const hash = row["payload_hash"];
      const createdAt = row["created_at"];
      const byteLength = row["byte_length"];
      if (
        typeof hash !== "string" ||
        typeof createdAt !== "number" ||
        typeof byteLength !== "number"
      ) {
        continue;
      }
      const bytes = deps.blobs.read(hash as Hash);
      if (!bytes.ok) {
        continue;
      }
      if (!decoder.decode(bytes.value).includes(input.nonce)) {
        continue;
      }
      const formatted = formatSourceRef({
        scheme: "blob",
        locator: hash as Hash,
        start: 0,
        end: byteLength
      });
      if (!formatted.ok) {
        continue;
      }
      return {
        upload_ref: formatted.value,
        payload_hash: hash as Hash,
        created_at: createdAt
      };
    }
    return null;
  }

  interface LinkedSession {
    readonly session_id: Id<"rts">;
    readonly raw_event_id: string;
    readonly payload_hash: Hash;
    readonly upload_ref: string;
    readonly created_at: number;
    readonly pid: number;
    readonly relation: ProcessRelation;
    readonly native_session_id: string;
    readonly state: string;
    readonly registration_hash: Hash;
    readonly artifact_hash: Hash;
  }

  /**
   * Finds an authenticated upload to the launched child session. The join on
   * `host_runtime_upload.session_id` is the link the runtime cannot author:
   * that column is written from the authenticated session id/nonce.
   *
   * The session process must be the child the kernel spawned or a descendant of
   * it, as read from the kernel's process-table snapshots. A hook host runs the
   * runtime in a subprocess, so pid equality alone would reject it permanently;
   * an unobserved relation still rejects the upload.
   *
   * `nonce` is required for `probe` (the upload must carry the probe nonce) and
   * null for `check_load` (a fresh launch has no call nonce to echo).
   */
  function findLinkedSession(input: {
    readonly registration: RegistrationFacts;
    readonly expected_artifact: Hash;
    readonly child_pid: number | null;
    readonly started_at: number;
    readonly finished_at: number;
    readonly nonce: string | null;
    readonly relations: ProcessRelations;
  }): LinkedSession | null {
    if (input.child_pid === null || !uploadHasSessionColumn()) {
      return null;
    }
    let rows: readonly SqlRow[];
    try {
      rows = deps.connection
        .prepare<SqlRow>(
          `SELECT u.session_id, u.raw_event_id, u.payload_hash, u.created_at,
                  s.pid, s.native_session_id, s.state, s.session_role AS session_role,
                  s.registration_hash AS session_registration_hash,
                  s.artifact_hash AS session_artifact_hash,
                  s.adapter_id AS session_adapter_id,
                  s.adapter_version AS session_adapter_version,
                  s.implementation_hash AS session_implementation_hash
             FROM host_runtime_upload u
             JOIN host_runtime_session s ON s.session_id = u.session_id
            WHERE u.registration_hash = :registration_hash
              AND u.session_id IS NOT NULL
              AND u.created_at >= :started_at
              AND u.created_at <= :finished_at
            ORDER BY u.created_at DESC`
        )
        .all({
          registration_hash: input.registration.registration_hash,
          started_at: input.started_at,
          finished_at: input.finished_at
        });
    } catch {
      return null;
    }
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for (const row of rows) {
      if (
        row["session_registration_hash"] !== input.registration.registration_hash ||
        row["session_artifact_hash"] !== input.expected_artifact ||
        row["session_adapter_id"] !== input.registration.adapter_id ||
        row["session_adapter_version"] !== input.registration.adapter_version ||
        row["session_implementation_hash"] !== input.registration.implementation_hash ||
        typeof row["pid"] !== "number" ||
        row["session_role"] !== "evaluator" ||
        typeof row["native_session_id"] !== "string" ||
        row["native_session_id"].length === 0 ||
        typeof row["session_id"] !== "string" ||
        typeof row["raw_event_id"] !== "string" ||
        typeof row["payload_hash"] !== "string" ||
        typeof row["created_at"] !== "number" ||
        typeof row["session_artifact_hash"] !== "string"
      ) {
        continue;
      }
      const relation = input.relations.relate(row["pid"], input.child_pid);
      if (relation === null) {
        continue;
      }
      const bytes = deps.blobs.read(row["payload_hash"] as Hash);
      if (!bytes.ok) {
        continue;
      }
      if (
        input.nonce !== null &&
        !decoder.decode(bytes.value).includes(input.nonce)
      ) {
        continue;
      }
      const formatted = formatSourceRef({
        scheme: "blob",
        locator: row["payload_hash"] as Hash,
        start: 0,
        end: bytes.value.byteLength
      });
      if (!formatted.ok) {
        continue;
      }
      return {
        session_id: row["session_id"] as Id<"rts">,
        raw_event_id: row["raw_event_id"],
        payload_hash: row["payload_hash"] as Hash,
        upload_ref: formatted.value,
        created_at: row["created_at"],
        pid: row["pid"],
        relation,
        native_session_id: row["native_session_id"],
        state: typeof row["state"] === "string" ? row["state"] : "unknown",
        registration_hash: row["session_registration_hash"] as Hash,
        artifact_hash: row["session_artifact_hash"]
      };
    }
    return null;
  }

  async function observeProbe(
    input: KernelProbeEvidenceRequest,
    registration: RegistrationFacts,
    spec: ProbeObservationSpecLike
  ): Promise<KernelProbeObservation | null> {
    if (input.now > input.deadline_at) {
      return null;
    }
    const captured: CapturedRequest[] = [];
    let capture: { readonly server: Server; readonly base_url: string } | null = null;
    let workDir: string | null = null;
    try {
      const artifact =
        spec.launch.artifact_mount === undefined
          ? null
          : findVerifiedArtifact(deps.connection, registration);
      capture = await startCapture(spec.protocol, input.nonce, captured, now);
      workDir = mkdtempSync(join(tmpdir(), "evoplug-native-probe-"));
      const variables: Readonly<Record<string, string>> = {
        capture_base_url: capture.base_url,
        capture_url: capture.base_url,
        nonce: input.nonce,
        prompt: probeInstruction(input.nonce),
        setup_dir: workDir
      };
      if (!writeSetup(workDir, spec.launch.setup_files, variables)) {
        return null;
      }
      const artifactMounted =
        artifact !== null &&
        spec.launch.artifact_mount !== undefined &&
        mountArtifact(
          artifact,
          workDir,
          spec.launch.artifact_mount,
          spec.launch.discovery_entry
        );
      const resolvedEnv: NodeJS.ProcessEnv = { ...process.env, ...deps.env };
      for (const [name, value] of Object.entries(spec.launch.env ?? {})) {
        resolvedEnv[name] = substitute(value, variables);
      }
      const timeoutMs = Math.max(
        1,
        Math.min(
          spec.launch.timeout_ms ?? DEFAULT_TIMEOUT_MS,
          Math.max(1, input.deadline_at - now())
        )
      );
      const tracker = trackProcesses({
        snapshot: processSnapshot,
        interval_ms: processSnapshotInterval
      });
      const startedAt = now();
      const childResult = await runProcess(
        spawnProcess,
        spec.launch.command,
        spec.launch.args.map((arg) => substitute(arg, variables)),
        { cwd: workDir, env: resolvedEnv, timeout_ms: timeoutMs }
      );
      const finishedAt = now();
      tracker.stop();
      if (finishedAt > input.deadline_at) {
        return null;
      }
      const matched = captured.find((entry) => entry.body.includes(input.nonce));
      if (matched === undefined) {
        return null;
      }
      const upload = findAcceptedUpload({
        ...input,
        now: Math.min(finishedAt, input.deadline_at)
      });
      const expectedArtifact = registration.written_hash ?? registration.artifact_hash;
      const linked =
        deps.session_roundtrip === true && artifact !== null && artifactMounted
          ? findLinkedSession({
              registration,
              expected_artifact: expectedArtifact,
              child_pid: childResult.pid,
              started_at: startedAt,
              finished_at: finishedAt,
              nonce: input.nonce,
              relations: tracker.relations
            })
          : null;
      const executable = resolveExecutable(spec.launch.command);
      const executableHash = executable === null ? null : hashFile(executable);
      const sameArtifactSession =
        linked !== null &&
        artifact !== null &&
        artifact.manifest_hash === expectedArtifact &&
        linked.artifact_hash === expectedArtifact &&
        linked.registration_hash === registration.registration_hash;
      const contract = {
        schema_version: CAPTURE_SCHEMA,
        contract_id: CAPTURE_ID,
        kind: "native_cli_contract",
        protocol: spec.protocol,
        call_id: input.call_id,
        nonce: input.nonce,
        session_id: linked?.session_id ?? input.session_id,
        call_session_id: input.session_id,
        registration_hash: input.registration_hash,
        binding_key: input.binding_key,
        artifact_hash: input.artifact_hash,
        observed_at: matched.received_at,
        launch: {
          command: spec.launch.command,
          resolved_path: executable,
          executable_hash: executableHash,
          executable_hash_matches_binding: false
        },
        artifact_verification:
          artifact === null
            ? null
            : {
                root: artifact.root,
                manifest_hash: artifact.manifest_hash,
                registered_hash: expectedArtifact,
                entry: artifact.entry,
                files_verified: artifact.files.length,
                discovery_entry: spec.launch.discovery_entry ?? null,
                mounted: artifactMounted
              },
        capture: {
          request_received_at: matched.received_at,
          method: matched.method,
          url: matched.url,
          body: matched.body,
          nonce_present: true
        },
        upload_nonce_match:
          upload === null
            ? null
            : {
                schema_version: UPLOAD_SCHEMA,
                upload_ref: upload.upload_ref,
                payload_hash: upload.payload_hash,
                created_at: upload.created_at
              },
        session_link:
          linked === null
            ? null
            : {
                session_id: linked.session_id,
                call_session_id: input.session_id,
                pid: linked.pid,
                child_pid: childResult.pid,
                relation: linked.relation,
                native_session_id: linked.native_session_id,
                registration_hash: linked.registration_hash,
                artifact_hash: linked.artifact_hash,
                upload_ref: linked.upload_ref,
                raw_event_id: linked.raw_event_id,
                created_at: linked.created_at
              },
        process: {
          pid: childResult.pid,
          exit_code: childResult.exit_code,
          timed_out: childResult.timed_out
        },
        same_artifact_session: sameArtifactSession,
        capability_evidence: sameArtifactSession,
        reason:
          sameArtifactSession
            ? null
            : "native_cli_contract_requires_same_artifact_session"
      } as const;
      let contractRef: string | null = null;
      if (deps.blobs.putSync !== undefined) {
        const bytes = new TextEncoder().encode(JSON.stringify(contract));
        const stored = deps.blobs.putSync(bytes);
        if (stored.ok) {
          const formatted = formatSourceRef({
            scheme: "blob",
            locator: stored.value.hash,
            start: 0,
            end: stored.value.byte_length
          });
          contractRef = formatted.ok ? formatted.value : null;
        }
      }
      await deps.contracts?.record(
        toJsonValue({
          ...contract,
          ...(contractRef === null ? {} : { contract_ref: contractRef })
        })
      );
      if (linked === null || artifact === null || !sameArtifactSession) {
        return null;
      }
      if (matched.received_at < input.issued_at || matched.received_at > input.deadline_at) {
        return null;
      }
      const evidence: JsonValue[] = [
        toJsonValue({
          kind: "provider_capture",
          received_at: matched.received_at,
          method: matched.method,
          url: matched.url,
          body: matched.body,
          nonce_present: true
        }),
        toJsonValue({
          kind: "authenticated_upload",
          upload_ref: linked.upload_ref,
          raw_event_id: linked.raw_event_id,
          payload_hash: linked.payload_hash,
          session_id: linked.session_id,
          created_at: linked.created_at,
          nonce_present: true
        }),
        toJsonValue({
          kind: "kernel_session_link",
          session_id: linked.session_id,
          call_session_id: input.session_id,
          pid: linked.pid,
          child_pid: childResult.pid,
          relation: linked.relation,
          native_session_id: linked.native_session_id,
          session_state: linked.state,
          registration_hash: linked.registration_hash,
          artifact_hash: linked.artifact_hash
        }),
        toJsonValue({
          kind: "artifact_verification",
          root: artifact.root,
          manifest_hash: artifact.manifest_hash,
          registered_hash: expectedArtifact,
          entry: artifact.entry,
          files_verified: artifact.files.length,
          executable_path: executable,
          executable_hash: executableHash
        }),
        toJsonValue({
          kind: "child_process",
          pid: childResult.pid,
          exit_code: childResult.exit_code,
          timed_out: childResult.timed_out
        })
      ];
      return {
        kind: "probe",
        call_id: input.call_id,
        nonce: input.nonce,
        session_id: linked.session_id,
        call_session_id: input.session_id,
        registration_hash: registration.registration_hash,
        binding_key: input.binding_key,
        artifact_hash: registration.artifact_hash,
        native_session_id: linked.native_session_id,
        capabilities: ["input_capture"] as const,
        nonce_observed: true,
        observed_at: matched.received_at,
        evidence
      };
    } catch {
      return null;
    } finally {
      if (capture !== null) {
        await new Promise<void>((resolve) => {
          capture?.server.close(() => resolve());
        });
      }
      if (workDir !== null) {
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  /**
   * Kernel-executed load readback for `check_load`.
   *
   * The runtime's own `LoadCheckResult` only says what the runtime read. This
   * path instead runs the adapter-declared launch in a kernel-owned setup dir
   * with the verified installed artifact mounted, and accepts the result only
   * when the kernel observes all of:
   * - the installed tree re-hashes to the registration's written artifact;
   * - the child process the kernel spawned authenticated a runtime session that
   *   is that process (or a hook descendant) and belongs to the same
   *   registration/artifact;
   * - an authenticated upload from that session landed inside the call window.
   * The runtime never supplies the hash used as proof, and a fresh process can
   * only speak for `new_session`/`restart` boundaries the adapter declared.
   */
  async function observeCheckLoad(
    input: KernelProbeEvidenceRequest,
    registration: RegistrationFacts,
    spec: ProbeObservationSpecLike
  ): Promise<KernelProbeObservation | null> {
    const declaration = spec.load_check;
    if (
      declaration === undefined ||
      input.load_boundary === undefined ||
      !declaration.boundaries.includes(input.load_boundary as "new_session" | "restart") ||
      spec.launch.artifact_mount === undefined ||
      input.now > input.deadline_at
    ) {
      return null;
    }
    const expectedArtifact = registration.written_hash ?? registration.artifact_hash;
    const captured: CapturedRequest[] = [];
    let capture: { readonly server: Server; readonly base_url: string } | null = null;
    let workDir: string | null = null;
    let stopTracker: (() => void) | null = null;
    try {
      const artifact = findVerifiedArtifact(deps.connection, registration);
      if (artifact === null || artifact.manifest_hash !== expectedArtifact) {
        return null;
      }
      capture = await startCapture(spec.protocol, input.nonce, captured, now);
      workDir = mkdtempSync(join(tmpdir(), "evoplug-native-load-"));
      const variables: Readonly<Record<string, string>> = {
        capture_base_url: capture.base_url,
        capture_url: capture.base_url,
        nonce: input.nonce,
        prompt: probeInstruction(input.nonce),
        setup_dir: workDir
      };
      if (!writeSetup(workDir, spec.launch.setup_files, variables)) {
        return null;
      }
      if (
        !mountArtifact(
          artifact,
          workDir,
          spec.launch.artifact_mount,
          spec.launch.discovery_entry
        )
      ) {
        return null;
      }
      const resolvedEnv: NodeJS.ProcessEnv = { ...process.env, ...deps.env };
      for (const [name, value] of Object.entries(spec.launch.env ?? {})) {
        resolvedEnv[name] = substitute(value, variables);
      }
      const timeoutMs = Math.max(
        1,
        Math.min(
          spec.launch.timeout_ms ?? DEFAULT_TIMEOUT_MS,
          Math.max(1, input.deadline_at - now())
        )
      );
      const tracker = trackProcesses({
        snapshot: processSnapshot,
        interval_ms: processSnapshotInterval
      });
      stopTracker = tracker.stop;
      const startedAt = now();
      const childResult = await runProcess(
        spawnProcess,
        spec.launch.command,
        spec.launch.args.map((arg) => substitute(arg, variables)),
        { cwd: workDir, env: resolvedEnv, timeout_ms: timeoutMs }
      );
      const finishedAt = now();
      tracker.stop();
      stopTracker = null;
      if (finishedAt > input.deadline_at) {
        return null;
      }
      const linked = findLinkedSession({
        registration,
        expected_artifact: expectedArtifact,
        child_pid: childResult.pid,
        started_at: startedAt,
        finished_at: Math.min(finishedAt, input.deadline_at),
        nonce: null,
        relations: tracker.relations
      });
      if (linked === null) {
        return null;
      }
      if (
        linked.created_at < input.issued_at ||
        linked.created_at > input.deadline_at ||
        linked.artifact_hash !== expectedArtifact ||
        linked.registration_hash !== registration.registration_hash
      ) {
        return null;
      }
      const executable = resolveExecutable(spec.launch.command);
      const executableHash = executable === null ? null : hashFile(executable);
      const evidence: JsonValue[] = [
        toJsonValue({
          kind: "artifact_verification",
          root: artifact.root,
          manifest_hash: artifact.manifest_hash,
          registered_hash: expectedArtifact,
          entry: artifact.entry,
          files_verified: artifact.files.length,
          discovery_entry: spec.launch.discovery_entry ?? null,
          mount: spec.launch.artifact_mount,
          executable_path: executable,
          executable_hash: executableHash
        }),
        toJsonValue({
          kind: "kernel_session_link",
          session_id: linked.session_id,
          call_session_id: input.session_id,
          pid: linked.pid,
          child_pid: childResult.pid,
          relation: linked.relation,
          native_session_id: linked.native_session_id,
          session_state: linked.state,
          registration_hash: linked.registration_hash,
          artifact_hash: linked.artifact_hash
        }),
        toJsonValue({
          kind: "authenticated_upload",
          upload_ref: linked.upload_ref,
          raw_event_id: linked.raw_event_id,
          payload_hash: linked.payload_hash,
          session_id: linked.session_id,
          created_at: linked.created_at,
          nonce_present: false
        }),
        toJsonValue({
          kind: "child_process",
          pid: childResult.pid,
          exit_code: childResult.exit_code,
          timed_out: childResult.timed_out
        }),
        toJsonValue({
          kind: "load_boundary",
          boundary: input.load_boundary,
          declared_boundaries: [...declaration.boundaries]
        })
      ];
      await deps.contracts?.record(
        toJsonValue({
          schema_version: LOAD_SCHEMA,
          contract_id: CAPTURE_ID,
          kind: "kernel_load_readback",
          call_id: input.call_id,
          nonce: input.nonce,
          session_id: linked.session_id,
          call_session_id: input.session_id,
          registration_hash: input.registration_hash,
          binding_key: input.binding_key,
          artifact_hash: input.artifact_hash,
          observed_at: linked.created_at,
          load_boundary: input.load_boundary,
          evidence
        })
      );
      return {
        kind: "check_load",
        call_id: input.call_id,
        nonce: input.nonce,
        session_id: linked.session_id,
        call_session_id: input.session_id,
        registration_hash: registration.registration_hash,
        binding_key: input.binding_key,
        artifact_hash: registration.artifact_hash,
        native_session_id: linked.native_session_id,
        capabilities: ["managed_object_load"] as const,
        nonce_observed: false,
        observed_at: linked.created_at,
        evidence
      };
    } catch {
      return null;
    } finally {
      stopTracker?.();
      if (capture !== null) {
        await new Promise<void>((resolve) => {
          capture?.server.close(() => resolve());
        });
      }
      if (workDir !== null) {
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  return {
    source_id: SOURCE_ID,
    async observe(input) {
      try {
        if (input.kind !== "probe" && input.kind !== "check_load") {
          return ok([]);
        }
        if (input.kind === "probe" && !input.capabilities.includes("input_capture")) {
          return ok([]);
        }
        if (
          input.kind === "check_load" &&
          !input.capabilities.includes("managed_object_load")
        ) {
          return ok([]);
        }
        const registration = readRegistrationFacts(deps.connection, input.registration_hash);
        if (registration === null) {
          return ok([]);
        }
        const spec = deps.specs.specForAdapter(registration.adapter_id);
        if (spec === null) {
          return ok([]);
        }
        const observation =
          input.kind === "probe"
            ? await observeProbe(input, registration, spec)
            : await observeCheckLoad(input, registration, spec);
        return ok(observation === null ? [] : [observation]);
      } catch {
        return err(sourceError("probe_observation"));
      }
    }
  };
}
