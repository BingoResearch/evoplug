/**
 * Probe binding declaration for the `claude-code` adapter (W1).
 *
 * These are the facts the adapter itself can state about how its runtime is
 * constructed. The kernel supplies host version, binary hash and session scope
 * when it turns this spec into a `CapabilityBinding`; nothing here branches on
 * the host inside the kernel.
 */

import { defineAdapterProbeSpec, type AdapterProbeSpec } from "@evoplug/host-runtime";

export const claudeCodeProbeSpec: AdapterProbeSpec = defineAdapterProbeSpec({
  adapter_id: "claude-code",
  construction_path: "cli",
  isolation: "local",
  mapping: "exact"
});
