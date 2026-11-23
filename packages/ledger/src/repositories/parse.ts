import type { ErrorEnvelope, Id, MethodRef, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type { AcceptanceCriterion, RequirementScope } from "../domain/requirements.js";
import { ledgerOk, schemaError } from "../errors.js";
import { isSourceRef } from "../source-ref.js";
import { isHash } from "../raw-hash.js";

/** JSON parsers for state-row text columns. `null` means malformed. */
export function parseJsonValueText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const parsed = parseJsonValueText(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export function parseJsonArrayStrings(text: string): string[] | null {
  const parsed = parseJsonValueText(text);
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

export function parseSourceRefArray(text: string): SourceRef[] | null {
  const values = parseJsonArrayStrings(text);
  if (values === null) return null;
  const out: SourceRef[] = [];
  for (const value of values) {
    if (!isSourceRef(value)) return null;
    out.push(value);
  }
  return out;
}

export function parseBindingFromJson(text: string): VersionBinding | null {
  const record = parseJsonObject(text);
  if (record === null) return null;
  const taskId = record["task_id"];
  const branchId = record["branch_id"];
  const inputEpoch = record["input_epoch"];
  const goalVersion = record["goal_version"];
  const configVersion = record["config_version"];
  const watermark = record["watermark"];
  if (
    typeof taskId !== "string" ||
    typeof branchId !== "string" ||
    typeof inputEpoch !== "number" ||
    !Number.isSafeInteger(inputEpoch) ||
    inputEpoch < 1 ||
    typeof goalVersion !== "string" ||
    typeof configVersion !== "string" ||
    typeof watermark !== "number" ||
    !Number.isSafeInteger(watermark) ||
    watermark < 0
  ) {
    return null;
  }
  return {
    task_id: taskId as Id<"task">,
    branch_id: branchId as Id<"br">,
    input_epoch: inputEpoch,
    goal_version: goalVersion,
    config_version: configVersion,
    watermark,
  };
}

export function parseScopeFromJson(text: string): RequirementScope | null {
  const record = parseJsonObject(text);
  if (record === null) return null;
  const paths = record["paths"];
  const hosts = record["hosts"];
  const modes = record["modes"];
  const projectIds = record["project_ids"];
  if (!Array.isArray(paths) || !Array.isArray(hosts) || !Array.isArray(modes) || !Array.isArray(projectIds)) {
    return null;
  }
  if (!paths.every((item): item is string => typeof item === "string")) return null;
  if (!hosts.every((item): item is string => typeof item === "string")) return null;
  if (!projectIds.every((item): item is string => typeof item === "string")) return null;
  const parsedModes: Array<"online" | "review" | "trial" | "global"> = [];
  for (const mode of modes) {
    if (mode === "online" || mode === "review" || mode === "trial" || mode === "global") {
      parsedModes.push(mode);
    } else {
      return null;
    }
  }
  return { paths, hosts, modes: parsedModes, project_ids: projectIds };
}

export function parseAcceptanceFromJson(text: string): AcceptanceCriterion[] | null {
  const parsed = parseJsonValueText(text);
  if (!Array.isArray(parsed)) return null;
  const out: AcceptanceCriterion[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const kind = record["kind"];
    if (kind === "human_acceptance" && typeof record["source_ref"] === "string") {
      if (!isSourceRef(record["source_ref"])) return null;
      out.push({ kind, source_ref: record["source_ref"] });
    } else if (
      kind === "test_pass" &&
      typeof record["command"] === "string" &&
      typeof record["cwd"] === "string"
    ) {
      out.push({ kind, command: record["command"], cwd: record["cwd"] });
    } else if (kind === "artifact_check" && typeof record["path"] === "string") {
      const expected = record["expected_hash"];
      if (expected === undefined) {
        out.push({ kind, path: record["path"] });
      } else if (typeof expected === "string" && isHash(expected)) {
        out.push({ kind, path: record["path"], expected_hash: expected });
      } else {
        return null;
      }
    } else if (
      kind === "external_verification" &&
      typeof record["verifier"] === "string" &&
      typeof record["evidence_ref"] === "string"
    ) {
      if (!isSourceRef(record["evidence_ref"])) return null;
      out.push({
        kind,
        verifier: record["verifier"],
        evidence_ref: record["evidence_ref"],
      });
    } else {
      return null;
    }
  }
  return out;
}

export function parseMethodRefFromJson(text: string): MethodRef | null {
  const record = parseJsonObject(text);
  if (record === null) return null;
  if (
    record["schema_version"] !== "rsi.method_ref/1" ||
    typeof record["method_id"] !== "string" ||
    typeof record["method_version"] !== "string" ||
    typeof record["rule_version"] !== "string"
  ) {
    return null;
  }
  return {
    schema_version: "rsi.method_ref/1",
    method_id: record["method_id"],
    method_version: record["method_version"],
    rule_version: record["rule_version"],
  };
}

/** Wraps a parse failure as `E_SCHEMA` for write-path callers. */
export function requireParsed<T>(value: T | null, path: string): Result<T, ErrorEnvelope> {
  return value === null ? schemaError<T>(path, "parseable") : ledgerOk(value);
}
