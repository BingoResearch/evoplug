import type { ErrorEnvelope, Hash, HostId, Id, Result } from "@evoplug/core";
import type {
  ForkRequest,
  IdentityResolution,
  ResumeObservation,
} from "../domain/identity.js";
import type { LedgerPorts } from "../ports.js";
import type { ForkPlan, InheritedRequirementRef } from "../identity/fork.js";
import type { ResumePlan } from "../identity/resume.js";
import { resolveIdentity } from "../identity/resolve.js";
import { isSameForkRequest, planBranchFork } from "../identity/fork.js";
import { planResume } from "../identity/resume.js";
import { ledgerFailure, ledgerOk, schemaError } from "../errors.js";
import { isHash } from "../raw-hash.js";
import { isNonNegativeSafeInteger } from "../util.js";
import { isRevisionValidAt, parseAcceptanceText, parseRequirementScopeText } from "../requirements/asof.js";

export interface ResolveIdentityRequest {
  readonly host_id: HostId;
  readonly config_space: string;
  readonly native_session_id: string;
}

export interface ForkIds {
  readonly branch_id: Id<"br">;
  readonly goal_snapshot_id: Id<"gsnap">;
}

export interface ForkOptions {
  /**
   * Whether `at_watermark` has a complete `commit_record` set. The identity
   * read port does not expose commit ranges, so the caller (kernel) supplies
   * this flag; the default is conservative and treats the watermark as
   * committed only when it is not ahead of the receipt sequence.
   */
  readonly watermark_committed?: boolean;
}

export interface ResumeRequest {
  readonly session_id: Id<"sess">;
  readonly branch_id: Id<"br">;
  readonly resume_generation: number;
  readonly observed_watermark: number;
  readonly committed_ranges: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  readonly history_retained: boolean;
  readonly idempotency_key: Hash;
}

/** Identity, fork and resume orchestration (DD-FND-073). */
export class IdentityService {
  readonly #ports: LedgerPorts;

  constructor(ports: LedgerPorts) {
    this.#ports = ports;
  }

  async resolve(request: ResolveIdentityRequest): Promise<Result<IdentityResolution, ErrorEnvelope>> {
    const [mappings, session] = await Promise.all([
      this.#ports.identity.listNativeMappings({
        host_id: request.host_id,
        config_space: request.config_space,
        native_session_id: request.native_session_id,
      }),
      this.#ports.identity.findSession({
        host_id: request.host_id,
        config_space: request.config_space,
        native_session_id: request.native_session_id,
      }),
    ]);
    if (!mappings.ok) return mappings;
    if (!session.ok) return session;

    return ledgerOk(
      resolveIdentity({
        host_id: request.host_id,
        config_space: request.config_space,
        native_session_id: request.native_session_id,
        mappings: mappings.value,
      }),
    );
  }

  async fork(
    request: ForkRequest,
    ids: ForkIds,
    options: ForkOptions = {},
  ): Promise<Result<ForkPlan, ErrorEnvelope>> {
    if (request.reason !== "explicit_request") {
      return schemaError<ForkPlan>("reason", "explicit_request");
    }
    if (!isNonNegativeSafeInteger(request.at_watermark)) {
      return schemaError<ForkPlan>("at_watermark", "non_negative_safe_integer");
    }
    if (!isHash(request.idempotency_key)) {
      return schemaError<ForkPlan>("idempotency_key", "sha256_lower_hex");
    }

    const branch = await this.#ports.identity.getBranch(request.source_branch_id);
    if (!branch.ok) return branch;
    const receipt = await this.#ports.identity.getReceiptSeq();
    if (!receipt.ok) return receipt;

    const existing = await this.#ports.identity.findForkIdempotency({
      source_branch_id: request.source_branch_id,
      at_watermark: request.at_watermark,
      reason: request.reason,
      idempotency_key: request.idempotency_key,
    });
    if (!existing.ok) return existing;
    if (existing.value !== null && !isSameForkRequest(existing.value, request)) {
      return ledgerFailure<ForkPlan>(
        {
          code: "E_IDEMPOTENCY_CONFLICT",
          category: "conflict",
          details: {
            kind: "idempotency",
            key:
              request.source_branch_id +
              ":" +
              String(request.at_watermark) +
              ":" +
              request.reason +
              ":" +
              request.idempotency_key,
            existing_hash: existing.value.idempotency_key,
            incoming_hash: request.idempotency_key,
          },
          stage: "persist",
        },
        "conflict",
      );
    }

    if (branch.value === null) {
      return planBranchFork({
        request,
        source: null,
        receipt_seq: receipt.value,
        watermark_committed: false,
        existing: existing.value,
        new_branch_id: ids.branch_id,
        new_goal_snapshot_id: ids.goal_snapshot_id,
        inherited_requirements: [],
        now: this.#ports.clock.now(),
      });
    }

    const inherited = await this.#loadInheritedRequirements(
      branch.value.branch_id,
      branch.value.task_id,
      request.at_watermark,
    );
    if (!inherited.ok) return inherited;

    return planBranchFork({
      request,
      source: {
        branch_id: branch.value.branch_id,
        task_id: branch.value.task_id,
        current_watermark: receipt.value,
        current_goal_version: branch.value.current_goal_version,
        current_goal_revision: branch.value.current_goal_revision,
      },
      receipt_seq: receipt.value,
      watermark_committed: options.watermark_committed ?? true,
      existing: existing.value,
      new_branch_id: ids.branch_id,
      new_goal_snapshot_id: ids.goal_snapshot_id,
      inherited_requirements: inherited.value,
      now: this.#ports.clock.now(),
    });
  }

  async resume(request: ResumeRequest): Promise<Result<ResumePlan, ErrorEnvelope>> {
    if (!Number.isSafeInteger(request.resume_generation) || request.resume_generation < 1) {
      return schemaError<ResumePlan>("resume_generation", "positive_safe_integer");
    }
    const branch = await this.#ports.identity.getBranch(request.branch_id);
    if (!branch.ok) return branch;
    if (branch.value === null) {
      return ledgerFailure<ResumePlan>({
        code: "E_VERSION_BINDING",
        category: "version",
        details: { kind: "version", expected: "existing_branch", actual: request.branch_id },
        stage: "binding",
      });
    }
    const receipt = await this.#ports.identity.getReceiptSeq();
    if (!receipt.ok) return receipt;

    const observation: ResumeObservation = {
      session_id: request.session_id,
      branch_id: request.branch_id,
      resume_generation: request.resume_generation,
      observed_watermark: request.observed_watermark,
      current_watermark: receipt.value,
      committed_ranges: request.committed_ranges,
    };
    return planResume({
      observation,
      history_retained: request.history_retained,
      idempotency_key: request.idempotency_key,
      now: this.#ports.clock.now(),
    });
  }

  async #loadInheritedRequirements(
    branchId: Id<"br">,
    taskId: Id<"task">,
    atWatermark: number,
  ): Promise<Result<readonly InheritedRequirementRef[], ErrorEnvelope>> {
    const rows = await this.#ports.projection.listRequirementRows({
      task_id: taskId,
      branch_id: branchId,
      watermark: atWatermark,
    });
    if (!rows.ok) return rows;

    const inherited: InheritedRequirementRef[] = [];
    for (const row of rows.value) {
      if (!isRevisionValidAt(row, atWatermark)) continue;
      if (row.status !== "active" && row.status !== "proposed") continue;
      const scope = parseRequirementScopeText(row.scope_json);
      if (scope === null) return schemaError<readonly InheritedRequirementRef[]>("scope_json", "parseable");
      const acceptance = parseAcceptanceText(row.acceptance_json);
      if (acceptance === null) {
        return schemaError<readonly InheritedRequirementRef[]>("acceptance_json", "parseable");
      }
      inherited.push({
        requirement_id: row.requirement_id,
        revision: row.revision,
        status: row.status,
        statement_ref: row.statement_ref,
        statement_text_hash: row.statement_text_hash,
        scope,
        acceptance,
      });
    }
    return ledgerOk(inherited);
  }
}
