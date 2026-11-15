/**
 * `@evoplug/core` public surface (DD-FND-030 … DD-FND-035).
 *
 * Shared types only: identifiers, canonical JSON and hashing, version
 * binding, results and errors, source references, clock and the transaction
 * port used by FND read ports. Domain packages and adapter boundaries import
 * these names; no domain package redefines them.
 */

export * from "./json.js";
export * from "./canonical.js";
export * from "./hash.js";
export * from "./ids.js";
export * from "./result.js";
export * from "./errors.js";
export * from "./error-code-list.js";
export * from "./error-registry-types.js";
export * from "./event-types.js";
export * from "./source-ref.js";
export * from "./clock.js";
export * from "./tx.js";
export * from "./version-binding.js";
export * from "./state-row.js";
export * from "./admission/index.js";
export * from "./generated/host-vocabulary.js";
export * from "./ports/index.js";

export type {
  ContentUpload,
  WriteApplyRequest,
  WriteResult,
} from "./generated/types/write-apply-request.js";
export type {
  EventDraft,
  HumanAttestation,
  NativeMessageKind,
} from "./generated/types/event-draft.js";
export type { IngestReceipt } from "./generated/types/ingest-receipt.js";
export type { GrantView } from "./generated/types/authorization-grant.js";
export type {
  IdentityResolution,
  ResumeResult,
} from "./generated/types/identity-resolution.js";
export type { LedgerView } from "./generated/types/ledger-view.js";
export type {
  ReplayApproveRequest,
  ReplayAuthorizeRequest,
  ReplayAuthorization,
  ReplayClassification,
  ReplayClassifyRequest,
  ReplayExecution,
  ReplayPlan,
  ReplayPlanDraft,
  ReplayReconcileRequest,
  ReplayRejectRequest,
  ReplayRevokeRequest,
} from "./generated/types/replay-plan.js";
export type {
  GcReport,
  SystemDescription,
  SystemStatus,
} from "./generated/types/system-description.js";
export type {
  CapabilityName,
  HostEventBinding,
} from "./host/types.js";
