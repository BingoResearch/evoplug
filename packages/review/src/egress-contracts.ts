/**
 * FND egress approval ABI consumed by REV (DD-REV-010, DD-FND-093.1).
 *
 * `EgressApprovedSourcesPrepared` is an opaque FND brand: REV stores it
 * unchanged and passes it back to the in-transaction read port. REV never
 * projects `data_class` or the FND `facts` into a snapshot.
 */

import type { ErrorEnvelope, Hash, Result, SourceRef } from "@evoplug/core";

import type { Tx } from "@evoplug/core";

export interface EgressApprovedSourcesInput {
  schema_version: "rsi.egress_approved_sources_in/1";
  policy_ref: string;
  evidence_refs: SourceRef[];
  experience_refs: SourceRef[];
}

declare const egressApprovedSourcesPreparedBrand: unique symbol;

export interface EgressApprovedSourcesPrepared {
  readonly [egressApprovedSourcesPreparedBrand]: true;
  readonly schema_version: "rsi.egress_approved_sources_prepared/1";
}

export interface EgressApprovedSourcesView {
  schema_version: "rsi.egress_approved_sources_view/1";
  egress_policy_ref: string;
  egress_policy_version: string;
  approved_evidence_refs: SourceRef[];
  approved_experience_refs: SourceRef[];
  rejected_sources: Array<{
    ref: SourceRef;
    reason: "not_approved" | "classifier_unknown" | "policy_missing" | "source_missing";
  }>;
}

export interface EgressPolicyPreparationPort {
  prepareApprovedSources(
    input: EgressApprovedSourcesInput
  ): Promise<Result<EgressApprovedSourcesPrepared, ErrorEnvelope>>;
}

export interface EgressPolicyReadPort {
  getApprovedSourcesInTransaction(
    tx: Tx,
    input: EgressApprovedSourcesInput,
    prepared: EgressApprovedSourcesPrepared
  ): Result<EgressApprovedSourcesView, ErrorEnvelope>;
}

/** Provider-side decision record; REV only stores its `SourceRef`. */
export interface EgressRequestView {
  allowed: boolean;
  approval_id: string | null;
  decision_ref: SourceRef | null;
  sources: SourceRef[];
}

export interface EgressDecisionPort {
  decide(input: {
    purpose: "review_match";
    binding: import("@evoplug/core").VersionBinding;
    sources: SourceRef[];
    endpoint: string;
    model_id: string;
  }): Promise<Result<EgressRequestView, ErrorEnvelope>>;
}

export interface EgressApprovalSummary {
  policy_ref: string;
  policy_version: string;
  approved_evidence_refs: SourceRef[];
  approved_experience_refs: SourceRef[];
  approved: Hash;
}
