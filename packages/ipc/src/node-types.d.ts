/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This package uses Node built-ins
// (`node:net`, `node:crypto`, `node:fs/promises`, `node:path`) and Node globals
// (`Buffer`, `process`, `setTimeout`, `AbortController`, `AbortSignal`,
// `performance`, `TextEncoder`, `TextDecoder`), so the type package is
// referenced once for the whole `@evoplug/ipc` program, mirroring
// `packages/core/src/node-types.d.ts`.
