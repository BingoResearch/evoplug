/**
 * Verified container/VM sandbox spawner (DD-FND-094).
 *
 * The host spawner runs `isolation.mechanism="none"`. A sandbox plan must be
 * handed to an executor that actually owns a container/VM/OS sandbox and has
 * verified isolation evidence; this factory only exposes that seam and fails
 * closed when no runtime is injected rather than claiming an isolation the
 * process cannot provide.
 */

import type { ErrorEnvelope, Result } from "@evoplug/core";
import { err, makeErrorEnvelope } from "@evoplug/core";

export type SandboxMechanism = "container" | "vm" | "os_sandbox";

export interface SandboxSpawnRequest {
  readonly command: string;
  readonly cwd: string;
  readonly isolation: {
    readonly mechanism: SandboxMechanism;
    readonly verified: boolean;
    readonly evidence_ref: string | null;
    readonly network_namespace: boolean;
    readonly writable_roots: readonly string[];
  };
  readonly allowed_network: boolean;
  readonly network_target: string | null;
}

export interface SandboxProcessOutcome {
  readonly process_exited: boolean;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly output_overflow: boolean;
}

export interface SandboxProcessHandle {
  readonly pid: number | null;
  wait(): Promise<SandboxProcessOutcome>;
  terminate(): void;
}

export interface SandboxRuntime {
  spawn(request: SandboxSpawnRequest): Promise<Result<SandboxProcessHandle, ErrorEnvelope>>;
}

export interface SandboxSpawner {
  readonly supported_isolation: readonly SandboxMechanism[];
  readonly handles_egress: true;
  spawn(request: SandboxSpawnRequest): Promise<Result<SandboxProcessHandle, ErrorEnvelope>>;
}

const SANDBOX_MECHANISMS: readonly SandboxMechanism[] = ["container", "vm", "os_sandbox"];

function unavailable(stage: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal",
    stage,
    details: { kind: "internal", incident_id: "replay.sandbox_runtime_unavailable" }
  });
}

/**
 * Builds a spawner over a verified sandbox runtime. Without a runtime it still
 * advertises the mechanisms but refuses every spawn, so a sandbox plan cannot
 * silently fall back to the host.
 */
export function createSandboxSpawner(
  runtime: SandboxRuntime | null,
  mechanisms: readonly SandboxMechanism[] = SANDBOX_MECHANISMS
): SandboxSpawner {
  const supported: readonly SandboxMechanism[] = [...mechanisms];
  return {
    supported_isolation: supported,
    handles_egress: true,
    async spawn(
      request: SandboxSpawnRequest
    ): Promise<Result<SandboxProcessHandle, ErrorEnvelope>> {
      if (runtime === null) {
        return err(unavailable("replay_sandbox_spawn"));
      }
      if (!supported.includes(request.isolation.mechanism) || !request.isolation.verified) {
        return err(unavailable("replay_sandbox_isolation"));
      }
      return runtime.spawn(request);
    }
  };
}
