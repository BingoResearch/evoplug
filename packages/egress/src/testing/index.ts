/**
 * Test doubles for the DD-FND-093.1 ports.
 *
 * These are injected only by unit-test constructors. The production
 * composition root always uses the real SQLite-backed ports. An unconfigured
 * fake fails with `E_INTERNAL` and never approves a source set.
 */

import { makeErrorEnvelope } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Result,
  Tx,
} from "@evoplug/core";

import {
  computeEgressApprovedSourcesInputHash,
  sealEgressApprovedSources,
  type EgressApprovedSourcesInput,
  type EgressApprovedSourcesPrepared,
  type EgressApprovedSourcesView,
  type EgressPolicyPreparationPort,
  type EgressPolicyReadPort,
  type EgressSourceFact,
} from "../approved-sources.js";
import { EGRESS_POLICY_REF } from "../approved-sources.js";
import { EGRESS_CLASSIFIER_VERSION } from "../classifier.js";

interface FakeEgressPreparationConfig {
  readonly prepared?: EgressApprovedSourcesPrepared;
  readonly error?: ErrorEnvelope;
}

/** Records the exact input and never mutates or reclassifies it. */
export class FakeEgressPolicyPreparationPort implements EgressPolicyPreparationPort {
  readonly calls: EgressApprovedSourcesInput[] = [];
  private readonly config: FakeEgressPreparationConfig;

  constructor(config: FakeEgressPreparationConfig = {}) {
    this.config = config;
  }

  async prepareApprovedSources(
    input: EgressApprovedSourcesInput,
  ): Promise<Result<EgressApprovedSourcesPrepared, ErrorEnvelope>> {
    this.calls.push(input);
    if (this.config.error !== undefined) {
      return { ok: false, status: "rejected", error: this.config.error };
    }
    if (this.config.prepared !== undefined) {
      return { ok: true, status: "ok", value: this.config.prepared };
    }
    return { ok: false, status: "rejected", error: fakeUnconfiguredError() };
  }
}

interface FakeEgressReadConfig {
  readonly view?: EgressApprovedSourcesView;
  readonly error?: ErrorEnvelope;
}

interface FakeEgressReadCall {
  readonly tx: Tx;
  readonly input: EgressApprovedSourcesInput;
  readonly prepared: EgressApprovedSourcesPrepared;
}

/** Verifies the seal and policy constant; zero file/blob reads by construction. */
export class FakeEgressPolicyReadPort implements EgressPolicyReadPort {
  readonly calls: FakeEgressReadCall[] = [];
  readonly fileReadAttempts: number = 0;
  private readonly config: FakeEgressReadConfig;

  constructor(config: FakeEgressReadConfig = {}) {
    this.config = config;
  }

  getApprovedSourcesInTransaction(
    tx: Tx,
    input: EgressApprovedSourcesInput,
    prepared: EgressApprovedSourcesPrepared,
  ): Result<EgressApprovedSourcesView, ErrorEnvelope> {
    this.calls.push({ tx, input, prepared });
    if (this.config.error !== undefined) {
      return { ok: false, status: "rejected", error: this.config.error };
    }
    if (prepared.policy_ref !== EGRESS_POLICY_REF) {
      return { ok: false, status: "rejected", error: fakeUnconfiguredError() };
    }
    if (prepared.input_hash !== computeEgressApprovedSourcesInputHash(input)) {
      return { ok: false, status: "rejected", error: fakeUnconfiguredError() };
    }
    if (this.config.view !== undefined) {
      return { ok: true, status: "ok", value: this.config.view };
    }
    return { ok: false, status: "rejected", error: fakeUnconfiguredError() };
  }
}

/**
 * Test factory for a prepared object with a legal seal. Production code must
 * never call this; it exists so fakes cannot forge a structurally identical
 * object that the read port would accept.
 */
export function makeTestPrepared(input: {
  input: EgressApprovedSourcesInput;
  policy_version: string;
  policy_hash: Hash;
  facts: readonly EgressSourceFact[];
}): EgressApprovedSourcesPrepared {
  return sealEgressApprovedSources({
    schema_version: "rsi.egress_approved_sources_prepared/1",
    input_hash: computeEgressApprovedSourcesInputHash(input.input),
    policy_ref: EGRESS_POLICY_REF,
    egress_policy_version: input.policy_version,
    egress_policy_hash: input.policy_hash,
    classifier_version: EGRESS_CLASSIFIER_VERSION,
    facts: input.facts,
  });
}

function fakeUnconfiguredError(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal",
    stage: "egress_fake",
    details: { kind: "internal", incident_id: "fake_unconfigured" },
  });
}
