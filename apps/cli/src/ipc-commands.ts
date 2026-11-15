/**
 * IPC command assembly for `evolve` (DD-FND-041, DD-FND-042, DD-FND-101).
 *
 * Each case mirrors one row of the CLI table: it reads the declared files,
 * builds the exact `IpcParams` member and sends it through the shared client.
 * Idempotency placement follows the command table: `required` puts the key on
 * the request envelope, `in_params` puts it inside `params`, and `forbidden`
 * never sends one.
 */

import type { ErrorEnvelope, JsonValue, Result } from "@evoplug/core";
import type { IpcClient, IpcMethod, IpcParams, IpcRequestOptions, IpcResult } from "@evoplug/ipc";
import type { ParsedCommand } from "./args.js";
import { optionFlag, optionInteger, optionString } from "./args.js";
import { cliFieldError } from "./errors.js";
import { encodeResultValue } from "./result.js";
import {
  asForkReason,
  asGrantListState,
  asGrantObjectType,
  asHash,
  asHostId,
  asId,
  asInstallRevokeReason,
  asReplayRevokeReason,
  asSourceRef,
  cliInternalError,
  readJsonFile
} from "./support.js";

export type StatusAxis = "storage" | "ipc" | "budget" | "outbox" | "config" | "capabilities";

/** `status.get` requires a non-empty, duplicate-free axis list. */
export const CLI_STATUS_AXES: readonly StatusAxis[] = [
  "storage",
  "ipc",
  "budget",
  "outbox",
  "config",
  "capabilities"
];

/** The parser guarantees declared required values; a miss is an internal bug. */
function requiredOption(parsed: ParsedCommand, name: string): string {
  const value = optionString(parsed, name);
  if (value === null) {
    throw new Error(`missing parsed option --${name}`);
  }
  return value;
}

function requiredInteger(parsed: ParsedCommand, name: string): number {
  const value = optionInteger(parsed, name);
  if (value === null) {
    throw new Error(`missing parsed option --${name}`);
  }
  return value;
}

function positional(parsed: ParsedCommand, index: number): string {
  const value = parsed.positionals[index];
  if (value === undefined) {
    throw new Error(`missing parsed positional ${String(index)}`);
  }
  return value;
}

function jsonValue(value: unknown): Result<JsonValue, ErrorEnvelope> {
  try {
    return { ok: true, status: "ok", value: encodeResultValue(value) };
  } catch {
    return {
      ok: false,
      status: "rejected",
      error: cliInternalError("cli.result_encoding_failed")
    };
  }
}

/** Keeps the typed IPC result but converts the success payload to JSON. */
function finish<M extends IpcMethod>(
  result: Result<IpcResult[M], ErrorEnvelope>
): Result<JsonValue, ErrorEnvelope> {
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }
  return jsonValue(result.value);
}

/**
 * A fully assembled request. Building happens before connecting so invalid
 * files or mutually exclusive flags answer exit 2 even when no kernel runs.
 */
export interface IpcCommand {
  readonly method: IpcMethod;
  send(
    client: IpcClient,
    options: IpcRequestOptions
  ): Promise<Result<JsonValue, ErrorEnvelope>>;
}

function okCommand<M extends IpcMethod>(
  method: M,
  params: IpcParams[M]
): Result<IpcCommand, ErrorEnvelope> {
  return {
    ok: true,
    status: "ok",
    value: {
      method,
      send: async (
        client: IpcClient,
        options: IpcRequestOptions
      ): Promise<Result<JsonValue, ErrorEnvelope>> =>
        finish(await client.request(method, params, options))
    }
  };
}

async function readAttestation<T>(
  parsed: ParsedCommand
): Promise<Result<T, ErrorEnvelope>> {
  return readJsonFile<T>(requiredOption(parsed, "attestation"));
}

function idempotencyKeyOption(parsed: ParsedCommand): string {
  return requiredOption(parsed, "idempotency-key");
}

/**
 * Builds and sends the request for one IPC-backed command. File and field
 * errors surface before any socket write.
 */
export async function buildIpcCommand(
  parsed: ParsedCommand
): Promise<Result<IpcCommand, ErrorEnvelope>> {
  switch (parsed.spec.id) {
    case "install.approve": {
      const subject = await readJsonFile<IpcParams["install.approve"]["subject"]>(
        requiredOption(parsed, "subject")
      );
      if (!subject.ok) {
        return subject;
      }
      const attestation = await readAttestation<
        IpcParams["install.approve"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["install.approve"] = {
        schema_version: "rsi.adapter_install_approve/1",
        subject: subject.value,
        human_attestation: attestation.value,
        ttl_ms: requiredInteger(parsed, "ttl-ms"),
        idempotency_key: idempotencyKeyOption(parsed)
      };
      return okCommand("install.approve", params);
    }

    case "install.revoke": {
      const approvalId = asId(positional(parsed, 0), "iap", "approval_id");
      if (!approvalId.ok) {
        return approvalId;
      }
      const approvalHash = asHash(requiredOption(parsed, "approval-hash"), "--approval-hash");
      if (!approvalHash.ok) {
        return approvalHash;
      }
      const reason = asInstallRevokeReason(requiredOption(parsed, "reason"), "--reason");
      if (!reason.ok) {
        return reason;
      }
      const attestation = await readAttestation<
        IpcParams["install.revoke"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["install.revoke"] = {
        subject: {
          schema_version: "rsi.adapter_install_revoke_subject/1",
          purpose: "adapter_install",
          approval_id: approvalId.value,
          expected_approval_hash: approvalHash.value,
          reason: reason.value
        },
        human_attestation: attestation.value,
        idempotency_key: idempotencyKeyOption(parsed)
      };
      return okCommand("install.revoke", params);
    }

    case "install.approval.get": {
      const approvalId = asId(positional(parsed, 0), "iap", "approval_id");
      if (!approvalId.ok) {
        return approvalId;
      }
      const subjectHash = asHash(requiredOption(parsed, "subject-hash"), "--subject-hash");
      if (!subjectHash.ok) {
        return subjectHash;
      }
      const params: IpcParams["install.approval.get"] = {
        approval_id: approvalId.value,
        expected_subject_hash: subjectHash.value
      };
      return okCommand("install.approval.get", params);
    }

    case "install.approval.consume": {
      const approvalId = asId(positional(parsed, 0), "iap", "approval_id");
      if (!approvalId.ok) {
        return approvalId;
      }
      const approvalHash = asHash(requiredOption(parsed, "approval-hash"), "--approval-hash");
      if (!approvalHash.ok) {
        return approvalHash;
      }
      const registrationHash = asHash(
        requiredOption(parsed, "registration-hash"),
        "--registration-hash"
      );
      if (!registrationHash.ok) {
        return registrationHash;
      }
      const params: IpcParams["install.approval.consume"] = {
        approval_id: approvalId.value,
        expected_approval_hash: approvalHash.value,
        registration_hash: registrationHash.value,
        request_id: requiredOption(parsed, "request-id"),
        idempotency_key: idempotencyKeyOption(parsed)
      };
      return okCommand("install.approval.consume", params);
    }

    case "status": {
      const params: IpcParams["status.get"] = { include: [...CLI_STATUS_AXES] };
      return okCommand("status.get", params);
    }

    case "skills.adopt": {
      const request = await readJsonFile<IpcParams["write.apply"]>(requiredOption(parsed, "request"));
      if (!request.ok) {
        return request;
      }
      return okCommand("write.apply", request.value);
    }

    case "grant.issue": {
      const request = await readJsonFile<Omit<IpcParams["grant.issue"], "human_attestation">>(
        requiredOption(parsed, "request")
      );
      if (!request.ok) {
        return request;
      }
      const attestation = await readAttestation<
        IpcParams["grant.issue"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["grant.issue"] = {
        ...request.value,
        human_attestation: attestation.value
      };
      return okCommand("grant.issue", params);
    }

    case "grant.revoke": {
      const grantId = asId(positional(parsed, 0), "grant", "grant_id");
      if (!grantId.ok) {
        return grantId;
      }
      const expectedHash = asHash(requiredOption(parsed, "expected-hash"), "--expected-hash");
      if (!expectedHash.ok) {
        return expectedHash;
      }
      const reason = asReplayRevokeReason(requiredOption(parsed, "reason"), "--reason");
      if (!reason.ok) {
        return reason;
      }
      const attestation = await readAttestation<
        IpcParams["grant.revoke"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["grant.revoke"] = {
        schema_version: "rsi.grant_revoke/1",
        grant_id: grantId.value,
        expected_grant_hash: expectedHash.value,
        human_attestation: attestation.value,
        reason: reason.value
      };
      return okCommand("grant.revoke", params);
    }

    case "grant.list": {
      const objectTypeRaw = optionString(parsed, "object-type");
      const stateRaw = optionString(parsed, "state");
      const limit = optionInteger(parsed, "limit");
      const objectType =
        objectTypeRaw === null
          ? null
          : asGrantObjectType(objectTypeRaw, "--object-type");
      if (objectType !== null && !objectType.ok) {
        return objectType;
      }
      const state = stateRaw === null ? null : asGrantListState(stateRaw, "--state");
      if (state !== null && !state.ok) {
        return state;
      }
      const params: IpcParams["grant.list"] = {
        ...(objectType === null ? {} : { object_type: objectType.value }),
        ...(state === null ? {} : { state: state.value }),
        ...(limit === null ? {} : { limit })
      };
      return okCommand("grant.list", params);
    }

    case "replay.create": {
      const plan = await readJsonFile<IpcParams["replay.create"]["plan"]>(
        requiredOption(parsed, "plan")
      );
      if (!plan.ok) {
        return plan;
      }
      const params: IpcParams["replay.create"] = { plan: plan.value };
      return okCommand("replay.create", params);
    }

    case "replay.approve": {
      const planId = asId(positional(parsed, 0), "rpl", "replay_plan_id");
      if (!planId.ok) {
        return planId;
      }
      const planHash = asHash(requiredOption(parsed, "plan-hash"), "--plan-hash");
      if (!planHash.ok) {
        return planHash;
      }
      const attestation = await readAttestation<
        IpcParams["replay.approve"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["replay.approve"] = {
        schema_version: "rsi.replay_approve/1",
        replay_plan_id: planId.value,
        expected_plan_hash: planHash.value,
        ttl_ms: requiredInteger(parsed, "ttl-ms"),
        human_attestation: attestation.value,
        reason: requiredOption(parsed, "reason")
      };
      return okCommand("replay.approve", params);
    }

    case "replay.revoke": {
      const approvalId = asId(positional(parsed, 0), "rpa", "approval_id");
      if (!approvalId.ok) {
        return approvalId;
      }
      const approvalHash = asHash(requiredOption(parsed, "approval-hash"), "--approval-hash");
      if (!approvalHash.ok) {
        return approvalHash;
      }
      const reason = asReplayRevokeReason(requiredOption(parsed, "reason"), "--reason");
      if (!reason.ok) {
        return reason;
      }
      const attestation = await readAttestation<
        IpcParams["replay.revoke"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["replay.revoke"] = {
        schema_version: "rsi.replay_revoke/1",
        approval_id: approvalId.value,
        expected_approval_hash: approvalHash.value,
        human_attestation: attestation.value,
        reason: reason.value
      };
      return okCommand("replay.revoke", params);
    }

    case "replay.reject": {
      const planId = asId(positional(parsed, 0), "rpl", "replay_plan_id");
      if (!planId.ok) {
        return planId;
      }
      const planHash = asHash(requiredOption(parsed, "plan-hash"), "--plan-hash");
      if (!planHash.ok) {
        return planHash;
      }
      const attestation = await readAttestation<
        IpcParams["replay.reject"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["replay.reject"] = {
        schema_version: "rsi.replay_reject/1",
        replay_plan_id: planId.value,
        expected_plan_hash: planHash.value,
        human_attestation: attestation.value,
        reason: requiredOption(parsed, "reason")
      };
      return okCommand("replay.reject", params);
    }

    case "replay.reconcile": {
      const executionId = asId(positional(parsed, 0), "rex", "execution_id");
      if (!executionId.ok) {
        return executionId;
      }
      const evidenceRef = asSourceRef(requiredOption(parsed, "evidence"), "--evidence");
      if (!evidenceRef.ok) {
        return evidenceRef;
      }
      const attestation = await readAttestation<
        IpcParams["replay.reconcile"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["replay.reconcile"] = {
        schema_version: "rsi.replay_reconcile/1",
        execution_id: executionId.value,
        fencing_token: requiredOption(parsed, "fencing-token"),
        evidence_ref: evidenceRef.value,
        human_attestation: attestation.value,
        reason: requiredOption(parsed, "reason")
      };
      return okCommand("replay.reconcile", params);
    }

    case "replay.execute": {
      const planId = asId(positional(parsed, 0), "rpl", "replay_plan_id");
      if (!planId.ok) {
        return planId;
      }
      const planHash = asHash(requiredOption(parsed, "plan-hash"), "--plan-hash");
      if (!planHash.ok) {
        return planHash;
      }
      const approvalRaw = optionString(parsed, "approval");
      const approval = approvalRaw === null ? null : asId(approvalRaw, "rpa", "--approval");
      if (approval !== null && !approval.ok) {
        return approval;
      }
      const params: IpcParams["replay.execute"] = {
        replay_plan_id: planId.value,
        expected_plan_hash: planHash.value,
        approval_id: approval === null ? null : approval.value
      };
      return okCommand("replay.execute", params);
    }

    case "replay.result": {
      const executionId = asId(positional(parsed, 0), "rex", "execution_id");
      if (!executionId.ok) {
        return executionId;
      }
      const params: IpcParams["replay.result"] = { execution_id: executionId.value };
      return okCommand("replay.result", params);
    }

    case "egress.approve": {
      const request = await readJsonFile<IpcParams["egress.approve"]["request"]>(
        requiredOption(parsed, "request")
      );
      if (!request.ok) {
        return request;
      }
      const attestation = await readAttestation<
        IpcParams["egress.approve"]["human_attestation"]
      >(parsed);
      if (!attestation.ok) {
        return attestation;
      }
      const params: IpcParams["egress.approve"] = {
        schema_version: "rsi.egress_approval_request/1",
        request: request.value,
        ttl_ms: requiredInteger(parsed, "ttl-ms"),
        human_attestation: attestation.value
      };
      return okCommand("egress.approve", params);
    }

    case "session.fork": {
      const branchId = asId(positional(parsed, 0), "br", "branch");
      if (!branchId.ok) {
        return branchId;
      }
      const reasonRaw = optionString(parsed, "reason");
      const reason = reasonRaw === null ? null : asForkReason(reasonRaw, "--reason");
      if (reason !== null && !reason.ok) {
        return reason;
      }
      const params: IpcParams["identity.fork"] = {
        source_branch_id: branchId.value,
        at_watermark: requiredInteger(parsed, "at-watermark"),
        reason: reason === null ? "user_fork" : reason.value
      };
      return okCommand("identity.fork", params);
    }

    case "session.resume": {
      const hostId = asHostId(requiredOption(parsed, "host"), "--host");
      if (!hostId.ok) {
        return hostId;
      }
      const params: IpcParams["identity.resume"] = {
        session_id: positional(parsed, 0),
        host_id: hostId.value,
        config_space: requiredOption(parsed, "config-space"),
        observed_watermark: requiredInteger(parsed, "observed-watermark")
      };
      return okCommand("identity.resume", params);
    }

    case "gc": {
      const dryRun = optionFlag(parsed, "dry-run");
      const apply = optionFlag(parsed, "apply");
      if (dryRun && apply) {
        return {
          ok: false,
          status: "rejected",
          error: cliFieldError("--apply", "mutually_exclusive_with_dry_run")
        };
      }
      const params: IpcParams["maintenance.gc"] = { mode: apply ? "apply" : "dry_run" };
      return okCommand("maintenance.gc", params);
    }

    default:
      return {
        ok: false,
        status: "rejected",
        error: cliInternalError(`cli.unmapped_ipc_command:${parsed.spec.id}`)
      };
  }
}
