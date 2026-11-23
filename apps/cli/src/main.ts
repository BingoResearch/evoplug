#!/usr/bin/env node
/**
 * `evolve` executable entrypoint (DD-FND-101).
 *
 * The binary only dispatches; all command logic lives in `run.ts`. Exit codes
 * are set through `process.exitCode` so buffered stdout/stderr always flush.
 */

import { runCli } from "./run.js";

void runCli(process.argv.slice(2)).then(
  (exitCode: number): void => {
    process.exitCode = exitCode;
  },
  (): void => {
    process.stderr.write("evolve: internal error\n");
    process.exitCode = 1;
  }
);
