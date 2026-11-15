/**
 * Auditable config upgrade for an initialized home (W11).
 *
 * `init.complete.json` binds the canonical config bytes through
 * `config_version`. Editing `config.json` in place leaves the marker stale and
 * the next startup rejects the home with `E_HOME_INCOMPATIBLE`. This module is
 * the supported path: it verifies the old bytes against the marker, records a
 * durable backup, writes the new canonical bytes, then advances the marker.
 *
 * The function never ignores a hash mismatch. A caller-supplied expectation
 * (`expected_previous_config_version`) must also match, which makes the upgrade
 * safe against a concurrent writer or a stale operator plan.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorEnvelope, Hash, Result } from "@evoplug/core";
import { canonicalJsonText } from "@evoplug/core";
import type { EvoplugConfig } from "./config.js";
import {
  canonicalConfigJson,
  computeConfigContentHash,
  computeConfigVersion,
  configVersionBody,
  parseConfigText
} from "./config.js";
import { versionError } from "./errors.js";
import {
  homeLayout,
  readInitCompleteMarker,
  writeFileAtomicDurable,
  type InitCompleteMarker
} from "./home.js";

export interface UpgradeConfigOptions {
  readonly home: string;
  readonly next: EvoplugConfig;
  /**
   * The version the operator believes is active. Supplying it turns a
   * concurrent change into a conflict instead of overwriting it.
   */
  readonly expected_previous_config_version?: string;
  readonly now?: () => number;
}

export type ConfigUpgradeStatus = "upgraded" | "no_op";

export interface ConfigUpgradeResult {
  readonly status: ConfigUpgradeStatus;
  readonly previous_config_version: string;
  readonly next_config_version: string;
  readonly previous_config_hash: Hash;
  readonly next_config_hash: Hash;
  /** Top-level config keys whose canonical JSON changed. */
  readonly changed_keys: readonly string[];
  /** Backup file holding the pre-upgrade canonical config, when upgraded. */
  readonly backup_path: string | null;
  readonly marker: InitCompleteMarker;
}

function configJsonByKey(config: EvoplugConfig): Readonly<Record<string, string>> {
  const body = configVersionBody(config);
  const withHome = { ...body, product_home: config.product_home };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(withHome)) {
    out[key] = canonicalJsonText(value);
  }
  return out;
}

function changedTopLevelKeys(previous: EvoplugConfig, next: EvoplugConfig): readonly string[] {
  const left = configJsonByKey(previous);
  const right = configJsonByKey(next);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    if (left[key] !== right[key]) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Replaces `config.json` and advances `init.complete.json` atomically enough
 * for restart: the backup exists before the config changes, and a failed
 * marker update restores the previous config bytes.
 */
export async function upgradeConfig(
  options: UpgradeConfigOptions
): Promise<Result<ConfigUpgradeResult, ErrorEnvelope>> {
  const home = options.home;
  if (options.next.product_home !== home) {
    return {
      ok: false,
      status: "rejected",
      error: versionError(home, options.next.product_home, "E_HOME_INCOMPATIBLE")
    };
  }

  const markerResult = await readInitCompleteMarker(home);
  if (!markerResult.ok) {
    return markerResult;
  }
  if (markerResult.value === null) {
    return {
      ok: false,
      status: "rejected",
      error: versionError("initialized", "missing", "E_HOME_INCOMPATIBLE")
    };
  }
  const marker = markerResult.value;
  if (marker.root !== home) {
    return {
      ok: false,
      status: "rejected",
      error: versionError(home, marker.root, "E_HOME_INCOMPATIBLE")
    };
  }
  if (
    options.expected_previous_config_version !== undefined &&
    options.expected_previous_config_version !== marker.config_version
  ) {
    return {
      ok: false,
      status: "conflict",
      error: versionError(options.expected_previous_config_version, marker.config_version, "E_HOME_INCOMPATIBLE")
    };
  }

  const layout = homeLayout(home);
  let previousText: string;
  try {
    previousText = await readFile(layout.config_path, "utf8");
  } catch {
    return {
      ok: false,
      status: "rejected",
      error: versionError("config.json", "missing", "E_HOME_INCOMPATIBLE")
    };
  }
  const parsedPrevious = parseConfigText(previousText);
  if (!parsedPrevious.ok) {
    return parsedPrevious;
  }
  const previous = parsedPrevious.value;
  const previousVersion = computeConfigVersion(previous);
  // The audit gate: the bytes on disk must still be the bytes the marker
  // recorded. Editing config.json by hand is a mismatch, not an upgrade.
  if (previousVersion !== marker.config_version) {
    return {
      ok: false,
      status: "rejected",
      error: versionError(previousVersion, marker.config_version, "E_HOME_INCOMPATIBLE")
    };
  }
  const previousHash = computeConfigContentHash(previous);
  const nextVersion = computeConfigVersion(options.next);
  const nextHash = computeConfigContentHash(options.next);
  const changedKeys = changedTopLevelKeys(previous, options.next);

  if (nextVersion === previousVersion) {
    return {
      ok: true,
      status: "no_op",
      value: {
        status: "no_op",
        previous_config_version: previousVersion,
        next_config_version: nextVersion,
        previous_config_hash: previousHash,
        next_config_hash: nextHash,
        changed_keys: changedKeys,
        backup_path: null,
        marker
      }
    };
  }

  const stamp = options.now?.() ?? Date.now();
  const backupPath = join(
    layout.backups_dir,
    `config-${previousVersion.slice("cfgv:sha256:".length).slice(0, 16)}-${String(stamp)}.json`
  );
  const backup = await writeFileAtomicDurable(backupPath, canonicalConfigJson(previous));
  if (!backup.ok) {
    return backup;
  }

  const written = await writeFileAtomicDurable(layout.config_path, canonicalConfigJson(options.next));
  if (!written.ok) {
    return written;
  }

  const nextMarker: InitCompleteMarker = {
    ...marker,
    config_version: nextVersion
  };
  const markerWritten = await writeFileAtomicDurable(
    layout.init_complete_path,
    `${JSON.stringify(nextMarker)}\n`
  );
  if (!markerWritten.ok) {
    // Restore the old bytes so the failed attempt leaves a consistent home.
    await writeFileAtomicDurable(layout.config_path, canonicalConfigJson(previous));
    return markerWritten;
  }

  return {
    ok: true,
    status: "ok",
    value: {
      status: "upgraded",
      previous_config_version: previousVersion,
      next_config_version: nextVersion,
      previous_config_hash: previousHash,
      next_config_hash: nextHash,
      changed_keys: changedKeys,
      backup_path: backupPath,
      marker: nextMarker
    }
  };
}
