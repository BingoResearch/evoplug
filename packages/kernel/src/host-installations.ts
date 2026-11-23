/**
 * Attach-produced runtime configuration hashes, per registration.
 *
 * A host can be attached from more than one host directory (appendix I.1: a
 * caller-local attach resolves its own agent directory, then the canonical
 * attach restores the suite/user install). `adapter_registration.config_hash`
 * holds one value, so a second installation used to make every later runtime
 * start fail `E_ARTIFACT_MISMATCH`.
 *
 * This file keeps the closed set of config hashes that real attach runs wrote
 * for one registration. `host.runtime.ready` accepts a config only when its
 * hash is in that set; a hand-written or modified config still fails.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJsonText, isHash, type Hash, type JsonValue } from "@evoplug/core";

export const HOST_INSTALLATIONS_SCHEMA = "rsi.host_installations/1";

interface InstallationsDocument {
  readonly schema_version: typeof HOST_INSTALLATIONS_SCHEMA;
  readonly by_registration: Readonly<Record<string, readonly Hash[]>>;
}

const MAX_HASHES_PER_REGISTRATION = 16;

function documentPath(home: string): string {
  return join(home, "host-runtime", "installations.json");
}

function readDocument(home: string): InstallationsDocument {
  const path = documentPath(home);
  if (!existsSync(path)) {
    return { schema_version: HOST_INSTALLATIONS_SCHEMA, by_registration: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { schema_version: HOST_INSTALLATIONS_SCHEMA, by_registration: {} };
    }
    const record = parsed as Record<string, unknown>;
    if (record["schema_version"] !== HOST_INSTALLATIONS_SCHEMA) {
      return { schema_version: HOST_INSTALLATIONS_SCHEMA, by_registration: {} };
    }
    const raw = record["by_registration"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { schema_version: HOST_INSTALLATIONS_SCHEMA, by_registration: {} };
    }
    const by_registration: Record<string, Hash[]> = {};
    for (const [registration, hashes] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(hashes)) continue;
      const clean = hashes.filter((hash): hash is Hash => typeof hash === "string" && isHash(hash));
      if (clean.length > 0) by_registration[registration] = clean;
    }
    return { schema_version: HOST_INSTALLATIONS_SCHEMA, by_registration };
  } catch {
    return { schema_version: HOST_INSTALLATIONS_SCHEMA, by_registration: {} };
  }
}

/** Records one config hash an attach actually wrote for this registration. */
export function recordHostInstallation(input: {
  readonly home: string;
  readonly registration_hash: Hash;
  readonly config_hash: Hash;
}): void {
  if (!isHash(input.registration_hash) || !isHash(input.config_hash)) return;
  const current = readDocument(input.home);
  const existing = current.by_registration[input.registration_hash] ?? [];
  const next = existing.includes(input.config_hash)
    ? [...existing]
    : [...existing, input.config_hash].slice(-MAX_HASHES_PER_REGISTRATION);
  const document: InstallationsDocument = {
    schema_version: HOST_INSTALLATIONS_SCHEMA,
    by_registration: { ...current.by_registration, [input.registration_hash]: next }
  };
  const directory = join(input.home, "host-runtime");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = documentPath(input.home);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, canonicalJsonText(document as unknown as JsonValue), { mode: 0o600 });
  renameSync(temporary, path);
}

/** True when this exact config hash was produced by an attach for the registration. */
export function hostInstallationAllows(
  home: string | undefined,
  registration_hash: string,
  config_hash: string
): boolean {
  if (home === undefined || !isHash(registration_hash) || !isHash(config_hash)) return false;
  const document = readDocument(home);
  return (document.by_registration[registration_hash] ?? []).includes(config_hash as Hash);
}
