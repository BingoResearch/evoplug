/**
 * `@evoplug/adapter-pi` public surface.
 *
 * The package implements the HOST-owned `HostAdapter` port (DD-HOST-001) for
 * Pi (DD-HOST-010). It exports the frozen descriptor, the event contract
 * table, the normalizer, the adapter class and the identity/version facts.
 */

export type * from "./contract.js";
export { adapterErr, adapterOk } from "./contract.js";

export {
  PiHostAdapter,
  createPiHostAdapter,
  computeCapabilityBindingKey,
  isPiHostEventBinding,
  isProbeableCapability,
  type PiDeliveryBridgePort,
  type PiDeliverySubmitInput,
  type PiDeliverySubmitResult,
  type PiHostAdapterOptions,
  type PiRegistrationApplyInput,
  type PiRegistrationApplyResult,
  type PiRegistrationWriterPort
} from "./adapter.js";

export {
  PI_ADAPTER_DESCRIPTOR,
  PI_CONFIG_SPACES,
  PI_DESCRIPTOR_HASH,
  PI_DESCRIPTOR_REF,
  PI_REGISTRATION_TARGETS,
  PI_SUPPORTED_MODES,
  computeDescriptorHash,
  computeRegistrationHash,
  describePiAdapter,
  descriptorToJson,
  isPiConfigSpace,
  isPiMode,
  piConstructionPathForMode,
  piRegistrationTarget,
  validateAdapterDescriptor,
  type RegistrationHashFields
} from "./descriptor.js";

export {
  PI_EVENT_CONTRACTS,
  PI_EVENT_NAMES,
  PI_OBSERVATION_EVENTS,
  isPiObservationEvent,
  piAsyncWorkUnknown,
  piCanonicalKinds,
  piEventContract,
  piQueueEmptyUnknown,
  piRequiredCapabilities,
  piRetryStateUnknown
} from "./events.js";

export {
  HOST_RESERVED_CAPABILITY,
  PI_CAPABILITY_NAMES,
  PI_DECLARED_CAPABILITIES,
  hasStaticAdapterEvidence,
  isCapabilityName
} from "./capabilities.js";

export {
  PI_ADAPTER_ID,
  PI_ADAPTER_VERSION,
  PI_HOST_ID,
  PI_HOST_VERSION,
  PI_IMPLEMENTATION_FILES,
  PI_IMPLEMENTATION_HASH,
  PI_INSTALL_PATH,
  PI_SOURCE_COMMIT,
  PI_SOURCE_VERSION,
  PI_TOOLCHAIN,
  PI_VERSION_FACTS,
  computeImplementationHash,
  type AdapterManifestFile,
  type AdapterManifestInput
} from "./manifest.js";

export { normalizePiEvent } from "./normalize.js";

export { PI_UNKNOWN_REASON, piUnknown, type PiUnknownReason } from "./facts.js";

export { PI_REGISTRATION_ARTIFACT } from "./registration.js";

export { PI_GENERATION_SPEC } from "./generation-spec.js";

export { piProbeSpec } from "./probe-spec.js";

export * from "./compaction-spec.js";

export {
  createPiSdkReloadResolver,
  type PiSdkReloadResolver,
  type PiSdkReloadResolverOptions,
  type PiSettingsManagerLike,
  type PiSettingsModuleLike
} from "./reload-resolution.js";
