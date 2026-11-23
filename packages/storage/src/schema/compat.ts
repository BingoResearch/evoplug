/**
 * Schema migration classification and compatibility checks (DD-FND-063).
 *
 * A minor migration may only add tables, nullable columns, columns with a
 * default, indexes or views. Any destructive or reinterpreting change requires
 * a new schema major. These helpers are pure: they never read the database and
 * never decide what the current binary happens to support.
 */

import type { Hash } from "@evoplug/core";

type SchemaChangeKind =
  | "add_table"
  | "add_nullable_column"
  | "add_column_with_default"
  | "add_index"
  | "add_view"
  | "delete"
  | "rename"
  | "change_type"
  | "tighten_enum"
  | "semantic_change";

/** How a single schema change affects the schema major. */
type SchemaChangeClass = "minor" | "major";

interface SchemaChange {
  readonly kind: SchemaChangeKind;
  /** Required for column additions; a NOT NULL column needs a default. */
  readonly nullable?: boolean;
  readonly has_default?: boolean;
}

/**
 * Classifies one change against DD-FND-063 rule 1.
 *
 * Only the additive kinds are minor. An unknown kind, or a NOT NULL column
 * without a default, is treated as major so an unproven change can never ride
 * along inside a minor migration.
 */
export function classifyMigrationChange(change: SchemaChange): SchemaChangeClass {
  switch (change.kind) {
    case "add_table":
    case "add_index":
    case "add_view":
      return "minor";
    case "add_nullable_column":
      return "minor";
    case "add_column_with_default":
      return change.has_default === true ? "minor" : "major";
    case "delete":
    case "rename":
    case "change_type":
    case "tighten_enum":
    case "semantic_change":
      return "major";
    default:
      return "major";
  }
}

type SchemaCompatibilityReason =
  | "E_SCHEMA_MAJOR_UNSUPPORTED"
  | "E_SCHEMA_COMPAT_UNPROVEN"
  | "E_SCHEMA_MIGRATION_DESTRUCTIVE";

type SchemaCompatibilityVerdict =
  | {
      readonly compatible: true;
      /** `current` for an equal major, `import` for a proven older major. */
      readonly disposition: "current" | "import";
      readonly requires_import: boolean;
    }
  | {
      readonly compatible: false;
      readonly reason_code: SchemaCompatibilityReason;
    };

interface SchemaCompatibilityRequest {
  /** Major recorded in the source database. */
  readonly from_major: number;
  /** Major carried by the current binary. */
  readonly to_major: number;
  /** Planned same-major changes; empty for a read-only version check. */
  readonly changes?: readonly SchemaChange[];
  /**
   * Import manifest hash recorded by `schema_meta`. An older source major is
   * only compatible when the import was explicitly proven.
   */
  readonly import_manifest_hash?: Hash | null;
}

/**
 * Verifies a source/target schema pair without reading persisted state.
 *
 * - equal majors accept only minor changes;
 * - an older source major requires an import manifest (`E_SCHEMA_COMPAT_UNPROVEN`);
 * - a newer source major is unsupported for this binary.
 */
export function verifySchemaCompatibility(
  input: SchemaCompatibilityRequest
): SchemaCompatibilityVerdict {
  const changes = input.changes ?? [];
  if (input.to_major < input.from_major) {
    return { compatible: false, reason_code: "E_SCHEMA_MAJOR_UNSUPPORTED" };
  }
  if (changes.some((change) => classifyMigrationChange(change) === "major")) {
    return { compatible: false, reason_code: "E_SCHEMA_MIGRATION_DESTRUCTIVE" };
  }
  if (input.to_major === input.from_major) {
    return { compatible: true, disposition: "current", requires_import: false };
  }
  const manifest = input.import_manifest_hash ?? null;
  if (manifest === null) {
    return { compatible: false, reason_code: "E_SCHEMA_COMPAT_UNPROVEN" };
  }
  return { compatible: true, disposition: "import", requires_import: true };
}
