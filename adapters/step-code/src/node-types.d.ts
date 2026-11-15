/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This adapter's program uses the Node
// built-in `node:perf_hooks` module and the global `AbortSignal`,
// `TextEncoder` and `TextDecoder` web APIs, so the type package is referenced
// here once for the whole `@evoplug/adapter-step-code` program.
