#!/usr/bin/env node
// Development test dispatcher for evoplug (DD-FND-022).
//
//   node tools/test-cli/cli.mjs test --suite <suite> [-- <vitest flags>]
//
// This CLI is the only route to Vitest. It locates node_modules/.bin/vitest
// with the Node.js standard library, checks the bootstrap prerequisites and
// returns the documented exit codes. It never starts the kernel, creates a
// database or reads real harness configuration.
//
// Exit codes:
//   0    tests passed
//   1    tests failed
//   2    invalid argument or suite
//   3    missing prerequisite
//   128+N child terminated by signal N
//
// The suite enum is closed: TCLI-01..TCLI-07. `integration:s` is not a suite
// and every argument after `--` must be unable to change the test selection.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

export const EXIT_CODES = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  prerequisite: 3
});

export const TEST_CLI_ERRORS = Object.freeze({
  unknownCommand: "E_CLI_UNKNOWN_COMMAND",
  argument: "E_TESTCLI_ARGUMENT",
  prerequisite: "E_TESTCLI_PREREQUISITE"
});

/** @typedef {{ id: string, suite: string, projects: string[], filters: string[], hostSelection: boolean, requiresBuild: boolean }} SuiteDispatch */

/** @type {ReadonlyArray<SuiteDispatch>} */
export const SUITE_DISPATCH = Object.freeze([
  Object.freeze({ id: "TCLI-01", suite: "unit", projects: ["unit"], filters: [], hostSelection: false, requiresBuild: false }),
  Object.freeze({ id: "TCLI-02", suite: "functional", projects: ["functional"], filters: [], hostSelection: false, requiresBuild: false }),
  Object.freeze({ id: "TCLI-03", suite: "integration", projects: ["integration"], filters: [], hostSelection: false, requiresBuild: true }),
  Object.freeze({ id: "TCLI-04", suite: "fault", projects: ["fault"], filters: [], hostSelection: false, requiresBuild: false }),
  Object.freeze({
    id: "TCLI-05",
    suite: "contract:s",
    projects: ["integration"],
    filters: ["tests/integration/contracts/legacy"],
    hostSelection: false,
    requiresBuild: true
  }),
  Object.freeze({
    id: "TCLI-06",
    suite: "h",
    projects: ["integration"],
    filters: ["tests/integration/host"],
    hostSelection: true,
    requiresBuild: true
  }),
  Object.freeze({
    id: "TCLI-07",
    suite: "all",
    projects: ["unit", "functional", "integration", "fault"],
    filters: [],
    hostSelection: false,
    requiresBuild: true
  })
]);

const SUITE_BY_NAME = new Map(SUITE_DISPATCH.map((entry) => [entry.suite, entry]));

export class TestCliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "TestCliError";
    this.code = code;
    this.exitCode = EXIT_CODES.usage;
  }
}

/**
 * @param {string} name
 * @returns {SuiteDispatch | null}
 */
export function resolveSuite(name) {
  return SUITE_BY_NAME.get(name) ?? null;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new TestCliError(TEST_CLI_ERRORS.argument, `${flag} requires a value`);
  }
  return value;
}

/**
 * Parse the arguments that follow the `test` subcommand.
 *
 * @param {string[]} argv
 * @returns {{ descriptor: SuiteDispatch, plan: string | null, allowlist: string | null, passthrough: string[] }}
 */
export function parseArguments(argv) {
  let suite = null;
  let plan = null;
  let allowlist = null;
  let passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (arg === "--suite") {
      suite = takeValue(argv, index, "--suite");
      index += 1;
    } else if (arg.startsWith("--suite=")) {
      suite = arg.slice("--suite=".length);
    } else if (arg === "--plan") {
      plan = takeValue(argv, index, "--plan");
      index += 1;
    } else if (arg.startsWith("--plan=")) {
      plan = arg.slice("--plan=".length);
    } else if (arg === "--allowlist") {
      allowlist = takeValue(argv, index, "--allowlist");
      index += 1;
    } else if (arg.startsWith("--allowlist=")) {
      allowlist = arg.slice("--allowlist=".length);
    } else {
      throw new TestCliError(TEST_CLI_ERRORS.argument, `unknown argument: ${arg}`);
    }
  }
  if (suite === null) {
    throw new TestCliError(TEST_CLI_ERRORS.argument, "--suite <suite> is required");
  }
  const descriptor = resolveSuite(suite);
  if (descriptor === null) {
    throw new TestCliError(TEST_CLI_ERRORS.argument, `unknown suite: ${suite}`);
  }
  if (descriptor.hostSelection) {
    if (plan !== null && allowlist !== null) {
      throw new TestCliError(TEST_CLI_ERRORS.argument, "--plan and --allowlist are mutually exclusive");
    }
    if (plan === null && allowlist === null) {
      throw new TestCliError(TEST_CLI_ERRORS.argument, "suite h requires --plan FILE or --allowlist FILE");
    }
  } else if (plan !== null || allowlist !== null) {
    throw new TestCliError(TEST_CLI_ERRORS.argument, "--plan and --allowlist are only valid for suite h");
  }
  const checked = validatePassthrough(passthrough);
  return { descriptor, plan, allowlist, passthrough: checked };
}

/**
 * Only reporting and failure-policy flags may follow `--`. Positional filters
 * and every flag that can widen or redirect the selection are rejected.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function validatePassthrough(argv) {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reporter") {
      const value = takeValue(argv, index, "--reporter");
      output.push("--reporter", value);
      index += 1;
    } else if (arg.startsWith("--reporter=")) {
      const value = arg.slice("--reporter=".length);
      if (value === "") {
        throw new TestCliError(TEST_CLI_ERRORS.argument, "--reporter requires a value");
      }
      output.push(arg);
    } else if (arg === "--bail") {
      const value = takeValue(argv, index, "--bail");
      if (!/^\d+$/.test(value)) {
        throw new TestCliError(TEST_CLI_ERRORS.argument, "--bail requires a non-negative integer");
      }
      output.push("--bail", value);
      index += 1;
    } else if (arg.startsWith("--bail=")) {
      const value = arg.slice("--bail=".length);
      if (!/^\d+$/.test(value)) {
        throw new TestCliError(TEST_CLI_ERRORS.argument, "--bail requires a non-negative integer");
      }
      output.push(arg);
    } else if (arg === "--silent") {
      output.push(arg);
    } else if (arg.startsWith("--silent=")) {
      const value = arg.slice("--silent=".length);
      if (value === "") {
        throw new TestCliError(TEST_CLI_ERRORS.argument, "--silent requires a value when = is used");
      }
      output.push(arg);
    } else if (arg.startsWith("-")) {
      throw new TestCliError(
        TEST_CLI_ERRORS.argument,
        `option ${arg} is not allowed after --; only --reporter, --bail and --silent are accepted`
      );
    } else {
      throw new TestCliError(
        TEST_CLI_ERRORS.argument,
        `positional argument ${arg} is not allowed after --; the suite alone selects the test set`
      );
    }
  }
  return output;
}

/**
 * Build the Vitest argument vector that implements a dispatch row.
 *
 * @param {SuiteDispatch} descriptor
 * @param {string[]} extraFilters explicit host case filters
 * @param {string[]} passthrough validated reporting flags
 * @returns {string[]}
 */
export function buildVitestArgs(descriptor, extraFilters, passthrough) {
  const args = ["run"];
  for (const project of descriptor.projects) {
    args.push("--project", project);
  }
  if (descriptor.hostSelection) {
    // Real-host suites launch independent CLI/kernel/provider processes. Keep
    // them sequential so one host's process startup and filesystem activity
    // cannot distort another host's timing or shared OS resources.
    args.push("--maxWorkers", "1");
  }
  args.push(...(descriptor.hostSelection ? extraFilters : descriptor.filters), ...passthrough);
  return args;
}

/**
 * Map a child process result onto the documented exit codes.
 *
 * @param {number | null} code
 * @param {number | null} signalNumber
 * @returns {number}
 */
export function childExitCode(code, signalNumber) {
  if (signalNumber !== null && signalNumber !== undefined) {
    return 128 + signalNumber;
  }
  if (code === 0) {
    return EXIT_CODES.ok;
  }
  return EXIT_CODES.failed;
}

const USAGE = `Usage: node tools/test-cli/cli.mjs test --suite <suite> [options] [-- <vitest flags>]

Suites (closed enum):
  TCLI-01  unit         vitest project unit
  TCLI-02  functional   vitest project functional
  TCLI-03  integration  vitest project integration
  TCLI-04  fault        vitest project fault
  TCLI-05  contract:s   project integration, filtered to tests/integration/contracts/legacy
  TCLI-06  h            project integration, filtered to tests/integration/host (needs --plan or --allowlist)
  TCLI-07  all          unit, functional, integration and fault

Options:
  --suite SUITE        suite name from the table above (required)
  --plan FILE          explicit host plan for suite h
  --allowlist FILE     explicit host case allowlist for suite h
  --root DIR           workspace root (default: repository root)
  --help               show this message

After -- only --reporter, --bail and --silent are accepted.
Exit codes: 0 passed, 1 failed, 2 invalid arguments, 3 missing prerequisite, 128+N signal.
`;

const PREREQUISITES = Object.freeze([
  { path: "node_modules/vitest", hint: "pnpm install:locked" },
  { path: "node_modules/.bin/vitest", hint: "pnpm install:locked" },
  { path: "packages/core/src/generated/ids.ts", hint: "pnpm bootstrap" },
  { path: "packages/core/src/generated/host-vocabulary.ts", hint: "pnpm bootstrap" }
]);

const BUILD_PREREQUISITE = Object.freeze({
  path: "apps/cli/dist/main.js",
  hint: "pnpm build"
});

function printUsage(stream) {
  stream.write(USAGE);
}

function parseRootArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new TestCliError(TEST_CLI_ERRORS.argument, "--root requires a directory");
      }
      return resolve(value);
    }
    if (arg.startsWith("--root=")) {
      return resolve(arg.slice("--root=".length));
    }
    if (arg === "--") {
      break;
    }
  }
  return DEFAULT_ROOT;
}

function stripRootArgs(argv) {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      continue;
    }
    if (arg === "--") {
      output.push(arg, ...argv.slice(index + 1));
      break;
    }
    output.push(arg);
  }
  return output;
}

function missingPrerequisites(rootDir, descriptor) {
  const required = [...PREREQUISITES];
  if (descriptor.requiresBuild) {
    required.push(BUILD_PREREQUISITE);
  }
  const missing = [];
  for (const item of required) {
    const absolute = join(rootDir, item.path);
    if (!existsSync(absolute) || (item.path === "node_modules/vitest" && !statSync(absolute).isDirectory())) {
      missing.push(item);
    }
  }
  return missing;
}

function extractHostEntries(document) {
  if (Array.isArray(document)) {
    return document;
  }
  if (typeof document !== "object" || document === null) {
    return null;
  }
  if ("suite" in document && document.suite !== "h") {
    return null;
  }
  for (const key of ["cases", "allowlist", "paths"]) {
    if (Array.isArray(document[key])) {
      return document[key];
    }
  }
  return null;
}

/**
 * Load an explicit host plan or allowlist and normalise it to workspace
 * relative test paths under tests/integration/host/.
 *
 * @param {string} rootDir
 * @param {string} filePath
 * @returns {string[]}
 */
export function loadHostSelection(rootDir, filePath) {
  const absolute = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  if (!existsSync(absolute)) {
    throw new TestCliError(TEST_CLI_ERRORS.argument, `host selection file not found: ${absolute}`);
  }
  let document;
  try {
    document = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new TestCliError(
      TEST_CLI_ERRORS.argument,
      `cannot parse ${absolute}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const entries = extractHostEntries(document);
  if (entries === null || entries.length === 0) {
    throw new TestCliError(
      TEST_CLI_ERRORS.argument,
      `${absolute} must contain a non-empty cases, allowlist or paths array`
    );
  }
  const hostRoot = resolve(rootDir, "tests", "integration", "host");
  const selected = [];
  for (const entry of entries) {
    let value;
    if (typeof entry === "string") {
      value = entry;
    } else if (typeof entry === "object" && entry !== null && typeof entry.path === "string") {
      value = entry.path;
    } else {
      throw new TestCliError(TEST_CLI_ERRORS.argument, `${absolute} contains an entry without a path string`);
    }
    const candidate = value.replace(/\\/g, "/").startsWith("tests/")
      ? resolve(rootDir, value)
      : resolve(hostRoot, value.replace(/^\.\//, ""));
    if (!(candidate === hostRoot || candidate.startsWith(hostRoot + sep))) {
      throw new TestCliError(
        TEST_CLI_ERRORS.argument,
        `host selection entry ${value} is outside tests/integration/host/`
      );
    }
    if (/[*?{}\[\]\\]/.test(value) || !existsSync(candidate) || !statSync(candidate).isFile() || !candidate.endsWith(".test.ts")) {
      throw new TestCliError(TEST_CLI_ERRORS.argument, `host selection entry ${value} must name an existing .test.ts file`);
    }
    const realHostRoot = realpathSync(hostRoot);
    if (!realpathSync(candidate).startsWith(realHostRoot + sep)) {
      throw new TestCliError(TEST_CLI_ERRORS.argument, `host selection entry ${value} resolves outside tests/integration/host/`);
    }
    const relativePath = relative(rootDir, candidate).split(sep).join("/");
    if (!selected.includes(relativePath)) {
      selected.push(relativePath);
    }
  }
  return selected;
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {string} rootDir
 * @param {string[] | null} hostSelection
 * @returns {Promise<{ code: number | null, signal: string | null, error: Error | null }>}
 */
function runVitest(bin, args, rootDir, hostSelection) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };
    const env = { ...process.env };
    delete env.EVOPLUG_H_SELECTION;
    if (hostSelection !== null) env.EVOPLUG_H_SELECTION = JSON.stringify(hostSelection);
    // contract:s reuses the integration project; the legacy contract modules
    // are already part of the S suites, so they only self-register when this
    // explicit suite selects the legacy contracts directory.
    delete env.EVOPLUG_CONTRACT_S;
    if (args.includes("tests/integration/contracts/legacy")) env.EVOPLUG_CONTRACT_S = "1";
    const child = spawn(bin, args, { cwd: rootDir, stdio: "inherit", env });
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // The child may already be gone.
      }
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, () => forward(signal));
    }
    child.once("error", (error) => settle({ code: null, signal: null, error }));
    child.once("close", (code, signal) => settle({ code, signal, error: null }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage(process.stderr);
    process.stderr.write(`${TEST_CLI_ERRORS.argument}: missing subcommand; expected "test"\n`);
    return EXIT_CODES.usage;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    printUsage(process.stdout);
    return EXIT_CODES.ok;
  }
  if (argv[0] !== "test") {
    process.stderr.write(`${TEST_CLI_ERRORS.unknownCommand}: unknown command "${argv[0]}"\n`);
    printUsage(process.stderr);
    return EXIT_CODES.usage;
  }

  const rest = argv.slice(1);
  let rootDir;
  let parsed;
  try {
    rootDir = parseRootArg(rest);
    const withoutRoot = stripRootArgs(rest);
    if (withoutRoot[0] === "--help" || withoutRoot[0] === "-h") {
      printUsage(process.stdout);
      return EXIT_CODES.ok;
    }
    parsed = parseArguments(withoutRoot);
  } catch (error) {
    if (error instanceof TestCliError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return EXIT_CODES.usage;
    }
    throw error;
  }

  const { descriptor, plan, allowlist, passthrough } = parsed;
  const missing = missingPrerequisites(rootDir, descriptor);
  if (missing.length > 0) {
    for (const item of missing) {
      process.stderr.write(`${TEST_CLI_ERRORS.prerequisite}: ${item.path} is missing; run ${item.hint}\n`);
    }
    return EXIT_CODES.prerequisite;
  }

  let extraFilters = [];
  if (descriptor.hostSelection) {
    try {
      extraFilters = loadHostSelection(rootDir, plan ?? allowlist ?? "");
    } catch (error) {
      if (error instanceof TestCliError) {
        process.stderr.write(`${error.code}: ${error.message}\n`);
        return EXIT_CODES.usage;
      }
      throw error;
    }
  }

  const vitestArgs = buildVitestArgs(descriptor, extraFilters, passthrough);
  const vitestBin = join(rootDir, "node_modules", ".bin", "vitest");
  process.stderr.write(
    `test-cli: ${descriptor.id} suite=${descriptor.suite} projects=${descriptor.projects.join(",")}\n`
  );

  const result = await runVitest(vitestBin, vitestArgs, rootDir, descriptor.hostSelection ? extraFilters : null);
  if (result.error !== null) {
    process.stderr.write(
      `${TEST_CLI_ERRORS.prerequisite}: cannot execute ${vitestBin}: ${result.error.message}; run pnpm install:locked\n`
    );
    return EXIT_CODES.prerequisite;
  }
  const signalNumber = result.signal === null ? null : (osConstants.signals[result.signal] ?? 0);
  return childExitCode(result.code, signalNumber);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main();
}
