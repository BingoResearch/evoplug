/**
 * OpenCode 2.2+ discovery compatibility (closed-loop design appendix A).
 *
 * OpenCode watches both `<config>/opencode/plugin` and `<config>/opencode/plugins`.
 * Attach installs the verified artifact once through the registry (the runtime
 * binding, registration hash and manifest all describe one directory), then
 * mirrors that directory to the sibling name. Detach removes only the mirror;
 * the registry owns the primary directory.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Appendix H.1: this path comes from the attach caller's environment snapshot,
 * never from the long-lived kernel process. A missing HOME/XDG_CONFIG_HOME
 * yields `null` instead of falling back to the kernel's own home.
 */
export function openCodeConfigRoot(
  env: Readonly<Record<string, string | undefined>>
): string | null {
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.length > 0) return xdg;
  const home = env["HOME"];
  return home !== undefined && home.length > 0 ? join(home, ".config") : null;
}

function pluginPair(
  configSpace: string,
  env: Readonly<Record<string, string | undefined>>
): { readonly primary: string; readonly mirror: string } | null {
  if (configSpace === "user") {
    const root = openCodeConfigRoot(env);
    if (root === null) return null;
    return {
      primary: join(root, "opencode", "plugin"),
      mirror: join(root, "opencode", "plugins")
    };
  }
  if (configSpace === "project") {
    return {
      primary: join(process.cwd(), ".opencode", "plugin"),
      mirror: join(process.cwd(), ".opencode", "plugins")
    };
  }
  return null;
}

/** Mirrors the attached plugin directory into its sibling `plugins` name. */
export function mirrorOpenCodePluginDir(
  configSpace: string,
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const pair = pluginPair(configSpace, env);
  if (pair === null || !existsSync(pair.primary)) {
    return false;
  }
  cpSync(pair.primary, pair.mirror, { recursive: true, force: true });
  return true;
}

/**
 * OpenCode 2.1.x loads both `<config>/opencode/plugin` and
 * `<config>/opencode/plugins` in the same process. Copying the artifact into
 * both makes the V2 loader activate two definitions with the same `id`, which
 * deadlocks reconciliation. The sibling name is only needed where the host
 * stopped reading the singular directory (2.2+), so the mirror is gated on the
 * detected version instead of being unconditional.
 */
export function shouldMirrorOpenCodePluginDir(hostVersion: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(hostVersion ?? "");
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 2);
}

/** Removes the mirrored directory; the registry-owned primary is untouched. */
export function removeOpenCodePluginMirror(
  configSpace: string,
  env: Readonly<Record<string, string | undefined>>
): void {
  const pair = pluginPair(configSpace, env);
  if (pair !== null) {
    rmSync(pair.mirror, { recursive: true, force: true });
  }
}
