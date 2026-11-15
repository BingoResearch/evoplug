/**
 * `@evoplug/cli` public surface.
 *
 * Exports the argument parser, the command table, the result/exit-code
 * contract and the `runCli` programmatic entrypoint used by tests and tools.
 */

export * from "./args.js";
export * from "./commands.js";
export * from "./errors.js";
export * from "./exit-codes.js";
export * from "./result.js";
export * from "./support.js";
export type { StatusAxis } from "./ipc-commands.js";
export { CLI_STATUS_AXES } from "./ipc-commands.js";
export type { LocalOutcome } from "./local-commands.js";
export { runLocalCommand } from "./local-commands.js";
export { runCli } from "./run.js";
export type { RunCliOptions } from "./run.js";
