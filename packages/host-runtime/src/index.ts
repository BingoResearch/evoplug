/**
 * `@evoplug/host-runtime` public surface (DD-HOST-200 … DD-HOST-202).
 *
 * This package runs inside the host process: artifact verification, instance
 * configuration, structural redaction, the IPC client wrapper and the runtime
 * lifecycle. It intentionally has no dependency on kernel, storage, SQLite or
 * any adapter package.
 */

export type { RuntimeCall } from "@evoplug/core/host";

export * from "./artifact.js";
export * from "./config.js";
export * from "./load-guard.js";
export * from "./redact.js";
export * from "./client.js";
export * from "./probe.js";
export * from "./runtime-probe.js";
export * from "./runtime-confirmation.js";
export * from "./mcp-confirm-protocol.js";
export * from "./mcp-confirm-session.js";
export * from "./mcp-confirm-server.js";
export * from "./runtime-session-confirmation.js";
export * from "./runtime.js";
