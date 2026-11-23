/**
 * Runtime feature flags and their resolved product configuration (W11).
 *
 * A flag is a *permission to activate* a capability, never the capability
 * itself. The closed set is reported by `system.describe` and persisted in the
 * product config (`config.features`). Two homes with the same flags resolve to
 * the same booleans; an unknown name is rejected instead of silently treated
 * as off, because a typo would otherwise disable a requested capability.
 *
 * The ten W11 flags default to off. The six pre-W11 labels were retired: an
 * old home may still carry them in `config.features`, so parsing and bootstrap
 * keep accepting them and resolution ignores them, while `system.describe`
 * reports only the active closed set.
 */

import { makeErrorEnvelope, type ErrorEnvelope } from "@evoplug/core";

/** Closed feature-flag set reported by `system.describe`. */
export type FeatureFlag =
  | "runtime_probe"
  | "fresh_home_admission"
  | "dispatch_short_circuit"
  | "evidence_supplement"
  | "delivery_ttl"
  | "feedback_ledger"
  | "experience_retrieval"
  | "rollback_resolution"
  | "cli_generation"
  | "config_autotune"
  | "active_replay"
  | "semantic_judge"
  | "managed_blocks";

/**
 * Pre-W11 labels kept only for compatibility with old homes. They never gate
 * a capability and are never reported by `system.describe`.
 */
export type LegacyFeatureFlag =
  | "online_judge"
  | "review_worker"
  | "egress"
  | "managed_write"
  | "config_write"
  | "replay";

export const LEGACY_FEATURE_FLAGS: readonly LegacyFeatureFlag[] = Object.freeze([
  "online_judge",
  "review_worker",
  "egress",
  "managed_write",
  "config_write",
  "replay"
]);

/**
 * Any flag name accepted from a caller or a persisted config. Resolution drops
 * the legacy names; the public closed set is `FeatureFlag`.
 */
export type ConfiguredFeatureFlag = FeatureFlag | LegacyFeatureFlag;

export const FEATURE_FLAGS: readonly FeatureFlag[] = Object.freeze([
  "runtime_probe",
  "fresh_home_admission",
  "dispatch_short_circuit",
  "evidence_supplement",
  "delivery_ttl",
  "feedback_ledger",
  "experience_retrieval",
  "rollback_resolution",
  "cli_generation",
  "config_autotune",
  "active_replay",
  "semantic_judge",
  // Appendix Q.1: the first release generates and adopts skills only.
  // Memory and instructions stay behind this flag (default off).
  "managed_blocks"
]);
export type ResolvedFeatures = Readonly<Record<FeatureFlag, boolean>>;

/** Mode of the deterministic dispatch short-circuit (W3). */
export type DispatchMode = "off" | "shadow" | "enforce";

/** Default when the flag is on but no explicit mode is configured. */
export const DEFAULT_DISPATCH_MODE: DispatchMode = "shadow";

export function isFeatureFlag(value: unknown): value is FeatureFlag {
  return typeof value === "string" && (FEATURE_FLAGS as readonly string[]).includes(value);
}

export function isLegacyFeatureFlag(value: unknown): value is LegacyFeatureFlag {
  return (
    typeof value === "string" &&
    (LEGACY_FEATURE_FLAGS as readonly string[]).includes(value)
  );
}

export function isConfiguredFeatureFlag(value: unknown): value is ConfiguredFeatureFlag {
  return isFeatureFlag(value) || isLegacyFeatureFlag(value);
}

/**
 * Resolves a flag list to a complete boolean record.
 *
 * Duplicates collapse. Retired pre-W11 names are accepted and ignored so an
 * old home keeps booting with the same effective capabilities. An unknown name
 * throws: the config validator rejects it earlier, so reaching this point with
 * an unknown name is a programming error, not a user preference.
 */
export function resolveFeatures(
  flags: readonly ConfiguredFeatureFlag[]
): ResolvedFeatures {
  const enabled = new Set<string>();
  for (const flag of flags) {
    if (isLegacyFeatureFlag(flag)) {
      continue;
    }
    if (!isFeatureFlag(flag)) {
      throw new TypeError(`unknown feature flag: ${String(flag)}`);
    }
    enabled.add(flag);
  }
  const resolved = {} as Record<FeatureFlag, boolean>;
  for (const flag of FEATURE_FLAGS) {
    resolved[flag] = enabled.has(flag);
  }
  return Object.freeze(resolved);
}

/**
 * Effective dispatch mode from the flag plus the optional config block.
 *
 *   flag off                                   -> "off" (config is inert)
 *   flag on,  dispatch.short_circuit = true    -> "enforce"
 *   flag on,  dispatch.short_circuit absent    -> config mode, default "shadow"
 *
 * `short_circuit=true` always enforces because the key states the operator
 * wants decisions acted on; the mode only refines the flag-on, key-absent case.
 */
export function resolveDispatchMode(
  features: ResolvedFeatures,
  dispatch?: { readonly short_circuit?: boolean; readonly mode?: DispatchMode }
): DispatchMode {
  if (!features.dispatch_short_circuit) {
    return "off";
  }
  if (dispatch?.short_circuit === true) {
    return "enforce";
  }
  return dispatch?.mode ?? DEFAULT_DISPATCH_MODE;
}

/**
 * The single rejection shape for a subsystem whose feature flag is off.
 *
 * Callers branch on `E_DISABLED`; the reason string names the flag and the
 * stable `feature_not_enabled` rule. No state is written before this is
 * returned, and the subsystem must not start a process or touch the network.
 */
export function featureDisabledError(feature: FeatureFlag): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_DISABLED",
    category: "policy",
    message_key: "error.disabled",
    stage: "feature_gate",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path: `feature.${feature}`, rule: "feature_not_enabled" }
  });
}
