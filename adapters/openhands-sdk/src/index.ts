/**
 * `@evoplug/adapter-openhands-sdk` public surface.
 *
 * The package implements the HOST-owned `HostAdapter` port (DD-HOST-001) for
 * the OpenHands SDK (DD-HOST-060, DD-HOST-100). It exports the frozen
 * descriptor, the event contract table, the normalizer, the adapter class and
 * the identity/version facts.
 */

export type * from "./contract.js";
export { adapterErr, adapterOk } from "./contract.js";

export {
  OpenhandsHostAdapter,
  createOpenhandsHostAdapter,
  computeCapabilityBindingKey,
  isOpenhandsHostEventBinding,
  isProbeableCapability,
  type OpenhandsDeliveryBridgePort,
  type OpenhandsDeliverySubmitInput,
  type OpenhandsDeliverySubmitResult,
  type OpenhandsHostAdapterOptions,
  type OpenhandsRegistrationApplyInput,
  type OpenhandsRegistrationApplyResult,
  type OpenhandsRegistrationWriterPort
} from "./adapter.js";

export {
  OPENHANDS_ADAPTER_DESCRIPTOR,
  OPENHANDS_CONFIG_SPACES,
  OPENHANDS_CONSTRUCTION_PATHS,
  OPENHANDS_DESCRIPTOR_HASH,
  OPENHANDS_DESCRIPTOR_REF,
  OPENHANDS_PLUGIN_DIRECTORIES,
  OPENHANDS_REGISTRATION_TARGETS,
  OPENHANDS_SUPPORTED_MODES,
  computeDescriptorHash,
  computeRegistrationHash,
  describeOpenhandsAdapter,
  descriptorToJson,
  isOpenhandsConfigSpace,
  isOpenhandsConstructionPath,
  isOpenhandsMode,
  openhandsConstructionPathForMode,
  openhandsRegistrationTarget,
  validateAdapterDescriptor,
  type RegistrationHashFields
} from "./descriptor.js";

export {
  OPENHANDS_EVENT_CONTRACTS,
  OPENHANDS_EVENT_NAMES,
  OPENHANDS_OBSERVATION_EVENTS,
  isOpenhandsObservationEvent,
  openhandsAsyncWorkUnknown,
  openhandsAutoTurnUnknown,
  openhandsCanonicalKinds,
  openhandsEventContract,
  openhandsInputOriginUnknown,
  openhandsMessageIdUnknown,
  openhandsQueueEmptyUnknown,
  openhandsRequiredCapabilities,
  openhandsRetryStateUnknown
} from "./events.js";

export {
  HOST_RESERVED_CAPABILITY,
  OPENHANDS_CAPABILITY_NAMES,
  OPENHANDS_DECLARED_CAPABILITIES,
  OPENHANDS_STATIC_EVIDENCE_CAPABILITIES,
  hasStaticAdapterEvidence,
  isCapabilityName
} from "./capabilities.js";

export {
  OPENHANDS_ADAPTER_ID,
  OPENHANDS_ADAPTER_VERSION,
  OPENHANDS_HOST_ID,
  OPENHANDS_HOST_VERSION,
  OPENHANDS_IMPLEMENTATION_FILES,
  OPENHANDS_IMPLEMENTATION_HASH,
  OPENHANDS_MAPPED_FILES,
  OPENHANDS_SOURCE_COMMIT,
  OPENHANDS_SOURCE_VERSION,
  OPENHANDS_TOOLCHAIN,
  OPENHANDS_VERSION_FACTS,
  computeImplementationHash,
  type AdapterManifestFile,
  type AdapterManifestInput
} from "./manifest.js";

export { normalizeOpenhandsEvent } from "./normalize.js";

export {
  OPENHANDS_UNKNOWN_REASON,
  openhandsUnknown,
  type OpenhandsUnknownReason
} from "./facts.js";

export { OPENHANDS_REGISTRATION_ARTIFACT } from "./registration.js";

export { OPENHANDS_GENERATION_SPEC } from "./generation-spec.js";

export { openHandsSdkProbeSpec } from "./probe-spec.js";

export * from "./compaction-spec.js";
