// runtime-manifest.json validation (DD-FND-023).
//
// The design fixes what the manifest must record (download URL, the official
// SHASUMS256.txt SHA-256, the kernel version and the package hash) but does not
// publish field names. The names below are the single schema this repository
// uses; see the implementation summary for the open question.

import { SUPPORTED_SQLITE_RANGES, isSupportedSqliteVersion, parseVersion } from "./sqlite-version.mjs";

export const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

export const RUNTIME_MANIFEST_FIELDS = Object.freeze({
  required: Object.freeze(["node_version", "download_url", "node_sha256", "kernel_version", "package_sha256"]),
  optional: Object.freeze(["schema_version", "sqlite_version", "published_at"])
});

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed runtime manifest. Unknown keys are rejected so a second
 * schema cannot appear silently.
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, errors: Array<{ field: string, message: string }> }}
 */
export function validateRuntimeManifest(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ field: "", message: "runtime manifest must be a JSON object" }] };
  }
  const known = new Set([...RUNTIME_MANIFEST_FIELDS.required, ...RUNTIME_MANIFEST_FIELDS.optional]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      errors.push({ field: key, message: "unknown runtime manifest field" });
    }
  }
  for (const field of RUNTIME_MANIFEST_FIELDS.required) {
    if (!(field in value)) {
      errors.push({ field, message: "required field is missing" });
    }
  }
  const nodeVersion = value.node_version;
  if (nodeVersion !== undefined && (typeof nodeVersion !== "string" || !VERSION_PATTERN.test(nodeVersion))) {
    errors.push({ field: "node_version", message: 'must be a "major.minor.patch" string' });
  }
  const downloadUrl = value.download_url;
  if (downloadUrl !== undefined) {
    let valid = typeof downloadUrl === "string";
    if (valid) {
      try {
        const parsed = new URL(downloadUrl);
        valid = parsed.protocol === "https:";
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      errors.push({ field: "download_url", message: "must be an absolute https URL" });
    }
  }
  for (const field of ["node_sha256", "package_sha256"]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (typeof fieldValue !== "string" || !SHA256_PATTERN.test(fieldValue))) {
      errors.push({ field, message: "must be 64 lowercase hex characters, optionally prefixed with sha256:" });
    }
  }
  const kernelVersion = value.kernel_version;
  if (kernelVersion !== undefined && (typeof kernelVersion !== "string" || kernelVersion.trim() === "")) {
    errors.push({ field: "kernel_version", message: "must be a non-empty string" });
  }
  if ("schema_version" in value && (typeof value.schema_version !== "string" || value.schema_version.trim() === "")) {
    errors.push({ field: "schema_version", message: "must be a non-empty string when present" });
  }
  if ("published_at" in value && (typeof value.published_at !== "string" || Number.isNaN(Date.parse(value.published_at)))) {
    errors.push({ field: "published_at", message: "must be an ISO-8601 timestamp string when present" });
  }
  if ("sqlite_version" in value) {
    if (typeof value.sqlite_version !== "string" || parseVersion(value.sqlite_version) === null) {
      errors.push({ field: "sqlite_version", message: 'must be a "major.minor.patch" string when present' });
    } else if (!isSupportedSqliteVersion(value.sqlite_version)) {
      errors.push({
        field: "sqlite_version",
        message: `unsupported SQLite version; accepted ranges are ${SUPPORTED_SQLITE_RANGES.join(", ")}`
      });
    }
  }
  return { ok: errors.length === 0, errors };
}
