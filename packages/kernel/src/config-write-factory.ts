/**
 * W10 kernel facade over the FND config-write port.
 *
 * `@evoplug/auth` is a kernel dependency; the app layer is not. This module is
 * the only place the app composition reaches `createConfigWritePort` and the
 * `config_write_result` read projection.
 */

import { authError, createConfigWritePort } from "@evoplug/auth";
import type {
  ConfigPatchApplyPort,
  ConfigWritePort,
  ConfigWriteReadPort,
  ConfigWriteResult,
  ErrorEnvelope,
  Result,
  RootResolver
} from "@evoplug/core";
import { err, ok } from "@evoplug/core";
import type { BlobStore, JournalCommitter, SqliteConnection, SqlRow } from "@evoplug/storage";

/** Structural mirror of the auth dependency bag with core/storage types only. */
interface KernelConfigWritePortDeps {
  readonly connection: SqliteConnection;
  readonly blob_store: BlobStore;
  readonly now: () => number;
  readonly monotonic?: () => number;
  readonly journal?: JournalCommitter;
  readonly root_resolver?: RootResolver;
  readonly apply_port?: ConfigPatchApplyPort;
  readonly holder_client_id?: string;
}

export function createKernelConfigWritePort(deps: KernelConfigWritePortDeps): ConfigWritePort {
  return createConfigWritePort(deps);
}

function notFoundWrite(): ErrorEnvelope {
  return authError({
    code: "E_WRITE_CONFIG_NOT_FOUND",
    stage: "config_read",
    details: { kind: "none" }
  });
}

interface WriteResultRow extends SqlRow {
  readonly config_write_id: string;
  readonly candidate_id: string;
  readonly candidate_hash: string;
  readonly attempt: number;
  readonly state: string;
  readonly path: string;
  readonly candidate_content_hash: string | null;
  readonly new_file_hash: string | null;
  readonly new_semantic_hash: string | null;
  readonly snapshot_id: string | null;
  readonly readback_verified: number;
  readonly protected_subtrees_verified: number;
  readonly atomicity: string;
  readonly exclusion: string;
  readonly error_code: string | null;
  readonly completed_at: number;
}

/**
 * Read projection for `config_write_result`. The trial service uses it to walk
 * trial -> attempt -> write result -> snapshot during rollback resolution.
 */
export function createKernelConfigWriteReadPort(connection: SqliteConnection): ConfigWriteReadPort {
  return {
    async getConfigWrite(input): Promise<Result<ConfigWriteResult, ErrorEnvelope>> {
      const row = connection
        .prepare<WriteResultRow>(
          `SELECT config_write_id, candidate_id, candidate_hash, attempt, state, path,
                  candidate_content_hash, new_file_hash, new_semantic_hash, snapshot_id,
                  readback_verified, protected_subtrees_verified, atomicity, exclusion,
                  error_code, completed_at
             FROM config_write_result
            WHERE config_write_id = ?
            ORDER BY attempt DESC
            LIMIT 1`
        )
        .get([input.config_write_id]);
      if (row === undefined) {
        return err(notFoundWrite(), "rejected");
      }
      return ok({
        schema_version: "rsi.config_write_result/1",
        config_write_id: row.config_write_id as ConfigWriteResult["config_write_id"],
        candidate_id: row.candidate_id as ConfigWriteResult["candidate_id"],
        candidate_hash: row.candidate_hash as ConfigWriteResult["candidate_hash"],
        attempt: row.attempt,
        state: row.state as ConfigWriteResult["state"],
        path: row.path,
        candidate_content_hash: row.candidate_content_hash as ConfigWriteResult["candidate_content_hash"],
        new_file_hash: row.new_file_hash as ConfigWriteResult["new_file_hash"],
        new_semantic_hash: row.new_semantic_hash as ConfigWriteResult["new_semantic_hash"],
        snapshot_id: row.snapshot_id as ConfigWriteResult["snapshot_id"],
        readback_verified: row.readback_verified === 1,
        protected_subtrees_verified: row.protected_subtrees_verified === 1,
        atomicity: row.atomicity as ConfigWriteResult["atomicity"],
        exclusion: row.exclusion as ConfigWriteResult["exclusion"],
        error_code: row.error_code,
        completed_at: row.completed_at
      });
    }
  };
}
