/**
 * W10 reload evidence producer (D7).
 *
 * Reload channels are adapter declarations keyed by config space. The kernel
 * never branches on a host id: it selects the declared channel, calls the
 * adapter's real resolve function and freezes the result as an
 * `EffectiveProbe`. A `next_session` declaration is `unsupported`: a session
 * boundary is not effect evidence.
 */

import type {
  ConfigReloadDeclaration,
  ConfigReloadProbeInput,
  ConfigReloadProbePort,
  ConfigReloadProbeResult,
  ConfigResult,
  EffectiveProbe
} from "@evoplug/core/config";
import { configError, fail, succeed } from "@evoplug/core/config";

interface ConfigReloadProbeDeps {
  readonly declarations: readonly ConfigReloadDeclaration[];
  readonly now: () => number;
}

function declarationFor(
  declarations: readonly ConfigReloadDeclaration[],
  configSpaceId: string
): ConfigReloadDeclaration | null {
  return declarations.find((declaration) => declaration.config_space_id === configSpaceId) ?? null;
}

function sourceFor(
  kind: ConfigReloadProbeResult["evidence_kind"]
): EffectiveProbe["source"] {
  return kind === "config_watch" ? "runtime_log_resolved" : "host_resolved_config";
}

function isEvidenceKind(kind: ConfigReloadDeclaration["kind"]): kind is ConfigReloadProbeResult["evidence_kind"] {
  return kind === "sdk_reload" || kind === "new_process_parse" || kind === "config_watch";
}

export function createConfigReloadProbe(deps: ConfigReloadProbeDeps): ConfigReloadProbePort {
  return {
    async probe(input: ConfigReloadProbeInput): Promise<ConfigResult<ConfigReloadProbeResult>> {
      if (
        !Number.isSafeInteger(input.deadline_ms) ||
        input.deadline_ms < 1 ||
        input.deadline_ms > 600_000
      ) {
        return fail(
          configError("E_CFG_DEADLINE_EXCEEDED", {
            details: [{ key: "deadline_ms", value: input.deadline_ms }]
          })
        );
      }
      if (input.signal?.aborted === true) {
        return fail(configError("E_CFG_CANCELLED"));
      }
      const declaration = declarationFor(deps.declarations, input.config_space_id);
      if (declaration === null) {
        return fail(
          configError("E_CFG_APPLY_UNCONFIRMED", {
            details: [{ key: "reload", value: "declaration_missing" }]
          })
        );
      }
      if (!isEvidenceKind(declaration.kind)) {
        return fail(
          configError("E_CFG_APPLY_UNCONFIRMED", {
            details: [
              { key: "reload", value: "declaration_not_effect" },
              { key: "reload_kind", value: declaration.kind }
            ]
          })
        );
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<ConfigResult<never>>((resolve) => {
        timer = setTimeout(() => {
          resolve(
            fail(
              configError("E_CFG_DEADLINE_EXCEEDED", {
                details: [{ key: "deadline_ms", value: input.deadline_ms }]
              })
            )
          );
        }, input.deadline_ms);
      });
      const resolved = await Promise.race([
        declaration.resolve({
          field_ids: input.field_ids,
          deadline_ms: input.deadline_ms,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        }),
        deadline
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (!resolved.ok) {
        return resolved;
      }
      if (resolved.value.assignments.length === 0) {
        return fail(
          configError("E_CFG_APPLY_UNCONFIRMED", {
            details: [{ key: "reload", value: "no_resolved_values" }]
          })
        );
      }
      if (resolved.value.repeat_count < 1) {
        return fail(
          configError("E_CFG_APPLY_UNCONFIRMED", {
            details: [{ key: "reload", value: "repeat_count_below_one" }]
          })
        );
      }
      const observedAt =
        Number.isFinite(resolved.value.observed_at) && resolved.value.observed_at >= 0
          ? resolved.value.observed_at
          : deps.now();
      const probe: EffectiveProbe = {
        source: sourceFor(declaration.kind),
        resolved: resolved.value.assignments,
        evidence_ref: resolved.value.evidence_ref,
        repeat_count: resolved.value.repeat_count,
        baseline_explainable: resolved.value.baseline_explainable,
        observed_at: observedAt
      };
      return succeed({ probe, evidence_kind: declaration.kind });
    }
  };
}
