/**
 * Probe binding declaration for the `openhands-sdk` adapter (W1).
 *
 * These are the facts the adapter itself can state about how its runtime is
 * constructed. The kernel supplies host version, binary hash and session scope
 * when it turns this spec into a `CapabilityBinding`; nothing here branches on
 * the host inside the kernel.
 */

import { defineAdapterProbeSpec, type AdapterProbeSpec } from "@evoplug/host-runtime";

export const openHandsSdkProbeSpec: AdapterProbeSpec = defineAdapterProbeSpec({
  adapter_id: "openhands-sdk",
  construction_path: "direct_agent",
  isolation: "local",
  mapping: "partial"
});
