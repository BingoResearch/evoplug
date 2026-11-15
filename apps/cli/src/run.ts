/**
 * `evolve` dispatch loop (DD-FND-101).
 *
 * Parses argv, handles `--help`/`--version`, then routes the matched command
 * to the local table or to the IPC client. Output is exactly one `rsi.cli/1`
 * object on stdout with `--json`; failures also write the bare ErrorEnvelope to
 * stderr. Exit codes come from `exit-codes.ts`; unsupported local commands are
 * forced to 3 as documented for unavailable features.
 */

import type { ErrorEnvelope, Result } from "@evoplug/core";
import { newId } from "@evoplug/core";
import { IpcClient } from "@evoplug/ipc";
import type { IpcRequestOptions } from "@evoplug/ipc";
import { parseCliArguments } from "./args.js";
import type { ParsedCommand } from "./args.js";
import { CLI_COMMANDS, isCommandPrefix } from "./commands.js";
import { cliFailure, cliSuccess, encodeResultValue, renderHuman } from "./result.js";
import type { CliJsonOutput } from "./result.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  exitCodeForFailure
} from "./exit-codes.js";
import { cliFieldError } from "./errors.js";
import {
  DEFAULT_CLI_IO,
  PRODUCT_VERSION,
  checkIdempotencyKey,
  cliInternalError,
  ensureInitialized,
  resolveCliHome
} from "./support.js";
import type { CliEnvironment, CliIo } from "./support.js";
import { buildIpcCommand } from "./ipc-commands.js";
import { runLocalCommand } from "./local-commands.js";
import type { LocalOutcome } from "./local-commands.js";

export interface RunCliOptions {
  readonly io?: CliIo;
  readonly env?: CliEnvironment;
}

function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function emitOutput(output: CliJsonOutput, json: boolean, io: CliIo): void {
  if (json) {
    io.stdout(`${JSON.stringify(output)}\n`);
    if (!output.ok) {
      io.stderr(`${JSON.stringify(output.error)}\n`);
    }
    return;
  }
  const text = `${renderHuman(output)}\n`;
  if (output.ok) {
    io.stdout(text);
  } else {
    io.stderr(text);
  }
}

function helpText(): string {
  const lines: string[] = [
    `evolve ${PRODUCT_VERSION}`,
    "",
    "Usage: evolve <command> [options]",
    "",
    "Commands:"
  ];
  for (const spec of CLI_COMMANDS) {
    lines.push(`  ${spec.path.join(" ").padEnd(30)} ${spec.summary}`);
  }
  lines.push(
    "",
    "Global options:",
    "  --home DIR              product home (default: $EVOPLUG_HOME or ~/.evoplug)",
    "  --json                  print one rsi.cli/1 result object",
    "  --idempotency-key KEY   retry key for mutating IPC commands",
    "  --help                  show this help",
    "  --version               show the product version"
  );
  return `${lines.join("\n")}\n`;
}

function helpJson(): CliJsonOutput {
  const commands = CLI_COMMANDS.map((spec) => ({
    command: spec.path.join(" "),
    summary: spec.summary
  }));
  return cliSuccess(
    "help",
    encodeResultValue({
      schema_version: "rsi.cli_help/1",
      product_version: PRODUCT_VERSION,
      usage: "evolve <command> [options]",
      commands
    })
  );
}

function versionJson(): CliJsonOutput {
  return cliSuccess(
    "version",
    encodeResultValue({
      schema_version: "rsi.cli_version/1",
      name: "evolve",
      product_version: PRODUCT_VERSION
    })
  );
}

/** `--help`/`-h`/`help` and `--version`/`-v`/`version` short-circuit with exit 0. */
function handleMeta(argv: readonly string[], io: CliIo): number | null {
  if (argv.length === 0) {
    return null;
  }
  const json = wantsJson(argv);
  const first = argv[0];
  if (argv.includes("--help") || argv.includes("-h") || first === "help") {
    if (json) {
      emitOutput(helpJson(), true, io);
    } else {
      io.stdout(helpText());
    }
    return EXIT_OK;
  }
  if (argv.includes("--version") || argv.includes("-v") || first === "version") {
    if (json) {
      emitOutput(versionJson(), true, io);
    } else {
      io.stdout(`evolve ${PRODUCT_VERSION}\n`);
    }
    return EXIT_OK;
  }
  return null;
}

/** Best-effort command label for a parse failure. */
function commandLabel(argv: readonly string[]): string {
  const path: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-") || !isCommandPrefix(path, token)) {
      break;
    }
    path.push(token);
  }
  if (path.length > 0) {
    return path.join(" ");
  }
  const first = argv[0];
  return first !== undefined && !first.startsWith("-") ? first : "";
}

/**
 * Envelope idempotency: `required` sends the key (generating one when the
 * command allows omission, e.g. `gc`), `in_params` sends none, and `forbidden`
 * rejects a supplied key before connecting.
 */
function envelopeIdempotency(parsed: ParsedCommand): Result<string | null, ErrorEnvelope> {
  const execution = parsed.spec.execution;
  if (execution.kind !== "ipc") {
    return { ok: true, status: "ok", value: null };
  }
  switch (execution.idempotency) {
    case "forbidden": {
      if (parsed.idempotency_key !== null) {
        return {
          ok: false,
          status: "rejected",
          error: cliFieldError("--idempotency-key", "forbidden_for_read_only_method")
        };
      }
      return { ok: true, status: "ok", value: null };
    }
    case "in_params": {
      const key = parsed.idempotency_key;
      if (key === null) {
        return {
          ok: false,
          status: "rejected",
          error: cliFieldError("--idempotency-key", "missing_required")
        };
      }
      const invalid = checkIdempotencyKey(key);
      if (invalid !== null) {
        return { ok: false, status: "rejected", error: invalid };
      }
      return { ok: true, status: "ok", value: null };
    }
    case "required": {
      const key = parsed.idempotency_key ?? newId("ipc");
      const invalid = checkIdempotencyKey(key);
      if (invalid !== null) {
        return { ok: false, status: "rejected", error: invalid };
      }
      return { ok: true, status: "ok", value: key };
    }
  }
}

function emitLocalOutcome(
  command: string,
  outcome: LocalOutcome,
  json: boolean,
  io: CliIo
): number {
  if (outcome.diagnostic !== undefined) {
    io.stderr(`evolve ${command}: ${outcome.diagnostic}\n`);
  }
  const output = outcome.value.ok
    ? cliSuccess(command, outcome.value.value)
    : cliFailure(command, outcome.value.error);
  emitOutput(output, json, io);
  return outcome.exit_code;
}

async function runIpcCommand(
  parsed: ParsedCommand,
  env: CliEnvironment,
  json: boolean,
  io: CliIo
): Promise<number> {
  const home = resolveCliHome(parsed.home, env);
  if (!home.ok) {
    emitOutput(cliFailure(parsed.command, home.error), json, io);
    return exitCodeForFailure(home.status, home.error);
  }
  const ready = await ensureInitialized(home.value);
  if (!ready.ok) {
    emitOutput(cliFailure(parsed.command, ready.error), json, io);
    return EXIT_UNAVAILABLE;
  }
  const idempotency = envelopeIdempotency(parsed);
  if (!idempotency.ok) {
    emitOutput(cliFailure(parsed.command, idempotency.error), json, io);
    return EXIT_USAGE;
  }
  const built = await buildIpcCommand(parsed);
  if (!built.ok) {
    emitOutput(cliFailure(parsed.command, built.error), json, io);
    return exitCodeForFailure(built.status, built.error);
  }

  const client = await IpcClient.connect({
    evoplug_home: home.value,
    client_id: newId("adp"),
    client_kind: "cli",
    product_version: PRODUCT_VERSION
  });
  if (!client.ok) {
    emitOutput(cliFailure(parsed.command, client.error), json, io);
    return exitCodeForFailure(client.status, client.error);
  }

  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const requestOptions: IpcRequestOptions = {
    signal: controller.signal,
    ...(idempotency.value === null ? {} : { idempotency_key: idempotency.value })
  };

  try {
    const result = await built.value.send(client.value, requestOptions);
    if (!result.ok) {
      emitOutput(cliFailure(parsed.command, result.error), json, io);
      return exitCodeForFailure(result.status, result.error);
    }
    emitOutput(cliSuccess(parsed.command, result.value), json, io);
    return EXIT_OK;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    client.value.close();
  }
}

/** Runs one CLI invocation and returns the documented exit code. */
export async function runCli(
  argv: readonly string[],
  options?: RunCliOptions
): Promise<number> {
  const io = options?.io ?? DEFAULT_CLI_IO;
  const env = options?.env ?? process.env;
  const json = wantsJson(argv);

  const meta = handleMeta(argv, io);
  if (meta !== null) {
    return meta;
  }

  const parsed = parseCliArguments(argv);
  if (!parsed.ok) {
    const command = commandLabel(argv);
    emitOutput(cliFailure(command, parsed.error), json, io);
    return exitCodeForFailure("rejected", parsed.error);
  }

  const command = parsed.value.command;
  try {
    if (parsed.value.spec.execution.kind === "local") {
      const outcome = await runLocalCommand(parsed.value, env);
      return emitLocalOutcome(command, outcome, json, io);
    }
    return await runIpcCommand(parsed.value, env, json, io);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown_error";
    const envelope = cliInternalError(`cli.unhandled:${name}`);
    emitOutput(cliFailure(command, envelope), json, io);
    io.stderr(`evolve ${command}: internal error\n`);
    return EXIT_FAILED;
  }
}
