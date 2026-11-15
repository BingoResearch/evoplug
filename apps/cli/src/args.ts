/**
 * `evolve` argument parser.
 *
 * The command path is matched against `CLI_COMMANDS`; unknown words are
 * `E_CLI_UNKNOWN_COMMAND` (exit 2). Options are `--name value`, `--name=value`,
 * or a bare boolean flag. `--json`, `--home` and `--idempotency-key` are
 * global; every other option must be declared by the matched command.
 */

import type { ErrorEnvelope } from "@evoplug/core";
import type { CliCommandSpec, CliOptionSpec } from "./commands.js";
import { commandByPath, isCommandPrefix } from "./commands.js";
import { cliFieldError, cliUnknownCommandError } from "./errors.js";

export type ParsedOptionValue = string | true;

export interface ParsedCommand {
  readonly spec: CliCommandSpec;
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, ParsedOptionValue>;
  readonly json: boolean;
  readonly home: string | null;
  readonly idempotency_key: string | null;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedCommand }
  | { readonly ok: false; readonly error: ErrorEnvelope };

function fieldError(path: string, rule: string): ErrorEnvelope {
  return cliFieldError(path, rule);
}

function unknownCommand(): ErrorEnvelope {
  return cliUnknownCommandError();
}

function optionSpec(spec: CliCommandSpec, name: string): CliOptionSpec | null {
  for (const option of spec.options) {
    if (option.name === name) {
      return option;
    }
  }
  return null;
}

function isGlobalOption(name: string): boolean {
  return name === "json" || name === "home" || name === "idempotency-key";
}

/** Splits `--name=value`, returning the bare name and an optional value. */
function splitOption(token: string): { readonly name: string; readonly value: string | null } {
  const body = token.slice(2);
  const equals = body.indexOf("=");
  if (equals < 0) {
    return { name: body, value: null };
  }
  return { name: body.slice(0, equals), value: body.slice(equals + 1) };
}

function validateOptionValue(option: CliOptionSpec, value: string): ErrorEnvelope | null {
  if (option.kind === "boolean") {
    return fieldError(`--${option.name}`, "boolean_takes_no_value");
  }
  if (value.length === 0) {
    return fieldError(`--${option.name}`, "empty_value");
  }
  if (option.kind === "integer") {
    if (!/^-?\d+$/.test(value)) {
      return fieldError(`--${option.name}`, "must_be_integer");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      return fieldError(`--${option.name}`, "must_be_safe_integer");
    }
    if (option.min !== undefined && parsed < option.min) {
      return fieldError(`--${option.name}`, `min_${String(option.min)}`);
    }
    if (option.max !== undefined && parsed > option.max) {
      return fieldError(`--${option.name}`, `max_${String(option.max)}`);
    }
  }
  if (option.enum_values !== undefined && !option.enum_values.includes(value)) {
    return fieldError(`--${option.name}`, "unknown_enum");
  }
  return null;
}

/** Parses `process.argv.slice(2)`-shaped input. */
export function parseCliArguments(argv: readonly string[]): ParseResult {
  if (argv.length === 0) {
    return { ok: false, error: unknownCommand() };
  }
  const path: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token.startsWith("-") || !isCommandPrefix(path, token)) {
      break;
    }
    path.push(token);
    index += 1;
    const next = argv[index];
    if (next === undefined || next.startsWith("-") || !isCommandPrefix(path, next)) {
      break;
    }
  }
  const spec = commandByPath(path);
  if (spec === null) {
    return { ok: false, error: unknownCommand() };
  }

  const options = new Map<string, ParsedOptionValue>();
  const positionals: string[] = [];
  let json = false;
  let home: string | null = null;
  let idempotencyKey: string | null = null;
  let positionalOnly = false;

  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) {
      continue;
    }
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith("--")) {
      const { name, value } = splitOption(token);
      if (name.length === 0) {
        return { ok: false, error: fieldError(token, "malformed_option") };
      }
      if (name === "json") {
        if (value !== null) {
          return { ok: false, error: fieldError("--json", "boolean_takes_no_value") };
        }
        json = true;
        continue;
      }
      const declared = optionSpec(spec, name) ?? (isGlobalOption(name) ? null : undefined);
      if (declared === undefined) {
        return { ok: false, error: fieldError(`--${name}`, "unknown_option") };
      }
      const effective: CliOptionSpec =
        declared ?? { name, kind: "string", required: false, value_name: "VALUE" };
      let raw: string | null = value;
      if (raw === null && effective.kind !== "boolean") {
        const next = argv[index];
        if (next === undefined) {
          return { ok: false, error: fieldError(`--${name}`, "missing_value") };
        }
        raw = next;
        index += 1;
      }
      if (effective.kind === "boolean") {
        if (raw !== null) {
          return { ok: false, error: fieldError(`--${name}`, "boolean_takes_no_value") };
        }
        options.set(name, true);
        continue;
      }
      if (raw === null) {
        return { ok: false, error: fieldError(`--${name}`, "missing_value") };
      }
      const invalid = validateOptionValue(effective, raw);
      if (invalid !== null) {
        return { ok: false, error: invalid };
      }
      if (options.has(name)) {
        return { ok: false, error: fieldError(`--${name}`, "duplicate_option") };
      }
      options.set(name, raw);
      if (name === "home") {
        home = raw;
      } else if (name === "idempotency-key") {
        idempotencyKey = raw;
      }
      continue;
    }
    if (!positionalOnly && token.startsWith("-") && token !== "-") {
      return { ok: false, error: fieldError(token, "unknown_option") };
    }
    positionals.push(token);
  }

  for (const option of spec.options) {
    if (!option.required) {
      continue;
    }
    if (!options.has(option.name)) {
      return { ok: false, error: fieldError(`--${option.name}`, "missing_required") };
    }
  }

  const requiredPositionals = spec.positionals.filter((entry) => entry.required).length;
  if (positionals.length < requiredPositionals) {
    const missing = spec.positionals[positionals.length];
    return {
      ok: false,
      error: fieldError(missing === undefined ? "<positional>" : missing.name, "missing_required")
    };
  }
  if (positionals.length > spec.positionals.length) {
    const extra = positionals[spec.positionals.length] ?? "<extra>";
    return { ok: false, error: fieldError(extra, "unexpected_positional") };
  }

  return {
    ok: true,
    value: {
      spec,
      command: spec.path.join(" "),
      positionals,
      options,
      json,
      home,
      idempotency_key: idempotencyKey
    }
  };
}

export function optionString(parsed: ParsedCommand, name: string): string | null {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : null;
}

export function optionInteger(parsed: ParsedCommand, name: string): number | null {
  const value = optionString(parsed, name);
  if (value === null) {
    return null;
  }
  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

export function optionFlag(parsed: ParsedCommand, name: string): boolean {
  return parsed.options.get(name) === true;
}
