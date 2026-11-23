/**
 * Composition root for the kernel IPC surface (DD-FND-042, DD-FND-103).
 *
 * Every registered method gets exactly one handler. The three kernel-owned
 * methods are served from the environment ports; the remaining methods are
 * delegated to the domain service map. A method with no service is still
 * registered (so the transport does not answer `E_IPC_METHOD_UNKNOWN`) but
 * answers `E_INTERNAL` with `incident_id="kernel.handler_unavailable"`, and its
 * name is returned in `missing_methods` for startup diagnostics.
 */

import { type ErrorEnvelope, type GcReport, type Result } from "@evoplug/core";
import type {
  IpcHandler,
  IpcHandlerContext,
  IpcHandlerMap,
  IpcMethod,
  IpcResult
} from "@evoplug/ipc";
import { IPC_METHODS } from "@evoplug/ipc";
import { fieldError, internalError } from "./errors.js";
import type {
  GcPort,
  IpcStatsPort,
  KernelDomainMethod,
  KernelEnvironment,
  KernelServicePorts,
  SystemDescribePort,
  SystemStatusPort
} from "./ports.js";
import { KERNEL_OWNED_METHODS } from "./ports.js";
import type { GcParams, SystemStatusAxes } from "./system.js";
import {
  buildSystemDescription,
  buildSystemStatus,
  validateGcParams,
  validateStatusInclude
} from "./system.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return sharedIsRecord(value);
}

const HANDLER_UNAVAILABLE_INCIDENT = "kernel.handler_unavailable";

function unavailable<M extends IpcMethod>(method: M): IpcHandler<M> {
  return async (): Promise<Result<IpcResult[M], ErrorEnvelope>> => ({
    ok: false,
    status: "rejected",
    error: internalError(`${HANDLER_UNAVAILABLE_INCIDENT}:${method}`)
  });
}

function describeHandler(port: SystemDescribePort): IpcHandler<"system.describe"> {
  return async (
    context: IpcHandlerContext<"system.describe">
  ): Promise<Result<IpcResult["system.describe"], ErrorEnvelope>> => {
    if (!isRecord(context.params) || Object.keys(context.params).length > 0) {
      return {
        ok: false,
        status: "rejected",
        error: fieldError("params", "must_be_empty")
      };
    }
    return { ok: true, status: "ok", value: buildSystemDescription(port.facts()) };
  };
}

function statusHandler(port: SystemStatusPort, ipc: IpcStatsPort): IpcHandler<"status.get"> {
  return async (context: IpcHandlerContext<"status.get">): Promise<Result<IpcResult["status.get"], ErrorEnvelope>> => {
    const include = validateStatusInclude(context.params.include);
    if (!include.ok) {
      return include;
    }
    const axes: Result<SystemStatusAxes, ErrorEnvelope> = await port.readStatus(include.value);
    if (!axes.ok) {
      return axes;
    }
    return {
      ok: true,
      status: "ok",
      value: buildSystemStatus({
        axes: axes.value,
        ipc: {
          mode_verified: ipc.modeVerified(),
          active_connections: ipc.activeConnections()
        }
      })
    };
  };
}

function gcHandler(port: GcPort): IpcHandler<"maintenance.gc"> {
  return async (context: IpcHandlerContext<"maintenance.gc">): Promise<Result<GcReport, ErrorEnvelope>> => {
    const params = validateGcParams(context.params);
    if (!params.ok) {
      return params;
    }
    const gcParams: GcParams = params.value;
    return port.run(gcParams);
  };
}

interface ComposeKernelOptions {
  readonly services: KernelServicePorts;
  readonly environment: KernelEnvironment;
}

export interface KernelComposition {
  readonly handlers: IpcHandlerMap;
  /** Domain methods that have no service and answer `E_INTERNAL`. */
  readonly missing_methods: readonly KernelDomainMethod[];
  /** Every method the map answers, in registry order. */
  readonly wired_methods: readonly IpcMethod[];
}

/**
 * Builds the closed handler map. The literal below lists all 47 registered
 * methods, so adding a method to `IpcMethod` without wiring it fails the build.
 */
export function composeKernelHandlers(options: ComposeKernelOptions): KernelComposition {
  const { services, environment } = options;
  const handlers: IpcHandlerMap = {
    "system.describe": describeHandler(environment.describe),
    "event.ingest": services["event.ingest"] ?? unavailable("event.ingest"),
    "host.runtime.ready": services["host.runtime.ready"] ?? unavailable("host.runtime.ready"),
    "host.runtime.upload": services["host.runtime.upload"] ?? unavailable("host.runtime.upload"),
    "host.runtime.poll": services["host.runtime.poll"] ?? unavailable("host.runtime.poll"),
    "host.runtime.result": services["host.runtime.result"] ?? unavailable("host.runtime.result"),
    "identity.resolve": services["identity.resolve"] ?? unavailable("identity.resolve"),
    "identity.fork": services["identity.fork"] ?? unavailable("identity.fork"),
    "identity.resume": services["identity.resume"] ?? unavailable("identity.resume"),
    "ledger.read": services["ledger.read"] ?? unavailable("ledger.read"),
    "grant.issue": services["grant.issue"] ?? unavailable("grant.issue"),
    "grant.revoke": services["grant.revoke"] ?? unavailable("grant.revoke"),
    "grant.list": services["grant.list"] ?? unavailable("grant.list"),
    "budget.reserve": services["budget.reserve"] ?? unavailable("budget.reserve"),
    "budget.claim": services["budget.claim"] ?? unavailable("budget.claim"),
    "budget.settle": services["budget.settle"] ?? unavailable("budget.settle"),
    "decision.record": services["decision.record"] ?? unavailable("decision.record"),
    "delivery.create": services["delivery.create"] ?? unavailable("delivery.create"),
    "delivery.update": services["delivery.update"] ?? unavailable("delivery.update"),
    "write.apply": services["write.apply"] ?? unavailable("write.apply"),
    "egress.evaluate": services["egress.evaluate"] ?? unavailable("egress.evaluate"),
    "egress.approve": services["egress.approve"] ?? unavailable("egress.approve"),
    "install.approve": services["install.approve"] ?? unavailable("install.approve"),
    "install.revoke": services["install.revoke"] ?? unavailable("install.revoke"),
    "install.approval.get": services["install.approval.get"] ?? unavailable("install.approval.get"),
    "install.approval.consume":
      services["install.approval.consume"] ?? unavailable("install.approval.consume"),
    "replay.classify": services["replay.classify"] ?? unavailable("replay.classify"),
    "replay.create": services["replay.create"] ?? unavailable("replay.create"),
    "replay.authorize": services["replay.authorize"] ?? unavailable("replay.authorize"),
    "replay.approve": services["replay.approve"] ?? unavailable("replay.approve"),
    "replay.revoke": services["replay.revoke"] ?? unavailable("replay.revoke"),
    "replay.reject": services["replay.reject"] ?? unavailable("replay.reject"),
    "replay.execute": services["replay.execute"] ?? unavailable("replay.execute"),
    "replay.reconcile": services["replay.reconcile"] ?? unavailable("replay.reconcile"),
    "replay.result": services["replay.result"] ?? unavailable("replay.result"),
    "status.get": statusHandler(environment.status, environment.ipc),
    "cli.execute": services["cli.execute"] ?? unavailable("cli.execute"),
    "host.attach.execute":
      services["host.attach.execute"] ?? unavailable("host.attach.execute"),
    "maintenance.gc": gcHandler(environment.gc),
    "config.space.capture":
      services["config.space.capture"] ?? unavailable("config.space.capture"),
    "config.space.read_fields":
      services["config.space.read_fields"] ?? unavailable("config.space.read_fields"),
    "config.trial.create_plan":
      services["config.trial.create_plan"] ?? unavailable("config.trial.create_plan"),
    "config.trial.start": services["config.trial.start"] ?? unavailable("config.trial.start"),
    "config.trial.execute_attempt":
      services["config.trial.execute_attempt"] ?? unavailable("config.trial.execute_attempt"),
    "config.trial.record_observation":
      services["config.trial.record_observation"] ??
      unavailable("config.trial.record_observation"),
    "config.trial.request_rollback":
      services["config.trial.request_rollback"] ?? unavailable("config.trial.request_rollback"),
    "config.trial.close": services["config.trial.close"] ?? unavailable("config.trial.close"),
    "config.trial.reconcile":
      services["config.trial.reconcile"] ?? unavailable("config.trial.reconcile"),
    "config.promotion.collect":
      services["config.promotion.collect"] ?? unavailable("config.promotion.collect")
  };

  const missing: KernelDomainMethod[] = [];
  for (const method of IPC_METHODS) {
    if (KERNEL_OWNED_METHODS.includes(method)) {
      continue;
    }
    const domainMethod = method as KernelDomainMethod;
    if (services[domainMethod] === undefined) {
      missing.push(domainMethod);
    }
  }

  return {
    handlers,
    missing_methods: missing,
    wired_methods: [...IPC_METHODS]
  };
}
