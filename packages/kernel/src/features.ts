/**
 * Runtime feature flags and their resolved product configuration (W11).
 *
 * A flag is a *permission to activate* a capability, never the capability
 * itself. The closed set is reported by `system.describe` and persisted in the
 * product config (`config.features`). Two homes with the same flags resolve to
 * the same booleans; an unknown name is rejected instead of silently treated
 * as off, because a typo would otherwise disable a requested capability.
 *
 * The six original flags keep their pre-W11 defaults at the bootstrap layer
 * (`apps/kernel/src/bootstrap.ts`). The ten W11 flags default to off.
 */

/**
 * Closed feature-flag set.
 *
 * Order is part of the public description: the original six first, then the
 * W11 capabilities.
 */
export type FeatureFlag =
  | "online_judge"
  | "review_worker"
  | "egress"
  | "managed_write"
  | "config_write"
  | "replay"
  | "runtime_probe"
  | "fresh_home_admission"
  | "dispatch_short_circuit"
  | "evidence_supplement"
  | "delivery_ttl"
  | "feedback_ledger"
  | "experience_retrieval"
  | "rollback_resolution"
  | "cli_generation"
  | "config_autotune";

export const FEATURE_FLAGS: readonly FeatureFlag[] = Object.freeze([
  "online_judge",
  "review_worker",
  "egress",
  "managed_write",
  "config_write",
  "replay",
  "runtime_probe",
  "fresh_home_admission",
  "dispatch_short_circuit",
  "evidence_supplement",
  "delivery_ttl",
  "feedback_ledger",
  "experience_retrieval",
  "rollback_resolution",
  "cli_generation",
  "config_autotune"
]);

export type ResolvedFeatures = Readonly<Record<FeatureFlag, boolean>>;

/** Mode of the deterministic dispatch short-circuit (W3). */
export type DispatchMode = "off" | "shadow" | "enforce";

/** Default when the flag is on but no explicit mode is configured. */
export const DEFAULT_DISPATCH_MODE: DispatchMode = "shadow";

export function isFeatureFlag(value: unknown): value is FeatureFlag {
  return typeof value === "string" && (FEATURE_FLAGS as readonly string[]).includes(value);
}

/**
 * Resolves a flag list to a complete boolean record.
 *
 * Duplicates collapse. An unknown name throws: the config validator rejects it
 * earlier, so reaching this point with an unknown name is a programming error,
 * not a user preference.
 */
export function resolveFeatures(flags: readonly FeatureFlag[]): ResolvedFeatures {
  const enabled = new Set<string>();
  for (const flag of flags) {
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

export function featureEnabled(features: ResolvedFeatures, name: FeatureFlag): boolean {
  return features[name] === true;
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
