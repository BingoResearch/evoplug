/**
 * Stable event identity for one-shot command hooks (appendix N.1).
 *
 * Claude Code starts a new process per hook event and its `UserPromptSubmit`
 * payload carries `prompt_id` but no timestamp. The kernel's event identity is
 * (session, host event, native message/event id, source seq, occurred_at). If
 * the adapter forwards only the session id and lets the runtime fall back to
 * `Date.now()` for `occurred_at`, two hook deliveries of one turn get different
 * identity keys, and two prompts submitted in the same millisecond collide.
 *
 * This module derives the event id from the session id, hook event name and
 * the host payload content (`UserPromptSubmit` includes the prompt text and
 * the host's transcript path/prompt id). The first delivery of an event also
 * claims an occurrence timestamp; later deliveries of the identical payload
 * read it back, so `occurred_at` is stable without inventing a host clock.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalHash } from "@evoplug/core";
import type { JsonValue } from "@evoplug/core";

const IDENTITY_SCHEMA = "rsi.hook_event_id/1";
const OCCURRENCE_DIR = "hook-occurrences";
const OCCURRENCE_TTL_MS = 60 * 60 * 1_000;

export interface HookEventIdentityInput {
  readonly host_id: string;
  readonly session_id: string | null;
  readonly hook_event: string;
  readonly payload: Record<string, JsonValue>;
}

/** Host payload without adapter-added fields; only host facts form the id. */
function hostPayload(payload: Record<string, JsonValue>): Record<string, JsonValue> {
  const copy: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith("__evoplug_")) continue;
    copy[key] = value;
  }
  return copy;
}

/**
 * Derives the native event id. Identical payloads (the host's repeated
 * delivery of one hook) map to the same id; any different prompt, turn id or
 * transcript position maps to a different one.
 */
export function deriveHookEventId(input: HookEventIdentityInput): string {
  const digest = canonicalHash({
    schema_version: IDENTITY_SCHEMA,
    host_id: input.host_id,
    session_id: input.session_id,
    hook_event: input.hook_event,
    payload: hostPayload(input.payload)
  });
  return `hke1-${digest.slice("sha256:".length)}`;
}

function pruneOccurrences(directory: string, now: number): void {
  // Roughly hourly, remove claims that can no longer receive duplicates.
  if (Math.floor(now / 60_000) % 60 !== 0) return;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(directory, name);
    try {
      if (now - statSync(path).mtimeMs > OCCURRENCE_TTL_MS) unlinkSync(path);
    } catch {
      // A racing process already removed it.
    }
  }
}

/**
 * Returns the first delivery's wall-clock time for this event. The claim file
 * is created with `wx`, so concurrent hook processes agree on one value.
 * Any file-system failure degrades to `now`; identity still contains the
 * content hash, so the event is not lost, only duplicate detection weakens.
 */
export function claimHookOccurrence(
  evoplugHome: string | null,
  eventId: string,
  now: number
): number {
  if (evoplugHome === null || evoplugHome.length === 0) return now;
  const directory = join(evoplugHome, "runtime", OCCURRENCE_DIR);
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    return now;
  }
  const path = join(directory, eventId);
  try {
    writeFileSync(path, String(now), { encoding: "utf8", flag: "wx" });
    pruneOccurrences(directory, now);
    return now;
  } catch {
    // Another hook process created the claim. It may still be between create
    // and write; retry briefly so a duplicate never falls back to its own
    // arrival time (which would change the event identity).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const value = Number(readFileSync(path, "utf8"));
        if (Number.isSafeInteger(value) && value > 0) return value;
      } catch {
        // fall through to the short pause
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    return now;
  }
}
