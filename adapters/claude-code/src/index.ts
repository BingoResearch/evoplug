/**
 * `@evoplug/adapter-claude-code` public surface.
 *
 * The package implements the HOST-owned `HostAdapter` port (DD-HOST-001) for
 * Claude Code (DD-HOST-070). It exports the frozen descriptor, the event
 * contract table, the normalizer, the adapter class and the identity/version
 * facts. `generation` is absent by design: every `generation.*` capability is
 * `unknown/none` for this host.
 */

export type * from "./contract.js";
export { adapterErr, adapterOk } from "./contract.js";

export {
  ClaudeHostAdapter,
  createClaudeHostAdapter,
  computeCapabilityBindingKey,
  isClaudeHostEventBinding,
  isProbeableCapability,
  type ClaudeDeliveryBridgePort,
  type ClaudeDeliverySubmitInput,
  type ClaudeDeliverySubmitResult,
  type ClaudeHostAdapterOptions,
  type ClaudeLoadBridgePort,
  type ClaudeLoadCheckInput,
  type ClaudePendingBridgePort,
  type ClaudePendingInspectInput,
  type ClaudeProbeBridgeInput,
  type ClaudeProbeBridgePort,
  type ClaudeProbeBridgeResult,
  type ClaudeRegistrationApplyInput,
  type ClaudeRegistrationApplyResult,
  type ClaudeRegistrationWriterPort
} from "./adapter.js";

export {
  CLAUDE_ADAPTER_DESCRIPTOR,
  CLAUDE_CONFIG_SPACES,
  CLAUDE_DESCRIPTOR_HASH,
  CLAUDE_DESCRIPTOR_REF,
  CLAUDE_REGISTRATION_TARGETS,
  CLAUDE_SUPPORTED_MODES,
  claudeConstructionPathForMode,
  claudeRegistrationTarget,
  computeDescriptorHash,
  computeRegistrationHash,
  describeClaudeAdapter,
  descriptorToJson,
  isClaudeConfigSpace,
  isClaudeMode,
  validateAdapterDescriptor,
  type RegistrationHashFields
} from "./descriptor.js";

export {
  CLAUDE_EVENT_CONTRACTS,
  CLAUDE_EVENT_NAMES,
  CLAUDE_OBSERVATION_EVENTS,
  CLAUDE_OFFICIAL_CLASSIC_EVENT_COUNT,
  claudeBackgroundSemanticsUnknown,
  claudeCanonicalKinds,
  claudeCompactionSummaryUnknown,
  claudeEventContract,
  claudeLoadReadbackUnknown,
  claudePendingSemanticsUnknown,
  claudeQueueEmptyUnknown,
  claudeRequiredCapabilities,
  claudeRetryStateUnknown,
  isClaudeObservationEvent
} from "./events.js";

export {
  CLAUDE_CAPABILITY_NAMES,
  CLAUDE_DECLARED_CAPABILITIES,
  HOST_RESERVED_CAPABILITY,
  hasStaticAdapterEvidence,
  isCapabilityName
} from "./capabilities.js";

export {
  CLAUDE_ADAPTER_ID,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_HOST_ID,
  CLAUDE_HOST_VERSION,
  CLAUDE_IMPLEMENTATION_FILES,
  CLAUDE_IMPLEMENTATION_HASH,
  CLAUDE_INSTALL_PATH,
  CLAUDE_SOURCE_BASELINE,
  CLAUDE_TOOLCHAIN,
  CLAUDE_VERSION_FACTS,
  computeImplementationHash,
  type AdapterManifestFile,
  type AdapterManifestInput
} from "./manifest.js";

export { normalizeClaudeEvent } from "./normalize.js";

export { CLAUDE_UNKNOWN_REASON, claudeUnknown, type ClaudeUnknownReason } from "./facts.js";

export { CLAUDE_REGISTRATION_ARTIFACT } from "./registration.js";

export { CLAUDE_CODE_GENERATION_SPEC } from "./generation-spec.js";

export { claudeCodeProbeSpec } from "./probe-spec.js";

export * from "./compaction-spec.js";
