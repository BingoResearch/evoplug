/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This package uses Node built-ins
// (`node:crypto`) and the global `TextEncoder`, so the type package is
// referenced here once for the whole `@evoplug/replay` program, mirroring
// `packages/core/src/node-types.d.ts`.
