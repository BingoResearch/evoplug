/**
 * Host-owned Jev provisioning ABI.
 *
 * Provisioning is an explicit write operation: the host supplies the typed
 * service-profile and capability inputs, while the kernel persists the profile,
 * capability and derived semantic validator through the EVD state-row writer.
 * Credential values are not part of this input or any durable row.
 */

import {
  buildJevServiceProfile,
  buildSemanticBackendCapability,
  buildSemanticValidationBinding,
  type EvdStateWritePort,
  type JevServiceProfile,
  type JevServiceProfileInput,
  type SemanticBackendCapability,
  type SemanticCapabilityInput,
  type SemanticValidationBinding
} from "@evoplug/evidence";
import type { ErrorEnvelope, Result } from "@evoplug/core";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

export interface JevProvisioningInput {
  readonly profile: JevServiceProfileInput;
  readonly capability: SemanticCapabilityInput;
  readonly now: number;
  readonly expected_profile_version: number | null;
  readonly expected_capability_version: number | null;
  /**
   * Optional read connection. With it an already persisted, identical binding
   * is returned as `existing` instead of being rewritten; a repeated
   * `configure jev` must not collide with its own validator row.
   */
  readonly connection?: SqliteConnection | undefined;
}

interface JevProvisioningResult {
  readonly profile: Omit<JevServiceProfile, "profile_id" | "profile_version" | "created_at">;
  readonly capability: SemanticBackendCapability;
  readonly validator: SemanticValidationBinding;
}

type ProvisionFailure = {
  readonly ok: false;
  readonly status: "rejected";
  readonly commit_state: "not_written" | "unknown_recovery_required";
  readonly error: ErrorEnvelope;
};

function failure(outcome: {
  readonly ok: false;
  readonly commit_state: "not_written" | "unknown_recovery_required";
  readonly error: ErrorEnvelope;
}): ProvisionFailure {
  return {
    ok: false,
    status: "rejected",
    commit_state: outcome.commit_state,
    error: outcome.error
  };
}

function readExistingBinding(
  connection: SqliteConnection | undefined,
  profileKey: string,
  capabilityKey: string
): boolean {
  if (connection === undefined) return false;
  const profile = connection
    .prepare<SqlRow>(
      `SELECT 1 AS present FROM evd_service_profile
        WHERE json_extract(body_json, '$.schema_version') = 'rsi.jev_service_profile/1'
          AND json_extract(body_json, '$.profile_key') = :profile_key
        LIMIT 1`
    )
    .get({ profile_key: profileKey });
  if (profile === undefined) return false;
  const capability = connection
    .prepare<SqlRow>(
      `SELECT 1 AS present FROM evd_service_profile
        WHERE json_extract(body_json, '$.schema_version') = 'rsi.semantic_backend_capability/1'
          AND json_extract(body_json, '$.capability_key') = :capability_key
        LIMIT 1`
    )
    .get({ capability_key: capabilityKey });
  return capability !== undefined;
}

/** Persists one complete Jev binding through the durable EVD writer. */
export async function provisionJevBinding(
  writer: EvdStateWritePort,
  input: JevProvisioningInput
): Promise<Result<JevProvisioningResult, ErrorEnvelope> &
  (| { readonly ok: true; readonly status: "ok"; readonly commit_state: "committed" | "existing"; readonly value: JevProvisioningResult }
   | ProvisionFailure)> {
  const profile = buildJevServiceProfile(input.profile);
  const capabilityRecord = buildSemanticBackendCapability(input.capability);
  const existing = readExistingBinding(input.connection, profile.profile_key, capabilityRecord.capability_key);
  if (existing) {
    return {
      ok: true,
      status: "ok",
      commit_state: "existing",
      value: {
        profile,
        capability: capabilityRecord,
        validator: buildSemanticValidationBinding({ capability: capabilityRecord, now: input.now })
      }
    };
  }
  const profileWrite = await writer.writeServiceProfile({
    profile,
    expected_previous_version: input.expected_profile_version
  });
  if (!profileWrite.ok) return failure(profileWrite);

  const capability = capabilityRecord;
  const capabilityWrite = await writer.writeSemanticBackendCapability({
    capability,
    expected_previous_version: input.expected_capability_version
  });
  if (!capabilityWrite.ok) return failure(capabilityWrite);

  const validator = buildSemanticValidationBinding({ capability, now: input.now });
  const validatorWrite = await writer.writeSemanticValidationBinding({ binding: validator });
  if (!validatorWrite.ok) return failure(validatorWrite);

  return {
    ok: true,
    status: "ok",
    commit_state:
      profileWrite.commit_state === "committed" ||
      capabilityWrite.commit_state === "committed" ||
      validatorWrite.commit_state === "committed"
        ? "committed"
        : "existing",
    value: { profile, capability, validator }
  };
}
