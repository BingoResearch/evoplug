/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This package uses Node globals
// (`TextEncoder`, `TextDecoder`, `setTimeout`, `clearTimeout`, `AbortController`,
// `AbortSignal`) and Node built-ins through `@evoplug/core`, so the type package
// is referenced once for the whole `@evoplug/evidence` program, mirroring
// `packages/core/src/node-types.d.ts` and `packages/ipc/src/node-types.d.ts`.
