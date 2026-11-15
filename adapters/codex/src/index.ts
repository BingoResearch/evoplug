/**
 * `@evoplug/adapter-codex` public surface.
 *
 * The package implements the HOST-owned `HostAdapter` port (DD-HOST-001) for
 * Codex (DD-HOST-040). It exports the frozen descriptor, the event contract
 * table, the normalizer, the adapter class and the identity/version facts.
 */

export type * from "./contract.js";
export { adapterErr, adapterOk } from "./contract.js";

export {
  CodexHostAdapter,
  createCodexHostAdapter,
  computeCapabilityBindingKey,
  isCodexHostEventBinding,
  isProbeableCapability,
  type CodexDeliveryBridgePort,
  type CodexDeliverySubmitInput,
  type CodexDeliverySubmitResult,
  type CodexHostAdapterOptions,
  type CodexLoadBridgePort,
  type CodexLoadCheckInput,
  type CodexProbeBridgeInput,
  type CodexProbeBridgePort,
  type CodexProbeBridgeResult,
  type CodexRegistrationApplyInput,
  type CodexRegistrationApplyResult,
  type CodexRegistrationWriterPort
} from "./adapter.js";

export {
  CODEX_ADAPTER_DESCRIPTOR,
  CODEX_CONFIG_SPACES,
  CODEX_DESCRIPTOR_HASH,
  CODEX_DESCRIPTOR_REF,
  CODEX_REGISTRATION_TARGETS,
  CODEX_SUPPORTED_MODES,
  codexConstructionPathForMode,
  codexRegistrationTarget,
  computeDescriptorHash,
  computeRegistrationHash,
  describeCodexAdapter,
  descriptorToJson,
  isCodexConfigSpace,
  isCodexMode,
  validateAdapterDescriptor,
  type RegistrationHashFields
} from "./descriptor.js";

export {
  CODEX_EVENT_CONTRACTS,
  CODEX_EVENT_NAMES,
  CODEX_OBSERVATION_EVENTS,
  codexAppServerDurableUnknown,
  codexAsyncWorkUnknown,
  codexCanonicalKinds,
  codexEventContract,
  codexQueueEmptyUnknown,
  codexRequiredCapabilities,
  codexRetryStateUnknown,
  isCodexObservationEvent
} from "./events.js";

export {
  CODEX_CAPABILITY_NAMES,
  CODEX_DECLARED_CAPABILITIES,
  HOST_RESERVED_CAPABILITY,
  hasStaticAdapterEvidence,
  isCapabilityName
} from "./capabilities.js";

export {
  CODEX_ADAPTER_ID,
  CODEX_ADAPTER_VERSION,
  CODEX_HOST_ID,
  CODEX_HOST_VERSION,
  CODEX_IMPLEMENTATION_FILES,
  CODEX_IMPLEMENTATION_HASH,
  CODEX_INSTALL_PATH,
  CODEX_SOURCE_COMMIT,
  CODEX_SOURCE_VERSION,
  CODEX_TOOLCHAIN,
  CODEX_VERSION_FACTS,
  computeImplementationHash,
  type AdapterManifestFile,
  type AdapterManifestInput
} from "./manifest.js";

export { normalizeCodexEvent } from "./normalize.js";

export { CODEX_UNKNOWN_REASON, codexUnknown, type CodexUnknownReason } from "./facts.js";

export { CODEX_REGISTRATION_ARTIFACT } from "./registration.js";

export { CODEX_GENERATION_SPEC } from "./generation-spec.js";

export { codexProbeSpec } from "./probe-spec.js";

export * from "./compaction-spec.js";
