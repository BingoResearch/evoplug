/**
 * `WriteAdoptionReadPort` (DD-FND-091).
 *
 * `getAdoption` is the only read surface FND offers to REV's `recordAdoption`.
 * It reads the committed `write_intent` row, the `MAX(attempt)` `write_result`
 * row and the `authorization_grant` row the intent points at, in one read
 * transaction.
 *
 * The rules are strict and fail closed:
 *
 *   - a missing intent, result or grant answers `E_WRITE_NOT_FOUND`; there is
 *     no partial view and no synthesised result;
 *   - every returned field comes verbatim from the committed SQLite rows; the
 *     caller's proposal summary is never used to fill a gap;
 *   - the grant is projected onto `GrantPublicView`, so the raw
 *     `human_attestation` never reaches the caller;
 *   - the read creates no rows, no projections, no grant consumption and
 *     never refreshes a stale state.
 */

import { type ErrorEnvelope, type Id, type Result } from "@evoplug/core";
import type { SqliteConnection, SqlRow } from "@evoplug/storage";

import { fieldError } from "./errors.js";
import type {
  GrantPublicView,
  GrantScope
} from "./grants.js";
import type {
  WriteAdoptionView,
  WriteIntent,
  WriteIntentState,
  WriteResult
} from "./write-intent.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Row readers                                                         */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const WRITE_INTENT_STATES: ReadonlySet<string> = new Set([
  "intent_recorded",
  "snapshot_written",
  "temp_written",
  "renamed",
  "dir_synced",
  "verified",
  "pending_approval",
  "conflict",
  "path_rejected",
  "write_failed",
  "partial",
  "recovery_required"
]);

function stringField(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function numberField(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

function nullableStringField(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function nullableNumberField(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

function parseJson(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readWriteIntent(row: Row): WriteIntent | null {
  const writeId = stringField(row, "write_id");
  const idempotencyKey = stringField(row, "idempotency_key");
  const grantId = stringField(row, "grant_id");
  const action = stringField(row, "action");
  const objectType = stringField(row, "object_type");
  const candidateId = stringField(row, "candidate_id");
  const candidateHash = stringField(row, "candidate_hash");
  const binding = parseJson(stringField(row, "binding_json"));
  const scopeKind = stringField(row, "scope_kind");
  const scopeRefId = stringField(row, "scope_ref_id");
  const scopeHash = stringField(row, "scope_hash");
  const rootId = stringField(row, "root_id");
  const rootIdentityPin = parseJson(stringField(row, "root_identity_pin_json"));
  const rootRegistrationHash = stringField(row, "root_registration_hash");
  const targetPath = stringField(row, "target_path");
  const targetOwnership = stringField(row, "target_ownership");
  const writeMode = stringField(row, "write_mode");
  const blockAction = nullableStringField(row, "block_action");
  const blockSelector = nullableStringField(row, "block_selector");
  const expectedFileHash = nullableStringField(row, "expected_file_hash");
  const expectedBlockHash = nullableStringField(row, "expected_block_hash");
  const snapshotId = nullableStringField(row, "snapshot_id");
  const rollbackOfWriteId = nullableStringField(row, "rollback_of_write_id");
  const targetSnapshotId = nullableStringField(row, "target_snapshot_id");
  const targetSnapshotHash = nullableStringField(row, "target_snapshot_hash");
  const atomicity = stringField(row, "atomicity");
  const exclusion = stringField(row, "exclusion");
  const unattendedPolicy = stringField(row, "unattended_policy");
  const state = stringField(row, "state");
  const attempt = numberField(row, "attempt");
  const lastErrorCode = nullableStringField(row, "last_error_code");
  const rowVersion = numberField(row, "row_version");
  const createdAt = numberField(row, "created_at");
  const updatedAt = numberField(row, "updated_at");
  if (
    writeId === null ||
    idempotencyKey === null ||
    grantId === null ||
    action === null ||
    objectType === null ||
    candidateId === null ||
    candidateHash === null ||
    !isRecord(binding) ||
    scopeKind === null ||
    scopeRefId === null ||
    scopeHash === null ||
    rootId === null ||
    !isRecord(rootIdentityPin) ||
    rootRegistrationHash === null ||
    targetPath === null ||
    targetOwnership === null ||
    writeMode === null ||
    atomicity === null ||
    exclusion === null ||
    unattendedPolicy === null ||
    state === null ||
    !WRITE_INTENT_STATES.has(state) ||
    attempt === null ||
    rowVersion === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  if (objectType === "config") {
    return null;
  }
  return {
    schema_version: "rsi.write_intent/2",
    write_id: writeId as Id<"wi">,
    idempotency_key: idempotencyKey,
    grant_id: grantId as Id<"grant">,
    action: action as WriteIntent["action"],
    object_type: objectType as WriteIntent["object_type"],
    candidate_id: candidateId as WriteIntent["candidate_id"],
    candidate_hash: candidateHash as WriteIntent["candidate_hash"],
    binding: binding as unknown as WriteIntent["binding"],
    scope_kind: scopeKind as WriteIntent["scope_kind"],
    scope_ref_id: scopeRefId,
    project_id: nullableStringField(row, "project_id"),
    config_space_id: nullableStringField(row, "config_space_id"),
    scope_hash: scopeHash as WriteIntent["scope_hash"],
    root_id: rootId,
    root_identity_pin: rootIdentityPin as unknown as WriteIntent["root_identity_pin"],
    root_registration_hash: rootRegistrationHash as WriteIntent["root_registration_hash"],
    target_path: targetPath,
    target_ownership: targetOwnership as WriteIntent["target_ownership"],
    write_mode: writeMode as WriteIntent["write_mode"],
    block_action: blockAction as WriteIntent["block_action"],
    block_selector: blockSelector,
    expected_file_hash: expectedFileHash as WriteIntent["expected_file_hash"],
    expected_block_hash: expectedBlockHash as WriteIntent["expected_block_hash"],
    snapshot_id: snapshotId as WriteIntent["snapshot_id"],
    rollback_of_write_id: rollbackOfWriteId as WriteIntent["rollback_of_write_id"],
    target_snapshot_id: targetSnapshotId as WriteIntent["target_snapshot_id"],
    target_snapshot_hash: targetSnapshotHash as WriteIntent["target_snapshot_hash"],
    atomicity: atomicity as WriteIntent["atomicity"],
    exclusion: exclusion as WriteIntent["exclusion"],
    unattended_policy: unattendedPolicy as WriteIntent["unattended_policy"],
    state: state as WriteIntentState,
    attempt,
    last_error_code: lastErrorCode,
    row_version: rowVersion,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function readWriteResult(row: Row): WriteResult | null {
  const writeId = stringField(row, "write_id");
  const attempt = numberField(row, "attempt");
  const state = stringField(row, "state");
  const rootId = stringField(row, "root_id");
  const path = stringField(row, "path");
  const newFileHash = nullableStringField(row, "new_file_hash");
  const newBlockHash = nullableStringField(row, "new_block_hash");
  const snapshotId = nullableStringField(row, "snapshot_id");
  const targetSnapshotId = nullableStringField(row, "target_snapshot_id");
  const targetSnapshotHash = nullableStringField(row, "target_snapshot_hash");
  const threeWayDiffRef = nullableStringField(row, "three_way_diff_ref");
  const readbackVerified = numberField(row, "readback_verified");
  const atomicity = stringField(row, "atomicity");
  const exclusion = stringField(row, "exclusion");
  const unattendedPolicy = stringField(row, "unattended_policy");
  const errorCode = nullableStringField(row, "error_code");
  const completedAt = nullableNumberField(row, "completed_at");
  if (
    writeId === null ||
    attempt === null ||
    state === null ||
    !WRITE_INTENT_STATES.has(state) ||
    rootId === null ||
    path === null ||
    readbackVerified === null ||
    atomicity === null ||
    exclusion === null ||
    unattendedPolicy === null
  ) {
    return null;
  }
  return {
    schema_version: "rsi.write_result/2",
    write_id: writeId as Id<"wi">,
    attempt,
    state: state as WriteIntentState,
    root_id: rootId,
    path,
    new_file_hash: newFileHash as WriteResult["new_file_hash"],
    new_block_hash: newBlockHash as WriteResult["new_block_hash"],
    snapshot_id: snapshotId as WriteResult["snapshot_id"],
    target_snapshot_id: targetSnapshotId as WriteResult["target_snapshot_id"],
    target_snapshot_hash: targetSnapshotHash as WriteResult["target_snapshot_hash"],
    three_way_diff_ref: threeWayDiffRef as WriteResult["three_way_diff_ref"],
    readback_verified: readbackVerified === 1,
    atomicity: atomicity as WriteResult["atomicity"],
    exclusion: exclusion as WriteResult["exclusion"],
    unattended_policy: unattendedPolicy as WriteResult["unattended_policy"],
    error_code: errorCode,
    completed_at: completedAt
  };
}

/**
 * Projects the grant row onto `GrantPublicView`.
 *
 * The raw `human_attestation` column is read but never returned: the public
 * view carries the attestation-free fields only.
 */
function readGrantPublicView(row: Row): GrantPublicView | null {
  const grantId = stringField(row, "grant_id");
  const issuedBy = stringField(row, "issued_by");
  const subject = stringField(row, "subject");
  const objectType = stringField(row, "object_type");
  const scope = parseJson(stringField(row, "scope_json"));
  const actions = parseJson(stringField(row, "actions_json"));
  const mode = stringField(row, "mode");
  const candidateId = nullableStringField(row, "candidate_id");
  const candidateHash = nullableStringField(row, "candidate_hash");
  const policyVersion = stringField(row, "policy_version");
  const issuedAt = numberField(row, "issued_at");
  const expiresAt = nullableNumberField(row, "expires_at");
  const revokedAt = nullableNumberField(row, "revoked_at");
  const grantHash = stringField(row, "grant_hash");
  if (
    grantId === null ||
    issuedBy === null ||
    subject === null ||
    objectType === null ||
    !isRecord(scope) ||
    !Array.isArray(actions) ||
    mode === null ||
    policyVersion === null ||
    issuedAt === null ||
    grantHash === null
  ) {
    return null;
  }
  if (objectType === "config") {
    return null;
  }
  return {
    grant_id: grantId as Id<"grant">,
    issued_by: issuedBy as GrantPublicView["issued_by"],
    subject: "rsi",
    object_type: objectType as GrantPublicView["object_type"],
    scope: scope as unknown as GrantScope,
    actions: actions as GrantPublicView["actions"],
    mode: mode as GrantPublicView["mode"],
    candidate_id: candidateId as GrantPublicView["candidate_id"],
    candidate_hash: candidateHash as GrantPublicView["candidate_hash"],
    policy_version: policyVersion,
    issued_at: issuedAt,
    expires_at: expiresAt,
    revoked_at: revokedAt,
    grant_hash: grantHash as GrantPublicView["grant_hash"]
  };
}

/* ------------------------------------------------------------------ */
/* Read port                                                           */
/* ------------------------------------------------------------------ */

interface WriteAdoptionPortOptions {
  /** The single writer connection; the read runs in one read transaction. */
  readonly connection: SqliteConnection;
}

/**
 * Creates the FND `WriteAdoptionReadPort`.
 *
 * The implementation is a pure read: it opens one read transaction, selects
 * the three committed rows and projects them. It never writes, never consumes
 * a grant and never synthesises a missing row.
 */
export function createWriteAdoptionReadPort(
  options: WriteAdoptionPortOptions
): { getAdoption(write_id: Id<"wi">): Promise<Result<WriteAdoptionView, ErrorEnvelope>> } {
  return {
    async getAdoption(
      write_id: Id<"wi">
    ): Promise<Result<WriteAdoptionView, ErrorEnvelope>> {
      const notFound = (): Result<WriteAdoptionView, ErrorEnvelope> => ({
        ok: false,
        status: "rejected",
        error: fieldError("E_WRITE_NOT_FOUND", "write_id", "not_found")
      });
      let intentRow: Row | undefined;
      let resultRow: Row | undefined;
      let grantRow: Row | undefined;
      try {
        // One read transaction: the three rows are read from the same
        // snapshot, so a concurrent write cannot tear the view.
        options.connection.exec("BEGIN");
        try {
          intentRow = options.connection
            .prepare<SqlRow>("SELECT * FROM write_intent WHERE write_id = :write_id")
            .get({ write_id }) as Row | undefined;
          if (intentRow !== undefined) {
            resultRow = options.connection
              .prepare<SqlRow>(
                `SELECT * FROM write_result
                  WHERE write_id = :write_id
                  ORDER BY attempt DESC LIMIT 1`
              )
              .get({ write_id }) as Row | undefined;
            const grantId = stringField(intentRow, "grant_id");
            if (grantId !== null) {
              grantRow = options.connection
                .prepare<SqlRow>("SELECT * FROM authorization_grant WHERE grant_id = :grant_id")
                .get({ grant_id: grantId }) as Row | undefined;
            }
          }
        } finally {
          options.connection.exec("COMMIT");
        }
      } catch {
        return notFound();
      }
      if (intentRow === undefined || resultRow === undefined || grantRow === undefined) {
        return notFound();
      }
      const intent = readWriteIntent(intentRow);
      const result = readWriteResult(resultRow);
      const grant = readGrantPublicView(grantRow);
      if (intent === null || result === null || grant === null) {
        return notFound();
      }
      return {
        ok: true,
        status: "ok",
        value: {
          schema_version: "rsi.write_adoption_view/1",
          intent,
          result,
          grant
        }
      };
    }
  };
}

/**
 * Reads the adoption view of one `write_id` from an open connection.
 *
 * The convenience entry point for callers that hold the single writer
 * connection directly. It is the same read as
 * {@link createWriteAdoptionReadPort} and carries the same guarantees.
 */
export function getAdoption(
  connection: SqliteConnection,
  write_id: Id<"wi">
): Promise<Result<WriteAdoptionView, ErrorEnvelope>> {
  return createWriteAdoptionReadPort({ connection }).getAdoption(write_id);
}
