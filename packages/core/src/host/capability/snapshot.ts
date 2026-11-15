/**
 * CapabilitySnapshotPort and the canonical `capability_snapshot_hash`
 * (DD-CAP-008).
 *
 * A snapshot covers only current `subject="product_adapter"` records. The
 * bytes are content addressed; `get` never returns live aggregates and always
 * recomputes the stored content before reporting `found`.
 */

import { performance } from "node:perf_hooks";

import { canonicalJson } from "../../canonical.js";
import { canonicalHash, hashBytes, isHash } from "../../hash.js";
import type { Hash } from "../../hash.js";
import { toJsonValue } from "../../json.js";
import type { JsonValue } from "../../json.js";
import type { SourceRef } from "../../source-ref.js";
import type { ErrorEnvelope } from "../../errors.js";
import type { Clock } from "../../clock.js";
import { ok, type Result } from "../../result.js";
import { adapterErr, type HostAdapterError, type HostAdapterResult } from "../errors.js";
import type { CapabilityRecord } from "../types.js";
import { isRecord, isSafePositiveInt } from "../validation.js";

export interface CapabilitySnapshotGetRequest {
  request_id: string;
  snapshot_hash: Hash;
  deadline_ms: number;
}

export type CapabilitySnapshotGetResult =
  | { state: "found"; snapshot_ref: SourceRef; snapshot_hash: Hash }
  | { state: "not_found" }
  | { state: "hash_mismatch"; stored_hash: Hash; recomputed_hash: Hash };

export interface CapabilitySnapshotCurrentRequest {
  request_id: string;
  subject: "product_adapter";
  deadline_ms: number;
}

export type CapabilitySnapshotCurrentResult =
  | { state: "found"; snapshot_ref: SourceRef; snapshot_hash: Hash }
  | { state: "not_found" };

export interface CapabilitySnapshotPort {
  get(
    req: CapabilitySnapshotGetRequest,
    signal?: AbortSignal
  ): Promise<HostAdapterResult<CapabilitySnapshotGetResult>>;
  getCurrent(
    req: CapabilitySnapshotCurrentRequest,
    signal?: AbortSignal
  ): Promise<HostAdapterResult<CapabilitySnapshotCurrentResult>>;
}

/** Canonical snapshot preimage (DD-CAP-008). */
export function capabilitySnapshotPreimage(records: readonly CapabilityRecord[]): JsonValue {
  const product = records.filter((record) => record.binding.subject === "product_adapter");
  const bindingKeys = Array.from(new Set(product.map((record) => record.binding_key))).sort();
  const sorted = product.slice().sort((left, right) => {
    if (left.binding_key !== right.binding_key) {
      return left.binding_key < right.binding_key ? -1 : 1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return {
    schema_version: "rsi.capability_snapshot/1",
    subject: "product_adapter",
    binding_keys: bindingKeys,
    records: sorted.map<JsonValue>((record) => ({
      binding_key: record.binding_key,
      name: record.name,
      status: record.status,
      evidence_stage: record.evidence_stage,
      details: toJsonValue(record.details),
      evidence_refs: Array.from(new Set(record.evidence_refs)).sort(),
      probe_ref: record.probe_ref ?? null,
      probe_result: record.probe_result ?? null,
      blocker_code: record.blocker_code ?? null,
      failure_code: record.failure_code ?? null,
      checked_at: record.checked_at,
      verified_at: record.verified_at ?? null
    }))
  };
}

export function canonicalCapabilitySnapshotBytes(records: readonly CapabilityRecord[]): Uint8Array {
  return canonicalJson(capabilitySnapshotPreimage(records));
}

export function computeCapabilitySnapshotHash(records: readonly CapabilityRecord[]): Hash {
  return canonicalHash(capabilitySnapshotPreimage(records));
}

export interface CapabilitySnapshotBlobStore {
  put(input: {
    bytes: Uint8Array;
    owner: { type: "host_capability_snapshot"; id: Hash };
  }): Promise<Result<{ content_ref: SourceRef; content_hash: Hash }, ErrorEnvelope>>;
  getByHash(input: {
    snapshot_hash: Hash;
  }): Promise<Result<{ content_ref: SourceRef; bytes: Uint8Array } | null, ErrorEnvelope>>;
}

export interface CapabilitySnapshotDeps {
  clock: Clock;
  /** Reads the current committed `capability_record` rows. */
  listCurrent: () => Promise<Result<readonly CapabilityRecord[], ErrorEnvelope>>;
  blobs: CapabilitySnapshotBlobStore;
  /** Evidence ref used for local validation failures (HostAdapterError shape). */
  failure_ref: SourceRef;
}

function snapshotError(
  deps: CapabilitySnapshotDeps,
  code: HostAdapterError["code"],
  retryable: boolean
): HostAdapterError {
  return {
    code,
    retryable,
    detail_ref: deps.failure_ref,
    observed_at: deps.clock.utcNowMs()
  };
}

function validDeadline(value: unknown): value is number {
  return isSafePositiveInt(value) && value <= 600_000;
}

function checkSignal(clock: Clock, deadlineRemaining: number, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) {
    return false;
  }
  return clock.monotonicRemainingMs(clock.monotonicNowMs() + deadlineRemaining) > 0;
}

/** Production factory over a list-current reader and a CAS blob store. */
export function createCapabilitySnapshotPort(deps: CapabilitySnapshotDeps): CapabilitySnapshotPort {
  return {
    async get(
      req: CapabilitySnapshotGetRequest,
      signal?: AbortSignal
    ): Promise<HostAdapterResult<CapabilitySnapshotGetResult>> {
      if (
        !isRecord(req) ||
        typeof req.request_id !== "string" ||
        req.request_id.length === 0 ||
        req.request_id.length > 128 ||
        typeof req.snapshot_hash !== "string" ||
        !isHash(req.snapshot_hash) ||
        !validDeadline(req.deadline_ms)
      ) {
        return adapterErr(snapshotError(deps, "E_SCHEMA", false));
      }
      if (!checkSignal(deps.clock, req.deadline_ms, signal)) {
        return adapterErr(snapshotError(deps, signal?.aborted === true ? "E_CANCELLED" : "E_DEADLINE_EXCEEDED", true));
      }
      const stored = await deps.blobs.getByHash({ snapshot_hash: req.snapshot_hash });
      if (!stored.ok) {
        return adapterErr(snapshotError(deps, "E_IO", true));
      }
      if (stored.value === null) {
        return ok({ state: "not_found" });
      }
      const recomputed = hashBytes(stored.value.bytes);
      if (recomputed !== req.snapshot_hash) {
        return ok({ state: "hash_mismatch", stored_hash: req.snapshot_hash, recomputed_hash: recomputed });
      }
      return ok({ state: "found", snapshot_ref: stored.value.content_ref, snapshot_hash: req.snapshot_hash });
    },

    async getCurrent(
      req: CapabilitySnapshotCurrentRequest,
      signal?: AbortSignal
    ): Promise<HostAdapterResult<CapabilitySnapshotCurrentResult>> {
      if (
        !isRecord(req) ||
        typeof req.request_id !== "string" ||
        req.request_id.length === 0 ||
        req.request_id.length > 128 ||
        req.subject !== "product_adapter" ||
        !validDeadline(req.deadline_ms)
      ) {
        return adapterErr(snapshotError(deps, "E_SCHEMA", false));
      }
      if (!checkSignal(deps.clock, req.deadline_ms, signal)) {
        return adapterErr(snapshotError(deps, signal?.aborted === true ? "E_CANCELLED" : "E_DEADLINE_EXCEEDED", true));
      }
      const records = await deps.listCurrent();
      if (!records.ok) {
        return adapterErr(snapshotError(deps, "E_IO", true));
      }
      const product = records.value.filter((record) => record.binding.subject === "product_adapter");
      if (product.length === 0) {
        return ok({ state: "not_found" });
      }
      const bytes = canonicalCapabilitySnapshotBytes(product);
      const snapshotHash = hashBytes(bytes);
      const put = await deps.blobs.put({
        bytes,
        owner: { type: "host_capability_snapshot", id: snapshotHash }
      });
      if (!put.ok || put.value.content_hash !== snapshotHash) {
        return adapterErr(snapshotError(deps, "E_IO", true));
      }
      return ok({ state: "found", snapshot_ref: put.value.content_ref, snapshot_hash: snapshotHash });
    }
  };
}
