/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This package uses Node built-ins
// (`node:perf_hooks`, `node:crypto`, `node:fs`, `node:url`) and Node globals
// (`AbortSignal`, `TextEncoder`, `TextDecoder`, `Buffer`, `URL`), so the type
// package is referenced once for the whole `@evoplug/adapter-opencode` program,
// mirroring `packages/core/src/node-types.d.ts` and
// `packages/ipc/src/node-types.d.ts`.
