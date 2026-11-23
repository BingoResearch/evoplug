/**
 * OpenCode `cli_spawn` generation adapter (DD-HOST-002).
 *
 * The adapter owns only the child-process boundary. OpenCode keeps its own
 * provider configuration and authentication; evoplug passes no credential to
 * this module. A composition root supplies read/write ports for content
 * addressed blobs so prompt and output bytes remain inside the existing source
 * evidence boundary.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  canonicalHash,
  hashBytes,
  isSourceRef,
  parseSourceRef,
  systemClock,
  toJsonValue,
  type Clock,
  type ErrorEnvelope,
  type Id,
  type Result,
  type SourceRef
} from "@evoplug/core";
import type {
  AdapterBackendSelection,
  GenerationAuthRequest,
  GenerationAuthResult,
  GenerationBackendRef,
  GenerationBackendSelectRequest,
  GenerationCancelRequest,
  GenerationCancelResult,
  GenerationCapabilityBinding,
  GenerationCreateRequest,
  GenerationCreateResult,
  GenerationOutputRequest,
  GenerationOutputResult,
  GenerationRecoverRequest,
  GenerationRecoverResult,
  HostAdapterResult
} from "@evoplug/core/host";
import { adapterErr, adapterOk } from "@evoplug/core/host";

import {
  OPENCODE_ADAPTER_ID,
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_HOST_ID,
  OPENCODE_HOST_VERSION
} from "./manifest.js";
import { OPENCODE_DESCRIPTOR_REF } from "./descriptor.js";
import {
  extractJsonlText,
  normalizeFinalNewline,
  OPENCODE_OUTPUT_EXTRACT,
  OPENCODE_OUTPUT_NORMALIZATION
} from "./generation-output.js";
import { OPENCODE_GENERATION_SPEC } from "./generation-spec.js";

const DEFAULT_EXECUTABLE = "opencode";
const DEFAULT_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;
const PROFILE_REF = "opencode-cli:inherited-provider";

type BlobReadPort = (
  ref: SourceRef,
  options?: { readonly maxBytes?: number }
) => Promise<Result<Uint8Array, ErrorEnvelope>>;
type BlobWritePort = (bytes: Uint8Array) => Promise<Result<SourceRef, ErrorEnvelope>>;
type SpawnPort = (
  executable: string,
  args: string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

/**
 * Appendix J.3: inline OpenCode config for the tool-less generation agent.
 * When the caller already set inline config, keep its other keys and only add
 * the agent definition.
 */
export function mergeGenerationConfig(existing: string | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim().length > 0) {
    try {
      const value = JSON.parse(existing) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  const agents = typeof parsed["agent"] === "object" && parsed["agent"] !== null && !Array.isArray(parsed["agent"])
    ? { ...(parsed["agent"] as Record<string, unknown>) }
    : {};
  agents["evoplug-generation"] = {
    mode: "primary",
    tools: {
      "*": false,
      bash: false,
      edit: false,
      write: false,
      read: false,
      grep: false,
      glob: false,
      list: false,
      patch: false,
      webfetch: false,
      todowrite: false,
      todoread: false,
      task: false,
      skill: false,
      question: false
    }
  };
  return JSON.stringify({ ...parsed, agent: agents });
}

export interface OpenCodeGenerationAdapterOptions {
  /** Defaults to `opencode`, resolved by the child process PATH. */
  readonly executable?: string;
  /** Backend descriptor supplied by the approved composition root. */
  readonly backend?: GenerationBackendRef;
  /** Reads the frozen snapshot bytes. */
  readonly readSource: BlobReadPort;
  /** Stores output bytes and returns the resulting `blob://` ref. */
  readonly writeOutput: BlobWritePort;
  /** Inherited when omitted; this lets the user's configured CLI provider work. */
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  readonly spawn?: SpawnPort;
  readonly maxSnapshotBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly killGraceMs?: number;
  /** Extra argv placed after `--format json` and before the prompt. */
  readonly extraArgs?: readonly string[];
}

interface Session {
  readonly handle_ref: string;
  readonly process: ChildProcessWithoutNullStreams;
  readonly idempotency_key: string;
  readonly output: number[];
  readonly diagnostics: number[];
  readonly started_at: number;
  poll: number;
  closed: boolean;
  exit_code: number | null;
  exit_signal: NodeJS.Signals | null;
  spawn_error: Error | null;
  cancel_requested: boolean;
  timed_out: boolean;
  overflow: boolean;
  deadline_timer: ReturnType<typeof setTimeout> | null;
  kill_timer: ReturnType<typeof setTimeout> | null;
  abort_cleanup: (() => void) | null;
}

function backendCapability(
  name: GenerationCapabilityBinding["name"],
  status: GenerationCapabilityBinding["status"] = "unknown"
): GenerationCapabilityBinding {
  return {
    name,
    capability_id: `cap:opencode.cli.${name.slice("generation.".length)}` as Id<"cap">,
    status,
    evidence_stage: status === "verified" ? "roundtrip" : "static",
    evidence_refs: []
  };
}

/** Builds a descriptor for the installed OpenCode CLI without claiming H evidence. */
export function createOpenCodeCliBackend(input: {
  readonly executable?: string;
  readonly backend_id?: string;
  readonly backend_version?: string;
  readonly network?: GenerationBackendRef["isolation"]["network"];
  readonly capability_status?: GenerationCapabilityBinding["status"];
  readonly approval_ref?: string;
  readonly verified_at?: number;
} = {}): GenerationBackendRef {
  const entryRef = input.executable ?? DEFAULT_EXECUTABLE;
  const status = input.capability_status ?? "unknown";
  const capabilities = {
    create: backendCapability("generation.create", status),
    auth: backendCapability("generation.auth", status),
    cancel: backendCapability("generation.cancel", status),
    recover: backendCapability("generation.recover", status),
    output: backendCapability("generation.output", status)
  };
  const capability_snapshot_hash = canonicalHash(
    toJsonValue({
      schema_version: "rsi.opencode_cli_capability_snapshot/1",
      executable: entryRef,
      capabilities
    })
  );
  const backend: GenerationBackendRef = {
    schema_version: "rsi.generation_backend_ref/1",
    backend_id: input.backend_id ?? "opencode.cli_spawn",
    backend_kind: "cli",
    entry_kind: "cli_spawn",
    entry_ref: entryRef,
    backend_version: input.backend_version ?? OPENCODE_HOST_VERSION,
    protocol_versions: ["cli_spawn/1", "opencode-run-json/1"],
    isolation: {
      mode: "process",
      network: input.network ?? "enabled",
      evidence_refs: []
    },
    capabilities,
    capability_snapshot_hash,
    approval_ref: input.approval_ref ?? "operator-configured"
  };
  if (input.verified_at !== undefined) backend.verified_at = input.verified_at;
  return backend;
}

function absoluteDeadlineRemaining(clock: Clock, deadline: number): number {
  if (!Number.isSafeInteger(deadline)) return 0;
  return Math.max(0, deadline - clock.utcNowMs());
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function jsonLinesValid(bytes: Uint8Array): boolean | "unknown" {
  if (bytes.byteLength === 0) return "unknown";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) JSON.parse(line);
    }
    return true;
  } catch {
    return false;
  }
}

export class OpenCodeCliGenerationAdapter {
  private readonly executable: string;
  private readonly backend: GenerationBackendRef;
  private readonly readSource: BlobReadPort;
  private readonly writeOutput: BlobWritePort;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly clock: Clock;
  private readonly spawnProcess: SpawnPort;
  private readonly maxSnapshotBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly killGraceMs: number;
  private readonly extraArgs: readonly string[];
  private readonly sessions = new Map<string, Session>();
  private readonly idempotency = new Map<string, string>();

  constructor(options: OpenCodeGenerationAdapterOptions) {
    this.executable = options.executable ?? options.backend?.entry_ref ?? DEFAULT_EXECUTABLE;
    this.backend = options.backend ?? createOpenCodeCliBackend({ executable: this.executable });
    this.readSource = options.readSource;
    this.writeOutput = options.writeOutput;
    this.env = options.env;
    this.clock = options.clock ?? systemClock;
    this.spawnProcess =
      options.spawn ??
      ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams);
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.extraArgs = Object.freeze([...(options.extraArgs ?? [])]);
  }

  async selectBackend(
    req: GenerationBackendSelectRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<AdapterBackendSelection>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", OPENCODE_DESCRIPTOR_REF));
    if (req.host_binding.host_id !== OPENCODE_HOST_ID) {
      return adapterOk({ state: "blocked_no_backend", reason: "no_approved_backend", missing: [], evidence_refs: [] });
    }
    if (!req.approved_backend_ids.includes(this.backend.backend_id)) {
      return adapterOk({ state: "blocked_no_backend", reason: "no_approved_backend", missing: [], evidence_refs: [] });
    }
    return adapterOk({
      state: "available",
      backend: this.backend,
      evidence_refs: this.backend.isolation.evidence_refs
    });
  }

  async create(
    req: GenerationCreateRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationCreateResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", req.snapshot_ref));
    const remaining = absoluteDeadlineRemaining(this.clock, req.deadline_ms);
    if (remaining < 1) return adapterErr(this.error("E_DEADLINE_EXCEEDED", req.snapshot_ref, true));
    if (req.backend.entry_kind !== "cli_spawn" || req.backend.backend_id !== this.backend.backend_id) {
      return adapterErr(this.error("E_CONFLICT", req.snapshot_ref));
    }
    if (!isAbsolute(req.workspace_ref)) return adapterErr(this.error("E_SCHEMA", req.snapshot_ref));

    const previous = this.idempotency.get(req.idempotency_key);
    if (previous !== undefined) {
      const existing = this.sessions.get(previous);
      if (existing !== undefined) {
        return adapterOk({
          state: "created",
          handle_ref: existing.handle_ref,
          host_session_ref: existing.handle_ref,
          started_at: existing.started_at,
          isolation_evidence_refs: [...this.backend.isolation.evidence_refs]
        });
      }
    }

    const snapshot = await this.readSource(req.snapshot_ref, { maxBytes: this.maxSnapshotBytes });
    if (!snapshot.ok) return adapterErr(this.error("E_EVIDENCE_UNKNOWN", req.snapshot_ref));
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", req.snapshot_ref));
    let snapshotText: string;
    try {
      snapshotText = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.value);
      JSON.parse(snapshotText);
    } catch {
      return adapterErr(this.error("E_SCHEMA", req.snapshot_ref));
    }

    const prompt = [
      "You are running an evoplug review generation.",
      "Use the following frozen review snapshot as the complete review context.",
      "Return the candidate output only; do not claim verification or delivery.",
      "<evoplug-review-snapshot>",
      snapshotText,
      "</evoplug-review-snapshot>"
    ].join("\n");
    const args = ["run", "--standalone", "--format", "json", "--agent", "evoplug-generation", ...this.extraArgs];
    const environment = {
      ...process.env,
      ...(this.env ?? {}),
      // Appendix J.3: the generation child runs a dedicated agent with every
      // tool disabled. Inline config documents merge with the user's file
      // config, so the user's provider/model selection still applies.
      OPENCODE_CONFIG_CONTENT: mergeGenerationConfig(process.env["OPENCODE_CONFIG_CONTENT"])
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.executable, args, {
        cwd: req.workspace_ref,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      return adapterErr(this.error("E_IO", req.snapshot_ref, true));
    }
    // 2.1.4 JSON-escapes a positional message; stdin preserves the prompt.
    if (child.stdin !== null && child.stdin !== undefined) {
      child.stdin.on("error", () => {
        // A host that exits immediately closes the pipe; the exit code wins.
      });
      child.stdin.end(prompt, "utf8");
    }

    const handle_ref = `opencode-run:${randomUUID()}`;
    const session: Session = {
      handle_ref,
      process: child,
      idempotency_key: req.idempotency_key,
      output: [],
      diagnostics: [],
      started_at: this.clock.utcNowMs(),
      poll: 0,
      closed: false,
      exit_code: null,
      exit_signal: null,
      spawn_error: null,
      cancel_requested: false,
      timed_out: false,
      overflow: false,
      deadline_timer: null,
      kill_timer: null,
      abort_cleanup: null
    };
    const append = (target: number[], chunk: Buffer, overflowOnTruncate: boolean): void => {
      const remainingBytes = this.maxBufferedBytes - target.length;
      if (remainingBytes <= 0) {
        if (overflowOnTruncate) session.overflow = true;
        return;
      }
      const bytes = new Uint8Array(chunk.subarray(0, remainingBytes));
      for (const byte of bytes) target.push(byte);
      if (overflowOnTruncate && bytes.byteLength < chunk.byteLength) session.overflow = true;
    };
    // Only stdout is candidate content. Host diagnostics stay off the output
    // ref so a warning line cannot break the strict generator protocol parse.
    child.stdout.on("data", (chunk: Buffer) => append(session.output, chunk, true));
    child.stderr.on("data", (chunk: Buffer) => append(session.diagnostics, chunk, false));
    child.once("error", (error) => {
      session.spawn_error = error instanceof Error ? error : new Error(String(error));
    });
    child.once("close", (code, signalName) => {
      session.closed = true;
      session.exit_code = code;
      session.exit_signal = signalName;
      if (session.deadline_timer !== null) clearTimeout(session.deadline_timer);
      if (session.kill_timer !== null) clearTimeout(session.kill_timer);
      session.abort_cleanup?.();
      session.abort_cleanup = null;
    });
    const terminate = (): void => {
      if (session.closed) return;
      session.timed_out = true;
      session.cancel_requested = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close event records the resulting unknown state.
      }
      session.kill_timer = setTimeout(() => {
        if (!session.closed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The close event remains the source of truth.
          }
        }
      }, this.killGraceMs);
    };
    session.deadline_timer = setTimeout(terminate, Math.max(1, remaining));
    const onAbort = (): void => terminate();
    signal.addEventListener("abort", onAbort, { once: true });
    session.abort_cleanup = () => signal.removeEventListener("abort", onAbort);
    this.sessions.set(handle_ref, session);
    this.idempotency.set(req.idempotency_key, handle_ref);

    return adapterOk({
      state: "created",
      handle_ref,
      host_session_ref: handle_ref,
      started_at: session.started_at,
      isolation_evidence_refs: [...this.backend.isolation.evidence_refs]
    });
  }

  async authenticate(
    req: GenerationAuthRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationAuthResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", OPENCODE_DESCRIPTOR_REF));
    const session = this.sessions.get(req.handle_ref);
    if (session === undefined) return adapterErr(this.error("E_CONFLICT", OPENCODE_DESCRIPTOR_REF));
    if (absoluteDeadlineRemaining(this.clock, req.deadline_ms) < 1) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", OPENCODE_DESCRIPTOR_REF, true));
    }
    if (session.spawn_error !== null) {
      return adapterOk({ state: "unavailable", mechanism: "cli_process_error", profile_ref: PROFILE_REF, evidence_refs: [] });
    }
    // Authentication stays inside OpenCode. Starting the CLI is the only safe
    // observation available here; provider failures remain real process output.
    return adapterOk({ state: "available", mechanism: "cli_inherited_auth", profile_ref: PROFILE_REF, evidence_refs: [] });
  }

  async readOutput(
    req: GenerationOutputRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationOutputResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", OPENCODE_DESCRIPTOR_REF));
    const session = this.sessions.get(req.handle_ref);
    if (session === undefined) return adapterErr(this.error("E_CONFLICT", OPENCODE_DESCRIPTOR_REF));
    if (absoluteDeadlineRemaining(this.clock, req.deadline_ms) < 1) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", OPENCODE_DESCRIPTOR_REF, true));
    }
    if (!Number.isSafeInteger(req.max_bytes) || req.max_bytes <= 0) {
      return adapterErr(this.error("E_SCHEMA", OPENCODE_DESCRIPTOR_REF));
    }
    const offset = parseCursor(req.cursor);
    if (offset === null || offset > session.output.length) {
      return adapterErr(this.error("E_SCHEMA", OPENCODE_DESCRIPTOR_REF));
    }
    if (!session.closed && session.output.length <= offset) {
      await waitForSessionProgress(session, offset, absoluteDeadlineRemaining(this.clock, req.deadline_ms), signal);
      if (signal.aborted) return adapterErr(this.error("E_CANCELLED", OPENCODE_DESCRIPTOR_REF));
    }
    const rawBytes = Uint8Array.from(session.output);
    // SourceRef is a non-empty half-open range. While the child has produced
    // no bytes yet, return a transient descriptor ref; the runner only reads
    // the ref from the terminal response, after output exists or the process
    // has failed.
    if (rawBytes.byteLength === 0) {
      if (!session.closed) {
        session.poll += 1;
        return adapterOk({
          state: "chunk",
          output_ref: OPENCODE_DESCRIPTOR_REF,
          schema_valid: "unknown",
          next_cursor: `0:${session.poll}`
        });
      }
      return adapterOk({ state: "failed", output_ref: OPENCODE_DESCRIPTOR_REF, schema_valid: "unknown" });
    }
    const closed = session.closed;
    const exitOk =
      session.exit_code === 0 && session.exit_signal === null && !session.cancel_requested;
    let emitted = rawBytes;
    let extractionFailed = false;
    if (closed && exitOk) {
      const decoded = decodeUtf8(rawBytes);
      const extracted = decoded === null ? null : extractJsonlText(decoded, OPENCODE_OUTPUT_EXTRACT);
      if (extracted === null || !extracted.ok) {
        // The host stream had no declared assistant text. Keep the raw bytes
        // for diagnostics but report failure instead of letting a downstream
        // strict parse treat the envelope as a candidate.
        extractionFailed = true;
      } else {
        emitted = new TextEncoder().encode(
          normalizeFinalNewline(extracted.text, OPENCODE_OUTPUT_NORMALIZATION)
        );
      }
    }
    const stored = await this.writeOutput(emitted);
    if (!stored.ok) return adapterErr(this.error("E_IO", OPENCODE_DESCRIPTOR_REF, true));
    if (!isSourceRef(stored.value)) return adapterErr(this.error("E_SCHEMA", OPENCODE_DESCRIPTOR_REF));
    const parsed = parseSourceRef(stored.value);
    if (!parsed.ok || parsed.value.scheme !== "blob" || parsed.value.locator !== hashBytes(emitted)) {
      return adapterErr(this.error("E_CONFLICT", stored.value));
    }
    const schemaValid = extractionFailed ? false : jsonLinesValid(emitted);
    if (rawBytes.byteLength > req.max_bytes || session.overflow) {
      return adapterOk({ state: "failed", output_ref: stored.value, schema_valid: schemaValid });
    }
    if (!closed) {
      session.poll += 1;
      return adapterOk({
        state: "chunk",
        output_ref: stored.value,
        schema_valid: jsonLinesValid(rawBytes),
        next_cursor: `${rawBytes.byteLength}:${session.poll}`
      });
    }
    return adapterOk({
      state: exitOk && !extractionFailed ? "complete" : "failed",
      output_ref: stored.value,
      schema_valid: schemaValid
    });
  }

  async cancel(
    req: GenerationCancelRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationCancelResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", OPENCODE_DESCRIPTOR_REF));
    const session = this.sessions.get(req.handle_ref);
    if (session === undefined) return adapterOk({ state: "unsupported", evidence_refs: [] });
    if (absoluteDeadlineRemaining(this.clock, req.deadline_ms) < 1) {
      return adapterErr(this.error("E_DEADLINE_EXCEEDED", OPENCODE_DESCRIPTOR_REF, true));
    }
    if (session.closed) return adapterOk({ state: "not_running", evidence_refs: [] });
    session.cancel_requested = true;
    try {
      if (!session.process.kill("SIGTERM")) return adapterOk({ state: "unknown", evidence_refs: [] });
    } catch {
      return adapterOk({ state: "unknown", evidence_refs: [] });
    }
    session.kill_timer = setTimeout(() => {
      if (!session.closed) {
        try {
          session.process.kill("SIGKILL");
        } catch {
          // close remains authoritative.
        }
      }
    }, this.killGraceMs);
    return adapterOk({ state: "cancelled", evidence_refs: [] });
  }

  async recover(
    _req: GenerationRecoverRequest,
    signal: AbortSignal
  ): Promise<HostAdapterResult<GenerationRecoverResult>> {
    if (signal.aborted) return adapterErr(this.error("E_CANCELLED", OPENCODE_DESCRIPTOR_REF));
    return adapterOk({ state: "not_recoverable", evidence_refs: [] });
  }

  private error(
    code: Parameters<typeof makeAdapterError>[0],
    detail_ref: SourceRef,
    retryable = false
  ) {
    return makeAdapterError(code, detail_ref, this.clock.utcNowMs(), retryable);
  }
}

function makeAdapterError(
  code: "E_DEADLINE_EXCEEDED" | "E_CAPABILITY" | "E_UNSUPPORTED" | "E_CONFLICT" | "E_HOST_REJECTED" | "E_AUTH_UNAVAILABLE" | "E_EVIDENCE_UNKNOWN" | "E_SCHEMA" | "E_IO" | "E_CANCELLED" | "E_INTERNAL",
  detail_ref: SourceRef,
  observed_at: number,
  retryable: boolean
) {
  return { code, retryable, detail_ref, observed_at } as const;
}

async function waitForSessionProgress(
  session: Session,
  offset: number,
  remainingMs: number,
  signal: AbortSignal
): Promise<void> {
  if (session.closed || session.output.length > offset || remainingMs <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(done, Math.max(1, remainingMs));
    const finish = (): void => {
      session.process.stdout.off("data", onData);
      session.process.stderr.off("data", onData);
      session.process.off("close", onClose);
      session.process.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    function done(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
      resolve();
    }
    function onData(): void {
      if (session.output.length > offset) done();
    }
    function onClose(): void {
      done();
    }
    function onError(): void {
      done();
    }
    function onAbort(): void {
      done();
    }
    session.process.stdout.on("data", onData);
    session.process.stderr.on("data", onData);
    session.process.once("close", onClose);
    session.process.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseCursor(value: string | undefined): number | null {
  if (value === undefined) return 0;
  const match = /^(\d+):\d+$/.exec(value);
  if (match === null) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : null;
}

export function createOpenCodeCliGenerationAdapter(
  options: OpenCodeGenerationAdapterOptions
): OpenCodeCliGenerationAdapter {
  return new OpenCodeCliGenerationAdapter(options);
}

/** The adapter's immutable identity used by composition and diagnostics. */
export const OPENCODE_GENERATION_BACKEND_ID = "opencode.cli_spawn";
export const OPENCODE_GENERATION_PROTOCOL = "cli_spawn/1";
export const OPENCODE_GENERATION_ADAPTER_ID: typeof OPENCODE_ADAPTER_ID = OPENCODE_ADAPTER_ID;
export const OPENCODE_GENERATION_ADAPTER_VERSION: typeof OPENCODE_ADAPTER_VERSION = OPENCODE_ADAPTER_VERSION;

/**
 * W9 declaration. Re-exported here so the composition root can read it from
 * the package root without a new subpath export or an `index.ts` change.
 */
export { OPENCODE_GENERATION_SPEC };
