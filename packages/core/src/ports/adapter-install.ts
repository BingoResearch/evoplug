/**
 * Adapter install approval wire DTOs (DD-FND-096 / DD-HOST-001).
 *
 * The install port and its approval view live in the HOST submodule; the IPC
 * method table only needs these request/revoke shapes.
 */

import type { HumanAttestation } from "../generated/types/event-draft.js";
import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";

export interface AdapterInstallApproveRequest {
  readonly schema_version: "rsi.adapter_install_approve/1";
  readonly subject: import("../host/types.js").AdapterInstallSubject;
  readonly human_attestation: HumanAttestation;
  readonly ttl_ms: number;
  readonly idempotency_key: string;
}

export interface AdapterInstallRevokeSubject {
  readonly schema_version: "rsi.adapter_install_revoke_subject/1";
  readonly purpose: "adapter_install";
  readonly approval_id: Id<"iap">;
  readonly expected_approval_hash: Hash;
  readonly reason: "human_revoked" | "superseded" | "security";
}

export type {
  AdapterInstallApprovalView,
  AdapterInstallSubject,
} from "../host/types.js";
