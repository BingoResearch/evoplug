/**
 * Pi payload inspection for `normalizeEvent` (DD-TRG-004).
 *
 * The shared payload view and member readers live in `@evoplug/adapter-kit`;
 * this module keeps the adapter's export surface and view type name.
 */

import { resolvePayloadView, type PayloadView } from "@evoplug/adapter-kit";

import type { ResolvedHostPayload } from "./contract.js";

export {
  asJsonRecord,
  stringMember,
  booleanMember,
  safeIntegerMember,
  objectMember,
  findTopLevelMember,
  textMemberRef,
  valueMemberRef,
  sortedMemberNames,
  type JsonRecord,
  type PayloadView
} from "@evoplug/adapter-kit";

export type PiPayloadView = PayloadView;

/** Reads the frozen payload into the adapter's view; `null` means invalid ref. */
export function readPiPayload(payload: ResolvedHostPayload): PiPayloadView | null {
  return resolvePayloadView(payload);
}
