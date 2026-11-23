/**
 * Proposal state machine (DD-REV-050).
 *
 * A full Proposal is created `checked`; judge completion moves it to
 * `unverified`; handoff moves it to `proposed`; adoption requires an FND
 * verified write. `generated` and `rejected` are not Proposal states.
 */

import type { ErrorEnvelope } from "@evoplug/core";

import { illegalProposalTransition } from "./errors.js";
import type { Proposal } from "./types.js";

type ProposalState = Proposal["state"];

const PROPOSAL_EDGES: Readonly<Record<ProposalState, readonly ProposalState[]>> = {
  checked: ["unverified", "proposed", "stale"],
  unverified: ["proposed", "stale"],
  proposed: ["adopted", "stale", "withdrawn"],
  stale: [],
  withdrawn: [],
  adopted: []
};

function proposalTransitionAllowed(from: ProposalState, to: ProposalState): boolean {
  return PROPOSAL_EDGES[from].includes(to);
}

export function proposalTransitionError(
  from: ProposalState,
  to: ProposalState
): ErrorEnvelope | null {
  return proposalTransitionAllowed(from, to) ? null : illegalProposalTransition(from, to);
}

export function proposalStateAfterJudge(current: ProposalState): ProposalState {
  return current === "checked" ? "unverified" : current;
}

export function proposalStateAfterHandoff(current: ProposalState): ProposalState {
  return current === "checked" || current === "unverified" ? "proposed" : current;
}

export function proposalStateAfterAdoption(current: ProposalState, verified: boolean): ProposalState {
  return current === "proposed" && verified ? "adopted" : current;
}

