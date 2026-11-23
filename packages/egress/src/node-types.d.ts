/// <reference types="node" />
//
// `@types/node` is installed at the workspace root but the shared tsconfig does
// not pin `compilerOptions.types`. Egress uses Node built-ins (`node:url`,
// `node:net`) and the global `TextEncoder`, so the type package is referenced
// here once for the whole `@evoplug/egress` program.
