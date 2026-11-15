/**
 * `CapabilityPipelinePort` over the committed `capability_record` table
 * (DD-CAP-002, DD-CAP-008).
 *
 * The online pipeline asks for one capability at a time and for the canonical
 * snapshot hash. Both are read from persisted records; an absent record is
 * reported as `null` (unknown), never as a verified capability. A scope that
 * spans more than one adapter binding is rejected instead of picking one.
 */

import type {
  CapabilityName,
  CapabilityRecord,
  ConfigSpace,
  HostMode,
  HostId
} from "@evoplug/core/host";
import {
  capabilityBindingKey,
  computeCapabilitySnapshotHash,
  validateCapabilityRecord
} from "@evoplug/core/host";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { err, makeErrorEnvelope, ok } from "@evoplug/core";
import type { SqliteConnection, SqlRow } from "@evoplug/storage";

import type { CapabilityPipelinePort } from "./online-pipeline.js";

const COLUMNS = `capability_id, binding_key, binding_json, name, status,
  evidence_stage, evidence_refs_json, probe_ref, probe_result, blocker_code,
  failure_code, checked_at, verified_at, last_verified_at, details_json,
  legacy_json`;

function str(row: SqlRow, key: string): string | null {
  const value = row[key as keyof SqlRow];
  return typeof value === "string" ? value : null;
}

function int(row: SqlRow, key: string): number | null {
  const value = row[key as keyof SqlRow];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function capabilityError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_CAPABILITY",
    category: "policy",
    message_key: "error.capability.unavailable",
    stage: "capability_lookup",
    details: { kind: "field", path, rule }
  });
}

function asRecord(row: SqlRow): Result<CapabilityRecord, ErrorEnvelope> | null {
  const bindingKey = str(row, "binding_key");
  const bindingJson = str(row, "binding_json");
  const evidenceRefsJson = str(row, "evidence_refs_json");
  const detailsJson = str(row, "details_json");
  const legacyJson = str(row, "legacy_json");
  const checkedAt = int(row, "checked_at");
  if (
    bindingKey === null ||
    bindingJson === null ||
    evidenceRefsJson === null ||
    detailsJson === null ||
    checkedAt === null
  ) {
    return null;
  }
  const binding = parseJson(bindingJson);
  const evidenceRefs = parseJson(evidenceRefsJson);
  const details = parseJson(detailsJson);
  if (
    binding === null ||
    !Array.isArray(evidenceRefs) ||
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return null;
  }
  const value: Record<string, unknown> = {
    schema_version: "rsi.capability/2",
    capability_id: str(row, "capability_id"),
    binding,
    binding_key: bindingKey,
    name: str(row, "name"),
    status: str(row, "status"),
    evidence_stage: str(row, "evidence_stage"),
    evidence_refs: evidenceRefs,
    checked_at: checkedAt,
    details
  };
  for (const key of [
    "probe_ref",
    "probe_result",
    "blocker_code",
    "failure_code",
    "verified_at",
    "last_verified_at"
  ] as const) {
    const field = key === "verified_at" || key === "last_verified_at" ? int(row, key) : str(row, key);
    if (field !== null) value[key] = field;
  }
  if (legacyJson !== null) {
    const legacy = parseJson(legacyJson);
    if (legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)) {
      value["legacy"] = legacy;
    }
  }
  return validateCapabilityRecord(value);
}

/** Reads and validates every persisted capability record. */
export function listCapabilityRecords(
  connection: SqliteConnection
): Result<readonly CapabilityRecord[], ErrorEnvelope> {
  const rows = connection
    .prepare<SqlRow>(`SELECT ${COLUMNS} FROM capability_record ORDER BY binding_key, name`)
    .all();
  const records: CapabilityRecord[] = [];
  for (const row of rows) {
    const parsed = asRecord(row);
    if (parsed === null) {
      return err(capabilityError("$", "record_row"));
    }
    if (!parsed.ok) return parsed;
    if (capabilityBindingKey(parsed.value.binding) !== parsed.value.binding_key) {
      return err(capabilityError("binding_key", "binding_key_mismatch"));
    }
    records.push(parsed.value);
  }
  return ok(records);
}

export interface CapabilityScopeSelector {
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
}

export type CapabilitySelector = CapabilityScopeSelector | { readonly binding_key: Hash };

function matches(record: CapabilityRecord, selector: CapabilitySelector): boolean {
  if ("binding_key" in selector) {
    return record.binding_key === selector.binding_key;
  }
  return (
    record.binding.subject === "product_adapter" &&
    record.binding.host_id === selector.host_id &&
    record.binding.mode === selector.mode &&
    record.binding.config_space === selector.config_space
  );
}

/**
 * Builds the pipeline port for one adapter binding.
 *
 * `snapshotHash` always covers every current `product_adapter` record, as
 * DD-CAP-008 requires; `lookup` is restricted to the selected binding. When a
 * scope selector matches more than one binding, construction fails closed
 * because the adapter binding for the event is then ambiguous.
 */
export function createCapabilityPipelinePort(
  connection: SqliteConnection,
  selector: CapabilitySelector
): Result<CapabilityPipelinePort, ErrorEnvelope> {
  const listed = listCapabilityRecords(connection);
  if (!listed.ok) return listed;
  const all = listed.value;
  const selected = all.filter((record) => matches(record, selector));
  if (!("binding_key" in selector)) {
    const keys = new Set(selected.map((record) => record.binding_key));
    if (keys.size > 1) {
      return err(capabilityError("$", "ambiguous_binding"));
    }
  }
  const byName = new Map<CapabilityName, CapabilityRecord>();
  for (const record of selected) byName.set(record.name, record);
  const productRecords = all.filter((record) => record.binding.subject === "product_adapter");
  return ok({
    lookup(name: CapabilityName) {
      const record = byName.get(name);
      if (record === undefined) return null;
      return { status: record.status, evidence_stage: record.evidence_stage };
    },
    snapshotHash() {
      return ok(computeCapabilitySnapshotHash(productRecords));
    }
  });
}
