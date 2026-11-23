/**
 * Claude payload inspection for `normalizeEvent` (DD-TRG-004).
 *
 * The shared payload view and member readers live in `@evoplug/adapter-kit`;
 * this module keeps the adapter's export surface and view type name.
 */

import {
  asJsonRecord,
  resolvePayloadView,
  stringMember,
  type JsonRecord,
  type PayloadView
} from "@evoplug/adapter-kit";
import { sortUtf8 } from "@evoplug/core";

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

export type ClaudePayloadView = PayloadView;

/** Reads the frozen payload into the adapter's view; `null` means invalid ref. */
export function readClaudePayload(payload: ResolvedHostPayload): ClaudePayloadView | null {
  return resolvePayloadView(payload);
}

export function stringArrayMember(record: JsonRecord | null, keys: readonly string[]): readonly string[] | null {
  if (record === null) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const strings = value.filter((entry): entry is string => typeof entry === "string");
    if (strings.length > 0) {
      return strings;
    }
  }
  return null;
}

const BACKGROUND_ID_KEYS: readonly string[] = ["id", "task_id", "cron_id", "name"];

/**
 * Deterministic background reference list from an array member.
 *
 * Items may be plain strings or objects carrying a stable id. The result is
 * UTF-8 sorted and de-duplicated; an absent or empty array yields `[]`, which
 * the normalizer still treats as "not observed", never as "no background
 * work".
 */
export function backgroundRefs(record: JsonRecord | null, keys: readonly string[]): readonly string[] {
  if (record === null) {
    return Object.freeze([]);
  }
  const refs = new Set<string>();
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) {
        refs.add(item);
        continue;
      }
      const itemRecord = asJsonRecord(item);
      if (itemRecord === null) {
        continue;
      }
      const id = stringMember(itemRecord, BACKGROUND_ID_KEYS);
      if (id !== null && id.length > 0) {
        refs.add(id);
      }
    }
  }
  return Object.freeze(sortUtf8([...refs], (value) => value));
}
