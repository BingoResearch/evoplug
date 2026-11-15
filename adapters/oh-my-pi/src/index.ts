/**
 * `@evoplug/adapter-oh-my-pi` public surface.
 *
 * The package implements the HOST-owned `HostAdapter` port (DD-HOST-001) for
 * Oh My Pi (DD-HOST-020). It exports the frozen descriptor, the event contract
 * table, the normalizer, the adapter class and the identity/version facts.
 */

export type * from "./contract.js";
export { adapterErr, adapterOk } from "./contract.js";

export {
  OmpHostAdapter,
  createOmpHostAdapter,
  computeCapabilityBindingKey,
  isOmpHostEventBinding,
  isProbeableCapability,
  type OmpDeliveryBridgePort,
  type OmpDeliverySubmitInput,
  type OmpDeliverySubmitResult,
  type OmpHostAdapterOptions,
  type OmpRegistrationApplyInput,
  type OmpRegistrationApplyResult,
  type OmpRegistrationWriterPort
} from "./adapter.js";

export {
  OMP_ADAPTER_DESCRIPTOR,
  OMP_CONFIG_SPACES,
  OMP_DESCRIPTOR_HASH,
  OMP_DESCRIPTOR_REF,
  OMP_REGISTRATION_TARGETS,
  OMP_SUPPORTED_MODES,
  computeDescriptorHash,
  computeRegistrationHash,
  describeOmpAdapter,
  descriptorToJson,
  isOmpConfigSpace,
  isOmpMode,
  ompConstructionPathForMode,
  ompRegistrationTarget,
  validateAdapterDescriptor,
  type RegistrationHashFields
} from "./descriptor.js";

export {
  OMP_EVENT_CONTRACTS,
  OMP_EVENT_NAMES,
  OMP_OBSERVATION_EVENTS,
  isOmpObservationEvent,
  ompAsyncWorkUnknown,
  ompCanonicalKinds,
  ompEventContract,
  ompQueueEmptyUnknown,
  ompRequiredCapabilities,
  ompRetryStateUnknown,
  ompWillContinueUnknown
} from "./events.js";

export {
  HOST_RESERVED_CAPABILITY,
  OMP_CAPABILITY_NAMES,
  OMP_DECLARED_CAPABILITIES,
  hasStaticAdapterEvidence,
  isCapabilityName
} from "./capabilities.js";

export {
  OMP_ADAPTER_ID,
  OMP_ADAPTER_VERSION,
  OMP_HOST_ID,
  OMP_HOST_RUNTIME,
  OMP_HOST_VERSION,
  OMP_IMPLEMENTATION_FILES,
  OMP_IMPLEMENTATION_HASH,
  OMP_SOURCE_COMMIT,
  OMP_SOURCE_VERSION,
  OMP_TOOLCHAIN,
  OMP_VERSION_FACTS,
  computeImplementationHash,
  type AdapterManifestFile,
  type AdapterManifestInput
} from "./manifest.js";

export { normalizeOmpEvent } from "./normalize.js";

export { OMP_UNKNOWN_REASON, ompUnknown, type OmpUnknownReason } from "./facts.js";

export { OMP_REGISTRATION_ARTIFACT } from "./registration.js";

export { OMP_GENERATION_SPEC } from "./generation-spec.js";

export { ohMyPiProbeSpec } from "./probe-spec.js";

export * from "./compaction-spec.js";
