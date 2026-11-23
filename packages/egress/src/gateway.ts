/**
 * Kernel-owned egress gateway (DD-FND-093).
 *
 * Every outbound request is evaluated against the frozen policy before the
 * transport is called. The gateway follows no redirects, never truncates a
 * body to fit a cap, and reports denials as data rather than as transport
 * errors.
 */

import type { ErrorEnvelope, Result, SourceRef } from "@evoplug/core";
import { ok } from "@evoplug/core";

import { evaluateEgress } from "./evaluate.js";
import type { EgressDenyReason, EgressPolicy, EgressRequestInput } from "./types.js";
import type { EgressSourceStatus } from "./evaluate.js";

interface EgressGatewayRequest {
  readonly request: EgressRequestInput;
  readonly source_status?: ReadonlyMap<SourceRef, EgressSourceStatus>;
  readonly require_single_approval?: boolean;
}

interface EgressTransportRequest {
  readonly endpoint: EgressRequestInput["endpoint"];
  /** Redirects are never followed automatically. */
  readonly redirect: "manual";
  readonly body_sha256: string;
  readonly byte_length: number;
}

interface EgressTransportResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly location: string | null;
}

export type EgressTransport = (
  request: EgressTransportRequest
) => Promise<Result<EgressTransportResponse, ErrorEnvelope>>;

interface EgressGatewayDeps {
  readonly policy: EgressPolicy;
  readonly transport: EgressTransport;
  readonly now_ms: () => number;
  readonly max_response_bytes: number;
}

type EgressGatewayDenialReason = EgressDenyReason | "approval_required";

type EgressGatewayOutcome =
  | {
      readonly allowed: true;
      readonly status: number;
      readonly byte_length: number;
    }
  | {
      readonly allowed: false;
      readonly reason_code: EgressGatewayDenialReason;
    };

interface EgressGateway {
  send(request: EgressGatewayRequest): Promise<Result<EgressGatewayOutcome, ErrorEnvelope>>;
}

/** Redirects are denied rather than re-evaluated or followed. */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export function createEgressGateway(deps: EgressGatewayDeps): EgressGateway {
  return {
    async send(request: EgressGatewayRequest): Promise<Result<EgressGatewayOutcome, ErrorEnvelope>> {
      const evaluated = evaluateEgress(deps.policy, request.request, {
        now_ms: deps.now_ms(),
        source_status: request.source_status ?? new Map(),
        require_single_approval: request.require_single_approval ?? false
      });
      if (!evaluated.ok) return evaluated;
      if (!evaluated.value.allowed) {
        return ok({ allowed: false, reason_code: evaluated.value.reason_code });
      }
      const response = await deps.transport({
        endpoint: request.request.endpoint,
        redirect: "manual",
        body_sha256: request.request.body_sha256,
        byte_length: request.request.byte_length
      });
      if (!response.ok) return response;
      if (isRedirect(response.value.status)) {
        return ok({ allowed: false, reason_code: "endpoint_not_allowed" });
      }
      if (response.value.body.byteLength > deps.max_response_bytes) {
        return ok({ allowed: false, reason_code: "byte_limit_exceeded" });
      }
      return ok({
        allowed: true,
        status: response.value.status,
        byte_length: response.value.body.byteLength
      });
    }
  };
}
