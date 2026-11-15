/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. This package uses Node built-ins
// (`node:child_process`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`)
// and Node globals (`process`, `URL`), so the type package is referenced once
// for the whole `@evoplug/kernel` program, mirroring
// `packages/core/src/node-types.d.ts` and `packages/ipc/src/node-types.d.ts`.
