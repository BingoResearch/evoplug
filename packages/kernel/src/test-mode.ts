/**
 * Test-mode home marker (design 5.4).
 *
 * A home created by `evolve init --test-mode` carries an immutable marker. Only
 * such a home accepts the automated-test confirmation backdoor; every
 * production home rejects both the marker creation and the backdoor proof. The
 * marker is a standalone file so it can be written before the database exists
 * and can never be flipped by a later command.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { err, makeErrorEnvelope, ok, type ErrorEnvelope, type Result } from "@evoplug/core";
import { writeFileAtomicDurable } from "./home.js";

export const TEST_MODE_FILE_NAME = "test-mode.json";
export const TEST_MODE_SCHEMA = "rsi.test_mode/1" as const;

export interface TestModeMarker {
  readonly schema_version: typeof TEST_MODE_SCHEMA;
  readonly enabled: true;
  readonly created_at: number;
}

export function testModeMarkerPath(home: string): string {
  return join(home, TEST_MODE_FILE_NAME);
}

function parseMarker(value: unknown): TestModeMarker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["schema_version"] !== TEST_MODE_SCHEMA ||
    record["enabled"] !== true ||
    typeof record["created_at"] !== "number" ||
    !Number.isSafeInteger(record["created_at"]) ||
    record["created_at"] < 0
  ) {
    return null;
  }
  return {
    schema_version: TEST_MODE_SCHEMA,
    enabled: true,
    created_at: record["created_at"]
  };
}

/** Synchronous form used by proof composition at startup. */
export function isTestModeHomeSync(home: string | undefined): boolean {
  if (home === undefined) return false;
  try {
    return existsSync(testModeMarkerPath(home));
  } catch {
    return false;
  }
}

export async function readTestModeMarker(
  home: string
): Promise<Result<TestModeMarker | null, ErrorEnvelope>> {
  let text: string;
  try {
    text = await readFile(testModeMarkerPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(null);
    }
    return err(markerError("test_mode_marker_unreadable"));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(markerError("test_mode_marker_invalid"));
  }
  const marker = parseMarker(parsed);
  return marker === null ? err(markerError("test_mode_marker_invalid")) : ok(marker);
}

/**
 * Writes the marker exactly once. An existing marker is never rewritten, so a
 * production home cannot be turned into a test home after the fact.
 */
export async function createTestModeMarker(
  home: string,
  now: number
): Promise<Result<TestModeMarker, ErrorEnvelope>> {
  const existing = await readTestModeMarker(home);
  if (!existing.ok) return existing;
  if (existing.value !== null) return ok(existing.value);
  const marker: TestModeMarker = {
    schema_version: TEST_MODE_SCHEMA,
    enabled: true,
    created_at: now
  };
  const written = await writeFileAtomicDurable(
    testModeMarkerPath(home),
    `${JSON.stringify(marker)}\n`
  );
  return written.ok ? ok(marker) : written;
}

/**
 * True when this process runs from a source checkout. A packaged artifact has
 * no workspace manifest next to `apps/kernel/dist`, so it must additionally set
 * `EVOPLUG_ALLOW_TEST_MODE=1` before `--test-mode` is accepted.
 */
export function testModeRequiresAllowEnv(from_dist: string): boolean {
  return !existsSync(join(from_dist, "..", "..", "..", "pnpm-workspace.yaml"));
}

function markerError(rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "test_mode_marker",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path: "test-mode.json", rule }
  });
}
