/**
 * `@evoplug/adapter-opencode` public surface.
 *
 * The package implements the HOST-owned `HostAdapter` port (DD-HOST-001) for
 * OpenCode (DD-HOST-050). It exports the frozen descriptor, the event contract
 * table, the normalizer, the adapter class and the identity/version facts.
 *
 * The 2.1.0 source baseline and the installed 2.1.4 binary remain separate
 * facts; no capability is inherited across that boundary (DD-HOST-100).
 */

export type * from "./contract.js";
export { adapterErr, adapterOk } from "./contract.js";

export {
  OpenCodeHostAdapter,
  computeCapabilityBindingKey,
  createOpenCodeHostAdapter,
  isOpenCodeHostEventBinding,
  isProbeableCapability,
  normalizeOpenCodePluginList,
  OPENCODE_PLUGIN_CONFIG_KEYS,
  type OpenCodeDeliveryBridgePort,
  type OpenCodeDeliverySubmitInput,
  type OpenCodeDeliverySubmitResult,
  type OpenCodeHostAdapterOptions,
  type OpenCodePendingInspectInput,
  type OpenCodePendingReaderPort,
  type OpenCodeRegistrationApplyInput,
  type OpenCodeRegistrationApplyResult,
  type OpenCodeRegistrationWriterPort
} from "./adapter.js";

export {
  OPENCODE_ADAPTER_DESCRIPTOR,
  OPENCODE_CONFIG_SPACES,
  OPENCODE_DESCRIPTOR_HASH,
  OPENCODE_DESCRIPTOR_REF,
  OPENCODE_REGISTRATION_TARGETS,
  OPENCODE_SUPPORTED_MODES,
  computeDescriptorHash,
  computeRegistrationHash,
  describeOpenCodeAdapter,
  descriptorToJson,
  isOpenCodeConfigSpace,
  isOpenCodeMode,
  openCodeConstructionPathForMode,
  openCodeRegistrationTarget,
  validateAdapterDescriptor,
  type RegistrationHashFields
} from "./descriptor.js";

export {
  OPENCODE_DURABLE_COMPACTION_PREFIX,
  OPENCODE_EVENT_CONTRACTS,
  OPENCODE_EVENT_NAMES,
  OPENCODE_OBSERVATION_EVENTS,
  OPENCODE_SERVER_ONLY_EVENTS,
  isOpenCodeCompactionEvent,
  isOpenCodeObservationEvent,
  isOpenCodeServerOnlyEvent,
  openCodeAsyncWorkUnknown,
  openCodeCanonicalKinds,
  openCodeCompactionContract,
  openCodeEventContract,
  openCodePendingUnknown,
  openCodeQueueEmptyUnknown,
  openCodeRequiredCapabilities,
  openCodeRetryStateUnknown
} from "./events.js";

export {
  HOST_RESERVED_CAPABILITY,
  OPENCODE_CAPABILITY_NAMES,
  OPENCODE_DECLARED_CAPABILITIES,
  hasStaticAdapterEvidence,
  isCapabilityName
} from "./capabilities.js";

export {
  OPENCODE_ADAPTER_ID,
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_EVENT_HOST_VERSION,
  OPENCODE_HOST_ID,
  OPENCODE_HOST_VERSION,
  OPENCODE_IMPLEMENTATION_FILES,
  OPENCODE_IMPLEMENTATION_HASH,
  OPENCODE_INSTALL_PATH,
  OPENCODE_SOURCE_COMMIT,
  OPENCODE_SOURCE_VERSION,
  OPENCODE_TOOLCHAIN,
  OPENCODE_VERSION_FACTS,
  computeImplementationHash,
  type AdapterManifestFile,
  type AdapterManifestInput
} from "./manifest.js";

export { normalizeOpenCodeEvent } from "./normalize.js";

export { OPENCODE_UNKNOWN_REASON, openCodeUnknown, type OpenCodeUnknownReason } from "./facts.js";

export { OPENCODE_REGISTRATION_ARTIFACT } from "./registration.js";

export {
  createOpenCodeCliBackend,
  createOpenCodeCliGenerationAdapter,
  OpenCodeCliGenerationAdapter,
  OPENCODE_GENERATION_ADAPTER_ID,
  OPENCODE_GENERATION_ADAPTER_VERSION,
  OPENCODE_GENERATION_BACKEND_ID,
  OPENCODE_GENERATION_PROTOCOL,
  type OpenCodeGenerationAdapterOptions
} from "./generation.js";

export { OPENCODE_GENERATION_SPEC } from "./generation-spec.js";

export { openCodeProbeSpec } from "./probe-spec.js";

export * from "./compaction-spec.js";
