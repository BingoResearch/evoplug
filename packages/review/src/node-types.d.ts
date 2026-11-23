/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This package uses Node globals
// (`TextEncoder`, `TextDecoder`, `AbortController`,
// `AbortSignal`, `setTimeout`, `clearTimeout`, `setInterval`,
// `clearInterval`), so the type package is referenced once for the whole
// `@evoplug/review` program, mirroring `packages/core/src/node-types.d.ts`.
