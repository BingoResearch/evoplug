import type { ErrorEnvelope, Result, VersionBinding } from "@evoplug/core";
import { schemaError, ledgerOk } from "./errors.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "./util.js";

const GOAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CONFIG_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * Structural `VersionBinding` validation. Equality with the live branch row is
 * a separate check performed inside the write transaction.
 */
export function validateVersionBinding(
  binding: VersionBinding,
): Result<VersionBinding, ErrorEnvelope> {
  if (binding.task_id.length === 0) {
    return schemaError<VersionBinding>("binding.task_id", "non_empty");
  }
  if (binding.branch_id.length === 0) {
    return schemaError<VersionBinding>("binding.branch_id", "non_empty");
  }
  if (!isPositiveSafeInteger(binding.input_epoch)) {
    return schemaError<VersionBinding>("binding.input_epoch", "positive_safe_integer");
  }
  if (!GOAL_VERSION_PATTERN.test(binding.goal_version)) {
    return schemaError<VersionBinding>("binding.goal_version", "opaque_version_format");
  }
  if (!CONFIG_VERSION_PATTERN.test(binding.config_version)) {
    return schemaError<VersionBinding>("binding.config_version", "opaque_version_format");
  }
  if (!isNonNegativeSafeInteger(binding.watermark)) {
    return schemaError<VersionBinding>("binding.watermark", "non_negative_safe_integer");
  }
  return ledgerOk(binding);
}

/** Exact six-field equality; goal/config versions compare byte-for-byte. */
export function equalVersionBindings(a: VersionBinding, b: VersionBinding): boolean {
  return (
    a.task_id === b.task_id &&
    a.branch_id === b.branch_id &&
    a.input_epoch === b.input_epoch &&
    a.goal_version === b.goal_version &&
    a.config_version === b.config_version &&
    a.watermark === b.watermark
  );
}

/** Task/branch identity only, used for cross-binding visibility checks. */
export function sameTaskBranch(a: VersionBinding, b: VersionBinding): boolean {
  return a.task_id === b.task_id && a.branch_id === b.branch_id;
}

/**
 * Fact visibility under a read binding V: the creating binding F is visible
 * when its epoch and watermark do not exceed V's. Goal/config versions are not
 * compared because facts keep their creation versions.
 */
export function factVisibleUnder(created: VersionBinding, read: VersionBinding): boolean {
  return (
    created.task_id === read.task_id &&
    created.branch_id === read.branch_id &&
    created.input_epoch <= read.input_epoch &&
    created.watermark <= read.watermark
  );
}
