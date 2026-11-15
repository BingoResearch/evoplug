/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. Core root code uses Node built-ins
// (`node:crypto`, `node:perf_hooks`) and the global `TextEncoder`, so the type
// package is referenced here once for the whole `@evoplug/core` program.
