/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This package uses Node built-ins
// (`node:perf_hooks`) and Node globals (`AbortSignal`, `TextEncoder`,
// `TextDecoder`), so the type package is referenced once for the whole
// `@evoplug/adapter-pi` program, mirroring `packages/core/src/node-types.d.ts`
// and `packages/ipc/src/node-types.d.ts`.
