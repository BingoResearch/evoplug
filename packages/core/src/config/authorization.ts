/**
 * Authorization and forbidden surfaces (DD-CFG-036, DD-CFG-080 … DD-CFG-085,
 * DD-CFG-187).
 *
 * Credentials, permissions, sandbox, managed policy, shared budget and evoplug
 * acceptance policy are never writable, even with a syntactically valid grant.
 * Deny rules match whole path segments; substring matching is forbidden so
 * `model_auto_compact_token_limit` is never mistaken for a credential.
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { ConfigPath } from "./types.js";
import type {
  AuthorizationClass,
  ConfigGrantScope,
  ConfigResult,
  ConfigSpaceSelector,
  DenyRule,
  ExecutionKind,
  FieldSpec,
  ModelScopeKey
} from "./types.js";
import { configError, fail, succeed } from "./errors.js";
import { computeScopeHash, type ScopeGrantBinding, type ScopeHashInput } from "./hash.js";

/** Classes that never enter a factor, grant or write path (DD-CFG-082). */
const FORBIDDEN_CLASSES: readonly AuthorizationClass[] = [
  "forbidden_credentials",
  "forbidden_permissions",
  "forbidden_sandbox",
  "forbidden_shared_budget",
  "forbidden_evoplug_policy",
  "forbidden_managed_policy"
];

export function isForbiddenClass(value: AuthorizationClass): boolean {
  return FORBIDDEN_CLASSES.includes(value);
}

/* ------------------------------------------------------------------ */
/* Deny rules (DD-CFG-083)                                             */
/* ------------------------------------------------------------------ */

function pathPrefix(ruleId: string, segments: readonly string[], cls: AuthorizationClass): DenyRule {
  return {
    rule_id: ruleId,
    authorization_class: cls as Exclude<AuthorizationClass, "trialable" | "host_capacity">,
    match: { kind: "path_prefix", segments }
  };
}

function pathExact(ruleId: string, segments: readonly string[], cls: AuthorizationClass): DenyRule {
  return {
    rule_id: ruleId,
    authorization_class: cls as Exclude<AuthorizationClass, "trialable" | "host_capacity">,
    match: { kind: "path_exact", segments }
  };
}

function envName(ruleId: string, name: string, cls: AuthorizationClass): DenyRule {
  return {
    rule_id: ruleId,
    authorization_class: cls as Exclude<AuthorizationClass, "trialable" | "host_capacity">,
    match: { kind: "env_name", name }
  };
}

const CREDENTIAL_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "STEP_API_KEY",
  "OPENROUTER_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN"
];

/** Closed, segment-exact deny set shipped with every registry snapshot. */
export function defaultDenyRules(): readonly DenyRule[] {
  const rules: DenyRule[] = [
    pathPrefix("deny.api_key", ["api_key"], "forbidden_credentials"),
    pathPrefix("deny.apiKey", ["apiKey"], "forbidden_credentials"),
    pathPrefix("deny.secret", ["secret"], "forbidden_credentials"),
    pathPrefix("deny.password", ["password"], "forbidden_credentials"),
    pathExact("deny.authorization_header", ["headers", "Authorization"], "forbidden_credentials"),
    pathExact("deny.authorization_header_lower", ["headers", "authorization"], "forbidden_credentials"),
    pathPrefix("deny.permissions", ["permissions"], "forbidden_permissions"),
    pathExact("deny.approval_policy", ["approval_policy"], "forbidden_permissions"),
    pathExact("deny.approval_mode", ["approval_mode"], "forbidden_permissions"),
    pathPrefix("deny.sandbox", ["sandbox"], "forbidden_sandbox"),
    pathPrefix("deny.managed", ["managed"], "forbidden_managed_policy"),
    pathPrefix("deny.mcp_servers", ["mcp_servers"], "forbidden_managed_policy"),
    pathPrefix("deny.hooks", ["hooks"], "forbidden_permissions"),
    pathPrefix("deny.evoplug_budget", ["evoplug", "budget"], "forbidden_shared_budget"),
    pathPrefix("deny.evoplug_policy", ["evoplug", "policy"], "forbidden_evoplug_policy"),
    pathPrefix("deny.evoplug_acceptance", ["evoplug", "acceptance"], "forbidden_evoplug_policy")
  ];
  for (const [index, name] of CREDENTIAL_ENV_NAMES.entries()) {
    rules.push(envName(`deny.env.${String(index).padStart(2, "0")}.${name.toLowerCase()}`, name, "forbidden_credentials"));
  }
  return rules.sort((left, right) => (left.rule_id < right.rule_id ? -1 : left.rule_id > right.rule_id ? 1 : 0));
}

/**
 * The configuration field path segments a deny rule matches against.
 *
 * A deny rule names the field path inside the configuration document
 * (`mcp_servers`, `evoplug.budget`), not the file it lives in. The file
 * location (root and relative path) is a separate coordinate and is not part
 * of the matched segments (DD-CFG-083).
 */
export function pathSegments(path: ConfigPath): readonly string[] {
  switch (path.kind) {
    case "file":
      return pointerSegments(path.pointer);
    case "settings_api":
      return [...path.key_path];
    case "setter":
      return [path.setter_id];
    case "env":
      return [path.name];
  }
}

function pointerSegments(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function segmentPrefixMatches(prefix: readonly string[], segments: readonly string[]): boolean {
  if (prefix.length > segments.length) {
    return false;
  }
  return prefix.every((segment, index) => segments[index] === segment);
}

function denyRuleMatches(rule: DenyRule, path: ConfigPath): boolean {
  switch (rule.match.kind) {
    case "env_name":
      return path.kind === "env" && path.name === rule.match.name;
    case "path_exact":
      return (
        rule.match.segments.length === pathSegments(path).length &&
        segmentPrefixMatches(rule.match.segments, pathSegments(path))
      );
    case "path_prefix":
      return segmentPrefixMatches(rule.match.segments, pathSegments(path));
  }
}

/** Returns the first matching deny rule, or null. Order follows `rule_id`. */
export function matchDenyRule(rules: readonly DenyRule[], path: ConfigPath): DenyRule | null {
  for (const rule of rules) {
    if (denyRuleMatches(rule, path)) {
      return rule;
    }
  }
  return null;
}

/**
 * Authorization gate for staging one factor field (DD-CFG-033, DD-CFG-036).
 * Status and forbidden class are separate axes; both must pass.
 */
export function checkFieldStagedForTrial(
  spec: FieldSpec,
  path: ConfigPath,
  denyRules: readonly DenyRule[]
): ConfigResult<void> {
  if (isForbiddenClass(spec.authorization_class)) {
    return fail(configError("E_CFG_FORBIDDEN_FIELD", { field_id: spec.field_id }));
  }
  const denied = matchDenyRule(denyRules, path);
  if (denied !== null) {
    return fail(
      configError("E_CFG_FORBIDDEN_FIELD", {
        field_id: spec.field_id,
        details: [{ key: "deny_rule", value: denied.rule_id }]
      })
    );
  }
  if (spec.value_schema.kind === "unverified") {
    return fail(configError("E_CFG_FIELD_NOT_EXECUTABLE", { field_id: spec.field_id }));
  }
  if (spec.status !== "active") {
    return fail(
      configError("E_CFG_FIELD_NOT_EXECUTABLE", {
        field_id: spec.field_id,
        details: [
          { key: "status", value: spec.status },
          { key: "status_reason", value: spec.status_reason }
        ]
      })
    );
  }
  if (spec.mapping !== "exact") {
    return fail(
      configError("E_CFG_CAPABILITY_UNVERIFIED", {
        field_id: spec.field_id,
        details: [{ key: "mapping", value: spec.mapping }]
      })
    );
  }
  return succeed(undefined);
}

/* ------------------------------------------------------------------ */
/* Grant checks (DD-CFG-080, DD-CFG-081)                               */
/* ------------------------------------------------------------------ */

type ConfigGrantAction = "update" | "rollback";

interface GrantCheckInput {
  grant: {
    grant_id: Id<"grant">;
    object_type: string;
    object_id: string;
    actions: readonly string[];
    mode: "once" | "standing";
    candidate_id: string | null;
    candidate_hash: Hash | null;
    expires_at: number | null;
    revoked_at: number | null;
    scope: { config_scope?: { field_ids: readonly string[]; source_layer_ids: readonly string[]; model_scope_keys: readonly string[] } | undefined };
  } | null;
  action: ConfigGrantAction;
  now: number;
  config_space_id: Hash;
  candidate_id: Id<"ctr">;
  expected_patch_hash: Hash | null;
  field_ids: readonly Id<"fld">[];
  source_layer_id: string;
  model_scope_key: ModelScopeKey;
  capacity_trial: boolean;
  require_capacity: boolean;
}

/**
 * Validates one config grant. `null` (missing) and scope mismatches are
 * distinct codes; expired/revoked is a scope failure too (DD-CFG-081).
 */
export function checkConfigGrant(input: GrantCheckInput): ConfigResult<void> {
  const grant = input.grant;
  if (grant === null) {
    return fail(configError("E_CFG_AUTHORIZATION_MISSING"));
  }
  if (grant.object_type !== "config") {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "object_type", value: grant.object_type }] }));
  }
  if (grant.mode !== "once") {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "mode", value: grant.mode }] }));
  }
  if (!grant.actions.includes(input.action)) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "action", value: input.action }] }));
  }
  if (grant.revoked_at !== null || (grant.expires_at !== null && grant.expires_at <= input.now)) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "grant_state", value: "expired_or_revoked" }] }));
  }
  if (grant.object_id !== input.config_space_id) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "object_id", value: "config_space_mismatch" }] }));
  }
  if (grant.candidate_id !== input.candidate_id) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "candidate_id", value: "candidate_mismatch" }] }));
  }
  const expectedHash = input.expected_patch_hash;
  if (expectedHash !== null && grant.candidate_hash !== expectedHash) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "candidate_hash", value: "patch_mismatch" }] }));
  }
  const configScope = grant.scope.config_scope;
  if (configScope === undefined) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "config_scope", value: "missing" }] }));
  }
  for (const fieldId of input.field_ids) {
    if (!configScope.field_ids.includes(fieldId)) {
      return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { field_id: fieldId, details: [{ key: "dimension", value: "field_id" }] }));
    }
  }
  if (!configScope.source_layer_ids.includes(input.source_layer_id)) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "source_layer_id" }] }));
  }
  if (!configScope.model_scope_keys.includes(input.model_scope_key)) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "model_scope_key" }] }));
  }
  if (input.require_capacity && !input.capacity_trial) {
    return fail(configError("E_CFG_AUTHORIZATION_SCOPE", { details: [{ key: "dimension", value: "capacity_trial" }] }));
  }
  return succeed(undefined);
}

/** Grants required by an execution kind (DD-CFG-080, DD-CFG-112). */
export function requiredGrantActions(kind: ExecutionKind): readonly ConfigGrantAction[] {
  switch (kind) {
    case "write_and_observe":
      return ["update", "rollback"];
    case "observe_only":
      return [];
    case "rollback_only":
      return ["rollback"];
  }
}

/** Authorization class needs `capacity_trial=true` and the W2 window. */
export function requiresCapacityGrant(spec: FieldSpec): boolean {
  return spec.authorization_class === "host_capacity";
}

/* ------------------------------------------------------------------ */
/* scope_hash (DD-CFG-187)                                             */
/* ------------------------------------------------------------------ */

interface ScopeHashInputs {
  plan_id: Id<"trial">;
  plan_hash: Hash;
  trial_id: Id<"ctr">;
  candidate_id: Id<"ctr">;
  selector: ConfigSpaceSelector;
  requirement: {
    field_ids: readonly Id<"fld">[];
    source_layer_ids: readonly string[];
    model_scope_key: ModelScopeKey;
    config_space_id: Hash;
  };
  update: ScopeGrantBinding | null;
  update_scope: ConfigGrantScope | null;
  rollback: ScopeGrantBinding | null;
  rollback_scope: ConfigGrantScope | null;
}

/**
 * Union of present grant scopes, falling back to the plan requirement when a
 * kind has no grant. `object_id` is the config-space id.
 */
function buildScopeHashInput(input: ScopeHashInputs): ScopeHashInput {
  const fieldIds = new Set<Id<"fld">>();
  const layerIds = new Set<string>();
  const modelKeys = new Set<ModelScopeKey>();
  const scopes: ConfigGrantScope[] = [];
  if (input.update !== null && input.update_scope !== null) {
    scopes.push(input.update_scope);
  }
  if (input.rollback !== null && input.rollback_scope !== null) {
    scopes.push(input.rollback_scope);
  }
  if (scopes.length === 0) {
    for (const id of input.requirement.field_ids) {
      fieldIds.add(id);
    }
    for (const id of input.requirement.source_layer_ids) {
      layerIds.add(id);
    }
    modelKeys.add(input.requirement.model_scope_key);
  } else {
    for (const scope of scopes) {
      for (const id of scope.field_ids) {
        fieldIds.add(id);
      }
      for (const id of scope.source_layer_ids) {
        layerIds.add(id);
      }
      for (const key of scope.model_scope_keys) {
        modelKeys.add(key);
      }
    }
  }
  return {
    plan_id: input.plan_id,
    plan_hash: input.plan_hash,
    trial_id: input.trial_id,
    candidate_id: input.candidate_id,
    object_id: input.requirement.config_space_id,
    field_ids: [...fieldIds],
    source_layer_ids: [...layerIds],
    model_scope_keys: [...modelKeys],
    update: input.update,
    rollback: input.rollback
  };
}

export function scopeHashFor(input: ScopeHashInputs): Hash {
  return computeScopeHash(buildScopeHashInput(input));
}
