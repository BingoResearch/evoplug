/**
 * Local (non-IPC) command execution (DD-FND-101).
 *
 * `doctor` and `configure --show` are read-only and can be completed from the
 * CLI boundary. Every other local command needs the storage, kernel, HOST or
 * REV packages, which `apps/cli` may not import (DD-FND-021). Those commands
 * are dispatched to `apps/kernel/dist/local-cli.js`, which owns the home
 * bootstrap, config writer, install manifest and structured capability
 * failures. The CLI only parses argv, spawns the bridge and re-wraps the
 * returned result in the `rsi.cli/1` envelope.
 */

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  ErrorDetails,
  ErrorEnvelope,
  JsonValue,
  Result
} from "@evoplug/core";
import {
  isErrorCategory,
  isErrorCode,
  isErrorSideEffect,
  isErrorStage,
  isFailureStatus,
  isId,
  makeErrorEnvelope,
  newId
} from "@evoplug/core";
import { IpcClient, readEndpointDescriptor } from "@evoplug/ipc";
import type { ParsedCommand } from "./args.js";
import { optionFlag } from "./args.js";
import type { CliEnvironment } from "./support.js";
import {
  HOME_DIR_MODE,
  HOME_FILE_MODE,
  PRODUCT_VERSION,
  cliHomeIncompatibleError,
  cliInternalError,
  cliUnsupportedCommandError,
  ensureInitialized,
  homePaths,
  resolveCliHome
} from "./support.js";
import { cliFieldError } from "./errors.js";
import { CLI_STATUS_AXES } from "./ipc-commands.js";
import {
  EXIT_CANCELLED,
  EXIT_DEGRADED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  exitCodeForFailure
} from "./exit-codes.js";
import { encodeResultValue } from "./result.js";

export interface LocalOutcome {
  readonly value: Result<JsonValue, ErrorEnvelope>;
  readonly exit_code: number;
  readonly diagnostic?: string;
}

type CheckStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

interface DoctorReport {
  readonly schema_version: "rsi.cli_doctor/1";
  readonly home: string;
  readonly status: CheckStatus;
  readonly checks: readonly DoctorCheck[];
}

type PathKind = "missing" | "file" | "directory" | "socket" | "symlink" | "other";

interface PathProbe {
  readonly kind: PathKind;
  readonly mode: number;
}

async function probePath(path: string): Promise<PathProbe> {
  try {
    const stats = await lstat(path);
    const mode = stats.mode & 0o777;
    if (stats.isSymbolicLink()) {
      return { kind: "symlink", mode };
    }
    if (stats.isDirectory()) {
      return { kind: "directory", mode };
    }
    if (stats.isSocket()) {
      return { kind: "socket", mode };
    }
    if (stats.isFile()) {
      return { kind: "file", mode };
    }
    return { kind: "other", mode };
  } catch {
    return { kind: "missing", mode: 0 };
  }
}

function failure(error: ErrorEnvelope, exitCode: number, diagnostic?: string): LocalOutcome {
  const base: LocalOutcome = {
    value: { ok: false, status: "rejected", error },
    exit_code: exitCode
  };
  return diagnostic === undefined ? base : { ...base, diagnostic };
}

function success(value: unknown): LocalOutcome {
  return {
    value: { ok: true, status: "ok", value: encodeResultValue(value) },
    exit_code: EXIT_OK
  };
}

function unsupported(handler: string): LocalOutcome {
  return {
    value: {
      ok: false,
      status: "rejected",
      error: cliUnsupportedCommandError(handler)
    },
    exit_code: EXIT_UNAVAILABLE,
    diagnostic: unsupportedMessage(handler)
  };
}

function unsupportedMessage(handler: string): string {
  switch (handler) {
    case "configure":
      return "configure is unavailable except for `evolve configure --show`, `--input FILE`, or `--jev-input FILE`: writing configuration requires the kernel local writer.";
    default:
      return "this command is not supported by the current CLI build.";
  }
}

/* ------------------------------------------------------------------ */
/* Kernel local command bridge (DD-FND-021, DD-FND-101)               */
/* ------------------------------------------------------------------ */

const LOCAL_CLI_REQUEST_SCHEMA: "rsi.local_cli_request/1" = "rsi.local_cli_request/1";
const LOCAL_CLI_RESULT_SCHEMA: "rsi.local_cli_result/1" = "rsi.local_cli_result/1";
const LOCAL_CLI_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CREDENTIAL_REF_BYTES = 4096;

type LocalCliOptionValue = string | true;

interface LocalCliRequest {
  readonly schema_version: "rsi.local_cli_request/1";
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, LocalCliOptionValue>>;
  readonly home: string;
  readonly json: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows the detail branches the kernel bridge can emit. */
function readErrorDetails(value: unknown): ErrorDetails | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value["kind"]) {
    case "none":
      return { kind: "none" };
    case "field": {
      const path = value["path"];
      const rule = value["rule"];
      if (typeof path === "string" && typeof rule === "string") {
        return { kind: "field", path, rule };
      }
      return null;
    }
    case "version": {
      const expected = value["expected"];
      const actual = value["actual"];
      if (typeof expected === "string" && typeof actual === "string") {
        return { kind: "version", expected, actual };
      }
      return null;
    }
    case "internal": {
      const incidentId = value["incident_id"];
      if (typeof incidentId === "string") {
        return { kind: "internal", incident_id: incidentId };
      }
      return null;
    }
    case "storage": {
      const operation = value["operation"];
      if (typeof operation !== "string") {
        return null;
      }
      const sqliteCode = value["sqlite_code"];
      return typeof sqliteCode === "string"
        ? { kind: "storage", operation, sqlite_code: sqliteCode }
        : { kind: "storage", operation };
    }
    default:
      return null;
  }
}

function readBridgeError(value: unknown): ErrorEnvelope | null {
  if (!isRecord(value) || value["schema_version"] !== "rsi.error/1") {
    return null;
  }
  const code = value["code"];
  const category = value["category"];
  const messageKey = value["message_key"];
  const stage = value["stage"];
  const retryable = value["retryable"];
  const sideEffect = value["side_effect"];
  const details = readErrorDetails(value["details"]);
  if (
    typeof code !== "string" ||
    !isErrorCode(code) ||
    typeof category !== "string" ||
    !isErrorCategory(category) ||
    typeof messageKey !== "string" ||
    messageKey.length === 0 ||
    typeof stage !== "string" ||
    !isErrorStage(stage) ||
    typeof retryable !== "boolean" ||
    typeof sideEffect !== "string" ||
    !isErrorSideEffect(sideEffect) ||
    details === null
  ) {
    return null;
  }
  const traceId = value["trace_id"];
  return makeErrorEnvelope({
    code,
    category,
    message_key: messageKey,
    stage,
    details,
    retryable,
    side_effect: sideEffect,
    ...(typeof traceId === "string" && isId(traceId, "ipc") ? { trace_id: traceId } : {})
  });
}

function readBridgeOutcome(value: unknown, stderr: string): LocalOutcome | null {
  if (!isRecord(value) || value["schema_version"] !== LOCAL_CLI_RESULT_SCHEMA) {
    return null;
  }
  const exitCode = value["exit_code"];
  if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) {
    return null;
  }
  if (value["ok"] === true) {
    return {
      value: { ok: true, status: "ok", value: encodeResultValue(value["value"] ?? null) },
      exit_code: exitCode
    };
  }
  if (value["ok"] !== false) {
    return null;
  }
  const status = value["status"];
  if (typeof status !== "string" || !isFailureStatus(status)) {
    return null;
  }
  const error = readBridgeError(value["error"]);
  if (error === null) {
    return null;
  }
  const diagnostic = value["diagnostic"];
  const text =
    typeof diagnostic === "string" && diagnostic.length > 0 ? diagnostic : stderr.trim();
  const outcome: LocalOutcome = { value: { ok: false, status, error }, exit_code: exitCode };
  return text.length === 0 ? outcome : { ...outcome, diagnostic: text };
}

function kernelBridgePath(env: CliEnvironment): string {
  const override = env["EVOPLUG_KERNEL_LOCAL_CLI"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return fileURLToPath(new URL("../../kernel/dist/local-cli.js", import.meta.url));
}

function kernelServePath(): string {
  return fileURLToPath(new URL("../../kernel/dist/main.js", import.meta.url));
}

function cancelledEnvelope(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CANCELLED",
    category: "deadline",
    message_key: "error.request.cancelled",
    stage: "request_control",
    details: { kind: "none" }
  });
}

/** Runs one command through the kernel bridge and re-wraps its JSON result. */
function spawnBridge(request: LocalCliRequest, bridgePath: string): Promise<LocalOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve(
        failure(
          cliInternalError("cli.local_bridge_spawn_failed"),
          EXIT_UNAVAILABLE,
          "the kernel local command bridge could not be started; build @evoplug/app-kernel first."
        )
      );
      return;
    }

    let settled = false;
    let overflow = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const onSigint = (): void => {
      child.kill("SIGINT");
    };
    const onSigterm = (): void => {
      child.kill("SIGTERM");
    };
    const removeSignals = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    const finish = (outcome: LocalOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignals();
      resolve(outcome);
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    child.stdout.on("data", (chunk: Buffer): void => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > LOCAL_CLI_MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer): void => {
      stderrBytes += chunk.length;
      if (stderrBytes <= LOCAL_CLI_MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
      }
    });
    child.once("error", (error: Error): void => {
      finish(
        failure(
          cliInternalError(`cli.local_bridge_error:${error.name}`),
          EXIT_UNAVAILABLE,
          "the kernel local command bridge could not be started; build @evoplug/app-kernel first."
        )
      );
    });
    child.once("close", (code: number | null): void => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (overflow) {
        finish(
          failure(
            cliInternalError("cli.local_bridge_output_overflow"),
            EXIT_FAILED,
            "the kernel local command bridge produced an oversized response."
          )
        );
        return;
      }
      const text = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (text.length === 0) {
        finish(
          failure(
            cliInternalError(`cli.local_bridge_no_output:${code === null ? "signal" : String(code)}`),
            code === null ? EXIT_FAILED : EXIT_UNAVAILABLE,
            stderr.trim()
          )
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const outcome = readBridgeOutcome(parsed, stderr);
      finish(outcome ?? failure(cliInternalError("cli.local_bridge_invalid_result"), EXIT_FAILED, stderr.trim()));
    });

    if (child.stdin === null) {
      finish(failure(cliInternalError("cli.local_bridge_stdin_unavailable"), EXIT_UNAVAILABLE));
      return;
    }
    child.stdin.on("error", (): void => {
      // the bridge may exit before reading; the close handler reports the outcome
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * Reads the `configure --credential-stdin` value. It is an external secret
 * reference, not the secret: stdout, stderr and logs never receive it, and it
 * is forwarded to the kernel bridge only inside the internal request.
 */
async function readCredentialRefFromStdin(): Promise<Result<string, ErrorEnvelope>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += buffer.length;
      if (bytes > MAX_CREDENTIAL_REF_BYTES) {
        return {
          ok: false,
          status: "rejected",
          error: cliFieldError("--credential-stdin", "secret_ref_too_long")
        };
      }
      chunks.push(buffer);
    }
  } catch {
    return {
      ok: false,
      status: "rejected",
      error: cliFieldError("--credential-stdin", "stdin_unreadable")
    };
  }
  const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  if (text.length === 0) {
    return {
      ok: false,
      status: "rejected",
      error: cliFieldError("--credential-stdin", "empty_secret_ref")
    };
  }
  if (/[\r\n]/u.test(text)) {
    return {
      ok: false,
      status: "rejected",
      error: cliFieldError("--credential-stdin", "single_secret_ref_required")
    };
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return {
        ok: false,
        status: "rejected",
        error: cliFieldError("--credential-stdin", "control_character")
      };
    }
  }
  return { ok: true, status: "ok", value: text };
}

async function runBridgeCommand(parsed: ParsedCommand, env: CliEnvironment): Promise<LocalOutcome> {
  const home = resolveCliHome(parsed.home, env);
  if (!home.ok) {
    return failure(home.error, exitCodeForFailure(home.status, home.error));
  }
  const options: Record<string, LocalCliOptionValue> = {};
  for (const [key, value] of parsed.options) {
    options[key] = value;
  }
  if (
    parsed.spec.id === "configure" &&
    optionFlag(parsed, "credential-stdin") &&
    !optionFlag(parsed, "show")
  ) {
    const secretRef = await readCredentialRefFromStdin();
    if (!secretRef.ok) {
      return failure(secretRef.error, EXIT_USAGE);
    }
    options["credential-stdin"] = secretRef.value;
  }
  const request: LocalCliRequest = {
    schema_version: LOCAL_CLI_REQUEST_SCHEMA,
    command: parsed.spec.id,
    positionals: parsed.positionals,
    options,
    home: home.value,
    json: parsed.json
  };
  return spawnBridge(request, kernelBridgePath(env));
}

/** `serve` execs the kernel process entrypoint; there is no CLI stdout body. */
async function runServeLocal(parsed: ParsedCommand, env: CliEnvironment): Promise<LocalOutcome> {
  const home = resolveCliHome(parsed.home, env);
  if (!home.ok) {
    return failure(home.error, exitCodeForFailure(home.status, home.error));
  }
  const argv = [kernelServePath(), "serve", "--home", home.value];
  if (optionFlag(parsed, "foreground")) {
    argv.push("--foreground");
  }
  for (const name of ["generation-binding-key", "generation-executable"]) {
    const value = parsed.options.get(name);
    if (typeof value === "string") argv.push(`--${name}`, value);
  }
  const credentialEnv = parsed.options.get("jev-credential-env");
  if (typeof credentialEnv === "string") {
    argv.push("--jev-credential-env", credentialEnv);
  }
  const credentialRef = parsed.options.get("jev-credential-ref");
  if (typeof credentialRef === "string") {
    argv.push("--jev-credential-ref", credentialRef);
  }
  const allowedHosts = parsed.options.get("jev-allowed-hosts");
  if (typeof allowedHosts === "string") {
    for (const host of allowedHosts.split(",").map((value) => value.trim()).filter((value) => value.length > 0)) {
      argv.push("--jev-allowed-host", host);
    }
  }
  for (const name of ["config-reload-host", "config-reload-executable", "config-reload-workspace"]) {
    const value = parsed.options.get(name);
    if (typeof value === "string") argv.push(`--${name}`, value);
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, argv, { stdio: "inherit" });
    } catch {
      resolve(
        failure(
          cliInternalError("cli.kernel_serve_spawn_failed"),
          EXIT_UNAVAILABLE,
          "the kernel entrypoint could not be started; build @evoplug/app-kernel first."
        )
      );
      return;
    }
    const onSigint = (): void => {
      child.kill("SIGINT");
    };
    const onSigterm = (): void => {
      child.kill("SIGTERM");
    };
    const removeSignals = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", (error: Error): void => {
      removeSignals();
      resolve(failure(cliInternalError(`cli.kernel_serve_error:${error.name}`), EXIT_UNAVAILABLE));
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null): void => {
      removeSignals();
      const exitCode =
        code ?? (signal === "SIGINT" ? EXIT_CANCELLED : EXIT_FAILED);
      if (exitCode === EXIT_OK) {
        resolve(success({ status: "stopped" }));
        return;
      }
      if (exitCode === EXIT_CANCELLED) {
        resolve(failure(cancelledEnvelope(), EXIT_CANCELLED));
        return;
      }
      resolve(
        failure(
          cliInternalError(`cli.kernel_serve_exit:${String(exitCode)}`),
          exitCode
        )
      );
    });
  });
}

async function resolveReadyHome(
  parsed: ParsedCommand,
  env: CliEnvironment
): Promise<Result<string, ErrorEnvelope>> {
  const home = resolveCliHome(parsed.home, env);
  if (!home.ok) {
    return home;
  }
  const ready = await ensureInitialized(home.value);
  if (!ready.ok) {
    return ready;
  }
  return home;
}

async function runDoctor(parsed: ParsedCommand, env: CliEnvironment): Promise<LocalOutcome> {
  const home = await resolveReadyHome(parsed, env);
  if (!home.ok) {
    return failure(home.error, exitCodeForFailure(home.status, home.error));
  }
  const paths = homePaths(home.value);
  const checks: DoctorCheck[] = [];

  const homeProbe = await probePath(home.value);
  const homeOk = homeProbe.kind === "directory" && homeProbe.mode === HOME_DIR_MODE;
  checks.push({
    name: "home",
    status: homeOk ? "ok" : "fail",
    detail: homeOk
      ? "directory mode 0700"
      : `expected directory mode 0700, got ${homeProbe.kind} mode ${homeProbe.mode.toString(8)}`
  });

  checks.push(await probeFile(paths.init_complete_path, "init.complete.json", "file", HOME_FILE_MODE, false));
  checks.push(await probeJsonFile(paths.config_path, "config.json"));
  checks.push(
    await probeFile(paths.runtime_dir, "runtime", "directory", HOME_DIR_MODE, false)
  );
  checks.push(
    await probeFile(paths.socket_path, "kernel.sock", "socket", HOME_FILE_MODE, true)
  );
  checks.push(
    await probeFile(paths.token_path, "ipc.token", "file", HOME_FILE_MODE, true)
  );
  checks.push(await probeEndpoint(paths.endpoint_path));
  checks.push(await probeKernel(home.value, paths.endpoint_path, paths.token_path));

  const failed = checks.some((check) => check.status === "fail");
  const degraded = checks.some((check) => check.status === "warn");
  const report: DoctorReport = {
    schema_version: "rsi.cli_doctor/1",
    home: home.value,
    status: failed ? "fail" : degraded ? "warn" : "ok",
    checks
  };
  return {
    value: { ok: true, status: "ok", value: encodeResultValue(report) },
    exit_code: failed ? EXIT_FAILED : degraded ? EXIT_DEGRADED : EXIT_OK
  };
}

async function probeFile(
  path: string,
  name: string,
  expectedKind: PathKind,
  expectedMode: number,
  missingIsWarn: boolean
): Promise<DoctorCheck> {
  const probe = await probePath(path);
  if (probe.kind === "missing") {
    return { name, status: missingIsWarn ? "warn" : "fail", detail: "missing" };
  }
  if (probe.kind !== expectedKind) {
    return { name, status: "fail", detail: `expected ${expectedKind}, got ${probe.kind}` };
  }
  if (probe.mode !== expectedMode) {
    return {
      name,
      status: "fail",
      detail: `expected mode ${expectedMode.toString(8)}, got ${probe.mode.toString(8)}`
    };
  }
  return { name, status: "ok", detail: `${expectedKind} mode ${expectedMode.toString(8)}` };
}

async function probeJsonFile(path: string, name: string): Promise<DoctorCheck> {
  const base = await probeFile(path, name, "file", HOME_FILE_MODE, false);
  if (base.status !== "ok") {
    return base;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { name, status: "fail", detail: "must be a JSON object" };
    }
    return { name, status: "ok", detail: "JSON object, mode 0600" };
  } catch {
    return { name, status: "fail", detail: "invalid JSON" };
  }
}

async function probeEndpoint(path: string): Promise<DoctorCheck> {
  const probe = await probePath(path);
  if (probe.kind === "missing") {
    return { name: "endpoint.json", status: "warn", detail: "missing; kernel not running" };
  }
  if (probe.kind !== "file" || probe.mode !== HOME_FILE_MODE) {
    return { name: "endpoint.json", status: "fail", detail: "expected file mode 0600" };
  }
  const descriptor = await readEndpointDescriptor(path);
  if (!descriptor.ok) {
    return { name: "endpoint.json", status: "fail", detail: descriptor.reason };
  }
  return { name: "endpoint.json", status: "ok", detail: "descriptor present" };
}

/** Read-only `status.get` probe; no token or path is printed. */
async function probeKernel(
  home: string,
  endpointPath: string,
  tokenPath: string
): Promise<DoctorCheck> {
  const endpoint = await probePath(endpointPath);
  const token = await probePath(tokenPath);
  if (endpoint.kind === "missing" || token.kind === "missing") {
    return { name: "kernel", status: "warn", detail: "not running (no runtime endpoint)" };
  }
  const client = await IpcClient.connect({
    evoplug_home: home,
    client_id: newId("adp"),
    client_kind: "cli",
    product_version: PRODUCT_VERSION,
    connect_timeout_ms: 1000
  });
  if (!client.ok) {
    return { name: "kernel", status: "warn", detail: `unreachable: ${client.error.code}` };
  }
  try {
    const status = await client.value.request(
      "status.get",
      { include: [...CLI_STATUS_AXES] },
      { deadline_ms: 5000 }
    );
    if (!status.ok) {
      return { name: "kernel", status: "warn", detail: `status.get failed: ${status.error.code}` };
    }
    return {
      name: "kernel",
      status: status.value.status === "ready" ? "ok" : "warn",
      detail: `status.get: ${status.value.status}`
    };
  } finally {
    client.value.close();
  }
}

async function runConfigure(parsed: ParsedCommand, env: CliEnvironment): Promise<LocalOutcome> {
  if (!optionFlag(parsed, "show")) {
    return runBridgeCommand(parsed, env);
  }
  if (parsed.options.has("input") || optionFlag(parsed, "credential-stdin")) {
    return runBridgeCommand(parsed, env);
  }
  const home = await resolveReadyHome(parsed, env);
  if (!home.ok) {
    return failure(home.error, exitCodeForFailure(home.status, home.error));
  }
  try {
    const text = await readFile(homePaths(home.value).config_path, "utf8");
    const parsedConfig: unknown = JSON.parse(text);
    return success(parsedConfig);
  } catch {
    return failure(cliHomeIncompatibleError("unreadable_config"), EXIT_UNAVAILABLE);
  }
}

/** Dispatches one local command. */
export async function runLocalCommand(
  parsed: ParsedCommand,
  env: CliEnvironment
): Promise<LocalOutcome> {
  const execution = parsed.spec.execution;
  if (execution.kind !== "local") {
    return failure(cliUnsupportedCommandError(parsed.spec.id), EXIT_UNAVAILABLE);
  }
  switch (execution.handler) {
    case "doctor":
      return runDoctor(parsed, env);
    case "configure":
      return runConfigure(parsed, env);
    case "serve":
      return runServeLocal(parsed, env);
    case "init":
    case "install":
    case "uninstall":
    case "attach":
    case "detach":
    case "review":
    case "skills.diff":
    case "skills.revoke":
    case "skills.resolve":
    case "export":
    case "import":
      return runBridgeCommand(parsed, env);
    default:
      return unsupported(execution.handler);
  }
}
