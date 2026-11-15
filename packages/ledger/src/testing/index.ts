import type { ErrorEnvelope, Hash, ResolvedSource, Result, SourceRef } from "@evoplug/core";
import type { HumanProofPurpose, HumanProofVerdict, LedgerClockPort, OriginProofPort } from "../ports.js";
import type { HumanAttestation } from "../domain/common.js";
import { sha256Bytes } from "../raw-hash.js";

/** Deterministic clock for unit tests. */
export class FakeClock implements LedgerClockPort {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

/** In-memory `SourceRefPort` backed by frozen bytes. */
export class FakeSourceRefStore {
  readonly #content = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): SourceRef {
    const hash = sha256Bytes(bytes);
    this.#content.set(hash, bytes);
    return `blob://${hash}#bytes=0-${bytes.byteLength}`;
  }

  readonly port: import("@evoplug/core").SourceRefPort = {
    resolve: (ref: SourceRef): Promise<Result<ResolvedSource>> => {
      const hash = ref.slice("blob://".length, ref.lastIndexOf("#bytes="));
      const bytes = this.#content.get(hash);
      if (bytes === undefined) {
        return Promise.resolve({
          ok: true,
          status: "ok",
          value: {
            bytes: null,
            length: 0,
            retrievable: false,
            contentVersion: null,
            range_content_hash: null,
            reason: "missing",
          },
        });
      }
      const contentHash = sha256Bytes(bytes);
      return Promise.resolve({
        ok: true,
        status: "ok",
        value: {
          bytes,
          length: bytes.byteLength,
          retrievable: true,
          contentVersion: contentHash,
          range_content_hash: contentHash,
        },
      });
    },
    checkRetrievable: (refs: readonly SourceRef[]): Promise<ReadonlyMap<SourceRef, ResolvedSource>> => {
      const map = new Map<SourceRef, ResolvedSource>();
      for (const ref of refs) {
        const hash = ref.slice("blob://".length, ref.lastIndexOf("#bytes="));
        const bytes = this.#content.get(hash);
        map.set(ref, {
          bytes: bytes ?? null,
          length: bytes?.byteLength ?? 0,
          retrievable: bytes !== undefined,
          contentVersion: bytes === undefined ? null : sha256Bytes(bytes),
          range_content_hash: bytes === undefined ? null : sha256Bytes(bytes),
        });
      }
      return Promise.resolve(map);
    },
  };
}

/** Origin proof stub that returns a fixed verdict and records calls. */
export class FakeOriginProof implements OriginProofPort {
  readonly calls: string[] = [];
  #verdict: HumanProofVerdict;

  constructor(verdict: HumanProofVerdict = "unverified") {
    this.#verdict = verdict;
  }

  setVerdict(verdict: HumanProofVerdict): void {
    this.#verdict = verdict;
  }

  verifyHuman(input: {
    readonly attestation: HumanAttestation;
    readonly host_id: import("@evoplug/core").HostId;
    readonly config_space: string;
    readonly native_session_id: string;
    readonly event_key: Hash;
  }): Promise<HumanProofVerdict> {
    this.calls.push(input.event_key);
    return Promise.resolve(this.#verdict);
  }

  verifyControlPlane(_input: {
    readonly attestation: HumanAttestation;
    readonly subject_hash: Hash;
    readonly purpose: HumanProofPurpose;
  }): Promise<HumanProofVerdict> {
    return Promise.resolve(this.#verdict);
  }
}

/** Builds a `Result` error for tests without hand-writing envelopes. */
export function fakeError(code: ErrorEnvelope["code"]): ErrorEnvelope {
  return {
    schema_version: "rsi.error/1",
    code,
    category: "internal",
    retryable: false,
    side_effect: "none",
    message_key: "error." + code.toLowerCase(),
    details: { kind: "none" },
    stage: "test",
    trace_id: "ipc:00000000000000000000000000" as import("@evoplug/core").Id<"ipc">,
  };
}
