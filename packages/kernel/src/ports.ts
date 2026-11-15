/**
 * Kernel composition ports.
 *
 * Domain services are consumed exactly through the documented IPC contract:
 * each entry is an `IpcHandler<M>` over `IpcParams[M]`/`IpcResult[M]` from
 * `@evoplug/ipc`, so the kernel never re-declares a domain DTO or a second
 * method table (DD-FND-042). The three kernel-owned methods (`system.describe`,
 * `status.get`, `maintenance.gc`) are served by the environment ports below.
 */

import type { ErrorEnvelope, GcReport, Result } from "@evoplug/core";
import type { IpcHandler, IpcMethod } from "@evoplug/ipc";
import type { GcParams, RuntimeFacts, StatusAxis, SystemStatusAxes } from "./system.js";

/** IPC methods whose implementation belongs to a domain package or adapter. */
export type KernelDomainMethod = Exclude<IpcMethod, "system.describe" | "status.get" | "maintenance.gc">;

export const KERNEL_OWNED_METHODS: readonly IpcMethod[] = ["system.describe", "status.get", "maintenance.gc"];

/**
 * One handler per domain method. A missing key is reported by
 * `composeKernelHandlers`; the composed handler answers `E_INTERNAL` with
 * `incident_id="kernel.handler_unavailable"` and the method name in the log,
 * never a fabricated success.
 */
export type KernelServicePorts = {
  readonly [M in KernelDomainMethod]?: IpcHandler<M>;
};

/** Static runtime facts for `system.describe`; read once at startup. */
export interface SystemDescribePort {
  facts(): RuntimeFacts;
}

/**
 * Axis read for `status.get`. `include` is the validated, non-empty axis set;
 * the port must return every structural axis of a complete `SystemStatus`.
 */
export interface SystemStatusPort {
  readStatus(include: readonly StatusAxis[]): Promise<Result<SystemStatusAxes, ErrorEnvelope>>;
}

/** `maintenance.gc`, executed inside the single-writer critical section. */
export interface GcPort {
  run(params: GcParams): Promise<Result<GcReport, ErrorEnvelope>>;
}

/** Live IPC facts; wired to the running server by the app bootstrap. */
export interface IpcStatsPort {
  activeConnections(): number;
  /** False when the 0700/0600/0600 probe has not passed. */
  modeVerified(): boolean;
}

export interface KernelEnvironment {
  readonly describe: SystemDescribePort;
  readonly status: SystemStatusPort;
  readonly gc: GcPort;
  readonly ipc: IpcStatsPort;
}

export type IpcMethodHandler = IpcHandler<IpcMethod>;
